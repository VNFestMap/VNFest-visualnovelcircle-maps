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
	"golang.org/x/crypto/bcrypt"
)

func multiDeviceFixture(t *testing.T, role string) *Server {
	t.Helper()
	root := t.TempDir()
	cfg := config.Config{Root: root, SiteURL: "http://test", DBDriver: "sqlite", DBPath: filepath.Join(root, "auth.db"), DataDir: root, UploadDir: root, SessionLifetime: 3600, SessionSecret: "isolated-test-secret"}
	db, err := sqlstore.Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	for _, query := range []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, nickname TEXT, avatar_url TEXT, role TEXT NOT NULL, status TEXT NOT NULL, email TEXT, email_verified_at TEXT, password_hash TEXT, qq_openid TEXT, discord_id TEXT, is_audit INTEGER DEFAULT 0, profile_bio TEXT, membership_application_email_enabled INTEGER DEFAULT 1, display_membership_id INTEGER, language_preference TEXT, credentials_completed_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, last_login_at TEXT)`,
		`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, ip_address TEXT, user_agent TEXT, expires_at DATETIME NOT NULL, is_valid INTEGER NOT NULL DEFAULT 1)`,
		`CREATE TABLE club_memberships (id INTEGER PRIMARY KEY, user_id INTEGER, club_id INTEGER, country TEXT, role TEXT, status TEXT)`,
		`CREATE TABLE galgame_resumes (user_id INTEGER PRIMARY KEY, payload TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at DATETIME, updated_at DATETIME)`,
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	if err := sqlstore.Apply(context.Background(), db, nil); err != nil {
		t.Fatal(err)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte("multi-device-password"), 4)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO users(id,username,role,status,email,password_hash) VALUES (1,'reader',?,'active','reader@example.com',?)", role, string(hash)); err != nil {
		t.Fatal(err)
	}
	s, err := New(cfg, db, filestore.New(root, root), &sessionstore.Manager{Store: sessionstore.New(db), CookieName: "PHPSESSID", Lifetime: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func multiRequest(s *Server, action, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	method := http.MethodPost
	if body == "" {
		method = http.MethodGet
	}
	req := httptest.NewRequest(method, "http://test/api/auth.php?action="+action, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://test")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	res := httptest.NewRecorder()
	s.ServeHTTP(res, req)
	return res
}

func multiCookie(t *testing.T, res *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, cookie := range res.Result().Cookies() {
		if cookie.Name == "PHPSESSID" && cookie.Value != "" {
			return cookie
		}
	}
	t.Fatalf("no login cookie: %d %s", res.Code, res.Body.String())
	return nil
}

func multiAssertAccess(t *testing.T, s *Server, cookie *http.Cookie, valid bool) {
	t.Helper()
	res := multiRequest(s, "me", "", cookie)
	var result struct {
		LoggedIn bool `json:"logged_in"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &result); err != nil || result.LoggedIn != valid {
		t.Fatalf("session access want=%v: %d %s", valid, res.Code, res.Body.String())
	}
	if valid {
		req := httptest.NewRequest(http.MethodGet, "http://test/api/galgame_resume.php?action=load", nil)
		req.AddCookie(cookie)
		board := httptest.NewRecorder()
		s.ServeHTTP(board, req)
		if board.Code != http.StatusOK || !strings.Contains(board.Body.String(), `"success":true`) {
			t.Fatalf("protected access: %d %s", board.Code, board.Body.String())
		}
	}
}

func TestMultiDevicePasswordLoginAndLogout(t *testing.T) {
	for _, role := range []string{"member", "super_admin"} {
		t.Run(role, func(t *testing.T) {
			s := multiDeviceFixture(t, role)
			payload := `{"username":"reader","password":"multi-device-password"}`
			var cookies []*http.Cookie
			for i := 0; i < 3; i++ {
				cookies = append(cookies, multiCookie(t, multiRequest(s, "login_local", payload, nil)))
			}
			for _, cookie := range cookies {
				multiAssertAccess(t, s, cookie, true)
			}
			failed := multiRequest(s, "login_local", `{"username":"reader","password":"incorrect"}`, cookies[0])
			if strings.Contains(failed.Body.String(), `"success":true`) || len(failed.Result().Cookies()) != 0 {
				t.Fatal("failed login changed session")
			}
			for _, cookie := range cookies {
				multiAssertAccess(t, s, cookie, true)
			}
			newCookie := multiCookie(t, multiRequest(s, "login_local", payload, cookies[0]))
			if newCookie.Value == cookies[0].Value {
				t.Fatal("login did not rotate")
			}
			multiAssertAccess(t, s, cookies[0], false)
			multiAssertAccess(t, s, newCookie, true)
			if res := multiRequest(s, "logout", "", newCookie); !strings.Contains(res.Body.String(), `"success":true`) {
				t.Fatal(res.Body.String())
			}
			multiAssertAccess(t, s, newCookie, false)
			for _, cookie := range cookies[1:] {
				multiAssertAccess(t, s, cookie, true)
			}
		})
	}
}

func TestMultiDeviceOAuthLinkAndCompletion(t *testing.T) {
	for _, provider := range []string{"qq", "discord"} {
		t.Run(provider, func(t *testing.T) {
			s := multiDeviceFixture(t, "member")
			passwordCookie := multiCookie(t, multiRequest(s, "login_local", `{"username":"reader","password":"multi-device-password"}`, nil))
			pending := &sessionstore.Session{ID: "pending-" + provider, Valid: true, ExpiresAt: time.Now().Add(time.Hour), Payload: map[string]any{"oauth_pending": map[string]any{"provider": provider, "subject": "isolated-subject", "email": "reader@example.com", "verified": true, "return_to": "index.html"}}}
			if err := s.sessions.Store.Save(context.Background(), pending); err != nil {
				t.Fatal(err)
			}
			linked := multiRequest(s, "oauth_link_existing", `{"email":"reader@example.com"}`, &http.Cookie{Name: "PHPSESSID", Value: pending.ID})
			if linked.Code != http.StatusOK || !strings.Contains(linked.Body.String(), `"success":true`) {
				t.Fatal(linked.Body.String())
			}
			oauthCookie := multiCookie(t, linked)
			multiAssertAccess(t, s, passwordCookie, true)
			multiAssertAccess(t, s, oauthCookie, true)
			req := httptest.NewRequest(http.MethodGet, "http://test/api/auth.php?action="+provider+"_callback", nil)
			res := httptest.NewRecorder()
			if err := s.loginExistingOAuth(context.Background(), res, req, 1); err != nil {
				t.Fatal(err)
			}
			multiAssertAccess(t, s, multiCookie(t, res), true)
			multiAssertAccess(t, s, passwordCookie, true)
			multiAssertAccess(t, s, oauthCookie, true)
		})
	}
}

func TestMultiDeviceResetAndDeactivation(t *testing.T) {
	s := multiDeviceFixture(t, "member")
	payload := `{"username":"reader","password":"multi-device-password"}`
	a := multiCookie(t, multiRequest(s, "login_local", payload, nil))
	b := multiCookie(t, multiRequest(s, "login_local", payload, nil))
	rows := []authCodeRow{{UserID: 1, Email: "reader@example.com", Code: "123456", ExpiresAt: time.Now().Add(time.Minute).Unix()}}
	if err := s.files.WriteJSONAtomic(context.Background(), "password_reset_codes.json", rows); err != nil {
		t.Fatal(err)
	}
	reset := multiRequest(s, "reset_password", `{"email":"reader@example.com","code":"123456","new_password":"new-device-password"}`, nil)
	if !strings.Contains(reset.Body.String(), `"success":true`) {
		t.Fatal(reset.Body.String())
	}
	multiAssertAccess(t, s, a, false)
	multiAssertAccess(t, s, b, false)
	payload = `{"username":"reader","password":"new-device-password"}`
	a = multiCookie(t, multiRequest(s, "login_local", payload, nil))
	b = multiCookie(t, multiRequest(s, "login_local", payload, nil))
	if _, err := s.db.Exec("INSERT INTO users(id,username,role,status,email,password_hash) SELECT 2,'operator','super_admin','active','operator@example.com',password_hash FROM users WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	admin := multiCookie(t, multiRequest(s, "login_local", `{"username":"operator","password":"new-device-password"}`, nil))
	req := httptest.NewRequest(http.MethodPost, "http://test/api/users.php?action=delete", strings.NewReader(`{"id":1}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://test")
	req.AddCookie(admin)
	ban := httptest.NewRecorder()
	s.ServeHTTP(ban, req)
	if ban.Code != http.StatusOK || !strings.Contains(ban.Body.String(), `"success":true`) {
		t.Fatalf("deactivate: %d %s", ban.Code, ban.Body.String())
	}
	multiAssertAccess(t, s, a, false)
	multiAssertAccess(t, s, b, false)
}

func TestMultiDeviceFailedWriteDoesNotSetCookie(t *testing.T) {
	for _, table := range []string{"sessions", "vnfest_session_bridge"} {
		t.Run(table, func(t *testing.T) {
			s := multiDeviceFixture(t, "member")
			payload := `{"username":"reader","password":"multi-device-password"}`
			a := multiCookie(t, multiRequest(s, "login_local", payload, nil))
			b := multiCookie(t, multiRequest(s, "login_local", payload, nil))
			if _, err := s.db.Exec("CREATE TRIGGER fail_login BEFORE INSERT ON " + table + " BEGIN SELECT RAISE(ABORT, 'injected failure'); END"); err != nil {
				t.Fatal(err)
			}
			failed := multiRequest(s, "login_local", payload, a)
			if failed.Code != http.StatusInternalServerError || len(failed.Result().Cookies()) != 0 {
				t.Fatalf("failed write published a cookie: %d %s", failed.Code, failed.Body.String())
			}
			multiAssertAccess(t, s, a, true)
			multiAssertAccess(t, s, b, true)
		})
	}
}
