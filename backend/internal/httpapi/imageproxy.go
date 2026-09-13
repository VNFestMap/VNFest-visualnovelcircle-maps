package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var (
	bangumiImagePath = regexp.MustCompile(`(?i)^/(r/\d+/)?pic/`)
	vndbImagePath    = regexp.MustCompile(`(?i)^/[a-z0-9._-]+(?:/[a-z0-9._-]+)*\.(?:jpe?g|png|gif|webp)$`)
	cngalImagePath   = regexp.MustCompile(`(?i)^/(?:images|upload)/[a-z0-9._/-]+$`)
	tucangImagePath  = regexp.MustCompile(`(?i)^/api/image/show/[a-z0-9_-]+$`)
	steamImagePath   = regexp.MustCompile(`(?i)^/steam/apps/\d+/[a-z0-9._/-]+\.(?:jpe?g|png|gif|webp)$`)
)

func (s *Server) imageProxy(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	rawURL := strings.TrimSpace(r.URL.Query().Get("url"))
	parsed, ok := allowedImageURL(rawURL)
	if !ok {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, "invalid url")
		return
	}
	cacheDir := filepath.Join(s.cfg.DataDir, "cache", "images")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		writeImageProxyNotFound(w)
		return
	}
	cacheKey := sha256.Sum256([]byte(rawURL))
	cachePath := filepath.Join(cacheDir, hex.EncodeToString(cacheKey[:])+".img")
	if data, err := readFreshBytes(cachePath, 24*time.Hour); err == nil {
		writeImageResponse(w, r, data)
		return
	}

	var data []byte
	var err error
	for _, candidate := range imageProxyFetchURLs(rawURL, parsed) {
		data, err = fetchImage(r.Context(), candidate)
		if err == nil {
			break
		}
	}
	if err != nil {
		if cached, readErr := os.ReadFile(cachePath); readErr == nil && len(cached) > 0 {
			writeImageResponse(w, r, cached)
			return
		}
		writeImageProxyNotFound(w)
		return
	}
	// Cache failure is non-fatal: the proxy response is still valid.
	_ = writeBytesAtomic(cachePath, data)
	writeImageResponse(w, r, data)
}

// imageProxyFetchURLs keeps the public proxy contract stable while handling
// provider-specific URLs that do not behave like ordinary image URLs. CnGal
// currently returns a tucang wrapper whose raw query is the image.cngal.org or
// Steam CDN origin; the PHP proxy tried the wrapper first and then a same-host
// allowlisted origin. Older Bangumi records also contain http URLs, which
// should use HTTPS first to avoid a redirect round trip while retaining the
// original candidate as fallback.
func imageProxyFetchURLs(raw string, parsed *url.URL) []string {
	if parsed == nil {
		return nil
	}
	candidates := make([]string, 0, 3)
	seen := make(map[string]struct{}, 3)
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		if _, exists := seen[value]; exists {
			return
		}
		seen[value] = struct{}{}
		candidates = append(candidates, value)
	}

	if strings.EqualFold(parsed.Hostname(), "lain.bgm.tv") && parsed.Scheme == "http" {
		secure := *parsed
		secure.Scheme = "https"
		add(secure.String())
	}
	add(raw)

	if strings.EqualFold(parsed.Hostname(), "tucang.cngal.top") {
		original := strings.TrimSpace(parsed.RawQuery)
		originalURL, err := url.Parse(original)
		if err == nil && originalURL != nil {
			if _, allowed := allowedImageURL(originalURL.String()); allowed {
				add(originalURL.String())
			}
		}
	}

	return candidates
}

func allowedImageURL(raw string) (*url.URL, bool) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, false
	}
	host := strings.ToLower(parsed.Hostname())
	allowed := (host == "lain.bgm.tv" && bangumiImagePath.MatchString(parsed.Path)) ||
		((host == "t.vndb.org" || host == "s.vndb.org") && vndbImagePath.MatchString(parsed.Path)) ||
		(host == "tucang.cngal.top" && tucangImagePath.MatchString(parsed.Path)) ||
		(host == "image.cngal.org" && cngalImagePath.MatchString(parsed.Path)) ||
		(host == "media.st.dl.eccdnx.com" && steamImagePath.MatchString(parsed.Path))
	if !allowed {
		return nil, false
	}
	return parsed, true
}

func fetchImage(ctx context.Context, rawURL string) ([]byte, error) {
	requestCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "VNFest/1.0 (https://map.vnfest.top; contact@vnfest.top)")
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, errors.New("upstream image status")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 10<<20+1))
	if err != nil || len(data) == 0 || len(data) > 10<<20 {
		return nil, errors.New("invalid image size")
	}
	if imageContentType(data) == "" {
		return nil, errors.New("invalid image type")
	}
	return data, nil
}

func imageContentType(data []byte) string {
	if len(data) >= 8 && bytes.Equal(data[:8], []byte("\x89PNG\r\n\x1a\n")) {
		return "image/png"
	}
	if len(data) >= 3 && bytes.Equal(data[:3], []byte{0xff, 0xd8, 0xff}) {
		return "image/jpeg"
	}
	if len(data) >= 6 && (bytes.Equal(data[:6], []byte("GIF87a")) || bytes.Equal(data[:6], []byte("GIF89a"))) {
		return "image/gif"
	}
	if len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")) {
		return "image/webp"
	}
	return ""
}

func readFreshBytes(path string, ttl time.Duration) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || time.Since(info.ModTime()) >= ttl {
		return nil, errors.New("cache miss")
	}
	return os.ReadFile(path)
}

func writeBytesAtomic(path string, data []byte) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".vnfest-image-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryName, path)
}

func writeImageResponse(w http.ResponseWriter, r *http.Request, data []byte) {
	mime := imageContentType(data)
	if mime == "" {
		writeImageProxyNotFound(w)
		return
	}
	hash := sha256.Sum256(data)
	etag := `"` + hex.EncodeToString(hash[:]) + `"`
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Length", fmt.Sprint(len(data)))
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("ETag", etag)
	if strings.Trim(r.Header.Get("If-None-Match"), `"`) == strings.Trim(etag, `"`) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	_, _ = w.Write(data)
}

func writeImageProxyNotFound(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	_, _ = io.WriteString(w, "image not found")
}
