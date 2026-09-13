package httpapi

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/filestore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sessionstore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
	"golang.org/x/crypto/bcrypt"
)

func TestCompatibilityEndpoints(t *testing.T) {
	cfg := config.Config{Root: t.TempDir(), SiteURL: "http://test", DBDriver: "sqlite", DataDir: t.TempDir(), UploadDir: t.TempDir()}
	server, err := New(cfg, nil, filestore.New(cfg.DataDir, cfg.UploadDir), nil)
	if err != nil {
		t.Fatal(err)
	}
	checks := []struct {
		path string
		code int
	}{
		{"/api/test.php", http.StatusOK},
		{"/Forum/api/forum.php", http.StatusGone},
		{"/api/clubs.php?action=list", http.StatusOK},
	}
	for _, check := range checks {
		recorder := httptest.NewRecorder()
		server.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, check.path, nil))
		if recorder.Code != check.code {
			t.Errorf("%s: got %d, want %d", check.path, recorder.Code, check.code)
		}
	}
}

func TestStaticPHPSourceIsNotServed(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "secret.php"), []byte("<?php echo 'secret';"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{Root: root, SiteURL: "http://test", DBDriver: "sqlite", DataDir: root, UploadDir: root}
	server, err := New(cfg, nil, filestore.New(cfg.DataDir, cfg.UploadDir), nil)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/secret.php", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("PHP source was served with status %d", recorder.Code)
	}
}

func TestStaticMountedVolumesServeExistingImages(t *testing.T) {
	root, dataRoot, uploadRoot, wikiUploadRoot := t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir()
	checks := []struct {
		root, requestPath, body string
	}{
		{uploadRoot, "galonly/2/review.jpg", "galonly-image"},
		{uploadRoot, "posts/2026/09/post.png", "post-image"},
		{dataRoot, "avatars/user.png", "avatar-image"},
		{wikiUploadRoot, "club/article.png", "wiki-image"},
	}
	for _, check := range checks {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(check.root, check.requestPath)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(check.root, check.requestPath), []byte(check.body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	cfg := config.Config{Root: root, SiteURL: "http://test", DBDriver: "sqlite", DataDir: dataRoot, UploadDir: uploadRoot, WikiUploadDir: wikiUploadRoot}
	server, err := New(cfg, nil, filestore.New(dataRoot, uploadRoot), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, check := range []struct {
		path, want string
	}{
		{"/uploads/galonly/2/review.jpg", "galonly-image"},
		{"/uploads/posts/2026/09/post.png", "post-image"},
		{"/data/avatars/user.png", "avatar-image"},
		{"/wiki/uploads/club/article.png", "wiki-image"},
	} {
		recorder := httptest.NewRecorder()
		server.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, check.path, nil))
		if recorder.Code != http.StatusOK || recorder.Body.String() != check.want {
			t.Fatalf("%s: status=%d body=%q", check.path, recorder.Code, recorder.Body.String())
		}
	}
}

func TestUploadRequiresSession(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{Root: root, SiteURL: "http://test", DBDriver: "sqlite", DataDir: root, UploadDir: root}
	server, err := New(cfg, nil, filestore.New(root, root), nil)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/avatar.php?action=upload", strings.NewReader("")))
	if recorder.Code != http.StatusUnauthorized || !strings.Contains(recorder.Body.String(), "请先登录") {
		t.Fatalf("unauthenticated upload: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestUserBoardUsesBridgedPHPSESSID(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{Root: root, SiteURL: "http://test", DBDriver: "sqlite", DBPath: filepath.Join(root, "test.db"), DataDir: root, UploadDir: root}
	db, err := sqlstore.Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, query := range []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, nickname TEXT, avatar_url TEXT, role TEXT NOT NULL, status TEXT NOT NULL, email TEXT, email_verified_at TEXT, password_hash TEXT, qq_openid TEXT, discord_id TEXT, is_audit INTEGER DEFAULT 0, profile_bio TEXT, membership_application_email_enabled INTEGER DEFAULT 1, display_membership_id INTEGER, language_preference TEXT)`,
		`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, ip_address TEXT, user_agent TEXT, expires_at DATETIME NOT NULL, is_valid INTEGER NOT NULL DEFAULT 1)`,
		`CREATE TABLE galgame_resumes (user_id INTEGER PRIMARY KEY, payload TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)`,
		`CREATE TABLE galgame_memes (user_id INTEGER PRIMARY KEY, payload TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)`,
		`CREATE TABLE galgame_tiers (user_id INTEGER PRIMARY KEY, payload TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)`,
		`CREATE TABLE club_memberships (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, club_id INTEGER NOT NULL, country TEXT, role TEXT, status TEXT)`,
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO users(id, username, nickname, avatar_url, role, status, email, password_hash) VALUES (1, 'tester', '测试者', '', 'member', 'active', 'tester@example.com', '')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO sessions(id, user_id, expires_at, is_valid) VALUES (?, 1, ?, 1)`, strings.Repeat("b", 32), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE vnfest_session_bridge (session_id TEXT PRIMARY KEY, user_id INTEGER, payload_json TEXT NOT NULL, expires_at DATETIME NOT NULL, is_valid INTEGER NOT NULL DEFAULT 1, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO vnfest_session_bridge(session_id, user_id, payload_json, expires_at, is_valid, created_at, updated_at) VALUES (?, 1, ?, ?, 1, ?, ?)`, strings.Repeat("b", 32), `{"user_id":1}`, time.Now().Add(time.Hour), time.Now(), time.Now()); err != nil {
		t.Fatal(err)
	}
	manager := &sessionstore.Manager{Store: sessionstore.New(db), CookieName: "PHPSESSID", Lifetime: 7 * 24 * time.Hour}
	server, err := New(cfg, db, filestore.New(root, root), manager)
	if err != nil {
		t.Fatal(err)
	}

	load := httptest.NewRequest(http.MethodGet, "http://test/api/galgame_resume.php?action=load", nil)
	load.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: strings.Repeat("b", 32)})
	loadRecorder := httptest.NewRecorder()
	server.ServeHTTP(loadRecorder, load)
	if loadRecorder.Code != http.StatusOK || !strings.Contains(loadRecorder.Body.String(), `"resume":null`) {
		t.Fatalf("bridged load failed: status=%d body=%s", loadRecorder.Code, loadRecorder.Body.String())
	}

	save := httptest.NewRequest(http.MethodPost, "http://test/api/galgame_resume.php?action=save", strings.NewReader(`{"resume":{"profile":{"name":"中文用户"}}}`))
	save.Header.Set("Content-Type", "application/json")
	save.Header.Set("Origin", "http://test")
	save.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: strings.Repeat("b", 32)})
	saveRecorder := httptest.NewRecorder()
	server.ServeHTTP(saveRecorder, save)
	if saveRecorder.Code != http.StatusOK || !strings.Contains(saveRecorder.Body.String(), `"saved":true`) {
		t.Fatalf("board save failed: status=%d body=%s", saveRecorder.Code, saveRecorder.Body.String())
	}
}

// TestSQLiteAuthPostsAndMessagesChain exercises the smallest useful end-to-end
// migration slice. It proves that the same PHPSESSID issued by the Go login
// handler is readable by the bridge-backed middleware and can authorize the
// write paths for posts, follows, and direct messages.
func TestSQLiteAuthPostsAndMessagesChain(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{
		Root:            root,
		SiteURL:         "http://test",
		DBDriver:        "sqlite",
		DBPath:          filepath.Join(root, "vnfest.db"),
		DataDir:         root,
		UploadDir:       root,
		SessionLifetime: int((7 * 24 * time.Hour).Seconds()),
	}
	db, err := sqlstore.Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// This is the application baseline supplied by the existing PHP schema;
	// Go migrations must only add compatibility metadata and new indexes/tables.
	if _, err := db.Exec(`CREATE TABLE users (
		id INTEGER PRIMARY KEY,
		username TEXT NOT NULL UNIQUE,
		nickname TEXT,
		avatar_url TEXT,
		role TEXT NOT NULL DEFAULT 'visitor',
		status TEXT NOT NULL DEFAULT 'active',
		email TEXT,
		email_verified_at TEXT,
		password_hash TEXT,
		qq_openid TEXT,
		discord_id TEXT,
		is_audit INTEGER NOT NULL DEFAULT 0,
		profile_bio TEXT,
		membership_application_email_enabled INTEGER NOT NULL DEFAULT 1,
		display_membership_id INTEGER,
		language_preference TEXT,
		credentials_completed_at TEXT,
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		last_login_at TEXT
	)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE sessions (
		id TEXT PRIMARY KEY,
		user_id INTEGER NOT NULL,
		ip_address TEXT,
		user_agent TEXT,
		expires_at DATETIME NOT NULL,
		is_valid INTEGER NOT NULL DEFAULT 1
	)`); err != nil {
		t.Fatal(err)
	}
	if err := sqlstore.Apply(context.Background(), db, nil); err != nil {
		t.Fatal(err)
	}
	if err := sqlstore.Verify(context.Background(), db); err != nil {
		t.Fatal(err)
	}

	hash, err := bcrypt.GenerateFromPassword([]byte("correct horse battery staple"), 4)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		id       int
		username string
		nickname string
	}{
		{1, "alice", "Alice"},
		{2, "bob", "Bob"},
	} {
		if _, err := db.Exec(`INSERT INTO users(id,username,nickname,avatar_url,role,status,email,password_hash)
			VALUES(?,?,?,?,?,?,?,?)`, row.id, row.username, row.nickname, "", "visitor", "active", row.username+"@example.com", string(hash)); err != nil {
			t.Fatal(err)
		}
	}

	manager := &sessionstore.Manager{Store: sessionstore.New(db), CookieName: "PHPSESSID", Lifetime: 7 * 24 * time.Hour}
	server, err := New(cfg, db, filestore.New(root, root), manager)
	if err != nil {
		t.Fatal(err)
	}

	login := func(username string) *http.Cookie {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "http://test/api/auth.php?action=login_local", strings.NewReader(`{"username":"`+username+`","password":"correct horse battery staple"}`))
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		server.ServeHTTP(res, req)
		if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"success":true`) {
			t.Fatalf("login %s: status=%d body=%s", username, res.Code, res.Body.String())
		}
		for _, cookie := range res.Result().Cookies() {
			if cookie.Name == "PHPSESSID" && cookie.Value != "" {
				return cookie
			}
		}
		t.Fatalf("login %s did not issue PHPSESSID", username)
		return nil
	}
	aliceCookie := login("alice")
	bobCookie := login("bob")

	var bridgeUser int
	var legacyUser int
	if err := db.QueryRow(`SELECT user_id FROM vnfest_session_bridge WHERE session_id=?`, aliceCookie.Value).Scan(&bridgeUser); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT user_id FROM sessions WHERE id=?`, aliceCookie.Value).Scan(&legacyUser); err != nil {
		t.Fatal(err)
	}
	if bridgeUser != 1 || legacyUser != 1 {
		t.Fatalf("session bridge mismatch: bridge=%d legacy=%d", bridgeUser, legacyUser)
	}

	request := func(method, target string, body string, cookie *http.Cookie, origin bool) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, "http://test"+target, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if origin {
			req.Header.Set("Origin", "http://test")
		}
		req.AddCookie(cookie)
		res := httptest.NewRecorder()
		server.ServeHTTP(res, req)
		return res
	}

	created := request(http.MethodPost, "/api/posts.php?action=create", `{"content":"hello from Go"}`, aliceCookie, true)
	if created.Code != http.StatusOK || !strings.Contains(created.Body.String(), "hello from Go") {
		t.Fatalf("post create: status=%d body=%s", created.Code, created.Body.String())
	}
	var postID int64
	if err := db.QueryRow(`SELECT id FROM posts WHERE author_id=1 ORDER BY id DESC LIMIT 1`).Scan(&postID); err != nil {
		t.Fatal(err)
	}
	feed := request(http.MethodGet, "/api/posts.php?action=feed", "", aliceCookie, false)
	if feed.Code != http.StatusOK || !strings.Contains(feed.Body.String(), "hello from Go") {
		t.Fatalf("post feed: status=%d body=%s", feed.Code, feed.Body.String())
	}
	liked := request(http.MethodPost, "/api/posts.php?action=like", `{"id":`+strconv.FormatInt(postID, 10)+`}`, aliceCookie, true)
	if liked.Code != http.StatusOK || !strings.Contains(liked.Body.String(), `"liked":true`) {
		t.Fatalf("post like: status=%d body=%s", liked.Code, liked.Body.String())
	}

	for _, pair := range []struct {
		cookie *http.Cookie
		id     int
	}{
		{aliceCookie, 2},
		{bobCookie, 1},
	} {
		follow := request(http.MethodPost, "/api/posts.php?action=follow", `{"id":`+strconv.Itoa(pair.id)+`}`, pair.cookie, true)
		if follow.Code != http.StatusOK || !strings.Contains(follow.Body.String(), `"following":true`) {
			t.Fatalf("follow %d: status=%d body=%s", pair.id, follow.Code, follow.Body.String())
		}
	}

	sent := request(http.MethodPost, "/api/messages.php?action=send", `{"to_user_id":2,"content":"hello privately"}`, aliceCookie, true)
	if sent.Code != http.StatusOK || !strings.Contains(sent.Body.String(), "hello privately") {
		t.Fatalf("message send: status=%d body=%s", sent.Code, sent.Body.String())
	}
	thread := request(http.MethodGet, "/api/messages.php?action=thread&user_id=1", "", bobCookie, false)
	if thread.Code != http.StatusOK || !strings.Contains(thread.Body.String(), "hello privately") {
		t.Fatalf("message thread: status=%d body=%s", thread.Code, thread.Body.String())
	}

	// Uploads use the same PHP-visible storage roots and session as the JSON
	// APIs. The PNG is a real 1x1 image, so this also exercises MIME sniffing.
	multipartRequest := func(target, field, filename string, data []byte, fields map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		part, err := writer.CreateFormFile(field, filename)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(data); err != nil {
			t.Fatal(err)
		}
		for key, value := range fields {
			if err := writer.WriteField(key, value); err != nil {
				t.Fatal(err)
			}
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "http://test"+target, &body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		req.Header.Set("Origin", "http://test")
		req.AddCookie(aliceCookie)
		res := httptest.NewRecorder()
		server.ServeHTTP(res, req)
		return res
	}
	png1x1 := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 'I', 'H', 'D', 'R', 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 'I', 'D', 'A', 'T', 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 'I', 'E', 'N', 'D', 0xae, 0x42, 0x60, 0x82}
	attachment := multipartRequest("/api/post_images.php?action=upload", "image", "one.png", png1x1, map[string]string{"upload_token": "post-test-01"})
	if attachment.Code != http.StatusOK || !strings.Contains(attachment.Body.String(), `"relative_path"`) {
		t.Fatalf("post image upload: status=%d body=%s", attachment.Code, attachment.Body.String())
	}
	banner := multipartRequest("/api/user_banner.php?action=upload", "image", "one.png", png1x1, nil)
	if banner.Code != http.StatusOK || !strings.Contains(banner.Body.String(), "/uploads/banners/") {
		t.Fatalf("banner upload: status=%d body=%s", banner.Code, banner.Body.String())
	}
	project := multipartRequest("/api/project_files.php", "file", "notes.txt", []byte("project file"), map[string]string{"project_id": "7"})
	if project.Code != http.StatusOK || !strings.Contains(project.Body.String(), "uploads/project_files/7/") {
		t.Fatalf("project file upload: status=%d body=%s", project.Code, project.Body.String())
	}
}
