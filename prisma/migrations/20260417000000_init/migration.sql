-- CreateEnum
CREATE TYPE "IpVersion" AS ENUM ('v4', 'v6');

-- CreateEnum
CREATE TYPE "SubnetStatus" AS ENUM ('available', 'reserved', 'deprecated');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('active', 'expired', 'released');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'networkadmin', 'assetsadmin', 'user', 'readonly');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('active', 'maintenance', 'decommissioned', 'storage');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('server', 'switch', 'router', 'firewall', 'workstation', 'printer', 'access_point', 'other');

-- CreateTable
CREATE TABLE "ip_blocks" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,
    "ipVersion" "IpVersion" NOT NULL,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ip_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subnets" (
    "id" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT,
    "status" "SubnetStatus" NOT NULL DEFAULT 'available',
    "vlan" INTEGER,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "discoveredBy" TEXT,
    "fortigateDevice" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subnets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" TEXT NOT NULL,
    "subnetId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "hostname" TEXT,
    "owner" TEXT NOT NULL,
    "projectRef" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "notes" TEXT,
    "status" "ReservationStatus" NOT NULL DEFAULT 'active',
    "createdBy" TEXT,
    "conflictMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "pollInterval" INTEGER NOT NULL DEFAULT 4,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL DEFAULT 'info',
    "action" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "resourceName" TEXT,
    "actor" TEXT,
    "message" TEXT NOT NULL,
    "details" JSONB,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "ipAddress" TEXT,
    "macAddress" TEXT,
    "macAddresses" JSONB DEFAULT '[]',
    "hostname" TEXT,
    "dnsName" TEXT,
    "assetTag" TEXT,
    "serialNumber" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "assetType" "AssetType" NOT NULL DEFAULT 'other',
    "status" "AssetStatus" NOT NULL DEFAULT 'active',
    "location" TEXT,
    "learnedLocation" TEXT,
    "department" TEXT,
    "assignedTo" TEXT,
    "os" TEXT,
    "osVersion" TEXT,
    "lastSeenSwitch" TEXT,
    "lastSeenAp" TEXT,
    "associatedUsers" JSONB DEFAULT '[]',
    "acquiredAt" TIMESTAMP(3),
    "warrantyExpiry" TIMESTAMP(3),
    "purchaseOrder" TEXT,
    "notes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'readonly',
    "auth_provider" TEXT NOT NULL DEFAULT 'local',
    "azure_oid" TEXT,
    "display_name" TEXT,
    "email" TEXT,
    "last_login" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'General',
    "color" TEXT NOT NULL DEFAULT '#4fc3f7',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ip_blocks_cidr_key" ON "ip_blocks"("cidr");

-- CreateIndex
CREATE INDEX "ip_blocks_ipVersion_idx" ON "ip_blocks"("ipVersion");

-- CreateIndex
CREATE INDEX "subnets_blockId_idx" ON "subnets"("blockId");

-- CreateIndex
CREATE INDEX "subnets_blockId_status_idx" ON "subnets"("blockId", "status");

-- CreateIndex
CREATE INDEX "subnets_cidr_idx" ON "subnets"("cidr");

-- CreateIndex
CREATE INDEX "subnets_status_idx" ON "subnets"("status");

-- CreateIndex
CREATE INDEX "subnets_discoveredBy_idx" ON "subnets"("discoveredBy");

-- CreateIndex
CREATE INDEX "reservations_subnetId_idx" ON "reservations"("subnetId");

-- CreateIndex
CREATE INDEX "reservations_subnetId_status_idx" ON "reservations"("subnetId", "status");

-- CreateIndex
CREATE INDEX "reservations_owner_idx" ON "reservations"("owner");

-- CreateIndex
CREATE INDEX "reservations_projectRef_idx" ON "reservations"("projectRef");

-- CreateIndex
CREATE INDEX "reservations_status_idx" ON "reservations"("status");

-- CreateIndex
CREATE INDEX "reservations_status_expiresAt_idx" ON "reservations"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "reservations_expiresAt_idx" ON "reservations"("expiresAt");

-- CreateIndex
CREATE INDEX "reservations_createdBy_idx" ON "reservations"("createdBy");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_subnetId_ipAddress_status_key" ON "reservations"("subnetId", "ipAddress", "status");

-- CreateIndex
CREATE INDEX "integrations_type_idx" ON "integrations"("type");

-- CreateIndex
CREATE INDEX "integrations_enabled_idx" ON "integrations"("enabled");

-- CreateIndex
CREATE INDEX "events_timestamp_idx" ON "events"("timestamp");

-- CreateIndex
CREATE INDEX "events_action_idx" ON "events"("action");

-- CreateIndex
CREATE INDEX "events_resourceType_idx" ON "events"("resourceType");

-- CreateIndex
CREATE INDEX "events_level_idx" ON "events"("level");

-- CreateIndex
CREATE UNIQUE INDEX "assets_assetTag_key" ON "assets"("assetTag");

-- CreateIndex
CREATE INDEX "assets_ipAddress_idx" ON "assets"("ipAddress");

-- CreateIndex
CREATE INDEX "assets_macAddress_idx" ON "assets"("macAddress");

-- CreateIndex
CREATE INDEX "assets_hostname_idx" ON "assets"("hostname");

-- CreateIndex
CREATE INDEX "assets_assetType_idx" ON "assets"("assetType");

-- CreateIndex
CREATE INDEX "assets_status_idx" ON "assets"("status");

-- CreateIndex
CREATE INDEX "assets_department_idx" ON "assets"("department");

-- CreateIndex
CREATE INDEX "assets_serialNumber_idx" ON "assets"("serialNumber");

-- CreateIndex
CREATE INDEX "assets_dnsName_idx" ON "assets"("dnsName");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_azure_oid_key" ON "users"("azure_oid");

-- CreateIndex
CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name");

-- CreateIndex
CREATE INDEX "tags_category_idx" ON "tags"("category");

-- AddForeignKey
ALTER TABLE "subnets" ADD CONSTRAINT "subnets_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "ip_blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subnets" ADD CONSTRAINT "subnets_discoveredBy_fkey" FOREIGN KEY ("discoveredBy") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_subnetId_fkey" FOREIGN KEY ("subnetId") REFERENCES "subnets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

