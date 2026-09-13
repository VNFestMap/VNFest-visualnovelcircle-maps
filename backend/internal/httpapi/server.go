package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	mailintegration "github.com/VNFestMap/galgame-community-map/backend/internal/integrations/mail"
	"github.com/VNFestMap/galgame-community-map/backend/internal/integrations/picui"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/filestore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sessionstore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
	"golang.org/x/crypto/bcrypt"
)

type Server struct {
	cfg            config.Config
	db             *sqlstore.DB
	files          *filestore.Store
	sessions       *sessionstore.Manager
	mailer         *mailintegration.Mailer
	picui          *picui.Client
	picuiPendingMu sync.Mutex
	mux            *http.ServeMux
	legacy         http.Handler
}

func New(cfg config.Config, db *sqlstore.DB, files *filestore.Store, sessions *sessionstore.Manager) (*Server, error) {
	server := &Server{
		cfg: cfg, db: db, files: files, sessions: sessions, mux: http.NewServeMux(),
		mailer: mailintegration.New(mailintegration.Config{
			Driver: cfg.MailDriver, FromName: cfg.MailFromName, FromAddr: cfg.MailFromAddr,
			SMTPHost: cfg.SMTPHost, SMTPPort: cfg.SMTPPort, SMTPUser: cfg.SMTPUser,
			SMTPPass: cfg.SMTPPassword, SMTPSecure: cfg.SMTPSecure,
		}),
		picui: picui.New(picui.Config{
			Enabled:      cfg.PicUIEnabled,
			APIURL:       cfg.PicUIAPIURL,
			Token:        cfg.PicUIToken,
			AllowedHosts: cfg.PicUIAllowedHosts,
			Timeout:      time.Duration(cfg.PicUITimeout) * time.Second,
			Permission:   cfg.PicUIPermission,
		}),
	}
	if cfg.LegacyPHPUpstream != "" {
		upstream, err := url.Parse(cfg.LegacyPHPUpstream)
		if err != nil || upstream.Scheme == "" || upstream.Host == "" {
			return nil, fmt.Errorf("invalid LEGACY_PHP_UPSTREAM")
		}
		proxy := httputil.NewSingleHostReverseProxy(upstream)
		originalDirector := proxy.Director
		proxy.Director = func(r *http.Request) {
			originalDirector(r)
			r.Header.Set("X-VNFest-Edge", "go")
		}
		server.legacy = proxy
	}
	server.routes()
	return server, nil
}

func (s *Server) routes() {
	s.mux.HandleFunc("/api/health.php", s.health)
	s.mux.HandleFunc("/api/test.php", s.test)
	s.mux.HandleFunc("/api/public/v1/clubs.php", s.publicClubs)
	s.mux.HandleFunc("/api/public/v1/club.php", s.publicClub)
	s.mux.HandleFunc("/api/public/v1/manifest.php", s.publicManifest)
	s.mux.HandleFunc("/api/auth.php", s.auth)
	s.mux.HandleFunc("/api/qq_callback.php", func(w http.ResponseWriter, r *http.Request) { s.oauthCallback(w, r, "qq") })
	s.mux.HandleFunc("/api/discord_callback.php", func(w http.ResponseWriter, r *http.Request) { s.oauthCallback(w, r, "discord") })
	s.mux.HandleFunc("/api/bangumi_callback.php", func(w http.ResponseWriter, r *http.Request) { s.oauthCallback(w, r, "bangumi") })
	s.mux.HandleFunc("/api/galgame_resume.php", s.userBoard)
	s.mux.HandleFunc("/api/galgame_meme.php", s.userBoard)
	s.mux.HandleFunc("/api/galgame_tier.php", s.userBoard)
	s.mux.HandleFunc("/api/get_config.php", s.publicConfig)
	s.mux.HandleFunc("/api/clubs.php", s.clubs)
	s.mux.HandleFunc("/api/clubs_japan.php", s.clubsJapan)
	s.mux.HandleFunc("/api/membership.php", s.membership)
	s.mux.HandleFunc("/api/users.php", s.users)
	s.mux.HandleFunc("/api/events.php", s.events)
	s.mux.HandleFunc("/api/extract.php", s.extract)
	s.mux.HandleFunc("/api/admin_insights.php", s.adminInsights)
	s.mux.HandleFunc("/api/admin_logs.php", s.adminLogs)
	s.mux.HandleFunc("/api/announcements.php", s.announcements)
	s.mux.HandleFunc("/api/notifications.php", s.notifications)
	s.mux.HandleFunc("/api/narrative_auth.php", s.narrativeAuth)
	s.mux.HandleFunc("/api/feedback.php", s.feedback)
	s.mux.HandleFunc("/api/bot.php", s.bot)
	s.mux.HandleFunc("/api/submit.php", s.submit)
	s.mux.HandleFunc("/api/submit_event.php", s.submitEvent)
	s.mux.HandleFunc("/api/submit_publication.php", s.submitPublication)
	s.mux.HandleFunc("/api/toggle_visibility.php", s.toggleVisibility)
	s.mux.HandleFunc("/api/star_unions.php", s.starUnions)
	s.mux.HandleFunc("/api/image_proxy.php", s.imageProxy)
	s.mux.HandleFunc("/api/avatar.php", s.avatarUpload)
	s.mux.HandleFunc("/api/user_banner.php", s.userBanner)
	s.mux.HandleFunc("/api/post_images.php", s.postImages)
	s.mux.HandleFunc("/api/project_files.php", s.projectFiles)
	s.mux.HandleFunc("/api/club_avatar.php", s.clubAvatarUpload)
	s.mux.HandleFunc("/api/badge_image.php", func(w http.ResponseWriter, r *http.Request) { s.recognitionImageUpload(w, r, "badge") })
	s.mux.HandleFunc("/api/quiz_image.php", func(w http.ResponseWriter, r *http.Request) { s.recognitionImageUpload(w, r, "quiz") })
	s.mux.HandleFunc("/api/submission_image.php", func(w http.ResponseWriter, r *http.Request) { s.recognitionImageUpload(w, r, "submission") })
	s.mux.HandleFunc("/api/posts.php", s.posts)
	s.mux.HandleFunc("/api/messages.php", s.messages)
	s.mux.HandleFunc("/api/projects.php", s.projectHub)
	s.mux.HandleFunc("/api/project_items.php", s.projectHub)
	s.mux.HandleFunc("/api/project_participations.php", s.projectHub)
	s.mux.HandleFunc("/api/publications.php", s.publications)
	s.mux.HandleFunc("/api/manuscripts.php", s.manuscripts)
	s.mux.HandleFunc("/api/publication_previews.php", s.publicationPreviews)
	s.mux.HandleFunc("/api/wiki.php", s.wiki)
	s.mux.HandleFunc("/api/club_codes.php", s.clubCodes)
	s.mux.HandleFunc("/api/club_comments.php", s.clubComments)
	s.mux.HandleFunc("/api/club_recommendations.php", s.clubRecommendations)
	s.mux.HandleFunc("/api/club_moe_king.php", s.clubMoeKing)
	s.mux.HandleFunc("/api/analytics.php", s.analytics)
	s.mux.HandleFunc("/api/growth.php", s.growth)
	s.mux.HandleFunc("/api/recognition_credentials.php", s.recognitionCredentials)
	s.mux.HandleFunc("/api/recognition_participate.php", s.recognitionParticipate)
	s.mux.HandleFunc("/api/recognition_programs.php", s.recognitionPrograms)
	s.mux.HandleFunc("/api/recognition_events.php", s.recognitionEvents)
	s.mux.HandleFunc("/api/recognition_admin.php", s.recognitionAdmin)
	s.mux.HandleFunc("/api/galonly.php", s.galonly)
	s.mux.HandleFunc("/api/galonly_staff.php", s.galonlyStaff)
	s.mux.HandleFunc("/api/vote_projects.php", s.voteProjects)
	s.mux.HandleFunc("/api/vote_nominations.php", s.voteNominations)
	s.mux.HandleFunc("/api/vote_stages.php", s.voteStagesAPI)
	s.mux.HandleFunc("/api/vote_votes.php", s.voteVotes)
	s.mux.HandleFunc("/api/vote_matches.php", s.voteMatches)
	s.mux.HandleFunc("/api/vote_sources.php", s.voteSources)
	s.mux.HandleFunc("/api/quiz_hub.php", s.quizHub)
	s.mux.HandleFunc("/api/migrate_publications.php", s.migratePublications)
	s.mux.HandleFunc("/api/moe_contests.php", s.voteProjects)
	s.mux.HandleFunc("/api/twelve_contests.php", s.voteProjects)
	s.mux.HandleFunc("/api/moe_stages.php", s.voteStagesAPI)
	s.mux.HandleFunc("/api/twelve_rounds.php", s.voteStagesAPI)
	s.mux.HandleFunc("/api/moe_votes.php", s.voteVotes)
	s.mux.HandleFunc("/api/twelve_votes.php", s.voteVotes)
	s.mux.HandleFunc("/api/moe_matches.php", s.voteMatches)
	s.mux.HandleFunc("/api/moe_candidates.php", s.voteNominations)
	s.mux.HandleFunc("/api/twelve_works.php", s.voteNominations)
	s.mux.HandleFunc("/api/backgrounds.php", s.backgrounds)
	s.mux.HandleFunc("/api/vndb_search.php", s.vndbSearch)
	s.mux.HandleFunc("/api/vndb_proxy.php", s.vndbProxy)
	s.mux.HandleFunc("/api/quiz.php", s.quiz)
	s.mux.HandleFunc("/api/quiz_auth.php", s.quizAuth)
	s.mux.HandleFunc("/api/bangumi_account.php", s.bangumiAccount)
	s.mux.HandleFunc("/api/bangumi_proxy.php", s.bangumiProxy)
	s.mux.HandleFunc("/api/bangumi_v0_search.php", s.bangumiV0Search)
	s.mux.HandleFunc("/api/spy_rooms.php", s.spyRooms)
	s.mux.HandleFunc("/api/spy_actions.php", s.spyActions)
	s.mux.HandleFunc("/api/spy_table.php", s.spyTable)
	s.mux.HandleFunc("/Forum/api/forum.php", s.forumArchived)
	s.mux.HandleFunc("/club-operation-portrait/api/index.php", s.portrait)
	// Keep the prefix addressable so an isolated rehearsal upstream can still be
	// selected during rollback. Every production endpoint is registered above;
	// an unknown path is never silently treated as a migrated API.
	s.mux.HandleFunc("/api/", s.compat)
	s.mux.HandleFunc("/", s.static)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestID := make([]byte, 8)
	if _, err := rand.Read(requestID); err == nil {
		w.Header().Set("X-Request-ID", hex.EncodeToString(requestID))
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	s.mux.ServeHTTP(w, r)
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		s.healthHeaders(w)
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	s.healthHeaders(w)
	started := time.Now()
	status := "ok"
	checks := map[string]any{
		"go_version":          runtime.Version(),
		"go_sapi":             "go-http",
		"php_version":         "disabled",
		"php_sapi":            "disabled",
		"config_exists":       true,
		"db_driver":           s.cfg.DBDriver,
		"site_url":            s.cfg.SiteURL,
		"legacy_php_upstream": s.cfg.LegacyPHPUpstream != "",
	}
	if s.db == nil {
		checks["database"] = "not_configured"
		status = "degraded"
	} else if err := s.db.PingContext(r.Context()); err != nil {
		checks["database"] = "error"
		status = "degraded"
	} else {
		checks["database"] = "connected"
	}
	missing := make([]string, 0)
	// API compatibility paths are Go routes and intentionally have no physical
	// PHP files in the production image. Check only static assets that the Go
	// file server must provide.
	for _, name := range []string{"index.html", "admin/events.php"} {
		if _, err := os.Stat(filepath.Join(s.cfg.Root, filepath.FromSlash(name))); err != nil {
			if os.IsNotExist(err) {
				missing = append(missing, name)
			}
		}
	}
	if len(missing) > 0 {
		checks["file_integrity"] = "missing: " + strings.Join(missing, ", ")
		status = "degraded"
	} else {
		checks["file_integrity"] = "complete"
	}
	writable := make([]string, 0)
	for name, dir := range map[string]string{"data": s.cfg.DataDir, "uploads": s.cfg.UploadDir} {
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			writable = append(writable, name)
			continue
		}
		probe := filepath.Join(dir, ".vnfest-write-probe")
		if err := os.WriteFile(probe, []byte("ok"), 0o600); err != nil {
			writable = append(writable, name)
		} else {
			_ = os.Remove(probe)
		}
	}
	if len(writable) > 0 {
		checks["writable_dirs"] = "unwritable: " + strings.Join(writable, ", ")
		status = "degraded"
	} else {
		checks["writable_dirs"] = "ok"
	}
	checks["data_files_count"] = countJSONFiles(s.cfg.DataDir)
	checks["response_time_ms"] = float64(time.Since(started).Microseconds()) / 1000
	code := http.StatusOK
	if status != "ok" {
		code = http.StatusServiceUnavailable
	}
	writeJSONStatus(w, code, map[string]any{"status": status, "timestamp": time.Now().Format(time.RFC3339), "checks": checks})
}

func (s *Server) healthHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
}

func (s *Server) test(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "API 正常工作"})
}

func (s *Server) forumArchived(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	writeJSONStatus(w, http.StatusGone, map[string]any{"success": false, "archived": true, "message": "论坛功能已停止；当前内容发布请进入 VNFest 专栏。", "column_url": "/column/"})
}

func (s *Server) auth(w http.ResponseWriter, r *http.Request) {
	s.authHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	switch action {
	case "me":
		s.authMe(w, r)
	case "logout":
		s.authLogout(w, r)
	case "login_local":
		s.authLoginLocal(w, r)
	case "oauth_pending", "oauth_config", "qq_auth", "discord_auth", "bangumi_auth",
		"oauth_send_code", "oauth_verify_code", "oauth_complete_account", "oauth_link_existing", "oauth_transfer_provider", "oauth_cancel",
		"bind_qq", "bind_discord",
		"unbind_qq", "unbind_discord", "unbind_bangumi":
		s.authOAuth(w, r, action)
	case "register_local", "send_register_code", "send_password_reset_code", "reset_password",
		"change_password", "set_password", "send_code", "bind_email", "unbind_email",
		"update_profile", "update_display_club", "update_membership_application_email_preference", "update_language_preference":
		s.authExtended(w, r, action)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知动作", "available_actions": []string{"login_local", "register_local", "logout", "me", "oauth_pending", "oauth_config"}})
	}
}

func (s *Server) authHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token, Authorization")
	w.Header().Set("Cache-Control", "no-store")
}

func (s *Server) authMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	if s.sessions == nil || s.sessions.Store == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"logged_in": false, "user": nil, "memberships": []any{}, "error": "session store unavailable"})
		return
	}
	session, err := s.sessions.LoadRequest(r.Context(), r)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"logged_in": false, "user": nil, "memberships": []any{}, "error": "session unavailable"})
		return
	}
	if session == nil || session.UserID == nil {
		writeJSON(w, map[string]any{"logged_in": false, "user": nil, "memberships": []any{}})
		return
	}
	user, err := s.findUser(r.Context(), *session.UserID)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"logged_in": false, "user": nil, "memberships": []any{}, "error": "user unavailable"})
		return
	}
	if user == nil {
		_ = s.sessions.Store.Invalidate(r.Context(), session.ID)
		writeJSON(w, map[string]any{"logged_in": false, "user": nil, "memberships": []any{}})
		return
	}
	memberships := s.memberships(r.Context(), *session.UserID)
	writeJSON(w, map[string]any{"logged_in": true, "user": s.publicUser(r.Context(), user), "memberships": memberships})
}

func (s *Server) authLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		methodNotAllowed(w, "GET, POST")
		return
	}
	if s.sessions == nil || s.sessions.Store == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "退出登录失败"})
		return
	}
	if cookie, err := r.Cookie(s.sessions.CookieName); err == nil {
		if err := s.sessions.Store.Invalidate(r.Context(), cookie.Value); err != nil && s.legacy == nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "退出登录失败"})
			return
		}
	}
	s.sessions.ClearCookie(w)
	writeJSON(w, map[string]any{"success": true, "message": "已退出登录"})
}

func (s *Server) authLoginLocal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &input, 1<<20); err != nil || strings.TrimSpace(input.Username) == "" || input.Password == "" {
		writeJSON(w, map[string]any{"success": false, "message": "请输入用户名和密码"})
		return
	}
	user, err := s.findUserByLogin(r.Context(), strings.TrimSpace(input.Username))
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "登录失败，请稍后再试"})
		return
	}
	if user == nil || !verifyPassword(input.Password, user.PasswordHash) {
		writeJSON(w, map[string]any{"success": false, "message": "用户名或密码错误"})
		return
	}
	userID := user.ID
	sessionID, err := newSessionID()
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "登录失败，请稍后再试"})
		return
	}
	// Match PHP createSession semantics: one active session per user, including
	// rows visible to the rollback PHP runtime through the bridge.
	session := &sessionstore.Session{ID: sessionID, UserID: &userID, Payload: map[string]any{"user_id": userID}, ExpiresAt: time.Now().Add(time.Duration(s.cfg.SessionLifetime) * time.Second), Valid: true, IPAddress: clientIP(r), UserAgent: r.UserAgent()}
	var saveErr error
	if store, ok := s.sessions.Store.(*sessionstore.Store); ok {
		saveErr = store.SaveReplacingUserSessions(r.Context(), session)
	} else {
		saveErr = s.sessions.Store.Save(r.Context(), session)
	}
	if saveErr != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "登录失败，请稍后再试"})
		return
	}
	_, _ = s.db.ExecContext(r.Context(), "UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?", userID)
	s.sessions.SetCookie(w, sessionID)
	writeJSON(w, map[string]any{"success": true, "message": "登录成功", "user": s.publicUser(r.Context(), user), "memberships": s.memberships(r.Context(), userID)})
}

type user struct {
	ID                                                          int64
	Username, Nickname, AvatarURL, Role, Email, EmailVerifiedAt string
	PasswordHash, QQOpenID, DiscordID, ProfileBio               string
	IsAudit, MembershipEmailEnabled                             int64
	DisplayMembershipID                                         *int64
	LanguagePreference                                          string
}

func (s *Server) findUser(ctx context.Context, id int64) (*user, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, username, COALESCE(nickname, ''), COALESCE(avatar_url, ''), role,
        COALESCE(email, ''), COALESCE(email_verified_at, ''), COALESCE(password_hash, ''),
        COALESCE(qq_openid, ''), COALESCE(discord_id, ''), COALESCE(is_audit, 0), COALESCE(profile_bio, ''),
        COALESCE(membership_application_email_enabled, 1), display_membership_id,
        COALESCE(language_preference, '') FROM users WHERE id = ? AND status = 'active'`, id)
	return scanUser(row)
}

func (s *Server) findUserByLogin(ctx context.Context, login string) (*user, error) {
	user, err := s.scanUserQuery(ctx, `WHERE username = ? AND status = 'active'`, login)
	if err != nil {
		return nil, err
	}
	if user != nil {
		return user, nil
	}
	return s.scanUserQuery(ctx, `WHERE email = ? AND status = 'active'`, strings.ToLower(login))
}

func (s *Server) scanUserQuery(ctx context.Context, where string, value any) (*user, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, username, COALESCE(nickname, ''), COALESCE(avatar_url, ''), role,
        COALESCE(email, ''), COALESCE(email_verified_at, ''), COALESCE(password_hash, ''),
        COALESCE(qq_openid, ''), COALESCE(discord_id, ''), COALESCE(is_audit, 0), COALESCE(profile_bio, ''),
        COALESCE(membership_application_email_enabled, 1), display_membership_id,
        COALESCE(language_preference, '') FROM users `+where, value)
	return scanUser(row)
}

type scanner interface{ Scan(...any) error }

func scanUser(row scanner) (*user, error) {
	var result user
	var emailVerified, displayID, language sqlNullString
	if err := row.Scan(&result.ID, &result.Username, &result.Nickname, &result.AvatarURL, &result.Role, &result.Email, &emailVerified, &result.PasswordHash, &result.QQOpenID, &result.DiscordID, &result.IsAudit, &result.ProfileBio, &result.MembershipEmailEnabled, &displayID, &language); err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, err
	}
	result.EmailVerifiedAt = emailVerified.String
	if displayID.Valid {
		value := displayID.Int64
		result.DisplayMembershipID = &value
	}
	result.LanguagePreference = language.String
	return &result, nil
}

// sqlNullString also accepts the datetime/integer values returned by both
// MySQL and modernc SQLite without exposing driver-specific types here.
type sqlNullString struct {
	String string
	Int64  int64
	Valid  bool
}

func (n *sqlNullString) Scan(value any) error {
	if value == nil {
		n.Valid = false
		return nil
	}
	n.Valid = true
	switch item := value.(type) {
	case string:
		n.String = item
	case []byte:
		n.String = string(item)
	case time.Time:
		n.String = item.Format("2006-01-02 15:04:05")
	case int64:
		n.Int64 = item
		n.String = fmt.Sprint(item)
	default:
		n.String = fmt.Sprint(item)
	}
	return nil
}

func (s *Server) memberships(ctx context.Context, userID int64) []map[string]any {
	rows, err := s.db.QueryContext(ctx, `SELECT id, club_id, country, role, status FROM club_memberships WHERE user_id = ? AND status = 'active'`, userID)
	if err != nil {
		rows, err = s.db.QueryContext(ctx, `SELECT id, club_id, role, status FROM club_memberships WHERE user_id = ? AND status = 'active'`, userID)
		if err != nil {
			return []map[string]any{}
		}
		defer rows.Close()
		result := []map[string]any{}
		for rows.Next() {
			var id, clubID int64
			var role, status string
			if rows.Scan(&id, &clubID, &role, &status) == nil {
				result = append(result, map[string]any{"id": id, "club_id": clubID, "role": role, "status": status})
			}
		}
		return result
	}
	defer rows.Close()
	result := []map[string]any{}
	for rows.Next() {
		var id, clubID int64
		var country, role, status string
		if rows.Scan(&id, &clubID, &country, &role, &status) == nil {
			result = append(result, map[string]any{"id": id, "club_id": clubID, "country": country, "role": role, "status": status})
		}
	}
	return result
}

func publicUser(u *user) map[string]any {
	return publicUserWithBangumi(u, false, "")
}

func publicUserWithBangumi(u *user, bound bool, bangumiUsername string) map[string]any {
	return map[string]any{"id": u.ID, "username": u.Username, "nickname": firstNonEmpty(u.Nickname, u.Username), "avatar_url": u.AvatarURL, "role": u.Role, "email": u.Email, "email_verified": u.EmailVerifiedAt != "", "has_password": u.PasswordHash != "", "credentials_complete": u.PasswordHash != "" && u.EmailVerifiedAt != "", "needs_credential_upgrade": (u.QQOpenID != "" || u.DiscordID != "") && !(u.PasswordHash != "" && u.EmailVerifiedAt != ""), "can_set_password": u.PasswordHash == "" && u.EmailVerifiedAt != "", "can_unbind_email": (u.QQOpenID == "" && u.DiscordID == "") || !(u.PasswordHash != "" && u.EmailVerifiedAt != ""), "qq_bound": u.QQOpenID != "", "discord_bound": u.DiscordID != "", "bangumi_bound": bound, "bangumi_username": bangumiUsername, "profile_bio": u.ProfileBio, "is_audit": u.IsAudit, "membership_application_email_enabled": u.MembershipEmailEnabled == 1, "display_membership_id": u.DisplayMembershipID, "display_club": nil, "language_preference": languageOrNil(u.LanguagePreference)}
}

func (s *Server) publicUser(ctx context.Context, u *user) map[string]any {
	if u == nil {
		return nil
	}
	var bound int
	var username string
	if s.db != nil {
		// The binding table is installed by the Go migration. During the
		// rehearsal window it may not exist yet; the normal auth response must
		// remain usable in that case, so this optional enrichment is best effort.
		if err := s.db.QueryRowContext(ctx, "SELECT 1, bangumi_username FROM bangumi_bindings WHERE vnfmap_user_id=? LIMIT 1", u.ID).Scan(&bound, &username); err != nil {
			bound, username = 0, ""
		}
	}
	return publicUserWithBangumi(u, bound == 1, username)
}

func (s *Server) compat(w http.ResponseWriter, r *http.Request) {
	if s.legacy != nil {
		s.legacy.ServeHTTP(w, r)
		return
	}
	writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "code": "unknown_api", "message": "接口不存在", "path": r.URL.Path})
}

func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/config.php" || strings.HasPrefix(r.URL.Path, "/includes/") || strings.HasPrefix(r.URL.Path, "/vendor/") || strings.HasSuffix(r.URL.Path, ".db") || strings.HasSuffix(r.URL.Path, ".sqlite") || (strings.HasSuffix(r.URL.Path, ".php") && r.URL.Path != "/admin/events.php") {
		http.NotFound(w, r)
		return
	}
	// Check the raw path before path.Clean removes traversal components.
	// Rejecting a path segment containing '..' is intentionally conservative
	// for public static files and prevents escaping a configured volume root.
	if strings.Contains(r.URL.Path, "..") {
		http.NotFound(w, r)
		return
	}
	clean := path.Clean("/" + r.URL.Path)
	if strings.Contains(clean, "..") {
		http.NotFound(w, r)
		return
	}
	// These are deployment mount points, not necessarily children of the
	// checkout. Serving them explicitly keeps the public URLs unchanged when
	// Docker/Nginx mounts data and uploads on separate volumes.
	switch {
	case strings.HasPrefix(clean, "/uploads/"):
		s.serveStaticVolume(w, r, "/uploads/", s.cfg.UploadDir)
		return
	case strings.HasPrefix(clean, "/data/"):
		s.serveStaticVolume(w, r, "/data/", s.cfg.DataDir)
		return
	case strings.HasPrefix(clean, "/wiki/uploads/"):
		s.serveStaticVolume(w, r, "/wiki/uploads/", s.cfg.WikiUploadDir)
		return
	}
	http.FileServer(http.Dir(s.cfg.Root)).ServeHTTP(w, r)
}

func (s *Server) serveStaticVolume(w http.ResponseWriter, r *http.Request, prefix, root string) {
	if strings.TrimSpace(root) == "" {
		http.NotFound(w, r)
		return
	}
	copyRequest := r.Clone(r.Context())
	copyRequest.URL.Path = "/" + strings.TrimPrefix(path.Clean("/"+r.URL.Path), prefix)
	// copyRequest already contains a path relative to the configured volume
	// root. Applying StripPrefix a second time would make every /uploads/ and
	// /data/ request miss with 404 (for example /uploads/galonly/x.png would
	// be looked up as /uploads/galonly/x.png inside the uploads root).
	http.FileServer(http.Dir(root)).ServeHTTP(w, copyRequest)
}

func decodeJSON(r *http.Request, dst any, max int64) error {
	r.Body = io.NopCloser(io.LimitReader(r.Body, max))
	return json.NewDecoder(r.Body).Decode(dst)
}
func writeJSON(w http.ResponseWriter, value any) { writeJSONStatus(w, http.StatusOK, value) }
func writeJSONStatus(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func methodNotAllowed(w http.ResponseWriter, allowed string) {
	w.Header().Set("Allow", allowed)
	writeJSONStatus(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "message": "仅支持 " + allowed + " 请求"})
}
func countJSONFiles(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	count := 0
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			count++
		}
	}
	return count
}
func newSessionID() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
func clientIP(r *http.Request) string {
	host := r.RemoteAddr
	if index := strings.LastIndex(host, ":"); index > -1 {
		return host[:index]
	}
	return host
}
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
func languageOrNil(value string) any {
	if value == "zh" || value == "ja" {
		return value
	}
	return nil
}
func isNoRows(err error) bool { return strings.Contains(strings.ToLower(err.Error()), "no rows") }
func verifyPassword(password, encoded string) bool {
	if encoded == "" {
		return false
	}
	return bcryptCompare([]byte(encoded), []byte(password))
}
func bcryptCompare(hash, password []byte) bool {
	// PHP password_hash() commonly emits $2y$; Go's bcrypt parser uses the
	// equivalent $2a$ marker, while the actual bcrypt payload is identical.
	encoded := strings.Replace(string(hash), "$2y$", "$2a$", 1)
	return bcrypt.CompareHashAndPassword([]byte(encoded), password) == nil
}
