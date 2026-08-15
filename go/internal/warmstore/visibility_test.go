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
	// Branch two: project rows, joined through the unique membership
	// index — that uniqueness is what makes UNION ALL exact.
	if !strings.Contains(sql, "JOIN project_members pm") {
		t.Errorf("missing the project-membership branch:\n%s", sql)
	}
	if strings.Contains(sql, "UNION\n") || strings.Contains(sql, "UNION ALL ALL") {
		t.Errorf("unexpected set operator:\n%s", sql)
	}
}
