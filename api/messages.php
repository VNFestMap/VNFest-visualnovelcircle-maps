<?php
declare(strict_types=1);

require_once __DIR__ . '/../includes/posts/helpers.php';

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

try {
    $input = postsInput();
    $action = strtolower(trim((string)($_GET['action'] ?? $input['action'] ?? 'list')));

    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
        $user = getCurrentUser() ?: postsFail('login_required', '请先登录', 401);
        if ($action === 'list') postsJson(['success' => true, 'data' => postsDmList($user)]);
        if ($action === 'thread') postsJson(['success' => true, 'data' => postsDmThread($_GET, $user)]);
        if ($action === 'friends') postsJson(['success' => true, 'data' => ['friends' => postsDmFriends($user)]]);
        if ($action === 'unread_count') postsJson(['success' => true, 'data' => ['unread' => postsDmUnreadCount($user)]]);
        postsFail('unknown_action', '未知操作', 400);
    }

    postsRequireMethod('POST');
    postsRequireSameOrigin();
    $user = getCurrentUser() ?: postsFail('login_required', '请先登录', 401);

    if ($action === 'thread') postsJson(['success' => true, 'data' => postsDmThread($input, $user)]);
    if ($action === 'send') postsJson(['success' => true, 'data' => postsDmSend($input, $user)]);
    if ($action === 'read') postsJson(['success' => true, 'data' => postsDmMarkRead($input, $user)]);
    postsFail('unknown_action', '未知操作', 400);
} catch (Throwable $e) {
    error_log('[messages] ' . $e->getMessage());
    if ($e instanceof PDOException) postsFail('database_unavailable', '数据库暂时不可用，请稍后重试', 500);
    postsFail('messages_unavailable', '私信操作失败，请稍后重试', 500);
}
