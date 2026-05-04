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
        name: "memory.update",
        description:
          "Rewrite an existing memory in place. Preserves id, hit count, edges, and creation date; rewrites content (re-embedded), namespace, metadata, and provenance fields. Use this when a fact changes (e.g. user moved cities) instead of forget+remember, which would lose hit count and graph connections. Omit `content` to update only metadata-side fields without re-embedding.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Memory id (ULID)." },
            content: { type: "string" },
            namespace: { type: "string" },
            metadata: { type: "object" },
            sourceType: { type: "string" },
            capturedFrom: { type: "string" },
            confidence: { type: "number", description: "0..1" },
            project: { type: "string", description: "Project id or name (scope check)." },
          },
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
          "List projects (sub-brains) the caller is a member of. Returns id + name + role for each.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "project.create",
        description:
          "Create a new project (sub-brain) and become its owner. Returns the new project's id (server-assigned ULID).",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Project name (1-128 chars)." },
          },
          required: ["name"],
        },
      },
      {
        name: "project.delete",
        description:
          "Delete a project owned by the caller. Removes every memory entry, vector, and graph node in the project. The caller must be the owner.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project id or human name." },
          },
          required: ["project"],
        },
      },
      {
        name: "project.activate",
        description:
          "Set the caller's active project. Subsequent memory.* calls without an explicit `project` arg default to this scope: search/recent/neighbors union it with user-global, remember/forget target it directly. Idempotent.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project id or human name." },
          },
          required: ["project"],
        },
      },
      {
        name: "project.deactivate",
        description:
          "Clear the caller's active project. Subsequent memory.* calls without an explicit `project` arg fall back to user-global only.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "project.share",
        description:
          "Add another user as a member of a project the caller owns. The invitee can read and write the project's memories. Username may be the user's email or display name.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project id or human name." },
            username: { type: "string", description: "Email or display name of the user to add." },
          },
          required: ["project", "username"],
        },
      },
      {
        name: "project.unshare",
        description:
          "Remove a member from a project. The caller must be the owner. The owner cannot unshare themselves — delete the project instead.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project id or human name." },
            username: { type: "string", description: "Email or display name of the user to remove." },
          },
          required: ["project", "username"],
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

  /** Returns the caller's active-project id, or null when not set. The
   *  active project is a per-user pointer set by `project.activate`;
   *  memory.* tools fall back to it when the caller didn't pass an
   *  explicit `project` / `includeProjects` arg. Read fresh on every
   *  call so activate/deactivate take effect immediately within the
   *  same MCP session. */
  async function getActiveProject(): Promise<string | null> {
    if (!warm) return null;
    return warm.getActiveProject(userId);
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
        let project = await resolveProject(args.project);
        let includeProjects = await resolveProjects(args.includeProjects);
        // Active-project fallback: when the caller didn't pass a scope,
        // union user-global with the active project (matches dashboard
        // sidebar semantics).
        if (!project && (!includeProjects || includeProjects.length === 0)) {
          const active = await getActiveProject();
          if (active) includeProjects = [active];
        }
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
        let project = await resolveProject(args.project);
        if (!project) project = await getActiveProject();
        const r = await engine.remember(userId, {
          content: String(args.content),
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          source: typeof args.source === "string" ? args.source : undefined,
          sourceType: typeof args.sourceType === "string" ? args.sourceType : undefined,
          capturedFrom: typeof args.capturedFrom === "string" ? args.capturedFrom : undefined,
          confidence: typeof args.confidence === "number" ? args.confidence : undefined,
          force: args.force === true,
          project,
        });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.today": {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        let project = await resolveProject(args.project);
        let includeProjects = await resolveProjects(args.includeProjects);
        if (!project && (!includeProjects || includeProjects.length === 0)) {
          const active = await getActiveProject();
          if (active) includeProjects = [active];
        }
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
        let project = await resolveProject(args.project);
        let includeProjects = await resolveProjects(args.includeProjects);
        if (!project && (!includeProjects || includeProjects.length === 0)) {
          const active = await getActiveProject();
          if (active) includeProjects = [active];
        }
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
        let project = await resolveProject(args.project);
        let includeProjects = await resolveProjects(args.includeProjects);
        if (!project && (!includeProjects || includeProjects.length === 0)) {
          const active = await getActiveProject();
          if (active) includeProjects = [active];
        }
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
        let project = await resolveProject(args.project);
        if (!project) project = await getActiveProject();
        const r = await engine.forget(userId, String(args.id), { project });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.update": {
        let project = await resolveProject(args.project);
        if (!project) project = await getActiveProject();
        const md = (args.metadata ?? undefined) as Record<string, unknown> | undefined;
        const r = await engine.update(userId, String(args.id), {
          content: typeof args.content === "string" ? args.content : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          metadata: md,
          sourceType: typeof args.sourceType === "string" ? args.sourceType : undefined,
          capturedFrom: typeof args.capturedFrom === "string" ? args.capturedFrom : undefined,
          confidence: typeof args.confidence === "number" ? args.confidence : undefined,
          project,
        });
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
        const project = await warm.createProject({ name, ownerUserId: userId });
        return { content: [{ type: "text", text: JSON.stringify(project) }] };
      }
      case "project.delete": {
        if (!warm) throw new Error("project.delete requires the warm store");
        const projectId = await resolveProject(args.project);
        if (!projectId) throw new Error("project required");
        const project = await warm.getProject(projectId);
        if (!project) throw new Error("unknown project");
        if (project.ownerUserId !== userId) {
          throw new Error("only the owner can delete a project");
        }
        const r = await engine.deleteProject(projectId);
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "project.activate": {
        if (!warm) throw new Error("project.activate requires the warm store");
        const projectId = await resolveProject(args.project);
        if (!projectId) throw new Error("project required");
        await warm.setActiveProject(userId, projectId);
        return { content: [{ type: "text", text: JSON.stringify({ active: projectId }) }] };
      }
      case "project.deactivate": {
        if (!warm) throw new Error("project.deactivate requires the warm store");
        await warm.setActiveProject(userId, null);
        return { content: [{ type: "text", text: JSON.stringify({ active: null }) }] };
      }
      case "project.share": {
        if (!warm) throw new Error("project.share requires the warm store");
        const projectId = await resolveProject(args.project);
        if (!projectId) throw new Error("project required");
        const project = await warm.getProject(projectId);
        if (!project) throw new Error("unknown project");
        if (project.ownerUserId !== userId) {
          throw new Error("only the owner can share a project");
        }
        const username = String(args.username);
        const target = await warm.findUserByUsername(username);
        if (!target) throw new Error(`unknown user '${username}'`);
        const ok = await warm.addProjectMember(projectId, target.id, "member");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ added: ok, userId: target.id, username: target.username }),
            },
          ],
        };
      }
      case "project.unshare": {
        if (!warm) throw new Error("project.unshare requires the warm store");
        const projectId = await resolveProject(args.project);
        if (!projectId) throw new Error("project required");
        const project = await warm.getProject(projectId);
        if (!project) throw new Error("unknown project");
        if (project.ownerUserId !== userId) {
          throw new Error("only the owner can unshare a project");
        }
        const username = String(args.username);
        const target = await warm.findUserByUsername(username);
        if (!target) throw new Error(`unknown user '${username}'`);
        if (target.id === project.ownerUserId) {
          throw new Error("the owner cannot unshare themselves — delete the project instead");
        }
        const r = await warm.removeProjectMember(projectId, target.id);
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
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
