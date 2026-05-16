/**
 * src/services/fortigateLocationService.ts
 *
 * Pull `sysLocation` from a FortiGate during discovery via the FortiOS REST
 * API rather than SNMP. `GET /api/v2/cmdb/system.snmp/sysinfo` returns the
 * FortiGate's SNMP system info block; its `location` field is exactly the
 * value served on OID 1.3.6.1.2.1.1.6.0 when an SNMP agent is configured.
 *
 * Why REST instead of SNMP:
 *   - Reuses the existing FMG-proxy / standalone-FortiGate transport via
 *     `callFortiOs` — no separate SNMP credential to resolve, no net-snmp
 *     session, no per-host gate to coordinate with monitoring.
 *   - In FMG proxy mode, FMG forwards the call to the FortiGate; Polaris
 *     doesn't need direct network reachability to the FortiGate's mgmt IP.
 *   - The API token the integration already uses for discovery has read
 *     access to `system.snmp/sysinfo` by default — no extra admin profile
 *     setting required.
 *
 * Discovery-only entry point. The steady-state monitoring pipeline doesn't
 * call this — sysLocation changes rarely, and re-querying every probe would
 * burn worker time for no value.
 *
 * Never throws. REST failures (token mismatch, endpoint unavailable, FortiOS
 * versions that omit the sysinfo block) come back as `null` so the discovery
 * sync carries on with no location update.
 */
import { logger } from "../utils/logger.js";
import { callFortiOs, buildTransportForIntegration } from "./reservationPushService.js";

interface FortiOsSnmpSysinfo {
  status?: string;
  "engine-id"?: string;
  description?: string;
  contact?: string;
  location?: string;
}

/**
 * Fetch the FortiGate's configured SNMP sysLocation via REST. Returns the
 * raw string (whitespace-collapsed, trimmed) or null when missing/empty.
 *
 * `deviceName` is the FMG device name in proxy mode, ignored in
 * standalone-FortiGate mode (the transport already knows the FortiGate's
 * identity from the integration config).
 */
export async function fetchFortigateSysLocation(args: {
  integration: { id: string; type: string; config: unknown };
  deviceName: string;
}): Promise<string | null> {
  const { integration, deviceName } = args;
  try {
    const transport = await buildTransportForIntegration(integration, deviceName);
    const result = await callFortiOs<FortiOsSnmpSysinfo | FortiOsSnmpSysinfo[]>(
      transport,
      "GET",
      "/api/v2/cmdb/system.snmp/sysinfo",
    );
    // FortiOS sometimes wraps the single object in an array; tolerate both.
    const sysinfo = Array.isArray(result) ? result[0] : result;
    const raw = sysinfo?.location;
    if (typeof raw !== "string") return null;
    const cleaned = raw.replace(/\s+/g, " ").trim();
    return cleaned || null;
  } catch (err: any) {
    logger.warn(
      { integrationId: integration.id, deviceName, err: err?.message },
      "fortigate_location.fetch_failed",
    );
    return null;
  }
}
