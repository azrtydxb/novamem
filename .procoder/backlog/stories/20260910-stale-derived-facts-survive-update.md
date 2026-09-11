# Derived facts survive update and delete — and outrank the source that was corrected or removed

Status: open
Created: 2026-09-10
Epic: post-migration-gaps

## Description

With fact extraction enabled, `remember` writes a source entry and the
extractor derives `[fact]` rows from it. `PUT /v1/memories/{id}`
(`memory_update`) re-embeds the **source** and leaves every derived row
untouched, so a corrected memory keeps being contradicted by its own
derivatives.

Reproduced on the kw deployment:

1. remember "The … boiler is serviced every **30 days** without exception"
   → source row + a derived `[fact]` row, both saying 30 days
2. `PUT /v1/memories/{id}` to "… every **14 days** …" →
   `{"updated":true,"embeddingChanged":true}`
3. the derived row still reads `[fact] … serviced every 30 days …`, and
   its `metadata.fact.object` / `entities` still say 30 days; its
   `updated_at` is unchanged from creation

The search result is the damaging part — querying "how often is the …
boiler serviced" returns:

    1.480  [fact] … boiler serviced every 30 days without exception
    0.921  The … boiler is serviced every 14 days without exception

**The stale derivative outranks the correction.** An agent reading the
top hit acts on the value the user just corrected. For a memory product
that is a correctness bug, not a tidiness one: the guarantee that a
correction sticks is the point of `memory_update` existing at all.

Found while exercising the tools through Claude Code end-to-end; Claude
itself noticed and reported the discrepancy mid-run.

## Notes

The fix is tractable because the link already exists: derived rows carry
`metadata.source_chunk_id` pointing at the source entry. Nothing needs
to be inferred — the update path simply does not follow it.

**`memory_forget` does not cascade either — confirmed 2026-09-10** over
the MCP connection. Deleting a source entry leaves its derived rows in
place, and the orphan then ranks _first_ for the topic:

    memory_forget(source)  -> {"deleted": true, "coldDeleteOk": true}
    memory_search(topic)   -> 0.905  [event] … (derived, source_chunk_id
                                      points at the deleted row)

The delete path shows the same partial-touch signature as the update
path: the derivative's `metadata.sourceText` is stripped, but the row,
its `content` and its `fact` fields all survive. So both verbs reach
into the derivative and neither finishes the job.

This is the more serious half. `memory_forget` is documented as
"Permanently delete a memory entry", and a user who deletes a fact —
possibly _because_ it was sensitive — still gets it served back from
the derivative. Any fix must cover delete as well as update.

## Decision

Owner chose **re-extract on update** (2026-09-10): drop the derivatives
and re-run extraction against the new content, so derived structure
survives a correction rather than being silently lost. Delete has no
new content to extract from, so it simply removes the derivatives.

## Acceptance criteria

- [ ] updating a source entry leaves no derived row asserting the old value
- [ ] updating re-derives from the new content, so derived structure is not lost
- [ ] deleting a source entry leaves no derived row behind
- [ ] a search after either verb cannot return the superseded content
- [ ] conformance covers correct-then-search and delete-then-search, so neither can regress
