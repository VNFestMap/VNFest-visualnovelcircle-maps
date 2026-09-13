package httpapi

import (
	"context"
	"database/sql"
	"net/http"
	"strings"

	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

func (s *Server) membership(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	switch action {
	case "my":
		s.membershipMy(w, r)
	case "apply":
		s.membershipApply(w, r)
	case "members":
		s.membershipMembers(w, r)
	case "pending":
		s.membershipPending(w, r)
	case "club_member_counts":
		s.membershipCounts(w, r)
	case "set_application_email_recipient":
		s.membershipEmailRecipient(w, r)
	case "approve", "reject":
		s.membershipReview(w, r, action)
	case "leave":
		s.membershipLeave(w, r)
	case "kick":
		s.membershipKick(w, r)
	case "change_role":
		s.membershipChangeRole(w, r)
	case "transfer":
		s.membershipTransfer(w, r)
	case "grant_from_submission":
		s.membershipGrantFromSubmission(w, r)
	default:
		writeJSON(w, map[string]any{"success": false, "message": "未知动作"})
	}
}

func (s *Server) membershipMy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSON(w, map[string]any{"success": true, "memberships": []any{}})
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT id, club_id, COALESCE(country, 'china'), role, status, joined_at FROM club_memberships WHERE user_id = ? ORDER BY joined_at DESC`, userID)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "无法读取成员身份"})
		return
	}
	defer rows.Close()
	result := make([]map[string]any, 0)
	for rows.Next() {
		var id, clubID int64
		var country, role, status string
		var joined any
		if rows.Scan(&id, &clubID, &country, &role, &status, &joined) == nil {
			result = append(result, map[string]any{"id": id, "club_id": clubID, "country": country, "role": role, "status": status, "joined_at": joined})
		}
	}
	writeJSON(w, map[string]any{"success": true, "memberships": result})
}

func (s *Server) membershipApply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	var input map[string]any
	if decodeJSON(r, &input, 256<<10) != nil {
		writeJSON(w, map[string]any{"success": false, "message": "请求数据格式错误"})
		return
	}
	clubID := mapPositiveInt(input, "club_id")
	if clubID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效的同好会 ID"})
		return
	}
	country := normalizeCountry(mapString(input, "country"))
	joinMethod := mapString(input, "join_method")
	if joinMethod != "external_exchange" {
		joinMethod = "school_no_code"
	}
	applyRole := mapString(input, "apply_role")
	if joinMethod == "external_exchange" {
		applyRole = "external"
	}
	if applyRole != "member" && applyRole != "manager" && applyRole != "representative" && applyRole != "external" {
		applyRole = "member"
	}
	var existingID int64
	var existingStatus string
	err := s.db.QueryRowContext(r.Context(), "SELECT id, status FROM club_memberships WHERE user_id = ? AND club_id = ? AND COALESCE(country, 'china') = ? LIMIT 1", userID, clubID, country).Scan(&existingID, &existingStatus)
	if err == nil {
		switch existingStatus {
		case "active":
			writeJSON(w, map[string]any{"success": false, "message": "你已绑定该同好会"})
			return
		case "pending":
			writeJSON(w, map[string]any{"success": false, "message": "绑定申请已提交，请等待审核"})
			return
		}
	}
	if joinMethod == "external_exchange" && (mapString(input, "external_club_name") == "" || mapString(input, "external_club_role") == "" || mapString(input, "apply_reason") == "") {
		writeJSON(w, map[string]any{"success": false, "message": "请填写所属同好会、身份和申请理由"})
		return
	}
	args := []any{applyRole, mapString(input, "qq_account"), mapString(input, "contact_account"), applyRole, mapBoolInt(input, "is_student", true), country, joinMethod, mapString(input, "external_club_name"), mapString(input, "external_club_role"), mapString(input, "apply_reason")}
	var id int64
	if existingID > 0 {
		result, err := s.db.ExecContext(r.Context(), `UPDATE club_memberships SET role = ?, status = 'pending', qq_account = ?, contact_account = ?, apply_role = ?, is_student = ?, country = ?, join_method = ?, external_club_name = ?, external_club_role = ?, apply_reason = ?, joined_at = CURRENT_TIMESTAMP, reviewed_at = NULL, reviewed_by = NULL, left_at = NULL WHERE id = ?`, append(args, existingID)...)
		if err != nil || mustRowsAffected(result) != 1 {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "绑定申请提交失败"})
			return
		}
		id = existingID
	} else {
		result, err := s.db.ExecContext(r.Context(), `INSERT INTO club_memberships (user_id, club_id, role, status, qq_account, contact_account, apply_role, is_student, country, join_method, external_club_name, external_club_role, apply_reason, joined_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, append([]any{userID, clubID}, args...)...)
		if err != nil {
			writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "绑定申请提交失败"})
			return
		}
		id, _ = result.LastInsertId()
	}
	writeJSON(w, map[string]any{"success": true, "message": "绑定申请已提交，等待管理员审核", "membership": map[string]any{"id": id, "status": "pending"}})
}

func (s *Server) membershipMembers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	clubID := queryInt(r, "club_id")
	country := normalizeCountry(r.URL.Query().Get("country"))
	if clubID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效的俱乐部 ID"})
		return
	}
	if !s.canManageMembership(r.Context(), userID, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT cm.id, cm.user_id, cm.role, cm.status, cm.joined_at, COALESCE(cm.application_email_enabled, 1), COALESCE(cm.qq_account, ''), COALESCE(cm.contact_account, ''), COALESCE(cm.apply_role, ''), COALESCE(cm.is_student, 0), COALESCE(cm.join_method, ''), COALESCE(cm.external_club_name, ''), COALESCE(cm.external_club_role, ''), COALESCE(cm.apply_reason, ''), u.username, COALESCE(u.nickname, ''), COALESCE(u.email, ''), COALESCE(u.avatar_url, '') FROM club_memberships cm JOIN users u ON u.id = cm.user_id WHERE cm.club_id = ? AND COALESCE(cm.country, 'china') = ? AND cm.status = 'active' ORDER BY cm.joined_at ASC`, clubID, country)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "成员查询失败"})
		return
	}
	defer rows.Close()
	result := make([]map[string]any, 0)
	_, role := s.optionalSessionUser(r)
	isSuper := role == "super_admin"
	for rows.Next() {
		var id, memberID int64
		var memberRole, status string
		var joined any
		var emailEnabled, student int64
		var qq, contact, applyRole, joinMethod, extName, extRole, reason, username, nickname, email, avatar string
		if rows.Scan(&id, &memberID, &memberRole, &status, &joined, &emailEnabled, &qq, &contact, &applyRole, &student, &joinMethod, &extName, &extRole, &reason, &username, &nickname, &email, &avatar) != nil {
			continue
		}
		item := map[string]any{"id": id, "user_id": memberID, "role": memberRole, "status": status, "joined_at": joined, "application_email_enabled": emailEnabled, "username": username, "nickname": nickname, "email": email, "avatar_url": avatar}
		if isSuper {
			item["qq_account"], item["contact_account"], item["apply_role"], item["is_student"], item["join_method"], item["external_club_name"], item["external_club_role"], item["apply_reason"] = qq, contact, applyRole, student, joinMethod, extName, extRole, reason
		}
		result = append(result, item)
	}
	writeJSON(w, map[string]any{"success": true, "members": result})
}

func (s *Server) membershipPending(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	_, role := s.optionalSessionUser(r)
	all := r.URL.Query().Get("status") == "all"
	filter := "AND cm.status = 'pending'"
	if all {
		filter = ""
	}
	query := `SELECT cm.id, cm.user_id, cm.club_id, COALESCE(cm.country, 'china'), cm.status, cm.joined_at, COALESCE(cm.apply_role, ''), COALESCE(cm.qq_account, ''), COALESCE(cm.contact_account, ''), COALESCE(cm.is_student, 0), COALESCE(cm.join_method, ''), COALESCE(cm.external_club_name, ''), COALESCE(cm.external_club_role, ''), COALESCE(cm.apply_reason, ''), u.username, COALESCE(u.avatar_url, '') FROM club_memberships cm JOIN users u ON u.id = cm.user_id WHERE 1=1 ` + filter
	var rows *sql.Rows
	var err error
	if role == "super_admin" {
		rows, err = s.db.QueryContext(r.Context(), query+" ORDER BY cm.joined_at ASC")
	} else {
		rows, err = s.db.QueryContext(r.Context(), query+` AND EXISTS (SELECT 1 FROM club_memberships mgr WHERE mgr.user_id = ? AND mgr.role IN ('representative', 'manager') AND mgr.status = 'active' AND mgr.club_id = cm.club_id AND COALESCE(mgr.country, 'china') = COALESCE(cm.country, 'china')) ORDER BY cm.joined_at ASC`, userID)
	}
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "申请查询失败"})
		return
	}
	defer rows.Close()
	result := make([]map[string]any, 0)
	for rows.Next() {
		var id, memberID, clubID, student int64
		var country, status, applyRole, qq, contact, joinMethod, extName, extRole, reason, username, avatar string
		var joined any
		if rows.Scan(&id, &memberID, &clubID, &country, &status, &joined, &applyRole, &qq, &contact, &student, &joinMethod, &extName, &extRole, &reason, &username, &avatar) == nil {
			result = append(result, map[string]any{"id": id, "user_id": memberID, "club_id": clubID, "country": country, "status": status, "joined_at": joined, "apply_role": applyRole, "qq_account": qq, "contact_account": contact, "is_student": student, "join_method": joinMethod, "external_club_name": extName, "external_club_role": extRole, "apply_reason": reason, "username": username, "avatar_url": avatar})
		}
	}
	writeJSON(w, map[string]any{"success": true, "memberships": result})
}

func (s *Server) membershipCounts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	_, role := s.optionalSessionUser(r)
	if role != "super_admin" && !s.hasAnyManagementRole(r.Context(), userID) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	rows, err := s.db.QueryContext(r.Context(), "SELECT club_id, COALESCE(country, 'china'), COUNT(*) FROM club_memberships WHERE status = 'active' GROUP BY club_id, country")
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "查询失败"})
		return
	}
	defer rows.Close()
	counts := map[string]int64{}
	for rows.Next() {
		var clubID, count int64
		var country string
		if rows.Scan(&clubID, &country, &count) == nil {
			counts[intString(clubID)+":"+country] = count
		}
	}
	writeJSON(w, map[string]any{"success": true, "counts": counts})
}

func (s *Server) membershipReview(w http.ResponseWriter, r *http.Request, action string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	var input map[string]any
	_ = decodeJSON(r, &input, 64<<10)
	membershipID := mapPositiveInt(input, "membership_id")
	if membershipID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效的成员 ID"})
		return
	}
	var clubID, targetUser int64
	var country, status string
	if err := s.db.QueryRowContext(r.Context(), "SELECT club_id, user_id, COALESCE(country, 'china'), status FROM club_memberships WHERE id = ?", membershipID).Scan(&clubID, &targetUser, &country, &status); err != nil || status != "pending" {
		writeJSON(w, map[string]any{"success": false, "message": "未找到待审批的申请"})
		return
	}
	if !s.canManageMembership(r.Context(), userID, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	next := "active"
	if action == "reject" {
		next = "rejected"
	}
	result, err := s.db.ExecContext(r.Context(), "UPDATE club_memberships SET status = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ? WHERE id = ? AND status = 'pending'", next, userID, membershipID)
	if err != nil || mustRowsAffected(result) != 1 {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "操作失败"})
		return
	}
	_ = targetUser
	writeJSON(w, map[string]any{"success": true, "message": map[string]string{"active": "已批准绑定", "rejected": "已拒绝绑定"}[next]})
}

func (s *Server) membershipLeave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	var input map[string]any
	_ = decodeJSON(r, &input, 64<<10)
	id := mapPositiveInt(input, "membership_id")
	if id <= 0 {
		clubID := mapPositiveInt(input, "club_id")
		if clubID > 0 {
			_ = s.db.QueryRowContext(r.Context(), "SELECT id FROM club_memberships WHERE user_id = ? AND club_id = ? AND COALESCE(country, 'china') = ? AND status = 'active'", userID, clubID, normalizeCountry(mapString(input, "country"))).Scan(&id)
		}
	}
	if id <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效的成员 ID"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), "UPDATE club_memberships SET status = 'left', left_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status = 'active'", id, userID)
	if err != nil || mustRowsAffected(result) != 1 {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无法退出该同好会绑定"})
		return
	}
	clearDisplayMembership(s.db, r.Context(), id)
	writeJSON(w, map[string]any{"success": true, "message": "已退出同好会"})
}

func (s *Server) membershipKick(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	var input map[string]any
	_ = decodeJSON(r, &input, 64<<10)
	id := mapPositiveInt(input, "membership_id")
	var clubID, targetUser int64
	var country, role string
	if id <= 0 || s.db.QueryRowContext(r.Context(), "SELECT club_id, user_id, COALESCE(country, 'china'), role FROM club_memberships WHERE id = ? AND status = 'active'", id).Scan(&clubID, &targetUser, &country, &role) != nil {
		writeJSON(w, map[string]any{"success": false, "message": "未找到活跃的成员记录"})
		return
	}
	if targetUser == userID {
		writeJSON(w, map[string]any{"success": false, "message": "不能踢出自己"})
		return
	}
	if !s.canManageMembership(r.Context(), userID, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	_, myRole := s.clubManagementRole(r.Context(), userID, clubID, country)
	if myRole == "manager" && role != "member" && role != "external" {
		writeJSON(w, map[string]any{"success": false, "message": "管理员只能踢出普通成员"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), "UPDATE club_memberships SET status = 'kicked', left_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'", id)
	if err != nil || mustRowsAffected(result) != 1 {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "移出成员失败"})
		return
	}
	clearDisplayMembership(s.db, r.Context(), id)
	writeJSON(w, map[string]any{"success": true, "message": "已踢出成员"})
}

func (s *Server) membershipChangeRole(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	var input map[string]any
	_ = decodeJSON(r, &input, 64<<10)
	id, role := mapPositiveInt(input, "membership_id"), mapString(input, "role")
	if id <= 0 || (role != "member" && role != "manager" && role != "representative") {
		writeJSON(w, map[string]any{"success": false, "message": "无效的角色"})
		return
	}
	var clubID, targetUser int64
	var country, oldRole, status string
	if s.db.QueryRowContext(r.Context(), "SELECT club_id, user_id, COALESCE(country, 'china'), role, status FROM club_memberships WHERE id = ?", id).Scan(&clubID, &targetUser, &country, &oldRole, &status) != nil || status != "active" {
		writeJSON(w, map[string]any{"success": false, "message": "未找到活跃的成员记录"})
		return
	}
	_, myRole := s.clubManagementRole(r.Context(), userID, clubID, country)
	_, sessionRole := s.optionalSessionUser(r)
	if sessionRole != "super_admin" && (myRole != "representative" || role == "representative" || oldRole == "representative") {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "只有负责人可以修改成员角色"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE club_memberships SET role = ? WHERE id = ? AND status = 'active'", role, id); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "角色更新失败"})
		return
	}
	_ = targetUser
	writeJSON(w, map[string]any{"success": true, "message": "角色已更新"})
}

func (s *Server) membershipTransfer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	var input map[string]any
	_ = decodeJSON(r, &input, 64<<10)
	clubID, targetID := mapPositiveInt(input, "club_id"), mapPositiveInt(input, "membership_id")
	country := normalizeCountry(mapString(input, "country"))
	if clubID <= 0 || targetID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "参数不完整"})
		return
	}
	_, myRole := s.clubManagementRole(r.Context(), userID, clubID, country)
	if myRole != "representative" {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "只有负责人可以转让身份"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "操作失败"})
		return
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(r.Context(), "UPDATE club_memberships SET role = 'manager' WHERE user_id = ? AND club_id = ? AND COALESCE(country, 'china') = ? AND status = 'active'", userID, clubID, country); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "操作失败"})
		return
	}
	if _, err = tx.ExecContext(r.Context(), "UPDATE club_memberships SET role = 'representative' WHERE id = ? AND club_id = ? AND COALESCE(country, 'china') = ? AND status = 'active'", targetID, clubID, country); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "操作失败"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "操作失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "负责人已转让"})
}

func (s *Server) membershipEmailRecipient(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	var input map[string]any
	_ = decodeJSON(r, &input, 64<<10)
	id, enabled := mapPositiveInt(input, "membership_id"), mapBoolInt(input, "enabled", false)
	if id <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "邮件提醒设置无效"})
		return
	}
	var clubID int64
	var country, role string
	if s.db.QueryRowContext(r.Context(), "SELECT club_id, COALESCE(country, 'china'), role FROM club_memberships WHERE id = ? AND status = 'active'", id).Scan(&clubID, &country, &role) != nil || (role != "representative" && role != "manager") {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "未找到可配置邮件提醒的负责人或管理员"})
		return
	}
	_, sessionRole := s.optionalSessionUser(r)
	_, myRole := s.clubManagementRole(r.Context(), userID, clubID, country)
	if sessionRole != "super_admin" && myRole != "representative" {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "只有本同好会负责人可以配置申请邮件收件人"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE club_memberships SET application_email_enabled = ? WHERE id = ?", enabled, id); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "邮件提醒设置保存失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": map[bool]string{true: "已开启本会申请邮件提醒", false: "已关闭本会申请邮件提醒"}[enabled == 1], "membership_id": id, "enabled": enabled == 1})
}

// membershipGrantFromSubmission ports the administrator-only automatic bind
// performed after a club submission is approved. It keeps an already-active
// membership's role untouched and is idempotent for retries from the admin UI.
func (s *Server) membershipGrantFromSubmission(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	admin, ok := s.clubWriteUser(w, r, true)
	if !ok {
		return
	}
	if admin.Role != "super_admin" {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "仅超级管理员可执行此操作"})
		return
	}
	input := map[string]any{}
	if decodeJSON(r, &input, 128<<10) != nil {
		writeJSON(w, map[string]any{"success": false, "message": "请求数据格式错误"})
		return
	}
	targetUserID := int64Value(input["user_id"])
	clubID := int64Value(input["club_id"])
	country := normalizeCountry(mapString(input, "country"))
	role := firstNonEmpty(mapString(input, "role"), mapString(input, "apply_role"), "external")
	role = map[string]string{"other": "external", "external": "external", "member": "member", "manager": "manager", "representative": "representative"}[role]
	if role == "" {
		role = "external"
	}
	if targetUserID <= 0 || clubID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "缺少有效的用户 ID 或同好会 ID"})
		return
	}
	var active int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT id FROM users WHERE id=? AND status='active'", targetUserID).Scan(&active); err != nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "提交用户不存在或已停用"})
		return
	}
	contact := firstNonEmpty(mapString(input, "contact_account"), mapString(input, "qq_account"))
	var membershipID int64
	var existingStatus string
	err := s.db.QueryRowContext(r.Context(), "SELECT id,status FROM club_memberships WHERE user_id=? AND club_id=? AND COALESCE(country,'china')=? LIMIT 1", targetUserID, clubID, country).Scan(&membershipID, &existingStatus)
	hasExisting := err == nil
	if err != nil && err != sql.ErrNoRows {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取成员身份失败"})
		return
	}
	grantMode := "created"
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "自动绑定身份失败"})
		return
	}
	defer tx.Rollback()
	if hasExisting && existingStatus == "active" {
		grantMode = "already_active"
	} else if hasExisting {
		_, err = tx.ExecContext(r.Context(), `UPDATE club_memberships SET role=?,status='active',apply_role=?,join_method='club_submit',qq_account=?,contact_account=?,left_at=NULL,joined_at=CURRENT_TIMESTAMP,reviewed_at=NULL,reviewed_by=NULL WHERE id=?`, role, role, contact, contact, membershipID)
		grantMode = "reactivated"
		if err == nil {
			_, err = tx.ExecContext(r.Context(), "UPDATE users SET display_membership_id=NULL WHERE display_membership_id=?", membershipID)
		}
	} else {
		result, insertErr := tx.ExecContext(r.Context(), `INSERT INTO club_memberships(user_id,club_id,role,status,qq_account,contact_account,apply_role,is_student,country,join_method,external_club_name,external_club_role,apply_reason) VALUES(?,?,?,'active',?,?,?,0,?,'club_submit','','','同好会信息提交通过后自动绑定')`, targetUserID, clubID, role, contact, contact, role, country)
		err = insertErr
		if err == nil {
			membershipID, err = result.LastInsertId()
		}
	}
	if err != nil {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "自动绑定身份失败"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "自动绑定身份失败"})
		return
	}
	clubName := s.clubCodeClubName(r.Context(), clubID, country)
	roleLabel := map[string]string{"external": "其他", "member": "成员", "manager": "管理员", "representative": "负责人"}[role]
	if roleLabel == "" {
		roleLabel = role
	}
	s.membershipGrantNotification(r.Context(), targetUserID, membershipID, clubName, roleLabel)
	_ = active
	writeJSON(w, map[string]any{"success": true, "message": "已自动绑定同好会身份", "membership_id": membershipID, "grant_mode": grantMode})
}

func (s *Server) membershipGrantNotification(ctx context.Context, userID, membershipID int64, clubName, roleLabel string) {
	if exists, _ := s.db.TableExists(ctx, "notifications"); !exists {
		return
	}
	_, _ = s.db.ExecContext(ctx, `INSERT INTO notifications(user_id,type,title,message,link,related_type,related_id) VALUES(?,?,?,?,?,?,?)`, userID, "join_approved", "同好会信息已通过", "你在同好会「"+clubName+"」的信息提交已通过，已自动绑定为「"+roleLabel+"」", "index.html", "club_membership", membershipID)
}

func (s *Server) canManageMembership(ctx context.Context, userID, clubID int64, country string) bool {
	_, role := s.clubManagementRole(ctx, userID, clubID, country)
	return role == "super_admin" || role == "representative" || role == "manager"
}
func (s *Server) clubManagementRole(ctx context.Context, userID, clubID int64, country string) (int64, string) {
	if s.db == nil {
		return 0, ""
	}
	var role string
	if err := s.db.QueryRowContext(ctx, "SELECT role FROM users WHERE id = ? AND status = 'active'", userID).Scan(&role); err == nil && role == "super_admin" {
		return userID, role
	}
	_ = s.db.QueryRowContext(ctx, "SELECT role FROM club_memberships WHERE user_id = ? AND club_id = ? AND COALESCE(country, 'china') = ? AND status = 'active' AND role IN ('representative','manager') ORDER BY CASE role WHEN 'representative' THEN 2 ELSE 1 END DESC LIMIT 1", userID, clubID, country).Scan(&role)
	return userID, role
}
func (s *Server) hasAnyManagementRole(ctx context.Context, userID int64) bool {
	var exists int
	return s.db.QueryRowContext(ctx, "SELECT 1 FROM club_memberships WHERE user_id = ? AND status = 'active' AND role IN ('representative','manager') LIMIT 1", userID).Scan(&exists) == nil
}
func clearDisplayMembership(db *sqlstore.DB, ctx context.Context, id int64) {
	if db == nil {
		return
	}
	_, _ = db.ExecContext(ctx, "UPDATE users SET display_membership_id = NULL WHERE display_membership_id = ?", id)
}
func normalizeCountry(value string) string {
	if value == "japan" || value == "overseas" {
		return value
	}
	return "china"
}
func mapString(input map[string]any, key string) string {
	value, ok := input[key]
	if !ok || value == nil {
		return ""
	}
	return strings.TrimSpace(stringValue(value))
}
func mapPositiveInt(input map[string]any, key string) int64 { return int64Value(input[key]) }
func mapBoolInt(input map[string]any, key string, fallback bool) int {
	value, ok := input[key]
	if !ok {
		if fallback {
			return 1
		}
		return 0
	}
	switch item := value.(type) {
	case bool:
		if item {
			return 1
		}
		return 0
	case float64:
		if item != 0 {
			return 1
		}
		return 0
	case string:
		if strings.EqualFold(item, "true") || item == "1" {
			return 1
		}
		return 0
	}
	return 0
}
func queryInt(r *http.Request, key string) int64 {
	value := r.URL.Query().Get(key)
	return int64Value(value)
}
