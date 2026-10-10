package config

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strings"
)

type ipResolver interface {
	LookupIPAddr(context.Context, string) ([]net.IPAddr, error)
}

// validateEndpointURL rejects plaintext HTTP to hosts that are not known to
// resolve exclusively to private or loopback addresses. DNS is checked at
// startup; callers and tests can provide a resolver to keep the policy
// deterministic and offline.
func validateEndpointURL(key, raw string, allowPublicHTTP bool, resolver ipResolver) error {
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("%s is not a valid URL: %w", key, err)
	}
	if !strings.EqualFold(u.Scheme, "http") {
		return nil
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("%s must include a host", key)
	}
	if allowPublicHTTP {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil {
		if privateOrLoopback(ip) {
			return nil
		}
		return insecureEndpointError(key, raw)
	}
	addrs, err := resolver.LookupIPAddr(context.Background(), host)
	if err != nil {
		return fmt.Errorf("%s uses HTTP and host %q could not be resolved to verify it is private; use HTTPS or set NOVAMEM_ALLOW_INSECURE_ENDPOINTS=1 to explicitly allow public HTTP: %w", key, host, err)
	}
	if len(addrs) == 0 {
		return fmt.Errorf("%s uses HTTP and host %q resolved to no addresses; use HTTPS or set NOVAMEM_ALLOW_INSECURE_ENDPOINTS=1 to explicitly allow public HTTP", key, host)
	}
	for _, addr := range addrs {
		if !privateOrLoopback(addr.IP) {
			return insecureEndpointError(key, raw)
		}
	}
	return nil
}

func privateOrLoopback(ip net.IP) bool {
	return ip != nil && (ip.IsPrivate() || ip.IsLoopback())
}

func insecureEndpointError(key, raw string) error {
	return fmt.Errorf("%s uses HTTP with a public host (%s); use HTTPS or set NOVAMEM_ALLOW_INSECURE_ENDPOINTS=1 to explicitly allow public HTTP", key, raw)
}
