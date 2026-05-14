// storage.go — per-mountpoint disk usage.
//
// Cross-platform via gopsutil/disk. gopsutil already filters out the
// noise: pseudo-filesystems (proc, sysfs, devpts, tmpfs of size 0),
// container overlay layers, etc. Each Partition returns a real mount
// the operator cares about — '/' / '/var' on Linux, 'C:\' on Windows,
// '/' / '/Volumes/*' on macOS.
//
// We deliberately skip the network filesystems (NFS, SMB, AFP) by
// default — usage reads on them block when the server is unreachable
// and would stall the collector tick. Operators with NFS to monitor
// can lean on REST/SNMP per-stream resolution instead.
package collectors

import (
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/disk"

	"github.com/polaris/agent/internal/transport"
)

// StorageOnce enumerates all local mountpoints and emits one usage
// row per mount.
func StorageOnce() []*transport.StorageSample {
	ts := time.Now().UTC().Format(time.RFC3339Nano)

	// Partitions(false) returns "physical" devices only — skips
	// /proc, /sys, /dev, tmpfs zero-byte mounts, etc.
	parts, err := disk.Partitions(false)
	if err != nil {
		return nil
	}

	out := make([]*transport.StorageSample, 0, len(parts))
	for _, p := range parts {
		if isNetworkFs(p.Fstype) {
			continue
		}
		u, err := disk.Usage(p.Mountpoint)
		if err != nil {
			// Don't fail the whole pass on one stuck mount.
			continue
		}
		total := u.Total
		used := u.Used
		out = append(out, &transport.StorageSample{
			Timestamp:  ts,
			MountPath:  p.Mountpoint,
			TotalBytes: &total,
			UsedBytes:  &used,
		})
	}
	return out
}

func isNetworkFs(fstype string) bool {
	switch strings.ToLower(fstype) {
	case "nfs", "nfs4", "cifs", "smbfs", "smb3", "afp", "fuse.sshfs":
		return true
	}
	return false
}
