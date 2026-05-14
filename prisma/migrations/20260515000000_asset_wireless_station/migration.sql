-- AssetWirelessStation: current-state table of wireless clients connected
-- to each FortiAP. Populated by the SNMP system-info pass when an
-- access_point asset has interfacesPolling resolved to "snmp" — the
-- collector walks fapStationTable (1.3.6.1.4.1.12356.120.8.1.1) and the
-- recordSystemInfoResult helper full-replaces the row set inside one
-- $transaction per asset.
--
-- Mirrors AssetLldpNeighbor shape, minus the 48h stickiness window:
-- wireless clients are transient by design, so a station absent from a
-- fresh scrape just drops on the spot. `matchedAssetId` is resolved at
-- persist time via a MAC-match against endpoint inventory; SetNull on
-- delete so removing the matched endpoint just clears the cross-link.
--
-- Additive migration — no data backfill needed.

CREATE TABLE "asset_wireless_stations" (
  "id"             TEXT        NOT NULL,
  "apAssetId"      TEXT        NOT NULL,
  "staMacAddr"     TEXT        NOT NULL,
  "staIpAddr"      TEXT,
  "ssid"           TEXT,
  "radioId"        INTEGER,
  "wlanId"         INTEGER,
  "vlanId"         INTEGER,
  "bssid"          TEXT,
  "signalStrength" INTEGER,
  "noise"          INTEGER,
  "bandwidthTx"    INTEGER,
  "bandwidthRx"    INTEGER,
  "idleSeconds"    INTEGER,
  "matchedAssetId" TEXT,
  "source"         TEXT        NOT NULL,
  "firstSeen"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeen"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "asset_wireless_stations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_wireless_stations_apAssetId_staMacAddr_key"
  ON "asset_wireless_stations"("apAssetId", "staMacAddr");
CREATE INDEX "asset_wireless_stations_apAssetId_idx"
  ON "asset_wireless_stations"("apAssetId");
CREATE INDEX "asset_wireless_stations_matchedAssetId_idx"
  ON "asset_wireless_stations"("matchedAssetId");
CREATE INDEX "asset_wireless_stations_staMacAddr_idx"
  ON "asset_wireless_stations"("staMacAddr");

ALTER TABLE "asset_wireless_stations"
  ADD CONSTRAINT "asset_wireless_stations_apAssetId_fkey"
    FOREIGN KEY ("apAssetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_wireless_stations_matchedAssetId_fkey"
    FOREIGN KEY ("matchedAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
