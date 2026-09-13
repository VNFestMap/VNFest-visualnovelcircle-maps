package sessionstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/domain"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

type Session = domain.Session

type SessionStore interface {
	Load(ctx context.Context, sessionID string) (*Session, error)
	Save(ctx context.Context, session *Session) error
	Invalidate(ctx context.Context, sessionID string) error
}

type Store struct {
	db *sqlstore.DB
}

var _ domain.SessionStore = (*Store)(nil)

func New(db *sqlstore.DB) *Store { return &Store{db: db} }

func (s *Store) Load(ctx context.Context, sessionID string) (*Session, error) {
	if sessionID == "" || len(sessionID) > 128 {
		return nil, nil
	}
	var userID sql.NullInt64
	var payload string
	var expires, created, updated any
	var valid int
	err := s.db.QueryRowContext(ctx, `SELECT user_id, payload_json, expires_at, created_at, updated_at, is_valid
        FROM vnfest_session_bridge WHERE session_id = ?`, sessionID).Scan(&userID, &payload, &expires, &created, &updated, &valid)
	if errors.Is(err, sql.ErrNoRows) {
		return s.loadLegacy(ctx, sessionID)
	}
	if bridgeTableMissing(err) {
		return s.loadLegacy(ctx, sessionID)
	}
	if err != nil {
		return nil, fmt.Errorf("load session bridge: %w", err)
	}
	expiresAt, err := parseTime(expires)
	if err != nil {
		return nil, fmt.Errorf("parse session expiry: %w", err)
	}
	if valid == 0 || !expiresAt.After(time.Now()) {
		return nil, nil
	}
	result := &Session{ID: sessionID, ExpiresAt: expiresAt, Valid: true}
	if userID.Valid {
		result.UserID = &userID.Int64
	}
	result.Payload = map[string]any{}
	if strings.TrimSpace(payload) != "" {
		if err := json.Unmarshal([]byte(payload), &result.Payload); err != nil {
			return nil, fmt.Errorf("decode session payload: %w", err)
		}
	}
	result.CreatedAt, _ = parseTime(created)
	result.UpdatedAt, _ = parseTime(updated)
	return result, nil
}

func bridgeTableMissing(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "no such table") || strings.Contains(message, "doesn't exist") || strings.Contains(message, "does not exist")
}

func (s *Store) loadLegacy(ctx context.Context, sessionID string) (*Session, error) {
	var userID int64
	var expires any
	var valid int
	err := s.db.QueryRowContext(ctx, `SELECT user_id, expires_at, is_valid FROM sessions WHERE id = ?`, sessionID).Scan(&userID, &expires, &valid)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load legacy session: %w", err)
	}
	expiresAt, err := parseTime(expires)
	if err != nil {
		return nil, err
	}
	if valid == 0 || !expiresAt.After(time.Now()) {
		return nil, nil
	}
	return &Session{ID: sessionID, UserID: &userID, Payload: map[string]any{"user_id": userID}, ExpiresAt: expiresAt, Valid: true}, nil
}

func (s *Store) Save(ctx context.Context, session *Session) error {
	return s.save(ctx, session, false)
}

// SaveReplacingUserSessions atomically retires all sessions for the user and
// creates the replacement in both stores. If any write fails, the old login
// remains usable for a PHP rollback instead of being invalidated prematurely.
func (s *Store) SaveReplacingUserSessions(ctx context.Context, session *Session) error {
	return s.save(ctx, session, true)
}

func (s *Store) save(ctx context.Context, session *Session, replaceUserSessions bool) error {
	if session == nil || session.ID == "" || len(session.ID) > 128 {
		return errors.New("invalid session")
	}
	if session.Payload == nil {
		session.Payload = map[string]any{}
	}
	if session.UserID != nil {
		session.Payload["user_id"] = *session.UserID
	}
	payload, err := json.Marshal(session.Payload)
	if err != nil {
		return fmt.Errorf("encode session payload: %w", err)
	}
	now := time.Now().UTC()
	if session.CreatedAt.IsZero() {
		session.CreatedAt = now
	}
	if session.UpdatedAt.IsZero() {
		session.UpdatedAt = now
	}
	valid := 0
	if session.Valid {
		valid = 1
	}
	var user any
	if session.UserID != nil {
		user = *session.UserID
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin session transaction: %w", err)
	}
	defer tx.Rollback()
	if replaceUserSessions && session.UserID != nil {
		if _, err := tx.ExecContext(ctx, "UPDATE sessions SET is_valid = 0 WHERE user_id = ?", *session.UserID); err != nil {
			return fmt.Errorf("invalidate legacy user sessions: %w", err)
		}
		if _, err := tx.ExecContext(ctx, "UPDATE vnfest_session_bridge SET is_valid = 0, updated_at = ? WHERE user_id = ?", now, *session.UserID); err != nil {
			return fmt.Errorf("invalidate bridged user sessions: %w", err)
		}
	}
	if err := s.saveSessionTx(ctx, tx, session, user, string(payload), valid); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit session transaction: %w", err)
	}
	return nil
}

func (s *Store) saveSessionTx(ctx context.Context, tx *sql.Tx, session *Session, user any, payload string, valid int) error {
	query := `INSERT INTO vnfest_session_bridge(session_id, user_id, payload_json, expires_at, is_valid, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET user_id=excluded.user_id, payload_json=excluded.payload_json,
		expires_at=excluded.expires_at, is_valid=excluded.is_valid, updated_at=excluded.updated_at`
	if s.db.Driver == "mysql" {
		query = `INSERT INTO vnfest_session_bridge(session_id, user_id, payload_json, expires_at, is_valid, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), payload_json=VALUES(payload_json),
			expires_at=VALUES(expires_at), is_valid=VALUES(is_valid), updated_at=VALUES(updated_at)`
	}
	if _, err := tx.ExecContext(ctx, query, session.ID, user, payload, session.ExpiresAt, valid, session.CreatedAt, session.UpdatedAt); err != nil {
		return fmt.Errorf("save session bridge: %w", err)
	}
	if session.UserID != nil {
		legacyQuery := `INSERT INTO sessions(id, user_id, ip_address, user_agent, expires_at, is_valid)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, ip_address=excluded.ip_address,
            user_agent=excluded.user_agent, expires_at=excluded.expires_at, is_valid=excluded.is_valid`
		if s.db.Driver == "mysql" {
			legacyQuery = `INSERT INTO sessions(id, user_id, ip_address, user_agent, expires_at, is_valid)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), ip_address=VALUES(ip_address),
                user_agent=VALUES(user_agent), expires_at=VALUES(expires_at), is_valid=VALUES(is_valid)`
		}
		if _, err := tx.ExecContext(ctx, legacyQuery, session.ID, *session.UserID, session.IPAddress, session.UserAgent, session.ExpiresAt, valid); err != nil {
			return fmt.Errorf("save legacy session: %w", err)
		}
	}
	return nil
}

func (s *Store) Invalidate(ctx context.Context, sessionID string) error {
	if sessionID == "" {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE vnfest_session_bridge SET is_valid = 0, updated_at = ? WHERE session_id = ?", time.Now().UTC(), sessionID); err != nil && !bridgeTableMissing(err) {
		return fmt.Errorf("invalidate session bridge: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE sessions SET is_valid = 0 WHERE id = ?", sessionID); err != nil {
		return fmt.Errorf("invalidate legacy session: %w", err)
	}
	return nil
}

// InvalidateUserSessions keeps the one-active-session behavior of the PHP
// implementation while also invalidating the bridge rows. This is deliberately
// transactional so a login cannot leave a rollback-visible session active when
// the new session is issued.
func (s *Store) InvalidateUserSessions(ctx context.Context, userID int64) error {
	if userID <= 0 {
		return errors.New("invalid user id")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin session invalidation: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "UPDATE sessions SET is_valid = 0 WHERE user_id = ?", userID); err != nil {
		return fmt.Errorf("invalidate legacy user sessions: %w", err)
	}
	if _, err := tx.ExecContext(ctx, "UPDATE vnfest_session_bridge SET is_valid = 0, updated_at = ? WHERE user_id = ?", time.Now().UTC(), userID); err != nil && !bridgeTableMissing(err) {
		return fmt.Errorf("invalidate bridged user sessions: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit session invalidation: %w", err)
	}
	return nil
}

type Manager struct {
	Store        SessionStore
	CookieName   string
	CookieDomain string
	Secure       bool
	Lifetime     time.Duration
}

func (m Manager) LoadRequest(ctx context.Context, r *http.Request) (*Session, error) {
	cookie, err := r.Cookie(m.CookieName)
	if err != nil {
		if errors.Is(err, http.ErrNoCookie) {
			return nil, nil
		}
		return nil, err
	}
	return m.Store.Load(ctx, cookie.Value)
}

func (m Manager) SetCookie(w http.ResponseWriter, sessionID string) {
	http.SetCookie(w, &http.Cookie{Name: m.CookieName, Value: sessionID, Path: "/", Domain: m.CookieDomain, Secure: m.Secure, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: int(m.Lifetime.Seconds())})
}

func (m Manager) ClearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: m.CookieName, Value: "", Path: "/", Domain: m.CookieDomain, Secure: m.Secure, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: -1, Expires: time.Unix(1, 0)})
}

func parseTime(value any) (time.Time, error) {
	switch item := value.(type) {
	case time.Time:
		return item, nil
	case string:
		return parseTimeString(item)
	case []byte:
		return parseTimeString(string(item))
	default:
		return time.Time{}, fmt.Errorf("unsupported database time type %T", value)
	}
}

func parseTimeString(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05.999999999-07:00", "2006-01-02 15:04:05.999999", "2006-01-02 15:04:05"} {
		if parsed, err := time.ParseInLocation(layout, value, time.Local); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, fmt.Errorf("unsupported database time value %q", value)
}
