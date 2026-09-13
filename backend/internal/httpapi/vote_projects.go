package httpapi

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

func (s *Server) voteProjects(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	switch action {
	case "list":
		s.voteProjectList(w, r)
	case "my_manageable":
		s.voteProjectManageable(w, r)
	case "get":
		s.voteProjectGet(w, r)
	case "create":
		s.voteProjectCreate(w, r)
	case "update":
		s.voteProjectUpdate(w, r)
	case "share":
		s.voteProjectShare(w, r)
	case "publish", "suspend", "archive", "delete":
		s.voteProjectLifecycle(w, r, action)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知 action=" + action})
	}
}

func (s *Server) voteProjectList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	where := []string{"visibility='public'", "status<>'draft'"}
	args := []any{}
	if projectType := voteNormalize(firstNonEmpty(stringValue(r.URL.Query().Get("project_type")), votePathProjectType(r.URL.Path)), voteProjectTypes, ""); projectType != "" {
		where = append(where, "project_type=?")
		args = append(args, projectType)
	}
	if country := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("country"))); country != "" && country != "all" {
		where = append(where, "country=?")
		args = append(args, voteProjectCountry(country))
	}
	if clubID := parsePositiveInt(r.URL.Query().Get("club_id")); clubID > 0 {
		where = append(where, "club_id=?")
		args = append(args, clubID)
	}
	if status := stringValue(r.URL.Query().Get("status")); containsString(voteProjectStatuses, status) {
		where = append(where, "status=?")
		args = append(args, status)
	}
	page := parsePositiveInt(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	offset := (page - 1) * 100
	rows, err := s.db.QueryContext(r.Context(), "SELECT id,project_type,club_id,country,title,COALESCE(year_label,''),COALESCE(description,''),COALESCE(cover_url,''),status,visibility,eligibility_mode,result_visibility,COALESCE(config_json,'{}'),COALESCE(share_token,''),guest_vote,created_by,created_at,updated_at,COALESCE(published_at,''),COALESCE(ended_at,'') FROM vote_projects WHERE "+strings.Join(where, " AND ")+" ORDER BY updated_at DESC,id DESC LIMIT 100 OFFSET "+strconv.FormatInt(offset, 10), args...)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取企划失败"})
		return
	}
	projects, err := s.scanVoteProjects(rows)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取企划失败"})
		return
	}
	var total int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM vote_projects WHERE "+strings.Join(where, " AND "), args...).Scan(&total); err != nil {
		total = int64(len(projects))
	}
	result := make([]map[string]any, 0, len(projects))
	for _, project := range projects {
		row := project.publicMap()
		row["entry_count"] = s.voteEntryCount(r.Context(), project.ID)
		row["current_stage"] = s.voteCurrentStage(r.Context(), project.ID)
		result = append(result, row)
	}
	writeJSON(w, map[string]any{"success": true, "data": result, "total": total, "limit": 100})
}

func (s *Server) voteProjectManageable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	where, args := "", []any{}
	if projectType := voteNormalize(firstNonEmpty(stringValue(r.URL.Query().Get("project_type")), votePathProjectType(r.URL.Path)), voteProjectTypes, ""); projectType != "" {
		where, args = " WHERE project_type=?", []any{projectType}
	}
	query := "SELECT id,project_type,club_id,country,title,COALESCE(year_label,''),COALESCE(description,''),COALESCE(cover_url,''),status,visibility,eligibility_mode,result_visibility,COALESCE(config_json,'{}'),COALESCE(share_token,''),guest_vote,created_by,created_at,updated_at,COALESCE(published_at,''),COALESCE(ended_at,'') FROM vote_projects" + where
	orderPrefix := ""
	if user.Role != "super_admin" {
		query = "SELECT DISTINCT p.id,p.project_type,p.club_id,p.country,p.title,COALESCE(p.year_label,''),COALESCE(p.description,''),COALESCE(p.cover_url,''),p.status,p.visibility,p.eligibility_mode,p.result_visibility,COALESCE(p.config_json,'{}'),COALESCE(p.share_token,''),p.guest_vote,p.created_by,p.created_at,p.updated_at,COALESCE(p.published_at,''),COALESCE(p.ended_at,'') FROM vote_projects p JOIN club_memberships m ON m.club_id=p.club_id AND m.country=p.country WHERE m.user_id=? AND m.status='active' AND m.role IN ('representative','manager')" + strings.Replace(where, " WHERE", " AND", 1)
		args = append([]any{user.ID}, args...)
		orderPrefix = "p."
	}
	query += " ORDER BY " + orderPrefix + "updated_at DESC," + orderPrefix + "id DESC LIMIT 200"
	rows, err := s.db.QueryContext(r.Context(), query, args...)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取企划失败"})
		return
	}
	projects, err := s.scanVoteProjects(rows)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取企划失败"})
		return
	}
	result := make([]map[string]any, 0, len(projects))
	for _, project := range projects {
		result = append(result, project.publicMap())
	}
	writeJSON(w, map[string]any{"success": true, "data": result})
}

func (s *Server) voteProjectGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	project, err := s.voteProject(r.Context(), parsePositiveInt(firstNonEmpty(r.URL.Query().Get("id"), r.URL.Query().Get("project_id"))))
	if err == sql.ErrNoRows || project == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "企划不存在"})
		return
	}
	if filter := firstNonEmpty(stringValue(r.URL.Query().Get("project_type")), votePathProjectType(r.URL.Path)); filter != "" && project.ProjectType != filter {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "企划不存在"})
		return
	}
	viewerID, _ := s.optionalSessionUser(r)
	var viewer *user
	if viewerID != nil {
		viewer, _ = s.findUser(r.Context(), *viewerID)
	}
	if !s.voteCanRead(r.Context(), viewer, project) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权查看该企划"})
		return
	}
	manage := s.voteCanManage(r.Context(), viewer, project)
	if project.Status == "draft" && !manage {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "企划不存在"})
		return
	}
	stages := s.voteStages(r.Context(), project.ID, manage)
	share := strings.TrimSpace(r.URL.Query().Get("share"))
	data := project.publicMap()
	if !manage {
		data["share_token"] = nil
	}
	writeJSON(w, map[string]any{"success": true, "data": data, "stages": stages, "can_manage": manage, "can_participate": s.voteCanParticipate(r.Context(), viewer, project), "authenticated": viewer != nil, "guest_vote_enabled": project.GuestVote == 1, "share_valid": share != "" && project.ShareToken != "" && share == project.ShareToken, "share_token": map[bool]any{true: project.ShareToken, false: nil}[manage]})
}

func (s *Server) voteProjectCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	input := voteReadJSON(r)
	projectType := voteNormalize(firstNonEmpty(firstNonEmpty(stringValue(input["project_type"]), stringValue(r.URL.Query().Get("project_type"))), votePathProjectType(r.URL.Path)), voteProjectTypes, "twelve")
	clubID, country := integerValue(input["club_id"]), voteProjectCountry(stringValue(input["country"]))
	title := strings.TrimSpace(stringValue(input["title"]))
	if clubID <= 0 || title == "" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请填写同好会和企划标题"})
		return
	}
	if !s.canManageClubCodes(r.Context(), user, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "只有负责人/管理员可创建本会企划"})
		return
	}
	eligibility := firstNonEmpty(stringValue(input["eligibility_mode"]), "club_member")
	if !containsString(voteEligibilityModes, eligibility) || eligibility == "invite_code" || eligibility == "whitelist" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "邀请码/白名单参与资格尚未开放，请先选择同好会成员或登录用户"})
		return
	}
	visibility := voteNormalize(firstNonEmpty(stringValue(input["visibility"]), "public"), voteVisibilities, "public")
	resultVisibility := voteNormalize(firstNonEmpty(stringValue(input["result_visibility"]), "live_rank_only"), voteResultVisibilities, "live_rank_only")
	result, err := s.db.ExecContext(r.Context(), "INSERT INTO vote_projects(project_type,club_id,country,title,year_label,description,cover_url,status,visibility,eligibility_mode,result_visibility,config_json,created_by) VALUES(?,?,?,?,?,?,?,'draft',?,?,?,?,?)", projectType, clubID, country, title, firstNonEmpty(stringValue(input["year_label"]), ""), stringValue(input["description"]), stringValue(input["cover_url"]), visibility, eligibility, resultVisibility, jsonStringOrEmpty(input["config"]), user.ID)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "创建企划失败"})
		return
	}
	id, _ := result.LastInsertId()
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err == nil {
		for _, stage := range voteDefaultStagesFor(projectType) {
			if _, err = tx.ExecContext(r.Context(), "INSERT INTO vote_stages(project_id,stage_type,title,sort_order,status,vote_mode,max_select,advance_count,group_count,result_visibility,config_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)", id, stage[0], stage[1], stage[2], "pending", stage[3], stage[4], stage[5], stage[6], resultVisibility, "{}"); err != nil {
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
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "创建企划阶段失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "id": id, "project_type": projectType})
}

func (s *Server) voteProjectUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	project, err := s.voteProject(r.Context(), parsePositiveInt(r.URL.Query().Get("id")))
	if err != nil || project == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "企划不存在"})
		return
	}
	if !s.voteCanManage(r.Context(), user, project) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权管理该企划"})
		return
	}
	input := voteReadJSON(r)
	eligibility := voteNormalize(firstNonEmpty(stringValue(input["eligibility_mode"]), project.EligibilityMode), voteEligibilityModes, "club_member")
	if eligibility == "invite_code" || eligibility == "whitelist" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "邀请码/白名单参与资格尚未开放，请先选择同好会成员或登录用户"})
		return
	}
	guest := project.GuestVote
	if _, exists := input["guest_vote"]; exists && boolValue(input["guest_vote"]) {
		guest = 1
	} else if _, exists := input["guest_vote"]; exists {
		guest = 0
	}
	_, err = s.db.ExecContext(r.Context(), "UPDATE vote_projects SET title=?,year_label=?,description=?,cover_url=?,visibility=?,eligibility_mode=?,result_visibility=?,guest_vote=?,config_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", firstNonEmpty(stringValue(input["title"]), project.Title), firstNonEmpty(stringValue(input["year_label"]), project.YearLabel), firstNonEmpty(stringValue(input["description"]), project.Description), firstNonEmpty(stringValue(input["cover_url"]), project.CoverURL), voteNormalize(firstNonEmpty(stringValue(input["visibility"]), project.Visibility), voteVisibilities, "public"), eligibility, voteNormalize(firstNonEmpty(stringValue(input["result_visibility"]), project.ResultVisibility), voteResultVisibilities, "live_rank_only"), guest, jsonStringOrEmpty(input["config"]), project.ID)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "更新企划失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true})
}

func (s *Server) voteProjectShare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPost)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	project, err := s.voteProject(r.Context(), parsePositiveInt(r.URL.Query().Get("id")))
	if err != nil || project == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "企划不存在"})
		return
	}
	if !s.voteCanManage(r.Context(), user, project) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权管理该企划"})
		return
	}
	if project.ShareToken == "" {
		raw := make([]byte, 16)
		if _, err := rand.Read(raw); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "分享令牌生成失败"})
			return
		}
		project.ShareToken = hex.EncodeToString(raw)
		if _, err := s.db.ExecContext(r.Context(), "UPDATE vote_projects SET share_token=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", project.ShareToken, project.ID); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "分享令牌保存失败"})
			return
		}
	}
	writeJSON(w, map[string]any{"success": true, "share_token": project.ShareToken, "guest_vote": project.GuestVote, "status": project.Status})
}

func (s *Server) voteProjectLifecycle(w http.ResponseWriter, r *http.Request, action string) {
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	project, err := s.voteProject(r.Context(), parsePositiveInt(r.URL.Query().Get("id")))
	if err != nil || project == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "企划不存在"})
		return
	}
	if !s.voteCanManage(r.Context(), user, project) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权管理该企划"})
		return
	}
	if action == "delete" {
		tx, err := s.db.BeginTx(r.Context(), nil)
		if err == nil {
			for _, table := range []string{"vote_votes", "vote_matches", "vote_stage_entries", "vote_nominations", "vote_entries", "vote_stages", "vote_results"} {
				if _, err = tx.ExecContext(r.Context(), "DELETE FROM "+table+" WHERE project_id=?", project.ID); err != nil {
					break
				}
			}
			if err == nil {
				_, err = tx.ExecContext(r.Context(), "DELETE FROM vote_projects WHERE id=?", project.ID)
			}
			if err == nil {
				err = tx.Commit()
			} else {
				_ = tx.Rollback()
			}
		}
		if err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "删除企划失败"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "deleted_id": project.ID})
		return
	}
	target := map[string]string{"publish": "running", "suspend": "suspended", "archive": "archived"}[action]
	if action == "publish" && s.voteStageCount(r.Context(), project.ID) == 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请先配置赛程阶段再发布"})
		return
	}
	query := "UPDATE vote_projects SET status=?,updated_at=CURRENT_TIMESTAMP"
	args := []any{target}
	if action == "publish" {
		query += ",published_at=COALESCE(published_at,CURRENT_TIMESTAMP)"
	}
	query += " WHERE id=?"
	args = append(args, project.ID)
	if _, err := s.db.ExecContext(r.Context(), query, args...); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "企划状态保存失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "status": target})
}

func (s *Server) scanVoteProjects(rows *sql.Rows) ([]voteProjectView, error) {
	defer rows.Close()
	result := []voteProjectView{}
	for rows.Next() {
		var project voteProjectView
		if err := rows.Scan(&project.ID, &project.ProjectType, &project.ClubID, &project.Country, &project.Title, &project.YearLabel, &project.Description, &project.CoverURL, &project.Status, &project.Visibility, &project.EligibilityMode, &project.ResultVisibility, &project.ConfigJSON, &project.ShareToken, &project.GuestVote, &project.CreatedBy, &project.CreatedAt, &project.UpdatedAt, &project.PublishedAt, &project.EndedAt); err != nil {
			return nil, err
		}
		result = append(result, project)
	}
	return result, rows.Err()
}

func (s *Server) voteStages(ctx context.Context, projectID int64, manage bool) []map[string]any {
	rows, err := s.db.QueryContext(ctx, "SELECT id,stage_type,title,sort_order,status,starts_at,ends_at,vote_mode,max_select,advance_count,group_count,score_min,score_max,allow_vote_change,result_visibility,COALESCE(config_json,'{}'),created_at,updated_at FROM vote_stages WHERE project_id=? ORDER BY sort_order ASC,id ASC", projectID)
	if err != nil {
		return []map[string]any{}
	}
	defer rows.Close()
	result := []map[string]any{}
	for rows.Next() {
		var id, sortOrder, maxSelect, advance, groups, scoreMin, scoreMax, allowChange int64
		var stageType, title, status, starts, ends, mode, visibility, config, created, updated sql.NullString
		if rows.Scan(&id, &stageType, &title, &sortOrder, &status, &starts, &ends, &mode, &maxSelect, &advance, &groups, &scoreMin, &scoreMax, &allowChange, &visibility, &config, &created, &updated) != nil {
			continue
		}
		row := map[string]any{"id": id, "stage_type": stageType.String, "title": title.String, "sort_order": sortOrder, "status": status.String, "starts_at": starts.String, "ends_at": ends.String, "vote_mode": mode.String, "max_select": maxSelect, "advance_count": advance, "group_count": groups, "score_min": scoreMin, "score_max": scoreMax, "allow_vote_change": allowChange, "result_visibility": visibility.String, "created_at": created.String, "updated_at": updated.String}
		if manage {
			decoded := map[string]any{}
			_ = json.Unmarshal([]byte(config.String), &decoded)
			row["config_json"] = decoded
		}
		result = append(result, row)
	}
	return result
}

func (s *Server) voteEntryCount(ctx context.Context, projectID int64) int64 {
	var count int64
	_ = s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM vote_entries WHERE project_id=? AND entry_status='approved'", projectID).Scan(&count)
	return count
}

func (s *Server) voteStageCount(ctx context.Context, projectID int64) int64 {
	var count int64
	_ = s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM vote_stages WHERE project_id=?", projectID).Scan(&count)
	return count
}

func (s *Server) voteCurrentStage(ctx context.Context, projectID int64) map[string]any {
	var id int64
	var stageType, title, status, ends, mode, config string
	var maxSelect, advance, groups int64
	if err := s.db.QueryRowContext(ctx, "SELECT id,stage_type,title,status,COALESCE(ends_at,''),vote_mode,max_select,advance_count,group_count,COALESCE(config_json,'{}') FROM vote_stages WHERE project_id=? AND status IN ('open','pending','locked') ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,sort_order ASC LIMIT 1", projectID).Scan(&id, &stageType, &title, &status, &ends, &mode, &maxSelect, &advance, &groups, &config); err != nil {
		return nil
	}
	return map[string]any{"id": id, "stage_type": stageType, "title": title, "status": status, "ends_at": ends, "end_time": ends, "vote_mode": mode, "max_select": maxSelect, "advance_count": advance, "group_count": groups, "config_json": jsonDecodeMap(config)}
}

func jsonStringOrEmpty(value any) string {
	if value == nil {
		return "{}"
	}
	return jsonString(value)
}

func jsonDecodeMap(value string) map[string]any {
	result := map[string]any{}
	_ = json.Unmarshal([]byte(value), &result)
	return result
}
