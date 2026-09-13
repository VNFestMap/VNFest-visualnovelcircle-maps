package httpapi

import (
	"net/http"
	"sync"
	"time"
)

type rateBucket struct {
	started time.Time
	count   int
}

var authRate = struct {
	sync.Mutex
	buckets map[string]rateBucket
}{buckets: make(map[string]rateBucket)}

func allowRequest(r *http.Request, action string, limit int, window time.Duration) bool {
	if limit <= 0 {
		return false
	}
	key := action + "|" + clientIP(r)
	now := time.Now()
	authRate.Lock()
	defer authRate.Unlock()
	bucket := authRate.buckets[key]
	if bucket.started.IsZero() || now.Sub(bucket.started) >= window {
		bucket = rateBucket{started: now, count: 0}
	}
	if bucket.count >= limit {
		authRate.buckets[key] = bucket
		return false
	}
	bucket.count++
	authRate.buckets[key] = bucket
	return true
}

func rateLimited(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "60")
	writeJSONStatus(w, http.StatusTooManyRequests, map[string]any{"success": false, "message": "操作过于频繁，请稍后再试"})
}
