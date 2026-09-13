package picui

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
)

var (
	ErrDisabled    = errors.New("picui disabled")
	ErrRateLimited = errors.New("picui rate limited")
)

type Config struct {
	Enabled      bool
	APIURL       string
	Token        string
	AllowedHosts []string
	Timeout      time.Duration
	Permission   int
}

type Result struct {
	URL string
	Key string
}

type Client struct {
	cfg        Config
	httpClient *http.Client
}

func New(cfg Config) *Client {
	if strings.TrimSpace(cfg.APIURL) == "" {
		cfg.APIURL = "https://picui.cn/api/v1"
	}
	cfg.APIURL = strings.TrimRight(strings.TrimSpace(cfg.APIURL), "/")
	if cfg.Timeout < 5*time.Second || cfg.Timeout > 60*time.Second {
		cfg.Timeout = 30 * time.Second
	}
	if cfg.Permission < 0 || cfg.Permission > 9 {
		cfg.Permission = 1
	}
	if len(cfg.AllowedHosts) == 0 {
		cfg.AllowedHosts = []string{"picui.cn", "www.picui.cn", "free.picui.cn"}
	}
	return &Client{cfg: cfg, httpClient: &http.Client{Timeout: cfg.Timeout}}
}

func (c *Client) Enabled() bool {
	return c != nil && c.cfg.Enabled && strings.TrimSpace(c.cfg.Token) != "" && c.cfg.APIURL != ""
}

func (c *Client) TrustedURL(raw string) bool {
	if c == nil {
		return false
	}
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	for _, allowed := range c.cfg.AllowedHosts {
		allowed = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(allowed, ".")))
		if allowed != "" && (host == allowed || strings.HasSuffix(host, "."+allowed)) {
			return true
		}
	}
	return false
}

// Upload sends one already-validated image to PicUI. The caller is expected to
// keep a local copy before calling this method. The response body is bounded,
// the bearer token is never included in errors, and only a trusted returned
// URL is exposed to the caller.
func (c *Client) Upload(ctx context.Context, data []byte, originalName, mimeType string) (Result, error) {
	if !c.Enabled() {
		return Result{}, ErrDisabled
	}
	if len(data) == 0 || !strings.HasPrefix(strings.ToLower(strings.TrimSpace(mimeType)), "image/") {
		return Result{}, errors.New("unsupported image")
	}
	name := safeFilename(originalName)
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		body, contentType, err := multipartBody(data, name, mimeType, c.cfg.Permission)
		if err != nil {
			return Result{}, err
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.APIURL+"/upload", body)
		if err != nil {
			return Result{}, err
		}
		request.Header.Set("Accept", "application/json")
		request.Header.Set("Content-Type", contentType)
		request.Header.Set("Authorization", "Bearer "+c.cfg.Token)

		response, err := c.httpClient.Do(request)
		if err != nil {
			lastErr = errors.New("picui network error")
			if attempt < 3 && waitRetry(ctx, attempt, "") == nil {
				continue
			}
			break
		}
		responseBody, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
		_ = response.Body.Close()
		if readErr != nil || len(responseBody) > 1<<20 {
			lastErr = errors.New("picui response unreadable")
			if attempt < 3 && waitRetry(ctx, attempt, "") == nil {
				continue
			}
			break
		}
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			var payload struct {
				Status  bool   `json:"status"`
				Message string `json:"message"`
				Error   string `json:"error"`
				Data    struct {
					Key   string `json:"key"`
					Links struct {
						URL string `json:"url"`
					} `json:"links"`
				} `json:"data"`
			}
			if json.Unmarshal(responseBody, &payload) == nil {
				if payload.Status && c.TrustedURL(payload.Data.Links.URL) {
					return Result{URL: strings.TrimSpace(payload.Data.Links.URL), Key: strings.TrimSpace(payload.Data.Key)}, nil
				}
				message := strings.ToLower(strings.TrimSpace(payload.Message + " " + payload.Error))
				if strings.Contains(message, "每小时") || strings.Contains(message, "限流") || strings.Contains(message, "rate") || strings.Contains(message, "too many") {
					return Result{}, ErrRateLimited
				}
			}
			lastErr = errors.New("picui returned no trusted image URL")
		} else {
			lastErr = fmt.Errorf("picui HTTP %d", response.StatusCode)
		}
		if !retryableStatus(response.StatusCode) || attempt >= 3 {
			break
		}
		if err := waitRetry(ctx, attempt, response.Header.Get("Retry-After")); err != nil {
			return Result{}, err
		}
	}
	if lastErr == nil {
		lastErr = errors.New("picui upload failed")
	}
	return Result{}, lastErr
}

func multipartBody(data []byte, name, mimeType string, permission int) (*bytes.Buffer, string, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", name)
	if err != nil {
		return nil, "", err
	}
	if _, err := part.Write(data); err != nil {
		return nil, "", err
	}
	if err := writer.WriteField("permission", strconv.Itoa(permission)); err != nil {
		return nil, "", err
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}
	return &body, writer.FormDataContentType(), nil
}

func safeFilename(raw string) string {
	name := path.Base(strings.ReplaceAll(strings.TrimSpace(raw), `\`, "/"))
	if name == "." || name == "/" || name == "" {
		return "image.bin"
	}
	var b strings.Builder
	for _, r := range name {
		if r < 0x20 || r == 0x7f || r == '"' || r == '\\' {
			b.WriteByte('_')
			continue
		}
		b.WriteRune(r)
	}
	name = b.String()
	if len(name) > 180 {
		name = name[:180]
	}
	return name
}

func retryableStatus(status int) bool {
	return status == http.StatusTooManyRequests || status >= 500
}

func waitRetry(ctx context.Context, attempt int, retryAfter string) error {
	delay := time.Duration(attempt) * 500 * time.Millisecond
	if seconds, err := strconv.Atoi(strings.TrimSpace(retryAfter)); err == nil && seconds > 0 {
		delay = time.Duration(seconds) * time.Second
	}
	if delay > 3*time.Second {
		delay = 3 * time.Second
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
