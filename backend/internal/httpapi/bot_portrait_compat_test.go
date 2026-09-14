package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
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

func TestBotPortraitAndPublicationMigrationCompatibility(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{Root: root, SiteURL: "http://test", DBDriver: "sqlite", DBPath: filepath.Join(root, "compat.db"), DataDir: root, UploadDir: root, SessionLifetime: 3600, BotAPIKey: "bot-secret", LegacyAuthEnabled: false}
	db, err := sqlstore.Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, nickname TEXT, avatar_url TEXT, role TEXT NOT NULL, status TEXT NOT NULL, email TEXT, email_verified_at TEXT, password_hash TEXT, qq_openid TEXT, discord_id TEXT, is_audit INTEGER DEFAULT 0, profile_bio TEXT, membership_application_email_enabled INTEGER DEFAULT 1, display_membership_id INTEGER, language_preference TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, ip_address TEXT, user_agent TEXT, expires_at TEXT NOT NULL, is_valid INTEGER NOT NULL DEFAULT 1)`,
		`CREATE TABLE club_memberships (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, club_id INTEGER NOT NULL, country TEXT NOT NULL DEFAULT 'china', role TEXT NOT NULL, status TEXT NOT NULL, joined_at TEXT)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := sqlstore.Apply(context.Background(), db, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO users(id,username,nickname,role,status) VALUES(1,'admin','管理员','super_admin','active')`); err != nil {
		t.Fatal(err)
	}
	if err := db.Ping(); err != nil {
		t.Fatal(err)
	}
	files := filestore.New(root, root)
	for name, document := range map[string]any{
		"clubs.json":         map[string]any{"data": []any{map[string]any{"id": 7, "name": "测试社团", "display_name": "测试社团", "province": "上海", "info": "hidden", "visible_by_default": false}}},
		"clubs_japan.json":   map[string]any{"data": []any{}},
		"projects.json":      map[string]any{"projects": []any{}, "migrated_at": nil},
		"project_items.json": map[string]any{"items": []any{}},
		"publications.json":  map[string]any{"publications": []any{map[string]any{"id": 9, "club_ids": []any{map[string]any{"id": 7, "country": "china"}}, "publicationName": "兼容刊物", "status": "writing", "clubName": "测试社团", "submitContact": "contact", "submitLink": "", "description": "desc", "deadline": "2026-12-01"}}},
	} {
		if err := files.WriteJSONAtomic(context.Background(), name, document); err != nil {
			t.Fatal(err)
		}
	}
	sessions := sessionstore.New(db)
	uid := int64(1)
	if err := sessions.Save(context.Background(), &sessionstore.Session{ID: "compat-admin", UserID: &uid, Payload: map[string]any{"user_id": uid}, ExpiresAt: time.Now().Add(time.Hour), Valid: true}); err != nil {
		t.Fatal(err)
	}
	server, err := New(cfg, db, files, &sessionstore.Manager{Store: sessions, CookieName: "PHPSESSID"})
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, endpoint, body string, session string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://test"+endpoint, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://test")
		if session != "" {
			req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: session})
		}
		res := httptest.NewRecorder()
		server.ServeHTTP(res, req)
		return res
	}
	clubs := request(http.MethodGet, "/api/bot.php?action=clubs&token=bot-secret", "", "")
	if clubs.Code != http.StatusOK || !strings.Contains(clubs.Body.String(), "测试社团") || !strings.Contains(clubs.Body.String(), `"contact_hidden":true`) {
		t.Fatalf("bot clubs status=%d body=%s", clubs.Code, clubs.Body.String())
	}
	if got := request(http.MethodPost, "/api/bot.php?action=clubs&token=bot-secret", "{}", ""); got.Code != http.StatusMethodNotAllowed {
		t.Fatalf("bot GET-only status=%d body=%s", got.Code, got.Body.String())
	}
	tokenResponse := request(http.MethodPost, "/api/bot.php?action=bot_tokens_create", `{"club_id":7,"name":"test","approve_membership":true}`, "compat-admin")
	if tokenResponse.Code != http.StatusOK || !strings.Contains(tokenResponse.Body.String(), `"token":"gmap_club_`) {
		t.Fatalf("bot token create status=%d body=%s", tokenResponse.Code, tokenResponse.Body.String())
	}
	var tokenPayload struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(tokenResponse.Body.Bytes(), &tokenPayload); err != nil || tokenPayload.Token == "" {
		t.Fatalf("bot token payload=%s", tokenResponse.Body.String())
	}
	listedTokens := request(http.MethodGet, "/api/bot.php?action=bot_tokens_list&club_id=7", "", "compat-admin")
	if listedTokens.Code != http.StatusOK || !strings.Contains(listedTokens.Body.String(), `"active":true`) {
		t.Fatalf("new bot token should remain active: status=%d body=%s", listedTokens.Code, listedTokens.Body.String())
	}
	clubActivity := request(http.MethodGet, "/api/bot.php?action=club_activity&token="+tokenPayload.Token, "", "")
	if clubActivity.Code != http.StatusOK || !strings.Contains(clubActivity.Body.String(), "测试社团") {
		t.Fatalf("club bot activity status=%d body=%s", clubActivity.Code, clubActivity.Body.String())
	}
	full := request(http.MethodGet, "/api/bot.php?action=clubs&token="+tokenPayload.Token+"&full=1", "", "")
	if full.Code != http.StatusForbidden {
		t.Fatalf("club bot full status=%d body=%s", full.Code, full.Body.String())
	}
	migrated := request(http.MethodGet, "/api/migrate_publications.php", "", "compat-admin")
	if migrated.Code != http.StatusOK || !strings.Contains(migrated.Body.String(), `"projects_migrated":1`) {
		t.Fatalf("publication migration status=%d body=%s", migrated.Code, migrated.Body.String())
	}
	repeat := request(http.MethodPost, "/api/migrate_publications.php", "", "compat-admin")
	if repeat.Code != http.StatusOK || !strings.Contains(repeat.Body.String(), "无需重复执行") {
		t.Fatalf("publication migration repeat status=%d body=%s", repeat.Code, repeat.Body.String())
	}

	portrait := request(http.MethodPost, "/club-operation-portrait/api/index.php?action=analyze", `{"basic_info":{},"dimensions":{},"base_scores":{}}`, "")
	if portrait.Code != http.StatusOK || !strings.Contains(portrait.Body.String(), `"llm_error":true`) {
		t.Fatalf("portrait fallback status=%d body=%s", portrait.Code, portrait.Body.String())
	}
	portraitOptions := request(http.MethodOptions, "/club-operation-portrait/api/index.php?action=analyze", "", "")
	if portraitOptions.Code != http.StatusNoContent {
		t.Fatalf("portrait options status=%d", portraitOptions.Code)
	}

	var multipartBody bytes.Buffer
	writer := multipart.NewWriter(&multipartBody)
	part, err := writer.CreateFormFile("file", "quiz.json")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte(`{"questions":[{"type":"single","question":"Q","options":["A","B"],"answer":[0]}]}`))
	_ = writer.WriteField("title", "共享题库")
	_ = writer.Close()
	req := httptest.NewRequest(http.MethodPost, "http://test/api/quiz_hub.php?action=shared_upload", &multipartBody)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: "compat-admin"})
	res := httptest.NewRecorder()
	server.ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "答案已剥离") {
		t.Fatalf("quiz upload status=%d body=%s", res.Code, res.Body.String())
	}
}
