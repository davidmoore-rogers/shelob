// Package collectors holds the per-stream sample producers. Phase 3 ships
// the response-time collector end-to-end; telemetry / interfaces / storage
// land in Phase 5 (each has platform-specific code paths — PDH counters on
// Windows, /proc on Linux, sysctl/IOKit on macOS — and that's where the
// agent's footprint grows).
//
// The response-time stream is intentionally the simplest: "did the agent
// run during the last interval, and how long did the loopback round-trip
// take?" The reading isn't a network probe — it's a process-local
// liveness signal that the agent is actually running its main loop. When
// the agent has gone away (host rebooted, service crashed, network ATE
// the host), no samples land; the server's last-seen-N-samples sliding
// window flips to "down" via the same five-state machine the periodic
// puller uses, and the operator sees red on the Device Map / asset list.
package collectors

import (
	"time"

	"github.com/polaris/agent/internal/transport"
)

// ResponseTimeOnce runs one observation. Returns a server-shaped sample
// payload ready to push. Adds a small synthetic RTT (the time the agent
// took to wake up and run this observation) so the chart isn't a flat line.
func ResponseTimeOnce() *transport.ResponseTimeSample {
	start := time.Now()

	// In Phase 3 the "probe" is a noop — we're not really measuring
	// anything except that the agent is alive. Phase 5 layers an actual
	// localhost reachability check on top (e.g. dial 127.0.0.1:<a default
	// service port>) so the response-time line in the UI reflects real
	// system load rather than a flat 0 ms.
	elapsedMs := int(time.Since(start).Milliseconds())

	return &transport.ResponseTimeSample{
		Timestamp:      time.Now().UTC().Format(time.RFC3339Nano),
		Success:        true,
		ResponseTimeMs: &elapsedMs,
	}
}
