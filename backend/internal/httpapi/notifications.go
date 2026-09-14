package httpapi

import (
	"encoding/json"
	"net/http"
)

func (s *Server) notifications(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	action := r.URL.Query().Get("action")
	if action == "" {
		writeJSON(w, map[string]any{"success": false, "message": "未知操作"})
		return
	}
	userID, _ := s.optionalSessionUser(r)
	if userID == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	if s.db == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "数据库暂时不可用，请稍后重试"})
		return
	}
	switch action {
	case "list":
		if r.Method != http.MethodGet {
			writeJSON(w, map[string]any{"success": false, "message": "仅支持 GET 请求"})
			return
		}
		s.notificationList(w, r, *userID)
	case "count_unread":
		if r.Method != http.MethodGet {
			writeJSON(w, map[string]any{"success": false, "message": "仅支持 GET 请求"})
			return
		}
		count, err := s.unreadNotifications(r, *userID)
		if err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "数据库暂时不可用，请稍后重试"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "count": count})
	case "mark_read", "mark_all_read":
		if r.Method != http.MethodPost {
			writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST 请求"})
			return
		}
		s.notificationMarkRead(w, r, *userID, action)
	default:
		writeJSON(w, map[string]any{"success": false, "message": "未知操作"})
	}
}

func (s *Server) unreadNotifications(r *http.Request, userID int64) (int, error) {
	var count int
	err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = 0", userID).Scan(&count)
	return count, err
}

func (s *Server) notificationList(w http.ResponseWriter, r *http.Request, userID int64) {
	page := boundedQueryInt(r, "page", 1, 1, 1000000)
	limit := boundedQueryInt(r, "limit", 20, 1, 100)
	offset := (page - 1) * limit
	var total int
	if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM notifications WHERE user_id = ?", userID).Scan(&total); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "数据库暂时不可用，请稍后重试"})
		return
	}
	unread, err := s.unreadNotifications(r, userID)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "数据库暂时不可用，请稍后重试"})
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT id, type, title, message, link, related_type, related_id, is_read, created_at
        FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`, userID, limit, offset)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "数据库暂时不可用，请稍后重试"})
		return
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var id, relatedID, isRead any
		var typ, title, message, link, relatedType any
		var created any
		if err := rows.Scan(&id, &typ, &title, &message, &link, &relatedType, &relatedID, &isRead, &created); err != nil {
			continue
		}
		// database/sql may return MySQL TEXT/VARCHAR columns as []byte when the
		// destination is any. Passing those byte slices to encoding/json encodes
		// them as base64, which makes Chinese notification text look corrupted in
		// the browser. Normalize all textual columns before building the JSON map.
		items = append(items, map[string]any{"id": id, "type": databaseValueString(typ), "title": databaseValueString(title), "message": databaseValueString(message), "link": databaseValueString(link), "related_type": databaseValueString(relatedType), "related_id": relatedID, "is_read": integerValue(isRead), "created_at": databaseValueString(created)})
	}
	totalPages := (total + limit - 1) / limit
	if totalPages < 1 {
		totalPages = 1
	}
	writeJSON(w, map[string]any{"success": true, "notifications": items, "unread_count": unread, "total": total, "page": page, "limit": limit, "total_pages": totalPages})
}

func (s *Server) notificationMarkRead(w http.ResponseWriter, r *http.Request, userID int64, action string) {
	if action == "mark_read" {
		var input struct {
			ID int64 `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.ID <= 0 {
			writeJSON(w, map[string]any{"success": false, "message": "无效的通知 ID"})
			return
		}
		if _, err := s.db.ExecContext(r.Context(), "UPDATE notifications SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?", input.ID, userID); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "数据库暂时不可用，请稍后重试"})
			return
		}
	} else if _, err := s.db.ExecContext(r.Context(), "UPDATE notifications SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND is_read = 0", userID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "数据库暂时不可用，请稍后重试"})
		return
	}
	count, err := s.unreadNotifications(r, userID)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "数据库暂时不可用，请稍后重试"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "unread_count": count})
}
