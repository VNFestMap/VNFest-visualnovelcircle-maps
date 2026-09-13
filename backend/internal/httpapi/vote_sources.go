package httpapi

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

func (s *Server) voteSources(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	if action := strings.TrimSpace(r.URL.Query().Get("action")); action != "" && action != "search" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知 action=" + action})
		return
	}
	keyword := strings.TrimSpace(firstNonEmpty(r.URL.Query().Get("keyword"), r.URL.Query().Get("q")))
	if keyword == "" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请输入搜索关键词"})
		return
	}
	limit := boundedQueryInt(r, "limit", 12, 1, 30)
	projectType := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("project_type")))
	if projectType != "moe" {
		projectType = "twelve"
	}
	results := []map[string]any{}
	if projectType == "moe" {
		results = append(results, s.voteSourceBangumiCharacters(r, keyword, limit)...)
	} else {
		results = append(results, s.voteSourceBangumiSubjects(r, keyword, limit)...)
		results = append(results, s.voteSourceVNDB(r, keyword, maxIntInt(1, limit/2), "vn")...)
	}
	results = append(results, map[string]any{"source_type": "manual", "source_id": "", "title": keyword, "title_cn": keyword, "subtitle": map[string]string{"moe": "手动角色提名", "twelve": "手动作品提名"}[projectType], "image_url": "", "summary": "", "external_url": ""})
	writeJSON(w, map[string]any{"success": true, "data": results, "source_order": []string{"bangumi", "vndb", "manual"}})
}

func (s *Server) voteSourceBangumiSubjects(r *http.Request, keyword string, limit int) []map[string]any {
	endpoint := s.bangumiAPIURL() + "/search/subject/" + url.PathEscape(keyword) + "?type=4&responseGroup=large"
	status, raw, err := s.bangumiRequest(r, http.MethodGet, endpoint, "", nil)
	if err != nil || status < 200 || status >= 300 {
		return nil
	}
	var data map[string]any
	if decodeJSONBytes(raw, &data) != nil {
		return nil
	}
	result := []map[string]any{}
	for _, value := range anySlice(data["list"]) {
		row, ok := value.(map[string]any)
		if !ok || len(result) >= limit {
			continue
		}
		id := stringValue(row["id"])
		images, _ := row["images"].(map[string]any)
		result = append(result, map[string]any{"source_type": "bangumi_subject", "source_id": id, "title": stringValue(row["name"]), "title_cn": stringValue(row["name_cn"]), "subtitle": stringValue(row["air_date"]), "image_url": bangumiImageProxy(map[string]any{"images": images}), "summary": truncateString(stringValue(row["summary"]), 240), "external_url": nonEmptyURL("https://bgm.tv/subject/", id)})
	}
	return result
}

func (s *Server) voteSourceBangumiCharacters(r *http.Request, keyword string, limit int) []map[string]any {
	payload := map[string]any{"keyword": keyword}
	status, raw, err := s.bangumiRequest(r, http.MethodPost, s.bangumiAPIURL()+"/v0/search/characters?limit="+strconv.Itoa(maxIntInt(limit*3, 30)), "", payload)
	if err != nil || status < 200 || status >= 300 {
		return nil
	}
	var data map[string]any
	if decodeJSONBytes(raw, &data) != nil {
		return nil
	}
	result := []map[string]any{}
	for _, value := range anySlice(data["data"]) {
		row, ok := value.(map[string]any)
		if !ok || len(result) >= limit {
			continue
		}
		id := stringValue(row["id"])
		if id == "" {
			continue
		}
		result = append(result, map[string]any{"source_type": "bangumi_character", "source_id": id, "title": stringValue(row["name"]), "title_cn": stringValue(row["name_cn"]), "subtitle": stringValue(row["relation"]), "image_url": bangumiImageProxy(row), "summary": truncateString(stringValue(row["summary"]), 240), "external_url": nonEmptyURL("https://bgm.tv/character/", id)})
	}
	return result
}

func (s *Server) voteSourceVNDB(r *http.Request, keyword string, limit int, kind string) []map[string]any {
	endpoint, fields := "vn", "title, titles{lang,title,main}, image{url}, released, developers{name}, description"
	if kind == "character" {
		endpoint, fields = "character", "name, original, aliases, description, image{url}, vns{title}"
	}
	response := s.vndbRequest(r.Context(), endpoint, map[string]any{"filters": []any{"search", "=", keyword}, "fields": fields, "sort": "searchrank", "results": limit})
	if response.Err != nil || response.Status < 200 || response.Status >= 300 || response.Data == nil {
		return nil
	}
	result := []map[string]any{}
	for _, value := range anySlice(response.Data["results"]) {
		row, ok := value.(map[string]any)
		if !ok {
			continue
		}
		id := stringValue(row["id"])
		image := ""
		if imageData, ok := row["image"].(map[string]any); ok {
			image = stringValue(imageData["url"])
		}
		if kind == "vn" {
			result = append(result, map[string]any{"source_type": "vndb_vn", "source_id": id, "title": stringValue(row["title"]), "title_cn": vndbChineseTitle(row), "subtitle": vndbDeveloperNames(row), "image_url": trustedImageProxy(image), "summary": truncateString(stringValue(row["description"]), 240), "external_url": nonEmptyURL("https://vndb.org/", id)})
		} else {
			result = append(result, map[string]any{"source_type": "vndb_character", "source_id": id, "title": stringValue(row["name"]), "title_cn": stringValue(row["original"]), "subtitle": vndbVNNames(row), "image_url": trustedImageProxy(image), "summary": truncateString(stringValue(row["description"]), 240), "external_url": nonEmptyURL("https://vndb.org/", id)})
		}
	}
	return result
}

func decodeJSONBytes(raw []byte, target any) error {
	return json.Unmarshal(raw, target)
}

func maxIntInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func nonEmptyURL(prefix, id string) string {
	if id == "" {
		return ""
	}
	return prefix + id
}

func trustedImageProxy(raw string) string {
	parsed, err := url.Parse(raw)
	if err == nil && parsed.Scheme == "https" && strings.EqualFold(parsed.Hostname(), "t.vndb.org") {
		return "/api/image_proxy.php?url=" + url.QueryEscape(raw)
	}
	return ""
}

func vndbChineseTitle(row map[string]any) string {
	for _, value := range anySlice(row["titles"]) {
		if title, ok := value.(map[string]any); ok {
			lang := stringValue(title["lang"])
			if lang == "zh-Hans" || lang == "zh-Hant" || lang == "zh" {
				return stringValue(title["title"])
			}
		}
	}
	return ""
}

func vndbDeveloperNames(row map[string]any) string {
	values := []string{}
	for _, value := range anySlice(row["developers"]) {
		if item, ok := value.(map[string]any); ok && stringValue(item["name"]) != "" && len(values) < 2 {
			values = append(values, stringValue(item["name"]))
		}
	}
	return strings.Join(values, " / ")
}

func vndbVNNames(row map[string]any) string {
	values := []string{}
	for _, value := range anySlice(row["vns"]) {
		if item, ok := value.(map[string]any); ok && stringValue(item["title"]) != "" && len(values) < 3 {
			values = append(values, stringValue(item["title"]))
		}
	}
	return strings.Join(values, " / ")
}
