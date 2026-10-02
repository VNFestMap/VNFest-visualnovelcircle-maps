package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/filestore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sessionstore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

func TestGalOnlyBeijingMapAPI(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{Root: root, SiteURL: "http://test", DBDriver: "sqlite", DBPath: filepath.Join(root, "galonly-map.db"), DataDir: root, UploadDir: root, SessionLifetime: 3600}
	db, err := sqlstore.Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, nickname TEXT, avatar_url TEXT, role TEXT NOT NULL, status TEXT NOT NULL, email TEXT, email_verified_at TEXT, password_hash TEXT, qq_openid TEXT, discord_id TEXT, is_audit INTEGER DEFAULT 0, profile_bio TEXT, membership_application_email_enabled INTEGER DEFAULT 1, display_membership_id INTEGER, language_preference TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, last_login_at TEXT)`,
		`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, ip_address TEXT, user_agent TEXT, expires_at TEXT NOT NULL, is_valid INTEGER NOT NULL DEFAULT 1)`,
		`CREATE TABLE club_memberships (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, club_id INTEGER NOT NULL, country TEXT NOT NULL DEFAULT 'china', role TEXT NOT NULL, status TEXT NOT NULL, join_method TEXT, joined_at TEXT, left_at TEXT)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := sqlstore.Apply(context.Background(), db, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO users(id,username,nickname,role,status,is_audit) VALUES
        (1,'map-admin','地图管理员','super_admin','active',0),
        (2,'map-member','普通会员','member','active',0),
        (3,'map-reviewer','北京审核员','member','active',0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO galonly_events(id,name,location,date,registration_open,event_code,description)
        VALUES(1,'北京 GalOnly','北投购物公园 B1','2026-10-18',1,'beijing','北京活动公开资料')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO galonly_reviewers(event_id,user_id,role) VALUES(1,3,'reviewer')`); err != nil {
		t.Fatal(err)
	}
	sessions := sessionstore.New(db)
	for _, item := range []struct {
		id  string
		uid int64
	}{{"map-admin-session", 1}, {"map-member-session", 2}, {"map-reviewer-session", 3}} {
		uid := item.uid
		if err := sessions.Save(context.Background(), &sessionstore.Session{ID: item.id, UserID: &uid, Payload: map[string]any{"user_id": uid}, ExpiresAt: time.Now().Add(time.Hour), Valid: true}); err != nil {
			t.Fatal(err)
		}
	}
	server, err := New(cfg, db, filestore.New(root, root), &sessionstore.Manager{Store: sessions, CookieName: "PHPSESSID"})
	if err != nil {
		t.Fatal(err)
	}
	request := func(sessionID, method, endpoint, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://test"+endpoint, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://test")
		if sessionID != "" {
			req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sessionID})
		}
		res := httptest.NewRecorder()
		server.ServeHTTP(res, req)
		return res
	}
	decode := func(t *testing.T, res *httptest.ResponseRecorder) map[string]any {
		t.Helper()
		var payload map[string]any
		if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
			t.Fatalf("status=%d body=%s: %v", res.Code, res.Body.String(), err)
		}
		return payload
	}

	publicBefore := request("", http.MethodGet, "/api/galonly.php?action=map_public&event_code=beijing", "")
	beforePayload := decode(t, publicBefore)
	if publicBefore.Code != http.StatusOK || beforePayload["map_status"] != "unpublished" || beforePayload["map"] != nil || strings.Contains(publicBefore.Body.String(), "虚构") {
		t.Fatalf("unpublished public map leaked data: status=%d body=%s", publicBefore.Code, publicBefore.Body.String())
	}
	publicEvent, ok := beforePayload["event"].(map[string]any)
	if !ok || publicEvent["event_code"] != "beijing" {
		t.Fatalf("public event projection=%v", beforePayload["event"])
	}
	if _, leaked := publicEvent["id"]; leaked {
		t.Fatalf("public event leaked internal id: %v", publicEvent)
	}
	if forbidden := request("map-member-session", http.MethodGet, "/api/galonly.php?action=map_admin&event_code=beijing", ""); forbidden.Code != http.StatusForbidden {
		t.Fatalf("ordinary member map_admin status=%d body=%s", forbidden.Code, forbidden.Body.String())
	}
	if guestState := request("", http.MethodPost, "/api/galonly.php?action=map_state&event_code=beijing", `{"event_code":"beijing","favorite_booth_ids":[]}`); guestState.Code != http.StatusUnauthorized {
		t.Fatalf("guest map_state write status=%d body=%s", guestState.Code, guestState.Body.String())
	}
	evilOriginRequest := httptest.NewRequest(http.MethodPost, "http://test/api/galonly.php?action=map_save", strings.NewReader(galonlyMapSaveBody(galonlyMapTestProject(false, 0), 0, "", "evil.json")))
	evilOriginRequest.Header.Set("Content-Type", "application/json")
	evilOriginRequest.Header.Set("Origin", "https://evil.example")
	evilOriginRequest.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: "map-admin-session"})
	evilOriginResponse := httptest.NewRecorder()
	server.ServeHTTP(evilOriginResponse, evilOriginRequest)
	if evilOriginResponse.Code != http.StatusForbidden {
		t.Fatalf("cross-origin map write status=%d body=%s", evilOriginResponse.Code, evilOriginResponse.Body.String())
	}
	capability := decode(t, request("map-reviewer-session", http.MethodGet, "/api/galonly.php?action=map_capability&event_code=beijing", ""))
	if capability["can_edit"] != true || capability["review_role"] != "reviewer" {
		t.Fatalf("event reviewer capability=%v", capability)
	}
	uploadImage := func(sessionID, asset string) *httptest.ResponseRecorder {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		filename := "product.png"
		if asset == "avatar" {
			filename = "avatar.webp"
		}
		part, err := writer.CreateFormFile("file", filename)
		if err != nil {
			t.Fatal(err)
		}
		png1x1 := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 'I', 'H', 'D', 'R', 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 'I', 'D', 'A', 'T', 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 'I', 'E', 'N', 'D', 0xae, 0x42, 0x60, 0x82}
		if _, err := part.Write(png1x1); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "http://test/api/galonly.php?action=map_upload_image&event_code=beijing&asset="+asset, &body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		req.Header.Set("Origin", "http://test")
		req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sessionID})
		res := httptest.NewRecorder()
		server.ServeHTTP(res, req)
		return res
	}
	uploaded := uploadImage("map-reviewer-session", "product")
	uploadedPayload := decode(t, uploaded)
	uploadedURL, hasURL := uploadedPayload["url"].(string)
	if uploaded.Code != http.StatusOK || uploadedPayload["success"] != true || !hasURL || !strings.HasPrefix(uploadedURL, "/uploads/galonly/1/") || uploadedPayload["storage"] != "local" {
		t.Fatalf("map product image upload status=%d body=%s", uploaded.Code, uploaded.Body.String())
	}
	avatarUploaded := uploadImage("map-reviewer-session", "avatar")
	avatarPayload := decode(t, avatarUploaded)
	avatarURL, avatarHasURL := avatarPayload["url"].(string)
	if avatarUploaded.Code != http.StatusOK || avatarPayload["success"] != true || avatarPayload["asset"] != "avatar" || !avatarHasURL || !strings.Contains(avatarURL, "/avatar_") {
		t.Fatalf("map avatar image upload status=%d body=%s", avatarUploaded.Code, avatarUploaded.Body.String())
	}
	var oversizedBody bytes.Buffer
	oversizedWriter := multipart.NewWriter(&oversizedBody)
	oversizedPart, err := oversizedWriter.CreateFormFile("file", "oversized.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := oversizedPart.Write(bytes.Repeat([]byte{'x'}, (10<<20)+(512<<10))); err != nil {
		t.Fatal(err)
	}
	if err := oversizedWriter.Close(); err != nil {
		t.Fatal(err)
	}
	oversizedRequest := httptest.NewRequest(http.MethodPost, "http://test/api/galonly.php?action=map_upload_image&event_code=beijing", &oversizedBody)
	oversizedRequest.Header.Set("Content-Type", oversizedWriter.FormDataContentType())
	oversizedRequest.Header.Set("Origin", "http://test")
	oversizedRequest.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: "map-reviewer-session"})
	oversizedResponse := httptest.NewRecorder()
	server.ServeHTTP(oversizedResponse, oversizedRequest)
	if oversizedResponse.Code != http.StatusBadRequest {
		t.Fatalf("oversized map upload status=%d body=%s", oversizedResponse.Code, oversizedResponse.Body.String())
	}

	realProject := galonlyMapTestProject(false, 0)
	var realProjectValue map[string]any
	if err := json.Unmarshal(realProject, &realProjectValue); err != nil {
		t.Fatal(err)
	}
	realCatalog := realProjectValue["catalog"].(map[string]any)
	realBooths := realCatalog["booths"].([]any)
	realBooths[0].(map[string]any)["avatarUrl"] = avatarURL
	realProject, _ = json.Marshal(realProjectValue)
	draft := request("map-admin-session", http.MethodPost, "/api/galonly.php?action=map_save", galonlyMapSaveBody(realProject, 0, "", "real-beijing.json"))
	draftPayload := decode(t, draft)
	if draft.Code != http.StatusOK || draftPayload["success"] != true {
		t.Fatalf("save real draft status=%d body=%s", draft.Code, draft.Body.String())
	}
	revision1 := int64(draftPayload["revision"].(float64))
	checksum1 := draftPayload["checksum_sha256"].(string)
	if legacy := request("map-admin-session", http.MethodPost, "/api/galonly.php?action=map_publish", `{"event_code":"beijing","revision":1}`); legacy.Code != http.StatusConflict {
		t.Fatalf("legacy map publisher remained writable: status=%d body=%s", legacy.Code, legacy.Body.String())
	}
	if missingChecksum := request("map-reviewer-session", http.MethodPost, "/api/galonly.php?action=map_save", galonlyMapSaveBody(realProject, revision1, "", "missing-checksum.json")); missingChecksum.Code != http.StatusConflict {
		t.Fatalf("map save without checksum status=%d body=%s", missingChecksum.Code, missingChecksum.Body.String())
	}
	if stale := request("map-reviewer-session", http.MethodPost, "/api/galonly.php?action=map_save", galonlyMapSaveBody(realProject, 0, checksum1, "stale.json")); stale.Code != http.StatusConflict {
		t.Fatalf("stale map save status=%d body=%s", stale.Code, stale.Body.String())
	}
	adminAfterPublish := decode(t, request("map-admin-session", http.MethodGet, "/api/galonly.php?action=map_admin&event_code=beijing", ""))
	if adminAfterPublish["draft"] != nil {
		t.Fatalf("stale draft remained after publish: %v", adminAfterPublish["draft"])
	}
	if _, err := db.Exec(`INSERT INTO galonly_applications(id,event_id,user_id,status,booth_name,image_path,display_image,merchandise_items)
		VALUES(502,1,2,'confirmed','真实摊位 A02','[]','/uploads/galonly/1/application-502.webp','[{"name":"申请制品","category":"周边","description":"","priceCents":1234,"images":["/uploads/galonly/1/product-502.webp"]}]')`); err != nil {
		t.Fatal(err)
	}
	public := request("", http.MethodGet, "/api/galonly.php?action=map_public&event_code=beijing", "")
	publicPayload := decode(t, public)
	if public.Code != http.StatusOK || publicPayload["map_status"] != "published" || publicPayload["published_booth_count"] != float64(2) || publicPayload["published_table_count"] != float64(2) || strings.Contains(public.Body.String(), "applicationId") {
		t.Fatalf("published public map status=%d body=%s", public.Code, public.Body.String())
	}
	publicMap, ok := publicPayload["map"].(map[string]any)
	if !ok {
		t.Fatalf("public map projection=%v", publicPayload["map"])
	}
	for _, key := range []string{"revision", "checksum_sha256", "published_at"} {
		if _, leaked := publicMap[key]; leaked {
			t.Fatalf("public map leaked %s: %v", key, publicMap)
		}
	}
	publicProject := publicMap["project"].(map[string]any)
	publicCatalog := publicProject["catalog"].(map[string]any)
	publicBooths := publicCatalog["booths"].([]any)
	var applicationBooth map[string]any
	for _, rawBooth := range publicBooths {
		booth := rawBooth.(map[string]any)
		if booth["id"] == "A02" {
			applicationBooth = booth
			break
		}
	}
	if applicationBooth == nil {
		t.Fatalf("map-owned A02 disappeared from public output: %v", publicBooths)
	}
	applicationProducts := applicationBooth["products"].([]any)
	if len(applicationProducts) != 0 {
		t.Fatalf("application merchandise leaked into map products: %v", applicationProducts)
	}
	if _, exists := applicationBooth["detailImageUrl"]; exists {
		t.Fatalf("application display image leaked into map booth: %v", applicationBooth["detailImageUrl"])
	}
	var avatarBooth map[string]any
	for _, rawBooth := range publicBooths {
		booth := rawBooth.(map[string]any)
		if booth["id"] == "A01" {
			avatarBooth = booth
			break
		}
	}
	if avatarBooth == nil || avatarBooth["avatarUrl"] != avatarURL {
		t.Fatalf("map-owned avatar URL was not returned: %v", avatarBooth)
	}
	mapBeforeApplicationChange := public.Body.String()
	if _, err := db.Exec(`UPDATE galonly_applications SET status='pending',display_image='/uploads/galonly/1/application-502-changed.webp',merchandise_items='[{"name":"申请修改后的制品","priceCents":9999}]' WHERE id=502`); err != nil {
		t.Fatal(err)
	}
	unchanged := request("", http.MethodGet, "/api/galonly.php?action=map_public&event_code=beijing", "")
	if unchanged.Code != http.StatusOK || unchanged.Body.String() != mapBeforeApplicationChange {
		t.Fatalf("application changes altered map public output: before=%s after=%s", mapBeforeApplicationChange, unchanged.Body.String())
	}
	adminPayload := decode(t, request("map-reviewer-session", http.MethodGet, "/api/galonly.php?action=map_admin&event_code=beijing", ""))
	versions, ok := adminPayload["versions"].([]any)
	if !ok || len(versions) == 0 {
		t.Fatalf("admin versions=%v", adminPayload["versions"])
	}
	version, ok := versions[0].(map[string]any)
	if !ok || version["revision"] == nil || version["checksum_sha256"] == nil {
		t.Fatalf("admin version metadata=%v", versions[0])
	}

	stateWrite := request("map-member-session", http.MethodPost, "/api/galonly.php?action=map_state&event_code=beijing", `{"event_code":"beijing","favorite_booth_ids":["A01","A02","A01"],"selected_booth_id":"A02"}`)
	if stateWrite.Code != http.StatusOK {
		t.Fatalf("save user map state status=%d body=%s", stateWrite.Code, stateWrite.Body.String())
	}
	stateRead := decode(t, request("map-member-session", http.MethodGet, "/api/galonly.php?action=map_state&event_code=beijing", ""))
	if stateRead["logged_in"] != true || len(stateRead["favorite_booth_ids"].([]any)) != 2 || stateRead["selected_booth_id"] != "A02" {
		t.Fatalf("user map state=%v", stateRead)
	}
	invalidState := request("map-member-session", http.MethodPost, "/api/galonly.php?action=map_state&event_code=beijing", `{"favorite_booth_ids":["Z99"]}`)
	if invalidState.Code != http.StatusBadRequest {
		t.Fatalf("invalid user map state status=%d body=%s", invalidState.Code, invalidState.Body.String())
	}
	serverSideStateRequest := httptest.NewRequest(http.MethodPost, "http://test/api/galonly.php?action=map_state&event_code=beijing", strings.NewReader(`{"event_code":"beijing","favorite_booth_ids":["A01"],"selected_booth_id":"A01"}`))
	serverSideStateRequest.Header.Set("Content-Type", "application/json")
	serverSideStateRequest.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: "map-member-session"})
	serverSideStateResponse := httptest.NewRecorder()
	server.ServeHTTP(serverSideStateResponse, serverSideStateRequest)
	if serverSideStateResponse.Code != http.StatusOK {
		t.Fatalf("origin-less server-side map state status=%d body=%s", serverSideStateResponse.Code, serverSideStateResponse.Body.String())
	}

	if _, err := db.Exec(`INSERT INTO galonly_applications(id,event_id,user_id,status,booth_name,image_path) VALUES(501,1,2,'pending','待审核摊位','[]')`); err != nil {
		t.Fatal(err)
	}
	linkedProject := galonlyMapTestProject(false, 501)
	linkedDraft := request("map-reviewer-session", http.MethodPost, "/api/galonly.php?action=map_save", galonlyMapSaveBody(linkedProject, revision1, checksum1, "linked-pending.json"))
	linkedDraftPayload := decode(t, linkedDraft)
	if linkedDraft.Code != http.StatusOK {
		t.Fatalf("reviewer save linked draft status=%d body=%s", linkedDraft.Code, linkedDraft.Body.String())
	}
	revision2 := int64(linkedDraftPayload["revision"].(float64))
	checksum2 := linkedDraftPayload["checksum_sha256"].(string)
	if _, err := db.Exec(`UPDATE galonly_applications SET status='rejected' WHERE id=501`); err != nil {
		t.Fatal(err)
	}
	independent := decode(t, request("", http.MethodGet, "/api/galonly.php?action=map_public&event_code=beijing", ""))
	if independent["published_booth_count"] != float64(2) || !strings.Contains(request("", http.MethodGet, "/api/galonly.php?action=map_public&event_code=beijing", "").Body.String(), `"id":"A01"`) {
		t.Fatalf("rejected application changed the map publication: %v", independent)
	}

	demoDraft := request("map-admin-session", http.MethodPost, "/api/galonly.php?action=map_save", galonlyMapSaveBody(galonlyMapTestProject(true, 0), revision2, checksum2, "demo.json"))
	if demoDraft.Code != http.StatusBadRequest {
		t.Fatalf("demo map save status=%d body=%s", demoDraft.Code, demoDraft.Body.String())
	}
	var documentCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM galonly_map_documents WHERE event_id=1`).Scan(&documentCount); err != nil {
		t.Fatal(err)
	}
	invalid := request("map-admin-session", http.MethodPost, "/api/galonly.php?action=map_save", galonlyMapSaveBody([]byte(`{"schemaVersion":5,"eventId":"shanghai"}`), revision2, checksum2, "invalid.json"))
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid draft status=%d body=%s", invalid.Code, invalid.Body.String())
	}
	var documentCountAfter int
	if err := db.QueryRow(`SELECT COUNT(*) FROM galonly_map_documents WHERE event_id=1`).Scan(&documentCountAfter); err != nil {
		t.Fatal(err)
	}
	if documentCountAfter != documentCount {
		t.Fatalf("invalid import partially wrote documents: before=%d after=%d", documentCount, documentCountAfter)
	}
}

func TestGalOnlyMapAvatarURLValidation(t *testing.T) {
	var project map[string]any
	if err := json.Unmarshal(galonlyMapTestProject(false, 0), &project); err != nil {
		t.Fatal(err)
	}
	catalog := project["catalog"].(map[string]any)
	booths := catalog["booths"].([]any)
	booths[0].(map[string]any)["avatarUrl"] = "http://evil.example/avatar.webp"
	raw, _ := json.Marshal(project)
	if _, err := validateGalonlyMapProject(raw, true); err == nil {
		t.Fatal("insecure avatar URL was accepted")
	}
	booths[0].(map[string]any)["avatarUrl"] = nil
	raw, _ = json.Marshal(project)
	if _, err := validateGalonlyMapProject(raw, true); err != nil {
		t.Fatalf("explicit avatar clear was rejected: %v", err)
	}
}

func TestGalOnlyMapMultiTableProject(t *testing.T) {
	var project map[string]any
	if err := json.Unmarshal(galonlyMapTestProject(false, 0), &project); err != nil {
		t.Fatal(err)
	}
	catalog := project["catalog"].(map[string]any)
	booths := catalog["booths"].([]any)
	booth := booths[0].(map[string]any)
	booth["id"] = "circle-aurora"
	booth["tableIds"] = []any{"A01", "A02"}
	catalog["booths"] = []any{booth}
	raw, _ := json.Marshal(project)
	normalized, err := validateGalonlyMapProject(raw, true)
	if err != nil {
		t.Fatalf("multi-table project rejected: %v", err)
	}
	if galonlyMapProjectTableCount(normalized) != 2 || len(galonlyMapProjectBoothIDs(normalized)) != 1 {
		t.Fatalf("multi-table count mismatch: project=%v", normalized)
	}
	aliases := galonlyMapProjectBoothAliases(normalized)
	if aliases["A01"] != "circle-aurora" || aliases["A02"] != "circle-aurora" {
		t.Fatalf("multi-table aliases=%v", aliases)
	}
	favorites, err := galonlyMapStateIDs([]string{"A01", "A02", "circle-aurora"}, aliases)
	if err != nil || len(favorites) != 1 || favorites[0] != "circle-aurora" {
		t.Fatalf("legacy favorites were not merged: values=%v err=%v", favorites, err)
	}

	booth["tableIds"] = []any{"A01", "A01"}
	invalidRaw, _ := json.Marshal(project)
	if _, err := validateGalonlyMapProject(invalidRaw, true); err == nil {
		t.Fatal("duplicate table assignment within one booth was accepted")
	}

	booth["tableIds"] = []any{"A01"}
	second := map[string]any{}
	for key, value := range booth {
		second[key] = value
	}
	second["id"] = "circle-aurora-2"
	second["name"] = "历史重复桌位资料"
	second["tableIds"] = []any{"A01"}
	second["products"] = []any{}
	catalog["booths"] = []any{booth, second}
	duplicateAcrossBooths, _ := json.Marshal(project)
	normalizedConflict, err := validateGalonlyMapProject(duplicateAcrossBooths, true)
	if err != nil {
		t.Fatalf("historical cross-booth table conflict should remain editable: %v", err)
	}
	conflictLayout, err := galonlyMapLayoutProject(normalizedConflict)
	if err != nil {
		t.Fatalf("historical conflict could not migrate to layout v6: %v", err)
	}
	if tableID := galonlyMapExpandedTableConflict(normalizedConflict, conflictLayout); tableID != "" {
		t.Fatalf("unchanged historical conflict was treated as expanded: %s", tableID)
	}

	proposed := galonlyMapClone(conflictLayout)
	proposedCatalog := proposed["catalog"].(map[string]any)
	proposedBooths := proposedCatalog["booths"].([]any)
	proposedBooths = append(proposedBooths, map[string]any{
		"id": "circle-aurora-3", "tableIds": []any{"A01"}, "category": "game", "color": "#336699", "reserved": false,
	})
	proposedCatalog["booths"] = proposedBooths
	if tableID := galonlyMapExpandedTableConflict(normalizedConflict, proposed); tableID != "A01" {
		t.Fatalf("new owner did not expand historical conflict: %q", tableID)
	}
}

func TestGalOnlyMapPlaceholdersDoNotConsumeRealBoothLimit(t *testing.T) {
	var project map[string]any
	if err := json.Unmarshal(galonlyMapTestProject(false, 0), &project); err != nil {
		t.Fatal(err)
	}
	catalog := project["catalog"].(map[string]any)
	booths := catalog["booths"].([]any)
	booths = []any{booths[0]}
	used := map[string]bool{"A01": true}
	for id := range galonlyMapBoothIDs() {
		if used[id] || len(booths) >= 64 {
			continue
		}
		used[id] = true
		booths = append(booths, map[string]any{
			"id": id, "tableIds": []any{id}, "placeholder": true,
			"name": id + " · 待填写", "circleName": "参展资料待填写", "category": "game",
			"tagline": "位置已预留，等待真实参展资料。", "description": galonlyMapPlaceholderDescription,
			"tags": []any{"待填写"}, "status": "preparing", "color": "#8ba5b8", "avatarText": "待",
			"announcement": galonlyMapPlaceholderAnnouncement, "contact": map[string]any{"label": "", "url": nil},
			"products": []any{},
		})
	}
	if len(booths) != 64 {
		t.Fatalf("test fixture has %d booths, want 64", len(booths))
	}
	catalog["booths"] = booths
	raw, _ := json.Marshal(project)
	if _, err := validateGalonlyMapProject(raw, true); err != nil {
		t.Fatalf("placeholder catalog should not consume the real booth limit: %v", err)
	}
}

func TestGalOnlyMapLegacyPlaceholderDoesNotBlockRealTable(t *testing.T) {
	var project map[string]any
	if err := json.Unmarshal(galonlyMapTestProject(false, 0), &project); err != nil {
		t.Fatal(err)
	}
	catalog := project["catalog"].(map[string]any)
	placeholder := map[string]any{
		"id": "G11", "tableIds": []any{"G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09", "G10", "G11", "G12"},
		"name": "日谷阿姨", "circleName": "日谷阿姨", "category": "game", "tagline": "位置已预留，等待真实参展资料。",
		"description": galonlyMapPlaceholderDescription, "tags": []any{"待填写"}, "status": "open", "color": "#f88825", "avatarText": "日谷",
		"announcement": galonlyMapPlaceholderAnnouncement, "contact": map[string]any{"label": "官方主页", "url": nil}, "products": []any{},
	}
	real := map[string]any{
		"id": "circle-g05", "tableIds": []any{"G05"}, "name": "真实 G05 摊位", "circleName": "G05 创作组", "category": "game",
		"tagline": "真实摊位资料。", "description": "真实公开摊位。", "tags": []any{"原创"}, "status": "open", "color": "#326cc2", "avatarText": "真",
		"announcement": "现场资料以摊主公告为准。", "contact": map[string]any{"label": "官方主页", "url": nil}, "products": []any{},
	}
	catalog["booths"] = []any{placeholder, real}
	raw, _ := json.Marshal(project)
	normalized, err := validateGalonlyMapProject(raw, true)
	if err != nil {
		t.Fatalf("legacy placeholder incorrectly blocked G05: %v", err)
	}
	normalizedCatalog := normalized["catalog"].(map[string]any)
	normalizedBooths := normalizedCatalog["booths"].([]any)
	if len(normalizedBooths) != 2 {
		t.Fatalf("normalized booths=%v", normalizedBooths)
	}
	if normalizedBooths[0].(map[string]any)["placeholder"] != true {
		t.Fatalf("legacy placeholder marker was not preserved: %v", normalizedBooths[0])
	}
	ids, ok := normalizedBooths[1].(map[string]any)["tableIds"].([]string)
	if !ok || len(ids) != 1 || ids[0] != "G05" {
		t.Fatalf("real G05 table was not preserved: %v", normalizedBooths[1])
	}
}

func TestGalOnlyMapAreaNames(t *testing.T) {
	var project map[string]any
	if err := json.Unmarshal(galonlyMapTestProject(false, 0), &project); err != nil {
		t.Fatal(err)
	}
	project["settings"] = map[string]any{
		"numberingRevision": 1,
		"areaNames": map[string]any{
			"makeup": "妆造间",
			"stage":  "小舞台",
		},
	}
	raw, _ := json.Marshal(project)
	normalized, err := validateGalonlyMapProject(raw, true)
	if err != nil {
		t.Fatalf("area names rejected: %v", err)
	}
	settings, ok := normalized["settings"].(map[string]any)
	if !ok {
		t.Fatalf("normalized settings=%v", normalized["settings"])
	}
	names, ok := settings["areaNames"].(map[string]any)
	if !ok || names["makeup"] != "妆造间" || names["stage"] != "小舞台" {
		t.Fatalf("normalized area names=%v", settings["areaNames"])
	}

	project["settings"] = map[string]any{"areaNames": map[string]any{"unknown": "不应被接受"}}
	invalidRaw, _ := json.Marshal(project)
	if _, err := validateGalonlyMapProject(invalidRaw, true); err == nil {
		t.Fatal("unknown area name was accepted")
	}
}

func galonlyMapTestProject(demo bool, applicationID int64) []byte {
	first := map[string]any{
		"id": "A01", "name": "真实摊位 A01", "circleName": "北京创作组", "category": "game", "tagline": "在现场分享一段故事。",
		"description": "北京活动的真实公开摊位资料。", "tags": []any{"视觉小说"}, "status": "open", "color": "#326cc2", "avatarText": "真",
		"announcement": "现场资料以摊主公告为准。", "contact": map[string]any{"label": "官方主页", "url": nil}, "products": []any{
			map[string]any{"id": "A01-P01", "name": "故事设定集", "kind": "book", "priceCents": 6800, "unit": "份", "spec": "A5 / 64 页", "description": "公开制品介绍。", "status": "available", "badge": "新品", "variants": []any{"标准版"}, "imageUrl": nil, "note": "价格以现场为准。"},
		},
	}
	if applicationID > 0 {
		first["applicationId"] = applicationID
	}
	second := map[string]any{
		"id": "A02", "name": "真实摊位 A02", "circleName": "北京制作室", "category": "game", "tagline": "把新的角色带到现场。",
		"description": "另一个真实公开摊位资料。", "tags": []any{"原创游戏"}, "status": "preparing", "color": "#54857d", "avatarText": "制",
		"announcement": "资料持续更新。", "contact": map[string]any{"label": "", "url": nil}, "products": []any{},
	}
	project := map[string]any{
		"schemaVersion": 5, "eventId": "beijing", "units": "metres", "settings": map[string]any{},
		"positions": map[string]any{"A01": map[string]any{"x": 0, "z": 0}, "A02": map[string]any{"x": 1.2, "z": 0}},
		"catalog": map[string]any{
			"schemaVersion": 1, "eventId": "beijing", "demo": demo, "currency": "CNY", "notice": "北京 GalOnly 官方发布资料。",
			"categories": []any{map[string]any{"id": "game", "name": "独立游戏", "color": "#326cc2", "icon": "game"}},
			"booths":     []any{first, second},
		},
	}
	raw, _ := json.Marshal(project)
	return raw
}

func galonlyMapSaveBody(project []byte, baseRevision int64, baseChecksum, sourceName string) string {
	var value any
	_ = json.Unmarshal(project, &value)
	body, _ := json.Marshal(map[string]any{"event_code": "beijing", "base_revision": baseRevision, "base_checksum_sha256": baseChecksum, "source_name": sourceName, "project": value})
	return string(body)
}
