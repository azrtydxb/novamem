package contract

// The scenario server replays scripted responses so that every SDK can be
// run against the same failure modes without carrying its own fake HTTP
// server. A runner points its client at <url>/s/<scenario-id>, makes one
// call, then asks /_verdict/<scenario-id> whether the request it sent was
// the one the scenario expects.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// File is scenarios.json.
type File struct {
	Version   int        `json:"version"`
	Token     string     `json:"token"`
	TimeoutMs int        `json:"timeoutMs"`
	Scenarios []Scenario `json:"scenarios"`
}

// Scenario is one scripted call and the outcome every SDK must report.
type Scenario struct {
	ID            string                      `json:"id"`
	Call          Call                        `json:"call"`
	Respond       oneOrMany[Response]         `json:"respond"`
	ExpectRequest *oneOrMany[ExpectedRequest] `json:"expectRequest,omitempty"`
	Expect        Expectation                 `json:"expect"`
	Requires      []string                    `json:"requires,omitempty"`
}

// Call names the SDK method (a routes.json name, or "ctor" for a
// construction-only scenario) and its arguments in wire form.
type Call struct {
	Class         string         `json:"class"`
	Method        string         `json:"method"`
	Args          map[string]any `json:"args"`
	CancelAfterMs int            `json:"cancelAfterMs,omitempty"`
}

// Response is what the server does with one request: reply with Status and
// a JSON or raw body, or act out a Fault.
type Response struct {
	Status int             `json:"status,omitempty"`
	JSON   json.RawMessage `json:"json,omitempty"`
	Raw    *string         `json:"raw,omitempty"`
	// Fault is "timeout", "reset", "oversize" or "refused". "refused" never
	// reaches the server: the runner dials the closed port instead.
	Fault string `json:"fault,omitempty"`
}

// ExpectedRequest is what the SDK must have sent.
type ExpectedRequest struct {
	Method string            `json:"method"`
	Path   string            `json:"path"`
	JSON   json.RawMessage   `json:"json,omitempty"`
	Query  map[string]string `json:"query,omitempty"`
	NoBody bool              `json:"noBody,omitempty"`
}

// Expectation is the outcome the SDK must classify the call as.
type Expectation struct {
	// Outcome is ok, empty, unavailable, not_found, error or canceled.
	Outcome    string          `json:"outcome"`
	Retryable  *bool           `json:"retryable,omitempty"`
	StatusCode *int            `json:"statusCode,omitempty"`
	Code       string          `json:"code,omitempty"`
	Message    string          `json:"messageContains,omitempty"`
	Result     json.RawMessage `json:"result,omitempty"`
}

// oneOrMany accepts either a single object or an array of them, so the
// common one-request scenario doesn't need brackets.
type oneOrMany[T any] []T

func (o *oneOrMany[T]) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) > 0 && b[0] == '[' {
		var many []T
		if err := json.Unmarshal(b, &many); err != nil {
			return err
		}
		*o = many
		return nil
	}
	var one T
	if err := json.Unmarshal(b, &one); err != nil {
		return err
	}
	*o = []T{one}
	return nil
}

// OversizeBytes is the body the "oversize" fault sends: past every SDK's
// 8 MiB cap by a clear margin.
const OversizeBytes = 9 << 20

// LoadScenarios reads and sanity-checks scenarios.json.
func LoadScenarios(path string) (*File, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var f File
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	seen := map[string]bool{}
	for _, s := range f.Scenarios {
		switch {
		case s.ID == "":
			return nil, fmt.Errorf("a scenario has no id")
		case seen[s.ID]:
			return nil, fmt.Errorf("%s: duplicate id", s.ID)
		case s.Call.Class != "ctor" && len(s.Respond) == 0:
			return nil, fmt.Errorf("%s: no respond", s.ID)
		case s.Expect.Outcome == "":
			return nil, fmt.Errorf("%s: no expect.outcome", s.ID)
		}
		seen[s.ID] = true
	}
	return &f, nil
}

type state struct {
	requests   int
	mismatches []string
}

type server struct {
	f     *File
	byID  map[string]*Scenario
	mu    sync.Mutex
	state map[string]*state
}

// NewServer serves the scenarios in f.
func NewServer(f *File) http.Handler {
	s := &server{f: f, byID: map[string]*Scenario{}, state: map[string]*state{}}
	for i := range f.Scenarios {
		s.byID[f.Scenarios[i].ID] = &f.Scenarios[i]
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /_verdict/{id}", s.verdict)
	mux.HandleFunc("/s/{id}/{rest...}", s.replay)
	return mux
}

func (s *server) verdict(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.mu.Lock()
	st := s.state[id]
	delete(s.state, id)
	s.mu.Unlock()
	out := struct {
		Requests   int      `json:"requests"`
		Mismatches []string `json:"mismatches"`
	}{Mismatches: []string{}}
	if st != nil {
		out.Requests = st.requests
		out.Mismatches = append(out.Mismatches, st.mismatches...)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func (s *server) replay(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sc, ok := s.byID[id]
	if !ok {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(599)
		_, _ = fmt.Fprintf(w, `{"error":"unknown scenario %s"}`, id)
		return
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))

	s.mu.Lock()
	st := s.state[id]
	if st == nil {
		st = &state{}
		s.state[id] = st
	}
	n := st.requests
	st.requests++
	st.mismatches = append(st.mismatches, s.check(sc, n, r, body)...)
	s.mu.Unlock()

	resp := sc.Respond[min(n, len(sc.Respond)-1)]
	switch resp.Fault {
	case "timeout":
		select {
		case <-time.After(time.Duration(s.f.TimeoutMs+500) * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		writeBody(w, 200, []byte("{}"))
	case "reset":
		if hj, ok := w.(http.Hijacker); ok {
			if conn, _, err := hj.Hijack(); err == nil {
				_ = conn.Close()
				return
			}
		}
		panic(http.ErrAbortHandler)
	case "oversize":
		big := make([]byte, 0, OversizeBytes)
		big = append(big, `{"results":[`...)
		for len(big) < OversizeBytes-4 {
			big = append(big, "0,"...)
		}
		big = append(big, "0]}"...)
		writeBody(w, 200, big)
	default:
		switch {
		case resp.Raw != nil:
			writeBody(w, resp.Status, []byte(*resp.Raw))
		case resp.JSON != nil:
			writeBody(w, resp.Status, resp.JSON)
		default:
			writeBody(w, resp.Status, nil)
		}
	}
}

func writeBody(w http.ResponseWriter, status int, body []byte) {
	if body != nil {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// check compares request n against the scenario's expectation and
// returns one line per difference.
func (s *server) check(sc *Scenario, n int, r *http.Request, body []byte) []string {
	var out []string
	if got, want := r.Header.Get("Authorization"), "Bearer "+s.f.Token; got != want {
		out = append(out, fmt.Sprintf("request %d: Authorization header is not the scenario bearer", n))
	}
	if got := r.Header.Get("Accept"); !strings.Contains(got, "application/json") {
		out = append(out, fmt.Sprintf("request %d: Accept = %q, want application/json", n, got))
	}
	if sc.ExpectRequest == nil {
		return out
	}
	exp := *sc.ExpectRequest
	if n >= len(exp) {
		return append(out, fmt.Sprintf("request %d: unexpected request %s %s (scenario expects %d)", n, r.Method, r.URL.Path, len(exp)))
	}
	e := exp[n]
	path := "/" + r.PathValue("rest")
	if r.Method != e.Method || path != e.Path {
		out = append(out, fmt.Sprintf("request %d: got %s %s, want %s %s", n, r.Method, path, e.Method, e.Path))
	}
	for k, v := range e.Query {
		if got := r.URL.Query().Get(k); got != v {
			out = append(out, fmt.Sprintf("request %d: query %s = %q, want %q", n, k, got, v))
		}
	}
	trimmed := bytes.TrimSpace(body)
	if e.NoBody && len(trimmed) > 0 {
		out = append(out, fmt.Sprintf("request %d: sent a body %q, want none", n, trimmed))
	}
	if len(trimmed) > 0 && !strings.Contains(r.Header.Get("Content-Type"), "application/json") {
		out = append(out, fmt.Sprintf("request %d: body sent with Content-Type %q", n, r.Header.Get("Content-Type")))
	}
	if e.JSON != nil {
		var want, got any
		_ = json.Unmarshal(e.JSON, &want)
		if err := json.Unmarshal(trimmed, &got); err != nil {
			out = append(out, fmt.Sprintf("request %d: body is not JSON: %q", n, trimmed))
		} else if d := Subset(want, got, "$"); d != "" {
			out = append(out, fmt.Sprintf("request %d: body %s", n, d))
		}
	}
	if sc.ID == "today-since-24h" {
		out = append(out, checkSince(n, trimmed)...)
	}
	return out
}

// checkSince is the one rule that depends on the clock: Today must send a
// since that is now − 24h, give or take a minute.
func checkSince(n int, body []byte) []string {
	var b struct {
		Since string `json:"since"`
	}
	_ = json.Unmarshal(body, &b)
	t, err := time.Parse(time.RFC3339, b.Since)
	if err != nil {
		return []string{fmt.Sprintf("request %d: since %q is not RFC 3339", n, b.Since)}
	}
	if d := time.Since(t) - 24*time.Hour; math.Abs(d.Seconds()) > 60 {
		return []string{fmt.Sprintf("request %d: since out of range (%s from now − 24h)", n, d)}
	}
	return nil
}

// Subset reports the first place want is not contained in got, or "".
// Objects match when every key of want matches in got (extra keys pass);
// arrays must have equal length and match element-wise; numbers compare
// by value.
func Subset(want, got any, path string) string {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return fmt.Sprintf("%s: want an object, got %T", path, got)
		}
		for k, wv := range w {
			gv, present := g[k]
			if !present {
				return fmt.Sprintf("%s.%s: missing", path, k)
			}
			if d := Subset(wv, gv, path+"."+k); d != "" {
				return d
			}
		}
		return ""
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return fmt.Sprintf("%s: want %d-element array, got %v", path, len(w), got)
		}
		for i := range w {
			if d := Subset(w[i], g[i], fmt.Sprintf("%s[%d]", path, i)); d != "" {
				return d
			}
		}
		return ""
	default:
		if fmt.Sprint(want) != fmt.Sprint(got) {
			return fmt.Sprintf("%s: got %v, want %v", path, got, want)
		}
		return ""
	}
}
