package jobs

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

func TestRunRecognitionExpiresAndAcknowledgesOutbox(t *testing.T) {
	root := t.TempDir()
	db, err := sqlstore.Open(context.Background(), config.Config{DBDriver: "sqlite", DBPath: filepath.Join(root, "worker.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, query := range []string{
		`CREATE TABLE recognition_credentials (id INTEGER PRIMARY KEY, credential_uid TEXT NOT NULL, holder_user_id INTEGER NOT NULL, badge_id INTEGER NOT NULL, program_id INTEGER NOT NULL, status TEXT NOT NULL, expires_at TEXT)`,
		`CREATE TABLE recognition_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, task_type TEXT NOT NULL, payload TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', created_at TEXT, processed_at TEXT)`,
		`CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, link TEXT, related_type TEXT, related_id INTEGER, is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT, read_at TEXT)`,
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO recognition_credentials(id,credential_uid,holder_user_id,badge_id,program_id,status,expires_at) VALUES(1,'cred-1',7,8,9,'active',datetime('now','-1 minute'))`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO recognition_outbox(task_type,payload,status) VALUES('unknown_task','{}','pending')`); err != nil {
		t.Fatal(err)
	}

	report, err := RunRecognition(context.Background(), db, false)
	if err != nil {
		t.Fatal(err)
	}
	if report.Expired != 1 || report.OutboxProcessed != 1 || report.OutboxFailed != 1 {
		t.Fatalf("unexpected report: %#v", report)
	}
	var status string
	if err := db.QueryRow(`SELECT status FROM recognition_credentials WHERE id=1`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "expired" {
		t.Fatalf("credential status=%q", status)
	}
	var done, pending int
	if err := db.QueryRow(`SELECT COUNT(*) FROM recognition_outbox WHERE status='done'`).Scan(&done); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM recognition_outbox WHERE status='pending'`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if done != 1 || pending != 1 {
		t.Fatalf("outbox state: done=%d pending=%d", done, pending)
	}
	var notifications int
	if err := db.QueryRow(`SELECT COUNT(*) FROM notifications WHERE user_id=7`).Scan(&notifications); err != nil {
		t.Fatal(err)
	}
	if notifications != 1 {
		t.Fatalf("notifications=%d", notifications)
	}
}

func TestRunRecognitionDryRunDoesNotWrite(t *testing.T) {
	root := t.TempDir()
	db, err := sqlstore.Open(context.Background(), config.Config{DBDriver: "sqlite", DBPath: filepath.Join(root, "worker.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE recognition_credentials (id INTEGER PRIMARY KEY, credential_uid TEXT, holder_user_id INTEGER, badge_id INTEGER, program_id INTEGER, status TEXT, expires_at TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE recognition_outbox (id INTEGER PRIMARY KEY, task_type TEXT, payload TEXT, status TEXT, attempts INTEGER, last_error TEXT, created_at TEXT, processed_at TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO recognition_credentials VALUES(1,'cred',1,1,1,'active',datetime('now','-1 minute'))`); err != nil {
		t.Fatal(err)
	}
	report, err := RunRecognition(context.Background(), db, true)
	if err != nil || report.Expired != 1 {
		t.Fatalf("dry run: report=%#v err=%v", report, err)
	}
	var status string
	if err := db.QueryRow(`SELECT status FROM recognition_credentials WHERE id=1`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "active" {
		t.Fatalf("dry run changed status=%q", status)
	}
}
