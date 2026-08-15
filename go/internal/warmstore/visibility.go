package warmstore

// visibleEntries builds a subquery selecting `cols` from every
// memory_entries row user $1 may see: their own unscoped rows, plus the
// rows of every project they belong to.
//
// The obvious spelling of that is one predicate —
//
//	WHERE (user_id = $1 AND project_id IS NULL)
//	   OR EXISTS (SELECT 1 FROM project_members pm
//	               WHERE pm.project_id = memory_entries.project_id
//	                 AND pm.user_id = $1)
//
// — and Postgres cannot make an index plan out of it: the OR's second
// branch is correlated, so it runs a SubPlan per row over a sequential
// scan. Measured on novamem-bench's 380k-row table, that cost 34s for
// /v1/stats, 39s for /v1/hygiene and 35s for /v1/me/changes. Split into
// two branches, each side is an index scan and the same three queries
// answer in single-digit milliseconds.
//
// UNION ALL rather than UNION, and it is exact, not an approximation:
//
//   - the branches are disjoint — the first takes only project_id IS
//     NULL rows, the second only rows whose project_id matches a
//     membership row and is therefore NOT NULL — so nothing is counted
//     twice;
//   - the second branch is a semi-join through IN, so it yields each
//     entry at most once no matter how the membership table is shaped.
//     An inner JOIN would have been equivalent here — uq_project_members
//     is UNIQUE on (project_id, user_id) — but it also drags
//     project_members into scope, where its own user_id and project_id
//     columns make those names ambiguous in `cols`. IN keeps the only
//     table in scope memory_entries, so callers can pass plain column
//     names and expressions over them.
//
// `cols` is spliced into both branches, so it may name any column of
// memory_entries or any expression over them (`left(content, 160) AS
// snippet` is fine). It must include anything the caller ORDER BYs,
// since the sort happens outside the subquery.
func visibleEntries(cols string) string {
	return `(SELECT ` + cols + `
		   FROM memory_entries
		  WHERE user_id = $1 AND project_id IS NULL
		  UNION ALL
		 SELECT ` + cols + `
		   FROM memory_entries
		  WHERE project_id IN (SELECT project_id FROM project_members WHERE user_id = $1))`
}
