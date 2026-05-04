/**
 * Zod request-body schemas for the HTTP layer. Centralised here so:
 *  - tests can import them to assert structural shape
 *  - the OpenAPI generator can be derived from them in the future
 *    (currently the OpenAPI doc is hand-rolled in openapi.ts)
 *  - the MCP shim can use them to validate tool args
 *
 * All schemas use `.strict()` where appropriate — extra fields are
 * rejected so a typo in a body field doesn't silently get ignored.
 */
import { z } from "zod";

/** Hard cap on stored content size — prevents a single oversized POST
 *  from exhausting memory or the DB row size limit. ~256KB is plenty
 *  for any reasonable memory entry. */
export const MAX_CONTENT_BYTES = 256 * 1024;

/** Project ids are server-assigned ULIDs (26-char Crockford base32) but
 *  the wire schema accepts any short string — clients may have older ids
 *  or test fixtures. The membership check at the route layer is the real
 *  access boundary; this is just a length / character-class sanity gate. */
export const ProjectIdRule = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, { message: "project id contains invalid characters" });

/** Body-field validator for any place a caller may pass *either* a project
 *  id (ULID) or a human name. Keeps a hard upper bound (128 chars) and
 *  rejects control characters but is otherwise permissive — names like
 *  "MCP Bearer Test" with spaces must be accepted. The route layer's
 *  resolveProjectRef does the actual existence + membership checks. */
// eslint-disable-next-line no-control-regex
const _NO_CTRL = /^[^\x00-\x1f\x7f]+$/;
export const ProjectRefRule = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e \u0080-\uffff]+$/, { message: "project ref contains control characters" });

export const UsernameRule = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, {
    message: "username must be 2–64 chars; alphanumeric, dot, underscore, dash",
  });

// ─── Memory data-plane bodies ──────────────────────────────────────────

/** Namespace shelf names. Same charset as project ids — we accept
 *  reasonably-shaped strings; the value is opaque to the engine. */
const NamespaceRule = z.string().min(1).max(128);

export const SearchBody = z.object({
  query: z.string().min(1).max(8 * 1024),
  k: z.number().int().positive().max(100).optional(),
  namespace: z.string().max(128).optional(),
  agentName: z.string().max(128).optional().nullable(),
  project: ProjectRefRule.optional().nullable(),
  /** Active-project mode: merge results from the caller's user-global
   *  store with the listed projects (membership enforced at the route
   *  layer). Capped at 16 to bound the per-request fan-out. */
  includeProjects: z.array(ProjectRefRule).max(16).optional(),
  /** Cross-namespace mode: union the search across these namespace
   *  shelves instead of just `namespace` (or "default"). Capped at 16
   *  for the same fanout-budget reason as includeProjects. */
  includeNamespaces: z.array(NamespaceRule).max(16).optional(),
  weights: z
    .object({
      keyword: z.number().optional(),
      vector: z.number().optional(),
      graph: z.number().optional(),
    })
    .optional(),
});

export const RememberBody = z.object({
  content: z.string().min(1).max(MAX_CONTENT_BYTES),
  namespace: z.string().max(128).optional(),
  source: z.string().max(128).optional(),
  agentName: z.string().max(128).optional().nullable(),
  project: ProjectRefRule.optional().nullable(),
  // Zod 4: `z.record(...)` now requires both key + value schemas.
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const DecayBody = z.object({
  effectiveDays: z.number().positive().optional(),
});

export const RecentBody = z.object({
  namespace: z.string().max(128).optional(),
  k: z.number().int().positive().max(200).optional(),
  /** ISO-8601 lower bound. Validated here so an invalid string doesn't
   *  reach the SQL layer (review finding P2-14). */
  since: z
    .string()
    .datetime({ offset: true, message: "since must be ISO-8601 (e.g. 2026-05-02T17:00:00Z)" })
    .optional(),
  project: ProjectRefRule.optional().nullable(),
  includeProjects: z.array(ProjectRefRule).max(16).optional(),
  includeNamespaces: z.array(NamespaceRule).max(16).optional(),
});

export const NeighborsBody = z.object({
  id: z.string().min(1).max(128),
  depth: z.number().int().positive().max(3).optional(),
  k: z.number().int().positive().max(50).optional(),
  project: ProjectRefRule.optional().nullable(),
  includeProjects: z.array(ProjectRefRule).max(16).optional(),
  includeNamespaces: z.array(NamespaceRule).max(16).optional(),
});

export const ForgetBody = z.object({
  id: z.string().min(1).max(128),
  project: ProjectRefRule.optional().nullable(),
});

// ─── Admin bodies ──────────────────────────────────────────────────────

export const AdminCreateTokenBody = z.object({
  label: z.string().max(128).optional(),
});

export const AdminRevokeBody = z.object({
  token: z.string().min(1).max(256),
});

// ─── Auth + user-management bodies ──────────────────────────────────────

export const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export const CreateUserBody = z.object({
  username: UsernameRule,
  password: z.string().min(8).max(256),
  role: z.enum(["admin", "user"]),
});

export const SetRoleBody = z.object({
  role: z.enum(["admin", "user"]),
});

export const MintMyTokenBody = z.object({
  label: z.string().max(128).optional(),
});

export const CreateProjectBody = z.object({
  // Project ids are server-assigned ULIDs — clients send only the name.
  name: z.string().min(1).max(128),
});

export const AddMemberBody = z.object({
  username: z.string().min(1).max(64),
  role: z.enum(["owner", "member"]).optional(),
});

export const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
});
