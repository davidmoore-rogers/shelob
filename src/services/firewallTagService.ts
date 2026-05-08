/**
 * src/services/firewallTagService.ts
 *
 * `firewall:<hostname>` breadcrumb tags on FortiGate-discovered assets.
 *
 * Stamps every FortiSwitch / FortiAP / non-infra endpoint with a tag naming the
 * FortiGate it lives behind so operators can filter "everything behind
 * FortiGate-X" from the Assets page tag picker.
 *
 * The reconciler runs at end of every full / finalize FMG / FortiGate
 * discovery run — every input that drives the tag set (the controller
 * hostname on infra, AssetFortigateSighting rows on endpoints, the firewall
 * asset's own hostname, decommission state) is only written by discovery, so
 * end-of-sync is the natural reconciliation point. No periodic safety-net job.
 *
 * Cross-integration safety: the reconciler only strips `firewall:<hostname>`
 * tags whose hostname is one of THIS integration's currently-known FortiGate
 * hostnames. Tags pointing at FortiGates owned by another integration (or
 * operator-typed `firewall:fake`) survive untouched.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { getSightingSettings } from "./assetSightingService.js";

const TAG_PREFIX = "firewall:";
const TAG_CATEGORY = "FortiGate";
const TAG_DEFAULT_COLOR = "#4fc3f7";

const INFRA_TYPES = ["switch", "access_point"] as const;

export interface ReconcileSummary extends Record<string, unknown> {
  integrationId: string;
  added: number;
  removed: number;
  assetsTouched: number;
}

// --- Tag name helpers ---

function firewallTag(hostname: string): string {
  return `${TAG_PREFIX}${hostname}`;
}

function isFirewallTag(tag: string): boolean {
  return tag.startsWith(TAG_PREFIX);
}

// --- Tag registry helpers ---

async function upsertTagRegistry(hostname: string): Promise<void> {
  const tagName = firewallTag(hostname);
  try {
    await prisma.tag.upsert({
      where: { name: tagName },
      update: {},
      create: { name: tagName, category: TAG_CATEGORY, color: TAG_DEFAULT_COLOR },
    });
  } catch (err: any) {
    logger.debug({ err: err?.message ?? String(err), tag: tagName }, "firewallTag: registry upsert failed (non-fatal)");
  }
}

async function deleteTagRegistry(hostname: string): Promise<void> {
  const tagName = firewallTag(hostname);
  try {
    await prisma.tag.deleteMany({ where: { name: tagName } });
  } catch (err: any) {
    logger.debug({ err: err?.message ?? String(err), tag: tagName }, "firewallTag: registry delete failed (non-fatal)");
  }
}

// --- Asset tag mutation primitives ---

async function removeTagFromAllAssets(tag: string): Promise<number> {
  const rows = await prisma.asset.findMany({
    where: { tags: { has: tag } },
    select: { id: true, tags: true },
  });
  for (const row of rows) {
    const tags = Array.isArray(row.tags) ? row.tags : [];
    await prisma.asset.update({
      where: { id: row.id },
      data: { tags: tags.filter((t) => t !== tag) },
    });
  }
  return rows.length;
}

// --- Topology reader ---

interface TopologyMeta {
  role?: "fortigate" | "fortiswitch" | "fortiap";
  controllerFortigate?: string | null;
}

function readTopology(raw: unknown): TopologyMeta {
  if (raw && typeof raw === "object") return raw as TopologyMeta;
  return {};
}

// --- Public API ---

/**
 * Idempotent. Called from the Phase 3 firewall create branch so the tag picker
 * carries the entry from the moment a FortiGate is first discovered, before
 * the first reconciler tick lands.
 */
export async function seedFirewallTagRegistry(hostname: string | null | undefined): Promise<void> {
  const trimmed = (hostname || "").trim();
  if (!trimmed) return;
  await upsertTagRegistry(trimmed);
}

/**
 * Strip the old hostname's tag from every asset, add the new one to the same
 * set, and rotate the registry row. Called from the Phase 3 firewall update
 * branch when the projected hostname differs from the existing value.
 */
export async function applyFirewallRename(
  oldHostname: string | null | undefined,
  newHostname: string | null | undefined,
): Promise<{ renamedAssets: number }> {
  const oldH = (oldHostname || "").trim();
  const newH = (newHostname || "").trim();
  if (!oldH || !newH || oldH === newH) return { renamedAssets: 0 };

  const oldTag = firewallTag(oldH);
  const newTag = firewallTag(newH);

  const rows = await prisma.asset.findMany({
    where: { tags: { has: oldTag } },
    select: { id: true, tags: true },
  });
  for (const row of rows) {
    const tags = Array.isArray(row.tags) ? row.tags : [];
    const next = tags.filter((t) => t !== oldTag);
    if (!next.includes(newTag)) next.push(newTag);
    await prisma.asset.update({ where: { id: row.id }, data: { tags: next } });
  }

  await deleteTagRegistry(oldH);
  await upsertTagRegistry(newH);

  return { renamedAssets: rows.length };
}

/**
 * Strip `firewall:<hostname>` from every asset that carries it and remove the
 * registry row. Called from Phase 2a's per-decommissioned-firewall loop so a
 * removed FortiGate stops being a filterable option immediately.
 */
export async function applyFirewallDecommission(
  hostname: string | null | undefined,
): Promise<{ strippedAssets: number }> {
  const trimmed = (hostname || "").trim();
  if (!trimmed) return { strippedAssets: 0 };
  const stripped = await removeTagFromAllAssets(firewallTag(trimmed));
  await deleteTagRegistry(trimmed);
  return { strippedAssets: stripped };
}

/**
 * Rebuild the `firewall:*` tag set per asset for the scope of one integration.
 *
 * Inputs (all written by discovery):
 *   - Asset.fortinetTopology.controllerFortigate — single tag per
 *     FortiSwitch / FortiAP, tracking its current controller.
 *   - AssetFortigateSighting (filtered by integrationId, lastSeen within
 *     sightingMaxAgeDays) — multi-tag possible per endpoint when sighted on
 *     multiple FortiGates within the freshness window.
 *
 * Strip allowlist: only `firewall:<hostname>` tags whose hostname is one of
 * THIS integration's active firewall hostnames are eligible to be removed.
 * Tags pointing at FortiGates owned by other integrations or typed manually
 * by an operator survive untouched.
 *
 * Idempotent: writes only when the tag array actually differs.
 */
export async function reconcileFirewallTagsForIntegration(
  integrationId: string,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { integrationId, added: 0, removed: 0, assetsTouched: 0 };

  // --- 1. Active firewalls owned by this integration ---
  const firewalls = await prisma.asset.findMany({
    where: {
      assetType: "firewall",
      discoveredByIntegrationId: integrationId,
      status: { not: "decommissioned" },
    },
    select: { id: true, hostname: true },
  });

  // Strip allowlist: hostnames whose `firewall:<hostname>` tag we may remove
  // when the asset shouldn't carry it. Tags for hostnames outside this set
  // are out of scope for this integration's reconcile and are left alone.
  const ownedHostnames = new Set<string>();
  for (const fw of firewalls) {
    const h = (fw.hostname || "").trim();
    if (h) ownedHostnames.add(h);
  }
  const ownedTags = new Set<string>(Array.from(ownedHostnames).map((h) => firewallTag(h)));

  // Idempotent registry maintenance — covers fresh-install case where a
  // periodic re-tick or future reconciler call still needs the picker entries.
  for (const h of ownedHostnames) {
    await upsertTagRegistry(h);
  }

  // --- 2. Compute expected tag set per asset ---
  const expectedByAsset = new Map<string, Set<string>>();
  const ensureExpected = (assetId: string): Set<string> => {
    let set = expectedByAsset.get(assetId);
    if (!set) {
      set = new Set<string>();
      expectedByAsset.set(assetId, set);
    }
    return set;
  };

  // Infra: FortiSwitches / FortiAPs discovered by this integration whose
  // controllerFortigate is one of this integration's active firewalls.
  const infra = await prisma.asset.findMany({
    where: {
      assetType: { in: [...INFRA_TYPES] },
      discoveredByIntegrationId: integrationId,
    },
    select: { id: true, fortinetTopology: true },
  });
  for (const a of infra) {
    const topo = readTopology(a.fortinetTopology);
    const ctrl = (topo.controllerFortigate || "").trim();
    if (!ctrl) continue;
    if (!ownedHostnames.has(ctrl)) continue;
    ensureExpected(a.id).add(firewallTag(ctrl));
  }

  // Endpoints: every recent sighting on one of this integration's FortiGates.
  const { sightingMaxAgeDays } = await getSightingSettings();
  const sightingFilter: Record<string, unknown> = { integrationId };
  if (sightingMaxAgeDays > 0) {
    const cutoff = new Date(Date.now() - sightingMaxAgeDays * 24 * 60 * 60 * 1000);
    sightingFilter.lastSeen = { gte: cutoff };
  }
  const sightings = await prisma.assetFortigateSighting.findMany({
    where: sightingFilter,
    select: {
      assetId: true,
      fortigateDevice: true,
      asset: { select: { assetType: true } },
    },
  });
  for (const s of sightings) {
    if (!s.asset) continue;
    if (s.asset.assetType === "firewall") continue; // never tag a FortiGate with itself
    if (s.asset.assetType === "switch" || s.asset.assetType === "access_point") continue; // infra path owns its own attribution
    const device = (s.fortigateDevice || "").trim();
    if (!device || !ownedHostnames.has(device)) continue;
    ensureExpected(s.assetId).add(firewallTag(device));
  }

  // --- 3. Diff against current tags & write per-asset deltas ---
  // Pull current tags for: every asset with a non-empty expected set, plus
  // every asset that already carries one of this integration's owned tags
  // (covers strip-only cases where the asset moved out from behind the
  // FortiGate and the expected set is now empty).
  const candidateIds = new Set<string>(expectedByAsset.keys());
  if (ownedTags.size > 0) {
    const currentlyTagged = await prisma.asset.findMany({
      where: { tags: { hasSome: Array.from(ownedTags) } },
      select: { id: true },
    });
    for (const r of currentlyTagged) candidateIds.add(r.id);
  }
  if (candidateIds.size === 0) return summary;

  const current = await prisma.asset.findMany({
    where: { id: { in: Array.from(candidateIds) } },
    select: { id: true, tags: true },
  });
  for (const row of current) {
    const tags = Array.isArray(row.tags) ? [...row.tags] : [];
    const expected = expectedByAsset.get(row.id) ?? new Set<string>();
    const next: string[] = [];
    let removed = 0;

    // Carry every non-firewall tag through, plus firewall:* tags that point
    // at FortiGates outside this integration's allowlist.
    for (const t of tags) {
      if (!isFirewallTag(t)) {
        next.push(t);
        continue;
      }
      if (ownedTags.has(t)) {
        if (expected.has(t)) {
          next.push(t);
        } else {
          removed++;
        }
        continue;
      }
      // firewall:* tag for some other integration / operator-typed → keep.
      next.push(t);
    }

    let added = 0;
    for (const t of expected) {
      if (!next.includes(t)) {
        next.push(t);
        added++;
      }
    }

    if (added === 0 && removed === 0) continue;
    await prisma.asset.update({ where: { id: row.id }, data: { tags: next } });
    summary.added += added;
    summary.removed += removed;
    summary.assetsTouched += 1;
  }

  return summary;
}
