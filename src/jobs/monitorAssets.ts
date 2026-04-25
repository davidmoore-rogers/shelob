/**
 * src/jobs/monitorAssets.ts
 *
 * Periodic asset monitoring tick. Wakes every TICK_MS, asks
 * monitoringService.runMonitorPass() to handle anything due across the
 * three cadences (response-time probe, telemetry, system info), and once
 * per day prunes the three time-series tables independently using their
 * own retention windows.
 *
 * Cadence pacing is per-asset (Asset.monitorIntervalSec / telemetryIntervalSec
 * / systemInfoIntervalSec, falling back to the global defaults), so the tick
 * is intentionally faster than any reasonable interval — runMonitorPass
 * filters out assets that aren't due yet.
 */

import {
  runMonitorPass,
  pruneMonitorSamples,
  pruneTelemetrySamples,
  pruneSystemInfoSamples,
} from "../services/monitoringService.js";
import { logger } from "../utils/logger.js";

const TICK_MS = 5_000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

let lastPruneAt = 0;
let running = false;

async function tick(): Promise<void> {
  if (running) return; // skip overlap if a slow probe is still finishing
  running = true;
  try {
    const stats = await runMonitorPass();
    if (stats.probed > 0 || stats.telemetry.collected > 0 || stats.systemInfo.collected > 0) {
      logger.debug({ stats }, "Monitor pass complete");
    }
    if (Date.now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
      const [pruned, telPruned, sysPruned] = await Promise.all([
        pruneMonitorSamples(),
        pruneTelemetrySamples(),
        pruneSystemInfoSamples(),
      ]);
      lastPruneAt = Date.now();
      if (pruned > 0 || telPruned > 0 || sysPruned > 0) {
        logger.info({ pruned, telPruned, sysPruned }, "Pruned old monitor samples");
      }
    }
  } catch (err) {
    logger.error({ err }, "Monitor tick failed");
  } finally {
    running = false;
  }
}

tick();
setInterval(tick, TICK_MS);
