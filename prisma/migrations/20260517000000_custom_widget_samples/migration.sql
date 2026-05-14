-- Slice 7 — Custom MIB tab schema.
--
-- Adds the per-asset and per-class-override cadence columns for the new
-- `customWidget` stream plus the AssetCustomWidgetSample time-series table
-- that the Custom MIB tab consumes. All additions are nullable / additive
-- so existing rows are untouched.

-- ── Asset columns ───────────────────────────────────────────────────────
ALTER TABLE "assets" ADD COLUMN "customWidgetPolling"     TEXT;
ALTER TABLE "assets" ADD COLUMN "customWidgetCredentialId" TEXT;
ALTER TABLE "assets" ADD COLUMN "customWidgetIntervalSec" INTEGER;
ALTER TABLE "assets" ADD COLUMN "customWidgetTimeoutMs"   INTEGER;
ALTER TABLE "assets" ADD COLUMN "lastCustomWidgetAt"      TIMESTAMP(3);

ALTER TABLE "assets" ADD CONSTRAINT "assets_customWidgetCredentialId_fkey"
  FOREIGN KEY ("customWidgetCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "assets_customWidgetCredentialId_idx" ON "assets"("customWidgetCredentialId");

-- ── MonitorClassOverride columns ────────────────────────────────────────
ALTER TABLE "monitor_class_overrides" ADD COLUMN "customWidgetPolling"        TEXT;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "customWidgetCredentialId"   TEXT;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "customWidgetIntervalSeconds" INTEGER;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "customWidgetTimeoutMs"      INTEGER;

ALTER TABLE "monitor_class_overrides" ADD CONSTRAINT "monitor_class_overrides_customWidgetCredentialId_fkey"
  FOREIGN KEY ("customWidgetCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "monitor_class_overrides_customWidgetCredentialId_idx" ON "monitor_class_overrides"("customWidgetCredentialId");

-- ── AssetCustomWidgetSample ────────────────────────────────────────────
CREATE TABLE "asset_custom_widget_samples" (
  "id"        TEXT PRIMARY KEY,
  "assetId"   TEXT NOT NULL REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "widgetId"  TEXT NOT NULL,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "kind"      TEXT NOT NULL,
  "value"     JSONB NOT NULL
);
CREATE INDEX "asset_custom_widget_samples_assetId_timestamp_idx"
  ON "asset_custom_widget_samples"("assetId", "timestamp");
CREATE INDEX "asset_custom_widget_samples_assetId_widgetId_timestamp_idx"
  ON "asset_custom_widget_samples"("assetId", "widgetId", "timestamp");
CREATE INDEX "asset_custom_widget_samples_widgetId_idx"
  ON "asset_custom_widget_samples"("widgetId");
