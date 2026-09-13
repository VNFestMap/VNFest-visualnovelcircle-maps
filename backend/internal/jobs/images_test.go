package jobs

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

func TestImageManifestReplacementKeepsValidDocument(t *testing.T) {
	path := filepath.Join(t.TempDir(), "image-host", "manifest.json")
	first := imageManifest{Version: 1, Entries: map[string]imageManifestEntry{"uploads/a.png": {SHA256: "a", Status: "uploaded"}}}
	if err := writeImageManifest(path, first); err != nil {
		t.Fatalf("write first manifest: %v", err)
	}
	second := imageManifest{Version: 1, Entries: map[string]imageManifestEntry{"uploads/a.png": {SHA256: "b", Status: "uploaded"}}}
	if err := writeImageManifest(path, second); err != nil {
		t.Fatalf("replace manifest: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	var decoded imageManifest
	if err := json.Unmarshal(data, &decoded); err != nil || decoded.Entries["uploads/a.png"].SHA256 != "b" {
		t.Fatalf("replacement did not preserve the new valid document: %s", data)
	}
}

func TestImageReferenceReplacementAndSkipGuards(t *testing.T) {
	next, count := replaceImageReferenceText("<img src='../uploads/a.png'>", map[string]string{"uploads/a.png": "https://picui.example/a"})
	if count == 0 || next != "<img src='https://picui.example/a'>" {
		t.Fatalf("image reference replacement mismatch: %q (%d)", next, count)
	}
	if !shouldSkipImageRewritePath(".codex-backups/old/index.html") || shouldSkipImageRewritePath("wiki/content/index.html") {
		t.Fatal("rewrite skip guard mismatch")
	}
}

func TestDatabaseImageRewriteIsAllowlistedAndBackedUp(t *testing.T) {
	db, err := sqlstore.Open(context.Background(), config.Config{DBDriver: "sqlite", DBPath: filepath.Join(t.TempDir(), "test.db")})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE image_rows (id INTEGER PRIMARY KEY, image_url TEXT, note TEXT)`); err != nil {
		t.Fatalf("create table: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO image_rows(id,image_url,note) VALUES(1,'uploads/a.png','uploads/a.png')`); err != nil {
		t.Fatalf("insert row: %v", err)
	}
	backupRoot := filepath.Join(t.TempDir(), "backup")
	count, err := rewriteDatabaseImageReferences(context.Background(), db, backupRoot, map[string]string{"uploads/a.png": "https://picui.example/a"})
	if err != nil || count != 1 {
		t.Fatalf("database rewrite failed: count=%d err=%v", count, err)
	}
	var imageURL, note string
	if err := db.QueryRow(`SELECT image_url,note FROM image_rows WHERE id=1`).Scan(&imageURL, &note); err != nil {
		t.Fatalf("read rewritten row: %v", err)
	}
	if imageURL != "https://picui.example/a" || note != "uploads/a.png" {
		t.Fatalf("rewrite escaped allowlist: image=%q note=%q", imageURL, note)
	}
	if _, err := os.Stat(filepath.Join(backupRoot, "database-before-rewrite.json")); err != nil {
		t.Fatalf("database backup missing: %v", err)
	}
}
