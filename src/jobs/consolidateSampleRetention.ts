/**
 * src/jobs/consolidateSampleRetention.ts
 *
 * One-shot startup migration. Seeds the new global
 * `Setting("sampleRetention")` row from the legacy single-tier retention
 * fields scattered across:
 *
 *   - `Setting("manualMonitorSettings")` — the operator's manual-tier
 *     `sampleRetentionDays` / `telemetryRetentionDays` /
 *     `systemInfoRetentionDays`, plus the nested switch / accessPoint
 *     overrides (formerly fortiswitch / fortiap before phase 0).
 *   - `Setting("monitorSettings")` — the legacy global row that predated
 *     the monitor-settings hierarchy. Usually deleted by
 *     migrateMonitorSettingsHierarchy; included here as a fallback for
 *     installs where that migration hasn't run yet for some reason.
 *
 * For each (stream, class) pair we take whichever legacy value is set
 * (priority: manualMonitorSettings > monitorSettings > hardcoded
 * default), then map it forward as the `detail` retention. `hourly`
 * defaults to 30, `daily` to 365. Operators with custom legacy values
 * (e.g. sampleRetentionDays=14) preserve their choice for the detail
 * tier and inherit the SolarWinds-style defaults for the new tiers.
 *
 * MonitorClassOverride retention columns (the per-(integration, assetType)
 * overrides phase 1 added 9 columns to) are NOT consulted. Phase 5 pulled
 * retention out of the per-tier hierarchy entirely; integration-scoped
 * retention overrides were rare in practice and don't have a natural
 * collapse into a global per-class shape. Those columns become unused
 * after this migration and will be dropped in a follow-up release.
 *
 * Idempotent via the `sampleRetentionConsolidatedAt` marker. Safe on
 * fresh installs (no legacy values → just seeds defaults and marker).
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import {
  defaultSampleRetention,
  invalidateSampleRetentionCache,
  SETTING_KEY as RETENTION_KEY,
  type ClassRetention,
  type SampleRetention,
} from "../services/sampleRetentionService.js";
import { runInstrumentedJob } from "./_metrics.js";

const MANUAL_KEY            = "manualMonitorSettings";
const LEGACY_MONITOR_KEY    = "monitorSettings";
const MIGRATED_KEY          = "sampleRetentionConsolidatedAt";

function toPositiveInt(v: unknown, fallback: number): number {
  if (v == null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * Resolve a legacy single-tier retention value for one (stream, class) pair.
 * Order: manualMonitorSettings (top-level for default class, nested for
 * switch/accessPoint) → monitorSettings (same shape) → hardcoded default.
 */
function legacyValue(
  manual: Record<string, unknown> | null,
  legacy: Record<string, unknown> | null,
  key: string,
  klass: "default" | "switch" | "accessPoint",
  fallback: number,
): number {
  function pickFrom(blob: Record<string, unknown> | null): number | null {
    if (!blob) return null;
    if (klass === "default") {
      const v = toPositiveInt(blob[key], -1);
      return v >= 0 ? v : null;
    }
    const nested = blob[klass];
    if (nested == null || typeof nested !== "object") return null;
    const v = toPositiveInt((nested as Record<string, unknown>)[key], -1);
    return v >= 0 ? v : null;
  }
  return pickFrom(manual) ?? pickFrom(legacy) ?? fallback;
}

(async () => {
  try {
    await runInstrumentedJob("consolidateSampleRetention", async () => {
      const migrated = await prisma.setting.findUnique({ where: { key: MIGRATED_KEY } });
      if (migrated) return;

      const existing = await prisma.setting.findUnique({ where: { key: RETENTION_KEY } });
      if (existing) {
        // Operator (or an earlier run) already populated the new setting;
        // mark consolidated and bail without touching their values.
        await prisma.setting.create({
          data: { key: MIGRATED_KEY, value: { migratedAt: new Date().toISOString(), alreadyPresent: true } as any },
        });
        return;
      }

      const manualRow = await prisma.setting.findUnique({ where: { key: MANUAL_KEY } });
      const legacyRow = await prisma.setting.findUnique({ where: { key: LEGACY_MONITOR_KEY } });
      const manual = (manualRow?.value as Record<string, unknown> | null) ?? null;
      const legacy = (legacyRow?.value as Record<string, unknown> | null) ?? null;

      const def = defaultSampleRetention();

      function consolidate(streamLegacyKey: "sampleRetentionDays" | "telemetryRetentionDays" | "systemInfoRetentionDays",
                           tierDefaults: { detail: ClassRetention; hourly: ClassRetention; daily: ClassRetention }) {
        return {
          detail: {
            default:     legacyValue(manual, legacy, streamLegacyKey, "default",     tierDefaults.detail.default),
            switch:      legacyValue(manual, legacy, streamLegacyKey, "switch",      tierDefaults.detail.switch),
            accessPoint: legacyValue(manual, legacy, streamLegacyKey, "accessPoint", tierDefaults.detail.accessPoint),
          },
          hourly: { ...tierDefaults.hourly },
          daily:  { ...tierDefaults.daily },
        };
      }

      const seeded: SampleRetention = {
        sample:     consolidate("sampleRetentionDays",     def.sample),
        telemetry:  consolidate("telemetryRetentionDays",  def.telemetry),
        systemInfo: consolidate("systemInfoRetentionDays", def.systemInfo),
      };

      await prisma.setting.create({ data: { key: RETENTION_KEY, value: seeded as any } });
      invalidateSampleRetentionCache();

      await prisma.setting.create({
        data: {
          key: MIGRATED_KEY,
          value: {
            migratedAt: new Date().toISOString(),
            hadLegacy: Boolean(manual || legacy),
            seeded,
          } as any,
        },
      });

      logger.info({ seeded }, "Sample retention consolidated into global Setting(sampleRetention)");
    });
  } catch (err) {
    logger.error(
      { err },
      "Sample-retention consolidation failed — rerun cleanly by deleting the sampleRetentionConsolidatedAt Setting row and restarting",
    );
  }
})();
