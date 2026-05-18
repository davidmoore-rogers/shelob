/**
 * tests/unit/autoMonitorInterfacesService.test.ts
 *
 * Pure-function coverage for the resolver + pattern compiler + legacy
 * coercion. No DB calls; the DB-bound functions (apply/preview/aggregate)
 * are exercised by the integration test suite.
 */

import { describe, it, expect } from "vitest";
import {
  compileWildcard,
  compilePattern,
  resolvePinnedInterfaces,
  coerceLegacySelection,
  type ResolverInterface,
  type LldpByIfName,
  type AutoMonitorSelection,
} from "../../src/services/autoMonitorInterfacesService.js";

function iface(name: string, type: string | null = "physical", up = true): ResolverInterface {
  return { ifName: name, ifType: type, operStatus: up ? "up" : "down" };
}

describe("compileWildcard", () => {
  it("matches simple * suffix", () => {
    const r = compileWildcard("wan*");
    expect(r.test("wan1")).toBe(true);
    expect(r.test("wan-uplink")).toBe(true);
    expect(r.test("lan1")).toBe(false);
  });

  it("matches single-character ?", () => {
    const r = compileWildcard("port?");
    expect(r.test("port1")).toBe(true);
    expect(r.test("port10")).toBe(false);
  });

  it("anchors the pattern", () => {
    const r = compileWildcard("wan");
    expect(r.test("wan")).toBe(true);
    expect(r.test("wan1")).toBe(false);
    expect(r.test("xwan")).toBe(false);
  });

  it("escapes regex metacharacters in the literal", () => {
    const r = compileWildcard("port[1]");
    expect(r.test("port[1]")).toBe(true);
    expect(r.test("port1")).toBe(false);
  });

  it("rejects empty input", () => {
    expect(() => compileWildcard("")).toThrow();
  });
});

describe("compilePattern", () => {
  it("regex=false delegates to compileWildcard (anchored)", () => {
    const r = compilePattern("wan*", false);
    expect(r.test("wan1")).toBe(true);
    expect(r.test("xwan1")).toBe(false);
  });

  it("regex=true returns the raw regex anchor-free", () => {
    const r = compilePattern("wan", true);
    expect(r.test("wan")).toBe(true);
    expect(r.test("wan1")).toBe(true); // anchor-free: substring matches
    expect(r.test("xwan")).toBe(true);
  });

  it("regex=true respects explicit anchors", () => {
    const r = compilePattern("^wan\\d+$", true);
    expect(r.test("wan1")).toBe(true);
    expect(r.test("wan10")).toBe(true);
    expect(r.test("wan")).toBe(false);
    expect(r.test("xwan1")).toBe(false);
  });

  it("regex=true throws on invalid regex", () => {
    expect(() => compilePattern("(unclosed", true)).toThrow();
  });
});

describe("resolvePinnedInterfaces — null / empty inputs", () => {
  it("returns empty for null selection", () => {
    expect(resolvePinnedInterfaces(null, [iface("wan1")])).toEqual([]);
  });

  it("returns empty for empty interface list", () => {
    expect(resolvePinnedInterfaces({ byNames: { names: ["wan1"] } }, [])).toEqual([]);
  });

  it("returns empty for selection with all blocks empty/missing", () => {
    expect(resolvePinnedInterfaces({}, [iface("wan1")])).toEqual([]);
  });
});

describe("resolvePinnedInterfaces — byNames", () => {
  const ifs = [iface("wan1"), iface("wan2", "physical", false), iface("internal1")];

  it("returns only names that exist on the device", () => {
    const out = resolvePinnedInterfaces({ byNames: { names: ["wan1", "wan2", "wan3"] } }, ifs);
    expect(out.sort()).toEqual(["wan1", "wan2"]);
  });

  it("ignores up/down state — explicit names always pin", () => {
    const out = resolvePinnedInterfaces({ byNames: { names: ["wan2"] } }, ifs);
    expect(out).toEqual(["wan2"]);
  });

  it("returns empty when no name matches", () => {
    const out = resolvePinnedInterfaces({ byNames: { names: ["nonexistent"] } }, ifs);
    expect(out).toEqual([]);
  });
});

describe("resolvePinnedInterfaces — byPatterns", () => {
  const ifs = [
    iface("wan1"),
    iface("wan2", "physical", false),
    iface("internal1"),
    iface("port1", "physical", false),
  ];

  it("wildcard mode matches across all interfaces when onlyUp=false", () => {
    const out = resolvePinnedInterfaces({ byPatterns: { patterns: ["wan*"], regex: false, onlyUp: false } }, ifs);
    expect(out.sort()).toEqual(["wan1", "wan2"]);
  });

  it("filters down interfaces when onlyUp=true", () => {
    const out = resolvePinnedInterfaces({ byPatterns: { patterns: ["wan*"], regex: false, onlyUp: true } }, ifs);
    expect(out).toEqual(["wan1"]);
  });

  it("supports multiple patterns (OR semantics)", () => {
    const out = resolvePinnedInterfaces({ byPatterns: { patterns: ["wan*", "internal?"], regex: false, onlyUp: false } }, ifs);
    expect(out.sort()).toEqual(["internal1", "wan1", "wan2"]);
  });

  it("regex mode honors anchor-free semantics", () => {
    const out = resolvePinnedInterfaces({ byPatterns: { patterns: ["wan"], regex: true, onlyUp: false } }, ifs);
    expect(out.sort()).toEqual(["wan1", "wan2"]);
  });

  it("regex mode respects explicit ^$ anchors", () => {
    const out = resolvePinnedInterfaces({ byPatterns: { patterns: ["^port1$"], regex: true, onlyUp: false } }, ifs);
    expect(out).toEqual(["port1"]);
  });

  it("returns empty for empty patterns array", () => {
    const out = resolvePinnedInterfaces({ byPatterns: { patterns: [], regex: false, onlyUp: false } }, ifs);
    expect(out).toEqual([]);
  });
});

describe("resolvePinnedInterfaces — byTypes", () => {
  const ifs = [
    iface("wan1", "physical", true),
    iface("wan2", "physical", false),
    iface("vlan100", "vlan", true),
    iface("aggA", "aggregate", true),
    iface("ifNoType", null, true),
  ];

  it("returns names whose type is in the set", () => {
    const out = resolvePinnedInterfaces({ byTypes: { types: ["physical"], onlyUp: false } }, ifs);
    expect(out.sort()).toEqual(["wan1", "wan2"]);
  });

  it("filters down interfaces when onlyUp=true", () => {
    const out = resolvePinnedInterfaces({ byTypes: { types: ["physical"], onlyUp: true } }, ifs);
    expect(out).toEqual(["wan1"]);
  });

  it("supports multiple types", () => {
    const out = resolvePinnedInterfaces({ byTypes: { types: ["physical", "vlan"], onlyUp: false } }, ifs);
    expect(out.sort()).toEqual(["vlan100", "wan1", "wan2"]);
  });

  it("never matches an interface with ifType=null", () => {
    const out = resolvePinnedInterfaces({ byTypes: { types: ["physical", "aggregate", "vlan", "loopback", "tunnel"], onlyUp: false } }, ifs);
    expect(out).not.toContain("ifNoType");
  });
});

describe("resolvePinnedInterfaces — byLldp", () => {
  const ifs = [
    iface("port1"),
    iface("port2"),
    iface("port3"),
  ];

  it("pins interfaces whose neighbor is a monitored asset of the chosen type", () => {
    const lldp: LldpByIfName = new Map([
      ["port1", [{ matchedAssetType: "switch",   matchedAssetMonitored: true  }]],
      ["port2", [{ matchedAssetType: "firewall", matchedAssetMonitored: true  }]],
      ["port3", [{ matchedAssetType: "switch",   matchedAssetMonitored: false }]],
    ]);
    const out = resolvePinnedInterfaces(
      { byLldp: { neighborTypes: ["switch", "firewall"] } },
      ifs,
      lldp,
    );
    expect(out.sort()).toEqual(["port1", "port2"]);
  });

  it("requires the neighbor's matched asset to be monitored=true", () => {
    const lldp: LldpByIfName = new Map([
      ["port1", [{ matchedAssetType: "switch", matchedAssetMonitored: false }]],
    ]);
    const out = resolvePinnedInterfaces({ byLldp: { neighborTypes: ["switch"] } }, ifs, lldp);
    expect(out).toEqual([]);
  });

  it("ignores interfaces with no LLDP neighbors", () => {
    const lldp: LldpByIfName = new Map();
    const out = resolvePinnedInterfaces({ byLldp: { neighborTypes: ["switch"] } }, ifs, lldp);
    expect(out).toEqual([]);
  });

  it("any neighbor matching is enough on shared media", () => {
    const lldp: LldpByIfName = new Map([
      ["port1", [
        { matchedAssetType: "workstation", matchedAssetMonitored: true },
        { matchedAssetType: "switch",      matchedAssetMonitored: true },
      ]],
    ]);
    const out = resolvePinnedInterfaces({ byLldp: { neighborTypes: ["switch"] } }, ifs, lldp);
    expect(out).toEqual(["port1"]);
  });

  it("returns empty when ctx is missing even though byLldp is set", () => {
    const out = resolvePinnedInterfaces({ byLldp: { neighborTypes: ["switch"] } }, ifs);
    expect(out).toEqual([]);
  });
});

describe("resolvePinnedInterfaces — multi-block union", () => {
  const ifs = [
    iface("wan1", "physical", true),
    iface("port1", "physical", true),
    iface("vlan100", "vlan", true),
    iface("uplink", "aggregate", true),
  ];

  it("unions across all enabled blocks (no duplicates)", () => {
    const lldp: LldpByIfName = new Map([
      ["uplink", [{ matchedAssetType: "switch", matchedAssetMonitored: true }]],
    ]);
    const sel: AutoMonitorSelection = {
      byNames:    { names: ["port1"] },
      byPatterns: { patterns: ["wan*"], regex: false, onlyUp: false },
      byTypes:    { types: ["vlan"], onlyUp: false },
      byLldp:     { neighborTypes: ["switch"] },
    };
    const out = resolvePinnedInterfaces(sel, ifs, lldp).sort();
    expect(out).toEqual(["port1", "uplink", "vlan100", "wan1"]);
  });

  it("overlapping blocks dedupe (port1 matched by both names and pattern)", () => {
    const sel: AutoMonitorSelection = {
      byNames:    { names: ["port1"] },
      byPatterns: { patterns: ["port*"], regex: false, onlyUp: false },
    };
    const out = resolvePinnedInterfaces(sel, ifs);
    expect(out).toEqual(["port1"]);
  });
});

describe("coerceLegacySelection", () => {
  it("returns null for null/empty input", () => {
    expect(coerceLegacySelection(null)).toBeNull();
    expect(coerceLegacySelection(undefined)).toBeNull();
    expect(coerceLegacySelection({})).toBeNull();
  });

  it("passes through new-shape selections unchanged", () => {
    const sel: AutoMonitorSelection = { byNames: { names: ["wan1"] } };
    expect(coerceLegacySelection(sel)).toBe(sel);
  });

  it("converts legacy names shape", () => {
    expect(coerceLegacySelection({ mode: "names", names: ["wan1", "wan2"] })).toEqual({
      byNames: { names: ["wan1", "wan2"] },
    });
  });

  it("converts legacy wildcard shape with regex=false default", () => {
    expect(coerceLegacySelection({ mode: "wildcard", patterns: ["wan*"], onlyUp: true })).toEqual({
      byPatterns: { patterns: ["wan*"], regex: false, onlyUp: true },
    });
  });

  it("converts legacy type shape with onlyUp default=true", () => {
    expect(coerceLegacySelection({ mode: "type", types: ["physical"] })).toEqual({
      byTypes: { types: ["physical"], onlyUp: true },
    });
  });
});
