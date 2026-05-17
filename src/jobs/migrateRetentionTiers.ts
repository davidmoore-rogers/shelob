/**
 * src/jobs/migrateRetentionTiers.ts
 *
 * One-shot startup migration that expands the single-tier retention fields
 * into the new detail / hourly / daily tier shape.
 *
 * Before this migration:
 *   - Setting("manualMonitorSettings").{sample,telemetry,systemInfo}RetentionDays
 *   - Integration.config.monitorSettings.{sample,telemetry,systemInfo}RetentionDays
 *   - MonitorClassOverride.{sample,telemetry,systemInfo}RetentionDays
 *
 * After this migration:
 *   - The legacy single-tier columns/keys are preserved (the resolver + prune
 *     layer still consume them until phase 5 lands).
 *   - Each carries new sibling fields *DetailRetentionDays /
 *     *HourlyRetentionDays / *DailyRetentionDays.
 *   - Detail is seeded from the legacy value (operator's current choice
 *     preserved). Hourly defaults to 30, daily to 365 — matches the
 *     SolarWinds tiering operators already understand.
 *
 * Phase 1 lands the schema + this seed; phases 2-4 add the rollup writer
 * and tier-aware reader, then phase 5 makes the prune layer consume the
 * tiered values and drops the legacy columns.
 *
 * Idempotent via the `retentionTiersMigratedAt` Setting marker. Safe on
 * fresh installs (no legacy values to copy → just stamps defaults and the
 * marker). Defensive against the boot-time race with
 * migrateMonitorSettingsHierarchy by polling its completion marker before
 * doing any writes.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { invalidateMonitorSettingsCache } from "../services/monitoringService.js";
import { runInstrumentedJob } from "./_metrics.js";

const MANUAL_KEY            = "manualMonitorSettings";
const HIERARCHY_MARKER_KEY  = "monitorSettingsHierarchyMigratedAt";
const MIGRATED_KEY          = "retentionTiersMigratedAt";

// New defaults for the two tiers operators have no legacy value for. Detail
// comes from the legacy retention field — operators who tuned that get to
// keep their choice.
const DEFAULT_HOURLY_DAYS = 30;
const DEFAULT_DAILY_DAYS  = 365;

// Streams whose retention now splits into three tiers. Each maps the legacy
// key name to the new tier-3 keys we write alongside.
const STREAMS = [
  {
    legacy:        "sampleRetentionDays",
    detail:        "sampleDetailRetentionDays",
    hourly:        "sampleHourlyRetentionDays",
    daily:         "sampleDailyRetentionDays",
  },
  {
    legacy:        "telemetryRetentionDays",
    detail:        "telemetryDetailRetentionDays",
    hourly:        "telemetryHourlyRetentionDays",
    daily:         "telemetryDailyRetentionDays",
  },
  {
    legacy:        "systemInfoRetentionDays",
    detail:        "systemInfoDetailRetentionDays",
    hourly:        "systemInfoHourlyRetentionDays",
    daily:         "systemInfoDailyRetentionDays",
  },
] as const;

/**
 * Read a JSON settings blob and return the expanded object. Returns
 * `{ value, changed }` so the caller can skip the DB write when nothing
 * needs to change. Per-stream rules:
 *   - If detail is already set, leave it alone (idempotent).
 *   - Otherwise, copy the legacy value when present; fall through to
 *     `DEFAULT_HOURLY_DAYS` only when neither legacy nor detail is set
 *     (covers brand-new tier-3 rows seeded with empty objects).
 *   - Hourly/daily get defaults when absent.
 */
function expandTierRetention(
  raw: Record<string, unknown> | null | undefined,
): { value: Record<string, unknown>; changed: boolean } {
  const value: Record<string, unknown> = { ...(raw ?? {}) };
  let changed = false;

  for (const s of STREAMS) {
    const legacy = value[s.legacy];
    const legacyN = typeof legacy === "number" && Number.isFinite(legacy) && legacy >= 0
      ? Math.floor(legacy)
      : null;

    if (value[s.detail] === undefined) {
      value[s.detail] = legacyN ?? DEFAULT_HOURLY_DAYS;
      changed = true;
    }
    if (value[s.hourly] === undefined) {
      value[s.hourly] = DEFAULT_HOURLY_DAYS;
      changed = true;
    }
    if (value[s.daily] === undefined) {
      value[s.daily] = DEFAULT_DAILY_DAYS;
      changed = true;
    }
  }
  return { value, changed };
}

/**
 * Defensive wait for the hierarchy-migration marker so we don't seed retention
 * tiers into a manualMonitorSettings row that doesn't exist yet. Hierarchy
 * usually completes within a few hundred ms of boot; after that the marker
 * sticks for the life of the install.
 */
async function waitForHierarchyMigration(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const marker = await prisma.setting.findUnique({ where: { key: HIERARCHY_MARKER_KEY } });
    if (marker) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  // 5 seconds elapsed without hierarchy stamping its marker — proceed
  // anyway. On a fresh-install boot the hierarchy IIFE may legitimately
  // skip writing the marker until much later in startup, and we don't
  // want this migration to block forever.
  logger.warn("Retention-tier migration proceeding without hierarchy marker (took >5s)");
}

(async () => {
  try {
    await runInstrumentedJob("migrateRetentionTiers", async () => {
      // Idempotency guard.
      const migratedRow = await prisma.setting.findUnique({ where: { key: MIGRATED_KEY } });
      if (migratedRow) return;

      await waitForHierarchyMigration();

      let manualUpdated       = false;
      let integrationsUpdated = 0;
      let overridesUpdated    = 0;

      // ── Manual tier ────────────────────────────────────────────────────
      const manualRow = await prisma.setting.findUnique({ where: { key: MANUAL_KEY } });
      if (manualRow) {
        const { value, changed } = expandTierRetention(manualRow.value as Record<string, unknown> | null);
        if (changed) {
          await prisma.setting.update({ where: { key: MANUAL_KEY }, data: { value: value as any } });
          manualUpdated = true;
        }
      } else {
        // No manual tier yet — seed it with defaults so the resolver has
        // something to read from once phase 5 starts consuming the tiered
        // fields.
        await prisma.setting.create({
          data: {
            key: MANUAL_KEY,
            value: expandTierRetention({}).value as any,
          },
        });
        manualUpdated = true;
      }

      // ── Integration tier ───────────────────────────────────────────────
      const integrations = await prisma.integration.findMany({ select: { id: true, config: true } });
      for (const integ of integrations) {
        const cfg = (integ.config && typeof integ.config === "object" ? integ.config : null) as
          | Record<string, unknown>
          | null;
        if (!cfg) continue;
        const ms = (cfg.monitorSettings && typeof cfg.monitorSettings === "object"
          ? cfg.monitorSettings
          : null) as Record<string, unknown> | null;
        if (!ms) continue;
        const { value, changed } = expandTierRetention(ms);
        if (changed) {
          await prisma.integration.update({
            where: { id: integ.id },
            data:  { config: { ...cfg, monitorSettings: value } as any },
          });
          integrationsUpdated++;
        }
      }

      // ── MonitorClassOverride rows ──────────────────────────────────────
      // Real columns this time, not JSON. For each row, copy the legacy
      // retention column into the matching *DetailRetentionDays when the
      // detail column is null. Hourly/daily are left null (= inherit from
      // the tier below); operators who want per-class hourly/daily set
      // them explicitly.
      const overrides = await prisma.monitorClassOverride.findMany({
        select: {
          id: true,
          sampleRetentionDays: true,
          telemetryRetentionDays: true,
          systemInfoRetentionDays: true,
          sampleDetailRetentionDays: true,
          telemetryDetailRetentionDays: true,
          systemInfoDetailRetentionDays: true,
        },
      });
      for (const o of overrides) {
        const data: Record<string, number> = {};
        if (o.sampleDetailRetentionDays == null && o.sampleRetentionDays != null) {
          data.sampleDetailRetentionDays = o.sampleRetentionDays;
        }
        if (o.telemetryDetailRetentionDays == null && o.telemetryRetentionDays != null) {
          data.telemetryDetailRetentionDays = o.telemetryRetentionDays;
        }
        if (o.systemInfoDetailRetentionDays == null && o.systemInfoRetentionDays != null) {
          data.systemInfoDetailRetentionDays = o.systemInfoRetentionDays;
        }
        if (Object.keys(data).length === 0) continue;
        await prisma.monitorClassOverride.update({ where: { id: o.id }, data });
        overridesUpdated++;
      }

      await prisma.setting.create({
        data: {
          key: MIGRATED_KEY,
          value: {
            migratedAt: new Date().toISOString(),
            manualUpdated,
            integrationsUpdated,
            overridesUpdated,
          } as any,
        },
      });

      // Drop the resolver cache so the next monitor pass reads through to
      // the freshly-seeded tier-3 values rather than any in-memory copies
      // captured before this job ran.
      invalidateMonitorSettingsCache();

      logger.info(
        { manualUpdated, integrationsUpdated, overridesUpdated },
        "Retention-tier migration complete (detail seeded from legacy; hourly/daily defaulted)",
      );
    });
  } catch (err) {
    logger.error(
      { err },
      "Retention-tier startup migration failed — rerun cleanly by deleting the retentionTiersMigratedAt Setting row and restarting",
    );
  }
})();
