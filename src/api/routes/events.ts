/**
 * src/api/routes/events.ts — Event log read endpoints + shared logger
 */

import { Router } from "express";
import { prisma } from "../../db.js";

const router = Router();

// GET /api/v1/events — list events (newest first, paginated)
router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const level = req.query.level as string | undefined;
    const action = req.query.action as string | undefined;
    const resourceType = req.query.resourceType as string | undefined;

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const where: Record<string, unknown> = { timestamp: { gte: cutoff } };
    if (level) where.level = level;
    if (action) where.action = { contains: action };
    if (resourceType) where.resourceType = resourceType;

    const [events, total] = await Promise.all([
      prisma.event.findMany({
        where,
        orderBy: { timestamp: "desc" },
        skip: offset,
        take: limit,
      }),
      prisma.event.count({ where }),
    ]);

    res.json({ events, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

export default router;

// ─── Shared Event Logger ────────────────────────────────────────────────────

export interface LogEventInput {
  action: string;
  resourceType?: string;
  resourceId?: string;
  resourceName?: string;
  actor?: string;
  message: string;
  level?: "info" | "warning" | "error";
  details?: Record<string, unknown>;
}

export async function logEvent(input: LogEventInput): Promise<void> {
  try {
    await prisma.event.create({
      data: {
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        resourceName: input.resourceName,
        actor: input.actor,
        message: input.message,
        level: input.level || "info",
        details: input.details as any,
      },
    });
  } catch {
    // Never let event logging break the main request
  }
}
