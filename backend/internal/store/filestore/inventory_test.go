package filestore

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestInventoryProducesStableHashes(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "ignored.lock"), []byte("lock"), 0o600); err != nil {
		t.Fatal(err)
	}
	entries, err := Inventory(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Path != "a.txt" || entries[0].Size != 5 || entries[0].SHA256 != "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" {
		t.Fatalf("unexpected inventory: %#v", entries)
	}
}
