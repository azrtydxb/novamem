// Hybrid retrieval scoring. Transcribed from
// packages/server/src/engine/hybrid-search.ts (read-only reference,
// never imported): fuse, DEFAULT_WEIGHTS, DEFAULT_MIN_VECTOR_SCORE,
// recencyScore, extractQueryEntities, entityMatchScore, rankPrior,
// effectiveDays.
package engine

import (
	"math"
	"regexp"
	"sort"
	"strings"
)

type HybridWeights struct {
	Keyword float64
	Vector  float64
	Graph   float64
	Recency float64
	Entity  float64
}

// DefaultWeights — recalibrated against bge-m3 on a LongMemEval slice
// (hybrid-search.ts DEFAULT_WEIGHTS).
var DefaultWeights = HybridWeights{Keyword: 0.15, Vector: 0.65, Graph: 0.05, Recency: 0.10, Entity: 0.05}

// DefaultMinVectorScore — absolute cosine below which a vector-only
// candidate is noise. Calibrated for MiniLM-class models; inert on
// bge-m3 (every candidate clears it). Override per call or via
// NOVAMEM_SEARCH_MIN_VECTOR_SCORE.
const DefaultMinVectorScore = 0.25

// HybridSignal — per-tier contributions; nil = tier did not propose
// this candidate (distinct from a 0 score).
type HybridSignal struct {
	Keyword *float64
	Vector  *float64
	Graph   *float64
	Recency *float64
	Entity  *float64
}

type HybridInput struct {
	ID      string
	Signals HybridSignal
}

type SignalSet struct {
	Keyword float64 `json:"keyword"`
	Vector  float64 `json:"vector"`
	Graph   float64 `json:"graph"`
	Recency float64 `json:"recency"`
	Entity  float64 `json:"entity"`
}

type HybridOutput struct {
	ID      string
	Score   float64
	Signals SignalSet
}

func clampUnit(n float64) float64 {
	// hybrid-search.ts clamp01 — no rounding (unlike capturemeta's
	// toFixed(3) clamp01).
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return 0
	}
	if n < 0 {
		return 0
	}
	if n > 1 {
		return 1
	}
	return n
}

// Fuse combines per-id signal contributions into a single fused score.
// Scale handling is asymmetric on purpose (see hybrid-search.ts):
// vector/graph/recency are absolute and used raw (clamped to [0,1]);
// keyword (ts_rank) and entity (hit count) have no absolute scale and
// are max-normalised within the query. Weights are renormalised across
// the tiers that actually produced candidates. minVectorScore < 0 means
// "use the default"; 0 disables the noise floor.
func Fuse(inputs []HybridInput, weights HybridWeights, minVectorScore float64) []HybridOutput {
	if minVectorScore < 0 {
		minVectorScore = DefaultMinVectorScore
	}

	var maxKeyword, maxEntity float64
	var presentKeyword, presentVector, presentGraph, presentRecency, presentEntity bool
	for _, i := range inputs {
		if i.Signals.Keyword != nil {
			presentKeyword = true
			if *i.Signals.Keyword > maxKeyword {
				maxKeyword = *i.Signals.Keyword
			}
		}
		if i.Signals.Vector != nil {
			presentVector = true
		}
		if i.Signals.Graph != nil {
			presentGraph = true
		}
		if i.Signals.Recency != nil {
			presentRecency = true
		}
		if i.Signals.Entity != nil {
			presentEntity = true
			if *i.Signals.Entity > maxEntity {
				maxEntity = *i.Signals.Entity
			}
		}
	}

	// Redistribute the weight of tiers that produced no candidates so the
	// fused score stays on a stable [0,1] scale.
	activeTotal := 0.0
	if presentKeyword {
		activeTotal += weights.Keyword
	}
	if presentVector {
		activeTotal += weights.Vector
	}
	if presentGraph {
		activeTotal += weights.Graph
	}
	if presentRecency {
		activeTotal += weights.Recency
	}
	if presentEntity {
		activeTotal += weights.Entity
	}
	var w HybridWeights
	if activeTotal > 0 {
		if presentKeyword {
			w.Keyword = weights.Keyword / activeTotal
		}
		if presentVector {
			w.Vector = weights.Vector / activeTotal
		}
		if presentGraph {
			w.Graph = weights.Graph / activeTotal
		}
		if presentRecency {
			w.Recency = weights.Recency / activeTotal
		}
		if presentEntity {
			w.Entity = weights.Entity / activeTotal
		}
	}

	type slot struct {
		SignalSet
		hasKeyword bool
		hasGraph   bool
		order      int // first-seen order for deterministic output
	}
	grouped := map[string]*slot{}
	orderCounter := 0
	for _, i := range inputs {
		cur := grouped[i.ID]
		if cur == nil {
			cur = &slot{order: orderCounter}
			orderCounter++
			grouped[i.ID] = cur
		}
		if i.Signals.Keyword != nil {
			cur.hasKeyword = true
			normalized := 0.0
			if maxKeyword > 0 {
				normalized = clampUnit(*i.Signals.Keyword / maxKeyword)
			}
			cur.Keyword = math.Max(cur.Keyword, normalized)
		}
		if i.Signals.Vector != nil {
			cur.Vector = math.Max(cur.Vector, clampUnit(*i.Signals.Vector))
		}
		if i.Signals.Graph != nil {
			cur.hasGraph = true
			cur.Graph = math.Max(cur.Graph, clampUnit(*i.Signals.Graph))
		}
		if i.Signals.Recency != nil {
			cur.Recency = math.Max(cur.Recency, clampUnit(*i.Signals.Recency))
		}
		if i.Signals.Entity != nil {
			normalized := 0.0
			if maxEntity > 0 {
				normalized = clampUnit(*i.Signals.Entity / maxEntity)
			}
			cur.Entity = math.Max(cur.Entity, normalized)
		}
	}

	out := make([]HybridOutput, 0, len(grouped))
	for id, s := range grouped {
		// Noise floor: only-the-vector-tier candidates below the floor are
		// the nearest of an unrelated set, not a hit. recency is computed
		// for every candidate so it is not corroboration; entity is.
		if !s.hasKeyword && !s.hasGraph && s.Entity <= 0 && s.Vector < minVectorScore {
			continue
		}
		score := s.Keyword*w.Keyword + s.Vector*w.Vector + s.Graph*w.Graph +
			s.Recency*w.Recency + s.Entity*w.Entity
		out = append(out, HybridOutput{ID: id, Score: score, Signals: s.SignalSet})
	}
	// Stable sort keyed by first-seen order to make ties deterministic
	// (a Go map's iteration order is random; JS Map preserves insertion).
	sort.SliceStable(out, func(a, b int) bool {
		if out[a].Score != out[b].Score {
			return out[a].Score > out[b].Score
		}
		return grouped[out[a].ID].order < grouped[out[b].ID].order
	})
	return out
}

// RecencyScore — exp(-ageDays / halfLifeDays) in [0,1]; missing/invalid
// timestamps score 0 (arbitrarily old).
func RecencyScore(ageDays float64, halfLifeDays float64) float64 {
	if ageDays < 0 {
		ageDays = 0
	}
	return math.Exp(-ageDays / halfLifeDays)
}

var (
	doubleQuotedRe = regexp.MustCompile(`"([^"]+)"`)
	singleQuotedRe = regexp.MustCompile(`'([^']+)'`)
	nonEntityRe    = regexp.MustCompile(`[^A-Za-z0-9-]`)
	cappedRe       = regexp.MustCompile(`^[A-Z][a-z0-9-]+$`)
	longNumberRe   = regexp.MustCompile(`\b\d{3,}\b`)
	moneyRe        = regexp.MustCompile(`\$\d+`)
	wsRe           = regexp.MustCompile(`\s+`)
)

// ExtractQueryEntities — proper-noun-like tokens from a free-text query
// for entity scoring: quoted strings, multi-word Title Case past
// sentence position 0, standalone numbers ≥3 digits, and $-amounts.
// Lowercased, insertion-ordered, min length 2 (hybrid-search.ts
// extractQueryEntities).
func ExtractQueryEntities(query string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(s string) {
		if len(s) < 2 || seen[s] {
			return
		}
		seen[s] = true
		out = append(out, s)
	}
	for _, m := range doubleQuotedRe.FindAllStringSubmatch(query, -1) {
		add(strings.ToLower(strings.TrimSpace(m[1])))
	}
	for _, m := range singleQuotedRe.FindAllStringSubmatch(query, -1) {
		add(strings.ToLower(strings.TrimSpace(m[1])))
	}
	tokens := wsRe.Split(query, -1)
	var buf []string
	flush := func() {
		if len(buf) >= 1 {
			add(strings.ToLower(strings.Join(buf, " ")))
		}
		buf = nil
	}
	for i, tok := range tokens {
		t := nonEntityRe.ReplaceAllString(tok, "")
		isCapped := cappedRe.MatchString(t)
		if isCapped && i != 0 {
			buf = append(buf, t)
		} else {
			flush()
		}
	}
	flush()
	for _, m := range longNumberRe.FindAllString(query, -1) {
		add(m)
	}
	for _, m := range moneyRe.FindAllString(query, -1) {
		add(m)
	}
	// The TS Set preserves insertion order; the final filter(len>=2) is
	// applied in add() above.
	return out
}

// EntityMatchScore — count of distinct query entities present in the
// content, case-insensitive. Fuse max-normalises it.
func EntityMatchScore(content string, entities []string) float64 {
	if len(entities) == 0 || content == "" {
		return 0
	}
	c := strings.ToLower(content)
	hits := 0.0
	for _, e := range entities {
		if strings.Contains(c, e) {
			hits++
		}
	}
	return hits
}

var recencySensitiveTypes = map[string]bool{"deployment_state": true, "setup_fact": true}

// RankPrior — multiplicative rank-time prior over the fused score:
// confidenceFactor in [0.7,1] plus a gentle freshness boost for
// "current state" memory types. Bounded to [0.7, 1.15]
// (hybrid-search.ts rankPrior).
func RankPrior(confidence *float64, memoryType string, ageDays *float64) float64 {
	c := 1.0
	if confidence != nil && !math.IsNaN(*confidence) && !math.IsInf(*confidence, 0) {
		c = clampUnit(*confidence)
	}
	confidenceFactor := 0.7 + 0.3*c
	recencyFactor := 1.0
	if recencySensitiveTypes[memoryType] && ageDays != nil && !math.IsNaN(*ageDays) && !math.IsInf(*ageDays, 0) {
		a := math.Max(0, *ageDays)
		recencyFactor = 1 + 0.15*math.Exp(-a/30)
	}
	return confidenceFactor * recencyFactor
}

// EffectiveDays — synaptic-decay lifespan: 7 × log₂(hits+1). Must stay
// in lockstep with the SQL twin in the decay pass (slice 6).
func EffectiveDays(hits int) float64 {
	return 7 * math.Log2(float64(hits)+1)
}

// EstimateTokens — cheap ~4 chars/token estimate for the search token
// budget (engine/index.ts estimateTokens; JS content.length is UTF-16).
func EstimateTokens(content string) int {
	return (utf16Len(content) + 3) / 4
}
