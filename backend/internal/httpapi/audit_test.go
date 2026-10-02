package httpapi

import (
	"bytes"
	"context"
	"database/sql"
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

func TestAutomaticAuditCapturesMultipartBusinessFields(t *testing.T) {
	server := newAuditTestServer(t)
	server.mux = http.NewServeMux()
	server.mux.HandleFunc("/api/galonly.php", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Fatal(err)
		}
		writeJSON(w, map[string]any{"success": true, "storage": "picui", "fallback": false})
	})
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("application_id", "42")
	_ = writer.WriteField("asset", "product")
	_ = writer.WriteField("password", "never-log-this")
	part, err := writer.CreateFormFile("file", "private-filename.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("image contents"))
	_ = writer.Close()
	req := httptest.NewRequest(http.MethodPost, "http://test/api/galonly.php?action=upload_image&event_code=beijing", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res := httptest.NewRecorder()
	server.ServeHTTP(res, req)
	var targetID int64
	var details string
	if err := server.db.QueryRow(`SELECT target_id,details FROM audit_logs LIMIT 1`).Scan(&targetID, &details); err != nil {
		t.Fatal(err)
	}
	if targetID != 42 || !strings.Contains(details, `"application_id":"42"`) || !strings.Contains(details, `"asset":"product"`) || !strings.Contains(details, `"storage":"picui"`) || !strings.Contains(details, `"event_code":"beijing"`) {
		t.Fatalf("multipart audit lost business fields: target=%d details=%s", targetID, details)
	}
	if strings.Contains(details, "never-log-this") || strings.Contains(details, "private-filename.png") || strings.Contains(details, "image contents") {
		t.Fatalf("multipart audit recorded private input: %s", details)
	}
}

func TestAutomaticAuditPreservesBusinessDecision(t *testing.T) {
	server := newAuditTestServer(t)
	server.mux = http.NewServeMux()
	server.mux.HandleFunc("/api/galonly.php", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"success": true, "decision": "reject", "result": "rejected"})
	})
	req := httptest.NewRequest(http.MethodPost, "http://test/api/galonly.php?action=resolve", strings.NewReader(`{"application_id":42,"decision":"reject"}`))
	req.Header.Set("Content-Type", "application/json")
	server.ServeHTTP(httptest.NewRecorder(), req)
	var details string
	if err := server.db.QueryRow(`SELECT details FROM audit_logs LIMIT 1`).Scan(&details); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(details, `"result":"rejected"`) || !strings.Contains(details, `"decision":"reject"`) {
		t.Fatalf("business decision overwritten: %s", details)
	}
}

func TestBoothTrackingIsNotReportedAsSuccessfulAdminOperation(t *testing.T) {
	server := newAuditTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "http://test/api/galonly_booths.php?action=track", strings.NewReader(`{"event_code":"beijing"}`))
	if !server.shouldSkipAutomaticAudit(req) {
		t.Fatal("best-effort tracking returns 204 on failure and must not become a successful operation log")
	}
}

func newAuditTestServer(t *testing.T) *Server {
	t.Helper()
	root := t.TempDir()
	cfg := config.Config{Root: root, SiteURL: "http://test", DBDriver: "sqlite", DBPath: filepath.Join(root, "audit.db"), DataDir: root, UploadDir: root}
	db, err := sqlstore.Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`CREATE TABLE audit_logs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER,
		action TEXT NOT NULL,
		target_type TEXT,
		target_id INTEGER,
		details TEXT,
		ip_address TEXT,
		created_at TEXT DEFAULT CURRENT_TIMESTAMP
	)`); err != nil {
		t.Fatal(err)
	}
	return &Server{cfg: cfg, db: db, files: filestore.New(root, root)}
}

func TestRecordAuditSanitizesSecretsAndPreservesOperationContext(t *testing.T) {
	server := newAuditTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "http://test/api/auth.php?action=change_password&code=654321&token=secret-token", nil)
	req.RemoteAddr = "198.51.100.7:4321"
	req.Header.Set("User-Agent", strings.Repeat("A", 700))
	actor := &user{ID: 7, Role: "super_admin"}
	server.recordAudit(req.Context(), req, actor, "user.change_password", "user", int64Ptr(19), map[string]any{
		"email":        "admin@example.com",
		"password":     "do-not-store",
		"code":         "654321",
		"access_token": "secret-token",
		"result":       "success",
	})

	var userID, targetID sql.NullInt64
	var action, details, ip string
	if err := server.db.QueryRow(`SELECT user_id, action, target_id, details, ip_address FROM audit_logs LIMIT 1`).Scan(&userID, &action, &targetID, &details, &ip); err != nil {
		t.Fatal(err)
	}
	if !userID.Valid || userID.Int64 != 7 || action != "user.change_password" || !targetID.Valid || targetID.Int64 != 19 || ip != "198.51.100.7" {
		t.Fatalf("unexpected audit row: user=%v action=%q target=%v ip=%q", userID, action, targetID, ip)
	}
	if strings.Contains(details, "do-not-store") || strings.Contains(details, "654321") || strings.Contains(details, "secret-token") {
		t.Fatalf("sensitive value entered audit details: %s", details)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(details), &decoded); err != nil {
		t.Fatal(err)
	}
	contextValue, ok := decoded["_context"].(map[string]any)
	if !ok {
		t.Fatalf("missing request context: %s", details)
	}
	if contextValue["method"] != "POST" || contextValue["path"] != "/api/auth.php" || contextValue["actor_role"] != "super_admin" {
		t.Fatalf("unexpected request context: %#v", contextValue)
	}
	if len(contextValue["user_agent"].(string)) != 500 {
		t.Fatalf("user agent was not bounded: %d", len(contextValue["user_agent"].(string)))
	}
}

func TestLegacyAdminTokenAuditHasSuperAdminRoleWithoutUserID(t *testing.T) {
	server := newAuditTestServer(t)
	server.cfg.LegacyAuthEnabled = true
	server.cfg.AdminToken = "admin-token-for-test"
	req := httptest.NewRequest(http.MethodPost, "http://test/api/users.php?action=update", nil)
	req.Header.Set("X-Admin-Token", server.cfg.AdminToken)
	actor := server.auditActor(req)
	if actor == nil || actor.ID != 0 || actor.Role != "super_admin" {
		t.Fatalf("legacy token actor mismatch: %#v", actor)
	}
	server.recordAudit(req.Context(), req, actor, "users.update", "user", nil, nil)
	var userID sql.NullInt64
	var details string
	if err := server.db.QueryRow(`SELECT user_id, details FROM audit_logs LIMIT 1`).Scan(&userID, &details); err != nil {
		t.Fatal(err)
	}
	if userID.Valid {
		t.Fatalf("legacy token unexpectedly received user id %d", userID.Int64)
	}
	if !strings.Contains(details, `"actor_role":"super_admin"`) {
		t.Fatalf("legacy token role missing: %s", details)
	}
}

func TestAutomaticAuditRunsAfterSuccessfulHandler(t *testing.T) {
	server := newAuditTestServer(t)
	server.mux = http.NewServeMux()
	committed := false
	server.mux.HandleFunc("/api/audit_fixture.php", func(w http.ResponseWriter, r *http.Request) {
		committed = true
		writeJSON(w, map[string]any{"success": true, "id": 41})
	})
	req := httptest.NewRequest(http.MethodPost, "http://test/api/audit_fixture.php?action=create&token=not-logged", strings.NewReader(`{"id":41,"password":"hidden"}`))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "203.0.113.8:80"
	res := httptest.NewRecorder()
	server.ServeHTTP(res, req)
	if res.Code != http.StatusOK || !committed {
		t.Fatalf("business response failed: status=%d body=%s", res.Code, res.Body.String())
	}
	var action, details string
	if err := server.db.QueryRow(`SELECT action, details FROM audit_logs LIMIT 1`).Scan(&action, &details); err != nil {
		t.Fatal(err)
	}
	if action != "audit_fixture.create" || strings.Contains(details, "hidden") || !strings.Contains(details, `"result":"success"`) {
		t.Fatalf("unexpected automatic audit: action=%q details=%s", action, details)
	}
}

func TestAuditWriteFailureDoesNotChangeBusinessResponse(t *testing.T) {
	server := newAuditTestServer(t)
	if err := server.db.Close(); err != nil {
		t.Fatal(err)
	}
	server.mux = http.NewServeMux()
	server.mux.HandleFunc("/api/audit_failure_fixture.php", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"success": true, "committed": true})
	})
	req := httptest.NewRequest(http.MethodPost, "http://test/api/audit_failure_fixture.php?action=update", nil)
	res := httptest.NewRecorder()
	server.ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"committed":true`) {
		t.Fatalf("audit failure changed successful business response: status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestAdminLogsQueryContract(t *testing.T) {
	server := newAuditTestServer(t)
	if _, err := server.db.Exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, nickname TEXT, role TEXT, status TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err := server.db.Exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, ip_address TEXT, user_agent TEXT, expires_at DATETIME, is_valid INTEGER DEFAULT 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := server.db.Exec(`INSERT INTO users(id, username, nickname, role, status) VALUES (1, 'root', '超级管理员', 'super_admin', 'active'), (2, 'member', '普通用户', 'member', 'active')`); err != nil {
		t.Fatal(err)
	}
	adminSession := strings.Repeat("a", 32)
	memberSession := strings.Repeat("b", 32)
	if _, err := server.db.Exec(`INSERT INTO sessions(id, user_id, expires_at, is_valid) VALUES (?, 1, ?, 1), (?, 2, ?, 1)`, adminSession, time.Now().Add(time.Hour), memberSession, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	server.sessions = &sessionstore.Manager{Store: sessionstore.New(server.db), CookieName: "PHPSESSID", Lifetime: time.Hour}
	rows := []struct {
		action, target, details, created string
	}{
		{"user.login", "user", `{"provider":"local"}`, "2026-09-20 10:00:00"},
		{"membership.approve", "club_membership", `{"status":"approved"}`, "2026-09-20 09:00:00"},
		{"add_recommendation", "club_recommendations", `{}`, "2026-09-19 10:00:00"},
		{"mystery.maintenance", "system", `{"name":"nightly"}`, "2026-09-18 10:00:00"},
		{"bot.create", "bot", `{}`, "2026-09-17 10:00:00"},
	}
	for _, row := range rows {
		if _, err := server.db.Exec(`INSERT INTO audit_logs(user_id, action, target_type, target_id, details, ip_address, created_at) VALUES (1, ?, ?, 1, ?, '127.0.0.1', ?)`, row.action, row.target, row.details, row.created); err != nil {
			t.Fatal(err)
		}
	}
	request := func(session, query string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "http://test/api/admin_logs.php?"+query, nil)
		req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: session})
		res := httptest.NewRecorder()
		server.adminLogs(res, req)
		return res
	}
	if res := request(adminSession, "action=list&type=all&per_page=2&page=1"); res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"total":5`) || !strings.Contains(res.Body.String(), `"per_page":2`) {
		t.Fatalf("all/pagination query failed: status=%d body=%s", res.Code, res.Body.String())
	}
	if res := request(adminSession, "action=list&type=auth"); !strings.Contains(res.Body.String(), `"total":1`) {
		t.Fatalf("auth filter failed: %s", res.Body.String())
	}
	if res := request(adminSession, "action=list&type=club"); !strings.Contains(res.Body.String(), `"total":2`) {
		t.Fatalf("club filter failed: %s", res.Body.String())
	}
	if res := request(adminSession, "action=list&type=system"); !strings.Contains(res.Body.String(), `"total":1`) {
		t.Fatalf("system filter failed: %s", res.Body.String())
	}
	if res := request(adminSession, "action=list&date_from=2026-09-19&date_to=2026-09-20&search=approve"); !strings.Contains(res.Body.String(), `"total":1`) {
		t.Fatalf("date/search filter failed: %s", res.Body.String())
	}
	if res := request(memberSession, "action=list&type=all"); res.Code != http.StatusForbidden {
		t.Fatalf("non-super-admin was not denied: status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestAuditTypeConditionsMatchPHPContract(t *testing.T) {
	auth := auditTypeCondition("auth")
	if !strings.Contains(auth, "al.action IN") || strings.Contains(auth, "LIKE 'user.%code%'") {
		t.Fatalf("auth condition is not the PHP allowlist: %s", auth)
	}
	club := auditTypeCondition("club")
	for _, value := range []string{"generate_club_code", "delete_club_comment", "add_recommendation", "club_moe_king.%", "star_union.%"} {
		if !strings.Contains(club, value) {
			t.Fatalf("club condition missing %q: %s", value, club)
		}
	}
	system := auditTypeCondition("system")
	if !strings.HasPrefix(system, "NOT (") || !strings.Contains(system, "al.action LIKE 'bot.%'") {
		t.Fatalf("system condition does not exclude known categories: %s", system)
	}
}

func TestAuditActionCompatibilityNames(t *testing.T) {
	cases := []struct {
		path, action, want string
	}{
		{"/api/membership.php", "approve", "membership.approve"},
		{"/api/club_codes.php", "generate", "generate_club_code"},
		{"/api/recognition_programs.php", "create", "recog_program_created"},
		{"/api/vote_projects.php", "share", "vote_project.share_token_issue"},
		{"/api/bangumi_callback.php", "", "user.bind_bangumi"},
	}
	for _, item := range cases {
		req := httptest.NewRequest(http.MethodPost, "http://test"+item.path+"?action="+item.action, nil)
		action, _, _, ok := auditActionForRequest(req, nil, []byte(`{"success":true,"id":1}`))
		if !ok || action != item.want {
			t.Errorf("%s action %q: got %q (ok=%v), want %q", item.path, item.action, action, ok, item.want)
		}
	}
}

func int64Ptr(value int64) *int64 { return &value }
