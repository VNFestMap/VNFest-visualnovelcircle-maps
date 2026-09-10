<?php
// SQLite and pure-aggregation behavior tests for the operational insights layer.
require_once __DIR__ . '/../includes/admin_insights.php';

function insightsTestAssert(bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
}

insightsTestAssert(extension_loaded('pdo_sqlite'), 'pdo_sqlite extension is required');

$db = new PDO('sqlite::memory:');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->exec('CREATE TABLE club_memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER NOT NULL,
    country TEXT NOT NULL DEFAULT \'china\',
    role TEXT NOT NULL DEFAULT \'member\',
    status TEXT NOT NULL DEFAULT \'active\',
    joined_at TEXT NOT NULL,
    reviewed_at TEXT,
    reviewed_by INTEGER
)');
$db->exec("INSERT INTO club_memberships (club_id, country, role, status, joined_at) VALUES (7, 'china', 'representative', 'active', '2026-09-01 00:00:00')");
$db->exec("INSERT INTO club_memberships (club_id, country, role, status, joined_at) VALUES (7, 'china', 'member', 'pending', '2026-09-01 00:00:00')");

$records = [
    [
        'type' => 'club', 'type_label' => '同好会申请', 'id' => 1, 'title' => '积压申请', 'status' => 'pending', 'country' => 'china', 'club_id' => 1,
        'submitted_at' => new DateTimeImmutable('2026-09-01 00:00:00', adminInsightsTimezone()), 'reviewed_at' => null,
    ],
    [
        'type' => 'event', 'type_label' => '活动申请', 'id' => 2, 'title' => '已处理活动', 'status' => 'approved', 'country' => 'china', 'club_id' => 1,
        'submitted_at' => new DateTimeImmutable('2026-09-04 00:00:00', adminInsightsTimezone()), 'reviewed_at' => new DateTimeImmutable('2026-09-05 00:00:00', adminInsightsTimezone()),
    ],
    [
        'type' => 'feedback', 'type_label' => '反馈建议', 'id' => 3, 'title' => '历史缺时间反馈', 'status' => 'approved', 'country' => 'china', 'club_id' => 0,
        'submitted_at' => new DateTimeImmutable('2026-08-01 00:00:00', adminInsightsTimezone()), 'reviewed_at' => null,
    ],
];
$range = adminInsightsRange('2026-09-01', '2026-09-06');
$summary = adminInsightsQueueAndReview($records, $range, new DateTimeImmutable('2026-09-06 12:00:00', adminInsightsTimezone()));
insightsTestAssert($summary['queue']['pending'] === 1, 'pending queue count is incorrect');
insightsTestAssert($summary['queue']['overdue_24h'] === 1 && $summary['queue']['overdue_72h'] === 1, 'queue SLA thresholds are incorrect');
insightsTestAssert($summary['queue']['oldest_wait_hours'] === 132.0, 'oldest pending age is incorrect');
insightsTestAssert($summary['review']['processed'] === 1 && $summary['review']['approved'] === 1, 'dated review processing count is incorrect');
insightsTestAssert($summary['review']['median_hours'] === 24.0, 'review duration median is incorrect');
insightsTestAssert($summary['review']['by_type'][1]['pass_rate_pct'] === 100.0 && $summary['review']['by_type'][1]['median_hours'] === 24.0, 'per-type review metrics are incorrect');
insightsTestAssert($summary['review']['terminal_records'] === 1, 'undated terminal records must not enter selected-period coverage');
insightsTestAssert(count($summary['review']['trend']) === 6 && $summary['review']['trend'][4]['processed'] === 1, 'review trend date filling is incorrect');

$stamp = adminInsightsStampReviewTransitions(
    [['id' => 9, 'status' => 'pending']],
    [['id' => 9, 'status' => 'approved', 'reviewed_at' => 'spoofed', 'reviewed_by' => 999]],
    42,
    '2026-09-06T12:00:00+08:00'
);
insightsTestAssert($stamp[0]['reviewed_at'] === '2026-09-06T12:00:00+08:00' && $stamp[0]['reviewed_by'] === 42, 'server review stamping must override client values');
$preserved = adminInsightsStampReviewTransitions(
    [['id' => 9, 'status' => 'approved', 'reviewed_at' => '2026-09-05T12:00:00+08:00', 'reviewed_by' => 7]],
    [['id' => 9, 'status' => 'approved', 'reviewed_at' => 'spoofed', 'reviewed_by' => 999]],
    42,
    '2026-09-06T12:00:00+08:00'
);
insightsTestAssert($preserved[0]['reviewed_at'] === '2026-09-05T12:00:00+08:00' && $preserved[0]['reviewed_by'] === 7, 'first review timestamp must remain immutable');

$sources = [];
$loaded = adminInsightsLoadRecords($db, __DIR__ . '/../data', $sources);
insightsTestAssert(count($loaded) >= 2, 'records should load from JSON and SQLite');
$membership = array_values(array_filter($loaded, static fn($row) => $row['type'] === 'membership'));
insightsTestAssert(count($membership) === 2, 'membership records must be included in queue data');
insightsTestAssert(adminInsightsRange('2026-09-06', '2026-09-01')['from'] === '2026-09-01', 'reversed dates must be normalized');

$issues = [
    ['severity' => 'warning', 'type' => 'public_quality', 'score' => 60, 'title' => '资料乙'],
    ['severity' => 'urgent', 'type' => 'queue', 'age_hours' => 24, 'title' => '待办甲'],
    ['severity' => 'urgent', 'type' => 'queue', 'age_hours' => 96, 'title' => '待办乙'],
    ['severity' => 'warning', 'type' => 'public_quality', 'score' => 20, 'title' => '资料甲'],
];
adminInsightsSortIssues($issues);
insightsTestAssert($issues[0]['title'] === '待办乙' && $issues[1]['title'] === '待办甲' && $issues[2]['title'] === '资料甲', 'priority issue ordering is incorrect');

echo "Admin insights SQLite behavior OK\n";
