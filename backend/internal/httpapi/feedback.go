package httpapi

import (
	"errors"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

func (s *Server) feedback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if s.files == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "文件存储不可用"})
		return
	}
	action := r.URL.Query().Get("action")
	if r.Method == http.MethodGet && action == "read" {
		if _, ok := s.adminUserID(r); !ok {
			s.adminDenied(w, r)
			return
		}
		var rows []map[string]any
		if err := s.files.ReadJSON(r.Context(), "feedback.json", &rows); err != nil && !errors.Is(err, os.ErrNotExist) {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取失败"})
			return
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		writeJSON(w, rows)
		return
	}
	if r.Method == http.MethodPut && action == "save" {
		if _, ok := s.adminUserID(r); !ok {
			s.adminDenied(w, r)
			return
		}
		var rows []map[string]any
		if err := decodeJSON(r, &rows, 4<<20); err != nil || rows == nil {
			writeJSON(w, map[string]any{"success": false, "message": "无效数据"})
			return
		}
		if err := s.files.WriteJSONAtomic(r.Context(), "feedback.json", rows); err != nil {
			writeJSON(w, map[string]any{"success": false})
			return
		}
		writeJSON(w, map[string]any{"success": true})
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST 请求"})
		return
	}
	if wait := feedbackWait(clientIP(r), time.Now()); wait > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		writeJSONStatus(w, 429, map[string]any{"success": false, "message": "反馈提交过于频繁，请稍后再试"})
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 32<<10); err != nil || input == nil {
		writeJSON(w, map[string]any{"success": false, "message": "无效数据"})
		return
	}
	fields := map[string]string{}
	for key, max := range map[string]int{"type": 16, "title": 120, "content": 3000, "contact": 120, "device": 200, "page_url": 500} {
		value, ok := input[key].(string)
		if input[key] != nil && !ok {
			writeJSONStatus(w, 400, map[string]any{"success": false, "message": "反馈字段必须是文本"})
			return
		}
		value = strings.TrimSpace(value)
		if !feedbackTextValid(value, max) {
			writeJSONStatus(w, 400, map[string]any{"success": false, "message": "反馈字段过长或含无效字符"})
			return
		}
		fields[key] = value
	}
	typ, title, content := fields["type"], fields["title"], fields["content"]
	if typ != "bug" && typ != "feature" && typ != "other" {
		writeJSONStatus(w, 400, map[string]any{"success": false, "message": "请选择反馈类型"})
		return
	}
	if runeLength(title) < 2 || runeLength(content) < 10 {
		writeJSONStatus(w, 400, map[string]any{"success": false, "message": "标题请填写 2-120 字，详细说明请填写 10-3000 字"})
		return
	}
	if !feedbackURLValid(fields["page_url"]) {
		writeJSONStatus(w, 400, map[string]any{"success": false, "message": "相关页面请填写有效的 HTTP 或 HTTPS 地址"})
		return
	}
	var rows []map[string]any
	if err := s.files.ReadJSON(r.Context(), "feedback.json", &rows); err != nil && !errors.Is(err, os.ErrNotExist) {
		writeJSON(w, map[string]any{"success": false, "message": "保存失败，请稍后重试"})
		return
	}
	for _, row := range rows {
		if stringValue(row["title"]) == title && stringValue(row["content"]) == content && stringValue(row["contact"]) == fields["contact"] {
			at, err := time.ParseInLocation("2006-01-02 15:04:05", stringValue(row["submitted_at"]), time.Local)
			if err == nil && time.Since(at) >= 0 && time.Since(at) < 24*time.Hour {
				writeJSONStatus(w, 409, map[string]any{"success": false, "message": "这条反馈已提交，请勿重复提交"})
				return
			}
		}
	}
	maxID := int64(0)
	for _, row := range rows {
		if id := integerValue(row["id"]); id > maxID {
			maxID = id
		}
	}
	entry := map[string]any{
		"id": maxID + 1, "type": typ, "title": title, "content": content,
		"page_url": fields["page_url"], "contact": fields["contact"],
		"device": fields["device"], "status": "pending",
		"submitted_at": time.Now().Format("2006-01-02 15:04:05"), "user_agent": r.UserAgent(),
	}
	rows = append(rows, entry)
	if err := s.files.WriteJSONAtomic(r.Context(), "feedback.json", rows); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "保存失败，请稍后重试"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "提交成功", "id": maxID + 1})
}

func runeLength(value string) int { return len([]rune(value)) }

// Bound both attempts and memory use; no raw IP addresses are persisted.
var feedbackRate = struct {
	sync.Mutex
	buckets map[string]struct {
		started time.Time
		count   int
	}
}{buckets: make(map[string]struct {
	started time.Time
	count   int
})}

func feedbackWait(ip string, now time.Time) time.Duration {
	const window = 10 * time.Minute
	feedbackRate.Lock()
	defer feedbackRate.Unlock()
	for key, b := range feedbackRate.buckets {
		if now.Sub(b.started) >= window {
			delete(feedbackRate.buckets, key)
		}
	}
	b, exists := feedbackRate.buckets[ip]
	if !exists && len(feedbackRate.buckets) >= 10000 {
		return window
	}
	if b.started.IsZero() {
		b.started = now
	}
	if b.count >= 5 {
		return b.started.Add(window).Sub(now)
	}
	b.count++
	feedbackRate.buckets[ip] = b
	return 0
}

func feedbackTextValid(value string, max int) bool {
	if !utf8.ValidString(value) || runeLength(value) > max {
		return false
	}
	for _, ch := range value {
		if ch == utf8.RuneError || (unicode.IsControl(ch) && ch != '\n' && ch != '\r' && ch != '\t') {
			return false
		}
	}
	return true
}

func feedbackURLValid(value string) bool {
	if value == "" {
		return true
	}
	for _, ch := range value {
		if unicode.IsSpace(ch) || unicode.IsControl(ch) {
			return false
		}
	}
	parsed, err := url.Parse(value)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Hostname() != "" && parsed.User == nil && parsed.Opaque == ""
}
