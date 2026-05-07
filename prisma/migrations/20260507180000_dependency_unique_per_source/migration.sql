-- Allow a (child, parent) pair to exist in BOTH "computed" and "override"
-- form simultaneously — the read-time resolver in dependencyTreeService
-- groups by source and applies override-wins. Including source in the
-- unique key keeps the recompute job's source="computed" rows untouched
-- when an operator pins the same parent via the override endpoint.
DROP INDEX "asset_dependency_parents_assetId_parentAssetId_key";
CREATE UNIQUE INDEX "asset_dependency_parents_assetId_parentAssetId_source_key" ON "asset_dependency_parents"("assetId", "parentAssetId", "source");
