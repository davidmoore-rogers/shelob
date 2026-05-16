-- FortiGate SNMP sysLocation pull + geocoder cache.
--
-- Two columns on Asset for the raw sysLocation string + the timestamp of the
-- last successful SNMP pull. Both nullable so existing rows are unchanged.
-- Populated only on firewall assets discovered through an FMG/standalone
-- FortiGate integration whose `fortigateMonitor.pullSnmpLocation` toggle
-- is on AND whose resolved SNMP monitoring credential can reach the device.
--
-- The new `geocode_cache` table is the negative+positive cache backing the
-- Nominatim fallback used when the FortiGate's CMDB `gui-device-latitude` /
-- `gui-device-longitude` are missing or malformed. `query` is normalized
-- (trim + collapse whitespace + lowercased); `display_query` preserves the
-- original casing for UI display. ttl_expires_at lets the geocoder refresh
-- entries periodically without re-hitting the upstream on every cycle.

ALTER TABLE "assets" ADD COLUMN "snmpLocation" TEXT;
ALTER TABLE "assets" ADD COLUMN "snmpLocationFetchedAt" TIMESTAMP(3);

CREATE TABLE "geocode_cache" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "displayQuery" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "provider" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ttlExpiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "geocode_cache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "geocode_cache_query_key" ON "geocode_cache"("query");
CREATE INDEX "geocode_cache_ttlExpiresAt_idx" ON "geocode_cache"("ttlExpiresAt");
