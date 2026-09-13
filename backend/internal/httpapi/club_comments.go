package httpapi

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"
)

func (s *Server) clubComments(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	switch action {
	case "list":
		s.clubCommentsList(w, r)
	case "add":
		s.clubCommentsAdd(w, r)
	case "delete":
		s.clubCommentsDelete(w, r)
	default:
		writeJSON(w, map[string]any{"success": false, "message": "未知操作 action=" + action})
	}
}

func (s *Server) clubCommentsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	clubID := parsePositiveInt(r.URL.Query().Get("club_id"))
	country := clubCodeCountry(r.URL.Query().Get("country"))
	page := parsePositiveInt(r.URL.Query().Get("page"))
	if page <= 0 {
		page = 1
	}
	limit := parsePositiveInt(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 20
	}
	if limit > 50 {
		limit = 50
	}
	if clubID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效的同好会 ID"})
		return
	}
	var total int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM club_comments WHERE club_id = ? AND country = ? AND is_deleted = 0", clubID, country).Scan(&total); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取留言失败"})
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT c.id, c.club_id, c.user_id, c.content, c.created_at, c.updated_at,
        u.username, u.avatar_url, u.nickname
        FROM club_comments c JOIN users u ON u.id = c.user_id
        WHERE c.club_id = ? AND c.country = ? AND c.is_deleted = 0
        ORDER BY c.created_at DESC LIMIT ? OFFSET ?`, clubID, country, limit, (page-1)*limit)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取留言失败"})
		return
	}
	defer rows.Close()
	comments := make([]map[string]any, 0)
	for rows.Next() {
		var id, rowClubID, userID int64
		var content string
		var createdAt, username, avatar, nickname sql.NullString
		var updatedAt sql.NullString
		if err := rows.Scan(&id, &rowClubID, &userID, &content, &createdAt, &updatedAt, &username, &avatar, &nickname); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取留言失败"})
			return
		}
		comments = append(comments, map[string]any{"id": id, "club_id": rowClubID, "user_id": userID, "content": content, "created_at": nullableStringCompat(createdAt), "updated_at": nullableStringCompat(updatedAt), "username": nullableStringCompat(username), "avatar_url": nullableStringCompat(avatar), "nickname": nullableStringCompat(nickname)})
	}
	if err := rows.Err(); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取留言失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "data": comments, "total": total, "page": page, "limit": limit})
}

func (s *Server) clubCommentsAdd(w http.ResponseWriter, r *http.Request) {
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
	content := strings.TrimSpace(stringValue(input["content"]))
	if clubID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效的同好会 ID"})
		return
	}
	if content == "" {
		writeJSON(w, map[string]any{"success": false, "message": "请输入留言内容"})
		return
	}
	if len([]rune(content)) > 1000 {
		writeJSON(w, map[string]any{"success": false, "message": "留言内容不能超过 1000 字"})
		return
	}
	if !s.clubActiveMember(r.Context(), user.ID, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "仅同好会成员可留言"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), "INSERT INTO club_comments (club_id, country, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)", clubID, country, user.ID, content, time.Now().Format("2006-01-02 15:04:05"))
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "留言失败"})
		return
	}
	id, err := result.LastInsertId()
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "留言失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "留言成功", "id": id})
}

func (s *Server) clubCommentsDelete(w http.ResponseWriter, r *http.Request) {
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
	if err := decodeJSON(r, &input, 1<<20); err != nil || input == nil || integerValue(input["id"]) <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效数据"})
		return
	}
	commentID := integerValue(input["id"])
	var clubID, ownerID int64
	var country string
	if err := s.db.QueryRowContext(r.Context(), "SELECT club_id, country, user_id FROM club_comments WHERE id = ? AND is_deleted = 0", commentID).Scan(&clubID, &country, &ownerID); err != nil {
		if err == sql.ErrNoRows {
			writeJSON(w, map[string]any{"success": false, "message": "留言不存在"})
		} else {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取留言失败"})
		}
		return
	}
	if ownerID != user.ID && !s.canManageClubCodes(r.Context(), user, clubID, clubCodeCountry(country)) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权删除此留言"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE club_comments SET is_deleted = 1 WHERE id = ?", commentID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "删除留言失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "留言已删除"})
}

func (s *Server) clubActiveMember(ctx context.Context, userID, clubID int64, country string) bool {
	var id int64
	if err := s.db.QueryRowContext(ctx, "SELECT id FROM club_memberships WHERE user_id = ? AND club_id = ? AND country = ? AND status = 'active' AND role <> 'external' LIMIT 1", userID, clubID, country).Scan(&id); err == nil {
		return true
	}
	return s.db.QueryRowContext(ctx, "SELECT id FROM club_memberships WHERE user_id = ? AND club_id = ? AND status = 'active' AND role <> 'external' LIMIT 1", userID, clubID).Scan(&id) == nil
}

func nullableStringCompat(value sql.NullString) any {
	if value.Valid {
		return value.String
	}
	return nil
}
