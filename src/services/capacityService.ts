/**
 * src/services/capacityService.ts
 *
 * Computes a "capacity snapshot" of the host + database + monitoring workload
 * and grades it ok / watch / amber / red. Surfaced via GET
 * /api/v1/server-settings/pg-tuning and rendered on the Server Settings →
 * Maintenance tab; the global navbar banner reads severity from the same
 * payload.
 *
 * Rationale: small DBs need no tuning, but the time-series sample tables
 * (asset_monitor_samples, asset_interface_samples, etc.) grow with
 * monitoredAssets × probe-cadence × retention. Once that product blows past
 * host RAM or *any* of the volumes Polaris/Postgres write to is squeezed,
 * ops needs to know before it bites — not after.
 *
 * Volumes scanned (deduped by stat.dev so single-LV installs collapse cleanly):
 *
 *   app      — install dir (where dist/ lives)
 *   state    — POLARIS_STATE_DIR root (often the same as app)
 *   backups  — encrypted DB dump destination
 *   db       — PostgreSQL `SHOW data_directory`, only when the DB is on
 *              localhost (`appHost.dbColocated` is the hint)
 *
 * Severity tiering:
 *   red    — disk free <10% on any volume, DB > 50% of free disk on its
 *            volume, autovacuum stale >7d on a populated sample table,
 *            projected size > 8× host RAM
 *   amber  — disk 10–20% on any volume, dead-tup >20%, projected > 4× RAM,
 *            ramInsufficient, pgTuningNeeded
 *   watch  — disk 20–30% on any volume. Drives the transition Event to
 *            syslog/SFTP archival but NOT the navbar banner — gives ops a
 *            "you have weeks, not minutes" signal before amber.
 */

import { totalmem, freemem, cpus, loadavg } from "node:os";
import { statfs, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { prisma } from "../db.js";
import { getMonitorSettings, type MonitorSettings } from "./monitoringService.js";
import { isTimescaleAvailable, isHypertable, SAMPLE_TABLES as TIMESCALE_SAMPLE_TABLES } from "./timescaleService.js";
import { isPgbossInstalled, getBootTimeMode, getQueueMode } from "./queueService.js";
import { getDeploymentContext } from "../utils/deploymentContext.js";
import { BACKUP_DIR, STATE_DIR } from "../utils/paths.js";
import { logger } from "../utils/logger.js";
import { getDirectDatabaseUrl, isPgbouncerMode } from "../utils/dbConnections.js";

export type Severity = "ok" | "watch" | "amber" | "red";

// ─── Connection-pool peak tracking ───────────────────────────────────────────
//
// Tracks the highest pg_stat_activity count this process has seen across
// every capacity snapshot since boot. Module-local — resets on process
// restart, which is fine: if the pool is genuinely undersized the alert
// will resurface within one capacityWatch tick (10 min) of operator load.
let peakConnectionCount = 0;

// ─── Direct pg.Pool for pg_stat_activity reads ──────────────────────────────
//
// When PgBouncer sits in front of Postgres, the application Prisma client
// goes through it — but `pg_stat_activity` then shows the PgBouncer-side
// view of backend connections, which under-counts what Polaris actually
// holds. Open a tiny dedicated pool (max 2) against the direct URL so the
// pool-saturation gauges + the Capacity Advisor's pool sizing read the
// real cluster-side state.
//
// Lazy-init: under single-URL installs we never instantiate this and just
// route the query through `prisma` like before. Same data, no extra pool.
let directStatsPool: pg.Pool | null = null;

function getDirectStatsPool(): pg.Pool | null {
  if (!isPgbouncerMode()) return null;
  if (directStatsPool) return directStatsPool;
  const url = getDirectDatabaseUrl();
  if (!url) return null;
  directStatsPool = new pg.Pool({ connectionString: url, max: 2 });
  directStatsPool.on("error", (err) => {
    logger.warn({ err: err.message }, "capacityService: direct stats pool error");
  });
  return directStatsPool;
}

async function readPgStatActivity(): Promise<{ in_use: number; max: number }> {
  const directPool = getDirectStatsPool();
  const sql = `
    SELECT
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS in_use,
      (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max
  `;
  try {
    if (directPool) {
      const r = await directPool.query<{ in_use: number; max: number }>(sql);
      return r.rows[0] ?? { in_use: 0, max: 0 };
    }
    const r = await prisma.$queryRawUnsafe<{ in_use: number; max: number }[]>(sql);
    return r[0] ?? { in_use: 0, max: 0 };
  } catch {
    return { in_use: 0, max: 0 };
  }
}

function readEnvInt(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

export interface CapacityReason {
  severity: "watch" | "amber" | "red";
  code: string;
  message: string;
  suggestion: string;
}

export type VolumeRole = "app" | "state" | "backups" | "db";

export interface VolumeStat {
  /** All Polaris-named paths that resolve to this filesystem. */
  paths: string[];
  /** Roles this volume serves (deduped). Useful for the operator-facing label. */
  roles: VolumeRole[];
  freeBytes: number;
  totalBytes: number;
}

export interface CapacitySampleTable {
  name: string;
  rows: number;
  bytes: number;
  avgBytesPerRow: number;
  deadTupRatio: number;
  lastAutovacuum: string | null;
}

export interface CapacitySnapshot {
  computedAt: string;
  severity: Severity;
  reasons: CapacityReason[];
  appHost: {
    cpuCount: number;
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    loadAvg: [number, number, number];
    /**
     * Every distinct filesystem Polaris and (when co-located) Postgres write
     * to. Pre-deduped by stat.dev so a single-LV box shows one entry, a
     * STIG-style RHEL with separate /var and /opt LVs shows two, etc.
     */
    volumes: VolumeStat[];
    dbColocated: boolean;
  };
  database: {
    sizeBytes: number;
    sampleTables: CapacitySampleTable[];
    /**
     * PostgreSQL `SHOW data_directory` value. Null when the DB is remote
     * (path is meaningless on this host) or when the SHOW failed.
     */
    dataDirectory: string | null;
    /**
     * TimescaleDB extension + per-table hypertable status. Drives the
     * `timescale_recommended` reason and is surfaced on the Maintenance tab
     * so operators can see at a glance whether their sample tables are on
     * the fast path (hypertable + chunk-drop prune + compression).
     */
    timescale: {
      extensionInstalled: boolean;
      hypertableTables: string[];
    };
    /**
     * Monitor work queue status. `pgbossInstalled` reflects whether the
     * pg-boss npm package is available at runtime; `active` is the mode
     * the running process is using (captured from Setting at boot);
     * `persisted` is the current Setting value (= what the next process
     * restart will use). When `active !== persisted`, the operator has
     * flipped the mode via the [Enable on next restart] button and a
     * restart is pending. Surfaced on the Maintenance tab Capabilities row.
     */
    queue: {
      pgbossInstalled: boolean;
      active: "cursor" | "pgboss";
      persisted: "cursor" | "pgboss";
    };
    /**
     * Live connection-pool picture against PostgreSQL's `max_connections`.
     *
     * `currentInUse` is the snapshot count from pg_stat_activity at the time
     * this CapacitySnapshot was built. `peakObserved` is a rolling high-water
     * mark tracked in module-local memory across snapshots — captures the
     * worst-case during discovery / peak monitoring even though the snapshot
     * itself might land during a quiet moment. Resets on process restart;
     * acceptable because the alert recurs naturally if the pool is genuinely
     * undersized.
     *
     * `prismaPoolSize` is what the Prisma driver-adapter pool was created with
     * (DATABASE_POOL_SIZE env var, default 25). `pgbossPoolSize` is what
     * pg-boss's separate internal pool was created with (POLARIS_PGBOSS_POOL_SIZE
     * env var, default 10) — null when the boot-time queue mode is "cursor"
     * since pg-boss isn't running.
     *
     * Drives the `db_pool_undersized` capacity reason and is surfaced on the
     * Maintenance tab Database card so operators can see headroom at a glance.
     */
    connectionPool: {
      currentInUse: number;
      peakObserved: number;
      prismaPoolSize: number;
      pgbossPoolSize: number | null;
      maxConnections: number;
    };
  };
  workload: {
    monitoredAssetCount: number;
    /**
     * Total operator-pinned interfaces being polled on the response-time
     * cadence — sum of `Asset.monitoredInterfaces` array lengths across every
     * monitored asset. Independent of the ~20-iface-per-asset default the
     * steady-state projection assumes for the full system-info pass; this is
     * just the fast-poll subset operators have explicitly opted into.
     */
    monitoredInterfaceCount: number;
    cadences: { responseTimeSec: number; telemetrySec: number; systemInfoSec: number };
    retention: { monitorDays: number; telemetryDays: number; systemInfoDays: number };
    /**
     * Steady-state DB size at the current cadences, retention, and monitored
     * asset count. This is what the database will grow to *if nothing changes*
     * — not a 30-day forecast. Calculated by extrapolating per-asset row rates
     * across the configured retention window for every time-series sample
     * table, then summing.
     */
    steadyStateSizeBytes: number;
  };
}

// Tables we project. Each maps to which retention setting governs it AND
// which asset-count bucket populates it.
//
//   "all"        — every monitored asset (response-time probe fires for all,
//                  including managed switches/APs via the controller path)
//   "telemetry"  — assets whose resolved telemetry method can actually deliver
//                  CPU/memory data. Managed FortiSwitches/FortiAPs on REST API
//                  are excluded: the endpoint lives on the parent FortiGate,
//                  not the device's IP, so collectTelemetry returns
//                  {supported:false} and lastTelemetryAt never advances.
//   "systemInfo" — same exclusion for interface/storage/IPsec/LLDP tables.
//                  WinRM and SSH *do* support system-info in principle so they
//                  are not excluded here (only the REST API + switch/AP combo).
const SAMPLE_TABLES: Array<{
  name: string;
  retention: keyof MonitorSettings;
  countKey: "all" | "telemetry" | "systemInfo";
}> = [
  { name: "asset_monitor_samples",       retention: "sampleRetentionDays",     countKey: "all"        },
  { name: "asset_telemetry_samples",     retention: "telemetryRetentionDays",  countKey: "telemetry"  },
  { name: "asset_temperature_samples",   retention: "telemetryRetentionDays",  countKey: "telemetry"  },
  { name: "asset_interface_samples",     retention: "systemInfoRetentionDays", countKey: "systemInfo" },
  { name: "asset_storage_samples",       retention: "systemInfoRetentionDays", countKey: "systemInfo" },
  { name: "asset_ipsec_tunnel_samples",  retention: "systemInfoRetentionDays", countKey: "systemInfo" },
];

// Default rows-per-asset-per-day when we have no samples yet to learn from.
// Numbers are deliberately conservative so a fresh install with monitoring
// just turned on still gets a sensible projection.
const DEFAULT_ROWS_PER_ASSET_PER_DAY: Record<string, (m: MonitorSettings) => number> = {
  asset_monitor_samples:       (m) => 86400 / m.intervalSeconds,
  asset_telemetry_samples:     (m) => 86400 / m.telemetryIntervalSeconds,
  asset_temperature_samples:   (m) => (86400 / m.telemetryIntervalSeconds) * 4,   // ~4 sensors
  asset_interface_samples:     (m) => (86400 / m.systemInfoIntervalSeconds) * 20, // ~20 ifaces
  asset_storage_samples:       (m) => (86400 / m.systemInfoIntervalSeconds) * 3,  // ~3 mounts
  asset_ipsec_tunnel_samples:  (m) => (86400 / m.systemInfoIntervalSeconds) * 1,  // ~1 tunnel
};

// Defaults used only when a table has zero rows (so avg bytes/row is unknown).
const DEFAULT_BYTES_PER_ROW: Record<string, number> = {
  asset_monitor_samples:       310,
  asset_telemetry_samples:     325,
  asset_temperature_samples:   290,
  asset_interface_samples:     395,
  asset_storage_samples:       310,
  asset_ipsec_tunnel_samples:  390,
};

const APP_DIR = dirname(fileURLToPath(import.meta.url));

// Conventional PGDATA paths per platform. Used when `SHOW data_directory`
// fails — typically because the application's DB role is not a superuser and
// not a member of `pg_read_all_settings` (the default in a least-privilege
// install), which makes `data_directory` unreadable. Without this fallback a
// separate /var on a STIG-style RHEL layout never enters the volume scan and
// the UI shows only the app volume even when /var is the at-risk filesystem.
// Mirrors the candidate list in `src/utils/startupDiskCheck.ts`.
const PG_DATA_DIR_CANDIDATES: string[] = process.platform === "win32"
  ? [
      "C:\\Program Files\\PostgreSQL\\17\\data",
      "C:\\Program Files\\PostgreSQL\\16\\data",
      "C:\\Program Files\\PostgreSQL\\15\\data",
      "C:\\Program Files\\PostgreSQL\\14\\data",
      "C:\\Program Files\\PostgreSQL\\13\\data",
    ]
  : [
      "/var/lib/pgsql/data",
      "/var/lib/pgsql/17/data",
      "/var/lib/pgsql/16/data",
      "/var/lib/pgsql/15/data",
      "/var/lib/postgresql/17/main",
      "/var/lib/postgresql/16/main",
      "/var/lib/postgresql/15/main",
      "/var/lib/postgresql/14/main",
    ];

async function pickFirstExistingPath(candidates: string[]): Promise<string | null> {
  for (const p of candidates) {
    try {
      await stat(p);
      return p;
    } catch {
      // not present, keep going
    }
  }
  return null;
}

function isDbLocal(): boolean {
  const url = process.env.DATABASE_URL || "";
  const m = url.match(/@([^:/?]+)/);
  if (!m) return false;
  const host = m[1].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Resolve PostgreSQL's data directory. Tries `SHOW data_directory` first
 * because it's authoritative when it works; falls back to scanning the
 * platform's conventional PGDATA candidates when it doesn't (the common case
 * is a non-superuser application role lacking `pg_read_all_settings`, which
 * makes `data_directory` unreadable). Returns null when the DB is remote or
 * when no candidate path exists on disk.
 */
async function resolveDbDataDirectory(): Promise<string | null> {
  if (!isDbLocal()) return null;
  try {
    const rows = await prisma.$queryRawUnsafe<{ data_directory: string }[]>(
      "SHOW data_directory",
    );
    const path = rows[0]?.data_directory;
    if (path && path.length > 0) return path;
  } catch (err: any) {
    logger.debug({ err: err?.message }, "capacityService: SHOW data_directory failed, falling back to platform candidates");
  }
  return pickFirstExistingPath(PG_DATA_DIR_CANDIDATES);
}

/**
 * Statfs a single path. Returns null on any failure (path missing, permission
 * denied, statfs unsupported). Caller drops null entries.
 */
async function statfsPath(
  path: string,
  role: VolumeRole,
): Promise<{ role: VolumeRole; path: string; dev: number; freeBytes: number; totalBytes: number } | null> {
  try {
    const [fs, st] = await Promise.all([statfs(path), stat(path)]);
    return {
      role,
      path,
      dev: Number(st.dev),
      freeBytes: Number(fs.bavail) * Number(fs.bsize),
      totalBytes: Number(fs.blocks) * Number(fs.bsize),
    };
  } catch {
    return null;
  }
}

/**
 * Build the deduped volume list. Each candidate path is statfs'd; entries
 * sharing the same stat.dev are merged so a single-volume box reports one
 * row (with multiple roles), and a multi-LV layout reports each filesystem
 * once. Roles are preserved as a set so the UI can label "app + state + db
 * on /var" or "db alone on /var/lib/pgsql".
 */
async function getVolumes(dataDirectory: string | null): Promise<VolumeStat[]> {
  const candidates: Array<{ role: VolumeRole; path: string }> = [
    { role: "app",     path: APP_DIR    },
    { role: "state",   path: STATE_DIR  },
    { role: "backups", path: BACKUP_DIR },
  ];
  if (dataDirectory) candidates.push({ role: "db", path: dataDirectory });

  const probed = (await Promise.all(candidates.map((c) => statfsPath(c.path, c.role))))
    .filter((v): v is NonNullable<typeof v> => v !== null);

  // Dedupe by stat.dev. Roles and paths accumulate; free/total are the same
  // for every entry on the same dev so we just take the first.
  const byDev = new Map<number, VolumeStat>();
  for (const p of probed) {
    const existing = byDev.get(p.dev);
    if (existing) {
      if (!existing.roles.includes(p.role)) existing.roles.push(p.role);
      if (!existing.paths.includes(p.path)) existing.paths.push(p.path);
    } else {
      byDev.set(p.dev, {
        paths: [p.path],
        roles: [p.role],
        freeBytes: p.freeBytes,
        totalBytes: p.totalBytes,
      });
    }
  }

  // Stable order: by lowest-free-percent first, so the most-at-risk volume
  // is always the first reasons-loop sees and the first the UI renders.
  return [...byDev.values()].sort((a, b) => {
    const pctA = a.totalBytes > 0 ? a.freeBytes / a.totalBytes : 1;
    const pctB = b.totalBytes > 0 ? b.freeBytes / b.totalBytes : 1;
    return pctA - pctB;
  });
}

interface PgStatRow {
  relname: string;
  n_live_tup: bigint;
  n_dead_tup: bigint;
  bytes: bigint;
  last_autovacuum: Date | null;
}

async function getSampleTableStats(): Promise<CapacitySampleTable[]> {
  const names = SAMPLE_TABLES.map((t) => t.name);
  const rows = await prisma.$queryRawUnsafe<PgStatRow[]>(
    `SELECT
       relname,
       n_live_tup,
       n_dead_tup,
       pg_total_relation_size(quote_ident(relname)) AS bytes,
       last_autovacuum
     FROM pg_stat_user_tables
     WHERE relname = ANY($1::text[])`,
    names,
  );

  // Index by name so we can return a stable, complete list even when a table
  // isn't yet in pg_stat_user_tables (fresh install before first insert).
  const byName = new Map(rows.map((r) => [r.relname, r]));
  return SAMPLE_TABLES.map((t) => {
    const r = byName.get(t.name);
    const live = r ? Number(r.n_live_tup) : 0;
    const dead = r ? Number(r.n_dead_tup) : 0;
    const bytes = r ? Number(r.bytes) : 0;
    const total = live + dead;
    // Divide by (live + dead) so a bloated table — tiny live count, large dead
    // count from a recent aggressive prune — doesn't produce an absurd per-row
    // estimate. bytes / 8 live rows on a 180 MB table → 22 MB/row; bytes /
    // (8 + 80k dead) → ~2 kB/row, which is realistic.
    const avgBytesPerRow = total > 0 ? Math.round(bytes / total) : DEFAULT_BYTES_PER_ROW[t.name] ?? 300;
    return {
      name: t.name,
      rows: live,
      bytes,
      avgBytesPerRow,
      deadTupRatio: total > 0 ? dead / total : 0,
      lastAutovacuum: r?.last_autovacuum ? r.last_autovacuum.toISOString() : null,
    };
  });
}

function projectSteadyStateSize(args: {
  currentDbBytes: number;
  sampleTables: CapacitySampleTable[];
  monitoredCount: number;
  /** Monitored assets that can actually produce telemetry (CPU/memory/temps).
   *  Excludes managed FortiSwitches/FortiAPs whose resolved polling is REST API. */
  telemetryEligibleCount: number;
  /** Monitored assets that can actually produce system-info (interfaces/storage/IPsec).
   *  Same exclusion as telemetryEligibleCount; WinRM/SSH are kept in. */
  systemInfoEligibleCount: number;
  monitor: MonitorSettings;
}): number {
  const { currentDbBytes, sampleTables, monitoredCount, telemetryEligibleCount, systemInfoEligibleCount, monitor } = args;

  // Subtract current sample-table bytes so we don't double-count when adding
  // the projected sample-table bytes back in.
  const sampleBytesNow = sampleTables.reduce((sum, t) => sum + t.bytes, 0);
  const baseBytes = Math.max(0, currentDbBytes - sampleBytesNow);

  if (monitoredCount === 0) {
    return currentDbBytes;
  }

  let projectedSampleBytes = 0;
  for (const def of SAMPLE_TABLES) {
    const t = sampleTables.find((s) => s.name === def.name);
    if (!t) continue;

    const count =
      def.countKey === "telemetry"  ? telemetryEligibleCount  :
      def.countKey === "systemInfo" ? systemInfoEligibleCount :
      monitoredCount;
    const rowsPerAssetPerDay = DEFAULT_ROWS_PER_ASSET_PER_DAY[def.name](monitor);
    const retentionDays = monitor[def.retention] as number;
    projectedSampleBytes += count * rowsPerAssetPerDay * retentionDays * t.avgBytesPerRow;
  }

  return baseBytes + projectedSampleBytes;
}

function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + " GB";
  if (b >= 1024 ** 2) return Math.round(b / 1024 ** 2) + " MB";
  if (b >= 1024)      return Math.round(b / 1024) + " kB";
  return b + " B";
}

/** Friendly label for a volume — combines its roles into "app + state" etc. */
function volumeLabel(v: VolumeStat): string {
  if (v.roles.length === 1) {
    if (v.roles[0] === "db") return "Database volume";
    if (v.roles[0] === "app") return "Application volume";
    if (v.roles[0] === "state") return "State volume";
    if (v.roles[0] === "backups") return "Backups volume";
  }
  const has = (r: VolumeRole) => v.roles.includes(r);
  if (has("db") && has("app")) return "Application + DB volume";
  if (has("db")) return "DB volume";
  return "Application volume";
}

export interface AdvisorGapsForReasons {
  workersUndersized: boolean;
  poolUndersized: boolean;
  maxConnectionsUndersized: boolean;
  /** Brief text naming the worst worker gap, used inside the reason message. */
  worstGap?: string;
  /** The recommended max_connections value, surfaced in the reason text. */
  recommendedMaxConnections?: number;
}

function computeReasons(
  snap: CapacitySnapshot,
  ramInsufficient: boolean,
  pgTuningNeeded: boolean,
  advisor?: AdvisorGapsForReasons,
): CapacityReason[] {
  const reasons: CapacityReason[] = [];
  const ram = snap.appHost.totalMemoryBytes;

  // ── Per-volume disk thresholds ────────────────────────────────────────────
  // Walk every distinct filesystem Polaris/Postgres write to so a small
  // separate /var (the canonical RHEL trap) is caught even when the install
  // volume is comfortable. Volumes are pre-sorted lowest-free first.
  for (const v of snap.appHost.volumes) {
    if (v.totalBytes <= 0) continue;
    const pct = v.freeBytes / v.totalBytes;
    const pathHint = v.paths[0] ? ` (${v.paths[0]})` : "";
    const label = volumeLabel(v);

    if (pct < 0.10) {
      reasons.push({
        severity: "red",
        code: "disk_critical",
        message: `${label} has only ${formatBytes(v.freeBytes)} free (${(pct * 100).toFixed(1)}%)${pathHint}.`,
        suggestion: v.roles.includes("db")
          ? "Free disk space immediately or expand the volume — PostgreSQL will refuse new writes once the volume is full."
          : "Free disk space immediately or expand the volume — backups and update rollback both need headroom.",
      });
    } else if (pct < 0.20) {
      reasons.push({
        severity: "amber",
        code: "disk_low",
        message: `${label} free is ${(pct * 100).toFixed(0)}%${pathHint}.`,
        suggestion: "Plan to expand the volume soon. Backups and update rollback both require headroom.",
      });
    } else if (pct < 0.30) {
      reasons.push({
        severity: "watch",
        code: "disk_watch",
        message: `${label} free is ${(pct * 100).toFixed(0)}%${pathHint}.`,
        suggestion: "Watch trend over the next few weeks; expand the volume before it crosses 20%.",
      });
    }
  }

  // Database dominates *its* volume (only useful when DB volume is visible).
  const dbVolume = snap.appHost.volumes.find((v) => v.roles.includes("db"));
  if (dbVolume && snap.database.sizeBytes > dbVolume.freeBytes * 0.5) {
    reasons.push({
      severity: "red",
      code: "db_dominates_disk",
      message: `Database (${formatBytes(snap.database.sizeBytes)}) exceeds 50% of free space on its volume.`,
      suggestion: "Reduce sample retention (Asset monitoring settings), expand the disk, or move PostgreSQL to a larger volume.",
    });
  }

  // Steady-state projection exceeds available disk on the DB volume. At current
  // settings the DB will fill the disk before reaching steady-state — the
  // per-volume disk-free thresholds above won't fire until it's already too late.
  if (dbVolume && snap.workload.steadyStateSizeBytes > dbVolume.freeBytes) {
    reasons.push({
      severity: "red",
      code: "projected_exceeds_disk",
      message: `Steady-state database size (${formatBytes(snap.workload.steadyStateSizeBytes)}) exceeds free space on the database volume (${formatBytes(dbVolume.freeBytes)} free).`,
      suggestion: "Reduce sample retention or monitored asset count, or expand the database volume. The Capacity Advisor card surfaces retention and cadence levers if you can't expand the volume.",
    });
  } else if (dbVolume && snap.workload.steadyStateSizeBytes > dbVolume.freeBytes * 0.75) {
    reasons.push({
      severity: "amber",
      code: "projected_approaches_disk",
      message: `Steady-state database size (${formatBytes(snap.workload.steadyStateSizeBytes)}) will consume more than 75% of free space on the database volume (${formatBytes(dbVolume.freeBytes)} free).`,
      suggestion: "Consider reducing sample retention or expanding the database volume before it fills. The Capacity Advisor card surfaces retention and cadence levers if you can't expand the volume.",
    });
  }

  // Stale autovacuum on a populated sample table — bloat will keep growing.
  // Collapsed into a single reason listing every affected table so an install
  // with several bloated sample tables doesn't render the same advice 3-5
  // times stacked vertically. TimescaleDB hypertables are exempted: their
  // chunks are append-only and become immutable once the compression policy
  // runs (default: 7 days), so the parent table legitimately won't autovacuum
  // and would trip this red rule permanently. The amber `autovacuum_lag`
  // rule (dead-tup ratio) below is the real signal for those tables.
  const tsHypertables = new Set(snap.database.timescale?.hypertableTables ?? []);
  const staleTables = snap.database.sampleTables.filter((t) => {
    if (tsHypertables.has(t.name)) return false;
    if (!t.lastAutovacuum || t.rows <= 1000) return false;
    return Date.now() - new Date(t.lastAutovacuum).getTime() > 7 * 86400 * 1000;
  });
  if (staleTables.length > 0) {
    const names = staleTables.map((t) => t.name).join(", ");
    reasons.push({
      severity: "red",
      code: "autovacuum_stale",
      message: staleTables.length === 1
        ? `Table ${names} hasn't been autovacuumed in over 7 days.`
        : `${staleTables.length} tables haven't been autovacuumed in over 7 days: ${names}.`,
      suggestion: `Investigate autovacuum status. Run VACUUM on the affected tables manually and lower autovacuum_vacuum_scale_factor to 0.05 for each.`,
    });
  }

  // Steady-state DB size > 8× host RAM — query performance will collapse.
  if (snap.workload.steadyStateSizeBytes > ram * 8) {
    reasons.push({
      severity: "red",
      code: "projected_db_huge",
      message: `Steady-state database size (${formatBytes(snap.workload.steadyStateSizeBytes)}) is more than 8× host RAM at current settings.`,
      suggestion: "Add RAM, reduce sample retention, or reduce the monitored asset count. Charts will get progressively slower. The Capacity Advisor card surfaces retention and cadence levers if you can't add RAM.",
    });
  }

  // ── Amber: autovacuum lag ────────────────────────────────────────────────
  // Collapsed into a single reason listing every affected table with its
  // dead-tuple percentage — multiple bloated sample tables would otherwise
  // each push their own near-identical warning row.
  const laggingTables = snap.database.sampleTables.filter(
    (t) => t.rows > 1000 && t.deadTupRatio > 0.20,
  );
  if (laggingTables.length > 0) {
    const list = laggingTables
      .map((t) => `${t.name} (${(t.deadTupRatio * 100).toFixed(0)}%)`)
      .join(", ");
    reasons.push({
      severity: "amber",
      code: "autovacuum_lag",
      message: laggingTables.length === 1
        ? `Table ${list} has dead tuples building up — autovacuum is falling behind.`
        : `${laggingTables.length} tables have dead tuples building up — autovacuum is falling behind: ${list}.`,
      suggestion: `Lower autovacuum_vacuum_scale_factor to 0.05 for the affected tables.`,
    });
  }

  if (snap.workload.steadyStateSizeBytes > ram * 4 && snap.workload.steadyStateSizeBytes <= ram * 8) {
    reasons.push({
      severity: "amber",
      code: "projected_db_large",
      message: `Steady-state database size (${formatBytes(snap.workload.steadyStateSizeBytes)}) exceeds 4× host RAM.`,
      suggestion: "Consider adding RAM or reducing sample retention before performance degrades. The Capacity Advisor card surfaces retention and cadence levers if you can't add RAM.",
    });
  }

  // ── pg-boss state ────────────────────────────────────────────────────────
  // The legacy pgboss_recommended / pgboss_overdue / pgboss_pending reasons
  // were folded into the Capacity Advisor card, which surfaces queue mode as
  // one of its levers alongside pool sizes and worker counts. See
  // capacityAdvisorService.ts and the QUEUE_MODE recommendation.

  // ── Watch: TimescaleDB recommendation ────────────────────────────────────
  // Once the sample tables together cross ~1 GB and the extension isn't
  // installed, advise the operator. Below the threshold it's not worth
  // bothering them — plain Postgres prune handles small sample tables fine.
  // Above it, partition-drop prune and compression are step-change wins
  // (10-30× storage reduction, instant chunk drops vs. seq-scan deleteMany).
  // The suggestion adapts to deployment context so the install hint matches
  // the operator's actual environment.
  const TIMESCALE_RECOMMEND_BYTES = 1024 * 1024 * 1024; // 1 GB
  const sampleTableBytes = snap.database.sampleTables.reduce((sum, t) => sum + t.bytes, 0);
  if (!snap.database.timescale.extensionInstalled && sampleTableBytes > TIMESCALE_RECOMMEND_BYTES) {
    const ctx = getDeploymentContext();
    const suggestion = !ctx.dbIsLocal
      ? "Ask your database administrator to install the timescaledb extension on the polaris database. Some managed services (RDS for Postgres) don't support it; Timescale Cloud and Azure Postgres Flexible Server do."
      : ctx.runtimeIsContainer
        ? "Switch your Postgres container to the timescale/timescaledb:latest-pg15 image. Existing data is preserved on the volume."
        : "Install TimescaleDB on this server. See docs/INSTALL.md → Recommended: TimescaleDB.";
    reasons.push({
      severity: "watch",
      code: "timescale_recommended",
      message: `Sample tables are ${formatBytes(sampleTableBytes)}. Installing TimescaleDB would compress them by ~10× and make daily prune instant.`,
      suggestion,
    });
  }

  // ── Watch: pool / workers / max_connections undersized (rollup from advisor) ─
  // The legacy `db_pool_undersized` reason was absorbed into the Capacity
  // Advisor's DATABASE_POOL_SIZE recommendation — the advisor factors
  // peakObserved into the prisma pool target directly, so when the pool is
  // genuinely undersized the advisor's row flips to "Stage" and the
  // poolUndersized flag (passed in via `advisor`) carries the signal.
  const pool = snap.database.connectionPool;

  // ── Watch: connection pool undersized (rollup from advisor) ────────────
  // Replaces the legacy `db_pool_undersized` reason which fired on peak
  // utilization heuristics. The advisor's DATABASE_POOL_SIZE recommendation
  // now factors peakObserved directly into the prisma pool target, so when
  // pool is undersized the advisor card carries the exact recommended value
  // and this reason just flags it for the Maintenance pill.
  if (advisor?.poolUndersized) {
    reasons.push({
      severity: "watch",
      code: "pool_undersized",
      message: `Database connection pool is sized below what the current peak demand requires.`,
      suggestion:
        `Open the Capacity Advisor card and click Stage to write the recommended pool sizes ` +
        `to .env. Bumping the pool is a low-risk fix when Postgres has headroom. If ` +
        `pg_stat_activity shows many rows stuck in idle in transaction, fix the holders instead.`,
    });
  }

  // ── Watch: monitor workers undersized (rollup from advisor) ─────────────
  // Single rollup reason — one entry per cadence would clutter the panel.
  // The advisor card carries the per-cadence recommendations.
  if (advisor?.workersUndersized) {
    const gapText = advisor.worstGap ? ` Worst gap: ${advisor.worstGap}.` : "";
    reasons.push({
      severity: "watch",
      code: "monitor_workers_undersized",
      message: `Monitor worker pool is sized below what the current workload requires.${gapText}`,
      suggestion:
        `Open the Capacity Advisor card and click Stage to write the recommended worker ` +
        `counts to .env. Takes effect on next Polaris restart.`,
    });
  }

  // ── Amber: max_connections undersized ───────────────────────────────────
  // Fires when current max_connections is below what the advisor would
  // recommend. Requires a PostgreSQL restart, so it stays advisory and
  // doesn't get a Stage button.
  if (advisor?.maxConnectionsUndersized && advisor.recommendedMaxConnections && pool.maxConnections > 0) {
    reasons.push({
      severity: "amber",
      code: "max_connections_undersized",
      message:
        `PostgreSQL max_connections is ${pool.maxConnections} but the recommended value ` +
        `for current workload is ${advisor.recommendedMaxConnections}.`,
      suggestion:
        `Set max_connections=${advisor.recommendedMaxConnections} in postgresql.conf and ` +
        `restart PostgreSQL. Polaris can't change this from the UI because it requires a Postgres restart.`,
    });
  }

  // ── Watch: unauthenticated /metrics or /health endpoint ────────────────
  // Both endpoints are open by default and gated by their respective bearer
  // tokens when set. The setup wizard auto-generates both tokens at install
  // time; this fires when an operator has cleared one (or upgraded from a
  // pre-auto-token install). /metrics is the higher-impact leak — fleet
  // size, monitor health by status, queue depth, transport-level RTT
  // histograms — so it gets its own reason; /health is recon-only ("the
  // app is up") but symmetric and trivial to gate, so we surface it too.
  // Watch-severity: Maintenance-tab warning + audit Event, no navbar
  // banner. Operators who deliberately want either endpoint open (some
  // L4 health probes can't carry a header) can ignore the warning.
  if (!process.env.METRICS_TOKEN || process.env.METRICS_TOKEN.trim() === "") {
    reasons.push({
      severity: "watch",
      code: "metrics_token_unset",
      message:
        "/metrics is reachable without authentication. The endpoint exposes " +
        "fleet size, monitored asset health, monitor pass duration, and queue " +
        "depth — useful recon for an attacker if Polaris is publicly reachable.",
      suggestion:
        "Click Generate token to write METRICS_TOKEN into .env (the gate takes " +
        "effect immediately — no restart). Then update your Prometheus scrape " +
        "config to send `Authorization: Bearer <token>` — see docs/grafana/README.md.",
    });
  }
  if (!process.env.HEALTH_TOKEN || process.env.HEALTH_TOKEN.trim() === "") {
    reasons.push({
      severity: "watch",
      code: "health_token_unset",
      message:
        "/health is reachable without authentication. The leak is small " +
        "(just 'the app is up') but the gate is trivial to enable.",
      suggestion:
        "Click Generate token to write HEALTH_TOKEN into .env (the gate takes " +
        "effect immediately — no restart). Then configure your monitoring system " +
        "to send `Authorization: Bearer <token>`.",
    });
  }

  // RAM-insufficient and PG-tuning are amber card reasons — the route handler
  // computes the inputs and passes them in here.
  if (ramInsufficient) {
    reasons.push({
      severity: "amber",
      code: "ram_insufficient",
      message: `Host RAM is below the recommended minimum for the current database size.`,
      suggestion: "Add RAM to reach the recommended minimum (see the host card for the target).",
    });
  }
  if (pgTuningNeeded) {
    reasons.push({
      severity: "amber",
      code: "pg_tuning_needed",
      message: `One or more PostgreSQL settings are below the recommended minimum.`,
      suggestion: "See the PostgreSQL Tuning section below for the specific settings to adjust.",
    });
  }

  return reasons;
}

function deriveSeverity(reasons: CapacityReason[]): Severity {
  if (reasons.some((r) => r.severity === "red")) return "red";
  if (reasons.some((r) => r.severity === "amber")) return "amber";
  if (reasons.some((r) => r.severity === "watch")) return "watch";
  return "ok";
}

/**
 * Build the snapshot. Pure: reads system state but does not write any
 * Settings or Events. Use `recordCapacityTransition` if you want to fire
 * the audit-log Event on severity changes.
 */
export async function getCapacitySnapshot(opts: {
  ramInsufficient: boolean;
  pgTuningNeeded: boolean;
  /** Optional advisor-driven gap data. When provided, populates the
   *  `monitor_workers_undersized` / `max_connections_undersized` reasons.
   *  Omitted by callers that don't yet have an advisor state (e.g. the
   *  first half of the two-pass orchestration in getCapacitySnapshotWithAdvisor). */
  advisor?: AdvisorGapsForReasons;
}): Promise<CapacitySnapshot> {
  const dataDirectory = await resolveDbDataDirectory();

  // An asset is telemetry/systemInfo-eligible when it is NOT a managed
  // FortiSwitch/FortiAP whose resolved polling method is REST API. The full
  // four-tier hierarchy resolver isn't practical for an aggregate count, so we
  // approximate: exclude assets where assetType is switch/access_point AND
  // the per-asset polling column is null (= inherits REST API from the FMG/FG
  // integration source default) or explicitly set to rest_api. Switches/APs
  // with an explicit snmp override are correctly kept in.
  // Count helper: assets that will actually produce telemetry/systemInfo rows.
  // Managed FortiSwitches/APs on REST API never do (the endpoints live on the
  // parent FortiGate, not the device's IP), so the full monitored count would
  // inflate those table projections. We approximate by excluding assets where
  // assetType is switch/access_point AND the per-asset polling column is null
  // (= inherits REST API from the integration source default) or explicitly
  // set to rest_api. Assets with an explicit snmp override are kept in.
  const telemetryEligibleSQL = `
    SELECT COUNT(*)::bigint AS count FROM "assets"
    WHERE monitored = true
      AND NOT (
        "assetType" IN ('switch', 'access_point')
        AND ("telemetryPolling" IS NULL OR "telemetryPolling" = 'rest_api')
      )`;
  const systemInfoEligibleSQL = `
    SELECT COUNT(*)::bigint AS count FROM "assets"
    WHERE monitored = true
      AND NOT (
        "assetType" IN ('switch', 'access_point')
        AND ("interfacesPolling" IS NULL OR "interfacesPolling" = 'rest_api')
      )`;

  const [
    monitor,
    monitoredCount,
    telemetryEligibleRow,
    systemInfoEligibleRow,
    monitoredInterfaceRow,
    volumes,
    dbSizeRow,
    sampleTables,
    connRow,
  ] = await Promise.all([
    getMonitorSettings(),
    prisma.asset.count({ where: { monitored: true } }),
    prisma.$queryRawUnsafe<{ count: bigint }[]>(telemetryEligibleSQL),
    prisma.$queryRawUnsafe<{ count: bigint }[]>(systemInfoEligibleSQL),
    prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COALESCE(SUM(COALESCE(array_length("monitoredInterfaces", 1), 0)), 0)::bigint AS count
         FROM "assets"
        WHERE monitored = true`,
    ),
    getVolumes(dataDirectory),
    prisma.$queryRawUnsafe<{ size: bigint }[]>(
      "SELECT pg_database_size(current_database()) AS size",
    ),
    getSampleTableStats(),
    readPgStatActivity(),
  ]);
  const telemetryEligibleCount  = Number(telemetryEligibleRow[0]?.count  ?? monitoredCount);
  const systemInfoEligibleCount = Number(systemInfoEligibleRow[0]?.count ?? monitoredCount);

  const monitoredInterfaceCount = Number(monitoredInterfaceRow[0]?.count ?? 0);
  const dbSizeBytes = Number(dbSizeRow[0]?.size ?? 0);

  // Connection-pool snapshot. Update the rolling peak before reading it back
  // so the snapshot reflects the new high-water mark when this call is the
  // one that observed it.
  const currentInUse = Number(connRow.in_use ?? 0);
  const maxConnections = Number(connRow.max ?? 0);
  if (currentInUse > peakConnectionCount) peakConnectionCount = currentInUse;
  const bootMode = getBootTimeMode();
  const prismaPoolSize = readEnvInt("DATABASE_POOL_SIZE", 25);
  // Default must match queueService.ts:resolveEnvInt("POLARIS_PGBOSS_POOL_SIZE", 20) — that's
  // the value pg-boss is actually instantiated with when the env var is unset, so we report
  // it consistently in the snapshot. A mismatch here made the Database card's "Polaris pool
  // size" line disagree with the Capacity Advisor's "POLARIS_PGBOSS_POOL_SIZE" row.
  const pgbossPoolSize = bootMode === "pgboss" ? readEnvInt("POLARIS_PGBOSS_POOL_SIZE", 20) : null;

  const cadences = {
    responseTimeSec: monitor.intervalSeconds,
    telemetrySec:    monitor.telemetryIntervalSeconds,
    systemInfoSec:   monitor.systemInfoIntervalSeconds,
  };
  const retention = {
    monitorDays:    monitor.sampleRetentionDays,
    telemetryDays:  monitor.telemetryRetentionDays,
    systemInfoDays: monitor.systemInfoRetentionDays,
  };

  const steadyStateSizeBytes = projectSteadyStateSize({
    currentDbBytes: dbSizeBytes,
    sampleTables,
    monitoredCount,
    telemetryEligibleCount,
    systemInfoEligibleCount,
    monitor,
  });

  const snap: CapacitySnapshot = {
    computedAt: new Date().toISOString(),
    severity: "ok",
    reasons: [],
    appHost: {
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
      loadAvg: loadavg() as [number, number, number],
      volumes,
      dbColocated: isDbLocal(),
    },
    database: {
      sizeBytes: dbSizeBytes,
      sampleTables,
      dataDirectory,
      timescale: {
        extensionInstalled: isTimescaleAvailable(),
        hypertableTables: TIMESCALE_SAMPLE_TABLES.filter((t) => isHypertable(t)),
      },
      queue: {
        pgbossInstalled: isPgbossInstalled(),
        active: getBootTimeMode(),
        persisted: await getQueueMode(),
      },
      connectionPool: {
        currentInUse,
        peakObserved: peakConnectionCount,
        prismaPoolSize,
        pgbossPoolSize,
        maxConnections,
      },
    },
    workload: {
      monitoredAssetCount: monitoredCount,
      monitoredInterfaceCount,
      cadences,
      retention,
      steadyStateSizeBytes,
    },
  };

  snap.reasons = computeReasons(snap, opts.ramInsufficient, opts.pgTuningNeeded, opts.advisor);
  snap.severity = deriveSeverity(snap.reasons);
  return snap;
}

/**
 * Two-pass orchestrator: builds an initial snapshot, computes the Capacity
 * Advisor state against it, then rebuilds the snapshot with the advisor's gap
 * data wired into computeReasons so the advisor-driven reasons appear.
 *
 * Used by callers that want both the snapshot and the advisor state without
 * duplicating the orchestration (capacityWatch job, the new
 * /server-settings/capacity-advisor route).
 *
 * `pgTuning` is the external dependency that `capacityAdvisorService` can't
 * compute on its own — it's owned by `buildPgRecommended` in serverSettings.ts.
 * Callers pass in the already-computed current/recommended pairs.
 */
export async function getCapacitySnapshotWithAdvisor(
  opts: {
    ramInsufficient: boolean;
    pgTuningNeeded: boolean;
    pgTuning: import("./capacityAdvisorService.js").PgTuningExternal;
  },
): Promise<{
  snapshot: CapacitySnapshot;
  advisor: import("./capacityAdvisorService.js").AdvisorState;
}> {
  // Avoid an import cycle at module load: require lazily inside the function.
  // capacityAdvisorService imports type-only from this module, so this dynamic
  // import is purely a paranoia-belt for the runtime side.
  const advisorMod = await import("./capacityAdvisorService.js");
  // Build the snapshot once. The expensive bits (sample-table stats, volume
  // statfs, pg_stat_activity) cost hundreds of ms on busy DBs — re-running
  // the full snapshot just to inject advisor reasons was doubling the
  // Maintenance tab's first-paint latency.
  const snapshot = await getCapacitySnapshot({
    ramInsufficient: opts.ramInsufficient,
    pgTuningNeeded: opts.pgTuningNeeded,
  });
  // Compute the advisor state against this snapshot.
  const advisor = await advisorMod.recomputeAdvisorFromSnapshot(snapshot, opts.pgTuning);
  const gaps = advisorMod.summarizeAdvisorGaps(advisor);
  // The recommendedMaxConnections lives on the advisor's PG_MAX_CONNECTIONS
  // recommendation; surface it so the reason text can name the value.
  const maxConnRec = advisor.recommendations.find((r) => r.key === "PG_MAX_CONNECTIONS");
  const gapsForReasons: AdvisorGapsForReasons = {
    ...gaps,
    recommendedMaxConnections:
      maxConnRec && typeof maxConnRec.recommended === "number"
        ? maxConnRec.recommended
        : undefined,
  };
  // Re-derive reasons + severity in place with the advisor gaps wired in,
  // so the advisor-driven reasons fire without doing a second snapshot pass.
  snapshot.reasons = computeReasons(snapshot, opts.ramInsufficient, opts.pgTuningNeeded, gapsForReasons);
  snapshot.severity = deriveSeverity(snapshot.reasons);
  return { snapshot, advisor };
}

// ─── Transition-only Event emission ───────────────────────────────────────────
// Storing the last severity in a Setting key lets us emit an Event only when
// severity actually changes. The Event flows out through eventArchiveService
// to syslog/SFTP, so a flip into red on a busy night reaches the on-call
// channel even when the UI has already stopped responding (DB on the floor).
// The route handler and a periodic job both call this; concurrent calls are
// idempotent because we re-read the stored value inside the same flow and
// no-op when it already matches the new severity.

const SEVERITY_SETTING_KEY = "capacity.lastSeverity";

interface StoredSeverity {
  severity: Severity;
  recordedAt: string;
}

async function readStoredSeverity(): Promise<StoredSeverity | null> {
  const row = await prisma.setting.findUnique({ where: { key: SEVERITY_SETTING_KEY } });
  if (!row) return null;
  const v = row.value as Partial<StoredSeverity> | null;
  if (!v || !v.severity) return null;
  return { severity: v.severity as Severity, recordedAt: v.recordedAt ?? new Date(0).toISOString() };
}

async function writeStoredSeverity(severity: Severity): Promise<void> {
  const value: StoredSeverity = { severity, recordedAt: new Date().toISOString() };
  await prisma.setting.upsert({
    where: { key: SEVERITY_SETTING_KEY },
    update: { value: value as any },
    create: { key: SEVERITY_SETTING_KEY, value: value as any },
  });
}

function severityRank(s: Severity): number {
  if (s === "red") return 3;
  if (s === "amber") return 2;
  if (s === "watch") return 1;
  return 0;
}

function pickHeadlineReason(reasons: CapacityReason[]): CapacityReason | null {
  if (reasons.length === 0) return null;
  const ranked = [...reasons].sort((a, b) => {
    const rank = (s: CapacityReason["severity"]) =>
      s === "red" ? 3 : s === "amber" ? 2 : 1;
    return rank(b.severity) - rank(a.severity);
  });
  return ranked[0];
}

/**
 * Compare current snapshot severity against the last-stored severity and emit
 * one `capacity.severity_changed` Event if they differ. Best-effort — failures
 * are logged at debug level and never thrown so a transient DB hiccup doesn't
 * break the snapshot fetch.
 *
 * Maps severity to Event level: red → "error", amber/watch → "warning",
 * ok → "info" (recovery).
 */
export async function recordCapacityTransition(snap: CapacitySnapshot): Promise<void> {
  try {
    const prior = await readStoredSeverity();
    if (prior && prior.severity === snap.severity) return;

    const level = snap.severity === "red"
      ? "error"
      : snap.severity === "amber" || snap.severity === "watch"
      ? "warning"
      : "info";

    const direction = !prior
      ? "initial"
      : severityRank(snap.severity) > severityRank(prior.severity)
        ? "escalated"
        : "recovered";

    const headline = pickHeadlineReason(snap.reasons);
    const message = !prior
      ? `Capacity baseline established at ${snap.severity}.`
      : direction === "escalated"
        ? `Capacity ${prior.severity} → ${snap.severity}${headline ? `: ${headline.message}` : "."}`
        : `Capacity ${prior.severity} → ${snap.severity} (recovered).`;

    await prisma.event.create({
      data: {
        action: "capacity.severity_changed",
        resourceType: "system",
        actor: "system",
        level,
        message,
        details: {
          from: prior?.severity ?? null,
          to: snap.severity,
          direction,
          reasons: snap.reasons,
          volumes: snap.appHost.volumes.map((v) => ({
            paths: v.paths,
            roles: v.roles,
            freeBytes: v.freeBytes,
            totalBytes: v.totalBytes,
            freePct: v.totalBytes > 0
              ? Number(((v.freeBytes / v.totalBytes) * 100).toFixed(1))
              : null,
          })),
        } as any,
      },
    });

    await writeStoredSeverity(snap.severity);
  } catch (err: any) {
    logger.debug({ err: err?.message }, "capacityService: recordCapacityTransition failed");
  }
}
