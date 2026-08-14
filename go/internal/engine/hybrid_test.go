package engine

import (
	"math"
	"testing"
)

func fp(f float64) *float64 { return &f }

func approx(t *testing.T, got, want float64, msg string) {
	t.Helper()
	if math.Abs(got-want) > 1e-12 {
		t.Fatalf("%s: got %v, want %v", msg, got, want)
	}
}

// Hand-computed against hybrid-search.ts fuse() with DEFAULT_WEIGHTS
// {keyword:.15, vector:.65, graph:.05, recency:.10, entity:.05}.
//
// Case: keyword+vector tiers present → activeTotal = .15+.65 = .80,
// renormalised w.keyword = .1875, w.vector = .8125. maxKeyword = 2 so
// a's keyword normalises to 1.0 and b's to 0.5.
//
//	a {keyword: 2}            → 1.0·.1875               = 0.1875
//	b {keyword: 1, vector:.8} → 0.5·.1875 + 0.8·.8125  = 0.74375
//	c {vector: .1}            → vector-only below the .25 floor → dropped
func TestFuseKeywordVectorRenormalisation(t *testing.T) {
	out := Fuse([]HybridInput{
		{ID: "a", Signals: HybridSignal{Keyword: fp(2)}},
		{ID: "b", Signals: HybridSignal{Keyword: fp(1), Vector: fp(0.8)}},
		{ID: "c", Signals: HybridSignal{Vector: fp(0.1)}},
	}, DefaultWeights, -1)
	if len(out) != 2 {
		t.Fatalf("want 2 results (c dropped by noise floor), got %d", len(out))
	}
	if out[0].ID != "b" || out[1].ID != "a" {
		t.Fatalf("order: got %s,%s want b,a", out[0].ID, out[1].ID)
	}
	approx(t, out[0].Score, 0.74375, "b score")
	approx(t, out[1].Score, 0.1875, "a score")
	approx(t, out[0].Signals.Keyword, 0.5, "b keyword signal")
	approx(t, out[0].Signals.Vector, 0.8, "b vector signal")
}

// Vector-only: activeTotal = .65 → w.vector = 1, cosines pass through
// raw. 0.24999 sits below the floor with no corroboration → dropped.
func TestFuseVectorOnlyRawCosine(t *testing.T) {
	out := Fuse([]HybridInput{
		{ID: "a", Signals: HybridSignal{Vector: fp(0.9)}},
		{ID: "b", Signals: HybridSignal{Vector: fp(0.3)}},
		{ID: "c", Signals: HybridSignal{Vector: fp(0.24999)}},
	}, DefaultWeights, -1)
	if len(out) != 2 {
		t.Fatalf("want 2 results, got %d", len(out))
	}
	approx(t, out[0].Score, 0.9, "a score")
	approx(t, out[1].Score, 0.3, "b score")
}

// Vector+recency: activeTotal = .65+.10 = .75.
//
//	a {vector: .5, recency: 1.0} → .5·(.65/.75) + 1·(.10/.75)
//	                             = 0.43333333333333335 + 0.13333333333333333
//	                             = 0.5666666666666667
func TestFuseRecencyRenormalisation(t *testing.T) {
	out := Fuse([]HybridInput{
		{ID: "a", Signals: HybridSignal{Vector: fp(0.5), Recency: fp(1.0)}},
	}, DefaultWeights, -1)
	if len(out) != 1 {
		t.Fatalf("want 1 result, got %d", len(out))
	}
	approx(t, out[0].Score, 0.5666666666666667, "a score")
}

// Entity corroboration rescues a low-cosine candidate from the noise
// floor (recency does not — it is computed for every candidate).
// activeTotal = .65+.05 = .70; maxEntity = 2 normalises d's entity to 1.
//
//	d {vector:.1, entity:2} → .1·(.65/.7) + 1·(.05/.7) = 0.16428571428571428
//	e {vector:.9}           → .9·(.65/.7)              = 0.8357142857142857
func TestFuseEntityRescuesNoiseFloor(t *testing.T) {
	out := Fuse([]HybridInput{
		{ID: "d", Signals: HybridSignal{Vector: fp(0.1), Entity: fp(2)}},
		{ID: "e", Signals: HybridSignal{Vector: fp(0.9)}},
	}, DefaultWeights, -1)
	if len(out) != 2 {
		t.Fatalf("want 2 results, got %d", len(out))
	}
	approx(t, out[0].Score, 0.8357142857142857, "e score")
	approx(t, out[1].Score, 0.16428571428571428, "d score")
}

// minVectorScore 0 disables the floor entirely (SearchBody.minVectorScore).
func TestFuseFloorDisabled(t *testing.T) {
	out := Fuse([]HybridInput{
		{ID: "c", Signals: HybridSignal{Vector: fp(0.01)}},
	}, DefaultWeights, 0)
	if len(out) != 1 {
		t.Fatalf("floor disabled: want 1 result, got %d", len(out))
	}
}

// Duplicate ids merge with per-signal MAX before weighting.
func TestFuseDuplicateIDsMax(t *testing.T) {
	out := Fuse([]HybridInput{
		{ID: "a", Signals: HybridSignal{Vector: fp(0.4)}},
		{ID: "a", Signals: HybridSignal{Vector: fp(0.7)}},
	}, DefaultWeights, -1)
	if len(out) != 1 {
		t.Fatalf("want 1 merged result, got %d", len(out))
	}
	approx(t, out[0].Score, 0.7, "merged vector max")
}

func TestRecencyScore(t *testing.T) {
	approx(t, RecencyScore(0, 180), 1, "age 0")
	approx(t, RecencyScore(180, 180), math.Exp(-1), "age 180")
	approx(t, RecencyScore(-5, 180), 1, "negative age clamps to 0")
}

func TestExtractQueryEntities(t *testing.T) {
	got := ExtractQueryEntities(`Where does Pascal keep the "espresso machine" manual from 2023`)
	want := []string{"espresso machine", "pascal", "2023"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}

	// Multi-word Title Case buffers join; the sentence-initial capital is
	// skipped (position 0 is just capitalisation).
	got = ExtractQueryEntities("Tell me about Nova Memory Service today")
	if len(got) != 1 || got[0] != "nova memory service" {
		t.Fatalf("multi-word: got %v", got)
	}

	// Mixed-caps words like NovaMem do NOT match the ^[A-Z][a-z0-9-]+$
	// shape (interior capital) — same as the TS regex.
	got = ExtractQueryEntities("what does NovaMem store")
	if len(got) != 0 {
		t.Fatalf("mixed caps: got %v, want none", got)
	}
}

func TestEntityMatchScore(t *testing.T) {
	entities := []string{"pascal", "espresso machine", "2023"}
	approx(t, EntityMatchScore("Pascal prefers espresso", entities), 1, "one hit")
	approx(t, EntityMatchScore("In 2023 Pascal bought an espresso machine", entities), 3, "three hits")
	approx(t, EntityMatchScore("", entities), 0, "empty content")
}

func TestRankPrior(t *testing.T) {
	one, half, zero := 1.0, 0.5, 0.0
	approx(t, RankPrior(&one, "general", &zero), 1.0, "confidence 1, non-recency type")
	approx(t, RankPrior(&half, "general", &zero), 0.85, "confidence 0.5")
	approx(t, RankPrior(&one, "deployment_state", &zero), 1.15, "fresh deployment_state")
	// nil confidence defaults to 1 (TS: non-number → 1).
	approx(t, RankPrior(nil, "general", nil), 1.0, "nil confidence")
}

func TestEffectiveDays(t *testing.T) {
	approx(t, EffectiveDays(0), 0, "0 hits")
	approx(t, EffectiveDays(1), 7, "1 hit → 7·log2(2)")
	approx(t, EffectiveDays(3), 14, "3 hits → 7·log2(4)")
}

func TestEstimateTokens(t *testing.T) {
	if EstimateTokens("") != 0 {
		t.Fatal("empty → 0")
	}
	if EstimateTokens("abcd") != 1 {
		t.Fatal("4 chars → 1")
	}
	if EstimateTokens("abcde") != 2 {
		t.Fatal("5 chars → ceil(5/4) = 2")
	}
}

func TestIsContentSuperset(t *testing.T) {
	// The canonical counter-example from the engine doc-comment: high
	// cosine + high Jaccard, but "wife" is dropped → NOT a superset.
	if IsContentSuperset("wife's birthday is May 3", "daughter's birthday is May 3") {
		t.Fatal("distinct facts must not read as restatement")
	}
	if !IsContentSuperset("port is 7778", "the NovaMem port is 7778 on the bench") {
		t.Fatal("refinement keeping all content words is a superset")
	}
	if !IsContentSuperset("the a is", "anything") {
		t.Fatal("stopword-only prev has empty token set → superset")
	}
}

func TestLooksContradictory(t *testing.T) {
	if !LooksContradictory("NovaMem deployment uses port 7778", "NovaMem deployment uses port 7779") {
		t.Fatal("differing scalars on both sides → contradictory")
	}
	if LooksContradictory("service is enabled", "service is running fine") {
		t.Fatal("no scalars, same negation polarity → not contradictory")
	}
	if !LooksContradictory("feature is enabled", "feature is not enabled") {
		t.Fatal("negation polarity flip → contradictory")
	}
}
