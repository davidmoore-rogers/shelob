-- Per-subnet "last refreshed by discovery" timestamp. Bumped by the
-- integration-wide discoverDhcpSubnets pass and by the per-subnet
-- Refresh action; drives the "Discovered N minutes ago" line in the
-- IP panel slide-in.

ALTER TABLE "subnets"
  ADD COLUMN "lastDiscoveredAt" TIMESTAMP(3);

-- Seed: for already-discovered subnets, treat updatedAt as the best-known
-- last-refreshed time so the UI doesn't show a permanent "never" until the
-- next discovery cycle. Manually-created subnets stay null.
UPDATE "subnets"
  SET "lastDiscoveredAt" = "updatedAt"
  WHERE "discoveredBy" IS NOT NULL;
