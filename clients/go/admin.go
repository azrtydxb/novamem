package novamem

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

// Admin is the server-administration surface, authenticated with an ADMIN
// user's bearer. Its reason to exist is fleet provisioning: an orchestrator
// (NovaFlow) that runs many agents creates one NovaMem user per agent through
// ProvisionUser and hands each agent only its own token.
//
// Keep the admin bearer strictly on the orchestrator side. It can create
// users and revoke any token; it must never reach an agent's context, which
// is the same reason these methods are not on Client.
//
// Construct with NewAdmin. Error contract as everywhere in this package;
// role failures surface as a non-retryable *Error with StatusCode 403.
type Admin struct {
	c *Client
}

// NewAdmin validates cfg and returns an admin client. The token must belong
// to a user with the admin role — the constructor cannot check that (it makes
// no network call), so a wrong-role token surfaces as 403 on first use.
func NewAdmin(cfg Config) (*Admin, error) {
	c, err := New(cfg)
	if err != nil {
		return nil, err
	}
	return &Admin{c: c}, nil
}

// ProvisionUserRequest creates one user, non-interactively.
type ProvisionUserRequest struct {
	// Email is the new user's identity and must be unique server-wide. Make
	// it deterministic per agent (e.g. "agent-<slug>@novaflow.local") so a
	// retried provision collides into ErrAlreadyExists instead of minting a
	// twin account.
	Email string `json:"email"`
	// Password must satisfy the server's policy (min 8 chars). For
	// bearer-only agents, generate 24+ random chars and discard after the
	// call — the token is the working credential.
	Password string `json:"password"`
	// Name is a display name. The server refuses email-shaped names by
	// convention (name is not unique; an email look-alike invites lookup
	// confusion) — this client does not enforce that, the operator should.
	Name string `json:"name,omitempty"`
	// TokenLabel, when set, makes the server mint a bearer for the new user
	// in the same call — the whole point for provisioning: one round trip
	// from "agent exists" to "agent has a credential". Empty skips the mint.
	TokenLabel string `json:"tokenLabel,omitempty"`
	// TokenScope narrows the minted bearer: "read_only" for agents that
	// only recall. Empty means "full". Requires TokenLabel.
	TokenScope string `json:"tokenScope,omitempty"`
	// TokenExpiresInDays sets a hard expiry on the minted bearer (max
	// 3650). 0 = never. Requires TokenLabel.
	TokenExpiresInDays int `json:"tokenExpiresInDays,omitempty"`
}

// ProvisionedUser is the outcome of a ProvisionUser call.
type ProvisionedUser struct {
	UserID string `json:"userId"`
	Email  string `json:"email"`
	// Token is the new user's plaintext bearer — present only when
	// TokenLabel was set, and THIS IS THE ONLY TIME IT EXISTS. The server
	// keeps the hash; losing this string means re-minting.
	Token string `json:"token,omitempty"`
}

// ProvisionUser creates a user (and optionally its first bearer) through the
// server's in-process sign-up — the only sign-up path that exists in user
// auth mode; there is no HTTP registration form to automate.
//
// A taken email is HTTP 409 — branch on it with IsAlreadyExists. For
// deterministic per-agent emails that answer means "provisioned before"; the
// first provision's token is NOT returned again — recover it from wherever
// it was stored, or revoke and re-provision.
func (a *Admin) ProvisionUser(ctx context.Context, req ProvisionUserRequest) (ProvisionedUser, error) {
	var out ProvisionedUser
	if strings.TrimSpace(req.Email) == "" || strings.TrimSpace(req.Password) == "" {
		return out, &Error{Op: "provision-user", Message: "email and password are required"}
	}
	err := a.c.do(ctx, "provision-user", http.MethodPost, "/v1/admin/users", req, &out)
	return out, err
}

// IsAlreadyExists reports whether err is the 409 duplicate-email answer from
// ProvisionUser.
func IsAlreadyExists(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.StatusCode == http.StatusConflict
}

// RevokeUserToken revokes ANY user's bearer by plaintext — the admin-side
// teardown for a decommissioned agent. Requires the plaintext (the server
// looks it up by hash); an orchestrator that stored the agent token encrypted
// decrypts it for this call and then forgets it.
func (a *Admin) RevokeUserToken(ctx context.Context, plaintext string) (bool, error) {
	if strings.TrimSpace(plaintext) == "" {
		return false, &Error{Op: "revoke-user-token", Message: "token is required"}
	}
	body := struct {
		Token string `json:"token"`
	}{Token: plaintext}
	var out struct {
		Revoked bool `json:"revoked"`
	}
	err := a.c.do(ctx, "revoke-user-token", http.MethodPost, "/v1/admin/tokens/revoke", body, &out)
	return out.Revoked, err
}

// AdminUser is one row of the admin census.
type AdminUser struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	Name      string `json:"name"`
	Role      string `json:"role"`
	CreatedAt string `json:"createdAt"`
	// EntryCount and TokenCount are the user's footprint — what a delete
	// would take with it.
	EntryCount int `json:"entryCount"`
	TokenCount int `json:"tokenCount"`
}

// ListUsers returns every user with entry + token counts.
func (a *Admin) ListUsers(ctx context.Context) ([]AdminUser, error) {
	var out struct {
		Users []AdminUser `json:"users"`
	}
	err := a.c.do(ctx, "list-users", http.MethodGet, "/v1/admin/users", nil, &out)
	return out.Users, err
}

// UserDeletion reports what removing a user actually removed.
type UserDeletion struct {
	Deleted         bool     `json:"deleted"`
	EntriesRemoved  int      `json:"entriesRemoved"`
	TokensRemoved   int      `json:"tokensRemoved"`
	ProjectsDeleted []string `json:"projectsDeleted"`
	ColdCleanup     []string `json:"coldCleanup"`
	// ColdCleanupOk false means the primary data is gone but vector
	// copies survived (queued for the server's reaper) — the deletion is
	// not yet complete. Same honesty rule as Client.Forget.
	ColdCleanupOk bool `json:"coldCleanupOk"`
}

// UserDeletionPreview is the dry-run answer: what WOULD go.
type UserDeletionPreview struct {
	UserID        string   `json:"userId"`
	Email         string   `json:"email"`
	Entries       int      `json:"entries"`
	Tokens        int      `json:"tokens"`
	OwnedProjects []string `json:"ownedProjects"`
}

// PreviewDeleteUser reports what deleting the user would remove, without
// removing anything. Call it first — deletion is irreversible.
func (a *Admin) PreviewDeleteUser(ctx context.Context, userID string) (UserDeletionPreview, error) {
	var out struct {
		WouldDelete UserDeletionPreview `json:"wouldDelete"`
	}
	if strings.TrimSpace(userID) == "" {
		return out.WouldDelete, &Error{Op: "preview-delete-user", Message: "userID is required"}
	}
	err := a.c.do(ctx, "preview-delete-user", http.MethodDelete,
		"/v1/admin/users/"+url.PathEscape(userID)+"?dryRun=true", nil, &out)
	return out.WouldDelete, err
}

// DeleteUser removes a user and EVERYTHING they own — memories in every
// scope, owned projects (including their vector collections), tokens,
// sessions and the account itself. Irreversible; use PreviewDeleteUser
// first. The orchestrator's agent-teardown path: revoke reachable
// credentials, then delete the user.
func (a *Admin) DeleteUser(ctx context.Context, userID string) (UserDeletion, error) {
	var out UserDeletion
	if strings.TrimSpace(userID) == "" {
		return out, &Error{Op: "delete-user", Message: "userID is required"}
	}
	err := a.c.do(ctx, "delete-user", http.MethodDelete,
		"/v1/admin/users/"+url.PathEscape(userID), nil, &out)
	return out, err
}
