/**
 * src/services/deviceIconService.ts — operator-uploaded device icons
 *
 * Used by the Device Map's topology graph to render hardware-specific
 * imagery (FortiGate-91G chassis, FortiSwitch-148E faceplate, etc.)
 * instead of generic colored circles. Resolution at render time is
 * most-specific-wins:
 *
 *   1. scope="model"        key="<manufacturer>/<model>"  — most specific
 *   2. scope="model"        key="<model>"                 — manufacturer-agnostic
 *   3. scope="type"         key=<assetType>               — type-level
 *   4. scope="manufacturer" key=<manufacturer>            — vendor fallback
 *   5. no row → null (frontend uses default node style)
 *
 * Manufacturer keys are canonicalized through the same alias map as
 * Asset.manufacturer (Fortinet, Inc. → Fortinet) so the picker and the
 * resolver agree.
 *
 * Storage is bytes-in-DB (image data column on the row) plus a dedicated
 * /api/v1/device-icons/:id/image route that serves the raw bytes with
 * Content-Type + Cache-Control headers. Browser caches via standard HTTP
 * cache so a topology re-render doesn't re-fetch the image.
 *
 * Validation at upload time:
 *   - mimeType in the allowed set (PNG / JPEG / WebP / SVG).
 *   - Raster size cap MAX_ICON_BYTES; SVG cap MAX_SVG_BYTES (lower —
 *     operator icons should be tiny and parser work scales with size).
 *   - Magic-byte check on the first few bytes for raster formats.
 *   - SVG: text decode + pattern-based reject of script / DOCTYPE /
 *     ENTITY / foreignObject / event handlers / javascript: URLs /
 *     external href refs / iframe/object/embed / xml-stylesheet PI /
 *     @import in <style>. Reject (not sanitize) so the operator sees
 *     the rejection and re-exports from their tool rather than us
 *     silently rewriting stored content.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { normalizeManufacturer } from "../utils/manufacturerNormalize.js";

const MAX_ICON_BYTES = 256 * 1024; // 256 KB — plenty for a raster node icon.
const MAX_SVG_BYTES = 32 * 1024;   // 32 KB — SVGs are text and parser work scales with size; node icons are simple.

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
]);

// Magic-byte signatures for the raster formats. SVG is handled separately
// by validateSvg() because XML can start with an optional BOM + whitespace
// + either `<?xml` or `<svg`.
const MAGIC_BYTES: Array<{ mime: string; prefix: number[] }> = [
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  { mime: "image/png", prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // JPEG: FF D8 FF
  { mime: "image/jpeg", prefix: [0xff, 0xd8, 0xff] },
  // WebP: RIFF....WEBP
  { mime: "image/webp", prefix: [0x52, 0x49, 0x46, 0x46] },
];

// SVG reject patterns. Any match → refuse the upload. Case-insensitive;
// applied to the decoded UTF-8 text of the SVG. Conservative by design.
const SVG_REJECT_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "<script>",          re: /<\s*script\b/i },
  { name: "<foreignObject>",   re: /<\s*foreignObject\b/i },
  { name: "<iframe>",          re: /<\s*iframe\b/i },
  { name: "<object>",          re: /<\s*object\b/i },
  { name: "<embed>",           re: /<\s*embed\b/i },
  { name: "<!DOCTYPE>",        re: /<!\s*DOCTYPE/i },
  { name: "<!ENTITY>",         re: /<!\s*ENTITY/i },
  { name: "xml-stylesheet PI", re: /<\?\s*xml-stylesheet/i },
  // Inline event handlers (onclick, onload, onmouseover, ...).
  { name: "on*= event handler", re: /\s+on[a-z]+\s*=/i },
  // javascript: in any URL attribute. Allow leading whitespace + the
  // common "&#x6A;avascript:" entity-escape trick is also blocked because
  // we reject any `&#` entity reference in href/xlink:href below.
  { name: "javascript: URL", re: /\b(?:href|xlink:href|src|action|formaction)\s*=\s*["']?\s*(?:&#[xX]?[0-9a-fA-F]+;?\s*)*j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i },
  // External href / xlink:href / src — anything not starting with '#'
  // (in-document fragment). Disallows http://, https://, //, data:,
  // file://, etc. SVGs that need <use href="#foo"> are unaffected.
  { name: "external href", re: /\b(?:href|xlink:href|src)\s*=\s*["'](?!#)[^"']*["']/i },
  // CSS @import or url() pointing outside the document.
  { name: "@import in <style>", re: /@import\b/i },
  { name: "external url() in CSS", re: /url\s*\(\s*["']?(?!\s*#)(?:https?:|\/\/|data:|file:)/i },
];

export type IconScope = "type" | "model" | "manufacturer";

export interface UploadedIcon {
  scope: IconScope;
  key: string;
  filename: string;
  mimeType: string;
  data: Buffer;
  uploadedBy?: string;
}

export interface DeviceIconSummary {
  id: string;
  scope: string;
  key: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedBy: string | null;
  uploadedAt: Date;
}

function detectMagicMime(data: Buffer): string | null {
  for (const { mime, prefix } of MAGIC_BYTES) {
    if (data.length < prefix.length) continue;
    let ok = true;
    for (let i = 0; i < prefix.length; i++) {
      if (data[i] !== prefix[i]) { ok = false; break; }
    }
    if (ok) return mime;
  }
  return null;
}

function normalizeKey(scope: IconScope, key: string): string {
  const trimmed = key.trim();
  if (scope === "type") return trimmed.toLowerCase();
  if (scope === "manufacturer") {
    return normalizeManufacturer(trimmed) ?? trimmed;
  }
  // Model keys: trim each side of the slash so "  Fortinet  /  FortiGate-91G  "
  // canonicalizes to "Fortinet/FortiGate-91G". Manufacturer half goes through
  // the alias map so "Fortinet, Inc./FortiGate-91G" → "Fortinet/FortiGate-91G".
  if (trimmed.includes("/")) {
    const [manuf, ...rest] = trimmed.split("/");
    const manufCanonical = normalizeManufacturer(manuf.trim()) ?? manuf.trim();
    return `${manufCanonical}/${rest.join("/").trim()}`;
  }
  return trimmed;
}

const VALID_TYPE_KEYS = new Set([
  "server", "switch", "router", "firewall", "workstation",
  "printer", "access_point", "other",
]);

function validateSvg(data: Buffer): void {
  // Decode as UTF-8 with replacement so invalid sequences still surface
  // patterns rather than throw. Strip a leading BOM if present.
  let text = data.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const trimmedStart = text.trimStart();
  // Must start with <?xml or <svg. Anything else (HTML, plain text,
  // mis-extension binary that happens to decode) gets refused.
  if (!/^<\?xml\b/i.test(trimmedStart) && !/^<svg\b/i.test(trimmedStart)) {
    throw new AppError(400, "File doesn't look like an SVG (missing <?xml or <svg root element)");
  }
  // Confirm a <svg> element is present somewhere in the document. Guards
  // against an XML file that has the prolog but isn't actually an SVG.
  if (!/<\s*svg\b/i.test(text)) {
    throw new AppError(400, "SVG payload missing <svg> root element");
  }
  for (const { name, re } of SVG_REJECT_PATTERNS) {
    if (re.test(text)) {
      throw new AppError(400, `SVG rejected — contains ${name}. SVG uploads disallow scripts, external references, and other dynamic content.`);
    }
  }
}

export function validateUpload(input: UploadedIcon): void {
  if (input.scope !== "type" && input.scope !== "model" && input.scope !== "manufacturer") {
    throw new AppError(400, `Invalid scope "${input.scope}" — must be "type", "model", or "manufacturer"`);
  }
  const key = normalizeKey(input.scope, input.key);
  if (!key) throw new AppError(400, "Key is required");
  if (input.scope === "type" && !VALID_TYPE_KEYS.has(key)) {
    throw new AppError(400, `Invalid type key "${key}" — must be one of: ${[...VALID_TYPE_KEYS].sort().join(", ")}`);
  }
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new AppError(400, `Unsupported image format "${input.mimeType}" — allowed: PNG, JPEG, WebP, SVG`);
  }
  if (!input.data || input.data.length === 0) {
    throw new AppError(400, "Empty file upload");
  }
  const isSvg = input.mimeType === "image/svg+xml";
  const cap = isSvg ? MAX_SVG_BYTES : MAX_ICON_BYTES;
  if (input.data.length > cap) {
    throw new AppError(400, `Icon too large (${input.data.length} bytes; max ${cap} for ${isSvg ? "SVG" : "raster"})`);
  }
  if (isSvg) {
    validateSvg(input.data);
    return;
  }
  // Magic-byte check — declared mimeType must match what's in the bytes.
  // Defends against mis-extension uploads.
  const detected = detectMagicMime(input.data);
  if (!detected) throw new AppError(400, "File doesn't look like a valid PNG / JPEG / WebP image");
  if (detected !== input.mimeType) {
    throw new AppError(400, `File contents are ${detected} but upload declared ${input.mimeType}`);
  }
}

export async function uploadIcon(input: UploadedIcon): Promise<DeviceIconSummary> {
  validateUpload(input);
  const key = normalizeKey(input.scope, input.key);
  // Prisma 7 Bytes column wants Uint8Array<ArrayBuffer> strictly; the
  // Buffer type from multer is Buffer<ArrayBufferLike> (where ArrayBufferLike
  // includes SharedArrayBuffer). Copy into a fresh Uint8Array backed by a
  // dedicated ArrayBuffer so the type narrows correctly.
  const dataBytes = new Uint8Array(input.data.byteLength);
  dataBytes.set(input.data);
  const row = await prisma.deviceIcon.upsert({
    where: { scope_key: { scope: input.scope, key } },
    create: {
      scope: input.scope,
      key,
      filename: input.filename,
      mimeType: input.mimeType,
      data: dataBytes,
      size: input.data.length,
      uploadedBy: input.uploadedBy ?? null,
    },
    update: {
      filename: input.filename,
      mimeType: input.mimeType,
      data: dataBytes,
      size: input.data.length,
      uploadedBy: input.uploadedBy ?? null,
      uploadedAt: new Date(),
    },
  });
  return summarize(row);
}

export async function listIcons(): Promise<DeviceIconSummary[]> {
  const rows = await prisma.deviceIcon.findMany({
    select: { id: true, scope: true, key: true, filename: true, mimeType: true, size: true, uploadedBy: true, uploadedAt: true },
    orderBy: [{ scope: "asc" }, { key: "asc" }],
  });
  return rows;
}

export async function getIconImage(id: string): Promise<{ mimeType: string; data: Buffer } | null> {
  const row = await prisma.deviceIcon.findUnique({
    where: { id },
    select: { mimeType: true, data: true },
  });
  if (!row) return null;
  return { mimeType: row.mimeType, data: Buffer.from(row.data) };
}

export async function deleteIcon(id: string): Promise<boolean> {
  try {
    await prisma.deviceIcon.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}

// Resolve which icon (if any) applies to an asset. Returns the icon id
// the topology endpoint can reference as `iconUrl: /api/v1/device-icons/<id>/image`.
// Most-specific-wins; null when no icon matches.
//
// Caller passes a snapshot of the asset's relevant fields so this can run
// over an in-memory list without per-asset DB roundtrips.
export interface IconResolutionInput {
  manufacturer: string | null;
  model: string | null;
  assetType: string | null;
}

export async function resolveIconForAsset(
  input: IconResolutionInput,
  iconCache?: Map<string, string | null>,
): Promise<string | null> {
  const candidates = buildResolutionCandidates(input);
  for (const c of candidates) {
    const cacheKey = `${c.scope}|${c.key}`;
    if (iconCache && iconCache.has(cacheKey)) {
      const cached = iconCache.get(cacheKey);
      if (cached !== null) return cached ?? null;
      continue;
    }
    const row = await prisma.deviceIcon.findUnique({
      where: { scope_key: { scope: c.scope, key: c.key } },
      select: { id: true },
    });
    if (iconCache) iconCache.set(cacheKey, row?.id ?? null);
    if (row) return row.id;
  }
  return null;
}

// Bulk-resolution helper for renderers (e.g. topology endpoint) that need
// icons for many assets in one go. Pre-loads all icons once and returns
// a Map<scopeKey, iconId> for in-memory lookup.
export async function loadIconResolutionCache(): Promise<Map<string, string | null>> {
  const rows = await prisma.deviceIcon.findMany({
    select: { id: true, scope: true, key: true },
  });
  const cache = new Map<string, string | null>();
  for (const r of rows) {
    cache.set(`${r.scope}|${r.key}`, r.id);
  }
  return cache;
}

// Resolve an iconUrl for a single asset using a pre-loaded cache (sync).
// Returns the relative URL path or null.
export function resolveIconUrl(input: IconResolutionInput, cache: Map<string, string | null>): string | null {
  const candidates = buildResolutionCandidates(input).map((c) => `${c.scope}|${c.key}`);
  for (const c of candidates) {
    const id = cache.get(c);
    if (id) return `/api/v1/device-icons/${id}/image`;
  }
  return null;
}

// Build the ordered candidate list for resolution. Priority (per project
// decision, see CLAUDE.md "Device Icons"):
//   1. model: <manufacturer>/<model>   (most specific)
//   2. model: <model>
//   3. type:  <assetType>
//   4. manufacturer: <manufacturer>     (vendor-wide fallback)
// Manufacturer values are canonicalized through the alias map so the
// resolver and the picker agree on "Fortinet" vs "Fortinet, Inc.".
function buildResolutionCandidates(input: IconResolutionInput): Array<{ scope: string; key: string }> {
  const candidates: Array<{ scope: string; key: string }> = [];
  const manufacturerCanonical = input.manufacturer
    ? (normalizeManufacturer(input.manufacturer.trim()) ?? input.manufacturer.trim())
    : null;
  if (manufacturerCanonical && input.model) {
    candidates.push({ scope: "model", key: `${manufacturerCanonical}/${input.model.trim()}` });
  }
  if (input.model) {
    candidates.push({ scope: "model", key: input.model.trim() });
  }
  if (input.assetType) {
    candidates.push({ scope: "type", key: input.assetType.trim().toLowerCase() });
  }
  if (manufacturerCanonical) {
    candidates.push({ scope: "manufacturer", key: manufacturerCanonical });
  }
  return candidates;
}

function summarize(row: {
  id: string; scope: string; key: string; filename: string;
  mimeType: string; size: number; uploadedBy: string | null; uploadedAt: Date;
}): DeviceIconSummary {
  return {
    id: row.id,
    scope: row.scope,
    key: row.key,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    uploadedBy: row.uploadedBy,
    uploadedAt: row.uploadedAt,
  };
}
