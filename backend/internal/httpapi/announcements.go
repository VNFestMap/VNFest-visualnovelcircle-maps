package httpapi

import (
	"database/sql"
	"net/http"
	"strings"
)

// announcementAction is the complete action surface of api/announcements.php.
// Keeping the administrative actions here, instead of forwarding them through
// the compatibility proxy, is important because publishing an announcement
// also creates notifications for active users.
func (s *Server) announcementAction(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if s.db == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "数据库不可用"})
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	switch action {
	case "active":
		if r.Method != http.MethodGet {
			writeJSON(w, map[string]any{"success": false, "message": "仅支持 GET 请求"})
			return
		}
		s.announcementList(w, r, true)
	case "list":
		if r.Method != http.MethodGet {
			writeJSON(w, map[string]any{"success": false, "message": "仅支持 GET 请求"})
			return
		}
		if !s.announcementSuperAdmin(w, r) {
			return
		}
		s.announcementList(w, r, false)
	case "create", "update", "publish", "delete":
		if r.Method != http.MethodPost {
			writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST 请求"})
			return
		}
		if !s.announcementSuperAdmin(w, r) {
			return
		}
		s.announcementWrite(w, r, action)
	default:
		writeJSON(w, map[string]any{"success": false, "message": "未知操作"})
	}
}

func (s *Server) announcementSuperAdmin(w http.ResponseWriter, r *http.Request) bool {
	userID, role := s.optionalSessionUser(r)
	if userID != nil && role == "super_admin" {
		return true
	}
	// Preserve the existing transition-only X-Admin-Token behavior. The
	// legacy PHP implementation treats a valid token as a super administrator
	// even though it has no users.id to attach to the row.
	if _, ok := s.adminUserID(r); ok && userID == nil && s.cfg.LegacyAuthEnabled && strings.TrimSpace(r.Header.Get("X-Admin-Token")) != "" {
		return true
	}
	if userID == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
	} else {
		writeJSON(w, map[string]any{"success": false, "message": "权限不足"})
	}
	return false
}

func (s *Server) announcementList(w http.ResponseWriter, r *http.Request, activeOnly bool) {
	query := `SELECT id,title,content,type,is_persistent,created_at,published_at FROM announcements`
	if !activeOnly {
		query = `SELECT id,title,content,type,status, is_persistent,created_by,created_at,published_at FROM announcements ORDER BY created_at DESC`
	} else {
		query += ` WHERE status='published' AND is_persistent=1 ORDER BY published_at DESC LIMIT 20`
	}
	rows, err := s.db.QueryContext(r.Context(), query)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "无法读取公告"})
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		if activeOnly {
			var id, persistent any
			var title, content, typ any
			var created, published any
			if err := rows.Scan(&id, &title, &content, &typ, &persistent, &created, &published); err != nil {
				continue
			}
			items = append(items, map[string]any{"id": id, "title": title, "content": content, "type": typ, "is_persistent": persistent, "created_at": databaseValueString(created), "published_at": databaseValueString(published)})
			continue
		}
		var id, persistent, createdBy any
		var title, content, typ, status any
		var created, published any
		if err := rows.Scan(&id, &title, &content, &typ, &status, &persistent, &createdBy, &created, &published); err != nil {
			continue
		}
		items = append(items, map[string]any{"id": id, "title": title, "content": content, "type": typ, "status": status, "is_persistent": persistent, "created_by": createdBy, "created_at": databaseValueString(created), "published_at": databaseValueString(published)})
	}
	if err := rows.Err(); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "无法读取公告"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "announcements": items})
}

func (s *Server) announcementWrite(w http.ResponseWriter, r *http.Request, action string) {
	input := map[string]any{}
	if err := decodeJSON(r, &input, 1<<20); err != nil {
		input = map[string]any{}
	}
	switch action {
	case "create":
		title, content := strings.TrimSpace(stringValue(input["title"])), strings.TrimSpace(stringValue(input["content"]))
		if title == "" {
			writeJSON(w, map[string]any{"success": false, "message": "公告标题不能为空"})
			return
		}
		if content == "" {
			writeJSON(w, map[string]any{"success": false, "message": "公告内容不能为空"})
			return
		}
		typ := announcementType(stringValue(input["type"]))
		persistent := boolInt(boolValueDefault(input["is_persistent"], true))
		userID, _ := s.optionalSessionUser(r)
		var creator any
		if userID != nil {
			creator = *userID
		}
		result, err := s.db.ExecContext(r.Context(), `INSERT INTO announcements(title,content,type,status,is_persistent,created_by) VALUES(?,?,?,'draft',?,?)`, title, content, typ, persistent, creator)
		if err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "公告保存失败"})
			return
		}
		id, _ := result.LastInsertId()
		writeJSON(w, map[string]any{"success": true, "id": id, "message": "草稿已保存"})
	case "update":
		id := integerValue(input["id"])
		if id <= 0 {
			writeJSON(w, map[string]any{"success": false, "message": "无效的公告 ID"})
			return
		}
		title, content := strings.TrimSpace(stringValue(input["title"])), strings.TrimSpace(stringValue(input["content"]))
		if title == "" {
			writeJSON(w, map[string]any{"success": false, "message": "公告标题不能为空"})
			return
		}
		if content == "" {
			writeJSON(w, map[string]any{"success": false, "message": "公告内容不能为空"})
			return
		}
		persistent := boolInt(boolValueDefault(input["is_persistent"], true))
		_, err := s.db.ExecContext(r.Context(), `UPDATE announcements SET title=?,content=?,type=?,is_persistent=? WHERE id=? AND status='draft'`, title, content, announcementType(stringValue(input["type"])), persistent, id)
		if err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "公告更新失败"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "草稿已更新"})
	case "publish":
		id := integerValue(input["id"])
		if id <= 0 {
			writeJSON(w, map[string]any{"success": false, "message": "无效的公告 ID"})
			return
		}
		var title, content string
		if err := s.db.QueryRowContext(r.Context(), `SELECT title,content FROM announcements WHERE id=?`, id).Scan(&title, &content); err == sql.ErrNoRows {
			writeJSON(w, map[string]any{"success": false, "message": "公告不存在"})
			return
		} else if err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "公告读取失败"})
			return
		}
		if _, err := s.db.ExecContext(r.Context(), `UPDATE announcements SET status='published',published_at=CURRENT_TIMESTAMP WHERE id=?`, id); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "公告发布失败"})
			return
		}
		notified := s.announcementBroadcast(r, title, content, id)
		writeJSON(w, map[string]any{"success": true, "message": "公告已发布", "notified": notified})
	case "delete":
		id := integerValue(input["id"])
		if id <= 0 {
			writeJSON(w, map[string]any{"success": false, "message": "无效的公告 ID"})
			return
		}
		if _, err := s.db.ExecContext(r.Context(), `DELETE FROM announcements WHERE id=?`, id); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "公告删除失败"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "公告已删除"})
	}
}

func (s *Server) announcementBroadcast(r *http.Request, title, content string, id int64) int64 {
	rows, err := s.db.QueryContext(r.Context(), `SELECT id FROM users WHERE status='active'`)
	if err != nil {
		return 0
	}
	ids := []int64{}
	for rows.Next() {
		var userID int64
		if rows.Scan(&userID) != nil {
			continue
		}
		ids = append(ids, userID)
	}
	_ = rows.Close()
	var notified int64
	for _, userID := range ids {
		if _, err := s.db.ExecContext(r.Context(), `INSERT INTO notifications(user_id,type,title,message,link,related_type,related_id) VALUES(?,?,?,?,?,?,?)`, userID, "system", "📢 全站公告："+title, content, "", "announcement", id); err == nil {
			notified++
		}
	}
	return notified
}

func announcementType(value string) string {
	switch value {
	case "info", "warning", "important", "update":
		return value
	default:
		return "info"
	}
}

func boolValueDefault(value any, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return boolValue(value)
}
