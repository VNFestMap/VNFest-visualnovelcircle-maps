<?php
// api/bangumi_account.php - 当前登录用户的 Bangumi 收藏读取接口

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('Access-Control-Allow-Methods: GET, OPTIONS');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit();
}

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/oauth_bangumi.php';
require_once __DIR__ . '/../includes/rate_limit.php';

function bangumiAccountRespond(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit();
}

function bangumiAccountFail(string $message, int $status = 400): never
{
    bangumiAccountRespond(['success' => false, 'message' => $message], $status);
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    bangumiAccountFail('仅支持 GET 请求', 405);
}

$action = (string)($_GET['action'] ?? 'status');
$user = requireLogin();
$db = getDB();
$userId = (int)$user['id'];

if ($action === 'status') {
    try {
        $binding = bangumiBindingForUser($db, $userId);
    } catch (Throwable $error) {
        bangumiAccountFail('Bangumi 绑定功能尚未完成数据库初始化', 503);
    }
    bangumiAccountRespond([
        'success' => true,
        'bound' => (bool)$binding,
        'account' => $binding ? [
            'user_id' => (int)$binding['bangumi_user_id'],
            'username' => (string)$binding['bangumi_username'],
            'nickname' => (string)($binding['bangumi_nickname'] ?? ''),
        ] : null,
    ]);
}

if ($action !== 'collections') {
    bangumiAccountFail('未知动作', 404);
}

checkRateLimit('bangumi_account_collections', 30, 1);

$limit = max(1, min(100, (int)($_GET['limit'] ?? 100)));
$offset = max(0, min(100000, (int)($_GET['offset'] ?? 0)));

try {
    $binding = bangumiBindingForUser($db, $userId);
} catch (Throwable $error) {
    bangumiAccountFail('Bangumi 绑定功能尚未完成数据库初始化', 503);
}
if (!$binding) {
    bangumiAccountFail('请先绑定 Bangumi 账号', 403);
}

try {
    $accessToken = bangumiAccessToken($db, $userId, $binding);
    $path = '/v0/users/' . rawurlencode((string)$binding['bangumi_username']) . '/collections?'
        . http_build_query([
            'subject_type' => 4,
            'type' => 2,
            'limit' => $limit,
            'offset' => $offset,
        ]);
    $response = bangumiApiGet($path, $accessToken);

    // An otherwise-valid token may have been revoked before its expiry time.
    // Refresh once, then retry the same page. Never expose the token upstream.
    if ((int)($response['status'] ?? 0) === 401) {
        // The first refresh may rotate the refresh token. Read the row again
        // before the one allowed retry instead of reusing a stale PDO row.
        $retryBinding = bangumiBindingForUser($db, $userId) ?: $binding;
        $accessToken = bangumiAccessToken($db, $userId, $retryBinding, true);
        $response = bangumiApiGet($path, $accessToken);
    }
    if (!$response['ok'] || !is_array($response['data'])) {
        $status = (int)($response['status'] ?? 0);
        if ($status === 401) {
            bangumiAccountFail('Bangumi 授权已失效，请重新绑定', 401);
        }
        bangumiAccountFail('暂时无法读取 Bangumi 收藏，请稍后再试', 502);
    }

    $payload = $response['data'];
    $rows = is_array($payload['data'] ?? null) ? $payload['data'] : [];
    $items = [];
    foreach ($rows as $row) {
        if (!is_array($row)) continue;
        $subjectId = (int)($row['subject_id'] ?? $row['subject']['id'] ?? 0);
        $subject = is_array($row['subject'] ?? null) ? $row['subject'] : [];
        if ($subjectId <= 0) continue;

        $title = trim((string)($subject['name_cn'] ?? ''));
        $originalTitle = trim((string)($subject['name'] ?? ''));
        $image = bangumiSubjectImage($subject);
        if ($title === '') $title = $originalTitle;
        if ($title === '') $title = 'Bangumi #' . $subjectId;

        $items[] = [
            'bangumi_id' => $subjectId,
            'title' => $originalTitle,
            'title_cn' => $title,
            'image' => $image,
            'source' => 'bangumi',
            'collection_type' => (int)($row['type'] ?? 2),
        ];
    }

    $total = isset($payload['total']) ? max(0, (int)$payload['total']) : $offset + count($items);
    bangumiAccountRespond([
        'success' => true,
        'items' => $items,
        'pagination' => [
            'limit' => $limit,
            'offset' => $offset,
            'total' => $total,
            'has_more' => $offset + count($items) < $total || count($items) >= $limit,
        ],
    ]);
} catch (Throwable $error) {
    error_log('Bangumi collection fetch failed: ' . $error->getMessage());
    if ((int)$error->getCode() === 401) {
        try {
            $db->prepare('DELETE FROM bangumi_bindings WHERE vnfmap_user_id = ?')->execute([$userId]);
        } catch (Throwable $cleanupError) {
            error_log('Unable to clear expired Bangumi binding: ' . $cleanupError->getMessage());
        }
        bangumiAccountFail('Bangumi 授权已失效，请重新绑定', 401);
    }
    bangumiAccountFail('暂时无法读取 Bangumi 收藏，请稍后重试', 502);
}

function bangumiSubjectImage(array $subject): string
{
    $images = is_array($subject['images'] ?? null) ? $subject['images'] : [];
    $image = '';
    foreach (['medium', 'large', 'small', 'grid', 'common'] as $key) {
        if (!empty($images[$key])) {
            $image = trim((string)$images[$key]);
            break;
        }
    }
    if ($image === '') return '';
    $host = strtolower((string)(parse_url($image, PHP_URL_HOST) ?? ''));
    if ($host !== 'lain.bgm.tv') return '';
    return '/api/image_proxy.php?url=' . rawurlencode($image);
}
