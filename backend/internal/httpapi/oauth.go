package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/integrations/mail"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sessionstore"
	"golang.org/x/crypto/bcrypt"
)

type oauthProfile struct {
	Provider     string
	Subject      string
	Username     string
	Nickname     string
	Avatar       string
	Email        string
	UnionID      string
	AccessToken  string
	RefreshToken string
	ExpiresIn    int64
}

func (s *Server) authOAuth(w http.ResponseWriter, r *http.Request, action string) {
	switch action {
	case "oauth_config":
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		writeJSON(w, map[string]any{"success": true, "qq_configured": s.cfg.QQAppID != "" && s.cfg.QQAppSecret != "", "discord_configured": s.cfg.DiscordClientID != "" && s.cfg.DiscordClientSecret != "", "bangumi_configured": s.cfg.BangumiClientID != "" && s.cfg.BangumiClientSecret != ""})
	case "qq_auth", "discord_auth", "bangumi_auth":
		s.oauthBegin(w, r, strings.TrimSuffix(action, "_auth"))
	case "oauth_pending":
		s.oauthPending(w, r)
	case "oauth_send_code":
		s.oauthSendCode(w, r)
	case "oauth_verify_code":
		s.oauthVerifyCode(w, r)
	case "oauth_complete_account":
		s.oauthCompleteAccount(w, r)
	case "oauth_link_existing":
		s.oauthLinkExisting(w, r)
	case "oauth_transfer_provider":
		s.oauthTransferProvider(w, r)
	case "oauth_cancel":
		s.oauthCancel(w, r)
	case "bind_qq", "bind_discord":
		writeJSONStatus(w, http.StatusGone, map[string]any{"success": false, "code": "OAUTH_BIND_REQUIRED", "message": "请通过第三方授权页面完成绑定"})
	case "unbind_qq", "unbind_discord", "unbind_bangumi":
		s.oauthUnbind(w, r, strings.TrimSuffix(strings.TrimPrefix(action, "unbind_"), ""))
	}
}

func (s *Server) oauthBegin(w http.ResponseWriter, r *http.Request, provider string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	if provider == "bangumi" && s.cfg.BangumiClientID == "" {
		s.oauthRedirect(w, r, "user.html?tab=account", "error", "Bangumi OAuth 未配置")
		return
	}
	if provider == "qq" && (s.cfg.QQAppID == "" || s.cfg.QQAppSecret == "") {
		s.oauthRedirect(w, r, "login.html", "error", "QQ OAuth 未配置")
		return
	}
	if provider == "discord" && (s.cfg.DiscordClientID == "" || s.cfg.DiscordClientSecret == "") {
		s.oauthRedirect(w, r, "login.html", "error", "Discord OAuth 未配置")
		return
	}
	mode := r.URL.Query().Get("mode")
	if mode != "bind" {
		mode = "login"
	}
	if mode == "bind" {
		if _, ok := s.loggedInUserID(r); !ok {
			s.oauthRedirect(w, r, "login.html", "error", "请先登录再绑定"+providerLabel(provider))
			return
		}
	}
	session, isNew, err := s.oauthSession(r)
	if err != nil {
		s.oauthRedirect(w, r, "login.html", "error", "登录服务暂时不可用")
		return
	}
	state, err := randomToken(32)
	if err != nil {
		s.oauthRedirect(w, r, "login.html", "error", "登录服务暂时不可用")
		return
	}
	returnTo := safeReturnTo(r.URL.Query().Get("return_to"), map[string]string{"qq": "index.html", "discord": "index.html", "bangumi": "user.html?tab=account"}[provider])
	if session.Payload == nil {
		session.Payload = map[string]any{}
	}
	session.Payload[provider+"_state"] = state
	session.Payload["oauth_provider"] = provider
	session.Payload["oauth_mode"] = mode
	session.Payload["oauth_return_to"] = returnTo
	session.Payload["oauth_started_at"] = time.Now().Unix()
	if err := s.sessions.Store.Save(r.Context(), session); err != nil {
		s.oauthRedirect(w, r, returnTo, "error", "登录服务暂时不可用")
		return
	}
	if isNew {
		s.sessions.SetCookie(w, session.ID)
	}
	authURL := s.providerAuthURL(provider, state, mode)
	if authURL == "" {
		s.oauthRedirect(w, r, returnTo, "error", "OAuth 配置无效")
		return
	}
	http.Redirect(w, r, authURL, http.StatusFound)
}

func (s *Server) oauthCallback(w http.ResponseWriter, r *http.Request, provider string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	session, err := s.oauthSessionExisting(r)
	if err != nil || session == nil {
		s.oauthRedirect(w, r, "login.html", "error", "授权流程已失效，请重新开始")
		return
	}
	returnTo := safeReturnTo(stringPayload(session.Payload, "oauth_return_to"), "index.html")
	state := r.URL.Query().Get("state")
	expected := stringPayload(session.Payload, provider+"_state")
	mode := stringPayload(session.Payload, "oauth_mode")
	if state == "" || expected == "" || !hmac.Equal([]byte(state), []byte(expected)) {
		s.oauthClearContext(r.Context(), session)
		s.oauthRedirect(w, r, returnTo, "error", "授权流程已失效，请重新开始")
		return
	}
	if started := int64Value(session.Payload["oauth_started_at"]); started > 0 && time.Now().Unix()-started > 600 {
		s.oauthClearContext(r.Context(), session)
		s.oauthRedirect(w, r, returnTo, "error", "授权流程已过期，请重新开始")
		return
	}
	// Consume the state before the provider request. A replay can never repeat
	// the account-linking side effect even if the upstream times out later.
	s.oauthClearContext(r.Context(), session)
	if r.URL.Query().Get("error") != "" {
		s.oauthRedirect(w, r, returnTo, "error", "授权被取消")
		return
	}
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		s.oauthRedirect(w, r, returnTo, "error", "授权返回参数不完整")
		return
	}
	profile, err := s.exchangeOAuth(r.Context(), provider, code)
	if err != nil || profile.Subject == "" {
		s.oauthRedirect(w, r, returnTo, "error", providerLabel(provider)+"授权失败")
		return
	}
	if provider == "bangumi" {
		s.oauthBangumiBind(w, r, session, returnTo, profile)
		return
	}
	if mode == "bind" {
		s.oauthBindProfile(w, r, session, returnTo, profile)
		return
	}
	var ownerID int64
	if s.db == nil || s.db.QueryRowContext(r.Context(), "SELECT id FROM users WHERE "+providerColumn(provider)+" = ? AND status = 'active' LIMIT 1", profile.Subject).Scan(&ownerID) == nil {
		if err := s.loginExistingOAuth(r.Context(), w, r, ownerID); err != nil {
			s.oauthRedirect(w, r, returnTo, "error", "登录服务暂时不可用")
			return
		}
		s.oauthRedirect(w, r, returnTo, "success", providerLabel(provider)+"登录成功")
		return
	}
	if session.Payload == nil {
		session.Payload = map[string]any{}
	}
	session.Payload["oauth_pending"] = map[string]any{"provider": provider, "flow": "new_login", "subject": profile.Subject, "union_id": profile.UnionID, "username": profile.Username, "avatar_url": profile.Avatar, "return_to": returnTo, "verified": false}
	if err := s.sessions.Store.Save(r.Context(), session); err != nil {
		s.oauthRedirect(w, r, returnTo, "error", "登录服务暂时不可用")
		return
	}
	s.oauthRedirect(w, r, "login.html", "pending", "")
}

func (s *Server) oauthBindProfile(w http.ResponseWriter, r *http.Request, session *sessionstore.Session, returnTo string, profile oauthProfile) {
	userID := session.UserID
	if userID == nil {
		s.oauthRedirect(w, r, "login.html", "error", "请先登录再绑定")
		return
	}
	var ownerID int64
	err := s.db.QueryRowContext(r.Context(), "SELECT id FROM users WHERE "+providerColumn(profile.Provider)+" = ? LIMIT 1", profile.Subject).Scan(&ownerID)
	if err == nil && ownerID != *userID {
		s.oauthRedirect(w, r, "login.html", "provider-conflict", "")
		return
	}
	if err == nil {
		s.oauthRedirect(w, r, returnTo, "success", providerLabel(profile.Provider)+"已绑定")
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE users SET "+providerColumn(profile.Provider)+" = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", profile.Subject, *userID); err != nil {
		s.oauthRedirect(w, r, returnTo, "error", "绑定失败")
		return
	}
	s.oauthRedirect(w, r, returnTo, "success", providerLabel(profile.Provider)+"绑定成功")
}

func (s *Server) oauthPending(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	session, err := s.oauthSessionExisting(r)
	if err != nil || session == nil {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "OAUTH_PENDING_NOT_FOUND", "message": "没有找到待完成的授权，请重新登录"})
		return
	}
	pending, ok := session.Payload["oauth_pending"].(map[string]any)
	if !ok || pending == nil {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "OAUTH_PENDING_NOT_FOUND", "message": "没有找到待完成的授权，请重新登录"})
		return
	}
	provider := stringValue(pending["provider"])
	writeJSON(w, map[string]any{"success": true, "pending": true, "flow": stringValue(pending["flow"]), "provider": provider, "provider_label": providerLabel(provider), "display_name": stringValue(pending["username"]), "avatar": stringValue(pending["avatar_url"]), "return_to": safeReturnTo(stringValue(pending["return_to"]), "index.html")})
}

func (s *Server) oauthSendCode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	session, err := s.oauthSessionExisting(r)
	if err != nil || session == nil {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "OAUTH_PENDING_NOT_FOUND", "message": "授权状态已失效，请重新登录"})
		return
	}
	pending, ok := session.Payload["oauth_pending"].(map[string]any)
	if !ok {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "OAUTH_PENDING_NOT_FOUND", "message": "授权状态已失效，请重新登录"})
		return
	}
	var input struct {
		Email string `json:"email"`
	}
	if decodeJSON(r, &input, 64<<10) != nil {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "code": "EMAIL_INVALID", "message": "邮箱格式不正确"})
		return
	}
	input.Email = strings.ToLower(strings.TrimSpace(input.Email))
	if !validEmail(input.Email) {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "code": "EMAIL_INVALID", "message": "邮箱格式不正确"})
		return
	}
	code, _ := sixDigitCode()
	pending["email"] = input.Email
	pending["code_hash"] = oauthCodeHash(session.ID, code, s.cfg.SessionSecret)
	pending["code_expires_at"] = time.Now().Add(5 * time.Minute).Unix()
	pending["attempts"] = 0
	pending["verified"] = false
	if err := s.sessions.Store.Save(r.Context(), session); err != nil || s.mailer.Send(r.Context(), mail.Message{To: input.Email, Subject: "社交账号登录验证码", Body: "您的验证码是：" + code + "\n\n验证码 5 分钟内有效。如果不是您本人操作，请忽略此邮件。\n"}) != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "code": "OAUTH_CODE_SEND_FAILED", "message": "验证码发送失败，请稍后再试"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "验证码已发送至 " + maskEmail(input.Email), "expires_in": 300})
}

func (s *Server) oauthVerifyCode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	session, err := s.oauthSessionExisting(r)
	if err != nil || session == nil {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "OAUTH_PENDING_NOT_FOUND", "message": "授权状态已失效，请重新登录"})
		return
	}
	pending, ok := session.Payload["oauth_pending"].(map[string]any)
	if !ok {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "OAUTH_PENDING_NOT_FOUND", "message": "授权状态已失效，请重新登录"})
		return
	}
	var input struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}
	if decodeJSON(r, &input, 64<<10) != nil {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "code": "OAUTH_CODE_INVALID", "message": "验证码无效或已过期"})
		return
	}
	if input.Email != "" && strings.ToLower(strings.TrimSpace(input.Email)) != stringValue(pending["email"]) {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "code": "OAUTH_EMAIL_MISMATCH", "message": "验证码与当前邮箱不匹配"})
		return
	}
	if intValue(pending["attempts"]) >= 5 || time.Now().Unix() >= int64Value(pending["code_expires_at"]) || !hmac.Equal([]byte(stringValue(pending["code_hash"])), []byte(oauthCodeHash(session.ID, strings.TrimSpace(input.Code), s.cfg.SessionSecret))) {
		pending["attempts"] = intValue(pending["attempts"]) + 1
		_ = s.sessions.Store.Save(r.Context(), session)
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "code": "OAUTH_CODE_INVALID", "message": "验证码无效或已过期"})
		return
	}
	pending["verified"] = true
	pending["code_hash"] = nil
	_ = s.sessions.Store.Save(r.Context(), session)
	existing := false
	var id int64
	if s.db.QueryRowContext(r.Context(), "SELECT id FROM users WHERE email = ? AND status = 'active' LIMIT 1", stringValue(pending["email"])).Scan(&id) == nil {
		existing = true
	}
	writeJSON(w, map[string]any{"success": true, "email_exists": existing, "next": map[bool]string{true: "choose_existing", false: "set_password"}[existing]})
}

func (s *Server) oauthCompleteAccount(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	session, err := s.oauthSessionExisting(r)
	if err != nil || session == nil {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "OAUTH_PENDING_NOT_FOUND", "message": "授权状态已失效，请重新登录"})
		return
	}
	pending, ok := session.Payload["oauth_pending"].(map[string]any)
	if !ok || pending["verified"] != true {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "code": "OAUTH_EMAIL_VERIFICATION_REQUIRED", "message": "请先验证邮箱验证码"})
		return
	}
	var input struct{ Email, Password, PasswordConfirmation string }
	_ = decodeJSON(r, &input, 1<<20)
	input.Email = strings.ToLower(strings.TrimSpace(input.Email))
	if input.Email != stringValue(pending["email"]) || len(input.Password) < 6 || len(input.Password) > 128 || input.Password != input.PasswordConfirmation {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "code": "PASSWORD_INVALID", "message": "账号信息无效"})
		return
	}
	hash, err := bcryptHash(input.Password)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "账号创建失败，请稍后再试"})
		return
	}
	provider := stringValue(pending["provider"])
	if !validOAuthProvider(provider) {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "OAUTH_PROVIDER_INVALID", "message": "授权提供方无效"})
		return
	}
	username := oauthUsername(provider, stringValue(pending["subject"]))
	column := providerColumn(provider)
	result, err := s.db.ExecContext(r.Context(), "INSERT INTO users (username, nickname, password_hash, role, status, avatar_url, email, email_verified_at, credentials_completed_at, created_at, updated_at, last_login_at, "+column+") VALUES (?, ?, ?, 'visitor', 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)", username, firstNonEmpty(stringValue(pending["username"]), username), hash, stringValue(pending["avatar_url"]), input.Email, stringValue(pending["subject"]))
	if err != nil {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "OAUTH_ACCOUNT_CREATE_FAILED", "message": "账号创建失败，请稍后再试"})
		return
	}
	userID, err := result.LastInsertId()
	delete(session.Payload, "oauth_pending")
	if err != nil || s.loginExistingOAuth(r.Context(), w, r, userID) != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "登录态创建失败，请稍后再试"})
		return
	}
	user, _ := s.findUser(r.Context(), userID)
	writeJSON(w, map[string]any{"success": true, "message": "账号创建成功", "redirect_to": safeReturnTo(stringValue(pending["return_to"]), "index.html"), "user": s.publicUser(r.Context(), user)})
}

func (s *Server) oauthLinkExisting(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	session, err := s.oauthSessionExisting(r)
	if err != nil || session == nil {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "授权状态已失效，请重新登录"})
		return
	}
	pending, ok := session.Payload["oauth_pending"].(map[string]any)
	if !ok || pending["verified"] != true {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "请先验证邮箱验证码"})
		return
	}
	if !validOAuthProvider(stringValue(pending["provider"])) {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "OAUTH_PROVIDER_INVALID", "message": "授权提供方无效"})
		return
	}
	var input struct {
		Email string `json:"email"`
	}
	_ = decodeJSON(r, &input, 64<<10)
	if strings.ToLower(strings.TrimSpace(input.Email)) != stringValue(pending["email"]) {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "message": "邮箱与已验证的邮箱不匹配"})
		return
	}
	var userID int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT id FROM users WHERE email = ? AND status = 'active' LIMIT 1", input.Email).Scan(&userID); err != nil {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "message": "目标账号当前不可用"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE users SET "+providerColumn(stringValue(pending["provider"]))+" = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND COALESCE("+providerColumn(stringValue(pending["provider"]))+", '') = ''", stringValue(pending["subject"]), userID); err != nil {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "绑定已有账号失败，请稍后再试"})
		return
	}
	delete(session.Payload, "oauth_pending")
	if err := s.loginExistingOAuth(r.Context(), w, r, userID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "登录态创建失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "已绑定到已有账号", "redirect_to": safeReturnTo(stringValue(pending["return_to"]), "index.html")})
}

// oauthTransferProvider completes the email-verified provider-transfer flow
// used by the PHP account bridge. The provider identity is moved atomically:
// the old owner is detached only in the same transaction that binds it to the
// verified target account, so a failed request cannot create two owners.
func (s *Server) oauthTransferProvider(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	session, err := s.oauthSessionExisting(r)
	if err != nil || session == nil {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "PROVIDER_TRANSFER_EXPIRED", "message": "授权状态已失效，请重新绑定"})
		return
	}
	pending, ok := session.Payload["oauth_pending"].(map[string]any)
	if !ok || stringValue(pending["flow"]) != "provider_transfer" || !boolValue(pending["verified"]) {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "OAUTH_EMAIL_VERIFICATION_REQUIRED", "message": "请先验证当前账号邮箱"})
		return
	}
	userID, loggedIn := s.loggedInUserID(r)
	targetID := integerValue(pending["target_user_id"])
	if !loggedIn || targetID <= 0 || userID != targetID {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "OAUTH_PENDING_NOT_FOUND", "message": "授权状态已失效，请重新绑定"})
		return
	}
	provider := stringValue(pending["provider"])
	if provider != "qq" && provider != "discord" {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "OAUTH_PENDING_NOT_FOUND", "message": "授权状态已失效，请重新绑定"})
		return
	}
	if s.db == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "code": "PROVIDER_TRANSFER_FAILED", "message": "第三方账号转移失败，请稍后再试"})
		return
	}
	column := providerColumn(provider)
	subject := stringValue(pending["subject"])
	if subject == "" {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "OAUTH_PENDING_NOT_FOUND", "message": "授权状态已失效，请重新绑定"})
		return
	}
	var sourceID int64
	ownerErr := s.db.QueryRowContext(r.Context(), "SELECT id FROM users WHERE "+column+"=? AND status='active' LIMIT 1", subject).Scan(&sourceID)
	if ownerErr != nil && !isNoRows(ownerErr) {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "code": "PROVIDER_TRANSFER_FAILED", "message": "第三方账号转移失败，请稍后再试"})
		return
	}
	var targetProvider string
	if err := s.db.QueryRowContext(r.Context(), "SELECT COALESCE("+column+",'') FROM users WHERE id=? AND status='active'", targetID).Scan(&targetProvider); err != nil {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "OAUTH_PENDING_NOT_FOUND", "message": "授权状态已失效，请重新绑定"})
		return
	}
	if targetProvider != "" && targetProvider != subject {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "TARGET_PROVIDER_ALREADY_BOUND", "message": "当前账号已绑定其他第三方身份"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "code": "PROVIDER_TRANSFER_FAILED", "message": "第三方账号转移失败，请稍后再试"})
		return
	}
	defer tx.Rollback()
	if sourceID > 0 && sourceID != targetID {
		if _, err = tx.ExecContext(r.Context(), "UPDATE users SET "+column+"=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND "+column+"=?", sourceID, subject); err != nil {
			writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "PROVIDER_CONFLICT", "message": "第三方账号转移失败，请稍后再试"})
			return
		}
	}
	if provider == "qq" {
		_, err = tx.ExecContext(r.Context(), "UPDATE users SET qq_openid=?, qq_unionid=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", subject, nullIfEmpty(stringValue(pending["union_id"])), targetID)
	} else {
		_, err = tx.ExecContext(r.Context(), "UPDATE users SET discord_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", subject, targetID)
	}
	if err != nil {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "PROVIDER_TRANSFER_FAILED", "message": "第三方账号转移失败，请稍后再试"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "code": "PROVIDER_TRANSFER_FAILED", "message": "第三方账号转移失败，请稍后再试"})
		return
	}
	returnTo := safeReturnTo(stringValue(pending["return_to"]), "user.html?tab=account")
	delete(session.Payload, "oauth_pending")
	_ = s.sessions.Store.Save(r.Context(), session)
	writeJSON(w, map[string]any{"success": true, "message": "第三方登录身份已转移到当前账号", "redirect_to": returnTo})
}

func (s *Server) oauthBangumiBind(w http.ResponseWriter, r *http.Request, session *sessionstore.Session, returnTo string, profile oauthProfile) {
	if session.UserID == nil {
		s.oauthRedirect(w, r, "login.html", "error", "请先登录 VNFmap 账号再绑定 Bangumi")
		return
	}
	if s.db == nil {
		s.oauthRedirect(w, r, returnTo, "error", "Bangumi 绑定服务不可用")
		return
	}
	var bound int64
	err := s.db.QueryRowContext(r.Context(), "SELECT vnfmap_user_id FROM bangumi_bindings WHERE bangumi_user_id = ? LIMIT 1", profile.Subject).Scan(&bound)
	if err == nil && bound != *session.UserID {
		s.oauthRedirect(w, r, returnTo, "error", "该 Bangumi 账号已绑定到其他 VNFmap 账号")
		return
	}
	if err == nil {
		s.oauthRedirect(w, r, returnTo, "success", "Bangumi 已绑定")
		return
	}
	if profile.Subject == "" || profile.Username == "" || profile.AccessToken == "" || s.cfg.BangumiTokenKey == "" {
		s.oauthRedirect(w, r, returnTo, "error", "Bangumi 绑定配置不完整，请联系管理员")
		return
	}
	accessCipher, err := sealBangumiToken(s.cfg.BangumiTokenKey, profile.AccessToken)
	if err != nil {
		s.oauthRedirect(w, r, returnTo, "error", "Bangumi 绑定服务不可用")
		return
	}
	refreshCipher := ""
	if profile.RefreshToken != "" {
		refreshCipher, err = sealBangumiToken(s.cfg.BangumiTokenKey, profile.RefreshToken)
		if err != nil {
			s.oauthRedirect(w, r, returnTo, "error", "Bangumi 绑定服务不可用")
			return
		}
	}
	var boundUser int64
	err = s.db.QueryRowContext(r.Context(), "SELECT vnfmap_user_id FROM bangumi_bindings WHERE bangumi_user_id = ? LIMIT 1", profile.Subject).Scan(&boundUser)
	if err == nil && boundUser != *session.UserID {
		s.oauthRedirect(w, r, returnTo, "error", "该 Bangumi 账号已绑定到其他 VNFmap 账号")
		return
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		s.oauthRedirect(w, r, returnTo, "error", "Bangumi 绑定服务不可用")
		return
	}
	var existingUser int64
	var oldRefresh, oldExpiry string
	existingErr := s.db.QueryRowContext(r.Context(), "SELECT vnfmap_user_id, COALESCE(refresh_token_ciphertext,''), COALESCE(token_expires_at,'') FROM bangumi_bindings WHERE vnfmap_user_id = ? LIMIT 1", *session.UserID).Scan(&existingUser, &oldRefresh, &oldExpiry)
	if existingErr != nil && !errors.Is(existingErr, sql.ErrNoRows) {
		s.oauthRedirect(w, r, returnTo, "error", "Bangumi 绑定服务不可用")
		return
	}
	if refreshCipher == "" && existingErr == nil && existingUser == *session.UserID {
		refreshCipher = oldRefresh
	}
	expiresAt := any(nil)
	if profile.ExpiresIn > 0 {
		expiresAt = time.Now().Add(time.Duration(profile.ExpiresIn) * time.Second).Format("2006-01-02 15:04:05")
	} else if oldExpiry != "" && existingErr == nil {
		expiresAt = oldExpiry
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.oauthRedirect(w, r, returnTo, "error", "Bangumi 绑定服务不可用")
		return
	}
	defer tx.Rollback()
	if existingErr == nil {
		_, err = tx.ExecContext(r.Context(), `UPDATE bangumi_bindings SET bangumi_user_id=?, bangumi_username=?, bangumi_nickname=?, access_token_ciphertext=?, refresh_token_ciphertext=?, token_expires_at=?, updated_at=CURRENT_TIMESTAMP WHERE vnfmap_user_id=?`, profile.Subject, profile.Username, profile.Nickname, accessCipher, refreshCipher, expiresAt, *session.UserID)
	} else {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO bangumi_bindings (vnfmap_user_id,bangumi_user_id,bangumi_username,bangumi_nickname,access_token_ciphertext,refresh_token_ciphertext,token_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, *session.UserID, profile.Subject, profile.Username, profile.Nickname, accessCipher, refreshCipher, expiresAt)
	}
	if err != nil {
		s.oauthRedirect(w, r, returnTo, "error", "Bangumi 绑定失败，请稍后再试")
		return
	}
	if err := tx.Commit(); err != nil {
		s.oauthRedirect(w, r, returnTo, "error", "Bangumi 绑定失败，请稍后再试")
		return
	}
	s.oauthRedirect(w, r, returnTo, "success", "Bangumi 绑定成功")
}

func (s *Server) oauthCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	if session, _ := s.oauthSessionExisting(r); session != nil {
		delete(session.Payload, "oauth_pending")
		_ = s.sessions.Store.Save(r.Context(), session)
	}
	writeJSON(w, map[string]any{"success": true, "message": "授权已取消"})
}

func (s *Server) oauthUnbind(w http.ResponseWriter, r *http.Request, provider string) {
	if r.Method != http.MethodPost || !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	if provider == "bangumi" {
		if _, err := s.db.ExecContext(r.Context(), "DELETE FROM bangumi_bindings WHERE vnfmap_user_id = ?", userID); err != nil {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "Bangumi 绑定功能尚未完成数据库初始化"})
			return
		}
	} else {
		var pass, verified, other string
		otherColumn := "discord_id"
		if provider == "discord" {
			otherColumn = "qq_openid"
		}
		if err := s.db.QueryRowContext(r.Context(), "SELECT COALESCE(password_hash, ''), COALESCE(email_verified_at, ''), COALESCE("+otherColumn+", '') FROM users WHERE id = ?", userID).Scan(&pass, &verified, &other); err != nil || pass == "" && verified == "" && other == "" {
			writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "code": "LAST_LOGIN_METHOD", "message": "请先设置密码或绑定其他登录方式，再解绑"})
			return
		}
		if _, err := s.db.ExecContext(r.Context(), "UPDATE users SET "+providerColumn(provider)+" = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", userID); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "解绑失败"})
			return
		}
	}
	writeJSON(w, map[string]any{"success": true, "message": providerLabel(provider) + "已解绑"})
}

func (s *Server) oauthSession(r *http.Request) (*sessionstore.Session, bool, error) {
	session, err := s.oauthSessionExisting(r)
	if err != nil {
		return nil, false, err
	}
	if session != nil {
		return session, false, nil
	}
	if s.sessions == nil || s.sessions.Store == nil {
		return nil, false, errors.New("session store unavailable")
	}
	id, err := randomToken(32)
	if err != nil {
		return nil, false, err
	}
	now := time.Now()
	return &sessionstore.Session{ID: id, Payload: map[string]any{}, ExpiresAt: now.Add(time.Duration(s.cfg.SessionLifetime) * time.Second), Valid: true, IPAddress: clientIP(r), UserAgent: r.UserAgent()}, true, nil
}
func (s *Server) oauthSessionExisting(r *http.Request) (*sessionstore.Session, error) {
	if s.sessions == nil || s.sessions.Store == nil {
		return nil, errors.New("session store unavailable")
	}
	return s.sessions.LoadRequest(r.Context(), r)
}
func (s *Server) oauthClearContext(ctx context.Context, session *sessionstore.Session) {
	delete(session.Payload, "qq_state")
	delete(session.Payload, "discord_state")
	delete(session.Payload, "bangumi_state")
	delete(session.Payload, "oauth_provider")
	delete(session.Payload, "oauth_mode")
	delete(session.Payload, "oauth_started_at")
	_ = s.sessions.Store.Save(ctx, session)
}
func (s *Server) loginExistingOAuth(ctx context.Context, w http.ResponseWriter, r *http.Request, userID int64) error {
	if s.sessions == nil || s.sessions.Store == nil {
		return errors.New("session store unavailable")
	}
	id, err := randomToken(32)
	if err != nil {
		return err
	}
	session := &sessionstore.Session{ID: id, UserID: &userID, Payload: map[string]any{"user_id": userID}, ExpiresAt: time.Now().Add(time.Duration(s.cfg.SessionLifetime) * time.Second), Valid: true, IPAddress: clientIP(r), UserAgent: r.UserAgent()}
	if store, ok := s.sessions.Store.(*sessionstore.Store); ok {
		err = store.SaveReplacingUserSessions(ctx, session)
	} else {
		err = s.sessions.Store.Save(ctx, session)
	}
	if err == nil {
		s.sessions.SetCookie(w, id)
	}
	return err
}

func (s *Server) providerAuthURL(provider, state, mode string) string {
	redirect := s.providerRedirect(provider)
	values := url.Values{"state": {state}, "redirect_uri": {redirect}}
	switch provider {
	case "qq":
		values.Set("response_type", "code")
		values.Set("client_id", s.cfg.QQAppID)
		values.Set("scope", "get_user_info")
		return "https://graph.qq.com/oauth2.0/authorize?" + values.Encode()
	case "discord":
		values.Set("response_type", "code")
		values.Set("client_id", s.cfg.DiscordClientID)
		values.Set("scope", "identify email")
		return "https://discord.com/api/oauth2/authorize?" + values.Encode()
	case "bangumi":
		values.Set("client_id", s.cfg.BangumiClientID)
		values.Set("response_type", "code")
		values.Set("scope", "user:read")
		return "https://bgm.tv/oauth/authorize?" + values.Encode()
	}
	_ = mode
	return ""
}
func (s *Server) providerRedirect(provider string) string {
	configured := map[string]string{"qq": s.cfg.QQRedirectURI, "discord": s.cfg.DiscordRedirectURI, "bangumi": s.cfg.BangumiRedirectURI}[provider]
	if configured != "" {
		return configured
	}
	return strings.TrimRight(s.cfg.SiteURL, "/") + "/api/" + provider + "_callback.php"
}

func (s *Server) exchangeOAuth(ctx context.Context, provider, code string) (oauthProfile, error) {
	switch provider {
	case "qq":
		return exchangeQQ(ctx, s.cfg, code, s.providerRedirect(provider))
	case "discord":
		return exchangeDiscord(ctx, s.cfg, code, s.providerRedirect(provider))
	case "bangumi":
		return exchangeBangumi(ctx, s.cfg, code, s.providerRedirect(provider))
	default:
		return oauthProfile{}, errors.New("unsupported provider")
	}
}

func exchangeQQ(ctx context.Context, cfg config.Config, code, redirect string) (oauthProfile, error) {
	query := url.Values{"grant_type": {"authorization_code"}, "client_id": {cfg.QQAppID}, "client_secret": {cfg.QQAppSecret}, "code": {code}, "redirect_uri": {redirect}}
	text, err := oauthRequestText(ctx, http.MethodGet, "https://graph.qq.com/oauth2.0/token?"+query.Encode(), "", nil)
	if err != nil {
		return oauthProfile{}, err
	}
	values, _ := url.ParseQuery(text)
	access := values.Get("access_token")
	if access == "" {
		return oauthProfile{}, errors.New("QQ token missing")
	}
	openidText, err := oauthRequestText(ctx, http.MethodGet, "https://graph.qq.com/oauth2.0/me?access_token="+url.QueryEscape(access)+"&fmt=json", "", nil)
	if err != nil {
		return oauthProfile{}, err
	}
	openidText = strings.TrimSpace(openidText)
	if i := strings.Index(openidText, "{"); i >= 0 {
		openidText = openidText[i:]
	}
	var open map[string]any
	if json.Unmarshal([]byte(strings.TrimSuffix(openidText, ");")), &open) != nil {
		return oauthProfile{}, errors.New("QQ openid invalid")
	}
	subject := stringValue(open["openid"])
	var info map[string]any
	body, err := oauthRequestText(ctx, http.MethodGet, "https://graph.qq.com/user/get_user_info?access_token="+url.QueryEscape(access)+"&oauth_consumer_key="+url.QueryEscape(cfg.QQAppID)+"&openid="+url.QueryEscape(subject), "", nil)
	if err != nil || json.Unmarshal([]byte(body), &info) != nil {
		return oauthProfile{}, errors.New("QQ profile invalid")
	}
	return oauthProfile{Provider: "qq", Subject: subject, Username: firstNonEmpty(stringValue(info["nickname"]), "QQ用户"), Avatar: firstNonEmpty(stringValue(info["figureurl_qq_2"]), stringValue(info["figureurl_qq_1"]))}, nil
}
func exchangeDiscord(ctx context.Context, cfg config.Config, code, redirect string) (oauthProfile, error) {
	form := url.Values{"client_id": {cfg.DiscordClientID}, "client_secret": {cfg.DiscordClientSecret}, "grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirect}}
	tokenBody, err := oauthRequestText(ctx, http.MethodPost, "https://discord.com/api/oauth2/token", form.Encode(), map[string]string{"Content-Type": "application/x-www-form-urlencoded"})
	if err != nil {
		return oauthProfile{}, err
	}
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if json.Unmarshal([]byte(tokenBody), &token) != nil || token.AccessToken == "" {
		return oauthProfile{}, errors.New("Discord token missing")
	}
	body, err := oauthRequestText(ctx, http.MethodGet, "https://discord.com/api/users/@me", "", map[string]string{"Authorization": "Bearer " + token.AccessToken})
	if err != nil {
		return oauthProfile{}, err
	}
	var user map[string]any
	if json.Unmarshal([]byte(body), &user) != nil {
		return oauthProfile{}, errors.New("Discord profile invalid")
	}
	avatar := ""
	if stringValue(user["avatar"]) != "" {
		avatar = "https://cdn.discordapp.com/avatars/" + stringValue(user["id"]) + "/" + stringValue(user["avatar"]) + ".png"
	}
	return oauthProfile{Provider: "discord", Subject: stringValue(user["id"]), Username: firstNonEmpty(firstNonEmpty(stringValue(user["global_name"]), stringValue(user["username"])), "Discord用户"), Avatar: avatar, Email: stringValue(user["email"])}, nil
}
func exchangeBangumi(ctx context.Context, cfg config.Config, code, redirect string) (oauthProfile, error) {
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {cfg.BangumiClientID}, "client_secret": {cfg.BangumiClientSecret}, "code": {code}, "redirect_uri": {redirect}}
	oauthBase := strings.TrimRight(cfg.BangumiOAuthURL, "/")
	if oauthBase == "" {
		oauthBase = "https://bgm.tv"
	}
	tokenBody, err := oauthRequestText(ctx, http.MethodPost, oauthBase+"/oauth/access_token", form.Encode(), map[string]string{"Content-Type": "application/x-www-form-urlencoded"})
	if err != nil {
		return oauthProfile{}, err
	}
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if json.Unmarshal([]byte(tokenBody), &token) != nil {
		values, parseErr := url.ParseQuery(tokenBody)
		if parseErr != nil {
			return oauthProfile{}, errors.New("Bangumi token invalid")
		}
		token.AccessToken, token.RefreshToken = values.Get("access_token"), values.Get("refresh_token")
	}
	if token.AccessToken == "" {
		return oauthProfile{}, errors.New("Bangumi token missing")
	}
	apiBase := strings.TrimRight(cfg.BangumiAPIURL, "/")
	if apiBase == "" {
		apiBase = "https://api.bgm.tv"
	}
	body, err := oauthRequestText(ctx, http.MethodGet, apiBase+"/v0/me", "", map[string]string{"Authorization": "Bearer " + token.AccessToken})
	if err != nil {
		return oauthProfile{}, err
	}
	var user map[string]any
	if json.Unmarshal([]byte(body), &user) != nil {
		return oauthProfile{}, errors.New("Bangumi profile invalid")
	}
	username := firstNonEmpty(stringValue(user["username"]), stringValue(user["nickname"]))
	return oauthProfile{Provider: "bangumi", Subject: stringValue(user["id"]), Username: username, Nickname: stringValue(user["nickname"]), AccessToken: token.AccessToken, RefreshToken: token.RefreshToken, ExpiresIn: token.ExpiresIn}, nil
}
func oauthRequestText(ctx context.Context, method, endpoint, body string, headers map[string]string) (string, error) {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", "VNFest/1.0")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := (&http.Client{Timeout: 12 * time.Second}).Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("OAuth provider status %d", response.StatusCode)
	}
	limited := io.LimitReader(response.Body, 1<<20)
	data, err := io.ReadAll(limited)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func providerColumn(provider string) string {
	if provider == "discord" {
		return "discord_id"
	}
	if provider == "qq" {
		return "qq_openid"
	}
	return ""
}
func validOAuthProvider(provider string) bool { return provider == "qq" || provider == "discord" }

func bangumiTokenMAC(key, value []byte) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(value)
	return mac.Sum(nil)
}

func bangumiTokenKey(configured string) []byte {
	digest := sha256.Sum256([]byte(configured))
	return digest[:]
}

// The PHP runtime already persists Bangumi tokens in this authenticated
// format. Keeping the exact format lets a PHP rollback read bindings written
// by Go without exposing either token in a response or log.
func sealBangumiToken(configured, plaintext string) (string, error) {
	if strings.TrimSpace(configured) == "" || plaintext == "" {
		return "", errors.New("Bangumi token encryption key or token missing")
	}
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	key := bangumiTokenKey(configured)
	plain := []byte(plaintext)
	ciphertext := make([]byte, len(plain))
	for offset, counter := 0, 0; offset < len(plain); offset, counter = offset+32, counter+1 {
		streamInput := append(append([]byte("vnfest-bangumi-v1|"), nonce...), []byte("|"+strconv.Itoa(counter))...)
		stream := bangumiTokenMAC(key, streamInput)
		end := offset + 32
		if end > len(plain) {
			end = len(plain)
		}
		for i := offset; i < end; i++ {
			ciphertext[i] = plain[i] ^ stream[i-offset]
		}
	}
	tagInput := append(append([]byte("vnfest-bangumi-v1|"), nonce...), append([]byte("|"), ciphertext...)...)
	tag := bangumiTokenMAC(key, tagInput)
	return "v1." + base64.RawURLEncoding.EncodeToString(nonce) + "." + base64.RawURLEncoding.EncodeToString(ciphertext) + "." + base64.RawURLEncoding.EncodeToString(tag), nil
}

func openBangumiToken(configured, encoded string) (string, error) {
	parts := strings.Split(encoded, ".")
	if len(parts) != 4 || parts[0] != "v1" || strings.TrimSpace(configured) == "" {
		return "", errors.New("invalid Bangumi token")
	}
	nonce, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(nonce) != 16 {
		return "", errors.New("invalid Bangumi token nonce")
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", errors.New("invalid Bangumi token ciphertext")
	}
	tag, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil || len(tag) != sha256.Size {
		return "", errors.New("invalid Bangumi token tag")
	}
	key := bangumiTokenKey(configured)
	tagInput := append(append([]byte("vnfest-bangumi-v1|"), nonce...), append([]byte("|"), ciphertext...)...)
	if !hmac.Equal(tag, bangumiTokenMAC(key, tagInput)) {
		return "", errors.New("invalid Bangumi token signature")
	}
	plain := make([]byte, len(ciphertext))
	for offset, counter := 0, 0; offset < len(ciphertext); offset, counter = offset+32, counter+1 {
		streamInput := append(append([]byte("vnfest-bangumi-v1|"), nonce...), []byte("|"+strconv.Itoa(counter))...)
		stream := bangumiTokenMAC(key, streamInput)
		end := offset + 32
		if end > len(ciphertext) {
			end = len(ciphertext)
		}
		for i := offset; i < end; i++ {
			plain[i] = ciphertext[i] ^ stream[i-offset]
		}
	}
	return string(plain), nil
}

func providerLabel(provider string) string {
	return map[string]string{"qq": "QQ", "discord": "Discord", "bangumi": "Bangumi"}[provider]
}
func oauthUsername(provider, subject string) string {
	suffix := subject
	if len(suffix) > 12 {
		suffix = suffix[len(suffix)-12:]
	}
	return "oauth_" + provider + "_" + suffix
}
func randomToken(size int) (string, error) {
	b := make([]byte, size)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func oauthCodeHash(sessionID, code, secret string) string {
	key := secret
	if key == "" {
		key = sessionID
	}
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write([]byte(sessionID + ":" + code))
	return fmt.Sprintf("%x", mac.Sum(nil))
}
func safeReturnTo(candidate, fallback string) string {
	candidate = strings.TrimSpace(candidate)
	if candidate == "" || strings.HasPrefix(candidate, "//") || strings.Contains(candidate, "\\") {
		return fallback
	}
	parsed, err := url.Parse(candidate)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || parsed.Path == "" {
		return fallback
	}
	return strings.TrimPrefix(candidate, "/")
}
func (s *Server) oauthRedirect(w http.ResponseWriter, r *http.Request, returnTo, status, message string) {
	target := safeReturnTo(returnTo, "index.html")
	values := url.Values{"oauth": {status}}
	if message != "" {
		values.Set("message", message)
	}
	separator := "?"
	if strings.Contains(target, "?") {
		separator = "&"
	}
	http.Redirect(w, r, strings.TrimRight(s.cfg.SiteURL, "/")+"/"+target+separator+values.Encode(), http.StatusFound)
}
func stringPayload(payload map[string]any, key string) string {
	if payload == nil {
		return ""
	}
	return stringValue(payload[key])
}
func intValue(value any) int { return int(int64Value(value)) }
func int64Value(value any) int64 {
	switch item := value.(type) {
	case int:
		return int64(item)
	case int64:
		return item
	case float64:
		return int64(item)
	case string:
		n, _ := strconv.ParseInt(item, 10, 64)
		return n
	}
	return 0
}
func bcryptHash(value string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(value), 12)
	return string(hash), err
}
