-- AlterTable: add per-stream credential FK columns to assets
ALTER TABLE "assets" ADD COLUMN "responseTimeCredentialId" TEXT;
ALTER TABLE "assets" ADD COLUMN "telemetryCredentialId" TEXT;
ALTER TABLE "assets" ADD COLUMN "interfacesCredentialId" TEXT;
ALTER TABLE "assets" ADD COLUMN "lldpCredentialId" TEXT;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_responseTimeCredentialId_fkey" FOREIGN KEY ("responseTimeCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_telemetryCredentialId_fkey" FOREIGN KEY ("telemetryCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_interfacesCredentialId_fkey" FOREIGN KEY ("interfacesCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_lldpCredentialId_fkey" FOREIGN KEY ("lldpCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
