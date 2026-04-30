-- Stale-reservation detection. lastSeenLeased is updated by the DHCP sync
-- whenever /api/v2/monitor/system/dhcp confirms a reservation's IP is being
-- actively held by a client. staleNotifiedAt records the last time the
-- nightly flagStaleReservations job emitted a `reservation.stale` Event for
-- this row, so the alert doesn't refire daily once the threshold is crossed.

ALTER TABLE "reservations"
    ADD COLUMN "lastSeenLeased"  TIMESTAMP(3),
    ADD COLUMN "staleNotifiedAt" TIMESTAMP(3);
