package jobs

import (
	"context"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/azrtydxb/novamem/go/internal/engine"
	"github.com/azrtydxb/novamem/go/internal/metrics"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRetentionDisabledDoesNotDelete(t *testing.T) {
	url := os.Getenv("NOVAMEM_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set NOVAMEM_TEST_DATABASE_URL to a throwaway database to run")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	warm := warmstore.New(pool)
	if err := warmstore.Migrate(ctx, pool, slog.New(slog.DiscardHandler)); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	user := "retention-disabled-" + time.Now().Format("150405.000000000")
	id := "DISABLED" + time.Now().Format("150405.000000000")
	if _, err := warm.InsertEntry(ctx, id, warmstore.InsertEntryArgs{UserID: user, Namespace: "retention-disabled-test", Content: "retention disabled fixture", Metadata: map[string]any{"expiresAt": "2099-01-01T00:00:00Z"}}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM memory_entries WHERE id=$1`, id) })
	if _, err := pool.Exec(ctx, `UPDATE memory_entries SET updated_at=now()-interval '90 days' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	runCtx, cancel := context.WithCancel(ctx)
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	Run(runCtx, Config{
		Engine: engine.New(engine.Options{Warm: warm, Log: slog.New(slog.DiscardHandler)}),
		Warm:   warm, Metrics: metrics.New(), Log: slog.New(slog.DiscardHandler),
		DecayInterval: time.Hour, ReconcileInterval: time.Hour,
		RetentionEnabled: false, RetentionInterval: 10 * time.Millisecond,
		RetentionMaxAge: 24 * time.Hour, RetentionBatch: 10,
	})
	entry, err := warm.GetEntry(ctx, user, id, nil)
	if err != nil {
		t.Fatal(err)
	}
	if entry == nil {
		t.Fatal("retention deleted an entry while disabled")
	}
}

func TestRetentionDisabledDoesNotRegisterTicker(t *testing.T) {
	registered := 0
	scheduleRetention(Config{RetentionEnabled: false}, func(time.Duration, func(context.Context)) {
		registered++
	})
	if registered != 0 {
		t.Fatalf("disabled retention registered %d ticker(s)", registered)
	}
}
