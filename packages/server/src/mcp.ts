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
import { NOVAMEM_INSTRUCTIONS } from "./mcp-instructions.js";

export interface McpContext {
  /** Memory-owner id — the user the caller's bearer maps to. */
  userId: string;
  /** Project the bearer/session is bound to (or null for whole-user). */
  projectId?: string | null;
}

/** Build the MCP server. `ctxOrUserId` accepts either a context object
 *  (new shape with user + optional project) or a bare userId string for
 *  back-compat with existing callers. */
export function buildMcpServer(
  engine: MemoryEngine,
  ctxOrUserId: McpContext | string,
  warm?: WarmStore,
): Server {
  const ctx: McpContext =
    typeof ctxOrUserId === "string" ? { userId: ctxOrUserId } : ctxOrUserId;
  const userId = ctx.userId;
  const server = new Server(
    { name: "novamem", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: NOVAMEM_INSTRUCTIONS },
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
            namespace: { type: "string", description: "Single namespace shelf (default 'default'). Ignored when includeNamespaces is set." },
            includeNamespaces: {
              type: "array",
              items: { type: "string" },
              description: "Cross-namespace search: union results across these shelves. Use when you don't know which namespace a memory was written to.",
            },
            project: {
              type: "string",
              description: "Project to scope to. Accepts id (ULID) or human name. Omit for user-wide entries.",
            },
            includeProjects: {
              type: "array",
              items: { type: "string" },
              description: "Active-project mode: union user-global with each listed project (id or name).",
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
        description: "Recent entries, ordered newest first. Optional ISO-8601 `since` lower bound.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            includeNamespaces: { type: "array", items: { type: "string" }, description: "Cross-namespace recent feed." },
            k: { type: "number" },
            since: { type: "string", description: "ISO-8601 timestamp" },
            project: { type: "string", description: "Project id or name." },
            includeProjects: { type: "array", items: { type: "string" } },
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
            project: { type: "string", description: "Project id or name (for entry resolution)." },
            includeProjects: { type: "array", items: { type: "string" } },
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
          "List projects (sub-brains) the caller is a member of. Returns id + name + role — pass the `id` (a ULID) to `project` on memory.* calls to scope them.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "project.create",
        description:
          "Create a new project (sub-brain) and become its owner. The project's id is returned; pass that id to `project` on subsequent memory.* calls to scope them. Don't use the human name as `project` — it won't resolve.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Project name (1-128 chars). The id is server-assigned (ULID).",
            },
          },
          required: ["name"],
        },
      },
    ],
  }));

  /** Resolve a single project reference (id or human name) and verify the
   *  caller is a member. Returns the canonical ULID, or null when the
   *  caller didn't pass one. Throws on failure — the outer try/catch in
   *  the CallTool dispatcher turns it into an MCP isError result with a
   *  message the agent can read. */
  async function resolveProject(arg: unknown): Promise<string | null> {
    const requested = typeof arg === "string" && arg.length > 0 ? arg : null;
    if (!requested) return null;
    if (!warm) {
      throw new Error("project lookup requires the warm store");
    }
    const byId = await warm.getProject(requested);
    const project = byId ?? (await warm.findProjectByName(userId, requested));
    if (!project) {
      throw new Error(`no such project '${requested}' — call project.list to see ids`);
    }
    const m = await warm.getProjectMembership(project.id, userId);
    if (!m) {
      throw new Error(`not a member of project '${requested}' (id ${project.id})`);
    }
    return project.id;
  }

  /** Same as resolveProject but for the includeProjects array. Resolves
   *  every entry and validates membership. */
  async function resolveProjects(arg: unknown): Promise<string[] | undefined> {
    if (!Array.isArray(arg) || arg.length === 0) return undefined;
    const out: string[] = [];
    for (const v of arg) {
      const id = await resolveProject(v);
      if (id) out.push(id);
    }
    return out.length > 0 ? out : undefined;
  }

  function asStringArray(arg: unknown): string[] | undefined {
    if (!Array.isArray(arg) || arg.length === 0) return undefined;
    const out = arg.filter((v): v is string => typeof v === "string" && v.length > 0);
    return out.length > 0 ? out : undefined;
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
        const project = await resolveProject(args.project);
        const includeProjects = await resolveProjects(args.includeProjects);
        const r = await engine.search(userId, {
          query: String(args.query),
          k: typeof args.k === "number" ? args.k : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          includeNamespaces: asStringArray(args.includeNamespaces),
          project,
          includeProjects,
          weights,
        });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.remember": {
        const project = await resolveProject(args.project);
        const r = await engine.remember(userId, {
          content: String(args.content),
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          source: typeof args.source === "string" ? args.source : undefined,
          project,
        });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.today": {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const project = await resolveProject(args.project);
        const includeProjects = await resolveProjects(args.includeProjects);
        const r = await engine.recent(userId, {
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          includeNamespaces: asStringArray(args.includeNamespaces),
          k: typeof args.k === "number" ? args.k : 20,
          since,
          project,
          includeProjects,
        });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.recent": {
        const project = await resolveProject(args.project);
        const includeProjects = await resolveProjects(args.includeProjects);
        const r = await engine.recent(userId, {
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          includeNamespaces: asStringArray(args.includeNamespaces),
          k: typeof args.k === "number" ? args.k : undefined,
          since: typeof args.since === "string" ? args.since : undefined,
          project,
          includeProjects,
        });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.neighbors": {
        const project = await resolveProject(args.project);
        const includeProjects = await resolveProjects(args.includeProjects);
        const r = await engine.neighbors(userId, {
          id: String(args.id),
          depth: typeof args.depth === "number" ? args.depth : undefined,
          k: typeof args.k === "number" ? args.k : undefined,
          project,
          includeProjects,
        });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.forget": {
        const project = await resolveProject(args.project);
        const r = await engine.forget(userId, String(args.id), { project });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.stats": {
        const r = await engine.stats(userId);
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "project.list": {
        if (!warm) {
          return {
            content: [{ type: "text", text: "project.list requires the warm store" }],
            isError: true,
          };
        }
        // Tokens have no project scope — any authenticated caller lists
        // projects owned-or-joined by their underlying user.
        const projects = await warm.listProjectsForUser(userId);
        return { content: [{ type: "text", text: JSON.stringify({ projects }) }] };
      }
      case "project.create": {
        if (!warm) {
          return {
            content: [{ type: "text", text: "project.create requires the warm store" }],
            isError: true,
          };
        }
        const name = String(args.name);
        if (!name || name.length > 128) {
          return { content: [{ type: "text", text: "invalid project name (1–128 chars)" }], isError: true };
        }
        // The bearer's owning user becomes the project owner — same flow
        // as POST /v1/me/projects in the cookie-auth dashboard.
        const project = await warm.createProject({
          name,
          ownerUserId: userId,
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

export async function startMcpStdio(engine: MemoryEngine, userId: string): Promise<void> {
  const server = buildMcpServer(engine, userId);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
