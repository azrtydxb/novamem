package initcli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStatePathUsesXDGConfigHome(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	if got, want := StatePath(), filepath.Join(dir, "novamem", "init.json"); got != want {
		t.Errorf("StatePath() = %q, want %q", got, want)
	}

	// Empty (not just unset) must also fall back to ~/.config.
	t.Setenv("XDG_CONFIG_HOME", "")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home directory")
	}
	if got, want := StatePath(), filepath.Join(home, ".config", "novamem", "init.json"); got != want {
		t.Errorf("StatePath() with empty XDG = %q, want %q", got, want)
	}
}

func TestStateRoundTripAndMode(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

	// Missing file → zero state.
	if got := LoadState(); got != (InitState{}) {
		t.Errorf("LoadState() with no file = %+v, want zero", got)
	}

	SaveState(InitState{LastBaseURL: "https://mem.example.com", LastEmail: "a@b.test"})
	got := LoadState()
	if got.LastBaseURL != "https://mem.example.com" || got.LastEmail != "a@b.test" {
		t.Errorf("round-trip = %+v", got)
	}

	info, err := os.Stat(StatePath())
	if err != nil {
		t.Fatalf("state file not written: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("state file mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestSaveStateNeverWritesTokens(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	SaveState(InitState{LastBaseURL: "https://mem.example.com", LastEmail: "a@b.test"})
	raw, err := os.ReadFile(StatePath())
	if err != nil {
		t.Fatal(err)
	}
	// The struct has no token field by design; assert the serialised
	// document stays exactly the two convenience keys.
	want := "{\n  \"lastBaseUrl\": \"https://mem.example.com\",\n  \"lastEmail\": \"a@b.test\"\n}\n"
	if string(raw) != want {
		t.Errorf("state file = %q, want %q", raw, want)
	}
}

func TestLoadStateToleratesGarbage(t *testing.T) {
	for _, body := range []string{"not json at all", "[1,2,3]", "\"scalar\"", "{\"lastBaseUrl\": 42}", ""} {
		dir := t.TempDir()
		t.Setenv("XDG_CONFIG_HOME", dir)
		path := StatePath()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if got := LoadState(); got != (InitState{}) {
			t.Errorf("LoadState() with %q = %+v, want zero state", body, got)
		}
	}
}

func TestSaveStateOnUnwritableDirIsSilent(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	parent := t.TempDir()
	if err := os.Chmod(parent, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(parent, 0o700) })
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(parent, "ro"))
	SaveState(InitState{LastEmail: "a@b.test"}) // must not panic
	if got := LoadState(); got != (InitState{}) {
		t.Errorf("LoadState() after a failed save = %+v, want zero state", got)
	}
}
