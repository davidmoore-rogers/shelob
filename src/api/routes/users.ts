/**
 * src/api/routes/users.ts — User management (list, create, reset password, delete)
 */

import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";

const router = Router();

const passwordSchema = z.string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[0-9]/, "Password must contain a number")
  .regex(/[^a-zA-Z0-9]/, "Password must contain a special character");

const CreateUserSchema = z.object({
  username: z.string().min(1).max(64),
  password: passwordSchema,
  role:     z.enum(["admin", "networkadmin", "assetsadmin", "user", "readonly"]).optional(),
});

const ResetPasswordSchema = z.object({
  password: passwordSchema,
});

const UpdateRoleSchema = z.object({
  role: z.enum(["admin", "networkadmin", "assetsadmin", "user", "readonly"]),
});

// GET /api/v1/users
router.get("/", async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, username: true, role: true, authProvider: true, displayName: true, email: true, lastLogin: true, createdAt: true, updatedAt: true },
      orderBy: { username: "asc" },
    });
    res.json(users);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/users
router.post("/", async (req, res, next) => {
  try {
    const { username, password, role } = CreateUserSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) throw new AppError(409, `User "${username}" already exists`);

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { username, passwordHash, role: role || "readonly", authProvider: "local" },
      select: { id: true, username: true, role: true, authProvider: true, createdAt: true },
    });
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/users/:id/password
router.put("/:id/password", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const { password } = ResetPasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw new AppError(404, "User not found");
    if (user.authProvider === "azure") throw new AppError(400, "Cannot reset password for Azure SSO users");

    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.user.update({
      where: { id },
      data: { passwordHash },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/users/:id/role
router.put("/:id/role", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const { role } = UpdateRoleSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw new AppError(404, "User not found");

    // Prevent demoting yourself
    if (req.session?.userId === user.id) {
      throw new AppError(400, "You cannot change your own role");
    }

    await prisma.user.update({
      where: { id },
      data: { role },
    });
    res.json({ ok: true, role });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/users/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw new AppError(404, "User not found");

    // Prevent deleting yourself
    if (req.session?.userId === user.id) {
      throw new AppError(400, "You cannot delete your own account");
    }

    await prisma.user.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
