/**
 * src/jobs/_metrics.ts — small helper that wraps a job tick in
 * `polaris_job_duration_seconds{job}` + `polaris_job_total{job, outcome}`
 * without changing the job's error semantics.
 *
 * Each periodic job calls `runInstrumentedJob("name", async () => { ... })`
 * inside its tick function so a thrown error still propagates to the
 * existing logger/try-catch wrappers — we only observe duration + outcome
 * along the way.
 */

import { startJobTimer, recordJobOutcome } from "../metrics.js";

export async function runInstrumentedJob<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const stop = startJobTimer(name);
  try {
    const result = await fn();
    stop();
    recordJobOutcome(name, "success");
    return result;
  } catch (err) {
    stop();
    recordJobOutcome(name, "failure");
    throw err;
  }
}
