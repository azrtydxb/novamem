// Service keys: the registered Ed25519 public keys behind on-behalf-of
// tokens (ADR 0011, migration 0012). Only public keys are stored.
package warmstore

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// ServiceKey is one registered key. PublicKey is the raw 32-byte Ed25519
// key, base64url.
type ServiceKey struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	OrganizationID string     `json:"organizationId"`
	PublicKey      string     `json:"publicKey"`
	CreatedAt      time.Time  `json:"createdAt"`
	RevokedAt      *time.Time `json:"revokedAt"`
}

const serviceKeyColumns = `id, name, organization_id, public_key, created_at, revoked_at`

func scanServiceKey(r rowScanner) (*ServiceKey, error) {
	var k ServiceKey
	if err := r.Scan(&k.ID, &k.Name, &k.OrganizationID, &k.PublicKey, &k.CreatedAt, &k.RevokedAt); err != nil {
		return nil, err
	}
	return &k, nil
}

// CreateServiceKey registers a key. The caller validates the org (and
// refuses the default org) and the key encoding.
func (s *Store) CreateServiceKey(ctx context.Context, id, name, orgID, publicKey string) (*ServiceKey, error) {
	return scanServiceKey(s.Pool.QueryRow(ctx,
		`INSERT INTO service_keys (id, name, organization_id, public_key)
		 VALUES ($1,$2,$3,$4) RETURNING `+serviceKeyColumns,
		id, name, orgID, publicKey))
}

// GetServiceKey returns (nil, nil) for an unknown id. Revoked keys are
// returned with RevokedAt set; the verifier rejects them.
func (s *Store) GetServiceKey(ctx context.Context, id string) (*ServiceKey, error) {
	k, err := scanServiceKey(s.Pool.QueryRow(ctx,
		`SELECT `+serviceKeyColumns+` FROM service_keys WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return k, err
}

// ListServiceKeys returns every key, newest first, revoked ones included
// so an operator can see what was retired.
func (s *Store) ListServiceKeys(ctx context.Context) ([]ServiceKey, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT `+serviceKeyColumns+` FROM service_keys ORDER BY created_at DESC, id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ServiceKey{}
	for rows.Next() {
		k, err := scanServiceKey(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *k)
	}
	return out, rows.Err()
}

// RevokeServiceKey marks a key revoked. Returns false when the id is
// unknown or already revoked.
func (s *Store) RevokeServiceKey(ctx context.Context, id string) (bool, error) {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE service_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}
