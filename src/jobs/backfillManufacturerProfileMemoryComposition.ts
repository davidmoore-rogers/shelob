/**
 * src/jobs/backfillManufacturerProfileMemoryComposition.ts
 *
 * One-shot startup migration: stamp the multi-OID memory `composition` blob
 * onto existing ManufacturerProfileMetric + ManufacturerProfileMetricOverride
 * rows that predate the column. Pairs with the inline emission added to
 * `seedManufacturerProfiles` so fresh installs get composition stamped from
 * the start; this job is for installs that ran the seed before the column
 * existed.
 *
 * Behaviour: for every entry in VENDOR_TELEMETRY_PROFILES whose `memory`
 * block maps to a known composition shape (via `memoryQueryToComposition`),
 * find the matching DB row(s) and write composition ONLY when both:
 *   1. The row's existing `composition` column is null (don't overwrite
 *      operator edits).
 *   2. The row's `defaultSymbol` / `symbol` matches the primary OID from
 *      the hardcoded entry (sanity check — operator hasn't already
 *      replaced the seed value with their own bespoke symbol).
 *
 * Idempotent: the marker `Setting.backfillManufacturerProfileMemoryCompositionAt`
 * is stamped on first successful run. Re-runs are a no-op via marker; even
 * without the marker, the two safety checks above mean a re-run wouldn't
 * clobber anything.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { runInstrumentedJob } from "./_metrics.js";
import { VENDOR_TELEMETRY_PROFILES, memoryQueryToComposition } from "../services/vendorTelemetryProfiles.js";
import { normalizeManufacturer } from "../utils/manufacturerNormalize.js";
import { refreshProfileCache } from "../services/manufacturerProfileService.js";

const MARKER_KEY = "backfillManufacturerProfileMemoryCompositionAt";

// Same SEED_MAP relationship as `seedManufacturerProfiles.ts` — translates
// the human-friendly vendor labels onto canonical manufacturer + optional
// modelPattern so we can find the right row(s) to backfill.
interface SeedRow { vendorLabel: string; manufacturer: string; modelPattern: string | null }
const SEED_MAP: SeedRow[] = [
  { vendorLabel: "Cisco IOS / IOS-XE / NX-OS",        manufacturer: "Cisco",    modelPattern: null },
  { vendorLabel: "Juniper Junos",                     manufacturer: "Juniper",  modelPattern: null },
  { vendorLabel: "Mikrotik RouterOS",                 manufacturer: "Mikrotik", modelPattern: null },
  { vendorLabel: "Fortinet FortiSwitch (SNMP path)",  manufacturer: "Fortinet", modelPattern: "FortiSwitch" },
  { vendorLabel: "Fortinet FortiAP (SNMP path)",      manufacturer: "Fortinet", modelPattern: "FortiAP" },
  { vendorLabel: "Fortinet FortiOS (SNMP path)",      manufacturer: "Fortinet", modelPattern: null },
  { vendorLabel: "HP / Aruba ProCurve",               manufacturer: "HP",       modelPattern: null },
  { vendorLabel: "Dell PowerConnect / Networking",    manufacturer: "Dell",     modelPattern: null },
];

interface BackfillStats { metricRowsUpdated: number; overrideRowsUpdated: number; skipped: boolean }

export async function backfillManufacturerProfileMemoryComposition(): Promise<BackfillStats> {
  const marker = await prisma.setting.findUnique({ where: { key: MARKER_KEY } });
  if (marker !== null) {
    return { metricRowsUpdated: 0, overrideRowsUpdated: 0, skipped: true };
  }

  let metricRowsUpdated = 0;
  let overrideRowsUpdated = 0;

  for (const seedRow of SEED_MAP) {
    const profile = VENDOR_TELEMETRY_PROFILES.find((p) => p.vendor === seedRow.vendorLabel);
    if (!profile?.memory) continue;
    const composition = memoryQueryToComposition(profile.memory);
    if (!composition) continue;
    // Primary symbol — whichever the seed job picked. Order matches
    // `profileToMetricSeeds` so the matching check stays stable.
    const primarySymbol =
      profile.memory.usedBytesSymbol ||
      profile.memory.totalBytesSymbol ||
      profile.memory.pctSymbol ||
      profile.memory.freeBytesSymbol;
    if (!primarySymbol) continue;

    const mfr = normalizeManufacturer(seedRow.manufacturer) ?? seedRow.manufacturer;
    const dbProfile = await (prisma as any).manufacturerProfile.findUnique({
      where: { manufacturer: mfr },
      include: { metrics: { where: { metricKey: "memory" }, include: { overrides: true } } },
    });
    if (!dbProfile) continue;
    const memoryRow = dbProfile.metrics[0];
    if (!memoryRow) continue;

    if (seedRow.modelPattern) {
      // Override-targeted backfill — find the override matching this seed's
      // modelPattern and stamp composition when the safety checks pass.
      const override = memoryRow.overrides.find((o: any) =>
        o.modelPattern === seedRow.modelPattern && o.symbol === primarySymbol);
      if (!override) continue;
      if (override.composition) continue; // already set — don't clobber
      await (prisma as any).manufacturerProfileMetricOverride.update({
        where: { id: override.id },
        data:  { composition },
      });
      overrideRowsUpdated += 1;
    } else {
      // Umbrella metric-row backfill.
      if (memoryRow.composition) continue;             // already set
      if (memoryRow.defaultSymbol !== primarySymbol) continue; // operator-edited; skip
      await (prisma as any).manufacturerProfileMetric.update({
        where: { id: memoryRow.id },
        data:  { composition },
      });
      metricRowsUpdated += 1;
    }
  }

  await prisma.setting.upsert({
    where:  { key: MARKER_KEY },
    update: { value: { at: new Date().toISOString(), metricRowsUpdated, overrideRowsUpdated } },
    create: { key: MARKER_KEY, value: { at: new Date().toISOString(), metricRowsUpdated, overrideRowsUpdated } },
  });

  return { metricRowsUpdated, overrideRowsUpdated, skipped: false };
}

(async () => {
  try {
    await runInstrumentedJob("backfillManufacturerProfileMemoryComposition", async () => {
      const result = await backfillManufacturerProfileMemoryComposition();
      if (!result.skipped && (result.metricRowsUpdated || result.overrideRowsUpdated)) {
        logger.info(result, "Backfilled manufacturer profile memory composition");
      }
      // Refresh the in-memory cache so the resolver picks up the new
      // composition without waiting for the next write to a profile row.
      await refreshProfileCache();
    });
  } catch (err) {
    logger.error({ err }, "backfillManufacturerProfileMemoryComposition startup task failed");
  }
})();
