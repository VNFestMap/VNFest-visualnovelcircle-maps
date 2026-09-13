package sqlstore_test

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sessionstore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

func nowPlusHour() time.Time { return time.Now().Add(time.Hour) }

func TestApplyVerifyAndSessionRoundTripSQLite(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{DBDriver: "sqlite", DBPath: root + "/test.db"}
	db, err := sqlstore.Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, query := range []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, status TEXT NOT NULL)`,
		`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, ip_address TEXT, user_agent TEXT, expires_at DATETIME NOT NULL, is_valid INTEGER NOT NULL DEFAULT 1)`,
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	if err := sqlstore.Apply(context.Background(), db, nil); err != nil {
		t.Fatal(err)
	}
	if err := sqlstore.Verify(context.Background(), db); err != nil {
		t.Fatal(err)
	}

	userID := int64(42)
	if _, err := db.Exec(`INSERT INTO users(id, username, status) VALUES (?, ?, ?)`, userID, "tester", "active"); err != nil {
		t.Fatal(err)
	}
	store := sessionstore.New(db)
	session := &sessionstore.Session{ID: strings.Repeat("a", 32), UserID: &userID, Payload: map[string]any{"user_id": userID, "qq_state": "opaque-state"}, ExpiresAt: nowPlusHour(), Valid: true}
	if err := store.Save(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load(context.Background(), session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded == nil || loaded.UserID == nil || *loaded.UserID != userID || loaded.Payload["qq_state"] != "opaque-state" {
		t.Fatalf("unexpected session: %#v", loaded)
	}
	if err := store.Invalidate(context.Background(), session.ID); err != nil {
		t.Fatal(err)
	}
	loaded, err = store.Load(context.Background(), session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded != nil {
		t.Fatalf("invalidated session was loaded: %#v", loaded)
	}
}

func TestSnapshotIncludesSchemaDetailsWithoutSQLiteDeadlock(t *testing.T) {
	root := t.TempDir()
	db, err := sqlstore.Open(context.Background(), config.Config{DBDriver: "sqlite", DBPath: root + "/snapshot.db"})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, query := range []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, status TEXT NOT NULL)`,
		`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL, is_valid INTEGER NOT NULL DEFAULT 1, FOREIGN KEY(user_id) REFERENCES users(id))`,
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	if err := sqlstore.Apply(context.Background(), db, nil); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := sqlstore.WriteSnapshot(context.Background(), db, &output); err != nil {
		t.Fatal(err)
	}
	var snapshot struct {
		SchemaSHA256 string `json:"schema_sha256"`
		Tables       []struct {
			Name        string `json:"name"`
			Columns     []any  `json:"columns"`
			Indexes     []any  `json:"indexes"`
			ForeignKeys []any  `json:"foreign_keys"`
		} `json:"tables"`
	}
	if err := json.Unmarshal(output.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.SchemaSHA256 == "" || len(snapshot.Tables) < 5 {
		t.Fatalf("incomplete snapshot: sha=%q tables=%d", snapshot.SchemaSHA256, len(snapshot.Tables))
	}
	var foundPosts bool
	for _, table := range snapshot.Tables {
		if table.Name == "posts" {
			foundPosts = true
			if len(table.Columns) == 0 || len(table.Indexes) == 0 || len(table.ForeignKeys) == 0 {
				t.Fatalf("posts schema details missing: %#v", table)
			}
		}
	}
	if !foundPosts {
		t.Fatal("posts table missing from snapshot")
	}
}
