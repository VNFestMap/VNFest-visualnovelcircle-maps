package httpapi

import (
	"context"
	"crypto/rand"
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

const clubCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func (s *Server) clubCodes(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	switch action {
	case "list":
		s.clubCodeList(w, r)
	case "generate":
		s.clubCodeGenerate(w, r)
	case "revoke":
		s.clubCodeRevoke(w, r)
	case "redeem":
		s.clubCodeRedeem(w, r)
	default:
		writeJSON(w, map[string]any{"success": false, "message": "未知操作 action=" + action})
	}
}

func (s *Server) clubCodeList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	clubID := parsePositiveInt(r.URL.Query().Get("club_id"))
	country := clubCodeCountry(r.URL.Query().Get("country"))
	if clubID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效的同好会 ID"})
		return
	}
	if !s.canManageClubCodes(r.Context(), user, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权查看绑定码"})
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT id, club_id, code, created_by, max_uses, use_count, expires_at, is_active, created_at
        FROM club_verification_codes WHERE club_id = ? AND (country = ? OR country = '' OR country IS NULL) ORDER BY created_at DESC`, clubID, country)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取绑定码失败"})
		return
	}
	defer rows.Close()
	result := make([]map[string]any, 0)
	now := time.Now()
	for rows.Next() {
		var id, rowClubID, createdBy, maxUses, useCount int64
		var code, expires, createdAt sql.NullString
		var active int64
		if err := rows.Scan(&id, &rowClubID, &code, &createdBy, &maxUses, &useCount, &expires, &active, &createdAt); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取绑定码失败"})
			return
		}
		expired := clubCodeExpired(expires.String, now)
		result = append(result, map[string]any{
			"id": id, "club_id": rowClubID, "code": code.String, "created_by": createdBy,
			"max_uses": maxUses, "use_count": useCount, "expires_at": clubCodeNullableString(expires),
			"is_active": active, "created_at": createdAt.String, "is_expired": expired,
			"is_full": useCount >= maxUses, "is_valid": active != 0 && !expired && useCount < maxUses,
		})
	}
	if err := rows.Err(); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取绑定码失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "codes": result})
}

func (s *Server) clubCodeGenerate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 1<<20); err != nil || input == nil {
		writeJSON(w, map[string]any{"success": false, "message": "请求数据格式错误"})
		return
	}
	clubID := integerValue(input["club_id"])
	country := clubCodeCountry(stringValue(input["country"]))
	maxUses := integerValue(input["max_uses"])
	if maxUses == 0 {
		maxUses = 50
	}
	expiresAt := nullableInputString(input["expires_at"])
	if clubID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效的同好会 ID"})
		return
	}
	if !s.canManageClubCodes(r.Context(), user, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权生成绑定码"})
		return
	}
	if maxUses < 1 || maxUses > 999 {
		writeJSON(w, map[string]any{"success": false, "message": "使用次数需在 1-999 之间"})
		return
	}
	code, err := uniqueClubCode(r.Context(), s.db)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "绑定码生成失败"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), `INSERT INTO club_verification_codes (club_id, code, created_by, max_uses, expires_at, country) VALUES (?, ?, ?, ?, ?, ?)`, clubID, code, user.ID, maxUses, expiresAt, country)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "绑定码生成失败"})
		return
	}
	id, err := result.LastInsertId()
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "绑定码生成失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "绑定码生成成功", "code": map[string]any{
		"id": id, "club_id": clubID, "code": code, "max_uses": maxUses, "use_count": 0,
		"expires_at": expiresAt, "is_active": 1, "created_at": time.Now().Format("2006-01-02 15:04:05"),
	}})
}

func (s *Server) clubCodeRevoke(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 1<<20); err != nil || input == nil || integerValue(input["code_id"]) <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效数据"})
		return
	}
	codeID := integerValue(input["code_id"])
	var clubID int64
	var country, code string
	if err := s.db.QueryRowContext(r.Context(), "SELECT club_id, COALESCE(country,'china'), code FROM club_verification_codes WHERE id = ?", codeID).Scan(&clubID, &country, &code); err != nil {
		if err == sql.ErrNoRows {
			writeJSON(w, map[string]any{"success": false, "message": "绑定码不存在"})
		} else {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取绑定码失败"})
		}
		return
	}
	if !s.canManageClubCodes(r.Context(), user, clubID, clubCodeCountry(country)) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权禁用此绑定码"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE club_verification_codes SET is_active = 0 WHERE id = ?", codeID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "禁用绑定码失败"})
		return
	}
	_ = code
	writeJSON(w, map[string]any{"success": true, "message": "绑定码已禁用"})
}

func (s *Server) clubCodeRedeem(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 1<<20); err != nil || input == nil {
		writeJSON(w, map[string]any{"success": false, "message": "请求数据格式错误"})
		return
	}
	code := strings.ToUpper(strings.TrimSpace(stringValue(input["code"])))
	if code == "" {
		writeJSON(w, map[string]any{"success": false, "message": "请填写绑定码"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "绑定失败，请稍后再试"})
		return
	}
	defer tx.Rollback()
	query := `SELECT id, club_id, max_uses, use_count, expires_at, is_active, country FROM club_verification_codes WHERE code = ?`
	if s.cfg.DBDriver == "mysql" {
		query += " FOR UPDATE"
	}
	var codeID, clubID, maxUses, useCount, active int64
	var expires sql.NullString
	var country string
	if err := tx.QueryRowContext(r.Context(), query, code).Scan(&codeID, &clubID, &maxUses, &useCount, &expires, &active, &country); err != nil {
		if err == sql.ErrNoRows {
			writeJSON(w, map[string]any{"success": false, "message": "绑定码无效"})
		} else {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "绑定失败，请稍后再试"})
		}
		return
	}
	if active == 0 {
		writeJSON(w, map[string]any{"success": false, "message": "绑定码已被禁用"})
		return
	}
	if clubCodeExpired(expires.String, time.Now()) {
		writeJSON(w, map[string]any{"success": false, "message": "绑定码已过期"})
		return
	}
	if useCount >= maxUses {
		writeJSON(w, map[string]any{"success": false, "message": "绑定码已达使用上限"})
		return
	}
	country = clubCodeCountry(country)
	joinedAt := time.Now().Format("2006-01-02 15:04:05")
	var membershipID int64
	var membershipStatus string
	membershipErr := tx.QueryRowContext(r.Context(), "SELECT id, status FROM club_memberships WHERE user_id = ? AND club_id = ? AND country = ?", user.ID, clubID, country).Scan(&membershipID, &membershipStatus)
	if membershipErr != nil && membershipErr != sql.ErrNoRows {
		// Older deployments may not have country yet. Keep the PHP fallback query.
		membershipErr = tx.QueryRowContext(r.Context(), "SELECT id, status FROM club_memberships WHERE user_id = ? AND club_id = ?", user.ID, clubID).Scan(&membershipID, &membershipStatus)
	}
	if membershipErr == nil && membershipStatus == "active" {
		writeJSON(w, map[string]any{"success": false, "message": "你已经是该同好会的成员"})
		return
	}
	if membershipErr == nil {
		if _, err = tx.ExecContext(r.Context(), "UPDATE club_memberships SET status = 'active', role = 'member', join_method = 'school_code', joined_at = ?, left_at = NULL WHERE id = ?", joinedAt, membershipID); err != nil {
			// Keep compatibility with old schemas which do not yet have the additive columns.
			_, err = tx.ExecContext(r.Context(), "UPDATE club_memberships SET status = 'active', role = 'member', joined_at = ? WHERE id = ?", joinedAt, membershipID)
		}
	} else if membershipErr == sql.ErrNoRows {
		_, err = tx.ExecContext(r.Context(), "INSERT INTO club_memberships (user_id, club_id, country, role, status, join_method, joined_at) VALUES (?, ?, ?, 'member', 'active', 'school_code', ?)", user.ID, clubID, country, joinedAt)
		if err != nil {
			_, err = tx.ExecContext(r.Context(), "INSERT INTO club_memberships (user_id, club_id, role, status, joined_at) VALUES (?, ?, 'member', 'active', ?)", user.ID, clubID, joinedAt)
		}
	}
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "绑定失败，请稍后再试"})
		return
	}
	result, err := tx.ExecContext(r.Context(), "UPDATE club_verification_codes SET use_count = use_count + 1 WHERE id = ? AND is_active = 1 AND use_count < max_uses", codeID)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "绑定失败，请稍后再试"})
		return
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		writeJSON(w, map[string]any{"success": false, "message": "绑定码已达使用上限"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "绑定失败，请稍后再试"})
		return
	}
	clubName := s.clubCodeClubName(r.Context(), clubID, country)
	s.clubCodeNotify(r.Context(), user.ID, clubID, clubName)
	writeJSON(w, map[string]any{"success": true, "message": "已通过绑定码加入同好会「" + clubName + "」", "club_name": clubName})
}

func (s *Server) clubCodeUserResponse(w http.ResponseWriter, r *http.Request) (*user, bool) {
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return nil, false
	}
	user, err := s.findUser(r.Context(), userID)
	if err != nil || user == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return nil, false
	}
	return user, true
}

func (s *Server) canManageClubCodes(ctx context.Context, user *user, clubID int64, country string) bool {
	if user != nil && user.Role == "super_admin" {
		return true
	}
	if user == nil || s.db == nil {
		return false
	}
	var id int64
	err := s.db.QueryRowContext(ctx, `SELECT id FROM club_memberships WHERE user_id = ? AND club_id = ? AND country = ? AND role IN ('representative','manager') AND status = 'active' LIMIT 1`, user.ID, clubID, country).Scan(&id)
	return err == nil
}

func uniqueClubCode(ctx context.Context, db *sqlstore.DB) (string, error) {
	for attempt := 0; attempt < 10; attempt++ {
		code, err := newClubCode()
		if err != nil {
			return "", err
		}
		var exists int
		if err := db.QueryRowContext(ctx, "SELECT 1 FROM club_verification_codes WHERE code = ? LIMIT 1", code).Scan(&exists); err == sql.ErrNoRows {
			return code, nil
		} else if err != nil {
			return "", err
		}
	}
	return "", fmt.Errorf("unable to allocate unique club code")
}

func newClubCode() (string, error) {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	var builder strings.Builder
	builder.Grow(len(raw))
	for _, value := range raw {
		builder.WriteByte(clubCodeAlphabet[int(value)%len(clubCodeAlphabet)])
	}
	return builder.String(), nil
}

func (s *Server) clubCodeClubName(ctx context.Context, clubID int64, country string) string {
	fileName := "clubs.json"
	if country == "japan" {
		fileName = "clubs_japan.json"
	}
	document := s.projectHubReadMap(ctx, fileName, map[string]any{"data": []any{}})
	for _, row := range mapSlice(document["data"]) {
		if integerValue(row["id"]) == clubID {
			return firstNonEmpty(stringValue(row["display_name"]), firstNonEmpty(stringValue(row["name"]), firstNonEmpty(stringValue(row["school"]), "同好会#"+strconvInt(clubID))))
		}
	}
	return "同好会#" + strconvInt(clubID)
}

func (s *Server) clubCodeNotify(ctx context.Context, userID, clubID int64, clubName string) {
	if s.db == nil {
		return
	}
	if exists, _ := s.db.TableExists(ctx, "notifications"); !exists {
		return
	}
	_, _ = s.db.ExecContext(ctx, `INSERT INTO notifications(user_id, type, title, message, link, related_type, related_id) VALUES (?, ?, ?, ?, ?, ?, ?)`, userID, "join_approved", "同好会加入成功", "你已通过绑定码加入同好会「"+clubName+"」", "", "club", clubID)
}

func clubCodeCountry(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "japan") {
		return "japan"
	}
	return "china"
}

func clubCodeExpired(value string, now time.Time) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return false
	}
	for _, layout := range []string{"2006-01-02 15:04:05", time.RFC3339, "2006-01-02"} {
		if parsed, err := time.ParseInLocation(layout, value, time.Local); err == nil {
			return parsed.Before(now)
		}
	}
	return value < now.Format("2006-01-02 15:04:05")
}

func clubCodeNullableString(value sql.NullString) any {
	if !value.Valid {
		return nil
	}
	return value.String
}

func nullableInputString(value any) any {
	if value == nil {
		return nil
	}
	value = strings.TrimSpace(stringValue(value))
	if value == "" {
		return nil
	}
	return value
}
