<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/../includes/forum.php';
require_once __DIR__ . '/../../includes/rate_limit.php';
require_once __DIR__ . '/../../includes/audit.php';
require_once __DIR__ . '/../../includes/notifications.php';

if (PHP_SAPI !== 'cli') {
    http_response_code(410);
    echo json_encode([
        'success' => false,
        'archived' => true,
        'message' => '论坛功能已停止；当前内容发布请进入 VNFest 专栏。',
        'column_url' => '/column/',
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$db = getDB();
$action = strtolower(trim((string)($_GET['action'] ?? 'bootstrap')));
$user = getCurrentUser();
$writeActions = [
    'create_post', 'update_post', 'delete_post',
    'create_reply', 'update_reply', 'delete_reply',
    'toggle_like', 'toggle_favorite', 'upload_image', 'delete_upload',
    'report', 'moderate',
];

if (in_array($action, $writeActions, true)) {
    forumRequireMethod('POST');
    forumRequireSameOrigin();
    $user = requireLogin();
}

try {
    switch ($action) {
        case 'bootstrap':
            $categories = $db->query(
                "SELECT id, scope, club_id, country, name, slug, sort_order
                 FROM forum_categories
                 WHERE scope='plaza' AND club_id IS NULL AND country IS NULL AND is_active=1
                 ORDER BY sort_order, id"
            )->fetchAll();
            $unread = 0;
            if ($user) {
                $stmt = $db->prepare('SELECT COUNT(*) FROM notifications WHERE user_id=? AND is_read=0');
                $stmt->execute([(int)$user['id']]);
                $unread = (int)$stmt->fetchColumn();
            }
            forumRespond(['success' => true, 'data' => [
                'user' => forumUserPublic($user),
                'categories' => $categories,
                'unread_notifications' => $unread,
                'limits' => [
                    'title' => FORUM_TITLE_MAX,
                    'body' => FORUM_BODY_MAX,
                    'images' => FORUM_IMAGE_MAX_COUNT,
                    'image_bytes' => FORUM_IMAGE_MAX_BYTES,
                    'tags' => FORUM_TAG_MAX_COUNT,
                    'tag_length' => FORUM_TAG_MAX_LENGTH,
                ],
            ]]);

        case 'list_posts':
            [$page, $limit, $offset] = forumPagination();
            if (($_GET['scope'] ?? 'plaza') !== 'plaza'
                || isset($_GET['club_id']) || isset($_GET['country'])) {
                forumFail('当前仅支持论坛广场', 422);
            }
            $params = [];
            $where = ["p.scope='plaza'", "p.status='published'", 'p.deleted_at IS NULL'];
            $categoryId = (int)($_GET['category_id'] ?? 0);
            if ($categoryId > 0) {
                $where[] = 'p.category_id=?';
                $params[] = $categoryId;
            }
            $sort = in_array((string)($_GET['sort'] ?? 'latest'), ['latest', 'hot', 'essence'], true)
                ? (string)($_GET['sort'] ?? 'latest') : 'latest';
            if ($sort === 'essence') $where[] = 'p.is_essence=1';
            if ($sort === 'hot') {
                $where[] = 'p.created_at>=?';
                $params[] = date('Y-m-d H:i:s', time() - 30 * 86400);
            }
            $keyword = forumString($_GET['q'] ?? '', 100, false);
            if ($keyword !== '') {
                $like = '%' . $keyword . '%';
                $driver = (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME);
                $fts5 = $driver === 'sqlite' && (bool)$db->query(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='forum_posts_fts'"
                )->fetchColumn();
                if ($driver === 'mysql') {
                    $where[] = "(MATCH(p.title,p.body_md) AGAINST(? IN BOOLEAN MODE)
                        OR EXISTS(SELECT 1 FROM forum_replies sr WHERE sr.post_id=p.id AND sr.status='published'
                            AND sr.deleted_at IS NULL AND MATCH(sr.body_md) AGAINST(? IN BOOLEAN MODE)))";
                    $params[] = $keyword;
                    $params[] = $keyword;
                } elseif ($fts5) {
                    $phrase = '"' . str_replace('"', '""', $keyword) . '"';
                    $where[] = "(p.id IN (SELECT rowid FROM forum_posts_fts WHERE forum_posts_fts MATCH ?)
                        OR EXISTS(SELECT 1 FROM forum_replies sr WHERE sr.post_id=p.id AND sr.status='published'
                            AND sr.deleted_at IS NULL AND sr.id IN (
                                SELECT rowid FROM forum_replies_fts WHERE forum_replies_fts MATCH ?)))";
                    $params[] = $phrase;
                    $params[] = $phrase;
                } else {
                    $where[] = "(p.title LIKE ? OR p.body_md LIKE ?
                        OR EXISTS(SELECT 1 FROM forum_replies sr WHERE sr.post_id=p.id AND sr.status='published'
                            AND sr.deleted_at IS NULL AND sr.body_md LIKE ?))";
                    array_push($params, $like, $like, $like);
                }
            }
            $whereSql = implode(' AND ', $where);
            $count = $db->prepare("SELECT COUNT(*) FROM forum_posts p WHERE {$whereSql}");
            $count->execute($params);
            $total = (int)$count->fetchColumn();
            $order = $sort === 'hot'
                ? '(p.reply_count*5+p.like_count*3+p.view_count*0.02) DESC,p.last_activity_at DESC,p.id DESC'
                : 'p.is_pinned DESC,p.last_activity_at DESC,p.id DESC';
            $sql = "SELECT p.*,c.name AS category_name,c.slug AS category_slug,
                           u.username,u.nickname,u.avatar_url,u.role AS author_role," . FORUM_DISPLAY_CLUB_SELECT . ",
                           lr.author_id AS last_reply_author_id,lru.username AS last_reply_username,
                           lru.nickname AS last_reply_nickname
                    FROM forum_posts p
                    JOIN users u ON u.id=p.author_id
                    " . FORUM_DISPLAY_CLUB_JOIN . "
                    LEFT JOIN forum_categories c ON c.id=p.category_id
                    LEFT JOIN forum_replies lr ON lr.id=(
                        SELECT lr2.id FROM forum_replies lr2
                        WHERE lr2.post_id=p.id AND lr2.status='published' AND lr2.deleted_at IS NULL
                        ORDER BY lr2.created_at DESC,lr2.id DESC LIMIT 1)
                    LEFT JOIN users lru ON lru.id=lr.author_id
                    WHERE {$whereSql} ORDER BY {$order} LIMIT ? OFFSET ?";
            $stmt = $db->prepare($sql);
            $index = 1;
            foreach ($params as $param) $stmt->bindValue($index++, $param);
            $stmt->bindValue($index++, $limit, PDO::PARAM_INT);
            $stmt->bindValue($index, $offset, PDO::PARAM_INT);
            $stmt->execute();
            $rows = $stmt->fetchAll();
            $postIds = array_column($rows, 'id');
            $tagMap = forumTagsForPosts($postIds);
            $previewMap = forumPreviewImagesForPosts($postIds);
            $items = array_map(static function (array $row) use ($user, $keyword, $tagMap, $previewMap): array {
                $postId = (int)$row['id'];
                return forumSerializePostListItem(
                    $row,
                    $user,
                    $tagMap[$postId] ?? [],
                    $previewMap[$postId] ?? null,
                    $keyword !== ''
                );
            }, $rows);
            forumRespond(['success' => true, 'data' => [
                'items' => $items,
                'pagination' => [
                    'page' => $page,
                    'limit' => $limit,
                    'total' => $total,
                    'total_pages' => max(1, (int)ceil($total / $limit)),
                ],
            ]]);

        case 'get_post':
            $id = (int)($_GET['id'] ?? 0);
            $post = forumGetPost($id);
            if (!$post) forumFail('帖子不存在', 404);
            if (!forumPostAccess($post, $user)) forumFail('帖子不存在', 404);
            $db->prepare('UPDATE forum_posts SET view_count=view_count+1 WHERE id=?')->execute([$id]);
            $post['view_count'] = (int)$post['view_count'] + 1;
            $tagMap = forumTagsForPosts([$id]);
            $data = forumSerializePost($post, $user, $tagMap[$id] ?? []);
            $data['liked'] = false;
            $data['favorited'] = false;
            if ($user) {
                $stmt = $db->prepare("SELECT 1 FROM forum_reactions WHERE user_id=? AND target_type='post' AND target_id=? AND reaction_type='like'");
                $stmt->execute([(int)$user['id'], $id]);
                $data['liked'] = (bool)$stmt->fetchColumn();
                $stmt = $db->prepare('SELECT 1 FROM forum_favorites WHERE user_id=? AND post_id=?');
                $stmt->execute([(int)$user['id'], $id]);
                $data['favorited'] = (bool)$stmt->fetchColumn();
            }
            $stmt = $db->prepare(
                "SELECT id,relative_path,mime_type,width,height,file_size,original_name
                 FROM forum_attachments WHERE target_type='post' AND target_id=? ORDER BY id"
            );
            $stmt->execute([$id]);
            $data['attachments'] = $stmt->fetchAll();
            forumRespond(['success' => true, 'data' => $data]);

        case 'list_replies':
            [$page, $limit, $offset] = forumPagination();
            $postId = (int)($_GET['post_id'] ?? 0);
            $post = forumGetPost($postId);
            if (!$post) forumFail('帖子不存在', 404);
            if (!forumPostAccess($post, $user)) forumFail('帖子不存在', 404);
            $sort = ($_GET['sort'] ?? 'time') === 'hot' ? 'hot' : 'time';
            $stmt = $db->prepare("SELECT COUNT(*) FROM forum_replies WHERE post_id=? AND status='published' AND deleted_at IS NULL");
            $stmt->execute([$postId]);
            $total = (int)$stmt->fetchColumn();
            $anchorId = max(0, (int)($_GET['anchor_id'] ?? 0));
            if ($anchorId > 0 && $sort === 'time') {
                $anchorPage = forumReplyPageForAnchor($postId, $anchorId, $limit);
                if ($anchorPage !== null) {
                    $page = $anchorPage;
                    $offset = ($page - 1) * $limit;
                }
            }
            $order = $sort === 'hot' ? 'r.like_count DESC,r.created_at ASC,r.id ASC' : 'r.created_at ASC,r.id ASC';
            $stmt = $db->prepare(
                "SELECT r.*,u.username,u.nickname,u.avatar_url,u.role AS author_role," . FORUM_DISPLAY_CLUB_SELECT . ",
                        (SELECT COUNT(*) FROM forum_replies floor_reply
                         WHERE floor_reply.post_id=r.post_id
                           AND (floor_reply.created_at < r.created_at
                             OR (floor_reply.created_at = r.created_at AND floor_reply.id <= r.id))) AS floor_number,
                        pr.id AS parent_visible_id,pr.body_md AS parent_body_md,
                        pu.username AS parent_username,pu.nickname AS parent_nickname
                 FROM forum_replies r
                 JOIN users u ON u.id=r.author_id
                 " . FORUM_DISPLAY_CLUB_JOIN . "
                 LEFT JOIN forum_replies pr ON pr.id=r.parent_reply_id AND pr.post_id=r.post_id
                    AND pr.status='published' AND pr.deleted_at IS NULL
                 LEFT JOIN users pu ON pu.id=pr.author_id
                 WHERE r.post_id=? AND r.status='published' AND r.deleted_at IS NULL
                 ORDER BY {$order} LIMIT ? OFFSET ?"
            );
            $stmt->bindValue(1, $postId, PDO::PARAM_INT);
            $stmt->bindValue(2, $limit, PDO::PARAM_INT);
            $stmt->bindValue(3, $offset, PDO::PARAM_INT);
            $stmt->execute();
            $rows = $stmt->fetchAll();
            $likedReplyIds = [];
            if ($user && $rows) {
                $replyIds = array_map(static fn(array $row): int => (int)$row['id'], $rows);
                $placeholders = implode(',', array_fill(0, count($replyIds), '?'));
                $likeStmt = $db->prepare(
                    "SELECT target_id FROM forum_reactions
                     WHERE user_id=? AND target_type='reply' AND reaction_type='like'
                       AND target_id IN ({$placeholders})"
                );
                $likeStmt->execute(array_merge([(int)$user['id']], $replyIds));
                $likedReplyIds = array_fill_keys(array_map('intval', $likeStmt->fetchAll(PDO::FETCH_COLUMN)), true);
            }
            $items = [];
            foreach ($rows as $row) {
                $own = $user && (int)$row['author_id'] === (int)$user['id'];
                $manage = $user && ($user['role'] ?? '') === 'super_admin';
                $items[] = [
                    'id' => (int)$row['id'],
                    'post_id' => $postId,
                    'floor' => (int)$row['floor_number'],
                    'body_md' => (string)$row['body_md'],
                    'like_count' => (int)$row['like_count'],
                    'liked' => isset($likedReplyIds[(int)$row['id']]),
                    'edited_at' => $row['edited_at'] ?: null,
                    'created_at' => (string)$row['created_at'],
                    'author' => [
                        'id' => (int)$row['author_id'],
                        'username' => (string)$row['username'],
                        'nickname' => (string)($row['nickname'] ?: $row['username']),
                        'avatar_url' => (string)($row['avatar_url'] ?? ''),
                        'role' => (string)$row['author_role'],
                        'display_club' => forumDisplayClubFromRow($row),
                    ],
                    'parent' => $row['parent_visible_id'] ? [
                        'id' => (int)$row['parent_reply_id'],
                        'username' => (string)(($row['parent_nickname'] ?? '') ?: ($row['parent_username'] ?? '')),
                        'excerpt' => forumMarkdownExcerpt((string)($row['parent_body_md'] ?? ''), 280),
                    ] : null,
                    'capabilities' => [
                        'edit' => (bool)$own,
                        'delete' => (bool)($own || $manage),
                        'like' => (bool)$user,
                        'report' => (bool)$user && !$own,
                    ],
                ];
            }
            forumRespond(['success' => true, 'data' => [
                'items' => $items,
                'pagination' => [
                    'page' => $page,
                    'limit' => $limit,
                    'total' => $total,
                    'total_pages' => max(1, (int)ceil($total / $limit)),
                ],
            ]]);

        case 'list_categories':
            if (($_GET['scope'] ?? 'plaza') !== 'plaza'
                || isset($_GET['club_id']) || isset($_GET['country'])) {
                forumFail('当前仅支持论坛广场', 422);
            }
            $stmt = $db->query(
                "SELECT id,scope,club_id,country,name,slug,sort_order
                 FROM forum_categories
                 WHERE scope='plaza' AND club_id IS NULL AND country IS NULL AND is_active=1
                 ORDER BY sort_order,id"
            );
            forumRespond(['success' => true, 'data' => ['items' => $stmt->fetchAll()]]);

        case 'list_mine':
            $user = requireLogin();
            [$page, $limit, $offset] = forumPagination();
            $type = in_array((string)($_GET['type'] ?? 'posts'), ['posts', 'replies', 'favorites'], true)
                ? (string)($_GET['type'] ?? 'posts') : 'posts';
            $accessSql = " AND p.scope='plaza'";
            $accessParams = [];
            if ($type === 'replies') {
                $base = "FROM forum_replies r JOIN forum_posts p ON p.id=r.post_id JOIN users u ON u.id=r.author_id
                         WHERE r.author_id=? AND r.status='published' AND r.deleted_at IS NULL
                         AND p.status='published' AND p.deleted_at IS NULL{$accessSql}";
                $count = $db->prepare("SELECT COUNT(*) {$base}");
                $count->execute(array_merge([(int)$user['id']], $accessParams));
                $total = (int)$count->fetchColumn();
                $stmt = $db->prepare("SELECT r.id,r.post_id,r.body_md,r.like_count,r.created_at,p.title AS post_title {$base}
                                      ORDER BY r.created_at DESC LIMIT ? OFFSET ?");
                $bind = array_merge([(int)$user['id']], $accessParams);
                $index = 1;
                foreach ($bind as $param) $stmt->bindValue($index++, $param, PDO::PARAM_INT);
                $stmt->bindValue($index++, $limit, PDO::PARAM_INT);
                $stmt->bindValue($index, $offset, PDO::PARAM_INT);
                $stmt->execute();
                $items = $stmt->fetchAll();
            } else {
                if ($type === 'favorites') {
                    $base = "FROM forum_favorites f JOIN forum_posts p ON p.id=f.post_id
                             JOIN users u ON u.id=p.author_id " . FORUM_DISPLAY_CLUB_JOIN . " LEFT JOIN forum_categories c ON c.id=p.category_id
                             LEFT JOIN forum_replies lr ON lr.id=(
                                 SELECT lr2.id FROM forum_replies lr2
                                 WHERE lr2.post_id=p.id AND lr2.status='published' AND lr2.deleted_at IS NULL
                                 ORDER BY lr2.created_at DESC,lr2.id DESC LIMIT 1)
                             LEFT JOIN users lru ON lru.id=lr.author_id
                             WHERE f.user_id=? AND p.status='published' AND p.deleted_at IS NULL{$accessSql}";
                    $order = 'f.created_at DESC';
                } else {
                    $base = "FROM forum_posts p JOIN users u ON u.id=p.author_id " . FORUM_DISPLAY_CLUB_JOIN . "
                             LEFT JOIN forum_categories c ON c.id=p.category_id
                             LEFT JOIN forum_replies lr ON lr.id=(
                                 SELECT lr2.id FROM forum_replies lr2
                                 WHERE lr2.post_id=p.id AND lr2.status='published' AND lr2.deleted_at IS NULL
                                 ORDER BY lr2.created_at DESC,lr2.id DESC LIMIT 1)
                             LEFT JOIN users lru ON lru.id=lr.author_id
                             WHERE p.author_id=? AND p.status='published' AND p.deleted_at IS NULL{$accessSql}";
                    $order = 'p.created_at DESC';
                }
                $count = $db->prepare("SELECT COUNT(*) {$base}");
                $count->execute(array_merge([(int)$user['id']], $accessParams));
                $total = (int)$count->fetchColumn();
                $stmt = $db->prepare(
                    "SELECT p.*,c.name AS category_name,c.slug AS category_slug,
                            u.username,u.nickname,u.avatar_url,u.role AS author_role," . FORUM_DISPLAY_CLUB_SELECT . ",
                            lr.author_id AS last_reply_author_id,lru.username AS last_reply_username,
                            lru.nickname AS last_reply_nickname
                     {$base} ORDER BY {$order} LIMIT ? OFFSET ?"
                );
                $bind = array_merge([(int)$user['id']], $accessParams);
                $index = 1;
                foreach ($bind as $param) $stmt->bindValue($index++, $param, PDO::PARAM_INT);
                $stmt->bindValue($index++, $limit, PDO::PARAM_INT);
                $stmt->bindValue($index, $offset, PDO::PARAM_INT);
                $stmt->execute();
                $rows = $stmt->fetchAll();
                $postIds = array_column($rows, 'id');
                $tagMap = forumTagsForPosts($postIds);
                $previewMap = forumPreviewImagesForPosts($postIds);
                $items = array_map(static function (array $row) use ($user, $tagMap, $previewMap): array {
                    $postId = (int)$row['id'];
                    return forumSerializePostListItem(
                        $row,
                        $user,
                        $tagMap[$postId] ?? [],
                        $previewMap[$postId] ?? null
                    );
                }, $rows);
            }
            forumRespond(['success' => true, 'data' => [
                'items' => $items,
                'pagination' => [
                    'page' => $page,
                    'limit' => $limit,
                    'total' => $total,
                    'total_pages' => max(1, (int)ceil($total / $limit)),
                ],
            ]]);

        case 'moderation_queue':
            $user = requireLogin();
            [$page, $limit, $offset] = forumPagination();
            $status = in_array((string)($_GET['status'] ?? 'pending'), ['pending', 'resolved', 'dismissed'], true)
                ? (string)($_GET['status'] ?? 'pending') : 'pending';
            if (($user['role'] ?? '') !== 'super_admin') forumFail('权限不足', 403);
            $params = [$status];
            $filter = "r.status=? AND EXISTS(
                SELECT 1 FROM forum_posts p
                WHERE p.scope='plaza' AND (
                    (r.target_type='post' AND p.id=r.target_id)
                    OR (r.target_type='reply' AND p.id=(SELECT post_id FROM forum_replies WHERE id=r.target_id))
                ))";
            $count = $db->prepare("SELECT COUNT(*) FROM forum_reports r WHERE {$filter}");
            $count->execute($params);
            $total = (int)$count->fetchColumn();
            $stmt = $db->prepare(
                "SELECT r.*,u.username,u.nickname FROM forum_reports r
                 JOIN users u ON u.id=r.reporter_id
                 WHERE {$filter} ORDER BY r.created_at DESC LIMIT ? OFFSET ?"
            );
            $index = 1;
            foreach ($params as $param) $stmt->bindValue($index++, $param);
            $stmt->bindValue($index++, $limit, PDO::PARAM_INT);
            $stmt->bindValue($index, $offset, PDO::PARAM_INT);
            $stmt->execute();
            forumRespond(['success' => true, 'data' => [
                'items' => $stmt->fetchAll(),
                'pagination' => [
                    'page' => $page,
                    'limit' => $limit,
                    'total' => $total,
                    'total_pages' => max(1, (int)ceil($total / $limit)),
                ],
            ]]);

        case 'create_post':
            checkRateLimit('forum:create_post', 8, 10);
            $input = forumInput();
            $title = forumString($input['title'] ?? '', FORUM_TITLE_MAX);
            $body = forumString($input['body_md'] ?? '', FORUM_BODY_MAX);
            $token = forumString($input['upload_token'] ?? '', 64, false);
            $tags = forumNormalizeTags($input['tags'] ?? []);
            if (($input['scope'] ?? 'plaza') !== 'plaza'
                || trim((string)($input['club_id'] ?? '')) !== ''
                || trim((string)($input['country'] ?? '')) !== '') {
                forumFail('当前仅支持论坛广场', 422);
            }
            $categoryId = (int)($input['category_id'] ?? 0);
            $categoryId = forumValidateCategory($categoryId ?: null);
            if (!$categoryId) forumFail('请选择分类', 422);
            forumValidateMarkdownImages($body, (int)$user['id'], $token);
            $db->beginTransaction();
            $stmt = $db->prepare(
                'INSERT INTO forum_posts(author_id,scope,club_id,country,category_id,title,body_md) VALUES(?,?,?,?,?,?,?)'
            );
            $stmt->execute([(int)$user['id'], 'plaza', null, null, $categoryId, $title, $body]);
            $id = (int)$db->lastInsertId();
            forumSyncPostTags($id, $tags);
            forumBindAttachments((int)$user['id'], $token, 'post', $id, $body);
            forumNotifyMentions($body, (int)$user['id'], forumPostLink($id), 'forum_post', $id);
            $db->commit();
            forumRespond(['success' => true, 'message' => '帖子已发布', 'data' => ['id' => $id]], 201);

        case 'update_post':
            checkRateLimit('forum:update_post', 20, 10);
            $input = forumInput();
            $id = (int)($input['id'] ?? 0);
            $post = forumGetPost($id, true);
            if (!$post || !forumPostAccess($post, $user)) forumFail('帖子不存在', 404);
            if ((int)$post['author_id'] !== (int)$user['id']) forumFail('只能编辑自己的帖子', 403);
            if ((string)$post['status'] !== 'published' || !empty($post['deleted_at'])) forumFail('当前帖子不能编辑', 409);
            $title = forumString($input['title'] ?? '', FORUM_TITLE_MAX);
            $body = forumString($input['body_md'] ?? '', FORUM_BODY_MAX);
            $token = forumString($input['upload_token'] ?? '', 64, false);
            $tags = forumNormalizeTags($input['tags'] ?? []);
            $categoryId = (int)($input['category_id'] ?? 0);
            $categoryId = forumValidateCategory($categoryId ?: null);
            if (!$categoryId) forumFail('请选择分类', 422);
            forumValidateMarkdownImages($body, (int)$user['id'], $token, 'post', $id);
            $db->beginTransaction();
            forumCreateRevision('post', $post, (int)$user['id']);
            $db->prepare(
                'UPDATE forum_posts SET title=?,body_md=?,category_id=?,edited_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?'
            )->execute([$title, $body, $categoryId, $id]);
            forumSyncPostTags($id, $tags);
            forumBindAttachments((int)$user['id'], $token, 'post', $id, $body);
            forumNotifyMentions($body, (int)$user['id'], forumPostLink($id), 'forum_post', $id);
            $db->commit();
            forumRespond(['success' => true, 'message' => '帖子已更新', 'data' => ['id' => $id]]);

        case 'delete_post':
            $input = forumInput();
            $id = (int)($input['id'] ?? 0);
            $post = forumGetPost($id, true);
            if (!$post || !forumPostAccess($post, $user)) forumFail('帖子不存在', 404);
            $canDelete = (int)$post['author_id'] === (int)$user['id'] || ($user['role'] ?? '') === 'super_admin';
            if (!$canDelete) forumFail('权限不足', 403);
            $db->beginTransaction();
            forumCreateRevision('post', $post, (int)$user['id']);
            $db->prepare("UPDATE forum_posts SET status='deleted',deleted_at=CURRENT_TIMESTAMP WHERE id=?")->execute([$id]);
            logAction('forum_post_delete', 'forum_post', $id, ['scope' => $post['scope']]);
            $db->commit();
            forumRespond(['success' => true, 'message' => '帖子已删除']);

        case 'create_reply':
            checkRateLimit('forum:create_reply', 20, 10);
            $input = forumInput();
            $postId = (int)($input['post_id'] ?? 0);
            $post = forumGetPost($postId);
            if (!$post) forumFail('帖子不存在', 404);
            if (!forumPostAccess($post, $user)) forumFail('帖子不存在', 404);
            $body = forumString($input['body_md'] ?? '', FORUM_BODY_MAX);
            $parentId = (int)($input['parent_reply_id'] ?? 0);
            $parentId = $parentId > 0 ? $parentId : null;
            $token = forumString($input['upload_token'] ?? '', 64, false);
            forumValidateMarkdownImages($body, (int)$user['id'], $token);
            $parent = null;
            if ($parentId) {
                $parent = forumGetReply($parentId);
                if (!$parent || (int)$parent['post_id'] !== $postId) forumFail('引用回复不存在', 422);
            }
            $db->beginTransaction();
            $stmt = $db->prepare('INSERT INTO forum_replies(post_id,author_id,parent_reply_id,body_md) VALUES(?,?,?,?)');
            $stmt->execute([$postId, (int)$user['id'], $parentId, $body]);
            $id = (int)$db->lastInsertId();
            forumBindAttachments((int)$user['id'], $token, 'reply', $id, $body);
            $db->prepare(
                "UPDATE forum_posts SET reply_count=(SELECT COUNT(*) FROM forum_replies WHERE post_id=? AND status='published' AND deleted_at IS NULL),last_activity_at=CURRENT_TIMESTAMP WHERE id=?"
            )->execute([$postId, $postId]);
            if ((int)$post['author_id'] !== (int)$user['id']) {
                createNotification((int)$post['author_id'], 'forum_reply', '你的帖子收到新回复', (string)$post['title'], forumReplyLink($postId, $id), 'forum_reply', $id);
            }
            if ($parent && (int)$parent['author_id'] !== (int)$user['id'] && (int)$parent['author_id'] !== (int)$post['author_id']) {
                createNotification((int)$parent['author_id'], 'forum_reply', '你的回复收到引用', '点击查看回复', forumReplyLink($postId, $id), 'forum_reply', $id);
            }
            forumNotifyMentions($body, (int)$user['id'], forumReplyLink($postId, $id), 'forum_reply', $id);
            $db->commit();
            forumRespond(['success' => true, 'message' => '回复已发布', 'data' => ['id' => $id, 'anchor_id' => $id]], 201);

        case 'update_reply':
            checkRateLimit('forum:update_reply', 30, 10);
            $input = forumInput();
            $id = (int)($input['id'] ?? 0);
            $reply = forumGetReply($id, true);
            if (!$reply || !forumPostAccess($reply, $user)) forumFail('回复不存在', 404);
            if ((int)$reply['author_id'] !== (int)$user['id']) forumFail('只能编辑自己的回复', 403);
            if ((string)$reply['status'] !== 'published' || !empty($reply['deleted_at'])) forumFail('当前回复不能编辑', 409);
            $body = forumString($input['body_md'] ?? '', FORUM_BODY_MAX);
            $token = forumString($input['upload_token'] ?? '', 64, false);
            forumValidateMarkdownImages($body, (int)$user['id'], $token, 'reply', $id);
            $db->beginTransaction();
            forumCreateRevision('reply', $reply, (int)$user['id']);
            $db->prepare('UPDATE forum_replies SET body_md=?,edited_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?')->execute([$body, $id]);
            forumBindAttachments((int)$user['id'], $token, 'reply', $id, $body);
            forumNotifyMentions($body, (int)$user['id'], forumReplyLink((int)$reply['post_id'], $id), 'forum_reply', $id);
            $db->commit();
            forumRespond(['success' => true, 'message' => '回复已更新']);

        case 'delete_reply':
            $input = forumInput();
            $id = (int)($input['id'] ?? 0);
            $reply = forumGetReply($id, true);
            if (!$reply || !forumPostAccess($reply, $user)) forumFail('回复不存在', 404);
            $canDelete = (int)$reply['author_id'] === (int)$user['id'] || ($user['role'] ?? '') === 'super_admin';
            if (!$canDelete) forumFail('权限不足', 403);
            $db->beginTransaction();
            forumCreateRevision('reply', $reply, (int)$user['id']);
            $db->prepare("UPDATE forum_replies SET status='deleted',deleted_at=CURRENT_TIMESTAMP WHERE id=?")->execute([$id]);
            $db->prepare(
                "UPDATE forum_posts SET reply_count=(SELECT COUNT(*) FROM forum_replies WHERE post_id=? AND status='published' AND deleted_at IS NULL) WHERE id=?"
            )->execute([(int)$reply['post_id'], (int)$reply['post_id']]);
            logAction('forum_reply_delete', 'forum_reply', $id);
            $db->commit();
            forumRespond(['success' => true, 'message' => '回复已删除']);

        case 'toggle_like':
            checkRateLimit('forum:like', 120, 10);
            $input = forumInput();
            $type = ($input['target_type'] ?? 'post') === 'reply' ? 'reply' : 'post';
            $id = (int)($input['target_id'] ?? 0);
            $target = $type === 'post' ? forumGetPost($id) : forumGetReply($id);
            if (!$target) forumFail('内容不存在', 404);
            $post = $type === 'post' ? $target : forumGetPost((int)$target['post_id']);
            if (!$post || !forumPostAccess($post, $user)) forumFail('内容不存在', 404);
            $hasDesiredState = array_key_exists('active', $input);
            $desiredState = $hasDesiredState
                ? filter_var($input['active'], FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE)
                : null;
            if ($hasDesiredState && $desiredState === null) forumFail('无效的点赞状态', 422);
            $db->beginTransaction();
            $created = false;
            if ($hasDesiredState && $desiredState === false) {
                $db->prepare(
                    "DELETE FROM forum_reactions
                     WHERE user_id=? AND target_type=? AND target_id=? AND reaction_type='like'"
                )->execute([(int)$user['id'], $type, $id]);
                $active = false;
            } else {
                $stmt = $db->prepare("SELECT id FROM forum_reactions WHERE user_id=? AND target_type=? AND target_id=? AND reaction_type='like'");
                $stmt->execute([(int)$user['id'], $type, $id]);
                $existing = (int)($stmt->fetchColumn() ?: 0);
                if (!$hasDesiredState && $existing) {
                    $db->prepare('DELETE FROM forum_reactions WHERE id=?')->execute([$existing]);
                    $active = false;
                } else {
                    $driver = (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME);
                    $insert = $driver === 'sqlite'
                        ? "INSERT OR IGNORE INTO forum_reactions(user_id,target_type,target_id,reaction_type) VALUES(?,?,?,'like')"
                        : "INSERT IGNORE INTO forum_reactions(user_id,target_type,target_id,reaction_type) VALUES(?,?,?,'like')";
                    $insertStmt = $db->prepare($insert);
                    $insertStmt->execute([(int)$user['id'], $type, $id]);
                    $created = $insertStmt->rowCount() > 0;
                    $active = true;
                }
                if ($created && (int)$target['author_id'] !== (int)$user['id']) {
                    $likeLink = $type === 'reply'
                        ? forumReplyLink((int)$post['id'], $id)
                        : forumPostLink((int)$post['id']);
                    createNotification((int)$target['author_id'], 'forum_like', '你的论坛内容收到点赞', '点击查看内容', $likeLink, 'forum_' . $type, $id);
                }
            }
            forumRecount($type, $id);
            $table = $type === 'post' ? 'forum_posts' : 'forum_replies';
            $stmt = $db->prepare("SELECT like_count FROM {$table} WHERE id=?");
            $stmt->execute([$id]);
            $likeCount = (int)$stmt->fetchColumn();
            $db->commit();
            forumRespond(['success' => true, 'data' => ['active' => $active, 'like_count' => $likeCount]]);

        case 'toggle_favorite':
            checkRateLimit('forum:favorite', 120, 10);
            $input = forumInput();
            $postId = (int)($input['post_id'] ?? 0);
            $post = forumGetPost($postId);
            if (!$post) forumFail('帖子不存在', 404);
            if (!forumPostAccess($post, $user)) forumFail('帖子不存在', 404);
            $hasDesiredState = array_key_exists('active', $input);
            $desiredState = $hasDesiredState
                ? filter_var($input['active'], FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE)
                : null;
            if ($hasDesiredState && $desiredState === null) forumFail('无效的收藏状态', 422);
            $db->beginTransaction();
            if ($hasDesiredState && $desiredState === false) {
                $db->prepare('DELETE FROM forum_favorites WHERE user_id=? AND post_id=?')
                    ->execute([(int)$user['id'], $postId]);
                $active = false;
            } else {
                $stmt = $db->prepare('SELECT id FROM forum_favorites WHERE user_id=? AND post_id=?');
                $stmt->execute([(int)$user['id'], $postId]);
                $existing = (int)($stmt->fetchColumn() ?: 0);
                if (!$hasDesiredState && $existing) {
                    $db->prepare('DELETE FROM forum_favorites WHERE id=?')->execute([$existing]);
                    $active = false;
                } else {
                    $driver = (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME);
                    $insert = $driver === 'sqlite'
                        ? 'INSERT OR IGNORE INTO forum_favorites(user_id,post_id) VALUES(?,?)'
                        : 'INSERT IGNORE INTO forum_favorites(user_id,post_id) VALUES(?,?)';
                    $db->prepare($insert)->execute([(int)$user['id'], $postId]);
                    $active = true;
                }
            }
            $db->prepare('UPDATE forum_posts SET favorite_count=(SELECT COUNT(*) FROM forum_favorites WHERE post_id=?) WHERE id=?')->execute([$postId, $postId]);
            $stmt = $db->prepare('SELECT favorite_count FROM forum_posts WHERE id=?');
            $stmt->execute([$postId]);
            $favoriteCount = (int)$stmt->fetchColumn();
            $db->commit();
            forumRespond(['success' => true, 'data' => ['active' => $active, 'favorite_count' => $favoriteCount]]);

        case 'upload_image':
            checkRateLimit('forum:upload', 40, 10);
            if (empty($_FILES['image']) || !is_array($_FILES['image'])) forumFail('请选择图片', 422);
            $file = $_FILES['image'];
            if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) forumFail('图片上传失败', 422);
            if ((int)$file['size'] <= 0 || (int)$file['size'] > FORUM_IMAGE_MAX_BYTES) forumFail('单张图片不能超过 10MB', 422);
            $token = forumString($_POST['upload_token'] ?? '', 64);
            if (!preg_match('/^[a-zA-Z0-9_-]{12,64}$/', $token)) forumFail('无效的上传令牌', 422);
            $count = $db->prepare('SELECT COUNT(*) FROM forum_attachments WHERE uploader_id=? AND upload_token=? AND target_id IS NULL');
            $count->execute([(int)$user['id'], $token]);
            if ((int)$count->fetchColumn() >= FORUM_IMAGE_MAX_COUNT) forumFail('每篇内容最多 20 张图片', 422);
            $dimensions = @getimagesize((string)$file['tmp_name']);
            if (!$dimensions) forumFail('文件不是有效图片', 422);
            $mime = class_exists('finfo')
                ? (string)(new finfo(FILEINFO_MIME_TYPE))->file((string)$file['tmp_name'])
                : (string)($dimensions['mime'] ?? '');
            $allowed = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp'];
            if (!isset($allowed[$mime])) forumFail('仅支持 JPEG、PNG、GIF、WebP', 422);
            $relative = 'uploads/' . date('Y/m') . '/' . bin2hex(random_bytes(20)) . '.' . $allowed[$mime];
            $absolute = dirname(__DIR__) . '/' . $relative;
            $directory = dirname($absolute);
            if (!is_dir($directory) && !mkdir($directory, 0755, true) && !is_dir($directory)) {
                forumFail('无法创建上传目录', 500);
            }
            if (!move_uploaded_file((string)$file['tmp_name'], $absolute)) forumFail('无法保存图片', 500);
            try {
                $stmt = $db->prepare(
                    'INSERT INTO forum_attachments(uploader_id,upload_token,relative_path,mime_type,width,height,file_size,original_name) VALUES(?,?,?,?,?,?,?,?)'
                );
                $stmt->execute([
                    (int)$user['id'], $token, $relative, $mime,
                    (int)$dimensions[0], (int)$dimensions[1], (int)$file['size'], basename((string)$file['name']),
                ]);
                $attachmentId = (int)$db->lastInsertId();
            } catch (Throwable $error) {
                @unlink($absolute);
                throw $error;
            }
            forumRespond(['success' => true, 'message' => '图片已上传', 'data' => [
                'id' => $attachmentId,
                'path' => $relative,
                'url' => './' . $relative,
                'mime_type' => $mime,
                'width' => (int)$dimensions[0],
                'height' => (int)$dimensions[1],
                'file_size' => (int)$file['size'],
                'original_name' => basename((string)$file['name']),
            ]], 201);

        case 'delete_upload':
            $input = forumInput();
            $attachmentId = (int)($input['attachment_id'] ?? 0);
            $stmt = $db->prepare('SELECT id,relative_path FROM forum_attachments WHERE id=? AND uploader_id=? AND target_id IS NULL LIMIT 1');
            $stmt->execute([$attachmentId, (int)$user['id']]);
            $attachment = $stmt->fetch();
            if (!$attachment) forumFail('待上传图片不存在或已经绑定', 404);
            $absolute = dirname(__DIR__) . '/' . (string)$attachment['relative_path'];
            $uploadRoot = realpath(dirname(__DIR__) . '/uploads');
            $parent = realpath(dirname($absolute));
            if (!$uploadRoot || !$parent || !str_starts_with($parent, $uploadRoot)) forumFail('附件路径无效', 500);
            $db->prepare('DELETE FROM forum_attachments WHERE id=?')->execute([$attachmentId]);
            if (is_file($absolute)) @unlink($absolute);
            forumRespond(['success' => true, 'message' => '图片已移除']);

        case 'report':
            checkRateLimit('forum:report', 12, 60);
            $input = forumInput();
            $type = ($input['target_type'] ?? 'post') === 'reply' ? 'reply' : 'post';
            $id = (int)($input['target_id'] ?? 0);
            $reason = (string)($input['reason'] ?? '');
            $reasons = ['spam', 'harassment', 'illegal', 'copyright', 'privacy', 'other'];
            if (!in_array($reason, $reasons, true)) forumFail('无效的举报理由', 422);
            $details = forumString($input['details'] ?? '', 1000, false);
            if ($reason === 'other' && $details === '') forumFail('选择“其他”时请补充说明', 422);
            $target = $type === 'post' ? forumGetPost($id) : forumGetReply($id);
            if (!$target) forumFail('内容不存在', 404);
            $post = $type === 'post' ? $target : forumGetPost((int)$target['post_id']);
            if (!$post || !forumPostAccess($post, $user)) forumFail('内容不存在', 404);
            if ((int)$target['author_id'] === (int)$user['id']) forumFail('不能举报自己的内容', 422);
            $duplicate = $db->prepare("SELECT id FROM forum_reports WHERE reporter_id=? AND target_type=? AND target_id=? AND status='pending'");
            $duplicate->execute([(int)$user['id'], $type, $id]);
            if ($duplicate->fetchColumn()) forumFail('你已经举报过该内容，正在处理中', 409);
            $snapshot = json_encode([
                'title' => $target['title'] ?? null,
                'body_md' => $target['body_md'],
                'author_id' => (int)$target['author_id'],
                'captured_at' => date(DATE_ATOM),
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $stmt = $db->prepare(
                'INSERT INTO forum_reports(reporter_id,target_type,target_id,reason,details,content_snapshot) VALUES(?,?,?,?,?,?)'
            );
            $stmt->execute([(int)$user['id'], $type, $id, $reason, $details, $snapshot]);
            forumRespond(['success' => true, 'message' => '举报已提交，我们会尽快处理', 'data' => ['id' => (int)$db->lastInsertId()]], 201);

        case 'moderate':
            checkRateLimit('forum:moderate', 80, 10);
            $input = forumInput();
            $operation = (string)($input['operation'] ?? '');
            $type = ($input['target_type'] ?? 'post') === 'reply' ? 'reply' : 'post';
            $id = (int)($input['target_id'] ?? 0);
            $target = $type === 'post' ? forumGetPost($id, true) : forumGetReply($id, true);
            if (!$target) forumFail('内容不存在', 404);
            $post = $type === 'post' ? $target : forumGetPost((int)$target['post_id'], true);
            if (!$post || !forumPostAccess($post, $user)) forumFail('内容不存在', 404);
            if (($user['role'] ?? '') !== 'super_admin') forumFail('没有论坛广场管理权限', 403);
            $resolution = forumString($input['resolution'] ?? '', 1000, false);
            $reportId = (int)($input['report_id'] ?? 0);
            $statusMap = ['hide' => 'hidden', 'delete' => 'deleted', 'restore' => 'published'];
            $db->beginTransaction();
            if (isset($statusMap[$operation])) {
                $table = $type === 'post' ? 'forum_posts' : 'forum_replies';
                $newStatus = $statusMap[$operation];
                forumCreateRevision($type, $target, (int)$user['id']);
                $deletedSql = $newStatus === 'deleted' ? 'CURRENT_TIMESTAMP' : 'NULL';
                $db->prepare("UPDATE {$table} SET status=?,deleted_at={$deletedSql} WHERE id=?")->execute([$newStatus, $id]);
            } elseif ($type === 'post' && in_array($operation, ['pin', 'unpin', 'essence', 'unessence'], true)) {
                $field = str_contains($operation, 'essence') ? 'is_essence' : 'is_pinned';
                $active = in_array($operation, ['pin', 'essence'], true) ? 1 : 0;
                $db->prepare("UPDATE forum_posts SET {$field}=? WHERE id=?")->execute([$active, $id]);
                if ($active && (int)$target['author_id'] !== (int)$user['id']) {
                    createNotification(
                        (int)$target['author_id'],
                        $field === 'is_pinned' ? 'forum_pin' : 'forum_essence',
                        $field === 'is_pinned' ? '你的帖子已被置顶' : '你的帖子已被加精',
                        (string)$target['title'], forumPostLink($id), 'forum_post', $id
                    );
                }
            } elseif ($operation !== 'dismiss') {
                forumFail('无效的管理操作', 422);
            }
            if ($reportId > 0) {
                $reportStatus = $operation === 'dismiss' ? 'dismissed' : 'resolved';
                $db->prepare(
                    'UPDATE forum_reports SET status=?,handled_by=?,resolution=?,handled_at=CURRENT_TIMESTAMP
                     WHERE id=? AND target_type=? AND target_id=?'
                )->execute([$reportStatus, (int)$user['id'], $resolution, $reportId, $type, $id]);
            }
            logAction('forum_moderate', 'forum_' . $type, $id, [
                'operation' => $operation,
                'report_id' => $reportId,
                'resolution' => $resolution,
            ]);
            $db->commit();
            forumRespond(['success' => true, 'message' => '管理操作已完成']);

        default:
            forumFail('未知的论坛操作', 404);
    }
} catch (PDOException $error) {
    forumRollback($db);
    error_log('[forum] database error: ' . $error->getMessage());
    $duplicate = in_array((string)$error->getCode(), ['23000', '19'], true);
    forumFail($duplicate ? '提交的数据与现有记录重复' : '论坛数据暂时不可用，请稍后重试', $duplicate ? 409 : 500);
} catch (Throwable $error) {
    forumRollback($db);
    error_log('[forum] error: ' . $error->getMessage());
    forumFail('论坛服务暂时不可用，请稍后重试', 500);
}
