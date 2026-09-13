package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	publicAPIVersion = "1"
	publicAPIOrigin  = "https://map.vnfest.top"
)

var (
	publicAPIProvinceSeparator = regexp.MustCompile(`[+＋/／、,，;；|｜]`)
	publicAPIProvinceSuffix    = regexp.MustCompile(`(特别行政区|维吾尔自治区|回族自治区|壮族自治区|自治区|省|市)$`)
	publicAPIExternalURL       = regexp.MustCompile(`(?i)https?://[^\s，,）)\]】>]+`)
	publicAPILogoPath          = regexp.MustCompile(`^data/[A-Za-z0-9_./-]+(\?[^\s]+)?$`)
)

var publicAPIChinaRegions = map[string]string{
	"北京": "北京", "天津": "天津", "河北": "河北", "山西": "山西", "内蒙古": "内蒙古",
	"辽宁": "辽宁", "吉林": "吉林", "黑龙江": "黑龙江", "上海": "上海", "江苏": "江苏",
	"浙江": "浙江", "安徽": "安徽", "福建": "福建", "江西": "江西", "山东": "山东",
	"河南": "河南", "湖北": "湖北", "湖南": "湖南", "广东": "广东", "广西": "广西",
	"海南": "海南", "重庆": "重庆", "四川": "四川", "贵州": "贵州", "云南": "云南",
	"西藏": "西藏", "陕西": "陕西", "甘肃": "甘肃", "青海": "青海", "宁夏": "宁夏",
	"新疆": "新疆", "香港": "香港", "澳门": "澳门", "台湾": "台湾",
}

type publicAPIClub struct {
	ID            int      `json:"id"`
	Country       string   `json:"country"`
	Province      string   `json:"province"`
	Provinces     []string `json:"provinces"`
	City          string   `json:"city"`
	School        string   `json:"school"`
	Name          string   `json:"name"`
	DisplayName   string   `json:"display_name"`
	PublicSummary string   `json:"public_summary"`
	Type          string   `json:"type"`
	PublicStatus  string   `json:"public_status"`
	Verified      bool     `json:"verified"`
	LogoURL       string   `json:"logo_url"`
	ExternalLinks []string `json:"external_links"`
	CreatedAt     string   `json:"created_at"`
	UpdatedAt     string   `json:"updated_at"`
}

type publicAPIPayload struct {
	Rows        []publicAPIClub
	DataVersion string
	MTime       time.Time
}

func (s *Server) publicClubs(w http.ResponseWriter, r *http.Request) {
	if !s.publicAPIBootstrap(w, r) {
		return
	}
	if !s.publicAPIRequireChina(w, r) {
		return
	}
	payload, err := s.publicAPIPayload()
	if err != nil {
		s.publicAPIError(w, http.StatusInternalServerError, "internal_error", "公开数据源格式错误")
		return
	}
	s.publicAPISend(w, r, payload, payload.Rows)
}

func (s *Server) publicClub(w http.ResponseWriter, r *http.Request) {
	if !s.publicAPIBootstrap(w, r) {
		return
	}
	if !s.publicAPIRequireChina(w, r) {
		return
	}
	id, err := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("id")))
	if err != nil || id < 1 {
		s.publicAPIError(w, http.StatusBadRequest, "invalid_id", "同好会 ID 无效")
		return
	}
	payload, err := s.publicAPIPayload()
	if err != nil {
		s.publicAPIError(w, http.StatusInternalServerError, "internal_error", "公开数据源格式错误")
		return
	}
	for _, row := range payload.Rows {
		if row.ID == id {
			s.publicAPISend(w, r, payload, row)
			return
		}
	}
	s.publicAPIError(w, http.StatusNotFound, "not_found", "未找到该公开同好会")
}

func (s *Server) publicManifest(w http.ResponseWriter, r *http.Request) {
	if !s.publicAPIBootstrap(w, r) {
		return
	}
	payload, err := s.publicAPIPayload()
	if err != nil {
		s.publicAPIError(w, http.StatusInternalServerError, "internal_error", "公开数据源格式错误")
		return
	}
	data := struct {
		Site struct {
			Title        string `json:"title"`
			Description  string `json:"description"`
			CanonicalURL string `json:"canonical_url"`
		} `json:"site"`
		Scope struct {
			Country        string   `json:"country"`
			Region         string   `json:"region"`
			ExcludedRegion []string `json:"excluded_regions"`
		} `json:"scope"`
		Features        []string `json:"features"`
		MapSourceStatus string   `json:"map_source_status"`
		Endpoints       struct {
			Clubs string `json:"clubs"`
			Club  string `json:"club"`
		} `json:"endpoints"`
	}{}
	data.Site.Title = "视觉小说学园祭"
	data.Site.Description = "VNFest（视觉小说学园祭）是一个视觉小说展示项目，主要整理和展示各地区高校视觉小说兴趣组织的公开信息，并提供地区索引、资料查询及相关文化内容浏览功能。"
	data.Site.CanonicalURL = "https://vnfest.top"
	data.Scope.Country = "china"
	data.Scope.Region = "中国区（含台湾、香港、澳门）"
	data.Scope.ExcludedRegion = []string{"日本", "海外"}
	data.Features = []string{"map", "clubs", "search", "filters"}
	data.MapSourceStatus = os.Getenv("VNFEST_CN_MAP_SOURCE_STATUS")
	if data.MapSourceStatus == "" {
		data.MapSourceStatus = "pending"
	}
	data.Endpoints.Clubs = "/api/public/v1/clubs.php?country=china"
	data.Endpoints.Club = "/api/public/v1/club.php?country=china&id={id}"
	s.publicAPISend(w, r, payload, data)
}

func (s *Server) publicAPIBootstrap(w http.ResponseWriter, r *http.Request) bool {
	s.publicAPIHeaders(w, r)
	if r.Method == http.MethodOptions {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin != "" && publicAPIAllowedOrigin(origin) == "" {
			s.publicAPIError(w, http.StatusForbidden, "cors_origin_denied", "来源不在允许列表中")
			return false
		}
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET, OPTIONS")
		s.publicAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "公共接口只允许 GET 和 OPTIONS")
		return false
	}
	return true
}

func (s *Server) publicAPIRequireChina(w http.ResponseWriter, r *http.Request) bool {
	if strings.ToLower(strings.TrimSpace(r.URL.Query().Get("country"))) != "china" {
		s.publicAPIError(w, http.StatusBadRequest, "country_not_allowed", "该公共接口只提供中国区公开资料")
		return false
	}
	return true
}

func (s *Server) publicAPIHeaders(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Vary", "Origin, Accept-Encoding")
	if origin := publicAPIAllowedOrigin(strings.TrimSpace(r.Header.Get("Origin"))); origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type, If-None-Match, If-Modified-Since")
		w.Header().Set("Access-Control-Max-Age", "600")
	}
}

func publicAPIAllowedOrigin(origin string) string {
	switch origin {
	case "https://vnfest.top", "https://www.vnfest.top":
		return origin
	default:
		return ""
	}
}

func (s *Server) publicAPIError(w http.ResponseWriter, status int, code, message string) {
	body, _ := publicAPIJSON(struct {
		Success    bool   `json:"success"`
		APIVersion string `json:"api_version"`
		Error      string `json:"error"`
		Message    string `json:"message"`
	}{false, publicAPIVersion, code, message})
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func (s *Server) publicAPISend(w http.ResponseWriter, r *http.Request, payload publicAPIPayload, data any) {
	generatedAt := payload.MTime.UTC().Format("2006-01-02T15:04:05+00:00")
	body, err := publicAPIJSON(struct {
		Success     bool   `json:"success"`
		APIVersion  string `json:"api_version"`
		DataVersion string `json:"data_version"`
		GeneratedAt string `json:"generated_at"`
		Data        any    `json:"data"`
	}{true, publicAPIVersion, payload.DataVersion, generatedAt, data})
	if err != nil {
		s.publicAPIError(w, http.StatusInternalServerError, "internal_error", "响应编码失败")
		return
	}
	digest := sha256.Sum256(body)
	etag := `"` + hex.EncodeToString(digest[:]) + `"`
	w.Header().Set("ETag", etag)
	w.Header().Set("Last-Modified", payload.MTime.UTC().Format(http.TimeFormat))
	w.Header().Set("Cache-Control", "public, max-age=60, stale-while-revalidate=300")
	if strings.TrimSpace(r.Header.Get("If-None-Match")) == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	if since, err := http.ParseTime(r.Header.Get("If-Modified-Since")); err == nil && !payload.MTime.IsZero() && since.Unix() >= payload.MTime.Unix() {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (s *Server) publicAPIPayload() (publicAPIPayload, error) {
	file := filepath.Join(s.cfg.DataDir, "clubs.json")
	stat, err := os.Stat(file)
	if err != nil {
		if os.IsNotExist(err) {
			rows := []publicAPIClub{}
			canonical, _ := publicAPIJSON(rows)
			digest := sha256.Sum256(canonical)
			return publicAPIPayload{Rows: rows, DataVersion: hex.EncodeToString(digest[:]), MTime: time.Now()}, nil
		}
		return publicAPIPayload{}, err
	}
	contents, err := os.ReadFile(file)
	if err != nil {
		return publicAPIPayload{}, err
	}
	var decoded struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(contents, &decoded); err != nil {
		return publicAPIPayload{}, err
	}
	rows := make([]publicAPIClub, 0, len(decoded.Data))
	for _, raw := range decoded.Data {
		if row, ok := publicAPIRow(raw); ok && row.ID > 0 {
			rows = append(rows, row)
		}
	}
	canonical, err := publicAPIJSON(rows)
	if err != nil {
		return publicAPIPayload{}, err
	}
	digest := sha256.Sum256(canonical)
	return publicAPIPayload{Rows: rows, DataVersion: hex.EncodeToString(digest[:]), MTime: stat.ModTime()}, nil
}

func publicAPIRow(row map[string]any) (publicAPIClub, bool) {
	if strings.ToLower(publicAPIString(row["country"], "china")) != "china" || !publicAPIIsPublished(row) {
		return publicAPIClub{}, false
	}
	provinces := publicAPIProvinceParts(row)
	if len(provinces) == 0 {
		return publicAPIClub{}, false
	}
	status := strings.ToLower(strings.TrimSpace(publicAPIString(row["status"], "published")))
	if status == "" {
		status = "published"
	}
	if !publicAPIStatusAllowed(status) {
		status = "published"
	}
	summary := row["public_summary"]
	if summary == nil {
		summary = row["remark"]
	}
	if summary == nil {
		summary = row["description"]
	}
	name := publicAPIString(row["name"], "")
	displayName := publicAPIString(row["display_name"], name)
	if name == "" {
		name = displayName
	}
	return publicAPIClub{
		ID:            publicAPIInt(row["id"]),
		Country:       "china",
		Province:      provinces[0],
		Provinces:     provinces,
		City:          publicAPITruncate(row["city"], 120),
		School:        publicAPITruncate(row["school"], 240),
		Name:          publicAPITruncate(name, 240),
		DisplayName:   publicAPITruncate(displayName, 240),
		PublicSummary: publicAPITruncate(summary, 5000),
		Type:          publicAPITruncate(publicAPIString(row["type"], "school"), 60),
		PublicStatus:  status,
		Verified:      publicAPITruthy(row["verified"]),
		LogoURL:       publicAPILogoURL(row["logo_url"]),
		ExternalLinks: publicAPIExternalLinks(row["external_links"]),
		CreatedAt:     publicAPITruncate(row["created_at"], 40),
		UpdatedAt:     publicAPITruncate(row["updated_at"], 40),
	}, true
}

func publicAPIStatusAllowed(status string) bool {
	switch status {
	case "", "public", "published", "approved", "active", "visible":
		return true
	default:
		return false
	}
}

func publicAPIIsPublished(row map[string]any) bool {
	status, exists := row["status"]
	if !exists {
		return true
	}
	return publicAPIStatusAllowed(strings.ToLower(strings.TrimSpace(publicAPIString(status, ""))))
}

func publicAPIProvinceParts(row map[string]any) []string {
	values := []any{}
	if raw, ok := row["provinces"]; ok {
		if list, ok := raw.([]any); ok {
			values = list
		}
	} else if raw, ok := row["province"]; ok {
		values = make([]any, 0)
		for _, part := range publicAPIProvinceSeparator.Split(publicAPIString(raw, ""), -1) {
			values = append(values, part)
		}
	}
	result := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		name := publicAPINormalizeProvince(publicAPIString(value, ""))
		if name != "" && !seen[name] {
			seen[name] = true
			result = append(result, name)
		}
	}
	return result
}

func publicAPINormalizeProvince(value string) string {
	value = strings.TrimSpace(value)
	value = publicAPIProvinceSuffix.ReplaceAllString(value, "")
	return publicAPIChinaRegions[value]
}

func publicAPITruncate(value any, limit int) string {
	text := strings.TrimSpace(publicAPIString(value, ""))
	runes := []rune(text)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return text
}

func publicAPIExternalLinks(value any) []string {
	parts := []string{}
	if list, ok := value.([]any); ok {
		for _, item := range list {
			if object, ok := item.(map[string]any); ok {
				item = object["url"]
				if item == nil {
					item = object["href"]
				}
			}
			parts = append(parts, publicAPIString(item, ""))
		}
	} else {
		parts = append(parts, publicAPIString(value, ""))
	}
	links := []string{}
	seen := map[string]bool{}
	for _, match := range publicAPIExternalURL.FindAllString(strings.Join(parts, "\n"), -1) {
		link := strings.TrimRight(strings.TrimSpace(match), ".。;；")
		parsed, err := url.Parse(link)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || seen[link] {
			continue
		}
		seen[link] = true
		links = append(links, link)
		if len(links) == 10 {
			break
		}
	}
	return links
}

func publicAPILogoURL(value any) string {
	text := strings.TrimSpace(publicAPIString(value, ""))
	if text == "" {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(text), "http://") || strings.HasPrefix(strings.ToLower(text), "https://") {
		parsed, err := url.Parse(text)
		if err == nil && parsed.Host != "" {
			return text
		}
		return ""
	}
	if !publicAPILogoPath.MatchString(text) {
		return ""
	}
	return publicAPIOrigin + "/" + strings.TrimLeft(text, "/")
}

func publicAPIString(value any, fallback string) string {
	if value == nil {
		return fallback
	}
	switch item := value.(type) {
	case string:
		return item
	case json.Number:
		return item.String()
	case float64:
		return strconv.FormatFloat(item, 'f', -1, 64)
	case bool:
		if item {
			return "1"
		}
		return ""
	default:
		return fmt.Sprint(item)
	}
}

func publicAPIInt(value any) int {
	if value == nil {
		return 0
	}
	switch item := value.(type) {
	case float64:
		return int(item)
	case json.Number:
		parsed, _ := strconv.Atoi(item.String())
		return parsed
	case string:
		parsed, _ := strconv.Atoi(strings.TrimSpace(item))
		return parsed
	default:
		parsed, _ := strconv.Atoi(publicAPIString(item, ""))
		return parsed
	}
}

func publicAPITruthy(value any) bool {
	switch item := value.(type) {
	case nil:
		return false
	case bool:
		return item
	case string:
		return item != "" && item != "0"
	case float64:
		return item != 0
	case json.Number:
		return item.String() != "" && item.String() != "0"
	default:
		return true
	}
}

func publicAPIJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'}), nil
}
