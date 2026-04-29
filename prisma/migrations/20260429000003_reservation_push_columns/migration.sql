-- DHCP reservation push to FortiGate. New columns on `reservations` track the
-- MAC sent to the device, which integration pushed the reservation, and the
-- (scope, entry) pair that pins the row on the FortiGate so unpush hits the
-- exact entry without re-resolving by IP.
--
-- pushStatus values currently in use:
--   "synced" — verified on device after a push
--   "drift"  — was synced, missing on rediscovery (operator deleted on device)
-- A push failure during reservation create aborts the create entirely, so no
-- "failed" row is persisted from that path.

ALTER TABLE "reservations"
    ADD COLUMN "macAddress"    TEXT,
    ADD COLUMN "pushedToId"    TEXT,
    ADD COLUMN "pushedScopeId" INTEGER,
    ADD COLUMN "pushedEntryId" INTEGER,
    ADD COLUMN "pushStatus"    TEXT,
    ADD COLUMN "pushedAt"      TIMESTAMP(3),
    ADD COLUMN "pushError"     TEXT;

CREATE INDEX "reservations_pushedToId_idx" ON "reservations"("pushedToId");

ALTER TABLE "reservations"
    ADD CONSTRAINT "reservations_pushedToId_fkey"
    FOREIGN KEY ("pushedToId") REFERENCES "integrations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
