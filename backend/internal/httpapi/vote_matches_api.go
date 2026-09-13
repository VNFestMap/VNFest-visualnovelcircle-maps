package httpapi

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
)

func (s *Server) voteMatches(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	switch action {
	case "list", "contest_bracket":
		s.voteMatchList(w, r)
	case "generate":
		s.voteMatchGenerate(w, r)
	case "update", "open", "lock", "settle":
		s.voteMatchUpdate(w, r, action)
	case "settle_by_votes":
		s.voteMatchSettleByVotes(w, r)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知 action=" + action})
	}
}

func (s *Server) voteMatchList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	stageID := voteProjectID(r.URL.Query().Get("stage_id"))
	if stageID <= 0 {
		projectID := voteProjectID(r.URL.Query().Get("project_id"))
		_ = s.db.QueryRowContext(r.Context(), "SELECT id FROM vote_stages WHERE project_id=? AND stage_type IN ('bracket','final') ORDER BY sort_order,id LIMIT 1", projectID).Scan(&stageID)
	}
	if stageID <= 0 {
		writeJSON(w, map[string]any{"success": true, "data": []any{}})
		return
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
	data, err := s.voteMatchRows(r.Context(), stageID, s.voteCanManage(r.Context(), viewer, project))
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取对阵失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "data": data})
}

func (s *Server) voteMatchGenerate(w http.ResponseWriter, r *http.Request) {
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
	_, project, ok := s.voteProjectManager(w, r, integerValue(stage["project_id"]))
	if !ok {
		return
	}
	if project.ProjectType != "moe" || (stringValue(stage["stage_type"]) != "bracket" && stringValue(stage["stage_type"]) != "final") {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "只有萌战 1v1 阶段可以生成对阵"})
		return
	}
	entryIDs := voteInt64Array(input["entry_ids"])
	if len(entryIDs) == 0 {
		if err := s.voteEnsureStageEntries(r.Context(), stageID, project.ID); err != nil {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取候选池失败"})
			return
		}
		rows, queryErr := s.db.QueryContext(r.Context(), "SELECT entry_id FROM vote_stage_entries WHERE stage_id=? AND status='active' ORDER BY seed_no,id", stageID)
		if queryErr != nil {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取候选池失败"})
			return
		}
		for rows.Next() {
			var entryID int64
			if rows.Scan(&entryID) == nil {
				entryIDs = append(entryIDs, entryID)
			}
		}
		_ = rows.Close()
	}
	entryIDs = uniqueInt64(entryIDs)
	if !isPowerOfTwo(len(entryIDs)) {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "萌战 1v1 晋级人数必须是 2 的幂"})
		return
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(entryIDs)), ",")
	args := []any{project.ID}
	for _, entryID := range entryIDs {
		args = append(args, entryID)
	}
	var valid int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM vote_entries WHERE project_id=? AND entry_status='approved' AND id IN ("+placeholders+")", args...).Scan(&valid); err != nil || valid != int64(len(entryIDs)) {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "对阵条目必须属于本企划且已审核通过"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "生成对阵失败"})
		return
	}
	if _, err = tx.ExecContext(r.Context(), "DELETE FROM vote_matches WHERE stage_id=?", stageID); err == nil {
		_, err = tx.ExecContext(r.Context(), "DELETE FROM vote_results WHERE stage_id=?", stageID)
	}
	matchIDs := map[int]map[int]int64{}
	if err == nil {
		insert := "INSERT INTO vote_matches(project_id,stage_id,round_no,match_no,slot_a_entry_id,slot_b_entry_id,status) VALUES(?,?,?,?,?,?,?)"
		roundSize := len(entryIDs)
		round := 1
		for roundSize >= 2 && err == nil {
			matchIDs[round] = map[int]int64{}
			for index, matchNo := 0, 1; index < roundSize; index, matchNo = index+2, matchNo+1 {
				var a, b any
				if round == 1 {
					a, b = entryIDs[index], entryIDs[index+1]
				}
				result, insertErr := tx.ExecContext(r.Context(), insert, project.ID, stageID, round, matchNo, a, b, "pending")
				if insertErr != nil {
					err = insertErr
					break
				}
				matchIDs[round][matchNo], _ = result.LastInsertId()
			}
			roundSize /= 2
			round++
		}
	}
	if err == nil {
		for round, matches := range matchIDs {
			next := matchIDs[round+1]
			for matchNo, matchID := range matches {
				nextID := next[(matchNo+1)/2]
				if nextID == 0 {
					continue
				}
				slot := "A"
				if matchNo%2 == 0 {
					slot = "B"
				}
				if _, err = tx.ExecContext(r.Context(), "UPDATE vote_matches SET next_match_id=?,next_slot=? WHERE id=?", nextID, slot, matchID); err != nil {
					break
				}
			}
		}
	}
	if err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "生成对阵失败"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "生成对阵失败"})
		return
	}
	data, _ := s.voteMatchRows(r.Context(), stageID, true)
	writeJSON(w, map[string]any{"success": true, "data": data})
}

func (s *Server) voteMatchUpdate(w http.ResponseWriter, r *http.Request, action string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	input := voteReadJSON(r)
	matchID := voteProjectID(r.URL.Query().Get("id"), input["id"])
	match, err := s.voteMatch(r.Context(), matchID)
	if err == sql.ErrNoRows || match == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "对阵不存在"})
		return
	}
	if _, _, ok := s.voteProjectManager(w, r, integerValue(match["project_id"])); !ok {
		return
	}
	slotA := voteProjectID(input["slot_a_entry_id"])
	if slotA == 0 {
		slotA = integerValue(match["slot_a_entry_id"])
	}
	slotB := voteProjectID(input["slot_b_entry_id"])
	if slotB == 0 {
		slotB = integerValue(match["slot_b_entry_id"])
	}
	winner := voteProjectID(input["winner_entry_id"])
	if winner == 0 {
		winner = integerValue(match["winner_entry_id"])
	}
	status := stringValue(input["status"])
	if action == "open" {
		status = "open"
	} else if action == "lock" {
		status = "pending"
	} else if action == "settle" {
		status = "settled"
	} else {
		status = voteNormalize(status, []string{"pending", "open", "settled"}, "pending")
	}
	if action == "settle" && (winner == 0 || (winner != slotA && winner != slotB)) {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "胜者必须来自当前对阵 A/B 槽位"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err == nil {
		_, err = tx.ExecContext(r.Context(), "UPDATE vote_matches SET slot_a_entry_id=?,slot_b_entry_id=?,winner_entry_id=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", nullableInt64(slotA), nullableInt64(slotB), nullableInt64(winner), status, matchID)
		if err == nil && action == "settle" && integerValue(match["next_match_id"]) > 0 {
			field := "slot_a_entry_id"
			if strings.EqualFold(stringValue(match["next_slot"]), "B") {
				field = "slot_b_entry_id"
			}
			_, err = tx.ExecContext(r.Context(), "UPDATE vote_matches SET "+field+"=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", winner, integerValue(match["next_match_id"]))
		}
		if err == nil && action == "settle" && integerValue(match["next_match_id"]) == 0 {
			_, err = tx.ExecContext(r.Context(), "UPDATE vote_stages SET status='settled',updated_at=CURRENT_TIMESTAMP WHERE id=?", integerValue(match["stage_id"]))
			if err == nil {
				_, err = tx.ExecContext(r.Context(), "UPDATE vote_projects SET status='ended',ended_at=COALESCE(ended_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=?", integerValue(match["project_id"]))
			}
		}
		if err == nil {
			err = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
	}
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "保存对阵失败"})
		return
	}
	data, _ := s.voteMatchRows(r.Context(), integerValue(match["stage_id"]), true)
	writeJSON(w, map[string]any{"success": true, "status": status, "data": data})
}

func (s *Server) voteMatchSettleByVotes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	input := voteReadJSON(r)
	stageID := voteProjectID(input["stage_id"], r.URL.Query().Get("stage_id"))
	stage, err := s.voteFetchStage(r.Context(), stageID)
	if err != nil || stage == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "stage not found"})
		return
	}
	if _, _, ok := s.voteProjectManager(w, r, integerValue(stage["project_id"])); !ok {
		return
	}
	rows, err := s.db.QueryContext(r.Context(), "SELECT id,slot_a_entry_id,slot_b_entry_id FROM vote_matches WHERE stage_id=? AND status='open' ORDER BY round_no,match_no", stageID)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取对阵失败"})
		return
	}
	type openMatch struct{ id, a, b int64 }
	matches := []openMatch{}
	for rows.Next() {
		var match openMatch
		var a, b sql.NullInt64
		if rows.Scan(&match.id, &a, &b) == nil {
			if a.Valid {
				match.a = a.Int64
			}
			if b.Valid {
				match.b = b.Int64
			}
			matches = append(matches, match)
		}
	}
	_ = rows.Close()
	settled, unresolved := []map[string]any{}, []map[string]any{}
	for _, match := range matches {
		var aVotes, bVotes int64
		_ = s.db.QueryRowContext(r.Context(), "SELECT COALESCE(SUM(vote_value),0) FROM vote_votes WHERE stage_id=? AND match_id=? AND entry_id=?", stageID, match.id, match.a).Scan(&aVotes)
		_ = s.db.QueryRowContext(r.Context(), "SELECT COALESCE(SUM(vote_value),0) FROM vote_votes WHERE stage_id=? AND match_id=? AND entry_id=?", stageID, match.id, match.b).Scan(&bVotes)
		if match.a == 0 || match.b == 0 || aVotes == bVotes {
			unresolved = append(unresolved, map[string]any{"match_id": match.id, "slot_a_votes": aVotes, "slot_b_votes": bVotes, "reason": map[bool]string{true: "tie", false: "missing_slot"}[aVotes == bVotes]})
			continue
		}
		winner := match.a
		if bVotes > aVotes {
			winner = match.b
		}
		if _, err := s.db.ExecContext(r.Context(), "UPDATE vote_matches SET winner_entry_id=?,status='settled',updated_at=CURRENT_TIMESTAMP WHERE id=?", winner, match.id); err != nil {
			continue
		}
		settled = append(settled, map[string]any{"match_id": match.id, "winner_entry_id": winner, "slot_a_votes": aVotes, "slot_b_votes": bVotes})
	}
	data, _ := s.voteMatchRows(r.Context(), stageID, true)
	writeJSON(w, map[string]any{"success": true, "settled_count": len(settled), "unresolved_count": len(unresolved), "settled": settled, "unresolved": unresolved, "data": data})
}

func (s *Server) voteMatch(ctx context.Context, id int64) (map[string]any, error) {
	row := s.db.QueryRowContext(ctx, "SELECT id,project_id,stage_id,round_no,match_no,slot_a_entry_id,slot_b_entry_id,winner_entry_id,status,next_match_id,next_slot FROM vote_matches WHERE id=?", id)
	var matchID, projectID, stageID, roundNo, matchNo int64
	var a, b, winner, nextID sql.NullInt64
	var status, nextSlot string
	if err := row.Scan(&matchID, &projectID, &stageID, &roundNo, &matchNo, &a, &b, &winner, &status, &nextID, &nextSlot); err != nil {
		return nil, err
	}
	result := map[string]any{"id": matchID, "project_id": projectID, "stage_id": stageID, "round_no": roundNo, "match_no": matchNo, "slot_a_entry_id": nil, "slot_b_entry_id": nil, "winner_entry_id": nil, "status": status, "next_match_id": nil, "next_slot": nextSlot}
	if a.Valid {
		result["slot_a_entry_id"] = a.Int64
	}
	if b.Valid {
		result["slot_b_entry_id"] = b.Int64
	}
	if winner.Valid {
		result["winner_entry_id"] = winner.Int64
	}
	if nextID.Valid {
		result["next_match_id"] = nextID.Int64
	}
	return result, nil
}

func (s *Server) voteMatchRows(ctx context.Context, stageID int64, includeVotes bool) ([]map[string]any, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT m.id,m.project_id,m.stage_id,m.round_no,m.match_no,m.slot_a_entry_id,m.slot_b_entry_id,m.winner_entry_id,m.status,m.next_match_id,m.next_slot,
		a.title,a.title_cn,a.image_url,b.title,b.title_cn,b.image_url,w.title,w.title_cn
		FROM vote_matches m LEFT JOIN vote_entries a ON a.id=m.slot_a_entry_id LEFT JOIN vote_entries b ON b.id=m.slot_b_entry_id LEFT JOIN vote_entries w ON w.id=m.winner_entry_id WHERE m.stage_id=? ORDER BY m.round_no,m.match_no`, stageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []map[string]any{}
	for rows.Next() {
		var id, projectID, sid, roundNo, matchNo int64
		var a, b, winner, nextID sql.NullInt64
		var status, nextSlot string
		var aTitle, aTitleCN, aImage, bTitle, bTitleCN, bImage, wTitle, wTitleCN sql.NullString
		if err := rows.Scan(&id, &projectID, &sid, &roundNo, &matchNo, &a, &b, &winner, &status, &nextID, &nextSlot, &aTitle, &aTitleCN, &aImage, &bTitle, &bTitleCN, &bImage, &wTitle, &wTitleCN); err != nil {
			return nil, err
		}
		row := map[string]any{"id": id, "project_id": projectID, "stage_id": sid, "round_no": roundNo, "match_no": matchNo, "slot_a_entry_id": nil, "slot_b_entry_id": nil, "winner_entry_id": nil, "status": status, "next_match_id": nil, "next_slot": nextSlot, "slot_a_title": aTitle.String, "slot_a_title_cn": aTitleCN.String, "slot_a_image": bangumiProxyImageURL(aImage.String), "slot_b_title": bTitle.String, "slot_b_title_cn": bTitleCN.String, "slot_b_image": bangumiProxyImageURL(bImage.String), "winner_title": wTitle.String, "winner_title_cn": wTitleCN.String}
		if a.Valid {
			row["slot_a_entry_id"] = a.Int64
		}
		if b.Valid {
			row["slot_b_entry_id"] = b.Int64
		}
		if winner.Valid {
			row["winner_entry_id"] = winner.Int64
		}
		if nextID.Valid {
			row["next_match_id"] = nextID.Int64
		}
		if includeVotes {
			var aVotes, bVotes int64
			_ = s.db.QueryRowContext(ctx, "SELECT COALESCE(SUM(vote_value),0) FROM vote_votes WHERE stage_id=? AND match_id=? AND entry_id=?", stageID, id, nullableInt64Value(a)).Scan(&aVotes)
			_ = s.db.QueryRowContext(ctx, "SELECT COALESCE(SUM(vote_value),0) FROM vote_votes WHERE stage_id=? AND match_id=? AND entry_id=?", stageID, id, nullableInt64Value(b)).Scan(&bVotes)
			row["slot_a_votes"], row["slot_b_votes"] = aVotes, bVotes
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func nullableInt64Value(value sql.NullInt64) int64 {
	if value.Valid {
		return value.Int64
	}
	return 0
}

func isPowerOfTwo(value int) bool {
	return value > 0 && value&(value-1) == 0
}
