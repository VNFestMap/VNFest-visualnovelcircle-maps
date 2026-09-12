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
    $action = strtolower(trim((string)($_GET['action'] ?? $input['action'] ?? 'bootstrap')));
    $db = postsDb();
    $currentUser = getCurrentUser();

    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
        if ($action === 'bootstrap') {
            postsJson([
                'success' => true,
                'data' => [
                    'user' => postsUserPayload($currentUser),
                    'clubs' => $currentUser ? postsSelectableClubs((int)$currentUser['id']) : [],
                    'limits' => [
                        'content_max' => POSTS_CONTENT_MAX,
                        'images_max' => POSTS_IMAGES_MAX,
                    ],
                ],
            ]);
        }
        if ($action === 'feed') postsJson(['success' => true, 'data' => postsListFeed($_GET, $currentUser)]);
        if ($action === 'detail') {
            $id = max(0, (int)($_GET['id'] ?? 0));
            $row = postsFetchPost($id);
            $visible = $row && (string)$row['status'] === 'published' && empty($row['deleted_at']);
            $isOwner = $row && $currentUser && ((int)$row['author_id'] === (int)$currentUser['id'] || postsCanManage($currentUser));
            if (!$visible && !$isOwner) postsFail('not_found', '推文不存在或已被删除', 404);
            postsJson([
                'success' => true,
                'data' => [
                    'post' => postsSerializePost($row, $currentUser, ['include_quoted' => true, 'include_reply_to' => true]),
                    'replies' => postsListReplies($id, $currentUser),
                ],
            ]);
        }
        if ($action === 'mine') {
            $user = $currentUser ?: postsFail('login_required', '请先登录', 401);
            postsJson(['success' => true, 'data' => postsListMine($_GET, $user)]);
        }
        if ($action === 'profile') {
            $row = postsFetchUserByUsername((string)($_GET['username'] ?? ''));
            if (!$row) postsFail('not_found', '用户不存在', 404);
            postsJson(['success' => true, 'data' => [
                'user' => postsProfilePayload($row, $currentUser),
                'suggested' => postsSuggestedUsers($currentUser),
            ]]);
        }
        if ($action === 'user_timeline') {
            $row = postsFetchUserByUsername((string)($_GET['username'] ?? ''));
            if (!$row) postsFail('not_found', '用户不存在', 404);
            $tab = strtolower(trim((string)($_GET['tab'] ?? 'posts')));
            if (!in_array($tab, ['posts', 'replies'], true)) $tab = 'posts';
            postsJson(['success' => true, 'data' => postsListUserTimeline((int)$row['id'], $tab, $_GET, $currentUser)]);
        }
        if ($action === 'suggested') {
            postsJson(['success' => true, 'data' => ['users' => postsSuggestedUsers($currentUser)]]);
        }
        if ($action === 'follow_list') {
            postsJson(['success' => true, 'data' => postsFollowList($_GET, $currentUser)]);
        }
        if ($action === 'search') {
            $query = trim((string)($_GET['q'] ?? ''));
            postsJson(['success' => true, 'data' => [
                'query' => $query,
                'users' => postsSearchUsers($query, $currentUser),
                'posts' => postsSearchPosts($query, $currentUser, postsCursor($_GET)),
            ]]);
        }
        postsFail('unknown_action', '未知操作', 400);
    }

    postsRequireMethod('POST');
    postsRequireSameOrigin();
    $user = $currentUser ?: postsFail('login_required', '请先登录', 401);

    if ($action === 'create') postsJson(['success' => true, 'data' => postsCreate($input, $user)]);
    if ($action === 'delete') postsJson(['success' => true, 'data' => postsDelete($input, $user)]);
    if ($action === 'like') postsJson(['success' => true, 'data' => postsLike($input, $user)]);
    if ($action === 'unlike') postsJson(['success' => true, 'data' => postsUnlike($input, $user)]);
    if ($action === 'follow') postsJson(['success' => true, 'data' => postsFollow($input, $user)]);
    if ($action === 'unfollow') postsJson(['success' => true, 'data' => postsUnfollow($input, $user)]);
    postsFail('unknown_action', '未知操作', 400);
} catch (Throwable $e) {
    error_log('[posts] ' . $e->getMessage());
    if ($e instanceof PDOException) postsFail('database_unavailable', '数据库暂时不可用，请稍后重试', 500);
    postsFail('posts_unavailable', '动态操作失败，请稍后重试', 500);
}
