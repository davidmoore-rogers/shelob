-- Add storage as an independent per-stream polling method, paralleling the
-- five existing streams (responseTime / cpuMemory / temperature / interfaces
-- / lldp). null = inherit from the class override / integration tier / source
-- default. Source defaults: FMG/FortiGate → "disabled" (no meaningful storage
-- on FortiOS appliances); every other source → null (= "not delivered"),
-- operators opt in by picking SNMP at any tier.

ALTER TABLE "assets" ADD COLUMN "storagePolling" TEXT;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "storagePolling" TEXT;
