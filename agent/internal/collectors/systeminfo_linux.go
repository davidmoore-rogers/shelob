//go:build linux

package collectors

import (
	"os"
	"strings"
)

// readPlatformDMI reads /sys/class/dmi/id/* — the kernel-exposed SMBIOS
// view. Standard on every modern Linux distro. File permissions are
// usually 0444 (world-readable) for sys_vendor / product_name /
// bios_version, but product_serial is often 0400 (root only) on
// hardened deployments — the agent's DynamicUser will see empty there,
// which is fine (projection just falls through to Intune/AD).
//
// Trims trailing newlines + whitespace. Returns empty strings for
// missing/unreadable files; never errors out (best-effort).
func readPlatformDMI() *platformDMI {
	get := func(name string) string {
		b, err := os.ReadFile("/sys/class/dmi/id/" + name)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(b))
	}
	return &platformDMI{
		Manufacturer: get("sys_vendor"),
		Model:        get("product_name"),
		Serial:       get("product_serial"),
		BiosVersion:  get("bios_version"),
	}
}
