// User / session / bearer-token reads and writes for auth.mode=user.
// Transcribed from warm-store/index.ts (createUserToken, resolveUserToken,
// rotateUserToken, listUserTokens, deleteUserTokenByHash, findUserById)
// plus the Better-Auth-owned `"user"`, `"account"` and `"session"` tables,
// which Better Auth's own DDL created and which we only read/write in the
// shapes it already uses.
package warmstore

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/azrtydxb/novamem/go/internal/auth"
)

// tokenTouchInterval is the minimum gap between last_used_at writes for
// one token — the resolve path is a plain SELECT and the touch is fired
// off-path (warm-store/index.ts TOKEN_TOUCH_INTERVAL_MS).
const tokenTouchInterval = time.Minute

const tokenTouchMapMax = 4096

var tokenTouch struct {
	sync.Mutex
	at map[string]time.Time
}

func init() { tokenTouch.at = map[string]time.Time{} }

// FindUserByID resolves a Better Auth user. `Username` is the full email
// (issue #21 — BA has no username column and every caller displays it).
func (s *Store) FindUserByID(ctx context.Context, id string) (*User, error) {
	var u User
	var role *string
	err := s.Pool.QueryRow(ctx,
		`SELECT id, email, role FROM "user" WHERE id = $1`, id).Scan(&u.ID, &u.Username, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	u.Role = "user"
	if role != nil && *role != "" {
		u.Role = *role
	}
	return &u, nil
}

// CredentialPassword returns the stored scrypt hash for a user's
// email+password account row, or "" when the user has no credential
// account (social-only — not a shape this deployment produces).
func (s *Store) CredentialPassword(ctx context.Context, userID string) (string, error) {
	var pw *string
	err := s.Pool.QueryRow(ctx, `
		SELECT password FROM "account"
		 WHERE "userId" = $1 AND "providerId" = 'credential' AND password IS NOT NULL
		 LIMIT 1`, userID).Scan(&pw)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil || pw == nil {
		return "", err
	}
	return *pw, nil
}

// ─── Sessions ──────────────────────────────────────────────────────────

// CreateSession inserts a Better-Auth-shaped session row and returns its
// opaque token (what the signed cookie carries).
func (s *Store) CreateSession(ctx context.Context, userID, ip, userAgent string, ttl time.Duration) (token string, expiresAt time.Time, err error) {
	token = auth.NewID()
	expiresAt = time.Now().Add(ttl)
	_, err = s.Pool.Exec(ctx, `
		INSERT INTO "session" (id, "expiresAt", token, "ipAddress", "userAgent", "userId")
		VALUES ($1,$2,$3,$4,$5,$6)`,
		auth.NewID(), expiresAt, token, ip, userAgent, userID)
	return token, expiresAt, err
}

// SessionUser resolves a session token to its user, or nil when the
// token is unknown or expired. Expired rows are left for the session
// sweeper — reads just refuse them.
func (s *Store) SessionUser(ctx context.Context, token string) (*User, time.Time, error) {
	var u User
	var role *string
	var expires time.Time
	err := s.Pool.QueryRow(ctx, `
		SELECT u.id, u.email, u.role, sess."expiresAt"
		  FROM "session" sess JOIN "user" u ON u.id = sess."userId"
		 WHERE sess.token = $1`, token).Scan(&u.ID, &u.Username, &role, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, time.Time{}, nil
	}
	if err != nil {
		return nil, time.Time{}, err
	}
	if !expires.After(time.Now()) {
		return nil, time.Time{}, nil
	}
	u.Role = "user"
	if role != nil && *role != "" {
		u.Role = *role
	}
	return &u, expires, nil
}

// RefreshSession extends a session that is older than updateAge
// (auth-betterauth.ts: 7-day expiry, rolled forward once a day) and
// reports whether it moved, so the caller can re-set the cookie.
func (s *Store) RefreshSession(ctx context.Context, token string, ttl, updateAge time.Duration) (time.Time, bool, error) {
	var updatedAt time.Time
	err := s.Pool.QueryRow(ctx, `SELECT "updatedAt" FROM "session" WHERE token = $1`, token).Scan(&updatedAt)
	if err != nil {
		return time.Time{}, false, err
	}
	if time.Since(updatedAt) < updateAge {
		return time.Time{}, false, nil
	}
	expires := time.Now().Add(ttl)
	_, err = s.Pool.Exec(ctx,
		`UPDATE "session" SET "expiresAt" = $2, "updatedAt" = now() WHERE token = $1`, token, expires)
	return expires, err == nil, err
}

func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM "session" WHERE token = $1`, token)
	return err
}

// ─── Bearer tokens ─────────────────────────────────────────────────────

type TokenInfo struct {
	UserID    string
	TokenHash string
	Label     *string
	Scope     string // full | read_only
	ProjectID *string
}

// Restricted reports whether the bearer is narrower than its owner —
// the condition http.ts's restrictedTokenDenied gates on.
func (t *TokenInfo) Restricted() bool {
	return t != nil && (t.Scope == "read_only" || t.ProjectID != nil)
}

type TokenRow struct {
	TokenHash  string     `json:"tokenHash"`
	Label      *string    `json:"label"`
	Scope      string     `json:"scope"`
	ProjectID  *string    `json:"projectId"`
	ExpiresAt  *time.Time `json:"expiresAt"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
	Revoked    bool       `json:"revoked"`
}

// CreateUserToken mints a bearer for a user. Returns the plaintext once;
// only the sha256 is stored. nil when the user doesn't exist.
func (s *Store) CreateUserToken(ctx context.Context, userID string, label *string, scope string, projectID *string, expiresAt *time.Time) (token string, createdAt time.Time, err error) {
	var exists int
	err = s.Pool.QueryRow(ctx, `SELECT 1 FROM "user" WHERE id = $1 LIMIT 1`, userID).Scan(&exists)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", time.Time{}, nil
	}
	if err != nil {
		return "", time.Time{}, err
	}
	token = auth.NewBearerToken()
	if scope == "" {
		scope = "full"
	}
	err = s.Pool.QueryRow(ctx, `
		INSERT INTO user_tokens (token_hash, user_id, label, scope, project_id, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING created_at`,
		auth.HashToken(token), userID, label, scope, projectID, expiresAt).Scan(&createdAt)
	if err != nil {
		return "", time.Time{}, err
	}
	return token, createdAt, nil
}

// ResolveUserToken maps a plaintext bearer to its owner. nil for
// unknown / revoked / expired tokens — never an error the auth hook has
// to interpret. last_used_at is touched off-path, throttled per token.
func (s *Store) ResolveUserToken(ctx context.Context, plaintext string) (*TokenInfo, error) {
	if plaintext == "" {
		return nil, nil
	}
	hash := auth.HashToken(plaintext)
	var info TokenInfo
	var expiresAt, lastUsedAt *time.Time
	err := s.Pool.QueryRow(ctx, `
		SELECT user_id, label, scope, project_id, expires_at, last_used_at
		  FROM user_tokens WHERE token_hash = $1 AND revoked_at IS NULL LIMIT 1`, hash).
		Scan(&info.UserID, &info.Label, &info.Scope, &info.ProjectID, &expiresAt, &lastUsedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if expiresAt != nil && !expiresAt.After(time.Now()) {
		return nil, nil // expired ⇒ same answer as revoked
	}
	info.TokenHash = hash
	if info.Scope != "read_only" {
		info.Scope = "full"
	}
	s.touchToken(hash, lastUsedAt)
	return &info, nil
}

func (s *Store) touchToken(hash string, lastUsedAt *time.Time) {
	now := time.Now()
	if lastUsedAt != nil && now.Sub(*lastUsedAt) < tokenTouchInterval {
		return
	}
	tokenTouch.Lock()
	if queued, ok := tokenTouch.at[hash]; ok && now.Sub(queued) < tokenTouchInterval {
		tokenTouch.Unlock()
		return
	}
	if len(tokenTouch.at) >= tokenTouchMapMax {
		tokenTouch.at = map[string]time.Time{}
	}
	tokenTouch.at[hash] = now
	tokenTouch.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		// Re-check revocation: a token revoked between the SELECT and
		// this write must not look freshly used to operators.
		if _, err := s.Pool.Exec(ctx,
			`UPDATE user_tokens SET last_used_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
			hash); err != nil {
			tokenTouch.Lock()
			delete(tokenTouch.at, hash)
			tokenTouch.Unlock()
		}
	}()
}

// RotateUserToken revokes the presented bearer and mints a replacement
// for the same user in one transaction. The new row copies the old
// row's restrictions verbatim — rotating a read-only or project-confined
// bearer must not quietly widen it. nil when the plaintext is unknown or
// already revoked.
func (s *Store) RotateUserToken(ctx context.Context, plaintext string) (token, userID string, createdAt time.Time, err error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return "", "", time.Time{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var scope string
	var projectID *string
	var expiresAt *time.Time
	err = tx.QueryRow(ctx, `
		UPDATE user_tokens SET revoked_at = now()
		 WHERE token_hash = $1 AND revoked_at IS NULL
		 RETURNING user_id, scope, project_id, expires_at`, auth.HashToken(plaintext)).
		Scan(&userID, &scope, &projectID, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", time.Time{}, nil
	}
	if err != nil {
		return "", "", time.Time{}, err
	}
	token = auth.NewBearerToken()
	label := "rotated"
	if err := tx.QueryRow(ctx, `
		INSERT INTO user_tokens (token_hash, user_id, label, scope, project_id, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING created_at`,
		auth.HashToken(token), userID, label, scope, projectID, expiresAt).Scan(&createdAt); err != nil {
		return "", "", time.Time{}, err
	}
	return token, userID, createdAt, tx.Commit(ctx)
}

// ListUserTokens — every token row the user owns, oldest first,
// including revoked ones (the dashboard shows them greyed out).
func (s *Store) ListUserTokens(ctx context.Context, userID string) ([]TokenRow, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT token_hash, label, scope, project_id, expires_at, created_at, last_used_at, revoked_at
		  FROM user_tokens WHERE user_id = $1 ORDER BY created_at ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TokenRow{}
	for rows.Next() {
		var t TokenRow
		var revokedAt *time.Time
		if err := rows.Scan(&t.TokenHash, &t.Label, &t.Scope, &t.ProjectID,
			&t.ExpiresAt, &t.CreatedAt, &t.LastUsedAt, &revokedAt); err != nil {
			return nil, err
		}
		t.Revoked = revokedAt != nil
		out = append(out, t)
	}
	return out, rows.Err()
}

// CountLiveTokens — non-revoked tokens the user owns (the onboarding
// wizard's "minted a token yet?" signal).
func (s *Store) CountLiveTokens(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.Pool.QueryRow(ctx,
		`SELECT count(*) FROM user_tokens WHERE user_id = $1 AND revoked_at IS NULL`, userID).Scan(&n)
	return n, err
}

// DeleteUserTokenByHash hard-deletes one of the user's tokens.
func (s *Store) DeleteUserTokenByHash(ctx context.Context, userID, tokenHash string) (bool, error) {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM user_tokens WHERE token_hash = $1 AND user_id = $2`, tokenHash, userID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}
