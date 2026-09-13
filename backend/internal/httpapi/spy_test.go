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

func TestSpyHTTPGameLifecycleCompatibility(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{Root: root, SiteURL: "http://test", DBDriver: "sqlite", DBPath: filepath.Join(root, "spy.db"), DataDir: root, UploadDir: root, SessionLifetime: 3600}
	db, err := sqlstore.Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, nickname TEXT, avatar_url TEXT, role TEXT NOT NULL, status TEXT NOT NULL, email TEXT, email_verified_at TEXT, password_hash TEXT, qq_openid TEXT, discord_id TEXT, is_audit INTEGER DEFAULT 0, profile_bio TEXT, membership_application_email_enabled INTEGER DEFAULT 1, display_membership_id INTEGER, language_preference TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, last_login_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, ip_address TEXT, user_agent TEXT, expires_at TEXT NOT NULL, is_valid INTEGER NOT NULL DEFAULT 1)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := sqlstore.Apply(context.Background(), db, nil); err != nil {
		t.Fatal(err)
	}
	for id := 1; id <= 5; id++ {
		if _, err := db.Exec(`INSERT INTO users(id,username,nickname,role,status) VALUES(?,?,?,?,?)`, id, "spy"+strconv.Itoa(id), "玩家"+strconv.Itoa(id), "member", "active"); err != nil {
			t.Fatal(err)
		}
	}
	sessions := sessionstore.New(db)
	cookies := map[int]string{}
	for id := 1; id <= 5; id++ {
		sid := "spy-session-" + strconv.Itoa(id)
		uid := int64(id)
		if err := sessions.Save(context.Background(), &sessionstore.Session{ID: sid, UserID: &uid, Payload: map[string]any{"user_id": uid}, ExpiresAt: time.Now().Add(time.Hour), Valid: true}); err != nil {
			t.Fatal(err)
		}
		cookies[id] = sid
	}
	server, err := New(cfg, db, filestore.New(root, root), &sessionstore.Manager{Store: sessions, CookieName: "PHPSESSID"})
	if err != nil {
		t.Fatal(err)
	}
	request := func(uid int, method, endpoint, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://test"+endpoint, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://test")
		if uid > 0 {
			req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: cookies[uid]})
		}
		res := httptest.NewRecorder()
		server.ServeHTTP(res, req)
		return res
	}
	created := request(1, http.MethodPost, "/api/spy_rooms.php?action=create", `{"name":"SQLite 测试局","cap":4,"timer_profile":"fast"}`)
	if created.Code != http.StatusOK {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var createdBody struct {
		RoomID int64  `json:"room_id"`
		Code   string `json:"code"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &createdBody); err != nil || createdBody.RoomID <= 0 || createdBody.Code == "" {
		t.Fatalf("create response=%s", created.Body.String())
	}
	for id := 2; id <= 5; id++ {
		joined := request(id, http.MethodPost, "/api/spy_rooms.php?action=join", `{"code":"`+createdBody.Code+`"}`)
		if joined.Code != http.StatusOK {
			t.Fatalf("join %d status=%d body=%s", id, joined.Code, joined.Body.String())
		}
	}
	started := request(1, http.MethodPost, "/api/spy_rooms.php?action=start", `{"code":"`+createdBody.Code+`"}`)
	if started.Code != http.StatusOK {
		t.Fatalf("start status=%d body=%s", started.Code, started.Body.String())
	}
	for {
		var speaker, round int64
		var phase string
		if err := db.QueryRow(`SELECT speaker_seat,round,phase FROM spy_rooms WHERE id=?`, createdBody.RoomID).Scan(&speaker, &round, &phase); err != nil {
			t.Fatal(err)
		}
		if phase != spyPhaseDay {
			break
		}
		var uid int
		if err := db.QueryRow(`SELECT user_id FROM spy_seats WHERE room_id=? AND seat=?`, createdBody.RoomID, speaker).Scan(&uid); err != nil {
			t.Fatal(err)
		}
		response := request(uid, http.MethodPost, "/api/spy_actions.php?action=sentence", `{"code":"`+createdBody.Code+`","skip":true}`)
		if response.Code != http.StatusOK {
			t.Fatalf("sentence status=%d body=%s", response.Code, response.Body.String())
		}
	}
	for {
		var phase string
		if err := db.QueryRow(`SELECT phase FROM spy_rooms WHERE id=?`, createdBody.RoomID).Scan(&phase); err != nil {
			t.Fatal(err)
		}
		if phase != spyPhaseVote {
			break
		}
		rows, err := db.Query(`SELECT seat,user_id FROM spy_seats WHERE room_id=? ORDER BY seat`, createdBody.RoomID)
		if err != nil {
			t.Fatal(err)
		}
		type player struct{ seat, uid int }
		players := []player{}
		for rows.Next() {
			var p player
			if err := rows.Scan(&p.seat, &p.uid); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			players = append(players, p)
		}
		rows.Close()
		for _, p := range players {
			target := players[0].seat
			if target == p.seat {
				target = players[1].seat
			}
			response := request(p.uid, http.MethodPost, "/api/spy_actions.php?action=vote", `{"code":"`+createdBody.Code+`","to_seat":`+strconv.Itoa(target)+`}`)
			if response.Code != http.StatusOK {
				t.Fatalf("vote seat=%d status=%d body=%s", p.seat, response.Code, response.Body.String())
			}
		}
	}
	snapshot := request(1, http.MethodGet, "/api/spy_table.php?code="+createdBody.Code, "")
	if snapshot.Code != http.StatusOK || !strings.Contains(snapshot.Body.String(), `"success":true`) {
		t.Fatalf("snapshot status=%d body=%s", snapshot.Code, snapshot.Body.String())
	}
	if !strings.Contains(snapshot.Body.String(), `"room"`) || !strings.Contains(snapshot.Body.String(), `"seats"`) {
		t.Fatalf("snapshot shape=%s", snapshot.Body.String())
	}
}
