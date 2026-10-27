package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type insightRecord struct {
	kind, title, status, country string
	id                           int64
	submitted, reviewed          time.Time
}

var insightTypes = []string{"club", "event", "publication", "membership", "feedback"}
var insightLabels = map[string]string{"club": "同好会申请", "event": "活动申请", "publication": "企划申请", "membership": "成员绑定", "feedback": "反馈建议"}

func (s *Server) insightRows(ctx context.Context, name, key string, sources map[string]any) []any {
	var document any
	err := fmt.Errorf("file store unavailable")
	if s.files != nil {
		err = s.files.ReadJSON(ctx, name, &document)
	}
	if err != nil {
		status := "unavailable"
		if errors.Is(err, os.ErrNotExist) {
			status = "missing"
		}
		sources[name] = map[string]any{"status": status}
		return nil
	}
	if key != "" {
		if obj, ok := document.(map[string]any); ok {
			document = obj[key]
		} else {
			document = nil
		}
	}
	rows, ok := document.([]any)
	if !ok {
		sources[name] = map[string]any{"status": "invalid_shape"}
		return nil
	}
	sources[name] = map[string]any{"status": "ok", "count": len(rows)}
	return rows
}

func cloneMap(row map[string]any) map[string]any {
	result := make(map[string]any, len(row))
	for key, value := range row {
		result[key] = value
	}
	return result
}

func insightTime(value any) time.Time {
	if v, ok := value.(time.Time); ok {
		// SQL DATETIME has no offset. Match PHP's Shanghai interpretation of
		// its wall-clock fields, independently of the driver's loc setting.
		v, _ = time.ParseInLocation("2006-01-02 15:04:05", v.Format("2006-01-02 15:04:05"), analyticsLocation)
		return v
	}
	text := strings.TrimSpace(stringValue(databaseValueString(value)))
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05", "2006-01-02T15:04:05", "2006-01-02"} {
		if v, err := time.ParseInLocation(layout, text, analyticsLocation); err == nil {
			return v.In(analyticsLocation)
		}
	}
	return time.Time{}
}
func insightDate(v time.Time) string {
	if v.IsZero() {
		return ""
	}
	return v.In(analyticsLocation).Format("2006-01-02")
}
func insightSerializedTime(v time.Time) any {
	if v.IsZero() {
		return nil
	}
	return v.In(analyticsLocation).Format(time.RFC3339)
}
func insightAge(start, end time.Time) float64 {
	return math.Max(0, math.Round(end.Sub(start).Hours()*100)/100)
}
func insightPercentile(values []float64, p float64) any {
	if len(values) == 0 {
		return nil
	}
	sort.Float64s(values)
	index := p / 100 * float64(len(values)-1)
	lo, hi := int(math.Floor(index)), int(math.Ceil(index))
	return math.Round((values[lo]+(values[hi]-values[lo])*(index-float64(lo)))*100) / 100
}
func insightCountry(raw string) string {
	if strings.ToLower(strings.TrimSpace(raw)) == "japan" {
		return "japan"
	}
	return "china"
}
func insightQueryEscape(value string) string {
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}
func insightRange(r *http.Request) (time.Time, time.Time) {
	end := insightTime(r.URL.Query().Get("to"))
	if end.IsZero() {
		end = analyticsLocalDate(time.Now())
	}
	start := insightTime(r.URL.Query().Get("from"))
	if start.IsZero() {
		start = end.AddDate(0, 0, -29)
	}
	if start.After(end) {
		start, end = end, start
	}
	if start.Before(end.AddDate(0, 0, -365)) {
		start = end.AddDate(0, 0, -365)
	}
	return start, end
}
func (s *Server) insightRecords(ctx context.Context, sources map[string]any) ([]insightRecord, []map[string]any) {
	records := []insightRecord{}
	for _, spec := range []struct{ kind, file, title string }{{"club", "submissions.json", "name"}, {"event", "submissions_event.json", "event"}, {"publication", "submissions_publication.json", "publicationName"}, {"feedback", "feedback.json", "title"}} {
		rows := s.insightRows(ctx, spec.file, "", sources)
		for _, value := range rows {
			row, ok := value.(map[string]any)
			if !ok {
				continue
			}
			status := firstNonEmpty(strings.TrimSpace(stringValue(row["status"])), "pending")
			reviewed := row["reviewed_at"]
			if stringValue(reviewed) == "" {
				if status == "approved" {
					reviewed = row["approved_at"]
				}
				if status == "rejected" {
					reviewed = row["rejected_at"]
				}
				if spec.kind == "feedback" && status != "pending" {
					reviewed = row["updated_at"]
				}
			}
			records = append(records, insightRecord{kind: spec.kind, id: integerValue(row["id"]), title: firstNonEmpty(strings.TrimSpace(stringValue(row[spec.title])), "未命名记录"), status: status, country: insightCountry(stringValue(row["country"])), submitted: insightTime(firstNonEmpty(stringValue(row["submitted_at"]), stringValue(row["timestamp"]))), reviewed: insightTime(reviewed)})
		}
	}
	memberships := []map[string]any{}
	if s.db == nil {
		sources["club_memberships"] = map[string]any{"status": "unavailable"}
		return records, memberships
	}
	rows, err := s.db.QueryContext(ctx, "SELECT id,club_id,country,role,status,joined_at,reviewed_at,reviewed_by FROM club_memberships ORDER BY id")
	fallback := false
	if err != nil {
		fallback = true
		rows, err = s.db.QueryContext(ctx, "SELECT id,club_id,country,role,status,joined_at FROM club_memberships ORDER BY id")
	}
	if err != nil {
		sources["club_memberships"] = map[string]any{"status": "unavailable"}
		return records, memberships
	}
	defer rows.Close()
	for rows.Next() {
		var id, clubID int64
		var country, role, status, joined, reviewed, by any
		if fallback {
			err = rows.Scan(&id, &clubID, &country, &role, &status, &joined)
		} else {
			err = rows.Scan(&id, &clubID, &country, &role, &status, &joined, &reviewed, &by)
		}
		if err != nil {
			break
		}
		records = append(records, insightRecord{kind: "membership", id: id, title: "未命名记录", status: stringValue(databaseValueString(status)), country: insightCountry(stringValue(databaseValueString(country))), submitted: insightTime(joined), reviewed: insightTime(reviewed)})
		memberships = append(memberships, map[string]any{"id": id, "club_id": clubID, "country": insightCountry(stringValue(databaseValueString(country))), "role": databaseValueString(role), "status": databaseValueString(status), "joined_at": joined})
	}
	if err != nil || rows.Err() != nil {
		sources["club_memberships"] = map[string]any{"status": "unavailable"}
		return records[:len(records)-len(memberships)], []map[string]any{}
	}
	sources["club_memberships"] = map[string]any{"status": "ok", "count": len(memberships), "review_timestamps_available": !fallback}
	return records, memberships
}

func insightQueueReview(records []insightRecord, start, end, now time.Time) (map[string]any, map[string]any, map[string]any, []map[string]any) {
	byType := map[string]map[string]any{}
	durations := []float64{}
	durationByType := map[string][]float64{}
	for _, kind := range insightTypes {
		byType[kind] = map[string]any{"type": kind, "pending": 0, "overdue_24h": 0, "overdue_72h": 0, "oldest_wait_hours": nil, "incoming": 0, "processed": 0}
		durationByType[kind] = []float64{}
	}
	trend := []map[string]any{}
	trendByDate := map[string]map[string]any{}
	for day := start; !day.After(end); day = day.AddDate(0, 0, 1) {
		key := insightDate(day)
		row := map[string]any{"date": key, "incoming": 0, "processed": 0, "backlog": 0}
		trend = append(trend, row)
		trendByDate[key] = row
	}
	inc := func(row map[string]any, key string) { row[key] = integerValue(row[key]) + 1 }
	priority := []map[string]any{}
	var processed, approved, rejected int64
	oldest := float64(0)
	oldestKnown := false
	for _, record := range records {
		row, ok := byType[record.kind]
		if !ok {
			continue
		}
		if record.status == "pending" {
			inc(row, "pending")
			if !record.submitted.IsZero() {
				oldestKnown = true
				age := insightAge(record.submitted, now)
				if age >= 24 {
					inc(row, "overdue_24h")
				}
				if age >= 72 {
					inc(row, "overdue_72h")
				}
				if row["oldest_wait_hours"] == nil || age > numberFloat(row["oldest_wait_hours"]) {
					row["oldest_wait_hours"] = age
				}
				if age > oldest {
					oldest = age
				}
				severity, message := "info", "待处理 尚未处理"
				if age >= 24 {
					severity = "warning"
				}
				if age >= 72 {
					severity = "urgent"
					message = "待处理 超过 72 小时"
				}
				priority = append(priority, map[string]any{"severity": severity, "type": "queue", "issue_code": "pending_" + record.kind, "type_label": insightLabels[record.kind], "title": record.title, "message": message, "age_hours": age, "record_id": record.id, "country": record.country, "action_url": fmt.Sprintf("reviews.html?module=review&tab=%s&status=pending&id=%d", record.kind, record.id)})
			}
		}
		if tr, ok := trendByDate[insightDate(record.submitted)]; ok {
			inc(tr, "incoming")
			inc(row, "incoming")
		}
		if record.status == "approved" || record.status == "rejected" {
			if tr, ok := trendByDate[insightDate(record.reviewed)]; ok {
				processed++
				inc(row, "processed")
				inc(tr, "processed")
				if record.status == "approved" {
					approved++
					inc(row, "approved")
				} else {
					rejected++
					inc(row, "rejected")
				}
				if !record.submitted.IsZero() && !record.reviewed.Before(record.submitted) {
					age := insightAge(record.submitted, record.reviewed)
					durations = append(durations, age)
					durationByType[record.kind] = append(durationByType[record.kind], age)
				}
			}
		}
		if !record.submitted.IsZero() {
			for _, tr := range trend {
				key := stringValue(tr["date"])
				if insightDate(record.submitted) <= key && (record.status == "pending" || record.reviewed.IsZero() || insightDate(record.reviewed) > key) {
					inc(tr, "backlog")
				}
			}
		}
	}
	var pending, overdue24, overdue72 int64
	typeRows := []map[string]any{}
	for _, kind := range insightTypes {
		row := byType[kind]
		pending += integerValue(row["pending"])
		overdue24 += integerValue(row["overdue_24h"])
		overdue72 += integerValue(row["overdue_72h"])
		terminal := integerValue(row["approved"]) + integerValue(row["rejected"])
		row["terminal_records"] = terminal
		row["pass_rate_pct"] = insightRate(integerValue(row["approved"]), terminal)
		row["median_hours"] = insightPercentile(durationByType[kind], 50)
		row["p90_hours"] = insightPercentile(durationByType[kind], 90)
		typeRows = append(typeRows, row)
	}
	var oldestValue any
	if pending > 0 && oldestKnown {
		oldestValue = oldest
	}
	queue := map[string]any{"pending": pending, "overdue_24h": overdue24, "overdue_72h": overdue72, "oldest_wait_hours": oldestValue, "by_type": typeRows}
	review := map[string]any{"processed": processed, "approved": approved, "rejected": rejected, "terminal_records": processed, "pass_rate_pct": insightRate(approved, processed), "median_hours": insightPercentile(durations, 50), "p90_hours": insightPercentile(durations, 90), "trend": trend, "by_type": typeRows}
	coverage := map[string]any{"reliable": len(durations), "terminal_records": processed, "percentage": insightRate(int64(len(durations)), processed)}
	return queue, review, coverage, priority
}
func insightRate(a, b int64) any {
	if b == 0 {
		return nil
	}
	return math.Round(float64(a)/float64(b)*1000) / 10
}
func numberFloat(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case int64:
		return float64(v)
	}
	return 0
}

func insightSort(issues []map[string]any) {
	ranks := map[string]int{"urgent": 0, "warning": 1, "info": 2}
	types := map[string]int{"queue": 0, "governance": 1, "public_quality": 2}
	sort.SliceStable(issues, func(i, j int) bool {
		a, b := issues[i], issues[j]
		if ranks[stringValue(a["severity"])] != ranks[stringValue(b["severity"])] {
			return ranks[stringValue(a["severity"])] < ranks[stringValue(b["severity"])]
		}
		at, bt := stringValue(a["type"]), stringValue(b["type"])
		if at == "queue" && bt == "queue" {
			if numberFloat(a["age_hours"]) != numberFloat(b["age_hours"]) {
				return numberFloat(a["age_hours"]) > numberFloat(b["age_hours"])
			}
		} else if at != "queue" && bt != "queue" {
			if numberFloat(a["score"]) != numberFloat(b["score"]) {
				return numberFloat(a["score"]) < numberFloat(b["score"])
			}
		} else if at != bt {
			return types[at] < types[bt]
		}
		for _, key := range []string{"title", "issue_code", "country"} {
			if stringValue(a[key]) != stringValue(b[key]) {
				return stringValue(a[key]) < stringValue(b[key])
			}
		}
		return integerValue(a["record_id"]) < integerValue(b["record_id"])
	})
}

func insightBuckets(scores []float64) []map[string]any {
	counts := []int{0, 0, 0, 0}
	for _, score := range scores {
		index := 3
		if score >= 90 {
			index = 0
		} else if score >= 70 {
			index = 1
		} else if score >= 50 {
			index = 2
		}
		counts[index]++
	}
	result := []map[string]any{}
	for i, label := range []string{"90-100", "70-89", "50-69", "0-49"} {
		result = append(result, map[string]any{"label": label, "count": counts[i]})
	}
	return result
}
func insightAverage(scores []float64) any {
	if len(scores) == 0 {
		return nil
	}
	sum := 0.0
	for _, v := range scores {
		sum += v
	}
	return math.Round(sum/float64(len(scores))*10) / 10
}
func insightCounts(counts map[string]int, key string) []map[string]any {
	keys := []string{}
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	result := []map[string]any{}
	for _, k := range keys {
		result = append(result, map[string]any{key: k, "count": counts[k]})
	}
	return result
}

// Match the public PHP growth rules, including case-insensitive textual links.
// Read association documents once per request rather than once per club.
func insightAssociated(club map[string]any, rows []any, publication bool) bool {
	country, id := stringValue(club["country"]), integerValue(club["id"])
	name := firstNonEmpty(stringValue(club["display_name"]), firstNonEmpty(stringValue(club["name"]), stringValue(club["school"])))
	short := strings.TrimSpace(stringValue(club["name"]))
	contains := func(text, part string) bool { return strings.Contains(strings.ToLower(text), strings.ToLower(part)) }
	for _, value := range rows {
		row, ok := value.(map[string]any)
		if !ok {
			continue
		}
		if !publication && row["club_id"] != nil && integerValue(row["club_id"]) == id && firstNonEmpty(stringValue(row["country"]), country) == country {
			return true
		}
		for _, value := range anySlice(row["club_ids"]) {
			ref, ok := value.(map[string]any)
			if ok && integerValue(ref["id"]) == id && firstNonEmpty(stringValue(ref["country"]), "china") == country {
				return true
			}
		}
		clubName := strings.TrimSpace(stringValue(row["clubName"]))
		if publication {
			if clubName != "" && (clubName == name || clubName == short || contains(clubName, short)) {
				return true
			}
		} else {
			text := clubName + " " + stringValue(row["raw_text"]) + " " + stringValue(row["event"])
			if (short != "" && contains(text, short)) || (name != "" && contains(text, name)) {
				return true
			}
		}
	}
	return false
}

func (s *Server) insightQuality(ctx context.Context, country string, memberships []map[string]any, sources map[string]any, now time.Time) map[string]any {
	events := s.insightRows(ctx, "events.json", "events", sources)
	publications := s.insightRows(ctx, "publications.json", "publications", sources)
	var wiki map[string]any
	if data, err := os.ReadFile(filepath.Join(s.cfg.Root, "wiki", "index.json")); err == nil {
		_ = json.Unmarshal(data, &wiki)
	}
	publicScores, governanceScores := []float64{}, []float64{}
	missingCounts, governanceCounts := map[string]int{}, map[string]int{}
	issues, low := []map[string]any{}, []map[string]any{}
	labels := map[string]string{"logo": "缺少 Logo", "intro": "缺少简介", "public_contact": "联系方式展示策略待确认", "external_links": "缺少外部链接", "wiki": "缺少 Wiki", "events": "暂无关联活动", "publications": "暂无关联刊物/企划"}
	membershipSource, _ := sources["club_memberships"].(map[string]any)
	membershipOK := stringValue(membershipSource["status"]) == "ok"
	for _, source := range []struct{ file, country string }{{"clubs.json", "china"}, {"clubs_japan.json", "japan"}} {
		if country != "all" && country != source.country {
			continue
		}
		rows := s.insightRows(ctx, source.file, "data", sources)
		for _, value := range rows {
			club, ok := value.(map[string]any)
			if !ok {
				continue
			}
			club = cloneMap(club)
			club["country"] = source.country
			id := integerValue(club["id"])
			title := firstNonEmpty(strings.TrimSpace(stringValue(club["display_name"])), firstNonEmpty(strings.TrimSpace(stringValue(club["name"])), firstNonEmpty(stringValue(club["school"]), "未命名同好会")))
			updated := insightTime(club["updated_at"])
			action := fmt.Sprintf("reviews.html?module=clubs&country=%s&club_id=%d&search=%s", source.country, id, insightQueryEscape(firstNonEmpty(stringValue(club["name"]), stringValue(club["school"]))))
			visible := boolValue(club["visible_by_default"]) && !boolValue(club["protected"])
			contact := strings.TrimSpace(stringValue(club["info"]))
			intro := club["remark"]
			if intro == nil {
				intro = club["raw_text"]
			}
			_, hasWiki := wiki[growthWikiKey(source.country, id)].(map[string]any)
			checks := []bool{strings.TrimSpace(stringValue(club["logo_url"])) != "", strings.TrimSpace(stringValue(intro)) != "", visible || contact == "", strings.TrimSpace(stringValue(club["external_links"])) != "", hasWiki, insightAssociated(club, events, false), insightAssociated(club, publications, true)}
			missing := []string{}
			for i, key := range []string{"logo", "intro", "public_contact", "external_links", "wiki", "events", "publications"} {
				if !checks[i] {
					missing = append(missing, key)
				}
			}
			score := math.Round(float64(len(checks)-len(missing)) / float64(len(checks)) * 100)
			publicScores = append(publicScores, score)
			item := map[string]any{"club_id": id, "country": source.country, "title": title, "score": score, "missing": missing, "updated_at": insightSerializedTime(updated), "action_url": action}
			if score < 70 {
				low = append(low, item)
			}
			for _, key := range missing {
				missingCounts[key]++
				if score < 70 || containsString([]string{"logo", "intro", "wiki"}, key) {
					issue := cloneMap(item)
					delete(issue, "missing")
					issue["severity"] = "info"
					if score < 50 {
						issue["severity"] = "warning"
					}
					issue["type"] = "public_quality"
					issue["issue_code"] = "missing_" + key
					issue["type_label"] = "公开资料"
					issue["message"] = labels[key]
					issues = append(issues, issue)
				}
			}
			// Unavailable membership data must not imply that every club lacks a manager.
			if !membershipOK {
				continue
			}
			representatives, managers := 0, 0
			oldest := time.Time{}
			var pendingID int64
			for _, m := range memberships {
				if integerValue(m["club_id"]) != id || stringValue(m["country"]) != source.country {
					continue
				}
				if stringValue(m["status"]) == "active" {
					if stringValue(m["role"]) == "representative" {
						representatives++
					}
					if containsString([]string{"representative", "manager"}, stringValue(m["role"])) {
						managers++
					}
				}
				if stringValue(m["status"]) == "pending" {
					if pendingID == 0 {
						pendingID = integerValue(m["id"])
					}
					joined := insightTime(m["joined_at"])
					if !joined.IsZero() && (oldest.IsZero() || joined.Before(oldest)) {
						oldest = joined
					}
				}
			}
			pendingOK := oldest.IsZero() || insightAge(oldest, now) < 72
			visibilityOK := contact == "" || !boolValue(club["protected"]) || !boolValue(club["visible_by_default"])
			passed, total := 0, 4
			for _, ok := range []bool{representatives > 0, managers > 0, pendingOK, visibilityOK} {
				if ok {
					passed++
				}
			}
			if updated.IsZero() {
				governanceCounts["unknown_freshness"]++
			} else {
				total++
				if insightAge(updated, now) <= 180*24 {
					passed++
				}
			}
			governanceScore := math.Round(float64(passed) / float64(total) * 100)
			governanceScores = append(governanceScores, governanceScore)
			add := func(code, severity, message, link string, date time.Time) {
				governanceCounts[code]++
				issues = append(issues, map[string]any{"severity": severity, "type": "governance", "issue_code": code, "type_label": "治理", "title": title, "message": message, "score": governanceScore, "country": source.country, "club_id": id, "updated_at": insightSerializedTime(date), "action_url": link})
			}
			if representatives == 0 {
				add("no_representative", "urgent", "没有有效负责人", action, updated)
			}
			if managers == 0 {
				add("no_management", "warning", "没有有效负责人或管理员", action, updated)
			}
			if !pendingOK {
				add("overdue_membership", "urgent", "存在超过 72 小时的成员绑定申请", fmt.Sprintf("reviews.html?module=review&tab=membership&status=pending&id=%d", pendingID), oldest)
			}
			if !visibilityOK {
				add("visibility_conflict", "warning", "联系方式同时设置为保护和默认公开", action, updated)
			}
			if !updated.IsZero() && insightAge(updated, now) > 180*24 {
				add("stale_update", "warning", "超过 180 天未更新", action, updated)
			}
		}
	}
	sort.SliceStable(low, func(i, j int) bool {
		a, b := low[i], low[j]
		if numberFloat(a["score"]) != numberFloat(b["score"]) {
			return numberFloat(a["score"]) < numberFloat(b["score"])
		}
		if stringValue(a["country"]) != stringValue(b["country"]) {
			return stringValue(a["country"]) < stringValue(b["country"])
		}
		return stringValue(a["title"]) < stringValue(b["title"])
	})
	if len(low) > 50 {
		low = low[:50]
	}
	insightSort(issues)
	return map[string]any{"public": map[string]any{"average_score": insightAverage(publicScores), "evaluated": len(publicScores), "buckets": insightBuckets(publicScores), "missing_dimensions": insightCounts(missingCounts, "dimension"), "low_score_clubs": low}, "governance": map[string]any{"average_score": insightAverage(governanceScores), "evaluated": len(governanceScores), "unknown_freshness": governanceCounts["unknown_freshness"], "buckets": insightBuckets(governanceScores), "issue_counts": insightCounts(governanceCounts, "issue_code")}, "issues": issues}
}

func (s *Server) insightPayload(r *http.Request) (map[string]any, []map[string]any) {
	country := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("country")))
	if country != "china" && country != "japan" {
		country = "all"
	}
	start, end := insightRange(r)
	sources := map[string]any{}
	// Record dependencies used by the existing public growth scoring rules.
	s.insightRows(r.Context(), "events.json", "events", sources)
	s.insightRows(r.Context(), "publications.json", "publications", sources)
	var wiki map[string]any
	wikiData, wikiErr := os.ReadFile(filepath.Join(s.cfg.Root, "wiki", "index.json"))
	if wikiErr != nil {
		sources["wiki/index.json"] = map[string]any{"status": "missing"}
	} else if json.Unmarshal(wikiData, &wiki) != nil || wiki == nil {
		sources["wiki/index.json"] = map[string]any{"status": "invalid_shape"}
	} else {
		sources["wiki/index.json"] = map[string]any{"status": "ok", "count": len(wiki)}
	}
	records, memberships := s.insightRecords(r.Context(), sources)
	if country != "all" {
		filtered := []insightRecord{}
		for _, record := range records {
			if record.country == country || record.kind == "feedback" {
				filtered = append(filtered, record)
			}
		}
		records = filtered
	}
	now := time.Now().In(analyticsLocation)
	queue, review, coverage, priority := insightQueueReview(records, start, end, now)
	quality := s.insightQuality(r.Context(), country, memberships, sources, now)
	issues := append(priority, mapSlice(quality["issues"])...)
	delete(quality, "issues")
	insightSort(issues)
	priorityItems := issues
	if len(priorityItems) > 50 {
		priorityItems = priorityItems[:50]
	}
	return map[string]any{"success": true, "meta": map[string]any{"timezone": "Asia/Shanghai", "generated_at": now.Format(time.RFC3339), "range": map[string]any{"from": insightDate(start), "to": insightDate(end)}, "country": country, "sources": sources, "review_time_coverage": coverage}, "queue": queue, "review": review, "quality": quality, "priority_items": priorityItems}, issues
}
func (s *Server) adminInsightsSummary(w http.ResponseWriter, r *http.Request) {
	payload, _ := s.insightPayload(r)
	writeJSON(w, payload)
}
func (s *Server) adminInsightsIssues(w http.ResponseWriter, r *http.Request) {
	kind := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("type")))
	if !containsString([]string{"queue", "public_quality", "governance"}, kind) {
		kind = "all"
	}
	severity := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("severity")))
	if !containsString([]string{"urgent", "warning", "info"}, severity) {
		severity = "all"
	}
	payload, issues := s.insightPayload(r)
	meta := payload["meta"].(map[string]any)
	country := stringValue(meta["country"])
	filtered := []map[string]any{}
	for _, issue := range issues {
		if (kind == "all" || stringValue(issue["type"]) == kind) && (severity == "all" || stringValue(issue["severity"]) == severity) && (country == "all" || stringValue(issue["country"]) == country) {
			filtered = append(filtered, issue)
		}
	}
	page, perPage := int(queryInt(r, "page")), int(queryInt(r, "per_page"))
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = 50
	}
	if perPage > 100 {
		perPage = 100
	}
	offset := len(filtered)
	if page <= (len(filtered)/perPage)+1 {
		offset = (page - 1) * perPage
	}
	if offset > len(filtered) {
		offset = len(filtered)
	}
	end := offset + perPage
	if end > len(filtered) {
		end = len(filtered)
	}
	writeJSON(w, map[string]any{"success": true, "meta": meta, "issues": filtered[offset:end], "total": len(filtered), "page": page, "per_page": perPage})
}
