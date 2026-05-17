/**
 * src/services/sampleHistoryService.ts
 *
 * Tier-aware readers for the six chart history endpoints. Phase 4 of the
 * tiered sample-retention work. Each function takes (assetId, since, until,
 * tier[, extraKey]) and returns serialised sample rows + stats matching
 * the existing response shape the chart renderers expect, with two
 * additions on rollup tiers:
 *
 *   - Gauge tables (monitor, telemetry, temperature, storage):
 *     samples keep the SAME field names the detail tier emits — e.g.
 *     `responseTimeMs`, `cpuPct`, `celsius`, `usedBytes`. On rollup tier
 *     those values are bucket averages instead of point measurements;
 *     `min*` / `max*` siblings + `sampleCount` are added so tooltips can
 *     show the bucket spread.
 *
 *   - Counter tables (interface, ipsec): rollup samples ADD pre-computed
 *     rate fields (`inBytesPerSec`, `outBytesPerSec`, ..., or
 *     `incomingBytesPerSec` / `outgoingBytesPerSec` for ipsec) computed
 *     from the bucket's first/last counter endpoints. Cumulative counter
 *     fields (`inOctets`, `incomingBytes`, ...) are intentionally OMITTED
 *     on rollup tiers — those values are only meaningful as deltas, and
 *     the rate is what the chart actually plots. The frontend branches
 *     on `bucketSeconds > 0` to read the rate fields directly instead of
 *     diffing consecutive cumulative samples (which is what detail tier
 *     still needs).
 *
 * BigInt → number coercion at the boundary, same as the existing
 * `bigIntToNumber()` helper in routes/assets.ts. Octets up to 2^53-1
 * (≈9 PB) fit safely.
 */

import { prisma } from "../db.js";
import type { SampleTier } from "./sampleQueryRouter.js";

function bn(v: bigint | null | undefined): number | null {
  if (v == null) return null;
  return Number(v);
}

/**
 * Counter-rate helper. `first` and `last` are cumulative counter values at
 * the boundaries of a bucket; `bucketStart` and `lastBucketSampleAt` give
 * the time delta. Returns null on missing endpoints or counter resets
 * (negative deltas), matching the detail-tier client-side diff behavior.
 */
function rate(first: number | null, last: number | null, bucketStartMs: number, lastSampleAtMs: number): number | null {
  if (first == null || last == null) return null;
  const delta = last - first;
  if (delta < 0) return null; // counter reset
  const seconds = (lastSampleAtMs - bucketStartMs) / 1000;
  if (seconds <= 0) return 0;
  return delta / seconds;
}

// ─── Monitor history (response time) ─────────────────────────────────────────

export interface MonitorHistoryRow {
  timestamp:      Date;
  success?:       boolean;   // detail only
  responseTimeMs: number | null;
  error?:         string | null;
  // Rollup-only:
  sampleCount?:       number;
  successCount?:      number;
  failureCount?:      number;
  minResponseTimeMs?: number | null;
  maxResponseTimeMs?: number | null;
}

export interface MonitorHistoryResult {
  samples: MonitorHistoryRow[];
  stats: {
    total: number;
    failed: number;
    successRate: number | null;
    packetLossRate: number | null;
    avgMs: number | null;
    minMs: number | null;
    maxMs: number | null;
  };
}

export async function readMonitorHistory(
  assetId: string,
  since: Date,
  until: Date,
  tier: SampleTier,
): Promise<MonitorHistoryResult> {
  if (tier === "detail") {
    const rows = await prisma.assetMonitorSample.findMany({
      where: { assetId, timestamp: { gte: since, lte: until } },
      orderBy: { timestamp: "asc" },
      select: { timestamp: true, success: true, responseTimeMs: true, error: true },
    });
    const total = rows.length;
    const failed = rows.filter((s) => !s.success).length;
    const ok = rows.filter((s) => s.success && typeof s.responseTimeMs === "number").map((s) => s.responseTimeMs as number);
    return {
      samples: rows,
      stats: {
        total,
        failed,
        successRate: total ? (total - failed) / total : null,
        packetLossRate: total ? failed / total : null,
        avgMs: ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null,
        minMs: ok.length ? Math.min(...ok) : null,
        maxMs: ok.length ? Math.max(...ok) : null,
      },
    };
  }

  const table = tier === "hourly" ? "asset_monitor_samples_hourly" : "asset_monitor_samples_daily";
  const rows = await prisma.$queryRawUnsafe<Array<{
    bucketStart: Date;
    sampleCount: number;
    successCount: number;
    failureCount: number;
    avgResponseTimeMs: number | null;
    minResponseTimeMs: number | null;
    maxResponseTimeMs: number | null;
  }>>(
    `SELECT "bucketStart", "sampleCount", "successCount", "failureCount",
            "avgResponseTimeMs", "minResponseTimeMs", "maxResponseTimeMs"
     FROM "${table}"
     WHERE "assetId" = $1 AND "bucketStart" >= $2 AND "bucketStart" <= $3
     ORDER BY "bucketStart" ASC`,
    assetId, since, until,
  );

  let total = 0, failed = 0;
  let weightedSum = 0, weightedCount = 0;
  let minMs: number | null = null, maxMs: number | null = null;
  for (const r of rows) {
    total += r.sampleCount;
    failed += r.failureCount;
    if (r.avgResponseTimeMs != null && r.successCount > 0) {
      weightedSum += r.avgResponseTimeMs * r.successCount;
      weightedCount += r.successCount;
    }
    if (r.minResponseTimeMs != null) minMs = minMs == null ? r.minResponseTimeMs : Math.min(minMs, r.minResponseTimeMs);
    if (r.maxResponseTimeMs != null) maxMs = maxMs == null ? r.maxResponseTimeMs : Math.max(maxMs, r.maxResponseTimeMs);
  }
  return {
    samples: rows.map((r) => ({
      timestamp:         r.bucketStart,
      responseTimeMs:    r.avgResponseTimeMs,
      sampleCount:       r.sampleCount,
      successCount:      r.successCount,
      failureCount:      r.failureCount,
      minResponseTimeMs: r.minResponseTimeMs,
      maxResponseTimeMs: r.maxResponseTimeMs,
    })),
    stats: {
      total,
      failed,
      successRate: total ? (total - failed) / total : null,
      packetLossRate: total ? failed / total : null,
      avgMs: weightedCount ? Math.round(weightedSum / weightedCount) : null,
      minMs,
      maxMs,
    },
  };
}

// ─── Telemetry history (CPU + memory) ────────────────────────────────────────

export interface TelemetryHistoryRow {
  timestamp:        Date;
  cpuPct:           number | null;
  memPct:           number | null;
  memUsedBytes:     number | null;
  memTotalBytes:    number | null;
  sampleCount?:     number;
  minCpuPct?:       number | null;
  maxCpuPct?:       number | null;
  minMemPct?:       number | null;
  maxMemPct?:       number | null;
}

export interface TelemetryHistoryResult {
  samples: TelemetryHistoryRow[];
  stats: {
    total: number;
    avgCpuPct: number | null;
    maxCpuPct: number | null;
    avgMemPct: number | null;
    maxMemPct: number | null;
  };
}

export async function readTelemetryHistory(
  assetId: string,
  since: Date,
  until: Date,
  tier: SampleTier,
): Promise<TelemetryHistoryResult> {
  if (tier === "detail") {
    const samples = await prisma.assetTelemetrySample.findMany({
      where: { assetId, timestamp: { gte: since, lte: until } },
      orderBy: { timestamp: "asc" },
      select: { timestamp: true, cpuPct: true, memPct: true, memUsedBytes: true, memTotalBytes: true },
    });
    const rows: TelemetryHistoryRow[] = samples.map((s) => ({
      timestamp:     s.timestamp,
      cpuPct:        s.cpuPct,
      memPct:        s.memPct,
      memUsedBytes:  bn(s.memUsedBytes),
      memTotalBytes: bn(s.memTotalBytes),
    }));
    const cpus = rows.map((r) => r.cpuPct).filter((x): x is number => typeof x === "number");
    const mems = rows.map((r) => r.memPct ?? (r.memTotalBytes && r.memUsedBytes ? (r.memUsedBytes / r.memTotalBytes) * 100 : null))
                     .filter((x): x is number => typeof x === "number");
    return {
      samples: rows,
      stats: {
        total:     rows.length,
        avgCpuPct: cpus.length ? cpus.reduce((a, b) => a + b, 0) / cpus.length : null,
        maxCpuPct: cpus.length ? Math.max(...cpus) : null,
        avgMemPct: mems.length ? mems.reduce((a, b) => a + b, 0) / mems.length : null,
        maxMemPct: mems.length ? Math.max(...mems) : null,
      },
    };
  }

  const table = tier === "hourly" ? "asset_telemetry_samples_hourly" : "asset_telemetry_samples_daily";
  const rows = await prisma.$queryRawUnsafe<Array<{
    bucketStart: Date;
    sampleCount: number;
    avgCpuPct: number | null; minCpuPct: number | null; maxCpuPct: number | null;
    avgMemPct: number | null; minMemPct: number | null; maxMemPct: number | null;
    avgMemUsedBytes: bigint | null;
    maxMemUsedBytes: bigint | null;
    lastMemTotalBytes: bigint | null;
  }>>(
    `SELECT "bucketStart", "sampleCount",
            "avgCpuPct", "minCpuPct", "maxCpuPct",
            "avgMemPct", "minMemPct", "maxMemPct",
            "avgMemUsedBytes", "maxMemUsedBytes", "lastMemTotalBytes"
     FROM "${table}"
     WHERE "assetId" = $1 AND "bucketStart" >= $2 AND "bucketStart" <= $3
     ORDER BY "bucketStart" ASC`,
    assetId, since, until,
  );

  let total = 0;
  let cpuWeightedSum = 0, cpuWeightedCount = 0, cpuMax: number | null = null;
  let memWeightedSum = 0, memWeightedCount = 0, memMax: number | null = null;
  const out: TelemetryHistoryRow[] = rows.map((r) => {
    total += r.sampleCount;
    if (r.avgCpuPct != null) { cpuWeightedSum += r.avgCpuPct * r.sampleCount; cpuWeightedCount += r.sampleCount; }
    if (r.maxCpuPct != null) cpuMax = cpuMax == null ? r.maxCpuPct : Math.max(cpuMax, r.maxCpuPct);
    if (r.avgMemPct != null) { memWeightedSum += r.avgMemPct * r.sampleCount; memWeightedCount += r.sampleCount; }
    if (r.maxMemPct != null) memMax = memMax == null ? r.maxMemPct : Math.max(memMax, r.maxMemPct);
    return {
      timestamp:     r.bucketStart,
      cpuPct:        r.avgCpuPct,
      memPct:        r.avgMemPct,
      memUsedBytes:  bn(r.avgMemUsedBytes),
      memTotalBytes: bn(r.lastMemTotalBytes),
      sampleCount:   r.sampleCount,
      minCpuPct:     r.minCpuPct,
      maxCpuPct:     r.maxCpuPct,
      minMemPct:     r.minMemPct,
      maxMemPct:     r.maxMemPct,
    };
  });
  return {
    samples: out,
    stats: {
      total,
      avgCpuPct: cpuWeightedCount ? cpuWeightedSum / cpuWeightedCount : null,
      maxCpuPct: cpuMax,
      avgMemPct: memWeightedCount ? memWeightedSum / memWeightedCount : null,
      maxMemPct: memMax,
    },
  };
}

// ─── Temperature history (per sensor) ────────────────────────────────────────

export interface TemperatureHistoryRow {
  timestamp:   Date;
  sensorName:  string;
  celsius:     number | null;
  sampleCount?: number;
  minCelsius?:  number | null;
  maxCelsius?:  number | null;
}

export interface TemperatureHistoryResult {
  samples: TemperatureHistoryRow[];
  stats: {
    total: number;
    avgCelsius: number | null;
    minCelsius: number | null;
    maxCelsius: number | null;
  };
}

export async function readTemperatureHistory(
  assetId: string,
  since: Date,
  until: Date,
  tier: SampleTier,
  sensorName: string | null,
): Promise<TemperatureHistoryResult> {
  if (tier === "detail") {
    const samples = await prisma.assetTemperatureSample.findMany({
      where: { assetId, timestamp: { gte: since, lte: until }, ...(sensorName ? { sensorName } : {}) },
      orderBy: { timestamp: "asc" },
    });
    const rows: TemperatureHistoryRow[] = samples.map((s) => ({
      timestamp:  s.timestamp,
      sensorName: s.sensorName,
      celsius:    s.celsius,
    }));
    const cs = rows.map((r) => r.celsius).filter((x): x is number => typeof x === "number");
    return {
      samples: rows,
      stats: {
        total:      rows.length,
        avgCelsius: cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : null,
        minCelsius: cs.length ? Math.min(...cs) : null,
        maxCelsius: cs.length ? Math.max(...cs) : null,
      },
    };
  }

  const table = tier === "hourly" ? "asset_temperature_samples_hourly" : "asset_temperature_samples_daily";
  const params: unknown[] = [assetId, since, until];
  let where = `"assetId" = $1 AND "bucketStart" >= $2 AND "bucketStart" <= $3`;
  if (sensorName) {
    params.push(sensorName);
    where += ` AND "sensorName" = $4`;
  }
  const rows = await prisma.$queryRawUnsafe<Array<{
    bucketStart: Date;
    sensorName: string;
    sampleCount: number;
    avgCelsius: number | null;
    minCelsius: number | null;
    maxCelsius: number | null;
  }>>(
    `SELECT "bucketStart", "sensorName", "sampleCount", "avgCelsius", "minCelsius", "maxCelsius"
     FROM "${table}"
     WHERE ${where}
     ORDER BY "bucketStart" ASC`,
    ...params,
  );

  let total = 0;
  let weightedSum = 0, weightedCount = 0;
  let cmin: number | null = null, cmax: number | null = null;
  const out: TemperatureHistoryRow[] = rows.map((r) => {
    total += r.sampleCount;
    if (r.avgCelsius != null) { weightedSum += r.avgCelsius * r.sampleCount; weightedCount += r.sampleCount; }
    if (r.minCelsius != null) cmin = cmin == null ? r.minCelsius : Math.min(cmin, r.minCelsius);
    if (r.maxCelsius != null) cmax = cmax == null ? r.maxCelsius : Math.max(cmax, r.maxCelsius);
    return {
      timestamp:   r.bucketStart,
      sensorName:  r.sensorName,
      celsius:     r.avgCelsius,
      sampleCount: r.sampleCount,
      minCelsius:  r.minCelsius,
      maxCelsius:  r.maxCelsius,
    };
  });
  return {
    samples: out,
    stats: {
      total,
      avgCelsius: weightedCount ? weightedSum / weightedCount : null,
      minCelsius: cmin,
      maxCelsius: cmax,
    },
  };
}

// ─── Storage history (per mountpoint) ────────────────────────────────────────

export interface StorageHistoryRow {
  timestamp:  Date;
  totalBytes: number | null;
  usedBytes:  number | null;
  sampleCount?:  number;
  minUsedBytes?: number | null;
  maxUsedBytes?: number | null;
}

export async function readStorageHistory(
  assetId: string,
  since: Date,
  until: Date,
  tier: SampleTier,
  mountPath: string,
): Promise<{ samples: StorageHistoryRow[] }> {
  if (tier === "detail") {
    const samples = await prisma.assetStorageSample.findMany({
      where: { assetId, mountPath, timestamp: { gte: since, lte: until } },
      orderBy: { timestamp: "asc" },
    });
    return {
      samples: samples.map((s) => ({
        timestamp:  s.timestamp,
        totalBytes: bn(s.totalBytes),
        usedBytes:  bn(s.usedBytes),
      })),
    };
  }

  const table = tier === "hourly" ? "asset_storage_samples_hourly" : "asset_storage_samples_daily";
  const rows = await prisma.$queryRawUnsafe<Array<{
    bucketStart: Date;
    sampleCount: number;
    avgUsedBytes: bigint | null;
    minUsedBytes: bigint | null;
    maxUsedBytes: bigint | null;
    lastTotalBytes: bigint | null;
  }>>(
    `SELECT "bucketStart", "sampleCount", "avgUsedBytes", "minUsedBytes", "maxUsedBytes", "lastTotalBytes"
     FROM "${table}"
     WHERE "assetId" = $1 AND "mountPath" = $2 AND "bucketStart" >= $3 AND "bucketStart" <= $4
     ORDER BY "bucketStart" ASC`,
    assetId, mountPath, since, until,
  );
  return {
    samples: rows.map((r) => ({
      timestamp:    r.bucketStart,
      totalBytes:   bn(r.lastTotalBytes),
      usedBytes:    bn(r.avgUsedBytes),
      sampleCount:  r.sampleCount,
      minUsedBytes: bn(r.minUsedBytes),
      maxUsedBytes: bn(r.maxUsedBytes),
    })),
  };
}

// ─── Interface history (counter table) ───────────────────────────────────────

export interface InterfaceHistoryRow {
  timestamp:   Date;
  adminStatus: string | null;
  operStatus:  string | null;
  speedBps:    number | null;
  ipAddress:   string | null;
  macAddress:  string | null;
  // Detail-tier counter values (cumulative). Omitted on rollup tier.
  inOctets?:   number | null;
  outOctets?:  number | null;
  inErrors?:   number | null;
  outErrors?:  number | null;
  // Rollup-tier pre-computed rates (bytes/sec, errors/sec). Omitted on detail.
  inBytesPerSec?:  number | null;
  outBytesPerSec?: number | null;
  inErrorsPerSec?:  number | null;
  outErrorsPerSec?: number | null;
  sampleCount?:    number;
}

export interface InterfaceHistoryMeta {
  alias:                  string | null;
  description:            string | null;
  discoveredDescription:  string | null;
  overrideDescription:    string | null;
}

export async function readInterfaceHistory(
  assetId: string,
  since: Date,
  until: Date,
  tier: SampleTier,
  ifName: string,
): Promise<{ samples: InterfaceHistoryRow[]; meta: InterfaceHistoryMeta }> {
  if (tier === "detail") {
    const samples = await prisma.assetInterfaceSample.findMany({
      where: { assetId, ifName, timestamp: { gte: since, lte: until } },
      orderBy: { timestamp: "asc" },
    });
    const latest = samples.length > 0 ? samples[samples.length - 1] : null;
    return {
      samples: samples.map((s) => ({
        timestamp:   s.timestamp,
        adminStatus: s.adminStatus,
        operStatus:  s.operStatus,
        speedBps:    bn(s.speedBps),
        ipAddress:   s.ipAddress,
        macAddress:  s.macAddress,
        inOctets:    bn(s.inOctets),
        outOctets:   bn(s.outOctets),
        inErrors:    bn(s.inErrors),
        outErrors:   bn(s.outErrors),
      })),
      meta: {
        alias:                 latest?.alias       ?? null,
        description:           null, // resolved by caller with override merge
        discoveredDescription: latest?.description ?? null,
        overrideDescription:   null,
      },
    };
  }

  const table = tier === "hourly" ? "asset_interface_samples_hourly" : "asset_interface_samples_daily";
  const rows = await prisma.$queryRawUnsafe<Array<{
    bucketStart: Date;
    sampleCount: number;
    firstInOctets: bigint | null; lastInOctets: bigint | null;
    firstOutOctets: bigint | null; lastOutOctets: bigint | null;
    firstInErrors: bigint | null; lastInErrors: bigint | null;
    firstOutErrors: bigint | null; lastOutErrors: bigint | null;
    maxSpeedBps: bigint | null;
    lastAdminStatus: string | null;
    lastOperStatus: string | null;
    lastIpAddress: string | null;
    lastMacAddress: string | null;
    lastAlias: string | null;
    lastDescription: string | null;
    lastBucketSampleAt: Date;
  }>>(
    `SELECT "bucketStart", "sampleCount",
            "firstInOctets", "lastInOctets",
            "firstOutOctets", "lastOutOctets",
            "firstInErrors", "lastInErrors",
            "firstOutErrors", "lastOutErrors",
            "maxSpeedBps",
            "lastAdminStatus", "lastOperStatus",
            "lastIpAddress", "lastMacAddress",
            "lastAlias", "lastDescription",
            "lastBucketSampleAt"
     FROM "${table}"
     WHERE "assetId" = $1 AND "ifName" = $2 AND "bucketStart" >= $3 AND "bucketStart" <= $4
     ORDER BY "bucketStart" ASC`,
    assetId, ifName, since, until,
  );

  let latestAlias: string | null = null;
  let latestDesc:  string | null = null;
  const samples: InterfaceHistoryRow[] = rows.map((r) => {
    if (r.lastAlias       != null) latestAlias = r.lastAlias;
    if (r.lastDescription != null) latestDesc  = r.lastDescription;
    const startMs = r.bucketStart.getTime();
    const lastMs  = r.lastBucketSampleAt.getTime();
    return {
      timestamp:       r.bucketStart,
      adminStatus:     r.lastAdminStatus,
      operStatus:      r.lastOperStatus,
      speedBps:        bn(r.maxSpeedBps),
      ipAddress:       r.lastIpAddress,
      macAddress:      r.lastMacAddress,
      inBytesPerSec:   rate(bn(r.firstInOctets),  bn(r.lastInOctets),  startMs, lastMs),
      outBytesPerSec:  rate(bn(r.firstOutOctets), bn(r.lastOutOctets), startMs, lastMs),
      inErrorsPerSec:  rate(bn(r.firstInErrors),  bn(r.lastInErrors),  startMs, lastMs),
      outErrorsPerSec: rate(bn(r.firstOutErrors), bn(r.lastOutErrors), startMs, lastMs),
      sampleCount:     r.sampleCount,
    };
  });
  return {
    samples,
    meta: {
      alias:                 latestAlias,
      description:           null,
      discoveredDescription: latestDesc,
      overrideDescription:   null,
    },
  };
}

// ─── IPsec history (counter table + status) ──────────────────────────────────

export interface IpsecHistoryRow {
  timestamp:     Date;
  status:        string; // "up" | "down" | "partial" | "dynamic" (detail value or dominant in bucket)
  remoteGateway: string | null;
  // Detail-only cumulative bytes:
  incomingBytes?: number | null;
  outgoingBytes?: number | null;
  // Rollup-only pre-computed rates + status counts:
  incomingBytesPerSec?: number | null;
  outgoingBytesPerSec?: number | null;
  statusUpCount?:      number;
  statusDownCount?:    number;
  statusPartialCount?: number;
  statusDynamicCount?: number;
  proxyIdCount:    number | null;
  sampleCount?:    number;
}

function dominantStatus(up: number, down: number, partial: number, dynamic: number): string {
  // Pick whichever status saw the most samples in the bucket. Ties go to
  // the worse status: down > partial > dynamic > up, so a flapping tunnel
  // never looks healthier than its worst observed state.
  const ranked: Array<[string, number]> = [
    ["down", down], ["partial", partial], ["dynamic", dynamic], ["up", up],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  return ranked[0][0];
}

export async function readIpsecHistory(
  assetId: string,
  since: Date,
  until: Date,
  tier: SampleTier,
  tunnelName: string,
): Promise<{ samples: IpsecHistoryRow[] }> {
  if (tier === "detail") {
    const samples = await prisma.assetIpsecTunnelSample.findMany({
      where: { assetId, tunnelName, timestamp: { gte: since, lte: until } },
      orderBy: { timestamp: "asc" },
    });
    return {
      samples: samples.map((s) => ({
        timestamp:     s.timestamp,
        status:        s.status,
        remoteGateway: s.remoteGateway,
        incomingBytes: bn(s.incomingBytes),
        outgoingBytes: bn(s.outgoingBytes),
        proxyIdCount:  s.proxyIdCount,
      })),
    };
  }

  const table = tier === "hourly" ? "asset_ipsec_tunnel_samples_hourly" : "asset_ipsec_tunnel_samples_daily";
  const rows = await prisma.$queryRawUnsafe<Array<{
    bucketStart: Date;
    sampleCount: number;
    statusUpCount: number; statusDownCount: number; statusPartialCount: number; statusDynamicCount: number;
    firstIncomingBytes: bigint | null; lastIncomingBytes: bigint | null;
    firstOutgoingBytes: bigint | null; lastOutgoingBytes: bigint | null;
    lastRemoteGateway: string | null;
    lastProxyIdCount: number | null;
    lastBucketSampleAt: Date;
  }>>(
    `SELECT "bucketStart", "sampleCount",
            "statusUpCount", "statusDownCount", "statusPartialCount", "statusDynamicCount",
            "firstIncomingBytes", "lastIncomingBytes",
            "firstOutgoingBytes", "lastOutgoingBytes",
            "lastRemoteGateway",
            "lastProxyIdCount",
            "lastBucketSampleAt"
     FROM "${table}"
     WHERE "assetId" = $1 AND "tunnelName" = $2 AND "bucketStart" >= $3 AND "bucketStart" <= $4
     ORDER BY "bucketStart" ASC`,
    assetId, tunnelName, since, until,
  );

  return {
    samples: rows.map((r) => {
      const startMs = r.bucketStart.getTime();
      const lastMs  = r.lastBucketSampleAt.getTime();
      return {
        timestamp:           r.bucketStart,
        status:              dominantStatus(r.statusUpCount, r.statusDownCount, r.statusPartialCount, r.statusDynamicCount),
        remoteGateway:       r.lastRemoteGateway,
        incomingBytesPerSec: rate(bn(r.firstIncomingBytes), bn(r.lastIncomingBytes), startMs, lastMs),
        outgoingBytesPerSec: rate(bn(r.firstOutgoingBytes), bn(r.lastOutgoingBytes), startMs, lastMs),
        statusUpCount:       r.statusUpCount,
        statusDownCount:     r.statusDownCount,
        statusPartialCount:  r.statusPartialCount,
        statusDynamicCount:  r.statusDynamicCount,
        proxyIdCount:        r.lastProxyIdCount,
        sampleCount:         r.sampleCount,
      };
    }),
  };
}
