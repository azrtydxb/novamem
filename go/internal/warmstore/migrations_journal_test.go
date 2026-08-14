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

// The hashes every live database already recorded in
// drizzle.__drizzle_migrations. Editing a migration file changes its
// hash, and a database that applied the old text would never apply the
// new one — the schema would silently diverge from the SQL in the tree.
// Pinning them here means such an edit fails the build instead.
//
// These are the values read off the novamem-bench database during the
// Go cutover, which drizzle-kit wrote. A NEW migration appends a line;
// an existing line changing is a bug unless every deployment is being
// rebuilt from scratch.
var pinnedMigrationHashes = map[string]string{
	"0000_wonderful_boom_boom.sql":         "6aca695823196d477737d779da13645357e0447a4865b3d7245549938b8841b0",
	"0001_lucky_talkback.sql":              "c090a3f99a86a228590e2b8797cc68922b501575a9538577e911addb52932646",
	"0002_tidy_omega_sentinel.sql":         "bf61edda4bd106f203c0431d186e400c2e385a328a800666dfdbe2874f9270fa",
	"0003_harsh_oracle.sql":                "923ec66f5738a5c575b846e77bb78702d400e0a22c1c068ce499d0e05e48893a",
	"0004_mysterious_stepford_cuckoos.sql": "ce890c8326ce9256c2206c998aa4224a09bc4162358e97d811df13cf496ad4cd",
	"0005_red_dark_phoenix.sql":            "074e44ce58e126a6ccdfdf86676abf79bd6ff6f03e9ad5574fb5209e09e7503d",
	"0006_amusing_kulan_gath.sql":          "68e51a7b73b819721abf31ad4464010a7aee078d06e8b7e2d9b67e2066855a61",
	"0007_equal_next_avengers.sql":         "688fdefa3bcf14d15cdffd2844d16f9dc763f8fa97a1f028dabc4bfe74290bab",
	"0008_minor_hammerhead.sql":            "69f8fc9ebc17e0f6cbf3b3e1edfbc1d37a73cb92bf62d51f66eae893bde18651",
}

func TestMigrationHashesArePinned(t *testing.T) {
	ms, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, m := range ms {
		file := m.Tag + ".sql"
		seen[file] = true
		want, pinned := pinnedMigrationHashes[file]
		if !pinned {
			t.Errorf("%s is embedded but not pinned — add its hash to pinnedMigrationHashes", file)
			continue
		}
		if m.Hash != want {
			t.Errorf("%s hash changed:\n  have %s\n  want %s\n"+
				"Editing an applied migration desynchronises every existing database. "+
				"Write a new migration instead.", file, m.Hash, want)
		}
	}
	for file := range pinnedMigrationHashes {
		if !seen[file] {
			t.Errorf("%s is pinned but no longer embedded — a migration was deleted", file)
		}
	}
}
