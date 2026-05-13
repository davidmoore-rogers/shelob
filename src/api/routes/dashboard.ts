/**
 * src/api/routes/dashboard.ts
 *
 * Single endpoint that backs the new Dashboard home page in one round-trip:
 *   - blockUtilization:  per-block address allocation (reused from utilizationService)
 *   - recentReservations: most recent 10 manual (user-created) reservations
 *   - assetTypeCounts:   counts per AssetType excluding decommissioned/disabled
 *   - monitorAlerts:     monitored assets currently in warning/down state,
 *                         oldest transition first, capped at 50
 */

import { Router } from "express";
import { prisma } from "../../db.js";
import * as utilizationService from "../../services/utilizationService.js";

const router = Router();

const MONITOR_ALERT_CAP = 50;

router.get("/summary", async (_req, res, next) => {
  try {
    const [global, recentReservations, assetTypeCountsRaw, monitorAlertsRaw] = await Promise.all([
      utilizationService.getGlobalUtilization(),
      utilizationService.getRecentManualReservations(10),
      prisma.asset.groupBy({
        by: ["assetType"],
        _count: { _all: true },
        where: { status: { notIn: ["decommissioned", "disabled"] } },
      }),
      prisma.asset.findMany({
        where: {
          monitored: true,
          monitorStatus: { in: ["warning", "down"] },
        },
        select: {
          id: true,
          hostname: true,
          ipAddress: true,
          assetType: true,
          monitorStatus: true,
          monitorStatusChangedAt: true,
        },
        // Nulls last so a freshly-flipped asset without a transition timestamp
        // doesn't push older outages off the visible head of the list.
        orderBy: [{ monitorStatusChangedAt: { sort: "asc", nulls: "last" } }],
        take: MONITOR_ALERT_CAP + 1,
      }),
    ]);

    const overflow = monitorAlertsRaw.length > MONITOR_ALERT_CAP;
    const monitorAlerts = overflow ? monitorAlertsRaw.slice(0, MONITOR_ALERT_CAP) : monitorAlertsRaw;

    res.json({
      blockUtilization:    global.blockUtilization,
      recentReservations,
      assetTypeCounts:     assetTypeCountsRaw.map((row) => ({
        assetType: row.assetType,
        count:     row._count._all,
      })),
      monitorAlerts,
      monitorAlertsOverflow: overflow,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
