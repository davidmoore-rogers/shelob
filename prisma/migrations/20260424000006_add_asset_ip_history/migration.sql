-- CreateTable
CREATE TABLE "asset_ip_history" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_ip_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "asset_ip_history_assetId_ip_key" ON "asset_ip_history"("assetId", "ip");

-- CreateIndex
CREATE INDEX "asset_ip_history_assetId_idx" ON "asset_ip_history"("assetId");

-- AddForeignKey
ALTER TABLE "asset_ip_history" ADD CONSTRAINT "asset_ip_history_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
