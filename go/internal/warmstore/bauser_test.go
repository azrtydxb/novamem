package warmstore

import (
	"context"
	"log/slog"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Opt-in, like the migration and rate-limit tests:
//
//	NOVAMEM_TEST_DATABASE_URL=postgres://…/throwaway go test ./internal/warmstore
func baUserStore(t *testing.T) *Store {
	t.Helper()
	url := os.Getenv("NOVAMEM_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set NOVAMEM_TEST_DATABASE_URL to a throwaway database to run")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := Migrate(ctx, pool, slog.New(slog.DiscardHandler)); err != nil {
		t.Fatal(err)
	}
	return New(pool)
}

// The flag says "this account owes a password change". Only an account
// that HAS a password can owe one.
//
// An admin-created account carries a password the admin chose and the
// user never did, so it must rotate before anything else. An account
// created with no password has no credential row at all: it cannot sign
// in through the only flow this product offers, so it can never reach
// the screen that clears the flag. Setting it there creates an account
// that is permanently locked out, silently.
func TestCreateBAUserFlagsOnlyCredentialledAccounts(t *testing.T) {
	s := baUserStore(t)
	ctx := context.Background()

	for _, tc := range []struct {
		name     string
		email    string
		password string
		want     bool
	}{
		{"admin chose a temporary password", "flagged@test.local", "temp-password-1", true},
		{"no credential to change", "invited@test.local", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Re-runnable against the same throwaway database.
			if _, err := s.Pool.Exec(ctx,
				`DELETE FROM "user" WHERE lower(email) = lower($1)`, tc.email); err != nil {
				t.Fatal(err)
			}

			u, err := s.CreateBAUser(ctx, tc.email, "probe", tc.password, "user")
			if err != nil {
				t.Fatal(err)
			}
			if u == nil {
				t.Fatal("CreateBAUser returned nil for a fresh email")
			}
			if u.MustChangePassword != tc.want {
				t.Errorf("mustChangePassword = %v, want %v", u.MustChangePassword, tc.want)
			}

			// And the flag must agree with whether a credential exists —
			// that is the invariant, not the literal it was written with.
			var credentials int
			if err := s.Pool.QueryRow(ctx,
				`SELECT count(*)::int FROM "account" WHERE "userId" = $1 AND "providerId" = 'credential'`,
				u.ID).Scan(&credentials); err != nil {
				t.Fatal(err)
			}
			if (credentials > 0) != u.MustChangePassword {
				t.Errorf("credential rows = %d but mustChangePassword = %v",
					credentials, u.MustChangePassword)
			}

			t.Cleanup(func() {
				_, _ = s.Pool.Exec(ctx, `DELETE FROM "user" WHERE id = $1`, u.ID)
			})
		})
	}
}
