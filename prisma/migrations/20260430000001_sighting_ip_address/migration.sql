-- Track the IP address last seen for each (asset, FortiGate) DHCP sighting so the
-- Quarantine tab can show "what we saw" alongside the FortiGate name.
ALTER TABLE "asset_fortigate_sightings" ADD COLUMN "ipAddress" TEXT;
