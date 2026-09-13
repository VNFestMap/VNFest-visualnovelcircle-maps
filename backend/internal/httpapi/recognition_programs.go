package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"
)

var recognitionProgramTypes = []string{"assessment", "activity", "mission", "submission", "competition", "award", "external"}
var recognitionBadgeCategories = []string{"knowledge", "skill", "participation", "contribution", "competition", "honor", "memorial", "joint"}
var recognitionStandardCaps = []string{"quiz.basic", "quiz.multiple_choice", "quiz.judgement", "quiz.fill_blank", "quiz.question_pool", "rule.score_threshold", "rule.attempt_limit", "rule.cooldown", "rule.time_window", "submission.text", "review.manual", "activity.claim_code", "credential.single", "credential.batch_import", "award.manual", "stats.basic"}
var recognitionAdvancedCaps = []string{"quiz.random_pool", "quiz.timed", "workflow.multi_stage", "workflow.prerequisite", "workflow.branch", "review.multi_reviewer", "review.owner_final", "rule.conditional", "credential.tiered", "credential.expiring", "credential.limited"}
var recognitionExpertCaps = []string{"event.external", "webhook.inbound", "webhook.outbound", "identity.external_link", "identity.claim_later", "credential.joint_issue"}

type recognitionProgramRow struct {
	ID, ClubID, MaxAttempts, Cooldown, MaxIssuance, CredentialTTL                    int64
	Country, Type, Title, Intro, Difficulty, Visibility, Status, Capabilities, Rules string
	OpenAt, CloseAt, CreatedAt, UpdatedAt                                            sql.NullString
}

func (s *Server) recognitionPrograms(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	switch action {
	case "list":
		s.recognitionProgramList(w, r)
	case "detail":
		s.recognitionProgramDetail(w, r)
	case "create":
		s.recognitionProgramCreate(w, r)
	case "update":
		s.recognitionProgramUpdate(w, r)
	case "publish":
		s.recognitionProgramPublish(w, r)
	case "set_status":
		s.recognitionProgramStatus(w, r)
	case "manage":
		s.recognitionProgramManage(w, r)
	case "badge_create":
		s.recognitionBadgeCreate(w, r)
	case "badge_update":
		s.recognitionBadgeUpdate(w, r)
	case "badge_list":
		s.recognitionBadgeList(w, r)
	case "caps_reference":
		recognitionCapsReference(w)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知操作"})
	}
}

func (s *Server) recognitionProgramList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	query := `SELECT id,club_id,country,type,title,COALESCE(intro,''),participant_difficulty,visibility,status,capabilities,COALESCE(participation_rules,''),max_attempts,cooldown_minutes,open_at,close_at,max_issuance,credential_ttl_days,created_at,updated_at FROM recognition_programs WHERE status='published' AND visibility='public'`
	args := []any{}
	if id := parsePositiveInt(r.URL.Query().Get("club_id")); id > 0 {
		query += " AND club_id=? AND country=?"
		args = append(args, id, clubCodeCountry(r.URL.Query().Get("country")))
	}
	if typ := stringValue(r.URL.Query().Get("type")); containsString(recognitionProgramTypes, typ) {
		query += " AND type=?"
		args = append(args, typ)
	}
	query += " ORDER BY created_at DESC LIMIT 100"
	rows, err := s.db.QueryContext(r.Context(), query, args...)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取考核失败"})
		return
	}
	programs, err := s.scanRecognitionPrograms(rows)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取考核失败"})
		return
	}
	result := make([]map[string]any, 0, len(programs))
	for _, program := range programs {
		caps := recognitionAugmentCaps(recognitionDecodeCaps(program.Capabilities), program)
		var issued int64
		if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM recognition_credentials WHERE program_id=? AND status='active'", program.ID).Scan(&issued); err != nil {
			issued = 0
		}
		row := recognitionProgramPublic(program)
		row["club_name"] = s.recognitionClubName(r.Context(), program.ClubID, program.Country)
		row["tier"], row["issued_count"] = recognitionTier(caps), issued
		result = append(result, row)
	}
	writeJSON(w, map[string]any{"success": true, "programs": result})
}

func (s *Server) recognitionProgramDetail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	id := parsePositiveInt(r.URL.Query().Get("id"))
	program, err := s.recognitionProgram(r.Context(), id)
	if err == sql.ErrNoRows || program == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "考核不存在"})
		return
	}
	viewerID, _ := s.optionalSessionUser(r)
	isManager := false
	var viewer *user
	if viewerID != nil {
		viewer, _ = s.findUser(r.Context(), *viewerID)
		isManager = viewer != nil && s.recognitionCanDesign(r.Context(), viewer, program.ClubID, program.Country)
	}
	if program.Status == "draft" && !isManager {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "考核不存在"})
		return
	}
	version, _ := s.recognitionVersion(r.Context(), id, !isManager)
	content := map[string]any{}
	if version != nil {
		content = version["content"].(map[string]any)
		if !isManager {
			content = recognitionStripAnswers(content)
		}
	}
	result := map[string]any{"success": true, "program": map[string]any{"id": program.ID, "club_id": program.ClubID, "country": program.Country, "club_name": s.recognitionClubName(r.Context(), program.ClubID, program.Country), "type": program.Type, "title": program.Title, "intro": program.Intro, "participant_difficulty": program.Difficulty, "status": program.Status, "open_at": recognitionNull(program.OpenAt), "close_at": recognitionNull(program.CloseAt), "max_attempts": program.MaxAttempts, "cooldown_minutes": program.Cooldown, "tier": recognitionTier(recognitionAugmentCaps(recognitionDecodeCaps(program.Capabilities), *program)), "is_manager": isManager}, "version": version}
	if version != nil {
		result["version"].(map[string]any)["content"] = content
	}
	if viewer != nil && version != nil {
		var attempts int64
		_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM recognition_attempts WHERE program_version_id=? AND user_id=?", integerValue(result["version"].(map[string]any)["id"]), viewer.ID).Scan(&attempts)
		result["my_attempts"] = attempts
		var uid sql.NullString
		_ = s.db.QueryRowContext(r.Context(), "SELECT credential_uid FROM recognition_credentials WHERE program_version_id=? AND holder_user_id=? AND status='active' LIMIT 1", integerValue(result["version"].(map[string]any)["id"]), viewer.ID).Scan(&uid)
		result["my_credential_uid"] = recognitionNull(uid)
	}
	writeJSON(w, result)
}

func (s *Server) recognitionProgramCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
		return
	}
	if !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	input := map[string]any{}
	if err := decodeJSON(r, &input, 4<<20); err != nil || input == nil {
		writeJSON(w, map[string]any{"success": false, "message": "请求数据格式错误"})
		return
	}
	clubID := integerValue(input["club_id"])
	country := clubCodeCountry(stringValue(input["country"]))
	if !s.recognitionCanDesign(r.Context(), user, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权为该同好会创建考核"})
		return
	}
	if s.growthFindClub(r.Context(), country, clubID) == nil {
		writeJSON(w, map[string]any{"success": false, "message": "同好会不存在"})
		return
	}
	typ := stringValue(input["type"])
	if !containsString(recognitionProgramTypes, typ) {
		typ = "assessment"
	}
	title := cleanProjectText(input["title"], 100)
	if title == "" {
		writeJSON(w, map[string]any{"success": false, "message": "标题必填且不超过 100 字"})
		return
	}
	content, _ := input["content"].(map[string]any)
	if content == nil {
		content = map[string]any{}
	}
	if err := recognitionValidateContent(content, typ); err != "" {
		writeJSON(w, map[string]any{"success": false, "message": err})
		return
	}
	caps := recognitionDeriveCaps(content, typ, integerValue(input["credential_ttl_days"]), integerValue(input["max_issuance"]))
	result, err := s.db.ExecContext(r.Context(), `INSERT INTO recognition_programs (club_id,country,type,title,intro,participant_difficulty,visibility,status,capabilities,max_attempts,cooldown_minutes,open_at,close_at,max_issuance,credential_ttl_days,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, clubID, country, typ, title, cleanProjectText(input["intro"], 5000), recognitionDifficulty(input["participant_difficulty"]), "public", "draft", jsonString(caps), maxInt64(integerValue(input["max_attempts"]), 0), maxInt64(integerValue(input["cooldown_minutes"]), 0), nullableInputString(input["open_at"]), nullableInputString(input["close_at"]), maxInt64(integerValue(input["max_issuance"]), 0), maxInt64(integerValue(input["credential_ttl_days"]), 0), user.ID)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "创建失败"})
		return
	}
	programID, _ := result.LastInsertId()
	if _, err := s.db.ExecContext(r.Context(), "INSERT INTO recognition_program_versions(program_id,version_no,status,content_snapshot) VALUES(?,?,?,?)", programID, "v0.1", "draft", jsonString(content)); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "创建失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "program_id": programID, "tier": recognitionTier(caps)})
}

func (s *Server) recognitionProgramUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
		return
	}
	if !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 4<<20); err != nil || input == nil {
		writeJSON(w, map[string]any{"success": false, "message": "请求数据格式错误"})
		return
	}
	programID := integerValue(input["program_id"])
	program, err := s.recognitionProgram(r.Context(), programID)
	if err == sql.ErrNoRows || program == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "考核不存在"})
		return
	}
	if !s.recognitionCanDesign(r.Context(), user, program.ClubID, program.Country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权修改该考核"})
		return
	}
	sets, args := []string{}, []any{}
	for _, field := range []string{"title", "intro", "participant_difficulty", "open_at", "close_at", "max_attempts", "cooldown_minutes", "max_issuance", "credential_ttl_days"} {
		if value, exists := input[field]; exists {
			if field == "title" {
				value = cleanProjectText(value, 100)
			}
			if strings.HasSuffix(field, "_attempts") || strings.HasSuffix(field, "_minutes") || strings.HasSuffix(field, "_issuance") || strings.HasSuffix(field, "_days") {
				value = maxInt64(integerValue(value), 0)
			}
			sets, args = append(sets, field+"=?"), append(args, value)
		}
	}
	if content, exists := input["content"]; exists {
		contentMap, _ := content.(map[string]any)
		if contentMap == nil {
			contentMap = map[string]any{}
		}
		typ := firstNonEmpty(stringValue(input["type"]), program.Type)
		if err := recognitionValidateContent(contentMap, typ); err != "" {
			writeJSON(w, map[string]any{"success": false, "message": err})
			return
		}
		sets = append(sets, "capabilities=?", "type=?")
		args = append(args, jsonString(recognitionDeriveCaps(contentMap, typ, integerValue(input["credential_ttl_days"]), integerValue(input["max_issuance"]))), typ)
		version, _ := s.recognitionVersion(r.Context(), programID, true)
		if version != nil {
			_, _ = s.db.ExecContext(r.Context(), "UPDATE recognition_program_versions SET content_snapshot=? WHERE id=?", jsonString(contentMap), integerValue(version["id"]))
		} else {
			var count int64
			_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM recognition_program_versions WHERE program_id=?", programID).Scan(&count)
			_, _ = s.db.ExecContext(r.Context(), "INSERT INTO recognition_program_versions(program_id,version_no,status,content_snapshot) VALUES(?,?,?,?)", programID, "v0."+strconvInt(count+1), "draft", jsonString(contentMap))
		}
	}
	if len(sets) > 0 {
		args = append(args, programID)
		if _, err := s.db.ExecContext(r.Context(), "UPDATE recognition_programs SET "+strings.Join(sets, ",")+" WHERE id=?", args...); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "更新失败"})
			return
		}
	}
	writeJSON(w, map[string]any{"success": true})
}

func (s *Server) recognitionProgramPublish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !sameOrigin(r) {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 1<<20); err != nil || input == nil {
		writeJSON(w, map[string]any{"success": false, "message": "请求数据格式错误"})
		return
	}
	programID := integerValue(input["program_id"])
	program, err := s.recognitionProgram(r.Context(), programID)
	if err == sql.ErrNoRows || program == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "考核不存在"})
		return
	}
	if !s.recognitionCanDesign(r.Context(), user, program.ClubID, program.Country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权发布该考核"})
		return
	}
	version, _ := s.recognitionVersion(r.Context(), programID, true)
	if version == nil || stringValue(version["status"]) != "draft" {
		writeJSON(w, map[string]any{"success": false, "message": "没有可发布的草稿版本"})
		return
	}
	versionID := integerValue(version["id"])
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "发布失败"})
		return
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(r.Context(), "UPDATE recognition_program_versions SET status='superseded' WHERE program_id=? AND status='published'", programID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "发布失败"})
		return
	}
	if _, err := tx.ExecContext(r.Context(), "UPDATE recognition_program_versions SET status='published', published_by=?, published_at=? WHERE id=?", user.ID, time.Now().Format("2006-01-02 15:04:05"), versionID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "发布失败"})
		return
	}
	if _, err := tx.ExecContext(r.Context(), "UPDATE recognition_programs SET status='published' WHERE id=?", programID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "发布失败"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "发布失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "version_id": versionID, "version_no": version["version_no"]})
}

func (s *Server) recognitionProgramStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !sameOrigin(r) {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	var input map[string]any
	_ = decodeJSON(r, &input, 1<<20)
	program, err := s.recognitionProgram(r.Context(), integerValue(input["program_id"]))
	if err == sql.ErrNoRows || program == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "考核不存在"})
		return
	}
	target := stringValue(input["status"])
	if !containsString([]string{"paused", "published", "archived"}, target) {
		writeJSON(w, map[string]any{"success": false, "message": "目标状态非法"})
		return
	}
	if !s.recognitionCanDesign(r.Context(), user, program.ClubID, program.Country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权操作"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE recognition_programs SET status=? WHERE id=?", target, program.ID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "状态保存失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true})
}

func (s *Server) recognitionProgramManage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	clubID := parsePositiveInt(r.URL.Query().Get("club_id"))
	country := clubCodeCountry(r.URL.Query().Get("country"))
	if !s.recognitionCanDesign(r.Context(), user, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT id,club_id,country,type,title,COALESCE(intro,''),participant_difficulty,visibility,status,capabilities,COALESCE(participation_rules,''),max_attempts,cooldown_minutes,open_at,close_at,max_issuance,credential_ttl_days,created_at,updated_at FROM recognition_programs WHERE club_id=? AND country=? ORDER BY created_at DESC`, clubID, country)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取考核失败"})
		return
	}
	programs, _ := s.scanRecognitionPrograms(rows)
	result := make([]map[string]any, 0, len(programs))
	for _, program := range programs {
		row := recognitionProgramPublic(program)
		row["tier"] = recognitionTier(recognitionAugmentCaps(recognitionDecodeCaps(program.Capabilities), program))
		var issuedTotal int64
		_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM recognition_credentials WHERE program_id=?", program.ID).Scan(&issuedTotal)
		row["issued_total"] = issuedTotal
		result = append(result, row)
	}
	writeJSON(w, map[string]any{"success": true, "programs": result})
}

func (s *Server) recognitionBadgeCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !sameOrigin(r) {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 1<<20); err != nil || input == nil {
		writeJSON(w, map[string]any{"success": false, "message": "请求数据格式错误"})
		return
	}
	clubID, country := integerValue(input["club_id"]), clubCodeCountry(stringValue(input["country"]))
	if !s.recognitionCanBadge(r.Context(), user, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权管理该同好会徽章"})
		return
	}
	name := cleanProjectText(input["name"], 60)
	if name == "" {
		writeJSON(w, map[string]any{"success": false, "message": "徽章名称必填且不超过 60 字"})
		return
	}
	category := stringValue(input["category"])
	if !containsString(recognitionBadgeCategories, category) {
		category = "participation"
	}
	result, err := s.db.ExecContext(r.Context(), `INSERT INTO recognition_badges(club_id,country,name,category,description,image_url,created_by) VALUES(?,?,?,?,?,?,?)`, clubID, country, name, category, cleanProjectText(input["description"], 2000), cleanProjectText(input["image_url"], 500), user.ID)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "创建徽章失败"})
		return
	}
	id, _ := result.LastInsertId()
	writeJSON(w, map[string]any{"success": true, "badge_id": id})
}

func (s *Server) recognitionBadgeUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !sameOrigin(r) {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 1<<20); err != nil || input == nil {
		writeJSON(w, map[string]any{"success": false, "message": "请求数据格式错误"})
		return
	}
	badgeID, clubID := integerValue(input["badge_id"]), integerValue(input["club_id"])
	country := clubCodeCountry(stringValue(input["country"]))
	if !s.recognitionCanBadge(r.Context(), user, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权管理该同好会徽章"})
		return
	}
	sets, args := []string{}, []any{}
	if value, exists := input["name"]; exists {
		name := cleanProjectText(value, 60)
		if name == "" {
			writeJSON(w, map[string]any{"success": false, "message": "徽章名称必填且不超过 60 字"})
			return
		}
		sets, args = append(sets, "name=?"), append(args, name)
	}
	if value, exists := input["category"]; exists {
		category := stringValue(value)
		if !containsString(recognitionBadgeCategories, category) {
			category = "participation"
		}
		sets, args = append(sets, "category=?"), append(args, category)
	}
	for _, field := range []string{"description", "image_url"} {
		if value, exists := input[field]; exists {
			sets, args = append(sets, field+"=?"), append(args, cleanProjectText(value, 2000))
		}
	}
	if len(sets) == 0 {
		writeJSON(w, map[string]any{"success": false, "message": "没有需要更新的字段"})
		return
	}
	sets = append(sets, "version=version+1")
	args = append(args, badgeID, clubID, country)
	if _, err := s.db.ExecContext(r.Context(), "UPDATE recognition_badges SET "+strings.Join(sets, ",")+" WHERE id=? AND club_id=? AND country=?", args...); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "更新徽章失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true})
}

func (s *Server) recognitionBadgeList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	rows, err := s.db.QueryContext(r.Context(), "SELECT id,name,category,description,image_url,version,created_at FROM recognition_badges WHERE club_id=? AND country=? ORDER BY created_at DESC", parsePositiveInt(r.URL.Query().Get("club_id")), clubCodeCountry(r.URL.Query().Get("country")))
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取徽章失败"})
		return
	}
	defer rows.Close()
	badges := []map[string]any{}
	for rows.Next() {
		var id, version int64
		var name, category string
		var description, image, created sql.NullString
		if rows.Scan(&id, &name, &category, &description, &image, &version, &created) == nil {
			badges = append(badges, map[string]any{"id": id, "name": name, "category": category, "description": recognitionNull(description), "image_url": bangumiProxyImageURL(image.String), "version": version, "created_at": recognitionNull(created)})
		}
	}
	writeJSON(w, map[string]any{"success": true, "badges": badges})
}

func recognitionCapsReference(w http.ResponseWriter) {
	writeJSON(w, map[string]any{"success": true, "tiers": []map[string]any{{"key": "standard", "label": "标准", "caps": recognitionStandardCaps}, {"key": "advanced", "label": "进阶", "caps": recognitionAdvancedCaps}, {"key": "expert", "label": "专家", "caps": recognitionExpertCaps}}, "implemented": recognitionStandardCaps, "note": "层级不落库：保存时按实际使用能力自动判定，档位选择器仅控制编辑器可见范围。"})
}

func (s *Server) recognitionProgram(ctx context.Context, id int64) (*recognitionProgramRow, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id,club_id,country,type,title,COALESCE(intro,''),participant_difficulty,visibility,status,COALESCE(capabilities,'[]'),COALESCE(participation_rules,''),max_attempts,cooldown_minutes,open_at,close_at,max_issuance,credential_ttl_days,created_at,updated_at FROM recognition_programs WHERE id=?`, id)
	var result recognitionProgramRow
	err := row.Scan(&result.ID, &result.ClubID, &result.Country, &result.Type, &result.Title, &result.Intro, &result.Difficulty, &result.Visibility, &result.Status, &result.Capabilities, &result.Rules, &result.MaxAttempts, &result.Cooldown, &result.OpenAt, &result.CloseAt, &result.MaxIssuance, &result.CredentialTTL, &result.CreatedAt, &result.UpdatedAt)
	return &result, err
}

func (s *Server) scanRecognitionPrograms(rows *sql.Rows) ([]recognitionProgramRow, error) {
	defer rows.Close()
	result := []recognitionProgramRow{}
	for rows.Next() {
		var row recognitionProgramRow
		if err := rows.Scan(&row.ID, &row.ClubID, &row.Country, &row.Type, &row.Title, &row.Intro, &row.Difficulty, &row.Visibility, &row.Status, &row.Capabilities, &row.Rules, &row.MaxAttempts, &row.Cooldown, &row.OpenAt, &row.CloseAt, &row.MaxIssuance, &row.CredentialTTL, &row.CreatedAt, &row.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func (s *Server) recognitionVersion(ctx context.Context, programID int64, includeDraft bool) (map[string]any, error) {
	query := "SELECT id,version_no,status,content_snapshot,created_at,published_at FROM recognition_program_versions WHERE program_id=? AND status='published' ORDER BY id DESC LIMIT 1"
	if includeDraft {
		query = "SELECT id,version_no,status,content_snapshot,created_at,published_at FROM recognition_program_versions WHERE program_id=? ORDER BY CASE WHEN status='draft' THEN 0 WHEN status='published' THEN 1 ELSE 2 END,id DESC LIMIT 1"
	}
	var id int64
	var versionNo, status, snapshot string
	var created, published sql.NullString
	if err := s.db.QueryRowContext(ctx, query, programID).Scan(&id, &versionNo, &status, &snapshot, &created, &published); err != nil {
		return nil, err
	}
	content := map[string]any{}
	if json.Unmarshal([]byte(snapshot), &content) != nil || content == nil {
		content = map[string]any{}
	}
	return map[string]any{"id": id, "version_no": versionNo, "status": status, "content": content, "created_at": recognitionNull(created), "published_at": recognitionNull(published)}, nil
}

func (s *Server) recognitionClubName(ctx context.Context, clubID int64, country string) string {
	club := s.growthFindClub(ctx, country, clubID)
	if club == nil {
		return "同好会 #" + strconvInt(clubID)
	}
	return firstNonEmpty(stringValue(club["display_name"]), firstNonEmpty(stringValue(club["name"]), firstNonEmpty(stringValue(club["school"]), "同好会 #"+strconvInt(clubID))))
}

func (s *Server) recognitionCanDesign(ctx context.Context, user *user, clubID int64, country string) bool {
	return user != nil && (user.Role == "super_admin" || s.recognitionHasRole(ctx, user, clubID, country, "program_designer") || s.canManageClubCodes(ctx, user, clubID, country))
}
func (s *Server) recognitionCanBadge(ctx context.Context, user *user, clubID int64, country string) bool {
	return user != nil && (user.Role == "super_admin" || s.recognitionHasRole(ctx, user, clubID, country, "badge_manager") || s.canManageClubCodes(ctx, user, clubID, country))
}
func (s *Server) recognitionCanIssue(ctx context.Context, user *user, clubID int64, country string) bool {
	return user != nil && (user.Role == "super_admin" || s.recognitionHasRole(ctx, user, clubID, country, "issuer") || s.canManageClubCodes(ctx, user, clubID, country))
}
func (s *Server) recognitionCanReview(ctx context.Context, user *user, clubID int64, country string) bool {
	return user != nil && (user.Role == "super_admin" || s.recognitionHasRole(ctx, user, clubID, country, "reviewer") || s.canManageClubCodes(ctx, user, clubID, country))
}
func (s *Server) recognitionHasRole(ctx context.Context, user *user, clubID int64, country, wanted string) bool {
	if user == nil {
		return false
	}
	if wanted == "auditor" && user.IsAudit != 0 {
		return true
	}
	var exists int64
	if s.db.QueryRowContext(ctx, "SELECT id FROM recognition_club_roles WHERE user_id=? AND club_id=? AND country=? AND role=? LIMIT 1", user.ID, clubID, country, wanted).Scan(&exists) == nil {
		return true
	}
	var role string
	if s.db.QueryRowContext(ctx, "SELECT role FROM club_memberships WHERE user_id=? AND club_id=? AND country=? AND status='active' LIMIT 1", user.ID, clubID, country).Scan(&role) == nil {
		if wanted == "program_designer" || wanted == "badge_manager" || wanted == "issuer" || wanted == "reviewer" {
			return role == "representative"
		}
		return role == "representative" || role == "manager"
	}
	return false
}

func recognitionProgramPublic(program recognitionProgramRow) map[string]any {
	return map[string]any{"id": program.ID, "club_id": program.ClubID, "country": program.Country, "type": program.Type, "title": program.Title, "intro": program.Intro, "participant_difficulty": program.Difficulty, "open_at": recognitionNull(program.OpenAt), "close_at": recognitionNull(program.CloseAt), "status": program.Status, "credential_ttl_days": program.CredentialTTL, "max_issuance": program.MaxIssuance, "created_at": recognitionNull(program.CreatedAt)}
}
func recognitionDecodeCaps(value string) []string {
	var result []string
	_ = json.Unmarshal([]byte(value), &result)
	return result
}
func recognitionAugmentCaps(caps []string, program recognitionProgramRow) []string {
	result := append([]string{}, caps...)
	if program.CredentialTTL > 0 && !containsString(result, "credential.expiring") {
		result = append(result, "credential.expiring")
	}
	if program.MaxIssuance > 0 && !containsString(result, "credential.limited") {
		result = append(result, "credential.limited")
	}
	return uniqueStrings(result)
}
func recognitionTier(caps []string) string {
	for _, cap := range caps {
		if containsString(recognitionExpertCaps, cap) {
			return "expert"
		}
	}
	for _, cap := range caps {
		if containsString(recognitionAdvancedCaps, cap) {
			return "advanced"
		}
	}
	return "standard"
}
func recognitionDeriveCaps(content map[string]any, typ string, ttl, maxIssuance int64) []string {
	result := []string{"credential.single", "stats.basic"}
	if quiz, ok := content["quiz"].(map[string]any); ok {
		result = append(result, "quiz.basic", "quiz.question_pool")
		for _, question := range anySlice(quiz["questions"]) {
			if row, ok := question.(map[string]any); ok {
				switch stringValue(row["type"]) {
				case "multiple":
					result = append(result, "quiz.multiple_choice")
				case "judge":
					result = append(result, "quiz.judgement")
				case "fill_blank", "fill_multi":
					result = append(result, "quiz.fill_blank")
				}
			}
		}
	}
	if _, ok := content["rules"].(map[string]any); ok {
		result = append(result, "rule.score_threshold")
	}
	if typ == "submission" {
		result = append(result, "submission.text", "review.manual")
	}
	if typ == "award" {
		result = append(result, "award.manual")
	}
	if ttl > 0 {
		result = append(result, "credential.expiring")
	}
	if maxIssuance > 0 {
		result = append(result, "credential.limited")
	}
	if _, ok := content["claim"].(map[string]any); ok {
		result = append(result, "activity.claim_code")
	}
	return uniqueStrings(result)
}
func recognitionValidateContent(content map[string]any, typ string) string {
	if typ == "assessment" {
		quiz, ok := content["quiz"].(map[string]any)
		if !ok || len(anySlice(quiz["questions"])) == 0 {
			return "答题类考核至少需要一道题目"
		}
	}
	if typ == "submission" && content["submission"] == nil {
		return "作品提交配置不能为空"
	}
	return ""
}
func recognitionStripAnswers(input map[string]any) map[string]any {
	output := map[string]any{}
	for key, value := range input {
		if key == "answer" || key == "answers" || key == "correct_answer" {
			continue
		}
		if row, ok := value.(map[string]any); ok {
			output[key] = recognitionStripAnswers(row)
			continue
		}
		if values, ok := value.([]any); ok {
			clean := make([]any, 0, len(values))
			for _, item := range values {
				if row, ok := item.(map[string]any); ok {
					clean = append(clean, recognitionStripAnswers(row))
				} else {
					clean = append(clean, item)
				}
			}
			output[key] = clean
			continue
		}
		output[key] = value
	}
	return output
}
func recognitionDifficulty(value any) string {
	result := stringValue(value)
	if !containsString([]string{"easy", "normal", "hard", "extreme"}, result) {
		return "normal"
	}
	return result
}
func recognitionNull(value sql.NullString) any {
	if value.Valid {
		return value.String
	}
	return nil
}
func jsonString(value any) string { encoded, _ := json.Marshal(value); return string(encoded) }
func maxInt64(value, minimum int64) int64 {
	if value < minimum {
		return minimum
	}
	return value
}
func uniqueStrings(values []string) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		if value != "" && !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	sort.Strings(result)
	return result
}
