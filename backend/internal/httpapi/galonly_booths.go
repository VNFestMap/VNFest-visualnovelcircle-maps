package httpapi

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
	"golang.org/x/crypto/bcrypt"
)

const (
	galonlyBoothSessionCookie = "GALONLY_BOOTH_SESSION"
	galonlyBoothSessionAge    = 7 * 24 * time.Hour
	galonlyBoothProfileMax    = 512 << 10
	galonlyBoothMetricMax     = 16 << 10
	galonlyBoothImageMax      = 10 << 20
	galonlyBoothLoginLimit    = 5
	galonlyBoothLoginLock     = 15 * time.Minute
)

var galonlyBoothProfileFields = []string{
	"name", "circleName", "tagline", "description", "avatarText", "announcement",
	"avatarUrl", "tags", "status", "color", "contact", "products", "thumbnailUrl", "detailImageUrl",
}

var galonlyBoothMetricTypes = map[string]bool{
	"detail_view": true, "contact_click": true, "product_click": true,
	"favorite_on": true, "favorite_off": true,
}

type galonlyBoothMeta struct {
	ID       string
	TableIDs []string
	MapBooth map[string]any
}

type galonlyBoothAccount struct {
	ID                 int64
	EventID            int64
	BoothID            string
	Username           string
	UsernameNormalized string
	PasswordHash       string
	InitialCiphertext  string
	Status             string
	CredentialVersion  int64
	FailedAttempts     int64
	LockedUntil        string
	LastLoginAt        string
	PasswordChangedAt  string
}

type galonlyBoothSessionAccount struct {
	Account galonlyBoothAccount
	Token   string
}

type galonlyBoothProfileRequest struct {
	EventCode   string         `json:"event_code"`
	BoothID     string         `json:"booth_id"`
	BaseVersion int64          `json:"base_version"`
	Profile     map[string]any `json:"profile"`
}

type galonlyBoothLoginRequest struct {
	EventCode string `json:"event_code"`
	Username  string `json:"username"`
	Password  string `json:"password"`
}

type galonlyBoothPasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

type galonlyBoothMetricRequest struct {
	EventCode string `json:"event_code"`
	BoothID   string `json:"booth_id"`
	ProductID string `json:"product_id"`
	Metric    string `json:"metric_type"`
	EventUUID string `json:"event_uuid"`
	VisitorID string `json:"visitor_id"`
}

func (s *Server) galonlyBooths(w http.ResponseWriter, r *http.Request) {
	boothAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action"))) {
	case "admin_list":
		s.galonlyBoothAdminList(w, r)
	case "admin_save_profile":
		s.galonlyBoothAdminSaveProfile(w, r)
	case "admin_reset_credentials":
		s.galonlyBoothAdminResetCredentials(w, r)
	case "admin_update_account":
		s.galonlyBoothAdminUpdateAccount(w, r)
	case "login":
		s.galonlyBoothLogin(w, r)
	case "logout":
		s.galonlyBoothLogout(w, r)
	case "me":
		s.galonlyBoothMe(w, r)
	case "save_profile":
		s.galonlyBoothSaveProfile(w, r)
	case "change_password":
		s.galonlyBoothChangePassword(w, r)
	case "upload_image":
		s.galonlyBoothUploadImage(w, r)
	case "metrics":
		s.galonlyBoothMetrics(w, r)
	case "track":
		s.galonlyBoothTrack(w, r)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{
			"success":           false,
			"message":           "未知摊位门户动作",
			"available_actions": []string{"admin_list", "admin_save_profile", "admin_reset_credentials", "admin_update_account", "login", "logout", "me", "save_profile", "change_password", "upload_image", "metrics", "track"},
		})
	}
}

// galonlyPublic is the deliberately small, read-only contract for external
// platforms that mirror Beijing GalOnly booth information. It does not share
// the booth portal's admin/login actions or expose accounts, contact details,
// metrics, or profile versions.
func (s *Server) galonlyPublic(w http.ResponseWriter, r *http.Request) {
	galonlyPublicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}

	var input struct {
		Action    string `json:"action"`
		EventKey  string `json:"eventKey"`
		EventKey2 string `json:"event_key"`
		EventCode string `json:"event_code"`
	}
	if err := decodeJSON(r, &input, 32<<10); err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{
			"ok": false, "success": false, "message": "请求 JSON 无法读取",
		})
		return
	}
	if strings.ToLower(strings.TrimSpace(input.Action)) != "list" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{
			"ok": false, "success": false, "message": "只支持 action=list",
			"available_actions": []string{"list"},
		})
		return
	}

	eventKey := strings.TrimSpace(input.EventKey)
	if eventKey == "" {
		eventKey = strings.TrimSpace(input.EventKey2)
	}
	if eventKey == "" {
		eventKey = strings.TrimSpace(input.EventCode)
	}
	eventCode, canonicalKey, err := galonlyPublicEvent(eventKey)
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{
			"ok": false, "success": false, "message": err.Error(),
		})
		return
	}

	_, eventID, err := s.galonlyMapEvent(r.Context(), eventCode)
	if err != nil {
		s.galonlyMapEventError(w, err)
		return
	}
	response := map[string]any{
		"ok":         true,
		"success":    true,
		"action":     "list",
		"eventKey":   canonicalKey,
		"event_code": eventCode,
		"map_status": "unpublished",
		"merchants":  []map[string]any{},
	}

	document, err := s.galonlyMapDocument(r.Context(), `SELECT id,event_id,revision,status,schema_version,payload_json,checksum_sha256,source_name,created_by,created_at,published_by,published_at
        FROM galonly_map_documents WHERE event_id=? AND status='published' ORDER BY revision DESC LIMIT 1`, eventID)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, response)
		return
	}
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{
			"ok": false, "success": false, "message": "读取已发布摊位资料失败",
		})
		return
	}
	project, err := galonlyMapProjectFromDocument(document)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{
			"ok": false, "success": false, "message": "已发布摊位资料无效",
		})
		return
	}
	if galonlyMapProjectIsDemo(project) {
		response["map_status"] = "demo"
		writeJSON(w, response)
		return
	}
	publicProject, _, _, err := s.galonlyMapPublicProject(r.Context(), eventID, project)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{
			"ok": false, "success": false, "message": "读取公开摊位资料失败",
		})
		return
	}
	response["map_status"] = "published"
	response["merchants"] = galonlyPublicBoothList(publicProject)
	if publishedAt := strings.TrimSpace(stringValue(document["published_at"])); publishedAt != "" {
		response["updatedAt"] = publishedAt
	}
	writeJSON(w, response)
}

func galonlyPublicAPIHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func galonlyPublicEvent(value string) (string, string, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "bgo-02", galonlyMapEventCode:
		return galonlyMapEventCode, "bgo-02", nil
	default:
		return "", "", fmt.Errorf("不支持的 eventKey，仅支持 eventKey=bgo-02")
	}
}

func galonlyPublicBoothList(project map[string]any) []map[string]any {
	catalog, _ := project["catalog"].(map[string]any)
	items, _ := catalog["booths"].([]any)
	result := make([]map[string]any, 0, len(items))
	for _, raw := range items {
		booth, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		merchantKey := strings.TrimSpace(stringValue(booth["id"]))
		if merchantKey == "" {
			continue
		}
		tableIDs := galonlyPublicTableIDs(booth["tableIds"])
		boothNo := merchantKey
		if len(tableIDs) > 0 {
			boothNo = tableIDs[0]
		}
		introText := strings.TrimSpace(stringValue(booth["description"]))
		if introText == "" {
			introText = strings.TrimSpace(stringValue(booth["tagline"]))
		}
		result = append(result, map[string]any{
			"merchantKey":    merchantKey,
			"boothId":        merchantKey,
			"boothNo":        boothNo,
			"tableIds":       tableIDs,
			"name":           stringValue(booth["name"]),
			"circleName":     stringValue(booth["circleName"]),
			"introText":      introText,
			"announcement":   stringValue(booth["announcement"]),
			"status":         stringValue(booth["status"]),
			"tags":           galonlyPublicStringList(booth["tags"]),
			"avatarUrl":      galonlyPublicImageURL(booth["avatarUrl"]),
			"thumbnailUrl":   galonlyPublicImageURL(booth["thumbnailUrl"]),
			"detailImageUrl": galonlyPublicImageURL(booth["detailImageUrl"]),
		})
	}
	sort.SliceStable(result, func(i, j int) bool {
		return strings.ToUpper(stringValue(result[i]["merchantKey"])) < strings.ToUpper(stringValue(result[j]["merchantKey"]))
	})
	return result
}

func galonlyPublicTableIDs(value any) []string {
	result := []string{}
	switch values := value.(type) {
	case []any:
		for _, raw := range values {
			if item := strings.ToUpper(strings.TrimSpace(stringValue(raw))); item != "" {
				result = append(result, item)
			}
		}
	case []string:
		for _, raw := range values {
			if item := strings.ToUpper(strings.TrimSpace(raw)); item != "" {
				result = append(result, item)
			}
		}
	}
	sort.Strings(result)
	return result
}

func galonlyPublicStringList(value any) []string {
	result := []string{}
	if values, ok := value.([]any); ok {
		for _, raw := range values {
			if item := strings.TrimSpace(stringValue(raw)); item != "" {
				result = append(result, item)
			}
		}
	}
	return result
}

func galonlyPublicImageURL(value any) any {
	image := strings.TrimSpace(stringValue(value))
	if image == "" || !galonlyMapURLAllowed(image) {
		return nil
	}
	return image
}

func boothAPIHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func (s *Server) requireBoothAdmin(w http.ResponseWriter, r *http.Request) (*user, bool) {
	admin, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return nil, false
	}
	if admin.Role != "super_admin" {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "摊位账号控制台仅限超级管理员"})
		return nil, false
	}
	return admin, true
}

func requireBoothSameOrigin(r *http.Request) bool {
	if strings.TrimSpace(r.Header.Get("Origin")) == "" && strings.TrimSpace(r.Referer()) == "" {
		return true
	}
	return sameOrigin(r)
}

func (s *Server) galonlyBoothEventID(ctx context.Context, eventCode string) (int64, error) {
	_, eventID, err := s.galonlyMapEvent(ctx, eventCode)
	return eventID, err
}

func (s *Server) galonlyBoothCatalog(ctx context.Context, eventID int64) (map[string]galonlyBoothMeta, error) {
	document, err := s.galonlyMapDocument(ctx, `SELECT id,event_id,revision,status,schema_version,payload_json,checksum_sha256,source_name,created_by,created_at,published_by,published_at
        FROM galonly_map_documents WHERE event_id=? AND status='published' ORDER BY revision DESC LIMIT 1`, eventID)
	if err != nil {
		return nil, err
	}
	project, err := galonlyMapProjectFromDocument(document)
	if err != nil {
		return nil, err
	}
	publicProject, _, _, err := s.galonlyMapPublicProject(ctx, eventID, project)
	if err != nil {
		return nil, err
	}
	catalog, _ := publicProject["catalog"].(map[string]any)
	items, _ := catalog["booths"].([]any)
	result := make(map[string]galonlyBoothMeta, len(items))
	for _, raw := range items {
		booth, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		id := strings.ToUpper(strings.TrimSpace(stringValue(booth["id"])))
		if id == "" {
			continue
		}
		meta := galonlyBoothMeta{ID: id, MapBooth: booth}
		switch tableIDs := booth["tableIds"].(type) {
		case []any:
			for _, rawTableID := range tableIDs {
				if tableID := strings.ToUpper(strings.TrimSpace(stringValue(rawTableID))); tableID != "" {
					meta.TableIDs = append(meta.TableIDs, tableID)
				}
			}
		case []string:
			for _, rawTableID := range tableIDs {
				if tableID := strings.ToUpper(strings.TrimSpace(rawTableID)); tableID != "" {
					meta.TableIDs = append(meta.TableIDs, tableID)
				}
			}
		}
		sort.Strings(meta.TableIDs)
		result[id] = meta
	}
	return result, nil
}

func (s *Server) ensureGalonlyBoothCatalog(ctx context.Context, eventID int64) (map[string]galonlyBoothMeta, error) {
	catalog, err := s.galonlyBoothCatalog(ctx, eventID)
	if err != nil {
		return nil, err
	}
	for id, meta := range catalog {
		profile := boothProfileFromMapBooth(meta.MapBooth)
		normalized, err := normalizeGalonlyBoothProfile(profile, id)
		if err != nil {
			// A reserved V6 layout entry intentionally has no profile or account.
			// It becomes a real portal only after a chief assignment or profile save.
			if strings.TrimSpace(stringValue(profile["name"])) == "" {
				continue
			}
			return nil, fmt.Errorf("初始化摊位 %s 资料失败: %w", id, err)
		}
		encoded, err := json.Marshal(normalized)
		if err != nil {
			return nil, err
		}
		insertProfile := `INSERT OR IGNORE INTO galonly_booth_profiles
            (event_id,booth_id,profile_json,profile_version,updated_by_type,created_at,updated_at)
            VALUES (?,?,?,1,'seed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
		if s.db.Driver == "mysql" {
			insertProfile = `INSERT INTO galonly_booth_profiles
                (event_id,booth_id,profile_json,profile_version,updated_by_type,created_at,updated_at)
				VALUES (?,?,?,1,'seed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
				ON DUPLICATE KEY UPDATE booth_id=VALUES(booth_id)`
		}
		if _, err := s.db.ExecContext(ctx, insertProfile, eventID, id, string(encoded)); err != nil {
			return nil, err
		}
		if err := s.createGalonlyBoothAccount(ctx, eventID, id); err != nil {
			return nil, err
		}
	}
	return catalog, nil
}

func boothProfileFromMapBooth(booth map[string]any) map[string]any {
	profile := map[string]any{}
	for _, key := range galonlyBoothProfileFields {
		if value, ok := booth[key]; ok {
			profile[key] = galonlyMapCloneValue(value)
		}
	}
	if _, ok := profile["tags"]; !ok {
		profile["tags"] = []any{}
	}
	if _, ok := profile["products"]; !ok {
		profile["products"] = []any{}
	}
	if _, ok := profile["contact"]; !ok {
		profile["contact"] = map[string]any{"label": "", "url": nil}
	}
	return profile
}

func galonlyMapCloneValue(value any) any {
	raw, err := json.Marshal(value)
	if err != nil {
		return value
	}
	var cloned any
	if json.Unmarshal(raw, &cloned) != nil {
		return value
	}
	return cloned
}

func normalizeGalonlyBoothProfile(input map[string]any, boothID string) (map[string]any, error) {
	if input == nil {
		return nil, errors.New("资料必须是对象")
	}
	result := map[string]any{}
	name := strings.TrimSpace(stringValue(input["name"]))
	if !validMapText(name, 120) || name == "" {
		return nil, fmt.Errorf("摊位 %s 的展示名称不能为空", boothID)
	}
	result["name"] = name
	for _, item := range []struct {
		key string
		max int
	}{
		{"circleName", 120}, {"tagline", 200}, {"description", 3000}, {"avatarText", 12}, {"announcement", 1000},
	} {
		value := strings.TrimSpace(stringValue(input[item.key]))
		if !validMapText(value, item.max) {
			return nil, fmt.Errorf("摊位 %s 的 %s 文本无效", boothID, item.key)
		}
		result[item.key] = value
	}
	for _, key := range []string{"thumbnailUrl", "detailImageUrl"} {
		image := strings.TrimSpace(stringValue(input[key]))
		if image != "" && !galonlyMapURLAllowed(image) {
			return nil, fmt.Errorf("摊位 %s 的 %s 图片地址无效", boothID, key)
		}
		if image != "" {
			result[key] = image
		}
	}
	if value, exists := input["avatarUrl"]; exists {
		image := strings.TrimSpace(stringValue(value))
		if image != "" && !galonlyMapURLAllowed(image) {
			return nil, fmt.Errorf("摊位 %s 的头像地址无效", boothID)
		}
		if image == "" {
			result["avatarUrl"] = nil
		} else {
			result["avatarUrl"] = image
		}
	}
	status := strings.ToLower(strings.TrimSpace(stringValue(input["status"])))
	if status == "" {
		status = "open"
	}
	if !galonlyMapBoothStatuses[status] {
		return nil, fmt.Errorf("摊位 %s 的营业状态无效", boothID)
	}
	result["status"] = status
	color := strings.TrimSpace(stringValue(input["color"]))
	if color == "" {
		color = "#4d7cc7"
	}
	if !galonlyMapColorPattern.MatchString(color) {
		return nil, fmt.Errorf("摊位 %s 的颜色无效", boothID)
	}
	result["color"] = color

	tags := []any{}
	switch values := input["tags"].(type) {
	case []any:
		tags = values
	case []string:
		for _, value := range values {
			tags = append(tags, value)
		}
	case nil:
	default:
		return nil, fmt.Errorf("摊位 %s 的标签格式无效", boothID)
	}
	if len(tags) > 8 {
		return nil, fmt.Errorf("摊位 %s 的标签数量无效", boothID)
	}
	normalizedTags := make([]any, 0, len(tags))
	seenTags := map[string]bool{}
	for _, raw := range tags {
		value := strings.TrimSpace(stringValue(raw))
		if value == "" || !validMapText(value, 32) || seenTags[value] {
			return nil, fmt.Errorf("摊位 %s 的标签无效", boothID)
		}
		seenTags[value] = true
		normalizedTags = append(normalizedTags, value)
	}
	result["tags"] = normalizedTags
	contact, err := normalizeGalonlyMapContact(input["contact"])
	if err != nil {
		return nil, fmt.Errorf("摊位 %s 的联系方式无效: %w", boothID, err)
	}
	result["contact"] = contact

	products := []any{}
	switch values := input["products"].(type) {
	case []any:
		products = values
	case []map[string]any:
		for _, value := range values {
			products = append(products, value)
		}
	case nil:
	default:
		return nil, fmt.Errorf("摊位 %s 的制品格式无效", boothID)
	}
	if len(products) > 40 {
		return nil, fmt.Errorf("摊位 %s 的制品数量无效", boothID)
	}
	productIDs := map[string]bool{}
	normalizedProducts := make([]any, 0, len(products))
	for _, raw := range products {
		product, err := normalizeGalonlyMapProduct(raw, boothID, productIDs)
		if err != nil {
			return nil, err
		}
		normalizedProducts = append(normalizedProducts, product)
	}
	result["products"] = normalizedProducts
	return result, nil
}

func (s *Server) createGalonlyBoothAccount(ctx context.Context, eventID int64, boothID string) error {
	if strings.TrimSpace(s.cfg.BoothCredentialKey) == "" {
		return errors.New("GALONLY_BOOTH_CREDENTIAL_KEY 未配置，无法生成摊位临时密码")
	}
	username := "BJG-" + strings.ToUpper(strings.TrimSpace(boothID))
	password := "G" + strings.ToUpper(strings.TrimSpace(boothID)) + "-" + randomHex(6)
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	ciphertext, err := s.encryptGalonlyBoothPassword(password)
	if err != nil {
		return err
	}
	insert := `INSERT OR IGNORE INTO galonly_booth_accounts
        (event_id,booth_id,username,username_normalized,password_hash,initial_password_ciphertext,status,credential_version,failed_attempts,created_at,updated_at)
		VALUES (?,?,?,?,? ,?,'active',1,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
	if s.db.Driver == "mysql" {
		insert = `INSERT INTO galonly_booth_accounts
            (event_id,booth_id,username,username_normalized,password_hash,initial_password_ciphertext,status,credential_version,failed_attempts,created_at,updated_at)
			VALUES (?,?,?,?,? ,?,'active',1,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
			ON DUPLICATE KEY UPDATE booth_id=VALUES(booth_id)`
	}
	_, err = s.db.ExecContext(ctx, insert, eventID, boothID, username, strings.ToLower(username), string(hash), ciphertext)
	return err
}

func (s *Server) encryptGalonlyBoothPassword(password string) (string, error) {
	keyText := strings.TrimSpace(s.cfg.BoothCredentialKey)
	if keyText == "" {
		return "", errors.New("摊位凭据密钥未配置")
	}
	digest := sha256.Sum256([]byte(keyText))
	block, err := aes.NewCipher(digest[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, nonce, []byte(password), nil)
	return "v1." + base64.RawURLEncoding.EncodeToString(nonce) + "." + base64.RawURLEncoding.EncodeToString(sealed), nil
}

func (s *Server) decryptGalonlyBoothPassword(ciphertext string) (string, error) {
	parts := strings.Split(ciphertext, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return "", errors.New("摊位凭据密文版本无效")
	}
	keyText := strings.TrimSpace(s.cfg.BoothCredentialKey)
	if keyText == "" {
		return "", errors.New("摊位凭据密钥未配置")
	}
	nonce, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", err
	}
	sealed, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(keyText))
	block, err := aes.NewCipher(digest[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, nonce, sealed, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func (s *Server) galonlyBoothAdminList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	admin, ok := s.requireBoothAdmin(w, r)
	if !ok {
		return
	}
	if !requireBoothSameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	eventID, err := s.galonlyBoothEventID(r.Context(), r.URL.Query().Get("event_code"))
	if err != nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "北京活动不存在或尚未发布地图"})
		return
	}
	catalog, err := s.ensureGalonlyBoothCatalog(r.Context(), eventID)
	if err != nil {
		s.galonlyBoothStorageError(w, err)
		return
	}
	ids := make([]string, 0, len(catalog))
	for id := range catalog {
		ids = append(ids, id)
	}
	sortGalonlyBoothIDs(ids)
	booths := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		profile, version, err := s.readGalonlyBoothProfile(r.Context(), eventID, id)
		if err != nil {
			s.galonlyBoothStorageError(w, err)
			return
		}
		account, err := s.readGalonlyBoothAccount(r.Context(), eventID, id)
		if err != nil {
			s.galonlyBoothStorageError(w, err)
			return
		}
		accountJSON := map[string]any{
			"id": account.ID, "username": account.Username, "status": account.Status,
			"credential_version": account.CredentialVersion, "failed_attempts": account.FailedAttempts,
			"locked_until": boothNullableString(account.LockedUntil), "last_login_at": boothNullableString(account.LastLoginAt),
			"password_changed": strings.TrimSpace(account.PasswordChangedAt) != "",
		}
		if account.PasswordChangedAt == "" && account.InitialCiphertext != "" {
			if password, decryptErr := s.decryptGalonlyBoothPassword(account.InitialCiphertext); decryptErr == nil {
				accountJSON["initial_password"] = password
			} else {
				accountJSON["initial_password_unavailable"] = true
			}
		}
		metrics := s.galonlyBoothMetricSummary(r.Context(), eventID, id)
		booths = append(booths, map[string]any{
			"booth_id": id, "table_ids": catalog[id].TableIDs, "profile": profile,
			"profile_version": version, "account": accountJSON, "metrics": metrics,
		})
	}
	writeJSON(w, map[string]any{"success": true, "event_code": galonlyMapEventCode, "event_id": eventID, "updated_by": admin.Username, "booths": booths})
}

func sortGalonlyBoothIDs(ids []string) {
	sort.Slice(ids, func(i, j int) bool {
		left, right := strings.ToUpper(ids[i]), strings.ToUpper(ids[j])
		lp, rp := left, right
		if len(lp) > 0 {
			lp = lp[:1]
		}
		if len(rp) > 0 {
			rp = rp[:1]
		}
		if lp != rp {
			return lp < rp
		}
		ln, rn := boothTrailingNumber(left), boothTrailingNumber(right)
		if ln != rn {
			return ln < rn
		}
		return left < right
	})
}

func boothTrailingNumber(value string) int {
	index := len(value)
	for index > 0 && value[index-1] >= '0' && value[index-1] <= '9' {
		index--
	}
	if index == len(value) {
		return 0
	}
	parsed, _ := strconv.Atoi(value[index:])
	return parsed
}

func (s *Server) galonlyBoothAdminSaveProfile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	admin, ok := s.requireBoothAdmin(w, r)
	if !ok {
		return
	}
	if !requireBoothSameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	var input galonlyBoothProfileRequest
	if err := decodeJSON(r, &input, galonlyBoothProfileMax); err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "摊位资料无法读取"})
		return
	}
	eventID, err := s.galonlyBoothEventID(r.Context(), input.EventCode)
	if err != nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "活动不存在"})
		return
	}
	if _, err := s.ensureGalonlyBoothCatalog(r.Context(), eventID); err != nil {
		s.galonlyBoothStorageError(w, err)
		return
	}
	if err := s.saveGalonlyBoothProfile(r.Context(), eventID, input.BoothID, input.BaseVersion, input.Profile, "admin", &admin.ID, nil); err != nil {
		s.galonlyBoothProfileSaveError(w, err)
		return
	}
	profile, version, _ := s.readGalonlyBoothProfile(r.Context(), eventID, strings.ToUpper(strings.TrimSpace(input.BoothID)))
	writeJSON(w, map[string]any{"success": true, "booth_id": strings.ToUpper(strings.TrimSpace(input.BoothID)), "profile": profile, "profile_version": version})
}

func (s *Server) galonlyBoothAdminResetCredentials(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if _, ok := s.requireBoothAdmin(w, r); !ok {
		return
	}
	if !requireBoothSameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	var input struct {
		EventCode string `json:"event_code"`
		BoothID   string `json:"booth_id"`
	}
	if err := decodeJSON(r, &input, 32<<10); err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "摊位账号请求无法读取"})
		return
	}
	eventID, err := s.galonlyBoothEventID(r.Context(), input.EventCode)
	if err != nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "活动不存在"})
		return
	}
	if _, err := s.ensureGalonlyBoothCatalog(r.Context(), eventID); err != nil {
		s.galonlyBoothStorageError(w, err)
		return
	}
	account, temporaryPassword, err := s.resetGalonlyBoothCredentials(r.Context(), eventID, input.BoothID)
	if err != nil {
		s.galonlyBoothStorageError(w, err)
		return
	}
	writeJSON(w, map[string]any{"success": true, "booth_id": account.BoothID, "username": account.Username, "temporary_password": temporaryPassword})
}

func (s *Server) galonlyBoothAdminUpdateAccount(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if _, ok := s.requireBoothAdmin(w, r); !ok {
		return
	}
	if !requireBoothSameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	var input struct {
		EventCode string `json:"event_code"`
		BoothID   string `json:"booth_id"`
		Username  string `json:"username"`
		Status    string `json:"status"`
	}
	if err := decodeJSON(r, &input, 32<<10); err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "摊位账号请求无法读取"})
		return
	}
	eventID, err := s.galonlyBoothEventID(r.Context(), input.EventCode)
	if err != nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "活动不存在"})
		return
	}
	boothID := strings.ToUpper(strings.TrimSpace(input.BoothID))
	username := strings.TrimSpace(input.Username)
	if len(username) < 3 || len(username) > 96 || strings.ContainsAny(username, "\r\n\x00") || strings.ContainsAny(username, " \t") {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "登录账号长度或格式无效"})
		return
	}
	status := strings.ToLower(strings.TrimSpace(input.Status))
	if status != "active" && status != "disabled" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "账号状态无效"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "摊位账号暂时无法保存"})
		return
	}
	result, err := tx.ExecContext(r.Context(), `UPDATE galonly_booth_accounts SET username=?,username_normalized=?,status=?,credential_version=credential_version+1,updated_at=CURRENT_TIMESTAMP WHERE event_id=? AND booth_id=?`, username, strings.ToLower(username), status, eventID, boothID)
	if err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "登录账号已存在或无法保存"})
		return
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "摊位账号不存在"})
		return
	}
	if _, err := tx.ExecContext(r.Context(), `UPDATE galonly_booth_sessions SET revoked_at=CURRENT_TIMESTAMP
        WHERE account_id=(SELECT id FROM galonly_booth_accounts WHERE event_id=? AND booth_id=?) AND revoked_at IS NULL`, eventID, boothID); err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "摊位账号暂时无法保存"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "摊位账号暂时无法保存"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "booth_id": boothID, "username": username, "status": status})
}

func (s *Server) saveGalonlyBoothProfile(ctx context.Context, eventID int64, boothID string, baseVersion int64, raw map[string]any, actorType string, userID *int64, accountID *int64) error {
	boothID = strings.ToUpper(strings.TrimSpace(boothID))
	if boothID == "" || baseVersion <= 0 {
		return errors.New("缺少摊位或资料版本")
	}
	normalized, err := normalizeGalonlyBoothProfile(raw, boothID)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `UPDATE galonly_booth_profiles SET profile_json=?,profile_version=profile_version+1,updated_by_type=?,updated_by_user_id=?,updated_by_account_id=?,updated_at=CURRENT_TIMESTAMP WHERE event_id=? AND booth_id=? AND profile_version=?`, string(encoded), actorType, userID, accountID, eventID, boothID, baseVersion)
	if err != nil {
		return err
	}
	affected, _ := result.RowsAffected()
	if affected != 1 {
		return fmt.Errorf("资料版本已变化，请刷新后再保存")
	}
	return nil
}

func (s *Server) readGalonlyBoothProfile(ctx context.Context, eventID int64, boothID string) (map[string]any, int64, error) {
	var encoded string
	var version int64
	err := s.db.QueryRowContext(ctx, "SELECT profile_json,profile_version FROM galonly_booth_profiles WHERE event_id=? AND booth_id=?", eventID, strings.ToUpper(strings.TrimSpace(boothID))).Scan(&encoded, &version)
	if err != nil {
		return nil, 0, err
	}
	var profile map[string]any
	if err := json.Unmarshal([]byte(encoded), &profile); err != nil || profile == nil {
		return nil, 0, errors.New("摊位资料数据无效")
	}
	return profile, version, nil
}

func (s *Server) readGalonlyBoothAccount(ctx context.Context, eventID int64, boothID string) (galonlyBoothAccount, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id,event_id,booth_id,username,username_normalized,password_hash,initial_password_ciphertext,status,credential_version,failed_attempts,locked_until,last_login_at,password_changed_at
        FROM galonly_booth_accounts WHERE event_id=? AND booth_id=?`, eventID, strings.ToUpper(strings.TrimSpace(boothID)))
	return scanGalonlyBoothAccount(row)
}

func scanGalonlyBoothAccount(row scanner) (galonlyBoothAccount, error) {
	var result galonlyBoothAccount
	var initial, locked, lastLogin, changed sql.NullString
	if err := row.Scan(&result.ID, &result.EventID, &result.BoothID, &result.Username, &result.UsernameNormalized, &result.PasswordHash, &initial, &result.Status, &result.CredentialVersion, &result.FailedAttempts, &locked, &lastLogin, &changed); err != nil {
		return result, err
	}
	result.InitialCiphertext = initial.String
	result.LockedUntil = locked.String
	result.LastLoginAt = lastLogin.String
	result.PasswordChangedAt = changed.String
	return result, nil
}

func boothNullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func (s *Server) resetGalonlyBoothCredentials(ctx context.Context, eventID int64, boothID string) (galonlyBoothAccount, string, error) {
	account, err := s.readGalonlyBoothAccount(ctx, eventID, boothID)
	if err != nil {
		return account, "", err
	}
	password := "G" + strings.ToUpper(account.BoothID) + "-" + randomHex(6)
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return account, "", err
	}
	ciphertext, err := s.encryptGalonlyBoothPassword(password)
	if err != nil {
		return account, "", err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return account, "", err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE galonly_booth_accounts SET password_hash=?,initial_password_ciphertext=?,password_changed_at=NULL,credential_version=credential_version+1,failed_attempts=0,locked_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`, string(hash), ciphertext, account.ID); err != nil {
		_ = tx.Rollback()
		return account, "", err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE galonly_booth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE account_id=? AND revoked_at IS NULL", account.ID); err != nil {
		_ = tx.Rollback()
		return account, "", err
	}
	if err := tx.Commit(); err != nil {
		return account, "", err
	}
	account.PasswordHash = string(hash)
	account.InitialCiphertext = ciphertext
	account.PasswordChangedAt = ""
	account.CredentialVersion++
	return account, password, nil
}

func (s *Server) galonlyBoothProfileSaveError(w http.ResponseWriter, err error) {
	message := err.Error()
	status := http.StatusBadRequest
	if strings.Contains(message, "版本已变化") {
		status = http.StatusConflict
	}
	writeJSONStatus(w, status, map[string]any{"success": false, "message": message})
}

func (s *Server) galonlyBoothStorageError(w http.ResponseWriter, err error) {
	if boothPortalTableMissing(err) {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "摊位门户尚未完成数据库迁移"})
		return
	}
	writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "摊位门户数据暂时不可用"})
}

func boothPortalTableMissing(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "no such table") || strings.Contains(message, "doesn't exist") || strings.Contains(message, "unknown table")
}

func (s *Server) galonlyBoothLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !requireBoothSameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	var input galonlyBoothLoginRequest
	if err := decodeJSON(r, &input, 32<<10); err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "登录信息无法读取"})
		return
	}
	eventID, err := s.galonlyBoothEventID(r.Context(), input.EventCode)
	if err != nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "账号或密码错误"})
		return
	}
	catalog, catalogErr := s.ensureGalonlyBoothCatalog(r.Context(), eventID)
	if catalogErr != nil {
		if boothPortalTableMissing(catalogErr) {
			s.galonlyBoothStorageError(w, catalogErr)
		} else {
			writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "账号或密码错误"})
		}
		return
	}
	username := strings.TrimSpace(input.Username)
	if len(username) < 3 || len(username) > 96 || len(input.Password) < 1 || len(input.Password) > 256 {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "账号或密码错误"})
		return
	}
	row := s.db.QueryRowContext(r.Context(), `SELECT id,event_id,booth_id,username,username_normalized,password_hash,initial_password_ciphertext,status,credential_version,failed_attempts,locked_until,last_login_at,password_changed_at
        FROM galonly_booth_accounts WHERE event_id=? AND username_normalized=? LIMIT 1`, eventID, strings.ToLower(username))
	account, err := scanGalonlyBoothAccount(row)
	if err != nil || account.Status != "active" {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "账号或密码错误"})
		return
	}
	if boothTimeFuture(account.LockedUntil) {
		writeJSONStatus(w, http.StatusTooManyRequests, map[string]any{"success": false, "message": "登录失败次数过多，请稍后再试"})
		return
	}
	if !verifyPassword(input.Password, account.PasswordHash) {
		attempts := account.FailedAttempts + 1
		if attempts >= galonlyBoothLoginLimit {
			lockedUntil := time.Now().UTC().Add(galonlyBoothLoginLock)
			_, _ = s.db.ExecContext(r.Context(), `UPDATE galonly_booth_accounts SET failed_attempts=?,locked_until=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`, attempts, lockedUntil, account.ID)
		} else {
			_, _ = s.db.ExecContext(r.Context(), `UPDATE galonly_booth_accounts SET failed_attempts=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`, attempts, account.ID)
		}
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "账号或密码错误"})
		return
	}
	profile, version, err := s.readGalonlyBoothProfile(r.Context(), eventID, account.BoothID)
	if err != nil {
		s.galonlyBoothStorageError(w, err)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `UPDATE galonly_booth_accounts SET failed_attempts=0,locked_until=NULL,last_login_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`, account.ID); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "登录暂时不可用，请稍后再试"})
		return
	}
	token, err := s.issueGalonlyBoothSession(r.Context(), account)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "登录暂时不可用，请稍后再试"})
		return
	}
	setGalonlyBoothCookie(w, token, time.Now().Add(galonlyBoothSessionAge), s.cfg.SessionCookieSecure)
	writeJSON(w, map[string]any{"success": true, "booth_id": account.BoothID, "table_ids": catalog[account.BoothID].TableIDs, "profile": profile, "profile_version": version, "account": boothPortalAccountResponse(account)})
}

func (s *Server) issueGalonlyBoothSession(ctx context.Context, account galonlyBoothAccount) (string, error) {
	token, err := newSessionID()
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(digest[:])
	expires := time.Now().UTC().Add(galonlyBoothSessionAge)
	if _, err := s.db.ExecContext(ctx, `INSERT INTO galonly_booth_sessions(token_hash,account_id,credential_version,expires_at,created_at,last_seen_at)
        VALUES (?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, tokenHash, account.ID, account.CredentialVersion, expires); err != nil {
		return "", err
	}
	return token, nil
}

func setGalonlyBoothCookie(w http.ResponseWriter, token string, expires time.Time, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name: galonlyBoothSessionCookie, Value: token, Path: "/", Expires: expires, MaxAge: int(galonlyBoothSessionAge / time.Second),
		HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode,
	})
}

func clearGalonlyBoothCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{Name: galonlyBoothSessionCookie, Value: "", Path: "/", MaxAge: -1, Expires: time.Unix(1, 0).UTC(), HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode})
}

func (s *Server) loadGalonlyBoothSession(ctx context.Context, r *http.Request) (*galonlyBoothSessionAccount, error) {
	cookie, err := r.Cookie(galonlyBoothSessionCookie)
	if err != nil || strings.TrimSpace(cookie.Value) == "" {
		return nil, nil
	}
	digest := sha256.Sum256([]byte(cookie.Value))
	tokenHash := hex.EncodeToString(digest[:])
	row := s.db.QueryRowContext(ctx, `SELECT a.id,a.event_id,a.booth_id,a.username,a.username_normalized,a.password_hash,a.initial_password_ciphertext,a.status,a.credential_version,a.failed_attempts,a.locked_until,a.last_login_at,a.password_changed_at,s.credential_version
        FROM galonly_booth_sessions s JOIN galonly_booth_accounts a ON a.id=s.account_id
        WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>CURRENT_TIMESTAMP AND a.status='active' LIMIT 1`, tokenHash)
	var account galonlyBoothAccount
	var initial, locked, lastLogin, changed sql.NullString
	var sessionVersion int64
	if err := row.Scan(&account.ID, &account.EventID, &account.BoothID, &account.Username, &account.UsernameNormalized, &account.PasswordHash, &initial, &account.Status, &account.CredentialVersion, &account.FailedAttempts, &locked, &lastLogin, &changed, &sessionVersion); err != nil {
		if errors.Is(err, sql.ErrNoRows) || isNoRows(err) {
			return nil, nil
		}
		return nil, err
	}
	if sessionVersion != account.CredentialVersion {
		return nil, nil
	}
	account.InitialCiphertext = initial.String
	account.LockedUntil = locked.String
	account.LastLoginAt = lastLogin.String
	account.PasswordChangedAt = changed.String
	_, _ = s.db.ExecContext(ctx, "UPDATE galonly_booth_sessions SET last_seen_at=CURRENT_TIMESTAMP WHERE token_hash=?", tokenHash)
	return &galonlyBoothSessionAccount{Account: account, Token: cookie.Value}, nil
}

func (s *Server) galonlyBoothLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !requireBoothSameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	if session, _ := s.loadGalonlyBoothSession(r.Context(), r); session != nil {
		digest := sha256.Sum256([]byte(session.Token))
		_, _ = s.db.ExecContext(r.Context(), "UPDATE galonly_booth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE token_hash=?", hex.EncodeToString(digest[:]))
	}
	clearGalonlyBoothCookie(w, s.cfg.SessionCookieSecure)
	writeJSON(w, map[string]any{"success": true})
}

func (s *Server) galonlyBoothMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	session, err := s.loadGalonlyBoothSession(r.Context(), r)
	if err != nil {
		s.galonlyBoothStorageError(w, err)
		return
	}
	if session == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请使用摊位账号登录"})
		return
	}
	profile, version, err := s.readGalonlyBoothProfile(r.Context(), session.Account.EventID, session.Account.BoothID)
	if err != nil {
		s.galonlyBoothStorageError(w, err)
		return
	}
	meta, _ := s.galonlyBoothCatalog(r.Context(), session.Account.EventID)
	writeJSON(w, map[string]any{"success": true, "event_code": galonlyMapEventCode, "booth_id": session.Account.BoothID, "table_ids": meta[session.Account.BoothID].TableIDs, "profile": profile, "profile_version": version, "account": boothPortalAccountResponse(session.Account), "metrics": s.galonlyBoothMetricSummary(r.Context(), session.Account.EventID, session.Account.BoothID)})
}

func boothPortalAccountResponse(account galonlyBoothAccount) map[string]any {
	return map[string]any{
		"username": account.Username, "status": account.Status,
		"password_changed": strings.TrimSpace(account.PasswordChangedAt) != "",
		"last_login_at":    boothNullableString(account.LastLoginAt),
	}
}

func (s *Server) galonlyBoothSaveProfile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !requireBoothSameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	session, err := s.loadGalonlyBoothSession(r.Context(), r)
	if err != nil {
		s.galonlyBoothStorageError(w, err)
		return
	}
	if session == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请使用摊位账号登录"})
		return
	}
	var input galonlyBoothProfileRequest
	if err := decodeJSON(r, &input, galonlyBoothProfileMax); err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "摊位资料无法读取"})
		return
	}
	if input.EventCode != "" && strings.ToLower(strings.TrimSpace(input.EventCode)) != galonlyMapEventCode {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "活动标识无效"})
		return
	}
	if strings.ToUpper(strings.TrimSpace(input.BoothID)) != session.Account.BoothID {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "不能修改其他摊位资料"})
		return
	}
	if err := s.saveGalonlyBoothProfile(r.Context(), session.Account.EventID, session.Account.BoothID, input.BaseVersion, input.Profile, "booth", nil, &session.Account.ID); err != nil {
		s.galonlyBoothProfileSaveError(w, err)
		return
	}
	profile, version, _ := s.readGalonlyBoothProfile(r.Context(), session.Account.EventID, session.Account.BoothID)
	writeJSON(w, map[string]any{"success": true, "booth_id": session.Account.BoothID, "profile": profile, "profile_version": version})
}

func (s *Server) galonlyBoothChangePassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !requireBoothSameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	session, err := s.loadGalonlyBoothSession(r.Context(), r)
	if err != nil {
		s.galonlyBoothStorageError(w, err)
		return
	}
	if session == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请使用摊位账号登录"})
		return
	}
	var input galonlyBoothPasswordRequest
	if err := decodeJSON(r, &input, 32<<10); err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "密码请求无法读取"})
		return
	}
	if len(input.NewPassword) < 12 || len(input.NewPassword) > 128 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "新密码需要 12–128 个字符"})
		return
	}
	if !verifyPassword(input.CurrentPassword, session.Account.PasswordHash) {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "当前密码错误"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(input.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "密码暂时无法保存"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "密码暂时无法保存"})
		return
	}
	if _, err := tx.ExecContext(r.Context(), `UPDATE galonly_booth_accounts SET password_hash=?,initial_password_ciphertext=NULL,password_changed_at=CURRENT_TIMESTAMP,credential_version=credential_version+1,failed_attempts=0,locked_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`, string(hash), session.Account.ID); err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "密码暂时无法保存"})
		return
	}
	if _, err := tx.ExecContext(r.Context(), "UPDATE galonly_booth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE account_id=? AND revoked_at IS NULL", session.Account.ID); err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "密码暂时无法保存"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "密码暂时无法保存"})
		return
	}
	account := session.Account
	account.PasswordHash = string(hash)
	account.PasswordChangedAt = time.Now().UTC().Format(time.RFC3339)
	account.CredentialVersion++
	token, err := s.issueGalonlyBoothSession(r.Context(), account)
	if err != nil {
		clearGalonlyBoothCookie(w, s.cfg.SessionCookieSecure)
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "密码已保存，请重新登录"})
		return
	}
	setGalonlyBoothCookie(w, token, time.Now().Add(galonlyBoothSessionAge), s.cfg.SessionCookieSecure)
	writeJSON(w, map[string]any{"success": true, "message": "密码已更新"})
}

func (s *Server) galonlyBoothUploadImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !requireBoothSameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	eventID, err := s.galonlyBoothEventID(r.Context(), r.URL.Query().Get("event_code"))
	if err != nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "活动不存在"})
		return
	}
	boothID := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("booth_id")))
	if session, sessionErr := s.loadGalonlyBoothSession(r.Context(), r); sessionErr == nil && session != nil {
		if boothID == "" {
			boothID = session.Account.BoothID
		}
		if boothID != session.Account.BoothID {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "不能上传到其他摊位"})
			return
		}
	} else {
		admin, ok := s.requireBoothAdmin(w, r)
		if !ok {
			return
		}
		_ = admin
		if boothID == "" {
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "管理员上传需要 booth_id"})
			return
		}
	}
	catalog, err := s.ensureGalonlyBoothCatalog(r.Context(), eventID)
	if err != nil {
		s.galonlyBoothStorageError(w, err)
		return
	}
	if _, ok := catalog[boothID]; !ok {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "摊位不在当前已发布地图中"})
		return
	}
	asset := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("asset")))
	if asset == "" {
		asset = "product"
	}
	if asset != "product" && asset != "avatar" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "图片用途无效"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, galonlyBoothImageMax+(256<<10))
	if err := r.ParseMultipartForm(galonlyBoothImageMax + 1<<20); err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "图片上传失败"})
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请选择图片"})
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, galonlyBoothImageMax+1))
	if err != nil || len(data) == 0 || int64(len(data)) > galonlyBoothImageMax {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "图片不能超过 10MB"})
		return
	}
	mimeType := strings.ToLower(strings.TrimSpace(http.DetectContentType(data)))
	if !supportedPublicImageMime(mimeType) {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "仅支持 JPEG、PNG、GIF、WebP 格式"})
		return
	}
	extension := map[string]string{"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp"}[mimeType]
	prefix := "product_"
	if asset == "avatar" {
		prefix = "avatar_"
	}
	filename := prefix + time.Now().UTC().Format("20060102150405") + "_" + randomHex(5) + "." + extension
	relative := "galonly/" + safeUploadID(intString(eventID)) + "/booths/" + safeUploadID(boothID) + "/" + filename
	localURL := "/uploads/" + relative
	stored, err := s.storePublicUploadImage(r.Context(), relative, localURL, filepath.Base(header.Filename), mimeType, "galonly-booth:"+intString(eventID)+":"+boothID+":"+asset, data)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "图片保存失败，请稍后重试"})
		return
	}
	response := storedImageFields(stored)
	response["success"] = true
	response["url"] = stored.URL
	response["path"] = stored.URL
	response["name"] = header.Filename
	response["event_code"] = galonlyMapEventCode
	response["booth_id"] = boothID
	response["asset"] = asset
	writeJSON(w, response)
}

func (s *Server) galonlyBoothMetrics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	eventID, err := s.galonlyBoothEventID(r.Context(), r.URL.Query().Get("event_code"))
	if err != nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "活动不存在"})
		return
	}
	boothID := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("booth_id")))
	if admin, adminErr := s.findBoothAdmin(r.Context(), r); adminErr == nil && admin != nil {
		if boothID == "" {
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "管理员查看统计需要 booth_id"})
			return
		}
	} else {
		session, sessionErr := s.loadGalonlyBoothSession(r.Context(), r)
		if sessionErr != nil || session == nil {
			writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
			return
		}
		boothID = session.Account.BoothID
	}
	if boothID == "" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "缺少 booth_id"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "event_code": galonlyMapEventCode, "booth_id": boothID, "metrics": s.galonlyBoothMetricSummary(r.Context(), eventID, boothID)})
}

func (s *Server) findBoothAdmin(ctx context.Context, r *http.Request) (*user, error) {
	userID, _ := s.optionalSessionUser(r)
	if userID == nil {
		return nil, sql.ErrNoRows
	}
	admin, err := s.findUser(ctx, *userID)
	if err != nil || admin == nil || admin.Role != "super_admin" {
		return nil, sql.ErrNoRows
	}
	return admin, nil
}

func (s *Server) galonlyBoothTrack(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	// Analytics is best effort. Always return 204 so a blocked tracker never
	// changes the map's interaction path or exposes whether a booth exists.
	if err := requireBoothTrackOrigin(r); err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var input galonlyBoothMetricRequest
	if err := decodeJSON(r, &input, galonlyBoothMetricMax); err != nil || !galonlyBoothMetricTypes[input.Metric] {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	eventID, err := s.galonlyBoothEventID(r.Context(), input.EventCode)
	if err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	aliases, err := s.galonlyMapCurrentPublicBoothAliases(r.Context(), eventID)
	if err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	boothID := aliases[strings.ToUpper(strings.TrimSpace(input.BoothID))]
	if boothID == "" || !validGalonlyMetricIdentifier(input.EventUUID, 36) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	productID := strings.TrimSpace(input.ProductID)
	if len(productID) > 96 || strings.ContainsAny(productID, "\r\n\x00") {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	viewerID, _ := s.optionalSessionUser(r)
	visitorID := strings.TrimSpace(input.VisitorID)
	if visitorID == "" && viewerID != nil {
		visitorID = "user:" + intString(*viewerID)
	}
	if visitorID == "" || len(visitorID) > 160 || strings.ContainsAny(visitorID, "\r\n\x00") {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	hashKey := strings.TrimSpace(s.cfg.AnalyticsHashKey)
	if hashKey == "" {
		hashKey = strings.TrimSpace(s.cfg.SessionSecret)
	}
	if hashKey == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	mac := hmac.New(sha256.New, []byte(hashKey))
	_, _ = mac.Write([]byte(visitorID))
	visitorHash := hex.EncodeToString(mac.Sum(nil))
	now := time.Now().UTC()
	insert := `INSERT OR IGNORE INTO galonly_booth_metric_events(event_uuid,event_id,booth_id,metric_type,visitor_hash,product_id,day_key,created_at) VALUES (?,?,?,?,?,?,?,?)`
	if s.db.Driver == "mysql" {
		insert = `INSERT IGNORE INTO galonly_booth_metric_events(event_uuid,event_id,booth_id,metric_type,visitor_hash,product_id,day_key,created_at) VALUES (?,?,?,?,?,?,?,?)`
	}
	_, _ = s.db.ExecContext(r.Context(), insert, strings.ToLower(input.EventUUID), eventID, boothID, input.Metric, visitorHash, boothNullableString(productID), now.Format("2006-01-02"), now)
	if input.Metric == "favorite_on" || input.Metric == "favorite_off" {
		active := 0
		if input.Metric == "favorite_on" {
			active = 1
		}
		userID := any(nil)
		if viewerID != nil {
			userID = *viewerID
		}
		upsert := `INSERT INTO galonly_booth_favorites(event_id,booth_id,visitor_hash,user_id,active,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(event_id,booth_id,visitor_hash) DO UPDATE SET user_id=excluded.user_id,active=excluded.active,updated_at=excluded.updated_at`
		if s.db.Driver == "mysql" {
			upsert = `INSERT INTO galonly_booth_favorites(event_id,booth_id,visitor_hash,user_id,active,updated_at) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),active=VALUES(active),updated_at=VALUES(updated_at)`
		}
		_, _ = s.db.ExecContext(r.Context(), upsert, eventID, boothID, visitorHash, userID, active, now)
	}
	w.WriteHeader(http.StatusNoContent)
}

func requireBoothTrackOrigin(r *http.Request) error {
	if strings.TrimSpace(r.Header.Get("Origin")) == "" && strings.TrimSpace(r.Referer()) == "" {
		return nil
	}
	if sameOrigin(r) {
		return nil
	}
	return errors.New("invalid origin")
}

func validGalonlyMetricIdentifier(value string, max int) bool {
	value = strings.TrimSpace(value)
	if len(value) == 0 || len(value) > max || strings.ContainsAny(value, "\r\n\x00") {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || strings.ContainsRune("-", char) {
			continue
		}
		return false
	}
	return true
}

func (s *Server) galonlyBoothMetricSummary(ctx context.Context, eventID int64, boothID string) map[string]any {
	result := map[string]any{
		"detail_views": int64(0), "unique_viewers": int64(0), "favorites": int64(0),
		"contact_clicks": int64(0), "product_clicks": int64(0),
		"trend": []map[string]any{}, "top_products": []map[string]any{},
	}
	queries := []struct {
		key   string
		query string
	}{
		{"detail_views", "SELECT COUNT(*) FROM galonly_booth_metric_events WHERE event_id=? AND booth_id=? AND metric_type='detail_view'"},
		{"unique_viewers", "SELECT COUNT(DISTINCT visitor_hash) FROM galonly_booth_metric_events WHERE event_id=? AND booth_id=?"},
		{"contact_clicks", "SELECT COUNT(*) FROM galonly_booth_metric_events WHERE event_id=? AND booth_id=? AND metric_type='contact_click'"},
		{"product_clicks", "SELECT COUNT(*) FROM galonly_booth_metric_events WHERE event_id=? AND booth_id=? AND metric_type='product_click'"},
	}
	for _, item := range queries {
		var count int64
		if err := s.db.QueryRowContext(ctx, item.query, eventID, strings.ToUpper(strings.TrimSpace(boothID))).Scan(&count); err == nil {
			result[item.key] = count
		}
	}
	var favorites int64
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM galonly_booth_favorites WHERE event_id=? AND booth_id=? AND active=1", eventID, strings.ToUpper(strings.TrimSpace(boothID))).Scan(&favorites); err == nil {
		result["favorites"] = favorites
	}
	start := time.Now().UTC().AddDate(0, 0, -29).Format("2006-01-02")
	rows, err := s.db.QueryContext(ctx, `SELECT day_key,metric_type,COUNT(*) FROM galonly_booth_metric_events WHERE event_id=? AND booth_id=? AND day_key>=? GROUP BY day_key,metric_type ORDER BY day_key ASC`, eventID, strings.ToUpper(strings.TrimSpace(boothID)), start)
	if err == nil {
		trend := []map[string]any{}
		for rows.Next() {
			var day, metric string
			var count int64
			if rows.Scan(&day, &metric, &count) == nil {
				trend = append(trend, map[string]any{"day": day, "metric_type": metric, "count": count})
			}
		}
		_ = rows.Close()
		result["trend"] = trend
	}
	productRows, err := s.db.QueryContext(ctx, `SELECT product_id,COUNT(*) FROM galonly_booth_metric_events WHERE event_id=? AND booth_id=? AND metric_type='product_click' AND product_id IS NOT NULL AND product_id<>'' GROUP BY product_id ORDER BY COUNT(*) DESC LIMIT 12`, eventID, strings.ToUpper(strings.TrimSpace(boothID)))
	if err == nil {
		top := []map[string]any{}
		for productRows.Next() {
			var id string
			var count int64
			if productRows.Scan(&id, &count) == nil {
				top = append(top, map[string]any{"product_id": id, "clicks": count})
			}
		}
		_ = productRows.Close()
		result["top_products"] = top
	}
	return result
}

func syncGalonlyBoothFavoritesForUser(ctx context.Context, db *sqlstore.DB, eventID, userID int64, favorites []string, aliases map[string]string, analyticsKey string) error {
	if db == nil || userID <= 0 || strings.TrimSpace(analyticsKey) == "" {
		return nil
	}
	hash := hmac.New(sha256.New, []byte(analyticsKey))
	_, _ = hash.Write([]byte("user:" + intString(userID)))
	visitorHash := hex.EncodeToString(hash.Sum(nil))
	if _, err := db.ExecContext(ctx, "UPDATE galonly_booth_favorites SET active=0,updated_at=CURRENT_TIMESTAMP WHERE event_id=? AND visitor_hash=?", eventID, visitorHash); err != nil {
		if boothPortalTableMissing(err) {
			return nil
		}
		return err
	}
	seen := map[string]bool{}
	for _, raw := range favorites {
		canonical := strings.ToUpper(strings.TrimSpace(raw))
		if aliases != nil {
			canonical = aliases[canonical]
		}
		if canonical == "" || seen[canonical] {
			continue
		}
		seen[canonical] = true
		userIDValue := userID
		upsert := `INSERT INTO galonly_booth_favorites(event_id,booth_id,visitor_hash,user_id,active,updated_at) VALUES (?,?,?,?,1,CURRENT_TIMESTAMP) ON CONFLICT(event_id,booth_id,visitor_hash) DO UPDATE SET user_id=excluded.user_id,active=1,updated_at=CURRENT_TIMESTAMP`
		if db.Driver == "mysql" {
			upsert = `INSERT INTO galonly_booth_favorites(event_id,booth_id,visitor_hash,user_id,active,updated_at) VALUES (?,?,?,?,1,CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),active=1,updated_at=CURRENT_TIMESTAMP`
		}
		if _, err := db.ExecContext(ctx, upsert, eventID, canonical, visitorHash, userIDValue); err != nil && !boothPortalTableMissing(err) {
			return err
		}
	}
	return nil
}

func (s *Server) syncGalonlyBoothFavorites(ctx context.Context, eventID, userID int64, favorites []string, aliases map[string]string) {
	key := strings.TrimSpace(s.cfg.AnalyticsHashKey)
	if key == "" {
		key = strings.TrimSpace(s.cfg.SessionSecret)
	}
	_ = syncGalonlyBoothFavoritesForUser(ctx, s.db, eventID, userID, favorites, aliases, key)
}

func boothTimeFuture(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return false
	}
	layouts := []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05.999999999", "2006-01-02 15:04:05"}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.After(time.Now())
		}
	}
	return false
}
