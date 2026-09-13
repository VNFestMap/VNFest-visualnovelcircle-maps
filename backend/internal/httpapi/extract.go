package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

const extractDefaultLimit = 20

// extract is the native Go implementation of the read-only aggregation API.
// It intentionally reads the same JSON documents and legacy tables as PHP;
// it does not introduce a new public data model during the migration.
func (s *Server) extract(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet {
		writeJSONStatus(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "message": "GET only"})
		return
	}
	resource := strings.ToLower(strings.TrimSpace(firstNonEmpty(r.URL.Query().Get("resource"), r.URL.Query().Get("type"))))
	if resource == "" || resource == "all" {
		resource = "summary"
	}
	var data any
	switch resource {
	case "help":
		data = map[string]any{"resources": []string{"summary", "clubs", "events", "publications", "moe_contests", "user"}, "params": map[string]any{"resource": "summary|clubs|events|publications|moe_contests|user", "country": "all|china|japan, used by clubs and moe_contests", "q": "text search", "id": "resource id", "limit": "1-100, default 20", "include_contact": "1 to include club contact only when current viewer can see it"}, "examples": []string{"/api/extract.php", "/api/extract.php?resource=clubs&country=china&limit=10", "/api/extract.php?resource=events&q=GalOnly", "/api/extract.php?resource=user"}}
	case "summary":
		data = map[string]any{"viewer": s.extractViewer(r), "clubs": s.extractClubs(r), "events": s.extractEvents(r), "publications": s.extractPublications(r), "moe_contests": s.extractMoeContests(r)}
	case "clubs":
		data = s.extractClubs(r)
	case "events":
		data = s.extractEvents(r)
	case "publications":
		data = s.extractPublications(r)
	case "moe", "moe_contests":
		resource = "moe_contests"
		data = s.extractMoeContests(r)
	case "user", "me":
		resource = "user"
		userID, _ := s.optionalSessionUser(r)
		if userID == nil {
			writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "Login required", "logged_in": false})
			return
		}
		data = s.extractUser(r, *userID)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "Unknown resource", "resource": resource})
		return
	}
	writeJSON(w, map[string]any{"success": true, "resource": resource, "generated_at": time.Now().UTC().Format(time.RFC3339), "data": data})
}

func (s *Server) extractLimit(r *http.Request) int {
	limit := queryInt(r, "limit")
	if limit < 1 {
		return extractDefaultLimit
	}
	if limit > 100 {
		return 100
	}
	return int(limit)
}

func (s *Server) extractCountry(r *http.Request) string {
	country := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("country")))
	if country != "china" && country != "japan" {
		return "all"
	}
	return country
}

func extractMatches(row map[string]any, query string, fields ...string) bool {
	if query == "" {
		return true
	}
	query = strings.ToLower(query)
	for _, field := range fields {
		value := row[field]
		if list, ok := value.([]any); ok {
			value = strings.Join(anyStrings(list), " ")
		}
		if strings.Contains(strings.ToLower(stringValue(value)), query) {
			return true
		}
	}
	return false
}

func anyStrings(values []any) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = append(result, stringValue(value))
	}
	return result
}

func (s *Server) extractDocument(name string) ([]any, error) {
	if s.files == nil {
		return []any{}, nil
	}
	var document map[string]any
	if err := s.files.ReadJSON(contextBackground(), name, &document); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []any{}, nil
		}
		return nil, err
	}
	return anySlice(document[map[string]string{"clubs.json": "data", "clubs_japan.json": "data", "events.json": "events", "publications.json": "publications"}[name]]), nil
}

func contextBackground() context.Context { return context.Background() }

func (s *Server) extractClubs(r *http.Request) map[string]any {
	country := s.extractCountry(r)
	query := strings.TrimSpace(firstNonEmpty(r.URL.Query().Get("q"), r.URL.Query().Get("query")))
	id := queryInt(r, "id")
	includeContact := r.URL.Query().Get("include_contact") != ""
	viewerID, viewerRole := s.optionalSessionUser(r)
	memberships := s.membershipMap(r.Context(), viewerID)
	rows := []map[string]any{}
	available := map[string]int{"china": 0, "japan": 0}
	for _, source := range []struct{ name, country string }{{"clubs.json", "china"}, {"clubs_japan.json", "japan"}} {
		if country != "all" && country != source.country {
			continue
		}
		values, err := s.extractDocument(source.name)
		if err != nil {
			continue
		}
		available[source.country] = len(values)
		for _, value := range values {
			club, ok := value.(map[string]any)
			if !ok || (id > 0 && integerValue(club["id"]) != id) || !extractMatches(club, query, "name", "display_name", "school", "province", "prefecture", "type", "project") {
				continue
			}
			item := map[string]any{"id": integerValue(club["id"]), "country": source.country, "name": firstNonEmpty(stringValue(club["display_name"]), stringValue(club["name"])), "short_name": stringValue(club["name"]), "school": stringValue(club["school"]), "region": stringFirst(stringValue(club[map[string]string{"japan": "prefecture", "china": "province"}[source.country]]), stringValue(club["province"]), stringValue(club["prefecture"])), "type": firstNonEmpty(stringValue(club["type"]), "school"), "verified": integerValue(club["verified"]), "project": firstNonEmpty(stringValue(club["project"]), "galgame"), "created_at": stringValue(club["created_at"]), "logo_url": stringValue(club["logo_url"]), "external_links": stringValue(club["external_links"])}
			if region := stringValue(item["region"]); region != "" {
				item["regions"] = []string{region}
			} else {
				item["regions"] = []string{}
			}
			if includeContact {
				key := fmt.Sprintf("%d:%s", integerValue(club["id"]), source.country)
				member := memberships[key]
				level := roleLevel(viewerRole)
				canSee := boolValue(club["visible_by_default"]) || member.status == "active" || viewerRole == "super_admin" || (!boolValue(club["protected"]) && level >= 1)
				if canSee && stringValue(club["info"]) != "" {
					item["contact"] = stringValue(club["info"])
					item["contact_hidden"] = false
				} else {
					item["contact_hidden"] = stringValue(club["info"]) != ""
				}
			}
			rows = append(rows, item)
		}
	}
	return map[string]any{"total": len(rows), "available": map[string]int{"china": available["china"], "japan": available["japan"], "all": available["china"] + available["japan"]}, "items": sliceAnyMaps(rows, s.extractLimit(r))}
}

func roleLevel(role string) int {
	return map[string]int{"visitor": 0, "external": 0, "member": 1, "manager": 2, "representative": 3, "super_admin": 4}[role]
}

func stringFirst(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func sliceAnyMaps(values []map[string]any, limit int) []map[string]any {
	if len(values) > limit {
		return values[:limit]
	}
	return values
}

func (s *Server) extractEvents(r *http.Request) map[string]any {
	values, _ := s.extractDocument("events.json")
	query, id := strings.TrimSpace(firstNonEmpty(r.URL.Query().Get("q"), r.URL.Query().Get("query"))), queryInt(r, "id")
	items := []map[string]any{}
	for _, value := range values {
		row, ok := value.(map[string]any)
		if !ok || (id > 0 && integerValue(row["id"]) != id) || !extractMatches(row, query, "event", "date", "description", "link") {
			continue
		}
		items = append(items, map[string]any{"id": integerValue(row["id"]), "title": stringValue(row["event"]), "date": stringValue(row["date"]), "description": stringValue(row["description"]), "image_url": stringValue(row["image"]), "link": stringValue(row["link"]), "official": integerValue(firstNonEmptyAny(row["offical"], row["official"])), "created_at": stringValue(row["created_at"])})
	}
	return map[string]any{"total": len(items), "items": sliceAnyMaps(items, s.extractLimit(r))}
}

func firstNonEmptyAny(values ...any) any {
	for _, value := range values {
		if stringValue(value) != "" {
			return value
		}
	}
	return nil
}

func (s *Server) extractPublications(r *http.Request) map[string]any {
	values, _ := s.extractDocument("publications.json")
	query, id := strings.TrimSpace(firstNonEmpty(r.URL.Query().Get("q"), r.URL.Query().Get("query"))), queryInt(r, "id")
	items := []map[string]any{}
	for _, value := range values {
		row, ok := value.(map[string]any)
		if !ok || (id > 0 && integerValue(row["id"]) != id) || !extractMatches(row, query, "publicationName", "clubName", "status", "deadline", "description") {
			continue
		}
		clubIDs := []any{}
		if list, ok := row["club_ids"].([]any); ok {
			clubIDs = list
		}
		items = append(items, map[string]any{"id": integerValue(row["id"]), "title": stringValue(row["publicationName"]), "club_name": stringValue(row["clubName"]), "club_ids": clubIDs, "status": stringValue(row["status"]), "deadline": stringValue(row["deadline"]), "description": stringValue(row["description"]), "submit_contact": stringValue(row["submitContact"]), "submit_link": stringValue(row["submitLink"]), "image_url": stringValue(row["image_url"]), "created_at": stringValue(row["created_at"]), "updated_at": stringValue(row["updated_at"])})
	}
	return map[string]any{"total": len(items), "items": sliceAnyMaps(items, s.extractLimit(r))}
}

func (s *Server) extractMoeContests(r *http.Request) map[string]any {
	if s.db == nil {
		return map[string]any{"total": 0, "items": []any{}}
	}
	where := []string{"visibility='public'", "status <> 'draft'"}
	args := []any{}
	if id := queryInt(r, "id"); id > 0 {
		where = append(where, "id=?")
		args = append(args, id)
	}
	if country := s.extractCountry(r); country != "all" {
		where = append(where, "country=?")
		args = append(args, country)
	}
	if query := strings.TrimSpace(firstNonEmpty(r.URL.Query().Get("q"), r.URL.Query().Get("query"))); query != "" {
		where = append(where, "(title LIKE ? OR description LIKE ?)")
		args = append(args, "%"+query+"%", "%"+query+"%")
	}
	condition := strings.Join(where, " AND ")
	var total int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM moe_contests WHERE "+condition, args...).Scan(&total); err != nil {
		return map[string]any{"total": 0, "items": []any{}}
	}
	rows, err := s.db.QueryContext(r.Context(), "SELECT id,club_id,country,title,description,cover_url,candidate_mode,status,visibility,eligibility_mode,result_visibility,published_at,ended_at,updated_at FROM moe_contests WHERE "+condition+" ORDER BY updated_at DESC,id DESC LIMIT ?", append(args, s.extractLimit(r))...)
	if err != nil {
		return map[string]any{"total": total, "items": []any{}}
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, clubID int64
		var country, title, description, cover, candidate, status, visibility, eligibility, resultVisibility string
		var published, ended, updated any
		if rows.Scan(&id, &clubID, &country, &title, &description, &cover, &candidate, &status, &visibility, &eligibility, &resultVisibility, &published, &ended, &updated) == nil {
			items = append(items, map[string]any{"id": id, "club_id": clubID, "country": country, "title": title, "description": description, "cover_url": cover, "candidate_mode": candidate, "status": status, "visibility": visibility, "eligibility_mode": eligibility, "result_visibility": resultVisibility, "published_at": databaseValueString(published), "ended_at": databaseValueString(ended), "updated_at": databaseValueString(updated)})
		}
	}
	return map[string]any{"total": total, "items": items}
}

func (s *Server) extractViewer(r *http.Request) map[string]any {
	id, _ := s.optionalSessionUser(r)
	if id == nil {
		return map[string]any{"logged_in": false, "user": nil}
	}
	user, err := s.scanUserQuery(r.Context(), "WHERE id=? AND status='active'", *id)
	if err != nil || user == nil {
		return map[string]any{"logged_in": false, "user": nil}
	}
	return map[string]any{"logged_in": true, "user": s.publicUser(r.Context(), user)}
}

func (s *Server) extractUser(r *http.Request, userID int64) map[string]any {
	user, err := s.scanUserQuery(r.Context(), "WHERE id=? AND status='active'", userID)
	if err != nil || user == nil {
		return map[string]any{"user": nil, "memberships": []any{}, "notifications": map[string]any{"total": 0, "unread": 0, "items": []any{}}, "pending_membership_count": 0}
	}
	memberships := []map[string]any{}
	rows, err := s.db.QueryContext(r.Context(), "SELECT id,club_id,COALESCE(country,'china'),role,status,joined_at FROM club_memberships WHERE user_id=? ORDER BY joined_at DESC", userID)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var id, clubID int64
			var country, role, status string
			var joined any
			if rows.Scan(&id, &clubID, &country, &role, &status, &joined) == nil {
				memberships = append(memberships, map[string]any{"id": id, "club_id": clubID, "country": country, "role": role, "status": status, "joined_at": databaseValueString(joined)})
			}
		}
	}
	notifications := map[string]any{"total": 0, "unread": 0, "items": []any{}}
	var total, unread int64
	if s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM notifications WHERE user_id=?", userID).Scan(&total) == nil && s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM notifications WHERE user_id=? AND is_read=0", userID).Scan(&unread) == nil {
		notifications["total"], notifications["unread"] = total, unread
	}
	return map[string]any{"user": s.publicUser(r.Context(), user), "memberships": memberships, "notifications": notifications, "pending_membership_count": s.extractPendingMembership(r.Context(), user)}
}

func (s *Server) extractPendingMembership(ctx context.Context, user *user) int64 {
	var count int64
	if user.Role == "super_admin" {
		_ = s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM club_memberships WHERE status='pending'").Scan(&count)
		return count
	}
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM club_memberships cm WHERE cm.status='pending' AND EXISTS (SELECT 1 FROM club_memberships mgr WHERE mgr.user_id=? AND mgr.club_id=cm.club_id AND mgr.status='active' AND mgr.role IN ('representative','manager') AND (mgr.country=cm.country OR mgr.country IS NULL OR mgr.country=''))`, user.ID).Scan(&count)
	return count
}
