-- Enable pg_trgm and add GIN trigram indexes on the JSON columns the global
-- search box scans for substring matches:
--   * Asset.associatedUsers — logged-in users from FortiGate DHCP sightings
--   * AssetSource.observed  — Entra/AD/Intune raw blobs (SID, UPN, etc.)
-- Without these indexes, an ILIKE substring scan would be a seq scan on every
-- row of every active fleet member at every keystroke. Trigram GINs reduce
-- that to an index lookup for any 3+ char query.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "assets_associatedUsers_trgm"
  ON assets USING gin ((("associatedUsers")::text) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "asset_sources_observed_trgm"
  ON asset_sources USING gin (((observed)::text) gin_trgm_ops);
