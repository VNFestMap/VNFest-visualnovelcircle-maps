package httpapi

import (
	"net/http"
	"sync"
	"time"
)

type rateBucket struct {
	started time.Time
	count   int
	window  time.Duration
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
	return allowRateKey(key, limit, window)
}

func allowRateKey(key string, limit int, window time.Duration) bool {
	now := time.Now()
	authRate.Lock()
	defer authRate.Unlock()
	for k, b := range authRate.buckets {
		if now.Sub(b.started) >= b.window {
			delete(authRate.buckets, k)
		}
	}
	if _, exists := authRate.buckets[key]; !exists && len(authRate.buckets) >= 10000 {
		return false
	}
	bucket := authRate.buckets[key]
	if bucket.started.IsZero() || now.Sub(bucket.started) >= window {
		bucket = rateBucket{started: now, count: 0, window: window}
	}
	if bucket.count >= limit {
		authRate.buckets[key] = bucket
		return false
	}
	bucket.count++
	authRate.buckets[key] = bucket
	return true
}

func rateKeyWait(key string, window time.Duration) time.Duration {
	authRate.Lock()
	defer authRate.Unlock()
	b := authRate.buckets[key]
	if b.started.IsZero() {
		return window
	}
	left := b.started.Add(window).Sub(time.Now())
	if left < time.Second {
		return time.Second
	}
	return left
}
func clearRateKey(key string) { authRate.Lock(); delete(authRate.buckets, key); authRate.Unlock() }
func rateKeyBlocked(key string, limit int, window time.Duration) bool {
	authRate.Lock()
	defer authRate.Unlock()
	b := authRate.buckets[key]
	return time.Since(b.started) < window && b.count >= limit
}

func rateLimited(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "60")
	writeJSONStatus(w, http.StatusTooManyRequests, map[string]any{"success": false, "message": "操作过于频繁，请稍后再试"})
}
