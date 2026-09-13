package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

var recognitionEventTypes = map[string]bool{
	"assessment.started": true, "assessment.completed": true, "assessment.passed": true, "assessment.failed": true,
	"activity.registered": true, "activity.attended": true, "submission.created": true, "submission.approved": true,
	"submission.rejected": true, "review.completed": true, "award.approved": true, "credential.issued": true,
	"credential.revoked": true, "credential.expired": true, "credential.superseded": true,
}

func (s *Server) recognitionEvents(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Recog-Signature, X-Recog-Timestamp")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action"))) {
	case "submit":
		s.recognitionEventSubmit(w, r)
	case "quiz_sync":
		s.recognitionQuizSync(w, r)
	case "connector_create":
		s.recognitionConnectorCreate(w, r)
	case "connector_list":
		s.recognitionConnectorList(w, r)
	case "connector_revoke":
		s.recognitionConnectorRevoke(w, r)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知操作"})
	}
}

func (s *Server) recognitionEventSubmit(w http.ResponseWriter, r *http.Request) {
	if !allowRequest(r, "recog_event_submit", 120, time.Minute) {
		rateLimited(w)
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
		return
	}
	token := bearerToken(r.Header.Get("Authorization"))
	if token == "" {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "未提供 API Token"})
		return
	}
	connector, err := s.recognitionFindConnector(r.Context(), token)
	if err != nil || connector == nil {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "Token 无效或已吊销"})
		return
	}
	rawBody, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请求体读取失败"})
		return
	}
	var body map[string]any
	if json.Unmarshal(rawBody, &body) != nil || body == nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请求体必须为 JSON"})
		return
	}
	if connector.HMACSecret != "" {
		if message := verifyRecognitionSignature(connector.HMACSecret, rawBody, r.Header.Get("X-Recog-Signature"), r.Header.Get("X-Recog-Timestamp")); message != "" {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": message})
			return
		}
	}
	typ := stringValue(body["type"])
	if !validRecognitionEventType(typ, connector.ClubID) {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "message": "未知事件类型：" + typ})
		return
	}
	var userID any
	subject, _ := body["subject"].(map[string]any)
	if stringValue(subject["type"]) == "vnfmap_user" {
		userID = nullableID(subject["id"])
	} else if subjectType, subjectID := stringValue(subject["type"]), stringValue(subject["id"]); subjectType != "" && subjectID != "" {
		var mapped int64
		if err := s.db.QueryRowContext(r.Context(), "SELECT vnfmap_user_id FROM recognition_identity_links WHERE external_provider=? AND external_subject_id=? AND revoked_at IS NULL AND verification_status='verified'", subjectType, subjectID).Scan(&mapped); err != nil || mapped <= 0 {
			writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "message": "外部主体未绑定 VNFMap 账号"})
			return
		}
		userID = mapped
	}
	resource, _ := body["resource"].(map[string]any)
	var versionID, programID any
	if stringValue(resource["type"]) == "program_version" && integerValue(resource["id"]) > 0 {
		candidate := integerValue(resource["id"])
		var published int64
		if err := s.db.QueryRowContext(r.Context(), "SELECT program_id FROM recognition_program_versions WHERE id=? AND status='published'", candidate).Scan(&published); err != nil {
			writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "message": "项目版本不存在或未发布"})
			return
		}
		versionID, programID = candidate, published
	}
	if !recognitionConnectorAllows(connector.Scope, typ, integerValue(programID)) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "该事件类型不在 Connector 授权范围内"})
		return
	}
	eventID := firstNonEmpty(stringValue(body["event_id"]), "")
	if eventID == "" {
		eventID, _ = newRecognitionEventID()
	}
	event := map[string]any{"event_id": eventID, "idempotency_key": stringValue(body["idempotency_key"]), "schema_version": firstNonEmpty(stringValue(body["schema_version"]), "1.0"), "type": typ, "club_id": connector.ClubID, "country": connector.Country, "user_id": userID, "program_id": programID, "program_version_id": versionID, "connector_id": connector.ID, "data": body["data"], "evidence_refs": body["evidence_refs"], "source_verified": true}
	duplicate, err := recordRecognitionEventExec(r.Context(), s.db, event)
	if err != nil {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "message": err.Error()})
		return
	}
	if duplicate {
		writeJSON(w, map[string]any{"success": true, "duplicate": true, "message": "事件已处理过，返回原结果"})
		return
	}
	award := map[string]any{"passed": false, "issued": false, "error": nil}
	if integerValue(versionID) > 0 && integerValue(userID) > 0 {
		data, _ := body["data"].(map[string]any)
		award = s.recognitionEvaluateAndAward(r.Context(), integerValue(versionID), integerValue(userID), map[string]any{"score": data["score"], "source": "external"})
	}
	writeJSON(w, map[string]any{"success": true, "event_id": eventID, "passed": boolValue(award["passed"]), "issued": boolValue(award["issued"]), "message": firstNonEmpty(stringValue(award["error"]), "事件已受理")})
}

type recognitionConnectorRow struct {
	ID, ClubID                                                             int64
	Country, Name, Type, TokenPrefix, TokenHash, HMACSecret, Scope, Status string
}

func (s *Server) recognitionFindConnector(ctx context.Context, token string) (*recognitionConnectorRow, error) {
	if len(token) < 24 {
		return nil, sql.ErrNoRows
	}
	prefix := token
	if len(prefix) > 12 {
		prefix = prefix[:12]
	}
	rows, err := s.db.QueryContext(ctx, "SELECT id,club_id,country,name,type,token_prefix,token_hash,hmac_secret,scope,status FROM recognition_connectors WHERE token_prefix=? AND status='active' AND revoked_at IS NULL", prefix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	digest := sha256.Sum256([]byte(token))
	for rows.Next() {
		var row recognitionConnectorRow
		if err := rows.Scan(&row.ID, &row.ClubID, &row.Country, &row.Name, &row.Type, &row.TokenPrefix, &row.TokenHash, &row.HMACSecret, &row.Scope, &row.Status); err != nil {
			return nil, err
		}
		if hmac.Equal([]byte(row.TokenHash), []byte(hex.EncodeToString(digest[:]))) {
			_ = rows.Close()
			_, _ = s.db.ExecContext(ctx, "UPDATE recognition_connectors SET last_used_at=CURRENT_TIMESTAMP WHERE id=?", row.ID)
			return &row, nil
		}
	}
	return nil, sql.ErrNoRows
}

func (s *Server) recognitionConnectorCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !sameOrigin(r) {
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
	clubID, country := integerValue(input["club_id"]), clubCodeCountry(stringValue(input["country"]))
	if user.Role != "super_admin" && !s.recognitionHasRole(r.Context(), user, clubID, country, "integration_manager") && !s.canManageClubCodes(r.Context(), user, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权管理该同好会的 Connector"})
		return
	}
	name := cleanProjectText(input["name"], 128)
	if name == "" {
		writeJSON(w, map[string]any{"success": false, "message": "请填写 Connector 名称"})
		return
	}
	types := []string{"webhook", "rest_api", "discord", "qq", "csv", "qr", "claim_code", "game", "manual", "event_platform"}
	typ := stringValue(input["type"])
	if !containsString(types, typ) {
		typ = "webhook"
	}
	eventTypes := stringSlice(input["event_types"], 100)
	programIDs := []int64{}
	for _, value := range anySlice(input["program_ids"]) {
		if id := integerValue(value); id > 0 {
			programIDs = append(programIDs, id)
		}
	}
	tokenBytes, err := randomBytes(24)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "Connector 创建失败"})
		return
	}
	token := "recog_" + hex.EncodeToString(tokenBytes)
	digest := sha256.Sum256([]byte(token))
	hmacSecret := ""
	if boolValue(input["enable_hmac"]) {
		secret, err := randomBytes(24)
		if err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "Connector 创建失败"})
			return
		}
		hmacSecret = hex.EncodeToString(secret)
	}
	scope := map[string]any{"permissions": []string{"event:write"}, "event_types": eventTypes, "program_ids": programIDs}
	result, err := s.db.ExecContext(r.Context(), "INSERT INTO recognition_connectors(club_id,country,name,type,token_prefix,token_hash,hmac_secret,scope,created_by) VALUES(?,?,?,?,?,?,?,?,?)", clubID, country, name, typ, token[:12], hex.EncodeToString(digest[:]), hmacSecret, jsonString(scope), user.ID)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "Connector 创建失败"})
		return
	}
	id, _ := result.LastInsertId()
	writeJSON(w, map[string]any{"success": true, "connector_id": id, "token": token, "hmac_secret": hmacSecret, "message": "Token 只展示这一次，请妥善保存"})
}

func (s *Server) recognitionConnectorList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	clubID, country := parsePositiveInt(r.URL.Query().Get("club_id")), clubCodeCountry(r.URL.Query().Get("country"))
	if user.Role != "super_admin" && !s.canManageClubCodes(r.Context(), user, clubID, country) && !s.recognitionHasRole(r.Context(), user, clubID, country, "integration_manager") {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	rows, err := s.db.QueryContext(r.Context(), "SELECT id,name,type,scope,status,created_at,last_used_at,revoked_at FROM recognition_connectors WHERE club_id=? AND country=? ORDER BY id DESC", clubID, country)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取 Connector 失败"})
		return
	}
	defer rows.Close()
	connectors := []map[string]any{}
	for rows.Next() {
		var id int64
		var name, typ, status string
		var scopeText string
		var created, lastUsed, revoked sql.NullString
		if err := rows.Scan(&id, &name, &typ, &scopeText, &status, &created, &lastUsed, &revoked); err != nil {
			continue
		}
		scope := map[string]any{}
		_ = json.Unmarshal([]byte(scopeText), &scope)
		connectors = append(connectors, map[string]any{"id": id, "name": name, "type": typ, "scope": scope, "status": status, "created_at": recognitionNull(created), "last_used_at": recognitionNull(lastUsed), "revoked_at": recognitionNull(revoked)})
	}
	writeJSON(w, map[string]any{"success": true, "connectors": connectors})
}

func (s *Server) recognitionConnectorRevoke(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !sameOrigin(r) {
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
	id := integerValue(input["connector_id"])
	var clubID int64
	var country string
	if err := s.db.QueryRowContext(r.Context(), "SELECT club_id,country FROM recognition_connectors WHERE id=?", id).Scan(&clubID, &country); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "Connector 不存在"})
		return
	}
	if user.Role != "super_admin" && !s.canManageClubCodes(r.Context(), user, clubID, country) && !s.recognitionHasRole(r.Context(), user, clubID, country, "integration_manager") {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE recognition_connectors SET status='revoked',revoked_at=CURRENT_TIMESTAMP WHERE id=?", id); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "Connector 吊销失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true})
}

func (s *Server) recognitionQuizSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !sameOrigin(r) {
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
	programID := integerValue(input["program_id"])
	program, err := s.recognitionProgram(r.Context(), programID)
	if err != nil || program == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "项目不存在"})
		return
	}
	if program.Type != "assessment" {
		writeJSON(w, map[string]any{"success": false, "message": "答题战绩只能桥接到 assessment 类型项目"})
		return
	}
	if user.Role != "super_admin" && !s.recognitionCanIssue(r.Context(), user, program.ClubID, program.Country) && !s.recognitionHasRole(r.Context(), user, program.ClubID, program.Country, "integration_manager") {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权为该项目同步答题战绩"})
		return
	}
	version, err := s.recognitionVersion(r.Context(), programID, false)
	if err != nil || version == nil {
		writeJSON(w, map[string]any{"success": false, "message": "该项目尚无已发布版本"})
		return
	}
	content, _ := version["content"].(map[string]any)
	if _, exists := content["quiz"]; !exists {
		writeJSON(w, map[string]any{"success": false, "message": "目标项目未配置答题内容，无法桥接战绩"})
		return
	}
	limit := integerValue(input["limit"])
	if limit < 1 {
		limit = 200
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := s.db.QueryContext(r.Context(), "SELECT room_code,vnfest_user_id,ended_at,score,quiz_title,player_rank FROM quiz_results WHERE vnfest_user_id>0 ORDER BY ended_at ASC LIMIT ?", limit)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取答题战绩失败"})
		return
	}
	defer rows.Close()
	synced, awarded, skipped := 0, 0, 0
	for rows.Next() {
		var room, title string
		var targetID, endedAt, score, rank int64
		if err := rows.Scan(&room, &targetID, &endedAt, &score, &title, &rank); err != nil {
			skipped++
			continue
		}
		key := fmt.Sprintf("makoquiz_%s_%d_%d", room, targetID, endedAt)
		duplicate, eventErr := recordRecognitionEventExec(r.Context(), s.db, map[string]any{"idempotency_key": key, "type": "assessment.completed", "club_id": program.ClubID, "country": program.Country, "user_id": targetID, "program_id": programID, "program_version_id": integerValue(version["id"]), "data": map[string]any{"score": score, "room_code": room, "quiz_title": title, "player_rank": rank}, "source_verified": true})
		if eventErr != nil {
			skipped++
			continue
		}
		synced++
		if duplicate {
			continue
		}
		award := s.recognitionEvaluateAndAward(r.Context(), integerValue(version["id"]), targetID, map[string]any{"score": score, "source": "external"})
		if boolValue(award["issued"]) {
			awarded++
		}
	}
	writeJSON(w, map[string]any{"success": true, "synced": synced, "awarded": awarded, "skipped": skipped, "message": fmt.Sprintf("已同步 %d 条战绩，新签发 %d 份凭证（重复提交已幂等去重）", synced, awarded)})
}

func bearerToken(value string) string {
	parts := strings.Fields(value)
	if len(parts) == 2 && strings.EqualFold(parts[0], "bearer") {
		return strings.TrimSpace(parts[1])
	}
	return ""
}

func verifyRecognitionSignature(secret string, rawBody []byte, signature, timestamp string) string {
	if secret == "" {
		return "服务端未配置签名密钥"
	}
	if signature == "" || timestamp == "" {
		return "缺少签名或时间戳"
	}
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || seconds < 0 || strconv.FormatInt(seconds, 10) != timestamp {
		return "时间戳格式非法"
	}
	if delta := time.Now().Unix() - seconds; delta > 300 || delta < -300 {
		return "请求时间戳超出允许窗口，可能为重放"
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestamp + "."))
	_, _ = mac.Write(rawBody)
	if !hmac.Equal([]byte(hex.EncodeToString(mac.Sum(nil))), []byte(signature)) {
		return "签名校验失败"
	}
	return ""
}

func recognitionConnectorAllows(scopeText, eventType string, programID int64) bool {
	scope := map[string]any{}
	_ = json.Unmarshal([]byte(scopeText), &scope)
	permissions := stringSlice(scope["permissions"], 20)
	if !containsString(permissions, "event:write") {
		return false
	}
	allowedTypes := stringSlice(scope["event_types"], 200)
	if len(allowedTypes) > 0 && !containsString(allowedTypes, eventType) {
		return false
	}
	allowedPrograms := anySlice(scope["program_ids"])
	if len(allowedPrograms) > 0 && programID > 0 {
		found := false
		for _, item := range allowedPrograms {
			if integerValue(item) == programID {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func validRecognitionEventType(eventType string, clubID int64) bool {
	if recognitionEventTypes[eventType] {
		return true
	}
	if !strings.HasPrefix(eventType, "custom.") {
		return false
	}
	parts := strings.SplitN(eventType, ".", 3)
	if len(parts) != 3 || parts[1] == "" || parts[2] == "" {
		return false
	}
	if parts[1] != strconv.FormatInt(clubID, 10) && parts[1] != "club_"+strconv.FormatInt(clubID, 10) {
		return false
	}
	for _, part := range parts[1:] {
		for _, character := range part {
			if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '_' {
				return false
			}
		}
	}
	return len(eventType) <= 128
}

func randomBytes(size int) ([]byte, error) {
	result := make([]byte, size)
	_, err := rand.Read(result)
	return result, err
}
