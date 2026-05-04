/**
 * Single source of truth for the MCP tool surface.
 *
 * Both the in-process server (`mcp.ts`, used by `/mcp/sse`) and the
 * stdio shim (`packages/mcp/src/index.ts`) import from this file so the
 * two transports advertise an identical tool list, share validation
 * logic, and stay in sync as the surface evolves.
 *
 * Exports:
 *   - `NOVAMEM_INSTRUCTIONS`: behaviour rules surfaced via the MCP
 *     `instructions` field on `initialize`.
 *   - `TOOL_DEFINITIONS`: the JSON-Schema description of every tool's
 *     name, description, and input shape.
 *   - `TOOL_NAMES`: `keyof TOOL_DEFINITIONS` typed list.
 *   - `TOOL_INPUT_SCHEMAS`: Zod schemas used at call time to validate
 *     and coerce the caller's `arguments` blob. The HTTP layer's body
 *     schemas (`routes/schemas.ts`) are reused where the shape matches.
 *   - `resolveScope`: shared helper for the "default to active project"
 *     fallback that the data-plane tools (search/recent/neighbors/
 *     remember/forget/update) all need.
 */
import { z } from "zod";

import {
  ForgetBody,
  NeighborsBody,
  ProjectRefRule,
  RecentBody,
  RememberBody,
  SearchBody,
  UpdateMemoryBody,
} from "./routes/schemas.js";

// Re-export so consumers can pull instructions + tools from one module.
export { NOVAMEM_INSTRUCTIONS } from "./mcp-instructions.js";

// ─── Tool list (JSON-Schema for tools/list) ─────────────────────────────

/** A single MCP tool advertisement. The `inputSchema` follows JSON Schema
 *  Draft-07 conventions as expected by MCP `tools/list`. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "memory_search",
    description:
      "Hybrid search across stored memories. Always runs keyword (FTS) + vector (cosine) + graph (neighbours) in parallel and fuses with weighted scoring. Default weights: keyword 0.3, vector 0.6, graph 0.1. Override `weights` only when you have a specific reason — e.g. `{ keyword: 1, vector: 0 }` to force exact-string match for ids/symbols, or `{ vector: 1, keyword: 0 }` to ignore literal token overlap and lean entirely on semantic similarity.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        k: { type: "number", description: "Top-K to return (default 10)" },
        namespace: {
          type: "string",
          description:
            "Single namespace shelf (default 'default'). Ignored when includeNamespaces is set.",
        },
        includeNamespaces: {
          type: "array",
          items: { type: "string" },
          description:
            "Cross-namespace search: union results across these shelves. Use when you don't know which namespace a memory was written to.",
        },
        project: {
          type: "string",
          description:
            "Project to scope to. Accepts id (ULID) or human name. Omit for user-wide entries.",
        },
        includeProjects: {
          type: "array",
          items: { type: "string" },
          description:
            "Active-project mode: union user-global with each listed project (id or name).",
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
    name: "memory_remember",
    description: "Store a new memory entry",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        namespace: { type: "string" },
        source: { type: "string" },
        sourceType: {
          type: "string",
          description: "chat | email | code-review | doc | inference | observation | system | manual",
        },
        capturedFrom: {
          type: "string",
          description: "Agent name, conversation id, or other channel ref.",
        },
        confidence: { type: "number", description: "0..1, default 1.0" },
        force: {
          type: "boolean",
          description: "Bypass the worthiness gate. Default false.",
        },
        project: {
          type: "string",
          description: "Optional project (sub-brain) to scope to.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_today",
    description: "Recent entries (last 24h) for an optional namespace",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        includeNamespaces: { type: "array", items: { type: "string" } },
        k: { type: "number" },
        project: { type: "string", description: "Project id or name." },
        includeProjects: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "memory_recent",
    description:
      "Recent entries, ordered newest first. Optional ISO-8601 `since` lower bound.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        includeNamespaces: {
          type: "array",
          items: { type: "string" },
          description: "Cross-namespace recent feed.",
        },
        k: { type: "number" },
        since: { type: "string", description: "ISO-8601 timestamp" },
        project: { type: "string", description: "Project id or name." },
        includeProjects: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "memory_neighbors",
    description: "Graph-neighbour traversal from a seed memory id",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        depth: { type: "number", description: "Traversal depth (default 1)" },
        k: { type: "number" },
        project: {
          type: "string",
          description: "Project id or name (for entry resolution).",
        },
        includeProjects: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_forget",
    description:
      "Explicit deletion. Removes warm row, FTS, cold vector, and graph edges.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        project: { type: "string", description: "Project id or name (scope check)." },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_update",
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
    name: "memory_stats",
    description: "Service-wide stats snapshot",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "project_list",
    description:
      "List projects (sub-brains) the caller is a member of. Returns id + name + role for each.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "project_create",
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
    name: "project_delete",
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
    name: "project_activate",
    description:
      "Set the caller's active project. Subsequent memory_* calls without an explicit `project` arg default to this scope: search/recent/neighbors union it with user-global, remember/forget target it directly. Idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id or human name." },
      },
      required: ["project"],
    },
  },
  {
    name: "project_deactivate",
    description:
      "Clear the caller's active project. Subsequent memory_* calls without an explicit `project` arg fall back to user-global only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "project_share",
    description:
      "Add another user as a member of a project the caller owns. The invitee can read and write the project's memories. Username may be the user's email or display name.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id or human name." },
        username: {
          type: "string",
          description: "Email or display name of the user to add.",
        },
      },
      required: ["project", "username"],
    },
  },
  {
    name: "project_unshare",
    description:
      "Remove a member from a project. The caller must be the owner. The owner cannot unshare themselves — delete the project instead.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id or human name." },
        username: {
          type: "string",
          description: "Email or display name of the user to remove.",
        },
      },
      required: ["project", "username"],
    },
  },
];

export type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];

export const TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.name) as ToolName[];

// ─── Zod input schemas ─────────────────────────────────────────────────
//
// These validate the `arguments` payload of `tools/call`. The HTTP body
// schemas (`SearchBody`, `RememberBody`, etc.) are reused where shape
// matches; tools without an HTTP analogue get inline schemas.

const ProjectOnly = z.object({ project: ProjectRefRule });
const Empty = z.object({}).strict();

export const TodayBody = RecentBody;

export const TOOL_INPUT_SCHEMAS = {
  memory_search: SearchBody,
  memory_remember: RememberBody,
  memory_today: TodayBody,
  memory_recent: RecentBody,
  memory_neighbors: NeighborsBody,
  memory_forget: ForgetBody,
  memory_update: z.object({ id: z.string().min(1).max(128) }).and(UpdateMemoryBody),
  memory_stats: Empty,
  project_list: Empty,
  project_create: z.object({ name: z.string().min(1).max(128) }),
  project_delete: ProjectOnly,
  project_activate: ProjectOnly,
  project_deactivate: Empty,
  project_share: z.object({
    project: ProjectRefRule,
    username: z.string().min(1).max(128),
  }),
  project_unshare: z.object({
    project: ProjectRefRule,
    username: z.string().min(1).max(128),
  }),
} satisfies Record<string, z.ZodTypeAny>;

/** Validate raw `arguments` against the tool's Zod schema. Throws a
 *  human-readable error suitable for surfacing as the MCP isError text. */
export function parseToolArgs<K extends keyof typeof TOOL_INPUT_SCHEMAS>(
  name: K,
  raw: unknown,
): z.infer<(typeof TOOL_INPUT_SCHEMAS)[K]> {
  const schema = TOOL_INPUT_SCHEMAS[name];
  const r = schema.safeParse(raw ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    const path = first?.path?.join(".") ?? "";
    const msg = first?.message ?? "invalid arguments";
    throw new Error(path ? `invalid argument '${path}': ${msg}` : msg);
  }
  return r.data as z.infer<(typeof TOOL_INPUT_SCHEMAS)[K]>;
}

// ─── Scope resolution helper ───────────────────────────────────────────

/** Minimal warm-store surface needed by `resolveScope`. Avoids depending
 *  on the full `WarmStore` shape so the helper can be reused in tests
 *  with fakes. */
export interface ScopeWarmStore {
  getProject(idOrName: string): Promise<{ id: string; ownerUserId: string } | null>;
  findProjectByName(
    userId: string,
    name: string,
  ): Promise<{ id: string; ownerUserId: string } | null>;
  getProjectMembership(
    projectId: string,
    userId: string,
  ): Promise<{ role: string } | null>;
  getActiveProject(userId: string): Promise<string | null>;
}

export interface ResolveScopeArgs {
  /** Single project ref from caller (id or human name), or undefined. */
  project?: string | null;
  /** Multi project refs from caller, or undefined. */
  includeProjects?: readonly string[];
  /** When true (search/recent/neighbors/today): an unset scope falls
   *  back to `includeProjects: [activeProjectId]` so reads union
   *  user-global with the active project. When false (remember /
   *  forget / update): an unset scope falls back to
   *  `project: activeProjectId` so writes land in the active project. */
  unionWithActive: boolean;
}

export interface ResolveScopeResult {
  /** Canonical project ULID (or null when unset / no fallback). */
  project: string | null;
  /** Resolved canonical ULIDs (or undefined when unset). */
  includeProjects?: string[];
}

/** Resolve `project` + `includeProjects` to canonical ULIDs, verifying
 *  membership for each. Falls back to the caller's active project when
 *  no scope was supplied. Throws `Error` (with a human-readable
 *  message) on miss / not-a-member; the MCP dispatcher converts the
 *  throw into `{ isError: true, content: [...] }`.
 *
 *  When `warm` is null, no resolution happens — the helper just
 *  returns `{ project: project ?? null, includeProjects }` unchanged.
 *  This matches the in-process server's pre-existing behaviour for
 *  the `warm`-less code path. */
export async function resolveScope(
  warm: ScopeWarmStore | null | undefined,
  userId: string,
  args: ResolveScopeArgs,
): Promise<ResolveScopeResult> {
  if (!warm) {
    return {
      project: args.project ?? null,
      includeProjects:
        args.includeProjects && args.includeProjects.length > 0
          ? [...args.includeProjects]
          : undefined,
    };
  }

  let project: string | null = args.project ?? null;
  let includeProjects: string[] | undefined =
    args.includeProjects && args.includeProjects.length > 0
      ? [...args.includeProjects]
      : undefined;

  // Active-project fallback when caller didn't pass any scope.
  const noScope = !project && (!includeProjects || includeProjects.length === 0);
  if (noScope) {
    const active = await warm.getActiveProject(userId);
    if (active) {
      if (args.unionWithActive) includeProjects = [active];
      else project = active;
    }
  }

  if (project) {
    project = await resolveOne(warm, userId, project);
  }
  if (includeProjects && includeProjects.length > 0) {
    const out: string[] = [];
    for (const ref of includeProjects) {
      out.push(await resolveOne(warm, userId, ref));
    }
    includeProjects = out;
  }

  return { project, includeProjects };
}

/** Resolve a single project ref (id or human name) to a canonical ULID
 *  and verify the caller is a member. Throws on miss / not-a-member. */
export async function resolveOne(
  warm: ScopeWarmStore,
  userId: string,
  ref: string,
): Promise<string> {
  const byId = await warm.getProject(ref);
  const project = byId ?? (await warm.findProjectByName(userId, ref));
  if (!project) {
    throw new Error(`no such project '${ref}' — call project_list to see ids`);
  }
  const m = await warm.getProjectMembership(project.id, userId);
  if (!m) {
    throw new Error(`not a member of project '${ref}' (id ${project.id})`);
  }
  return project.id;
}
