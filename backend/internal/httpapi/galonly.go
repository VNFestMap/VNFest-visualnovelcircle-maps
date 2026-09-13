package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// GalOnly is kept as a single compatibility endpoint because the browser has
// always addressed the feature through /api/galonly.php. The implementation
// below intentionally uses the existing tables and status values; it does not
// introduce a second application model during the PHP-to-Go cutover.
func (s *Server) galonly(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	switch action {
	case "list_events":
		s.galonlyListEvents(w, r)
	case "list_participants":
		s.galonlyListParticipants(w, r)
	case "check_eligibility":
		s.galonlyEligibility(w, r)
	case "submit":
		s.galonlySubmit(w, r)
	case "get_application":
		s.galonlyGetApplication(w, r)
	case "update_application":
		s.galonlyUpdateApplication(w, r)
	case "delete_application":
		s.galonlyDeleteApplication(w, r)
	case "list_applications":
		s.galonlyListApplications(w, r)
	case "vote":
		s.galonlyReviewVote(w, r)
	case "withdraw_vote":
		s.galonlyWithdrawReviewVote(w, r)
	case "cast_public_vote":
		s.galonlyPublicVote(w, r)
	case "resolve", "resolve_product", "undo_resolve":
		s.galonlyResolve(w, r, action)
	case "list_reviewers", "save_reviewers":
		s.galonlyReviewers(w, r, action)
	case "add_event", "update_event", "delete_event":
		s.galonlyEventAdmin(w, r, action)
	case "upload_image", "upload_file":
		s.galonlyUpload(w, r, action)
	case "submit_merchandise", "get_merchandise", "get_merchandise_history":
		s.galonlyMerchandise(w, r, action)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知动作", "available_actions": []string{"list_events", "list_participants", "check_eligibility", "submit", "get_application", "update_application", "delete_application", "list_applications", "vote", "withdraw_vote", "cast_public_vote", "resolve", "upload_image", "upload_file"}})
	}
}

func (s *Server) galonlyListEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	events, err := s.queryMaps(r.Context(), "SELECT * FROM galonly_events ORDER BY date DESC,id DESC")
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取活动失败"})
		return
	}
	viewerID, _ := s.optionalSessionUser(r)
	for _, event := range events {
		eventID := integerValue(event["id"])
		var count int64
		_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM galonly_staff_applications WHERE event_id=? AND status IN ('pending','pooled')", eventID).Scan(&count)
		event["staff_current_applicants"] = count
		event["user_application_status"] = nil
		event["user_application_id"] = nil
		event["user_staff_application_status"] = nil
		event["user_staff_application_id"] = nil
		if viewerID != nil {
			var status string
			var id int64
			if s.db.QueryRowContext(r.Context(), "SELECT id,status FROM galonly_applications WHERE event_id=? AND user_id=? ORDER BY updated_at DESC,id DESC LIMIT 1", eventID, *viewerID).Scan(&id, &status) == nil {
				event["user_application_status"], event["user_application_id"] = status, id
			}
			if s.db.QueryRowContext(r.Context(), "SELECT id,status FROM galonly_staff_applications WHERE event_id=? AND user_id=? ORDER BY updated_at DESC,id DESC LIMIT 1", eventID, *viewerID).Scan(&id, &status) == nil {
				event["user_staff_application_status"], event["user_staff_application_id"] = status, id
			}
		}
	}
	writeJSON(w, map[string]any{"success": true, "events": events})
}

func (s *Server) galonlyListParticipants(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	eventID := parsePositiveInt(r.URL.Query().Get("event_id"))
	if eventID <= 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "缺少 event_id 参数"})
		return
	}
	events, err := s.queryMaps(r.Context(), "SELECT * FROM galonly_events WHERE id=?", eventID)
	if err != nil || len(events) == 0 {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "活动不存在"})
		return
	}
	applications, err := s.queryMaps(r.Context(), "SELECT * FROM galonly_applications WHERE event_id=? AND status IN ('approved','confirmed','shared') ORDER BY created_at ASC,id ASC", eventID)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取参展名单失败"})
		return
	}
	for _, app := range applications {
		s.galonlyNormalizeApplication(app)
		app["clubs"], _ = s.queryMaps(r.Context(), "SELECT club_id,club_country FROM galonly_application_clubs WHERE application_id=?", integerValue(app["id"]))
		var votes int64
		_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM galonly_public_votes WHERE application_id=?", integerValue(app["id"])).Scan(&votes)
		app["vote_count"] = votes
	}
	var totalVotes int64
	_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM galonly_public_votes WHERE event_id=?", eventID).Scan(&totalVotes)
	writeJSON(w, map[string]any{"success": true, "event": events[0], "participants": applications, "total": len(applications), "total_votes": totalVotes})
}

func (s *Server) galonlyEligibility(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	rows, err := s.db.QueryContext(r.Context(), "SELECT club_id,country FROM club_memberships WHERE user_id=? AND status='active'", user.ID)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取资格失败"})
		return
	}
	defer rows.Close()
	clubs := []map[string]any{}
	for rows.Next() {
		var id int64
		var country string
		if rows.Scan(&id, &country) == nil {
			clubs = append(clubs, map[string]any{"club_id": id, "country": country})
		}
	}
	if len(clubs) == 0 {
		writeJSON(w, map[string]any{"success": true, "eligible": false, "clubs": []any{}, "reason": "请先加入或创建一个同好会"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "eligible": true, "clubs": clubs, "reason": nil})
}

func (s *Server) galonlySubmit(w http.ResponseWriter, r *http.Request) {
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
	clubIDs := voteInt64Array(input["club_ids"])
	if eventID <= 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请选择活动"})
		return
	}
	if len(clubIDs) == 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请选择至少一个同好会"})
		return
	}
	var registrationOpen, staffOnly int64
	var eventCode string
	if err := s.db.QueryRowContext(r.Context(), "SELECT registration_open,staff_only,COALESCE(event_code,'') FROM galonly_events WHERE id=?", eventID).Scan(&registrationOpen, &staffOnly, &eventCode); err == sql.ErrNoRows {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "活动不存在"})
		return
	} else if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取活动失败"})
		return
	}
	if staffOnly == 1 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "该活动仅开放 Staff 申请"})
		return
	}
	if registrationOpen != 1 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "该活动暂未开放摊位申请"})
		return
	}
	boothType := strings.TrimSpace(stringValue(input["booth_type"]))
	if strings.EqualFold(eventCode, "beijing") && !containsString([]string{"sell_only", "activity_only", "both_sell", "both_activity"}, boothType) {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请选择摊位呈现形式"})
		return
	}
	contact := strings.TrimSpace(stringValue(input["contact"]))
	qqNumber, phoneNumber := strings.TrimSpace(stringValue(input["qq_number"])), strings.TrimSpace(stringValue(input["phone_number"]))
	if strings.EqualFold(eventCode, "beijing") {
		if qqNumber == "" || phoneNumber == "" {
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请填写 QQ 号与手机号"})
			return
		}
		contact = "QQ: " + qqNumber + " / 手机: " + phoneNumber
	} else if contact == "" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请输入联系方式"})
		return
	}
	for _, clubID := range clubIDs {
		var existing int64
		_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM galonly_application_clubs ac JOIN galonly_applications a ON a.id=ac.application_id WHERE a.event_id=? AND ac.club_id=? AND a.status IN ('pending','approved','phase2_pending','phase2_revision','phase2_additional_pending','confirmed','shared')", eventID, clubID).Scan(&existing)
		if existing > 0 {
			writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "同好会 ID " + strconv.FormatInt(clubID, 10) + " 已提交过申请"})
			return
		}
	}
	imagePaths := jsonListString(input["image_paths"])
	attachments := jsonListString(input["attachment_paths"])
	experience := jsonStringOrEmpty(input["exhibition_experience"])
	clubCountries, _ := input["club_countries"].([]any)
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "提交暂时不可用"})
		return
	}
	var eventNumber int64
	_ = tx.QueryRowContext(r.Context(), "SELECT COALESCE(MAX(event_number),0)+1 FROM galonly_applications WHERE event_id=?", eventID).Scan(&eventNumber)
	result, err := tx.ExecContext(r.Context(), `INSERT INTO galonly_applications(event_id,event_number,user_id,is_joint,joint_name,wants_upgrade,contact,qq_number,phone_number,exhibition_experience,notes,image_path,display_image,booth_name,booth_type,expected_members,layout_notes,needs_power,attachment_paths,merchandise_items,merchandise_attachments,status,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, eventID, eventNumber, user.ID, boolInt(boolValue(input["is_joint"])), stringValue(input["joint_name"]), boolInt(boolValue(input["wants_upgrade"])), contact, qqNumber, phoneNumber, experience, stringValue(input["notes"]), imagePaths, nullIfEmpty(stringValue(input["display_image"])), stringValue(input["booth_name"]), boothType, maxVoteInt64(integerValue(input["expected_members"]), 0), stringValue(input["layout_notes"]), firstNonEmpty(stringValue(input["needs_power"]), "unsure"), attachments, "[]", "[]")
	if err == nil {
		var appID int64
		appID, err = result.LastInsertId()
		for index, clubID := range clubIDs {
			country := ""
			if index < len(clubCountries) {
				country = stringValue(clubCountries[index])
			}
			if _, err = tx.ExecContext(r.Context(), "INSERT INTO galonly_application_clubs(application_id,club_id,club_country) VALUES(?,?,?)", appID, clubID, country); err != nil {
				break
			}
		}
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			_ = tx.Rollback()
		}
		if err == nil {
			writeJSON(w, map[string]any{"success": true, "application_id": appID, "event_number": eventNumber})
			return
		}
	} else {
		_ = tx.Rollback()
	}
	writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "提交失败"})
}

func nullIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func jsonListString(value any) string {
	if value == nil {
		return "[]"
	}
	if text, ok := value.(string); ok && strings.TrimSpace(text) == "" {
		return "[]"
	}
	encoded := jsonString(value)
	if encoded == "{}" {
		return "[]"
	}
	return encoded
}

func (s *Server) galonlyGetApplication(w http.ResponseWriter, r *http.Request) {
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
	var query string
	var args []any
	if applicationID > 0 {
		query, args = "SELECT * FROM galonly_applications WHERE id=? AND user_id=?", []any{applicationID, user.ID}
	} else if eventID > 0 {
		query, args = "SELECT * FROM galonly_applications WHERE event_id=? AND user_id=? ORDER BY updated_at DESC,id DESC LIMIT 1", []any{eventID, user.ID}
	} else {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "缺少 event_id 或 application_id 参数"})
		return
	}
	applications, err := s.queryMaps(r.Context(), query, args...)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取申请失败"})
		return
	}
	if len(applications) == 0 {
		writeJSON(w, map[string]any{"success": true, "application": nil})
		return
	}
	app := applications[0]
	s.galonlyNormalizeApplication(app)
	app["clubs"], _ = s.queryMaps(r.Context(), "SELECT club_id,club_country FROM galonly_application_clubs WHERE application_id=?", integerValue(app["id"]))
	app["votes"] = []any{}
	if reviewer, _ := s.galonlyCanReview(r.Context(), integerValue(app["event_id"]), user); reviewer {
		votes, _ := s.queryMaps(r.Context(), "SELECT vote,comment,phase,merchandise_version,created_at,auditer_id FROM galonly_votes WHERE application_id=? ORDER BY phase,id", integerValue(app["id"]))
		app["votes"] = votes
	}
	writeJSON(w, map[string]any{"success": true, "application": app})
}

func (s *Server) galonlyUpdateApplication(w http.ResponseWriter, r *http.Request) {
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
	if applicationID <= 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "缺少 application_id"})
		return
	}
	apps, err := s.queryMaps(r.Context(), "SELECT * FROM galonly_applications WHERE id=? AND user_id=?", applicationID, user.ID)
	if err != nil || len(apps) == 0 {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "申请不存在"})
		return
	}
	fields, args := []string{}, []any{}
	for _, field := range []string{"booth_name", "joint_name", "contact", "qq_number", "phone_number", "notes", "booth_type", "layout_notes", "needs_power", "display_image"} {
		if value, exists := input[field]; exists {
			fields = append(fields, field+"=?")
			if field == "display_image" {
				args = append(args, nullIfEmpty(stringValue(value)))
			} else {
				args = append(args, strings.TrimSpace(stringValue(value)))
			}
		}
	}
	for _, field := range []string{"is_joint", "wants_upgrade", "expected_members"} {
		if value, exists := input[field]; exists {
			fields = append(fields, field+"=?")
			args = append(args, maxVoteInt64(integerValue(value), 0))
		}
	}
	for _, field := range []string{"image_paths", "attachment_paths", "exhibition_experience", "merchandise_items", "merchandise_attachments"} {
		if value, exists := input[field]; exists {
			column := field
			if field == "image_paths" {
				column = "image_path"
			}
			fields = append(fields, column+"=?")
			if field == "exhibition_experience" {
				args = append(args, jsonStringOrEmpty(value))
			} else {
				args = append(args, jsonListString(value))
			}
		}
	}
	if len(fields) == 0 {
		writeJSON(w, map[string]any{"success": true, "message": "申请已更新"})
		return
	}
	fields = append(fields, "updated_at=CURRENT_TIMESTAMP")
	args = append(args, applicationID)
	if _, err := s.db.ExecContext(r.Context(), "UPDATE galonly_applications SET "+strings.Join(fields, ",")+" WHERE id=? AND user_id=?", append(args, user.ID)...); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "更新失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "申请已更新"})
}

func (s *Server) galonlyDeleteApplication(w http.ResponseWriter, r *http.Request) {
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
	if applicationID <= 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "缺少 application_id"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err == nil {
		_, err = tx.ExecContext(r.Context(), "DELETE FROM galonly_votes WHERE application_id=?", applicationID)
		if err == nil {
			_, err = tx.ExecContext(r.Context(), "DELETE FROM galonly_public_votes WHERE application_id=?", applicationID)
		}
		if err == nil {
			_, err = tx.ExecContext(r.Context(), "DELETE FROM galonly_application_clubs WHERE application_id=?", applicationID)
		}
		if err == nil {
			_, err = tx.ExecContext(r.Context(), "DELETE FROM galonly_applications WHERE id=? AND user_id=?", applicationID, user.ID)
		}
		if err == nil {
			err = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
	}
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "删除失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "申请已删除"})
}

func (s *Server) galonlyListApplications(w http.ResponseWriter, r *http.Request) {
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
	where, args := "1=1", []any{}
	if eventID > 0 {
		where += " AND a.event_id=?"
		args = append(args, eventID)
	}
	if status := strings.TrimSpace(r.URL.Query().Get("status")); status != "" && status != "all" {
		where += " AND a.status=?"
		args = append(args, status)
	}
	if phase := strings.TrimSpace(r.URL.Query().Get("phase")); phase != "" && phase != "all" {
		where += " AND a.phase=?"
		args = append(args, parsePositiveInt(phase))
	}
	applications, err := s.queryMaps(r.Context(), "SELECT a.*,u.nickname,u.username,u.avatar_url FROM galonly_applications a JOIN users u ON u.id=a.user_id WHERE "+where+" ORDER BY a.created_at DESC", args...)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取申请失败"})
		return
	}
	for _, app := range applications {
		s.galonlyNormalizeApplication(app)
		app["clubs"], _ = s.queryMaps(r.Context(), "SELECT club_id,club_country FROM galonly_application_clubs WHERE application_id=?", integerValue(app["id"]))
		app["votes"], _ = s.queryMaps(r.Context(), "SELECT vote,comment,phase,merchandise_version,created_at,auditer_id FROM galonly_votes WHERE application_id=? ORDER BY phase,id", integerValue(app["id"]))
	}
	writeJSON(w, map[string]any{"success": true, "applications": applications})
}

func (s *Server) galonlyReviewVote(w http.ResponseWriter, r *http.Request) {
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
	if applicationID <= 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "缺少 application_id"})
		return
	}
	if vote != "approve" && vote != "reject" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "投票值必须为 approve 或 reject"})
		return
	}
	apps, err := s.queryMaps(r.Context(), "SELECT a.id,a.event_id,a.status,a.phase,COALESCE(a.merchandise_version,0),COALESCE(e.event_code,'') FROM galonly_applications a LEFT JOIN galonly_events e ON e.id=a.event_id WHERE a.id=?", applicationID)
	if err != nil || len(apps) == 0 {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "申请不存在"})
		return
	}
	app := apps[0]
	if canReview, _ := s.galonlyCanReview(r.Context(), integerValue(app["event_id"]), user); !canReview {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	phase := integerValue(input["phase"])
	if phase == 0 {
		phase = 1
	}
	if phase != 1 && phase != 2 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "无效的审核阶段"})
		return
	}
	version := integerValue(app["merchandise_version"])
	var existing int64
	_ = s.db.QueryRowContext(r.Context(), "SELECT id FROM galonly_votes WHERE application_id=? AND auditer_id=? AND phase=? AND merchandise_version=?", applicationID, user.ID, phase, map[bool]int64{true: version, false: 0}[phase == 2]).Scan(&existing)
	if existing > 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "您已对该申请的本阶段投过票"})
		return
	}
	voteVersion := int64(0)
	if phase == 2 {
		voteVersion = version
	}
	if _, err := s.db.ExecContext(r.Context(), "INSERT INTO galonly_votes(application_id,auditer_id,vote,comment,phase,merchandise_version) VALUES(?,?,?,?,?,?)", applicationID, user.ID, vote, nullIfEmpty(stringValue(input["comment"])), phase, voteVersion); err != nil {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "意见提交失败"})
		return
	}
	counts := map[string]int64{"approve": 0, "reject": 0}
	rows, _ := s.db.QueryContext(r.Context(), "SELECT vote,COUNT(*) FROM galonly_votes WHERE application_id=? AND phase=? AND merchandise_version=? GROUP BY vote", applicationID, phase, voteVersion)
	if rows != nil {
		for rows.Next() {
			var name string
			var count int64
			if rows.Scan(&name, &count) == nil {
				counts[name] = count
			}
		}
		_ = rows.Close()
	}
	result := stringValue(app["status"])
	if !strings.EqualFold(stringValue(app["event_code"]), "beijing") && (counts["approve"] >= 4 || counts["reject"] >= 4) {
		result = "approved"
		if counts["reject"] >= 4 {
			result = "rejected"
		}
		_, _ = s.db.ExecContext(r.Context(), "UPDATE galonly_applications SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", result, applicationID)
		if result == "approved" {
			s.promoteGalonlyPublicImages(r.Context(), applicationID)
		}
	}
	writeJSON(w, map[string]any{"success": true, "result": result, "votes": counts, "message": "意见已记录"})
}

func (s *Server) galonlyWithdrawReviewVote(w http.ResponseWriter, r *http.Request) {
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
	phase := integerValue(input["phase"])
	query := "SELECT v.id,v.phase,a.event_id,COALESCE(e.event_code,'') FROM galonly_votes v JOIN galonly_applications a ON a.id=v.application_id LEFT JOIN galonly_events e ON e.id=a.event_id WHERE v.application_id=? AND v.auditer_id=?"
	args := []any{applicationID, user.ID}
	if phase == 1 || phase == 2 {
		query += " AND v.phase=?"
		args = append(args, phase)
	}
	query += " ORDER BY v.id DESC LIMIT 1"
	var voteID, votePhase, eventID int64
	var eventCode string
	if err := s.db.QueryRowContext(r.Context(), query, args...).Scan(&voteID, &votePhase, &eventID, &eventCode); err == sql.ErrNoRows {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "你尚未对该申请投过票"})
		return
	} else if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取投票失败"})
		return
	}
	if canReview, _ := s.galonlyCanReview(r.Context(), eventID, user); !canReview {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "DELETE FROM galonly_votes WHERE id=?", voteID); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "撤回投票失败"})
		return
	}
	if !strings.EqualFold(eventCode, "beijing") {
		var approved, rejected int64
		_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM galonly_votes WHERE application_id=? AND vote='approve'", applicationID).Scan(&approved)
		_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM galonly_votes WHERE application_id=? AND vote='reject'", applicationID).Scan(&rejected)
		status := "pending"
		if approved >= 4 {
			status = "approved"
		} else if rejected >= 4 {
			status = "rejected"
		}
		_, _ = s.db.ExecContext(r.Context(), "UPDATE galonly_applications SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", status, applicationID)
		writeJSON(w, map[string]any{"success": true, "result": status, "votes": map[string]int64{"approve": approved, "reject": rejected}})
		return
	}
	writeJSON(w, map[string]any{"success": true, "result": "withdrawn", "message": "意见已撤回", "phase": votePhase})
}

func (s *Server) galonlyPublicVote(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	input := voteReadJSON(r)
	eventID, applicationID := voteProjectID(input["event_id"]), voteProjectID(input["application_id"])
	if eventID <= 0 || applicationID <= 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "缺少参数"})
		return
	}
	var valid int64
	_ = s.db.QueryRowContext(r.Context(), "SELECT id FROM galonly_applications WHERE id=? AND event_id=? AND status IN ('approved','confirmed','shared')", applicationID, eventID).Scan(&valid)
	if valid == 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "无效的申请"})
		return
	}
	ip := clientIP(r)
	var existing int64
	_ = s.db.QueryRowContext(r.Context(), "SELECT id FROM galonly_public_votes WHERE event_id=? AND ip_address=? AND application_id=?", eventID, ip, applicationID).Scan(&existing)
	if existing > 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "您已赞过该摊位", "already_voted": true})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "INSERT INTO galonly_public_votes(event_id,application_id,ip_address) VALUES(?,?,?)", eventID, applicationID, ip); err != nil {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "投票失败"})
		return
	}
	var appVotes, totalVotes int64
	_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM galonly_public_votes WHERE application_id=?", applicationID).Scan(&appVotes)
	_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM galonly_public_votes WHERE event_id=?", eventID).Scan(&totalVotes)
	writeJSON(w, map[string]any{"success": true, "message": "投票成功", "vote_count": appVotes, "total_votes": totalVotes})
}

func (s *Server) galonlyResolve(w http.ResponseWriter, r *http.Request, action string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if action == "resolve_product" {
		s.galonlyResolveProduct(w, r)
		return
	}
	if action == "undo_resolve" {
		s.galonlyUndoResolve(w, r)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	input := voteReadJSON(r)
	applicationID := voteProjectID(input["application_id"])
	apps, err := s.queryMaps(r.Context(), "SELECT id,event_id,status,phase FROM galonly_applications WHERE id=?", applicationID)
	if err != nil || len(apps) == 0 {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "申请不存在"})
		return
	}
	app := apps[0]
	if canReview, _ := s.galonlyCanReview(r.Context(), integerValue(app["event_id"]), user); !canReview {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	if action == "undo_resolve" {
		if _, err := s.db.ExecContext(r.Context(), "UPDATE galonly_applications SET status='pending',updated_at=CURRENT_TIMESTAMP WHERE id=?", applicationID); err != nil {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "撤销审核失败"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "status": "pending"})
		return
	}
	decision := strings.TrimSpace(stringValue(input["decision"]))
	if decision == "" {
		decision = strings.TrimSpace(stringValue(input["status"]))
	}
	if decision != "approve" && decision != "reject" && decision != "revision" && decision != "shared" && decision != "confirmed" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "decision 必须为 approve 或 reject"})
		return
	}
	status := decision
	if decision == "approve" {
		status = "approved"
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE galonly_applications SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", status, applicationID); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "审核决定保存失败"})
		return
	}
	if status == "approved" || status == "confirmed" || status == "shared" {
		s.promoteGalonlyPublicImages(r.Context(), applicationID)
	}
	writeJSON(w, map[string]any{"success": true, "status": status, "message": "审核决定已保存"})
}

// galonlyResolveProduct preserves the Beijing two-phase merchandise review
// contract. It is deliberately separate from the legacy phase-one resolver:
// phase two has version checks, additional-review states, and a chief-reviewer
// gate that must not be accidentally widened by the generic path.
func (s *Server) galonlyResolveProduct(w http.ResponseWriter, r *http.Request) {
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	input := voteReadJSON(r)
	applicationID := voteProjectID(input["application_id"])
	decision := strings.TrimSpace(stringValue(input["decision"]))
	feedback := strings.TrimSpace(stringValue(input["feedback"]))
	if applicationID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "缺少 application_id"})
		return
	}
	validDecisions := map[string]bool{"approved": true, "revision": true, "rejected": true, "shared": true, "keep_approved": true, "withdraw_approval": true}
	if !validDecisions[decision] {
		writeJSON(w, map[string]any{"success": false, "message": "decision 必须为 approved / revision / rejected / shared / keep_approved / withdraw_approval"})
		return
	}
	apps, err := s.queryMaps(r.Context(), `SELECT ga.*,COALESCE(ge.event_code,'') AS event_code
		FROM galonly_applications ga LEFT JOIN galonly_events ge ON ge.id=ga.event_id WHERE ga.id=?`, applicationID)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取申请失败"})
		return
	}
	if len(apps) == 0 {
		writeJSON(w, map[string]any{"success": false, "message": "申请不存在"})
		return
	}
	app := apps[0]
	if !strings.EqualFold(stringValue(app["event_code"]), "beijing") {
		writeJSON(w, map[string]any{"success": false, "message": "该活动无制品审核阶段"})
		return
	}
	if _, role := s.galonlyCanReview(r.Context(), integerValue(app["event_id"]), user); role != "chief" {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "仅总审/专人可做出最终决定"})
		return
	}
	currentVersion := integerValue(app["merchandise_version"])
	if raw, exists := input["merchandise_version"]; exists && strings.TrimSpace(fmt.Sprint(raw)) != "" && integerValue(raw) != currentVersion {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "材料已更新，请刷新后重新审核", "current_version": currentVersion})
		return
	}
	status := stringValue(app["status"])
	if status != "phase2_pending" && status != "phase2_revision" && status != "phase2_additional_pending" {
		writeJSON(w, map[string]any{"success": false, "message": "该申请不在阶段二审核状态"})
		return
	}
	if status == "phase2_additional_pending" && decision != "keep_approved" && decision != "withdraw_approval" {
		writeJSON(w, map[string]any{"success": false, "message": "追加检查只能确认保留已通过或撤回已通过"})
		return
	}
	if status != "phase2_additional_pending" && (decision == "keep_approved" || decision == "withdraw_approval") {
		writeJSON(w, map[string]any{"success": false, "message": "该申请不在追加检查状态"})
		return
	}
	hasRevisionTable, _ := s.db.TableExists(r.Context(), "galonly_merchandise_revisions")

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "阶段二审核保存失败"})
		return
	}
	defer tx.Rollback()
	feedbackValue := any(nil)
	if feedback != "" {
		feedbackValue = feedback
	}
	set := "status=?,phase=2,phase2_feedback=?,revision_at=NULL,updated_at=CURRENT_TIMESTAMP"
	args := []any{}
	switch decision {
	case "approved":
		set = "status='confirmed',phase=2,phase2_feedback=?,revision_at=NULL,updated_at=CURRENT_TIMESTAMP"
		args = []any{feedbackValue, applicationID}
	case "revision":
		set = "status='phase2_revision',phase=2,phase2_feedback=?,revision_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP"
		args = []any{feedbackValue, applicationID}
	case "rejected":
		set = "status='rejected',phase=2,phase2_feedback=?,rejected_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP"
		args = []any{feedbackValue, applicationID}
	case "shared":
		set = "status='shared',phase=2,phase2_feedback=?,revision_at=NULL,updated_at=CURRENT_TIMESTAMP"
		args = []any{feedbackValue, applicationID}
	case "keep_approved":
		restoreStatus := "confirmed"
		if previous := stringValue(app["phase2_approved_status"]); previous == "confirmed" || previous == "shared" {
			restoreStatus = previous
		}
		set = "status=?,phase=2,phase2_approved_status=NULL,phase2_feedback=?,revision_at=NULL,updated_at=CURRENT_TIMESTAMP"
		args = []any{restoreStatus, feedbackValue, applicationID}
	case "withdraw_approval":
		set = "status='phase2_pending',phase=2,phase2_approved_status=NULL,phase2_feedback=?,revision_at=NULL,updated_at=CURRENT_TIMESTAMP"
		args = []any{feedbackValue, applicationID}
	}
	if _, err := tx.ExecContext(r.Context(), "UPDATE galonly_applications SET "+set+" WHERE id=?", args...); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "阶段二审核保存失败"})
		return
	}
	reviewStatus := decision
	if decision == "keep_approved" {
		reviewStatus = stringValue(app["phase2_approved_status"])
		if reviewStatus == "" {
			reviewStatus = "confirmed"
		}
	} else if decision == "withdraw_approval" {
		reviewStatus = "phase2_pending"
	}
	if hasRevisionTable {
		_, _ = tx.ExecContext(r.Context(), `UPDATE galonly_merchandise_revisions SET review_status=?,reviewed_at=CURRENT_TIMESTAMP,reviewed_by=?,review_feedback=? WHERE application_id=? AND material_version=?`, reviewStatus, user.ID, feedbackValue, applicationID, currentVersion)
	}
	if err := tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "阶段二审核保存失败"})
		return
	}
	s.galonlyReviewNotification(r.Context(), integerValue(app["user_id"]), applicationID, decision, feedback)
	if decision == "approved" || decision == "shared" || decision == "keep_approved" {
		s.promoteGalonlyPublicImages(r.Context(), applicationID)
	}
	writeJSON(w, map[string]any{"success": true, "message": "阶段二审核结果已确定并反馈给摊主"})
}

func (s *Server) galonlyUndoResolve(w http.ResponseWriter, r *http.Request) {
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	input := voteReadJSON(r)
	applicationID := voteProjectID(input["application_id"])
	phase := int(integerValue(input["phase"]))
	if applicationID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "缺少 application_id"})
		return
	}
	if phase != 1 && phase != 2 {
		writeJSON(w, map[string]any{"success": false, "message": "无效的审核阶段"})
		return
	}
	apps, err := s.queryMaps(r.Context(), `SELECT ga.*,COALESCE(ge.event_code,'') AS event_code
		FROM galonly_applications ga LEFT JOIN galonly_events ge ON ge.id=ga.event_id WHERE ga.id=?`, applicationID)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取申请失败"})
		return
	}
	if len(apps) == 0 {
		writeJSON(w, map[string]any{"success": false, "message": "申请不存在"})
		return
	}
	app := apps[0]
	if !strings.EqualFold(stringValue(app["event_code"]), "beijing") {
		writeJSON(w, map[string]any{"success": false, "message": "该活动无两阶段审核流程"})
		return
	}
	if _, role := s.galonlyCanReview(r.Context(), integerValue(app["event_id"]), user); role != "chief" {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "仅总审/专人可撤回最终决定"})
		return
	}
	status := stringValue(app["status"])
	if phase == 1 {
		if status != "approved" || integerValue(app["phase"]) != 1 {
			writeJSON(w, map[string]any{"success": false, "message": "该申请不在阶段一已通过状态，无法撤回"})
			return
		}
		if _, err := s.db.ExecContext(r.Context(), "UPDATE galonly_applications SET status='pending',phase=1,phase1_feedback=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?", applicationID); err != nil {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "撤回审核失败"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "已撤回阶段一通过，申请回到待审核"})
		return
	}
	if (status != "confirmed" && status != "shared") || integerValue(app["phase"]) != 2 {
		writeJSON(w, map[string]any{"success": false, "message": "该申请不在阶段二已通过状态，无法撤回"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE galonly_applications SET status='phase2_pending',phase=2,phase2_feedback=NULL,revision_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?", applicationID); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "撤回审核失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "已撤回阶段二通过，申请回到制品审核中"})
}

func (s *Server) galonlyReviewNotification(ctx context.Context, userID, applicationID int64, decision, feedback string) {
	if userID <= 0 || s.db == nil {
		return
	}
	if exists, _ := s.db.TableExists(ctx, "notifications"); !exists {
		return
	}
	title := "摊位申请审核结果"
	message := "阶段二审核结果：" + decision
	if feedback != "" {
		message += "；反馈：" + feedback
	}
	_, _ = s.db.ExecContext(ctx, `INSERT INTO notifications(user_id,type,title,message,link,related_type,related_id) VALUES(?,?,?,?,?,?,?)`, userID, "galonly_review", title, message, "", "galonly_application", applicationID)
}

func (s *Server) galonlyReviewers(w http.ResponseWriter, r *http.Request, action string) {
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	if user.Role != "super_admin" && user.IsAudit == 0 {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	if action == "list_reviewers" {
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		eventID := parsePositiveInt(r.URL.Query().Get("event_id"))
		rows, err := s.queryMaps(r.Context(), "SELECT r.*,u.username,u.nickname FROM galonly_reviewers r LEFT JOIN users u ON u.id=r.user_id WHERE r.event_id IN (0,?) ORDER BY r.event_id,r.role,r.id", eventID)
		if err != nil {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取审核人失败"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "reviewers": rows})
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	input := voteReadJSON(r)
	eventID := voteProjectID(input["event_id"])
	values, _ := input["reviewers"].([]any)
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err == nil {
		_, err = tx.ExecContext(r.Context(), "DELETE FROM galonly_reviewers WHERE event_id=?", eventID)
		for _, value := range values {
			row, _ := value.(map[string]any)
			uid := voteProjectID(row["user_id"])
			role := firstNonEmpty(stringValue(row["role"]), "jury")
			if uid <= 0 || (role != "chief" && role != "jury") {
				continue
			}
			if _, err = tx.ExecContext(r.Context(), "INSERT INTO galonly_reviewers(event_id,user_id,role) VALUES(?,?,?)", eventID, uid, role); err != nil {
				break
			}
		}
		if err == nil {
			err = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
	}
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "保存审核人失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "审核人已保存"})
}

func (s *Server) galonlyEventAdmin(w http.ResponseWriter, r *http.Request, action string) {
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	if user.Role != "super_admin" {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	input := voteReadJSON(r)
	if action == "delete_event" {
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		eventID := voteProjectID(input["event_id"], input["id"])
		if _, err := s.db.ExecContext(r.Context(), "DELETE FROM galonly_events WHERE id=?", eventID); err != nil {
			writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "删除活动失败"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "活动已删除"})
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if action == "add_event" {
		name := strings.TrimSpace(stringValue(input["name"]))
		date := firstNonEmpty(stringValue(input["date"]), time.Now().Format("2006-01-02"))
		if name == "" {
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请填写活动名称"})
			return
		}
		result, err := s.db.ExecContext(r.Context(), "INSERT INTO galonly_events(name,location,date,registration_open,staff_only,event_code,description) VALUES(?,?,?,?,?,?,?)", name, stringValue(input["location"]), date, boolInt(boolValue(input["registration_open"])), boolInt(boolValue(input["staff_only"])), stringValue(input["event_code"]), stringValue(input["description"]))
		if err != nil {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "创建活动失败"})
			return
		}
		id, _ := result.LastInsertId()
		writeJSON(w, map[string]any{"success": true, "event_id": id})
		return
	}
	eventID := voteProjectID(input["event_id"], input["id"])
	fields := []string{}
	args := []any{}
	for _, field := range []string{"name", "location", "date", "event_code", "description"} {
		if value, exists := input[field]; exists {
			fields = append(fields, field+"=?")
			args = append(args, stringValue(value))
		}
	}
	for _, field := range []string{"registration_open", "staff_only", "staff_required_count", "staff_roster_finalized"} {
		if value, exists := input[field]; exists {
			fields = append(fields, field+"=?")
			args = append(args, integerValue(value))
		}
	}
	if len(fields) == 0 {
		writeJSON(w, map[string]any{"success": true})
		return
	}
	args = append(args, eventID)
	if _, err := s.db.ExecContext(r.Context(), "UPDATE galonly_events SET "+strings.Join(fields, ",")+" WHERE id=?", args...); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "更新活动失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "活动已更新"})
}

func (s *Server) galonlyUpload(w http.ResponseWriter, r *http.Request, action string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if _, ok := s.clubCodeUserResponse(w, r); !ok {
		return
	}
	limit := int64(10 << 20)
	if action == "upload_image" {
		limit = 10 << 20
	}
	if err := r.ParseMultipartForm(limit + 1<<20); err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "文件上传失败"})
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "文件上传失败"})
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "文件不能超过 10MB"})
		return
	}
	contentType := http.DetectContentType(data)
	ext := map[string]string{"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp"}[contentType]
	if action == "upload_image" && ext == "" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "仅支持 JPEG、PNG、GIF、WebP 格式"})
		return
	}
	if ext == "" {
		ext = filepath.Ext(header.Filename)
		ext = strings.TrimPrefix(strings.ToLower(ext), ".")
		if ext == "" || len(ext) > 8 {
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "不支持的文件类型"})
			return
		}
	}
	eventID := firstNonEmpty(r.FormValue("event_id"), "0")
	name := "galonly_" + safeUploadID(eventID) + "_" + time.Now().Format("20060102150405") + "_" + randomHex(5) + "." + ext
	relative := filepath.ToSlash(filepath.Join("galonly", safeUploadID(eventID), name))
	if err := s.files.SaveUpload(r.Context(), relative, bytes.NewReader(data)); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "文件保存失败"})
		return
	}
	publicPath := "uploads/galonly/" + safeUploadID(eventID) + "/" + name
	writeJSON(w, map[string]any{"success": true, "path": publicPath, "name": header.Filename})
}

func (s *Server) galonlyMerchandise(w http.ResponseWriter, r *http.Request, action string) {
	input := map[string]any{}
	if r.Method == http.MethodPost {
		input = voteReadJSON(r)
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	applicationID := voteProjectID(input["application_id"], r.URL.Query().Get("application_id"))
	apps, err := s.queryMaps(r.Context(), "SELECT * FROM galonly_applications WHERE id=? AND user_id=?", applicationID, user.ID)
	if err != nil || len(apps) == 0 {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "申请不存在"})
		return
	}
	app := apps[0]
	s.galonlyNormalizeApplication(app)
	if action == "get_merchandise" || action == "get_merchandise_history" {
		writeJSON(w, map[string]any{"success": true, "application_id": applicationID, "version": integerValue(app["merchandise_version"]), "merchandise_items": app["merchandise_items"], "merchandise_attachments": app["merchandise_attachments"]})
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	items, _ := input["merchandise_items"]
	attachments, _ := input["merchandise_attachments"]
	version := integerValue(app["merchandise_version"]) + 1
	if _, err := s.db.ExecContext(r.Context(), "UPDATE galonly_applications SET merchandise_items=?,merchandise_attachments=?,merchandise_version=?,merchandise_updated_at=CURRENT_TIMESTAMP,status=CASE WHEN status IN ('approved','phase2_revision','phase2_additional_pending') THEN 'phase2_pending' ELSE status END,phase=2,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?", jsonStringOrEmpty(items), jsonStringOrEmpty(attachments), version, applicationID, user.ID); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "制品材料保存失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "version": version, "message": "制品材料已提交"})
}

func (s *Server) galonlyNormalizeApplication(app map[string]any) {
	for _, key := range []string{"image_path", "attachment_paths", "merchandise_items", "merchandise_attachments", "exhibition_experience"} {
		if value, ok := app[key]; ok {
			appKey := key
			if key == "image_path" {
				appKey = "image_paths"
			}
			app[appKey] = decodeJSONList(value)
		}
	}
	if _, ok := app["image_paths"]; !ok {
		app["image_paths"] = []any{}
	}
	if _, ok := app["attachment_paths"]; !ok {
		app["attachment_paths"] = []any{}
	}
	if _, ok := app["merchandise_items"]; !ok {
		app["merchandise_items"] = []any{}
	}
	if _, ok := app["merchandise_attachments"]; !ok {
		app["merchandise_attachments"] = []any{}
	}
	if value, ok := app["display_image"]; !ok || value == nil {
		app["display_image"] = nil
	}
}

func decodeJSONList(value any) any {
	if value == nil {
		return []any{}
	}
	if list, ok := value.([]any); ok {
		return list
	}
	text := stringValue(value)
	if text == "" {
		return []any{}
	}
	var decoded any
	if json.Unmarshal([]byte(text), &decoded) == nil {
		if _, ok := decoded.([]any); ok {
			return decoded
		}
		if decodedMap, ok := decoded.(map[string]any); ok && len(decodedMap) == 0 {
			return []any{}
		}
		return decoded
	}
	return []any{text}
}

func (s *Server) galonlyCanReview(ctx context.Context, eventID int64, user *user) (bool, string) {
	if user == nil {
		return false, ""
	}
	if user.Role == "super_admin" || user.IsAudit != 0 {
		return true, "chief"
	}
	var role string
	if err := s.db.QueryRowContext(ctx, "SELECT role FROM galonly_reviewers WHERE user_id=? AND event_id IN (0,?) ORDER BY event_id DESC LIMIT 1", user.ID, eventID).Scan(&role); err != nil {
		return false, ""
	}
	return role != "", role
}

func (s *Server) queryMaps(ctx context.Context, query string, args ...any) ([]map[string]any, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	result := []map[string]any{}
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for index := range values {
			pointers[index] = &values[index]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, err
		}
		row := map[string]any{}
		for index, column := range columns {
			switch value := values[index].(type) {
			case []byte:
				row[column] = string(value)
			default:
				row[column] = value
			}
		}
		result = append(result, row)
	}
	return result, rows.Err()
}
