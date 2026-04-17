/**
 * src/api/routes/serverSettings.ts — NTP and certificate management endpoints
 */

import { Router } from "express";
import multer from "multer";
import { execSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { existsSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getNtpSettings,
  updateNtpSettings,
  testNtpSync,
  listCertificates,
  addCertificate,
  deleteCertificate,
  getHttpsSettings,
  updateHttpsSettings,
  generateSelfSignedCert,
} from "../../services/serverSettingsService.js";
import { applyHttps, isHttpsRunning } from "../../httpsManager.js";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });
const restoreUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } });

const APP_VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // Works from both src/ (dev) and dist/ (build)
    for (const rel of ["../../../package.json", "../../package.json"]) {
      const p = join(here, rel);
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8")).version || "0.0.0";
    }
    return "0.0.0";
  } catch { return "0.0.0"; }
})();

// ─── Database ──────────────────────────────────────────────────────────────

router.get("/database", async (_req, res, next) => {
  try {
    // Query PostgreSQL for version, size, table stats, and connections
    const versionResult = await prisma.$queryRawUnsafe<any[]>("SELECT version()");
    const version = versionResult[0]?.version || "Unknown";

    const dbNameResult = await prisma.$queryRawUnsafe<any[]>("SELECT current_database() AS db");
    const dbName = dbNameResult[0]?.db || "unknown";

    const sizeResult = await prisma.$queryRawUnsafe<any[]>(
      "SELECT pg_size_pretty(pg_database_size(current_database())) AS size"
    );
    const databaseSize = sizeResult[0]?.size || "Unknown";

    const tablesResult = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        relname AS name,
        n_live_tup AS rows,
        pg_size_pretty(pg_total_relation_size(quote_ident(relname))) AS size,
        pg_total_relation_size(quote_ident(relname)) AS size_bytes
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(quote_ident(relname)) DESC
    `);
    const tables = tablesResult.map((t: any) => ({
      name: t.name,
      rows: Number(t.rows),
      size: t.size,
    }));

    const connResult = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS active,
        (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max
    `);
    const activeConnections = Number(connResult[0]?.active || 0);
    const maxConnections = Number(connResult[0]?.max || 100);

    const uptimeResult = await prisma.$queryRawUnsafe<any[]>(
      "SELECT date_trunc('second', current_timestamp - pg_postmaster_start_time()) AS uptime"
    );
    const uptime = uptimeResult[0]?.uptime || "Unknown";

    // Parse version string to extract short version
    const versionMatch = version.match(/PostgreSQL\s+([\d.]+)/);
    const shortVersion = versionMatch ? versionMatch[1] : version;

    // Parse connection URL for host/port
    const connUrl = process.env.DATABASE_URL || "";
    const urlMatch = connUrl.match(/@([^:/?]+)(?::(\d+))?/);
    const host = urlMatch ? urlMatch[1] : "localhost";
    const port = urlMatch && urlMatch[2] ? parseInt(urlMatch[2], 10) : 5432;
    const ssl = connUrl.includes("sslmode=require") || connUrl.includes("ssl=true") ? "Enabled" : "Disabled";

    res.json({
      type: "PostgreSQL",
      version: shortVersion,
      host,
      port,
      database: dbName,
      ssl,
      databaseSize,
      tableCount: tables.length,
      tables,
      activeConnections,
      maxConnections,
      uptime: String(uptime),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Database Backup ──────────────────────────────────────────────────────

router.post("/database/backup", async (req, res, next) => {
  try {
    const password: string | null = req.body?.password || null;
    const connUrl = process.env.DATABASE_URL || "";
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `shelob-backup-${APP_VERSION}-${ts}${password ? ".enc" : ""}.gz`;
    const tmpFile = join(tmpdir(), `shelob-dump-${Date.now()}.sql`);

    try {
      // Use pg_dump to create a full SQL dump
      // --clean --if-exists: DROP tables before CREATE so restore works on both fresh and existing databases
      execSync(`pg_dump "${connUrl}" --no-owner --no-acl --clean --if-exists -f "${tmpFile}"`, {
        timeout: 120000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: any) {
      throw new AppError(500, "pg_dump failed: " + (err.stderr?.toString() || err.message));
    }

    let payload = readFileSync(tmpFile);
    try { unlinkSync(tmpFile); } catch {}

    // Compress with gzip
    payload = gzipSync(payload);

    // Encrypt if password provided
    if (password) {
      const salt = randomBytes(32);
      const key = scryptSync(password, salt, 32);
      const iv = randomBytes(16);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const magic = Buffer.from("SHELOB1\0");
      payload = Buffer.concat([magic, salt, iv, authTag, encrypted]);
    }

    // Record backup in settings table
    const backupRecord = {
      id: `bk-${Date.now()}`,
      filename,
      size: payload.length,
      encrypted: !!password,
      createdAt: new Date().toISOString(),
    };
    const existing = await prisma.setting.findUnique({ where: { key: "backup_history" } });
    const history: any[] = existing?.value && Array.isArray(existing.value) ? existing.value as any[] : [];
    history.push(backupRecord);
    if (history.length > 50) history.splice(0, history.length - 50);
    await prisma.setting.upsert({
      where: { key: "backup_history" },
      update: { value: history },
      create: { key: "backup_history", value: history },
    });

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", payload.length);
    res.end(payload);
  } catch (err) {
    next(err);
  }
});

router.post("/database/restore", restoreUpload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError(400, "No backup file uploaded");
    const password: string | null = req.body?.password || null;
    const connUrl = process.env.DATABASE_URL || "";

    let payload = req.file.buffer;

    // Check if encrypted
    const magic = Buffer.from("SHELOB1\0");
    const isEncrypted = payload.length > 72 && payload.subarray(0, 8).equals(magic);

    if (isEncrypted) {
      if (!password) throw new AppError(400, "This backup is encrypted — a password is required to restore it");
      const salt = payload.subarray(8, 40);
      const iv = payload.subarray(40, 56);
      const authTag = payload.subarray(56, 72);
      const ciphertext = payload.subarray(72);
      const key = scryptSync(password, salt, 32);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      try {
        payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        throw new AppError(400, "Decryption failed — incorrect password or corrupted file");
      }
    }

    // Decompress
    try {
      payload = gunzipSync(payload);
    } catch {
      throw new AppError(400, "Decompression failed — file is not a valid gzip archive");
    }

    // Write SQL to temp file and restore with psql
    const tmpFile = join(tmpdir(), `shelob-restore-${Date.now()}.sql`);
    writeFileSync(tmpFile, payload);

    try {
      // --single-transaction: rollback everything if any statement fails
      execSync(`psql "${connUrl}" --single-transaction -f "${tmpFile}"`, {
        timeout: 120000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: any) {
      throw new AppError(500, "psql restore failed: " + (err.stderr?.toString() || err.message));
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }

    res.json({ ok: true, message: "Database restored successfully" });
  } catch (err) {
    next(err);
  }
});

router.get("/database/backups", async (_req, res, next) => {
  try {
    const existing = await prisma.setting.findUnique({ where: { key: "backup_history" } });
    const history: any[] = existing?.value && Array.isArray(existing.value) ? existing.value as any[] : [];
    res.json(history.reverse());
  } catch (err) {
    next(err);
  }
});

// ─── Tags ──────────────────────────────────────────────────────────────────

router.get("/tags", async (_req, res, next) => {
  try {
    const tags = await prisma.tag.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] });
    res.json(tags);
  } catch (err) {
    next(err);
  }
});

router.post("/tags", async (req, res, next) => {
  try {
    const name = (req.body.name || "").trim().toLowerCase().replace(/\s+/g, "-");
    if (!name) throw new AppError(400, "Tag name is required");

    const existing = await prisma.tag.findUnique({ where: { name } });
    if (existing) throw new AppError(409, `Tag "${name}" already exists`);

    const tag = await prisma.tag.create({
      data: {
        name,
        category: req.body.category || "General",
        color: req.body.color || "#4fc3f7",
      },
    });
    res.status(201).json(tag);
  } catch (err) {
    next(err);
  }
});

router.get("/tags/settings", async (_req, res, next) => {
  try {
    const row = await prisma.setting.findUnique({ where: { key: "tagSettings" } });
    res.json(row ? row.value : { enforce: false });
  } catch (err) {
    next(err);
  }
});

router.put("/tags/settings", async (req, res, next) => {
  try {
    const value = { enforce: req.body.enforce === true };
    const row = await prisma.setting.upsert({
      where: { key: "tagSettings" },
      update: { value },
      create: { key: "tagSettings", value },
    });
    res.json(row.value);
  } catch (err) {
    next(err);
  }
});

router.delete("/tags/:id", async (req, res, next) => {
  try {
    const tag = await prisma.tag.findUnique({ where: { id: req.params.id } });
    if (!tag) throw new AppError(404, "Tag not found");
    await prisma.tag.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ─── NTP ────────────────────────────────────────────────────────────────────

router.get("/ntp", async (_req, res, next) => {
  try {
    res.json(await getNtpSettings());
  } catch (err) {
    next(err);
  }
});

router.put("/ntp", async (req, res, next) => {
  try {
    res.json(await updateNtpSettings(req.body));
  } catch (err) {
    next(err);
  }
});

router.post("/ntp/test", async (req, res, next) => {
  try {
    res.json(await testNtpSync(req.body));
  } catch (err) {
    next(err);
  }
});

// ─── Certificates ───────────────────────────────────────────────────────────

router.get("/certificates", async (_req, res, next) => {
  try {
    const certs = await listCertificates();
    // Strip PEM content from list response
    const strip = (c: any) => ({ ...c, pem: undefined });
    res.json({
      trustedCAs: certs.trustedCAs.map(strip),
      serverCerts: certs.serverCerts.map(strip),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/certificates", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const category = req.body.category === "server" ? "server" : "ca";
    const pem = req.file.buffer.toString("utf-8");
    const record = await addCertificate(category as any, req.file.originalname, pem);
    res.status(201).json({ ...record, pem: undefined });
  } catch (err) {
    next(err);
  }
});

router.delete("/certificates/:id", async (req, res, next) => {
  try {
    await deleteCertificate(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post("/certificates/generate", async (req, res, next) => {
  try {
    const cn = req.body.commonName || "localhost";
    const days = Math.min(3650, Math.max(1, parseInt(req.body.days, 10) || 365));
    const result = await generateSelfSignedCert(cn, days);
    res.status(201).json({
      cert: { ...result.cert, pem: undefined },
      key: { ...result.key, pem: undefined },
    });
  } catch (err) {
    next(err);
  }
});

// ─── HTTPS ──────────────────────────────────────────────────────────────────

router.get("/https", async (_req, res, next) => {
  try {
    const settings = await getHttpsSettings();
    res.json({ ...settings, running: isHttpsRunning() });
  } catch (err) {
    next(err);
  }
});

router.put("/https", async (req, res, next) => {
  try {
    const settings = await updateHttpsSettings(req.body);
    res.json({ ...settings, running: isHttpsRunning() });
  } catch (err) {
    next(err);
  }
});

router.post("/https/apply", async (_req, res, next) => {
  try {
    const result = await applyHttps();
    res.json({ ...result, running: isHttpsRunning() });
  } catch (err) {
    next(err);
  }
});

export default router;
