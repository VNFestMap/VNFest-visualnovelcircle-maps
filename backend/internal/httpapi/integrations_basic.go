package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var backgroundExtensions = map[string]bool{
	".avif": true,
	".gif":  true,
	".jpeg": true,
	".jpg":  true,
	".png":  true,
	".webp": true,
}

func (s *Server) backgrounds(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}

	dir := filepath.Join(s.cfg.Root, "image", "background")
	root, rootErr := filepath.Abs(s.cfg.Root)
	dirAbs, dirErr := filepath.Abs(dir)
	if rootErr != nil || dirErr != nil || !pathWithin(root, dirAbs) {
		writeJSON(w, map[string]any{"success": true, "images": []any{}})
		return
	}
	entries, err := os.ReadDir(dirAbs)
	if errors.Is(err, os.ErrNotExist) {
		writeJSON(w, map[string]any{"success": true, "images": []any{}})
		return
	}
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "无法读取背景图片"})
		return
	}

	type background struct {
		Name  string `json:"name"`
		File  string `json:"file"`
		URL   string `json:"url"`
		MTime int64  `json:"mtime"`
	}
	images := make([]background, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !backgroundExtensions[strings.ToLower(filepath.Ext(entry.Name()))] {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		images = append(images, background{
			Name:  strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())),
			File:  entry.Name(),
			URL:   "image/background/" + url.PathEscape(entry.Name()),
			MTime: info.ModTime().Unix(),
		})
	}
	sort.SliceStable(images, func(i, j int) bool {
		if images[i].MTime == images[j].MTime {
			return images[i].File < images[j].File
		}
		return images[i].MTime > images[j].MTime
	})
	writeJSON(w, map[string]any{"success": true, "images": images})
}

func pathWithin(root, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

type vndbResponse struct {
	Data   map[string]any
	Status int
	Err    error
}

func (s *Server) vndbSearch(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	action := strings.TrimSpace(r.URL.Query().Get("action"))
	if action == "" {
		action = "vn"
	}
	keyword := strings.TrimSpace(r.URL.Query().Get("keyword"))
	if keyword == "" {
		writeJSON(w, map[string]any{"success": false, "message": "请输入关键词"})
		return
	}
	limit := boundedQueryInt(r, "limit", 12, 1, 30)
	pathName, fields, ok := vndbSearchSpec(action)
	if !ok {
		writeJSON(w, map[string]any{"success": false, "message": "Invalid action"})
		return
	}
	body := map[string]any{
		"filters": []any{"search", "=", keyword},
		"fields":  fields,
		"sort":    "searchrank",
		"results": limit,
	}
	response := s.vndbRequest(r.Context(), pathName, body)
	if response.Err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "VNDB API request failed"})
		return
	}
	if response.Status >= 400 || response.Data == nil {
		writeJSON(w, map[string]any{"success": false, "message": "JSON parse failed"})
		return
	}
	results := normalizeVNDBSearch(action, response.Data)
	writeJSON(w, map[string]any{
		"success": true,
		"count":   len(results),
		"data":    results,
		"_api":    "POST /kana/" + pathName,
	})
}

func vndbSearchSpec(action string) (string, string, bool) {
	switch action {
	case "vn":
		return "vn", "title, aliases, image.url, released, developers.name, description, rating, tags.name", true
	case "character":
		return "character", "name, original, aliases, description, image.url, vns.title, vns.id", true
	default:
		return "", "", false
	}
}

func (s *Server) vndbProxy(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	action := strings.TrimSpace(r.URL.Query().Get("action"))
	if action != "search" && action != "search_vn" {
		writeJSON(w, map[string]any{"success": false, "message": "未知操作 action=" + action})
		return
	}
	keyword := strings.TrimSpace(r.URL.Query().Get("keyword"))
	if keyword == "" {
		writeJSON(w, map[string]any{"success": false, "message": "请输入 VNDB 搜索关键词"})
		return
	}
	limit := boundedQueryInt(r, "limit", 10, 1, 20)
	body := map[string]any{
		"filters": []any{"search", "=", keyword},
		"fields":  "id,title,aliases,released,image.url,description,developers.name",
		"sort":    "searchrank",
		"results": limit,
	}
	cacheKey := vndbCacheKey("search", keyword, limit)
	response := s.vndbCachedRequest(r.Context(), "vn", body, cacheKey, time.Hour)
	if response.Err != nil || response.Data == nil || response.Status >= 400 {
		writeJSON(w, map[string]any{"success": false, "message": "VNDB API 请求失败", "status": response.Status})
		return
	}
	results := make([]map[string]any, 0)
	for _, item := range anySlice(response.Data["results"]) {
		if row, ok := item.(map[string]any); ok {
			results = append(results, normalizeVNDBProxy(row))
		}
	}
	writeJSON(w, map[string]any{"success": true, "data": results})
}

func (s *Server) vndbRequest(ctx context.Context, endpoint string, payload map[string]any) vndbResponse {
	return s.vndbRequestURL(ctx, strings.TrimRight(s.cfg.VNDBAPIURL, "/")+"/"+endpoint, payload)
}

func (s *Server) vndbRequestURL(ctx context.Context, rawURL string, payload map[string]any) vndbResponse {
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return vndbResponse{Err: fmt.Errorf("invalid external URL")}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return vndbResponse{Err: err}
	}
	requestCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, parsed.String(), strings.NewReader(string(body)))
	if err != nil {
		return vndbResponse{Err: err}
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "VNFest/1.0 (https://map.vnfest.top; contact@vnfest.top)")
	response, err := (&http.Client{Timeout: 12 * time.Second}).Do(request)
	if err != nil {
		return vndbResponse{Err: err}
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, 2<<20)
	var data map[string]any
	decodeErr := json.NewDecoder(limited).Decode(&data)
	if decodeErr != nil {
		return vndbResponse{Status: response.StatusCode, Err: decodeErr}
	}
	return vndbResponse{Data: data, Status: response.StatusCode}
}

func (s *Server) vndbCachedRequest(ctx context.Context, endpoint string, payload map[string]any, cacheKey string, ttl time.Duration) vndbResponse {
	var stale map[string]any
	if s.files != nil {
		var cached map[string]any
		if err := s.files.ReadJSON(ctx, filepath.ToSlash(filepath.Join("cache", "vndb", cacheKey+".json")), &cached); err == nil {
			stale = cached
			if info, statErr := os.Stat(filepath.Join(s.cfg.DataDir, "cache", "vndb", cacheKey+".json")); statErr == nil && time.Since(info.ModTime()) < ttl {
				return vndbResponse{Data: cached, Status: http.StatusOK}
			}
		}
	}
	response := s.vndbRequest(ctx, endpoint, payload)
	if response.Err == nil && response.Status < 400 && response.Data != nil && s.files != nil {
		_ = s.files.WriteJSONAtomic(ctx, filepath.ToSlash(filepath.Join("cache", "vndb", cacheKey+".json")), response.Data)
	}
	if response.Err != nil && stale != nil {
		return vndbResponse{Data: stale, Status: http.StatusOK}
	}
	return response
}

func vndbCacheKey(prefix, keyword string, limit int) string {
	sum := sha256.Sum256([]byte(strings.ToLower(keyword) + "_" + fmt.Sprint(limit)))
	return prefix + "_" + hex.EncodeToString(sum[:])
}

func normalizeVNDBSearch(action string, data map[string]any) []map[string]any {
	results := make([]map[string]any, 0)
	for _, item := range anySlice(data["results"]) {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		image, _ := row["image"].(map[string]any)
		if action == "vn" {
			developers := make([]string, 0, 3)
			for _, developer := range anySlice(row["developers"]) {
				if item, ok := developer.(map[string]any); ok {
					if name := stringValue(item["name"]); name != "" && len(developers) < 3 {
						developers = append(developers, name)
					}
				}
			}
			results = append(results, map[string]any{
				"vndb_id": stringValue(row["id"]), "title": stringValue(row["title"]), "title_cn": "",
				"aliases": row["aliases"], "image_url": stringValue(image["url"]), "developers": developers,
				"rating": row["rating"], "summary": truncateString(stringValue(row["description"]), 240),
				"tags": firstAny(row["tags"], 8), "released": stringValue(row["released"]),
				"url": "https://vndb.org/" + stringValue(row["id"]),
			})
			continue
		}
		results = append(results, map[string]any{
			"vndb_id": stringValue(row["id"]), "name": stringValue(row["name"]), "original": stringValue(row["original"]),
			"aliases": row["aliases"], "image_url": stringValue(image["url"]), "summary": truncateString(stringValue(row["description"]), 240),
			"vns": firstAny(row["vns"], 5), "url": "https://vndb.org/" + stringValue(row["id"]),
		})
	}
	return results
}

func normalizeVNDBProxy(row map[string]any) map[string]any {
	image, _ := row["image"].(map[string]any)
	developers := make([]string, 0, 2)
	for _, item := range anySlice(row["developers"]) {
		if developer, ok := item.(map[string]any); ok {
			if name := stringValue(developer["name"]); name != "" && len(developers) < 2 {
				developers = append(developers, name)
			}
		}
	}
	released := stringValue(row["released"])
	if utf8.RuneCountInString(released) > 4 {
		released = string([]rune(released)[:4])
	}
	return map[string]any{
		"vndb_id": stringValue(row["id"]), "title": stringValue(row["title"]),
		"title_alias": strings.Join(stringSlice(row["aliases"], 3), " / "), "brand": strings.Join(developers, " / "),
		"release_year": released, "cover_url": stringValue(image["url"]),
		"summary":      truncateString(stringValue(row["description"]), 240),
		"external_url": "https://vndb.org/" + stringValue(row["id"]),
	}
}

func anySlice(value any) []any {
	if maps, ok := value.([]map[string]any); ok {
		items := make([]any, 0, len(maps))
		for _, item := range maps {
			items = append(items, item)
		}
		return items
	}
	items, _ := value.([]any)
	return items
}

func firstAny(value any, limit int) []any {
	items := anySlice(value)
	if len(items) > limit {
		return items[:limit]
	}
	return items
}

func stringSlice(value any, limit int) []string {
	result := make([]string, 0, limit)
	for _, item := range anySlice(value) {
		if value := stringValue(item); value != "" && len(result) < limit {
			result = append(result, value)
		}
	}
	return result
}

func truncateString(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	return string([]rune(value)[:limit])
}

func boundedQueryInt(r *http.Request, key string, fallback, min, max int) int {
	value := fallback
	if raw := r.URL.Query().Get(key); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			value = fallback
		} else {
			value = parsed
		}
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func (s *Server) quiz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	switch r.URL.Query().Get("action") {
	case "submit_results":
		s.quizSubmitResults(w, r)
	case "my_results":
		s.quizMyResults(w, r)
	default:
		writeJSON(w, map[string]any{"success": false, "message": "未知操作，可用: submit_results, my_results"})
	}
}

func (s *Server) quizSubmitResults(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
		return
	}
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	parts := strings.Fields(auth)
	if len(parts) != 2 || parts[0] != "Bearer" || parts[1] == "" {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "未提供 API Key"})
		return
	}
	if s.cfg.QuizAPIKey == "" || subtle.ConstantTimeCompare([]byte(s.cfg.QuizAPIKey), []byte(parts[1])) != 1 {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "API Key 无效"})
		return
	}
	var body struct {
		RoomCode  string `json:"room_code"`
		QuizTitle string `json:"quiz_title"`
		EndedAt   int64  `json:"ended_at"`
		Players   []struct {
			VNFestID int64  `json:"vnfest_id"`
			Name     string `json:"name"`
			Score    int64  `json:"score"`
			Rank     int64  `json:"rank"`
		} `json:"players"`
	}
	if err := decodeJSON(r, &body, 2<<20); err != nil || strings.TrimSpace(body.RoomCode) == "" || len(body.Players) == 0 {
		writeJSON(w, map[string]any{"success": false, "message": "缺少 room_code / players"})
		return
	}
	if s.db == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "数据库不可用"})
		return
	}
	roomCode := truncateString(strings.TrimSpace(body.RoomCode), 16)
	quizTitle := truncateString(body.QuizTitle, 255)
	endedAt := body.EndedAt
	if endedAt > 0 && endedAt < 1000000000000 {
		endedAt *= 1000
	}
	if endedAt < 0 {
		endedAt = 0
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "提交战绩失败"})
		return
	}
	defer tx.Rollback()
	checkUser, err := tx.PrepareContext(r.Context(), "SELECT id FROM users WHERE id = ? AND status = 'active'")
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "提交战绩失败"})
		return
	}
	defer checkUser.Close()
	insertSQL := "INSERT OR IGNORE INTO quiz_results (vnfest_user_id, room_code, quiz_title, player_name, score, player_rank, players_count, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
	if s.cfg.DBDriver == "mysql" {
		insertSQL = "INSERT IGNORE INTO quiz_results (vnfest_user_id, room_code, quiz_title, player_name, score, player_rank, players_count, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
	}
	insert, err := tx.PrepareContext(r.Context(), insertSQL)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "提交战绩失败"})
		return
	}
	defer insert.Close()
	inserted := 0
	for _, player := range body.Players {
		if player.VNFestID <= 0 {
			continue
		}
		var existing int64
		if err := checkUser.QueryRowContext(r.Context(), player.VNFestID).Scan(&existing); err != nil {
			if isNoRows(err) {
				continue
			}
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "提交战绩失败"})
			return
		}
		result, err := insert.ExecContext(r.Context(), player.VNFestID, roomCode, quizTitle, truncateString(player.Name, 64), player.Score, player.Rank, len(body.Players), endedAt)
		if err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "提交战绩失败"})
			return
		}
		if affected, err := result.RowsAffected(); err == nil && affected > 0 {
			inserted++
		}
	}
	if err := tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "提交战绩失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "inserted": inserted, "received": len(body.Players)})
}

func (s *Server) quizMyResults(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 GET"})
		return
	}
	userID, _ := s.optionalSessionUser(r)
	if userID == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	if s.db == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "数据库不可用"})
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT room_code, quiz_title, player_name, score, player_rank, players_count, ended_at
        FROM quiz_results WHERE vnfest_user_id = ? ORDER BY ended_at DESC LIMIT 30`, *userID)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "无法读取答题记录"})
		return
	}
	defer rows.Close()
	results := make([]map[string]any, 0)
	for rows.Next() {
		var roomCode, quizTitle, playerName string
		var score, rank, playersCount, endedAt any
		if err := rows.Scan(&roomCode, &quizTitle, &playerName, &score, &rank, &playersCount, &endedAt); err == nil {
			results = append(results, map[string]any{"room_code": roomCode, "quiz_title": quizTitle, "player_name": playerName, "score": score, "player_rank": rank, "players_count": playersCount, "ended_at": endedAt})
		}
	}
	writeJSON(w, map[string]any{"success": true, "results": results})
}

func (s *Server) quizAuth(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if quizOriginAllowed(origin) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Vary", "Origin")
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, max-age=300")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	userID, _ := s.optionalSessionUser(r)
	if userID == nil {
		writeJSONCache(w, http.StatusOK, map[string]any{"ok": false, "user": nil}, "private, max-age=300")
		return
	}
	user, err := s.findUser(r.Context(), *userID)
	if err != nil || user == nil {
		writeJSONCache(w, http.StatusOK, map[string]any{"ok": false, "user": nil}, "private, max-age=300")
		return
	}
	team := map[string]any{"is_member": false, "role": nil}
	if s.db != nil {
		var role string
		err := s.db.QueryRowContext(r.Context(), `SELECT role FROM club_memberships WHERE user_id = ? AND status = 'active'
            ORDER BY CASE role WHEN 'representative' THEN 3 WHEN 'manager' THEN 2 WHEN 'member' THEN 1 WHEN 'external' THEN 0 ELSE 0 END DESC LIMIT 1`, user.ID).Scan(&role)
		if err == nil {
			team = map[string]any{"is_member": true, "role": role}
		}
	}
	var avatar any
	if user.AvatarURL != "" {
		avatar = user.AvatarURL
		if !strings.HasPrefix(user.AvatarURL, "http://") && !strings.HasPrefix(user.AvatarURL, "https://") {
			avatar = strings.TrimRight(s.cfg.SiteURL, "/") + "/" + strings.TrimLeft(user.AvatarURL, "/")
		}
	}
	public := map[string]any{"id": user.ID, "username": user.Username, "nickname": firstNonEmpty(user.Nickname, user.Username), "avatar_url": avatar, "role": user.Role, "team": team}
	response := map[string]any{"ok": true, "user": public, "bind_token": nil}
	if s.cfg.QuizLinkSecret != "" {
		payload, _ := json.Marshal(map[string]any{"uid": user.ID, "username": user.Username, "nickname": firstNonEmpty(user.Nickname, user.Username), "avatar_url": avatar, "team": team, "exp": time.Now().Add(7 * 24 * time.Hour).Unix()})
		encoded := base64.RawURLEncoding.EncodeToString(payload)
		mac := hmac.New(sha256.New, []byte(s.cfg.QuizLinkSecret))
		_, _ = mac.Write([]byte(encoded))
		response["bind_token"] = encoded + "." + hex.EncodeToString(mac.Sum(nil))
	}
	writeJSONCache(w, http.StatusOK, response, "private, max-age=300")
}

func writeJSONCache(w http.ResponseWriter, status int, value any, cacheControl string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", cacheControl)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func quizOriginAllowed(origin string) bool {
	if origin == "https://makoquiz.vnfest.top" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return false
	}
	return parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1"
}
