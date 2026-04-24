/**
 * src/db.ts — Prisma client singleton
 *
 * Import `prisma` from this module instead of instantiating PrismaClient
 * directly, so the connection pool is shared across the process.
 *
 * The extended client wraps every asset.create and asset.update that sets
 * ipAddress and records the IP in asset_ip_history (upsert on assetId+ip).
 * The base client (_base) is reused for the history upsert to avoid a
 * circular import with assetIpHistoryService.
 */

import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { prisma: any; _prismaBase: PrismaClient };

function _buildClient(base: PrismaClient) {
  return base.$extends({
    query: {
      asset: {
        async create({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          const result = await query(args);
          const d = args.data as Record<string, unknown> | undefined;
          const ip = typeof d?.ipAddress === "string" ? d.ipAddress : undefined;
          if (ip) {
            const src = typeof d?.ipSource === "string" ? d.ipSource : "manual";
            const now = new Date();
            base.assetIpHistory
              .upsert({
                where: { assetId_ip: { assetId: (result as any).id, ip } },
                update: { lastSeen: now, source: src },
                create: { assetId: (result as any).id, ip, source: src, firstSeen: now, lastSeen: now },
              })
              .catch(() => {});
          }
          return result;
        },
        async update({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          const result = await query(args);
          const d = args.data as Record<string, unknown> | undefined;
          const ip = typeof d?.ipAddress === "string" ? d.ipAddress : undefined;
          if (ip) {
            const src = typeof d?.ipSource === "string" ? d.ipSource : "manual";
            const now = new Date();
            base.assetIpHistory
              .upsert({
                where: { assetId_ip: { assetId: (result as any).id, ip } },
                update: { lastSeen: now, source: src },
                create: { assetId: (result as any).id, ip, source: src, firstSeen: now, lastSeen: now },
              })
              .catch(() => {});
          }
          return result;
        },
      },
    },
  });
}

const _base: PrismaClient = g._prismaBase ?? new PrismaClient();
export const prisma: ReturnType<typeof _buildClient> = g.prisma ?? _buildClient(_base);

if (process.env.NODE_ENV !== "production") {
  g._prismaBase = _base;
  g.prisma = prisma;
}
