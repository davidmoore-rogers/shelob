/**
 * src/jobs/migrateMonitorTransport.ts
 *
 * One-shot startup migration for the per-stream monitor transport toggles
 * (Integration.config.monitor{ResponseTime,Telemetry,Interfaces}Source).
 *
 * Before this migration the FMG/FortiGate integration's `monitorCredentialId`
 * field implicitly rerouted the response-time probe to SNMP whenever set. The
 * new explicit `monitorResponseTimeSource = "snmp"` toggle is the single
 * source of truth — this job back-fills it for any integration that already
 * had a credential configured, so existing deployments don't regress on first
 * boot after upgrade.
 *
 * Idempotent: only writes when monitorCredentialId is set AND
 * monitorResponseTimeSource is unset. Skips integrations whose toggle is
 * already explicitly "rest" or "snmp".
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";

(async () => {
  try {
    const integrations = await prisma.integration.findMany({
      where: { type: { in: ["fortimanager", "fortigate"] } },
      select: { id: true, name: true, type: true, config: true },
    });
    let migrated = 0;
    for (const integ of integrations) {
      const cfg = (integ.config && typeof integ.config === "object" ? integ.config : {}) as Record<string, unknown>;
      const credId = typeof cfg.monitorCredentialId === "string" ? cfg.monitorCredentialId : null;
      const existing = cfg.monitorResponseTimeSource;
      if (!credId) continue;
      if (existing === "rest" || existing === "snmp") continue;
      const newCfg = { ...cfg, monitorResponseTimeSource: "snmp" };
      await prisma.integration.update({ where: { id: integ.id }, data: { config: newCfg } });
      migrated++;
    }
    if (migrated > 0) {
      logger.info({ count: migrated }, "Back-filled monitorResponseTimeSource=snmp on integrations with legacy monitorCredentialId");
    }
  } catch (err) {
    logger.error({ err }, "Monitor-transport startup migration failed (existing integrations may need manual toggle)");
  }
})();
