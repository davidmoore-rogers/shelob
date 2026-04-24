-- AlterTable: add ipSource to track where ipAddress was last set from
ALTER TABLE "assets" ADD COLUMN "ipSource" TEXT;
