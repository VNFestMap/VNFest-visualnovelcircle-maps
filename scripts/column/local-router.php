<?php
declare(strict_types=1);

$requestPath = parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/';
$qaMode = (string)($_COOKIE['vnfest_column_qa'] ?? '');
if (isset($_GET['qa']) && (string)$_GET['qa'] === 'messages-lightbox') {
    $qaMode = 'messages-lightbox';
    setcookie('vnfest_column_qa', $qaMode, [
        'expires' => time() + 300,
        'path' => '/',
        'samesite' => 'Lax',
    ]);
}

// Keep the browser contract deterministic and independent from local runtime data.
// The actual PHP endpoints are exercised by the backend contract/integration tests.
if ($requestPath === '/api/posts.php') {
    header('Content-Type: application/json; charset=utf-8');
    $action = (string)($_GET['action'] ?? '');
    if ($action === 'bootstrap') {
        if ($qaMode === 'messages-lightbox') {
            echo json_encode(['success' => true, 'data' => [
                'user' => [
                    'id' => 1,
                    'username' => 'tester',
                    'nickname' => '测试用户',
                    'handle' => '@tester',
                    'avatar_url' => '/image/background/Defaultwallpaper.jpg',
                ],
                'clubs' => [],
                'limits' => ['content_max' => 280, 'images_max' => 4],
            ]], JSON_UNESCAPED_UNICODE);
            return true;
        }
        echo json_encode(['success' => true, 'data' => [
            'user' => null,
            'clubs' => [],
            'limits' => ['content_max' => 280, 'images_max' => 4],
        ]], JSON_UNESCAPED_UNICODE);
        return true;
    }
    if ($action === 'search') {
        echo json_encode(['success' => true, 'data' => [
            'posts' => [], 'users' => [], 'next_before_id' => null,
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
if (preg_match('#^/column/(post|search|messages|user|my|admin)(?:/|$)#', $requestPath)) {
    require __DIR__ . '/../../column/index.html';
    return true;
}
return false;
