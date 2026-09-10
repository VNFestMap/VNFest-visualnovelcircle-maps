<?php
// Import historical public-page PV from Nginx access logs.
//
// This command deliberately does not create historical UV. Nginx access logs
// do not contain the first-party visitor cookie, and this importer never
// stores IP addresses, raw User-Agent strings, or complete referrer URLs.

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "This command must run from CLI.\n");
    exit(1);
}

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/analytics.php';

function historicalOption(array $argv, string $name, ?string $default = null): ?string {
    $prefix = '--' . $name . '=';
    foreach (array_slice($argv, 1) as $argument) {
        if ($argument === '--' . $name) return '1';
        if (str_starts_with($argument, $prefix)) return substr($argument, strlen($prefix));
    }
    return $default;
}

function historicalDateTime(string $value): ?DateTimeImmutable {
    try {
        return new DateTimeImmutable($value);
    } catch (Throwable $ignored) {
        return null;
    }
}

function historicalPageTitle(string $pagePath): string {
    static $titles = [];
    if (array_key_exists($pagePath, $titles)) return $titles[$pagePath];
    $relative = $pagePath === '/' ? '/index.html' : $pagePath;
    $file = dirname(__DIR__) . $relative;
    if (!is_file($file)) return $titles[$pagePath] = '';
    $html = file_get_contents($file);
    if ($html === false || !preg_match('/<title[^>]*>(.*?)<\/title>/is', $html, $match)) return $titles[$pagePath] = '';
    $title = html_entity_decode(strip_tags($match[1]), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return $titles[$pagePath] = analyticsTrimText($title, 255);
}

function historicalSource(string $referrer): array {
    $referrer = trim($referrer);
    if ($referrer === '' || $referrer === '-') return ['direct', ''];
    $host = analyticsNormalizeHost((string)(parse_url($referrer, PHP_URL_HOST) ?: ''));
    if ($host === '') return ['external', ''];
    $siteHost = analyticsNormalizeHost((string)(parse_url((string)(defined('SITE_URL') ? SITE_URL : ''), PHP_URL_HOST) ?: ''));
    $internalHosts = array_filter([$siteHost, 'map.vnfest.top', 'www.map.vnfest.top']);
    if (in_array($host, $internalHosts, true)) return ['internal', $host];
    if (preg_match('/(?:^|\.)(?:google|bing|baidu|sogou|duckduckgo|yahoo|yandex)\./i', $host)) return ['search', $host];
    if (preg_match('/(?:facebook|instagram|twitter|x\.com|weibo|weixin|wechat|qq\.com|douban|bilibili|discord|reddit)\./i', $host)
        || in_array($host, ['x.com', 'discord.com', 'reddit.com'], true)) return ['social', $host];
    return ['external', $host];
}

function historicalDevice(string $userAgent): string {
    if (preg_match('/ipad|tablet|kindle|silk\//i', $userAgent)) return 'tablet';
    if (preg_match('/mobile|iphone|ipod|windows phone/i', $userAgent)) return 'mobile';
    if (preg_match('/android/i', $userAgent)) return 'tablet';
    return $userAgent === '' ? 'unknown' : 'desktop';
}

function historicalBrowser(string $userAgent): string {
    if (preg_match('/edg\//i', $userAgent)) return 'edge';
    if (preg_match('/firefox\//i', $userAgent)) return 'firefox';
    if (preg_match('/(?:chrome|crios)\//i', $userAgent)) return 'chrome';
    if (preg_match('/safari\//i', $userAgent)) return 'safari';
    return 'other';
}

function historicalOpenLog(string $file) {
    if (str_ends_with(strtolower($file), '.gz')) return gzopen($file, 'rb');
    return fopen($file, 'rb');
}

function historicalCloseLog($handle, string $file): void {
    if (str_ends_with(strtolower($file), '.gz')) gzclose($handle);
    else fclose($handle);
}

$from = historicalOption($argv, 'from', '2026-08-10');
$to = historicalOption($argv, 'to', '2026-09-05');
$untilRaw = historicalOption($argv, 'until');
$until = $untilRaw ? historicalDateTime($untilRaw) : null;
$dryRun = historicalOption($argv, 'dry-run') !== null;
$logOption = historicalOption($argv, 'log');
$logs = $logOption ? [$logOption] : [
    '/www/wwwlogs/162.251.93.178.log.20260903-132957.gz',
    '/www/wwwlogs/162.251.93.178.log',
];

if (!analyticsParseDate((string)$from) || !analyticsParseDate((string)$to) || (string)$from > (string)$to) {
    fwrite(STDERR, "Invalid --from/--to; use YYYY-MM-DD.\n");
    exit(2);
}
if ($untilRaw !== null && !$until) {
    fwrite(STDERR, "Invalid --until datetime.\n");
    exit(2);
}

$db = getDB();
if (!analyticsHistoricalTableAvailable($db)) {
    fwrite(STDERR, "analytics_historical_pv table is missing; run the analytics migration first.\n");
    exit(3);
}

$aggregate = [];
$lineCount = 0;
$matchedPageRequests = 0;
$skipped = 0;
$linePattern = '~^\S+\s+\S+\s+\S+\s+\[(?<time>[^\]]+)\]\s+"(?<request>[^"]*)"\s+(?<status>\d{3})\s+\S+\s+"(?<referrer>[^"]*)"\s+"(?<ua>[^"]*)"~';

foreach ($logs as $file) {
    if (!is_file($file)) {
        fwrite(STDERR, "Skipping missing log: $file\n");
        continue;
    }
    $handle = historicalOpenLog($file);
    if (!$handle) {
        fwrite(STDERR, "Unable to open log: $file\n");
        exit(4);
    }
    while (($line = fgets($handle)) !== false) {
        $lineCount++;
        if (!preg_match($linePattern, $line, $match)) { $skipped++; continue; }
        $requestParts = preg_split('/\s+/', trim($match['request']), 3);
        if (!$requestParts || strtoupper((string)($requestParts[0] ?? '')) !== 'GET') { $skipped++; continue; }
        $requestTime = historicalDateTime((string)$match['time']);
        if (!$requestTime) { $skipped++; continue; }
        $dayKey = $requestTime->setTimezone(analyticsTimezone())->format('Y-m-d');
        if ($dayKey < $from || $dayKey > $to || ($until && $requestTime >= $until)) { $skipped++; continue; }
        $status = (int)$match['status'];
        if ($status < 200 || $status >= 400) { $skipped++; continue; }
        $pagePath = analyticsNormalizePath((string)($requestParts[1] ?? '/'));
        if ($pagePath === null || ($pagePath !== '/' && !preg_match('/\.html$/i', $pagePath))) { $skipped++; continue; }
        [$sourceCategory, $referrerHost] = historicalSource((string)$match['referrer']);
        $deviceType = historicalDevice((string)$match['ua']);
        $browserName = historicalBrowser((string)$match['ua']);
        $key = implode("\x1f", [$dayKey, $pagePath, $sourceCategory, $referrerHost, $deviceType, $browserName]);
        if (!isset($aggregate[$key])) {
            $aggregate[$key] = [
                'day_key' => $dayKey,
                'page_path' => $pagePath,
                'page_title' => historicalPageTitle($pagePath),
                'source_category' => $sourceCategory,
                'referrer_host' => $referrerHost,
                'device_type' => $deviceType,
                'browser_name' => $browserName,
                'pv_count' => 0,
            ];
        }
        $aggregate[$key]['pv_count']++;
        $matchedPageRequests++;
    }
    historicalCloseLog($handle, $file);
}

if (!$dryRun) {
    $importedAt = analyticsUtcNowString();
    $driver = $db->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($driver === 'mysql') {
        $sql = 'INSERT INTO analytics_historical_pv '
            . '(day_key, page_path, page_title, source_category, referrer_host, device_type, browser_name, pv_count, imported_at) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) '
            . 'ON DUPLICATE KEY UPDATE page_title = VALUES(page_title), pv_count = VALUES(pv_count), imported_at = VALUES(imported_at)';
    } else {
        $sql = 'INSERT INTO analytics_historical_pv '
            . '(day_key, page_path, page_title, source_category, referrer_host, device_type, browser_name, pv_count, imported_at) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) '
            . 'ON CONFLICT(day_key, page_path, source_category, referrer_host, device_type, browser_name) '
            . 'DO UPDATE SET page_title = excluded.page_title, pv_count = excluded.pv_count, imported_at = excluded.imported_at';
    }
    $statement = $db->prepare($sql);
    $db->beginTransaction();
    try {
        foreach ($aggregate as $row) {
            $statement->execute([
                $row['day_key'], $row['page_path'], $row['page_title'], $row['source_category'],
                $row['referrer_host'], $row['device_type'], $row['browser_name'], $row['pv_count'], $importedAt,
            ]);
        }
        $db->commit();
    } catch (Throwable $error) {
        if ($db->inTransaction()) $db->rollBack();
        throw $error;
    }
}

echo json_encode([
    'success' => true,
    'dry_run' => $dryRun,
    'from' => $from,
    'to' => $to,
    'until' => $untilRaw,
    'log_files' => $logs,
    'lines_read' => $lineCount,
    'matched_page_requests' => $matchedPageRequests,
    'aggregate_rows' => count($aggregate),
    'skipped_lines' => $skipped,
    'historical_uv' => null,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL;
