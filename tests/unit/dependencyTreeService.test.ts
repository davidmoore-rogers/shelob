/**
 * tests/unit/dependencyTreeService.test.ts
 *
 * Pure-function coverage for the dependency-tree builder, BFS layer
 * assignment, and the all-down multi-parent suppression evaluator. The
 * DB-bound recompute / reconcile wrappers are exercised via integration
 * tests separately.
 */

import { describe, it, expect } from "vitest";

import {
  buildDependencyEdgesFromInputs,
  assignLayers,
  evaluateSuppression,
  type DepAsset,
  type DepInterfaceEdge,
  type DepLldpEdge,
  type SuppressionAssetState,
} from "../../src/services/dependencyTreeService.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function fg(id: string, hostname: string): DepAsset {
  return { id, hostname, serialNumber: null, assetType: "firewall", fortinetTopology: null };
}
function sw(id: string, hostname: string, controllerFortigate?: string): DepAsset {
  return {
    id,
    hostname,
    serialNumber: null,
    assetType: "switch",
    fortinetTopology: controllerFortigate ? { role: "fortiswitch", controllerFortigate } : null,
  };
}
function ap(id: string, hostname: string, parentSwitch?: string, controllerFortigate?: string): DepAsset {
  return {
    id,
    hostname,
    serialNumber: null,
    assetType: "access_point",
    fortinetTopology: { role: "fortiap", parentSwitch, controllerFortigate },
  };
}

// ─── buildDependencyEdgesFromInputs ─────────────────────────────────────────

describe("buildDependencyEdgesFromInputs", () => {
  it("emits controller→switch edges from fortinetTopology", () => {
    const assets = [fg("fg1", "FG-EDGE-01"), sw("sw1", "FS-CORE-01", "FG-EDGE-01")];
    const edges = buildDependencyEdgesFromInputs(assets, [], []);
    expect(edges).toEqual([
      { childAssetId: "sw1", parentAssetId: "fg1", detectedVia: "controller" },
    ]);
  });

  it("emits switch→AP edges from fortinetTopology.parentSwitch", () => {
    const assets = [
      fg("fg1", "FG-EDGE-01"),
      sw("sw1", "FS-CORE-01", "FG-EDGE-01"),
      ap("ap1", "FAP-01", "FS-CORE-01"),
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], []);
    expect(edges).toContainEqual({ childAssetId: "ap1", parentAssetId: "sw1", detectedVia: "controller" });
  });

  it("falls back to FortiGate parent for an AP not behind a switch", () => {
    const assets = [
      fg("fg1", "FG-EDGE-01"),
      ap("ap1", "FAP-01", undefined, "FG-EDGE-01"),
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], []);
    expect(edges).toContainEqual({ childAssetId: "ap1", parentAssetId: "fg1", detectedVia: "controller" });
  });

  it("emits both directions for interface edges (BFS resolves direction)", () => {
    const assets = [sw("sw1", "FS-A"), sw("sw2", "FS-B")];
    const edges = buildDependencyEdgesFromInputs(assets, [{ sourceAssetId: "sw1", targetAssetId: "sw2" }], []);
    expect(edges).toContainEqual({ childAssetId: "sw1", parentAssetId: "sw2", detectedVia: "interface" });
    expect(edges).toContainEqual({ childAssetId: "sw2", parentAssetId: "sw1", detectedVia: "interface" });
  });

  it("controller signal beats interface and lldp on the same pair", () => {
    const assets = [fg("fg1", "FG-EDGE-01"), sw("sw1", "FS-CORE-01", "FG-EDGE-01")];
    const edges = buildDependencyEdgesFromInputs(
      assets,
      [{ sourceAssetId: "sw1", targetAssetId: "fg1" }],
      [{ assetId: "sw1", matchedAssetId: "fg1" }],
    );
    const swToFg = edges.filter(e => e.childAssetId === "sw1" && e.parentAssetId === "fg1");
    expect(swToFg).toHaveLength(1);
    expect(swToFg[0].detectedVia).toBe("controller");
  });

  it("ignores self-loops and references to unknown assets", () => {
    const assets = [sw("sw1", "FS-A")];
    const edges = buildDependencyEdgesFromInputs(
      assets,
      [
        { sourceAssetId: "sw1", targetAssetId: "sw1" }, // self-loop
        { sourceAssetId: "sw1", targetAssetId: "ghost" }, // unknown peer
      ],
      [],
    );
    expect(edges).toEqual([]);
  });

  it("does not bind a switch's controllerFortigate to an asset of the wrong type", () => {
    // hostname collides with an AP, not a firewall — must NOT create the edge.
    const assets = [
      ap("ap1", "FG-EDGE-01"), // pretend an AP somehow shares a hostname with a FortiGate
      sw("sw1", "FS-CORE-01", "FG-EDGE-01"),
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], []);
    expect(edges.find(e => e.childAssetId === "sw1")).toBeUndefined();
  });
});

// ─── assignLayers ───────────────────────────────────────────────────────────

describe("assignLayers", () => {
  it("assigns layer 1 to every FortiGate root", () => {
    const assets = [fg("fg1", "A"), fg("fg2", "B"), sw("sw1", "C")];
    const { layers } = assignLayers(assets, []);
    expect(layers.get("fg1")).toBe(1);
    expect(layers.get("fg2")).toBe(1);
    expect(layers.has("sw1")).toBe(false); // no edges → unresolved
  });

  it("walks a 4-tier chain (FG → core → distribution → access)", () => {
    const assets = [
      fg("fg",  "FG"),
      sw("core","CORE", "FG"),
      sw("dist","DIST"), // chained via interface edge to core
      sw("acc", "ACC"),  // chained via interface edge to dist
    ];
    const ifEdges: DepInterfaceEdge[] = [
      { sourceAssetId: "core", targetAssetId: "dist" },
      { sourceAssetId: "dist", targetAssetId: "acc"  },
    ];
    const candidate = buildDependencyEdgesFromInputs(assets, ifEdges, []);
    const { layers, keptEdges } = assignLayers(assets, candidate);
    expect(layers.get("fg")).toBe(1);
    expect(layers.get("core")).toBe(2);
    expect(layers.get("dist")).toBe(3);
    expect(layers.get("acc")).toBe(4);
    expect(keptEdges).toContainEqual({ childAssetId: "core", parentAssetId: "fg",   detectedVia: "controller" });
    expect(keptEdges).toContainEqual({ childAssetId: "dist", parentAssetId: "core", detectedVia: "interface" });
    expect(keptEdges).toContainEqual({ childAssetId: "acc",  parentAssetId: "dist", detectedVia: "interface" });
  });

  it("MCLAG-paired switches at the same layer don't become parents of each other", () => {
    // FG at L1; sw1 + sw2 both controllerFortigate=FG → both L2; mutual interface edge.
    const assets = [
      fg("fg",  "FG"),
      sw("sw1", "A", "FG"),
      sw("sw2", "B", "FG"),
    ];
    const ifEdges: DepInterfaceEdge[] = [{ sourceAssetId: "sw1", targetAssetId: "sw2" }];
    const candidate = buildDependencyEdgesFromInputs(assets, ifEdges, []);
    const { layers, keptEdges } = assignLayers(assets, candidate);
    expect(layers.get("sw1")).toBe(2);
    expect(layers.get("sw2")).toBe(2);
    // Same-layer edges are pruned.
    expect(keptEdges.find(e => e.childAssetId === "sw1" && e.parentAssetId === "sw2")).toBeUndefined();
    expect(keptEdges.find(e => e.childAssetId === "sw2" && e.parentAssetId === "sw1")).toBeUndefined();
  });

  it("dual-homed switch records BOTH FortiGates as parents", () => {
    // controllerFortigate is single-valued, but the second FG also has an
    // interface edge from sw1 — both end up as L1 parents at L2.
    const assets = [
      fg("fg1", "FG-A"),
      fg("fg2", "FG-B"),
      sw("sw1", "DUAL", "FG-A"),
    ];
    const ifEdges: DepInterfaceEdge[] = [{ sourceAssetId: "sw1", targetAssetId: "fg2" }];
    const candidate = buildDependencyEdgesFromInputs(assets, ifEdges, []);
    const { layers, keptEdges } = assignLayers(assets, candidate);
    expect(layers.get("sw1")).toBe(2);
    const sw1Parents = keptEdges.filter(e => e.childAssetId === "sw1").map(e => e.parentAssetId).sort();
    expect(sw1Parents).toEqual(["fg1", "fg2"]);
  });

  it("orphans (no path from any FG) end up unresolved", () => {
    const assets = [
      fg("fg",  "FG"),
      sw("sw1", "ISLAND-A"),
      sw("sw2", "ISLAND-B"),
    ];
    const ifEdges: DepInterfaceEdge[] = [{ sourceAssetId: "sw1", targetAssetId: "sw2" }];
    const candidate = buildDependencyEdgesFromInputs(assets, ifEdges, []);
    const { layers, unresolved } = assignLayers(assets, candidate);
    expect(layers.get("fg")).toBe(1);
    expect(unresolved.sort()).toEqual(["sw1", "sw2"]);
  });
});

// ─── evaluateSuppression ────────────────────────────────────────────────────

describe("evaluateSuppression", () => {
  function st(id: string, layer: number | null, monitorStatus: string | null, monitored = true): SuppressionAssetState {
    return { id, layer, monitorStatus, monitored, currentlySuppressed: false };
  }

  it("orphans (no parents) are never suppressed", () => {
    const states = [st("a", 1, "down")];
    const out = evaluateSuppression(states, new Map());
    expect(out.get("a")).toBe(false);
  });

  it("single parent down → child suppressed", () => {
    const states = [st("fg", 1, "down"), st("sw", 2, "up")];
    const parents = new Map([["sw", ["fg"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("fg")).toBe(false);
    expect(out.get("sw")).toBe(true);
  });

  it("multi-parent: ANY parent up → child not suppressed", () => {
    const states = [st("fg1", 1, "down"), st("fg2", 1, "up"), st("sw", 2, "up")];
    const parents = new Map([["sw", ["fg1", "fg2"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(false);
  });

  it("multi-parent: ALL parents down → child suppressed", () => {
    const states = [st("fg1", 1, "down"), st("fg2", 1, "down"), st("sw", 2, "up")];
    const parents = new Map([["sw", ["fg1", "fg2"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(true);
  });

  it("transitive: parent suppressed → grandchild suppressed too", () => {
    const states = [
      st("fg",   1, "down"),
      st("core", 2, "up"),
      st("acc",  3, "up"),
    ];
    const parents = new Map([["core", ["fg"]], ["acc", ["core"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("core")).toBe(true);
    expect(out.get("acc")).toBe(true);
  });

  it("warning / recovering parents do NOT suppress descendants", () => {
    // Suppression follows confirmed-down only.
    const wState = [st("fg", 1, "warning"), st("sw", 2, "up")];
    const rState = [st("fg", 1, "recovering"), st("sw", 2, "up")];
    const parents = new Map([["sw", ["fg"]]]);
    expect(evaluateSuppression(wState, parents).get("sw")).toBe(false);
    expect(evaluateSuppression(rState, parents).get("sw")).toBe(false);
  });

  it("unmonitored parent is transparent — walks up to grandparents", () => {
    // sw_mid is unmonitored; FG is down; acc should be suppressed because
    // its only chain back to a monitored ancestor is via a down FG.
    const states = [
      st("fg",     1, "down"),
      st("sw_mid", 2, null, /*monitored=*/false),
      st("acc",    3, "up"),
    ];
    const parents = new Map([["sw_mid", ["fg"]], ["acc", ["sw_mid"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("acc")).toBe(true);
  });

  it("unmonitored parent with no grandparents is treated as ok", () => {
    // No monitored ancestor → no signal → not suppressed.
    const states = [
      st("orphan", 2, null, /*monitored=*/false),
      st("acc",    3, "up"),
    ];
    const parents = new Map([["acc", ["orphan"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("acc")).toBe(false);
  });
});
