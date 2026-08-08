/**
 * Zod request-body schemas for the HTTP layer. Centralised here so:
 *  - tests can import them to assert structural shape
 *  - @fastify/swagger derives the live OpenAPI document from them
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
// Homoglyph hardening (issue #23): NFKC-normalise before the charset
// check so visually-confusable Unicode (e.g. Cyrillic "\u0410" masquerading
// as Latin "A") collapses to its canonical form before validation. The
// route layer's resolveProjectRef remains the actual access boundary.
export const ProjectRefRule = z
  .string()
  .min(1)
  .max(128)
  .transform((s) => s.normalize("NFKC"))
  .pipe(
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\x21-\x7e \u0080-\uffff]+$/, {
        message: "project ref contains control characters",
      }),
  );

export const UsernameRule = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, {
    message: "username must be 2–64 chars; alphanumeric, dot, underscore, dash",
  });

// ─── Memory data-plane bodies ──────────────────────────────────────────

/** Namespace shelf names. Same charset discipline as project ids: the
 *  value is opaque to the engine but it *is* concatenated into Qdrant
 *  collection names, so control characters, whitespace and slashes have
 *  no business here even though the `u_`/`p_` prefixes already make
 *  cross-tenant collisions structurally impossible. */
const NamespaceRule = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/i, {
    message:
      "namespace must start alphanumeric and contain only letters, digits, dot, colon, underscore, or dash",
  });
export const SensitivityRule = z.enum(["public", "internal", "private", "sensitive"]);

/** Hard caps on caller-supplied metadata bags (issue #23):
 *  - keys must be ≤64 chars (rejects pathological long keys that would
 *    bloat JSONB indexes / FTS payloads).
 *  - serialized JSON must be ≤8KB (write-authorised callers could
 *    otherwise pile huge per-row blobs given the global 2MB body cap). */
const MAX_METADATA_KEY_LEN = 64;
const MAX_METADATA_BYTES = 8 * 1024;
const MetadataRule = z
  .record(z.string(), z.unknown())
  .refine((v) => Object.keys(v).every((k) => k.length <= MAX_METADATA_KEY_LEN), {
    message: `metadata key too long (${MAX_METADATA_KEY_LEN}-char max)`,
  })
  .refine((v) => JSON.stringify(v).length <= MAX_METADATA_BYTES, {
    message: "metadata too large (8KB max)",
  });

export const SessionRecapBody = z.object({
  decisions: z.array(z.string().min(12).max(4000)).optional(),
  setupFacts: z.array(z.string().min(12).max(4000)).optional(),
  rootCauses: z.array(z.string().min(12).max(4000)).optional(),
  preferences: z.array(z.string().min(12).max(4000)).optional(),
  projectConventions: z.array(z.string().min(12).max(4000)).optional(),
  safetyConstraints: z.array(z.string().min(12).max(4000)).optional(),
  other: z.array(z.string().min(12).max(4000)).optional(),
  namespace: z.string().min(1).max(128).optional(),
  source: z.string().min(1).max(256).optional(),
  sourceType: z.string().min(1).max(64).optional(),
  capturedFrom: z.string().min(1).max(256).optional(),
  agentName: z.string().max(128).optional().nullable(),
  confidence: z.number().min(0).max(1).optional(),
  force: z.boolean().optional(),
  project: ProjectRefRule.optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  sensitivity: SensitivityRule.optional(),
}).strict();

export const MAX_SEARCH_K = 200;

export const SearchBody = z.object({
  query: z.string().min(1).max(8 * 1024),
  k: z.number().int().positive().max(MAX_SEARCH_K).optional(),
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
      recency: z.number().optional(),
      entity: z.number().optional(),
    })
    .optional(),
  maxSensitivity: SensitivityRule.optional(),
  asOf: z.string().datetime().optional().nullable(),
  decompose: z.boolean().optional(),
  expandSourceChunks: z.boolean().optional(),
});

export const ContextBody = z.object({
  /** The user's current message / task. Used as the relevance query. */
  message: z.string().min(1).max(8 * 1024),
  k: z.number().int().positive().max(50).optional(),
  namespace: z.string().max(128).optional(),
  project: ProjectRefRule.optional().nullable(),
  includeProjects: z.array(ProjectRefRule).max(16).optional(),
  includeNamespaces: z.array(NamespaceRule).max(16).optional(),
  weights: z
    .object({
      keyword: z.number().optional(),
      vector: z.number().optional(),
      graph: z.number().optional(),
      recency: z.number().optional(),
      entity: z.number().optional(),
    })
    .optional(),
  maxSensitivity: SensitivityRule.optional(),
  asOf: z.string().datetime().optional().nullable(),
  decompose: z.boolean().optional(),
  expandSourceChunks: z.boolean().optional(),
});


export const AdoptionBody = z.object({
  client: z.string().max(64).optional(),
  observedTools: z.array(z.string().min(1).max(128)).max(128).optional(),
  observedInstructionsHash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
}).strict();

export const HygieneBody = z.object({
  k: z.number().int().positive().max(100).optional(),
}).strict();

export const EvaluateBody = z.object({
  suite: z.string().min(1).max(64).optional(),
}).strict();

export const CaptureBody = z.object({
  /** One self-contained durable fact to store. */
  content: z.string().min(1).max(MAX_CONTENT_BYTES),
  namespace: z.string().max(128).optional(),
  source: z.string().max(128).optional(),
  agentName: z.string().max(128).optional().nullable(),
  project: ProjectRefRule.optional().nullable(),
  metadata: MetadataRule.optional(),
  sensitivity: SensitivityRule.optional(),
  sourceType: z.string().max(64).optional(),
  capturedFrom: z.string().max(256).optional(),
  confidence: z.number().min(0).max(1).optional(),
  force: z.boolean().optional(),
});

export const RememberBody = z.object({
  content: z.string().min(1).max(MAX_CONTENT_BYTES),
  namespace: z.string().max(128).optional(),
  source: z.string().max(128).optional(),
  agentName: z.string().max(128).optional().nullable(),
  project: ProjectRefRule.optional().nullable(),
  metadata: MetadataRule.optional(),
  sensitivity: SensitivityRule.optional(),
  // Provenance fields. Open-string vocab; recommended values documented
  // in the MCP instructions block.
  sourceType: z.string().max(64).optional(),
  capturedFrom: z.string().max(256).optional(),
  confidence: z.number().min(0).max(1).optional(),
  // Bypass for the worthiness gate. Default false.
  force: z.boolean().optional(),
});

export const UpdateMemoryBody = z.object({
  content: z.string().min(1).max(MAX_CONTENT_BYTES).optional(),
  namespace: z.string().max(128).optional(),
  metadata: MetadataRule.optional(),
  sensitivity: SensitivityRule.optional(),
  sourceType: z.string().max(64).optional(),
  capturedFrom: z.string().max(256).optional(),
  confidence: z.number().min(0).max(1).optional(),
  project: ProjectRefRule.optional().nullable(),
});

export const DecayBody = z.object({
  effectiveDays: z.number().positive().optional(),
});

export const RecentBody = z.object({
  namespace: z.string().max(128).optional(),
  k: z.number().int().positive().max(200).optional(),
  /** ISO-8601 lower bound. Validated here so an invalid string doesn't
   *  reach the SQL layer. */
  since: z
    .string()
    .datetime({ offset: true, message: "since must be ISO-8601 (e.g. 2026-05-02T17:00:00Z)" })
    .optional(),
  project: ProjectRefRule.optional().nullable(),
  includeProjects: z.array(ProjectRefRule).max(16).optional(),
  includeNamespaces: z.array(NamespaceRule).max(16).optional(),
  maxSensitivity: SensitivityRule.optional(),
});

export const NeighborsBody = z.object({
  id: z.string().min(1).max(128),
  depth: z.number().int().positive().max(3).optional(),
  k: z.number().int().positive().max(50).optional(),
  project: ProjectRefRule.optional().nullable(),
  includeProjects: z.array(ProjectRefRule).max(16).optional(),
  includeNamespaces: z.array(NamespaceRule).max(16).optional(),
  maxSensitivity: SensitivityRule.optional(),
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
  /** @deprecated Legacy display handle kept for back-compat with older
   *  clients. New code uses `email` via Better Auth's
   *  /api/auth/sign-in/email; this body shape is retained only for the
   *  pre-Better-Auth login surface. */
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export const CreateUserBody = z.object({
  /** @deprecated Legacy display handle kept for back-compat; new code
   *  uses `email` (Better Auth derives the display username from the
   *  email's local-part on first sign-in). */
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

export const ActiveProjectBody = z.object({
  project: ProjectRefRule,
});

export const AddMemberBody = z.object({
  /** @deprecated Legacy display handle kept for back-compat; new code
   *  uses `email` to identify the invitee. The route layer resolves
   *  this against the users table for membership operations. */
  username: z.string().min(1).max(64),
  role: z.enum(["owner", "member"]).optional(),
});

export const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
});
