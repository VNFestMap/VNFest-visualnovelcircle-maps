package httpapi

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// recognitionCredentials implements the public achievement-library endpoint.
// Credential writes go through the helpers below so that issuing, revoking,
// the durable event, and the notification outbox are committed together.
func (s *Server) recognitionCredentials(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action"))) {
	case "my":
		s.recognitionCredentialsMine(w, r)
	case "verify":
		s.recognitionCredentialVerify(w, r)
	case "set_visibility":
		s.recognitionCredentialVisibility(w, r)
	case "revoke":
		s.recognitionCredentialRevoke(w, r)
	case "grant":
		s.recognitionCredentialGrant(w, r)
	case "club_list":
		s.recognitionCredentialClubList(w, r)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知操作"})
	}
}

type recognitionCredentialRow struct {
	ID, HolderUserID, BadgeID, BadgeVersion, IssuerClubID, ProgramID, ProgramVersionID int64
	IssuerCountry, UID, CredentialType, VerificationLevel, Status                      string
	ConditionSnapshot, EvidenceRefs, RevocationReason                                  sql.NullString
	PublicVisibility                                                                   int64
	IssuedAt, ExpiresAt, RevokedAt                                                     sql.NullString
	SupersededBy                                                                       sql.NullInt64
	BadgeName, BadgeCategory, BadgeImage, ProgramTitle, ProgramType                    string
}

func (s *Server) recognitionCredentialsMine(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	credentials, err := s.fetchRecognitionCredentials(r.Context(), "c.holder_user_id = ?", user.ID, 200)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取成就库失败"})
		return
	}
	active, clubs := 0, map[string]bool{}
	for _, credential := range credentials {
		if credential.Status == "active" {
			active++
			clubs[fmt.Sprintf("%d:%s", credential.IssuerClubID, credential.IssuerCountry)] = true
		}
	}
	writeJSON(w, map[string]any{
		"success":     true,
		"summary":     map[string]any{"total": len(credentials), "active": active, "club_count": len(clubs)},
		"credentials": credentials,
	})
}

func (s *Server) recognitionCredentialVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	if !allowRequest(r, "recog_verify", 60, time.Minute) {
		rateLimited(w)
		return
	}
	uid := strings.TrimSpace(r.URL.Query().Get("uid"))
	if uid == "" {
		writeJSON(w, map[string]any{"success": false, "message": "缺少凭证编号"})
		return
	}
	credentials, err := s.fetchRecognitionCredentials(r.Context(), "c.credential_uid = ?", uid, 1)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "验证服务暂不可用"})
		return
	}
	if len(credentials) == 0 {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "未找到该凭证编号"})
		return
	}
	credential := credentials[0]
	if credential.PublicVisibility == 0 && credential.Status == "active" {
		writeJSON(w, map[string]any{"success": true, "credential": map[string]any{
			"credential_uid": credential.UID, "status": credential.Status, "public_visibility": 0,
			"status_text": "该凭证持有人选择不公开详情",
		}})
		return
	}
	statusText := map[string]string{
		"active": "有效", "expired": "已过期", "revoked": "历史凭证，当前已撤销", "superseded": "已被新版本替代",
	}[credential.Status]
	if statusText == "" {
		statusText = credential.Status
	}
	writeJSON(w, map[string]any{"success": true, "credential": map[string]any{
		"credential_uid":     credential.UID,
		"badge_name":         credential.BadgeName,
		"badge_category":     credential.BadgeCategory,
		"badge_image":        credential.BadgeImage,
		"club_name":          s.recognitionClubName(r.Context(), credential.IssuerClubID, credential.IssuerCountry),
		"program_title":      credential.ProgramTitle,
		"credential_type":    credential.CredentialType,
		"verification_level": credential.VerificationLevel,
		"status":             credential.Status,
		"status_text":        statusText,
		"issued_at":          recognitionNull(credential.IssuedAt),
		"expires_at":         recognitionNull(credential.ExpiresAt),
		"revoked_at":         recognitionNull(credential.RevokedAt),
		"conditions":         recognitionCredentialConditions(credential.ConditionSnapshot),
	}})
}

func (s *Server) recognitionCredentialVisibility(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 1<<20); err != nil || input == nil {
		writeJSON(w, map[string]any{"success": false, "message": "请求数据格式错误"})
		return
	}
	uid := strings.TrimSpace(stringValue(input["credential_uid"]))
	visible := int64(0)
	if boolValue(input["public_visibility"]) {
		visible = 1
	}
	var credentialID, holderID int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT id,holder_user_id FROM recognition_credentials WHERE credential_uid=?", uid).Scan(&credentialID, &holderID); err != nil || holderID != user.ID {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "凭证不存在或不属于你"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE recognition_credentials SET public_visibility=? WHERE id=?", visible, credentialID); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "保存失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true})
}

func (s *Server) recognitionCredentialRevoke(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 1<<20); err != nil || input == nil {
		writeJSON(w, map[string]any{"success": false, "message": "请求数据格式错误"})
		return
	}
	uid, reason := strings.TrimSpace(stringValue(input["credential_uid"])), strings.TrimSpace(stringValue(input["reason"]))
	if reason == "" {
		writeJSON(w, map[string]any{"success": false, "message": "撤销必须填写原因"})
		return
	}
	credential, err := s.recognitionCredentialByUID(r.Context(), uid)
	if errors.Is(err, sql.ErrNoRows) || credential == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "凭证不存在"})
		return
	}
	if user.Role != "super_admin" && !s.recognitionCanIssue(r.Context(), user, credential.IssuerClubID, credential.IssuerCountry) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "只有签发同好会管理员或平台管理员可撤销"})
		return
	}
	if credential.Status != "active" {
		writeJSON(w, map[string]any{"success": false, "message": "凭证当前状态为 " + credential.Status + "，不可撤销"})
		return
	}
	if err := s.revokeRecognitionCredential(r.Context(), credential, reason, user.ID); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": err.Error()})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "凭证已撤销，历史记录保留"})
}

func (s *Server) recognitionCredentialGrant(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 1<<20); err != nil || input == nil {
		writeJSON(w, map[string]any{"success": false, "message": "请求数据格式错误"})
		return
	}
	usernames := stringSlice(input["usernames"], 200)
	programID := integerValue(input["program_id"])
	if len(usernames) == 0 {
		writeJSON(w, map[string]any{"success": false, "message": "请填写至少一个用户名"})
		return
	}
	if len(usernames) > 200 {
		writeJSON(w, map[string]any{"success": false, "message": "单次最多授予 200 人"})
		return
	}
	program, err := s.recognitionProgram(r.Context(), programID)
	if errors.Is(err, sql.ErrNoRows) || program == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "认可项目不存在"})
		return
	}
	if program.Type != "award" && program.Type != "activity" {
		writeJSON(w, map[string]any{"success": false, "message": "人工授予仅支持 award / activity 类型项目"})
		return
	}
	if user.Role != "super_admin" && !s.recognitionCanIssue(r.Context(), user, program.ClubID, program.Country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权为该同好会授予凭证"})
		return
	}
	version, err := s.recognitionVersion(r.Context(), programID, false)
	if err != nil || version == nil {
		writeJSON(w, map[string]any{"success": false, "message": "该项目尚无已发布版本"})
		return
	}
	content, _ := version["content"].(map[string]any)
	rules, _ := content["rules"].(map[string]any)
	award, _ := rules["award"].(map[string]any)
	badgeID := integerValue(award["badge_id"])
	if badgeID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "项目未配置奖励徽章"})
		return
	}
	granted, skipped := 0, []string{}
	for _, username := range usernames {
		target, err := s.findUserByLogin(r.Context(), username)
		if err != nil || target == nil {
			skipped = append(skipped, username)
			continue
		}
		credential, duplicate, err := s.issueRecognitionCredential(r.Context(), recognitionIssueArgs{
			HolderUserID: target.ID, BadgeID: badgeID, IssuerClubID: program.ClubID, IssuerCountry: program.Country,
			ProgramID: program.ID, ProgramVersionID: integerValue(version["id"]), CredentialType: "honor",
			VerificationLevel: "owner_grant", Conditions: []any{"同好会负责人特别授予"}, SourceType: "manual_grant", ActorUserID: user.ID,
		})
		if err != nil {
			skipped = append(skipped, username)
			continue
		}
		if !duplicate && credential != nil {
			granted++
		} else if duplicate {
			skipped = append(skipped, username+"（已持有）")
		}
	}
	writeJSON(w, map[string]any{"success": true, "granted": granted, "skipped": skipped})
}

func (s *Server) recognitionCredentialClubList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	clubID := parsePositiveInt(r.URL.Query().Get("club_id"))
	country := clubCodeCountry(r.URL.Query().Get("country"))
	if user.Role != "super_admin" && !s.recognitionHasRole(r.Context(), user, clubID, country, "auditor") && !s.recognitionCanIssue(r.Context(), user, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	credentials, err := s.fetchRecognitionCredentials(r.Context(), "c.issuer_club_id=? AND c.issuer_country=?", clubID, country, 200)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取凭证失败"})
		return
	}
	for index := range credentials {
		var username, nickname sql.NullString
		_ = s.db.QueryRowContext(r.Context(), "SELECT username,COALESCE(nickname,'') FROM users WHERE id=?", credentials[index].HolderUserID).Scan(&username, &nickname)
		name := stringValue(nickname)
		if name == "" {
			name = stringValue(username)
		}
		credentials[index].HolderName = name
	}
	result := make([]map[string]any, 0, len(credentials))
	for _, credential := range credentials {
		result = append(result, credential.publicMap(true))
	}
	writeJSON(w, map[string]any{"success": true, "credentials": result})
}

func (s *Server) fetchRecognitionCredentials(ctx context.Context, where string, args ...any) ([]recognitionCredentialView, error) {
	limit := 200
	if len(args) > 0 {
		if candidate, ok := args[len(args)-1].(int); ok && candidate > 0 {
			limit = candidate
			args = args[:len(args)-1]
		}
	}
	query := `SELECT c.id,c.credential_uid,c.holder_user_id,c.badge_id,c.badge_version,c.issuer_club_id,c.issuer_country,
        c.program_id,c.program_version_id,c.credential_type,c.verification_level,c.status,c.condition_snapshot,c.evidence_refs,
        c.public_visibility,c.issued_at,c.expires_at,c.revocation_reason,c.revoked_at,c.superseded_by,
        b.name,b.category,b.image_url,p.title,p.type
        FROM recognition_credentials c JOIN recognition_badges b ON b.id=c.badge_id JOIN recognition_programs p ON p.id=c.program_id
        WHERE ` + where + ` ORDER BY c.issued_at DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []recognitionCredentialView{}
	for rows.Next() {
		var row recognitionCredentialRow
		if err := rows.Scan(&row.ID, &row.UID, &row.HolderUserID, &row.BadgeID, &row.BadgeVersion, &row.IssuerClubID, &row.IssuerCountry,
			&row.ProgramID, &row.ProgramVersionID, &row.CredentialType, &row.VerificationLevel, &row.Status, &row.ConditionSnapshot, &row.EvidenceRefs,
			&row.PublicVisibility, &row.IssuedAt, &row.ExpiresAt, &row.RevocationReason, &row.RevokedAt, &row.SupersededBy,
			&row.BadgeName, &row.BadgeCategory, &row.BadgeImage, &row.ProgramTitle, &row.ProgramType); err != nil {
			return nil, err
		}
		result = append(result, row.view())
	}
	return result, rows.Err()
}

type recognitionCredentialView struct {
	ID, HolderUserID, BadgeVersion, IssuerClubID, ProgramID, ProgramVersionID int64
	UID, IssuerCountry, CredentialType, VerificationLevel, Status             string
	PublicVisibility                                                          int64
	IssuedAt, ExpiresAt, RevokedAt                                            sql.NullString
	SupersededBy                                                              sql.NullInt64
	BadgeName, BadgeCategory, BadgeImage, ProgramTitle, ProgramType           string
	ConditionSnapshot                                                         sql.NullString
	Conditions                                                                []any
	HolderName                                                                string
}

func (row recognitionCredentialRow) view() recognitionCredentialView {
	return recognitionCredentialView{ID: row.ID, HolderUserID: row.HolderUserID, BadgeVersion: row.BadgeVersion, IssuerClubID: row.IssuerClubID,
		ProgramID: row.ProgramID, ProgramVersionID: row.ProgramVersionID, UID: row.UID, IssuerCountry: row.IssuerCountry,
		CredentialType: row.CredentialType, VerificationLevel: row.VerificationLevel, Status: row.Status, PublicVisibility: row.PublicVisibility,
		IssuedAt: row.IssuedAt, ExpiresAt: row.ExpiresAt, RevokedAt: row.RevokedAt, SupersededBy: row.SupersededBy,
		BadgeName: row.BadgeName, BadgeCategory: row.BadgeCategory, BadgeImage: row.BadgeImage, ProgramTitle: row.ProgramTitle, ProgramType: row.ProgramType,
		ConditionSnapshot: row.ConditionSnapshot,
		Conditions:        recognitionCredentialConditions(row.ConditionSnapshot)}
}

func (view recognitionCredentialView) publicMap(includeHolder bool) map[string]any {
	result := map[string]any{
		"id": view.ID, "credential_uid": view.UID, "holder_user_id": view.HolderUserID, "badge_version": view.BadgeVersion,
		"issuer_club_id": view.IssuerClubID, "issuer_country": view.IssuerCountry, "program_id": view.ProgramID,
		"program_version_id": view.ProgramVersionID, "credential_type": view.CredentialType, "verification_level": view.VerificationLevel,
		"status": view.Status, "public_visibility": view.PublicVisibility, "issued_at": recognitionNull(view.IssuedAt),
		"expires_at": recognitionNull(view.ExpiresAt), "revoked_at": recognitionNull(view.RevokedAt), "superseded_by": nullableInt(view.SupersededBy),
		"badge_name": view.BadgeName, "badge_category": view.BadgeCategory, "badge_image": view.BadgeImage,
		"program_title": view.ProgramTitle, "program_type": view.ProgramType, "conditions": view.Conditions,
	}
	if includeHolder {
		result["holder_name"] = view.HolderName
	}
	return result
}

func (s *Server) recognitionCredentialByUID(ctx context.Context, uid string) (*recognitionCredentialRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT c.id,c.credential_uid,c.holder_user_id,c.badge_id,c.badge_version,c.issuer_club_id,c.issuer_country,
        c.program_id,c.program_version_id,c.credential_type,c.verification_level,c.status,c.condition_snapshot,c.evidence_refs,
        c.public_visibility,c.issued_at,c.expires_at,c.revocation_reason,c.revoked_at,c.superseded_by,
        b.name,b.category,b.image_url,p.title,p.type
        FROM recognition_credentials c JOIN recognition_badges b ON b.id=c.badge_id JOIN recognition_programs p ON p.id=c.program_id
        WHERE c.credential_uid=? LIMIT 1`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, sql.ErrNoRows
	}
	var row recognitionCredentialRow
	err = rows.Scan(&row.ID, &row.UID, &row.HolderUserID, &row.BadgeID, &row.BadgeVersion, &row.IssuerClubID, &row.IssuerCountry,
		&row.ProgramID, &row.ProgramVersionID, &row.CredentialType, &row.VerificationLevel, &row.Status, &row.ConditionSnapshot, &row.EvidenceRefs,
		&row.PublicVisibility, &row.IssuedAt, &row.ExpiresAt, &row.RevocationReason, &row.RevokedAt, &row.SupersededBy,
		&row.BadgeName, &row.BadgeCategory, &row.BadgeImage, &row.ProgramTitle, &row.ProgramType)
	return &row, err
}

type recognitionExec interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type recognitionIssueArgs struct {
	HolderUserID, BadgeID, IssuerClubID, ProgramID, ProgramVersionID int64
	IssuerCountry, CredentialType, VerificationLevel, SourceType     string
	Conditions                                                       []any
	EvidenceRefs                                                     any
	ExpiresAt                                                        *time.Time
	ActorUserID                                                      int64
}

func (s *Server) issueRecognitionCredential(ctx context.Context, args recognitionIssueArgs) (map[string]any, bool, error) {
	if args.HolderUserID <= 0 || args.BadgeID <= 0 || args.ProgramVersionID <= 0 || args.IssuerClubID <= 0 {
		return nil, false, errors.New("签发参数不完整")
	}
	if args.IssuerCountry == "" {
		args.IssuerCountry = "china"
	}
	if args.CredentialType == "" {
		args.CredentialType = "participation"
	}
	if args.VerificationLevel == "" {
		args.VerificationLevel = "auto"
	}
	var active int64
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM users WHERE id=? AND status='active'", args.HolderUserID).Scan(&active); err != nil || active == 0 {
		return nil, false, errors.New("持有人账号不存在或不可用")
	}
	var badgeName string
	var badgeVersion int64
	if err := s.db.QueryRowContext(ctx, "SELECT name,version FROM recognition_badges WHERE id=?", args.BadgeID).Scan(&badgeName, &badgeVersion); err != nil {
		return nil, false, errors.New("徽章定义不存在")
	}
	var maxIssuance, ttl int64
	var programTitle string
	if err := s.db.QueryRowContext(ctx, "SELECT max_issuance,credential_ttl_days,title FROM recognition_programs WHERE id=?", args.ProgramID).Scan(&maxIssuance, &ttl, &programTitle); err != nil {
		return nil, false, errors.New("认可项目不存在")
	}
	if maxIssuance > 0 {
		var issued int64
		if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM recognition_credentials WHERE program_version_id=? AND badge_id=?", args.ProgramVersionID, args.BadgeID).Scan(&issued); err != nil {
			return nil, false, err
		}
		if issued >= maxIssuance {
			return nil, false, errors.New("该徽章已达限量签发上限")
		}
	}
	if args.ExpiresAt == nil && ttl > 0 {
		expires := time.Now().Add(time.Duration(ttl) * 24 * time.Hour)
		args.ExpiresAt = &expires
	}
	var existingID int64
	var existingUID string
	if err := s.db.QueryRowContext(ctx, "SELECT id,credential_uid FROM recognition_credentials WHERE program_version_id=? AND holder_user_id=? AND badge_id=? AND status='active' LIMIT 1", args.ProgramVersionID, args.HolderUserID, args.BadgeID).Scan(&existingID, &existingUID); err == nil {
		return map[string]any{"id": existingID, "credential_uid": existingUID}, true, nil
	}
	conditionJSON := jsonString(map[string]any{"conditions": args.Conditions, "verification_level": args.VerificationLevel, "source_type": firstNonEmpty(args.SourceType, "auto_rule")})
	evidenceJSON := anyJSONOrNil(args.EvidenceRefs)
	for attempt := 0; attempt < 5; attempt++ {
		uid, err := newRecognitionCredentialUID(s.cfg.RecognitionCredPrefix)
		if err != nil {
			return nil, false, err
		}
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return nil, false, err
		}
		result, execErr := tx.ExecContext(ctx, `INSERT INTO recognition_credentials
            (credential_uid,holder_user_id,badge_id,badge_version,issuer_club_id,issuer_country,program_id,program_version_id,
             credential_type,verification_level,status,condition_snapshot,evidence_refs,public_visibility,expires_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`, uid, args.HolderUserID, args.BadgeID, badgeVersion, args.IssuerClubID, args.IssuerCountry,
			args.ProgramID, args.ProgramVersionID, args.CredentialType, args.VerificationLevel, "active", conditionJSON, evidenceJSON, timeString(args.ExpiresAt))
		if execErr != nil {
			_ = tx.Rollback()
			if recognitionUniqueError(execErr) {
				if err := s.db.QueryRowContext(ctx, "SELECT id,credential_uid FROM recognition_credentials WHERE program_version_id=? AND holder_user_id=? AND badge_id=? AND status='active' LIMIT 1", args.ProgramVersionID, args.HolderUserID, args.BadgeID).Scan(&existingID, &existingUID); err == nil {
					return map[string]any{"id": existingID, "credential_uid": existingUID}, true, nil
				}
				continue
			}
			return nil, false, errors.New("凭证写入失败")
		}
		credentialID, _ := result.LastInsertId()
		if credentialID <= 0 {
			_ = tx.Rollback()
			return nil, false, errors.New("凭证写入失败")
		}
		if _, err = recordRecognitionEventExec(ctx, tx, map[string]any{
			"type": "credential.issued", "idempotency_key": "cred_issue_" + strconvInt(credentialID), "club_id": args.IssuerClubID,
			"country": args.IssuerCountry, "user_id": args.HolderUserID, "program_id": args.ProgramID, "program_version_id": args.ProgramVersionID,
			"badge_id": args.BadgeID, "data": map[string]any{"credential_uid": uid, "verification_level": args.VerificationLevel}, "source_verified": true,
		}); err != nil {
			_ = tx.Rollback()
			return nil, false, err
		}
		payload := map[string]any{"credential_id": credentialID, "credential_uid": uid, "user_id": args.HolderUserID, "badge_name": badgeName, "program_title": programTitle}
		if err = enqueueRecognitionOutboxExec(ctx, tx, "notify_credential_issued", payload); err != nil {
			_ = tx.Rollback()
			return nil, false, err
		}
		if err = tx.Commit(); err != nil {
			return nil, false, err
		}
		return map[string]any{"id": credentialID, "credential_uid": uid, "badge_name": badgeName, "program_title": programTitle, "expires_at": timeString(args.ExpiresAt)}, false, nil
	}
	return nil, false, errors.New("凭证写入失败")
}

func (s *Server) revokeRecognitionCredential(ctx context.Context, credential *recognitionCredentialRow, reason string, actorID int64) error {
	reason = truncateRecognition(reason, 250)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return errors.New("凭证状态保存失败")
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, "UPDATE recognition_credentials SET status='revoked',revocation_reason=?,revoked_at=CURRENT_TIMESTAMP,revoked_by=? WHERE id=? AND status='active'", reason, actorID, credential.ID)
	if err != nil {
		return errors.New("凭证状态保存失败")
	}
	changed, _ := result.RowsAffected()
	if changed == 0 {
		return errors.New("凭证当前状态不可撤销")
	}
	if _, err = recordRecognitionEventExec(ctx, tx, map[string]any{
		"type": "credential.revoked", "idempotency_key": "cred_revoke_" + strconvInt(credential.ID), "club_id": credential.IssuerClubID,
		"country": credential.IssuerCountry, "user_id": credential.HolderUserID, "program_id": credential.ProgramID, "program_version_id": credential.ProgramVersionID,
		"badge_id": credential.BadgeID, "data": map[string]any{"credential_uid": credential.UID, "reason": reason}, "source_verified": true,
	}); err != nil {
		return errors.New("凭证事件保存失败")
	}
	if err = enqueueRecognitionOutboxExec(ctx, tx, "notify_credential_revoked", map[string]any{"credential_id": credential.ID, "user_id": credential.HolderUserID, "badge_name": credential.BadgeName, "reason": reason}); err != nil {
		return errors.New("凭证通知任务保存失败")
	}
	if err := tx.Commit(); err != nil {
		return errors.New("凭证状态保存失败")
	}
	return nil
}

func recordRecognitionEventExec(ctx context.Context, exec recognitionExec, event map[string]any) (bool, error) {
	eventID := strings.TrimSpace(stringValue(event["event_id"]))
	if eventID == "" {
		eventID, _ = newRecognitionEventID()
	}
	if len(eventID) > 64 {
		return false, errors.New("事件编号长度非法")
	}
	idempotency := firstNonEmpty(stringValue(event["idempotency_key"]), eventID)
	typ := strings.TrimSpace(stringValue(event["type"]))
	if !validRecognitionEventType(typ, integerValue(event["club_id"])) {
		return false, errors.New("未知事件类型：" + typ)
	}
	data := anyJSONOrNil(event["data"])
	evidence := anyJSONOrNil(event["evidence_refs"])
	_, err := exec.ExecContext(ctx, `INSERT INTO recognition_events
        (event_id,idempotency_key,schema_version,type,club_id,country,user_id,program_id,program_version_id,badge_id,connector_id,
         occurred_at,data,evidence_refs,source_verified,status,error_message)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'processed','')`, eventID, idempotency, "1.0", typ, nullableID(event["club_id"]),
		firstNonEmpty(stringValue(event["country"]), "china"), nullableID(event["user_id"]), nullableID(event["program_id"]), nullableID(event["program_version_id"]),
		nullableID(event["badge_id"]), nullableID(event["connector_id"]), time.Now().Format("2006-01-02 15:04:05"), data, evidence, boolInt(boolValue(event["source_verified"])))
	if err != nil && recognitionUniqueError(err) {
		return true, nil
	}
	return false, err
}

func enqueueRecognitionOutboxExec(ctx context.Context, exec recognitionExec, taskType string, payload map[string]any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = exec.ExecContext(ctx, "INSERT INTO recognition_outbox(task_type,payload,status,attempts) VALUES(?,?,?,0)", taskType, string(encoded), "pending")
	return err
}

func newRecognitionCredentialUID(prefix string) (string, error) {
	raw := make([]byte, 4)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return firstNonEmpty(prefix, "VNF-CRED-") + time.Now().Format("20060102") + "-" + strings.ToUpper(hex.EncodeToString(raw)), nil
}

func newRecognitionEventID() (string, error) {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return "recog-" + hex.EncodeToString(raw), nil
}

func recognitionCredentialConditions(value sql.NullString) []any {
	if !value.Valid || strings.TrimSpace(value.String) == "" {
		return []any{}
	}
	var document map[string]any
	if json.Unmarshal([]byte(value.String), &document) != nil || document == nil {
		return []any{}
	}
	return anySlice(document["conditions"])
}

func recognitionUniqueError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "unique") || strings.Contains(message, "duplicate") || strings.Contains(message, "constraint failed")
}

func truncateRecognition(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

func timeString(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.Format("2006-01-02 15:04:05")
}

func nullableID(value any) any {
	id := integerValue(value)
	if id <= 0 {
		return nil
	}
	return id
}

func anyJSONOrNil(value any) any {
	if value == nil {
		return nil
	}
	if text, ok := value.(string); ok {
		return text
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return string(encoded)
}

func nullableInt(value sql.NullInt64) any {
	if value.Valid {
		return value.Int64
	}
	return nil
}
