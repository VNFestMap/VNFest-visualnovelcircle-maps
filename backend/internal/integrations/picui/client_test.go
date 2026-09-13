package picui

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestUploadSendsPicUIContractAndAcceptsFreeHost(t *testing.T) {
	const token = "test-token-not-a-production-secret"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/upload" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+token {
			t.Errorf("authorization header was not forwarded correctly")
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Fatalf("parse multipart form: %v", err)
		}
		if got := r.FormValue("permission"); got != "1" {
			t.Errorf("permission = %q, want 1", got)
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			t.Fatalf("file field missing: %v", err)
		}
		defer file.Close()
		if header.Filename != "cover.png" {
			t.Errorf("filename = %q, want cover.png", header.Filename)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":true,"data":{"key":"k-1","links":{"url":"https://free.picui.cn/images/k-1.png"}}}`))
	}))
	defer server.Close()

	client := New(Config{
		Enabled:      true,
		APIURL:       server.URL + "/api/v1",
		Token:        token,
		AllowedHosts: []string{"free.picui.cn"},
		Timeout:      5 * time.Second,
		Permission:   1,
	})
	result, err := client.Upload(context.Background(), []byte("png-bytes"), "cover.png", "image/png")
	if err != nil {
		t.Fatalf("upload failed: %v", err)
	}
	if result.URL != "https://free.picui.cn/images/k-1.png" || result.Key != "k-1" {
		t.Fatalf("unexpected upload result: %#v", result)
	}

}

func TestUploadRejectsUntrustedReturnedURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":true,"data":{"links":{"url":"https://evil.example/image.png"}}}`))
	}))
	defer server.Close()
	client := New(Config{Enabled: true, APIURL: server.URL, Token: "token", AllowedHosts: []string{"free.picui.cn"}})
	if _, err := client.Upload(context.Background(), []byte("png"), "a.png", "image/png"); err == nil {
		t.Fatal("untrusted URL was accepted")
	}
}

func TestUploadRateLimitIsNotRetried(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":false,"message":"每小时上传次数已达上限"}`))
	}))
	defer server.Close()
	client := New(Config{Enabled: true, APIURL: server.URL, Token: "token", AllowedHosts: []string{"free.picui.cn"}})
	_, err := client.Upload(context.Background(), []byte("png"), "a.png", "image/png")
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("error = %v, want ErrRateLimited", err)
	}
	if requests != 1 {
		t.Fatalf("rate-limited request count = %d, want 1", requests)
	}
}

func TestUploadDisabled(t *testing.T) {
	client := New(Config{APIURL: "https://picui.cn/api/v1", Token: "token"})
	_, err := client.Upload(context.Background(), []byte("png"), "a.png", "image/png")
	if !errors.Is(err, ErrDisabled) {
		t.Fatalf("error = %v, want ErrDisabled", err)
	}
}
