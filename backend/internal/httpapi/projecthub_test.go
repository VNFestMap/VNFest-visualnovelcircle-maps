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

func TestProjectHubAndPublicationCompatibility(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{Root: root, SiteURL: "http://test", DBDriver: "sqlite", DBPath: filepath.Join(root, "test.db"), DataDir: root, UploadDir: root, SessionLifetime: 3600}
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
	if _, err := db.Exec(`INSERT INTO users(id,username,nickname,role,status) VALUES(1,'admin','Admin','super_admin','active')`); err != nil {
		t.Fatal(err)
	}
	store := sessionstore.New(db)
	uid := int64(1)
	if err := store.Save(context.Background(), &sessionstore.Session{ID: "project-session", UserID: &uid, Payload: map[string]any{"user_id": 1}, ExpiresAt: time.Now().Add(time.Hour), Valid: true}); err != nil {
		t.Fatal(err)
	}
	manager := &sessionstore.Manager{Store: store, CookieName: "PHPSESSID"}
	server, err := New(cfg, db, filestore.New(root, root), manager)
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://test"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://test")
		req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: "project-session"})
		res := httptest.NewRecorder()
		server.ServeHTTP(res, req)
		return res
	}
	created := request(http.MethodPost, "/api/projects.php", `{"title":"Go project","project_type":"content","club_id":7}`)
	if created.Code != http.StatusOK || !strings.Contains(created.Body.String(), "Go project") {
		t.Fatalf("project create: status=%d body=%s", created.Code, created.Body.String())
	}
	var projectPayload struct {
		Project map[string]any `json:"project"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &projectPayload); err != nil {
		t.Fatal(err)
	}
	projectID := int64Value(projectPayload.Project["id"])
	if projectID <= 0 {
		t.Fatalf("missing project id: %#v", projectPayload.Project)
	}
	updated := request(http.MethodPost, "/api/projects.php", `{"_method":"PUT","id":100000,"summary":"updated"}`)
	if updated.Code != http.StatusOK || !strings.Contains(updated.Body.String(), "updated") {
		t.Fatalf("project override update: status=%d body=%s", updated.Code, updated.Body.String())
	}
	item := request(http.MethodPost, "/api/project_items.php", `{"project_id":100000,"label":"稿件"}`)
	if item.Code != http.StatusOK || !strings.Contains(item.Body.String(), "item_1") {
		t.Fatalf("item create: status=%d body=%s", item.Code, item.Body.String())
	}
	part := request(http.MethodPost, "/api/project_participations.php", `{"project_id":100000,"item_id":"item_1","content":"参与内容"}`)
	if part.Code != http.StatusOK || !strings.Contains(part.Body.String(), "参与内容") {
		t.Fatalf("participation create: status=%d body=%s", part.Code, part.Body.String())
	}
	publication := request(http.MethodPost, "/api/publications.php", `{"clubName":"测试社团","publicationName":"测试刊物","club_id":7}`)
	if publication.Code != http.StatusOK || !strings.Contains(publication.Body.String(), "测试刊物") {
		t.Fatalf("publication create: status=%d body=%s", publication.Code, publication.Body.String())
	}
	public := request(http.MethodGet, "/api/projects.php", "")
	if public.Code != http.StatusOK || !strings.Contains(public.Body.String(), "Go project") {
		t.Fatalf("project list: status=%d body=%s", public.Code, public.Body.String())
	}
}
