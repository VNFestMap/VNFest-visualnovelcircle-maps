package httpapi

import (
	"bytes"
	"errors"
	"image"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	postImageMaxBytes   = 10 << 20
	postImageMaxSide    = 8192
	postImageMaxPixels  = 40_000_000
	projectFileMaxBytes = 50 << 20
)

var uploadTokenRE = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

func (s *Server) userBanner(w http.ResponseWriter, r *http.Request) {
	setUploadHeaders(w, "POST, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !sameOrigin(r) {
		postsError(w, "cross_origin", "拒绝跨站写入请求", http.StatusForbidden, nil)
		return
	}
	userID, ok := s.requireSpaceAccess(w, r)
	if !ok {
		return
	}
	if strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("action")), "remove") {
		if s.db == nil {
			postsError(w, "banner_unavailable", "横幅操作失败，请稍后重试", http.StatusServiceUnavailable, nil)
			return
		}
		if _, err := s.db.ExecContext(r.Context(), "UPDATE users SET banner_url = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?", userID); err != nil {
			postsError(w, "banner_unavailable", "横幅操作失败，请稍后重试", http.StatusInternalServerError, nil)
			return
		}
		writeJSON(w, map[string]any{"success": true, "data": map[string]any{"banner_url": "", "message": "已移除横幅"}})
		return
	}
	if s.db == nil || s.files == nil {
		postsError(w, "banner_unavailable", "横幅上传服务不可用", http.StatusServiceUnavailable, nil)
		return
	}
	imageFile, err := parseUploadedImage(w, r, "image", postImageMaxBytes)
	if err != nil {
		postsError(w, "invalid_upload", err.Error(), http.StatusUnprocessableEntity, nil)
		return
	}
	relative := filepath.ToSlash(filepath.Join("banners", time.Now().Format("2006/01"), randomHex(20)+"."+imageFile.Ext))
	localURL := "/uploads/" + relative
	stored, err := s.storePublicUploadImage(r.Context(), relative, localURL, filepath.Base(relative), imageMime(imageFile.Ext), "user_banner:"+intString(userID), imageFile.Bytes)
	if err != nil {
		postsError(w, "upload_failed", "无法保存图片", http.StatusInternalServerError, nil)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE users SET banner_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", stored.URL, userID); err != nil {
		// Keep the historical file rather than risking deletion of a file that
		// may already be visible through a cache or a concurrent request.
		postsError(w, "banner_unavailable", "横幅更新失败，请稍后重试", http.StatusInternalServerError, nil)
		return
	}
	data := map[string]any{"banner_url": stored.URL, "message": "横幅已更新"}
	for key, value := range storedImageFields(stored) {
		data[key] = value
	}
	writeJSON(w, map[string]any{"success": true, "data": data})
}

func (s *Server) postImages(w http.ResponseWriter, r *http.Request) {
	setUploadHeaders(w, "POST, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !sameOrigin(r) {
		postsError(w, "cross_origin", "拒绝跨站写入请求", http.StatusForbidden, nil)
		return
	}
	userID, ok := s.requireSpaceAccess(w, r)
	if !ok {
		return
	}
	if s.db == nil || s.files == nil {
		postsError(w, "upload_unavailable", "图片上传服务不可用", http.StatusServiceUnavailable, nil)
		return
	}
	if strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("action")), "delete") {
		s.postImageDelete(w, r, userID)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, postImageMaxBytes+256<<10)
	if err := r.ParseMultipartForm(postImageMaxBytes + 256<<10); err != nil {
		postsError(w, "invalid_upload", "图片上传失败", http.StatusUnprocessableEntity, nil)
		return
	}
	imageFile, err := parseMultipartFile(r, "image", postImageMaxBytes)
	if err != nil {
		postsError(w, "invalid_upload", err.Error(), http.StatusUnprocessableEntity, nil)
		return
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(imageFile.Bytes))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > postImageMaxSide || config.Height > postImageMaxSide || int64(config.Width)*int64(config.Height) > postImageMaxPixels {
		postsError(w, "invalid_upload", "图片尺寸过大", http.StatusUnprocessableEntity, nil)
		return
	}
	token := strings.TrimSpace(r.FormValue("upload_token"))
	if token == "" {
		token = "post-" + randomHex(12)
	}
	if !uploadTokenRE.MatchString(token) {
		postsError(w, "invalid_upload_token", "上传标识无效", http.StatusUnprocessableEntity, nil)
		return
	}
	var count int
	if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM post_attachments WHERE uploader_id = ? AND upload_token = ? AND post_id IS NULL", userID, token).Scan(&count); err != nil {
		postsError(w, "upload_unavailable", "图片上传失败，请稍后重试", http.StatusInternalServerError, nil)
		return
	}
	if count >= postsImagesMax*3 {
		postsError(w, "upload_limit", "本次编辑上传图片过多，请先发布或移除部分图片", http.StatusUnprocessableEntity, nil)
		return
	}
	relative := filepath.ToSlash(filepath.Join("posts", time.Now().Format("2006/01"), randomHex(20)+"."+imageFile.Ext))
	if err := s.files.SaveUpload(r.Context(), relative, bytes.NewReader(imageFile.Bytes)); err != nil {
		postsError(w, "upload_failed", "无法保存图片", http.StatusInternalServerError, nil)
		return
	}
	originalName := truncateString(strings.TrimSpace(r.FormValue("filename")), 255)
	if originalName == "" {
		if file, header, headerErr := r.FormFile("image"); headerErr == nil && header != nil {
			originalName = truncateString(header.Filename, 255)
			_ = file.Close()
		}
	}
	result, err := s.db.ExecContext(r.Context(), `INSERT INTO post_attachments
		(uploader_id, post_id, upload_token, relative_path, mime_type, width, height, file_size, original_name, created_at)
		VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, userID, token, relative, imageMime(imageFile.Ext), config.Width, config.Height, len(imageFile.Bytes), originalName)
	if err != nil {
		// The file is intentionally retained as a recoverable orphan. A later
		// operator can reconcile it from the inventory; no user data is lost.
		postsError(w, "upload_unavailable", "图片记录保存失败，请稍后重试", http.StatusInternalServerError, nil)
		return
	}
	attachmentID, err := result.LastInsertId()
	if err != nil {
		postsError(w, "upload_unavailable", "图片记录保存失败，请稍后重试", http.StatusInternalServerError, nil)
		return
	}
	writeJSON(w, map[string]any{"success": true, "data": map[string]any{
		"upload_token": token,
		"attachment":   map[string]any{"id": attachmentID, "relative_path": relative, "url": "/uploads/" + relative, "width": config.Width, "height": config.Height},
	}})
}

func (s *Server) postImageDelete(w http.ResponseWriter, r *http.Request, userID int64) {
	var input map[string]any
	if err := decodeJSON(r, &input, 64<<10); err != nil || input == nil {
		postsError(w, "invalid_request", "请求格式无效", http.StatusUnprocessableEntity, nil)
		return
	}
	id := integerValue(input["id"])
	if id <= 0 {
		postsError(w, "not_found", "图片不存在或已随推文发布", http.StatusNotFound, nil)
		return
	}
	var relative string
	if err := s.db.QueryRowContext(r.Context(), "SELECT relative_path FROM post_attachments WHERE id = ? AND uploader_id = ? AND post_id IS NULL LIMIT 1", id, userID).Scan(&relative); err != nil {
		postsError(w, "not_found", "图片不存在或已随推文发布", http.StatusNotFound, nil)
		return
	}
	if err := s.files.DeleteUpload(r.Context(), relative); err != nil && !errors.Is(err, os.ErrNotExist) {
		postsError(w, "upload_unavailable", "图片删除失败，请稍后重试", http.StatusInternalServerError, nil)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "DELETE FROM post_attachments WHERE id = ? AND uploader_id = ? AND post_id IS NULL", id, userID); err != nil {
		postsError(w, "upload_unavailable", "图片记录删除失败，请稍后重试", http.StatusInternalServerError, nil)
		return
	}
	writeJSON(w, map[string]any{"success": true, "data": map[string]any{"message": "图片已删除"}})
}

var projectFileExt = map[string]string{
	"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
	"gif": "image/gif", "webp": "image/webp", "doc": "application/msword",
	"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "txt": "text/plain",
}

func (s *Server) projectFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(http.StatusOK)
		return
	}
	switch r.Method {
	case http.MethodGet:
		s.projectFileDownload(w, r)
	case http.MethodPost:
		s.projectFileUpload(w, r)
	case http.MethodDelete:
		s.projectFileDelete(w, r)
	default:
		methodNotAllowed(w, "GET, POST, DELETE")
	}
}

func (s *Server) projectFileDownload(w http.ResponseWriter, r *http.Request) {
	relative := cleanProjectFilePath(r.URL.Query().Get("file"))
	if relative == "" {
		http.NotFound(w, r)
		return
	}
	absolute := filepath.Join(s.cfg.UploadDir, "project_files", filepath.FromSlash(relative))
	base, err := filepath.Abs(filepath.Join(s.cfg.UploadDir, "project_files"))
	if err != nil || !withinPath(base, absolute) {
		http.NotFound(w, r)
		return
	}
	info, err := os.Stat(absolute)
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	file, err := os.Open(absolute)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filepath.Base(absolute)+`"`)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	http.ServeContent(w, r, filepath.Base(absolute), info.ModTime(), file)
}

func (s *Server) projectFileUpload(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	if s.files == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "文件服务不可用"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, projectFileMaxBytes+256<<10)
	if err := r.ParseMultipartForm(projectFileMaxBytes + 256<<10); err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "上传失败"})
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil || header.Size <= 0 || header.Size > projectFileMaxBytes {
		if file != nil {
			file.Close()
		}
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请选择不超过 50MB 的文件"})
		return
	}
	defer file.Close()
	ext := strings.ToLower(filepath.Ext(header.Filename))
	ext = strings.TrimPrefix(ext, ".")
	if _, ok := projectFileExt[ext]; !ok {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "不支持的文件类型"})
		return
	}
	projectID := parsePositiveInt(r.FormValue("project_id"))
	directory := "general"
	if projectID > 0 {
		directory = strconv.FormatInt(projectID, 10)
	}
	filename := time.Now().Format("20060102150405") + "_" + randomHex(6) + "." + ext
	relative := filepath.ToSlash(filepath.Join("project_files", directory, filename))
	if err := s.files.SaveUpload(r.Context(), relative, io.LimitReader(file, projectFileMaxBytes)); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "保存失败"})
		return
	}
	publicRelative := "uploads/" + relative
	writeJSON(w, map[string]any{"success": true, "file": map[string]any{
		"name": header.Filename, "url": publicRelative,
		"download_url": "./api/project_files.php?file=" + directory + "/" + filename,
		"size":         header.Size, "uploaded_by": userID, "created_at": time.Now().Format("2006-01-02 15:04:05"),
	}})
}

func (s *Server) projectFileDelete(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	if _, ok := s.loggedInUserID(r); !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	var input map[string]any
	if r.URL.Query().Get("file") != "" {
		input = map[string]any{"file": r.URL.Query().Get("file")}
	} else {
		_ = decodeJSON(r, &input, 64<<10)
	}
	relative := cleanProjectFilePath(stringValue(input["file"]))
	if relative == "" {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "文件不存在"})
		return
	}
	if err := s.files.DeleteUpload(r.Context(), filepath.ToSlash(filepath.Join("project_files", relative))); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "文件不存在"})
		} else {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "文件删除失败"})
		}
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "文件已删除"})
}

func cleanProjectFilePath(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, `\`, "/"))
	value = strings.TrimLeft(value, "/")
	if value == "" || strings.Contains(value, "\x00") || strings.Contains(value, "..") {
		return ""
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(value)))
	if clean == "." || strings.HasPrefix(clean, "../") || filepath.IsAbs(clean) {
		return ""
	}
	return clean
}

func withinPath(base, candidate string) bool {
	base, _ = filepath.Abs(base)
	candidate, _ = filepath.Abs(candidate)
	relative, err := filepath.Rel(base, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func imageMime(ext string) string {
	switch ext {
	case "jpg":
		return "image/jpeg"
	case "png":
		return "image/png"
	case "gif":
		return "image/gif"
	case "webp":
		return "image/webp"
	default:
		return "application/octet-stream"
	}
}
