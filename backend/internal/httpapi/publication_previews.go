package httpapi

import (
	"bytes"
	"image"
	_ "image/jpeg"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func (s *Server) publicationPreviews(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method == http.MethodGet {
		s.publicationPreviewsGet(w, r)
		return
	}
	if r.Method != http.MethodPost {
		writeJSONStatus(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "message": "不支持的请求方法"})
		return
	}
	if !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	user, err := s.findUser(r.Context(), userID)
	if err != nil || user == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	input := map[string]any{}
	isMultipart := strings.Contains(strings.ToLower(r.Header.Get("Content-Type")), "multipart/form-data")
	if isMultipart {
		r.Body = http.MaxBytesReader(w, r.Body, 10<<20+256<<10)
		if err := r.ParseMultipartForm(10<<20 + 256<<10); err != nil {
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请求格式无效"})
			return
		}
		for _, key := range []string{"action", "preview_id", "id", "page", "page_count"} {
			if value := r.FormValue(key); value != "" {
				input[key] = value
			}
		}
	} else if err := decodeJSON(r, &input, 2<<20); err != nil || input == nil {
		input = map[string]any{}
	}
	if action == "" {
		action = strings.ToLower(stringValue(input["action"]))
	}
	if action == "" {
		action = "list"
	}
	switch action {
	case "create":
		s.previewCreate(w, r, user, input)
	case "upload_page":
		s.previewUploadPage(w, r, user, input)
	case "publish":
		s.previewPublish(w, r, user, input)
	case "delete":
		s.previewDelete(w, r, user, input)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知 action"})
	}
}

func (s *Server) publicationPreviewsGet(w http.ResponseWriter, r *http.Request) {
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	data := s.projectHubReadMap(r.Context(), "publication_previews.json", map[string]any{"previews": []any{}})
	rows := mapSlice(data["previews"])
	if action == "backgrounds" {
		writeJSON(w, map[string]any{"success": true, "backgrounds": s.previewBackgrounds()})
		return
	}
	if action == "manage_list" {
		userID, ok := s.loggedInUserID(r)
		if !ok {
			writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
			return
		}
		user, err := s.findUser(r.Context(), userID)
		if err != nil || user == nil {
			writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
			return
		}
		result := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			if user.Role == "super_admin" || s.previewUserCanManage(r, user, normalizeProjectClubs(row["club_ids"])) {
				result = append(result, previewManageRow(row, user))
			}
		}
		sort.SliceStable(result, func(i, j int) bool {
			return stringValue(result[i]["updated_at"]) > stringValue(result[j]["updated_at"])
		})
		writeJSON(w, map[string]any{"success": true, "previews": result})
		return
	}
	active := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		if stringValue(row["status"]) == "active" {
			active = append(active, row)
		}
	}
	sort.SliceStable(active, func(i, j int) bool {
		return stringValue(active[i]["updated_at"]) > stringValue(active[j]["updated_at"])
	})
	if action == "list" || action == "" {
		out := make([]map[string]any, 0, len(active))
		for _, row := range active {
			out = append(out, previewPublicRow(row))
		}
		writeJSON(w, map[string]any{"success": true, "previews": out})
		return
	}
	if action != "detail" && action != "book_data" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知 action"})
		return
	}
	id := parsePositiveInt(firstNonEmpty(r.URL.Query().Get("id"), r.URL.Query().Get("preview_id")))
	var match map[string]any
	for _, row := range active {
		if integerValue(row["id"]) == id {
			match = row
			break
		}
	}
	if match == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "预览不存在或尚未发布"})
		return
	}
	public := previewPublicRow(match)
	if action == "book_data" {
		count := int(integerValue(match["page_count"]))
		pageURLs := stringSliceAny(match["page_urls"])
		pages := make([]any, 0, count)
		for index := 0; index < count; index++ {
			page := ""
			if index < len(pageURLs) {
				page = strings.TrimSpace(pageURLs[index])
			}
			if page == "" {
				page = stringValue(match["pages_base_path"]) + strconvInt(int64(index+1)) + ".jpg"
			}
			pages = append(pages, page)
		}
		toc := make([]map[string]any, 0, maxInt(count, 1))
		for index := 0; index < maxInt(count, 1); index++ {
			toc = append(toc, map[string]any{"caption": "第 " + strconvInt(int64(index+1)) + " 页", "page": strconvInt(int64(index + 1))})
		}
		public["pages"], public["toc"], public["reader_settings"] = pages, toc, previewReaderSettings(match["reader_settings"])
	}
	writeJSON(w, map[string]any{"success": true, "preview": public})
}

func (s *Server) previewCreate(w http.ResponseWriter, r *http.Request, user *user, input map[string]any) {
	clubs := normalizeProjectClubs(input["club_ids"])
	if !s.previewUserCanManage(r, user, clubs) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足，无法为该同好会发布刊物预览"})
		return
	}
	title := cleanProjectText(input["title"], 120)
	if title == "" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请填写刊物标题"})
		return
	}
	data := s.projectHubReadMap(r.Context(), "publication_previews.json", map[string]any{"previews": []any{}})
	rows := mapSlice(data["previews"])
	id := nextPublicationID(rows)
	row := map[string]any{"id": id, "title": title, "club_ids": clubs, "description": cleanProjectText(input["description"], 2000), "reader_settings": previewReaderSettings(input["reader_settings"]), "cover_path": "", "page_count": 0, "pages_base_path": "uploads/publication_previews/" + strconvInt(id) + "/pages/", "page_urls": []any{}, "page_local_paths": []any{}, "created_by": user.ID, "created_by_name": firstNonEmpty(user.Nickname, user.Username), "created_at": projectHubNow(), "updated_at": projectHubNow(), "status": "uploading"}
	rows = append(rows, row)
	data["previews"] = rows
	if err := s.projectHubWriteMap(r.Context(), "publication_previews.json", data); err != nil {
		projectHubWriteError(w)
		return
	}
	writeJSON(w, map[string]any{"success": true, "preview": previewPublicRow(row)})
}

func (s *Server) previewUploadPage(w http.ResponseWriter, r *http.Request, user *user, input map[string]any) {
	if s.files == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "保存页面失败"})
		return
	}
	id := integerValue(input["preview_id"])
	if id <= 0 {
		id = integerValue(input["id"])
	}
	data := s.projectHubReadMap(r.Context(), "publication_previews.json", map[string]any{"previews": []any{}})
	rows := mapSlice(data["previews"])
	idx := projectIndex(rows, id)
	if idx < 0 {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "预览不存在"})
		return
	}
	if !s.previewUserCanManage(r, user, normalizeProjectClubs(rows[idx]["club_ids"])) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	page := integerValue(input["page"])
	if page < 1 {
		page = 1
	}
	file, header, err := r.FormFile("image")
	if err != nil || header == nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "缺少页面图片"})
		return
	}
	defer file.Close()
	if header.Size <= 0 || header.Size > 10<<20 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "页面图片必须是 JPG"})
		return
	}
	content, err := io.ReadAll(io.LimitReader(file, 10<<20+1))
	if err != nil || len(content) > 10<<20 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "页面图片必须是 JPG"})
		return
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(content))
	if err != nil || format != "jpeg" || config.Width < 1 || config.Height < 1 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "页面图片必须是 JPG"})
		return
	}
	_ = config
	filename := "page_" + strconvInt(page) + "_" + strings.ReplaceAll(projectHubNow(), " ", "") + "_" + randomHex(4) + ".jpg"
	relative := filepath.ToSlash(filepath.Join("publication_previews", strconvInt(id), "pages", filename))
	localURL := "/uploads/" + relative
	stored, err := s.storePublicUploadImage(r.Context(), relative, localURL, header.Filename, "image/jpeg", "publication_preview:"+strconvInt(id), content)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "保存页面失败"})
		return
	}
	pageURLs := anySlice(rows[idx]["page_urls"])
	pageLocal := anySlice(rows[idx]["page_local_paths"])
	for len(pageURLs) < int(page) {
		pageURLs = append(pageURLs, "")
		pageLocal = append(pageLocal, "")
	}
	pageURLs[page-1], pageLocal[page-1] = stored.URL, "uploads/"+relative
	rows[idx]["page_urls"], rows[idx]["page_local_paths"] = pageURLs, pageLocal
	rows[idx]["page_count"] = maxInt(int(integerValue(rows[idx]["page_count"])), int(page))
	if stringValue(rows[idx]["cover_path"]) == "" {
		rows[idx]["cover_path"] = pageURLs[0]
	}
	rows[idx]["updated_at"], rows[idx]["status"] = projectHubNow(), "uploading"
	data["previews"] = rows
	if err := s.projectHubWriteMap(r.Context(), "publication_previews.json", data); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "保存页面失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "page": page})
}

func (s *Server) previewPublish(w http.ResponseWriter, r *http.Request, user *user, input map[string]any) {
	s.previewChangeStatus(w, r, user, input, true)
}

func (s *Server) previewDelete(w http.ResponseWriter, r *http.Request, user *user, input map[string]any) {
	s.previewChangeStatus(w, r, user, input, false)
}

func (s *Server) previewChangeStatus(w http.ResponseWriter, r *http.Request, user *user, input map[string]any, publish bool) {
	id := integerValue(input["preview_id"])
	if id <= 0 {
		id = integerValue(input["id"])
	}
	data := s.projectHubReadMap(r.Context(), "publication_previews.json", map[string]any{"previews": []any{}})
	rows := mapSlice(data["previews"])
	idx := projectIndex(rows, id)
	if idx < 0 {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "预览不存在"})
		return
	}
	if !s.previewUserCanManage(r, user, normalizeProjectClubs(rows[idx]["club_ids"])) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	if publish {
		pageCount := integerValue(input["page_count"])
		if pageCount <= 0 {
			pageCount = integerValue(rows[idx]["page_count"])
		}
		if pageCount < 1 {
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "页数无效"})
			return
		}
		pages := stringSliceAny(rows[idx]["page_urls"])
		for index := 0; index < int(pageCount); index++ {
			if index >= len(pages) || strings.TrimSpace(pages[index]) == "" {
				writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "第 " + strconvInt(int64(index+1)) + " 页尚未上传"})
				return
			}
		}
		rows[idx]["page_count"] = pageCount
		rows[idx]["status"] = "active"
		if stringValue(rows[idx]["cover_path"]) == "" && len(pages) > 0 {
			rows[idx]["cover_path"] = pages[0]
		}
	} else {
		rows[idx]["status"] = "deleted"
	}
	rows[idx]["updated_at"] = projectHubNow()
	data["previews"] = rows
	if err := s.projectHubWriteMap(r.Context(), "publication_previews.json", data); err != nil {
		projectHubWriteError(w)
		return
	}
	if publish {
		writeJSON(w, map[string]any{"success": true, "preview": previewPublicRow(rows[idx])})
	} else {
		writeJSON(w, map[string]any{"success": true})
	}
}

func (s *Server) previewUserCanManage(r *http.Request, user *user, clubs []map[string]any) bool {
	if user != nil && user.Role == "super_admin" {
		return true
	}
	for _, club := range clubs {
		if s.projectHubCanManageClub(r.Context(), user, club) {
			return true
		}
	}
	return false
}

func previewPublicRow(row map[string]any) map[string]any {
	return map[string]any{"id": integerValue(row["id"]), "title": stringValue(row["title"]), "club_ids": row["club_ids"], "description": stringValue(row["description"]), "cover_path": stringValue(row["cover_path"]), "page_count": integerValue(row["page_count"]), "pages_base_path": stringValue(row["pages_base_path"]), "created_by_name": stringValue(row["created_by_name"]), "created_at": stringValue(row["created_at"]), "updated_at": stringValue(row["updated_at"]), "status": firstNonEmpty(stringValue(row["status"]), "uploading")}
}

func previewManageRow(row map[string]any, user *user) map[string]any {
	public := previewPublicRow(row)
	public["can_delete"] = stringValue(public["status"]) != "deleted"
	_ = user
	return public
}

func previewReaderSettings(value any) map[string]any {
	defaults := map[string]any{"page_size": map[string]any{"preset": "a4", "width_mm": 210, "height_mm": 297, "orientation": "portrait"}, "theme": "wiki", "fit_mode": "fit-page", "flip_sound": true}
	input, ok := value.(map[string]any)
	if !ok {
		return defaults
	}
	result := map[string]any{}
	for key, defaultValue := range defaults {
		result[key] = defaultValue
	}
	if pageSize, ok := input["page_size"].(map[string]any); ok {
		page := map[string]any{"preset": firstNonEmpty(stringValue(pageSize["preset"]), "a4"), "width_mm": pageSize["width_mm"], "height_mm": pageSize["height_mm"], "orientation": firstNonEmpty(stringValue(pageSize["orientation"]), "portrait")}
		if page["width_mm"] == nil {
			page["width_mm"] = 210
		}
		if page["height_mm"] == nil {
			page["height_mm"] = 297
		}
		result["page_size"] = page
	}
	if theme := stringValue(input["theme"]); theme == "wiki" || theme == "dark" || theme == "warm" {
		result["theme"] = theme
	}
	if fit := stringValue(input["fit_mode"]); fit == "fit-page" || fit == "fit-width" {
		result["fit_mode"] = fit
	}
	if value, ok := input["flip_sound"].(bool); ok {
		result["flip_sound"] = value
	}
	return result
}

func (s *Server) previewBackgrounds() []map[string]any {
	root := filepath.Join(s.cfg.Root, "tools", "pdf-reader", "vendor", "pdfReader", "images", "background")
	entries, err := os.ReadDir(root)
	if err != nil {
		return []map[string]any{}
	}
	result := []map[string]any{}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		if ext != ".jpg" && ext != ".jpeg" && ext != ".png" && ext != ".webp" && ext != ".gif" {
			continue
		}
		result = append(result, map[string]any{"id": entry.Name(), "name": strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())), "path": "tools/pdf-reader/vendor/pdfReader/images/background/" + entry.Name()})
	}
	sort.SliceStable(result, func(i, j int) bool { return stringValue(result[i]["name"]) < stringValue(result[j]["name"]) })
	return result
}

func stringSliceAny(value any) []string {
	result := []string{}
	for _, item := range anySlice(value) {
		result = append(result, stringValue(item))
	}
	return result
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
