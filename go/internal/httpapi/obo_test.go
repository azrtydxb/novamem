package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/azrtydxb/novamem/go/internal/auth"
	"github.com/azrtydxb/novamem/go/internal/engine"
	"github.com/azrtydxb/novamem/go/internal/metrics"
	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

// oboEnv is a real server over a freshly created, throwaway database.
type oboEnv struct {
	t          *testing.T
	h          http.Handler
	pool       *pgxpool.Pool
	adminToken string
	userToken  string // an ordinary nm_ user (org "default")
	eng        *engine.Engine
	warm       *warmstore.Store
}

// newOBOEnv skips without NOVAMEM_TEST_DATABASE_URL, except in CI, where
// a missing database means the job lost its Postgres service and the
// organization-isolation guarantee would silently stop being tested.
func newOBOEnv(t *testing.T) *oboEnv {
	t.Helper()
	base := os.Getenv("NOVAMEM_TEST_DATABASE_URL")
	if base == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("NOVAMEM_TEST_DATABASE_URL is unset in CI: the go job must provide Postgres")
		}
		t.Skip("set NOVAMEM_TEST_DATABASE_URL to a Postgres with the pgvector image to run")
	}
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(base)
	if err != nil {
		t.Fatal(err)
	}
	// Own database: Migrate is not serialised, and other packages' tests
	// use the base one concurrently.
	var rnd [6]byte
	_, _ = rand.Read(rnd[:])
	dbName := "novamem_obo_" + hex.EncodeToString(rnd[:])
	admin, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+dbName); err != nil {
		_ = admin.Close(ctx)
		t.Fatal(err)
	}
	_ = admin.Close(ctx)
	cfg.ConnConfig.Database = dbName
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		c, err := pgx.Connect(ctx, base)
		if err != nil {
			return
		}
		defer func() { _ = c.Close(ctx) }()
		_, _ = c.Exec(ctx, `DROP DATABASE IF EXISTS `+dbName+` WITH (FORCE)`)
	})
	log := slog.New(slog.DiscardHandler)
	if err := warmstore.Migrate(ctx, pool, log); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	warm := warmstore.New(pool)
	coll := metrics.New()
	eng := engine.New(engine.Options{Warm: warm, Log: log, MaxContentChars: 4000, Metrics: coll})
	h := New(Options{
		Metrics: coll, Pool: pool, Log: log, Engine: eng, Warm: warm,
		AuthMode: "user", CookieSecret: strings.Repeat("s", 32),
	})
	env := &oboEnv{t: t, h: h, pool: pool, eng: eng, warm: warm}

	mkToken := func(email, role string) string {
		u, err := warm.CreateBAUser(ctx, email, "t", "", role)
		if err != nil {
			t.Fatal(err)
		}
		label := "test"
		tok, _, err := warm.CreateUserToken(ctx, u.ID, &label, "full", nil, nil)
		if err != nil || tok == "" {
			t.Fatalf("token: %v", err)
		}
		return tok
	}
	env.adminToken = mkToken("admin@example.test", "admin")
	env.userToken = mkToken("user@example.test", "user")
	return env
}

func (e *oboEnv) do(method, path, token string, body any) (int, map[string]any) {
	e.t.Helper()
	var rdr *strings.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = strings.NewReader(string(b))
	} else {
		rdr = strings.NewReader("")
	}
	req := httptest.NewRequest(method, path, rdr)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

type svc struct {
	kid  string
	org  string
	priv ed25519.PrivateKey
}

func (s svc) token(t *testing.T, sub string) string {
	t.Helper()
	tok, err := auth.MintOBOToken(s.priv, s.kid, s.org, sub, time.Now(), 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func (e *oboEnv) register(org string) svc {
	e.t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	code, out := e.do("POST", "/v1/admin/service-keys", e.adminToken, map[string]any{
		"name": "svc-" + org, "organizationId": org, "publicKey": auth.EncodeServicePublicKey(pub),
	})
	if code != http.StatusCreated {
		e.t.Fatalf("register %s: %d %v", org, code, out)
	}
	return svc{kid: out["id"].(string), org: org, priv: priv}
}

func (e *oboEnv) remember(token, content string, extra map[string]any) string {
	e.t.Helper()
	body := map[string]any{"content": content}
	for k, v := range extra {
		body[k] = v
	}
	code, out := e.do("POST", "/v1/remember", token, body)
	if code != http.StatusCreated && code != http.StatusOK {
		e.t.Fatalf("remember: %d %v", code, out)
	}
	id, _ := out["id"].(string)
	if id == "" {
		e.t.Fatalf("remember returned no id: %v", out)
	}
	return id
}

// search returns the contents a keyword search returns.
func (e *oboEnv) search(token, query string) []string {
	e.t.Helper()
	code, out := e.do("POST", "/v1/search", token, map[string]any{"query": query, "k": 20})
	// The test server has no embedder, so the vector tier is down: a
	// search that matches nothing answers 503 {degraded:true, results:[]}
	// instead of 200 {results:[]}. Both mean "no results here".
	degradedEmpty := code == http.StatusServiceUnavailable && out["degraded"] == true
	if code != http.StatusOK && !degradedEmpty {
		e.t.Fatalf("search: %d %v", code, out)
	}
	var contents []string
	results, _ := out["results"].([]any)
	for _, r := range results {
		contents = append(contents, r.(map[string]any)["content"].(string))
	}
	return contents
}

func only(t *testing.T, who string, got []string, want string) {
	t.Helper()
	if len(got) != 1 || got[0] != want {
		t.Fatalf("%s: results = %q, want exactly [%q]", who, got, want)
	}
}

func TestOnBehalfOfToken(t *testing.T) {
	e := newOBOEnv(t)
	ctx := context.Background()
	acme := e.register("acme")
	globex := e.register("globex")

	acmeAlice, acmeBob, globexAlice := acme.token(t, "alice"), acme.token(t, "bob"), globex.token(t, "alice")

	const q = "zebra quokka"
	cAcmeAlice := q + " acme alice note"
	cGlobexAlice := q + " globex alice note"
	cDefault := q + " default user note"
	idAcme := e.remember(acmeAlice, cAcmeAlice, nil)
	idGlobex := e.remember(globexAlice, cGlobexAlice, nil)
	e.remember(e.userToken, cDefault, nil)

	t.Run("search is scoped by org and user", func(t *testing.T) {
		only(t, "acme/alice", e.search(acmeAlice, q), cAcmeAlice)
		only(t, "globex/alice (same sub, other org)", e.search(globexAlice, q), cGlobexAlice)
		if got := e.search(acmeBob, q); len(got) != 0 {
			t.Fatalf("acme/bob sees another user's entries: %q", got)
		}
		only(t, "ordinary user", e.search(e.userToken, q), cDefault)
	})

	t.Run("recent and stats are scoped", func(t *testing.T) {
		code, out := e.do("POST", "/v1/recent", acmeAlice, map[string]any{"k": 20})
		if code != 200 {
			t.Fatalf("recent %d %v", code, out)
		}
		res := out["results"].([]any)
		if len(res) != 1 || res[0].(map[string]any)["id"] != idAcme {
			t.Fatalf("recent = %v", out)
		}
		code, out = e.do("POST", "/v1/recent", acmeBob, map[string]any{"k": 20})
		if code != 200 || len(out["results"].([]any)) != 0 {
			t.Fatalf("bob recent = %d %v", code, out)
		}
		code, out = e.do("GET", "/v1/stats", acmeAlice, nil)
		if code != 200 {
			t.Fatalf("stats %d %v", code, out)
		}
		if total := fmt.Sprint(out["totalWarm"]); total != "1" {
			t.Fatalf("stats totalWarm = %s, want 1 (%v)", total, out)
		}
	})

	t.Run("rows carry the organization", func(t *testing.T) {
		rows, err := e.pool.Query(ctx, `SELECT organization_id, user_id FROM memory_entries ORDER BY organization_id`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		got := map[string]string{}
		for rows.Next() {
			var org, user string
			if err := rows.Scan(&org, &user); err != nil {
				t.Fatal(err)
			}
			got[org] = user
		}
		if got["acme"] != "org:acme/alice" || got["globex"] != "org:globex/alice" || got["default"] == "" || len(got) != 3 {
			t.Fatalf("organization_id / user_id = %v", got)
		}
	})

	t.Run("body-supplied org and user are ignored", func(t *testing.T) {
		const c = "kinkajou body override attempt"
		id := e.remember(acmeBob, c, map[string]any{
			"userId": "org:globex/alice", "user_id": "org:globex/alice",
			"organizationId": "globex", "org": "globex",
		})
		only(t, "acme/bob", e.search(acmeBob, "kinkajou"), c)
		if got := e.search(globexAlice, "kinkajou"); len(got) != 0 {
			t.Fatalf("body-supplied identity leaked into globex/alice: %q", got)
		}
		var org, user string
		if err := e.pool.QueryRow(ctx, `SELECT organization_id, user_id FROM memory_entries WHERE id = $1`, id).Scan(&org, &user); err != nil {
			t.Fatal(err)
		}
		if org != "acme" || user != "org:acme/bob" {
			t.Fatalf("stored as %s / %s", org, user)
		}
	})

	t.Run("a token cannot forget or update across org or user", func(t *testing.T) {
		for who, tok := range map[string]string{"globex/alice": globexAlice, "acme/bob": acmeBob, "ordinary user": e.userToken} {
			if code, _ := e.do("POST", "/v1/forget", tok, map[string]any{"id": idAcme}); code != http.StatusForbidden {
				t.Fatalf("%s forget: status %d, want 403", who, code)
			}
			code, out := e.do("PUT", "/v1/memories/"+idAcme, tok, map[string]any{"content": "overwritten by " + who})
			if code == http.StatusOK && out["updated"] == true {
				t.Fatalf("%s updated an entry it does not own", who)
			}
		}
		only(t, "acme/alice after attacks", e.search(acmeAlice, q), cAcmeAlice)
		if code, _ := e.do("POST", "/v1/forget", acmeAlice, map[string]any{"id": idGlobex}); code != http.StatusForbidden {
			t.Fatalf("acme/alice forgot globex's entry: %d", code)
		}
		only(t, "globex/alice after attacks", e.search(globexAlice, q), cGlobexAlice)
	})

	t.Run("the owner can update and forget", func(t *testing.T) {
		code, out := e.do("PUT", "/v1/memories/"+idAcme, acmeAlice, map[string]any{"content": cAcmeAlice + " edited"})
		if code != 200 || out["updated"] != true {
			t.Fatalf("owner update: %d %v", code, out)
		}
		only(t, "after update", e.search(acmeAlice, q), cAcmeAlice+" edited")
		code, out = e.do("POST", "/v1/forget", acmeAlice, map[string]any{"id": idAcme})
		if code != 200 || out["deleted"] != true {
			t.Fatalf("owner forget: %d %v", code, out)
		}
		if got := e.search(acmeAlice, q); len(got) != 0 {
			t.Fatalf("entry survived forget: %q", got)
		}
		only(t, "globex untouched", e.search(globexAlice, q), cGlobexAlice)
	})

	t.Run("the org column filters on its own (defense in depth)", func(t *testing.T) {
		// Corrupt a row so its user_id still says acme/dora but its
		// organization_id says globex: the user_id filter alone would
		// serve it, the org filter must not.
		const c = "pangolin org column canary"
		dora := acme.token(t, "dora")
		id := e.remember(dora, c, nil)
		only(t, "before", e.search(dora, "pangolin"), c)
		if _, err := e.pool.Exec(ctx, `UPDATE memory_entries SET organization_id = 'globex' WHERE id = $1`, id); err != nil {
			t.Fatal(err)
		}
		if got := e.search(dora, "pangolin"); len(got) != 0 {
			t.Fatalf("a row from another organization was served: %q", got)
		}
		code, out := e.do("POST", "/v1/forget", dora, map[string]any{"id": id})
		if code != 200 || out["deleted"] == true {
			t.Fatalf("forget crossed the org column: %d %v", code, out)
		}
		code, out = e.do("PUT", "/v1/memories/"+id, dora, map[string]any{"content": "pangolin hijacked"})
		if code == 200 && out["updated"] == true {
			t.Fatal("update crossed the org column")
		}
		var n int
		if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM memory_entries WHERE id = $1 AND content = $2`, id, c).Scan(&n); err != nil || n != 1 {
			t.Fatalf("row was altered or deleted: n=%d err=%v", n, err)
		}
	})

	t.Run("surfaces an OBO token may not reach", func(t *testing.T) {
		for _, c := range []struct{ method, path string }{
			{"GET", "/v1/admin/users"}, {"GET", "/v1/admin/service-keys"},
			{"POST", "/v1/admin/service-keys"}, {"POST", "/v1/me/tokens"},
			{"GET", "/v1/me/projects"}, {"POST", "/v1/auth/rotate-token"},
			{"POST", "/v1/decay"},
		} {
			code, _ := e.do(c.method, c.path, acmeAlice, map[string]any{})
			if code != http.StatusForbidden && code != http.StatusUnauthorized {
				t.Errorf("%s %s: status %d, want 403/401", c.method, c.path, code)
			}
		}
		for _, c := range []struct{ method, path string }{
			{"GET", "/v1/admin/users"}, {"GET", "/v1/me/tokens"},
		} {
			if code, _ := e.do(c.method, c.path, acmeAlice, map[string]any{}); code != http.StatusForbidden {
				t.Errorf("%s %s: status %d, want exactly 403", c.method, c.path, code)
			}
		}
	})

	t.Run("projects are denied", func(t *testing.T) {
		for _, c := range []struct {
			path string
			body map[string]any
		}{
			{"/v1/search", map[string]any{"query": q, "project": "p"}},
			{"/v1/search", map[string]any{"query": q, "includeProjects": []string{"p"}}},
			{"/v1/remember", map[string]any{"content": "x", "project": "p"}},
			{"/v1/recent", map[string]any{"project": "p"}},
		} {
			if code, out := e.do("POST", c.path, acmeAlice, c.body); code != http.StatusForbidden {
				t.Errorf("%s %v: status %d %v, want 403", c.path, c.body, code, out)
			}
		}
		// GET with the project in the query: this route once passed it
		// straight to the store without any access check.
		if code, out := e.do("GET", "/v1/context-prefix?project=p", acmeAlice, nil); code != http.StatusForbidden {
			t.Errorf("/v1/context-prefix?project=p: status %d %v, want 403", code, out)
		}
	})

	t.Run("rejected tokens", func(t *testing.T) {
		// A forged signature: right kid and org, wrong private key.
		_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
		forged := svc{kid: acme.kid, org: "acme", priv: otherPriv}.token(t, "alice")
		expired, _ := auth.MintOBOToken(acme.priv, acme.kid, "acme", "alice", time.Now().Add(-time.Hour), 5*time.Minute)
		tooLong, _ := auth.MintOBOToken(acme.priv, acme.kid, "acme", "alice", time.Now(), time.Hour)
		wrongOrg, _ := auth.MintOBOToken(acme.priv, acme.kid, "globex", "alice", time.Now(), time.Minute)
		badSub, _ := auth.MintOBOToken(acme.priv, acme.kid, "acme", "al ice", time.Now(), time.Minute)
		unknownKid, _ := auth.MintOBOToken(acme.priv, "nope", "acme", "alice", time.Now(), time.Minute)
		for name, tok := range map[string]string{
			"bad signature": forged, "expired": expired, "lifetime over the cap": tooLong,
			"org other than the key's": wrongOrg, "sub charset": badSub, "unknown kid": unknownKid,
		} {
			if code, _ := e.do("POST", "/v1/search", tok, map[string]any{"query": q}); code != http.StatusUnauthorized {
				t.Errorf("%s: status %d, want 401", name, code)
			}
		}

		// A key bound to "default" can never be registered...
		pub, priv, _ := ed25519.GenerateKey(rand.Reader)
		code, _ := e.do("POST", "/v1/admin/service-keys", e.adminToken, map[string]any{
			"name": "evil", "organizationId": "default", "publicKey": auth.EncodeServicePublicKey(pub),
		})
		if code != http.StatusBadRequest {
			t.Errorf("registering a default-org key: status %d, want 400", code)
		}
		// ...and if one got into the table anyway, it still authenticates nobody.
		k, err := warmstore.New(e.pool).CreateServiceKey(ctx, "smuggled", "evil", "default", auth.EncodeServicePublicKey(pub))
		if err != nil {
			t.Fatal(err)
		}
		smuggled, _ := auth.MintOBOToken(priv, k.ID, "default", "anyone", time.Now(), time.Minute)
		if code, _ := e.do("POST", "/v1/search", smuggled, map[string]any{"query": q}); code != http.StatusUnauthorized {
			t.Errorf("default-org key token: status %d, want 401", code)
		}
	})

	t.Run("a revoked key stops working at once", func(t *testing.T) {
		doomed := e.register("initech")
		tok := doomed.token(t, "carol")
		e.remember(tok, "wombat revocation canary", nil)
		if got := e.search(tok, "wombat"); len(got) != 1 {
			t.Fatalf("before revoke: %q", got)
		}
		if code, out := e.do("DELETE", "/v1/admin/service-keys/"+doomed.kid, e.adminToken, nil); code != 200 {
			t.Fatalf("revoke: %d %v", code, out)
		}
		if code, _ := e.do("POST", "/v1/search", tok, map[string]any{"query": "wombat"}); code != http.StatusUnauthorized {
			t.Fatalf("after revoke: status %d, want 401", code)
		}
		if code, _ := e.do("DELETE", "/v1/admin/service-keys/"+doomed.kid, e.adminToken, nil); code != http.StatusNotFound {
			t.Fatalf("second revoke: %d, want 404", code)
		}
		code, out := e.do("GET", "/v1/admin/service-keys", e.adminToken, nil)
		if code != 200 || len(out["keys"].([]any)) < 3 {
			t.Fatalf("list: %d %v", code, out)
		}
	})

	t.Run("the admin surface is admin only", func(t *testing.T) {
		if code, _ := e.do("GET", "/v1/admin/service-keys", e.userToken, nil); code != http.StatusForbidden {
			t.Fatalf("non-admin list: %d, want 403", code)
		}
		if code, _ := e.do("GET", "/v1/admin/service-keys", "", nil); code != http.StatusUnauthorized {
			t.Fatalf("anonymous list: %d, want 401", code)
		}
	})

	t.Run("ordinary nm_ tokens are unchanged", func(t *testing.T) {
		only(t, "ordinary user", e.search(e.userToken, q), cDefault)
		var org string
		if err := e.pool.QueryRow(ctx, `SELECT organization_id FROM memory_entries WHERE content = $1`, cDefault).Scan(&org); err != nil || org != "default" {
			t.Fatalf("ordinary entry org = %q, %v", org, err)
		}
		if code, _ := e.do("GET", "/v1/me/tokens", e.userToken, nil); code != 200 {
			t.Fatalf("ordinary /v1/me/tokens: %d", code)
		}
	})

	t.Run("MCP uses the same scoping", func(t *testing.T) {
		mcpCall := func(tok, sid, body string) (*httptest.ResponseRecorder, map[string]any) {
			req := httptest.NewRequest("POST", "/mcp", strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "application/json, text/event-stream")
			req.Header.Set("Authorization", "Bearer "+tok)
			if sid != "" {
				req.Header.Set("Mcp-Session-Id", sid)
			}
			rec := httptest.NewRecorder()
			e.h.ServeHTTP(rec, req)
			var out map[string]any
			_ = json.Unmarshal(rec.Body.Bytes(), &out)
			return rec, out
		}
		init := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}`
		rec, _ := mcpCall(acmeAlice, "", init)
		sid := rec.Header().Get("Mcp-Session-Id")
		if rec.Code != 200 || sid == "" {
			t.Fatalf("initialize: %d %s", rec.Code, rec.Body)
		}
		call := func(tool string, args map[string]any) map[string]any {
			b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call",
				"params": map[string]any{"name": tool, "arguments": args}})
			rec, out := mcpCall(acmeAlice, sid, string(b))
			if rec.Code != 200 {
				t.Fatalf("%s: %d %s", tool, rec.Code, rec.Body)
			}
			return out["result"].(map[string]any)
		}
		res := call("memory_remember", map[string]any{"content": "capybara mcp scoped note"})
		if res["isError"] == true {
			t.Fatalf("memory_remember: %v", res)
		}
		if got := e.search(acmeAlice, "capybara"); len(got) != 1 {
			t.Fatalf("MCP write not visible to its own REST identity: %q", got)
		}
		for who, tok := range map[string]string{"acme/bob": acmeBob, "globex/alice": globexAlice, "ordinary": e.userToken} {
			if got := e.search(tok, "capybara"); len(got) != 0 {
				t.Fatalf("MCP write leaked to %s: %q", who, got)
			}
		}
		if res := call("project_list", map[string]any{}); res["isError"] != true {
			t.Fatalf("project_list should be denied: %v", res)
		}
		if res := call("memory_search", map[string]any{"query": "capybara", "project": "p"}); res["isError"] != true {
			t.Fatalf("a project scope over MCP should be denied: %v", res)
		}
		// A session minted for one identity is not usable by another.
		b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 3, "method": "tools/call",
			"params": map[string]any{"name": "memory_search", "arguments": map[string]any{"query": "capybara"}}})
		if rec, _ := mcpCall(globexAlice, sid, string(b)); rec.Code == 200 && strings.Contains(rec.Body.String(), "capybara mcp") {
			t.Fatalf("session reuse across identities leaked: %s", rec.Body)
		}
	})
}
