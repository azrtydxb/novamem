/**
 * Remote MCP shim — exposes a remote novamem-server's tools over MCP stdio.
 * The server's local MCP (in `packages/server/src/mcp.ts`) talks to an
 * in-process engine; this shim talks to a remote engine via HTTP using
 * `NovamemClient`.
 *
 * Authenticates with the bearer token the host sets via `NOVAMEM_TOKEN`.
 * Tokens are user-scoped (`nm_…`) — they carry every right the owning
 * user has, including project create / list / membership, because the
 * server resolves the bearer to its underlying user before dispatch.
 *
 * **Source of truth**: the canonical tool list, JSON schemas, and
 * instruction text live in `packages/server/src/mcp-tools.ts`. This
 * file mirrors them locally because the shim is published to npm and
 * cannot depend on the server package (which is private). Keep this
 * mirror in sync — the parametric test in `mcp.test.ts` cross-checks
 * the tool name set across both transports.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { NovamemClient } from "@azrtydxb/novamem";

/** Behaviour rules surfaced to the host LLM via the MCP `instructions`
 *  field on `initialize`. Compliant clients (Claude Code, Claude Desktop,
 *  Cursor, etc.) thread this into the model's system context for every
 *  conversation that has the connector enabled. Mirror of
 *  `NOVAMEM_INSTRUCTIONS` in `packages/server/src/mcp-instructions.ts`. */
const NOVAMEM_INSTRUCTIONS = `# NovaMem long-term memory

You have a persistent memory system through the \`novamem\` MCP server. It
exposes hybrid search (keyword + vector + graph) over durable entries the
user has accumulated across sessions. **Use it.** Do not wait for the user to say "use memory".

## Mandatory memory protocol

Before answering any substantive user request, call \`memory_context\` once with the user's current message. After meaningful work, call \`memory_capture\` for durable outcomes. Before asking the user to repeat context, call \`memory_context\` or \`memory_search\` first.

## When to call \`memory_search\`

Search before any of these:
- The user references prior work or a past decision.
- You're about to make a non-trivial design call — a similar one may exist.
- The user asks about a preference, convention, or constraint they didn't
  state this turn.
- You're starting a task in an unfamiliar area — search before exploring blind.

Default weights are tuned for prose. Useful overrides:
- \`{ keyword: 1, vector: 0 }\` — exact id / symbol / file / hash lookup.
- \`{ vector: 1, keyword: 0 }\` — semantic-only (concept over literal tokens).
- \`{ graph: 1 }\` — neighbour-driven recall ("what's adjacent to X?").

If every hit is below ~0.4, treat it as a miss.

## When to call \`memory_remember\`

Save things that will still matter next session:
- Decisions with reasoning ("chose drizzle over knex because…").
- User preferences that recur (tools, formatting, review style).
- Hidden constraints (legal/compliance, deadlines, dep pins).
- Bug post-mortems (root cause + fix), not just the fix itself.
- Architecture invariants the codebase wouldn't reveal on its own.

Don't save:
- Conversational context that ends with the task.
- Facts trivially derivable from the current code.
- Anything the user said is private/secret.
- Verbatim error stack traces — extract the diagnosis instead.

The server applies a worthiness gate. Inputs that are too short
(<12 chars) or obvious filler ("ok", "thanks", "noted") get rejected
with \`{rejected: <reason>, id: null}\`. Pass \`force: true\` to bypass
when the user explicitly asked for it. Exact duplicates within the
same scope are deduplicated automatically — the response is
\`{id: <existingId>, deduplicated: true}\`; treat that as success.

Provenance — when known, set:
- \`sourceType\`: chat | email | code-review | doc | inference |
  observation | system | manual (open vocab; pick what fits)
- \`capturedFrom\`: agent name, conversation id, or other channel ref
- \`confidence\`: 0..1, default 1.0. Lower for inferred facts.

When you remember something proactively, mention it in one short sentence
("Saved that as a memory.") so the user can correct or veto.

## When to call \`memory_update\`

Facts evolve. When the user says "I now live in Singapore", search for
the existing "lives in" memory and \`memory_update\` it instead of
calling remember (which would leave the old fact alongside the new
one). Update preserves the entry's id, hit count, and graph edges; it
re-embeds when content changes. Skip the embedder by omitting
\`content\` if you only need to bump metadata or confidence.

## Project scope (sub-brains)

A project is a *sub-brain* — its memories are a separate shelf from your
user-global memory. Lifecycle:

- \`project_list\` — what you have access to (id + name + role).
- \`project_create({name})\` — own a new project.
- \`project_delete({project})\` — purge it (owner only).
- \`project_activate({project})\` — set the active project. Subsequent
  memory_* calls without an explicit \`project\` arg default to it:
  search/recent/neighbors union user-global with the active project,
  remember/forget target it directly. Use this when the user signals
  they're working on a specific project ("I'm working on Apollo
  today" / "context: Phoenix migration").
- \`project_deactivate\` — clear the active project.
- \`project_share({project, username})\` — invite another user (email
  or display name). Owner only.
- \`project_unshare({project, username})\` — remove a member. Owner only.

When passing \`project\` explicitly to a memory_* call, an id (ULID)
or human name both work. Omit \`project\` to use whatever's active.

## Decay & reinforcement

Entries decay if not accessed: \`effectiveDays = 7 · log₂(hits + 1)\`.
Searching counts as access — re-finding important memories keeps them warm.

## Tools available
\`memory_context\`, \`memory_capture\`, \`memory_session_recap\`, \`memory_hygiene\`, \`memory_evaluate\`, \`memory_adoption\`,
\`memory_search\`, \`memory_remember\`, \`memory_update\`, \`memory_recent\`, \`memory_today\`, \`memory_neighbors\`,
\`memory_forget\`, \`memory_stats\`, \`project_list\`, \`project_create\`, \`project_delete\`, \`project_activate\`,
\`project_deactivate\`, \`project_share\`, \`project_unshare\`.
`;

/** Mirror of `TOOL_DEFINITIONS` in
 *  `packages/server/src/mcp-tools.ts`. Keep in sync. */
const TOOL_DEFINITIONS = [
  {
    name: "memory_context",
    description: "Mandatory first-pass grounding tool. Call before substantive requests; returns relevant + recent context.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        k: { type: "number" },
        namespace: { type: "string" },
        includeNamespaces: { type: "array", items: { type: "string" } },
        maxSensitivity: { type: "string", enum: ["public", "internal", "private", "sensitive"] },
        project: { type: "string" },
        includeProjects: { type: "array", items: { type: "string" } },
        weights: { type: "object" },
      },
      required: ["message"],
    },
  },
  {
    name: "memory_capture",
    description: "Low-friction durable write path for decisions, preferences, verified setup facts, and root-cause lessons.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        namespace: { type: "string" },
        source: { type: "string" },
        sourceType: { type: "string" },
        capturedFrom: { type: "string" },
        confidence: { type: "number" },
        force: { type: "boolean" },
        project: { type: "string" },
        metadata: { type: "object" },
        sensitivity: { type: "string", enum: ["public", "internal", "private", "sensitive"] },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_session_recap",
    description: "Ingest a concise end-of-session recap as durable typed memories.",
    inputSchema: {
      type: "object",
      properties: {
        decisions: { type: "array", items: { type: "string" } },
        setupFacts: { type: "array", items: { type: "string" } },
        rootCauses: { type: "array", items: { type: "string" } },
        preferences: { type: "array", items: { type: "string" } },
        projectConventions: { type: "array", items: { type: "string" } },
        safetyConstraints: { type: "array", items: { type: "string" } },
        other: { type: "array", items: { type: "string" } },
        namespace: { type: "string" },
        source: { type: "string" },
        sourceType: { type: "string" },
        capturedFrom: { type: "string" },
        confidence: { type: "number" },
        force: { type: "boolean" },
        project: { type: "string" },
        metadata: { type: "object" },
        sensitivity: { type: "string", enum: ["public", "internal", "private", "sensitive"] },
      },
    },
  },

  {
    name: "memory_hygiene",
    description: "Read-only hygiene report for memory curation candidates.",
    inputSchema: {
      type: "object",
      properties: { k: { type: "number" } },
    },
  },
  {
    name: "memory_evaluate",
    description: "Run built-in memory quality evaluation scenarios.",
    inputSchema: {
      type: "object",
      properties: { suite: { type: "string" } },
    },
  },

  {
    name: "memory_adoption",
    description: "Read-only client adoption report with current tool surface, instructions hash, feature flags, diagnostics, and refresh guidance.",
    inputSchema: {
      type: "object",
      properties: {
        client: { type: "string" },
        observedTools: { type: "array", items: { type: "string" } },
        observedInstructionsHash: { type: "string" },
      },
    },
  },
  {
    name: "memory_search",
    description:
      "Hybrid search across stored memories (remote novamem). Always runs keyword (FTS) + vector (cosine) + graph (neighbours) in parallel and fuses with weighted scoring. Default weights: keyword 0.3, vector 0.6, graph 0.1. Override `weights` only when you have a specific reason — e.g. `{ keyword: 1, vector: 0 }` for exact-id lookup, or `{ vector: 1, keyword: 0 }` to ignore literal overlap. Pass `project` to scope to a sub-brain you have access to (or omit to search user-wide entries).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        k: { type: "number" },
        namespace: { type: "string" },
        includeNamespaces: { type: "array", items: { type: "string" } },
        maxSensitivity: { type: "string", enum: ["public", "internal", "private", "sensitive"] },
        project: {
          type: "string",
          description: "Project id or name. Omit for user-wide entries.",
        },
        includeProjects: { type: "array", items: { type: "string" } },
        weights: {
          type: "object",
          properties: {
            keyword: { type: "number" },
            vector: { type: "number" },
            graph: { type: "number" },
          },
        },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_remember",
    description: "Store a new memory entry (remote novamem)",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        namespace: { type: "string" },
        source: { type: "string" },
        sourceType: { type: "string" },
        capturedFrom: { type: "string" },
        confidence: { type: "number", description: "0..1" },
        force: { type: "boolean" },
        project: { type: "string", description: "Project id or name." },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_today",
    description: "Recent entries (last 24h)",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        includeNamespaces: { type: "array", items: { type: "string" } },
        maxSensitivity: { type: "string", enum: ["public", "internal", "private", "sensitive"] },
        k: { type: "number" },
        project: { type: "string" },
        includeProjects: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "memory_recent",
    description:
      "Recent entries in a namespace, ordered newest first. Optional ISO-8601 `since` lower bound.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        includeNamespaces: { type: "array", items: { type: "string" } },
        maxSensitivity: { type: "string", enum: ["public", "internal", "private", "sensitive"] },
        k: { type: "number" },
        since: { type: "string" },
        project: { type: "string" },
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
        depth: { type: "number" },
        k: { type: "number" },
        project: { type: "string" },
        includeProjects: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_forget",
    description: "Explicit deletion of a memory entry",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        project: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_update",
    description:
      "Rewrite an existing memory in place. Preserves id, hit count, edges, and creation date; rewrites content (re-embedded), namespace, metadata, and provenance fields. Omit `content` to update only metadata-side fields without re-embedding.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        content: { type: "string" },
        namespace: { type: "string" },
        metadata: { type: "object" },
        sourceType: { type: "string" },
        capturedFrom: { type: "string" },
        confidence: { type: "number" },
        project: { type: "string" },
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
    description: "List projects the caller is a member of (id + name + role).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "project_create",
    description: "Create a new project and become its owner. Returns the project's id.",
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
    description: "Delete a project owned by the caller. Caller must be the owner.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Project id or name." } },
      required: ["project"],
    },
  },
  {
    name: "project_activate",
    description:
      "Set the caller's active project. Subsequent memory_* calls without an explicit `project` arg default to this scope.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Project id or name." } },
      required: ["project"],
    },
  },
  {
    name: "project_deactivate",
    description: "Clear the caller's active project. Reads/writes default to user-global again.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "project_share",
    description:
      "Add another user as a member of a project the caller owns. Username may be email or display name.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id or name." },
        username: { type: "string", description: "Email or display name." },
      },
      required: ["project", "username"],
    },
  },
  {
    name: "project_unshare",
    description: "Remove a member from a project. Caller must be the owner.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id or name." },
        username: { type: "string", description: "Email or display name." },
      },
      required: ["project", "username"],
    },
  },
] as const;

type ToolAnnotations = {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

function annotationsFor(name: string): ToolAnnotations {
  if (["memory_context", "memory_hygiene", "memory_evaluate", "memory_adoption", "memory_search", "memory_today", "memory_recent", "memory_neighbors", "memory_stats", "project_list"].includes(name)) {
    return { title: name, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  }
  if (["memory_forget", "project_delete", "project_unshare"].includes(name)) {
    return { title: name, readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  }
  return { title: name, readOnlyHint: false, destructiveHint: false, idempotentHint: ["memory_update", "project_activate", "project_deactivate", "project_share"].includes(name), openWorldHint: false };
}

const TOOL_DEFINITIONS_WITH_ANNOTATIONS = TOOL_DEFINITIONS.map((t) => ({
  ...t,
  annotations: annotationsFor(t.name),
}));

/** Lightweight shape-validators for tool args. The shim deliberately
 *  doesn't pull in zod — most validation can fall back to the server,
 *  which is the real authority. We just narrow the obvious required
 *  fields here to give a sharp error before the network round-trip. */
function asStr(v: unknown, label: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`'${label}' must be a non-empty string`);
  }
  return v;
}
function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function optNum(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function optBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function optStrArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return out.length > 0 ? out : undefined;
}
function optProject(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}


export interface RemoteMcpServerOptions {
  /** Base URL the host configured via NOVAMEM_BASE_URL. */
  baseUrl?: string;
  /** Bearer token from NOVAMEM_TOKEN. */
  token?: string;
}

export function buildRemoteMcpServer(
  client: NovamemClient,
  opts: RemoteMcpServerOptions = {},
): Server {
  const server = new Server(
    { name: "novamem-mcp", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: NOVAMEM_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS_WITH_ANNOTATIONS as unknown as typeof TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const project = optProject(args.project);
    const includeProjects = optStrArray(args.includeProjects);
    try {
      switch (req.params.name) {
        case "memory_context": {
          const w = (args.weights ?? {}) as { keyword?: unknown; vector?: unknown; graph?: unknown };
          const weights =
            typeof w.keyword === "number" || typeof w.vector === "number" || typeof w.graph === "number"
              ? {
                  ...(typeof w.keyword === "number" ? { keyword: w.keyword } : {}),
                  ...(typeof w.vector === "number" ? { vector: w.vector } : {}),
                  ...(typeof w.graph === "number" ? { graph: w.graph } : {}),
                }
              : undefined;
          const body = {
            message: asStr(args.message, "message"),
            k: optNum(args.k),
            namespace: optStr(args.namespace),
            includeNamespaces: optStrArray(args.includeNamespaces),
            project,
            includeProjects,
            weights,
            maxSensitivity: optStr(args.maxSensitivity),
          } as unknown as Parameters<typeof client.context>[0];
          const r = await client.context(body);
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_capture": {
          const body = {
            content: asStr(args.content, "content"),
            namespace: optStr(args.namespace),
            source: optStr(args.source),
            sourceType: optStr(args.sourceType),
            capturedFrom: optStr(args.capturedFrom),
            confidence: optNum(args.confidence),
            force: optBool(args.force),
            project,
            metadata: args.metadata && typeof args.metadata === "object" ? args.metadata : undefined,
            sensitivity: optStr(args.sensitivity),
          } as unknown as Parameters<typeof client.capture>[0];
          const r = await client.capture(body);
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_session_recap": {
          const groups = [
            { items: optStrArray(args.decisions), namespace: "decisions", memoryType: "decision" },
            { items: optStrArray(args.setupFacts), namespace: "current-setup", memoryType: "setup_fact" },
            { items: optStrArray(args.rootCauses), namespace: "root-causes", memoryType: "bug_root_cause" },
            { items: optStrArray(args.preferences), namespace: "user", memoryType: "user_preference" },
            { items: optStrArray(args.projectConventions), namespace: "project-conventions", memoryType: "project_convention" },
            { items: optStrArray(args.safetyConstraints), namespace: "safety", memoryType: "safety_constraint" },
            { items: optStrArray(args.other), namespace: optStr(args.namespace) ?? "memory", memoryType: "general" },
          ];
          const results = [];
          for (const group of groups) {
            for (const content of group.items ?? []) {
              const body = {
                content,
                namespace: optStr(args.namespace) ?? group.namespace,
                source: optStr(args.source) ?? "memory_session_recap",
                sourceType: optStr(args.sourceType) ?? "summary",
                capturedFrom: optStr(args.capturedFrom) ?? "memory_session_recap",
                confidence: optNum(args.confidence),
                force: optBool(args.force),
                project,
                metadata: { ...((args.metadata && typeof args.metadata === "object") ? args.metadata : {}), memoryType: group.memoryType, recap: true },
                sensitivity: optStr(args.sensitivity),
              } as unknown as Parameters<typeof client.capture>[0];
              const r = await client.capture(body);
              results.push(...((r as { results?: unknown[] }).results ?? [r]));
            }
          }
          return { content: [{ type: "text", text: JSON.stringify({ saved: results.filter((r: any) => r?.id).length, results }) }] };
        }
        case "memory_hygiene": {
          const r = await client.hygiene({ k: optNum(args.k) });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_evaluate": {
          const r = await client.evaluate({ suite: optStr(args.suite) });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }

        case "memory_adoption": {
          const r = await client.adoption({
            client: optStr(args.client),
            observedTools: optStrArray(args.observedTools),
            observedInstructionsHash: optStr(args.observedInstructionsHash),
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_search": {
          const w = (args.weights ?? {}) as {
            keyword?: unknown;
            vector?: unknown;
            graph?: unknown;
          };
          const weights =
            typeof w.keyword === "number" || typeof w.vector === "number" || typeof w.graph === "number"
              ? {
                  ...(typeof w.keyword === "number" ? { keyword: w.keyword } : {}),
                  ...(typeof w.vector === "number" ? { vector: w.vector } : {}),
                  ...(typeof w.graph === "number" ? { graph: w.graph } : {}),
                }
              : undefined;
          // The client's SearchRequest type doesn't yet list the newer
          // body fields (includeNamespaces / includeProjects); cast through
          // unknown so they still ride the wire — the server schema accepts
          // them, and the client is a thin JSON encoder.
          const searchBody = {
            query: asStr(args.query, "query"),
            k: optNum(args.k),
            namespace: optStr(args.namespace),
            includeNamespaces: optStrArray(args.includeNamespaces),
            project,
            includeProjects,
            weights,
            maxSensitivity: optStr(args.maxSensitivity),
          } as unknown as Parameters<typeof client.search>[0];
          const r = await client.search(searchBody);
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_remember": {
          // Cast through unknown — RememberRequest in the client doesn't
          // yet list sourceType / capturedFrom / confidence / force.
          const rememberBody = {
            content: asStr(args.content, "content"),
            namespace: optStr(args.namespace),
            source: optStr(args.source),
            sourceType: optStr(args.sourceType),
            capturedFrom: optStr(args.capturedFrom),
            confidence: optNum(args.confidence),
            force: optBool(args.force),
            project,
            sensitivity: optStr(args.sensitivity),
          } as unknown as Parameters<typeof client.remember>[0];
          const r = await client.remember(rememberBody);
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_today": {
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const body = {
            namespace: optStr(args.namespace),
            includeNamespaces: optStrArray(args.includeNamespaces),
            k: optNum(args.k) ?? 20,
            since,
            project,
            includeProjects,
            maxSensitivity: optStr(args.maxSensitivity),
          } as unknown as Parameters<typeof client.recent>[0];
          const r = await client.recent(body);
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_recent": {
          const body = {
            namespace: optStr(args.namespace),
            includeNamespaces: optStrArray(args.includeNamespaces),
            k: optNum(args.k),
            since: optStr(args.since),
            project,
            includeProjects,
            maxSensitivity: optStr(args.maxSensitivity),
          } as unknown as Parameters<typeof client.recent>[0];
          const r = await client.recent(body);
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_neighbors": {
          const body = {
            id: asStr(args.id, "id"),
            depth: optNum(args.depth),
            k: optNum(args.k),
            project,
            includeProjects,
            maxSensitivity: optStr(args.maxSensitivity),
          } as unknown as Parameters<typeof client.neighbors>[0];
          const r = await client.neighbors(body);
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_forget": {
          const r = await client.forget(asStr(args.id, "id"), { project });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_update": {
          const id = asStr(args.id, "id");
          const body: Record<string, unknown> = {};
          if (typeof args.content === "string") body.content = args.content;
          if (typeof args.namespace === "string") body.namespace = args.namespace;
          if (args.metadata && typeof args.metadata === "object") body.metadata = args.metadata;
          if (typeof args.sourceType === "string") body.sourceType = args.sourceType;
          if (typeof args.capturedFrom === "string") body.capturedFrom = args.capturedFrom;
          if (typeof args.confidence === "number") body.confidence = args.confidence;
          if (typeof args.sensitivity === "string") body.sensitivity = args.sensitivity;
          if (project !== undefined) body.project = project;
          const r = await client.update(id, body);
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_stats": {
          const r = await client.stats();
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "project_list": {
          const r = await client.listProjects();
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "project_create": {
          const r = await client.createProject({ name: asStr(args.name, "name") });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "project_delete": {
          const r = await client.deleteProject(asStr(args.project, "project"));
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "project_activate": {
          const r = await client.setActiveProject(asStr(args.project, "project"));
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "project_deactivate": {
          await client.clearActiveProject();
          return { content: [{ type: "text", text: JSON.stringify({ active: null }) }] };
        }
        case "project_share": {
          const r = await client.addProjectMember(asStr(args.project, "project"), {
            username: asStr(args.username, "username"),
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "project_unshare": {
          const r = await client.removeProjectMemberByUsername(
            asStr(args.project, "project"),
            asStr(args.username, "username"),
          );
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        default:
          return {
            content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
            isError: true,
          };
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  return server;
}

export async function startRemoteMcpStdio(
  client: NovamemClient,
  opts: RemoteMcpServerOptions = {},
): Promise<void> {
  const server = buildRemoteMcpServer(client, opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Tool name set published by this shim. Exported so the parametric
 *  cross-transport test in the server package can verify the two
 *  copies stay in sync. */
export const REMOTE_MCP_TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.name);
