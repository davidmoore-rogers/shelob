/**
 * src/api/middleware/auth.ts — Session + bearer-token authentication
 *
 * Two parallel auth surfaces:
 *   - Session (UI / browser): cookie-bearing requests. RBAC is enforced by
 *     `requirePermission(functionKey, level)` from ./permissions.ts, which
 *     consults the session's role snapshot.
 *   - Bearer token (external): `Authorization: Bearer polaris_<...>` from a
 *     long-lived API token, scoped to a fixed list of capabilities.
 *
 * The five hardcoded-role helpers (requireAdmin / requireNetworkAdmin /
 * requireAssetsAdmin / requireUserOrAbove / isNetworkAdminOrAbove) were
 * retired in the dynamic-roles cutover (migration
 * 20260524000000_roles_table_cutover). Routes that need the bearer-or-
 * session hybrid now use `requireSessionOrTokenPermission` from
 * ./permissions.ts.
 */

import { Request, Response, NextFunction } from "express";
import { AppError } from "../../utils/errors.js";
import { verifyToken } from "../../services/apiTokenService.js";
import { verifyBearer as verifyAgentBearer } from "../../services/agentTokenService.js";

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (req.session?.userId || req.apiToken) {
    return next();
  }
  next(new AppError(401, "Unauthorized — please log in"));
}

// ─── Bearer-token auth ────────────────────────────────────────────────

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== "string") return null;
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/**
 * Resolve a bearer token (if any) on the request and attach the
 * authenticated identity to `req.apiToken`. Always calls next() — does
 * not enforce auth on its own. Pair with `requireSessionOrTokenScope`
 * for the actual gate.
 *
 * Mounted globally on the API router below the session/CSRF middleware
 * so every downstream route can opt in via the hybrid guards.
 */
export async function attachApiToken(req: Request, _res: Response, next: NextFunction) {
  try {
    const raw = extractBearerToken(req);
    if (!raw) return next();
    const callerIp = (req.ip || req.socket.remoteAddress || null) ?? null;
    const token = await verifyToken(raw, callerIp);
    if (token) req.apiToken = token;
    next();
  } catch {
    // Swallow — invalid token is the same as no token. The downstream
    // guard returns 401/403 with a uniform message.
    next();
  }
}

/**
 * Polaris Agent bearer guard. Verifies the presented bearer against the
 * `ManagedAgent` token store (separate from `ApiToken`; see
 * `agentTokenService.ts` for the rationale). On success attaches
 * `{managedAgentId, assetId}` to `req.managedAgent`. 401 on missing/invalid.
 *
 * Used by every /api/v1/agents/* route EXCEPT /enroll (which uses the
 * one-shot enrollment token in the body, not a bearer header).
 */
export async function requireAgentBearer(req: Request, _res: Response, next: NextFunction) {
  try {
    const raw = extractBearerToken(req);
    if (!raw) return next(new AppError(401, "Unauthorized — agent bearer required"));
    const callerIp = (req.ip || req.socket.remoteAddress || null) ?? null;
    const verified = await verifyAgentBearer(raw, callerIp);
    if (!verified) return next(new AppError(401, "Unauthorized — agent bearer invalid or revoked"));
    req.managedAgent = verified;
    next();
  } catch (err) {
    next(err);
  }
}

// requireSessionOrTokenScope retired — see `requireSessionOrTokenPermission`
// in ./permissions.ts which takes a `(functionKey, level, scope)` triple
// and consults the session's role snapshot.
