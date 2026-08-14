package warmstore

import (
	"os"
	"path/filepath"
	"testing"
)

// This server owns the migration set now, but packages/server still
// ships its own copy until it is deleted. Any divergence would mean the
// two servers migrate the same database differently, so fail on it.
// Skips once packages/server is gone.
func TestEmbeddedMigrationsMatchTSCopy(t *testing.T) {
	tsDir := "../../../packages/server/src/warm-store/migrations"
	if _, err := os.Stat(tsDir); err != nil {
		t.Skipf("TS migration folder gone (expected after packages/server is deleted): %v", err)
	}
	files, err := filepath.Glob(filepath.Join(tsDir, "*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	ours, err := migrationFS.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	// -1 for the meta/ directory entry.
	if got, want := len(ours)-1, len(files); got != want {
		t.Errorf("embedded set has %d .sql files, TS copy has %d", got, want)
	}
	for _, f := range append(files, filepath.Join(tsDir, "meta", "_journal.json")) {
		want, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		rel, err := filepath.Rel(tsDir, f)
		if err != nil {
			t.Fatal(err)
		}
		got, err := migrationFS.ReadFile("migrations/" + filepath.ToSlash(rel))
		if err != nil {
			t.Errorf("%s: not embedded: %v", rel, err)
			continue
		}
		if string(got) != string(want) {
			t.Errorf("%s differs from the TS copy", rel)
		}
	}
}

// The journal must parse and be strictly ordered — the runner's
// "apply everything newer than max(created_at)" rule silently skips a
// migration whose `when` is out of order.
func TestMigrationJournalOrdered(t *testing.T) {
	ms, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) == 0 {
		t.Fatal("no migrations embedded")
	}
	for i := 1; i < len(ms); i++ {
		if ms[i].When <= ms[i-1].When {
			t.Errorf("migration %s (when=%d) is not newer than %s (when=%d)",
				ms[i].Tag, ms[i].When, ms[i-1].Tag, ms[i-1].When)
		}
	}
	for _, m := range ms {
		if len(m.Hash) != 64 {
			t.Errorf("%s: hash %q is not a sha256 hex digest", m.Tag, m.Hash)
		}
		if len(m.Statements) == 0 {
			t.Errorf("%s: no statements", m.Tag)
		}
	}
}
