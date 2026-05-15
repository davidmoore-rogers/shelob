-- New sourceType for auto-created reservations representing assets whose IPs
-- fall inside a known subnet but aren't covered by any DHCP / VIP / manual
-- entry. Written by dnsResolvedReservationService on asset write and by the
-- periodic reconcileDnsResolvedReservations job.
--
-- ADD VALUE IF NOT EXISTS so the migration is idempotent: if the type was
-- altered manually by a superuser (recovery path when the app DB role lost
-- ownership of the type), re-running this migration is a clean no-op rather
-- than a duplicate-value error.

ALTER TYPE "ReservationSourceType" ADD VALUE IF NOT EXISTS 'dns_resolved';
