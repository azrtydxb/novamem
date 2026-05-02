/**
 * Service configuration. Loaded from env vars by `loadConfig()`. A YAML loader
 * can layer on top later — env-only is the simplest sensible default and
 * matches the docker-compose deployment.
 */

import { z } from "zod";

export const ConfigSchema = z
  .object({
    service: z.object({
      host: z.string().default("0.0.0.0"),
      port: z.coerce.number().int().min(1).max(65_535).default(5_000),
      rateLimitPerMinute: z.coerce.number().int().positive().default(600),
    }),
    auth: z
      .object({
        mode: z.enum(["none", "bearer"]).default("none"),
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
    }),
    graph: z
      .object({
        enabled: z.coerce.boolean().default(true),
        url: z.string().optional(),
      })
      .default({ enabled: true })
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
    }),
    decay: z.object({
      intervalMs: z.coerce.number().int().positive().default(6 * 60 * 60 * 1000),
      defaultEffectiveDays: z.coerce.number().positive().default(7),
    }),
  });
export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    service: {
      host: env.NOVAMEM_HOST,
      port: env.NOVAMEM_PORT,
      rateLimitPerMinute: env.NOVAMEM_RATE_LIMIT_PER_MINUTE,
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
    },
    graph: {
      enabled: env.NOVAMEM_GRAPH_ENABLED ?? "true",
      url: env.NOVAMEM_GRAPH_URL ?? "redis://localhost:6379",
    },
    embeddings: {
      provider: env.NOVAMEM_EMBEDDINGS_PROVIDER,
      endpoint: env.NOVAMEM_EMBEDDINGS_ENDPOINT,
      model: env.NOVAMEM_EMBEDDINGS_MODEL,
      apiKey: env.NOVAMEM_EMBEDDINGS_API_KEY,
      dimensions: env.NOVAMEM_EMBEDDINGS_DIM,
    },
    decay: {
      intervalMs: env.NOVAMEM_DECAY_INTERVAL_MS,
      defaultEffectiveDays: env.NOVAMEM_DECAY_DAYS,
    },
  });
}
