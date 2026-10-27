package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// adminInsights is a native read-only implementation of the operations page.
// The exact dashboard presentation remains a frontend concern; this handler
// keeps the PHP URL and its summary/issues contract available to the existing
// admin page.
func (s *Server) adminInsights(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet {
		writeJSONStatus(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "message": "仅支持 GET 请求"})
		return
	}
	_, role := s.optionalSessionUser(r)
	if role != "super_admin" {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "运营洞察仅限超级管理员"})
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	if action == "" || action == "summary" {
		s.adminInsightsSummary(w, r)
		return
	}
	if action == "issues" {
		s.adminInsightsIssues(w, r)
		return
	}
	writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知动作", "available_actions": []string{"summary", "issues"}})
}

func parseDatabaseTime(value string) (time.Time, error) {
	for _, layout := range []string{"2006-01-02 15:04:05", time.RFC3339} {
		if parsed, err := time.ParseInLocation(layout, value, time.Local); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, context.Canceled
}

func formatInt(value int64) string {
	return fmt.Sprint(value)
}

func (s *Server) adminLogs(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet {
		writeJSONStatus(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "message": "仅支持 GET 请求"})
		return
	}
	_, role := s.optionalSessionUser(r)
	if role != "super_admin" {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	if r.URL.Query().Get("action") != "list" {
		writeJSON(w, map[string]any{"success": false, "message": "未知动作", "available_actions": []string{"list"}})
		return
	}
	page, perPage := int(queryInt(r, "page")), int(queryInt(r, "per_page"))
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = 50
	}
	if perPage > 200 {
		perPage = 200
	}
	where, args := []string{"1=1"}, []any{}
	if condition := auditTypeCondition(r.URL.Query().Get("type")); condition != "" {
		where = append(where, "("+condition+")")
	}
	if value := strings.TrimSpace(r.URL.Query().Get("date_from")); value != "" {
		where, args = append(where, "al.created_at>=?"), append(args, value+" 00:00:00")
	}
	if value := strings.TrimSpace(r.URL.Query().Get("date_to")); value != "" {
		where, args = append(where, "al.created_at<=?"), append(args, value+" 23:59:59")
	}
	if value := strings.TrimSpace(r.URL.Query().Get("search")); value != "" {
		castType := "TEXT"
		if s.db.Driver == "mysql" {
			castType = "CHAR"
		}
		like := "%" + value + "%"
		where = append(where, "(al.action LIKE ? OR al.target_type LIKE ? OR CAST(al.target_id AS "+castType+") LIKE ? OR CAST(al.user_id AS "+castType+") LIKE ? OR al.ip_address LIKE ? OR u.username LIKE ? OR u.nickname LIKE ? OR al.details LIKE ?)")
		for i := 0; i < 8; i++ {
			args = append(args, like)
		}
	}
	condition := strings.Join(where, " AND ")
	var total int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM audit_logs al LEFT JOIN users u ON u.id=al.user_id WHERE "+condition, args...).Scan(&total); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "日志查询失败"})
		return
	}
	query := "SELECT al.id,al.user_id,al.action,al.target_type,al.target_id,al.details,al.ip_address,al.created_at,u.username,u.nickname,u.role FROM audit_logs al LEFT JOIN users u ON u.id=al.user_id WHERE " + condition + " ORDER BY al.created_at DESC,al.id DESC LIMIT ? OFFSET ?"
	rows, err := s.db.QueryContext(r.Context(), query, append(args, perPage, (page-1)*perPage)...)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "日志查询失败"})
		return
	}
	defer rows.Close()
	logs := []map[string]any{}
	for rows.Next() {
		var id, userID, targetID sqlNullInt64
		var action, targetType, details, ip, created, username, nickname, currentRole sqlNullString
		if err := rows.Scan(&id, &userID, &action, &targetType, &targetID, &details, &ip, &created, &username, &nickname, &currentRole); err != nil {
			continue
		}
		var decoded any
		if details.String != "" {
			_ = json.Unmarshal([]byte(details.String), &decoded)
		}
		requestContext := any(nil)
		if object, ok := decoded.(map[string]any); ok {
			requestContext = object["_context"]
		}
		logs = append(logs, map[string]any{"id": id.Int64, "user_id": nullInt64Value(userID), "action": action.String, "target_type": targetType.String, "target_id": nullInt64Value(targetID), "details": details.String, "ip_address": ip.String, "created_at": created.String, "username": username.String, "nickname": nickname.String, "current_role": currentRole.String, "details_decoded": decoded, "request_context": requestContext})
	}
	writeJSON(w, map[string]any{"success": true, "logs": logs, "total": total, "page": page, "per_page": perPage})
}

type sqlNullInt64 struct {
	Int64 int64
	Valid bool
}

func (value *sqlNullInt64) Scan(input any) error {
	if input == nil {
		value.Valid = false
		return nil
	}
	value.Valid = true
	switch typed := input.(type) {
	case int64:
		value.Int64 = typed
	case int:
		value.Int64 = int64(typed)
	case []byte:
		value.Int64 = integerValue(string(typed))
	default:
		value.Int64 = integerValue(input)
	}
	return nil
}

func nullInt64Value(value sqlNullInt64) any {
	if !value.Valid {
		return nil
	}
	return value.Int64
}

func auditTypeCondition(value string) string {
	authActions := "'user.register','user.login','user.logout','user.send_register_code','user.send_password_reset_code','user.reset_password','user.change_password','user.send_code','user.bind_email','user.unbind_email','user.bind_qq','user.unbind_qq','user.bind_discord','user.unbind_discord'"
	conditions := map[string]string{
		"review":      "al.action LIKE 'galonly.%' OR al.action LIKE 'galonly_staff.%' OR al.action LIKE 'review.%'",
		"auth":        "al.action IN (" + authActions + ")",
		"user":        "(al.action LIKE 'user.%' OR al.action LIKE 'users.%') AND al.action NOT IN (" + authActions + ")",
		"club":        "al.action LIKE 'membership.%' OR al.action LIKE 'club.%' OR al.action LIKE 'club_moe_king.%' OR al.action LIKE 'star_union.%' OR al.action IN ('generate_club_code','revoke_club_code','redeem_club_code','delete_club_comment','add_recommendation','remove_recommendation','reorder_recommendations')",
		"announce":    "al.action LIKE 'announcement.%' OR al.action LIKE 'announce.%'",
		"vote":        "al.action LIKE 'vote.%' OR al.action LIKE 'vote_%'",
		"recognition": "al.action LIKE 'recog.%' OR al.action LIKE 'recog_%'",
		"column":      "al.action LIKE 'column.%' OR al.action LIKE 'column_%'",
		"forum":       "al.action LIKE 'forum.%' OR al.action LIKE 'forum_%'",
		"integration": "al.action LIKE 'bot.%' OR al.action LIKE 'bot_%'",
	}
	typeName := strings.ToLower(strings.TrimSpace(value))
	if typeName == "system" {
		known := make([]string, 0, len(conditions))
		for _, condition := range conditions {
			known = append(known, "("+condition+")")
		}
		return "NOT (" + strings.Join(known, " OR ") + ")"
	}
	return conditions[typeName]
}
