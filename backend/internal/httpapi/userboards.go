package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	resumeMaxBytes = 10 << 20
	memeMaxBytes   = 15 << 20
	tierMaxBytes   = 15 << 20
)

var safeBoardImage = regexp.MustCompile(`(?i)^(data:image/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+|https?://[^\s<>"']+|/[^\s<>"']+|\./[^\s<>"']+|\.\./[^\s<>"']+)$`)

func (s *Server) userBoard(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/"), ".php")
	kind := strings.TrimPrefix(name, "galgame_")
	if kind != "resume" && kind != "meme" && kind != "tier" {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "接口不存在"})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if s.sessions == nil || s.sessions.Store == nil || s.db == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "服务暂不可用"})
		return
	}
	session, err := s.sessions.LoadRequest(r.Context(), r)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "暂时无法读取登录状态"})
		return
	}
	if session == nil || session.UserID == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录", "logged_in": false})
		return
	}
	userID := *session.UserID
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	if action == "load" {
		if r.Method != http.MethodGet {
			writeJSONStatus(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "message": "load 仅支持 GET 请求"})
			return
		}
		s.loadBoard(w, r, kind, userID)
		return
	}
	if action != "save" && action != "reset" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "不支持的操作"})
		return
	}
	if r.Method != http.MethodPost {
		writeJSONStatus(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "message": action + " 仅支持 POST 请求"})
		return
	}
	if kind != "resume" && !strings.HasPrefix(strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type"))), "application/json") {
		writeJSONStatus(w, http.StatusUnsupportedMediaType, map[string]any{"success": false, "message": "请求必须使用 application/json"})
		return
	}
	if !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源校验失败"})
		return
	}
	if action == "reset" {
		s.resetBoard(w, r, kind, userID)
		return
	}
	maxBytes := resumeMaxBytes
	if kind != "resume" {
		maxBytes = memeMaxBytes
	}
	_ = s.saveBoard(w, r, kind, userID, maxBytes)
}

func (s *Server) loadBoard(w http.ResponseWriter, r *http.Request, kind string, userID int64) {
	table := boardTable(kind)
	row := s.db.QueryRowContext(r.Context(), "SELECT payload, schema_version, updated_at FROM "+table+" WHERE user_id = ? LIMIT 1", userID)
	var payload string
	var schemaVersion int
	var updated any
	if err := row.Scan(&payload, &schemaVersion, &updated); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no rows") {
			writeJSON(w, map[string]any{"success": true, kind: nil, "updated_at": nil})
			return
		}
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": loadFailureMessage(kind)})
		return
	}
	var value any
	if err := json.Unmarshal([]byte(payload), &value); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": corruptFailureMessage(kind)})
		return
	}
	if kind == "meme" || kind == "tier" {
		object, ok := value.(map[string]any)
		if !ok {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": corruptFailureMessage(kind)})
			return
		}
		value = sanitizeBoard(kind, object)
	}
	writeJSON(w, map[string]any{"success": true, kind: value, "schema_version": schemaVersion, "updated_at": databaseValueString(updated)})
}

func (s *Server) resetBoard(w http.ResponseWriter, r *http.Request, kind string, userID int64) {
	if _, err := s.db.ExecContext(r.Context(), "DELETE FROM "+boardTable(kind)+" WHERE user_id = ?", userID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": resetFailureMessage(kind)})
		return
	}
	writeJSON(w, map[string]any{"success": true, "reset": true})
}

func (s *Server) saveBoard(w http.ResponseWriter, r *http.Request, kind string, userID int64, maxBytes int) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, int64(maxBytes)+1))
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请求内容为空"})
		return err
	}
	if len(body) == 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请求内容为空"})
		return nil
	}
	if len(body) > maxBytes {
		writeJSONStatus(w, http.StatusRequestEntityTooLarge, map[string]any{"success": false, "message": boardSizeMessage(kind)})
		return nil
	}
	var input map[string]any
	if err := json.NewDecoder(bytes.NewReader(body)).Decode(&input); err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请求必须是有效的 JSON"})
		return nil
	}
	object, ok := input[kind].(map[string]any)
	if !ok {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "缺少有效的 " + kind + " 对象"})
		return nil
	}
	value := sanitizeBoard(kind, object)
	encoded, err := marshalJSONNoEscape(value)
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "内容无法保存"})
		return nil
	}
	if len(encoded) > maxBytes {
		writeJSONStatus(w, http.StatusRequestEntityTooLarge, map[string]any{"success": false, "message": boardSizeMessage(kind)})
		return nil
	}
	table := boardTable(kind)
	query := "INSERT INTO " + table + " (user_id, payload, schema_version, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload, schema_version=excluded.schema_version, updated_at=CURRENT_TIMESTAMP"
	if s.db.Driver == "mysql" {
		query = "INSERT INTO " + table + " (user_id, payload, schema_version, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE payload=VALUES(payload), schema_version=VALUES(schema_version), updated_at=CURRENT_TIMESTAMP"
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": saveFailureMessage(kind)})
		return err
	}
	if _, err := tx.ExecContext(r.Context(), query, userID, string(encoded), 1); err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": saveFailureMessage(kind)})
		return err
	}
	if err := tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": saveFailureMessage(kind)})
		return err
	}
	var updated any
	if err := s.db.QueryRowContext(r.Context(), "SELECT updated_at FROM "+table+" WHERE user_id = ? LIMIT 1", userID).Scan(&updated); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": saveFailureMessage(kind)})
		return err
	}
	writeJSON(w, map[string]any{"success": true, "saved": true, "schema_version": 1, "updated_at": databaseValueString(updated)})
	return nil
}

func (s *Server) publicConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	writeJSON(w, map[string]any{"site_url": s.cfg.SiteURL, "auth_providers": []string{"local"}, "version": "2.0.0"})
}

func boardTable(kind string) string {
	switch kind {
	case "resume":
		return "galgame_resumes"
	case "meme":
		return "galgame_memes"
	default:
		return "galgame_tiers"
	}
}

func sanitizeBoard(kind string, object map[string]any) map[string]any {
	switch kind {
	case "resume":
		return sanitizeResume(object)
	case "meme":
		return sanitizeMeme(object)
	default:
		return sanitizeTier(object)
	}
}

func sanitizeResume(value map[string]any) map[string]any {
	profile, _ := value["profile"].(map[string]any)
	cleanProfile := map[string]any{
		"name": boardString(profile["name"], 240), "handle": boardString(profile["handle"], 120),
		"accountType": allowedString(profile["accountType"], []string{"x", "bgm", "bilibili", "discord", "qq"}, "bgm"),
		"avatar":      boardImage(profile["avatar"], 8<<20), "avatarShape": allowedString(profile["avatarShape"], []string{"square", "circle"}, "square"),
		"avatarPosX": clampInt(profile["avatarPosX"], 50, 0, 100), "avatarPosY": clampInt(profile["avatarPosY"], 50, 0, 100),
		"genres": boardList(profile["genres"], 20, 80), "brands": boardList(profile["brands"], 40, 240),
		"works": resumeItems(profile["works"], 30), "heroines": resumeItems(profile["heroines"], 30),
		"historyYears": boardString(profile["historyYears"], 80), "playCount": boardStringDefault(profile["playCount"], "0", 40),
		"voiceActors": boardList(profile["voiceActors"], 40, 240), "artists": boardList(profile["artists"], 40, 240),
		"writers": boardList(profile["writers"], 40, 240), "songs": boardList(profile["songs"], 40, 240),
		"attributes": boardList(profile["attributes"], 40, 120), "other": boardString(profile["other"], 4000),
	}
	enabled := []string{}
	if values, ok := value["enabledApis"].([]any); ok {
		for _, item := range values {
			name := boardString(item, 20)
			if (name == "bangumi" || name == "vndb") && !containsString(enabled, name) {
				enabled = append(enabled, name)
			}
		}
	}
	if len(enabled) == 0 {
		enabled = []string{"bangumi", "vndb"}
	}
	return map[string]any{"schema_version": 1, "mode": allowedString(value["mode"], []string{"resume", "card"}, "resume"), "moreItems": boardBool(value["moreItems"]), "popupEnabled": boardBoolDefault(value, "popupEnabled", true), "enabledApis": enabled, "profile": cleanProfile, "sections": resumeSections(value["sections"])}
}

func resumeItems(value any, maxItems int) []map[string]any {
	items, _ := value.([]any)
	result := []map[string]any{}
	for _, item := range items {
		if len(result) >= maxItems {
			break
		}
		if scalar, ok := item.(string); ok && strings.TrimSpace(scalar) != "" {
			result = append(result, map[string]any{"title": boardString(scalar, 240), "image": "", "source": "custom", "id": "", "cv": ""})
			continue
		}
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		title := boardString(object["title"], 240)
		if title == "" {
			continue
		}
		clean := map[string]any{"title": title, "image": boardImage(object["image"], 8<<20), "source": boardString(object["source"], 32), "id": boardString(object["id"], 120), "cv": boardString(object["cv"], 240)}
		if id := clampInt(object["bangumiId"], 0, 0, 1<<31-1); id > 0 {
			clean["bangumiId"] = id
		}
		result = append(result, clean)
	}
	return result
}

func resumeSections(value any) []map[string]any {
	items, _ := value.([]any)
	result := []map[string]any{}
	for _, item := range items {
		if len(result) >= 30 {
			break
		}
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id, typ := boardString(object["id"], 40), boardString(object["type"], 40)
		if id == "" || typ == "" {
			continue
		}
		entry := map[string]any{"id": id, "type": typ, "label": boardString(object["label"], 120), "span": clampInt(object["span"], 1, 1, 2)}
		if _, exists := object["field"]; exists {
			entry["field"] = boardString(object["field"], 40)
		}
		if _, exists := object["searchType"]; exists {
			entry["searchType"] = boardString(object["searchType"], 40)
		}
		result = append(result, entry)
	}
	return result
}

func sanitizeMeme(value map[string]any) map[string]any {
	board, _ := value["board"].(map[string]any)
	settings, _ := value["settings"].(map[string]any)
	mode := allowedString(board["colsMode"], []string{"fixed", "auto"}, "fixed")
	cols := clampInt(board["cols"], 6, 1, 6)
	rows := clampInt(board["rows"], 4, 1, 30)
	maxRows := 120 / 6
	if mode == "fixed" {
		maxRows = 120 / cols
	}
	if rows > maxRows {
		rows = maxRows
	}
	return map[string]any{"schema_version": 1, "board": map[string]any{"title": boardStringDefault(board["title"], "Galgame MEME", 80), "colsMode": mode, "cols": cols, "rows": rows, "cells": memeCells(board["cells"]), "unranked": memeList(board["unranked"], 100)}, "settings": map[string]any{"cardSize": allowedString(settings["cardSize"], []string{"sm", "md", "lg"}, "md"), "showTitles": boardBoolMapDefault(settings, "showTitles", true), "showPopup": boardBoolMapDefault(settings, "showPopup", true)}}
}

func memeCells(value any) []map[string]any {
	values, _ := value.([]any)
	result := []map[string]any{}
	for _, item := range values {
		if len(result) >= 120 {
			break
		}
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		result = append(result, map[string]any{"id": boardStringDefault(object["id"], fmt.Sprintf("cell-%d", len(result)), 80), "title": boardString(object["title"], 120), "cards": memeList(object["cards"], 100)})
	}
	return result
}
func memeList(value any, maxItems int) []map[string]any {
	values, _ := value.([]any)
	result := []map[string]any{}
	for _, item := range values {
		if len(result) >= maxItems {
			break
		}
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		title := boardString(object["title"], 240)
		if title == "" {
			continue
		}
		clean := map[string]any{"id": boardString(object["id"], 120), "kind": allowedString(object["kind"], []string{"work", "character", "custom"}, "custom"), "source": allowedString(object["source"], []string{"bangumi", "cngal", "resume", "custom"}, "custom"), "sourceId": boardStringDefault(object["sourceId"], boardString(object["source_id"], 160), 160), "title": title, "subtitle": boardStringDefault(object["subtitle"], boardString(object["sub"], 240), 240), "image": boardImage(object["image"], 12<<20)}
		if id := clampInt(object["bangumiId"], 0, 0, 1<<31-1); id > 0 {
			clean["bangumiId"] = id
		}
		if boardString(clean["id"], 1) == "" {
			encoded, _ := marshalJSONNoEscape(clean)
			digest := sha256.Sum256(encoded)
			clean["id"] = "meme-" + hex.EncodeToString(digest[:])[:18]
		}
		result = append(result, clean)
	}
	return result
}

func sanitizeTier(value map[string]any) map[string]any {
	board, _ := value["board"].(map[string]any)
	settings, _ := value["settings"].(map[string]any)
	return map[string]any{"schema_version": 1, "board": map[string]any{"title": boardStringDefault(board["title"], "Galgame Tier 表", 80), "rows": tierRows(board["rows"]), "unranked": tierList(board["unranked"], 100)}, "settings": map[string]any{"cardSize": allowedString(settings["cardSize"], []string{"sm", "md", "lg"}, "md"), "showTitles": boardBoolMapDefault(settings, "showTitles", true)}}
}
func tierRows(value any) []map[string]any {
	values, _ := value.([]any)
	result := []map[string]any{}
	for _, item := range values {
		if len(result) >= 12 {
			break
		}
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		result = append(result, map[string]any{"id": boardStringDefault(object["id"], fmt.Sprintf("row-%d", len(result)+1), 80), "label": boardStringDefault(object["label"], fmt.Sprintf("ROW %d", len(result)+1), 24), "color": boardColor(object["color"], "#d9d3de"), "cards": tierList(object["cards"], 60)})
	}
	return result
}
func tierList(value any, maxItems int) []map[string]any {
	values, _ := value.([]any)
	result := []map[string]any{}
	for _, item := range values {
		if len(result) >= maxItems {
			break
		}
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		title := boardString(object["title"], 240)
		if title == "" {
			continue
		}
		clean := map[string]any{"id": boardString(object["id"], 120), "kind": allowedString(object["kind"], []string{"work", "character", "custom"}, "custom"), "source": allowedString(object["source"], []string{"bangumi", "cngal", "vndb", "resume", "custom"}, "custom"), "sourceId": boardStringDefault(object["sourceId"], boardString(object["source_id"], 160), 160), "title": title, "subtitle": boardStringDefault(object["subtitle"], boardString(object["sub"], 240), 240), "image": boardImage(object["image"], 12<<20)}
		if id := clampInt(object["bangumiId"], 0, 0, 1<<31-1); id > 0 {
			clean["bangumiId"] = id
		}
		if boardString(clean["id"], 1) == "" {
			encoded, _ := marshalJSONNoEscape(clean)
			digest := sha256.Sum256(encoded)
			clean["id"] = "tier-" + hex.EncodeToString(digest[:])[:18]
		}
		result = append(result, clean)
	}
	return result
}

func sameOrigin(r *http.Request) bool {
	source := strings.TrimSpace(r.Header.Get("Origin"))
	if source == "" {
		source = strings.TrimSpace(r.Referer())
	}
	if source == "" || source == "null" {
		return false
	}
	parsed, err := url.Parse(source)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	scheme := "http"
	forwarded := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]))
	if r.TLS != nil || forwarded == "https" {
		scheme = "https"
	}
	requestHost := r.Host
	return strings.EqualFold(parsed.Scheme, scheme) && sameOriginHost(parsed, requestHost, scheme)
}

func sameOriginHost(source *url.URL, requestHost, scheme string) bool {
	requestURL, err := url.Parse(scheme + "://" + requestHost)
	if err != nil || source.Hostname() == "" || requestURL.Hostname() == "" || !strings.EqualFold(source.Hostname(), requestURL.Hostname()) {
		return false
	}
	sourcePort, requestPort := source.Port(), requestURL.Port()
	if sourcePort == "" {
		sourcePort = defaultPort(scheme)
	}
	if requestPort == "" {
		requestPort = defaultPort(scheme)
	}
	return sourcePort == requestPort
}

func defaultPort(scheme string) string {
	if strings.EqualFold(scheme, "https") {
		return "443"
	}
	return "80"
}
func boardString(value any, maxBytes int) string {
	if value == nil {
		return ""
	}
	var result string
	switch item := value.(type) {
	case string:
		result = item
	case float64:
		result = fmt.Sprint(item)
	case bool:
		if item {
			result = "1"
		}
	}
	result = strings.TrimSpace(result)
	for len(result) > maxBytes && !utf8.ValidString(result[:maxBytes]) {
		result = result[:len(result)-1]
	}
	if len(result) > maxBytes {
		result = result[:maxBytes]
	}
	return result
}
func boardStringDefault(value any, fallback string, maxBytes int) string {
	result := boardString(value, maxBytes)
	if result == "" {
		return fallback
	}
	return result
}
func boardImage(value any, maxBytes int) string {
	result := boardString(value, maxBytes)
	if result == "" || !safeBoardImage.MatchString(result) {
		return ""
	}
	return result
}
func boardList(value any, maxItems, maxBytes int) []string {
	values, _ := value.([]any)
	result := []string{}
	for _, item := range values {
		if len(result) >= maxItems {
			break
		}
		if object, ok := item.(map[string]any); ok {
			item = object["title"]
		}
		text := boardString(item, maxBytes)
		if text != "" {
			result = append(result, text)
		}
	}
	return result
}
func boardBool(value any) bool { result, _ := value.(bool); return result }
func boardBoolDefault(value map[string]any, key string, fallback bool) bool {
	if raw, ok := value[key]; ok {
		result, ok := raw.(bool)
		if ok {
			return result
		}
		return false
	}
	return fallback
}
func boardBoolMapDefault(value map[string]any, key string, fallback bool) bool {
	return boardBoolDefault(value, key, fallback)
}
func clampInt(value any, fallback, minValue, maxValue int) int {
	result := fallback
	switch item := value.(type) {
	case float64:
		result = int(item)
	case int:
		result = item
	case json.Number:
		if parsed, err := item.Int64(); err == nil {
			result = int(parsed)
		}
	}
	if result < minValue {
		return minValue
	}
	if result > maxValue {
		return maxValue
	}
	return result
}
func allowedString(value any, allowed []string, fallback string) string {
	result := boardString(value, 64)
	for _, item := range allowed {
		if result == item {
			return result
		}
	}
	return fallback
}
func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
func boardColor(value any, fallback string) string {
	valueString := strings.ToLower(boardString(value, 16))
	if len(valueString) == 7 && valueString[0] == '#' {
		for _, char := range valueString[1:] {
			if !strings.ContainsRune("0123456789abcdef", char) {
				return fallback
			}
		}
		return valueString
	}
	return fallback
}
func marshalJSONNoEscape(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}
func databaseValueString(value any) any {
	switch item := value.(type) {
	case time.Time:
		return item.Format("2006-01-02 15:04:05")
	case []byte:
		return string(item)
	default:
		return item
	}
}
func boardSizeMessage(kind string) string {
	if kind == "resume" {
		return "履历数据不能超过 10 MiB"
	}
	if kind == "meme" {
		return "MEME 看板数据不能超过 15 MiB"
	}
	return "Tier 表数据不能超过 15 MiB"
}
func loadFailureMessage(kind string) string {
	if kind == "resume" {
		return "暂时无法读取服务器履历"
	}
	if kind == "meme" {
		return "暂时无法读取服务器 MEME 看板"
	}
	return "暂时无法读取服务器 Tier 表"
}
func corruptFailureMessage(kind string) string {
	if kind == "resume" {
		return "服务器履历数据损坏，请重置后重新保存"
	}
	if kind == "meme" {
		return "服务器 MEME 数据损坏，请重置后重新保存"
	}
	return "服务器 Tier 数据损坏，请重置后重新保存"
}
func resetFailureMessage(kind string) string {
	if kind == "resume" {
		return "暂时无法重置服务器履历"
	}
	if kind == "meme" {
		return "暂时无法重置服务器 MEME 看板"
	}
	return "暂时无法重置服务器 Tier 表"
}
func saveFailureMessage(kind string) string {
	if kind == "resume" {
		return "暂时无法保存服务器履历"
	}
	if kind == "meme" {
		return "暂时无法保存服务器 MEME 看板"
	}
	return "暂时无法保存服务器 Tier 表"
}
