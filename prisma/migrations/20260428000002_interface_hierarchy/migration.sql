-- Add interface topology fields to asset_interface_samples.
-- ifType: "physical" | "aggregate" | "vlan" | "loopback" | "tunnel" (FortiOS REST + SNMP ifType OID)
-- ifParent: aggregate name for member ports; parent interface name for VLAN sub-interfaces (FortiOS REST only)
-- vlanId: 802.1Q VLAN ID (FortiOS REST only)
ALTER TABLE "asset_interface_samples"
  ADD COLUMN "ifType"   TEXT,
  ADD COLUMN "ifParent" TEXT,
  ADD COLUMN "vlanId"   INTEGER;
