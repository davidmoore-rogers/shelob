/**
 * src/jobs/seedManufacturerProfiles.ts
 *
 * One-shot startup that converts the hardcoded VENDOR_TELEMETRY_PROFILES
 * constant into ManufacturerProfile + ManufacturerProfileMetric +
 * ManufacturerProfileMetricOverride rows. Idempotent (marker-keyed in
 * Setting). The constant stays as the runtime fallback until the resolver
 * swap in a follow-up commit; this job only owns persistence.
 *
 * Layout: every entry in VENDOR_TELEMETRY_PROFILES whose regex anchors a
 * SPECIFIC model (FortiSwitch / FortiAP — the two pre-Fortinet entries)
 * becomes a `ManufacturerProfileMetricOverride` row under the umbrella
 * "Fortinet" manufacturer profile. Every other entry becomes its own
 * top-level profile (Cisco / Juniper / Mikrotik / Fortinet / HP / Dell).
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";
import { VENDOR_TELEMETRY_PROFILES, type VendorTelemetryProfile, memoryQueryToComposition } from "../services/vendorTelemetryProfiles.js";
import { refreshProfileCache } from "../services/manufacturerProfileService.js";
import { normalizeManufacturer } from "../utils/manufacturerNormalize.js";

const MARKER_KEY = "seedManufacturerProfilesSeededAt";

// Hand-mapped (vendor label → canonical manufacturer + optional modelPattern).
// We can't reliably parse the regex back to a manufacturer name programmatically
// (e.g. `/aruba|hpe|hewlett|procurve|^hp\b/i` covers four legal names; the human
// label "HP / Aruba ProCurve" is the operator's notion of the umbrella). The
// model overrides for Fortinet sub-families are tagged here so seeding can route
// them under the right parent.
interface SeedRow {
  vendorLabel: string;
  manufacturer: string;
  modelPattern: string | null; // null = top-level default; non-null = override under that manufacturer
}

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

// Translate a VENDOR_TELEMETRY_PROFILES entry's metric queries into a
// {symbol, type} pair per metric key. The hardcoded profile shape is
// richer than what the DB schema captures (mode="walk-avg", multi-symbol
// memory queries with separate used/free/total) — for seeding we capture
// the primary symbol; operators with bespoke needs replace it in the UI.
interface MetricSeed {
  metricKey:   string;
  symbol:      string;
  type:        "scalar" | "table";
  // Multi-OID composition for memory (today). Captured from the hardcoded
  // VENDOR_TELEMETRY_PROFILES bytes-form shape so the editable profile lines
  // up with what the runtime baseline already does.
  composition: ReturnType<typeof memoryQueryToComposition>;
}

function profileToMetricSeeds(p: VendorTelemetryProfile): MetricSeed[] {
  const out: MetricSeed[] = [];
  if (p.cpu) {
    out.push({
      metricKey:   "cpu",
      symbol:      p.cpu.symbol,
      type:        p.cpu.mode === "walk-avg" ? "table" : "scalar",
      composition: null,
    });
  }
  if (p.memory) {
    const mem = p.memory;
    // Primary symbol is what gets stored in the legacy single-symbol column;
    // composition carries the richer bytes-form shape when applicable. Both
    // are emitted — the resolver consults composition first.
    const memSymbol = mem.usedBytesSymbol || mem.totalBytesSymbol || mem.pctSymbol || mem.freeBytesSymbol;
    if (memSymbol) {
      out.push({
        metricKey:   "memory",
        symbol:      memSymbol,
        type:        mem.walkSubtree ? "table" : "scalar",
        composition: memoryQueryToComposition(mem),
      });
    }
  }
  if (p.disk) {
    out.push({ metricKey: "storage", symbol: p.disk.usedBytesSymbol, type: "scalar", composition: null });
  }
  if (p.temperature) {
    out.push({ metricKey: "temperature", symbol: p.temperature.symbol, type: "scalar", composition: null });
  }
  return out;
}

async function alreadySeeded(): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: MARKER_KEY } });
  return row !== null;
}

async function stampMarker(stats: { profiles: number; overrides: number }): Promise<void> {
  await prisma.setting.upsert({
    where:  { key: MARKER_KEY },
    update: { value: { at: new Date().toISOString(), ...stats } },
    create: { key: MARKER_KEY, value: { at: new Date().toISOString(), ...stats } },
  });
}

export async function seedManufacturerProfiles(): Promise<{ profiles: number; overrides: number; skipped: boolean }> {
  if (await alreadySeeded()) {
    return { profiles: 0, overrides: 0, skipped: true };
  }

  const profilesByMfr = new Map<string, { id: string; metricRowIds: Map<string, string> }>();
  let createdProfiles = 0;
  let createdOverrides = 0;

  // Pass 1: create one ManufacturerProfile + 7 metric rows per distinct
  // canonical manufacturer. Pre-populate metric defaults from the hardcoded
  // entry that DOESN'T have a modelPattern (the "umbrella" entry — e.g.
  // FortiOS for Fortinet; the only entry for Cisco/Juniper/etc.).
  const distinctMfrs = Array.from(new Set(SEED_MAP.map((s) => s.manufacturer)));
  for (const mfrRaw of distinctMfrs) {
    const mfr = normalizeManufacturer(mfrRaw) ?? mfrRaw;
    const profileId = (await import("crypto")).randomUUID();
    const umbrella = SEED_MAP.find((s) => s.manufacturer === mfrRaw && s.modelPattern === null);
    const umbrellaProfile = umbrella ? VENDOR_TELEMETRY_PROFILES.find((p) => p.vendor === umbrella.vendorLabel) : null;
    const umbrellaSeeds = umbrellaProfile ? profileToMetricSeeds(umbrellaProfile) : [];

    const metricRowIds = new Map<string, string>();
    const METRIC_KEYS = ["cpu", "memory", "temperature", "interfaces", "lldp", "storage", "wirelessStations"];

    const txOps: any[] = [
      (prisma as any).manufacturerProfile.create({
        data: {
          id:           profileId,
          manufacturer: mfr,
          createdBy:    "system:seed",
        },
      }),
    ];
    for (const mk of METRIC_KEYS) {
      const seed = umbrellaSeeds.find((s) => s.metricKey === mk);
      const id = (await import("crypto")).randomUUID();
      metricRowIds.set(mk, id);
      txOps.push(
        (prisma as any).manufacturerProfileMetric.create({
          data: {
            id,
            profileId,
            metricKey:     mk,
            defaultSymbol: seed?.symbol ?? null,
            defaultType:   seed?.type ?? "scalar",
            // Composition is memory-only today and only stamped when the
            // vendor's hardcoded shape provides one. Null otherwise.
            composition:   seed?.composition ?? null,
          },
        }),
      );
    }
    try {
      await prisma.$transaction(txOps);
      profilesByMfr.set(mfrRaw, { id: profileId, metricRowIds });
      createdProfiles += 1;
    } catch (err: any) {
      // Conflict (manufacturer already exists from a previous partial run) —
      // fetch the existing row + metric ids and reuse.
      if (err?.code === "P2002") {
        const existing = await (prisma as any).manufacturerProfile.findUnique({
          where: { manufacturer: mfr },
          include: { metrics: true },
        });
        if (existing) {
          const ids = new Map<string, string>();
          for (const m of existing.metrics) ids.set(m.metricKey, m.id);
          profilesByMfr.set(mfrRaw, { id: existing.id, metricRowIds: ids });
          continue;
        }
      }
      throw err;
    }
  }

  // Pass 2: every SEED_MAP entry with a non-null modelPattern becomes an
  // override under the parent profile's matching metric row.
  for (const seedRow of SEED_MAP) {
    if (!seedRow.modelPattern) continue;
    const parent = profilesByMfr.get(seedRow.manufacturer);
    if (!parent) {
      logger.warn({ vendorLabel: seedRow.vendorLabel }, "No parent profile for override seed; skipping");
      continue;
    }
    const profile = VENDOR_TELEMETRY_PROFILES.find((p) => p.vendor === seedRow.vendorLabel);
    if (!profile) continue;
    const seeds = profileToMetricSeeds(profile);
    for (const s of seeds) {
      const metricRowId = parent.metricRowIds.get(s.metricKey);
      if (!metricRowId) continue;
      try {
        await (prisma as any).manufacturerProfileMetricOverride.create({
          data: {
            metricRowId,
            modelPattern: seedRow.modelPattern,
            symbol:       s.symbol,
            type:         s.type,
            order:        0,
            // Composition is memory-only today; carried into the override row
            // so e.g. the FortiSwitch entry under Fortinet's Memory metric
            // gets `{ shape: "bytes_used_total", usedSymbol, totalSymbol }`.
            composition:  s.composition ?? null,
          },
        });
        createdOverrides += 1;
      } catch (err) {
        logger.warn({ err, vendorLabel: seedRow.vendorLabel, metricKey: s.metricKey }, "Failed to seed override");
      }
    }
  }

  await stampMarker({ profiles: createdProfiles, overrides: createdOverrides });
  return { profiles: createdProfiles, overrides: createdOverrides, skipped: false };
}

(async () => {
  try {
    await runInstrumentedJob("seedManufacturerProfiles", async () => {
      const result = await seedManufacturerProfiles();
      if (!result.skipped) {
        logger.info(result, "Seeded manufacturer profiles from VENDOR_TELEMETRY_PROFILES");
      }
      await refreshProfileCache();
    });
  } catch (err) {
    logger.error({ err }, "seedManufacturerProfiles startup task failed");
  }
})();
