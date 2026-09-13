package httpapi

import (
	"context"
	"crypto/md5"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

var voteProjectTypes = []string{"twelve", "moe"}
var voteProjectStatuses = []string{"draft", "published", "running", "ended", "archived", "suspended"}
var voteVisibilities = []string{"public", "unlisted", "club_only"}
var voteEligibilityModes = []string{"club_member", "public", "invite_code", "whitelist"}
var voteResultVisibilities = []string{"live_votes", "live_rank_only", "after_stage", "after_event", "hidden"}

type voteProjectView struct {
	ID, ClubID, CreatedBy                  int64
	ProjectType, Country, Title, YearLabel string
	Description, CoverURL, Status          string
	Visibility, EligibilityMode            string
	ResultVisibility, ConfigJSON           string
	ShareToken                             string
	GuestVote                              int64
	CreatedAt, UpdatedAt, PublishedAt      string
	EndedAt                                string
}

func (s *Server) voteProject(ctx context.Context, id int64) (*voteProjectView, error) {
	var result voteProjectView
	err := s.db.QueryRowContext(ctx, `SELECT id,project_type,club_id,country,title,COALESCE(year_label,''),COALESCE(description,''),COALESCE(cover_url,''),status,visibility,eligibility_mode,result_visibility,COALESCE(config_json,'{}'),COALESCE(share_token,''),guest_vote,created_by,created_at,updated_at,COALESCE(published_at,''),COALESCE(ended_at,'') FROM vote_projects WHERE id=?`, id).Scan(&result.ID, &result.ProjectType, &result.ClubID, &result.Country, &result.Title, &result.YearLabel, &result.Description, &result.CoverURL, &result.Status, &result.Visibility, &result.EligibilityMode, &result.ResultVisibility, &result.ConfigJSON, &result.ShareToken, &result.GuestVote, &result.CreatedBy, &result.CreatedAt, &result.UpdatedAt, &result.PublishedAt, &result.EndedAt)
	return &result, err
}

func (project voteProjectView) publicMap() map[string]any {
	config := map[string]any{}
	_ = json.Unmarshal([]byte(project.ConfigJSON), &config)
	return map[string]any{"id": project.ID, "project_type": project.ProjectType, "club_id": project.ClubID, "country": project.Country, "title": project.Title, "year_label": project.YearLabel, "description": project.Description, "cover_url": project.CoverURL, "status": project.Status, "visibility": project.Visibility, "eligibility_mode": project.EligibilityMode, "result_visibility": project.ResultVisibility, "guest_vote": project.GuestVote, "config": config, "created_by": project.CreatedBy, "created_at": project.CreatedAt, "updated_at": project.UpdatedAt, "published_at": project.PublishedAt, "ended_at": project.EndedAt}
}

func voteProjectCountry(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "japan" {
		return value
	}
	return "china"
}

func voteProjectID(values ...any) int64 {
	for _, value := range values {
		if id := integerValue(value); id > 0 {
			return id
		}
		if text := strings.TrimSpace(stringValue(value)); text != "" {
			if id, err := strconv.ParseInt(text, 10, 64); err == nil && id > 0 {
				return id
			}
		}
	}
	return 0
}

func votePathProjectType(pathValue string) string {
	switch strings.TrimPrefix(pathValue, "/api/") {
	case "moe_candidates.php", "moe_contests.php", "moe_matches.php", "moe_stages.php", "moe_votes.php":
		return "moe"
	case "twelve_contests.php", "twelve_rounds.php", "twelve_votes.php", "twelve_works.php":
		return "twelve"
	default:
		return ""
	}
}

func voteNormalize(value string, allowed []string, fallback string) string {
	for _, candidate := range allowed {
		if value == candidate {
			return value
		}
	}
	return fallback
}

func (s *Server) voteCanManage(ctx context.Context, user *user, project *voteProjectView) bool {
	return user != nil && project != nil && s.canManageClubCodes(ctx, user, project.ClubID, voteProjectCountry(project.Country))
}

func (s *Server) voteCanRead(ctx context.Context, user *user, project *voteProjectView) bool {
	if project == nil {
		return false
	}
	if project.Visibility == "public" || project.Visibility == "unlisted" {
		return true
	}
	return s.voteCanParticipate(ctx, user, project)
}

func (s *Server) voteCanParticipate(ctx context.Context, user *user, project *voteProjectView) bool {
	if user == nil {
		return false
	}
	if s.voteCanManage(ctx, user, project) {
		return true
	}
	if project.EligibilityMode == "public" {
		return true
	}
	if project.EligibilityMode != "club_member" {
		return false
	}
	var id int64
	return s.db.QueryRowContext(ctx, "SELECT id FROM club_memberships WHERE user_id=? AND club_id=? AND country=? AND status='active' LIMIT 1", user.ID, project.ClubID, voteProjectCountry(project.Country)).Scan(&id) == nil
}

func voteShareTokenMatches(project *voteProjectView, token string) bool {
	if project == nil || strings.TrimSpace(token) == "" || project.ShareToken == "" {
		return false
	}
	left, right := []byte(strings.TrimSpace(project.ShareToken)), []byte(strings.TrimSpace(token))
	return len(left) == len(right) && subtle.ConstantTimeCompare(left, right) == 1
}

func voteGuestKey(w http.ResponseWriter, r *http.Request) string {
	const cookieName = "vnGuestVoteKey"
	if cookie, err := r.Cookie(cookieName); err == nil && isVoteGuestKey(cookie.Value) {
		return cookie.Value
	}
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return ""
	}
	value := hex.EncodeToString(raw)
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: value, Path: "/", MaxAge: 63115200, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")})
	return value
}

func isVoteGuestKey(value string) bool {
	if len(value) != 32 {
		return false
	}
	for _, char := range value {
		if !(char >= '0' && char <= '9') && !(char >= 'a' && char <= 'f') {
			return false
		}
	}
	return true
}

func voteEntryIdentity(input map[string]any) string {
	sourceType := firstNonEmpty(stringValue(input["source_type"]), "manual")
	sourceID := strings.TrimSpace(stringValue(input["source_id"]))
	if sourceType != "manual" && sourceID != "" {
		return sourceType + ":" + sourceID
	}
	identity := strings.ToLower(strings.TrimSpace(stringValue(input["title"]))) + "|" +
		strings.ToLower(strings.TrimSpace(stringValue(input["title_cn"]))) + "|" +
		strings.ToLower(strings.TrimSpace(stringValue(input["subtitle"])))
	hash := md5.Sum([]byte(identity))
	return "manual:" + hex.EncodeToString(hash[:])
}

func voteEntryInput(input map[string]any, project *voteProjectView) map[string]any {
	sourceType := firstNonEmpty(stringValue(input["source_type"]), "manual")
	allowed := []string{"bangumi_subject", "vndb_vn", "manual"}
	if project.ProjectType == "moe" {
		allowed = []string{"bangumi_character", "manual"}
	}
	if !containsString(allowed, sourceType) {
		sourceType = "manual"
	}
	entry := map[string]any{"source_type": sourceType, "source_id": strings.TrimSpace(stringValue(input["source_id"])), "title": strings.TrimSpace(stringValue(input["title"])), "title_cn": strings.TrimSpace(stringValue(input["title_cn"])), "subtitle": strings.TrimSpace(stringValue(input["subtitle"])), "image_url": strings.TrimSpace(stringValue(input["image_url"])), "summary": strings.TrimSpace(stringValue(input["summary"])), "external_url": strings.TrimSpace(stringValue(input["external_url"]))}
	entry["identity_key"] = voteEntryIdentity(entry)
	return entry
}

func voteDefaultStagesFor(projectType string) [][7]any {
	if projectType == "moe" {
		return [][7]any{{"nomination", "提名期", 1, "nomination", 1, 0, 1}, {"qualifier", "海选", 2, "multi_select", 8, 32, 2}, {"bracket", "32 强 1v1 淘汰赛", 3, "match_single", 1, 1, 1}, {"final", "萌王决赛", 4, "match_single", 1, 1, 1}}
	}
	return [][7]any{{"nomination", "提名期", 1, "nomination", 1, 0, 1}, {"qualifier", "海选", 2, "multi_select", 12, 48, 2}, {"group_vote", "分组投票", 3, "multi_select", 12, 24, 4}, {"final", "最终十二器", 4, "multi_select", 12, 12, 1}}
}

func voteReadJSON(r *http.Request) map[string]any {
	input := map[string]any{}
	if decodeJSON(r, &input, 4<<20) != nil || input == nil {
		return map[string]any{}
	}
	return input
}
