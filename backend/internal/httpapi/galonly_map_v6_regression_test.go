package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/filestore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sessionstore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

// Exercise an already-published V6 document directly: saving a fresh V5
// project did not catch the production reader regression.
func TestGalOnlyMapPublicReadsPersistedV6(t *testing.T) {
	raw, err := os.ReadFile("testdata/galonly-map-published-v6.json")
	if err != nil {
		t.Fatal(err)
	}
	project, err := galonlyMapProjectFromDocument(map[string]any{"payload_json": string(raw)})
	if err != nil {
		t.Fatalf("persisted V6 document rejected: %v", err)
	}
	root := t.TempDir()
	cfg := config.Config{Root: root, SiteURL: "http://test", DBDriver: "sqlite", DBPath: filepath.Join(root, "v6.db"), DataDir: root, UploadDir: root}
	db, err := sqlstore.Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT, status TEXT)`); err != nil {
		t.Fatal(err)
	}
	if err := sqlstore.Apply(context.Background(), db, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO galonly_events(id,name,location,date,registration_open,event_code) VALUES(3,'北京 GalOnly','北投购物公园','2026-10-18',1,'beijing')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO galonly_map_documents(event_id,revision,status,schema_version,payload_json,checksum_sha256,source_name) VALUES(3,27,'published',6,?,?,'persisted-v6.json')`, string(raw), galonlyMapChecksum(raw)); err != nil {
		t.Fatal(err)
	}
	booths := project["catalog"].(map[string]any)["booths"].([]any)
	first := booths[0].(map[string]any)
	profile := `{"name":"有效公开摊位","circleName":"公开社团","products":[]}`
	if _, err := db.Exec(`INSERT INTO galonly_booth_profiles(event_id,booth_id,profile_json,visibility_state) VALUES(3,?,?,'active')`, first["id"], profile); err != nil {
		t.Fatal(err)
	}
	server, err := New(cfg, db, filestore.New(root, root), &sessionstore.Manager{Store: sessionstore.New(db), CookieName: "PHPSESSID"})
	if err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []string{"/api/galonly.php?action=map_public&event_code=beijing", "/api/galonly_public.php?event_code=beijing"} {
		res := httptest.NewRecorder()
		method, body := http.MethodGet, ""
		if strings.Contains(endpoint, "galonly_public.php") {
			method, body = http.MethodPost, `{"action":"list","event_code":"beijing"}`
		}
		req := httptest.NewRequest(method, "http://test"+endpoint, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		server.ServeHTTP(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("%s: status=%d body=%s", endpoint, res.Code, res.Body.String())
		}
		var response map[string]any
		if err := json.Unmarshal(res.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(endpoint, "map_public") {
			if response["map_status"] != "published" || int(response["published_booth_count"].(float64)) != len(booths) {
				t.Fatalf("V6 response: %s", res.Body.String())
			}
			publicProject := response["map"].(map[string]any)["project"].(map[string]any)
			if publicProject["schemaVersion"] != float64(6) {
				t.Fatalf("V6 schema lost: %v", publicProject["schemaVersion"])
			}
		}
		if !strings.Contains(res.Body.String(), "有效公开摊位") || strings.Contains(res.Body.String(), "applicationId") || strings.Contains(res.Body.String(), `"reserved"`) {
			t.Fatalf("public profile projection: %s", res.Body.String())
		}
	}
	if _, err := db.Exec(`UPDATE galonly_booth_profiles SET visibility_state='archived' WHERE event_id=3`); err != nil {
		t.Fatal(err)
	}
	res := httptest.NewRecorder()
	server.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "http://test/api/galonly.php?action=map_public&event_code=beijing", nil))
	if res.Code != http.StatusOK || strings.Contains(res.Body.String(), "有效公开摊位") {
		t.Fatalf("archived profile leaked: %s", res.Body.String())
	}
}
