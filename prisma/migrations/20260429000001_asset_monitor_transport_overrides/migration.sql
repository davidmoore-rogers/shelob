-- Per-stream monitor transport overrides on Asset.
-- null = inherit from the integration's matching toggle (default "rest").
-- "rest" or "snmp" = explicit override.
ALTER TABLE "assets"
  ADD COLUMN "monitorResponseTimeSource" TEXT,
  ADD COLUMN "monitorTelemetrySource"    TEXT,
  ADD COLUMN "monitorInterfacesSource"   TEXT;
