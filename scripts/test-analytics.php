<?php
// SQLite behavior and date-boundary tests for the privacy-preserving analytics layer.
require_once __DIR__ . '/../includes/analytics.php';

function analyticsTestAssert(bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
}

analyticsTestAssert(extension_loaded('pdo_sqlite'), 'pdo_sqlite extension is required');
$db = new PDO('sqlite::memory:');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->exec('CREATE TABLE analytics_pageviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    visitor_hash TEXT NOT NULL,
    page_path TEXT NOT NULL,
    page_title TEXT NOT NULL,
    source_category TEXT NOT NULL,
    referrer_host TEXT NOT NULL,
    device_type TEXT NOT NULL,
    browser_name TEXT NOT NULL,
    is_authenticated INTEGER NOT NULL,
    day_key TEXT NOT NULL,
    created_at TEXT NOT NULL
)');

$insert = $db->prepare('INSERT INTO analytics_pageviews
    (event_id, visitor_hash, page_path, page_title, source_category, referrer_host, device_type, browser_name, is_authenticated, day_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
$visitorA = analyticsVisitorHash('11111111-1111-4111-8111-111111111111');
$visitorB = analyticsVisitorHash('22222222-2222-4222-8222-222222222222');
$add = static function (string $event, string $visitor, string $page, string $day, int $authenticated) use ($insert): void {
    $insert->execute([$event, $visitor, $page, $page === '/index.html' ? '首页' : '其他页面', 'direct', '', 'desktop', 'chrome', $authenticated, $day, $day . ' 01:00:00']);
};

// One visitor views the same page three times in one day, then once on the next day.
$add('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', $visitorA, '/index.html', '2026-09-05', 0);
$add('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', $visitorA, '/index.html', '2026-09-05', 0);
$add('cccccccc-cccc-4ccc-8ccc-cccccccccccc', $visitorA, '/index.html', '2026-09-05', 1);
$add('dddddddd-dddd-4ddd-8ddd-dddddddddddd', $visitorA, '/other.html', '2026-09-06', 0);
// A second visitor reaches the same page on the first day.
$add('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', $visitorB, '/index.html', '2026-09-05', 0);

$dayOne = analyticsStats($db, '2026-09-05', '2026-09-05');
analyticsTestAssert($dayOne['pv'] === 4 && $dayOne['uv'] === 2, 'same-day PV/UV aggregation is incorrect');
$dayTwo = analyticsStats($db, '2026-09-06', '2026-09-06');
analyticsTestAssert($dayTwo['pv'] === 1 && $dayTwo['uv'] === 1, 'cross-day daily UV/PV aggregation is incorrect');
$lifetime = analyticsStats($db);
analyticsTestAssert($lifetime['pv'] === 5 && $lifetime['uv'] === 2, 'lifetime UV must deduplicate a visitor across days');

$page = analyticsBreakdown($db, 'pages', '2026-09-05', '2026-09-05');
analyticsTestAssert($page[0]['page_path'] === '/index.html' && $page[0]['pv'] === 4 && $page[0]['uv'] === 2, 'page breakdown is incorrect');
$auth = analyticsAuthStats($db, '2026-09-05', '2026-09-05');
analyticsTestAssert($auth['authenticated_pv'] === 1 && $auth['anonymous_pv'] === 3, 'authenticated/anonymous PV split is incorrect');

$trend = analyticsTrend($db, '2026-09-05', '2026-09-07');
analyticsTestAssert(count($trend) === 3 && $trend[1]['pv'] === 1 && $trend[2]['pv'] === 0, 'trend must fill missing natural dates');

// The event key is idempotent: a duplicate insert is ignored by the SQLite conflict clause used by the API.
$duplicate = $db->prepare('INSERT INTO analytics_pageviews
    (event_id, visitor_hash, page_path, page_title, source_category, referrer_host, device_type, browser_name, is_authenticated, day_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING');
$duplicate->execute(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', $visitorA, '/index.html', '首页', 'direct', '', 'desktop', 'chrome', 0, '2026-09-05', '2026-09-05 01:00:00']);
$count = (int)$db->query("SELECT COUNT(*) FROM analytics_pageviews WHERE event_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'")->fetchColumn();
analyticsTestAssert($count === 1, 'duplicate event_id must not create a second row');

$monday = new DateTimeImmutable('2026-09-07 12:00:00', analyticsTimezone());
$week = analyticsPeriodRange('week', $monday);
analyticsTestAssert($week['from'] === '2026-09-07' && $week['to'] === '2026-09-13', 'week must run Monday through Sunday');
$previousWeek = analyticsPreviousPeriodRange('week', $monday);
analyticsTestAssert($previousWeek['from'] === '2026-08-31' && $previousWeek['to'] === '2026-09-06', 'previous week boundary is incorrect');
$month = analyticsPeriodRange('month', new DateTimeImmutable('2026-09-30 12:00:00', analyticsTimezone()));
analyticsTestAssert($month['from'] === '2026-09-01' && $month['to'] === '2026-09-30', 'month boundary is incorrect');

$beforeChinaMidnight = new DateTimeImmutable('2026-09-01 15:59:59', new DateTimeZone('UTC'));
$afterChinaMidnight = new DateTimeImmutable('2026-09-01 16:00:00', new DateTimeZone('UTC'));
analyticsTestAssert(analyticsLocalDayKey($beforeChinaMidnight) === '2026-09-01', 'China day key before midnight is incorrect');
analyticsTestAssert(analyticsLocalDayKey($afterChinaMidnight) === '2026-09-02', 'China day key after midnight is incorrect');

analyticsTestAssert(analyticsNormalizePath('/index.html?token=secret#section') === '/index.html', 'query/hash must be removed from page path');
analyticsTestAssert(analyticsNormalizePath('/api/auth.php') === null, 'API paths must be rejected');
analyticsTestAssert(analyticsDateRange(null, '2026-09-05')['from'] === '2026-08-07', 'a range with only an end date must default to the preceding 30 days');
analyticsTestAssert(analyticsNormalizeHost('WWW.Example.COM.') === 'www.example.com', 'referrer host must be normalized');
analyticsTestAssert(analyticsDevice('phone') === 'unknown' && analyticsBrowser('opera') === 'other', 'enum allowlists must normalize unknown values');

// Historical access-log imports supplement PV only. They must never create a
// fake visitor hash or make the historical request count look like UV.
$db->exec('CREATE TABLE analytics_historical_pv (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day_key TEXT NOT NULL,
    page_path TEXT NOT NULL,
    page_title TEXT NOT NULL DEFAULT \'\',
    source_category TEXT NOT NULL DEFAULT \'external\',
    referrer_host TEXT NOT NULL DEFAULT \'\',
    device_type TEXT NOT NULL DEFAULT \'unknown\',
    browser_name TEXT NOT NULL DEFAULT \'other\',
    pv_count INTEGER NOT NULL DEFAULT 0,
    imported_at TEXT NOT NULL
)');
$historicalInsert = $db->prepare('INSERT INTO analytics_historical_pv
    (day_key, page_path, page_title, source_category, referrer_host, device_type, browser_name, pv_count, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
$historicalInsert->execute(['2026-08-10', '/index.html', '首页', 'direct', '', 'desktop', 'chrome', 4, '2026-09-05 14:00:00']);
$historicalInsert->execute(['2026-08-11', '/other.html', '其他页面', 'external', 'example.com', 'mobile', 'safari', 3, '2026-09-05 14:00:00']);
$historicalOnly = analyticsStats($db, '2026-08-10', '2026-08-11');
analyticsTestAssert($historicalOnly['pv'] === 7 && $historicalOnly['uv'] === 0 && $historicalOnly['historical_pv'] === 7 && $historicalOnly['uv_available'] === false, 'historical PV must not be counted as UV');
$historicalTrend = analyticsTrend($db, '2026-08-10', '2026-08-11');
analyticsTestAssert($historicalTrend[0]['pv'] === 4 && $historicalTrend[0]['historical_pv'] === 4 && $historicalTrend[0]['uv'] === 0, 'historical PV must appear in the daily trend without UV');
$historicalPage = analyticsBreakdown($db, 'pages', '2026-08-10', '2026-08-11');
analyticsTestAssert($historicalPage[0]['pv'] === 4 && $historicalPage[0]['uv'] === 0 && $historicalPage[0]['uv_available'] === false, 'historical page breakdown must expose unavailable UV');
$historicalAuth = analyticsAuthStats($db, '2026-08-10', '2026-08-11');
analyticsTestAssert($historicalAuth['authenticated_pv'] === 0 && $historicalAuth['anonymous_pv'] === 0 && $historicalAuth['historical_unknown_pv'] === 7, 'historical PV must not be classified as logged-in or anonymous');

echo "Analytics SQLite behavior OK\n";
