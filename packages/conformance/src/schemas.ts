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

/** POST /v1/capture response (201). Same worthiness-gate shape as
 *  RememberResponse (`id: null` + `rejected` on a gate reject), plus the
 *  contradiction/supersede fields unique to `capture()`. */
export const CaptureResponse = z
  .object({
    id: z.string().nullable(),
    rejected: z.string().optional(),
    deduplicated: z.boolean().optional(),
    updated: z.boolean().optional(),
    superseded: z.array(z.string()).optional(),
    embedded: z.boolean().optional(),
  })
  .passthrough();

/** POST /v1/session-recap response (201). */
export const SessionRecapResponse = z
  .object({
    saved: z.number(),
    results: z.array(CaptureResponse),
  })
  .passthrough();

/** POST /v1/hygiene response (200). */
export const HygieneResponse = z
  .object({
    summary: z
      .object({
        scanned: z.number(),
        lowValue: z.number(),
        stale: z.number(),
        duplicateClusters: z.number(),
        contradictionCandidates: z.number(),
        orphanCandidates: z.number(),
      })
      .passthrough(),
    lowValue: z.array(z.unknown()),
    stale: z.array(z.unknown()),
    duplicateClusters: z.array(z.unknown()),
    contradictionCandidates: z.array(z.unknown()),
    orphanCandidates: z.array(z.unknown()),
  })
  .passthrough();

/** POST /v1/evaluate response (200). */
export const EvaluateResponse = z
  .object({
    suite: z.string(),
    passed: z.boolean(),
    summary: z.object({ total: z.number(), passed: z.number(), failed: z.number() }).passthrough(),
    cases: z.array(z.object({ name: z.string(), passed: z.boolean() }).passthrough()),
  })
  .passthrough();

/** POST /v1/decay response (200, operator-only). */
export const DecayResponse = z
  .object({ demoted: z.number(), promoted: z.number(), expired: z.number() })
  .passthrough();

/** POST /v1/dream-cycle response (200, operator-only). */
export const DreamCycleResponse = z
  .object({
    walked: z.number(),
    merged: z.number(),
    edgesPromoted: z.number(),
    factsWalked: z.number(),
    factClustersJudged: z.number(),
    factsSuperseded: z.number(),
    durationMs: z.number(),
  })
  .passthrough();

/** POST /v1/reap-orphans response (200, operator-only). */
export const ReapOrphansResponse = z
  .object({
    attempted: z.number(),
    cleared: z.number(),
    abandoned: z.number(),
    pending: z.number(),
    total: z.number(),
  })
  .passthrough();

/** POST /v1/observe response (200, operator-only): `{observed, reflected,
 *  logChars}` when the observer is enabled server-side; the route answers
 *  503 `{error}` instead when it's disabled. */
export const ObserveResponse = z
  .object({ observed: z.number(), reflected: z.boolean(), logChars: z.number() })
  .passthrough();
