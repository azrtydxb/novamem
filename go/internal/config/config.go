// Package config loads the server configuration from the SAME environment
// variables the TypeScript server reads (frozen contract: same config
// surface — packages/server/src/config.ts). Only the variables the
// current slices consume are parsed; unknown NOVAMEM_* vars are ignored
// exactly like the TS loader ignores them.
package config

import (
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	Host     string // NOVAMEM_HOST, default 0.0.0.0
	Port     int    // NOVAMEM_PORT, default 7778
	WarmURL  string // NOVAMEM_WARM_URL (Postgres DSN) — required
	LogLevel string // LOG_LEVEL, default info

	// Auth. TS default is "user" (config.ts); the Go server serves only
	// none|bearer until slice 5, and Load refuses "user" loudly rather
	// than silently downgrading isolation.
	AuthMode  string // NOVAMEM_AUTH_MODE: none | bearer
	AuthToken string // NOVAMEM_AUTH_TOKEN — required when mode=bearer

	// Server-wide per-user write quotas; 0 = unlimited (quotas are
	// opt-in — config.ts quotas defaults).
	QuotaMaxEntries      int // NOVAMEM_QUOTA_MAX_ENTRIES
	QuotaWritesPerMinute int // NOVAMEM_QUOTA_WRITES_PER_MINUTE

	// Reject writes longer than this many characters (config.ts
	// search.maxContentChars, default 4000; 0 disables).
	MaxContentChars int // NOVAMEM_MAX_CONTENT_CHARS
}

func Load() (Config, error) {
	c := Config{
		Host:            getenv("NOVAMEM_HOST", "0.0.0.0"),
		Port:            7778,
		WarmURL:         os.Getenv("NOVAMEM_WARM_URL"),
		LogLevel:        getenv("LOG_LEVEL", "info"),
		AuthMode:        getenv("NOVAMEM_AUTH_MODE", "user"),
		AuthToken:       os.Getenv("NOVAMEM_AUTH_TOKEN"),
		MaxContentChars: 4000,
	}
	if p := os.Getenv("NOVAMEM_PORT"); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 {
			return c, fmt.Errorf("NOVAMEM_PORT %q is not a valid port", p)
		}
		c.Port = n
	}
	if c.WarmURL == "" {
		// Same fail-fast stance as the TS server: a server without its
		// warm store would 503 every request; refuse to start instead.
		return c, fmt.Errorf("NOVAMEM_WARM_URL is required")
	}
	switch c.AuthMode {
	case "none":
	case "bearer":
		if c.AuthToken == "" {
			// Exact fail-fast from http.ts buildHttpServer.
			return c, fmt.Errorf("auth.mode = 'bearer' requires auth.token to be set (NOVAMEM_AUTH_TOKEN)")
		}
	case "user":
		return c, fmt.Errorf("NOVAMEM_AUTH_MODE 'user' is not implemented in the Go server yet (slice 5) — set NOVAMEM_AUTH_MODE=none or bearer")
	default:
		return c, fmt.Errorf("NOVAMEM_AUTH_MODE %q is not one of none|bearer|user", c.AuthMode)
	}
	var err error
	if c.QuotaMaxEntries, err = intEnv("NOVAMEM_QUOTA_MAX_ENTRIES", 0); err != nil {
		return c, err
	}
	if c.QuotaWritesPerMinute, err = intEnv("NOVAMEM_QUOTA_WRITES_PER_MINUTE", 0); err != nil {
		return c, err
	}
	if c.MaxContentChars, err = intEnv("NOVAMEM_MAX_CONTENT_CHARS", 4000); err != nil {
		return c, err
	}
	return c, nil
}

func intEnv(key string, def int) (int, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return def, fmt.Errorf("%s %q is not a non-negative integer", key, raw)
	}
	return n, nil
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
