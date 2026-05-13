-- Per-stream collector timeouts.
--
-- The response-time probe already had a per-asset / per-class / per-tier
-- `probeTimeoutMs`. The telemetry + system-info collectors used a single
-- hardcoded 10s budget for every FortiOS REST / SNMP request. Operators on
-- slow links (FortiManager-proxied scrapes across WAN, busy SNMP agents)
-- need the same knob the response-time stream has.
--
-- Add nullable Int columns at every tier that already carries `probeTimeoutMs`.
-- Range / sanity validation is enforced in the route Zod schemas (1000..120000).

ALTER TABLE "assets"
  ADD COLUMN "telemetryTimeoutMs"  INTEGER,
  ADD COLUMN "systemInfoTimeoutMs" INTEGER;

ALTER TABLE "monitor_class_overrides"
  ADD COLUMN "telemetryTimeoutMs"  INTEGER,
  ADD COLUMN "systemInfoTimeoutMs" INTEGER;
