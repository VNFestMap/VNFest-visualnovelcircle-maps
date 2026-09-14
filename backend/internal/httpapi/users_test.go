package httpapi

import "testing"

func TestDisplayRoleUsesHighestPermissionLevel(t *testing.T) {
	tests := []struct {
		name        string
		role        string
		memberships []map[string]any
		want        string
	}{
		{name: "visitor without memberships", role: "visitor", want: "visitor"},
		{name: "activity personnel membership", role: "visitor", memberships: []map[string]any{{"role": "external", "status": "active"}}, want: "external"},
		{name: "manager outranks member", role: "visitor", memberships: []map[string]any{{"role": "member", "status": "active"}, {"role": "manager", "status": "active"}}, want: "manager"},
		{name: "representative outranks manager", role: "manager", memberships: []map[string]any{{"role": "representative", "status": "active"}}, want: "representative"},
		{name: "super admin remains highest", role: "super_admin", memberships: []map[string]any{{"role": "representative", "status": "active"}}, want: "super_admin"},
		{name: "inactive membership ignored", role: "visitor", memberships: []map[string]any{{"role": "representative", "status": "disabled"}}, want: "visitor"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := displayRole(test.role, test.memberships); got != test.want {
				t.Fatalf("displayRole(%q, %#v) = %q, want %q", test.role, test.memberships, got, test.want)
			}
		})
	}
}
