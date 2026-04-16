/**
 * src/api/routes/serverSettings.ts — NTP and certificate management endpoints
 */

import { Router } from "express";
import multer from "multer";
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
