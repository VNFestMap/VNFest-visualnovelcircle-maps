package httpapi

import (
	"context"
	"database/sql"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

func (s *Server) voteVotes(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	if action == "cast" && !allowRequest(r, "vote_cast", 30, time.Minute) {
		rateLimited(w)
		return
	}
	switch action {
	case "eligibility":
		s.voteEligibility(w, r)
	case "cast":
		s.voteCast(w, r)
	case "my_votes":
		s.voteMyVotes(w, r)
	case "results", "stage_results", "round_results", "final_results", "match_results":
		s.voteResults(w, r)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知 action=" + action})
	}
}

func (s *Server) voteEligibility(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	project, err := s.voteProject(r.Context(), voteProjectID(r.URL.Query().Get("project_id"), r.URL.Query().Get("contest_id")))
	if err == sql.ErrNoRows || project == nil {
		writeJSON(w, map[string]any{"success": true, "eligible": false, "reason": "project_not_found"})
		return
	}
	viewerID, _ := s.optionalSessionUser(r)
	var viewer *user
	if viewerID != nil {
		viewer, _ = s.findUser(r.Context(), *viewerID)
	}
	guest := project.GuestVote == 1 && project.Status == "running" && voteShareTokenMatches(project, r.URL.Query().Get("share"))
	eligible := guest || s.voteCanParticipate(r.Context(), viewer, project)
	reason := "login_required"
	if viewer != nil && !eligible {
		reason = "not_eligible"
	} else if guest && viewer == nil {
		reason = "guest_share"
	} else if eligible {
		reason = ""
	}
	writeJSON(w, map[string]any{"success": true, "eligible": eligible, "guest_eligible": guest, "reason": reason})
}

func (s *Server) voteCast(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	input := voteReadJSON(r)
	stage, err := s.voteFetchStage(r.Context(), voteProjectID(input["stage_id"], r.URL.Query().Get("stage_id")))
	if err == sql.ErrNoRows || stage == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "阶段不存在"})
		return
	}
	project, err := s.voteProject(r.Context(), integerValue(stage["project_id"]))
	if err != nil || project == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "企划不存在"})
		return
	}
	viewerID, _ := s.optionalSessionUser(r)
	var viewer *user
	if viewerID != nil {
		viewer, _ = s.findUser(r.Context(), *viewerID)
	}
	guestKey := ""
	if viewer == nil {
		if project.GuestVote != 1 || !voteShareTokenMatches(project, firstNonEmpty(stringValue(input["share"]), r.URL.Query().Get("share"))) {
			writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "该企划未开放免登录投票，请先登录", "logged_in": false})
			return
		}
		if project.Status != "running" {
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "活动不在进行中，无法投票"})
			return
		}
		guestKey = voteGuestKey(w, r)
	} else if !s.voteCanParticipate(r.Context(), viewer, project) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "当前账号不符合投票资格"})
		return
	}
	if stringValue(stage["status"]) != "open" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "当前阶段未开放投票"})
		return
	}
	if voteDeadlinePassed(stringValue(stage["ends_at"])) {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "当前阶段已到截止时间，不能继续投票"})
		return
	}
	entryIDs := voteInt64Array(input["entry_ids"])
	if len(entryIDs) == 0 {
		if entryID := voteProjectID(input["entry_id"]); entryID > 0 {
			entryIDs = []int64{entryID}
		}
	}
	entryIDs = uniqueInt64(entryIDs)
	maxSelect := integerValue(stage["max_select"])
	if maxSelect <= 0 {
		maxSelect = 1
	}
	if stringValue(stage["vote_mode"]) == "match_single" {
		maxSelect = 1
	}
	if len(entryIDs) == 0 || len(entryIDs) > 200 || int64(len(entryIDs)) > maxSelect {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "投票数量不符合当前阶段设置"})
		return
	}
	if err := s.voteEnsureStageEntries(r.Context(), integerValue(stage["id"]), project.ID); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取候选池失败"})
		return
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(entryIDs)), ",")
	args := []any{project.ID, integerValue(stage["id"])}
	for _, entryID := range entryIDs {
		args = append(args, entryID)
	}
	rows, err := s.db.QueryContext(r.Context(), "SELECT entry_id FROM vote_stage_entries WHERE project_id=? AND stage_id=? AND status='active' AND entry_id IN ("+placeholders+")", args...)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取候选池失败"})
		return
	}
	allowed := map[int64]bool{}
	for rows.Next() {
		var entryID int64
		if rows.Scan(&entryID) == nil {
			allowed[entryID] = true
		}
	}
	_ = rows.Close()
	if len(allowed) != len(entryIDs) {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "投票条目不属于当前阶段候选池"})
		return
	}
	voterUserID := int64(0)
	if viewer != nil {
		voterUserID = viewer.ID
	}
	matchID := voteProjectID(input["match_id"])
	if stringValue(stage["vote_mode"]) != "match_single" {
		matchID = 0
	}
	voterWhere := "user_id=? AND guest_key=''"
	voterArg := any(voterUserID)
	if guestKey != "" {
		voterWhere = "user_id IS NULL AND guest_key=?"
		voterArg = guestKey
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "投票暂时不可用"})
		return
	}
	if integerValue(stage["allow_vote_change"]) != 0 {
		deleteQuery := "DELETE FROM vote_votes WHERE stage_id=? AND " + voterWhere
		deleteArgs := []any{integerValue(stage["id"]), voterArg}
		if matchID > 0 {
			deleteQuery += " AND match_id=?"
			deleteArgs = append(deleteArgs, matchID)
		}
		_, err = tx.ExecContext(r.Context(), deleteQuery, deleteArgs...)
	} else {
		var existing int64
		checkQuery := "SELECT COUNT(*) FROM vote_votes WHERE stage_id=? AND " + voterWhere
		checkArgs := []any{integerValue(stage["id"]), voterArg}
		if matchID > 0 {
			checkQuery += " AND match_id=?"
			checkArgs = append(checkArgs, matchID)
		}
		err = tx.QueryRowContext(r.Context(), checkQuery, checkArgs...).Scan(&existing)
		if err == nil && existing > 0 {
			_ = tx.Rollback()
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "本阶段已投票"})
			return
		}
	}
	if err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "投票暂时不可用"})
		return
	}
	scores, _ := input["scores"].(map[string]any)
	insert := "INSERT INTO vote_votes(project_id,stage_id,entry_id,match_id,user_id,guest_key,vote_value,score_value) VALUES(?,?,?,?,?,?,?,?)"
	for _, entryID := range entryIDs {
		var score any
		if stringValue(stage["vote_mode"]) == "score" {
			value := integerValue(input["score_value"])
			if scores != nil {
				value = integerValue(scores[strconv.FormatInt(entryID, 10)])
			}
			min, max := integerValue(stage["score_min"]), integerValue(stage["score_max"])
			if value < min || value > max {
				_ = tx.Rollback()
				writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "评分超出范围"})
				return
			}
			score = value
		}
		if _, err = tx.ExecContext(r.Context(), insert, project.ID, integerValue(stage["id"]), entryID, nullableInt64(matchID), nullableInt64(voterUserID), guestKey, 1, score); err != nil {
			break
		}
	}
	if err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "投票保存失败"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "投票保存失败"})
		return
	}
	result := map[string]any{"success": true, "count": len(entryIDs), "guest": guestKey != ""}
	if guestKey != "" {
		result["guest"] = true
	}
	writeJSON(w, result)
}

func (s *Server) voteMyVotes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	projectID := voteProjectID(r.URL.Query().Get("project_id"), r.URL.Query().Get("contest_id"))
	viewerID, _ := s.optionalSessionUser(r)
	where := "v.user_id IS NULL AND v.guest_key=?"
	actor := any(voteGuestKey(w, r))
	if viewerID != nil {
		where = "v.user_id=?"
		actor = *viewerID
	}
	query := `SELECT v.id,v.project_id,v.stage_id,v.entry_id,v.match_id,v.user_id,v.guest_key,v.vote_value,v.score_value,v.created_at,e.title,e.title_cn,s.title
		FROM vote_votes v JOIN vote_entries e ON e.id=v.entry_id JOIN vote_stages s ON s.id=v.stage_id WHERE ` + where + " AND (?=0 OR v.project_id=?) ORDER BY v.created_at DESC"
	rows, err := s.db.QueryContext(r.Context(), query, actor, projectID, projectID)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取投票记录失败"})
		return
	}
	defer rows.Close()
	data := []map[string]any{}
	for rows.Next() {
		var id, pid, stageID, entryID, voteValue int64
		var matchID, userID sql.NullInt64
		var guestKey, score, created, title, titleCN, stageTitle sql.NullString
		if rows.Scan(&id, &pid, &stageID, &entryID, &matchID, &userID, &guestKey, &voteValue, &score, &created, &title, &titleCN, &stageTitle) != nil {
			continue
		}
		row := map[string]any{"id": id, "project_id": pid, "stage_id": stageID, "entry_id": entryID, "match_id": nil, "user_id": nil, "guest_key": guestKey.String, "vote_value": voteValue, "score_value": nil, "created_at": created.String, "title": title.String, "title_cn": titleCN.String, "stage_title": stageTitle.String}
		if matchID.Valid {
			row["match_id"] = matchID.Int64
		}
		if userID.Valid {
			row["user_id"] = userID.Int64
		}
		if score.Valid {
			if value, parseErr := strconv.ParseInt(score.String, 10, 64); parseErr == nil {
				row["score_value"] = value
			}
		}
		data = append(data, row)
	}
	writeJSON(w, map[string]any{"success": true, "data": data, "guest": viewerID == nil})
}

func (s *Server) voteResults(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	stageID := voteProjectID(r.URL.Query().Get("stage_id"), r.URL.Query().Get("round_id"))
	if stageID <= 0 {
		projectID := voteProjectID(r.URL.Query().Get("project_id"), r.URL.Query().Get("contest_id"))
		_ = s.db.QueryRowContext(r.Context(), "SELECT id FROM vote_stages WHERE project_id=? ORDER BY sort_order DESC,id DESC LIMIT 1", projectID).Scan(&stageID)
	}
	stage, err := s.voteFetchStage(r.Context(), stageID)
	if err == sql.ErrNoRows || stage == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "阶段不存在"})
		return
	}
	project, err := s.voteProject(r.Context(), integerValue(stage["project_id"]))
	if err != nil || project == nil {
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
	visibility := voteResultVisibility(project, stringValue(stage["status"]), stringValue(stage["result_visibility"]))
	if !visibility["rank_visible"].(bool) {
		writeJSON(w, map[string]any{"success": true, "data": []any{}, "match_results": []any{}, "stage_status": stringValue(stage["status"]), "result_visibility": stringValue(stage["result_visibility"]), "rank_visible": false, "metrics_visible": false})
		return
	}
	rows, err := s.voteResultRows(r.Context(), stageID, project.ID)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取投票结果失败"})
		return
	}
	if !visibility["metrics_visible"].(bool) {
		for _, row := range rows {
			delete(row, "votes")
			delete(row, "score_avg")
		}
	}
	writeJSON(w, map[string]any{"success": true, "data": rows, "match_results": []any{}, "stage_status": stringValue(stage["status"]), "result_visibility": stringValue(stage["result_visibility"]), "rank_visible": visibility["rank_visible"], "metrics_visible": visibility["metrics_visible"]})
}

func voteInt64Array(value any) []int64 {
	values, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]int64, 0, len(values))
	for _, item := range values {
		if value := voteProjectID(item); value > 0 {
			result = append(result, value)
		}
	}
	return result
}

func uniqueInt64(values []int64) []int64 {
	seen := map[int64]bool{}
	result := make([]int64, 0, len(values))
	for _, value := range values {
		if value > 0 && !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}

func voteDeadlinePassed(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return false
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02 15:04"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return !parsed.After(time.Now())
		}
	}
	return false
}

func voteResultVisibility(project *voteProjectView, stageStatus, configured string) map[string]any {
	visibility := voteNormalize(configured, voteResultVisibilities, "live_rank_only")
	if visibility == "live_votes" {
		return map[string]any{"rank_visible": true, "metrics_visible": true}
	}
	if visibility == "live_rank_only" {
		return map[string]any{"rank_visible": true, "metrics_visible": false}
	}
	if visibility == "after_stage" {
		visible := stageStatus == "settled"
		return map[string]any{"rank_visible": visible, "metrics_visible": visible}
	}
	if visibility == "after_event" {
		visible := project != nil && project.Status == "ended"
		return map[string]any{"rank_visible": visible, "metrics_visible": visible}
	}
	return map[string]any{"rank_visible": false, "metrics_visible": false}
}

func (s *Server) voteResultRows(ctx context.Context, stageID, projectID int64) ([]map[string]any, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT e.id,e.title,e.title_cn,e.subtitle,e.image_url,e.source_type,e.source_id,e.summary,COALESCE(SUM(v.vote_value),0),AVG(v.score_value)
		FROM vote_stage_entries se JOIN vote_entries e ON e.id=se.entry_id LEFT JOIN vote_votes v ON v.stage_id=se.stage_id AND v.entry_id=se.entry_id
		WHERE se.stage_id=? AND se.project_id=? AND se.status='active' AND e.entry_status='approved' GROUP BY e.id ORDER BY 9 DESC,10 DESC,e.id ASC`, stageID, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type result struct {
		row   map[string]any
		votes int64
		avg   sql.NullFloat64
	}
	results := []result{}
	for rows.Next() {
		var id int64
		var title, titleCN, subtitle, imageURL, sourceType, sourceID, summary string
		var votes int64
		var avg sql.NullFloat64
		if err := rows.Scan(&id, &title, &titleCN, &subtitle, &imageURL, &sourceType, &sourceID, &summary, &votes, &avg); err != nil {
			return nil, err
		}
		results = append(results, result{row: map[string]any{"entry_id": id, "title": title, "title_cn": titleCN, "subtitle": subtitle, "image_url": bangumiProxyImageURL(imageURL), "source_type": sourceType, "source_id": sourceID, "summary": summary}, votes: votes, avg: avg})
	}
	resultRows := make([]map[string]any, 0, len(results))
	for index, item := range results {
		item.row["rank_no"] = index + 1
		item.row["votes"] = item.votes
		if item.avg.Valid {
			item.row["score_avg"] = item.avg.Float64
		} else {
			item.row["score_avg"] = nil
		}
		resultRows = append(resultRows, item.row)
	}
	// Keep sort import useful for deterministic behaviour if database collation
	// differs between SQLite and MySQL.
	sort.SliceStable(resultRows, func(i, j int) bool {
		return integerValue(resultRows[i]["rank_no"]) < integerValue(resultRows[j]["rank_no"])
	})
	return resultRows, rows.Err()
}
