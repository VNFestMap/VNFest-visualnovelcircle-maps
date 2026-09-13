package sessionstore

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type memoryStore struct{ sessions map[string]*Session }

func (m *memoryStore) Load(_ context.Context, id string) (*Session, error) {
	return m.sessions[id], nil
}
func (m *memoryStore) Save(_ context.Context, session *Session) error {
	m.sessions[session.ID] = session
	return nil
}
func (m *memoryStore) Invalidate(_ context.Context, id string) error {
	delete(m.sessions, id)
	return nil
}

func TestPHPSESSIDCookieContract(t *testing.T) {
	manager := Manager{Store: &memoryStore{sessions: map[string]*Session{}}, CookieName: "PHPSESSID", CookieDomain: ".map.vnfest.top", Secure: true, Lifetime: 7 * 24 * time.Hour}
	recorder := httptest.NewRecorder()
	manager.SetCookie(recorder, "session-id")
	cookie := recorder.Result().Cookies()[0]
	if cookie.Name != "PHPSESSID" || cookie.Value != "session-id" || cookie.Domain != "map.vnfest.top" || !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("unexpected session cookie: %#v", cookie)
	}
	if cookie.MaxAge != 7*24*60*60 {
		t.Fatalf("unexpected max age: %d", cookie.MaxAge)
	}
}
