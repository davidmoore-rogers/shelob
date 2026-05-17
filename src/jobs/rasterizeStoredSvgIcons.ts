/**
 * src/jobs/rasterizeStoredSvgIcons.ts
 *
 * One-shot startup migration: convert every DeviceIcon row still stored
 * as image/svg+xml into image/png using the same resvg rasterizer the
 * upload path uses. Pairs with the inline conversion in
 * `deviceIconService.uploadIcon` — once both have run, no SVG bytes
 * remain in the DeviceIcon table and Cytoscape's topology renderer
 * always gets a raster source with intrinsic pixel dimensions.
 *
 * Background: Cytoscape's `background-image` pipeline loads images via
 * `new Image()` and rasterizes onto a canvas. SVGs exported by Adobe
 * Illustrator (and most design tools) omit `width`/`height` on the
 * opening tag and declare only `viewBox`, so the browser picks a tiny
 * default natural size and Cytoscape can't scale the bitmap up — the
 * icon visually anchors upper-left and stays small at every zoom.
 * Rasterizing on the server bypasses the entire class of bug.
 *
 * Idempotent: re-running the job after it converges is a no-op
 * (the mimeType filter finds zero rows). Best-effort per row — a
 * single malformed SVG doesn't abort the rest of the migration.
 */

import { logger } from "../utils/logger.js";
import { rasterizeStoredSvgIcons } from "../services/deviceIconService.js";
import { runInstrumentedJob } from "./_metrics.js";

(async () => {
  try {
    await runInstrumentedJob("rasterizeStoredSvgIcons", async () => {
      const { converted, failed } = await rasterizeStoredSvgIcons();
      if (converted > 0 || failed > 0) {
        logger.info({ converted, failed }, "Rasterized stored SVG device icons to PNG");
      }
    });
  } catch (err) {
    logger.error({ err }, "Stored-SVG icon rasterization failed (will retry next boot)");
  }
})();
