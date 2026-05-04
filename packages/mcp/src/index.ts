/**
 * Remote MCP shim — exposes a remote novamem-server's tools over MCP stdio.
 * The server's local MCP (in packages/server/src/mcp.ts) talks to an
 * in-process engine; this shim talks to a remote engine via HTTP.
 *
 * Authenticates with the bearer token the host sets via NOVAMEM_TOKEN.
 * Tokens are user-scoped (`nm_…`) — they carry every right the owning
 * user has, including project create / list / membership, because the
 * server resolves the bearer to its underlying user before dispatch.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { NovamemClient } from "@azrty/novamem";

/** Behaviour rules surfaced to the host LLM via the MCP `instructions`
 *  field on `initialize`. Compliant clients (Claude Code, Claude Desktop,
 *  Cursor, etc.) thread this into the model's system context for every
 *  conversation that has the connector enabled — so the operator doesn't
 *  have to mirror these rules into a per-agent CLAUDE.md / .cursor/rules
 *  / etc. The trade-off is that the token cost is paid every turn while
 *  the connector is loaded; keep it tight. */
const NOVAMEM_INSTRUCTIONS = `# NovaMem long-term memory

You have a persistent memory system through the \`novamem\` MCP server. It
exposes hybrid search (keyword + vector + graph) over durable entries the
user has accumulated across sessions. **Use it.** Don't re-derive things the
user already told you.

## When to call \`memory.search\`

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

## When to call \`memory.remember\`

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

When you remember something proactively, mention it in one short sentence
("Saved that as a memory.") so the user can correct or veto.

## Project scope

A project is a *sub-brain*. Pass \`project: <id>\` to scope a call to that
project; omit it for user-wide entries. \`project.list\` returns the
projects the caller can access. If a memory clearly belongs to a project
the user is working on, scope it there.

## Decay & reinforcement

Entries decay if not accessed: \`effectiveDays = 7 · log₂(hits + 1)\`.
Searching counts as access — re-finding important memories keeps them warm.

## Tools available
\`memory.search\`, \`memory.remember\`, \`memory.recent\`, \`memory.today\`,
\`memory.neighbors\`, \`memory.forget\`, \`memory.stats\`, \`project.list\`,
\`project.create\`.
`;

export function buildRemoteMcpServer(client: NovamemClient): Server {
  const server = new Server(
    { name: "novamem-mcp", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: NOVAMEM_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "memory.search",
        description:
          "Hybrid search across stored memories (remote novamem). Always runs keyword (FTS) + vector (cosine) + graph (neighbours) in parallel and fuses with weighted scoring. Default weights: keyword 0.3, vector 0.6, graph 0.1. Override `weights` only when you have a specific reason — e.g. `{ keyword: 1, vector: 0 }` for exact-id lookup, or `{ vector: 1, keyword: 0 }` to ignore literal overlap. Pass `project` to scope to a sub-brain you have access to (or omit to search user-wide entries).",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            k: { type: "number" },
            namespace: { type: "string" },
            project: {
              type: "string",
              description: "Project (sub-brain) id. Omit for user-wide entries.",
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
          required: ["query"],
        },
      },
      {
        name: "memory.remember",
        description: "Store a new memory entry (remote novamem)",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string" },
            namespace: { type: "string" },
            source: { type: "string" },
            project: { type: "string", description: "Project (sub-brain) to write into." },
          },
          required: ["content"],
        },
      },
      {
        name: "memory.today",
        description: "Recent entries (last 24h)",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            k: { type: "number" },
            project: { type: "string" },
          },
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
            since: { type: "string" },
            project: { type: "string" },
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
            depth: { type: "number" },
            k: { type: "number" },
            project: { type: "string" },
          },
          required: ["id"],
        },
      },
      {
        name: "memory.forget",
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
        name: "memory.stats",
        description: "Service-wide stats snapshot",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "project.list",
        description:
          "List projects (sub-brains) the current caller is a member of. Requires a dashboard session bearer (NOVAMEM_TOKEN starting with `ns_`); user-bearer (`nm_`) callers will get an error.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "project.create",
        description:
          "Create a new project (sub-brain) and become its owner. Memory operations using this project as `project` are scoped to it. Requires a dashboard session bearer (NOVAMEM_TOKEN starting with `ns_`).",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Slug (2–64 chars; alphanumeric / dot / underscore / dash).",
            },
            name: { type: "string", description: "Display name" },
          },
          required: ["id", "name"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const project = typeof args.project === "string" && args.project.length > 0 ? args.project : undefined;
    try {
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
          const r = await client.search({
            query: String(args.query),
            k: typeof args.k === "number" ? args.k : undefined,
            namespace: typeof args.namespace === "string" ? args.namespace : undefined,
            project,
            weights,
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory.remember": {
          const r = await client.remember({
            content: String(args.content),
            namespace: typeof args.namespace === "string" ? args.namespace : undefined,
            source: typeof args.source === "string" ? args.source : undefined,
            project,
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory.today": {
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const r = await client.recent({
            namespace: typeof args.namespace === "string" ? args.namespace : undefined,
            k: typeof args.k === "number" ? args.k : 20,
            since,
            project,
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory.recent": {
          const r = await client.recent({
            namespace: typeof args.namespace === "string" ? args.namespace : undefined,
            k: typeof args.k === "number" ? args.k : undefined,
            since: typeof args.since === "string" ? args.since : undefined,
            project,
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory.neighbors": {
          const r = await client.neighbors({
            id: String(args.id),
            depth: typeof args.depth === "number" ? args.depth : undefined,
            k: typeof args.k === "number" ? args.k : undefined,
            project,
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory.forget": {
          const r = await client.forget(String(args.id), { project });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory.stats": {
          const r = await client.stats();
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "project.list": {
          const r = await client.listProjects();
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "project.create": {
          const r = await client.createProject({
            id: String(args.id),
            name: String(args.name),
          });
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

export async function startRemoteMcpStdio(client: NovamemClient): Promise<void> {
  const server = buildRemoteMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
