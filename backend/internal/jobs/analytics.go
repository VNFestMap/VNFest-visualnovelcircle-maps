package jobs

import (
	"bufio"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

type AnalyticsBackfillOptions struct {
	From, To string
	Until    *time.Time
	Logs     []string
	DryRun   bool
}

type AnalyticsBackfillReport struct {
	Success             bool     `json:"success"`
	DryRun              bool     `json:"dry_run"`
	From                string   `json:"from"`
	To                  string   `json:"to"`
	LogFiles            []string `json:"log_files"`
	LinesRead           int      `json:"lines_read"`
	MatchedPageRequests int      `json:"matched_page_requests"`
	AggregateRows       int      `json:"aggregate_rows"`
	SkippedLines        int      `json:"skipped_lines"`
	HistoricalUV        *int     `json:"historical_uv"`
}

var historicalAccessLogRE = regexp.MustCompile(`^\S+\s+\S+\s+\S+\s+\[(?P<time>[^\]]+)\]\s+"(?P<request>[^"]*)"\s+(?P<status>\d{3})\s+\S+\s+"(?P<referrer>[^"]*)"\s+"(?P<ua>[^"]*)"`)

type historicalPVKey struct {
	day, page, title, source, host, device, browser string
}

// RunAnalyticsBackfill ports the privacy-preserving historical PV importer.
// It never manufactures UV and never stores IP addresses, raw user agents, or
// complete referrer URLs.
func RunAnalyticsBackfill(ctx context.Context, db *sqlstore.DB, cfg config.Config, options AnalyticsBackfillOptions) (AnalyticsBackfillReport, error) {
	from := options.From
	if from == "" {
		from = "2026-08-10"
	}
	to := options.To
	if to == "" {
		to = "2026-09-05"
	}
	if !validDateKey(from) || !validDateKey(to) || from > to {
		return AnalyticsBackfillReport{}, fmt.Errorf("invalid from/to; use YYYY-MM-DD")
	}
	exists, err := db.TableExists(ctx, "analytics_historical_pv")
	if err != nil {
		return AnalyticsBackfillReport{}, err
	}
	if !exists {
		return AnalyticsBackfillReport{}, fmt.Errorf("%w: analytics_historical_pv", ErrSchemaUnavailable)
	}
	logs := options.Logs
	if len(logs) == 0 {
		logs = []string{"/www/wwwlogs/162.251.93.178.log.20260903-132957.gz", "/www/wwwlogs/162.251.93.178.log"}
	}
	report := AnalyticsBackfillReport{Success: true, DryRun: options.DryRun, From: from, To: to, LogFiles: append([]string(nil), logs...), HistoricalUV: nil}
	aggregate := map[historicalPVKey]int{}
	for _, logPath := range logs {
		file, closeFn, openErr := openHistoricalLog(logPath)
		if os.IsNotExist(openErr) {
			continue
		}
		if openErr != nil {
			return report, fmt.Errorf("open historical log: %w", openErr)
		}
		scanner := bufio.NewScanner(file)
		buffer := make([]byte, 64*1024)
		scanner.Buffer(buffer, 2<<20)
		for scanner.Scan() {
			report.LinesRead++
			line := scanner.Text()
			match := historicalAccessLogRE.FindStringSubmatch(line)
			if match == nil {
				report.SkippedLines++
				continue
			}
			fields := map[string]string{}
			for index, name := range historicalAccessLogRE.SubexpNames() {
				if index > 0 && name != "" && index < len(match) {
					fields[name] = match[index]
				}
			}
			requestParts := strings.Fields(fields["request"])
			if len(requestParts) < 2 || strings.ToUpper(requestParts[0]) != "GET" {
				report.SkippedLines++
				continue
			}
			requestTime, parseErr := parseAccessTime(fields["time"])
			if parseErr != nil {
				report.SkippedLines++
				continue
			}
			if options.Until != nil && !requestTime.Before(*options.Until) {
				report.SkippedLines++
				continue
			}
			day := requestTime.In(mustLocationJob("Asia/Shanghai")).Format("2006-01-02")
			if day < from || day > to {
				report.SkippedLines++
				continue
			}
			status := 0
			_, _ = fmt.Sscanf(fields["status"], "%d", &status)
			if status < 200 || status >= 400 {
				report.SkippedLines++
				continue
			}
			page := normalizeHistoricalPath(requestParts[1])
			if page == "" || (page != "/" && !strings.HasSuffix(strings.ToLower(page), ".html")) {
				report.SkippedLines++
				continue
			}
			source, host := historicalSourceCategory(fields["referrer"], cfg.SiteURL)
			key := historicalPVKey{day: day, page: page, title: historicalPageTitle(cfg.Root, page), source: source, host: host, device: historicalDevice(fields["ua"]), browser: historicalBrowser(fields["ua"])}
			aggregate[key]++
			report.MatchedPageRequests++
		}
		if err := scanner.Err(); err != nil {
			_ = closeFn()
			return report, fmt.Errorf("read historical log: %w", err)
		}
		if err := closeFn(); err != nil {
			return report, err
		}
	}
	report.AggregateRows = len(aggregate)
	if options.DryRun || len(aggregate) == 0 {
		return report, nil
	}
	return report, writeHistoricalPV(ctx, db, aggregate)
}

func validDateKey(value string) bool {
	_, err := time.Parse("2006-01-02", value)
	return err == nil
}

func parseAccessTime(value string) (time.Time, error) {
	return time.Parse("02/Jan/2006:15:04:05 -0700", value)
}

func openHistoricalLog(path string) (io.ReadCloser, func() error, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, func() error { return nil }, err
	}
	if strings.HasSuffix(strings.ToLower(path), ".gz") {
		reader, gzipErr := gzip.NewReader(file)
		if gzipErr != nil {
			_ = file.Close()
			return nil, func() error { return nil }, gzipErr
		}
		return reader, func() error {
			closeErr := reader.Close()
			fileErr := file.Close()
			if closeErr != nil {
				return closeErr
			}
			return fileErr
		}, nil
	}
	return file, file.Close, nil
}

func normalizeHistoricalPath(value string) string {
	if parsed, err := url.Parse(value); err == nil && parsed.IsAbs() {
		value = parsed.Path
	}
	if index := strings.IndexAny(value, "?#"); index >= 0 {
		value = value[:index]
	}
	value = strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	if value == "" {
		value = "/"
	}
	if !strings.HasPrefix(value, "/") {
		value = "/" + value
	}
	for strings.Contains(value, "//") {
		value = strings.ReplaceAll(value, "//", "/")
	}
	if historicalForbiddenPathRE.MatchString(value) || historicalFixturePathRE.MatchString(value) {
		return ""
	}
	return value
}

var historicalForbiddenPathRE = regexp.MustCompile(`(?i)/(?:admin|api|scripts|includes|data|uploads|node_modules|vendor)(?:/|$)`)
var historicalFixturePathRE = regexp.MustCompile(`(?i)(?:^|/)(?:test|tests|fixture|fixtures)(?:/|[-_.]|$)`)

func historicalPageTitle(root, page string) string {
	relative := page
	if page == "/" {
		relative = "/index.html"
	}
	file := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(relative, "/")))
	data, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	titleRE := regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	match := titleRE.FindSubmatch(data)
	if len(match) < 2 {
		return ""
	}
	title := regexp.MustCompile(`(?s)<[^>]+>`).ReplaceAllString(string(match[1]), "")
	return trimHistoricalText(title, 255)
}

func trimHistoricalText(value string, max int) string {
	value = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, strings.TrimSpace(value))
	runes := []rune(value)
	if len(runes) > max {
		return string(runes[:max])
	}
	return value
}

func historicalSourceCategory(referrer, siteURL string) (string, string) {
	referrer = strings.TrimSpace(referrer)
	if referrer == "" || referrer == "-" {
		return "direct", ""
	}
	parsed, err := url.Parse(referrer)
	if err != nil {
		return "external", ""
	}
	host := normalizeHistoricalHost(parsed.Hostname())
	if host == "" {
		return "external", ""
	}
	siteHost := ""
	if site, siteErr := url.Parse(siteURL); siteErr == nil {
		siteHost = normalizeHistoricalHost(site.Hostname())
	}
	if host == siteHost || host == "map.vnfest.top" || host == "www.map.vnfest.top" {
		return "internal", host
	}
	if strings.Contains(host, "google.") || strings.Contains(host, "bing.") || strings.Contains(host, "baidu.") || strings.Contains(host, "sogou.") || strings.Contains(host, "duckduckgo.") || strings.Contains(host, "yahoo.") || strings.Contains(host, "yandex.") {
		return "search", host
	}
	for _, social := range []string{"facebook.", "instagram.", "twitter.", "weibo.", "weixin.", "wechat.", "qq.com", "douban.", "bilibili.", "discord.", "reddit.", "x.com"} {
		if strings.Contains(host, social) {
			return "social", host
		}
	}
	return "external", host
}

func normalizeHistoricalHost(value string) string {
	value = strings.ToLower(strings.Trim(strings.TrimSpace(value), "."))
	if value == "" || len(value) > 253 || net.ParseIP(value) != nil {
		return value
	}
	if strings.ContainsAny(value, " /\\") {
		return ""
	}
	return value
}

func historicalDevice(userAgent string) string {
	lower := strings.ToLower(userAgent)
	if strings.Contains(lower, "ipad") || strings.Contains(lower, "tablet") || strings.Contains(lower, "kindle") || strings.Contains(lower, "silk/") || strings.Contains(lower, "android") {
		return "tablet"
	}
	if strings.Contains(lower, "mobile") || strings.Contains(lower, "iphone") || strings.Contains(lower, "ipod") || strings.Contains(lower, "windows phone") {
		return "mobile"
	}
	if userAgent == "" {
		return "unknown"
	}
	return "desktop"
}

func historicalBrowser(userAgent string) string {
	lower := strings.ToLower(userAgent)
	switch {
	case strings.Contains(lower, "edg/"):
		return "edge"
	case strings.Contains(lower, "firefox/"):
		return "firefox"
	case strings.Contains(lower, "chrome/") || strings.Contains(lower, "crios/"):
		return "chrome"
	case strings.Contains(lower, "safari/"):
		return "safari"
	default:
		return "other"
	}
}

func writeHistoricalPV(ctx context.Context, db *sqlstore.DB, values map[historicalPVKey]int) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var query string
	if db.Driver == "mysql" {
		query = `INSERT INTO analytics_historical_pv (day_key,page_path,page_title,source_category,referrer_host,device_type,browser_name,pv_count,imported_at) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE page_title=VALUES(page_title),pv_count=VALUES(pv_count),imported_at=VALUES(imported_at)`
	} else {
		query = `INSERT INTO analytics_historical_pv (day_key,page_path,page_title,source_category,referrer_host,device_type,browser_name,pv_count,imported_at) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(day_key,page_path,source_category,referrer_host,device_type,browser_name) DO UPDATE SET page_title=excluded.page_title,pv_count=excluded.pv_count,imported_at=excluded.imported_at`
	}
	statement, err := tx.PrepareContext(ctx, query)
	if err != nil {
		return err
	}
	keys := make([]historicalPVKey, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].day != keys[j].day {
			return keys[i].day < keys[j].day
		}
		return keys[i].page < keys[j].page
	})
	for _, key := range keys {
		if _, err := statement.ExecContext(ctx, key.day, key.page, key.title, key.source, key.host, key.device, key.browser, values[key]); err != nil {
			_ = statement.Close()
			return err
		}
	}
	if err := statement.Close(); err != nil {
		return err
	}
	return tx.Commit()
}

func mustLocationJob(name string) *time.Location {
	location, err := time.LoadLocation(name)
	if err != nil {
		return time.UTC
	}
	return location
}
