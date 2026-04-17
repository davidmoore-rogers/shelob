/**
 * src/api/routes/assets.ts — Asset management CRUD
 * GET routes are available to all authenticated users.
 * POST / PUT / DELETE require assets admin role.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { requireAssetsAdmin } from "../middleware/auth.js";
import { logEvent } from "./events.js";

const router = Router();

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const AssetTypeEnum = z.enum([
  "server", "switch", "router", "firewall",
  "workstation", "printer", "access_point", "other",
]);

const AssetStatusEnum = z.enum([
  "active", "maintenance", "decommissioned", "storage",
]);

const macRegex = /^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$/;

const CreateAssetSchema = z.object({
  ipAddress:     z.string().min(1).optional(),
  macAddress:    z.string().regex(macRegex, "Invalid MAC address format (expected AA:BB:CC:DD:EE:FF)").optional(),
  hostname:      z.string().optional(),
  dnsName:       z.string().optional(),
  assetTag:      z.string().optional(),
  serialNumber:  z.string().optional(),
  manufacturer:  z.string().optional(),
  model:         z.string().optional(),
  assetType:     AssetTypeEnum.optional().default("other"),
  status:        AssetStatusEnum.optional().default("storage"),
  location:      z.string().optional(),
  department:    z.string().optional(),
  assignedTo:    z.string().optional(),
  os:            z.string().optional(),
  acquiredAt:    z.string().datetime().optional().or(z.literal("")).transform(v => v || undefined),
  warrantyExpiry:z.string().datetime().optional().or(z.literal("")).transform(v => v || undefined),
  purchaseOrder: z.string().optional(),
  notes:         z.string().optional(),
  tags:          z.array(z.string()).optional(),
});

const UpdateAssetSchema = CreateAssetSchema.partial();

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/v1/assets — list all assets (all authenticated users)
router.get("/", async (req, res, next) => {
  try {
    const { status, assetType, department, search } = req.query as Record<string, string>;
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (assetType) where.assetType = assetType;
    if (department) where.department = { contains: department, mode: "insensitive" };
    if (search) {
      where.OR = [
        { hostname:  { contains: search, mode: "insensitive" } },
        { dnsName:   { contains: search, mode: "insensitive" } },
        { ipAddress: { contains: search, mode: "insensitive" } },
        { macAddress:{ contains: search, mode: "insensitive" } },
        { assetTag:  { contains: search, mode: "insensitive" } },
        { assignedTo:{ contains: search, mode: "insensitive" } },
      ];
    }
    const assets = await prisma.asset.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    res.json(assets);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id — get single asset (all authenticated users)
router.get("/:id", async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!asset) throw new AppError(404, "Asset not found");
    res.json(asset);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets — create (assets admin)
router.post("/", requireAssetsAdmin, async (req, res, next) => {
  try {
    const input = CreateAssetSchema.parse(req.body);
    const data: Record<string, unknown> = { ...input };
    if (input.macAddress) data.macAddress = input.macAddress.toUpperCase().replace(/-/g, ":");
    if (input.acquiredAt) data.acquiredAt = new Date(input.acquiredAt);
    if (input.warrantyExpiry) data.warrantyExpiry = new Date(input.warrantyExpiry);
    const asset = await prisma.asset.create({ data: data as any });
    logEvent({ action: "asset.created", resourceType: "asset", resourceId: asset.id, resourceName: input.hostname || input.ipAddress, actor: (req as any).user?.username, message: `Asset "${input.hostname || input.ipAddress || "unknown"}" created` });
    res.status(201).json(asset);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/assets/:id — update (assets admin)
router.put("/:id", requireAssetsAdmin, async (req, res, next) => {
  try {
    const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new AppError(404, "Asset not found");
    const input = UpdateAssetSchema.parse(req.body);
    const data: Record<string, unknown> = { ...input };
    if (input.macAddress) data.macAddress = input.macAddress.toUpperCase().replace(/-/g, ":");
    if (input.acquiredAt) data.acquiredAt = new Date(input.acquiredAt);
    else if (input.acquiredAt === undefined) delete data.acquiredAt;
    if (input.warrantyExpiry) data.warrantyExpiry = new Date(input.warrantyExpiry);
    else if (input.warrantyExpiry === undefined) delete data.warrantyExpiry;
    const asset = await prisma.asset.update({ where: { id: req.params.id }, data: data as any });
    logEvent({ action: "asset.updated", resourceType: "asset", resourceId: req.params.id, resourceName: asset.hostname || asset.ipAddress, actor: (req as any).user?.username, message: `Asset "${asset.hostname || asset.ipAddress || "unknown"}" updated` });
    res.json(asset);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/assets/:id — delete (assets admin)
router.delete("/:id", requireAssetsAdmin, async (req, res, next) => {
  try {
    const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new AppError(404, "Asset not found");
    await prisma.asset.delete({ where: { id: req.params.id } });
    logEvent({ action: "asset.deleted", resourceType: "asset", resourceId: req.params.id, resourceName: existing.hostname || existing.ipAddress, actor: (req as any).user?.username, message: `Asset "${existing.hostname || existing.ipAddress || "unknown"}" deleted` });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
