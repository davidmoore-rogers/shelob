// Polaris Agent — pushes monitoring samples to Polaris over HTTPS with a
// pinned-leaf TLS handshake. Generic binary across deployments; per-install
// identity (server URL, cert pin, bearer) lives entirely in agent.conf.
//
// Lifecycle:
//
//  1. Load agent.conf. If no bearer is present, run /enroll using the
//     one-shot enrollment_token. On success, persist the bearer to
//     agent.conf and remove the enrollment_token.
//  2. Start the collect loop (response-time samples on a fixed interval).
//  3. Start the heartbeat loop (less frequent).
//  4. Run until SIGTERM. Graceful shutdown flushes the last in-flight
//     sample push, if any.
//
// Phase 3 ships steps 1+2+3 with one collector (response-time). Phases
// 4+5 add the SSH/WinRM install path (server side) and the rest of the
// collectors + the WebSocket pull side. Each phase is independently
// deployable; nothing in this binary's surface changes for the operator.
package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/polaris/agent/internal/collectors"
	"github.com/polaris/agent/internal/config"
	"github.com/polaris/agent/internal/transport"
)

const (
	defaultResponseTimeIntervalSec = 60
	defaultHeartbeatIntervalSec    = 300
)

func main() {
	confPath := flag.String("conf", config.DefaultPath(), "path to agent.conf")
	flag.Parse()

	cfg, err := config.Load(*confPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	if err := cfg.Validate(); err != nil {
		log.Fatalf("invalid config: %v", err)
	}

	client := transport.NewClient(cfg.ServerURL, cfg.CertFingerprint, cfg.BearerToken)

	// Step 1: enroll if we don't have a bearer yet.
	if cfg.BearerToken == "" {
		if err := enroll(cfg, client); err != nil {
			log.Fatalf("enrollment failed: %v", err)
		}
	}

	ctx, cancel := signalContext()
	defer cancel()

	// Step 2 + 3: collect loop + heartbeat loop. Each runs on its own
	// timer so a slow sample-push doesn't starve heartbeats.
	go responseTimeLoop(ctx, cfg, client)
	go heartbeatLoop(ctx, cfg, client)

	<-ctx.Done()
	log.Println("Polaris Agent: shutting down")
}

// enroll posts the one-shot token to /api/v1/agents/enroll, persists the
// returned bearer, and updates the in-memory client. Mutates cfg in place.
func enroll(cfg *config.Config, client *transport.Client) error {
	if cfg.EnrollmentToken == "" {
		return errAndExit("no enrollment_token in agent.conf — has /enroll already succeeded?")
	}
	hostname, _ := os.Hostname()
	resp, err := client.Enroll(&transport.EnrollRequest{
		EnrollmentToken:           cfg.EnrollmentToken,
		Hostname:                  hostname,
		ServerCertFingerprintSeen: cfg.CertFingerprint,
	})
	if err != nil {
		return err
	}
	log.Printf("enrolled — assetId=%s", resp.AssetID)

	cfg.BearerToken = resp.Bearer
	cfg.EnrollmentToken = "" // one-shot is now consumed
	cfg.AgentID = resp.AssetID
	if err := cfg.Save(); err != nil {
		return errAndExit("enrollment succeeded but persisting agent.conf failed: " + err.Error())
	}
	client.SetBearer(resp.Bearer)
	return nil
}

func responseTimeLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	interval := time.Duration(cfg.ResponseTimeIntervalSec) * time.Second
	if interval == 0 {
		interval = defaultResponseTimeIntervalSec * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()

	// Fire once immediately so the operator sees a sample within seconds
	// of starting the agent rather than waiting one full interval.
	pushOne(client)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pushOne(client)
		}
	}
}

func pushOne(client *transport.Client) {
	sample := collectors.ResponseTimeOnce()
	_, err := client.PushSamples(&transport.SamplesBody{
		Stream:  "responseTime",
		Samples: []*transport.ResponseTimeSample{sample},
	})
	if err != nil {
		// Best-effort logging — repeated failures should be visible in
		// the host's journal but mustn't crash the agent (transient 5xx
		// is normal during Polaris restart).
		log.Printf("push responseTime sample: %v", err)
	}
}

func heartbeatLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	interval := time.Duration(cfg.HeartbeatIntervalSec) * time.Second
	if interval == 0 {
		interval = defaultHeartbeatIntervalSec * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()

	_, _ = client.Heartbeat() // immediate one so the UI sees us live on startup
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if _, err := client.Heartbeat(); err != nil {
				log.Printf("heartbeat: %v", err)
			}
		}
	}
}

func signalContext() (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	sigc := make(chan os.Signal, 1)
	signal.Notify(sigc, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigc
		cancel()
	}()
	return ctx, cancel
}

func errAndExit(msg string) error {
	log.Fatal(msg)
	return nil // unreached
}
