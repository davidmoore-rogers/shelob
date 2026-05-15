-- New sourceType for auto-created reservations representing assets whose IPs
-- fall inside a known subnet but aren't covered by any DHCP / VIP / manual
-- entry. Written by dnsResolvedReservationService on asset write and by the
-- periodic reconcileDnsResolvedReservations job.

ALTER TYPE "ReservationSourceType" ADD VALUE 'dns_resolved';
