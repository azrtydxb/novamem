package engine

import (
	"testing"
	"time"

	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

func TestFuseSearchCandidatesSortsAfterFactImportanceBoost(t *testing.T) {
	e := &Engine{minVectorScore: 0}
	entries := map[string]*warmstore.Entry{
		"raw":  {Metadata: map[string]any{"fact": map[string]any{"importance": float64(1)}}},
		"fact": {Metadata: map[string]any{"fact": map[string]any{"importance": float64(5)}}},
	}
	got := e.fuseSearchCandidates(
		[]warmstore.ScoredID{{ID: "raw", Score: 0.9}, {ID: "fact", Score: 0.5}},
		nil,
		[]string{"raw", "fact"},
		entries,
		"query",
		HybridWeights{Keyword: 1},
		nil,
		time.Now(),
	)
	if len(got) != 2 || got[0].ID != "fact" || got[1].ID != "raw" {
		t.Fatalf("importance-adjusted order = %v; want [fact raw]", got)
	}
}
