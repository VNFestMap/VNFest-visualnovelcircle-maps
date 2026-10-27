package httpapi

import (
	"crypto/rand"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

const jointLetterFile = "joint_letter_submissions.json"

var jointLetterDeadline = time.Date(2026, 10, 21, 12, 0, 0, 0, time.FixedZone("Asia/Shanghai", 8*60*60))

type jointLetterInput struct {
	RequestID    string                  `json:"request_id"`
	Kind         string                  `json:"kind"`
	Location     string                  `json:"location"`
	Content      string                  `json:"content"`
	ClubName     string                  `json:"club_name"`
	Signature    string                  `json:"signature"`
	Message      string                  `json:"message"`
	PersonalInfo string                  `json:"personal_info,omitempty"`
	Selection    *jointLetterSelection   `json:"selection,omitempty"`
	Suggestions  []jointLetterSuggestion `json:"suggestions,omitempty"`
}

type jointLetterSuggestion struct {
	Location  string                `json:"location"`
	Content   string                `json:"content"`
	Selection *jointLetterSelection `json:"selection,omitempty"`
}

// Offsets use UTF-16 code units, matching DOM Range and JavaScript string slicing.
type jointLetterSelection struct {
	StartParagraph int    `json:"start_paragraph"`
	StartOffset    int    `json:"start_offset"`
	EndParagraph   int    `json:"end_paragraph"`
	EndOffset      int    `json:"end_offset"`
	Quote          string `json:"quote"`
}

type jointLetterRecord struct {
	jointLetterInput
	ID          string `json:"id"`
	SubmittedAt string `json:"submitted_at"`
	UserID      *int64 `json:"user_id,omitempty"`
}

// Separate from the feedback limiter, with bounded lifetime and memory.
var jointLetterRate = struct {
	sync.Mutex
	buckets map[string]struct {
		Start time.Time
		Count int
	}
}{buckets: make(map[string]struct {
	Start time.Time
	Count int
})}

func jointLetterAllow(ip string, now time.Time) bool {
	jointLetterRate.Lock()
	defer jointLetterRate.Unlock()
	for key, bucket := range jointLetterRate.buckets {
		if now.Sub(bucket.Start) >= time.Minute {
			delete(jointLetterRate.buckets, key)
		}
	}
	b := jointLetterRate.buckets[ip]
	if b.Start.IsZero() {
		b.Start = now
	}
	if b.Count >= 10 || (b.Count == 0 && len(jointLetterRate.buckets) >= 10000) {
		return false
	}
	b.Count++
	jointLetterRate.buckets[ip] = b
	return true
}

func (s *Server) jointLetterAdminPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if _, ok := s.adminUserID(r); !ok {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>联合致信管理</title><p>请先使用超级管理员账号登录，再返回此页。</p><a href="/login.html">前往登录</a></html>`)
		return
	}
	s.static(w, r)
}

func (s *Server) jointLetter(w http.ResponseWriter, r *http.Request) {
	s.jointLetterAt(w, r, time.Now())
}

// Explicit time parameter makes deadline boundaries testable without changing the system clock.
func (s *Server) jointLetterAt(w http.ResponseWriter, r *http.Request, now time.Time) {
	fail := func(code int, message string) {
		writeJSONStatus(w, code, map[string]any{"success": false, "message": message})
	}
	action := r.URL.Query().Get("action")
	if r.Method == http.MethodGet && action == "profile" {
		s.jointLetterProfile(w, r)
		return
	}
	if r.Method == http.MethodGet && action == "status" {
		writeJSON(w, map[string]any{"success": true, "server_time": now.Format(time.RFC3339Nano), "deadline": jointLetterDeadline.Format(time.RFC3339), "open": now.Before(jointLetterDeadline)})
		return
	}
	admin := action == "list" || action == "export"
	if admin {
		if _, ok := s.adminUserID(r); !ok {
			s.adminDenied(w, r)
			return
		}
		if r.Method != http.MethodGet {
			methodNotAllowed(w, "GET")
			return
		}
	} else if action != "submit" || r.Method != http.MethodPost {
		fail(http.StatusBadRequest, "无效的收集请求")
		return
	}
	if s.files == nil {
		fail(503, "收集服务暂不可用，请稍后重试")
		return
	}
	var input jointLetterInput
	if !admin {
		if !jointLetterAllow(clientIP(r), now) {
			w.Header().Set("Retry-After", "60")
			fail(429, "提交过于频繁，请一分钟后重试")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		d := json.NewDecoder(r.Body)
		d.DisallowUnknownFields()
		if err := d.Decode(&input); err != nil {
			fail(400, "提交数据无效或过长")
			return
		}
		var extra any
		if d.Decode(&extra) != io.EOF {
			fail(400, "提交数据无效")
			return
		}
		if len(input.RequestID) != 36 || strings.Count(input.RequestID, "-") != 4 {
			fail(400, "提交编号无效，请刷新页面后重试")
			return
		}
		if _, err := hex.DecodeString(strings.ReplaceAll(input.RequestID, "-", "")); err != nil {
			fail(400, "提交编号无效")
			return
		}
		for _, field := range []*string{&input.Location, &input.Content, &input.ClubName, &input.Signature, &input.Message, &input.PersonalInfo} {
			*field = strings.TrimFunc(*field, func(c rune) bool { return unicode.IsSpace(c) || c == '\ufeff' })
		}
		valid := func(value string, max int, required bool) bool {
			if !utf8.ValidString(value) || (required && value == "") || (max > 0 && utf8.RuneCountInString(value) > max) {
				return false
			}
			for _, c := range value {
				if unicode.IsControl(c) && c != '\n' && c != '\r' && c != '\t' {
					return false
				}
			}
			return true
		}
		switch input.Kind {
		case "A":
			if !valid(input.ClubName, 120, true) || input.Signature != "" || input.Message != "" || input.PersonalInfo != "" {
				fail(400, "请填写位置、修改内容（各不超过3000字）及同好会名（不超过120字）")
				return
			}
			if input.Suggestions != nil {
				if len(input.Suggestions) == 0 || len(input.Suggestions) > 20 || input.Location != "" || input.Content != "" || input.Selection != nil {
					fail(400, "每次可提交1至20条修改建议，请使用一致的填写格式")
					return
				}
				for i := range input.Suggestions {
					item := &input.Suggestions[i]
					item.Location = strings.TrimFunc(item.Location, func(c rune) bool { return unicode.IsSpace(c) || c == '\ufeff' })
					item.Content = strings.TrimFunc(item.Content, func(c rune) bool { return unicode.IsSpace(c) || c == '\ufeff' })
					if !valid(item.Location, 3000, true) || !valid(item.Content, 3000, true) || (item.Selection != nil && !s.jointLetterSelectionValid(item.Selection)) {
						fail(400, "请完整填写每条建议的位置、修改内容（各不超过3000字），并检查原文标记")
						return
					}
				}
			} else if !valid(input.Location, 3000, true) || !valid(input.Content, 3000, true) {
				fail(400, "请填写位置和修改内容（各不超过3000字）")
				return
			}
		case "B":
			if !valid(input.Signature, 120, true) || !valid(input.Message, 0, false) || !valid(input.ClubName, 120, false) || !valid(input.PersonalInfo, 120, false) || input.Location != "" || input.Content != "" || input.Selection != nil || input.Suggestions != nil {
				fail(400, "请填写有效署名（不超过120字）、同好会及个人信息（各不超过120字），并检查留言格式")
				return
			}
		default:
			fail(400, "请选择收集表A或B")
			return
		}
		if input.Selection != nil && !s.jointLetterSelectionValid(input.Selection) {
			fail(400, "原文选区已失效，请重新选中原文或取消标记后手动填写位置")
			return
		}
	}
	// Lock the entire read/append/write transaction, including reads for export.
	s.jsonMu.Lock()
	defer s.jsonMu.Unlock()
	rows := []jointLetterRecord{}
	if err := s.files.ReadJSON(r.Context(), jointLetterFile, &rows); err != nil && !errors.Is(err, os.ErrNotExist) {
		fail(500, "读取收集记录失败，请稍后重试")
		return
	}
	if admin {
		kind := r.URL.Query().Get("kind")
		if kind != "A" && kind != "B" {
			fail(400, "请选择收集表A或B")
			return
		}
		filtered := []jointLetterRecord{}
		for _, row := range rows {
			if row.Kind == kind {
				row.RequestID = ""
				filtered = append(filtered, row)
			}
		}
		if action == "export" {
			jointLetterCSV(w, kind, filtered)
			return
		}
		writeJSON(w, map[string]any{"success": true, "rows": filtered, "count": len(filtered)})
		return
	}
	for _, row := range rows {
		if row.RequestID == input.RequestID {
			if !reflect.DeepEqual(row.jointLetterInput, input) {
				fail(409, "该提交编号已用于其他内容，请重新提交")
				return
			}
			writeJSON(w, map[string]any{"success": true, "id": row.ID, "message": "此条内容已收录"})
			return
		}
	}
	// A retry of a saved request can retrieve its receipt after closing; new records cannot.
	if !now.Before(jointLetterDeadline) {
		fail(410, "收集已截止，感谢参与")
		return
	}
	var nonce [12]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		fail(500, "生成回执失败，请稍后重试")
		return
	}
	userID, role := s.optionalSessionUser(r)
	if role == "" {
		userID = nil
	}
	row := jointLetterRecord{jointLetterInput: input, ID: input.Kind + "-" + hex.EncodeToString(nonce[:]), SubmittedAt: now.In(jointLetterDeadline.Location()).Format(time.RFC3339Nano), UserID: userID}
	rows = append(rows, row)
	if err := s.files.WriteJSONAtomic(r.Context(), jointLetterFile, rows); err != nil {
		fail(500, "保存失败，请保留填写内容并重试")
		return
	}
	writeJSON(w, map[string]any{"success": true, "id": row.ID, "message": "提交成功"})
}

func jointLetterCSV(w http.ResponseWriter, kind string, rows []jointLetterRecord) {
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="joint-letter-`+kind+`.csv"`)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, "\ufeff")
	cw := csv.NewWriter(w)
	cw.UseCRLF = true
	header := []string{"回执编号", "提交时间", "原句或添加位置", "修改或增添内容", "同好会名", "选中原文", "选区定位", "关联账号ID", "建议序号", "本次建议总数"}
	if kind == "B" {
		header = []string{"回执编号", "提交时间", "希望使用的署名", "留言", "同好会名", "个人称呼或身份", "关联账号ID"}
	}
	_ = cw.Write(header)
	for _, row := range rows {
		items := row.Suggestions
		if len(items) == 0 {
			items = []jointLetterSuggestion{{Location: row.Location, Content: row.Content, Selection: row.Selection}}
		}
		for index, item := range items {
			quote, anchor, userID := "", "", ""
			if item.Selection != nil {
				quote = item.Selection.Quote
				encoded, _ := json.Marshal(item.Selection)
				anchor = string(encoded)
			}
			if row.UserID != nil {
				userID = strconvInt(*row.UserID)
			}
			cells := []string{row.ID, row.SubmittedAt, item.Location, item.Content, row.ClubName, quote, anchor, userID, strconvInt(int64(index + 1)), strconvInt(int64(len(items)))}
			if kind == "B" {
				cells = []string{row.ID, row.SubmittedAt, row.Signature, row.Message, row.ClubName, row.PersonalInfo, userID}
			}
			for i, cell := range cells {
				trimmed := strings.TrimLeftFunc(cell, unicode.IsSpace)
				if strings.HasPrefix(trimmed, "=") || strings.HasPrefix(trimmed, "+") || strings.HasPrefix(trimmed, "-") || strings.HasPrefix(trimmed, "@") {
					cells[i] = "'" + cell
				}
			}
			_ = cw.Write(cells)
		}
	}
	cw.Flush()
}

func (s *Server) jointLetterProfile(w http.ResponseWriter, r *http.Request) {
	id, role := s.optionalSessionUser(r)
	if id == nil || role == "" {
		writeJSON(w, map[string]any{"success": true, "logged_in": false, "user": nil, "clubs": []any{}})
		return
	}
	u, err := s.findUser(r.Context(), *id)
	if err != nil || u == nil {
		writeJSONStatus(w, 503, map[string]any{"success": false, "message": "暂时无法检测账号，可继续手动填写"})
		return
	}
	clubs := []map[string]any{}
	for _, membership := range s.memberships(r.Context(), *id) {
		if stringValue(membership["role"]) == "external" {
			continue
		}
		clubID := integerValue(membership["club_id"])
		country := normalizeCountry(stringValue(membership["country"]))
		name := s.clubCodeClubName(r.Context(), clubID, country)
		if name == "同好会#"+strconvInt(clubID) {
			continue
		}
		preferred := u.DisplayMembershipID != nil && *u.DisplayMembershipID == integerValue(membership["id"])
		clubs = append(clubs, map[string]any{"id": clubID, "country": country, "name": name, "preferred": preferred})
	}
	writeJSON(w, map[string]any{"success": true, "logged_in": true, "user": map[string]any{"id": u.ID, "nickname": firstNonEmpty(u.Nickname, u.Username)}, "clubs": clubs})
}

func (s *Server) jointLetterSelectionValid(selection *jointLetterSelection) bool {
	if selection.StartParagraph < 1 || selection.EndParagraph < selection.StartParagraph || selection.StartOffset < 0 || selection.EndOffset < 0 || selection.Quote == "" || utf8.RuneCountInString(selection.Quote) > 3000 {
		return false
	}
	raw, err := os.ReadFile(filepath.Join(s.cfg.Root, "joint-letter", "draft-reference.json"))
	if err != nil {
		return false
	}
	var paragraphs []string
	if json.Unmarshal(raw, &paragraphs) != nil || selection.EndParagraph > len(paragraphs) {
		return false
	}
	parts := []string{}
	for i := selection.StartParagraph; i <= selection.EndParagraph; i++ {
		units := utf16.Encode([]rune(paragraphs[i-1]))
		start, end := 0, len(units)
		if i == selection.StartParagraph {
			start = selection.StartOffset
		}
		if i == selection.EndParagraph {
			end = selection.EndOffset
		}
		if start > end || end > len(units) || start > len(units) {
			return false
		}
		parts = append(parts, string(utf16.Decode(units[start:end])))
	}
	return strings.Join(parts, "\n\n") == selection.Quote
}
