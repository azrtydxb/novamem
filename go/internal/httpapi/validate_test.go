package httpapi

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

type envelope struct {
	Error  string  `json:"error"`
	Issues []issue `json:"issues"`
}

func doReq(t *testing.T, authMode, authToken, method, path, body string, headers map[string]string) (*httptest.ResponseRecorder, envelope) {
	t.Helper()
	h := newTestServer(t, authMode, authToken)
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	for k, val := range headers {
		req.Header.Set(k, val)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var env envelope
	_ = json.Unmarshal(rec.Body.Bytes(), &env)
	return rec, env
}

// The conformance 80-errors suite pins this envelope: 400,
// error "invalid request body", and an issues[] entry with path
// "content" for a missing required field.
func TestZodEnvelopeMissingContent(t *testing.T) {
	rec, env := doReq(t, "none", "", "POST", "/v1/remember", `{}`, nil)
	if rec.Code != 400 {
		t.Fatalf("status %d, want 400", rec.Code)
	}
	if env.Error != "invalid request body" {
		t.Fatalf("error %q", env.Error)
	}
	found := false
	for _, i := range env.Issues {
		if i.Path == "content" {
			found = true
			if i.Code != "invalid_type" || i.Message != "Required" {
				t.Fatalf("content issue = %+v", i)
			}
		}
	}
	if !found {
		t.Fatalf("no issue with path 'content': %+v", env.Issues)
	}
	assertHardeningHeaders(t, "/v1/remember", rec)
}

func TestZodEnvelopeOversizedContent(t *testing.T) {
	// One char over MAX_CONTENT_BYTES (schemas.ts) — but under the 2MB
	// transport body limit, so the schema layer answers.
	content := strings.Repeat("x", MaxContentBytes+1)
	body := `{"content":"` + content + `"}`
	rec, env := doReq(t, "none", "", "POST", "/v1/remember", body, nil)
	if rec.Code != 400 {
		t.Fatalf("status %d, want 400", rec.Code)
	}
	if env.Error != "invalid request body" {
		t.Fatalf("error %q", env.Error)
	}
	if len(env.Issues) == 0 || env.Issues[0].Path != "content" || env.Issues[0].Code != "too_big" {
		t.Fatalf("issues = %+v", env.Issues)
	}
}

func TestZodEnvelopeFieldRules(t *testing.T) {
	tests := []struct {
		name     string
		body     string
		wantPath string
		wantCode string
	}{
		{"content wrong type", `{"content": 7}`, "content", "invalid_type"},
		{"namespace too long", `{"content":"a valid fact of length","namespace":"` + strings.Repeat("n", 129) + `"}`, "namespace", "too_big"},
		{"bad sensitivity", `{"content":"a valid fact of length","sensitivity":"topsecret"}`, "sensitivity", "invalid_enum_value"},
		{"confidence over 1", `{"content":"a valid fact of length","confidence":1.5}`, "confidence", "too_big"},
		{"bad expiresAt", `{"content":"a valid fact of length","expiresAt":"tomorrow"}`, "expiresAt", "invalid_string"},
		{"metadata key too long", `{"content":"a valid fact of length","metadata":{"` + strings.Repeat("k", 65) + `":1}}`, "metadata", "custom"},
		{"project control chars", "{\"content\":\"a valid fact of length\",\"project\":\"a\\u0007b\"}", "project", "invalid_string"},
		{"force wrong type", `{"content":"a valid fact of length","force":"yes"}`, "force", "invalid_type"},
	}
	for _, tt := range tests {
		rec, env := doReq(t, "none", "", "POST", "/v1/remember", tt.body, nil)
		if rec.Code != 400 {
			t.Errorf("%s: status %d, want 400", tt.name, rec.Code)
			continue
		}
		found := false
		for _, i := range env.Issues {
			if i.Path == tt.wantPath && i.Code == tt.wantCode {
				found = true
			}
		}
		if !found {
			t.Errorf("%s: no issue path=%s code=%s in %+v", tt.name, tt.wantPath, tt.wantCode, env.Issues)
		}
	}
}

func TestRecentBodyValidation(t *testing.T) {
	tests := []struct {
		name     string
		body     string
		wantPath string
	}{
		{"k over 200", `{"k": 201}`, "k"},
		{"k float", `{"k": 1.5}`, "k"},
		{"bad since", `{"since": "yesterday"}`, "since"},
		{"bad contentMode", `{"contentMode": "brief"}`, "contentMode"},
		{"too many includeNamespaces", `{"includeNamespaces": [` + strings.TrimSuffix(strings.Repeat(`"ns",`, 17), ",") + `]}`, "includeNamespaces"},
		{"bad namespace item", `{"includeNamespaces": ["-bad"]}`, "includeNamespaces.0"},
	}
	for _, tt := range tests {
		rec, env := doReq(t, "none", "", "POST", "/v1/recent", tt.body, nil)
		if rec.Code != 400 {
			t.Errorf("%s: status %d, want 400 (%s)", tt.name, rec.Code, rec.Body.String())
			continue
		}
		found := false
		for _, i := range env.Issues {
			if i.Path == tt.wantPath {
				found = true
			}
		}
		if !found {
			t.Errorf("%s: no issue with path %q in %+v", tt.name, tt.wantPath, env.Issues)
		}
	}
	// since message is custom (schemas.ts RecentBody).
	_, env := doReq(t, "none", "", "POST", "/v1/recent", `{"since":"nope"}`, nil)
	if env.Issues[0].Message != "since must be ISO-8601 (e.g. 2026-05-02T17:00:00Z)" {
		t.Fatalf("since message = %q", env.Issues[0].Message)
	}
}

// Auth contract (http.ts): bearer mode 401s {"error":"unauthorized"} on
// a missing or wrong token, exact body; none mode is open.
func TestBearerAuth(t *testing.T) {
	rec, env := doReq(t, "bearer", "sekret", "POST", "/v1/remember", `{}`, nil)
	if rec.Code != 401 || env.Error != "unauthorized" {
		t.Fatalf("no token: %d %q", rec.Code, env.Error)
	}
	rec, env = doReq(t, "bearer", "sekret", "POST", "/v1/remember", `{}`,
		map[string]string{"Authorization": "Bearer wrong"})
	if rec.Code != 401 || env.Error != "unauthorized" {
		t.Fatalf("wrong token: %d %q", rec.Code, env.Error)
	}
	// Right token reaches the validation layer (400, not 401).
	rec, _ = doReq(t, "bearer", "sekret", "POST", "/v1/remember", `{}`,
		map[string]string{"Authorization": "Bearer sekret"})
	if rec.Code != 400 {
		t.Fatalf("right token: %d, want 400 from validation", rec.Code)
	}
	// Health probes stay public in bearer mode.
	rec, _ = doReq(t, "bearer", "sekret", "GET", "/live", "", nil)
	if rec.Code != 200 {
		t.Fatalf("/live gated: %d", rec.Code)
	}
}

// Body-parse failures are their own contract, distinct from schema
// issues (Fastify answers them before any schema runs). Slice-8 parity
// audit found every JSON endpoint collapsing all three cases into a
// bogus "<field> Required" issue.
func TestMalformedBodyEnvelopes(t *testing.T) {
	for _, path := range []string{"/v1/remember", "/v1/search", "/v1/forget", "/v1/recent"} {
		rec, env := doReq(t, "none", "", "POST", path, `{not json`, nil)
		if rec.Code != 400 {
			t.Fatalf("%s unparseable: status %d", path, rec.Code)
		}
		if env.Error != "Body is not valid JSON but content-type is set to 'application/json'" {
			t.Fatalf("%s unparseable: error = %q", path, env.Error)
		}
		if len(env.Issues) != 0 {
			t.Fatalf("%s unparseable: parse errors carry no issues, got %v", path, env.Issues)
		}

		for body, want := range map[string]string{
			`[1,2]`: "Invalid input: expected object, received array",
			`"s"`:   "Invalid input: expected object, received string",
			`5`:     "Invalid input: expected object, received number",
		} {
			rec, env := doReq(t, "none", "", "POST", path, body, nil)
			if rec.Code != 400 || env.Error != "invalid request body" {
				t.Fatalf("%s %s: %d %q", path, body, rec.Code, env.Error)
			}
			if len(env.Issues) != 1 || env.Issues[0].Path != "" || env.Issues[0].Message != want {
				t.Fatalf("%s %s: issues = %+v, want path \"\" message %q", path, body, env.Issues, want)
			}
		}
	}
}

// A literal null body is a present-but-wrong-typed body, not an absent
// one. Verified against the live TS oracle.
func TestNullBodyEnvelope(t *testing.T) {
	_, err := decodeBody([]byte("null"), false)
	var iss *issue
	if !errors.As(err, &iss) {
		t.Fatalf("want an issue, got %v", err)
	}
	if iss.Message != "Invalid input: expected object, received null" {
		t.Fatalf("message = %q", iss.Message)
	}
	if m, err := decodeBody([]byte("null"), true); err != nil || len(m) != 0 {
		t.Fatalf("optional null should be an empty object: %v %v", m, err)
	}
}
