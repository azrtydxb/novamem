---
title: Worthiness, dedup, and supersession
---

# Worthiness, dedup, and supersession

`memory_remember` is the raw write path: it applies a **worthiness gate** and **SHA-256 exact dedup** before inserting. `memory_capture` is the preferred agent-facing path: it applies the same filters, then runs a scoped retrieval check to update near-duplicates in place or supersede contradictory older facts.

## Worthiness gate

Implemented as `MemoryEngine.shouldReject(content)` returning `null` (fit to store) or a short reason string. Two rules:

1. **Too short** — `content.trim().length < 12`. A 12-char floor is a heuristic for "not durable knowledge." Single words, single emoji reactions, and most filler chat are blocked.
2. **Conversational filler** — regex match against `^(thanks?|ok(ay)?|sure|got it|great|cool|yes|no|nope|yep|alright|noted|done)\.?$`. Closes the obvious "the agent said 'ok' and remembered it" failure mode.

When rejected, `memory_remember` returns:

```json
{ "id": null, "rejected": "too short — not durable knowledge" }
```

## Bypass with `force`

Set `force: true` on the remember call to skip the gate:

```json
{ "content": "x", "force": true }
```

Use only when you know what you're doing — short anchors (project ids, version pins, phone numbers) are valid; "ok" is not.

## SHA-256 dedup

Even past the gate, an entry whose content (after normalisation) hashes to a value already present in the same scope is collapsed to the existing id:

```
content_hash = sha256(normalize(content))
```

Normalisation: lowercase, collapse internal whitespace, trim. Two writes of "Tokio is the de-facto async runtime." (with different casing or extra spaces) produce the same hash.

The dedup response surfaces the existing id:

```json
{ "id": "01KQW8EKAJYNTVSGA283SF2ZGQ", "deduplicated": true }
```

The original entry's `hits` counter is incremented — duplicates count as positive signal that the content is worth keeping.

## Scope of dedup

Dedup is per `(user, project, namespace)` — the same content under different namespaces stays as separate entries. Reasoning: namespaces exist precisely so the same fact can be filed under multiple categories ("decisions" + "incidents") without collision.

## What the gate doesn't do

- **Doesn't verify factual accuracy.** That's the agent's job.
- **Doesn't check for PII.** novamem is unaware of content semantics.
- **Doesn't scan for prompt injection.** Memory entries are content the user wrote; if your agent threatens to be tricked by what it remembers, that's an upstream concern.

## Source

[`go/internal/engine/engine.go`](https://github.com/azrtydxb/novamem/blob/main/go/internal/engine/engine.go) — worthiness rejection, exact dedup on remember, and capture duplicate/supersession handling.


## Semantic duplicate/update (`memory_capture`)

After the worthiness gate and exact hash check, `memory_capture` searches active memories in the same `(user, project, namespace)` scope. If a nearby active memory is semantically close and not contradictory, NovaMem rewrites that entry in place instead of inserting another row. The response is:

```json
{ "id": "01KQW8EKAJYNTVSGA283SF2ZGQ", "deduplicated": true, "updated": true }
```

Use this for normal agent saves after meaningful work; it prevents gradual accumulation of paraphrased setup facts.

## Contradiction supersession (`memory_capture`)

If the new captured fact contradicts nearby active memories, NovaMem inserts the new fact and marks the older entries as superseded in metadata:

```json
{
  "lifecycleStatus": "superseded",
  "supersededBy": "01NEW...",
  "supersededReason": "contradiction",
  "supersededAt": "2026-05-20T05:53:00.000Z"
}
```

The capture response includes the old ids:

```json
{ "id": "01NEW...", "superseded": ["01OLD..."] }
```

Superseded and deprecated entries are hidden from normal `memory_search` / `memory_context` results. They remain stored for provenance and can still be inspected by id/admin tooling or hard-deleted with `memory_forget` if the user asks.


## Retention policies by memory type

`memory_capture` annotates entries with `metadata.retention`. The decay pass uses `retention.baseEffectiveDays` as the per-entry decay base, so long-lived preferences resist demotion while current-only deployment state ages out more quickly. Hygiene/evaluation tooling also surfaces this metadata. Current policies include:

- `user_preference` / `safety_constraint`: `long_lived`
- `setup_fact`: `supersede_aggressively`
- `deployment_state`: `current_only`
- `decision`: `medium_long`
- `bug_root_cause`: `medium`
- `project_convention`: `long_lived` but supersede on changed conventions
- `general`: `standard`

## Hygiene and evaluation

`/v1/hygiene` and `memory_hygiene` expose read-only candidates for cleanup: low-value memories, stale current-state entries, duplicate clusters, scalar contradiction candidates, and warm/cold orphan candidates.

`/v1/evaluate` and `memory_evaluate` run built-in quality scenarios so memory behaviour is measurable rather than anecdotal.
