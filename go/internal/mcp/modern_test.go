package mcp

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const modernVer = "2026-07-28"

// modernPost sends a modern-era request with the mirrored headers the
// spec requires, unless a header is overridden to "-" (omit).
func modernPost(t *testing.T, h http.Handler, method, body string, over map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	hdr := map[string]string{"Mcp-Protocol-Version": modernVer, "Mcp-Method": method}
	for k, v := range over {
		hdr[k] = v
	}
	for k, v := range hdr {
		if v == "-" {
			delete(hdr, k)
		}
	}
	return post(t, h, body, hdr)
}

// modernBody builds a CONFORMING modern request: this revision makes
// both protocolVersion and clientCapabilities required `_meta` fields,
// so a helper that omitted either would be testing a request the spec
// says servers must reject.
func modernBody(id, method, extra string) string {
	meta := `"_meta":{"` + metaProtocolVersion + `":"` + modernVer +
		`","` + metaClientCapabilities + `":{}}`
	params := "{" + meta
	if extra != "" {
		params += "," + extra
	}
	params += "}"
	return `{"jsonrpc":"2.0","id":` + id + `,"method":"` + method + `","params":` + params + `}`
}

func decodeResult(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var env struct {
		Result map[string]any  `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("body is not JSON-RPC: %s", rec.Body)
	}
	if env.Error != nil {
		t.Fatalf("wanted a result, got error %s", env.Error)
	}
	return env.Result
}

// server/discover is a MUST in the modern era: it is how a client learns
// what the server speaks without a handshake.
func TestModernDiscover(t *testing.T) {
	h := streamableHandler(testServer(t, Options{CookieSecret: testCookieSecret}), "user-a")
	rec := modernPost(t, h, discoverMethod, modernBody("1", discoverMethod, ""), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200\n%s", rec.Code, rec.Body)
	}
	res := decodeResult(t, rec)
	if res["resultType"] != resultTypeComplete {
		t.Errorf("resultType = %v", res["resultType"])
	}
	versions, _ := res["supportedVersions"].([]any)
	if len(versions) != len(SupportedProtocolVersions) {
		t.Errorf("supportedVersions = %v, want all %v", versions, SupportedProtocolVersions)
	}
	var sawModern bool
	for _, v := range versions {
		if v == modernVer {
			sawModern = true
		}
	}
	if !sawModern {
		t.Error("discover must advertise the modern revision")
	}
	if _, ok := res["capabilities"].(map[string]any); !ok {
		t.Error("discover must report capabilities")
	}
	meta, _ := res["_meta"].(map[string]any)
	info, _ := meta[metaServerInfo].(map[string]any)
	if info["name"] != serverName {
		t.Errorf("_meta serverInfo = %v", meta)
	}
	if res["ttlMs"] == nil || res["cacheScope"] != "public" {
		t.Errorf("discover must carry the cache hints, got ttlMs=%v cacheScope=%v",
			res["ttlMs"], res["cacheScope"])
	}
}

// A modern request must never mint or echo a session: the revision has
// no session concept, and echoing one would tell a client to keep using
// a mechanism this era removed.
func TestModernIsStateless(t *testing.T) {
	srv := testServer(t, Options{CookieSecret: testCookieSecret})
	h := streamableHandler(srv, "user-a")

	rec := modernPost(t, h, "tools/list", modernBody("1", "tools/list", ""), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200\n%s", rec.Code, rec.Body)
	}
	if sid := rec.Header().Get("Mcp-Session-Id"); sid != "" {
		t.Errorf("modern response minted a session id %q", sid)
	}
	if n := srv.streamable.countForUser("user-a"); n != 0 {
		t.Errorf("modern request created %d session(s)", n)
	}
	// A stray session header from a confused client is ignored, not honoured.
	rec = modernPost(t, h, "tools/list", modernBody("2", "tools/list", ""),
		map[string]string{"Mcp-Session-Id": "not-a-real-session"})
	if rec.Code != http.StatusOK {
		t.Fatalf("a stray Mcp-Session-Id must be ignored, got %d\n%s", rec.Code, rec.Body)
	}
}

func TestModernToolsListCarriesCacheFields(t *testing.T) {
	h := streamableHandler(testServer(t, Options{CookieSecret: testCookieSecret}), "user-a")
	res := decodeResult(t, modernPost(t, h, "tools/list", modernBody("1", "tools/list", ""), nil))
	if res["resultType"] != resultTypeComplete {
		t.Errorf("resultType = %v", res["resultType"])
	}
	if res["ttlMs"] == nil {
		t.Error("tools/list must carry ttlMs (CacheableResult)")
	}
	if res["cacheScope"] != toolsListCacheScope {
		t.Errorf("cacheScope = %v", res["cacheScope"])
	}
	tools, _ := res["tools"].([]any)
	if len(tools) == 0 {
		t.Fatal("no tools returned")
	}
	// Deterministic order is a SHOULD in this revision; ours is a static
	// embedded array, so assert it matches the declaration order.
	first, _ := tools[0].(map[string]any)
	if first["name"] != ToolNames()[0] {
		t.Errorf("tools order drifted: %v vs %v", first["name"], ToolNames()[0])
	}
}

func TestModernToolsCall(t *testing.T) {
	h := streamableHandler(testServer(t, Options{CookieSecret: testCookieSecret}), "user-a")
	body := modernBody("1", "tools/call", `"name":"memory_stats","arguments":{}`)
	res := decodeResult(t, modernPost(t, h, "tools/call", body,
		map[string]string{"Mcp-Name": "memory_stats"}))
	if res["resultType"] != resultTypeComplete {
		t.Errorf("resultType = %v", res["resultType"])
	}
	if res["content"] == nil {
		t.Errorf("no content: %v", res)
	}
	if res["isError"] != nil {
		t.Errorf("unexpected isError: %v", res)
	}
}

// Header/body agreement is a security control, not tidiness: an
// intermediary may route on the header while this server executes the
// body.
func TestModernHeaderMismatchRejected(t *testing.T) {
	h := streamableHandler(testServer(t, Options{CookieSecret: testCookieSecret}), "user-a")
	call := modernBody("1", "tools/call", `"name":"memory_stats","arguments":{}`)

	cases := map[string]struct {
		method string
		body   string
		over   map[string]string
	}{
		"missing MCP-Protocol-Version": {"tools/list", modernBody("1", "tools/list", ""),
			map[string]string{"Mcp-Protocol-Version": "-"}},
		"missing Mcp-Method": {"tools/list", modernBody("1", "tools/list", ""),
			map[string]string{"Mcp-Method": "-"}},
		"Mcp-Method disagrees": {"tools/list", modernBody("1", "tools/list", ""),
			map[string]string{"Mcp-Method": "tools/call"}},
		"version header disagrees": {"tools/list", modernBody("1", "tools/list", ""),
			map[string]string{"Mcp-Protocol-Version": "2025-11-25"}},
		"missing Mcp-Name on tools/call": {"tools/call", call, nil},
		"Mcp-Name disagrees":             {"tools/call", call, map[string]string{"Mcp-Name": "other_tool"}},
		"bad base64 sentinel":            {"tools/call", call, map[string]string{"Mcp-Name": "=?base64?!!!not-b64?="}},
	}
	for name, c := range cases {
		rec := modernPost(t, h, c.method, c.body, c.over)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d, want 400\n%s", name, rec.Code, rec.Body)
			continue
		}
		if !strings.Contains(rec.Body.String(), `"code":-32020`) {
			t.Errorf("%s: want HeaderMismatch -32020, got %s", name, rec.Body)
		}
	}
}

// The sentinel encoding exists so non-ASCII names can travel in headers;
// a correctly encoded one must be accepted, which means decoding before
// comparing.
func TestModernAcceptsBase64SentinelName(t *testing.T) {
	h := streamableHandler(testServer(t, Options{CookieSecret: testCookieSecret}), "user-a")
	body := modernBody("1", "tools/call", `"name":"memory_stats","arguments":{}`)
	enc := b64SentinelPrefix + base64.StdEncoding.EncodeToString([]byte("memory_stats")) + b64SentinelSuffix
	rec := modernPost(t, h, "tools/call", body, map[string]string{"Mcp-Name": enc})
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200\n%s", rec.Code, rec.Body)
	}
}

// An unknown method must be 404 with a JSON-RPC body, which is how a
// client tells "this endpoint does not implement that RPC" from "this
// is not an MCP endpoint". ping and logging/setLevel were removed in
// this revision, so they land here.
func TestModernUnknownMethodIs404(t *testing.T) {
	h := streamableHandler(testServer(t, Options{CookieSecret: testCookieSecret}), "user-a")
	for _, m := range []string{"ping", "logging/setLevel", "resources/list", "nonsense"} {
		rec := modernPost(t, h, m, modernBody("1", m, ""), nil)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: got %d, want 404\n%s", m, rec.Code, rec.Body)
		}
		if !strings.Contains(rec.Body.String(), `"code":-32601`) {
			t.Errorf("%s: want -32601, got %s", m, rec.Body)
		}
	}
}

// A version we do not implement gets the spec's error with the list to
// retry from — the signal a dual-era client uses to retry rather than
// downgrade to the handshake.
func TestModernUnsupportedVersionError(t *testing.T) {
	h := streamableHandler(testServer(t, Options{CookieSecret: testCookieSecret}), "user-a")
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"` +
		metaProtocolVersion + `":"2099-01-01"}}}`
	rec := post(t, h, body, map[string]string{
		"Mcp-Protocol-Version": "2099-01-01", "Mcp-Method": "tools/list"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400\n%s", rec.Code, rec.Body)
	}
	var env struct {
		Error struct {
			Code int `json:"code"`
			Data struct {
				Supported []string `json:"supported"`
				Requested string   `json:"requested"`
			} `json:"data"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if env.Error.Code != codeUnsupportedProtocolVersion {
		t.Errorf("code = %d, want %d", env.Error.Code, codeUnsupportedProtocolVersion)
	}
	if env.Error.Data.Requested != "2099-01-01" || len(env.Error.Data.Supported) == 0 {
		t.Errorf("data = %+v", env.Error.Data)
	}
}

// A modern notification is acknowledged with 202 and no body.
func TestModernNotificationAccepted(t *testing.T) {
	h := streamableHandler(testServer(t, Options{CookieSecret: testCookieSecret}), "user-a")
	body := `{"jsonrpc":"2.0","method":"notifications/whatever","params":{"_meta":{"` +
		metaProtocolVersion + `":"` + modernVer + `"}}}`
	rec := post(t, h, body, map[string]string{
		"Mcp-Protocol-Version": modernVer, "Mcp-Method": "notifications/whatever"})
	if rec.Code != http.StatusAccepted || rec.Body.Len() != 0 {
		t.Fatalf("got %d with %d bytes, want 202 and an empty body", rec.Code, rec.Body.Len())
	}
}

// The whole point of dual-era: neither era's traffic disturbs the other,
// on one endpoint.
func TestBothErasOnOneEndpoint(t *testing.T) {
	srv := testServer(t, Options{CookieSecret: testCookieSecret})
	h := streamableHandler(srv, "user-a")

	sid := openSession(t, h) // legacy handshake
	if sid == "" {
		t.Fatal("legacy initialize returned no session")
	}
	if rec := modernPost(t, h, "tools/list", modernBody("9", "tools/list", ""), nil); rec.Code != http.StatusOK {
		t.Fatalf("modern request during a legacy session: %d\n%s", rec.Code, rec.Body)
	}
	// The legacy session still works after modern traffic.
	rec := post(t, h, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		map[string]string{"Mcp-Session-Id": sid})
	if rec.Code != http.StatusOK {
		t.Fatalf("legacy session broke after a modern request: %d\n%s", rec.Code, rec.Body)
	}
	// The legacy result must NOT carry modern-only fields.
	res := decodeResult(t, rec)
	if res["resultType"] != nil || res["ttlMs"] != nil {
		t.Errorf("legacy result leaked modern fields: %v", res)
	}
}

// A legacy client asking for a version we do not speak must be answered
// with a *legacy* version: it has a handshake to finish, and the modern
// revision has none.
func TestLegacyInitializeNeverFallsBackToModern(t *testing.T) {
	h := streamableHandler(testServer(t, Options{CookieSecret: testCookieSecret}), "user-a")
	for _, asked := range []string{"2025-03-26", "1999-01-01", modernVer} {
		body := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"` +
			asked + `","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}`
		rec := post(t, h, body, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("asked %s: %d %s", asked, rec.Code, rec.Body)
		}
		res := decodeResult(t, rec)
		got, _ := res["protocolVersion"].(string)
		if isModernVersion(got) {
			t.Errorf("asked %s, handshake answered modern %s", asked, got)
		}
		if got != latestLegacyVersion() {
			t.Errorf("asked %s, got %s, want %s", asked, got, latestLegacyVersion())
		}
	}
}

// `io.modelcontextprotocol/clientCapabilities` is REQUIRED on every
// modern request: "A request missing any required field is malformed;
// the server MUST reject it with JSON-RPC error code -32602 (Invalid
// params). On HTTP, the response status MUST be 400 Bad Request."
//
// The server needs nothing from the field. The point is that a
// stateless server reads every request's capabilities without a
// handshake, so a request omitting them is not one this revision
// defines — and accepting it teaches clients a shape no other server
// has to honour.
//
// proved by: every modern test in this file passed before the check
// existed, because the helper above never sent the field.
func TestModernRejectsAMissingClientCapabilities(t *testing.T) {
	h := streamableHandler(testServer(t, Options{CookieSecret: testCookieSecret}), "user-a")
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"` +
		metaProtocolVersion + `":"` + modernVer + `"}}}`
	rec := modernPost(t, h, "tools/list", body, nil)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400\n%s", rec.Code, rec.Body.String())
	}
	var env struct {
		Error struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if env.Error.Code != codeInvalidParams {
		t.Errorf("code = %d, want %d", env.Error.Code, codeInvalidParams)
	}
	if !strings.Contains(env.Error.Message, metaClientCapabilities) {
		t.Errorf("message %q does not name the missing field", env.Error.Message)
	}
}

// The spec splits tool failures in two and puts "unknown tool" on the
// protocol side — a JSON-RPC error, not `isError` content. The
// distinction is about who can act on it: a model can retry a tool that
// rejected its arguments, but cannot conjure a tool the server does not
// have.
//
// The legacy era keeps the transcribed isError shape; this is the modern
// era only.
//
// proved by: removed the HasTool guard — the call falls through to the
// dispatcher and comes back 200 with isError content, and the error
// assertions below fail.
func TestModernUnknownToolIsAProtocolError(t *testing.T) {
	h := streamableHandler(testServer(t, Options{CookieSecret: testCookieSecret}), "user-a")
	body := modernBody("1", "tools/call", `"name":"memory_nonexistent","arguments":{}`)
	rec := modernPost(t, h, "tools/call", body, map[string]string{"Mcp-Name": "memory_nonexistent"})

	var env struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("body is not JSON-RPC: %s", rec.Body)
	}
	if env.Error == nil {
		t.Fatalf("unknown tool came back as a result, not a protocol error: %s", rec.Body)
	}
	if env.Error.Code != codeInvalidParams {
		t.Errorf("code = %d, want %d", env.Error.Code, codeInvalidParams)
	}
	if !strings.Contains(env.Error.Message, "memory_nonexistent") {
		t.Errorf("message %q does not name the tool", env.Error.Message)
	}

	// A tool that DOES exist but fails still reports as tool content, so
	// the model can act on it.
	ok := modernBody("2", "tools/call", `"name":"memory_search","arguments":{}`)
	okRec := modernPost(t, h, "tools/call", ok, map[string]string{"Mcp-Name": "memory_search"})
	if okRec.Code != http.StatusOK {
		t.Fatalf("an advertised tool should dispatch: %d %s", okRec.Code, okRec.Body)
	}
}

// This server returns all 21 tools in one page and never issues a
// `nextCursor`, so any cursor a client sends is one it never got from
// here. Ignoring it and serving page one again would leave a paging
// client looping over the same page forever.
func TestModernToolsListRejectsAnUnknownCursor(t *testing.T) {
	h := streamableHandler(testServer(t, Options{CookieSecret: testCookieSecret}), "user-a")
	body := modernBody("1", "tools/list", `"cursor":"eyJwYWdlIjogM30="`)
	rec := modernPost(t, h, "tools/list", body, nil)

	var env struct {
		Error *struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if env.Error == nil || env.Error.Code != codeInvalidParams {
		t.Fatalf("want -32602 for an unknown cursor, got %s", rec.Body)
	}

	// The unpaginated call is untouched, and carries no nextCursor —
	// which is how a client knows it has the whole list.
	plain := modernPost(t, h, "tools/list", modernBody("2", "tools/list", ""), nil)
	res := decodeResult(t, plain)
	if _, ok := res["nextCursor"]; ok {
		t.Error("nextCursor present on a single-page list")
	}
}

// Two ways a malformed modern request used to slip past validation and
// be served as though it had asked for something valid. Both were found
// by review, not by the suite.
func TestModernRejectsMalformedParams(t *testing.T) {
	h := streamableHandler(testServer(t, Options{CookieSecret: testCookieSecret}), "user-a")
	meta := `"_meta":{"` + metaProtocolVersion + `":"` + modernVer +
		`","` + metaClientCapabilities + `":{}}`

	errCode := func(t *testing.T, rec *httptest.ResponseRecorder) int {
		t.Helper()
		var env struct {
			Error *struct {
				Code int `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
			t.Fatalf("body is not JSON-RPC: %s", rec.Body)
		}
		if env.Error == nil {
			t.Fatalf("wanted an error, got: %s", rec.Body)
		}
		return env.Error.Code
	}

	// A cursor of the wrong type made the whole params decode fail. The
	// error was discarded, so `cursor` read as absent and the client was
	// served page one — the loop the cursor check exists to break.
	t.Run("a cursor of the wrong type is not silently no cursor", func(t *testing.T) {
		body := `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{` + meta + `,"cursor":123}}`
		rec := modernPost(t, h, "tools/list", body, nil)
		if got := errCode(t, rec); got != codeInvalidParams {
			t.Errorf("code = %d, want %d", got, codeInvalidParams)
		}
		if rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", rec.Code)
		}
	})

	// The field is typed ClientCapabilities. `_meta` holds raw JSON, so a
	// presence check alone accepted null, arrays and strings.
	for _, bad := range []string{`null`, `[]`, `"tools"`, `42`} {
		t.Run("clientCapabilities is not an object: "+bad, func(t *testing.T) {
			body := `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"` +
				metaProtocolVersion + `":"` + modernVer + `","` +
				metaClientCapabilities + `":` + bad + `}}}`
			rec := modernPost(t, h, "tools/list", body, nil)
			if got := errCode(t, rec); got != codeInvalidParams {
				t.Errorf("code = %d, want %d", got, codeInvalidParams)
			}
		})
	}
}
