/**
 * Service configuration. Loaded from env vars by `loadConfig()`. A YAML loader
 * can layer on top later — env-only is the simplest sensible default and
 * matches the docker-compose deployment.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";

/** Env-var boolean. Accepts real booleans (for programmatic callers) and
 *  the usual string spellings, treating "0"/"false"/"no"/"off"/"" as
 *  false. `z.coerce.boolean()` cannot be used for env vars: it applies JS
 *  truthiness, so every non-empty string — including "false" — is true. */
const EnvBoolean = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === "boolean") return v;
    const s = v.trim().toLowerCase();
    return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
  });

export const ConfigSchema = z
  .object({
    service: z.object({
      host: z.string().default("0.0.0.0"),
      port: z.coerce.number().int().min(1).max(65_535).default(7_778),
      rateLimitPerMinute: z.coerce.number().int().positive().default(600),
      /** Pino log level for the Fastify logger. Operator override via
       *  LOG_LEVEL (no NOVAMEM_ prefix — matches the de-facto Pino
       *  convention). */
      logLevel: z
        .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
        .default("info"),
      /** CORS allow-list. Comma-separated env value is parsed into an
       *  array; "*" → reflect-any, "" / "self" → same-origin only.
       *  Default mirrors the dev SPA origin. */
      corsOrigins: z.array(z.string()).default(["http://localhost:5173"]),
      /** When true (NOVAMEM_INSECURE_COOKIES=1), session cookies are
       *  emitted without the Secure attribute so localhost dev over HTTP
       *  works. Production must leave this false. */
      insecureCookies: EnvBoolean.default(false),
      /** Public-facing base URL for the service — used by Better Auth as
       *  its trusted origin / cookie domain. Defaults to
       *  http://${host}:${port} when unset. */
      baseUrl: z.string().default("http://0.0.0.0:7778"),
      /** Postgres pool max connections. Bounded so a load spike can't
       *  exhaust the database silently. Default 20. */
      pgPoolMax: z.coerce.number().int().positive().default(20),
    }),
    auth: z
      .object({
        // - "none": dev only, every request becomes the synthetic `public` user.
        // - "bearer": single shared token, single implicit `public` user — back-compat.
        // - "user": per-user bearers via user_tokens table, real isolation.
        mode: z.enum(["none", "bearer", "user"]).default("user"),
        token: z.string().optional(),
      })
      .refine((v) => v.mode !== "bearer" || !!v.token, {
        message: "auth.mode = 'bearer' requires auth.token (NOVAMEM_AUTH_TOKEN)",
        path: ["token"],
      }),
    warm: z.object({
      url: z.string(),
    }),
    cold: z.object({
      /** Vector backend. `qdrant` (default) or `pgvector` — Phase 8.
       *  pgvector keeps vectors in Postgres (usually the warm store's own
       *  database via `url`), collapsing the minimum stack to one
       *  database + an embedder. Qdrant remains the scale-out option. */
      provider: z.enum(["qdrant", "pgvector"]).default("qdrant"),
      /** Qdrant URL, or a Postgres connection string for pgvector. For
       *  pgvector, leave unset to reuse the warm store's database. */
      url: z.string(),
      vectorSize: z.coerce.number().int().positive().default(384),
      /** Per-request timeout in ms (Qdrant request / Postgres statement). */
      timeoutMs: z.coerce.number().int().positive().default(15_000),
    }),
    embeddings: z.object({
      provider: z.enum(["openai-compatible", "local-transformers"]).default("local-transformers"),
      endpoint: z.string().optional(),
      model: z.string().optional(),
      apiKey: z.string().optional(),
      dimensions: z.coerce.number().int().positive().default(384),
      /** Per-request timeout for remote embedders. */
      timeoutMs: z.coerce.number().int().positive().default(30_000),
      /** Asymmetric-retrieval prefixes. Left unset, they're inferred from
       *  the model id (e5 / bge families); set explicitly to override. */
      queryPrefix: z.string().optional(),
      documentPrefix: z.string().optional(),
      /** How often the reconciler looks for entries written without a
       *  vector. 60s trades a minute of "stored but not yet semantically
       *  findable" for a loop that is invisible when the backlog is
       *  empty (one indexed count against a near-empty partial index). */
      reconcileIntervalMs: z.coerce.number().int().positive().default(60_000),
      /** Entries per reconciler tick — bounds embedder/LLM load and tick
       *  duration while a backlog drains. 400, not 50: with claim-on-read
       *  batching (disjoint rows per replica) a big batch keeps the
       *  extraction semaphore fed for the whole tick instead of starving
       *  it — measured 3× drain throughput during the Phase 6 backlog
       *  (a 10k-entry backlog cleared in under an hour). The per-call
       *  semaphores, not this number, are what actually cap upstream
       *  burst load. */
      reconcileBatchSize: z.coerce.number().int().positive().max(1000).default(400),
    }),
    search: z.object({
      /** Absolute cosine below which a vector-only candidate is treated as
       *  noise rather than a hit. */
      minVectorScore: z.coerce.number().min(0).max(1).default(0.25),
      /** Reject writes longer than this many characters — beyond the
       *  embedding model's window the tail is silently unsearchable. */
      maxContentChars: z.coerce.number().int().min(0).default(4_000),
      /** Deployment-specific high-relevance vocabulary for the worthiness
       *  scorer (operator name, product names, project slugs). */
      personalTerms: z.array(z.string()).default([]),
    }).default({ minVectorScore: 0.25, maxContentChars: 4_000, personalTerms: [] }),
    /** Arch-plan Phase 2: write-time LLM fact extraction. When enabled, every
     *  `/v1/remember` triggers a background LLM pass that distills the raw
     *  chunk into ≤5 typed facts (preference / fact / event / task /
     *  knowledge). Each fact is stored as its own memory_entries row with
     *  metadata.fact = {...} and metadata.source_chunk_id back-pointing to
     *  the raw chunk. Fire-and-forget so write-path latency is unaffected. */
    extraction: z
      .object({
        enabled: z.coerce.boolean().default(false),
        endpoint: z.string().optional(),
        model: z.string().optional(),
        apiKey: z.string().optional(),
        maxFactsPerChunk: z.coerce.number().int().positive().default(8),
        /** Hard ceiling on the LLM call; if extraction times out the
         *  raw chunk still gets stored (degraded-safe, marker kept).
         *  120s, not 15-30s: measured during the Phase 6 bulk load, a
         *  short timeout aborted generations queued behind a busy vLLM
         *  and re-queued them forever — an abort storm that cut drain
         *  throughput while wasting GPU work already done. The durable
         *  facts_pending marker makes patience free. */
        timeoutMs: z.coerce.number().int().positive().default(120_000),
        /** Per-pod concurrency cap on extraction calls (semaphore). Tune
         *  so {pod_count × this} sits at or below the upstream's
         *  effective concurrency. Measured: 12/pod on 3 pods against a
         *  64-seat vLLM pool was the healthy zone; pushing to 20/pod
         *  inflated per-stream latency into the (old, shorter) timeout. */
        maxConcurrent: z.coerce.number().int().positive().default(12),
      })
      .default({ enabled: false, maxFactsPerChunk: 8, timeoutMs: 120_000, maxConcurrent: 12 })
      .refine((v) => !v.enabled || (!!v.endpoint && !!v.model), {
        message: "extraction.enabled = true requires endpoint + model",
        path: ["endpoint"],
      }),
    /** Arch-plan Phase 4: query decomposition + coherence rerank. Off by
     *  default — set NOVAMEM_QUERY_DECOMP_ENABLED=1 to opt in per request
     *  via the `decompose: true` body field. */
    queryDecomp: z
      .object({
        enabled: z.coerce.boolean().default(false),
        endpoint: z.string().optional(),
        model: z.string().optional(),
        apiKey: z.string().optional(),
        maxSubqueries: z.coerce.number().int().min(1).max(5).default(3),
        coherenceRerank: z.coerce.boolean().default(true),
        timeoutMs: z.coerce.number().int().positive().default(8_000),
      })
      .default({ enabled: false, maxSubqueries: 3, coherenceRerank: true, timeoutMs: 8_000 })
      .refine((v) => !v.enabled || (!!v.endpoint && !!v.model), {
        message: "queryDecomp.enabled = true requires endpoint + model",
        path: ["endpoint"],
      }),
    /** Vector-neighbour edges created per remember (0 disables graph
     *  enrichment entirely — useful for bulk loads). Enrichment runs
     *  async off the write path either way. */
    graphLinkFanout: z.coerce.number().int().min(0).max(10).default(3),
    /** Mem0-alignment Phase 5 EXPERIMENT: second-pass cross-encoder
     *  reranker. Off by default — set NOVAMEM_RERANK_ENABLED=1 to opt in
     *  per request via the `rerank: true` body field. Endpoint is the
     *  full URL of a Jina/Cohere-compatible /rerank service (vLLM or TEI
     *  serving e.g. BAAI/bge-reranker-v2-m3). Adopted only if it beats
     *  the Phase 4 configuration at n>=50; deleted otherwise. */
    rerank: z
      .object({
        enabled: EnvBoolean.default(false),
        endpoint: z.string().optional(),
        model: z.string().optional(),
        apiKey: z.string().optional(),
        poolMultiplier: z.coerce.number().int().min(2).max(10).default(4),
        timeoutMs: z.coerce.number().int().positive().default(5_000),
      })
      .default({ enabled: false, poolMultiplier: 4, timeoutMs: 5_000 })
      .refine((v) => !v.enabled || (!!v.endpoint && !!v.model), {
        message: "rerank.enabled = true requires endpoint + model",
        path: ["endpoint"],
      }),
    /** Arch-plan Phase 5: Observer/Reflector background distillation worker.
     *  Produces a single per-(user, project) markdown blob that callers can
     *  fetch via /v1/context-prefix. Cheaper-than-retrieval path for agents
     *  that want cacheable prompts. */
    observer: z
      .object({
        enabled: z.coerce.boolean().default(false),
        endpoint: z.string().optional(),
        model: z.string().optional(),
        apiKey: z.string().optional(),
        observeThreshold: z.coerce.number().int().positive().default(10),
        reflectThreshold: z.coerce.number().int().positive().default(50),
        timeoutMs: z.coerce.number().int().positive().default(30_000),
      })
      .default({ enabled: false, observeThreshold: 10, reflectThreshold: 50, timeoutMs: 30_000 })
      .refine((v) => !v.enabled || (!!v.endpoint && !!v.model), {
        message: "observer.enabled = true requires endpoint + model",
        path: ["endpoint"],
      }),
    decay: z.object({
      intervalMs: z.coerce.number().int().positive().default(6 * 60 * 60 * 1000),
      defaultEffectiveDays: z.coerce.number().positive().default(7),
    }),
    /** Secret used to sign Fastify cookies AND seed Better Auth's session
     *  signer. Must be operator-supplied in any non-`auth.mode=none`
     *  deployment — we refuse to start otherwise (see `loadConfig`). The
     *  dev fallback only kicks in when `auth.mode=none`, so a forgotten
     *  env var in production fails loud instead of silently accepting
     *  attacker-minted sessions. */
    cookieSecret: z.string().min(16),
    /** Bootstrap admin seeding. When both fields are set and no admin
     *  user exists yet, main.ts signs up the account via Better Auth and
     *  promotes it. Idempotent across restarts. */
    bootstrap: z
      .object({
        adminEmail: z.string().optional(),
        adminPassword: z.string().optional(),
      })
      .default({}),
    admin: z.object({
      // Master switch for the admin dashboard UI + /v1/admin/metrics route.
      // Set NOVAMEM_ADMIN_DASHBOARD=0 (or "false") to disable the surface
      // entirely. Anything else (or unset) → enabled.
      dashboard: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => {
          if (typeof v === "boolean") return v;
          const s = v.trim().toLowerCase();
          return s !== "0" && s !== "false" && s !== "no" && s !== "off";
        }),
    }).default({ dashboard: true }),
  });
export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Default mirrors the schema default ("user") so the start-up secret
  // check below treats unset as the safe-by-default mode.
  const authMode = env.NOVAMEM_AUTH_MODE ?? "user";
  const explicitSecret = env.NOVAMEM_COOKIE_SECRET;
  let cookieSecret = explicitSecret;
  if (!cookieSecret) {
    if (authMode === "none") {
      // Dev fallback: a process-lifetime random secret. Every restart
      // invalidates existing sessions — fine for `pnpm dev`, and there
      // is no shared, attacker-knowable string anywhere in the binary.
      // eslint-disable-next-line no-console
      console.warn(
        "[novamem] WARNING: NOVAMEM_COOKIE_SECRET unset — generated an ephemeral random secret " +
          "for this process. Sessions will not survive restarts. " +
          "Set NOVAMEM_COOKIE_SECRET to a 32+ char random value for any persistent deployment.",
      );
      cookieSecret = randomBytes(32).toString("base64url");
    } else {
      throw new Error(
        "NOVAMEM_COOKIE_SECRET is required when auth.mode != 'none'. " +
          "Generate one with `openssl rand -hex 32` and set it in your environment.",
      );
    }
  }
  // Derive defaults for service.baseUrl from host:port so operators
  // don't have to set NOVAMEM_BASE_URL on every dev box. Production
  // deployments behind a reverse proxy supply the public URL explicitly.
  const host = env.NOVAMEM_HOST ?? "0.0.0.0";
  const port = env.NOVAMEM_PORT ?? "7778";
  const baseUrl = env.NOVAMEM_BASE_URL ?? `http://${host}:${port}`;

  // CORS origins: empty string / "self" → same-origin only (empty array);
  // "*" → reflect-any (preserved as the literal "*" sentinel); otherwise
  // a comma-separated allowlist trimmed and filtered.
  const corsRaw = env.NOVAMEM_CORS_ORIGINS;
  let corsOrigins: string[] | undefined;
  if (corsRaw !== undefined) {
    if (corsRaw === "" || corsRaw === "self") corsOrigins = [];
    else if (corsRaw === "*") corsOrigins = ["*"];
    else corsOrigins = corsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  return ConfigSchema.parse({
    service: {
      host: env.NOVAMEM_HOST,
      port: env.NOVAMEM_PORT,
      rateLimitPerMinute: env.NOVAMEM_RATE_LIMIT_PER_MINUTE,
      logLevel: env.LOG_LEVEL,
      corsOrigins,
      // Raw string: EnvBoolean understands "1"/"true"/"yes"/"on" as well
      // as the "0"/"false"/"no"/"off" spellings an operator is likely to
      // reach for when explicitly turning this *off* in production.
      insecureCookies: env.NOVAMEM_INSECURE_COOKIES,
      baseUrl,
      pgPoolMax: env.NOVAMEM_PG_POOL_MAX,
    },
    auth: {
      mode: env.NOVAMEM_AUTH_MODE,
      token: env.NOVAMEM_AUTH_TOKEN,
    },
    warm: {
      url: env.NOVAMEM_WARM_URL ?? "postgres://novamem:novamem@localhost:5432/novamem",
    },
    cold: {
      provider: env.NOVAMEM_COLD_PROVIDER,
      url:
        env.NOVAMEM_COLD_URL ??
        (env.NOVAMEM_COLD_PROVIDER === "pgvector"
          ? env.NOVAMEM_WARM_URL ?? "postgres://novamem:novamem@localhost:5432/novamem"
          : "http://localhost:6333"),
      vectorSize: env.NOVAMEM_COLD_VECTOR_SIZE,
      timeoutMs: env.NOVAMEM_COLD_TIMEOUT_MS,
    },
    embeddings: {
      provider: env.NOVAMEM_EMBEDDINGS_PROVIDER,
      endpoint: env.NOVAMEM_EMBEDDINGS_ENDPOINT,
      model: env.NOVAMEM_EMBEDDINGS_MODEL,
      apiKey: env.NOVAMEM_EMBEDDINGS_API_KEY,
      dimensions: env.NOVAMEM_EMBEDDINGS_DIM,
      timeoutMs: env.NOVAMEM_EMBEDDINGS_TIMEOUT_MS,
      queryPrefix: env.NOVAMEM_EMBEDDINGS_QUERY_PREFIX,
      documentPrefix: env.NOVAMEM_EMBEDDINGS_DOCUMENT_PREFIX,
      reconcileIntervalMs: env.NOVAMEM_EMBEDDINGS_RECONCILE_INTERVAL_MS,
      reconcileBatchSize: env.NOVAMEM_EMBEDDINGS_RECONCILE_BATCH,
    },
    search: {
      minVectorScore: env.NOVAMEM_SEARCH_MIN_VECTOR_SCORE,
      maxContentChars: env.NOVAMEM_MAX_CONTENT_CHARS,
      personalTerms: env.NOVAMEM_PERSONAL_TERMS
        ? env.NOVAMEM_PERSONAL_TERMS.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
    },
    extraction: {
      enabled: env.NOVAMEM_EXTRACTION_ENABLED ?? false,
      endpoint: env.NOVAMEM_EXTRACTION_ENDPOINT,
      model: env.NOVAMEM_EXTRACTION_MODEL,
      apiKey: env.NOVAMEM_EXTRACTION_API_KEY,
      maxFactsPerChunk: env.NOVAMEM_EXTRACTION_MAX_FACTS,
      timeoutMs: env.NOVAMEM_EXTRACTION_TIMEOUT_MS,
      maxConcurrent: env.NOVAMEM_EXTRACTION_MAX_CONCURRENT,
    },
    queryDecomp: {
      enabled: env.NOVAMEM_QUERY_DECOMP_ENABLED ?? false,
      endpoint: env.NOVAMEM_QUERY_DECOMP_ENDPOINT,
      model: env.NOVAMEM_QUERY_DECOMP_MODEL,
      apiKey: env.NOVAMEM_QUERY_DECOMP_API_KEY,
      maxSubqueries: env.NOVAMEM_QUERY_DECOMP_MAX_SUBQUERIES,
      coherenceRerank: env.NOVAMEM_QUERY_DECOMP_COHERENCE_RERANK ?? true,
      timeoutMs: env.NOVAMEM_QUERY_DECOMP_TIMEOUT_MS,
    },
    graphLinkFanout: env.NOVAMEM_GRAPH_LINK_FANOUT,
    rerank: {
      enabled: env.NOVAMEM_RERANK_ENABLED ?? false,
      endpoint: env.NOVAMEM_RERANK_ENDPOINT,
      model: env.NOVAMEM_RERANK_MODEL,
      apiKey: env.NOVAMEM_RERANK_API_KEY,
      poolMultiplier: env.NOVAMEM_RERANK_POOL_MULTIPLIER,
      timeoutMs: env.NOVAMEM_RERANK_TIMEOUT_MS,
    },
    observer: {
      enabled: env.NOVAMEM_OBSERVER_ENABLED ?? false,
      endpoint: env.NOVAMEM_OBSERVER_ENDPOINT,
      model: env.NOVAMEM_OBSERVER_MODEL,
      apiKey: env.NOVAMEM_OBSERVER_API_KEY,
      observeThreshold: env.NOVAMEM_OBSERVER_OBSERVE_THRESHOLD,
      reflectThreshold: env.NOVAMEM_OBSERVER_REFLECT_THRESHOLD,
      timeoutMs: env.NOVAMEM_OBSERVER_TIMEOUT_MS,    },
    decay: {
      intervalMs: env.NOVAMEM_DECAY_INTERVAL_MS,
      defaultEffectiveDays: env.NOVAMEM_DECAY_DAYS,
    },
    cookieSecret,
    bootstrap: {
      adminEmail: env.NOVAMEM_BOOTSTRAP_ADMIN_EMAIL,
      adminPassword: env.NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD,
    },
    admin: {
      dashboard: env.NOVAMEM_ADMIN_DASHBOARD,
    },
  });
}
