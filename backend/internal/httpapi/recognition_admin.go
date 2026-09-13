package httpapi

import (
	"crypto/rand"
	"database/sql"
	"net/http"
	"strings"
	"time"
)

const recognitionClaimAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func (s *Server) recognitionAdmin(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action"))) {
	case "submissions":
		s.recognitionAdminSubmissions(w, r)
	case "review":
		s.recognitionAdminReview(w, r)
	case "claim_generate":
		s.recognitionAdminClaimGenerate(w, r)
	case "import_participants":
		s.recognitionAdminImportParticipants(w, r)
	case "claim_list":
		s.recognitionAdminClaimList(w, r)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知操作"})
	}
}

func (s *Server) recognitionAdminSubmissions(w http.ResponseWriter, r *http.Request) {
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
	if !s.recognitionCanReview(r.Context(), user, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	status := stringValue(r.URL.Query().Get("status"))
	if !containsString([]string{"pending", "approved", "rejected"}, status) {
		status = "pending"
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT s.id,s.content,s.file_path,s.status,s.created_at,v.id,v.program_id,p.title,u.username,COALESCE(u.nickname,''),u.id
        FROM recognition_submissions s JOIN recognition_program_versions v ON v.id=s.program_version_id JOIN recognition_programs p ON p.id=v.program_id
        JOIN users u ON u.id=s.user_id WHERE p.club_id=? AND p.country=? AND s.status=? ORDER BY s.created_at ASC LIMIT 200`, clubID, country, status)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取提交失败"})
		return
	}
	defer rows.Close()
	result := []map[string]any{}
	for rows.Next() {
		var id, versionID, programID, holderID int64
		var content, filePath, rowStatus, created, title, username, nickname string
		if err := rows.Scan(&id, &content, &filePath, &rowStatus, &created, &versionID, &programID, &title, &username, &nickname, &holderID); err != nil {
			continue
		}
		result = append(result, map[string]any{"id": id, "content": content, "file_path": filePath, "status": rowStatus, "created_at": created, "program_version_id": versionID, "program_id": programID, "program_title": title, "holder_username": username, "holder_nickname": nickname, "holder_user_id": holderID})
	}
	writeJSON(w, map[string]any{"success": true, "submissions": result})
}

func (s *Server) recognitionAdminReview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
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
	submissionID := integerValue(input["submission_id"])
	decision := stringValue(input["decision"])
	if !containsString([]string{"approved", "rejected"}, decision) {
		writeJSON(w, map[string]any{"success": false, "message": "审核结论非法"})
		return
	}
	var programID, versionID, holderID, clubID int64
	var country, currentStatus string
	if err := s.db.QueryRowContext(r.Context(), `SELECT s.user_id,s.status,v.id,v.program_id,p.club_id,p.country FROM recognition_submissions s JOIN recognition_program_versions v ON v.id=s.program_version_id JOIN recognition_programs p ON p.id=v.program_id WHERE s.id=?`, submissionID).Scan(&holderID, &currentStatus, &versionID, &programID, &clubID, &country); err != nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "提交不存在"})
		return
	}
	if currentStatus != "pending" {
		writeJSON(w, map[string]any{"success": false, "message": "该提交已审核"})
		return
	}
	if !s.recognitionCanReview(r.Context(), user, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权审核该提交"})
		return
	}
	comment := truncateRecognition(strings.TrimSpace(stringValue(input["comment"])), 5000)
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "审核失败"})
		return
	}
	if _, err = tx.ExecContext(r.Context(), "UPDATE recognition_submissions SET status=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'", decision, submissionID); err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "审核失败"})
		return
	}
	if _, err = tx.ExecContext(r.Context(), "INSERT INTO recognition_reviews(submission_id,reviewer_id,decision,comment) VALUES(?,?,?,?)", submissionID, user.ID, decision, comment); err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "审核失败"})
		return
	}
	eventType := "submission.rejected"
	if decision == "approved" {
		eventType = "submission.approved"
	}
	if _, err = recordRecognitionEventExec(r.Context(), tx, map[string]any{"type": eventType, "idempotency_key": "review_" + strconvInt(submissionID), "club_id": clubID, "country": country, "user_id": holderID, "program_id": programID, "program_version_id": versionID, "data": map[string]any{"submission_id": submissionID, "reviewer_id": user.ID}, "source_verified": true}); err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "审核失败"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "审核失败"})
		return
	}
	award := map[string]any{"passed": false, "issued": false, "duplicate": false, "credential": nil, "error": nil}
	if decision == "approved" {
		var reviewerCount int64
		_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM recognition_reviews WHERE submission_id=? AND decision='approved'", submissionID).Scan(&reviewerCount)
		award = s.recognitionEvaluateAndAward(r.Context(), versionID, holderID, map[string]any{"submission_status": "approved", "reviewer_count": reviewerCount, "source": "site"})
	}
	message := "已驳回"
	if decision == "approved" {
		message = firstNonEmpty(stringValue(award["error"]), map[bool]string{true: "已通过并签发凭证", false: "已通过，未满足签发条件"}[boolValue(award["passed"])])
	}
	writeJSON(w, map[string]any{"success": true, "decision": decision, "issued": boolValue(award["issued"]), "already_held": boolValue(award["duplicate"]), "credential": award["credential"], "message": message})
}

func (s *Server) recognitionAdminClaimGenerate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
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
	count := integerValue(input["count"])
	if count < 1 {
		count = 1
	}
	if count > 500 {
		count = 500
	}
	ttlHours := maxInt64(integerValue(input["ttl_hours"]), 0)
	program, err := s.recognitionProgram(r.Context(), programID)
	if err != nil || program == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "项目不存在"})
		return
	}
	if !s.recognitionCanIssue(r.Context(), user, program.ClubID, program.Country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权为该项目生成兑换码"})
		return
	}
	version, err := s.recognitionVersion(r.Context(), programID, false)
	if err != nil || version == nil {
		writeJSON(w, map[string]any{"success": false, "message": "该项目尚无已发布版本"})
		return
	}
	content, _ := version["content"].(map[string]any)
	rules, _ := content["rules"].(map[string]any)
	award, _ := rules["award"].(map[string]any)
	badgeID := integerValue(award["badge_id"])
	if badgeID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "项目未配置奖励徽章"})
		return
	}
	var expires any
	var expiresText any
	if ttlHours > 0 {
		expiry := time.Now().Add(time.Duration(ttlHours) * time.Hour).Format("2006-01-02 15:04:05")
		expires, expiresText = expiry, expiry
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "兑换码生成失败"})
		return
	}
	codes := []string{}
	for index := int64(0); index < count; index++ {
		inserted := false
		for retry := 0; retry < 5 && !inserted; retry++ {
			code, codeErr := newRecognitionClaimCode()
			if codeErr != nil {
				_ = tx.Rollback()
				writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "兑换码生成失败"})
				return
			}
			if _, err = tx.ExecContext(r.Context(), "INSERT INTO recognition_claim_codes(code,program_id,program_version_id,badge_id,expires_at) VALUES(?,?,?,?,?)", code, programID, integerValue(version["id"]), badgeID, expires); err == nil {
				codes = append(codes, code)
				inserted = true
			} else if !recognitionUniqueError(err) {
				_ = tx.Rollback()
				writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "兑换码生成失败"})
				return
			}
		}
		if !inserted {
			_ = tx.Rollback()
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "兑换码生成失败"})
			return
		}
	}
	if err = tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "兑换码生成失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "codes": codes, "expires_at": expiresText})
}

func (s *Server) recognitionAdminImportParticipants(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 2<<20); err != nil || input == nil {
		writeJSON(w, map[string]any{"success": false, "message": "请求数据格式错误"})
		return
	}
	programID := integerValue(input["program_id"])
	usernames := stringSlice(input["usernames"], 2000)
	if len(usernames) == 0 {
		raw := strings.TrimPrefix(stringValue(input["csv"]), "\ufeff")
		for _, token := range strings.FieldsFunc(raw, func(r rune) bool { return r == '\n' || r == '\r' || r == ',' }) {
			if token = strings.Trim(token, " \t\"'"); token != "" {
				usernames = append(usernames, token)
			}
		}
	}
	if len(usernames) == 0 {
		writeJSON(w, map[string]any{"success": false, "message": "请提供参与名单（用户名列表或 CSV 文本）"})
		return
	}
	if len(usernames) > 2000 {
		writeJSON(w, map[string]any{"success": false, "message": "单次导入最多 2000 人"})
		return
	}
	program, err := s.recognitionProgram(r.Context(), programID)
	if err != nil || program == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "项目不存在"})
		return
	}
	if program.Type != "activity" && program.Type != "award" {
		writeJSON(w, map[string]any{"success": false, "message": "名单导入仅支持 activity / award 类型项目"})
		return
	}
	if !s.recognitionCanIssue(r.Context(), user, program.ClubID, program.Country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权为该项目导入名单"})
		return
	}
	version, err := s.recognitionVersion(r.Context(), programID, false)
	if err != nil || version == nil {
		writeJSON(w, map[string]any{"success": false, "message": "该项目尚无已发布版本"})
		return
	}
	content, _ := version["content"].(map[string]any)
	rules, _ := content["rules"].(map[string]any)
	award, _ := rules["award"].(map[string]any)
	badgeID := integerValue(award["badge_id"])
	if badgeID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "项目未配置奖励徽章"})
		return
	}
	imported, skipped := 0, []string{}
	for _, username := range usernames {
		target, targetErr := s.findUserByLogin(r.Context(), username)
		if targetErr != nil || target == nil {
			skipped = append(skipped, username+"（账号不存在）")
			continue
		}
		_, _ = recordRecognitionEventExec(r.Context(), s.db, map[string]any{"type": "activity.attended", "idempotency_key": "import_" + strconvInt(integerValue(version["id"])) + "_" + strconvInt(target.ID), "club_id": program.ClubID, "country": program.Country, "user_id": target.ID, "program_id": programID, "program_version_id": integerValue(version["id"]), "badge_id": badgeID, "data": map[string]any{"imported_by": user.ID}, "source_verified": true})
		_, duplicate, issueErr := s.issueRecognitionCredential(r.Context(), recognitionIssueArgs{HolderUserID: target.ID, BadgeID: badgeID, IssuerClubID: program.ClubID, IssuerCountry: program.Country, ProgramID: programID, ProgramVersionID: integerValue(version["id"]), CredentialType: "participation", VerificationLevel: "batch_import", Conditions: []any{"活动参与名单批量导入"}, SourceType: "batch_import", ActorUserID: user.ID})
		if issueErr != nil {
			skipped = append(skipped, username)
		} else if duplicate {
			skipped = append(skipped, username+"（已持有）")
		} else {
			imported++
		}
	}
	shown := skipped
	if len(shown) > 50 {
		shown = shown[:50]
	}
	writeJSON(w, map[string]any{"success": true, "imported": imported, "skipped": shown, "skipped_total": len(skipped)})
}

func (s *Server) recognitionAdminClaimList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	programID := parsePositiveInt(r.URL.Query().Get("program_id"))
	program, err := s.recognitionProgram(r.Context(), programID)
	if err != nil || program == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "项目不存在"})
		return
	}
	if !s.recognitionCanIssue(r.Context(), user, program.ClubID, program.Country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	rows, err := s.db.QueryContext(r.Context(), "SELECT code,redeemed_by,redeemed_at,expires_at FROM recognition_claim_codes WHERE program_id=? ORDER BY id DESC LIMIT 1000", programID)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取兑换码失败"})
		return
	}
	defer rows.Close()
	codes := []map[string]any{}
	redeemed := 0
	for rows.Next() {
		var code string
		var redeemedBy sql.NullInt64
		var redeemedAt, expiresAt sql.NullString
		if rows.Scan(&code, &redeemedBy, &redeemedAt, &expiresAt) != nil {
			continue
		}
		if redeemedBy.Valid {
			redeemed++
		}
		codes = append(codes, map[string]any{"code": code, "redeemed_by": nullableInt(redeemedBy), "redeemed_at": recognitionNull(redeemedAt), "expires_at": recognitionNull(expiresAt)})
	}
	writeJSON(w, map[string]any{"success": true, "total": len(codes), "redeemed": redeemed, "codes": codes})
}

func newRecognitionClaimCode() (string, error) {
	result := make([]byte, 10)
	raw := make([]byte, 10)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	for index, value := range raw {
		result[index] = recognitionClaimAlphabet[int(value)%len(recognitionClaimAlphabet)]
	}
	return string(result), nil
}
