package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// forgetBySource posts {"source_ref": ref} and returns the receipt.
func (e *oboEnv) forgetBySource(token, ref string) (int, map[string]any) {
	e.t.Helper()
	return e.do("POST", "/v1/forget", token, map[string]any{"source_ref": ref})
}

func receiptIDs(t *testing.T, out map[string]any) []string {
	t.Helper()
	raw, ok := out["ids"].([]any)
	if !ok {
		t.Fatalf("receipt has no ids array: %v", out)
	}
	ids := make([]string, 0, len(raw))
	for _, r := range raw {
		ids = append(ids, r.(string))
	}
	sort.Strings(ids)
	if int(out["count"].(float64)) != len(ids) {
		t.Fatalf("receipt count %v != len(ids) %d", out["count"], len(ids))
	}
	return ids
}

// entryExists reads the row directly, bypassing every scope rule.
func (e *oboEnv) entryExists(id string) bool {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*) FROM memory_entries WHERE id = $1`, id).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n == 1
}

func (e *oboEnv) refCount(id string) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*) FROM memory_entry_source_refs WHERE entry_id = $1`, id).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *oboEnv) recentContents(token string) []string {
	e.t.Helper()
	code, out := e.do("POST", "/v1/recent", token, map[string]any{"k": 50})
	if code != http.StatusOK {
		e.t.Fatalf("recent: %d %v", code, out)
	}
	var got []string
	for _, r := range out["results"].([]any) {
		got = append(got, r.(map[string]any)["content"].(string))
	}
	return got
}

// TestForgetBySource: DB-backed (see newOBOEnv — it fails rather than
// skips under CI when there is no database).
func TestForgetBySource(t *testing.T) {
	e := newOBOEnv(t)
	ctx := context.Background()
	acme := e.register("acme")
	globex := e.register("globex")
	alice, bob, globexAlice := acme.token(t, "alice"), acme.token(t, "bob"), globex.token(t, "alice")

	const shared = "sharepoint://sites/hr/policy.docx"

	// Alice (acme): A carries two refs, B one of them, C an unrelated one.
	const q = "wombat"
	cA, cB, cC := q+" alpha leave policy text", q+" beta leave policy text", q+" gamma unrelated text"
	idA := e.remember(alice, cA, map[string]any{"source_refs": []string{shared, "jira:HR-42"}})
	idB := e.remember(alice, cB, map[string]any{"source_refs": []string{shared}})
	idC := e.remember(alice, cC, map[string]any{"source_refs": []string{"sharepoint://sites/hr/other.docx"}})
	// The same ref string held by other tenants and users.
	cBob, cGlobex, cDefault := q+" bob note about it", q+" globex note about it", q+" default note about it"
	idBob := e.remember(bob, cBob, map[string]any{"source_refs": []string{shared}})
	idGlobex := e.remember(globexAlice, cGlobex, map[string]any{"source_refs": []string{shared}})
	idDefault := e.remember(e.userToken, cDefault, map[string]any{"source_refs": []string{shared}})

	t.Run("refs are stored per entry, in the entry's org", func(t *testing.T) {
		refs, err := e.warm.SourceRefsOf(ctx, idA)
		if err != nil || !reflect.DeepEqual(refs, []string{"jira:HR-42", shared}) {
			t.Fatalf("refs of A = %q, %v", refs, err)
		}
		var org string
		if err := e.pool.QueryRow(ctx, `SELECT organization_id FROM memory_entry_source_refs WHERE entry_id = $1 LIMIT 1`, idGlobex).Scan(&org); err != nil || org != "globex" {
			t.Fatalf("ref org = %q, %v", org, err)
		}
	})

	t.Run("exactly one of id and source_ref", func(t *testing.T) {
		for name, body := range map[string]map[string]any{
			"both":    {"id": idA, "source_ref": shared},
			"neither": {},
			"blank":   {"source_ref": "   "},
			"control": {"source_ref": "a\x01b"},
			"empty":   {"source_ref": ""},
			"toolong": {"source_ref": strings.Repeat("x", 513)},
			"number":  {"source_ref": 7},
		} {
			if code, out := e.do("POST", "/v1/forget", alice, body); code != http.StatusBadRequest {
				t.Errorf("%s: status %d %v, want 400", name, code, out)
			}
		}
		if !e.entryExists(idA) || !e.entryExists(idB) {
			t.Fatal("a rejected request deleted something")
		}
	})

	t.Run("source_refs are validated on write", func(t *testing.T) {
		many := make([]string, 33)
		for i := range many {
			many[i] = "r" + strings.Repeat("x", i)
		}
		for name, refs := range map[string]any{
			"too many":    many,
			"too long":    []string{strings.Repeat("x", 513)},
			"empty item":  []string{""},
			"blank item":  []string{"  "},
			"control":     []string{"a\nb"},
			"not a array": "x",
			"not strings": []int{1},
		} {
			for _, path := range []string{"/v1/remember", "/v1/capture"} {
				code, out := e.do("POST", path, alice, map[string]any{"content": "valid content for refs check", "source_refs": refs})
				if code != http.StatusBadRequest {
					t.Errorf("%s %s: %d %v, want 400", path, name, code, out)
				}
			}
		}
	})

	t.Run("forget by one of several refs", func(t *testing.T) {
		code, out := e.forgetBySource(alice, "jira:HR-42")
		if code != http.StatusOK {
			t.Fatalf("%d %v", code, out)
		}
		if got := receiptIDs(t, out); !reflect.DeepEqual(got, []string{idA}) {
			t.Fatalf("receipt ids = %q, want [%s]", got, idA)
		}
		if out["sourceRef"] != "jira:HR-42" {
			t.Fatalf("receipt = %v", out)
		}
		// Gone from every read path and from the tables.
		for _, c := range e.search(alice, q) {
			if c == cA {
				t.Fatal("A still in search")
			}
		}
		for _, c := range e.recentContents(alice) {
			if c == cA {
				t.Fatal("A still in recent")
			}
		}
		if got, err := e.warm.GetEntry(ctx, "org:acme/alice", idA, nil); err != nil || got != nil {
			t.Fatalf("A still readable: %v, %v", got, err)
		}
		if code, out := e.do("PUT", "/v1/memories/"+idA, alice, map[string]any{"content": "resurrect attempt"}); code == 200 && out["updated"] == true {
			t.Fatal("A still updatable")
		}
		if e.entryExists(idA) || e.refCount(idA) != 0 {
			t.Fatal("A's row or refs survive")
		}
		var fts int
		if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM memory_fts WHERE entry_id = $1`, idA).Scan(&fts); err != nil || fts != 0 {
			t.Fatalf("A's FTS shadow survives: %d %v", fts, err)
		}
		// B shares a ref but not the forgotten one.
		if !e.entryExists(idB) || !e.entryExists(idC) {
			t.Fatal("unrelated entries were removed")
		}
	})

	t.Run("org scoping and other users", func(t *testing.T) {
		// Globex's alice forgets the same ref string: only globex's entry goes.
		code, out := e.forgetBySource(globexAlice, shared)
		if code != http.StatusOK {
			t.Fatalf("%d %v", code, out)
		}
		if got := receiptIDs(t, out); !reflect.DeepEqual(got, []string{idGlobex}) {
			t.Fatalf("globex receipt = %q, want [%s]", got, idGlobex)
		}
		for _, id := range []string{idB, idC, idBob, idDefault} {
			if !e.entryExists(id) {
				t.Fatalf("globex's forget removed %s from another org or user", id)
			}
		}
		if e.entryExists(idGlobex) {
			t.Fatal("globex entry survived its own forget")
		}
		// And the other way: acme's alice must not touch bob (same org,
		// other user), the ordinary user (org default) or anyone else.
		code, out = e.forgetBySource(alice, shared)
		if code != http.StatusOK {
			t.Fatalf("%d %v", code, out)
		}
		if got := receiptIDs(t, out); !reflect.DeepEqual(got, []string{idB}) {
			t.Fatalf("alice receipt = %q, want [%s]", got, idB)
		}
		if !e.entryExists(idBob) || !e.entryExists(idDefault) || !e.entryExists(idC) {
			t.Fatal("alice's forget reached bob, the default org, or an unrelated ref")
		}
		only(t, "bob", e.search(bob, q), cBob)
		only(t, "ordinary user", e.search(e.userToken, q), cDefault)
	})

	t.Run("idempotent: a repeat forgets nothing", func(t *testing.T) {
		code, out := e.forgetBySource(alice, shared)
		if code != http.StatusOK {
			t.Fatalf("%d %v", code, out)
		}
		if got := receiptIDs(t, out); len(got) != 0 || out["count"].(float64) != 0 {
			t.Fatalf("repeat receipt = %v", out)
		}
		if code, out := e.forgetBySource(alice, "never-seen-ref"); code != http.StatusOK || out["count"].(float64) != 0 {
			t.Fatalf("unknown ref = %d %v", code, out)
		}
	})

	t.Run("the ordinary user forgets only its own", func(t *testing.T) {
		code, out := e.forgetBySource(e.userToken, shared)
		if code != http.StatusOK {
			t.Fatalf("%d %v", code, out)
		}
		if got := receiptIDs(t, out); !reflect.DeepEqual(got, []string{idDefault}) {
			t.Fatalf("receipt = %q, want [%s]", got, idDefault)
		}
		if !e.entryExists(idBob) {
			t.Fatal("a default-org forget removed an acme entry")
		}
	})

	t.Run("project entries are not reachable without the project", func(t *testing.T) {
		// A project entry is owned by the project, not the user: a forget
		// with no project, from its own author, must leave it alone —
		// forget-by-id's rule (user-wide scope only without a project).
		code, out := e.do("POST", "/v1/me/projects", e.userToken, map[string]any{"name": "refproj"})
		if code != http.StatusCreated && code != http.StatusOK {
			t.Fatalf("create project: %d %v", code, out)
		}
		pid, _ := out["id"].(string)
		if pid == "" {
			t.Fatalf("project has no id: %v", out)
		}
		const c = "quokka project note with a ref"
		id := e.remember(e.userToken, c, map[string]any{"project": pid, "source_refs": []string{"proj-ref"}})
		// A user-wide entry with the same ref must survive the project forget.
		idWide := e.remember(e.userToken, "quokka user wide note with a ref", map[string]any{"source_refs": []string{"proj-ref"}})
		// Clear the active-project default so the bare forget below is the
		// "no project" branch; an active project would default into it,
		// exactly as forget-by-id does.
		if code, out := e.do("DELETE", "/v1/me/active-project", e.userToken, nil); code/100 != 2 {
			t.Fatalf("deactivate: %d %v", code, out)
		}
		code, out = e.forgetBySource(e.userToken, "proj-ref")
		if code != 200 || !reflect.DeepEqual(receiptIDs(t, out), []string{idWide}) {
			t.Fatalf("user-scope forget = %d %v, want only the user-wide entry", code, out)
		}
		if !e.entryExists(id) {
			t.Fatal("a user-scope forget removed a project entry")
		}
		code, out = e.do("POST", "/v1/forget", e.userToken, map[string]any{"source_ref": "proj-ref", "project": pid})
		if code != 200 || !reflect.DeepEqual(receiptIDs(t, out), []string{id}) {
			t.Fatalf("project-scoped forget = %d %v", code, out)
		}
	})

	t.Run("org filters hold on their own (defense in depth)", func(t *testing.T) {
		// Corrupt the entry's org: user_id and the ref still match, so only
		// the entry's own organization_id keeps the forget out.
		idE := e.remember(alice, q+" epsilon canary entry text", map[string]any{"source_refs": []string{"canary-ref"}})
		if _, err := e.pool.Exec(ctx, `UPDATE memory_entries SET organization_id = 'globex' WHERE id = $1`, idE); err != nil {
			t.Fatal(err)
		}
		if code, out := e.forgetBySource(alice, "canary-ref"); code != 200 || out["count"].(float64) != 0 || !e.entryExists(idE) {
			t.Fatalf("entry-org filter missing: %d %v", code, out)
		}
		// Corrupt only the ref's org.
		idF := e.remember(alice, q+" zeta canary entry text", map[string]any{"source_refs": []string{"canary-ref-2"}})
		if _, err := e.pool.Exec(ctx, `UPDATE memory_entry_source_refs SET organization_id = 'globex' WHERE entry_id = $1`, idF); err != nil {
			t.Fatal(err)
		}
		if code, out := e.forgetBySource(alice, "canary-ref-2"); code != 200 || out["count"].(float64) != 0 || !e.entryExists(idF) {
			t.Fatalf("ref-org filter missing: %d %v", code, out)
		}
	})

	t.Run("dedupe merges refs into the existing entry", func(t *testing.T) {
		const c = "narwhal merged refs content is identical"
		id1 := e.remember(bob, c, map[string]any{"source_refs": []string{"src-1"}})
		for _, path := range []string{"/v1/remember", "/v1/capture"} {
			ref := "src-via-" + strings.TrimPrefix(path, "/v1/")
			code, out := e.do("POST", path, bob, map[string]any{"content": c, "source_refs": []string{ref, "src-1"}})
			if (code != 200 && code != 201) || out["id"] != id1 || out["deduplicated"] != true {
				t.Fatalf("%s: %d %v, want a dedupe onto %s", path, code, out, id1)
			}
		}
		refs, err := e.warm.SourceRefsOf(ctx, id1)
		want := []string{"src-1", "src-via-capture", "src-via-remember"}
		if err != nil || !reflect.DeepEqual(refs, want) {
			t.Fatalf("refs = %q (%v), want %q", refs, err, want)
		}
		// Forgetting a MERGED-IN source removes the entry.
		code, out := e.forgetBySource(bob, "src-via-capture")
		if code != 200 || !reflect.DeepEqual(receiptIDs(t, out), []string{id1}) {
			t.Fatalf("forget merged ref: %d %v", code, out)
		}
		if e.entryExists(id1) {
			t.Fatal("entry survived forgetting one of its merged sources")
		}
		// A dedupe with no refs adds none and is not an error.
		id2 := e.remember(bob, c, nil)
		if e.refCount(id2) != 0 {
			t.Fatal("refs appeared from nowhere")
		}
	})

	t.Run("forget by id still works and removes the refs", func(t *testing.T) {
		id := e.remember(bob, "by id forget keeps working text", map[string]any{"source_refs": []string{"byid"}})
		code, out := e.do("POST", "/v1/forget", bob, map[string]any{"id": id})
		if code != 200 || out["deleted"] != true || e.refCount(id) != 0 {
			t.Fatalf("%d %v refs=%d", code, out, e.refCount(id))
		}
	})

	t.Run("MCP memory_forget mirrors the HTTP receipt", func(t *testing.T) {
		s := &server{engine: e.eng, warm: e.warm}
		id := e.remember(bob, "mcp forget by source text here", map[string]any{"source_refs": []string{"mcp-ref"}})
		for _, args := range []map[string]any{{}, {"id": id, "source_ref": "mcp-ref"}} {
			if _, err := s.callTool(ctx, "org:acme/bob", "memory_forget", args); err == nil {
				t.Fatalf("memory_forget %v accepted", args)
			}
		}
		got, err := s.callTool(ctx, "org:acme/bob", "memory_forget", map[string]any{"source_ref": "mcp-ref"})
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(strings.TrimSpace(strings.ReplaceAll(sprintJSON(t, got), " ", "")), `"count":1`) || e.entryExists(id) {
			t.Fatalf("mcp receipt = %v, entry exists %v", got, e.entryExists(id))
		}
	})
}

func sprintJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
