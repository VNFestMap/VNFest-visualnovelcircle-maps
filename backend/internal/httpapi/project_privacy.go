package httpapi

import (
	"net/http"
	"strings"
)

func (s *Server) projectHubGetSecure(w http.ResponseWriter, r *http.Request) {
	var current *user
	if id, _ := s.optionalSessionUser(r); id != nil {
		current, _ = s.findUser(r.Context(), *id)
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/")
	file, key := "projects.json", "projects"
	if path == "project_items.php" {
		file, key = "project_items.json", "items"
	}
	if path == "project_participations.php" {
		file, key = "project_participations.json", "participations"
	}
	result := []map[string]any{}
	for _, row := range s.projectHubRows(r.Context(), file, key) {
		project := row
		if key != "projects" {
			project = s.fileProject(r, integerValue(row["project_id"]))
		}
		manage := current != nil && project != nil && s.projectHubCanManageProject(r.Context(), current, project)
		if project == nil {
			continue
		}
		if stringValue(project["deleted_at"]) != "" || stringValue(row["deleted_at"]) != "" {
			if !manage || r.URL.Query().Get("include_deleted") != "1" {
				continue
			}
		} else if !publicProject(project) && !manage {
			continue
		}
		if key == "projects" {
			if typ := r.URL.Query().Get("type"); typ != "" && stringValue(row["project_type"]) != typ {
				continue
			}
			if status := r.URL.Query().Get("status"); status != "" && stringValue(row["status"]) != status {
				continue
			}
		} else {
			if id := parsePositiveInt(r.URL.Query().Get("project_id")); id > 0 && integerValue(row["project_id"]) != id {
				continue
			}
		}
		own := current != nil && integerValue(row["user_id"]) == current.ID
		if key == "participations" {
			if stringValue(row["status"]) == "withdrawn" && (!manage || r.URL.Query().Get("include_withdrawn") != "1") {
				continue
			}
			if id := r.URL.Query().Get("item_id"); id != "" && stringValue(row["item_id"]) != id {
				continue
			}
		}
		out := map[string]any{}
		for k, v := range row {
			out[k] = v
		}
		if key == "participations" && !manage && !own {
			for _, k := range []string{"contact", "content", "attachments", "review_note", "reviewed_by"} {
				delete(out, k)
			}
		}
		result = append(result, out)
	}
	writeJSON(w, map[string]any{"success": true, key: result})
}
