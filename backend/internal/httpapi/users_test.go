package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sessionstore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

func TestDisplayRoleUsesHighestPermissionLevel(t *testing.T) {
	tests := []struct {
		name             string
		role             string
		memberships      []map[string]any
		activityReviewer bool
		want             string
	}{
		{name: "visitor without memberships", role: "visitor", want: "visitor"},
		{name: "activity personnel membership", role: "visitor", memberships: []map[string]any{{"role": "external", "status": "active"}}, want: "external"},
		{name: "activity personnel audit identity", role: "visitor", activityReviewer: true, want: "external"},
		{name: "activity personnel does not demote manager", role: "manager", activityReviewer: true, want: "manager"},
		{name: "manager outranks member", role: "visitor", memberships: []map[string]any{{"role": "member", "status": "active"}, {"role": "manager", "status": "active"}}, want: "manager"},
		{name: "representative outranks manager", role: "manager", memberships: []map[string]any{{"role": "representative", "status": "active"}}, want: "representative"},
		{name: "super admin remains highest", role: "super_admin", memberships: []map[string]any{{"role": "representative", "status": "active"}}, want: "super_admin"},
		{name: "inactive membership ignored", role: "visitor", memberships: []map[string]any{{"role": "representative", "status": "disabled"}}, want: "visitor"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := displayRoleWithActivityReviewer(test.role, test.memberships, test.activityReviewer); got != test.want {
				t.Fatalf("displayRole(%q, %#v) = %q, want %q", test.role, test.memberships, got, test.want)
			}
		})
	}
}

func TestUserActivityReviewerFilteringAndAtomicRevocation(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{DBDriver: "sqlite", DBPath: filepath.Join(root, "users.db")}
	db, err := sqlstore.Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, nickname TEXT, email TEXT, avatar_url TEXT, profile_bio TEXT, language_preference TEXT, role TEXT NOT NULL, status TEXT NOT NULL, is_audit INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, last_login_at TEXT)`,
		`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, payload TEXT, ip_address TEXT, user_agent TEXT, expires_at TEXT NOT NULL, is_valid INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE club_memberships (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, club_id INTEGER NOT NULL, country TEXT DEFAULT 'china', role TEXT NOT NULL, status TEXT NOT NULL, joined_at TEXT)`,
		`CREATE TABLE galonly_reviewers (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL, UNIQUE(event_id,user_id))`,
		`INSERT INTO users(id,username,nickname,role,status,is_audit) VALUES
            (1,'admin','Admin','super_admin','active',0),
            (2,'reviewer','Reviewer','visitor','active',0),
            (3,'auditor','Auditor','visitor','active',1),
            (4,'external-member','External member','visitor','active',0),
            (5,'manager','Manager','manager','active',1)`,
		`INSERT INTO galonly_reviewers(event_id,user_id,role) VALUES(1,2,'reviewer')`,
		`INSERT INTO club_memberships(user_id,club_id,country,role,status,joined_at) VALUES(4,9,'china','external','active',CURRENT_TIMESTAMP)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec("INSERT INTO sessions(id,user_id,expires_at,is_valid) VALUES(?,?,?,1)", "admin-session", 1, time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	server, err := New(cfg, db, nil, &sessionstore.Manager{Store: sessionstore.New(db), CookieName: "PHPSESSID"})
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, target, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://test"+target, strings.NewReader(body))
		req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: "admin-session"})
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		res := httptest.NewRecorder()
		server.ServeHTTP(res, req)
		return res
	}
	usernames := func(res *httptest.ResponseRecorder) map[string]bool {
		t.Helper()
		var payload struct {
			Users []map[string]any `json:"users"`
		}
		if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode status=%d body=%s: %v", res.Code, res.Body.String(), err)
		}
		result := map[string]bool{}
		for _, item := range payload.Users {
			result[stringValue(item["username"])] = true
		}
		return result
	}

	external := request(http.MethodGet, "/api/users.php?action=list&role=external&per_page=100", "")
	if external.Code != http.StatusOK {
		t.Fatalf("external list status=%d body=%s", external.Code, external.Body.String())
	}
	externalUsers := usernames(external)
	for _, username := range []string{"reviewer", "auditor", "external-member", "manager"} {
		if !externalUsers[username] {
			t.Fatalf("effective external user %q missing from %v", username, externalUsers)
		}
	}

	revoked := request(http.MethodPost, "/api/users.php?action=update", `{"id":2,"is_audit":false}`)
	if revoked.Code != http.StatusOK {
		t.Fatalf("reviewer revoke status=%d body=%s", revoked.Code, revoked.Body.String())
	}
	var reviewerCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM galonly_reviewers WHERE user_id=2").Scan(&reviewerCount); err != nil || reviewerCount != 0 {
		t.Fatalf("reviewer assignment count=%d err=%v", reviewerCount, err)
	}

	if _, err := db.Exec("UPDATE users SET is_audit=1 WHERE id=2"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO galonly_reviewers(event_id,user_id,role) VALUES(1,2,'reviewer')"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TRIGGER reject_reviewer_delete BEFORE DELETE ON galonly_reviewers BEGIN SELECT RAISE(ABORT,'blocked'); END`); err != nil {
		t.Fatal(err)
	}
	failed := request(http.MethodPost, "/api/users.php?action=update", `{"id":2,"is_audit":false}`)
	if failed.Code != http.StatusInternalServerError {
		t.Fatalf("failed revoke status=%d body=%s", failed.Code, failed.Body.String())
	}
	var audit int
	if err := db.QueryRow("SELECT is_audit FROM users WHERE id=2").Scan(&audit); err != nil || audit != 1 {
		t.Fatalf("audit flag did not roll back: audit=%d err=%v", audit, err)
	}
	if _, err := db.Exec("DROP TRIGGER reject_reviewer_delete"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("DROP TABLE galonly_reviewers"); err != nil {
		t.Fatal(err)
	}
	legacy := request(http.MethodGet, "/api/users.php?action=list&role=external&per_page=100", "")
	if legacy.Code != http.StatusOK {
		t.Fatalf("legacy external list status=%d body=%s", legacy.Code, legacy.Body.String())
	}
	legacyUsers := usernames(legacy)
	if !legacyUsers["auditor"] || !legacyUsers["external-member"] {
		t.Fatalf("legacy external identities missing from %v", legacyUsers)
	}
	if _, err := db.Exec("DROP TABLE club_memberships"); err != nil {
		t.Fatal(err)
	}
	if unavailable := request(http.MethodGet, "/api/users.php?action=get&id=2", ""); unavailable.Code != http.StatusServiceUnavailable {
		t.Fatalf("membership lookup failure status=%d body=%s", unavailable.Code, unavailable.Body.String())
	}
}
