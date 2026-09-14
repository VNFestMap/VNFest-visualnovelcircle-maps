package httpapi

import (
	"net/http"
	"strings"

	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sessionstore"
)

func (s *Server) users(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	_, role := s.optionalSessionUser(r)
	if role != "super_admin" {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	switch strings.ToLower(r.URL.Query().Get("action")) {
	case "stats":
		s.userStats(w, r)
	case "list":
		s.userList(w, r)
	case "get":
		s.userGet(w, r)
	case "update":
		s.userUpdate(w, r)
	case "delete":
		s.userDelete(w, r)
	default:
		writeJSON(w, map[string]any{"success": false, "message": "未知动作"})
	}
}

func (s *Server) userStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	stats := map[string]int64{}
	for key, query := range map[string]string{"total": "SELECT COUNT(*) FROM users", "super_admins": "SELECT COUNT(*) FROM users WHERE role = 'super_admin'", "managers": "SELECT COUNT(*) FROM users WHERE role IN ('representative','manager')", "members": "SELECT COUNT(*) FROM users WHERE role = 'member'", "visitors": "SELECT COUNT(*) FROM users WHERE role = 'visitor'", "banned": "SELECT COUNT(*) FROM users WHERE status = 'banned'"} {
		var count int64
		if err := s.db.QueryRowContext(r.Context(), query).Scan(&count); err != nil {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "查询失败"})
			return
		}
		stats[key] = count
	}
	writeJSON(w, map[string]any{"success": true, "stats": stats})
}

func (s *Server) userList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	page := int64Value(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	perPage := int64Value(r.URL.Query().Get("per_page"))
	if perPage < 1 {
		perPage = 20
	}
	if perPage > 100 {
		perPage = 100
	}
	search, role, status := strings.TrimSpace(r.URL.Query().Get("search")), strings.TrimSpace(r.URL.Query().Get("role")), strings.TrimSpace(r.URL.Query().Get("status"))
	where := []string{"1=1"}
	args := []any{}
	if search != "" {
		where = append(where, "(u.username LIKE ? OR u.nickname LIKE ? OR u.email LIKE ?)")
		needle := "%" + search + "%"
		args = append(args, needle, needle, needle)
	}
	if status != "" {
		where = append(where, "u.status = ?")
		args = append(args, status)
	}
	if role != "" {
		if role == "visitor" {
			where = append(where, "u.role = 'visitor' AND NOT EXISTS (SELECT 1 FROM club_memberships cm WHERE cm.user_id = u.id AND cm.status = 'active')")
		} else if role == "external" || role == "member" || role == "manager" || role == "representative" {
			where = append(where, "EXISTS (SELECT 1 FROM club_memberships cm WHERE cm.user_id = u.id AND cm.role = ? AND cm.status = 'active')")
			args = append(args, role)
		} else {
			where = append(where, "u.role = ?")
			args = append(args, role)
		}
	}
	whereSQL := strings.Join(where, " AND ")
	var total int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM users u WHERE "+whereSQL, args...).Scan(&total); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "查询失败"})
		return
	}
	rows, err := s.db.QueryContext(r.Context(), "SELECT u.id, u.username, COALESCE(u.nickname, ''), COALESCE(u.email, ''), COALESCE(u.avatar_url, ''), u.role, u.status, COALESCE(u.is_audit, 0), u.created_at, u.updated_at, u.last_login_at FROM users u WHERE "+whereSQL+" ORDER BY u.created_at DESC LIMIT ? OFFSET ?", append(args, perPage, (page-1)*perPage)...)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "查询失败"})
		return
	}
	defer rows.Close()
	result := make([]map[string]any, 0)
	userIDs := make([]int64, 0)
	for rows.Next() {
		var id, audit int64
		var username, nickname, email, avatar, userRole, userStatus string
		var created, updated, login any
		if rows.Scan(&id, &username, &nickname, &email, &avatar, &userRole, &userStatus, &audit, &created, &updated, &login) == nil {
			result = append(result, map[string]any{"id": id, "username": username, "nickname": nickname, "email": email, "avatar_url": avatar, "role": userRole, "status": userStatus, "is_audit": audit, "created_at": created, "updated_at": updated, "last_login_at": login, "memberships": []map[string]any{}})
			userIDs = append(userIDs, id)
		}
	}
	if len(userIDs) > 0 {
		placeholders := strings.TrimRight(strings.Repeat("?,", len(userIDs)), ",")
		membershipRows, membershipErr := s.db.QueryContext(r.Context(), "SELECT user_id, id, club_id, COALESCE(country, 'china'), role, status, joined_at FROM club_memberships WHERE user_id IN ("+placeholders+") AND status = 'active' ORDER BY joined_at DESC", int64Args(userIDs)...)
		if membershipErr == nil {
			defer membershipRows.Close()
			byUser := make(map[int64][]map[string]any, len(userIDs))
			for membershipRows.Next() {
				var userID, membershipID, clubID int64
				var country, membershipRole, membershipStatus string
				var joined any
				if membershipRows.Scan(&userID, &membershipID, &clubID, &country, &membershipRole, &membershipStatus, &joined) == nil {
					byUser[userID] = append(byUser[userID], map[string]any{"id": membershipID, "club_id": clubID, "country": country, "role": membershipRole, "status": membershipStatus, "joined_at": joined})
				}
			}
			for _, item := range result {
				memberships := byUser[integerValue(item["id"])]
				if memberships == nil {
					memberships = []map[string]any{}
				}
				item["memberships"] = memberships
				item["display_role"] = displayRole(stringValue(item["role"]), memberships)
			}
		}
	}
	/* Even an empty membership query must expose a stable effective level. */
	for _, item := range result {
		if _, ok := item["display_role"]; !ok {
			item["display_role"] = displayRole(stringValue(item["role"]), nil)
		}
	}
	writeJSON(w, map[string]any{"success": true, "users": result, "total": total, "page": page, "per_page": perPage, "pagination": map[string]any{"page": page, "per_page": perPage, "total": total, "total_pages": (total + perPage - 1) / perPage}})
}

func int64Args(values []int64) []any {
	args := make([]any, len(values))
	for index, value := range values {
		args[index] = value
	}
	return args
}

func (s *Server) userGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	id := queryInt(r, "id")
	if id <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "缺少用户 ID"})
		return
	}
	var username, nickname, email, avatar, role, status string
	var audit int64
	var created, updated, login any
	if err := s.db.QueryRowContext(r.Context(), "SELECT username, COALESCE(nickname, ''), COALESCE(email, ''), COALESCE(avatar_url, ''), role, status, COALESCE(is_audit, 0), created_at, updated_at, last_login_at FROM users WHERE id = ?", id).Scan(&username, &nickname, &email, &avatar, &role, &status, &audit, &created, &updated, &login); err != nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "用户不存在"})
		return
	}
	memberships := s.userMembershipRows(r, id)
	writeJSON(w, map[string]any{"success": true, "user": map[string]any{"id": id, "username": username, "nickname": nickname, "email": email, "avatar_url": avatar, "role": role, "status": status, "is_audit": audit, "created_at": created, "updated_at": updated, "last_login_at": login, "memberships": memberships, "display_role": displayRole(role, memberships)}})
}

func (s *Server) userUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	currentID, _ := s.optionalSessionUser(r)
	var input map[string]any
	_ = decodeJSON(r, &input, 128<<10)
	id := mapPositiveInt(input, "id")
	if id <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "缺少用户 ID"})
		return
	}
	if currentID != nil && *currentID == id && (mapString(input, "role") != "" && mapString(input, "role") != "super_admin" || mapString(input, "status") != "" && mapString(input, "status") != "active") {
		writeJSON(w, map[string]any{"success": false, "message": "不能降低或禁用自己的管理员权限"})
		return
	}
	updates, args := []string{}, []any{}
	for _, field := range []string{"nickname", "profile_bio", "language_preference", "role", "status"} {
		if value, ok := input[field]; ok {
			if field == "nickname" && len([]rune(mapString(input, field))) > 30 {
				writeJSON(w, map[string]any{"success": false, "message": "昵称过长"})
				return
			}
			updates = append(updates, field+" = ?")
			args = append(args, stringValue(value))
		}
	}
	if value, ok := input["is_audit"]; ok {
		updates = append(updates, "is_audit = ?")
		args = append(args, mapBoolInt(map[string]any{"value": value}, "value", false))
	}
	if len(updates) == 0 {
		writeJSON(w, map[string]any{"success": false, "message": "没有可更新的字段"})
		return
	}
	updates = append(updates, "updated_at = CURRENT_TIMESTAMP")
	args = append(args, id)
	result, err := s.db.ExecContext(r.Context(), "UPDATE users SET "+strings.Join(updates, ", ")+" WHERE id = ?", args...)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "用户信息更新失败"})
		return
	}
	if mustRowsAffected(result) != 1 {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "用户不存在"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "用户信息已更新"})
}

func (s *Server) userDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	currentID, _ := s.optionalSessionUser(r)
	var input map[string]any
	_ = decodeJSON(r, &input, 64<<10)
	id := mapPositiveInt(input, "id")
	if id <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "缺少用户 ID"})
		return
	}
	if currentID != nil && *currentID == id {
		writeJSON(w, map[string]any{"success": false, "message": "不能封禁自己的账号"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), "UPDATE users SET status = 'banned', updated_at = CURRENT_TIMESTAMP WHERE id = ?", id)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "封禁用户失败"})
		return
	}
	if mustRowsAffected(result) != 1 {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "用户不存在"})
		return
	}
	if s.sessions != nil {
		if store, ok := s.sessions.Store.(*sessionstore.Store); ok {
			_ = store.InvalidateUserSessions(r.Context(), id)
		}
	}
	writeJSON(w, map[string]any{"success": true, "message": "用户已封禁"})
}

func (s *Server) userMembershipRows(r *http.Request, id int64) []map[string]any {
	rows, err := s.db.QueryContext(r.Context(), "SELECT id, club_id, COALESCE(country, 'china'), role, status, joined_at FROM club_memberships WHERE user_id = ? ORDER BY joined_at DESC", id)
	if err != nil {
		return []map[string]any{}
	}
	defer rows.Close()
	result := []map[string]any{}
	for rows.Next() {
		var membershipID, clubID int64
		var country, role, status string
		var joined any
		if rows.Scan(&membershipID, &clubID, &country, &role, &status, &joined) == nil {
			result = append(result, map[string]any{"id": membershipID, "club_id": clubID, "country": country, "role": role, "status": status, "joined_at": joined})
		}
	}
	return result
}
func displayRole(role string, memberships []map[string]any) string {
	bestRole := role
	bestLevel := permissionRoleLevel(role)
	if bestLevel < 0 {
		bestRole, bestLevel = "visitor", permissionRoleLevel("visitor")
	}
	for _, membership := range memberships {
		if membership["status"] != "active" {
			continue
		}
		candidate := stringValue(membership["role"])
		candidateLevel := permissionRoleLevel(candidate)
		if candidateLevel > bestLevel {
			bestRole, bestLevel = candidate, candidateLevel
		}
	}
	return bestRole
}

func permissionRoleLevel(role string) int {
	switch role {
	case "visitor":
		return 0
	case "external":
		return 1
	case "member":
		return 2
	case "manager":
		return 3
	case "representative":
		return 4
	case "super_admin":
		return 5
	default:
		return -1
	}
}
