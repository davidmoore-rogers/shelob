-- Adds a nullable JSONB `composition` column to both
-- manufacturer_profile_metrics and manufacturer_profile_metric_overrides.
-- Consulted by manufacturerProfileService when metricKey="memory" to express
-- the multi-OID memory shape (Used+Total or Used+Free) in the editable
-- profile — matches what the hardcoded VENDOR_TELEMETRY_PROFILES baseline
-- can already do for FortiSwitch via collectMemoryVendor. When present takes
-- precedence over the existing single-symbol defaultSymbol / symbol columns.

ALTER TABLE "manufacturer_profile_metrics"
  ADD COLUMN "composition" JSONB;

ALTER TABLE "manufacturer_profile_metric_overrides"
  ADD COLUMN "composition" JSONB;
