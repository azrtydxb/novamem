// novamem-mcp bridges MCP stdio hosts (Claude Desktop and friends) to a
// novamem server's streamable-HTTP MCP endpoint. It is a pure transport
// bridge: every JSON-RPC message read from stdin is POSTed to {base}/mcp
// and the response written back to stdout, so the tool list, schemas,
// instructions, and behaviours are always exactly what the server
// serves — nothing is mirrored locally, nothing can drift. (Its
// TypeScript predecessor, packages/mcp, kept a hand-synced copy of all
// 21 tool definitions; that mirror is what this design deletes.)
//
// Config matches the TS shim: NOVAMEM_BASE_URL (default
// http://localhost:7778) and NOVAMEM_TOKEN (nm_… bearer).
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

func main() {
	base := os.Getenv("NOVAMEM_BASE_URL")
	if base == "" {
		base = "http://localhost:7778"
	}
	b := &bridge{
		endpoint: strings.TrimRight(base, "/") + "/mcp",
		token:    os.Getenv("NOVAMEM_TOKEN"),
		client:   &http.Client{Timeout: 120 * time.Second},
		out:      os.Stdout,
	}
	if err := b.run(os.Stdin); err != nil {
		fmt.Fprintln(os.Stderr, "novamem-mcp:", err)
		os.Exit(1)
	}
}

type bridge struct {
	endpoint string
	token    string
	client   *http.Client

	mu      sync.Mutex // serializes stdout writes and session updates
	out     io.Writer
	session string
}

// run reads newline-delimited JSON-RPC messages until EOF. Each message
// is relayed concurrently (hosts pipeline requests); stdout writes are
// serialized. On EOF the session is closed server-side via DELETE.
func (b *bridge) run(in io.Reader) error {
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	var wg sync.WaitGroup
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		msg := append([]byte(nil), line...)
		// Until the server has minted a session id (initialize's response),
		// relay synchronously — a pipelined message racing ahead of
		// initialize would be rejected for missing Mcp-Session-Id.
		b.mu.Lock()
		haveSession := b.session != ""
		b.mu.Unlock()
		if !haveSession {
			b.relay(msg)
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			b.relay(msg)
		}()
	}
	wg.Wait()
	b.closeSession()
	return sc.Err()
}

// relay POSTs one message and forwards the response. A transport
// failure must not leave the host hanging on a request id, so it is
// answered with a JSON-RPC error instead of silence.
func (b *bridge) relay(msg []byte) {
	req, err := http.NewRequest(http.MethodPost, b.endpoint, bytes.NewReader(msg))
	if err != nil {
		b.writeErr(msg, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if b.token != "" {
		req.Header.Set("Authorization", "Bearer "+b.token)
	}
	b.mu.Lock()
	if b.session != "" {
		req.Header.Set("Mcp-Session-Id", b.session)
	}
	b.mu.Unlock()

	resp, err := b.client.Do(req)
	if err != nil {
		b.writeErr(msg, err)
		return
	}
	defer func() { _ = resp.Body.Close() }()

	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		b.mu.Lock()
		b.session = sid
		b.mu.Unlock()
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		b.writeErr(msg, err)
		return
	}
	if resp.StatusCode == http.StatusAccepted || resp.StatusCode == http.StatusNoContent {
		return // notification acknowledged; nothing to forward
	}
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		for _, data := range sseData(body) {
			b.writeLine(data)
		}
		return
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return
	}
	b.writeLine(body)
}

// sseData extracts the data payload of each SSE event frame.
func sseData(body []byte) [][]byte {
	var out [][]byte
	var data []byte
	for _, line := range bytes.Split(body, []byte("\n")) {
		line = bytes.TrimSuffix(line, []byte("\r"))
		if rest, ok := bytes.CutPrefix(line, []byte("data:")); ok {
			data = append(data, bytes.TrimPrefix(rest, []byte(" "))...)
			continue
		}
		if len(bytes.TrimSpace(line)) == 0 && len(data) > 0 {
			out = append(out, data)
			data = nil
		}
	}
	if len(data) > 0 {
		out = append(out, data)
	}
	return out
}

// writeErr answers a failed relay with a JSON-RPC error carrying the
// original request's id — silence would hang the host. Notifications
// (no id) fail silently by protocol.
func (b *bridge) writeErr(msg []byte, cause error) {
	var probe struct {
		ID json.RawMessage `json:"id"`
	}
	if json.Unmarshal(msg, &probe) != nil || len(probe.ID) == 0 || string(probe.ID) == "null" {
		fmt.Fprintln(os.Stderr, "novamem-mcp: relay failed:", cause)
		return
	}
	env, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      probe.ID,
		"error":   map[string]any{"code": -32603, "message": "novamem-mcp: " + cause.Error()},
	})
	if err != nil {
		return
	}
	b.writeLine(env)
}

func (b *bridge) writeLine(p []byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, _ = b.out.Write(append(p, '\n'))
}

// closeSession tells the server the session is done (DELETE /mcp), the
// streamable transport's explicit teardown. Best-effort: the server
// also reaps idle sessions.
func (b *bridge) closeSession() {
	b.mu.Lock()
	sid := b.session
	b.mu.Unlock()
	if sid == "" {
		return
	}
	req, err := http.NewRequest(http.MethodDelete, b.endpoint, nil)
	if err != nil {
		return
	}
	req.Header.Set("Mcp-Session-Id", sid)
	if b.token != "" {
		req.Header.Set("Authorization", "Bearer "+b.token)
	}
	if resp, err := b.client.Do(req); err == nil {
		_ = resp.Body.Close()
	}
}
