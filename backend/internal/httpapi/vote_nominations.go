package httpapi

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// voteNominations keeps the old vote_nominations.php contract while using the
// shared SQL tables.  The endpoint deliberately does not expose the legacy
// PHP implementation: it is safe to switch the edge only after this handler
// and its contract tests are green.
func (s *Server) voteNominations(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	if (action == "submit" || action == "nominate") && !allowRequest(r, "vote_nominate", 12, 60*time.Second) {
		rateLimited(w)
		return
	}
	switch action {
	case "list":
		s.voteNominationList(w, r)
	case "submit", "nominate":
		s.voteNominationSubmit(w, r)
	case "my", "my_nominations":
		s.voteNominationMine(w, r)
	case "nomination_summary":
		s.voteNominationSummary(w, r)
	case "withdraw", "withdraw_nomination":
		s.voteNominationWithdraw(w, r)
	case "approve", "reject":
		s.voteNominationReview(w, r, action)
	case "remove", "restore":
		s.voteNominationRemoveRestore(w, r, action)
	case "create", "import":
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请使用 action=submit 提交提名"})
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知 action=" + action})
	}
}

func (s *Server) voteNominationList(w http.ResponseWriter, r *http.Request) {
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
	where := []string{"project_id=?"}
	args := []any{project.ID}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	manage := s.voteCanManage(r.Context(), viewer, project)
	if status != "" {
		where = append(where, "entry_status=?")
		args = append(args, status)
		if !manage && status != "approved" {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权查看"})
			return
		}
	} else if !manage {
		where = append(where, "entry_status='approved'")
	}
	rows, err := s.db.QueryContext(r.Context(), "SELECT id,project_id,source_type,source_id,title,title_cn,subtitle,image_url,summary,external_url,identity_key,entry_status,created_by,reviewed_by,reviewed_at,created_at,updated_at FROM vote_entries WHERE "+strings.Join(where, " AND ")+" ORDER BY created_at DESC,id DESC", args...)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取提名失败"})
		return
	}
	data, err := scanVoteEntries(rows)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取提名失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "data": data})
}

func (s *Server) voteNominationSubmit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	input := voteReadJSON(r)
	projectID := voteProjectID(input["project_id"], input["contest_id"], r.URL.Query().Get("project_id"), r.URL.Query().Get("contest_id"))
	project, err := s.voteProject(r.Context(), projectID)
	if err == sql.ErrNoRows || project == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "企划不存在"})
		return
	}
	if expected := votePathProjectType(r.URL.Path); expected != "" && expected != project.ProjectType {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "企划不存在"})
		return
	}
	if !s.voteCanParticipate(r.Context(), user, project) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "当前账号不符合提名资格"})
		return
	}
	entry := voteEntryInput(input, project)
	if stringValue(entry["title"]) == "" && stringValue(entry["title_cn"]) == "" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请填写提名名称"})
		return
	}
	stageID, maxNoms, err := s.voteOpenNominationStage(r.Context(), project.ID, integerValue(input["stage_id"]))
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": err.Error()})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "提名暂时不可用"})
		return
	}
	var entryID int64
	var existingStatus string
	err = tx.QueryRowContext(r.Context(), "SELECT id,entry_status FROM vote_entries WHERE project_id=? AND identity_key=?", project.ID, stringValue(entry["identity_key"])).Scan(&entryID, &existingStatus)
	if err == sql.ErrNoRows {
		result, insertErr := tx.ExecContext(r.Context(), "INSERT INTO vote_entries(project_id,source_type,source_id,title,title_cn,subtitle,image_url,summary,external_url,identity_key,entry_status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?, 'approved', ?)", project.ID, stringValue(entry["source_type"]), stringValue(entry["source_id"]), stringValue(entry["title"]), stringValue(entry["title_cn"]), stringValue(entry["subtitle"]), stringValue(entry["image_url"]), stringValue(entry["summary"]), stringValue(entry["external_url"]), stringValue(entry["identity_key"]), user.ID)
		if insertErr == nil {
			entryID, err = result.LastInsertId()
		} else {
			err = insertErr
		}
	} else if err != nil {
		// Keep the original query error for the rollback path below.
	} else if existingStatus == "removed" || existingStatus == "pending" {
		_, err = tx.ExecContext(r.Context(), "UPDATE vote_entries SET entry_status='approved',updated_at=CURRENT_TIMESTAMP WHERE id=?", entryID)
	}
	if err != nil {
		_ = tx.Rollback()
		// A concurrent request may have created the same identity. Treat it as
		// the same idempotent nomination after re-reading it outside the tx.
		if entryID == 0 {
			_ = s.db.QueryRowContext(r.Context(), "SELECT id FROM vote_entries WHERE project_id=? AND identity_key=?", project.ID, stringValue(entry["identity_key"])).Scan(&entryID)
		}
		if entryID == 0 {
			writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "提名保存失败"})
			return
		}
		// Continue with the nomination query in a fresh transaction.
		tx, err = s.db.BeginTx(r.Context(), nil)
		if err != nil {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "提名暂时不可用"})
			return
		}
	}
	var activeCount int64
	var existingNomStatus string
	var nominationID int64
	nomErr := tx.QueryRowContext(r.Context(), "SELECT id,status FROM vote_nominations WHERE project_id=? AND entry_id=? AND user_id=?", project.ID, entryID, user.ID).Scan(&nominationID, &existingNomStatus)
	if nomErr != nil && nomErr != sql.ErrNoRows {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "提名保存失败"})
		return
	}
	if nomErr == sql.ErrNoRows || existingNomStatus != "active" {
		if err = tx.QueryRowContext(r.Context(), "SELECT COUNT(DISTINCT entry_id) FROM vote_nominations WHERE project_id=? AND user_id=? AND status='active'", project.ID, user.ID).Scan(&activeCount); err != nil {
			_ = tx.Rollback()
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "提名保存失败"})
			return
		}
		if activeCount >= maxNoms {
			_ = tx.Rollback()
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "已达到最大提名数（" + strconv.FormatInt(maxNoms, 10) + " 个）"})
			return
		}
	}
	if nomErr == sql.ErrNoRows {
		_, err = tx.ExecContext(r.Context(), "INSERT INTO vote_nominations(project_id,stage_id,entry_id,user_id,status) VALUES(?,?,?,?,'active')", project.ID, stageID, entryID, user.ID)
	} else if existingNomStatus == "withdrawn" {
		_, err = tx.ExecContext(r.Context(), "UPDATE vote_nominations SET status='active',stage_id=?,created_at=CURRENT_TIMESTAMP WHERE id=?", stageID, nominationID)
	}
	if err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "提名保存失败"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "提名保存失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "entry_id": entryID})
}

func (s *Server) voteNominationMine(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	projectID := voteProjectID(r.URL.Query().Get("project_id"), r.URL.Query().Get("contest_id"))
	query := `SELECT n.id,n.project_id,n.stage_id,n.entry_id,n.user_id,n.status,n.created_at,e.title,e.title_cn,e.subtitle,e.image_url,e.entry_status
		FROM vote_nominations n JOIN vote_entries e ON e.id=n.entry_id
		WHERE n.user_id=? AND (?=0 OR n.project_id=?) AND n.status='active' ORDER BY n.created_at DESC`
	rows, err := s.db.QueryContext(r.Context(), query, user.ID, projectID, projectID)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取提名失败"})
		return
	}
	defer rows.Close()
	data := []map[string]any{}
	for rows.Next() {
		var id, pid, stageID, entryID, uid int64
		var status, created, title, titleCN, subtitle, imageURL, entryStatus string
		if err := rows.Scan(&id, &pid, &stageID, &entryID, &uid, &status, &created, &title, &titleCN, &subtitle, &imageURL, &entryStatus); err != nil {
			continue
		}
		data = append(data, map[string]any{"id": id, "project_id": pid, "stage_id": stageID, "entry_id": entryID, "user_id": uid, "status": status, "created_at": created, "title": title, "title_cn": titleCN, "subtitle": subtitle, "image_url": bangumiProxyImageURL(imageURL), "entry_status": entryStatus})
	}
	writeJSON(w, map[string]any{"success": true, "data": data})
}

func (s *Server) voteNominationSummary(w http.ResponseWriter, r *http.Request) {
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
	viewerID, _ := s.optionalSessionUser(r)
	var viewer *user
	if viewerID != nil {
		viewer, _ = s.findUser(r.Context(), *viewerID)
	}
	if !s.voteCanRead(r.Context(), viewer, project) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权查看该企划"})
		return
	}
	rows, err := s.db.QueryContext(r.Context(), "SELECT entry_status,COUNT(*) FROM vote_entries WHERE project_id=? GROUP BY entry_status", projectID)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取统计失败"})
		return
	}
	defer rows.Close()
	summary := map[string]any{"pending": int64(0), "approved": int64(0), "rejected": int64(0)}
	for rows.Next() {
		var status string
		var count int64
		if rows.Scan(&status, &count) == nil {
			summary[status] = count
		}
	}
	writeJSON(w, map[string]any{"success": true, "data": summary})
}

func (s *Server) voteNominationWithdraw(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPost)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	input := voteReadJSON(r)
	entryID := voteProjectID(r.URL.Query().Get("entry_id"), r.URL.Query().Get("id"), stringValue(input["entry_id"]), stringValue(input["id"]))
	if entryID <= 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "缺少 entry_id"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "操作暂时不可用"})
		return
	}
	if _, err = tx.ExecContext(r.Context(), "UPDATE vote_nominations SET status='withdrawn' WHERE entry_id=? AND user_id=?", entryID, user.ID); err == nil {
		var active int64
		err = tx.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM vote_nominations WHERE entry_id=? AND status='active'", entryID).Scan(&active)
		if err == nil && active == 0 {
			_, err = tx.ExecContext(r.Context(), "UPDATE vote_entries SET entry_status='removed' WHERE id=? AND entry_status IN ('pending','approved')", entryID)
			if err == nil {
				_, err = tx.ExecContext(r.Context(), "UPDATE vote_stage_entries SET status='removed' WHERE entry_id=? AND status='active'", entryID)
			}
		}
	}
	if err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "撤回提名失败"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "撤回提名失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true})
}

func (s *Server) voteNominationReview(w http.ResponseWriter, r *http.Request, action string) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPost)
		return
	}
	input := voteReadJSON(r)
	entryID := voteProjectID(r.URL.Query().Get("entry_id"), r.URL.Query().Get("id"), stringValue(input["entry_id"]), stringValue(input["id"]))
	var projectID int64
	var currentStatus string
	if err := s.db.QueryRowContext(r.Context(), "SELECT project_id,entry_status FROM vote_entries WHERE id=?", entryID).Scan(&projectID, &currentStatus); err == sql.ErrNoRows {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "提名不存在"})
		return
	} else if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取提名失败"})
		return
	}
	manager, project, ok := s.voteProjectManager(w, r, projectID)
	if !ok {
		return
	}
	_ = currentStatus
	status := "rejected"
	if action == "approve" {
		status = "approved"
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE vote_entries SET entry_status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?", status, manager.ID, entryID); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "审核提名失败"})
		return
	}
	if status == "rejected" {
		_, _ = s.db.ExecContext(r.Context(), "UPDATE vote_stage_entries SET status='removed' WHERE entry_id=?", entryID)
	}
	_ = project
	writeJSON(w, map[string]any{"success": true, "status": status})
}

func (s *Server) voteNominationRemoveRestore(w http.ResponseWriter, r *http.Request, action string) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPost)
		return
	}
	input := voteReadJSON(r)
	entryID := voteProjectID(r.URL.Query().Get("entry_id"), r.URL.Query().Get("id"), stringValue(input["entry_id"]), stringValue(input["id"]))
	var projectID int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT project_id FROM vote_entries WHERE id=?", entryID).Scan(&projectID); err == sql.ErrNoRows {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "条目不存在"})
		return
	} else if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取条目失败"})
		return
	}
	if _, _, ok := s.voteProjectManager(w, r, projectID); !ok {
		return
	}
	status := "removed"
	if action == "restore" {
		status = "approved"
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err == nil {
		_, err = tx.ExecContext(r.Context(), "UPDATE vote_entries SET entry_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", status, entryID)
		if err == nil && action == "remove" {
			_, err = tx.ExecContext(r.Context(), "UPDATE vote_nominations SET status='withdrawn' WHERE entry_id=?", entryID)
			if err == nil {
				_, err = tx.ExecContext(r.Context(), "UPDATE vote_stage_entries SET status='removed' WHERE entry_id=?", entryID)
			}
		} else if err == nil {
			_, err = tx.ExecContext(r.Context(), "UPDATE vote_nominations SET status='active' WHERE entry_id=?", entryID)
		}
		if err == nil {
			err = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
	}
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "保存条目状态失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "status": status})
}

func (s *Server) voteOpenNominationStage(ctx context.Context, projectID, requested int64) (int64, int64, error) {
	query := "SELECT id,max_select FROM vote_stages WHERE project_id=? AND stage_type='nomination' AND status='open'"
	args := []any{projectID}
	if requested > 0 {
		query += " AND id=?"
		args = append(args, requested)
	} else {
		query += " ORDER BY sort_order ASC LIMIT 2"
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()
	var stageID, maxSelect int64
	count := 0
	for rows.Next() {
		count++
		if count == 1 {
			if err := rows.Scan(&stageID, &maxSelect); err != nil {
				return 0, 0, err
			}
		}
	}
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}
	if count != 1 {
		return 0, 0, fmt.Errorf("当前企划没有唯一开放的提名阶段")
	}
	if maxSelect < 1 {
		maxSelect = 1
	}
	return stageID, maxSelect, nil
}

func (s *Server) voteProjectManager(w http.ResponseWriter, r *http.Request, projectID int64) (*user, *voteProjectView, bool) {
	project, err := s.voteProject(r.Context(), projectID)
	if err == sql.ErrNoRows || project == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "企划不存在"})
		return nil, nil, false
	}
	manager, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return nil, nil, false
	}
	if !s.voteCanManage(r.Context(), manager, project) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权管理该企划"})
		return nil, nil, false
	}
	return manager, project, true
}

func scanVoteEntries(rows *sql.Rows) ([]map[string]any, error) {
	defer rows.Close()
	result := []map[string]any{}
	for rows.Next() {
		var id, projectID, createdBy int64
		var reviewedBy sql.NullInt64
		var sourceType, sourceID, title, titleCN, subtitle, imageURL, summary, externalURL, identity, status, reviewedAt, createdAt, updatedAt sql.NullString
		if err := rows.Scan(&id, &projectID, &sourceType, &sourceID, &title, &titleCN, &subtitle, &imageURL, &summary, &externalURL, &identity, &status, &createdBy, &reviewedBy, &reviewedAt, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		row := map[string]any{"id": id, "project_id": projectID, "source_type": sourceType.String, "source_id": sourceID.String, "title": title.String, "title_cn": titleCN.String, "subtitle": subtitle.String, "image_url": bangumiProxyImageURL(imageURL.String), "summary": summary.String, "external_url": externalURL.String, "identity_key": identity.String, "entry_status": status.String, "created_by": createdBy, "reviewed_by": nil, "reviewed_at": nil, "created_at": createdAt.String, "updated_at": updatedAt.String}
		if reviewedBy.Valid {
			row["reviewed_by"] = reviewedBy.Int64
		}
		if reviewedAt.Valid {
			row["reviewed_at"] = reviewedAt.String
		}
		result = append(result, row)
	}
	return result, rows.Err()
}
