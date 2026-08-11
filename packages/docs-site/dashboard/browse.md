---
title: Browse · Today · Graph
---

# Browse · Today · Graph

Three user-facing pages for exploring your memory.

## Browse

Hybrid search over your memories. Type a query → all three signals (keyword + vector + graph) run in parallel and the top-K fused results render with per-tier signal badges.

- **Empty input** falls through to recent entries (newest first).
- **+ Remember** opens a modal to add a new entry. The textarea is the focused element on open; `Esc` cancels, `⌘/Ctrl + Enter` saves.
- **Tier badges** on each row show which signal contributed: warm · cold · graph. A hit with all three shaded is a strong match.
- **Click an entry** to open its detail card with the full content + provenance fields (`sourceType`, `capturedFrom`, `confidence`, `createdAt`, `hits`).

## Today

A read-only feed of the last 24 h of activity:

- New `remember` entries
- Tokens minted by you
- Project joins (you joined a project as a member)
- Audit-log entries that name you as the actor (password resets, role changes)

Mixed and ranked by timestamp. Useful as a daily digest of "what did the agent learn today on my behalf."

## Graph

Visual neighbourhood of a seed entry. Pick an entry → it renders at the centre with strongly-linked neighbours arranged in a circle. Click any node to recenter on it; the inspector card on the right shows that node's content + signal scores.

- **Depth slider** (1, 2, 3) — wider walks pull in further-out neighbours. Served from the SQL relations table since Phase 7; the engine degrades to `degraded:true` only if the relations query itself fails.
- **Edge weights** are the path-product of relationship strengths along the walk; nearer = stronger.

The graph is built automatically: every new `remember` links to its top vector neighbours (configurable via `graphLinkFanout`, default 3). The nightly dream cycle promotes shared-neighbour edges.

## Active project

The sidebar's project switcher determines what each page sees:

- **Global memory only** — your private user-global entries.
- **Some project active** — user-global ∪ that project's entries. Search / recent / today / graph all union both.

Switching the active project doesn't move any data; it just widens the scope of subsequent queries.

## See also

- [Mental model](/concepts/mental-model) — the user / project / namespace hierarchy
- [Hybrid search internals](/architecture/hybrid-search)
