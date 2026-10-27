package httpapi

import "net/http"

func (s *Server) adminUserID(r *http.Request) (int64, bool) {
	id, role := s.optionalSessionUser(r)
	if id != nil && role == "super_admin" {
		return *id, true
	}
	return 0, false
}
func requireAdminResponse(w http.ResponseWriter) {
	writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "需要超级管理员权限"})
}

func (s *Server) adminDenied(w http.ResponseWriter, r *http.Request) {
	id, _ := s.optionalSessionUser(r)
	status := http.StatusForbidden
	message := "需要超级管理员权限"
	if id == nil {
		status = http.StatusUnauthorized
		message = "请先登录"
	}
	writeJSONStatus(w, status, map[string]any{"success": false, "message": message})
}
