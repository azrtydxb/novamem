// Package novamem is a Go client for the NovaMem memory service.
//
// # The service in one screen
//
// NovaMem stores durable facts for an agent or application and retrieves them
// by hybrid search — keyword, vector and graph signals fused into one ranking.
// Three things about its model shape every call you will make:
//
//   - ISOLATION IS PER USER. A bearer token (`nm_…`) belongs to a user and
//     carries every right that user has. There is no per-token scope-down: a
//     leaked token is a leaked account, so treat it exactly like a password.
//     Mint one from the dashboard's API Tokens page, via [Management.MintToken],
//     or — for fleet provisioning — via [Admin.ProvisionUser].
//   - PROJECTS ARE THE SHARING BOUNDARY. Every entry is either user-wide or
//     belongs to a project (a "sub-brain") whose members can all read and
//     delete its entries. Pass Project (an id or a human name) to scope a
//     call; leave it empty for user-wide. IncludeProjects unions a read across
//     the user-wide store and the listed projects in one request.
//   - NAMESPACES ARE SHELVES, NOT SECURITY. A namespace groups entries within
//     a scope. It is opaque to the engine and enforces nothing.
//
// # The one property this client will not compromise
//
// NovaMem is a network service. It WILL be unreachable sometimes, and the
// whole design of this package follows from insisting that a caller can always
// tell these two apart:
//
//	res, err := c.Search(ctx, novamem.SearchRequest{Query: q})
//	switch {
//	case novamem.Unavailable(err):
//	    // "I could not look." Say that. Do not claim ignorance.
//	case err != nil:
//	    // A real answer that was not success: bad token, bad request.
//	case len(res.Entries) == 0:
//	    // "There is nothing stored about that." This one is knowledge.
//	}
//
// Conflating them is how an agent ends up telling a person "I have no record
// of that" when the truth is that a pod was restarting. Empty results with a
// nil error are the only thing this package will ever present as absence.
//
// Everything else is downstream of that: every call takes a context and is
// bounded even if that context has no deadline; the read paths never retry, so
// a caller can degrade in one round trip rather than after three backoffs; and
// errors say whether they are worth retrying, so the write path — the one
// where a dropped call loses information — can be retried by whoever owns the
// retry budget. The client holds no global state and reads no environment: you
// supply the base URL and token, which is what makes two clients, or a test
// against an httptest.Server, possible in one process.
//
// # Quickstart
//
//	c, err := novamem.New(novamem.Config{
//	    BaseURL: "http://localhost:7778",
//	    Token:   os.Getenv("NOVAMEM_TOKEN"), // nm_…
//	})
//	if err != nil {
//	    return err
//	}
//	if _, err := c.Capture(ctx, novamem.CaptureRequest{
//	    Content: "User prefers dark roast",
//	}); err != nil {
//	    return err
//	}
//	res, err := c.Search(ctx, novamem.SearchRequest{Query: "coffee preference", K: 5})
//
// Client covers the data-plane operations an agent needs: Capture, Remember,
// Search, Recent, Neighbors, Update, Forget, plus the context helpers
// (Context, SessionRecap, ContextPrefix, Today) and the read-only Stats and
// Health probes. Project and token administration are deliberately NOT on
// Client — an agent process holding a client should not be able to perform
// them by accident. They live on two separate, explicitly-constructed types:
//
//   - [Management] (NewManagement) — the caller's own /v1/me/* surface:
//     API tokens, projects and members, active project, and the maintenance
//     endpoints (decay, hygiene, evaluate, adoption, observe).
//   - [Admin] (NewAdmin) — server administration with an admin user's
//     bearer: non-interactive user provisioning (ProvisionUser) and token
//     revocation. This is what an orchestrator uses to create one NovaMem
//     user per agent.
package novamem

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultTimeout bounds a single call when Config.Timeout is unset.
//
// Sized for the SLOWEST operation rather than the typical one: Capture embeds
// the content server-side before it answers, so a limit tuned to a warm search
// would turn every write into a spurious timeout. Pass a shorter context
// deadline when you have a tighter budget — this exists so that a caller who
// passes context.Background() at a black-holed host still gets an answer
// instead of a goroutine stuck forever.
const DefaultTimeout = 15 * time.Second

// ErrUnavailable marks every failure that means "I could not look".
//
// The one error a caller MUST test for, via Unavailable. It covers anything
// that left us without an answer from a working NovaMem: a refused dial, a DNS
// failure, a timeout, a 5xx, a 429, a body that is not the JSON this API
// promises. Deliberately NOT matched by 400/401/403/404 — those are answers,
// and an agent that treats "your token is wrong" as "the store is down" will
// wait out an outage that no amount of waiting fixes.
var ErrUnavailable = errors.New("novamem unavailable")

// ErrNotFound is the store answering "that id is not in your scope".
//
// A real answer, not an outage, which is why it is a separate sentinel: an
// Update against a deleted memory should tell you the memory is gone, not that
// memory is unreachable.
var ErrNotFound = errors.New("novamem: not found")

// Error is what every method in this package returns on failure.
//
// It carries StatusCode for callers that want to be specific, but the two
// questions worth asking are answered by Unavailable(err) and Retryable(err) —
// those are the ones that change what an agent says or does.
//
// It NEVER contains the bearer token. Not in Message, not in the wrapped
// cause. Errors get logged, and a log line is the classic way a long-lived
// credential escapes into somewhere it is never rotated out of.
type Error struct {
	// Op is the client method that failed ("search", "capture", …).
	Op string
	// StatusCode is the HTTP status, or 0 when no response was received.
	StatusCode int
	// Code is the server's machine-readable error code when it sent one.
	Code string
	// Message is the server's human-readable message, or a description of the
	// transport failure. Never contains credentials.
	Message string

	unavailable bool
	retryable   bool
	cause       error
}

func (e *Error) Error() string {
	var b strings.Builder
	b.WriteString("novamem ")
	b.WriteString(e.Op)
	if e.StatusCode != 0 {
		fmt.Fprintf(&b, ": %d", e.StatusCode)
	}
	if e.Code != "" {
		b.WriteString(" [" + e.Code + "]")
	}
	if e.Message != "" {
		b.WriteString(": " + e.Message)
	}
	return b.String()
}

// Unwrap exposes the underlying cause alongside the ErrUnavailable and
// ErrNotFound sentinels, so errors.Is works on the classification without a
// caller reaching for errors.As and reading a bool field. The multi-error
// Unwrap is what lets one error be simultaneously "is a context deadline" and
// "is unavailable" — which is exactly what a timeout is.
func (e *Error) Unwrap() []error {
	var out []error
	if e.cause != nil {
		out = append(out, e.cause)
	}
	if e.unavailable {
		out = append(out, ErrUnavailable)
	}
	if e.StatusCode == http.StatusNotFound {
		out = append(out, ErrNotFound)
	}
	return out
}

// Retryable reports whether calling again could plausibly succeed.
func (e *Error) Retryable() bool { return e.retryable }

// Unavailable reports whether err means the store could not be consulted.
//
// Branch on this before saying anything about what you do or do not remember.
func Unavailable(err error) bool { return errors.Is(err, ErrUnavailable) }

// Retryable reports whether err is worth retrying.
//
// True only where a retry is both safe and useful: transport failures,
// timeouts, 429 and 5xx. A rejected token or a malformed request is never
// retryable no matter how many times it is asked. Retry policy itself is the
// caller's — this package never retries on your behalf, because the right
// budget and backoff depend on a turn deadline it cannot see.
func Retryable(err error) bool {
	var e *Error
	if errors.As(err, &e) {
		return e.Retryable()
	}
	return false
}

// Config is everything the client needs, all of it injected.
//
// No environment reads live in this package on purpose: NovaMem's address and
// token are deployment facts, and a library that reaches for os.Getenv makes
// itself impossible to point at a test server, impossible to use twice in one
// process, and impossible to reason about from the call site.
type Config struct {
	// BaseURL of the NovaMem service, e.g. "https://novamem.example.com".
	// A trailing slash is tolerated.
	BaseURL string
	// Token is the long-lived opaque bearer (`nm_…`). Sent as
	// "Authorization: Bearer <token>" and never included in an error.
	Token string
	// Timeout bounds a single call. Zero means DefaultTimeout.
	Timeout time.Duration
	// HTTPClient is optional. When nil the client builds its own with a
	// cloned default transport. http.DefaultClient is deliberately NOT used:
	// it has no timeout and is shared process-wide with code that may set
	// one.
	HTTPClient *http.Client
}

// Client talks to one NovaMem service as one user.
//
// Safe for concurrent use by multiple goroutines; it holds no mutable state
// beyond the *http.Client, which is itself concurrency-safe. Create one per
// (host, token) pair and share it — the underlying transport pools
// connections, so a client per call would forfeit keep-alive.
type Client struct {
	baseURL string
	token   string
	timeout time.Duration
	http    *http.Client
}

// New validates the configuration and returns a client.
//
// It fails on a missing base URL or token rather than deferring to the first
// call, because a client built from an empty config would spend a deployment's
// whole uptime returning 401s that look, in the logs, exactly like a revoked
// token. Configuration errors belong at wiring time.
func New(cfg Config) (*Client, error) {
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if base == "" {
		return nil, errors.New("novamem: BaseURL is required")
	}
	u, err := url.Parse(base)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("novamem: BaseURL %q is not an absolute http(s) URL", cfg.BaseURL)
	}
	if strings.TrimSpace(cfg.Token) == "" {
		// Says only that it is missing, never what was passed — an error
		// about a credential must not quote the credential.
		return nil, errors.New("novamem: Token is required")
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	hc := cfg.HTTPClient
	if hc == nil {
		// No client-level Timeout: the per-call context deadline is the one
		// bound, and having two would make the effective limit depend on
		// which fired first — surfacing as two different errors for one
		// condition.
		transport := http.DefaultTransport
		if t, ok := transport.(*http.Transport); ok {
			transport = t.Clone()
		}
		hc = &http.Client{Transport: transport}
	}
	return &Client{baseURL: base, token: cfg.Token, timeout: timeout, http: hc}, nil
}

// ─── Wire types ────────────────────────────────────────────────────────────
//
// Field names below mirror the server's zod schemas, which are `.strict()` in
// several places: a misspelled field is a 400, not a silently ignored option.

// Sensitivity classifies how freely an entry may be recalled. Reads default to
// excluding "sensitive" unless MaxSensitivity asks for it explicitly.
type Sensitivity string

// The four sensitivity levels, in increasing order of restriction.
const (
	SensitivityPublic    Sensitivity = "public"
	SensitivityInternal  Sensitivity = "internal"
	SensitivityPrivate   Sensitivity = "private"
	SensitivitySensitive Sensitivity = "sensitive"
)

// Entry is one memory as the server returns it. Search, Recent and Neighbors
// all emit this same shape.
type Entry struct {
	ID      string  `json:"id"`
	Score   float64 `json:"score"`
	Content string  `json:"content"`
	// Tier is "warm" or "cold" — which store answered, not a quality signal.
	Tier      string `json:"tier"`
	Namespace string `json:"namespace"`
	// Project is nil for user-wide entries, hence the pointer: "belongs to no
	// project" and "belongs to a project named empty-string" would otherwise
	// be the same value.
	Project  *string        `json:"project"`
	Source   string         `json:"source"`
	Metadata map[string]any `json:"metadata"`
	// Signals is nil on ordered results (Recent), where ranking does not
	// apply — a pointer so "not ranked" stays distinct from "ranked zero".
	Signals *Signals `json:"signals,omitempty"`
}

// Signals is the per-channel contribution to an entry's score. Neighbors
// populates only Graph.
type Signals struct {
	Keyword float64 `json:"keyword,omitempty"`
	Vector  float64 `json:"vector,omitempty"`
	Graph   float64 `json:"graph,omitempty"`
}

// Results is what the three read paths return.
type Results struct {
	Entries []Entry `json:"results"`
	// Degraded is the server admitting it answered from a partial view — a
	// disconnected graph store, typically. When it is true AND Entries is
	// empty, this client returns an ErrUnavailable error instead; see the
	// read methods. A degraded response WITH entries is returned as data, and
	// this flag lets you hedge the answer you build from it.
	Degraded bool `json:"degraded"`
}

// Weights re-weights the hybrid ranking channels for one query. Nil fields
// keep the server's defaults.
type Weights struct {
	Keyword *float64 `json:"keyword,omitempty"`
	Vector  *float64 `json:"vector,omitempty"`
	Graph   *float64 `json:"graph,omitempty"`
	Recency *float64 `json:"recency,omitempty"`
	Entity  *float64 `json:"entity,omitempty"`
}

// CaptureRequest is the agent-facing write. Content is the only required
// field; the rest is provenance the server defaults when absent.
//
// Capture is preferred over a raw store: before writing, the server looks for
// semantically close entries in the same scope, updates a near-duplicate in
// place, and marks an older contradicted fact superseded. That is what keeps a
// long-lived memory from silently accumulating three versions of one truth.
type CaptureRequest struct {
	// Content is one self-contained durable fact. Max 256KB.
	Content   string `json:"content"`
	Namespace string `json:"namespace,omitempty"`
	Source    string `json:"source,omitempty"`
	AgentName string `json:"agentName,omitempty"`
	// Project scopes the write to a sub-brain, by id or name. Empty means
	// user-wide; the field is omitted rather than sent as "", which the
	// server's project rule (min length 1) would reject.
	Project      string         `json:"project,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	Sensitivity  Sensitivity    `json:"sensitivity,omitempty"`
	SourceType   string         `json:"sourceType,omitempty"`
	CapturedFrom string         `json:"capturedFrom,omitempty"`
	Confidence   *float64       `json:"confidence,omitempty"`
	// Force bypasses the server's worthiness gate. Without it, content the
	// server judges non-durable ("ok, thanks") comes back Rejected with no
	// id — which is the gate working, not a failure.
	Force bool `json:"force,omitempty"`
}

// CaptureResult is the outcome of a write.
//
// A capture that stored nothing is NOT an error. Ask Saved, and use Rejected
// to explain why when it is false.
type CaptureResult struct {
	// ID is nil when nothing was stored.
	ID *string `json:"id"`
	// Rejected is the server's reason for storing nothing, when it declined.
	Rejected string `json:"rejected,omitempty"`
	// Deduplicated means an identical memory already existed; ID is that
	// existing entry.
	Deduplicated bool `json:"deduplicated,omitempty"`
	// Updated means a near-duplicate was rewritten in place rather than a new
	// entry created.
	Updated bool `json:"updated,omitempty"`
	// Superseded lists entries this capture contradicted and retired.
	Superseded []string `json:"superseded,omitempty"`
}

// Saved reports whether the store now holds this memory under some id.
func (r CaptureResult) Saved() bool { return r.ID != nil && *r.ID != "" }

// SearchRequest is a hybrid (keyword + vector + graph) query.
//
// With neither Namespace nor IncludeNamespaces set, the server searches every
// namespace the caller has entries in — so omitting them is the right default
// rather than a narrowing.
type SearchRequest struct {
	// Query is the search text. Required. Max 8KB.
	Query string `json:"query"`
	// K caps the number of results (max 200). Zero omits it; the server uses 10.
	K         int    `json:"k,omitempty"`
	Namespace string `json:"namespace,omitempty"`
	AgentName string `json:"agentName,omitempty"`
	// Project scopes the read to one sub-brain, by id or name.
	Project string `json:"project,omitempty"`
	// IncludeProjects unions the user-wide store with these projects (max
	// 16). Membership is enforced server-side.
	IncludeProjects []string `json:"includeProjects,omitempty"`
	// IncludeNamespaces unions across these namespace shelves (max 16) and
	// overrides Namespace.
	IncludeNamespaces []string    `json:"includeNamespaces,omitempty"`
	Weights           *Weights    `json:"weights,omitempty"`
	MaxSensitivity    Sensitivity `json:"maxSensitivity,omitempty"`
}

// RecentRequest lists entries newest-first, optionally since a timestamp.
type RecentRequest struct {
	Namespace string `json:"namespace,omitempty"`
	// K caps the number of results (max 200). Zero omits it.
	K int `json:"k,omitempty"`
	// Since is an inclusive lower bound on entry time. The zero value omits
	// it. Formatted at send time as RFC3339 with an explicit offset, because
	// the server requires one — a naive format would come back as a 400 that
	// reads like a server fault.
	Since             time.Time   `json:"-"`
	Project           string      `json:"project,omitempty"`
	IncludeProjects   []string    `json:"includeProjects,omitempty"`
	IncludeNamespaces []string    `json:"includeNamespaces,omitempty"`
	MaxSensitivity    Sensitivity `json:"maxSensitivity,omitempty"`
}

// NeighborsRequest walks the memory graph out from a seed entry — the way to
// ask "what else is connected to this?" once a search has found an anchor.
type NeighborsRequest struct {
	// ID of the seed entry. Required.
	ID string `json:"id"`
	// Depth of the walk, 1–3. Zero omits it; the server uses 1.
	Depth int `json:"depth,omitempty"`
	// K caps the number of neighbours (max 50).
	K                 int         `json:"k,omitempty"`
	Project           string      `json:"project,omitempty"`
	IncludeProjects   []string    `json:"includeProjects,omitempty"`
	IncludeNamespaces []string    `json:"includeNamespaces,omitempty"`
	MaxSensitivity    Sensitivity `json:"maxSensitivity,omitempty"`
}

// UpdateRequest rewrites an existing entry in place.
//
// Prefer this to Forget-then-Capture when a fact changes: it preserves the
// entry's id, creation time, hit count and graph edges, all of which a delete
// would throw away. Omitting Content skips the server's re-embedding, so a
// metadata-only correction is cheap.
type UpdateRequest struct {
	// ID of the entry to rewrite. Required; sent as a path parameter.
	ID           string         `json:"-"`
	Content      string         `json:"content,omitempty"`
	Namespace    string         `json:"namespace,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	Sensitivity  Sensitivity    `json:"sensitivity,omitempty"`
	SourceType   string         `json:"sourceType,omitempty"`
	CapturedFrom string         `json:"capturedFrom,omitempty"`
	Confidence   *float64       `json:"confidence,omitempty"`
	Project      string         `json:"project,omitempty"`
}

// UpdateResult reports what the rewrite did.
type UpdateResult struct {
	ID      string `json:"id"`
	Updated bool   `json:"updated"`
	// EmbeddingChanged is false when only metadata moved.
	EmbeddingChanged bool `json:"embeddingChanged"`
}

// ForgetRequest deletes one entry by id.
type ForgetRequest struct {
	// ID of the entry to delete. Required.
	ID string `json:"id"`
	// Project scopes the delete. The server re-resolves the entry's actual
	// scope by id regardless, so a wrong project cannot delete an entry the
	// caller has no claim on.
	Project string `json:"project,omitempty"`
}

// ForgetResult reports what the delete actually removed.
type ForgetResult struct {
	// Deleted is false — with no error — when the id was not in the caller's
	// scope. The entry is already not there, which is what was asked for, but
	// you are told you deleted NOTHING rather than congratulated.
	Deleted bool `json:"deleted"`
	// ColdDeleteOk is false when the primary row went but the vector copy
	// survived; the server queues it for its reaper. Surfaced because
	// "forgotten" is a promise to a person, and a half-completed delete is
	// not one this client will quietly round up.
	ColdDeleteOk bool `json:"coldDeleteOk"`
}

// ─── Operations ────────────────────────────────────────────────────────────

// Capture stores a durable fact, deduplicating and superseding as it goes.
//
// The only operation whose failures are worth retrying, and the only one where
// a dropped call loses information the caller cannot reconstruct later. No
// retry happens here: the caller owns the schedule and the budget, and often a
// durable queue that is a better home for the redelivery than a for-loop.
// Retryable(err) says which failures are worth it.
//
// A nil error does not mean something was stored — check CaptureResult.Saved.
func (c *Client) Capture(ctx context.Context, req CaptureRequest) (CaptureResult, error) {
	var out CaptureResult
	if strings.TrimSpace(req.Content) == "" {
		return out, &Error{Op: "capture", Message: "content is required"}
	}
	err := c.do(ctx, "capture", http.MethodPost, "/v1/capture", req, &out)
	return out, err
}

// Search runs a hybrid keyword + vector + graph query.
//
// NO RETRY, by design. A read that fails should fail FAST so the caller can
// degrade inside the same turn — "I could not reach my memory" said promptly
// beats the same sentence after three backoffs, by which time the budget is
// gone and the person is still waiting.
//
// An empty Results with a nil error means the store holds nothing matching.
// Anything else is an error, and Unavailable says whether it means the store
// could not be consulted.
func (c *Client) Search(ctx context.Context, req SearchRequest) (Results, error) {
	var out Results
	if strings.TrimSpace(req.Query) == "" {
		return out, &Error{Op: "search", Message: "query is required"}
	}
	if err := c.do(ctx, "search", http.MethodPost, "/v1/search", req, &out); err != nil {
		return out, err
	}
	return out, degradedEmpty("search", out)
}

// Recent lists the newest entries in scope. No retry, for the same reason as
// Search.
func (c *Client) Recent(ctx context.Context, req RecentRequest) (Results, error) {
	// Since is formatted here rather than carried as a caller-supplied string
	// so nobody can hand the server a timestamp shape its validator rejects.
	body := struct {
		RecentRequest
		Since string `json:"since,omitempty"`
	}{RecentRequest: req}
	if !req.Since.IsZero() {
		body.Since = req.Since.UTC().Format(time.RFC3339)
	}
	var out Results
	if err := c.do(ctx, "recent", http.MethodPost, "/v1/recent", body, &out); err != nil {
		return out, err
	}
	return out, degradedEmpty("recent", out)
}

// Neighbors walks the graph out from a seed entry. No retry, as above.
//
// The graph store is the flakiest dependency behind this API — see
// degradedEmpty for what this client does with the server's habit of reporting
// that failure as a successful, empty answer.
func (c *Client) Neighbors(ctx context.Context, req NeighborsRequest) (Results, error) {
	var out Results
	if strings.TrimSpace(req.ID) == "" {
		return out, &Error{Op: "neighbors", Message: "id is required"}
	}
	if err := c.do(ctx, "neighbors", http.MethodPost, "/v1/neighbors", req, &out); err != nil {
		return out, err
	}
	return out, degradedEmpty("neighbors", out)
}

// Update rewrites an entry in place, preserving its id, creation time and
// edges.
//
// An unknown id is ErrNotFound, not ErrUnavailable: the store answered, and
// the answer was that the memory is gone.
func (c *Client) Update(ctx context.Context, req UpdateRequest) (UpdateResult, error) {
	var out UpdateResult
	id := strings.TrimSpace(req.ID)
	if id == "" {
		return out, &Error{Op: "update", Message: "id is required"}
	}
	path := "/v1/memories/" + url.PathEscape(id)
	if err := c.do(ctx, "update", http.MethodPut, path, req, &out); err != nil {
		return out, err
	}
	if out.ID == "" {
		out.ID = id
	}
	return out, nil
}

// Forget deletes an entry.
//
// IT WILL NOT REPORT SUCCESS ON A FAILED DELETE. Forgetting is a promise made
// to a person — usually the person who asked for it — and there is no
// acceptable version of this call where a failure is rounded up to "done". So:
// every transport failure, 5xx and unparseable body is an error, never a
// zero-valued "deleted"; an id that is not in your scope comes back
// Deleted=false with no error, which is the truthful "there was nothing of
// yours there to delete"; and ColdDeleteOk=false is passed through untouched,
// because a vector copy that survived the primary delete means the content is
// still retrievable and nobody has yet earned the word "forgotten".
func (c *Client) Forget(ctx context.Context, req ForgetRequest) (ForgetResult, error) {
	var out ForgetResult
	if strings.TrimSpace(req.ID) == "" {
		return out, &Error{Op: "forget", Message: "id is required"}
	}
	if err := c.do(ctx, "forget", http.MethodPost, "/v1/forget", req, &out); err != nil {
		if errors.Is(err, ErrNotFound) {
			// The store answered "not here". Nothing was deleted and nothing
			// needed to be — report that plainly rather than as a fault.
			return ForgetResult{Deleted: false, ColdDeleteOk: true}, nil
		}
		return ForgetResult{}, err
	}
	return out, nil
}

// Remember stores content unconditionally — no worthiness gate, no
// dedup-or-supersede pass. Prefer Capture for agent-written facts; Remember is
// for content a person or pipeline explicitly asked to store, where a silent
// rejection would be the surprise. Field set is identical to CaptureRequest
// (Force is meaningless here and ignored by the server).
func (c *Client) Remember(ctx context.Context, req CaptureRequest) (CaptureResult, error) {
	var out CaptureResult
	if strings.TrimSpace(req.Content) == "" {
		return out, &Error{Op: "remember", Message: "content is required"}
	}
	err := c.do(ctx, "remember", http.MethodPost, "/v1/remember", req, &out)
	return out, err
}

// ContextRequest asks the server to assemble a working context for one
// incoming message: relevant entries by hybrid search plus the newest entries
// in scope, in a single round trip.
type ContextRequest struct {
	Message string `json:"message"`
	// K bounds the relevant-results half. The server defaults it.
	K                 int         `json:"k,omitempty"`
	Namespace         string      `json:"namespace,omitempty"`
	Project           string      `json:"project,omitempty"`
	IncludeProjects   []string    `json:"includeProjects,omitempty"`
	IncludeNamespaces []string    `json:"includeNamespaces,omitempty"`
	Weights           *Weights    `json:"weights,omitempty"`
	MaxSensitivity    Sensitivity `json:"maxSensitivity,omitempty"`
}

// ContextResult is the server-assembled context bundle.
type ContextResult struct {
	Relevant Results `json:"relevant"`
	Recent   Results `json:"recent"`
	// Guidance is the server's one-line instruction on how to use the bundle
	// in a prompt.
	Guidance string `json:"guidance"`
}

// Context assembles retrieval context for one message in a single round trip —
// the "what do I know that bears on this?" call an agent makes before
// answering. No retry, same reasoning as Search.
func (c *Client) Context(ctx context.Context, req ContextRequest) (ContextResult, error) {
	var out ContextResult
	if strings.TrimSpace(req.Message) == "" {
		return out, &Error{Op: "context", Message: "message is required"}
	}
	err := c.do(ctx, "context", http.MethodPost, "/v1/context", req, &out)
	return out, err
}

// SessionRecapRequest batches end-of-session facts by category. Every list is
// optional; empty lists are simply skipped server-side.
type SessionRecapRequest struct {
	Decisions          []string `json:"decisions,omitempty"`
	SetupFacts         []string `json:"setupFacts,omitempty"`
	RootCauses         []string `json:"rootCauses,omitempty"`
	Preferences        []string `json:"preferences,omitempty"`
	ProjectConventions []string `json:"projectConventions,omitempty"`
	SafetyConstraints  []string `json:"safetyConstraints,omitempty"`
	Other              []string `json:"other,omitempty"`
	Namespace          string   `json:"namespace,omitempty"`
	Source             string   `json:"source,omitempty"`
	SourceType         string   `json:"sourceType,omitempty"`
	CapturedFrom       string   `json:"capturedFrom,omitempty"`
	Project            string   `json:"project,omitempty"`
}

// SessionRecapResult reports the batch outcome. Saved counts stored entries;
// Results carries the per-item outcomes in submission order, including gate
// rejections (which are not errors — see CaptureResult).
type SessionRecapResult struct {
	Saved   int             `json:"saved"`
	Results []CaptureResult `json:"results"`
}

// SessionRecap stores a batch of end-of-session facts in one call. Write-path
// semantics: worth retrying via Retryable(err), never retried here.
func (c *Client) SessionRecap(ctx context.Context, req SessionRecapRequest) (SessionRecapResult, error) {
	var out SessionRecapResult
	err := c.do(ctx, "session-recap", http.MethodPost, "/v1/session-recap", req, &out)
	return out, err
}

// ContextPrefix fetches the cacheable observation-log prefix for this user
// (optionally scoped to a project). Prompt-caching agents prepend it verbatim.
//
// ErrNotFound means the server's observer feature is disabled — a
// configuration answer, not an outage; callers treating the prefix as an
// optimization should fall back to Search/Context on it.
func (c *Client) ContextPrefix(ctx context.Context, project string) (string, error) {
	path := "/v1/context-prefix"
	if project != "" {
		path += "?project=" + url.QueryEscape(project)
	}
	var out struct {
		Prefix string `json:"prefix"`
	}
	if err := c.do(ctx, "context-prefix", http.MethodGet, path, nil, &out); err != nil {
		return "", err
	}
	return out.Prefix, nil
}

// Today lists entries from the last 24 hours — sugar over Recent with Since
// set, mirroring the TypeScript client.
func (c *Client) Today(ctx context.Context, req RecentRequest) (Results, error) {
	req.Since = time.Now().Add(-24 * time.Hour)
	return c.Recent(ctx, req)
}

// Stats is the per-user entry census: counts by namespace plus totals.
type Stats struct {
	ByNamespace map[string]struct {
		Warm int `json:"warm"`
		Cold int `json:"cold"`
	} `json:"byNamespace"`
	TotalWarm   int     `json:"totalWarm"`
	TotalCold   int     `json:"totalCold"`
	LastDecayAt *string `json:"lastDecayAt"`
	UptimeMs    int64   `json:"uptimeMs"`
}

// Stats returns the caller's entry counts. Read-path semantics: no retry.
func (c *Client) Stats(ctx context.Context) (Stats, error) {
	var out Stats
	err := c.do(ctx, "stats", http.MethodGet, "/v1/stats", nil, &out)
	return out, err
}

// Health probes the public liveness endpoint. Boolean by design — dependency
// detail is admin-only server-side. A transport failure is ErrUnavailable like
// any other call; a served `{"ok": false}` comes back (false, nil): the
// service answered, and the answer was "not healthy".
func (c *Client) Health(ctx context.Context) (bool, error) {
	var out struct {
		OK bool `json:"ok"`
	}
	if err := c.do(ctx, "health", http.MethodGet, "/health", nil, &out); err != nil {
		// /health itself answers 503 with {"ok": false} when a dependency is
		// down — that is an answer, not an outage of the HTTP surface.
		var e *Error
		if errors.As(err, &e) && e.StatusCode == http.StatusServiceUnavailable {
			return false, nil
		}
		return false, err
	}
	return out.OK, nil
}

// degradedEmpty converts the server's "degraded, no results" into
// ErrUnavailable.
//
// THE SUBTLEST WAY THIS PACKAGE COULD LIE. The neighbors route catches its own
// graph failures and replies 200 {results: [], degraded: true}; search does the
// same when a backing store is unreachable. That is a reasonable choice for the
// server's own dashboard, which renders a partial page — but for a caller
// deciding what to tell a person, it is an outage wearing the costume of an
// empty result set, which is the exact confusion this package exists to
// prevent. A degraded response with NO results carries no information at all,
// so it is reported as what it is: we could not look. Retryable, because the
// usual cause is a graph store that reconnects on its own.
//
// A degraded response WITH results is left alone and returned as data — those
// hits are real, and Results.Degraded lets the caller hedge.
func degradedEmpty(op string, r Results) error {
	if r.Degraded && len(r.Entries) == 0 {
		return &Error{
			Op:          op,
			StatusCode:  http.StatusOK,
			Message:     "store answered degraded with no results, so this is not evidence of absence",
			unavailable: true,
			retryable:   true,
		}
	}
	return nil
}

// maxResponseBytes caps a decoded response. Generous next to the server's own
// 256KB-per-entry limit, and present only so a rogue endpoint cannot make the
// caller allocate without bound.
const maxResponseBytes = 8 << 20

// do performs one request and decodes its body. Every operation funnels
// through here, so the classification of failures is written exactly once.
//
// A nil body sends no request body at all — the GET endpoints (stats, token
// and project listings) must not receive a stray `null` payload.
func (c *Client) do(ctx context.Context, op, method, path string, body, out any) error {
	// EVERY CALL IS BOUNDED, including one handed context.Background(). An
	// unbounded call to a host that accepts the connection and then never
	// answers does not fail — it holds the caller open forever, which is worse
	// than any error this package can return.
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return &Error{Op: op, Message: "encode request: " + err.Error(), cause: err}
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return &Error{Op: op, Message: "build request: " + err.Error(), cause: err}
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.http.Do(req)
	if err != nil {
		return c.transportError(ctx, op, err)
	}
	defer func() {
		// Drain before close so the connection can be reused; bounded,
		// because a server streaming an unbounded error page should not be
		// able to hold this goroutine after we have the status we needed.
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()
	}()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return c.transportError(ctx, op, err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		e := httpError(op, resp.StatusCode, raw)
		// The server's own message is quoted verbatim, and a server that
		// echoes the credential back in an error ("bad token nm_…") would
		// otherwise get it laundered into this client's logs. Cheap, and it
		// removes the only path by which the token can reach an error string.
		e.Message = strings.ReplaceAll(e.Message, c.token, "[redacted]")
		return e
	}
	if out == nil {
		// Caller expects no payload (204-style endpoints). The status code
		// already carried the whole answer.
		return nil
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		// A 2xx with no body is not the contract. Decoding it into a
		// zero value would tell a Forget caller the delete happened.
		return &Error{
			Op: op, StatusCode: resp.StatusCode,
			Message:     "empty response body",
			unavailable: true,
		}
	}
	if err := json.Unmarshal(raw, out); err != nil {
		// MALFORMED BODY IS UNAVAILABILITY, not an empty result. In practice
		// it is a proxy's HTML error page or a truncated response — i.e. we
		// never reached a working NovaMem. Not retryable: the same request
		// will parse the same way, and something in the path needs fixing
		// rather than repeating.
		return &Error{
			Op: op, StatusCode: resp.StatusCode,
			Message:     "malformed response body",
			unavailable: true,
			cause:       err,
		}
	}
	return nil
}

// transportError classifies a failure that produced no HTTP response.
func (c *Client) transportError(ctx context.Context, op string, err error) error {
	// THE CALLER'S CANCELLATION IS REPORTED AS CANCELLATION, not as an
	// outage. A caller that abandoned the work already knows why there is no
	// answer, and telling it "the store is unreachable" would have it log a
	// false alarm about a host that is perfectly healthy.
	if errors.Is(err, context.Canceled) {
		cause := context.Cause(ctx)
		if cause == nil {
			cause = context.Canceled
		}
		return &Error{Op: op, Message: "canceled", cause: cause}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		// A deadline, whoever set it, means we did not get to look — so it IS
		// unavailability, and it is retryable: the host may simply have been
		// slower than this call's budget.
		return &Error{
			Op: op, Message: "timed out",
			unavailable: true, retryable: true, cause: err,
		}
	}
	// What is left is a dial failure, DNS failure, reset connection or TLS
	// error: the host could not be reached. The wrapped *url.Error carries
	// the URL, which is safe — the token lives in a header, never in the URL,
	// so it cannot ride along into a log line here.
	return &Error{
		Op: op, Message: "unreachable: " + err.Error(),
		unavailable: true, retryable: true, cause: err,
	}
}

// httpError turns a non-2xx into a classified *Error.
//
// The split is the whole point of the package: 5xx and 429 mean the store
// could not answer (unavailable, retryable); 4xx means it DID answer and the
// request was wrong (neither) — a rejected token is a deployment problem that
// no retry and no amount of graceful-degradation language will fix, and if it
// is reported as an outage nobody will go and rotate the credential.
func httpError(op string, status int, raw []byte) *Error {
	e := &Error{Op: op, StatusCode: status}
	// The server's uniform error shape is {error, code?, issues?}.
	var payload struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(raw, &payload); err == nil && payload.Error != "" {
		e.Message = payload.Error
		e.Code = payload.Code
	} else {
		e.Message = truncate(strings.TrimSpace(string(raw)), 256)
	}
	if status >= 500 || status == http.StatusTooManyRequests {
		e.unavailable = true
		e.retryable = true
	}
	return e
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
