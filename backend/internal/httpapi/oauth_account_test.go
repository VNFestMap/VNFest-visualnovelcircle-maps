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

func TestOAuthAccountCompletionWithLoginPagePayload(t *testing.T) {
	for _, provider := range []string{"qq", "discord"} {
		t.Run(provider, func(t *testing.T) {
			root := t.TempDir()
			cfg := config.Config{Root: root, SiteURL: "http://test", DBDriver: "sqlite", DBPath: filepath.Join(root, "oauth.db"), DataDir: root, UploadDir: root, SessionLifetime: 3600, SessionSecret: "test-session-secret"}
			db, err := sqlstore.Open(context.Background(), cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			for _, statement := range []string{
				`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, nickname TEXT, avatar_url TEXT, role TEXT NOT NULL, status TEXT NOT NULL, email TEXT, email_verified_at TEXT, password_hash TEXT, qq_openid TEXT, discord_id TEXT, is_audit INTEGER DEFAULT 0, profile_bio TEXT, membership_application_email_enabled INTEGER DEFAULT 1, display_membership_id INTEGER, language_preference TEXT, credentials_completed_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, last_login_at TEXT)`,
				`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, ip_address TEXT, user_agent TEXT, expires_at TEXT NOT NULL, is_valid INTEGER NOT NULL DEFAULT 1)`,
				`CREATE TABLE club_memberships (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, club_id INTEGER NOT NULL, country TEXT, role TEXT, status TEXT)`,
			} {
				if _, err := db.Exec(statement); err != nil {
					t.Fatal(err)
				}
			}
			if err := sqlstore.Apply(context.Background(), db, nil); err != nil {
				t.Fatal(err)
			}
			store := sessionstore.New(db)
			if err := store.Save(context.Background(), &sessionstore.Session{ID: "oauth-pending", Payload: map[string]any{"oauth_pending": map[string]any{"provider": provider, "subject": "test-provider-subject", "username": "测试用户", "return_to": "index.html", "email": "reader@example.com", "code_hash": oauthCodeHash("oauth-pending", "012345", cfg.SessionSecret), "code_expires_at": time.Now().Add(5 * time.Minute).Unix()}}, ExpiresAt: time.Now().Add(time.Hour), Valid: true}); err != nil {
				t.Fatal(err)
			}
			server, err := New(cfg, db, filestore.New(root, root), &sessionstore.Manager{Store: store, CookieName: "PHPSESSID", Lifetime: time.Hour})
			if err != nil {
				t.Fatal(err)
			}
			request := func(action, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
				req := httptest.NewRequest(http.MethodPost, "http://test/api/auth.php?action="+action, strings.NewReader(body))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", "http://test")
				if cookie != nil {
					req.AddCookie(cookie)
				}
				res := httptest.NewRecorder()
				server.ServeHTTP(res, req)
				return res
			}
			pendingCookie := &http.Cookie{Name: "PHPSESSID", Value: "oauth-pending"}
			payload := `{"email":"reader@example.com","password":"correct-password","password_confirmation":"correct-password"}`
			if res := request("oauth_complete_account", payload, pendingCookie); res.Code != http.StatusUnprocessableEntity || !strings.Contains(res.Body.String(), "OAUTH_EMAIL_VERIFICATION_REQUIRED") {
				t.Fatalf("unverified account: %d %s", res.Code, res.Body.String())
			}
			verifyBody, _ := json.Marshal(map[string]string{"email": "reader@example.com", "code": "012345"})
			if res := request("oauth_verify_code", string(verifyBody), pendingCookie); res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"next":"set_password"`) {
				t.Fatalf("verify code: %d %s", res.Code, res.Body.String())
			}
			for _, invalid := range []string{
				`{"email":"reader@example.com","password":"correct-password","password_confirmation":"different-password"}`,
				`{"email":"reader@example.com","password":"correct-password"}`,
				`{"email":"other@example.com","password":"correct-password","password_confirmation":"correct-password"}`,
				`{"email":"reader@example.com","password":"123","password_confirmation":"123"}`,
				`{invalid-json`,
			} {
				if res := request("oauth_complete_account", invalid, pendingCookie); res.Code != http.StatusUnprocessableEntity {
					t.Fatalf("invalid account accepted: %d %s", res.Code, res.Body.String())
				}
			}
			var count int
			if err := db.QueryRow("SELECT COUNT(*) FROM users").Scan(&count); err != nil || count != 0 {
				t.Fatalf("invalid requests created users: %d %v", count, err)
			}
			res := request("oauth_complete_account", payload, pendingCookie)
			if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"success":true`) {
				t.Fatalf("complete account: %d %s", res.Code, res.Body.String())
			}
			var uid int64
			var email, hash, subject string
			if err := db.QueryRow("SELECT id,email,password_hash,"+providerColumn(provider)+" FROM users").Scan(&uid, &email, &hash, &subject); err != nil {
				t.Fatal(err)
			}
			if email != "reader@example.com" || subject != "test-provider-subject" || bcrypt.CompareHashAndPassword([]byte(hash), []byte("correct-password")) != nil {
				t.Fatal("account credentials/provider were not saved correctly")
			}
			var loginCookie *http.Cookie
			for _, cookie := range res.Result().Cookies() {
				if cookie.Name == "PHPSESSID" {
					loginCookie = cookie
				}
			}
			if loginCookie == nil || loginCookie.Value == pendingCookie.Value {
				t.Fatal("login session was not issued/rotated")
			}
			meReq := httptest.NewRequest(http.MethodGet, "http://test/api/auth.php?action=me", nil)
			meReq.AddCookie(loginCookie)
			me := httptest.NewRecorder()
			server.ServeHTTP(me, meReq)
			if me.Code != http.StatusOK || !strings.Contains(me.Body.String(), `"email":"reader@example.com"`) {
				t.Fatalf("created account is not logged in: %d %s", me.Code, me.Body.String())
			}
			otherLogin := request("login_local", `{"username":"reader@example.com","password":"correct-password"}`, nil)
			if !strings.Contains(otherLogin.Body.String(), `"success":true`) {
				t.Fatal(otherLogin.Body.String())
			}
			me = httptest.NewRecorder()
			server.ServeHTTP(me, meReq)
			if !strings.Contains(me.Body.String(), `"logged_in":true`) {
				t.Fatal("password login invalidated the OAuth completion session")
			}
			if old, err := store.Load(context.Background(), pendingCookie.Value); err != nil || old != nil {
				t.Fatalf("pending session was not retired: %v %v", old, err)
			}
		})
	}
}
