package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	galonlyMapEventCode = "beijing"
	galonlyMapMaxJSON   = 8 << 20
	galonlyMapMaxBooths = 63
)

var (
	galonlyMapColorPattern      = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	galonlyMapIDPattern         = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`)
	galonlyMapBoothKeyPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	galonlyMapCategoryIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
)

type galonlyMapProjectInput struct {
	EventCode      string                    `json:"event_code"`
	BaseRev        int64                     `json:"base_revision"`
	BaseChecksum   string                    `json:"base_checksum_sha256"`
	SourceName     string                    `json:"source_name"`
	Project        json.RawMessage           `json:"project"`
	ProfileUpdates []galonlyMapProfileUpdate `json:"profile_updates"`
}

// A map save may include edited public profiles, but never application state.
// Profile versions make a stale map tab fail instead of silently overwriting a
// booth owner's newer portal save.
type galonlyMapProfileUpdate struct {
	BoothID     string         `json:"booth_id"`
	BaseVersion int64          `json:"base_version"`
	Profile     map[string]any `json:"profile"`
}

type galonlyMapStateInput struct {
	EventCode       string   `json:"event_code"`
	FavoriteBooths  []string `json:"favorite_booth_ids"`
	SelectedBoothID string   `json:"selected_booth_id"`
}

func (s *Server) galonlyMap(w http.ResponseWriter, r *http.Request, action string) {
	switch action {
	case "map_public":
		s.galonlyMapPublic(w, r)
	case "map_capability":
		s.galonlyMapCapability(w, r)
	case "map_admin":
		s.galonlyMapAdmin(w, r)
	case "map_save":
		s.galonlyMapSave(w, r)
	case "map_save_draft", "map_publish":
		// Draft/publish was a two-write protocol without a current-version lock.
		// Keeping it writable lets a stale static page republish historic maps.
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "地图编辑器已升级：请刷新页面后使用“保存地图”。旧草稿/发布接口已停止写入。", "code": "map_editor_upgrade_required"})
	case "map_export":
		s.galonlyMapExport(w, r)
	case "map_state":
		s.galonlyMapState(w, r)
	case "map_upload_image":
		s.galonlyMapUploadImage(w, r)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知地图动作"})
	}
}

// galonlyMapUploadImage is deliberately separate from the application upload
// endpoint. Map product images are public map content and may use the existing
// PicUI integration immediately; application/review uploads remain local until
// their application is approved and promoted.
func (s *Server) galonlyMapUploadImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !requireBoothSameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	_, eventID, err := s.galonlyMapEvent(r.Context(), r.URL.Query().Get("event_code"))
	if err != nil {
		s.galonlyMapEventError(w, err)
		return
	}
	canEdit, reviewRole := s.galonlyCanReview(r.Context(), eventID, user)
	if !canEdit {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "没有北京活动地图审核权限"})
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

	const limit = int64(10 << 20)
	r.Body = http.MaxBytesReader(w, r.Body, limit+(256<<10))
	if err := r.ParseMultipartForm(limit + 1<<20); err != nil {
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
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit || len(data) == 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "图片不能超过 10MB"})
		return
	}
	mimeType := strings.ToLower(strings.TrimSpace(http.DetectContentType(data)))
	if !supportedPublicImageMime(mimeType) {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "仅支持 JPEG、PNG、GIF、WebP 格式"})
		return
	}
	ext := map[string]string{"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp"}[mimeType]
	prefix := "map_"
	if asset == "avatar" {
		prefix = "avatar_"
	}
	name := prefix + safeUploadID(intString(eventID)) + "_" + time.Now().Format("20060102150405") + "_" + randomHex(5) + "." + ext
	directory := "galonly/" + safeUploadID(intString(eventID))
	relative := directory + "/" + name
	localURL := "/uploads/" + relative
	stored, err := s.storePublicUploadImage(r.Context(), relative, localURL, header.Filename, mimeType, "galonly-map:"+galonlyMapEventCode+":"+asset, data)
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
	response["review_role"] = reviewRole
	response["asset"] = asset
	writeJSON(w, response)
}

func (s *Server) galonlyMapPublic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	event, eventID, err := s.galonlyMapEvent(r.Context(), r.URL.Query().Get("event_code"))
	if err != nil {
		s.galonlyMapEventError(w, err)
		return
	}
	viewerID, _ := s.optionalSessionUser(r)
	state := map[string]any{"logged_in": viewerID != nil, "favorite_booth_ids": []string{}, "selected_booth_id": nil}
	if viewerID != nil {
		state = s.galonlyMapUserState(r.Context(), eventID, *viewerID)
	}

	response := map[string]any{
		"success":               true,
		"event":                 galonlyMapPublicEvent(event),
		"event_code":            galonlyMapEventCode,
		"map_status":            "unpublished",
		"map":                   nil,
		"published_booth_count": 0,
		"published_table_count": 0,
		"viewer_state":          galonlyMapFilterState(state, map[string]string{}),
	}
	document, err := s.galonlyMapDocument(r.Context(), `SELECT id,event_id,revision,status,schema_version,payload_json,checksum_sha256,source_name,created_by,created_at,published_by,published_at FROM galonly_map_documents WHERE event_id=? AND status='published' ORDER BY revision DESC LIMIT 1`, eventID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取已发布地图失败"})
		return
	}
	if err == nil {
		project, projectErr := galonlyMapProjectFromDocument(document)
		if projectErr != nil {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "已发布地图数据无效"})
			return
		}
		if !galonlyMapProjectIsDemo(project) {
			publicProject, boothCount, tableCount, filterErr := s.galonlyMapPublicProject(r.Context(), eventID, project)
			if filterErr != nil {
				writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取公开摊位资料失败"})
				return
			}
			response["map_status"] = "published"
			response["published_booth_count"] = boothCount
			response["published_table_count"] = tableCount
			response["map"] = map[string]any{
				"project": publicProject,
			}
			response["viewer_state"] = galonlyMapFilterState(state, galonlyMapProjectBoothAliases(publicProject))
		}
	}
	writeJSON(w, response)
}

func (s *Server) galonlyMapCapability(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	_, eventID, err := s.galonlyMapEvent(r.Context(), r.URL.Query().Get("event_code"))
	if err != nil {
		s.galonlyMapEventError(w, err)
		return
	}
	userID, _ := s.optionalSessionUser(r)
	var viewer *user
	if userID != nil {
		viewer, _ = s.findUser(r.Context(), *userID)
	}
	canEdit, reviewRole := s.galonlyCanReview(r.Context(), eventID, viewer)
	response := map[string]any{
		"success":     true,
		"event_code":  galonlyMapEventCode,
		"logged_in":   userID != nil,
		"can_edit":    canEdit,
		"review_role": nil,
	}
	if reviewRole != "" {
		response["review_role"] = reviewRole
	}
	writeJSON(w, response)
}

func (s *Server) galonlyMapAdmin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	event, eventID, err := s.galonlyMapEvent(r.Context(), r.URL.Query().Get("event_code"))
	if err != nil {
		s.galonlyMapEventError(w, err)
		return
	}
	canEdit, reviewRole := s.galonlyCanReview(r.Context(), eventID, user)
	if !canEdit {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "没有北京活动地图审核权限"})
		return
	}
	documents, err := s.galonlyMapDocuments(r.Context(), eventID)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取地图版本失败"})
		return
	}
	var published map[string]any
	versions := make([]map[string]any, 0, len(documents))
	for _, document := range documents {
		versions = append(versions, galonlyMapVersionResponse(document))
		project, projectErr := galonlyMapProjectFromDocument(document)
		if projectErr != nil {
			continue
		}
		if published == nil && stringValue(document["status"]) == "published" {
			publicProject, _, _, publicErr := s.galonlyMapPublicProject(r.Context(), eventID, project)
			if publicErr != nil {
				writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取当前地图资料失败"})
				return
			}
			if publicErr = s.galonlyMapAttachProfileVersions(r.Context(), eventID, publicProject); publicErr != nil {
				writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取当前摊位资料版本失败"})
				return
			}
			published = galonlyMapDocumentResponse(document, publicProject)
		}
	}
	writeJSON(w, map[string]any{
		"success":     true,
		"event":       event,
		"event_code":  galonlyMapEventCode,
		"can_edit":    true,
		"review_role": reviewRole,
		"draft":       nil,
		"published":   published,
		"versions":    versions,
	})
}

// Profile versions are only returned by the authenticated map-admin endpoint.
// The editor returns them in profile_updates so portal and map edits share the
// same optimistic-lock boundary.
func (s *Server) galonlyMapAttachProfileVersions(ctx context.Context, eventID int64, project map[string]any) error {
	rows, err := s.db.QueryContext(ctx, `SELECT booth_id,profile_version FROM galonly_booth_profiles
        WHERE event_id=? AND visibility_state='active'`, eventID)
	if err != nil {
		return err
	}
	defer rows.Close()
	versions := map[string]int64{}
	for rows.Next() {
		var boothID string
		var version int64
		if err := rows.Scan(&boothID, &version); err != nil {
			return err
		}
		versions[strings.ToUpper(strings.TrimSpace(boothID))] = version
	}
	if err := rows.Err(); err != nil {
		return err
	}
	catalog, _ := project["catalog"].(map[string]any)
	items, _ := catalog["booths"].([]any)
	for _, raw := range items {
		if booth, ok := raw.(map[string]any); ok {
			if version, exists := versions[strings.ToUpper(strings.TrimSpace(stringValue(booth["id"])))]; exists {
				booth["profileVersion"] = version
			}
		}
	}
	return nil
}

// galonlyMapSave is the sole mutable map endpoint. It validates the exact
// published revision/checksum under a transaction, promotes the replacement
// layout immediately, and archives the previous revision. There is no draft
// state to accidentally republish from an old browser tab.
func (s *Server) galonlyMapSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !requireBoothSameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	var input galonlyMapProjectInput
	if err := decodeJSON(r, &input, galonlyMapMaxJSON); err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "地图项目 JSON 无法读取"})
		return
	}
	event, eventID, err := s.galonlyMapEvent(r.Context(), input.EventCode)
	if err != nil {
		s.galonlyMapEventError(w, err)
		return
	}
	canEdit, reviewRole := s.galonlyCanReview(r.Context(), eventID, user)
	if !canEdit {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "没有北京活动地图审核权限"})
		return
	}
	if len(input.Project) == 0 || len(input.Project) > galonlyMapMaxJSON {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "缺少完整地图项目，或项目超过 8 MB 限制"})
		return
	}
	project, err := validateGalonlyMapProject(input.Project, false)
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": err.Error()})
		return
	}
	layout, err := galonlyMapLayoutProject(project)
	if err != nil {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "message": err.Error()})
		return
	}
	payload, err := json.Marshal(layout)
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "地图布局无法规范化"})
		return
	}
	checksum := galonlyMapChecksum(payload)
	sourceName := galonlyMapSourceName(input.SourceName)
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "无法开始保存地图"})
		return
	}
	defer tx.Rollback()
	current, err := s.galonlyMapCurrentPublishedTx(r.Context(), tx, eventID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取当前地图版本失败"})
		return
	}
	if errors.Is(err, sql.ErrNoRows) {
		if input.BaseRev != 0 || strings.TrimSpace(input.BaseChecksum) != "" {
			writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "当前地图尚未初始化，请刷新当前地图后再保存", "code": "map_version_conflict"})
			return
		}
	} else if input.BaseRev != integerValue(current["revision"]) || strings.TrimSpace(input.BaseChecksum) != strings.TrimSpace(stringValue(current["checksum_sha256"])) {
		writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "已有管理员保存了新版本；请刷新当前地图后再决定如何处理本地编辑。", "code": "map_version_conflict", "current_revision": integerValue(current["revision"]), "current_checksum_sha256": stringValue(current["checksum_sha256"])})
		return
	}
	var currentProject map[string]any
	if current != nil {
		currentProject, err = galonlyMapProjectFromDocument(current)
		if err != nil {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取当前地图布局失败"})
			return
		}
	}
	if tableID := galonlyMapExpandedTableConflict(currentProject, layout); tableID != "" {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{
			"success": false,
			"message": fmt.Sprintf("实体桌位 %s 形成了新的重复占用；请保留原历史归属或先合并冲突摊位", tableID),
			"code":    "map_table_conflict_expanded",
		})
		return
	}
	if err := s.galonlyMapSeedLegacyProfilesTx(r.Context(), tx, eventID, project, user.ID); err != nil {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "message": err.Error()})
		return
	}
	if err := s.galonlyMapSaveProfilesTx(r.Context(), tx, eventID, layout, input.ProfileUpdates, user.ID); err != nil {
		if errors.Is(err, errGalonlyMapProfileConflict) {
			writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "有摊位资料已被其他管理员或摊主更新；请刷新当前地图。", "code": "profile_version_conflict"})
		} else {
			writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "message": err.Error()})
		}
		return
	}
	if current != nil {
		if _, err = tx.ExecContext(r.Context(), "UPDATE galonly_map_documents SET status='archived' WHERE id=?", integerValue(current["id"])); err != nil {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "归档旧地图版本失败"})
			return
		}
	}
	nextRevision, err := s.galonlyMapNextRevision(r.Context(), tx, s.db.Driver, eventID)
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO galonly_map_documents
            (event_id,revision,status,schema_version,payload_json,checksum_sha256,source_name,created_by,published_by,published_at)
            VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`, eventID, nextRevision, "published", 6, string(payload), checksum, sourceName, user.ID, user.ID)
	}
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "保存地图失败"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "提交地图保存失败"})
		return
	}
	publicProject, _, _, _ := s.galonlyMapPublicProject(r.Context(), eventID, layout)
	s.recordGalonlyMapAudit(r.Context(), r, user, eventID, nextRevision, "map_save", checksum, sourceName, reviewRole)
	writeJSON(w, map[string]any{"success": true, "event": event, "event_code": galonlyMapEventCode, "revision": nextRevision, "checksum_sha256": checksum, "source_name": sourceName, "project": publicProject})
}

func (s *Server) galonlyMapSaveDraft(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !requireBoothSameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	var input galonlyMapProjectInput
	if err := decodeJSON(r, &input, galonlyMapMaxJSON); err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "地图项目 JSON 无法读取"})
		return
	}
	event, eventID, err := s.galonlyMapEvent(r.Context(), input.EventCode)
	if err != nil {
		s.galonlyMapEventError(w, err)
		return
	}
	canEdit, reviewRole := s.galonlyCanReview(r.Context(), eventID, user)
	if !canEdit {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "没有北京活动地图审核权限"})
		return
	}
	if len(input.Project) == 0 || len(input.Project) > galonlyMapMaxJSON {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "缺少完整地图项目，或项目超过 8 MB 限制"})
		return
	}
	project, err := validateGalonlyMapProject(input.Project, true)
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": err.Error()})
		return
	}
	payload, err := json.Marshal(project)
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "地图项目无法规范化"})
		return
	}
	checksum := galonlyMapChecksum(payload)
	sourceName := galonlyMapSourceName(input.SourceName)
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "无法开始保存地图草稿"})
		return
	}
	if input.BaseRev > 0 {
		var exists int
		if err := tx.QueryRowContext(r.Context(), "SELECT 1 FROM galonly_map_documents WHERE event_id=? AND revision=? LIMIT 1", eventID, input.BaseRev).Scan(&exists); err != nil {
			_ = tx.Rollback()
			if errors.Is(err, sql.ErrNoRows) {
				writeJSONStatus(w, http.StatusConflict, map[string]any{"success": false, "message": "地图基准版本不存在，请重新读取版本"})
			} else {
				writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取地图基准版本失败"})
			}
			return
		}
	}
	nextRevision, err := s.galonlyMapNextRevision(r.Context(), tx, s.db.Driver, eventID)
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO galonly_map_documents
            (event_id,revision,status,schema_version,payload_json,checksum_sha256,source_name,created_by)
            VALUES (?,?,?,?,?,?,?,?)`, eventID, nextRevision, "draft", 5, string(payload), checksum, sourceName, user.ID)
	}
	if err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "保存地图草稿失败"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "提交地图草稿失败"})
		return
	}
	s.recordGalonlyMapAudit(r.Context(), r, user, eventID, nextRevision, "map_save_draft", checksum, sourceName, reviewRole)
	writeJSON(w, map[string]any{
		"success": true, "event": event, "event_code": galonlyMapEventCode,
		"revision": nextRevision, "checksum_sha256": checksum, "source_name": sourceName, "project": project,
	})
}

func (s *Server) galonlyMapPublish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !requireBoothSameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	var input struct {
		EventCode string `json:"event_code"`
		Revision  int64  `json:"revision"`
	}
	if err := decodeJSON(r, &input, 64<<10); err != nil || input.Revision <= 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "请选择要发布的地图草稿版本"})
		return
	}
	event, eventID, err := s.galonlyMapEvent(r.Context(), input.EventCode)
	if err != nil {
		s.galonlyMapEventError(w, err)
		return
	}
	canEdit, reviewRole := s.galonlyCanReview(r.Context(), eventID, user)
	if !canEdit {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "没有北京活动地图审核权限"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "无法开始发布地图"})
		return
	}
	var document map[string]any
	rows, queryErr := tx.QueryContext(r.Context(), `SELECT id,event_id,revision,status,schema_version,payload_json,checksum_sha256,source_name,created_by,created_at,published_by,published_at
        FROM galonly_map_documents WHERE event_id=? AND revision=? LIMIT 1`, eventID, input.Revision)
	if queryErr == nil {
		document, queryErr = galonlyMapScanRows(rows)
	}
	if queryErr != nil {
		_ = tx.Rollback()
		if errors.Is(queryErr, sql.ErrNoRows) {
			writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "地图版本不存在"})
		} else {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取地图版本失败"})
		}
		return
	}
	project, err := galonlyMapProjectFromDocument(document)
	if err == nil {
		if galonlyMapProjectIsDemo(project) {
			err = fmt.Errorf("虚构 demo 项目不能发布")
		}
	}
	if err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": err.Error()})
		return
	}
	if _, err = tx.ExecContext(r.Context(), "UPDATE galonly_map_documents SET status='archived' WHERE event_id=? AND status IN ('published','draft') AND revision<>?", eventID, input.Revision); err == nil {
		_, err = tx.ExecContext(r.Context(), "UPDATE galonly_map_documents SET status='published',published_by=?,published_at=CURRENT_TIMESTAMP WHERE event_id=? AND revision=?", user.ID, eventID, input.Revision)
	}
	if err != nil {
		_ = tx.Rollback()
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "发布地图失败"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "提交地图发布失败"})
		return
	}
	checksum := stringValue(document["checksum_sha256"])
	sourceName := stringValue(document["source_name"])
	s.recordGalonlyMapAudit(r.Context(), r, user, eventID, input.Revision, "map_publish", checksum, sourceName, reviewRole)
	writeJSON(w, map[string]any{
		"success": true, "event": event, "event_code": galonlyMapEventCode,
		"revision": input.Revision, "checksum_sha256": checksum, "project": project,
	})
}

func (s *Server) galonlyMapExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	_, eventID, err := s.galonlyMapEvent(r.Context(), r.URL.Query().Get("event_code"))
	if err != nil {
		s.galonlyMapEventError(w, err)
		return
	}
	canEdit, reviewRole := s.galonlyCanReview(r.Context(), eventID, user)
	if !canEdit {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "没有北京活动地图审核权限"})
		return
	}
	var document map[string]any
	revision := parsePositiveInt(r.URL.Query().Get("revision"))
	if revision > 0 {
		document, err = s.galonlyMapDocument(r.Context(), `SELECT id,event_id,revision,status,schema_version,payload_json,checksum_sha256,source_name,created_by,created_at,published_by,published_at
            FROM galonly_map_documents WHERE event_id=? AND revision=? LIMIT 1`, eventID, revision)
	} else {
		status := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("status")))
		if status == "draft" || status == "published" {
			document, err = s.galonlyMapDocument(r.Context(), `SELECT id,event_id,revision,status,schema_version,payload_json,checksum_sha256,source_name,created_by,created_at,published_by,published_at
                FROM galonly_map_documents WHERE event_id=? AND status=? ORDER BY revision DESC LIMIT 1`, eventID, status)
		} else {
			document, err = s.galonlyMapDocument(r.Context(), `SELECT id,event_id,revision,status,schema_version,payload_json,checksum_sha256,source_name,created_by,created_at,published_by,published_at
                FROM galonly_map_documents WHERE event_id=? AND status='draft' ORDER BY revision DESC LIMIT 1`, eventID)
			if errors.Is(err, sql.ErrNoRows) {
				document, err = s.galonlyMapDocument(r.Context(), `SELECT id,event_id,revision,status,schema_version,payload_json,checksum_sha256,source_name,created_by,created_at,published_by,published_at
                    FROM galonly_map_documents WHERE event_id=? AND status='published' ORDER BY revision DESC LIMIT 1`, eventID)
			}
		}
	}
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "没有可导出的地图版本"})
		} else {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取地图导出版本失败"})
		}
		return
	}
	project, err := galonlyMapProjectFromDocument(document)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "地图版本数据无效"})
		return
	}
	payload, _ := json.Marshal(project)
	s.recordGalonlyMapAudit(r.Context(), r, user, eventID, integerValue(document["revision"]), "map_export", stringValue(document["checksum_sha256"]), stringValue(document["source_name"]), reviewRole)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="beijing-galonly-map-v%d.json"`, integerValue(document["revision"])))
	_, _ = w.Write(payload)
}

func (s *Server) galonlyMapState(w http.ResponseWriter, r *http.Request) {
	_, eventID, err := s.galonlyMapEvent(r.Context(), r.URL.Query().Get("event_code"))
	if err != nil {
		s.galonlyMapEventError(w, err)
		return
	}
	viewerID, _ := s.optionalSessionUser(r)
	if r.Method == http.MethodGet {
		if viewerID == nil {
			writeJSON(w, map[string]any{"success": true, "logged_in": false, "favorite_booth_ids": []string{}, "selected_booth_id": nil})
			return
		}
		state := s.galonlyMapUserState(r.Context(), eventID, *viewerID)
		state = galonlyMapFilterState(state, func() map[string]string {
			aliases, _ := s.galonlyMapCurrentPublicBoothAliases(r.Context(), eventID)
			if favorites, ok := state["favorite_booth_ids"].([]string); ok {
				s.syncGalonlyBoothFavorites(r.Context(), eventID, *viewerID, favorites, aliases)
			}
			return aliases
		}())
		state["success"] = true
		state["logged_in"] = true
		writeJSON(w, state)
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPost)
		return
	}
	if !requireBoothSameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	if viewerID == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "logged_in": false, "message": "登录后才能同步地图清单"})
		return
	}
	var input galonlyMapStateInput
	if err := decodeJSON(r, &input, 64<<10); err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "地图清单无法读取"})
		return
	}
	if input.EventCode != "" && strings.ToLower(strings.TrimSpace(input.EventCode)) != galonlyMapEventCode {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "活动标识无效"})
		return
	}
	publicAliases, err := s.galonlyMapCurrentPublicBoothAliases(r.Context(), eventID)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取公开地图状态失败"})
		return
	}
	favorites, err := galonlyMapStateIDs(input.FavoriteBooths, publicAliases)
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": err.Error()})
		return
	}
	selected := strings.TrimSpace(input.SelectedBoothID)
	if selected != "" {
		selected = publicAliases[selected]
	}
	if input.SelectedBoothID != "" && selected == "" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "最后选中的摊位不在北京已发布地图中"})
		return
	}
	favoriteJSON, _ := json.Marshal(favorites)
	var upsert string
	if s.db.Driver == "mysql" {
		upsert = `INSERT INTO galonly_map_user_state (event_id,user_id,favorite_booths_json,selected_booth_id)
            VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE favorite_booths_json=VALUES(favorite_booths_json),selected_booth_id=VALUES(selected_booth_id),updated_at=CURRENT_TIMESTAMP`
	} else {
		upsert = `INSERT INTO galonly_map_user_state (event_id,user_id,favorite_booths_json,selected_booth_id)
            VALUES (?,?,?,?) ON CONFLICT(event_id,user_id) DO UPDATE SET favorite_booths_json=excluded.favorite_booths_json,selected_booth_id=excluded.selected_booth_id,updated_at=CURRENT_TIMESTAMP`
	}
	if _, err := s.db.ExecContext(r.Context(), upsert, eventID, *viewerID, string(favoriteJSON), galonlyMapNullableString(selected)); err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "服务器清单同步失败，请保留本机清单"})
		return
	}
	s.syncGalonlyBoothFavorites(r.Context(), eventID, *viewerID, favorites, publicAliases)
	writeJSON(w, map[string]any{"success": true, "logged_in": true, "favorite_booth_ids": favorites, "selected_booth_id": galonlyMapNullableString(selected)})
}

func (s *Server) galonlyMapEvent(ctx context.Context, requestedCode string) (map[string]any, int64, error) {
	code := strings.ToLower(strings.TrimSpace(requestedCode))
	if code == "" {
		code = galonlyMapEventCode
	}
	if code != galonlyMapEventCode {
		return nil, 0, fmt.Errorf("地图接口只支持 event_code=beijing")
	}
	rows, err := s.queryMaps(ctx, `SELECT id,name,location,date,event_code,COALESCE(description,'') AS description FROM galonly_events WHERE event_code=? LIMIT 1`, galonlyMapEventCode)
	if err != nil {
		return nil, 0, err
	}
	if len(rows) == 0 {
		return nil, 0, sql.ErrNoRows
	}
	event := rows[0]
	eventID := integerValue(event["id"])
	if eventID <= 0 {
		return nil, 0, fmt.Errorf("北京活动 ID 无效")
	}
	event["id"] = eventID
	event["event_code"] = galonlyMapEventCode
	event["date"] = galonlyMapJSONValue(event["date"])
	return event, eventID, nil
}

func galonlyMapPublicEvent(event map[string]any) map[string]any {
	public := map[string]any{"event_code": galonlyMapEventCode}
	for _, key := range []string{"name", "location", "date", "description"} {
		if value, ok := event[key]; ok {
			public[key] = value
		}
	}
	return public
}

func (s *Server) galonlyMapEventError(w http.ResponseWriter, err error) {
	if errors.Is(err, sql.ErrNoRows) {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "北京活动不存在"})
		return
	}
	if strings.Contains(err.Error(), "只支持") {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": err.Error()})
		return
	}
	writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取北京活动失败"})
}

func (s *Server) galonlyMapDocuments(ctx context.Context, eventID int64) ([]map[string]any, error) {
	rows, err := s.queryMaps(ctx, `SELECT id,event_id,revision,status,schema_version,payload_json,checksum_sha256,source_name,created_by,created_at,published_by,published_at
        FROM galonly_map_documents WHERE event_id=? ORDER BY revision DESC LIMIT 100`, eventID)
	return rows, err
}

func (s *Server) galonlyMapDocument(ctx context.Context, query string, args ...any) (map[string]any, error) {
	rows, err := s.queryMaps(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, sql.ErrNoRows
	}
	return rows[0], nil
}

func galonlyMapScanRows(rows *sql.Rows) (map[string]any, error) {
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, sql.ErrNoRows
	}
	values := make([]any, len(columns))
	pointers := make([]any, len(columns))
	for i := range values {
		pointers[i] = &values[i]
	}
	if err := rows.Scan(pointers...); err != nil {
		return nil, err
	}
	result := make(map[string]any, len(columns))
	for i, value := range values {
		if raw, ok := value.([]byte); ok {
			result[columns[i]] = string(raw)
		} else {
			result[columns[i]] = value
		}
	}
	return result, nil
}

func (s *Server) galonlyMapUserState(ctx context.Context, eventID, userID int64) map[string]any {
	state := map[string]any{"logged_in": true, "favorite_booth_ids": []string{}, "selected_booth_id": nil}
	var favoriteJSON, selected sql.NullString
	err := s.db.QueryRowContext(ctx, "SELECT favorite_booths_json,selected_booth_id FROM galonly_map_user_state WHERE event_id=? AND user_id=?", eventID, userID).Scan(&favoriteJSON, &selected)
	if err != nil {
		return state
	}
	var favorites []string
	if favoriteJSON.Valid {
		_ = json.Unmarshal([]byte(favoriteJSON.String), &favorites)
	}
	favorites, _ = galonlyMapStateIDs(favorites, nil)
	state["favorite_booth_ids"] = favorites
	if selected.Valid && strings.TrimSpace(selected.String) != "" {
		state["selected_booth_id"] = strings.TrimSpace(selected.String)
	}
	return state
}

func galonlyMapFilterState(state map[string]any, aliases map[string]string) map[string]any {
	result := map[string]any{
		"logged_in":          state["logged_in"] == true,
		"favorite_booth_ids": []string{},
		"selected_booth_id":  nil,
	}
	if favorites, ok := state["favorite_booth_ids"].([]string); ok {
		filtered := make([]string, 0, len(favorites))
		seen := map[string]bool{}
		for _, id := range favorites {
			if canonical := aliases[id]; canonical != "" && !seen[canonical] {
				seen[canonical] = true
				filtered = append(filtered, canonical)
			}
		}
		result["favorite_booth_ids"] = filtered
	}
	if selected := strings.TrimSpace(stringValue(state["selected_booth_id"])); selected != "" && aliases[selected] != "" {
		result["selected_booth_id"] = aliases[selected]
	}
	return result
}

func (s *Server) galonlyMapCurrentPublicBoothAliases(ctx context.Context, eventID int64) (map[string]string, error) {
	document, err := s.galonlyMapDocument(ctx, `SELECT id,event_id,revision,status,schema_version,payload_json,checksum_sha256,source_name,created_by,created_at,published_by,published_at
        FROM galonly_map_documents WHERE event_id=? AND status='published' ORDER BY revision DESC LIMIT 1`, eventID)
	if errors.Is(err, sql.ErrNoRows) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	project, err := galonlyMapProjectFromDocument(document)
	if err != nil || galonlyMapProjectIsDemo(project) {
		return map[string]string{}, err
	}
	publicProject, _, _, err := s.galonlyMapPublicProject(ctx, eventID, project)
	if err != nil {
		return nil, err
	}
	return galonlyMapProjectBoothAliases(publicProject), nil
}

func (s *Server) galonlyMapPublicProject(ctx context.Context, eventID int64, project map[string]any) (map[string]any, int, int, error) {
	cloned := galonlyMapClone(project)
	catalog, ok := cloned["catalog"].(map[string]any)
	if !ok {
		return nil, 0, 0, fmt.Errorf("地图缺少 catalog")
	}
	items, ok := catalog["booths"].([]any)
	if !ok {
		return nil, 0, 0, fmt.Errorf("地图缺少 booths")
	}
	profiles, err := s.galonlyMapActiveProfiles(ctx, eventID)
	if err != nil {
		return nil, 0, 0, err
	}
	publicBooths := make([]any, 0, len(items))
	for _, item := range items {
		booth, ok := item.(map[string]any)
		if !ok {
			return nil, 0, 0, fmt.Errorf("摊位数据无效")
		}
		copyBooth := galonlyMapClone(booth)
		// applicationId remains accepted only when reading a legacy map document;
		// it is never a public link to review data.
		delete(copyBooth, "applicationId")
		boothID := strings.ToUpper(strings.TrimSpace(stringValue(copyBooth["id"])))
		if profile, exists := profiles[boothID]; exists {
			for _, key := range galonlyBoothProfileFields {
				// Layout owns colors. The profile schema keeps a historical color
				// field for portal compatibility, but it cannot move/recolor a table.
				if key == "color" {
					continue
				}
				if value, found := profile[key]; found {
					copyBooth[key] = galonlyMapCloneValue(value)
				}
			}
			delete(copyBooth, "placeholder")
			delete(copyBooth, "reserved")
		} else if mapInt64(project["schemaVersion"]) == 6 {
			// A v6 layout has no mutable placeholder field. Public state is derived
			// from a layout reservation and active profile availability.
			copyBooth = galonlyMapPublicPlaceholderBooth(copyBooth)
			delete(copyBooth, "reserved")
		} else if placeholder, _ := booth["placeholder"].(bool); placeholder && galonlyMapPublicPlaceholderIsBlank(copyBooth) {
			continue
		}
		publicBooths = append(publicBooths, copyBooth)
	}
	catalog["booths"] = publicBooths
	cloned["catalog"] = catalog
	return cloned, len(publicBooths), galonlyMapProjectTableCount(cloned), nil
}

func galonlyMapPublicPlaceholderBooth(layout map[string]any) map[string]any {
	id := strings.TrimSpace(stringValue(layout["id"]))
	layout["placeholder"] = true
	layout["name"] = id + " · 待分配"
	layout["circleName"] = "参展资料待分配"
	layout["tagline"] = "该桌位已保留，等待总审分配有效参展资料。"
	layout["description"] = "这是尚未启用公开资料的地图桌位。"
	layout["tags"] = []any{"待分配"}
	layout["status"] = "preparing"
	layout["avatarText"] = "待"
	layout["announcement"] = ""
	layout["contact"] = map[string]any{"label": "", "url": nil}
	layout["products"] = []any{}
	return layout
}

// galonlyMapActiveProfiles reads only profiles that are allowed to become
// public. Account records, assignment ids and review state are never joined
// into the map projection.
func (s *Server) galonlyMapActiveProfiles(ctx context.Context, eventID int64) (map[string]map[string]any, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT booth_id,profile_json FROM galonly_booth_profiles
        WHERE event_id=? AND visibility_state='active'`, eventID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]map[string]any{}
	for rows.Next() {
		var boothID, encoded string
		if err := rows.Scan(&boothID, &encoded); err != nil {
			return nil, err
		}
		var profile map[string]any
		if err := json.Unmarshal([]byte(encoded), &profile); err != nil || profile == nil {
			continue
		}
		result[strings.ToUpper(strings.TrimSpace(boothID))] = profile
	}
	return result, rows.Err()
}

var errGalonlyMapProfileConflict = errors.New("galonly map profile version conflict")

func (s *Server) galonlyMapSaveProfilesTx(ctx context.Context, tx *sql.Tx, eventID int64, layout map[string]any, updates []galonlyMapProfileUpdate, userID int64) error {
	if len(updates) == 0 {
		return nil
	}
	catalog, _ := layout["catalog"].(map[string]any)
	items, _ := catalog["booths"].([]any)
	allowed := map[string]bool{}
	for _, raw := range items {
		if booth, ok := raw.(map[string]any); ok {
			allowed[strings.ToUpper(strings.TrimSpace(stringValue(booth["id"])))] = true
		}
	}
	seen := map[string]bool{}
	for _, update := range updates {
		boothID := strings.ToUpper(strings.TrimSpace(update.BoothID))
		if !allowed[boothID] || seen[boothID] {
			return fmt.Errorf("摊位资料不属于当前地图布局：%s", boothID)
		}
		seen[boothID] = true
		profile, err := normalizeGalonlyBoothProfile(update.Profile, boothID)
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(profile)
		if err != nil {
			return err
		}
		var current int64
		err = tx.QueryRowContext(ctx, "SELECT profile_version FROM galonly_booth_profiles WHERE event_id=? AND booth_id=?", eventID, boothID).Scan(&current)
		if errors.Is(err, sql.ErrNoRows) {
			if update.BaseVersion != 0 {
				return errGalonlyMapProfileConflict
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO galonly_booth_profiles
                (event_id,booth_id,profile_json,profile_version,visibility_state,updated_by_type,updated_by_user_id,created_at,updated_at)
                VALUES (?,?,?,1,'active','map_admin',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, eventID, boothID, string(encoded), userID)
			if err != nil {
				return err
			}
			continue
		}
		if err != nil || current != update.BaseVersion {
			return errGalonlyMapProfileConflict
		}
		result, err := tx.ExecContext(ctx, `UPDATE galonly_booth_profiles
            SET profile_json=?,profile_version=profile_version+1,visibility_state='active',updated_by_type='map_admin',updated_by_user_id=?,updated_by_account_id=NULL,updated_at=CURRENT_TIMESTAMP
            WHERE event_id=? AND booth_id=? AND profile_version=?`, string(encoded), userID, eventID, boothID, update.BaseVersion)
		if err != nil {
			return err
		}
		if affected, _ := result.RowsAffected(); affected != 1 {
			return errGalonlyMapProfileConflict
		}
	}
	return nil
}

// The first V6 save must not erase public data embedded by the old V5 map.
// It copies only missing profiles, never overwriting a portal-owned profile;
// subsequent V6 saves carry no content in the map document at all.
func (s *Server) galonlyMapSeedLegacyProfilesTx(ctx context.Context, tx *sql.Tx, eventID int64, project map[string]any, userID int64) error {
	if mapInt64(project["schemaVersion"]) != 5 {
		return nil
	}
	catalog, _ := project["catalog"].(map[string]any)
	items, _ := catalog["booths"].([]any)
	for _, raw := range items {
		booth, ok := raw.(map[string]any)
		if !ok || galonlyMapBoothIsPlaceholder(booth) {
			continue
		}
		boothID := strings.ToUpper(strings.TrimSpace(stringValue(booth["id"])))
		profile, err := normalizeGalonlyBoothProfile(boothProfileFromMapBooth(booth), boothID)
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(profile)
		if err != nil {
			return err
		}
		if s.db.Driver == "mysql" {
			_, err = tx.ExecContext(ctx, `INSERT INTO galonly_booth_profiles
                (event_id,booth_id,profile_json,profile_version,visibility_state,updated_by_type,updated_by_user_id,created_at,updated_at)
                VALUES (?,?,?,1,'active','legacy_map_seed',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
                ON DUPLICATE KEY UPDATE booth_id=VALUES(booth_id)`, eventID, boothID, string(encoded), userID)
		} else {
			_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO galonly_booth_profiles
                (event_id,booth_id,profile_json,profile_version,visibility_state,updated_by_type,updated_by_user_id,created_at,updated_at)
                VALUES (?,?,?,1,'active','legacy_map_seed',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, eventID, boothID, string(encoded), userID)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) galonlyMapCurrentPublishedTx(ctx context.Context, tx *sql.Tx, eventID int64) (map[string]any, error) {
	query := `SELECT id,event_id,revision,status,schema_version,payload_json,checksum_sha256,source_name,created_by,created_at,published_by,published_at
        FROM galonly_map_documents WHERE event_id=? AND status='published' ORDER BY revision DESC LIMIT 1`
	if s.db.Driver == "mysql" {
		query += " FOR UPDATE"
	}
	rows, err := tx.QueryContext(ctx, query, eventID)
	if err != nil {
		return nil, err
	}
	return galonlyMapScanRows(rows)
}

func galonlyMapPublicPlaceholderIsBlank(booth map[string]any) bool {
	id := strings.TrimSpace(stringValue(booth["id"]))
	name := strings.TrimSpace(stringValue(booth["name"]))
	if name == "" || strings.Contains(name, "待填写") {
		return true
	}
	return id != "" && name == id+" · 待填写"
}

func (s *Server) recordGalonlyMapAudit(ctx context.Context, r *http.Request, u *user, eventID, revision int64, action, checksum, sourceName, reviewRole string) {
	if s.db == nil || u == nil {
		return
	}
	details, _ := json.Marshal(map[string]any{
		"event_code":      galonlyMapEventCode,
		"event_id":        eventID,
		"revision":        revision,
		"checksum_sha256": checksum,
		"source_name":     sourceName,
		"review_role":     reviewRole,
	})
	_, _ = s.db.ExecContext(ctx, `INSERT INTO audit_logs (user_id,action,target_type,target_id,details,ip_address)
        VALUES (?,?,?,?,?,?)`, u.ID, action, "galonly_map", revision, string(details), clientIP(r))
}

func (s *Server) galonlyMapNextRevision(ctx context.Context, tx *sql.Tx, driver string, eventID int64) (int64, error) {
	query := "SELECT COALESCE(MAX(revision),0)+1 FROM galonly_map_documents WHERE event_id=?"
	if driver == "mysql" {
		query += " FOR UPDATE"
	}
	var revision int64
	if err := tx.QueryRowContext(ctx, query, eventID).Scan(&revision); err != nil {
		return 0, err
	}
	return revision, nil
}

func validateGalonlyMapProject(raw []byte, allowDemo bool) (map[string]any, error) {
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil, fmt.Errorf("地图项目 JSON 无法解析")
	}
	if root == nil {
		return nil, fmt.Errorf("地图项目必须是 JSON 对象")
	}
	if mapInt64(root["schemaVersion"]) == 6 {
		return validateGalonlyMapLayoutProject(root, allowDemo)
	}
	if mapInt64(root["schemaVersion"]) != 5 || stringValue(root["eventId"]) != galonlyMapEventCode || stringValue(root["units"]) != "metres" {
		return nil, fmt.Errorf("请选择 schemaVersion=6、eventId=beijing 的地图布局")
	}
	settings, ok := root["settings"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("地图项目缺少 settings")
	}
	positions, ok := root["positions"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("地图项目缺少 positions")
	}
	catalog, ok := root["catalog"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("地图项目缺少 catalog")
	}
	normalizedSettings, err := normalizeGalonlyMapSettings(settings)
	if err != nil {
		return nil, err
	}
	normalizedPositions, err := normalizeGalonlyMapPositions(positions)
	if err != nil {
		return nil, err
	}
	normalizedCatalog, err := normalizeGalonlyMapCatalog(catalog, allowDemo)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"schemaVersion": 5,
		"eventId":       galonlyMapEventCode,
		"units":         "metres",
		"settings":      normalizedSettings,
		"positions":     normalizedPositions,
		"catalog":       normalizedCatalog,
	}, nil
}

// V6 deliberately stores only things the layout owns. Every mutable public
// description lives in galonly_booth_profiles and gets projected when read.
func validateGalonlyMapLayoutProject(root map[string]any, allowDemo bool) (map[string]any, error) {
	if stringValue(root["eventId"]) != galonlyMapEventCode || stringValue(root["units"]) != "metres" {
		return nil, fmt.Errorf("请选择 schemaVersion=6、eventId=beijing 的地图布局")
	}
	settings, ok := root["settings"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("地图项目缺少 settings")
	}
	positions, ok := root["positions"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("地图项目缺少 positions")
	}
	catalog, ok := root["catalog"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("地图项目缺少 catalog")
	}
	normalizedSettings, err := normalizeGalonlyMapSettings(settings)
	if err != nil {
		return nil, err
	}
	normalizedPositions, err := normalizeGalonlyMapPositions(positions)
	if err != nil {
		return nil, err
	}
	if mapInt64(catalog["schemaVersion"]) != 1 || stringValue(catalog["eventId"]) != galonlyMapEventCode || stringValue(catalog["currency"]) != "CNY" {
		return nil, fmt.Errorf("catalog 必须使用 schemaVersion=1、eventId=beijing、currency=CNY")
	}
	demo, ok := catalog["demo"].(bool)
	if !ok || (demo && !allowDemo) {
		return nil, fmt.Errorf("catalog.demo 无效")
	}
	// Reuse the established category validator with an empty booth list.
	categoryCatalog, err := normalizeGalonlyMapCatalog(map[string]any{
		"schemaVersion": 1, "eventId": galonlyMapEventCode, "currency": "CNY", "demo": demo,
		"categories": catalog["categories"], "booths": []any{}, "notice": catalog["notice"],
	}, allowDemo)
	if err != nil {
		return nil, err
	}
	categoryIDs := map[string]bool{}
	for _, raw := range categoryCatalog["categories"].([]any) {
		if item, ok := raw.(map[string]any); ok {
			categoryIDs[stringValue(item["id"])] = true
		}
	}
	rawBooths, ok := catalog["booths"].([]any)
	if !ok || len(rawBooths) > len(galonlyMapBoothIDs()) {
		return nil, fmt.Errorf("地图目录数量不能超过可用桌位数量")
	}
	validTables := galonlyMapBoothIDs()
	boothIDs := map[string]bool{}
	booths := make([]any, 0, len(rawBooths))
	for _, raw := range rawBooths {
		booth, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("布局摊位数据无效")
		}
		id := strings.ToUpper(strings.TrimSpace(stringValue(booth["id"])))
		if !galonlyMapBoothKeyPattern.MatchString(id) || boothIDs[id] {
			return nil, fmt.Errorf("布局摊位 ID %s 无效或重复", id)
		}
		boothIDs[id] = true
		values, ok := booth["tableIds"].([]any)
		if !ok || len(values) == 0 || len(values) > galonlyMapMaxBooths {
			return nil, fmt.Errorf("布局摊位 %s 的 tableIds 数量无效", id)
		}
		tables, local := make([]string, 0, len(values)), map[string]bool{}
		for _, rawTable := range values {
			tableID := strings.ToUpper(strings.TrimSpace(stringValue(rawTable)))
			if !validTables[tableID] || local[tableID] {
				return nil, fmt.Errorf("布局摊位 %s 内的实体桌位 %s 无效或重复", id, tableID)
			}
			local[tableID] = true
			tables = append(tables, tableID)
		}
		sort.Strings(tables)
		category := strings.TrimSpace(stringValue(booth["category"]))
		color := strings.TrimSpace(stringValue(booth["color"]))
		if !categoryIDs[category] || !galonlyMapColorPattern.MatchString(color) {
			return nil, fmt.Errorf("布局摊位 %s 的分类或颜色无效", id)
		}
		reserved, _ := booth["reserved"].(bool)
		booths = append(booths, map[string]any{"id": id, "tableIds": tables, "category": category, "color": color, "reserved": reserved})
	}
	categoryCatalog["booths"] = booths
	return map[string]any{"schemaVersion": 6, "eventId": galonlyMapEventCode, "units": "metres", "settings": normalizedSettings, "positions": normalizedPositions, "catalog": categoryCatalog}, nil
}

// galonlyMapExpandedTableConflict lets administrators keep or reduce a known
// legacy overlap while preventing any save from introducing a new owner for a
// table. This keeps unrelated map edits usable until the three-person review
// team resolves the historical records explicitly.
func galonlyMapExpandedTableConflict(current, proposed map[string]any) string {
	currentOwners := galonlyMapTableOwners(current)
	for tableID, proposedOwners := range galonlyMapTableOwners(proposed) {
		if len(proposedOwners) < 2 {
			continue
		}
		knownOwners := currentOwners[tableID]
		if len(knownOwners) < 2 {
			return tableID
		}
		for owner := range proposedOwners {
			if !knownOwners[owner] {
				return tableID
			}
		}
	}
	return ""
}

func galonlyMapTableOwners(project map[string]any) map[string]map[string]bool {
	result := map[string]map[string]bool{}
	if project == nil {
		return result
	}
	catalog, _ := project["catalog"].(map[string]any)
	booths, _ := catalog["booths"].([]any)
	for _, raw := range booths {
		booth, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		owner := strings.ToUpper(strings.TrimSpace(stringValue(booth["id"])))
		if owner == "" {
			continue
		}
		appendOwner := func(rawTableID string) {
			tableID := strings.ToUpper(strings.TrimSpace(rawTableID))
			if tableID == "" {
				return
			}
			if result[tableID] == nil {
				result[tableID] = map[string]bool{}
			}
			result[tableID][owner] = true
		}
		switch tableIDs := booth["tableIds"].(type) {
		case []any:
			for _, value := range tableIDs {
				appendOwner(stringValue(value))
			}
		case []string:
			for _, value := range tableIDs {
				appendOwner(value)
			}
		}
	}
	return result
}

func galonlyMapLayoutProject(project map[string]any) (map[string]any, error) {
	if mapInt64(project["schemaVersion"]) == 6 {
		encoded, _ := json.Marshal(project)
		return validateGalonlyMapProject(encoded, false)
	}
	catalog, _ := project["catalog"].(map[string]any)
	rawBooths, _ := catalog["booths"].([]any)
	layoutBooths := make([]any, 0, len(rawBooths))
	for _, raw := range rawBooths {
		booth, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("布局摊位数据无效")
		}
		layoutBooths = append(layoutBooths, map[string]any{
			"id": booth["id"], "tableIds": booth["tableIds"], "category": booth["category"], "color": booth["color"],
			"reserved": galonlyMapBoothIsPlaceholder(booth),
		})
	}
	layoutCandidate := map[string]any{
		"schemaVersion": 6, "eventId": galonlyMapEventCode, "units": "metres",
		"settings": project["settings"], "positions": project["positions"],
		"catalog": map[string]any{"schemaVersion": 1, "eventId": galonlyMapEventCode, "currency": "CNY", "demo": catalog["demo"], "categories": catalog["categories"], "notice": catalog["notice"], "booths": layoutBooths},
	}
	encoded, _ := json.Marshal(layoutCandidate)
	return validateGalonlyMapProject(encoded, false)
}

func normalizeGalonlyMapSettings(input map[string]any) (map[string]any, error) {
	result := map[string]any{}
	for key, value := range input {
		if len(key) > 48 || !utf8.ValidString(key) {
			return nil, fmt.Errorf("场景设置名称无效")
		}
		if !galonlyMapPublicSettingKeys[key] {
			return nil, fmt.Errorf("场景设置 %s 不在公开地图字段内", key)
		}
		switch item := value.(type) {
		case map[string]any:
			if key != "areaNames" || len(item) > len(galonlyMapAreaNameIDs) {
				return nil, fmt.Errorf("场景设置 %s 格式无效", key)
			}
			names := map[string]any{}
			for areaID, raw := range item {
				if !galonlyMapAreaNameIDs[areaID] {
					return nil, fmt.Errorf("场地名称 %s 不在可编辑区域内", areaID)
				}
				name, ok := raw.(string)
				if !ok {
					return nil, fmt.Errorf("场地名称 %s 文本过长或无效", areaID)
				}
				name = strings.TrimSpace(name)
				if name != "" && !validMapText(name, 80) {
					return nil, fmt.Errorf("场地名称 %s 文本过长或无效", areaID)
				}
				if name != "" {
					names[areaID] = name
				}
			}
			result[key] = names
		case string:
			if !validMapText(item, 255) {
				return nil, fmt.Errorf("场景设置 %s 文本过长或无效", key)
			}
			if strings.HasSuffix(strings.ToLower(key), "color") || key == "accent" {
				if !galonlyMapColorPattern.MatchString(item) {
					return nil, fmt.Errorf("场景设置 %s 的颜色无效", key)
				}
			}
			result[key] = item
		case bool:
			result[key] = item
		default:
			number, ok := mapFiniteNumber(value)
			if !ok || math.Abs(number) > 1000000 {
				return nil, fmt.Errorf("场景设置 %s 的数值无效", key)
			}
			result[key] = number
		}
	}
	return result, nil
}

var galonlyMapPublicSettingKeys = map[string]bool{
	"side": true, "staff": true, "lane": true, "cross": true, "snap": true,
	"props": true, "decor": true, "boxes": true, "motion": true, "autoOrbit": true,
	"orbitSpeed": true, "labelMode": true, "floorColor": true, "wallColor": true,
	"accent": true, "title": true, "subtitle": true, "wallHeight": true, "cut": true,
	"chairs": true, "labels": true, "zones": true, "layoutRevision": true,
	"numberingRevision": true,
	"ceilingDetails":    true, "areaLabels": true, "eastAdmission": true,
	"materialSeconds": true, "eastX": true, "eastUp": true, "eastOut": true,
	"crowdVisible": true, "crowdCount": true, "crowdSpeed": true, "crowdDwell": true,
	"crowdPlaying": true, "vendorsVisible": true, "vendorPose": true, "checkpoints": true,
	"gateLocationVersion": true, "entryX": true, "entryZ": true, "exitX": true,
	"exitZ": true, "checkDuration": true, "showLifeRoutes": true, "areaNames": true,
}

var galonlyMapAreaNameIDs = map[string]bool{
	"market": true, "g": true, "ne": true, "east": true,
	"makeup": true, "stage": true, "se": true, "stage-g": true,
}

func normalizeGalonlyMapPositions(input map[string]any) (map[string]any, error) {
	validIDs := galonlyMapBoothIDs()
	result := map[string]any{}
	for id, raw := range input {
		if !validIDs[id] {
			return nil, fmt.Errorf("布局包含未知桌位 %s", id)
		}
		position, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("桌位 %s 的布局无效", id)
		}
		normalized := map[string]any{}
		for _, key := range []string{"x", "z", "rotation"} {
			if value, exists := position[key]; exists {
				number, ok := mapFiniteNumber(value)
				if !ok || math.Abs(number) > 1000000 {
					return nil, fmt.Errorf("桌位 %s 的 %s 坐标无效", id, key)
				}
				normalized[key] = number
			}
		}
		if len(normalized) == 0 {
			return nil, fmt.Errorf("桌位 %s 缺少布局坐标", id)
		}
		result[id] = normalized
	}
	return result, nil
}

func normalizeGalonlyMapCatalog(input map[string]any, allowDemo bool) (map[string]any, error) {
	if mapInt64(input["schemaVersion"]) != 1 || stringValue(input["eventId"]) != galonlyMapEventCode || stringValue(input["currency"]) != "CNY" {
		return nil, fmt.Errorf("catalog 必须使用 schemaVersion=1、eventId=beijing、currency=CNY")
	}
	demo, ok := input["demo"].(bool)
	if !ok {
		return nil, fmt.Errorf("catalog.demo 必须是布尔值")
	}
	if demo && !allowDemo {
		return nil, fmt.Errorf("虚构 demo 项目不能发布")
	}
	categoryValues, ok := input["categories"].([]any)
	if !ok || len(categoryValues) > 12 {
		return nil, fmt.Errorf("分类数量必须在 0–12 个之间")
	}
	categories := make([]any, 0, len(categoryValues))
	categoryIDs := map[string]bool{}
	for _, raw := range categoryValues {
		item, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("分类数据无效")
		}
		id := strings.TrimSpace(stringValue(item["id"]))
		name := strings.TrimSpace(stringValue(item["name"]))
		if !galonlyMapCategoryIDPattern.MatchString(id) || categoryIDs[id] || !validMapText(name, 30) || !galonlyMapColorPattern.MatchString(stringValue(item["color"])) {
			return nil, fmt.Errorf("分类 %s 无效", id)
		}
		categoryIDs[id] = true
		category := map[string]any{"id": id, "name": name, "color": stringValue(item["color"])}
		if icon := strings.TrimSpace(stringValue(item["icon"])); icon != "" {
			if !validMapText(icon, 32) {
				return nil, fmt.Errorf("分类 %s 图标名称无效", id)
			}
			category["icon"] = icon
		}
		categories = append(categories, category)
	}
	boothValues, ok := input["booths"].([]any)
	if !ok || len(boothValues) > len(galonlyMapBoothIDs()) {
		return nil, fmt.Errorf("地图目录数量不能超过可用桌位数量")
	}
	realBoothCount := 0
	for _, raw := range boothValues {
		booth, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("摊位数据无效")
		}
		if !galonlyMapBoothIsPlaceholder(booth) {
			realBoothCount++
		}
	}
	if realBoothCount > galonlyMapMaxBooths {
		return nil, fmt.Errorf("真实摊位数量必须在 0–63 个之间")
	}
	if len(boothValues) > 0 && len(categories) == 0 {
		return nil, fmt.Errorf("存在摊位时至少需要一个分类")
	}
	booths := make([]any, 0, len(boothValues))
	boothIDs := map[string]bool{}
	tableIDs := map[string]bool{}
	productIDs := map[string]bool{}
	validIDs := galonlyMapBoothIDs()
	for _, raw := range boothValues {
		booth, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("摊位数据无效")
		}
		normalized, err := normalizeGalonlyMapBooth(booth, validIDs, boothIDs, tableIDs, productIDs, categoryIDs)
		if err != nil {
			return nil, err
		}
		booths = append(booths, normalized)
	}
	catalog := map[string]any{
		"schemaVersion": 1,
		"eventId":       galonlyMapEventCode,
		"demo":          demo,
		"currency":      "CNY",
		"categories":    categories,
		"booths":        booths,
	}
	if notice := strings.TrimSpace(stringValue(input["notice"])); notice != "" {
		if !validMapText(notice, 500) {
			return nil, fmt.Errorf("catalog.notice 文本过长或无效")
		}
		catalog["notice"] = notice
	}
	return catalog, nil
}

func normalizeGalonlyMapBooth(input map[string]any, validTableIDs, boothIDs, tableIDs, productIDs, categoryIDs map[string]bool) (map[string]any, error) {
	id := strings.TrimSpace(stringValue(input["id"]))
	if !galonlyMapBoothKeyPattern.MatchString(id) || boothIDs[id] {
		return nil, fmt.Errorf("摊位 ID %s 无效或重复", id)
	}
	boothIDs[id] = true
	placeholder := galonlyMapBoothIsPlaceholder(input)
	rawTableIDs, hasTableIDs := input["tableIds"]
	if !hasTableIDs {
		if !validTableIDs[id] {
			return nil, fmt.Errorf("摊位 %s 缺少 tableIds", id)
		}
		rawTableIDs = []any{id}
	}
	values, ok := rawTableIDs.([]any)
	if !ok || len(values) == 0 || len(values) > galonlyMapMaxBooths {
		return nil, fmt.Errorf("摊位 %s 的 tableIds 数量无效", id)
	}
	normalizedTableIDs := make([]string, 0, len(values))
	localTables := map[string]bool{}
	for _, rawTableID := range values {
		tableID := strings.ToUpper(strings.TrimSpace(stringValue(rawTableID)))
		if !validTableIDs[tableID] {
			return nil, fmt.Errorf("摊位 %s 的桌位编号不存在：%s", id, tableID)
		}
		if localTables[tableID] {
			return nil, fmt.Errorf("摊位 %s 内的桌位重复：%s", id, tableID)
		}
		localTables[tableID] = true
		if !placeholder {
			tableIDs[tableID] = true
		}
		normalizedTableIDs = append(normalizedTableIDs, tableID)
	}
	sort.Strings(normalizedTableIDs)
	name := strings.TrimSpace(stringValue(input["name"]))
	circleName := strings.TrimSpace(stringValue(input["circleName"]))
	category := strings.TrimSpace(stringValue(input["category"]))
	status := strings.ToLower(strings.TrimSpace(stringValue(input["status"])))
	color := strings.TrimSpace(stringValue(input["color"]))
	if !validMapText(name, 120) || !validMapText(circleName, 120) || !categoryIDs[category] || !galonlyMapBoothStatuses[status] || !galonlyMapColorPattern.MatchString(color) {
		return nil, fmt.Errorf("摊位 %s 的名称、分类、状态或颜色无效", id)
	}
	normalized := map[string]any{
		"id": id, "tableIds": normalizedTableIDs, "name": name, "circleName": circleName, "category": category,
		"status": status, "color": color,
	}
	if placeholder {
		normalized["placeholder"] = true
	}
	for key, max := range map[string]int{"tagline": 200, "description": 3000, "avatarText": 12, "announcement": 1000} {
		value := strings.TrimSpace(stringValue(input[key]))
		if (key == "tagline" || key == "description") && value == "" {
			return nil, fmt.Errorf("摊位 %s 的 %s 不能为空", id, key)
		}
		if !validMapText(value, max) {
			return nil, fmt.Errorf("摊位 %s 的 %s 文本无效", id, key)
		}
		if value != "" {
			normalized[key] = value
		}
	}
	if value, exists := input["avatarUrl"]; exists {
		image := strings.TrimSpace(stringValue(value))
		if image != "" && !galonlyMapURLAllowed(image) {
			return nil, fmt.Errorf("摊位 %s 的头像地址无效", id)
		}
		if image == "" {
			normalized["avatarUrl"] = nil
		} else {
			normalized["avatarUrl"] = image
		}
	}
	tags, ok := input["tags"].([]any)
	if !ok || len(tags) > 8 {
		return nil, fmt.Errorf("摊位 %s 的标签数量无效", id)
	}
	normalizedTags := make([]any, 0, len(tags))
	for _, raw := range tags {
		value := strings.TrimSpace(stringValue(raw))
		if !validMapText(value, 32) {
			return nil, fmt.Errorf("摊位 %s 的标签无效", id)
		}
		normalizedTags = append(normalizedTags, value)
	}
	normalized["tags"] = normalizedTags
	if applicationID := mapInt64(input["applicationId"]); applicationID > 0 {
		normalized["applicationId"] = applicationID
	} else if input["applicationId"] != nil {
		return nil, fmt.Errorf("摊位 %s 的 applicationId 无效", id)
	}
	contact, err := normalizeGalonlyMapContact(input["contact"])
	if err != nil {
		return nil, fmt.Errorf("摊位 %s 的联系方式无效: %w", id, err)
	}
	normalized["contact"] = contact
	products, ok := input["products"].([]any)
	if !ok || len(products) > 40 {
		return nil, fmt.Errorf("摊位 %s 的制品数量无效", id)
	}
	normalizedProducts := make([]any, 0, len(products))
	for _, raw := range products {
		product, err := normalizeGalonlyMapProduct(raw, id, productIDs)
		if err != nil {
			return nil, err
		}
		normalizedProducts = append(normalizedProducts, product)
	}
	normalized["products"] = normalizedProducts
	return normalized, nil
}

const (
	galonlyMapPlaceholderDescription  = "这是地图编辑器的待填写位置，不会直接作为公开参展信息。"
	galonlyMapPlaceholderAnnouncement = "请导入或填写真实活动资料后再发布。"
)

func galonlyMapBoothIsPlaceholder(input map[string]any) bool {
	if value, ok := input["placeholder"].(bool); ok {
		return value
	}
	if strings.TrimSpace(stringValue(input["description"])) != galonlyMapPlaceholderDescription ||
		strings.TrimSpace(stringValue(input["announcement"])) != galonlyMapPlaceholderAnnouncement {
		return false
	}
	tags, ok := input["tags"].([]any)
	if !ok {
		return false
	}
	for _, raw := range tags {
		if strings.TrimSpace(stringValue(raw)) == "待填写" {
			return true
		}
	}
	return false
}

func normalizeGalonlyMapContact(raw any) (map[string]any, error) {
	if raw == nil {
		return map[string]any{"label": "", "url": nil}, nil
	}
	input, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("contact 必须是对象")
	}
	label := strings.TrimSpace(stringValue(input["label"]))
	if !validMapText(label, 64) {
		return nil, fmt.Errorf("label 无效")
	}
	urlValue := strings.TrimSpace(stringValue(input["url"]))
	if urlValue != "" && !galonlyMapURLAllowed(urlValue) {
		return nil, fmt.Errorf("url 只允许 HTTPS 或同源相对地址")
	}
	var url any
	if urlValue != "" {
		url = urlValue
	}
	return map[string]any{"label": label, "url": url}, nil
}

func normalizeGalonlyMapProduct(raw any, boothID string, productIDs map[string]bool) (map[string]any, error) {
	input, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("摊位 %s 的制品数据无效", boothID)
	}
	id := strings.TrimSpace(stringValue(input["id"]))
	name := strings.TrimSpace(stringValue(input["name"]))
	status := strings.ToLower(strings.TrimSpace(stringValue(input["status"])))
	price, priceOK := mapInteger(input["priceCents"])
	if !galonlyMapIDPattern.MatchString(id) || productIDs[id] || !validMapText(name, 160) || !priceOK || price < 0 || price > 100000000 || !galonlyMapProductStatuses[status] {
		return nil, fmt.Errorf("摊位 %s 的制品 ID、名称、价格或状态无效", boothID)
	}
	productIDs[id] = true
	result := map[string]any{"id": id, "name": name, "priceCents": price, "status": status}
	for key, max := range map[string]int{"kind": 32, "unit": 12, "spec": 200, "description": 2000, "badge": 20, "imageLabel": 80, "note": 1000} {
		value := strings.TrimSpace(stringValue(input[key]))
		if (key == "unit" || key == "spec" || key == "description") && value == "" {
			return nil, fmt.Errorf("制品 %s 的 %s 不能为空", id, key)
		}
		if !validMapText(value, max) {
			return nil, fmt.Errorf("制品 %s 的 %s 文本无效", id, key)
		}
		if value != "" {
			result[key] = value
		}
	}
	variants, ok := input["variants"].([]any)
	if !ok || len(variants) == 0 || len(variants) > 12 {
		return nil, fmt.Errorf("制品 %s 的版本数量无效", id)
	}
	normalizedVariants := make([]any, 0, len(variants))
	variantIDs := map[string]bool{}
	for _, rawVariant := range variants {
		variant := strings.TrimSpace(stringValue(rawVariant))
		if !validMapText(variant, 50) || variantIDs[variant] {
			return nil, fmt.Errorf("制品 %s 的版本名称无效", id)
		}
		variantIDs[variant] = true
		normalizedVariants = append(normalizedVariants, variant)
	}
	result["variants"] = normalizedVariants
	image := strings.TrimSpace(stringValue(input["imageUrl"]))
	if image != "" && !galonlyMapURLAllowed(image) {
		return nil, fmt.Errorf("制品 %s 的图片地址只允许 HTTPS 或同源相对地址", id)
	}
	if image != "" {
		result["imageUrl"] = image
	} else {
		result["imageUrl"] = nil
	}
	return result, nil
}

var galonlyMapBoothStatuses = map[string]bool{"open": true, "rest": true, "preparing": true}
var galonlyMapProductStatuses = map[string]bool{"available": true, "sold_out": true, "display_only": true}

func galonlyMapBoothIDs() map[string]bool {
	result := map[string]bool{}
	for _, prefix := range []string{"A", "B", "C", "D", "E", "F"} {
		for i := 1; i <= 8; i++ {
			result[fmt.Sprintf("%s%02d", prefix, i)] = true
		}
	}
	for _, prefix := range []string{"G"} {
		for i := 1; i <= 12; i++ {
			result[fmt.Sprintf("%s%02d", prefix, i)] = true
		}
	}
	for _, prefix := range []string{"H"} {
		for i := 1; i <= 3; i++ {
			result[fmt.Sprintf("%s%02d", prefix, i)] = true
		}
	}
	for _, item := range []string{"S01", "S02", "O01", "O02", "O03", "O04", "O05"} {
		result[item] = true
	}
	return result
}

func galonlyMapProjectFromDocument(document map[string]any) (map[string]any, error) {
	payload := stringValue(document["payload_json"])
	if payload == "" {
		return nil, fmt.Errorf("地图项目为空")
	}
	return validateGalonlyMapProject([]byte(payload), true)
}

func galonlyMapDocumentResponse(document, project map[string]any) map[string]any {
	return map[string]any{
		"id":              integerValue(document["id"]),
		"event_id":        integerValue(document["event_id"]),
		"revision":        integerValue(document["revision"]),
		"status":          stringValue(document["status"]),
		"schema_version":  integerValue(document["schema_version"]),
		"checksum_sha256": stringValue(document["checksum_sha256"]),
		"source_name":     stringValue(document["source_name"]),
		"created_by":      integerValue(document["created_by"]),
		"created_at":      galonlyMapJSONValue(document["created_at"]),
		"published_by":    integerValue(document["published_by"]),
		"published_at":    galonlyMapJSONValue(document["published_at"]),
		"project":         project,
	}
}

func galonlyMapVersionResponse(document map[string]any) map[string]any {
	return map[string]any{
		"id":              integerValue(document["id"]),
		"event_id":        integerValue(document["event_id"]),
		"revision":        integerValue(document["revision"]),
		"status":          stringValue(document["status"]),
		"schema_version":  integerValue(document["schema_version"]),
		"checksum_sha256": stringValue(document["checksum_sha256"]),
		"source_name":     stringValue(document["source_name"]),
		"created_by":      integerValue(document["created_by"]),
		"created_at":      galonlyMapJSONValue(document["created_at"]),
		"published_by":    integerValue(document["published_by"]),
		"published_at":    galonlyMapJSONValue(document["published_at"]),
	}
}

func galonlyMapProjectIsDemo(project map[string]any) bool {
	catalog, _ := project["catalog"].(map[string]any)
	demo, _ := catalog["demo"].(bool)
	return demo
}

func galonlyMapProjectBoothIDs(project map[string]any) map[string]bool {
	result := map[string]bool{}
	catalog, _ := project["catalog"].(map[string]any)
	items, _ := catalog["booths"].([]any)
	for _, item := range items {
		if booth, ok := item.(map[string]any); ok {
			if id := strings.TrimSpace(stringValue(booth["id"])); id != "" {
				result[id] = true
			}
		}
	}
	return result
}

func galonlyMapProjectBoothAliases(project map[string]any) map[string]string {
	aliases := map[string]string{}
	catalog, _ := project["catalog"].(map[string]any)
	items, _ := catalog["booths"].([]any)
	for _, item := range items {
		booth, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id := strings.TrimSpace(stringValue(booth["id"]))
		if id == "" {
			continue
		}
		aliases[id] = id
		switch tableIDs := booth["tableIds"].(type) {
		case []any:
			for _, rawTableID := range tableIDs {
				if tableID := strings.TrimSpace(stringValue(rawTableID)); tableID != "" {
					aliases[tableID] = id
				}
			}
		case []string:
			for _, rawTableID := range tableIDs {
				if tableID := strings.TrimSpace(rawTableID); tableID != "" {
					aliases[tableID] = id
				}
			}
		}
	}
	return aliases
}

func galonlyMapProjectTableCount(project map[string]any) int {
	catalog, _ := project["catalog"].(map[string]any)
	items, _ := catalog["booths"].([]any)
	count := 0
	for _, item := range items {
		booth, _ := item.(map[string]any)
		switch tableIDs := booth["tableIds"].(type) {
		case []any:
			count += len(tableIDs)
		case []string:
			count += len(tableIDs)
		}
	}
	return count
}

func galonlyMapClone(value map[string]any) map[string]any {
	raw, _ := json.Marshal(value)
	var clone map[string]any
	_ = json.Unmarshal(raw, &clone)
	if clone == nil {
		return map[string]any{}
	}
	return clone
}

func galonlyMapChecksum(payload []byte) string {
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}

func galonlyMapSourceName(value string) string {
	value = strings.TrimSpace(value)
	value = strings.ReplaceAll(value, "\\", "_")
	value = strings.ReplaceAll(value, "/", "_")
	if !validMapText(value, 255) {
		return "beijing-galonly-map.json"
	}
	if value == "" {
		return "beijing-galonly-map.json"
	}
	return value
}

func galonlyMapJSONValue(value any) any {
	switch item := value.(type) {
	case time.Time:
		return item.Format(time.RFC3339)
	case []byte:
		return string(item)
	default:
		return value
	}
}

func galonlyMapStateIDs(values []string, aliases map[string]string) ([]string, error) {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, raw := range values {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		canonical := id
		if aliases != nil {
			canonical = aliases[id]
		}
		if aliases != nil && canonical == "" {
			return nil, fmt.Errorf("清单包含未发布或无效摊位 %s", id)
		}
		if !galonlyMapBoothKeyPattern.MatchString(canonical) {
			return nil, fmt.Errorf("清单包含无效摊位 %s", id)
		}
		if !seen[canonical] {
			seen[canonical] = true
			result = append(result, canonical)
		}
		if len(result) > galonlyMapMaxBooths {
			return nil, fmt.Errorf("清单摊位数量超过 63 个")
		}
	}
	return result, nil
}

func galonlyMapNullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}

func validMapText(value string, max int) bool {
	return utf8.ValidString(value) && utf8.RuneCountInString(value) <= max && !strings.ContainsAny(value, "\x00\r\n")
}

func galonlyMapURLAllowed(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return true
	}
	if strings.HasPrefix(value, "//") || strings.ContainsAny(value, "\r\n\x00") {
		return false
	}
	if strings.HasPrefix(value, "/") || strings.HasPrefix(value, "./") || strings.HasPrefix(value, "../") {
		return true
	}
	if !strings.HasPrefix(strings.ToLower(value), "https://") {
		return false
	}
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil
}

func mapFiniteNumber(value any) (float64, bool) {
	switch number := value.(type) {
	case float64:
		return number, !math.IsNaN(number) && !math.IsInf(number, 0)
	case float32:
		converted := float64(number)
		return converted, !math.IsNaN(converted) && !math.IsInf(converted, 0)
	case int:
		return float64(number), true
	case int64:
		return float64(number), true
	case json.Number:
		converted, err := number.Float64()
		return converted, err == nil && !math.IsNaN(converted) && !math.IsInf(converted, 0)
	default:
		return 0, false
	}
}

func mapInteger(value any) (int64, bool) {
	number, ok := mapFiniteNumber(value)
	// JSON numbers arrive as float64 in the decoded project. Keeping the
	// accepted integer range comfortably below float64's exactness boundary
	// avoids silently changing IDs when converting to int64.
	const maxExactMapInteger = 9000000000000000.0
	if !ok || math.Trunc(number) != number || number < -maxExactMapInteger || number > maxExactMapInteger {
		return 0, false
	}
	return int64(number), true
}

func mapInt64(value any) int64 {
	number, ok := mapInteger(value)
	if !ok {
		return 0
	}
	return number
}
