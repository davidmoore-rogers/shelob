-- Tracks the last time Asset.monitorStatus transitioned to a new value.
-- Drives the "how long has this asset been warning/down" duration on the
-- Dashboard's Monitor Alerts card. Null until the first transition; the
-- backfillMonitorStatusChangedAt startup job seeds existing warning/down
-- assets from the latest monitor.status_changed Event when possible.
ALTER TABLE "assets" ADD COLUMN "monitorStatusChangedAt" TIMESTAMP(3);
