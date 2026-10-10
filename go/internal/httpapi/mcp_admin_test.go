package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

func TestMCPAdminReadOnlyTools(t *testing.T) {
	e := newOBOEnv(t)
	service := e.register("mcp-admin-check")
	oboToken := service.token(t, "agent")
	dreamAt := "2026-10-10T10:00:00Z"
	reaperAt := "2026-10-10T10:05:00Z"
	if err := e.warm.SetEngineState(t.Context(), warmstore.EngineStateLastDreamRun, dreamAt); err != nil {
		t.Fatal(err)
	}
	if err := e.warm.SetEngineState(t.Context(), warmstore.EngineStateLastReaperRun, reaperAt); err != nil {
		t.Fatal(err)
	}

	call := func(token, tool string) (bool, map[string]any, string) {
		t.Helper()
		post := func(sid, body string) *httptest.ResponseRecorder {
			req := httptest.NewRequest("POST", "/mcp", strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "application/json, text/event-stream")
			req.Header.Set("Authorization", "Bearer "+token)
			if sid != "" {
				req.Header.Set("Mcp-Session-Id", sid)
			}
			rec := httptest.NewRecorder()
			e.h.ServeHTTP(rec, req)
			return rec
		}
		init := post("", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}`)
		if init.Code != 200 {
			t.Fatalf("initialize: %d %s", init.Code, init.Body)
		}
		body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": map[string]any{"name": tool, "arguments": map[string]any{}}})
		rec := post(init.Header().Get("Mcp-Session-Id"), string(body))
		if rec.Code != 200 {
			t.Fatalf("%s: %d %s", tool, rec.Code, rec.Body)
		}
		var out struct {
			Result struct {
				IsError    bool           `json:"isError"`
				Structured map[string]any `json:"structuredContent"`
				Content    []struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"result"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode %s: %v", tool, err)
		}
		msg := ""
		if len(out.Result.Content) > 0 {
			msg = out.Result.Content[0].Text
		}
		return out.Result.IsError, out.Result.Structured, msg
	}

	for _, tool := range []string{"admin_list_users", "admin_list_projects", "admin_list_tokens", "admin_health", "admin_stats", "admin_audit_recent", "admin_ops_status"} {
		t.Run(tool+" admin success", func(t *testing.T) {
			isErr, structured, msg := call(e.adminToken, tool)
			if isErr || structured == nil {
				t.Fatalf("expected schema-bearing success, error=%v structured=%v message=%s", isErr, structured, msg)
			}
			if tool == "admin_list_tokens" && (strings.Contains(msg, e.adminToken) || strings.Contains(msg, e.userToken)) {
				t.Fatal("token metadata response exposed a bearer secret")
			}
			if tool == "admin_ops_status" {
				jobs, _ := structured["jobs"].(map[string]any)
				dream, _ := jobs["dream"].(map[string]any)
				reaper, _ := jobs["reaper"].(map[string]any)
				if dream["lastRunAt"] != dreamAt || reaper["lastRunAt"] != reaperAt {
					t.Fatalf("persisted job timestamps = dream %v / reaper %v", dream["lastRunAt"], reaper["lastRunAt"])
				}
			}
		})
		t.Run(tool+" non-admin denial", func(t *testing.T) {
			isErr, _, msg := call(e.userToken, tool)
			if !isErr || !strings.Contains(msg, "admin only") {
				t.Fatalf("expected admin denial, error=%v message=%s", isErr, msg)
			}
		})
		t.Run(tool+" OBO denial", func(t *testing.T) {
			isErr, _, msg := call(oboToken, tool)
			if !isErr || !strings.Contains(msg, "admin only") {
				t.Fatalf("expected OBO admin denial, error=%v message=%s", isErr, msg)
			}
		})
	}
}
