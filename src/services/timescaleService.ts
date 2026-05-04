/**
 * src/services/timescaleService.ts
 *
 * TimescaleDB detection and hypertable utilities. Polaris's monitoring
 * sample tables (asset_monitor_samples, asset_telemetry_samples,
 * asset_temperature_samples, asset_interface_samples, asset_storage_samples,
 * asset_ipsec_tunnel_samples) work as plain Postgres tables OR as Timescale
 * hypertables; the prune layer dispatches on hypertable status so the same
 * code path works in both modes.
 *
 * Detection runs once at startup via `detectTimescale()` and caches the
 * result + per-table hypertable status. Subsequent calls return the cached
 * value. Re-detection happens automatically after the boot-time conversion
 * pass (Step 3b) so downstream `isHypertable()` checks reflect the
 * post-conversion state.
 *
 * Detection failures are non-fatal — the cache stays at "extension not
 * available" and the prune layer falls through to the deleteMany path.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

/** Sample tables we project / prune / hypertable. Exported so callers stay in sync. */
export const SAMPLE_TABLES = [
  "asset_monitor_samples",
  "asset_telemetry_samples",
  "asset_temperature_samples",
  "asset_interface_samples",
  "asset_storage_samples",
  "asset_ipsec_tunnel_samples",
] as const;

export type SampleTableName = typeof SAMPLE_TABLES[number];

interface DetectionState {
  extensionInstalled: boolean;
  hypertables: Set<string>;
  detectedAt: number;
}

let state: DetectionState = {
  extensionInstalled: false,
  hypertables: new Set(),
  detectedAt: 0,
};

/**
 * Probe Postgres for the timescaledb extension and the hypertable status of
 * every sample table. Caches the result. Idempotent — call as many times as
 * you like; the cache only updates when the probe succeeds.
 */
export async function detectTimescale(): Promise<DetectionState> {
  try {
    const ext = await prisma.$queryRawUnsafe<{ extname: string }[]>(
      `SELECT extname FROM pg_extension WHERE extname = 'timescaledb'`,
    );
    const installed = ext.length > 0;
    const hypertables = new Set<string>();
    if (installed) {
      // Hypertable inventory. `timescaledb_information.hypertables` only lists
      // tables that are currently hypertables — anything missing is plain
      // Postgres. Filter to our sample tables so we ignore unrelated user
      // hypertables (none in Polaris today, but safe to scope).
      try {
        const rows = await prisma.$queryRawUnsafe<{ hypertable_name: string }[]>(
          `SELECT hypertable_name FROM timescaledb_information.hypertables`,
        );
        for (const r of rows) {
          if ((SAMPLE_TABLES as readonly string[]).includes(r.hypertable_name)) {
            hypertables.add(r.hypertable_name);
          }
        }
      } catch (err) {
        // Schema didn't exist yet (extension just installed but information
        // schema not visible to this role). Still set installed=true so the
        // operator-facing alert dismisses; hypertable conversion will fix it
        // on next boot once the schema is reachable.
        logger.debug({ err }, "timescaledb_information schema unreadable; treating sample tables as plain");
      }
    }
    state = { extensionInstalled: installed, hypertables, detectedAt: Date.now() };
    logger.info(
      { installed, hypertables: [...hypertables] },
      "TimescaleDB detection complete",
    );
  } catch (err) {
    logger.warn({ err }, "TimescaleDB detection failed; treating as not available");
    state = { extensionInstalled: false, hypertables: new Set(), detectedAt: Date.now() };
  }
  return state;
}

export function isTimescaleAvailable(): boolean {
  return state.extensionInstalled;
}

export function isHypertable(tableName: string): boolean {
  return state.hypertables.has(tableName);
}

export function getDetectionState(): DetectionState {
  return state;
}

/**
 * Drop chunks older than the supplied cutoff from a hypertable. No-op when
 * the table is not a hypertable; cheap to call unconditionally.
 *
 * `drop_chunks` is chunk-granular — it can only drop a chunk when ALL rows
 * in the chunk are older than the cutoff. That makes it a fast pre-filter
 * before the per-class deleteMany pass: chunks beyond the longest retention
 * disappear in O(1) without a seq-scan, then deleteMany handles the residue
 * inside the retention window.
 */
export async function dropChunks(tableName: string, olderThan: Date): Promise<void> {
  if (!isHypertable(tableName)) return;
  try {
    await prisma.$executeRawUnsafe(
      `SELECT drop_chunks($1::regclass, $2::timestamptz)`,
      tableName,
      olderThan.toISOString(),
    );
  } catch (err) {
    logger.warn({ err, table: tableName }, "drop_chunks failed; falling back to deleteMany");
  }
}
