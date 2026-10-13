package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/azrtydxb/novamem/go/internal/engine"
)

// TestMCPProjectConfinedToken is issue #340: a full-scope nm_ token
// confined to one project must be held to it over /mcp exactly as it is
// over HTTP. Every scoped tool is run with such a token against a user
// who also owns user-wide entries and a second project.
func TestMCPProjectConfinedToken(t *testing.T) {
	e := newOBOEnv(t)
	ctx := context.Background()

	u, err := e.warm.CreateBAUser(ctx, "confined@example.test", "t", "", "user")
	if err != nil {
		t.Fatal(err)
	}
	p1, err := e.warm.CreateProject(ctx, engine.NewULID(), "confined-one", u.ID)
	if err != nil {
		t.Fatal(err)
	}
	p2, err := e.warm.CreateProject(ctx, engine.NewULID(), "confined-two", u.ID)
	if err != nil {
		t.Fatal(err)
	}
	label := "t"
	full, _, err := e.warm.CreateUserToken(ctx, u.ID, &label, "full", nil, nil)
	if err != nil || full == "" {
		t.Fatalf("token: %v", err)
	}
	confined, _, err := e.warm.CreateUserToken(ctx, u.ID, &label, "full", &p1.ID, nil)
	if err != nil || confined == "" {
		t.Fatalf("confined token: %v", err)
	}

	const (
		wUser  = "zyxwuserwide"
		wOther = "zyxwotherproj"
		wMine  = "zyxwmineproj"
	)
	idUser := e.remember(full, wUser+" user-wide note", map[string]any{"sourceRefs": []string{"ref:user"}})
	idOther := e.remember(full, wOther+" other project note", map[string]any{"project": p2.ID, "sourceRefs": []string{"ref:other"}})
	idMine := e.remember(full, wMine+" own project note", map[string]any{"project": p1.ID})

	mcpSession := func(tok string) func(tool string, args map[string]any) (bool, string) {
		post := func(sid, body string) *httptest.ResponseRecorder {
			req := httptest.NewRequest("POST", "/mcp", strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "application/json, text/event-stream")
			req.Header.Set("Authorization", "Bearer "+tok)
			if sid != "" {
				req.Header.Set("Mcp-Session-Id", sid)
			}
			rec := httptest.NewRecorder()
			e.h.ServeHTTP(rec, req)
			return rec
		}
		rec := post("", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}`)
		sid := rec.Header().Get("Mcp-Session-Id")
		if rec.Code != 200 || sid == "" {
			t.Fatalf("initialize: %d %s", rec.Code, rec.Body)
		}
		return func(tool string, args map[string]any) (bool, string) {
			t.Helper()
			b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call",
				"params": map[string]any{"name": tool, "arguments": args}})
			rec := post(sid, string(b))
			if rec.Code != 200 {
				t.Fatalf("%s: %d %s", tool, rec.Code, rec.Body)
			}
			var out struct {
				Result struct {
					IsError bool `json:"isError"`
				} `json:"result"`
			}
			_ = json.Unmarshal(rec.Body.Bytes(), &out)
			return out.Result.IsError, rec.Body.String()
		}
	}
	callC := mcpSession(confined)
	callU := mcpSession(full)

	content := func(id string) (string, *string) {
		var c string
		var p *string
		if err := e.pool.QueryRow(ctx, `SELECT content, project_id FROM memory_entries WHERE id = $1`, id).Scan(&c, &p); err != nil {
			return "", nil
		}
		return c, p
	}
	exists := func(id string) bool {
		var n int
		_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM memory_entries WHERE id = $1`, id).Scan(&n)
		return n == 1
	}
	// noLeak asserts a call's whole response never carries another
	// scope's entries.
	// (Ids are not checked: update and forget echo the id they were given.)
	noLeak := func(tool string, args map[string]any) (bool, string) {
		t.Helper()
		isErr, body := callC(tool, args)
		for _, w := range []string{wUser, wOther} {
			if strings.Contains(body, w) {
				// Errorf, not Fatalf: this closure holds the parent t, and
				// FailNow from a subtest goroutine aborts the whole run.
				t.Errorf("%s %v leaked %q: %s", tool, args, w, body)
			}
		}
		return isErr, body
	}

	t.Run("reads land in the token's project", func(t *testing.T) {
		for _, tool := range []string{"memory_search", "memory_context"} {
			args := map[string]any{"query": "note"}
			if tool == "memory_context" {
				args = map[string]any{"message": "note"}
			}
			isErr, body := noLeak(tool, args)
			if isErr || !strings.Contains(body, wMine) {
				t.Fatalf("%s did not return the token's own project entry: %s", tool, body)
			}
		}
		for _, tool := range []string{"memory_recent", "memory_today"} {
			isErr, body := noLeak(tool, map[string]any{})
			if isErr || !strings.Contains(body, wMine) {
				t.Fatalf("%s did not return the token's own project entry: %s", tool, body)
			}
		}
		// The unconfined token sees everything: the confinement is the
		// token's, not a change to the tools.
		for _, w := range []string{wUser} {
			if isErr, body := callU("memory_search", map[string]any{"query": w}); isErr || !strings.Contains(body, w) {
				t.Fatalf("unconfined token lost user-wide reads: %s", body)
			}
		}
	})

	t.Run("explicit other scope is refused", func(t *testing.T) {
		for _, tool := range []string{"memory_search", "memory_context", "memory_recent", "memory_today", "memory_neighbors"} {
			base := map[string]any{}
			switch tool {
			case "memory_search":
				base["query"] = "note"
			case "memory_context":
				base["message"] = "note"
			case "memory_neighbors":
				base["id"] = idMine
			}
			for _, extra := range []map[string]any{
				{"project": p2.ID}, {"project": "confined-two"}, {"includeProjects": []string{p2.ID}},
				{"includeProjects": []string{p1.ID, p2.ID}},
			} {
				args := map[string]any{}
				for k, v := range base {
					args[k] = v
				}
				for k, v := range extra {
					args[k] = v
				}
				isErr, body := noLeak(tool, args)
				if !isErr || !strings.Contains(body, "confined") {
					t.Fatalf("%s %v should be refused as confined: %s", tool, extra, body)
				}
			}
		}
		// Naming its own project is fine, by id or name.
		for _, ref := range []string{p1.ID, "confined-one"} {
			if isErr, body := noLeak("memory_search", map[string]any{"query": "note", "project": ref}); isErr {
				t.Fatalf("own project by %q refused: %s", ref, body)
			}
		}
	})

	t.Run("neighbors cannot seed from outside the project", func(t *testing.T) {
		for _, id := range []string{idUser, idOther} {
			_, _ = noLeak("memory_neighbors", map[string]any{"id": id})
		}
	})

	t.Run("writes land in the token's project", func(t *testing.T) {
		for _, tc := range []struct {
			tool string
			args map[string]any
			word string
		}{
			{"memory_remember", map[string]any{"content": "zyxwwrite remember implicit"}, "zyxwwrite remember implicit"},
			{"memory_capture", map[string]any{"content": "zyxwwrite capture implicit entry"}, "zyxwwrite capture implicit entry"},
			{"memory_session_recap", map[string]any{"decisions": []string{"zyxwwrite recap implicit decision"}}, "zyxwwrite recap implicit decision"},
		} {
			if isErr, body := callC(tc.tool, tc.args); isErr {
				t.Fatalf("%s: %s", tc.tool, body)
			}
			var proj *string
			err := e.pool.QueryRow(ctx, `SELECT project_id FROM memory_entries WHERE content = $1`, tc.word).Scan(&proj)
			if err != nil || proj == nil || *proj != p1.ID {
				t.Fatalf("%s implicit scope: project_id = %v err %v, want %s", tc.tool, proj, err, p1.ID)
			}
			// An explicit other project is refused and writes nothing.
			bad := map[string]any{"project": p2.ID}
			for k, v := range tc.args {
				bad[k] = v
			}
			switch tc.tool {
			case "memory_session_recap":
				bad["decisions"] = []string{"zyxwbad recap"}
			default:
				bad["content"] = "zyxwbad " + tc.tool
			}
			if isErr, body := callC(tc.tool, bad); !isErr {
				t.Fatalf("%s into another project should be refused: %s", tc.tool, body)
			}
		}
		var n int
		_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM memory_entries WHERE content LIKE 'zyxwbad%'`).Scan(&n)
		if n != 0 {
			t.Fatalf("refused writes still stored %d rows", n)
		}
	})

	t.Run("id-targeted update and forget stay inside the project", func(t *testing.T) {
		for _, id := range []string{idUser, idOther} {
			_, _ = noLeak("memory_update", map[string]any{"id": id, "content": "overwritten zyxw"})
			if c, _ := content(id); strings.Contains(c, "overwritten") {
				t.Fatalf("confined token updated %s", id)
			}
			_, _ = noLeak("memory_forget", map[string]any{"id": id})
			if !exists(id) {
				t.Fatalf("confined token forgot %s", id)
			}
			// Even naming the entry's real project does not widen it.
			_, _ = noLeak("memory_forget", map[string]any{"id": id, "project": p2.ID})
			if !exists(id) {
				t.Fatalf("confined token forgot %s via explicit project", id)
			}
		}
	})

	t.Run("forget by source ref is confined", func(t *testing.T) {
		for _, args := range []map[string]any{
			{"sourceRef": "ref:user"}, {"sourceRef": "ref:other"},
			{"sourceRef": "ref:other", "project": p2.ID},
		} {
			_, _ = noLeak("memory_forget", args)
			if !exists(idUser) || !exists(idOther) {
				t.Fatalf("forget %v reached outside the project", args)
			}
		}
	})

	t.Run("in-project update and forget still work", func(t *testing.T) {
		if isErr, body := callC("memory_update", map[string]any{"id": idMine, "content": wMine + " edited"}); isErr {
			t.Fatalf("update own: %s", body)
		}
		if c, _ := content(idMine); !strings.HasSuffix(c, "edited") {
			t.Fatalf("own update did not apply: %q", c)
		}
		if isErr, body := callC("memory_forget", map[string]any{"id": idMine}); isErr {
			t.Fatalf("forget own: %s", body)
		}
		if exists(idMine) {
			t.Fatal("own entry survived forget")
		}
	})

	t.Run("account-wide tools are refused", func(t *testing.T) {
		for tool, args := range map[string]map[string]any{
			"memory_stats": {}, "memory_hygiene": {}, "memory_evaluate": {},
			"project_list": {}, "project_create": {"name": "x"}, "project_delete": {"project": p1.ID},
			"project_activate": {"project": p1.ID}, "project_deactivate": {},
			"project_share":   {"project": p1.ID, "username": "a@b.test"},
			"project_unshare": {"project": p1.ID, "username": "a@b.test"},
		} {
			if isErr, body := callC(tool, args); !isErr || !strings.Contains(body, "confined") {
				t.Fatalf("%s should be refused for a confined token: %s", tool, body)
			}
		}
		var n int
		_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM projects WHERE name = 'x'`).Scan(&n)
		if n != 0 {
			t.Fatal("confined token created a project")
		}
	})

	t.Run("unconfined token is unaffected", func(t *testing.T) {
		for _, tool := range []string{"memory_stats", "memory_hygiene", "project_list"} {
			if isErr, body := callU(tool, map[string]any{}); isErr {
				t.Fatalf("%s: %s", tool, body)
			}
		}
		if isErr, body := callU("memory_remember", map[string]any{"content": "zyxwfree implicit user-wide"}); isErr {
			t.Fatal(body)
		}
		var proj *string
		if err := e.pool.QueryRow(ctx, `SELECT project_id FROM memory_entries WHERE content = 'zyxwfree implicit user-wide'`).Scan(&proj); err != nil || proj != nil {
			t.Fatalf("unconfined implicit write should be user-wide: %v %v", proj, err)
		}
		if isErr, body := callU("memory_forget", map[string]any{"sourceRef": "ref:user"}); isErr || !strings.Contains(body, `\"count\":1`) {
			t.Fatalf("unconfined forget by ref: %s", body)
		}
		if exists(idUser) {
			t.Fatal("unconfined token could not forget its own user-wide entry")
		}
	})
}
