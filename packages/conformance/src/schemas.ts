import { z } from "zod";

/**
 * Transcribed from live oracle responses + `packages/server/src/engine/index.ts`
 * and `packages/server/src/routes/schemas.ts` (read-only reference, never
 * imported). Loose on purpose: `.passthrough()` everywhere, assert only the
 * fields later suites can rely on.
 */

/** Shape of an item in `results` from /v1/recent (and /v1/search,
 *  /v1/neighbors, /v1/context — same `SearchResult` engine type). */
export const MemoryEntry = z
  .object({
    id: z.string().min(1),
    content: z.string(),
    namespace: z.string().optional(),
    project: z.string().nullable().optional(),
    tier: z.enum(["warm", "cold"]).optional(),
    source: z.string().optional(),
    score: z.number().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/** Generic `{ error: string }` response used across the API for 4xx/5xx. */
export const ErrorBody = z.object({ error: z.string() }).passthrough();

/** POST /v1/remember response (201). `id` is null when the worthiness gate
 *  rejects the content and `force` wasn't set. */
export const RememberResponse = z
  .object({
    id: z.string().nullable(),
    rejected: z.string().optional(),
    deduplicated: z.boolean().optional(),
    embedded: z.boolean().optional(),
  })
  .passthrough();

/** POST /v1/recent response (200). */
export const RecentResponse = z
  .object({
    results: z.array(MemoryEntry),
  })
  .passthrough();

/** PUT /v1/memories/{id} response (200): `{ id, updated, embeddingChanged }`. */
export const UpdateMemoryResponse = z
  .object({
    id: z.string(),
    updated: z.boolean(),
    embeddingChanged: z.boolean(),
  })
  .passthrough();

/** POST /v1/forget response (200): `{ deleted, coldDeleteOk }`. */
export const ForgetResponse = z
  .object({
    deleted: z.boolean(),
    coldDeleteOk: z.boolean(),
  })
  .passthrough();

/** GET /v1/stats response (200). */
export const StatsResponse = z
  .object({
    byNamespace: z.record(z.string(), z.object({ warm: z.number(), cold: z.number() }).passthrough()),
    totalWarm: z.number(),
    totalCold: z.number(),
    lastDecayAt: z.string().nullable(),
    uptimeMs: z.number(),
  })
  .passthrough();
