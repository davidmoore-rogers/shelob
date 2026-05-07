/**
 * src/api/routes/mapRegions.ts
 *
 * CRUD for operator-drawn map regions. All routes are guarded by
 * requireNetworkAdmin (mounted in src/api/router.ts) — non-admins never need
 * region data because regions are only rendered while editing.
 */

import { Router } from "express";
import { z } from "zod";
import * as service from "../../services/mapRegionService.js";
import { logEvent } from "./events.js";

const router = Router();

const PolygonSchema = z
  .array(z.tuple([z.number(), z.number()]))
  .min(3, "Polygon must have at least 3 vertices")
  .max(1000, "Polygon cannot have more than 1000 vertices");

const CreateRegionSchema = z.object({
  name: z.string().min(1, "Region name is required").max(64),
  polygon: PolygonSchema,
});

const UpdateRegionSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  polygon: PolygonSchema.optional(),
});

// GET /map/regions
router.get("/", async (_req, res, next) => {
  try {
    res.json(await service.listRegions());
  } catch (err) {
    next(err);
  }
});

// POST /map/regions
router.post("/", async (req, res, next) => {
  try {
    const input = CreateRegionSchema.parse(req.body);
    const created = await service.createRegion({
      name: input.name,
      polygon: input.polygon,
      actor: req.session?.username ?? null,
    });
    const summary = await service.applyOneRegion(created);
    logEvent({
      action: "region.created",
      resourceType: "map-region",
      resourceId: created.id,
      resourceName: created.name,
      actor: req.session?.username,
      message: `Map region "${created.name}" created (${summary.added} asset${summary.added === 1 ? "" : "s"} tagged)`,
      details: { vertices: created.polygon.length, added: summary.added },
    });
    if (summary.added > 0) {
      logEvent({
        action: "region.tags_reconciled",
        resourceType: "map-region",
        resourceId: created.id,
        resourceName: created.name,
        message: `Region tags reconciled: +${summary.added} / -${summary.removed} (${summary.assetsTouched} asset${summary.assetsTouched === 1 ? "" : "s"} touched)`,
        details: summary,
      });
    }
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// PUT /map/regions/:id
router.put("/:id", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const input = UpdateRegionSchema.parse(req.body);
    const result = await service.updateRegion(id, input);
    let summary: service.ReconcileSummary;
    if (result.renamed) {
      summary = await service.applyRename(result.region, result.previousName);
    } else {
      summary = await service.applyOneRegion(result.region);
    }
    logEvent({
      action: "region.updated",
      resourceType: "map-region",
      resourceId: result.region.id,
      resourceName: result.region.name,
      actor: req.session?.username,
      message: result.renamed
        ? `Map region renamed "${result.previousName}" → "${result.region.name}"`
        : `Map region "${result.region.name}" updated${result.polygonChanged ? " (polygon edited)" : ""}`,
      details: {
        previousName: result.previousName,
        renamed: result.renamed,
        polygonChanged: result.polygonChanged,
        vertices: result.region.polygon.length,
        ...summary,
      },
    });
    if (summary.assetsTouched > 0) {
      logEvent({
        action: "region.tags_reconciled",
        resourceType: "map-region",
        resourceId: result.region.id,
        resourceName: result.region.name,
        message: `Region tags reconciled: +${summary.added} / -${summary.removed} (${summary.assetsTouched} asset${summary.assetsTouched === 1 ? "" : "s"} touched)`,
        details: summary,
      });
    }
    res.json(result.region);
  } catch (err) {
    next(err);
  }
});

// DELETE /map/regions/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const removed = await service.deleteRegion(id);
    const summary = await service.applyDelete(removed);
    logEvent({
      action: "region.deleted",
      resourceType: "map-region",
      resourceId: removed.id,
      resourceName: removed.name,
      actor: req.session?.username,
      message: `Map region "${removed.name}" deleted (${summary.removed} asset${summary.removed === 1 ? "" : "s"} untagged)`,
      details: summary,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
