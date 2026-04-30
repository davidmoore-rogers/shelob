-- Per-token integration scoping. Tokens with assets:quarantine MUST list at
-- least one integration id; the quarantine service filters sightings by the
-- token's integrationIds[] when called via bearer auth, so a token minted for
-- one FMG/FortiGate can never accidentally push to another.
ALTER TABLE "api_tokens" ADD COLUMN "integrationIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
