package httpapi

// Native Go implementation of the three legacy Spy endpoints.  The PHP
// implementation keeps the game rules in includes/spy_game.php; this file
// intentionally mirrors its public state machine and its privacy projection
// instead of introducing a new API.  The database tables are shared with the
// PHP rollback image, so a cutover does not require a game-data conversion.

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	spyRoleCivilian  = "civilian"
	spyRoleSpy       = "spy"
	spyRoleBlank     = "blank"
	spyPhaseDay      = "day"
	spyPhaseDiscuss  = "discuss"
	spyPhaseVote     = "vote"
	spyPhaseNight    = "night"
	spyPhaseOver     = "over"
	spyStatusWaiting = "waiting"
	spyStatusPlaying = "playing"
	spyStatusEnded   = "ended"
	spyMinPlayers    = 4
	spyMaxPlayers    = 12
	spyOnlineWindow  = 12
	spyHeartbeatMin  = 6
)

var spyMessages = map[string]string{
	"not_login": "请先登录", "invalid_action": "操作名称无法识别", "invalid_params": "请求参数不完整",
	"room_not_found": "房间不存在", "room_closed": "房间已关闭", "room_full": "房间座位已满",
	"join_code_invalid": "房间码不正确", "spectate_off": "该房间未开放观战", "not_member": "你不在该房间内",
	"not_host": "仅房主可执行该操作", "already_joined": "你已在该房间内", "game_started": "本局已经开始",
	"game_not_started": "本局尚未开始", "phase_wrong": "当前阶段不支持该操作", "already_out": "你已出局",
	"not_your_turn": "当前未轮到你发言", "already_spoken": "本回合你已提交过描述", "sentence_empty": "描述不能为空",
	"sentence_too_long": "描述超出长度限制", "word_spill": "描述中不得出现自己所持有的词", "already_voted": "你已投过票",
	"vote_target_invalid": "投票目标无效", "vote_already_settled": "本轮投票已结束", "guess_exists": "你已提交过猜词",
	"not_blank": "仅白板可提交猜词", "distribution_invalid": "身份分配与入座人数不一致", "players_not_enough": "入座人数不足，无法开局",
	"word_bank_empty": "词库为空，请联系管理员", "no_revote_left": "重新投票次数已用完", "seat_not_found": "座位不存在",
	"server_error": "服务器繁忙，请稍后重试",
}

type spyHTTPError struct {
	key    string
	status int
	extra  map[string]any
}

func (e *spyHTTPError) Error() string       { return e.key }
func spyError(key string, status int) error { return &spyHTTPError{key: key, status: status} }
func spyErrorExtra(key string, status int, extra map[string]any) error {
	return &spyHTTPError{key: key, status: status, extra: extra}
}

type spyRoom struct {
	ID, HostUserID, ClubID, Cap, Joined, DistCivilian, DistSpy, DistBlank, Round         int64
	Code, Name, Country, Phase, TimerProfile, JoinCode, WordA, WordB, Status, Winner     string
	DeadlineAt, SpeakerSeat, VoteSealedAt, RevoteUsed, Spectate, SpectateDelay, NeedCode int64
	HostLastSeenAt, Rev, LastActivityAt                                                  int64
}

type spySeat struct {
	ID, RoomID, Seat, UserID                int64
	Nick, Avatar, Role, RolePreset, OutBy   string
	ReadyAt, ViewedAt, LastSeenAt, JoinedAt int64
	OutRound                                sql.NullInt64
}

type spyWord struct{ Civilian, Spy, Difficulty, Similarity string }

type spyOutcome struct {
	Round, EliminatedSeat    int64
	Stage, OutBy, HostRuling string
	Tie                      bool
	Eliminated               sql.NullInt64
	Tally                    map[string]any
}

func (s *Server) spyHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	w.Header().Set("Pragma", "no-cache")
}

func (s *Server) spyRooms(w http.ResponseWriter, r *http.Request) {
	s.spyHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	body := spyInput(r)
	action := strings.ToLower(spyInputValue(body, r, "action", ""))
	if action == "" {
		action = "list"
	}
	if action == "list" {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			methodNotAllowed(w, "GET, POST")
			return
		}
		uid := int64(0)
		if viewer, viewerOK := s.spyOptionalUser(r); viewerOK {
			uid = viewer.ID
		}
		rooms, err := s.spyLobby(r.Context(), uid)
		if err != nil {
			spyWriteHTTP(w, err)
			return
		}
		spyWriteOK(w, map[string]any{"rooms": rooms})
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	s.spyWriteCommand(w, r, body, func(ctx context.Context, tx *sql.Tx, u *user) (map[string]any, error) {
		switch action {
		case "create":
			return s.spyCreateTx(ctx, tx, u, body)
		case "join":
			id, err := s.spyRefTx(ctx, tx, body, r)
			if err != nil {
				return nil, err
			}
			return s.spyJoinTx(ctx, tx, id, u, spyInputValue(body, r, "join_code", ""))
		case "leave":
			id, err := s.spyRefTx(ctx, tx, body, r)
			if err != nil {
				return nil, err
			}
			return s.spyLeaveTx(ctx, tx, id, u)
		case "config":
			id, err := s.spyRefTx(ctx, tx, body, r)
			if err != nil {
				return nil, err
			}
			patch := body
			if nested, ok := body["patch"].(map[string]any); ok {
				patch = nested
			}
			return s.spyConfigTx(ctx, tx, id, u, patch)
		case "ready":
			id, err := s.spyRefTx(ctx, tx, body, r)
			if err != nil {
				return nil, err
			}
			return s.spyReadyTx(ctx, tx, id, u, spyBoolValue(spyInputValue(body, r, "ready", "1")))
		case "start":
			id, err := s.spyRefTx(ctx, tx, body, r)
			if err != nil {
				return nil, err
			}
			return s.spyStartTx(ctx, tx, id, u)
		case "close":
			id, err := s.spyRefTx(ctx, tx, body, r)
			if err != nil {
				return nil, err
			}
			return s.spyCloseTx(ctx, tx, id, u)
		default:
			return nil, spyError("invalid_action", http.StatusBadRequest)
		}
	})
}

func (s *Server) spyActions(w http.ResponseWriter, r *http.Request) {
	s.spyHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	body := spyInput(r)
	action := strings.ToLower(spyInputValue(body, r, "action", ""))
	s.spyWriteCommand(w, r, body, func(ctx context.Context, tx *sql.Tx, u *user) (map[string]any, error) {
		id, err := s.spyRefTx(ctx, tx, body, r)
		if err != nil {
			return nil, err
		}
		switch action {
		case "sentence":
			return s.spySentenceTx(ctx, tx, id, u, spyInputValue(body, r, "body", ""), spyBoolValue(spyInputValue(body, r, "skip", "0")))
		case "vote":
			return s.spyVoteTx(ctx, tx, id, u, spyNullableSeat(body, r, "to_seat"))
		case "night":
			return s.spyNightTx(ctx, tx, id, u, spyNullableSeat(body, r, "target_seat"))
		case "guess":
			return s.spyGuessTx(ctx, tx, id, u, spyInputValue(body, r, "guess_a", ""), spyInputValue(body, r, "guess_b", ""))
		case "advance":
			return s.spyAdvanceCommandTx(ctx, tx, id, u)
		case "resolve":
			ruling := spyInputValue(body, r, "ruling", "")
			if ruling != "eliminate" && ruling != "revote" && ruling != "pass" {
				return nil, spyError("invalid_params", 400)
			}
			return s.spyResolveTx(ctx, tx, id, u, ruling, spyNullableSeat(body, r, "seat"))
		case "assign":
			seat, ok := spyIntValue(spyInputValue(body, r, "seat", ""))
			if !ok {
				return nil, spyError("invalid_params", 400)
			}
			return s.spyAssignTx(ctx, tx, id, u, seat, spyInputValue(body, r, "role", ""))
		default:
			return nil, spyError("invalid_action", 400)
		}
	})
}

func (s *Server) spyTable(w http.ResponseWriter, r *http.Request) {
	s.spyHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		methodNotAllowed(w, "GET, POST")
		return
	}
	body := spyInput(r)
	u, ok := s.spyOptionalUser(r)
	if !ok {
		spyWriteHTTP(w, spyError("not_login", 401))
		return
	}
	ref := spyInputValue(body, r, "code", "")
	if ref == "" {
		ref = spyInputValue(body, r, "room", "")
	}
	if ref == "" {
		spyWriteHTTP(w, spyError("invalid_params", 400))
		return
	}
	room, err := s.spyLoadRoom(r.Context(), ref, nil)
	if err != nil {
		spyWriteHTTP(w, err)
		return
	}
	seat, err := s.spySeat(r.Context(), room.ID, u.ID, nil)
	if err != nil {
		spyWriteHTTP(w, err)
		return
	}
	referee := seat == nil && room.HostUserID == u.ID
	if seat == nil && !referee && room.Spectate != 1 {
		spyWriteHTTP(w, spyError("spectate_off", 403))
		return
	}
	_ = s.spyTouch(r.Context(), room, seat, u.ID)
	since, _ := spyIntValue(spyInputValue(body, r, "since", "0"))
	if since > 0 && since >= room.Rev {
		spyWriteOK(w, map[string]any{"rev": room.Rev, "changed": false})
		return
	}
	viewerHost := room.HostUserID == u.ID
	snapshot, err := s.spySnapshot(r.Context(), room, seat, referee, since, viewerHost)
	if err != nil {
		spyWriteHTTP(w, err)
		return
	}
	spyWriteOK(w, snapshot)
}

func (s *Server) spyOptionalUser(r *http.Request) (*user, bool) {
	id, _ := s.optionalSessionUser(r)
	if id == nil || s.db == nil {
		return nil, false
	}
	u, err := s.findUser(r.Context(), *id)
	return u, err == nil && u != nil
}

func (s *Server) spyWriteCommand(w http.ResponseWriter, r *http.Request, body map[string]any, fn func(context.Context, *sql.Tx, *user) (map[string]any, error)) {
	u, ok := s.spyOptionalUser(r)
	if !ok {
		spyWriteHTTP(w, spyError("not_login", 401))
		return
	}
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if key == "" {
		key = strings.TrimSpace(stringValue(body["idempotency_key"]))
	}
	if len(key) > 64 {
		key = key[:64]
	}
	if key != "" {
		var raw string
		var expires int64
		if err := s.db.QueryRowContext(r.Context(), "SELECT response, expires_at FROM spy_idempotency WHERE idem_key=?", key).Scan(&raw, &expires); err == nil && expires >= time.Now().Unix() {
			var cached map[string]any
			if json.Unmarshal([]byte(raw), &cached) == nil {
				spyWriteJSON(w, http.StatusOK, cached)
				return
			}
		}
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		spyWriteHTTP(w, fmt.Errorf("%w: %v", spyError("server_error", 500), err))
		return
	}
	payload, runErr := fn(r.Context(), tx, u)
	if runErr != nil {
		_ = tx.Rollback()
		spyWriteHTTP(w, runErr)
		return
	}
	if err := tx.Commit(); err != nil {
		spyWriteHTTP(w, spyError("server_error", 500))
		return
	}
	response := map[string]any{"success": true}
	for k, v := range payload {
		response[k] = v
	}
	if key != "" {
		raw, _ := json.Marshal(response)
		now := time.Now().Unix()
		if s.db.Driver == "mysql" {
			_, _ = s.db.ExecContext(r.Context(), `INSERT INTO spy_idempotency(idem_key,room_id,response,created_at,expires_at) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE response=VALUES(response),created_at=VALUES(created_at),expires_at=VALUES(expires_at)`, key, 0, string(raw), now, now+600)
		} else {
			_, _ = s.db.ExecContext(r.Context(), `INSERT INTO spy_idempotency(idem_key,room_id,response,created_at,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(idem_key) DO UPDATE SET response=excluded.response,created_at=excluded.created_at,expires_at=excluded.expires_at`, key, 0, string(raw), now, now+600)
		}
	}
	spyWriteJSON(w, http.StatusOK, response)
}

func spyWriteOK(w http.ResponseWriter, data map[string]any) {
	response := map[string]any{"success": true}
	for k, v := range data {
		response[k] = v
	}
	spyWriteJSON(w, http.StatusOK, response)
}
func spyWriteHTTP(w http.ResponseWriter, err error) {
	if e, ok := err.(*spyHTTPError); ok {
		body := map[string]any{"success": false, "message": spyMessages[e.key]}
		if body["message"] == "" {
			body["message"] = spyMessages["server_error"]
		}
		for k, v := range e.extra {
			body[k] = v
		}
		spyWriteJSON(w, e.status, body)
		return
	}
	spyWriteJSON(w, 500, map[string]any{"success": false, "message": spyMessages["server_error"]})
}
func spyWriteJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func spyInput(r *http.Request) map[string]any {
	body := map[string]any{}
	if r.Body != nil {
		_ = decodeJSON(r, &body, 2<<20)
	}
	return body
}
func spyInputValue(body map[string]any, r *http.Request, key, fallback string) string {
	if value := r.URL.Query().Get(key); value != "" {
		return value
	}
	if value, ok := body[key]; ok {
		return strings.TrimSpace(fmt.Sprint(value))
	}
	return fallback
}
func spyBoolValue(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	return value == "1" || value == "true" || value == "yes" || value == "on"
}
func spyIntValue(value string) (int64, bool) {
	n, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	return n, err == nil
}
func spyNullableSeat(body map[string]any, r *http.Request, key string) *int64 {
	raw := spyInputValue(body, r, key, "")
	if raw == "" || raw == "null" {
		return nil
	}
	n, ok := spyIntValue(raw)
	if !ok {
		return nil
	}
	return &n
}
func spyClean(value string, max int) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\x00", ""))
	value = strings.Join(strings.Fields(value), " ")
	if len([]rune(value)) > max {
		value = string([]rune(value)[:max])
	}
	return value
}

func (s *Server) spyRefTx(ctx context.Context, tx *sql.Tx, body map[string]any, r *http.Request) (int64, error) {
	ref := spyInputValue(body, r, "code", "")
	if ref == "" {
		ref = spyInputValue(body, r, "room", "")
	}
	if ref == "" {
		ref = spyInputValue(body, r, "room_id", "")
	}
	room, err := s.spyLoadRoom(ctx, ref, tx)
	if err != nil {
		return 0, err
	}
	return room.ID, nil
}
func (s *Server) spyLoadRoom(ctx context.Context, ref string, tx *sql.Tx) (*spyRoom, error) {
	if strings.TrimSpace(ref) == "" {
		return nil, spyError("invalid_params", 400)
	}
	q := `SELECT id,code,name,host_user_id,COALESCE(club_id,0),country,cap,joined,dist_civilian,dist_spy,dist_blank,phase,round,timer_profile,deadline_at,speaker_seat,vote_sealed_at,revote_used,spectate,spectate_delay,need_code,join_code,word_a,word_b,status,winner,host_last_seen_at,rev,last_activity_at FROM spy_rooms WHERE `
	args := []any{}
	if n, ok := spyIntValue(ref); ok && n > 0 {
		q += "id=?"
		args = append(args, n)
	} else {
		q += "code=?"
		args = append(args, strings.ToUpper(ref))
	}
	if tx != nil && s.db.Driver == "mysql" {
		q += " FOR UPDATE"
	}
	var row *sql.Row
	if tx != nil {
		row = tx.QueryRowContext(ctx, q, args...)
	} else {
		row = s.db.QueryRowContext(ctx, q, args...)
	}
	room := &spyRoom{}
	err := row.Scan(&room.ID, &room.Code, &room.Name, &room.HostUserID, &room.ClubID, &room.Country, &room.Cap, &room.Joined, &room.DistCivilian, &room.DistSpy, &room.DistBlank, &room.Phase, &room.Round, &room.TimerProfile, &room.DeadlineAt, &room.SpeakerSeat, &room.VoteSealedAt, &room.RevoteUsed, &room.Spectate, &room.SpectateDelay, &room.NeedCode, &room.JoinCode, &room.WordA, &room.WordB, &room.Status, &room.Winner, &room.HostLastSeenAt, &room.Rev, &room.LastActivityAt)
	if err != nil && isNoRows(err) {
		return nil, spyError("room_not_found", 404)
	}
	if err != nil {
		return nil, err
	}
	return room, nil
}
func (s *Server) spySeats(ctx context.Context, roomID int64, tx *sql.Tx) ([]spySeat, error) {
	q := `SELECT id,room_id,seat,COALESCE(user_id,0),COALESCE(nick,''),COALESCE(avatar,''),COALESCE(role,''),COALESCE(role_preset,''),ready_at,viewed_at,out_round,COALESCE(out_by,''),last_seen_at,0 FROM spy_seats WHERE room_id=? ORDER BY seat`
	var rows *sql.Rows
	var err error
	args := []any{roomID}
	if tx != nil {
		rows, err = tx.QueryContext(ctx, q, args...)
	} else {
		rows, err = s.db.QueryContext(ctx, q, args...)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []spySeat{}
	for rows.Next() {
		var seat spySeat
		if err := rows.Scan(&seat.ID, &seat.RoomID, &seat.Seat, &seat.UserID, &seat.Nick, &seat.Avatar, &seat.Role, &seat.RolePreset, &seat.ReadyAt, &seat.ViewedAt, &seat.OutRound, &seat.OutBy, &seat.LastSeenAt, &seat.JoinedAt); err != nil {
			return nil, err
		}
		result = append(result, seat)
	}
	return result, rows.Err()
}
func (s *Server) spySeat(ctx context.Context, roomID, userID int64, tx *sql.Tx) (*spySeat, error) {
	q := `SELECT id,room_id,seat,COALESCE(user_id,0),COALESCE(nick,''),COALESCE(avatar,''),COALESCE(role,''),COALESCE(role_preset,''),ready_at,viewed_at,out_round,COALESCE(out_by,''),last_seen_at,0 FROM spy_seats WHERE room_id=? AND user_id=?`
	var row *sql.Row
	if tx != nil {
		row = tx.QueryRowContext(ctx, q, roomID, userID)
	} else {
		row = s.db.QueryRowContext(ctx, q, roomID, userID)
	}
	var seat spySeat
	err := row.Scan(&seat.ID, &seat.RoomID, &seat.Seat, &seat.UserID, &seat.Nick, &seat.Avatar, &seat.Role, &seat.RolePreset, &seat.ReadyAt, &seat.ViewedAt, &seat.OutRound, &seat.OutBy, &seat.LastSeenAt, &seat.JoinedAt)
	if err != nil && isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &seat, nil
}
func spyAlive(seat spySeat, round int64) bool {
	return !seat.OutRound.Valid || seat.OutRound.Int64 >= round
}
func spyAliveSeats(seats []spySeat, round int64) []spySeat {
	result := []spySeat{}
	for _, seat := range seats {
		if spyAlive(seat, round) {
			result = append(result, seat)
		}
	}
	return result
}
func spyTargets(seats []spySeat, round int64) []int64 {
	result := []int64{}
	for _, seat := range spyAliveSeats(seats, round) {
		result = append(result, seat.Seat)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}
func spySeatMap(seats []spySeat) map[int64]spySeat {
	result := map[int64]spySeat{}
	for _, seat := range seats {
		result[seat.Seat] = seat
	}
	return result
}
func spyNow() int64 { return time.Now().Unix() }
func spyRequireHost(room *spyRoom, u *user) error {
	if room.HostUserID != u.ID {
		return spyError("not_host", 403)
	}
	return nil
}
func spyRequireWaiting(room *spyRoom) error {
	if room.Status != spyStatusWaiting {
		return spyError("game_started", 409)
	}
	return nil
}
func spyRequirePlaying(room *spyRoom) error {
	if room.Status != spyStatusPlaying {
		return spyError("game_not_started", 409)
	}
	return nil
}
func spyRequireSeat(seat *spySeat) error {
	if seat == nil {
		return spyError("not_member", 403)
	}
	return nil
}
func spyRequireAlive(seat *spySeat) error {
	if seat == nil || seat.OutRound.Valid {
		return spyError("already_out", 409)
	}
	return nil
}

func (s *Server) spyCreateTx(ctx context.Context, tx *sql.Tx, u *user, body map[string]any) (map[string]any, error) {
	cap := int64(8)
	if n, ok := spyIntValue(stringValue(body["cap"])); ok {
		cap = n
	}
	if cap < spyMinPlayers {
		cap = spyMinPlayers
	}
	if cap > spyMaxPlayers {
		cap = spyMaxPlayers
	}
	profile := spyClean(firstNonEmpty(stringValue(body["timer_profile"]), "standard"), 16)
	if profile != "fast" && profile != "standard" && profile != "slow" {
		profile = "standard"
	}
	country := spyClean(firstNonEmpty(stringValue(body["country"]), "china"), 12)
	if country != "japan" {
		country = "china"
	}
	name := firstNonEmpty(spyClean(stringValue(body["name"]), 40), "未命名房间")
	spectate := int64(1)
	if value, ok := body["spectate"]; ok && !boolValue(value) {
		spectate = 0
	}
	needCode := int64(0)
	if boolValue(body["need_code"]) {
		needCode = 1
	}
	delay := int64(60)
	if n, ok := spyIntValue(stringValue(body["spectate_delay"])); ok {
		delay = n
	}
	if delay < 0 {
		delay = 0
	}
	if delay > 600 {
		delay = 600
	}
	now := spyNow()
	code, err := spyNewRoomCode(ctx, tx)
	if err != nil {
		return nil, err
	}
	joinCode := ""
	if needCode == 1 {
		joinCode = spyJoinCode()
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO spy_rooms(code,name,host_user_id,club_id,country,cap,timer_profile,spectate,spectate_delay,need_code,join_code,status,phase,host_last_seen_at,last_activity_at,rev) VALUES(?,?,?,?,?,?,?,?,?,?,?,'waiting','lobby',?,?,1)`, code, name, u.ID, nil, country, cap, profile, spectate, delay, needCode, joinCode, now, now)
	if err != nil {
		return nil, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return nil, err
	}
	if err := spyBumpTx(ctx, tx, id, "room-created", map[string]any{"cap": cap, "timer": profile}); err != nil {
		return nil, err
	}
	return map[string]any{"room_id": id, "code": code, "referee": true}, nil
}
func spyNewRoomCode(ctx context.Context, tx *sql.Tx) (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	for attempt := 0; attempt < 16; attempt++ {
		raw := make([]byte, 6)
		if _, err := rand.Read(raw); err != nil {
			return "", err
		}
		code := make([]byte, 6)
		for i, b := range raw {
			code[i] = alphabet[int(b)%len(alphabet)]
		}
		var exists int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM spy_rooms WHERE code=?", string(code)).Scan(&exists); err != nil {
			return "", err
		}
		if exists == 0 {
			return string(code), nil
		}
	}
	return "", spyError("server_error", 500)
}
func spyJoinCode() string {
	raw := make([]byte, 2)
	if _, err := rand.Read(raw); err != nil {
		return "1000"
	}
	return strconv.Itoa(1000 + (int(raw[0])<<8|int(raw[1]))%9000)
}
func (s *Server) spyJoinTx(ctx context.Context, tx *sql.Tx, id int64, u *user, joinCode string) (map[string]any, error) {
	room, err := s.spyLoadRoom(ctx, strconv.FormatInt(id, 10), tx)
	if err != nil {
		return nil, err
	}
	seat, err := s.spySeat(ctx, id, u.ID, tx)
	if err != nil {
		return nil, err
	}
	if seat != nil {
		_, err = tx.ExecContext(ctx, "UPDATE spy_seats SET last_seen_at=? WHERE room_id=? AND seat=?", spyNow(), id, seat.Seat)
		return map[string]any{"seat": seat.Seat, "rejoined": true, "referee": false}, err
	}
	if err := spyRequireWaiting(room); err != nil {
		return nil, err
	}
	if room.NeedCode == 1 && room.JoinCode != "" && spyClean(joinCode, 16) != room.JoinCode {
		return nil, spyError("join_code_invalid", 403)
	}
	seats, err := s.spySeats(ctx, id, tx)
	if err != nil {
		return nil, err
	}
	if int64(len(seats)) >= room.Cap {
		return nil, spyError("room_full", 409)
	}
	taken := map[int64]bool{}
	for _, row := range seats {
		taken[row.Seat] = true
	}
	newSeat := int64(0)
	for n := int64(1); n <= room.Cap; n++ {
		if !taken[n] {
			newSeat = n
			break
		}
	}
	if newSeat == 0 {
		return nil, spyError("room_full", 409)
	}
	nick := firstNonEmpty(spyClean(u.Nickname, 64), u.Username)
	_, err = tx.ExecContext(ctx, "INSERT INTO spy_seats(room_id,seat,user_id,nick,avatar,last_seen_at) VALUES(?,?,?,?,?,?)", id, newSeat, u.ID, nick, spyClean(u.AvatarURL, 255), spyNow())
	if err != nil {
		return nil, err
	}
	_, err = tx.ExecContext(ctx, "UPDATE spy_rooms SET joined=? WHERE id=?", len(seats)+1, id)
	if err != nil {
		return nil, err
	}
	if err = spyBumpTx(ctx, tx, id, "seat-joined", map[string]any{"seat": newSeat, "nick": nick}); err != nil {
		return nil, err
	}
	return map[string]any{"seat": newSeat, "rejoined": false, "referee": false}, nil
}
func (s *Server) spyLeaveTx(ctx context.Context, tx *sql.Tx, id int64, u *user) (map[string]any, error) {
	room, err := s.spyLoadRoom(ctx, strconv.FormatInt(id, 10), tx)
	if err != nil {
		return nil, err
	}
	if err = spyRequireWaiting(room); err != nil {
		return nil, err
	}
	seat, err := s.spySeat(ctx, id, u.ID, tx)
	if err != nil {
		return nil, err
	}
	if err = spyRequireSeat(seat); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM spy_seats WHERE room_id=? AND seat=?", id, seat.Seat); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE spy_rooms SET joined=(SELECT COUNT(*) FROM spy_seats WHERE room_id=?) WHERE id=?", id, id); err != nil {
		return nil, err
	}
	if err = spyBumpTx(ctx, tx, id, "seat-left", map[string]any{"seat": seat.Seat}); err != nil {
		return nil, err
	}
	return map[string]any{"seat": seat.Seat}, nil
}
func (s *Server) spyConfigTx(ctx context.Context, tx *sql.Tx, id int64, u *user, body map[string]any) (map[string]any, error) {
	room, err := s.spyLoadRoom(ctx, strconv.FormatInt(id, 10), tx)
	if err != nil {
		return nil, err
	}
	if err = spyRequireHost(room, u); err != nil {
		return nil, err
	}
	if err = spyRequireWaiting(room); err != nil {
		return nil, err
	}
	sets := []string{}
	args := []any{}
	if value, ok := body["name"]; ok {
		sets = append(sets, "name=?")
		args = append(args, firstNonEmpty(spyClean(stringValue(value), 40), "未命名房间"))
	}
	if value, ok := body["cap"]; ok {
		n, _ := spyIntValue(stringValue(value))
		if n < spyMinPlayers {
			n = spyMinPlayers
		}
		if n > spyMaxPlayers {
			n = spyMaxPlayers
		}
		seats, _ := s.spySeats(ctx, id, tx)
		if n < int64(len(seats)) {
			return nil, spyError("room_full", 409)
		}
		sets = append(sets, "cap=?")
		args = append(args, n)
	}
	for _, key := range []string{"timer_profile", "country", "word_a", "word_b"} {
		if value, ok := body[key]; ok {
			v := spyClean(stringValue(value), 64)
			if key == "timer_profile" && (v != "fast" && v != "standard" && v != "slow") {
				return nil, spyError("invalid_params", 400)
			}
			if key == "country" && v != "china" && v != "japan" {
				return nil, spyError("invalid_params", 400)
			}
			sets = append(sets, key+"=?")
			args = append(args, v)
		}
	}
	for _, key := range []string{"spectate", "need_code"} {
		if value, ok := body[key]; ok {
			sets = append(sets, key+"=?")
			args = append(args, boolInt(boolValue(value)))
		}
	}
	if value, ok := body["spectate_delay"]; ok {
		n, _ := spyIntValue(stringValue(value))
		if n < 0 {
			n = 0
		}
		if n > 600 {
			n = 600
		}
		sets = append(sets, "spectate_delay=?")
		args = append(args, n)
	}
	for _, key := range []string{"dist_civilian", "dist_spy", "dist_blank"} {
		if value, ok := body[key]; ok {
			n, _ := spyIntValue(stringValue(value))
			if n < 0 {
				n = 0
			}
			if n > spyMaxPlayers {
				n = spyMaxPlayers
			}
			sets = append(sets, key+"=?")
			args = append(args, n)
		}
	}
	if len(sets) == 0 {
		return map[string]any{"changed": []any{}}, nil
	}
	if needCode, ok := body["need_code"]; ok && boolValue(needCode) && room.JoinCode == "" {
		sets = append(sets, "join_code=?")
		args = append(args, spyJoinCode())
	}
	args = append(args, id)
	if _, err := tx.ExecContext(ctx, "UPDATE spy_rooms SET "+strings.Join(sets, ", ")+" WHERE id=?", args...); err != nil {
		return nil, err
	}
	names := make([]any, len(sets))
	for i, v := range sets {
		names[i] = strings.Split(v, "=")[0]
	}
	if err := spyBumpTx(ctx, tx, id, "room-config", map[string]any{"changed": names}); err != nil {
		return nil, err
	}
	return map[string]any{"changed": names}, nil
}
func (s *Server) spyReadyTx(ctx context.Context, tx *sql.Tx, id int64, u *user, ready bool) (map[string]any, error) {
	room, err := s.spyLoadRoom(ctx, strconv.FormatInt(id, 10), tx)
	if err != nil {
		return nil, err
	}
	if err = spyRequireWaiting(room); err != nil {
		return nil, err
	}
	seat, err := s.spySeat(ctx, id, u.ID, tx)
	if err != nil {
		return nil, err
	}
	if err = spyRequireSeat(seat); err != nil {
		return nil, err
	}
	value := int64(0)
	if ready {
		value = spyNow()
	}
	_, err = tx.ExecContext(ctx, "UPDATE spy_seats SET ready_at=? WHERE room_id=? AND seat=?", value, id, seat.Seat)
	if err != nil {
		return nil, err
	}
	if err = spyBumpTx(ctx, tx, id, "seat-ready", map[string]any{"seat": seat.Seat, "ready": boolInt(ready)}); err != nil {
		return nil, err
	}
	return map[string]any{"seat": seat.Seat, "ready": ready}, nil
}

func (s *Server) spyAssignTx(ctx context.Context, tx *sql.Tx, id int64, u *user, seat int64, role string) (map[string]any, error) {
	room, err := s.spyLoadRoom(ctx, strconv.FormatInt(id, 10), tx)
	if err != nil {
		return nil, err
	}
	if err = spyRequireHost(room, u); err != nil {
		return nil, err
	}
	if err = spyRequireWaiting(room); err != nil {
		return nil, err
	}
	if role != "" && role != spyRoleCivilian && role != spyRoleSpy && role != spyRoleBlank {
		return nil, spyError("invalid_params", 400)
	}
	rows, err := s.spySeats(ctx, id, tx)
	if err != nil {
		return nil, err
	}
	found := false
	for _, row := range rows {
		if row.Seat == seat {
			found = true
		}
	}
	if !found {
		return nil, spyError("seat_not_found", 404)
	}
	if _, err = tx.ExecContext(ctx, "UPDATE spy_seats SET role_preset=? WHERE room_id=? AND seat=?", role, id, seat); err != nil {
		return nil, err
	}
	if err = spyBumpTx(ctx, tx, id, "seat-preset", map[string]any{"seat": seat, "role": role}); err != nil {
		return nil, err
	}
	return map[string]any{"seat": seat, "role": role}, nil
}

func spyDefaultDist(players int64) (map[string]int64, bool) {
	table := map[int64][3]int64{4: {3, 1, 0}, 5: {4, 1, 0}, 6: {4, 1, 1}, 7: {5, 1, 1}, 8: {5, 2, 1}, 9: {6, 2, 1}, 10: {7, 2, 1}, 11: {7, 2, 2}, 12: {8, 2, 2}}
	v, ok := table[players]
	if !ok {
		return nil, false
	}
	return map[string]int64{"civilian": v[0], "spy": v[1], "blank": v[2]}, true
}
func spyValidateDist(players int64, d map[string]int64) bool {
	return d["civilian"]+d["spy"]+d["blank"] == players && d["civilian"] >= 1 && d["spy"] >= 1 && d["blank"] >= 0
}
func (s *Server) spyStartTx(ctx context.Context, tx *sql.Tx, id int64, u *user) (map[string]any, error) {
	room, err := s.spyLoadRoom(ctx, strconv.FormatInt(id, 10), tx)
	if err != nil {
		return nil, err
	}
	if err = spyRequireHost(room, u); err != nil {
		return nil, err
	}
	if room.Status == spyStatusPlaying {
		return nil, spyError("game_started", 409)
	}
	if room.Status == spyStatusEnded {
		return nil, spyError("room_closed", 409)
	}
	seats, err := s.spySeats(ctx, id, tx)
	if err != nil {
		return nil, err
	}
	players := int64(len(seats))
	if players < spyMinPlayers {
		return nil, spyError("players_not_enough", 409)
	}
	d, ok := spyDefaultDist(players)
	if !ok {
		d = map[string]int64{"civilian": room.DistCivilian, "spy": room.DistSpy, "blank": room.DistBlank}
	}
	presets := map[int64]string{}
	counts := map[string]int64{}
	for _, seat := range seats {
		if seat.RolePreset != "" {
			presets[seat.Seat] = seat.RolePreset
			counts[seat.RolePreset]++
		}
	}
	for _, role := range []string{spyRoleSpy, spyRoleBlank} {
		if counts[role] > d[role] {
			d[role] = counts[role]
		}
	}
	d["civilian"] = players - d["spy"] - d["blank"]
	if !spyValidateDist(players, d) {
		return nil, spyError("distribution_invalid", 409)
	}
	roles := []string{}
	for i := int64(0); i < d["civilian"]; i++ {
		roles = append(roles, spyRoleCivilian)
	}
	for i := int64(0); i < d["spy"]; i++ {
		roles = append(roles, spyRoleSpy)
	}
	for i := int64(0); i < d["blank"]; i++ {
		roles = append(roles, spyRoleBlank)
	}
	spyShuffle(roles)
	for _, seat := range seats {
		role := presets[seat.Seat]
		if role == "" {
			role = roles[0]
			roles = roles[1:]
		}
		if _, err := tx.ExecContext(ctx, "UPDATE spy_seats SET role=?,role_preset=?,out_round=NULL,out_by='' WHERE room_id=? AND seat=?", role, presets[seat.Seat], id, seat.Seat); err != nil {
			return nil, err
		}
	}
	if err := s.spyDealWordTx(ctx, tx, id, room); err != nil {
		return nil, err
	}
	for _, table := range []string{"spy_round_outcomes", "spy_sentences", "spy_votes", "spy_night_actions", "spy_blank_guesses", "spy_results"} {
		if _, err := tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE room_id=?", id); err != nil {
			return nil, err
		}
	}
	now := spyNow()
	if _, err := tx.ExecContext(ctx, "UPDATE spy_rooms SET status='playing',phase='day',round=1,dist_civilian=?,dist_spy=?,dist_blank=?,winner='',revote_used=0,joined=? WHERE id=?", d["civilian"], d["spy"], d["blank"], players, id); err != nil {
		return nil, err
	}
	if err := s.spyOpenPhaseTx(ctx, tx, id); err != nil {
		return nil, err
	}
	if err := spyBumpTx(ctx, tx, id, "game-started", map[string]any{"players": players}); err != nil {
		return nil, err
	}
	_ = now
	return map[string]any{"players": players, "distribution": d}, nil
}
func spyShuffle(values []string) {
	for i := len(values) - 1; i > 0; i-- {
		raw := make([]byte, 1)
		if _, err := rand.Read(raw); err != nil {
			continue
		}
		j := int(raw[0]) % (i + 1)
		values[i], values[j] = values[j], values[i]
	}
}
func (s *Server) spyDealWordTx(ctx context.Context, tx *sql.Tx, id int64, room *spyRoom) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM spy_words WHERE room_id=?", id); err != nil {
		return err
	}
	if room.WordA != "" || room.WordB != "" {
		if room.WordA == "" || room.WordB == "" {
			return spyError("invalid_params", 400)
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO spy_words(room_id,pair_id,civilian_word,spy_word,difficulty,similarity,dealt_at) VALUES(?,0,?,?,?, ?,?)`, id, room.WordA, room.WordB, "custom", "custom", spyNow())
		return err
	}
	if err := spySeedWords(ctx, tx); err != nil {
		return err
	}
	var word spyWord
	var pairID int64
	err := tx.QueryRowContext(ctx, `SELECT id,a,b,level,similarity FROM spy_word_pairs WHERE enabled=1 ORDER BY used_count,id LIMIT 1`).Scan(&pairID, &word.Civilian, &word.Spy, &word.Difficulty, &word.Similarity)
	if err != nil {
		if err != nil && isNoRows(err) {
			return spyError("word_bank_empty", 500)
		}
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO spy_words(room_id,pair_id,civilian_word,spy_word,difficulty,similarity,dealt_at) VALUES(?,?,?,?,?,?,?)`, id, pairID, word.Civilian, word.Spy, word.Difficulty, word.Similarity, spyNow()); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "UPDATE spy_word_pairs SET used_count=used_count+1 WHERE a=? AND b=?", word.Civilian, word.Spy)
	return err
}
func spySeedWords(ctx context.Context, tx *sql.Tx) error {
	var count int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM spy_word_pairs").Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	pairs := [][4]string{{"视觉小说", "轻小说", "mid", "near"}, {"冰淇淋", "雪糕", "easy", "near"}, {"微信", "QQ", "easy", "mid"}, {"猫", "老虎", "easy", "mid"}, {"咖啡", "奶茶", "easy", "near"}, {"小说", "散文", "mid", "far"}, {"地铁", "轻轨", "easy", "near"}, {"大学老师", "高中老师", "mid", "near"}, {"香水", "花露水", "mid", "mid"}, {"牛奶", "豆浆", "easy", "near"}, {"吉他", "贝斯", "mid", "near"}, {"原神", "崩坏：星穹铁道", "mid", "mid"}}
	for _, p := range pairs {
		if _, err := tx.ExecContext(ctx, "INSERT INTO spy_word_pairs(a,b,level,similarity,used_count,enabled) VALUES(?,?,?,?,0,1)", p[0], p[1], p[2], p[3]); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) spyOpenPhaseTx(ctx context.Context, tx *sql.Tx, id int64) error {
	room, err := s.spyLoadRoom(ctx, strconv.FormatInt(id, 10), tx)
	if err != nil {
		return err
	}
	seats, err := s.spySeats(ctx, id, tx)
	if err != nil {
		return err
	}
	seconds := spyPhaseSeconds(room.TimerProfile, room.Phase, int64(len(spyAliveSeats(seats, room.Round))))
	speaker := int64(0)
	if room.Phase == spyPhaseDay {
		alive := spyTargets(seats, room.Round)
		if len(alive) > 0 {
			speaker = alive[(int(room.Round)-1)%len(alive)]
		}
	}
	deadline := int64(0)
	if room.Phase != "lobby" && room.Phase != spyPhaseOver {
		deadline = spyNow() + seconds
	}
	_, err = tx.ExecContext(ctx, "UPDATE spy_rooms SET deadline_at=?,speaker_seat=? WHERE id=?", deadline, speaker, id)
	return err
}
func spyPhaseSeconds(profile, phase string, alive int64) int64 {
	table := map[string]map[string]int64{"fast": {spyPhaseDay: 25, spyPhaseDiscuss: 90, spyPhaseVote: 40, spyPhaseNight: 30}, "standard": {spyPhaseDay: 40, spyPhaseDiscuss: 180, spyPhaseVote: 60, spyPhaseNight: 45}, "slow": {spyPhaseDay: 60, spyPhaseDiscuss: 300, spyPhaseVote: 90, spyPhaseNight: 60}}
	v := table[profile]
	if v == nil {
		v = table["standard"]
	}
	seconds := v[phase]
	if seconds == 0 {
		seconds = v[spyPhaseDiscuss]
	}
	if phase == spyPhaseDay {
		seconds *= maxInt64(1, alive)
	}
	return maxInt64(1, seconds)
}
func spyNextPhase(phase string, round int64) (string, int64) {
	switch phase {
	case spyPhaseDay:
		return spyPhaseDiscuss, round
	case spyPhaseDiscuss:
		return spyPhaseVote, round
	case spyPhaseVote:
		return spyPhaseNight, round
	case spyPhaseNight:
		return spyPhaseDay, round + 1
	}
	return spyPhaseOver, round
}
func spyNormalizeWord(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(value)), ""))
}

func (s *Server) spySentenceTx(ctx context.Context, tx *sql.Tx, id int64, u *user, text string, skip bool) (map[string]any, error) {
	room, seat, seats, err := s.spyContextTx(ctx, tx, id, u.ID)
	if err != nil {
		return nil, err
	}
	_ = seats
	if err = spyRequirePlaying(room); err != nil {
		return nil, err
	}
	if room.Phase != spyPhaseDay {
		return nil, spyError("phase_wrong", 409)
	}
	if err = spyRequireAlive(seat); err != nil {
		return nil, err
	}
	if seat.Seat != room.SpeakerSeat {
		return nil, spyError("not_your_turn", 409)
	}
	round := room.Round
	body := spyClean(text, 120)
	if skip {
		body = ""
	} else {
		if body == "" {
			return nil, spyError("sentence_empty", 400)
		}
		if len([]rune(body)) > 40 {
			return nil, spyError("sentence_too_long", 400)
		}
		word, err := s.spyMyWordTx(ctx, tx, id, seat.Role)
		if err != nil {
			return nil, err
		}
		if word != "" && strings.Contains(spyNormalizeWord(body), spyNormalizeWord(word)) {
			return nil, spyError("word_spill", 400)
		}
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO spy_sentences(room_id,round,seat,body,skipped,submitted_at) VALUES(?,?,?,?,?,?)", id, round, seat.Seat, body, boolInt(!(!skip)), spyNow())
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") || strings.Contains(strings.ToLower(err.Error()), "constraint") {
			return map[string]any{"seat": seat.Seat, "replay": true, "advanced": nil}, nil
		}
		return nil, err
	}
	if err = spyBumpTx(ctx, tx, id, "sentence", map[string]any{"seat": seat.Seat, "round": round, "skipped": boolInt(skip)}); err != nil {
		return nil, err
	}
	rows, err := s.spySeats(ctx, id, tx)
	if err != nil {
		return nil, err
	}
	order := spyTargets(rows, round)
	done := true
	for _, n := range order {
		var exists int
		_ = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM spy_sentences WHERE room_id=? AND round=? AND seat=?", id, round, n).Scan(&exists)
		if exists == 0 {
			done = false
			break
		}
	}
	if done {
		if _, err := s.spyAdvanceTx(ctx, tx, id, "speakers-done"); err != nil {
			return nil, err
		}
	} else {
		for _, n := range order {
			var exists int
			_ = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM spy_sentences WHERE room_id=? AND round=? AND seat=?", id, round, n).Scan(&exists)
			if exists == 0 {
				_, err = tx.ExecContext(ctx, "UPDATE spy_rooms SET speaker_seat=? WHERE id=?", n, id)
				break
			}
		}
	}
	return map[string]any{"seat": seat.Seat, "replay": false, "advanced": nil}, err
}

func (s *Server) spyVoteTx(ctx context.Context, tx *sql.Tx, id int64, u *user, target *int64) (map[string]any, error) {
	room, seat, seats, err := s.spyContextTx(ctx, tx, id, u.ID)
	if err != nil {
		return nil, err
	}
	if err = spyRequirePlaying(room); err != nil {
		return nil, err
	}
	if room.Phase != spyPhaseVote {
		return nil, spyError("phase_wrong", 409)
	}
	if err = spyRequireAlive(seat); err != nil {
		return nil, err
	}
	tie, err := s.spyTieOpenTx(ctx, tx, room)
	if err != nil {
		return nil, err
	}
	if tie {
		return nil, spyError("vote_already_settled", 409)
	}
	var exists int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM spy_votes WHERE room_id=? AND round=? AND from_seat=?", id, room.Round, seat.Seat).Scan(&exists); err != nil {
		return nil, err
	}
	if exists > 0 {
		return nil, spyError("already_voted", 409)
	}
	if target != nil {
		valid := false
		for _, row := range spyAliveSeats(seats, room.Round) {
			if row.Seat == *target && row.Seat != seat.Seat {
				valid = true
			}
		}
		if !valid {
			return nil, spyError("vote_target_invalid", 400)
		}
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO spy_votes(room_id,round,from_seat,to_seat,sealed,submitted_at) VALUES(?,?,?,?,0,?)", id, room.Round, seat.Seat, target, spyNow()); err != nil {
		return nil, err
	}
	if err = spyBumpTx(ctx, tx, id, "vote-cast", map[string]any{"seat": seat.Seat, "round": room.Round}); err != nil {
		return nil, err
	}
	var count int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM spy_votes WHERE room_id=? AND round=?", id, room.Round).Scan(&count); err != nil {
		return nil, err
	}
	alive := len(spyAliveSeats(seats, room.Round))
	if count >= alive {
		if _, err = s.spyAdvanceTx(ctx, tx, id, "votes-complete"); err != nil {
			return nil, err
		}
	}
	return map[string]any{"seat": seat.Seat, "advanced": nil}, nil
}
func (s *Server) spyNightTx(ctx context.Context, tx *sql.Tx, id int64, u *user, target *int64) (map[string]any, error) {
	room, seat, seats, err := s.spyContextTx(ctx, tx, id, u.ID)
	if err != nil {
		return nil, err
	}
	if err = spyRequirePlaying(room); err != nil {
		return nil, err
	}
	if room.Phase != spyPhaseNight {
		return nil, spyError("phase_wrong", 409)
	}
	if err = spyRequireAlive(seat); err != nil {
		return nil, err
	}
	var exists int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM spy_night_actions WHERE room_id=? AND round=? AND from_seat=?", id, room.Round, seat.Seat).Scan(&exists); err != nil {
		return nil, err
	}
	if exists > 0 {
		return nil, spyError("already_voted", 409)
	}
	if target != nil {
		valid := false
		for _, row := range spyAliveSeats(seats, room.Round) {
			if row.Seat == *target {
				valid = true
			}
		}
		if !valid {
			return nil, spyError("vote_target_invalid", 400)
		}
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO spy_night_actions(room_id,round,from_seat,target_seat,submitted_at) VALUES(?,?,?,?,?)", id, room.Round, seat.Seat, target, spyNow()); err != nil {
		return nil, err
	}
	if err = spyBumpTx(ctx, tx, id, "night-action", map[string]any{"round": room.Round}); err != nil {
		return nil, err
	}
	var submitted int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM spy_night_actions a JOIN spy_seats s ON s.room_id=a.room_id AND s.seat=a.from_seat WHERE a.room_id=? AND a.round=? AND s.role=? AND (s.out_round IS NULL OR s.out_round>=?)", id, room.Round, spyRoleSpy, room.Round).Scan(&submitted); err != nil {
		return nil, err
	}
	var spies int
	for _, row := range seats {
		if row.Role == spyRoleSpy && spyAlive(row, room.Round) {
			spies++
		}
	}
	if spies > 0 && submitted >= spies {
		if _, err = s.spyAdvanceTx(ctx, tx, id, "night-complete"); err != nil {
			return nil, err
		}
	}
	return map[string]any{"seat": seat.Seat, "advanced": nil}, nil
}
func (s *Server) spyGuessTx(ctx context.Context, tx *sql.Tx, id int64, u *user, a, b string) (map[string]any, error) {
	room, seat, _, err := s.spyContextTx(ctx, tx, id, u.ID)
	if err != nil {
		return nil, err
	}
	if err = spyRequirePlaying(room); err != nil {
		return nil, err
	}
	if seat.Role != spyRoleBlank {
		return nil, spyError("not_blank", 403)
	}
	if seat.OutRound.Valid {
		return nil, spyError("already_out", 409)
	}
	var exists int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM spy_blank_guesses WHERE room_id=? AND seat=?", id, seat.Seat).Scan(&exists); err != nil {
		return nil, err
	}
	if exists > 0 {
		return nil, spyError("guess_exists", 409)
	}
	word, err := s.spyWordTx(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	a, b = spyClean(a, 64), spyClean(b, 64)
	na, nb := spyNormalizeWord(a), spyNormalizeWord(b)
	nc, ns := spyNormalizeWord(word.Civilian), spyNormalizeWord(word.Spy)
	hitA := na == nc || na == ns
	hitB := nb == nc || nb == ns
	all := (na == nc || nb == nc) && (na == ns || nb == ns)
	result := "miss"
	if all {
		result = "only-one"
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO spy_blank_guesses(room_id,round,seat,guess_a,guess_b,hit_a,hit_b,result,host_confirmed,created_at) VALUES(?,?,?,?,?,?,?, ?,1,?)", id, room.Round, seat.Seat, a, b, boolInt(hitA), boolInt(hitB), result, spyNow()); err != nil {
		return nil, err
	}
	if err = spyBumpTx(ctx, tx, id, "blank-guess", map[string]any{"seat": seat.Seat, "round": room.Round}); err != nil {
		return nil, err
	}
	ended := false
	if all {
		if err = s.spyFinishTx(ctx, tx, id, "blank", "白板猜中两个词，单独获胜。"); err != nil {
			return nil, err
		}
		ended = true
	}
	return map[string]any{"seat": seat.Seat, "result": result, "ended": ended}, nil
}

func (s *Server) spyAdvanceCommandTx(ctx context.Context, tx *sql.Tx, id int64, u *user) (map[string]any, error) {
	room, err := s.spyLoadRoom(ctx, strconv.FormatInt(id, 10), tx)
	if err != nil {
		return nil, err
	}
	if err = spyRequireHost(room, u); err != nil {
		return nil, err
	}
	if err = spyRequirePlaying(room); err != nil {
		return nil, err
	}
	if room.Phase == "lobby" || room.Phase == spyPhaseOver {
		return nil, spyError("phase_wrong", 409)
	}
	return s.spyAdvanceTx(ctx, tx, id, "host")
}
func (s *Server) spyAdvanceTx(ctx context.Context, tx *sql.Tx, id int64, trigger string) (map[string]any, error) {
	room, err := s.spyLoadRoom(ctx, strconv.FormatInt(id, 10), tx)
	if err != nil {
		return nil, err
	}
	if room.Status != spyStatusPlaying {
		return map[string]any{"phase": room.Phase, "round": room.Round, "ended": room.Status == spyStatusEnded, "winner": nullString(room.Winner), "tie": false}, nil
	}
	tie := false
	var out any
	if room.Phase == spyPhaseVote {
		tie, out, err = s.spySettleVoteTx(ctx, tx, room)
		if err != nil {
			return nil, err
		}
	} else if room.Phase == spyPhaseNight {
		if err = s.spySettleNightTx(ctx, tx, room); err != nil {
			return nil, err
		}
	}
	room, err = s.spyLoadRoom(ctx, strconv.FormatInt(id, 10), tx)
	if err != nil {
		return nil, err
	}
	if room.Status != spyStatusPlaying {
		return map[string]any{"phase": spyPhaseOver, "round": room.Round, "ended": true, "winner": nullString(room.Winner), "tie": false}, nil
	}
	win := s.spyEvaluateWin(ctx, tx, room.ID)
	if win["over"].(bool) {
		winner := win["winner"].(string)
		if err = s.spyFinishTx(ctx, tx, id, winner, win["reason"].(string)); err != nil {
			return nil, err
		}
		return map[string]any{"phase": spyPhaseOver, "round": room.Round, "ended": true, "winner": winner, "tie": false}, nil
	}
	if tie {
		if err = spyBumpTx(ctx, tx, id, "vote-tie", map[string]any{"round": room.Round, "trigger": trigger}); err != nil {
			return nil, err
		}
		return map[string]any{"phase": spyPhaseVote, "round": room.Round, "ended": false, "winner": nil, "tie": true}, nil
	}
	next, nextRound := spyNextPhase(room.Phase, room.Round)
	if _, err = tx.ExecContext(ctx, "UPDATE spy_rooms SET phase=?,round=? WHERE id=?", next, nextRound, id); err != nil {
		return nil, err
	}
	if err = s.spyOpenPhaseTx(ctx, tx, id); err != nil {
		return nil, err
	}
	if err = spyBumpTx(ctx, tx, id, "phase", map[string]any{"phase": next, "round": nextRound, "trigger": trigger, "out": out}); err != nil {
		return nil, err
	}
	return map[string]any{"phase": next, "round": nextRound, "ended": false, "winner": nil, "tie": false}, nil
}
func (s *Server) spySettleVoteTx(ctx context.Context, tx *sql.Tx, room *spyRoom) (bool, any, error) {
	var existing int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM spy_round_outcomes WHERE room_id=? AND round=? AND stage='vote'", room.ID, room.Round).Scan(&existing); err != nil {
		return false, nil, err
	}
	if existing > 0 {
		return false, nil, nil
	}
	seats, err := s.spySeats(ctx, room.ID, tx)
	if err != nil {
		return false, nil, err
	}
	targets := spyTargets(seats, room.Round)
	rows, err := tx.QueryContext(ctx, "SELECT from_seat,to_seat FROM spy_votes WHERE room_id=? AND round=?", room.ID, room.Round)
	if err != nil {
		return false, nil, err
	}
	defer rows.Close()
	counts := map[int64]int64{}
	for _, n := range targets {
		counts[n] = 0
	}
	abstain := int64(0)
	cast := int64(0)
	for rows.Next() {
		var from int64
		var to sql.NullInt64
		if err := rows.Scan(&from, &to); err != nil {
			return false, nil, err
		}
		if !to.Valid {
			abstain++
			continue
		}
		if to.Int64 == from {
			continue
		}
		if _, ok := counts[to.Int64]; ok {
			counts[to.Int64]++
			cast++
		}
	}
	ordered := make([]int64, 0, len(targets))
	for n := range counts {
		ordered = append(ordered, n)
	}
	sort.Slice(ordered, func(i, j int) bool {
		if counts[ordered[i]] == counts[ordered[j]] {
			return ordered[i] < ordered[j]
		}
		return counts[ordered[i]] > counts[ordered[j]]
	})
	top := int64(0)
	if len(ordered) > 0 {
		top = counts[ordered[0]]
	}
	leaders := []int64{}
	for _, n := range ordered {
		if counts[n] == top {
			leaders = append(leaders, n)
		}
	}
	tie := top >= 1 && len(leaders) > 1
	var eliminated any
	var role string
	if top >= 1 && !tie {
		eliminated = leaders[0]
		for _, seat := range seats {
			if seat.Seat == leaders[0] {
				role = seat.Role
			}
		}
		if _, err = tx.ExecContext(ctx, "UPDATE spy_seats SET out_round=?,out_by='vote' WHERE room_id=? AND seat=?", room.Round, room.ID, leaders[0]); err != nil {
			return false, nil, err
		}
	}
	tallyRows := []map[string]any{}
	for _, n := range ordered {
		tallyRows = append(tallyRows, map[string]any{"seat": n, "votes": counts[n]})
	}
	tally, _ := json.Marshal(map[string]any{"rows": tallyRows, "abstain": abstain, "cast": cast})
	if _, err = tx.ExecContext(ctx, "INSERT INTO spy_round_outcomes(room_id,round,stage,eliminated_seat,eliminated_role,out_by,tie,host_ruling,tally,created_at) VALUES(?,?,?,?,?,?,?, '',?,?)", room.ID, room.Round, "vote", eliminated, role, func() string {
		if eliminated != nil {
			return "vote"
		}
		return ""
	}(), boolInt(tie), string(tally), spyNow()); err != nil {
		return false, nil, err
	}
	_, err = tx.ExecContext(ctx, "UPDATE spy_rooms SET vote_sealed_at=? WHERE id=?", spyNow(), room.ID)
	return tie, eliminated, err
}
func (s *Server) spySettleNightTx(ctx context.Context, tx *sql.Tx, room *spyRoom) error {
	var existing int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM spy_round_outcomes WHERE room_id=? AND round=? AND stage='night'", room.ID, room.Round).Scan(&existing); err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}
	seats, err := s.spySeats(ctx, room.ID, tx)
	if err != nil {
		return err
	}
	roles := spySeatMap(seats)
	rows, err := tx.QueryContext(ctx, "SELECT from_seat,target_seat FROM spy_night_actions WHERE room_id=? AND round=?", room.ID, room.Round)
	if err != nil {
		return err
	}
	defer rows.Close()
	knife := map[int64]int64{}
	self := []int64{}
	targets := map[int64]bool{}
	for _, n := range spyTargets(seats, room.Round) {
		targets[n] = true
	}
	for rows.Next() {
		var from int64
		var target sql.NullInt64
		if err := rows.Scan(&from, &target); err != nil {
			return err
		}
		if !target.Valid || !targets[target.Int64] {
			continue
		}
		if roles[from].Role != spyRoleSpy {
			self = append(self, from)
		} else {
			knife[target.Int64]++
		}
	}
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
		if _, err = tx.ExecContext(ctx, "UPDATE spy_seats SET out_round=?,out_by='kill' WHERE room_id=? AND seat=?", room.Round, room.ID, killed); err != nil {
			return err
		}
	}
	selfUnique := []int64{}
	for _, n := range self {
		if n != killed && !containsInt64(selfUnique, n) {
			selfUnique = append(selfUnique, n)
			if _, err = tx.ExecContext(ctx, "UPDATE spy_seats SET out_round=?,out_by='self-kill' WHERE room_id=? AND seat=?", room.Round, room.ID, n); err != nil {
				return err
			}
		}
	}
	out := any(nil)
	by := ""
	if killed > 0 {
		out = killed
		by = "kill"
	} else if len(selfUnique) > 0 {
		out = selfUnique[0]
		by = "self-kill"
	}
	tally, _ := json.Marshal(map[string]any{"killed": func() []int64 {
		if killed > 0 {
			return []int64{killed}
		}
		return []int64{}
	}(), "self_kills": selfUnique})
	_, err = tx.ExecContext(ctx, "INSERT INTO spy_round_outcomes(room_id,round,stage,eliminated_seat,eliminated_role,out_by,tie,host_ruling,tally,created_at) VALUES(?,?,?,?,?,'',0,'',?,?)", room.ID, room.Round, "night", out, func() string {
		if killed > 0 {
			return roles[killed].Role
		}
		if len(selfUnique) > 0 {
			return roles[selfUnique[0]].Role
		}
		return ""
	}(), string(tally), spyNow())
	_ = by
	return err
}
func containsInt64(values []int64, target int64) bool {
	for _, v := range values {
		if v == target {
			return true
		}
	}
	return false
}

func (s *Server) spyContextTx(ctx context.Context, tx *sql.Tx, id, userID int64) (*spyRoom, *spySeat, []spySeat, error) {
	room, err := s.spyLoadRoom(ctx, strconv.FormatInt(id, 10), tx)
	if err != nil {
		return nil, nil, nil, err
	}
	seat, err := s.spySeat(ctx, id, userID, tx)
	if err != nil {
		return nil, nil, nil, err
	}
	seats, err := s.spySeats(ctx, id, tx)
	return room, seat, seats, err
}
func (s *Server) spyTieOpenTx(ctx context.Context, tx *sql.Tx, room *spyRoom) (bool, error) {
	if room.Phase != spyPhaseVote {
		return false, nil
	}
	var tie int
	var eliminated sql.NullInt64
	err := tx.QueryRowContext(ctx, "SELECT tie,eliminated_seat FROM spy_round_outcomes WHERE room_id=? AND round=? AND stage='vote'", room.ID, room.Round).Scan(&tie, &eliminated)
	if err != nil && isNoRows(err) {
		return false, nil
	}
	return tie == 1 && !eliminated.Valid, err
}
func spyBumpTx(ctx context.Context, tx *sql.Tx, id int64, kind string, payload map[string]any) error {
	now := spyNow()
	if _, err := tx.ExecContext(ctx, "UPDATE spy_rooms SET rev=rev+1,last_activity_at=? WHERE id=?", now, id); err != nil {
		return err
	}
	var rev int64
	if err := tx.QueryRowContext(ctx, "SELECT rev FROM spy_rooms WHERE id=?", id).Scan(&rev); err != nil {
		return err
	}
	raw, _ := json.Marshal(payload)
	_, err := tx.ExecContext(ctx, "INSERT INTO spy_events(room_id,rev,kind,payload,created_at) VALUES(?,?,?,?,?)", id, rev, kind, string(raw), now)
	return err
}
func (s *Server) spyTouch(ctx context.Context, room *spyRoom, seat *spySeat, userID int64) error {
	now := spyNow()
	if seat != nil {
		_, _ = s.db.ExecContext(ctx, "UPDATE spy_seats SET last_seen_at=? WHERE room_id=? AND seat=? AND last_seen_at<?", now, room.ID, seat.Seat, now-spyHeartbeatMin)
	}
	if room.HostUserID == userID {
		_, _ = s.db.ExecContext(ctx, "UPDATE spy_rooms SET host_last_seen_at=? WHERE id=? AND host_last_seen_at<?", now, room.ID, now-spyHeartbeatMin)
	}
	return nil
}

func (s *Server) spyMyWordTx(ctx context.Context, tx *sql.Tx, id int64, role string) (string, error) {
	word, err := s.spyWordTx(ctx, tx, id)
	if err != nil {
		return "", err
	}
	if role == spyRoleSpy {
		return word.Spy, nil
	}
	if role == spyRoleCivilian {
		return word.Civilian, nil
	}
	return "", nil
}
func (s *Server) spyWordTx(ctx context.Context, tx *sql.Tx, id int64) (spyWord, error) {
	var row *sql.Row
	if tx != nil {
		row = tx.QueryRowContext(ctx, "SELECT civilian_word,spy_word,difficulty,similarity FROM spy_words WHERE room_id=?", id)
	} else {
		row = s.db.QueryRowContext(ctx, "SELECT civilian_word,spy_word,difficulty,similarity FROM spy_words WHERE room_id=?", id)
	}
	var result spyWord
	err := row.Scan(&result.Civilian, &result.Spy, &result.Difficulty, &result.Similarity)
	if err != nil && isNoRows(err) {
		return result, spyError("word_bank_empty", 500)
	}
	return result, err
}
func (s *Server) spyEvaluateWin(ctx context.Context, tx *sql.Tx, id int64) map[string]any {
	seats, _ := s.spySeats(ctx, id, tx)
	alive := map[string]int64{spyRoleCivilian: 0, spyRoleSpy: 0, spyRoleBlank: 0}
	for _, seat := range seats {
		if !seat.OutRound.Valid {
			alive[seat.Role]++
		}
	}
	if alive[spyRoleSpy] == 0 && alive[spyRoleBlank] == 0 {
		if alive[spyRoleCivilian] == 0 {
			return map[string]any{"over": true, "winner": "draw", "reason": "场上已无存活玩家，判定和局。"}
		}
		return map[string]any{"over": true, "winner": "civilian", "reason": "卧底与白板已全部出局，好人阵营胜利。"}
	}
	if alive[spyRoleSpy] > 0 && alive[spyRoleSpy] >= alive[spyRoleCivilian] {
		return map[string]any{"over": true, "winner": "spy", "reason": "存活卧底已达到存活好人数量，卧底胜利。"}
	}
	return map[string]any{"over": false, "winner": nil, "reason": ""}
}
func (s *Server) spyFinishTx(ctx context.Context, tx *sql.Tx, id int64, winner, reason string) error {
	room, err := s.spyLoadRoom(ctx, strconv.FormatInt(id, 10), tx)
	if err != nil {
		return err
	}
	if room.Status == spyStatusEnded {
		return nil
	}
	seats, err := s.spySeats(ctx, id, tx)
	if err != nil {
		return err
	}
	reveal := []map[string]any{}
	for _, seat := range seats {
		out := any(nil)
		if seat.OutRound.Valid {
			out = seat.OutRound.Int64
		}
		reveal = append(reveal, map[string]any{"seat": seat.Seat, "nick": seat.Nick, "role": seat.Role, "out_round": out, "out_by": seat.OutBy})
	}
	raw, _ := json.Marshal(reveal)
	if _, err = tx.ExecContext(ctx, "DELETE FROM spy_results WHERE room_id=?", id); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO spy_results(room_id,winner,reason,rounds,awards,reveal,settled_at) VALUES(?,?,?,?,'[]',?,?)`, id, winner, reason, room.Round, string(raw), spyNow()); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE spy_rooms SET status='ended',phase='over',winner=?,deadline_at=0,speaker_seat=0 WHERE id=?", winner, id); err != nil {
		return err
	}
	return spyBumpTx(ctx, tx, id, "game-over", map[string]any{"winner": winner, "rounds": room.Round})
}

func (s *Server) spyLobby(ctx context.Context, userID int64) ([]map[string]any, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT r.id,r.code,r.name,r.phase,r.round,r.cap,r.status,r.timer_profile,r.spectate,r.need_code,(SELECT COUNT(*) FROM spy_seats s WHERE s.room_id=r.id),(SELECT COUNT(*) FROM spy_seats s WHERE s.room_id=r.id AND s.user_id=?),(r.host_user_id=?) FROM spy_rooms r WHERE r.status<>'ended' ORDER BY r.last_activity_at DESC LIMIT 40`, userID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []map[string]any{}
	for rows.Next() {
		var id, round, cap, spectate, need, seated, mine, host int64
		var code, name, phase, status, timer string
		if err := rows.Scan(&id, &code, &name, &phase, &round, &cap, &status, &timer, &spectate, &need, &seated, &mine, &host); err != nil {
			return nil, err
		}
		result = append(result, map[string]any{"id": id, "code": code, "name": name, "phase": phase, "round": round, "cap": cap, "seated": seated, "status": status, "mine": mine > 0, "is_host": host > 0, "joinable": status == spyStatusWaiting && seated < cap, "spectate": spectate == 1, "need_code": need == 1, "timer": timer})
	}
	return result, rows.Err()
}

func (s *Server) spySnapshot(ctx context.Context, room *spyRoom, mySeat *spySeat, referee bool, since int64, isHost bool) (map[string]any, error) {
	seats, err := s.spySeats(ctx, room.ID, nil)
	if err != nil {
		return nil, err
	}
	now := spyNow()
	round := room.Round
	phase := room.Phase
	over := room.Status == spyStatusEnded || phase == spyPhaseOver
	reveal := over || referee
	hostWaiting := isHost && room.Status == spyStatusWaiting
	targets := spyTargets(seats, round)
	order := append([]int64(nil), targets...)
	sentences := map[string]any{}
	rows, err := s.db.QueryContext(ctx, "SELECT round,seat,body,skipped,submitted_at FROM spy_sentences WHERE room_id=?", room.ID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var rno, seat, submitted int64
		var body string
		var skipped int64
		if err := rows.Scan(&rno, &seat, &body, &skipped, &submitted); err != nil {
			rows.Close()
			return nil, err
		}
		if mySeat == nil && !referee && submitted > now-room.SpectateDelay {
			continue
		}
		key := strconv.FormatInt(rno, 10)
		current, _ := sentences[key].(map[string]any)
		if current == nil {
			current = map[string]any{}
			sentences[key] = current
		}
		current[strconv.FormatInt(seat, 10)] = map[string]any{"body": body, "skipped": skipped == 1}
	}
	rows.Close()
	voted := map[int64]bool{}
	rows, err = s.db.QueryContext(ctx, "SELECT from_seat FROM spy_votes WHERE room_id=? AND round=?", room.ID, round)
	if err == nil {
		for rows.Next() {
			var seat int64
			_ = rows.Scan(&seat)
			voted[seat] = true
		}
		rows.Close()
	}
	var nightSubmitted int64
	_ = s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM spy_night_actions WHERE room_id=? AND round=?", room.ID, round).Scan(&nightSubmitted)
	var nightGuesses = map[int64]map[string]any{}
	rows, err = s.db.QueryContext(ctx, "SELECT seat,guess_a,guess_b,result FROM spy_blank_guesses WHERE room_id=?", room.ID)
	if err == nil {
		for rows.Next() {
			var seat int64
			var a, b, result string
			_ = rows.Scan(&seat, &a, &b, &result)
			nightGuesses[seat] = map[string]any{"submitted": true, "result": result, "guess_a": a, "guess_b": b}
		}
		rows.Close()
	}
	seatView := []map[string]any{}
	for _, seat := range seats {
		out := any(nil)
		if seat.OutRound.Valid {
			out = seat.OutRound.Int64
		}
		visibleOut := seat.OutBy
		if out != nil && !reveal && seat.OutRound.Int64 >= round {
			visibleOut = ""
		}
		row := map[string]any{"seat": seat.Seat, "nick": seat.Nick, "avatar": seat.Avatar, "ready": seat.ReadyAt > 0, "online": seat.LastSeenAt >= now-spyOnlineWindow, "out_round": out, "speaking": phase == spyPhaseDay && room.SpeakerSeat == seat.Seat, "has_voted": voted[seat.Seat], "has_spoken": spySentenceExists(sentences, round, seat.Seat), "guessed": nightGuesses[seat.Seat] != nil, "out_by": visibleOut}
		if reveal {
			row["role"] = seat.Role
		}
		if referee || hostWaiting {
			row["preset"] = seat.RolePreset
		}
		if mySeat == nil && !referee {
			row["has_voted"] = false
			row["has_spoken"] = false
			row["guessed"] = false
		}
		seatView = append(seatView, row)
	}
	me := any(nil)
	if mySeat != nil {
		alive := spyAlive(*mySeat, round)
		m := map[string]any{"seat": mySeat.Seat, "nick": mySeat.Nick, "ready": mySeat.ReadyAt > 0, "out_round": func() any {
			if mySeat.OutRound.Valid {
				return mySeat.OutRound.Int64
			}
			return nil
		}(), "is_speaking": phase == spyPhaseDay && room.SpeakerSeat == mySeat.Seat && alive, "can_speak": phase == spyPhaseDay && room.SpeakerSeat == mySeat.Seat && alive && !spySentenceExists(sentences, round, mySeat.Seat), "can_vote": phase == spyPhaseVote && alive && !voted[mySeat.Seat], "can_guess": false}
		if reveal {
			m["role"] = mySeat.Role
		}
		if mySeat.Role == spyRoleBlank {
			m["role"] = spyRoleBlank
			m["word"] = ""
			m["can_guess"] = !over && nightGuesses[mySeat.Seat] == nil
			if g := nightGuesses[mySeat.Seat]; g != nil {
				m["guess"] = map[string]any{"guess_a": g["guess_a"], "guess_b": g["guess_b"]}
			}
		} else if mySeat.Role != "" {
			word, _ := s.spyMyWordTx(ctx, nil, room.ID, mySeat.Role)
			m["word"] = word
		}
		me = m
	}
	outcomes, err := s.spyOutcomes(ctx, room, reveal)
	if err != nil {
		return nil, err
	}
	var result any
	var words any
	if over {
		var winner, reason string
		var rounds, settled int64
		var awards, revealRaw string
		if err := s.db.QueryRowContext(ctx, "SELECT winner,reason,rounds,COALESCE(awards,''),COALESCE(reveal,''),settled_at FROM spy_results WHERE room_id=?", room.ID).Scan(&winner, &reason, &rounds, &awards, &revealRaw, &settled); err == nil {
			result = map[string]any{"winner": winner, "reason": reason, "rounds": rounds, "awards": decodeAnyList(awards), "reveal": decodeAnyList(revealRaw), "settled_at": settled}
		}
	}
	if referee || over {
		w, _ := s.spyWordTx(ctx, nil, room.ID)
		words = map[string]any{"civilian_word": w.Civilian, "spy_word": w.Spy, "difficulty": w.Difficulty, "similarity": w.Similarity}
	}
	distribution := map[string]any{"civilian": room.DistCivilian, "spy": room.DistSpy, "blank": room.DistBlank}
	if room.DistCivilian == 0 && room.DistSpy == 0 && room.DistBlank == 0 {
		if d, ok := spyDefaultDist(maxInt64(spyMinPlayers, int64(len(seats)))); ok {
			distribution = map[string]any{"civilian": d["civilian"], "spy": d["spy"], "blank": d["blank"]}
		}
	}
	tieOpen := false
	if room.Phase == spyPhaseVote {
		var tie int64
		var eliminated sql.NullInt64
		if err := s.db.QueryRowContext(ctx, "SELECT tie,eliminated_seat FROM spy_round_outcomes WHERE room_id=? AND round=? AND stage='vote'", room.ID, room.Round).Scan(&tie, &eliminated); err == nil {
			tieOpen = tie == 1 && !eliminated.Valid
		}
	}
	events := []any{}
	if since > 0 {
		events, _ = s.spyEvents(ctx, room.ID, since)
	}
	return map[string]any{"rev": room.Rev, "changed": true, "room": map[string]any{"id": room.ID, "code": room.Code, "name": room.Name, "phase": room.Phase, "round": room.Round, "status": room.Status, "cap": room.Cap, "joined": len(seats), "distribution": distribution, "timer_profile": room.TimerProfile, "speaker_seat": room.SpeakerSeat, "speaking_order": order, "targets": targets, "revote_used": room.RevoteUsed == 1, "tie_open": tieOpen, "spectate": room.Spectate == 1, "spectate_delay": room.SpectateDelay, "need_code": room.NeedCode == 1, "host_user_id": room.HostUserID, "host_seat": func() any {
		for _, seat := range seats {
			if seat.UserID == room.HostUserID {
				return seat.Seat
			}
		}
		return nil
	}(), "can_control": isHost, "word_a": func() string {
		if referee || hostWaiting {
			return room.WordA
		}
		return ""
	}(), "word_b": func() string {
		if referee || hostWaiting {
			return room.WordB
		}
		return ""
	}(), "server_now": now, "deadline_at": room.DeadlineAt, "remaining": func() any {
		if room.DeadlineAt > 0 {
			return maxInt64(0, room.DeadlineAt-now)
		}
		return nil
	}(), "winner": func() string {
		if over {
			return room.Winner
		}
		return ""
	}()}, "seats": seatView, "me": me, "sentences": sentences, "outcomes": outcomes, "night": map[string]any{"required": room.DistSpy, "submitted": minInt64(nightSubmitted, room.DistSpy)}, "words": words, "result": result, "events": events}, nil
}
func minInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
func spySentenceExists(sentences map[string]any, round, seat int64) bool {
	current, _ := sentences[strconv.FormatInt(round, 10)].(map[string]any)
	if current == nil {
		return false
	}
	_, ok := current[strconv.FormatInt(seat, 10)]
	return ok
}
func decodeAnyList(raw string) any {
	if strings.TrimSpace(raw) == "" {
		return []any{}
	}
	var value any
	if json.Unmarshal([]byte(raw), &value) != nil {
		return []any{}
	}
	return value
}
func (s *Server) spyOutcomes(ctx context.Context, room *spyRoom, reveal bool) ([]map[string]any, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT round,stage,eliminated_seat,out_by,tie,host_ruling,tally FROM spy_round_outcomes WHERE room_id=? ORDER BY round,stage", room.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []map[string]any{}
	for rows.Next() {
		var round int64
		var stage, outBy, host, tally string
		var eliminated sql.NullInt64
		var tie int64
		if err := rows.Scan(&round, &stage, &eliminated, &outBy, &tie, &host, &tally); err != nil {
			return nil, err
		}
		if !reveal && round >= room.Round {
			continue
		}
		var e any
		if eliminated.Valid {
			e = eliminated.Int64
		}
		result = append(result, map[string]any{"round": round, "stage": stage, "eliminated_seat": e, "out_by": outBy, "tie": tie == 1, "host_ruling": host, "tally": decodeAnyList(tally)})
	}
	return result, nil
}
func (s *Server) spyEvents(ctx context.Context, id, since int64) ([]any, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT rev,kind,payload FROM spy_events WHERE room_id=? AND rev>? ORDER BY rev LIMIT 60", id, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []any{}
	for rows.Next() {
		var rev int64
		var kind, payload string
		_ = rows.Scan(&rev, &kind, &payload)
		var value any
		_ = json.Unmarshal([]byte(payload), &value)
		result = append(result, map[string]any{"rev": rev, "kind": kind, "payload": value})
	}
	return result, nil
}

func (s *Server) spyCloseTx(ctx context.Context, tx *sql.Tx, id int64, u *user) (map[string]any, error) {
	room, err := s.spyLoadRoom(ctx, strconv.FormatInt(id, 10), tx)
	if err != nil {
		return nil, err
	}
	if err = spyRequireHost(room, u); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE spy_rooms SET status='ended',phase='over',deadline_at=0,speaker_seat=0 WHERE id=?", id); err != nil {
		return nil, err
	}
	if err = spyBumpTx(ctx, tx, id, "room-closed", map[string]any{}); err != nil {
		return nil, err
	}
	return map[string]any{"closed": true}, nil
}
func (s *Server) spyResolveTx(ctx context.Context, tx *sql.Tx, id int64, u *user, ruling string, target *int64) (map[string]any, error) {
	room, err := s.spyLoadRoom(ctx, strconv.FormatInt(id, 10), tx)
	if err != nil {
		return nil, err
	}
	if err = spyRequireHost(room, u); err != nil {
		return nil, err
	}
	if err = spyRequirePlaying(room); err != nil {
		return nil, err
	}
	if room.Phase != spyPhaseVote {
		return nil, spyError("phase_wrong", 409)
	}
	tie, err := s.spyTieOpenTx(ctx, tx, room)
	if err != nil {
		return nil, err
	}
	if !tie {
		return nil, spyError("phase_wrong", 409)
	}
	if ruling == "revote" {
		if room.RevoteUsed == 1 {
			return nil, spyError("no_revote_left", 409)
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM spy_votes WHERE room_id=? AND round=?", id, room.Round); err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM spy_round_outcomes WHERE room_id=? AND round=? AND stage='vote'", id, room.Round); err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE spy_rooms SET revote_used=1 WHERE id=?", id); err != nil {
			return nil, err
		}
		if err = s.spyOpenPhaseTx(ctx, tx, id); err != nil {
			return nil, err
		}
		if err = spyBumpTx(ctx, tx, id, "vote-reopened", map[string]any{"round": room.Round}); err != nil {
			return nil, err
		}
		return map[string]any{"ruling": "revote", "advanced": nil}, nil
	}
	if ruling == "pass" {
		if _, err = tx.ExecContext(ctx, "INSERT INTO spy_round_outcomes(room_id,round,stage,eliminated_seat,out_by,tie,host_ruling,tally,created_at) VALUES(?,?, 'pass',NULL,'',0,?,NULL,?)", id, room.Round, "本轮无人出局", spyNow()); err != nil {
			return nil, err
		}
		if err = spyBumpTx(ctx, tx, id, "vote-ruled", map[string]any{"round": room.Round, "ruling": "pass"}); err != nil {
			return nil, err
		}
		return s.spyAdvanceTx(ctx, tx, id, "ruling")
	}
	if ruling != "eliminate" || target == nil {
		return nil, spyError("invalid_params", 400)
	}
	seats, err := s.spySeats(ctx, id, tx)
	if err != nil {
		return nil, err
	}
	valid := false
	role := ""
	for _, seat := range seats {
		if seat.Seat == *target && spyAlive(seat, room.Round) {
			valid = true
			role = seat.Role
		}
	}
	if !valid {
		return nil, spyError("vote_target_invalid", 400)
	}
	if _, err = tx.ExecContext(ctx, "UPDATE spy_seats SET out_round=?,out_by='vote' WHERE room_id=? AND seat=?", room.Round, id, *target); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE spy_round_outcomes SET eliminated_seat=?,eliminated_role=?,out_by='vote',tie=0,host_ruling=? WHERE room_id=? AND round=? AND stage='vote'", *target, role, "房主裁决平票", id, room.Round); err != nil {
		return nil, err
	}
	if err = spyBumpTx(ctx, tx, id, "vote-ruled", map[string]any{"round": room.Round, "ruling": "eliminate", "seat": *target}); err != nil {
		return nil, err
	}
	return s.spyAdvanceTx(ctx, tx, id, "ruling")
}
