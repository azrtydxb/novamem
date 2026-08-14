package config

import "testing"

// config.ts defaults NOVAMEM_COLD_PROVIDER to "qdrant"; an unset value
// must not silently mean "no cold tier".
func TestColdProviderDefaultsToQdrant(t *testing.T) {
	t.Setenv("NOVAMEM_WARM_URL", "postgres://u:p@127.0.0.1:5432/db")
	t.Setenv("NOVAMEM_AUTH_MODE", "none")
	t.Setenv("NOVAMEM_HOST", "127.0.0.1")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.ColdProvider != "qdrant" {
		t.Fatalf("ColdProvider = %q, want qdrant (config.ts default)", c.ColdProvider)
	}
	if c.ColdURL != "http://localhost:6333" {
		t.Fatalf("ColdURL = %q, want the local Qdrant default", c.ColdURL)
	}
}
