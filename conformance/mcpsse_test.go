package conformance

// Port of suites/71-mcp-sse.test.ts.
//
// Legacy SSE transport (/mcp/sse + /mcp/messages), exercised at the wire
// level: open the stream, capture the `endpoint` frame's sessionId, POST
// JSON-RPC to /mcp/messages, read responses back off the stream (POSTs
// answer 202; results arrive as SSE `message` frames). Raw HTTP rather
// than an SDK client — the SDK's EventSource polyfill fights this
// legacy transport, and the wire IS the contract the Go server must
// reproduce. Transcription source: routes/mcp-sse.ts (read-only).

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

// snapshotPath is reference/tools.snapshot.json, resolved relative to
// this module (the TS suite resolves it relative to the suite file).
const snapshotPath = "reference/tools.snapshot.json"

func TestMCPLegacySSETransport(t *testing.T) {
	e := Target(t)

	t.Run("handshake advertises the same tool surface; a tool call round-trips", func(t *testing.T) {
		// AbortController + the TS 60s case timeout.
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.URL+"/mcp/sse", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+e.TestToken)
		// A dedicated no-timeout client: httpClient's overall Timeout
		// covers body reads, which would kill a held-open SSE stream;
		// the context above bounds this case instead.
		sse, err := (&http.Client{}).Do(req)
		if err != nil {
			t.Fatalf("GET /mcp/sse: %v", err)
		}
		defer func() { _ = sse.Body.Close() }()
		if sse.StatusCode != 200 {
			t.Fatalf("status = %d, want 200", sse.StatusCode)
		}

		reader := bufio.NewReader(sse.Body)
		buf := ""
		chunk := make([]byte, 4096)
		readUntil := func(pred func(buf string) bool) {
			t.Helper()
			deadline := time.Now().Add(20 * time.Second)
			for !pred(buf) {
				if time.Now().After(deadline) {
					tail := buf
					if len(tail) > 400 {
						tail = tail[len(tail)-400:]
					}
					t.Fatalf("SSE frame timeout; buffer: %s", tail)
				}
				n, err := reader.Read(chunk)
				if n > 0 {
					buf += string(chunk[:n])
				}
				if err != nil {
					t.Fatalf("SSE stream closed early: %v", err)
				}
			}
		}

		sessionRe := regexp.MustCompile(`sessionId=([A-Za-z0-9_-]+)`)
		readUntil(func(b string) bool { return sessionRe.MatchString(b) })
		sessionID := sessionRe.FindStringSubmatch(buf)[1]

		post := func(body any) {
			t.Helper()
			r := API(t, "/mcp/messages?sessionId="+sessionID, Opts{Body: body})
			// SSEServerTransport acks the POST; the JSON-RPC result
			// arrives on the stream.
			if r.Status != 200 && r.Status != 202 {
				t.Fatalf("POST /mcp/messages status = %d, want 200 or 202", r.Status)
			}
		}

		// The frame for a response id can span reads; match on the id
		// then extract that frame's data line.
		messageFor := func(id int) map[string]any {
			for _, f := range strings.Split(buf, "\n\n") {
				var data strings.Builder
				for _, l := range strings.Split(f, "\n") {
					if strings.HasPrefix(l, "data: ") {
						data.WriteString(l[6:])
					}
				}
				if data.Len() == 0 {
					continue
				}
				var msg map[string]any
				if json.Unmarshal([]byte(data.String()), &msg) != nil {
					continue // partial frame
				}
				if got, ok := msg["id"].(float64); ok && got == float64(id) {
					return msg
				}
			}
			return nil
		}
		resultFor := func(id int) any {
			t.Helper()
			msg := messageFor(id)
			if msg == nil {
				return nil
			}
			if errVal, ok := msg["error"]; ok && errVal != nil {
				raw, _ := json.Marshal(errVal)
				t.Fatalf("JSON-RPC error for id %d: %s", id, raw)
			}
			return msg["result"]
		}

		post(map[string]any{
			"jsonrpc": "2.0",
			"id":      1,
			"method":  "initialize",
			"params": map[string]any{
				"protocolVersion": "2024-11-05",
				"capabilities":    map[string]any{},
				"clientInfo":      map[string]any{"name": "conf-sse", "version": "0"},
			},
		})
		readUntil(func(string) bool { return resultFor(1) != nil })
		post(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})

		post(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": map[string]any{}})
		readUntil(func(string) bool { return resultFor(2) != nil })
		toolsAny, ok := resultFor(2).(map[string]any)["tools"].([]any)
		if !ok {
			t.Fatalf("tools/list result has no tools array")
		}
		var names []string
		for _, tl := range toolsAny {
			name, _ := tl.(map[string]any)["name"].(string)
			names = append(names, name)
		}
		sort.Strings(names)
		if raw, err := os.ReadFile(snapshotPath); err == nil {
			var snapshot struct {
				Names []string `json:"names"`
			}
			if err := json.Unmarshal(raw, &snapshot); err != nil {
				t.Fatalf("snapshot parse: %v", err)
			}
			if len(names) != len(snapshot.Names) {
				t.Fatalf("tool names = %v, want snapshot %v", names, snapshot.Names)
			}
			for i := range names {
				if names[i] != snapshot.Names[i] {
					t.Fatalf("tool names = %v, want snapshot %v", names, snapshot.Names)
				}
			}
		} else if len(names) < 21 {
			t.Fatalf("only %d tools, want >= 21", len(names))
		}

		// Namespace-SCOPED memory_recent, not memory_stats: unscoped
		// recent/stats fan out one query per namespace — measured ~33s on
		// the bench corpus's 527 shelves (44ms scoped). Any tool
		// round-trip proves the transport; take the O(1) one.
		post(map[string]any{
			"jsonrpc": "2.0",
			"id":      3,
			"method":  "tools/call",
			"params": map[string]any{
				"name":      "memory_recent",
				"arguments": map[string]any{"k": 1, "namespace": "default"},
			},
		})
		readUntil(func(string) bool { return resultFor(3) != nil })
		content, ok := resultFor(3).(map[string]any)["content"].([]any)
		if !ok || len(content) == 0 {
			t.Fatalf("tools/call result has no content")
		}
		text, _ := content[0].(map[string]any)["text"].(string)
		var recent map[string]any
		if err := json.Unmarshal([]byte(text), &recent); err != nil {
			t.Fatalf("memory_recent text is not JSON: %v", err)
		}
		if _, ok := recent["results"]; !ok {
			t.Fatalf("memory_recent payload lacks results: %v", recent)
		}
	})
}
