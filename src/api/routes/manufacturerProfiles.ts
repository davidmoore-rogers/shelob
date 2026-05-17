/**
 * src/api/routes/manufacturerProfiles.ts
 *
 * CRUD endpoints for the editable Manufacturer Profile model. Mounted at
 * `/server-settings/manufacturer-profiles`. Reads open to admin OR
 * assets-admin (same precedent as the MIB Database routes); writes
 * admin-only.
 *
 * The monitoring path doesn't consume these rows yet — the resolver swap
 * lands in a follow-up commit. This module owns the operator-editable
 * surface: list profiles, get one full profile, create, edit metric row
 * defaults, manage per-model overrides, manage custom widgets.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAdmin, requireAdminOrAssetsAdmin } from "../middleware/auth.js";
import {
  listProfiles, getProfile, createProfile, deleteProfile,
  updateMetricRow, createOverride, updateOverride, deleteOverride,
  createWidget, updateWidget, deleteWidget,
} from "../../services/manufacturerProfileService.js";
import { TRANSFORM_KINDS, TRANSFORM_LABELS } from "../../utils/symbolTransforms.js";
import { logger } from "../../utils/logger.js";

const router: Router = Router();

function actor(req: Request): string | null {
  const u = (req as any).session?.user;
  return (u && typeof u.username === "string") ? u.username : null;
}

function send(res: Response, body: unknown, status = 200): void {
  res.status(status).json(body);
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try { await fn(req, res); } catch (err) { next(err); }
  };
}

// GET / — list every profile (summary view).
router.get("/", requireAdminOrAssetsAdmin, handle(async (_req, res) => {
  const profiles = await listProfiles();
  send(res, { profiles, transforms: TRANSFORM_KINDS.map((k) => ({ kind: k, label: TRANSFORM_LABELS[k] })) });
}));

// GET /:id — full profile (metrics + overrides + custom widgets).
router.get("/:id", requireAdminOrAssetsAdmin, handle(async (req, res) => {
  const profile = await getProfile(String(req.params.id));
  if (!profile) return send(res, { error: "Profile not found" }, 404);
  send(res, { profile });
}));

// POST / — create a new profile. Body: { manufacturer }.
router.post("/", requireAdmin, handle(async (req, res) => {
  const { manufacturer } = (req.body || {}) as { manufacturer?: string };
  if (!manufacturer || typeof manufacturer !== "string") {
    return send(res, { error: "manufacturer is required" }, 400);
  }
  const profile = await createProfile({ manufacturer, createdBy: actor(req) });
  logger.info({ profileId: profile.id, manufacturer: profile.manufacturer, actor: actor(req) }, "manufacturer profile created");
  send(res, { profile }, 201);
}));

// PUT /:id/metrics/:metricKey — set the metric row's default symbol/mibId/type/transform.
// Body additionally accepts `composition` for the memory metric — see
// `parseMemoryComposition` in manufacturerProfileService for the shape and
// per-shape required fields. Passing `composition: null` clears it.
router.put("/:id/metrics/:metricKey", requireAdmin, handle(async (req, res) => {
  const updated = await updateMetricRow(String(req.params.id), String(req.params.metricKey), req.body || {});
  send(res, { metric: updated });
}));

// POST /:id/metrics/:metricKey/overrides — add a per-model override.
// Body additionally accepts `composition` for the memory metric (same shape
// as the metric row's composition). When composition is supplied, the `symbol`
// field is optional — the resolver consumes the composition directly.
router.post("/:id/metrics/:metricKey/overrides", requireAdmin, handle(async (req, res) => {
  const created = await createOverride(String(req.params.id), String(req.params.metricKey), req.body || {});
  send(res, { override: created }, 201);
}));

// PUT /:id/metrics/:metricKey/overrides/:overrideId — edit.
router.put("/:id/metrics/:metricKey/overrides/:overrideId", requireAdmin, handle(async (req, res) => {
  const updated = await updateOverride(String(req.params.overrideId), req.body || {});
  send(res, { override: updated });
}));

// DELETE /:id/metrics/:metricKey/overrides/:overrideId.
router.delete("/:id/metrics/:metricKey/overrides/:overrideId", requireAdmin, handle(async (req, res) => {
  await deleteOverride(String(req.params.overrideId));
  res.status(204).end();
}));

// POST /:id/widgets — add a custom widget.
router.post("/:id/widgets", requireAdmin, handle(async (req, res) => {
  const widget = await createWidget(String(req.params.id), { ...(req.body || {}), createdBy: actor(req) });
  send(res, { widget }, 201);
}));

// PUT /:id/widgets/:widgetId.
router.put("/:id/widgets/:widgetId", requireAdmin, handle(async (req, res) => {
  const widget = await updateWidget(String(req.params.widgetId), req.body || {});
  send(res, { widget });
}));

// DELETE /:id/widgets/:widgetId.
router.delete("/:id/widgets/:widgetId", requireAdmin, handle(async (req, res) => {
  await deleteWidget(String(req.params.widgetId));
  res.status(204).end();
}));

// DELETE /:id — admin only.
router.delete("/:id", requireAdmin, handle(async (req, res) => {
  await deleteProfile(String(req.params.id));
  logger.info({ profileId: String(req.params.id), actor: actor(req) }, "manufacturer profile deleted");
  res.status(204).end();
}));

export default router;
