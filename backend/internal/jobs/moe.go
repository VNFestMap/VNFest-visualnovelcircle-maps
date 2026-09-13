package jobs

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

// MoeSettlementReport is intentionally machine-readable because the cron
// replacement is also used during the PHP -> Go rehearsal.
type MoeSettlementReport struct {
	Checked   int              `json:"checked"`
	Due       int              `json:"due"`
	Settled   []map[string]any `json:"settled"`
	Reviewing []map[string]any `json:"reviewing"`
	Errors    []map[string]any `json:"errors"`
	DryRun    bool             `json:"dry_run"`
}

type moePool struct {
	id, runID, projectID, stageID int64
	stageType, status, voteMode   string
	groupCount, maxSelect         int
	advanceCount                  int
	configJSON                    string
	deadline                      sql.NullString
}

type moeEntry struct {
	entryID, seedNo, votes, scoreTotal, ratingCount int64
	groupKey                                        string
	scoreAvg                                        sql.NullFloat64
}

// RunMoeSettlement ports settle-moe-contests.php. It only settles due pools,
// writes each pool in one transaction, and never deletes votes or entries.
func RunMoeSettlement(ctx context.Context, db *sqlstore.DB, dryRun bool) (MoeSettlementReport, error) {
	report := MoeSettlementReport{DryRun: dryRun, Settled: []map[string]any{}, Reviewing: []map[string]any{}, Errors: []map[string]any{}}
	for _, table := range []string{"vote_flow_pools", "vote_flow_pool_entries", "vote_flow_results", "vote_votes"} {
		exists, err := db.TableExists(ctx, table)
		if err != nil {
			return report, err
		}
		if !exists {
			return report, fmt.Errorf("%w: %s", ErrSchemaUnavailable, table)
		}
	}
	rows, err := db.QueryContext(ctx, `SELECT p.id,p.run_id,p.project_id,p.stage_id,p.stage_type,p.status,p.vote_mode,
		p.group_count,p.max_select,p.advance_count,COALESCE(p.config_json,'{}'),s.ends_at
		FROM vote_flow_pools p JOIN vote_projects project ON project.id=p.project_id AND project.project_type='moe'
		JOIN vote_stages s ON s.id=p.stage_id WHERE p.status IN ('open','locked') ORDER BY p.id`)
	if err != nil {
		return report, err
	}
	pools := []moePool{}
	for rows.Next() {
		var pool moePool
		if err := rows.Scan(&pool.id, &pool.runID, &pool.projectID, &pool.stageID, &pool.stageType, &pool.status, &pool.voteMode,
			&pool.groupCount, &pool.maxSelect, &pool.advanceCount, &pool.configJSON, &pool.deadline); err != nil {
			rows.Close()
			return report, err
		}
		pools = append(pools, pool)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return report, err
	}
	if err := rows.Close(); err != nil {
		return report, err
	}
	now := time.Now()
	for _, pool := range pools {
		report.Checked++
		deadline := moeDeadline(pool)
		if deadline.IsZero() || deadline.After(now) {
			continue
		}
		report.Due++
		item, err := settleMoePool(ctx, db, pool, now.Unix(), dryRun)
		if err != nil {
			report.Errors = append(report.Errors, map[string]any{"pool_id": pool.id, "stage_id": pool.stageID, "message": truncateError(err.Error())})
			continue
		}
		if stringValueJob(item["status"]) == "reviewing" {
			report.Reviewing = append(report.Reviewing, item)
		} else {
			report.Settled = append(report.Settled, item)
		}
	}
	return report, nil
}

func moeDeadline(pool moePool) time.Time {
	var config map[string]any
	_ = json.Unmarshal([]byte(pool.configJSON), &config)
	raw := stringValueJob(config["ends_at"])
	if raw == "" && pool.deadline.Valid {
		raw = pool.deadline.String
	}
	if raw == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02"} {
		if value, err := time.Parse(layout, raw); err == nil {
			return value
		}
	}
	return time.Time{}
}

func settleMoePool(ctx context.Context, db *sqlstore.DB, pool moePool, now int64, dryRun bool) (map[string]any, error) {
	if pool.voteMode == "match_single" {
		return settleMoeMatches(ctx, db, pool, now, dryRun)
	}
	entries, err := loadMoeEntries(ctx, db, pool)
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("阶段池没有候选，不能结算")
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if pool.voteMode == "score" {
			if entries[i].scoreTotal != entries[j].scoreTotal {
				return entries[i].scoreTotal > entries[j].scoreTotal
			}
			if entries[i].ratingCount != entries[j].ratingCount {
				return entries[i].ratingCount > entries[j].ratingCount
			}
		}
		if entries[i].votes != entries[j].votes {
			return entries[i].votes > entries[j].votes
		}
		if entries[i].seedNo != entries[j].seedNo {
			return entries[i].seedNo < entries[j].seedNo
		}
		return entries[i].entryID < entries[j].entryID
	})
	advance := pool.advanceCount
	if advance <= 0 || advance > len(entries) {
		advance = len(entries)
	}
	tie := false
	if advance > 0 && advance < len(entries) {
		tie = entries[advance-1].votes == entries[advance].votes
		if pool.voteMode == "score" {
			tie = tie && entries[advance-1].scoreTotal == entries[advance].scoreTotal && entries[advance-1].ratingCount == entries[advance].ratingCount
		}
	}
	item := map[string]any{"pool_id": pool.id, "stage_id": pool.stageID, "advanced_count": advance, "result_count": len(entries), "status": "settled", "tie_breaks": tie}
	if tie {
		item["status"] = "reviewing"
	}
	if dryRun {
		return item, nil
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var current string
	if err := tx.QueryRowContext(ctx, "SELECT status FROM vote_flow_pools WHERE id=?", pool.id).Scan(&current); err != nil {
		return nil, err
	}
	if current != "open" && current != "locked" {
		return nil, fmt.Errorf("阶段池状态已变化，不能结算")
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM vote_flow_results WHERE pool_id=?", pool.id); err != nil {
		return nil, err
	}
	insert, err := tx.PrepareContext(ctx, `INSERT INTO vote_flow_results (run_id,pool_id,project_id,entry_id,rank_no,votes,score_total,rating_count,score_avg,advanced,snapshot_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
	if err != nil {
		return nil, err
	}
	defer insert.Close()
	for index, entry := range entries {
		advanced := index < advance && !tie
		if _, err := insert.ExecContext(ctx, pool.runID, pool.id, pool.projectID, entry.entryID, index+1, entry.votes, entry.scoreTotal, entry.ratingCount, nullableFloat(entry.scoreAvg), jobBoolInt(advanced), fmt.Sprintf(`{"group_key":%q,"seed_no":%d}`, entry.groupKey, entry.seedNo)); err != nil {
			return nil, err
		}
	}
	status := "settled"
	if tie {
		status = "reviewing"
	}
	if _, err := tx.ExecContext(ctx, "UPDATE vote_flow_pools SET status=?,settled_at=CASE WHEN ?='settled' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?", status, status, pool.id); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE vote_stages SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", status, pool.stageID); err != nil {
		return nil, err
	}
	if status == "settled" && pool.stageType == "final" {
		if _, err := tx.ExecContext(ctx, "UPDATE vote_projects SET status='ended',ended_at=COALESCE(ended_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=?", pool.projectID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return item, nil
}

func loadMoeEntries(ctx context.Context, db *sqlstore.DB, pool moePool) ([]moeEntry, error) {
	query := `SELECT fpe.entry_id,COALESCE(fpe.seed_no,0),COALESCE(fpe.group_key,''),COALESCE(SUM(v.vote_value),0),COALESCE(SUM(v.score_value),0),COUNT(v.id),AVG(v.score_value)
		FROM vote_flow_pool_entries fpe LEFT JOIN vote_votes v ON v.entry_id=fpe.entry_id AND v.stage_id=?
		WHERE fpe.pool_id=? AND fpe.status='active' GROUP BY fpe.entry_id,fpe.seed_no,fpe.group_key ORDER BY fpe.group_key,fpe.seed_no`
	rows, err := db.QueryContext(ctx, query, pool.stageID, pool.id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []moeEntry{}
	for rows.Next() {
		var entry moeEntry
		if err := rows.Scan(&entry.entryID, &entry.seedNo, &entry.groupKey, &entry.votes, &entry.scoreTotal, &entry.ratingCount, &entry.scoreAvg); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

func settleMoeMatches(ctx context.Context, db *sqlstore.DB, pool moePool, now int64, dryRun bool) (map[string]any, error) {
	rows, err := db.QueryContext(ctx, `SELECT id,slot_a_entry_id,slot_b_entry_id FROM vote_flow_matches WHERE pool_id=? AND status='open' ORDER BY round_no,match_no`, pool.id)
	if err != nil {
		return nil, err
	}
	type match struct{ id, a, b int64 }
	matches := []match{}
	for rows.Next() {
		var value match
		if err := rows.Scan(&value.id, &value.a, &value.b); err != nil {
			rows.Close()
			return nil, err
		}
		matches = append(matches, value)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	settled, unresolved := 0, 0
	if !dryRun {
		for _, current := range matches {
			var winner sql.NullInt64
			var countA, countB int64
			if err := db.QueryRowContext(ctx, "SELECT COALESCE(SUM(CASE WHEN entry_id=? THEN vote_value ELSE 0 END),0),COALESCE(SUM(CASE WHEN entry_id=? THEN vote_value ELSE 0 END),0) FROM vote_votes WHERE match_id=?", current.a, current.b, current.id).Scan(&countA, &countB); err != nil {
				return nil, err
			}
			if countA == 0 && countB == 0 {
				continue
			}
			if countA == countB {
				unresolved++
				continue
			}
			winner.Int64 = current.a
			if countB > countA {
				winner.Int64 = current.b
			}
			winner.Valid = true
			if _, err := db.ExecContext(ctx, "UPDATE vote_flow_matches SET winner_entry_id=?,status='settled',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'", winner.Int64, current.id); err != nil {
				return nil, err
			}
			settled++
		}
	} else {
		settled = len(matches)
	}
	status := "settled"
	if unresolved > 0 {
		status = "reviewing"
	}
	return map[string]any{"pool_id": pool.id, "stage_id": pool.stageID, "settled_count": settled, "unresolved_count": unresolved, "status": status, "checked_at": now}, nil
}

func nullableFloat(value sql.NullFloat64) any {
	if value.Valid {
		return value.Float64
	}
	return nil
}

func stringValueJob(value any) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}
