// Package transport carries the four HTTP endpoints the agent talks to:
//
//	POST /api/v1/agents/enroll     — public; one-shot enrollment token → bearer
//	POST /api/v1/agents/samples    — bearer; bulk-write samples per stream
//	POST /api/v1/agents/heartbeat  — bearer; bump lastSeenAt + refresh version
//	GET  /api/v1/agents/config     — bearer; resolved cadences + ETag short-circuit
//
// One *http.Client with a pinned TLS transport is reused across all calls.
// The bearer is stamped into the Authorization header for everything except
// /enroll (which uses the body's enrollmentToken field instead).
package transport

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/polaris/agent/internal/pinned"
)

// Client wraps the Polaris HTTP surface. Construct one via NewClient and
// reuse it for the life of the agent process.
type Client struct {
	baseURL string
	bearer  string
	httpc   *http.Client

	// AgentVersion is reported on /enroll and /heartbeat so the server
	// can render "v0.1.0" badges on the asset details page.
	AgentVersion string
}

// NewClient builds a Client that pins TLS to certFingerprint. The bearer
// can be empty at construction time — callers Enroll() first, then set
// the returned bearer via SetBearer().
func NewClient(baseURL, certFingerprint, bearer string) *Client {
	tr := &http.Transport{
		TLSClientConfig:       pinned.TLSConfig(certFingerprint),
		ResponseHeaderTimeout: 15 * time.Second,
		IdleConnTimeout:       90 * time.Second,
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		bearer:  bearer,
		// AgentVersion is filled in by main.go from the ldflag-stamped
		// `version` constant before any call that emits it (/enroll,
		// /heartbeat). The fallback string here is what shows up if
		// main.go forgets to set it — defensive only.
		AgentVersion: "0.0.0-unstamped",
		httpc:        &http.Client{Transport: tr, Timeout: 30 * time.Second},
	}
}

// SetBearer swaps the token the client uses for Authorization headers.
// Called once after /enroll returns the long-lived bearer.
func (c *Client) SetBearer(b string) { c.bearer = b }

// ─── Enroll ───────────────────────────────────────────────────────────

type EnrollRequest struct {
	EnrollmentToken           string `json:"enrollmentToken"`
	OsPlatform                string `json:"osPlatform"`
	Arch                      string `json:"arch"`
	AgentVersion              string `json:"agentVersion"`
	Hostname                  string `json:"hostname,omitempty"`
	ServerCertFingerprintSeen string `json:"serverCertFingerprintSeen"`
}

type EnrollResponse struct {
	Bearer     string `json:"bearer"`
	AssetID    string `json:"assetId"`
	ConfigETag string `json:"configEtag"`
}

// Enroll posts the one-shot enrollment token + the cert pin we observed
// during the TLS handshake. Server cross-checks against the pin baked
// into our ManagedAgent row at install time, atomically mints a
// long-lived bearer, and returns it. Caller MUST persist the bearer to
// agent.conf before any other call — losing it requires a Reinstall.
func (c *Client) Enroll(req *EnrollRequest) (*EnrollResponse, error) {
	req.AgentVersion = c.AgentVersion
	if req.OsPlatform == "" {
		req.OsPlatform = runtime.GOOS // "linux" | "darwin" | "windows"
	}
	if req.Arch == "" {
		req.Arch = runtime.GOARCH // "amd64" | "arm64"
	}
	var out EnrollResponse
	if err := c.do("POST", "/api/v1/agents/enroll", req, &out, false); err != nil {
		return nil, fmt.Errorf("enroll: %w", err)
	}
	return &out, nil
}

// ─── Samples ──────────────────────────────────────────────────────────

// ResponseTimeSample matches the server's ResponseTimeSampleSchema.
type ResponseTimeSample struct {
	Timestamp      string  `json:"timestamp,omitempty"` // RFC3339; server fills now() if empty
	Success        bool    `json:"success"`
	ResponseTimeMs *int    `json:"responseTimeMs,omitempty"` // pointer so we can send explicit null on failure
	Error          *string `json:"error,omitempty"`
}

type SamplesBody struct {
	Stream  string      `json:"stream"` // "responseTime" | "telemetry" | "interfaces" | "storage"
	Samples interface{} `json:"samples"`
}

type SamplesResponse struct {
	Accepted int `json:"accepted"`
	Rejected int `json:"rejected"`
}

// PushSamples POSTs one stream's worth of samples. The bearer-bound
// assetId is stamped server-side; we never send our own assetId on the
// wire. Returns the {accepted, rejected} counts the server reports.
func (c *Client) PushSamples(body *SamplesBody) (*SamplesResponse, error) {
	if c.bearer == "" {
		return nil, errors.New("PushSamples called without a bearer token — enroll first")
	}
	var out SamplesResponse
	if err := c.do("POST", "/api/v1/agents/samples", body, &out, true); err != nil {
		return nil, fmt.Errorf("samples: %w", err)
	}
	return &out, nil
}

// ─── Heartbeat ────────────────────────────────────────────────────────

type HeartbeatResponse struct {
	OK         bool   `json:"ok"`
	ConfigETag string `json:"configEtag"`
}

// Heartbeat is the fallback the agent uses to bump lastSeenAt + refresh
// agentVersion when there's no live WebSocket. The returned ConfigETag
// lets the agent know whether it needs to refresh /config — when it
// matches the agent's cached etag we can skip the round-trip.
func (c *Client) Heartbeat() (*HeartbeatResponse, error) {
	if c.bearer == "" {
		return nil, errors.New("Heartbeat called without a bearer token — enroll first")
	}
	body := map[string]string{"agentVersion": c.AgentVersion}
	var out HeartbeatResponse
	if err := c.do("POST", "/api/v1/agents/heartbeat", body, &out, true); err != nil {
		return nil, fmt.Errorf("heartbeat: %w", err)
	}
	return &out, nil
}

// ─── Config ───────────────────────────────────────────────────────────

type StreamConfig struct {
	Enabled     bool `json:"enabled"`
	IntervalSec int  `json:"intervalSec"`
	TimeoutMs   int  `json:"timeoutMs"`
}

type ConfigResponse struct {
	ETag    string                  `json:"etag"`
	Streams map[string]StreamConfig `json:"streams"`
	Monitored bool                  `json:"monitored"`
}

// FetchConfig pulls the resolved cadences + which streams are agent-mode.
// `ifNoneMatch` is the agent's cached etag — pass it through to short-
// circuit when nothing changed (server returns 304 → this function
// returns a nil *ConfigResponse and a nil error).
func (c *Client) FetchConfig(ifNoneMatch string) (*ConfigResponse, error) {
	if c.bearer == "" {
		return nil, errors.New("FetchConfig called without a bearer token — enroll first")
	}
	req, err := http.NewRequest("GET", c.baseURL+"/api/v1/agents/config", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.bearer)
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch)
	}
	resp, err := c.httpc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified {
		return nil, nil // unchanged — caller keeps cached config
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("config: status %d", resp.StatusCode)
	}
	var out ConfigResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("config: decode: %w", err)
	}
	return &out, nil
}

// ─── Internal HTTP helper ─────────────────────────────────────────────

func (c *Client) do(method, path string, body, out interface{}, withBearer bool) error {
	var rdr io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal: %w", err)
		}
		rdr = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, c.baseURL+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if withBearer {
		if c.bearer == "" {
			return errors.New("bearer required but unset")
		}
		req.Header.Set("Authorization", "Bearer "+c.bearer)
	}
	resp, err := c.httpc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		buf, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(buf)))
	}
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return fmt.Errorf("decode: %w", err)
		}
	}
	return nil
}
