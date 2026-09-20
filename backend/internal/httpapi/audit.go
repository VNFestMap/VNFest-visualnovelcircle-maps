package httpapi

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path"
	"strconv"
	"strings"
)

const (
	auditResponseCaptureLimit = 128 << 10
	auditJSONBodyLimit        = 1 << 20
)

// auditResponseWriter keeps the normal response path intact while retaining a
// small JSON response sample for the post-request audit record. It is only
// installed for API mutations, never for static files or streaming reads.
type auditResponseWriter struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
}

func (w *auditResponseWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *auditResponseWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	if w.body.Len() < auditResponseCaptureLimit {
		remaining := auditResponseCaptureLimit - w.body.Len()
		if remaining > len(p) {
			remaining = len(p)
		}
		_, _ = w.body.Write(p[:remaining])
	}
	return w.ResponseWriter.Write(p)
}

func (w *auditResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *auditResponseWriter) Flush() {
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		if w.status == 0 {
			w.WriteHeader(http.StatusOK)
		}
		flusher.Flush()
	}
}

type auditRequestSnapshot struct {
	actor       *user
	body        map[string]any
	path        string
	method      string
	contentType string
}

func (s *Server) auditRequestSnapshot(r *http.Request) *auditRequestSnapshot {
	if !shouldAutomaticallyAudit(r) || s.shouldSkipAutomaticAudit(r) {
		return nil
	}
	snapshot := &auditRequestSnapshot{
		actor:       s.auditActor(r),
		path:        r.URL.Path,
		method:      r.Method,
		contentType: r.Header.Get("Content-Type"),
	}
	if snapshot.contentType != "" && strings.HasPrefix(strings.ToLower(snapshot.contentType), "application/json") && r.Body != nil && r.ContentLength >= 0 && r.ContentLength <= auditJSONBodyLimit {
		body, err := io.ReadAll(r.Body)
		if err == nil {
			r.Body = io.NopCloser(bytes.NewReader(body))
			var decoded map[string]any
			if json.Unmarshal(body, &decoded) == nil {
				snapshot.body = decoded
			}
		}
	}
	return snapshot
}

func (s *Server) shouldSkipAutomaticAudit(r *http.Request) bool {
	switch r.URL.Path {
	case "/api/admin_logs.php", "/api/admin_insights.php", "/api/analytics.php", "/api/health.php", "/api/test.php", "/api/galonly_map.php":
		// The map endpoint already has domain-specific audit records. The other
		// endpoints are read-only operational surfaces.
		return true
	}
	return false
}

func shouldAutomaticallyAudit(r *http.Request) bool {
	if r.Method == http.MethodOptions || r.Method == http.MethodHead || !strings.HasPrefix(r.URL.Path, "/api/") {
		return false
	}
	if r.Method == http.MethodGet {
		// These GET requests have a real state-changing side effect in the
		// compatibility contract. OAuth callbacks are included so a successful
		// callback is visible even though it ends in a redirect.
		if r.URL.Path == "/api/auth.php" && strings.EqualFold(r.URL.Query().Get("action"), "logout") {
			return true
		}
		return strings.HasSuffix(r.URL.Path, "_callback.php")
	}
	return r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodPatch || r.Method == http.MethodDelete
}

func (s *Server) auditActor(r *http.Request) *user {
	userID, role := s.optionalSessionUser(r)
	if userID != nil {
		return &user{ID: *userID, Role: role}
	}
	if s.cfg.LegacyAuthEnabled && s.cfg.AdminToken != "" && subtle.ConstantTimeCompare([]byte(strings.TrimSpace(r.Header.Get("X-Admin-Token"))), []byte(s.cfg.AdminToken)) == 1 {
		return &user{Role: "super_admin"}
	}
	return nil
}

func (s *Server) finishAutomaticAudit(r *http.Request, snapshot *auditRequestSnapshot, response *auditResponseWriter) {
	if snapshot == nil || response == nil || !auditResponseSucceeded(response.status, response.body.Bytes()) {
		return
	}
	action, targetType, targetID, ok := auditActionForRequest(r, snapshot.body, response.body.Bytes())
	if !ok {
		return
	}
	actor := snapshot.actor
	if actor == nil {
		actor = s.auditActorFromResponse(r, response)
	}
	details := safeAuditDetails(r, snapshot.body, response.body.Bytes())
	details["result"] = "success"
	s.recordAudit(r.Context(), r, actor, action, targetType, targetID, details)
}

func auditResponseSucceeded(status int, body []byte) bool {
	if status == 0 {
		status = http.StatusOK
	}
	if status < http.StatusOK || status >= http.StatusMultipleChoices {
		return false
	}
	var decoded map[string]any
	if json.Unmarshal(body, &decoded) == nil {
		if value, exists := decoded["success"]; exists {
			if success, ok := value.(bool); ok {
				return success
			}
		}
	}
	return true
}

func (s *Server) auditActorFromResponse(r *http.Request, response *auditResponseWriter) *user {
	// Login and registration create the session in the response. Replay the
	// response cookie against the request so the same session lookup used by
	// normal handlers can recover the actor without exposing session contents.
	if s.sessions != nil {
		for _, cookie := range (&http.Response{Header: response.Header()}).Cookies() {
			if cookie.Name != s.sessions.CookieName {
				continue
			}
			clone := r.Clone(r.Context())
			clone.Header = r.Header.Clone()
			clone.AddCookie(cookie)
			if actor := s.auditActor(clone); actor != nil {
				return actor
			}
		}
	}
	var decoded map[string]any
	if json.Unmarshal(response.body.Bytes(), &decoded) == nil {
		if nested, ok := decoded["user"].(map[string]any); ok {
			if id := positiveAuditInt(nested["id"]); id > 0 {
				return &user{ID: id, Role: stringValue(nested["role"])}
			}
		}
	}
	return nil
}

func (s *Server) recordAudit(ctx context.Context, r *http.Request, actor *user, action, targetType string, targetID *int64, details map[string]any) {
	if s.db == nil || strings.TrimSpace(action) == "" {
		return
	}
	if details == nil {
		details = map[string]any{}
	}
	details = sanitizeAuditDetails(details)
	contextDetails := map[string]any{
		"method":     auditTrim(r.Method, 12),
		"path":       auditTrim(r.URL.Path, 255),
		"user_agent": auditTrim(r.UserAgent(), 500),
		"actor_role": nil,
	}
	if actor != nil && actor.Role != "" {
		contextDetails["actor_role"] = auditTrim(actor.Role, 64)
	}
	details["_context"] = contextDetails
	encoded, err := json.Marshal(details)
	if err != nil {
		slog.Default().Warn("audit log encode failed", "action", action, "target_type", targetType, "error", fmt.Sprintf("%T", err))
		return
	}
	var userID any
	if actor != nil && actor.ID > 0 {
		userID = actor.ID
	}
	var target any
	if targetID != nil && *targetID > 0 {
		target = *targetID
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
        VALUES (?, ?, ?, ?, ?, ?)`, userID, auditTrim(action, 255), auditTrim(targetType, 100), target, string(encoded), clientIP(r))
	if err != nil {
		slog.Default().Warn("audit log write failed", "action", action, "target_type", targetType, "target_id", target, "user_id", userID, "error", fmt.Sprintf("%T", err))
	}
}

func auditActionForRequest(r *http.Request, body map[string]any, response []byte) (string, string, *int64, bool) {
	name := strings.TrimSuffix(path.Base(r.URL.Path), ".php")
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	if action == "" {
		action = strings.ToLower(strings.TrimSpace(stringValue(body["action"])))
	}
	if r.URL.Path == "/api/bangumi_callback.php" {
		return "user.bind_bangumi", "user", auditTargetID(body, response), true
	}
	if r.URL.Path == "/api/qq_callback.php" || r.URL.Path == "/api/discord_callback.php" {
		return "user.login", "user", auditTargetID(body, response), true
	}
	if r.URL.Path == "/api/auth.php" {
		mapped := map[string]string{
			"login_local": "user.login", "logout": "user.logout", "register_local": "user.register",
			"send_register_code": "user.send_register_code", "send_password_reset_code": "user.send_password_reset_code",
			"reset_password": "user.reset_password", "change_password": "user.change_password", "set_password": "user.set_password",
			"send_code": "user.send_code", "bind_email": "user.bind_email", "unbind_email": "user.unbind_email",
			"update_profile": "user.update_profile", "update_display_club": "user.update_display_club",
			"update_membership_application_email_preference": "user.update_membership_application_email_preference",
			"update_language_preference":                     "user.update_language_preference", "bind_qq": "user.bind_qq", "bind_discord": "user.bind_discord",
			"unbind_qq": "user.unbind_qq", "unbind_discord": "user.unbind_discord", "unbind_bangumi": "user.unbind_bangumi",
			"oauth_send_code": "user.oauth_send_code", "oauth_link_existing": "user.oauth_link_existing",
			"oauth_transfer_provider": "user.oauth_provider_transfer",
		}
		mappedAction := mapped[action]
		if mappedAction == "" {
			return "", "", nil, false
		}
		return mappedAction, "user", auditTargetID(body, response), true
	}
	if action == "" && r.Method == http.MethodGet {
		return "", "", nil, false
	}
	if action == "export" || isAuditReadAction(action) {
		return "", "", nil, false
	}
	if mappedAction, mappedTarget := compatibilityAuditAction(r.URL.Path, action, body); mappedAction != "" {
		return mappedAction, mappedTarget, auditTargetID(body, response), true
	}

	var auditAction, targetType string
	switch name {
	case "users":
		targetType = "user"
		switch action {
		case "delete":
			auditAction = "users.ban"
		case "update":
			if positiveAuditInt(body["is_audit"]) == 0 && body["is_audit"] != nil {
				auditAction = "users.revoke_audit_reviewer"
			} else if body["status"] != nil {
				auditAction = "users.ban"
			} else {
				auditAction = "users.update"
			}
		}
	case "membership":
		auditAction, targetType = "membership."+action, "club_membership"
	case "club_codes":
		targetType = "club_verification_codes"
		auditAction = map[string]string{"generate": "generate_club_code", "revoke": "revoke_club_code", "redeem": "redeem_club_code"}[action]
	case "club_comments":
		targetType = "club_comments"
		auditAction = map[string]string{"delete": "delete_club_comment", "add": "club_comment.add"}[action]
	case "club_recommendations":
		targetType = "club_recommendations"
		auditAction = map[string]string{"add": "add_recommendation", "remove": "remove_recommendation", "reorder": "reorder_recommendations"}[action]
	case "club_moe_king":
		targetType, auditAction = "club_moe_kings", "club_moe_king."+action
	case "star_unions":
		targetType, auditAction = "star_union", "star_union."+action
	case "announcements":
		targetType, auditAction = "announcement", "announcement."+action
	case "galonly":
		targetType, auditAction = "galonly_application", "galonly."+action
	case "galonly_staff":
		targetType, auditAction = "galonly_staff_application", "galonly_staff."+action
	case "vote_projects":
		targetType, auditAction = "vote_projects", "vote_project."+action
	case "vote_nominations":
		targetType = "vote_entries"
		if action == "submit" || action == "nominate" {
			auditAction = "vote_nomination.submit"
		} else {
			auditAction = "vote_entry." + action
		}
	case "vote_stages", "moe_stages", "twelve_rounds":
		targetType, auditAction = "vote_stages", "vote_stage."+action
	case "vote_votes", "moe_votes", "twelve_votes":
		targetType = "vote_stages"
		if action == "cast" || action == "vote" {
			auditAction = "vote.cast"
		} else {
			auditAction = "vote." + action
		}
	case "vote_matches", "moe_matches":
		targetType, auditAction = "vote_stages", "vote_match."+action
	case "recognition_credentials", "recognition_events", "recognition_admin", "recognition_programs", "recognition_participate", "quiz_hub":
		targetType, auditAction = "recognition_program", "recog_"+action
	case "posts":
		targetType, auditAction = "forum_post", "forum."+action
	case "projects", "project_items", "project_participations":
		targetType, auditAction = "project", "project."+action
	case "publications", "manuscripts", "publication_previews":
		targetType, auditAction = "column_article", "column."+action
	case "wiki":
		targetType, auditAction = "wiki", "wiki."+action
	case "avatar":
		targetType, auditAction = "user", "user.change_avatar"
	case "user_banner":
		targetType, auditAction = "user", "user.change_banner"
	default:
		if action == "" {
			action = strings.ToLower(r.Method)
		}
		targetType, auditAction = name, name+"."+action
	}
	if auditAction == "" || strings.HasSuffix(auditAction, ".") {
		return "", "", nil, false
	}
	return auditAction, targetType, auditTargetID(body, response), true
}

func compatibilityAuditAction(requestPath, action string, body map[string]any) (string, string) {
	switch requestPath {
	case "/api/bangumi_callback.php":
		return "user.bind_bangumi", "user"
	case "/api/bot.php":
		if action == "create_token" || action == "issue_token" || action == "bot_tokens_create" {
			return "bot_token.create", "club_bot_tokens"
		}
		if action == "revoke_token" || action == "delete_token" || action == "bot_tokens_revoke" {
			return "bot_token.revoke", "club_bot_tokens"
		}
	case "/api/badge_image.php":
		return "recog_badge_image_uploaded", "recognition_badge"
	case "/api/quiz_image.php":
		return "recog_quiz_image_uploaded", "recognition_quiz"
	case "/api/submission_image.php":
		return "recog_submission_image_uploaded", "recognition_submission"
	case "/api/quiz_hub.php":
		switch action {
		case "shared_upload":
			return "recog_quiz_share_uploaded", "quiz_share"
		case "shared_delete":
			return "recog_quiz_share_deleted", "quiz_share"
		}
	case "/api/toggle_visibility.php":
		return "club.toggle_visibility", "club"
	case "/api/recognition_admin.php":
		switch action {
		case "review":
			decision := strings.ToLower(strings.TrimSpace(stringValue(body["decision"])))
			if decision != "" {
				return "recog_submission_" + auditTrim(decision, 32), "recognition_submission"
			}
		case "claim_generate":
			return "recog_claim_generated", "recognition_program"
		case "import_participants":
			return "recog_participants_imported", "recognition_program"
		}
	case "/api/recognition_credentials.php":
		switch action {
		case "set_visibility":
			return "recog_credential_visibility", "recognition_credential"
		case "revoke":
			return "recog_credential_revoked", "recognition_credential"
		case "grant":
			return "recog_credential_issued", "recognition_credential"
		}
	case "/api/recognition_events.php":
		switch action {
		case "quiz_sync":
			return "recog_quiz_sync", "recognition_program"
		case "connector_create":
			return "recog_connector_created", "recognition_connector"
		case "connector_revoke":
			return "recog_connector_revoked", "recognition_connector"
		}
	case "/api/recognition_programs.php":
		switch action {
		case "create":
			return "recog_program_created", "recognition_program"
		case "update":
			return "recog_program_updated", "recognition_program"
		case "publish":
			return "recog_program_published", "recognition_program"
		case "set_status":
			status := strings.ToLower(strings.TrimSpace(stringValue(body["status"])))
			if status != "" {
				return "recog_program_status_" + auditTrim(status, 32), "recognition_program"
			}
		case "badge_create":
			return "recog_badge_created", "recognition_badge"
		case "badge_update":
			return "recog_badge_updated", "recognition_badge"
		}
	case "/api/vote_projects.php", "/api/moe_contests.php", "/api/twelve_contests.php":
		if action == "share" || action == "share_token_issue" {
			return "vote_project.share_token_issue", "vote_projects"
		}
	case "/api/vote_votes.php", "/api/moe_votes.php", "/api/twelve_votes.php":
		if action == "cast" {
			return "vote.cast", "vote_stages"
		}
	case "/api/vote_matches.php", "/api/moe_matches.php":
		if action == "generate" {
			return "vote_match.generate", "vote_stages"
		}
	}
	return "", ""
}

func isAuditReadAction(action string) bool {
	switch action {
	case "list", "get", "read", "load", "me", "stats", "summary", "issues", "pending", "members", "my", "my_events", "my_nominations", "my_unions", "active", "search", "config", "oauth_config", "oauth_pending", "login_state", "eligibility", "capability", "map_public", "map_admin", "map_state", "public":
		return true
	default:
		return false
	}
}

func sanitizeAuditDetails(input map[string]any) map[string]any {
	output := make(map[string]any, len(input))
	for key, value := range input {
		if key == "_context" || isSensitiveAuditKey(key) {
			continue
		}
		if safe, keep := safeAuditValue(value); keep {
			output[auditTrim(key, 64)] = safe
		}
	}
	return output
}

func isSensitiveAuditKey(key string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "-", "_"), " ", "_"))
	for _, part := range []string{"password", "passwd", "secret", "token", "credential", "authorization", "cookie", "session", "captcha", "verification_code", "access_code", "refresh_code"} {
		if strings.Contains(normalized, part) {
			return true
		}
	}
	return normalized == "code" || normalized == "otp" || normalized == "query" || normalized == "request_body"
}

func safeAuditDetails(r *http.Request, body map[string]any, response []byte) map[string]any {
	details := map[string]any{}
	for _, key := range []string{"id", "user_id", "club_id", "country", "event_id", "application_id", "membership_id", "project_id", "stage_id", "pool_id", "program_id", "submission_id", "union_id", "phase", "vote", "decision", "status", "result", "provider", "count", "existing_count", "guest", "public_visibility", "duplicate", "mail_sent", "found", "fields", "updated_fields", "role", "old_role", "new_role", "name", "title"} {
		if value, ok := body[key]; ok {
			if safe, keep := safeAuditValue(value); keep {
				details[key] = safe
			}
		}
		if value := r.URL.Query().Get(key); value != "" {
			details[key] = auditTrim(value, 255)
		}
	}
	var decoded map[string]any
	if json.Unmarshal(response, &decoded) == nil {
		for _, key := range []string{"id", "user_id", "club_id", "application_id", "membership_id", "project_id", "stage_id", "pool_id", "program_id", "submission_id", "union_id", "phase", "vote", "decision", "status", "result", "provider", "count", "mail_sent", "found"} {
			if value, ok := decoded[key]; ok {
				if safe, keep := safeAuditValue(value); keep {
					details[key] = safe
				}
			}
		}
	}
	return details
}

func safeAuditValue(value any) (any, bool) {
	switch typed := value.(type) {
	case nil, bool:
		return typed, true
	case float64:
		if typed < -1e9 || typed > 1e9 {
			return nil, false
		}
		return typed, true
	case string:
		return auditTrim(typed, 255), true
	case []any:
		if len(typed) > 50 {
			return nil, false
		}
		result := make([]any, 0, len(typed))
		for _, item := range typed {
			if safe, keep := safeAuditValue(item); keep {
				result = append(result, safe)
			}
		}
		return result, true
	default:
		return nil, false
	}
}

func auditTargetID(body map[string]any, response []byte) *int64 {
	for _, key := range []string{"id", "target_id", "application_id", "membership_id", "project_id", "stage_id", "program_id", "submission_id", "union_id", "club_id", "user_id"} {
		if id := positiveAuditInt(body[key]); id > 0 {
			return &id
		}
	}
	var decoded map[string]any
	if json.Unmarshal(response, &decoded) == nil {
		for _, key := range []string{"id", "target_id", "application_id", "membership_id", "project_id", "stage_id", "program_id", "submission_id", "union_id", "club_id", "user_id"} {
			if id := positiveAuditInt(decoded[key]); id > 0 {
				return &id
			}
		}
	}
	return nil
}

func positiveAuditInt(value any) int64 {
	switch typed := value.(type) {
	case int:
		return int64(typed)
	case int64:
		return typed
	case float64:
		return int64(typed)
	case string:
		value, _ := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		return value
	default:
		return 0
	}
}

func auditTrim(value string, max int) string {
	runes := []rune(value)
	if len(runes) > max {
		return string(runes[:max])
	}
	return value
}
