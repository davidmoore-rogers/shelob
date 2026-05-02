/**
 * src/utils/paths.ts — Resolve where Polaris's persistent state lives on disk.
 *
 * Single opt-in env var: POLARIS_STATE_DIR.
 *   - Unset (RHEL prod, dev): falls back to the project root, so .env,
 *     .setup-complete, data/backups/, and public/uploads/ stay exactly where
 *     they've always been. Zero behavior change for existing installs.
 *   - Set (Docker image only): redirects all four state items under one
 *     directory so the container needs a single bind mount. The Dockerfile
 *     pins this to /app/state.
 *
 * Layout under STATE_DIR (whichever it is):
 *   .env
 *   .setup-complete
 *   data/backups/
 *   public/uploads/
 *
 * The `public/uploads` substructure is preserved (rather than collapsed to
 * just `uploads/`) so the Express `/uploads/*` static route can be mounted
 * to the same path on both layouts without a special case.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const STATE_DIR = process.env.POLARIS_STATE_DIR
  ? resolve(process.env.POLARIS_STATE_DIR)
  : PROJECT_ROOT;

export const ENV_FILE = resolve(STATE_DIR, ".env");
export const SETUP_COMPLETE_MARKER = resolve(STATE_DIR, ".setup-complete");
export const BACKUP_DIR = resolve(STATE_DIR, "data", "backups");
export const UPLOADS_DIR = resolve(STATE_DIR, "public", "uploads");
