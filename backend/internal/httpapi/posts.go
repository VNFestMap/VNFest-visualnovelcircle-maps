package httpapi

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const (
	postsContentMax = 280
	postsImagesMax  = 4
	postsFeedMax    = 50
)

var postStoredPathRE = regexp.MustCompile(`^[A-Za-z0-9/_\-.]+$`)

type postRecord struct {
	ID, AuthorID, ClubID, LikeCount, ReplyCount, RepostCount                  int64
	Content, ImagesJSON, Status, AuthorUsername, AuthorNickname, AuthorAvatar string
	ClubCountry, CreatedAt, DeletedAt                                         string
	ReplyToID, QuotedPostID                                                   sql.NullInt64
}

func (s *Server) posts(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	if action == "" && r.Method == http.MethodPost {
		body, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
		if err == nil {
			var input map[string]any
			_ = json.Unmarshal(body, &input)
			if input == nil {
				input = map[string]any{}
			}
			action = strings.ToLower(strings.TrimSpace(stringValue(input["action"])))
			r.Body = io.NopCloser(bytes.NewReader(body))
		}
	}
	if action == "" {
		action = "bootstrap"
	}
	if r.Method == http.MethodGet {
		s.postsGet(w, r, action)
		return
	}
	if r.Method != http.MethodPost {
		postsError(w, "method_not_allowed", "请求方法不允许", http.StatusMethodNotAllowed, nil)
		return
	}
	if !sameOrigin(r) {
		postsError(w, "cross_origin", "拒绝跨站写入请求", http.StatusForbidden, nil)
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		postsError(w, "login_required", "请先登录", http.StatusUnauthorized, nil)
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 2<<20); err != nil || input == nil {
		input = map[string]any{}
	}
	s.postsWrite(w, r, action, userID, input)
}

func (s *Server) postsGet(w http.ResponseWriter, r *http.Request, action string) {
	viewerID, _ := s.loggedInUserID(r)
	if action == "bootstrap" {
		var payload any
		if viewerID > 0 {
			payload = s.postUserPayload(r, viewerID)
		}
		clubs := []map[string]any{}
		if viewerID > 0 {
			clubs = s.postSelectableClubs(r, viewerID)
		}
		writeJSON(w, map[string]any{"success": true, "data": map[string]any{"user": payload, "clubs": clubs, "limits": map[string]any{"content_max": postsContentMax, "images_max": postsImagesMax}}})
		return
	}
	switch action {
	case "feed":
		result, err := s.postFeed(r, viewerID)
		if err != nil {
			if failure, ok := err.(postFailure); ok {
				postsError(w, failure.Code, failure.Message, failure.Status, failure.Fields)
				return
			}
			postsError(w, "posts_unavailable", "动态操作失败，请稍后重试", http.StatusInternalServerError, nil)
			return
		}
		writeJSON(w, map[string]any{"success": true, "data": result})
	case "detail":
		id := parsePositiveInt(r.URL.Query().Get("id"))
		post, err := s.fetchPost(r, id)
		if err != nil || post == nil || (post.Status != "published" && (viewerID == 0 || post.AuthorID != viewerID)) || (post.DeletedAt != "" && (viewerID == 0 || post.AuthorID != viewerID)) {
			postsError(w, "not_found", "推文不存在或已被删除", http.StatusNotFound, nil)
			return
		}
		replies, _ := s.postReplies(r, id, viewerID)
		writeJSON(w, map[string]any{"success": true, "data": map[string]any{"post": s.serializePost(r, post, viewerID), "replies": replies}})
	case "mine":
		if viewerID == 0 {
			postsError(w, "login_required", "请先登录", http.StatusUnauthorized, nil)
			return
		}
		result, err := s.postTimeline(r, viewerID, "", viewerID)
		if err != nil {
			postsError(w, "posts_unavailable", "动态操作失败，请稍后重试", http.StatusInternalServerError, nil)
			return
		}
		writeJSON(w, map[string]any{"success": true, "data": result})
	case "profile", "user_timeline":
		username := strings.TrimSpace(r.URL.Query().Get("username"))
		id, err := s.userIDByUsername(r, username)
		if err != nil || id == 0 {
			postsError(w, "not_found", "用户不存在", http.StatusNotFound, nil)
			return
		}
		if action == "profile" {
			profile, err := s.postProfile(r, id, viewerID)
			if err != nil {
				postsError(w, "posts_unavailable", "动态操作失败，请稍后重试", http.StatusInternalServerError, nil)
				return
			}
			writeJSON(w, map[string]any{"success": true, "data": map[string]any{"user": profile, "suggested": s.postSuggested(r, viewerID)}})
			return
		}
		tab := r.URL.Query().Get("tab")
		if tab != "replies" {
			tab = "posts"
		}
		result, err := s.postTimeline(r, id, tab, viewerID)
		if err != nil {
			postsError(w, "posts_unavailable", "动态操作失败，请稍后重试", http.StatusInternalServerError, nil)
			return
		}
		writeJSON(w, map[string]any{"success": true, "data": result})
	case "suggested":
		writeJSON(w, map[string]any{"success": true, "data": map[string]any{"users": s.postSuggested(r, viewerID)}})
	case "follow_list":
		if viewerID == 0 {
			writeJSON(w, map[string]any{"success": true, "data": map[string]any{"followers": []any{}, "following": []any{}}})
			return
		}
		writeJSON(w, map[string]any{"success": true, "data": s.postFollowList(r, viewerID)})
	case "search":
		query := strings.TrimSpace(r.URL.Query().Get("q"))
		writeJSON(w, map[string]any{"success": true, "data": map[string]any{"query": query, "users": s.postSearchUsers(r, query, viewerID), "posts": s.postSearch(r, query, viewerID)}})
	default:
		postsError(w, "unknown_action", "未知操作", http.StatusBadRequest, nil)
	}
}

func (s *Server) postsWrite(w http.ResponseWriter, r *http.Request, action string, userID int64, input map[string]any) {
	switch action {
	case "create":
		post, err := s.createPost(r, userID, input)
		if err != nil {
			if failure, ok := err.(postFailure); ok {
				postsError(w, failure.Code, failure.Message, failure.Status, failure.Fields)
				return
			}
			postsError(w, "posts_unavailable", "动态操作失败，请稍后重试", http.StatusInternalServerError, nil)
			return
		}
		writeJSON(w, map[string]any{"success": true, "data": map[string]any{"post": s.serializePost(r, post, userID), "message": "推文已发布"}})
	case "delete":
		id := integerValue(input["id"])
		post, err := s.fetchPost(r, id)
		if err != nil || post == nil || post.DeletedAt != "" {
			postsError(w, "not_found", "推文不存在", http.StatusNotFound, nil)
			return
		}
		if post.AuthorID != userID && !s.isSuperAdmin(r, userID) {
			postsError(w, "permission_denied", "无权删除这条推文", http.StatusForbidden, nil)
			return
		}
		if err := s.deletePost(r, post); err != nil {
			postsError(w, "posts_unavailable", "动态操作失败，请稍后重试", http.StatusInternalServerError, nil)
			return
		}
		writeJSON(w, map[string]any{"success": true, "data": map[string]any{"message": "推文已删除"}})
	case "like", "unlike":
		id := integerValue(input["id"])
		post, err := s.fetchPost(r, id)
		if err != nil || post == nil || (post.Status != "published" && post.DeletedAt == "") || post.DeletedAt != "" {
			postsError(w, "not_found", "推文不存在", http.StatusNotFound, nil)
			return
		}
		liked := action == "like"
		count, err := s.setPostLike(r, id, userID, liked)
		if err != nil {
			postsError(w, "posts_unavailable", "动态操作失败，请稍后重试", http.StatusInternalServerError, nil)
			return
		}
		message := "已取消点赞"
		if liked {
			message = "已点赞"
		}
		writeJSON(w, map[string]any{"success": true, "data": map[string]any{"like_count": count, "liked": liked, "message": message}})
	case "follow", "unfollow":
		target := integerValue(input["id"])
		if target <= 0 {
			postsError(w, "invalid_target", "关注对象无效", http.StatusUnprocessableEntity, nil)
			return
		}
		if target == userID && action == "follow" {
			postsError(w, "self_follow", "不能关注自己", http.StatusUnprocessableEntity, nil)
			return
		}
		if err := s.setFollow(r, userID, target, action == "follow"); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				postsError(w, "not_found", "用户不存在", http.StatusNotFound, nil)
				return
			}
			postsError(w, "posts_unavailable", "动态操作失败，请稍后重试", http.StatusInternalServerError, nil)
			return
		}
		var followers int
		_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM user_follows WHERE following_id = ?", target).Scan(&followers)
		message := "已取消关注"
		if action == "follow" {
			message = "已关注"
		}
		writeJSON(w, map[string]any{"success": true, "data": map[string]any{"following": action == "follow", "followers": followers, "message": message}})
	default:
		postsError(w, "unknown_action", "未知操作", http.StatusBadRequest, nil)
	}
}

type postFailure struct {
	Code, Message string
	Status        int
	Fields        map[string]any
}

func (e postFailure) Error() string { return e.Message }
func postsError(w http.ResponseWriter, code, message string, status int, fields map[string]any) {
	if fields == nil {
		fields = map[string]any{}
	}
	writeJSONStatus(w, status, map[string]any{"success": false, "error": map[string]any{"code": code, "message": message, "fields": fields}})
}

func (s *Server) fetchPost(r *http.Request, id int64) (*postRecord, error) {
	if id <= 0 {
		return nil, nil
	}
	row := s.db.QueryRowContext(r.Context(), `SELECT p.id, p.author_id, COALESCE(p.club_id,0), COALESCE(p.club_country,''), p.content,
        COALESCE(p.images_json,'[]'), p.reply_to_id, p.quoted_post_id, p.status, COALESCE(p.like_count,0), COALESCE(p.reply_count,0), COALESCE(p.repost_count,0),
        p.created_at, p.deleted_at, u.username, COALESCE(u.nickname,''), COALESCE(u.avatar_url,'')
        FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = ? LIMIT 1`, id)
	return scanPost(row)
}

func scanPost(row interface{ Scan(...any) error }) (*postRecord, error) {
	var p postRecord
	var clubCountry, content, images, status, created, deleted, username, nickname, avatar sqlNullString
	if err := row.Scan(&p.ID, &p.AuthorID, &p.ClubID, &clubCountry, &content, &images, &p.ReplyToID, &p.QuotedPostID, &status, &p.LikeCount, &p.ReplyCount, &p.RepostCount, &created, &deleted, &username, &nickname, &avatar); err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, err
	}
	p.ClubCountry, p.Content, p.ImagesJSON, p.Status = clubCountry.String, content.String, images.String, status.String
	p.CreatedAt, p.DeletedAt, p.AuthorUsername, p.AuthorNickname, p.AuthorAvatar = created.String, deleted.String, username.String, nickname.String, avatar.String
	return &p, nil
}

func (s *Server) serializePost(r *http.Request, p *postRecord, viewerID int64) map[string]any {
	images := []string{}
	var raw []string
	if json.Unmarshal([]byte(p.ImagesJSON), &raw) == nil {
		for _, value := range raw {
			value = strings.TrimSpace(strings.ReplaceAll(value, `\`, `/`))
			if s.picui != nil && s.picui.TrustedURL(value) && len(images) < postsImagesMax {
				images = append(images, value)
				continue
			}
			value = strings.TrimLeft(value, "/")
			if value != "" && !strings.Contains(value, "..") && strings.HasPrefix(value, "uploads/posts/") && len(images) < postsImagesMax {
				images = append(images, "/"+value)
			}
		}
	}
	liked := false
	var marker int
	if viewerID > 0 && s.db.QueryRowContext(r.Context(), "SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ? LIMIT 1", p.ID, viewerID).Scan(&marker) == nil {
		liked = true
	}
	return map[string]any{"id": p.ID, "content": p.Content, "images": images, "reply_to_id": nullInt(p.ReplyToID), "quoted_post_id": nullInt(p.QuotedPostID), "status": p.Status, "like_count": p.LikeCount, "reply_count": p.ReplyCount, "repost_count": p.RepostCount, "created_at": p.CreatedAt, "author": map[string]any{"id": p.AuthorID, "username": p.AuthorUsername, "handle": "@" + p.AuthorUsername, "nickname": firstNonEmpty(p.AuthorNickname, p.AuthorUsername), "avatar_url": p.AuthorAvatar}, "club": nil, "liked": liked, "capabilities": map[string]any{"delete": viewerID > 0 && (viewerID == p.AuthorID || s.isSuperAdmin(r, viewerID))}}
}

func nullInt(value sql.NullInt64) any {
	if value.Valid {
		return value.Int64
	}
	return nil
}

func (s *Server) postFeed(r *http.Request, viewerID int64) (map[string]any, error) {
	limit := boundedQueryInt(r, "limit", 20, 1, postsFeedMax)
	before := parsePositiveInt(r.URL.Query().Get("before_id"))
	sqlText := `SELECT p.id, p.author_id, COALESCE(p.club_id,0), COALESCE(p.club_country,''), p.content, COALESCE(p.images_json,'[]'), p.reply_to_id, p.quoted_post_id, p.status, COALESCE(p.like_count,0), COALESCE(p.reply_count,0), COALESCE(p.repost_count,0), p.created_at, p.deleted_at, u.username, COALESCE(u.nickname,''), COALESCE(u.avatar_url,'') FROM posts p JOIN users u ON u.id=p.author_id WHERE p.status='published' AND p.deleted_at IS NULL AND p.reply_to_id IS NULL`
	params := []any{}
	if r.URL.Query().Get("scope") == "following" {
		if viewerID == 0 {
			return nil, postFailure{Code: "login_required", Message: "请先登录", Status: http.StatusUnauthorized}
		}
		sqlText += " AND (p.author_id = ? OR p.author_id IN (SELECT following_id FROM user_follows WHERE follower_id = ?))"
		params = append(params, viewerID, viewerID)
	}
	if before > 0 {
		sqlText += " AND p.id < ?"
		params = append(params, before)
	}
	sqlText += " ORDER BY p.id DESC LIMIT ?"
	params = append(params, limit)
	rows, err := s.db.QueryContext(r.Context(), sqlText, params...)
	if err != nil {
		return nil, err
	}
	items := []*postRecord{}
	for rows.Next() {
		p, err := scanPost(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	serialized := make([]map[string]any, 0, len(items))
	for _, p := range items {
		serialized = append(serialized, s.serializePost(r, p, viewerID))
	}
	var next any
	if len(serialized) == limit {
		next = serialized[len(serialized)-1]["id"]
	}
	return map[string]any{"posts": serialized, "next_before_id": next}, nil
}

func (s *Server) postReplies(r *http.Request, id, viewerID int64) ([]map[string]any, error) {
	rows, err := s.db.QueryContext(r.Context(), `SELECT p.id, p.author_id, COALESCE(p.club_id,0), COALESCE(p.club_country,''), p.content, COALESCE(p.images_json,'[]'), p.reply_to_id, p.quoted_post_id, p.status, COALESCE(p.like_count,0), COALESCE(p.reply_count,0), COALESCE(p.repost_count,0), p.created_at, p.deleted_at, u.username, COALESCE(u.nickname,''), COALESCE(u.avatar_url,'') FROM posts p JOIN users u ON u.id=p.author_id WHERE p.reply_to_id=? AND p.status='published' AND p.deleted_at IS NULL ORDER BY p.id ASC LIMIT 200`, id)
	if err != nil {
		return nil, err
	}
	posts := []*postRecord{}
	for rows.Next() {
		p, err := scanPost(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		posts = append(posts, p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	result := make([]map[string]any, 0, len(posts))
	for _, p := range posts {
		result = append(result, s.serializePost(r, p, viewerID))
	}
	return result, nil
}

func (s *Server) postTimeline(r *http.Request, targetID int64, tab string, viewerID int64) (map[string]any, error) {
	limit := boundedQueryInt(r, "limit", 20, 1, postsFeedMax)
	before := parsePositiveInt(r.URL.Query().Get("before_id"))
	sqlText := `SELECT p.id,p.author_id,COALESCE(p.club_id,0),COALESCE(p.club_country,''),p.content,COALESCE(p.images_json,'[]'),p.reply_to_id,p.quoted_post_id,p.status,COALESCE(p.like_count,0),COALESCE(p.reply_count,0),COALESCE(p.repost_count,0),p.created_at,p.deleted_at,u.username,COALESCE(u.nickname,''),COALESCE(u.avatar_url,'') FROM posts p JOIN users u ON u.id=p.author_id WHERE p.author_id=? AND p.status='published' AND p.deleted_at IS NULL`
	params := []any{targetID}
	if tab == "replies" {
		sqlText += " AND p.reply_to_id IS NOT NULL"
	} else {
		sqlText += " AND p.reply_to_id IS NULL"
	}
	if before > 0 {
		sqlText += " AND p.id<?"
		params = append(params, before)
	}
	sqlText += " ORDER BY p.id DESC LIMIT ?"
	params = append(params, limit)
	rows, err := s.db.QueryContext(r.Context(), sqlText, params...)
	if err != nil {
		return nil, err
	}
	items := []*postRecord{}
	for rows.Next() {
		p, err := scanPost(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	serialized := make([]map[string]any, 0, len(items))
	for _, p := range items {
		serialized = append(serialized, s.serializePost(r, p, viewerID))
	}
	var next any
	if len(serialized) == limit {
		next = serialized[len(serialized)-1]["id"]
	}
	return map[string]any{"posts": serialized, "next_before_id": next}, nil
}

func (s *Server) userIDByUsername(r *http.Request, username string) (int64, error) {
	var id int64
	err := s.db.QueryRowContext(r.Context(), "SELECT id FROM users WHERE username=? AND status='active' LIMIT 1", username).Scan(&id)
	return id, err
}
func (s *Server) postUserPayload(r *http.Request, id int64) map[string]any {
	u, err := s.findUser(r.Context(), id)
	if err != nil || u == nil {
		return nil
	}
	return map[string]any{"id": u.ID, "username": u.Username, "handle": "@" + u.Username, "nickname": firstNonEmpty(u.Nickname, u.Username), "avatar_url": u.AvatarURL, "role": u.Role, "can_manage": u.Role == "super_admin"}
}
func (s *Server) postSelectableClubs(r *http.Request, id int64) []map[string]any {
	rows, err := s.db.QueryContext(r.Context(), "SELECT id,club_id,COALESCE(country,'china'),role FROM club_memberships WHERE user_id=? AND status='active' AND role IN ('member','manager','representative') ORDER BY id DESC", id)
	if err != nil {
		return []map[string]any{}
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var mid, cid int64
		var country, role string
		if rows.Scan(&mid, &cid, &country, &role) == nil {
			out = append(out, map[string]any{"membership_id": mid, "club_id": cid, "country": country, "role": role})
		}
	}
	return out
}
func (s *Server) postProfile(r *http.Request, id, viewer int64) (map[string]any, error) {
	var username, nickname, avatar, banner, role, bio, created string
	err := s.db.QueryRowContext(r.Context(), "SELECT username,COALESCE(nickname,''),COALESCE(avatar_url,''),COALESCE(banner_url,''),role,COALESCE(profile_bio,''),created_at FROM users WHERE id=? AND status='active'", id).Scan(&username, &nickname, &avatar, &banner, &role, &bio, &created)
	if err != nil {
		return nil, err
	}
	var posts, followers, following int
	_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM posts WHERE author_id=? AND status='published' AND deleted_at IS NULL", id).Scan(&posts)
	_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM user_follows WHERE following_id=?", id).Scan(&followers)
	_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM user_follows WHERE follower_id=?", id).Scan(&following)
	var followingMe int
	if viewer > 0 {
		_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM user_follows WHERE follower_id=? AND following_id=?", viewer, id).Scan(&followingMe)
	}
	return map[string]any{"id": id, "username": username, "handle": "@" + username, "nickname": firstNonEmpty(nickname, username), "avatar_url": avatar, "banner_url": banner, "role": role, "bio": bio, "created_at": created, "stats": map[string]any{"posts": posts, "followers": followers, "following": following}, "is_self": viewer == id, "is_following": followingMe > 0}, nil
}
func (s *Server) postSuggested(r *http.Request, viewer int64) []map[string]any {
	rows, err := s.db.QueryContext(r.Context(), "SELECT u.id,u.username,COALESCE(u.nickname,''),COALESCE(u.avatar_url,''),COUNT(p.id) FROM users u JOIN posts p ON p.author_id=u.id AND p.status='published' AND p.deleted_at IS NULL WHERE u.status='active' AND (?=0 OR u.id<>? ) GROUP BY u.id,u.username,u.nickname,u.avatar_url ORDER BY MAX(p.id) DESC LIMIT 4", viewer, viewer)
	if err != nil {
		return []map[string]any{}
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, count int64
		var username, nickname, avatar string
		if rows.Scan(&id, &username, &nickname, &avatar, &count) == nil {
			out = append(out, map[string]any{"id": id, "username": username, "handle": "@" + username, "nickname": firstNonEmpty(nickname, username), "avatar_url": avatar, "post_count": count})
		}
	}
	return out
}
func (s *Server) postFollowList(r *http.Request, viewer int64) map[string]any {
	out := map[string]any{"followers": []map[string]any{}, "following": []map[string]any{}}
	for key, sqlText := range map[string]string{"followers": "SELECT u.id,u.username,COALESCE(u.nickname,''),COALESCE(u.avatar_url,'') FROM user_follows f JOIN users u ON u.id=f.follower_id WHERE f.following_id=? ORDER BY f.id DESC LIMIT 100", "following": "SELECT u.id,u.username,COALESCE(u.nickname,''),COALESCE(u.avatar_url,'') FROM user_follows f JOIN users u ON u.id=f.following_id WHERE f.follower_id=? ORDER BY f.id DESC LIMIT 100"} {
		rows, err := s.db.QueryContext(r.Context(), sqlText, viewer)
		if err != nil {
			continue
		}
		items := []map[string]any{}
		for rows.Next() {
			var id int64
			var username, nickname, avatar string
			if rows.Scan(&id, &username, &nickname, &avatar) == nil {
				items = append(items, map[string]any{"id": id, "username": username, "handle": "@" + username, "nickname": firstNonEmpty(nickname, username), "avatar_url": avatar})
			}
		}
		rows.Close()
		out[key] = items
	}
	return out
}
func (s *Server) postSearchUsers(r *http.Request, q string, viewer int64) []map[string]any {
	if q == "" {
		return []map[string]any{}
	}
	like := "%" + q + "%"
	rows, err := s.db.QueryContext(r.Context(), "SELECT id,username,COALESCE(nickname,''),COALESCE(avatar_url,''),COALESCE(profile_bio,'') FROM users WHERE status='active' AND (username LIKE ? OR nickname LIKE ?) ORDER BY id ASC LIMIT 8", like, like)
	if err != nil {
		return []map[string]any{}
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var username, nickname, avatar, bio string
		if rows.Scan(&id, &username, &nickname, &avatar, &bio) == nil {
			out = append(out, map[string]any{"id": id, "username": username, "handle": "@" + username, "nickname": firstNonEmpty(nickname, username), "avatar_url": avatar, "bio": bio})
		}
	}
	return out
}
func (s *Server) postSearch(r *http.Request, q string, viewer int64) map[string]any {
	if q == "" {
		return map[string]any{"posts": []map[string]any{}, "next_before_id": nil}
	}
	limit := boundedQueryInt(r, "limit", 20, 1, postsFeedMax)
	rows, err := s.db.QueryContext(r.Context(), `SELECT p.id,p.author_id,COALESCE(p.club_id,0),COALESCE(p.club_country,''),p.content,COALESCE(p.images_json,'[]'),p.reply_to_id,p.quoted_post_id,p.status,COALESCE(p.like_count,0),COALESCE(p.reply_count,0),COALESCE(p.repost_count,0),p.created_at,p.deleted_at,u.username,COALESCE(u.nickname,''),COALESCE(u.avatar_url,'') FROM posts p JOIN users u ON u.id=p.author_id WHERE p.status='published' AND p.deleted_at IS NULL AND p.content LIKE ? ORDER BY p.id DESC LIMIT ?`, "%"+q+"%", limit)
	if err != nil {
		return map[string]any{"posts": []map[string]any{}, "next_before_id": nil}
	}
	posts := []*postRecord{}
	for rows.Next() {
		p, e := scanPost(rows)
		if e == nil {
			posts = append(posts, p)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return map[string]any{"posts": []map[string]any{}, "next_before_id": nil}
	}
	rows.Close()
	items := make([]map[string]any, 0, len(posts))
	for _, p := range posts {
		items = append(items, s.serializePost(r, p, viewer))
	}
	return map[string]any{"posts": items, "next_before_id": nil}
}

func (s *Server) createPost(r *http.Request, userID int64, input map[string]any) (*postRecord, error) {
	content := strings.TrimSpace(stringValue(input["content"]))
	content = strings.ReplaceAll(content, "\r\n", "\n")
	if content == "" {
		return nil, postFailure{Code: "required", Message: "推文内容不能为空", Status: http.StatusUnprocessableEntity, Fields: map[string]any{"field": "content"}}
	}
	if runeLength(content) > postsContentMax {
		return nil, postFailure{Code: "too_long", Message: "推文超过 280 字上限", Status: http.StatusUnprocessableEntity, Fields: map[string]any{"field": "content", "max_length": postsContentMax}}
	}
	for _, r := range content {
		if r < 0x20 && r != '\n' && r != '\t' || r == 0x7f {
			return nil, postFailure{Code: "invalid_content", Message: "推文包含不可用字符", Status: http.StatusUnprocessableEntity}
		}
	}
	uploadToken := strings.TrimSpace(stringValue(input["upload_token"]))
	if uploadToken != "" && !uploadTokenRE.MatchString(uploadToken) {
		return nil, postFailure{Code: "invalid_upload_token", Message: "上传标识无效", Status: http.StatusUnprocessableEntity}
	}
	rawImages, imagesProvided := input["images"]
	if !imagesProvided {
		rawImages = []any{}
	}
	imagesInput, ok := rawImages.([]any)
	if !ok {
		return nil, postFailure{Code: "invalid_image", Message: "图片参数无效", Status: http.StatusUnprocessableEntity}
	}
	if len(imagesInput) > postsImagesMax {
		return nil, postFailure{Code: "too_many_images", Message: "一条推文最多 4 张图片", Status: http.StatusUnprocessableEntity}
	}
	images := []string{}
	for _, item := range imagesInput {
		value := strings.TrimLeft(strings.ReplaceAll(stringValue(item), `\`, "/"), "/")
		if value == "" || strings.Contains(value, "..") || !strings.HasPrefix(value, "uploads/posts/") || !postStoredPathRE.MatchString(value) {
			return nil, postFailure{Code: "invalid_image", Message: "图片参数无效", Status: http.StatusUnprocessableEntity, Fields: map[string]any{"field": "images"}}
		}
		if !containsString(images, value) {
			images = append(images, value)
		}
	}
	if len(images) > 0 && s.db == nil {
		return nil, postFailure{Code: "posts_unavailable", Message: "动态操作失败，请稍后重试", Status: http.StatusInternalServerError}
	}
	clubID, clubCountry, err := s.resolvePostClub(r, userID, input["club_membership_id"])
	if err != nil {
		return nil, err
	}
	// Every image must have been uploaded by this user. Unpublished uploads
	// additionally require the same upload_token that the editor submitted;
	// this prevents a caller from attaching another user's or another editor's
	// orphaned file merely by guessing a public path.
	if len(images) > 0 {
		for _, imagePath := range images {
			var attachmentToken string
			var postID sql.NullInt64
			if err := s.db.QueryRowContext(r.Context(), "SELECT upload_token, post_id FROM post_attachments WHERE uploader_id=? AND relative_path=? LIMIT 1", userID, imagePath).Scan(&attachmentToken, &postID); err != nil {
				return nil, postFailure{Code: "attachment_not_owned", Message: "推文包含未通过上传的图片", Status: http.StatusUnprocessableEntity, Fields: map[string]any{"field": "images"}}
			}
			if !postID.Valid && (uploadToken == "" || attachmentToken != uploadToken) {
				return nil, postFailure{Code: "attachment_token_mismatch", Message: "图片上传标识已失效，请重新上传", Status: http.StatusUnprocessableEntity, Fields: map[string]any{"field": "images"}}
			}
		}
	}
	reply := integerValue(input["reply_to_id"])
	quoted := integerValue(input["quoted_post_id"])
	if reply > 0 {
		p, _ := s.fetchPost(r, reply)
		if p == nil || p.Status != "published" || p.DeletedAt != "" {
			return nil, postFailure{Code: "not_found", Message: "回复的目标推文不存在", Status: http.StatusNotFound}
		}
	}
	if quoted > 0 {
		p, _ := s.fetchPost(r, quoted)
		if p == nil || p.Status != "published" || p.DeletedAt != "" {
			return nil, postFailure{Code: "not_found", Message: "引用的推文不存在", Status: http.StatusNotFound}
		}
	}
	now := time.Now().Format("2006-01-02 15:04:05")
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	data, _ := json.Marshal(images)
	result, err := tx.ExecContext(r.Context(), "INSERT INTO posts (author_id,club_id,club_country,content,images_json,reply_to_id,quoted_post_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", userID, nullID(clubID), nullString(clubCountry), content, string(data), nullID(reply), nullID(quoted), "published", now, now)
	if err != nil {
		return nil, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return nil, err
	}
	if reply > 0 {
		if _, err = tx.ExecContext(r.Context(), "UPDATE posts SET reply_count=reply_count+1,updated_at=? WHERE id=?", now, reply); err != nil {
			return nil, err
		}
	}
	if quoted > 0 {
		if _, err = tx.ExecContext(r.Context(), "UPDATE posts SET repost_count=repost_count+1,updated_at=? WHERE id=?", now, quoted); err != nil {
			return nil, err
		}
	}
	for _, imagePath := range images {
		result, bindErr := tx.ExecContext(r.Context(), "UPDATE post_attachments SET post_id=? WHERE uploader_id=? AND relative_path=? AND post_id IS NULL", id, userID, imagePath)
		if bindErr != nil {
			return nil, bindErr
		}
		if affected, affectedErr := result.RowsAffected(); affectedErr == nil && affected == 0 {
			// A previously published attachment may be reused, matching the
			// legacy PHP behavior. A new/orphaned attachment must still bind.
			var existing sql.NullInt64
			if scanErr := tx.QueryRowContext(r.Context(), "SELECT post_id FROM post_attachments WHERE uploader_id=? AND relative_path=? LIMIT 1", userID, imagePath).Scan(&existing); scanErr != nil || !existing.Valid {
				return nil, postFailure{Code: "attachment_not_owned", Message: "推文包含未通过上传的图片", Status: http.StatusUnprocessableEntity}
			}
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	// post_images.php is also used by private messages, so promotion happens
	// only after this public post is committed. A provider failure leaves the
	// post and its local image fully usable.
	s.promotePostImages(r.Context(), id, userID, images)
	return s.fetchPost(r, id)
}

func nullString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (s *Server) resolvePostClub(r *http.Request, userID int64, raw any) (int64, string, error) {
	membershipID := integerValue(raw)
	if membershipID <= 0 {
		return 0, "", nil
	}
	if s.db == nil {
		return 0, "", postFailure{Code: "invalid_club", Message: "同好会归属无效或已失效", Status: http.StatusUnprocessableEntity, Fields: map[string]any{"field": "club_membership_id"}}
	}
	var clubID int64
	var country string
	err := s.db.QueryRowContext(r.Context(), "SELECT club_id, COALESCE(country,'') FROM club_memberships WHERE id=? AND user_id=? AND status='active' LIMIT 1", membershipID, userID).Scan(&clubID, &country)
	if err != nil || clubID <= 0 || (country != "china" && country != "japan") {
		return 0, "", postFailure{Code: "invalid_club", Message: "同好会归属无效或已失效", Status: http.StatusUnprocessableEntity, Fields: map[string]any{"field": "club_membership_id"}}
	}
	return clubID, country, nil
}

func (s *Server) validateOwnedPostImages(r *http.Request, userID int64, raw any) ([]string, error) {
	if raw == nil {
		return []string{}, nil
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, postFailure{Code: "invalid_image", Message: "图片参数无效", Status: http.StatusUnprocessableEntity}
	}
	result := make([]string, 0, postsImagesMax)
	for _, item := range items {
		if len(result) >= postsImagesMax {
			break
		}
		value := strings.TrimLeft(strings.ReplaceAll(stringValue(item), `\`, "/"), "/")
		if value == "" || strings.Contains(value, "..") || !strings.HasPrefix(value, "uploads/posts/") || !postStoredPathRE.MatchString(value) {
			return nil, postFailure{Code: "invalid_image", Message: "私信图片必须通过上传接口添加", Status: http.StatusUnprocessableEntity}
		}
		if containsString(result, "/"+value) {
			continue
		}
		var owner int64
		if err := s.db.QueryRowContext(r.Context(), "SELECT uploader_id FROM post_attachments WHERE uploader_id=? AND relative_path=? LIMIT 1", userID, value).Scan(&owner); err != nil || owner != userID {
			return nil, postFailure{Code: "attachment_not_owned", Message: "私信包含未上传的图片", Status: http.StatusUnprocessableEntity}
		}
		result = append(result, "/"+value)
	}
	return result, nil
}
func nullID(value int64) any {
	if value > 0 {
		return value
	}
	return nil
}
func (s *Server) deletePost(r *http.Request, p *postRecord) error {
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now().Format("2006-01-02 15:04:05")
	if _, err = tx.ExecContext(r.Context(), "UPDATE posts SET status='deleted',deleted_at=?,updated_at=? WHERE id=?", now, now, p.ID); err != nil {
		return err
	}
	if p.ReplyToID.Valid {
		_, _ = tx.ExecContext(r.Context(), "UPDATE posts SET reply_count=CASE WHEN reply_count>0 THEN reply_count-1 ELSE 0 END,updated_at=? WHERE id=?", now, p.ReplyToID.Int64)
	}
	if p.QuotedPostID.Valid {
		_, _ = tx.ExecContext(r.Context(), "UPDATE posts SET repost_count=CASE WHEN repost_count>0 THEN repost_count-1 ELSE 0 END,updated_at=? WHERE id=?", now, p.QuotedPostID.Int64)
	}
	return tx.Commit()
}
func (s *Server) setPostLike(r *http.Request, id, userID int64, liked bool) (int, error) {
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if liked {
		q := "INSERT OR IGNORE INTO post_likes(post_id,user_id,created_at) VALUES(?,?,CURRENT_TIMESTAMP)"
		if s.cfg.DBDriver == "mysql" {
			q = "INSERT IGNORE INTO post_likes(post_id,user_id,created_at) VALUES(?,?,CURRENT_TIMESTAMP)"
		}
		if _, err = tx.ExecContext(r.Context(), q, id, userID); err != nil {
			return 0, err
		}
	} else if _, err = tx.ExecContext(r.Context(), "DELETE FROM post_likes WHERE post_id=? AND user_id=?", id, userID); err != nil {
		return 0, err
	}
	var count int
	if err = tx.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM post_likes WHERE post_id=?", id).Scan(&count); err != nil {
		return 0, err
	}
	if _, err = tx.ExecContext(r.Context(), "UPDATE posts SET like_count=? WHERE id=?", count, id); err != nil {
		return 0, err
	}
	return count, tx.Commit()
}
func (s *Server) setFollow(r *http.Request, userID, target int64, following bool) error {
	var exists int
	if err := s.db.QueryRowContext(r.Context(), "SELECT 1 FROM users WHERE id=? AND status='active'", target).Scan(&exists); err != nil {
		return err
	}
	if following {
		q := "INSERT OR IGNORE INTO user_follows(follower_id,following_id,created_at) VALUES(?,?,CURRENT_TIMESTAMP)"
		if s.cfg.DBDriver == "mysql" {
			q = "INSERT IGNORE INTO user_follows(follower_id,following_id,created_at) VALUES(?,?,CURRENT_TIMESTAMP)"
		}
		_, err := s.db.ExecContext(r.Context(), q, userID, target)
		return err
	}
	_, err := s.db.ExecContext(r.Context(), "DELETE FROM user_follows WHERE follower_id=? AND following_id=?", userID, target)
	return err
}
func (s *Server) isSuperAdmin(r *http.Request, id int64) bool {
	var role string
	return s.db.QueryRowContext(r.Context(), "SELECT role FROM users WHERE id=? AND status='active'", id).Scan(&role) == nil && role == "super_admin"
}
