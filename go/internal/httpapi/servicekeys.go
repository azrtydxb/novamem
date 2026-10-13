// Service-key administration: /v1/admin/service-keys. A service key is
// the Ed25519 public half of a key a service uses to mint on-behalf-of
// JWTs (ADR 0011), bound to exactly one organization. Admin-only, like
// the rest of /v1/admin/*; an on-behalf-of token cannot reach it.
package httpapi

import (
	"net/http"

	"github.com/azrtydxb/novamem/go/internal/auth"
	"github.com/azrtydxb/novamem/go/internal/tenant"
)

func (s *server) registerServiceKeys(mux *routeMux) {
	mux.HandleFunc("POST /v1/admin/service-keys", s.withAuth(s.handleServiceKeyCreate))
	mux.HandleFunc("GET /v1/admin/service-keys", s.withAuth(s.handleServiceKeyList))
	mux.HandleFunc("DELETE /v1/admin/service-keys/{id}", s.withAuth(s.handleServiceKeyRevoke))
}

func (s *server) handleServiceKeyCreate(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	c, ok := s.meBody(w, r, false)
	if !ok {
		return
	}
	name, _ := c.str("name", true, 1, 128)
	org, hasOrg := c.str("organizationId", true, 1, 64)
	pubRaw, hasPub := c.str("publicKey", true, 1, 128)
	if hasOrg {
		switch {
		case org == tenant.DefaultOrg:
			// The default org owns every real user's data; a service key
			// bound to it could act as any of them.
			c.add("organizationId", "service keys cannot be bound to the default organization", "invalid_value")
		case !tenant.ValidOrg(org):
			c.add("organizationId", "must be 1-64 characters of [A-Za-z0-9._-], starting with a letter or digit", "invalid_format")
		}
	}
	var pubNormalized string
	if hasPub {
		pub, err := auth.DecodeServicePublicKey(pubRaw)
		if err != nil {
			c.add("publicKey", err.Error(), "invalid_format")
		} else {
			pubNormalized = auth.EncodeServicePublicKey(pub)
		}
	}
	if len(c.issues) > 0 {
		s.sendIssues(w, c.issues)
		return
	}
	key, err := s.warm.CreateServiceKey(r.Context(), auth.NewID(), name, org, pubNormalized)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	s.audit(r, "admin.service_key.create", key.ID, map[string]any{
		"name": name, "organizationId": org,
	})
	writeJSONValue(w, http.StatusCreated, key)
}

func (s *server) handleServiceKeyList(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	keys, err := s.warm.ListServiceKeys(r.Context())
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	writeJSONValue(w, http.StatusOK, map[string]any{"keys": keys})
}

func (s *server) handleServiceKeyRevoke(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	id := r.PathValue("id")
	revoked, err := s.warm.RevokeServiceKey(r.Context(), id)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	if !revoked {
		s.sendError(w, http.StatusNotFound, "no such active service key")
		return
	}
	s.audit(r, "admin.service_key.revoke", id, nil)
	writeJSONValue(w, http.StatusOK, map[string]any{"revoked": true})
}
