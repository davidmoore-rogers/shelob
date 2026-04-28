/**
 * src/services/oidRegistry.ts — Symbolic name → numeric OID resolver.
 *
 * Loads every uploaded MIB from the database, parses out OBJECT-TYPE /
 * OBJECT IDENTIFIER / MODULE-IDENTITY / NOTIFICATION-TYPE / OBJECT-IDENTITY
 * assignments, and resolves each symbol against a built-in seed of standard
 * SMI roots + common vendor enterprise prefixes. The resolved table is cached
 * in-memory; `refresh()` reloads from the database after MIB uploads/deletes.
 *
 * Resolution algorithm:
 *   1. Start with `numeric: Map<string, string>` seeded with the well-known
 *      roots in BUILT_IN_OIDS.
 *   2. Each parsed entry is `{ name, parts }` where `parts` is the raw
 *      `::= { ... }` body — a sequence of identifier names and integers.
 *   3. Make repeated passes: for each entry whose first part is a known
 *      symbol (or one of the few literal numeric forms SMI uses at root),
 *      resolve the chain by joining the prefix with every integer in `parts`.
 *      Loop until a pass adds nothing new — anything still unresolved is an
 *      unmet dependency (often "you forgot to upload the SMI MIB").
 *
 * The registry intentionally treats the ::= body as a flat sequence so that
 * SMI's chained form (`::= { iso 3 6 1 4 1 9 ... }`) and the more common
 * named-parent form (`::= { ciscoMgmt 109 }`) both fall out of one pass.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

// ─── Seed ──────────────────────────────────────────────────────────────────
//
// Standard SMI roots from RFC 1155 / RFC 2578 plus a small set of vendor
// enterprise prefixes. Including the vendor prefixes lets users upload only
// the leaf MIB they care about (e.g. CISCO-PROCESS-MIB) without having to
// chase down every CISCO-SMI dependency first.
const BUILT_IN_OIDS: Record<string, string> = {
  // Top-level
  ccitt: "0",
  iso: "1",
  "joint-iso-ccitt": "2",
  org: "1.3",
  dod: "1.3.6",
  internet: "1.3.6.1",
  directory: "1.3.6.1.1",
  mgmt: "1.3.6.1.2",
  "mib-2": "1.3.6.1.2.1",
  experimental: "1.3.6.1.3",
  private: "1.3.6.1.4",
  enterprises: "1.3.6.1.4.1",
  security: "1.3.6.1.5",
  snmpV2: "1.3.6.1.6",
  snmpDomains: "1.3.6.1.6.1",
  snmpProxys: "1.3.6.1.6.2",
  snmpModules: "1.3.6.1.6.3",
  // Cisco
  cisco: "1.3.6.1.4.1.9",
  ciscoMgmt: "1.3.6.1.4.1.9.9",
  // Juniper
  juniperMIB: "1.3.6.1.4.1.2636",
  // Mikrotik
  mikrotik: "1.3.6.1.4.1.14988",
  mtxrSystem: "1.3.6.1.4.1.14988.1.1.3",
  // Aruba / HP / HPE
  hp: "1.3.6.1.4.1.11",
  hpSwitch: "1.3.6.1.4.1.11.2.14.11.5.1.9",
  // Fortinet
  fortinet: "1.3.6.1.4.1.12356",
  fnFortiGateMib: "1.3.6.1.4.1.12356.101",
  // Dell
  dell: "1.3.6.1.4.1.674",
};

// ─── Parser ────────────────────────────────────────────────────────────────

interface ParsedAssignment {
  name: string;
  parts: string[]; // raw ::= { ... } body — mix of identifier names and integer literals
}

// SMI assignment forms we care about. The body before ::= can be huge (full
// OBJECT-TYPE clauses with DESCRIPTION blocks), so we capture lazily up to
// the closing brace of the OID assignment.
const ASSIGNMENT_RE =
  /\b([a-z][\w-]*)\s+(?:OBJECT-TYPE|OBJECT\s+IDENTIFIER|MODULE-IDENTITY|OBJECT-IDENTITY|NOTIFICATION-TYPE|OBJECT-GROUP|NOTIFICATION-GROUP|MODULE-COMPLIANCE)\b[\s\S]*?::=\s*\{\s*([^{}]+?)\s*\}/g;

// Strip ASN.1 comments (already lifted from mibService — duplicated here to
// keep this module independent and avoid a circular import).
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n && text[i] !== '"') {
        out += text[i];
        i++;
      }
      if (i < n) {
        out += text[i];
        i++;
      }
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      out += "  ";
      i += 2;
      while (i < n) {
        if (text[i] === "\n" || text[i] === "\r") break;
        if (text[i] === "-" && text[i + 1] === "-") {
          out += "  ";
          i += 2;
          break;
        }
        out += text[i] === "\t" ? "\t" : " ";
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function parseObjectAssignments(rawText: string): ParsedAssignment[] {
  const stripped = stripComments(rawText);
  const out: ParsedAssignment[] = [];
  let m: RegExpExecArray | null;
  ASSIGNMENT_RE.lastIndex = 0;
  while ((m = ASSIGNMENT_RE.exec(stripped))) {
    const name = m[1];
    // Reject ALLCAPS keywords that snuck through (SMI has a handful of
    // reserved words like SEQUENCE, IMPORTS that won't match the leading
    // lowercase character — but be defensive).
    if (/^[A-Z]/.test(name)) continue;
    const parts = m[2].trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    out.push({ name, parts });
  }
  return out;
}

// ─── Cache + resolution ────────────────────────────────────────────────────

let _numeric: Map<string, string> | null = null;
let _unresolved: string[] = [];
let _byMib: Map<string, string[]> = new Map(); // mibId → resolved symbol names from that MIB
let _loadingPromise: Promise<void> | null = null;

function isInteger(s: string): boolean {
  return /^\d+$/.test(s);
}

function resolveAll(entries: ParsedAssignment[]): { numeric: Map<string, string>; unresolved: string[] } {
  const numeric = new Map<string, string>(Object.entries(BUILT_IN_OIDS));

  // Iteratively resolve until a full pass adds nothing new.
  let progress = true;
  let pending = entries.slice();
  while (progress && pending.length > 0) {
    progress = false;
    const stillPending: ParsedAssignment[] = [];
    for (const e of pending) {
      const resolved = tryResolveParts(e.parts, numeric);
      if (resolved) {
        if (!numeric.has(e.name)) {
          numeric.set(e.name, resolved);
          progress = true;
        }
      } else {
        stillPending.push(e);
      }
    }
    pending = stillPending;
  }

  return {
    numeric,
    unresolved: pending.map((e) => e.name),
  };
}

// Try to resolve an SMI assignment body to a numeric OID. The body is a
// sequence of names and integers, e.g.
//   `ciscoMgmt 109 1`             — name + sub-ids
//   `iso 3 6 1 4 1 9 9 109`       — fully-numeric chain anchored at iso
//   `cpmCPUTotalEntry 8`          — single name + sub-id
// The leading element must be a known symbol (including the SMI roots in
// BUILT_IN_OIDS); subsequent elements are integers (or known symbols too,
// though that's vanishingly rare in real MIBs).
function tryResolveParts(parts: string[], numeric: Map<string, string>): string | null {
  if (parts.length === 0) return null;
  const head = parts[0];
  let prefix: string | null;
  if (isInteger(head)) {
    prefix = head;
  } else if (numeric.has(head)) {
    prefix = numeric.get(head)!;
  } else {
    return null; // dependency not yet resolved
  }
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (isInteger(p)) {
      prefix += "." + p;
    } else if (numeric.has(p)) {
      prefix += "." + numeric.get(p)!;
    } else {
      // OBJECT IDENTIFIER assignments inside a body (e.g. `{ a b 5 }`) almost
      // never reference a second symbol in real MIBs — bail.
      return null;
    }
  }
  return prefix;
}

async function loadInternal(): Promise<void> {
  const rows = await prisma.mibFile.findMany({
    select: { id: true, moduleName: true, contents: true },
  });

  const allEntries: ParsedAssignment[] = [];
  const entriesByMib = new Map<string, ParsedAssignment[]>();
  for (const row of rows) {
    try {
      const entries = parseObjectAssignments(row.contents);
      allEntries.push(...entries);
      entriesByMib.set(row.id, entries);
    } catch (err: any) {
      logger.warn({ mib: row.moduleName, err: err?.message }, "MIB parse failed during oidRegistry refresh");
    }
  }

  const { numeric, unresolved } = resolveAll(allEntries);
  _numeric = numeric;
  _unresolved = unresolved;
  _byMib = new Map();
  for (const [mibId, entries] of entriesByMib) {
    const resolvedNames = entries.map((e) => e.name).filter((n) => numeric.has(n));
    _byMib.set(mibId, resolvedNames);
  }

  if (rows.length > 0) {
    logger.info(
      {
        mibs: rows.length,
        symbols: numeric.size - Object.keys(BUILT_IN_OIDS).length,
        unresolved: unresolved.length,
      },
      "MIB symbol table loaded",
    );
  }
}

async function ensureLoaded(): Promise<void> {
  if (_numeric) return;
  if (!_loadingPromise) _loadingPromise = loadInternal();
  await _loadingPromise;
  _loadingPromise = null;
}

/**
 * Resolve a symbolic OID name to its numeric form (e.g.
 * `cpmCPUTotal5secRev` → `1.3.6.1.4.1.9.9.109.1.1.1.1.8`). Returns `null`
 * when the name isn't defined in any uploaded MIB or when its dependency
 * chain couldn't be resolved (usually a missing IMPORTS dependency).
 */
export async function resolveOid(name: string): Promise<string | null> {
  await ensureLoaded();
  if (!_numeric) return null;
  return _numeric.get(name) ?? null;
}

/**
 * Synchronous variant for hot probe paths. Callers must have awaited
 * `ensureRegistryLoaded()` (or `refreshRegistry()`) at least once before;
 * returns null until the registry is loaded.
 */
export function resolveOidSync(name: string): string | null {
  if (!_numeric) return null;
  return _numeric.get(name) ?? null;
}

export async function ensureRegistryLoaded(): Promise<void> {
  await ensureLoaded();
}

/**
 * Reload the registry from the database. Called after MIB uploads/deletes
 * and at app startup.
 */
export async function refreshRegistry(): Promise<void> {
  _numeric = null;
  _unresolved = [];
  _byMib = new Map();
  _loadingPromise = null;
  await ensureLoaded();
}

export interface RegistrySnapshot {
  symbolCount: number;
  unresolvedCount: number;
  unresolvedNames: string[]; // capped at 50 for sanity
}

export async function getRegistrySnapshot(): Promise<RegistrySnapshot> {
  await ensureLoaded();
  return {
    symbolCount: _numeric ? _numeric.size - Object.keys(BUILT_IN_OIDS).length : 0,
    unresolvedCount: _unresolved.length,
    unresolvedNames: _unresolved.slice(0, 50),
  };
}

/** Number of resolved symbols contributed by a specific MIB row id. */
export async function getMibSymbolCount(mibId: string): Promise<number> {
  await ensureLoaded();
  return _byMib.get(mibId)?.length ?? 0;
}
