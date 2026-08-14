// Observer / Reflector — the observation-log pipeline behind /v1/observe
// and /v1/context-prefix. Transcribed from
// packages/server/src/engine/observer.ts; both system prompts are copied
// VERBATIM.
//
// The persisted blob lives in the engine (it needs the warm store): this
// type is the LLM half only — one "observe" pass that turns recent chunks
// into dated bullets, and one "reflect" pass that collapses the log.
package llm

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

const observeSystemPrompt = `You convert a batch of recent conversational chunks into concise dated bullets for a long-term memory log.

Output format (strict):
- One bullet per fact
- Start each bullet with a priority emoji: 🔴 critical | 🟡 useful | 🟢 minor
- Then the date in YYYY-MM-DD format in brackets
- Then a short factual statement (<140 chars)
- No headings, no prose, no markdown other than the bullets

Examples:
🔴 [2026-05-21] User graduated with a Business Administration degree
🟡 [2026-05-30] User asked about Seattle travel tips; flight to SF delayed
🟢 [2026-06-01] User mentioned packing snacks for flights

Output ONLY the bullets, one per line. No preamble.`

const reflectSystemPrompt = `You restructure a growing observational log into a cleaner version.

Rules:
- Combine bullets about the same fact across dates into one (keep the latest date)
- Demote priority if a fact is older than 6 months and unused
- Drop bullets superseded by newer ones (e.g. "moved to Chicago" then "moved to suburbs" → keep suburbs only)
- Preserve all distinct facts
- Output format identical to input: priority emoji, date, short statement

Output ONLY the reorganised bullets. No preamble.`

// ObserverConfig — observer.ts ObserverConfig.
type ObserverConfig struct {
	Config
	// ObserveThreshold / ReflectThreshold are carried for config parity
	// with the TS server, which likewise reads them into the module and
	// gates on the engine's own bullet count.
	ObserveThreshold int
	ReflectThreshold int
}

type Observer struct {
	client
	cfg ObserverConfig
}

func NewObserver(cfg ObserverConfig) *Observer {
	return &Observer{client: newClient(cfg.Config), cfg: cfg}
}

// llm — observer.ts Observer.llm: a non-OK status yields "", an unusable
// body is an error (callers treat "" as "nothing to observe", so the two
// must stay distinguishable).
func (o *Observer) llm(ctx context.Context, system, user string, maxTokens int) (string, error) {
	text, err := o.complete(ctx, "observer", []Message{
		{Role: "system", Content: system},
		{Role: "user", Content: user},
	}, maxTokens)
	if errors.Is(err, errNotOK) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return stripMarkdownFences(text), nil
}

// Observe converts the last N raw memories into dated bullets.
func (o *Observer) Observe(ctx context.Context, recentChunks []string) (string, error) {
	if len(recentChunks) == 0 {
		return "", nil
	}
	parts := make([]string, len(recentChunks))
	for i, c := range recentChunks {
		parts[i] = fmt.Sprintf("[chunk %d]\n%s", i+1, c)
	}
	return o.llm(ctx, observeSystemPrompt, strings.Join(parts, "\n\n"), 1024)
}

// Reflect collapses + supersedes across an existing observation log.
func (o *Observer) Reflect(ctx context.Context, currentLog string) (string, error) {
	if strings.TrimSpace(currentLog) == "" {
		return currentLog, nil
	}
	return o.llm(ctx, reflectSystemPrompt, currentLog, 2048)
}
