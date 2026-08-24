package initcli

// Tiny persistent state for the init CLI.
//
// On a successful run, write the values the user picked so the next run
// can pre-fill them. Only stores non-sensitive choices: base URL and
// email. Bearer tokens are NEVER stored — they're auth material and the
// user might rotate them between runs.
//
// Location: $XDG_CONFIG_HOME/novamem/init.json (default
// ~/.config/novamem/init.json). Falls back to a silent no-op if the
// directory can't be created (e.g. read-only home).

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// InitState is the handful of non-sensitive choices carried between runs.
type InitState struct {
	// LastBaseURL is the last successful --base-url value. Pre-fills the
	// next interactive prompt unless the user passes a flag or has the
	// env var set.
	LastBaseURL string `json:"lastBaseUrl,omitempty"`
	// LastEmail is the last email used for --email / interactive sign-in.
	LastEmail string `json:"lastEmail,omitempty"`
}

// StatePath returns the state file location. An empty or unset
// XDG_CONFIG_HOME falls back to ~/.config.
func StatePath() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			home = ""
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "novamem", "init.json")
}

// LoadState reads state from disk. Returns the zero InitState if the file
// is missing, unreadable or invalid — never fails.
func LoadState() InitState {
	raw, err := os.ReadFile(StatePath())
	if err != nil {
		return InitState{}
	}
	// Decode into a loose map first so a JSON array, a scalar, or fields
	// of the wrong type degrade to "no state" instead of a hard error —
	// the TypeScript original type-checked each field individually.
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return InitState{}
	}
	out := InitState{}
	if s, ok := parsed["lastBaseUrl"].(string); ok {
		out.LastBaseURL = s
	}
	if s, ok := parsed["lastEmail"].(string); ok {
		out.LastEmail = s
	}
	return out
}

// SaveState writes state to disk. Best-effort: creates the directory if
// it doesn't exist, swallows errors (read-only home, permission denied,
// etc.).
func SaveState(s InitState) {
	path := StatePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		// Best-effort. State is a convenience, not a contract.
		return
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		// Best-effort. State is a convenience, not a contract.
		return
	}
	b = append(b, '\n')
	// 0600: the file lives in the user's config dir and, while it holds
	// no secrets by design, an email is still personal data.
	if err := os.WriteFile(path, b, 0o600); err != nil {
		// Best-effort. State is a convenience, not a contract.
		return
	}
}
