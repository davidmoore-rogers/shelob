/**
 * src/jobs/mergeFortiswitchEndpointGhosts.ts
 *
 * One-shot startup cleanup. Before the FortiSwitch baseMac capture landed
 * (see DiscoveredFortiSwitch.baseMac in fortimanagerService.ts and the
 * `is_fortilink_peer` join in detected-device), a managed FortiSwitch was
 * discovered by serial (assetType="switch", no MAC) while its own
 * management MAC was independently learned by the FortiGate's DHCP / ARP /
 * MAC-table pathway and created a SEPARATE Asset (assetType="other" or
 * "workstation", sourceKind="fortigate-endpoint"). Both referred to the
 * same physical device but had no overlapping identifier the dedup logic
 * used.
 *
 * This sweep:
 *   1. Pages through Asset rows where assetType="switch" AND macAddress IS NULL.
 *   2. For each, looks up its fortiswitch AssetSource to recover the
 *      switch's mgmt IP, then searches for sibling endpoint assets whose
 *      `ipAddress` matches AND whose `lastSeenSwitch` starts with
 *      `<switch.hostname>/` (the FortiLink-port sighting pattern).
 *   3. When exactly one orphan matches, transfers AssetMacAddress /
 *      AssetAssociatedIp / AssetIpHistory / AssetFortigateSighting rows
 *      from orphan → switch (delete-on-conflict for unique violations),
 *      stamps macAddress on the switch, and deletes the orphan plus its
 *      AssetSource rows. Skip when multiple orphans match (operator review).
 *
 * Pairs with the inline MAC-fallback lookup added to the FortiSwitch
 * update path in `syncDhcpSubnets`, which prevents the duplication on
 * future discoveries.
 *
 * Idempotent: re-running finds zero candidates once convergent. Sample
 * tables (AssetMonitorSample / Telemetry / etc.) cascade-delete with
 * the orphan — endpoint assets are not monitored by default so these
 * are virtually always empty for the orphan side.
 */

import { logger } from "../utils/logger.js";
import { prisma } from "../db.js";
import { runInstrumentedJob } from "./_metrics.js";

const PAGE_SIZE = 200;

(async () => {
  try {
    await runInstrumentedJob("mergeFortiswitchEndpointGhosts", async () => {
      let cursor: { id: string } | undefined = undefined;
      let scannedCount = 0;
      let mergedCount = 0;
      let skippedAmbiguousCount = 0;

      while (true) {
        const switches: Array<{
          id: string;
          hostname: string | null;
          ipAddress: string | null;
          sources: Array<{ observed: unknown }>;
        }> = await prisma.asset.findMany({
          where: { assetType: "switch", macAddress: null },
          select: {
            id: true,
            hostname: true,
            ipAddress: true,
            sources: {
              where: { sourceKind: "fortiswitch" },
              select: { observed: true },
              take: 1,
            },
          },
          orderBy: { id: "asc" },
          take: PAGE_SIZE,
          ...(cursor ? { cursor, skip: 1 } : {}),
        });
        if (switches.length === 0) break;
        cursor = { id: switches[switches.length - 1].id };
        scannedCount += switches.length;

        for (const sw of switches) {
          const observed = (sw.sources[0]?.observed ?? null) as Record<string, unknown> | null;
          const mgmtIp = (typeof observed?.mgmtIp === "string" && observed.mgmtIp) || sw.ipAddress || null;
          const hostname = sw.hostname;
          if (!mgmtIp || !hostname) continue;

          const orphans = await prisma.asset.findMany({
            where: {
              id: { not: sw.id },
              ipAddress: mgmtIp,
              assetType: { in: ["other", "workstation"] }, // FortiGate device-inventory defaults
              lastSeenSwitch: { startsWith: `${hostname}/` },
              sources: { some: { sourceKind: "fortigate-endpoint" } },
            },
            select: { id: true, macAddress: true, hostname: true, lastSeenSwitch: true },
            take: 2, // 2 to detect ambiguity
          });

          if (orphans.length === 0) continue;
          if (orphans.length > 1) {
            skippedAmbiguousCount++;
            logger.warn(
              {
                switchId: sw.id,
                switchHostname: hostname,
                mgmtIp,
                orphanIds: orphans.map((o) => o.id),
              },
              "FortiSwitch ghost-merge: multiple orphan candidates — skipping (operator review)",
            );
            continue;
          }

          const orphan = orphans[0];
          try {
            await mergeOrphanIntoSwitch(sw.id, orphan.id, orphan.macAddress);
            mergedCount++;
            logger.info(
              { switchId: sw.id, switchHostname: hostname, orphanId: orphan.id, adoptedMac: orphan.macAddress },
              "FortiSwitch ghost-merge: merged orphan endpoint into switch",
            );
          } catch (err) {
            logger.warn(
              { err, switchId: sw.id, orphanId: orphan.id },
              "FortiSwitch ghost-merge: failed to merge orphan (will retry next boot)",
            );
          }
        }

        if (switches.length < PAGE_SIZE) break;
      }

      if (scannedCount > 0 || mergedCount > 0) {
        logger.info(
          { scanned: scannedCount, merged: mergedCount, skippedAmbiguous: skippedAmbiguousCount },
          "FortiSwitch ghost-merge complete",
        );
      }
    });
  } catch (err) {
    logger.error({ err }, "mergeFortiswitchEndpointGhosts failed (will retry next boot)");
  }
})();

async function mergeOrphanIntoSwitch(
  switchId: string,
  orphanId: string,
  orphanMac: string | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // AssetMacAddress — unique on (assetId, mac). Re-point non-conflicting,
    // delete conflicting (the switch already has that MAC).
    {
      const swMacs = await tx.assetMacAddress.findMany({
        where: { assetId: switchId },
        select: { mac: true },
      });
      const swMacSet = new Set(swMacs.map((m) => m.mac));
      const orphanMacs = await tx.assetMacAddress.findMany({
        where: { assetId: orphanId },
        select: { id: true, mac: true },
      });
      for (const m of orphanMacs) {
        if (swMacSet.has(m.mac)) {
          await tx.assetMacAddress.delete({ where: { id: m.id } });
        } else {
          await tx.assetMacAddress.update({ where: { id: m.id }, data: { assetId: switchId } });
        }
      }
    }

    // AssetAssociatedIp — unique on (assetId, ip).
    {
      const swIps = await tx.assetAssociatedIp.findMany({
        where: { assetId: switchId },
        select: { ip: true },
      });
      const swIpSet = new Set(swIps.map((i) => i.ip));
      const orphanIps = await tx.assetAssociatedIp.findMany({
        where: { assetId: orphanId },
        select: { id: true, ip: true },
      });
      for (const i of orphanIps) {
        if (swIpSet.has(i.ip)) {
          await tx.assetAssociatedIp.delete({ where: { id: i.id } });
        } else {
          await tx.assetAssociatedIp.update({ where: { id: i.id }, data: { assetId: switchId } });
        }
      }
    }

    // AssetIpHistory — unique on (assetId, ip).
    {
      const swHist = await tx.assetIpHistory.findMany({
        where: { assetId: switchId },
        select: { ip: true },
      });
      const swHistSet = new Set(swHist.map((h) => h.ip));
      const orphanHist = await tx.assetIpHistory.findMany({
        where: { assetId: orphanId },
        select: { id: true, ip: true },
      });
      for (const h of orphanHist) {
        if (swHistSet.has(h.ip)) {
          await tx.assetIpHistory.delete({ where: { id: h.id } });
        } else {
          await tx.assetIpHistory.update({ where: { id: h.id }, data: { assetId: switchId } });
        }
      }
    }

    // AssetFortigateSighting — unique on (assetId, fortigateDevice).
    {
      const swSights = await tx.assetFortigateSighting.findMany({
        where: { assetId: switchId },
        select: { fortigateDevice: true },
      });
      const swSightSet = new Set(swSights.map((s) => s.fortigateDevice));
      const orphanSights = await tx.assetFortigateSighting.findMany({
        where: { assetId: orphanId },
        select: { id: true, fortigateDevice: true },
      });
      for (const s of orphanSights) {
        if (swSightSet.has(s.fortigateDevice)) {
          await tx.assetFortigateSighting.delete({ where: { id: s.id } });
        } else {
          await tx.assetFortigateSighting.update({ where: { id: s.id }, data: { assetId: switchId } });
        }
      }
    }

    // Source rows on the orphan are all by definition placeholders
    // superseded by the switch's canonical fortiswitch source — drop them.
    // Cannot re-point them: AssetSource is uniquely keyed on
    // (sourceKind, externalId), and any conflict would mean the switch
    // already has a more authoritative row for that source.
    await tx.assetSource.deleteMany({ where: { assetId: orphanId } });

    // Stamp the adopted MAC onto the switch when we have one.
    if (orphanMac) {
      await tx.asset.update({
        where: { id: switchId },
        data: { macAddress: orphanMac },
      });
    }

    // Cascade-delete the orphan. Any sample tables (monitor / telemetry /
    // interface / storage / lldp / wireless / custom widget) wipe with it —
    // endpoint assets are not monitored by default so these are usually
    // empty. If somehow the orphan was being monitored, those samples are
    // lost; the switch starts fresh on its own monitoring path.
    await tx.asset.delete({ where: { id: orphanId } });
  });
}
