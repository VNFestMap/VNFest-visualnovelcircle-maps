package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/filestore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sessionstore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

func TestClubCodesGenerateListRedeemCompatibility(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{Root: root, SiteURL: "http://test", DBDriver: "sqlite", DBPath: filepath.Join(root, "test.db"), DataDir: root, UploadDir: root, SessionLifetime: 3600}
	db, err := sqlstore.Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, nickname TEXT, avatar_url TEXT, role TEXT NOT NULL, status TEXT NOT NULL, email TEXT, email_verified_at TEXT, password_hash TEXT, qq_openid TEXT, discord_id TEXT, is_audit INTEGER DEFAULT 0, profile_bio TEXT, membership_application_email_enabled INTEGER DEFAULT 1, display_membership_id INTEGER, language_preference TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, ip_address TEXT, user_agent TEXT, expires_at TEXT NOT NULL, is_valid INTEGER NOT NULL DEFAULT 1)`,
		`CREATE TABLE club_memberships (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, club_id INTEGER NOT NULL, country TEXT NOT NULL DEFAULT 'china', role TEXT NOT NULL, status TEXT NOT NULL, join_method TEXT, joined_at TEXT, left_at TEXT)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := sqlstore.Apply(context.Background(), db, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO users(id,username,nickname,role,status) VALUES (1,'admin','管理员','super_admin','active'),(2,'member','成员','member','active')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO club_memberships(user_id,club_id,country,role,status) VALUES (1,7,'china','representative','active')`); err != nil {
		t.Fatal(err)
	}
	files := filestore.New(root, root)
	if err := files.WriteJSONAtomic(context.Background(), "clubs.json", map[string]any{"data": []any{map[string]any{"id": 7, "name": "测试同好会"}}}); err != nil {
		t.Fatal(err)
	}
	sessions := sessionstore.New(db)
	for _, item := range []struct {
		id  string
		uid int64
	}{{"admin-session", 1}, {"member-session", 2}} {
		uid := item.uid
		if err := sessions.Save(context.Background(), &sessionstore.Session{ID: item.id, UserID: &uid, Payload: map[string]any{"user_id": uid}, ExpiresAt: time.Now().Add(time.Hour), Valid: true}); err != nil {
			t.Fatal(err)
		}
	}
	server, err := New(cfg, db, files, &sessionstore.Manager{Store: sessions, CookieName: "PHPSESSID"})
	if err != nil {
		t.Fatal(err)
	}
	request := func(sessionID, method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://test"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://test")
		req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sessionID})
		res := httptest.NewRecorder()
		server.ServeHTTP(res, req)
		return res
	}

	generated := request("admin-session", http.MethodPost, "/api/club_codes.php?action=generate", `{"club_id":7,"max_uses":1}`)
	if generated.Code != http.StatusOK {
		t.Fatalf("generate status=%d body=%s", generated.Code, generated.Body.String())
	}
	var generatedPayload struct {
		Code map[string]any `json:"code"`
	}
	if err := json.Unmarshal(generated.Body.Bytes(), &generatedPayload); err != nil {
		t.Fatal(err)
	}
	code := stringValue(generatedPayload.Code["code"])
	if len(code) != 8 {
		t.Fatalf("unexpected generated code: %#v", generatedPayload.Code)
	}

	listed := request("admin-session", http.MethodGet, "/api/club_codes.php?action=list&club_id=7", "")
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), code) {
		t.Fatalf("list status=%d body=%s", listed.Code, listed.Body.String())
	}
	redeemed := request("member-session", http.MethodPost, "/api/club_codes.php?action=redeem", `{"code":"`+code+`"}`)
	if redeemed.Code != http.StatusOK || !strings.Contains(redeemed.Body.String(), "测试同好会") {
		t.Fatalf("redeem status=%d body=%s", redeemed.Code, redeemed.Body.String())
	}
	var membershipStatus string
	if err := db.QueryRow(`SELECT status FROM club_memberships WHERE user_id=2 AND club_id=7 AND country='china'`).Scan(&membershipStatus); err != nil {
		t.Fatal(err)
	}
	if membershipStatus != "active" {
		t.Fatalf("membership status=%q", membershipStatus)
	}
	redeemedAgain := request("member-session", http.MethodPost, "/api/club_codes.php?action=redeem", `{"code":"`+code+`"}`)
	if redeemedAgain.Code != http.StatusOK || !strings.Contains(redeemedAgain.Body.String(), "达使用上限") {
		t.Fatalf("redeem duplicate status=%d body=%s", redeemedAgain.Code, redeemedAgain.Body.String())
	}
	comment := request("member-session", http.MethodPost, "/api/club_comments.php?action=add", `{"club_id":7,"content":"留言兼容性检查"}`)
	if comment.Code != http.StatusOK || !strings.Contains(comment.Body.String(), "留言成功") {
		t.Fatalf("comment add status=%d body=%s", comment.Code, comment.Body.String())
	}
	var commentPayload struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(comment.Body.Bytes(), &commentPayload); err != nil || commentPayload.ID <= 0 {
		t.Fatalf("comment payload: %s", comment.Body.String())
	}
	commentList := request("", http.MethodGet, "/api/club_comments.php?action=list&club_id=7", "")
	if commentList.Code != http.StatusOK || !strings.Contains(commentList.Body.String(), "留言兼容性检查") {
		t.Fatalf("comment list status=%d body=%s", commentList.Code, commentList.Body.String())
	}
	deletedComment := request("member-session", http.MethodPost, "/api/club_comments.php?action=delete", `{"id":`+strconv.FormatInt(commentPayload.ID, 10)+`}`)
	if deletedComment.Code != http.StatusOK || !strings.Contains(deletedComment.Body.String(), "留言已删除") {
		t.Fatalf("comment delete status=%d body=%s", deletedComment.Code, deletedComment.Body.String())
	}
	recommendation := request("admin-session", http.MethodPost, "/api/club_recommendations.php?action=add", `{"club_id":7,"bangumi_id":123,"title":"测试推荐","rating":8.5}`)
	if recommendation.Code != http.StatusOK || !strings.Contains(recommendation.Body.String(), "已添加推荐") {
		t.Fatalf("recommendation add status=%d body=%s", recommendation.Code, recommendation.Body.String())
	}
	var recommendationPayload struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(recommendation.Body.Bytes(), &recommendationPayload); err != nil || recommendationPayload.ID <= 0 {
		t.Fatalf("recommendation payload: %s", recommendation.Body.String())
	}
	listRecommendation := request("", http.MethodGet, "/api/club_recommendations.php?action=list&club_id=7", "")
	if listRecommendation.Code != http.StatusOK || !strings.Contains(listRecommendation.Body.String(), "测试推荐") {
		t.Fatalf("recommendation list status=%d body=%s", listRecommendation.Code, listRecommendation.Body.String())
	}
	slots := make([]string, 12)
	for index := range slots {
		slots[index] = "null"
	}
	slots[0] = strconv.FormatInt(recommendationPayload.ID, 10)
	ordered := request("admin-session", http.MethodPost, "/api/club_recommendations.php?action=reorder", `{"slots":[`+strings.Join(slots, ",")+"]}")
	if ordered.Code != http.StatusOK || !strings.Contains(ordered.Body.String(), "排序已更新") {
		t.Fatalf("recommendation reorder status=%d body=%s", ordered.Code, ordered.Body.String())
	}
	removedRecommendation := request("admin-session", http.MethodPost, "/api/club_recommendations.php?action=remove", `{"id":`+strconv.FormatInt(recommendationPayload.ID, 10)+`}`)
	if removedRecommendation.Code != http.StatusOK || !strings.Contains(removedRecommendation.Body.String(), "已移除推荐") {
		t.Fatalf("recommendation remove status=%d body=%s", removedRecommendation.Code, removedRecommendation.Body.String())
	}
	revoked := request("admin-session", http.MethodPost, "/api/club_codes.php?action=revoke", `{"code_id":1}`)
	if revoked.Code != http.StatusOK || !strings.Contains(revoked.Body.String(), "已禁用") {
		t.Fatalf("revoke status=%d body=%s", revoked.Code, revoked.Body.String())
	}
}
