-- Convert the six monitoring sample tables from single-column PK (id) to
-- composite PK (id, timestamp). Required by TimescaleDB hypertables, which
-- mandate that the partitioning column be part of every UNIQUE/PRIMARY KEY
-- constraint. Composite PK is functionally equivalent on plain Postgres —
-- queries don't change because the codebase never uses findUnique by id
-- alone on these tables.

ALTER TABLE "asset_monitor_samples" DROP CONSTRAINT "asset_monitor_samples_pkey";
ALTER TABLE "asset_monitor_samples" ADD CONSTRAINT "asset_monitor_samples_pkey" PRIMARY KEY ("id", "timestamp");

ALTER TABLE "asset_telemetry_samples" DROP CONSTRAINT "asset_telemetry_samples_pkey";
ALTER TABLE "asset_telemetry_samples" ADD CONSTRAINT "asset_telemetry_samples_pkey" PRIMARY KEY ("id", "timestamp");

ALTER TABLE "asset_temperature_samples" DROP CONSTRAINT "asset_temperature_samples_pkey";
ALTER TABLE "asset_temperature_samples" ADD CONSTRAINT "asset_temperature_samples_pkey" PRIMARY KEY ("id", "timestamp");

ALTER TABLE "asset_interface_samples" DROP CONSTRAINT "asset_interface_samples_pkey";
ALTER TABLE "asset_interface_samples" ADD CONSTRAINT "asset_interface_samples_pkey" PRIMARY KEY ("id", "timestamp");

ALTER TABLE "asset_storage_samples" DROP CONSTRAINT "asset_storage_samples_pkey";
ALTER TABLE "asset_storage_samples" ADD CONSTRAINT "asset_storage_samples_pkey" PRIMARY KEY ("id", "timestamp");

ALTER TABLE "asset_ipsec_tunnel_samples" DROP CONSTRAINT "asset_ipsec_tunnel_samples_pkey";
ALTER TABLE "asset_ipsec_tunnel_samples" ADD CONSTRAINT "asset_ipsec_tunnel_samples_pkey" PRIMARY KEY ("id", "timestamp");
