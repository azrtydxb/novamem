// Write-time LLM fact extraction + the dream-cycle's batch consolidation.
// Transcribed from packages/server/src/engine/fact-extractor.ts. The two
// system prompts and the user templates below are copied VERBATIM — they
// were tuned against the LongMemEval benchmark and are contract.
package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
)

// FactType — "preference" | "fact" | "event" | "task" | "knowledge".
type FactType = string

// ExtractedFact is one typed proposition distilled from a chunk.
type ExtractedFact struct {
	Type       FactType
	Subject    string
	Predicate  string
	Object     string
	OccurredAt *string
	Entities   []string
	Importance int // 1..5
}

// FactToText renders a fact as the one-line natural-language string that
// gets embedded and FTS-indexed (fact-extractor.ts factToText).
func FactToText(f ExtractedFact) string {
	timePart := ""
	// JS truthiness: an empty occurredAt renders no time suffix.
	if f.OccurredAt != nil && *f.OccurredAt != "" {
		timePart = " (" + *f.OccurredAt + ")"
	}
	return fmt.Sprintf("[%s] %s %s %s%s", f.Type, f.Subject, f.Predicate, f.Object, timePart)
}

// ClusterFact is one member of a consolidation cluster.
type ClusterFact struct {
	ID         string
	Text       string
	OccurredAt *string
}

// Supersession is one {superseded, by} verdict from consolidate().
type Supersession struct {
	SupersededID string
	ByID         string
}

const extractSystemPrompt = `You distill conversational text into typed memory facts. You output ONLY a JSON array.

Each fact MUST have these fields exactly:
  "type": one of "preference" | "fact" | "event" | "task" | "knowledge"
  "subject": who/what the fact is about ("the user", a named person, an entity)
  "predicate": short verb-phrase ("prefers", "located_in", "did", "owns", "wants", "ordered", "redeemed", "visited", "pickup_at", "return_at")
  "object": the value (free text, concise)
  "occurredAt": ISO-8601 timestamp if the fact has a clear time. If the chunk header carries a "Date:" line, use that date. Else omit.
  "entities": array of every proper noun, place name, brand, dollar amount, count, location, person referenced. Be exhaustive.
  "importance": 1..5 (5 = critical for recall)

Type meanings:
  preference: stable likes/dislikes/habits — every distinct preference gets its own fact
  fact:       static personal info (degree, name, address, ownership)
  event:      something that happened with a time
  task:       open todo / pending action — every distinct task gets its own fact
  knowledge:  user's situation/status that may change (location, job, plans)

CRITICAL — ENUMERATION:
- Each distinct item, action, person, place, or preference is its OWN fact, not a summary.
- If the user mentions "3 items at the store: blazer, boots, dress", emit THREE separate facts, one per item.
- If the user lists preferences ("I like X, also Y, and Z"), emit ONE fact per preference.
- If the user mentions counts or amounts ("$5 coupon", "2 weeks", "3 items"), include them in entities AND in the object text.
- Prefer many small facts over one summary fact. Aim for 3-6 facts when the chunk has multiple items.

Rules:
- Only emit facts clearly supported by the text. If unsure, skip.
- Skip "the user is asking" / pleasantries / assistant suggestions.
- Always include the chunk's Date in occurredAt when the fact is event/task/knowledge.
- Output an empty array [] if no facts can be extracted.`

func extractUserPrompt(content string, max int) string {
	return fmt.Sprintf("Extract up to %d typed facts from this conversation chunk. "+
		"Enumerate every distinct item, action, or preference as its own fact:\n\n"+
		"```\n%s\n```\n\n"+
		"Output ONLY a JSON array of fact objects. No prose, no explanation, no markdown.", max, content)
}

const consolidateSystemPrompt = `You maintain a fact store. You are given numbered GROUPS of similar stored facts. For each group decide whether any fact is an OUTDATED VERSION of another fact in the same group.

A fact supersedes another ONLY when both describe the same subject and the same attribute, and one is clearly the newer or corrected value (changed number, date, location, status, preference). Facts about different people, different attributes, or merely related topics MUST coexist — when unsure, do nothing.

Output ONLY a JSON array of objects {"group": n, "superseded": "<id>", "by": "<id>"}. Empty array if nothing is superseded. No prose.`

func consolidateUserPrompt(clusters [][]ClusterFact) string {
	groups := make([]string, 0, len(clusters))
	for i, c := range clusters {
		lines := make([]string, 0, len(c)+1)
		lines = append(lines, fmt.Sprintf("GROUP %d:", i+1))
		for _, f := range c {
			occurred := "?"
			if f.OccurredAt != nil {
				occurred = *f.OccurredAt
			}
			lines = append(lines, fmt.Sprintf("  id=%s occurred_at=%s :: %s", f.ID, occurred, utf16Slice(f.Text, 400)))
		}
		groups = append(groups, strings.Join(lines, "\n"))
	}
	return strings.Join(groups, "\n\n")
}

// FactExtractorConfig — fact-extractor.ts FactExtractorConfig.
type FactExtractorConfig struct {
	Config
	MaxFactsPerChunk int
	// MaxConcurrent bounds in-flight extract()/consolidate() calls. Pick a
	// value slightly below upstream's effective concurrency divided by
	// replica count; without it, fire-and-forget extractions stack faster
	// than the upstream LLM drains and most silently time out.
	MaxConcurrent int
}

type FactExtractor struct {
	client
	cfg FactExtractorConfig
	sem semaphore
}

func NewFactExtractor(cfg FactExtractorConfig) *FactExtractor {
	return &FactExtractor{
		client: newClient(cfg.Config),
		cfg:    cfg,
		sem:    newSemaphore(cfg.MaxConcurrent),
	}
}

// MaxFactsPerChunk exposes the cap so the engine can apply the same slice
// TS applies at the call site (engine.storeFactsForChunk).
func (x *FactExtractor) MaxFactsPerChunk() int { return x.cfg.MaxFactsPerChunk }

// Extract distills one chunk into typed facts. An empty result means "no
// facts in this chunk" (a COMPLETED extraction); an error means the call
// itself was unusable and the caller keeps the debt marker.
func (x *FactExtractor) Extract(ctx context.Context, content string) ([]ExtractedFact, error) {
	if strings.TrimSpace(content) == "" {
		return nil, nil
	}
	x.sem.acquire()
	defer x.sem.release()
	text, err := x.complete(ctx, "fact extraction", []Message{
		{Role: "system", Content: extractSystemPrompt},
		{Role: "user", Content: extractUserPrompt(content, x.cfg.MaxFactsPerChunk)},
	}, 1024)
	if errors.Is(err, errNotOK) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return parseFacts(text, x.cfg.MaxFactsPerChunk), nil
}

// Consolidate judges a batch of similar-fact clusters in ONE LLM call and
// returns the supersession pairs. Deliberately batch-shaped and run only
// from the dream cycle, never from the write path.
func (x *FactExtractor) Consolidate(ctx context.Context, clusters [][]ClusterFact) ([]Supersession, error) {
	if len(clusters) == 0 {
		return nil, nil
	}
	x.sem.acquire()
	defer x.sem.release()
	// Output is a JSON array of {superseded, by} id pairs — small, but it
	// scales with the number of clusters judged.
	maxTokens := len(clusters) * 96
	if maxTokens < 256 {
		maxTokens = 256
	}
	text, err := x.complete(ctx, "consolidate", []Message{
		{Role: "system", Content: consolidateSystemPrompt},
		{Role: "user", Content: consolidateUserPrompt(clusters)},
	}, maxTokens)
	if errors.Is(err, errNotOK) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return parseConsolidations(text, clusters), nil
}

var factTypes = map[string]bool{
	"preference": true, "fact": true, "event": true, "task": true, "knowledge": true,
}

func parseFacts(raw string, max int) []ExtractedFact {
	match := firstJSONArray(stripJSONFences(raw))
	if match == "" {
		return nil
	}
	var arr []any
	if err := json.Unmarshal([]byte(match), &arr); err != nil {
		return nil
	}
	var out []ExtractedFact
	for _, item := range arr {
		o, ok := item.(map[string]any)
		if !ok {
			continue
		}
		str := func(key string) string {
			s, _ := o[key].(string)
			return strings.TrimSpace(s)
		}
		typ := ""
		if s, ok := o["type"].(string); ok {
			typ = strings.TrimSpace(strings.ToLower(s))
		}
		if !factTypes[typ] {
			continue
		}
		subject, predicate, object := str("subject"), str("predicate"), str("object")
		if subject == "" || predicate == "" || object == "" {
			continue
		}
		entities := []string{}
		if list, ok := o["entities"].([]any); ok {
			for _, x := range list {
				if s, ok := x.(string); ok {
					if v := strings.TrimSpace(s); v != "" {
						entities = append(entities, v)
					}
				}
			}
		}
		importance := 3
		if n, ok := o["importance"].(float64); ok {
			importance = int(math.Max(1, math.Min(5, math.Round(n))))
		}
		var occurredAt *string
		if s, ok := o["occurredAt"].(string); ok {
			v := strings.TrimSpace(s)
			occurredAt = &v
		}
		out = append(out, ExtractedFact{
			Type: typ, Subject: subject, Predicate: predicate, Object: object,
			OccurredAt: occurredAt, Entities: entities, Importance: importance,
		})
		if len(out) >= max {
			break
		}
	}
	return out
}

// parseConsolidations keeps only pairs whose ids BOTH belong to the same
// input cluster — the model inventing ids or crossing groups must not
// mark unrelated facts inactive.
func parseConsolidations(raw string, clusters [][]ClusterFact) []Supersession {
	match := firstJSONArray(stripJSONFences(raw))
	if match == "" {
		return nil
	}
	var arr []any
	if err := json.Unmarshal([]byte(match), &arr); err != nil {
		return nil
	}
	var out []Supersession
	for _, item := range arr {
		o, ok := item.(map[string]any)
		if !ok {
			continue
		}
		sup, _ := o["superseded"].(string)
		by, _ := o["by"].(string)
		if sup == "" || by == "" || sup == by {
			continue
		}
		inSameCluster := false
		for _, c := range clusters {
			hasSup, hasBy := false, false
			for _, f := range c {
				if f.ID == sup {
					hasSup = true
				}
				if f.ID == by {
					hasBy = true
				}
			}
			if hasSup && hasBy {
				inSameCluster = true
				break
			}
		}
		if inSameCluster {
			out = append(out, Supersession{SupersededID: sup, ByID: by})
		}
	}
	return out
}
