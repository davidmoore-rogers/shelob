/**
 * src/services/queueService.ts
 *
 * Monitor work queue mode + pg-boss runtime lifecycle. Polaris ships with
 * two queue implementations:
 *
 *   "cursor" (default) — the in-memory cursor-pool queue inside
 *                        runMonitorPass; used by every install out of
 *                        the box. Fits small/medium fleets fine after
 *                        the Step 4a split-tick fix.
 *   "pgboss"           — pg-boss-backed durable queue with per-cadence
 *                        worker pools (probe / fastFiltered / telemetry
 *                        / systemInfo). Recommended once monitored asset
 *                        count crosses ~500 or pass duration exceeds the
 *                        probe cadence; opt-in via the Maintenance tab
 *                        recommendation alert's [Enable on next restart]
 *                        button. Setting takes effect on next process
 *                        restart so the boot path can wire the right
 *                        scheduler before any tick fires.
 *
 * The active mode lives in `Setting.monitor.queueMode` (`"cursor" | "pgboss"`);
 * reads are cached at startup so subsequent `getQueueMode()` calls don't
 * round-trip the DB. `setQueueMode()` writes the Setting AND updates the
 * cache, but the running process keeps its boot-time mode — only the next
 * restart picks up the change. That's intentional: switching queue
 * scheduler mid-run would require draining in-flight jobs and restarting
 * timers, which is way more complexity than the operator-side restart
 * cost is worth.
 */

import { cpus } from "node:os";
import type { PgBoss as PgBossType, Job as PgBossJob } from "pg-boss";

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { setPgbossQueueJobs, setPgbossJobAge, recordQueueMode, setMonitorWorkers } from "../metrics.js";
import {
  runProbeFor,
  runTelemetryFor,
  runSystemInfoFor,
  runFastFilteredFor,
  type MonitorCadence,
} from "./monitoringService.js";

export type QueueMode = "cursor" | "pgboss";

const SETTING_KEY = "monitor.queueMode";

let cachedMode: QueueMode | null = null;
let cachedPgbossInstalled: boolean | null = null;
/**
 * Mode the running process actually uses. Captured at boot from the Setting
 * value; ignores subsequent setQueueMode() calls so the operator-driven
 * "enable on next restart" semantics are preserved without tracking two
 * separate caches in callers.
 */
let bootTimeMode: QueueMode | null = null;

/**
 * Try to dynamically load pg-boss. The package is bundled, so this only
 * fails if node_modules is incomplete or the install was extracted from a
 * stripped tarball. Cached after first call.
 */
export async function detectPgboss(): Promise<boolean> {
  if (cachedPgbossInstalled !== null) return cachedPgbossInstalled;
  try {
    await import("pg-boss");
    cachedPgbossInstalled = true;
  } catch {
    cachedPgbossInstalled = false;
  }
  return cachedPgbossInstalled;
}

export function isPgbossInstalled(): boolean {
  return cachedPgbossInstalled === true;
}

/**
 * Read the persisted queue mode. Cached after first call. Defaults to
 * "cursor" when no Setting is present, when the value is malformed, or
 * when pg-boss is somehow not installed (defensive fallback so a missing
 * package can never strand a fleet without monitoring).
 */
export async function getQueueMode(): Promise<QueueMode> {
  if (cachedMode !== null) return cachedMode;
  try {
    const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
    const v = row?.value as { mode?: string } | null;
    const fromSetting: QueueMode = v?.mode === "pgboss" ? "pgboss" : "cursor";
    cachedMode = fromSetting === "pgboss" && !isPgbossInstalled() ? "cursor" : fromSetting;
  } catch {
    cachedMode = "cursor";
  }
  return cachedMode;
}

/**
 * Persist the queue mode. Updates the Setting and refreshes the cache, but
 * does NOT change `getBootTimeMode()` — the running process continues using
 * whatever it picked up at boot. The new mode takes effect on next restart.
 */
export async function setQueueMode(mode: QueueMode): Promise<void> {
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: { mode } },
    create: { key: SETTING_KEY, value: { mode } },
  });
  cachedMode = mode;
}

/**
 * The mode this process is actually running with. Set once at boot by
 * `initializeQueue()`. Subsequent `setQueueMode()` calls update the Setting
 * and the on-disk cache but never this value, so dispatch in the monitor
 * job stays consistent for the lifetime of the process.
 */
export function getBootTimeMode(): QueueMode {
  return bootTimeMode ?? "cursor";
}

/**
 * Warm caches and capture the boot-time mode. Call once at startup, before
 * any monitor tick fires. Idempotent.
 */
export async function initializeQueue(): Promise<void> {
  await detectPgboss();
  bootTimeMode = await getQueueMode();
  recordQueueMode(bootTimeMode);
}

// ─── pg-boss runtime ───────────────────────────────────────────────────────
//
// Naming convention: every Polaris-owned queue starts `polaris-monitor-`.
// When discovery moves into pg-boss in a future phase, add `polaris-discovery-*`
// queues alongside and revisit the worker-count tuning together — they share
// the same Node.js worker process and the same DB pool.

export const QUEUE_NAMES: Record<MonitorCadence, string> = {
  probe:        "polaris-monitor-probe",
  fastFiltered: "polaris-monitor-fastfiltered",
  telemetry:    "polaris-monitor-telemetry",
  systemInfo:   "polaris-monitor-systeminfo",
};

interface MonitorJobPayload {
  assetId: string;
  /** Probe-only: labels the per-transport metric. Omitted for other cadences. */
  transport?: string;
}

let bossInstance: PgBossType | null = null;
let metricsRefreshInterval: ReturnType<typeof setInterval> | null = null;

// ─── Stalled-worker watchdog ─────────────────────────────────────────────────
//
// pg-boss workers stop consuming when the internal polling timer crashes on a
// DB connection error — the "error" event fires and is logged, but the timer
// doesn't restart automatically. The symptom: many jobs in "created" state,
// 0 active for > 1 minute. The fix is a full stop→start cycle.
//
// Safety rails: at most 3 auto-recoveries per rolling hour; each attempt is
// logged so operators can see what happened in journalctl. After the cap is
// hit, a plain error is logged every minute so the alert remains visible.

const STALL_CREATED_THRESHOLD  = 50;   // > 50 queued jobs with 0 active = suspicious
const STALL_CONSECUTIVE_LIMIT   = 4;   // 4 × 15 s = 1 min before we act
const STALL_MAX_RECOVERIES      = 3;
const STALL_RECOVERY_WINDOW_MS  = 60 * 60 * 1000; // 1 h rolling window

let stalledReadings  = 0;
let recoveryAttempts: number[] = []; // timestamps of recent auto-recoveries
let recovering       = false;

async function attemptWorkerRecovery(): Promise<void> {
  if (recovering) return;
  recovering = true;
  try {
    logger.warn("pg-boss workers stalled; attempting auto-recovery (stop → start)");
    // Clear the metrics interval so startPgbossWorkers won't create a duplicate.
    if (metricsRefreshInterval !== null) {
      clearInterval(metricsRefreshInterval);
      metricsRefreshInterval = null;
    }
    if (bossInstance) {
      try { await bossInstance.stop({ graceful: false, timeout: 10_000 }); } catch { /* best-effort */ }
      bossInstance = null;
    }
    await startPgbossWorkers();
    logger.info("pg-boss worker auto-recovery completed");
  } catch (err) {
    logger.error({ err }, "pg-boss worker auto-recovery failed — restart polaris to recover monitoring");
  } finally {
    recovering = false;
  }
}

/**
 * Refresh pg-boss queue-depth metrics by querying pgboss.job directly.
 * Runs every 15s while pg-boss is active. Zero-fills all queue×state
 * combinations first so gauges don't linger when a queue drains.
 * Also runs the stalled-worker watchdog on each tick.
 */
async function refreshPgbossMetrics(): Promise<void> {
  let totalCreated = 0;
  let totalActive  = 0;
  let heavyCreated = 0;
  let heavyActive  = 0;
  try {
    const queueNames = Object.values(QUEUE_NAMES);
    // MAX(EXTRACT(...)) gives the oldest waiting job per (queue, state) so a
    // queue that's draining quickly (low age) is distinguishable from one
    // that's stuck (high age) even at identical depth.
    const rows = await prisma.$queryRaw<Array<{ name: string; state: string; count: number; age_seconds: number | null }>>`
      SELECT name,
             state,
             count(*)::int AS count,
             EXTRACT(EPOCH FROM (now() - MIN(created_on)))::float8 AS age_seconds
      FROM pgboss.job
      WHERE name = ANY(${queueNames}::text[])
      AND state IN ('created', 'active', 'failed')
      GROUP BY name, state
    `;
    for (const name of queueNames) {
      setPgbossQueueJobs(name, "created", 0);
      setPgbossQueueJobs(name, "active", 0);
      setPgbossQueueJobs(name, "failed", 0);
      setPgbossJobAge(name, "created", 0);
      setPgbossJobAge(name, "active", 0);
    }
    const heavyQueues = new Set([QUEUE_NAMES.telemetry, QUEUE_NAMES.systemInfo]);
    for (const row of rows) {
      setPgbossQueueJobs(row.name, row.state, Number(row.count));
      // Only created/active have a meaningful "oldest job age." Failed jobs
      // sit until the 1h archive runs; their age isn't a backlog signal.
      if (row.state === "created" || row.state === "active") {
        const age = row.age_seconds != null ? Number(row.age_seconds) : 0;
        setPgbossJobAge(row.name, row.state, Number.isFinite(age) ? age : 0);
      }
      if (row.state === "created") {
        totalCreated += Number(row.count);
        if (heavyQueues.has(row.name)) heavyCreated += Number(row.count);
      }
      if (row.state === "active") {
        totalActive += Number(row.count);
        if (heavyQueues.has(row.name)) heavyActive += Number(row.count);
      }
    }
  } catch (err) {
    logger.debug({ err }, "pg-boss metrics refresh failed");
    return;
  }

  // Stalled-worker watchdog. Two independent stall conditions:
  //   (a) all queues — probe workers also stalled (totalActive === 0)
  //   (b) heavy queues only — telemetry/systemInfo stalled while probe runs fine
  // Check (b) catches the partial-stall case where probe workers are active
  // but heavy workers have stopped, which makes totalActive > 0 so (a) never
  // fires despite the backlog.
  const isStalled =
    (totalCreated > STALL_CREATED_THRESHOLD && totalActive === 0) ||
    (heavyCreated > STALL_CREATED_THRESHOLD && heavyActive === 0);

  if (isStalled) {
    stalledReadings++;
    if (stalledReadings >= STALL_CONSECUTIVE_LIMIT) {
      const now = Date.now();
      recoveryAttempts = recoveryAttempts.filter(t => now - t < STALL_RECOVERY_WINDOW_MS);
      if (recoveryAttempts.length < STALL_MAX_RECOVERIES) {
        recoveryAttempts.push(now);
        stalledReadings = 0;
        void attemptWorkerRecovery();
      } else if (stalledReadings % STALL_CONSECUTIVE_LIMIT === 0) {
        // Recovery cap hit — keep logging so the operator sees it
        logger.error(
          { totalCreated, heavyCreated, heavyActive, recoveryAttempts: recoveryAttempts.length },
          "pg-boss workers stalled and auto-recovery cap reached — run: systemctl restart polaris",
        );
      }
    }
  } else {
    stalledReadings = 0;
  }
}

function resolveEnvInt(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Default worker counts when pg-boss is the active queue. Sized for the
 * "you flipped this on because the cursor queue can't keep up" case, not
 * the small-fleet case (small fleets stay on cursor). Operators can override
 * via env var when benchmarking warrants — particularly on hosts with many
 * cores or DBs with high `max_connections`.
 *
 * The four cadences default to the same `max(16, min(64, cpus().length × 4))`
 * — enough headroom that an 8-core box gets 32 workers per queue, and bigger
 * hosts cap at 64 so the combined Polaris connection pool stays well below
 * a default Postgres `max_connections=100`. The work is I/O-bound across the
 * board (one or more SNMP / REST round-trips per job, no heavy CPU) so each
 * worker spends ~95% of its time blocked on the network — fewer workers
 * leaves cores idle. Earlier defaults of `max(8, N×2)` were overcautious
 * for I/O-bound work; the cap protects boxes with many cores from running
 * the connection pool dry.
 *
 *   POLARIS_MONITOR_PROBE_WORKERS    localConcurrency for probe queue        (default max(16, min(64, N×4)))
 *   POLARIS_MONITOR_FAST_WORKERS     localConcurrency for fastFiltered queue (default max(16, min(64, N×4)))
 *   POLARIS_MONITOR_HEAVY_WORKERS    localConcurrency for telemetry + systemInfo queues (default max(16, min(64, N×4)) each)
 */
function workerSize(envName: string, fallback: number): number {
  return resolveEnvInt(envName, fallback);
}

/**
 * Boot pg-boss and register the four monitor cadence queues. No-op when
 * the boot-time mode is "cursor". Idempotent — repeated calls are absorbed.
 *
 * Workers call back into the same `runFooFor()` functions the cursor pass
 * uses, so per-asset side effects (Asset.update, sample inserts, metrics)
 * are identical between modes — the only thing that differs is who's
 * holding the work queue.
 *
 * Job retention windows match what we'd want for monitor-grade work:
 *   - completed jobs archive after 1h (Polaris already records every probe
 *     outcome in AssetMonitorSample; pg-boss's job row is just queue
 *     bookkeeping, not the source of truth)
 *   - failed jobs archive after 1h (same — failures replicate to monitor
 *     samples and Events; pg-boss's failure rows are debugging breadcrumbs)
 *   - archive deletes after 7 days (covers a "what happened last week"
 *     forensic window without bloating pg-boss's tables)
 */
export async function startPgbossWorkers(): Promise<void> {
  if (bossInstance) return;
  if (getBootTimeMode() !== "pgboss") return;
  if (!isPgbossInstalled()) {
    logger.warn("pg-boss queue mode requested but package not installed; staying on cursor");
    return;
  }
  if (!process.env.DATABASE_URL) {
    logger.warn("pg-boss requested but DATABASE_URL is unset; staying on cursor");
    return;
  }

  const { PgBoss } = await import("pg-boss");
  // pg-boss manages its own pg.Pool separate from Prisma's adapter pool.
  // Default 20 — sized for the bumped worker defaults below (max 64 per
  // queue on bigger boxes); operators on small pg-boss fleets can drop it
  // back via env var. Expose as POLARIS_PGBOSS_POOL_SIZE so operators can
  // size it alongside DATABASE_POOL_SIZE.
  const pgbossPoolSize = resolveEnvInt("POLARIS_PGBOSS_POOL_SIZE", 20);
  const boss: PgBossType = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    max: pgbossPoolSize,
  });

  boss.on("error", (err: Error) => {
    logger.error({ err }, "pg-boss error");
  });

  await boss.start();

  // Per-queue config:
  //   - policy "singleton" + singletonKey on every send → only one job
  //     per (assetId, cadence) can be queued or active. Duplicate submits
  //     while a job is in flight are absorbed silently. Natural coalescing
  //     for the publisher's "re-evaluate every tick" pattern. Different
  //     assetIds run fully in parallel up to localConcurrency. (Earlier
  //     iterations passed "exclusive" here, which is not a documented
  //     pg-boss policy and silently throttled each queue to ~1 active job
  //     globally regardless of localConcurrency.)
  //   - retryLimit 0: monitor cadences are stateless. Next tick re-evaluates
  //     due state and re-publishes; better than retrying with stale snapshot.
  //   - deleteAfterSeconds 1d: keep recent completed/failed for debugging,
  //     then drop. The real audit trail lives in AssetMonitorSample / Events.
  //   - retentionSeconds 1h: bounds queued/retry backlog so a stuck queue
  //     can't bloat unbounded.
  //   - expireInSeconds 60: jobs that didn't get picked up in 60s die so
  //     they don't pile up across worker restarts.
  for (const name of Object.values(QUEUE_NAMES)) {
    await boss.createQueue(name, {
      policy: "singleton",
      retryLimit: 0,
      deleteAfterSeconds: 86_400,
      retentionSeconds: 3_600,
      expireInSeconds: 60,
    });
  }

  // pg-boss v12 renamed the concurrency knobs. `localConcurrency` is the
  // total number of jobs this node will process in parallel for the queue
  // (replaces v11's teamSize × teamConcurrency product). Defaults below are
  // sized for "operator deliberately switched to pg-boss because cursor
  // can't keep up" — small fleets stay on cursor where these don't apply.
  const defaultWorkers = Math.max(16, Math.min(64, cpus().length * 4));
  const probeWorkers = workerSize("POLARIS_MONITOR_PROBE_WORKERS", defaultWorkers);
  const fastWorkers  = workerSize("POLARIS_MONITOR_FAST_WORKERS",  defaultWorkers);
  const heavyWorkers = workerSize("POLARIS_MONITOR_HEAVY_WORKERS", defaultWorkers);
  setMonitorWorkers({
    probe:        probeWorkers,
    fastFiltered: fastWorkers,
    telemetry:    heavyWorkers,
    systemInfo:   heavyWorkers,
  });
  logger.info(
    {
      probeWorkers, fastWorkers, heavyWorkers, cores: cpus().length,
    },
    "pg-boss workers configured",
  );

  await boss.work<MonitorJobPayload>(QUEUE_NAMES.probe, {
    localConcurrency: probeWorkers, batchSize: 1, pollingIntervalSeconds: 1,
  }, async (jobs: PgBossJob<MonitorJobPayload>[]) => {
    const job = jobs[0];
    await runProbeFor(job.data.assetId, job.data.transport ?? "unknown");
  });

  await boss.work<MonitorJobPayload>(QUEUE_NAMES.fastFiltered, {
    localConcurrency: fastWorkers, batchSize: 1, pollingIntervalSeconds: 2,
  }, async (jobs: PgBossJob<MonitorJobPayload>[]) => {
    await runFastFilteredFor(jobs[0].data.assetId);
  });

  await boss.work<MonitorJobPayload>(QUEUE_NAMES.telemetry, {
    localConcurrency: heavyWorkers, batchSize: 1, pollingIntervalSeconds: 5,
  }, async (jobs: PgBossJob<MonitorJobPayload>[]) => {
    await runTelemetryFor(jobs[0].data.assetId);
  });

  await boss.work<MonitorJobPayload>(QUEUE_NAMES.systemInfo, {
    localConcurrency: heavyWorkers, batchSize: 1, pollingIntervalSeconds: 5,
  }, async (jobs: PgBossJob<MonitorJobPayload>[]) => {
    await runSystemInfoFor(jobs[0].data.assetId);
  });

  bossInstance = boss;
  void refreshPgbossMetrics();
  metricsRefreshInterval = setInterval(() => { void refreshPgbossMetrics(); }, 15_000);
  logger.info(
    { probeWorkers, fastWorkers, heavyWorkers },
    "pg-boss queue workers started",
  );
}

/**
 * Submit a monitor job. No-op when pg-boss isn't running (e.g. process is on
 * cursor mode, or pg-boss hasn't started yet). The `singletonKey` makes the
 * submission a coalescing operation — a duplicate for the same (assetId,
 * cadence) is silently absorbed while a prior job is queued or running, so
 * the publisher can re-evaluate due assets every tick without piling up
 * stale jobs.
 *
 * `retryLimit: 0` is deliberate: monitor cadences are stateless and the
 * next tick will re-evaluate due state anyway — better to drop a failed
 * job and pick the asset up fresh than retry against a probably-still-down
 * host with a stale snapshot. `expireInSeconds: 60` cleans up jobs that
 * never got picked up (e.g. workers were restarting) so the queue doesn't
 * accumulate dead weight.
 */
export async function publishMonitorJob(
  cadence: MonitorCadence,
  assetId: string,
  transport?: string,
): Promise<void> {
  if (!bossInstance) return;
  const queue = QUEUE_NAMES[cadence];
  await bossInstance.send(
    queue,
    { assetId, transport } as MonitorJobPayload,
    {
      singletonKey: `${assetId}:${cadence}`,
    },
  );
}

/**
 * Graceful stop. Drains in-flight jobs (up to a timeout) before resolving.
 * Called on process shutdown handlers; safe if pg-boss never started.
 */
export async function stopPgbossWorkers(): Promise<void> {
  if (!bossInstance) return;
  if (metricsRefreshInterval !== null) {
    clearInterval(metricsRefreshInterval);
    metricsRefreshInterval = null;
  }
  try {
    await bossInstance.stop({ graceful: true, timeout: 30_000 });
  } catch (err) {
    logger.warn({ err }, "pg-boss stop failed");
  }
  bossInstance = null;
}

export function isPgbossRunning(): boolean {
  return bossInstance !== null;
}
