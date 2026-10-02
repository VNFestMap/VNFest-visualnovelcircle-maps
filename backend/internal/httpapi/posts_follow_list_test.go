package httpapi

import (
	"context"
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

func TestPostFollowListUsesTargetAndMatchesFrontendContract(t *testing.T) {
	root := t.TempDir()
	db, err := sqlstore.Open(context.Background(), config.Config{DBDriver: "sqlite", DBPath: filepath.Join(root, "posts-follow-list.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	for _, query := range []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, nickname TEXT, avatar_url TEXT, profile_bio TEXT, role TEXT NOT NULL, status TEXT NOT NULL)`,
		`CREATE TABLE user_follows (id INTEGER PRIMARY KEY AUTOINCREMENT, follower_id INTEGER NOT NULL, following_id INTEGER NOT NULL, created_at TEXT)`,
		`CREATE TABLE club_memberships (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, club_id INTEGER NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL)`,
		`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL, is_valid INTEGER NOT NULL DEFAULT 1)`,
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []struct {
		id       int
		username string
		nickname string
		bio      string
	}{
		{1, "target", "Target", "target bio"},
		{2, "follower", "Follower", "follower bio"},
		{3, "viewer", "Viewer", "viewer bio"},
		{4, "following", "Following", "following bio"},
	} {
		if _, err := db.Exec("INSERT INTO users(id,username,nickname,avatar_url,profile_bio,role,status) VALUES(?,?,?,?,?,?,?)", row.id, row.username, row.nickname, "", row.bio, "member", "active"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec("INSERT INTO club_memberships(user_id,club_id,role,status) VALUES(3,7,'member','active')"); err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]int{{2, 1}, {1, 4}, {3, 2}, {2, 3}} {
		if _, err := db.Exec("INSERT INTO user_follows(follower_id,following_id,created_at) VALUES(?,?,CURRENT_TIMESTAMP)", pair[0], pair[1]); err != nil {
			t.Fatal(err)
		}
	}

	server := &Server{db: db}
	req := httptest.NewRequest(http.MethodGet, "http://test/api/posts.php?action=follow_list", nil)
	followers, err := server.postFollowList(req, 1, 3, "followers")
	if err != nil {
		t.Fatal(err)
	}
	if followers["type"] != "followers" {
		t.Fatalf("followers type=%#v", followers["type"])
	}
	followerUsers := followers["users"].([]map[string]any)
	if len(followerUsers) != 1 || followerUsers[0]["username"] != "follower" {
		t.Fatalf("followers users=%#v", followerUsers)
	}
	if followerUsers[0]["is_following"] != true || followerUsers[0]["is_friend"] != true || followerUsers[0]["bio"] != "follower bio" {
		t.Fatalf("follower metadata=%#v", followerUsers[0])
	}

	following, err := server.postFollowList(req, 1, 3, "following")
	if err != nil {
		t.Fatal(err)
	}
	if following["type"] != "following" {
		t.Fatalf("following type=%#v", following["type"])
	}
	followingUsers := following["users"].([]map[string]any)
	if len(followingUsers) != 1 || followingUsers[0]["username"] != "following" {
		t.Fatalf("following users=%#v", followingUsers)
	}

	if _, err := db.Exec("INSERT INTO sessions(id,user_id,expires_at,is_valid) VALUES(?,?,?,1)", "follow-list-session", 3, time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	sessionManager := &sessionstore.Manager{Store: sessionstore.New(db), CookieName: "PHPSESSID"}
	sessionRequest := httptest.NewRequest(http.MethodGet, "http://test/api/posts.php", nil)
	sessionRequest.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: "follow-list-session"})
	loadedSession, loadErr := sessionManager.LoadRequest(sessionRequest.Context(), sessionRequest)
	if loadErr != nil || loadedSession == nil || loadedSession.UserID == nil || *loadedSession.UserID != 3 {
		t.Fatalf("load test session: session=%#v err=%v", loadedSession, loadErr)
	}
	serverHTTP, err := New(
		config.Config{DBDriver: "sqlite", DBPath: filepath.Join(root, "posts-follow-list.db")},
		db,
		nil,
		sessionManager,
	)
	if err != nil {
		t.Fatal(err)
	}
	routeRequest := httptest.NewRequest(http.MethodGet, "http://test/api/posts.php?action=follow_list&username=target&type=followers", nil)
	routeRequest.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: "follow-list-session"})
	routeResponse := httptest.NewRecorder()
	serverHTTP.ServeHTTP(routeResponse, routeRequest)
	if routeResponse.Code != http.StatusOK || !strings.Contains(routeResponse.Body.String(), `"type":"followers"`) || !strings.Contains(routeResponse.Body.String(), `"username":"follower"`) {
		t.Fatalf("follow list route: status=%d body=%s", routeResponse.Code, routeResponse.Body.String())
	}

	invalidTypeRequest := httptest.NewRequest(http.MethodGet, "http://test/api/posts.php?action=follow_list&username=target&type=unknown", nil)
	invalidTypeRequest.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: "follow-list-session"})
	invalidTypeResponse := httptest.NewRecorder()
	serverHTTP.ServeHTTP(invalidTypeResponse, invalidTypeRequest)
	if invalidTypeResponse.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid follow list type: status=%d body=%s", invalidTypeResponse.Code, invalidTypeResponse.Body.String())
	}

	if _, err := db.Exec("DROP TABLE user_follows"); err != nil {
		t.Fatal(err)
	}
	unavailableRequest := httptest.NewRequest(http.MethodGet, "http://test/api/posts.php?action=follow_list&username=target&type=followers", nil)
	unavailableRequest.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: "follow-list-session"})
	unavailableResponse := httptest.NewRecorder()
	serverHTTP.ServeHTTP(unavailableResponse, unavailableRequest)
	if unavailableResponse.Code != http.StatusServiceUnavailable || !strings.Contains(unavailableResponse.Body.String(), `"code":"posts_unavailable"`) {
		t.Fatalf("unavailable follow list: status=%d body=%s", unavailableResponse.Code, unavailableResponse.Body.String())
	}
}
