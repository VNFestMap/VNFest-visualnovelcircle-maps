package httpapi

import "net/http"

func (s *Server) narrativeAuth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "https://narrative.map.vnfest.top")
	w.Header().Set("Access-Control-Allow-Credentials", "true")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	userID, _ := s.optionalSessionUser(r)
	if userID == nil {
		writeJSON(w, map[string]any{"ok": false, "user": nil})
		return
	}
	user, err := s.findUser(r.Context(), *userID)
	if err != nil || user == nil {
		writeJSON(w, map[string]any{"ok": false, "user": nil})
		return
	}
	var avatar any
	if user.AvatarURL != "" {
		avatar = user.AvatarURL
		if !hasHTTPPrefix(user.AvatarURL) {
			avatar = trimTrailingSlash(s.cfg.SiteURL) + "/" + trimLeadingSlash(user.AvatarURL)
		}
	}
	writeJSON(w, map[string]any{"ok": true, "user": map[string]any{
		"id": user.ID, "username": user.Username, "nickname": firstNonEmpty(user.Nickname, user.Username),
		"avatar_url": avatar, "role": user.Role, "is_audit": user.IsAudit,
	}})
}

func hasHTTPPrefix(value string) bool {
	return len(value) >= 7 && (value[:7] == "http://" || (len(value) >= 8 && value[:8] == "https://"))
}

func trimTrailingSlash(value string) string {
	for len(value) > 0 && value[len(value)-1] == '/' {
		value = value[:len(value)-1]
	}
	return value
}

func trimLeadingSlash(value string) string {
	for len(value) > 0 && value[0] == '/' {
		value = value[1:]
	}
	return value
}
