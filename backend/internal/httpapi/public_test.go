package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/filestore"
)

func TestPublicAPICompatibilityContract(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	clubs := map[string]any{"data": []map[string]any{
		{
			"id": 7, "country": "china", "province": "广东省/香港", "city": "深圳",
			"school": "测试学校", "name": "测试社", "remark": "公开摘要",
			"status": "published", "verified": 1, "logo_url": "data/club_avatars/7.png",
			"external_links": []any{"https://example.com/a.", "https://example.com/a", "not-a-url"},
		},
		{"id": 8, "country": "japan", "province": "东京都", "name": "不应公开"},
		{"id": 9, "country": "china", "province": "广东", "status": "private", "name": "不应公开"},
	}}
	encoded, err := json.Marshal(clubs)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "clubs.json"), encoded, 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{Root: root, SiteURL: "https://www.map.vnfest.top", DataDir: dataDir, UploadDir: root}
	server, err := New(cfg, nil, filestore.New(dataDir, root), nil)
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/public/v1/clubs.php?country=china", nil)
	request.Header.Set("Origin", "https://www.vnfest.top")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("clubs status=%d body=%s", response.Code, response.Body.String())
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "https://www.vnfest.top" {
		t.Fatalf("missing allowed origin: %q", response.Header().Get("Access-Control-Allow-Origin"))
	}
	if response.Header().Get("Cache-Control") != "public, max-age=60, stale-while-revalidate=300" {
		t.Fatalf("unexpected cache policy: %q", response.Header().Get("Cache-Control"))
	}
	var clubsResponse struct {
		Success bool            `json:"success"`
		Data    []publicAPIClub `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &clubsResponse); err != nil {
		t.Fatal(err)
	}
	if !clubsResponse.Success || len(clubsResponse.Data) != 1 {
		t.Fatalf("unexpected public rows: %+v", clubsResponse)
	}
	row := clubsResponse.Data[0]
	if row.ID != 7 || row.Province != "广东" || len(row.Provinces) != 2 || row.LogoURL != "https://map.vnfest.top/data/club_avatars/7.png" {
		t.Fatalf("unexpected public row: %+v", row)
	}
	if len(row.ExternalLinks) != 1 || row.ExternalLinks[0] != "https://example.com/a" {
		t.Fatalf("unexpected external links: %+v", row.ExternalLinks)
	}

	conditional := httptest.NewRequest(http.MethodGet, "/api/public/v1/clubs.php?country=china", nil)
	conditional.Header.Set("If-None-Match", response.Header().Get("ETag"))
	conditionalResponse := httptest.NewRecorder()
	server.ServeHTTP(conditionalResponse, conditional)
	if conditionalResponse.Code != http.StatusNotModified {
		t.Fatalf("conditional status=%d body=%s", conditionalResponse.Code, conditionalResponse.Body.String())
	}

	checks := []struct {
		name string
		path string
		code int
	}{
		{"club", "/api/public/v1/club.php?country=china&id=7", http.StatusOK},
		{"invalid country", "/api/public/v1/club.php?id=7", http.StatusBadRequest},
		{"invalid id", "/api/public/v1/club.php?country=china&id=bad", http.StatusBadRequest},
		{"missing club", "/api/public/v1/club.php?country=china&id=999", http.StatusNotFound},
		{"manifest", "/api/public/v1/manifest.php", http.StatusOK},
	}
	for _, check := range checks {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, check.path, nil))
		if response.Code != check.code {
			t.Errorf("%s status=%d want=%d body=%s", check.name, response.Code, check.code, response.Body.String())
		}
	}

	options := httptest.NewRequest(http.MethodOptions, "/api/public/v1/clubs.php", nil)
	options.Header.Set("Origin", "https://www.vnfest.top")
	optionsResponse := httptest.NewRecorder()
	server.ServeHTTP(optionsResponse, options)
	if optionsResponse.Code != http.StatusNoContent || optionsResponse.Header().Get("Access-Control-Allow-Methods") != "GET, OPTIONS" {
		t.Fatalf("options response=%d headers=%v", optionsResponse.Code, optionsResponse.Header())
	}

	deniedOptions := httptest.NewRequest(http.MethodOptions, "/api/public/v1/clubs.php", nil)
	deniedOptions.Header.Set("Origin", "https://evil.example")
	deniedResponse := httptest.NewRecorder()
	server.ServeHTTP(deniedResponse, deniedOptions)
	if deniedResponse.Code != http.StatusForbidden || !strings.Contains(deniedResponse.Body.String(), "cors_origin_denied") {
		t.Fatalf("denied options response=%d body=%s", deniedResponse.Code, deniedResponse.Body.String())
	}

	post := httptest.NewRequest(http.MethodPost, "/api/public/v1/clubs.php?country=china", nil)
	postResponse := httptest.NewRecorder()
	server.ServeHTTP(postResponse, post)
	if postResponse.Code != http.StatusMethodNotAllowed || postResponse.Header().Get("Allow") != "GET, OPTIONS" {
		t.Fatalf("post response=%d headers=%v", postResponse.Code, postResponse.Header())
	}
}
