package novamem

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Management is the caller's own account-management surface: API tokens,
// projects and their members, the active project, and the maintenance
// endpoints (/v1/me/*, /v1/decay, …), all performed as the user who owns the
// bearer. It is a separate type from Client on purpose — see the package
// comment: an agent handed a Client cannot delete a project or mint a token by
// accident, because its client simply has no such methods.
//
// Same transport, same error contract: every method returns *Error, and
// Unavailable / Retryable / ErrNotFound classify failures exactly as they do
// on Client. Construct with NewManagement.
type Management struct {
	c *Client
}

// NewManagement validates cfg and returns a management client. Deliberately a
// separate constructor rather than a method on Client, so granting an agent
// memory access never implicitly grants it account management.
func NewManagement(cfg Config) (*Management, error) {
	c, err := New(cfg)
	if err != nil {
		return nil, err
	}
	return &Management{c: c}, nil
}

// ─── Tokens (per-device API keys) ──────────────────────────────────────────

// Token is one bearer as the listing shows it. The plaintext is absent — the
// server stores only the hash; TokenHash is the handle for revocation.
type Token struct {
	TokenHash string  `json:"tokenHash"`
	Label     *string `json:"label"`
	// Scope is "full" or "read_only".
	Scope string `json:"scope"`
	// ProjectID is non-nil when the token is confined to one project.
	ProjectID *string `json:"projectId"`
	// ExpiresAt is non-nil for tokens with a hard expiry (RFC3339).
	ExpiresAt  *string `json:"expiresAt"`
	CreatedAt  string  `json:"createdAt"`
	LastUsedAt *string `json:"lastUsedAt"`
	Revoked    bool    `json:"revoked"`
}

// MintTokenRequest describes the bearer to mint. Zero values mean the
// historical default: full scope, user-wide, never expires.
type MintTokenRequest struct {
	// Label is optional operator context ("laptop", "novaflow").
	Label string `json:"label,omitempty"`
	// Scope "read_only" limits the token to GET plus the read-shaped POST
	// routes (search/recent/neighbors/context). Empty means "full".
	Scope string `json:"scope,omitempty"`
	// Project (id or name; the caller must be a member) confines the token
	// to that project. Confined tokens cannot reach /v1/auth/*,
	// /v1/admin/* or token minting, and every data-plane call is forced
	// into the project.
	Project string `json:"project,omitempty"`
	// ExpiresInDays sets a hard expiry (max 3650). 0 = never.
	ExpiresInDays int `json:"expiresInDays,omitempty"`
}

// MintedToken carries the one-time plaintext of a freshly minted bearer.
type MintedToken struct {
	// Token is the plaintext `nm_…` bearer. THIS IS THE ONLY TIME IT EXISTS —
	// the server keeps only its hash. Store it like a password.
	Token     string  `json:"token"`
	ProjectID *string `json:"projectId"`
	CreatedAt string  `json:"createdAt"`
	// Warning is the server's own reminder about one-time visibility.
	Warning string `json:"warning"`
}

// MintToken mints a new bearer for the calling user. Restricted tokens
// (read-only scope, project confinement, expiry) are the right shape to
// hand to less trusted processes — they cannot mint further tokens or
// reach admin/auth surfaces, and rotation preserves their restrictions.
func (m *Management) MintToken(ctx context.Context, req MintTokenRequest) (MintedToken, error) {
	var out MintedToken
	err := m.c.do(ctx, "mint-token", http.MethodPost, "/v1/me/tokens", req, &out)
	return out, err
}

// ListTokens lists the caller's bearers (hashes, never plaintext).
func (m *Management) ListTokens(ctx context.Context) ([]Token, error) {
	var out struct {
		Tokens []Token `json:"tokens"`
	}
	err := m.c.do(ctx, "list-tokens", http.MethodGet, "/v1/me/tokens", nil, &out)
	return out.Tokens, err
}

// RevokeToken hard-deletes one of the caller's bearers by its sha256 hash (as
// listed by ListTokens). Deleting the token this client authenticates with
// works — and locks this client out on the next call.
func (m *Management) RevokeToken(ctx context.Context, tokenHash string) (bool, error) {
	hash := strings.TrimSpace(tokenHash)
	if hash == "" {
		return false, &Error{Op: "revoke-token", Message: "tokenHash is required"}
	}
	var out struct {
		Deleted bool `json:"deleted"`
	}
	err := m.c.do(ctx, "revoke-token", http.MethodDelete, "/v1/me/tokens/"+url.PathEscape(hash), nil, &out)
	return out.Deleted, err
}

// ─── Projects (sub-brains) ─────────────────────────────────────────────────

// Project is one sub-brain as the listing shows it.
type Project struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Role is the CALLER's role in it: "owner" or "member".
	Role        string `json:"role"`
	OwnerUserID string `json:"ownerUserId"`
	CreatedAt   string `json:"createdAt"`
}

// ProjectMember is one row of a project's membership listing.
type ProjectMember struct {
	UserID string `json:"userId"`
	// Username is the display handle (derived from the member's email).
	Username string `json:"username"`
	Role     string `json:"role"`
	JoinedAt string `json:"joinedAt"`
}

// ProjectDeletion reports what removing a project actually removed.
type ProjectDeletion struct {
	Deleted        bool `json:"deleted"`
	EntriesRemoved int  `json:"entriesRemoved"`
	// ColdCollectionsDropped names the vector collections that went with it.
	ColdCollectionsDropped []string `json:"coldCollectionsDropped"`
	GraphCleared           bool     `json:"graphCleared"`
}

// ListProjects lists every project the caller belongs to.
func (m *Management) ListProjects(ctx context.Context) ([]Project, error) {
	var out struct {
		Projects []Project `json:"projects"`
	}
	err := m.c.do(ctx, "list-projects", http.MethodGet, "/v1/me/projects", nil, &out)
	return out.Projects, err
}

// CreateProject creates a project owned by the caller. The id is
// server-assigned; pass either the id or the (unique-per-owner) name to
// data-plane calls.
func (m *Management) CreateProject(ctx context.Context, name string) (Project, error) {
	var out Project
	if strings.TrimSpace(name) == "" {
		return out, &Error{Op: "create-project", Message: "name is required"}
	}
	body := struct {
		Name string `json:"name"`
	}{Name: name}
	err := m.c.do(ctx, "create-project", http.MethodPost, "/v1/me/projects", body, &out)
	return out, err
}

// DeleteProject removes a project AND its memories, vector collections and
// graph scope. Owner-only server-side. There is no undo; the return value
// itemizes what is gone so the caller can log a truthful record of it.
func (m *Management) DeleteProject(ctx context.Context, id string) (ProjectDeletion, error) {
	var out ProjectDeletion
	if strings.TrimSpace(id) == "" {
		return out, &Error{Op: "delete-project", Message: "id is required"}
	}
	err := m.c.do(ctx, "delete-project", http.MethodDelete, "/v1/me/projects/"+url.PathEscape(id), nil, &out)
	return out, err
}

// ListProjectMembers lists a project's membership.
func (m *Management) ListProjectMembers(ctx context.Context, id string) ([]ProjectMember, error) {
	if strings.TrimSpace(id) == "" {
		return nil, &Error{Op: "list-members", Message: "id is required"}
	}
	var out struct {
		Members []ProjectMember `json:"members"`
	}
	err := m.c.do(ctx, "list-members", http.MethodGet, "/v1/me/projects/"+url.PathEscape(id)+"/members", nil, &out)
	return out.Members, err
}

// RemoveProjectMemberByUsername removes a member by display username: it
// lists the membership, resolves the username to a user id, and removes
// that member. Mirrors the TS client's convenience wrapper.
func (m *Management) RemoveProjectMemberByUsername(ctx context.Context, id, username string) (bool, error) {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(username) == "" {
		return false, &Error{Op: "remove-member", Message: "id and username are required"}
	}
	members, err := m.ListProjectMembers(ctx, id)
	if err != nil {
		return false, err
	}
	for _, mem := range members {
		if mem.Username == username {
			return m.RemoveProjectMember(ctx, id, mem.UserID)
		}
	}
	return false, &Error{Op: "remove-member", Message: "unknown member '" + username + "'"}
}

// AddProjectMember adds a user to a project by their EXACT EMAIL — the
// server resolves the target with an exact-email lookup, despite the wire
// field being named "username" for historical reasons (the display username
// is derived from the email and is not unique). Pass the address the user
// signs in with; a display handle will simply not match. role is "member" or
// "owner"; empty means the server default ("member").
func (m *Management) AddProjectMember(ctx context.Context, id, email, role string) error {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(email) == "" {
		return &Error{Op: "add-member", Message: "id and email are required"}
	}
	body := struct {
		// Wire name is "username"; the value is an exact email. See method doc.
		Username string `json:"username"`
		Role     string `json:"role,omitempty"`
	}{Username: email, Role: role}
	var out struct {
		Added bool `json:"added"`
	}
	return m.c.do(ctx, "add-member", http.MethodPost, "/v1/me/projects/"+url.PathEscape(id)+"/members", body, &out)
}

// RemoveProjectMember removes a member by user id (from ListProjectMembers).
func (m *Management) RemoveProjectMember(ctx context.Context, id, userID string) (bool, error) {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(userID) == "" {
		return false, &Error{Op: "remove-member", Message: "id and userId are required"}
	}
	var out struct {
		Removed bool `json:"removed"`
	}
	err := m.c.do(ctx, "remove-member", http.MethodDelete,
		"/v1/me/projects/"+url.PathEscape(id)+"/members/"+url.PathEscape(userID), nil, &out)
	return out.Removed, err
}

// ─── Active project ────────────────────────────────────────────────────────

// ActiveProject reports the caller's current default scope, or ("", "") when
// none is set. Reads with no explicit scope union user-global with this
// project; writes with no explicit scope land in it.
func (m *Management) ActiveProject(ctx context.Context) (id, name string, err error) {
	var out struct {
		Active *struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"active"`
	}
	if err := m.c.do(ctx, "active-project", http.MethodGet, "/v1/me/active-project", nil, &out); err != nil {
		return "", "", err
	}
	if out.Active == nil {
		return "", "", nil
	}
	return out.Active.ID, out.Active.Name, nil
}

// SetActiveProject sets the caller's default scope (id or name).
func (m *Management) SetActiveProject(ctx context.Context, project string) error {
	if strings.TrimSpace(project) == "" {
		return &Error{Op: "set-active-project", Message: "project is required"}
	}
	body := struct {
		Project string `json:"project"`
	}{Project: project}
	var out struct {
		Active struct {
			ID string `json:"id"`
		} `json:"active"`
	}
	return m.c.do(ctx, "set-active-project", http.MethodPut, "/v1/me/active-project", body, &out)
}

// ClearActiveProject reverts the caller to user-global scope. The server
// answers 204; a nil error is the whole result.
func (m *Management) ClearActiveProject(ctx context.Context) error {
	return m.c.do(ctx, "clear-active-project", http.MethodDelete, "/v1/me/active-project", nil, nil)
}

// ─── Maintenance + diagnostics ─────────────────────────────────────────────
//
// These mirror the TypeScript client's operator conveniences. In user auth
// mode the server gates decay and observe on the admin role; a plain user's
// bearer gets 403, which surfaces here as a non-retryable *Error.

// Decay runs one demote/promote pass over the caller-visible entries.
func (m *Management) Decay(ctx context.Context, effectiveDays int) (demoted, promoted int, err error) {
	body := struct {
		EffectiveDays int `json:"effectiveDays,omitempty"`
	}{EffectiveDays: effectiveDays}
	var out struct {
		Demoted  int `json:"demoted"`
		Promoted int `json:"promoted"`
	}
	if err := m.c.do(ctx, "decay", http.MethodPost, "/v1/decay", body, &out); err != nil {
		return 0, 0, err
	}
	return out.Demoted, out.Promoted, nil
}

// Hygiene reports low-value, stale, duplicate, contradictory and orphaned
// entries. Shapes are intentionally loose (server heuristics evolve); callers
// mostly count and sample them.
type Hygiene struct {
	LowValue                []map[string]any `json:"lowValue"`
	Stale                   []map[string]any `json:"stale"`
	DuplicateClusters       []any            `json:"duplicateClusters"`
	ContradictionCandidates []any            `json:"contradictionCandidates"`
	OrphanCandidates        []any            `json:"orphanCandidates"`
}

// Hygiene runs the memory-hygiene report. k bounds each list (0 = server
// default).
func (m *Management) Hygiene(ctx context.Context, k int) (Hygiene, error) {
	body := struct {
		K int `json:"k,omitempty"`
	}{K: k}
	var out Hygiene
	err := m.c.do(ctx, "hygiene", http.MethodPost, "/v1/hygiene", body, &out)
	return out, err
}

// Evaluation is the result of the server's built-in quality scenarios.
type Evaluation struct {
	Suite   string `json:"suite"`
	Summary struct {
		Total  int `json:"total"`
		Passed int `json:"passed"`
		Failed int `json:"failed"`
	} `json:"summary"`
	Cases []struct {
		Name   string `json:"name"`
		Passed bool   `json:"passed"`
	} `json:"cases"`
}

// Evaluate runs a built-in memory-quality suite ("" = default).
func (m *Management) Evaluate(ctx context.Context, suite string) (Evaluation, error) {
	body := struct {
		Suite string `json:"suite,omitempty"`
	}{Suite: suite}
	var out Evaluation
	err := m.c.do(ctx, "evaluate", http.MethodPost, "/v1/evaluate", body, &out)
	return out, err
}

// Adoption reports the server's integration-health diagnostics for a client
// integration. The shape is dominated by free-form diagnostics; exposed as raw
// maps for the same reason as Hygiene.
func (m *Management) Adoption(ctx context.Context, client string) (map[string]any, error) {
	body := struct {
		Client string `json:"client,omitempty"`
	}{Client: client}
	var out map[string]any
	err := m.c.do(ctx, "adoption", http.MethodPost, "/v1/adoption", body, &out)
	return out, err
}

// Observe triggers one observer+reflector pass over recent memories (the
// pipeline behind Client.ContextPrefix). limit 0 means the server default.
//
// The server answers 503 when the observer FEATURE IS DISABLED — a stable
// configuration answer, not an outage, so unlike every other 5xx it comes
// back neither Unavailable nor Retryable: retrying a feature flag does not
// flip it. Branch on it via *Error.Code == "observer_disabled".
func (m *Management) Observe(ctx context.Context, project string, limit int) error {
	body := struct {
		Project string `json:"project,omitempty"`
		Limit   int    `json:"limit,omitempty"`
	}{Project: project, Limit: limit}
	var out map[string]any
	err := m.c.do(ctx, "observe", http.MethodPost, "/v1/observe", body, &out)
	var e *Error
	if errors.As(err, &e) && e.StatusCode == http.StatusServiceUnavailable {
		return &Error{Op: "observe", StatusCode: e.StatusCode, Code: "observer_disabled", Message: "observer disabled"}
	}
	return err
}

// Change is one changelog event: what happened to one entry.
type Change struct {
	// Seq is the stable pagination cursor — pass the page's last Seq back
	// as AfterSeq to resume without missing same-timestamp events.
	Seq       int     `json:"seq"`
	EntryID   string  `json:"entryId"`
	ProjectID *string `json:"projectId"`
	// Change is "created", "updated", "superseded", "deleted" or "expired".
	Change string         `json:"change"`
	Detail map[string]any `json:"detail"`
	At     string         `json:"at"`
}

// Changes pages the caller's memory changelog, oldest-first. since is an
// optional RFC3339 lower bound; afterSeq (preferred for paging) resumes
// strictly after that cursor; limit caps the page (server max 500).
//
// The log is BEST-EFFORT by contract: appends never block mutations, so
// a failed append means a missed event. Use it for auditing and cache
// invalidation hints, not as the source of truth.
func (m *Management) Changes(ctx context.Context, since string, afterSeq, limit int) ([]Change, int, error) {
	q := url.Values{}
	if since != "" {
		q.Set("since", since)
	}
	if afterSeq > 0 {
		q.Set("afterSeq", strconv.Itoa(afterSeq))
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	path := "/v1/me/changes"
	if enc := q.Encode(); enc != "" {
		path += "?" + enc
	}
	var out struct {
		Changes []Change `json:"changes"`
		NextSeq *int     `json:"nextSeq"`
	}
	if err := m.c.do(ctx, "changes", http.MethodGet, path, nil, &out); err != nil {
		return nil, 0, err
	}
	next := afterSeq
	if out.NextSeq != nil {
		next = *out.NextSeq
	}
	return out.Changes, next, nil
}

// Usage is the caller's stored-entry count and quota overrides (nil
// fields mean the server default applies).
type Usage struct {
	Entries int `json:"entries"`
	Quota   struct {
		MaxEntries      *int `json:"maxEntries"`
		WritesPerMinute *int `json:"writesPerMinute"`
	} `json:"quota"`
}

// Usage reports the caller's memory footprint against their quotas.
func (m *Management) Usage(ctx context.Context) (Usage, error) {
	var out Usage
	err := m.c.do(ctx, "usage", http.MethodGet, "/v1/me/usage", nil, &out)
	return out, err
}

// ExportedEntry is one row of an export page.
type ExportedEntry struct {
	ID           string         `json:"id"`
	ProjectID    *string        `json:"projectId"`
	Content      string         `json:"content"`
	Namespace    string         `json:"namespace"`
	Source       string         `json:"source"`
	AgentName    *string        `json:"agentName"`
	Metadata     map[string]any `json:"metadata"`
	SourceType   *string        `json:"sourceType"`
	CapturedFrom *string        `json:"capturedFrom"`
	Confidence   float64        `json:"confidence"`
	CreatedAt    string         `json:"createdAt"`
	UpdatedAt    string         `json:"updatedAt"`
}

// Export pages every entry the caller owns, oldest id first. Pass the
// returned cursor back as afterID until it returns an empty page.
func (m *Management) Export(ctx context.Context, afterID string, limit int) ([]ExportedEntry, string, error) {
	q := url.Values{}
	if afterID != "" {
		q.Set("afterId", afterID)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	path := "/v1/me/export"
	if enc := q.Encode(); enc != "" {
		path += "?" + enc
	}
	var out struct {
		Entries     []ExportedEntry `json:"entries"`
		NextAfterID *string         `json:"nextAfterId"`
	}
	if err := m.c.do(ctx, "export", http.MethodGet, path, nil, &out); err != nil {
		return nil, "", err
	}
	next := afterID
	if out.NextAfterID != nil {
		next = *out.NextAfterID
	}
	return out.Entries, next, nil
}

// ImportEntry is one entry to import — the writable subset of
// ExportedEntry (ids are never preserved across deployments).
type ImportEntry struct {
	Content      string         `json:"content"`
	Namespace    string         `json:"namespace,omitempty"`
	Source       string         `json:"source,omitempty"`
	AgentName    string         `json:"agentName,omitempty"`
	Project      string         `json:"project,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	SourceType   string         `json:"sourceType,omitempty"`
	CapturedFrom string         `json:"capturedFrom,omitempty"`
	Confidence   *float64       `json:"confidence,omitempty"`
}

// ImportResult reports an import page's outcome.
type ImportResult struct {
	Imported     int `json:"imported"`
	Deduplicated int `json:"deduplicated"`
	Failed       []struct {
		Index int    `json:"index"`
		Error string `json:"error"`
	} `json:"failed"`
}

// Import stores a page of entries (max 200 per call) as new memories for
// the calling user. Content-hash dedup makes re-importing the same page
// idempotent — repeated entries count as Deduplicated, not Imported.
func (m *Management) Import(ctx context.Context, entries []ImportEntry) (ImportResult, error) {
	var out ImportResult
	if len(entries) == 0 {
		return out, &Error{Op: "import", Message: "entries are required"}
	}
	body := struct {
		Entries []ImportEntry `json:"entries"`
	}{Entries: entries}
	err := m.c.do(ctx, "import", http.MethodPost, "/v1/me/import", body, &out)
	return out, err
}
