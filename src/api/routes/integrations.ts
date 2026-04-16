/**
 * src/api/routes/integrations.ts — Integration CRUD + connection testing
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { requireAdmin } from "../middleware/auth.js";
import * as fortimanager from "../../services/fortimanagerService.js";
import * as windowsServer from "../../services/windowsServerService.js";
import { isValidIpAddress, ipInCidr, normalizeCidr, cidrContains, cidrOverlaps } from "../../utils/cidr.js";
import type { DiscoveredSubnet } from "../../services/fortimanagerService.js";
import { logEvent } from "./events.js";

const router = Router();

// Track in-flight DHCP discovery per integration — abort previous if re-saved
const activeDiscovery = new Map<string, AbortController>();

// All integration routes require admin
router.use(requireAdmin);

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const FortiManagerConfigSchema = z.object({
  host:      z.string().optional().default(""),
  port:      z.number().int().min(1).max(65535).optional().default(443),
  apiUser:   z.string().optional().default(""),
  apiToken:  z.string().optional().default(""),
  adom:      z.string().optional().default("root"),
  verifySsl: z.boolean().optional().default(false),
  mgmtInterface: z.string().optional().default(""),
  dhcpInclude:   z.array(z.string()).optional().default([]),
  dhcpExclude:   z.array(z.string()).optional().default([]),
});

const WindowsServerConfigSchema = z.object({
  host:      z.string().optional().default(""),
  port:      z.number().int().min(1).max(65535).optional().default(5985),
  username:  z.string().optional().default(""),
  password:  z.string().optional().default(""),
  useSsl:    z.boolean().optional().default(false),
  domain:    z.string().optional().default(""),
  dhcpInclude: z.array(z.string()).optional().default([]),
  dhcpExclude: z.array(z.string()).optional().default([]),
});

const CreateIntegrationSchema = z.discriminatedUnion("type", [
  z.object({
    type:         z.literal("fortimanager"),
    name:         z.string().min(1, "Name is required"),
    config:       FortiManagerConfigSchema,
    enabled:      z.boolean().optional().default(true),
    pollInterval: z.number().int().min(1).max(24).optional().default(4),
  }),
  z.object({
    type:         z.literal("windowsserver"),
    name:         z.string().min(1, "Name is required"),
    config:       WindowsServerConfigSchema,
    enabled:      z.boolean().optional().default(true),
    pollInterval: z.number().int().min(1).max(24).optional().default(4),
  }),
]);

const UpdateIntegrationSchema = z.object({
  name:         z.string().min(1).optional(),
  config:       z.record(z.unknown()).optional(),
  enabled:      z.boolean().optional(),
  pollInterval: z.number().int().min(1).max(24).optional(),
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/v1/integrations
router.get("/", async (_req, res, next) => {
  try {
    const integrations = await prisma.integration.findMany({
      orderBy: { createdAt: "desc" },
    });
    // Strip passwords from the response
    const safe = integrations.map(stripSecret);
    res.json(safe);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/integrations/:id
router.get("/:id", async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({
      where: { id: req.params.id },
    });
    if (!integration) throw new AppError(404, "Integration not found");
    res.json(stripSecret(integration));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations
router.post("/", async (req, res, next) => {
  try {
    const input = CreateIntegrationSchema.parse(req.body);
    const integration = await prisma.integration.create({
      data: {
        type: input.type,
        name: input.name,
        config: input.config as any,
        enabled: input.enabled,
        pollInterval: input.pollInterval,
      },
    });

    logEvent({ action: "integration.created", resourceType: "integration", resourceId: integration.id, resourceName: input.name, actor: (req as any).user?.username, message: `Integration "${input.name}" (${input.type}) created` });

    const response: Record<string, unknown> = stripSecret(integration);

    // Auto-register FortiManager IP as asset/reservation
    if (input.type === "fortimanager" && input.config.host) {
      const registration = await registerFortiManager(input.config.host, input.name, false);
      if (registration?.conflicts?.length) {
        response.conflicts = registration.conflicts;
      }
    }

    // DHCP discovery
    const canDiscover =
      input.enabled !== false &&
      input.config.host &&
      ((input.type === "fortimanager" && (input.config as any).apiToken) ||
       (input.type === "windowsserver" && (input.config as any).username));

    if (canDiscover) {
      activeDiscovery.get(integration.id)?.abort();
      const ac = new AbortController();
      activeDiscovery.set(integration.id, ac);
      logEvent({ action: "integration.discover.started", resourceType: "integration", resourceId: integration.id, resourceName: input.name, actor: (req as any).user?.username, message: `DHCP discovery started for "${input.name}"` });
      try {
        let discovered: DiscoveredSubnet[];
        if (input.type === "windowsserver") {
          discovered = await windowsServer.discoverDhcpScopes(input.config as any, ac.signal);
        } else {
          discovered = await fortimanager.discoverDhcpSubnets(input.config as any, ac.signal);
        }
        const syncResult = await syncDhcpSubnets(integration.id, input.type, discovered);
        response.dhcpDiscovery = syncResult;
        logEvent({ action: "integration.discover.completed", resourceType: "integration", resourceId: integration.id, resourceName: input.name, actor: (req as any).user?.username, message: `DHCP discovery completed for "${input.name}" — ${syncResult.created.length} created, ${syncResult.updated.length} updated, ${syncResult.skipped.length} skipped` });
      } catch (err: any) {
        if (err.name !== "AbortError") {
          response.dhcpDiscoveryError = err.message || "DHCP discovery failed";
          logEvent({ action: "integration.discover.error", resourceType: "integration", resourceId: integration.id, resourceName: input.name, actor: (req as any).user?.username, level: "error", message: `DHCP discovery failed for "${input.name}": ${err.message || "Unknown error"}` });
        }
      } finally {
        activeDiscovery.delete(integration.id);
      }
    }

    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/integrations/:id
router.put("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new AppError(404, "Integration not found");

    const input = UpdateIntegrationSchema.parse(req.body);
    const currentConfig = existing.config as Record<string, unknown>;

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.pollInterval !== undefined) data.pollInterval = input.pollInterval;
    if (input.config) {
      // Merge config — preserve secrets if not re-submitted
      const newConfig = { ...currentConfig, ...input.config };
      if (!input.config.apiToken) {
        newConfig.apiToken = currentConfig.apiToken;
      }
      if (!input.config.password) {
        newConfig.password = currentConfig.password;
      }
      data.config = newConfig;
    }

    const updated = await prisma.integration.update({
      where: { id: req.params.id },
      data,
    });

    logEvent({ action: "integration.updated", resourceType: "integration", resourceId: req.params.id, resourceName: updated.name, actor: (req as any).user?.username, message: `Integration "${updated.name}" updated` });

    const finalConfig = (updated.config as Record<string, unknown>) || {};
    const response: Record<string, unknown> = stripSecret(updated);

    // Auto-register FortiManager IP as asset/reservation
    if (existing.type === "fortimanager" && finalConfig.host && typeof finalConfig.host === "string") {
      const registration = await registerFortiManager(finalConfig.host, updated.name, false);
      if (registration?.conflicts?.length) {
        response.conflicts = registration.conflicts;
      }
    }

    // DHCP discovery
    const canDiscover =
      updated.enabled &&
      finalConfig.host &&
      ((existing.type === "fortimanager" && finalConfig.apiToken) ||
       (existing.type === "windowsserver" && finalConfig.username));

    if (canDiscover) {
      activeDiscovery.get(req.params.id)?.abort();
      const ac = new AbortController();
      activeDiscovery.set(req.params.id, ac);
      logEvent({ action: "integration.discover.started", resourceType: "integration", resourceId: req.params.id, resourceName: updated.name, actor: (req as any).user?.username, message: `DHCP discovery started for "${updated.name}"` });
      try {
        let discovered: DiscoveredSubnet[];
        if (existing.type === "windowsserver") {
          discovered = await windowsServer.discoverDhcpScopes(finalConfig as any, ac.signal);
        } else {
          discovered = await fortimanager.discoverDhcpSubnets(finalConfig as any, ac.signal);
        }
        const syncResult = await syncDhcpSubnets(updated.id, existing.type, discovered);
        response.dhcpDiscovery = syncResult;
        logEvent({ action: "integration.discover.completed", resourceType: "integration", resourceId: req.params.id, resourceName: updated.name, actor: (req as any).user?.username, message: `DHCP discovery completed for "${updated.name}" — ${syncResult.created.length} created, ${syncResult.updated.length} updated, ${syncResult.skipped.length} skipped` });
      } catch (err: any) {
        if (err.name !== "AbortError") {
          response.dhcpDiscoveryError = err.message || "DHCP discovery failed";
          logEvent({ action: "integration.discover.error", resourceType: "integration", resourceId: req.params.id, resourceName: updated.name, actor: (req as any).user?.username, level: "error", message: `DHCP discovery failed for "${updated.name}": ${err.message || "Unknown error"}` });
        }
      } finally {
        activeDiscovery.delete(req.params.id);
      }
    }

    res.json(response);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/integrations/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new AppError(404, "Integration not found");
    await prisma.integration.delete({ where: { id: req.params.id } });
    logEvent({ action: "integration.deleted", resourceType: "integration", resourceId: req.params.id, resourceName: existing.name, actor: (req as any).user?.username, message: `Integration "${existing.name}" deleted` });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/:id/test
router.post("/:id/test", async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({
      where: { id: req.params.id },
    });
    if (!integration) throw new AppError(404, "Integration not found");

    const config = integration.config as Record<string, unknown>;
    let result: { ok: boolean; message: string; version?: string };

    logEvent({ action: "integration.test.started", resourceType: "integration", resourceId: req.params.id, resourceName: integration.name, actor: (req as any).user?.username, message: `Connection test started for "${integration.name}"` });

    if (integration.type === "fortimanager") {
      result = await fortimanager.testConnection(config as any);
    } else if (integration.type === "windowsserver") {
      result = await windowsServer.testConnection(config as any);
    } else {
      result = { ok: false, message: `Unknown integration type: ${integration.type}` };
    }

    // Save test result
    await prisma.integration.update({
      where: { id: req.params.id },
      data: { lastTestAt: new Date(), lastTestOk: result.ok },
    });

    logEvent({ action: "integration.test.completed", resourceType: "integration", resourceId: req.params.id, resourceName: integration.name, actor: (req as any).user?.username, level: result.ok ? "info" : "warning", message: `Connection test ${result.ok ? "succeeded" : "failed"} for "${integration.name}": ${result.message}` });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/:id/register — overwrite selected fields on conflicting reservation
router.post("/:id/register", async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({
      where: { id: req.params.id },
    });
    if (!integration) throw new AppError(404, "Integration not found");

    const config = integration.config as Record<string, unknown>;
    if (!config.host || typeof config.host !== "string") {
      throw new AppError(400, "Integration has no host configured");
    }

    // fields: which proposed fields to apply to the existing reservation
    const fields: string[] = Array.isArray(req.body?.fields) ? req.body.fields : [];
    const result = await registerFortiManager(config.host as string, integration.name, true, fields);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/:id/discover — manually trigger DHCP discovery
router.post("/:id/discover", async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({
      where: { id: req.params.id },
    });
    if (!integration) throw new AppError(404, "Integration not found");

    const config = integration.config as Record<string, unknown>;
    if (!config.host) {
      throw new AppError(400, "Integration has no host configured");
    }
    if (integration.type === "fortimanager" && !config.apiToken) {
      throw new AppError(400, "Integration has no API token configured");
    }
    if (integration.type === "windowsserver" && !config.username) {
      throw new AppError(400, "Integration has no username configured");
    }

    // Abort any in-flight discovery for this integration
    activeDiscovery.get(req.params.id)?.abort();
    const ac = new AbortController();
    activeDiscovery.set(req.params.id, ac);

    logEvent({ action: "integration.discover.started", resourceType: "integration", resourceId: req.params.id, resourceName: integration.name, actor: (req as any).user?.username, message: `Manual DHCP discovery started for "${integration.name}"` });

    try {
      let discovered: DiscoveredSubnet[];
      if (integration.type === "windowsserver") {
        discovered = await windowsServer.discoverDhcpScopes(config as any, ac.signal);
      } else {
        discovered = await fortimanager.discoverDhcpSubnets(config as any, ac.signal);
      }
      const syncResult = await syncDhcpSubnets(integration.id, integration.type, discovered);
      logEvent({ action: "integration.discover.completed", resourceType: "integration", resourceId: req.params.id, resourceName: integration.name, actor: (req as any).user?.username, message: `Manual DHCP discovery completed for "${integration.name}" — ${syncResult.created.length} created, ${syncResult.updated.length} updated, ${syncResult.skipped.length} skipped` });
      res.json(syncResult);
    } catch (err: any) {
      logEvent({ action: "integration.discover.error", resourceType: "integration", resourceId: req.params.id, resourceName: integration.name, actor: (req as any).user?.username, level: "error", message: `Manual DHCP discovery failed for "${integration.name}": ${err.message || "Unknown error"}` });
      throw err;
    } finally {
      activeDiscovery.delete(req.params.id);
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/test — test without saving (for the create form)
router.post("/test", async (req, res, next) => {
  try {
    const input = CreateIntegrationSchema.parse(req.body);
    let result: { ok: boolean; message: string; version?: string };

    if (input.type === "fortimanager") {
      result = await fortimanager.testConnection(input.config);
    } else if (input.type === "windowsserver") {
      result = await windowsServer.testConnection(input.config);
    } else {
      result = { ok: false, message: `Unknown integration type: ${(input as any).type}` };
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isPrivateIp(ip: string): boolean {
  if (!isValidIpAddress(ip)) return false;
  const parts = ip.split(".").map(Number);
  // 10.0.0.0/8
  if (parts[0] === 10) return true;
  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

interface ConflictEntry {
  type: "reservation";
  existing: Record<string, unknown>;
  proposed: Record<string, unknown>;
}

/**
 * Register a FortiManager's IP as a subnet reservation and asset.
 * If force=false, returns conflicts instead of overwriting.
 * If force=true, overwrites selected fields on the existing reservation.
 */
async function registerFortiManager(host: string, integrationName: string, force: boolean, fields: string[] = []) {
  if (!isValidIpAddress(host)) return { conflicts: [], created: [] };

  const subnets = await prisma.subnet.findMany();
  const matchingSubnet = subnets.find((s) => ipInCidr(host, s.cidr));

  if (!matchingSubnet && !isPrivateIp(host)) return { conflicts: [], created: [] };

  const conflicts: ConflictEntry[] = [];
  const created: string[] = [];
  const hostname = integrationName.toLowerCase().replace(/\s+/g, "-");

  // ── Reservation ──
  const proposedReservation = {
    ipAddress: host,
    hostname,
    owner: "network-team",
    projectRef: "FortiManager Integration",
    notes: `Auto-registered from FortiManager integration: ${integrationName}`,
    status: "active",
  };

  if (matchingSubnet) {
    const existingRes = await prisma.reservation.findFirst({
      where: { subnetId: matchingSubnet.id, ipAddress: host, status: "active" },
    });

    if (existingRes) {
      if (force) {
        // Only overwrite the fields the admin selected
        const updateData: Record<string, unknown> = {};
        const allowedFields = ["hostname", "owner", "projectRef", "notes", "status"];
        for (const f of fields) {
          if (allowedFields.includes(f) && f in proposedReservation) {
            updateData[f] = (proposedReservation as Record<string, unknown>)[f];
          }
        }
        if (Object.keys(updateData).length > 0) {
          await prisma.reservation.update({
            where: { id: existingRes.id },
            data: updateData,
          });
        }
        created.push("reservation");
      } else {
        conflicts.push({
          type: "reservation",
          existing: {
            id: existingRes.id,
            ipAddress: existingRes.ipAddress,
            hostname: existingRes.hostname,
            owner: existingRes.owner,
            projectRef: existingRes.projectRef,
            notes: existingRes.notes,
            status: existingRes.status,
            subnetCidr: matchingSubnet.cidr,
          },
          proposed: { ...proposedReservation, subnetCidr: matchingSubnet.cidr },
        });
      }
    } else {
      await prisma.reservation.create({
        data: { subnetId: matchingSubnet.id, ...proposedReservation },
      });
      created.push("reservation");
    }
  }

  // ── Asset (always create — multiple assets may share an IP) ──
  const proposedAsset = {
    ipAddress: host,
    hostname,
    assetType: "server" as const,
    status: "active" as const,
    manufacturer: "Fortinet",
    model: "FortiManager",
    department: "Network Security",
    notes: `Auto-registered from FortiManager integration: ${integrationName}`,
    tags: ["fortimanager", "auto-registered"],
  };

  await prisma.asset.create({ data: proposedAsset });
  created.push("asset");

  return { conflicts, created };
}

/**
 * Sync discovered DHCP subnets into the database.
 * Creates new subnets or updates existing ones with integration/device info.
 */
async function syncDhcpSubnets(integrationId: string, integrationType: string, discovered: DiscoveredSubnet[]) {
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  const blocks = await prisma.ipBlock.findMany();

  for (const entry of discovered) {
    let cidr: string;
    try {
      cidr = normalizeCidr(entry.cidr);
    } catch {
      skipped.push(`${entry.cidr} (invalid CIDR)`);
      continue;
    }

    // Check if subnet already exists
    const existing = await prisma.subnet.findUnique({ where: { cidr } });
    if (existing) {
      await prisma.subnet.update({
        where: { id: existing.id },
        data: { discoveredBy: integrationId, fortigateDevice: entry.fortigateDevice },
      });
      updated.push(cidr);
      continue;
    }

    // Find the most specific parent block that contains this CIDR
    const matchingBlock = blocks
      .filter((b) => cidrContains(b.cidr, cidr))
      .sort((a, b) => {
        const prefixA = parseInt(a.cidr.split("/")[1], 10);
        const prefixB = parseInt(b.cidr.split("/")[1], 10);
        return prefixB - prefixA; // most specific first
      })[0];

    if (!matchingBlock) {
      skipped.push(`${cidr} (no matching parent block)`);
      continue;
    }

    // Check for overlaps with sibling subnets
    const siblings = await prisma.subnet.findMany({
      where: { blockId: matchingBlock.id },
      select: { cidr: true },
    });
    const overlap = siblings.find((s) => cidrOverlaps(s.cidr, cidr));
    if (overlap) {
      skipped.push(`${cidr} (overlaps ${overlap.cidr})`);
      continue;
    }

    // Create the subnet
    try {
      await prisma.subnet.create({
        data: {
          blockId: matchingBlock.id,
          cidr,
          name: `DHCP: ${entry.name} (${entry.fortigateDevice})`,
          purpose: `Discovered from ${integrationType === "windowsserver" ? "Windows Server" : "FortiManager"} DHCP`,
          status: "available",
          discoveredBy: integrationId,
          fortigateDevice: entry.fortigateDevice,
          tags: ["dhcp-discovered", integrationType],
        },
      });
      created.push(cidr);
    } catch {
      // Unique constraint race — treat as update
      try {
        await prisma.subnet.update({
          where: { cidr },
          data: { discoveredBy: integrationId, fortigateDevice: entry.fortigateDevice },
        });
        updated.push(cidr);
      } catch {
        skipped.push(`${cidr} (create failed)`);
      }
    }
  }

  return { created, updated, skipped };
}

function stripSecret(integration: Record<string, any>) {
  const config = { ...(integration.config as Record<string, unknown>) };
  if (config.apiToken) {
    config.apiToken = "••••••••";
  }
  if (config.password) {
    config.password = "••••••••";
  }
  return { ...integration, config };
}

export default router;
