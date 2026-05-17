-- Adds a nullable TEXT `defaultMibStdKey` / `mibStdKey` column to
-- manufacturer_profile_metrics and manufacturer_profile_metric_overrides.
-- Operator-pinned standard MIB key (e.g. "std:lldp", "std:host-resources").
-- Display-only at probe time: the resolver still walks
-- asset → model → vendor → generic → seed; this column lets the editable
-- profile table render a meaningful MIB label for metrics whose symbol
-- resolves from a built-in seed instead of the literal word "seed".
-- Mutually exclusive with defaultMibId / mibId in the UI.

ALTER TABLE "manufacturer_profile_metrics"
  ADD COLUMN "defaultMibStdKey" TEXT;

ALTER TABLE "manufacturer_profile_metric_overrides"
  ADD COLUMN "mibStdKey" TEXT;
