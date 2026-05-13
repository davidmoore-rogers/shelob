/**
 * src/jobs/backfillMonitorStatusChangedAt.ts
 *
 * One-shot startup job: seeds Asset.monitorStatusChangedAt for assets that
 * were already in warning/down/recovering before the column existed. The
 * column is stamped going forward by recordProbeResult; this job covers the
 * gap on existing installs so the Dashboard's "how long has this been
 * warning/down" duration isn't blank for the lifetime of the current outage.
 *
 * Source for the seed value: the most recent `monitor.status_changed` Event
 * whose details.nextStatus matches the asset's current monitorStatus. Events
 * are pruned at 7 days; assets whose last transition is older than that get
 * left null (Dashboard renders "—").
 *
 * Idempotent — only touches rows where monitorStatusChangedAt IS NULL.
 *
 * Import from src/app.ts to activate.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";

async function backfillMonitorStatusChangedAt(): Promise<void> {
  const start = Date.now();
  try {
    await runInstrumentedJob("backfillMonitorStatusChangedAt", async () => {
      const candidates = await prisma.asset.findMany({
        where: {
          monitored: true,
          monitorStatusChangedAt: null,
          monitorStatus: { in: ["warning", "down", "recovering"] },
        },
        select: { id: true, monitorStatus: true },
      });
      if (candidates.length === 0) return;

      let stamped = 0;
      for (const asset of candidates) {
        const evt = await prisma.event.findFirst({
          where: {
            action: "monitor.status_changed",
            resourceId: asset.id,
          },
          orderBy: { timestamp: "desc" },
          select: { timestamp: true, details: true },
        });
        if (!evt) continue;
        const details = evt.details as { nextStatus?: string } | null;
        if (!details || details.nextStatus !== asset.monitorStatus) continue;
        await prisma.asset.update({
          where: { id: asset.id },
          data: { monitorStatusChangedAt: evt.timestamp },
        });
        stamped++;
      }

      if (stamped > 0) {
        logger.info(
          {
            candidates: candidates.length,
            stamped,
            elapsedMs: Date.now() - start,
          },
          "Backfilled monitorStatusChangedAt from monitor.status_changed events",
        );
      }
    });
  } catch (err: any) {
    logger.error(
      { err: err?.message ?? String(err) },
      "monitorStatusChangedAt backfill failed (next status change will repopulate)",
    );
  }
}

setTimeout(backfillMonitorStatusChangedAt, 60_000);
