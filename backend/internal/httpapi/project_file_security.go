package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type projectFileRecord struct {
	ID, Path, Name, MIME, Purpose        string
	ProjectID, UploaderID, Size, Created int64
}

func filePathHash(path string) string {
	h := sha256.Sum256([]byte(path))
	return hex.EncodeToString(h[:])
}
func (s *Server) readProjectFile(r *http.Request, relative string) (*projectFileRecord, error) {
	if s.db == nil {
		return nil, errors.New("database unavailable")
	}
	f := &projectFileRecord{}
	err := s.db.QueryRowContext(r.Context(), `SELECT id,storage_path,project_id,uploader_id,purpose,original_name,mime_type,size_bytes,created_at FROM project_file_records WHERE path_hash=? AND deleted=0`, filePathHash(relative)).Scan(&f.ID, &f.Path, &f.ProjectID, &f.UploaderID, &f.Purpose, &f.Name, &f.MIME, &f.Size, &f.Created)
	return f, err
}
func (s *Server) insertProjectFile(r *http.Request, f *projectFileRecord) error {
	_, err := s.db.ExecContext(r.Context(), `INSERT INTO project_file_records(id,path_hash,storage_path,project_id,uploader_id,purpose,original_name,mime_type,size_bytes,created_at,deleted) VALUES(?,?,?,?,?,?,?,?,?,?,0)`, f.ID, filePathHash(f.Path), f.Path, f.ProjectID, f.UploaderID, f.Purpose, f.Name, f.MIME, f.Size, f.Created)
	return err
}
func (s *Server) fileProject(r *http.Request, id int64) map[string]any {
	var result map[string]any
	for _, p := range s.projectHubRows(r.Context(), "projects.json", "projects") {
		if integerValue(p["id"]) != id {
			continue
		}
		// Historical duplicate IDs cannot establish a unique resource owner.
		if result != nil {
			return nil
		}
		result = p
	}
	return result
}
func publicProject(p map[string]any) bool {
	return p != nil && stringValue(p["deleted_at"]) == "" && containsString([]string{"collecting", "ongoing", "completed", "active"}, stringValue(p["status"]))
}
func (s *Server) projectFileAccess(r *http.Request, f *projectFileRecord, write bool) bool {
	p := s.fileProject(r, f.ProjectID)
	if !write && f.Purpose == "public" && publicProject(p) {
		return true
	}
	id, _ := s.optionalSessionUser(r)
	if id == nil {
		return false
	}
	u, err := s.findUser(r.Context(), *id)
	if err != nil || u == nil {
		return false
	}
	return u.Role == "super_admin" || f.UploaderID == u.ID || p != nil && s.projectHubCanManageProject(r.Context(), u, p)
}
func attachmentRelative(raw any) string {
	row, ok := raw.(map[string]any)
	if !ok {
		return ""
	}
	if value := stringValue(row["download_url"]); value != "" {
		if u, e := url.Parse(value); e == nil && u.Host == "" && strings.HasSuffix(u.Path, "/api/project_files.php") {
			return cleanProjectFilePath(u.Query().Get("file"))
		}
	}
	value := strings.TrimLeft(stringValue(row["url"]), "./")
	if strings.HasPrefix(value, "uploads/project_files/") {
		return cleanProjectFilePath(strings.TrimPrefix(value, "uploads/project_files/"))
	}
	return ""
}

// Legacy ownership comes only from persisted participation.user_id, never from
// a client supplied uploaded_by field. Unlinked or conflicting files are private.
func (s *Server) reconcileProjectFile(r *http.Request, relative string) (*projectFileRecord, error) {
	if f, err := s.readProjectFile(r, relative); err == nil {
		return f, nil
	}
	var tombstones int
	if e := s.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM project_file_records WHERE path_hash=? AND deleted=1`, filePathHash(relative)).Scan(&tombstones); e != nil {
		return nil, e
	}
	if tombstones > 0 {
		return nil, nil
	}
	absolute, ok := regularStaticFile(filepath.Join(s.cfg.UploadDir, "project_files"), relative)
	if !ok {
		return nil, os.ErrNotExist
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return nil, err
	}
	f := &projectFileRecord{ID: randomHex(24), Path: relative, Name: filepath.Base(relative), MIME: "application/octet-stream", Purpose: "private", Size: info.Size(), Created: info.ModTime().Unix()}
	matched := false
	conflict := false
	for _, row := range s.projectHubRows(r.Context(), "project_participations.json", "participations") {
		for _, attachment := range anySlice(row["attachments"]) {
			if attachmentRelative(attachment) != relative {
				continue
			}
			pid, uid := integerValue(row["project_id"]), integerValue(row["user_id"])
			if matched && (pid != f.ProjectID || uid != f.UploaderID) {
				conflict = true
			}
			f.ProjectID, f.UploaderID = pid, uid
			matched = true
		}
	}
	if conflict {
		f.ProjectID, f.UploaderID = 0, 0
	}
	if err := s.insertProjectFile(r, f); err != nil {
		return s.readProjectFile(r, relative)
	}
	return f, nil
}
func (s *Server) validateParticipationFiles(r *http.Request, attachments any, userID, projectID int64) bool {
	for _, raw := range anySlice(attachments) {
		relative := attachmentRelative(raw)
		if relative == "" {
			return false
		}
		f, err := s.readProjectFile(r, relative)
		if err != nil || f.UploaderID != userID || f.ProjectID != projectID || f.Purpose != "private" {
			return false
		}
	}
	return true
}
func (s *Server) initializeProjectFiles() error {
	if s.db == nil || s.files == nil {
		return nil
	}
	// Lightweight test servers may intentionally omit the ownership schema;
	// production verifies migration 22 before New can run.
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM project_file_records`).Scan(&count); err != nil {
		return nil
	}
	root := filepath.Join(s.cfg.UploadDir, "project_files")
	if _, err := os.Stat(root); os.IsNotExist(err) {
		return nil
	}
	req := &http.Request{}
	req = httpRequestWithContext(req)
	return filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		rel, e := filepath.Rel(root, p)
		if e != nil {
			return e
		}
		_, e = s.reconcileProjectFile(req, filepath.ToSlash(rel))
		return e
	})
}
func projectFileURL(relative string) string {
	return "./api/project_files.php?file=" + url.QueryEscape(relative)
}
func (s *Server) projectFileDownloadSecure(w http.ResponseWriter, r *http.Request) {
	relative := cleanProjectFilePath(r.URL.Query().Get("file"))
	if relative == "" {
		http.NotFound(w, r)
		return
	}
	// Never recreate a tombstoned record, and never authorize a missing record
	// from client metadata. Legacy records are populated once during startup.
	f, err := s.readProjectFile(r, relative)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if !s.projectFileAccess(r, f, false) {
		status := 403
		if id, _ := s.optionalSessionUser(r); id == nil {
			status = 401
		}
		writeJSONStatus(w, status, map[string]any{"success": false, "message": "无权访问该附件"})
		return
	}
	absolute, ok := regularStaticFile(filepath.Join(s.cfg.UploadDir, "project_files"), f.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	file, err := os.Open(absolute)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(f.Name))
	w.Header().Set("Cache-Control", "private, no-store")
	http.ServeContent(w, r, f.Name, info.ModTime(), file)
}
func (s *Server) projectUploadPermission(w http.ResponseWriter, r *http.Request, userID, projectID int64, purpose string) bool {
	p := s.fileProject(r, projectID)
	if p == nil || stringValue(p["deleted_at"]) != "" {
		writeJSONStatus(w, 404, map[string]any{"success": false, "message": "企划不存在"})
		return false
	}
	u, err := s.findUser(r.Context(), userID)
	if err != nil || u == nil {
		writeJSONStatus(w, 401, map[string]any{"success": false})
		return false
	}
	manage := s.projectHubCanManageProject(r.Context(), u, p)
	if purpose == "public" && !manage || purpose == "private" && !manage && stringValue(p["status"]) != "collecting" {
		writeJSONStatus(w, 403, map[string]any{"success": false, "message": "该企划不接受附件上传"})
		return false
	}
	return true
}
func (s *Server) projectFileDeleteSecure(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.loggedInUserID(r); !ok {
		writeJSONStatus(w, 401, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	var input map[string]any
	relative := r.URL.Query().Get("file")
	if relative == "" {
		_ = decodeJSON(r, &input, 64<<10)
		relative = stringValue(input["file"])
	}
	relative = cleanProjectFilePath(relative)
	f, err := s.readProjectFile(r, relative)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if !s.projectFileAccess(r, f, true) {
		writeJSONStatus(w, 403, map[string]any{"success": false, "message": "无权删除该附件"})
		return
	}
	// Hide first; a filesystem failure retains recoverable bytes without serving
	// a record whose deletion already succeeded.
	if _, err = s.db.ExecContext(r.Context(), `UPDATE project_file_records SET deleted=1 WHERE id=? AND deleted=0`, f.ID); err != nil {
		writeJSONStatus(w, 500, map[string]any{"success": false})
		return
	}
	if err = s.files.DeleteUpload(r.Context(), "project_files/"+relative); err != nil && !errors.Is(err, os.ErrNotExist) {
		writeJSONStatus(w, 500, map[string]any{"success": false, "message": "记录已隐藏，文件清理待重试"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "文件已删除"})
}

// Kept independent from a live client request for startup reconciliation.
func httpRequestWithContext(r *http.Request) *http.Request {
	return r.WithContext(context.Background())
}
