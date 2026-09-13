package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var wikiFileMu sync.Mutex
var wikiClubKeyRE = regexp.MustCompile(`^(china|japan)-([0-9]+)$`)
var wikiStoredImageRE = regexp.MustCompile(`^[A-Za-z0-9/_\-.]+$`)

func (s *Server) wiki(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	if strings.HasPrefix(action, "guide_") {
		s.wikiGuide(w, r, action)
		return
	}
	clubKey := strings.TrimSpace(r.URL.Query().Get("club_key"))
	if clubKey == "" && (r.Method == http.MethodPost || r.Method == http.MethodPut) {
		var input map[string]any
		if err := decodeJSON(r, &input, 4<<20); err == nil {
			clubKey = strings.TrimSpace(stringValue(input["club_key"]))
			encoded, _ := json.Marshal(input)
			r.Body = io.NopCloser(bytes.NewReader(encoded))
		}
	}
	match := wikiClubKeyRE.FindStringSubmatch(clubKey)
	if len(match) != 3 {
		writeJSON(w, map[string]any{"success": false, "message": "无效的 wiki 标识"})
		return
	}
	clubID := parsePositiveInt(match[2])
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	user, err := s.findUser(r.Context(), userID)
	if err != nil || user == nil || !s.projectHubCanManageClub(r.Context(), user, map[string]any{"id": clubID, "country": match[1]}) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权编辑该同好会维基"})
		return
	}
	switch action {
	case "get":
		if r.Method != http.MethodGet {
			writeJSONStatus(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "message": "不支持的操作"})
			return
		}
		club := s.wikiClub(r.Context(), match[1], clubID)
		contentPath := filepath.Join(s.cfg.Root, "wiki", "content", clubKey+".json")
		content, exists := readWikiMap(contentPath)
		if !exists {
			content = wikiDefaultContent(clubKey, club)
		}
		writeJSON(w, map[string]any{"success": true, "exists": exists, "club": club, "content": content, "page_url": "./wiki/pages/" + clubKey + ".html", "ja_page_url": "./wiki/pages/" + clubKey + "-ja.html"})
	case "upload":
		s.wikiUpload(w, r, clubKey)
	case "save":
		if r.Method != http.MethodPost || !sameOrigin(r) {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
			return
		}
		var input map[string]any
		if err := decodeJSON(r, &input, 4<<20); err != nil || input == nil {
			writeJSON(w, map[string]any{"success": false, "message": "无效数据"})
			return
		}
		content := normalizeWikiContent(input, clubKey, s.wikiClub(r.Context(), match[1], clubID))
		if content == nil {
			writeJSON(w, map[string]any{"success": false, "message": "标题和摘要不能为空"})
			return
		}
		if len(mapSlice(content["sections"])) == 0 {
			writeJSON(w, map[string]any{"success": false, "message": "至少需要一个章节，且章节需要包含正文或内容块"})
			return
		}
		if err := s.writeWikiContent(clubKey, content); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "保存内容失败，请联系管理员检查 wiki/content 权限"})
			return
		}
		if err := s.writeWikiPageAndIndex(clubKey, content, s.wikiClub(r.Context(), match[1], clubID)); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "保存内容失败，请稍后重试"})
			return
		}
		writeJSON(w, map[string]any{"success": true, "message": "维基内容已保存", "content": content, "page_url": "./wiki/pages/" + clubKey + ".html", "ja_page_url": "./wiki/pages/" + clubKey + "-ja.html"})
	default:
		writeJSON(w, map[string]any{"success": false, "message": "不支持的操作"})
	}
}

func (s *Server) wikiClub(ctx context.Context, country string, id int64) map[string]any {
	name := map[string]string{"china": "clubs.json", "japan": "clubs_japan.json"}[country]
	data := s.projectHubReadMap(ctx, name, map[string]any{"data": []any{}})
	for _, row := range mapSlice(data["data"]) {
		if integerValue(row["id"]) == id {
			row["country"] = country
			return row
		}
	}
	return map[string]any{"id": id, "country": country}
}

func (s *Server) wikiUpload(w http.ResponseWriter, r *http.Request, clubKey string) {
	if r.Method != http.MethodPost || !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	if s.files == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "图片保存失败"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20+256<<10)
	if err := r.ParseMultipartForm(10<<20 + 256<<10); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "上传失败，请重新选择图片"})
		return
	}
	imageFile, err := parseMultipartFile(r, "image", 10<<20)
	if err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 JPEG、PNG、GIF、WebP 格式"})
		return
	}
	name := time.Now().Format("20060102150405") + "_" + randomHex(4) + "." + imageFile.Ext
	relative := filepath.ToSlash(filepath.Join(clubKey, name))
	localURL := "../uploads/" + relative
	stored, err := s.storePublicUploadImage(r.Context(), relative, localURL, name, imageMime(imageFile.Ext), "wiki:"+clubKey, imageFile.Bytes)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "图片保存失败"})
		return
	}
	response := map[string]any{"success": true, "message": "图片上传成功", "image_url": stored.URL}
	for key, value := range storedImageFields(stored) {
		response[key] = value
	}
	writeJSON(w, response)
}

func (s *Server) writeWikiContent(clubKey string, content map[string]any) error {
	encoded, err := json.MarshalIndent(content, "", "    ")
	if err != nil {
		return err
	}
	return writeWikiAtomic(filepath.Join(s.cfg.Root, "wiki", "content", clubKey+".json"), encoded)
}

func (s *Server) writeWikiPageAndIndex(clubKey string, content, club map[string]any) error {
	zh, err := renderWikiPage(content, club, "zh")
	if err != nil {
		return err
	}
	if err := writeWikiAtomic(filepath.Join(s.cfg.Root, "wiki", "pages", clubKey+".html"), []byte(zh)); err != nil {
		return err
	}
	if ja, ok := content["i18n"].(map[string]any); ok {
		if localized, ok := ja["ja"].(map[string]any); ok && stringValue(localized["title"]) != "" {
			merged := map[string]any{}
			for key, value := range content {
				merged[key] = value
			}
			merged["title"], merged["summary"], merged["sections"] = localized["title"], localized["summary"], localized["sections"]
			jaHTML, renderErr := renderWikiPage(merged, club, "ja")
			if renderErr != nil {
				return renderErr
			}
			if err := writeWikiAtomic(filepath.Join(s.cfg.Root, "wiki", "pages", clubKey+"-ja.html"), []byte(jaHTML)); err != nil {
				return err
			}
		}
	}
	indexPath := filepath.Join(s.cfg.Root, "wiki", "index.json")
	manifest, exists := readWikiMap(indexPath)
	if !exists {
		manifest = map[string]any{}
	}
	manifest[clubKey] = map[string]any{"title": stringValue(content["title"]), "url": "./pages/" + clubKey + ".html", "country": stringValue(club["country"]), "country_label": map[string]string{"china": "中国", "japan": "日本"}[stringValue(club["country"])], "school": firstNonEmpty(stringValue(club["school"]), stringValue(club["name"])), "club_name": stringValue(club["display_name"]), "region": firstNonEmpty(stringValue(club["province"]), stringValue(club["prefecture"])), "summary": stringValue(content["summary"]), "updated_at": stringValue(content["updated_at"]), "i18n": map[string]any{}}
	encoded, err := json.MarshalIndent(manifest, "", "    ")
	if err != nil {
		return err
	}
	return writeWikiAtomic(indexPath, encoded)
}

func normalizeWikiContent(input map[string]any, clubKey string, club map[string]any) map[string]any {
	defaultContent := wikiDefaultContent(clubKey, club)
	title := firstNonEmpty(cleanProjectText(input["title"], 300), stringValue(defaultContent["title"]))
	summary := firstNonEmpty(cleanProjectText(input["summary"], 3000), stringValue(defaultContent["summary"]))
	if title == "" || summary == "" {
		return nil
	}
	infobox := map[string]any{}
	if raw, ok := input["infobox"].(map[string]any); ok {
		for key, value := range raw {
			key = cleanProjectText(key, 120)
			if key != "" && cleanProjectText(value, 1000) != "" {
				infobox[key] = cleanProjectText(value, 1000)
			}
		}
	}
	if len(infobox) == 0 {
		infobox = defaultContent["infobox"].(map[string]any)
	}
	sections := []map[string]any{}
	for _, raw := range anySlice(input["sections"]) {
		section, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		heading := cleanProjectText(section["heading"], 200)
		blocks := []map[string]any{}
		for _, rawBlock := range anySlice(section["blocks"]) {
			block, ok := rawBlock.(map[string]any)
			if !ok {
				continue
			}
			typ := stringValue(block["type"])
			if typ == "paragraph" && cleanProjectText(block["text"], 12000) != "" {
				blocks = append(blocks, map[string]any{"type": "paragraph", "text": cleanProjectText(block["text"], 12000), "note": cleanProjectText(block["note"], 1000)})
			} else if typ == "image" {
				imageURL := safeWikiHref(stringValue(block["url"]))
				if imageURL != "#" {
					blocks = append(blocks, map[string]any{"type": "image", "url": imageURL, "caption": cleanProjectText(block["caption"], 500), "alt": cleanProjectText(block["alt"], 500), "width_percent": boundedQueryIntValue(block["width_percent"], 25, 100, 100), "aspect_ratio": firstNonEmpty(stringValue(block["aspect_ratio"]), "16/10"), "align": firstNonEmpty(stringValue(block["align"]), "center"), "fit": firstNonEmpty(stringValue(block["fit"]), "cover")})
				}
			}
		}
		if len(blocks) == 0 {
			for _, paragraph := range anySlice(section["body"]) {
				if text := cleanProjectText(paragraph, 12000); text != "" {
					blocks = append(blocks, map[string]any{"type": "paragraph", "text": text, "note": ""})
				}
			}
		}
		if heading != "" && len(blocks) > 0 {
			level := int64(2)
			if integerValue(section["level"]) == 3 {
				level = 3
			}
			sections = append(sections, map[string]any{"heading": heading, "level": level, "blocks": blocks, "body": wikiBlockBodies(blocks)})
		}
	}
	images := normalizeWikiImages(input["images"])
	refs := []map[string]any{}
	for _, raw := range anySlice(input["references"]) {
		ref, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		label, link := cleanProjectText(ref["label"], 300), safeWikiHref(stringValue(ref["url"]))
		if label != "" || link != "#" {
			refs = append(refs, map[string]any{"label": firstNonEmpty(label, link), "url": link})
		}
	}
	result := map[string]any{"club_key": clubKey, "title": title, "summary": summary, "infobox": infobox, "sections": sections, "images": images, "avatar": map[string]any{}, "references": refs, "i18n": map[string]any{}, "updated_at": time.Now().Format("2006-01-02")}
	if avatar, ok := input["avatar"].(map[string]any); ok {
		if link := safeWikiHref(stringValue(avatar["url"])); link != "#" {
			result["avatar"] = map[string]any{"url": link, "caption": cleanProjectText(avatar["caption"], 500), "alt": cleanProjectText(avatar["alt"], 500), "position": map[bool]string{true: "bottom", false: "top"}[stringValue(avatar["position"]) == "bottom"]}
		}
	}
	if localized, ok := input["i18n"].(map[string]any); ok {
		if ja, ok := localized["ja"].(map[string]any); ok {
			result["i18n"] = map[string]any{"ja": map[string]any{"title": cleanProjectText(ja["title"], 300), "summary": cleanProjectText(ja["summary"], 3000), "sections": ja["sections"]}}
		}
	}
	return result
}

func wikiDefaultContent(clubKey string, club map[string]any) map[string]any {
	title := firstNonEmpty(stringValue(club["display_name"]), firstNonEmpty(stringValue(club["name"]), clubKey))
	return map[string]any{"club_key": clubKey, "title": title, "summary": title + " 是登记在 Galgame 同好会地图中的高校同好会之一。", "infobox": map[string]any{"学校": stringValue(club["school"]), "地区": firstNonEmpty(stringValue(club["province"]), stringValue(club["prefecture"])), "类型": "高校同好会", "状态": "未认证"}, "sections": []any{map[string]any{"heading": "概要", "level": 2, "body": []any{"本页面用于整理该同好会的公开资料、发展历史、活动记录和对外链接。"}}}, "images": []any{}, "references": []any{}, "updated_at": time.Now().Format("2006-01-02")}
}

func normalizeWikiImages(value any) []map[string]any {
	result := []map[string]any{}
	for _, raw := range anySlice(value) {
		row, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if link := safeWikiHref(stringValue(row["url"])); link != "#" {
			result = append(result, map[string]any{"url": link, "caption": cleanProjectText(row["caption"], 500), "alt": cleanProjectText(row["alt"], 500), "width_percent": boundedQueryIntValue(row["width_percent"], 25, 100, 100), "aspect_ratio": firstNonEmpty(stringValue(row["aspect_ratio"]), "16/10"), "align": firstNonEmpty(stringValue(row["align"]), "center"), "fit": firstNonEmpty(stringValue(row["fit"]), "cover")})
		}
	}
	return result
}

func wikiBlockBodies(blocks []map[string]any) []string {
	result := []string{}
	for _, block := range blocks {
		if stringValue(block["type"]) == "paragraph" {
			result = append(result, stringValue(block["text"]))
		}
	}
	return result
}

func safeWikiHref(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || strings.ContainsAny(value, "\x00\r\n") || strings.HasPrefix(value, "//") {
		return "#"
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "javascript" || parsed.Scheme == "vbscript" || parsed.Scheme == "data" {
		return "#"
	}
	return value
}

func renderWikiPage(content, club map[string]any, lang string) (string, error) {
	localized := content
	if lang == "ja" {
		if all, ok := content["i18n"].(map[string]any); ok {
			if ja, ok := all["ja"].(map[string]any); ok {
				localized = map[string]any{}
				for key, value := range content {
					localized[key] = value
				}
				for _, key := range []string{"title", "summary", "sections"} {
					if value, exists := ja[key]; exists {
						localized[key] = value
					}
				}
			}
		}
	}
	title := html.EscapeString(stringValue(localized["title"]))
	var body strings.Builder
	body.WriteString("<!doctype html><html lang=\"")
	if lang == "ja" {
		body.WriteString("ja")
	} else {
		body.WriteString("zh-CN")
	}
	body.WriteString("\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>")
	body.WriteString(title)
	body.WriteString(" - 同好会维基</title><link rel=\"stylesheet\" href=\"../wiki.css\"></head><body><header class=\"wiki-header\"><a href=\"../../index.html\">Galgame 同好会地图</a><a href=\"../index.html\">VNFest WIKI</a></header><main class=\"wiki-page wiki-reading-page\"><article class=\"wiki-article\"><header><h1>")
	body.WriteString(title)
	body.WriteString("</h1></header><p class=\"wiki-summary\">")
	body.WriteString(wikiFormatText(stringValue(localized["summary"])))
	body.WriteString("</p>")
	for _, raw := range anySlice(localized["sections"]) {
		section, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		level := 2
		if integerValue(section["level"]) == 3 {
			level = 3
		}
		body.WriteString(fmt.Sprintf("<section class=\"wiki-section\"><h%d>%s</h%d>", level, html.EscapeString(stringValue(section["heading"])), level))
		for _, rawBlock := range anySlice(section["blocks"]) {
			block, ok := rawBlock.(map[string]any)
			if !ok {
				continue
			}
			switch stringValue(block["type"]) {
			case "paragraph":
				body.WriteString("<p>" + wikiFormatText(stringValue(block["text"])) + "</p>")
			case "image":
				imageURL := html.EscapeString(safeWikiHref(stringValue(block["url"])))
				body.WriteString("<figure><img loading=\"lazy\" src=\"" + imageURL + "\" alt=\"" + html.EscapeString(stringValue(block["alt"])) + "\"><figcaption>" + wikiFormatText(stringValue(block["caption"])) + "</figcaption></figure>")
			}
		}
		body.WriteString("</section>")
	}
	body.WriteString("<footer>最后更新：" + html.EscapeString(stringValue(content["updated_at"])) + "</footer></article></main></body></html>")
	return body.String(), nil
}

func wikiFormatText(value string) string {
	value = html.EscapeString(strings.ReplaceAll(value, "\r\n", "\n"))
	value = strings.ReplaceAll(value, "\n", "<br>")
	return value
}

func readWikiMap(path string) (map[string]any, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var value map[string]any
	if json.Unmarshal(data, &value) != nil || value == nil {
		return nil, false
	}
	return value, true
}

func writeWikiAtomic(path string, data []byte) error {
	wikiFileMu.Lock()
	defer wikiFileMu.Unlock()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp-" + randomHex(8)
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err == nil {
		return nil
	}
	backup := path + ".vnfest-replace-" + randomHex(8)
	if _, err := os.Stat(path); err == nil {
		if err := os.Rename(path, backup); err != nil {
			_ = os.Remove(tmp)
			return err
		}
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Rename(backup, path)
		_ = os.Remove(tmp)
		return err
	}
	_ = os.Remove(backup)
	return nil
}

func boundedQueryIntValue(value any, min, max, fallback int) int64 {
	n := integerValue(value)
	if n < int64(min) {
		return int64(fallback)
	}
	if n > int64(max) {
		return int64(max)
	}
	return n
}

func (s *Server) wikiGuide(w http.ResponseWriter, r *http.Request, action string) {
	lang := "zh-CN"
	if r.URL.Query().Get("lang") == "ja-JP" {
		lang = "ja-JP"
	}
	path := filepath.Join(s.cfg.DataDir, "wiki-guide", lang, "documents.json")
	catalog, exists := readWikiMap(path)
	if !exists {
		catalog = map[string]any{"version": 1, "language": lang, "groups": []any{}, "articles": []any{}}
	}
	if action == "guide_catalog" && r.Method == http.MethodGet {
		writeJSON(w, map[string]any{"success": true, "catalog": catalog})
		return
	}
	if action == "guide_article" && r.Method == http.MethodGet {
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		for _, article := range anySlice(catalog["articles"]) {
			if row, ok := article.(map[string]any); ok && stringValue(row["id"]) == id {
				writeJSON(w, map[string]any{"success": true, "article": row})
				return
			}
		}
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "文档不存在"})
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	user, _ := s.findUser(r.Context(), userID)
	if user == nil || user.Role != "super_admin" {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "仅超级管理员可维护使用文档"})
		return
	}
	if action == "guide_admin_catalog" && r.Method == http.MethodGet {
		writeJSON(w, map[string]any{"success": true, "runtime": catalog, "seedRevision": wikiGuideRevision(catalog)})
		return
	}
	if action == "guide_diff" && r.Method == http.MethodGet {
		writeJSON(w, map[string]any{"success": true, "seedRevision": wikiGuideRevision(catalog), "runtimeRevision": stringValue(catalog["seedRevision"]), "changed": true, "addedArticleIds": []any{}, "retiredArticleIds": []any{}})
		return
	}
	writeJSONStatus(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "message": "不支持的使用文档操作"})
}

func wikiGuideRevision(value map[string]any) string {
	encoded, _ := json.Marshal(value)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}
