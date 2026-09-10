<?php
// includes/analytics.php - first-party, privacy-preserving page-view analytics.

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/db.php';

function analyticsTimezone(): DateTimeZone {
    static $timezone = null;
    if ($timezone === null) $timezone = new DateTimeZone('Asia/Shanghai');
    return $timezone;
}

function analyticsNowLocal(): DateTimeImmutable {
    return new DateTimeImmutable('now', analyticsTimezone());
}

function analyticsUtcNowString(): string {
    return (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d H:i:s');
}

function analyticsLocalDayKey(?DateTimeImmutable $utcNow = null): string {
    $utcNow = $utcNow ?: new DateTimeImmutable('now', new DateTimeZone('UTC'));
    return $utcNow->setTimezone(analyticsTimezone())->format('Y-m-d');
}

function analyticsTrimText($value, int $maxLength): string {
    $value = trim((string)$value);
    $value = preg_replace('/[\\x00-\\x1F\\x7F]/u', '', $value) ?? '';
    if (function_exists('mb_substr')) return mb_substr($value, 0, $maxLength, 'UTF-8');
    return substr($value, 0, $maxLength);
}

function analyticsUuid($value): ?string {
    $value = trim((string)$value);
    return preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i', $value)
        ? strtolower($value) : null;
}

function analyticsNormalizePath($value): ?string {
    $path = analyticsTrimText($value, 512);
    if ($path === '') $path = '/';
    if (preg_match('/^https?:\\/\\//i', $path)) {
        $parsed = parse_url($path, PHP_URL_PATH);
        $path = is_string($parsed) && $parsed !== '' ? $parsed : '/';
    }
    $path = (string)(preg_split('/[?#]/', $path, 2)[0] ?? '');
    if ($path === '') $path = '/';
    $path = str_replace('\\', '/', $path);
    if ($path[0] !== '/') $path = '/' . $path;
    $path = preg_replace('#/{2,}#', '/', $path) ?: '/';
    if (preg_match('#/(?:admin|api|scripts|includes|data|uploads|node_modules|vendor)(?:/|$)#i', $path)) return null;
    if (preg_match('#(?:^|/)(?:test|tests|fixture|fixtures)(?:/|[-_.]|$)#i', $path)) return null;
    return $path;
}

function analyticsNormalizeHost($value): string {
    $host = analyticsTrimText($value, 255);
    if ($host === '') return '';
    if (preg_match('/^https?:\\/\\//i', $host)) $host = (string)(parse_url($host, PHP_URL_HOST) ?: '');
    $host = strtolower(trim($host, " .\\t\\r\\n"));
    if ($host === '' || strlen($host) > 253) return '';
    if (!preg_match('/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/', $host)
        && !filter_var($host, FILTER_VALIDATE_IP)) return '';
    return $host;
}

function analyticsSource($value): string {
    $allowed = ['direct', 'internal', 'search', 'social', 'external'];
    $source = strtolower(analyticsTrimText($value, 32));
    return in_array($source, $allowed, true) ? $source : 'external';
}

function analyticsDevice($value): string {
    $allowed = ['desktop', 'mobile', 'tablet', 'unknown'];
    $device = strtolower(analyticsTrimText($value, 16));
    return in_array($device, $allowed, true) ? $device : 'unknown';
}

function analyticsBrowser($value): string {
    $allowed = ['chrome', 'edge', 'firefox', 'safari', 'other'];
    $browser = strtolower(analyticsTrimText($value, 32));
    return in_array($browser, $allowed, true) ? $browser : 'other';
}

function analyticsHashKey(): string {
    if (defined('ANALYTICS_HASH_KEY') && (string)ANALYTICS_HASH_KEY !== '') return (string)ANALYTICS_HASH_KEY;
    if (defined('SESSION_SECRET') && (string)SESSION_SECRET !== '') return (string)SESSION_SECRET;
    return '';
}

function analyticsVisitorHash(string $visitorId): string {
    $key = analyticsHashKey();
    if ($key === '') throw new RuntimeException('analytics hash key is not configured');
    return hash_hmac('sha256', $visitorId, $key);
}

function analyticsParseDate(string $value): ?DateTimeImmutable {
    if (!preg_match('/^\\d{4}-\\d{2}-\\d{2}$/', $value)) return null;
    $date = DateTimeImmutable::createFromFormat('!Y-m-d', $value, analyticsTimezone());
    $errors = DateTimeImmutable::getLastErrors();
    if (!$date || ($errors !== false && ($errors['warning_count'] || $errors['error_count']))) return null;
    return $date;
}

function analyticsDateRange(?string $from, ?string $to): array {
    $today = analyticsNowLocal()->setTime(0, 0, 0);
    $from = trim((string)$from);
    $to = trim((string)$to);
    $end = $to === '' ? $today : analyticsParseDate($to);
    $start = $from === ''
        ? ($end ?: $today)->modify('-29 days')
        : analyticsParseDate($from);
    if (!$start || !$end || $start > $end) throw new InvalidArgumentException('日期范围无效');
    return ['from' => $start->format('Y-m-d'), 'to' => $end->format('Y-m-d'), 'start' => $start, 'end' => $end];
}

function analyticsPeriodRange(string $period, ?DateTimeImmutable $now = null): array {
    $now = ($now ?: analyticsNowLocal())->setTimezone(analyticsTimezone())->setTime(0, 0, 0);
    if ($period === 'today') $start = $now;
    elseif ($period === 'week') $start = $now->modify('monday this week');
    elseif ($period === 'month') $start = $now->modify('first day of this month');
    else throw new InvalidArgumentException('统计周期无效');
    if ($period === 'today') $end = $start;
    elseif ($period === 'week') $end = $start->modify('+6 days');
    else $end = $start->modify('last day of this month');
    return ['from' => $start->format('Y-m-d'), 'to' => $end->format('Y-m-d')];
}

function analyticsPreviousPeriodRange(string $period, ?DateTimeImmutable $now = null): array {
    $current = analyticsPeriodRange($period, $now);
    $start = analyticsParseDate($current['from']);
    $end = analyticsParseDate($current['to']);
    if (!$start || !$end) throw new InvalidArgumentException('统计周期无效');
    if ($period === 'month') {
        $previousStart = $start->modify('-1 month')->modify('first day of this month');
        $previousEnd = $previousStart->modify('last day of this month');
    } else {
        $days = (int)$start->diff($end)->format('%a') + 1;
        $previousEnd = $start->modify('-1 day');
        $previousStart = $previousEnd->modify('-' . ($days - 1) . ' days');
    }
    return ['from' => $previousStart->format('Y-m-d'), 'to' => $previousEnd->format('Y-m-d')];
}

function analyticsHistoricalTableAvailable(PDO $db): bool {
    try {
        $db->query('SELECT 1 FROM analytics_historical_pv LIMIT 1');
        return true;
    } catch (Throwable $ignored) {
        return false;
    }
}

function analyticsExactStats(PDO $db, ?string $from = null, ?string $to = null): array {
    $where = [];
    $params = [];
    if ($from !== null) { $where[] = 'day_key >= ?'; $params[] = $from; }
    if ($to !== null) { $where[] = 'day_key <= ?'; $params[] = $to; }
    $clause = $where ? ' WHERE ' . implode(' AND ', $where) : '';
    $stmt = $db->prepare("SELECT COUNT(*) AS pv, COUNT(DISTINCT visitor_hash) AS uv FROM analytics_pageviews$clause");
    $stmt->execute($params);
    $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
    return ['uv' => (int)($row['uv'] ?? 0), 'pv' => (int)($row['pv'] ?? 0)];
}

function analyticsHistoricalStats(PDO $db, ?string $from = null, ?string $to = null): array {
    if (!analyticsHistoricalTableAvailable($db)) return ['pv' => 0];
    $where = [];
    $params = [];
    if ($from !== null) { $where[] = 'day_key >= ?'; $params[] = $from; }
    if ($to !== null) { $where[] = 'day_key <= ?'; $params[] = $to; }
    $clause = $where ? ' WHERE ' . implode(' AND ', $where) : '';
    $stmt = $db->prepare("SELECT COALESCE(SUM(pv_count), 0) AS pv FROM analytics_historical_pv$clause");
    $stmt->execute($params);
    return ['pv' => (int)($stmt->fetchColumn() ?: 0)];
}

function analyticsStats(PDO $db, ?string $from = null, ?string $to = null): array {
    $exact = analyticsExactStats($db, $from, $to);
    $historical = analyticsHistoricalStats($db, $from, $to);
    return [
        'uv' => $exact['uv'],
        'pv' => $exact['pv'] + $historical['pv'],
        'exact_pv' => $exact['pv'],
        'historical_pv' => $historical['pv'],
        'uv_available' => $exact['pv'] > 0,
    ];
}

function analyticsAuthStats(PDO $db, string $from, string $to): array {
    $stmt = $db->prepare(
        'SELECT '
        . 'SUM(CASE WHEN is_authenticated = 1 THEN 1 ELSE 0 END) AS authenticated_pv, '
        . 'SUM(CASE WHEN is_authenticated = 0 THEN 1 ELSE 0 END) AS anonymous_pv '
        . 'FROM analytics_pageviews WHERE day_key >= ? AND day_key <= ?'
    );
    $stmt->execute([$from, $to]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
    return [
        'authenticated_pv' => (int)($row['authenticated_pv'] ?? 0),
        'anonymous_pv' => (int)($row['anonymous_pv'] ?? 0),
        'historical_unknown_pv' => analyticsHistoricalStats($db, $from, $to)['pv'],
    ];
}

function analyticsTrend(PDO $db, string $from, string $to): array {
    $stmt = $db->prepare(
        'SELECT day_key AS date, COUNT(*) AS pv, COUNT(DISTINCT visitor_hash) AS uv, '
        . 'SUM(CASE WHEN is_authenticated = 1 THEN 1 ELSE 0 END) AS authenticated_pv, '
        . 'SUM(CASE WHEN is_authenticated = 0 THEN 1 ELSE 0 END) AS anonymous_pv '
        . 'FROM analytics_pageviews WHERE day_key >= ? AND day_key <= ? GROUP BY day_key ORDER BY day_key ASC'
    );
    $stmt->execute([$from, $to]);
    $rows = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $rows[(string)$row['date']] = [
            'date' => (string)$row['date'], 'uv' => (int)$row['uv'], 'pv' => (int)$row['pv'],
            'exact_pv' => (int)$row['pv'], 'historical_pv' => 0, 'uv_available' => true,
            'authenticated_pv' => (int)$row['authenticated_pv'], 'anonymous_pv' => (int)$row['anonymous_pv'],
        ];
    }
    if (analyticsHistoricalTableAvailable($db)) {
        $historical = $db->prepare(
            'SELECT day_key AS date, COALESCE(SUM(pv_count), 0) AS pv '
            . 'FROM analytics_historical_pv WHERE day_key >= ? AND day_key <= ? GROUP BY day_key ORDER BY day_key ASC'
        );
        $historical->execute([$from, $to]);
        foreach ($historical->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $key = (string)$row['date'];
            if (!isset($rows[$key])) {
                $rows[$key] = [
                    'date' => $key, 'uv' => 0, 'pv' => 0, 'exact_pv' => 0, 'historical_pv' => 0,
                    'uv_available' => false, 'authenticated_pv' => 0, 'anonymous_pv' => 0,
                ];
            }
            $rows[$key]['historical_pv'] = (int)$row['pv'];
            $rows[$key]['pv'] += (int)$row['pv'];
        }
    }
    $start = analyticsParseDate($from);
    $end = analyticsParseDate($to);
    if (!$start || !$end) return array_values($rows);
    $result = [];
    for ($date = $start; $date <= $end; $date = $date->modify('+1 day')) {
        $key = $date->format('Y-m-d');
        $result[] = $rows[$key] ?? [
            'date' => $key, 'uv' => 0, 'pv' => 0, 'exact_pv' => 0, 'historical_pv' => 0,
            'uv_available' => false, 'authenticated_pv' => 0, 'anonymous_pv' => 0,
        ];
    }
    return $result;
}

function analyticsBreakdown(PDO $db, string $kind, string $from, string $to, int $limit = 20): array {
    $limit = min(100, max(1, $limit));
    $rows = [];
    if ($kind === 'pages') {
        $sql = 'SELECT page_path, MAX(page_title) AS page_title, COUNT(*) AS pv, COUNT(DISTINCT visitor_hash) AS uv '
            . 'FROM analytics_pageviews WHERE day_key >= ? AND day_key <= ? GROUP BY page_path';
    } elseif ($kind === 'sources') {
        $sql = 'SELECT source_category, referrer_host, COUNT(*) AS pv, COUNT(DISTINCT visitor_hash) AS uv '
            . 'FROM analytics_pageviews WHERE day_key >= ? AND day_key <= ? GROUP BY source_category, referrer_host';
    } elseif ($kind === 'devices') {
        $sql = 'SELECT device_type, COUNT(*) AS pv, COUNT(DISTINCT visitor_hash) AS uv '
            . 'FROM analytics_pageviews WHERE day_key >= ? AND day_key <= ? GROUP BY device_type';
    } elseif ($kind === 'browsers') {
        $sql = 'SELECT browser_name, COUNT(*) AS pv, COUNT(DISTINCT visitor_hash) AS uv '
            . 'FROM analytics_pageviews WHERE day_key >= ? AND day_key <= ? GROUP BY browser_name';
    } else {
        throw new InvalidArgumentException('统计维度无效');
    }
    $stmt = $db->prepare($sql);
    $stmt->execute([$from, $to]);
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $key = $kind === 'pages'
            ? (string)$row['page_path']
            : ($kind === 'sources' ? (string)$row['source_category'] . "\0" . (string)$row['referrer_host'] : (string)$row[$kind === 'devices' ? 'device_type' : 'browser_name']);
        $rows[$key] = [
            'row' => $row,
            'pv' => (int)($row['pv'] ?? 0),
            'uv' => (int)($row['uv'] ?? 0),
            'uv_available' => ((int)($row['pv'] ?? 0)) > 0,
        ];
    }
    if (analyticsHistoricalTableAvailable($db)) {
        $historical = $db->prepare(
            'SELECT page_path, MAX(page_title) AS page_title, source_category, referrer_host, device_type, browser_name, COALESCE(SUM(pv_count), 0) AS pv '
            . 'FROM analytics_historical_pv WHERE day_key >= ? AND day_key <= ? '
            . 'GROUP BY page_path, page_title, source_category, referrer_host, device_type, browser_name'
        );
        $historical->execute([$from, $to]);
        foreach ($historical->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if ($kind === 'pages') $key = (string)$row['page_path'];
            elseif ($kind === 'sources') $key = (string)$row['source_category'] . "\0" . (string)$row['referrer_host'];
            else $key = (string)$row[$kind === 'devices' ? 'device_type' : 'browser_name'];
            if (!isset($rows[$key])) {
                $rows[$key] = ['row' => $row, 'pv' => 0, 'uv' => 0, 'uv_available' => false];
            }
            $rows[$key]['pv'] += (int)$row['pv'];
            if ($kind === 'pages' && (string)($rows[$key]['row']['page_title'] ?? '') === '') $rows[$key]['row']['page_title'] = (string)$row['page_title'];
        }
    }
    usort($rows, static function (array $a, array $b): int {
        return ($b['pv'] <=> $a['pv']) ?: ($b['uv'] <=> $a['uv']);
    });
    $result = [];
    foreach (array_slice($rows, 0, $limit) as $item) {
        $row = $item['row'];
        $common = ['uv' => $item['uv'], 'pv' => $item['pv'], 'uv_available' => $item['uv_available']];
        if ($kind === 'pages') $result[] = ['page_path' => (string)($row['page_path'] ?? ''), 'page_title' => (string)($row['page_title'] ?? ''), ...$common];
        elseif ($kind === 'sources') $result[] = ['source_category' => (string)($row['source_category'] ?? 'external'), 'referrer_host' => (string)($row['referrer_host'] ?? ''), ...$common];
        else { $field = $kind === 'devices' ? 'device_type' : 'browser_name'; $result[] = [$field => (string)($row[$field] ?? 'other'), ...$common]; }
    }
    return $result;
}

function analyticsDelta(int $current, int $previous): ?float {
    if ($previous === 0) return null;
    return round((($current - $previous) / $previous) * 100, 1);
}

function analyticsPeriodPayload(PDO $db, string $period, DateTimeImmutable $now): array {
    $range = analyticsPeriodRange($period, $now);
    $previous = analyticsPreviousPeriodRange($period, $now);
    $stats = analyticsStats($db, $range['from'], $range['to']);
    $old = analyticsStats($db, $previous['from'], $previous['to']);
    return [
        'uv' => $stats['uv'], 'pv' => $stats['pv'],
        'exact_pv' => $stats['exact_pv'], 'historical_pv' => $stats['historical_pv'], 'uv_available' => $stats['uv_available'],
        'uv_delta_pct' => analyticsDelta($stats['uv'], $old['uv']),
        'pv_delta_pct' => analyticsDelta($stats['pv'], $old['pv']),
    ];
}

function analyticsBuildSummary(PDO $db, ?string $from = null, ?string $to = null): array {
    $range = analyticsDateRange($from, $to);
    $now = analyticsNowLocal();
    $selected = analyticsStats($db, $range['from'], $range['to']);
    $auth = analyticsAuthStats($db, $range['from'], $range['to']);
    $started = $db->query('SELECT MIN(day_key) FROM analytics_pageviews')->fetchColumn();
    $historicalStarted = analyticsHistoricalTableAvailable($db)
        ? $db->query('SELECT MIN(day_key) FROM analytics_historical_pv')->fetchColumn()
        : null;
    return [
        'success' => true,
        'meta' => [
            'timezone' => 'Asia/Shanghai',
            'tracking_started_at' => $started ?: null,
            'historical_pv_from' => $historicalStarted ?: null,
            'historical_pv_only' => (bool)$historicalStarted,
            'range' => ['from' => $range['from'], 'to' => $range['to']],
        ],
        'periods' => [
            'lifetime' => analyticsStats($db),
            'today' => analyticsPeriodPayload($db, 'today', $now),
            'week' => analyticsPeriodPayload($db, 'week', $now),
            'month' => analyticsPeriodPayload($db, 'month', $now),
        ],
        'selected' => [
            'from' => $range['from'], 'to' => $range['to'], 'uv' => $selected['uv'], 'pv' => $selected['pv'],
            'exact_pv' => $selected['exact_pv'], 'historical_pv' => $selected['historical_pv'], 'uv_available' => $selected['uv_available'],
            'authenticated_pv' => $auth['authenticated_pv'], 'anonymous_pv' => $auth['anonymous_pv'], 'historical_unknown_pv' => $auth['historical_unknown_pv'],
        ],
        'trend' => analyticsTrend($db, $range['from'], $range['to']),
        'breakdowns' => [
            'pages' => analyticsBreakdown($db, 'pages', $range['from'], $range['to']),
            'sources' => analyticsBreakdown($db, 'sources', $range['from'], $range['to']),
            'devices' => analyticsBreakdown($db, 'devices', $range['from'], $range['to']),
            'browsers' => analyticsBreakdown($db, 'browsers', $range['from'], $range['to']),
            'auth' => $auth,
        ],
    ];
}
