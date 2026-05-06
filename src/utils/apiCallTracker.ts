/**
 * src/utils/apiCallTracker.ts — per-integration outbound API call counter
 *
 * Uses AsyncLocalStorage so the integration context propagates through the
 * call stack without touching low-level function signatures. Call sites
 * (monitoringService workers, triggerDiscovery IIFE) set the context via
 * withIntegrationCtx(); rpc() and fgRequest() read it to increment/decrement
 * the counter. A setInterval sampler snapshots the live counters every 5 s
 * into a ring buffer (720 entries = 1 hour) when tracking is enabled.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface IntegCtx { id: string; name: string }

export const _integCtx = new AsyncLocalStorage<IntegCtx>();

export function withIntegrationCtx<T>(id: string, name: string, fn: () => Promise<T>): Promise<T> {
  return _integCtx.run({ id, name }, fn);
}

// ---------- live counters ----------

const _active = new Map<string, { count: number; name: string }>();

export function trackCallStart(): void {
  if (!_enabled) return;
  const ctx = _integCtx.getStore();
  if (!ctx) return;
  const e = _active.get(ctx.id);
  if (e) e.count++;
  else _active.set(ctx.id, { count: 1, name: ctx.name });
}

export function trackCallEnd(): void {
  if (!_enabled) return;
  const ctx = _integCtx.getStore();
  if (!ctx) return;
  const e = _active.get(ctx.id);
  if (e) e.count = Math.max(0, e.count - 1);
}

// ---------- ring buffer ----------

const MAX_SAMPLES = 720; // 1 h at 5 s intervals

export interface TrackerSample {
  ts: number;
  counts: Record<string, number>; // integrationId → active call count
}

const _samples: TrackerSample[] = [];
const _names = new Map<string, string>(); // persistent id → name registry

function takeSample(): void {
  const counts: Record<string, number> = {};
  for (const [id, { count, name }] of _active) {
    counts[id] = count;
    _names.set(id, name);
  }
  _samples.push({ ts: Date.now(), counts });
  if (_samples.length > MAX_SAMPLES) _samples.shift();
}

// ---------- enable / disable ----------

let _enabled = false;
let _timer: ReturnType<typeof setInterval> | null = null;

export function setTrackerEnabled(on: boolean): void {
  _enabled = on;
  if (on && !_timer) {
    _timer = setInterval(takeSample, 5_000);
  } else if (!on && _timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

export function isTrackerEnabled(): boolean { return _enabled; }

export function getTrackerData(): {
  enabled: boolean;
  samples: TrackerSample[];
  names: Record<string, string>;
} {
  return {
    enabled: _enabled,
    samples: [..._samples],
    names: Object.fromEntries(_names),
  };
}
