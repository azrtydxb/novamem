package warmstore

import (
	"encoding/json"
	"os"
	"testing"
)

// Keeps ExpectedLatestMigration honest against the checked-in drizzle
// journal. Runs in-repo (CI checks out the whole monorepo); skips if the
// journal isn't reachable (e.g. the module vendored elsewhere).
func TestExpectedLatestMigrationMatchesJournal(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/server/src/warm-store/migrations/meta/_journal.json")
	if err != nil {
		// FAIL, not skip: this module lives in the monorepo and the guard
		// is the whole point of the test — a renamed journal path must
		// not silently disarm it.
		t.Fatalf("drizzle journal not readable (moved?): %v", err)
	}
	var j struct {
		Entries []struct {
			When int64 `json:"when"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(raw, &j); err != nil {
		t.Fatal(err)
	}
	if n := len(j.Entries); n == 0 {
		t.Fatal("journal has no entries")
	}
	last := j.Entries[len(j.Entries)-1].When
	if last != ExpectedLatestMigration {
		t.Fatalf("journal's last migration is %d but ExpectedLatestMigration is %d — bump the const in the same PR as the migration",
			last, ExpectedLatestMigration)
	}
}
