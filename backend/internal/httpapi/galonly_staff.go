package httpapi

import (
	"database/sql"
	"net/http"
	"strings"
)

func (s *Server) galonlyStaff(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	switch action {
	case "get_my", "get_staff_application":
		s.galonlyStaffMine(w, r)
	case "submit_staff", "submit":
		s.galonlyStaffSubmit(w, r)
	case "list_staff_applications", "list_applications":
		s.galonlyStaffList(w, r)
	case "vote_staff", "vote":
		s.galonlyStaffVote(w, r)
	case "withdraw_staff_vote", "withdraw_vote":
		s.galonlyStaffWithdrawVote(w, r)
	case "update_staff":
		s.galonlyStaffUpdate(w, r)
	case "delete_staff_application":
		s.galonlyStaffDelete(w, r)
	case "update_status":
		s.galonlyStaffStatus(w, r)
	case "finalize_staff_roster", "unlock_staff_roster", "update_staff_event_config":
		s.galonlyStaffEventConfig(w, r, action)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知动作", "available_actions": []string{"get_my", "submit_staff", "list_staff_applications", "vote_staff", "withdraw_staff_vote", "update_status"}})
	}
}

func (s *Server) galonlyStaffMine(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	applicationID := parsePositiveInt(r.URL.Query().Get("application_id"))
	eventID := parsePositiveInt(r.URL.Query().Get("event_id"))
	query := "SELECT * FROM galonly_staff_applications WHERE user_id=?"
	args := []any{user.ID}
	if applicationID > 0 {
		query += " AND id=?"
		args = append(args, applicationID)
	} else if eventID > 0 {
		query += " AND event_id=?"
		args = append(args, eventID)
	}
	query += " ORDER BY updated_at DESC,id DESC LIMIT 1"
	rows, err := s.queryMaps(r.Context(), query, args...)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取 Staff 申请失败"})
		return
	}
	if len(rows) == 0 {
		writeJSON(w, map[string]any{"success": true, "application": nil})
		return
	}
	app := rows[0]
	app["positions"] = decodeJSONList(app["positions"])
	writeJSON(w, map[string]any{"success": true, "application": app})
}

func (s *Server) galonlyStaffSubmit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	input := voteReadJSON(r)
	eventID := voteProjectID(input["event_id"])
	if eventID <= 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请选择活动"})
		return
	}
	var open, staffOnly int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT staff_registration_open,staff_only FROM galonly_events WHERE id=?", eventID).Scan(&open, &staffOnly); err == sql.ErrNoRows {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "活动不存在"})
		return
	} else if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取活动失败"})
		return
	}
	if open != 1 && staffOnly == 1 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "Staff 报名尚未开放"})
		return
	}
	positions := jsonStringOrEmpty(input["positions"])
	result, err := s.db.ExecContext(r.Context(), `INSERT INTO galonly_staff_applications(event_id,user_id,cn_name,qq_number,phone_number,email,club_id,club_country,positions,confirm_schedule,is_cosplay,three_day_available,self_intro,gender,staff_experience,skills,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`, eventID, user.ID, stringValue(input["cn_name"]), stringValue(input["qq_number"]), stringValue(input["phone_number"]), stringValue(input["email"]), voteProjectID(input["club_id"]), firstNonEmpty(stringValue(input["club_country"]), "china"), positions, boolInt(boolValue(input["confirm_schedule"])), boolInt(boolValue(input["is_cosplay"])), boolInt(boolValue(input["three_day_available"])), stringValue(input["self_intro"]), stringValue(input["gender"]), boolInt(boolValue(input["staff_experience"])), jsonStringOrEmpty(input["skills"]))
	if err != nil {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "提交 Staff 申请失败"})
		return
	}
	id, _ := result.LastInsertId()
	writeJSON(w, map[string]any{"success": true, "application_id": id, "message": "Staff 申请已提交"})
}

func (s *Server) galonlyStaffList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	eventID := parsePositiveInt(r.URL.Query().Get("event_id"))
	if canReview, _ := s.galonlyCanReview(r.Context(), eventID, user); !canReview {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	query, args := "SELECT * FROM galonly_staff_applications", []any{}
	if eventID > 0 {
		query += " WHERE event_id=?"
		args = append(args, eventID)
	}
	query += " ORDER BY created_at DESC,id DESC"
	rows, err := s.queryMaps(r.Context(), query, args...)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取 Staff 申请失败"})
		return
	}
	for _, row := range rows {
		row["positions"] = decodeJSONList(row["positions"])
	}
	writeJSON(w, map[string]any{"success": true, "applications": rows})
}

func (s *Server) galonlyStaffVote(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	input := voteReadJSON(r)
	applicationID := voteProjectID(input["application_id"])
	vote := strings.TrimSpace(stringValue(input["vote"]))
	if vote != "approve" && vote != "reject" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "投票值必须为 approve 或 reject"})
		return
	}
	var eventID int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT event_id FROM galonly_staff_applications WHERE id=?", applicationID).Scan(&eventID); err == sql.ErrNoRows {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "申请不存在"})
		return
	}
	if canReview, _ := s.galonlyCanReview(r.Context(), eventID, user); !canReview {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE galonly_staff_applications SET vote=?,voted_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", vote, user.ID, applicationID); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "投票失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "vote": vote})
}

func (s *Server) galonlyStaffWithdrawVote(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	input := voteReadJSON(r)
	applicationID := voteProjectID(input["application_id"])
	var eventID int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT event_id FROM galonly_staff_applications WHERE id=?", applicationID).Scan(&eventID); err != nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "申请不存在"})
		return
	}
	if canReview, _ := s.galonlyCanReview(r.Context(), eventID, user); !canReview {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	_, err := s.db.ExecContext(r.Context(), "UPDATE galonly_staff_applications SET vote=NULL,voted_by=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?", applicationID)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "撤回投票失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "投票已撤回"})
}

func (s *Server) galonlyStaffUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	input := voteReadJSON(r)
	applicationID := voteProjectID(input["application_id"])
	fields, args := []string{}, []any{}
	for _, field := range []string{"cn_name", "qq_number", "phone_number", "email", "club_country", "self_intro", "gender", "skills"} {
		if value, exists := input[field]; exists {
			fields = append(fields, field+"=?")
			args = append(args, stringValue(value))
		}
	}
	if value, exists := input["positions"]; exists {
		fields = append(fields, "positions=?")
		args = append(args, jsonStringOrEmpty(value))
	}
	if len(fields) == 0 {
		writeJSON(w, map[string]any{"success": true})
		return
	}
	fields = append(fields, "updated_at=CURRENT_TIMESTAMP")
	args = append(args, applicationID, user.ID)
	if _, err := s.db.ExecContext(r.Context(), "UPDATE galonly_staff_applications SET "+strings.Join(fields, ",")+" WHERE id=? AND user_id=?", args...); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "更新 Staff 申请失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "Staff 申请已更新"})
}

func (s *Server) galonlyStaffDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	input := voteReadJSON(r)
	if _, err := s.db.ExecContext(r.Context(), "DELETE FROM galonly_staff_applications WHERE id=? AND user_id=?", voteProjectID(input["application_id"]), user.ID); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "删除 Staff 申请失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "Staff 申请已删除"})
}

func (s *Server) galonlyStaffStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	input := voteReadJSON(r)
	applicationID := voteProjectID(input["application_id"])
	status := strings.TrimSpace(stringValue(input["status"]))
	if !containsString([]string{"pending", "pooled", "rejected", "confirmed"}, status) {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "无效状态"})
		return
	}
	var eventID int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT event_id FROM galonly_staff_applications WHERE id=?", applicationID).Scan(&eventID); err != nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "申请不存在"})
		return
	}
	if canReview, _ := s.galonlyCanReview(r.Context(), eventID, user); !canReview {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE galonly_staff_applications SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", status, applicationID); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "保存状态失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "status": status})
}

func (s *Server) galonlyStaffEventConfig(w http.ResponseWriter, r *http.Request, action string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	input := voteReadJSON(r)
	eventID := voteProjectID(input["event_id"])
	if user.Role != "super_admin" && user.IsAudit == 0 {
		if canReview, _ := s.galonlyCanReview(r.Context(), eventID, user); !canReview {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
			return
		}
	}
	if action == "finalize_staff_roster" || action == "unlock_staff_roster" {
		value := int64(1)
		if action == "unlock_staff_roster" {
			value = 0
		}
		_, err := s.db.ExecContext(r.Context(), "UPDATE galonly_events SET staff_roster_finalized=? WHERE id=?", value, eventID)
		if err != nil {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "保存名单状态失败"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "staff_roster_finalized": value})
		return
	}
	fields, args := []string{}, []any{}
	for _, field := range []string{"staff_deadline", "staff_max_applicants", "staff_required_count", "staff_registration_open"} {
		if value, exists := input[field]; exists {
			fields = append(fields, field+"=?")
			if field == "staff_deadline" {
				args = append(args, nullIfEmpty(stringValue(value)))
			} else {
				args = append(args, integerValue(value))
			}
		}
	}
	if len(fields) == 0 {
		writeJSON(w, map[string]any{"success": true})
		return
	}
	args = append(args, eventID)
	if _, err := s.db.ExecContext(r.Context(), "UPDATE galonly_events SET "+strings.Join(fields, ",")+" WHERE id=?", args...); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "保存活动配置失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true})
}
