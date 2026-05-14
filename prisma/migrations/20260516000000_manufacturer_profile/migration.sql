-- Editable Manufacturer Profile foundation (Slice 6a).
--
-- The hardcoded VENDOR_TELEMETRY_PROFILES constant becomes seed data for
-- per-manufacturer database rows. The data model is purely additive — the
-- monitoring path still consults the constant until the resolver swap in a
-- follow-up commit. Existing installs see no behavior change beyond the
-- seed rows appearing in the new tables.

-- Per-asset MIB upload scope. Third tier in the resolver priority chain
-- (asset → model → manufacturer → generic → seed), used when one device of
-- a fleet runs different firmware that exposes vendor symbols the rest
-- doesn't. SetNull on asset delete so removing the asset keeps the MIB
-- text reachable for download/audit.
ALTER TABLE "mib_files" ADD COLUMN "assetId" TEXT;
ALTER TABLE "mib_files" ADD CONSTRAINT "mib_files_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "mib_files_assetId_idx" ON "mib_files"("assetId");

-- Manufacturer profile root. One row per alias-canonicalized manufacturer.
CREATE TABLE "manufacturer_profiles" (
  "id"           TEXT PRIMARY KEY,
  "manufacturer" TEXT NOT NULL UNIQUE,
  "createdBy"    TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL
);

-- Per-metric row under one profile. Default symbol/mib/type/transform
-- describes the universal probe shape for the manufacturer; per-model
-- exceptions live in the overrides table.
CREATE TABLE "manufacturer_profile_metrics" (
  "id"               TEXT PRIMARY KEY,
  "profileId"        TEXT NOT NULL REFERENCES "manufacturer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "metricKey"        TEXT NOT NULL,
  "defaultSymbol"    TEXT,
  "defaultMibId"     TEXT REFERENCES "mib_files"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "defaultType"      TEXT NOT NULL DEFAULT 'scalar',
  "defaultTransform" TEXT,
  CONSTRAINT "manufacturer_profile_metrics_profileId_metricKey_key" UNIQUE ("profileId", "metricKey")
);
CREATE INDEX "manufacturer_profile_metrics_defaultMibId_idx" ON "manufacturer_profile_metrics"("defaultMibId");

-- Per-model override under one metric row. Evaluated in order (lower wins);
-- first match against Asset.model is the effective symbol for that asset.
CREATE TABLE "manufacturer_profile_metric_overrides" (
  "id"           TEXT PRIMARY KEY,
  "metricRowId"  TEXT NOT NULL REFERENCES "manufacturer_profile_metrics"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "modelPattern" TEXT NOT NULL,
  "symbol"       TEXT NOT NULL,
  "mibId"        TEXT REFERENCES "mib_files"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "type"         TEXT NOT NULL DEFAULT 'scalar',
  "transform"    TEXT,
  "order"        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "manufacturer_profile_metric_overrides_metricRowId_order_idx"
  ON "manufacturer_profile_metric_overrides"("metricRowId", "order");
CREATE INDEX "manufacturer_profile_metric_overrides_mibId_idx"
  ON "manufacturer_profile_metric_overrides"("mibId");

-- Custom widget defined under a manufacturer profile. Consumed by the
-- Custom MIB tab on the asset details modal (Slice 7) — every asset whose
-- manufacturer matches the profile (and whose model satisfies the optional
-- modelPattern gate) renders this widget against its own SNMP data.
CREATE TABLE "manufacturer_custom_widgets" (
  "id"             TEXT PRIMARY KEY,
  "profileId"      TEXT NOT NULL REFERENCES "manufacturer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name"           TEXT NOT NULL,
  "symbol"         TEXT NOT NULL,
  "mibId"          TEXT NOT NULL REFERENCES "mib_files"("id") ON UPDATE CASCADE,
  "type"           TEXT NOT NULL DEFAULT 'scalar',
  "widgetType"     TEXT NOT NULL,
  "transform"      TEXT,
  "displayOptions" JSONB NOT NULL DEFAULT '{}',
  "order"          INTEGER NOT NULL DEFAULT 0,
  "modelPattern"   TEXT,
  "createdBy"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL
);
CREATE INDEX "manufacturer_custom_widgets_profileId_order_idx"
  ON "manufacturer_custom_widgets"("profileId", "order");
CREATE INDEX "manufacturer_custom_widgets_mibId_idx"
  ON "manufacturer_custom_widgets"("mibId");
