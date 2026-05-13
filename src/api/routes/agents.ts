/**
 * src/api/routes/agents.ts — Polaris Agent inbound API surface
 *
 * Mounted at /api/v1/agents/. Two auth surfaces:
 *
 *  - `POST /enroll` is public: the agent posts its one-shot enrollment
 *    token (baked into agent.conf at install time) and reports the cert
 *    fingerprint it observed on the TLS handshake. Server cross-checks the
 *    pin, mints a long-lived bearer, transitions installStatus → "active".
 *
 *  - Everything else (`POST /samples`, `GET /config`, `POST /heartbeat`)
 *    is gated by `requireAgentBearer`. The bearer is bound to a single
 *    assetId at issuance; the /samples handler stamps that assetId onto
 *    every sample server-side, ignoring any client-supplied value —
 *    defense against stolen-bearer cross-asset reuse.
 *
 * Phase 2 scope: end-to-end testable with curl alone. The Go agent
 * (Phase 3) calls these endpoints; the WebSocket pull side comes in a
 * follow-on. Samples land via the existing sampleWriteBuffer so they
 * appear on the asset details page within 2 s.
 */

import { Router } from "express";
import { z } from "zod";
import { createHash } from "node:crypto";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { requireAgentBearer } from "../middleware/auth.js";
import {
  consumeEnrollmentToken,
} from "../../services/agentTokenService.js";
import {
  recordProbeResult,
  resolveMonitorSettings,
} from "../../services/monitoringService.js";
import {
  enqueueMonitorSample,
  enqueueTelemetrySample,
  enqueueTemperatureSamples,
  enqueueInterfaceSamples,
  enqueueStorageSamples,
} from "../../services/sampleWriteBuffer.js";
import { logEvent } from "./events.js";
import { logger } from "../../utils/logger.js";

// ─── /enroll (public) ─────────────────────────────────────────────────
//
// Mounted on its own sub-router so router.ts can attach it BEFORE the
// requireAgentBearer guard (the agent has no bearer yet at this point).

export const agentsEnrollRouter = Router();

const EnrollSchema = z.object({
  enrollmentToken:             z.string().min(1),
  osPlatform:                  z.enum(["linux", "darwin", "windows"]),
  arch:                        z.enum(["amd64", "arm64"]),
  agentVersion:                z.string().min(1).max(64),
  hostname:                    z.string().max(255).optional(),
  serverCertFingerprintSeen:   z.string().regex(/^sha256:[0-9a-f]{64}$/i),
});

agentsEnrollRouter.post("/", async (req, res, next) => {
  try {
    const body = EnrollSchema.parse(req.body);

    const consumed = await consumeEnrollmentToken(body.enrollmentToken);
    const { managedAgent, bearer } = consumed;

    // Cross-check the pin. The agent reports the fingerprint it observed
    // during the TLS handshake; if it doesn't match what we stored at
    // install kickoff, something is intercepting the connection — refuse
    // to issue the bearer. We've already consumed the enrollment token at
    // this point (it's one-shot by design); the install is dead in this
    // state and the operator must Reinstall to get a fresh enrollment.
    const expectedPin = managedAgent.serverCertFingerprint.toLowerCase();
    const observedPin = body.serverCertFingerprintSeen.toLowerCase();
    if (expectedPin !== observedPin) {
      // The transaction in consumeEnrollmentToken already minted a bearer
      // we now need to revoke. Mark the install as failed so the operator
      // sees a clear error in the UI.
      await prisma.managedAgent.update({
        where: { id: managedAgent.id },
        data: {
          installStatus: "failed",
          installError:  `Cert pin mismatch — expected ${expectedPin}, agent saw ${observedPin}`,
          bearerRevokedAt: new Date(),
        },
      });
      await logEvent({
        action:       "agent.install_failed",
        resourceType: "asset",
        resourceId:   managedAgent.assetId,
        level:        "error",
        message:      "Agent enrollment rejected: TLS cert pin mismatch",
        details:      { expectedPin, observedPin, managedAgentId: managedAgent.id },
      });
      throw new AppError(400, "Server cert fingerprint mismatch — refusing enrollment");
    }

    // Plat/arch sanity: the install scripts should already have stamped
    // these on the row, but if the agent reports a different combo (host
    // got re-imaged with a different OS), refuse rather than silently
    // accept a mismatch.
    if (managedAgent.osPlatform !== body.osPlatform || managedAgent.arch !== body.arch) {
      await prisma.managedAgent.update({
        where: { id: managedAgent.id },
        data: {
          installStatus: "failed",
          installError:  `Platform mismatch — install expected ${managedAgent.osPlatform}/${managedAgent.arch}, agent reported ${body.osPlatform}/${body.arch}`,
          bearerRevokedAt: new Date(),
        },
      });
      throw new AppError(400, "Platform/arch mismatch — refusing enrollment");
    }

    await prisma.managedAgent.update({
      where: { id: managedAgent.id },
      data: { agentVersion: body.agentVersion },
    });

    await logEvent({
      action:       "agent.enrolled",
      resourceType: "asset",
      resourceId:   managedAgent.assetId,
      level:        "info",
      message:      `Polaris Agent enrolled (${body.osPlatform}/${body.arch} v${body.agentVersion})`,
      details:      { managedAgentId: managedAgent.id, hostname: body.hostname ?? null },
    });

    res.json({
      bearer,
      assetId:    managedAgent.assetId,
      configEtag: await computeConfigEtag(managedAgent.assetId),
    });
  } catch (err) { next(err); }
});

// ─── Bearer-gated routes ──────────────────────────────────────────────

export const agentsRouter = Router();
agentsRouter.use(requireAgentBearer);

// ─── Sample wire shapes ───────────────────────────────────────────────
//
// Discriminated union by `stream`. Each variant maps to a sampleWriteBuffer
// enqueue helper that batches inserts every 2 s. The /samples handler
// stamps `req.managedAgent.assetId` on every row — client-supplied assetId
// is intentionally not on the wire shape at all to make the cross-asset
// abuse surface vanishingly small.

const ResponseTimeSampleSchema = z.object({
  timestamp:      z.string().datetime().optional(), // defaults to server clock
  success:        z.boolean(),
  responseTimeMs: z.number().int().nullable().optional(), // null = packet loss
  error:          z.string().max(500).nullable().optional(),
});

const TelemetrySampleSchema = z.object({
  timestamp:     z.string().datetime().optional(),
  cpuPct:        z.number().nullable().optional(),
  memPct:        z.number().nullable().optional(),
  memUsedBytes:  z.number().int().nullable().optional(),
  memTotalBytes: z.number().int().nullable().optional(),
  temperatures:  z.array(z.object({
    sensorName: z.string().max(128),
    celsius:    z.number().nullable(),
  })).optional(),
});

const InterfaceSampleSchema = z.object({
  timestamp:     z.string().datetime().optional(),
  ifName:        z.string().min(1).max(128),
  adminStatus:   z.string().max(32).nullable().optional(),
  operStatus:    z.string().max(32).nullable().optional(),
  speedBps:      z.number().int().nullable().optional(),
  ipAddress:     z.string().max(64).nullable().optional(),
  macAddress:    z.string().max(64).nullable().optional(),
  inOctets:      z.number().int().nullable().optional(),
  outOctets:     z.number().int().nullable().optional(),
  inErrors:      z.number().int().nullable().optional(),
  outErrors:     z.number().int().nullable().optional(),
  ifType:        z.string().max(32).nullable().optional(),
  ifParent:      z.string().max(128).nullable().optional(),
  vlanId:        z.number().int().nullable().optional(),
  alias:         z.string().max(255).nullable().optional(),
  description:   z.string().max(1024).nullable().optional(),
});

const StorageSampleSchema = z.object({
  timestamp:  z.string().datetime().optional(),
  mountPath:  z.string().min(1).max(255),
  totalBytes: z.number().int().nullable().optional(),
  usedBytes:  z.number().int().nullable().optional(),
});

const SamplesBodySchema = z.discriminatedUnion("stream", [
  z.object({ stream: z.literal("responseTime"), samples: z.array(ResponseTimeSampleSchema).min(1).max(500) }),
  z.object({ stream: z.literal("telemetry"),    samples: z.array(TelemetrySampleSchema).min(1).max(500) }),
  z.object({ stream: z.literal("interfaces"),   samples: z.array(InterfaceSampleSchema).min(1).max(5000) }),
  z.object({ stream: z.literal("storage"),      samples: z.array(StorageSampleSchema).min(1).max(500) }),
]);

agentsRouter.post("/samples", async (req, res, next) => {
  try {
    const assetId = req.managedAgent!.assetId;
    const body = SamplesBodySchema.parse(req.body);

    let accepted = 0;
    const now = new Date();

    if (body.stream === "responseTime") {
      for (const s of body.samples) {
        const ts = s.timestamp ? new Date(s.timestamp) : now;
        // Enqueue the time-series sample.
        enqueueMonitorSample({
          assetId,
          timestamp:      ts,
          success:        s.success,
          responseTimeMs: s.success ? (s.responseTimeMs ?? 0) : null,
          error:          s.success ? null : (s.error ?? "Agent reported failure"),
        });
        // Drive the state machine + Asset row fields. opts.fromAgent
        // bypasses the agent-polling guard in recordProbeResult.
        await recordProbeResult(
          assetId,
          s.success
            ? { success: true,  responseTimeMs: s.responseTimeMs ?? 0 }
            : { success: false, responseTimeMs: 0, error: s.error ?? "Agent reported failure" },
          null,
          { fromAgent: true },
        );
        accepted++;
      }
    } else if (body.stream === "telemetry") {
      for (const s of body.samples) {
        const ts = s.timestamp ? new Date(s.timestamp) : now;
        enqueueTelemetrySample({
          assetId,
          timestamp:     ts,
          cpuPct:        s.cpuPct ?? null,
          memPct:        s.memPct ?? null,
          memUsedBytes:  s.memUsedBytes  != null ? BigInt(Math.round(s.memUsedBytes))  : null,
          memTotalBytes: s.memTotalBytes != null ? BigInt(Math.round(s.memTotalBytes)) : null,
        });
        if (s.temperatures && s.temperatures.length > 0) {
          enqueueTemperatureSamples(
            s.temperatures.map((t) => ({ assetId, timestamp: ts, sensorName: t.sensorName, celsius: t.celsius })),
          );
        }
        accepted++;
      }
      // Bump lastTelemetryAt so the System tab reflects freshness.
      await prisma.asset.update({ where: { id: assetId }, data: { lastTelemetryAt: now } });
    } else if (body.stream === "interfaces") {
      const rows = body.samples.map((s) => ({
        assetId,
        timestamp:   s.timestamp ? new Date(s.timestamp) : now,
        ifName:      s.ifName,
        adminStatus: s.adminStatus ?? null,
        operStatus:  s.operStatus ?? null,
        speedBps:    s.speedBps != null ? BigInt(Math.round(s.speedBps)) : null,
        ipAddress:   s.ipAddress ?? null,
        macAddress:  s.macAddress ?? null,
        inOctets:    s.inOctets  != null ? BigInt(Math.round(s.inOctets))  : null,
        outOctets:   s.outOctets != null ? BigInt(Math.round(s.outOctets)) : null,
        inErrors:    s.inErrors  != null ? BigInt(Math.round(s.inErrors))  : null,
        outErrors:   s.outErrors != null ? BigInt(Math.round(s.outErrors)) : null,
        ifType:      s.ifType ?? null,
        ifParent:    s.ifParent ?? null,
        vlanId:      s.vlanId ?? null,
        alias:       s.alias ?? null,
        description: s.description ?? null,
      }));
      enqueueInterfaceSamples(rows);
      accepted = rows.length;
      await prisma.asset.update({ where: { id: assetId }, data: { lastSystemInfoAt: now } });
    } else {
      // storage
      const rows = body.samples.map((s) => ({
        assetId,
        timestamp:  s.timestamp ? new Date(s.timestamp) : now,
        mountPath:  s.mountPath,
        totalBytes: s.totalBytes != null ? BigInt(Math.round(s.totalBytes)) : null,
        usedBytes:  s.usedBytes  != null ? BigInt(Math.round(s.usedBytes))  : null,
      }));
      enqueueStorageSamples(rows);
      accepted = rows.length;
      await prisma.asset.update({ where: { id: assetId }, data: { lastSystemInfoAt: now } });
    }

    res.json({ accepted, rejected: 0 });
  } catch (err) { next(err); }
});

// GET /config — the agent fetches its resolved cadences + which streams it
// should collect. Etag lets the agent issue If-None-Match on subsequent
// polls to short-circuit work when nothing changed.
agentsRouter.get("/config", async (req, res, next) => {
  try {
    const assetId = req.managedAgent!.assetId;
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      include: { discoveredByIntegration: true },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    const eff = await resolveMonitorSettings({
      ...asset,
      discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
    });

    const payload = {
      streams: {
        responseTime: {
          enabled:     eff.responseTimePolling === "agent",
          intervalSec: eff.intervalSeconds,
          timeoutMs:   eff.probeTimeoutMs,
        },
        telemetry: {
          enabled:     eff.telemetryPolling === "agent",
          intervalSec: eff.telemetryIntervalSeconds,
          timeoutMs:   eff.telemetryTimeoutMs,
        },
        interfaces: {
          enabled:     eff.interfacesPolling === "agent",
          intervalSec: eff.systemInfoIntervalSeconds,
          timeoutMs:   eff.systemInfoTimeoutMs,
        },
        lldp: {
          enabled:     eff.lldpPolling === "agent",
          intervalSec: eff.systemInfoIntervalSeconds,
          timeoutMs:   eff.systemInfoTimeoutMs,
        },
      },
      monitored: asset.monitored,
    };
    const etag = computeEtag(payload);

    // Conditional GET — short-circuit when client already has this exact config.
    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader("ETag", etag);
    res.json({ etag, ...payload });
  } catch (err) { next(err); }
});

const HeartbeatSchema = z.object({
  agentVersion: z.string().min(1).max(64).optional(),
});

agentsRouter.post("/heartbeat", async (req, res, next) => {
  try {
    const body = HeartbeatSchema.parse(req.body ?? {});
    const managedAgentId = req.managedAgent!.managedAgentId;
    if (body.agentVersion) {
      await prisma.managedAgent.update({
        where: { id: managedAgentId },
        data:  { agentVersion: body.agentVersion },
      });
    }
    // verifyBearer already bumped lastSeenAt/lastSeenIp opportunistically.
    res.json({ ok: true, configEtag: await computeConfigEtag(req.managedAgent!.assetId) });
  } catch (err) { next(err); }
});

// ─── Helpers ──────────────────────────────────────────────────────────

async function computeConfigEtag(assetId: string): Promise<string> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: { discoveredByIntegration: true },
  });
  if (!asset) return '"deleted"';
  const eff = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  const compact = {
    rt:    [eff.responseTimePolling, eff.intervalSeconds,           eff.probeTimeoutMs],
    tel:   [eff.telemetryPolling,    eff.telemetryIntervalSeconds,  eff.telemetryTimeoutMs],
    ifc:   [eff.interfacesPolling,   eff.systemInfoIntervalSeconds, eff.systemInfoTimeoutMs],
    lldp:  [eff.lldpPolling,         eff.systemInfoIntervalSeconds, eff.systemInfoTimeoutMs],
    mon:   asset.monitored,
  };
  return computeEtag(compact);
}

function computeEtag(payload: unknown): string {
  // Strong etag — the agent only ever fetches /config for itself so cache
  // semantics are simple. Hex digest keeps it short on the wire.
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
  return `"${hash}"`;
}

// Surface debug helper for tests / curl smoke-tests.
export function __debugLogger() { return logger; }
