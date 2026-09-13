package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

func (s *Server) submit(w http.ResponseWriter, r *http.Request) {
	s.submissionHeaders(w, "GET, POST, PUT, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method == http.MethodGet && r.URL.Query().Get("action") == "read" {
		if !s.requireAdmin(w, r) {
			return
		}
		data, _ := s.readSubmissionArray(r, "submissions.json")
		writeJSON(w, data)
		return
	}
	if r.Method == http.MethodPut && r.URL.Query().Get("action") == "save" {
		s.saveSubmission(w, r, "submissions.json")
		return
	}
	if r.Method != http.MethodPost {
		writeJSONStatus(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "message": "不支持的请求方法"})
		return
	}
	userID, role := s.optionalSessionUser(r)
	if userID == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	input := voteReadJSON(r)
	if len(input) == 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效的数据"})
		return
	}
	input["id"] = s.nextSubmissionID(r, "submissions.json")
	input["status"] = "pending"
	input["submitted_at"] = time.Now().Format("2006-01-02 15:04:05")
	input["user_id"] = *userID
	input["applicant_role"] = normalizeApplicantRole(stringValue(firstValue(input, "applicant_role", "role")))
	input["submitter_username"], input["submitter_nickname"] = s.submissionUserNames(r, *userID)
	_ = role
	items, _ := s.readSubmissionArray(r, "submissions.json")
	items = append(items, input)
	if err := s.writeSubmissionArray(r, "submissions.json", items); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "保存失败，请检查文件权限"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "提交成功", "id": input["id"]})
}

func (s *Server) submitEvent(w http.ResponseWriter, r *http.Request) {
	s.submissionHeaders(w, "GET, POST, PUT, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method == http.MethodGet && r.URL.Query().Get("action") == "read" {
		if !s.requireAdmin(w, r) {
			return
		}
		items, _ := s.readSubmissionArray(r, "submissions_event.json")
		writeJSON(w, items)
		return
	}
	if (r.Method == http.MethodPut) || (r.Method == http.MethodPost && r.URL.Query().Get("action") == "save") {
		s.saveSubmission(w, r, "submissions_event.json")
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "不支持的请求方法"})
		return
	}
	input := voteReadJSON(r)
	if len(input) == 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效的数据"})
		return
	}
	for _, field := range []string{"event", "date", "clubName", "description"} {
		if stringValue(input[field]) == "" {
			writeJSON(w, map[string]any{"success": false, "message": "请填写所有必填字段"})
			return
		}
	}
	item := map[string]any{"id": s.nextSubmissionID(r, "submissions_event.json"), "event": input["event"], "date": input["date"], "clubName": input["clubName"], "location": input["location"], "link": input["link"], "description": input["description"], "image": input["image"], "submitter": input["submitter"], "offical": 0, "status": "pending", "submitted_at": time.Now().Format("2006-01-02 15:04:05")}
	items, _ := s.readSubmissionArray(r, "submissions_event.json")
	items = append(items, item)
	if err := s.writeSubmissionArray(r, "submissions_event.json", items); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "保存失败，请检查文件权限"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "提交成功"})
}

func (s *Server) submitPublication(w http.ResponseWriter, r *http.Request) {
	s.submissionHeaders(w, "GET, POST, PUT, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method == http.MethodGet {
		if !s.requireAdmin(w, r) {
			return
		}
		items, _ := s.readSubmissionArray(r, "submissions_publication.json")
		writeJSON(w, items)
		return
	}
	if r.Method == http.MethodPut || (r.Method == http.MethodPost && r.URL.Query().Get("action") == "save") {
		s.saveSubmission(w, r, "submissions_publication.json")
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "不支持的请求方法"})
		return
	}
	input := voteReadJSON(r)
	if stringValue(input["clubName"]) == "" || stringValue(input["publicationName"]) == "" {
		writeJSON(w, map[string]any{"success": false, "message": "请填写同好会名称和刊物名称"})
		return
	}
	item := map[string]any{"id": s.nextSubmissionID(r, "submissions_publication.json"), "clubName": input["clubName"], "publicationName": input["publicationName"], "submitContact": input["submitContact"], "submitLink": input["submitLink"], "deadline": input["deadline"], "description": input["description"], "image_url": input["image_url"], "club_ids": input["club_ids"], "status": "pending", "submitted_at": time.Now().Format("2006-01-02 15:04:05"), "approved_at": nil, "rejected_at": nil, "publication_id": nil}
	items, _ := s.readSubmissionArray(r, "submissions_publication.json")
	items = append(items, item)
	if err := s.writeSubmissionArray(r, "submissions_publication.json", items); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "保存失败，请检查文件权限"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "投稿成功，请等待管理员审核"})
}

func (s *Server) toggleVisibility(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST 请求"})
		return
	}
	userID, role := s.optionalSessionUser(r)
	if userID == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	input := voteReadJSON(r)
	clubID := integerValue(input["club_id"])
	if clubID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效的俱乐部 ID"})
		return
	}
	country := strings.ToLower(stringValue(input["country"]))
	if country != "japan" {
		country = "china"
	}
	if role != "super_admin" {
		var exists int
		if s.db == nil || s.db.QueryRowContext(r.Context(), "SELECT 1 FROM club_memberships WHERE user_id=? AND club_id=? AND role IN ('representative','manager') AND status='active' LIMIT 1", *userID, clubID).Scan(&exists) != nil {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
			return
		}
	}
	name := "clubs.json"
	if country == "japan" {
		name = "clubs_japan.json"
	}
	var doc map[string]any
	if s.files == nil || s.files.ReadJSON(r.Context(), name, &doc) != nil {
		writeJSON(w, map[string]any{"success": false, "message": "数据文件不存在"})
		return
	}
	rows := anySlice(doc["data"])
	found := false
	visible := boolValue(input["visible"])
	for _, value := range rows {
		if item, ok := value.(map[string]any); ok && integerValue(item["id"]) == clubID {
			item["visible_by_default"] = visible
			found = true
			break
		}
	}
	if !found {
		writeJSON(w, map[string]any{"success": false, "message": "未找到该俱乐部"})
		return
	}
	doc["data"] = rows
	if err := s.files.WriteJSONAtomic(r.Context(), name, doc); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "保存失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": map[bool]string{true: "联系方式已设为公开", false: "联系方式已设为隐藏"}[visible], "visible_by_default": visible})
}

func (s *Server) submissionHeaders(w http.ResponseWriter, methods string) {
	publicAPIHeaders(w)
	w.Header().Set("Access-Control-Allow-Methods", methods)
}

func (s *Server) requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	if _, ok := s.adminUserID(r); !ok {
		requireAdminResponse(w)
		return false
	}
	return true
}

func (s *Server) readSubmissionArray(r *http.Request, name string) ([]map[string]any, error) {
	var raw any
	if s.files == nil {
		return []map[string]any{}, nil
	}
	if err := s.files.ReadJSON(r.Context(), name, &raw); err != nil {
		return []map[string]any{}, err
	}
	result := []map[string]any{}
	for _, value := range anySlice(raw) {
		if item, ok := value.(map[string]any); ok {
			result = append(result, item)
		}
	}
	return result, nil
}

func (s *Server) writeSubmissionArray(r *http.Request, name string, items []map[string]any) error {
	if s.files == nil {
		return errors.New("file store unavailable")
	}
	values := make([]any, len(items))
	for i, item := range items {
		values[i] = item
	}
	return s.files.WriteJSONAtomic(r.Context(), name, values)
}

func (s *Server) nextSubmissionID(r *http.Request, name string) int64 {
	items, _ := s.readSubmissionArray(r, name)
	var max int64
	for _, item := range items {
		if value := integerValue(item["id"]); value > max {
			max = value
		}
	}
	return max + 1
}

func (s *Server) saveSubmission(w http.ResponseWriter, r *http.Request, name string) {
	if !s.requireAdmin(w, r) {
		return
	}
	payload, err := readJSONPayload(r, 10<<20)
	if err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "无效数据"})
		return
	}
	items := mapsFromPayload(payload)
	if len(items) == 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效数据"})
		return
	}
	if err := s.writeSubmissionArray(r, name, items); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "保存失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "保存成功"})
}

func readJSONPayload(r *http.Request, limit int64) (any, error) {
	if r.Body == nil {
		return nil, errors.New("empty request body")
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, errors.New("request body too large")
	}
	var payload any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func mapsFromPayload(payload any) []map[string]any {
	if input, ok := payload.(map[string]any); ok {
		if values, ok := input["items"].([]any); ok {
			return mapsFromAnySlice(values)
		}
		return []map[string]any{input}
	}
	if values, ok := payload.([]any); ok {
		return mapsFromAnySlice(values)
	}
	return nil
}

func mapsFromAnySlice(values []any) []map[string]any {
	result := []map[string]any{}
	for _, value := range values {
		if item, ok := value.(map[string]any); ok {
			result = append(result, item)
		}
	}
	return result
}

func (s *Server) submissionUserNames(r *http.Request, userID int64) (string, string) {
	var username, nickname string
	if s.db != nil {
		_ = s.db.QueryRowContext(r.Context(), "SELECT username,COALESCE(nickname,'') FROM users WHERE id=?", userID).Scan(&username, &nickname)
	}
	return username, nickname
}

func normalizeApplicantRole(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "member", "manager", "representative":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "external"
	}
}

func firstValue(input map[string]any, first, second string) any {
	if value, ok := input[first]; ok {
		return value
	}
	return input[second]
}
