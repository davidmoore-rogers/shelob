// Package config reads the agent's runtime configuration from a single
// INI-style file: /var/lib/polaris-agent/agent.conf on Linux (writable
// via systemd's StateDirectory= so the agent can persist its bearer
// after /enroll — /etc/ is read-only under ProtectSystem=strict),
// /etc/polaris-agent/agent.conf on macOS,
// %ProgramData%\Polaris\agent\agent.conf on Windows.
//
// The file is generated server-side by agentInstallService at install time
// and is unique per install — the binary itself is generic across all
// Polaris deployments; per-install identity lives entirely here.
//
// Wire shape (intentionally tiny — no nested sections, no quoting rules):
//
//	server_url       = https://polaris.example.com:3000
//	cert_fingerprint = sha256:ab12cd34...
//	bearer_token     = polaris_xK9rT2pQwL3mNs7v...
//	agent_id         = 7f2e9a1c-... (optional, used in WS subprotocol)
//	enrollment_token = polaris_... (present until first /enroll succeeds; then removed by the agent)
//
// `bearer_token` is the long-lived bearer issued by /enroll. On a fresh
// install only `enrollment_token` is present; on first run the agent posts
// it to /api/v1/agents/enroll, receives a bearer, and rewrites the file
// with bearer_token populated and enrollment_token removed. From that
// point on the agent only needs server_url + cert_fingerprint + bearer_token.
package config

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Config carries the values loaded from agent.conf. Mutated in-place when
// the agent enrolls (bearer fills in; enrollment empties); persisted via
// Save() to the same path the file was loaded from.
type Config struct {
	path string // absolute path; not stored in the file itself

	ServerURL       string
	CertFingerprint string // "sha256:<lowercase-hex>"
	AgentID         string
	BearerToken     string
	EnrollmentToken string

	// Optional knobs — leave empty for defaults.
	ResponseTimeIntervalSec int
	HeartbeatIntervalSec    int
}

// DefaultPath returns the canonical agent.conf path for the running OS.
// Operators with non-standard layouts override via the POLARIS_AGENT_CONF env.
func DefaultPath() string {
	if v := os.Getenv("POLARIS_AGENT_CONF"); v != "" {
		return v
	}
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("ProgramData")
		if base == "" {
			base = `C:\ProgramData`
		}
		return filepath.Join(base, "Polaris", "agent", "agent.conf")
	case "linux":
		// /var/lib/ rather than /etc/ — systemd's StateDirectory exposes
		// this path to the DynamicUser as writable; /etc/ is read-only
		// under ProtectSystem=strict so cfg.Save() after /enroll would
		// fail there and the agent would loop on the consumed token.
		return "/var/lib/polaris-agent/agent.conf"
	default: // darwin, others — launchd plist doesn't use ProtectSystem
		return "/etc/polaris-agent/agent.conf"
	}
}

// Load reads + parses the file at path. Missing keys are returned as empty
// strings; Validate() decides what's required for a given lifecycle stage.
func Load(path string) (*Config, error) {
	f, err := os.Open(path) //nolint:gosec // operator-controlled file path
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	cfg := &Config{path: path}
	sc := bufio.NewScanner(f)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			return nil, fmt.Errorf("%s:%d: missing '='", path, lineNo)
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		switch key {
		case "server_url":
			cfg.ServerURL = val
		case "cert_fingerprint":
			cfg.CertFingerprint = strings.ToLower(val)
		case "agent_id":
			cfg.AgentID = val
		case "bearer_token":
			cfg.BearerToken = val
		case "enrollment_token":
			cfg.EnrollmentToken = val
		case "response_time_interval_sec":
			fmt.Sscanf(val, "%d", &cfg.ResponseTimeIntervalSec)
		case "heartbeat_interval_sec":
			fmt.Sscanf(val, "%d", &cfg.HeartbeatIntervalSec)
		default:
			// Unknown key — ignored to stay forward-compatible with newer
			// installer scripts writing keys this agent version doesn't read.
		}
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return cfg, nil
}

// Save rewrites the config file with the current in-memory values.
// Atomic via write-to-tempfile + rename so a crash mid-write doesn't
// leave the agent with a corrupt config.
func (c *Config) Save() error {
	dir := filepath.Dir(c.path)
	tmp, err := os.CreateTemp(dir, "agent.conf.*.tmp")
	if err != nil {
		return fmt.Errorf("create tempfile: %w", err)
	}
	defer os.Remove(tmp.Name()) // no-op on success after rename

	w := bufio.NewWriter(tmp)
	fmt.Fprintln(w, "# Polaris Agent configuration. Managed by agentInstallService at install")
	fmt.Fprintln(w, "# time and rewritten by the agent on enrollment. Do not edit by hand.")
	fmt.Fprintf(w, "server_url       = %s\n", c.ServerURL)
	fmt.Fprintf(w, "cert_fingerprint = %s\n", c.CertFingerprint)
	if c.AgentID != "" {
		fmt.Fprintf(w, "agent_id         = %s\n", c.AgentID)
	}
	if c.BearerToken != "" {
		fmt.Fprintf(w, "bearer_token     = %s\n", c.BearerToken)
	}
	if c.EnrollmentToken != "" {
		fmt.Fprintf(w, "enrollment_token = %s\n", c.EnrollmentToken)
	}
	if c.ResponseTimeIntervalSec > 0 {
		fmt.Fprintf(w, "response_time_interval_sec = %d\n", c.ResponseTimeIntervalSec)
	}
	if c.HeartbeatIntervalSec > 0 {
		fmt.Fprintf(w, "heartbeat_interval_sec     = %d\n", c.HeartbeatIntervalSec)
	}
	if err := w.Flush(); err != nil {
		return fmt.Errorf("flush: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close tempfile: %w", err)
	}
	// 0600 — config holds the bearer; only the agent's service user reads it.
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("chmod tempfile: %w", err)
	}
	if err := os.Rename(tmp.Name(), c.path); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

// Validate checks the minimal set of fields the agent needs for one of two
// lifecycle stages:
//
//	pre-enroll:  ServerURL + CertFingerprint + EnrollmentToken
//	post-enroll: ServerURL + CertFingerprint + BearerToken
//
// At least one of EnrollmentToken / BearerToken must be present.
func (c *Config) Validate() error {
	var missing []string
	if c.ServerURL == "" {
		missing = append(missing, "server_url")
	}
	if c.CertFingerprint == "" {
		missing = append(missing, "cert_fingerprint")
	}
	if c.BearerToken == "" && c.EnrollmentToken == "" {
		missing = append(missing, "bearer_token or enrollment_token")
	}
	if len(missing) > 0 {
		return fmt.Errorf("agent.conf missing required key(s): %s", strings.Join(missing, ", "))
	}
	if !strings.HasPrefix(c.CertFingerprint, "sha256:") {
		return errors.New("cert_fingerprint must start with sha256:")
	}
	return nil
}

// Path returns the file path the config was loaded from. Useful for Save().
func (c *Config) Path() string { return c.path }
