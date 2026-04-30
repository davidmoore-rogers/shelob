/**
 * src/jobs/resolvePolarisPushedConflicts.ts
 *
 * One-shot startup cleanup. Finds pending Conflict rows whose underlying
 * Reservation has `pushedToId` set — meaning Polaris pushed the entry to
 * the FortiGate itself, and any "discovered vs manual" conflict the next
 * discovery raised was just the device echoing back what we wrote. The
 * inline guard in `syncDhcpSubnets` (added in the same commit as this job)
 * stops new conflicts of this kind from being created; this job mops up
 * the legacy ones that were raised before the guard existed.
 *
 * For each match: flip the reservation's sourceType from "manual" to
 * "dhcp_reservation" (so subsequent discoveries also stop seeing it as a
 * conflict candidate) and mark the conflict rejected with
 * `resolvedBy="auto"` / `resolvedAt=now`. User-provided hostname / owner
 * / projectRef / notes are NOT overwritten — the FortiGate description
 * is intentionally distinct ("Polaris/<user>: <hostname>") and shouldn't
 * replace the user's Polaris-side metadata.
 *
 * Idempotent: re-running on a clean database is a no-op.
 *
 * Import this module from src/app.ts to activate it.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

async function resolvePolarisPushedConflicts(): Promise<void> {
  try {
    // Pull every pending reservation conflict whose underlying row was
    // pushed by Polaris. Volume is bounded by total pending conflicts on
    // the instance — small (low hundreds at most) on real deployments.
    const candidates = await prisma.conflict.findMany({
      where: {
        status: "pending",
        entityType: "reservation",
        reservation: { is: { pushedToId: { not: null } } },
      },
      include: { reservation: { select: { id: true, sourceType: true, ipAddress: true, hostname: true } } },
    });

    if (candidates.length === 0) return;

    let resolved = 0;
    const now = new Date();
    for (const c of candidates) {
      if (!c.reservation || !c.reservationId) continue;
      try {
        await prisma.$transaction([
          prisma.reservation.update({
            where: { id: c.reservationId },
            data:
              c.reservation.sourceType === "manual"
                ? { sourceType: "dhcp_reservation" }
                : {},
          }),
          prisma.conflict.update({
            where: { id: c.id },
            data: { status: "rejected", resolvedBy: "auto", resolvedAt: now },
          }),
        ]);
        resolved++;
      } catch (err) {
        logger.warn(
          { err: (err as any)?.message, conflictId: c.id, reservationId: c.reservationId },
          "Failed to auto-resolve Polaris-pushed conflict",
        );
      }
    }

    if (resolved > 0) {
      logger.info(
        { resolved, scanned: candidates.length },
        "Auto-resolved Polaris-pushed reservation conflicts at startup",
      );
    }
  } catch (err) {
    logger.error(err, "Error running resolvePolarisPushedConflicts startup job");
  }
}

// Run once on startup with a short delay so the DB connection is ready.
setTimeout(resolvePolarisPushedConflicts, 5_000);
