// Better Auth user administration over BA's own tables — the queries
// behind the five /api/auth/* endpoints the dashboard calls
// (admin/list-users, admin/create-user, admin/set-role,
// admin/remove-user, change-password).
//
// Row shapes are Better Auth's; the JSON `BAUser` renders is exactly
// what `parseUserOutput` emits for this deployment's schema (verified
// field-by-field against a live TS server).
package warmstore

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/azrtydxb/novamem/go/internal/auth"
)

// BAUser is Better Auth's user output document.
type BAUser struct {
	Name          string  `json:"name"`
	Email         string  `json:"email"`
	EmailVerified bool    `json:"emailVerified"`
	Image         *string `json:"image"`
	CreatedAt     string  `json:"createdAt"`
	UpdatedAt     string  `json:"updatedAt"`
	Role          *string `json:"role"`
	Banned        bool    `json:"banned"`
	BanReason     *string `json:"banReason"`
	BanExpires    *string `json:"banExpires"`
	ID            string  `json:"id"`
}

const baUserCols = `name, email, "emailVerified", image, "createdAt", "updatedAt", role, banned, "banReason", "banExpires", id`

// readBAUser scans the current row of a query selecting baUserCols.
func readBAUser(rows pgx.Rows) (*BAUser, error) {
	var u BAUser
	var created, updated time.Time
	var banned *bool
	var banExpires *time.Time
	if err := rows.Scan(&u.Name, &u.Email, &u.EmailVerified, &u.Image, &created, &updated,
		&u.Role, &banned, &u.BanReason, &banExpires, &u.ID); err != nil {
		return nil, err
	}
	u.CreatedAt = jsTime(created)
	u.UpdatedAt = jsTime(updated)
	u.Banned = banned != nil && *banned
	if banExpires != nil {
		s := jsTime(*banExpires)
		u.BanExpires = &s
	}
	return &u, nil
}

// jsTime is Date#toISOString — the format every other timestamp in this
// API uses.
func jsTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// ListBAUsers returns one page of users plus the unpaginated total.
// limit/offset of 0 mean "unset", matching Better Auth's `Number(x) ||
// undefined` coercion.
func (s *Store) ListBAUsers(ctx context.Context, limit, offset int) ([]BAUser, int, error) {
	sql := `SELECT ` + baUserCols + ` FROM "user" ORDER BY "createdAt" ASC`
	args := []any{}
	if limit > 0 {
		args = append(args, limit)
		sql += ` LIMIT $1`
	}
	if offset > 0 {
		args = append(args, offset)
		sql += ` OFFSET $` + itoa(len(args))
	}
	rows, err := s.Pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []BAUser{}
	for rows.Next() {
		u, err := readBAUser(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, *u)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	var total int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*)::int FROM "user"`).Scan(&total); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

// GetBAUser returns one user, or (nil, nil) when the id is unknown.
func (s *Store) GetBAUser(ctx context.Context, id string) (*BAUser, error) {
	rows, err := s.Pool.Query(ctx, `SELECT `+baUserCols+` FROM "user" WHERE id = $1`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	return readBAUser(rows)
}

// CreateBAUser writes the user + credential account rows a Better Auth
// `admin/create-user` call writes. Returns (nil, nil) when the email is
// already taken.
func (s *Store) CreateBAUser(ctx context.Context, email, name, password, role string) (*BAUser, error) {
	// An absent password is legal upstream — it creates a user with no
	// credential account (invite / social-only). Nothing in this product
	// produces one, but matching costs a branch.
	hash := ""
	if password != "" {
		var err error
		if hash, err = auth.HashPassword(password); err != nil {
			return nil, err
		}
	}
	id := auth.NewID()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var existing string
	err = tx.QueryRow(ctx, `SELECT id FROM "user" WHERE lower(email) = lower($1)`, email).Scan(&existing)
	if err == nil {
		return nil, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO "user" (id, email, name, "emailVerified", role, "createdAt", "updatedAt")
		VALUES ($1, $2, $3, false, $4, now(), now())`, id, email, name, role); err != nil {
		return nil, err
	}
	if hash != "" {
		if _, err = tx.Exec(ctx, `
			INSERT INTO "account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
			VALUES ($1, $2, 'credential', $2, $3, now(), now())`, auth.NewID(), id, hash); err != nil {
			return nil, err
		}
	}
	rows, err := tx.Query(ctx, `SELECT `+baUserCols+` FROM "user" WHERE id = $1`, id)
	if err != nil {
		return nil, err
	}
	if !rows.Next() {
		rows.Close()
		return nil, rows.Err()
	}
	u, err := readBAUser(rows)
	rows.Close()
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return u, nil
}

// SetBAUserRole updates the role column and returns the updated row.
func (s *Store) SetBAUserRole(ctx context.Context, id, role string) (*BAUser, error) {
	rows, err := s.Pool.Query(ctx,
		`UPDATE "user" SET role = $2, "updatedAt" = now() WHERE id = $1 RETURNING `+baUserCols, id, role)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	return readBAUser(rows)
}

// DeleteBAUser drops the user's sessions and then the user row itself
// (the account rows cascade), exactly what Better Auth's
// admin/remove-user does. novamem's own memory rows are left alone —
// the TS passthrough leaves them too; teardown lives on
// DELETE /v1/admin/users/{id}.
func (s *Store) DeleteBAUser(ctx context.Context, id string) error {
	if _, err := s.Pool.Exec(ctx, `DELETE FROM "session" WHERE "userId" = $1`, id); err != nil {
		return err
	}
	_, err := s.Pool.Exec(ctx, `DELETE FROM "user" WHERE id = $1`, id)
	return err
}

// CountAdminsExcept counts admins other than `excludeID` — the
// last-admin guard in routes/auth.ts.
func (s *Store) CountAdminsExcept(ctx context.Context, excludeID string) (int, error) {
	var n int
	err := s.Pool.QueryRow(ctx,
		`SELECT count(*)::int FROM "user" WHERE role = 'admin' AND id <> $1`, excludeID).Scan(&n)
	return n, err
}

// CountAdmins is the bootstrap-seed probe (main.ts: seed only when the
// system has no admin at all).
func (s *Store) CountAdmins(ctx context.Context) (int, error) {
	var n int
	err := s.Pool.QueryRow(ctx, `SELECT count(*)::int FROM "user" WHERE role = 'admin'`).Scan(&n)
	return n, err
}

// SetCredentialPassword replaces the scrypt hash on the user's
// credential account row. Returns false when there is no such row.
func (s *Store) SetCredentialPassword(ctx context.Context, userID, hash string) (bool, error) {
	tag, err := s.Pool.Exec(ctx, `
		UPDATE "account" SET password = $2, "updatedAt" = now()
		 WHERE "userId" = $1 AND "providerId" = 'credential' AND password IS NOT NULL`, userID, hash)
	return tag.RowsAffected() > 0, err
}

// DeleteUserSessions drops every session a user holds (change-password
// with revokeOtherSessions, and the remove-user path).
func (s *Store) DeleteUserSessions(ctx context.Context, userID string) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM "session" WHERE "userId" = $1`, userID)
	return err
}
