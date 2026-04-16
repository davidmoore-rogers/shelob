/**
 * src/services/fortimanagerService.ts — FortiManager JSON RPC API client
 *
 * Authenticates via bearer token (API key) rather than session-based login.
 */

import { Netmask } from "netmask";
import { AppError } from "../utils/errors.js";

export interface FortiManagerConfig {
  host: string;
  port?: number;
  apiUser: string;          // API user name (required by newer FMG versions)
  apiToken: string;         // Bearer token for authentication
  adom?: string;            // Administrative Domain (default: "root")
  verifySsl?: boolean;      // Skip TLS verification (default: false)
  mgmtInterface?: string;
  dhcpInclude?: string[];
  dhcpExclude?: string[];
}

interface JsonRpcRequest {
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse {
  id: number;
  result: Array<{
    status: { code: number; message: string };
    url: string;
    data?: unknown;
  }>;
}

/**
 * Test connectivity to a FortiManager using bearer token auth.
 * Calls /sys/status to verify access and retrieve version info.
 */
export async function testConnection(config: FortiManagerConfig): Promise<{
  ok: boolean;
  message: string;
  version?: string;
}> {
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;

  try {
    const statusPayload: JsonRpcRequest = {
      id: 1,
      method: "get",
      params: [{ url: "/sys/status" }],
    };

    const statusRes = await rpc(baseUrl, statusPayload, config.apiUser, config.apiToken, config.verifySsl);

    const code = statusRes.result?.[0]?.status?.code;
    if (code !== 0) {
      const msg = statusRes.result?.[0]?.status?.message || "Request failed";
      if (code === -11) {
        return { ok: false, message: "Invalid or expired API token" };
      }
      return { ok: false, message: msg };
    }

    const data = statusRes.result?.[0]?.data as Record<string, unknown> | undefined;
    const version = data?.Version ? String(data.Version) : undefined;

    return {
      ok: true,
      message: version ? `Connected — FortiManager ${version}` : "Connected successfully",
      version,
    };
  } catch (err: any) {
    if (err.cause?.code === "ECONNREFUSED") {
      return { ok: false, message: `Connection refused — ${config.host}:${config.port || 443}` };
    }
    if (err.cause?.code === "ENOTFOUND") {
      return { ok: false, message: `Host not found — ${config.host}` };
    }
    if (err.cause?.code === "ETIMEDOUT" || err.name === "TimeoutError") {
      return { ok: false, message: `Connection timed out — ${config.host}:${config.port || 443}` };
    }
    return { ok: false, message: err.message || "Unknown error" };
  }
}

/**
 * Low-level JSON RPC call to FortiManager with bearer token auth.
 */
async function rpc(
  url: string,
  payload: JsonRpcRequest,
  apiUser: string,
  apiToken: string,
  verifySsl?: boolean,
  externalSignal?: AbortSignal,
): Promise<JsonRpcResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  // If an external signal fires (e.g. integration re-saved), abort this request too
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiToken}`,
    };
    if (apiUser) headers["access_user"] = apiUser;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
      // @ts-ignore — Node 20+ supports this for fetch
      ...(verifySsl === false && {
        dispatcher: undefined, // handled by NODE_TLS_REJECT_UNAUTHORIZED at process level
      }),
    });

    if (res.status === 401 || res.status === 403) {
      throw new AppError(502, "Authentication failed — check your API token");
    }

    if (!res.ok) {
      throw new AppError(502, `FortiManager returned HTTP ${res.status}`);
    }

    return (await res.json()) as JsonRpcResponse;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

// ─── DHCP Discovery ─────────────────────────────────────────────────────────

export interface DiscoveredSubnet {
  cidr: string;
  name: string;           // DHCP server interface name
  fortigateDevice: string;
  dhcpServerId: string;
}

/**
 * Query FortiManager for DHCP servers across all managed FortiGate devices.
 * Returns discovered subnets derived from DHCP server configs,
 * filtered by the include/exclude lists.
 */
export async function discoverDhcpSubnets(
  config: FortiManagerConfig,
  signal?: AbortSignal,
): Promise<DiscoveredSubnet[]> {
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  const adom = config.adom || "root";
  const { apiUser, apiToken, verifySsl } = config;

  // Step 1: List managed devices in the ADOM
  const devicesPayload: JsonRpcRequest = {
    id: 1,
    method: "get",
    params: [{ url: `/dvmdb/adom/${adom}/device` }],
  };

  const devicesRes = await rpc(baseUrl, devicesPayload, apiUser, apiToken, verifySsl, signal);
  const devicesData = devicesRes.result?.[0]?.data;
  if (!Array.isArray(devicesData) || devicesData.length === 0) {
    return [];
  }

  const discovered: DiscoveredSubnet[] = [];

  // Step 2: For each device, query DHCP server configs
  for (const device of devicesData) {
    const deviceName = device.name || device.hostname;
    if (!deviceName) continue;

    // Stop early if the caller aborted (e.g. integration was re-saved)
    if (signal?.aborted) break;

    try {
      const dhcpPayload: JsonRpcRequest = {
        id: 2,
        method: "get",
        params: [{ url: `/pm/config/device/${deviceName}/vdom/root/system/dhcp/server` }],
      };

      const dhcpRes = await rpc(baseUrl, dhcpPayload, apiUser, apiToken, verifySsl, signal);
      const dhcpData = dhcpRes.result?.[0]?.data;
      if (!Array.isArray(dhcpData)) continue;

      for (const server of dhcpData) {
        const iface = server.interface || "";
        const serverId = String(server.id || iface);
        const netmaskStr = server.netmask;
        const ranges = server["ip-range"];

        if (!netmaskStr || !Array.isArray(ranges) || ranges.length === 0) continue;

        const startIp = ranges[0]["start-ip"];
        if (!startIp) continue;

        // Derive CIDR from start-ip + netmask
        try {
          const block = new Netmask(`${startIp}/${netmaskStr}`);
          const cidr = `${block.base}/${block.bitmask}`;

          discovered.push({
            cidr,
            name: iface || `dhcp-${serverId}`,
            fortigateDevice: deviceName,
            dhcpServerId: serverId,
          });
        } catch {
          // Skip entries with invalid netmask/IP combinations
        }
      }
    } catch {
      // Device query failed (offline, permissions, etc.) — skip and continue
    }
  }

  // Step 3: Filter by dhcpInclude / dhcpExclude
  return filterDhcpResults(discovered, config.dhcpInclude, config.dhcpExclude);
}

function filterDhcpResults(
  subnets: DiscoveredSubnet[],
  include?: string[],
  exclude?: string[],
): DiscoveredSubnet[] {
  let result = subnets;

  if (include && include.length > 0) {
    result = result.filter((s) =>
      include.some((pattern) =>
        s.name.toLowerCase().includes(pattern.toLowerCase()) ||
        s.dhcpServerId.toLowerCase().includes(pattern.toLowerCase())
      )
    );
  }

  if (exclude && exclude.length > 0) {
    result = result.filter((s) =>
      !exclude.some((pattern) =>
        s.name.toLowerCase().includes(pattern.toLowerCase()) ||
        s.dhcpServerId.toLowerCase().includes(pattern.toLowerCase())
      )
    );
  }

  return result;
}
