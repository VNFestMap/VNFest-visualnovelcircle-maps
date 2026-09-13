package httpapi

import (
	"errors"
	"net/http"
	"os"
	"strings"
	"time"
)

func (s *Server) feedback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if s.files == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "文件存储不可用"})
		return
	}
	action := r.URL.Query().Get("action")
	if r.Method == http.MethodGet && action == "read" {
		if _, ok := s.adminUserID(r); !ok {
			requireAdminResponse(w)
			return
		}
		var rows []map[string]any
		if err := s.files.ReadJSON(r.Context(), "feedback.json", &rows); err != nil && !errors.Is(err, os.ErrNotExist) {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取失败"})
			return
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		writeJSON(w, rows)
		return
	}
	if r.Method == http.MethodPut && action == "save" {
		if _, ok := s.adminUserID(r); !ok {
			requireAdminResponse(w)
			return
		}
		var rows []map[string]any
		if err := decodeJSON(r, &rows, 4<<20); err != nil || rows == nil {
			writeJSON(w, map[string]any{"success": false, "message": "无效数据"})
			return
		}
		if err := s.files.WriteJSONAtomic(r.Context(), "feedback.json", rows); err != nil {
			writeJSON(w, map[string]any{"success": false})
			return
		}
		writeJSON(w, map[string]any{"success": true})
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST 请求"})
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 1<<20); err != nil || input == nil {
		writeJSON(w, map[string]any{"success": false, "message": "无效数据"})
		return
	}
	typ := strings.TrimSpace(stringValue(input["type"]))
	title := strings.TrimSpace(stringValue(input["title"]))
	content := strings.TrimSpace(stringValue(input["content"]))
	if typ != "bug" && typ != "feature" && typ != "other" {
		writeJSON(w, map[string]any{"success": false, "message": "请选择反馈类型"})
		return
	}
	if title == "" || runeLength(title) > 120 {
		writeJSON(w, map[string]any{"success": false, "message": "请填写 1-120 字的标题"})
		return
	}
	if content == "" || runeLength(content) > 3000 {
		writeJSON(w, map[string]any{"success": false, "message": "请填写 1-3000 字的说明"})
		return
	}
	var rows []map[string]any
	if err := s.files.ReadJSON(r.Context(), "feedback.json", &rows); err != nil && !errors.Is(err, os.ErrNotExist) {
		writeJSON(w, map[string]any{"success": false, "message": "保存失败，请稍后重试"})
		return
	}
	maxID := int64(0)
	for _, row := range rows {
		if id := integerValue(row["id"]); id > maxID {
			maxID = id
		}
	}
	entry := map[string]any{
		"id": maxID + 1, "type": typ, "title": title, "content": content,
		"page_url": stringValue(input["page_url"]), "contact": stringValue(input["contact"]),
		"device": stringValue(input["device"]), "status": "pending",
		"submitted_at": time.Now().Format("2006-01-02 15:04:05"), "user_agent": r.UserAgent(),
	}
	rows = append(rows, entry)
	if err := s.files.WriteJSONAtomic(r.Context(), "feedback.json", rows); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "保存失败，请稍后重试"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "提交成功", "id": maxID + 1})
}

func runeLength(value string) int { return len([]rune(value)) }
