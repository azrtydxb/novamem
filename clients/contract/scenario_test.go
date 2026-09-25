package contract

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func verdictOf(t *testing.T, base, id string) (int, []string) {
	t.Helper()
	resp, err := http.Get(base + "/_verdict/" + id)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var v struct {
		Requests   int      `json:"requests"`
		Mismatches []string `json:"mismatches"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v.Requests, v.Mismatches
}

func TestScenarioServerReplaysAndRecords(t *testing.T) {
	expect := oneOrMany[ExpectedRequest]{{Method: "POST", Path: "/v1/search", JSON: json.RawMessage(`{"query":"q"}`)}}
	f := &File{Version: 1, Token: "nm_T", TimeoutMs: 300, Scenarios: []Scenario{{
		ID:            "s1",
		Call:          Call{Class: "Client", Method: "Client.Search"},
		Respond:       oneOrMany[Response]{{Status: 200, JSON: json.RawMessage(`{"results":[],"degraded":true}`)}},
		ExpectRequest: &expect,
		Expect:        Expectation{Outcome: "unavailable"},
	}}}
	srv := httptest.NewServer(NewServer(f))
	defer srv.Close()

	req, _ := http.NewRequest("POST", srv.URL+"/s/s1/v1/search", strings.NewReader(`{"query":"q","k":5}`))
	req.Header.Set("Authorization", "Bearer nm_T")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(body), `"degraded":true`) {
		t.Fatalf("replay = %d %s", resp.StatusCode, body)
	}
	if n, m := verdictOf(t, srv.URL, "s1"); n != 1 || len(m) != 0 {
		t.Fatalf("verdict = %d %v, want 1 request and no mismatches", n, m)
	}

	// A scenario whose expected request never arrives is a mismatch too.
	if n, m := verdictOf(t, srv.URL, "s1"); n != 0 || len(m) != 1 || !strings.Contains(m[0], "never sent") {
		t.Fatalf("verdict with no request = %d %v, want one never-sent mismatch", n, m)
	}

	// Wrong method, no auth, no Accept: every one of them is reported.
	req2, _ := http.NewRequest("GET", srv.URL+"/s/s1/v1/search", nil)
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp2.Body.Close()
	if _, m := verdictOf(t, srv.URL, "s1"); len(m) < 3 {
		t.Fatalf("mismatches = %v, want auth + accept + method", m)
	}
}

func TestSubset(t *testing.T) {
	var want, got any
	_ = json.Unmarshal([]byte(`{"a":1,"b":[{"c":"x"}]}`), &want)
	_ = json.Unmarshal([]byte(`{"a":1.0,"b":[{"c":"x","d":2}],"e":true}`), &got)
	if d := Subset(want, got, "$"); d != "" {
		t.Fatalf("subset reported %q", d)
	}
	_ = json.Unmarshal([]byte(`{"a":1,"b":[]}`), &got)
	if d := Subset(want, got, "$"); !strings.Contains(d, "$.b") {
		t.Fatalf("diff = %q, want one at $.b", d)
	}
}

// proved by: removing any method's scenario from scenarios.json fails this test.
func TestEveryMethodHasAScenario(t *testing.T) {
	routes, err := LoadRoutes("routes.json")
	if err != nil {
		t.Fatal(err)
	}
	f, err := LoadScenarios("scenarios.json")
	if err != nil {
		t.Fatal(err)
	}
	// Every method needs a scenario it must SUCCEED in: an error scenario
	// alone would let a method that always fails pass the suite.
	succeeds := map[string]bool{}
	for _, s := range f.Scenarios {
		if s.Expect.Outcome == "ok" || s.Expect.Outcome == "empty" {
			succeeds[s.Call.Method] = true
		}
	}
	for _, m := range Surface(routes) {
		if !succeeds[m.Name] {
			t.Errorf("no scenario in which %s succeeds", m.Name)
		}
	}
	for _, s := range f.Scenarios {
		if s.Call.Class == "ctor" {
			continue
		}
		if !strings.HasPrefix(s.Call.Method, s.Call.Class+".") {
			t.Errorf("%s: class %q does not match method %q", s.ID, s.Call.Class, s.Call.Method)
		}
	}
}

// proved by: deleting the scenario for any error-table row fails this test.
func TestErrorTableIsCovered(t *testing.T) {
	f, err := LoadScenarios("scenarios.json")
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, s := range f.Scenarios {
		ids[s.ID] = true
	}
	for _, op := range []string{"search", "capture"} {
		for _, row := range []string{"refused", "timeout", "reset", "500", "503", "429", "404", "400", "401", "403", "empty-body", "html-body", "oversize", "cancel"} {
			if id := op + "-" + row; !ids[id] {
				t.Errorf("missing scenario %s", id)
			}
		}
	}
	for _, id := range []string{
		"search-degraded-empty-is-unavailable", "search-degraded-with-results-is-data",
		"token-echoed-in-401-is-redacted", "forget-ok", "forget-404-not-deleted",
		"forget-500-error", "forget-blank-id-local", "capture-blank-content-local",
		"health-ok-false", "health-503-is-false", "observe-503-observer-disabled",
		"today-since-24h", "stats-get-sends-no-body", "ctor-blank-token",
		"ctor-relative-url", "remove-member-by-username-two-calls",
	} {
		if !ids[id] {
			t.Errorf("missing scenario %s", id)
		}
	}
}
