package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

const dmContentMax = 1000

func (s *Server) messages(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	if action == "" {
		action = "list"
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		postsError(w, "login_required", "请先登录", http.StatusUnauthorized, nil)
		return
	}
	if r.Method == http.MethodGet {
		s.messagesGet(w, r, action, userID)
		return
	}
	if r.Method != http.MethodPost || !sameOrigin(r) {
		if r.Method == http.MethodPost {
			postsError(w, "cross_origin", "拒绝跨站写入请求", http.StatusForbidden, nil)
		} else {
			postsError(w, "method_not_allowed", "请求方法不允许", http.StatusMethodNotAllowed, nil)
		}
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 2<<20); err != nil || input == nil {
		input = map[string]any{}
	}
	s.messagesWrite(w, r, action, userID, input)
}

func (s *Server) messagesGet(w http.ResponseWriter, r *http.Request, action string, userID int64) {
	switch action {
	case "list":
		data, err := s.dmList(r, userID)
		if err != nil {
			postsError(w, "messages_unavailable", "私信操作失败，请稍后重试", http.StatusInternalServerError, nil)
			return
		}
		writeJSON(w, map[string]any{"success": true, "data": data})
	case "thread":
		data, err := s.dmThread(r, userID, map[string]any{"user_id": parsePositiveInt(r.URL.Query().Get("user_id")), "after_id": parsePositiveInt(r.URL.Query().Get("after_id")), "before_id": parsePositiveInt(r.URL.Query().Get("before_id")), "limit": boundedQueryInt(r, "limit", 50, 1, 100)})
		if err != nil {
			s.writeDMError(w, err)
			return
		}
		writeJSON(w, map[string]any{"success": true, "data": data})
	case "friends":
		writeJSON(w, map[string]any{"success": true, "data": map[string]any{"friends": s.dmFriends(r, userID)}})
	case "unread_count":
		var count int
		err := s.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM dm_messages m JOIN dm_conversations c ON c.id=m.conversation_id WHERE (c.user_a_id=? OR c.user_b_id=?) AND m.sender_id<>? AND m.read_at IS NULL`, userID, userID, userID).Scan(&count)
		if err != nil {
			postsError(w, "messages_unavailable", "私信操作失败，请稍后重试", http.StatusInternalServerError, nil)
			return
		}
		writeJSON(w, map[string]any{"success": true, "data": map[string]any{"unread": count}})
	default:
		postsError(w, "unknown_action", "未知操作", http.StatusBadRequest, nil)
	}
}

func (s *Server) messagesWrite(w http.ResponseWriter, r *http.Request, action string, userID int64, input map[string]any) {
	switch action {
	case "thread":
		data, err := s.dmThread(r, userID, input)
		if err != nil {
			s.writeDMError(w, err)
			return
		}
		writeJSON(w, map[string]any{"success": true, "data": data})
	case "send":
		data, err := s.dmSend(r, userID, input)
		if err != nil {
			s.writeDMError(w, err)
			return
		}
		writeJSON(w, map[string]any{"success": true, "data": data})
	case "read":
		conversationID := integerValue(input["conversation_id"])
		if conversationID <= 0 {
			postsError(w, "invalid_target", "会话无效", http.StatusUnprocessableEntity, nil)
			return
		}
		var exists int
		if err := s.db.QueryRowContext(r.Context(), "SELECT 1 FROM dm_conversations WHERE id=? AND (user_a_id=? OR user_b_id=?)", conversationID, userID, userID).Scan(&exists); err != nil {
			postsError(w, "not_found", "会话不存在", http.StatusNotFound, nil)
			return
		}
		if _, err := s.db.ExecContext(r.Context(), "UPDATE dm_messages SET read_at=? WHERE conversation_id=? AND sender_id<>? AND read_at IS NULL", time.Now().Format("2006-01-02 15:04:05"), conversationID, userID); err != nil {
			postsError(w, "messages_unavailable", "私信操作失败，请稍后重试", http.StatusInternalServerError, nil)
			return
		}
		writeJSON(w, map[string]any{"success": true, "data": map[string]any{"message": "已读"}})
	default:
		postsError(w, "unknown_action", "未知操作", http.StatusBadRequest, nil)
	}
}

func (s *Server) dmList(r *http.Request, me int64) (map[string]any, error) {
	rows, err := s.db.QueryContext(r.Context(), `SELECT c.id, c.last_message_at, CASE WHEN c.user_a_id=? THEN c.user_b_id ELSE c.user_a_id END FROM dm_conversations c WHERE c.user_a_id=? OR c.user_b_id=? ORDER BY c.last_message_at DESC, c.id DESC LIMIT 50`, me, me, me)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	conversations := []map[string]any{}
	for rows.Next() {
		var id, otherID int64
		var last sqlNullString
		if err := rows.Scan(&id, &last, &otherID); err != nil {
			continue
		}
		other := s.dmUser(r, otherID)
		if other == nil {
			continue
		}
		var content string
		var sender int64
		var created sqlNullString
		_ = s.db.QueryRowContext(r.Context(), "SELECT content,sender_id,created_at FROM dm_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1", id).Scan(&content, &sender, &created)
		var unread int
		_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM dm_messages WHERE conversation_id=? AND sender_id<>? AND read_at IS NULL", id, me).Scan(&unread)
		var lastMessage any
		if content != "" || created.String != "" {
			lastMessage = map[string]any{"content": content, "mine": sender == me, "created_at": created.String}
		}
		conversations = append(conversations, map[string]any{"conversation_id": id, "user": other, "last_message": lastMessage, "last_message_at": last.String, "unread": unread})
	}
	return map[string]any{"conversations": conversations}, nil
}

func (s *Server) dmThread(r *http.Request, me int64, input map[string]any) (map[string]any, error) {
	otherID := integerValue(input["user_id"])
	if otherID <= 0 || otherID == me {
		return nil, postFailure{Code: "invalid_target", Message: "会话对象无效", Status: http.StatusUnprocessableEntity}
	}
	var exists int
	if err := s.db.QueryRowContext(r.Context(), "SELECT 1 FROM users WHERE id=? AND status='active'", otherID).Scan(&exists); err != nil {
		return nil, postFailure{Code: "not_found", Message: "用户不存在", Status: http.StatusNotFound}
	}
	conversationID, err := s.dmConversationID(r, me, otherID)
	if err != nil {
		return nil, err
	}
	after := integerValue(input["after_id"])
	before := integerValue(input["before_id"])
	limit := int(integerValue(input["limit"]))
	if limit < 1 || limit > 100 {
		limit = 50
	}
	query := `SELECT id,sender_id,content,images_json,created_at,read_at FROM dm_messages WHERE conversation_id=?`
	params := []any{conversationID}
	if after > 0 {
		query += " AND id>? ORDER BY id ASC LIMIT 200"
		params = append(params, after)
	} else {
		if before > 0 {
			query += " AND id<?"
			params = append(params, before)
		}
		query += " ORDER BY id DESC LIMIT ?"
		params = append(params, limit)
	}
	rows, err := s.db.QueryContext(r.Context(), query, params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := []map[string]any{}
	for rows.Next() {
		var id, sender int64
		var content, images, created, read sqlNullString
		if rows.Scan(&id, &sender, &content, &images, &created, &read) != nil {
			continue
		}
		messages = append(messages, map[string]any{"id": id, "sender_id": sender, "content": content.String, "images": safeDMImages(images.String), "created_at": created.String, "read_at": nullableString(read)})
	}
	if after == 0 {
		reverseMessages(messages)
	}
	return map[string]any{"messages": messages, "conversation_id": conversationID, "has_more_before": after == 0 && len(messages) == limit, "other": s.dmUser(r, otherID)}, nil
}

func (s *Server) dmSend(r *http.Request, me int64, input map[string]any) (map[string]any, error) {
	to := integerValue(input["to_user_id"])
	if to <= 0 || to == me {
		return nil, postFailure{Code: "invalid_target", Message: "私信对象无效", Status: http.StatusUnprocessableEntity}
	}
	var exists int
	if err := s.db.QueryRowContext(r.Context(), "SELECT 1 FROM users WHERE id=? AND status='active'", to).Scan(&exists); err != nil {
		return nil, postFailure{Code: "not_found", Message: "用户不存在", Status: http.StatusNotFound}
	}
	var mutual int
	_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM user_follows a JOIN user_follows b ON b.follower_id=a.following_id AND b.following_id=a.follower_id WHERE a.follower_id=? AND a.following_id=?", me, to).Scan(&mutual)
	if mutual == 0 {
		return nil, postFailure{Code: "not_friends", Message: "只能给互相关注的好友发私信", Status: http.StatusForbidden}
	}
	content := strings.TrimSpace(stringValue(input["content"]))
	if runeLength(content) > dmContentMax {
		return nil, postFailure{Code: "too_long", Message: "消息不能超过 1000 字", Status: http.StatusUnprocessableEntity}
	}
	images, imageErr := s.validateOwnedPostImages(r, me, input["images"])
	if imageErr != nil {
		return nil, imageErr
	}
	if content == "" && len(images) == 0 {
		return nil, postFailure{Code: "required", Message: "消息内容不能为空", Status: http.StatusUnprocessableEntity}
	}
	conversationID, err := s.dmConversationID(r, me, to)
	if err != nil {
		return nil, err
	}
	now := time.Now().Format("2006-01-02 15:04:05")
	data, _ := json.Marshal(images)
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(r.Context(), "INSERT INTO dm_messages(conversation_id,sender_id,content,images_json,created_at) VALUES(?,?,?,?,?)", conversationID, me, content, string(data), now)
	if err != nil {
		return nil, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(r.Context(), "UPDATE dm_conversations SET last_message_id=?,last_message_at=? WHERE id=?", id, now, conversationID); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return map[string]any{"message": map[string]any{"id": id, "sender_id": me, "content": content, "images": images, "created_at": now, "read_at": nil}, "conversation_id": conversationID, "message_text": "已发送"}, nil
}

func (s *Server) dmConversationID(r *http.Request, a, b int64) (int64, error) {
	min, max := a, b
	if min > max {
		min, max = max, min
	}
	q := "INSERT OR IGNORE INTO dm_conversations(user_a_id,user_b_id,created_at) VALUES(?,?,CURRENT_TIMESTAMP)"
	if s.cfg.DBDriver == "mysql" {
		q = "INSERT IGNORE INTO dm_conversations(user_a_id,user_b_id,created_at) VALUES(?,?,CURRENT_TIMESTAMP)"
	}
	if _, err := s.db.ExecContext(r.Context(), q, min, max); err != nil {
		return 0, err
	}
	var id int64
	err := s.db.QueryRowContext(r.Context(), "SELECT id FROM dm_conversations WHERE user_a_id=? AND user_b_id=?", min, max).Scan(&id)
	return id, err
}
func (s *Server) dmUser(r *http.Request, id int64) map[string]any {
	var username, nickname, avatar string
	if s.db.QueryRowContext(r.Context(), "SELECT username,COALESCE(nickname,''),COALESCE(avatar_url,'') FROM users WHERE id=?", id).Scan(&username, &nickname, &avatar) != nil {
		return nil
	}
	return map[string]any{"id": id, "username": username, "handle": "@" + username, "nickname": firstNonEmpty(nickname, username), "avatar_url": avatar}
}
func (s *Server) dmFriends(r *http.Request, me int64) []map[string]any {
	rows, err := s.db.QueryContext(r.Context(), "SELECT u.id,u.username,COALESCE(u.nickname,''),COALESCE(u.avatar_url,'') FROM users u JOIN user_follows a ON a.follower_id=? AND a.following_id=u.id JOIN user_follows b ON b.follower_id=u.id AND b.following_id=? WHERE u.status='active' ORDER BY u.id LIMIT 100", me, me)
	if err != nil {
		return []map[string]any{}
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var username, nickname, avatar string
		if rows.Scan(&id, &username, &nickname, &avatar) == nil {
			out = append(out, map[string]any{"id": id, "username": username, "handle": "@" + username, "nickname": firstNonEmpty(nickname, username), "avatar_url": avatar})
		}
	}
	return out
}
func safeDMImages(raw string) []string {
	var values []string
	if json.Unmarshal([]byte(raw), &values) != nil {
		return []string{}
	}
	out := []string{}
	for _, value := range values {
		value = strings.TrimLeft(strings.ReplaceAll(value, `\`, "/"), "/")
		if strings.HasPrefix(value, "uploads/posts/") && !strings.Contains(value, "..") {
			out = append(out, "/"+value)
		}
	}
	return out
}
func nullableString(value sqlNullString) any {
	if value.Valid {
		return value.String
	}
	return nil
}
func reverseMessages(messages []map[string]any) {
	for left, right := 0, len(messages)-1; left < right; left, right = left+1, right-1 {
		messages[left], messages[right] = messages[right], messages[left]
	}
}
func (s *Server) writeDMError(w http.ResponseWriter, err error) {
	if failure, ok := err.(postFailure); ok {
		postsError(w, failure.Code, failure.Message, failure.Status, failure.Fields)
		return
	}
	postsError(w, "messages_unavailable", "私信操作失败，请稍后重试", http.StatusInternalServerError, nil)
}
