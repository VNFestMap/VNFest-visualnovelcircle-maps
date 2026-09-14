package httpapi

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

func TestSpaceAccessUsesHighestSystemOrActiveMembershipRole(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{DBDriver: "sqlite", DBPath: filepath.Join(root, "space-access.db")}
	db, err := sqlstore.Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE club_memberships (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		userID int
		role   string
		status string
	}{
		{userID: 2, role: "external", status: "active"},
		{userID: 3, role: "member", status: "active"},
		{userID: 4, role: "manager", status: "active"},
		{userID: 5, role: "member", status: "pending"},
		{userID: 6, role: "member", status: "inactive"},
	} {
		if _, err := db.Exec("INSERT INTO club_memberships(user_id,role,status) VALUES(?,?,?)", row.userID, row.role, row.status); err != nil {
			t.Fatal(err)
		}
	}
	server := &Server{db: db}
	ptr := func(id int64) *int64 { return &id }
	cases := []struct {
		name    string
		userID  *int64
		role    string
		allowed bool
		reason  string
	}{
		{name: "guest", reason: "login_required"},
		{name: "visitor", userID: ptr(1), role: "visitor", reason: "membership_required"},
		{name: "external", userID: ptr(2), role: "external", reason: "membership_required"},
		{name: "system member", userID: ptr(1), role: "member", allowed: true, reason: "ok"},
		{name: "active member membership", userID: ptr(3), role: "visitor", allowed: true, reason: "ok"},
		{name: "manager", userID: ptr(7), role: "manager", allowed: true, reason: "ok"},
		{name: "representative", userID: ptr(7), role: "representative", allowed: true, reason: "ok"},
		{name: "super admin", userID: ptr(7), role: "super_admin", allowed: true, reason: "ok"},
		{name: "pending membership", userID: ptr(5), role: "visitor", reason: "membership_required"},
		{name: "inactive membership", userID: ptr(6), role: "visitor", reason: "membership_required"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			allowed, reason := server.spaceAccess(context.Background(), test.userID, test.role)
			if allowed != test.allowed || reason != test.reason {
				t.Fatalf("spaceAccess()=(%v,%q), want (%v,%q)", allowed, reason, test.allowed, test.reason)
			}
		})
	}

	failureDB, err := sqlstore.Open(context.Background(), config.Config{DBDriver: "sqlite", DBPath: filepath.Join(root, "space-access-failure.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer failureDB.Close()
	failureServer := &Server{db: failureDB}
	allowed, reason := failureServer.spaceAccess(context.Background(), ptr(99), "visitor")
	if allowed || reason != "unavailable" {
		t.Fatalf("database lookup failure must fail closed, got (%v,%q)", allowed, reason)
	}
}
