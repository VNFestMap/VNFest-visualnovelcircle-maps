package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"database/sql"
)

var analyticsUUIDRE = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var analyticsHostRE = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func (s *Server) analytics(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	action := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("action")))
	if action == "track" {
		s.analyticsTrack(w, r)
		return
	}
	if action != "summary" && action != "export" {
		writeJSON(w, map[string]any{"success": false, "message": "未知动作"})
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	userID, ok := s.loggedInUserID(r)
	if !ok {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	user, err := s.findUser(r.Context(), userID)
	if err != nil || user == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]any{"success": false, "message": "请先登录"})
		return
	}
	if user.Role != "super_admin" {
		writeJSONStatus(w, http.StatusForbidden, map[string]any{"success": false, "message": "权限不足"})
		return
	}
	summary, err := s.analyticsSummary(r.Context(), r.URL.Query().Get("from"), r.URL.Query().Get("to"))
	if err != nil {
		if strings.Contains(err.Error(), "日期范围无效") {
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{"success": false, "message": err.Error()})
		} else {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{"success": false, "message": "统计数据暂时不可用"})
		}
		return
	}
	if action == "summary" {
		writeJSON(w, summary)
		return
	}
	s.analyticsExport(w, r, summary)
}

func (s *Server) analyticsTrack(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var body map[string]any
	if err := decodeJSON(r, &body, 8192); err != nil || body == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	eventID := analyticsUUID(stringValue(body["event_id"]))
	visitorID := analyticsUUID(stringValue(body["visitor_id"]))
	pagePath := analyticsNormalizePath(stringValue(body["page_path"]))
	if eventID == "" || visitorID == "" || pagePath == "" || strings.TrimSpace(s.cfg.AnalyticsHashKey) == "" || s.db == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	mac := hmac.New(sha256.New, []byte(s.cfg.AnalyticsHashKey))
	_, _ = mac.Write([]byte(visitorID))
	visitorHash := hex.EncodeToString(mac.Sum(nil))
	authenticated := 0
	if userID, _ := s.optionalSessionUser(r); userID != nil {
		authenticated = 1
	}
	dayKey := time.Now().In(analyticsLocation).Format("2006-01-02")
	createdAt := time.Now().UTC().Format("2006-01-02 15:04:05")
	args := []any{eventID, visitorHash, pagePath, analyticsTrim(stringValue(body["page_title"]), 255), analyticsSource(stringValue(body["source_category"])), analyticsHost(stringValue(body["referrer_host"])), analyticsDevice(stringValue(body["device_type"])), analyticsBrowser(stringValue(body["browser_name"])), authenticated, dayKey, createdAt}
	var err error
	if s.cfg.DBDriver == "mysql" {
		_, err = s.db.ExecContext(r.Context(), `INSERT INTO analytics_pageviews (event_id, visitor_hash, page_path, page_title, source_category, referrer_host, device_type, browser_name, is_authenticated, day_key, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE event_id=VALUES(event_id)`, args...)
	} else {
		_, err = s.db.ExecContext(r.Context(), `INSERT INTO analytics_pageviews (event_id, visitor_hash, page_path, page_title, source_category, referrer_host, device_type, browser_name, is_authenticated, day_key, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`, args...)
	}
	// Analytics is deliberately best effort. A broken analytics table must not
	// turn a normal page navigation into an error.
	_ = err
	w.WriteHeader(http.StatusNoContent)
}

var analyticsLocation = mustLocation("Asia/Shanghai")

func mustLocation(name string) *time.Location {
	location, err := time.LoadLocation(name)
	if err != nil {
		return time.FixedZone("CST", 8*60*60)
	}
	return location
}

func (s *Server) analyticsSummary(ctx context.Context, fromRaw, toRaw string) (map[string]any, error) {
	from, to, start, end, err := analyticsDateRange(fromRaw, toRaw)
	if err != nil {
		return nil, err
	}
	selected, err := s.analyticsStats(ctx, from, to)
	if err != nil {
		return nil, err
	}
	auth, err := s.analyticsAuthStats(ctx, from, to)
	if err != nil {
		return nil, err
	}
	var tracking, historical sql.NullString
	if err := s.db.QueryRowContext(ctx, "SELECT MIN(day_key) FROM analytics_pageviews").Scan(&tracking); err != nil {
		return nil, err
	}
	if err := s.db.QueryRowContext(ctx, "SELECT MIN(day_key) FROM analytics_historical_pv").Scan(&historical); err != nil {
		return nil, err
	}
	now := time.Now().In(analyticsLocation)
	lifetime, err := s.analyticsStats(ctx, "", "")
	if err != nil {
		return nil, err
	}
	periods := map[string]any{}
	periods["lifetime"] = map[string]any{"uv": lifetime.UV, "pv": lifetime.PV, "exact_pv": lifetime.ExactPV, "historical_pv": lifetime.HistoricalPV, "uv_available": lifetime.UVAvailable}
	for _, period := range []string{"today", "week", "month"} {
		periodFrom, periodTo := analyticsPeriodRange(period, now)
		previousFrom, previousTo := analyticsPreviousPeriodRange(period, now)
		current, currentErr := s.analyticsStats(ctx, periodFrom, periodTo)
		previous, previousErr := s.analyticsStats(ctx, previousFrom, previousTo)
		if currentErr != nil || previousErr != nil {
			return nil, firstError(currentErr, previousErr)
		}
		periods[period] = map[string]any{"uv": current.UV, "pv": current.PV, "exact_pv": current.ExactPV, "historical_pv": current.HistoricalPV, "uv_available": current.UVAvailable, "uv_delta_pct": analyticsDelta(current.UV, previous.UV), "pv_delta_pct": analyticsDelta(current.PV, previous.PV)}
	}
	trend, err := s.analyticsTrend(ctx, from, to, start, end)
	if err != nil {
		return nil, err
	}
	breakdowns := map[string]any{}
	for _, kind := range []string{"pages", "sources", "devices", "browsers"} {
		rows, breakdownErr := s.analyticsBreakdown(ctx, kind, from, to)
		if breakdownErr != nil {
			return nil, breakdownErr
		}
		breakdowns[kind] = rows
	}
	breakdowns["auth"] = auth
	return map[string]any{
		"success":  true,
		"meta":     map[string]any{"timezone": "Asia/Shanghai", "tracking_started_at": analyticsNullString(tracking), "historical_pv_from": analyticsNullString(historical), "historical_pv_only": historical.Valid, "range": map[string]any{"from": from, "to": to}},
		"periods":  periods,
		"selected": map[string]any{"from": from, "to": to, "uv": selected.UV, "pv": selected.PV, "exact_pv": selected.ExactPV, "historical_pv": selected.HistoricalPV, "uv_available": selected.UVAvailable, "authenticated_pv": auth.AuthenticatedPV, "anonymous_pv": auth.AnonymousPV, "historical_unknown_pv": auth.HistoricalUnknownPV},
		"trend":    trend, "breakdowns": breakdowns,
	}, nil
}

type analyticsStatsResult struct {
	UV, PV, ExactPV, HistoricalPV int64
	UVAvailable                   bool
}
type analyticsAuthResult struct{ AuthenticatedPV, AnonymousPV, HistoricalUnknownPV int64 }

func (s *Server) analyticsStats(ctx context.Context, from, to string) (analyticsStatsResult, error) {
	where, args := analyticsRangeWhere(from, to)
	var exact analyticsStatsResult
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*), COUNT(DISTINCT visitor_hash) FROM analytics_pageviews"+where, args...).Scan(&exact.ExactPV, &exact.UV); err != nil {
		return exact, err
	}
	var historical int64
	if err := s.db.QueryRowContext(ctx, "SELECT COALESCE(SUM(pv_count),0) FROM analytics_historical_pv"+where, args...).Scan(&historical); err != nil {
		return exact, err
	}
	exact.HistoricalPV, exact.PV = historical, exact.ExactPV+historical
	exact.UVAvailable = exact.ExactPV > 0
	return exact, nil
}

func (s *Server) analyticsAuthStats(ctx context.Context, from, to string) (analyticsAuthResult, error) {
	where, args := analyticsRangeWhere(from, to)
	var result analyticsAuthResult
	if err := s.db.QueryRowContext(ctx, "SELECT COALESCE(SUM(CASE WHEN is_authenticated=1 THEN 1 ELSE 0 END),0), COALESCE(SUM(CASE WHEN is_authenticated=0 THEN 1 ELSE 0 END),0) FROM analytics_pageviews"+where, args...).Scan(&result.AuthenticatedPV, &result.AnonymousPV); err != nil {
		return result, err
	}
	if err := s.db.QueryRowContext(ctx, "SELECT COALESCE(SUM(pv_count),0) FROM analytics_historical_pv"+where, args...).Scan(&result.HistoricalUnknownPV); err != nil {
		return result, err
	}
	return result, nil
}

func (s *Server) analyticsTrend(ctx context.Context, from, to string, start, end time.Time) ([]map[string]any, error) {
	type trendRow struct{ pv, uv, auth, anon int64 }
	rows, err := s.db.QueryContext(ctx, "SELECT day_key, COUNT(*), COUNT(DISTINCT visitor_hash), COALESCE(SUM(CASE WHEN is_authenticated=1 THEN 1 ELSE 0 END),0), COALESCE(SUM(CASE WHEN is_authenticated=0 THEN 1 ELSE 0 END),0) FROM analytics_pageviews WHERE day_key>=? AND day_key<=? GROUP BY day_key", from, to)
	if err != nil {
		return nil, err
	}
	exact := map[string]trendRow{}
	for rows.Next() {
		var day string
		var row trendRow
		if err := rows.Scan(&day, &row.pv, &row.uv, &row.auth, &row.anon); err != nil {
			rows.Close()
			return nil, err
		}
		exact[day] = row
	}
	rows.Close()
	historical, err := s.analyticsHistoricalTrend(ctx, from, to)
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0)
	for day := start; !day.After(end); day = day.AddDate(0, 0, 1) {
		key := day.Format("2006-01-02")
		row := exact[key]
		historicalPV := historical[key]
		result = append(result, map[string]any{"date": key, "uv": row.uv, "pv": row.pv + historicalPV, "exact_pv": row.pv, "historical_pv": historicalPV, "uv_available": row.pv > 0, "authenticated_pv": row.auth, "anonymous_pv": row.anon})
	}
	return result, nil
}

func (s *Server) analyticsHistoricalTrend(ctx context.Context, from, to string) (map[string]int64, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT day_key, COALESCE(SUM(pv_count),0) FROM analytics_historical_pv WHERE day_key>=? AND day_key<=? GROUP BY day_key", from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]int64{}
	for rows.Next() {
		var day string
		var count int64
		if err := rows.Scan(&day, &count); err != nil {
			return nil, err
		}
		result[day] = count
	}
	return result, rows.Err()
}

func (s *Server) analyticsBreakdown(ctx context.Context, kind, from, to string) ([]map[string]any, error) {
	var query string
	switch kind {
	case "pages":
		query = "SELECT page_path, MAX(page_title), COUNT(*), COUNT(DISTINCT visitor_hash) FROM analytics_pageviews WHERE day_key>=? AND day_key<=? GROUP BY page_path"
	case "sources":
		query = "SELECT source_category, referrer_host, COUNT(*), COUNT(DISTINCT visitor_hash) FROM analytics_pageviews WHERE day_key>=? AND day_key<=? GROUP BY source_category, referrer_host"
	case "devices":
		query = "SELECT device_type, COUNT(*), COUNT(DISTINCT visitor_hash) FROM analytics_pageviews WHERE day_key>=? AND day_key<=? GROUP BY device_type"
	case "browsers":
		query = "SELECT browser_name, COUNT(*), COUNT(DISTINCT visitor_hash) FROM analytics_pageviews WHERE day_key>=? AND day_key<=? GROUP BY browser_name"
	default:
		return nil, fmt.Errorf("统计维度无效")
	}
	rows, err := s.db.QueryContext(ctx, query, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]map[string]any, 0)
	for rows.Next() {
		var first, second string
		var pv, uv int64
		var row map[string]any
		if kind == "pages" || kind == "sources" {
			if err := rows.Scan(&first, &second, &pv, &uv); err != nil {
				return nil, err
			}
			if kind == "pages" {
				row = map[string]any{"page_path": first, "page_title": second, "pv": pv, "uv": uv, "uv_available": pv > 0}
			} else {
				row = map[string]any{"source_category": first, "referrer_host": second, "pv": pv, "uv": uv, "uv_available": pv > 0}
			}
		} else {
			if err := rows.Scan(&first, &pv, &uv); err != nil {
				return nil, err
			}
			key := "browser_name"
			if kind == "devices" {
				key = "device_type"
			}
			row = map[string]any{key: first, "pv": pv, "uv": uv, "uv_available": pv > 0}
		}
		result = append(result, row)
	}
	sort.SliceStable(result, func(i, j int) bool { return integerValue(result[i]["pv"]) > integerValue(result[j]["pv"]) })
	if len(result) > 20 {
		result = result[:20]
	}
	return result, rows.Err()
}

func (s *Server) analyticsExport(w http.ResponseWriter, r *http.Request, summary map[string]any) {
	dataset := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("dataset")))
	if dataset == "" {
		dataset = "trend"
	}
	format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
	if format == "" {
		format = "json"
	}
	if !containsString([]string{"trend", "pages", "sources", "devices", "browsers"}, dataset) || !containsString([]string{"json", "csv"}, format) {
		writeJSON(w, map[string]any{"success": false, "message": "导出参数无效"})
		return
	}
	rows := []map[string]any{}
	if dataset == "trend" {
		rows = mapSlice(summary["trend"])
	} else if breakdowns, ok := summary["breakdowns"].(map[string]any); ok {
		rows = mapSlice(breakdowns[dataset])
	}
	filename := "vnfest_analytics_" + dataset + "." + format
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	if format == "json" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "meta": summary["meta"], "dataset": dataset, "rows": rows})
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	writer := csv.NewWriter(w)
	_, _ = io.WriteString(w, "\xEF\xBB\xBF")
	if len(rows) == 0 {
		_ = writer.Write([]string{"暂无数据"})
	} else {
		keys := make([]string, 0, len(rows[0]))
		for key := range rows[0] {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		_ = writer.Write(keys)
		for _, row := range rows {
			values := make([]string, len(keys))
			for index, key := range keys {
				values[index] = fmt.Sprint(row[key])
			}
			_ = writer.Write(values)
		}
	}
	writer.Flush()
}

func analyticsDateRange(fromRaw, toRaw string) (string, string, time.Time, time.Time, error) {
	today := analyticsLocalDate(time.Now())
	fromRaw, toRaw = strings.TrimSpace(fromRaw), strings.TrimSpace(toRaw)
	end := today
	if toRaw != "" {
		parsed, err := time.ParseInLocation("2006-01-02", toRaw, analyticsLocation)
		if err != nil {
			return "", "", time.Time{}, time.Time{}, fmt.Errorf("日期范围无效")
		}
		end = parsed
	}
	start := end.AddDate(0, 0, -29)
	if fromRaw != "" {
		parsed, err := time.ParseInLocation("2006-01-02", fromRaw, analyticsLocation)
		if err != nil {
			return "", "", time.Time{}, time.Time{}, fmt.Errorf("日期范围无效")
		}
		start = parsed
	}
	if start.After(end) {
		return "", "", time.Time{}, time.Time{}, fmt.Errorf("日期范围无效")
	}
	return start.Format("2006-01-02"), end.Format("2006-01-02"), start, end, nil
}

func analyticsRangeWhere(from, to string) (string, []any) {
	where := make([]string, 0, 2)
	args := make([]any, 0, 2)
	if from != "" {
		where = append(where, "day_key >= ?")
		args = append(args, from)
	}
	if to != "" {
		where = append(where, "day_key <= ?")
		args = append(args, to)
	}
	if len(where) == 0 {
		return "", args
	}
	return " WHERE " + strings.Join(where, " AND "), args
}

func analyticsPeriodRange(period string, now time.Time) (string, string) {
	today := analyticsLocalDate(now)
	var start, end time.Time
	switch period {
	case "today":
		start, end = today, today
	case "week":
		weekday := int(today.Weekday())
		if weekday == 0 {
			weekday = 7
		}
		start, end = today.AddDate(0, 0, -(weekday-1)), today.AddDate(0, 0, 7-weekday)
	case "month":
		start = time.Date(today.Year(), today.Month(), 1, 0, 0, 0, 0, analyticsLocation)
		end = start.AddDate(0, 1, -1)
	default:
		return today.Format("2006-01-02"), today.Format("2006-01-02")
	}
	return start.Format("2006-01-02"), end.Format("2006-01-02")
}

func analyticsPreviousPeriodRange(period string, now time.Time) (string, string) {
	from, to := analyticsPeriodRange(period, now)
	start, _ := time.ParseInLocation("2006-01-02", from, analyticsLocation)
	end, _ := time.ParseInLocation("2006-01-02", to, analyticsLocation)
	if period == "month" {
		previousStart := start.AddDate(0, -1, 0)
		previousStart = time.Date(previousStart.Year(), previousStart.Month(), 1, 0, 0, 0, 0, analyticsLocation)
		return previousStart.Format("2006-01-02"), previousStart.AddDate(0, 1, -1).Format("2006-01-02")
	}
	days := int(end.Sub(start).Hours()/24) + 1
	previousEnd := start.AddDate(0, 0, -1)
	return previousEnd.AddDate(0, 0, -(days - 1)).Format("2006-01-02"), previousEnd.Format("2006-01-02")
}

func analyticsLocalDate(value time.Time) time.Time {
	local := value.In(analyticsLocation)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, analyticsLocation)
}

func analyticsDelta(current, previous int64) any {
	if previous == 0 {
		return nil
	}
	return float64(int64(float64(current-previous)/float64(previous)*1000)) / 10
}

func analyticsUUID(value string) string {
	value = strings.TrimSpace(value)
	if analyticsUUIDRE.MatchString(value) {
		return strings.ToLower(value)
	}
	return ""
}

func analyticsTrim(value string, max int) string {
	value = strings.TrimSpace(value)
	result := make([]rune, 0, len(value))
	for _, char := range value {
		if char < 0x20 || char == 0x7f {
			continue
		}
		result = append(result, char)
		if len(result) >= max {
			break
		}
	}
	return string(result)
}

func analyticsNormalizePath(value string) string {
	pathValue := analyticsTrim(value, 512)
	if pathValue == "" {
		pathValue = "/"
	}
	if parsed, err := url.Parse(pathValue); err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") {
		pathValue = parsed.Path
	}
	if index := strings.IndexAny(pathValue, "?#"); index >= 0 {
		pathValue = pathValue[:index]
	}
	if pathValue == "" {
		pathValue = "/"
	}
	pathValue = strings.ReplaceAll(pathValue, "\\", "/")
	if !strings.HasPrefix(pathValue, "/") {
		pathValue = "/" + pathValue
	}
	for strings.Contains(pathValue, "//") {
		pathValue = strings.ReplaceAll(pathValue, "//", "/")
	}
	if regexp.MustCompile(`(?i)/(admin|api|scripts|includes|data|uploads|node_modules|vendor)(/|$)`).MatchString(pathValue) || regexp.MustCompile(`(?i)(^|/)(test|tests|fixture|fixtures)(/|-|_|\.|$)`).MatchString(pathValue) {
		return ""
	}
	return pathValue
}

func analyticsNormalizeHost(value string) string {
	host := analyticsTrim(value, 255)
	if parsed, err := url.Parse(host); err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") {
		host = parsed.Hostname()
	}
	host = strings.ToLower(strings.Trim(host, " .\t\r\n"))
	if host == "" || len(host) > 253 || (net.ParseIP(host) == nil && !analyticsHostRE.MatchString(host)) {
		return ""
	}
	return host
}

func analyticsHost(value string) string { return analyticsNormalizeHost(value) }
func analyticsSource(value string) string {
	return firstAllowed(strings.ToLower(analyticsTrim(value, 32)), []string{"direct", "internal", "search", "social", "external"}, "external")
}
func analyticsDevice(value string) string {
	return firstAllowed(strings.ToLower(analyticsTrim(value, 16)), []string{"desktop", "mobile", "tablet", "unknown"}, "unknown")
}
func analyticsBrowser(value string) string {
	return firstAllowed(strings.ToLower(analyticsTrim(value, 32)), []string{"chrome", "edge", "firefox", "safari", "other"}, "other")
}
func firstAllowed(value string, allowed []string, fallback string) string {
	if containsString(allowed, value) {
		return value
	}
	return fallback
}

func analyticsNullString(value sql.NullString) any {
	if value.Valid {
		return value.String
	}
	return nil
}

func firstError(first, second error) error {
	if first != nil {
		return first
	}
	return second
}
