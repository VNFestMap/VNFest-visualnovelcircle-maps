package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/integrations/picui"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/filestore"
)

func TestPublicImageKeepsLocalBackupAndReturnsPicUIURL(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":true,"data":{"key":"avatar-key","links":{"url":"https://free.picui.cn/avatar.png"}}}`))
	}))
	defer provider.Close()

	dataRoot, uploadRoot := t.TempDir(), t.TempDir()
	server := &Server{
		cfg:   config.Config{PicUIFallbackLocal: true},
		files: filestore.New(dataRoot, uploadRoot),
		picui: picui.New(picui.Config{Enabled: true, APIURL: provider.URL, Token: "token", AllowedHosts: []string{"free.picui.cn"}, Timeout: 5 * time.Second}),
	}
	result, err := server.storePublicDataImage(context.Background(), "avatars/a.png", "data/avatars/a.png", "a.png", "image/png", "avatar:1", []byte("png"))
	if err != nil {
		t.Fatalf("store public image: %v", err)
	}
	if result.Storage != "picui" || result.URL != "https://free.picui.cn/avatar.png" {
		t.Fatalf("unexpected stored image: %#v", result)
	}
	if result.LocalBackup != "data/avatars/a.png" {
		t.Fatalf("local backup = %q", result.LocalBackup)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "avatars", "a.png")); err != nil {
		t.Fatalf("local backup missing: %v", err)
	}
}

func TestPublicImageFallsBackAndRecordsRetryWithoutLosingLocalFile(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`upstream failure`))
	}))
	defer provider.Close()

	dataRoot := t.TempDir()
	server := &Server{
		cfg:   config.Config{PicUIFallbackLocal: true},
		files: filestore.New(dataRoot, t.TempDir()),
		picui: picui.New(picui.Config{Enabled: true, APIURL: provider.URL, Token: "token", AllowedHosts: []string{"free.picui.cn"}, Timeout: 5 * time.Second}),
	}
	result, err := server.storePublicDataImage(context.Background(), "avatars/a.png", "data/avatars/a.png", "a.png", "image/png", "avatar:1", []byte("png"))
	if err != nil {
		t.Fatalf("fallback should keep request successful: %v", err)
	}
	if result.Storage != "local" || !result.Fallback || result.URL != "data/avatars/a.png" {
		t.Fatalf("unexpected fallback result: %#v", result)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "avatars", "a.png")); err != nil {
		t.Fatalf("local fallback file missing: %v", err)
	}
	var pending map[string]map[string]any
	if err := server.files.ReadJSON(context.Background(), "image-host/pending.json", &pending); err != nil {
		t.Fatalf("pending retry record missing: %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("pending retry count = %d, want 1", len(pending))
	}
}

func TestPromotePublicImageValueLeavesPrivateOrUnrelatedValuesAlone(t *testing.T) {
	server := &Server{picui: picui.New(picui.Config{Enabled: true, Token: "token", AllowedHosts: []string{"free.picui.cn"}})}
	input := []any{"https://example.com/existing.png", "private-document.pdf", map[string]any{"caption": "中文"}}
	next, changed := server.promotePublicImageValue(context.Background(), input, "test", map[string]string{})
	if changed {
		t.Fatalf("unrelated values unexpectedly changed: %#v", next)
	}
}
