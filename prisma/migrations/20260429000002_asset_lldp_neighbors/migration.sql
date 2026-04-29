-- Current-state LLDP neighbor table per (asset, local interface). Replaced in
-- full on every system-info pass that successfully queried LLDP (FortiOS
-- /api/v2/monitor/system/interface/lldp-neighbors, or SNMP LLDP-MIB walk).
-- Powers the "Neighbor" column on the System tab interface table and feeds
-- the Device Map topology graph with real edges to non-Fortinet gear.

CREATE TABLE "asset_lldp_neighbors" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "localIfName" TEXT NOT NULL,
    "chassisIdSubtype" TEXT,
    "chassisId" TEXT,
    "portIdSubtype" TEXT,
    "portId" TEXT,
    "portDescription" TEXT,
    "systemName" TEXT,
    "systemDescription" TEXT,
    "managementIp" TEXT,
    "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "matchedAssetId" TEXT,
    "source" TEXT NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_lldp_neighbors_pkey" PRIMARY KEY ("id")
);

-- (assetId, localIfName, chassisId, portId) is the natural identity of a
-- neighbor sighting. Postgres treats NULLs as distinct, which we rely on so
-- two neighbors that both lack chassisId/portId can coexist (rare but valid
-- for some odd LLDP implementations).
CREATE UNIQUE INDEX "asset_lldp_neighbors_asset_iface_chassis_port_key"
    ON "asset_lldp_neighbors"("assetId", "localIfName", "chassisId", "portId");

CREATE INDEX "asset_lldp_neighbors_assetId_idx"
    ON "asset_lldp_neighbors"("assetId");
CREATE INDEX "asset_lldp_neighbors_assetId_localIfName_idx"
    ON "asset_lldp_neighbors"("assetId", "localIfName");
CREATE INDEX "asset_lldp_neighbors_matchedAssetId_idx"
    ON "asset_lldp_neighbors"("matchedAssetId");

ALTER TABLE "asset_lldp_neighbors"
    ADD CONSTRAINT "asset_lldp_neighbors_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "asset_lldp_neighbors"
    ADD CONSTRAINT "asset_lldp_neighbors_matchedAssetId_fkey"
    FOREIGN KEY ("matchedAssetId") REFERENCES "assets"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
