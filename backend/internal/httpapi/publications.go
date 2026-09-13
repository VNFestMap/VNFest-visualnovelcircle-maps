package httpapi

import (
	"context"
	"net/http"
)

func (s *Server) publications(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method == http.MethodGet {
		data := s.projectHubReadMap(r.Context(), "publications.json", map[string]any{"publications": []any{}})
		writeJSON(w, data)
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodPut && r.Method != http.MethodDelete {
		writeJSONStatus(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "message": "不支持的请求方法"})
		return
	}
	if !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	user, err := s.findUser(r.Context(), userID)
	if err != nil || user == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 2<<20); err != nil || input == nil {
		input = map[string]any{}
	}
	data := s.projectHubReadMap(r.Context(), "publications.json", map[string]any{"publications": []any{}})
	rows := mapSlice(data["publications"])
	idx := publicationIndex(rows, integerValue(input["id"]))
	switch r.Method {
	case http.MethodPost:
		if cleanProjectText(input["clubName"], 255) == "" || cleanProjectText(input["publicationName"], 255) == "" {
			writeJSON(w, map[string]any{"success": false, "message": "缺少必填字段"})
			return
		}
		clubID := integerValue(input["club_id"])
		if clubID <= 0 {
			if clubs := normalizeProjectClubs(input["club_ids"]); len(clubs) > 0 {
				clubID = integerValue(clubs[0]["id"])
			}
		}
		if !s.publicationCanManage(r.Context(), user, clubID, "") {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足，仅同好会负责人可添加刊物"})
			return
		}
		row := map[string]any{"id": nextPublicationID(rows), "clubName": cleanProjectText(input["clubName"], 255), "publicationName": cleanProjectText(input["publicationName"], 255), "status": firstNonEmpty(cleanProjectText(input["status"], 40), "planning"), "submitContact": cleanProjectText(input["submitContact"], 500), "submitLink": cleanProjectText(input["submitLink"], 500), "deadline": cleanProjectText(input["deadline"], 40), "description": cleanProjectText(input["description"], 4000), "image_url": cleanProjectText(input["image_url"], 500), "club_ids": normalizeProjectClubs(input["club_ids"]), "created_at": projectHubNow(), "updated_at": projectHubNow()}
		rows = append(rows, row)
		data["publications"] = rows
		if err := s.projectHubWriteMap(r.Context(), "publications.json", data); err != nil {
			projectHubWriteError(w)
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "添加成功", "data": row})
	case http.MethodPut:
		if idx < 0 || !s.publicationCanManageRow(r.Context(), user, rows[idx]) {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
			return
		}
		for _, field := range []string{"clubName", "publicationName", "status", "submitContact", "submitLink", "deadline", "description", "image_url"} {
			if _, exists := input[field]; exists {
				limit := 500
				if field == "description" {
					limit = 4000
				}
				rows[idx][field] = cleanProjectText(input[field], limit)
			}
		}
		if _, exists := input["club_ids"]; exists {
			rows[idx]["club_ids"] = normalizeProjectClubs(input["club_ids"])
		}
		rows[idx]["updated_at"] = projectHubNow()
		data["publications"] = rows
		if err := s.projectHubWriteMap(r.Context(), "publications.json", data); err != nil {
			projectHubWriteError(w)
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "更新成功"})
	case http.MethodDelete:
		if idx < 0 || !s.publicationCanManageRow(r.Context(), user, rows[idx]) {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
			return
		}
		rows = append(rows[:idx], rows[idx+1:]...)
		data["publications"] = rows
		if err := s.projectHubWriteMap(r.Context(), "publications.json", data); err != nil {
			projectHubWriteError(w)
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "删除成功"})
	}
}

func (s *Server) publicationCanManage(ctx context.Context, user *user, clubID int64, country string) bool {
	if user != nil && user.Role == "super_admin" {
		return true
	}
	if user == nil || clubID <= 0 || s.db == nil {
		return false
	}
	query := "SELECT id FROM club_memberships WHERE user_id=? AND club_id=? AND role IN ('representative','manager') AND status='active'"
	args := []any{user.ID, clubID}
	if country != "" {
		query += " AND COALESCE(country,'china')=?"
		args = append(args, country)
	}
	var id int64
	return s.db.QueryRowContext(ctx, query+" LIMIT 1", args...).Scan(&id) == nil
}

func (s *Server) publicationCanManageRow(ctx context.Context, user *user, row map[string]any) bool {
	if user != nil && user.Role == "super_admin" {
		return true
	}
	clubs := normalizeProjectClubs(row["club_ids"])
	for _, club := range clubs {
		if s.publicationCanManage(ctx, user, integerValue(club["id"]), stringValue(club["country"])) {
			return true
		}
	}
	if name := cleanProjectText(row["clubName"], 255); name != "" {
		for _, country := range []string{"china", "japan"} {
			data := s.projectHubReadMap(ctx, map[string]string{"china": "clubs.json", "japan": "clubs_japan.json"}[country], map[string]any{"data": []any{}})
			for _, club := range mapSlice(data["data"]) {
				if name == firstNonEmpty(stringValue(club["name"]), firstNonEmpty(stringValue(club["display_name"]), stringValue(club["school"]))) {
					return s.publicationCanManage(ctx, user, integerValue(club["id"]), country)
				}
			}
		}
	}
	return false
}

func publicationIndex(rows []map[string]any, id int64) int {
	for index, row := range rows {
		if integerValue(row["id"]) == id {
			return index
		}
	}
	return -1
}

func nextPublicationID(rows []map[string]any) int64 {
	var max int64
	for _, row := range rows {
		if id := integerValue(row["id"]); id > max {
			max = id
		}
	}
	return max + 1
}
