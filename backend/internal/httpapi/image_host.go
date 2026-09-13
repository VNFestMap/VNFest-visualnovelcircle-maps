package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type storedImage struct {
	URL         string
	LocalBackup string
	Storage     string
	RemoteKey   string
	Fallback    bool
}

func (s *Server) storePublicDataImage(ctx context.Context, relative, localURL, originalName, mimeType, contextName string, data []byte) (storedImage, error) {
	if s.files == nil {
		return storedImage{}, errors.New("file store unavailable")
	}
	if err := s.files.SaveData(ctx, relative, bytes.NewReader(data)); err != nil {
		return storedImage{}, err
	}
	return s.finishPublicImage(ctx, localURL, originalName, mimeType, contextName, data)
}

func (s *Server) storePublicUploadImage(ctx context.Context, relative, localURL, originalName, mimeType, contextName string, data []byte) (storedImage, error) {
	if s.files == nil {
		return storedImage{}, errors.New("file store unavailable")
	}
	if err := s.files.SaveUpload(ctx, relative, bytes.NewReader(data)); err != nil {
		return storedImage{}, err
	}
	return s.finishPublicImage(ctx, localURL, originalName, mimeType, contextName, data)
}

func (s *Server) finishPublicImage(ctx context.Context, localURL, originalName, mimeType, contextName string, data []byte) (storedImage, error) {
	result := storedImage{URL: localURL, LocalBackup: localURL, Storage: "local"}
	if s.picui == nil || !s.picui.Enabled() {
		return result, nil
	}
	remote, err := s.picui.Upload(ctx, data, originalName, mimeType)
	if err == nil {
		result.URL = remote.URL
		result.Storage = "picui"
		result.RemoteKey = remote.Key
		return result, nil
	}

	// The local file has already been durably written. Record a bounded retry
	// record without exposing provider credentials or response bodies.
	s.recordPicUIPending(ctx, contextName, localURL, data, err.Error())
	if !s.cfg.PicUIFallbackLocal {
		return storedImage{}, fmt.Errorf("image host upload failed: %w", err)
	}
	result.Fallback = true
	return result, nil
}

// Post images share their temporary upload endpoint with private messages. To
// avoid exposing a DM image on a public image host, promotion happens only
// after a post has been committed. The local path remains in
// post_attachments for ownership and cleanup; posts.images_json stores the
// remote URL only after a successful promotion.
func (s *Server) promotePostImages(ctx context.Context, postID, userID int64, images []string) {
	if s.db == nil || s.files == nil || s.picui == nil || !s.picui.Enabled() || postID <= 0 || userID <= 0 || len(images) == 0 {
		return
	}
	persisted := make([]string, 0, len(images))
	changed := false
	for _, imagePath := range images {
		imagePath = strings.TrimLeft(strings.ReplaceAll(strings.TrimSpace(imagePath), `\`, "/"), "/")
		if imagePath == "" || !strings.HasPrefix(imagePath, "uploads/posts/") || strings.Contains(imagePath, "..") {
			continue
		}
		localRelative := strings.TrimPrefix(imagePath, "uploads/")
		file, err := s.files.OpenUpload(ctx, localRelative)
		if err != nil {
			persisted = append(persisted, imagePath)
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(file, postImageMaxBytes+1))
		_ = file.Close()
		if readErr != nil || len(data) == 0 || len(data) > postImageMaxBytes {
			persisted = append(persisted, imagePath)
			continue
		}
		ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(localRelative)), ".")
		stored, storeErr := s.finishPublicImage(ctx, "/"+imagePath, filepath.Base(localRelative), imageMime(ext), "post:"+intString(postID), data)
		if storeErr != nil || stored.Storage != "picui" {
			persisted = append(persisted, imagePath)
			continue
		}
		persisted = append(persisted, stored.URL)
		changed = true
	}
	if !changed || len(persisted) != len(images) {
		return
	}
	encoded, err := json.Marshal(persisted)
	if err != nil {
		return
	}
	_, _ = s.db.ExecContext(ctx, "UPDATE posts SET images_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND author_id=?", string(encoded), postID, userID)
}

// promoteGalonlyPublicImages uploads only images belonging to an application
// that is already visible to the public. Submission/review uploads remain on
// the local volume until this point, which prevents an unapproved application
// or a private attachment from becoming publicly reachable at PicUI.
func (s *Server) promoteGalonlyPublicImages(ctx context.Context, applicationID int64) {
	if s.db == nil || s.files == nil || s.picui == nil || !s.picui.Enabled() || applicationID <= 0 {
		return
	}
	var imagePath, displayImage, merchandiseItems string
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(image_path,''),COALESCE(display_image,''),COALESCE(merchandise_items,'[]') FROM galonly_applications WHERE id=?`, applicationID).Scan(&imagePath, &displayImage, &merchandiseItems); err != nil {
		return
	}
	memo := map[string]string{}
	changed := false
	if imagePath != "" {
		var value any
		if json.Unmarshal([]byte(imagePath), &value) == nil {
			if next, didChange := s.promotePublicImageValue(ctx, value, "galonly:"+intString(applicationID), memo); didChange {
				if encoded, err := json.Marshal(next); err == nil {
					imagePath, changed = string(encoded), true
				}
			}
		}
	}
	if displayImage != "" {
		if next, didChange := s.promotePublicImageValue(ctx, displayImage, "galonly:"+intString(applicationID), memo); didChange {
			displayImage, changed = stringValue(next), true
		}
	}
	if merchandiseItems != "" {
		var value any
		if json.Unmarshal([]byte(merchandiseItems), &value) == nil {
			if next, didChange := s.promotePublicImageValue(ctx, value, "galonly:"+intString(applicationID), memo); didChange {
				if encoded, err := json.Marshal(next); err == nil {
					merchandiseItems, changed = string(encoded), true
				}
			}
		}
	}
	if changed {
		_, _ = s.db.ExecContext(ctx, `UPDATE galonly_applications SET image_path=?,display_image=?,merchandise_items=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`, imagePath, nullIfEmpty(displayImage), merchandiseItems, applicationID)
	}
}

func (s *Server) promotePublicImageValue(ctx context.Context, value any, contextName string, memo map[string]string) (any, bool) {
	switch typed := value.(type) {
	case string:
		raw := strings.TrimSpace(typed)
		if raw == "" || s.picui.TrustedURL(raw) {
			return value, false
		}
		localPath, file, localURL := s.openPublicImage(ctx, raw)
		if file == nil {
			return value, false
		}
		key := localPath
		if remote := memo[key]; remote != "" {
			return remote, true
		}
		data, err := io.ReadAll(io.LimitReader(file, 10<<20+1))
		_ = file.Close()
		if err != nil || len(data) == 0 || len(data) > 10<<20 {
			return value, false
		}
		mimeType := strings.ToLower(strings.TrimSpace(http.DetectContentType(data)))
		if !supportedPublicImageMime(mimeType) {
			return value, false
		}
		stored, err := s.finishPublicImage(ctx, localURL, filepath.Base(localPath), mimeType, contextName, data)
		if err != nil || stored.Storage != "picui" {
			return value, false
		}
		memo[key] = stored.URL
		return stored.URL, true
	case []any:
		changed := false
		for index := range typed {
			next, didChange := s.promotePublicImageValue(ctx, typed[index], contextName, memo)
			if didChange {
				typed[index], changed = next, true
			}
		}
		return typed, changed
	case map[string]any:
		changed := false
		for key, item := range typed {
			next, didChange := s.promotePublicImageValue(ctx, item, contextName, memo)
			if didChange {
				typed[key], changed = next, true
			}
		}
		return typed, changed
	default:
		return value, false
	}
}

func (s *Server) openPublicImage(ctx context.Context, raw string) (string, io.ReadCloser, string) {
	clean := strings.TrimLeft(strings.ReplaceAll(strings.TrimSpace(raw), `\`, "/"), "/")
	if clean == "" || strings.Contains(clean, "..") {
		return "", nil, ""
	}
	switch {
	case strings.HasPrefix(clean, "uploads/galonly/"):
		relative := strings.TrimPrefix(clean, "uploads/")
		file, err := s.files.OpenUpload(ctx, relative)
		return relative, fileOrNil(file, err), "/" + clean
	case strings.HasPrefix(clean, "data/galonly/"):
		relative := strings.TrimPrefix(clean, "data/")
		file, err := s.files.OpenData(ctx, relative)
		return relative, fileOrNil(file, err), "/" + clean
	case strings.HasPrefix(clean, "galonly/"):
		file, err := s.files.OpenData(ctx, clean)
		return clean, fileOrNil(file, err), "/data/" + clean
	default:
		return "", nil, ""
	}
}

func fileOrNil(file io.ReadCloser, err error) io.ReadCloser {
	if err != nil {
		return nil
	}
	return file
}

func supportedPublicImageMime(value string) bool {
	switch value {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}

func (s *Server) recordPicUIPending(ctx context.Context, contextName, localURL string, data []byte, uploadError string) {
	if s.files == nil {
		return
	}
	s.picuiPendingMu.Lock()
	defer s.picuiPendingMu.Unlock()

	rows := map[string]map[string]any{}
	if err := s.files.ReadJSON(ctx, "image-host/pending.json", &rows); err != nil && !errors.Is(err, os.ErrNotExist) {
		return
	}
	hash := sha256.Sum256(data)
	hashText := hex.EncodeToString(hash[:])
	key := localURL + "|" + hashText
	rows[key] = map[string]any{
		"context":    cleanImageHostContext(contextName),
		"local_url":  localURL,
		"sha256":     hashText,
		"size":       len(data),
		"error":      cleanImageHostError(uploadError),
		"updated_at": time.Now().Format(time.RFC3339),
	}
	_ = s.files.WriteJSONAtomic(ctx, "image-host/pending.json", rows)
}

func cleanImageHostContext(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 120 {
		value = value[:120]
	}
	var b strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune("._:-", r) {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

func cleanImageHostError(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 240 {
		value = value[:240]
	}
	return value
}

func storedImageFields(result storedImage) map[string]any {
	fields := map[string]any{
		"storage":      result.Storage,
		"local_backup": result.LocalBackup,
	}
	if result.RemoteKey != "" {
		fields["remote_key"] = result.RemoteKey
	}
	if result.Fallback {
		fields["fallback"] = true
	}
	return fields
}

func imageURLWithCacheBust(raw string) string {
	if raw == "" {
		return raw
	}
	separator := "?"
	if strings.Contains(raw, "?") {
		separator = "&"
	}
	return raw + separator + "t=" + fmt.Sprint(time.Now().Unix())
}
