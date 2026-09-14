package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func (s *Server) clubs(w http.ResponseWriter, r *http.Request) {
	s.clubList(w, r, "clubs.json", "china")
}
func (s *Server) clubsJapan(w http.ResponseWriter, r *http.Request) {
	s.clubList(w, r, "clubs_japan.json", "japan")
}

func (s *Server) clubList(w http.ResponseWriter, r *http.Request, fileName, country string) {
	if r.Method == http.MethodOptions {
		publicAPIHeaders(w)
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet {
		s.clubListWrite(w, r, fileName, country)
		return
	}
	publicAPIHeaders(w)
	var document map[string]any
	if err := s.files.ReadJSON(r.Context(), fileName, &document); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSON(w, map[string]any{"success": true, "total": 0, "data": []any{}})
			return
		}
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "无法读取同好会数据"})
		return
	}
	rows, _ := document["data"].([]any)
	userID, role := s.optionalSessionUser(r)
	roleLevel := map[string]float64{"visitor": 0, "external": 0.5, "member": 1, "manager": 2, "representative": 3, "super_admin": 4}[role]
	memberships := s.membershipMap(r.Context(), userID)
	for _, raw := range rows {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		itemCountry := stringValue(item["country"])
		if itemCountry == "" {
			itemCountry = country
		}
		id := integerValue(item["id"])
		key := strconv.FormatInt(id, 10) + ":" + itemCountry
		membership := memberships[key]
		isMember := membership.status == "active" && membership.membershipRole != "external"
		hasPending := membership.status == "pending"
		visibleDefault := boolValue(item["visible_by_default"])
		protected := boolValue(item["protected"])
		rawContact := stringValue(item["info"])
		canSeeAll := roleLevel >= 1
		// A manager and a representative are both responsible for contact
		// coordination. Keep protected group information hidden from ordinary
		// members while allowing either management role to read it.
		canSeeProtected := roleLevel >= 2
		infoHidden := false
		if protected {
			infoHidden = !isMember && !hasPending && !canSeeProtected
		} else {
			infoHidden = !isMember && !hasPending && !visibleDefault && !canSeeAll
		}
		item["info_hidden"] = infoHidden
		item["can_apply"] = userID != nil && !isMember && !hasPending
		if membership.status != "" {
			item["membership_status"] = membership.status
		} else {
			item["membership_status"] = nil
		}
		if infoHidden {
			item["info"] = "申请绑定后可见"
		}
		item["country"] = itemCountry
		item["share_url"] = "./club_share.html?club=" + url.QueryEscape(itemCountry+":"+strconv.FormatInt(id, 10))
		item["completeness"] = map[string]any{"score": 0, "missing": []string{"logo", "intro", "public_contact", "external_links", "wiki", "events", "publications"}}
		item["dynamic_summary"] = map[string]any{"events": 0, "publications": 0, "has_wiki": false}
		publicContact := ""
		if visibleDefault && !protected {
			publicContact = rawContact
		}
		item["public_contact"] = publicContact
	}
	if document == nil {
		document = map[string]any{}
	}
	document["success"] = true
	document["total"] = len(rows)
	document["data"] = rows
	writeJSON(w, document)
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		publicAPIHeaders(w)
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet {
		if r.Method == http.MethodPost {
			s.eventsWrite(w, r)
			return
		}
		methodNotAllowed(w, "GET, POST")
		return
	}
	publicAPIHeaders(w)
	var document map[string]any
	if err := s.files.ReadJSON(r.Context(), "events.json", &document); err != nil && !errors.Is(err, os.ErrNotExist) {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "无法读取活动数据"})
		return
	}
	if document == nil {
		document = map[string]any{}
	}
	rows, _ := document["events"].([]any)
	if rows == nil {
		rows = []any{}
	}
	if r.URL.Query().Get("action") == "registrations" {
		var registrations []any
		if err := s.files.ReadJSON(r.Context(), "event_registrations.json", &registrations); err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "无法读取报名数据"})
				return
			}
			registrations = []any{}
		}
		eventID := integerValue(r.URL.Query().Get("event_id"))
		if eventID > 0 {
			filtered := make([]any, 0, len(registrations))
			for _, item := range registrations {
				if row, ok := item.(map[string]any); ok && integerValue(row["event_id"]) == eventID {
					filtered = append(filtered, row)
				}
			}
			registrations = filtered
		}
		writeJSON(w, map[string]any{"success": true, "registrations": registrations})
		return
	}
	if r.URL.Query().Get("action") == "list" {
		writeJSON(w, map[string]any{"success": true, "events": rows})
		return
	}
	writeJSON(w, map[string]any{"events": rows})
}

func (s *Server) eventsWrite(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if s.files == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "文件存储不可用"})
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	input := map[string]any{}
	if err := json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(&input); err != nil {
		input = map[string]any{}
	}
	var userID *int64
	var role string
	if action == "register" || action == "unregister" {
		userID, role = s.optionalSessionUser(r)
		_ = role
		if userID == nil {
			writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
			return
		}
	} else {
		userID, role = s.optionalSessionUser(r)
		if userID == nil {
			writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "未授权访问"})
			return
		}
		if role != "super_admin" && role != "manager" && role != "representative" {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "未授权访问"})
			return
		}
	}
	if action == "register" || action == "unregister" {
		s.eventRegistration(w, r, action, *userID, input)
		return
	}
	var document map[string]any
	if err := s.files.ReadJSON(r.Context(), "events.json", &document); err != nil && !errors.Is(err, os.ErrNotExist) {
		writeJSON(w, map[string]any{"success": false, "message": "无法打开数据文件", "code": "file_open_failed"})
		return
	}
	if document == nil {
		document = map[string]any{}
	}
	rows, _ := document["events"].([]any)
	if rows == nil {
		rows = []any{}
	}
	switch action {
	case "add":
		if err := validateEvent(input, false); err != nil {
			writeJSON(w, err)
			return
		}
		key := eventKey(input)
		for _, item := range rows {
			if existing, ok := item.(map[string]any); ok && eventKey(existing) == key {
				writeJSON(w, map[string]any{"success": false, "message": "同名同日期活动已存在", "code": "duplicate_event"})
				return
			}
		}
		id := maxEventID(rows) + 1
		event := sanitizeEvent(input)
		event["id"] = id
		event["created_at"] = time.Now().Format("2006-01-02 15:04:05")
		rows = append(rows, event)
		document["events"] = rows
		if err := s.files.WriteJSONAtomic(r.Context(), "events.json", document); err != nil {
			writeJSON(w, map[string]any{"success": false, "message": "保存失败，请检查文件权限", "code": "file_write_failed"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "活动已添加", "event": event, "data": map[string]any{"events": rows}})
	case "update":
		eventID := integerValue(input["event_id"])
		if eventID <= 0 {
			writeJSON(w, map[string]any{"success": false, "message": "缺少活动 ID", "code": "event_id_required"})
			return
		}
		if err := validateEvent(input, true); err != nil {
			writeJSON(w, err)
			return
		}
		index := -1
		for i, item := range rows {
			if existing, ok := item.(map[string]any); ok && integerValue(existing["id"]) == eventID {
				index = i
				break
			}
		}
		if index < 0 {
			writeJSON(w, map[string]any{"success": false, "message": "活动不存在", "code": "event_not_found"})
			return
		}
		updated := sanitizeEvent(input, rows[index].(map[string]any))
		updated["id"] = eventID
		updated["updated_at"] = time.Now().Format("2006-01-02 15:04:05")
		for i, item := range rows {
			if i != index {
				if existing, ok := item.(map[string]any); ok && eventKey(existing) == eventKey(updated) {
					writeJSON(w, map[string]any{"success": false, "message": "同名同日期活动已存在", "code": "duplicate_event"})
					return
				}
			}
		}
		rows[index] = updated
		document["events"] = rows
		if err := s.files.WriteJSONAtomic(r.Context(), "events.json", document); err != nil {
			writeJSON(w, map[string]any{"success": false, "message": "保存失败，请检查文件权限", "code": "file_write_failed"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "活动已更新", "event": updated, "data": map[string]any{"events": rows}})
	case "delete":
		eventID := integerValue(input["event_id"])
		if eventID <= 0 {
			writeJSON(w, map[string]any{"success": false, "message": "缺少活动 ID", "code": "event_id_required"})
			return
		}
		next := []any{}
		found := false
		for _, item := range rows {
			if existing, ok := item.(map[string]any); ok && integerValue(existing["id"]) == eventID {
				found = true
				continue
			}
			next = append(next, item)
		}
		if !found {
			writeJSON(w, map[string]any{"success": false, "message": "活动不存在", "code": "event_not_found"})
			return
		}
		document["events"] = next
		if err := s.files.WriteJSONAtomic(r.Context(), "events.json", document); err != nil {
			writeJSON(w, map[string]any{"success": false, "message": "保存失败，请检查文件权限", "code": "file_write_failed"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "活动已删除", "events": next, "data": map[string]any{"events": next}})
	case "replace":
		incoming, _ := input["events"].([]any)
		for _, item := range incoming {
			if event, ok := item.(map[string]any); ok {
				if err := validateEvent(event, false); err != nil {
					writeJSON(w, err)
					return
				}
			}
		}
		document["events"] = incoming
		if err := s.files.WriteJSONAtomic(r.Context(), "events.json", document); err != nil {
			writeJSON(w, map[string]any{"success": false, "message": "保存失败，请检查文件权限", "code": "file_write_failed"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "活动已合并保存", "events": incoming, "data": map[string]any{"events": incoming}})
	default:
		writeJSON(w, map[string]any{"success": false, "message": "不支持的请求方法", "code": "unsupported_method"})
	}
}

func (s *Server) eventRegistration(w http.ResponseWriter, r *http.Request, action string, userID int64, input map[string]any) {
	eventID := integerValue(input["event_id"])
	if eventID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "缺少活动 ID", "code": "event_id_required"})
		return
	}
	var registrations []any
	var loaded []any
	if err := s.files.ReadJSON(r.Context(), "event_registrations.json", &loaded); err == nil {
		registrations = loaded
	} else if !errors.Is(err, os.ErrNotExist) {
		writeJSON(w, map[string]any{"success": false, "message": "无法打开数据文件", "code": "file_open_failed"})
		return
	}
	if action == "register" {
		for _, item := range registrations {
			if row, ok := item.(map[string]any); ok && integerValue(row["event_id"]) == eventID && integerValue(row["user_id"]) == userID {
				writeJSON(w, map[string]any{"success": false, "message": "您已报名该活动", "code": "already_registered"})
				return
			}
		}
		username := ""
		if s.db != nil {
			_ = s.db.QueryRowContext(r.Context(), "SELECT COALESCE(nickname, username, '') FROM users WHERE id = ?", userID).Scan(&username)
		}
		registrations = append(registrations, map[string]any{"event_id": eventID, "user_id": userID, "username": username, "registered_at": time.Now().Format("2006-01-02 15:04:05")})
		if err := s.files.WriteJSONAtomic(r.Context(), "event_registrations.json", registrations); err != nil {
			writeJSON(w, map[string]any{"success": false, "message": "保存失败，请检查文件权限", "code": "file_write_failed"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "报名成功", "registrations": registrations, "data": registrations})
		return
	}
	next := []any{}
	found := false
	for _, item := range registrations {
		if row, ok := item.(map[string]any); ok && integerValue(row["event_id"]) == eventID && integerValue(row["user_id"]) == userID {
			found = true
			continue
		}
		next = append(next, item)
	}
	if !found {
		writeJSON(w, map[string]any{"success": false, "message": "您未报名该活动", "code": "registration_not_found"})
		return
	}
	if err := s.files.WriteJSONAtomic(r.Context(), "event_registrations.json", next); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "保存失败，请检查文件权限", "code": "file_write_failed"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "已取消报名", "registrations": next, "data": next})
}

var eventDatePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func validateEvent(input map[string]any, partial bool) map[string]any {
	name, date, dateEnd := stringValue(input["event"]), stringValue(input["date"]), stringValue(input["date_end"])
	if !partial || inputHas(input, "event") {
		if name == "" {
			return map[string]any{"success": false, "message": "活动名称不能为空", "code": "event_name_required"}
		}
	}
	if !partial || inputHas(input, "date") {
		if date == "" {
			return map[string]any{"success": false, "message": "活动日期不能为空", "code": "event_date_required"}
		}
		if !eventDatePattern.MatchString(date) {
			return map[string]any{"success": false, "message": "活动日期格式无效", "code": "invalid_event_date"}
		}
	}
	if dateEnd != "" {
		if !eventDatePattern.MatchString(dateEnd) {
			return map[string]any{"success": false, "message": "结束日期格式无效", "code": "invalid_event_date_end"}
		}
		if date != "" && dateEnd < date {
			return map[string]any{"success": false, "message": "结束日期不能早于开始日期", "code": "invalid_date_range"}
		}
	}
	return nil
}
func eventKey(event map[string]any) string {
	return stringValue(event["event"]) + "|" + stringValue(event["date"])
}
func maxEventID(rows []any) int64 {
	var max int64
	for _, item := range rows {
		if row, ok := item.(map[string]any); ok && integerValue(row["id"]) > max {
			max = integerValue(row["id"])
		}
	}
	return max
}
func sanitizeEvent(input map[string]any, base ...map[string]any) map[string]any {
	result := map[string]any{}
	if len(base) > 0 {
		for key, value := range base[0] {
			result[key] = value
		}
	}
	for _, key := range []string{"event", "date", "date_end", "image", "raw_text", "offical", "description", "link"} {
		if value, ok := input[key]; ok {
			if key == "date_end" && (stringValue(value) == "" || value == false) {
				result[key] = nil
			} else if key == "offical" {
				result[key] = boolInt(boolValue(value))
			} else {
				result[key] = value
			}
		}
	}
	return result
}
func inputHas(input map[string]any, key string) bool { _, ok := input[key]; return ok }

func (s *Server) announcements(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		publicAPIHeaders(w)
		w.WriteHeader(http.StatusOK)
		return
	}
	s.announcementAction(w, r)
}

type membershipInfo struct{ status, membershipRole string }

func (s *Server) membershipMap(ctx context.Context, userID *int64) map[string]membershipInfo {
	result := map[string]membershipInfo{}
	if userID == nil || s.db == nil {
		return result
	}
	rows, err := s.db.QueryContext(ctx, `SELECT club_id, COALESCE(country, 'china'), status, role FROM club_memberships WHERE user_id = ?`, *userID)
	if err != nil {
		return result
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var country, status, role string
		if rows.Scan(&id, &country, &status, &role) == nil {
			result[strconv.FormatInt(id, 10)+":"+country] = membershipInfo{status: status, membershipRole: role}
		}
	}
	return result
}

func (s *Server) optionalSessionUser(r *http.Request) (*int64, string) {
	if s.sessions == nil || s.sessions.Store == nil || s.db == nil {
		return nil, ""
	}
	session, err := s.sessions.LoadRequest(r.Context(), r)
	if err != nil || session == nil || session.UserID == nil {
		return nil, ""
	}
	var role string
	if err := s.db.QueryRowContext(r.Context(), "SELECT role FROM users WHERE id = ? AND status = 'active'", *session.UserID).Scan(&role); err != nil {
		return session.UserID, ""
	}
	return session.UserID, role
}

func publicAPIHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token, Authorization")
	w.Header().Set("Cache-Control", "no-store")
}
func stringValue(value any) string {
	switch item := value.(type) {
	case string:
		return strings.TrimSpace(item)
	case []byte:
		return strings.TrimSpace(string(item))
	default:
		return ""
	}
}
func integerValue(value any) int64 {
	switch item := value.(type) {
	case float64:
		return int64(item)
	case int64:
		return item
	case int:
		return int64(item)
	case string:
		parsed, _ := strconv.ParseInt(item, 10, 64)
		return parsed
	}
	return 0
}
func boolValue(value any) bool {
	switch item := value.(type) {
	case bool:
		return item
	case float64:
		return item != 0
	case int64:
		return item != 0
	case string:
		return item == "1" || strings.EqualFold(item, "true")
	}
	return false
}
func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
