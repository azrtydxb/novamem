package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/azrtydxb/novamem/go/internal/coldstore"
	"github.com/azrtydxb/novamem/go/internal/config"
	"github.com/azrtydxb/novamem/go/internal/embeddings"
	"github.com/azrtydxb/novamem/go/internal/engine"
	"github.com/azrtydxb/novamem/go/internal/httpapi"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	level := slog.LevelInfo
	if cfg.LogLevel == "debug" {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, cfg.WarmURL)
	if err != nil {
		return fmt.Errorf("warm store pool: %w", err)
	}
	defer pool.Close()

	// Same stance as the TS server's bootstrap: refuse to serve against a
	// schema this build does not understand. Retry briefly — on a fresh
	// deploy Postgres may still be starting.
	checkCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	for {
		err = warmstore.CheckMigrationVersion(checkCtx, pool)
		if err == nil {
			break
		}
		select {
		case <-checkCtx.Done():
			return fmt.Errorf("migration check never succeeded: %w", err)
		case <-time.After(2 * time.Second):
		}
	}

	warm := warmstore.New(pool)

	// Cold tier and embedder are optional: unconfigured, the engine takes
	// the same branches the TS server takes with those services down —
	// writes store with embedded_at NULL and search degrades to keyword.
	var cold *coldstore.Store
	if cfg.ColdProvider == "pgvector" {
		cold, err = coldstore.New(ctx, coldstore.Config{
			URL:        cfg.ColdURL,
			VectorSize: cfg.ColdVectorSize,
			TimeoutMs:  cfg.ColdTimeoutMs,
		})
		if err != nil {
			return fmt.Errorf("cold store: %w", err)
		}
		defer cold.Close()
	}
	var embedder *embeddings.Client
	if cfg.EmbeddingsProvider == "openai-compatible" {
		embedder, err = embeddings.New(embeddings.Config{
			Endpoint:       cfg.EmbeddingsEndpoint,
			Model:          cfg.EmbeddingsModel,
			APIKey:         cfg.EmbeddingsAPIKey,
			Dimensions:     cfg.EmbeddingsDim,
			TimeoutMs:      cfg.EmbeddingsTimeoutMs,
			QueryPrefix:    cfg.EmbeddingsQueryPrefix,
			DocumentPrefix: cfg.EmbeddingsDocumentPrefix,
			Log:            log,
		})
		if err != nil {
			return fmt.Errorf("embedder: %w", err)
		}
		log.Info("embedder configured", "model", embedder.ModelID(),
			"dimensions", embedder.Dimensions(),
			"queryPrefix", embedder.Prefixes().Query,
			"documentPrefix", embedder.Prefixes().Document)
	}
	var reranker *embeddings.Reranker
	if cfg.RerankEnabled {
		reranker = embeddings.NewReranker(embeddings.RerankerConfig{
			Endpoint:  cfg.RerankEndpoint,
			Model:     cfg.RerankModel,
			APIKey:    cfg.RerankAPIKey,
			TimeoutMs: cfg.RerankTimeoutMs,
		})
	}

	eng := engine.New(engine.Options{
		Warm:            warm,
		Cold:            cold,
		Embedder:        embedder,
		Reranker:        reranker,
		Log:             log,
		Quotas:          engine.Quotas{MaxEntries: cfg.QuotaMaxEntries, WritesPerMinute: cfg.QuotaWritesPerMinute},
		MaxContentChars: cfg.MaxContentChars,
		PersonalTerms:   cfg.PersonalTerms,
		MinVectorScore:  cfg.MinVectorScore,
		RerankPoolMult:  cfg.RerankPoolMult,
		GraphLinkFanout: cfg.GraphLinkFanout,
	})

	srv := &http.Server{
		Addr: fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
		Handler: httpapi.New(httpapi.Options{
			Pool:        pool,
			Log:         log,
			Engine:      eng,
			Warm:        warm,
			AuthMode:    cfg.AuthMode,
			AuthToken:   cfg.AuthToken,
			CorsOrigins: cfg.CorsOrigins,
		}),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		log.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Info("novamem-go listening", "addr", srv.Addr, "latestMigration", warmstore.ExpectedLatestMigration)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
