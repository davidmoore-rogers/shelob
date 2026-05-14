//go:build !linux && !darwin && !windows

package collectors

// readPlatformDMI fallback for any OS the agent isn't formally built
// for. Returns empty so the projection falls through to other sources.
// The release matrix is linux + darwin + windows × amd64/arm64 only;
// this file exists so a future operator cross-compiling for a fourth
// OS (freebsd, openbsd) gets a clean compile, not a missing-symbol
// error.
func readPlatformDMI() *platformDMI {
	return &platformDMI{}
}
