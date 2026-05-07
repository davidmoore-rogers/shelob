-- AlterTable: add dependency-aware monitoring columns to assets
ALTER TABLE "assets" ADD COLUMN "dependencyLayer" INTEGER;
ALTER TABLE "assets" ADD COLUMN "dependencySuppressed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "assets" ADD COLUMN "dependencySuppressedAt" TIMESTAMP(3);

-- CreateIndex: speeds up the reconciler's "find suppressed rows" sweep
CREATE INDEX "assets_dependencySuppressed_idx" ON "assets"("dependencySuppressed");

-- CreateTable: persistent parent→child edges of the Fortinet infra dependency DAG
CREATE TABLE "asset_dependency_parents" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "parentAssetId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "detectedVia" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_dependency_parents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: dedupe key — one row per (child, parent) pair
CREATE UNIQUE INDEX "asset_dependency_parents_assetId_parentAssetId_key" ON "asset_dependency_parents"("assetId", "parentAssetId");

-- CreateIndex: child lookup (reconciler's per-asset effective-parents fetch)
CREATE INDEX "asset_dependency_parents_assetId_idx" ON "asset_dependency_parents"("assetId");

-- CreateIndex: parent lookup (propagateAfterStatusChange's descendants BFS)
CREATE INDEX "asset_dependency_parents_parentAssetId_idx" ON "asset_dependency_parents"("parentAssetId");

-- CreateIndex: source filter (recompute deletes only computed rows; overrides survive)
CREATE INDEX "asset_dependency_parents_source_idx" ON "asset_dependency_parents"("source");

-- AddForeignKey: child side — cascade delete with the asset
ALTER TABLE "asset_dependency_parents" ADD CONSTRAINT "asset_dependency_parents_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: parent side — cascade delete (an asset deletion drops every "X is the parent of Y" row pointing at it)
ALTER TABLE "asset_dependency_parents" ADD CONSTRAINT "asset_dependency_parents_parentAssetId_fkey" FOREIGN KEY ("parentAssetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
