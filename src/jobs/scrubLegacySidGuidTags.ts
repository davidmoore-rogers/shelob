/**
 * src/jobs/scrubLegacySidGuidTags.ts
 *
 * One-shot startup migration for Phase 4b of the multi-source asset model.
 *
 * The Entra and AD discovery paths used to mirror cross-integration identity
 * into `Asset.tags` as `sid:<SID>` and `ad-guid:<GUID>` markers — needed
 * before AssetSource existed because the tags array was the only place to
 * stash a hybrid-join cross-link or the AD GUID after Entra took over the
 * primary `assetTag`. After the multi-source cutover, both signals live on
 * AssetSource (entra.observed.onPremisesSecurityIdentifier,
 * ad.observed.objectSid, ad.externalId for the GUID) and the tag mirroring
 * is redundant.
 *
 * This job strips those legacy prefixes from existing rows. It runs once at
 * boot and is idempotent — re-running over an already-scrubbed table
 * touches nothing. Discovery code stops writing the markers in the same
 * commit; this catches the data left over from previous runs.
 *
 * NOTE: This does NOT touch `Asset.assetTag` (entra:/ad:/fgt: prefixes) or
 * the `prev-entra:` / `prev-ad:` breadcrumb tags. Those are part of slice
 * 4d/4e and require parallel changes to searchService + conflict
 * resolution before they can be safely retired.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";

const LEGACY_PREFIXES = ["sid:", "ad-guid:"];

(async () => {
  try {
    const rows = await prisma.asset.findMany({
      where: {
        // Postgres `array_position` would be cheaper than scanning every
        // row, but Prisma doesn't expose it for String[] columns. Restrict
        // to assets that have at least one tag instead — far smaller than
        // the full table on most installs.
        tags: { isEmpty: false },
      },
      select: { id: true, tags: true },
    });

    let scrubbed = 0;
    let entriesRemoved = 0;
    for (const row of rows) {
      const before = (row.tags as string[]) || [];
      const after = before.filter(
        (t) => !LEGACY_PREFIXES.some((p) => typeof t === "string" && t.startsWith(p)),
      );
      if (after.length === before.length) continue;
      entriesRemoved += before.length - after.length;
      scrubbed++;
      await prisma.asset.update({ where: { id: row.id }, data: { tags: after } });
    }

    if (scrubbed > 0) {
      logger.info(
        { assets: scrubbed, entriesRemoved },
        "Scrubbed legacy sid:/ad-guid: tags from Asset.tags (Phase 4b)",
      );
    }
  } catch (err) {
    logger.error(
      { err },
      "Phase-4b legacy-tag scrub failed (existing rows still carry sid:/ad-guid: markers — harmless, will retry next boot)",
    );
  }
})();
