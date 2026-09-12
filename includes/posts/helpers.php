<?php
declare(strict_types=1);

require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../display_club.php';
require_once __DIR__ . '/../rate_limit.php';
require_once __DIR__ . '/../audit.php';
require_once __DIR__ . '/schema.php';

const POSTS_CONTENT_MAX = 280;
const POSTS_IMAGES_MAX = 4;
const POSTS_IMAGE_MAX_BYTES = 10485760;
const POSTS_IMAGE_MAX_DIMENSION = 12000;
const POSTS_IMAGE_MAX_PIXELS = 40000000;
const POSTS_FEED_LIMIT_DEFAULT = 20;
const POSTS_FEED_LIMIT_MAX = 50;

function postsDb(): PDO
{
    $db = getDB();
    postsEnsureSchema($db);
    return $db;
}

function postsProjectRoot(): string
{
    return dirname(__DIR__, 2);
}

function postsJson(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function postsFail(string $code, string $message, int $status = 400, array $fields = []): never
{
    postsJson([
        'success' => false,
        'error' => [
            'code' => $code,
            'message' => $message,
            'fields' => $fields,
        ],
    ], $status);
}

function postsInput(): array
{
    $contentType = strtolower((string)($_SERVER['CONTENT_TYPE'] ?? ''));
    if (str_contains($contentType, 'application/json')) {
        $decoded = json_decode((string)file_get_contents('php://input'), true);
        return is_array($decoded) ? $decoded : [];
    }
    return is_array($_POST) ? $_POST : [];
}

function postsRequireMethod(string $method): void
{
    if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== strtoupper($method)) {
        header('Allow: ' . strtoupper($method));
        postsFail('method_not_allowed', '请求方法不允许', 405);
    }
}

function postsRequireSameOrigin(): void
{
    if (PHP_SAPI === 'cli') return;
    $fetchSite = strtolower(trim((string)($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '')));
    if ($fetchSite === 'cross-site') postsFail('cross_origin', '拒绝跨站写入请求', 403);

    $forwarded = strtolower(trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0] ?? ''));
    $scheme = in_array($forwarded, ['http', 'https'], true)
        ? $forwarded
        : ((!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off') ? 'https' : 'http');
    $authority = trim((string)($_SERVER['HTTP_HOST'] ?? ''));
    $requestUrl = parse_url($scheme . '://' . $authority);
    $requestHost = strtolower((string)($requestUrl['host'] ?? ''));
    $requestPort = (int)($requestUrl['port'] ?? ($scheme === 'https' ? 443 : 80));
    if ($requestHost === '') postsFail('cross_origin', '无法校验请求来源', 403);

    foreach (['HTTP_ORIGIN', 'HTTP_REFERER'] as $header) {
        $source = trim((string)($_SERVER[$header] ?? ''));
        if ($source === '') continue;
        $sourceUrl = parse_url($source);
        $sourceHost = strtolower((string)($sourceUrl['host'] ?? ''));
        $sourceScheme = strtolower((string)($sourceUrl['scheme'] ?? ''));
        $sourcePort = (int)($sourceUrl['port'] ?? ($sourceScheme === 'https' ? 443 : 80));
        if ($sourceHost === '' || !in_array($sourceScheme, ['http', 'https'], true)
            || $sourceHost !== $requestHost || $sourcePort !== $requestPort || $sourceScheme !== $scheme) {
            postsFail('cross_origin', '拒绝跨站写入请求', 403);
        }
        return;
    }
    postsFail('cross_origin', '缺少同源请求信息', 403);
}

function postsLength(string $value): int
{
    return function_exists('mb_strlen') ? mb_strlen($value, 'UTF-8') : strlen($value);
}

function postsSlice(string $value, int $length): string
{
    return function_exists('mb_substr') ? mb_substr($value, 0, $length, 'UTF-8') : substr($value, 0, $length);
}

function postsCanManage(?array $user): bool
{
    return (bool)$user && ($user['role'] ?? '') === 'super_admin';
}

function postsAudit(string $action, ?int $targetId = null, array $details = []): void
{
    try {
        logAction($action, 'post', $targetId, $details);
    } catch (Throwable $e) {
        error_log('posts audit failed: ' . $e->getMessage());
    }
}

function postsUserPayload(?array $user): ?array
{
    if (!$user) return null;
    return [
        'id' => (int)$user['id'],
        'username' => (string)($user['username'] ?? ''),
        'handle' => '@' . (string)($user['username'] ?? ''),
        'nickname' => trim((string)($user['nickname'] ?? '')) ?: (string)($user['username'] ?? ''),
        'avatar_url' => (string)($user['avatar_url'] ?? ''),
        'role' => (string)($user['role'] ?? 'member'),
        'can_manage' => postsCanManage($user),
    ];
}

function postsSelectableClubs(int $userId): array
{
    if ($userId <= 0) return [];
    try {
        $stmt = postsDb()->prepare(
            "SELECT id, club_id, COALESCE(country, 'china') AS country, role, status
             FROM club_memberships
             WHERE user_id = ? AND status = 'active' AND role IN ('member','manager','representative')
             ORDER BY id DESC"
        );
        $stmt->execute([$userId]);
        $result = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $club = displayClubPublicFromMembership($row);
            if (!$club) continue;
            $result[] = [
                'membership_id' => (int)$row['id'],
                'club_id' => (int)$row['club_id'],
                'country' => (string)$club['country'],
                'name' => (string)$club['name'],
                'role' => (string)$row['role'],
            ];
        }
        return $result;
    } catch (Throwable $e) {
        return [];
    }
}

function postsResolveClubSelection(PDO $db, int $userId, mixed $membershipId): array
{
    $membershipId = (int)$membershipId;
    if ($membershipId <= 0) return ['club_id' => null, 'club_country' => null];
    $membership = displayClubSelectableMembership($db, $userId, $membershipId);
    if (!$membership) postsFail('invalid_club', '同好会归属无效或已失效', 422, ['field' => 'club_membership_id']);
    return [
        'club_id' => (int)$membership['club_id'],
        'club_country' => (string)$membership['country'],
    ];
}

function postsSafeImagePath(string $value): string
{
    $value = trim(str_replace('\\', '/', $value));
    $value = preg_replace('/^\/+/', '', $value) ?? '';
    $value = preg_replace('/^\.\/+/', '', $value) ?? '';
    if ($value === '' || str_contains($value, '..') || !preg_match('#^uploads/posts/[a-zA-Z0-9/_\-.]+$#', $value)) return '';
    return '/' . $value;
}

function postsStoredPath(string $value): string
{
    $safe = postsSafeImagePath($value);
    return $safe === '' ? '' : ltrim($safe, '/');
}

function postsClubFromRow(array $row): ?array
{
    $clubId = (int)($row['club_id'] ?? 0);
    if ($clubId <= 0) return null;
    $country = strtolower(trim((string)($row['club_country'] ?? '')));
    if (!in_array($country, ['china', 'japan'], true)) {
        $matches = [];
        foreach (['china', 'japan'] as $candidate) {
            if (displayClubRecord($clubId, $candidate)) $matches[] = $candidate;
        }
        $country = count($matches) === 1 ? $matches[0] : '';
    }
    if ($country === '') return null;
    $club = displayClubRecord($clubId, $country);
    if (!$club) return null;
    return [
        'id' => $clubId,
        'country' => $country,
        'name' => trim((string)($club['display_name'] ?? $club['name'] ?? $club['school'] ?? '')),
    ];
}

function postsAuthorFromRow(array $row): array
{
    $username = (string)($row['author_username'] ?? $row['username'] ?? '');
    $nickname = trim((string)($row['author_nickname'] ?? $row['nickname'] ?? '')) ?: $username;
    return [
        'id' => (int)($row['author_id'] ?? 0),
        'username' => $username,
        'handle' => '@' . $username,
        'nickname' => $nickname,
        'avatar_url' => (string)($row['author_avatar_url'] ?? $row['avatar_url'] ?? ''),
    ];
}

function postsBaseSelect(): string
{
    return "SELECT p.*, u.username AS author_username, u.nickname AS author_nickname,
                   u.avatar_url AS author_avatar_url
            FROM posts p
            JOIN users u ON u.id = p.author_id";
}

function postsFetchPost(int $id): ?array
{
    if ($id <= 0) return null;
    $stmt = postsDb()->prepare(postsBaseSelect() . ' WHERE p.id = ? LIMIT 1');
    $stmt->execute([$id]);
    return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
}

function postsImagesFromRow(array $row): array
{
    $decoded = json_decode((string)($row['images_json'] ?? '[]'), true);
    if (!is_array($decoded)) return [];
    $images = [];
    foreach ($decoded as $path) {
        $safe = postsSafeImagePath((string)$path);
        if ($safe !== '') $images[] = $safe;
    }
    return array_slice($images, 0, POSTS_IMAGES_MAX);
}

function postsViewerLiked(int $postId, int $viewerId): bool
{
    if ($viewerId <= 0) return false;
    $stmt = postsDb()->prepare('SELECT COUNT(*) FROM post_likes WHERE post_id = ? AND user_id = ?');
    $stmt->execute([$postId, $viewerId]);
    return (int)$stmt->fetchColumn() > 0;
}

function postsSerializePost(array $row, ?array $user = null, array $options = []): array
{
    $status = (string)($row['status'] ?? 'published');
    $viewerId = (int)($user['id'] ?? 0);
    $canDelete = (bool)$user && empty($row['deleted_at'])
        && ((int)$row['author_id'] === $viewerId || postsCanManage($user));
    $payload = [
        'id' => (int)$row['id'],
        'content' => (string)$row['content'],
        'images' => postsImagesFromRow($row),
        'reply_to_id' => $row['reply_to_id'] !== null ? (int)$row['reply_to_id'] : null,
        'quoted_post_id' => $row['quoted_post_id'] !== null ? (int)$row['quoted_post_id'] : null,
        'status' => $status,
        'like_count' => (int)($row['like_count'] ?? 0),
        'reply_count' => (int)($row['reply_count'] ?? 0),
        'repost_count' => (int)($row['repost_count'] ?? 0),
        'created_at' => (string)($row['created_at'] ?? ''),
        'author' => postsAuthorFromRow($row),
        'club' => postsClubFromRow($row),
        'liked' => $viewerId > 0 ? postsViewerLiked((int)$row['id'], $viewerId) : false,
        'capabilities' => [
            'delete' => $canDelete,
        ],
    ];
    if (!empty($options['include_quoted']) && $row['quoted_post_id'] !== null) {
        $quoted = postsFetchPost((int)$row['quoted_post_id']);
        $payload['quoted_post'] = $quoted && (string)$quoted['status'] === 'published' && empty($quoted['deleted_at'])
            ? postsSerializePost($quoted, $user, [])
            : null;
    }
    if (!empty($options['include_reply_to']) && $row['reply_to_id'] !== null) {
        $parent = postsFetchPost((int)$row['reply_to_id']);
        $payload['reply_to_post'] = $parent && (string)$parent['status'] === 'published' && empty($parent['deleted_at'])
            ? postsSerializePost($parent, $user, [])
            : null;
    }
    return $payload;
}

function postsCursor(array $query): array
{
    $beforeId = max(0, (int)($query['before_id'] ?? 0));
    $limit = min(POSTS_FEED_LIMIT_MAX, max(1, (int)($query['limit'] ?? POSTS_FEED_LIMIT_DEFAULT)));
    return [$beforeId, $limit];
}

function postsListFeed(array $query, ?array $user): array
{
    $db = postsDb();
    [$beforeId, $limit] = postsCursor($query);
    $scope = strtolower(trim((string)($query['scope'] ?? '')));
    $sql = postsBaseSelect() . " WHERE p.status = 'published' AND p.deleted_at IS NULL AND p.reply_to_id IS NULL";
    $params = [];
    if ($scope === 'following') {
        $viewerId = (int)($user['id'] ?? 0);
        if ($viewerId <= 0) postsFail('login_required', '请先登录', 401);
        $sql .= " AND (p.author_id = ? OR p.author_id IN (SELECT following_id FROM user_follows WHERE follower_id = ?))";
        array_push($params, $viewerId, $viewerId);
    }
    if ($beforeId > 0) {
        $sql .= ' AND p.id < ?';
        $params[] = $beforeId;
    }
    $sql .= " ORDER BY p.id DESC LIMIT {$limit}";
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $posts = array_map(
        static fn(array $row): array => postsSerializePost($row, $user, ['include_quoted' => true]),
        $rows
    );
    $nextBeforeId = count($rows) === $limit ? (int)end($rows)['id'] : null;
    return ['posts' => $posts, 'next_before_id' => $nextBeforeId];
}

function postsListReplies(int $postId, ?array $user): array
{
    $db = postsDb();
    $stmt = $db->prepare(postsBaseSelect() . " WHERE p.reply_to_id = ? AND p.status = 'published' AND p.deleted_at IS NULL ORDER BY p.id ASC LIMIT 200");
    $stmt->execute([$postId]);
    return array_map(
        static fn(array $row): array => postsSerializePost($row, $user, ['include_quoted' => true]),
        $stmt->fetchAll(PDO::FETCH_ASSOC)
    );
}

function postsFetchUserByUsername(string $username): ?array
{
    $username = trim($username);
    if ($username === '' || strlen($username) > 40) return null;
    $stmt = postsDb()->prepare(
        "SELECT id, username, nickname, avatar_url, banner_url, role, profile_bio, created_at
         FROM users WHERE username = ? AND status = 'active' LIMIT 1"
    );
    $stmt->execute([$username]);
    return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
}

function postsProfilePayload(array $row, ?array $user): array
{
    $db = postsDb();
    $userId = (int)$row['id'];
    $viewerId = (int)($user['id'] ?? 0);
    $posts = $db->prepare("SELECT COUNT(*) FROM posts WHERE author_id = ? AND status = 'published' AND deleted_at IS NULL");
    $posts->execute([$userId]);
    $followers = $db->prepare('SELECT COUNT(*) FROM user_follows WHERE following_id = ?');
    $followers->execute([$userId]);
    $following = $db->prepare('SELECT COUNT(*) FROM user_follows WHERE follower_id = ?');
    $following->execute([$userId]);
    $isFollowing = false;
    if ($viewerId > 0 && $viewerId !== $userId) {
        $check = $db->prepare('SELECT COUNT(*) FROM user_follows WHERE follower_id = ? AND following_id = ?');
        $check->execute([$viewerId, $userId]);
        $isFollowing = (int)$check->fetchColumn() > 0;
    }
    $nickname = trim((string)($row['nickname'] ?? '')) ?: (string)$row['username'];
    return [
        'id' => $userId,
        'username' => (string)$row['username'],
        'handle' => '@' . (string)$row['username'],
        'nickname' => $nickname,
        'avatar_url' => (string)($row['avatar_url'] ?? ''),
        'banner_url' => (string)($row['banner_url'] ?? ''),
        'role' => (string)($row['role'] ?? 'member'),
        'bio' => trim((string)($row['profile_bio'] ?? '')),
        'created_at' => (string)($row['created_at'] ?? ''),
        'stats' => [
            'posts' => (int)$posts->fetchColumn(),
            'followers' => (int)$followers->fetchColumn(),
            'following' => (int)$following->fetchColumn(),
        ],
        'is_self' => $viewerId === $userId,
        'is_following' => $isFollowing,
        'is_friend' => $viewerId > 0 && $viewerId !== $userId ? postsAreFriends($db, $viewerId, $userId) : false,
    ];
}

function postsListUserTimeline(int $targetId, string $tab, array $query, ?array $user): array
{
    $db = postsDb();
    [$beforeId, $limit] = postsCursor($query);
    $sql = postsBaseSelect() . " WHERE p.author_id = ? AND p.status = 'published' AND p.deleted_at IS NULL";
    $params = [$targetId];
    if ($tab === 'replies') {
        $sql .= ' AND p.reply_to_id IS NOT NULL';
    } else {
        $sql .= ' AND p.reply_to_id IS NULL';
    }
    if ($beforeId > 0) {
        $sql .= ' AND p.id < ?';
        $params[] = $beforeId;
    }
    $sql .= " ORDER BY p.id DESC LIMIT {$limit}";
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $posts = array_map(
        static fn(array $row): array => postsSerializePost($row, $user, ['include_quoted' => true, 'include_reply_to' => true]),
        $rows
    );
    $nextBeforeId = count($rows) === $limit ? (int)end($rows)['id'] : null;
    return ['posts' => $posts, 'next_before_id' => $nextBeforeId];
}

function postsSuggestedUsers(?array $user, int $limit = 4): array
{
    $db = postsDb();
    $viewerId = (int)($user['id'] ?? 0);
    $sql = "SELECT u.id, u.username, u.nickname, u.avatar_url, MAX(p.id) AS last_post_id, COUNT(p.id) AS post_count
            FROM users u
            JOIN posts p ON p.author_id = u.id AND p.status = 'published' AND p.deleted_at IS NULL
            WHERE u.status = 'active'";
    $params = [];
    if ($viewerId > 0) {
        $sql .= ' AND u.id <> ? AND u.id NOT IN (SELECT following_id FROM user_follows WHERE follower_id = ?)';
        array_push($params, $viewerId, $viewerId);
    }
    $sql .= " GROUP BY u.id, u.username, u.nickname, u.avatar_url ORDER BY last_post_id DESC LIMIT {$limit}";
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    return array_map(static function (array $row) use ($db, $viewerId): array {
        $isFollowing = false;
        $isFriend = false;
        if ($viewerId > 0) {
            $check = $db->prepare('SELECT COUNT(*) FROM user_follows WHERE follower_id = ? AND following_id = ?');
            $check->execute([$viewerId, (int)$row['id']]);
            $isFollowing = (int)$check->fetchColumn() > 0;
            $isFriend = $isFollowing ? postsAreFriends($db, $viewerId, (int)$row['id']) : false;
        }
        $nickname = trim((string)($row['nickname'] ?? '')) ?: (string)$row['username'];
        return [
            'id' => (int)$row['id'],
            'username' => (string)$row['username'],
            'handle' => '@' . (string)$row['username'],
            'nickname' => $nickname,
            'avatar_url' => (string)($row['avatar_url'] ?? ''),
            'post_count' => (int)$row['post_count'],
            'is_following' => $isFollowing,
            'is_friend' => $isFriend,
        ];
    }, $stmt->fetchAll(PDO::FETCH_ASSOC));
}

function postsFollow(array $input, array $user): array
{
    checkRateLimit('posts:follow', 60, 10);
    $targetId = max(0, (int)($input['id'] ?? 0));
    if ($targetId <= 0) postsFail('invalid_target', '关注对象无效', 422);
    if ($targetId === (int)$user['id']) postsFail('self_follow', '不能关注自己', 422);
    $db = postsDb();
    $exists = $db->prepare("SELECT COUNT(*) FROM users WHERE id = ? AND status = 'active'");
    $exists->execute([$targetId]);
    if (!(int)$exists->fetchColumn()) postsFail('not_found', '用户不存在', 404);
    $isMysql = (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql';
    $sql = $isMysql
        ? 'INSERT IGNORE INTO user_follows (follower_id, following_id, created_at) VALUES (?,?,?)'
        : 'INSERT OR IGNORE INTO user_follows (follower_id, following_id, created_at) VALUES (?,?,?)';
    $db->prepare($sql)->execute([(int)$user['id'], $targetId, date('Y-m-d H:i:s')]);
    $count = $db->prepare('SELECT COUNT(*) FROM user_follows WHERE following_id = ?');
    $count->execute([$targetId]);
    return ['following' => true, 'followers' => (int)$count->fetchColumn(), 'message' => '已关注'];
}

function postsUnfollow(array $input, array $user): array
{
    checkRateLimit('posts:follow', 60, 10);
    $targetId = max(0, (int)($input['id'] ?? 0));
    if ($targetId <= 0) postsFail('invalid_target', '关注对象无效', 422);
    $db = postsDb();
    $db->prepare('DELETE FROM user_follows WHERE follower_id = ? AND following_id = ?')->execute([(int)$user['id'], $targetId]);
    $count = $db->prepare('SELECT COUNT(*) FROM user_follows WHERE following_id = ?');
    $count->execute([$targetId]);
    return ['following' => false, 'followers' => (int)$count->fetchColumn(), 'message' => '已取消关注'];
}

function postsSearchUsers(string $query, ?array $user, int $limit = 8): array
{
    $keyword = trim($query);
    if ($keyword === '') return [];
    $db = postsDb();
    $viewerId = (int)($user['id'] ?? 0);
    $like = '%' . addcslashes($keyword, '%_\\') . '%';
    $stmt = $db->prepare(
        "SELECT id, username, nickname, avatar_url, profile_bio
         FROM users
         WHERE status = 'active' AND (username LIKE ? OR nickname LIKE ?)
         ORDER BY CASE WHEN username = ? THEN 0 ELSE 1 END, id ASC
         LIMIT {$limit}"
    );
    $stmt->execute([$like, $like, $keyword]);
    return array_map(static function (array $row) use ($db, $viewerId): array {
        $isFollowing = false;
        $isFriend = false;
        if ($viewerId > 0) {
            $check = $db->prepare('SELECT COUNT(*) FROM user_follows WHERE follower_id = ? AND following_id = ?');
            $check->execute([$viewerId, (int)$row['id']]);
            $isFollowing = (int)$check->fetchColumn() > 0;
            $isFriend = $isFollowing ? postsAreFriends($db, $viewerId, (int)$row['id']) : false;
        }
        $nickname = trim((string)($row['nickname'] ?? '')) ?: (string)$row['username'];
        return [
            'id' => (int)$row['id'],
            'username' => (string)$row['username'],
            'handle' => '@' . (string)$row['username'],
            'nickname' => $nickname,
            'avatar_url' => (string)($row['avatar_url'] ?? ''),
            'bio' => trim((string)($row['profile_bio'] ?? '')),
            'is_following' => $isFollowing,
            'is_friend' => $isFriend,
        ];
    }, $stmt->fetchAll(PDO::FETCH_ASSOC));
}

function postsSearchPosts(string $query, ?array $user, array $cursor): array
{
    $keyword = trim($query);
    [$beforeId, $limit] = $cursor;
    if ($keyword === '') return ['posts' => [], 'next_before_id' => null];
    $db = postsDb();
    $like = '%' . addcslashes($keyword, '%_\\') . '%';
    $sql = postsBaseSelect() . " WHERE p.status = 'published' AND p.deleted_at IS NULL AND p.content LIKE ?";
    $params = [$like];
    if ($beforeId > 0) {
        $sql .= ' AND p.id < ?';
        $params[] = $beforeId;
    }
    $sql .= " ORDER BY p.id DESC LIMIT {$limit}";
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $posts = array_map(
        static fn(array $row): array => postsSerializePost($row, $user, ['include_quoted' => true]),
        $rows
    );
    $nextBeforeId = count($rows) === $limit ? (int)end($rows)['id'] : null;
    return ['posts' => $posts, 'next_before_id' => $nextBeforeId];
}

function postsAreFriends(PDO $db, int $a, int $b): bool
{
    $stmt = $db->prepare(
        'SELECT COUNT(*) FROM user_follows f1
         JOIN user_follows f2 ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
         WHERE f1.follower_id = ? AND f1.following_id = ?'
    );
    $stmt->execute([$a, $b]);
    return (int)$stmt->fetchColumn() > 0;
}

function postsDmConversationId(PDO $db, int $a, int $b): int
{
    $min = min($a, $b);
    $max = max($a, $b);
    $isMysql = (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql';
    $sql = $isMysql
        ? 'INSERT IGNORE INTO dm_conversations (user_a_id, user_b_id, created_at) VALUES (?,?,?)'
        : 'INSERT OR IGNORE INTO dm_conversations (user_a_id, user_b_id, created_at) VALUES (?,?,?)';
    $db->prepare($sql)->execute([$min, $max, date('Y-m-d H:i:s')]);
    $stmt = $db->prepare('SELECT id FROM dm_conversations WHERE user_a_id = ? AND user_b_id = ?');
    $stmt->execute([$min, $max]);
    return (int)$stmt->fetchColumn();
}

const DM_CONTENT_MAX = 1000;

function postsDmList(array $user): array
{
    $db = postsDb();
    $me = (int)$user['id'];
    $stmt = $db->prepare(
        "SELECT c.id, c.last_message_at,
                CASE WHEN c.user_a_id = ? THEN c.user_b_id ELSE c.user_a_id END AS other_id
         FROM dm_conversations c
         WHERE c.user_a_id = ? OR c.user_b_id = ?
         ORDER BY c.last_message_at DESC, c.id DESC
         LIMIT 50"
    );
    $stmt->execute([$me, $me, $me]);
    $conversations = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $otherId = (int)$row['other_id'];
        $userStmt = $db->prepare('SELECT id, username, nickname, avatar_url FROM users WHERE id = ?');
        $userStmt->execute([$otherId]);
        $other = $userStmt->fetch(PDO::FETCH_ASSOC);
        if (!$other) continue;
        $lastStmt = $db->prepare(
            'SELECT content, sender_id, created_at FROM dm_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1'
        );
        $lastStmt->execute([(int)$row['id']]);
        $last = $lastStmt->fetch(PDO::FETCH_ASSOC);
        $unreadStmt = $db->prepare(
            'SELECT COUNT(*) FROM dm_messages WHERE conversation_id = ? AND sender_id <> ? AND read_at IS NULL'
        );
        $unreadStmt->execute([(int)$row['id'], $me]);
        $nickname = trim((string)($other['nickname'] ?? '')) ?: (string)$other['username'];
        $conversations[] = [
            'conversation_id' => (int)$row['id'],
            'user' => [
                'id' => (int)$other['id'],
                'username' => (string)$other['username'],
                'handle' => '@' . (string)$other['username'],
                'nickname' => $nickname,
                'avatar_url' => (string)($other['avatar_url'] ?? ''),
            ],
            'last_message' => $last ? [
                'content' => (string)$last['content'],
                'mine' => (int)$last['sender_id'] === $me,
                'created_at' => (string)$last['created_at'],
            ] : null,
            'last_message_at' => (string)($row['last_message_at'] ?? ''),
            'unread' => (int)$unreadStmt->fetchColumn(),
        ];
    }
    return ['conversations' => $conversations];
}

function postsDmThread(array $input, array $user): array
{
    $db = postsDb();
    $me = (int)$user['id'];
    $otherId = max(0, (int)($input['user_id'] ?? 0));
    if ($otherId <= 0 || $otherId === $me) postsFail('invalid_target', '会话对象无效', 422);
    $exists = $db->prepare("SELECT COUNT(*) FROM users WHERE id = ? AND status = 'active'");
    $exists->execute([$otherId]);
    if (!(int)$exists->fetchColumn()) postsFail('not_found', '用户不存在', 404);
    $conversationId = postsDmConversationId($db, $me, $otherId);
    $afterId = max(0, (int)($input['after_id'] ?? 0));
    $beforeId = max(0, (int)($input['before_id'] ?? 0));
    $limit = min(100, max(1, (int)($input['limit'] ?? 50)));

    if ($afterId > 0) {
        $stmt = $db->prepare('SELECT * FROM dm_messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT 200');
        $stmt->execute([$conversationId, $afterId]);
        $messages = array_map('postsDmSerializeMessage', $stmt->fetchAll(PDO::FETCH_ASSOC));
        return ['messages' => $messages, 'conversation_id' => $conversationId, 'has_more_before' => false, 'other' => postsDmOtherPayload($db, $otherId)];
    }
    $sql = 'SELECT * FROM dm_messages WHERE conversation_id = ?';
    $params = [$conversationId];
    if ($beforeId > 0) {
        $sql .= ' AND id < ?';
        $params[] = $beforeId;
    }
    $sql .= " ORDER BY id DESC LIMIT {$limit}";
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    $rows = array_reverse($stmt->fetchAll(PDO::FETCH_ASSOC));
    $messages = array_map('postsDmSerializeMessage', $rows);
    $hasMoreBefore = count($rows) === $limit;
    return ['messages' => $messages, 'conversation_id' => $conversationId, 'has_more_before' => $hasMoreBefore, 'other' => postsDmOtherPayload($db, $otherId)];
}

function postsDmOtherPayload(PDO $db, int $otherId): array
{
    $stmt = $db->prepare('SELECT id, username, nickname, avatar_url FROM users WHERE id = ?');
    $stmt->execute([$otherId]);
    $other = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$other) return null;
    $nickname = trim((string)($other['nickname'] ?? '')) ?: (string)$other['username'];
    return [
        'id' => (int)$other['id'],
        'username' => (string)$other['username'],
        'handle' => '@' . (string)$other['username'],
        'nickname' => $nickname,
        'avatar_url' => (string)($other['avatar_url'] ?? ''),
    ];
}

function postsDmSerializeMessage(array $row): array
{
    $decoded = json_decode((string)($row['images_json'] ?? '[]'), true);
    $images = [];
    if (is_array($decoded)) {
        foreach ($decoded as $path) {
            $safe = postsSafeImagePath((string)$path);
            if ($safe !== '') $images[] = $safe;
        }
    }
    return [
        'id' => (int)$row['id'],
        'sender_id' => (int)$row['sender_id'],
        'content' => (string)$row['content'],
        'images' => $images,
        'created_at' => (string)$row['created_at'],
        'read_at' => $row['read_at'] ?? null,
    ];
}

function postsDmSend(array $input, array $user): array
{
    checkRateLimit('posts:dm_send', 30, 10);
    $db = postsDb();
    $me = (int)$user['id'];
    $toId = max(0, (int)($input['to_user_id'] ?? 0));
    if ($toId <= 0 || $toId === $me) postsFail('invalid_target', '私信对象无效', 422);
    if (!postsAreFriends($db, $me, $toId)) postsFail('not_friends', '只能给互相关注的好友发私信', 403);
    $content = trim((string)($input['content'] ?? ''));
    if (postsLength($content) > DM_CONTENT_MAX) postsFail('too_long', '消息不能超过 ' . DM_CONTENT_MAX . ' 字', 422);
    if (preg_match('/[ --]/u', $content)) postsFail('invalid_content', '消息包含不可用字符', 422);

    $rawImages = $input['images'] ?? [];
    if (!is_array($rawImages)) postsFail('invalid_image', '图片参数无效', 422);
    $storedPaths = [];
    foreach (array_slice(array_values($rawImages), 0, POSTS_IMAGES_MAX) as $path) {
        $path = postsStoredPath((string)$path);
        if ($path === '') postsFail('invalid_image', '私信图片必须通过上传接口添加', 422);
        if (!in_array($path, $storedPaths, true)) $storedPaths[] = $path;
    }
    foreach ($storedPaths as $path) {
        $stmt = $db->prepare('SELECT COUNT(*) FROM post_attachments WHERE uploader_id = ? AND relative_path = ?');
        $stmt->execute([$me, $path]);
        if (!(int)$stmt->fetchColumn()) postsFail('attachment_not_owned', '私信包含未上传的图片', 422);
    }
    if ($content === '' && !$storedPaths) postsFail('required', '消息内容不能为空', 422);

    $now = date('Y-m-d H:i:s');
    $db->beginTransaction();
    try {
        $conversationId = postsDmConversationId($db, $me, $toId);
        $stmt = $db->prepare('INSERT INTO dm_messages (conversation_id, sender_id, content, images_json, created_at) VALUES (?,?,?,?,?)');
        $stmt->execute([$conversationId, $me, $content, json_encode($storedPaths, JSON_UNESCAPED_SLASHES), $now]);
        $messageId = (int)$db->lastInsertId();
        $db->prepare('UPDATE dm_conversations SET last_message_id = ?, last_message_at = ? WHERE id = ?')
            ->execute([$messageId, $now, $conversationId]);
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
    postsAudit('posts.dm.send', $messageId, ['to' => $toId, 'images' => count($storedPaths)]);
    return [
        'message' => ['id' => $messageId, 'sender_id' => $me, 'content' => $content, 'images' => $storedPaths, 'created_at' => $now, 'read_at' => null],
        'conversation_id' => $conversationId,
        'message_text' => '已发送',
    ];
}

function postsDmMarkRead(array $input, array $user): array
{
    $db = postsDb();
    $me = (int)$user['id'];
    $conversationId = max(0, (int)($input['conversation_id'] ?? 0));
    if ($conversationId <= 0) postsFail('invalid_target', '会话无效', 422);
    $check = $db->prepare('SELECT COUNT(*) FROM dm_conversations WHERE id = ? AND (user_a_id = ? OR user_b_id = ?)');
    $check->execute([$conversationId, $me, $me]);
    if (!(int)$check->fetchColumn()) postsFail('not_found', '会话不存在', 404);
    $stmt = $db->prepare(
        'UPDATE dm_messages SET read_at = ? WHERE conversation_id = ? AND sender_id <> ? AND read_at IS NULL'
    );
    $stmt->execute([date('Y-m-d H:i:s'), $conversationId, $me]);
    return ['message' => '已读'];
}

function postsDmFriends(array $user): array
{
    $db = postsDb();
    $me = (int)$user['id'];
    $stmt = $db->prepare(
        "SELECT u.id, u.username, u.nickname, u.avatar_url
         FROM users u
         JOIN user_follows f1 ON f1.follower_id = ? AND f1.following_id = u.id
         JOIN user_follows f2 ON f2.follower_id = u.id AND f2.following_id = ?
         WHERE u.status = 'active'
         ORDER BY u.id ASC
         LIMIT 100"
    );
    $stmt->execute([$me, $me]);
    return array_map(static function (array $row): array {
        $nickname = trim((string)($row['nickname'] ?? '')) ?: (string)$row['username'];
        return [
            'id' => (int)$row['id'],
            'username' => (string)$row['username'],
            'handle' => '@' . (string)$row['username'],
            'nickname' => $nickname,
            'avatar_url' => (string)($row['avatar_url'] ?? ''),
        ];
    }, $stmt->fetchAll(PDO::FETCH_ASSOC));
}

function postsDmUnreadCount(array $user): int
{
    $db = postsDb();
    $me = (int)$user['id'];
    $stmt = $db->prepare(
        'SELECT COUNT(*) FROM dm_messages m
         JOIN dm_conversations c ON c.id = m.conversation_id
         WHERE (c.user_a_id = ? OR c.user_b_id = ?) AND m.sender_id <> ? AND m.read_at IS NULL'
    );
    $stmt->execute([$me, $me, $me]);
    return (int)$stmt->fetchColumn();
}

function postsFollowList(array $input, array $user): array
{
    $db = postsDb();
    $type = strtolower(trim((string)($input['type'] ?? 'following')));
    if (!in_array($type, ['following', 'followers'], true)) postsFail('invalid_type', '列表类型无效', 422);
    $target = postsFetchUserByUsername((string)($input['username'] ?? ''));
    if (!$target) postsFail('not_found', '用户不存在', 404);
    $targetId = (int)$target['id'];
    $viewerId = (int)($user['id'] ?? 0);

    if ($type === 'following') {
        $sql = "SELECT u.id, u.username, u.nickname, u.avatar_url, u.profile_bio FROM user_follows f JOIN users u ON u.id = f.following_id WHERE f.follower_id = ? AND u.status = 'active' ORDER BY f.id DESC LIMIT 200";
    } else {
        $sql = "SELECT u.id, u.username, u.nickname, u.avatar_url, u.profile_bio FROM user_follows f JOIN users u ON u.id = f.follower_id WHERE f.following_id = ? AND u.status = 'active' ORDER BY f.id DESC LIMIT 200";
    }
    $stmt = $db->prepare($sql);
    $stmt->execute([$targetId]);
    $users = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $isFollowing = false;
        if ($viewerId > 0) {
            $check = $db->prepare('SELECT COUNT(*) FROM user_follows WHERE follower_id = ? AND following_id = ?');
            $check->execute([$viewerId, (int)$row['id']]);
            $isFollowing = (int)$check->fetchColumn() > 0;
        }
        $nickname = trim((string)($row['nickname'] ?? '')) ?: (string)$row['username'];
        $users[] = [
            'id' => (int)$row['id'],
            'username' => (string)$row['username'],
            'handle' => '@' . (string)$row['username'],
            'nickname' => $nickname,
            'avatar_url' => (string)($row['avatar_url'] ?? ''),
            'bio' => trim((string)($row['profile_bio'] ?? '')),
            'is_following' => $isFollowing,
            'is_friend' => $viewerId > 0 && $viewerId !== (int)$row['id'] ? postsAreFriends($db, $viewerId, (int)$row['id']) : false,
        ];
    }
    return ['type' => $type, 'users' => $users];
}

function postsListMine(array $query, array $user): array
{
    $db = postsDb();
    [$beforeId, $limit] = postsCursor($query);
    $sql = postsBaseSelect() . " WHERE p.author_id = ? AND p.status = 'published' AND p.deleted_at IS NULL";
    $params = [(int)$user['id']];
    if ($beforeId > 0) {
        $sql .= ' AND p.id < ?';
        $params[] = $beforeId;
    }
    $sql .= " ORDER BY p.id DESC LIMIT {$limit}";
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $posts = array_map(
        static fn(array $row): array => postsSerializePost($row, $user, ['include_quoted' => true]),
        $rows
    );
    $nextBeforeId = count($rows) === $limit ? (int)end($rows)['id'] : null;
    return ['posts' => $posts, 'next_before_id' => $nextBeforeId];
}

function postsValidateContent(string $content): string
{
    $content = trim(preg_replace("/\r\n/", "\n", $content) ?? '');
    if ($content === '') postsFail('required', '推文内容不能为空', 422, ['field' => 'content']);
    if (postsLength($content) > POSTS_CONTENT_MAX) postsFail('too_long', '推文超过 ' . POSTS_CONTENT_MAX . ' 字上限', 422, ['field' => 'content', 'max_length' => POSTS_CONTENT_MAX]);
    if (preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', $content)) postsFail('invalid_content', '推文包含不可用字符', 422);
    return $content;
}

function postsValidateImages(PDO $db, int $userId, array $images, string $uploadToken): array
{
    if (count($images) > POSTS_IMAGES_MAX) postsFail('too_many_images', '一条推文最多 ' . POSTS_IMAGES_MAX . ' 张图片', 422);
    $stored = [];
    foreach ($images as $path) {
        $path = postsStoredPath((string)$path);
        if ($path === '') postsFail('invalid_image', '推文图片必须通过动态上传接口添加', 422, ['field' => 'images']);
        if (!in_array($path, $stored, true)) $stored[] = $path;
    }
    if (!$stored) return [];
    foreach ($stored as $path) {
        $stmt = $db->prepare(
            'SELECT id, post_id, upload_token FROM post_attachments
             WHERE uploader_id = ? AND relative_path = ? LIMIT 1'
        );
        $stmt->execute([$userId, $path]);
        $attachment = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$attachment) postsFail('attachment_not_owned', '推文包含未通过上传的图片', 422, ['field' => 'images']);
        if ((int)($attachment['post_id'] ?? 0) === 0 && ($uploadToken === '' || (string)$attachment['upload_token'] !== $uploadToken)) {
            postsFail('attachment_token_mismatch', '图片上传标识已失效，请重新上传', 422, ['field' => 'images']);
        }
    }
    return $stored;
}

function postsBindAttachments(PDO $db, int $userId, int $postId, array $storedPaths): void
{
    foreach ($storedPaths as $path) {
        $db->prepare('UPDATE post_attachments SET post_id = ? WHERE uploader_id = ? AND relative_path = ? AND post_id IS NULL')
            ->execute([$postId, $userId, $path]);
    }
}

function postsCreate(array $input, array $user): array
{
    checkRateLimit('posts:create', 20, 10);
    $db = postsDb();
    $content = postsValidateContent((string)($input['content'] ?? ''));
    $uploadToken = trim((string)($input['upload_token'] ?? ''));
    if ($uploadToken !== '' && !preg_match('/^[a-zA-Z0-9_-]{8,64}$/', $uploadToken)) postsFail('invalid_upload_token', '上传标识无效', 422);
    $rawImages = $input['images'] ?? [];
    if (!is_array($rawImages)) postsFail('invalid_image', '图片参数无效', 422);
    $storedPaths = postsValidateImages($db, (int)$user['id'], array_values($rawImages), $uploadToken);

    $club = ['club_id' => null, 'club_country' => null];
    if (!empty($input['club_membership_id'])) {
        $club = postsResolveClubSelection($db, (int)$user['id'], $input['club_membership_id']);
    }

    $replyToId = max(0, (int)($input['reply_to_id'] ?? 0));
    $quotedPostId = max(0, (int)($input['quoted_post_id'] ?? 0));
    if ($replyToId > 0) {
        $parent = postsFetchPost($replyToId);
        if (!$parent || (string)$parent['status'] !== 'published' || !empty($parent['deleted_at'])) {
            postsFail('not_found', '回复的目标推文不存在', 404, ['field' => 'reply_to_id']);
        }
    }
    if ($quotedPostId > 0) {
        $quoted = postsFetchPost($quotedPostId);
        if (!$quoted || (string)$quoted['status'] !== 'published' || !empty($quoted['deleted_at'])) {
            postsFail('not_found', '引用的推文不存在', 404, ['field' => 'quoted_post_id']);
        }
    }

    $now = date('Y-m-d H:i:s');
    $db->beginTransaction();
    try {
        $stmt = $db->prepare(
            'INSERT INTO posts (author_id, club_id, club_country, content, images_json, reply_to_id, quoted_post_id, status, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)'
        );
        $stmt->execute([
            (int)$user['id'], $club['club_id'], $club['club_country'], $content,
            json_encode($storedPaths, JSON_UNESCAPED_SLASHES),
            $replyToId > 0 ? $replyToId : null,
            $quotedPostId > 0 ? $quotedPostId : null,
            'published', $now, $now,
        ]);
        $postId = (int)$db->lastInsertId();
        if ($replyToId > 0) {
            $db->prepare('UPDATE posts SET reply_count = reply_count + 1, updated_at = ? WHERE id = ?')->execute([$now, $replyToId]);
        }
        if ($quotedPostId > 0) {
            $db->prepare('UPDATE posts SET repost_count = repost_count + 1, updated_at = ? WHERE id = ?')->execute([$now, $quotedPostId]);
        }
        postsBindAttachments($db, (int)$user['id'], $postId, $storedPaths);
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }

    postsAudit('posts.create', $postId, ['reply_to_id' => $replyToId ?: null, 'quoted_post_id' => $quotedPostId ?: null]);
    $row = postsFetchPost($postId);
    return [
        'post' => postsSerializePost($row, $user, ['include_quoted' => true, 'include_reply_to' => true]),
        'message' => '推文已发布',
    ];
}

function postsDelete(array $input, array $user): array
{
    checkRateLimit('posts:delete', 30, 10);
    $id = max(0, (int)($input['id'] ?? 0));
    $row = postsFetchPost($id);
    if (!$row || !empty($row['deleted_at'])) postsFail('not_found', '推文不存在', 404);
    if ((int)$row['author_id'] !== (int)$user['id'] && !postsCanManage($user)) postsFail('permission_denied', '无权删除这条推文', 403);
    $now = date('Y-m-d H:i:s');
    $db = postsDb();
    $db->beginTransaction();
    try {
        $db->prepare("UPDATE posts SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?")->execute([$now, $now, $id]);
        if ($row['reply_to_id'] !== null) {
            $db->prepare('UPDATE posts SET reply_count = CASE WHEN reply_count > 0 THEN reply_count - 1 ELSE 0 END, updated_at = ? WHERE id = ?')->execute([$now, (int)$row['reply_to_id']]);
        }
        if ($row['quoted_post_id'] !== null) {
            $db->prepare('UPDATE posts SET repost_count = CASE WHEN repost_count > 0 THEN repost_count - 1 ELSE 0 END, updated_at = ? WHERE id = ?')->execute([$now, (int)$row['quoted_post_id']]);
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
    postsAudit('posts.delete', $id);
    return ['message' => '推文已删除'];
}

function postsLike(array $input, array $user): array
{
    checkRateLimit('posts:like', 90, 10);
    $id = max(0, (int)($input['id'] ?? 0));
    $row = postsFetchPost($id);
    if (!$row || (string)$row['status'] !== 'published' || !empty($row['deleted_at'])) postsFail('not_found', '推文不存在', 404);
    $db = postsDb();
    $db->beginTransaction();
    try {
        $isMysql = (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql';
        $sql = $isMysql
            ? 'INSERT IGNORE INTO post_likes (post_id, user_id, created_at) VALUES (?,?,?)'
            : 'INSERT OR IGNORE INTO post_likes (post_id, user_id, created_at) VALUES (?,?,?)';
        $stmt = $db->prepare($sql);
        $stmt->execute([$id, (int)$user['id'], date('Y-m-d H:i:s')]);
        $count = $db->prepare('SELECT COUNT(*) FROM post_likes WHERE post_id = ?');
        $count->execute([$id]);
        $total = (int)$count->fetchColumn();
        $db->prepare('UPDATE posts SET like_count = ?, updated_at = updated_at WHERE id = ?')->execute([$total, $id]);
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
    return ['like_count' => $total, 'liked' => true, 'message' => '已点赞'];
}

function postsUnlike(array $input, array $user): array
{
    checkRateLimit('posts:like', 90, 10);
    $id = max(0, (int)($input['id'] ?? 0));
    $row = postsFetchPost($id);
    if (!$row) postsFail('not_found', '推文不存在', 404);
    $db = postsDb();
    $db->beginTransaction();
    try {
        $db->prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?')->execute([$id, (int)$user['id']]);
        $count = $db->prepare('SELECT COUNT(*) FROM post_likes WHERE post_id = ?');
        $count->execute([$id]);
        $total = (int)$count->fetchColumn();
        $db->prepare('UPDATE posts SET like_count = ?, updated_at = updated_at WHERE id = ?')->execute([$total, $id]);
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
    return ['like_count' => $total, 'liked' => false, 'message' => '已取消点赞'];
}
