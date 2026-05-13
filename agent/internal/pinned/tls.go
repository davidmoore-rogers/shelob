// Package pinned implements a TLS verifier that pins Polaris's HTTPS leaf
// cert by SHA-256 fingerprint. The agent does NOT trust system root CAs —
// the fingerprint is baked into agent.conf at install time and is the only
// thing the agent will accept on the wire.
//
// This is a stronger guarantee than typical "TLS with public CA trust":
//
//   - A compromised public CA can't forge a cert the agent will trust.
//   - An attacker who somehow swaps Polaris's hostname (DNS hijack, proxy
//     interception) can't substitute a different leaf — the pin won't match.
//   - The only way to rotate the pin is for an operator to re-run install
//     against a re-keyed Polaris server, which writes a fresh agent.conf.
//
// Fingerprint format: "sha256:<lowercase-hex>" — same format the server
// emits from httpsManager.getServerCertFingerprint().
package pinned

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

const Prefix = "sha256:"

// VerifyPeerCertificate builds a custom callback that compares the
// presented leaf certificate's SHA-256 against `expected`. Plug into
// tls.Config.VerifyPeerCertificate.
//
// We also leave tls.Config.InsecureSkipVerify=true so the standard chain
// check (which is what consults system roots) is skipped — pin verification
// is the only check that fires.
func VerifyPeerCertificate(expected string) func([][]byte, [][]*x509.Certificate) error {
	expected = strings.ToLower(strings.TrimSpace(expected))
	return func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		if !strings.HasPrefix(expected, Prefix) {
			return fmt.Errorf("invalid pin format %q — must start with %q", expected, Prefix)
		}
		if len(rawCerts) == 0 {
			return errors.New("no peer certificate presented")
		}
		// Leaf cert is rawCerts[0] (the standard order on a TLS handshake).
		sum := sha256.Sum256(rawCerts[0])
		got := Prefix + hex.EncodeToString(sum[:])
		if got != expected {
			return fmt.Errorf("cert pin mismatch — expected %s, got %s", expected, got)
		}
		return nil
	}
}

// TLSConfig returns a *tls.Config wired to pin against `expectedFingerprint`.
// Caller injects this into http.Transport or websocket.Dialer.
func TLSConfig(expectedFingerprint string) *tls.Config {
	return &tls.Config{
		// We skip the standard chain check entirely; the pin is sufficient.
		// VerifyPeerCertificate still fires either way (Go's TLS stack always
		// calls it when set, regardless of InsecureSkipVerify).
		InsecureSkipVerify:    true, //nolint:gosec // pin verification replaces it
		VerifyPeerCertificate: VerifyPeerCertificate(expectedFingerprint),
		MinVersion:            tls.VersionTLS12,
	}
}
