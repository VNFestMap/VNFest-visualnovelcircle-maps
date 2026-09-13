package httpapi

import (
	"net/http"
	"strings"
)

// migratePublications keeps the one-shot publication -> project-hub migration
// available at its original URL. It deliberately operates on the same JSON
// files as the PHP endpoint and is idempotent: an existing migrated_at marker
// is treated as the completion record and no rows are rewritten.
func (s *Server) migratePublications(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	userID, role := s.optionalSessionUser(r)
	if userID == nil || role != "super_admin" {
		if _, ok := s.adminUserID(r); !ok || role != "super_admin" {
			writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "需要超级管理员权限"})
			return
		}
	}

	projectsData := s.projectHubReadMap(r.Context(), "projects.json", map[string]any{"projects": []any{}, "migrated_at": nil})
	if strings.TrimSpace(stringValue(projectsData["migrated_at"])) != "" {
		writeJSON(w, map[string]any{"success": true, "message": "已迁移，无需重复执行", "stats": map[string]any{"projects_migrated": 0, "items_created": 0}})
		return
	}

	projects := mapSlice(projectsData["projects"])
	existingProjectIDs := map[int64]bool{}
	for _, project := range projects {
		if id := integerValue(project["legacy_publication_id"]); id > 0 {
			existingProjectIDs[id] = true
		}
	}
	itemsData := s.projectHubReadMap(r.Context(), "project_items.json", map[string]any{"items": []any{}})
	items := mapSlice(itemsData["items"])
	existingItemIDs := map[string]bool{}
	for _, item := range items {
		existingItemIDs[stringValue(item["id"])] = true
	}

	fallback := s.publicationProjectFallback(r)
	newProjects := make([]map[string]any, 0, len(fallback.projects))
	for _, project := range fallback.projects {
		id := integerValue(project["legacy_publication_id"])
		if id > 0 && !existingProjectIDs[id] {
			newProjects = append(newProjects, project)
			existingProjectIDs[id] = true
		}
	}
	newItems := make([]map[string]any, 0, len(fallback.items))
	for _, item := range fallback.items {
		id := stringValue(item["id"])
		if id != "" && !existingItemIDs[id] {
			newItems = append(newItems, item)
			existingItemIDs[id] = true
		}
	}

	projects = append(projects, newProjects...)
	items = append(items, newItems...)
	projectsData["projects"] = projects
	projectsData["migrated_at"] = projectHubNow()
	itemsData["items"] = items
	if err := s.projectHubWriteMap(r.Context(), "projects.json", projectsData); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "迁移写入失败"})
		return
	}
	if err := s.projectHubWriteMap(r.Context(), "project_items.json", itemsData); err != nil {
		// A failed secondary write must not silently leave a completed marker.
		// Restore only the in-memory original marker; the primary file remains a
		// valid JSON document and a subsequent run can be inspected/reconciled.
		projectsData["migrated_at"] = nil
		_ = s.projectHubWriteMap(r.Context(), "projects.json", projectsData)
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "迁移写入失败"})
		return
	}
	writeJSON(w, map[string]any{"success": true, "message": "迁移完成", "stats": map[string]any{"projects_migrated": len(newProjects), "items_created": len(newItems)}})
}

type publicationProjectFallbackData struct {
	projects []map[string]any
	items    []map[string]any
}

func (s *Server) publicationProjectFallback(r *http.Request) publicationProjectFallbackData {
	data := s.projectHubReadMap(r.Context(), "publications.json", map[string]any{"publications": []any{}})
	result := publicationProjectFallbackData{}
	for _, value := range anySlice(data["publications"]) {
		publication, ok := value.(map[string]any)
		if !ok {
			continue
		}
		id := integerValue(publication["id"])
		if id <= 0 {
			continue
		}
		clubs := normalizeProjectClubs(publication["club_ids"])
		if len(clubs) == 0 {
			if club := s.findProjectClubByName(r, stringValue(publication["clubName"])); club != nil {
				clubs = append(clubs, club)
			}
		}
		organizer := map[string]any{"id": int64(0), "country": "china"}
		if len(clubs) > 0 {
			organizer = clubs[0]
		}
		status := publicationProjectStatus(stringValue(publication["status"]))
		result.projects = append(result.projects, map[string]any{
			"id": id, "title": firstNonEmpty(stringValue(publication["publicationName"]), "未命名刊物"),
			"project_type": "publication", "is_joint": len(clubs) > 1, "status": status,
			"organizer_club": organizer, "participant_clubs": clubs,
			"summary": cleanProjectText(publication["description"], 100), "description": stringValue(publication["description"]),
			"cover_image": stringValue(publication["image_url"]), "deadline": stringValue(publication["deadline"]),
			"results_description": "", "results_link": "", "deleted_at": nil,
			"created_at":            firstNonEmpty(stringValue(publication["created_at"]), projectHubNow()),
			"updated_at":            firstNonEmpty(stringValue(publication["updated_at"]), projectHubNow()),
			"legacy_publication_id": id,
		})
		result.items = append(result.items, map[string]any{
			"id": "migrated_" + strconvInt(id), "project_id": id, "type": "submission", "label": "稿件投稿",
			"description": strings.TrimSpace(stringValue(publication["submitContact"]) + func() string {
				if link := stringValue(publication["submitLink"]); link != "" {
					return "\n" + link
				}
				return ""
			}()), "deadline": stringValue(publication["deadline"]),
			"status":    map[bool]string{true: "closed", false: "open"}[status == "archived"],
			"max_slots": nil, "form_schema": nil, "deleted_at": nil,
		})
	}
	return result
}

func publicationProjectStatus(status string) string {
	switch status {
	case "planning":
		return "draft"
	case "publishing", "completed":
		return "completed"
	case "suspended":
		return "archived"
	default:
		return "collecting"
	}
}

func (s *Server) findProjectClubByName(r *http.Request, name string) map[string]any {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	for _, source := range []struct {
		file, country string
	}{
		{"clubs.json", "china"}, {"clubs_japan.json", "japan"},
	} {
		rows, _ := s.extractDocument(source.file)
		for _, value := range rows {
			club, ok := value.(map[string]any)
			if !ok {
				continue
			}
			for _, candidate := range []string{stringValue(club["name"]), stringValue(club["display_name"]), stringValue(club["school"]), stringValue(club["raw_text"])} {
				if candidate == name {
					return map[string]any{"id": integerValue(club["id"]), "country": source.country, "name": firstNonEmpty(stringValue(club["name"]), firstNonEmpty(stringValue(club["display_name"]), name))}
				}
			}
		}
	}
	return nil
}
