#!/usr/bin/env node
/**
 * scripts/probe-fmg-geo.mjs — Diagnose where FMG/FortiGate stores longitude/latitude
 *
 * Prints every FortiGate in the ADOM with the full set of fields FMG returns
 * for that device (so you can spot where lat/lng actually live), and then
 * proxies a CMDB `system/global` read to each connected device and reports
 * whether that endpoint carries longitude/latitude.
 *
 * Usage:
 *   node scripts/probe-fmg-geo.mjs --host <host> --user <api-user> --token <api-token> [options]
 *
 * Options:
 *   --host      FortiManager hostname or IP (required)
 *   --user      API user name (required)
 *   --token     Bearer API token (required)
 *   --port      Port (default: 443)
 *   --adom      ADOM name (default: root)
 *   --no-verify Skip SSL certificate verification
 *   --limit     Only probe the first N devices (default: 3)
 */

import { request as httpsRequest } from "node:https";

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf("--" + name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}
const host = getArg("host");
const user = getArg("user");
const token = getArg("token");
const port = parseInt(getArg("port") || "443", 10);
const adom = getArg("adom") || "root";
const verifySsl = !args.includes("--no-verify");
const limit = parseInt(getArg("limit") || "3", 10);

if (!host || !user || !token) {
  console.error("Usage: node scripts/probe-fmg-geo.mjs --host <host> --user <api-user> --token <api-token> [--adom root] [--no-verify] [--limit 3]");
  process.exit(1);
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ id: 1, method, params });
    const req = httpsRequest({
      hostname: host, port, path: "/jsonrpc", method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Authorization: `Bearer ${token}`,
        access_user: user,
      },
      rejectUnauthorized: verifySsl,
      timeout: 15000,
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid JSON response")); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Connection timed out")); });
    req.on("error", reject);
    req.write(payload); req.end();
  });
}

console.log(`\n  FortiManager:  ${host}:${port}`);
console.log(`  ADOM:          ${adom}\n`);

// 1. Fetch every device with NO field filter so we see the raw record FMG exposes.
console.log(`  [1] /dvmdb/adom/${adom}/device — full device record (first ${limit})\n`);
let devicesList;
try {
  const res = await rpc("get", [{ url: `/dvmdb/adom/${adom}/device` }]);
  const code = res.result?.[0]?.status?.code;
  if (code !== 0) {
    console.error(`      FAIL: ${res.result?.[0]?.status?.message || "unknown error"}`);
    process.exit(1);
  }
  devicesList = res.result[0].data || [];
  console.log(`      Found ${devicesList.length} device(s). Sampling ${Math.min(limit, devicesList.length)}:\n`);

  for (const d of devicesList.slice(0, limit)) {
    console.log(`      ━━ ${d.name || d.hostname || "(unnamed)"} ━━`);
    const interesting = [
      "name", "hostname", "sn", "platform_str", "ip", "conn_status",
      "latitude", "longitude", "location", "desc", "comments", "_dn",
    ];
    for (const k of interesting) {
      if (d[k] !== undefined) console.log(`        ${k.padEnd(14)} = ${JSON.stringify(d[k])}`);
    }
    const other = Object.keys(d).filter((k) => !interesting.includes(k));
    if (other.length) console.log(`        (other keys: ${other.slice(0, 20).join(", ")}${other.length > 20 ? ", …" : ""})`);
    console.log("");
  }
} catch (err) {
  console.error(`      FAIL: ${err.message}`);
  process.exit(1);
}

// 2. For each connected device, proxy a CMDB read of system/global and show
//    whether the live FortiGate carries longitude/latitude in its own config.
console.log(`  [2] /sys/proxy/json → /api/v2/cmdb/system/global (each connected device)\n`);
const connected = devicesList.filter((d) => d.conn_status === 1 || d.conn_status === undefined).slice(0, limit);
for (const d of connected) {
  const name = d.name || d.hostname;
  process.stdout.write(`      ${name.padEnd(32)} → `);
  try {
    const res = await rpc("exec", [{
      url: "/sys/proxy/json",
      data: {
        target: [`/adom/${adom}/device/${name}`],
        action: "get",
        resource: "/api/v2/cmdb/system/global",
      },
    }]);
    const entry = res.result?.[0]?.data;
    const e = Array.isArray(entry) ? entry[0] : entry;
    const status = e?.status?.code;
    if (status !== 0) { console.log(`proxy status ${status}: ${e?.status?.message || "—"}`); continue; }
    const r = e?.response?.results;
    if (!r || typeof r !== "object") { console.log("no results object"); continue; }
    const hasLat = r.latitude !== undefined;
    const hasLng = r.longitude !== undefined;
    if (hasLat || hasLng) console.log(`latitude=${JSON.stringify(r.latitude)}  longitude=${JSON.stringify(r.longitude)}`);
    else {
      const sample = Object.keys(r).filter((k) => /loc|lat|lng|long|geo|coord|site/i.test(k));
      console.log(sample.length ? `no lat/lng, but related keys: ${sample.join(", ")}` : `no lat/lng in system/global`);
    }
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
  }
}

console.log("");
