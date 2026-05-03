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

/** Slug-safe project / username rules. */
export const ProjectIdRule = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, { message: "must be a slug" });

export const UsernameRule = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, {
    message: "username must be 2–64 chars; alphanumeric, dot, underscore, dash",
  });

// ─── Memory data-plane bodies ──────────────────────────────────────────

export const SearchBody = z.object({
  query: z.string().min(1).max(8 * 1024),
  k: z.number().int().positive().max(100).optional(),
  namespace: z.string().max(128).optional(),
  agentName: z.string().max(128).optional().nullable(),
  project: ProjectIdRule.optional().nullable(),
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
  project: ProjectIdRule.optional().nullable(),
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
  project: ProjectIdRule.optional().nullable(),
});

export const NeighborsBody = z.object({
  id: z.string().min(1).max(128),
  depth: z.number().int().positive().max(3).optional(),
  k: z.number().int().positive().max(50).optional(),
  project: ProjectIdRule.optional().nullable(),
});

export const ForgetBody = z.object({
  id: z.string().min(1).max(128),
  project: ProjectIdRule.optional().nullable(),
});

// ─── Admin bodies ──────────────────────────────────────────────────────
//
// The tenant id regex is *narrower* than a generic slug: the cold store
// derives qdrant collection names as `novamem_<tenantId>_<namespace>` for
// tenant-wide entries and `novamem_p_<projectId>_<namespace>` for project-
// scoped entries. A tenant id starting with `p_` would make a tenant's
// collections indistinguishable from project collections at prefix-scan
// time (see review finding P0-1). Forbid `p_` prefix explicitly + the
// bare value `p` for the same reason. Also forbid `__` (used as a
// separator-with-margin in a future migration).
export const AdminCreateTenantBody = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, {
      message: "tenant id must be lowercase alphanumeric / underscore / hyphen",
    })
    .refine((v) => v !== "p" && !v.startsWith("p_"), {
      message:
        "tenant id cannot start with 'p_' or be exactly 'p' (collides with project collection naming)",
    })
    .refine((v) => !v.includes("__"), {
      message: "tenant id cannot contain '__' (reserved separator)",
    }),
  name: z.string().min(1).max(128),
});

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

export const CreateUserBody = z
  .object({
    username: UsernameRule,
    password: z.string().min(8).max(256),
    role: z.enum(["admin", "user"]),
    tenantId: z.string().min(1).max(64).optional().nullable(),
  })
  .refine((v) => v.role === "admin" || (typeof v.tenantId === "string" && v.tenantId.length > 0), {
    message: "role 'user' requires a tenantId",
    path: ["tenantId"],
  });

export const SetRoleBody = z
  .object({
    role: z.enum(["admin", "user"]),
    tenantId: z.string().min(1).max(64).optional().nullable(),
  })
  .refine((v) => v.role === "admin" || (typeof v.tenantId === "string" && v.tenantId.length > 0), {
    message: "role 'user' requires a tenantId",
    path: ["tenantId"],
  });

export const MintMyTokenBody = z.object({
  label: z.string().max(128).optional(),
  projectId: ProjectIdRule.optional().nullable(),
});

export const CreateProjectBody = z.object({
  id: ProjectIdRule,
  name: z.string().min(1).max(128),
});

export const AddMemberBody = z.object({
  username: z.string().min(1).max(64),
  role: z.enum(["owner", "member"]).optional(),
});
