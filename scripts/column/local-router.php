<?php
declare(strict_types=1);

$requestPath = parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/';

// Keep the browser contract deterministic and independent from local runtime data.
// The actual PHP endpoints are exercised by the backend contract/integration tests.
if ($requestPath === '/api/posts.php') {
    header('Content-Type: application/json; charset=utf-8');
    $action = (string)($_GET['action'] ?? '');
    if ($action === 'bootstrap') {
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
