package httpapi

import (
	"context"
	"net/http"
)

var spaceRoleHierarchy = map[string]float64{
	"visitor":        0,
	"external":       0.5,
	"member":         1,
	"manager":        2,
	"representative": 3,
	"super_admin":    4,
}

// spaceAccess evaluates the effective system and active club membership role.
// Membership lookup errors deliberately fail closed so a storage problem can
// never turn into anonymous access to the space.
func (s *Server) spaceAccess(ctx context.Context, userID *int64, systemRole string) (bool, string) {
	if userID == nil || *userID <= 0 {
		return false, "login_required"
	}
	if s.db == nil {
		return false, "unavailable"
	}

	level := spaceRoleHierarchy[systemRole]
	rows, err := s.db.QueryContext(ctx, `SELECT role FROM club_memberships WHERE user_id = ? AND status = 'active' AND role IN ('member', 'manager', 'representative')`, *userID)
	if err != nil {
		return false, "unavailable"
	}
	defer rows.Close()
	for rows.Next() {
		var role string
		if err := rows.Scan(&role); err != nil {
			return false, "unavailable"
		}
		if membershipLevel := spaceRoleHierarchy[role]; membershipLevel > level {
			level = membershipLevel
		}
	}
	if err := rows.Err(); err != nil {
		return false, "unavailable"
	}
	if level >= spaceRoleHierarchy["member"] {
		return true, "ok"
	}
	return false, "membership_required"
}

func writeSpaceAccessError(w http.ResponseWriter, reason string) {
	switch reason {
	case "login_required":
		postsError(w, "login_required", "请先登录后进入同好会空间", http.StatusUnauthorized, nil)
	case "membership_required":
		postsError(w, "membership_required", "空间仅对成员及以上身份开放", http.StatusForbidden, nil)
	default:
		postsError(w, "space_access_unavailable", "空间权限暂时无法确认，请稍后重试", http.StatusServiceUnavailable, nil)
	}
}

func (s *Server) requireSpaceAccess(w http.ResponseWriter, r *http.Request) (int64, bool) {
	userID, role := s.optionalSessionUser(r)
	allowed, reason := s.spaceAccess(r.Context(), userID, role)
	if !allowed {
		writeSpaceAccessError(w, reason)
		return 0, false
	}
	return *userID, true
}
