<?php
declare(strict_types=1);

$requestPath = parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/';
$qaMode = (string)($_COOKIE['vnfest_column_qa'] ?? 'space-member');
if (isset($_GET['qa']) && preg_match('/^[a-z0-9-]+$/i', (string)$_GET['qa'])) {
    $qaMode = (string)$_GET['qa'];
    setcookie('vnfest_column_qa', $qaMode, [
        'expires' => time() + 300,
        'path' => '/',
        'samesite' => 'Lax',
    ]);
}

$spaceFixtures = [
    'space-guest' => ['user' => null, 'access' => ['allowed' => false, 'reason' => 'login_required'], 'clubs' => []],
    'space-visitor' => ['user' => ['role' => 'visitor'], 'access' => ['allowed' => false, 'reason' => 'membership_required'], 'clubs' => []],
    'space-external' => ['user' => ['role' => 'external'], 'access' => ['allowed' => false, 'reason' => 'membership_required'], 'clubs' => []],
    'space-inactive' => ['user' => ['role' => 'visitor'], 'access' => ['allowed' => false, 'reason' => 'membership_required'], 'clubs' => [['role' => 'member', 'status' => 'inactive']]],
    'space-pending' => ['user' => ['role' => 'visitor'], 'access' => ['allowed' => false, 'reason' => 'membership_required'], 'clubs' => [['role' => 'member', 'status' => 'pending']]],
    'space-member' => ['user' => ['role' => 'member'], 'access' => ['allowed' => true, 'reason' => 'ok'], 'clubs' => []],
    'space-club-member' => ['user' => ['role' => 'visitor'], 'access' => ['allowed' => true, 'reason' => 'ok'], 'clubs' => [['role' => 'member', 'status' => 'active']]],
    'space-manager' => ['user' => ['role' => 'manager'], 'access' => ['allowed' => true, 'reason' => 'ok'], 'clubs' => []],
    'space-representative' => ['user' => ['role' => 'representative'], 'access' => ['allowed' => true, 'reason' => 'ok'], 'clubs' => []],
    'space-super-admin' => ['user' => ['role' => 'super_admin'], 'access' => ['allowed' => true, 'reason' => 'ok'], 'clubs' => []],
    'messages-lightbox' => ['user' => ['role' => 'member'], 'access' => ['allowed' => true, 'reason' => 'ok'], 'clubs' => []],
];
$fixture = $spaceFixtures[$qaMode] ?? $spaceFixtures['space-member'];
$fixtureUser = $fixture['user'];
if ($fixtureUser) {
    $fixtureUser = array_merge([
        'id' => 1,
        'username' => 'tester',
        'nickname' => '测试用户',
        'handle' => '@tester',
        'avatar_url' => '/image/background/Defaultwallpaper.jpg',
    ], $fixtureUser);
}

// Keep the browser contract deterministic and independent from local runtime data.
// The actual PHP endpoints are exercised by the backend contract/integration tests.
if ($requestPath === '/api/posts.php') {
    header('Content-Type: application/json; charset=utf-8');
    $action = (string)($_GET['action'] ?? '');
    if ($action === 'bootstrap') {
        echo json_encode(['success' => true, 'data' => [
            'user' => $fixtureUser,
            'clubs' => $fixture['clubs'],
            'space_access' => $fixture['access'],
            'limits' => ['content_max' => 280, 'images_max' => 4],
        ]], JSON_UNESCAPED_UNICODE);
        return true;
    }
    if (!$fixture['access']['allowed']) {
        http_response_code($fixture['access']['reason'] === 'login_required' ? 401 : 403);
        echo json_encode(['success' => false, 'error' => [
            'code' => $fixture['access']['reason'], 'message' => '空间访问被拒绝',
        ]], JSON_UNESCAPED_UNICODE);
        return true;
    }
    if ($action === 'search') {
        echo json_encode(['success' => true, 'data' => [
            'posts' => ['posts' => [], 'next_before_id' => null], 'users' => [],
        ]], JSON_UNESCAPED_UNICODE);
        return true;
    }
    echo json_encode(['success' => true, 'data' => [
        'posts' => [], 'post' => null, 'profile' => null,
        'users' => [], 'next_before_id' => null,
    ]], JSON_UNESCAPED_UNICODE);
    return true;
}
if ($requestPath === '/api/messages.php') {
    header('Content-Type: application/json; charset=utf-8');
    if ($qaMode === 'messages-lightbox') {
        $action = (string)($_GET['action'] ?? '');
        $other = [
            'id' => 2,
            'username' => 'alice',
            'nickname' => 'Alice',
            'handle' => '@alice',
            'avatar_url' => '/image/background/Defaultwallpaper.jpg',
        ];
        if ($action === 'unread_count') {
            echo json_encode(['success' => true, 'data' => ['unread' => 0]], JSON_UNESCAPED_UNICODE);
            return true;
        }
        if ($action === 'thread') {
            echo json_encode(['success' => true, 'data' => [
                'conversation_id' => 1,
                'other' => $other,
                'messages' => [[
                    'id' => 1,
                    'sender_id' => 2,
                    'created_at' => '2026-09-13 12:00:00',
                    'content' => '请查看这张图',
                    'images' => ['/image/background/Defaultwallpaper.jpg'],
                ]],
            ]], JSON_UNESCAPED_UNICODE);
            return true;
        }
        if ($action === 'list' || $action === 'friends') {
            echo json_encode(['success' => true, 'data' => ['conversations' => [], 'friends' => [$other]]], JSON_UNESCAPED_UNICODE);
            return true;
        }
    }
    echo json_encode(['success' => false, 'error' => [
        'code' => 'AUTH_REQUIRED', 'message' => '请先登录',
    ]], JSON_UNESCAPED_UNICODE);
    return true;
}
if ($requestPath === '/api/vote_projects.php') {
    header('Content-Type: application/json; charset=utf-8');
    $type = (string)($_GET['project_type'] ?? '');
    $rows = [
        [
            'id' => 101,
            'project_type' => 'moe',
            'title' => '2026 年度萌战',
            'year_label' => '2026',
            'status' => 'running',
            'updated_at' => '2026-09-14 12:00:00',
            'current_stage' => ['title' => '海选', 'status' => 'open', 'ends_at' => '2026-09-30 23:59:59'],
        ],
        [
            'id' => 102,
            'project_type' => 'twelve',
            'title' => '2026 年度视觉小说十二器',
            'year_label' => '2026',
            'status' => 'completed',
            'updated_at' => '2026-09-12 12:00:00',
            'current_stage' => null,
        ],
    ];
    if ($type !== '') $rows = array_values(array_filter($rows, static fn ($row) => $row['project_type'] === $type));
    echo json_encode(['success' => true, 'data' => $rows, 'total' => count($rows), 'limit' => 100], JSON_UNESCAPED_UNICODE);
    return true;
}
if (preg_match('#^/column(?:/(?:post|search|messages|user|my|admin)(?:/.*)?|/?)$#', $requestPath)) {
    require __DIR__ . '/../../column/index.html';
    return true;
}
return false;
