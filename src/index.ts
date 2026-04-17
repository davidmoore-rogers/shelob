/**
 * src/index.ts — Application entry point
 *
 * Checks if the app needs first-run setup (no DATABASE_URL configured).
 * If so, starts a lightweight setup wizard server.
 * Otherwise, starts the full application.
 */

import { needsSetup } from "./setup/detectSetup.js";

(async () => {
  if (needsSetup()) {
    const { startSetupServer } = await import("./setup/setupServer.js");
    startSetupServer();
  } else {
    const { startApp } = await import("./app.js");
    startApp();
  }
})();
