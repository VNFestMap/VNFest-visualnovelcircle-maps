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

type SpyReport struct {
	Advanced int      `json:"advanced"`
	Pruned   int      `json:"idempotency_pruned"`
	Reaped   int      `json:"reaped"`
	Errors   []string `json:"errors,omitempty"`
	DryRun   bool     `json:"dry_run"`
}

// RunSpy is the Go replacement for scripts/spy_worker.php. It deliberately
// uses the same tables as the HTTP implementation and commits each room as a
// separate unit. A failure in one room therefore cannot discard another
// room's already committed timeout transition.
func RunSpy(ctx context.Context, db *sqlstore.DB, dryRun, reap bool) (SpyReport, error) {
	report := SpyReport{DryRun: dryRun}
	for round := 0; round < 5; round++ {
		advanced, errs, err := spyTick(ctx, db, time.Now().Unix(), 200, dryRun)
		report.Advanced += advanced
		report.Errors = append(report.Errors, errs...)
		if err != nil {
			return report, err
		}
		if advanced == 0 {
			break
		}
	}
	if dryRun {
		var count int
		if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM spy_idempotency WHERE expires_at < ?", time.Now().Unix()).Scan(&count); err != nil && !strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return report, err
		}
		report.Pruned = count
	} else {
		result, err := db.ExecContext(ctx, "DELETE FROM spy_idempotency WHERE expires_at < ?", time.Now().Unix())
		if err != nil {
			return report, err
		}
		pruned, _ := result.RowsAffected()
		report.Pruned = int(pruned)
	}
	if reap {
		count, err := spyReap(ctx, db, dryRun)
		if err != nil {
			return report, err
		}
		report.Reaped = count
	}
	return report, nil
}

type spyWorkerRoom struct {
	id, round, deadline, speaker, revote int64
	phase, status                        string
}
type spyWorkerSeat struct {
	seat int64
	role string
	out  sql.NullInt64
}

func spyTick(ctx context.Context, db *sqlstore.DB, now, limit int64, dryRun bool) (int, []string, error) {
	rows, err := db.QueryContext(ctx, "SELECT id FROM spy_rooms WHERE status='playing' AND deadline_at>0 AND deadline_at<=? ORDER BY deadline_at LIMIT ?", now, limit)
	if err != nil {
		return 0, nil, err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return 0, nil, err
	}
	advanced, errors := 0, []string{}
	for _, id := range ids {
		if dryRun {
			advanced++
			continue
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			errors = append(errors, fmt.Sprintf("%d: begin failed", id))
			continue
		}
		changed, err := spyAdvanceExpired(ctx, tx, id, now)
		if err == nil {
			err = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
		if err != nil {
			errors = append(errors, fmt.Sprintf("%d: %s", id, truncateError(err.Error())))
			continue
		}
		if changed {
			advanced++
		}
	}
	return advanced, errors, nil
}

func spyLoadWorkerRoom(ctx context.Context, tx *sql.Tx, id int64) (*spyWorkerRoom, error) {
	room := &spyWorkerRoom{}
	err := tx.QueryRowContext(ctx, "SELECT id,round,deadline_at,speaker_seat,revote_used,phase,status FROM spy_rooms WHERE id=?", id).Scan(&room.id, &room.round, &room.deadline, &room.speaker, &room.revote, &room.phase, &room.status)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return room, err
}

func spyWorkerSeats(ctx context.Context, tx *sql.Tx, id int64) ([]spyWorkerSeat, error) {
	rows, err := tx.QueryContext(ctx, "SELECT seat,COALESCE(role,''),out_round FROM spy_seats WHERE room_id=? ORDER BY seat", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []spyWorkerSeat{}
	for rows.Next() {
		var seat spyWorkerSeat
		if err := rows.Scan(&seat.seat, &seat.role, &seat.out); err != nil {
			return nil, err
		}
		result = append(result, seat)
	}
	return result, rows.Err()
}
func spyWorkerAlive(seat spyWorkerSeat) bool { return !seat.out.Valid }

func spyAdvanceExpired(ctx context.Context, tx *sql.Tx, id, now int64) (bool, error) {
	room, err := spyLoadWorkerRoom(ctx, tx, id)
	if err != nil || room == nil || room.status != "playing" || room.deadline > now {
		return false, err
	}
	seats, err := spyWorkerSeats(ctx, tx, id)
	if err != nil {
		return false, err
	}
	switch room.phase {
	case "day":
		if room.speaker > 0 {
			_, _ = tx.ExecContext(ctx, "INSERT INTO spy_sentences(room_id,round,seat,body,skipped,submitted_at) VALUES(?,?,?,?,1,?)", id, room.round, room.speaker, "", now)
		}
		if err := spyOpenNext(ctx, tx, room, seats); err != nil {
			return false, err
		}
	case "discuss":
		if err := spyTransition(ctx, tx, room, "vote", room.round, now); err != nil {
			return false, err
		}
	case "vote":
		tie, err := spyWorkerSettleVote(ctx, tx, room, seats, now)
		if err != nil {
			return false, err
		}
		if tie {
			_, err = tx.ExecContext(ctx, "UPDATE spy_rooms SET deadline_at=0 WHERE id=?", id)
			return true, err
		}
		if ended, err := spyWorkerEvaluateAndFinish(ctx, tx, room, seats, now); err != nil || ended {
			return true, err
		}
		if err := spyTransition(ctx, tx, room, "night", room.round, now); err != nil {
			return false, err
		}
	case "night":
		if err := spyWorkerSettleNight(ctx, tx, room, seats, now); err != nil {
			return false, err
		}
		fresh, err := spyLoadWorkerRoom(ctx, tx, id)
		if err != nil {
			return false, err
		}
		freshSeats, err := spyWorkerSeats(ctx, tx, id)
		if err != nil {
			return false, err
		}
		if ended, err := spyWorkerEvaluateAndFinish(ctx, tx, fresh, freshSeats, now); err != nil || ended {
			return true, err
		}
		if err := spyTransition(ctx, tx, fresh, "day", fresh.round+1, now); err != nil {
			return false, err
		}
	default:
		return false, nil
	}
	return true, nil
}

func spyOpenNext(ctx context.Context, tx *sql.Tx, room *spyWorkerRoom, seats []spyWorkerSeat) error {
	alive := []int64{}
	for _, seat := range seats {
		if spyWorkerAlive(seat) {
			alive = append(alive, seat.seat)
		}
	}
	if len(alive) == 0 {
		return spyTransition(ctx, tx, room, "discuss", room.round, spyNowJob())
	}
	missing := []int64{}
	for _, seat := range alive {
		var count int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM spy_sentences WHERE room_id=? AND round=? AND seat=?", room.id, room.round, seat).Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			missing = append(missing, seat)
		}
	}
	if len(missing) > 0 {
		_, err := tx.ExecContext(ctx, "UPDATE spy_rooms SET speaker_seat=?,deadline_at=? WHERE id=?", missing[0], spyNowJob()+40*int64(len(alive)), room.id)
		return err
	}
	return spyTransition(ctx, tx, room, "discuss", room.round, spyNowJob())
}
func spyTransition(ctx context.Context, tx *sql.Tx, room *spyWorkerRoom, phase string, round, now int64) error {
	seconds := int64(180)
	switch phase {
	case "vote":
		seconds = 60
	case "night":
		seconds = 45
	case "day":
		seconds = 40
	}
	speaker := int64(0)
	if phase == "day" {
		var min int64
		_ = tx.QueryRowContext(ctx, "SELECT COALESCE(MIN(seat),0) FROM spy_seats WHERE room_id=? AND out_round IS NULL", room.id).Scan(&min)
		speaker = min
		seconds *= maxJobInt64(1, func() int64 {
			var count int64
			_ = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM spy_seats WHERE room_id=? AND out_round IS NULL", room.id).Scan(&count)
			return count
		}())
	}
	if _, err := tx.ExecContext(ctx, "UPDATE spy_rooms SET phase=?,round=?,speaker_seat=?,deadline_at=? WHERE id=?", phase, round, speaker, now+seconds, room.id); err != nil {
		return err
	}
	return spyWorkerBump(ctx, tx, room.id, "phase", map[string]any{"phase": phase, "round": round})
}
func maxJobInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
func spyWorkerBump(ctx context.Context, tx *sql.Tx, id int64, kind string, payload map[string]any) error {
	if _, err := tx.ExecContext(ctx, "UPDATE spy_rooms SET rev=rev+1,last_activity_at=? WHERE id=?", spyNowJob(), id); err != nil {
		return err
	}
	var rev int64
	if err := tx.QueryRowContext(ctx, "SELECT rev FROM spy_rooms WHERE id=?", id).Scan(&rev); err != nil {
		return err
	}
	raw, _ := json.Marshal(payload)
	_, err := tx.ExecContext(ctx, "INSERT INTO spy_events(room_id,rev,kind,payload,created_at) VALUES(?,?,?,?,?)", id, rev, kind, string(raw), spyNowJob())
	return err
}
func spyNowJob() int64 { return time.Now().Unix() }

func spyWorkerSettleVote(ctx context.Context, tx *sql.Tx, room *spyWorkerRoom, seats []spyWorkerSeat, now int64) (bool, error) {
	var exists int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM spy_round_outcomes WHERE room_id=? AND round=? AND stage='vote'", room.id, room.round).Scan(&exists); err != nil {
		return false, err
	}
	if exists > 0 {
		return false, nil
	}
	alive := map[int64]bool{}
	for _, s := range seats {
		if spyWorkerAlive(s) {
			alive[s.seat] = true
		}
	}
	rows, err := tx.QueryContext(ctx, "SELECT from_seat,to_seat FROM spy_votes WHERE room_id=? AND round=?", room.id, room.round)
	if err != nil {
		return false, err
	}
	counts := map[int64]int64{}
	for n := range alive {
		counts[n] = 0
	}
	for rows.Next() {
		var from int64
		var to sql.NullInt64
		if err := rows.Scan(&from, &to); err != nil {
			rows.Close()
			return false, err
		}
		if to.Valid && to.Int64 != from && alive[to.Int64] {
			counts[to.Int64]++
		}
	}
	rows.Close()
	order := []int64{}
	for n := range counts {
		order = append(order, n)
	}
	sort.Slice(order, func(i, j int) bool {
		if counts[order[i]] == counts[order[j]] {
			return order[i] < order[j]
		}
		return counts[order[i]] > counts[order[j]]
	})
	top := int64(0)
	if len(order) > 0 {
		top = counts[order[0]]
	}
	leaders := []int64{}
	for _, n := range order {
		if counts[n] == top {
			leaders = append(leaders, n)
		}
	}
	tie := top >= 1 && len(leaders) > 1
	var out any
	role := ""
	if top >= 1 && !tie {
		out = leaders[0]
		for _, s := range seats {
			if s.seat == leaders[0] {
				role = s.role
			}
		}
		if _, err := tx.ExecContext(ctx, "UPDATE spy_seats SET out_round=?,out_by='vote' WHERE room_id=? AND seat=?", room.round, room.id, leaders[0]); err != nil {
			return false, err
		}
	}
	tally, _ := json.Marshal(map[string]any{"rows": func() []map[string]any {
		r := []map[string]any{}
		for _, n := range order {
			r = append(r, map[string]any{"seat": n, "votes": counts[n]})
		}
		return r
	}()})
	_, err = tx.ExecContext(ctx, "INSERT INTO spy_round_outcomes(room_id,round,stage,eliminated_seat,eliminated_role,out_by,tie,tally,created_at) VALUES(?,?,?,?,?,?,?, ?,?)", room.id, room.round, "vote", out, role, func() string {
		if out != nil {
			return "vote"
		}
		return ""
	}(), jobBoolInt(tie), string(tally), now)
	if err != nil {
		return false, err
	}
	_, err = tx.ExecContext(ctx, "UPDATE spy_rooms SET vote_sealed_at=? WHERE id=?", now, room.id)
	return tie, err
}
func spyWorkerSettleNight(ctx context.Context, tx *sql.Tx, room *spyWorkerRoom, seats []spyWorkerSeat, now int64) error {
	var exists int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM spy_round_outcomes WHERE room_id=? AND round=? AND stage='night'", room.id, room.round).Scan(&exists); err != nil {
		return err
	}
	if exists > 0 {
		return nil
	}
	by := map[int64]spyWorkerSeat{}
	alive := map[int64]bool{}
	for _, s := range seats {
		by[s.seat] = s
		if spyWorkerAlive(s) {
			alive[s.seat] = true
		}
	}
	rows, err := tx.QueryContext(ctx, "SELECT from_seat,target_seat FROM spy_night_actions WHERE room_id=? AND round=?", room.id, room.round)
	if err != nil {
		return err
	}
	knife := map[int64]int64{}
	self := []int64{}
	for rows.Next() {
		var from int64
		var target sql.NullInt64
		if err := rows.Scan(&from, &target); err != nil {
			rows.Close()
			return err
		}
		if !target.Valid || !alive[target.Int64] {
			continue
		}
		if by[from].role == "spy" {
			knife[target.Int64]++
		} else {
			self = append(self, from)
		}
	}
	rows.Close()
	max := int64(0)
	for _, n := range knife {
		if n > max {
			max = n
		}
	}
	leaders := []int64{}
	for n, v := range knife {
		if v == max {
			leaders = append(leaders, n)
		}
	}
	killed := int64(0)
	if max > 0 && len(leaders) == 1 {
		killed = leaders[0]
	}
	if killed > 0 {
		if _, err := tx.ExecContext(ctx, "UPDATE spy_seats SET out_round=?,out_by='kill' WHERE room_id=? AND seat=?", room.round, room.id, killed); err != nil {
			return err
		}
	}
	selfUnique := []int64{}
	for _, n := range self {
		if n != killed && !containsJobInt64(selfUnique, n) {
			selfUnique = append(selfUnique, n)
			if _, err := tx.ExecContext(ctx, "UPDATE spy_seats SET out_round=?,out_by='self-kill' WHERE room_id=? AND seat=?", room.round, room.id, n); err != nil {
				return err
			}
		}
	}
	var out any
	if killed > 0 {
		out = killed
	} else if len(selfUnique) > 0 {
		out = selfUnique[0]
	}
	tally, _ := json.Marshal(map[string]any{"killed": func() []int64 {
		if killed > 0 {
			return []int64{killed}
		}
		return []int64{}
	}(), "self_kills": selfUnique})
	_, err = tx.ExecContext(ctx, "INSERT INTO spy_round_outcomes(room_id,round,stage,eliminated_seat,out_by,tally,created_at) VALUES(?,?, 'night',?,?,?,?)", room.id, room.round, out, func() string {
		if killed > 0 {
			return "kill"
		}
		if len(selfUnique) > 0 {
			return "self-kill"
		}
		return ""
	}(), string(tally), now)
	return err
}
func containsJobInt64(v []int64, n int64) bool {
	for _, x := range v {
		if x == n {
			return true
		}
	}
	return false
}

func jobBoolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
func spyWorkerEvaluateAndFinish(ctx context.Context, tx *sql.Tx, room *spyWorkerRoom, seats []spyWorkerSeat, now int64) (bool, error) {
	alive := map[string]int64{}
	for _, s := range seats {
		if spyWorkerAlive(s) {
			alive[s.role]++
		}
	}
	winner := ""
	reason := ""
	if alive["spy"] == 0 && alive["blank"] == 0 {
		winner = "civilian"
		reason = "卧底与白板已全部出局，好人阵营胜利。"
	} else if alive["spy"] > 0 && alive["spy"] >= alive["civilian"] {
		winner = "spy"
		reason = "存活卧底已达到存活好人数量，卧底胜利。"
	}
	if winner == "" {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM spy_results WHERE room_id=?", room.id); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO spy_results(room_id,winner,reason,rounds,awards,reveal,settled_at) VALUES(?,?,?,?,'[]','[]',?)", room.id, winner, reason, room.round, now); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE spy_rooms SET status='ended',phase='over',winner=?,deadline_at=0,speaker_seat=0 WHERE id=?", winner, room.id); err != nil {
		return false, err
	}
	return true, spyWorkerBump(ctx, tx, room.id, "game-over", map[string]any{"winner": winner, "rounds": room.round})
}

func spyReap(ctx context.Context, db *sqlstore.DB, dryRun bool) (int, error) {
	now := time.Now().Unix()
	rows, err := db.QueryContext(ctx, "SELECT id FROM spy_rooms WHERE (status='playing' AND ?-last_activity_at>7200) OR (status='waiting' AND ?-last_activity_at>86400) OR (status='ended' AND ?-last_activity_at>604800)", now, now, now)
	if err != nil {
		return 0, err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if !dryRun && len(ids) > 0 {
		place := make([]string, len(ids))
		args := make([]any, len(ids))
		for i, id := range ids {
			place[i] = "?"
			args[i] = id
		}
		if _, err := db.ExecContext(ctx, "DELETE FROM spy_rooms WHERE id IN ("+strings.Join(place, ",")+")", args...); err != nil {
			return 0, err
		}
	}
	return len(ids), nil
}
