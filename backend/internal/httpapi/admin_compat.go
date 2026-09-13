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

func (s *Server) adminInsightsSummary(w http.ResponseWriter, r *http.Request) {
	country := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("country")))
	if country != "china" && country != "japan" {
		country = "all"
	}
	sources := map[string]any{}
	clubs := 0
	for _, source := range []struct{ file, key, country string }{{"clubs.json", "data", "china"}, {"clubs_japan.json", "data", "japan"}} {
		if country != "all" && country != source.country {
			continue
		}
		rows, err := s.extractDocument(source.file)
		if err != nil {
			sources[source.file] = map[string]any{"status": "unreadable"}
			continue
		}
		clubs += len(rows)
		sources[source.file] = map[string]any{"status": "ok", "count": len(rows)}
	}
	counts := map[string]int64{}
	if s.db != nil {
		for name, query := range map[string]string{"users": "SELECT COUNT(*) FROM users", "memberships": "SELECT COUNT(*) FROM club_memberships", "pending_memberships": "SELECT COUNT(*) FROM club_memberships WHERE status='pending'"} {
			var count int64
			if err := s.db.QueryRowContext(r.Context(), query).Scan(&count); err != nil {
				counts[name] = 0
			} else {
				counts[name] = count
			}
		}
	}
	analytics := map[string]any{}
	if s.db != nil {
		if summary, err := s.analyticsSummary(r.Context(), r.URL.Query().Get("from"), r.URL.Query().Get("to")); err == nil {
			analytics = summary
		}
	}
	writeJSON(w, map[string]any{"success": true, "country": country, "summary": map[string]any{"clubs": clubs, "database": counts, "analytics": analytics}, "sources": sources, "generated_at": time.Now().UTC().Format(time.RFC3339)})
}

func (s *Server) adminInsightsIssues(w http.ResponseWriter, r *http.Request) {
	typeFilter := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("type")))
	severityFilter := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("severity")))
	if typeFilter == "" {
		typeFilter = "all"
	}
	if severityFilter == "" {
		severityFilter = "all"
	}
	page := int(queryInt(r, "page"))
	if page < 1 {
		page = 1
	}
	perPage := int(queryInt(r, "per_page"))
	if perPage < 1 {
		perPage = 50
	}
	if perPage > 100 {
		perPage = 100
	}
	issues := []map[string]any{}
	if s.db != nil {
		rows, err := s.db.QueryContext(r.Context(), "SELECT id,club_id,COALESCE(country,'china'),joined_at FROM club_memberships WHERE status='pending' ORDER BY joined_at ASC")
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var id, clubID int64
				var country string
				var joined any
				if rows.Scan(&id, &clubID, &country, &joined) != nil {
					continue
				}
				if typeFilter != "all" && typeFilter != "queue" {
					continue
				}
				joinedAt := fmt.Sprint(databaseValueString(joined))
				severity := "warning"
				if parsed, err := parseDatabaseTime(joinedAt); err == nil && time.Since(parsed) > 72*time.Hour {
					severity = "urgent"
				}
				if severityFilter != "all" && severityFilter != severity {
					continue
				}
				issues = append(issues, map[string]any{"severity": severity, "type": "queue", "issue_code": "pending_membership", "type_label": "成员绑定", "title": "成员绑定申请", "message": "存在待审核成员绑定", "id": id, "club_id": clubID, "country": country, "submitted_at": joinedAt, "action_url": "reviews.html?module=review&tab=membership&status=pending&id=" + formatInt(id)})
			}
		}
	}
	// Keep public-quality issues deterministic and bounded. This is also useful
	// when the optional growth data is not installed in a local rehearsal DB.
	if typeFilter == "all" || typeFilter == "public_quality" {
		for _, source := range []struct{ file, country string }{{"clubs.json", "china"}, {"clubs_japan.json", "japan"}} {
			rows, _ := s.extractDocument(source.file)
			for _, value := range rows {
				club, ok := value.(map[string]any)
				if !ok || stringValue(club["logo_url"]) != "" {
					continue
				}
				severity := "info"
				if severityFilter != "all" && severityFilter != severity {
					continue
				}
				issues = append(issues, map[string]any{"severity": severity, "type": "public_quality", "issue_code": "missing_logo", "type_label": "公开资料", "title": firstNonEmpty(stringValue(club["display_name"]), stringValue(club["name"])), "message": "缺少 Logo", "country": source.country, "club_id": integerValue(club["id"])})
			}
		}
	}
	start := (page - 1) * perPage
	end := start + perPage
	if start > len(issues) {
		start = len(issues)
	}
	if end > len(issues) {
		end = len(issues)
	}
	writeJSON(w, map[string]any{"success": true, "issues": issues[start:end], "total": len(issues), "page": page, "per_page": perPage, "filters": map[string]any{"type": typeFilter, "severity": severityFilter}})
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
	conditions := map[string]string{
		"review":      "al.action LIKE 'galonly.%' OR al.action LIKE 'galonly_staff.%' OR al.action LIKE 'review.%'",
		"auth":        "al.action LIKE 'user.login' OR al.action LIKE 'user.logout' OR al.action LIKE 'user.register' OR al.action LIKE 'user.%code%'",
		"user":        "(al.action LIKE 'user.%' OR al.action LIKE 'users.%')",
		"club":        "al.action LIKE 'membership.%' OR al.action LIKE 'club.%' OR al.action LIKE 'star_union.%'",
		"announce":    "al.action LIKE 'announcement.%' OR al.action LIKE 'announce.%'",
		"vote":        "al.action LIKE 'vote.%' OR al.action LIKE 'vote_%'",
		"recognition": "al.action LIKE 'recog.%' OR al.action LIKE 'recog_%'",
		"column":      "al.action LIKE 'column.%' OR al.action LIKE 'column_%'",
		"forum":       "al.action LIKE 'forum.%' OR al.action LIKE 'forum_%'",
		"integration": "al.action LIKE 'bot.%' OR al.action LIKE 'bot_%'",
	}
	return conditions[strings.ToLower(strings.TrimSpace(value))]
}
