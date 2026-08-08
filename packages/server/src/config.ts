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
      url: z.string(),
      vectorSize: z.coerce.number().int().positive().default(384),
      /** Per-request Qdrant timeout in ms. */
      timeoutMs: z.coerce.number().int().positive().default(15_000),
    }),
    graph: z
      .object({
        // NOT `z.coerce.boolean()`: that is JS truthiness, under which the
        // *string* "false" (and "0", and "no") is `true`. Operators who
        // set NOVAMEM_GRAPH_ENABLED=false got a fully enabled graph that
        // then tried to reach redis://localhost:6379, marked every search
        // `degraded`, and warn-spammed — the exact opposite of the
        // documented behaviour. Parse env-style booleans explicitly, the
        // way `admin.dashboard` below already did.
        enabled: EnvBoolean.default(true),
        url: z.string().optional(),
        /** Per-query FalkorDB timeout in ms. */
        queryTimeoutMs: z.coerce.number().int().positive().default(10_000),
      })
      .default({ enabled: true, queryTimeoutMs: 10_000 })
      .refine((v) => !v.enabled || !!v.url, {
        message: "graph.enabled = true requires graph.url (NOVAMEM_GRAPH_URL)",
        path: ["url"],
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
      url: env.NOVAMEM_COLD_URL ?? "http://localhost:6333",
      vectorSize: env.NOVAMEM_COLD_VECTOR_SIZE,
      timeoutMs: env.NOVAMEM_COLD_TIMEOUT_MS,
    },
    graph: {
      enabled: env.NOVAMEM_GRAPH_ENABLED ?? "true",
      url: env.NOVAMEM_GRAPH_URL ?? "redis://localhost:6379",
      queryTimeoutMs: env.NOVAMEM_GRAPH_TIMEOUT_MS,
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
    },
    search: {
      minVectorScore: env.NOVAMEM_SEARCH_MIN_VECTOR_SCORE,
      maxContentChars: env.NOVAMEM_MAX_CONTENT_CHARS,
      personalTerms: env.NOVAMEM_PERSONAL_TERMS
        ? env.NOVAMEM_PERSONAL_TERMS.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
    },
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
