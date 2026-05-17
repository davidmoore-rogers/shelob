-- Phase 1 of tiered sample retention: schema only, no behavior change.
--
-- Adds 12 rollup tables (hourly + daily aggregates for each of the six
-- monitor sample tables) plus 9 new retention columns on monitor_class_overrides
-- (detail / hourly / daily × sample / telemetry / systemInfo).
--
-- The new tables are inert until phase 2 lands the sampleRollup job that
-- writes to them and phase 4 lands the query-tier router that reads from
-- them. The 3 legacy retention columns on monitor_class_overrides
-- (sampleRetentionDays / telemetryRetentionDays / systemInfoRetentionDays)
-- are intentionally retained alongside the new tiered columns; the
-- migrateRetentionTiers startup job seeds *DetailRetentionDays from the
-- legacy value on first boot. Legacy columns drop in a follow-up release
-- once fleet-wide migration is confirmed.
--
-- Aggregate column conventions:
--   - Gauge sources (monitor RTT, CPU/memory, temperature, storage):
--     sampleCount + avg/min/max
--   - Counter sources (interface octets/errors, ipsec bytes):
--     first/last per bucket + lastBucketSampleAt; rate derived at query
--     time as (last - first) / (lastBucketSampleAt - bucketStart in seconds)
--     with negative deltas treated as counter resets.
--   - IPsec also stores per-status sample counts (up/down/partial/dynamic)
--     so the query layer can distinguish flapping from steady-state.


-- AlterTable
ALTER TABLE "monitor_class_overrides" ADD COLUMN     "sampleDailyRetentionDays" INTEGER,
ADD COLUMN     "sampleDetailRetentionDays" INTEGER,
ADD COLUMN     "sampleHourlyRetentionDays" INTEGER,
ADD COLUMN     "systemInfoDailyRetentionDays" INTEGER,
ADD COLUMN     "systemInfoDetailRetentionDays" INTEGER,
ADD COLUMN     "systemInfoHourlyRetentionDays" INTEGER,
ADD COLUMN     "telemetryDailyRetentionDays" INTEGER,
ADD COLUMN     "telemetryDetailRetentionDays" INTEGER,
ADD COLUMN     "telemetryHourlyRetentionDays" INTEGER;

-- CreateTable
CREATE TABLE "asset_monitor_samples_hourly" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "successCount" INTEGER NOT NULL,
    "failureCount" INTEGER NOT NULL,
    "avgResponseTimeMs" DOUBLE PRECISION,
    "minResponseTimeMs" INTEGER,
    "maxResponseTimeMs" INTEGER,

    CONSTRAINT "asset_monitor_samples_hourly_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateTable
CREATE TABLE "asset_monitor_samples_daily" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "successCount" INTEGER NOT NULL,
    "failureCount" INTEGER NOT NULL,
    "avgResponseTimeMs" DOUBLE PRECISION,
    "minResponseTimeMs" INTEGER,
    "maxResponseTimeMs" INTEGER,

    CONSTRAINT "asset_monitor_samples_daily_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateTable
CREATE TABLE "asset_telemetry_samples_hourly" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "avgCpuPct" DOUBLE PRECISION,
    "minCpuPct" DOUBLE PRECISION,
    "maxCpuPct" DOUBLE PRECISION,
    "avgMemPct" DOUBLE PRECISION,
    "minMemPct" DOUBLE PRECISION,
    "maxMemPct" DOUBLE PRECISION,
    "avgMemUsedBytes" BIGINT,
    "maxMemUsedBytes" BIGINT,
    "lastMemTotalBytes" BIGINT,

    CONSTRAINT "asset_telemetry_samples_hourly_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateTable
CREATE TABLE "asset_telemetry_samples_daily" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "avgCpuPct" DOUBLE PRECISION,
    "minCpuPct" DOUBLE PRECISION,
    "maxCpuPct" DOUBLE PRECISION,
    "avgMemPct" DOUBLE PRECISION,
    "minMemPct" DOUBLE PRECISION,
    "maxMemPct" DOUBLE PRECISION,
    "avgMemUsedBytes" BIGINT,
    "maxMemUsedBytes" BIGINT,
    "lastMemTotalBytes" BIGINT,

    CONSTRAINT "asset_telemetry_samples_daily_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateTable
CREATE TABLE "asset_temperature_samples_hourly" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "sensorName" TEXT NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "avgCelsius" DOUBLE PRECISION,
    "minCelsius" DOUBLE PRECISION,
    "maxCelsius" DOUBLE PRECISION,

    CONSTRAINT "asset_temperature_samples_hourly_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateTable
CREATE TABLE "asset_temperature_samples_daily" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "sensorName" TEXT NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "avgCelsius" DOUBLE PRECISION,
    "minCelsius" DOUBLE PRECISION,
    "maxCelsius" DOUBLE PRECISION,

    CONSTRAINT "asset_temperature_samples_daily_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateTable
CREATE TABLE "asset_interface_samples_hourly" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "ifName" TEXT NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "firstInOctets" BIGINT,
    "lastInOctets" BIGINT,
    "firstOutOctets" BIGINT,
    "lastOutOctets" BIGINT,
    "firstInErrors" BIGINT,
    "lastInErrors" BIGINT,
    "firstOutErrors" BIGINT,
    "lastOutErrors" BIGINT,
    "maxSpeedBps" BIGINT,
    "lastAdminStatus" TEXT,
    "lastOperStatus" TEXT,
    "lastIpAddress" TEXT,
    "lastMacAddress" TEXT,
    "lastAlias" TEXT,
    "lastDescription" TEXT,
    "lastIfType" TEXT,
    "lastIfParent" TEXT,
    "lastVlanId" INTEGER,
    "lastBucketSampleAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_interface_samples_hourly_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateTable
CREATE TABLE "asset_interface_samples_daily" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "ifName" TEXT NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "firstInOctets" BIGINT,
    "lastInOctets" BIGINT,
    "firstOutOctets" BIGINT,
    "lastOutOctets" BIGINT,
    "firstInErrors" BIGINT,
    "lastInErrors" BIGINT,
    "firstOutErrors" BIGINT,
    "lastOutErrors" BIGINT,
    "maxSpeedBps" BIGINT,
    "lastAdminStatus" TEXT,
    "lastOperStatus" TEXT,
    "lastIpAddress" TEXT,
    "lastMacAddress" TEXT,
    "lastAlias" TEXT,
    "lastDescription" TEXT,
    "lastIfType" TEXT,
    "lastIfParent" TEXT,
    "lastVlanId" INTEGER,
    "lastBucketSampleAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_interface_samples_daily_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateTable
CREATE TABLE "asset_storage_samples_hourly" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "mountPath" TEXT NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "avgUsedBytes" BIGINT,
    "minUsedBytes" BIGINT,
    "maxUsedBytes" BIGINT,
    "lastTotalBytes" BIGINT,

    CONSTRAINT "asset_storage_samples_hourly_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateTable
CREATE TABLE "asset_storage_samples_daily" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "mountPath" TEXT NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "avgUsedBytes" BIGINT,
    "minUsedBytes" BIGINT,
    "maxUsedBytes" BIGINT,
    "lastTotalBytes" BIGINT,

    CONSTRAINT "asset_storage_samples_daily_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateTable
CREATE TABLE "asset_ipsec_tunnel_samples_hourly" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "tunnelName" TEXT NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "statusUpCount" INTEGER NOT NULL DEFAULT 0,
    "statusDownCount" INTEGER NOT NULL DEFAULT 0,
    "statusPartialCount" INTEGER NOT NULL DEFAULT 0,
    "statusDynamicCount" INTEGER NOT NULL DEFAULT 0,
    "firstIncomingBytes" BIGINT,
    "lastIncomingBytes" BIGINT,
    "firstOutgoingBytes" BIGINT,
    "lastOutgoingBytes" BIGINT,
    "lastRemoteGateway" TEXT,
    "lastParentInterface" TEXT,
    "lastProxyIdCount" INTEGER,
    "lastBucketSampleAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_ipsec_tunnel_samples_hourly_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateTable
CREATE TABLE "asset_ipsec_tunnel_samples_daily" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "tunnelName" TEXT NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "statusUpCount" INTEGER NOT NULL DEFAULT 0,
    "statusDownCount" INTEGER NOT NULL DEFAULT 0,
    "statusPartialCount" INTEGER NOT NULL DEFAULT 0,
    "statusDynamicCount" INTEGER NOT NULL DEFAULT 0,
    "firstIncomingBytes" BIGINT,
    "lastIncomingBytes" BIGINT,
    "firstOutgoingBytes" BIGINT,
    "lastOutgoingBytes" BIGINT,
    "lastRemoteGateway" TEXT,
    "lastParentInterface" TEXT,
    "lastProxyIdCount" INTEGER,
    "lastBucketSampleAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_ipsec_tunnel_samples_daily_pkey" PRIMARY KEY ("id","bucketStart")
);

-- CreateIndex
CREATE INDEX "asset_monitor_samples_hourly_assetId_bucketStart_idx" ON "asset_monitor_samples_hourly"("assetId", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "asset_monitor_samples_hourly_bucketStart_assetId_key" ON "asset_monitor_samples_hourly"("bucketStart", "assetId");

-- CreateIndex
CREATE INDEX "asset_monitor_samples_daily_assetId_bucketStart_idx" ON "asset_monitor_samples_daily"("assetId", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "asset_monitor_samples_daily_bucketStart_assetId_key" ON "asset_monitor_samples_daily"("bucketStart", "assetId");

-- CreateIndex
CREATE INDEX "asset_telemetry_samples_hourly_assetId_bucketStart_idx" ON "asset_telemetry_samples_hourly"("assetId", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "asset_telemetry_samples_hourly_bucketStart_assetId_key" ON "asset_telemetry_samples_hourly"("bucketStart", "assetId");

-- CreateIndex
CREATE INDEX "asset_telemetry_samples_daily_assetId_bucketStart_idx" ON "asset_telemetry_samples_daily"("assetId", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "asset_telemetry_samples_daily_bucketStart_assetId_key" ON "asset_telemetry_samples_daily"("bucketStart", "assetId");

-- CreateIndex
CREATE INDEX "asset_temperature_samples_hourly_assetId_bucketStart_idx" ON "asset_temperature_samples_hourly"("assetId", "bucketStart");

-- CreateIndex
CREATE INDEX "asset_temperature_samples_hourly_assetId_sensorName_bucketS_idx" ON "asset_temperature_samples_hourly"("assetId", "sensorName", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "asset_temperature_samples_hourly_bucketStart_assetId_sensor_key" ON "asset_temperature_samples_hourly"("bucketStart", "assetId", "sensorName");

-- CreateIndex
CREATE INDEX "asset_temperature_samples_daily_assetId_bucketStart_idx" ON "asset_temperature_samples_daily"("assetId", "bucketStart");

-- CreateIndex
CREATE INDEX "asset_temperature_samples_daily_assetId_sensorName_bucketSt_idx" ON "asset_temperature_samples_daily"("assetId", "sensorName", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "asset_temperature_samples_daily_bucketStart_assetId_sensorN_key" ON "asset_temperature_samples_daily"("bucketStart", "assetId", "sensorName");

-- CreateIndex
CREATE INDEX "asset_interface_samples_hourly_assetId_bucketStart_idx" ON "asset_interface_samples_hourly"("assetId", "bucketStart");

-- CreateIndex
CREATE INDEX "asset_interface_samples_hourly_assetId_ifName_bucketStart_idx" ON "asset_interface_samples_hourly"("assetId", "ifName", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "asset_interface_samples_hourly_bucketStart_assetId_ifName_key" ON "asset_interface_samples_hourly"("bucketStart", "assetId", "ifName");

-- CreateIndex
CREATE INDEX "asset_interface_samples_daily_assetId_bucketStart_idx" ON "asset_interface_samples_daily"("assetId", "bucketStart");

-- CreateIndex
CREATE INDEX "asset_interface_samples_daily_assetId_ifName_bucketStart_idx" ON "asset_interface_samples_daily"("assetId", "ifName", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "asset_interface_samples_daily_bucketStart_assetId_ifName_key" ON "asset_interface_samples_daily"("bucketStart", "assetId", "ifName");

-- CreateIndex
CREATE INDEX "asset_storage_samples_hourly_assetId_bucketStart_idx" ON "asset_storage_samples_hourly"("assetId", "bucketStart");

-- CreateIndex
CREATE INDEX "asset_storage_samples_hourly_assetId_mountPath_bucketStart_idx" ON "asset_storage_samples_hourly"("assetId", "mountPath", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "asset_storage_samples_hourly_bucketStart_assetId_mountPath_key" ON "asset_storage_samples_hourly"("bucketStart", "assetId", "mountPath");

-- CreateIndex
CREATE INDEX "asset_storage_samples_daily_assetId_bucketStart_idx" ON "asset_storage_samples_daily"("assetId", "bucketStart");

-- CreateIndex
CREATE INDEX "asset_storage_samples_daily_assetId_mountPath_bucketStart_idx" ON "asset_storage_samples_daily"("assetId", "mountPath", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "asset_storage_samples_daily_bucketStart_assetId_mountPath_key" ON "asset_storage_samples_daily"("bucketStart", "assetId", "mountPath");

-- CreateIndex
CREATE INDEX "asset_ipsec_tunnel_samples_hourly_assetId_bucketStart_idx" ON "asset_ipsec_tunnel_samples_hourly"("assetId", "bucketStart");

-- CreateIndex
CREATE INDEX "asset_ipsec_tunnel_samples_hourly_assetId_tunnelName_bucket_idx" ON "asset_ipsec_tunnel_samples_hourly"("assetId", "tunnelName", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "asset_ipsec_tunnel_samples_hourly_bucketStart_assetId_tunne_key" ON "asset_ipsec_tunnel_samples_hourly"("bucketStart", "assetId", "tunnelName");

-- CreateIndex
CREATE INDEX "asset_ipsec_tunnel_samples_daily_assetId_bucketStart_idx" ON "asset_ipsec_tunnel_samples_daily"("assetId", "bucketStart");

-- CreateIndex
CREATE INDEX "asset_ipsec_tunnel_samples_daily_assetId_tunnelName_bucketS_idx" ON "asset_ipsec_tunnel_samples_daily"("assetId", "tunnelName", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "asset_ipsec_tunnel_samples_daily_bucketStart_assetId_tunnel_key" ON "asset_ipsec_tunnel_samples_daily"("bucketStart", "assetId", "tunnelName");

-- AddForeignKey
ALTER TABLE "asset_monitor_samples_hourly" ADD CONSTRAINT "asset_monitor_samples_hourly_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_monitor_samples_daily" ADD CONSTRAINT "asset_monitor_samples_daily_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_telemetry_samples_hourly" ADD CONSTRAINT "asset_telemetry_samples_hourly_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_telemetry_samples_daily" ADD CONSTRAINT "asset_telemetry_samples_daily_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_temperature_samples_hourly" ADD CONSTRAINT "asset_temperature_samples_hourly_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_temperature_samples_daily" ADD CONSTRAINT "asset_temperature_samples_daily_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_interface_samples_hourly" ADD CONSTRAINT "asset_interface_samples_hourly_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_interface_samples_daily" ADD CONSTRAINT "asset_interface_samples_daily_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_storage_samples_hourly" ADD CONSTRAINT "asset_storage_samples_hourly_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_storage_samples_daily" ADD CONSTRAINT "asset_storage_samples_daily_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_ipsec_tunnel_samples_hourly" ADD CONSTRAINT "asset_ipsec_tunnel_samples_hourly_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_ipsec_tunnel_samples_daily" ADD CONSTRAINT "asset_ipsec_tunnel_samples_daily_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

