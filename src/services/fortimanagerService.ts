/**
 * src/services/fortimanagerService.ts — FortiManager JSON RPC API client
 */

import { AppError } from "../utils/errors.js";

export interface FortiManagerConfig {
  host: string;
  port?: number;
  username: string;
  password: string;
  adom?: string;          // Administrative Domain (default: "root")
  verifySsl?: boolean;    // Skip TLS verification (default: false)
}

interface JsonRpcRequest {
  id: number;
  method: string;
  params: unknown[];
  session?: string;
}

interface JsonRpcResponse {
  id: number;
  result: Array<{
    status: { code: number; message: string };
    url: string;
    data?: unknown;
  }>;
  session?: string;
}

/**
 * Test connectivity to a FortiManager by attempting a login + logout.
 * Returns { ok, message, version? }.
 */
export async function testConnection(config: FortiManagerConfig): Promise<{
  ok: boolean;
  message: string;
  version?: string;
}> {
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;

  let session: string | undefined;

  try {
    // 1. Login
    const loginPayload: JsonRpcRequest = {
      id: 1,
      method: "exec",
      params: [
        {
          url: "/sys/login/user",
          data: {
            user: config.username,
            passwd: config.password,
          },
        },
      ],
    };

    const loginRes = await rpc(baseUrl, loginPayload, config.verifySsl);

    if (!loginRes.session) {
      const code = loginRes.result?.[0]?.status?.code;
      if (code === -11) {
        return { ok: false, message: "Invalid credentials" };
      }
      return {
        ok: false,
        message: loginRes.result?.[0]?.status?.message || "Login failed (no session returned)",
      };
    }

    session = loginRes.session;

    // 2. Get system status (for version info)
    let version: string | undefined;
    try {
      const statusPayload: JsonRpcRequest = {
        id: 2,
        method: "get",
        params: [{ url: "/sys/status" }],
        session,
      };
      const statusRes = await rpc(baseUrl, statusPayload, config.verifySsl);
      const data = statusRes.result?.[0]?.data as Record<string, unknown> | undefined;
      if (data?.Version) {
        version = String(data.Version);
      }
    } catch {
      // Non-fatal — version is optional
    }

    // 3. Logout
    try {
      const logoutPayload: JsonRpcRequest = {
        id: 3,
        method: "exec",
        params: [{ url: "/sys/logout" }],
        session,
      };
      await rpc(baseUrl, logoutPayload, config.verifySsl);
    } catch {
      // Non-fatal
    }

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
 * Low-level JSON RPC call to FortiManager.
 */
async function rpc(
  url: string,
  payload: JsonRpcRequest,
  verifySsl?: boolean,
): Promise<JsonRpcResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      // @ts-ignore — Node 20+ supports this for fetch
      ...(verifySsl === false && {
        dispatcher: undefined, // handled by NODE_TLS_REJECT_UNAUTHORIZED at process level
      }),
    });

    if (!res.ok) {
      throw new AppError(502, `FortiManager returned HTTP ${res.status}`);
    }

    return (await res.json()) as JsonRpcResponse;
  } finally {
    clearTimeout(timeout);
  }
}
