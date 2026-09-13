package httpapi

import (
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

var manuscriptExtensions = map[string]bool{"pdf": true, "png": true, "jpg": true, "jpeg": true, "doc": true, "docx": true}

func (s *Server) manuscripts(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	if r.Method == http.MethodGet && action == "list_by_publication" {
		publicationID := parsePositiveInt(r.URL.Query().Get("publication_id"))
		rows := s.loadManuscripts(r)
		result := make([]map[string]any, 0)
		for _, row := range rows {
			if integerValue(row["publication_id"]) == publicationID {
				result = append(result, row)
			}
		}
		writeJSON(w, map[string]any{"success": true, "manuscripts": result})
		return
	}
	userID, loggedIn := s.loggedInUserID(r)
	if r.Method == http.MethodGet && action == "list_by_club" {
		if !loggedIn {
			writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
			return
		}
		user, _ := s.findUser(r.Context(), userID)
		clubID := parsePositiveInt(r.URL.Query().Get("club_id"))
		country := firstNonEmpty(cleanProjectText(r.URL.Query().Get("country"), 20), "china")
		if clubID <= 0 {
			writeJSON(w, map[string]any{"success": false, "message": "无效同好会ID"})
			return
		}
		if !s.publicationCanManage(r.Context(), user, clubID, country) {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
			return
		}
		result := make([]map[string]any, 0)
		for _, row := range s.loadManuscripts(r) {
			for _, rawClub := range anySlice(row["club_ids"]) {
				club := normalizeProjectClub(rawClub)
				if club != nil && integerValue(club["id"]) == clubID && stringValue(club["country"]) == country {
					result = append(result, row)
					break
				}
			}
		}
		writeJSON(w, map[string]any{"success": true, "manuscripts": result})
		return
	}
	if !loggedIn {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	user, err := s.findUser(r.Context(), userID)
	if err != nil || user == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	rows := s.loadManuscripts(r)
	switch action {
	case "upload":
		s.manuscriptUpload(w, r, user, rows)
	case "delete":
		s.manuscriptDelete(w, r, user, rows)
	case "download":
		s.manuscriptDownload(w, r, rows)
	default:
		writeJSON(w, map[string]any{"success": false, "message": "未知 action"})
	}
}

func (s *Server) loadManuscripts(r *http.Request) []map[string]any {
	if s.files == nil {
		return []map[string]any{}
	}
	var rows []map[string]any
	if err := s.files.ReadJSON(r.Context(), "manuscripts.json", &rows); err != nil || rows == nil {
		return []map[string]any{}
	}
	return rows
}

func (s *Server) manuscriptUpload(w http.ResponseWriter, r *http.Request, user *user, rows []map[string]any) {
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST 请求"})
		return
	}
	if s.files == nil || !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20+256<<10)
	if err := r.ParseMultipartForm(10<<20 + 256<<10); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "文件上传失败"})
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil || header.Size <= 0 || header.Size > 10<<20 {
		if file != nil {
			_ = file.Close()
		}
		writeJSON(w, map[string]any{"success": false, "message": "文件大小超过10MB限制"})
		return
	}
	defer file.Close()
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(header.Filename)), ".")
	if !manuscriptExtensions[ext] {
		writeJSON(w, map[string]any{"success": false, "message": "不支持的文件类型"})
		return
	}
	publicationID := parsePositiveInt(r.FormValue("publication_id"))
	publications := s.projectHubReadMap(r.Context(), "publications.json", map[string]any{"publications": []any{}})
	var publication map[string]any
	for _, row := range mapSlice(publications["publications"]) {
		if integerValue(row["id"]) == publicationID {
			publication = row
			break
		}
	}
	if publication == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "刊物不存在"})
		return
	}
	var maxID int64
	for _, row := range rows {
		if id := integerValue(row["id"]); id > maxID {
			maxID = id
		}
	}
	newID := maxID + 1
	filename := strconvInt(newID) + "_" + sanitizeManuscriptName(header.Filename)
	if err := s.files.SaveData(r.Context(), "manuscripts/"+filename, io.LimitReader(file, 10<<20)); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "文件保存失败"})
		return
	}
	row := map[string]any{"id": newID, "publication_id": publicationID, "publication_name": stringValue(publication["publicationName"]), "club_ids": publication["club_ids"], "submitter_id": user.ID, "submitter_name": firstNonEmpty(user.Nickname, user.Username), "contact": cleanProjectText(r.FormValue("contact"), 200), "file_name": header.Filename, "file_path": "data/manuscripts/" + filename, "remark": cleanProjectText(r.FormValue("remark"), 1000), "submitted_at": projectHubNow()}
	rows = append(rows, row)
	if err := s.files.WriteJSONAtomic(r.Context(), "manuscripts.json", rows); err != nil {
		// Preserve the saved file as a recoverable orphan. It is included in the
		// inventory and can be reconciled without losing the submitted bytes.
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "文件保存失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "上传成功", "manuscript": row})
}

func (s *Server) manuscriptDelete(w http.ResponseWriter, r *http.Request, user *user, rows []map[string]any) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		writeJSON(w, map[string]any{"success": false, "message": "不支持的请求方法"})
		return
	}
	if !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	var input map[string]any
	if r.Method == http.MethodDelete || strings.Contains(strings.ToLower(r.Header.Get("Content-Type")), "json") {
		_ = decodeJSON(r, &input, 64<<10)
	}
	id := integerValue(input["id"])
	if id <= 0 {
		id = parsePositiveInt(r.URL.Query().Get("id"))
	}
	idx := -1
	for index, row := range rows {
		if integerValue(row["id"]) == id {
			idx = index
			break
		}
	}
	if idx < 0 {
		writeJSON(w, map[string]any{"success": false, "message": "稿件不存在"})
		return
	}
	if integerValue(rows[idx]["submitter_id"]) != user.ID && user.Role != "super_admin" {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	// The legacy endpoint deleted the file. During migration we deliberately
	// keep it as a historical backup and only hide the record; zero-loss
	// cutover is more important than reclaiming this small amount of storage.
	rows = append(rows[:idx], rows[idx+1:]...)
	if err := s.files.WriteJSONAtomic(r.Context(), "manuscripts.json", rows); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "删除失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "删除成功"})
}

func (s *Server) manuscriptDownload(w http.ResponseWriter, r *http.Request, rows []map[string]any) {
	id := parsePositiveInt(r.URL.Query().Get("id"))
	var row map[string]any
	for _, candidate := range rows {
		if integerValue(candidate["id"]) == id {
			row = candidate
			break
		}
	}
	if row == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "稿件不存在"})
		return
	}
	if _, ok := s.loggedInUserID(r); !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	path := stringValue(row["file_path"])
	if !strings.HasPrefix(path, "data/") || strings.Contains(path, "..") {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "文件不存在"})
		return
	}
	relative := strings.TrimPrefix(path, "data/")
	file, err := os.Open(filepath.Join(s.cfg.DataDir, filepath.FromSlash(relative)))
	if err != nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "文件不存在"})
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "文件不存在"})
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename*=UTF-8''`+url.QueryEscape(stringValue(row["file_name"])))
	http.ServeContent(w, r, stringValue(row["file_name"]), info.ModTime(), file)
}

func sanitizeManuscriptName(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "upload.bin"
	}
	var out strings.Builder
	for _, r := range value {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' || r >= 0x4e00 && r <= 0x9fff {
			out.WriteRune(r)
		} else {
			out.WriteByte('_')
		}
	}
	return out.String()
}
