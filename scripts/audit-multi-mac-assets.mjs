#!/usr/bin/env node
/**
 * scripts/audit-multi-mac-assets.mjs
 *
 * Finds assets whose macAddresses list looks cross-stapled — i.e. MACs from
 * different DHCP subnets that were merged onto one asset by the old
 * findByEntry IP-fallback (fixed in commits 2ac0361 / e6096f7).
 *
 * Default: dry-run report.
 *   node scripts/audit-multi-mac-assets.mjs
 *
 * Apply mode: for each flagged asset, keep only MACs whose subnetCidr
 * contains the asset's primary ipAddress, and drop the rest. The dropped
 * devices will be re-created as fresh assets on the next discovery run.
 *   node --env-file=.env scripts/audit-multi-mac-assets.mjs --apply
 *
 * Heuristic: MAC entries on 2+ distinct subnetCidrs. A single endpoint's
 * wifi + ethernet MACs normally share one subnet; multi-subnet membership
 * is the tell for IP-recycle cross-stapling. (Device-field disagreement is
 * NOT used — a roaming endpoint legitimately reports different FortiGate
 * names across interfaces.)
 */

import { PrismaClient } from "@prisma/client";
import { Netmask } from "netmask";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

function containsIp(cidr, ip) {
  if (!cidr || !ip) return false;
  try { return new Netmask(cidr).contains(ip); } catch { return false; }
}

function distinctSubnets(macs) {
  return new Set(macs.map((m) => m.subnetCidr).filter(Boolean));
}

function fmtMac(m) {
  const parts = [m.mac];
  if (m.subnetCidr) parts.push(m.subnetCidr);
  if (m.device) parts.push(`dev=${m.device}`);
  if (m.source) parts.push(m.source);
  if (m.lastSeen) parts.push(new Date(m.lastSeen).toISOString().slice(0, 10));
  return parts.join("  ");
}

async function main() {
  const all = await prisma.asset.findMany({
    select: { id: true, hostname: true, ipAddress: true, macAddress: true, macAddresses: true },
  });

  const multi = all.filter((a) => Array.isArray(a.macAddresses) && a.macAddresses.length >= 2);
  const flagged = multi.filter((a) => distinctSubnets(a.macAddresses).size >= 2);

  console.log(`Scanned ${all.length} assets. ${multi.length} have 2+ MACs. ${flagged.length} span 2+ subnets (suspicious).\n`);

  const actions = [];
  for (const a of flagged) {
    const macs = a.macAddresses;
    const label = a.hostname || a.id;
    console.log(`— ${label}  (primary IP: ${a.ipAddress || "n/a"})`);
    for (const m of macs) console.log(`    ${fmtMac(m)}`);

    // Decide what apply would do
    let kept = a.ipAddress ? macs.filter((m) => containsIp(m.subnetCidr, a.ipAddress)) : [];
    if (kept.length === 0) {
      console.log(`    → no MAC's subnet contains the asset's primary IP; MANUAL REVIEW\n`);
      actions.push({ id: a.id, label, kind: "manual" });
      continue;
    }
    const dropped = macs.filter((m) => !kept.some((k) => k.mac === m.mac));
    if (dropped.length === 0) {
      console.log(`    → already consistent; no action\n`);
      continue;
    }
    const keptMacs = kept.map((m) => m.mac).join(", ");
    const droppedMacs = dropped.map((m) => m.mac).join(", ");
    console.log(`    → keep: ${keptMacs}`);
    console.log(`    → drop: ${droppedMacs}\n`);
    actions.push({ id: a.id, label, kept, dropped, kind: "prune" });
  }

  if (!APPLY) {
    const toPrune = actions.filter((x) => x.kind === "prune").length;
    const manual = actions.filter((x) => x.kind === "manual").length;
    console.log(`Dry-run. Would prune ${toPrune} asset(s); ${manual} need manual review.`);
    console.log(`Re-run with --apply to execute.`);
    return;
  }

  let pruned = 0;
  for (const act of actions) {
    if (act.kind !== "prune") continue;
    const newPrimary = act.kept[0].mac;
    await prisma.asset.update({
      where: { id: act.id },
      data: { macAddress: newPrimary, macAddresses: act.kept },
    });
    await prisma.event.create({
      data: {
        action: "asset.mac.pruned",
        resourceType: "asset",
        resourceId: act.id,
        resourceName: act.label,
        actor: "audit-multi-mac-assets",
        level: "warning",
        message: `Pruned ${act.dropped.length} cross-stapled MAC(s) from ${act.label}`,
        details: {
          kept: act.kept.map((m) => m.mac),
          dropped: act.dropped.map((m) => ({ mac: m.mac, subnetCidr: m.subnetCidr, device: m.device })),
        },
      },
    });
    pruned++;
  }
  console.log(`Applied. Pruned ${pruned} asset(s). Dropped MACs will reappear as fresh assets on the next discovery run.`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
