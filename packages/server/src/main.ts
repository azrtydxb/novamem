/**
 * Service entry point. Wires the engine, transports, and the decay loop, and
 * exposes a clean shutdown path.
 */

import { ColdStore } from "./cold-store.js";
import { WarmStore } from "./warm-store/index.js";
import { MemoryEngine } from "./engine/index.js";
import { makeEmbedder, resolvePrefixesWithSource } from "./embeddings.js";
import { buildHttpServer } from "./http.js";
import { loadConfig } from "./config.js";
import { MetricsCollector } from "./admin/metrics.js";
import { buildAuth } from "./auth-betterauth.js";
import { initTracing, shutdownTracing } from "./tracing.js";

async function main() {
  const cfg = loadConfig();
  await initTracing();

  if (cfg.auth.mode === "none") {
    // Hard guard: auth=none is a dev convenience. Binding it to a
    // non-loopback interface exposes every request as `public` to the
    // network. Refuse to start instead of warning-and-continuing.
    const host = cfg.service.host;
    const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
    if (!loopback) {
      throw new Error(
        `[novamem] refusing to start: auth.mode=none with host=${host}. ` +
          "auth=none is dev-only and must bind to loopback (127.0.0.1, ::1, or localhost). " +
          "Set NOVAMEM_AUTH_MODE=user for real isolation, " +
          "or =bearer + NOVAMEM_AUTH_TOKEN for a shared single-user bearer.",
      );
    }
    // Loud, unmissable: a docker-compose default with no auth is fine for
    // local dev but a footgun in production. The default exists so the
    // service "just works" out of the box; this warning is the receipt.
    // console.* reserved for pre-logger bootstrap only — Fastify's pino
    // logger doesn't exist until buildHttpServer runs.
    // eslint-disable-next-line no-console
    console.warn(
      "[novamem] WARNING: auth.mode=none — every request is accepted as the 'public' user. " +
        "Set NOVAMEM_AUTH_MODE=user for real isolation, " +
        "or =bearer + NOVAMEM_AUTH_TOKEN for a shared single-user bearer.",
    );
  } else if (cfg.auth.mode === "bearer") {
    // Bearer mode is fine for single-user deployments but doesn't isolate.
    // console.* reserved for pre-logger bootstrap only.
    // eslint-disable-next-line no-console
    console.warn(
      "[novamem] auth.mode=bearer — single shared token, single 'public' user. " +
        "Use auth.mode=user for multi-user isolation.",
    );
  }

  const warm = new WarmStore({ url: cfg.warm.url, pgPoolMax: cfg.service.pgPoolMax });
  await warm.initialize();

  const cold =
    cfg.cold.provider === "pgvector"
      ? (new (await import("./cold-store-pgvector.js")).PgVectorColdStore({
          url: cfg.cold.url,
          vectorSize: cfg.cold.vectorSize,
          timeoutMs: cfg.cold.timeoutMs,
        // Same structural-cast pattern as the test fakes (asCold): the
        // engine consumes the shared method surface, not Qdrant details.
        }) as unknown as ColdStore)
      : new ColdStore({
          url: cfg.cold.url,
          vectorSize: cfg.cold.vectorSize,
          timeoutMs: cfg.cold.timeoutMs,
        });

  const embedder = makeEmbedder({
    provider: cfg.embeddings.provider,
    endpoint: cfg.embeddings.endpoint,
    model: cfg.embeddings.model,
    apiKey: cfg.embeddings.apiKey,
    dimensions: cfg.embeddings.dimensions,
    timeoutMs: cfg.embeddings.timeoutMs,
    queryPrefix: cfg.embeddings.queryPrefix,
    documentPrefix: cfg.embeddings.documentPrefix,
  });

  // Say out loud how the retrieval prefixes were decided. An asymmetric
  // model driven with empty prefixes loses a large slice of its accuracy
  // — measured at 7.6pp Recall@10 on Qwen3-Embedding — and there is
  // otherwise nothing at runtime to distinguish "this model wants no
  // prefixes" from "nobody taught NovaMem about this model".
  {
    const { source } = resolvePrefixesWithSource(cfg.embeddings.model, {
      query: cfg.embeddings.queryPrefix,
      document: cfg.embeddings.documentPrefix,
    });
    const model = cfg.embeddings.model ?? "(provider default)";
    if (source === "none") {
      // console.* reserved for pre-logger bootstrap only — this runs
      // before buildHttpServer creates the pino logger.
      // eslint-disable-next-line no-console
      console.warn(
        `[novamem] no retrieval-prefix preset matched embedding model '${model}' — using empty ` +
          "query/document prefixes. Correct for symmetric models (MiniLM, bge-m3); wrong for " +
          "instruction-aware or asymmetric ones (e5, bge-*-en, Qwen3-Embedding), which lose " +
          "accuracy silently when driven symmetrically. Set NOVAMEM_EMBEDDINGS_QUERY_PREFIX / " +
          "_DOCUMENT_PREFIX if this model needs them.",
      );
    }
  }

  const metrics = new MetricsCollector();
  metrics.bindGaugeSources({
    warmEntries: async () => {
      const r = await warm.pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM memory_entries WHERE cold = false",
      );
      return Number(r.rows[0]?.count ?? 0);
    },
    coldEntries: async () => {
      const r = await warm.pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM memory_entries WHERE cold = true",
      );
      return Number(r.rows[0]?.count ?? 0);
    },
    // Phase 7: edges live in SQL; count them there.
    graphEdges: async () => {
      const r = await warm.pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM memory_relations",
      );
      return Number(r.rows[0]?.count ?? 0);
    },
    orphansPending: async () => {
      const r = await warm.pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM cold_orphans",
      );
      return Number(r.rows[0]?.count ?? 0);
    },
    // Read-through on scrape rather than off the engine's cached tick, so
    // the alerting signal is current even if the reconciler loop itself
    // has wedged — which is one of the things it needs to catch.
    pendingEmbeddings: async () => warm.countPendingEmbedding(),
    pendingFacts: async () => warm.countPendingFacts(),
  });

  metrics.bindUserGaugeSources({
    warmEntries: async (userId) => {
      const r = await warm.pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM memory_entries WHERE user_id = $1 AND cold = false",
        [userId],
      );
      return Number(r.rows[0]?.count ?? 0);
    },
    coldEntries: async (userId) => {
      const r = await warm.pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM memory_entries WHERE user_id = $1 AND cold = true",
        [userId],
      );
      return Number(r.rows[0]?.count ?? 0);
    },
    graphEdges: async (_userId) => {
      // Per-user edge count would require a graph query parameterised on
      // user — out of scope for this dashboard cut. Return null so the UI
      // shows "—" for user-scoped graph edges.
      return null;
    },
  });

  // Arch-plan Phase 2/4/5: optional LLM modules. Each is constructed iff
  // its `enabled` flag and required (endpoint, model) are set in config.
  // Disabling them falls back to the pre-arch-plan engine behaviour.
  let extractor: import("./engine/fact-extractor.js").FactExtractor | undefined;
  if (cfg.extraction.enabled && cfg.extraction.endpoint && cfg.extraction.model) {
    const { FactExtractor } = await import("./engine/fact-extractor.js");
    extractor = new FactExtractor({
      endpoint: cfg.extraction.endpoint,
      model: cfg.extraction.model,
      apiKey: cfg.extraction.apiKey,
      maxFactsPerChunk: cfg.extraction.maxFactsPerChunk,
      timeoutMs: cfg.extraction.timeoutMs,
      maxConcurrent: cfg.extraction.maxConcurrent,
    });
  }
  let decomposer: import("./engine/query-decomposer.js").QueryDecomposer | undefined;
  if (cfg.queryDecomp.enabled && cfg.queryDecomp.endpoint && cfg.queryDecomp.model) {
    const { QueryDecomposer } = await import("./engine/query-decomposer.js");
    decomposer = new QueryDecomposer({
      endpoint: cfg.queryDecomp.endpoint,
      model: cfg.queryDecomp.model,
      apiKey: cfg.queryDecomp.apiKey,
      maxSubqueries: cfg.queryDecomp.maxSubqueries,
      coherenceRerank: cfg.queryDecomp.coherenceRerank,
      timeoutMs: cfg.queryDecomp.timeoutMs,
    });
  }
  let reranker: import("./engine/reranker.js").SearchReranker | undefined;
  if (cfg.rerank.enabled && cfg.rerank.endpoint && cfg.rerank.model) {
    const { SearchReranker } = await import("./engine/reranker.js");
    reranker = new SearchReranker({
      endpoint: cfg.rerank.endpoint,
      model: cfg.rerank.model,
      apiKey: cfg.rerank.apiKey,
      timeoutMs: cfg.rerank.timeoutMs,
    });
  }
  let observer: import("./engine/observer.js").Observer | undefined;
  if (cfg.observer.enabled && cfg.observer.endpoint && cfg.observer.model) {
    const { Observer } = await import("./engine/observer.js");
    observer = new Observer(
      {
        endpoint: cfg.observer.endpoint,
        model: cfg.observer.model,
        apiKey: cfg.observer.apiKey,
        observeThreshold: cfg.observer.observeThreshold,
        reflectThreshold: cfg.observer.reflectThreshold,
        timeoutMs: cfg.observer.timeoutMs,
      },
      warm,
    );
  }

  const engine = new MemoryEngine({
    warm,
    cold,
    embedder,
    defaultEffectiveDays: cfg.decay.defaultEffectiveDays,
    metrics,
    extractor,
    extractorMaxFacts: cfg.extraction.maxFactsPerChunk,
    decomposer,
    reranker,
    rerankPoolMultiplier: cfg.rerank.poolMultiplier,
    graphLinkFanout: cfg.graphLinkFanout,
    observer,
    personalTerms: cfg.search.personalTerms,
    minVectorScore: cfg.search.minVectorScore,
    maxContentChars: cfg.search.maxContentChars,
  });

  // Better Auth instance — owns the dashboard control plane (login,
  // sessions, JWT issuance). Phase 1: scaffolded alongside the existing
  // /v1/auth/* routes; both flows live until the SPA cuts over.
  const baseUrl = cfg.service.baseUrl;
  const ba = buildAuth({
    pool: warm.pool,
    baseUrl,
    secret: cfg.cookieSecret,
    secureCookies: !cfg.service.insecureCookies,
    trustedOrigins: [baseUrl, "http://localhost:5173"],
  });

  // Bootstrap admin via Better Auth — sign up an account with the
  // configured bootstrap email + password if no Better Auth users exist
  // yet. Idempotent: re-runs on every start but no-ops once an account
  // is present. Better Auth's admin plugin can promote a user via
  // setRole; we do that immediately after sign-up so the dashboard's
  // role-gated routes work on the first login.
  // Scrub the bootstrap password from the env immediately after
  // loadConfig captured it, so `docker inspect` / a later spawn can't
  // recover it for the lifetime of the process. The captured value
  // lives only on the cfg object below.
  delete process.env.NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD;

  try {
    const adminEmail = cfg.bootstrap.adminEmail ?? null;
    const adminPassword = cfg.bootstrap.adminPassword ?? null;
    if (adminEmail && adminPassword) {
      // Seed when the system has no admin yet — even if regular users
      // already exist. Admin is the operator account (user management +
      // health checks); regular users sign in for memory operations.
      const probe = await warm.pool.query<{ count: string }>(
        `SELECT count(*)::text FROM "user" WHERE role = 'admin'`,
      );
      const adminCount = Number(probe.rows[0]?.count ?? "0");
      if (adminCount === 0) {
        // `name` is intentionally distinct from `email` — Better Auth's
        // `name` column has no uniqueness constraint, so reusing the email
        // there lets a later attacker register an account whose `name`
        // collides with the admin's email and leak through any
        // name-based lookup. Use a fixed sentinel instead.
        const r = await ba.api.signUpEmail({
          body: {
            email: adminEmail,
            password: adminPassword,
            name: "bootstrap-admin",
          },
        });
        const newUserId = (r as { user?: { id?: string } } | undefined)?.user?.id;
        if (newUserId) {
          // Promote the bootstrap user to admin. Better Auth's
          // /admin/set-role endpoint requires admin auth — and we're
          // the only user in the system right now, so there's no admin
          // to make the call. The warm store exposes `promoteToAdmin`
          // as the documented escape hatch for the bootstrap case.
          await warm.promoteToAdmin(newUserId);
          // console.* reserved for pre-logger bootstrap only — `app` and
          // its pino logger don't exist yet at this point.
          // eslint-disable-next-line no-console
          console.log(`[novamem] seeded bootstrap admin "${adminEmail}" via Better Auth`);
        }
      }
    }
  } catch (err) {
    // console.* reserved for pre-logger bootstrap only.
    // eslint-disable-next-line no-console
    console.error("[novamem] bootstrap admin failed:", (err as Error).message);
  }

  const app = buildHttpServer({
    engine,
    warm,
    auth: cfg.auth,
    cookieSecret: cfg.cookieSecret,
    rateLimitPerMinute: cfg.service.rateLimitPerMinute,
    logLevel: cfg.service.logLevel,
    corsOrigins: cfg.service.corsOrigins,
    metrics,
    adminDashboard: cfg.admin.dashboard,
    betterAuth: {
      handler: (req) => ba.handler(req),
      // Type derived from Better Auth's actual API shape — a BA upgrade
      // that changes the session payload becomes a compile error here
      // (and in HttpOptions) instead of a silent runtime mismatch.
      getSession: (headers) => ba.api.getSession({ headers }),
      signUpEmail: (body) => ba.api.signUpEmail({ body }),
    },
  });

  // Embedding-model provenance check. Runs after the logger swap below
  // would be too late — but before serving traffic is what matters, and
  // the engine logger is already wired by this point.
  await engine.checkEmbeddingModel().catch((err) => {
    app.log.warn({ err: (err as Error).message }, "embedding-model check failed");
  });

  // Now that the Fastify pino logger exists, swap the engine + graph
  // store boot-time console fallbacks for component-tagged child
  // loggers. Anything they log from this point on lands in the same
  // structured stream as request logs.
  engine.setLogger(app.log.child({ component: "engine" }));

  // ─── Background timers ──────────────────────────────────────────────
  // Each timer wraps its async body in an `inFlight` reentrancy guard:
  // if the previous tick is still running when the next fires, the next
  // is skipped. Per spec each timer keeps its own flag — a slow decay()
  // shouldn't block the dream cycle and vice-versa. The metrics flush
  // is idempotent so the guard is mostly belt-and-braces; dream is the
  // one that genuinely cannot run twice concurrently (the dedup-merge
  // phase races itself on the canonical-vs-loser pick).
  let decayInFlight = false;
  const decayTimer = setInterval(async () => {
    if (decayInFlight) return;
    decayInFlight = true;
    try {
      await engine.decay();
      // Run the cold-orphan reaper on the same cadence — both touch cold
      // storage and there's no value in running them at different rates.
      const reap = await engine.reapOrphans();
      if (reap.attempted > 0) {
        app.log.info({ ...reap }, "reaped orphans");
      }
    } catch (err) {
      app.log.error({ err: (err as Error).message }, "decay/reap loop error");
    } finally {
      decayInFlight = false;
    }
  }, cfg.decay.intervalMs);

  // Dream cycle — periodic compaction. Runs daily at the same cadence
  // as decay (the heavy work is the per-entry vector lookup; we don't
  // want to fire it more often than once per cold-store-write batch).
  // No-op on small stores, useful on large ones.
  let dreamInFlight = false;
  const dreamTimer = setInterval(async () => {
    if (dreamInFlight) return;
    dreamInFlight = true;
    try {
      const r = await engine.dreamCycle();
      if (r.merged > 0 || r.edgesPromoted > 0) {
        app.log.info(
          {
            walked: r.walked,
            merged: r.merged,
            edgesPromoted: r.edgesPromoted,
            durationMs: r.durationMs,
          },
          "dream cycle",
        );
      }
    } catch (err) {
      app.log.error({ err: (err as Error).message }, "dream cycle error");
    } finally {
      dreamInFlight = false;
    }
  }, 24 * 60 * 60 * 1000);
  dreamTimer.unref?.();

  // Embedding reconciler — drains entries whose vector was never written
  // (embedded_at IS NULL). Same reentrancy contract as the loops above:
  // a tick that overruns its interval is skipped rather than stacked, so
  // a slow embedder can't pile up concurrent batches against itself.
  // Errors are logged and the batch is simply retried next tick — the
  // pending state lives on the row, so nothing is lost by giving up here.
  let reconcileInFlight = false;
  const reconcileTimer = setInterval(async () => {
    if (reconcileInFlight) return;
    reconcileInFlight = true;
    try {
      const r = await engine.reconcilePendingEmbeddings({
        batchSize: cfg.embeddings.reconcileBatchSize,
      });
      if (r.scanned > 0) {
        app.log.info({ ...r }, "reconciled pending embeddings");
      }
      // Same tick, same in-flight guard: the fact-extraction twin. Runs
      // after embeddings so a shared outage recovers vectors (cheap)
      // before facts (LLM-bound). The extractor's semaphore meters the
      // batch's LLM concurrency exactly as it does for live writes.
      const f = await engine.reconcilePendingFacts({
        batchSize: cfg.embeddings.reconcileBatchSize,
      });
      if (f.scanned > 0) {
        app.log.info({ ...f }, "reconciled pending fact extractions");
      }
      // Third twin: deferred graph enrichment. Last because it is the
      // most deferrable — edges are a retrieval enhancement, not data.
      const g = await engine.reconcilePendingEnrichment({
        batchSize: cfg.embeddings.reconcileBatchSize,
      });
      if (g.scanned > 0) {
        app.log.info({ ...g }, "reconciled pending graph enrichment");
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      app.log.error({ err: e }, "reconciler error (embeddings, fact extraction, or graph enrichment)");
    } finally {
      reconcileInFlight = false;
    }
  }, cfg.embeddings.reconcileIntervalMs);
  reconcileTimer.unref?.();

  // 24h persistent throughput: every minute, flush pending per-user
  // counters from the in-mem MetricsCollector to metrics_samples so the
  // history chart survives reboots. Same loop also prunes >25h-old rows
  // so the table can't grow without bound.
  let metricsFlushInFlight = false;
  const metricsFlushTimer = setInterval(async () => {
    if (metricsFlushInFlight) return;
    metricsFlushInFlight = true;
    try {
      // Floor sampledAt to the minute so the bucket is stable across
      // races between record() and drain().
      const now = new Date();
      now.setSeconds(0, 0);
      const samples = metrics.drainPendingSamples(now);
      if (samples.length > 0) {
        try {
          await warm.recordMetricsSamples(samples);
        } catch (err) {
          // The drain already zeroed the in-memory counters, so a failed
          // insert used to silently lose that whole window. Put the
          // counts back so the next tick retries them.
          metrics.restorePendingSamples(samples);
          throw err;
        }
      }
      // Keep ~25h of history (24h chart + a margin) so a chart query at
      // sample-time-minus-24h always finds a left edge.
      const cutoff = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await warm.pruneMetricsSamples(cutoff);
    } catch (err) {
      app.log.error({ err: (err as Error).message }, "metrics flush error");
    } finally {
      metricsFlushInFlight = false;
    }
  }, 60 * 1000);
  metricsFlushTimer.unref?.();

  await app.listen({ host: cfg.service.host, port: cfg.service.port });

  app.log.info({ host: cfg.service.host, port: cfg.service.port }, "novamem listening");

  // Graceful shutdown. Three things the previous version got wrong:
  //   1. Any rejection (e.g. `warm.close()` against a broken pool) became
  //      an unhandled rejection and the process never reached
  //      `process.exit(0)` — it hung until the orchestrator SIGKILLed it.
  //   2. A hung `app.close()` (a long-poll SSE client, a stuck query) had
  //      no deadline, same outcome.
  //   3. A second SIGTERM re-entered the whole sequence.
  const SHUTDOWN_DEADLINE_MS = 15_000;
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    // Hard deadline: if the graceful path stalls, exit anyway rather than
    // waiting for the supervisor's kill signal.
    const forceExit = setTimeout(() => {
      app.log.error({ deadlineMs: SHUTDOWN_DEADLINE_MS }, "graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    forceExit.unref?.();

    clearInterval(decayTimer);
    clearInterval(dreamTimer);
    clearInterval(reconcileTimer);
    clearInterval(metricsFlushTimer);
    // Each step is independently guarded: one broken dependency must not
    // prevent the others from closing cleanly.
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["http", () => app.close()],
      ["warm", () => warm.close()],
      ["tracing", () => shutdownTracing()],
    ];
    for (const [name, close] of steps) {
      try {
        await close();
      } catch (err) {
        app.log.error({ step: name, err: (err as Error).message }, "shutdown step failed");
      }
    }
    clearTimeout(forceExit);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // A rejected promise with no handler would otherwise terminate the
  // process on Node ≥15 with no structured log line explaining why.
  process.on("unhandledRejection", (reason) => {
    app.log.error(
      { err: reason instanceof Error ? reason.message : String(reason) },
      "unhandled promise rejection",
    );
  });
  process.on("uncaughtException", (err) => {
    app.log.error({ err: err.message, stack: err.stack }, "uncaught exception — shutting down");
    void shutdown("uncaughtException");
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
