package warmstore

import (
	"strings"
	"testing"
)

// The point of visibleEntries is the plan it produces, which no unit
// test can see. What a test CAN protect is the shape that produced it:
// two disjoint branches instead of the correlated OR/EXISTS that made
// Postgres scan 380k rows per request. Reverting to that spelling costs
// 34-39 seconds on the bench corpus and is silent — nothing fails, the
// endpoints just crawl — so guard it here.
func TestVisibleEntriesKeepsBothBranches(t *testing.T) {
	sql := visibleEntries("namespace, cold")

	if strings.Count(sql, "namespace, cold") != 2 {
		t.Errorf("column list must appear in both branches:\n%s", sql)
	}
	if !strings.Contains(sql, "UNION ALL") {
		t.Errorf("branches must be combined with UNION ALL:\n%s", sql)
	}
	if strings.Contains(sql, "EXISTS") {
		t.Errorf("the correlated EXISTS is the slow shape this replaced:\n%s", sql)
	}
	// Branch one: the user's own unscoped rows.
	if !strings.Contains(sql, "user_id = $1 AND project_id IS NULL") {
		t.Errorf("missing the own-rows branch:\n%s", sql)
	}
	// Branch two: project rows, as a semi-join. It must NOT be a plain
	// JOIN — that pulls project_members into scope, and its own
	// user_id/project_id columns then make those names ambiguous for
	// any caller whose `cols` mentions them. Two of the three call
	// sites did, and the generated SQL failed at runtime with
	// "column reference is ambiguous" while every unit test passed.
	if !strings.Contains(sql, "project_id IN (SELECT project_id FROM project_members WHERE user_id = $1)") {
		t.Errorf("project branch must be a semi-join through IN:\n%s", sql)
	}
	if strings.Contains(sql, "JOIN project_members") {
		t.Errorf("a JOIN makes user_id/project_id ambiguous in cols:\n%s", sql)
	}
	// The ambiguity only bites when cols names a column both tables
	// have, so assert with such a cols — the shape the bug shipped in.
	amb := visibleEntries("id, user_id, project_id")
	if strings.Contains(amb, "JOIN project_members") {
		t.Errorf("ambiguous-prone cols must still avoid a join:\n%s", amb)
	}
	if strings.Contains(sql, "UNION\n") || strings.Contains(sql, "UNION ALL ALL") {
		t.Errorf("unexpected set operator:\n%s", sql)
	}
}
