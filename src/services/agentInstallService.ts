/**
 * src/services/agentInstallService.ts — Polaris Agent remote install / uninstall
 *
 * Connects to a target host via the operator's stored SSH or WinRM
 * credential, uploads the platform-matched agent binary + a generated
 * agent.conf, and runs the embedded installer script to register the
 * agent as a system service (systemd on Linux, launchd on macOS, Windows
 * Service on Windows). Uninstall is the mirror — stop service, remove
 * unit/plist/service definition, remove binary + config.
 *
 * This is the FIRST time Polaris executes remote commands. The existing
 * `monitoringService.probeSsh` / `probeWinRm` only authenticate; they
 * don't carry out arbitrary work. The helpers here extend `ssh2` with
 * SFTP upload + remote exec, and (Phase 4b) extend the WinRM SOAP code
 * with WinRS Send-File + Invoke-Command.
 *
 * Lifecycle as it threads through this service (see ManagedAgent
 * comment block in schema.prisma for the full state machine):
 *
 *   startInstall:
 *     pending → uploading (binary + script copied) →
 *     enrolling (installer started on host; awaits the agent's first
 *                POST /api/v1/agents/enroll) → active (set by /enroll)
 *
 *   startUninstall:
 *     active → uninstalling → (row hard-deleted on success, or
 *                              uninstall_failed if remote work errored)
 *
 * Phase 4a scope: SSH path complete (Linux + macOS). WinRM path returns
 * a clear "not yet supported in this release" error. Phase 4b adds the
 * Windows path.
 */

import { Client as SshClient } from "ssh2";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { AGENT_BIN_DIR } from "../utils/paths.js";
import { getCredential } from "./credentialService.js";
import { mintEnrollmentToken } from "./agentTokenService.js";
import { logEvent } from "../api/routes/events.js";
import { winrmRunOne, type WinRmConnection } from "../utils/winrm.js";

// ─── Public entry points ──────────────────────────────────────────────

export interface StartInstallInput {
  managedAgentId: string;
  credentialId:   string;
  hostOverride?:  string; // optional — defaults to Asset.ipAddress / dnsName / hostname
  /** Path-resolution hooks for tests; pass nothing in production. */
  testOverrides?: TestOverrides;
}

export interface StartUninstallInput {
  managedAgentId: string;
  credentialId:   string;
  hostOverride?:  string;
  testOverrides?: TestOverrides;
}

interface TestOverrides {
  /** Skip the actual SSH connect — return success immediately. Tests only. */
  fakeSshSucceed?: boolean;
  /** Skip the actual SSH connect — fail with this error. Tests only. */
  fakeSshFail?:    string;
}

/**
 * Fire-and-forget install kickoff. Returns immediately; the actual
 * SSH/WinRM work runs in the background and transitions installStatus
 * as it makes progress.
 *
 * The caller already created the ManagedAgent row in `pending` and
 * minted an enrollment token via the route handler. We pick up from
 * there: load the row, resolve the credential, copy binary + conf,
 * exec the installer, and stamp installStatus="enrolling" so the
 * agent's first POST /enroll (which flips it to "active") closes the
 * loop. Failures land in installStatus="failed" with installError set.
 */
export async function startInstall(input: StartInstallInput): Promise<void> {
  setImmediate(() => runInstall(input).catch((err) => {
    // Defensive — runInstall already captures errors into installError,
    // but anything escaping that path lands here.
    logger.error({ err, managedAgentId: input.managedAgentId }, "Agent install crashed unexpectedly");
  }));
}

/**
 * Fire-and-forget uninstall kickoff. Synchronous half (bearer revoke)
 * is done by the calling route — this picks up after revoke and does
 * the remote cleanup.
 */
export async function startUninstall(input: StartUninstallInput): Promise<void> {
  setImmediate(() => runUninstall(input).catch((err) => {
    logger.error({ err, managedAgentId: input.managedAgentId }, "Agent uninstall crashed unexpectedly");
  }));
}

// ─── Install runner ───────────────────────────────────────────────────

async function runInstall(input: StartInstallInput): Promise<void> {
  const { managedAgentId, credentialId, hostOverride, testOverrides } = input;

  // Load the row + the asset (for hostname resolution).
  const row = await prisma.managedAgent.findUnique({
    where: { id: managedAgentId },
    include: { asset: true },
  });
  if (!row) {
    logger.warn({ managedAgentId }, "Install kickoff: ManagedAgent row not found");
    return;
  }

  // Build the agent.conf body — we need an enrollment token. The route
  // handler may have already minted one (Phase 2 path), but for the
  // automated install we mint a fresh one here so the operator's clock
  // restarts from when the install actually fires.
  const enrollmentToken = await mintEnrollmentToken(managedAgentId);

  const host = hostOverride ?? row.asset.ipAddress ?? row.asset.dnsName ?? row.asset.hostname;
  if (!host) {
    return failInstall(managedAgentId, row.assetId, "Asset has no IP, dnsName, or hostname to connect to");
  }

  // Resolve the binary path. Per platform/arch tuple, the file is named
  // polaris-agent-<os>-<arch>{,.exe} under AGENT_BIN_DIR/<version>/.
  // The version is read from the manifest; Phase 4a expects operators
  // to have produced this directory via `make -C agent all` and
  // shipped it inside their Polaris release tarball.
  const manifest = await loadManifest();
  if (!manifest) {
    return failInstall(managedAgentId, row.assetId,
      `No agent binaries available — drop a manifest.json + binaries under ${AGENT_BIN_DIR}/<version>/ and retry`);
  }
  const binaryKey = `${row.osPlatform}-${row.arch}`;
  const binaryName = manifest.binaries[binaryKey];
  if (!binaryName) {
    return failInstall(managedAgentId, row.assetId, `No agent binary for platform ${binaryKey}`);
  }
  const binaryPath = resolvePath(AGENT_BIN_DIR, manifest.currentVersion, binaryName);
  let binaryBytes: Buffer;
  try {
    binaryBytes = await readFile(binaryPath);
  } catch (err: any) {
    return failInstall(managedAgentId, row.assetId,
      `Failed to read agent binary at ${binaryPath}: ${err.message ?? err}`);
  }

  // Load the credential. SSH path needs username + (password OR
  // privateKey); WinRM path needs username + password.
  let cred;
  try {
    cred = await getCredential(credentialId, { revealSecrets: true });
  } catch (err: any) {
    return failInstall(managedAgentId, row.assetId, `Credential lookup failed: ${err.message ?? err}`);
  }

  // Build the rendered agent.conf body that's about to be uploaded.
  const agentConfBody = renderAgentConf({
    serverUrl:       inferOwnServerUrl(),
    certFingerprint: row.serverCertFingerprint,
    enrollmentToken,
    agentId:         row.id,
  });

  await transition(managedAgentId, "uploading");

  if (row.osPlatform === "linux" || row.osPlatform === "darwin") {
    try {
      await sshInstall({
        host,
        cred: cred.config as Record<string, unknown>,
        binaryBytes,
        agentConfBody,
        platform: row.osPlatform,
        testOverrides,
      });
    } catch (err: any) {
      return failInstall(managedAgentId, row.assetId, err.message ?? String(err));
    }
  } else if (row.osPlatform === "windows") {
    try {
      await winrmInstall({
        host,
        cred: cred.config as Record<string, unknown>,
        agentConfBody,
        binaryFilename: binaryName,
        serverUrl: inferOwnServerUrl(),
        certFingerprint: row.serverCertFingerprint,
        testOverrides,
      });
    } catch (err: any) {
      return failInstall(managedAgentId, row.assetId, err.message ?? String(err));
    }
  } else {
    return failInstall(managedAgentId, row.assetId, `Unsupported osPlatform ${row.osPlatform}`);
  }

  await transition(managedAgentId, "enrolling");
  await logEvent({
    action:       "agent.installed",
    resourceType: "asset",
    resourceId:   row.assetId,
    level:        "info",
    message:      "Polaris Agent installer completed on host — awaiting agent enrollment",
    details:      { managedAgentId },
  });
  // installStatus transitions to "active" when the agent posts /enroll.
}

async function failInstall(managedAgentId: string, assetId: string, reason: string): Promise<void> {
  await prisma.managedAgent.update({
    where: { id: managedAgentId },
    data: { installStatus: "failed", installError: reason },
  }).catch(() => { /* best-effort */ });
  await logEvent({
    action:       "agent.install_failed",
    resourceType: "asset",
    resourceId:   assetId,
    level:        "error",
    message:      `Agent install failed: ${reason}`,
    details:      { managedAgentId },
  });
}

async function transition(managedAgentId: string, installStatus: string): Promise<void> {
  await prisma.managedAgent.update({
    where: { id: managedAgentId },
    data: { installStatus, installError: null },
  });
}

// ─── Uninstall runner ─────────────────────────────────────────────────

async function runUninstall(input: StartUninstallInput): Promise<void> {
  const { managedAgentId, credentialId, hostOverride, testOverrides } = input;

  const row = await prisma.managedAgent.findUnique({
    where: { id: managedAgentId },
    include: { asset: true },
  });
  if (!row) {
    logger.warn({ managedAgentId }, "Uninstall kickoff: row not found");
    return;
  }

  const host = hostOverride ?? row.asset.ipAddress ?? row.asset.dnsName ?? row.asset.hostname;
  if (!host) {
    return failUninstall(managedAgentId, row.assetId, "Asset has no IP/dnsName/hostname to connect to");
  }

  let cred;
  try {
    cred = await getCredential(credentialId, { revealSecrets: true });
  } catch (err: any) {
    return failUninstall(managedAgentId, row.assetId, `Credential lookup failed: ${err.message ?? err}`);
  }

  await prisma.managedAgent.update({
    where: { id: managedAgentId },
    data: { installStatus: "uninstalling", installError: null },
  });

  if (row.osPlatform === "linux" || row.osPlatform === "darwin") {
    try {
      await sshUninstall({
        host,
        cred: cred.config as Record<string, unknown>,
        platform: row.osPlatform,
        testOverrides,
      });
    } catch (err: any) {
      return failUninstall(managedAgentId, row.assetId, err.message ?? String(err));
    }
  } else if (row.osPlatform === "windows") {
    try {
      await winrmUninstall({
        host,
        cred: cred.config as Record<string, unknown>,
        testOverrides,
      });
    } catch (err: any) {
      return failUninstall(managedAgentId, row.assetId, err.message ?? String(err));
    }
  }

  // Hard-delete on success (audit trail lives in Event).
  await prisma.managedAgent.delete({ where: { id: managedAgentId } });
  await logEvent({
    action:       "agent.uninstalled",
    resourceType: "asset",
    resourceId:   row.assetId,
    level:        "info",
    message:      "Polaris Agent uninstalled cleanly",
    details:      { managedAgentId, osPlatform: row.osPlatform },
  });
}

async function failUninstall(managedAgentId: string, assetId: string, reason: string): Promise<void> {
  await prisma.managedAgent.update({
    where: { id: managedAgentId },
    data: { installStatus: "uninstall_failed", installError: reason },
  }).catch(() => { /* best-effort */ });
  await logEvent({
    action:       "agent.uninstall_failed",
    resourceType: "asset",
    resourceId:   assetId,
    level:        "warning",
    message:      `Agent uninstall failed: ${reason}`,
    details:      { managedAgentId },
  });
}

// ─── SSH helpers ──────────────────────────────────────────────────────

interface SshInstallParams {
  host: string;
  cred: Record<string, unknown>;
  binaryBytes: Buffer;
  agentConfBody: string;
  platform: "linux" | "darwin";
  testOverrides?: TestOverrides;
}

async function sshInstall(p: SshInstallParams): Promise<void> {
  if (p.testOverrides?.fakeSshSucceed) return;
  if (p.testOverrides?.fakeSshFail) throw new Error(p.testOverrides.fakeSshFail);

  await withSshClient(p.host, p.cred, async (client) => {
    // 1. SFTP upload binary + installer script to /tmp.
    await sftpPut(client, "/tmp/polaris-agent.bin",         p.binaryBytes, 0o755);
    await sftpPut(client, "/tmp/polaris-agent-install.sh",  installerScript(p.platform), 0o700);
    await sftpPut(client, "/tmp/polaris-agent.conf",        Buffer.from(p.agentConfBody, "utf8"), 0o600);

    // 2. Run the installer. `sudo` is implicit — the credential is
    //    expected to map to a user that can `sudo -n` (passwordless
    //    sudo) on the target. Operators who want a different escalation
    //    model can roll their own bootstrap. If sudo prompts for a
    //    password the install hangs; the timeout below trips it.
    const out = await sshExec(client, "sudo -n bash /tmp/polaris-agent-install.sh", 60_000);
    if (out.exitCode !== 0) {
      throw new Error(`Installer exited ${out.exitCode}: ${truncate(out.stderr || out.stdout, 400)}`);
    }
  });
}

interface SshUninstallParams {
  host: string;
  cred: Record<string, unknown>;
  platform: "linux" | "darwin";
  testOverrides?: TestOverrides;
}

async function sshUninstall(p: SshUninstallParams): Promise<void> {
  if (p.testOverrides?.fakeSshSucceed) return;
  if (p.testOverrides?.fakeSshFail) throw new Error(p.testOverrides.fakeSshFail);

  await withSshClient(p.host, p.cred, async (client) => {
    await sftpPut(client, "/tmp/polaris-agent-uninstall.sh", uninstallerScript(p.platform), 0o700);
    const out = await sshExec(client, "sudo -n bash /tmp/polaris-agent-uninstall.sh", 60_000);
    if (out.exitCode !== 0) {
      throw new Error(`Uninstaller exited ${out.exitCode}: ${truncate(out.stderr || out.stdout, 400)}`);
    }
  });
}

function withSshClient<T>(
  host: string,
  config: Record<string, unknown>,
  fn: (client: SshClient) => Promise<T>,
): Promise<T> {
  const username = String(config.username || "");
  const password = typeof config.password === "string" ? config.password : "";
  const privateKey = typeof config.privateKey === "string" ? config.privateKey : "";
  const port = Number.isFinite(Number(config.port)) ? Number(config.port) : 22;
  if (!username || (!password && !privateKey)) {
    return Promise.reject(new Error("SSH credential is missing username or password/privateKey"));
  }

  return new Promise<T>((resolve, reject) => {
    const client = new SshClient();
    let settled = false;
    const finish = (err: Error | null, val?: T) => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch { /* already closed */ }
      if (err) reject(err); else resolve(val as T);
    };

    client.on("ready", async () => {
      try {
        const v = await fn(client);
        finish(null, v);
      } catch (err: any) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    client.on("error", (err) => finish(err));

    const opts: any = { host, port, username, readyTimeout: 30_000 };
    if (privateKey) opts.privateKey = privateKey;
    else opts.password = password;
    try {
      client.connect(opts);
    } catch (err: any) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function sftpPut(client: SshClient, remotePath: string, body: Buffer, mode: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      const stream = sftp.createWriteStream(remotePath, { mode });
      stream.on("error", reject);
      stream.on("close", () => resolve());
      stream.end(body);
    });
  });
}

interface ExecResult { exitCode: number | null; stdout: string; stderr: string }

function sshExec(client: SshClient, cmd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      const timer = setTimeout(() => {
        try { stream.signal("KILL"); } catch { /* ignore */ }
        reject(new Error(`Remote command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      stream.on("close", (code: number) => {
        clearTimeout(timer);
        exitCode = code ?? null;
        resolve({ exitCode, stdout, stderr });
      });
      stream.on("data",   (d: Buffer) => { stdout += d.toString("utf8"); });
      stream.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    });
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ─── Embedded scripts + agent.conf templating ─────────────────────────
//
// Per-platform installer scripts live inline here (not on disk alongside
// the binary). Rationale: version-coupling — the systemd unit shape /
// launchd plist shape must match the binary's expected paths, and
// shipping them together would mean the operator has to also re-upload
// the script every time we patch a service-management bug.
//
// All three scripts share the same input contract: nothing on the command
// line, everything pre-staged at /tmp/polaris-agent.bin and
// /tmp/polaris-agent.conf (binary + config) — the script just moves them
// into place and registers the service.

function installerScript(platform: "linux" | "darwin"): Buffer {
  if (platform === "linux") {
    return Buffer.from(LINUX_INSTALL_SCRIPT, "utf8");
  }
  return Buffer.from(DARWIN_INSTALL_SCRIPT, "utf8");
}

function uninstallerScript(platform: "linux" | "darwin"): Buffer {
  if (platform === "linux") {
    return Buffer.from(LINUX_UNINSTALL_SCRIPT, "utf8");
  }
  return Buffer.from(DARWIN_UNINSTALL_SCRIPT, "utf8");
}

const LINUX_INSTALL_SCRIPT = `#!/usr/bin/env bash
# Polaris Agent installer for Linux (systemd). Run by polaris-agent-install.sh
# as root via sudo -n. Reads pre-staged binary + config from /tmp/.
set -euo pipefail

BIN_SRC=/tmp/polaris-agent.bin
CONF_SRC=/tmp/polaris-agent.conf
BIN_DST=/usr/local/bin/polaris-agent
CONF_DIR=/etc/polaris-agent
CONF_DST=\${CONF_DIR}/agent.conf
UNIT=/etc/systemd/system/polaris-agent.service

# Stop + remove any existing install so reinstall is idempotent.
systemctl stop  polaris-agent 2>/dev/null || true

install -m 0755 -o root -g root "\${BIN_SRC}"  "\${BIN_DST}"
mkdir -p "\${CONF_DIR}"
install -m 0600 -o root -g root "\${CONF_SRC}" "\${CONF_DST}"

cat > "\${UNIT}" <<'UNIT'
[Unit]
Description=Polaris Agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/polaris-agent -conf /etc/polaris-agent/agent.conf
Restart=on-failure
RestartSec=5
# Dedicated unprivileged user for the agent. Falls back to root if the
# user doesn't exist (operators with strict policies create it ahead of
# time). Agent only reads its config + writes outbound network traffic;
# no privileged operations needed at runtime.
User=polaris-agent
DynamicUser=yes
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

# DynamicUser=yes needs the unit-managed user to own the config; chmod
# at boot is handled by systemd's ReadOnlyPaths semantics. The config
# file stays root-owned but world-readable for the dynamic user.
chmod 0644 "\${CONF_DST}"

systemctl daemon-reload
systemctl enable polaris-agent
systemctl start  polaris-agent

# Clean up the staging files; they're no longer needed.
rm -f "\${BIN_SRC}" "\${CONF_SRC}"

echo "Polaris Agent installed and started"
`;

const LINUX_UNINSTALL_SCRIPT = `#!/usr/bin/env bash
# Polaris Agent uninstaller for Linux (systemd). Idempotent — missing
# files are ignored.
set -euo pipefail

systemctl stop    polaris-agent 2>/dev/null || true
systemctl disable polaris-agent 2>/dev/null || true
rm -f /etc/systemd/system/polaris-agent.service
systemctl daemon-reload || true

rm -rf /etc/polaris-agent
rm -f  /usr/local/bin/polaris-agent

echo "Polaris Agent removed"
`;

const DARWIN_INSTALL_SCRIPT = `#!/usr/bin/env bash
# Polaris Agent installer for macOS (launchd). Run as root via sudo -n.
set -euo pipefail

BIN_SRC=/tmp/polaris-agent.bin
CONF_SRC=/tmp/polaris-agent.conf
BIN_DST=/usr/local/bin/polaris-agent
CONF_DIR=/etc/polaris-agent
CONF_DST=\${CONF_DIR}/agent.conf
PLIST=/Library/LaunchDaemons/com.polaris.agent.plist

# Stop + unload any existing install so reinstall is idempotent.
if [ -f "\${PLIST}" ]; then
  launchctl unload "\${PLIST}" 2>/dev/null || true
fi

install -m 0755 -o root -g wheel "\${BIN_SRC}"  "\${BIN_DST}"
mkdir -p "\${CONF_DIR}"
install -m 0600 -o root -g wheel "\${CONF_SRC}" "\${CONF_DST}"

cat > "\${PLIST}" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>           <string>com.polaris.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/polaris-agent</string>
    <string>-conf</string>
    <string>/etc/polaris-agent/agent.conf</string>
  </array>
  <key>RunAtLoad</key>       <true/>
  <key>KeepAlive</key>       <true/>
  <key>StandardOutPath</key> <string>/var/log/polaris-agent.log</string>
  <key>StandardErrorPath</key> <string>/var/log/polaris-agent.log</string>
</dict>
</plist>
PLIST

chmod 0644 "\${PLIST}"
launchctl load "\${PLIST}"

rm -f "\${BIN_SRC}" "\${CONF_SRC}"

echo "Polaris Agent installed and started"
`;

const DARWIN_UNINSTALL_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

PLIST=/Library/LaunchDaemons/com.polaris.agent.plist

if [ -f "\${PLIST}" ]; then
  launchctl unload "\${PLIST}" 2>/dev/null || true
  rm -f "\${PLIST}"
fi

rm -rf /etc/polaris-agent
rm -f  /usr/local/bin/polaris-agent
rm -f  /var/log/polaris-agent.log

echo "Polaris Agent removed"
`;

interface RenderAgentConfInput {
  serverUrl:       string;
  certFingerprint: string;
  enrollmentToken: string;
  agentId:         string;
}

function renderAgentConf(input: RenderAgentConfInput): string {
  return [
    "# Polaris Agent configuration. Generated by agentInstallService.",
    "# Do not edit by hand — agent rewrites this file on enrollment.",
    `server_url       = ${input.serverUrl}`,
    `cert_fingerprint = ${input.certFingerprint}`,
    `agent_id         = ${input.agentId}`,
    `enrollment_token = ${input.enrollmentToken}`,
    "",
  ].join("\n");
}

// ─── Server-URL inference + binary manifest ───────────────────────────

/**
 * Best-effort own-server URL the installed agent should call back to.
 * Reads POLARIS_PUBLIC_URL if set (the operator pin; covers reverse-
 * proxy / split-DNS scenarios). Falls back to `https://<hostname>:<port>`
 * which is fine for single-box installs where the agent host can resolve
 * Polaris's hostname.
 *
 * If you're shipping Polaris behind a reverse proxy with TLS termination
 * upstream, SET POLARIS_PUBLIC_URL — otherwise the agent will try to
 * dial the upstream server's internal address (no good) and fail TLS
 * with an unhelpful error.
 */
function inferOwnServerUrl(): string {
  const fromEnv = process.env.POLARIS_PUBLIC_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const port = process.env.PORT ?? "3000";
  const host = process.env.POLARIS_PUBLIC_HOST ?? "localhost";
  // We can't easily tell from here whether HTTPS is enabled. Bias toward
  // https since the cert-pin handshake requires it; the install kickoff
  // route already refused when HTTPS isn't running.
  return `https://${host}:${port}`;
}

interface AgentManifest {
  currentVersion:    string;
  minimumCompatible: string;
  binaries:          Record<string, string>;
}

async function loadManifest(): Promise<AgentManifest | null> {
  try {
    const buf = await readFile(resolvePath(AGENT_BIN_DIR, "manifest.json"), "utf8");
    return JSON.parse(buf) as AgentManifest;
  } catch {
    return null;
  }
}

// ─── WinRM (Windows) install/uninstall ────────────────────────────────
//
// Architecture (vs SSH/Linux): we DON'T do a SOAP-based file upload. The
// PowerShell installer running on the host pulls the binary via HTTPS
// from Polaris's public `/api/v1/agents/binary/:filename` endpoint, with
// a cert-pin validation callback so it doesn't trust system CAs. WinRM
// only needs to run ONE command — the PowerShell installer one-liner.
// Saves us writing ~1000 lines of chunked WS-Management Send-verb code
// that's only used here.

interface WinRmInstallParams {
  host: string;
  cred: Record<string, unknown>;
  agentConfBody: string;
  binaryFilename: string;
  serverUrl: string;
  certFingerprint: string;
  testOverrides?: TestOverrides;
}

interface WinRmUninstallParams {
  host: string;
  cred: Record<string, unknown>;
  testOverrides?: TestOverrides;
}

async function winrmInstall(p: WinRmInstallParams): Promise<void> {
  if (p.testOverrides?.fakeSshSucceed) return; // tests reuse the same flag for both transports
  if (p.testOverrides?.fakeSshFail) throw new Error(p.testOverrides.fakeSshFail);

  const conn = winrmConnectionFromCred(p.host, p.cred);

  // Render the installer PowerShell. Base64-encoded agent.conf is
  // embedded so command-line escaping rules don't bite us; pin +
  // server URL + binary filename are passed as separate single-quoted
  // strings (PowerShell's single quotes don't expand $vars).
  const confB64 = Buffer.from(p.agentConfBody, "utf8").toString("base64");
  const ps = WINDOWS_INSTALL_PS
    .replace(/__SERVER_URL__/g,        p.serverUrl)
    .replace(/__CERT_FINGERPRINT__/g,  p.certFingerprint)
    .replace(/__BINARY_FILENAME__/g,   p.binaryFilename)
    .replace(/__AGENT_CONF_B64__/g,    confB64);

  // PowerShell accepts a base64-encoded script via -EncodedCommand; that
  // avoids EVERY shell-escape problem on the way through cmd.exe and
  // the WS-Management envelope. The encoding is UTF-16-LE, per the
  // docs.
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  const out = await winrmRunOne(conn, "powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encoded,
  ]);
  if (out.exitCode !== 0) {
    throw new Error(`Windows installer exited ${out.exitCode}: ${truncate(out.stderr || out.stdout, 400)}`);
  }
}

async function winrmUninstall(p: WinRmUninstallParams): Promise<void> {
  if (p.testOverrides?.fakeSshSucceed) return;
  if (p.testOverrides?.fakeSshFail) throw new Error(p.testOverrides.fakeSshFail);

  const conn = winrmConnectionFromCred(p.host, p.cred);
  const encoded = Buffer.from(WINDOWS_UNINSTALL_PS, "utf16le").toString("base64");
  const out = await winrmRunOne(conn, "powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encoded,
  ]);
  if (out.exitCode !== 0) {
    throw new Error(`Windows uninstaller exited ${out.exitCode}: ${truncate(out.stderr || out.stdout, 400)}`);
  }
}

function winrmConnectionFromCred(host: string, config: Record<string, unknown>): WinRmConnection {
  const username = String(config.username || "");
  const password = String(config.password || "");
  if (!username || !password) {
    throw new Error("WinRM credential is missing username or password");
  }
  return {
    host,
    port:     typeof config.port === "number" ? config.port : undefined,
    useHttps: config.useHttps !== false,
    username,
    password,
    timeoutMs: 120_000, // installer downloads a ~10 MB binary; default 60s is tight
  };
}

// PowerShell install template — runs on the target host.
//
// Substitutions (literal text replace, no escaping needed because all
// placeholder values are server-controlled and don't contain ': or `$):
//   __SERVER_URL__         e.g. https://polaris.example.com:3000
//   __CERT_FINGERPRINT__   e.g. sha256:ab12cd34...
//   __BINARY_FILENAME__    e.g. polaris-agent-0.1.0-windows-amd64.exe
//   __AGENT_CONF_B64__     base64 of the rendered agent.conf body
//
// The cert-pin callback uses ServerCertificateValidationCallback on
// ServicePointManager — works on PowerShell 5.1 (the version that ships
// with every Windows 10 / Server 2016+) AND on PowerShell 7. We
// explicitly do NOT use `-SkipCertificateCheck` (Invoke-WebRequest on
// PS5.1 doesn't support it; PS7 does but skipping checks entirely is
// strictly worse than pinning).
const WINDOWS_INSTALL_PS = `$ErrorActionPreference = 'Stop'

$serverUrl     = '__SERVER_URL__'
$pin           = '__CERT_FINGERPRINT__'.ToLower()
$binaryName    = '__BINARY_FILENAME__'
$confB64       = '__AGENT_CONF_B64__'

$installDir = Join-Path $env:ProgramFiles 'Polaris\\Agent'
$confDir    = Join-Path $env:ProgramData  'Polaris\\agent'
$binaryPath = Join-Path $installDir 'polaris-agent.exe'
$confPath   = Join-Path $confDir    'agent.conf'

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
New-Item -ItemType Directory -Force -Path $confDir    | Out-Null

# Stop + remove any existing install so reinstall is idempotent.
$svc = Get-Service -Name 'polaris-agent' -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.Status -ne 'Stopped') { Stop-Service -Name 'polaris-agent' -Force -ErrorAction SilentlyContinue }
  & sc.exe delete polaris-agent | Out-Null
  # sc.exe is async — give it a moment to release the binary lock.
  Start-Sleep -Seconds 2
}

# Cert-pin Invoke-WebRequest. We set a ServerCertificateValidationCallback
# that compares the leaf SHA-256 against the pinned fingerprint, then
# restore the previous callback after the download. TLS 1.2 is forced
# for compatibility with older Windows defaults.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$prevCallback = [Net.ServicePointManager]::ServerCertificateValidationCallback
[Net.ServicePointManager]::ServerCertificateValidationCallback = {
  param($sender, $cert, $chain, $errors)
  $bytes = $cert.GetRawCertData()
  $sha   = [Security.Cryptography.SHA256]::Create()
  $hash  = $sha.ComputeHash($bytes)
  $hex   = -join ($hash | ForEach-Object { $_.ToString('x2') })
  $observed = 'sha256:' + $hex
  if ($observed -ne $pin) {
    Write-Host "Cert pin mismatch: expected $pin, got $observed"
    return $false
  }
  return $true
}
try {
  $downloadUrl = "$serverUrl/api/v1/agents/binary/$binaryName"
  Invoke-WebRequest -Uri $downloadUrl -OutFile $binaryPath -UseBasicParsing
} finally {
  [Net.ServicePointManager]::ServerCertificateValidationCallback = $prevCallback
}

# Write agent.conf from the embedded base64. Atomic-ish via .tmp + Move-Item.
$confBytes = [Convert]::FromBase64String($confB64)
$tmpConf   = "$confPath.tmp"
[IO.File]::WriteAllBytes($tmpConf, $confBytes)
Move-Item -Force -LiteralPath $tmpConf -Destination $confPath

# ACL: only Administrators + SYSTEM read the config (the bearer is in it).
$acl = Get-Acl $confPath
$acl.SetAccessRuleProtection($true, $false)
$acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
$adminRule  = New-Object Security.AccessControl.FileSystemAccessRule('BUILTIN\\Administrators','FullControl','Allow')
$systemRule = New-Object Security.AccessControl.FileSystemAccessRule('NT AUTHORITY\\SYSTEM','FullControl','Allow')
$acl.AddAccessRule($adminRule)
$acl.AddAccessRule($systemRule)
Set-Acl -Path $confPath -AclObject $acl

# Register the Windows Service. New-Service is the canonical way to create
# a Windows Service from PowerShell on every supported Windows version;
# we explicitly avoid Get-WmiObject / Win32_Service which is DCOM-based
# and deprecated in PowerShell 7+.
New-Service -Name 'polaris-agent' \`
            -DisplayName 'Polaris Agent' \`
            -Description 'Polaris Agent — pushes monitoring samples to Polaris over HTTPS.' \`
            -BinaryPathName ('"' + $binaryPath + '" -conf "' + $confPath + '"') \`
            -StartupType Automatic | Out-Null

# Service recovery actions: restart on first/second/third failure with a 5s delay.
# sc.exe is the only well-supported path for this; New-Service doesn't expose it.
& sc.exe failure polaris-agent reset= 86400 actions= restart/5000/restart/5000/restart/10000 | Out-Null

Start-Service -Name 'polaris-agent'

Write-Host "Polaris Agent installed and started"
`;

const WINDOWS_UNINSTALL_PS = `$ErrorActionPreference = 'Continue'

$svc = Get-Service -Name 'polaris-agent' -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.Status -ne 'Stopped') { Stop-Service -Name 'polaris-agent' -Force -ErrorAction SilentlyContinue }
  & sc.exe delete polaris-agent | Out-Null
  Start-Sleep -Seconds 2
}

$installDir = Join-Path $env:ProgramFiles 'Polaris\\Agent'
$confDir    = Join-Path $env:ProgramData  'Polaris\\agent'
if (Test-Path $installDir) { Remove-Item -Recurse -Force -LiteralPath $installDir }
if (Test-Path $confDir)    { Remove-Item -Recurse -Force -LiteralPath $confDir }

Write-Host "Polaris Agent removed"
exit 0
`;
