package engine

// The narrow race in #272: extraction runs detached from the write, so an
// update can land while the LLM call is still out. Everything the
// extractor produces describes the text it was handed; if the row no
// longer holds that text, those facts describe wording that no longer
// exists — and Update has already deleted the derivatives they would sit
// beside, so writing them resurrects the old content's facts.
//
// The second half of the bug is quieter and worse: the stale goroutine
// finished by clearing facts_pending_at, settling a debt it had not paid.
// The reconciler then never retried, so the wrong facts stayed forever.
//
// These drive the decision directly. Two things are deliberately NOT
// covered here, and both need a live Postgres plus a real extractor:
// the end-to-end race (block the extractor, update, release), and the
// assertion that facts_pending_at survives a discard. The second is
// visible in the code — the stale branch returns before any write — but
// visible is not tested, and `extractor` is a concrete *llm.FactExtractor
// with no seam to block.
//
// What is tested is the predicate the whole fix turns on: whether this
// extraction is still describing the row it was started for.

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/azrtydxb/novamem/go/internal/llm"
)

func hashOf(s string) string { return sha256Hex(strings.TrimSpace(s)) }

func TestSourceMovedDecidesWhetherFactsMayBeWritten(t *testing.T) {
	const content = "the espresso machine is descaled monthly"

	for _, tc := range []struct {
		name      string
		stored    string
		found     bool
		lookupErr error
		wantMoved bool
		wantErr   bool
	}{
		{
			name:   "unchanged content is not moved",
			stored: hashOf(content), found: true,
			wantMoved: false,
		},
		{
			name: "content replaced underneath the extraction is moved",
			// What an update does: same row, different text.
			stored: hashOf("the espresso machine is descaled weekly"), found: true,
			wantMoved: true,
		},
		{
			name:   "leading and trailing space is not a change",
			stored: hashOf("   " + content + "\n"), found: true,
			wantMoved: false,
		},
		{
			name: "a deleted row is moved",
			// Its facts describe nothing, and the delete path already
			// removed the derivatives they would join.
			found: false, wantMoved: true,
		},
		{
			name: "a row with no hash at all is not moved",
			// Rows written before content hashing. There is nothing to
			// compare; stalling extraction on them forever would be a
			// worse bug than the race this guards.
			stored: "", found: true,
			wantMoved: false,
		},
		{
			name:      "a failed lookup is an error, never a silent write",
			lookupErr: errors.New("connection refused"),
			wantErr:   true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := &Engine{entryContentHash: func(context.Context, string) (string, bool, error) {
				return tc.stored, tc.found, tc.lookupErr
			}}
			moved, err := e.sourceMoved(context.Background(), storeFactsArgs{
				chunkID: "01J", chunkContent: content,
			})
			if tc.wantErr {
				if err == nil {
					t.Fatal("lookup failed but sourceMoved reported success — " +
						"the caller would treat that as 'not moved' and write the facts")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if moved != tc.wantMoved {
				t.Errorf("sourceMoved = %v, want %v", moved, tc.wantMoved)
			}
		})
	}
}

// TestStaleExtractionWritesNothing asserts the guard is WIRED IN, not
// merely correct.
//
// The predicate test above passes even with the check deleted from
// storeFactsForChunk, which is exactly the failure worth guarding: a
// correct function nobody calls. Here the warm store is nil, so every
// write below the guard — FindByContentHash, InsertEntry and the
// SetFactsPendingAt that settles the debt — dereferences nil. Reaching
// any of them panics.
//
// So: guard present, this returns cleanly and touches nothing. Guard
// removed, it panics on the first write it should never have attempted.
func TestStaleExtractionWritesNothing(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("extraction tried to write against a superseded source (panic: %v) — "+
				"the staleness guard is not being consulted in storeFactsForChunk", r)
		}
	}()

	e := &Engine{
		log:  slog.New(slog.DiscardHandler),
		warm: nil, // any write below the guard is a nil dereference
		extractFacts: func(context.Context, string) ([]llm.ExtractedFact, error) {
			return []llm.ExtractedFact{{
				Type: "preference", Subject: "user",
				Predicate: "descales", Object: "monthly",
			}}, nil
		},
		// The update landed while the extractor was out: same row, text
		// the extraction never saw.
		entryContentHash: func(context.Context, string) (string, bool, error) {
			return hashOf("the espresso machine is descaled weekly"), true, nil
		},
	}

	err := e.storeFactsForChunk(context.Background(), storeFactsArgs{
		chunkID:      "01J",
		chunkContent: "the espresso machine is descaled monthly",
	})
	if err != nil {
		t.Fatalf("a superseded source is a discard, not an error: %v", err)
	}
}

// TestFreshExtractionIsNotDiscarded is the other half: the guard must not
// swallow the ordinary case. With the row still holding the text it was
// handed, extraction proceeds — and reaches the writes, which panic on
// the nil store. That panic is the proof it got through.
func TestFreshExtractionIsNotDiscarded(t *testing.T) {
	const content = "the espresso machine is descaled monthly"
	e := &Engine{
		log:  slog.New(slog.DiscardHandler),
		warm: nil,
		extractFacts: func(context.Context, string) ([]llm.ExtractedFact, error) {
			return []llm.ExtractedFact{{Type: "preference", Subject: "user"}}, nil
		},
		entryContentHash: func(context.Context, string) (string, bool, error) {
			return hashOf(content), true, nil
		},
	}
	defer func() {
		if recover() == nil {
			t.Error("an unchanged source was discarded — the guard is too eager, " +
				"and ordinary extractions would silently store no facts")
		}
	}()
	_ = e.storeFactsForChunk(context.Background(), storeFactsArgs{
		chunkID: "01J", chunkContent: content,
	})
}
