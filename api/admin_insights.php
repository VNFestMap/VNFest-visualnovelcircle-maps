<?php
// Super-admin operational insights: read-only queue, review and data-quality aggregates.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/growth.php';
require_once __DIR__ . '/../includes/admin_insights.php';

function adminInsightsRespond(array $payload, int $status = 200): void {
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit();
}

$currentUser = requireLogin();
if (($currentUser['role'] ?? '') !== 'super_admin') {
    adminInsightsRespond(['success' => false, 'message' => '运营洞察仅限超级管理员'], 403);
}

$action = strtolower(trim((string)($_GET['action'] ?? 'summary')));
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    adminInsightsRespond(['success' => false, 'message' => '仅支持 GET 请求'], 405);
}
$country = strtolower(trim((string)($_GET['country'] ?? 'all')));
if (!in_array($country, ['all', 'china', 'japan'], true)) $country = 'all';

try {
    $db = getDB();
    if ($action === 'summary') {
        $payload = adminInsightsSummary(
            $db,
            trim((string)($_GET['from'] ?? '')) ?: null,
            trim((string)($_GET['to'] ?? '')) ?: null,
            $country
        );
        adminInsightsRespond($payload);
    }

    if ($action === 'issues') {
        $type = strtolower(trim((string)($_GET['type'] ?? 'all')));
        $severity = strtolower(trim((string)($_GET['severity'] ?? 'all')));
        if (!in_array($type, ['all', 'queue', 'public_quality', 'governance'], true)) $type = 'all';
        if (!in_array($severity, ['all', 'urgent', 'warning', 'info'], true)) $severity = 'all';
        $page = max(1, (int)($_GET['page'] ?? 1));
        $perPage = min(100, max(1, (int)($_GET['per_page'] ?? 50)));
        adminInsightsRespond(adminInsightsIssues($db, $type, $severity, $country, $page, $perPage));
    }

    adminInsightsRespond([
        'success' => false,
        'message' => '未知动作',
        'available_actions' => ['summary', 'issues'],
    ], 400);
} catch (Throwable $e) {
    error_log('admin insights query failed: ' . $e->getMessage());
    adminInsightsRespond(['success' => false, 'message' => '运营洞察暂时不可用，请稍后重试'], 500);
}
