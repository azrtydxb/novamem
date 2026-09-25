package novamem

// The shared behaviour suite (../contract/scenarios.json, ADR 0009) run
// against the reference client. Every other SDK runs the same scenarios
// against the same server; this file is the one they copy.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

type scenarioFile struct {
	Token     string `json:"token"`
	TimeoutMs int    `json:"timeoutMs"`
	Scenarios []struct {
		ID   string `json:"id"`
		Call struct {
			Class         string         `json:"class"`
			Method        string         `json:"method"`
			Args          map[string]any `json:"args"`
			CancelAfterMs int            `json:"cancelAfterMs"`
		} `json:"call"`
		Respond       json.RawMessage `json:"respond"`
		ExpectRequest json.RawMessage `json:"expectRequest"`
		Expect        struct {
			Outcome         string          `json:"outcome"`
			Retryable       *bool           `json:"retryable"`
			StatusCode      *int            `json:"statusCode"`
			Code            string          `json:"code"`
			MessageContains string          `json:"messageContains"`
			Result          json.RawMessage `json:"result"`
		} `json:"expect"`
	} `json:"scenarios"`
}

func startScenarioServer(t *testing.T) (base, closed string) {
	t.Helper()
	// Build, then run the binary: killing `go run` leaves its compiled child
	// alive, holding this test's output open until go test gives up.
	bin := t.TempDir() + "/scenario-server"
	build := exec.Command("go", "build", "-o", bin, "./cmd/scenario-server")
	build.Dir = "../contract"
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build scenario-server: %v\n%s", err, out)
	}
	cmd := exec.Command(bin, "-scenarios", "scenarios.json")
	cmd.Dir = "../contract"
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		t.Fatalf("scenario-server: %v", err)
	}
	f := strings.Fields(line) // listening <url> closed=<port>
	return f[1], strings.TrimPrefix(f[2], "closed=")
}

// proved by: deleting degradedEmpty's check fails
// search-degraded-empty-is-unavailable; deleting the [redacted]
// replacement fails token-echoed-in-401-is-redacted.
func TestScenarios(t *testing.T) {
	raw, err := os.ReadFile("../contract/scenarios.json")
	if err != nil {
		t.Skipf("scenarios.json not readable outside the monorepo: %v", err)
	}
	var f scenarioFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	base, closed := startScenarioServer(t)
	timeout := time.Duration(f.TimeoutMs) * time.Millisecond
	for _, s := range f.Scenarios {
		t.Run(s.ID, func(t *testing.T) {
			url := base + "/s/" + s.ID
			if strings.Contains(string(s.Respond), `"refused"`) {
				url = "http://127.0.0.1:" + closed + "/s/" + s.ID
			}
			ctx := context.Background()
			if s.Call.CancelAfterMs > 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				defer cancel()
				time.AfterFunc(time.Duration(s.Call.CancelAfterMs)*time.Millisecond, cancel)
			}
			var result any
			if s.Call.Class == "ctor" {
				args := s.Call.Args
				_, err = New(Config{BaseURL: strings.ReplaceAll(str(args, "baseUrl"), "<server>", base), Token: str(args, "token")})
			} else {
				result, err = dispatchScenario(ctx, Config{BaseURL: url, Token: f.Token, Timeout: timeout}, s.Call.Method, s.Call.Args)
			}

			exp := s.Expect
			if got := classifyScenario(result, err); got != exp.Outcome {
				t.Fatalf("outcome = %s (err: %v), want %s", got, err, exp.Outcome)
			}
			if err != nil {
				if strings.Contains(err.Error(), f.Token) || strings.Contains(fmt.Sprintf("%+v", err), f.Token) {
					t.Fatalf("token leaked into the error: %v", err)
				}
				if exp.Retryable != nil && Retryable(err) != *exp.Retryable {
					t.Errorf("retryable = %v, want %v", Retryable(err), *exp.Retryable)
				}
				var e *Error
				isErr := errors.As(err, &e)
				if exp.StatusCode != nil && (!isErr || e.StatusCode != *exp.StatusCode) {
					t.Errorf("status = %v, want %d", err, *exp.StatusCode)
				}
				if exp.Code != "" && (!isErr || e.Code != exp.Code) {
					t.Errorf("code = %v, want %s", err, exp.Code)
				}
				if exp.MessageContains != "" && !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(exp.MessageContains)) {
					t.Errorf("message = %q, want it to contain %q", err.Error(), exp.MessageContains)
				}
			}
			if len(exp.Result) > 0 {
				var want, got any
				_ = json.Unmarshal(exp.Result, &want)
				b, _ := json.Marshal(result)
				_ = json.Unmarshal(b, &got)
				if d := subset(want, got, "$"); d != "" {
					t.Errorf("result %s", d)
				}
			}
			if s.Call.Class == "ctor" {
				return
			}
			resp, err := http.Get(base + "/_verdict/" + s.ID)
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
			if len(v.Mismatches) > 0 {
				t.Errorf("request mismatches: %v", v.Mismatches)
			}
			if strings.TrimSpace(string(s.ExpectRequest)) == "[]" && v.Requests != 0 {
				t.Errorf("expected no request, the server saw %d", v.Requests)
			}
		})
	}
}

func classifyScenario(result any, err error) string {
	switch {
	case err == nil && isEmptyResult(result):
		return "empty"
	case err == nil:
		return "ok"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case Unavailable(err):
		return "unavailable"
	case errors.Is(err, ErrNotFound):
		return "not_found"
	default:
		return "error"
	}
}

// isEmptyResult: the call succeeded and its wire form is [] or an object
// whose results array is empty — the one shape that means "nothing stored".
func isEmptyResult(result any) bool {
	b, _ := json.Marshal(result)
	if strings.TrimSpace(string(b)) == "[]" {
		return true
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(b, &obj) == nil {
		if r, ok := obj["results"]; ok && strings.TrimSpace(string(r)) == "[]" {
			return true
		}
	}
	return false
}

// subset reports the first place want is not contained in got, or "".
func subset(want, got any, path string) string {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return fmt.Sprintf("%s: want an object, got %v", path, got)
		}
		for k, wv := range w {
			if d := subset(wv, g[k], path+"."+k); d != "" {
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

func str(args map[string]any, k string) string { s, _ := args[k].(string); return s }
func num(args map[string]any, k string) int    { n, _ := args[k].(float64); return int(n) }
func intp(args map[string]any, k string) *int {
	if _, ok := args[k]; !ok {
		return nil
	}
	n := num(args, k)
	return &n
}

// decode turns wire-form args into a request type, as a caller would
// build it.
func decode[T any](args map[string]any) T {
	var v T
	b, _ := json.Marshal(args)
	_ = json.Unmarshal(b, &v)
	return v
}

// dispatchScenario calls the routes.json method named by method. Methods
// that return several values report them as one wire-shaped object.
func dispatchScenario(ctx context.Context, cfg Config, method string, a map[string]any) (any, error) {
	c, err := New(cfg)
	if err != nil {
		return nil, err
	}
	m, err := NewManagement(cfg)
	if err != nil {
		return nil, err
	}
	ad, err := NewAdmin(cfg)
	if err != nil {
		return nil, err
	}
	switch method {
	case "Client.Capture":
		return c.Capture(ctx, decode[CaptureRequest](a))
	case "Client.Search":
		return c.Search(ctx, decode[SearchRequest](a))
	case "Client.Recent":
		return c.Recent(ctx, decode[RecentRequest](a))
	case "Client.Today":
		return c.Today(ctx, decode[RecentRequest](a))
	case "Client.Neighbors":
		return c.Neighbors(ctx, decode[NeighborsRequest](a))
	case "Client.Update":
		req := decode[UpdateRequest](a)
		req.ID = str(a, "id")
		return c.Update(ctx, req)
	case "Client.Forget":
		return c.Forget(ctx, decode[ForgetRequest](a))
	case "Client.Remember":
		return c.Remember(ctx, decode[CaptureRequest](a))
	case "Client.Context":
		return c.Context(ctx, decode[ContextRequest](a))
	case "Client.SessionRecap":
		return c.SessionRecap(ctx, decode[SessionRecapRequest](a))
	case "Client.ContextPrefix":
		return c.ContextPrefix(ctx, str(a, "project"))
	case "Client.Stats":
		return c.Stats(ctx)
	case "Client.Health":
		return c.Health(ctx)

	case "Management.MintToken":
		return m.MintToken(ctx, decode[MintTokenRequest](a))
	case "Management.ListTokens":
		return m.ListTokens(ctx)
	case "Management.RevokeToken":
		return m.RevokeToken(ctx, str(a, "hash"))
	case "Management.ListProjects":
		return m.ListProjects(ctx)
	case "Management.CreateProject":
		return m.CreateProject(ctx, str(a, "name"))
	case "Management.DeleteProject":
		return m.DeleteProject(ctx, str(a, "id"))
	case "Management.ListProjectMembers":
		return m.ListProjectMembers(ctx, str(a, "id"))
	case "Management.AddProjectMember":
		return nil, m.AddProjectMember(ctx, str(a, "id"), str(a, "email"), str(a, "role"))
	case "Management.RemoveProjectMember":
		return m.RemoveProjectMember(ctx, str(a, "id"), str(a, "userId"))
	case "Management.RemoveProjectMemberByUsername":
		return m.RemoveProjectMemberByUsername(ctx, str(a, "id"), str(a, "username"))
	case "Management.ActiveProject":
		id, name, err := m.ActiveProject(ctx)
		return map[string]string{"id": id, "name": name}, err
	case "Management.SetActiveProject":
		return nil, m.SetActiveProject(ctx, str(a, "project"))
	case "Management.ClearActiveProject":
		return nil, m.ClearActiveProject(ctx)
	case "Management.Decay":
		d, p, err := m.Decay(ctx, num(a, "effectiveDays"))
		return map[string]int{"demoted": d, "promoted": p}, err
	case "Management.Hygiene":
		return m.Hygiene(ctx, num(a, "k"))
	case "Management.Evaluate":
		return m.Evaluate(ctx, str(a, "suite"))
	case "Management.Adoption":
		return m.Adoption(ctx, str(a, "client"))
	case "Management.Observe":
		return nil, m.Observe(ctx, str(a, "project"), num(a, "limit"))
	case "Management.Changes":
		ch, next, err := m.Changes(ctx, str(a, "since"), num(a, "afterSeq"), num(a, "limit"))
		return map[string]any{"changes": ch, "nextSeq": next}, err
	case "Management.Usage":
		return m.Usage(ctx)
	case "Management.Export":
		es, next, err := m.Export(ctx, str(a, "afterId"), num(a, "limit"))
		return map[string]any{"entries": es, "nextAfterId": next}, err
	case "Management.Import":
		return m.Import(ctx, decode[struct {
			Entries []ImportEntry `json:"entries"`
		}](a).Entries)

	case "Admin.ProvisionUser":
		return ad.ProvisionUser(ctx, decode[ProvisionUserRequest](a))
	case "Admin.RevokeUserToken":
		return ad.RevokeUserToken(ctx, str(a, "token"))
	case "Admin.ListUsers":
		return ad.ListUsers(ctx)
	case "Admin.PreviewDeleteUser":
		return ad.PreviewDeleteUser(ctx, str(a, "id"))
	case "Admin.DeleteUser":
		return ad.DeleteUser(ctx, str(a, "id"))
	case "Admin.SetUserQuota":
		return nil, ad.SetUserQuota(ctx, str(a, "id"), QuotaOverride{MaxEntries: intp(a, "maxEntries"), WritesPerMinute: intp(a, "writesPerMinute")})
	}
	return nil, fmt.Errorf("scenario names unknown method %q", method)
}
