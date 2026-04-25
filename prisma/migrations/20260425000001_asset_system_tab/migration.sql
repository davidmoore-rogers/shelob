-- System tab: time-series tables for CPU/memory telemetry, per-interface
-- counters, and per-mountpoint storage. Cadence + retention are configured
-- on the existing `monitorSettings` Setting row; per-asset overrides live on
-- new columns of `assets`.
-- See src/services/monitoringService.ts (collectTelemetry / collectSystemInfo)
-- and src/jobs/monitorAssets.ts.

-- ─── New tables ────────────────────────────────────────────────────────────

CREATE TABLE "asset_telemetry_samples" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpuPct" DOUBLE PRECISION,
    -- memPct is set when the source reports memory only as a percentage
    -- (FortiOS); memUsedBytes/memTotalBytes are set when the source reports
    -- absolute bytes (SNMP, WMI). Either pair may be present.
    "memPct" DOUBLE PRECISION,
    "memUsedBytes" BIGINT,
    "memTotalBytes" BIGINT,

    CONSTRAINT "asset_telemetry_samples_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "asset_telemetry_samples_assetId_timestamp_idx"
    ON "asset_telemetry_samples"("assetId", "timestamp");

CREATE TABLE "asset_interface_samples" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ifName" TEXT NOT NULL,
    "adminStatus" TEXT,
    "operStatus" TEXT,
    "speedBps" BIGINT,
    "ipAddress" TEXT,
    "macAddress" TEXT,
    "inOctets" BIGINT,
    "outOctets" BIGINT,

    CONSTRAINT "asset_interface_samples_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "asset_interface_samples_assetId_timestamp_idx"
    ON "asset_interface_samples"("assetId", "timestamp");
CREATE INDEX "asset_interface_samples_assetId_ifName_timestamp_idx"
    ON "asset_interface_samples"("assetId", "ifName", "timestamp");

CREATE TABLE "asset_storage_samples" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mountPath" TEXT NOT NULL,
    "totalBytes" BIGINT,
    "usedBytes" BIGINT,

    CONSTRAINT "asset_storage_samples_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "asset_storage_samples_assetId_timestamp_idx"
    ON "asset_storage_samples"("assetId", "timestamp");
CREATE INDEX "asset_storage_samples_assetId_mountPath_timestamp_idx"
    ON "asset_storage_samples"("assetId", "mountPath", "timestamp");

-- ─── Asset columns ─────────────────────────────────────────────────────────

ALTER TABLE "assets"
    ADD COLUMN "telemetryIntervalSec"  INTEGER,
    ADD COLUMN "systemInfoIntervalSec" INTEGER,
    ADD COLUMN "lastTelemetryAt"       TIMESTAMP(3),
    ADD COLUMN "lastSystemInfoAt"      TIMESTAMP(3);

-- ─── Foreign keys ──────────────────────────────────────────────────────────

ALTER TABLE "asset_telemetry_samples"
    ADD CONSTRAINT "asset_telemetry_samples_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "asset_interface_samples"
    ADD CONSTRAINT "asset_interface_samples_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "asset_storage_samples"
    ADD CONSTRAINT "asset_storage_samples_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
