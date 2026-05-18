-- Queued DHCP reservation push. New columns on `reservations` track when a row
-- entered the "pending" state (transient device-side failure at create or
-- retry time — Polaris row persists, retry job keeps trying), how many push
-- attempts have been made, and when the last one fired (drives exponential
-- backoff for unmonitored FortiGates).
--
-- pushStatus values after this migration:
--   "synced"           — verified on device after a push
--   "drift"            — was synced, missing on rediscovery (operator deleted on device)
--   "pending"          — queued; awaiting an FMG/FortiGate that's reachable. sourceType
--                        stays "manual" until the push lands.
--   "failed_permanent" — terminal: 4xx, verify mismatch, or lost an IP-collision
--                        race against discovery. Operator must release or
--                        retry-now after fixing the cause.
--
-- Existing rows have pushStatus IN (NULL, 'synced', 'drift') and are unaffected.
-- No backfill required.

ALTER TABLE "reservations"
    ADD COLUMN "pushQueuedAt"      TIMESTAMP(3),
    ADD COLUMN "pushAttempts"      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "pushLastAttemptAt" TIMESTAMP(3);

-- Primary scan filter for the retry tick: WHERE pushStatus = 'pending' ORDER BY pushQueuedAt ASC.
CREATE INDEX "reservations_pushStatus_pushQueuedAt_idx"
    ON "reservations"("pushStatus", "pushQueuedAt");
