/**
 * src/setup/detectSetup.ts — Detect whether first-run setup is needed
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Returns true if the application needs first-run setup.
 * Checks: .env file exists AND DATABASE_URL is set.
 */
export function needsSetup(): boolean {
  // If DATABASE_URL is set and non-empty, we're configured
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0) {
    return false;
  }

  // No DATABASE_URL — check if .env file exists at all
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return true;

  // .env exists but DATABASE_URL is missing/empty — needs setup
  return true;
}
