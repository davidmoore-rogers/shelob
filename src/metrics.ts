/**
 * src/metrics.ts — Prometheus metrics registry + helpers
 *
 * Exposes a single Registry and a small surface of typed helper functions
 * so callers don't need to import metric objects directly. Default Node.js
 * process / event-loop metrics are registered here with no prefix so the
 * standard Node.js Grafana dashboards work without modification; everything
 * Polaris-specific is prefixed `polaris_`.
 *
 * Endpoint: GET /metrics on the main HTTP listener (mounted in `src/app.ts`).
 * Optional Bearer-token gate via the METRICS_TOKEN env var; when unset the
 * endpoint is open (mirroring the /health convention).
 */

import { Registry, collectDefaultMetrics, Histogram, Counter, Gauge } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

// ─── Polaris-specific metrics ──────────────────────────────────────────────

const monitorPassDuration = new Histogram({
  name: "polaris_monitor_pass_duration_seconds",
  help: "Wall-clock duration of one runMonitorPass call.",
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300, 600, 900],
  registers: [registry],
});

const monitorWorkDuration = new Histogram({
  name: "polaris_monitor_work_duration_seconds",
  help: "Wall-clock duration of a single monitor work item, by cadence.",
  labelNames: ["cadence"] as const,
  buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

const monitorWorkTotal = new Counter({
  name: "polaris_monitor_work_total",
  help: "Number of monitor work items processed, by cadence and outcome.",
  labelNames: ["cadence", "outcome"] as const,
  registers: [registry],
});

const monitorQueueDepth = new Gauge({
  name: "polaris_monitor_queue_depth",
  help: "Queued monitor work items at the start of the pass, by cadence (cursor mode only).",
  labelNames: ["cadence"] as const,
  registers: [registry],
});

const probeDuration = new Histogram({
  name: "polaris_probe_duration_seconds",
  help: "Per-probe wall-clock duration, by transport.",
  labelNames: ["transport"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15],
  registers: [registry],
});

const probeTotal = new Counter({
  name: "polaris_probe_total",
  help: "Number of probes by transport and outcome.",
  labelNames: ["transport", "outcome"] as const,
  registers: [registry],
});

const monitoredAssets = new Gauge({
  name: "polaris_monitored_assets",
  help: "Number of assets with monitored=true.",
  registers: [registry],
});

const monitoredAssetsByStatus = new Gauge({
  name: "polaris_monitored_assets_by_status",
  help: "Monitored assets grouped by current monitorStatus.",
  labelNames: ["status"] as const,
  registers: [registry],
});

const pgbossQueueJobs = new Gauge({
  name: "polaris_pgboss_queue_jobs",
  help: "pg-boss job counts by queue and state (pg-boss mode only).",
  labelNames: ["queue", "state"] as const,
  registers: [registry],
});

const monitorQueueModeGauge = new Gauge({
  name: "polaris_monitor_queue_mode",
  help: "Active monitor queue mode at boot (1 = this mode is running). Labels: mode=cursor|pgboss.",
  labelNames: ["mode"] as const,
  registers: [registry],
});

const monitorWorkers = new Gauge({
  name: "polaris_monitor_workers",
  help: "Configured worker count by cadence queue. Set once at boot from cpus().length + env-var overrides; static for the life of the process. In pg-boss mode this is each queue's localConcurrency. In cursor mode probe/fastFiltered map to the light-loop concurrency cap and telemetry/systemInfo map to the heavy-loop cap.",
  labelNames: ["queue"] as const,
  registers: [registry],
});

// ─── Helpers ───────────────────────────────────────────────────────────────

export type Cadence = "probe" | "telemetry" | "systemInfo" | "fastFiltered";
export type WorkOutcome = "success" | "failure" | "crash";
export type ProbeOutcome = "success" | "failure";

export function startPassTimer(): () => number {
  return monitorPassDuration.startTimer();
}

export function startWorkTimer(cadence: Cadence): () => number {
  return monitorWorkDuration.startTimer({ cadence });
}

export function recordWorkOutcome(cadence: Cadence, outcome: WorkOutcome): void {
  monitorWorkTotal.inc({ cadence, outcome });
}

export function recordProbe(transport: string, durationSeconds: number, outcome: ProbeOutcome): void {
  probeDuration.observe({ transport }, durationSeconds);
  probeTotal.inc({ transport, outcome });
}

export function setMonitoredAssets(
  total: number,
  byStatus: { up: number; down: number; unknown: number },
): void {
  monitoredAssets.set(total);
  monitoredAssetsByStatus.set({ status: "up" }, byStatus.up);
  monitoredAssetsByStatus.set({ status: "down" }, byStatus.down);
  monitoredAssetsByStatus.set({ status: "unknown" }, byStatus.unknown);
}

export function setQueueDepth(depths: Record<Cadence, number>): void {
  monitorQueueDepth.set({ cadence: "probe" }, depths.probe);
  monitorQueueDepth.set({ cadence: "fastFiltered" }, depths.fastFiltered);
  monitorQueueDepth.set({ cadence: "telemetry" }, depths.telemetry);
  monitorQueueDepth.set({ cadence: "systemInfo" }, depths.systemInfo);
}

export function setPgbossQueueJobs(queue: string, state: string, count: number): void {
  pgbossQueueJobs.set({ queue, state }, count);
}

export function recordQueueMode(mode: string): void {
  monitorQueueModeGauge.set({ mode }, 1);
}

export function setMonitorWorkers(counts: Record<Cadence, number>): void {
  monitorWorkers.set({ queue: "probe" },        counts.probe);
  monitorWorkers.set({ queue: "fastFiltered" }, counts.fastFiltered);
  monitorWorkers.set({ queue: "telemetry" },    counts.telemetry);
  monitorWorkers.set({ queue: "systemInfo" },   counts.systemInfo);
}

export async function renderMetrics(): Promise<{ contentType: string; body: string }> {
  return { contentType: registry.contentType, body: await registry.metrics() };
}
