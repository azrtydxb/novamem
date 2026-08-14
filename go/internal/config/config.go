// Package config loads the server configuration from the SAME environment
// variables the TypeScript server reads (frozen contract: same config
// surface). Only the variables the current slices consume are parsed;
// unknown NOVAMEM_* vars are ignored exactly like the TS loader ignores
// them.
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
}

func Load() (Config, error) {
	c := Config{
		Host:     getenv("NOVAMEM_HOST", "0.0.0.0"),
		Port:     7778,
		WarmURL:  os.Getenv("NOVAMEM_WARM_URL"),
		LogLevel: getenv("LOG_LEVEL", "info"),
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
	return c, nil
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
