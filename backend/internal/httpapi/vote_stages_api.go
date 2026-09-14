package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

var voteStageTypes = []string{"nomination", "qualifier", "group_vote", "bracket", "final"}
var voteStageStatuses = []string{"pending", "open", "locked", "reviewing", "settled"}
var voteModes = []string{"nomination", "multi_select", "score", "match_single"}

func (s *Server) voteStagesAPI(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	switch action {
	case "list":
		s.voteStageList(w, r)
	case "create":
		s.voteStageCreate(w, r)
	case "update", "update_and_rebuild":
		s.voteStageUpdate(w, r, action)
	case "reorder":
		s.voteStageReorder(w, r)
	case "stage_entries":
		s.voteStageEntries(w, r)
	case "seed_entries", "reseed_stage":
		s.voteStageSeed(w, r, action)
	case "open", "lock", "close", "settle", "open_pool", "settle_pool":
		s.voteStageLifecycle(w, r, action)
	case "flow_status", "rebuild", "rebuild_flow", "generate_next_pool", "advance", "advance_flow", "resolve_ties", "resolve_tie":
		// These names were introduced by the later flow engine. The basic
		// compatibility tables remain authoritative until a flow run exists;
		// returning a stable status keeps old admin clients from receiving a
		// transport-level 404 while the same state machine is used.
		s.voteStageFlowCompatibility(w, r, action)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知 action=" + action})
	}
}

func (s *Server) voteStageList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	projectID := voteProjectID(r.URL.Query().Get("project_id"), r.URL.Query().Get("contest_id"))
	project, err := s.voteProject(r.Context(), projectID)
	if err == sql.ErrNoRows || project == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "企划不存在"})
		return
	}
	if expected := votePathProjectType(r.URL.Path); expected != "" && expected != project.ProjectType {
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
	writeJSON(w, map[string]any{"success": true, "data": s.voteStages(r.Context(), projectID, manage), "can_manage": manage})
}

func (s *Server) voteStageCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	input := voteReadJSON(r)
	projectID := voteProjectID(input["project_id"], input["contest_id"], r.URL.Query().Get("project_id"), r.URL.Query().Get("contest_id"))
	if _, _, ok := s.voteProjectManager(w, r, projectID); !ok {
		return
	}
	payload, err := voteStagePayloadGo(input, nil)
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": err.Error()})
		return
	}
	if payload.Title == "" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请填写阶段标题"})
		return
	}
	var order int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT COALESCE(MAX(sort_order),0)+1 FROM vote_stages WHERE project_id=?", projectID).Scan(&order); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取阶段顺序失败"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), "INSERT INTO vote_stages(project_id,stage_type,title,sort_order,status,starts_at,ends_at,vote_mode,max_select,advance_count,group_count,score_min,score_max,allow_vote_change,result_visibility,config_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", projectID, payload.StageType, payload.Title, order, "pending", payload.StartsAt, payload.EndsAt, payload.VoteMode, payload.MaxSelect, payload.AdvanceCount, payload.GroupCount, payload.ScoreMin, payload.ScoreMax, payload.AllowVoteChange, payload.ResultVisibility, payload.ConfigJSON)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "创建阶段失败"})
		return
	}
	id, _ := result.LastInsertId()
	writeJSON(w, map[string]any{"success": true, "id": id})
}

type voteStageInput struct {
	StageType, Title, StartsAt, EndsAt, VoteMode, ResultVisibility, ConfigJSON string
	MaxSelect, AdvanceCount, GroupCount, ScoreMin, ScoreMax, AllowVoteChange   int64
}

func voteStagePayloadGo(input map[string]any, base map[string]any) (voteStageInput, error) {
	get := func(key, fallback string) string {
		if value := strings.TrimSpace(stringValue(input[key])); value != "" {
			return value
		}
		if base != nil {
			return strings.TrimSpace(stringValue(base[key]))
		}
		return fallback
	}
	stageType := voteNormalize(get("stage_type", "group_vote"), voteStageTypes, "group_vote")
	title := get("title", "未命名阶段")
	mode := voteNormalize(get("vote_mode", "multi_select"), voteModes, "multi_select")
	resultVisibility := voteNormalize(get("result_visibility", "live_rank_only"), voteResultVisibilities, "live_rank_only")
	maxSelect := integerValue(input["max_select"])
	if maxSelect <= 0 && base != nil {
		maxSelect = integerValue(base["max_select"])
	}
	if maxSelect <= 0 {
		maxSelect = 1
	}
	advance := integerValue(input["advance_count"])
	if advance < 0 {
		advance = 0
	}
	groups := integerValue(input["group_count"])
	if groups <= 0 {
		groups = 1
	}
	scoreMin := integerValue(input["score_min"])
	if scoreMin <= 0 {
		scoreMin = 1
	}
	scoreMax := integerValue(input["score_max"])
	if scoreMax <= 0 {
		scoreMax = 10
	}
	if scoreMin > scoreMax {
		return voteStageInput{}, fmt.Errorf("评分下限不能高于评分上限")
	}
	config := map[string]any{}
	if base != nil {
		_ = json.Unmarshal([]byte(stringValue(base["config_json"])), &config)
	}
	if value, ok := input["config"].(map[string]any); ok {
		for key, item := range value {
			config[key] = item
		}
	}
	for _, key := range []string{"allow_zero_fill", "allow_vote_change"} {
		if value, ok := input[key]; ok {
			config[key] = boolValue(value)
		}
	}
	for _, key := range []string{"tie_rule", "result_visibility"} {
		if value, ok := input[key]; ok {
			config[key] = strings.TrimSpace(stringValue(value))
		}
	}
	if value, ok := input["bracket_size"]; ok {
		config["bracket_size"] = maxVoteInt64(integerValue(value), 0)
	}
	if value, ok := input["source_stage_id"]; ok {
		config["source_stage_id"] = maxVoteInt64(integerValue(value), 0)
	}
	if _, ok := config["tie_rule"]; !ok {
		config["tie_rule"] = "manual"
	}
	if _, ok := config["allow_zero_fill"]; !ok {
		config["allow_zero_fill"] = false
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		return voteStageInput{}, fmt.Errorf("阶段配置无效")
	}
	return voteStageInput{StageType: stageType, Title: title, StartsAt: get("starts_at", ""), EndsAt: get("ends_at", ""), VoteMode: mode, MaxSelect: maxSelect, AdvanceCount: advance, GroupCount: groups, ScoreMin: scoreMin, ScoreMax: scoreMax, AllowVoteChange: int64(boolInt(boolValue(input["allow_vote_change"]))), ResultVisibility: resultVisibility, ConfigJSON: string(encoded)}, nil
}

func maxVoteInt64(value, minimum int64) int64 {
	if value < minimum {
		return minimum
	}
	return value
}

func (s *Server) voteStageUpdate(w http.ResponseWriter, r *http.Request, action string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	input := voteReadJSON(r)
	stageID := voteProjectID(r.URL.Query().Get("id"), input["id"])
	stage, err := s.voteFetchStage(r.Context(), stageID)
	if err == sql.ErrNoRows || stage == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "阶段不存在"})
		return
	}
	if _, _, ok := s.voteProjectManager(w, r, integerValue(stage["project_id"])); !ok {
		return
	}
	payload, err := voteStagePayloadGo(input, stage)
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": err.Error()})
		return
	}
	if payload.Title == "" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请填写阶段标题"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE vote_stages SET stage_type=?,title=?,starts_at=?,ends_at=?,vote_mode=?,max_select=?,advance_count=?,group_count=?,score_min=?,score_max=?,allow_vote_change=?,result_visibility=?,config_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", payload.StageType, payload.Title, payload.StartsAt, payload.EndsAt, payload.VoteMode, payload.MaxSelect, payload.AdvanceCount, payload.GroupCount, payload.ScoreMin, payload.ScoreMax, payload.AllowVoteChange, payload.ResultVisibility, payload.ConfigJSON, stageID); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "更新阶段失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "id": stageID})
}

func (s *Server) voteStageReorder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	input := voteReadJSON(r)
	projectID := voteProjectID(input["project_id"], input["contest_id"], r.URL.Query().Get("project_id"), r.URL.Query().Get("contest_id"))
	if _, _, ok := s.voteProjectManager(w, r, projectID); !ok {
		return
	}
	values, ok := input["stage_ids"].([]any)
	if !ok {
		if stringsValue, exists := input["stage_ids"].([]int64); exists {
			values = make([]any, len(stringsValue))
			for i, value := range stringsValue {
				values[i] = value
			}
		} else {
			values = []any{}
		}
	}
	for index, value := range values {
		stageID := voteProjectID(value)
		if stageID <= 0 {
			continue
		}
		_, _ = s.db.ExecContext(r.Context(), "UPDATE vote_stages SET sort_order=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=?", index+1, stageID, projectID)
	}
	writeJSON(w, map[string]any{"success": true})
}

func (s *Server) voteStageEntries(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	stageID := voteProjectID(r.URL.Query().Get("stage_id"), r.URL.Query().Get("id"))
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
	manage := s.voteCanManage(r.Context(), viewer, project)
	if err := s.voteEnsureStageEntries(r.Context(), stageID, integerValue(stage["project_id"])); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取阶段候选失败"})
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT se.id,se.project_id,se.stage_id,se.entry_id,se.group_key,se.seed_no,se.source_stage_id,se.source_result_rank,se.status,se.created_at,e.title,e.title_cn,e.subtitle,e.image_url,e.entry_status
		FROM vote_stage_entries se JOIN vote_entries e ON e.id=se.entry_id WHERE se.stage_id=? ORDER BY se.group_key,se.seed_no,se.id`, stageID)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取阶段候选失败"})
		return
	}
	defer rows.Close()
	data := []map[string]any{}
	for rows.Next() {
		var id, pid, sid, eid, seed int64
		var sourceStage, sourceRank sql.NullInt64
		var groupKey, status, created, title, titleCN, subtitle, imageURL, entryStatus string
		if rows.Scan(&id, &pid, &sid, &eid, &groupKey, &seed, &sourceStage, &sourceRank, &status, &created, &title, &titleCN, &subtitle, &imageURL, &entryStatus) != nil {
			continue
		}
		row := map[string]any{"id": id, "project_id": pid, "stage_id": sid, "entry_id": eid, "group_key": groupKey, "seed_no": seed, "source_stage_id": nil, "source_result_rank": nil, "status": status, "created_at": created, "title": title, "title_cn": titleCN, "subtitle": subtitle, "image_url": bangumiProxyImageURL(imageURL), "entry_status": entryStatus}
		if sourceStage.Valid {
			row["source_stage_id"] = sourceStage.Int64
		}
		if sourceRank.Valid {
			row["source_result_rank"] = sourceRank.Int64
		}
		data = append(data, row)
	}
	writeJSON(w, map[string]any{"success": true, "data": data, "can_manage": manage})
}

func (s *Server) voteStageSeed(w http.ResponseWriter, r *http.Request, action string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	input := voteReadJSON(r)
	stageID := voteProjectID(input["stage_id"], r.URL.Query().Get("stage_id"))
	stage, err := s.voteFetchStage(r.Context(), stageID)
	if err != nil || stage == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "阶段不存在"})
		return
	}
	if _, _, ok := s.voteProjectManager(w, r, integerValue(stage["project_id"])); !ok {
		return
	}
	entryValues, _ := input["entry_ids"].([]any)
	entryIDs := make([]int64, 0, len(entryValues))
	for _, value := range entryValues {
		if id := voteProjectID(value); id > 0 {
			entryIDs = append(entryIDs, id)
		}
	}
	if len(entryIDs) == 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请提供 entry_ids"})
		return
	}
	if action == "reseed_stage" {
		if _, err := s.db.ExecContext(r.Context(), "DELETE FROM vote_stage_entries WHERE stage_id=?", stageID); err != nil {
			writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "阶段已有活动，不能重建候选池"})
			return
		}
	}
	if err := s.voteSeedStageEntries(r.Context(), stageID, integerValue(stage["project_id"]), entryIDs, integerValue(input["source_stage_id"])); err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "候选池保存失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "count": len(entryIDs)})
}

func (s *Server) voteStageLifecycle(w http.ResponseWriter, r *http.Request, action string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	input := voteReadJSON(r)
	stageID := voteProjectID(r.URL.Query().Get("stage_id"), r.URL.Query().Get("id"), input["stage_id"], input["id"])
	stage, err := s.voteFetchStage(r.Context(), stageID)
	if err != nil || stage == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "阶段不存在"})
		return
	}
	if _, _, ok := s.voteProjectManager(w, r, integerValue(stage["project_id"])); !ok {
		return
	}
	status := map[string]string{"open": "open", "open_pool": "open", "lock": "locked", "close": "locked", "settle": "settled", "settle_pool": "settled"}[action]
	if status == "" {
		status = "pending"
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE vote_stages SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", status, stageID); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "阶段状态保存失败"})
		return
	}
	if status == "open" {
		_, _ = s.db.ExecContext(r.Context(), "UPDATE vote_projects SET status='running',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('published','draft')", integerValue(stage["project_id"]))
	}
	if status == "settled" {
		_ = s.voteMaterializeResults(r.Context(), stageID, integerValue(stage["project_id"]))
	}
	writeJSON(w, map[string]any{"success": true, "status": status})
}

func (s *Server) voteStageFlowCompatibility(w http.ResponseWriter, r *http.Request, action string) {
	if action == "flow_status" && r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	if action != "flow_status" && r.Method != http.MethodPost && r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPost)
		return
	}
	stageID := voteProjectID(r.URL.Query().Get("stage_id"), r.URL.Query().Get("pool_id"), r.URL.Query().Get("id"))
	projectID := voteProjectID(r.URL.Query().Get("project_id"), r.URL.Query().Get("contest_id"))
	var stage map[string]any
	var project *voteProjectView
	var err error
	if stageID > 0 {
		stage, err = s.voteFetchStage(r.Context(), stageID)
		if err != nil || stage == nil {
			writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "阶段不存在"})
			return
		}
		projectID = integerValue(stage["project_id"])
	}
	if projectID <= 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请提供 project_id 或 stage_id"})
		return
	}
	project, err = s.voteProject(r.Context(), projectID)
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
	if action != "flow_status" && !s.voteCanManage(r.Context(), viewer, project) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权管理该阶段"})
		return
	}
	if action == "flow_status" {
		pools := make([]map[string]any, 0)
		for _, current := range s.voteStages(r.Context(), projectID, s.voteCanManage(r.Context(), viewer, project)) {
			currentID := integerValue(current["id"])
			if currentID <= 0 {
				continue
			}
			pools = append(pools, map[string]any{
				"id": currentID, "stage_id": currentID, "status": stringValue(current["status"]),
				"entry_count": s.voteStageEntryCount(r.Context(), currentID),
				"vote_count": 0, "match_count": 0, "result_count": 0, "runtime": map[string]any{},
			})
		}
		writeJSON(w, map[string]any{"success": true, "project_id": projectID, "pools": pools, "flow": nil, "action": action})
		return
	}
	if stage == nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "该操作需要 stage_id"})
		return
	}
	count := s.voteStageEntryCount(r.Context(), stageID)
	writeJSON(w, map[string]any{"success": true, "project_id": projectID, "stage_id": stageID, "status": stringValue(stage["status"]), "entry_count": count, "flow": nil, "action": action})
}

func (s *Server) voteFetchStage(ctx context.Context, id int64) (map[string]any, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id,project_id,stage_type,title,sort_order,status,starts_at,ends_at,vote_mode,max_select,advance_count,group_count,score_min,score_max,allow_vote_change,result_visibility,COALESCE(config_json,'{}'),created_at,updated_at FROM vote_stages WHERE id=?`, id)
	var stageID, projectID, order, maxSelect, advance, groups, scoreMin, scoreMax, allowChange int64
	var stageType, title, status, starts, ends, mode, visibility, config, created, updated sql.NullString
	if err := row.Scan(&stageID, &projectID, &stageType, &title, &order, &status, &starts, &ends, &mode, &maxSelect, &advance, &groups, &scoreMin, &scoreMax, &allowChange, &visibility, &config, &created, &updated); err != nil {
		return nil, err
	}
	return map[string]any{"id": stageID, "project_id": projectID, "stage_type": stageType.String, "title": title.String, "sort_order": order, "status": status.String, "starts_at": starts.String, "ends_at": ends.String, "vote_mode": mode.String, "max_select": maxSelect, "advance_count": advance, "group_count": groups, "score_min": scoreMin, "score_max": scoreMax, "allow_vote_change": allowChange, "result_visibility": visibility.String, "config_json": config.String, "created_at": created.String, "updated_at": updated.String}, nil
}

func (s *Server) voteEnsureStageEntries(ctx context.Context, stageID, projectID int64) error {
	stage, err := s.voteFetchStage(ctx, stageID)
	if err != nil {
		return err
	}
	if stage != nil && (stringValue(stage["vote_mode"]) == "nomination" || stringValue(stage["stage_type"]) == "nomination") {
		return nil
	}
	var count int64
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM vote_stage_entries WHERE stage_id=?", stageID).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO vote_stage_entries(project_id,stage_id,entry_id,seed_no,status)
		SELECT project_id,?,id,ROW_NUMBER() OVER (ORDER BY id),'active' FROM vote_entries WHERE project_id=? AND entry_status='approved'`, stageID, projectID)
	if err == nil {
		return nil
	}
	// SQLite versions without window functions are still supported by the
	// pure-Go driver; use a deterministic per-row fallback.
	rows, queryErr := s.db.QueryContext(ctx, "SELECT id FROM vote_entries WHERE project_id=? AND entry_status='approved' ORDER BY id", projectID)
	if queryErr != nil {
		return err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	_ = rows.Close()
	return s.voteSeedStageEntries(ctx, stageID, projectID, ids, 0)
}

func (s *Server) voteSeedStageEntries(ctx context.Context, stageID, projectID int64, entryIDs []int64, sourceStageID int64) error {
	for index, entryID := range entryIDs {
		if entryID <= 0 {
			continue
		}
		if _, err := s.db.ExecContext(ctx, `INSERT INTO vote_stage_entries(project_id,stage_id,entry_id,seed_no,source_stage_id,status) VALUES(?,?,?,?,?,'active') ON CONFLICT(stage_id,entry_id) DO UPDATE SET status='active',seed_no=excluded.seed_no`, projectID, stageID, entryID, index+1, nullableInt64(sourceStageID)); err != nil {
			// MySQL does not understand SQLite's ON CONFLICT form.
			if _, fallbackErr := s.db.ExecContext(ctx, "INSERT INTO vote_stage_entries(project_id,stage_id,entry_id,seed_no,source_stage_id,status) VALUES(?,?,?,?,?,'active')", projectID, stageID, entryID, index+1, nullableInt64(sourceStageID)); fallbackErr != nil && !strings.Contains(strings.ToLower(fallbackErr.Error()), "duplicate") {
				return fallbackErr
			}
		}
	}
	return nil
}

func nullableInt64(value int64) any {
	if value <= 0 {
		return nil
	}
	return value
}

func (s *Server) voteStageEntryCount(ctx context.Context, stageID int64) int64 {
	var count int64
	_ = s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM vote_stage_entries WHERE stage_id=? AND status='active'", stageID).Scan(&count)
	return count
}

func (s *Server) voteMaterializeResults(ctx context.Context, stageID, projectID int64) error {
	if _, err := s.db.ExecContext(ctx, "DELETE FROM vote_results WHERE stage_id=?", stageID); err != nil {
		return err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT se.entry_id,COALESCE(SUM(v.vote_value),0),AVG(v.score_value) FROM vote_stage_entries se LEFT JOIN vote_votes v ON v.stage_id=se.stage_id AND v.entry_id=se.entry_id WHERE se.stage_id=? AND se.status='active' GROUP BY se.entry_id ORDER BY 2 DESC,3 DESC,se.entry_id ASC`, stageID)
	if err != nil {
		return err
	}
	type resultRow struct {
		entryID, votes int64
		avg            sql.NullFloat64
	}
	resultRows := []resultRow{}
	for rows.Next() {
		var entryID, votes int64
		var avg sql.NullFloat64
		if rows.Scan(&entryID, &votes, &avg) != nil {
			continue
		}
		resultRows = append(resultRows, resultRow{entryID: entryID, votes: votes, avg: avg})
	}
	if err := rows.Close(); err != nil {
		return err
	}
	var rank int64
	for _, result := range resultRows {
		rank++
		if _, err := s.db.ExecContext(ctx, "INSERT INTO vote_results(project_id,stage_id,entry_id,rank_no,votes,score_avg,advanced,snapshot_json) VALUES(?,?,?,?,?,?,?,?)", projectID, stageID, result.entryID, rank, result.votes, nullableFloat(result.avg), 0, "{}"); err != nil {
			return err
		}
	}
	return nil
}

func nullableFloat(value sql.NullFloat64) any {
	if value.Valid {
		return value.Float64
	}
	return nil
}
