-- Per-stream MIB ID columns on assets (String, no FK -- stores "std:<key>" or uploaded MIB UUID)
ALTER TABLE "assets" ADD COLUMN "responseTimeMibId" TEXT;
ALTER TABLE "assets" ADD COLUMN "telemetryMibId" TEXT;
ALTER TABLE "assets" ADD COLUMN "interfacesMibId" TEXT;
ALTER TABLE "assets" ADD COLUMN "lldpMibId" TEXT;

-- Per-stream credential and MIB columns on monitor_class_overrides
ALTER TABLE "monitor_class_overrides" ADD COLUMN "responseTimeCredentialId" TEXT;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "telemetryCredentialId" TEXT;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "interfacesCredentialId" TEXT;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "lldpCredentialId" TEXT;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "responseTimeMibId" TEXT;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "telemetryMibId" TEXT;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "interfacesMibId" TEXT;
ALTER TABLE "monitor_class_overrides" ADD COLUMN "lldpMibId" TEXT;

-- AddForeignKey constraints for class override credentials
ALTER TABLE "monitor_class_overrides" ADD CONSTRAINT "monitor_class_overrides_responseTimeCredentialId_fkey" FOREIGN KEY ("responseTimeCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "monitor_class_overrides" ADD CONSTRAINT "monitor_class_overrides_telemetryCredentialId_fkey" FOREIGN KEY ("telemetryCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "monitor_class_overrides" ADD CONSTRAINT "monitor_class_overrides_interfacesCredentialId_fkey" FOREIGN KEY ("interfacesCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "monitor_class_overrides" ADD CONSTRAINT "monitor_class_overrides_lldpCredentialId_fkey" FOREIGN KEY ("lldpCredentialId") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
