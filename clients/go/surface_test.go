package novamem

// Tests for the surfaces added alongside Client: the Remember/Context/
// Stats/Health additions, Management (/v1/me/*) and Admin (/v1/admin/*).
// Hermetic like novamem_test.go — every server here is an httptest.Server.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"
)

func newTestManagement(t *testing.T, h http.HandlerFunc) *Management {
	t.Helper()
	c, _ := newTestClient(t, h)
	return &Management{c: c}
}

func newTestAdmin(t *testing.T, h http.HandlerFunc) *Admin {
	t.Helper()
	c, _ := newTestClient(t, h)
	return &Admin{c: c}
}

func TestRememberHitsRememberRoute(t *testing.T) {
	var gotPath string
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "01K", "saved": true})
	})
	res, err := c.Remember(context.Background(), CaptureRequest{Content: "explicit fact"})
	if err != nil {
		t.Fatalf("Remember: %v", err)
	}
	if gotPath != "/v1/remember" {
		t.Fatalf("path = %q, want /v1/remember", gotPath)
	}
	if res.ID == nil || *res.ID != "01K" {
		t.Fatalf("id = %v", res.ID)
	}
}

func TestContextRequiresMessage(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("no request should be sent")
	})
	if _, err := c.Context(context.Background(), ContextRequest{}); err == nil {
		t.Fatal("want error for empty message")
	}
}

func TestContextPrefixDisabledIsNotFound(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "observer disabled"})
	})
	_, err := c.ContextPrefix(context.Background(), "")
	if !isNotFound(err) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestStatsAndHealthSendNoBody(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength != 0 {
			t.Errorf("%s %s: unexpected request body (len %d)", r.Method, r.URL.Path, r.ContentLength)
		}
		switch r.URL.Path {
		case "/v1/stats":
			_ = json.NewEncoder(w).Encode(map[string]any{"totalWarm": 7, "totalCold": 3, "byNamespace": map[string]any{}})
		case "/health":
			_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	})
	s, err := c.Stats(context.Background())
	if err != nil || s.TotalWarm != 7 {
		t.Fatalf("Stats: %v %+v", err, s)
	}
	ok, err := c.Health(context.Background())
	if err != nil || !ok {
		t.Fatalf("Health: %v %v", err, ok)
	}
}

func TestHealth503IsAnAnswerNotAnOutage(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": false})
	})
	ok, err := c.Health(context.Background())
	if err != nil {
		t.Fatalf("a served 503 {ok:false} must not be an error: %v", err)
	}
	if ok {
		t.Fatal("ok should be false")
	}
}

func TestTodaySetsSince(t *testing.T) {
	var since string
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		since, _ = body["since"].(string)
		_ = json.NewEncoder(w).Encode(Results{})
	})
	if _, err := c.Today(context.Background(), RecentRequest{}); err != nil {
		t.Fatalf("Today: %v", err)
	}
	ts, err := time.Parse(time.RFC3339, since)
	if err != nil {
		t.Fatalf("since %q is not RFC3339: %v", since, err)
	}
	if age := time.Since(ts); age < 23*time.Hour || age > 25*time.Hour {
		t.Fatalf("since is %v old, want ~24h", age)
	}
}

func TestManagementTokenLifecycle(t *testing.T) {
	m := newTestManagement(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/me/tokens":
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"token": "nm_fresh", "createdAt": "2026-01-01T00:00:00Z", "warning": "shown once"})
		case "GET /v1/me/tokens":
			_ = json.NewEncoder(w).Encode(map[string]any{"tokens": []map[string]any{{"tokenHash": "abc", "revoked": false, "createdAt": "2026-01-01T00:00:00Z"}}})
		case "DELETE /v1/me/tokens/abc":
			_ = json.NewEncoder(w).Encode(map[string]bool{"deleted": true})
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	ctx := context.Background()
	minted, err := m.MintToken(ctx, "test")
	if err != nil || minted.Token != "nm_fresh" {
		t.Fatalf("MintToken: %v %+v", err, minted)
	}
	tokens, err := m.ListTokens(ctx)
	if err != nil || len(tokens) != 1 || tokens[0].TokenHash != "abc" {
		t.Fatalf("ListTokens: %v %+v", err, tokens)
	}
	deleted, err := m.RevokeToken(ctx, "abc")
	if err != nil || !deleted {
		t.Fatalf("RevokeToken: %v %v", err, deleted)
	}
}

func TestManagementProjectLifecycle(t *testing.T) {
	m := newTestManagement(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/me/projects":
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(Project{ID: "01P", Name: "acme", Role: "owner"})
		case "GET /v1/me/projects":
			_ = json.NewEncoder(w).Encode(map[string]any{"projects": []Project{{ID: "01P", Name: "acme"}}})
		case "GET /v1/me/projects/01P/members":
			_ = json.NewEncoder(w).Encode(map[string]any{"members": []ProjectMember{{UserID: "u1", Username: "bob"}}})
		case "DELETE /v1/me/projects/01P":
			_ = json.NewEncoder(w).Encode(ProjectDeletion{Deleted: true, EntriesRemoved: 4})
		case "PUT /v1/me/active-project":
			_ = json.NewEncoder(w).Encode(map[string]any{"active": map[string]string{"id": "01P"}})
		case "DELETE /v1/me/active-project":
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	ctx := context.Background()
	p, err := m.CreateProject(ctx, "acme")
	if err != nil || p.ID != "01P" {
		t.Fatalf("CreateProject: %v %+v", err, p)
	}
	if projects, err := m.ListProjects(ctx); err != nil || len(projects) != 1 {
		t.Fatalf("ListProjects: %v %+v", err, projects)
	}
	if members, err := m.ListProjectMembers(ctx, "01P"); err != nil || members[0].Username != "bob" {
		t.Fatalf("ListProjectMembers: %v %+v", err, members)
	}
	if err := m.SetActiveProject(ctx, "01P"); err != nil {
		t.Fatalf("SetActiveProject: %v", err)
	}
	// 204 with no body must be a nil error, not "empty response body".
	if err := m.ClearActiveProject(ctx); err != nil {
		t.Fatalf("ClearActiveProject: %v", err)
	}
	del, err := m.DeleteProject(ctx, "01P")
	if err != nil || !del.Deleted || del.EntriesRemoved != 4 {
		t.Fatalf("DeleteProject: %v %+v", err, del)
	}
}

func TestAdminProvisionUser(t *testing.T) {
	a := newTestAdmin(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/admin/users" {
			t.Errorf("path = %s", r.URL.Path)
		}
		var body ProvisionUserRequest
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Email == "dup@x.local" {
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "User already exists"})
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(ProvisionedUser{UserID: "u9", Email: body.Email, Token: "nm_agent"})
	})
	ctx := context.Background()
	u, err := a.ProvisionUser(ctx, ProvisionUserRequest{Email: "agent-1@x.local", Password: "longenough", TokenLabel: "novaflow"})
	if err != nil || u.Token != "nm_agent" || u.UserID != "u9" {
		t.Fatalf("ProvisionUser: %v %+v", err, u)
	}
	_, err = a.ProvisionUser(ctx, ProvisionUserRequest{Email: "dup@x.local", Password: "longenough"})
	if !IsAlreadyExists(err) {
		t.Fatalf("want IsAlreadyExists on 409, got %v", err)
	}
	if Retryable(err) {
		t.Fatal("409 must not be retryable")
	}
	if _, err := a.ProvisionUser(ctx, ProvisionUserRequest{Email: "", Password: ""}); err == nil {
		t.Fatal("want validation error for missing fields")
	}
}

func TestAdminRevokeUserToken(t *testing.T) {
	a := newTestAdmin(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/admin/tokens/revoke" {
			t.Errorf("path = %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"revoked": true})
	})
	ok, err := a.RevokeUserToken(context.Background(), "nm_gone")
	if err != nil || !ok {
		t.Fatalf("RevokeUserToken: %v %v", err, ok)
	}
}

// isNotFound mirrors what callers write with errors.Is.
func isNotFound(err error) bool {
	return errors.Is(err, ErrNotFound)
}

func TestObserveDisabledIsNotRetryable(t *testing.T) {
	m := newTestManagement(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "observer disabled"})
	})
	err := m.Observe(context.Background(), "", 0)
	if err == nil {
		t.Fatal("want error")
	}
	if Retryable(err) || Unavailable(err) {
		t.Fatalf("observer-disabled must be neither retryable nor unavailable: %v", err)
	}
	var e *Error
	if !errors.As(err, &e) || e.Code != "observer_disabled" {
		t.Fatalf("want Code observer_disabled, got %v", err)
	}
}
