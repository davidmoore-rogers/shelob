/**
 * src/services/vendorTelemetryProfiles.ts — Per-vendor SNMP telemetry shapes.
 *
 * Standard HOST-RESOURCES-MIB (used by `collectTelemetrySnmp`) returns null
 * CPU/memory on most network gear — those vendors expose telemetry only via
 * their proprietary MIBs. This file maps an asset's `manufacturer` (and `os`,
 * for cases where the manufacturer field is empty) to the symbolic OID names
 * that actually carry CPU% and memory bytes for that vendor. The names are
 * resolved by `oidRegistry` against whichever MIBs the operator has uploaded
 * — when a profile matches but the underlying MIB hasn't been uploaded yet,
 * the probe falls back to HOST-RESOURCES-MIB rather than failing.
 *
 * To probe a new vendor, an operator uploads the relevant MIB(s) to Server
 * Settings → Identification → MIB Database. No code change needed unless the
 * symbolic names below are wrong for that vendor — in which case extend this
 * file.
 *
 * Entries are matched in array order; first match wins.
 */

export interface CpuQuery {
  symbol: string;                       // symbolic OID name (resolved via oidRegistry)
  mode: "scalar" | "walk-avg";          // scalar = .0, walk-avg = walk subtree + average
}

export interface MemoryQuery {
  // CPU/memory profiles can supply EITHER bytes (used + free or used + total)
  // OR a single percentage. The probe coerces whichever form arrives back to
  // the AssetTelemetrySample {cpuPct, memPct, memUsedBytes, memTotalBytes}
  // shape, with bytes winning when both are present.
  usedBytesSymbol?: string;
  freeBytesSymbol?: string;             // used + free → total at probe time
  totalBytesSymbol?: string;
  pctSymbol?: string;
  walkSubtree?: boolean;                // walk + sum (Cisco memory pools have multiple rows)
}

export interface VendorTelemetryProfile {
  vendor: string;                       // human-readable label, used in logs
  match: RegExp;                        // case-insensitive regex tested against `${manufacturer} ${os}`
  cpu?: CpuQuery;
  memory?: MemoryQuery;
}

/**
 * Built-in profile registry. Patterns intentionally err on the wide side so
 * that variations like "Cisco Systems", "Cisco IOS-XE", "cisco" all match the
 * same profile. The `match` regex is tested against the concatenation of
 * `manufacturer` + " " + `os`, so OS-only matches (e.g. an asset with no
 * manufacturer set but `os = "Cisco IOS"`) still hit.
 */
export const VENDOR_TELEMETRY_PROFILES: VendorTelemetryProfile[] = [
  {
    vendor: "Cisco IOS / IOS-XE / NX-OS",
    match: /cisco|ios-?xe|nx-?os/i,
    // CISCO-PROCESS-MIB::cpmCPUTotal5secRev — table walk; one row per CPU,
    // averaged at probe time. The `Rev` variant is on every IOS/IOS-XE since
    // 12.x; older boxes that only expose the non-Rev form will fall back.
    cpu: { symbol: "cpmCPUTotal5secRev", mode: "walk-avg" },
    // CISCO-MEMORY-POOL-MIB::ciscoMemoryPoolUsed / Free — multiple pools
    // (processor, I/O, fast, …); summed at probe time.
    memory: {
      usedBytesSymbol: "ciscoMemoryPoolUsed",
      freeBytesSymbol: "ciscoMemoryPoolFree",
      walkSubtree: true,
    },
  },
  {
    vendor: "Juniper Junos",
    match: /juniper|junos/i,
    // JUNIPER-MIB::jnxOperatingCPU — table indexed by physical entity; we
    // average the CPU rows (REs + linecards). Could refine to RE-only later.
    cpu: { symbol: "jnxOperatingCPU", mode: "walk-avg" },
    // JUNIPER-MIB::jnxOperatingBuffer — 1-100 percent, no byte equivalent
    // exposed via SNMP.
    memory: { pctSymbol: "jnxOperatingBuffer", walkSubtree: true },
  },
  {
    vendor: "Mikrotik RouterOS",
    match: /mikrotik|routeros/i,
    // MIKROTIK-MIB::mtxrSystemUserCPULoad — scalar percent
    cpu: { symbol: "mtxrSystemUserCPULoad", mode: "scalar" },
    // Mikrotik exposes RAM bytes via HOST-RESOURCES-MIB only, so leave the
    // memory profile empty and let the HRM fallback handle it.
  },
  {
    vendor: "Fortinet FortiOS (SNMP path)",
    match: /fortinet|fortigate|fortios/i,
    // FORTINET-FORTIGATE-MIB::fgSysCpuUsage / fgSysMemUsage — both scalars,
    // both 0-100 percent. Used for FortiGates monitored as plain SNMP rather
    // than via the FortiOS REST monitorType path.
    cpu: { symbol: "fgSysCpuUsage", mode: "scalar" },
    memory: { pctSymbol: "fgSysMemUsage" },
  },
  {
    vendor: "HP / Aruba ProCurve",
    match: /aruba|hpe|hewlett|procurve|^hp\b/i,
    // STATISTICS-MIB::hpSwitchCpuStat — scalar percent
    cpu: { symbol: "hpSwitchCpuStat", mode: "scalar" },
  },
  {
    vendor: "Dell PowerConnect / Networking",
    match: /\bdell\b|powerconnect|force10/i,
    // RADLAN / Dell-Vendor-MIB::rlCpuUtilDuringLastMinute — scalar percent
    cpu: { symbol: "rlCpuUtilDuringLastMinute", mode: "scalar" },
  },
];

/**
 * Pick the first profile whose `match` regex hits the given identity tuple.
 * Returns null when no profile matches — caller falls through to
 * HOST-RESOURCES-MIB.
 */
export function pickVendorProfile(
  manufacturer: string | null | undefined,
  os: string | null | undefined,
): VendorTelemetryProfile | null {
  const haystack = `${manufacturer ?? ""} ${os ?? ""}`.trim();
  if (!haystack) return null;
  for (const p of VENDOR_TELEMETRY_PROFILES) {
    if (p.match.test(haystack)) return p;
  }
  return null;
}
