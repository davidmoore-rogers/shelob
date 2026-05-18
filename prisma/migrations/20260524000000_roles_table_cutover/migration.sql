-- Roles table cutover: replaces the hardcoded UserRole enum with a Role
-- table whose `permissions` JSONB carries a per-function access matrix.
-- The five seeded rows reproduce the pre-cutover access exactly:
--
--   admin        — every function = fullwrite, isProtected = true
--   readonly     — every readable-by-non-admin function = read, others = none,
--                  isProtected = true
--   networkadmin — same shape as the prior `requireNetworkAdmin` middleware
--   assetsadmin  — same shape as `requireAssetsAdmin`
--   user         — same shape as `requireUserOrAbove`
--
-- Backfill keys on `name = users.role::text` which works because the prior
-- enum values exactly match the seeded role names. After backfill the old
-- `role` column and `UserRole` enum are dropped.
--
-- Function-key catalogue (25 keys) lives in src/api/middleware/permissions.ts
-- and is exposed at GET /api/v1/roles/functions for the frontend matrix UI.
--
-- Access semantics:
--   none      — route returns 403
--   read      — GET allowed; everything else 403
--   write     — GET + write ops; on subnets/reservations the ownership
--               filter still applies (createdBy === username)
--   fullwrite — same as write, but bypasses the ownership filter on
--               subnets/reservations (functionally identical to write
--               on the other 23 functions)

-- 1) Create the roles table
CREATE TABLE "roles" (
    "id"            TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "description"   TEXT,
    "permissions"   JSONB NOT NULL DEFAULT '{}',
    -- Region scope inherited by every user holding this role. Empty array
    -- = unrestricted (matches the pre-cutover default so existing accounts
    -- aren't suddenly locked out). Effective regions for a session are
    -- `union(role.region_tags, user.region_tags)`. Storage only; the
    -- consumer surfaces (asset / subnet / reservation list filters, map
    -- view) live in a separate change.
    "region_tags"   TEXT[] NOT NULL DEFAULT '{}'::text[],
    "is_built_in"   BOOLEAN NOT NULL DEFAULT false,
    "is_protected"  BOOLEAN NOT NULL DEFAULT false,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- 2) Seed the five built-in roles
INSERT INTO "roles" ("id", "name", "description", "permissions", "is_built_in", "is_protected", "updatedAt") VALUES
(
  gen_random_uuid()::text,
  'admin',
  'Full access to every function. Locked — cannot be edited or deleted.',
  '{
    "ipBlocks":"fullwrite","subnets":"fullwrite","reservations":"fullwrite","reservationPush":"fullwrite",
    "allocationTemplates":"fullwrite","assets":"fullwrite","assetsQuarantine":"fullwrite","assetsProbe":"fullwrite",
    "assetMonitorSettings":"fullwrite","mibDatabase":"fullwrite","manufacturerProfiles":"fullwrite",
    "manufacturerAliases":"fullwrite","credentials":"fullwrite","integrations":"fullwrite",
    "discoveryConflicts":"fullwrite","deviceMap":"fullwrite","mapRegions":"fullwrite","deviceIcons":"fullwrite",
    "events":"fullwrite","staleReservations":"fullwrite","apiTokens":"fullwrite","users":"fullwrite",
    "roles":"fullwrite","serverSettingsSystem":"fullwrite","serverSettingsData":"fullwrite"
  }'::jsonb,
  true,
  true,
  CURRENT_TIMESTAMP
),
(
  gen_random_uuid()::text,
  'readonly',
  'Read-only on every function that allows non-admin reads. Locked.',
  '{
    "ipBlocks":"read","subnets":"read","reservations":"read","reservationPush":"read",
    "allocationTemplates":"read","assets":"read","assetsQuarantine":"read","assetsProbe":"read",
    "assetMonitorSettings":"read","mibDatabase":"read","manufacturerProfiles":"read",
    "manufacturerAliases":"none","credentials":"read","integrations":"none",
    "discoveryConflicts":"none","deviceMap":"read","mapRegions":"none","deviceIcons":"none",
    "events":"read","staleReservations":"read","apiTokens":"none","users":"none",
    "roles":"none","serverSettingsSystem":"none","serverSettingsData":"none"
  }'::jsonb,
  true,
  true,
  CURRENT_TIMESTAMP
),
(
  gen_random_uuid()::text,
  'networkadmin',
  'Full CRUD on IP space + integrations + map regions. Read elsewhere.',
  '{
    "ipBlocks":"fullwrite","subnets":"fullwrite","reservations":"fullwrite","reservationPush":"write",
    "allocationTemplates":"write","assets":"read","assetsQuarantine":"read","assetsProbe":"write",
    "assetMonitorSettings":"read","mibDatabase":"read","manufacturerProfiles":"read",
    "manufacturerAliases":"none","credentials":"read","integrations":"write",
    "discoveryConflicts":"write","deviceMap":"read","mapRegions":"write","deviceIcons":"none",
    "events":"read","staleReservations":"write","apiTokens":"none","users":"none",
    "roles":"none","serverSettingsSystem":"none","serverSettingsData":"none"
  }'::jsonb,
  true,
  false,
  CURRENT_TIMESTAMP
),
(
  gen_random_uuid()::text,
  'assetsadmin',
  'Full asset management + own-subnet/own-reservation writes.',
  '{
    "ipBlocks":"read","subnets":"write","reservations":"write","reservationPush":"read",
    "allocationTemplates":"read","assets":"write","assetsQuarantine":"write","assetsProbe":"write",
    "assetMonitorSettings":"write","mibDatabase":"read","manufacturerProfiles":"read",
    "manufacturerAliases":"none","credentials":"read","integrations":"none",
    "discoveryConflicts":"write","deviceMap":"read","mapRegions":"none","deviceIcons":"none",
    "events":"read","staleReservations":"read","apiTokens":"none","users":"none",
    "roles":"none","serverSettingsSystem":"none","serverSettingsData":"none"
  }'::jsonb,
  true,
  false,
  CURRENT_TIMESTAMP
),
(
  gen_random_uuid()::text,
  'user',
  'Own-subnet / own-reservation writes; read on everything authorized for non-admins.',
  '{
    "ipBlocks":"read","subnets":"write","reservations":"write","reservationPush":"read",
    "allocationTemplates":"read","assets":"read","assetsQuarantine":"read","assetsProbe":"write",
    "assetMonitorSettings":"read","mibDatabase":"read","manufacturerProfiles":"read",
    "manufacturerAliases":"none","credentials":"read","integrations":"none",
    "discoveryConflicts":"none","deviceMap":"read","mapRegions":"none","deviceIcons":"none",
    "events":"read","staleReservations":"write","apiTokens":"none","users":"none",
    "roles":"none","serverSettingsSystem":"none","serverSettingsData":"none"
  }'::jsonb,
  true,
  false,
  CURRENT_TIMESTAMP
);

-- 3) Add nullable role_id + region_tags to users. region_tags carries
-- the per-user region scope (empty = unrestricted). Effective regions
-- for a session are `union(role.region_tags, user.region_tags)`.
ALTER TABLE "users" ADD COLUMN "role_id" TEXT;
ALTER TABLE "users" ADD COLUMN "region_tags" TEXT[] NOT NULL DEFAULT '{}'::text[];

-- 4) Backfill role_id from the existing enum column
UPDATE "users"
SET "role_id" = (SELECT "id" FROM "roles" WHERE "name" = "users"."role"::text);

-- Safety: every user must have resolved to a role
DO $$
DECLARE
  unresolved_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO unresolved_count FROM "users" WHERE "role_id" IS NULL;
  IF unresolved_count > 0 THEN
    RAISE EXCEPTION 'roles_table_cutover: % users have NULL role_id after backfill', unresolved_count;
  END IF;
END $$;

-- 5) Lock role_id NOT NULL and add the FK + index
ALTER TABLE "users" ALTER COLUMN "role_id" SET NOT NULL;
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "users_role_id_idx" ON "users"("role_id");

-- 6) Drop the old enum column + type
ALTER TABLE "users" DROP COLUMN "role";
DROP TYPE "UserRole";
