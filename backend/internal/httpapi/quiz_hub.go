package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"
)

func (s *Server) quizHub(w http.ResponseWriter, r *http.Request) {
	publicAPIHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if s.db == nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "数据库不可用"})
		return
	}
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action"))) {
	case "login_state":
		s.quizHubLoginState(w, r)
	case "shared_list":
		s.quizHubSharedList(w, r)
	case "shared_quiz":
		s.quizHubSharedQuiz(w, r)
	case "shared_upload":
		s.quizHubSharedUpload(w, r)
	case "shared_delete":
		s.quizHubSharedDelete(w, r)
	case "local":
		s.quizHubLocal(w, r)
	case "local_quiz":
		s.quizHubLocalQuiz(w, r)
	case "gallery":
		s.quizHubGallery(w, r)
	case "cover":
		s.quizHubCover(w, r)
	case "import":
		s.quizHubImport(w, r)
	default:
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "未知动作"})
	}
}

func (s *Server) quizHubLoginState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 GET"})
		return
	}
	userID, _ := s.optionalSessionUser(r)
	result := map[string]any{"success": true, "logged_in": userID != nil, "user_id": int64(0), "username": ""}
	if userID != nil {
		result["user_id"] = *userID
		var username string
		_ = s.db.QueryRowContext(r.Context(), "SELECT username FROM users WHERE id=?", *userID).Scan(&username)
		result["username"] = username
	}
	writeJSON(w, result)
}

func (s *Server) quizHubSharedList(w http.ResponseWriter, r *http.Request) {
	query := "SELECT id,title,description,uploader_id,uploader_name,question_count,type_counts,downloads,created_at FROM quiz_shares"
	args := []any{}
	if value := strings.TrimSpace(r.URL.Query().Get("q")); value != "" {
		query += " WHERE title LIKE ? OR uploader_name LIKE ?"
		args = append(args, "%"+value+"%", "%"+value+"%")
	}
	query += " ORDER BY id DESC LIMIT 200"
	rows, err := s.db.QueryContext(r.Context(), query, args...)
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "共享题库不可用"})
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, uploader, count, downloads int64
		var title, description, uploaderName, types string
		var created any
		if rows.Scan(&id, &title, &description, &uploader, &uploaderName, &count, &types, &downloads, &created) != nil {
			continue
		}
		var typeCounts any = map[string]any{}
		_ = json.Unmarshal([]byte(types), &typeCounts)
		items = append(items, map[string]any{"id": id, "title": title, "description": description, "uploader_id": uploader, "uploader_name": uploaderName, "question_count": count, "type_counts": typeCounts, "downloads": downloads, "created_at": databaseValueString(created)})
	}
	writeJSON(w, map[string]any{"success": true, "items": items})
}

func (s *Server) quizHubSharedQuiz(w http.ResponseWriter, r *http.Request) {
	id := queryInt(r, "id")
	var title, content string
	if err := s.db.QueryRowContext(r.Context(), "SELECT title,content FROM quiz_shares WHERE id=?", id).Scan(&title, &content); err != nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "题库不存在"})
		return
	}
	var quiz map[string]any
	if json.Unmarshal([]byte(content), &quiz) != nil || len(anySlice(quiz["questions"])) == 0 {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "题库内容已损坏"})
		return
	}
	quiz = recognitionStripAnswers(quiz)
	_, _ = s.db.ExecContext(r.Context(), "UPDATE quiz_shares SET downloads=downloads+1 WHERE id=?", id)
	writeJSON(w, map[string]any{"success": true, "title": title, "quiz": quiz})
}

func (s *Server) quizHubSharedUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
		return
	}
	userID, _ := s.optionalSessionUser(r)
	if userID == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	if err := r.ParseMultipartForm(5<<20 + 128<<10); err != nil {
		writeJSONStatus(w, http.StatusRequestEntityTooLarge, map[string]any{"success": false, "message": "文件超过 5MB 上限"})
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil || header == nil {
		writeJSON(w, map[string]any{"success": false, "message": "请选择要上传的题库 JSON 文件"})
		return
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 5<<20+1))
	if err != nil || len(raw) > 5<<20 {
		writeJSONStatus(w, http.StatusRequestEntityTooLarge, map[string]any{"success": false, "message": "文件超过 5MB 上限"})
		return
	}
	var document map[string]any
	if json.Unmarshal(raw, &document) != nil {
		writeJSON(w, map[string]any{"success": false, "message": "文件不是合法的 JSON"})
		return
	}
	quiz := document
	if nested, ok := document["quiz"].(map[string]any); ok {
		quiz = nested
	}
	questions := anySlice(quiz["questions"])
	if len(questions) == 0 {
		writeJSON(w, map[string]any{"success": false, "message": "题库里没有题目（需包含 questions 数组）"})
		return
	}
	if err := validateQuizHubContent(quiz); err != nil {
		writeJSON(w, map[string]any{"success": false, "message": "题库校验不通过：" + err.Error()})
		return
	}
	if _, ok := quiz["settings"].(map[string]any); !ok {
		quiz["settings"] = map[string]any{}
	}
	clean := recognitionStripAnswers(quiz)
	counts := map[string]int{}
	for _, question := range anySlice(clean["questions"]) {
		if row, ok := question.(map[string]any); ok {
			counts[stringValue(row["type"])]++
		}
	}
	title := strings.TrimSpace(r.FormValue("title"))
	if title == "" {
		title = "未命名题库"
	}
	title = truncateString(title, 60)
	description := truncateString(strings.TrimSpace(r.FormValue("description")), 200)
	username, nickname := s.submissionUserNames(r, *userID)
	if nickname == "" {
		nickname = username
	}
	token := randomHex(16)
	encodedTypes, _ := json.Marshal(counts)
	encodedContent, _ := json.Marshal(map[string]any{"questions": clean["questions"], "settings": clean["settings"]})
	result, err := s.db.ExecContext(r.Context(), "INSERT INTO quiz_shares(title,description,uploader_id,uploader_name,question_count,type_counts,content,upload_token) VALUES(?,?,?,?,?,?,?,?)", title, description, *userID, truncateString(nickname, 100), len(questions), string(encodedTypes), string(encodedContent), token)
	if err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "保存失败，请重试"})
		return
	}
	id, _ := result.LastInsertId()
	writeJSON(w, map[string]any{"success": true, "id": id, "message": "已上传，答案已剥离"})
}

func (s *Server) quizHubSharedDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]any{"success": false, "message": "仅支持 POST"})
		return
	}
	userID, role := s.optionalSessionUser(r)
	if userID == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	input := voteReadJSON(r)
	id := integerValue(input["id"])
	var uploader int64
	if s.db.QueryRowContext(r.Context(), "SELECT uploader_id FROM quiz_shares WHERE id=?", id).Scan(&uploader) != nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "题库不存在"})
		return
	}
	if uploader != *userID && role != "super_admin" {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "只能删除自己上传的题库"})
		return
	}
	_, _ = s.db.ExecContext(r.Context(), "DELETE FROM quiz_shares WHERE id=?", id)
	writeJSON(w, map[string]any{"success": true})
}

func (s *Server) quizHubLocal(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), "SELECT id,club_id,country,title,COALESCE(intro,'') FROM recognition_programs WHERE type='assessment' AND status='published' ORDER BY id DESC LIMIT 100")
	if err != nil {
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "读取考核失败"})
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, clubID int64
		var country, title, intro string
		if rows.Scan(&id, &clubID, &country, &title, &intro) != nil {
			continue
		}
		version, _ := s.recognitionVersion(r.Context(), id, false)
		if version == nil {
			continue
		}
		content, _ := version["content"].(map[string]any)
		quiz, _ := content["quiz"].(map[string]any)
		questions := anySlice(quiz["questions"])
		if len(questions) == 0 {
			continue
		}
		counts := map[string]int{}
		for _, question := range questions {
			if row, ok := question.(map[string]any); ok {
				counts[stringValue(row["type"])]++
			}
		}
		items = append(items, map[string]any{"id": id, "title": title, "intro": intro, "club_name": s.recognitionClubName(r.Context(), clubID, country), "question_count": len(questions), "type_counts": counts, "time_limit": integerValue(mustMapValue(quiz, "settings", map[string]any{})["time_limit"])})
	}
	writeJSON(w, map[string]any{"success": true, "items": items})
}

func (s *Server) quizHubLocalQuiz(w http.ResponseWriter, r *http.Request) {
	id := queryInt(r, "id")
	version, _ := s.recognitionVersion(r.Context(), id, false)
	if version == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "题库不存在"})
		return
	}
	program, _ := s.recognitionProgram(r.Context(), id)
	if program == nil {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"success": false, "message": "题库不存在"})
		return
	}
	content, _ := version["content"].(map[string]any)
	quiz, _ := content["quiz"].(map[string]any)
	writeJSON(w, map[string]any{"success": true, "title": program.Title, "quiz": map[string]any{"questions": recognitionStripAnswers(map[string]any{"questions": quiz["questions"]})["questions"], "settings": quiz["settings"]}})
}

func (s *Server) quizHubGallery(w http.ResponseWriter, r *http.Request) {
	query := url.Values{}
	for _, key := range []string{"q", "type", "sort", "limit", "offset"} {
		if value := r.URL.Query().Get(key); value != "" {
			query.Set(key, value)
		}
	}
	data, status, err := s.quizHubFetch(r, "/api/gallery?"+query.Encode())
	if err != nil {
		writeJSONStatus(w, http.StatusBadGateway, map[string]any{"success": false, "message": "连不上题库市集服务（makoquiz）"})
		return
	}
	if status < 200 || status >= 300 {
		writeJSONStatus(w, http.StatusBadGateway, map[string]any{"success": false, "message": "市集返回了无法解析的数据"})
		return
	}
	var value map[string]any
	if json.Unmarshal(data, &value) != nil {
		writeJSONStatus(w, http.StatusBadGateway, map[string]any{"success": false, "message": "市集返回了无法解析的数据"})
		return
	}
	value["success"], value["base_url"] = true, strings.TrimRight(s.cfg.MakoQuizURL, "/")
	writeJSON(w, value)
}

func (s *Server) quizHubCover(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if !regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(id) {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "参数非法"})
		return
	}
	data, status, err := s.quizHubFetch(r, "/api/gallery/"+url.PathEscape(id)+"/cover")
	if err != nil || status < 200 || status >= 300 {
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "image/*")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(data)
}

func (s *Server) quizHubImport(w http.ResponseWriter, r *http.Request) {
	userID, _ := s.optionalSessionUser(r)
	if userID == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if !regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(id) {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": "参数非法"})
		return
	}
	data, status, err := s.quizHubFetch(r, "/api/gallery/"+url.PathEscape(id)+"/download")
	if err != nil || status < 200 || status >= 300 {
		writeJSONStatus(w, http.StatusBadGateway, map[string]any{"success": false, "message": "连不上题库市集服务（makoquiz）"})
		return
	}
	if len(data) > 50<<20 || len(data) < 2 || string(data[:2]) != "PK" {
		writeJSONStatus(w, http.StatusBadGateway, map[string]any{"success": false, "message": "市集返回的不是有效的题库包"})
		return
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		writeJSONStatus(w, http.StatusBadGateway, map[string]any{"success": false, "message": "题库包损坏，无法解压"})
		return
	}
	var presentation map[string]any
	for _, file := range reader.File {
		if strings.EqualFold(path.Base(file.Name), "presentation.json") {
			handle, openErr := file.Open()
			if openErr == nil {
				content, readErr := io.ReadAll(io.LimitReader(handle, 10<<20))
				_ = handle.Close()
				if readErr == nil {
					_ = json.Unmarshal(content, &presentation)
				}
			}
			break
		}
	}
	if presentation == nil {
		writeJSONStatus(w, http.StatusBadGateway, map[string]any{"success": false, "message": "题库包里找不到 presentation.json"})
		return
	}
	quiz := quizFromPresentation(presentation)
	if len(anySlice(quiz["questions"])) == 0 {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{"success": false, "message": "没有可转译的题目", "notes": []string{"这份题库没有可转译的题目"}})
		return
	}
	writeJSON(w, map[string]any{"success": true, "source_title": stringValue(presentation["title"]), "quiz": quiz, "converted_count": len(anySlice(quiz["questions"])), "notes": []string{}})
}

func (s *Server) quizHubFetch(r *http.Request, endpoint string) ([]byte, int, error) {
	base := strings.TrimRight(s.cfg.MakoQuizURL, "/")
	requestCtx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, base+endpoint, nil)
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("User-Agent", "VNFmap-QuizHub/1.0")
	response, err := (&http.Client{Timeout: 15 * time.Second}).Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 50<<20+1))
	if err == nil && len(data) > 50<<20 {
		return nil, response.StatusCode, fmt.Errorf("makoquiz response too large")
	}
	return data, response.StatusCode, err
}

func validateQuizHubContent(quiz map[string]any) error {
	questions := anySlice(quiz["questions"])
	if len(questions) > 500 {
		return fmt.Errorf("题目数量非法（最多 500 题）")
	}
	for index, value := range questions {
		question, ok := value.(map[string]any)
		if !ok {
			return fmt.Errorf("第 %d 题结构非法", index+1)
		}
		typ := stringValue(question["type"])
		if !containsString([]string{"single", "multiple", "judge", "fill_blank", "order", "fill_multi"}, typ) {
			return fmt.Errorf("第 %d 题型不支持", index+1)
		}
		if strings.TrimSpace(stringValue(question["question"])) == "" {
			return fmt.Errorf("第 %d 题干为空", index+1)
		}
		points := integerValue(question["points"])
		if points == 0 {
			points = 10
		}
		if points < 1 || points > 100 {
			return fmt.Errorf("第 %d 分值需在 1–100 之间", index+1)
		}
		if containsString([]string{"single", "multiple", "judge", "order"}, typ) {
			options := anySlice(question["options"])
			if len(options) < 2 {
				return fmt.Errorf("第 %d 选项不足", index+1)
			}
			if typ == "order" && len(options) > 20 {
				return fmt.Errorf("第 %d 排序题选项不能超过 20 个", index+1)
			}
			if typ != "order" && len(anySlice(question["answer"])) == 0 {
				return fmt.Errorf("第 %d 未设置答案", index+1)
			}
		} else if typ == "fill_multi" {
			answers := anySlice(question["answer_texts"])
			if len(answers) < 1 || len(answers) > 10 {
				return fmt.Errorf("第 %d 多空填空需 1–10 个空", index+1)
			}
		} else if strings.TrimSpace(stringValue(question["answer_text"])) == "" {
			return fmt.Errorf("第 %d 填空题未设置答案", index+1)
		}
	}
	return nil
}

func quizFromPresentation(document map[string]any) map[string]any {
	if questions, ok := document["questions"].([]any); ok {
		return map[string]any{"questions": questions, "settings": mustMapValue(document, "settings", map[string]any{})}
	}
	if content, ok := document["quiz"].(map[string]any); ok {
		return map[string]any{"questions": anySlice(content["questions"]), "settings": mustMapValue(content, "settings", map[string]any{})}
	}
	return map[string]any{"questions": []any{}, "settings": map[string]any{}}
}

func mustMapValue(input map[string]any, key string, fallback map[string]any) map[string]any {
	if value, ok := input[key].(map[string]any); ok {
		return value
	}
	return fallback
}
