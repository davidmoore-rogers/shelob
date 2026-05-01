/**
 * src/utils/fortiapLldp.ts
 *
 * Pure (no I/O) extractor for the LLDP + mesh fields on a FortiOS
 * `/api/v2/monitor/wifi/managed_ap` row. Used by both fortimanagerService
 * and fortigateService — each FortiAP discovery path calls this to learn
 * its wired uplink (FortiSwitch hostname + port) directly from the AP
 * itself, plus its mesh parent serial when applicable.
 *
 * The wired-uplink discriminator is `system_description` starts with
 * "FortiSwitch-" — that filters out wireless backhaul rows (which advertise
 * "FortiAP-…" peers) and any other LLDP-speaking gear that isn't a
 * managed FortiSwitch (e.g., upstream non-Fortinet switches stay
 * un-resolved here; they'd need a separate path).
 *
 * `port_id` is the canonical port label ("port9"); `port_description` is
 * operator-set free text and not safe to key on.
 */

export interface FortiapLldpResult {
  // Filled when the AP's LLDP table reports a FortiSwitch neighbor on a
  // wired uplink. system_name and port_id from the matching LLDP entry.
  lldpUplinkSwitch?: string;
  lldpUplinkPort?: string;
  // Mesh role + parent. mesh_uplink: "ethernet" = wired-uplink AP, "mesh"
  // = wireless-mesh leaf. parent_wtp_id = the parent AP's serial number;
  // only meaningful when meshUplink === "mesh".
  meshUplink?: "ethernet" | "mesh";
  parentApSerial?: string;
}

interface ApLldpEntry {
  local_port?: unknown;
  chassis_id?: unknown;
  system_name?: unknown;
  system_description?: unknown;
  port_id?: unknown;
  port_description?: unknown;
}

interface ApRowForLldp {
  lldp?: unknown;
  mesh_uplink?: unknown;
  parent_wtp_id?: unknown;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function extractApLldpAndMesh(row: ApRowForLldp): FortiapLldpResult {
  const out: FortiapLldpResult = {};

  // 1. Wired uplink LLDP — find the first entry whose neighbor advertises
  //    itself as a FortiSwitch. Skip mesh peers (FortiAP-…) and any other
  //    non-FortiSwitch neighbors. Order in the FortiOS payload is local-
  //    port-major, but we iterate defensively.
  if (Array.isArray(row.lldp)) {
    for (const raw of row.lldp as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as ApLldpEntry;
      const sysDesc = asString(e.system_description);
      if (!sysDesc.startsWith("FortiSwitch-")) continue;
      const sysName = asString(e.system_name).trim();
      const portId = asString(e.port_id).trim();
      if (!sysName || !portId) continue;
      out.lldpUplinkSwitch = sysName;
      out.lldpUplinkPort = portId;
      break;
    }
  }

  // 2. Mesh fields. mesh_uplink is FortiOS's own classification — trust
  //    it directly. parent_wtp_id is only meaningful for mesh leaves.
  const meshUplink = asString(row.mesh_uplink).trim();
  if (meshUplink === "ethernet" || meshUplink === "mesh") {
    out.meshUplink = meshUplink;
  }
  const parentWtp = asString(row.parent_wtp_id).trim();
  if (parentWtp) out.parentApSerial = parentWtp;

  return out;
}
