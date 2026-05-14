// telemetry.go — CPU% + memory bytes per sample.
//
// Cross-platform via gopsutil: works the same on Linux (/proc/stat +
// /proc/meminfo), macOS (host_statistics + sysctl), and Windows
// (GetSystemTimes + GlobalMemoryStatusEx). Each call captures one
// instantaneous reading; the server stores them in a time-series and
// the System tab renders the chart.
//
// CPU% is the cross-core average over a ~1s sampling interval —
// gopsutil.cpu.Percent(interval, false) returns one float64 per call.
// Anything finer (per-core, kernel/user split) would inflate the
// payload without much operator value at this stage.
//
// Temperatures: gopsutil.host.SensorsTemperatures works on Linux
// (thermal_zone* + hwmon), macOS (smc, when accessible), and is a
// no-op on Windows (returns ErrNotImplementedError) — we treat the
// no-op the same as "no sensors available" and emit no temperature
// rows in that case.
package collectors

import (
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"

	"github.com/polaris/agent/internal/transport"
)

// TelemetryOnce takes one CPU+memory snapshot plus available
// temperatures and shapes it for the server. Returns a single sample
// row; the caller wraps it in a SamplesBody and pushes.
func TelemetryOnce() *transport.TelemetrySample {
	sample := &transport.TelemetrySample{
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
	}

	// CPU% — 1-second sampling window for a meaningful number. Two
	// consecutive Percent(0, ...) calls would give 0 most of the time
	// (no time elapsed between samples). gopsutil's Percent(interval,
	// false) blocks `interval` and returns the delta over that span.
	if pct, err := cpu.Percent(1*time.Second, false); err == nil && len(pct) > 0 {
		v := pct[0]
		sample.CPUPct = &v
	}

	// Memory bytes. We send both pct AND used/total — the server
	// schema accepts either form, and the System tab chart prefers
	// pct when both are present.
	if vm, err := mem.VirtualMemory(); err == nil {
		p := vm.UsedPercent
		sample.MemPct = &p
		used := vm.Used
		total := vm.Total
		sample.MemUsedBytes = &used
		sample.MemTotalBytes = &total
	}

	// Temperatures. Best-effort — many hosts don't expose sensors
	// (cloud VMs, containers, hardened bare-metal). Errors and
	// empty arrays both land as "no temperatures" silently.
	if temps, err := host.SensorsTemperatures(); err == nil {
		for _, t := range temps {
			if t.SensorKey == "" || t.Temperature == 0 {
				continue
			}
			c := t.Temperature
			sample.Temperatures = append(sample.Temperatures, transport.TelemetryTemperature{
				SensorName: t.SensorKey,
				Celsius:    &c,
			})
		}
	}

	return sample
}
