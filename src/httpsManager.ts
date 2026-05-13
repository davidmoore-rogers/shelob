/**
 * src/httpsManager.ts — Manages the HTTPS server lifecycle
 *
 * Call `initHttps(app)` once at startup. Call `applyHttps()` whenever
 * HTTPS settings or certificates change — it will start, restart, or
 * stop the HTTPS listener as needed.
 */

import https from "node:https";
import { constants as tlsConstants, createHash, X509Certificate } from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { getHttpsSettings, resolveHttpsCertificates } from "./services/serverSettingsService.js";
import { logger } from "./utils/logger.js";

let httpsServer: https.Server | null = null;
let expressApp: Express | null = null;
let redirectEnabled = false;
let httpsPort = 3443;
// Cached leaf cert from the currently-active TLS context, kept in sync via
// applyHttps(). Powers `getServerCertFingerprint()` for Polaris Agent
// install-time cert pinning. Cleared whenever HTTPS stops.
let currentCertPem: string | Buffer | null = null;

export function initHttps(app: Express): void {
  expressApp = app;
  applyHttps();
}

/**
 * Express middleware — mount early in index.ts.
 * When redirect is enabled and HTTPS is running, redirects HTTP → HTTPS.
 */
export function httpsRedirectMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!redirectEnabled || !httpsServer?.listening) return next();
  // Already HTTPS (behind a proxy or direct)
  if (req.secure || req.headers["x-forwarded-proto"] === "https") return next();
  // Skip API so admin can still manage settings over HTTP
  if (req.path.startsWith("/api/")) return next();
  const host = (req.headers.host || "localhost").replace(/:\d+$/, "");
  const target = `https://${host}${httpsPort === 443 ? "" : ":" + httpsPort}${req.originalUrl}`;
  res.redirect(301, target);
}

export async function applyHttps(): Promise<{ ok: boolean; message: string }> {
  const settings = await getHttpsSettings();
  httpsPort = settings.port;

  if (!settings.enabled) {
    redirectEnabled = false;
    currentCertPem = null;
    await stopHttps();
    return { ok: true, message: "HTTPS disabled" };
  }

  const tlsData = await resolveHttpsCertificates();
  if (!tlsData) {
    currentCertPem = null;
    await stopHttps();
    return { ok: false, message: "HTTPS enabled but certificate or key is missing" };
  }
  // Cache the leaf cert so getServerCertFingerprint() can hash it without
  // reaching into the Node TLS internals.
  currentCertPem = tlsData.cert;

  const opts: https.ServerOptions = {
    cert: tlsData.cert,
    key: tlsData.key,
    minVersion: "TLSv1.2",
    // Disable known-insecure ciphers; allow only AEAD suites for TLS 1.2
    // TLS 1.3 cipher suites are always secure and managed by Node.js automatically
    ciphers: [
      "TLS_AES_256_GCM_SHA384",
      "TLS_CHACHA20_POLY1305_SHA256",
      "TLS_AES_128_GCM_SHA256",
      "ECDHE-ECDSA-AES256-GCM-SHA384",
      "ECDHE-RSA-AES256-GCM-SHA384",
      "ECDHE-ECDSA-CHACHA20-POLY1305",
      "ECDHE-RSA-CHACHA20-POLY1305",
      "ECDHE-ECDSA-AES128-GCM-SHA256",
      "ECDHE-RSA-AES128-GCM-SHA256",
    ].join(":"),
    honorCipherOrder: true,
    secureOptions:
      tlsConstants.SSL_OP_NO_SSLv2 |
      tlsConstants.SSL_OP_NO_SSLv3 |
      tlsConstants.SSL_OP_NO_TLSv1 |
      tlsConstants.SSL_OP_NO_TLSv1_1 |
      tlsConstants.SSL_OP_NO_RENEGOTIATION,
  };
  if (tlsData.ca.length > 0) {
    opts.ca = tlsData.ca;
  }

  // If already running, update TLS context without full restart
  if (httpsServer && httpsServer.listening) {
    try {
      httpsServer.setSecureContext(opts);
      // If port changed, need full restart
      const addr = httpsServer.address();
      if (addr && typeof addr === "object" && addr.port !== settings.port) {
        await stopHttps();
        return startHttps(opts, settings.port);
      }
      redirectEnabled = settings.redirectHttp;
      logger.info("HTTPS certificate updated (hot reload)");
      return { ok: true, message: `HTTPS certificate updated on port ${settings.port}` };
    } catch (err: any) {
      logger.error({ err }, "Failed to update HTTPS context, restarting");
      await stopHttps();
    }
  }

  const result = await startHttps(opts, settings.port);
  // Only enable redirect after HTTPS is confirmed running
  redirectEnabled = settings.redirectHttp && result.ok;
  return result;
}

function startHttps(
  opts: https.ServerOptions,
  port: number,
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    if (!expressApp) {
      resolve({ ok: false, message: "Express app not initialized" });
      return;
    }

    httpsServer = https.createServer(opts, expressApp);

    httpsServer.on("error", (err: any) => {
      logger.error({ err }, "HTTPS server error");
      if (err.code === "EADDRINUSE") {
        resolve({ ok: false, message: `Port ${port} is already in use` });
      } else if (err.code === "ERR_SSL_NO_PRIVATE_KEY" || err.message?.includes("key")) {
        resolve({ ok: false, message: "Invalid private key" });
      } else {
        resolve({ ok: false, message: err.message || "HTTPS server error" });
      }
    });

    httpsServer.listen(port, () => {
      logger.info({ port }, "HTTPS server listening");
      resolve({ ok: true, message: `HTTPS server listening on port ${port}` });
    });
  });
}

async function stopHttps(): Promise<void> {
  if (!httpsServer) return;
  currentCertPem = null;
  return new Promise((resolve) => {
    httpsServer!.close(() => {
      logger.info("HTTPS server stopped");
      httpsServer = null;
      resolve();
    });
    // Force-close idle connections after a short grace period
    setTimeout(() => {
      if (httpsServer) {
        httpsServer.closeAllConnections?.();
      }
    }, 2000);
  });
}

export function isHttpsRunning(): boolean {
  return httpsServer !== null && httpsServer.listening;
}

/**
 * SHA-256 fingerprint of the running Polaris HTTPS leaf cert, as
 * `sha256:<lowercase-hex>`. Baked into each agent's `agent.conf` at
 * install time so the agent can pin Polaris's cert directly and skip
 * the system CA trust chain entirely (defends against CA-compromise /
 * MITM scenarios). The agent's Go TLS client uses this as a custom
 * VerifyPeerCertificate; `/api/v1/agents/enroll` cross-checks the
 * fingerprint the agent reports it observed against this value.
 *
 * Returns null when HTTPS is not running (e.g. dev installs serving over
 * plain HTTP); the install flow rejects agent installs in that mode
 * because there's no cert to pin and no encrypted transport.
 */
export function getServerCertFingerprint(): string | null {
  if (!httpsServer || !httpsServer.listening) return null;
  if (!currentCertPem) return null;
  try {
    const x509 = new X509Certificate(currentCertPem);
    const hex = createHash("sha256").update(x509.raw).digest("hex");
    return `sha256:${hex}`;
  } catch (err) {
    logger.warn({ err }, "Failed to compute server cert fingerprint");
    return null;
  }
}
