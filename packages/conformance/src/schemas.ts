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

/** POST /v1/me/projects response (201): `{id, name, ownerUserId, createdAt}`. */
export const ProjectResponse = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    ownerUserId: z.string(),
    createdAt: z.string(),
  })
  .passthrough();

/** GET /v1/me/active-project response (200): `{active: {id, name?} | null}`. */
export const ActiveProjectResponse = z
  .object({ active: z.object({ id: z.string(), name: z.string().optional() }).nullable() })
  .passthrough();

/** GET /v1/me/today response (200). */
export const TodayResponse = z
  .object({
    events: z.array(
      z
        .object({
          kind: z.enum(["remember", "token", "project", "audit"]),
          at: z.string(),
          text: z.string(),
          project: z.string().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** GET /v1/me/onboarding response (200). */
export const OnboardingResponse = z
  .object({
    bootstrapDone: z.boolean(),
    userExists: z.boolean(),
    mintedToken: z.boolean(),
    remembered: z.boolean(),
    userId: z.string().nullable(),
  })
  .passthrough();

/** GET /v1/me/metrics/history response (200): `{hours, samples: [...]}`. */
export const MetricsHistoryResponse = z
  .object({
    hours: z.number(),
    samples: z.array(
      z.object({ sampledAt: z.string(), queries: z.number(), remembers: z.number() }).passthrough(),
    ),
  })
  .passthrough();

/** GET /v1/me/tokens response (200): `{tokens: [...]}`. */
export const TokenListResponse = z
  .object({ tokens: z.array(z.record(z.string(), z.unknown())) })
  .passthrough();

/** POST /v1/me/tokens response (201). */
export const MintTokenResponse = z
  .object({
    token: z.string(),
    userId: z.string(),
    createdAt: z.string(),
    scope: z.string(),
    projectId: z.string().nullable(),
    expiresAt: z.string().nullable(),
    warning: z.string(),
  })
  .passthrough();

/** GET /v1/me/projects/{id}/members response (200). */
export const MembersResponse = z
  .object({
    members: z.array(
      z
        .object({ userId: z.string(), username: z.string(), role: z.string(), joinedAt: z.string() })
        .passthrough(),
    ),
  })
  .passthrough();

/** GET /v1/me/usage response (200): `{entries, quota: {maxEntries, writesPerMinute}}`. */
export const UsageResponse = z
  .object({
    entries: z.number(),
    quota: z
      .object({
        maxEntries: z.number().nullable(),
        writesPerMinute: z.number().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

/** GET /v1/me/changes response (200): `{changes: [...], nextSeq}`. */
export const ChangesResponse = z
  .object({
    changes: z.array(
      z
        .object({
          seq: z.number(),
          entryId: z.string(),
          projectId: z.string().nullable(),
          change: z.enum(["created", "updated", "superseded", "deleted", "expired"]),
          detail: z.record(z.string(), z.unknown()).nullable(),
          at: z.string(),
        })
        .passthrough(),
    ),
    nextSeq: z.number().nullable(),
  })
  .passthrough();

/** GET /v1/me/export response (200): `{entries: [...], nextAfterId}`. */
export const ExportResponse = z
  .object({
    entries: z.array(
      z
        .object({
          id: z.string(),
          projectId: z.string().nullable(),
          content: z.string(),
          namespace: z.string(),
          source: z.string(),
          createdAt: z.string(),
          updatedAt: z.string(),
        })
        .passthrough(),
    ),
    nextAfterId: z.string().nullable(),
  })
  .passthrough();

/** POST /v1/me/import response (201 fully/partially imported, 400 all
 *  entries failed): `{imported, deduplicated, failed: [{index, error}]}`. */
export const ImportResponse = z
  .object({
    imported: z.number(),
    deduplicated: z.number(),
    failed: z.array(z.object({ index: z.number(), error: z.string() }).passthrough()),
  })
  .passthrough();

/** GET /v1/admin/users row shape (part of AdminUsersResponse below). */
export const AdminUserRow = z
  .object({
    id: z.string().min(1),
    email: z.string(),
    name: z.string().nullable().optional(),
    role: z.enum(["admin", "user"]),
    createdAt: z.string(),
    entryCount: z.number(),
    tokenCount: z.number(),
  })
  .passthrough();

/** GET /v1/admin/users response (200). */
export const AdminUsersResponse = z.object({ users: z.array(AdminUserRow) }).passthrough();

/** POST /v1/admin/users response (201): `{userId, email, token?}` — `token`
 *  is only present when the request included `tokenLabel`. */
export const AdminCreateUserResponse = z
  .object({
    userId: z.string().min(1),
    email: z.string(),
    token: z.string().optional(),
  })
  .passthrough();

/** DELETE /v1/admin/users/{id} response (200, `dryRun` unset):
 *  `{deleted, entriesRemoved, tokensRemoved, projectsDeleted, coldCleanupOk}`. */
export const AdminDeleteUserResponse = z
  .object({
    deleted: z.boolean(),
    entriesRemoved: z.number(),
    tokensRemoved: z.number(),
    projectsDeleted: z.array(z.unknown()),
    coldCleanupOk: z.boolean(),
  })
  .passthrough();

/** PUT /v1/admin/users/{id}/quota response (200, transcribed from
 *  `feat/user-quotas`'s `admin.ts` — this worktree's checked-out admin
 *  route file predates the route entirely): `{userId, quota}`. */
export const AdminQuotaResponse = z
  .object({
    userId: z.string(),
    quota: z
      .object({
        maxEntries: z.number().nullable(),
        writesPerMinute: z.number().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

/** POST /v1/admin/tokens/revoke response (200): `{revoked: boolean}`. */
export const AdminRevokeResponse = z.object({ revoked: z.boolean() }).passthrough();

/** GET /v1/admin/audit-log entry + response shapes. */
export const AdminAuditLogEntry = z
  .object({
    id: z.number(),
    ts: z.string(),
    actorUserId: z.string().nullable(),
    actorLabel: z.string(),
    action: z.string(),
    target: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    requestIp: z.string().nullable(),
  })
  .passthrough();

export const AdminAuditLogResponse = z
  .object({ entries: z.array(AdminAuditLogEntry) })
  .passthrough();

/** GET /v1/admin/health/deep response (200/503): per-dependency snapshot. */
export const AdminHealthDeepResponse = z
  .object({
    ok: z.boolean(),
    deps: z
      .object({
        warm: z.enum(["ok", "unreachable"]),
        cold: z.enum(["ok", "unreachable"]),
        graph: z.enum(["ok", "unreachable", "disabled"]),
        embedder: z.enum(["ok", "failing"]),
      })
      .passthrough(),
    pendingEmbeddings: z.number().nullable(),
  })
  .passthrough();
