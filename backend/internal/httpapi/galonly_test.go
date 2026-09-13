package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/filestore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sessionstore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

func TestGalOnlyApplicationReviewAndPublicVoteCompatibility(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{Root: root, SiteURL: "http://test", DBDriver: "sqlite", DBPath: filepath.Join(root, "galonly.db"), DataDir: root, UploadDir: root, SessionLifetime: 3600}
	db, err := sqlstore.Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, nickname TEXT, avatar_url TEXT, role TEXT NOT NULL, status TEXT NOT NULL, email TEXT, email_verified_at TEXT, password_hash TEXT, qq_openid TEXT, discord_id TEXT, is_audit INTEGER DEFAULT 0, profile_bio TEXT, membership_application_email_enabled INTEGER DEFAULT 1, display_membership_id INTEGER, language_preference TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, last_login_at TEXT)`,
		`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, ip_address TEXT, user_agent TEXT, expires_at TEXT NOT NULL, is_valid INTEGER NOT NULL DEFAULT 1)`,
		`CREATE TABLE club_memberships (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, club_id INTEGER NOT NULL, country TEXT NOT NULL DEFAULT 'china', role TEXT NOT NULL, status TEXT NOT NULL, join_method TEXT, joined_at TEXT, left_at TEXT)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := sqlstore.Apply(context.Background(), db, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO users(id,username,nickname,role,status) VALUES(1,'admin','管理员','super_admin','active'),(2,'member','成员','member','active')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO club_memberships(user_id,club_id,country,role,status) VALUES(2,7,'china','member','active')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO galonly_events(id,name,location,date,registration_open,event_code) VALUES(1,'测试 GalOnly','上海','2026-10-01',1,'shanghai')`); err != nil {
		t.Fatal(err)
	}
	sessions := sessionstore.New(db)
	for _, item := range []struct {
		id  string
		uid int64
	}{{"gal-admin", 1}, {"gal-member", 2}} {
		uid := item.uid
		if err := sessions.Save(context.Background(), &sessionstore.Session{ID: item.id, UserID: &uid, Payload: map[string]any{"user_id": uid}, ExpiresAt: time.Now().Add(time.Hour), Valid: true}); err != nil {
			t.Fatal(err)
		}
	}
	server, err := New(cfg, db, filestore.New(root, root), &sessionstore.Manager{Store: sessions, CookieName: "PHPSESSID"})
	if err != nil {
		t.Fatal(err)
	}
	request := func(sessionID, method, endpoint, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://test"+endpoint, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://test")
		if sessionID != "" {
			req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sessionID})
		}
		res := httptest.NewRecorder()
		server.ServeHTTP(res, req)
		return res
	}
	events := request("", http.MethodGet, "/api/galonly.php?action=list_events", "")
	if events.Code != http.StatusOK || !strings.Contains(events.Body.String(), "测试 GalOnly") {
		t.Fatalf("events status=%d body=%s", events.Code, events.Body.String())
	}
	submitted := request("gal-member", http.MethodPost, "/api/galonly.php?action=submit", `{"event_id":1,"club_ids":[7],"club_countries":["china"],"contact":"qq-1","booth_name":"测试摊位"}`)
	if submitted.Code != http.StatusOK {
		t.Fatalf("submit status=%d body=%s", submitted.Code, submitted.Body.String())
	}
	var submission struct {
		ApplicationID int64 `json:"application_id"`
	}
	if err := json.Unmarshal(submitted.Body.Bytes(), &submission); err != nil || submission.ApplicationID <= 0 {
		t.Fatalf("submit payload=%s", submitted.Body.String())
	}
	got := request("gal-member", http.MethodGet, "/api/galonly.php?action=get_application&application_id="+strconv.FormatInt(submission.ApplicationID, 10), "")
	if got.Code != http.StatusOK || !strings.Contains(got.Body.String(), "测试摊位") || !strings.Contains(got.Body.String(), `"image_paths":[]`) {
		t.Fatalf("get status=%d body=%s", got.Code, got.Body.String())
	}
	resolved := request("gal-admin", http.MethodPost, "/api/galonly.php?action=resolve", `{"application_id":`+strconv.FormatInt(submission.ApplicationID, 10)+`,"decision":"approve"}`)
	if resolved.Code != http.StatusOK || !strings.Contains(resolved.Body.String(), `"status":"approved"`) {
		t.Fatalf("resolve status=%d body=%s", resolved.Code, resolved.Body.String())
	}
	participants := request("", http.MethodGet, "/api/galonly.php?action=list_participants&event_id=1", "")
	if participants.Code != http.StatusOK || !strings.Contains(participants.Body.String(), "测试摊位") {
		t.Fatalf("participants status=%d body=%s", participants.Code, participants.Body.String())
	}
	publicVote := request("", http.MethodPost, "/api/galonly.php?action=cast_public_vote", `{"event_id":1,"application_id":`+strconv.FormatInt(submission.ApplicationID, 10)+`}`)
	if publicVote.Code != http.StatusOK || !strings.Contains(publicVote.Body.String(), "投票成功") {
		t.Fatalf("public vote status=%d body=%s", publicVote.Code, publicVote.Body.String())
	}
	duplicate := request("", http.MethodPost, "/api/galonly.php?action=cast_public_vote", `{"event_id":1,"application_id":`+strconv.FormatInt(submission.ApplicationID, 10)+`}`)
	if duplicate.Code != http.StatusBadRequest || !strings.Contains(duplicate.Body.String(), "已赞过") {
		t.Fatalf("duplicate vote status=%d body=%s", duplicate.Code, duplicate.Body.String())
	}
	staff := request("gal-member", http.MethodPost, "/api/galonly_staff.php?action=submit_staff", `{"event_id":1,"cn_name":"Staff","positions":["摄影"]}`)
	if staff.Code != http.StatusOK || !strings.Contains(staff.Body.String(), "application_id") {
		t.Fatalf("staff status=%d body=%s", staff.Code, staff.Body.String())
	}
}
