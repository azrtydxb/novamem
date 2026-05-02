/**
 * MCP server exposing memory tools via stdio. The same engine instance backs
 * both HTTP and MCP — tool semantics are identical.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { MemoryEngine } from "./engine/index.js";
import type { WarmStore } from "./warm-store/index.js";

export interface McpContext {
  tenantId: string;
  /** Project the bearer/session is bound to (or null for tenant-wide). */
  projectId?: string | null;
  /** User id when authenticated as a dashboard user (used for project.create
   *  ownership). Null/undefined for tenant-bearer-only callers — those can't
   *  create projects via MCP. */
  userId?: string | null;
}

/** Build the MCP server. `ctxOrTenant` accepts either a context object (new
 *  shape with tenant + project + user) or a bare tenantId string for back-
 *  compat with existing callers. */
export function buildMcpServer(
  engine: MemoryEngine,
  ctxOrTenant: McpContext | string,
  warm?: WarmStore,
): Server {
  const ctx: McpContext =
    typeof ctxOrTenant === "string" ? { tenantId: ctxOrTenant } : ctxOrTenant;
  const tenantId = ctx.tenantId;
  const bearerProject = ctx.projectId ?? null;
  const server = new Server(
    { name: "novamem", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "memory.search",
        description:
          "Hybrid search across stored memories. Always runs keyword (FTS) + vector (cosine) + graph (neighbours) in parallel and fuses with weighted scoring. Default weights: keyword 0.3, vector 0.6, graph 0.1. Override `weights` only when you have a specific reason — e.g. `{ keyword: 1, vector: 0 }` to force exact-string match for ids/symbols, or `{ vector: 1, keyword: 0 }` to ignore literal token overlap and lean entirely on semantic similarity.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            k: { type: "number", description: "Top-K to return (default 10)" },
            namespace: { type: "string" },
            project: {
              type: "string",
              description: "Optional project (sub-brain) to scope to. Omit for tenant-wide entries.",
            },
            weights: {
              type: "object",
              description: "Per-signal weight overrides. Omit to use defaults.",
              properties: {
                keyword: { type: "number", description: "FTS keyword match weight" },
                vector: { type: "number", description: "Embedding cosine weight" },
                graph: { type: "number", description: "Graph-neighbour weight" },
              },
            },
          },
          required: ["query"],
        },
      },
      {
        name: "memory.remember",
        description: "Store a new memory entry",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string" },
            namespace: { type: "string" },
            source: { type: "string" },
            project: {
              type: "string",
              description: "Optional project (sub-brain) to scope to.",
            },
          },
          required: ["content"],
        },
      },
      {
        name: "memory.today",
        description: "Recent entries (last 24h) for an optional namespace",
        inputSchema: {
          type: "object",
          properties: { namespace: { type: "string" }, k: { type: "number" } },
        },
      },
      {
        name: "memory.recent",
        description: "Recent entries in a namespace, ordered newest first. Optional ISO-8601 `since` lower bound.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            k: { type: "number" },
            since: { type: "string", description: "ISO-8601 timestamp" },
          },
        },
      },
      {
        name: "memory.neighbors",
        description: "Graph-neighbour traversal from a seed memory id",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            depth: { type: "number", description: "Traversal depth (default 1)" },
            k: { type: "number" },
          },
          required: ["id"],
        },
      },
      {
        name: "memory.forget",
        description: "Explicit deletion. Removes warm row, FTS, cold vector, and graph edges.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
      {
        name: "memory.stats",
        description: "Service-wide stats snapshot",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "project.list",
        description:
          "List projects (sub-brains) the current caller is a member of. " +
          "Available only when authenticated as a dashboard user.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "project.create",
        description:
          "Create a new project (sub-brain) and add the caller as the owner. " +
          "Memory operations using this project as the `project` argument will " +
          "be scoped to it. Available only when authenticated as a dashboard user.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                "URL-safe slug, 2–64 chars, alphanumeric / dot / underscore / dash.",
            },
            name: { type: "string", description: "Display name" },
          },
          required: ["id", "name"],
        },
      },
    ],
  }));

  /** Resolve the project to use for a memory call. Same rules as the HTTP
   *  layer (centralised in routes/context.ts to prevent drift): bearer-
   *  bound project wins; tenant-wide bearer can't pass a project. The
   *  HTTP variant accepts a Fastify reply; the MCP variant throws (the
   *  outer try/catch turns the throw into an MCP isError result). */
  function resolveProject(arg: unknown): string | null {
    const requested = typeof arg === "string" && arg.length > 0 ? arg : null;
    if (bearerProject) {
      if (requested && requested !== bearerProject) {
        throw new Error(
          `bearer is scoped to project '${bearerProject}'; cannot operate on '${requested}'`,
        );
      }
      return bearerProject;
    }
    if (requested) {
      throw new Error(
        "this bearer is tenant-wide; mint a project-scoped token to access a project",
      );
    }
    return null;
  }

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    switch (req.params.name) {
      case "memory.search": {
        const w = (args.weights ?? {}) as { keyword?: unknown; vector?: unknown; graph?: unknown };
        const weights =
          typeof w.keyword === "number" || typeof w.vector === "number" || typeof w.graph === "number"
            ? {
                ...(typeof w.keyword === "number" ? { keyword: w.keyword } : {}),
                ...(typeof w.vector === "number" ? { vector: w.vector } : {}),
                ...(typeof w.graph === "number" ? { graph: w.graph } : {}),
              }
            : undefined;
        const project = resolveProject(args.project);
        const r = await engine.search(tenantId, {
          query: String(args.query),
          k: typeof args.k === "number" ? args.k : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          project,
          weights,
        });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.remember": {
        const project = resolveProject(args.project);
        const r = await engine.remember(tenantId, {
          content: String(args.content),
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          source: typeof args.source === "string" ? args.source : undefined,
          project,
        });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.today": {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const project = resolveProject(args.project);
        const r = await engine.recent(tenantId, {
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          k: typeof args.k === "number" ? args.k : 20,
          since,
          project,
        });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.recent": {
        const project = resolveProject(args.project);
        const r = await engine.recent(tenantId, {
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          k: typeof args.k === "number" ? args.k : undefined,
          since: typeof args.since === "string" ? args.since : undefined,
          project,
        });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.neighbors": {
        const project = resolveProject(args.project);
        const r = await engine.neighbors(tenantId, {
          id: String(args.id),
          depth: typeof args.depth === "number" ? args.depth : undefined,
          k: typeof args.k === "number" ? args.k : undefined,
          project,
        });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.forget": {
        const project = resolveProject(args.project);
        const r = await engine.forget(tenantId, String(args.id), { project });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.stats": {
        const r = await engine.stats(tenantId);
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "project.list": {
        if (!warm || !ctx.userId) {
          return {
            content: [{ type: "text", text: "project.list requires dashboard-user authentication" }],
            isError: true,
          };
        }
        const projects = await warm.listProjectsForUser(ctx.userId);
        return { content: [{ type: "text", text: JSON.stringify({ projects }) }] };
      }
      case "project.create": {
        if (!warm || !ctx.userId) {
          return {
            content: [{ type: "text", text: "project.create requires dashboard-user authentication" }],
            isError: true,
          };
        }
        const id = String(args.id);
        const name = String(args.name);
        if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) {
          return { content: [{ type: "text", text: "invalid project id (must be a slug, 2–64 chars)" }], isError: true };
        }
        if (await warm.getProject(id)) {
          return { content: [{ type: "text", text: "project id already exists" }], isError: true };
        }
        const project = await warm.createProject({
          id,
          name,
          ownerUserId: ctx.userId,
          ownerTenantId: tenantId,
        });
        return { content: [{ type: "text", text: JSON.stringify(project) }] };
      }
      default:
        return {
          content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
          isError: true,
        };
    }
  });

  return server;
}

export async function startMcpStdio(engine: MemoryEngine, tenantId: string): Promise<void> {
  const server = buildMcpServer(engine, tenantId);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
