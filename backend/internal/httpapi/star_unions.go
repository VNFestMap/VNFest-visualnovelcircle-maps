package httpapi

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strings"
)

func (s *Server) starUnions(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if s.db == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "数据库不可用"})
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	switch action {
	case "list":
		s.starUnionList(w, r)
	case "get":
		s.starUnionGet(w, r)
	case "create", "update", "delete", "add_club", "remove_club":
		s.starUnionWrite(w, r, action)
	case "my_unions":
		s.starUnionMine(w, r)
	default:
		writeJSON(w, map[string]any{"success": false, "message": "未知操作"})
	}
}

func (s *Server) starUnionList(w http.ResponseWriter, r *http.Request) {
	query := "SELECT id,name,COALESCE(description,''),COALESCE(region,''),COALESCE(country,'china'),created_by,created_at, bound_club_id,COALESCE(bound_club_country,'china'),COALESCE(star_color,'#f0c060') FROM star_unions"
	args := []any{}
	if country := strings.TrimSpace(r.URL.Query().Get("country")); country != "" {
		query += " WHERE country=?"
		args = append(args, country)
	}
	query += " ORDER BY created_at DESC"
	rows, err := s.db.QueryContext(r.Context(), query, args...)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "联合查询失败"})
		return
	}
	defer rows.Close()
	viewerID, _ := s.optionalSessionUser(r)
	unions := []map[string]any{}
	for rows.Next() {
		union, err := scanStarUnion(rows)
		if err != nil {
			continue
		}
		var count int64
		_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM star_union_members WHERE union_id=?", union["id"]).Scan(&count)
		union["member_count"] = count
		union["can_manage"] = viewerID != nil && (integerValue(union["created_by"]) == *viewerID || s.starUnionSuperAdmin(r.Context(), *viewerID))
		if r.URL.Query().Get("include_members") == "1" {
			union["_members"] = s.starUnionMembers(r, integerValue(union["id"]))
		}
		unions = append(unions, union)
	}
	writeJSON(w, map[string]any{"success": true, "unions": unions})
}

func (s *Server) starUnionGet(w http.ResponseWriter, r *http.Request) {
	id := queryInt(r, "id")
	if id <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "缺少联合ID"})
		return
	}
	union, err := s.loadStarUnion(r.Context(), id)
	if err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "联合不存在"})
		return
	}
	viewerID, _ := s.optionalSessionUser(r)
	union["can_manage"] = viewerID != nil && (integerValue(union["created_by"]) == *viewerID || s.starUnionSuperAdmin(r.Context(), *viewerID))
	if clubID := integerValue(union["bound_club_id"]); clubID > 0 {
		country := stringValue(union["bound_club_country"])
		club := s.starUnionClub(r, clubID, country)
		union["bound_club_name"], union["bound_club_school"] = firstNonEmpty(stringValue(club["name"]), stringValue(club["display_name"])), stringValue(club["school"])
	}
	writeJSON(w, map[string]any{"success": true, "union": union, "members": s.starUnionMembers(r, id)})
}

func (s *Server) starUnionWrite(w http.ResponseWriter, r *http.Request, action string) {
	userID, role := s.optionalSessionUser(r)
	if userID == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	input := voteReadJSON(r)
	if action == "create" {
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		name := strings.TrimSpace(stringValue(input["name"]))
		if name == "" {
			writeJSON(w, map[string]any{"success": false, "message": "联合名称不能为空"})
			return
		}
		if len([]rune(name)) > 100 {
			writeJSON(w, map[string]any{"success": false, "message": "联合名称不能超过100个字符"})
			return
		}
		result, err := s.db.ExecContext(r.Context(), "INSERT INTO star_unions (name,description,region,country,created_by,bound_club_id,bound_club_country,star_color) VALUES (?,?,?,?,?,?,?,?)", name, stringValue(input["description"]), stringValue(input["region"]), firstNonEmpty(stringValue(input["country"]), "china"), *userID, nullableInt64(integerValue(input["bound_club_id"])), firstNonEmpty(stringValue(input["bound_club_country"]), "china"), firstNonEmpty(stringValue(input["star_color"]), "#f0c060"))
		if err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "联合创建失败"})
			return
		}
		id, _ := result.LastInsertId()
		writeJSON(w, map[string]any{"success": true, "union": map[string]any{"id": id, "name": name, "created_by": *userID}})
		return
	}
	id := integerValue(input["id"])
	if id <= 0 {
		id = integerValue(input["union_id"])
	}
	union, err := s.loadStarUnion(r.Context(), id)
	if err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "联合不存在"})
		return
	}
	if role != "super_admin" && integerValue(union["created_by"]) != *userID {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": map[string]string{"update": "无权限编辑此联合", "delete": "无权限删除此联合", "add_club": "无权限操作", "remove_club": "无权限操作"}[action]})
		return
	}
	switch action {
	case "update":
		if r.Method != http.MethodPost && r.Method != http.MethodPut {
			methodNotAllowed(w, "POST, PUT")
			return
		}
		name := firstNonEmpty(stringValue(input["name"]), stringValue(union["name"]))
		boundClubID := integerValue(union["bound_club_id"])
		if _, present := input["bound_club_id"]; present {
			boundClubID = integerValue(input["bound_club_id"])
		}
		boundClubCountry := stringValue(union["bound_club_country"])
		if _, present := input["bound_club_country"]; present {
			boundClubCountry = stringValue(input["bound_club_country"])
		}
		_, err = s.db.ExecContext(r.Context(), "UPDATE star_unions SET name=?,description=?,region=?,bound_club_id=?,bound_club_country=?,star_color=? WHERE id=?", name, firstNonEmpty(stringValue(input["description"]), stringValue(union["description"])), firstNonEmpty(stringValue(input["region"]), stringValue(union["region"])), nullableInt64(boundClubID), firstNonEmpty(boundClubCountry, "china"), firstNonEmpty(stringValue(input["star_color"]), stringValue(union["star_color"])), id)
	case "delete":
		_, err = s.db.ExecContext(r.Context(), "DELETE FROM star_union_members WHERE union_id=?", id)
		if err == nil {
			_, err = s.db.ExecContext(r.Context(), "DELETE FROM star_unions WHERE id=?", id)
		}
	case "add_club":
		clubID := integerValue(input["club_id"])
		country := firstNonEmpty(stringValue(input["club_country"]), "china")
		club := s.starUnionClub(r, clubID, country)
		if club == nil {
			writeJSON(w, map[string]any{"success": false, "message": "同好会不存在"})
			return
		}
		_, err = s.db.ExecContext(r.Context(), "INSERT INTO star_union_members (union_id,club_id,club_country,added_by) VALUES (?,?,?,?)", id, clubID, country, *userID)
		if err == nil {
			writeJSON(w, map[string]any{"success": true, "message": "已添加同好会", "club_name": firstNonEmpty(stringValue(club["name"]), stringValue(club["display_name"]))})
			return
		}
		writeJSON(w, map[string]any{"success": false, "message": "该同好会已在联合中"})
		return
	case "remove_club":
		_, err = s.db.ExecContext(r.Context(), "DELETE FROM star_union_members WHERE union_id=? AND club_id=? AND club_country=?", id, integerValue(input["club_id"]), firstNonEmpty(stringValue(input["club_country"]), "china"))
	}
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "操作失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": map[string]string{"update": "已更新", "delete": "已删除", "remove_club": "已移除同好会"}[action]})
}

func (s *Server) starUnionMine(w http.ResponseWriter, r *http.Request) {
	userID, _ := s.optionalSessionUser(r)
	if userID == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	rows, err := s.db.QueryContext(r.Context(), "SELECT id,name,COALESCE(description,''),COALESCE(region,''),COALESCE(country,'china'),created_by,created_at,bound_club_id,COALESCE(bound_club_country,'china'),COALESCE(star_color,'#f0c060') FROM star_unions WHERE created_by=? ORDER BY created_at DESC", *userID)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "查询失败"})
		return
	}
	defer rows.Close()
	unions := []map[string]any{}
	for rows.Next() {
		union, err := scanStarUnion(rows)
		if err == nil {
			var count int64
			_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM star_union_members WHERE union_id=?", union["id"]).Scan(&count)
			union["member_count"] = count
			unions = append(unions, union)
		}
	}
	writeJSON(w, map[string]any{"success": true, "unions": unions})
}

func (s *Server) loadStarUnion(ctx context.Context, id int64) (map[string]any, error) {
	row := s.db.QueryRowContext(ctx, "SELECT id,name,COALESCE(description,''),COALESCE(region,''),COALESCE(country,'china'),created_by,created_at,bound_club_id,COALESCE(bound_club_country,'china'),COALESCE(star_color,'#f0c060') FROM star_unions WHERE id=?", id)
	return scanStarUnion(row)
}

type starUnionScanner interface{ Scan(...any) error }

func scanStarUnion(row starUnionScanner) (map[string]any, error) {
	var id, createdBy int64
	var name, description, region, country string
	var createdAt, boundCountry, color any
	var boundID sql.NullInt64
	if err := row.Scan(&id, &name, &description, &region, &country, &createdBy, &createdAt, &boundID, &boundCountry, &color); err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "name": name, "description": description, "region": region, "country": country, "created_by": createdBy, "created_at": databaseValueString(createdAt), "bound_club_id": nullInt64Value(sqlNullInt64{Int64: boundID.Int64, Valid: boundID.Valid}), "bound_club_country": fmt.Sprint(databaseValueString(boundCountry)), "star_color": fmt.Sprint(databaseValueString(color))}, nil
}

func (s *Server) starUnionMembers(r *http.Request, unionID int64) []map[string]any {
	rows, err := s.db.QueryContext(r.Context(), "SELECT id,union_id,club_id,COALESCE(club_country,'china'),added_by,added_at FROM star_union_members WHERE union_id=? ORDER BY added_at ASC", unionID)
	if err != nil {
		return []map[string]any{}
	}
	defer rows.Close()
	result := []map[string]any{}
	for rows.Next() {
		var id, union, club, addedBy int64
		var country string
		var addedAt any
		if rows.Scan(&id, &union, &club, &country, &addedBy, &addedAt) == nil {
			item := map[string]any{"id": id, "union_id": union, "club_id": club, "club_country": country, "added_by": addedBy, "added_at": databaseValueString(addedAt)}
			clubRow := s.starUnionClub(r, club, country)
			if clubRow != nil {
				item["club_name"] = firstNonEmpty(stringValue(clubRow["name"]), stringValue(clubRow["display_name"]))
				item["club_school"] = stringValue(clubRow["school"])
				item["club_province"] = firstNonEmpty(stringValue(clubRow["province"]), stringValue(clubRow["prefecture"]))
			}
			result = append(result, item)
		}
	}
	return result
}

func (s *Server) starUnionClub(r *http.Request, id int64, country string) map[string]any {
	name := "clubs.json"
	if country == "japan" {
		name = "clubs_japan.json"
	}
	rows, _ := s.extractDocument(name)
	for _, value := range rows {
		if club, ok := value.(map[string]any); ok && integerValue(club["id"]) == id {
			return club
		}
	}
	return nil
}

func (s *Server) starUnionSuperAdmin(ctx context.Context, userID int64) bool {
	var role string
	return s.db.QueryRowContext(ctx, "SELECT role FROM users WHERE id=? AND status='active'", userID).Scan(&role) == nil && role == "super_admin"
}
