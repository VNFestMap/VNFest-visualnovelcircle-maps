package httpapi

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const bangumiResponseLimit = 2 << 20

func (s *Server) bangumiAccount(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	if action == "" || action == "status" {
		var id, bgmID int64
		var username, nickname string
		err := s.db.QueryRowContext(r.Context(), `SELECT id,bangumi_user_id,bangumi_username,COALESCE(bangumi_nickname,'') FROM bangumi_bindings WHERE vnfmap_user_id=? LIMIT 1`, userID).Scan(&id, &bgmID, &username, &nickname)
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, map[string]any{"success": true, "bound": false, "account": nil})
			return
		}
		if err != nil {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "Bangumi 绑定功能尚未完成数据库初始化"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "bound": true, "account": map[string]any{"user_id": bgmID, "username": username, "nickname": nickname}})
		return
	}
	if action != "collections" {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "未知动作"})
		return
	}
	limit := boundedQueryInt(r, "limit", 100, 1, 100)
	offset := boundedQueryInt(r, "offset", 0, 0, 100000)
	var username, accessCipher string
	err := s.db.QueryRowContext(r.Context(), `SELECT bangumi_username,access_token_ciphertext FROM bangumi_bindings WHERE vnfmap_user_id=? LIMIT 1`, userID).Scan(&username, &accessCipher)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请先绑定 Bangumi 账号"})
		return
	}
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "Bangumi 绑定功能尚未完成数据库初始化"})
		return
	}
	accessToken, err := openBangumiToken(s.cfg.BangumiTokenKey, accessCipher)
	if err != nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "Bangumi 授权已失效，请重新绑定"})
		return
	}
	endpoint := s.bangumiAPIURL() + "/v0/users/" + url.PathEscape(username) + "/collections?subject_type=4&type=2&limit=" + strconv.Itoa(limit) + "&offset=" + strconv.Itoa(offset)
	status, payload, err := s.bangumiRequest(r, http.MethodGet, endpoint, accessToken, nil)
	if err != nil || status == http.StatusUnauthorized {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "Bangumi 授权已失效，请重新绑定"})
		return
	}
	if status < 200 || status >= 300 {
		writeJSONStatus(w, http.StatusBadGateway, map[string]any{"success": false, "message": "暂时无法读取 Bangumi 收藏，请稍后再试"})
		return
	}
	var document map[string]any
	if json.Unmarshal(payload, &document) != nil {
		writeJSONStatus(w, http.StatusBadGateway, map[string]any{"success": false, "message": "Bangumi 返回数据无效"})
		return
	}
	items := []map[string]any{}
	for _, raw := range anySlice(document["data"]) {
		row, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		subject, _ := row["subject"].(map[string]any)
		subjectID := int64Value(row["subject_id"])
		if subjectID == 0 {
			subjectID = int64Value(subject["id"])
		}
		if subjectID <= 0 {
			continue
		}
		original := stringValue(subject["name"])
		chinese := firstNonEmpty(stringValue(subject["name_cn"]), original)
		items = append(items, map[string]any{"bangumi_id": subjectID, "title": original, "title_cn": chinese, "image": bangumiImageProxy(subject), "source": "bangumi", "collection_type": int64Value(row["type"])})
	}
	total := int64Value(document["total"])
	if total == 0 {
		total = int64(offset) + int64(len(items))
	}
	writeJSON(w, map[string]any{"success": true, "items": items, "pagination": map[string]any{"limit": limit, "offset": offset, "total": total, "has_more": int64(offset)+int64(len(items)) < total || len(items) >= limit}})
}

func (s *Server) bangumiV0Search(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		methodNotAllowed(w, "GET, POST")
		return
	}
	keyword := strings.TrimSpace(r.URL.Query().Get("keyword"))
	if keyword == "" {
		writeJSON(w, map[string]any{"success": false, "message": "请输入关键词"})
		return
	}
	limit := boundedQueryInt(r, "limit", 20, 1, 50)
	payload := map[string]any{"keyword": keyword, "filter": map[string]any{"type": []int{4}}, "sort": "rank"}
	status, raw, err := s.bangumiRequest(r, http.MethodPost, s.bangumiAPIURL()+"/v0/search/subjects?limit="+strconv.Itoa(limit), "", payload)
	if err != nil || status < 200 || status >= 300 {
		writeJSONStatus(w, http.StatusBadGateway, map[string]any{"success": false, "message": "Bangumi API request failed"})
		return
	}
	writeJSON(w, normalizeBangumiV0Search(raw))
}

func (s *Server) bangumiProxy(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		methodNotAllowed(w, "GET, POST")
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	keyword := strings.TrimSpace(r.URL.Query().Get("keyword"))
	if action == "search" || action == "search_subject" {
		if keyword == "" {
			writeJSON(w, map[string]any{"success": false, "message": "请输入关键词"})
			return
		}
		typ := boundedQueryInt(r, "type", 4, 1, 10)
		endpoint := s.bangumiAPIURL() + "/search/subject/" + url.PathEscape(keyword) + "?type=" + strconv.Itoa(typ) + "&responseGroup=large"
		status, raw, err := s.bangumiRequest(r, http.MethodGet, endpoint, "", nil)
		if err != nil || status < 200 || status >= 300 {
			writeJSONStatus(w, http.StatusBadGateway, map[string]any{"success": false, "message": "Bangumi API request failed"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "data": normalizeBangumiLegacySearch(raw)})
		return
	}
	if action == "search_character" {
		if keyword == "" {
			writeJSON(w, map[string]any{"success": false, "message": "请输入角色关键词"})
			return
		}
		limit := boundedQueryInt(r, "limit", 20, 1, 50)
		offset := boundedQueryInt(r, "offset", 0, 0, 100000)
		payload := map[string]any{"keyword": keyword, "filter": map[string]any{"nsfw": true}}
		endpoint := s.bangumiAPIURL() + "/v0/search/characters?limit=" + strconv.Itoa(limit) + "&offset=" + strconv.Itoa(offset)
		status, raw, err := s.bangumiRequest(r, http.MethodPost, endpoint, "", payload)
		if err != nil || status < 200 || status >= 300 {
			writeJSONStatus(w, http.StatusBadGateway, map[string]any{"success": false, "message": "Bangumi API request failed"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "total": 0, "data": normalizeBangumiCharacters(raw)})
		return
	}
	path := ""
	switch action {
	case "get":
		path = "/v0/subjects/" + strconv.FormatInt(parsePositiveInt(r.URL.Query().Get("id")), 10)
	case "get_character":
		path = "/v0/characters/" + strconv.FormatInt(parsePositiveInt(firstNonEmpty(r.URL.Query().Get("id"), r.URL.Query().Get("character_id"))), 10)
	case "subject_characters":
		path = "/v0/subjects/" + strconv.FormatInt(parsePositiveInt(firstNonEmpty(r.URL.Query().Get("subject_id"), r.URL.Query().Get("id"))), 10) + "/characters"
	case "character_persons":
		path = "/v0/characters/" + strconv.FormatInt(parsePositiveInt(firstNonEmpty(r.URL.Query().Get("id"), r.URL.Query().Get("character_id"))), 10) + "/persons"
	case "ping":
		path = "/v0/characters/1"
	default:
		writeJSON(w, map[string]any{"success": false, "message": "未知操作 action=" + action})
		return
	}
	if strings.HasSuffix(path, "/0") || strings.Contains(path, "/0/") {
		writeJSON(w, map[string]any{"success": false, "message": "无效 ID"})
		return
	}
	started := time.Now()
	status, raw, err := s.bangumiRequest(r, http.MethodGet, s.bangumiAPIURL()+path, "", nil)
	if err != nil || status < 200 || status >= 300 {
		writeJSONStatus(w, http.StatusBadGateway, map[string]any{"success": false, "message": "Bangumi API request failed"})
		return
	}
	if action == "ping" {
		writeJSON(w, map[string]any{"success": true, "bangumi_reachable": true, "elapsed_ms": time.Since(started).Milliseconds()})
		return
	}
	if action == "character_persons" {
		var people any
		_ = json.Unmarshal(raw, &people)
		names := []string{}
		for _, item := range anySlice(people) {
			if person, ok := item.(map[string]any); ok {
				if name := firstNonEmpty(stringValue(person["name"]), stringValue(person["name_cn"])); name != "" {
					names = append(names, name)
				}
			}
		}
		writeJSON(w, map[string]any{"success": true, "data": map[string]any{"cv": strings.Join(names, "、"), "names": names}})
		return
	}
	if action == "get" || action == "get_character" {
		var data any
		_ = json.Unmarshal(raw, &data)
		writeJSON(w, map[string]any{"success": true, "data": data})
		return
	}
	writeJSON(w, map[string]any{"success": true, "data": normalizeBangumiCharacters(raw)})
}

func (s *Server) bangumiAPIURL() string {
	base := strings.TrimRight(s.cfg.BangumiAPIURL, "/")
	if base == "" {
		return "https://api.bgm.tv"
	}
	return base
}

func (s *Server) bangumiRequest(r *http.Request, method, endpoint, bearer string, body any) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(r.Context(), method, endpoint, reader)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "VNFest/1.0")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	response, err := (&http.Client{Timeout: 12 * time.Second}).Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, bangumiResponseLimit+1))
	if err != nil || len(data) > bangumiResponseLimit {
		return response.StatusCode, nil, errors.New("Bangumi response too large or unreadable")
	}
	return response.StatusCode, data, nil
}

func bangumiImageProxy(subject map[string]any) string {
	images, _ := subject["images"].(map[string]any)
	for _, key := range []string{"medium", "large", "small", "grid", "common"} {
		imageURL := stringValue(images[key])
		parsed, err := url.Parse(imageURL)
		if err == nil && strings.EqualFold(parsed.Hostname(), "lain.bgm.tv") && parsed.Scheme == "https" {
			return "/api/image_proxy.php?url=" + url.QueryEscape(imageURL)
		}
	}
	return ""
}

func normalizeBangumiV0Search(raw []byte) map[string]any {
	var document map[string]any
	if json.Unmarshal(raw, &document) != nil {
		return map[string]any{"success": false, "message": "JSON parse failed"}
	}
	result := []map[string]any{}
	for _, item := range anySlice(document["data"]) {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		images, _ := row["images"].(map[string]any)
		imageURL := firstNonEmpty(stringValue(images["medium"]), stringValue(images["large"]))
		result = append(result, map[string]any{"bangumi_id": int64Value(row["id"]), "title": stringValue(row["name"]), "title_cn": stringValue(row["name_cn"]), "image_url": bangumiProxyImageURL(imageURL), "rating": bangumiRatingScore(row["rating"]), "rating_total": bangumiRatingTotal(row["rating"]), "summary": truncateString(stringValue(row["summary"]), 240), "date": stringValue(row["date"]), "tags": row["tags"], "rank": int64Value(row["rank"])})
	}
	total := int64Value(document["total"])
	return map[string]any{"success": true, "total": total, "data": result, "_api": "POST /v0/search/subjects"}
}

func normalizeBangumiCharacters(raw []byte) []map[string]any {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return []map[string]any{}
	}
	rows := anySlice(value)
	if document, ok := value.(map[string]any); ok {
		rows = anySlice(document["data"])
	}
	result := []map[string]any{}
	for _, item := range rows {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		result = append(result, map[string]any{"character_id": int64Value(row["id"]), "name": stringValue(row["name"]), "name_cn": stringValue(row["name_cn"]), "image_url": bangumiProxyImageURL(stringValue(row["image_url"])), "summary": truncateString(stringValue(row["summary"]), 240), "relation": stringValue(row["relation"]), "type": row["type"]})
	}
	return result
}

func normalizeBangumiLegacySearch(raw []byte) []map[string]any {
	var document map[string]any
	if json.Unmarshal(raw, &document) != nil {
		return []map[string]any{}
	}
	result := []map[string]any{}
	for _, item := range anySlice(document["list"]) {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		result = append(result, map[string]any{"bangumi_id": int64Value(row["id"]), "title": stringValue(row["name"]), "title_cn": stringValue(row["name_cn"]), "image_url": bangumiProxyImageURL(stringValue(row["image_url"])), "rating": bangumiRatingScore(row["rating"]), "summary": truncateString(stringValue(row["summary"]), 200), "air_date": stringValue(row["air_date"])})
	}
	return result
}

func bangumiProxyImageURL(value string) string {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme != "https" || !strings.EqualFold(parsed.Hostname(), "lain.bgm.tv") {
		return ""
	}
	return "/api/image_proxy.php?url=" + url.QueryEscape(value)
}

func bangumiRatingScore(value any) any {
	if rating, ok := value.(map[string]any); ok {
		return rating["score"]
	}
	return value
}

func bangumiRatingTotal(value any) any {
	if rating, ok := value.(map[string]any); ok {
		return rating["total"]
	}
	return 0
}
