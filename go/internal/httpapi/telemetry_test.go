package httpapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/azrtydxb/novamem/go/internal/engine"
)

func TestAdminTelemetryAggregatesWithoutContentAndRequiresAdmin(t *testing.T) {
	e := newOBOEnv(t)
	ctx := context.Background()
	owner, err := e.warm.CreateBAUser(ctx, "telemetry@example.test", "t", "", "user")
	if err != nil {
		t.Fatal(err)
	}
	project, err := e.warm.CreateProject(ctx, engine.NewULID(), "project-opaque", owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	created := time.Now().UTC().Add(-24 * time.Hour)
	for _, row := range []struct {
		id, namespace, project, agent, sens string
		cold, embedded, factsPending        bool
	}{
		{"telemetry-a", "work", project.ID, "agent-x", "private", false, true, false},
		{"telemetry-b", "work", project.ID, "agent-x", "internal", true, false, true},
	} {
		_, err := e.pool.Exec(ctx, `INSERT INTO memory_entries (id,user_id,project_id,content,namespace,agent_name,cold,embedded_at,facts_pending_at,metadata,created_at) VALUES ($1,'public',$2,'must-not-leak',$3,$4,$5,CASE WHEN $6 THEN now() ELSE NULL END,CASE WHEN $7 THEN now() ELSE NULL END,jsonb_build_object('sensitivity',$8::text),$9)`, row.id, row.project, row.namespace, row.agent, row.cold, row.embedded, row.factsPending, row.sens, created)
		if err != nil {
			t.Fatal(err)
		}
	}
	if status, _ := e.do("GET", "/v1/admin/telemetry", e.userToken, nil); status != 403 {
		t.Fatalf("non-admin status=%d, want 403", status)
	}
	status, body := e.do("GET", "/v1/admin/telemetry", e.adminToken, nil)
	if status != 200 {
		t.Fatalf("admin status=%d body=%v", status, body)
	}
	if body["totalEntries"] != float64(2) || body["embeddedEntries"] != float64(1) || body["pendingEmbeddings"] != float64(1) || body["pendingExtractions"] != float64(1) {
		t.Fatalf("unexpected totals: %#v", body)
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "must-not-leak") || strings.Contains(string(encoded), "telemetry-a") {
		t.Fatalf("telemetry leaked memory content or entry ids: %s", encoded)
	}
	var got struct {
		ByNamespace   []telemetryGroup `json:"byNamespace"`
		ByProject     []telemetryGroup `json:"byProject"`
		BySensitivity []telemetryGroup `json:"bySensitivity"`
		ByTier        []telemetryGroup `json:"byTier"`
		TopAgents     []telemetryAgent `json:"topAgents"`
		CreatedPerDay []telemetryDay   `json:"createdPerDay"`
		LastDecayAt   *string          `json:"lastDecayAt"`
	}
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	assertCount := func(rows []telemetryGroup, key string, want int64) {
		t.Helper()
		for _, row := range rows {
			if row.Key == key && row.Count == want {
				return
			}
		}
		t.Errorf("missing %s count %d in %#v", key, want, rows)
	}
	assertCount(got.ByNamespace, "work", 2)
	assertCount(got.ByProject, project.ID, 2)
	assertCount(got.BySensitivity, "private", 1)
	assertCount(got.BySensitivity, "internal", 1)
	assertCount(got.ByTier, "warm", 1)
	assertCount(got.ByTier, "cold", 1)
	if len(got.TopAgents) != 1 || got.TopAgents[0].Name != "agent-x" || got.TopAgents[0].Count != 2 {
		t.Errorf("unexpected top agents: %#v", got.TopAgents)
	}
	var growth int64
	for _, day := range got.CreatedPerDay {
		growth += day.Count
	}
	if len(got.CreatedPerDay) != 30 || growth != 2 || got.LastDecayAt != nil {
		t.Errorf("unexpected daily growth or last-run data: days=%d entries=%d lastDecayAt=%v", len(got.CreatedPerDay), growth, got.LastDecayAt)
	}
}
