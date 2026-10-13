package tenant

import "testing"

func TestIdentity(t *testing.T) {
	for _, c := range []struct {
		s   string
		org bool
		sub bool
	}{
		{"acme", true, true}, {"Acme-1.x_y", true, true}, {"", false, false},
		{"-a", false, false}, {"a/b", false, false}, {"a:b", false, true},
		{"a b", false, false}, {"user@x.io", false, true},
	} {
		if got := ValidOrg(c.s); got != c.org {
			t.Errorf("ValidOrg(%q) = %v", c.s, got)
		}
		if got := ValidSub(c.s); got != c.sub {
			t.Errorf("ValidSub(%q) = %v", c.s, got)
		}
	}
	u := UserID("acme", "alice")
	if u != "org:acme/alice" || !IsOBO(u) || OrgOf(u) != "acme" {
		t.Fatalf("composite %q", u)
	}
	// An org cannot be forged through the subject: ':' is allowed in a
	// sub but '/' is not, so the first '/' always ends the org.
	if OrgOf(UserID("acme", "x:y")) != "acme" {
		t.Fatal("sub leaked into org")
	}
	for _, real := range []string{"public", "01HZX0000000000000000000", "abc123"} {
		if IsOBO(real) || OrgOf(real) != DefaultOrg {
			t.Fatalf("%q misclassified", real)
		}
	}
}
