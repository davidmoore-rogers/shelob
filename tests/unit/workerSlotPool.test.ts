/**
 * tests/unit/workerSlotPool.test.ts
 *
 * Coverage for the per-cadence worker slot pool. The pool is the only
 * thing standing between an operator and a readable journalctl trace of
 * one worker's lifecycle, so the basic invariants — unique ids while
 * busy, reuse after release, graceful fallback on overflow, stable
 * format — are worth pinning.
 */

import { describe, it, expect } from "vitest";

import {
  acquireWorkerSlot,
  createWorkerSlotPool,
  releaseWorkerSlot,
} from "../../src/utils/workerSlotPool.js";

describe("workerSlotPool — acquire / release", () => {
  it("hands out unique slot ids until the pool fills", () => {
    const pool = createWorkerSlotPool("probe", 3);
    const ids = [acquireWorkerSlot(pool), acquireWorkerSlot(pool), acquireWorkerSlot(pool)];
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(["probe-W01", "probe-W02", "probe-W03"]);
  });

  it("reuses a released slot on the next acquire", () => {
    const pool = createWorkerSlotPool("telemetry", 4);
    const a = acquireWorkerSlot(pool);
    const b = acquireWorkerSlot(pool);
    acquireWorkerSlot(pool);
    acquireWorkerSlot(pool);
    expect(a).toBe("telemetry-W01");
    expect(b).toBe("telemetry-W02");
    releaseWorkerSlot(pool, b);
    const reissued = acquireWorkerSlot(pool);
    expect(reissued).toBe("telemetry-W02");
  });

  it("returns the fallback id when the pool is already full", () => {
    const pool = createWorkerSlotPool("fast", 2);
    acquireWorkerSlot(pool);
    acquireWorkerSlot(pool);
    expect(acquireWorkerSlot(pool)).toBe("fast-W?");
  });

  it("releasing an unknown id is a no-op", () => {
    const pool = createWorkerSlotPool("sysinfo", 2);
    const a = acquireWorkerSlot(pool);
    // Releasing something that wasn't issued should not free anything else.
    releaseWorkerSlot(pool, "sysinfo-W99");
    releaseWorkerSlot(pool, "sysinfo-W?");
    releaseWorkerSlot(pool, "garbage");
    // The originally-acquired slot is still busy.
    const next = acquireWorkerSlot(pool);
    expect(next).toBe("sysinfo-W02");
    expect(a).toBe("sysinfo-W01");
  });

  it("uses the F letter for the floating pool", () => {
    const pool = createWorkerSlotPool("floating", 5);
    const a = acquireWorkerSlot(pool);
    const b = acquireWorkerSlot(pool);
    expect(a).toBe("floating-F01");
    expect(b).toBe("floating-F02");
  });

  it("pads slot numbers to 3 digits when the pool size is >99", () => {
    const pool = createWorkerSlotPool("probe", 120);
    const ids: string[] = [];
    for (let i = 0; i < 105; i++) ids.push(acquireWorkerSlot(pool));
    expect(ids[0]).toBe("probe-W001");
    expect(ids[9]).toBe("probe-W010");
    expect(ids[99]).toBe("probe-W100");
    expect(ids[104]).toBe("probe-W105");
  });
});
