/**
 * src/services/sampleQueryRouter.ts
 *
 * Picks which storage tier a chart history query should read from based on
 * the requested range and the operator's configured retention windows.
 * Phase 4 of the tiered sample-retention work.
 *
 * Rule (oldest-point-wins):
 *   - If `from >= now − detailDays` → read raw detail samples.
 *   - Else if `from >= now − hourlyDays` → read hourly rollups.
 *   - Else → read daily rollups.
 *
 * Pure — no I/O, no DB. Each chart history endpoint calls this once after
 * parsing the range, then dispatches to a tier-specific reader.
 *
 * Phase 4 ships with `DEFAULT_TIER_RETENTION` (matches the SolarWinds
 * defaults 7 / 30 / 365). Phase 5 swaps the per-endpoint usage of these
 * defaults for `resolveMonitorSettings(asset)` so per-asset operator
 * overrides actually win.
 */

export type SampleTier = "detail" | "hourly" | "daily";

export interface TierRetention {
  /** Days of detail samples kept. Range > this → drop to hourly. */
  detailDays: number;
  /** Days of hourly rollups kept. Range > this → drop to daily. */
  hourlyDays: number;
}

export interface TierPick {
  tier: SampleTier;
  /** 0 for detail, 3600 for hourly, 86400 for daily. Surface this to the
   *  client so chart renderers can show a "Hourly avg" / "Daily avg" badge
   *  and counter-rate readers know their denominator. */
  bucketSeconds: 0 | 3600 | 86400;
}

const SECONDS_PER_DAY = 86400;

/**
 * Tier defaults matching the SolarWinds-style tiering. Used as a fallback
 * when the asset-aware resolver isn't applicable (e.g. tests, fixture
 * data). Production endpoints route through `pickSampleTierForAsset`
 * which consults `Setting("sampleRetention")` per asset class.
 */
export const DEFAULT_TIER_RETENTION: TierRetention = {
  detailDays: 7,
  hourlyDays: 30,
};

/**
 * Pick the right tier for a query whose oldest requested point is `since`.
 *
 * The decision uses ONLY `since`, not `until`, because the oldest point is
 * the binding constraint: a query that asks for the last 30 days needs a
 * tier that has 30-day-old data. The newest point is always available in
 * the detail tier (because detail retention covers "recent"), but for
 * uniformity the entire query reads from one tier.
 */
export function pickSampleTier(
  since: Date,
  retention: TierRetention = DEFAULT_TIER_RETENTION,
): TierPick {
  const now = Date.now();
  const sinceMs = since.getTime();
  const detailCutoffMs = now - retention.detailDays * SECONDS_PER_DAY * 1000;
  const hourlyCutoffMs = now - retention.hourlyDays * SECONDS_PER_DAY * 1000;

  if (sinceMs >= detailCutoffMs) return { tier: "detail", bucketSeconds: 0 };
  if (sinceMs >= hourlyCutoffMs) return { tier: "hourly", bucketSeconds: 3600 };
  return { tier: "daily", bucketSeconds: SECONDS_PER_DAY };
}

/**
 * Asset-aware tier picker. Looks up the asset's assetType, resolves the
 * matching retention class from the global Setting("sampleRetention"),
 * and applies pickSampleTier. One extra small DB read per chart request
 * (PK lookup on Asset + cache-friendly retention read).
 *
 * The `prismaClient` / `getRetention` arguments default to the production
 * Prisma + sampleRetentionService bindings; injected for test paths.
 */
import { prisma } from "../db.js";
import { getSampleRetention, pickClassForAssetType, type RetentionStream } from "./sampleRetentionService.js";

export async function pickSampleTierForAsset(
  assetId: string,
  stream: RetentionStream,
  since: Date,
): Promise<TierPick> {
  const [asset, retention] = await Promise.all([
    prisma.asset.findUnique({ where: { id: assetId }, select: { assetType: true } }),
    getSampleRetention(),
  ]);
  const klass = pickClassForAssetType(asset?.assetType);
  return pickSampleTier(since, {
    detailDays: retention[stream].detail[klass],
    hourlyDays: retention[stream].hourly[klass],
  });
}
