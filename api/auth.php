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
    $first = mb_substr($name, 0, 1);
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
    return [
        'id' => (int)($user['id'] ?? 0),
        'username' => $user['username'] ?? '',
        'nickname' => $user['nickname'] ?? ($user['username'] ?? ''),
        'avatar_url' => $user['avatar_url'] ?? '',
        'role' => $user['role'] ?? 'visitor',
        'email' => $user['email'] ?? '',
        'email_verified' => !empty($user['email_verified_at']),
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
                "INSERT INTO users (username, nickname, password_hash, role, status, avatar_url, email, email_verified_at, created_at, updated_at, last_login_at)
                 VALUES (?, ?, ?, 'visitor', 'active', '', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
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

        logAction('user.change_password', 'user', $user['id']);
        echo json_encode(['success' => true, 'message' => '密码修改成功']);
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
        $email = trim($input['email'] ?? '');

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
        $email = trim($input['email'] ?? '');
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

        // 标记验证码已使用
        $db->prepare("UPDATE email_verifications SET used = 1 WHERE id = ?")->execute([$verification['id']]);

        // 检查邮箱唯一性
        $stmt = $db->prepare('SELECT id FROM users WHERE email = ? AND id != ?');
        $stmt->execute([$email, $user['id']]);
        if ($stmt->fetch()) {
            echo json_encode(['success' => false, 'message' => '该邮箱已被其他账号绑定']);
            exit();
        }

        $db->prepare(
            "UPDATE users SET email = ?, email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
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

    case 'qq_auth':
        // 跳转到 QQ OAuth 授权页面
        initSession();
        require_once __DIR__ . '/../includes/oauth_qq.php';
        $_SESSION['oauth_mode'] = $_GET['mode'] ?? 'login';
        $url = qq_get_authorization_url();
        header('Location: ' . $url);
        exit();

    case 'discord_auth':
        // 跳转到 Discord OAuth 授权页面
        initSession();
        require_once __DIR__ . '/../includes/oauth_discord.php';
        $_SESSION['oauth_mode'] = $_GET['mode'] ?? 'login';
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
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $openid = trim($input['openid'] ?? '');
        $unionid = trim($input['unionid'] ?? '');

        if (!$openid) {
            echo json_encode(['success' => false, 'message' => 'QQ OpenID 不能为空']);
            exit();
        }

        // 检查是否已被其他账号绑定
        $db = getDB();
        $stmt = $db->prepare('SELECT id FROM users WHERE qq_openid = ? AND id != ?');
        $stmt->execute([$openid, $user['id']]);
        if ($stmt->fetch()) {
            echo json_encode(['success' => false, 'message' => '该 QQ 账号已被其他用户绑定']);
            exit();
        }

        $db->prepare("UPDATE users SET qq_openid = ?, qq_unionid = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            ->execute([$openid, $unionid, $user['id']]);

        logAction('user.bind_qq', 'user', $user['id']);
        echo json_encode(['success' => true, 'message' => 'QQ 绑定成功']);
        exit();

    case 'unbind_qq':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        $user = requireLogin();
        $db = getDB();
        $db->prepare("UPDATE users SET qq_openid = NULL, qq_unionid = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            ->execute([$user['id']]);

        logAction('user.unbind_qq', 'user', $user['id']);
        echo json_encode(['success' => true, 'message' => 'QQ 已解绑']);
        exit();

    case 'bind_discord':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $discordId = trim($input['discord_id'] ?? '');

        if (!$discordId) {
            echo json_encode(['success' => false, 'message' => 'Discord ID 不能为空']);
            exit();
        }

        // 检查是否已被其他账号绑定
        $db = getDB();
        $stmt = $db->prepare('SELECT id FROM users WHERE discord_id = ? AND id != ?');
        $stmt->execute([$discordId, $user['id']]);
        if ($stmt->fetch()) {
            echo json_encode(['success' => false, 'message' => '该 Discord 账号已被其他用户绑定']);
            exit();
        }

        $db->prepare("UPDATE users SET discord_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            ->execute([$discordId, $user['id']]);

        logAction('user.bind_discord', 'user', $user['id']);
        echo json_encode(['success' => true, 'message' => 'Discord 绑定成功']);
        exit();

    case 'unbind_discord':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        $user = requireLogin();
        $db = getDB();
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
            'send_register_code', 'send_code', 'bind_email', 'unbind_email', 'update_profile',
            'update_membership_application_email_preference', 'update_language_preference', 'update_display_club',
            'bind_qq', 'unbind_qq', 'bind_discord', 'unbind_discord',
            'unbind_bangumi',
            'qq_auth', 'discord_auth', 'bangumi_auth', 'oauth_config'
        ]]);
        exit();
}
