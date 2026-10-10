// Package tenant is the identity model for on-behalf-of (OBO) callers
// (ADR 0011).
//
// A service acting for one of its users has no NovaMem user row. Its
// effective internal user id is a reserved composite,
//
//	org:<organization>/<subject>
//
// so that every store keyed by user_id (entries, FTS shadow, vectors,
// relations, facts, stats, quotas, rate limits) isolates organizations
// without learning about organizations. The prefix cannot collide with
// a real NovaMem user: real ids are ULIDs, Better Auth ids or the
// literal "public", none of which contain ':'.
package tenant

import "strings"

// DefaultOrg owns every row that predates organizations, and every row
// written by an ordinary (non-OBO) caller. Service keys may not be
// bound to it, so a service can never act as a real user.
const DefaultOrg = "default"

// Prefix marks a composite OBO user id.
const Prefix = "org:"

const (
	maxOrgLen = 64
	maxSubLen = 128
)

func isAlnum(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
}

// ValidOrg reports whether s is an acceptable organization id:
// 1-64 characters of [A-Za-z0-9._-], starting with an alphanumeric. It
// deliberately excludes ':' and '/', which keeps the composite id
// unambiguous to split.
func ValidOrg(s string) bool {
	if s == "" || len(s) > maxOrgLen || !isAlnum(s[0]) {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !isAlnum(c) && c != '.' && c != '_' && c != '-' {
			return false
		}
	}
	return true
}

// ValidSub reports whether s is an acceptable OBO subject: 1-128
// characters of [A-Za-z0-9._:@+=-], starting with an alphanumeric.
func ValidSub(s string) bool {
	if s == "" || len(s) > maxSubLen || !isAlnum(s[0]) {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !isAlnum(c) && !strings.ContainsRune("._:@+=-", rune(c)) {
			return false
		}
	}
	return true
}

// UserID builds the composite internal user id. The caller must have
// validated org and sub.
func UserID(org, sub string) string { return Prefix + org + "/" + sub }

// IsOBO reports whether userID is a composite OBO identity.
func IsOBO(userID string) bool { return strings.HasPrefix(userID, Prefix) }

// OrgOf is the organization a user id belongs to: the embedded org for a
// composite id, DefaultOrg for every real user.
func OrgOf(userID string) string {
	rest, ok := strings.CutPrefix(userID, Prefix)
	if !ok {
		return DefaultOrg
	}
	org, _, _ := strings.Cut(rest, "/")
	return org
}
