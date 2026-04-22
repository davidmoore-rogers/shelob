-- AlterTable: add associatedIps JSON column to assets
ALTER TABLE "assets" ADD COLUMN "associatedIps" JSONB NOT NULL DEFAULT '[]';
