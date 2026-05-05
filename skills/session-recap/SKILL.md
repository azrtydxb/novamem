---
name: session-recap
description: Run before ending a session to extract durable knowledge from the whole conversation and save it to novamem. Scans decisions, preferences, project state, bug post-mortems, and recurring constraints; proposes a list to memorize; on approval calls memory_remember for each. Use when the user says "wrap up", "save what we did", "memorize this session", "before I close this", "session recap", or runs `/session-recap`.
license: Apache-2.0
compatibility: Requires the novamem MCP server reachable + a user bearer token. See https://github.com/azrtydxb/novamem.
metadata:
  author: novamem
  version: "1.0"
  homepage: https://github.com/azrtydxb/novamem
---

# Session recap → novamem

The user is about to end the session. Your job: review the entire conversation and save what's worth keeping in their persistent memory store, so the next session — whether minutes or weeks later — picks up with the context intact.

This is a **two-phase** skill: propose first, then write after the user approves. Don't silently dump every line of the conversation into memory.

## What to extract

Walk the conversation and pick out items that match these categories. Reject everything else.

**KEEP** these:

| Type | Example |
|---|---|
| **Decisions with reasoning** | "Chose Postgres over SQLite because we need concurrent writes + FTS5 wasn't enough for our query shapes." |
| **User preferences** | "User prefers terse commit messages with a single-sentence body." "Always ship one bundled PR over many small ones for refactors in this area." |
| **Hidden constraints** | "Legal flagged session-token storage; auth rewrite is driven by compliance, not tech debt." |
| **Recurring rules / conventions** | "Never merge over Copilot/Claude review comments without resolving them." |
| **Bug post-mortems** | Root cause + fix shape, not just "the bug was fixed." |
| **Architecture invariants** | Things the codebase wouldn't reveal on its own. "Server is in changesets `ignore` list — release flow is manual `vX.Y.Z` tag." |
| **External resource pointers** | "Pipeline bugs are tracked in Linear project INGEST." "Oncall watches grafana.internal/d/api-latency for request-path changes." |
| **Project state milestones** | "v1.1.5 released with project-name resolution + dashboard browser-bug fixes." |
| **Anything the user explicitly said to remember** | Phrases: "remember", "don't forget", "save this", "for next time", "make a note of". |

**REJECT** these:

- Conversational filler ("ok", "thanks", "got it")
- Verbatim error stack traces (extract the diagnosis instead)
- Code that already lives in git (the commit message + git blame are authoritative)
- One-off Q&A that doesn't generalise
- Anything the user marked private / secret
- Ephemeral state ("the build is currently running")
- Information that's trivially derivable from the current code

The novamem worthiness gate also rejects entries under 12 chars and obvious filler — but the gate is your last line of defence, not your first. Curate before calling.

## Procedure

1. **Survey the conversation.** Re-read every user-and-assistant exchange. Don't skim. Build a mental list of candidate facts in each KEEP category.

2. **Group by namespace.** Pick the right shelf for each candidate. Common patterns:
   - `decisions` — ADRs, architecture choices, tooling picks
   - `preferences` — how the user wants things done
   - `incidents` — bug post-mortems, with date prefix
   - `architecture` — invariants of the codebase
   - `project-state` — milestone-level updates
   - `references` — pointers to external resources (Linear projects, dashboards, repos)

   If the user has been working in a specific project (sub-brain) all session, scope each entry to that project. Otherwise leave them user-global.

3. **Compose each entry as durable knowledge.** Two rules:
   - **Self-contained.** A future session won't have this conversation as context — write the entry so it stands alone.
   - **Non-obvious.** If a future-you reading the codebase would know this without the memory, don't store it.

   For decisions and constraints, lead with the rule. Then a `**Why:**` line (the reason the user gave) and a `**How to apply:**` line (when/where this kicks in). The why protects against later-you blindly applying a stale rule when the original reason is gone.

4. **Show the proposed list to the user.** Present each candidate as:

   ```
   [namespace] (sourceType, confidence, project)
   <full content>
   ```

   Group by namespace. Number each so the user can drop items by number. Ask: **"Memorize all of these? Or drop / edit any first?"**

5. **Wait for confirmation** before writing. The user may:
   - Say `go` / `yes` / `save all` → call `memory_remember` for each
   - Say `drop 3, 7` → skip those, save the rest
   - Edit specific entries → apply edits, then save the rest
   - Say `cancel` → don't call anything

6. **Write each approved entry** via `memory_remember`. Set provenance fields:
   - `sourceType: "chat"` (almost always — this is from a conversation)
   - `capturedFrom: "session-recap"` so later searches can see where the memory came from
   - `confidence: 1.0` for things the user said directly; `0.7-0.9` for inferences you drew
   - `namespace: <picked-above>`
   - `project: <if-applicable>`

   For each, briefly report the response: `→ saved as <id>` or `→ deduplicated against <existing-id>` or `→ rejected: <reason>` (gate hit; usually means the entry was too short — go back and expand it, or pass `force: true` if it's a deliberate short anchor).

7. **Final summary.** Tell the user how many entries were saved, by namespace. Mention any duplicates (the dedup branch is a sign the user said the same thing in a previous session — that's signal, not noise). If anything was rejected, surface it so they can rephrase + re-run.

## Quality bar

A good recap looks like this:

```
=== Proposed: 7 entries ===

[decisions] (chat, 1.0)
1. Chose VitePress over Astro for the docs site. Why: existing docs are
   markdown, Vite-fast build, built-in left sidebar, low maintenance.
   Alternatives considered: Astro (better SEO defaults), plain HTML
   (no build step but maintenance burden).

[incidents] (chat, 1.0)
2. 2026-05-05 incident: Pages workflow failed after docs-site PR
   because Dockerfile's `pnpm -r build` tried to invoke vitepress in
   the deps-stripped build stage. Fix: COPY docs-site/package.json in
   deps stage + filter `!@azrtydxb/novamem-docs-site` from `pnpm -r
   build`. Lesson: workspace lockfile + Dockerfile must agree on
   workspace members.

[preferences] (chat, 1.0)
3. Pascal prefers PRs to land via auto-merge on green CI rather than
   manual merges. **Why:** less context-switching when running
   multi-PR sessions. **How to apply:** open a PR with auto-squash
   enabled by default; only ask before merging on destructive ops.

…

Memorize all of these?
```

## What NOT to recap

- **Don't propose** entries that are already in memory. Run a quick `memory_search` against your candidate list first; for any candidate where you find an existing entry with cosine ≥ 0.85, either skip it (if the existing entry is current) or propose a `memory_update` instead (if the new wording is meaningfully better — same id, preserves edges + hits).

- **Don't propose** anything that should rightfully be in `git log` instead of memory. A commit message describes "what changed in this commit"; a memory entry describes "what's true about this codebase / project / user that isn't already captured by code or commits."

- **Don't propose** anything secret. If the user shared API keys, tokens, internal URLs, etc. — even casually — don't write them. The store is shared across the user's agent hosts; one leaky bearer means one leaky everywhere.

## Edge cases

- **Conversation was very short.** If there's nothing durable, say so plainly: "Nothing in this session passes the durability bar — no decisions, no new constraints, no preferences expressed. Nothing to save." That's a valid result.

- **User has no active project but the whole session was about one project.** Ask whether they want a project scope before saving. Or activate the project first via `project_activate`, then save without per-call `project` overrides.

- **Bug fix session.** The fix is in git. The memory should be the *post-mortem* — root cause + the lesson — not "I added a missing newline." If you can't extract a generalisable lesson, skip it.

- **Long session with many sub-topics.** Group recap by sub-topic + namespace; don't drown the user in a flat list of 40 candidates. If you're proposing more than ~15 entries, you're probably over-eager — re-filter against the durability bar.

## See also

- [SKILL.md](../novamem/SKILL.md) — the parent novamem skill, full tool reference
- [references/remember.md](../novamem/references/remember.md) — worthiness gate + provenance fields in detail
- [references/projects.md](../novamem/references/projects.md) — when to scope to a project vs user-global
