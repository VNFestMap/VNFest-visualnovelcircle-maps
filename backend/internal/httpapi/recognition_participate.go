package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	mathrand "math/rand"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

var recognitionSubmissionImagePath = regexp.MustCompile(`^data/submission_images/[A-Za-z0-9_.-]+\.(?i:jpe?g|png|gif|webp)$`)

func (s *Server) recognitionParticipate(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action"))) {
	case "start":
		s.recognitionStart(w, r)
	case "temp_save":
		s.recognitionTempSave(w, r)
	case "submit":
		s.recognitionSubmit(w, r)
	case "redeem":
		s.recognitionRedeem(w, r)
	case "submit_work":
		s.recognitionSubmitWork(w, r)
	case "status":
		s.recognitionParticipationStatus(w, r)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知操作"})
	}
}

func (s *Server) recognitionStart(w http.ResponseWriter, r *http.Request) {
	if !allowRequest(r, "recog_start", 30, time.Minute) {
		rateLimited(w)
		return
	}
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
	program, version, errMsg := s.recognitionOpenVersion(r.Context(), programID)
	if errMsg != "" {
		writeJSON(w, map[string]any{"success": false, "message": errMsg})
		return
	}
	content, _ := version["content"].(map[string]any)
	quiz, _ := content["quiz"].(map[string]any)
	if len(anySlice(quiz["questions"])) == 0 {
		writeJSON(w, map[string]any{"success": false, "message": "该项目不是答题类考核"})
		return
	}
	versionID := integerValue(version["id"])
	var ongoingID int64
	var savedAnswers, startedAt sql.NullString
	if err := s.db.QueryRowContext(r.Context(), `SELECT id,answers,started_at FROM recognition_attempts WHERE program_version_id=? AND user_id=? AND status='in_progress' ORDER BY id DESC LIMIT 1`, versionID, user.ID).Scan(&ongoingID, &savedAnswers, &startedAt); err == nil {
		saved := map[string]any{}
		_ = json.Unmarshal([]byte(savedAnswers.String), &saved)
		paper := anySlice(saved["quiz_paper"])
		if len(paper) == 0 {
			paper = recognitionBuildPaper(content)
		}
		settings := recognitionQuizSettings(quiz)
		writeJSON(w, map[string]any{"success": true, "attempt_id": ongoingID, "questions": paper, "settings": settings, "deadline": recognitionQuizDeadline(settings, startedAt.String), "saved_answers": anyMapSlice(saved["answers"]), "resumed": true})
		return
	}
	var used int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM recognition_attempts WHERE program_version_id=? AND user_id=?", versionID, user.ID).Scan(&used); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取答题记录失败"})
		return
	}
	if program.MaxAttempts > 0 && used >= program.MaxAttempts {
		writeJSON(w, map[string]any{"success": false, "message": fmt.Sprintf("已达最大尝试次数（%d 次）", program.MaxAttempts)})
		return
	}
	if program.Cooldown > 0 {
		var finished sql.NullString
		if err := s.db.QueryRowContext(r.Context(), "SELECT finished_at FROM recognition_attempts WHERE program_version_id=? AND user_id=? AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1", versionID, user.ID).Scan(&finished); err == nil {
			if last, ok := recognitionParseTime(finished); ok {
				wait := time.Until(last.Add(time.Duration(program.Cooldown) * time.Minute))
				if wait > 0 {
					writeJSON(w, map[string]any{"success": false, "message": fmt.Sprintf("冷却中，请 %d 分钟后再试", int(math.Ceil(wait.Minutes())))})
					return
				}
			}
		}
	}
	paper := recognitionBuildPaper(content)
	started := time.Now()
	saved := jsonString(map[string]any{"quiz_paper": paper})
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "开始答题失败"})
		return
	}
	result, err := tx.ExecContext(r.Context(), "INSERT INTO recognition_attempts(program_version_id,user_id,status,attempt_no,started_at,answers) VALUES(?,?,?,?,?,?)", versionID, user.ID, "in_progress", used+1, started.Format("2006-01-02 15:04:05"), saved)
	if err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "开始答题失败"})
		return
	}
	attemptID, _ := result.LastInsertId()
	if _, err := recordRecognitionEventExec(r.Context(), tx, map[string]any{"type": "assessment.started", "idempotency_key": "attempt_start_" + strconvInt(attemptID), "club_id": program.ClubID, "country": program.Country, "user_id": user.ID, "program_id": program.ID, "program_version_id": versionID, "source_verified": true}); err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "开始答题失败"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "开始答题失败"})
		return
	}
	settings := recognitionQuizSettings(quiz)
	writeJSON(w, map[string]any{"success": true, "attempt_id": attemptID, "questions": paper, "settings": settings, "deadline": recognitionQuizDeadline(settings, started.Format("2006-01-02 15:04:05"))})
}

func (s *Server) recognitionTempSave(w http.ResponseWriter, r *http.Request) {
	if !allowRequest(r, "recog_temp_save", 20, time.Minute) {
		rateLimited(w)
		return
	}
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
	attemptID := integerValue(input["attempt_id"])
	answers := input["answers"]
	if len(anySlice(answers)) > 500 {
		writeJSON(w, map[string]any{"success": false, "message": "暂存内容非法"})
		return
	}
	var owner int64
	var statusValue string
	var savedText sql.NullString
	if err := s.db.QueryRowContext(r.Context(), "SELECT user_id,status,answers FROM recognition_attempts WHERE id=?", attemptID).Scan(&owner, &statusValue, &savedText); err != nil || owner != user.ID {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "答题记录不存在"})
		return
	}
	if statusValue != "in_progress" {
		writeJSON(w, map[string]any{"success": false, "message": "该次答题已结束"})
		return
	}
	saved := map[string]any{}
	_ = json.Unmarshal([]byte(savedText.String), &saved)
	saved["answers"] = answers
	if _, err := s.db.ExecContext(r.Context(), "UPDATE recognition_attempts SET answers=? WHERE id=? AND user_id=? AND status='in_progress'", jsonString(saved), attemptID, user.ID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "暂存失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true})
}

func (s *Server) recognitionSubmit(w http.ResponseWriter, r *http.Request) {
	if !allowRequest(r, "recog_submit", 30, time.Minute) {
		rateLimited(w)
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
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
	attemptID := integerValue(input["attempt_id"])
	var owner, versionID, attemptNo int64
	var status, startedAt, savedText string
	if err := s.db.QueryRowContext(r.Context(), "SELECT user_id,program_version_id,attempt_no,status,started_at,COALESCE(answers,'') FROM recognition_attempts WHERE id=?", attemptID).Scan(&owner, &versionID, &attemptNo, &status, &startedAt, &savedText); err != nil || owner != user.ID {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "答题记录不存在"})
		return
	}
	if status != "in_progress" {
		writeJSON(w, map[string]any{"success": false, "message": "该次答题已结束"})
		return
	}
	version, err := s.recognitionVersionByID(r.Context(), versionID)
	if err != nil || version == nil || stringValue(version["status"]) != "published" {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "项目版本不存在"})
		return
	}
	content, _ := version["content"].(map[string]any)
	quiz, _ := content["quiz"].(map[string]any)
	settings := recognitionQuizSettings(quiz)
	saved := map[string]any{}
	_ = json.Unmarshal([]byte(savedText), &saved)
	paperSnapshot := anySlice(saved["quiz_paper"])
	questions := anySlice(quiz["questions"])
	if len(paperSnapshot) > 0 {
		picked := []any{}
		for _, item := range paperSnapshot {
			row, _ := item.(map[string]any)
			orig := int(integerValue(row["orig"]))
			if orig >= 0 && orig < len(questions) {
				picked = append(picked, questions[orig])
			}
		}
		if len(picked) > 0 {
			questions = picked
		}
	}
	originalAnswers := recognitionOriginalAnswers(input["answers"], input["paper"])
	grade := recognitionGradeQuestions(questions, originalAnswers, settings)
	deadline := recognitionQuizDeadline(settings, startedAt)
	overdue := deadline > 0 && time.Now().Unix() > deadline+60
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "提交失败"})
		return
	}
	if _, err = tx.ExecContext(r.Context(), "UPDATE recognition_attempts SET status='submitted',score=?,answers=?,finished_at=CURRENT_TIMESTAMP WHERE id=? AND status='in_progress'", grade["score"], jsonString(originalAnswers), attemptID); err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "提交失败"})
		return
	}
	if _, err = recordRecognitionEventExec(r.Context(), tx, map[string]any{"type": "assessment.completed", "idempotency_key": "attempt_done_" + strconvInt(attemptID), "user_id": user.ID, "program_id": integerValue(version["program_id"]), "program_version_id": versionID, "data": map[string]any{"score": grade["score"], "attempt_id": attemptID}, "source_verified": true}); err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "提交失败"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "提交失败"})
		return
	}
	award := map[string]any{"passed": false, "issued": false, "duplicate": false, "credential": nil, "reasons": []string{}, "error": nil}
	if !overdue {
		award = s.recognitionEvaluateAndAward(r.Context(), versionID, user.ID, map[string]any{"score": grade["score"], "source": "site"})
	}
	passed := boolValue(award["passed"])
	if _, err = recordRecognitionEventExec(r.Context(), s.db, map[string]any{"type": map[bool]string{true: "assessment.passed", false: "assessment.failed"}[passed], "idempotency_key": "attempt_result_" + strconvInt(attemptID), "user_id": user.ID, "program_id": integerValue(version["program_id"]), "program_version_id": versionID, "data": map[string]any{"score": grade["score"]}, "source_verified": true}); err != nil {
		// The attempt is already durable. Keep the response usable and leave the
		// event retryable in the outbox/replay tooling rather than changing score.
	}
	finalStatus := "failed"
	if passed {
		finalStatus = "passed"
	}
	_, _ = s.db.ExecContext(r.Context(), "UPDATE recognition_attempts SET status=? WHERE id=? AND status='submitted'", finalStatus, attemptID)
	if stringValue(settings["result_mode"]) == "hidden" {
		writeJSON(w, map[string]any{"success": true, "mode": "hidden", "message": "已提交，结果请稍后在考核详情页查看"})
		return
	}
	result := map[string]any{"success": true, "mode": settings["result_mode"], "passed": passed, "issued": boolValue(award["issued"]), "already_held": boolValue(award["duplicate"]), "credential": award["credential"]}
	if stringValue(settings["result_mode"]) == "immediate" {
		result["score"], result["detail"], result["reasons"] = grade["score"], grade["detail"], award["reasons"]
	}
	if overdue {
		result["message"] = "已超出考试限时，本次作答不计通过"
	} else if message := stringValue(award["error"]); message != "" {
		result["message"] = message
	} else if passed {
		result["message"] = "恭喜，考核通过"
	} else {
		result["message"] = "未满足通过条件，可再次尝试"
	}
	writeJSON(w, result)
}

func (s *Server) recognitionRedeem(w http.ResponseWriter, r *http.Request) {
	if !allowRequest(r, "recog_redeem", 30, time.Minute) {
		rateLimited(w)
		return
	}
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
	code := strings.ToUpper(strings.TrimSpace(stringValue(input["code"])))
	if code == "" || len(code) > 32 {
		writeJSON(w, map[string]any{"success": false, "message": "请输入兑换码"})
		return
	}
	var claimID, programID, versionID, badgeID int64
	var redeemedBy sql.NullInt64
	var expiresAt sql.NullString
	if err := s.db.QueryRowContext(r.Context(), "SELECT id,program_id,program_version_id,badge_id,redeemed_by,expires_at FROM recognition_claim_codes WHERE code=?", code).Scan(&claimID, &programID, &versionID, &badgeID, &redeemedBy, &expiresAt); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "兑换码无效"})
		return
	}
	if redeemedBy.Valid {
		writeJSON(w, map[string]any{"success": false, "message": "兑换码已被使用"})
		return
	}
	if expiresAt.Valid {
		if expiry, ok := recognitionParseTime(expiresAt); ok && time.Now().After(expiry) {
			writeJSON(w, map[string]any{"success": false, "message": "兑换码已过期"})
			return
		}
	}
	program, version, errMsg := s.recognitionOpenVersion(r.Context(), programID)
	if errMsg != "" || integerValue(version["id"]) != versionID {
		writeJSON(w, map[string]any{"success": false, "message": firstNonEmpty(errMsg, "考核版本不可参与")})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "兑换失败"})
		return
	}
	result, err := tx.ExecContext(r.Context(), "UPDATE recognition_claim_codes SET redeemed_by=?,redeemed_at=CURRENT_TIMESTAMP WHERE id=? AND redeemed_by IS NULL", user.ID, claimID)
	if err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "兑换失败"})
		return
	}
	changed, _ := result.RowsAffected()
	if changed == 0 {
		_ = tx.Rollback()
		writeJSON(w, map[string]any{"success": false, "message": "兑换码已被使用"})
		return
	}
	if _, err = recordRecognitionEventExec(r.Context(), tx, map[string]any{"type": "activity.attended", "idempotency_key": "claim_" + code, "club_id": program.ClubID, "country": program.Country, "user_id": user.ID, "program_id": programID, "program_version_id": versionID, "badge_id": badgeID, "data": map[string]any{"claim_code": code}, "source_verified": true}); err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "兑换失败"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "兑换失败"})
		return
	}
	award := s.recognitionEvaluateAndAward(r.Context(), versionID, user.ID, map[string]any{"source": "site"})
	writeJSON(w, map[string]any{"success": true, "issued": boolValue(award["issued"]), "already_held": boolValue(award["duplicate"]), "credential": award["credential"], "message": firstNonEmpty(stringValue(award["error"]), map[bool]string{true: "签到成功，凭证已发放", false: "签到已记录"}[boolValue(award["passed"])])})
}

func (s *Server) recognitionSubmitWork(w http.ResponseWriter, r *http.Request) {
	if !allowRequest(r, "recog_submit_work", 20, time.Minute) {
		rateLimited(w)
		return
	}
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
	versionID := integerValue(input["program_version_id"])
	contentText := strings.TrimSpace(stringValue(input["content"]))
	images := []string{}
	for _, item := range anySlice(input["images"]) {
		image := strings.TrimSpace(stringValue(item))
		if image == "" {
			continue
		}
		if len(images) >= 4 || !recognitionSubmissionImagePath.MatchString(image) {
			writeJSON(w, map[string]any{"success": false, "message": "图片地址不合法"})
			return
		}
		images = append(images, image)
	}
	if (contentText == "" && len(images) == 0) || len([]rune(contentText)) > 5000 {
		writeJSON(w, map[string]any{"success": false, "message": "请填写说明或上传图片，文字不超过 5000 字"})
		return
	}
	version, err := s.recognitionVersionByID(r.Context(), versionID)
	if err != nil || version == nil || stringValue(version["status"]) != "published" {
		writeJSON(w, map[string]any{"success": false, "message": "项目版本不存在或未发布"})
		return
	}
	program, err := s.recognitionProgram(r.Context(), integerValue(version["program_id"]))
	if err != nil || program == nil || program.Status != "published" {
		writeJSON(w, map[string]any{"success": false, "message": "考核当前不可参与"})
		return
	}
	var count int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM recognition_credentials WHERE program_version_id=? AND holder_user_id=? AND status='active'", versionID, user.ID).Scan(&count); err == nil && count > 0 {
		writeJSON(w, map[string]any{"success": false, "message": "你已获得该考核的凭证"})
		return
	}
	if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM recognition_submissions WHERE program_version_id=? AND user_id=? AND status='pending'", versionID, user.ID).Scan(&count); err == nil && count > 0 {
		writeJSON(w, map[string]any{"success": false, "message": "你已有一份待审提交，请等待审核结果"})
		return
	}
	stored := contentText
	filePath := ""
	if len(images) > 0 {
		stored = jsonString(map[string]any{"text": contentText, "images": images})
		filePath = strings.Join(images, "|")
	}
	result, err := s.db.ExecContext(r.Context(), "INSERT INTO recognition_submissions(program_version_id,user_id,content,file_path,status) VALUES(?,?,?,?,?)", versionID, user.ID, stored, filePath, "pending")
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "提交失败"})
		return
	}
	submissionID, _ := result.LastInsertId()
	_, _ = recordRecognitionEventExec(r.Context(), s.db, map[string]any{"type": "submission.created", "idempotency_key": "submission_" + strconvInt(submissionID), "club_id": program.ClubID, "country": program.Country, "user_id": user.ID, "program_id": program.ID, "program_version_id": versionID, "data": map[string]any{"submission_id": submissionID}, "source_verified": true})
	writeJSON(w, map[string]any{"success": true, "submission_id": submissionID, "message": "已提交，等待同好会审核"})
}

func (s *Server) recognitionParticipationStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	programID := parsePositiveInt(r.URL.Query().Get("program_id"))
	program, version, errMsg := s.recognitionOpenVersion(r.Context(), programID)
	if errMsg != "" {
		writeJSON(w, map[string]any{"success": false, "message": errMsg})
		return
	}
	versionID := integerValue(version["id"])
	var attempts int64
	_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM recognition_attempts WHERE program_version_id=? AND user_id=?", versionID, user.ID).Scan(&attempts)
	var uid sql.NullString
	_ = s.db.QueryRowContext(r.Context(), "SELECT credential_uid FROM recognition_credentials WHERE program_version_id=? AND holder_user_id=? AND status='active' LIMIT 1", versionID, user.ID).Scan(&uid)
	writeJSON(w, map[string]any{"success": true, "attempts": attempts, "max_attempts": program.MaxAttempts, "credential_uid": recognitionNull(uid)})
}

func (s *Server) recognitionOpenVersion(ctx context.Context, programID int64) (*recognitionProgramRow, map[string]any, string) {
	program, err := s.recognitionProgram(ctx, programID)
	if err != nil || program == nil {
		return nil, nil, "考核不存在"
	}
	if program.Status != "published" {
		return nil, nil, "考核当前不可参与"
	}
	now := time.Now()
	if open, ok := recognitionParseTime(program.OpenAt); ok && now.Before(open) {
		return nil, nil, "考核尚未开放（" + program.OpenAt.String + " 开始）"
	}
	if close, ok := recognitionParseTime(program.CloseAt); ok && now.After(close) {
		return nil, nil, "考核已截止"
	}
	version, err := s.recognitionVersion(ctx, programID, false)
	if err != nil || version == nil {
		return nil, nil, "考核暂无已发布版本"
	}
	return program, version, ""
}

func (s *Server) recognitionVersionByID(ctx context.Context, versionID int64) (map[string]any, error) {
	var id, programID int64
	var versionNo, status, snapshot string
	var created, published sql.NullString
	err := s.db.QueryRowContext(ctx, "SELECT id,program_id,version_no,status,content_snapshot,created_at,published_at FROM recognition_program_versions WHERE id=?", versionID).Scan(&id, &programID, &versionNo, &status, &snapshot, &created, &published)
	if err != nil {
		return nil, err
	}
	content := map[string]any{}
	_ = json.Unmarshal([]byte(snapshot), &content)
	return map[string]any{"id": id, "program_id": programID, "version_no": versionNo, "status": status, "content": content, "created_at": recognitionNull(created), "published_at": recognitionNull(published)}, nil
}

func recognitionQuizSettings(quiz map[string]any) map[string]any {
	settings, _ := quiz["settings"].(map[string]any)
	if settings == nil {
		settings = map[string]any{}
	}
	resultMode := stringValue(settings["result_mode"])
	if resultMode != "immediate" && resultMode != "pass_only" && resultMode != "hidden" {
		resultMode = "immediate"
	}
	timeLimit := integerValue(settings["time_limit"])
	if timeLimit < 0 {
		timeLimit = 0
	}
	if timeLimit > 180 {
		timeLimit = 180
	}
	pick := integerValue(settings["pick_count"])
	if pick < 0 {
		pick = 0
	}
	return map[string]any{"shuffle": boolValueOr(settings["shuffle"], boolValue(quiz["shuffle"])), "shuffle_options": boolValue(settings["shuffle_options"]), "pick_count": pick, "time_limit": timeLimit, "multiple_partial": boolValue(settings["multiple_partial"]), "result_mode": resultMode}
}

func recognitionBuildPaper(content map[string]any) []any {
	quiz, _ := content["quiz"].(map[string]any)
	questions := anySlice(quiz["questions"])
	if len(questions) == 0 {
		return []any{}
	}
	settings := recognitionQuizSettings(quiz)
	indexes := make([]int, len(questions))
	for index := range indexes {
		indexes[index] = index
	}
	random := mathrand.New(mathrand.NewSource(time.Now().UnixNano()))
	pick := int(integerValue(settings["pick_count"]))
	if pick > 0 && pick < len(indexes) {
		random.Shuffle(len(indexes), func(i, j int) { indexes[i], indexes[j] = indexes[j], indexes[i] })
		indexes = indexes[:pick]
		if !boolValue(settings["shuffle"]) {
			sort.Ints(indexes)
		}
	}
	if boolValue(settings["shuffle"]) {
		random.Shuffle(len(indexes), func(i, j int) { indexes[i], indexes[j] = indexes[j], indexes[i] })
	}
	paper := make([]any, 0, len(indexes))
	for sequence, original := range indexes {
		question, _ := questions[original].(map[string]any)
		kind := stringValue(question["type"])
		options := []any{}
		for optionIndex, raw := range anySlice(question["options"]) {
			options = append(options, map[string]any{"text": stringValue(raw), "oi": optionIndex})
		}
		optionIndexes := make([]int, len(options))
		for i := range optionIndexes {
			optionIndexes[i] = i
		}
		if (kind == "order" || (boolValue(settings["shuffle_options"]) && (kind == "single" || kind == "multiple" || kind == "judge"))) && len(optionIndexes) > 1 {
			random.Shuffle(len(optionIndexes), func(i, j int) { optionIndexes[i], optionIndexes[j] = optionIndexes[j], optionIndexes[i] })
		}
		orderedOptions := make([]any, 0, len(optionIndexes))
		for _, index := range optionIndexes {
			orderedOptions = append(orderedOptions, options[index])
		}
		item := map[string]any{"seq": sequence, "orig": original, "type": kind, "question": stringValue(question["question"]), "options": orderedOptions, "points": maxInt64(integerValue(question["points"]), 1), "explanation": stringValue(question["explanation"])}
		if image := stringValue(question["image"]); image != "" {
			item["image"] = image
		}
		if optionImages := anySlice(question["option_images"]); len(optionImages) > 0 {
			item["option_images"] = optionImages
		}
		if kind == "fill_multi" {
			item["blanks"] = len(anySlice(question["answer_texts"]))
		}
		paper = append(paper, item)
	}
	return paper
}

func recognitionOriginalAnswers(value, paperValue any) map[string]any {
	answers := map[string]any{}
	if input, ok := value.(map[string]any); ok {
		for key, answer := range input {
			answers[key] = answer
		}
	} else if list := anySlice(value); len(list) > 0 {
		for index, answer := range list {
			answers[fmt.Sprint(index)] = answer
		}
	}
	for _, item := range anySlice(paperValue) {
		row, _ := item.(map[string]any)
		orig, seq := strconvInt(integerValue(row["orig"])), fmt.Sprint(integerValue(row["seq"]))
		if answer, exists := answers[seq]; exists {
			answers[orig] = answer
			delete(answers, seq)
		}
	}
	return answers
}

func recognitionGradeQuestions(questions []any, answers map[string]any, settings map[string]any) map[string]any {
	score := 0.0
	total := 0
	detail := make([]any, 0, len(questions))
	for index, raw := range questions {
		question, _ := raw.(map[string]any)
		points := int(maxInt64(integerValue(question["points"]), 1))
		total += points
		given := answers[fmt.Sprint(index)]
		if given == nil {
			given = answers[fmt.Sprint(index)]
		}
		correct, earned := false, 0.0
		switch stringValue(question["type"]) {
		case "single", "judge":
			expected := intAt(anySlice(question["answer"]), 0)
			correct = given != nil && integerValue(given) == int64(expected)
			if correct {
				earned = float64(points)
			}
		case "multiple":
			expected := intList(question["answer"])
			givenList := intList(given)
			if len(expected) > 0 {
				if boolValue(settings["multiple_partial"]) {
					hit, miss := intersectionCount(givenList, expected), differenceCount(givenList, expected)
					earned = math.Max(0, float64(hit-miss)) / float64(len(expected)) * float64(points)
					correct = hit == len(expected) && miss == 0
				} else {
					a, b := append([]int{}, expected...), append([]int{}, givenList...)
					sort.Ints(a)
					sort.Ints(b)
					correct = fmt.Sprint(a) == fmt.Sprint(b)
					if correct {
						earned = float64(points)
					}
				}
			}
		case "fill_blank":
			correct = strings.EqualFold(strings.TrimSpace(stringValue(given)), strings.TrimSpace(stringValue(question["answer_text"]))) && strings.TrimSpace(stringValue(question["answer_text"])) != ""
			if correct {
				earned = float64(points)
			}
		case "order":
			givenList := intList(given)
			totalOptions := len(anySlice(question["options"]))
			hits := 0
			for position := 0; position < totalOptions; position++ {
				if position < len(givenList) && givenList[position] == position {
					hits++
				}
			}
			correct = totalOptions > 0 && hits == totalOptions
			if totalOptions > 0 {
				earned = math.Round(float64(points*hits)*10/float64(totalOptions)) / 10
			}
		case "fill_multi":
			expected := stringList(question["answer_texts"])
			givenList := stringList(given)
			hits := 0
			for position, expectedValue := range expected {
				if position < len(givenList) && strings.EqualFold(strings.TrimSpace(expectedValue), strings.TrimSpace(givenList[position])) && strings.TrimSpace(expectedValue) != "" {
					hits++
				}
			}
			correct = len(expected) > 0 && hits == len(expected)
			if len(expected) > 0 {
				earned = math.Round(float64(points*hits)*10/float64(len(expected))) / 10
			}
		}
		score += earned
		detail = append(detail, map[string]any{"correct": correct, "earned": math.Round(earned*10) / 10, "explanation": stringValue(question["explanation"])})
	}
	return map[string]any{"score": int(math.Round(score)), "raw": math.Round(score*10) / 10, "total": total, "detail": detail}
}

func (s *Server) recognitionEvaluateAndAward(ctx context.Context, versionID, userID int64, values map[string]any) map[string]any {
	result := map[string]any{"passed": false, "issued": false, "duplicate": false, "credential": nil, "reasons": []string{}, "error": nil}
	version, err := s.recognitionVersionByID(ctx, versionID)
	if err != nil || version == nil || stringValue(version["status"]) != "published" {
		result["error"] = "项目版本不存在或未发布"
		return result
	}
	content, _ := version["content"].(map[string]any)
	rules, _ := content["rules"].(map[string]any)
	program, err := s.recognitionProgram(ctx, integerValue(version["program_id"]))
	if err != nil || program == nil || (program.Status != "published" && program.Status != "paused") {
		result["error"] = "认可项目当前不可参与"
		return result
	}
	contextValues := map[string]any{"user_id": userID, "program_version_id": versionID, "score": nil, "submission_status": nil, "reviewer_count": 0, "source": "site"}
	for key, value := range values {
		contextValues[key] = value
	}
	passed, reasons := s.recognitionEvaluateRules(ctx, rules, contextValues)
	result["passed"], result["reasons"] = passed, reasons
	if !passed {
		return result
	}
	award, _ := rules["award"].(map[string]any)
	badgeID := integerValue(award["badge_id"])
	if badgeID <= 0 {
		badgeID = integerValue(content["badge_id"])
	}
	if badgeID <= 0 {
		result["error"] = "项目未配置奖励徽章"
		return result
	}
	credential, duplicate, err := s.issueRecognitionCredential(ctx, recognitionIssueArgs{HolderUserID: userID, BadgeID: badgeID, IssuerClubID: program.ClubID, IssuerCountry: program.Country, ProgramID: program.ID, ProgramVersionID: versionID, CredentialType: map[bool]string{true: "knowledge", false: "participation"}[program.Type == "assessment"], VerificationLevel: firstNonEmpty(stringValue(award["verification_level"]), "auto"), Conditions: stringAnySlice(reasons), SourceType: map[bool]string{true: "auto_rule", false: "external_event"}[stringValue(contextValues["source"]) == "site"]})
	if err != nil {
		result["error"] = err.Error()
		return result
	}
	result["issued"], result["duplicate"], result["credential"] = !duplicate, duplicate, credential
	return result
}

func (s *Server) recognitionEvaluateRules(ctx context.Context, ruleSet map[string]any, values map[string]any) (bool, []string) {
	conditions := anySlice(ruleSet["conditions"])
	if len(conditions) == 0 {
		return true, []string{}
	}
	logic := firstNonEmpty(stringValue(ruleSet["logic"]), "all")
	reasons := []string{}
	for _, raw := range conditions {
		condition, _ := raw.(map[string]any)
		matched := s.recognitionEvaluateCondition(ctx, condition, values)
		reasons = append(reasons, recognitionDescribeCondition(condition)+map[bool]string{true: "：满足", false: "：不满足"}[matched])
		if logic == "all" && !matched {
			return false, reasons
		}
		if logic == "any" && matched {
			return true, reasons
		}
	}
	return logic == "all", reasons
}

func (s *Server) recognitionEvaluateCondition(ctx context.Context, condition map[string]any, values map[string]any) bool {
	switch stringValue(condition["op"]) {
	case "score_gte":
		return values["score"] != nil && floatValue(values["score"]) >= floatValue(condition["value"])
	case "eq":
		return fmt.Sprint(values[stringValue(condition["field"])]) == fmt.Sprint(condition["value"])
	case "gte":
		return floatValue(values[stringValue(condition["field"])]) >= floatValue(condition["value"])
	case "lte":
		value := values[stringValue(condition["field"])]
		if value == nil {
			return false
		}
		return floatValue(value) <= floatValue(condition["value"])
	case "contains":
		for _, value := range anySlice(values[stringValue(condition["field"])]) {
			if fmt.Sprint(value) == fmt.Sprint(condition["value"]) {
				return true
			}
		}
		return false
	case "all_of":
		for _, item := range anySlice(condition["conditions"]) {
			row, _ := item.(map[string]any)
			if !s.recognitionEvaluateCondition(ctx, row, values) {
				return false
			}
		}
		return true
	case "any_of":
		for _, item := range anySlice(condition["conditions"]) {
			row, _ := item.(map[string]any)
			if s.recognitionEvaluateCondition(ctx, row, values) {
				return true
			}
		}
		return false
	case "time_window":
		now := time.Now()
		if start, ok := recognitionParseTimeString(stringValue(condition["start"])); ok && now.Before(start) {
			return false
		}
		if end, ok := recognitionParseTimeString(stringValue(condition["end"])); ok && now.After(end) {
			return false
		}
		return true
	case "event_count_gte":
		var count int64
		if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM recognition_events WHERE user_id=? AND program_version_id=? AND type=?", integerValue(values["user_id"]), integerValue(values["program_version_id"]), stringValue(condition["event_type"])).Scan(&count); err != nil {
			return false
		}
		return count >= maxInt64(integerValue(condition["value"]), 1)
	case "prerequisite_badge":
		var id int64
		return s.db.QueryRowContext(ctx, "SELECT id FROM recognition_credentials WHERE holder_user_id=? AND badge_id=? AND status='active' LIMIT 1", integerValue(values["user_id"]), integerValue(condition["badge_id"])).Scan(&id) == nil
	case "reviewer_count_gte":
		return integerValue(values["reviewer_count"]) >= maxInt64(integerValue(condition["value"]), 1)
	case "submission_approved":
		return stringValue(values["submission_status"]) == "approved"
	case "source_is":
		return stringValue(values["source"]) == stringValue(condition["value"])
	default:
		return false
	}
}

func floatValue(value any) float64 {
	switch item := value.(type) {
	case float64:
		return item
	case float32:
		return float64(item)
	case int:
		return float64(item)
	case int64:
		return float64(item)
	case json.Number:
		result, _ := item.Float64()
		return result
	case string:
		var result float64
		_, _ = fmt.Sscan(item, &result)
		return result
	default:
		return 0
	}
}

func recognitionDescribeCondition(condition map[string]any) string {
	value := recognitionValueString(condition["value"])
	switch stringValue(condition["op"]) {
	case "score_gte":
		return "得分 ≥ " + value
	case "eq":
		return stringValue(condition["field"]) + " = " + value
	case "gte":
		return stringValue(condition["field"]) + " ≥ " + value
	case "lte":
		return stringValue(condition["field"]) + " ≤ " + value
	case "contains":
		return stringValue(condition["field"]) + " 包含 " + value
	case "all_of":
		return fmt.Sprintf("同时满足 %d 项条件", len(anySlice(condition["conditions"])))
	case "any_of":
		return fmt.Sprintf("满足任意 %d 项条件之一", len(anySlice(condition["conditions"])))
	case "time_window":
		return "在时间窗口内（" + firstNonEmpty(stringValue(condition["start"]), "-") + " ~ " + firstNonEmpty(stringValue(condition["end"]), "-") + "）"
	case "event_count_gte":
		return stringValue(condition["event_type"]) + " 累计 ≥ " + firstNonEmpty(value, "1") + " 次"
	case "prerequisite_badge":
		return "已拥有前置徽章 #" + recognitionValueString(condition["badge_id"])
	case "reviewer_count_gte":
		return "审核人数 ≥ " + firstNonEmpty(value, "1")
	case "submission_approved":
		return "提交已通过审核"
	case "source_is":
		return "事件来源为 " + value
	default:
		return "未知条件"
	}
}

func recognitionValueString(value any) string {
	if value == nil {
		return ""
	}
	if text := stringValue(value); text != "" {
		return text
	}
	return fmt.Sprint(value)
}

func recognitionParseTime(value sql.NullString) (time.Time, bool) {
	if !value.Valid {
		return time.Time{}, false
	}
	return recognitionParseTimeString(value.String)
}

func recognitionParseTimeString(value string) (time.Time, bool) {
	value = strings.TrimSpace(value)
	for _, layout := range []string{"2006-01-02 15:04:05", time.RFC3339, "2006-01-02"} {
		if parsed, err := time.ParseInLocation(layout, value, time.Local); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func recognitionQuizDeadline(settings map[string]any, startedAt string) int64 {
	minutes := integerValue(settings["time_limit"])
	if minutes <= 0 {
		return 0
	}
	started, ok := recognitionParseTimeString(startedAt)
	if !ok {
		return 0
	}
	return started.Add(time.Duration(minutes) * time.Minute).Unix()
}

func boolValueOr(value any, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return boolValue(value)
}

func anyMapSlice(value any) map[string]any {
	if result, ok := value.(map[string]any); ok {
		return result
	}
	return map[string]any{}
}

func intAt(values []any, index int) int {
	if index >= 0 && index < len(values) {
		return int(integerValue(values[index]))
	}
	return 0
}

func intList(value any) []int {
	result := []int{}
	for _, item := range anySlice(value) {
		result = append(result, int(integerValue(item)))
	}
	return result
}

func stringList(value any) []string {
	result := []string{}
	for _, item := range anySlice(value) {
		result = append(result, stringValue(item))
	}
	return result
}

func stringAnySlice(values []string) []any {
	result := make([]any, 0, len(values))
	for _, value := range values {
		result = append(result, value)
	}
	return result
}

func intersectionCount(left, right []int) int {
	set := map[int]bool{}
	for _, value := range right {
		set[value] = true
	}
	count := 0
	for _, value := range left {
		if set[value] {
			count++
		}
	}
	return count
}

func differenceCount(left, right []int) int {
	set := map[int]bool{}
	for _, value := range right {
		set[value] = true
	}
	count := 0
	for _, value := range left {
		if !set[value] {
			count++
		}
	}
	return count
}
