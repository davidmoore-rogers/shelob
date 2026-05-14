-- Split the `telemetry` monitor stream into separate `cpuMemory` +
-- `temperature` streams.
--
-- Background: the legacy `telemetry` stream was one unit covering
-- CPU + memory + temperature with a single polling method, credential,
-- MIB, timeout, and cadence. On some small-branch firmware the FortiOS
-- REST sensor endpoint works while CPU/memory does not — operators
-- couldn't mix without splitting the stream.
--
-- Strategy: add the new per-stream columns, copy legacy values into
-- BOTH new streams so existing operator selections carry forward
-- identically, then drop the legacy columns. The retention column
-- (`telemetryRetentionDays`) stays as-is — sample retention is
-- table-level and continues to govern both AssetTelemetrySample
-- (CPU/memory) AND AssetTemperatureSample.
--
-- Tier-3 JSON shapes (Integration.config.monitorSettings,
-- Setting.manualMonitorSettings) are migrated below by rewriting their
-- `telemetryIntervalSeconds` / `telemetryTimeoutMs` keys into both
-- new streams. Existing operator selections preserve cadence and
-- timeout identically.

-- ── assets: add new columns ───────────────────────────────────────────
ALTER TABLE "assets"
  ADD COLUMN "cpuMemoryPolling"       TEXT,
  ADD COLUMN "temperaturePolling"     TEXT,
  ADD COLUMN "cpuMemoryCredentialId"  TEXT,
  ADD COLUMN "temperatureCredentialId" TEXT,
  ADD COLUMN "cpuMemoryMibId"         TEXT,
  ADD COLUMN "temperatureMibId"       TEXT,
  ADD COLUMN "cpuMemoryTimeoutMs"     INTEGER,
  ADD COLUMN "temperatureTimeoutMs"   INTEGER,
  ADD COLUMN "cpuMemoryIntervalSec"   INTEGER,
  ADD COLUMN "temperatureIntervalSec" INTEGER;

-- ── assets: backfill from legacy `telemetry*` columns ─────────────────
UPDATE "assets" SET
  "cpuMemoryPolling"        = "telemetryPolling",
  "temperaturePolling"      = "telemetryPolling",
  "cpuMemoryCredentialId"   = "telemetryCredentialId",
  "temperatureCredentialId" = "telemetryCredentialId",
  "cpuMemoryMibId"          = "telemetryMibId",
  "temperatureMibId"        = "telemetryMibId",
  "cpuMemoryTimeoutMs"      = "telemetryTimeoutMs",
  "temperatureTimeoutMs"    = "telemetryTimeoutMs",
  "cpuMemoryIntervalSec"    = "telemetryIntervalSec",
  "temperatureIntervalSec"  = "telemetryIntervalSec";

-- ── assets: add FK constraints + indexes for new credential columns ──
ALTER TABLE "assets"
  ADD CONSTRAINT "assets_cpuMemoryCredentialId_fkey"
    FOREIGN KEY ("cpuMemoryCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "assets_temperatureCredentialId_fkey"
    FOREIGN KEY ("temperatureCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "assets_cpuMemoryCredentialId_idx"    ON "assets"("cpuMemoryCredentialId");
CREATE INDEX "assets_temperatureCredentialId_idx" ON "assets"("temperatureCredentialId");

-- ── assets: drop legacy `telemetry*` columns ──────────────────────────
-- FK on telemetryCredentialId is dropped automatically when the column goes.
ALTER TABLE "assets"
  DROP COLUMN "telemetryPolling",
  DROP COLUMN "telemetryCredentialId",
  DROP COLUMN "telemetryMibId",
  DROP COLUMN "telemetryTimeoutMs",
  DROP COLUMN "telemetryIntervalSec";

-- ── monitor_class_overrides: add new columns ──────────────────────────
ALTER TABLE "monitor_class_overrides"
  ADD COLUMN "cpuMemoryPolling"           TEXT,
  ADD COLUMN "temperaturePolling"         TEXT,
  ADD COLUMN "cpuMemoryCredentialId"      TEXT,
  ADD COLUMN "temperatureCredentialId"    TEXT,
  ADD COLUMN "cpuMemoryMibId"             TEXT,
  ADD COLUMN "temperatureMibId"           TEXT,
  ADD COLUMN "cpuMemoryTimeoutMs"         INTEGER,
  ADD COLUMN "temperatureTimeoutMs"       INTEGER,
  ADD COLUMN "cpuMemoryIntervalSeconds"   INTEGER,
  ADD COLUMN "temperatureIntervalSeconds" INTEGER;

-- ── monitor_class_overrides: backfill from legacy ────────────────────
UPDATE "monitor_class_overrides" SET
  "cpuMemoryPolling"           = "telemetryPolling",
  "temperaturePolling"         = "telemetryPolling",
  "cpuMemoryCredentialId"      = "telemetryCredentialId",
  "temperatureCredentialId"    = "telemetryCredentialId",
  "cpuMemoryMibId"             = "telemetryMibId",
  "temperatureMibId"           = "telemetryMibId",
  "cpuMemoryTimeoutMs"         = "telemetryTimeoutMs",
  "temperatureTimeoutMs"       = "telemetryTimeoutMs",
  "cpuMemoryIntervalSeconds"   = "telemetryIntervalSeconds",
  "temperatureIntervalSeconds" = "telemetryIntervalSeconds";

-- ── monitor_class_overrides: FK constraints + indexes ─────────────────
ALTER TABLE "monitor_class_overrides"
  ADD CONSTRAINT "monitor_class_overrides_cpuMemoryCredentialId_fkey"
    FOREIGN KEY ("cpuMemoryCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "monitor_class_overrides_temperatureCredentialId_fkey"
    FOREIGN KEY ("temperatureCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "monitor_class_overrides_cpuMemoryCredentialId_idx"    ON "monitor_class_overrides"("cpuMemoryCredentialId");
CREATE INDEX "monitor_class_overrides_temperatureCredentialId_idx" ON "monitor_class_overrides"("temperatureCredentialId");

-- ── monitor_class_overrides: drop legacy columns ──────────────────────
ALTER TABLE "monitor_class_overrides"
  DROP COLUMN "telemetryPolling",
  DROP COLUMN "telemetryCredentialId",
  DROP COLUMN "telemetryMibId",
  DROP COLUMN "telemetryTimeoutMs",
  DROP COLUMN "telemetryIntervalSeconds";

-- ── Tier-3 JSON: rewrite Integration.config.monitorSettings keys ─────
-- Each Integration row's `config` JSONB may carry a `monitorSettings`
-- sub-object with `telemetryIntervalSeconds` and `telemetryTimeoutMs`.
-- Copy those values into the two new stream-specific keys and remove
-- the legacy ones. jsonb_set is idempotent against existing rows; the
-- `WHERE` clause skips rows that don't have a monitorSettings object so
-- a stray row with config = '{}' or config = NULL doesn't fail.
UPDATE "integrations"
SET    "config" = jsonb_set(
                    jsonb_set(
                      jsonb_set(
                        jsonb_set(
                          ("config"::jsonb) #- '{monitorSettings,telemetryIntervalSeconds}'
                                            #- '{monitorSettings,telemetryTimeoutMs}',
                          '{monitorSettings,cpuMemoryIntervalSeconds}',
                          COALESCE(("config"::jsonb) #> '{monitorSettings,telemetryIntervalSeconds}', 'null'::jsonb),
                          true
                        ),
                        '{monitorSettings,temperatureIntervalSeconds}',
                        COALESCE(("config"::jsonb) #> '{monitorSettings,telemetryIntervalSeconds}', 'null'::jsonb),
                        true
                      ),
                      '{monitorSettings,cpuMemoryTimeoutMs}',
                      COALESCE(("config"::jsonb) #> '{monitorSettings,telemetryTimeoutMs}', 'null'::jsonb),
                      true
                    ),
                    '{monitorSettings,temperatureTimeoutMs}',
                    COALESCE(("config"::jsonb) #> '{monitorSettings,telemetryTimeoutMs}', 'null'::jsonb),
                    true
                  )
WHERE  ("config"::jsonb) ? 'monitorSettings'
   AND (("config"::jsonb) -> 'monitorSettings') ?| ARRAY['telemetryIntervalSeconds','telemetryTimeoutMs'];

-- ── Tier-3 JSON: rewrite Setting.manualMonitorSettings shape ─────────
-- The manual-tier baseline sits in a single Setting row keyed
-- 'manualMonitorSettings'. Apply the same rewrite to its `value` JSONB.
UPDATE "settings"
SET    "value" = jsonb_set(
                   jsonb_set(
                     jsonb_set(
                       jsonb_set(
                         ("value"::jsonb) - 'telemetryIntervalSeconds'
                                          - 'telemetryTimeoutMs',
                         '{cpuMemoryIntervalSeconds}',
                         COALESCE(("value"::jsonb) -> 'telemetryIntervalSeconds', 'null'::jsonb),
                         true
                       ),
                       '{temperatureIntervalSeconds}',
                       COALESCE(("value"::jsonb) -> 'telemetryIntervalSeconds', 'null'::jsonb),
                       true
                     ),
                     '{cpuMemoryTimeoutMs}',
                     COALESCE(("value"::jsonb) -> 'telemetryTimeoutMs', 'null'::jsonb),
                     true
                   ),
                   '{temperatureTimeoutMs}',
                   COALESCE(("value"::jsonb) -> 'telemetryTimeoutMs', 'null'::jsonb),
                   true
                 )
WHERE  "key"   = 'manualMonitorSettings'
   AND ("value"::jsonb) ?| ARRAY['telemetryIntervalSeconds','telemetryTimeoutMs'];
