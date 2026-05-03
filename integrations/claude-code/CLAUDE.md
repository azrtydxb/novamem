<!--
  Append this block to the project's CLAUDE.md (or paste at the top of
  ~/.claude/CLAUDE.md if you want it across every project). Claude Code
  loads CLAUDE.md automatically into every session.
-->

# NovaMem long-term memory

You have a persistent memory system through the `novamem` MCP server. It
exposes hybrid search (keyword + vector + graph) over durable entries
the user has accumulated across sessions. Use it; don't re-derive things
the user already told you.

## When to **search** (`memory.search`)

Search before any of these:

- The user references prior work ("the auth refactor we did", "that
  decision about RRF vs min-max").
- You're about to make a non-trivial design decision — a similar one
  may already be on file.
- The user asks about a preference, convention, or constraint that
  wasn't stated this turn.
- You're starting a new task in an unfamiliar area of the codebase —
  search for it before exploring blind.

Default weights are tuned for prose. Override only when needed:

| Override                         | Use when                                                |
| -------------------------------- | ------------------------------------------------------- |
| default                          | Free-text recall.                                       |
| `{ keyword: 1, vector: 0 }`      | Looking up a specific id, symbol, file, or commit hash. |
| `{ vector: 1, keyword: 0 }`      | Semantic-only — concept matches over literal tokens.    |
| `{ graph: 1 }`                   | "What's adjacent to X?" — neighbour-driven recall.      |

Trust the score; if every hit is below ~0.4, treat it as a miss.

## When to **remember** (`memory.remember`)

Save things that will still matter next session:

- **Decisions** with reasoning ("chose drizzle over knex because …").
- **User preferences** that recur (tools, formatting, review style).
- **Hidden constraints** (legal/compliance, deadlines, dep pins).
- **Bug post-mortems** (root cause + fix), not just the fix.
- **Architecture invariants** the codebase wouldn't reveal on its own.

Do **not** save:

- Conversational context that ends with the task.
- Facts trivially derivable from the current code.
- Anything the user explicitly said is private/secret.
- Verbatim error stack traces — extract the diagnosis.

When you remember something proactively, mention it in one short
sentence ("Saved that as a memory.") so the user can correct or veto.

## Project scope

A project is a *sub-brain*. Pass `project: <id>` to scope a call to
that project; omit it for user-wide entries. Projects you can access
come back from `project.list`. If a memory clearly belongs to a project
the user is working on, scope it there.

## Decay & reinforcement

Entries decay if not accessed: `effectiveDays = 7 · log₂(hits + 1)`.
Searching an entry counts as access — re-finding important memories
keeps them warm. The user can `/forget <id>` for explicit deletion.

## Available MCP tools

`memory.search`, `memory.remember`, `memory.recent`, `memory.today`,
`memory.neighbors`, `memory.forget`, `memory.stats`, `project.list`,
`project.create`. Slash commands wrap the common ones — see
`/recall`, `/remember`, `/today`, `/forget`.
