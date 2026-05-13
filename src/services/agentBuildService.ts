/**
 * src/services/agentBuildService.ts — Polaris Agent build runner
 *
 * Drives the "Build agent binaries" button on Server Settings → Maintenance.
 * Single in-memory state map + single-build mutex (queueing comes in a
 * follow-on commit). One build runs all 6 platform/arch combinations
 * serially via `go build` direct invocation (no `make` dependency — Windows
 * hosts don't ship GNU make by default).
 *
 * Lifecycle:
 *
 *   POST /server-settings/agents/build  → startBuild()
 *       → setImmediate(runBuild) returns immediately
 *       → phase: preparing → building:linux-amd64 → ... → writing-manifest → complete
 *         (or → failed at any step)
 *
 * UI polls GET /build/:buildId every 2 s to render the progress strip;
 * UI polls GET /build/current on tab mount to rehydrate any in-flight
 * build the operator left running when they switched tabs.
 *
 * Per the Phase A foundation commit, the version stamped into the binaries
 * + used as the directory name + written to manifest.json comes from
 * `getAgentVersion()` (reads `agent/VERSION`), NOT `getAppVersion()`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rename, writeFile, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_BIN_DIR, STATE_DIR } from "../utils/paths.js";
import { getAgentVersion, getAgentSourceDir } from "../utils/version.js";
import { logEvent } from "../api/routes/events.js";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

// ─── Public types ─────────────────────────────────────────────────────

export const PLATFORMS = [
  { os: "linux",   arch: "amd64" },
  { os: "linux",   arch: "arm64" },
  { os: "darwin",  arch: "amd64" },
  { os: "darwin",  arch: "arm64" },
  { os: "windows", arch: "amd64" },
  { os: "windows", arch: "arm64" },
] as const;

export type BuildPhase =
  | "preparing"
  | "building:linux-amd64"
  | "building:linux-arm64"
  | "building:darwin-amd64"
  | "building:darwin-arm64"
  | "building:windows-amd64"
  | "building:windows-arm64"
  | "writing-manifest"
  | "complete"
  | "failed";

export interface BuildStep {
  platform: string;
  arch:     string;
  status:   "pending" | "running" | "success" | "failed";
  elapsedMs?: number;
  error?:    string;
}

export interface BuildState {
  buildId:     string;
  version:     string;
  phase:       BuildPhase;
  steps:       BuildStep[];
  startedAt:   Date;
  finishedAt?: Date;
  goVersion?:  string;
  error?:      string;
  /** Username of the operator who triggered, or "system:..." for automated. */
  actor:       string;
}

// ─── Module-local state ───────────────────────────────────────────────

const buildStates: Map<string, BuildState> = new Map();
let currentBuildId: string | null = null;

// ─── Go-detection ─────────────────────────────────────────────────────

export interface GoAvailability {
  ok:       boolean;
  version?: string;
  error?:   string;
}

/**
 * Returns true when `go version` runs successfully. UI gates the Build
 * button on this; the route layer returns 400 when false.
 *
 * Not cached because Go can be installed/removed on the host without
 * restarting Polaris, and operators expect "install Go and reload" to
 * just work. The exec is cheap (<10 ms when Go is on PATH).
 */
export async function goAvailable(): Promise<GoAvailability> {
  try {
    const { stdout } = await execFileAsync("go", ["version"], { timeout: 5_000 });
    return { ok: true, version: stdout.trim() };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "go not found on PATH" };
  }
}

// ─── Build kickoff ────────────────────────────────────────────────────

export interface StartBuildInput {
  actor: string;
}

export interface StartBuildResult {
  buildId: string;
  version: string;
}

export class BuildInFlightError extends Error {
  constructor() { super("A build is already in flight"); this.name = "BuildInFlightError"; }
}

export class GoUnavailableError extends Error {
  constructor(reason: string) { super(reason); this.name = "GoUnavailableError"; }
}

export async function startBuild(input: StartBuildInput): Promise<StartBuildResult> {
  // The single-mutex + immediate-409 behaviour is intentional for this
  // phase — Phase D extends it into a real FIFO queue with QUEUE_DEPTH=3.
  if (currentBuildId !== null) {
    throw new BuildInFlightError();
  }
  const go = await goAvailable();
  if (!go.ok) {
    throw new GoUnavailableError(go.error ?? "Go is not available on this Polaris server");
  }

  const buildId = randomUUID();
  const version = getAgentVersion();
  const state: BuildState = {
    buildId,
    version,
    phase:     "preparing",
    steps:     PLATFORMS.map((p) => ({ platform: p.os, arch: p.arch, status: "pending" })),
    startedAt: new Date(),
    goVersion: go.version,
    actor:     input.actor,
  };
  buildStates.set(buildId, state);
  currentBuildId = buildId;

  await logEvent({
    action:       "agent.build.started",
    level:        "info",
    actor:        input.actor,
    resourceType: "polaris-agent",
    resourceName: version,
    message:      `Agent build v${version} started`,
    details:      { buildId, goVersion: go.version },
  });

  // Fire async; never await. The route handler returns immediately so
  // the UI sees the in-flight state on its next poll.
  setImmediate(() => {
    runBuild(buildId).catch((err) => {
      logger.error({ err, buildId }, "Agent build crashed unexpectedly");
    });
  });

  return { buildId, version };
}

// ─── Build runner ─────────────────────────────────────────────────────

async function runBuild(buildId: string): Promise<void> {
  const state = buildStates.get(buildId);
  if (!state) {
    // Defensive — should never happen since startBuild populates the map
    // before scheduling runBuild.
    currentBuildId = null;
    return;
  }

  try {
    await doRun(state);
  } catch (err: any) {
    state.phase    = "failed";
    state.error    = err?.message ?? String(err);
    state.finishedAt = new Date();
    await logEvent({
      action:       "agent.build.failed",
      level:        "warning",
      actor:        state.actor,
      resourceType: "polaris-agent",
      resourceName: state.version,
      message:      `Agent build v${state.version} failed: ${state.error}`,
      details:      { buildId, error: state.error },
    });
  } finally {
    currentBuildId = null;
  }
}

async function doRun(state: BuildState): Promise<void> {
  const agentSourceDir = getAgentSourceDir();
  if (!agentSourceDir) {
    throw new Error("agent/ source directory not found — is the release tarball complete?");
  }

  // Phase: preparing
  const versionDir = resolvePath(AGENT_BIN_DIR, state.version);
  await mkdir(versionDir,          { recursive: true });
  await mkdir(resolvePath(STATE_DIR, ".cache", "go-build"), { recursive: true });

  // Build each platform serially. Parallel `go build` calls thrash the
  // shared GOCACHE; serial keeps cache contention down + total time
  // around 60 s on a 2-vCPU host with a warm cache.
  for (let i = 0; i < PLATFORMS.length; i++) {
    const { os, arch } = PLATFORMS[i];
    const step = state.steps[i];

    state.phase = `building:${os}-${arch}` as BuildPhase;
    step.status = "running";
    const stepStart = Date.now();

    const exeSuffix = os === "windows" ? ".exe" : "";
    const outName   = `polaris-agent-${os}-${arch}${exeSuffix}`;
    const outPath   = resolvePath(versionDir, outName);

    try {
      await execFileAsync(
        "go",
        [
          "build",
          "-trimpath",
          `-ldflags=-s -w -X main.version=${state.version}`,
          "-o", outPath,
          "./cmd/polaris-agent",
        ],
        {
          cwd:     agentSourceDir,
          timeout: 5 * 60_000, // 5 min per platform — extremely generous; warm-cache builds finish in <10 s
          env: {
            ...process.env,
            CGO_ENABLED: "0",
            GOOS:        os,
            GOARCH:      arch,
            HOME:        STATE_DIR,
            GOCACHE:     resolvePath(STATE_DIR, ".cache", "go-build"),
            GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? "local",
          },
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      step.status    = "success";
      step.elapsedMs = Date.now() - stepStart;
    } catch (err: any) {
      step.status    = "failed";
      step.elapsedMs = Date.now() - stepStart;
      step.error     = truncate(err?.stderr ?? err?.message ?? String(err), 800);
      throw new Error(`go build failed for ${os}/${arch}: ${step.error}`);
    }
  }

  // Phase: writing-manifest
  state.phase = "writing-manifest";
  const manifest = {
    currentVersion:    state.version,
    minimumCompatible: state.version,
    binaries: Object.fromEntries(
      PLATFORMS.map(({ os, arch }) => [
        `${os}-${arch}`,
        `polaris-agent-${os}-${arch}${os === "windows" ? ".exe" : ""}`,
      ]),
    ),
  };
  // Atomic via .tmp + rename.
  const manifestPath    = resolvePath(AGENT_BIN_DIR, "manifest.json");
  const manifestTmpPath = manifestPath + ".tmp";
  await writeFile(manifestTmpPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf-8" });
  await rename(manifestTmpPath, manifestPath);

  // Phase: complete
  state.phase      = "complete";
  state.finishedAt = new Date();
  await logEvent({
    action:       "agent.build.completed",
    level:        "info",
    actor:        state.actor,
    resourceType: "polaris-agent",
    resourceName: state.version,
    message:      `Agent build v${state.version} completed`,
    details: {
      buildId:       state.buildId,
      totalElapsedMs: state.finishedAt.getTime() - state.startedAt.getTime(),
      platforms:     state.steps.map((s) => ({ platform: s.platform, arch: s.arch, elapsedMs: s.elapsedMs })),
    },
  });
}

// ─── Read helpers (route layer + UI) ──────────────────────────────────

export function getBuild(buildId: string): BuildState | null {
  return buildStates.get(buildId) ?? null;
}

export function getCurrentBuild(): BuildState | null {
  if (currentBuildId === null) return null;
  return buildStates.get(currentBuildId) ?? null;
}

// ─── Inventory ────────────────────────────────────────────────────────

export interface InventoryFile {
  platform: string;
  arch:     string;
  filename: string;
  present:  boolean;
  sizeBytes?: number;
  mtime?:    string;
}

export interface InventoryResult {
  goAvailable: boolean;
  goVersion?:  string;
  goError?:    string;
  manifest:    { currentVersion: string; minimumCompatible?: string; binaries: Record<string, string> } | null;
  files:       InventoryFile[];
  agentSourceVersion: string;
}

/**
 * Snapshot of what's available right now: is Go on PATH? what does the
 * on-disk manifest say? which platform binaries are present + their
 * sizes / mtimes? what's the agent source's claimed version?
 *
 * The agent source version is the comparison key — the UI shows a
 * "v{currentVersion} (latest: v{agentSourceVersion})" hint when the
 * manifest's currentVersion is behind getAgentVersion().
 */
export async function getInventory(): Promise<InventoryResult> {
  const go = await goAvailable();
  const agentSourceVersion = getAgentVersion();

  let manifest: InventoryResult["manifest"] = null;
  const manifestPath = resolvePath(AGENT_BIN_DIR, "manifest.json");
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.currentVersion === "string") {
      manifest = parsed;
    }
  } catch { /* manifest missing or malformed — both render as "no builds yet" */ }

  const files: InventoryFile[] = [];
  for (const { os, arch } of PLATFORMS) {
    const filename = `polaris-agent-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
    let present = false, sizeBytes: number | undefined, mtime: string | undefined;
    if (manifest) {
      const p = resolvePath(AGENT_BIN_DIR, manifest.currentVersion, filename);
      try {
        const st = await stat(p);
        present = true;
        sizeBytes = st.size;
        mtime = st.mtime.toISOString();
      } catch { /* not present */ }
    }
    files.push({ platform: os, arch, filename, present, sizeBytes, mtime });
  }

  return {
    goAvailable: go.ok,
    goVersion:   go.version,
    goError:     go.error,
    manifest,
    files,
    agentSourceVersion,
  };
}

// ─── Small utilities ──────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
