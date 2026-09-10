package conformance

// Port of suites/70-mcp-streamable.test.ts.
//
// Read-only transcription sources: `packages/server/src/routes/
// mcp-streamable.ts` (transport wiring), `mcp-spec-guards.ts` (Origin +
// MCP-Protocol-Version MUSTs), `mcp-tools.ts` (tool advertisement).
// Never imported — this suite talks to the live oracle only.
//
// The TS suite drove the transport through the official MCP SDK client;
// stdlib-only Go speaks Streamable HTTP by hand instead: POST initialize
// (capturing Mcp-Session-Id), POST notifications/initialized, then
// JSON-RPC requests with the session header, accepting both plain-JSON
// and text/event-stream response framings — either is spec-conforming.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// streamableSnapshotPath is ../reference/tools.snapshot.json relative
// to the TS suite file; from this Go module that reference dir lives
// under packages/conformance/.
const streamableSnapshotPath = "reference/tools.snapshot.json"

// mcpSession is one live Streamable HTTP session: the negotiated
// protocol version rides along as the MCP-Protocol-Version header on
// every subsequent request (a 2025-06-18 MUST).
type mcpSession struct {
	sid    string
	proto  string
	nextID int
}

func (s *mcpSession) headers() map[string]string {
	h := map[string]string{"Accept": "application/json, text/event-stream"}
	if s.sid != "" {
		h["Mcp-Session-Id"] = s.sid
	}
	if s.proto != "" {
		h["Mcp-Protocol-Version"] = s.proto
	}
	return h
}

// envelope extracts the JSON-RPC response object from a Result, whether
// the server framed it as application/json or as an SSE event stream.
func envelope(t *testing.T, r Result) map[string]any {
	t.Helper()
	if m, ok := r.Body.(map[string]any); ok {
		return m
	}
	raw := r.Str()
	if strings.Contains(r.Headers.Get("Content-Type"), "text/event-stream") {
		for _, block := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n\n") {
			var data []string
			for _, line := range strings.Split(block, "\n") {
				if rest, ok := strings.CutPrefix(line, "data:"); ok {
					data = append(data, strings.TrimPrefix(rest, " "))
				}
			}
			if len(data) == 0 {
				continue
			}
			var msg map[string]any
			if json.Unmarshal([]byte(strings.Join(data, "\n")), &msg) != nil {
				continue
			}
			if _, hasID := msg["id"]; hasID && (msg["result"] != nil || msg["error"] != nil) {
				return msg
			}
		}
	}
	t.Fatalf("no JSON-RPC response in body (Content-Type %q): %q", r.Headers.Get("Content-Type"), raw)
	return nil
}

// rpc sends one JSON-RPC request over the session and returns the
// response envelope (which may carry "result" or "error" — callers that
// must not tolerate an error go through mustResult).
func (s *mcpSession) rpc(t *testing.T, method string, params any) map[string]any {
	t.Helper()
	s.nextID++
	r := API(t, "/mcp", Opts{
		Body:    map[string]any{"jsonrpc": "2.0", "id": s.nextID, "method": method, "params": params},
		Headers: s.headers(),
	})
	if r.Status != 200 {
		raw, _ := json.Marshal(r.Body)
		t.Fatalf("%s: transport answered %d, not a JSON-RPC response: %s", method, r.Status, raw)
	}
	return envelope(t, r)
}

func (s *mcpSession) mustResult(t *testing.T, method string, params any) map[string]any {
	t.Helper()
	env := s.rpc(t, method, params)
	if env["error"] != nil {
		raw, _ := json.Marshal(env["error"])
		t.Fatalf("%s: JSON-RPC error: %s", method, raw)
	}
	res, ok := env["result"].(map[string]any)
	if !ok {
		t.Fatalf("%s: result is %T, want object", method, env["result"])
	}
	return res
}

// connect opens a session: initialize, capture Mcp-Session-Id, send
// notifications/initialized. Bearer auth is the run's test token, same
// as the TS transport's requestInit headers.
func connect(t *testing.T) *mcpSession {
	t.Helper()
	s := &mcpSession{}
	s.nextID++
	r := API(t, "/mcp", Opts{
		Body: map[string]any{
			"jsonrpc": "2.0", "id": s.nextID, "method": "initialize",
			"params": map[string]any{
				"protocolVersion": "2025-06-18",
				"capabilities":    map[string]any{},
				"clientInfo":      map[string]any{"name": "novamem-conformance", "version": "0.0.1"},
			},
		},
		Headers: s.headers(),
	})
	if r.Status != 200 {
		raw, _ := json.Marshal(r.Body)
		t.Fatalf("initialize: %d %s", r.Status, raw)
	}
	env := envelope(t, r)
	if env["error"] != nil {
		raw, _ := json.Marshal(env["error"])
		t.Fatalf("initialize: JSON-RPC error: %s", raw)
	}
	s.sid = r.Headers.Get("Mcp-Session-Id")
	if s.sid == "" {
		t.Fatal("no Mcp-Session-Id header on initialize response")
	}
	if res, ok := env["result"].(map[string]any); ok {
		s.proto, _ = res["protocolVersion"].(string)
	}
	nr := API(t, "/mcp", Opts{
		Body:    map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"},
		Headers: s.headers(),
	})
	if nr.Status < 200 || nr.Status > 299 {
		t.Fatalf("notifications/initialized: %d", nr.Status)
	}
	return s
}

// disconnect DELETEs the session — client.close() alone drops the
// socket without telling the server, so the session lingers until the
// 30-minute idle reaper. Six sessions per run against a cap of ten
// means a second run inside that window fails on "too many concurrent
// MCP sessions" — on either server, the cap and the timeout being
// identical. Each test terminates its session on the way out.
// (405 would be the transport saying it doesn't support explicit
// termination — the SDK's terminateSession tolerates that too.)
func (s *mcpSession) disconnect(t *testing.T) {
	t.Helper()
	r := API(t, "/mcp", Opts{Method: "DELETE", Headers: s.headers()})
	if (r.Status < 200 || r.Status > 299) && r.Status != 405 {
		t.Errorf("session DELETE: %d", r.Status)
	}
}

// callTool is client.callTool: the CallToolResult object, with a
// JSON-RPC error surfaced as the second return (the TS SDK throws it —
// some SDK versions surface tool-level failures that way).
func (s *mcpSession) callTool(t *testing.T, name string, args map[string]any) (map[string]any, any) {
	t.Helper()
	env := s.rpc(t, "tools/call", map[string]any{"name": name, "arguments": args})
	if env["error"] != nil {
		return nil, env["error"]
	}
	res, ok := env["result"].(map[string]any)
	if !ok {
		t.Fatalf("tools/call %s: result is %T, want object", name, env["result"])
	}
	return res, nil
}

// toolJSON is the TS toolJson helper: parse content[0].text as JSON.
func toolJSON(t *testing.T, r map[string]any) map[string]any {
	t.Helper()
	content, _ := r["content"].([]any)
	if len(content) == 0 {
		t.Fatalf("tool result has no content: %v", r)
	}
	first, _ := content[0].(map[string]any)
	text, _ := first["text"].(string)
	var out map[string]any
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatalf("content[0].text is not JSON: %v\ntext: %s", err, text)
	}
	return out
}

func TestMCPStreamableTransport(t *testing.T) {
	Target(t)

	t.Run("initializes and advertises the snapshotted tool surface", func(t *testing.T) {
		s := connect(t)
		defer s.disconnect(t)
		res := s.mustResult(t, "tools/list", map[string]any{})
		toolsAny, _ := res["tools"].([]any)
		type tool struct {
			name   string
			schema any
		}
		var tools []tool
		var names []string
		for _, ta := range toolsAny {
			tm, _ := ta.(map[string]any)
			name, _ := tm["name"].(string)
			tools = append(tools, tool{name, tm["inputSchema"]})
			names = append(names, name)
		}
		sort.Strings(names)
		if len(names) < 21 {
			t.Fatalf("only %d tools advertised, want >= 21", len(names))
		}
		raw, err := os.ReadFile(filepath.FromSlash(streamableSnapshotPath))
		if err != nil {
			if os.IsNotExist(err) {
				t.Fatal("reference/tools.snapshot.json missing — regenerate with scripts/snapshot-tools.mjs against the oracle")
			}
			t.Fatal(err)
		}
		var snapshot struct {
			Names   []string       `json:"names"`
			Schemas map[string]any `json:"schemas"`
		}
		if err := json.Unmarshal(raw, &snapshot); err != nil {
			t.Fatalf("tools.snapshot.json: %v", err)
		}
		if !reflect.DeepEqual(names, snapshot.Names) {
			t.Fatalf("tool names drifted from snapshot:\n got %v\nwant %v", names, snapshot.Names)
		}
		// Schema drift matters as much as name drift: hosts build arg UIs
		// and validation from inputSchema.
		for _, tl := range tools {
			if !reflect.DeepEqual(snapshot.Schemas[tl.name], tl.schema) {
				got, _ := json.Marshal(tl.schema)
				want, _ := json.Marshal(snapshot.Schemas[tl.name])
				t.Fatalf("schema for %s drifted:\n got %s\nwant %s", tl.name, got, want)
			}
		}
	})

	t.Run("memory_remember -> memory_search -> memory_forget round-trip", func(t *testing.T) {
		s := connect(t)
		defer s.disconnect(t)
		shelf := NS()
		fact := fmt.Sprintf("the mcp conformance marker for this run is %s", shelf)
		storedRes, rpcErr := s.callTool(t, "memory_remember", map[string]any{"content": fact, "namespace": shelf})
		if rpcErr != nil {
			t.Fatalf("memory_remember: %v", rpcErr)
		}
		stored := toolJSON(t, storedRes)
		if id, _ := stored["id"].(string); id == "" {
			t.Fatalf("stored.id not truthy: %v", stored["id"])
		}
		foundRes, rpcErr := s.callTool(t, "memory_search", map[string]any{"query": "mcp conformance marker", "namespace": shelf})
		if rpcErr != nil {
			t.Fatalf("memory_search: %v", rpcErr)
		}
		found := toolJSON(t, foundRes)
		foundRaw, _ := json.Marshal(found)
		if !strings.Contains(string(foundRaw), shelf) {
			t.Fatalf("search result does not contain %q: %s", shelf, foundRaw)
		}
		goneRes, rpcErr := s.callTool(t, "memory_forget", map[string]any{"id": stored["id"]})
		if rpcErr != nil {
			t.Fatalf("memory_forget: %v", rpcErr)
		}
		gone := toolJSON(t, goneRes)
		if gone["deleted"] != true {
			t.Fatalf("gone.deleted = %v, want true", gone["deleted"])
		}
	})

	t.Run("unknown tool name is a tool-level error, not a transport crash", func(t *testing.T) {
		s := connect(t)
		defer s.disconnect(t)
		res, rpcErr := s.callTool(t, "memory_nonexistent", map[string]any{})
		if rpcErr != nil {
			// Some SDK versions surface it as a JSON-RPC error instead —
			// either is spec-conforming; a dropped connection is not.
			raw, _ := json.Marshal(rpcErr)
			if !regexp.MustCompile(`(?i)tool|unknown|not found`).MatchString(string(raw)) {
				t.Fatalf("JSON-RPC error does not name the tool problem: %s", raw)
			}
			return
		}
		if res["isError"] != true {
			t.Fatalf("isError = %v, want true", res["isError"])
		}
	})

	t.Run("malformed arguments are a tool error with a message", func(t *testing.T) {
		s := connect(t)
		defer s.disconnect(t)
		res, rpcErr := s.callTool(t, "memory_search", map[string]any{})
		if rpcErr != nil {
			t.Fatalf("memory_search: %v", rpcErr)
		}
		if res["isError"] != true {
			t.Fatalf("isError = %v, want true", res["isError"])
		}
		content, _ := json.Marshal(res["content"])
		if !regexp.MustCompile(`(?i)query`).MatchString(string(content)) {
			t.Fatalf("error content does not mention the missing query: %s", content)
		}
	})

	t.Run("spec guard: disallowed Origin answers 403", func(t *testing.T) {
		r := API(t, "/mcp", Opts{
			Method:  "POST",
			Body:    map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}},
			Headers: map[string]string{"origin": "https://evil.example.com"},
		})
		if r.Status != 403 {
			t.Fatalf("status = %d, want 403", r.Status)
		}
	})

	t.Run("spec guard: unsupported MCP-Protocol-Version answers 400", func(t *testing.T) {
		r := API(t, "/mcp", Opts{
			Method:  "POST",
			Body:    map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}},
			Headers: map[string]string{"mcp-protocol-version": "1999-01-01"},
		})
		if r.Status != 400 {
			t.Fatalf("status = %d, want 400", r.Status)
		}
	})
}
