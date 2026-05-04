/**
 * Behaviour rules surfaced to host LLMs via the MCP `instructions` field
 * on `initialize`. Compliant clients (Claude Code, Claude Desktop, Cursor,
 * etc.) thread this into the model's system context for every conversation
 * that has the connector enabled — operators don't have to mirror these
 * rules into a per-agent CLAUDE.md / .cursor/rules / etc.
 *
 * Used by both:
 *   - the in-process MCP server (`/mcp/sse` for direct-SSE clients)
 *   - the stdio shim in `@azrty/novamem-mcp` for legacy clients (kept in
 *     sync via its own copy — manually re-paste on changes)
 *
 * Trade-off: the token cost is paid every turn the connector is loaded.
 * Keep this tight.
 */
export const NOVAMEM_INSTRUCTIONS = `# NovaMem long-term memory

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

A project is a *sub-brain*. \`project.list\` returns each project's id (a
ULID) and name. **Pass the id (not the name) as \`project\` on memory.*
calls** — passing the human name will 404. Omit \`project\` for user-wide
entries. If a memory clearly belongs to a project the user is working on,
scope it there.

## Decay & reinforcement

Entries decay if not accessed: \`effectiveDays = 7 · log₂(hits + 1)\`.
Searching counts as access — re-finding important memories keeps them warm.

## Tools available
\`memory.search\`, \`memory.remember\`, \`memory.recent\`, \`memory.today\`,
\`memory.neighbors\`, \`memory.forget\`, \`memory.stats\`, \`project.list\`,
\`project.create\`.
`;
