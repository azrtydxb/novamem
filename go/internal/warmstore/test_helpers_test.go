package warmstore

import (
	"os"
	"testing"
)

func testDatabaseURL(t *testing.T) string {
	t.Helper()
	url := os.Getenv("NOVAMEM_TEST_DATABASE_URL")
	if url != "" {
		return url
	}
	if os.Getenv("CI") == "1" {
		t.Fatal("NOVAMEM_TEST_DATABASE_URL is unset in CI; DB-backed tests must run against Postgres")
	}
	t.Skip("set NOVAMEM_TEST_DATABASE_URL to a throwaway database to run")
	return ""
}
