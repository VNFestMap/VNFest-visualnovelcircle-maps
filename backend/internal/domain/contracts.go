package domain

import (
	"context"
	"io"
	"time"
)

// Stable seams shared by handlers, storage, and external integrations. Domain
// packages should depend on these contracts instead of a concrete SQL driver,
// filesystem layout, or SMTP implementation.
type Session struct {
	ID        string
	UserID    *int64
	Payload   map[string]any
	ExpiresAt time.Time
	CreatedAt time.Time
	UpdatedAt time.Time
	Valid     bool
	IPAddress string
	UserAgent string
}

type SessionStore interface {
	Load(ctx context.Context, sessionID string) (*Session, error)
	Save(ctx context.Context, session *Session) error
	Invalidate(ctx context.Context, sessionID string) error
}

type FileStore interface {
	ReadJSON(ctx context.Context, name string, dst any) error
	WriteJSONAtomic(ctx context.Context, name string, value any) error
	SaveUpload(ctx context.Context, relativePath string, r io.Reader) error
	OpenUpload(ctx context.Context, relativePath string) (io.ReadCloser, error)
}

type Message struct {
	To      string
	Subject string
	Body    string
}

type Mailer interface {
	Send(ctx context.Context, message Message) error
}

type OAuthBeginRequest struct {
	Provider    string
	State       string
	RedirectURI string
}

type OAuthRedirect struct{ URL string }

type OAuthCallbackRequest struct {
	Provider string
	Code     string
	State    string
}

type OAuthProfile struct {
	Provider string
	Subject  string
	Username string
	Email    string
}

type OAuthProvider interface {
	Begin(ctx context.Context, request OAuthBeginRequest) (OAuthRedirect, error)
	Callback(ctx context.Context, request OAuthCallbackRequest) (OAuthProfile, error)
}
