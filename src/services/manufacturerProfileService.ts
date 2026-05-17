/**
 * src/services/manufacturerProfileService.ts
 *
 * CRUD + cached resolver for the editable `ManufacturerProfile` data model.
 * Replaces the hardcoded VENDOR_TELEMETRY_PROFILES constant at runtime in a
 * follow-up commit; this commit only owns the persistence + read paths.
 *
 * The cache is module-local and refreshed on every write. The hot probe
 * path (Slice 6c) will call `getProfileFor(manufacturer)` which is sync
 * after the boot warm-up — same shape as oidRegistry's API.
 */

import { prisma } from "../db.js";
import { normalizeManufacturer } from "../utils/manufacturerNormalize.js";
import { isTransformKind, type TransformKind } from "../utils/symbolTransforms.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export type MetricKey =
  | "cpu"
  | "memory"
  | "temperature"
  | "interfaces"
  | "lldp"
  | "storage"
  | "wirelessStations";

export const METRIC_KEYS: MetricKey[] = [
  "cpu", "memory", "temperature", "interfaces", "lldp", "storage", "wirelessStations",
];

// Multi-OID composition for the memory metric. Today consulted only when
// metricKey="memory" — lets operators express bytes-form memory in the editable
// profile, matching what the hardcoded VENDOR_TELEMETRY_PROFILES baseline can
// already do via collectMemoryVendor. When present takes precedence over
// defaultSymbol on the metric row (and over `symbol` on an override row).
export type MemoryShape = "percent" | "bytes_used_total" | "bytes_used_free";

export interface MemoryComposition {
  shape:        MemoryShape;
  usedSymbol?:  string | null;
  totalSymbol?: string | null;
  freeSymbol?:  string | null;
  pctSymbol?:   string | null;
}

export interface MetricOverrideRow {
  id:           string;
  modelPattern: string;
  symbol:       string;
  mibId:        string | null;
  type:         "scalar" | "table";
  transform:    TransformKind | null;
  order:        number;
  composition:  MemoryComposition | null;
}

export interface MetricRow {
  id:               string;
  metricKey:        MetricKey;
  defaultSymbol:    string | null;
  defaultMibId:     string | null;
  defaultType:      "scalar" | "table";
  defaultTransform: TransformKind | null;
  composition:      MemoryComposition | null;
  overrides:        MetricOverrideRow[];
}

export interface CustomWidgetRow {
  id:             string;
  name:           string;
  symbol:         string;
  mibId:          string;
  type:           "scalar" | "table";
  widgetType:     "gauge" | "line" | "table";
  transform:      TransformKind | null;
  displayOptions: Record<string, unknown>;
  order:          number;
  modelPattern:   string | null;
}

export interface ProfileSummary {
  id:                 string;
  manufacturer:       string;
  metricCount:        number;
  overrideCount:      number;
  widgetCount:        number;
  scopedMibCount:     number;
  createdAt:          string;
  updatedAt:          string;
}

export interface ProfileFull {
  id:           string;
  manufacturer: string;
  createdBy:    string | null;
  createdAt:    string;
  updatedAt:    string;
  metrics:      MetricRow[];
  widgets:      CustomWidgetRow[];
}

const profileCache = new Map<string, ProfileFull>();
let cacheLoaded = false;

function asMetricKey(value: unknown): MetricKey {
  if (typeof value !== "string" || !(METRIC_KEYS as string[]).includes(value)) {
    throw new AppError(400, "Invalid metricKey");
  }
  return value as MetricKey;
}

function asType(value: unknown): "scalar" | "table" {
  if (value === "scalar" || value === "table") return value;
  throw new AppError(400, "Invalid type — expected 'scalar' or 'table'");
}

function asWidgetType(value: unknown): "gauge" | "line" | "table" {
  if (value === "gauge" || value === "line" || value === "table") return value;
  throw new AppError(400, "Invalid widgetType — expected gauge | line | table");
}

function asTransform(value: unknown): TransformKind | null {
  if (value === null || value === undefined || value === "") return null;
  if (isTransformKind(value)) return value;
  throw new AppError(400, `Invalid transform: ${String(value)}`);
}

const MEMORY_SHAPES: MemoryShape[] = ["percent", "bytes_used_total", "bytes_used_free"];

function trimOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t : null;
}

/**
 * Parse + validate a JSON `composition` blob coming from the API. Returns:
 *   - `null` when the input is null/undefined/empty (clears the column)
 *   - a normalized `MemoryComposition` when valid
 *   - throws AppError(400) when malformed
 *
 * Per-shape required fields:
 *   - "percent"            → pctSymbol required
 *   - "bytes_used_total"   → usedSymbol + totalSymbol required
 *   - "bytes_used_free"    → usedSymbol + freeSymbol required
 *
 * Unrelated fields are stripped on output so the stored shape stays tight
 * regardless of what the client sent.
 *
 * Today scoped to `metricKey="memory"`. The function is metric-key-agnostic
 * so future composition shapes for other metrics can reuse the same column;
 * callers gate by metricKey themselves.
 */
export function parseMemoryComposition(value: unknown): MemoryComposition | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "composition must be a JSON object");
  }
  const raw = value as Record<string, unknown>;
  const shape = raw.shape;
  if (typeof shape !== "string" || !(MEMORY_SHAPES as string[]).includes(shape)) {
    throw new AppError(400, `composition.shape must be one of: ${MEMORY_SHAPES.join(", ")}`);
  }
  const used  = trimOrNull(raw.usedSymbol);
  const total = trimOrNull(raw.totalSymbol);
  const free  = trimOrNull(raw.freeSymbol);
  const pct   = trimOrNull(raw.pctSymbol);
  const out: MemoryComposition = { shape: shape as MemoryShape };
  if (shape === "percent") {
    if (!pct) throw new AppError(400, "composition.pctSymbol is required for shape \"percent\"");
    out.pctSymbol = pct;
  } else if (shape === "bytes_used_total") {
    if (!used)  throw new AppError(400, "composition.usedSymbol is required for shape \"bytes_used_total\"");
    if (!total) throw new AppError(400, "composition.totalSymbol is required for shape \"bytes_used_total\"");
    out.usedSymbol  = used;
    out.totalSymbol = total;
  } else { // bytes_used_free
    if (!used) throw new AppError(400, "composition.usedSymbol is required for shape \"bytes_used_free\"");
    if (!free) throw new AppError(400, "composition.freeSymbol is required for shape \"bytes_used_free\"");
    out.usedSymbol = used;
    out.freeSymbol = free;
  }
  return out;
}

function shapeStoredComposition(raw: unknown): MemoryComposition | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.shape !== "string" || !(MEMORY_SHAPES as string[]).includes(r.shape)) return null;
  // Trust stored DB shape (already validated on write). Reflect whichever
  // symbol fields were stored — defensive `trimOrNull` handles legacy rows
  // that may have empty strings.
  const out: MemoryComposition = { shape: r.shape as MemoryShape };
  const used  = trimOrNull(r.usedSymbol);
  const total = trimOrNull(r.totalSymbol);
  const free  = trimOrNull(r.freeSymbol);
  const pct   = trimOrNull(r.pctSymbol);
  if (used)  out.usedSymbol  = used;
  if (total) out.totalSymbol = total;
  if (free)  out.freeSymbol  = free;
  if (pct)   out.pctSymbol   = pct;
  return out;
}

function shapeProfile(row: any): ProfileFull {
  const metrics: MetricRow[] = (row.metrics || []).map((m: any) => ({
    id:               m.id,
    metricKey:        asMetricKey(m.metricKey),
    defaultSymbol:    m.defaultSymbol ?? null,
    defaultMibId:     m.defaultMibId ?? null,
    defaultType:      asType(m.defaultType),
    defaultTransform: asTransform(m.defaultTransform),
    composition:      shapeStoredComposition(m.composition),
    overrides: (m.overrides || []).map((o: any) => ({
      id:           o.id,
      modelPattern: o.modelPattern,
      symbol:       o.symbol,
      mibId:        o.mibId ?? null,
      type:         asType(o.type),
      transform:    asTransform(o.transform),
      order:        o.order,
      composition:  shapeStoredComposition(o.composition),
    })),
  }));
  const widgets: CustomWidgetRow[] = (row.widgets || []).map((w: any) => ({
    id:             w.id,
    name:           w.name,
    symbol:         w.symbol,
    mibId:          w.mibId,
    type:           asType(w.type),
    widgetType:     asWidgetType(w.widgetType),
    transform:      asTransform(w.transform),
    displayOptions: (w.displayOptions ?? {}) as Record<string, unknown>,
    order:          w.order,
    modelPattern:   w.modelPattern ?? null,
  }));
  return {
    id:           row.id,
    manufacturer: row.manufacturer,
    createdBy:    row.createdBy ?? null,
    createdAt:    row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt:    row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    metrics,
    widgets,
  };
}

export async function refreshProfileCache(): Promise<void> {
  const rows = await (prisma as any).manufacturerProfile.findMany({
    include: {
      metrics: { include: { overrides: { orderBy: { order: "asc" } } } },
      widgets: { orderBy: { order: "asc" } },
    },
  });
  profileCache.clear();
  for (const row of rows) {
    const shaped = shapeProfile(row);
    profileCache.set(shaped.manufacturer.toLowerCase(), shaped);
  }
  cacheLoaded = true;
}

/**
 * Sync getter for the hot probe path. Returns null when the cache hasn't
 * loaded yet OR no profile exists for the given manufacturer. The Slice 6c
 * resolver swap will call this; for now it's exposed for future use and
 * unit-test convenience.
 */
export function getProfileFor(manufacturer: string | null | undefined): ProfileFull | null {
  if (!cacheLoaded || !manufacturer) return null;
  const canonical = normalizeManufacturer(manufacturer);
  if (!canonical) return null;
  return profileCache.get(canonical.toLowerCase()) ?? null;
}

export async function listProfiles(): Promise<ProfileSummary[]> {
  const rows = await (prisma as any).manufacturerProfile.findMany({
    include: {
      metrics: { include: { overrides: true } },
      widgets: true,
    },
    orderBy: { manufacturer: "asc" },
  });
  // Scoped MIB counts — joined separately so the count matches the
  // operator's mental model: "MIBs uploaded under this manufacturer."
  const mibCounts = new Map<string, number>();
  for (const row of rows) {
    const cnt = await (prisma as any).mibFile.count({ where: { manufacturer: row.manufacturer } });
    mibCounts.set(row.id, cnt);
  }
  return rows.map((row: any): ProfileSummary => {
    const overrideCount = (row.metrics || []).reduce(
      (acc: number, m: any) => acc + ((m.overrides || []).length || 0),
      0,
    );
    return {
      id:             row.id,
      manufacturer:   row.manufacturer,
      metricCount:    row.metrics?.length ?? 0,
      overrideCount,
      widgetCount:    row.widgets?.length ?? 0,
      scopedMibCount: mibCounts.get(row.id) ?? 0,
      createdAt:      row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      updatedAt:      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    };
  });
}

export async function getProfile(id: string): Promise<ProfileFull | null> {
  const row = await (prisma as any).manufacturerProfile.findUnique({
    where: { id },
    include: {
      metrics: { include: { overrides: { orderBy: { order: "asc" } } } },
      widgets: { orderBy: { order: "asc" } },
    },
  });
  return row ? shapeProfile(row) : null;
}

export async function createProfile(input: {
  manufacturer: string;
  createdBy?:   string | null;
}): Promise<ProfileFull> {
  const canonical = normalizeManufacturer(input.manufacturer);
  if (!canonical) throw new AppError(400, "Manufacturer is required");

  // Pre-populate one empty metric row per metric key so the operator's
  // first encounter with the modal shows the full canvas. defaultSymbol
  // null = "use built-in seed for this metric" — i.e. no change yet.
  const id = (await import("crypto")).randomUUID();
  await prisma.$transaction([
    (prisma as any).manufacturerProfile.create({
      data: {
        id,
        manufacturer: canonical,
        createdBy:    input.createdBy ?? null,
      },
    }),
    ...METRIC_KEYS.map((mk) =>
      (prisma as any).manufacturerProfileMetric.create({
        data: {
          profileId:   id,
          metricKey:   mk,
          defaultType: "scalar",
        },
      }),
    ),
  ]).catch((err: any) => {
    if (err && err.code === "P2002") {
      throw new AppError(409, `A profile for "${canonical}" already exists`);
    }
    throw err;
  });

  await refreshProfileCache();
  const created = await getProfile(id);
  if (!created) throw new AppError(500, "Profile creation failed");
  return created;
}

export async function updateMetricRow(
  profileId: string,
  metricKey: string,
  input: {
    defaultSymbol?:    string | null;
    defaultMibId?:     string | null;
    defaultType?:      string;
    defaultTransform?: string | null;
    // Memory-only today. Validated by parseMemoryComposition; explicit null
    // (or empty object) clears the stored composition so the row falls back
    // to defaultSymbol. Undefined leaves the existing value alone.
    composition?:      unknown;
  },
): Promise<MetricRow> {
  const mk = asMetricKey(metricKey);
  const row = await (prisma as any).manufacturerProfileMetric.findUnique({
    where: { profileId_metricKey: { profileId, metricKey: mk } },
  });
  if (!row) throw new AppError(404, "Metric row not found for this profile");

  // composition is memory-only; reject on other metrics so a typo in the UI
  // doesn't silently persist nonsense onto the wrong row.
  let compositionUpdate: MemoryComposition | null | undefined = undefined;
  if (input.composition !== undefined) {
    if (mk !== "memory" && input.composition !== null) {
      throw new AppError(400, "composition is only supported on the memory metric");
    }
    compositionUpdate = parseMemoryComposition(input.composition);
  }

  const updated = await (prisma as any).manufacturerProfileMetric.update({
    where: { id: row.id },
    data: {
      defaultSymbol:    input.defaultSymbol === undefined    ? undefined : (input.defaultSymbol ?? null),
      defaultMibId:     input.defaultMibId === undefined     ? undefined : (input.defaultMibId ?? null),
      defaultType:      input.defaultType === undefined      ? undefined : asType(input.defaultType),
      defaultTransform: input.defaultTransform === undefined ? undefined : (asTransform(input.defaultTransform) ?? null),
      composition:      compositionUpdate === undefined ? undefined : (compositionUpdate ?? null),
    },
    include: { overrides: { orderBy: { order: "asc" } } },
  });
  await touchProfile(profileId);
  await refreshProfileCache();
  return {
    id:               updated.id,
    metricKey:        mk,
    defaultSymbol:    updated.defaultSymbol ?? null,
    defaultMibId:     updated.defaultMibId ?? null,
    defaultType:      asType(updated.defaultType),
    defaultTransform: asTransform(updated.defaultTransform),
    composition:      shapeStoredComposition(updated.composition),
    overrides: (updated.overrides || []).map((o: any) => ({
      id:           o.id,
      modelPattern: o.modelPattern,
      symbol:       o.symbol,
      mibId:        o.mibId ?? null,
      type:         asType(o.type),
      transform:    asTransform(o.transform),
      order:        o.order,
      composition:  shapeStoredComposition(o.composition),
    })),
  };
}

export async function createOverride(
  profileId: string,
  metricKey: string,
  input: {
    modelPattern: string;
    symbol?:      string;
    mibId?:       string | null;
    type?:        string;
    transform?:   string | null;
    order?:       number;
    composition?: unknown;
  },
): Promise<MetricOverrideRow> {
  const mk = asMetricKey(metricKey);
  const row = await (prisma as any).manufacturerProfileMetric.findUnique({
    where: { profileId_metricKey: { profileId, metricKey: mk } },
  });
  if (!row) throw new AppError(404, "Metric row not found for this profile");
  if (!input.modelPattern || !input.modelPattern.trim()) {
    throw new AppError(400, "modelPattern is required");
  }
  try {
    new RegExp(input.modelPattern);
  } catch {
    throw new AppError(400, "modelPattern must be a valid regex");
  }
  let composition: MemoryComposition | null = null;
  if (input.composition !== undefined) {
    if (mk !== "memory" && input.composition !== null) {
      throw new AppError(400, "composition is only supported on the memory metric");
    }
    composition = parseMemoryComposition(input.composition);
  }
  // Either composition is supplied (bytes-form / explicit percent) or the
  // legacy single-symbol path applies. Composition wins when both are sent.
  const symbol = (input.symbol || "").trim();
  if (!composition && !symbol) {
    throw new AppError(400, "symbol or composition is required");
  }
  const created = await (prisma as any).manufacturerProfileMetricOverride.create({
    data: {
      metricRowId:  row.id,
      modelPattern: input.modelPattern,
      // `symbol` is non-null in the DB schema — store the composition's
      // primary OID (or an empty string if the operator only supplied a
      // composition with no scalar value) so the column stays satisfied
      // without losing the bytes-form intent.
      symbol:       symbol || (composition?.usedSymbol ?? composition?.pctSymbol ?? ""),
      mibId:        input.mibId ?? null,
      type:         asType(input.type ?? "scalar"),
      transform:    asTransform(input.transform ?? null),
      order:        Number.isFinite(input.order) ? Number(input.order) : 0,
      composition:  composition ?? null,
    },
  });
  await touchProfile(profileId);
  await refreshProfileCache();
  return {
    id:           created.id,
    modelPattern: created.modelPattern,
    symbol:       created.symbol,
    mibId:        created.mibId ?? null,
    type:         asType(created.type),
    transform:    asTransform(created.transform),
    order:        created.order,
    composition:  shapeStoredComposition(created.composition),
  };
}

export async function updateOverride(
  overrideId: string,
  input: {
    modelPattern?: string;
    symbol?:       string;
    mibId?:        string | null;
    type?:         string;
    transform?:    string | null;
    order?:        number;
    composition?:  unknown;
  },
): Promise<MetricOverrideRow> {
  const existing = await (prisma as any).manufacturerProfileMetricOverride.findUnique({
    where: { id: overrideId },
    include: { metricRow: true },
  });
  if (!existing) throw new AppError(404, "Override not found");
  if (input.modelPattern !== undefined) {
    if (!input.modelPattern.trim()) throw new AppError(400, "modelPattern is required");
    try { new RegExp(input.modelPattern); } catch {
      throw new AppError(400, "modelPattern must be a valid regex");
    }
  }
  let compositionUpdate: MemoryComposition | null | undefined = undefined;
  if (input.composition !== undefined) {
    if (existing.metricRow.metricKey !== "memory" && input.composition !== null) {
      throw new AppError(400, "composition is only supported on the memory metric");
    }
    compositionUpdate = parseMemoryComposition(input.composition);
  }
  // When composition is being set, allow `symbol` to remain whatever the
  // composition's primary OID is; when neither is supplied keep existing.
  // Reject only the "symbol cleared AND no composition present" case so the
  // DB's non-null `symbol` column stays satisfied.
  if (input.symbol !== undefined && !input.symbol.trim()) {
    // Symbol blank — composition must already cover it.
    const effectiveComposition =
      compositionUpdate !== undefined ? compositionUpdate : shapeStoredComposition(existing.composition);
    if (!effectiveComposition) throw new AppError(400, "symbol is required (or set a composition)");
  }
  const updated = await (prisma as any).manufacturerProfileMetricOverride.update({
    where: { id: overrideId },
    data: {
      modelPattern: input.modelPattern === undefined ? undefined : input.modelPattern,
      symbol:       input.symbol === undefined       ? undefined : input.symbol,
      mibId:        input.mibId === undefined        ? undefined : (input.mibId ?? null),
      type:         input.type === undefined         ? undefined : asType(input.type),
      transform:    input.transform === undefined    ? undefined : (asTransform(input.transform) ?? null),
      order:        input.order === undefined        ? undefined : Number(input.order),
      composition:  compositionUpdate === undefined  ? undefined : (compositionUpdate ?? null),
    },
  });
  await touchProfile(existing.metricRow.profileId);
  await refreshProfileCache();
  return {
    id:           updated.id,
    modelPattern: updated.modelPattern,
    symbol:       updated.symbol,
    mibId:        updated.mibId ?? null,
    type:         asType(updated.type),
    transform:    asTransform(updated.transform),
    order:        updated.order,
    composition:  shapeStoredComposition(updated.composition),
  };
}

export async function deleteOverride(overrideId: string): Promise<void> {
  const existing = await (prisma as any).manufacturerProfileMetricOverride.findUnique({
    where: { id: overrideId },
    include: { metricRow: true },
  });
  if (!existing) return;
  await (prisma as any).manufacturerProfileMetricOverride.delete({ where: { id: overrideId } });
  await touchProfile(existing.metricRow.profileId);
  await refreshProfileCache();
}

export async function createWidget(
  profileId: string,
  input: {
    name:           string;
    symbol:         string;
    mibId:          string;
    type?:          string;
    widgetType:     string;
    transform?:     string | null;
    displayOptions?: Record<string, unknown>;
    order?:         number;
    modelPattern?:  string | null;
    createdBy?:     string | null;
  },
): Promise<CustomWidgetRow> {
  if (!input.name || !input.name.trim()) throw new AppError(400, "Widget name is required");
  if (!input.symbol || !input.symbol.trim()) throw new AppError(400, "symbol is required");
  if (!input.mibId) throw new AppError(400, "mibId is required for custom widgets");
  if (input.modelPattern) {
    try { new RegExp(input.modelPattern); } catch {
      throw new AppError(400, "modelPattern must be a valid regex");
    }
  }
  const created = await (prisma as any).manufacturerCustomWidget.create({
    data: {
      profileId,
      name:           input.name.trim(),
      symbol:         input.symbol.trim(),
      mibId:          input.mibId,
      type:           asType(input.type ?? "scalar"),
      widgetType:     asWidgetType(input.widgetType),
      transform:      asTransform(input.transform ?? null),
      displayOptions: input.displayOptions ?? {},
      order:          Number.isFinite(input.order) ? Number(input.order) : 0,
      modelPattern:   input.modelPattern ?? null,
      createdBy:      input.createdBy ?? null,
    },
  });
  await touchProfile(profileId);
  await refreshProfileCache();
  return shapeWidget(created);
}

export async function updateWidget(
  widgetId: string,
  input: {
    name?:          string;
    symbol?:        string;
    mibId?:         string;
    type?:          string;
    widgetType?:    string;
    transform?:     string | null;
    displayOptions?: Record<string, unknown>;
    order?:         number;
    modelPattern?:  string | null;
  },
): Promise<CustomWidgetRow> {
  const existing = await (prisma as any).manufacturerCustomWidget.findUnique({ where: { id: widgetId } });
  if (!existing) throw new AppError(404, "Widget not found");
  if (input.modelPattern) {
    try { new RegExp(input.modelPattern); } catch {
      throw new AppError(400, "modelPattern must be a valid regex");
    }
  }
  const updated = await (prisma as any).manufacturerCustomWidget.update({
    where: { id: widgetId },
    data: {
      name:           input.name === undefined           ? undefined : input.name.trim(),
      symbol:         input.symbol === undefined         ? undefined : input.symbol.trim(),
      mibId:          input.mibId === undefined          ? undefined : input.mibId,
      type:           input.type === undefined           ? undefined : asType(input.type),
      widgetType:     input.widgetType === undefined     ? undefined : asWidgetType(input.widgetType),
      transform:      input.transform === undefined      ? undefined : (asTransform(input.transform) ?? null),
      displayOptions: input.displayOptions === undefined ? undefined : (input.displayOptions ?? {}),
      order:          input.order === undefined          ? undefined : Number(input.order),
      modelPattern:   input.modelPattern === undefined   ? undefined : (input.modelPattern ?? null),
    },
  });
  await touchProfile(existing.profileId);
  await refreshProfileCache();
  return shapeWidget(updated);
}

export async function deleteWidget(widgetId: string): Promise<void> {
  const existing = await (prisma as any).manufacturerCustomWidget.findUnique({ where: { id: widgetId } });
  if (!existing) return;
  await (prisma as any).manufacturerCustomWidget.delete({ where: { id: widgetId } });
  await touchProfile(existing.profileId);
  await refreshProfileCache();
}

export async function deleteProfile(profileId: string): Promise<void> {
  // No usage-count refusal here yet — the resolver swap (Slice 6c) is the
  // commit that introduces dependency. Today deleting a profile is purely
  // additive removal since monitoring still consults the hardcoded constant.
  await (prisma as any).manufacturerProfile.delete({ where: { id: profileId } });
  await refreshProfileCache();
}

function shapeWidget(w: any): CustomWidgetRow {
  return {
    id:             w.id,
    name:           w.name,
    symbol:         w.symbol,
    mibId:          w.mibId,
    type:           asType(w.type),
    widgetType:     asWidgetType(w.widgetType),
    transform:      asTransform(w.transform),
    displayOptions: (w.displayOptions ?? {}) as Record<string, unknown>,
    order:          w.order,
    modelPattern:   w.modelPattern ?? null,
  };
}

async function touchProfile(profileId: string): Promise<void> {
  try {
    await (prisma as any).manufacturerProfile.update({
      where: { id: profileId },
      data:  { updatedAt: new Date() },
    });
  } catch (err) {
    logger.debug({ err, profileId }, "Failed to bump manufacturer profile updatedAt");
  }
}
