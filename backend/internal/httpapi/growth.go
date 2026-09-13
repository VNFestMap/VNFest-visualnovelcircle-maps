package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var growthAnalyticsEvents = []string{"club_share_view", "club_share_copy", "club_apply_click", "bot_share_query"}

func (s *Server) growth(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	if action == "" {
		action = "club_summary"
	}
	if r.Method == http.MethodPost {
		if action != "record" {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		var input map[string]any
		if err := decodeJSON(r, &input, 1<<20); err != nil || input == nil {
			writeJSON(w, map[string]any{"success": false})
			return
		}
		event := strings.TrimSpace(stringValue(input["event"]))
		clubKey := cleanGrowthKey(firstNonEmpty(stringValue(input["club_key"]), stringValue(input["club"])))
		source := cleanGrowthSource(firstNonEmpty(stringValue(input["source"]), "web"))
		writeJSON(w, map[string]any{"success": s.growthRecord(r.Context(), event, clubKey, source)})
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	switch action {
	case "club_summary":
		s.growthClubSummaryHandler(w, r)
	case "owner_dashboard":
		s.growthOwnerDashboard(w, r)
	case "analytics_summary":
		s.growthAnalyticsSummaryHandler(w, r)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "unknown action", "action": action})
	}
}

func (s *Server) growthClubSummaryHandler(w http.ResponseWriter, r *http.Request) {
	key := firstNonEmpty(strings.TrimSpace(r.URL.Query().Get("club")), strings.TrimSpace(r.URL.Query().Get("key")))
	var club map[string]any
	if key != "" {
		club = s.growthFindClubByKey(r.Context(), key)
	} else {
		country := clubCodeCountry(r.URL.Query().Get("country"))
		club = s.growthFindClub(r.Context(), country, parsePositiveInt(r.URL.Query().Get("id")))
	}
	if club == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "club not found"})
		return
	}
	summary := s.growthBuildClubSummary(r.Context(), club)
	if growthBool(r.URL.Query().Get("track")) {
		_ = s.growthRecord(r.Context(), "club_share_view", stringValue(summary["key"]), cleanGrowthSource(firstNonEmpty(r.URL.Query().Get("source"), "web")))
	}
	writeJSON(w, map[string]any{"success": true, "club": summary})
}

func (s *Server) growthOwnerDashboard(w http.ResponseWriter, r *http.Request) {
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	memberships := s.growthManagedMemberships(r.Context(), user)
	clubs := make([]map[string]any, 0)
	clubKeys := make([]string, 0)
	for _, membership := range memberships {
		club := s.growthFindClub(r.Context(), stringValue(membership["country"]), integerValue(membership["club_id"]))
		if club == nil {
			continue
		}
		summary := s.growthBuildClubSummary(r.Context(), club)
		summary["owner_role"] = firstNonEmpty(stringValue(membership["role"]), "manager")
		clubs = append(clubs, summary)
		clubKeys = append(clubKeys, stringValue(summary["key"]))
	}
	analytics := s.growthAnalytics(r.Context(), clubKeys, 30)
	pending := s.growthMembershipCounts(r.Context(), clubKeys, "pending")
	active := s.growthMembershipCounts(r.Context(), clubKeys, "active")
	for _, club := range clubs {
		key := stringValue(club["key"])
		club["pending_members"], club["member_count"] = pending[key], active[key]
		byClub, _ := analytics["by_club"].(map[string]any)
		if value, ok := byClub[key]; ok {
			club["analytics"] = value
		} else {
			club["analytics"] = emptyGrowthClubAnalytics()
		}
	}
	writeJSON(w, map[string]any{"success": true, "clubs": clubs, "analytics": analytics, "templates": []map[string]any{
		{"key": "event", "label": "发布活动", "url": "./submit_event.html"},
		{"key": "publication", "label": "发布刊物征稿", "url": "./submit_publication.html"},
		{"key": "club", "label": "维护社团资料", "url": "./admin/club_manager.html"},
	}})
}

func (s *Server) growthAnalyticsSummaryHandler(w http.ResponseWriter, r *http.Request) {
	user, ok := s.clubCodeUserResponse(w, r)
	if !ok {
		return
	}
	keys := make([]string, 0)
	for _, membership := range s.growthManagedMemberships(r.Context(), user) {
		keys = append(keys, growthClubKey(stringValue(membership["country"]), integerValue(membership["club_id"])))
	}
	writeJSON(w, map[string]any{"success": true, "analytics": s.growthAnalytics(r.Context(), keys, 30)})
}

func (s *Server) growthManagedMemberships(ctx context.Context, user *user) []map[string]any {
	if user.Role == "super_admin" {
		all := s.growthLoadClubs(ctx, "all")
		if len(all) > 30 {
			all = all[:30]
		}
		result := make([]map[string]any, 0, len(all))
		for _, club := range all {
			result = append(result, map[string]any{"club_id": integerValue(club["id"]), "country": stringValue(club["country"]), "role": "super_admin"})
		}
		return result
	}
	rows, err := s.db.QueryContext(ctx, "SELECT club_id, country, role FROM club_memberships WHERE user_id=? AND status='active' AND role IN ('representative','manager') ORDER BY joined_at DESC", user.ID)
	if err != nil {
		rows, err = s.db.QueryContext(ctx, "SELECT club_id, role FROM club_memberships WHERE user_id=? AND status='active' AND role IN ('representative','manager') ORDER BY joined_at DESC", user.ID)
	}
	if err != nil {
		return []map[string]any{}
	}
	defer rows.Close()
	result := make([]map[string]any, 0)
	for rows.Next() {
		var clubID int64
		var country, role sql.NullString
		if rows.Scan(&clubID, &country, &role) == nil {
			result = append(result, map[string]any{"club_id": clubID, "country": firstNonEmpty(country.String, "china"), "role": role.String})
		}
	}
	return result
}

func (s *Server) growthMembershipCounts(ctx context.Context, keys []string, status string) map[string]int64 {
	result := map[string]int64{}
	if len(keys) == 0 {
		return result
	}
	rows, err := s.db.QueryContext(ctx, "SELECT club_id, country, COUNT(*) FROM club_memberships WHERE status=? GROUP BY club_id, country", status)
	withCountry := err == nil
	if err != nil {
		rows, err = s.db.QueryContext(ctx, "SELECT club_id, COUNT(*) FROM club_memberships WHERE status=? GROUP BY club_id", status)
	}
	if err != nil {
		return result
	}
	defer rows.Close()
	wanted := map[string]bool{}
	for _, key := range keys {
		wanted[key] = true
	}
	for rows.Next() {
		var id, count int64
		country := "china"
		if withCountry {
			var nullableCountry sql.NullString
			if err := rows.Scan(&id, &nullableCountry, &count); err != nil {
				continue
			}
			country = firstNonEmpty(nullableCountry.String, "china")
		} else if err := rows.Scan(&id, &count); err != nil {
			continue
		}
		key := growthClubKey(country, id)
		if wanted[key] {
			result[key] = count
		}
	}
	return result
}

func (s *Server) growthLoadClubs(ctx context.Context, country string) []map[string]any {
	result := make([]map[string]any, 0)
	for _, item := range []struct{ file, country string }{{"clubs.json", "china"}, {"clubs_japan.json", "japan"}} {
		if country != "all" && country != item.country {
			continue
		}
		for _, club := range s.projectHubRows(ctx, item.file, "data") {
			club["country"] = item.country
			result = append(result, club)
		}
	}
	return result
}

func (s *Server) growthFindClub(ctx context.Context, country string, id int64) map[string]any {
	if id <= 0 {
		return nil
	}
	for _, club := range s.growthLoadClubs(ctx, firstNonEmpty(country, "china")) {
		if integerValue(club["id"]) == id {
			return club
		}
	}
	return nil
}

func (s *Server) growthFindClubByKey(ctx context.Context, key string) map[string]any {
	country, id := growthParseClubKey(key)
	return s.growthFindClub(ctx, country, id)
}

func growthParseClubKey(value string) (string, int64) {
	value = strings.TrimSpace(value)
	parts := strings.FieldsFunc(value, func(r rune) bool { return r == ':' || r == '-' })
	if len(parts) == 2 && (parts[0] == "china" || parts[0] == "japan") {
		return parts[0], parsePositiveInt(parts[1])
	}
	if id := parsePositiveInt(value); id > 0 {
		return "china", id
	}
	return "", 0
}

func (s *Server) growthBuildClubSummary(ctx context.Context, club map[string]any) map[string]any {
	country := firstNonEmpty(stringValue(club["country"]), "china")
	id := integerValue(club["id"])
	name := firstNonEmpty(stringValue(club["display_name"]), firstNonEmpty(stringValue(club["name"]), "Club #"+strconvInt(id)))
	shortName := stringValue(club["name"])
	contact := strings.TrimSpace(stringValue(club["info"]))
	visible := boolValue(club["visible_by_default"]) && !boolValue(club["protected"])
	publicContact := ""
	if visible {
		publicContact = contact
	}
	events := s.growthEventsForClub(ctx, club)
	publications := s.growthPublicationsForClub(ctx, club)
	wiki := s.growthWikiForClub(country, id)
	missing := []string{}
	checks := map[string]bool{"logo": stringValue(club["logo_url"]) != "", "intro": firstNonEmpty(stringValue(club["remark"]), stringValue(club["raw_text"])) != "", "public_contact": !(!visible && contact != ""), "external_links": stringValue(club["external_links"]) != "", "wiki": wiki != nil, "events": len(events) > 0, "publications": len(publications) > 0}
	for _, key := range []string{"logo", "intro", "public_contact", "external_links", "wiki", "events", "publications"} {
		if !checks[key] {
			missing = append(missing, key)
		}
	}
	return map[string]any{
		"id": id, "key": growthClubKey(country, id), "country": country, "name": name, "short_name": shortName,
		"school": stringValue(club["school"]), "region": firstNonEmpty(stringValue(club["province"]), stringValue(club["prefecture"])),
		"type": firstNonEmpty(stringValue(club["type"]), "school"), "logo_url": stringValue(club["logo_url"]), "external_links": stringValue(club["external_links"]), "remark": stringValue(club["remark"]),
		"contact": publicContact, "contact_hidden": !visible && contact != "", "visible_by_default": boolInt(visible),
		"share_url": "./club_share.html?club=" + urlQueryEscape(growthClubKey(country, id)), "apply_url": "./index.html?guest=1&club=" + urlQueryEscape(growthClubKey(country, id)),
		"completeness": map[string]any{"score": int(float64(len(checks)-len(missing)) / float64(len(checks)) * 100), "missing": missing},
		"activity":     map[string]any{"events": firstFive(events), "publications": firstFive(publications), "wiki": wiki},
	}
}

func (s *Server) growthPublicationsForClub(ctx context.Context, club map[string]any) []map[string]any {
	country, id := stringValue(club["country"]), integerValue(club["id"])
	name, shortName := stringValue(club["display_name"]), stringValue(club["name"])
	result := []map[string]any{}
	for _, publication := range s.projectHubRows(ctx, "publications.json", "publications") {
		matched := false
		for _, ref := range anySlice(publication["club_ids"]) {
			if item := normalizeProjectClub(ref); item != nil && integerValue(item["id"]) == id && stringValue(item["country"]) == country {
				matched = true
			}
		}
		clubName := stringValue(publication["clubName"])
		if !matched && clubName != "" && (clubName == name || clubName == shortName || (shortName != "" && strings.Contains(clubName, shortName))) {
			matched = true
		}
		if matched {
			result = append(result, map[string]any{"id": integerValue(publication["id"]), "name": stringValue(publication["publicationName"]), "status": stringValue(publication["status"]), "deadline": stringValue(publication["deadline"]), "description": stringValue(publication["description"]), "submit_link": stringValue(publication["submitLink"]), "image_url": stringValue(publication["image_url"])})
		}
	}
	return result
}

func (s *Server) growthEventsForClub(ctx context.Context, club map[string]any) []map[string]any {
	country, id := stringValue(club["country"]), integerValue(club["id"])
	name, shortName := stringValue(club["display_name"]), stringValue(club["name"])
	result := []map[string]any{}
	for _, event := range s.projectHubRows(ctx, "events.json", "events") {
		matched := integerValue(event["club_id"]) == id && firstNonEmpty(stringValue(event["country"]), country) == country
		for _, ref := range anySlice(event["club_ids"]) {
			if item := normalizeProjectClub(ref); item != nil && integerValue(item["id"]) == id && stringValue(item["country"]) == country {
				matched = true
			}
		}
		text := strings.Join([]string{stringValue(event["clubName"]), stringValue(event["raw_text"]), stringValue(event["event"])}, " ")
		if !matched && ((shortName != "" && strings.Contains(text, shortName)) || (name != "" && strings.Contains(text, name))) {
			matched = true
		}
		if matched {
			result = append(result, map[string]any{"id": integerValue(event["id"]), "title": stringValue(event["event"]), "date": stringValue(event["date"]), "date_end": stringValue(event["date_end"]), "description": stringValue(event["description"]), "link": stringValue(event["link"]), "image": stringValue(event["image"])})
		}
	}
	sort.SliceStable(result, func(i, j int) bool { return stringValue(result[i]["date"]) > stringValue(result[j]["date"]) })
	return result
}

func (s *Server) growthWikiForClub(country string, id int64) map[string]any {
	path := filepath.Join(s.cfg.Root, "wiki", "index.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var index map[string]any
	if json.Unmarshal(data, &index) != nil {
		return nil
	}
	row, ok := index[growthWikiKey(country, id)].(map[string]any)
	if !ok {
		return nil
	}
	copyRow := map[string]any{}
	for key, value := range row {
		copyRow[key] = value
	}
	if href := stringValue(copyRow["url"]); href != "" && !strings.HasPrefix(strings.ToLower(href), "http://") && !strings.HasPrefix(strings.ToLower(href), "https://") {
		copyRow["url"] = "./wiki/" + strings.TrimPrefix(strings.TrimPrefix(href, "./"), "/")
	}
	return copyRow
}

func (s *Server) growthRecord(ctx context.Context, event, clubKey, source string) bool {
	if !containsString(growthAnalyticsEvents, event) || s.files == nil {
		return false
	}
	data := s.projectHubReadMap(ctx, "growth_analytics.json", map[string]any{"days": map[string]any{}})
	days, ok := data["days"].(map[string]any)
	if !ok {
		days = map[string]any{}
	}
	today := time.Now().Format("2006-01-02")
	day, ok := days[today].(map[string]any)
	if !ok {
		day = map[string]any{}
	}
	byEvent, ok := day[event].(map[string]any)
	if !ok {
		byEvent = map[string]any{}
	}
	row, ok := byEvent[clubKey].(map[string]any)
	if !ok {
		row = map[string]any{"total": 0, "sources": map[string]any{}}
	}
	row["total"] = integerValue(row["total"]) + 1
	sources, ok := row["sources"].(map[string]any)
	if !ok {
		sources = map[string]any{}
	}
	sources[source] = integerValue(sources[source]) + 1
	row["sources"], byEvent[clubKey], day[event], days[today], data["days"] = sources, row, byEvent, day, days
	return s.projectHubWriteMap(ctx, "growth_analytics.json", data) == nil
}

func (s *Server) growthAnalytics(ctx context.Context, keys []string, days int) map[string]any {
	data := s.projectHubReadMap(ctx, "growth_analytics.json", map[string]any{"days": map[string]any{}})
	wanted := map[string]bool{}
	for _, key := range keys {
		wanted[key] = true
	}
	filtered := len(keys) > 0
	cutoff := time.Now().AddDate(0, 0, -(maxInt(days, 1) - 1)).Format("2006-01-02")
	result := map[string]any{"club_share_view": int64(0), "club_share_copy": int64(0), "club_apply_click": int64(0), "bot_share_query": int64(0), "by_club": map[string]any{}}
	byClub := result["by_club"].(map[string]any)
	daysMap, _ := data["days"].(map[string]any)
	for dayKey, rawEvents := range daysMap {
		if dayKey < cutoff {
			continue
		}
		events, _ := rawEvents.(map[string]any)
		for event, rawClubs := range events {
			if !containsString(growthAnalyticsEvents, event) {
				continue
			}
			clubs, _ := rawClubs.(map[string]any)
			for clubKey, rawRow := range clubs {
				if filtered && !wanted[clubKey] {
					continue
				}
				row, ok := rawRow.(map[string]any)
				if !ok {
					continue
				}
				count := integerValue(row["total"])
				result[event] = integerValue(result[event]) + count
				club, _ := byClub[clubKey].(map[string]any)
				if club == nil {
					club = emptyGrowthClubAnalytics()
				}
				club[event] = integerValue(club[event]) + count
				byClub[clubKey] = club
			}
		}
	}
	return result
}

func growthClubKey(country string, id int64) string {
	if country != "japan" {
		country = "china"
	}
	return country + ":" + strconvInt(id)
}
func growthWikiKey(country string, id int64) string {
	return strings.Replace(growthClubKey(country, id), ":", "-", 1)
}
func growthBool(value string) bool {
	return containsString([]string{"1", "true", "yes"}, strings.ToLower(strings.TrimSpace(value)))
}
func cleanGrowthKey(value string) string {
	return firstNonEmpty(regexpReplace(value, `[^a-zA-Z0-9:_-]`, ""), "global")
}
func cleanGrowthSource(value string) string {
	return firstNonEmpty(regexpReplace(string(value), `[^a-zA-Z0-9:_-]`, ""), "web")
}
func regexpReplace(value, pattern, replacement string) string {
	return regexp.MustCompile(pattern).ReplaceAllString(value, replacement)
}
func emptyGrowthClubAnalytics() map[string]any {
	return map[string]any{"club_share_view": int64(0), "club_share_copy": int64(0), "club_apply_click": int64(0), "bot_share_query": int64(0)}
}
func firstFive(values []map[string]any) []map[string]any {
	if len(values) > 5 {
		return values[:5]
	}
	return values
}
func urlQueryEscape(value string) string {
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}
