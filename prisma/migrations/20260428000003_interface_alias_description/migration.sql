-- Add operator-set alias and description (comment) fields to interface samples.
-- alias: FortiOS CMDB `alias`, SNMP IF-MIB ifAlias (1.3.6.1.2.1.31.1.1.1.18). Override label.
-- description: FortiOS CMDB `description` (operator comment); SNMP has no equivalent comment field.
ALTER TABLE "asset_interface_samples"
  ADD COLUMN "alias"       TEXT,
  ADD COLUMN "description" TEXT;
