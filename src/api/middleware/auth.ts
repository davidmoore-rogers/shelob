/**
 * src/api/middleware/auth.ts — Session-based authentication guards
 */

import { Request, Response, NextFunction } from "express";
import { AppError } from "../../utils/errors.js";

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (req.session?.userId) {
    return next();
  }
  next(new AppError(401, "Unauthorized — please log in"));
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.session?.role === "admin") {
    return next();
  }
  next(new AppError(403, "Forbidden — admin access required"));
}

export function requireNetworkAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.session?.role === "admin" || req.session?.role === "networkadmin") {
    return next();
  }
  next(new AppError(403, "Forbidden — network admin access required"));
}

export function requireAssetsAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.session?.role === "admin" || req.session?.role === "assetsadmin") {
    return next();
  }
  next(new AppError(403, "Forbidden — assets admin access required"));
}

// Allows any authenticated role except `readonly`. Used on write routes that
// regular users are allowed to perform (create subnet/reservation, edit/delete
// their own records).
export function requireUserOrAbove(req: Request, _res: Response, next: NextFunction) {
  const role = req.session?.role;
  if (role === "admin" || role === "networkadmin" || role === "assetsadmin" || role === "user") {
    return next();
  }
  next(new AppError(403, "Forbidden — read-only users cannot modify data"));
}

// True when the caller may edit/delete any network resource regardless of
// ownership. Readers should fall back to ownership (createdBy) when this
// returns false.
export function isNetworkAdminOrAbove(req: Request): boolean {
  const role = req.session?.role;
  return role === "admin" || role === "networkadmin";
}
