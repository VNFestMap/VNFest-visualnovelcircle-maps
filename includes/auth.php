<?php
require_once __DIR__ . '/db.php';

const ROLE_HIERARCHY = [
    'visitor' => 0,
    'external' => 0.5,
    'member' => 1,
    'manager' => 2,
    'representative' => 3,
    'super_admin' => 4,
];

function initSession(): void {
    if (session_status() === PHP_SESSION_NONE) {
        // 7 天：与 makoquiz bind_token 有效期对齐，避免"关了浏览器就丢登录态"
        $lifetime = 604800;
        ini_set('session.cookie_lifetime', (string)$lifetime);
        ini_set('session.gc_maxlifetime', (string)$lifetime);
        ini_set('session.cookie_httponly', '1');
        ini_set('session.cookie_samesite', 'Lax');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.use_strict_mode', '1');
        // map.vnfest.top 与 www.map.vnfest.top 是同一站点。OAuth 从任一入口发起时，
        // 回调都可能回到 www；让两种主机名共享 PHP 会话，避免 Discord state 丢失。
        $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
        $host = preg_replace('/:\d+$/', '', $host);
        $migrateLegacyHostCookie = false;
        $sessionScopeMarker = 'VNFEST_SESSION_SCOPE';
        if (in_array($host, ['map.vnfest.top', 'www.map.vnfest.top'], true)) {
            ini_set('session.cookie_domain', '.map.vnfest.top');
            // 清理 2026-08-29 之前按单一主机保存的旧 cookie。Firefox 会按
            // cookie 创建时间把旧的 host-only PHPSESSID 与新的共享 cookie
            // 一起发送，PHP 可能因此恢复到未登录的旧 session，形成登录回跳。
            // 记住是否有旧 cookie，待 session_start() 完成后再发删除头。
            // PHP 可能会在 session_start() 中重写同名的 Set-Cookie 头。
            $migrateLegacyHostCookie = isset($_COOKIE[session_name()])
                && !isset($_COOKIE[$sessionScopeMarker]);
        }
        if (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') {
            ini_set('session.cookie_secure', '1');
        }
        session_start();
        if ($migrateLegacyHostCookie) {
            $secure = !empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off';
            // 不带 domain 才能精确删除 host-only cookie，不影响新的共享 cookie。
            setcookie(session_name(), '', [
                'expires' => time() - 42000,
                'path' => '/',
                'secure' => $secure,
                'httponly' => true,
                'samesite' => 'Lax',
            ]);
            // 旧 cookie 可能对应有效登录态；显式把当前 session 复制到共享域，
            // 避免清理旧 cookie 的同时把用户登出。
            setcookie(session_name(), session_id(), [
                'expires' => time() + $lifetime,
                'path' => '/',
                'domain' => '.map.vnfest.top',
                'secure' => $secure,
                'httponly' => true,
                'samesite' => 'Lax',
            ]);
            setcookie($sessionScopeMarker, 'shared', [
                'expires' => time() + $lifetime,
                'path' => '/',
                'domain' => '.map.vnfest.top',
                'secure' => $secure,
                'httponly' => true,
                'samesite' => 'Lax',
            ]);
        }
    }
}

function getCurrentUser(): ?array {
    initSession();
    if (!isset($_SESSION['user_id'])) {
        return null;
    }

    $db = getDB();
    $user = false;
    $variants = [
        'u.id, u.username, u.nickname, u.avatar_url, u.role, u.status, u.email, u.email_verified_at, u.password_hash, u.credentials_completed_at, u.qq_openid, u.discord_id, u.is_audit, u.profile_bio, u.membership_application_email_enabled, u.display_membership_id, u.language_preference',
        'u.id, u.username, u.nickname, u.avatar_url, u.role, u.status, u.email, u.email_verified_at, u.password_hash, u.qq_openid, u.discord_id, u.is_audit, u.profile_bio, u.membership_application_email_enabled, u.display_membership_id, u.language_preference',
        'u.id, u.username, u.nickname, u.avatar_url, u.role, u.status, u.email, u.email_verified_at, u.password_hash, u.qq_openid, u.discord_id, u.is_audit, u.profile_bio, u.membership_application_email_enabled, u.display_membership_id',
        'u.id, u.username, u.nickname, u.avatar_url, u.role, u.status, u.email, u.email_verified_at, u.password_hash, u.qq_openid, u.discord_id, u.is_audit, u.profile_bio, u.membership_application_email_enabled',
        'u.id, u.username, u.nickname, u.avatar_url, u.role, u.status, u.email, u.email_verified_at, u.password_hash, u.qq_openid, u.discord_id, u.is_audit',
        'u.id, u.username, u.nickname, u.avatar_url, u.role, u.status, u.email, u.email_verified_at, u.qq_openid, u.discord_id, u.is_audit, u.profile_bio, u.membership_application_email_enabled, u.display_membership_id, u.language_preference',
        'u.id, u.username, u.nickname, u.avatar_url, u.role, u.status, u.email, u.email_verified_at, u.qq_openid, u.discord_id, u.is_audit, u.profile_bio, u.membership_application_email_enabled, u.display_membership_id',
        'u.id, u.username, u.nickname, u.avatar_url, u.role, u.status, u.email, u.email_verified_at, u.qq_openid, u.discord_id, u.is_audit, u.profile_bio, u.membership_application_email_enabled',
        'u.id, u.username, u.nickname, u.avatar_url, u.role, u.status, u.email, u.email_verified_at, u.qq_openid, u.discord_id, u.is_audit, u.membership_application_email_enabled',
        'u.id, u.username, u.nickname, u.avatar_url, u.role, u.status, u.email, u.email_verified_at, u.qq_openid, u.discord_id, u.is_audit',
    ];
    foreach ($variants as $columns) {
        try {
            $stmt = $db->prepare("SELECT {$columns} FROM users u WHERE u.id = ? AND u.status = 'active'");
            $stmt->execute([$_SESSION['user_id']]);
            $user = $stmt->fetch();
            break;
        } catch (PDOException $e) {
            continue;
        }
    }
    if ($user) {
        $user['profile_bio'] = $user['profile_bio'] ?? '';
        $user['membership_application_email_enabled'] = $user['membership_application_email_enabled'] ?? 1;
        $user['display_membership_id'] = $user['display_membership_id'] ?? null;
        $user['language_preference'] = in_array(($user['language_preference'] ?? null), ['zh', 'ja'], true)
            ? $user['language_preference'] : null;
    }

    if (!$user) {
        unset($_SESSION['user_id']);
        return null;
    }

    return $user;
}

function requireLogin(): array {
    $user = getCurrentUser();
    if (!$user) {
        http_response_code(401);
        echo json_encode(['success' => false, 'message' => '请先登录', 'logged_in' => false]);
        exit();
    }
    return $user;
}

function requireRole(string $minRole): array {
    $user = requireLogin();
    $userLevel = ROLE_HIERARCHY[$user['role']] ?? 0;
    $requiredLevel = ROLE_HIERARCHY[$minRole] ?? 0;

    if ($userLevel < $requiredLevel) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => '权限不足']);
        exit();
    }
    return $user;
}

function requireAdmin(): array {
    initSession();

    // Try session-based auth first
    if (isset($_SESSION['user_id'])) {
        $user = getCurrentUser();
        if ($user && in_array($user['role'], ['manager', 'representative', 'super_admin'])) {
            return $user;
        }
        if ($user && hasAnyClubManagementRole($user)) {
            return $user;
        }
    }

    // Fallback to legacy token during transition
    if (defined('LEGACY_AUTH_ENABLED') && LEGACY_AUTH_ENABLED) {
        $headers = function_exists('getallheaders') ? getallheaders() : [];
        $token = $headers['X-Admin-Token'] ?? $headers['x-admin-token'] ?? '';
        if ($token === ADMIN_TOKEN) {
            return ['id' => 0, 'username' => 'legacy_admin', 'role' => 'super_admin', 'avatar_url' => ''];
        }
    }

    http_response_code(401);
    echo json_encode(['success' => false, 'message' => '未授权访问']);
    exit();
}

function hasAnyClubManagementRole(array $user): bool {
    $db = getDB();
    try {
        $stmt = $db->prepare(
            "SELECT id FROM club_memberships
             WHERE user_id = ?
               AND role IN ('representative', 'manager')
               AND status = 'active'
             LIMIT 1"
        );
        $stmt->execute([$user['id']]);
        return (bool)$stmt->fetch();
    } catch (Exception $e) {
        return false;
    }
}

function createSession(int $userId): void {
    initSession();
    session_regenerate_id(true);
    $_SESSION['user_id'] = $userId;

    $db = getDB();
    $db->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$userId]);

    $lifetime = defined('SESSION_LIFETIME') ? (int)SESSION_LIFETIME : 7200;
    $expiresAt = date('Y-m-d H:i:s', time() + $lifetime);

    $db->prepare(
        'INSERT INTO sessions (id, user_id, ip_address, user_agent, expires_at)
         VALUES (?, ?, ?, ?, ?)'
    )->execute([
        session_id(),
        $userId,
        $_SERVER['REMOTE_ADDR'] ?? '',
        $_SERVER['HTTP_USER_AGENT'] ?? '',
        $expiresAt,
    ]);
}

function destroySession(): void {
    initSession();
    if (isset($_SESSION['user_id'])) {
        $db = getDB();
        $db->prepare('UPDATE sessions SET is_valid = 0 WHERE id = ?')->execute([session_id()]);
    }
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
    }
    session_destroy();
}

/**
 * 检查当前用户是否有权限管理指定俱乐部
 * 超级管理员拥有全局权限，负责人/管理员可管理所属俱乐部
 */
function canManageClub(array $user, int $clubId): bool {
    if ($user['role'] === 'super_admin') {
        return true;
    }
    $db = getDB();
    $stmt = $db->prepare(
        "SELECT id FROM club_memberships WHERE user_id = ? AND club_id = ? AND role IN ('representative', 'manager') AND status = 'active'"
    );
    $stmt->execute([$user['id'], $clubId]);
    return (bool)$stmt->fetch();
}

function canManageClubInCountry(array $user, int $clubId, string $country): bool {
    if ($user['role'] === 'super_admin') {
        return true;
    }
    $db = getDB();
    try {
        $stmt = $db->prepare(
            "SELECT id FROM club_memberships
             WHERE user_id = ?
               AND club_id = ?
               AND country = ?
               AND role IN ('representative', 'manager')
               AND status = 'active'"
        );
        $stmt->execute([$user['id'], $clubId, $country]);
        return (bool)$stmt->fetch();
    } catch (Exception $e) {
        return canManageClub($user, $clubId);
    }
}

function hasAuditPermission(array $user): bool {
    if ($user['role'] === 'super_admin') return true;
    return !empty($user['is_audit']);
}
