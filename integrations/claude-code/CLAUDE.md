<!--
  Append this block to the project's CLAUDE.md (or paste at the top of
  ~/.claude/CLAUDE.md if you want it across every project). Claude Code
  loads CLAUDE.md automatically into every session.

  The server also ships these rules via the MCP `instructions` field on
  initialize — compliant clients thread them in automatically. Use this
  fallback when the host doesn't honour `instructions`.
-->

# NovaMem long-term memory

You have a persistent memory system through the `novamem` MCP server. It
exposes hybrid search (keyword + vector + graph) over durable entries
the user has accumulated across sessions. **Use it.** Don't re-derive
things the user already told you.

## When to call `memory.search`

Search before any of these:

- The user references prior work or a past decision.
- You're about to make a non-trivial design call — a similar one may exist.
- The user asks about a preference, convention, or constraint they didn't state this turn.
- You're starting a task in an unfamiliar area — search before exploring blind.

Default weights are tuned for prose. Useful overrides:

- `{ keyword: 1, vector: 0 }` — exact id / symbol / file / hash lookup.
- `{ vector: 1, keyword: 0 }` — semantic-only (concept over literal tokens).
- `{ graph: 1 }` — neighbour-driven recall ("what's adjacent to X?").

If every hit is below ~0.4, treat it as a miss.

## When to call `memory.remember`

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
with `{rejected: <reason>, id: null}`. Pass `force: true` to bypass
when the user explicitly asked for it. Exact duplicates within the
same scope are deduplicated automatically — the response is
`{id: <existingId>, deduplicated: true}`; treat that as success.

Provenance — when known, set:

- `sourceType`: chat / email / code-review / doc / inference / observation / system / manual
- `capturedFrom`: agent name, conversation id, or other channel ref
- `confidence`: 0..1, default 1.0. Lower for inferred facts.

When you remember something proactively, mention it in one short
sentence ("Saved that as a memory.") so the user can correct or veto.

## When to call `memory.update`

Facts evolve. When the user says "I now live in Singapore", search for
the existing "lives in" memory and `memory.update` it instead of
calling remember (which would leave the old fact alongside the new
one). Update preserves the entry's id, hit count, and graph edges; it
re-embeds when content changes. Skip the embedder by omitting `content`
if you only need to bump metadata or confidence.

## Project scope (sub-brains)

A project is a *sub-brain* — its memories are a separate shelf from
your user-global memory. Lifecycle:

- `project.list` — what you have access to.
- `project.create({name})` — own a new project.
- `project.delete({project})` — purge it (owner only).
- `project.activate({project})` — set the active project. memory.* calls
  without an explicit `project` arg default to it: search/recent/neighbors
  union user-global with the active project; remember/forget target it
  directly. Use this when the user signals they're working on a specific
  project.
- `project.deactivate` — clear the active project.
- `project.share({project, username})` — invite another user (email or
  display name). Owner only.
- `project.unshare({project, username})` — remove a member. Owner only.

When passing `project` to a memory.* call, an id (ULID) or human name
both work. Omit `project` to use whatever's active.

## Decay & reinforcement

Entries decay if not accessed: `effectiveDays = 7 · log₂(hits + 1)`.
Searching counts as access — re-finding important memories keeps them
warm.

## Available MCP tools

`memory.search`, `memory.remember`, `memory.update`, `memory.recent`,
`memory.today`, `memory.neighbors`, `memory.forget`, `memory.stats`,
`project.list`, `project.create`, `project.delete`, `project.activate`,
`project.deactivate`, `project.share`, `project.unshare`.
