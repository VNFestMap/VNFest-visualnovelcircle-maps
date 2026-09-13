package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	llmintegration "github.com/VNFestMap/galgame-community-map/backend/internal/integrations/llm"
)

var portraitDimensions = []string{
	"organization_stability", "activity_execution", "member_scale_participation",
	"content_accumulation", "external_connection", "continuity",
}

func (s *Server) portrait(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action"))) {
	case "prefill":
		if r.Method != http.MethodGet {
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"error": "未知 action，支持: analyze, correct, prefill"})
			return
		}
		s.portraitPrefill(w, r)
	case "analyze", "llm-correction/start":
		s.portraitAnalyze(w, r, false)
	case "correct", "llm-correction/complete":
		s.portraitAnalyze(w, r, true)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"error": "未知 action，支持: analyze, correct, prefill"})
	}
}

func (s *Server) portraitAnalyze(w http.ResponseWriter, r *http.Request, complete bool) {
	if r.Method != http.MethodPost {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"error": "请求体不完整，需要 basic_info, dimensions, base_scores"})
		return
	}
	var input map[string]any
	if err := decodeJSON(r, &input, 2<<20); err != nil || input == nil || input["basic_info"] == nil || input["dimensions"] == nil || input["base_scores"] == nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"error": "请求体不完整，需要 basic_info, dimensions, base_scores"})
		return
	}
	client := llmintegration.New(llmintegration.Config{
		Enabled: s.cfg.LLMEnabled, Provider: s.cfg.LLMProvider, APIKey: s.cfg.LLMAPIKey,
		APIURL: s.cfg.LLMAPIURL, Proxy: s.cfg.LLMProxy, Model: s.cfg.LLMModel,
		MaxTokens: s.cfg.LLMMaxTokens, Temperature: s.cfg.LLMTemperature,
	})
	prompt, _ := json.Marshal(input)
	result, err := client.Chat(r.Context(), portraitSystemPrompt, portraitUserPrompt(string(prompt), complete))
	if err != nil {
		if complete {
			writeJSON(w, portraitUnavailable("AI 顾问暂不可用，本地画像已生成。", true))
		} else {
			writeJSON(w, portraitUnavailable("AI 顾问暂不可用，本地画像已生成。", true))
		}
		return
	}
	if complete {
		writeJSON(w, normalizePortraitComplete(result))
		return
	}
	writeJSON(w, normalizePortraitStart(result))
}

func (s *Server) portraitPrefill(w http.ResponseWriter, r *http.Request) {
	userID, _ := s.optionalSessionUser(r)
	if userID == nil {
		writeJSON(w, map[string]any{"user": nil, "club": nil, "clubs": []any{}})
		return
	}
	user, err := s.findUser(r.Context(), *userID)
	if err != nil || user == nil {
		writeJSON(w, map[string]any{"user": nil, "club": nil, "clubs": []any{}})
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT club_id, COALESCE(country,'china') FROM club_memberships WHERE user_id=? AND status='active' ORDER BY joined_at DESC, id DESC`, *userID)
	if err != nil {
		writeJSON(w, map[string]any{"user": publicUser(user), "club": nil, "clubs": []any{}, "error": "数据库查询失败"})
		return
	}
	defer rows.Close()
	clubs := []any{}
	for rows.Next() {
		var clubID int64
		var country string
		if rows.Scan(&clubID, &country) != nil || clubID <= 0 {
			continue
		}
		name := "clubs.json"
		if country == "japan" {
			name = "clubs_japan.json"
		}
		for _, value := range mustDocumentRows(s, name) {
			club, ok := value.(map[string]any)
			if ok && integerValue(club["id"]) == clubID {
				clubs = append(clubs, normalizePortraitClub(club, clubID, country))
				break
			}
		}
	}
	var selected any
	if len(clubs) > 0 {
		selected = clubs[0]
	}
	writeJSON(w, map[string]any{"user": publicUser(user), "club": selected, "clubs": clubs})
}

func mustDocumentRows(s *Server, name string) []any {
	rows, _ := s.extractDocument(name)
	return rows
}

func normalizePortraitClub(club map[string]any, id int64, country string) map[string]any {
	foundedYear := any(nil)
	created := stringValue(club["created_at"])
	if len(created) >= 4 {
		if year := integerValue(created[:4]); year > 1900 && year <= int64(time.Now().Year()) {
			foundedYear = year
		}
	}
	province := firstNonEmpty(stringValue(club["province"]), stringValue(club["prefecture"]))
	city := firstNonEmpty(stringValue(club["prefecture"]), stringValue(club["province"]))
	return map[string]any{
		"club_id": id, "country": country, "name": stringValue(club["name"]),
		"display_name": firstNonEmpty(stringValue(club["display_name"]), stringValue(club["name"])),
		"school":       stringValue(club["school"]), "province": province, "city": city,
		"founded_year": foundedYear, "remark": stringValue(club["remark"]),
	}
}

func portraitUnavailable(message string, errorState bool) map[string]any {
	return map[string]any{
		"follow_up_questions": []any{}, "llm_available": false, "llm_error": errorState,
		"llm_error_type": "not_configured", "finish_reason": nil, "http_status": nil, "message": message,
	}
}

func normalizePortraitStart(result map[string]any) map[string]any {
	questions := []any{}
	for _, value := range anySlice(result["follow_up_questions"]) {
		question, ok := value.(map[string]any)
		if !ok || strings.TrimSpace(stringValue(question["question"])) == "" {
			continue
		}
		questions = append(questions, map[string]any{
			"id":               firstNonEmpty(stringValue(question["id"]), "q"+strconvInt(int64(len(questions)+1))),
			"question":         stringValue(question["question"]),
			"target_dimension": portraitDimension(stringValue(question["target_dimension"])),
			"input_type":       firstNonEmpty(stringValue(question["input_type"]), "textarea"),
			"reason":           stringValue(question["reason"]),
		})
		if len(questions) >= 5 {
			break
		}
	}
	return map[string]any{"follow_up_questions": questions, "message": stringValue(result["message"]), "llm_available": true, "llm_error": false}
}

func normalizePortraitComplete(result map[string]any) map[string]any {
	if result == nil {
		return portraitUnavailable("AI 顾问暂不可用，本地画像已生成。", true)
	}
	adjustment, _ := result["score_adjustment"].(map[string]any)
	if adjustment == nil {
		adjustment = map[string]any{}
	}
	for _, dimension := range portraitDimensions {
		value := integerValue(adjustment[dimension])
		if value < -10 {
			value = -10
		}
		if value > 10 {
			value = 10
		}
		adjustment[dimension] = value
	}
	result["score_adjustment"] = adjustment
	for _, key := range []string{"dimension_analysis", "strengths", "risks", "suggestions", "advantages", "recommendations", "revised_scores"} {
		if result[key] == nil {
			result[key] = []any{}
		}
	}
	result["advisor_summary"] = firstNonEmpty(stringValue(result["advisor_summary"]), stringValue(result["summary"]))
	result["follow_up_questions"] = []any{}
	result["llm_available"], result["llm_error"] = true, false
	return result
}

func portraitDimension(value string) string {
	for _, candidate := range portraitDimensions {
		if value == candidate {
			return value
		}
	}
	return portraitDimensions[0]
}

const portraitSystemPrompt = "你是高校视觉小说同好会运行状态分析专家。请根据输入证据生成严格 JSON，关注组织稳定、活动执行、成员参与、内容沉淀、外部连接和传承持续，不进行排名，不编造事实。"

func portraitUserPrompt(input string, complete bool) string {
	if complete {
		return "请基于以下表单和追问答案输出完整运行画像 JSON，score_adjustment 每项为 -10 到 10 的整数，follow_up_questions 必须为空数组。输入：" + input
	}
	return "请基于以下表单仅输出需要澄清的 follow_up_questions 数组和 message，问题最多 5 个，输入：" + input
}
