// The end-to-end property #371 asks for, against a real database:
//
//   - what the extraction LLM receives (captured at the extractFacts
//     seam) is REDACTED — no email, phone, key or address survives;
//   - the fact rows distilled from that payload carry the placeholders,
//     so recall still works on redacted text;
//   - the stored entry keeps the ORIGINAL content verbatim, because
//     redaction is about what leaves the process, never about what the
//     user wrote.
//
// Opt-in like the other DB tests:
//
//	NOVAMEM_TEST_DATABASE_URL=postgres://…/throwaway go test ./internal/engine
package engine

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/azrtydxb/novamem/go/internal/llm"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestExtractionPayloadIsRedactedButStoredContentIsNot(t *testing.T) {
	url := os.Getenv("NOVAMEM_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("NOVAMEM_TEST_DATABASE_URL is unset in CI: the go job must provide Postgres")
		}
		t.Skip("set NOVAMEM_TEST_DATABASE_URL to a throwaway database to run")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := warmstore.Migrate(ctx, pool, slog.New(slog.DiscardHandler)); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	warm := warmstore.New(pool)

	on := true
	e := New(Options{Warm: warm, Log: slog.New(slog.DiscardHandler), ExtractorRedact: &on})

	const content = "Email jane.doe@example.com or call +31 6 1234 5678. " +
		"The key is sk-abcdef1234567890abcd and the node is 192.168.10.100."
	const chunkID = "CHNK-redact-test-0001"
	user, ns := "u-redact-test", "redact-test"
	hash := sha256Hex(strings.TrimSpace(content))
	if _, err := warm.InsertEntry(ctx, chunkID, warmstore.InsertEntryArgs{
		UserID:      user,
		Content:     content,
		Namespace:   ns,
		ContentHash: &hash,
		Metadata:    map[string]any{},
	}); err != nil {
		t.Fatal(err)
	}

	// The seam stands in for the LLM. It records exactly what it was
	// handed and turns that payload into a fact object, so what the fact
	// rows hold is provably derived from what left the process.
	var sent string
	e.extractFacts = func(_ context.Context, payload string) ([]llm.ExtractedFact, error) {
		sent = payload
		return []llm.ExtractedFact{{
			Type: "fact", Subject: "the user", Predicate: "recorded",
			Object: payload, Importance: 3,
		}}, nil
	}

	err = e.storeFactsForChunk(ctx, storeFactsArgs{
		userID:       user,
		chunkID:      chunkID,
		chunkContent: content,
		namespace:    ns,
		parentSource: "test-source",
	})
	if err != nil {
		t.Fatal(err)
	}

	// The payload that left the process carries no PII and every
	// placeholder.
	for _, secret := range []string{
		"jane.doe@example.com", "+31 6 1234 5678",
		"sk-abcdef1234567890abcd", "192.168.10.100",
	} {
		if strings.Contains(sent, secret) {
			t.Errorf("extraction payload leaked %q:\n%s", secret, sent)
		}
	}
	for _, ph := range []string{"[EMAIL]", "[PHONE]", "[SECRET]", "[IP]"} {
		if !strings.Contains(sent, ph) {
			t.Errorf("extraction payload missing %s — that PII class was not redacted:\n%s", ph, sent)
		}
	}

	// The fact row the (stub) extractor produced carries the
	// placeholders, so the redaction survives into recall.
	var factContent string
	err = pool.QueryRow(ctx,
		`SELECT content FROM memory_entries
		 WHERE user_id = $1 AND source_type = 'fact'
		   AND metadata->>'source_chunk_id' = $2
		 LIMIT 1`, user, chunkID).Scan(&factContent)
	if err != nil {
		t.Fatalf("no fact row written: %v", err)
	}
	for _, ph := range []string{"[EMAIL]", "[PHONE]", "[SECRET]", "[IP]"} {
		if !strings.Contains(factContent, ph) {
			t.Errorf("stored fact missing %s: %q", ph, factContent)
		}
	}

	// The stored entry keeps the original, verbatim.
	entry, err := warm.GetEntry(ctx, user, chunkID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if entry == nil || entry.Content != content {
		t.Errorf("stored entry was rewritten; redaction must never touch storage:\n got %q\nwant %q",
			entry.Content, content)
	}
}

// The off-switch is an operator decision, and it must actually reach the
// payload rather than being decorative.
func TestExtractionRedactionCanBeDisabled(t *testing.T) {
	url := os.Getenv("NOVAMEM_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("NOVAMEM_TEST_DATABASE_URL is unset in CI: the go job must provide Postgres")
		}
		t.Skip("set NOVAMEM_TEST_DATABASE_URL to a throwaway database to run")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := warmstore.Migrate(ctx, pool, slog.New(slog.DiscardHandler)); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	off := false
	e := New(Options{Warm: warmstore.New(pool), Log: slog.New(slog.DiscardHandler), ExtractorRedact: &off})
	var sent string
	e.extractFacts = func(_ context.Context, payload string) ([]llm.ExtractedFact, error) {
		sent = payload
		return nil, nil
	}
	const content = "mail jane@example.com from 192.168.10.100"
	// The chunk row need not exist: the redaction happens BEFORE the
	// staleness check, so the payload is captured either way.
	if err := e.storeFactsForChunk(ctx, storeFactsArgs{
		userID: "u-off", chunkID: "gone", chunkContent: content, namespace: "n",
	}); err != nil {
		t.Fatal(err)
	}
	if sent != content {
		t.Errorf("redaction ran despite ExtractorRedact=false: %q", sent)
	}
}
