// Package jobs runs the background timers main.ts owns in the TS server:
// the decay/reap loop, the daily dream cycle, the embedding + enrichment
// reconciler, and the per-minute metrics flush.
//
// Every loop keeps its OWN in-flight guard: a tick that overruns its
// interval is SKIPPED, never stacked, and a slow decay must not block the
// dream cycle or vice-versa. Because each loop is a single goroutine that
// runs its body to completion before waiting for the next tick, the guard
// is structural here rather than a flag — the ticker's dropped ticks ARE
// the skip.
//
// Shutdown is by context: Run returns once every loop has finished the
// tick it was in.
package jobs

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/azrtydxb/novamem/go/internal/engine"
	"github.com/azrtydxb/novamem/go/internal/metrics"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

type Config struct {
	Engine  *engine.Engine
	Warm    *warmstore.Store
	Metrics *metrics.Collector
	Log     *slog.Logger

	// DecayInterval — NOVAMEM_DECAY_INTERVAL_MS (6h default). The
	// cold-orphan reaper rides the same tick: both touch cold storage and
	// there is no value in running them at different rates.
	DecayInterval time.Duration
	// ReconcileInterval / ReconcileBatch —
	// NOVAMEM_EMBEDDINGS_RECONCILE_INTERVAL_MS / _BATCH.
	ReconcileInterval time.Duration
	ReconcileBatch    int
}

// Run starts every loop and blocks until ctx is cancelled and all
// in-flight ticks have finished.
func Run(ctx context.Context, cfg Config) {
	var wg sync.WaitGroup
	loop := func(every time.Duration, body func(context.Context)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			t := time.NewTicker(every)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					body(ctx)
				}
			}
		}()
	}

	loop(cfg.DecayInterval, func(ctx context.Context) {
		r, err := cfg.Engine.Decay(ctx, 0)
		if err != nil {
			cfg.Log.Error("decay/reap loop error", "err", err)
			return
		}
		cfg.Log.Info("decay", "demoted", r.Demoted, "promoted", r.Promoted, "expired", r.Expired)
		reap, err := cfg.Engine.ReapOrphans(ctx)
		if err != nil {
			cfg.Log.Error("decay/reap loop error", "err", err)
			return
		}
		if reap.Attempted > 0 {
			cfg.Log.Info("reaped orphans", "attempted", reap.Attempted, "cleared", reap.Cleared,
				"abandoned", reap.Abandoned, "pending", reap.Pending, "total", reap.Total)
		}
	})

	// Dream cycle — daily. The heavy work is the per-entry vector lookup;
	// firing it more often than once per cold-write batch buys nothing.
	loop(24*time.Hour, func(ctx context.Context) {
		r, err := cfg.Engine.DreamCycle(ctx)
		if err != nil {
			cfg.Log.Error("dream cycle error", "err", err)
			return
		}
		if r.Merged > 0 || r.EdgesPromoted > 0 {
			cfg.Log.Info("dream cycle", "walked", r.Walked, "merged", r.Merged,
				"edgesPromoted", r.EdgesPromoted, "durationMs", r.DurationMs)
		}
	})

	// Reconciler: vectors first (cheap), then the deferred graph
	// enrichment (the most deferrable — edges are a retrieval
	// enhancement, not data). Errors are logged and the batch is retried
	// next tick; the pending state lives on the row, so nothing is lost.
	loop(cfg.ReconcileInterval, func(ctx context.Context) {
		r, err := cfg.Engine.ReconcilePendingEmbeddings(ctx, cfg.ReconcileBatch)
		if err != nil {
			cfg.Log.Error("reconciler error (embeddings)", "err", err)
		} else if r.Scanned > 0 {
			cfg.Log.Info("reconciled pending embeddings", "scanned", r.Scanned,
				"embedded", r.Done, "failed", r.Failed, "pending", r.Pending)
		}
		g, err := cfg.Engine.ReconcilePendingEnrichment(ctx, cfg.ReconcileBatch)
		if err != nil {
			cfg.Log.Error("reconciler error (graph enrichment)", "err", err)
		} else if g.Scanned > 0 {
			cfg.Log.Info("reconciled pending graph enrichment", "scanned", g.Scanned,
				"enriched", g.Done, "failed", g.Failed, "pending", g.Pending)
		}
	})

	// Persistent throughput: flush the per-user counters to
	// metrics_samples every minute so the 24h chart survives a restart,
	// and prune >25h-old rows (24h chart + margin) so the table can't
	// grow without bound.
	loop(time.Minute, func(ctx context.Context) {
		// Floor to the minute so the bucket is stable across races
		// between Record() and DrainSamples().
		now := time.Now().Truncate(time.Minute)
		samples := cfg.Metrics.DrainSamples(now)
		if len(samples) > 0 {
			userIDs := make([]string, len(samples))
			queries := make([]int, len(samples))
			remembers := make([]int, len(samples))
			for i, s := range samples {
				userIDs[i], queries[i], remembers[i] = s.UserID, s.Queries, s.Remembers
			}
			if err := cfg.Warm.RecordMetricsSamples(ctx, userIDs, now, queries, remembers); err != nil {
				// The drain already zeroed the counters, so put them back
				// or the whole window is silently lost.
				cfg.Metrics.RestoreSamples(samples)
				cfg.Log.Error("metrics flush error", "err", err)
				return
			}
		}
		if _, err := cfg.Warm.PruneMetricsSamples(ctx, time.Now().Add(-25*time.Hour)); err != nil {
			cfg.Log.Error("metrics flush error", "err", err)
		}
	})

	wg.Wait()
}
