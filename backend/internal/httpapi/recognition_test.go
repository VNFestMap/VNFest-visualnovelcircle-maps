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
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/filestore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sessionstore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

func TestRecognitionAssessmentCredentialAndConnectorFlow(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{Root: root, SiteURL: "http://test", DBDriver: "sqlite", DBPath: filepath.Join(root, "vnfest.db"), DataDir: root, UploadDir: root, SessionLifetime: 3600}
	db, err := sqlstore.Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, nickname TEXT, avatar_url TEXT, role TEXT NOT NULL, status TEXT NOT NULL, email TEXT, email_verified_at TEXT, password_hash TEXT, qq_openid TEXT, discord_id TEXT, is_audit INTEGER DEFAULT 0, profile_bio TEXT, membership_application_email_enabled INTEGER DEFAULT 1, display_membership_id INTEGER, language_preference TEXT, credentials_completed_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, last_login_at TEXT)`,
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
	if _, err := db.Exec(`INSERT INTO club_memberships(user_id,club_id,country,role,status) VALUES(1,7,'china','representative','active')`); err != nil {
		t.Fatal(err)
	}
	files := filestore.New(root, root)
	if err := files.WriteJSONAtomic(context.Background(), "clubs.json", map[string]any{"data": []any{map[string]any{"id": 7, "name": "测试同好会"}}}); err != nil {
		t.Fatal(err)
	}
	sessions := sessionstore.New(db)
	for _, item := range []struct {
		id  string
		uid int64
	}{{"admin-recognition", 1}, {"member-recognition", 2}} {
		uid := item.uid
		if err := sessions.Save(context.Background(), &sessionstore.Session{ID: item.id, UserID: &uid, Payload: map[string]any{"user_id": uid}, ExpiresAt: time.Now().Add(time.Hour), Valid: true}); err != nil {
			t.Fatal(err)
		}
	}
	server, err := New(cfg, db, files, &sessionstore.Manager{Store: sessions, CookieName: "PHPSESSID"})
	if err != nil {
		t.Fatal(err)
	}

	content := map[string]any{
		"quiz":  map[string]any{"questions": []any{map[string]any{"type": "single", "question": "1+1?", "options": []any{"2", "3"}, "answer": []any{0}, "points": 10, "explanation": "基础题"}}, "settings": map[string]any{"result_mode": "immediate"}},
		"rules": map[string]any{"conditions": []any{map[string]any{"op": "score_gte", "value": 10}}, "award": map[string]any{"badge_id": 1}},
	}
	if _, err := db.Exec(`INSERT INTO recognition_badges(id,club_id,country,name,category,description,image_url,version,created_by) VALUES(1,7,'china','基础徽章','knowledge','','',1,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO recognition_programs(id,club_id,country,type,title,intro,participant_difficulty,visibility,status,capabilities,participation_rules,max_attempts,cooldown_minutes,max_issuance,credential_ttl_days,created_by) VALUES(1,7,'china','assessment','测试考核','', 'normal','public','published','["quiz.basic"]','',3,0,0,0,1)`); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(content)
	if _, err := db.Exec(`INSERT INTO recognition_program_versions(id,program_id,version_no,status,content_snapshot,published_by,published_at) VALUES(1,1,'v1','published',?,1,CURRENT_TIMESTAMP)`, string(encoded)); err != nil {
		t.Fatal(err)
	}
	request := func(session, method, endpoint, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://test"+endpoint, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://test")
		if session != "" {
			req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: session})
		}
		recorder := httptest.NewRecorder()
		server.ServeHTTP(recorder, req)
		return recorder
	}

	started := request("member-recognition", http.MethodPost, "/api/recognition_participate.php?action=start", `{"program_id":1}`)
	if started.Code != http.StatusOK || !strings.Contains(started.Body.String(), `"attempt_id"`) || !strings.Contains(started.Body.String(), `"questions"`) {
		t.Fatalf("start status=%d body=%s", started.Code, started.Body.String())
	}
	var startPayload struct {
		AttemptID int64 `json:"attempt_id"`
	}
	if err := json.Unmarshal(started.Body.Bytes(), &startPayload); err != nil || startPayload.AttemptID <= 0 {
		t.Fatalf("start payload: %s", started.Body.String())
	}
	submitted := request("member-recognition", http.MethodPost, "/api/recognition_participate.php?action=submit", `{"attempt_id":`+strconvInt(startPayload.AttemptID)+`,"answers":{"0":0}}`)
	if submitted.Code != http.StatusOK || !strings.Contains(submitted.Body.String(), `"passed":true`) || !strings.Contains(submitted.Body.String(), `"issued":true`) {
		t.Fatalf("submit status=%d body=%s", submitted.Code, submitted.Body.String())
	}
	verified := request("", http.MethodGet, "/api/recognition_credentials.php?action=verify&uid=VNF-CRED-no-such", "")
	if verified.Code != http.StatusNotFound || !strings.Contains(verified.Body.String(), "未找到") {
		t.Fatalf("verify missing status=%d body=%s", verified.Code, verified.Body.String())
	}
	mine := request("member-recognition", http.MethodGet, "/api/recognition_credentials.php?action=my", "")
	if mine.Code != http.StatusOK || !strings.Contains(mine.Body.String(), "基础徽章") {
		t.Fatalf("mine status=%d body=%s", mine.Code, mine.Body.String())
	}

	created := request("admin-recognition", http.MethodPost, "/api/recognition_events.php?action=connector_create", `{"club_id":7,"name":"测试连接器"}`)
	if created.Code != http.StatusOK || !strings.Contains(created.Body.String(), `"token"`) {
		t.Fatalf("connector create status=%d body=%s", created.Code, created.Body.String())
	}
	var connector struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &connector); err != nil || connector.Token == "" {
		t.Fatalf("connector payload: %s", created.Body.String())
	}
	event := request("", http.MethodPost, "/api/recognition_events.php?action=submit", `{"event_id":"evt-test-1","type":"activity.attended","subject":{"type":"vnfmap_user","id":2},"data":{}}`)
	// This request intentionally has no Authorization header; verify the
	// endpoint does not accidentally accept a browser session in its place.
	if event.Code != http.StatusUnauthorized || !strings.Contains(event.Body.String(), "未提供 API Token") {
		t.Fatalf("unauthenticated event status=%d body=%s", event.Code, event.Body.String())
	}
	req := httptest.NewRequest(http.MethodPost, "http://test/api/recognition_events.php?action=submit", strings.NewReader(`{"event_id":"evt-test-1","type":"activity.attended","subject":{"type":"vnfmap_user","id":2},"data":{}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+connector.Token)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"event_id":"evt-test-1"`) {
		t.Fatalf("event submit status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}
