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

func TestVotingProjectNominationCastAndResultsCompatibility(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{Root: root, SiteURL: "http://test", DBDriver: "sqlite", DBPath: filepath.Join(root, "vote.db"), DataDir: root, UploadDir: root, SessionLifetime: 3600}
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
	if _, err := db.Exec(`INSERT INTO club_memberships(user_id,club_id,country,role,status) VALUES(1,7,'china','representative','active'),(2,7,'china','member','active')`); err != nil {
		t.Fatal(err)
	}
	files := filestore.New(root, root)
	sessions := sessionstore.New(db)
	for _, item := range []struct {
		id  string
		uid int64
	}{{"vote-admin", 1}, {"vote-member", 2}} {
		uid := item.uid
		if err := sessions.Save(context.Background(), &sessionstore.Session{ID: item.id, UserID: &uid, Payload: map[string]any{"user_id": uid}, ExpiresAt: time.Now().Add(time.Hour), Valid: true}); err != nil {
			t.Fatal(err)
		}
	}
	server, err := New(cfg, db, files, &sessionstore.Manager{Store: sessions, CookieName: "PHPSESSID"})
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
	var created struct {
		ID int64 `json:"id"`
	}
	response := request("vote-admin", http.MethodPost, "/api/vote_projects.php?action=create", `{"project_type":"twelve","club_id":7,"country":"china","title":"测试十二器","result_visibility":"live_votes"}`)
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &created) != nil || created.ID <= 0 {
		t.Fatalf("create status=%d body=%s", response.Code, response.Body.String())
	}
	var stageCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM vote_stages WHERE project_id=?`, created.ID).Scan(&stageCount); err != nil || stageCount != 4 {
		t.Fatalf("default stages count=%d err=%v", stageCount, err)
	}
	openNomination := request("vote-admin", http.MethodPost, "/api/vote_stages.php?action=open&stage_id=1", "")
	if openNomination.Code != http.StatusOK {
		t.Fatalf("open nomination status=%d body=%s", openNomination.Code, openNomination.Body.String())
	}
	var nominated struct {
		EntryID int64 `json:"entry_id"`
	}
	nomination := request("vote-member", http.MethodPost, "/api/vote_nominations.php?action=submit", `{"project_id":`+strconv.FormatInt(created.ID, 10)+`,"title":"作品 A","title_cn":"作品 A"}`)
	if nomination.Code != http.StatusOK || json.Unmarshal(nomination.Body.Bytes(), &nominated) != nil || nominated.EntryID <= 0 {
		t.Fatalf("nomination status=%d body=%s", nomination.Code, nomination.Body.String())
	}
	duplicate := request("vote-member", http.MethodPost, "/api/vote_nominations.php?action=nominate", `{"project_id":`+strconv.FormatInt(created.ID, 10)+`,"title":"作品 A","title_cn":"作品 A"}`)
	if duplicate.Code != http.StatusOK || !strings.Contains(duplicate.Body.String(), strconv.FormatInt(nominated.EntryID, 10)) {
		t.Fatalf("duplicate nomination status=%d body=%s", duplicate.Code, duplicate.Body.String())
	}
	listed := request("", http.MethodGet, "/api/vote_nominations.php?action=list&project_id="+strconv.FormatInt(created.ID, 10), "")
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), "作品 A") {
		t.Fatalf("nomination list status=%d body=%s", listed.Code, listed.Body.String())
	}
	openQualifier := request("vote-admin", http.MethodPost, "/api/vote_stages.php?action=open&stage_id=2", "")
	if openQualifier.Code != http.StatusOK {
		t.Fatalf("open qualifier status=%d body=%s", openQualifier.Code, openQualifier.Body.String())
	}
	seed := request("vote-admin", http.MethodPost, "/api/vote_stages.php?action=seed_entries", `{"stage_id":2,"entry_ids":[`+strconv.FormatInt(nominated.EntryID, 10)+`]}`)
	if seed.Code != http.StatusOK {
		t.Fatalf("seed status=%d body=%s", seed.Code, seed.Body.String())
	}
	cast := request("vote-member", http.MethodPost, "/api/vote_votes.php?action=cast", `{"stage_id":2,"entry_ids":[`+strconv.FormatInt(nominated.EntryID, 10)+`]}`)
	if cast.Code != http.StatusOK || !strings.Contains(cast.Body.String(), `"count":1`) {
		t.Fatalf("cast status=%d body=%s", cast.Code, cast.Body.String())
	}
	repeatCast := request("vote-member", http.MethodPost, "/api/vote_votes.php?action=cast", `{"stage_id":2,"entry_ids":[`+strconv.FormatInt(nominated.EntryID, 10)+`]}`)
	if repeatCast.Code != http.StatusBadRequest || !strings.Contains(repeatCast.Body.String(), "已投票") {
		t.Fatalf("repeat cast status=%d body=%s", repeatCast.Code, repeatCast.Body.String())
	}
	settle := request("vote-admin", http.MethodPost, "/api/vote_stages.php?action=settle&stage_id=2", "")
	if settle.Code != http.StatusOK {
		t.Fatalf("settle status=%d body=%s", settle.Code, settle.Body.String())
	}
	results := request("", http.MethodGet, "/api/vote_votes.php?action=stage_results&stage_id=2", "")
	if results.Code != http.StatusOK || !strings.Contains(results.Body.String(), "作品 A") || !strings.Contains(results.Body.String(), `"rank_no":1`) {
		t.Fatalf("results status=%d body=%s", results.Code, results.Body.String())
	}
	published := request("vote-admin", http.MethodPost, "/api/vote_projects.php?action=publish&id="+strconv.FormatInt(created.ID, 10), "")
	if published.Code != http.StatusOK || !strings.Contains(published.Body.String(), `"status":"running"`) {
		t.Fatalf("publish status=%d body=%s", published.Code, published.Body.String())
	}
}
