/**
 * src/services/userDashboardService.ts
 *
 * Per-user dashboard layout persistence. Stores the operator's chosen
 * widget set + positions + sizes + per-widget config so layouts follow
 * users across browsers and devices. Layout shape validation lives at
 * the route layer (Zod); this service is the thin DB seam.
 */

import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";

export interface DashboardLayout {
  version: 1;
  widgets: DashboardWidgetInstance[];
}

export interface DashboardWidgetInstance {
  id: string;
  type: string;
  col: number;
  row: number;
  width: number;
  height: number;
  config: Record<string, unknown>;
}

export const EMPTY_LAYOUT: DashboardLayout = { version: 1, widgets: [] };

/**
 * Returns the caller's layout, or the empty layout if no row exists yet.
 * Empty layout is the natural "Use the + Widget button to get started"
 * state — no row in the DB means the operator hasn't touched the
 * dashboard yet, and we deliberately don't seed defaults so a fresh
 * sign-in is a clean slate.
 */
export async function getLayoutForUser(userId: string): Promise<DashboardLayout> {
  const row = await prisma.userDashboard.findUnique({ where: { userId } });
  if (!row) return EMPTY_LAYOUT;
  return row.layout as unknown as DashboardLayout;
}

/**
 * Upsert the caller's layout. Caller is responsible for Zod validation
 * before calling. Returns the saved layout (round-trips so the client
 * sees exactly what the server stored).
 */
export async function saveLayoutForUser(userId: string, layout: DashboardLayout): Promise<DashboardLayout> {
  const json = layout as unknown as Prisma.InputJsonValue;
  const row = await prisma.userDashboard.upsert({
    where:  { userId },
    create: { userId, layout: json },
    update: { layout: json },
  });
  return row.layout as unknown as DashboardLayout;
}
