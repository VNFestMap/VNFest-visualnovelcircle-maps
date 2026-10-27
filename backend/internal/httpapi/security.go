package httpapi

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Session writes must originate from this site. Token-authenticated integrations
// and OAuth callbacks retain their own authentication contracts.
func (s *Server) securityRequest(w http.ResponseWriter, r *http.Request) bool {
	if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/club-operation-portrait/api/") {
		write := r.Method == "POST" || r.Method == "PUT" || r.Method == "PATCH" || r.Method == "DELETE"
		if r.URL.Path == "/api/auth.php" && r.URL.Query().Get("action") == "logout" {
			write = true
		}
		if write && !strings.HasPrefix(r.URL.Path, "/api/public/") && r.URL.Path != "/api/galonly_public.php" && r.URL.Path != "/api/analytics.php" && (r.URL.Path != "/api/bot.php" || strings.HasPrefix(r.URL.Query().Get("action"), "bot_tokens_")) && r.URL.Path != "/api/quiz_auth.php" && !sameOrigin(r) {
			writeJSONStatus(w, 403, map[string]any{"success": false, "message": "请求来源无效"})
			return false
		}
	}
	return true
}

type privateResponseWriter struct{ http.ResponseWriter }

func (w privateResponseWriter) WriteHeader(code int) {
	w.Header().Del("Access-Control-Allow-Origin")
	w.Header().Del("Access-Control-Allow-Credentials")
	w.ResponseWriter.WriteHeader(code)
}
func (w privateResponseWriter) Write(b []byte) (int, error) {
	w.Header().Del("Access-Control-Allow-Origin")
	w.Header().Del("Access-Control-Allow-Credentials")
	return w.ResponseWriter.Write(b)
}

func publicStaticPath(clean string) bool {
	for _, part := range strings.Split(clean, "/") {
		if strings.HasPrefix(part, ".") {
			return false
		}
	}
	first := strings.Split(strings.TrimPrefix(clean, "/"), "/")[0]
	switch first {
	case "backend", "scripts", "deploy", "exports", "docs", "includes", "vendor", "node_modules":
		return false
	}
	base := strings.ToLower(filepath.Base(clean))
	// Archives at the document root are deployment/maintenance artifacts.
	if strings.TrimPrefix(clean, "/") == filepath.Base(clean) {
		for _, ext := range []string{".zip", ".7z", ".rar", ".tar", ".tar.gz", ".tgz"} {
			if strings.HasSuffix(base, ext) {
				return false
			}
		}
	}
	if strings.HasPrefix(base, "_deploy") || strings.HasPrefix(base, "config.") || strings.HasPrefix(base, "package") || base == "go.mod" || base == "go.sum" {
		return false
	}
	for _, ext := range []string{".db", ".sqlite", ".sqlite3", ".sql", ".bak", ".backup", ".log", ".php", ".env"} {
		if strings.HasSuffix(base, ext) {
			return false
		}
	}
	return true
}

func regularStaticFile(root, relative string) (string, bool) {
	if root == "" {
		return "", false
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", false
	}
	candidate := filepath.Join(rootAbs, filepath.FromSlash(strings.TrimPrefix(relative, "/")))
	if !withinPath(rootAbs, candidate) {
		return "", false
	}
	// Do not follow even an in-root symlink: a public link could target a private
	// file in another mount or a sensitive file inside the same mount.
	rel, err := filepath.Rel(rootAbs, candidate)
	if err != nil {
		return "", false
	}
	cur := rootAbs
	for _, p := range strings.Split(rel, string(filepath.Separator)) {
		cur = filepath.Join(cur, p)
		info, err := os.Lstat(cur)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return "", false
		}
	}
	info, err := os.Stat(candidate)
	return candidate, err == nil && info.Mode().IsRegular()
}

func (s *Server) secureStatic(w http.ResponseWriter, r *http.Request, clean string) bool {
	if strings.HasPrefix(clean, "/.well-known/acme-challenge/") {
		rel := strings.TrimPrefix(clean, "/.well-known/acme-challenge/")
		if rel != "" && !strings.ContainsAny(rel, "/\\.") {
			if file, ok := regularStaticFile(s.cfg.Root, strings.TrimPrefix(clean, "/")); ok {
				http.ServeFile(w, r, file)
				return true
			}
		}
		http.NotFound(w, r)
		return true
	}
	if !publicStaticPath(clean) {
		http.NotFound(w, r)
		return true
	}
	if strings.HasPrefix(clean, "/uploads/project_files/") {
		copy := r.Clone(r.Context())
		copy.URL.RawQuery = url.Values{"file": {strings.TrimPrefix(clean, "/uploads/project_files/")}}.Encode()
		s.projectFileDownload(w, copy)
		return true
	}
	if strings.HasPrefix(clean, "/data/") {
		if clean == "/data/publications.json" {
			data := s.projectHubReadMap(r.Context(), "publications.json", map[string]any{"publications": []any{}})
			writeJSON(w, data)
			return true
		}
		rel := strings.TrimPrefix(clean, "/data/")
		dir := strings.Split(rel, "/")[0]
		switch dir {
		case "avatars", "badge_images", "club_avatars", "event_images", "publication_images", "quiz_images", "submission_images":
			ext := strings.ToLower(filepath.Ext(rel))
			if ext == ".jpg" || ext == ".jpeg" || ext == ".png" || ext == ".gif" || ext == ".webp" {
				s.serveStaticVolume(w, r, "/data/", s.cfg.DataDir)
				return true
			}
		}
		http.NotFound(w, r)
		return true
	}
	if strings.HasPrefix(clean, "/uploads/galonly/") {
		ext := strings.ToLower(filepath.Ext(clean))
		switch ext {
		case ".jpg", ".jpeg", ".png", ".gif", ".webp":
		case ".pdf", ".doc", ".docx", ".xls", ".xlsx":
			w.Header().Set("Content-Disposition", "attachment")
			w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
		default:
			http.NotFound(w, r)
			return true
		}
	}
	return false
}
