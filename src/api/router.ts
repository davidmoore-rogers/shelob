/**
 * src/api/router.ts
 */

import { Router } from "express";
import authRouter from "./routes/auth.js";
import blocksRouter from "./routes/blocks.js";
import subnetsRouter from "./routes/subnets.js";
import reservationsRouter from "./routes/reservations.js";
import utilizationRouter from "./routes/utilization.js";
import usersRouter from "./routes/users.js";
import integrationsRouter from "./routes/integrations.js";
import assetsRouter from "./routes/assets.js";
import eventsRouter from "./routes/events.js";
import conflictsRouter from "./routes/conflicts.js";
import serverSettingsRouter from "./routes/serverSettings.js";
import mibsRouter from "./routes/mibs.js";
import deviceIconsRouter from "./routes/deviceIcons.js";
import searchRouter from "./routes/search.js";
import mapRouter from "./routes/map.js";
import mapRegionsRouter from "./routes/mapRegions.js";
import allocationTemplatesRouter from "./routes/allocationTemplates.js";
import credentialsRouter from "./routes/credentials.js";
import manufacturerAliasesRouter from "./routes/manufacturerAliases.js";
import monitorSettingsRouter from "./routes/monitorSettings.js";
import apiTokensRouter from "./routes/apiTokens.js";
import dashboardRouter from "./routes/dashboard.js";
import { requireAuth, requireAdmin, requireNetworkAdmin, attachApiToken } from "./middleware/auth.js";

export const router = Router();

// Resolve any presented bearer token before any auth gate runs. Sets
// req.apiToken when valid; never enforces on its own.
router.use(attachApiToken);

// Auth routes are public (login, logout, session check)
router.use("/auth", authRouter);

// Branding is public so the login page can display custom name/logo
router.get("/server-settings/branding", async (_req, res, next) => {
  try {
    const { getBranding } = await import("./routes/serverSettings.js");
    res.json(await getBranding());
  } catch (err) { next(err); }
});

// Everything below requires an active session OR a valid bearer token.
// Token callers reach further role gates only when a route opts in via
// requireSessionOrTokenScope; the legacy session-only guards (requireAdmin
// etc.) will 403 a token caller because req.session.role is undefined.
router.use(requireAuth);
router.use("/blocks", blocksRouter);
router.use("/subnets", subnetsRouter);
router.use("/allocation-templates", allocationTemplatesRouter);
router.use("/reservations", reservationsRouter);
router.use("/utilization", utilizationRouter);
router.use("/dashboard", dashboardRouter);
router.use("/users", requireAdmin, usersRouter);
router.use("/integrations", requireNetworkAdmin, integrationsRouter);
router.use("/assets", assetsRouter);
router.use("/events", eventsRouter);
router.use("/search", searchRouter);
// Region routes are mounted BEFORE /map so Express's first-match routing picks
// the more-specific path. Region CRUD requires admin/networkadmin (drawing
// regions); the rest of /map is read-only and open to any authenticated user.
router.use("/map/regions", requireNetworkAdmin, mapRegionsRouter);
router.use("/map", mapRouter);
router.use("/conflicts", conflictsRouter);
router.use("/credentials", credentialsRouter);
router.use("/manufacturer-aliases", requireAdmin, manufacturerAliasesRouter);
// monitor-settings: reads open to any auth caller (asset-modal tier badges
// need them); writes guarded per-route by requireAssetsAdmin.
router.use("/monitor-settings", monitorSettingsRouter);
router.use("/api-tokens", requireAdmin, apiTokensRouter);
// MIBs surface mounted BEFORE /server-settings so its per-route guards
// (admin OR assets-admin on reads, admin-only on writes) take precedence
// over the blanket requireAdmin on the rest of /server-settings. Express
// first-match routing handles the rest — any path under /server-settings
// that doesn't start with /server-settings/mibs falls through to the
// admin-only serverSettingsRouter below.
router.use("/server-settings/mibs", mibsRouter);
router.use("/server-settings", requireAdmin, serverSettingsRouter);
// device-icons applies its own per-route guards (admin for CRUD, auth for image-serve)
router.use("/device-icons", deviceIconsRouter);
