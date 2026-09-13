package httpapi

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/integrations/mail"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sessionstore"
	"golang.org/x/crypto/bcrypt"
)

type authCodeRow struct {
	Email     string `json:"email"`
	UserID    int64  `json:"user_id,omitempty"`
	Code      string `json:"code"`
	Used      bool   `json:"used"`
	ExpiresAt int64  `json:"expires_at"`
	CreatedAt int64  `json:"created_at"`
	UsedAt    int64  `json:"used_at,omitempty"`
}

type authJSON struct {
	Username                string `json:"username"`
	Password                string `json:"password"`
	Email                   string `json:"email"`
	Code                    string `json:"code"`
	NewPassword             string `json:"new_password"`
	NewPasswordConfirmation string `json:"new_password_confirmation"`
	CurrentPassword         string `json:"current_password"`
	Nickname                string `json:"nickname"`
	ProfileBio              string `json:"profile_bio"`
	MembershipID            int64  `json:"membership_id"`
	Enabled                 *bool  `json:"enabled"`
	Language                string `json:"language"`
}

var authUsernameRE = regexp.MustCompile(`^[A-Za-z0-9_\x{4e00}-\x{9fff}]{2,20}$`)

func (s *Server) authExtended(w http.ResponseWriter, r *http.Request, action string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	limits := map[string]int{"register_local": 5, "send_register_code": 3, "send_password_reset_code": 3, "reset_password": 5, "change_password": 3, "set_password": 5, "send_code": 3, "bind_email": 5}
	if limit, ok := limits[action]; ok && !allowRequest(r, action, limit, time.Minute) {
		rateLimited(w)
		return
	}
	var input authJSON
	if err := decodeJSON(r, &input, 1<<20); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "请求格式无效"})
		return
	}
	input.Email = strings.ToLower(strings.TrimSpace(input.Email))
	input.Username = strings.TrimSpace(input.Username)
	input.Code = strings.TrimSpace(input.Code)
	switch action {
	case "send_register_code":
		s.authSendCode(w, r, input, false)
	case "send_password_reset_code":
		s.authSendCode(w, r, input, true)
	case "reset_password":
		s.authResetPassword(w, r, input)
	case "register_local":
		s.authRegister(w, r, input)
	case "change_password":
		s.authChangePassword(w, r, input, false)
	case "set_password":
		s.authChangePassword(w, r, input, true)
	case "send_code":
		s.authSendBindCode(w, r, input)
	case "bind_email":
		s.authBindEmail(w, r, input)
	case "unbind_email":
		s.authUnbindEmail(w, r)
	case "update_profile":
		s.authUpdateProfile(w, r, input)
	case "update_display_club":
		s.authUpdateDisplayClub(w, r, input)
	case "update_membership_application_email_preference":
		s.authUpdateMembershipEmail(w, r, input)
	case "update_language_preference":
		s.authUpdateLanguage(w, r, input)
	}
}

func (s *Server) authSendCode(w http.ResponseWriter, r *http.Request, input authJSON, reset bool) {
	if !validEmail(input.Email) {
		writeJSON(w, map[string]any{"success": false, "message": "邮箱格式不正确"})
		return
	}
	if s.db == nil || s.files == nil || s.mailer == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "邮件服务不可用"})
		return
	}
	var userID int64
	var username string
	err := s.db.QueryRowContext(r.Context(), "SELECT id, username FROM users WHERE email = ? AND status = 'active' LIMIT 1", input.Email).Scan(&userID, &username)
	found := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "邮件服务暂时不可用"})
		return
	}
	if !reset && found {
		writeJSON(w, map[string]any{"success": false, "message": "该邮箱已被注册"})
		return
	}
	if reset && !found {
		// Match PHP's enumeration-resistant response. Do not send an email.
		writeJSON(w, map[string]any{"success": true, "message": "如果该邮箱已绑定账号，验证码将发送至 " + maskEmail(input.Email)})
		return
	}
	code, err := sixDigitCode()
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "验证码生成失败"})
		return
	}
	rows := []authCodeRow{}
	name := "register_email_codes.json"
	if reset {
		name = "password_reset_codes.json"
	}
	_ = s.files.ReadJSON(r.Context(), name, &rows)
	now := time.Now().Unix()
	filtered := rows[:0]
	for _, row := range rows {
		if row.Email != input.Email || row.Used || row.ExpiresAt <= now {
			filtered = append(filtered, row)
		}
	}
	row := authCodeRow{Email: input.Email, UserID: userID, Code: code, ExpiresAt: now + 300, CreatedAt: now}
	rows = append(filtered, row)
	if err := s.files.WriteJSONAtomic(r.Context(), name, rows); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "验证码保存失败"})
		return
	}
	subject := "邮箱验证码"
	if reset {
		subject = "密码找回验证码"
	}
	body := fmt.Sprintf("您的%s是：%s\n\n验证码 5 分钟内有效。如果不是您本人操作，请忽略此邮件。\n", subject, code)
	if err := s.mailer.Send(r.Context(), mail.Message{To: input.Email, Subject: subject, Body: body}); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "验证码发送失败，请稍后再试"})
		return
	}
	if reset {
		writeJSON(w, map[string]any{"success": true, "message": "如果该邮箱已绑定账号，验证码将发送至 " + maskEmail(input.Email)})
	} else {
		writeJSON(w, map[string]any{"success": true, "message": "验证码已发送至 " + maskEmail(input.Email)})
	}
}

func (s *Server) authRegister(w http.ResponseWriter, r *http.Request, input authJSON) {
	if !authUsernameRE.MatchString(input.Username) {
		writeJSON(w, map[string]any{"success": false, "message": "用户名需为 2-20 位的中文、字母、数字或下划线"})
		return
	}
	if len(input.Password) < 6 || len(input.Password) > 128 {
		writeJSON(w, map[string]any{"success": false, "message": "密码需为 6-128 位"})
		return
	}
	if !validEmail(input.Email) {
		writeJSON(w, map[string]any{"success": false, "message": "邮箱格式不正确"})
		return
	}
	if !sixDigits(input.Code) {
		writeJSON(w, map[string]any{"success": false, "message": "请输入 6 位邮箱验证码"})
		return
	}
	if s.db == nil || s.files == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "注册服务不可用"})
		return
	}
	var exists int
	if err := s.db.QueryRowContext(r.Context(), "SELECT 1 FROM users WHERE username = ? LIMIT 1", input.Username).Scan(&exists); err == nil {
		writeJSON(w, map[string]any{"success": false, "message": "用户名已被注册"})
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "注册服务暂时不可用"})
		return
	}
	if err := s.db.QueryRowContext(r.Context(), "SELECT 1 FROM users WHERE email = ? LIMIT 1", input.Email).Scan(&exists); err == nil {
		writeJSON(w, map[string]any{"success": false, "message": "该邮箱已被注册"})
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "注册服务暂时不可用"})
		return
	}
	var rows []authCodeRow
	_ = s.files.ReadJSON(r.Context(), "register_email_codes.json", &rows)
	idx := -1
	now := time.Now().Unix()
	for i := range rows {
		if rows[i].Email == input.Email && rows[i].Code == input.Code && !rows[i].Used && rows[i].ExpiresAt > now {
			idx = i
			break
		}
	}
	if idx < 0 {
		writeJSON(w, map[string]any{"success": false, "message": "验证码无效或已过期"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(input.Password), 12)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "注册失败，请稍后再试"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "注册失败，请稍后再试"})
		return
	}
	result, err := tx.ExecContext(r.Context(), `INSERT INTO users (username, nickname, password_hash, role, status, avatar_url, email, email_verified_at, credentials_completed_at, created_at, updated_at, last_login_at) VALUES (?, ?, ?, 'visitor', 'active', '', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, input.Username, input.Username, string(hash), input.Email)
	if err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "注册失败，请稍后再试"})
		return
	}
	userID, err := result.LastInsertId()
	if err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "注册失败，请稍后再试"})
		return
	}
	rows[idx].Used, rows[idx].UsedAt = true, now
	if err := tx.Commit(); err != nil || s.files.WriteJSONAtomic(r.Context(), "register_email_codes.json", rows) != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "注册失败，请稍后再试"})
		return
	}
	if err := s.createAuthSession(r.Context(), w, r, userID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "注册成功但登录态创建失败，请重新登录"})
		return
	}
	user, _ := s.findUser(r.Context(), userID)
	writeJSON(w, map[string]any{"success": true, "message": "注册成功", "user": s.publicUser(r.Context(), user)})
}

func (s *Server) authResetPassword(w http.ResponseWriter, r *http.Request, input authJSON) {
	if !validEmail(input.Email) || !sixDigits(input.Code) {
		writeJSON(w, map[string]any{"success": false, "message": "验证码无效或已过期"})
		return
	}
	if len(input.NewPassword) < 6 || len(input.NewPassword) > 128 {
		writeJSON(w, map[string]any{"success": false, "message": "新密码需为 6-128 位"})
		return
	}
	var userID int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT id FROM users WHERE email = ? AND status = 'active' LIMIT 1", input.Email).Scan(&userID); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "验证码无效或已过期"})
		return
	}
	var rows []authCodeRow
	_ = s.files.ReadJSON(r.Context(), "password_reset_codes.json", &rows)
	idx := -1
	now := time.Now().Unix()
	for i := range rows {
		if rows[i].UserID == userID && rows[i].Email == input.Email && rows[i].Code == input.Code && !rows[i].Used && rows[i].ExpiresAt > now {
			idx = i
			break
		}
	}
	if idx < 0 {
		writeJSON(w, map[string]any{"success": false, "message": "验证码无效或已过期"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(input.NewPassword), 12)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "密码重置失败"})
		return
	}
	if _, err = s.db.ExecContext(r.Context(), "UPDATE users SET password_hash = ?, credentials_completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", string(hash), userID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "密码重置失败"})
		return
	}
	if store, ok := s.sessions.Store.(*sessionstore.Store); ok {
		if err = store.InvalidateUserSessions(r.Context(), userID); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "密码重置失败"})
			return
		}
	} else if _, err = s.db.ExecContext(r.Context(), "UPDATE sessions SET is_valid = 0 WHERE user_id = ?", userID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "密码重置失败"})
		return
	}
	rows[idx].Used, rows[idx].UsedAt = true, now
	_ = s.files.WriteJSONAtomic(r.Context(), "password_reset_codes.json", rows)
	writeJSON(w, map[string]any{"success": true, "message": "密码已重置，请使用新密码登录"})
}

func (s *Server) authChangePassword(w http.ResponseWriter, r *http.Request, input authJSON, setOnly bool) {
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	if len(input.NewPassword) < 6 || len(input.NewPassword) > 128 {
		writeJSON(w, map[string]any{"success": false, "message": "新密码需为 6-128 位"})
		return
	}
	if setOnly && input.NewPassword != input.NewPasswordConfirmation {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "code": "PASSWORD_MISMATCH", "message": "两次输入的密码不一致"})
		return
	}
	var current, emailVerified string
	err := s.db.QueryRowContext(r.Context(), "SELECT COALESCE(password_hash, ''), COALESCE(email_verified_at, '') FROM users WHERE id = ?", userID).Scan(&current, &emailVerified)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "密码更新失败"})
		return
	}
	if setOnly {
		if current != "" {
			writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "code": "PASSWORD_ALREADY_SET", "message": "当前账号已有密码，请使用修改密码功能"})
			return
		}
		if emailVerified == "" {
			writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "code": "EMAIL_VERIFICATION_REQUIRED", "message": "请先验证邮箱，再设置密码"})
			return
		}
	} else if !verifyPassword(input.CurrentPassword, current) {
		writeJSON(w, map[string]any{"success": false, "message": "当前密码错误"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(input.NewPassword), 12)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "密码更新失败"})
		return
	}
	query := "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
	if setOnly {
		query = "UPDATE users SET password_hash = ?, credentials_completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND COALESCE(password_hash, '') = '' AND email_verified_at IS NOT NULL"
	}
	result, err := s.db.ExecContext(r.Context(), query, string(hash), userID)
	if err != nil || (setOnly && mustRowsAffected(result) != 1) {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "message": "密码更新失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": map[bool]string{true: "密码设置成功", false: "密码修改成功"}[setOnly]})
}

func (s *Server) authSendBindCode(w http.ResponseWriter, r *http.Request, input authJSON) {
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	if !validEmail(input.Email) {
		writeJSON(w, map[string]any{"success": false, "message": "邮箱格式不正确"})
		return
	}
	var other int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1", input.Email, userID).Scan(&other); err == nil {
		writeJSON(w, map[string]any{"success": false, "message": "该邮箱已被其他账号绑定"})
		return
	}
	code, err := sixDigitCode()
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "验证码生成失败"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE email_verifications SET used = 1 WHERE user_id = ? AND email = ? AND used = 0", userID, input.Email); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "邮箱验证服务不可用"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "INSERT INTO email_verifications (user_id, email, code, expires_at) VALUES (?, ?, ?, ?)", userID, input.Email, code, time.Now().Add(5*time.Minute)); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "邮箱验证服务不可用"})
		return
	}
	if err := s.mailer.Send(r.Context(), mail.Message{To: input.Email, Subject: "邮箱验证码", Body: "您的验证码是：" + code + "\n\n验证码 5 分钟内有效。如果不是您本人操作，请忽略此邮件。\n"}); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "验证码发送失败，请稍后再试"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "验证码已发送至 " + maskEmail(input.Email)})
}

func (s *Server) authBindEmail(w http.ResponseWriter, r *http.Request, input authJSON) {
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	if !validEmail(input.Email) || !sixDigits(input.Code) {
		writeJSON(w, map[string]any{"success": false, "message": "验证码格式不正确"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "邮箱绑定失败"})
		return
	}
	defer tx.Rollback()
	var verificationID int64
	if err = tx.QueryRowContext(r.Context(), "SELECT id FROM email_verifications WHERE user_id = ? AND email = ? AND code = ? AND used = 0 AND expires_at > CURRENT_TIMESTAMP LIMIT 1", userID, input.Email, input.Code).Scan(&verificationID); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "验证码无效或已过期"})
		return
	}
	var other int64
	if err = tx.QueryRowContext(r.Context(), "SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1", input.Email, userID).Scan(&other); err == nil {
		writeJSON(w, map[string]any{"success": false, "message": "该邮箱已被其他账号绑定"})
		return
	}
	if _, err = tx.ExecContext(r.Context(), "UPDATE email_verifications SET used = 1 WHERE id = ?", verificationID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "邮箱绑定失败"})
		return
	}
	if _, err = tx.ExecContext(r.Context(), "UPDATE users SET email = ?, email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", input.Email, userID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "邮箱绑定失败"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "邮箱绑定失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "邮箱绑定成功", "email": input.Email})
}

func (s *Server) authUnbindEmail(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	var password, verified, qq, discord string
	if err := s.db.QueryRowContext(r.Context(), "SELECT COALESCE(password_hash, ''), COALESCE(email_verified_at, ''), COALESCE(qq_openid, ''), COALESCE(discord_id, '') FROM users WHERE id = ?", userID).Scan(&password, &verified, &qq, &discord); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "邮箱解绑失败"})
		return
	}
	if (qq != "" || discord != "") && password != "" && verified != "" {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "code": "EMAIL_REQUIRED", "message": "已完成登录凭证的账号不能解绑邮箱"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE users SET email = NULL, email_verified_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", userID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "邮箱解绑失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "邮箱已解绑"})
}

func (s *Server) authUpdateProfile(w http.ResponseWriter, r *http.Request, input authJSON) {
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	if input.Nickname == "" && input.ProfileBio == "" {
		writeJSON(w, map[string]any{"success": false, "message": "没有需要更新的字段"})
		return
	}
	if input.Nickname != "" && (len([]rune(input.Nickname)) < 1 || len([]rune(input.Nickname)) > 30) {
		writeJSON(w, map[string]any{"success": false, "message": "昵称需为 1-30 个字符"})
		return
	}
	if len([]rune(input.ProfileBio)) > 300 {
		writeJSON(w, map[string]any{"success": false, "message": "个性签名不能超过 300 个字符"})
		return
	}
	if input.Nickname != "" {
		if _, err := s.db.ExecContext(r.Context(), "UPDATE users SET nickname = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", input.Nickname, userID); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "更新失败"})
			return
		}
	}
	if input.ProfileBio != "" {
		if _, err := s.db.ExecContext(r.Context(), "UPDATE users SET profile_bio = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", input.ProfileBio, userID); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "更新失败"})
			return
		}
	}
	writeJSON(w, map[string]any{"success": true, "message": "已更新"})
}

func (s *Server) authUpdateDisplayClub(w http.ResponseWriter, r *http.Request, input authJSON) {
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	if input.MembershipID <= 0 {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "message": "请选择有效的成员身份"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), "UPDATE users SET display_membership_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND EXISTS (SELECT 1 FROM club_memberships WHERE id = ? AND user_id = ? AND status = 'active')", input.MembershipID, userID, input.MembershipID, userID)
	if err != nil || mustRowsAffected(result) != 1 {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "message": "无权设置该成员身份"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "展示社团已更新", "membership_id": input.MembershipID})
}

func (s *Server) authUpdateMembershipEmail(w http.ResponseWriter, r *http.Request, input authJSON) {
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	if input.Enabled == nil {
		writeJSON(w, map[string]any{"success": false, "message": "邮件提醒设置无效"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE users SET membership_application_email_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", boolInt(*input.Enabled), userID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "邮件提醒设置保存失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": map[bool]string{true: "已开启同好会申请邮件提醒", false: "已关闭同好会申请邮件提醒"}[*input.Enabled], "enabled": *input.Enabled})
}

func (s *Server) authUpdateLanguage(w http.ResponseWriter, r *http.Request, input authJSON) {
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	if input.Language != "zh" && input.Language != "ja" {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "message": "语言设置无效"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE users SET language_preference = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", input.Language, userID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "语言设置保存失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "language_preference": input.Language})
}

func (s *Server) createAuthSession(ctx context.Context, w http.ResponseWriter, r *http.Request, userID int64) error {
	if s.sessions == nil || s.sessions.Store == nil {
		return errors.New("session store unavailable")
	}
	sessionID, err := newSessionID()
	if err != nil {
		return err
	}
	session := &sessionstore.Session{ID: sessionID, UserID: &userID, Payload: map[string]any{"user_id": userID}, ExpiresAt: time.Now().Add(time.Duration(s.cfg.SessionLifetime) * time.Second), Valid: true, IPAddress: clientIP(r), UserAgent: r.UserAgent()}
	if store, ok := s.sessions.Store.(*sessionstore.Store); ok {
		if err = store.SaveReplacingUserSessions(ctx, session); err != nil {
			return err
		}
	} else if err = s.sessions.Store.Save(ctx, session); err != nil {
		return err
	}
	s.sessions.SetCookie(w, sessionID)
	return nil
}

func validEmail(value string) bool {
	return strings.Count(value, "@") == 1 && len(value) >= 5 && len(value) <= 255 && !strings.ContainsAny(value, " \t\r\n")
}
func sixDigits(value string) bool { return len(value) == 6 && strings.Trim(value, "0123456789") == "" }
func sixDigitCode() (string, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	n := (uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])) % 1000000
	return fmt.Sprintf("%06d", n), nil
}
func maskEmail(value string) string {
	parts := strings.SplitN(value, "@", 2)
	if len(parts) != 2 || parts[0] == "" {
		return ""
	}
	return string([]rune(parts[0])[0]) + "***@" + parts[1]
}
func mustRowsAffected(result sql.Result) int64 {
	if result == nil {
		return 0
	}
	n, _ := result.RowsAffected()
	return n
}
