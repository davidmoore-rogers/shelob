/**
 * src/api/routes/deviceIcons.ts — operator-uploaded device icons
 *
 * Admin CRUD for the icons used by the Device Map's topology graph.
 * Image-serve endpoint is auth-only (any logged-in user) so the topology
 * modal can render them without a secondary auth dance.
 */

import { Router } from "express";
import multer from "multer";
import {
  uploadIcon,
  listIcons,
  getIconImage,
  deleteIcon,
} from "../../services/deviceIconService.js";
import { logEvent } from "./events.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { AppError } from "../../utils/errors.js";

const router = Router();

// Hard cap matches deviceIconService's MAX_ICON_BYTES (raster cap is
// the larger of the two; the service enforces the lower SVG cap after
// inspecting mimeType). Multer rejects oversized uploads before the
// handler ever sees the buffer.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 256 * 1024 } });

// GET /device-icons — list. Hashes are not returned (they don't exist),
// just the metadata + a thumbnail URL the UI uses for previews.
router.get("/", requireAdmin, async (_req, res, next) => {
  try {
    const icons = await listIcons();
    res.json(
      icons.map((i) => ({
        ...i,
        // Convenience URL for the UI thumbnail and the topology renderer.
        // Same path the topology endpoint embeds in node payloads.
        url: `/api/v1/device-icons/${i.id}/image`,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// POST /device-icons — multipart upload.
//   field name: file (required)
//   form fields:
//     scope          ("manufacturer-type" | "manufacturer-model")
//     manufacturer   (string, required; canonicalized via alias map)
//     typeOrModel    (string, required; assetType enum value when
//                     scope=manufacturer-type, free text when
//                     scope=manufacturer-model)
// Re-uploading the same canonical key replaces the existing image.
router.post("/", requireAdmin, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError(400, "Missing 'file' upload");
    const scope = String(req.body?.scope || "");
    const manufacturer = String(req.body?.manufacturer || "");
    const typeOrModel = String(req.body?.typeOrModel || "");
    if (!scope) throw new AppError(400, "scope is required");
    const summary = await uploadIcon({
      scope: scope as "manufacturer-type" | "manufacturer-model",
      manufacturer,
      typeOrModel,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      data: req.file.buffer,
      uploadedBy: (req as any).session?.username,
    });
    logEvent({
      action: "device_icon.uploaded",
      resourceType: "device_icon",
      resourceId: summary.id,
      resourceName: `${summary.scope}:${summary.key}`,
      actor: (req as any).session?.username,
      level: "info",
      message: `Uploaded device icon for ${summary.scope}:${summary.key} (${summary.size} bytes, ${summary.mimeType})`,
    });
    res.json({ ...summary, url: `/api/v1/device-icons/${summary.id}/image` });
  } catch (err) {
    next(err);
  }
});

// DELETE /device-icons/:id
router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const ok = await deleteIcon(id);
    if (!ok) throw new AppError(404, "Icon not found");
    logEvent({
      action: "device_icon.deleted",
      resourceType: "device_icon",
      resourceId: id,
      actor: (req as any).session?.username,
      level: "info",
      message: `Deleted device icon ${id}`,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /device-icons/:id/image — serve raw bytes. Auth-only (session
// cookie); cacheable for 1 hour. Topology modal references this URL on
// each Cytoscape node's `background-image`. Browser cache deduplicates
// fetches across re-renders.
router.get("/:id/image", requireAuth, async (req, res, next) => {
  try {
    const img = await getIconImage(String(req.params.id));
    if (!img) throw new AppError(404, "Icon not found");
    // SVGs uploaded from Illustrator / common design tools often carry
    // `viewBox="0 0 192 192"` with NO `width`/`height` attribute. When
    // such an SVG is loaded via `new Image()` (Cytoscape's bitmap
    // pipeline path), the browser falls back to a tiny default natural
    // size and Cytoscape ends up with a too-small bitmap to scale —
    // the icon stops growing past a certain zoom and visually anchors
    // upper-left inside the node. Injecting explicit width/height on
    // serve gives the rasterizer a large source bitmap to work from
    // (512x512 is comfortably above any topology zoom we render at)
    // without modifying stored bytes — fixes every SVG already in the
    // DB without a backfill. Raster formats (PNG/JPEG/WebP) have
    // intrinsic pixel dimensions and don't need this.
    let payload = img.data;
    if (img.mimeType === "image/svg+xml") {
      payload = ensureSvgIntrinsicSize(img.data);
    }
    res.setHeader("Content-Type", img.mimeType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Length", String(payload.length));
    // Defense-in-depth for SVG: the upload-time validator already rejects
    // <script>, event handlers, external refs, etc. — but the same bytes
    // are reachable via a direct GET on this URL, so we layer browser-side
    // mitigations too. nosniff stops MIME confusion; the strict CSP blocks
    // any residual script / fetch / image / font / connect from executing
    // even if a bypass slipped past the validator.
    if (img.mimeType === "image/svg+xml") {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      );
    }
    res.send(payload);
  } catch (err) {
    next(err);
  }
});

// Inject `width="512" height="512"` into the opening <svg> tag when
// neither attribute is present. Idempotent — if EITHER width or height
// is already declared, the bytes pass through untouched (we trust the
// operator's explicit dimensions). Non-SVG-looking bytes also pass
// through; the upload validator already gates real SVG-ness.
const SVG_INJECT_SIZE = 512;
function ensureSvgIntrinsicSize(buf: Buffer): Buffer {
  let text: string;
  try {
    text = buf.toString("utf8");
  } catch {
    return buf;
  }
  const match = text.match(/<svg\b([^>]*)>/i);
  if (!match) return buf;
  const attrs = match[1];
  if (/\bwidth\s*=/i.test(attrs) || /\bheight\s*=/i.test(attrs)) return buf;
  const injected = `<svg width="${SVG_INJECT_SIZE}" height="${SVG_INJECT_SIZE}"${attrs}>`;
  const rewritten = text.replace(match[0], injected);
  return Buffer.from(rewritten, "utf8");
}

export default router;
