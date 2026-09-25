package main

import "testing"

func TestCasing(t *testing.T) {
	for _, c := range []struct{ in, pascal, camel, snake string }{
		{"contentMode", "ContentMode", "contentMode", "content_mode"},
		{"SessionRecap", "SessionRecap", "sessionRecap", "session_recap"},
		{"userId", "UserId", "userId", "user_id"},
		{"UserID", "UserId", "userId", "user_id"},
		{"read_only", "ReadOnly", "readOnly", "read_only"},
		{"RemoveProjectMemberByUsername", "RemoveProjectMemberByUsername", "removeProjectMemberByUsername", "remove_project_member_by_username"},
	} {
		if got := pascal(c.in); got != c.pascal {
			t.Errorf("pascal(%q) = %q, want %q", c.in, got, c.pascal)
		}
		if got := camel(c.in); got != c.camel {
			t.Errorf("camel(%q) = %q, want %q", c.in, got, c.camel)
		}
		if got := snake(c.in); got != c.snake {
			t.Errorf("snake(%q) = %q, want %q", c.in, got, c.snake)
		}
	}
}
