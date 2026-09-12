<?php
// scripts/test-oauth-account-flow.php - OAuth 账号辅助层临时 SQLite 集成测试
// 不读取项目配置、不连接真实数据库；每次运行都会使用并删除临时数据库。

declare(strict_types=1);

define('DB_DRIVER', 'sqlite');

function initSession(): void {
    if (session_status() === PHP_SESSION_NONE) {
        session_name('vnfest_oauth_test');
        session_id('oauth-test-' . getmypid());
        session_start();
    }
}

require_once __DIR__ . '/../includes/oauth_account.php';

$dbPath = tempnam(sys_get_temp_dir(), 'vnfest-oauth-');
if ($dbPath === false) {
    fwrite(STDERR, "无法创建临时 SQLite 数据库\n");
    exit(1);
}

function oauthTestAssert(bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

try {
    $db = new PDO('sqlite:' . $dbPath);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $db->exec('PRAGMA foreign_keys = ON');
    $db->exec(
        "CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            nickname TEXT NOT NULL DEFAULT '',
            password_hash TEXT,
            credentials_completed_at TEXT NULL,
            qq_openid TEXT UNIQUE,
            qq_unionid TEXT,
            discord_id TEXT UNIQUE,
            email TEXT UNIQUE,
            email_verified_at TEXT,
            avatar_url TEXT DEFAULT '',
            role TEXT NOT NULL DEFAULT 'visitor',
            status TEXT NOT NULL DEFAULT 'active',
            profile_bio TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_login_at TEXT
        )"
    );
    $db->exec(
        "CREATE TABLE oauth_account_challenges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id_hash TEXT NOT NULL,
            challenge_hash TEXT NOT NULL UNIQUE,
            provider TEXT NOT NULL,
            flow TEXT NOT NULL,
            target_user_id INTEGER NULL REFERENCES users(id) ON DELETE CASCADE,
            email TEXT NULL,
            code_hash TEXT NULL,
            code_expires_at TEXT NULL,
            verified_at TEXT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            code_sent_at TEXT NULL,
            send_count INTEGER NOT NULL DEFAULT 0,
            send_window_started_at TEXT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )"
    );

    $insert = $db->prepare(
        'INSERT INTO users
            (username, nickname, password_hash, qq_openid, qq_unionid, discord_id, email,
             email_verified_at, avatar_url, role, status, profile_bio)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    $insert->execute([
        'legacy_qq', '旧 QQ', '', 'qq-owner', 'qq-union', null,
        'legacy@example.com', null, 'legacy-avatar', 'visitor', 'active', 'legacy bio',
    ]);
    $legacyOwnerId = (int)$db->lastInsertId();
    $insert->execute([
        'existing_email', '已有邮箱', '', null, null, null,
        'target@example.com', '2026-09-11 00:00:00', 'target-avatar', 'visitor', 'active', 'target bio',
    ]);
    $existingEmailUserId = (int)$db->lastInsertId();

    initSession();
    $_SESSION['oauth_pending'] = null;

    // 新 QQ 挑战只保存服务端上下文；完成前 users 数量不得变化。
    $beforeCount = (int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn();
    $newQQ = oauthAccountCreateChallenge($db, 'qq', [
        'openid' => 'qq-new',
        'unionid' => 'qq-new-union',
        'username' => '新 QQ 用户',
        'avatar_url' => 'https://example.com/qq.png',
    ], 'new_login', null, 'index.html');
    $afterChallengeCount = (int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn();
    oauthTestAssert($beforeCount === $afterChallengeCount, '新 QQ 挑战不应提前创建 users 记录');
    oauthTestAssert(oauthAccountLoadPending($db) !== null, '新 QQ 挑战应能从 Session 加载');

    $created = oauthAccountCreateCompletedUser(
        $db,
        'qq',
        oauthAccountProfileFromPending($_SESSION['oauth_pending']),
        'new@example.com',
        password_hash('new-password', PASSWORD_BCRYPT),
        $newQQ['challenge_hash']
    );
    oauthTestAssert($created['success'] === true, '新 QQ 账号应能一次性创建');
    $newUser = oauthAccountFindUser($db, (int)$created['user_id']);
    oauthTestAssert($newUser && $newUser['email'] === 'new@example.com', '新 QQ 账号邮箱未写入');
    oauthTestAssert(!empty($newUser['email_verified_at']) && !empty($newUser['credentials_completed_at']), '新 QQ 账号凭证完成时间未写入');
    oauthTestAssert($newUser['qq_openid'] === 'qq-new' && $newUser['qq_unionid'] === 'qq-new-union', '新 QQ 身份未写入');
    $challenge = $db->prepare('SELECT consumed_at FROM oauth_account_challenges WHERE challenge_hash = ?');
    $challenge->execute([$newQQ['challenge_hash']]);
    oauthTestAssert((string)$challenge->fetchColumn() !== '', '完成账号后挑战应立即消费');
    oauthAccountClearPending();

    // Discord 使用同一辅助层完成，确保不会落回旧的空密码创建路径。
    $newDiscord = oauthAccountCreateChallenge($db, 'discord', [
        'discord_id' => 'discord-new',
        'username' => '新 Discord 用户',
        'avatar_url' => 'https://example.com/discord.png',
    ], 'new_login', null, 'index.html');
    $discordCreated = oauthAccountCreateCompletedUser(
        $db,
        'discord',
        oauthAccountProfileFromPending($_SESSION['oauth_pending']),
        'discord@example.com',
        password_hash('discord-password', PASSWORD_BCRYPT),
        $newDiscord['challenge_hash']
    );
    oauthTestAssert($discordCreated['success'] === true, '新 Discord 账号应走同一完成流程');
    $discordUser = oauthAccountFindUser($db, (int)$discordCreated['user_id']);
    oauthTestAssert($discordUser && $discordUser['discord_id'] === 'discord-new', '新 Discord 身份未写入');
    oauthAccountClearPending();

    // 邮箱已存在时，只把 provider 绑定到目标账号，不创建重复用户。
    $existingCount = (int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn();
    $linkChallenge = oauthAccountCreateChallenge($db, 'qq', [
        'openid' => 'qq-link',
        'unionid' => 'qq-link-union',
        'username' => '绑定 QQ',
        'avatar_url' => '',
    ], 'new_login', null, 'index.html');
    $linked = oauthAccountLinkPendingToExisting(
        $db,
        'qq',
        oauthAccountProfileFromPending($_SESSION['oauth_pending']),
        'target@example.com',
        $existingEmailUserId,
        $linkChallenge['challenge_hash']
    );
    oauthTestAssert($linked['success'] === true, '已验证邮箱应能绑定已有账号');
    oauthTestAssert((int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn() === $existingCount, '绑定已有邮箱不应创建重复用户');
    $linkedUser = oauthAccountFindUser($db, $existingEmailUserId);
    oauthTestAssert($linkedUser && $linkedUser['qq_openid'] === 'qq-link' && $linkedUser['username'] === 'existing_email', '已有账号资料不应被合并或替换');
    oauthAccountClearPending();

    // 转移只改变 QQ 字段；源账号的业务资料和目标账号其他字段保持不变。
    $insert->execute([
        'transfer_target', '转移目标', 'target-password', null, null, null,
        'transfer@example.com', '2026-09-11 00:00:00', 'transfer-avatar', 'visitor', 'active', 'keep this bio',
    ]);
    $transferTargetId = (int)$db->lastInsertId();
    $transferChallenge = oauthAccountCreateChallenge($db, 'qq', [
        'openid' => 'qq-owner',
        'unionid' => 'ignored-union',
        'username' => '旧 QQ',
        'avatar_url' => '',
    ], 'provider_transfer', $transferTargetId, 'user.html?tab=account');
    $sourceBefore = oauthAccountFindUser($db, $legacyOwnerId);
    $targetBefore = oauthAccountFindUser($db, $transferTargetId);
    $transferred = oauthAccountTransferProviderToUser(
        $db,
        'qq',
        $_SESSION['oauth_pending'],
        $transferTargetId,
        $transferChallenge['challenge_hash']
    );
    oauthTestAssert($transferred['success'] === true, 'QQ 身份应能转移到当前主账号');
    $sourceAfter = oauthAccountFindUser($db, $legacyOwnerId);
    $targetAfter = oauthAccountFindUser($db, $transferTargetId);
    oauthTestAssert($sourceAfter['qq_openid'] === null && $sourceAfter['qq_unionid'] === null, '源账号 QQ 身份应被清空');
    oauthTestAssert($targetAfter['qq_openid'] === 'qq-owner' && $targetAfter['qq_unionid'] === 'qq-union', '目标账号应接收原 QQ 身份');
    oauthTestAssert($sourceAfter['username'] === $sourceBefore['username'] && $sourceAfter['email'] === $sourceBefore['email'], '转移不得修改源账号资料');
    oauthTestAssert($targetAfter['username'] === $targetBefore['username'] && $targetAfter['email'] === $targetBefore['email'] && $targetAfter['profile_bio'] === $targetBefore['profile_bio'], '转移不得合并目标账号业务资料');
    oauthAccountClearPending();

    // 过期挑战不可重放。
    $expired = oauthAccountCreateChallenge($db, 'discord', [
        'discord_id' => 'discord-expired',
        'username' => '过期 Discord',
        'avatar_url' => '',
    ], 'new_login', null, 'index.html');
    $db->prepare('UPDATE oauth_account_challenges SET expires_at = ? WHERE challenge_hash = ?')
        ->execute([date('Y-m-d H:i:s', time() - 1), $expired['challenge_hash']]);
    oauthTestAssert(oauthAccountLoadPending($db) === null, '过期挑战不得继续加载');
    oauthTestAssert(oauthAccountTakePendingError() === 'OAUTH_PENDING_EXPIRED', '过期挑战应返回稳定错误码');

    echo "OAuth account helper integration checks passed\n";
} catch (Throwable $error) {
    fwrite(STDERR, 'OAuth account helper integration failed: ' . $error->getMessage() . "\n");
    exit(1);
} finally {
    if (session_status() !== PHP_SESSION_NONE) {
        session_destroy();
    }
    @unlink($dbPath);
}
