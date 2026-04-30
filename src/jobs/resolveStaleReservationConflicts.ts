/**
 * src/jobs/resolveStaleReservationConflicts.ts
 *
 * One-shot startup cleanup. Finds pending reservation Conflict rows whose
 * stored proposed values now match the live Reservation values — i.e. the
 * conflict was raised by an old discovery run when hostnames/owner/projectRef
 * differed, but the values have since come back into sync (operator updated
 * the manual reservation, asset hostname was renormalized, etc.). The inline
 * fix in `upsertConflict` stops new conflicts of this kind from lingering;
 * this job mops up the legacy ones that pre-date the fix.
 *
 * Match rule: a conflict is "stale" iff every field listed in conflictFields
 * (hostname / owner / projectRef) has the same value on the proposed side as
 * on the live reservation. If any one of them still differs, the conflict
 * stays open.
 *
 * Idempotent: re-running on a clean database is a no-op.
 *
 * Import this module from src/app.ts to activate it.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

async function resolveStaleReservationConflicts(): Promise<void> {
  try {
    const candidates = await prisma.conflict.findMany({
      where: { status: "pending", entityType: "reservation" },
      include: {
        reservation: {
          select: { id: true, hostname: true, owner: true, projectRef: true },
        },
      },
    });

    if (candidates.length === 0) return;

    const stale: string[] = [];
    for (const c of candidates) {
      if (!c.reservation) continue;
      const fields = c.conflictFields || [];
      if (fields.length === 0) {
        stale.push(c.id);
        continue;
      }
      const stillDiffers = fields.some((f) => {
        if (f === "hostname") return (c.proposedHostname ?? null) !== (c.reservation!.hostname ?? null);
        if (f === "owner") return (c.proposedOwner ?? null) !== (c.reservation!.owner ?? null);
        if (f === "projectRef") return (c.proposedProjectRef ?? null) !== (c.reservation!.projectRef ?? null);
        return true;
      });
      if (!stillDiffers) stale.push(c.id);
    }

    if (stale.length === 0) return;

    const result = await prisma.conflict.updateMany({
      where: { id: { in: stale }, status: "pending" },
      data: { status: "rejected", resolvedBy: "auto", resolvedAt: new Date() },
    });

    if (result.count > 0) {
      logger.info(
        { resolved: result.count, scanned: candidates.length },
        "Auto-resolved stale reservation conflicts at startup",
      );
    }
  } catch (err) {
    logger.error(err, "Error running resolveStaleReservationConflicts startup job");
  }
}

setTimeout(resolveStaleReservationConflicts, 5_000);
