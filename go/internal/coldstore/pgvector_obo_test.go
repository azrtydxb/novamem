package coldstore

import "testing"

// The vector tier isolates organizations through the scope key: an
// on-behalf-of identity's composite user id (ADR 0011) lands in a
// different partition from the same subject in another org, and from any
// real user.
func TestScopeOfSeparatesOrganizations(t *testing.T) {
	seen := map[string]string{}
	for _, uid := range []string{"org:acme/alice", "org:globex/alice", "org:acme/bob", "alice", "public"} {
		s := ScopeOf(uid, nil)
		if prev, dup := seen[s]; dup {
			t.Fatalf("%q and %q share scope %q", prev, uid, s)
		}
		seen[s] = uid
	}
}
