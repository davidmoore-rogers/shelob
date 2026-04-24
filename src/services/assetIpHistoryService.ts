/**
 * src/services/assetIpHistoryService.ts — Asset IP address history
 *
 * History is auto-populated by the Prisma query extension in db.ts whenever
 * an asset's ipAddress field is written. This service handles reads, settings,
 * and pruning only.
 */

import { prisma } from "../db.js";

const SETTINGS_KEY = "assetIpHistorySettings";

export interface IpHistorySettings {
  retentionDays: number; // 0 = keep forever
}

const DEFAULTS: IpHistorySettings = { retentionDays: 0 };

export async function getHistorySettings(): Promise<IpHistorySettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return { ...DEFAULTS };
  const v = row.value as any;
  const d = Number(v?.retentionDays);
  return { retentionDays: Number.isFinite(d) && d >= 0 ? Math.floor(d) : DEFAULTS.retentionDays };
}

export async function updateHistorySettings(settings: IpHistorySettings): Promise<void> {
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: settings as any },
    create: { key: SETTINGS_KEY, value: settings as any },
  });
}

export async function getIpHistory(assetId: string) {
  const { retentionDays } = await getHistorySettings();
  const where: Record<string, unknown> = { assetId };
  if (retentionDays > 0) {
    where.lastSeen = { gte: new Date(Date.now() - retentionDays * 86_400_000) };
  }
  return prisma.assetIpHistory.findMany({ where, orderBy: { lastSeen: "desc" } });
}

export async function pruneOldHistory(): Promise<number> {
  const { retentionDays } = await getHistorySettings();
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const { count } = await prisma.assetIpHistory.deleteMany({ where: { lastSeen: { lt: cutoff } } });
  return count;
}
