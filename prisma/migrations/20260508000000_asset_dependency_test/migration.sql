-- AlterTable: admin-only Dependency Test simulation columns on Asset.
-- When dependencyTestUntil is in the future, the reconciler treats the
-- asset as confirmed-down for the purposes of children's suppression
-- evaluation. Real probes keep running. Auto-clears at the timestamp.
ALTER TABLE "assets" ADD COLUMN "dependencyTestUntil" TIMESTAMP(3);
ALTER TABLE "assets" ADD COLUMN "dependencyTestStartedBy" TEXT;

-- Reconciler scans for expired rows on every tick — partial index keeps
-- the sweep cheap on fleets where the test is rarely active.
CREATE INDEX "assets_dependencyTestUntil_idx" ON "assets"("dependencyTestUntil")
  WHERE "dependencyTestUntil" IS NOT NULL;
