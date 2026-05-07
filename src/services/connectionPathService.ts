/**
 * src/services/connectionPathService.ts — Endpoint → switch → … → FortiGate
 * connection path resolver.
 *
 * Walks the upward dependency chain from an arbitrary asset back to its
 * upstream FortiGate so the Device Map topology overlay can dim everything
 * off the path. Handles four start-cases: firewall (path is just self),
 * switch / AP (start the upward walk from self), endpoint (parse
 * `lastSeenSwitch` to find the upstream switch first).
 *
 * Source-of-truth for hops above the endpoint:
 *   1. AssetDependencyParent (preferred — handles MCLAG / multi-hop chains;
 *      override rows take precedence over computed per existing convention).
 *   2. fortinetTopology.controllerFortigate / .parentSwitch fallback when no
 *      dependency rows exist yet (fresh installs before backfillDependencyTree
 *      runs, or freshly-discovered switches that haven't been re-recomputed).
 */

import { prisma } from "../db.js";
import type { Asset } from "../generated/prisma/client.js";

export type ConnectionHopKind = "endpoint" | "switch" | "firewall";

export interface ConnectionPathHop {
  kind: ConnectionHopKind;
  id: string;
  hostname: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  assetType: string;
  monitorStatus: string | null;
  monitored: boolean;
  /** Port on this switch where the previous (downstream) hop plugs in.
   *  Populated on the first switch hop after an endpoint, parsed from
   *  `Asset.lastSeenSwitch` ("<switchId>/<portName>"). */
  endpointPort?: string;
  /** Local interface on this switch / AP that goes UP to the next hop.
   *  From `fortinetTopology.uplinkInterface`. */
  uplinkInterface?: string;
}

export interface ConnectionPath {
  asset: {
    id: string;
    hostname: string | null;
    ipAddress: string | null;
    macAddress: string | null;
    assetType: string;
    monitorStatus: string | null;
  };
  hops: ConnectionPathHop[];
  /** Sum across every walked hop of (parents - 1), where >1 parent indicates
   *  MCLAG / dual-homed redundancy. The chosen parent at each hop is the one
   *  with monitorStatus="up" + most recent lastMonitorAt; the rest are tracked
   *  here so the UI can hint "+N alternate uplinks". */
  alternateUplinks: number;
  /** The FortiGate at the top of the chain, when one was reached.
   *  null when the walk terminates without hitting a firewall (orphan asset
   *  with no `lastSeenSwitch`, or upstream chain not yet discovered). */
  siteId: string | null;
}

const MAX_HOPS = 16; // sanity cap against pathological data / cycles

export async function resolveConnectionPath(assetId: string): Promise<ConnectionPath | null> {
  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset) return null;

  const hops: ConnectionPathHop[] = [];
  const seen = new Set<string>([asset.id]);

  // Asset itself is the leaf hop. Kind reflects assetType so the frontend
  // doesn't have to translate again.
  const leafKind: ConnectionHopKind =
    asset.assetType === "firewall" ? "firewall" :
    asset.assetType === "switch" || asset.assetType === "access_point" ? "switch" :
    "endpoint";
  hops.push(toHop(asset, leafKind));

  // Firewall short-circuit.
  if (leafKind === "firewall") {
    return { asset: shapeAsset(asset), hops, alternateUplinks: 0, siteId: asset.id };
  }

  // For endpoints, hop 1 above leaf is the switch resolved from lastSeenSwitch.
  let walkStartId: string | null = null;
  if (leafKind === "endpoint") {
    const parsed = parseLastSeenSwitch(asset.lastSeenSwitch);
    if (parsed) {
      const sw = await findSwitchByName(parsed.switchId);
      if (sw && !seen.has(sw.id)) {
        seen.add(sw.id);
        const swHop = toHop(sw, "switch");
        if (parsed.port) swHop.endpointPort = parsed.port;
        const uplink = uplinkInterfaceOf(sw);
        if (uplink) swHop.uplinkInterface = uplink;
        hops.push(swHop);
        walkStartId = sw.id;
      }
    }
  } else {
    // Switch / AP — walk starts from the leaf itself.
    walkStartId = asset.id;
    const uplink = uplinkInterfaceOf(asset);
    if (uplink) hops[0].uplinkInterface = uplink;
  }

  // Walk upward via dependency tree → firewall.
  let alternateUplinks = 0;
  let cursorId: string | null = walkStartId;
  for (let i = 0; cursorId && i < MAX_HOPS; i++) {
    const parents = await getEffectiveParents(cursorId);
    if (parents.length === 0) {
      // Fallback: read fortinetTopology.controllerFortigate (or parentSwitch
      // for an AP standing in the chain) and resolve it directly.
      const cur = await prisma.asset.findUnique({ where: { id: cursorId } });
      const fallback = await resolveTopologyFallback(cur);
      if (!fallback || seen.has(fallback.id)) break;
      seen.add(fallback.id);
      hops.push(toHop(fallback, fallback.assetType === "firewall" ? "firewall" : "switch"));
      if (fallback.assetType === "firewall") break;
      cursorId = fallback.id;
      continue;
    }
    const sorted = sortParentsByPreference(parents);
    const best = sorted[0];
    if (!best || seen.has(best.id)) break;
    seen.add(best.id);
    alternateUplinks += sorted.length - 1;
    const hopKind: ConnectionHopKind =
      best.assetType === "firewall" ? "firewall" : "switch";
    const hop = toHop(best, hopKind);
    if (hopKind === "switch") {
      const uplink = uplinkInterfaceOf(best);
      if (uplink) hop.uplinkInterface = uplink;
    }
    hops.push(hop);
    if (hopKind === "firewall") break;
    cursorId = best.id;
  }

  const last = hops[hops.length - 1];
  const siteId = last && last.kind === "firewall" ? last.id : null;
  return { asset: shapeAsset(asset), hops, alternateUplinks, siteId };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseLastSeenSwitch(s: string | null): { switchId: string; port: string } | null {
  if (!s) return null;
  const idx = s.indexOf("/");
  if (idx === -1) return { switchId: s.trim(), port: "" };
  return { switchId: s.substring(0, idx).trim(), port: s.substring(idx + 1).trim() };
}

async function findSwitchByName(switchId: string): Promise<Asset | null> {
  // FortiSwitch discovery stamps the device's `switch-id` (a hostname-like
  // FS-XXXX-NN form) into Asset.hostname, and the device serial into
  // Asset.serialNumber. lastSeenSwitch can carry either form depending on
  // which discovery path stamped it; check both.
  return prisma.asset.findFirst({
    where: {
      assetType: "switch",
      OR: [{ hostname: switchId }, { serialNumber: switchId }],
    },
  });
}

async function getEffectiveParents(assetId: string): Promise<Asset[]> {
  const rows = await prisma.assetDependencyParent.findMany({
    where: { assetId },
    include: { parent: true },
  });
  if (rows.length === 0) return [];
  const overrides = rows.filter((r) => r.source === "override");
  const effective = overrides.length > 0 ? overrides : rows.filter((r) => r.source === "computed");
  return effective.map((r) => r.parent);
}

function sortParentsByPreference(parents: Asset[]): Asset[] {
  return [...parents].sort((a, b) => {
    const aUp = a.monitorStatus === "up" ? 0 : 1;
    const bUp = b.monitorStatus === "up" ? 0 : 1;
    if (aUp !== bUp) return aUp - bUp;
    const aLast = a.lastMonitorAt?.getTime() ?? 0;
    const bLast = b.lastMonitorAt?.getTime() ?? 0;
    return bLast - aLast;
  });
}

async function resolveTopologyFallback(asset: Asset | null): Promise<Asset | null> {
  if (!asset) return null;
  const ft = (asset.fortinetTopology as { controllerFortigate?: string; parentSwitch?: string } | null) ?? null;
  if (!ft) return null;
  // For a switch that stamps controllerFortigate, jump straight to the FortiGate.
  if (asset.assetType === "switch" && ft.controllerFortigate) {
    return prisma.asset.findFirst({
      where: { hostname: ft.controllerFortigate, assetType: "firewall" },
    });
  }
  // For an AP that stamps parentSwitch, hop to the switch (which on next loop
  // iteration will jump to its FortiGate via its own dependency rows or
  // controllerFortigate).
  if (asset.assetType === "access_point" && ft.parentSwitch) {
    return prisma.asset.findFirst({
      where: { hostname: ft.parentSwitch, assetType: "switch" },
    });
  }
  if (asset.assetType === "access_point" && ft.controllerFortigate) {
    return prisma.asset.findFirst({
      where: { hostname: ft.controllerFortigate, assetType: "firewall" },
    });
  }
  return null;
}

function uplinkInterfaceOf(asset: Asset): string | undefined {
  const ft = (asset.fortinetTopology as { uplinkInterface?: string } | null) ?? null;
  const v = ft?.uplinkInterface;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function toHop(a: Asset, kind: ConnectionHopKind): ConnectionPathHop {
  return {
    kind,
    id: a.id,
    hostname: a.hostname,
    ipAddress: a.ipAddress,
    macAddress: a.macAddress,
    assetType: a.assetType,
    monitorStatus: a.monitorStatus,
    monitored: a.monitored,
  };
}

function shapeAsset(a: Asset) {
  return {
    id: a.id,
    hostname: a.hostname,
    ipAddress: a.ipAddress,
    macAddress: a.macAddress,
    assetType: a.assetType,
    monitorStatus: a.monitorStatus,
  };
}
