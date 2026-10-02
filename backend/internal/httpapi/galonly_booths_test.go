package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/filestore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sessionstore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

func TestGalOnlyBoothPortal(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{
		Root: root, SiteURL: "http://test", DBDriver: "sqlite", DBPath: filepath.Join(root, "booths.db"),
		DataDir: root, UploadDir: root, SessionLifetime: 3600, SessionCookieSecure: false,
		AnalyticsHashKey: "metrics-test-key", SessionSecret: "session-test-key", BoothCredentialKey: "credential-test-key",
	}
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
	if _, err := db.Exec(`INSERT INTO users(id,username,nickname,role,status,is_audit) VALUES (1,'super','超管','super_admin','active',0),(2,'member','普通用户','member','active',0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO galonly_events(id,name,location,date,registration_open,event_code,description) VALUES (1,'北京 GalOnly','B1','2026-10-18',1,'beijing','公开活动')`); err != nil {
		t.Fatal(err)
	}
	sessions := sessionstore.New(db)
	uid := int64(1)
	if err := sessions.Save(context.Background(), &sessionstore.Session{ID: "super-session", UserID: &uid, Payload: map[string]any{"user_id": uid}, ExpiresAt: time.Now().Add(time.Hour), Valid: true}); err != nil {
		t.Fatal(err)
	}
	server, err := New(cfg, db, filestore.New(root, root), &sessionstore.Manager{Store: sessions, CookieName: "PHPSESSID"})
	if err != nil {
		t.Fatal(err)
	}
	request := func(cookies []*http.Cookie, sessionID, method, action, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://test/api/galonly_booths.php?action="+action+"&event_code=beijing", strings.NewReader(body))
		req.Header.Set("Origin", "http://test")
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if sessionID != "" {
			req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sessionID})
		}
		for _, cookie := range cookies {
			req.AddCookie(cookie)
		}
		res := httptest.NewRecorder()
		server.ServeHTTP(res, req)
		return res
	}
	decode := func(res *httptest.ResponseRecorder) map[string]any {
		t.Helper()
		var payload map[string]any
		if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
			t.Fatalf("status=%d body=%s: %v", res.Code, res.Body.String(), err)
		}
		return payload
	}

	mapBody := galonlyMapSaveBody(galonlyMapTestProject(false, 0), 0, "", "booth-portal-map.json")
	mapRequest := func(action, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "http://test/api/galonly.php?action="+action, strings.NewReader(body))
		req.Header.Set("Origin", "http://test")
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: "super-session"})
		res := httptest.NewRecorder()
		server.ServeHTTP(res, req)
		return res
	}
	savedMap := decode(mapRequest("map_save", mapBody))
	if savedMap["success"] != true {
		t.Fatalf("map save=%v", savedMap)
	}
	publicRequest := httptest.NewRequest(http.MethodPost, "http://test/api/galonly_public.php", strings.NewReader(`{"action":"list","eventKey":"bgo-02"}`))
	publicRequest.Header.Set("Content-Type", "application/json")
	publicResponse := httptest.NewRecorder()
	server.ServeHTTP(publicResponse, publicRequest)
	publicPayload := decode(publicResponse)
	if publicResponse.Code != http.StatusOK || publicPayload["ok"] != true || publicPayload["eventKey"] != "bgo-02" {
		t.Fatalf("public booth list status=%d body=%s", publicResponse.Code, publicResponse.Body.String())
	}
	publicMerchants := publicPayload["merchants"].([]any)
	if len(publicMerchants) != 2 || publicMerchants[0].(map[string]any)["merchantKey"] != "A01" {
		t.Fatalf("public merchants=%v", publicMerchants)
	}
	if strings.Contains(publicResponse.Body.String(), "password_hash") || strings.Contains(publicResponse.Body.String(), "contact") || strings.Contains(publicResponse.Body.String(), "profile_version") {
		t.Fatalf("public booth list leaked private fields: %s", publicResponse.Body.String())
	}
	if publicResponse.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("public booth list missing CORS header")
	}
	var initializeWait sync.WaitGroup
	initializeErrors := make(chan error, 8)
	for index := 0; index < 8; index++ {
		initializeWait.Add(1)
		go func() {
			defer initializeWait.Done()
			_, err := server.ensureGalonlyBoothCatalog(context.Background(), 1)
			initializeErrors <- err
		}()
	}
	initializeWait.Wait()
	close(initializeErrors)
	for err := range initializeErrors {
		if err != nil {
			t.Fatalf("concurrent booth initialization: %v", err)
		}
	}
	for _, table := range []string{"galonly_booth_profiles", "galonly_booth_accounts"} {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM " + table + " WHERE event_id=1").Scan(&count); err != nil || count != 2 {
			t.Fatalf("%s count=%d err=%v", table, count, err)
		}
	}

	admin := request(nil, "super-session", http.MethodGet, "admin_list", "")
	adminPayload := decode(admin)
	if admin.Code != http.StatusOK || adminPayload["success"] != true {
		t.Fatalf("admin list status=%d body=%s", admin.Code, admin.Body.String())
	}
	booths := adminPayload["booths"].([]any)
	if len(booths) != 2 {
		t.Fatalf("booths=%v", booths)
	}
	first := booths[0].(map[string]any)
	boothID := first["booth_id"].(string)
	account := first["account"].(map[string]any)
	username := account["username"].(string)
	initialPassword := account["initial_password"].(string)
	if username == "" || initialPassword == "" || strings.Contains(admin.Body.String(), "password_hash") {
		t.Fatalf("account response leaked or was incomplete: %s", admin.Body.String())
	}
	if forbidden := request(nil, "", http.MethodGet, "admin_list", ""); forbidden.Code != http.StatusUnauthorized {
		t.Fatalf("guest admin list status=%d", forbidden.Code)
	}
	memberSession := "member-session"
	memberID := int64(2)
	if err := sessions.Save(context.Background(), &sessionstore.Session{ID: memberSession, UserID: &memberID, Payload: map[string]any{"user_id": memberID}, ExpiresAt: time.Now().Add(time.Hour), Valid: true}); err != nil {
		t.Fatal(err)
	}
	if forbidden := request(nil, memberSession, http.MethodGet, "admin_list", ""); forbidden.Code != http.StatusForbidden {
		t.Fatalf("member admin list status=%d body=%s", forbidden.Code, forbidden.Body.String())
	}

	login := request(nil, "", http.MethodPost, "login", `{"username":"`+username+`","password":"`+initialPassword+`"}`)
	loginPayload := decode(login)
	if login.Code != http.StatusOK || loginPayload["booth_id"] != boothID {
		t.Fatalf("booth login status=%d body=%s", login.Code, login.Body.String())
	}
	boothCookies := login.Result().Cookies()
	if len(boothCookies) == 0 || boothCookies[0].Name != galonlyBoothSessionCookie {
		t.Fatalf("login cookies=%v", boothCookies)
	}
	me := decode(request(boothCookies, "", http.MethodGet, "me", ""))
	profile := me["profile"].(map[string]any)
	publicBeforeProfile := httptest.NewRecorder()
	server.ServeHTTP(publicBeforeProfile, httptest.NewRequest(http.MethodGet, "http://test/api/galonly.php?action=map_public&event_code=beijing", nil))
	if publicBeforeProfile.Code != http.StatusOK {
		t.Fatalf("initial public map status=%d body=%s", publicBeforeProfile.Code, publicBeforeProfile.Body.String())
	}
	mapOwnedPublicBody := publicBeforeProfile.Body.String()
	profile["tagline"] = "摊主门户已同步"
	version := int64(me["profile_version"].(float64))
	saved := decode(request(boothCookies, "", http.MethodPost, "save_profile", `{"booth_id":"`+boothID+`","base_version":`+strconv.FormatInt(version, 10)+`,"profile":`+mustJSON(profile)+`}`))
	if saved["success"] != true {
		t.Fatalf("save profile=%v", saved)
	}
	publicRes := httptest.NewRecorder()
	server.ServeHTTP(publicRes, httptest.NewRequest(http.MethodGet, "http://test/api/galonly.php?action=map_public&event_code=beijing", nil))
	if publicRes.Body.String() == mapOwnedPublicBody || !strings.Contains(publicRes.Body.String(), "摊主门户已同步") {
		t.Fatalf("booth portal profile did not update public map output: %s", publicRes.Body.String())
	}
	changedResponse := request(boothCookies, "", http.MethodPost, "change_password", `{"current_password":"`+initialPassword+`","new_password":"a-new-password-123"}`)
	if changed := decode(changedResponse); changed["success"] != true {
		t.Fatalf("change password=%v", changed)
	}
	changedCookies := changedResponse.Result().Cookies()
	if len(changedCookies) == 0 || changedCookies[0].Name != galonlyBoothSessionCookie {
		t.Fatalf("changed password cookies=%v", changedCookies)
	}
	if stale := request(boothCookies, "", http.MethodGet, "me", ""); stale.Code != http.StatusUnauthorized {
		t.Fatalf("old password session remained valid: status=%d body=%s", stale.Code, stale.Body.String())
	}
	adminAfterChange := decode(request(nil, "super-session", http.MethodGet, "admin_list", ""))
	changedAccount := adminAfterChange["booths"].([]any)[0].(map[string]any)["account"].(map[string]any)
	if changedAccount["password_changed"] != true || changedAccount["initial_password"] != nil {
		t.Fatalf("initial password remained visible after change: %v", changedAccount)
	}
	updateAccount := func(status string) *httptest.ResponseRecorder {
		return request(nil, "super-session", http.MethodPost, "admin_update_account", `{"event_code":"beijing","booth_id":"`+boothID+`","username":"`+username+`","status":"`+status+`"}`)
	}
	if disabled := updateAccount("disabled"); disabled.Code != http.StatusOK {
		t.Fatalf("disable booth account status=%d body=%s", disabled.Code, disabled.Body.String())
	}
	if enabled := updateAccount("active"); enabled.Code != http.StatusOK {
		t.Fatalf("enable booth account status=%d body=%s", enabled.Code, enabled.Body.String())
	}
	if stale := request(changedCookies, "", http.MethodGet, "me", ""); stale.Code != http.StatusUnauthorized {
		t.Fatalf("pre-disable session revived after re-enable: status=%d body=%s", stale.Code, stale.Body.String())
	}
	relogin := request(nil, "", http.MethodPost, "login", `{"username":"`+username+`","password":"a-new-password-123"}`)
	if relogin.Code != http.StatusOK {
		t.Fatalf("relogin status=%d body=%s", relogin.Code, relogin.Body.String())
	}
	freshCookies := relogin.Result().Cookies()
	uploadBoothImage := func(asset string) *httptest.ResponseRecorder {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		part, err := writer.CreateFormFile("file", asset+".png")
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
		req := httptest.NewRequest(http.MethodPost, "http://test/api/galonly_booths.php?action=upload_image&event_code=beijing&booth_id="+boothID+"&asset="+asset, &body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		req.Header.Set("Origin", "http://test")
		for _, cookie := range freshCookies {
			req.AddCookie(cookie)
		}
		res := httptest.NewRecorder()
		server.ServeHTTP(res, req)
		return res
	}
	avatarUpload := uploadBoothImage("avatar")
	avatarUploadPayload := decode(avatarUpload)
	avatarURL, avatarURLOK := avatarUploadPayload["url"].(string)
	if avatarUpload.Code != http.StatusOK || avatarUploadPayload["success"] != true || avatarUploadPayload["asset"] != "avatar" || !avatarURLOK || !strings.Contains(avatarURL, "/avatar_") {
		t.Fatalf("booth avatar upload status=%d body=%s", avatarUpload.Code, avatarUpload.Body.String())
	}
	profile["avatarUrl"] = avatarURL
	profileVersion := int64(saved["profile_version"].(float64))
	avatarSaved := decode(request(freshCookies, "", http.MethodPost, "save_profile", `{"booth_id":"`+boothID+`","base_version":`+strconv.FormatInt(profileVersion, 10)+`,"profile":`+mustJSON(profile)+`}`))
	if avatarSaved["success"] != true {
		t.Fatalf("save avatar profile=%v", avatarSaved)
	}
	publicAfterAvatar := httptest.NewRecorder()
	server.ServeHTTP(publicAfterAvatar, httptest.NewRequest(http.MethodGet, "http://test/api/galonly.php?action=map_public&event_code=beijing", nil))
	if !strings.Contains(publicAfterAvatar.Body.String(), avatarURL) {
		t.Fatalf("booth portal avatar did not update map public output: %s", publicAfterAvatar.Body.String())
	}
	profile["avatarUrl"] = "http://evil.example/avatar.webp"
	invalidAvatar := request(freshCookies, "", http.MethodPost, "save_profile", `{"booth_id":"`+boothID+`","base_version":`+strconv.FormatInt(int64(avatarSaved["profile_version"].(float64)), 10)+`,"profile":`+mustJSON(profile)+`}`)
	if invalidAvatar.Code != http.StatusBadRequest {
		t.Fatalf("insecure booth avatar URL status=%d body=%s", invalidAvatar.Code, invalidAvatar.Body.String())
	}
	profile["avatarUrl"] = nil
	clearedAvatar := decode(request(freshCookies, "", http.MethodPost, "save_profile", `{"booth_id":"`+boothID+`","base_version":`+strconv.FormatInt(int64(avatarSaved["profile_version"].(float64)), 10)+`,"profile":`+mustJSON(profile)+`}`))
	if clearedAvatar["success"] != true {
		t.Fatalf("clear booth avatar=%v", clearedAvatar)
	}
	publicAfterClear := httptest.NewRecorder()
	server.ServeHTTP(publicAfterClear, httptest.NewRequest(http.MethodGet, "http://test/api/galonly.php?action=map_public&event_code=beijing", nil))
	if strings.Contains(publicAfterClear.Body.String(), avatarURL) || !strings.Contains(publicAfterClear.Body.String(), "摊主门户已同步") {
		t.Fatalf("booth portal avatar cleanup did not update map public output: %s", publicAfterClear.Body.String())
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
	oversizedRequest := httptest.NewRequest(http.MethodPost, "http://test/api/galonly_booths.php?action=upload_image&event_code=beijing&booth_id="+boothID, &oversizedBody)
	oversizedRequest.Header.Set("Content-Type", oversizedWriter.FormDataContentType())
	oversizedRequest.Header.Set("Origin", "http://test")
	for _, cookie := range freshCookies {
		oversizedRequest.AddCookie(cookie)
	}
	oversizedResponse := httptest.NewRecorder()
	server.ServeHTTP(oversizedResponse, oversizedRequest)
	if oversizedResponse.Code != http.StatusBadRequest {
		t.Fatalf("oversized booth upload status=%d body=%s", oversizedResponse.Code, oversizedResponse.Body.String())
	}
	var hashBefore string
	var versionBefore int64
	if err := db.QueryRow("SELECT password_hash,credential_version FROM galonly_booth_accounts WHERE event_id=1 AND booth_id=?", boothID).Scan(&hashBefore, &versionBefore); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TRIGGER reject_booth_session_revoke BEFORE UPDATE OF revoked_at ON galonly_booth_sessions WHEN NEW.revoked_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'blocked'); END`); err != nil {
		t.Fatal(err)
	}
	reset := request(nil, "super-session", http.MethodPost, "admin_reset_credentials", `{"event_code":"beijing","booth_id":"`+boothID+`"}`)
	if reset.Code != http.StatusServiceUnavailable {
		t.Fatalf("failed credential reset status=%d body=%s", reset.Code, reset.Body.String())
	}
	var hashAfter string
	var versionAfter int64
	if err := db.QueryRow("SELECT password_hash,credential_version FROM galonly_booth_accounts WHERE event_id=1 AND booth_id=?", boothID).Scan(&hashAfter, &versionAfter); err != nil {
		t.Fatal(err)
	}
	if hashAfter != hashBefore || versionAfter != versionBefore {
		t.Fatalf("failed credential reset did not roll back: version %d->%d", versionBefore, versionAfter)
	}
	if current := request(freshCookies, "", http.MethodGet, "me", ""); current.Code != http.StatusOK {
		t.Fatalf("failed credential reset invalidated current session: status=%d body=%s", current.Code, current.Body.String())
	}
	if _, err := db.Exec("DROP TRIGGER reject_booth_session_revoke"); err != nil {
		t.Fatal(err)
	}
	var profileJSON string
	if err := db.QueryRow("SELECT profile_json FROM galonly_booth_profiles WHERE event_id=1 AND booth_id=?", boothID).Scan(&profileJSON); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE galonly_booth_profiles SET profile_json='{' WHERE event_id=1 AND booth_id=?", boothID); err != nil {
		t.Fatal(err)
	}
	corruptLogin := request(nil, "", http.MethodPost, "login", `{"username":"`+username+`","password":"a-new-password-123"}`)
	if corruptLogin.Code != http.StatusServiceUnavailable || len(corruptLogin.Result().Cookies()) != 0 {
		t.Fatalf("corrupt profile login issued a session: status=%d cookies=%v body=%s", corruptLogin.Code, corruptLogin.Result().Cookies(), corruptLogin.Body.String())
	}
	if _, err := db.Exec("UPDATE galonly_booth_profiles SET profile_json=? WHERE event_id=1 AND booth_id=?", profileJSON, boothID); err != nil {
		t.Fatal(err)
	}
	track := func(metric, eventUUID string) {
		body := `{"booth_id":"` + boothID + `","metric_type":"` + metric + `","event_uuid":"` + eventUUID + `","visitor_id":"visitor-test-1"}`
		res := request(nil, "", http.MethodPost, "track", body)
		if res.Code != http.StatusNoContent {
			t.Fatalf("track %s status=%d body=%s", metric, res.Code, res.Body.String())
		}
	}
	track("detail_view", "00000000-0000-0000-0000-000000000001")
	track("product_click", "00000000-0000-0000-0000-000000000002")
	metrics := decode(request(boothCookies, "super-session", http.MethodGet, "metrics&booth_id="+boothID, ""))
	metricsData := metrics["metrics"].(map[string]any)
	if metricsData["detail_views"] != float64(1) || metricsData["product_clicks"] != float64(1) {
		t.Fatalf("metrics=%v", metricsData)
	}
}

func mustJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}
