/**
 * src/services/sampleRetentionService.ts
 *
 * Global sample-retention policy. Phase 5 pulled retention out of the
 * per-tier monitor-settings hierarchy (where it was confusingly mixed in
 * with cadence / polling / credentials / MIB hints) and into a single
 * `Setting("sampleRetention")` row edited from the Server Settings →
 * Maintenance card.
 *
 * Why global: retention is fundamentally a storage concern, not a per-
 * device-class concern. Operators tune it because disk fills up — that's
 * a fleet-wide question. The tiered model (detail / hourly / daily) is
 * also meant to be uniform across the fleet so the rollup writer can
 * produce one set of *_hourly / *_daily rows that every consumer reads.
 *
 * Per-class refinement stays. Operators may legitimately want shorter
 * retention for the chattier infra classes (switches and APs at 48-port
 * scale generate ~10× the interface samples of an endpoint). The
 * `default` / `switch` / `accessPoint` breakdown is preserved at every
 * tier × stream cell.
 *
 * Shape:
 *
 *   {
 *     sample:     { detail: ClassRet, hourly: ClassRet, daily: ClassRet },
 *     telemetry:  { detail: ClassRet, hourly: ClassRet, daily: ClassRet },
 *     systemInfo: { detail: ClassRet, hourly: ClassRet, daily: ClassRet },
 *   }
 *
 * where `ClassRet = { default: number, switch: number, accessPoint: number }`.
 *
 * Defaults match the SolarWinds-style tiering operators already know:
 * 7 days detail / 30 days hourly / 365 days daily, uniform across classes
 * and streams. 0 disables the tier (= keep forever for that class+tier).
 *
 * In-process cache with a 5-second TTL: the prune layer reads this once
 * per nightly tick (no cache hit), but the chart history endpoints
 * resolve retention on every request, and the in-process cache avoids a
 * DB roundtrip per chart open. Cache is invalidated on every write via
 * `invalidateSampleRetentionCache()`.
 */

import { prisma } from "../db.js";

export const SETTING_KEY = "sampleRetention";

export type RetentionStream = "sample" | "telemetry" | "systemInfo";
export type RetentionTier   = "detail" | "hourly" | "daily";
export type RetentionClass  = "default" | "switch" | "accessPoint";

export interface ClassRetention {
  default:     number;
  switch:      number;
  accessPoint: number;
}

export interface TierRetention {
  detail: ClassRetention;
  hourly: ClassRetention;
  daily:  ClassRetention;
}

export interface SampleRetention {
  sample:     TierRetention;
  telemetry:  TierRetention;
  systemInfo: TierRetention;
}

// SolarWinds-style defaults. Operators tune from the Maintenance card.
const DEFAULT_DETAIL_DAYS = 7;
const DEFAULT_HOURLY_DAYS = 30;
const DEFAULT_DAILY_DAYS  = 365;

function defaultClass(value: number): ClassRetention {
  return { default: value, switch: value, accessPoint: value };
}

function defaultTier(): TierRetention {
  return {
    detail: defaultClass(DEFAULT_DETAIL_DAYS),
    hourly: defaultClass(DEFAULT_HOURLY_DAYS),
    daily:  defaultClass(DEFAULT_DAILY_DAYS),
  };
}

export function defaultSampleRetention(): SampleRetention {
  return {
    sample:     defaultTier(),
    telemetry:  defaultTier(),
    systemInfo: defaultTier(),
  };
}

// In-process cache. TTL deliberately short so an admin PUT is visible
// to chart queries within a few seconds even without explicit
// invalidation — and short enough that a hot path (every chart request)
// doesn't hit the DB.
const CACHE_TTL_MS = 5000;
let cache: { value: SampleRetention; fetchedAt: number } | null = null;

export function invalidateSampleRetentionCache(): void {
  cache = null;
}

function toPositiveInt(v: unknown, fallback: number): number {
  if (v == null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function parseClass(raw: unknown, fallback: ClassRetention): ClassRetention {
  if (raw == null || typeof raw !== "object") return { ...fallback };
  const r = raw as Record<string, unknown>;
  return {
    default:     toPositiveInt(r.default,     fallback.default),
    switch:      toPositiveInt(r.switch,      fallback.switch),
    accessPoint: toPositiveInt(r.accessPoint, fallback.accessPoint),
  };
}

function parseTier(raw: unknown, fallback: TierRetention): TierRetention {
  if (raw == null || typeof raw !== "object") return {
    detail: { ...fallback.detail },
    hourly: { ...fallback.hourly },
    daily:  { ...fallback.daily },
  };
  const r = raw as Record<string, unknown>;
  return {
    detail: parseClass(r.detail, fallback.detail),
    hourly: parseClass(r.hourly, fallback.hourly),
    daily:  parseClass(r.daily,  fallback.daily),
  };
}

function parseSampleRetention(raw: unknown): SampleRetention {
  const fallback = defaultSampleRetention();
  if (raw == null || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;
  return {
    sample:     parseTier(r.sample,     fallback.sample),
    telemetry:  parseTier(r.telemetry,  fallback.telemetry),
    systemInfo: parseTier(r.systemInfo, fallback.systemInfo),
  };
}

export async function getSampleRetention(): Promise<SampleRetention> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.value;
  }
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const value = parseSampleRetention(row?.value);
  cache = { value, fetchedAt: now };
  return value;
}

/**
 * Replace the stored retention with the supplied value. Missing fields
 * inherit from the current stored value (so the UI can PUT a partial
 * update without losing other tiers). Validates each numeric to a
 * non-negative integer; out-of-range or non-numeric values fall back to
 * the existing stored value.
 */
export async function updateSampleRetention(input: Partial<SampleRetention> | Record<string, unknown>): Promise<SampleRetention> {
  const current = await getSampleRetention();
  // Re-parse the input on top of `current` so partial updates merge
  // correctly. parseSampleRetention with `current` as the fallback gives
  // us exactly that semantic.
  const merged = mergeRetention(current, input);
  await prisma.setting.upsert({
    where:  { key: SETTING_KEY },
    update: { value: merged as any },
    create: { key: SETTING_KEY, value: merged as any },
  });
  invalidateSampleRetentionCache();
  return merged;
}

function mergeClass(current: ClassRetention, input: unknown): ClassRetention {
  if (input == null || typeof input !== "object") return { ...current };
  const i = input as Record<string, unknown>;
  return {
    default:     i.default     == null ? current.default     : toPositiveInt(i.default,     current.default),
    switch:      i.switch      == null ? current.switch      : toPositiveInt(i.switch,      current.switch),
    accessPoint: i.accessPoint == null ? current.accessPoint : toPositiveInt(i.accessPoint, current.accessPoint),
  };
}

function mergeTier(current: TierRetention, input: unknown): TierRetention {
  if (input == null || typeof input !== "object") return {
    detail: { ...current.detail },
    hourly: { ...current.hourly },
    daily:  { ...current.daily },
  };
  const i = input as Record<string, unknown>;
  return {
    detail: i.detail == null ? { ...current.detail } : mergeClass(current.detail, i.detail),
    hourly: i.hourly == null ? { ...current.hourly } : mergeClass(current.hourly, i.hourly),
    daily:  i.daily  == null ? { ...current.daily }  : mergeClass(current.daily,  i.daily),
  };
}

function mergeRetention(current: SampleRetention, input: Partial<SampleRetention> | Record<string, unknown>): SampleRetention {
  const i = input as Record<string, unknown>;
  return {
    sample:     i.sample     == null ? current.sample     : mergeTier(current.sample,     i.sample),
    telemetry:  i.telemetry  == null ? current.telemetry  : mergeTier(current.telemetry,  i.telemetry),
    systemInfo: i.systemInfo == null ? current.systemInfo : mergeTier(current.systemInfo, i.systemInfo),
  };
}

/**
 * Convenience: pull the retention number for one (stream, tier, class)
 * triple out of a SampleRetention bundle. Callers that already have a
 * SampleRetention in hand can do `r.sample.detail.switch` directly;
 * this is for code paths that want a string-keyed lookup.
 */
export function getRetentionDays(
  retention: SampleRetention,
  stream: RetentionStream,
  tier: RetentionTier,
  klass: RetentionClass,
): number {
  return retention[stream][tier][klass];
}

/**
 * Map an `Asset.assetType` enum value to the retention class it belongs to.
 * Anything that isn't a switch or access point falls into `default` — the
 * retention dimension only splits out the two infra classes that generate
 * the dominant share of sample volume on big fleets.
 */
export function pickClassForAssetType(assetType: string | null | undefined): RetentionClass {
  if (assetType === "switch") return "switch";
  if (assetType === "access_point") return "accessPoint";
  return "default";
}
