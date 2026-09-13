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

func TestAnalyticsTrackSummaryAndPrivacyRules(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{Root: root, SiteURL: "http://test", DBDriver: "sqlite", DBPath: filepath.Join(root, "test.db"), DataDir: root, UploadDir: root, SessionLifetime: 3600, AnalyticsHashKey: "test-only-analytics-key"}
	db, err := sqlstore.Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, nickname TEXT, avatar_url TEXT, role TEXT NOT NULL, status TEXT NOT NULL, email TEXT, email_verified_at TEXT, password_hash TEXT, qq_openid TEXT, discord_id TEXT, is_audit INTEGER DEFAULT 0, profile_bio TEXT, membership_application_email_enabled INTEGER DEFAULT 1, display_membership_id INTEGER, language_preference TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, ip_address TEXT, user_agent TEXT, expires_at TEXT NOT NULL, is_valid INTEGER NOT NULL DEFAULT 1)`); err != nil {
		t.Fatal(err)
	}
	if err := sqlstore.Apply(context.Background(), db, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO users(id,username,nickname,role,status) VALUES (1,'admin','管理员','super_admin','active')`); err != nil {
		t.Fatal(err)
	}
	sessionStore := sessionstore.New(db)
	uid := int64(1)
	if err := sessionStore.Save(context.Background(), &sessionstore.Session{ID: "analytics-admin", UserID: &uid, Payload: map[string]any{"user_id": 1}, ExpiresAt: time.Now().Add(time.Hour), Valid: true}); err != nil {
		t.Fatal(err)
	}
	server, err := New(cfg, db, filestore.New(root, root), &sessionstore.Manager{Store: sessionStore, CookieName: "PHPSESSID"})
	if err != nil {
		t.Fatal(err)
	}
	request := func(sessionID, method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://test"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if sessionID != "" {
			req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sessionID})
		}
		res := httptest.NewRecorder()
		server.ServeHTTP(res, req)
		return res
	}

	event := `{"event_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","visitor_id":"11111111-1111-4111-8111-111111111111","page_path":"/index.html?secret=removed","page_title":"首页","source_category":"direct","device_type":"desktop","browser_name":"chrome"}`
	tracked := request("", http.MethodPost, "/api/analytics.php?action=track", event)
	if tracked.Code != http.StatusNoContent {
		t.Fatalf("track status=%d body=%s", tracked.Code, tracked.Body.String())
	}
	duplicate := request("", http.MethodPost, "/api/analytics.php?action=track", event)
	if duplicate.Code != http.StatusNoContent {
		t.Fatalf("duplicate track status=%d", duplicate.Code)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM analytics_pageviews`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("duplicate event count=%d", count)
	}
	invalidPath := request("", http.MethodPost, "/api/analytics.php?action=track", strings.Replace(event, "/index.html?secret=removed", "/api/auth.php", 1))
	if invalidPath.Code != http.StatusNoContent {
		t.Fatalf("invalid path status=%d", invalidPath.Code)
	}
	date := time.Now().In(analyticsLocation).Format("2006-01-02")
	summary := request("analytics-admin", http.MethodGet, "/api/analytics.php?action=summary&from="+date+"&to="+date, "")
	if summary.Code != http.StatusOK {
		t.Fatalf("summary status=%d body=%s", summary.Code, summary.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(summary.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	selected, ok := payload["selected"].(map[string]any)
	if !ok || integerValue(selected["pv"]) != 1 || integerValue(selected["uv"]) != 1 {
		t.Fatalf("summary selected=%#v", payload["selected"])
	}
	export := request("analytics-admin", http.MethodGet, "/api/analytics.php?action=export&dataset=pages&format=csv&from="+date+"&to="+date, "")
	if export.Code != http.StatusOK || !strings.Contains(export.Header().Get("Content-Type"), "text/csv") || !strings.Contains(export.Body.String(), "/index.html") {
		t.Fatalf("export status=%d content-type=%s body=%s", export.Code, export.Header().Get("Content-Type"), export.Body.String())
	}
}

func TestAnalyticsNormalization(t *testing.T) {
	if got := analyticsNormalizePath("/index.html?token=secret#part"); got != "/index.html" {
		t.Fatalf("path=%q", got)
	}
	if got := analyticsNormalizePath("/api/auth.php"); got != "" {
		t.Fatalf("private path=%q", got)
	}
	if got := analyticsNormalizeHost("WWW.Example.COM."); got != "www.example.com" {
		t.Fatalf("host=%q", got)
	}
	if got := analyticsDevice("phone"); got != "unknown" {
		t.Fatalf("device=%q", got)
	}
	if got := analyticsBrowser("opera"); got != "other" {
		t.Fatalf("browser=%q", got)
	}
}
