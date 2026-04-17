/**
 * src/jobs/updateCheck.ts
 *
 * Scheduled job: checks for application updates weekly via git fetch.
 * The result is stored in the update status so the Database tab can
 * show a notification without the admin clicking "Check for Updates".
 *
 * Usage in app.ts:
 *   import "./jobs/updateCheck.js";
 */

import { checkForUpdates, getUpdateStatus } from "../services/updateService.js";
import { logger } from "../utils/logger.js";

const INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

async function runCheck(): Promise<void> {
  try {
    const current = getUpdateStatus();

    // Don't overwrite an in-progress update or a completed notification
    if (
      current.state === "applying" ||
      current.state === "restarting" ||
      current.state === "complete" ||
      current.state === "available"
    ) {
      return;
    }

    const result = await checkForUpdates();

    if (result.state === "available") {
      logger.info(
        { current: result.currentVersion, latest: result.latestVersion, behind: result.commitsBehind },
        "Application update available"
      );
    } else {
      logger.debug("Update check: up to date");
    }
  } catch (err) {
    logger.error(err, "Failed to check for updates");
  }
}

// First check 60 seconds after startup, then weekly
setTimeout(runCheck, 60 * 1000);
setInterval(runCheck, INTERVAL_MS);
