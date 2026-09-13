package httpapi

import (
	"database/sql"
	"net/http"
	"strings"
)

func (s *Server) clubMoeKing(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	switch action {
	case "get":
		s.clubMoeKingGet(w, r)
	case "set":
		s.clubMoeKingSet(w, r)
	case "remove":
		s.clubMoeKingRemove(w, r)
	default:
		writeJSON(w, map[string]any{"success": false, "message": "未知操作 action=" + action})
	}
}

func (s *Server) clubMoeKingGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	clubID := parsePositiveInt(r.URL.Query().Get("club_id"))
	country := clubCodeCountry(r.URL.Query().Get("country"))
	if clubID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效的同好会 ID"})
		return
	}
	var id, characterID, updatedBy int64
	var rowCountry, name, nameCN, imageURL string
	var summary, updatedAt sql.NullString
	err := s.db.QueryRowContext(r.Context(), `SELECT id, club_id, country, character_id, name, name_cn, image_url, summary, updated_by, updated_at
        FROM club_moe_kings WHERE club_id = ? AND country = ? LIMIT 1`, clubID, country).Scan(&id, &clubID, &rowCountry, &characterID, &name, &nameCN, &imageURL, &summary, &updatedBy, &updatedAt)
	if err == sql.ErrNoRows {
		writeJSON(w, map[string]any{"success": true, "data": nil})
		return
	}
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取萌王失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "data": map[string]any{
		"id": id, "club_id": clubID, "country": rowCountry, "character_id": characterID,
		"name": name, "name_cn": nameCN, "image_url": bangumiProxyImageURL(imageURL),
		"summary": nullableStringCompat(summary), "updated_by": updatedBy, "updated_at": nullableStringCompat(updatedAt),
	}})
}

func (s *Server) clubMoeKingSet(w http.ResponseWriter, r *http.Request) {
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
	characterID := integerValue(input["character_id"])
	name := strings.TrimSpace(stringValue(input["name"]))
	if clubID <= 0 || characterID <= 0 || name == "" {
		writeJSON(w, map[string]any{"success": false, "message": "角色信息不完整"})
		return
	}
	if !s.canManageClubCodes(r.Context(), user, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	nameCN := strings.TrimSpace(stringValue(input["name_cn"]))
	imageURL := strings.TrimSpace(stringValue(input["image_url"]))
	summary := strings.TrimSpace(stringValue(input["summary"]))
	var err error
	if s.cfg.DBDriver == "sqlite" {
		_, err = s.db.ExecContext(r.Context(), `INSERT INTO club_moe_kings (club_id, country, character_id, name, name_cn, image_url, summary, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(club_id, country) DO UPDATE SET character_id=excluded.character_id, name=excluded.name, name_cn=excluded.name_cn,
            image_url=excluded.image_url, summary=excluded.summary, updated_by=excluded.updated_by, updated_at=datetime('now')`, clubID, country, characterID, name, nameCN, imageURL, summary, user.ID)
	} else {
		_, err = s.db.ExecContext(r.Context(), `INSERT INTO club_moe_kings (club_id, country, character_id, name, name_cn, image_url, summary, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON DUPLICATE KEY UPDATE character_id=VALUES(character_id), name=VALUES(name), name_cn=VALUES(name_cn), image_url=VALUES(image_url),
            summary=VALUES(summary), updated_by=VALUES(updated_by), updated_at=CURRENT_TIMESTAMP`, clubID, country, characterID, name, nameCN, imageURL, summary, user.ID)
	}
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "更新萌王失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "萌王已更新"})
}

func (s *Server) clubMoeKingRemove(w http.ResponseWriter, r *http.Request) {
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
		input = map[string]any{}
	}
	clubID := integerValue(input["club_id"])
	country := clubCodeCountry(stringValue(input["country"]))
	if clubID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效的同好会 ID"})
		return
	}
	if !s.canManageClubCodes(r.Context(), user, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "DELETE FROM club_moe_kings WHERE club_id = ? AND country = ?", clubID, country); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "移除萌王失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "萌王已移除"})
}
