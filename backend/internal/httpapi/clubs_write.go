package httpapi

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var clubProvinceSeparator = regexp.MustCompile(`[+＋/／、,，;；|｜]`)

// clubListWrite ports the write half of clubs.php and clubs_japan.php. These
// endpoints store the public club catalog in JSON, so writes go through the
// same locked, atomic FileStore path as the rest of the migration.
func (s *Server) clubListWrite(w http.ResponseWriter, r *http.Request, fileName, country string) {
	publicAPIHeaders(w)
	input := map[string]any{}
	if err := decodeJSON(r, &input, 2<<20); err != nil {
		input = map[string]any{}
	}
	if r.Method == http.MethodPost {
		user, ok := s.clubWriteUser(w, r, true)
		if !ok {
			return
		}
		if user.Role != "super_admin" {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权添加同好会"})
			return
		}
		if stringValue(input["name"]) == "" || stringValue(input["info"]) == "" {
			writeJSON(w, map[string]any{"success": false, "message": "缺少必填字段"})
			return
		}
		provinces := normalizeClubProvinces(input)
		if country == "china" && len(provinces) == 0 {
			writeJSON(w, map[string]any{"success": false, "message": "请选择至少一个省份"})
			return
		}
		if country == "japan" && strings.TrimSpace(firstNonEmpty(stringValue(input["prefecture"]), stringValue(input["province"]))) == "" {
			writeJSON(w, map[string]any{"success": false, "message": "请填写都道府县"})
			return
		}
		document, rows := s.readClubDocument(r, fileName)
		id := maxClubID(rows) + 1
		name := strings.TrimSpace(stringValue(input["name"]))
		info := stringValue(input["info"])
		item := map[string]any{
			"id": id, "name": name, "display_name": name, "info": info,
			"school": stringValue(input["school"]), "type": firstNonEmpty(stringValue(input["type"]), "school"),
			"verified": 1, "raw_text": name + " " + info,
			"created_at": time.Now().Format("2006-01-02 15:04:05"), "project": "galgame",
			"remark": stringValue(input["remark"]), "logo_url": stringValue(input["logo_url"]),
			"external_links": stringValue(input["external_links"]), "country": country,
			"protected": boolValue(input["protected"]),
		}
		if country == "japan" {
			prefecture := normalizeJapanPrefecture(stringValue(firstNonEmptyValue(input["prefecture"], input["province"])))
			item["prefecture"], item["province"] = prefecture, prefecture
		} else {
			item["province"], item["provinces"] = provinces[0], provinces
			item["city"] = stringValue(input["city"])
		}
		rows = append(rows, item)
		document["data"], document["success"], document["total"] = rows, true, len(rows)
		if err := s.files.WriteJSONAtomic(r.Context(), fileName, document); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "保存失败，请检查文件权限"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "添加成功", "id": id, "data": item})
		return
	}

	if r.Method == http.MethodPut {
		user, ok := s.clubWriteUser(w, r, false)
		if !ok {
			return
		}
		id := integerValue(input["id"])
		if id <= 0 {
			writeJSON(w, map[string]any{"success": false, "message": "无效数据"})
			return
		}
		clubCountry := firstNonEmpty(stringValue(input["country"]), country)
		if input["operation"] == "jiangsu_city_bulk" && user.Role != "super_admin" {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "江苏专项仅超级管理员可用"})
			return
		}
		if user.Role != "super_admin" && !s.canManageClubInCountry(r.Context(), user, id, clubCountry) {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权修改此同好会"})
			return
		}
		document, rows := s.readClubDocument(r, fileName)
		index := -1
		for i, row := range rows {
			if integerValue(row["id"]) == id {
				index = i
				break
			}
		}
		if index < 0 {
			writeJSON(w, map[string]any{"success": false, "message": "未找到要更新的数据"})
			return
		}
		item := rows[index]
		clubUpdateString(item, input, "school", "name", "info", "type", "created_at", "remark", "logo_url", "external_links")
		if name, ok := input["name"]; ok {
			item["display_name"] = name
		}
		if info, ok := input["info"]; ok {
			item["raw_text"] = stringValue(item["name"]) + " " + stringValue(info)
		}
		if country == "japan" {
			prefecture := firstNonEmpty(stringValue(input["prefecture"]), stringValue(input["province"]), stringValue(item["prefecture"]))
			item["prefecture"], item["province"], item["country"] = normalizeJapanPrefecture(prefecture), normalizeJapanPrefecture(prefecture), "japan"
		} else {
			if provinces := normalizeClubProvinces(input); len(provinces) > 0 {
				item["province"], item["provinces"] = provinces[0], provinces
			} else if _, ok := input["province"]; ok {
				item["province"] = stringValue(input["province"])
				delete(item, "provinces")
			}
			if city, ok := input["city"]; ok {
				item["city"] = city
			}
			item["country"] = firstNonEmpty(stringValue(input["country"]), country)
		}
		if _, ok := input["visible_by_default"]; ok {
			item["visible_by_default"] = boolValue(input["visible_by_default"])
		}
		if _, ok := input["protected"]; ok {
			item["protected"] = boolValue(input["protected"])
		}
		rows[index] = item
		document["data"], document["success"], document["total"] = rows, true, len(rows)
		if err := s.files.WriteJSONAtomic(r.Context(), fileName, document); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "保存失败，请检查文件权限"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "更新成功"})
		return
	}

	if r.Method == http.MethodDelete {
		user, ok := s.clubWriteUser(w, r, true)
		if !ok {
			return
		}
		if user.Role != "super_admin" {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权删除同好会"})
			return
		}
		id := integerValue(input["id"])
		if id <= 0 {
			writeJSON(w, map[string]any{"success": false, "message": "无效数据"})
			return
		}
		document, rows := s.readClubDocument(r, fileName)
		filtered := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			if integerValue(row["id"]) != id {
				filtered = append(filtered, row)
			}
		}
		document["data"], document["success"], document["total"] = filtered, true, len(filtered)
		if err := s.files.WriteJSONAtomic(r.Context(), fileName, document); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "保存失败，请检查文件权限"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "删除成功"})
		return
	}

	methodNotAllowed(w, "GET, POST, PUT, DELETE, OPTIONS")
}

func (s *Server) clubWriteUser(w http.ResponseWriter, r *http.Request, adminRequired bool) (*user, bool) {
	// Check the transition token before the session helper writes a 401.
	if adminRequired && s.cfg.LegacyAuthEnabled && strings.TrimSpace(r.Header.Get("X-Admin-Token")) != "" {
		if _, valid := s.adminUserID(r); valid {
			return &user{Role: "super_admin"}, true
		}
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if ok {
		if adminRequired && user.Role != "super_admin" && !s.hasAnyManagementRole(r.Context(), user.ID) {
			writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "未授权访问"})
			return nil, false
		}
		return user, true
	}
	return nil, false
}

func (s *Server) canManageClubInCountry(ctx context.Context, current *user, clubID int64, country string) bool {
	if current != nil && current.Role == "super_admin" {
		return true
	}
	return current != nil && s.canManageMembership(ctx, current.ID, clubID, country)
}

func (s *Server) readClubDocument(r *http.Request, fileName string) (map[string]any, []map[string]any) {
	document := map[string]any{"data": []any{}}
	if s.files != nil {
		var loaded map[string]any
		if err := s.files.ReadJSON(r.Context(), fileName, &loaded); err == nil && loaded != nil {
			document = loaded
		}
	}
	rows := mapSlice(document["data"])
	return document, rows
}

func maxClubID(rows []map[string]any) int64 {
	var max int64
	for _, row := range rows {
		if id := integerValue(row["id"]); id > max {
			max = id
		}
	}
	return max
}

func normalizeClubProvinces(input map[string]any) []string {
	values := []string{}
	if raw, ok := input["provinces"].([]any); ok {
		for _, value := range raw {
			values = append(values, strings.TrimSpace(stringValue(value)))
		}
	} else if province := stringValue(input["province"]); province != "" {
		values = clubProvinceSeparator.Split(province, -1)
	}
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		if value != "" && !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}

func normalizeJapanPrefecture(value string) string { return strings.TrimSpace(value) }

func firstNonEmptyValue(values ...any) any {
	for _, value := range values {
		if stringValue(value) != "" {
			return value
		}
	}
	return nil
}

func clubUpdateString(item, input map[string]any, fields ...string) {
	for _, field := range fields {
		if value, ok := input[field]; ok {
			if field == "name" || field == "info" || field == "school" || field == "type" || field == "remark" || field == "logo_url" || field == "external_links" {
				item[field] = strings.TrimSpace(stringValue(value))
			} else if field == "created_at" {
				item[field] = stringValue(value)
			}
		}
	}
}
