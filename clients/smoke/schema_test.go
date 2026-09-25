package smoke

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

func loadDoc(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile("../../docs/api/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func TestValidateCatchesMissingRequired(t *testing.T) {
	doc := loadDoc(t)
	if err := Validate(doc, "RevokeResult", map[string]any{"revoked": true}); err != nil {
		t.Fatalf("valid body rejected: %v", err)
	}
	err := Validate(doc, "RevokeResult", map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "$.revoked") {
		t.Fatalf("err = %v, want missing $.revoked", err)
	}
	err = Validate(doc, "AdminUserList", map[string]any{"users": []any{map[string]any{"id": 1}}})
	if err == nil || !strings.Contains(err.Error(), "$.users[0].id") {
		t.Fatalf("err = %v, want type error at $.users[0].id", err)
	}
}

// proved by: removing `tokenCount` from AdminUser in the handler (or adding a required field
// the handler never sends to the schema) fails this test in the sdk-smoke job.
func TestResponsesMatchSchemas(t *testing.T) {
	base, admin := os.Getenv("NOVAMEM_SMOKE_URL"), os.Getenv("NOVAMEM_SMOKE_ADMIN_TOKEN")
	if base == "" || admin == "" {
		t.Skip("NOVAMEM_SMOKE_URL unset: live schema check needs the sdk-smoke job")
	}
	doc := loadDoc(t)
	call := func(method, path, token string, body any) (int, any) {
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(method, base+path, rd)
		req.Header.Set("Authorization", "Bearer "+token)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer resp.Body.Close()
		var v any
		_ = json.NewDecoder(resp.Body).Decode(&v)
		return resp.StatusCode, v
	}
	check := func(route, schema string, status, want int, v any) {
		t.Helper()
		if status != want {
			t.Errorf("%s: status %d, want %d (%v)", route, status, want, v)
			return
		}
		if err := Validate(doc, schema, v); err != nil {
			t.Errorf("%s: %v", route, err)
		}
	}

	st, prov := call("POST", "/v1/admin/users", admin, map[string]any{"email": "smoke-user@example.com", "password": "smoke-password-1", "name": "smoke", "tokenLabel": "smoke"})
	check("POST /v1/admin/users", "ProvisionedUser", st, 201, prov)
	userID := prov.(map[string]any)["userId"].(string)
	userToken := prov.(map[string]any)["token"].(string)

	st, v := call("GET", "/v1/admin/users", admin, nil)
	check("GET /v1/admin/users", "AdminUserList", st, 200, v)
	st, v = call("PUT", "/v1/admin/users/"+userID+"/quota", admin, map[string]any{"maxEntries": 100, "writesPerMinute": 10})
	check("PUT /v1/admin/users/{id}/quota", "QuotaResult", st, 200, v)

	st, v = call("POST", "/v1/me/import", userToken, map[string]any{"entries": []any{map[string]any{"content": "smoke import"}}})
	check("POST /v1/me/import", "ImportResult", st, 201, v)
	st, v = call("GET", "/v1/me/export?limit=10", userToken, nil)
	check("GET /v1/me/export", "ExportPage", st, 200, v)

	st, minted := call("POST", "/v1/me/tokens", userToken, map[string]any{"label": "smoke-2"})
	if st != 201 {
		t.Fatalf("mint second token: %d %v", st, minted)
	}
	st, list := call("GET", "/v1/me/tokens", userToken, nil)
	if st != 200 {
		t.Fatalf("list tokens: %d", st)
	}
	var hash string
	for _, tok := range list.(map[string]any)["tokens"].([]any) {
		if m := tok.(map[string]any); m["label"] == "smoke-2" {
			hash, _ = m["tokenHash"].(string)
		}
	}
	st, v = call("DELETE", "/v1/me/tokens/"+hash, userToken, nil)
	check("DELETE /v1/me/tokens/{hash}", "TokenDeleted", st, 200, v)

	// The observer is disabled in the smoke server, so the documented answer is 404.
	st, v = call("GET", "/v1/context-prefix", userToken, nil)
	check("GET /v1/context-prefix (observer off)", "Error", st, 404, v)

	st, v = call("POST", "/v1/admin/tokens/revoke", admin, map[string]any{"token": userToken})
	check("POST /v1/admin/tokens/revoke", "RevokeResult", st, 200, v)
	st, v = call("DELETE", "/v1/admin/users/"+userID+"?dryRun=true", admin, nil)
	check("DELETE /v1/admin/users/{id}?dryRun=true", "UserDeletionPreview", st, 200, v)
	st, v = call("DELETE", "/v1/admin/users/"+userID, admin, nil)
	check("DELETE /v1/admin/users/{id}", "UserDeletion", st, 200, v)
}
