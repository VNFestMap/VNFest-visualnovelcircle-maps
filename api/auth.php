<?php
// api/auth.php - 认证端点（本地用户名/密码注册登录）
// 动作: login_local, register_local, logout, me

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/rate_limit.php';
require_once __DIR__ . '/../includes/audit.php';
require_once __DIR__ . '/../includes/mailer.php';
require_once __DIR__ . '/../includes/notifications.php';
require_once __DIR__ . '/../includes/display_club.php';
require_once __DIR__ . '/../includes/club_code.php';
require_once __DIR__ . '/../includes/oauth_bangumi.php';
require_once __DIR__ . '/../includes/oauth_account.php';

$action = $_GET['action'] ?? '';

function registerCodeFile(): string {
    return __DIR__ . '/../data/register_email_codes.json';
}

function readRegisterCodes(): array {
    $file = registerCodeFile();
    if (!file_exists($file)) return [];
    $rows = json_decode(file_get_contents($file), true);
    return is_array($rows) ? $rows : [];
}

function writeRegisterCodes(array $rows): bool {
    $file = registerCodeFile();
    $dir = dirname($file);
    if (!is_dir($dir)) mkdir($dir, 0755, true);
    return file_put_contents($file, json_encode($rows, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX) !== false;
}

function passwordResetCodeFile(): string {
    return __DIR__ . '/../data/password_reset_codes.json';
}

function readPasswordResetCodes(): array {
    $file = passwordResetCodeFile();
    if (!file_exists($file)) return [];
    $rows = json_decode(file_get_contents($file), true);
    return is_array($rows) ? $rows : [];
}

function writePasswordResetCodes(array $rows): bool {
    $file = passwordResetCodeFile();
    $dir = dirname($file);
    if (!is_dir($dir)) mkdir($dir, 0755, true);
    return file_put_contents($file, json_encode($rows, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX) !== false;
}

function normalizeEmail(string $email): string {
    return strtolower(trim($email));
}

function maskEmail(string $email): string {
    $parts = explode('@', $email, 2);
    if (count($parts) !== 2) {
        return '';
    }

    $name = $parts[0];
    $domain = $parts[1];
    $first = function_exists('oauthAccountStringSubstr')
        ? oauthAccountStringSubstr($name, 0, 1)
        : substr($name, 0, 1);
    return $first . '***@' . $domain;
}

function publicAuthUser(array $user): array {
    $displayMembershipId = isset($user['display_membership_id']) && (int)$user['display_membership_id'] > 0
        ? (int)$user['display_membership_id'] : null;
    $displayClub = null;
    if ((int)($user['id'] ?? 0) > 0) {
        $displayClub = displayClubForUser(getDB(), (int)$user['id']);
    }
    $bangumiBinding = bangumiPublicBindingForUser((int)($user['id'] ?? 0));
    $hasPassword = oauthAccountHasPassword($user);
    $credentialsComplete = $hasPassword && !empty($user['email_verified_at']);
    $hasSocialProvider = !empty($user['qq_openid']) || !empty($user['discord_id']);
    return [
        'id' => (int)($user['id'] ?? 0),
        'username' => $user['username'] ?? '',
        'nickname' => $user['nickname'] ?? ($user['username'] ?? ''),
        'avatar_url' => $user['avatar_url'] ?? '',
        'role' => $user['role'] ?? 'visitor',
        'email' => $user['email'] ?? '',
        'email_verified' => !empty($user['email_verified_at']),
        'has_password' => $hasPassword,
        'credentials_complete' => $credentialsComplete,
        'needs_credential_upgrade' => $hasSocialProvider && !$credentialsComplete,
        'can_set_password' => !$hasPassword && !empty($user['email_verified_at']),
        // 仅对已经完成社交凭证升级的账号锁定邮箱；本地注册账号继续保留原有规则。
        'can_unbind_email' => !$hasSocialProvider || !$credentialsComplete,
        'qq_bound' => !empty($user['qq_openid']),
        'discord_bound' => !empty($user['discord_id']),
        'bangumi_bound' => $bangumiBinding['bound'],
        'bangumi_username' => $bangumiBinding['username'],
        'profile_bio' => $user['profile_bio'] ?? '',
        'is_audit' => (int)($user['is_audit'] ?? 0),
        'membership_application_email_enabled' => (int)($user['membership_application_email_enabled'] ?? 1) === 1,
        'display_membership_id' => $displayMembershipId,
        'display_club' => $displayClub,
        'language_preference' => in_array(($user['language_preference'] ?? null), ['zh', 'ja'], true)
            ? $user['language_preference'] : null,
    ];
}

function authRequireSameOrigin(): void {
    $requestHost = strtolower(trim((string)($_SERVER['HTTP_HOST'] ?? '')));
    if ($requestHost === '') {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => '请求来源无效']);
        exit();
    }
    $requestScheme = !empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off' ? 'https' : 'http';
    $forwardedScheme = strtolower(trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0] ?? ''));
    if (in_array($forwardedScheme, ['http', 'https'], true)) $requestScheme = $forwardedScheme;
    foreach (['HTTP_ORIGIN', 'HTTP_REFERER'] as $header) {
        $value = trim((string)($_SERVER[$header] ?? ''));
        if ($value === '') continue;
        $authority = strtolower((string)(parse_url($value, PHP_URL_HOST) ?? ''));
        $port = parse_url($value, PHP_URL_PORT);
        if ($port !== null) $authority .= ':' . (int)$port;
        $scheme = strtolower((string)(parse_url($value, PHP_URL_SCHEME) ?? ''));
        if ($authority !== $requestHost || !in_array($scheme, ['http', 'https'], true) || $scheme !== $requestScheme) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '请求来源无效']);
            exit();
        }
        return;
    }
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => '请求来源无效']);
    exit();
}

function authEnsureMembershipApplicationEmailPreferenceColumn(PDO $db): void {
    try {
        $db->query('SELECT membership_application_email_enabled FROM users LIMIT 1');
        return;
    } catch (Throwable $e) {
        // 旧部署按默认开启补齐；MySQL 与 SQLite 均接受该列定义。
    }

    try {
        $db->exec('ALTER TABLE users ADD COLUMN membership_application_email_enabled TINYINT(1) NOT NULL DEFAULT 1');
    } catch (Throwable $e) {
        error_log('Unable to add membership application email preference column: ' . $e->getMessage());
    }
}

function authEnsureLanguagePreferenceColumn(PDO $db): void {
    try {
        $db->query('SELECT language_preference FROM users LIMIT 1');
        return;
    } catch (Throwable $e) {
        // Older deployments receive the additive nullable preference column on first write.
    }

    try {
        $db->exec('ALTER TABLE users ADD COLUMN language_preference VARCHAR(5) NULL DEFAULT NULL');
    } catch (Throwable $e) {
        error_log('Unable to add language preference column: ' . $e->getMessage());
    }
}

function authJsonInput(): array {
    $input = json_decode(file_get_contents('php://input'), true);
    return is_array($input) ? $input : [];
}

function authOAuthError(string $code, string $message, int $status = 422): void {
    http_response_code($status);
    echo json_encode([
        'success' => false,
        'code' => $code,
        'message' => $message,
    ]);
    exit();
}

function authOAuthPendingContext(PDO $db): array {
    $context = oauthAccountLoadPending($db);
    if ($context) {
        return ['success' => true, 'context' => $context];
    }

    $errorCode = oauthAccountTakePendingError() ?: 'OAUTH_PENDING_NOT_FOUND';
    return [
        'success' => false,
        'code' => $errorCode,
        'message' => $errorCode === 'OAUTH_PENDING_EXPIRED'
            ? '本次授权已过期，请重新登录'
            : '没有找到待完成的授权，请重新登录',
    ];
}

function authOAuthCodeHash(string $code): string {
    initSession();
    return hash_hmac('sha256', $code, session_id());
}

function authOAuthChallengeIsVerified(array $row): bool {
    return !empty($row['verified_at']) && empty($row['consumed_at']);
}

function authOAuthEmailUser(PDO $db, string $email): ?array {
    $stmt = $db->prepare('SELECT id, status, email, email_verified_at FROM users WHERE email = ? LIMIT 1');
    $stmt->execute([$email]);
    $user = $stmt->fetch();
    return $user ?: null;
}

function authOAuthUserHasAlternativeLogin(PDO $db, int $userId, string $provider): bool {
    $stmt = $db->prepare(
        'SELECT password_hash, email_verified_at, qq_openid, discord_id FROM users WHERE id = ? LIMIT 1'
    );
    $stmt->execute([$userId]);
    $user = $stmt->fetch();
    if (!$user) return false;

    if (oauthAccountHasPassword($user)) return true;
    // 已验证邮箱可以通过现有密码找回流程恢复本地登录，因此也是可保留的恢复方式。
    if (!empty($user['email_verified_at'])) return true;
    $otherProvider = $provider === 'qq' ? 'discord_id' : 'qq_openid';
    return trim((string)($user[$otherProvider] ?? '')) !== '';
}

function authOAuthCredentialStateUpdate(PDO $db, int $userId): void {
    $db->prepare(
        "UPDATE users
         SET credentials_completed_at = CASE
             WHEN COALESCE(password_hash, '') <> '' AND email_verified_at IS NOT NULL
             THEN COALESCE(credentials_completed_at, CURRENT_TIMESTAMP)
             ELSE credentials_completed_at
         END,
         updated_at = CURRENT_TIMESTAMP
         WHERE id = ?"
    )->execute([$userId]);
}

switch ($action) {
    case 'register_local':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        checkRateLimit('register_local', 5, 1); // 每分钟最多 5 次注册

        $input = json_decode(file_get_contents('php://input'), true);
        $username = trim($input['username'] ?? '');
        $password = $input['password'] ?? '';
        $email = normalizeEmail($input['email'] ?? '');
        $code = trim($input['code'] ?? '');
        $clubBindCode = trim((string)($input['club_code'] ?? ''));

        // 验证用户名
        if (!preg_match('/^[a-zA-Z0-9_\x{4e00}-\x{9fff}]{2,20}$/u', $username)) {
            echo json_encode(['success' => false, 'message' => '用户名需为 2-20 位的中文、字母、数字或下划线']);
            exit();
        }
        // 验证密码
        if (strlen($password) < 6 || strlen($password) > 128) {
            echo json_encode(['success' => false, 'message' => '密码需为 6-128 位']);
            exit();
        }

        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            echo json_encode(['success' => false, 'message' => '邮箱格式不正确']);
            exit();
        }
        if (!preg_match('/^\d{6}$/', $code)) {
            echo json_encode(['success' => false, 'message' => '请输入 6 位邮箱验证码']);
            exit();
        }

        $db = getDB();

        // 绑定码是可选的；如果填写，则在创建账号前准备好兼容旧部署所需的列。
        if ($clubBindCode !== '') {
            if (strlen($clubBindCode) > 255) {
                echo json_encode(['success' => false, 'message' => '同好会绑定码无效']);
                exit();
            }
            clubCodeEnsureMembershipColumns($db);
        }

        // 检查重复用户名
        $stmt = $db->prepare('SELECT id FROM users WHERE username = ?');
        $stmt->execute([$username]);
        if ($stmt->fetch()) {
            echo json_encode(['success' => false, 'message' => '用户名已被注册']);
            exit();
        }

        $stmt = $db->prepare('SELECT id FROM users WHERE email = ?');
        $stmt->execute([$email]);
        if ($stmt->fetch()) {
            echo json_encode(['success' => false, 'message' => '该邮箱已被注册']);
            exit();
        }

        $codes = readRegisterCodes();
        $matchedIndex = null;
        $now = time();
        foreach ($codes as $i => $row) {
            if (($row['email'] ?? '') === $email && ($row['code'] ?? '') === $code && empty($row['used']) && (int)($row['expires_at'] ?? 0) > $now) {
                $matchedIndex = $i;
                break;
            }
        }
        if ($matchedIndex === null) {
            echo json_encode(['success' => false, 'message' => '验证码无效或已过期']);
            exit();
        }

        $hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
        $clubBinding = null;
        try {
            $db->beginTransaction();

            $stmt = $db->prepare(
                "INSERT INTO users
                    (username, nickname, password_hash, role, status, avatar_url, email, email_verified_at,
                     credentials_completed_at, created_at, updated_at, last_login_at)
                 VALUES (?, ?, ?, 'visitor', 'active', '', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            );
            $stmt->execute([$username, $username, $hash, $email]);
            $userId = $db->lastInsertId();

            if ($clubBindCode !== '') {
                $clubBinding = clubCodeBindUser($db, (int)$userId, $clubBindCode);
                if (!$clubBinding['success']) {
                    throw new ClubCodeBindingException($clubBinding['message']);
                }
            }

            $codes[$matchedIndex]['used'] = true;
            $codes[$matchedIndex]['used_at'] = time();
            writeRegisterCodes($codes);
            $db->commit();
        } catch (ClubCodeBindingException $e) {
            if ($db->inTransaction()) $db->rollBack();
            http_response_code(422);
            echo json_encode(['success' => false, 'message' => $e->getMessage()]);
            exit();
        } catch (Throwable $e) {
            if ($db->inTransaction()) $db->rollBack();
            error_log('Unable to complete local registration: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => '注册失败，请稍后再试']);
            exit();
        }

        createSession($userId);
        $registerAudit = ['provider' => 'local', 'email' => $email];
        if ($clubBinding) {
            $registerAudit['club_id'] = $clubBinding['club_id'];
            $registerAudit['club_country'] = $clubBinding['country'];
        }
        logAction('user.register', 'user', $userId, $registerAudit);
        backfillAnnouncements((int)$userId);

        $response = [
            'success' => true,
            'message' => '注册成功',
            'user' => publicAuthUser([
                'id' => (int)$userId,
                'username' => $username,
                'nickname' => $username,
                'avatar_url' => '',
                'role' => 'visitor',
                'email' => $email,
                'email_verified_at' => date('Y-m-d H:i:s'),
                'password_hash' => $hash,
                'credentials_completed_at' => date('Y-m-d H:i:s'),
                'profile_bio' => '',
            ])
        ];
        if ($clubBinding) {
            logAction('redeem_club_code', 'club_verification_codes', $clubBinding['code_id'], [
                'club_id' => $clubBinding['club_id'],
                'country' => $clubBinding['country'],
                'registration' => true,
            ]);
            $response['club_binding'] = [
                'club_id' => $clubBinding['club_id'],
                'country' => $clubBinding['country'],
                'club_name' => $clubBinding['club_name'],
            ];
        }
        echo json_encode($response);
        exit();

    case 'send_register_code':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        checkRateLimit('send_register_code', 3, 1);

        $input = json_decode(file_get_contents('php://input'), true);
        $email = normalizeEmail($input['email'] ?? '');

        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            echo json_encode(['success' => false, 'message' => '邮箱格式不正确']);
            exit();
        }

        $db = getDB();
        $stmt = $db->prepare('SELECT id FROM users WHERE email = ?');
        $stmt->execute([$email]);
        if ($stmt->fetch()) {
            echo json_encode(['success' => false, 'message' => '该邮箱已被注册']);
            exit();
        }

        $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $codes = array_values(array_filter(readRegisterCodes(), function ($row) use ($email) {
            return ($row['email'] ?? '') !== $email || !empty($row['used']) || (int)($row['expires_at'] ?? 0) <= time();
        }));
        $codes[] = [
            'email' => $email,
            'code' => $code,
            'used' => false,
            'expires_at' => time() + 300,
            'created_at' => time(),
        ];
        writeRegisterCodes($codes);

        $subject = ($subjectPrefix ?? '') . '邮箱验证码';
        $message = "您的注册验证码是：{$code}\n\n";
        $message .= "验证码 5 分钟内有效。如果不是您本人操作，请忽略此邮件。\n";
        $mailSent = sendMail($email, $subject, $message);

        logAction('user.send_register_code', 'user', null, ['email' => $email, 'mail_sent' => $mailSent]);
        if (!$mailSent) {
            echo json_encode(['success' => false, 'message' => '验证码发送失败，请稍后再试']);
            exit();
        }

        echo json_encode([
            'success' => true,
            'message' => '验证码已发送至 ' . maskEmail($email),
        ]);
        exit();

    case 'send_password_reset_code':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        checkRateLimit('send_password_reset_code', 3, 1);

        $input = json_decode(file_get_contents('php://input'), true);
        $email = normalizeEmail($input['email'] ?? '');

        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            echo json_encode(['success' => false, 'message' => '邮箱格式不正确']);
            exit();
        }

        $genericMessage = '如果该邮箱已绑定账号，验证码将发送至 ' . maskEmail($email);
        $db = getDB();
        $stmt = $db->prepare("SELECT id, username FROM users WHERE email = ? AND status = 'active' LIMIT 1");
        $stmt->execute([$email]);
        $user = $stmt->fetch();

        if (!$user) {
            logAction('user.send_password_reset_code', 'user', null, ['email' => $email, 'mail_sent' => false, 'found' => false]);
            echo json_encode(['success' => true, 'message' => $genericMessage]);
            exit();
        }

        $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $codes = array_values(array_filter(readPasswordResetCodes(), function ($row) use ($email) {
            return ($row['email'] ?? '') !== $email || !empty($row['used']) || (int)($row['expires_at'] ?? 0) <= time();
        }));
        $codes[] = [
            'email' => $email,
            'user_id' => (int)$user['id'],
            'code' => $code,
            'used' => false,
            'expires_at' => time() + 300,
            'created_at' => time(),
        ];
        writePasswordResetCodes($codes);

        $subject = ($subjectPrefix ?? '') . '密码找回验证码';
        $message = "您的密码找回验证码是：{$code}\n\n";
        $message .= "验证码 5 分钟内有效。若不是您本人操作，请忽略此邮件并尽快检查账号安全。\n";
        $mailSent = sendMail($email, $subject, $message);

        logAction('user.send_password_reset_code', 'user', (int)$user['id'], ['email' => $email, 'mail_sent' => $mailSent, 'found' => true]);
        if (!$mailSent) {
            echo json_encode(['success' => false, 'message' => '验证码发送失败，请稍后再试']);
            exit();
        }

        echo json_encode(['success' => true, 'message' => $genericMessage]);
        exit();

    case 'reset_password':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        checkRateLimit('reset_password', 5, 1);

        $input = json_decode(file_get_contents('php://input'), true);
        $email = normalizeEmail($input['email'] ?? '');
        $code = trim($input['code'] ?? '');
        $newPassword = $input['new_password'] ?? '';

        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            echo json_encode(['success' => false, 'message' => '邮箱格式不正确']);
            exit();
        }
        if (!preg_match('/^\d{6}$/', $code)) {
            echo json_encode(['success' => false, 'message' => '验证码为 6 位数字']);
            exit();
        }
        if (strlen($newPassword) < 6 || strlen($newPassword) > 128) {
            echo json_encode(['success' => false, 'message' => '新密码需为 6-128 位']);
            exit();
        }

        $db = getDB();
        $stmt = $db->prepare("SELECT id FROM users WHERE email = ? AND status = 'active' LIMIT 1");
        $stmt->execute([$email]);
        $user = $stmt->fetch();
        if (!$user) {
            echo json_encode(['success' => false, 'message' => '验证码无效或已过期']);
            exit();
        }

        $codes = readPasswordResetCodes();
        $matchedIndex = null;
        $now = time();
        foreach ($codes as $i => $row) {
            if (
                (int)($row['user_id'] ?? 0) === (int)$user['id'] &&
                ($row['email'] ?? '') === $email &&
                ($row['code'] ?? '') === $code &&
                empty($row['used']) &&
                (int)($row['expires_at'] ?? 0) > $now
            ) {
                $matchedIndex = $i;
                break;
            }
        }
        if ($matchedIndex === null) {
            echo json_encode(['success' => false, 'message' => '验证码无效或已过期']);
            exit();
        }

        $newHash = password_hash($newPassword, PASSWORD_BCRYPT, ['cost' => 12]);
        $db->prepare("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            ->execute([$newHash, $user['id']]);
        authOAuthCredentialStateUpdate($db, (int)$user['id']);
        $db->prepare("UPDATE sessions SET is_valid = 0 WHERE user_id = ?")->execute([$user['id']]);

        $codes[$matchedIndex]['used'] = true;
        $codes[$matchedIndex]['used_at'] = time();
        writePasswordResetCodes($codes);

        logAction('user.reset_password', 'user', (int)$user['id'], ['email' => $email]);
        echo json_encode(['success' => true, 'message' => '密码已重置，请使用新密码登录']);
        exit();

    case 'login_local':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        checkRateLimit('login_local', 10, 1); // 每分钟最多 10 次登录尝试

        $input = json_decode(file_get_contents('php://input'), true);
        $username = trim($input['username'] ?? '');
        $password = $input['password'] ?? '';

        if (!$username || !$password) {
            echo json_encode(['success' => false, 'message' => '请输入用户名和密码']);
            exit();
        }

        $db = getDB();

        // 先按用户名查找，再按邮箱查找
        $stmt = $db->prepare('SELECT * FROM users WHERE username = ? AND status = \'active\'');
        $stmt->execute([$username]);
        $user = $stmt->fetch();

        if (!$user) {
            $stmt = $db->prepare('SELECT * FROM users WHERE email = ? AND status = \'active\'');
            $stmt->execute([$username]);
            $user = $stmt->fetch();
        }

        if (!$user || !password_verify($password, $user['password_hash'] ?? '')) {
            echo json_encode(['success' => false, 'message' => '用户名或密码错误']);
            exit();
        }

        // 更新最后登录时间
        $db->prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?")
            ->execute([$user['id']]);

        createSession($user['id']);
        logAction('user.login', 'user', $user['id'], ['provider' => 'local']);

        // 加载绑定信息
        $stmt = $db->prepare("SELECT club_id, role, status FROM club_memberships WHERE user_id = ? AND status = 'active'");
        $stmt->execute([$user['id']]);

        echo json_encode([
            'success' => true,
            'message' => '登录成功',
            'user' => publicAuthUser($user),
            'memberships' => $stmt->fetchAll(),
        ]);
        exit();

    case 'logout':
        $user = getCurrentUser();
        if ($user) {
            logAction('user.logout', 'user', $user['id']);
        }
        destroySession();
        echo json_encode(['success' => true, 'message' => '已退出登录']);
        exit();

    case 'me':
        $user = getCurrentUser();
        if ($user) {
            // 加载用户绑定信息（兼容 country 列尚未创建的情况）
            $db = getDB();
            $memberships = [];
            try {
                $stmt = $db->prepare(
                    "SELECT id, club_id, country, role, status FROM club_memberships WHERE user_id = ? AND status = 'active'"
                );
                $stmt->execute([$user['id']]);
                $memberships = $stmt->fetchAll();
            } catch (Exception $e) {
                // country 列不存在时回退
                $stmt = $db->prepare(
                    "SELECT id, club_id, role, status FROM club_memberships WHERE user_id = ? AND status = 'active'"
                );
                $stmt->execute([$user['id']]);
                $memberships = $stmt->fetchAll();
            }

            echo json_encode([
                'logged_in' => true,
                'user' => publicAuthUser($user),
                'memberships' => $memberships,
            ]);
        } else {
            echo json_encode([
                'logged_in' => false,
                'user' => null,
                'memberships' => [],
            ]);
        }
        exit();

    case 'change_password':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        $user = requireLogin();
        checkRateLimit('change_password', 3, 1);

        $input = json_decode(file_get_contents('php://input'), true);
        $currentPassword = $input['current_password'] ?? '';
        $newPassword = $input['new_password'] ?? '';

        if (strlen($newPassword) < 6 || strlen($newPassword) > 128) {
            echo json_encode(['success' => false, 'message' => '新密码需为 6-128 位']);
            exit();
        }

        $db = getDB();
        $stmt = $db->prepare('SELECT password_hash FROM users WHERE id = ?');
        $stmt->execute([$user['id']]);
        $row = $stmt->fetch();

        if (!$row || !password_verify($currentPassword, $row['password_hash'] ?? '')) {
            echo json_encode(['success' => false, 'message' => '当前密码错误']);
            exit();
        }

        $newHash = password_hash($newPassword, PASSWORD_BCRYPT, ['cost' => 12]);
        $db->prepare("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            ->execute([$newHash, $user['id']]);
        authOAuthCredentialStateUpdate($db, (int)$user['id']);

        logAction('user.change_password', 'user', $user['id']);
        echo json_encode(['success' => true, 'message' => '密码修改成功']);
        exit();

    case 'set_password':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        authRequireSameOrigin();
        $user = requireLogin();
        checkRateLimit('set_password', 5, 1);

        $input = authJsonInput();
        $newPassword = (string)($input['new_password'] ?? '');
        $confirmation = (string)($input['new_password_confirmation'] ?? '');
        if (strlen($newPassword) < 6 || strlen($newPassword) > 128) {
            authOAuthError('PASSWORD_INVALID', '新密码需为 6-128 位');
        }
        if ($newPassword !== $confirmation) {
            authOAuthError('PASSWORD_MISMATCH', '两次输入的密码不一致');
        }

        $db = getDB();
        $stmt = $db->prepare('SELECT password_hash, email_verified_at FROM users WHERE id = ? LIMIT 1');
        $stmt->execute([(int)$user['id']]);
        $securityUser = $stmt->fetch() ?: [];
        if (oauthAccountHasPassword($securityUser)) {
            authOAuthError('PASSWORD_ALREADY_SET', '当前账号已有密码，请使用修改密码功能');
        }
        if (empty($securityUser['email_verified_at'])) {
            authOAuthError('EMAIL_VERIFICATION_REQUIRED', '请先验证邮箱，再设置密码');
        }

        $newHash = password_hash($newPassword, PASSWORD_BCRYPT, ['cost' => 12]);
        $passwordUpdate = $db->prepare(
            "UPDATE users SET password_hash = ?, credentials_completed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND COALESCE(password_hash, '') = '' AND email_verified_at IS NOT NULL"
        );
        $passwordUpdate->execute([$newHash, (int)$user['id']]);
        if ($passwordUpdate->rowCount() !== 1) {
            authOAuthError('PASSWORD_ALREADY_SET', '当前账号已有密码，请使用修改密码功能');
        }

        logAction('user.set_password', 'user', (int)$user['id']);
        echo json_encode(['success' => true, 'message' => '密码设置成功']);
        exit();

    case 'send_code':
        // 发送邮箱验证码
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        $user = requireLogin();
        checkRateLimit('send_code', 3, 1); // 每分钟最多 3 次

        $input = json_decode(file_get_contents('php://input'), true);
        $email = normalizeEmail($input['email'] ?? '');

        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            echo json_encode(['success' => false, 'message' => '邮箱格式不正确']);
            exit();
        }

        // 检查邮箱唯一性
        $db = getDB();
        $stmt = $db->prepare('SELECT id FROM users WHERE email = ? AND id != ?');
        $stmt->execute([$email, $user['id']]);
        if ($stmt->fetch()) {
            echo json_encode(['success' => false, 'message' => '该邮箱已被其他账号绑定']);
            exit();
        }

        // 生成 6 位验证码
        $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);

        // 使之前的验证码失效
        $db->prepare("UPDATE email_verifications SET used = 1 WHERE user_id = ? AND email = ? AND used = 0")
            ->execute([$user['id'], $email]);

        // 存储新验证码（5 分钟有效）
        $expiresAt = date('Y-m-d H:i:s', time() + 300);
        $stmt = $db->prepare(
            "INSERT INTO email_verifications (user_id, email, code, expires_at) VALUES (?, ?, ?, ?)"
        );
        $stmt->execute([$user['id'], $email, $code, $expiresAt]);

        // 发送邮件
        $subject = ($subjectPrefix ?? '') . '邮箱验证码';
        $message = "您的验证码是：{$code}\n\n";
        $message .= "验证码 5 分钟内有效。如果不是您本人操作，请忽略此邮件。\n";
        $mailSent = sendMail($email, $subject, $message);

        logAction('user.send_code', 'user', $user['id'], ['email' => $email, 'mail_sent' => $mailSent]);

        if (!$mailSent) {
            echo json_encode(['success' => false, 'message' => '验证码发送失败，请稍后再试']);
            exit();
        }

        echo json_encode([
            'success' => true,
            'message' => '验证码已发送至 ' . maskEmail($email),
        ]);
        exit();

    case 'bind_email':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        $user = requireLogin();
        checkRateLimit('bind_email', 5, 1);

        $input = json_decode(file_get_contents('php://input'), true);
        $email = normalizeEmail((string)($input['email'] ?? ''));
        $code = trim($input['code'] ?? '');

        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            echo json_encode(['success' => false, 'message' => '邮箱格式不正确']);
            exit();
        }

        if (!preg_match('/^\d{6}$/', $code)) {
            echo json_encode(['success' => false, 'message' => '验证码格式不正确']);
            exit();
        }

        $db = getDB();

        // 验证验证码
        $stmt = $db->prepare(
            "SELECT id FROM email_verifications WHERE user_id = ? AND email = ? AND code = ? AND used = 0 AND expires_at > CURRENT_TIMESTAMP"
        );
        $stmt->execute([$user['id'], $email, $code]);
        $verification = $stmt->fetch();

        if (!$verification) {
            echo json_encode(['success' => false, 'message' => '验证码无效或已过期']);
            exit();
        }

        // 检查邮箱唯一性
        $stmt = $db->prepare('SELECT id FROM users WHERE email = ? AND id != ?');
        $stmt->execute([$email, $user['id']]);
        if ($stmt->fetch()) {
            echo json_encode(['success' => false, 'message' => '该邮箱已被其他账号绑定']);
            exit();
        }

        // 验证码只在所有更新条件通过后消耗，避免邮箱冲突导致验证码被无效占用。
        $db->prepare("UPDATE email_verifications SET used = 1 WHERE id = ?")->execute([$verification['id']]);

        $db->prepare(
            "UPDATE users SET email = ?, email_verified_at = CURRENT_TIMESTAMP,
                    credentials_completed_at = CASE
                        WHEN COALESCE(password_hash, '') <> '' THEN COALESCE(credentials_completed_at, CURRENT_TIMESTAMP)
                        ELSE credentials_completed_at
                    END,
                    updated_at = CURRENT_TIMESTAMP
             WHERE id = ?"
        )->execute([$email, $user['id']]);

        logAction('user.bind_email', 'user', $user['id'], ['email' => $email]);
        echo json_encode(['success' => true, 'message' => '邮箱绑定成功', 'email' => $email]);
        exit();

    case 'unbind_email':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        $user = requireLogin();

        $db = getDB();
        $stmt = $db->prepare(
            'SELECT password_hash, email_verified_at, qq_openid, discord_id, credentials_completed_at
             FROM users WHERE id = ? LIMIT 1'
        );
        $stmt->execute([(int)$user['id']]);
        $securityUser = $stmt->fetch() ?: [];
        $credentialsComplete = oauthAccountCredentialsComplete($securityUser);
        $hasSocialProvider = trim((string)($securityUser['qq_openid'] ?? '')) !== ''
            || trim((string)($securityUser['discord_id'] ?? '')) !== '';
        if ($hasSocialProvider && $credentialsComplete) {
            authOAuthError('EMAIL_REQUIRED', '已完成登录凭证的账号不能解绑邮箱');
        }
        $db->prepare(
            "UPDATE users SET email = NULL, email_verified_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )->execute([$user['id']]);

        logAction('user.unbind_email', 'user', $user['id']);
        echo json_encode(['success' => true, 'message' => '邮箱已解绑']);
        exit();

    case 'update_profile':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);

        $nickname = isset($input['nickname']) ? trim($input['nickname']) : null;
        $bio = isset($input['profile_bio']) ? trim($input['profile_bio']) : null;

        if ($nickname === null && $bio === null) {
            echo json_encode(['success' => false, 'message' => '没有需要更新的字段']);
            exit();
        }

        // 先验证所有字段，再执行更新
        if ($nickname !== null && (mb_strlen($nickname) < 1 || mb_strlen($nickname) > 30)) {
            echo json_encode(['success' => false, 'message' => '昵称需为 1-30 个字符']);
            exit();
        }
        if ($bio !== null && mb_strlen($bio) > 300) {
            echo json_encode(['success' => false, 'message' => '个性签名不能超过 300 个字符']);
            exit();
        }

        $db = getDB();
        if ($nickname !== null) {
            $db->prepare("UPDATE users SET nickname = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                ->execute([$nickname, $user['id']]);
        }
        if ($bio !== null) {
            $db->prepare("UPDATE users SET profile_bio = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                ->execute([$bio, $user['id']]);
        }

        logAction('user.update_profile', 'user', $user['id'], ['nickname' => $nickname, 'bio' => $bio]);
        echo json_encode(['success' => true, 'message' => '已更新']);
        exit();

    case 'update_display_club':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            http_response_code(405);
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        authRequireSameOrigin();
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input) || !array_key_exists('membership_id', $input)) {
            http_response_code(422);
            echo json_encode(['success' => false, 'message' => '请选择有效的代表同好会']);
            exit();
        }
        $rawMembershipId = $input['membership_id'];
        if ($rawMembershipId !== null && (!is_int($rawMembershipId) || $rawMembershipId <= 0)) {
            http_response_code(422);
            echo json_encode(['success' => false, 'message' => '代表同好会设置无效']);
            exit();
        }
        $membershipId = $rawMembershipId === null ? null : (int)$rawMembershipId;
        $db = getDB();
        $membership = null;
        $displayClub = null;
        try {
            $db->beginTransaction();
            if ($membershipId !== null) {
                $membership = displayClubSelectableMembership($db, (int)$user['id'], $membershipId, true);
                if (!$membership) {
                    $db->rollBack();
                    http_response_code(422);
                    echo json_encode(['success' => false, 'message' => '只能选择自己的正式活跃会籍']);
                    exit();
                }
                $displayClub = displayClubPublicFromMembership($membership);
                if (!$displayClub) {
                    $db->rollBack();
                    http_response_code(503);
                    echo json_encode(['success' => false, 'message' => '同好会资料暂不可用，请稍后重试']);
                    exit();
                }
            }
            $userLock = $db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' ? ' FOR UPDATE' : '';
            $stmt = $db->prepare('SELECT display_membership_id FROM users WHERE id = ? LIMIT 1' . $userLock);
            $stmt->execute([(int)$user['id']]);
            $oldValue = $stmt->fetchColumn();
            $oldMembershipId = $oldValue === false || $oldValue === null ? null : (int)$oldValue;
            if ($oldMembershipId !== $membershipId) {
                $oldMembership = null;
                if ($oldMembershipId !== null) {
                    $oldStmt = $db->prepare(
                        "SELECT club_id, COALESCE(country, 'china') AS country FROM club_memberships WHERE id = ? AND user_id = ? LIMIT 1"
                    );
                    $oldStmt->execute([$oldMembershipId, (int)$user['id']]);
                    $oldMembership = $oldStmt->fetch(PDO::FETCH_ASSOC) ?: null;
                }
                $db->prepare('UPDATE users SET display_membership_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                    ->execute([$membershipId, (int)$user['id']]);
                logAction('user.update_display_club', 'user', (int)$user['id'], [
                    'old' => displayClubMembershipKey($oldMembership),
                    'new' => displayClubMembershipKey($membership),
                ]);
            }
            $db->commit();
        } catch (Throwable $e) {
            if ($db->inTransaction()) $db->rollBack();
            error_log('Unable to update display club: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => '代表同好会保存失败']);
            exit();
        }

        echo json_encode([
            'success' => true,
            'message' => $membershipId === null ? '已取消展示代表同好会' : '代表同好会已更新',
            'display_club' => $displayClub,
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit();

    case 'update_membership_application_email_preference':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $enabled = filter_var($input['enabled'] ?? null, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
        if ($enabled === null) {
            echo json_encode(['success' => false, 'message' => '邮件提醒设置无效']);
            exit();
        }

        $db = getDB();
        authEnsureMembershipApplicationEmailPreferenceColumn($db);
        try {
            $db->prepare('UPDATE users SET membership_application_email_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                ->execute([$enabled ? 1 : 0, $user['id']]);
            logAction('user.update_membership_application_email_preference', 'user', $user['id'], [
                'enabled' => $enabled,
            ]);
        } catch (Throwable $e) {
            error_log('Unable to update membership application email preference: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => '邮件提醒设置保存失败']);
            exit();
        }

        echo json_encode([
            'success' => true,
            'message' => $enabled ? '已开启同好会申请邮件提醒' : '已关闭同好会申请邮件提醒',
            'enabled' => $enabled,
        ]);
        exit();

    case 'update_language_preference':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            http_response_code(405);
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        authRequireSameOrigin();
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $language = is_array($input) ? ($input['language'] ?? null) : null;
        if (!is_string($language) || !in_array($language, ['zh', 'ja'], true)) {
            http_response_code(422);
            echo json_encode(['success' => false, 'message' => '语言设置无效']);
            exit();
        }

        $db = getDB();
        authEnsureLanguagePreferenceColumn($db);
        try {
            $db->prepare('UPDATE users SET language_preference = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                ->execute([$language, $user['id']]);
            logAction('user.update_language_preference', 'user', $user['id'], [
                'language' => $language,
            ]);
        } catch (Throwable $e) {
            error_log('Unable to update language preference: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => '语言设置保存失败']);
            exit();
        }

        echo json_encode([
            'success' => true,
            'language_preference' => $language,
        ]);
        exit();

    case 'oauth_pending':
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            authOAuthError('METHOD_NOT_ALLOWED', '仅支持 GET 请求', 405);
        }
        initSession();
        try {
            $db = getDB();
            $pendingResult = authOAuthPendingContext($db);
            if (!$pendingResult['success']) {
                authOAuthError($pendingResult['code'], $pendingResult['message'], 409);
            }

            $pendingContext = $pendingResult['context'];
            $pending = $pendingContext['pending'];
            $meta = oauthAccountProviderMeta((string)$pending['provider']);
            echo json_encode([
                'success' => true,
                'pending' => true,
                'flow' => $pending['flow'],
                'provider' => $meta['provider'],
                'provider_label' => $meta['label'],
                'display_name' => $pending['username'] ?? '',
                'avatar' => $pending['avatar_url'] ?? '',
                'return_to' => oauthAccountSafeReturnTo($pending['return_to'] ?? null, $meta['default_return']),
            ]);
        } catch (Throwable $error) {
            error_log('Unable to load OAuth pending challenge: ' . $error->getMessage());
            authOAuthError('OAUTH_SETUP_UNAVAILABLE', '登录服务暂时不可用，请稍后再试', 503);
        }
        exit();

    case 'oauth_send_code':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            authOAuthError('METHOD_NOT_ALLOWED', '仅支持 POST 请求', 405);
        }
        authRequireSameOrigin();
        checkRateLimit('oauth_send_code', 3, 1);

        try {
            $db = getDB();
            $pendingResult = authOAuthPendingContext($db);
            if (!$pendingResult['success']) {
                authOAuthError($pendingResult['code'], $pendingResult['message'], 409);
            }
            $pendingContext = $pendingResult['context'];
            $row = $pendingContext['row'];
            $pending = $pendingContext['pending'];
            $flow = (string)$pending['flow'];

            if ($flow === 'provider_transfer') {
                $currentUser = getCurrentUser();
                if (!$currentUser || (int)($pending['target_user_id'] ?? 0) !== (int)$currentUser['id']) {
                    authOAuthError('OAUTH_PENDING_NOT_FOUND', '授权状态已失效，请重新绑定', 409);
                }
                $email = normalizeEmail((string)($currentUser['email'] ?? ''));
                if ($email === '' || empty($currentUser['email_verified_at'])) {
                    authOAuthError('TARGET_EMAIL_REQUIRED', '请先验证当前账号邮箱');
                }
            } else {
                $input = authJsonInput();
                $email = normalizeEmail((string)($input['email'] ?? ''));
                if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 255) {
                    authOAuthError('EMAIL_INVALID', '邮箱格式不正确');
                }
            }

            $now = time();
            $windowStartedAt = strtotime((string)($row['send_window_started_at'] ?? ''));
            $sendCount = (int)($row['send_count'] ?? 0);
            if ($windowStartedAt === false || $windowStartedAt <= $now - 60) {
                $windowStartedAt = $now;
                $sendCount = 0;
            }
            // 发送次数同时跨越同一 Session 创建的多个挑战统计，避免反复发起
            // OAuth 回调后绕过单挑战的 3 次/分钟限制。
            $recentSent = $db->prepare(
                'SELECT COUNT(*) FROM oauth_account_challenges
                 WHERE session_id_hash = ? AND email = ? AND code_sent_at >= ?'
            );
            $recentSent->execute([
                oauthAccountSessionHash(),
                $email,
                date('Y-m-d H:i:s', $now - 60),
            ]);
            if ($sendCount >= 3 || (int)$recentSent->fetchColumn() >= 3) {
                authOAuthError('OAUTH_CODE_RATE_LIMITED', '验证码发送过于频繁，请稍后再试', 429);
            }

            $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
            $newSendCount = $sendCount + 1;
            $windowDate = date('Y-m-d H:i:s', $windowStartedAt);
            $sentDate = date('Y-m-d H:i:s', $now);
            $expiresDate = date('Y-m-d H:i:s', $now + 300);
            $update = $db->prepare(
                'UPDATE oauth_account_challenges
                 SET email = ?, code_hash = ?, code_expires_at = ?, verified_at = NULL,
                     attempt_count = 0, code_sent_at = ?, send_count = ?, send_window_started_at = ?
                 WHERE challenge_hash = ? AND session_id_hash = ? AND consumed_at IS NULL'
            );
            $update->execute([
                $email,
                authOAuthCodeHash($code),
                $expiresDate,
                $sentDate,
                $newSendCount,
                $windowDate,
                $row['challenge_hash'],
                oauthAccountSessionHash(),
            ]);
            if ($update->rowCount() !== 1) {
                authOAuthError('OAUTH_PENDING_EXPIRED', '本次授权已过期，请重新登录', 409);
            }

            $subject = $flow === 'provider_transfer' ? '账号绑定确认验证码' : '社交账号登录验证码';
            $message = "您的验证码是：{$code}\n\n";
            $message .= "验证码 5 分钟内有效。如果不是您本人操作，请忽略此邮件。\n";
            $mailSent = sendMail($email, ($subjectPrefix ?? '') . $subject, $message);
            logAction('user.oauth_send_code', 'user', $flow === 'provider_transfer' ? (int)$pending['target_user_id'] : null, [
                'provider' => $pending['provider'],
                'flow' => $flow,
                'email' => $email,
                'mail_sent' => $mailSent,
            ]);
            if (!$mailSent) {
                authOAuthError('OAUTH_CODE_SEND_FAILED', '验证码发送失败，请稍后再试', 503);
            }

            echo json_encode([
                'success' => true,
                'message' => '验证码已发送至 ' . maskEmail($email),
                'expires_in' => 300,
            ]);
        } catch (Throwable $error) {
            error_log('Unable to send OAuth account code: ' . $error->getMessage());
            authOAuthError('OAUTH_SETUP_UNAVAILABLE', '登录服务暂时不可用，请稍后再试', 503);
        }
        exit();

    case 'oauth_verify_code':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            authOAuthError('METHOD_NOT_ALLOWED', '仅支持 POST 请求', 405);
        }
        authRequireSameOrigin();
        checkRateLimit('oauth_verify_code', 10, 1);

        try {
            $db = getDB();
            $pendingResult = authOAuthPendingContext($db);
            if (!$pendingResult['success']) {
                authOAuthError($pendingResult['code'], $pendingResult['message'], 409);
            }
            $pendingContext = $pendingResult['context'];
            $row = $pendingContext['row'];
            $pending = $pendingContext['pending'];
            $flow = (string)$pending['flow'];
            $input = authJsonInput();
            $code = trim((string)($input['code'] ?? ''));
            if (!preg_match('/^\d{6}$/', $code)) {
                authOAuthError('OAUTH_CODE_INVALID', '验证码为 6 位数字');
            }

            if (authOAuthChallengeIsVerified($row)) {
                authOAuthError('OAUTH_CHALLENGE_CONSUMED', '验证码已使用，请继续完成下一步');
            }

            $email = '';
            if ($flow === 'new_login') {
                $email = normalizeEmail((string)($input['email'] ?? ''));
                if (!filter_var($email, FILTER_VALIDATE_EMAIL) || $email !== normalizeEmail((string)($row['email'] ?? ''))) {
                    authOAuthError('OAUTH_EMAIL_MISMATCH', '验证码与当前邮箱不匹配');
                }
            }

            if (!authOAuthChallengeIsVerified($row)) {
                $codeExpiresAt = strtotime((string)($row['code_expires_at'] ?? ''));
                if (empty($row['code_hash']) || $codeExpiresAt === false || $codeExpiresAt <= time()) {
                    authOAuthError('OAUTH_CODE_EXPIRED', '验证码无效或已过期');
                }

                $attemptCount = (int)($row['attempt_count'] ?? 0);
                if ($attemptCount >= 5) {
                    authOAuthError('OAUTH_CODE_ATTEMPTS_EXCEEDED', '验证码错误次数过多，请重新发送验证码');
                }

                $expectedHash = authOAuthCodeHash($code);
                if (!hash_equals((string)$row['code_hash'], $expectedHash)) {
                    $attemptUpdate = $db->prepare(
                        'UPDATE oauth_account_challenges
                         SET attempt_count = attempt_count + 1
                         WHERE challenge_hash = ? AND session_id_hash = ? AND consumed_at IS NULL AND attempt_count < 5'
                    );
                    $attemptUpdate->execute([$row['challenge_hash'], oauthAccountSessionHash()]);
                    if ($attemptUpdate->rowCount() !== 1 || $attemptCount + 1 >= 5) {
                        authOAuthError('OAUTH_CODE_ATTEMPTS_EXCEEDED', '验证码错误次数过多，请重新发送验证码');
                    }
                    authOAuthError('OAUTH_CODE_INVALID', '验证码无效或已过期');
                }

                $verifiedUpdate = $db->prepare(
                    'UPDATE oauth_account_challenges
                     SET verified_at = CURRENT_TIMESTAMP, code_hash = NULL, code_expires_at = NULL, attempt_count = 0
                     WHERE challenge_hash = ? AND session_id_hash = ? AND consumed_at IS NULL
                       AND code_hash IS NOT NULL AND code_expires_at > ? AND attempt_count < 5'
                );
                $verifiedUpdate->execute([
                    $row['challenge_hash'],
                    oauthAccountSessionHash(),
                    date('Y-m-d H:i:s'),
                ]);
                if ($verifiedUpdate->rowCount() !== 1) {
                    $attemptCheck = $db->prepare(
                        'SELECT attempt_count, consumed_at FROM oauth_account_challenges
                         WHERE challenge_hash = ? AND session_id_hash = ? LIMIT 1'
                    );
                    $attemptCheck->execute([$row['challenge_hash'], oauthAccountSessionHash()]);
                    $attemptState = $attemptCheck->fetch() ?: [];
                    if ((int)($attemptState['attempt_count'] ?? 0) >= 5) {
                        authOAuthError('OAUTH_CODE_ATTEMPTS_EXCEEDED', '验证码错误次数过多，请重新发送验证码');
                    }
                    authOAuthError('OAUTH_CHALLENGE_CONSUMED', '验证码已使用，请重新发送验证码');
                }
            } else {
                $email = normalizeEmail((string)($row['email'] ?? ''));
            }

            if ($flow === 'provider_transfer') {
                echo json_encode(['success' => true, 'next' => 'transfer']);
                exit();
            }

            $existing = authOAuthEmailUser($db, $email);
            echo json_encode([
                'success' => true,
                'email_exists' => (bool)$existing,
                'next' => $existing ? 'choose_existing' : 'set_password',
            ]);
        } catch (Throwable $error) {
            error_log('Unable to verify OAuth account code: ' . $error->getMessage());
            authOAuthError('OAUTH_SETUP_UNAVAILABLE', '登录服务暂时不可用，请稍后再试', 503);
        }
        exit();

    case 'oauth_complete_account':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            authOAuthError('METHOD_NOT_ALLOWED', '仅支持 POST 请求', 405);
        }
        authRequireSameOrigin();
        checkRateLimit('oauth_complete_account', 5, 1);

        try {
            $db = getDB();
            $pendingResult = authOAuthPendingContext($db);
            if (!$pendingResult['success']) {
                authOAuthError($pendingResult['code'], $pendingResult['message'], 409);
            }
            $pendingContext = $pendingResult['context'];
            $row = $pendingContext['row'];
            $pending = $pendingContext['pending'];
            if (($pending['flow'] ?? '') !== 'new_login' || !authOAuthChallengeIsVerified($row)) {
                authOAuthError('OAUTH_EMAIL_VERIFICATION_REQUIRED', '请先验证邮箱验证码');
            }
            $provider = (string)($pending['provider'] ?? '');
            if (!in_array($provider, ['qq', 'discord'], true)) {
                authOAuthError('OAUTH_PENDING_NOT_FOUND', '授权状态已失效，请重新登录', 409);
            }

            $input = authJsonInput();
            $email = normalizeEmail((string)($input['email'] ?? ''));
            $password = (string)($input['password'] ?? '');
            $confirmation = (string)($input['password_confirmation'] ?? '');
            if (!filter_var($email, FILTER_VALIDATE_EMAIL) || $email !== normalizeEmail((string)($row['email'] ?? ''))) {
                authOAuthError('OAUTH_EMAIL_MISMATCH', '邮箱与已验证的邮箱不匹配');
            }
            if (strlen($password) < 6 || strlen($password) > 128) {
                authOAuthError('PASSWORD_INVALID', '密码需为 6-128 位');
            }
            if ($password !== $confirmation) {
                authOAuthError('PASSWORD_MISMATCH', '两次输入的密码不一致');
            }

            $profile = oauthAccountProfileFromPending($pending);
            $hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
            $result = oauthAccountCreateCompletedUser($db, $provider, $profile, $email, $hash, (string)$row['challenge_hash']);
            if (!$result['success']) {
                $status = in_array($result['code'] ?? '', ['EMAIL_EXISTS', 'PROVIDER_CONFLICT', 'OAUTH_CHALLENGE_CONSUMED'], true) ? 409 : 500;
                authOAuthError((string)$result['code'], (string)$result['message'], $status);
            }

            $userId = (int)$result['user_id'];
            oauthAccountClearPending();
            createSession($userId);
            logAction('user.register', 'user', $userId, ['provider' => $provider, 'email' => $email, 'result' => 'success']);
            if (function_exists('backfillAnnouncements')) backfillAnnouncements($userId);
            $createdUser = oauthAccountFindUser($db, $userId) ?: [
                'id' => $userId,
                'username' => $result['username'],
                'nickname' => $pending['username'] ?? $result['username'],
                'avatar_url' => $pending['avatar_url'] ?? '',
                'role' => 'visitor',
                'email' => $email,
                'email_verified_at' => date('Y-m-d H:i:s'),
                'password_hash' => $hash,
            ];
            echo json_encode([
                'success' => true,
                'message' => '账号创建成功',
                'redirect_to' => oauthAccountSafeReturnTo($pending['return_to'] ?? null),
                'user' => publicAuthUser($createdUser),
            ]);
        } catch (Throwable $error) {
            error_log('Unable to complete OAuth account: ' . $error->getMessage());
            authOAuthError('OAUTH_ACCOUNT_CREATE_FAILED', '账号创建失败，请稍后再试', 500);
        }
        exit();

    case 'oauth_link_existing':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            authOAuthError('METHOD_NOT_ALLOWED', '仅支持 POST 请求', 405);
        }
        authRequireSameOrigin();
        checkRateLimit('oauth_link_existing', 5, 1);

        try {
            $db = getDB();
            $pendingResult = authOAuthPendingContext($db);
            if (!$pendingResult['success']) {
                authOAuthError($pendingResult['code'], $pendingResult['message'], 409);
            }
            $pendingContext = $pendingResult['context'];
            $row = $pendingContext['row'];
            $pending = $pendingContext['pending'];
            if (($pending['flow'] ?? '') !== 'new_login' || !authOAuthChallengeIsVerified($row)) {
                authOAuthError('OAUTH_EMAIL_VERIFICATION_REQUIRED', '请先验证邮箱验证码');
            }
            $provider = (string)($pending['provider'] ?? '');
            if (!in_array($provider, ['qq', 'discord'], true)) {
                authOAuthError('OAUTH_PENDING_NOT_FOUND', '授权状态已失效，请重新登录', 409);
            }

            $input = authJsonInput();
            $email = normalizeEmail((string)($input['email'] ?? ''));
            if (!filter_var($email, FILTER_VALIDATE_EMAIL) || $email !== normalizeEmail((string)($row['email'] ?? ''))) {
                authOAuthError('OAUTH_EMAIL_MISMATCH', '邮箱与已验证的邮箱不匹配');
            }
            $target = authOAuthEmailUser($db, $email);
            if (!$target) {
                authOAuthError('TARGET_ACCOUNT_UNAVAILABLE', '目标账号当前不可用');
            }
            if (($target['status'] ?? '') !== 'active') {
                authOAuthError('TARGET_ACCOUNT_UNAVAILABLE', '目标账号当前不可用');
            }

            $result = oauthAccountLinkPendingToExisting(
                $db,
                $provider,
                oauthAccountProfileFromPending($pending),
                $email,
                (int)$target['id'],
                (string)$row['challenge_hash']
            );
            if (!$result['success']) {
                $status = in_array($result['code'] ?? '', ['PROVIDER_CONFLICT', 'TARGET_PROVIDER_ALREADY_BOUND', 'OAUTH_CHALLENGE_CONSUMED'], true) ? 409 : 422;
                authOAuthError((string)$result['code'], (string)$result['message'], $status);
            }

            oauthAccountClearPending();
            createSession((int)$target['id']);
            logAction('user.oauth_link_existing', 'user', (int)$target['id'], ['provider' => $provider, 'result' => 'success']);
            echo json_encode([
                'success' => true,
                'message' => '已绑定到已有账号',
                'redirect_to' => oauthAccountSafeReturnTo($pending['return_to'] ?? null),
            ]);
        } catch (Throwable $error) {
            error_log('Unable to link OAuth provider to existing account: ' . $error->getMessage());
            authOAuthError('OAUTH_LINK_FAILED', '绑定已有账号失败，请稍后再试', 500);
        }
        exit();

    case 'oauth_transfer_provider':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            authOAuthError('METHOD_NOT_ALLOWED', '仅支持 POST 请求', 405);
        }
        authRequireSameOrigin();
        checkRateLimit('oauth_transfer_provider', 5, 1);

        try {
            $db = getDB();
            $pendingResult = authOAuthPendingContext($db);
            if (!$pendingResult['success']) {
                $pendingCode = $pendingResult['code'] === 'OAUTH_PENDING_EXPIRED'
                    ? 'PROVIDER_TRANSFER_EXPIRED' : $pendingResult['code'];
                authOAuthError($pendingCode, $pendingResult['message'], 409);
            }
            $pendingContext = $pendingResult['context'];
            $row = $pendingContext['row'];
            $pending = $pendingContext['pending'];
            if (($pending['flow'] ?? '') !== 'provider_transfer' || !authOAuthChallengeIsVerified($row)) {
                authOAuthError('OAUTH_EMAIL_VERIFICATION_REQUIRED', '请先验证当前账号邮箱');
            }
            $provider = (string)($pending['provider'] ?? '');
            if (!in_array($provider, ['qq', 'discord'], true)) {
                authOAuthError('OAUTH_PENDING_NOT_FOUND', '授权状态已失效，请重新绑定', 409);
            }

            $currentUser = getCurrentUser();
            $targetId = (int)($pending['target_user_id'] ?? 0);
            if (!$currentUser || $targetId <= 0 || (int)$currentUser['id'] !== $targetId) {
                authOAuthError('OAUTH_PENDING_NOT_FOUND', '授权状态已失效，请重新绑定', 409);
            }

            $result = oauthAccountTransferProviderToUser($db, $provider, $pending, $targetId, (string)$row['challenge_hash']);
            if (!$result['success']) {
                $status = in_array($result['code'] ?? '', ['PROVIDER_CONFLICT', 'PROVIDER_OWNER_UNAVAILABLE', 'TARGET_PROVIDER_ALREADY_BOUND', 'OAUTH_CHALLENGE_CONSUMED'], true) ? 409 : 422;
                authOAuthError((string)$result['code'], (string)$result['message'], $status);
            }

            oauthAccountClearPending();
            logAction('user.oauth_provider_transfer', 'user', $targetId, [
                'provider' => $provider,
                'source_user_id' => $result['source_id'] ?? null,
                'result' => 'success',
            ]);
            echo json_encode([
                'success' => true,
                'message' => '第三方登录身份已转移到当前账号',
                'redirect_to' => oauthAccountSafeReturnTo($pending['return_to'] ?? null, 'user.html?tab=account'),
            ]);
        } catch (Throwable $error) {
            error_log('Unable to transfer OAuth provider identity: ' . $error->getMessage());
            authOAuthError('PROVIDER_TRANSFER_FAILED', '第三方账号转移失败，请稍后再试', 500);
        }
        exit();

    case 'oauth_cancel':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            authOAuthError('METHOD_NOT_ALLOWED', '仅支持 POST 请求', 405);
        }
        authRequireSameOrigin();
        try {
            $db = getDB();
            $pendingContext = oauthAccountLoadPending($db);
            if ($pendingContext) {
                oauthAccountConsumeChallenge($db, (string)$pendingContext['row']['challenge_hash']);
            }
        } catch (Throwable $error) {
            error_log('Unable to cancel OAuth challenge: ' . $error->getMessage());
        }
        oauthAccountClearPending();
        echo json_encode(['success' => true, 'message' => '授权已取消']);
        exit();

    case 'qq_auth':
        // 跳转到 QQ OAuth 授权页面
        initSession();
        require_once __DIR__ . '/../includes/oauth_qq.php';
        $mode = (string)($_GET['mode'] ?? 'login');
        if (!in_array($mode, ['login', 'bind'], true)) $mode = 'login';
        if ($mode === 'bind' && !getCurrentUser()) {
            header('Location: ' . oauthAccountCallbackRedirect('login.html', 'error', '请先登录再绑定QQ'));
            exit();
        }
        oauthAccountSetOAuthContext('qq', $mode, $_GET['return_to'] ?? ($mode === 'bind' ? 'user.html?tab=account' : 'index.html'));
        $url = qq_get_authorization_url();
        header('Location: ' . $url);
        exit();

    case 'discord_auth':
        // 跳转到 Discord OAuth 授权页面
        initSession();
        require_once __DIR__ . '/../includes/oauth_discord.php';
        $mode = (string)($_GET['mode'] ?? 'login');
        if (!in_array($mode, ['login', 'bind'], true)) $mode = 'login';
        if ($mode === 'bind' && !getCurrentUser()) {
            header('Location: ' . oauthAccountCallbackRedirect('login.html', 'error', '请先登录再绑定Discord'));
            exit();
        }
        oauthAccountSetOAuthContext('discord', $mode, $_GET['return_to'] ?? ($mode === 'bind' ? 'user.html?tab=account' : 'index.html'));
        $url = discord_get_authorization_url();
        header('Location: ' . $url);
        exit();

    case 'bangumi_auth':
        // Bangumi is a binding-only integration; it must not become a second
        // VNFmap login path.
        initSession();
        requireLogin();
        require_once __DIR__ . '/../includes/oauth_bangumi.php';
        try {
            $url = bangumiAuthorizationUrl();
        } catch (Throwable $error) {
            header('Location: ../user.html?tab=account&oauth=error&message=' . rawurlencode($error->getMessage()));
            exit();
        }
        header('Location: ' . $url);
        exit();

    case 'bind_qq':
        authOAuthError('OAUTH_BIND_REQUIRED', '请通过 QQ 授权页面完成绑定', 410);
        exit();

    case 'unbind_qq':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        authRequireSameOrigin();
        $user = requireLogin();
        $db = getDB();
        if (!authOAuthUserHasAlternativeLogin($db, (int)$user['id'], 'qq')) {
            authOAuthError('LAST_LOGIN_METHOD', '请先设置密码或绑定其他登录方式，再解绑 QQ');
        }
        $db->prepare("UPDATE users SET qq_openid = NULL, qq_unionid = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            ->execute([$user['id']]);

        logAction('user.unbind_qq', 'user', $user['id']);
        echo json_encode(['success' => true, 'message' => 'QQ 已解绑']);
        exit();

    case 'bind_discord':
        authOAuthError('OAUTH_BIND_REQUIRED', '请通过 Discord 授权页面完成绑定', 410);
        exit();

    case 'unbind_discord':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        authRequireSameOrigin();
        $user = requireLogin();
        $db = getDB();
        if (!authOAuthUserHasAlternativeLogin($db, (int)$user['id'], 'discord')) {
            authOAuthError('LAST_LOGIN_METHOD', '请先设置密码或绑定其他登录方式，再解绑 Discord');
        }
        $db->prepare("UPDATE users SET discord_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            ->execute([$user['id']]);

        logAction('user.unbind_discord', 'user', $user['id']);
        echo json_encode(['success' => true, 'message' => 'Discord 已解绑']);
        exit();

    case 'unbind_bangumi':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        authRequireSameOrigin();
        $user = requireLogin();
        $db = getDB();
        try {
            $db->prepare('DELETE FROM bangumi_bindings WHERE vnfmap_user_id = ?')
                ->execute([(int)$user['id']]);
        } catch (Throwable $error) {
            http_response_code(503);
            echo json_encode(['success' => false, 'message' => 'Bangumi 绑定功能尚未完成数据库初始化']);
            exit();
        }

        logAction('user.unbind_bangumi', 'user', (int)$user['id']);
        echo json_encode(['success' => true, 'message' => 'Bangumi 已解绑']);
        exit();

    case 'oauth_config':
        echo json_encode([
            'success' => true,
            'qq_configured' => defined('QQ_APPID') && QQ_APPID !== '',
            'discord_configured' => defined('DISCORD_CLIENT_ID') && DISCORD_CLIENT_ID !== '',
            'bangumi_configured' => bangumiOAuthConfigured(),
        ]);
        exit();

    default:
        echo json_encode(['success' => false, 'message' => '未知动作', 'available_actions' => [
            'login_local', 'register_local', 'logout', 'me', 'change_password',
            'set_password', 'oauth_pending', 'oauth_send_code', 'oauth_verify_code',
            'oauth_complete_account', 'oauth_link_existing', 'oauth_transfer_provider', 'oauth_cancel',
            'send_register_code', 'send_code', 'bind_email', 'unbind_email', 'update_profile',
            'update_membership_application_email_preference', 'update_language_preference', 'update_display_club',
            'bind_qq', 'unbind_qq', 'bind_discord', 'unbind_discord',
            'unbind_bangumi',
            'qq_auth', 'discord_auth', 'bangumi_auth', 'oauth_config'
        ]]);
        exit();
}
