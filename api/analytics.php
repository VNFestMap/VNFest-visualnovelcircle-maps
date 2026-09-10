<?php
// api/analytics.php - first-party page-view collection and super-admin analytics.

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/analytics.php';
require_once __DIR__ . '/../includes/auth.php';

function analyticsJsonResponse(array $payload, int $status = 200): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit();
}

function analyticsRequestBody(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > 8192) return [];
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function analyticsRequireSuperAdmin(): array {
    $user = requireLogin();
    if (($user['role'] ?? '') !== 'super_admin') analyticsJsonResponse(['success' => false, 'message' => '权限不足'], 403);
    return $user;
}

function analyticsIsExistingSession(): bool {
    $sessionCookie = session_name();
    return isset($_COOKIE[$sessionCookie]) && (string)$_COOKIE[$sessionCookie] !== '';
}

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit();
}

$action = strtolower(trim((string)($_GET['action'] ?? '')));

if ($action === 'track') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') analyticsJsonResponse(['success' => false, 'message' => '仅支持 POST'], 405);
    $body = analyticsRequestBody();
    $eventId = analyticsUuid($body['event_id'] ?? null);
    $visitorId = analyticsUuid($body['visitor_id'] ?? null);
    $pagePath = analyticsNormalizePath($body['page_path'] ?? null);
    if (!$eventId || !$visitorId || $pagePath === null) {
        http_response_code(204);
        exit();
    }
    try {
        $db = getDB();
        $isAuthenticated = false;
        if (analyticsIsExistingSession()) $isAuthenticated = (bool)getCurrentUser();
        $source = analyticsSource($body['source_category'] ?? 'external');
        $host = analyticsNormalizeHost($body['referrer_host'] ?? '');
        $title = analyticsTrimText($body['page_title'] ?? '', 255);
        $device = analyticsDevice($body['device_type'] ?? 'unknown');
        $browser = analyticsBrowser($body['browser_name'] ?? 'other');
        $eventHash = analyticsVisitorHash($visitorId);
        $dayKey = analyticsLocalDayKey();
        $createdAt = analyticsUtcNowString();
        if ($db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql') {
            $stmt = $db->prepare(
                'INSERT INTO analytics_pageviews '
                . '(event_id, visitor_hash, page_path, page_title, source_category, referrer_host, device_type, browser_name, is_authenticated, day_key, created_at) '
                . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
                . 'ON DUPLICATE KEY UPDATE event_id = VALUES(event_id)'
            );
        } else {
            $stmt = $db->prepare(
                'INSERT INTO analytics_pageviews '
                . '(event_id, visitor_hash, page_path, page_title, source_category, referrer_host, device_type, browser_name, is_authenticated, day_key, created_at) '
                . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
                . 'ON CONFLICT(event_id) DO NOTHING'
            );
        }
        $stmt->execute([$eventId, $eventHash, $pagePath, $title, $source, $host, $device, $browser, $isAuthenticated ? 1 : 0, $dayKey, $createdAt]);
    } catch (Throwable $ignored) {
        // Analytics must never break the public page. The next page view can retry.
    }
    http_response_code(204);
    exit();
}

if ($action !== 'summary' && $action !== 'export') analyticsJsonResponse(['success' => false, 'message' => '未知动作'], 400);
analyticsRequireSuperAdmin();

try {
    $db = getDB();
    $summary = analyticsBuildSummary($db, $_GET['from'] ?? null, $_GET['to'] ?? null);
    if ($action === 'summary') analyticsJsonResponse($summary);

    $dataset = strtolower(trim((string)($_GET['dataset'] ?? 'trend')));
    $format = strtolower(trim((string)($_GET['format'] ?? 'json')));
    $allowed = ['trend', 'pages', 'sources', 'devices', 'browsers'];
    if (!in_array($dataset, $allowed, true) || !in_array($format, ['csv', 'json'], true)) {
        analyticsJsonResponse(['success' => false, 'message' => '导出参数无效'], 400);
    }
    $rows = $dataset === 'trend' ? $summary['trend'] : ($summary['breakdowns'][$dataset] ?? []);
    if ($format === 'json') {
        header('Content-Type: application/json; charset=utf-8');
        header('Content-Disposition: attachment; filename="vnfest_analytics_' . $dataset . '.json"');
        echo json_encode(['success' => true, 'meta' => $summary['meta'], 'dataset' => $dataset, 'rows' => $rows], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit();
    }
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="vnfest_analytics_' . $dataset . '.csv"');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF");
    if (!$rows) {
        fputcsv($out, ['暂无数据']);
    } else {
        fputcsv($out, array_keys($rows[0]));
        foreach ($rows as $row) fputcsv($out, array_values($row));
    }
    fclose($out);
    exit();
} catch (InvalidArgumentException $e) {
    analyticsJsonResponse(['success' => false, 'message' => $e->getMessage()], 400);
} catch (Throwable $e) {
    analyticsJsonResponse(['success' => false, 'message' => '统计数据暂时不可用'], 503);
}
