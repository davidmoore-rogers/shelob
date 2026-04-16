/**
 * src/api/routes/reservations.ts
 */

import { Router } from "express";
import { z } from "zod";
import * as reservationService from "../../services/reservationService.js";
import { logEvent } from "./events.js";

const router = Router();

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const CreateReservationSchema = z.object({
  subnetId: z.string().uuid(),
  ipAddress: z.string().optional(),
  hostname: z.string().optional(),
  owner: z.string().min(1),
  projectRef: z.string().min(1),
  expiresAt: z.coerce.date().optional(),
  notes: z.string().optional(),
});

const UpdateReservationSchema = z.object({
  hostname: z.string().optional(),
  owner: z.string().min(1).optional(),
  projectRef: z.string().min(1).optional(),
  expiresAt: z.coerce.date().optional(),
  notes: z.string().optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get("/", async (req, res, next) => {
  try {
    const { subnetId, owner, projectRef, status } = req.query as Record<string, string>;
    const reservations = await reservationService.listReservations({
      subnetId,
      owner,
      projectRef,
      status: status as any,
    });
    res.json(reservations);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    res.json(await reservationService.getReservation(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const input = CreateReservationSchema.parse(req.body);
    const reservation = await reservationService.createReservation(input);
    logEvent({ action: "reservation.created", resourceType: "reservation", resourceId: reservation.id, resourceName: input.hostname || input.ipAddress, actor: (req as any).user?.username, message: `Reservation created for ${input.ipAddress || "subnet"} (${input.owner})` });
    res.status(201).json(reservation);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const input = UpdateReservationSchema.parse(req.body);
    const reservation = await reservationService.updateReservation(req.params.id, input);
    logEvent({ action: "reservation.updated", resourceType: "reservation", resourceId: req.params.id, resourceName: input.hostname, actor: (req as any).user?.username, message: `Reservation updated` });
    res.json(reservation);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await reservationService.releaseReservation(req.params.id);
    logEvent({ action: "reservation.released", resourceType: "reservation", resourceId: req.params.id, actor: (req as any).user?.username, message: `Reservation released` });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
