/**
 * src/jobs/fixInfraAssetTypes.ts
 *
 * One-shot startup cleanup. Earlier code paths created assets via DHCP /
 * device-inventory before FortiSwitch / FortiAP discovery linked them up by
 * serial or hostname. The infra discovery linked the asset (added a
 * `fortiswitch` / `fortiap` AssetSource) but did NOT correct the inherited
 * `assetType="other"`, leaving:
 *
 *   1. The infrastructure asset still typed as "other" in the UI
 *   2. A stale `fortigate-endpoint` source row hanging around alongside the
 *      authoritative `fortiswitch` / `fortiap` source on the Sources tab
 *   3. Endpoint pathway guards (which check `assetType !== "switch"`) keep
 *      refreshing the stale source on every discovery cycle
 *
 * This job sweeps once at boot:
 *   - Asset has a `fortiswitch` source AND assetType != "switch" → flip to
 *     "switch" and delete fortigate-endpoint sources on the same asset
 *   - Asset has a `fortiap` source AND assetType != "access_point" → flip
 *     to "access_point" and delete fortigate-endpoint sources on the same
 *     asset
 *
 * Idempotent: re-running after convergence is a no-op (the WHERE clause
 * naturally excludes already-fixed rows).
 *
 * Pairs with the inline correction added to the FortiSwitch / FortiAP
 * update paths in `syncDhcpSubnets`, which prevents the issue from
 * recurring on future discoveries.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { runInstrumentedJob } from "./_metrics.js";

(async () => {
  try {
    await runInstrumentedJob("fixInfraAssetTypes", async () => {
    const fixOne = async (
      sourceKind: "fortiswitch" | "fortiap",
      targetType: "switch" | "access_point",
    ): Promise<{ retyped: number; sourcesDropped: number }> => {
      const candidates = await prisma.assetSource.findMany({
        where: {
          sourceKind,
          asset: { assetType: { not: targetType } },
        },
        select: { assetId: true },
      });
      if (candidates.length === 0) return { retyped: 0, sourcesDropped: 0 };

      const assetIds = Array.from(new Set(candidates.map((c) => c.assetId)));

      // Drop the stale endpoint source rows first — the assetType update
      // afterward fires through the same DB extension that no other path
      // depends on the endpoint row being present at that point.
      const sourcesDropped = await prisma.assetSource.deleteMany({
        where: {
          assetId: { in: assetIds },
          sourceKind: "fortigate-endpoint",
        },
      });

      const retyped = await prisma.asset.updateMany({
        where: { id: { in: assetIds } },
        data:  { assetType: targetType },
      });

      return { retyped: retyped.count, sourcesDropped: sourcesDropped.count };
    };

    const sw = await fixOne("fortiswitch", "switch");
    const ap = await fixOne("fortiap",     "access_point");

    if (sw.retyped > 0 || ap.retyped > 0) {
      logger.info(
        {
          switchesRetyped:        sw.retyped,
          switchEndpointsSwept:   sw.sourcesDropped,
          apsRetyped:             ap.retyped,
          apEndpointsSwept:       ap.sourcesDropped,
        },
        "Fixed infrastructure assetType + swept stale fortigate-endpoint sources",
      );
    }
    });
  } catch (err) {
    logger.error({ err }, "fixInfraAssetTypes failed (will retry next boot)");
  }
})();
