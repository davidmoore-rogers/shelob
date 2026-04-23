-- Extend Conflict to cover asset hostname collisions from Entra ID discovery.
-- Reservation conflicts remain the primary use case; asset conflicts are a new
-- variant distinguished by entityType.

-- 1. Drop existing FK so we can alter reservationId to be nullable
ALTER TABLE "conflicts" DROP CONSTRAINT "conflicts_reservationId_fkey";

-- 2. Relax reservationId, add asset-conflict columns
ALTER TABLE "conflicts"
    ADD COLUMN "entityType" TEXT NOT NULL DEFAULT 'reservation',
    ADD COLUMN "assetId" TEXT,
    ADD COLUMN "proposedDeviceId" TEXT,
    ADD COLUMN "proposedAssetFields" JSONB,
    ALTER COLUMN "reservationId" DROP NOT NULL,
    ALTER COLUMN "proposedSourceType" DROP NOT NULL;

-- 3. Re-add the reservation FK, now nullable
ALTER TABLE "conflicts"
    ADD CONSTRAINT "conflicts_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "reservations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Add the asset FK
ALTER TABLE "conflicts"
    ADD CONSTRAINT "conflicts_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. New indexes
CREATE INDEX "conflicts_assetId_idx" ON "conflicts"("assetId");
CREATE INDEX "conflicts_entityType_idx" ON "conflicts"("entityType");
CREATE INDEX "conflicts_proposedDeviceId_idx" ON "conflicts"("proposedDeviceId");
