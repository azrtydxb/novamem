/**
 * Hand-written OpenAPI 3.0 document for the novamem HTTP surface. Served
 * at /openapi.json and rendered by Swagger UI at /api-docs.
 *
 * Hand-rolled (not Zod-generated) so we keep control over examples and
 * prose. Better Auth's own surface (/api/auth/*) is documented at
 * https://www.better-auth.com/docs and is not duplicated here — this
 * spec covers only routes we own.
 */

export type OpenApiDocument = ReturnType<typeof openapiSpec>;

export function openapiSpec() {
  return {
    openapi: "3.0.3",
    info: {
      title: "novamem",
      version: "0.1.0",
      description:
        "Tiered memory service with hybrid search (keyword + vector + graph), " +
        "per-user isolation, and project-scoped sub-brains.\n\n" +
        "**Auth**: every authenticated route accepts either an `nm_…` user " +
        "bearer (created from the dashboard's API Tokens page) or a Better " +
        "Auth session cookie/bearer (set by `POST /api/auth/sign-in/email`). " +
        "Both flow through the same auth hook and resolve to the same user. " +
        "Better Auth's own routes are mounted at `/api/auth/*` — see the " +
        "Better Auth documentation for their shapes.",
      license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
    },
    servers: [{ url: "/", description: "this server" }],
    components: {
      securitySchemes: {
        UserBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "nm_…",
          description:
            "Per-device API token belonging to one user. Carries every " +
            "right the owning user has — data plane, project CRUD, " +
            "membership, metrics. Created from the dashboard's API Tokens " +
            "page; the plaintext is shown once.",
        },
        SessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "nm.session_token",
          description:
            "Better Auth session cookie set by /api/auth/sign-in/email. " +
            "HttpOnly + SameSite=Lax. Browsers attach it automatically.",
        },
      },
      schemas: {
        // ─── Memory ─────────────────────────────────────────────────────
        SearchRequest: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", minLength: 1, maxLength: 8192 },
            k: { type: "integer", minimum: 1, maximum: 100 },
            namespace: { type: "string", maxLength: 128 },
            agentName: { type: "string", maxLength: 128, nullable: true },
            project: {
              type: "string",
              nullable: true,
              description: "Project id (ULID) or human name. Omit to use the active project, falling back to user-wide entries.",
            },
            includeProjects: {
              type: "array",
              items: { type: "string" },
              maxItems: 16,
              description: "Active-project mode: union user-wide with the listed projects. Each entry may be an id or human name.",
            },
            includeNamespaces: {
              type: "array",
              items: { type: "string" },
              maxItems: 16,
              description: "Cross-namespace search: union the result across these namespace shelves.",
            },
            weights: {
              type: "object",
              properties: {
                keyword: { type: "number" },
                vector: { type: "number" },
                graph: { type: "number" },
              },
            },
          },
          example: { query: "coffee preference", k: 5, project: "Phoenix" },
        },
        SearchResult: {
          type: "object",
          properties: {
            id: { type: "string" },
            score: { type: "number" },
            content: { type: "string" },
            tier: { type: "string", enum: ["warm", "cold"] },
            namespace: { type: "string" },
            project: { type: "string", nullable: true },
            source: { type: "string" },
            sourceType: { type: "string", nullable: true },
            capturedFrom: { type: "string", nullable: true },
            confidence: { type: "number" },
            metadata: { type: "object", additionalProperties: true },
            signals: {
              type: "object",
              properties: {
                keyword: { type: "number" },
                vector: { type: "number" },
                graph: { type: "number" },
              },
            },
          },
        },
        SearchResponse: {
          type: "object",
          properties: {
            results: { type: "array", items: { $ref: "#/components/schemas/SearchResult" } },
            degraded: { type: "boolean", description: "True when the graph leg failed; results returned without graph signal." },
          },
        },
        RememberRequest: {
          type: "object",
          required: ["content"],
          properties: {
            content: { type: "string", minLength: 1, maxLength: 262144 },
            namespace: { type: "string", maxLength: 128 },
            source: { type: "string", maxLength: 128 },
            agentName: { type: "string", maxLength: 128, nullable: true },
            project: { type: "string", nullable: true, description: "Project id or human name." },
            metadata: { type: "object", additionalProperties: true },
            sourceType: {
              type: "string",
              maxLength: 64,
              description: "Open-string vocab: chat / email / code-review / doc / inference / observation / system / manual.",
            },
            capturedFrom: { type: "string", maxLength: 256 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            force: {
              type: "boolean",
              description: "Bypass the worthiness gate. Default false.",
            },
          },
          example: {
            content: "User profile: Pascal Watteel lives in Singapore.",
            sourceType: "chat",
            capturedFrom: "claude-desktop",
            confidence: 0.95,
          },
        },
        RememberResponse: {
          type: "object",
          properties: {
            id: { type: "string", nullable: true, description: "ULID of the new entry, or null when rejected by the worthiness gate." },
            rejected: { type: "string", description: "When set, explains why the gate refused the write." },
            deduplicated: { type: "boolean", description: "True when an exact duplicate already existed; the response id is the existing entry's." },
          },
        },
        UpdateMemoryRequest: {
          type: "object",
          properties: {
            content: { type: "string", minLength: 1, maxLength: 262144, description: "Omit to update only metadata-side fields without re-embedding." },
            namespace: { type: "string", maxLength: 128 },
            metadata: { type: "object", additionalProperties: true },
            sourceType: { type: "string", maxLength: 64 },
            capturedFrom: { type: "string", maxLength: 256 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            project: { type: "string", nullable: true, description: "Scope check; must match the entry's project." },
          },
        },
        UpdateMemoryResponse: {
          type: "object",
          properties: {
            id: { type: "string" },
            updated: { type: "boolean" },
            embeddingChanged: { type: "boolean" },
          },
        },
        RecentRequest: {
          type: "object",
          properties: {
            namespace: { type: "string", maxLength: 128 },
            includeNamespaces: { type: "array", items: { type: "string" }, maxItems: 16 },
            k: { type: "integer", minimum: 1, maximum: 200 },
            since: { type: "string", format: "date-time" },
            project: { type: "string", nullable: true },
            includeProjects: { type: "array", items: { type: "string" }, maxItems: 16 },
          },
        },
        NeighborsRequest: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            depth: { type: "integer", minimum: 1, maximum: 3 },
            k: { type: "integer", minimum: 1, maximum: 50 },
            project: { type: "string", nullable: true },
            includeProjects: { type: "array", items: { type: "string" }, maxItems: 16 },
            includeNamespaces: { type: "array", items: { type: "string" }, maxItems: 16 },
          },
        },
        ForgetRequest: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            project: { type: "string", nullable: true },
          },
        },
        ForgetResponse: {
          type: "object",
          properties: {
            deleted: { type: "boolean" },
            coldDeleteOk: { type: "boolean" },
          },
        },
        DecayRequest: {
          type: "object",
          properties: { effectiveDays: { type: "number" } },
        },
        DecayResponse: {
          type: "object",
          properties: { demoted: { type: "integer" }, promoted: { type: "integer" } },
        },
        DreamCycleResponse: {
          type: "object",
          properties: {
            walked: { type: "integer" },
            merged: { type: "integer" },
            edgesPromoted: { type: "integer" },
            durationMs: { type: "integer" },
          },
        },
        // ─── Projects ───────────────────────────────────────────────────
        Project: {
          type: "object",
          properties: {
            id: { type: "string", description: "ULID, server-assigned." },
            name: { type: "string" },
            ownerUserId: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        CreateProjectRequest: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1, maxLength: 128 } },
        },
        AddMemberRequest: {
          type: "object",
          required: ["username"],
          properties: {
            username: { type: "string", description: "Email or display name of the user to invite." },
            role: { type: "string", enum: ["owner", "member"] },
          },
        },
        ActiveProjectRequest: {
          type: "object",
          required: ["project"],
          properties: { project: { type: "string", description: "Project id or human name." } },
        },
        ActiveProjectResponse: {
          type: "object",
          properties: {
            active: {
              type: "object",
              nullable: true,
              properties: { id: { type: "string" }, name: { type: "string" } },
            },
          },
        },
        // ─── Tokens ─────────────────────────────────────────────────────
        MintTokenRequest: {
          type: "object",
          properties: { label: { type: "string", maxLength: 128 } },
        },
        MintTokenResponse: {
          type: "object",
          properties: {
            token: { type: "string", description: "Plaintext bearer (`nm_…`) — shown once. Server stores only the sha256 hash." },
            userId: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            warning: { type: "string" },
          },
        },
        Health: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            deps: {
              type: "object",
              properties: {
                warm: { type: "string", enum: ["ok", "unreachable"] },
                cold: { type: "string", enum: ["ok", "unreachable"] },
                graph: { type: "string", enum: ["ok", "unreachable", "disabled"] },
              },
            },
          },
        },
        Error: {
          type: "object",
          properties: { error: { type: "string" }, code: { type: "string" } },
        },
      },
    },
    paths: {
      // ─── Memory data plane ─────────────────────────────────────────
      "/v1/search": {
        post: {
          tags: ["memory"],
          summary: "Hybrid search across stored memories",
          security: [{ UserBearer: [] }, { SessionCookie: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/SearchRequest" } } },
          },
          responses: {
            "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/SearchResponse" } } } },
            "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "404": { description: "No such project", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "403": { description: "Not a member of the requested project", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/v1/remember": {
        post: {
          tags: ["memory"],
          summary: "Store a new memory entry",
          description:
            "Subject to the worthiness gate (rejects content < 12 chars or matching the conversational-filler regex unless `force: true`). Exact duplicates within the same scope return the existing id with `deduplicated: true`.",
          security: [{ UserBearer: [] }, { SessionCookie: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/RememberRequest" } } },
          },
          responses: {
            "200": { description: "Either the new entry id, a dedup hit, or a worthiness-gate rejection.", content: { "application/json": { schema: { $ref: "#/components/schemas/RememberResponse" } } } },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/v1/memories/{id}": {
        put: {
          tags: ["memory"],
          summary: "Rewrite an existing memory in place",
          description:
            "Preserves id, hit count, graph edges, and creation timestamp. Re-embeds the cold vector when `content` changes; skips the embedder when only metadata moves.",
          security: [{ UserBearer: [] }, { SessionCookie: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: false,
            content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateMemoryRequest" } } },
          },
          responses: {
            "200": { description: "Updated", content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateMemoryResponse" } } } },
            "404": { description: "No such memory in the caller's scope" },
          },
        },
      },
      "/v1/recent": {
        post: {
          tags: ["memory"],
          summary: "Newest entries, optionally filtered by namespace + since",
          security: [{ UserBearer: [] }, { SessionCookie: [] }],
          requestBody: {
            required: false,
            content: { "application/json": { schema: { $ref: "#/components/schemas/RecentRequest" } } },
          },
          responses: { "200": { description: "OK" } },
        },
      },
      "/v1/neighbors": {
        post: {
          tags: ["memory"],
          summary: "Graph-neighbour traversal from a seed memory id",
          security: [{ UserBearer: [] }, { SessionCookie: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/NeighborsRequest" } } },
          },
          responses: { "200": { description: "OK" } },
        },
      },
      "/v1/forget": {
        post: {
          tags: ["memory"],
          summary: "Delete a memory entry across warm + FTS + cold + graph",
          security: [{ UserBearer: [] }, { SessionCookie: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/ForgetRequest" } } },
          },
          responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/ForgetResponse" } } } } },
        },
      },
      "/v1/decay": {
        post: {
          tags: ["lifecycle"],
          summary: "Run the demotion pass on demand",
          security: [{ UserBearer: [] }, { SessionCookie: [] }],
          requestBody: {
            required: false,
            content: { "application/json": { schema: { $ref: "#/components/schemas/DecayRequest" } } },
          },
          responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/DecayResponse" } } } } },
        },
      },
      "/v1/dream-cycle": {
        post: {
          tags: ["lifecycle"],
          summary: "Run dedup-merge + edge-promotion compaction now",
          description:
            "The same logic runs daily on a timer. Manual trigger is useful after a bulk import or for testing. Cross-user — operates on whatever rows exist.",
          security: [{ UserBearer: [] }, { SessionCookie: [] }],
          responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/DreamCycleResponse" } } } } },
        },
      },
      "/v1/reap-orphans": {
        post: {
          tags: ["lifecycle"],
          summary: "Manually retry queued cold-store deletes",
          security: [{ UserBearer: [] }, { SessionCookie: [] }],
          responses: { "200": { description: "OK" } },
        },
      },
      "/v1/stats": {
        get: {
          tags: ["lifecycle"],
          summary: "Per-namespace counts, last decay timestamp",
          security: [{ UserBearer: [] }, { SessionCookie: [] }],
          responses: { "200": { description: "OK" } },
        },
      },
      // ─── Bearer rotation ──────────────────────────────────────────
      "/v1/auth/rotate-token": {
        post: {
          tags: ["auth"],
          summary: "Rotate the caller's nm_… bearer atomically",
          description:
            "Authed by the current bearer (sent as `Authorization: Bearer <current>`). Returns a new plaintext (shown once) and revokes the old. Only available in `user` auth mode.",
          security: [{ UserBearer: [] }],
          responses: {
            "201": { description: "New bearer minted; old one revoked." },
            "401": { description: "Unauthorized — current bearer invalid or missing." },
          },
        },
      },
      // ─── User self-service ────────────────────────────────────────
      "/v1/me/active-project": {
        get: {
          tags: ["self-service"],
          summary: "Read the caller's active project pointer",
          security: [{ SessionCookie: [] }, { UserBearer: [] }],
          responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/ActiveProjectResponse" } } } } },
        },
        put: {
          tags: ["self-service"],
          summary: "Set the caller's active project",
          security: [{ SessionCookie: [] }, { UserBearer: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/ActiveProjectRequest" } } },
          },
          responses: {
            "200": { description: "OK" },
            "403": { description: "Not a member of the requested project" },
            "404": { description: "No such project" },
          },
        },
        delete: {
          tags: ["self-service"],
          summary: "Clear the caller's active project",
          security: [{ SessionCookie: [] }, { UserBearer: [] }],
          responses: { "204": { description: "Cleared" } },
        },
      },
      "/v1/me/projects": {
        get: {
          tags: ["projects"],
          summary: "List projects the caller is a member of",
          security: [{ SessionCookie: [] }, { UserBearer: [] }],
          responses: { "200": { description: "OK" } },
        },
        post: {
          tags: ["projects"],
          summary: "Create a project; caller becomes owner",
          security: [{ SessionCookie: [] }, { UserBearer: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CreateProjectRequest" } } },
          },
          responses: {
            "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/Project" } } } },
          },
        },
      },
      "/v1/me/projects/{id}": {
        delete: {
          tags: ["projects"],
          summary: "Delete a project (owner only). Purges every memory in it.",
          security: [{ SessionCookie: [] }, { UserBearer: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Deleted" },
            "403": { description: "Caller is not the owner" },
            "404": { description: "No such project" },
          },
        },
      },
      "/v1/me/projects/{id}/members": {
        get: {
          tags: ["projects"],
          summary: "List members of a project the caller can access",
          security: [{ SessionCookie: [] }, { UserBearer: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "OK" } },
        },
        post: {
          tags: ["projects"],
          summary: "Add a member by username (owner only)",
          security: [{ SessionCookie: [] }, { UserBearer: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/AddMemberRequest" } } },
          },
          responses: { "201": { description: "Added" }, "403": { description: "Not the owner" } },
        },
      },
      "/v1/me/projects/{id}/members/{userId}": {
        delete: {
          tags: ["projects"],
          summary: "Remove a member. Owner removes anyone; member can leave themselves.",
          security: [{ SessionCookie: [] }, { UserBearer: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "userId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "Removed" } },
        },
      },
      "/v1/me/tokens": {
        get: {
          tags: ["tokens"],
          summary: "List the caller's nm_… bearers",
          security: [{ SessionCookie: [] }, { UserBearer: [] }],
          responses: { "200": { description: "OK" } },
        },
        post: {
          tags: ["tokens"],
          summary: "Mint a new nm_… bearer for the caller",
          security: [{ SessionCookie: [] }, { UserBearer: [] }],
          requestBody: {
            required: false,
            content: { "application/json": { schema: { $ref: "#/components/schemas/MintTokenRequest" } } },
          },
          responses: {
            "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/MintTokenResponse" } } } },
          },
        },
      },
      "/v1/me/tokens/{hash}": {
        delete: {
          tags: ["tokens"],
          summary: "Hard-delete a bearer by sha256 hash",
          security: [{ SessionCookie: [] }, { UserBearer: [] }],
          parameters: [{ name: "hash", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Deleted" } },
        },
      },
      "/v1/me/metrics": {
        get: {
          tags: ["metrics"],
          summary: "Operational metrics scoped to the caller",
          security: [{ SessionCookie: [] }, { UserBearer: [] }],
          responses: { "200": { description: "OK" } },
        },
      },
      "/v1/me/metrics/history": {
        get: {
          tags: ["metrics"],
          summary: "Persistent throughput history (1-min buckets)",
          security: [{ SessionCookie: [] }, { UserBearer: [] }],
          parameters: [
            {
              name: "hours",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 48, default: 24 },
            },
          ],
          responses: { "200": { description: "OK" } },
        },
      },
      // /v1/me/{search,remember,recent,neighbors,forget,memories/:id}
      // mirror the data-plane shapes exactly; documented under their /v1/*
      // counterparts. They exist so cookie-authenticated dashboard SPAs
      // can hit them without sending Authorization.
      // ─── Admin ────────────────────────────────────────────────────
      "/v1/admin/audit-log": {
        get: {
          tags: ["admin"],
          summary: "All admin actions, newest first",
          security: [{ SessionCookie: [] }],
          responses: {
            "200": { description: "OK" },
            "401": { description: "Unauthorized — requires role=admin" },
          },
        },
      },
      "/v1/admin/metrics": {
        get: {
          tags: ["admin"],
          summary: "Global operational metrics snapshot (in-process; resets on restart)",
          security: [{ SessionCookie: [] }],
          responses: { "200": { description: "OK" } },
        },
      },
      "/v1/admin/metrics/prom": {
        get: {
          tags: ["admin"],
          summary: "Same as /v1/admin/metrics in Prometheus exposition format",
          security: [{ SessionCookie: [] }],
          responses: { "200": { description: "text/plain; version=0.0.4" } },
        },
      },
      // ─── Liveness ─────────────────────────────────────────────────
      "/health": {
        get: {
          tags: ["liveness"],
          summary: "Liveness + dependency snapshot",
          responses: {
            "200": { description: "Up", content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } } },
            "503": { description: "A dependency is unreachable" },
          },
        },
      },
    },
    tags: [
      { name: "memory", description: "Read/write the memory data plane" },
      { name: "lifecycle", description: "Decay, dream cycle, orphan reaper, stats" },
      { name: "auth", description: "Rotate `nm_…` bearers (Better Auth's own surface lives at /api/auth/*)" },
      { name: "self-service", description: "Per-caller settings (active project)" },
      { name: "projects", description: "Project CRUD + membership" },
      { name: "tokens", description: "Per-device `nm_…` bearer management" },
      { name: "metrics", description: "Per-user metrics + 24h history" },
      { name: "admin", description: "Admin-only endpoints (role=admin)" },
      { name: "liveness", description: "Health checks" },
    ],
  };
}
