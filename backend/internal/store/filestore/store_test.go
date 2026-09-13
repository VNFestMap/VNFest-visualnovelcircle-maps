package filestore

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestJSONAtomicWritePreservesValidDocument(t *testing.T) {
	root := t.TempDir()
	store := New(filepath.Join(root, "data"), filepath.Join(root, "uploads"))
	ctx := context.Background()
	if err := store.WriteJSONAtomic(ctx, "nested/state.json", map[string]any{"中文": "保留", "items": []int{1, 2}}); err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := store.ReadJSON(ctx, "nested/state.json", &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["中文"] != "保留" {
		t.Fatalf("unexpected JSON: %#v", decoded)
	}
	if _, err := os.Stat(filepath.Join(root, "data", "nested", "state.json.lock")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("lock file was not removed: %v", err)
	}
}

func TestConcurrentJSONWritesDoNotCreatePartialJSON(t *testing.T) {
	root := t.TempDir()
	store := New(filepath.Join(root, "data"), filepath.Join(root, "uploads"))
	var group sync.WaitGroup
	for i := 0; i < 12; i++ {
		group.Add(1)
		go func(value int) {
			defer group.Done()
			if err := store.WriteJSONAtomic(context.Background(), "state.json", map[string]int{"value": value}); err != nil {
				t.Errorf("write %d: %v", value, err)
			}
		}(i)
	}
	group.Wait()
	data, err := os.ReadFile(filepath.Join(root, "data", "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]int
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("final file is not valid JSON: %v; data=%q", err, data)
	}
}

func TestUploadPathBoundaryAndRoundTrip(t *testing.T) {
	root := t.TempDir()
	store := New(filepath.Join(root, "data"), filepath.Join(root, "uploads"))
	if err := store.SaveUpload(context.Background(), "posts/a.txt", strings.NewReader("hello")); err != nil {
		t.Fatal(err)
	}
	file, err := store.OpenUpload(context.Background(), "posts/a.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil || string(data) != "hello" {
		t.Fatalf("unexpected upload: %q, %v", data, err)
	}
	for _, name := range []string{"../outside", "../../outside", "/absolute", `..\outside`, `C:\outside`} {
		if err := store.SaveUpload(context.Background(), name, strings.NewReader("bad")); err == nil {
			t.Fatalf("path traversal was accepted: %q", name)
		}
	}
}
