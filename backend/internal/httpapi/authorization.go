package httpapi

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

func (s *Server) adminUserID(r *http.Request) (int64, bool) {
	userID, role := s.optionalSessionUser(r)
	if userID != nil {
		if role == "super_admin" || role == "manager" || role == "representative" {
			return *userID, true
		}
		if s.db != nil {
			var exists int
			err := s.db.QueryRowContext(r.Context(), `SELECT 1 FROM club_memberships
                WHERE user_id = ? AND role IN ('manager', 'representative') AND status = 'active' LIMIT 1`, *userID).Scan(&exists)
			if err == nil {
				return *userID, true
			}
		}
	}
	if s.cfg.LegacyAuthEnabled && s.cfg.AdminToken != "" {
		token := strings.TrimSpace(r.Header.Get("X-Admin-Token"))
		if token != "" && subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.AdminToken)) == 1 {
			return 0, true
		}
	}
	return 0, false
}

func requireAdminResponse(w http.ResponseWriter) {
	writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "未授权访问"})
}
