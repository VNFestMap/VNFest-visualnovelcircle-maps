package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"time"
)

func codeDigest(secret, purpose, email, salt, code string) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(purpose + "\x00" + email + "\x00" + salt + "\x00" + code))
	return hex.EncodeToString(h.Sum(nil))
}
func waitResponse(w http.ResponseWriter, wait time.Duration) {
	seconds := int64((wait + time.Second - 1) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
	writeJSONStatus(w, 429, map[string]any{"success": false, "message": "操作过于频繁，请稍后再试"})
}

// Persisted budgets are shared across local-account and OAuth flows, and survive
// restarts. Inserts and updates are guarded by row locks (MySQL) or SQLite's
// write transaction. Capacity is bounded; failure always prevents mail sending.
func (s *Server) allowCodeSend(r *http.Request, email string) (time.Duration, error) {
	if s.db == nil {
		return 0, errors.New("database unavailable")
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	now := time.Now().Unix()
	if _, err = tx.ExecContext(r.Context(), `DELETE FROM security_send_budgets WHERE started_at<?`, now-3600); err != nil {
		return 0, err
	}
	for _, rule := range []struct {
		key           string
		limit, window int64
	}{{"email-minute:" + filePathHash(email), 1, 60}, {"email-hour:" + filePathHash(email), 5, 3600}, {"ip-hour:" + filePathHash(clientIP(r)), 20, 3600}} {
		var started, count int64
		query := `SELECT started_at,request_count FROM security_send_budgets WHERE bucket_key=?`
		if s.db.Driver == "mysql" {
			query += " FOR UPDATE"
		}
		err = tx.QueryRowContext(r.Context(), query, rule.key).Scan(&started, &count)
		if errors.Is(err, sql.ErrNoRows) {
			var total int
			if e := tx.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM security_send_budgets`).Scan(&total); e != nil {
				return 0, e
			}
			if total >= 10000 {
				return time.Hour, nil
			}
			if _, err = tx.ExecContext(r.Context(), `INSERT INTO security_send_budgets(bucket_key,started_at,request_count) VALUES(?,?,1)`, rule.key, now); err != nil {
				return 0, err
			}
			continue
		}
		if err != nil {
			return 0, err
		}
		if now-started >= rule.window {
			started = now
			count = 0
		}
		if count >= rule.limit {
			return time.Duration(started+rule.window-now) * time.Second, nil
		}
		if _, err = tx.ExecContext(r.Context(), `UPDATE security_send_budgets SET started_at=?,request_count=? WHERE bucket_key=?`, started, count+1, rule.key); err != nil {
			return 0, err
		}
	}
	return 0, tx.Commit()
}
func (s *Server) codeSendResponse(w http.ResponseWriter, r *http.Request, email string) bool {
	wait, err := s.allowCodeSend(r, email)
	if err != nil {
		writeJSONStatus(w, 503, map[string]any{"success": false, "message": "验证码服务暂时不可用"})
		return false
	}
	if wait > 0 {
		waitResponse(w, wait)
		return false
	}
	return true
}
func (s *Server) issueSecurityCode(r *http.Request, purpose, email string, userID int64) (string, string, error) {
	code, err := sixDigitCode()
	if err != nil {
		return "", "", err
	}
	salt, id := randomHex(24), randomHex(24)
	now := time.Now().Unix()
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(r.Context(), `UPDATE security_email_codes SET used=1 WHERE purpose=? AND email=? AND used=0`, purpose, email); err != nil {
		return "", "", err
	}
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO security_email_codes(id,purpose,email,user_id,salt,code_hash,expires_at,attempts,used,created_at) VALUES(?,?,?,?,?,?,?,0,0,?)`, id, purpose, email, userID, salt, codeDigest(s.cfg.SessionSecret, purpose, email, salt, code), now+300, now); err != nil {
		return "", "", err
	}
	return code, id, tx.Commit()
}
func (s *Server) revokeSecurityCode(r *http.Request, id string) {
	_, _ = s.db.ExecContext(r.Context(), `UPDATE security_email_codes SET used=1 WHERE id=?`, id)
}

// A wrong attempt is committed; a valid code is consumed in the same
// transaction as the account mutation. This prevents replay and lost counters.
func (s *Server) consumeSecurityCode(r *http.Request, tx *sql.Tx, purpose, email, code string, userID int64) bool {
	var id, salt, digest string
	var attempts, expires int64
	query := `SELECT id,salt,code_hash,attempts,expires_at FROM security_email_codes WHERE purpose=? AND email=? AND user_id=? AND used=0 ORDER BY created_at DESC LIMIT 1`
	if s.db.Driver == "mysql" {
		query += " FOR UPDATE"
	}
	if tx.QueryRowContext(r.Context(), query, purpose, email, userID).Scan(&id, &salt, &digest, &attempts, &expires) != nil {
		return false
	}
	if attempts >= 5 || expires <= time.Now().Unix() {
		return false
	}
	if !hmac.Equal([]byte(digest), []byte(codeDigest(s.cfg.SessionSecret, purpose, email, salt, code))) {
		if _, err := tx.ExecContext(r.Context(), `UPDATE security_email_codes SET attempts=attempts+1 WHERE id=? AND used=0`, id); err == nil {
			_ = tx.Commit()
		}
		return false
	}
	result, err := tx.ExecContext(r.Context(), `UPDATE security_email_codes SET used=1 WHERE id=? AND used=0 AND attempts<5 AND expires_at>?`, id, time.Now().Unix())
	return err == nil && mustRowsAffected(result) == 1
}
