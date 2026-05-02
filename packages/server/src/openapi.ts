/**
 * Hand-written OpenAPI 3.0 document for the novamem HTTP surface. Served
 * at /openapi.json and rendered by Swagger UI at /api-docs.
 *
 * We don't auto-generate from Zod schemas (would need fastify-type-provider-
 * zod and a wholesale route refactor); a hand-rolled spec is small enough
 * to maintain and gives us full control over examples and prose.
 */

export type OpenApiDocument = ReturnType<typeof openapiSpec>;

export function openapiSpec() {
  return {
    openapi: "3.0.3",
    info: {
      title: "novamem",
      version: "0.1.0",
      description:
        "Tiered memory service with hybrid search (keyword + vector + graph), per-tenant " +
        "isolation, and project-scoped sub-brains.\n\n" +
        "**Auth**: data-plane routes accept tenant tokens (`nm_…`), control-plane routes " +
        "accept session tokens (`ns_…`). Admin routes also accept the legacy " +
        "`NOVAMEM_ADMIN_TOKEN` for back-compat.",
      license: { name: "MIT" },
    },
    servers: [{ url: "/", description: "this server" }],
    components: {
      securitySchemes: {
        TenantBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "nm_…",
          description: "Tenant API token. Used for memory data plane.",
        },
        SessionBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "ns_…",
          description: "Dashboard session token. Used for /v1/auth/* and /v1/me/*.",
        },
        AdminBearer: {
          type: "http",
          scheme: "bearer",
          description:
            "Either an admin user's session bearer (ns_…) OR the legacy " +
            "NOVAMEM_ADMIN_TOKEN. Required for /v1/admin/*.",
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
              description: "Project (sub-brain) id. Omit for tenant-wide entries.",
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
            degraded: { type: "boolean" },
          },
        },
        RememberRequest: {
          type: "object",
          required: ["content"],
          properties: {
            content: { type: "string", minLength: 1, maxLength: 262_144 },
            namespace: { type: "string", maxLength: 128 },
            source: { type: "string", maxLength: 128 },
            agentName: { type: "string", maxLength: 128, nullable: true },
            project: { type: "string", nullable: true },
            metadata: { type: "object", additionalProperties: true },
          },
        },
        RememberResponse: {
          type: "object",
          properties: { id: { type: "string" } },
        },
        RecentRequest: {
          type: "object",
          properties: {
            namespace: { type: "string", maxLength: 128 },
            k: { type: "integer", minimum: 1, maximum: 200 },
            since: { type: "string", description: "ISO-8601 timestamp" },
            project: { type: "string", nullable: true },
          },
        },
        NeighborsRequest: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", maxLength: 128 },
            depth: { type: "integer", minimum: 1, maximum: 3 },
            k: { type: "integer", minimum: 1, maximum: 50 },
            project: { type: "string", nullable: true },
          },
        },
        ForgetRequest: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", maxLength: 128 },
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
          properties: {
            demoted: { type: "integer" },
            promoted: { type: "integer" },
          },
        },
        // ─── Health / Stats / Metrics ──────────────────────────────────
        HealthResponse: {
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
        StatsResponse: {
          type: "object",
          properties: {
            byNamespace: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: {
                  warm: { type: "integer" },
                  cold: { type: "integer" },
                },
              },
            },
            totalWarm: { type: "integer" },
            totalCold: { type: "integer" },
            lastDecayAt: { type: "string", nullable: true },
            uptimeMs: { type: "integer" },
          },
        },
        MetricsSnapshot: {
          type: "object",
          properties: {
            counters: { type: "object", additionalProperties: { type: "integer" } },
            gauges: { type: "object", additionalProperties: true },
            rates: { type: "object", additionalProperties: { type: "number" } },
            uptime_ms: { type: "integer" },
          },
        },
        // ─── Admin / Tenants ────────────────────────────────────────────
        Tenant: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        TenantToken: {
          type: "object",
          properties: {
            tokenHash: { type: "string" },
            label: { type: "string", nullable: true },
            createdByUserId: { type: "string", nullable: true },
            projectId: { type: "string", nullable: true },
            createdAt: { type: "string", format: "date-time" },
            lastUsedAt: { type: "string", format: "date-time", nullable: true },
            revoked: { type: "boolean" },
          },
        },
        MintTokenResponse: {
          type: "object",
          properties: {
            token: {
              type: "string",
              description: "Plaintext bearer token — shown ONCE; server stores only the hash.",
            },
            tenantId: { type: "string" },
            projectId: { type: "string", nullable: true },
            createdAt: { type: "string", format: "date-time" },
            warning: { type: "string" },
          },
        },
        // ─── Auth / Users ──────────────────────────────────────────────
        LoginRequest: {
          type: "object",
          required: ["username", "password"],
          properties: {
            username: { type: "string" },
            password: { type: "string", format: "password" },
          },
        },
        LoginResponse: {
          type: "object",
          properties: {
            token: { type: "string", description: "Session bearer (ns_…)" },
            expiresAt: { type: "string", format: "date-time" },
            user: { $ref: "#/components/schemas/SessionUser" },
          },
        },
        SessionUser: {
          type: "object",
          properties: {
            id: { type: "string" },
            username: { type: "string" },
            role: { type: "string", enum: ["admin", "user"] },
            tenantId: { type: "string", nullable: true },
          },
        },
        DashUser: {
          type: "object",
          properties: {
            id: { type: "string" },
            username: { type: "string" },
            role: { type: "string", enum: ["admin", "user"] },
            tenantId: { type: "string", nullable: true },
            createdAt: { type: "string", format: "date-time" },
            lastLoginAt: { type: "string", format: "date-time", nullable: true },
          },
        },
        CreateUserRequest: {
          type: "object",
          required: ["username", "password", "role"],
          properties: {
            username: { type: "string" },
            password: { type: "string", format: "password", minLength: 8 },
            role: { type: "string", enum: ["admin", "user"] },
            tenantId: {
              type: "string",
              nullable: true,
              description: "Required for role 'user'.",
            },
          },
        },
        // ─── Projects ──────────────────────────────────────────────────
        Project: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            role: { type: "string", enum: ["owner", "member"] },
            ownerUserId: { type: "string" },
            ownerTenantId: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        ProjectMember: {
          type: "object",
          properties: {
            userId: { type: "string" },
            username: { type: "string" },
            tenantId: { type: "string", nullable: true },
            role: { type: "string", enum: ["owner", "member"] },
            joinedAt: { type: "string", format: "date-time" },
          },
        },
        CreateProjectRequest: {
          type: "object",
          required: ["id", "name"],
          properties: {
            id: { type: "string", description: "Slug, 2–64 chars." },
            name: { type: "string" },
          },
        },
        // ─── Common error ──────────────────────────────────────────────
        Error: {
          type: "object",
          properties: { error: { type: "string" } },
        },
      },
    },
    tags: [
      { name: "Memory", description: "Search, store, and recall memory entries." },
      { name: "Health", description: "Liveness probes and operational metrics." },
      { name: "Auth", description: "Dashboard sign-in and self-service token rotation." },
      { name: "Me", description: "User-scoped self-service: tokens, projects, metrics." },
      { name: "Admin", description: "Tenant + user management, system metrics." },
      { name: "MCP", description: "SSE-MCP transport for remote MCP-aware hosts." },
    ],
    paths: buildPaths(),
  } as const;
}

function buildPaths() {
  const errorResponse = {
    description: "Error",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
  const authError = { 401: errorResponse, 403: errorResponse };
  const adminError = { ...authError, 404: errorResponse };

  const tenant = [{ TenantBearer: [] as string[] }];
  const session = [{ SessionBearer: [] as string[] }];
  const admin = [{ AdminBearer: [] as string[] }];

  const jsonBody = (schemaRef: string) => ({
    required: true,
    content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaRef}` } } },
  });
  const jsonResponse = (schemaRef: string, description = "OK") => ({
    description,
    content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaRef}` } } },
  });

  return {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Liveness probe + dependency snapshot",
        responses: { 200: jsonResponse("HealthResponse") },
      },
    },
    "/v1/search": {
      post: {
        tags: ["Memory"],
        summary: "Hybrid search (keyword + vector + graph)",
        security: tenant,
        requestBody: jsonBody("SearchRequest"),
        responses: { 200: jsonResponse("SearchResponse"), ...authError },
      },
    },
    "/v1/remember": {
      post: {
        tags: ["Memory"],
        summary: "Store a new memory entry",
        security: tenant,
        requestBody: jsonBody("RememberRequest"),
        responses: { 201: jsonResponse("RememberResponse", "Created"), ...authError },
      },
    },
    "/v1/recent": {
      post: {
        tags: ["Memory"],
        summary: "Recent entries by namespace, newest first",
        security: tenant,
        requestBody: jsonBody("RecentRequest"),
        responses: { 200: jsonResponse("SearchResponse"), ...authError },
      },
    },
    "/v1/neighbors": {
      post: {
        tags: ["Memory"],
        summary: "Graph-neighbour traversal from a seed entry",
        security: tenant,
        requestBody: jsonBody("NeighborsRequest"),
        responses: { 200: jsonResponse("SearchResponse"), ...authError },
      },
    },
    "/v1/forget": {
      post: {
        tags: ["Memory"],
        summary: "Hard-delete a memory entry",
        security: tenant,
        requestBody: jsonBody("ForgetRequest"),
        responses: { 200: jsonResponse("ForgetResponse"), ...authError },
      },
    },
    "/v1/decay": {
      post: {
        tags: ["Health"],
        summary: "Run the decay (warm→cold) pass",
        security: tenant,
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/DecayRequest" } } } },
        responses: { 200: jsonResponse("DecayResponse") },
      },
    },
    "/v1/reap-orphans": {
      post: {
        tags: ["Health"],
        summary: "Drain the cold-orphan queue",
        security: tenant,
        responses: { 200: { description: "Reaper run summary" } },
      },
    },
    "/v1/stats": {
      get: {
        tags: ["Health"],
        summary: "Per-namespace counts and last decay timestamp",
        security: tenant,
        responses: { 200: jsonResponse("StatsResponse") },
      },
    },
    "/openapi.json": {
      get: {
        tags: ["Health"],
        summary: "Raw OpenAPI document",
        responses: { 200: { description: "OpenAPI 3.0 document" } },
      },
    },
    "/v1/auth/status": {
      get: {
        tags: ["Auth"],
        summary: "Bootstrap status (is there at least one admin?)",
        responses: { 200: { description: "{ ready, bootstrapNeeded }" } },
      },
    },
    "/v1/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Sign in with username + password",
        requestBody: jsonBody("LoginRequest"),
        responses: { 201: jsonResponse("LoginResponse"), 401: errorResponse },
      },
    },
    "/v1/auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "Revoke this session bearer",
        security: session,
        responses: { 204: { description: "Logged out" } },
      },
    },
    "/v1/auth/me": {
      get: {
        tags: ["Auth"],
        summary: "Current user info",
        security: session,
        responses: { 200: { description: "{ user }", content: { "application/json": { schema: { type: "object", properties: { user: { $ref: "#/components/schemas/SessionUser" } } } } } } },
      },
    },
    "/v1/auth/rotate-token": {
      post: {
        tags: ["Auth"],
        summary: "Rotate a tenant token (CLI / device path)",
        security: tenant,
        responses: { 201: jsonResponse("MintTokenResponse"), 400: errorResponse, 401: errorResponse },
      },
    },
    "/v1/me/metrics": {
      get: {
        tags: ["Me"],
        summary: "Operational metrics scoped to the user's tenant",
        security: session,
        responses: { 200: jsonResponse("MetricsSnapshot") },
      },
    },
    "/v1/me/tokens": {
      get: {
        tags: ["Me"],
        summary: "List the user's tenant's API tokens",
        security: session,
        responses: { 200: { description: "{ tokens }", content: { "application/json": { schema: { type: "object", properties: { tokens: { type: "array", items: { $ref: "#/components/schemas/TenantToken" } } } } } } } },
      },
      post: {
        tags: ["Me"],
        summary: "Mint a new API token (optionally project-scoped)",
        security: session,
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  projectId: { type: "string", nullable: true },
                },
              },
            },
          },
        },
        responses: { 201: jsonResponse("MintTokenResponse"), ...authError },
      },
    },
    "/v1/me/tokens/{hash}/revoke": {
      post: {
        tags: ["Me"],
        summary: "Revoke an API token by sha256 hash",
        security: session,
        parameters: [{ name: "hash", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "{ revoked: true }" }, ...adminError },
      },
    },
    "/v1/me/projects": {
      get: {
        tags: ["Me"],
        summary: "List projects this user is a member of",
        security: session,
        responses: { 200: { description: "{ projects }", content: { "application/json": { schema: { type: "object", properties: { projects: { type: "array", items: { $ref: "#/components/schemas/Project" } } } } } } } },
      },
      post: {
        tags: ["Me"],
        summary: "Create a project (caller becomes owner)",
        security: session,
        requestBody: jsonBody("CreateProjectRequest"),
        responses: { 201: jsonResponse("Project"), 409: errorResponse, ...authError },
      },
    },
    "/v1/me/projects/{id}": {
      delete: {
        tags: ["Me"],
        summary: "Delete a project (owner only) and purge its memory",
        security: session,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "Purge summary" }, ...adminError },
      },
    },
    "/v1/me/projects/{id}/members": {
      get: {
        tags: ["Me"],
        summary: "List members of a project",
        security: session,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "{ members }", content: { "application/json": { schema: { type: "object", properties: { members: { type: "array", items: { $ref: "#/components/schemas/ProjectMember" } } } } } } }, ...adminError },
      },
      post: {
        tags: ["Me"],
        summary: "Add a member to a project (owner only)",
        security: session,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["username"],
                properties: {
                  username: { type: "string" },
                  role: { type: "string", enum: ["owner", "member"] },
                },
              },
            },
          },
        },
        responses: { 201: { description: "Added" }, ...adminError, 409: errorResponse },
      },
    },
    "/v1/me/projects/{id}/members/{userId}": {
      delete: {
        tags: ["Me"],
        summary: "Remove a member (owner removes anyone; non-owner can only remove themselves)",
        security: session,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "userId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { 200: { description: "{ removed: true }" }, ...adminError },
      },
    },
    "/v1/admin/tenants": {
      get: {
        tags: ["Admin"],
        summary: "List tenants",
        security: admin,
        responses: { 200: { description: "{ tenants }", content: { "application/json": { schema: { type: "object", properties: { tenants: { type: "array", items: { $ref: "#/components/schemas/Tenant" } } } } } } } },
      },
      post: {
        tags: ["Admin"],
        summary: "Create a tenant",
        security: admin,
        requestBody: { content: { "application/json": { schema: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } } } } },
        responses: { 201: jsonResponse("Tenant") },
      },
    },
    "/v1/admin/tenants/{id}": {
      delete: {
        tags: ["Admin"],
        summary: "Delete a tenant + purge all its memory data and tokens",
        security: admin,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "Purge summary" }, 400: errorResponse, ...adminError },
      },
    },
    "/v1/admin/tenants/{id}/tokens": {
      get: {
        tags: ["Admin"],
        summary: "List tokens for a tenant (sha256 hashes only)",
        security: admin,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "{ tokens }" } },
      },
      post: {
        tags: ["Admin"],
        summary: "Mint a new tenant token (plaintext shown once)",
        security: admin,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { label: { type: "string" } } } } } },
        responses: { 201: jsonResponse("MintTokenResponse"), 404: errorResponse },
      },
    },
    "/v1/admin/tenants/{tenantId}/tokens/{hash}/revoke": {
      post: {
        tags: ["Admin"],
        summary: "Revoke a tenant token by sha256 hash",
        security: admin,
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "hash", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { 200: { description: "{ revoked: true }" }, ...adminError },
      },
    },
    "/v1/admin/tokens/revoke": {
      post: {
        tags: ["Admin"],
        summary: "Revoke a token by plaintext (legacy / CLI path)",
        security: admin,
        requestBody: { content: { "application/json": { schema: { type: "object", required: ["token"], properties: { token: { type: "string" } } } } } },
        responses: { 200: { description: "{ revoked: boolean }" } },
      },
    },
    "/v1/admin/users": {
      get: {
        tags: ["Admin"],
        summary: "List dashboard users",
        security: admin,
        responses: { 200: { description: "{ users }", content: { "application/json": { schema: { type: "object", properties: { users: { type: "array", items: { $ref: "#/components/schemas/DashUser" } } } } } } } },
      },
      post: {
        tags: ["Admin"],
        summary: "Create a dashboard user (admin or user role)",
        security: admin,
        requestBody: jsonBody("CreateUserRequest"),
        responses: { 201: jsonResponse("DashUser"), 400: errorResponse, 409: errorResponse },
      },
    },
    "/v1/admin/users/{id}": {
      delete: {
        tags: ["Admin"],
        summary: "Delete a user (refuses self / last-admin)",
        security: admin,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "{ deleted: boolean }" }, 400: errorResponse, ...adminError },
      },
    },
    "/v1/admin/users/{id}/role": {
      post: {
        tags: ["Admin"],
        summary: "Change a user's role / tenant",
        security: admin,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", required: ["role"], properties: { role: { type: "string", enum: ["admin", "user"] }, tenantId: { type: "string", nullable: true } } } } } },
        responses: { 200: { description: "{ updated: boolean }" }, ...adminError },
      },
    },
    "/v1/admin/metrics": {
      get: {
        tags: ["Admin"],
        summary: "Operational metrics snapshot (cross-tenant)",
        security: admin,
        responses: { 200: jsonResponse("MetricsSnapshot") },
      },
    },
    "/mcp/sse": {
      get: {
        tags: ["MCP"],
        summary: "Open an SSE event stream for an MCP session",
        security: tenant,
        responses: { 200: { description: "text/event-stream — long-lived connection" } },
      },
    },
    "/mcp/messages": {
      post: {
        tags: ["MCP"],
        summary: "Send a JSON-RPC message on an open SSE-MCP session",
        parameters: [{ name: "sessionId", in: "query", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "OK" }, 400: errorResponse, 404: errorResponse },
      },
    },
  };
}
