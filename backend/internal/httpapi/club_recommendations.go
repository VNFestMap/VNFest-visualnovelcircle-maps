package httpapi

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

const clubRecommendationSlots = 12

func (s *Server) clubRecommendations(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	switch action {
	case "list":
		s.clubRecommendationsList(w, r)
	case "add":
		s.clubRecommendationsAdd(w, r)
	case "remove":
		s.clubRecommendationsRemove(w, r)
	case "reorder":
		s.clubRecommendationsReorder(w, r)
	default:
		writeJSON(w, map[string]any{"success": false, "message": "未知操作 action=" + action})
	}
}

func (s *Server) clubRecommendationsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	clubID := parsePositiveInt(r.URL.Query().Get("club_id"))
	country := clubCodeCountry(r.URL.Query().Get("country"))
	if clubID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效的同好会 ID"})
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT id, bangumi_id, title, image_url, rating, summary, sort_order, created_at
        FROM club_recommendations WHERE club_id = ? AND country = ? ORDER BY sort_order ASC, id ASC LIMIT 12`, clubID, country)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取推荐失败"})
		return
	}
	defer rows.Close()
	result := make([]map[string]any, 0)
	for rows.Next() {
		var id, bangumiID, sortOrder int64
		var title, imageURL string
		var rating sql.NullFloat64
		var summary, createdAt sql.NullString
		if err := rows.Scan(&id, &bangumiID, &title, &imageURL, &rating, &summary, &sortOrder, &createdAt); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取推荐失败"})
			return
		}
		result = append(result, map[string]any{"id": id, "bangumi_id": bangumiID, "title": title, "image_url": bangumiProxyImageURL(imageURL), "rating": nullFloat(rating), "summary": recommendationNullString(summary), "sort_order": sortOrder, "created_at": recommendationNullString(createdAt)})
	}
	if err := rows.Err(); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取推荐失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "data": result})
}

func (s *Server) clubRecommendationsAdd(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
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
	clubID := integerValue(input["club_id"])
	country := clubCodeCountry(stringValue(input["country"]))
	bangumiID := integerValue(input["bangumi_id"])
	title := strings.TrimSpace(stringValue(input["title"]))
	if clubID <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效的同好会 ID"})
		return
	}
	if bangumiID <= 0 || title == "" {
		writeJSON(w, map[string]any{"success": false, "message": "请选择有效的游戏条目"})
		return
	}
	if !s.canManageClubCodes(r.Context(), user, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权管理推荐榜"})
		return
	}
	var count int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM club_recommendations WHERE club_id = ? AND country = ?", clubID, country).Scan(&count); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取推荐失败"})
		return
	}
	if count >= clubRecommendationSlots {
		writeJSON(w, map[string]any{"success": false, "message": "推荐榜已达上限（12 部）"})
		return
	}
	var duplicate int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT id FROM club_recommendations WHERE club_id = ? AND country = ? AND bangumi_id = ? LIMIT 1", clubID, country, bangumiID).Scan(&duplicate); err == nil {
		writeJSON(w, map[string]any{"success": false, "message": "该条目已在推荐榜中"})
		return
	}
	rating := recommendationFloat(input["rating"])
	if rating <= 0 {
		rating = s.cachedBangumiRating(r.Context(), bangumiID)
	}
	requested, hasPosition := recommendationPosition(input["position"])
	if hasPosition && requested < 0 {
		writeJSON(w, map[string]any{"success": false, "message": "推荐位置必须是 1 到 12"})
		return
	}
	var sortOrder int64
	if hasPosition {
		sortOrder = int64(requested)
		var occupied int64
		if err := s.db.QueryRowContext(r.Context(), "SELECT id FROM club_recommendations WHERE club_id = ? AND country = ? AND sort_order = ? LIMIT 1", clubID, country, sortOrder).Scan(&occupied); err == nil {
			writeJSON(w, map[string]any{"success": false, "message": "第 " + strconvInt(sortOrder+1) + " 位已有条目，请选择空位或使用排序"})
			return
		}
	} else {
		rows, err := s.db.QueryContext(r.Context(), "SELECT sort_order FROM club_recommendations WHERE club_id = ? AND country = ?", clubID, country)
		if err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取推荐失败"})
			return
		}
		occupied := map[int64]bool{}
		for rows.Next() {
			var value int64
			if rows.Scan(&value) == nil && value >= 0 && value < clubRecommendationSlots {
				occupied[value] = true
			}
		}
		rows.Close()
		sortOrder = -1
		for candidate := int64(0); candidate < clubRecommendationSlots; candidate++ {
			if !occupied[candidate] {
				sortOrder = candidate
				break
			}
		}
		if sortOrder < 0 {
			writeJSON(w, map[string]any{"success": false, "message": "没有可用的推荐榜位置，请先整理排序"})
			return
		}
	}
	result, err := s.db.ExecContext(r.Context(), `INSERT INTO club_recommendations (club_id, country, bangumi_id, title, image_url, rating, summary, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, clubID, country, bangumiID, title, strings.TrimSpace(stringValue(input["image_url"])), rating, strings.TrimSpace(stringValue(input["summary"])), sortOrder, user.ID)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "添加推荐失败"})
		return
	}
	id, err := result.LastInsertId()
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "添加推荐失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "已添加推荐", "id": id})
}

func (s *Server) clubRecommendationsRemove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 1<<20); err != nil || input == nil || integerValue(input["id"]) <= 0 {
		writeJSON(w, map[string]any{"success": false, "message": "无效数据"})
		return
	}
	id := integerValue(input["id"])
	var clubID int64
	var country string
	if err := s.db.QueryRowContext(r.Context(), "SELECT club_id, country FROM club_recommendations WHERE id = ?", id).Scan(&clubID, &country); err != nil {
		if err == sql.ErrNoRows {
			writeJSON(w, map[string]any{"success": false, "message": "推荐条目不存在"})
		} else {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取推荐失败"})
		}
		return
	}
	if !s.canManageClubCodes(r.Context(), user, clubID, clubCodeCountry(country)) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权移除推荐"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "DELETE FROM club_recommendations WHERE id = ?", id); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "移除推荐失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "已移除推荐"})
}

func (s *Server) clubRecommendationsReorder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !sameOrigin(r) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "请求来源无效"})
		return
	}
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 1<<20); err != nil || input == nil {
		writeJSON(w, map[string]any{"success": false, "message": "无效数据"})
		return
	}
	values, hasSlots := anySlice(input["slots"]), input["slots"] != nil
	if !hasSlots {
		values = anySlice(input["ids"])
		if len(values) == 0 || len(values) > clubRecommendationSlots {
			writeJSON(w, map[string]any{"success": false, "message": "推荐列表数量无效"})
			return
		}
		values = append(values, make([]any, clubRecommendationSlots-len(values))...)
	}
	if len(values) != clubRecommendationSlots {
		writeJSON(w, map[string]any{"success": false, "message": "推荐槽位必须恰好为 12 个"})
		return
	}
	slots := make([]any, clubRecommendationSlots)
	ids := make([]int64, 0, clubRecommendationSlots)
	seen := map[int64]bool{}
	for index, value := range values {
		if value == nil || (func() bool {
			text, isString := value.(string)
			return isString && strings.TrimSpace(text) == ""
		})() {
			slots[index] = nil
			continue
		}
		if _, isBool := value.(bool); isBool {
			writeJSON(w, map[string]any{"success": false, "message": "推荐槽位包含无效条目"})
			return
		}
		id := integerValue(value)
		if id <= 0 || seen[id] {
			message := "推荐槽位包含无效条目"
			if seen[id] {
				message = "推荐槽位不能包含重复条目"
			}
			writeJSON(w, map[string]any{"success": false, "message": message})
			return
		}
		seen[id], slots[index] = true, id
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		writeJSON(w, map[string]any{"success": false, "message": "推荐列表不能为空"})
		return
	}
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for index, id := range ids {
		placeholders[index], args[index] = "?", id
	}
	rows, err := s.db.QueryContext(r.Context(), "SELECT id, club_id, country FROM club_recommendations WHERE id IN ("+strings.Join(placeholders, ",")+")", args...)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取推荐失败"})
		return
	}
	rowCount := 0
	var clubID int64
	country := ""
	consistent := true
	for rows.Next() {
		var id, rowClubID int64
		var rowCountry string
		if rows.Scan(&id, &rowClubID, &rowCountry) != nil {
			consistent = false
			continue
		}
		if rowCount == 0 {
			clubID, country = rowClubID, clubCodeCountry(rowCountry)
		} else if rowClubID != clubID || clubCodeCountry(rowCountry) != country {
			consistent = false
		}
		rowCount++
	}
	rows.Close()
	if !consistent || rowCount != len(ids) {
		writeJSON(w, map[string]any{"success": false, "message": "推荐槽位包含不存在的条目"})
		return
	}
	if !s.canManageClubCodes(r.Context(), user, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "无权排序"})
		return
	}
	currentRows, err := s.db.QueryContext(r.Context(), "SELECT id FROM club_recommendations WHERE club_id = ? AND country = ? ORDER BY id ASC", clubID, country)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "读取推荐失败"})
		return
	}
	current := make([]int64, 0)
	for currentRows.Next() {
		var id int64
		if currentRows.Scan(&id) == nil {
			current = append(current, id)
		}
	}
	currentRows.Close()
	submitted := append([]int64(nil), ids...)
	sort.Slice(current, func(i, j int) bool { return current[i] < current[j] })
	sort.Slice(submitted, func(i, j int) bool { return submitted[i] < submitted[j] })
	if len(current) != len(submitted) {
		writeJSON(w, map[string]any{"success": false, "message": "推荐槽位必须完整包含该同好会当前的全部条目"})
		return
	}
	for index := range current {
		if current[index] != submitted[index] {
			writeJSON(w, map[string]any{"success": false, "message": "推荐槽位必须完整包含该同好会当前的全部条目"})
			return
		}
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "排序保存失败，请稍后重试"})
		return
	}
	defer tx.Rollback()
	for index, value := range slots {
		if value == nil {
			continue
		}
		if _, err := tx.ExecContext(r.Context(), "UPDATE club_recommendations SET sort_order = ? WHERE id = ? AND club_id = ? AND country = ?", index, value, clubID, country); err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "排序保存失败，请稍后重试"})
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "排序保存失败，请稍后重试"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "排序已更新"})
}

func (s *Server) cachedBangumiRating(ctx context.Context, bangumiID int64) float64 {
	for _, name := range []string{"cache/bangumi/subject_" + strconvInt(bangumiID) + ".json", "cache/bangumi/subject_" + strconvInt(bangumiID) + "_v0.json"} {
		data := s.projectHubReadMap(ctx, name, nil)
		if rating, ok := data["rating"].(map[string]any); ok {
			if score := recommendationFloat(rating["score"]); score > 0 {
				return score
			}
		}
		if score := recommendationFloat(data["score"]); score > 0 {
			return score
		}
	}
	return 0
}

func recommendationFloat(value any) float64 {
	switch item := value.(type) {
	case float64:
		return item
	case float32:
		return float64(item)
	case int:
		return float64(item)
	case int64:
		return float64(item)
	case string:
		var result float64
		_, _ = fmt.Sscanf(strings.TrimSpace(item), "%f", &result)
		return result
	default:
		return 0
	}
}

func recommendationPosition(value any) (int, bool) {
	if value == nil || strings.TrimSpace(stringValue(value)) == "" {
		return 0, false
	}
	if _, ok := value.(bool); ok {
		return -1, true
	}
	position := integerValue(value)
	if position < 1 || position > clubRecommendationSlots {
		return -1, true
	}
	return int(position - 1), true
}

func nullFloat(value sql.NullFloat64) any {
	if value.Valid {
		return value.Float64
	}
	return nil
}

func recommendationNullString(value sql.NullString) any {
	if value.Valid {
		return value.String
	}
	return nil
}
