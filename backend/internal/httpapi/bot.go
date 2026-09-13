package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

type botAuthInfo struct {
	Type        string
	TokenID     int64
	ClubID      int64
	Country     string
	Permissions []string
}

func (s *Server) bot(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	mutating := map[string]bool{"auto_approve": true, "membership_approve": true, "membership_reject": true, "bot_tokens_create": true, "bot_tokens_revoke": true}
	if !mutating[action] && r.Method != http.MethodGet {
		writeJSONStatus(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "GET only"})
		return
	}
	if containsString([]string{"bot_tokens_list", "bot_tokens_create", "bot_tokens_revoke"}, action) {
		s.botTokenAction(w, r, action)
		return
	}
	auth, ok := s.botAuthenticate(w, r)
	if !ok {
		return
	}
	full := botQueryBool(r, "full") || botQueryBool(r, "include_private") || botQueryBool(r, "include_contact")
	if auth.Type == "club" && full {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "error": "同好会 Bot token 不允许请求 full/include_private 数据"})
		return
	}
	limit := boundedQueryInt(r, "limit", 20, 1, 100)
	query := strings.TrimSpace(firstNonEmpty(r.URL.Query().Get("q"), r.URL.Query().Get("query"), r.URL.Query().Get("keyword")))
	switch action {
	case "", "help":
		writeJSON(w, map[string]any{"success": true, "auth": map[string]any{"type": auth.Type, "permissions": auth.Permissions}, "actions": []string{"clubs", "club", "club_share", "club_activity", "search", "events", "publications", "wiki", "star_unions", "moe_contests", "announcements", "membership_applications", "membership_approve", "membership_reject", "stats", "admin_summary", "galonly_events", "galonly_applications", "galonly_staff_applications", "bot_tokens_list", "bot_tokens_create", "bot_tokens_revoke"}, "params": []string{"token", "action", "country", "id", "q", "region", "type", "status", "limit", "full", "scope", "club_key", "since_id", "order", "membership_id", "event_id"}})
	case "clubs", "search":
		s.botClubs(w, r, auth, full, limit, query)
	case "club":
		s.botClub(w, r, auth, full, query)
	case "club_share", "club_activity":
		s.botClubActivity(w, r, auth, action, query)
	case "events":
		s.botEvents(w, r, query, limit)
	case "publications":
		s.botPublications(w, r, query, limit, full)
	case "wiki":
		s.botWiki(w, r, query, limit)
	case "star_unions":
		s.botStarUnions(w, r, query, limit)
	case "moe_contests":
		writeJSON(w, map[string]any{"success": true, "total": 0, "data": []any{}, "code": "MOE_REBUILDING", "message": "萌战模块正在重构，旧方案已下线，接口动作保留。"})
	case "announcements":
		s.botAnnouncements(w, r, limit)
	case "membership_applications":
		s.botMembershipApplications(w, r, auth, query)
	case "membership_approve", "auto_approve":
		s.botMembershipDecision(w, r, auth, true)
	case "membership_reject":
		s.botMembershipDecision(w, r, auth, false)
	case "stats":
		s.botStats(w, r, auth)
	case "admin_summary":
		if auth.Type != "global" {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "error": "该 action 仅全站 Bot API 密钥可用"})
			return
		}
		s.botAdminSummary(w, r)
	case "galonly_events":
		s.botGalonlyEvents(w, r)
	case "galonly_applications":
		s.botGalonlyApplications(w, r, limit)
	case "galonly_staff_applications":
		s.botGalonlyStaffApplications(w, r, limit)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "error": "未知 action", "action": action})
	}
}

func (s *Server) botAuthenticate(w http.ResponseWriter, r *http.Request) (botAuthInfo, bool) {
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		header := strings.TrimSpace(r.Header.Get("Authorization"))
		if len(header) >= 7 && strings.EqualFold(header[:7], "bearer ") {
			token = strings.TrimSpace(header[7:])
		}
	}
	if strings.HasPrefix(token, "gmap_club_") {
		if s.db == nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "database unavailable"})
			return botAuthInfo{}, false
		}
		prefix := token
		if len(prefix) > 22 {
			prefix = prefix[:22]
		}
		rows, err := s.db.QueryContext(r.Context(), "SELECT id,club_id,COALESCE(country,'china'),token_hash,permissions FROM club_bot_tokens WHERE token_prefix=? AND revoked_at IS NULL ORDER BY id DESC", prefix)
		if err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "club token query failed"})
			return botAuthInfo{}, false
		}
		var matched botAuthInfo
		matchedOK := false
		for rows.Next() {
			var id, clubID int64
			var country, hash, permissions string
			if rows.Scan(&id, &clubID, &country, &hash, &permissions) == nil && bcrypt.CompareHashAndPassword([]byte(hash), []byte(token)) == nil {
				matched = botAuthInfo{Type: "club", TokenID: id, ClubID: clubID, Country: firstNonEmpty(country, "china"), Permissions: botPermissions(permissions)}
				matchedOK = true
				break
			}
		}
		_ = rows.Close()
		if matchedOK {
			_, _ = s.db.ExecContext(r.Context(), "UPDATE club_bot_tokens SET last_used_at=CURRENT_TIMESTAMP WHERE id=?", matched.TokenID)
			return matched, true
		}
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "error": "无效的同好会 Bot token"})
		return botAuthInfo{}, false
	}
	expected := strings.TrimSpace(s.cfg.BotAPIKey)
	if expected == "" && s.cfg.LegacyAuthEnabled {
		expected = strings.TrimSpace(s.cfg.AdminToken)
	}
	if expected == "" {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "BOT_API_KEY 未配置"})
		return botAuthInfo{}, false
	}
	if token == "" || subtle.ConstantTimeCompare([]byte(expected), []byte(token)) != 1 {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "error": "无效的 API 密钥"})
		return botAuthInfo{}, false
	}
	return botAuthInfo{Type: "global", Permissions: []string{"all"}}, true
}

func (s *Server) botTokenAction(w http.ResponseWriter, r *http.Request, action string) {
	userID, role := s.optionalSessionUser(r)
	if userID == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "error": "请先登录"})
		return
	}
	if action == "bot_tokens_list" && r.Method != http.MethodGet || action != "bot_tokens_list" && r.Method != http.MethodPost {
		method := http.MethodPost
		if action == "bot_tokens_list" {
			method = http.MethodGet
		}
		writeJSONStatus(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": method + " only"})
		return
	}
	if s.db == nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "database unavailable"})
		return
	}
	if action == "bot_tokens_list" {
		clubID := queryInt(r, "club_id")
		country := firstNonEmpty(r.URL.Query().Get("country"), "china")
		if clubID <= 0 || !s.botCanManageTokenClub(r, *userID, role, clubID, country) {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "error": "无权查看该同好会 Bot token"})
			return
		}
		s.botListTokens(w, r, clubID, country)
		return
	}
	var input map[string]any
	if decodeJSON(r, &input, 1<<20) != nil || input == nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "error": "无效 JSON"})
		return
	}
	if action == "bot_tokens_create" {
		clubID := integerValue(input["club_id"])
		country := firstNonEmpty(stringValue(input["country"]), "china")
		if clubID <= 0 {
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "error": "club_id required"})
			return
		}
		if !s.botCanManageTokenClub(r, *userID, role, clubID, country) {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "error": "无权创建该同好会 Bot token"})
			return
		}
		token := "gmap_club_" + randomHex(24)
		name := truncateString(firstNonEmpty(stringValue(input["name"]), "AstrBot 接入"), 80)
		permissions := []string{}
		if boolValue(input["approve_membership"]) {
			permissions = append(permissions, "approve_membership")
		}
		encoded, _ := json.Marshal(permissions)
		result, err := s.db.ExecContext(r.Context(), "INSERT INTO club_bot_tokens(club_id,country,name,token_prefix,token_hash,permissions,created_by) VALUES(?,?,?,?,?,?,?)", clubID, country, name, token[:22], stringMustHash(token), string(encoded), *userID)
		if err != nil {
			writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "create token failed"})
			return
		}
		id, _ := result.LastInsertId()
		writeJSON(w, map[string]any{"success": true, "message": "Bot token 已创建，请立即复制保存，刷新后不会再次显示明文。", "token": token, "item": map[string]any{"id": id, "club_id": clubID, "country": country, "name": name, "token_prefix": token[:22], "permissions": permissions, "active": true}})
		return
	}
	tokenID := integerValue(input["token_id"])
	if tokenID <= 0 {
		tokenID = integerValue(input["id"])
	}
	var clubID int64
	var country string
	if s.db.QueryRowContext(r.Context(), "SELECT club_id,COALESCE(country,'china') FROM club_bot_tokens WHERE id=?", tokenID).Scan(&clubID, &country) != nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "error": "token not found"})
		return
	}
	if !s.botCanManageTokenClub(r, *userID, role, clubID, country) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "error": "无权吊销该同好会 Bot token"})
		return
	}
	_, _ = s.db.ExecContext(r.Context(), "UPDATE club_bot_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE id=? AND revoked_at IS NULL", tokenID)
	writeJSON(w, map[string]any{"success": true, "message": "Bot token 已吊销"})
}

func stringMustHash(value string) string {
	hash, err := bcrypt.GenerateFromPassword([]byte(value), bcrypt.DefaultCost)
	if err != nil {
		return ""
	}
	return string(hash)
}

func (s *Server) botCanManageTokenClub(r *http.Request, userID int64, role string, clubID int64, country string) bool {
	if role == "super_admin" {
		return true
	}
	return s.projectHubCanManageClub(r.Context(), &user{ID: userID, Role: role}, map[string]any{"id": clubID, "country": country})
}

func (s *Server) botListTokens(w http.ResponseWriter, r *http.Request, clubID int64, country string) {
	rows, err := s.db.QueryContext(r.Context(), "SELECT id,club_id,COALESCE(country,'china'),COALESCE(name,''),token_prefix,permissions,created_by,created_at,last_used_at,revoked_at FROM club_bot_tokens WHERE club_id=? AND COALESCE(country,'china')=? ORDER BY id DESC", clubID, country)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "token query failed"})
		return
	}
	defer rows.Close()
	result := []map[string]any{}
	for rows.Next() {
		var id, rowClub, createdBy int64
		var rowCountry, name, prefix, permissions string
		var created, last, revoked any
		if rows.Scan(&id, &rowClub, &rowCountry, &name, &prefix, &permissions, &createdBy, &created, &last, &revoked) == nil {
			result = append(result, map[string]any{"id": id, "club_id": rowClub, "country": rowCountry, "name": name, "token_prefix": prefix, "permissions": botPermissions(permissions), "created_by": createdBy, "created_at": databaseValueString(created), "last_used_at": databaseValueString(last), "revoked_at": databaseValueString(revoked), "active": databaseValueString(revoked) == ""})
		}
	}
	writeJSON(w, map[string]any{"success": true, "tokens": result})
}

func botPermissions(raw string) []string {
	var values []any
	if json.Unmarshal([]byte(raw), &values) != nil {
		return []string{}
	}
	result := []string{}
	for _, value := range values {
		if item := stringValue(value); item != "" {
			result = append(result, item)
		}
	}
	return result
}

func botQueryBool(r *http.Request, key string) bool {
	value := strings.ToLower(strings.TrimSpace(r.URL.Query().Get(key)))
	return value == "1" || value == "true" || value == "yes" || value == "full"
}

func (s *Server) botLoadClubs(ctx context.Context, country string) []map[string]any {
	result := []map[string]any{}
	for _, source := range []struct{ file, country string }{{"clubs.json", "china"}, {"clubs_japan.json", "japan"}} {
		if country != "" && country != "all" && country != source.country {
			continue
		}
		for _, value := range s.projectHubRows(ctx, source.file, "data") {
			club := map[string]any{}
			for key, item := range value {
				club[key] = item
			}
			club["country"] = source.country
			result = append(result, club)
		}
	}
	sort.SliceStable(result, func(i, j int) bool {
		if stringValue(result[i]["country"]) != stringValue(result[j]["country"]) {
			return stringValue(result[i]["country"]) < stringValue(result[j]["country"])
		}
		return integerValue(result[i]["id"]) < integerValue(result[j]["id"])
	})
	return result
}

func botRegion(club map[string]any, country string) string {
	value := firstNonEmpty(stringValue(club[map[string]string{"japan": "prefecture", "china": "province"}[country]]), stringValue(club["province"]), stringValue(club["prefecture"]))
	value = strings.TrimSpace(value)
	if country == "china" {
		value = strings.TrimSuffix(strings.TrimSuffix(value, "省"), "市")
	}
	return value
}

func botAbsoluteURL(s *Server, value string) string {
	value = strings.TrimSpace(value)
	if value == "" || strings.HasPrefix(value, "#") {
		return ""
	}
	if strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") {
		return value
	}
	return strings.TrimRight(s.cfg.SiteURL, "/") + "/" + strings.TrimLeft(value, "/")
}

func botClubRow(s *Server, club map[string]any, full bool, counts map[string]int64) map[string]any {
	country := firstNonEmpty(stringValue(club["country"]), "china")
	id := integerValue(club["id"])
	region := botRegion(club, country)
	contact := stringValue(club["info"])
	row := map[string]any{"id": id, "key": country + ":" + strconv.FormatInt(id, 10), "country": country, "name": firstNonEmpty(stringValue(club["display_name"]), stringValue(club["name"])), "short_name": stringValue(club["name"]), "school": stringValue(club["school"]), "region": region, "province": map[bool]string{true: region, false: ""}[country == "china"], "prefecture": map[bool]string{true: region, false: ""}[country == "japan"], "type": firstNonEmpty(stringValue(club["type"]), "school"), "verified": integerValue(club["verified"]), "project": firstNonEmpty(stringValue(club["project"]), "galgame"), "created_at": stringValue(club["created_at"]), "logo_url": botAbsoluteURL(s, stringValue(club["logo_url"])), "share_url": botAbsoluteURL(s, "club_share.html?club="+urlQueryEscape(country+":"+strconv.FormatInt(id, 10))), "external_links": stringValue(club["external_links"]), "member_count": counts[country+":"+strconv.FormatInt(id, 10)]}
	if full {
		row["contact"], row["contact_hidden"] = contact, false
		row["remark"], row["raw_text"] = stringValue(club["remark"]), stringValue(club["raw_text"])
		row["protected"], row["visible_by_default"] = integerValue(club["protected"]), integerValue(club["visible_by_default"])
	} else {
		visible := boolValue(club["visible_by_default"])
		row["contact"] = map[bool]string{true: contact, false: ""}[visible]
		row["contact_hidden"] = !visible && contact != ""
	}
	return row
}

func (s *Server) botClubByKey(ctx context.Context, value, country string) map[string]any {
	value = strings.TrimSpace(value)
	if strings.Contains(value, "-") {
		value = strings.Replace(value, "-", ":", 1)
	}
	parts := strings.SplitN(value, ":", 2)
	if len(parts) == 2 {
		country, value = strings.ToLower(parts[0]), parts[1]
	}
	id, _ := strconv.ParseInt(value, 10, 64)
	if id <= 0 {
		return nil
	}
	for _, club := range s.botLoadClubs(ctx, firstNonEmpty(country, "all")) {
		if integerValue(club["id"]) == id {
			return club
		}
	}
	return nil
}

func (s *Server) botMemberCounts(ctx context.Context) map[string]int64 {
	counts := map[string]int64{}
	if s.db == nil {
		return counts
	}
	rows, err := s.db.QueryContext(ctx, "SELECT club_id,COALESCE(country,'china'),COUNT(*) FROM club_memberships WHERE status='active' AND role<>'external' GROUP BY club_id,COALESCE(country,'china')")
	if err != nil {
		return counts
	}
	defer rows.Close()
	for rows.Next() {
		var id, count int64
		var country string
		if rows.Scan(&id, &country, &count) == nil {
			counts[country+":"+strconv.FormatInt(id, 10)] = count
		}
	}
	return counts
}

func botMatches(row map[string]any, query string, fields ...string) bool {
	for _, term := range strings.Fields(strings.ToLower(query)) {
		matched := false
		for _, field := range fields {
			value := stringValue(row[field])
			if value == "" {
				if encoded, err := json.Marshal(row[field]); err == nil {
					value = string(encoded)
				}
			}
			if strings.Contains(strings.ToLower(value), term) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	return true
}

func (s *Server) botClubs(w http.ResponseWriter, r *http.Request, auth botAuthInfo, full bool, limit int, query string) {
	country := strings.ToLower(firstNonEmpty(r.URL.Query().Get("country"), "all"))
	if country != "china" && country != "japan" {
		country = "all"
	}
	typeFilter := strings.TrimSpace(r.URL.Query().Get("type"))
	regionFilter := strings.TrimSpace(r.URL.Query().Get("region"))
	counts := s.botMemberCounts(r.Context())
	items := []map[string]any{}
	for _, club := range s.botLoadClubs(r.Context(), country) {
		clubCountry := stringValue(club["country"])
		if typeFilter != "" && stringValue(club["type"]) != typeFilter || regionFilter != "" && botRegion(club, clubCountry) != regionFilter || !botMatches(club, query, "name", "display_name", "school", "province", "prefecture", "remark", "raw_text", "project") {
			continue
		}
		items = append(items, botClubRow(s, club, full, counts))
		if len(items) >= limit {
			break
		}
	}
	writeJSON(w, map[string]any{"success": true, "action": firstNonEmpty(r.URL.Query().Get("action"), "clubs"), "total": len(items), "data": items})
	_ = auth
}

func (s *Server) botClub(w http.ResponseWriter, r *http.Request, auth botAuthInfo, full bool, query string) {
	key := firstNonEmpty(r.URL.Query().Get("id"), r.URL.Query().Get("key"), r.URL.Query().Get("club_key"))
	club := s.botClubByKey(r.Context(), key, firstNonEmpty(r.URL.Query().Get("country"), "all"))
	if club == nil && query != "" {
		for _, candidate := range s.botLoadClubs(r.Context(), "all") {
			if botMatches(candidate, query, "name", "display_name", "school", "remark", "raw_text") {
				club = candidate
				break
			}
		}
	}
	if club == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "error": "未找到该同好会"})
		return
	}
	row := botClubRow(s, club, full, s.botMemberCounts(r.Context()))
	writeJSON(w, map[string]any{"success": true, "data": row})
}

func (s *Server) botClubActivity(w http.ResponseWriter, r *http.Request, auth botAuthInfo, action, query string) {
	key := firstNonEmpty(r.URL.Query().Get("id"), r.URL.Query().Get("key"), r.URL.Query().Get("club_key"))
	club := s.botClubByKey(r.Context(), key, "all")
	if club == nil && auth.Type == "club" && key == "" {
		club = s.botClubByKey(r.Context(), strconv.FormatInt(auth.ClubID, 10), auth.Country)
	}
	if club == nil || auth.Type == "club" && (integerValue(club["id"]) != auth.ClubID || stringValue(club["country"]) != auth.Country) {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "error": "未找到该同好会"})
		return
	}
	summary := s.growthBuildClubSummary(r.Context(), club)
	if action == "club_activity" {
		writeJSON(w, map[string]any{"success": true, "data": map[string]any{"club": map[string]any{"key": summary["key"], "name": summary["name"], "share_url": botAbsoluteURL(s, stringValue(summary["share_url"]))}, "activity": summary["activity"]}})
		return
	}
	writeJSON(w, map[string]any{"success": true, "data": summary})
	_ = query
}

func (s *Server) botEvents(w http.ResponseWriter, r *http.Request, query string, limit int) {
	rows := s.projectHubRows(r.Context(), "events.json", "events")
	items := []map[string]any{}
	for i := len(rows) - 1; i >= 0 && len(items) < limit; i-- {
		row := rows[i]
		if !botMatches(row, query, "event", "date", "date_end", "description", "link") {
			continue
		}
		items = append(items, map[string]any{"id": integerValue(row["id"]), "title": stringValue(row["event"]), "date": stringValue(row["date"]), "date_end": stringValue(row["date_end"]), "description": stringValue(row["description"]), "link": stringValue(row["link"]), "image_url": botAbsoluteURL(s, stringValue(row["image"])), "official": integerValue(firstNonEmpty(stringValue(row["offical"]), stringValue(row["official"]))), "created_at": stringValue(row["created_at"])})
	}
	writeJSON(w, map[string]any{"success": true, "total": len(items), "data": items})
}

func (s *Server) botPublications(w http.ResponseWriter, r *http.Request, query string, limit int, full bool) {
	rows := s.projectHubRows(r.Context(), "publications.json", "publications")
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	items := []map[string]any{}
	for _, row := range rows {
		if status != "" && stringValue(row["status"]) != status || !botMatches(row, query, "publicationName", "clubName", "status", "deadline", "description", "submitContact") {
			continue
		}
		item := map[string]any{"id": integerValue(row["id"]), "title": stringValue(row["publicationName"]), "club_name": stringValue(row["clubName"]), "club_ids": row["club_ids"], "status": stringValue(row["status"]), "deadline": stringValue(row["deadline"]), "description": stringValue(row["description"]), "submit_contact": "", "submit_contact_hidden": stringValue(row["submitContact"]) != "", "submit_link": "", "image_url": botAbsoluteURL(s, stringValue(row["image_url"])), "created_at": stringValue(row["created_at"]), "updated_at": stringValue(row["updated_at"])}
		if full {
			item["submit_contact"], item["submit_link"] = stringValue(row["submitContact"]), stringValue(row["submitLink"])
		}
		items = append(items, item)
		if len(items) >= limit {
			break
		}
	}
	writeJSON(w, map[string]any{"success": true, "total": len(items), "data": items})
}

func (s *Server) botWiki(w http.ResponseWriter, r *http.Request, query string, limit int) {
	data, _ := os.ReadFile(filepath.Join(s.cfg.Root, "wiki", "index.json"))
	var index map[string]any
	_ = json.Unmarshal(data, &index)
	items := []map[string]any{}
	for key, raw := range index {
		row, ok := raw.(map[string]any)
		if !ok || !botMatches(row, query, "title", "school", "club_name", "region", "summary", "country_label") {
			continue
		}
		row["key"] = key
		row["url"] = botAbsoluteURL(s, stringValue(row["url"]))
		items = append(items, row)
		if len(items) >= limit {
			break
		}
	}
	writeJSON(w, map[string]any{"success": true, "total": len(items), "data": items})
}

func (s *Server) botStarUnions(w http.ResponseWriter, r *http.Request, query string, limit int) {
	if s.db == nil {
		writeJSON(w, map[string]any{"success": true, "total": 0, "data": []any{}})
		return
	}
	args := []any{}
	where := []string{}
	if country := strings.ToLower(r.URL.Query().Get("country")); country == "china" || country == "japan" {
		where = append(where, "country=?")
		args = append(args, country)
	}
	if query != "" {
		where = append(where, "(name LIKE ? OR description LIKE ? OR region LIKE ?)")
		args = append(args, "%"+query+"%", "%"+query+"%", "%"+query+"%")
	}
	querySQL := "SELECT id,name,COALESCE(description,''),COALESCE(region,''),COALESCE(country,'china'),bound_club_id,COALESCE(bound_club_country,'china'),COALESCE(star_color,'#f0c060'),created_at FROM star_unions"
	if len(where) > 0 {
		querySQL += " WHERE " + strings.Join(where, " AND ")
	}
	querySQL += " ORDER BY created_at DESC LIMIT ?"
	args = append(args, limit)
	rows, err := s.db.QueryContext(r.Context(), querySQL, args...)
	if err != nil {
		writeJSON(w, map[string]any{"success": true, "total": 0, "data": []any{}})
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, boundID int64
		var name, description, region, country, boundCountry, color string
		var created any
		if rows.Scan(&id, &name, &description, &region, &country, &boundID, &boundCountry, &color, &created) == nil {
			var count int64
			_ = s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM star_union_members WHERE union_id=?", id).Scan(&count)
			items = append(items, map[string]any{"id": id, "name": name, "description": description, "region": region, "country": country, "bound_club_id": botNullableID(boundID), "bound_club_country": boundCountry, "star_color": color, "created_at": databaseValueString(created), "member_count": count})
		}
	}
	writeJSON(w, map[string]any{"success": true, "total": len(items), "data": items})
}

func botNullableID(value int64) any {
	if value <= 0 {
		return nil
	}
	return value
}

func (s *Server) botAnnouncements(w http.ResponseWriter, r *http.Request, limit int) {
	rows, err := s.db.QueryContext(r.Context(), "SELECT id,title,content,type,status,is_persistent,created_at,published_at FROM announcements WHERE status='published' ORDER BY published_at DESC,created_at DESC LIMIT ?", limit)
	if err != nil {
		writeJSON(w, map[string]any{"success": true, "total": 0, "data": []any{}})
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, persistent any
		var title, content, typ, status string
		var created, published any
		if rows.Scan(&id, &title, &content, &typ, &status, &persistent, &created, &published) == nil {
			items = append(items, map[string]any{"id": id, "title": title, "content": content, "type": typ, "status": status, "is_persistent": integerValue(persistent), "created_at": databaseValueString(created), "published_at": databaseValueString(published)})
		}
	}
	writeJSON(w, map[string]any{"success": true, "total": len(items), "data": items})
}

func (s *Server) botMembershipApplications(w http.ResponseWriter, r *http.Request, auth botAuthInfo, _ string) {
	scope := strings.ToLower(firstNonEmpty(r.URL.Query().Get("scope"), "all"))
	status := strings.ToLower(firstNonEmpty(r.URL.Query().Get("status"), "pending"))
	sinceID := queryInt(r, "since_id")
	order := "ASC"
	if strings.EqualFold(r.URL.Query().Get("order"), "desc") {
		order = "DESC"
	}
	limit := boundedQueryInt(r, "limit", 20, 1, 50)
	where := []string{}
	args := []any{}
	if status != "" && status != "all" {
		where = append(where, "cm.status=?")
		args = append(args, status)
	}
	if sinceID > 0 {
		where = append(where, "cm.id > ?")
		args = append(args, sinceID)
	}
	if auth.Type == "club" {
		scope = "club"
		clubKey := firstNonEmpty(r.URL.Query().Get("club_key"), r.URL.Query().Get("key"))
		if clubKey != "" && !strings.EqualFold(strings.ReplaceAll(clubKey, "-", ":"), auth.Country+":"+strconv.FormatInt(auth.ClubID, 10)) {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "error": "同好会 Bot token 只能读取本同好会申请"})
			return
		}
		where = append(where, "cm.club_id=?", "COALESCE(cm.country,'china')=?")
		args = append(args, auth.ClubID, auth.Country)
	} else if scope == "club" {
		clubKey := firstNonEmpty(r.URL.Query().Get("club_key"), r.URL.Query().Get("key"))
		club := s.botClubByKey(r.Context(), clubKey, "all")
		if club == nil {
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "error": "无效的 club_key"})
			return
		}
		where = append(where, "cm.club_id=?", "COALESCE(cm.country,'china')=?")
		args = append(args, integerValue(club["id"]), stringValue(club["country"]))
	} else if scope != "all" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "error": "scope must be club or all"})
		return
	}
	query := `SELECT cm.id,cm.user_id,cm.club_id,COALESCE(cm.country,'china'),cm.status,cm.role,COALESCE(cm.apply_role,''),COALESCE(cm.join_method,''),COALESCE(cm.qq_account,''),COALESCE(cm.contact_account,''),COALESCE(cm.external_club_name,''),COALESCE(cm.external_club_role,''),COALESCE(cm.apply_reason,''),cm.joined_at,COALESCE(u.username,''),COALESCE(u.nickname,'') FROM club_memberships cm LEFT JOIN users u ON u.id=cm.user_id`
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY cm.id " + order + " LIMIT ?"
	args = append(args, limit)
	rows, err := s.db.QueryContext(r.Context(), query, args...)
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "error": "membership application query failed"})
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, userID, clubID int64
		var country, rowStatus, role, applyRole, joinMethod, qq, contact, externalName, externalRole, reason, joined, username, nickname string
		if rows.Scan(&id, &userID, &clubID, &country, &rowStatus, &role, &applyRole, &joinMethod, &qq, &contact, &externalName, &externalRole, &reason, &joined, &username, &nickname) == nil {
			club := s.botClubByKey(r.Context(), country+":"+strconv.FormatInt(clubID, 10), country)
			clubName := "同好会#" + strconv.FormatInt(clubID, 10)
			if club != nil {
				clubName = firstNonEmpty(stringValue(club["display_name"]), stringValue(club["name"]), clubName)
			}
			method := firstNonEmpty(joinMethod, "school_no_code")
			applicationRole := firstNonEmpty(applyRole, role, "member")
			items = append(items, map[string]any{"id": id, "club_key": country + ":" + strconv.FormatInt(clubID, 10), "club_name": clubName, "country": country, "club_id": clubID, "status": rowStatus, "join_method": method, "join_method_label": botJoinMethodLabel(method), "apply_role": applicationRole, "role_label": botRoleLabel(applicationRole), "applicant_name": firstNonEmpty(nickname, username, "用户#"+strconv.FormatInt(userID, 10)), "username": username, "user_id": userID, "contact_account": contact, "qq_account": qq, "external_club_name": externalName, "external_club_role": externalRole, "apply_reason": reason, "created_at": joined, "joined_at": joined})
		}
	}
	writeJSON(w, map[string]any{"success": true, "total": len(items), "data": items})
}

func botJoinMethodLabel(method string) string {
	switch method {
	case "school_code":
		return "本校成员申请（有绑定码）"
	case "external_exchange":
		return "外校成员交流申请"
	default:
		return "本校成员申请加入（未有绑定码）"
	}
}

func botRoleLabel(role string) string {
	switch role {
	case "external":
		return "外交成员（IEM）"
	case "representative":
		return "负责人"
	case "manager":
		return "管理员"
	case "super_admin":
		return "超级管理员"
	default:
		return "成员"
	}
}

func (s *Server) botMembershipDecision(w http.ResponseWriter, r *http.Request, auth botAuthInfo, approve bool) {
	input := map[string]any{}
	if r.Method == http.MethodPost {
		_ = decodeJSON(r, &input, 1<<20)
	}
	id := integerValue(firstNonNil(input["membership_id"], r.URL.Query().Get("membership_id")))
	if id <= 0 {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "error": "membership_id required"})
		return
	}
	var clubID, userID int64
	var country, status string
	if s.db.QueryRowContext(r.Context(), "SELECT club_id,user_id,COALESCE(country,'china'),status FROM club_memberships WHERE id=?", id).Scan(&clubID, &userID, &country, &status) != nil || status != "pending" {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "error": "pending application not found"})
		return
	}
	if auth.Type != "global" && (auth.ClubID != clubID || auth.Country != country || !containsString(auth.Permissions, "approve_membership")) {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "error": "该 token 未开启审批权限"})
		return
	}
	newStatus := "rejected"
	if approve {
		newStatus = "active"
	}
	_, err := s.db.ExecContext(r.Context(), "UPDATE club_memberships SET status=?,left_at=NULL WHERE id=? AND status='pending'", newStatus, id)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "membership decision failed"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": map[bool]string{true: "membership approved", false: "membership rejected"}[approve], "membership_id": id})
	_ = userID
}

func (s *Server) botStats(w http.ResponseWriter, r *http.Request, auth botAuthInfo) {
	clubs := s.botLoadClubs(r.Context(), "all")
	counts := s.botMemberCounts(r.Context())
	byCountry, byType, byRegion := map[string]int64{}, map[string]int64{}, map[string]int64{}
	visible := []map[string]any{}
	for _, club := range clubs {
		if auth.Type == "club" && (integerValue(club["id"]) != auth.ClubID || stringValue(club["country"]) != auth.Country) {
			continue
		}
		visible = append(visible, club)
		country := stringValue(club["country"])
		byCountry[country]++
		byType[firstNonEmpty(stringValue(club["type"]), "school")]++
		if region := botRegion(club, country); region != "" {
			byRegion[region]++
		}
	}
	activeUsers, _ := s.botScalar(r.Context(), "SELECT COUNT(*) FROM users WHERE status='active'")
	totalMembers := int64(0)
	if auth.Type == "club" {
		totalMembers = counts[auth.Country+":"+strconv.FormatInt(auth.ClubID, 10)]
	} else {
		for _, count := range counts {
			totalMembers += count
		}
	}
	events := s.projectHubRows(r.Context(), "events.json", "events")
	publications := s.projectHubRows(r.Context(), "publications.json", "publications")
	wikiPages := int64(0)
	growthAnalytics := s.growthAnalytics(r.Context(), nil, 30)
	if auth.Type == "club" && len(visible) > 0 {
		summary := s.growthBuildClubSummary(r.Context(), visible[0])
		activity, _ := summary["activity"].(map[string]any)
		events = nil
		publications = nil
		if activity != nil {
			events, _ = activity["events"].([]map[string]any)
			publications, _ = activity["publications"].([]map[string]any)
			if activity["wiki"] != nil {
				wikiPages = 1
			}
		}
		keys := []string{auth.Country + ":" + strconv.FormatInt(auth.ClubID, 10)}
		growthAnalytics = s.growthAnalytics(r.Context(), keys, 30)
	} else {
		var index map[string]any
		if data, err := os.ReadFile(filepath.Join(s.cfg.Root, "wiki", "index.json")); err == nil && json.Unmarshal(data, &index) == nil {
			wikiPages = int64(len(index))
		}
	}
	writeJSON(w, map[string]any{"success": true, "data": map[string]any{"mode": auth.Type, "club_key": map[bool]string{true: auth.Country + ":" + strconv.FormatInt(auth.ClubID, 10), false: ""}[auth.Type == "club"], "total_clubs": len(visible), "total_members": totalMembers, "total_events": len(events), "total_publications": len(publications), "total_wiki_pages": wikiPages, "total_moe_contests": 0, "active_users": activeUsers, "growth_analytics_30d": growthAnalytics, "by_country": byCountry, "by_type": byType, "top_regions": byRegion}})
}

func (s *Server) botScalar(ctx context.Context, query string, args ...any) (int64, error) {
	var value int64
	if s.db == nil {
		return 0, fmt.Errorf("database unavailable")
	}
	err := s.db.QueryRowContext(ctx, query, args...).Scan(&value)
	return value, err
}

func (s *Server) botAdminSummary(w http.ResponseWriter, r *http.Request) {
	data := map[string]any{"pending_club_submissions": s.botPendingJSON(r, "submissions.json", ""), "pending_publication_submissions": s.botPendingJSON(r, "submissions_publication.json", ""), "pending_event_submissions": s.botPendingJSON(r, "submissions_event.json", ""), "pending_feedback": s.botPendingJSON(r, "feedback.json", ""), "event_registrations": s.botPendingJSON(r, "event_registrations.json", ""), "pending_memberships": int64(0), "active_users": int64(0), "total_clubs": len(s.botLoadClubs(r.Context(), "all")), "total_publications": len(s.projectHubRows(r.Context(), "publications.json", "publications")), "total_events": len(s.projectHubRows(r.Context(), "events.json", "events")), "total_wiki_pages": 0}
	data["pending_memberships"], _ = s.botScalar(r.Context(), "SELECT COUNT(*) FROM club_memberships WHERE status='pending'")
	data["active_users"], _ = s.botScalar(r.Context(), "SELECT COUNT(*) FROM users WHERE status='active'")
	writeJSON(w, map[string]any{"success": true, "data": data})
}

func (s *Server) botPendingJSON(r *http.Request, name, key string) int64 {
	rows := s.projectHubRows(r.Context(), name, key)
	if key == "" {
		var raw any
		if s.files != nil && s.files.ReadJSON(r.Context(), name, &raw) == nil {
			rows = mapSlice(raw)
		}
	}
	var count int64
	for _, row := range rows {
		if stringValue(row["status"]) == "pending" {
			count++
		}
	}
	return count
}

func (s *Server) botGalonlyEvents(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), "SELECT id,name,location,date,registration_open,staff_only,event_code,description FROM galonly_events ORDER BY date ASC")
	if err != nil {
		writeJSON(w, map[string]any{"success": true, "total": 0, "data": []any{}})
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, registration, staff int64
		var name, location, date, code, description string
		if rows.Scan(&id, &name, &location, &date, &registration, &staff, &code, &description) == nil {
			items = append(items, map[string]any{"id": id, "name": name, "location": location, "date": date, "registration_open": registration, "staff_only": staff, "event_code": code, "description": description})
		}
	}
	writeJSON(w, map[string]any{"success": true, "total": len(items), "data": items})
}

func (s *Server) botGalonlyApplications(w http.ResponseWriter, r *http.Request, limit int) {
	s.botGalonlyApplicationRows(w, r, limit, false)
}

func (s *Server) botGalonlyStaffApplications(w http.ResponseWriter, r *http.Request, limit int) {
	s.botGalonlyApplicationRows(w, r, limit, true)
}

func (s *Server) botGalonlyApplicationRows(w http.ResponseWriter, r *http.Request, limit int, staff bool) {
	table := "galonly_applications"
	if staff {
		table = "galonly_staff_applications"
	}
	query := "SELECT id,event_id,user_id,status,created_at,updated_at FROM " + table + " WHERE 1=1"
	args := []any{}
	if eventID := queryInt(r, "event_id"); eventID > 0 {
		query += " AND event_id=?"
		args = append(args, eventID)
	}
	if status := strings.TrimSpace(r.URL.Query().Get("status")); status != "" && status != "all" {
		query += " AND status=?"
		args = append(args, status)
	}
	query += " ORDER BY id " + map[bool]string{true: "ASC", false: "DESC"}[strings.EqualFold(r.URL.Query().Get("order"), "asc")] + " LIMIT ?"
	args = append(args, limit)
	rows, err := s.db.QueryContext(r.Context(), query, args...)
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "error": "application query failed"})
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, eventID, userID int64
		var status string
		var created, updated any
		if rows.Scan(&id, &eventID, &userID, &status, &created, &updated) == nil {
			items = append(items, map[string]any{"id": id, "event_id": eventID, "user_id": userID, "status": status, "created_at": databaseValueString(created), "updated_at": databaseValueString(updated)})
		}
	}
	writeJSON(w, map[string]any{"success": true, "total": len(items), "data": items})
}
