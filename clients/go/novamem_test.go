package novamem

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testToken = "nm_test_secret_do_not_leak"

// newTestClient wires a client at srv against a real httptest.Server. No test
// in this file may reach a real NovaMem: every case is served locally, so the
// suite is hermetic and the failure modes (5xx, 401, garbage) are producible
// on demand rather than waited for.
func newTestClient(t *testing.T, h http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c, err := New(Config{BaseURL: srv.URL, Token: testToken, Timeout: 2 * time.Second})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c, srv
}

// call invokes one operation by name so the error-path tables can exercise
// every method through one code path.
func call(ctx context.Context, c *Client, op string) error {
	switch op {
	case "capture":
		_, err := c.Capture(ctx, CaptureRequest{Content: "a durable fact worth keeping"})
		return err
	case "search":
		_, err := c.Search(ctx, SearchRequest{Query: "anything"})
		return err
	case "recent":
		_, err := c.Recent(ctx, RecentRequest{})
		return err
	case "neighbors":
		_, err := c.Neighbors(ctx, NeighborsRequest{ID: "01K"})
		return err
	case "update":
		_, err := c.Update(ctx, UpdateRequest{ID: "01K", Content: "new"})
		return err
	case "forget":
		_, err := c.Forget(ctx, ForgetRequest{ID: "01K"})
		return err
	}
	panic("unknown op " + op)
}

var allOps = []string{"capture", "search", "recent", "neighbors", "update", "forget"}

func TestHappyPath(t *testing.T) {
	project := "phoenix"
	entry := Entry{
		ID: "01KMEM", Score: 0.87, Content: "User prefers dark roast",
		Tier: "warm", Namespace: "user", Project: &project, Source: "memory_capture",
		Metadata: map[string]any{"sensitivity": "private"},
		Signals:  &Signals{Keyword: 0.4, Vector: 0.5},
	}

	tests := []struct {
		name       string
		wantPath   string
		wantMethod string
		// wantBody are field names the request body must contain, checked so
		// a rename on the server side fails here rather than in production.
		wantBody []string
		status   int
		respond  any
		check    func(t *testing.T, c *Client)
	}{
		{
			name: "capture", wantPath: "/v1/capture", wantMethod: http.MethodPost,
			wantBody: []string{`"content"`, `"namespace"`, `"project"`},
			status:   http.StatusCreated,
			respond:  map[string]any{"id": "01KNEW", "superseded": []string{"01KOLD"}},
			check: func(t *testing.T, c *Client) {
				got, err := c.Capture(context.Background(), CaptureRequest{
					Content: "User prefers dark roast", Namespace: "user", Project: "phoenix",
				})
				if err != nil {
					t.Fatalf("Capture: %v", err)
				}
				if !got.Saved() || *got.ID != "01KNEW" {
					t.Errorf("Saved()=%v id=%v, want saved 01KNEW", got.Saved(), got.ID)
				}
				if len(got.Superseded) != 1 || got.Superseded[0] != "01KOLD" {
					t.Errorf("Superseded=%v", got.Superseded)
				}
			},
		},
		{
			name: "capture rejected by worthiness gate is not an error",
			// The gate declining is the system working. If this ever becomes
			// an error, every caller starts logging alarms about "ok, thanks".
			wantPath: "/v1/capture", wantMethod: http.MethodPost,
			status:  http.StatusCreated,
			respond: map[string]any{"id": nil, "rejected": "too short — not durable knowledge"},
			check: func(t *testing.T, c *Client) {
				got, err := c.Capture(context.Background(), CaptureRequest{Content: "ok"})
				if err != nil {
					t.Fatalf("Capture: %v", err)
				}
				if got.Saved() {
					t.Error("Saved()=true for a rejected capture")
				}
				if got.Rejected == "" {
					t.Error("Rejected reason not surfaced")
				}
			},
		},
		{
			name: "search", wantPath: "/v1/search", wantMethod: http.MethodPost,
			wantBody: []string{`"query"`, `"k"`, `"includeProjects"`, `"maxSensitivity"`},
			status:   http.StatusOK,
			respond:  Results{Entries: []Entry{entry}, Degraded: false},
			check: func(t *testing.T, c *Client) {
				got, err := c.Search(context.Background(), SearchRequest{
					Query: "coffee", K: 5, IncludeProjects: []string{"phoenix"},
					MaxSensitivity: SensitivityPrivate,
				})
				if err != nil {
					t.Fatalf("Search: %v", err)
				}
				if len(got.Entries) != 1 || got.Entries[0].ID != "01KMEM" {
					t.Fatalf("Entries=%+v", got.Entries)
				}
				if got.Entries[0].Project == nil || *got.Entries[0].Project != "phoenix" {
					t.Errorf("Project=%v", got.Entries[0].Project)
				}
				if got.Entries[0].Signals == nil || got.Entries[0].Signals.Vector != 0.5 {
					t.Errorf("Signals=%+v", got.Entries[0].Signals)
				}
			},
		},
		{
			name: "search empty is absence, not an error",
			// The load-bearing case for the whole package: a store that holds
			// nothing must be distinguishable from a store we could not read.
			wantPath: "/v1/search", wantMethod: http.MethodPost,
			status:  http.StatusOK,
			respond: Results{Entries: []Entry{}},
			check: func(t *testing.T, c *Client) {
				got, err := c.Search(context.Background(), SearchRequest{Query: "nothing"})
				if err != nil {
					t.Fatalf("Search: %v", err)
				}
				if len(got.Entries) != 0 {
					t.Errorf("Entries=%v", got.Entries)
				}
				if Unavailable(err) {
					t.Error("an empty result must never look unavailable")
				}
			},
		},
		{
			name: "recent sends since as RFC3339 with an offset",
			// The server rejects a timestamp without an offset with a 400,
			// which reads like a server fault at the call site.
			wantPath: "/v1/recent", wantMethod: http.MethodPost,
			wantBody: []string{`"since":"2026-05-02T17:00:00Z"`, `"k":3`},
			status:   http.StatusOK,
			respond:  map[string]any{"results": []Entry{entry}},
			check: func(t *testing.T, c *Client) {
				got, err := c.Recent(context.Background(), RecentRequest{
					K: 3, Since: time.Date(2026, 5, 2, 17, 0, 0, 0, time.UTC),
				})
				if err != nil {
					t.Fatalf("Recent: %v", err)
				}
				if len(got.Entries) != 1 {
					t.Fatalf("Entries=%+v", got.Entries)
				}
			},
		},
		{
			name: "neighbors", wantPath: "/v1/neighbors", wantMethod: http.MethodPost,
			wantBody: []string{`"id":"01KMEM"`, `"depth":2`},
			status:   http.StatusOK,
			respond:  Results{Entries: []Entry{entry}},
			check: func(t *testing.T, c *Client) {
				got, err := c.Neighbors(context.Background(), NeighborsRequest{ID: "01KMEM", Depth: 2})
				if err != nil {
					t.Fatalf("Neighbors: %v", err)
				}
				if len(got.Entries) != 1 {
					t.Fatalf("Entries=%+v", got.Entries)
				}
			},
		},
		{
			name: "update", wantPath: "/v1/memories/01KMEM", wantMethod: http.MethodPut,
			wantBody: []string{`"content"`, `"confidence":1`},
			status:   http.StatusOK,
			respond:  map[string]any{"id": "01KMEM", "updated": true, "embeddingChanged": true},
			check: func(t *testing.T, c *Client) {
				conf := 1.0
				got, err := c.Update(context.Background(), UpdateRequest{
					ID: "01KMEM", Content: "User now prefers filter", Confidence: &conf,
				})
				if err != nil {
					t.Fatalf("Update: %v", err)
				}
				if !got.Updated || got.ID != "01KMEM" || !got.EmbeddingChanged {
					t.Errorf("got %+v", got)
				}
			},
		},
		{
			name: "forget", wantPath: "/v1/forget", wantMethod: http.MethodPost,
			wantBody: []string{`"id":"01KMEM"`},
			status:   http.StatusOK,
			respond:  ForgetResult{Deleted: true, ColdDeleteOk: true},
			check: func(t *testing.T, c *Client) {
				got, err := c.Forget(context.Background(), ForgetRequest{ID: "01KMEM"})
				if err != nil {
					t.Fatalf("Forget: %v", err)
				}
				if !got.Deleted || !got.ColdDeleteOk {
					t.Errorf("got %+v", got)
				}
			},
		},
		{
			name: "forget surfaces a surviving cold copy",
			// Half a delete is not "forgotten", and the caller has to be able
			// to see that without reading the server's logs.
			wantPath: "/v1/forget", wantMethod: http.MethodPost,
			status:  http.StatusOK,
			respond: ForgetResult{Deleted: true, ColdDeleteOk: false},
			check: func(t *testing.T, c *Client) {
				got, err := c.Forget(context.Background(), ForgetRequest{ID: "01KMEM"})
				if err != nil {
					t.Fatalf("Forget: %v", err)
				}
				if !got.Deleted || got.ColdDeleteOk {
					t.Errorf("got %+v, want Deleted with ColdDeleteOk false", got)
				}
			},
		},
		{
			name: "forget of an unknown id deletes nothing and does not fail",
			// Idempotent by contract: the entry is not there, which is what
			// was asked for.
			wantPath: "/v1/forget", wantMethod: http.MethodPost,
			status:  http.StatusOK,
			respond: ForgetResult{Deleted: false, ColdDeleteOk: true},
			check: func(t *testing.T, c *Client) {
				got, err := c.Forget(context.Background(), ForgetRequest{ID: "nope"})
				if err != nil {
					t.Fatalf("Forget: %v", err)
				}
				if got.Deleted {
					t.Error("Deleted=true for an id the store does not hold")
				}
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if tc.wantPath != "" && r.URL.Path != tc.wantPath {
					t.Errorf("path=%q want %q", r.URL.Path, tc.wantPath)
				}
				if tc.wantMethod != "" && r.Method != tc.wantMethod {
					t.Errorf("method=%q want %q", r.Method, tc.wantMethod)
				}
				if got := r.Header.Get("Authorization"); got != "Bearer "+testToken {
					t.Errorf("Authorization=%q", got)
				}
				if got := r.Header.Get("Content-Type"); got != "application/json" {
					t.Errorf("Content-Type=%q", got)
				}
				body, _ := io.ReadAll(r.Body)
				for _, want := range tc.wantBody {
					if !strings.Contains(string(body), want) {
						t.Errorf("body %s missing %s", body, want)
					}
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_ = json.NewEncoder(w).Encode(tc.respond)
			})
			tc.check(t, c)
		})
	}
}

// TestOmitsEmptyOptionalFields guards the one encoding mistake that turns a
// working call into a 400: the server's project rule rejects "", so an unset
// Project must be absent from the body rather than present and empty.
func TestOmitsEmptyOptionalFields(t *testing.T) {
	var body string
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		_, _ = w.Write([]byte(`{"results":[]}`))
	})
	if _, err := c.Search(context.Background(), SearchRequest{Query: "q"}); err != nil {
		t.Fatalf("Search: %v", err)
	}
	for _, forbidden := range []string{`"project"`, `"namespace"`, `"k"`, `"weights"`, `"since"`} {
		if strings.Contains(body, forbidden) {
			t.Errorf("body %s should omit %s when unset", body, forbidden)
		}
	}
}

// TestUnreachableHost is the property the package exists for: a host that is
// not there must produce a checkable, distinct error — never an empty result.
func TestUnreachableHost(t *testing.T) {
	// A server that is started and immediately closed gives a guaranteed
	// connection refusal at a port nothing else is on, with no DNS involved.
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()

	c, err := New(Config{BaseURL: url, Token: testToken, Timeout: 2 * time.Second})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for _, op := range allOps {
		t.Run(op, func(t *testing.T) {
			err := call(context.Background(), c, op)
			if err == nil {
				t.Fatal("want an error from an unreachable host, got nil")
			}
			if !Unavailable(err) {
				t.Errorf("Unavailable(%v)=false; an unreachable host MUST be distinguishable "+
					"from an empty store", err)
			}
			if !Retryable(err) {
				t.Errorf("Retryable(%v)=false; a refused dial may succeed later", err)
			}
			assertNoToken(t, err)
		})
	}
}

// TestServerErrors covers what an HTTP answer means. The 5xx/401 split is the
// point: one is an outage to degrade around, the other is a credential to fix.
func TestServerErrors(t *testing.T) {
	tests := []struct {
		name            string
		status          int
		body            string
		wantUnavailable bool
		wantRetryable   bool
		wantNotFound    bool
		wantMessage     string
		wantCode        string
	}{
		{
			name: "500 is an outage", status: http.StatusInternalServerError,
			body: `{"error":"internal error"}`, wantUnavailable: true, wantRetryable: true,
			wantMessage: "internal error",
		},
		{
			name: "503 is an outage", status: http.StatusServiceUnavailable,
			body: `{"error":"upstream down"}`, wantUnavailable: true, wantRetryable: true,
			wantMessage: "upstream down",
		},
		{
			name: "429 is an outage worth retrying", status: http.StatusTooManyRequests,
			body: `{"error":"slow down"}`, wantUnavailable: true, wantRetryable: true,
			wantMessage: "slow down",
		},
		{
			// A rejected token is NOT unavailability. Reporting it as one
			// makes an agent apologise about a network for as long as it
			// takes someone to notice the credential was never rotated.
			name: "401 is an answer, not an outage", status: http.StatusUnauthorized,
			body: `{"error":"unauthorized"}`, wantUnavailable: false, wantRetryable: false,
			wantMessage: "unauthorized",
		},
		{
			name: "403 is an answer", status: http.StatusForbidden,
			body: `{"error":"not a member of this project"}`, wantMessage: "not a member of this project",
		},
		{
			name: "400 carries the server's code", status: http.StatusBadRequest,
			body:        `{"error":"bad body","code":"FST_ERR_VALIDATION"}`,
			wantMessage: "bad body", wantCode: "FST_ERR_VALIDATION",
		},
		{
			name: "404 is not found, not unavailable", status: http.StatusNotFound,
			body: `{"error":"no such memory in your scope"}`, wantNotFound: true,
			wantMessage: "no such memory in your scope",
		},
		{
			name:   "a non-JSON error body still yields a usable message",
			status: http.StatusBadGateway, body: "<html>502 Bad Gateway</html>",
			wantUnavailable: true, wantRetryable: true, wantMessage: "502 Bad Gateway",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			// Search stands in for the read paths; forget is checked
			// separately below because its 404 handling differs.
			err := call(context.Background(), c, "search")
			if err == nil {
				t.Fatal("want an error")
			}
			if Unavailable(err) != tc.wantUnavailable {
				t.Errorf("Unavailable=%v want %v (err %v)", Unavailable(err), tc.wantUnavailable, err)
			}
			if Retryable(err) != tc.wantRetryable {
				t.Errorf("Retryable=%v want %v (err %v)", Retryable(err), tc.wantRetryable, err)
			}
			if errors.Is(err, ErrNotFound) != tc.wantNotFound {
				t.Errorf("ErrNotFound=%v want %v", errors.Is(err, ErrNotFound), tc.wantNotFound)
			}
			var e *Error
			if !errors.As(err, &e) {
				t.Fatalf("error %v is not *novamem.Error", err)
			}
			if e.StatusCode != tc.status {
				t.Errorf("StatusCode=%d want %d", e.StatusCode, tc.status)
			}
			if tc.wantMessage != "" && !strings.Contains(e.Message, tc.wantMessage) {
				t.Errorf("Message=%q want to contain %q", e.Message, tc.wantMessage)
			}
			if e.Code != tc.wantCode {
				t.Errorf("Code=%q want %q", e.Code, tc.wantCode)
			}
			if e.Op != "search" {
				t.Errorf("Op=%q", e.Op)
			}
			assertNoToken(t, err)
		})
	}
}

// TestForgetNeverReportsFalseSuccess is the promise-to-a-person test. Every
// way the call can fail must produce an error and a zero result — nothing here
// may return Deleted=true, and a failure may not come back as a silent
// "deleted nothing" either, because a caller would report that as done.
func TestForgetNeverReportsFalseSuccess(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"5xx", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"boom"}`))
		}},
		{"401", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
		}},
		{"garbage body", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`not json at all`))
		}},
		{"empty body", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}},
		{"a body that omits deleted", func(w http.ResponseWriter, _ *http.Request) {
			// Decodes cleanly into the zero value. Deleted must stay false.
			_, _ = w.Write([]byte(`{"somethingElse":true}`))
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := newTestClient(t, tc.handler)
			got, err := c.Forget(context.Background(), ForgetRequest{ID: "01KMEM"})
			if got.Deleted {
				t.Fatalf("Forget reported Deleted=true (err %v) — a delete that did not "+
					"demonstrably happen must never be reported as done", err)
			}
			if tc.name != "a body that omits deleted" && err == nil {
				t.Fatal("a failed delete must be an error, not a quiet false")
			}
		})
	}
}

// TestMalformedJSON: a body that is not the promised JSON means we never
// reached a working NovaMem, so it is unavailability — and specifically not an
// empty result, which is how it would otherwise decode.
func TestMalformedJSON(t *testing.T) {
	bodies := []struct {
		name string
		body string
	}{
		{"html error page", `<!doctype html><html><body>502</body></html>`},
		{"truncated json", `{"results":[{"id":"01K"`},
		{"empty 200", ``},
	}
	for _, tc := range bodies {
		for _, op := range allOps {
			t.Run(tc.name+"/"+op, func(t *testing.T) {
				c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write([]byte(tc.body))
				})
				err := call(context.Background(), c, op)
				if err == nil {
					t.Fatal("want an error for an unparseable body")
				}
				if !Unavailable(err) {
					t.Errorf("Unavailable(%v)=false; an unreadable answer is not an empty store", err)
				}
				if Retryable(err) {
					t.Error("Retryable=true; repeating the request will parse the same way")
				}
			})
		}
	}

	// Valid JSON whose fields are the wrong TYPE is the same failure wearing
	// a better disguise — it decodes into nothing useful, so it must not
	// decode into a confident zero value either.
	wrongType := map[string]string{
		"capture":   `{"id":12345}`,
		"search":    `{"results":"not an array"}`,
		"recent":    `{"results":"not an array"}`,
		"neighbors": `{"results":"not an array"}`,
		"update":    `{"updated":"maybe"}`,
		"forget":    `{"deleted":"yes"}`,
	}
	for _, op := range allOps {
		t.Run("wrong field type/"+op, func(t *testing.T) {
			c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(wrongType[op]))
			})
			err := call(context.Background(), c, op)
			if err == nil {
				t.Fatal("want an error for a body that does not match the contract")
			}
			if !Unavailable(err) {
				t.Errorf("Unavailable(%v)=false", err)
			}
		})
	}
}

// TestDegradedEmptyIsUnavailable pins the least obvious decision in the
// package: the server reports some backing-store failures as a 200 with
// {results:[], degraded:true}. That is an outage in the costume of an empty
// result, and it must not reach a caller as absence.
func TestDegradedEmptyIsUnavailable(t *testing.T) {
	t.Run("degraded and empty is an outage", func(t *testing.T) {
		for _, op := range []string{"search", "recent", "neighbors"} {
			c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(`{"seed":"01K","results":[],"degraded":true}`))
			})
			err := call(context.Background(), c, op)
			if !Unavailable(err) {
				t.Errorf("%s: Unavailable=false for a degraded-empty response (err %v)", op, err)
			}
			if !Retryable(err) {
				t.Errorf("%s: Retryable=false; a degraded store usually reconnects", op)
			}
		}
	})
	t.Run("degraded with results is data", func(t *testing.T) {
		c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"results":[{"id":"01K","content":"x"}],"degraded":true}`))
		})
		got, err := c.Search(context.Background(), SearchRequest{Query: "x"})
		if err != nil {
			t.Fatalf("partial results must still be returned: %v", err)
		}
		if len(got.Entries) != 1 || !got.Degraded {
			t.Errorf("got %+v, want one entry with Degraded set", got)
		}
	})
}

// TestContextCancellation: the caller's own cancellation is reported as
// cancellation and NOT as an outage — a caller that gave up already knows why
// there is no answer, and a false outage alarm about a healthy host is worse
// than no signal.
func TestContextCancellation(t *testing.T) {
	for _, op := range allOps {
		t.Run(op, func(t *testing.T) {
			released := make(chan struct{})
			c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				<-released
				_, _ = w.Write([]byte(`{}`))
			})
			t.Cleanup(func() { close(released) })

			ctx, cancel := context.WithCancel(context.Background())
			go func() {
				time.Sleep(20 * time.Millisecond)
				cancel()
			}()
			err := call(ctx, c, op)
			if err == nil {
				t.Fatal("want an error when the caller cancels")
			}
			if !errors.Is(err, context.Canceled) {
				t.Errorf("errors.Is(%v, context.Canceled)=false", err)
			}
			if Unavailable(err) {
				t.Error("a caller's own cancellation must not be reported as an outage")
			}
		})
	}
}

// TestTimeoutIsUnavailable: a call that ran out of time did not get to look,
// which IS unavailability — and is retryable, since the host may just have
// been slower than this call's budget.
func TestTimeoutIsUnavailable(t *testing.T) {
	released := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-released
	}))
	t.Cleanup(func() { close(released); srv.Close() })

	c, err := New(Config{BaseURL: srv.URL, Token: testToken, Timeout: 30 * time.Millisecond})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	err = call(context.Background(), c, "search")
	if !Unavailable(err) {
		t.Errorf("Unavailable(%v)=false for a timeout", err)
	}
	if !Retryable(err) {
		t.Errorf("Retryable(%v)=false for a timeout", err)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("errors.Is(%v, context.DeadlineExceeded)=false", err)
	}
}

// TestEveryCallIsBounded proves requirement one is not theoretical: a caller
// that passes context.Background() to a host that accepts and never answers
// still gets an error, rather than a goroutine parked forever.
func TestEveryCallIsBounded(t *testing.T) {
	released := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-released
	}))
	t.Cleanup(func() { close(released); srv.Close() })

	c, err := New(Config{BaseURL: srv.URL, Token: testToken, Timeout: 50 * time.Millisecond})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- call(context.Background(), c, "capture") }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("want a timeout error")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("an unbounded call: the client did not impose its own deadline")
	}
}

// TestNoRetries locks requirement four in place. Reads must reach the server
// exactly once so a caller can degrade in one round trip; capture must not be
// retried internally either, because the caller owns that budget.
func TestNoRetries(t *testing.T) {
	for _, op := range allOps {
		t.Run(op, func(t *testing.T) {
			calls := 0
			c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
				calls++
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(`{"error":"boom"}`))
			})
			_ = call(context.Background(), c, op)
			if calls != 1 {
				t.Errorf("server saw %d requests, want exactly 1 — this package must not retry", calls)
			}
		})
	}
}

// TestTokenNeverLeaks: the bearer is long-lived and opaque, errors get logged,
// and a credential in a log line is one nobody rotates.
func TestTokenNeverLeaks(t *testing.T) {
	t.Run("even when the server echoes it back", func(t *testing.T) {
		c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			// A careless server quoting the credential in its error must not
			// get it laundered into this client's error text, and from there
			// into a log nobody rotates.
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"bad token ` + testToken + `"}`))
		})
		err := call(context.Background(), c, "search")
		if err == nil {
			t.Fatal("want an error")
		}
		assertNoToken(t, err)
		if !strings.Contains(err.Error(), "[redacted]") {
			t.Errorf("err=%v, want the echoed token replaced rather than dropped silently", err)
		}
	})
	t.Run("in a transport error", func(t *testing.T) {
		srv := httptest.NewServer(http.NotFoundHandler())
		url := srv.URL
		srv.Close()
		c, err := New(Config{BaseURL: url, Token: testToken})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		assertNoToken(t, call(context.Background(), c, "search"))
	})
	t.Run("in a config error", func(t *testing.T) {
		_, err := New(Config{BaseURL: "://nope", Token: testToken})
		if err == nil {
			t.Fatal("want an error for an unparseable base URL")
		}
		assertNoToken(t, err)
	})
}

func assertNoToken(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		return
	}
	if strings.Contains(err.Error(), testToken) {
		t.Fatalf("error text leaks the bearer token: %v", err)
	}
}

func TestNewValidatesConfig(t *testing.T) {
	tests := []struct {
		name string
		cfg  Config
		want string
	}{
		{"no base url", Config{Token: "nm_x"}, "BaseURL is required"},
		{"relative base url", Config{BaseURL: "/v1", Token: "nm_x"}, "not an absolute"},
		{"no token", Config{BaseURL: "http://x"}, "Token is required"},
		{"blank token", Config{BaseURL: "http://x", Token: "   "}, "Token is required"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := New(tc.cfg)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("New err=%v, want to contain %q", err, tc.want)
			}
		})
	}

	t.Run("trailing slash is tolerated", func(t *testing.T) {
		var path string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path = r.URL.Path
			_, _ = w.Write([]byte(`{"results":[]}`))
		}))
		t.Cleanup(srv.Close)
		c, err := New(Config{BaseURL: srv.URL + "/", Token: "nm_x"})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		if _, err := c.Search(context.Background(), SearchRequest{Query: "q"}); err != nil {
			t.Fatalf("Search: %v", err)
		}
		if path != "/v1/search" {
			t.Errorf("path=%q — a trailing slash produced a doubled separator", path)
		}
	})

	t.Run("timeout defaults", func(t *testing.T) {
		c, err := New(Config{BaseURL: "http://x", Token: "nm_x"})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		if c.timeout != DefaultTimeout {
			t.Errorf("timeout=%v want %v", c.timeout, DefaultTimeout)
		}
	})
}

// TestMissingRequiredArgs: the client refuses locally rather than spending a
// round trip to learn what it already knows.
func TestMissingRequiredArgs(t *testing.T) {
	calls := 0
	c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		calls++
		_, _ = w.Write([]byte(`{}`))
	})
	ctx := context.Background()
	if _, err := c.Capture(ctx, CaptureRequest{}); err == nil {
		t.Error("Capture with no content should fail locally")
	}
	if _, err := c.Search(ctx, SearchRequest{}); err == nil {
		t.Error("Search with no query should fail locally")
	}
	if _, err := c.Neighbors(ctx, NeighborsRequest{}); err == nil {
		t.Error("Neighbors with no id should fail locally")
	}
	if _, err := c.Update(ctx, UpdateRequest{}); err == nil {
		t.Error("Update with no id should fail locally")
	}
	if _, err := c.Forget(ctx, ForgetRequest{}); err == nil {
		t.Error("Forget with no id should fail locally")
	}
	if calls != 0 {
		t.Errorf("server saw %d requests; local validation should have caught all of them", calls)
	}
}

// TestUpdateNotFound: a memory that is gone is a fact about the store, not a
// fact about the network.
func TestUpdateNotFound(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"no such memory in your scope"}`))
	})
	_, err := c.Update(context.Background(), UpdateRequest{ID: "01KGONE", Content: "x"})
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("errors.Is(%v, ErrNotFound)=false", err)
	}
	if Unavailable(err) {
		t.Error("a 404 must not read as an outage")
	}
}
