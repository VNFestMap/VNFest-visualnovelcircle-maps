package httpapi

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type uploadedImage struct {
	Bytes []byte
	Ext   string
}

func (s *Server) avatarUpload(w http.ResponseWriter, r *http.Request) {
	setUploadHeaders(w, "GET, POST, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.URL.Query().Get("action") != "upload" {
		writeJSON(w, map[string]any{"success": false, "message": "未知动作"})
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST 请求"})
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	imageFile, err := parseUploadedImage(w, r, "avatar", 2<<20)
	if err != nil {
		writeJSON(w, map[string]any{"success": false, "message": err.Error()})
		return
	}
	name := "avatar_" + intString(userID) + "_" + time.Now().Format("20060102150405") + "_" + randomHex(4) + "." + imageFile.Ext
	localURL := "data/avatars/" + name
	stored, err := s.storePublicDataImage(r.Context(), filepath.ToSlash(filepath.Join("avatars", name)), localURL, name, imageMime(imageFile.Ext), "avatar:"+intString(userID), imageFile.Bytes)
	if err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "文件保存失败"})
		return
	}
	avatarURL := imageURLWithCacheBust(stored.URL)
	if s.db == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "数据库不可用"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE users SET avatar_url = ?, avatar_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", avatarURL, userID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "头像更新失败"})
		return
	}
	response := map[string]any{"success": true, "message": "头像上传成功", "avatar_url": avatarURL}
	for key, value := range storedImageFields(stored) {
		response[key] = value
	}
	writeJSON(w, response)
}

func (s *Server) clubAvatarUpload(w http.ResponseWriter, r *http.Request) {
	setUploadHeaders(w, "POST, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST 请求"})
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	// ParseMultipartForm may read from r.Body before FormFile applies its own
	// limit. Apply the hard request limit first so the limit covers the complete
	// multipart envelope as well as the image bytes.
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20+256<<10)
	if err := r.ParseMultipartForm(2<<20 + 256<<10); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "上传失败"})
		return
	}
	scope := r.URL.Query().Get("scope")
	if scope == "" {
		scope = "club"
	}
	country := r.FormValue("country")
	if country != "japan" && country != "overseas" {
		country = "china"
	}
	rawID := strings.TrimSpace(r.FormValue("id"))
	if scope == "club" {
		id := parsePositiveInt(rawID)
		if id <= 0 {
			writeJSON(w, map[string]any{"success": false, "message": "缺少同好会 ID"})
			return
		}
		if !s.canManageClubUpload(r, userID, id, country) {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权上传该同好会头像"})
			return
		}
		rawID = intString(id)
	} else {
		if _, ok := s.adminUserID(r); !ok {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
			return
		}
		rawID = safeUploadID(rawID)
		if rawID == "" {
			rawID = scope + "_" + intString(time.Now().Unix()) + "_" + randomHex(4)
		}
	}
	imageFile, err := parseMultipartFile(r, "image", 2<<20)
	if err != nil {
		writeJSON(w, map[string]any{"success": false, "message": err.Error()})
		return
	}
	base := rawID + "_" + time.Now().Format("20060102150405") + "_" + randomHex(4) + "." + imageFile.Ext
	if scope == "club" {
		base = country + "_" + base
	}
	dir, prefix := "club_avatars", "data/club_avatars/"
	if scope == "publication" {
		dir, prefix = "publication_images", "data/publication_images/"
	} else if scope == "event" {
		dir, prefix = "event_images", "data/event_images/"
	}
	localURL := prefix + base
	stored, err := s.storePublicDataImage(r.Context(), filepath.ToSlash(filepath.Join(dir, base)), localURL, base, imageMime(imageFile.Ext), "club_avatar:"+scope+":"+country, imageFile.Bytes)
	if err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "文件保存失败"})
		return
	}
	response := map[string]any{"success": true, "message": "上传成功", "image_url": imageURLWithCacheBust(stored.URL)}
	for key, value := range storedImageFields(stored) {
		response[key] = value
	}
	writeJSON(w, response)
}

func (s *Server) recognitionImageUpload(w http.ResponseWriter, r *http.Request, kind string) {
	setUploadHeaders(w, "GET, POST, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST 请求"})
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	if kind != "submission" {
		if _, ok := s.adminUserID(r); !ok {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
			return
		}
	}
	// Keep the multipart envelope bounded before parsing fields and files.
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20+256<<10)
	if err := r.ParseMultipartForm(10<<20 + 256<<10); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "上传失败"})
		return
	}
	imageFile, err := parseMultipartFile(r, "image", 10<<20)
	if err != nil {
		writeJSON(w, map[string]any{"success": false, "message": err.Error()})
		return
	}
	clubID := parsePositiveInt(r.FormValue("club_id"))
	if (kind == "quiz" || kind == "badge") && clubID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "缺少同好会 ID"})
		return
	}
	country := r.FormValue("country")
	if country != "japan" && country != "overseas" {
		country = "china"
	}
	dir, prefix, name, successMessage := "submission_images", "data/submission_images/", "sub_"+intString(userID)+"_", "图片上传成功"
	if kind == "quiz" {
		dir, prefix, name, successMessage = "quiz_images", "data/quiz_images/", "quiz_"+intString(clubID)+"_"+country+"_", "题目图片上传成功"
	} else if kind == "badge" {
		dir, prefix, name, successMessage = "badge_images", "data/badge_images/", "badge_"+intString(clubID)+"_"+country+"_", "徽章图片上传成功"
	}
	filename := name + randomHex(6) + "." + imageFile.Ext
	localURL := prefix + filename
	var stored storedImage
	if kind == "badge" {
		stored, err = s.storePublicDataImage(r.Context(), filepath.ToSlash(filepath.Join(dir, filename)), localURL, filename, imageMime(imageFile.Ext), "recognition_badge:"+country, imageFile.Bytes)
	} else {
		stored = storedImage{URL: localURL, LocalBackup: localURL, Storage: "local"}
		err = s.files.SaveData(r.Context(), filepath.ToSlash(filepath.Join(dir, filename)), bytes.NewReader(imageFile.Bytes))
	}
	if err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "文件保存失败"})
		return
	}
	response := map[string]any{"success": true, "message": successMessage, "image_url": stored.URL}
	for key, value := range storedImageFields(stored) {
		response[key] = value
	}
	writeJSON(w, response)
}

func setUploadHeaders(w http.ResponseWriter, methods string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", methods)
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func (s *Server) loggedInUserID(r *http.Request) (int64, bool) {
	userID, _ := s.optionalSessionUser(r)
	return valueOrZero(userID), userID != nil
}

func (s *Server) canManageClubUpload(r *http.Request, userID, clubID int64, country string) bool {
	if userID <= 0 {
		return false
	}
	_, role := s.optionalSessionUser(r)
	if role == "super_admin" {
		return true
	}
	if s.db == nil {
		return false
	}
	var exists int
	err := s.db.QueryRowContext(r.Context(), `SELECT 1 FROM club_memberships WHERE user_id = ? AND club_id = ?
        AND COALESCE(country, 'china') = ? AND status = 'active' AND role IN ('manager', 'representative') LIMIT 1`, userID, clubID, country).Scan(&exists)
	return err == nil
}

func parseUploadedImage(w http.ResponseWriter, r *http.Request, field string, max int64) (uploadedImage, error) {
	r.Body = http.MaxBytesReader(w, r.Body, max+256<<10)
	if err := r.ParseMultipartForm(max + 256<<10); err != nil {
		return uploadedImage{}, errors.New("上传失败")
	}
	return parseMultipartFile(r, field, max)
}

func parseMultipartFile(r *http.Request, field string, max int64) (uploadedImage, error) {
	file, header, err := r.FormFile(field)
	if err != nil {
		return uploadedImage{}, errors.New("上传失败")
	}
	defer file.Close()
	if header.Size <= 0 || header.Size > max {
		if field == "avatar" {
			return uploadedImage{}, errors.New("图片大小不能超过 2MB")
		}
		if max >= 10<<20 {
			return uploadedImage{}, errors.New("图片不能超过 10MB")
		}
		return uploadedImage{}, errors.New("图片大小不能超过 2MB")
	}
	data, err := io.ReadAll(io.LimitReader(file, max+1))
	if err != nil || int64(len(data)) > max {
		return uploadedImage{}, errors.New("上传失败")
	}
	return classifyImage(data)
}

func classifyImage(data []byte) (uploadedImage, error) {
	if len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP" {
		return uploadedImage{Bytes: data, Ext: "webp"}, nil
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 {
		return uploadedImage{}, errors.New("仅支持 JPEG、PNG、GIF、WebP 格式")
	}
	mimeType := http.DetectContentType(data)
	ext := map[string]string{"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif"}[mimeType]
	if ext == "" {
		return uploadedImage{}, errors.New("仅支持 JPEG、PNG、GIF、WebP 格式")
	}
	return uploadedImage{Bytes: data, Ext: ext}, nil
}

func safeUploadID(value string) string {
	result := make([]byte, 0, len(value))
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '_' || char == '-' {
			result = append(result, byte(char))
		} else {
			result = append(result, '_')
		}
	}
	return string(result)
}

func randomHex(bytesCount int) string {
	data := make([]byte, bytesCount)
	if _, err := rand.Read(data); err != nil {
		return "00000000"
	}
	return hex.EncodeToString(data)
}

func intString(value int64) string { return strconv.FormatInt(value, 10) }
func parsePositiveInt(value string) int64 {
	parsed, _ := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if parsed < 0 {
		return 0
	}
	return parsed
}
func valueOrZero(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}
