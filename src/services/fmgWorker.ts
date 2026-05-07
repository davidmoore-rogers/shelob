/**
 * src/services/fmgWorker.ts — Per-integration single-consumer FortiManager worker.
 *
 * FortiManager drops parallel API connections past 1-2 concurrent requests for
 * the same API user (the "FMG concurrency limit" — see project memo). Every
 * code path in Polaris that talks to FMG must funnel through one of these
 * workers so that constraint is enforced by construction instead of by
 * convention. Callers `submit()` work; the worker drains the queue serially.
 *
 * The worker is per-integration-id (one logical FMG instance, one queue) and
 * is created lazily on first `submit()`. Idle workers are not torn down — the
 * memory footprint is negligible and GCing them would race with concurrent
 * `getFmgWorker()` calls.
 *
 * Cross-feature serialization: discovery's mgmt-IP resolves, reservation push,
 * quarantine push, lease release, manual API proxy, and connection-test calls
 * all share the same per-integration queue. An operator clicking "Reserve IP"
 * mid-discovery can't drop a parallel-connection on FMG anymore — the push
 * waits its turn behind the in-flight resolve.
 *
 * Abort: `submit()` accepts an optional AbortSignal. If it fires before the
 * task starts, the queued entry is rejected with AbortError (the task never
 * runs). If it fires while the task is in-flight, it's the task's job to honor
 * the signal via the standard fetch-signal threading — the worker doesn't
 * force-cancel.
 */

import { setFmgWorkerQueueDepth, setFmgWorkerInflight } from "../metrics.js";

class AbortError extends Error {
  override name = "AbortError";
  constructor(message = "Aborted before FMG worker started the task") {
    super(message);
  }
}

interface QueueEntry<T = unknown> {
  label: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
  // Listener attached to the signal so we can drop the entry from the queue
  // immediately on early abort. Removed on dispatch.
  onAbort?: () => void;
}

export class FmgWorker {
  readonly integrationId: string;
  private queue: QueueEntry[] = [];
  private inFlight: QueueEntry | null = null;
  private draining = false;

  constructor(integrationId: string) {
    this.integrationId = integrationId;
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  get inFlightLabel(): string | null {
    return this.inFlight?.label ?? null;
  }

  /**
   * Submit a task to the worker. Returns a promise that resolves with the
   * task's result, or rejects with the task's error. Aborting before the task
   * starts removes the entry and rejects with AbortError without running the
   * task. Aborting while in-flight is the task's responsibility (via fetch
   * signal); the worker only guarantees serial dispatch.
   */
  submit<T>(label: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new AbortError(`Aborted before submit: ${label}`));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = { label, run, resolve, reject, signal };

      if (signal) {
        const onAbort = () => {
          // Only matters if the entry hasn't been picked up yet. If it's
          // already in-flight, the inner fetch handles the abort.
          const idx = this.queue.indexOf(entry as QueueEntry);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            this.publishDepth();
            entry.reject(new AbortError(`Aborted while queued: ${label}`));
          }
        };
        entry.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.queue.push(entry as QueueEntry);
      this.publishDepth();
      this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift()!;
        this.publishDepth();
        if (entry.signal && entry.onAbort) {
          entry.signal.removeEventListener("abort", entry.onAbort);
        }
        if (entry.signal?.aborted) {
          entry.reject(new AbortError(`Aborted before dispatch: ${entry.label}`));
          continue;
        }
        this.inFlight = entry;
        this.publishInflight(1);
        try {
          const result = await entry.run();
          entry.resolve(result);
        } catch (err) {
          entry.reject(err);
        } finally {
          this.inFlight = null;
          this.publishInflight(0);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private publishDepth(): void {
    setFmgWorkerQueueDepth(this.integrationId, this.queue.length);
  }

  private publishInflight(value: 0 | 1): void {
    setFmgWorkerInflight(this.integrationId, value);
  }
}

const workers = new Map<string, FmgWorker>();

/**
 * Returns the FmgWorker for the given integration id, creating it on first
 * call. Always returns the same worker instance for the same integration id
 * across the life of the process.
 */
export function getFmgWorker(integrationId: string): FmgWorker {
  let worker = workers.get(integrationId);
  if (!worker) {
    worker = new FmgWorker(integrationId);
    workers.set(integrationId, worker);
  }
  return worker;
}

/**
 * Test-only: clear the worker registry. Resets module state between test runs
 * so each test starts with a clean queue.
 */
export function __resetFmgWorkersForTests(): void {
  workers.clear();
}
