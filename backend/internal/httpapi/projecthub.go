package httpapi

import (
	"context"
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// projectHub serves the JSON-backed project hub without changing the public
// endpoint names. The PHP implementation stores these files under data/ and
// the Go FileStore uses the same relative names, so cutover does not require a
// data conversion or a URL change.
func (s *Server) projectHub(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	var input map[string]any
	if r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodDelete {
		if err := decodeJSON(r, &input, 2<<20); err != nil {
			input = map[string]any{}
		}
	}
	method := projectHubEffectiveMethod(r, input)
	if method == http.MethodGet {
		s.projectHubGet(w, r)
		return
	}
	if method != http.MethodPost && method != http.MethodPut && method != http.MethodDelete {
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
	name := strings.TrimPrefix(r.URL.Path, "/api/")
	switch name {
	case "projects.php":
		s.projectHubProjectsWrite(w, r, method, input, user)
	case "project_items.php":
		s.projectHubItemsWrite(w, r, method, input, user)
	case "project_participations.php":
		s.projectHubParticipationsWrite(w, r, method, input, user)
	default:
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "接口不存在"})
	}
}

func projectHubEffectiveMethod(r *http.Request, input map[string]any) string {
	method := r.Method
	if method != http.MethodPost {
		return method
	}
	for _, key := range []string{"ph_method", "project_hub_method", "_method", "method"} {
		if value := strings.ToUpper(strings.TrimSpace(stringValue(input[key]))); value == http.MethodPut || value == http.MethodDelete {
			return value
		}
	}
	for _, key := range []string{"ph_method", "_method"} {
		if value := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get(key))); value == http.MethodPut || value == http.MethodDelete {
			return value
		}
	}
	return method
}

func (s *Server) projectHubGet(w http.ResponseWriter, r *http.Request) {
	switch strings.TrimPrefix(r.URL.Path, "/api/") {
	case "projects.php":
		data := s.projectHubReadMap(r.Context(), "projects.json", map[string]any{"projects": []any{}})
		projects := mapSlice(data["projects"])
		if r.URL.Query().Get("include_deleted") != "1" {
			projects = filterProjectRows(projects, false)
		}
		typ := cleanProjectText(r.URL.Query().Get("type"), 30)
		status := cleanProjectText(r.URL.Query().Get("status"), 30)
		projects = filterProjectField(projects, "project_type", typ)
		projects = filterProjectField(projects, "status", status)
		writeJSON(w, map[string]any{"success": true, "projects": projects})
	case "project_items.php":
		data := s.projectHubReadMap(r.Context(), "project_items.json", map[string]any{"items": []any{}})
		items := mapSlice(data["items"])
		if r.URL.Query().Get("include_deleted") != "1" {
			items = filterProjectRows(items, false)
		}
		if projectID := parsePositiveInt(r.URL.Query().Get("project_id")); projectID > 0 {
			filtered := make([]map[string]any, 0, len(items))
			for _, item := range items {
				if integerValue(item["project_id"]) == projectID {
					filtered = append(filtered, item)
				}
			}
			items = filtered
		}
		writeJSON(w, map[string]any{"success": true, "items": items})
	case "project_participations.php":
		data := s.projectHubReadMap(r.Context(), "project_participations.json", map[string]any{"participations": []any{}})
		rows := mapSlice(data["participations"])
		if r.URL.Query().Get("include_withdrawn") != "1" {
			filtered := rows[:0]
			for _, row := range rows {
				if stringValue(row["status"]) != "withdrawn" {
					filtered = append(filtered, row)
				}
			}
			rows = filtered
		}
		if projectID := parsePositiveInt(r.URL.Query().Get("project_id")); projectID > 0 {
			filtered := make([]map[string]any, 0, len(rows))
			for _, row := range rows {
				if integerValue(row["project_id"]) == projectID {
					filtered = append(filtered, row)
				}
			}
			rows = filtered
		}
		if itemID := cleanProjectText(r.URL.Query().Get("item_id"), 60); itemID != "" {
			filtered := make([]map[string]any, 0, len(rows))
			for _, row := range rows {
				if stringValue(row["item_id"]) == itemID {
					filtered = append(filtered, row)
				}
			}
			rows = filtered
		}
		writeJSON(w, map[string]any{"success": true, "participations": rows})
	}
}

func (s *Server) projectHubProjectsWrite(w http.ResponseWriter, r *http.Request, method string, input map[string]any, user *user) {
	data := s.projectHubReadMap(r.Context(), "projects.json", map[string]any{"projects": []any{}, "migrated_at": nil})
	projects := mapSlice(data["projects"])
	switch method {
	case http.MethodPost:
		title := cleanProjectText(input["title"], 120)
		if title == "" {
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请填写企划名称"})
			return
		}
		organizer := s.projectHubResolveOrganizer(r.Context(), input, user)
		if organizer == nil || integerValue(organizer["id"]) <= 0 {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请先绑定或选择可管理的同好会"})
			return
		}
		if !s.projectHubCanManageClub(r.Context(), user, organizer) {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权以该同好会发起企划"})
			return
		}
		project := map[string]any{
			"id": nextProjectID(projects), "title": title,
			"project_type":   allowedProjectValue(input["project_type"], []string{"publication", "activity", "content", "recruit", "other"}, "publication"),
			"is_joint":       boolValue(input["is_joint"]),
			"status":         allowedProjectValue(input["status"], []string{"draft", "collecting", "ongoing", "completed", "archived"}, "collecting"),
			"organizer_club": organizer, "participant_clubs": normalizeProjectClubs(input["participant_clubs"]),
			"summary": cleanProjectText(input["summary"], 160), "description": cleanProjectText(input["description"], 8000),
			"cover_image": cleanProjectText(input["cover_image"], 500), "deadline": cleanProjectDate(input["deadline"]),
			"event_date": cleanProjectDate(input["event_date"]), "event_date_end": cleanProjectDate(input["event_date_end"]),
			"results_description": cleanProjectText(input["results_description"], 4000), "results_link": cleanProjectText(input["results_link"], 500),
			"deleted_at": nil, "created_at": projectHubNow(), "updated_at": projectHubNow(),
		}
		projects = append(projects, project)
		data["projects"] = projects
		if err := s.projectHubWriteMap(r.Context(), "projects.json", data); err != nil {
			projectHubWriteError(w)
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "企划已创建", "project": project})
	case http.MethodPut:
		id := integerValue(input["id"])
		idx := projectIndex(projects, id)
		if idx < 0 {
			writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "企划不存在"})
			return
		}
		if !s.projectHubCanManageProject(r.Context(), user, projects[idx]) {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
			return
		}
		if raw, exists := input["organizer_club"]; exists {
			club := normalizeProjectClub(raw)
			if club == nil || !s.projectHubCanManageClub(r.Context(), user, club) {
				writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权以该同好会发起企划"})
				return
			}
			projects[idx]["organizer_club"] = club
		}
		for _, field := range []string{"title", "project_type", "status", "summary", "description", "cover_image", "results_description", "results_link"} {
			if _, exists := input[field]; !exists {
				continue
			}
			limit := 500
			if field == "description" {
				limit = 8000
			}
			if field == "results_description" {
				limit = 4000
			}
			projects[idx][field] = cleanProjectText(input[field], limit)
		}
		if _, exists := input["is_joint"]; exists {
			projects[idx]["is_joint"] = boolValue(input["is_joint"])
		}
		if _, exists := input["participant_clubs"]; exists {
			projects[idx]["participant_clubs"] = normalizeProjectClubs(input["participant_clubs"])
		}
		for _, field := range []string{"deadline", "event_date", "event_date_end"} {
			if _, exists := input[field]; exists {
				projects[idx][field] = cleanProjectDate(input[field])
			}
		}
		projects[idx]["updated_at"] = projectHubNow()
		data["projects"] = projects
		if err := s.projectHubWriteMap(r.Context(), "projects.json", data); err != nil {
			projectHubWriteError(w)
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "企划已更新", "project": projects[idx]})
	case http.MethodDelete:
		id := integerValue(input["id"])
		idx := projectIndex(projects, id)
		if idx < 0 {
			writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "企划不存在"})
			return
		}
		if !s.projectHubCanManageProject(r.Context(), user, projects[idx]) {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
			return
		}
		projects[idx]["deleted_at"] = projectHubNow()
		projects[idx]["updated_at"] = projectHubNow()
		data["projects"] = projects
		if err := s.projectHubWriteMap(r.Context(), "projects.json", data); err != nil {
			projectHubWriteError(w)
			return
		}
		// The PHP endpoint also withdraws related records. Keep these changes
		// best-effort and atomic per file; a failed secondary write never erases
		// the primary project record.
		parts := s.projectHubReadMap(r.Context(), "project_participations.json", map[string]any{"participations": []any{}})
		for _, row := range mapSlice(parts["participations"]) {
			if integerValue(row["project_id"]) == id && stringValue(row["status"]) != "withdrawn" {
				row["status"], row["updated_at"] = "withdrawn", projectHubNow()
			}
		}
		_ = s.projectHubWriteMap(r.Context(), "project_participations.json", parts)
		writeJSON(w, map[string]any{"success": true, "message": "企划已删除"})
	}
}

func (s *Server) projectHubItemsWrite(w http.ResponseWriter, r *http.Request, method string, input map[string]any, user *user) {
	data := s.projectHubReadMap(r.Context(), "project_items.json", map[string]any{"items": []any{}})
	items := mapSlice(data["items"])
	projects := s.projectHubRows(r.Context(), "projects.json", "projects")
	if method == http.MethodPost {
		projectID := integerValue(input["project_id"])
		project, idx := projectByID(projects, projectID)
		if idx < 0 || stringValue(project["deleted_at"]) != "" || !s.projectHubCanManageProject(r.Context(), user, project) {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
			return
		}
		label := cleanProjectText(input["label"], 80)
		if label == "" {
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请填写参与项名称"})
			return
		}
		item := map[string]any{"id": nextProjectItemID(items), "project_id": projectID, "type": allowedProjectValue(input["type"], []string{"submission", "registration", "collaboration", "survey", "voting", "other"}, "submission"), "label": label, "description": cleanProjectText(input["description"], 1000), "deadline": cleanProjectDate(input["deadline"]), "status": map[bool]string{true: "closed", false: "open"}[stringValue(input["status"]) == "closed"], "max_slots": nullablePositive(input["max_slots"]), "form_schema": input["form_schema"], "deleted_at": nil, "created_at": projectHubNow(), "updated_at": projectHubNow()}
		items = append(items, item)
		data["items"] = items
		if err := s.projectHubWriteMap(r.Context(), "project_items.json", data); err != nil {
			projectHubWriteError(w)
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "参与项已创建", "item": item})
		return
	}
	id := stringValue(input["id"])
	idx := projectItemIndex(items, id)
	if idx < 0 {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "参与项不存在"})
		return
	}
	project, projectIdx := projectByID(projects, integerValue(items[idx]["project_id"]))
	if projectIdx < 0 || !s.projectHubCanManageProject(r.Context(), user, project) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	switch method {
	case http.MethodPut:
		for _, field := range []string{"label", "description"} {
			if _, exists := input[field]; exists {
				items[idx][field] = cleanProjectText(input[field], map[string]int{"label": 80, "description": 1000}[field])
			}
		}
		if _, exists := input["deadline"]; exists {
			items[idx]["deadline"] = cleanProjectDate(input["deadline"])
		}
		if _, exists := input["status"]; exists {
			items[idx]["status"] = map[bool]string{true: "closed", false: "open"}[stringValue(input["status"]) == "closed"]
		}
		if _, exists := input["max_slots"]; exists {
			items[idx]["max_slots"] = nullablePositive(input["max_slots"])
		}
		if _, exists := input["form_schema"]; exists {
			items[idx]["form_schema"] = input["form_schema"]
		}
		if _, exists := input["type"]; exists {
			items[idx]["type"] = allowedProjectValue(input["type"], []string{"submission", "registration", "collaboration", "survey", "voting", "other"}, "submission")
		}
		items[idx]["updated_at"] = projectHubNow()
	case http.MethodDelete:
		items[idx]["deleted_at"], items[idx]["updated_at"] = projectHubNow(), projectHubNow()
	default:
		writeJSONStatus(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "message": "不支持的请求方法"})
		return
	}
	data["items"] = items
	if err := s.projectHubWriteMap(r.Context(), "project_items.json", data); err != nil {
		projectHubWriteError(w)
		return
	}
	if method == http.MethodDelete {
		writeJSON(w, map[string]any{"success": true, "message": "参与项已删除"})
	} else {
		writeJSON(w, map[string]any{"success": true, "message": "参与项已更新", "item": items[idx]})
	}
}

func (s *Server) projectHubParticipationsWrite(w http.ResponseWriter, r *http.Request, method string, input map[string]any, user *user) {
	data := s.projectHubReadMap(r.Context(), "project_participations.json", map[string]any{"participations": []any{}})
	rows := mapSlice(data["participations"])
	if method == http.MethodPost {
		projectID := integerValue(input["project_id"])
		itemID := cleanProjectText(input["item_id"], 60)
		projects := s.projectHubRows(r.Context(), "projects.json", "projects")
		project, projectIdx := projectByID(projects, projectID)
		items := s.projectHubRows(r.Context(), "project_items.json", "items")
		item, itemIdx := projectItemByID(items, itemID, projectID)
		if projectIdx < 0 || itemIdx < 0 || stringValue(project["deleted_at"]) != "" || stringValue(item["deleted_at"]) != "" {
			writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "企划或参与项不存在"})
			return
		}
		if stringValue(item["status"]) == "closed" {
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "该参与项已关闭"})
			return
		}
		content := cleanProjectText(input["content"], 6000)
		if content == "" {
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请填写参与内容"})
			return
		}
		participantType := "user"
		if stringValue(input["participant_type"]) == "club" {
			participantType = "club"
		}
		club := normalizeProjectClub(input["club"])
		if participantType == "club" && club == nil {
			club = normalizeProjectClub(map[string]any{
				"id":      input["club_id"],
				"country": input["country"],
			})
		}
		if participantType == "club" && (club == nil || !s.projectHubCanManageClub(r.Context(), user, club)) {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权代表该同好会参与"})
			return
		}
		row := map[string]any{"id": nextProjectID(rows), "project_id": projectID, "item_id": itemID, "participant_type": participantType, "user_id": user.ID, "club_id": nullablePositive(clubValue(club, "id")), "club_country": stringValue(clubValue(club, "country")), "display_name": cleanProjectText(firstNonEmpty(stringValue(input["display_name"]), firstNonEmpty(user.Nickname, user.Username)), 80), "contact": cleanProjectText(input["contact"], 200), "content": content, "attachments": input["attachments"], "status": "submitted", "created_at": projectHubNow(), "updated_at": projectHubNow()}
		rows = append(rows, row)
		data["participations"] = rows
		if err := s.projectHubWriteMap(r.Context(), "project_participations.json", data); err != nil {
			projectHubWriteError(w)
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "已提交参与", "participation": row})
		return
	}
	id := integerValue(input["id"])
	idx := projectIndex(rows, id)
	if idx < 0 {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "参与记录不存在"})
		return
	}
	project, projectIdx := projectByID(s.projectHubRows(r.Context(), "projects.json", "projects"), integerValue(rows[idx]["project_id"]))
	if projectIdx < 0 || !s.projectHubCanManageProject(r.Context(), user, project) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	if method != http.MethodPut {
		writeJSONStatus(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "message": "不支持的请求方法"})
		return
	}
	if status := stringValue(input["status"]); status != "" && containsString([]string{"submitted", "reviewing", "accepted", "rejected", "withdrawn"}, status) {
		rows[idx]["status"] = status
	}
	if _, exists := input["review_note"]; exists {
		rows[idx]["review_note"] = cleanProjectText(input["review_note"], 1000)
	}
	rows[idx]["reviewed_by"], rows[idx]["updated_at"] = user.ID, projectHubNow()
	data["participations"] = rows
	if err := s.projectHubWriteMap(r.Context(), "project_participations.json", data); err != nil {
		projectHubWriteError(w)
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "参与记录已更新", "participation": rows[idx]})
}

func (s *Server) projectHubReadMap(ctx context.Context, name string, fallback map[string]any) map[string]any {
	if s.files == nil {
		return fallback
	}
	var data map[string]any
	if err := s.files.ReadJSON(ctx, name, &data); err != nil || data == nil {
		return fallback
	}
	return data
}

func (s *Server) projectHubWriteMap(ctx context.Context, name string, data map[string]any) error {
	if s.files == nil {
		return sql.ErrConnDone
	}
	return s.files.WriteJSONAtomic(ctx, name, data)
}

func (s *Server) projectHubRows(ctx context.Context, name, key string) []map[string]any {
	return mapSlice(s.projectHubReadMap(ctx, name, map[string]any{key: []any{}})[key])
}

func projectHubWriteError(w http.ResponseWriter) {
	writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "保存失败"})
}

func (s *Server) projectHubResolveOrganizer(ctx context.Context, input map[string]any, user *user) map[string]any {
	if club := normalizeProjectClub(input["organizer_club"]); club != nil {
		return club
	}
	if name := cleanProjectText(input["club_name"], 160); name != "" {
		for _, country := range []string{"china", "japan"} {
			data := s.projectHubReadMap(ctx, map[string]string{"china": "clubs.json", "japan": "clubs_japan.json"}[country], map[string]any{"data": []any{}})
			for _, row := range mapSlice(data["data"]) {
				if name == firstNonEmpty(stringValue(row["name"]), firstNonEmpty(stringValue(row["display_name"]), stringValue(row["school"]))) {
					return map[string]any{"id": integerValue(row["id"]), "country": country, "name": name}
				}
			}
		}
	}
	if user.Role != "super_admin" {
		var id int64
		var country string
		if s.db != nil && s.db.QueryRowContext(ctx, "SELECT club_id, COALESCE(country,'china') FROM club_memberships WHERE user_id=? AND role IN ('representative','manager') AND status='active' ORDER BY id LIMIT 1", user.ID).Scan(&id, &country) == nil {
			return map[string]any{"id": id, "country": country}
		}
	}
	if user.Role == "super_admin" {
		id := integerValue(input["club_id"])
		if id > 0 {
			return map[string]any{"id": id, "country": firstNonEmpty(cleanProjectText(input["country"], 20), "china")}
		}
	}
	return nil
}

func (s *Server) projectHubCanManageClub(ctx context.Context, user *user, club map[string]any) bool {
	if user != nil && user.Role == "super_admin" {
		return true
	}
	if user == nil || s.db == nil || club == nil {
		return false
	}
	var id int64
	return s.db.QueryRowContext(ctx, "SELECT id FROM club_memberships WHERE user_id=? AND club_id=? AND COALESCE(country,'china')=? AND role IN ('representative','manager') AND status='active' LIMIT 1", user.ID, integerValue(club["id"]), firstNonEmpty(stringValue(club["country"]), "china")).Scan(&id) == nil
}

func (s *Server) projectHubCanManageProject(ctx context.Context, user *user, project map[string]any) bool {
	club := normalizeProjectClub(project["organizer_club"])
	return s.projectHubCanManageClub(ctx, user, club)
}

func projectHubNow() string { return time.Now().Format("2006-01-02 15:04:05") }

func cleanProjectText(value any, limit int) string {
	text := strings.TrimSpace(stringValue(value))
	if len([]rune(text)) > limit {
		text = string([]rune(text)[:limit])
	}
	return text
}

func cleanProjectDate(value any) string {
	text := cleanProjectText(value, 10)
	if len(text) == 10 && text[4] == '-' && text[7] == '-' {
		if _, err := time.Parse("2006-01-02", text); err == nil {
			return text
		}
	}
	return ""
}

func allowedProjectValue(value any, allowed []string, fallback string) string {
	valueString := stringValue(value)
	if containsString(allowed, valueString) {
		return valueString
	}
	return fallback
}

func normalizeProjectClub(value any) map[string]any {
	row, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	id := integerValue(firstNonNil(row["id"], row["club_id"]))
	if id <= 0 {
		return nil
	}
	country := firstNonEmpty(cleanProjectText(row["country"], 20), "china")
	if country != "china" && country != "japan" {
		return nil
	}
	return map[string]any{"id": id, "country": country, "name": cleanProjectText(firstNonEmpty(stringValue(row["name"]), stringValue(row["club_name"])), 160)}
}

func normalizeProjectClubs(value any) []map[string]any {
	result := []map[string]any{}
	seen := map[string]bool{}
	for _, item := range anySlice(value) {
		club := normalizeProjectClub(item)
		if club == nil {
			continue
		}
		key := stringValue(club["country"]) + ":" + strconvInt(integerValue(club["id"]))
		if !seen[key] {
			seen[key] = true
			result = append(result, club)
		}
	}
	return result
}

func firstNonNil(values ...any) any {
	for _, value := range values {
		if value != nil && stringValue(value) != "" {
			return value
		}
	}
	return nil
}

func clubValue(club map[string]any, key string) any {
	if club == nil {
		return nil
	}
	return club[key]
}

func nullablePositive(value any) any {
	if value == nil || stringValue(value) == "" {
		return nil
	}
	id := integerValue(value)
	if id <= 0 {
		return nil
	}
	return id
}

func mapSlice(value any) []map[string]any {
	result := []map[string]any{}
	switch items := value.(type) {
	case []map[string]any:
		return append(result, items...)
	case []any:
		for _, item := range items {
			if row, ok := item.(map[string]any); ok {
				result = append(result, row)
			}
		}
	}
	return result
}

func filterProjectRows(rows []map[string]any, includeDeleted bool) []map[string]any {
	if includeDeleted {
		return rows
	}
	result := rows[:0]
	for _, row := range rows {
		if stringValue(row["deleted_at"]) == "" {
			result = append(result, row)
		}
	}
	return result
}

func filterProjectField(rows []map[string]any, field, value string) []map[string]any {
	if value == "" || value == "all" {
		return rows
	}
	result := rows[:0]
	for _, row := range rows {
		if stringValue(row[field]) == value {
			result = append(result, row)
		}
	}
	return result
}

func projectIndex(rows []map[string]any, id int64) int {
	for index, row := range rows {
		if integerValue(row["id"]) == id {
			return index
		}
	}
	return -1
}

func projectByID(rows []map[string]any, id int64) (map[string]any, int) {
	index := projectIndex(rows, id)
	if index < 0 {
		return nil, -1
	}
	return rows[index], index
}

func projectItemIndex(rows []map[string]any, id string) int {
	for index, row := range rows {
		if stringValue(row["id"]) == id {
			return index
		}
	}
	return -1
}

func projectItemByID(rows []map[string]any, id string, projectID int64) (map[string]any, int) {
	for index, row := range rows {
		if stringValue(row["id"]) == id && (projectID <= 0 || integerValue(row["project_id"]) == projectID) {
			return row, index
		}
	}
	return nil, -1
}

func nextProjectID(rows []map[string]any) int64 {
	var max int64
	for _, row := range rows {
		if id := integerValue(row["id"]); id > max {
			max = id
		}
	}
	if max+1 < 100000 {
		return 100000
	}
	return max + 1
}

func nextProjectItemID(rows []map[string]any) string {
	max := int64(0)
	for _, row := range rows {
		value := stringValue(row["id"])
		if strings.HasPrefix(value, "item_") {
			if parsed, err := strconv.ParseInt(strings.TrimPrefix(value, "item_"), 10, 64); err == nil && parsed > max {
				max = parsed
			}
		}
	}
	return "item_" + strconvInt(max+1)
}

func strconvInt(value int64) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	buf := [20]byte{}
	index := len(buf)
	for value > 0 {
		index--
		buf[index] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		index--
		buf[index] = '-'
	}
	return string(buf[index:])
}
