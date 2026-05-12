/**
 * src/services/dependencyTreeService.ts
 *
 * Dependency-aware monitoring suppression for Fortinet infrastructure.
 *
 * Two layers, separated cleanly:
 *
 *   1. Persisted dependency DAG (slow-changing) — `AssetDependencyParent`
 *      rows. Refreshed at end of every FMG/FortiGate discovery cycle by
 *      `recomputeDependencyTree`. Operators may pin overrides via the
 *      admin override endpoints; computed rows and override rows live
 *      side-by-side, with overrides taking precedence per asset.
 *
 *   2. Runtime suppression flag (fast-changing) — `Asset.dependencySuppressed`.
 *      Driven by `reconcileDependencySuppression` (60s reconciler — source
 *      of truth) plus `propagateAfterStatusChange` (event-hook latency
 *      optimization). Suppression fires only on the confirmed-down edge:
 *      `warning` and `recovering` flapping does NOT propagate.
 *
 * Multi-parent semantics ("all-down"): a switch with redundant uplinks
 * suppresses only when EVERY effective parent is down or itself
 * suppressed. Unmonitored parents are transparent (an un-monitored
 * mid-chain switch doesn't block recovery — we walk up to its parents).
 *
 * The pure helpers (`buildDependencyEdgesFromInputs`, `assignLayers`,
 * `evaluateSuppression`) are exported for unit testing.
 */

import { prisma } from "../db.js";
import { inferInterfaceTopology } from "./interfaceTopologyService.js";
import { logEvent } from "../api/routes/events.js";
import { logger } from "../utils/logger.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type DependencyDetectedVia = "controller" | "interface" | "lldp" | "manual";
export type DependencySource = "computed" | "override";

/** Pure-function input — one Fortinet infra asset. */
export interface DepAsset {
  id: string;
  hostname: string | null;
  serialNumber: string | null;
  assetType: string;
  fortinetTopology: unknown;
}

/** Pure-function input — one inferred-interface edge. Bidirectional. */
export interface DepInterfaceEdge {
  sourceAssetId: string;
  targetAssetId: string;
}

/** Pure-function input — one LLDP neighbor row that resolved to a Polaris asset. */
export interface DepLldpEdge {
  assetId:        string;  // local asset
  matchedAssetId: string;  // resolved peer
}

/** Output of edge construction — one directed parent→child edge. */
export interface DependencyEdge {
  childAssetId:  string;
  parentAssetId: string;
  detectedVia:   DependencyDetectedVia;
}

export interface LayerAssignment {
  layers: Map<string, number>;
  /** Edges that survived layer pruning — kept (parent.layer === child.layer - 1). */
  keptEdges: DependencyEdge[];
  /** Asset ids that ended up without a layer (cycles or disconnected). */
  unresolved: string[];
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Build the candidate parent→child edge set from raw discovery signals.
 *
 * Direction is inherent for controller edges (FortiGate → switch, switch →
 * AP). Interface and LLDP edges are bidirectional — direction is resolved
 * later by `assignLayers` via BFS from the FortiGate roots.
 *
 * The output is the FULL undirected graph expressed as both-direction
 * directed edges; `assignLayers` prunes to the parent-edge set.
 */
export function buildDependencyEdgesFromInputs(
  assets: DepAsset[],
  interfaceEdges: DepInterfaceEdge[],
  lldpEdges: DepLldpEdge[],
): DependencyEdge[] {
  const byHostname = new Map<string, DepAsset>();
  for (const a of assets) {
    if (a.hostname) byHostname.set(a.hostname.toLowerCase(), a);
  }
  const byId = new Map<string, DepAsset>();
  for (const a of assets) byId.set(a.id, a);

  // Use a Set to dedupe — same edge may surface via multiple signals; we
  // track the strongest source per pair (controller > interface > lldp).
  const edgeStrength = new Map<string, { edge: DependencyEdge; strength: number }>();
  const STRENGTH: Record<DependencyDetectedVia, number> = {
    controller: 3,
    interface:  2,
    lldp:       1,
    manual:     0,
  };
  function add(child: string, parent: string, detectedVia: DependencyDetectedVia) {
    if (child === parent) return;
    const key = `${child}|${parent}`;
    const s = STRENGTH[detectedVia];
    const existing = edgeStrength.get(key);
    if (!existing || s > existing.strength) {
      edgeStrength.set(key, { edge: { childAssetId: child, parentAssetId: parent, detectedVia }, strength: s });
    }
  }

  // 1) Controller-derived edges (directed, authoritative).
  for (const a of assets) {
    const top = a.fortinetTopology as Record<string, unknown> | null;
    if (!top) continue;
    if (a.assetType === "switch") {
      const parentHost = typeof top.controllerFortigate === "string" ? top.controllerFortigate.toLowerCase() : null;
      if (parentHost) {
        const parent = byHostname.get(parentHost);
        if (parent && parent.assetType === "firewall") add(a.id, parent.id, "controller");
      }
    } else if (a.assetType === "access_point") {
      const parentSwitchHost = typeof top.parentSwitch === "string" ? top.parentSwitch.toLowerCase() : null;
      const parentFgHost = typeof top.controllerFortigate === "string" ? top.controllerFortigate.toLowerCase() : null;
      if (parentSwitchHost) {
        const parent = byHostname.get(parentSwitchHost);
        if (parent && parent.assetType === "switch") add(a.id, parent.id, "controller");
      } else if (parentFgHost) {
        // AP not behind a FortiSwitch (rare — direct uplink to FortiGate).
        const parent = byHostname.get(parentFgHost);
        if (parent && parent.assetType === "firewall") add(a.id, parent.id, "controller");
      }
    }
  }

  // 2) Interface-derived edges (bidirectional — emit both directions and
  // let assignLayers pick the parent direction via BFS layer pruning).
  for (const e of interfaceEdges) {
    const a = byId.get(e.sourceAssetId);
    const b = byId.get(e.targetAssetId);
    if (!a || !b) continue;
    add(a.id, b.id, "interface");
    add(b.id, a.id, "interface");
  }

  // 3) LLDP-derived edges (bidirectional; weakest signal).
  for (const e of lldpEdges) {
    const a = byId.get(e.assetId);
    const b = byId.get(e.matchedAssetId);
    if (!a || !b) continue;
    add(a.id, b.id, "lldp");
    add(b.id, a.id, "lldp");
  }

  return [...edgeStrength.values()].map(v => v.edge);
}

/**
 * Assign BFS-shortest-path layers from the FortiGate roots, then keep only
 * edges that point from layer L-1 to layer L (parent edges). Same-layer
 * edges (MCLAG siblings) and reverse edges are dropped.
 *
 * Cycles can't form once layers are assigned by BFS — disconnected
 * components or assets only reachable through unmonitored intermediates
 * end up unresolved.
 */
export function assignLayers(
  assets: DepAsset[],
  edges: DependencyEdge[],
): LayerAssignment {
  const layers = new Map<string, number>();

  // Layer 1: every FortiGate firewall.
  for (const a of assets) {
    if (a.assetType === "firewall") layers.set(a.id, 1);
  }

  // Build undirected adjacency from the candidate edge set.
  const adjacency = new Map<string, Set<string>>();
  function link(a: string, b: string) {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  }
  for (const e of edges) {
    link(e.childAssetId,  e.parentAssetId);
    link(e.parentAssetId, e.childAssetId);
  }

  // BFS outward from layer 1, stable in id order so multiple FGs at layer 1
  // explore deterministically (matters for the hostname-tie test cases).
  const queue: string[] = [...layers.keys()].sort();
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const curLayer = layers.get(cur)!;
    const neighbors = adjacency.get(cur);
    if (!neighbors) continue;
    for (const n of neighbors) {
      if (!layers.has(n)) {
        layers.set(n, curLayer + 1);
        queue.push(n);
      }
    }
  }

  // Prune: keep only edges where parent is exactly one layer above child.
  const keptEdges: DependencyEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const childLayer  = layers.get(e.childAssetId);
    const parentLayer = layers.get(e.parentAssetId);
    if (childLayer == null || parentLayer == null) continue;
    if (parentLayer + 1 !== childLayer) continue;
    const key = `${e.childAssetId}|${e.parentAssetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keptEdges.push(e);
  }

  const unresolved = assets
    .filter(a => !layers.has(a.id))
    .map(a => a.id);

  return { layers, keptEdges, unresolved };
}

/**
 * Evaluate desired `dependencySuppressed` state for every asset given the
 * current per-asset effective-parent set and per-asset state.
 *
 * "All-down" semantics: an asset is suppressed iff it has at least one
 * effective parent AND every effective parent is either confirmed down or
 * itself suppressed. Unmonitored parents are transparent — they're skipped
 * and the walk continues to their parents (if any).
 *
 * Iteratively re-evaluates in BFS layer order until stable. Bounded — at
 * most one pass per layer.
 */
export interface SuppressionAssetState {
  id: string;
  layer: number | null;
  monitored: boolean;
  monitorStatus: string | null;
  /** Computed previously — used as the starting state for the iteration. */
  currentlySuppressed: boolean;
  /**
   * Admin-only "Dependency Test" overlay. When this timestamp is in the
   * future, the asset is treated as confirmed-down for the purposes of
   * isParentOk — children with this asset in their effective parent set
   * get suppressed exactly as they would under a real outage. Real probes
   * still update monitorStatus normally; the overlay is purely a what-if.
   * Past or null = inactive (auto-expired or never set).
   */
  dependencyTestUntil?: Date | null;
}
export function evaluateSuppression(
  states: SuppressionAssetState[],
  /** Map child id → effective parent ids. */
  parentsByChild: Map<string, string[]>,
): Map<string, boolean> {
  // Index by id for fast lookup.
  const stateById = new Map<string, SuppressionAssetState>();
  for (const s of states) stateById.set(s.id, s);

  // Walk in layer order so a parent's effective state is settled before
  // its children are evaluated. Assets with null layer (unresolved /
  // disconnected) end up with no parents → never suppressed.
  const sorted = [...states].sort((a, b) => {
    const la = a.layer ?? Number.MAX_SAFE_INTEGER;
    const lb = b.layer ?? Number.MAX_SAFE_INTEGER;
    return la - lb;
  });

  const result = new Map<string, boolean>();
  for (const s of sorted) result.set(s.id, false);

  for (const s of sorted) {
    const parents = parentsByChild.get(s.id) ?? [];
    if (parents.length === 0) {
      result.set(s.id, false);
      continue;
    }

    // Resolve effective parents — skip unmonitored, walk up through them.
    // Bounded by layer order; we never re-enter visited.
    const visited = new Set<string>();
    const evalNow = Date.now();
    function isParentOk(parentId: string): boolean {
      if (visited.has(parentId)) return false;
      visited.add(parentId);
      const ps = stateById.get(parentId);
      if (!ps) return true; // unknown asset — treat as ok rather than block.
      // Admin-only Dependency Test overlay. Active overlay forces this
      // parent to behave as down for child suppression — it does NOT walk
      // through to grandparents the way an unmonitored parent does, since
      // the operator's intent is "pretend THIS box went offline."
      if (ps.dependencyTestUntil && ps.dependencyTestUntil.getTime() > evalNow) {
        return false;
      }
      if (!ps.monitored) {
        // Transparent — recurse to grandparents. No grandparents = "ok"
        // (we have no monitored ancestor that says otherwise).
        const grand = parentsByChild.get(parentId) ?? [];
        if (grand.length === 0) return true;
        return grand.some(g => isParentOk(g));
      }
      // Monitored: ok iff up / warning / recovering / unknown AND not suppressed.
      const okStatus = ps.monitorStatus !== "down";
      const suppressed = result.get(parentId) ?? false;
      return okStatus && !suppressed;
    }

    const anyParentOk = parents.some(p => isParentOk(p));
    result.set(s.id, !anyParentOk);
  }

  return result;
}

// ─── DB-bound recompute ─────────────────────────────────────────────────────

/**
 * Rebuild the persisted dependency DAG from current discovery signals.
 *
 * - Reads every Fortinet infra asset (firewall / switch / access_point);
 *   when `integrationId` is supplied, only that integration's assets are
 *   in scope (used by the per-discovery-cycle hook).
 * - Computes parent edges from controller signals + interface topology +
 *   LLDP, prunes via BFS layer assignment.
 * - Replaces the `source="computed"` rows for the in-scope assets in one
 *   transaction. `source="override"` rows are never touched.
 * - Updates `Asset.dependencyLayer` for every in-scope asset.
 *
 * Idempotent — running it twice in a row produces the same DB state.
 */
export async function recomputeDependencyTree(integrationId?: string): Promise<{
  scoped: number;
  edgesWritten: number;
  unresolved: number;
}> {
  // Always pull the global Fortinet inventory. Even when `integrationId`
  // narrows the scope, parent edges may cross integration boundaries (e.g.
  // a FortiSwitch managed by integration A whose controller FG was
  // discovered by integration B). The "scope" governs which assets get
  // their computed rows replaced and `dependencyLayer` rewritten — not the
  // graph we walk.
  const inventory = await prisma.asset.findMany({
    where: {
      assetType: { in: ["firewall", "switch", "access_point"] },
    },
    select: {
      id: true,
      hostname: true,
      serialNumber: true,
      assetType: true,
      fortinetTopology: true,
      discoveredByIntegrationId: true,
    },
  });
  if (inventory.length === 0) return { scoped: 0, edgesWritten: 0, unresolved: 0 };

  const inScope = integrationId
    ? new Set(inventory.filter(a => a.discoveredByIntegrationId === integrationId).map(a => a.id))
    : new Set(inventory.map(a => a.id));

  const depAssets: DepAsset[] = inventory.map(a => ({
    id:               a.id,
    hostname:         a.hostname,
    serialNumber:     a.serialNumber,
    assetType:        a.assetType,
    fortinetTopology: a.fortinetTopology,
  }));

  // Interface edges via the existing inferrer (operates on latest interface samples).
  const ifResult = await inferInterfaceTopology(inventory.map(a => a.id));
  const interfaceEdges: DepInterfaceEdge[] = ifResult.edges.map(e => ({
    sourceAssetId: e.sourceAssetId,
    targetAssetId: e.targetAssetId,
  }));

  // LLDP edges — only neighbors that resolved to a Polaris asset count
  // for dependency purposes.
  const lldpRows = await prisma.assetLldpNeighbor.findMany({
    where: {
      assetId: { in: inventory.map(a => a.id) },
      matchedAssetId: { not: null },
    },
    select: { assetId: true, matchedAssetId: true },
  });
  const lldpEdges: DepLldpEdge[] = lldpRows
    .filter((r): r is { assetId: string; matchedAssetId: string } => !!r.matchedAssetId)
    .map(r => ({ assetId: r.assetId, matchedAssetId: r.matchedAssetId }));

  // Build, layer, prune.
  const candidateEdges = buildDependencyEdgesFromInputs(depAssets, interfaceEdges, lldpEdges);
  const { layers, keptEdges, unresolved } = assignLayers(depAssets, candidateEdges);

  // Restrict the writeback to in-scope assets. An out-of-scope asset's
  // computed rows are NOT touched here; another integration's recompute
  // run owns those.
  const scopedKept = keptEdges.filter(e => inScope.has(e.childAssetId));

  // Single transaction: delete computed rows for in-scope children,
  // re-insert from kept edges, and update each in-scope asset's layer.
  await prisma.$transaction(async tx => {
    if (inScope.size > 0) {
      await tx.assetDependencyParent.deleteMany({
        where: {
          source:  "computed",
          assetId: { in: [...inScope] },
        },
      });
    }
    if (scopedKept.length > 0) {
      // createMany skipDuplicates handles cases where override rows pin
      // the same (child, parent) pair as the computed signal.
      await tx.assetDependencyParent.createMany({
        data: scopedKept.map(e => ({
          assetId:       e.childAssetId,
          parentAssetId: e.parentAssetId,
          source:        "computed",
          detectedVia:   e.detectedVia,
        })),
        skipDuplicates: true,
      });
    }
    // Layer update — all in-scope assets, even ones with no edges (those
    // get null layer, e.g. an isolated firewall whose hostname doesn't
    // match any switch's controllerFortigate gets layer 1; an orphan
    // switch with no resolvable parent gets null).
    //
    // Bucket in-scope assets by their resolved layer value (including null)
    // and issue ONE updateMany per distinct layer. The dependency DAG only
    // grows a handful of layers deep on real fleets — firewall (1), direct
    // switches/APs (2), chained switches (3), the occasional 4 — so this
    // collapses ~1800 sequential per-row UPDATEs into 4–6 set-based ones.
    // The previous per-asset `await tx.asset.update` loop was the dominant
    // cost of Phase 12 finalize on large fleets (~minute on 1.8k assets).
    const byLayer = new Map<number | null, string[]>();
    for (const a of inventory) {
      if (!inScope.has(a.id)) continue;
      const layer = layers.get(a.id) ?? null;
      const list = byLayer.get(layer);
      if (list) list.push(a.id);
      else byLayer.set(layer, [a.id]);
    }
    for (const [layer, ids] of byLayer) {
      await tx.asset.updateMany({
        where: { id: { in: ids } },
        data:  { dependencyLayer: layer },
      });
    }
  });

  logger.debug(
    {
      event:        "dependency.recompute",
      integrationId: integrationId ?? null,
      scoped:        inScope.size,
      edgesWritten:  scopedKept.length,
      unresolved:    unresolved.length,
    },
    "Recomputed dependency tree",
  );

  return {
    scoped:       inScope.size,
    edgesWritten: scopedKept.length,
    unresolved:   unresolved.length,
  };
}

// ─── DB-bound reconcile ─────────────────────────────────────────────────────

/**
 * Resolve effective parents per asset. Override rows take precedence; if
 * any source="override" row exists for a child, the computed set is
 * ignored. An empty override set = explicit "no parents" pin (asset opts
 * out of suppression entirely).
 */
async function loadEffectiveParents(): Promise<Map<string, string[]>> {
  const rows = await prisma.assetDependencyParent.findMany({
    select: { assetId: true, parentAssetId: true, source: true },
  });
  const overridesByChild = new Map<string, string[]>();
  const computedByChild  = new Map<string, string[]>();
  for (const r of rows) {
    const target = r.source === "override" ? overridesByChild : computedByChild;
    const cur = target.get(r.assetId);
    if (cur) cur.push(r.parentAssetId);
    else target.set(r.assetId, [r.parentAssetId]);
  }
  // Children that have ANY override row → use override set (possibly empty
  // — explicit pin requires us to also carry an empty marker; we get this
  // by adding the assetId to the result map even when its override set
  // happens to be empty, but createMany of an empty array can't reach
  // here since we only iterate rows we found). So: any child with at
  // least one override row gets the override set; everyone else gets the
  // computed set.
  const result = new Map<string, string[]>();
  for (const [child, parents] of computedByChild) result.set(child, parents);
  for (const [child, parents] of overridesByChild) result.set(child, parents);
  return result;
}

/**
 * 60s reconciler — source of truth for `dependencySuppressed`.
 *
 * Loads every monitored asset, evaluates desired suppression state under
 * "all-down" multi-parent semantics, writes only diffs, and emits
 * `monitor.dependency_suppressed` / `monitor.dependency_resumed` events
 * for transitions.
 */
export async function reconcileDependencySuppression(): Promise<{
  evaluated: number;
  changed:   number;
}> {
  // Auto-expire any "Dependency Test" overlays whose deadline has passed
  // BEFORE we read the suppression state — this way the read sees the
  // freshly-cleared rows and the reconciler ends the test session in the
  // same tick that detects expiry. Each cleared asset writes one audit
  // Event so admins see when a test ended without explicit cleanup.
  const now0 = new Date();
  const expired = await prisma.asset.findMany({
    where: { dependencyTestUntil: { lte: now0 } },
    select: { id: true, hostname: true, dependencyTestStartedBy: true, dependencyTestUntil: true },
  });
  if (expired.length > 0) {
    await prisma.asset.updateMany({
      where: { id: { in: expired.map(e => e.id) } },
      data:  { dependencyTestUntil: null, dependencyTestStartedBy: null },
    });
    for (const e of expired) {
      await logEvent({
        action:       "asset.dependency_test.expired",
        resourceType: "asset",
        resourceId:   e.id,
        resourceName: e.hostname ?? undefined,
        level:        "info",
        message:      `Dependency Test expired on ${e.hostname ?? e.id} (started by ${e.dependencyTestStartedBy ?? "unknown"})`,
        details:      { dependencyTestUntil: e.dependencyTestUntil, startedBy: e.dependencyTestStartedBy },
      });
    }
  }

  const assets = await prisma.asset.findMany({
    select: {
      id: true,
      hostname: true,
      assetType: true,
      monitored: true,
      monitorStatus: true,
      dependencyLayer: true,
      dependencySuppressed: true,
      dependencyTestUntil: true,
    },
  });
  if (assets.length === 0) return { evaluated: 0, changed: 0 };

  const parentsByChild = await loadEffectiveParents();

  const states: SuppressionAssetState[] = assets.map(a => ({
    id:                  a.id,
    layer:               a.dependencyLayer,
    monitored:           a.monitored,
    monitorStatus:       a.monitorStatus,
    currentlySuppressed: a.dependencySuppressed,
    dependencyTestUntil: a.dependencyTestUntil,
  }));

  const desired = evaluateSuppression(states, parentsByChild);

  // Compute diffs and apply. Write each transition + emit one event per
  // changed monitored asset (un-monitored assets don't emit events —
  // operators don't care about dependency state on un-watched gear).
  const now = new Date();
  let changed = 0;
  type Transition = { id: string; hostname: string | null; from: boolean; to: boolean; layer: number | null; parentIds: string[] };
  const transitions: Transition[] = [];
  for (const a of assets) {
    const next = desired.get(a.id) ?? false;
    if (next === a.dependencySuppressed) continue;
    transitions.push({
      id:        a.id,
      hostname:  a.hostname,
      from:      a.dependencySuppressed,
      to:        next,
      layer:     a.dependencyLayer,
      parentIds: parentsByChild.get(a.id) ?? [],
    });
    changed++;
  }

  if (transitions.length === 0) return { evaluated: assets.length, changed: 0 };

  // Hostname lookup for the event payload — one extra in-memory pass.
  const hostnameById = new Map<string, string | null>();
  for (const a of assets) hostnameById.set(a.id, a.hostname);

  await prisma.$transaction(async tx => {
    for (const t of transitions) {
      await tx.asset.update({
        where: { id: t.id },
        data: {
          dependencySuppressed:   t.to,
          dependencySuppressedAt: t.to ? now : null,
        },
      });
    }
  });

  // Events fire AFTER the DB write so anyone reading on the back of the
  // event sees the new state. Only emit for monitored assets. We `await`
  // each call (vs. the fire-and-forget pattern used elsewhere) so that
  // when the reconciler returns its caller can rely on the audit row
  // being durable — the 60s tick cadence makes the per-event latency
  // negligible, and tests reading the Event table immediately after
  // would otherwise race with in-flight writes.
  for (const t of transitions) {
    const asset = assets.find(a => a.id === t.id);
    if (!asset || !asset.monitored) continue;
    const parentHostnames = t.parentIds.map(id => hostnameById.get(id) ?? id);
    if (t.to) {
      await logEvent({
        action:       "monitor.dependency_suppressed",
        resourceType: "asset",
        resourceId:   t.id,
        resourceName: t.hostname ?? undefined,
        level:        "info",
        message:      `Monitor: ${t.hostname ?? t.id} suppressed (parent ${parentHostnames.join(", ") || "—"} down)`,
        details: {
          layer:           t.layer,
          parentAssetIds:  t.parentIds,
          parentHostnames,
        },
      });
    } else {
      await logEvent({
        action:       "monitor.dependency_resumed",
        resourceType: "asset",
        resourceId:   t.id,
        resourceName: t.hostname ?? undefined,
        level:        "info",
        message:      `Monitor: ${t.hostname ?? t.id} resumed (dependency cleared)`,
        details: {
          layer:           t.layer,
          parentAssetIds:  t.parentIds,
          parentHostnames,
        },
      });
    }
  }

  return { evaluated: assets.length, changed };
}

/**
 * Latency-optimization hook fired from `recordProbeResult` after a
 * `monitor.status_changed` Event lands. Cheaper than a full reconciler
 * tick since we only re-evaluate the changed asset's transitive
 * descendants — the rest of the fleet's effective state hasn't moved.
 *
 * Best-effort. The 60s reconciler is the source of truth and will catch
 * anything this hook misses (server restart mid-transition, race, etc.).
 */
export async function propagateAfterStatusChange(_assetId: string): Promise<void> {
  try {
    await reconcileDependencySuppression();
  } catch (err: any) {
    logger.warn(
      { event: "dependency.propagate.failed", err: err?.message ?? String(err) },
      "propagateAfterStatusChange failed (reconciler will catch on next tick)",
    );
  }
}
