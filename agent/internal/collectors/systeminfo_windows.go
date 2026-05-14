//go:build windows

package collectors

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

// readPlatformDMI reads SMBIOS-derived values from the BIOS registry
// key that Windows populates at boot. Two relevant keys:
//
//   HKLM\HARDWARE\DESCRIPTION\System\BIOS  →  SystemManufacturer,
//                                             SystemProductName,
//                                             BIOSVersion, BIOSReleaseDate.
//   HKLM\HARDWARE\DESCRIPTION\System       →  SystemBiosVersion (older fmt)
//
// SerialNumber lives in HKLM\SYSTEM\HardwareConfig\Current\SerialNumber
// in modern Windows but it's not always populated. The reliable cross-
// version source is WMI's Win32_BIOS.SerialNumber, but pulling in WMI
// in pure Go is heavy. We try the registry path first; empty serial
// falls through to Intune/AD in the projection, which is acceptable.
//
// Read-only access — registry.QUERY_VALUE is the minimum permission.
// HARDWARE keys are world-readable on all supported Windows versions
// so the agent's service user can open them without elevation.
func readPlatformDMI() *platformDMI {
	d := &platformDMI{}

	if k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`HARDWARE\DESCRIPTION\System\BIOS`, registry.QUERY_VALUE); err == nil {
		defer k.Close()
		d.Manufacturer = stringFromReg(k, "SystemManufacturer")
		d.Model = stringFromReg(k, "SystemProductName")
		d.BiosVersion = stringFromReg(k, "BIOSVersion")
		// Some OEMs put the chassis serial here under a non-standard name.
		if s := stringFromReg(k, "SystemSKU"); s != "" && d.Serial == "" {
			d.Serial = s
		}
	}

	// Modern Windows stamps the SMBIOS serial here. Best-effort.
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SYSTEM\HardwareConfig\Current`, registry.QUERY_VALUE); err == nil {
		defer k.Close()
		if s := stringFromReg(k, "SystemSerialNumber"); s != "" {
			d.Serial = s
		}
	}

	return d
}

func stringFromReg(k registry.Key, name string) string {
	s, _, err := k.GetStringValue(name)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(s)
}
