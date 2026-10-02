package sessionstore

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

func loginStoreFixture(t *testing.T) (*Store, *sqlstore.DB) {
	t.Helper()
	db, err := sqlstore.Open(context.Background(), config.Config{DBDriver: "sqlite", DBPath: filepath.Join(t.TempDir(), "sessions.db")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	for _, query := range []string{
		`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, ip_address TEXT, user_agent TEXT, expires_at DATETIME, is_valid INTEGER NOT NULL DEFAULT 1)`,
		`CREATE TABLE vnfest_session_bridge (session_id TEXT PRIMARY KEY, user_id INTEGER, payload_json TEXT, expires_at DATETIME, is_valid INTEGER NOT NULL, created_at DATETIME, updated_at DATETIME)`,
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	return New(db), db
}

func loginSession(id string) *Session {
	uid := int64(1)
	return &Session{ID: id, UserID: &uid, Valid: true, ExpiresAt: time.Now().Add(time.Hour)}
}

func assertStoredLogin(t *testing.T, store *Store, db *sqlstore.DB, id string, valid bool) {
	t.Helper()
	session, err := store.Load(context.Background(), id)
	if err != nil || (session != nil) != valid {
		t.Fatalf("load %s: %v %v, want valid=%v", id, session, err, valid)
	}
	for _, table := range []struct{ name, key string }{{"sessions", "id"}, {"vnfest_session_bridge", "session_id"}} {
		var flag int
		if err := db.QueryRow("SELECT is_valid FROM "+table.name+" WHERE "+table.key+" = ?", id).Scan(&flag); err != nil || (flag == 1) != valid {
			t.Fatalf("%s/%s validity=%d err=%v", table.name, id, flag, err)
		}
	}
}

func TestLoginKeepsOtherDevicesAndRotatesCurrentSession(t *testing.T) {
	store, db := loginStoreFixture(t)
	ctx := context.Background()
	for _, id := range []string{"desktop", "mobile", "tablet"} {
		if err := store.SaveLogin(ctx, loginSession(id), ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.SaveLogin(ctx, loginSession("desktop-new"), "desktop"); err != nil {
		t.Fatal(err)
	}
	assertStoredLogin(t, store, db, "desktop", false)
	for _, id := range []string{"desktop-new", "mobile", "tablet"} {
		assertStoredLogin(t, store, db, id, true)
	}
	if err := store.Invalidate(ctx, "desktop-new"); err != nil {
		t.Fatal(err)
	}
	assertStoredLogin(t, store, db, "desktop-new", false)
	assertStoredLogin(t, store, db, "mobile", true)
	if err := store.InvalidateUserSessions(ctx, 1); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"mobile", "tablet"} {
		assertStoredLogin(t, store, db, id, false)
	}
}

func TestLoginWriteFailurePreservesOldSessions(t *testing.T) {
	for _, table := range []string{"sessions", "vnfest_session_bridge"} {
		t.Run(table, func(t *testing.T) {
			store, db := loginStoreFixture(t)
			ctx := context.Background()
			for _, id := range []string{"old-browser", "other-device"} {
				if err := store.SaveLogin(ctx, loginSession(id), ""); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := db.Exec("CREATE TRIGGER fail_login BEFORE INSERT ON " + table + " BEGIN SELECT RAISE(ABORT, 'injected write failure'); END"); err != nil {
				t.Fatal(err)
			}
			if err := store.SaveLogin(ctx, loginSession("new-browser"), "old-browser"); err == nil {
				t.Fatal("write failure was swallowed")
			}
			for _, id := range []string{"old-browser", "other-device"} {
				assertStoredLogin(t, store, db, id, true)
			}
			for _, name := range []string{"sessions", "vnfest_session_bridge"} {
				var count int
				if err := db.QueryRow("SELECT COUNT(*) FROM " + name).Scan(&count); err != nil || count != 2 {
					t.Fatalf("partial write in %s: %d %v", name, count, err)
				}
			}
		})
	}
}

func TestConcurrentLoginAndExpiry(t *testing.T) {
	store, db := loginStoreFixture(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	for _, id := range []string{"a", "b", "c", "d", "e", "f"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			if err := store.SaveLogin(ctx, loginSession(id), ""); err != nil {
				t.Error(err)
			}
		}(id)
	}
	wg.Wait()
	for _, id := range []string{"a", "b", "c", "d", "e", "f"} {
		assertStoredLogin(t, store, db, id, true)
	}
	expired := loginSession("expired")
	expired.ExpiresAt = time.Now().Add(-time.Hour)
	if err := store.SaveLogin(ctx, expired, ""); err != nil {
		t.Fatal(err)
	}
	if got, err := store.Load(ctx, "expired"); err != nil || got != nil {
		t.Fatalf("expired session accepted: %v %v", got, err)
	}
}
