<?php
// includes/oauth_account.php - QQ/Discord 账号完成、绑定与身份转移
//
// OAuth provider 只负责证明第三方身份。本文件负责把该身份安全地接入
// VNFest 账号体系；社交身份可以立即创建可登录账号，邮箱和密码按需补充。

function oauthAccountProviderMeta(string $provider): array {
    if ($provider === 'qq') {
        return [
            'provider' => 'qq',
            'label' => 'QQ',
            'subject_key' => 'openid',
            'column' => 'qq_openid',
            'union_column' => 'qq_unionid',
            'default_return' => 'index.html',
            'login_message' => 'QQ登录成功',
            'bind_message' => 'QQ绑定成功',
        ];
    }

    if ($provider === 'discord') {
        return [
            'provider' => 'discord',
            'label' => 'Discord',
            'subject_key' => 'discord_id',
            'column' => 'discord_id',
            'union_column' => null,
            'default_return' => 'index.html',
            'login_message' => 'Discord登录成功',
            'bind_message' => 'Discord绑定成功',
        ];
    }

    throw new InvalidArgumentException('不支持的 OAuth provider');
}

function oauthAccountNormalizeEmail(string $email): string {
    return strtolower(trim($email));
}

function oauthAccountStringLength(string $value): int {
    if (function_exists('mb_strlen')) {
        return mb_strlen($value, 'UTF-8');
    }
    $chars = preg_split('//u', $value, -1, PREG_SPLIT_NO_EMPTY);
    return is_array($chars) ? count($chars) : strlen($value);
}

function oauthAccountStringSubstr(string $value, int $start, int $length): string {
    if (function_exists('mb_substr')) {
        return mb_substr($value, $start, $length, 'UTF-8');
    }
    $chars = preg_split('//u', $value, -1, PREG_SPLIT_NO_EMPTY);
    return is_array($chars) ? implode('', array_slice($chars, $start, $length)) : substr($value, $start, $length);
}

function oauthAccountSafeReturnTo(?string $candidate, string $fallback = 'index.html'): string {
    $candidate = trim((string)$candidate);
    $fallback = trim($fallback) !== '' ? trim($fallback) : 'index.html';

    if ($candidate === ''
        || strpos($candidate, '..') !== false
        || strpos($candidate, '\\') !== false
        || strpos($candidate, '#') !== false
        || $candidate[0] === '/') {
        return $fallback;
    }
    if (preg_match('/\A(?:https?:)?\/\//i', $candidate)) {
        return $fallback;
    }
    if (!preg_match('/\A[a-zA-Z0-9_.\/?=&%#-]+\z/', $candidate)) {
        return $fallback;
    }

    $path = parse_url($candidate, PHP_URL_PATH);
    if (!is_string($path) || !in_array($path, ['index.html', 'login.html', 'user.html'], true)) {
        return $fallback;
    }

    return $candidate;
}

function oauthAccountCallbackRedirect(string $returnTo, string $status, string $message = ''): string {
    $returnTo = oauthAccountSafeReturnTo($returnTo);
    $separator = strpos($returnTo, '?') === false ? '?' : '&';
    $params = ['oauth' => $status];
    if ($message !== '') {
        $params['message'] = $message;
    }
    return '../' . ltrim($returnTo, './') . $separator . http_build_query($params, '', '&', PHP_QUERY_RFC3986);
}

function oauthAccountPendingRedirect(string $status = 'pending'): string {
    if (!in_array($status, ['pending', 'provider-conflict'], true)) {
        $status = 'pending';
    }
    return '../login.html?oauth=' . rawurlencode($status);
}

function oauthAccountContextReturnTo(string $fallback = 'index.html'): string {
    initSession();
    return oauthAccountSafeReturnTo($_SESSION['oauth_return_to'] ?? null, $fallback);
}

function oauthAccountClearOAuthContext(): void {
    initSession();
    unset($_SESSION['oauth_mode'], $_SESSION['oauth_return_to'], $_SESSION['oauth_provider'], $_SESSION['oauth_started_at']);
}

function oauthAccountSetOAuthContext(string $provider, string $mode, ?string $returnTo = null): void {
    $meta = oauthAccountProviderMeta($provider);
    initSession();

    if (!in_array($mode, ['login', 'bind'], true)) {
        $mode = 'login';
    }

    $_SESSION['oauth_provider'] = $meta['provider'];
    $_SESSION['oauth_mode'] = $mode;
    $_SESSION['oauth_return_to'] = oauthAccountSafeReturnTo($returnTo, $meta['default_return']);
    $_SESSION['oauth_started_at'] = time();
}

function oauthAccountSessionHash(): string {
    initSession();
    return hash('sha256', session_id());
}

function oauthAccountCreateChallenge(
    PDO $db,
    string $provider,
    array $profile,
    string $flow,
    ?int $targetUserId,
    string $returnTo
): array {
    $meta = oauthAccountProviderMeta($provider);
    if (!in_array($flow, ['new_login', 'provider_transfer'], true)) {
        throw new InvalidArgumentException('不支持的 OAuth 挑战类型');
    }

    $subject = trim((string)($profile[$meta['subject_key']] ?? ''));
    if ($subject === '') {
        throw new InvalidArgumentException('OAuth 身份标识为空');
    }

    initSession();
    $sessionHash = oauthAccountSessionHash();
    // 仅把不可逆摘要放进挑战记录；摘要本身只通过服务端 Session 关联。
    $challengeHash = hash('sha256', bin2hex(random_bytes(32)));
    $returnTo = oauthAccountSafeReturnTo($returnTo, $meta['default_return']);

    // 请求时清理已过期挑战；已消费但尚未到期的记录暂时保留，便于
    // 统计同一 Session/邮箱在一分钟内的验证码发送次数。
    $cleanup = $db->prepare('DELETE FROM oauth_account_challenges WHERE expires_at <= ?');
    $cleanup->execute([date('Y-m-d H:i:s')]);

    // 同一浏览器 Session 只保留一个未完成挑战，防止旧 provider 挑战被重放。
    $db->prepare(
        'UPDATE oauth_account_challenges SET consumed_at = CURRENT_TIMESTAMP
         WHERE session_id_hash = ? AND consumed_at IS NULL'
    )->execute([$sessionHash]);

    $stmt = $db->prepare(
        'INSERT INTO oauth_account_challenges
            (session_id_hash, challenge_hash, provider, flow, target_user_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
    );
    $stmt->execute([
        $sessionHash,
        $challengeHash,
        $meta['provider'],
        $flow,
        $targetUserId,
        date('Y-m-d H:i:s', time() + 900),
    ]);

    $_SESSION['oauth_pending'] = [
        'challenge_hash' => $challengeHash,
        'provider' => $meta['provider'],
        'flow' => $flow,
        'target_user_id' => $targetUserId,
        'subject' => $subject,
        'unionid' => $provider === 'qq' ? trim((string)($profile['unionid'] ?? '')) : '',
        'username' => trim((string)($profile['username'] ?? '')),
        'avatar_url' => trim((string)($profile['avatar_url'] ?? '')),
        'return_to' => $returnTo,
    ];
    unset($_SESSION['oauth_pending_error']);

    return [
        'challenge_hash' => $challengeHash,
        'provider' => $meta['provider'],
        'flow' => $flow,
        'return_to' => $returnTo,
    ];
}

function oauthAccountClearPending(?string $errorCode = null): void {
    initSession();
    unset($_SESSION['oauth_pending']);
    if ($errorCode !== null && $errorCode !== '') {
        $_SESSION['oauth_pending_error'] = $errorCode;
    } else {
        unset($_SESSION['oauth_pending_error']);
    }
}

function oauthAccountTakePendingError(): ?string {
    initSession();
    $error = $_SESSION['oauth_pending_error'] ?? null;
    unset($_SESSION['oauth_pending_error']);
    return is_string($error) && $error !== '' ? $error : null;
}

function oauthAccountLoadPending(PDO $db): ?array {
    initSession();
    $pending = $_SESSION['oauth_pending'] ?? null;
    if (!is_array($pending) || trim((string)($pending['challenge_hash'] ?? '')) === '') {
        return null;
    }

    $stmt = $db->prepare(
        'SELECT * FROM oauth_account_challenges
         WHERE challenge_hash = ? AND session_id_hash = ? LIMIT 1'
    );
    $stmt->execute([(string)$pending['challenge_hash'], oauthAccountSessionHash()]);
    $row = $stmt->fetch();
    $cleanup = $db->prepare(
        'DELETE FROM oauth_account_challenges
         WHERE expires_at <= ? AND challenge_hash <> ?'
    );
    $cleanup->execute([date('Y-m-d H:i:s'), (string)$pending['challenge_hash']]);
    if (!$row) {
        oauthAccountClearPending('OAUTH_PENDING_NOT_FOUND');
        return null;
    }

    $expiresAt = strtotime((string)($row['expires_at'] ?? ''));
    if (!empty($row['consumed_at']) || ($expiresAt !== false && $expiresAt <= time())) {
        $db->prepare(
            'UPDATE oauth_account_challenges SET consumed_at = CURRENT_TIMESTAMP
             WHERE challenge_hash = ? AND consumed_at IS NULL'
        )->execute([(string)$pending['challenge_hash']]);
        oauthAccountClearPending('OAUTH_PENDING_EXPIRED');
        return null;
    }

    if (($row['provider'] ?? '') !== ($pending['provider'] ?? '') || ($row['flow'] ?? '') !== ($pending['flow'] ?? '')) {
        oauthAccountClearPending('OAUTH_PENDING_NOT_FOUND');
        return null;
    }

    return ['row' => $row, 'pending' => $pending];
}

function oauthAccountConsumeChallenge(PDO $db, string $challengeHash): bool {
    $stmt = $db->prepare(
        'UPDATE oauth_account_challenges SET consumed_at = CURRENT_TIMESTAMP
         WHERE challenge_hash = ? AND session_id_hash = ? AND consumed_at IS NULL AND expires_at > ?'
    );
    $stmt->execute([$challengeHash, oauthAccountSessionHash(), date('Y-m-d H:i:s')]);
    return $stmt->rowCount() === 1;
}

function oauthAccountFindProviderOwner(PDO $db, string $provider, string $subject, bool $forUpdate = false): ?array {
    $meta = oauthAccountProviderMeta($provider);
    $subject = trim($subject);
    if ($subject === '') {
        return null;
    }

    $sql = "SELECT * FROM users WHERE {$meta['column']} = ? LIMIT 1";
    if ($forUpdate && defined('DB_DRIVER') && DB_DRIVER === 'mysql') {
        $sql .= ' FOR UPDATE';
    }
    $stmt = $db->prepare($sql);
    $stmt->execute([$subject]);
    $user = $stmt->fetch();
    return $user ?: null;
}

function oauthAccountFindUser(PDO $db, int $userId, bool $forUpdate = false): ?array {
    $sql = 'SELECT * FROM users WHERE id = ? LIMIT 1';
    if ($forUpdate && defined('DB_DRIVER') && DB_DRIVER === 'mysql') {
        $sql .= ' FOR UPDATE';
    }
    $stmt = $db->prepare($sql);
    $stmt->execute([$userId]);
    $user = $stmt->fetch();
    return $user ?: null;
}

function oauthAccountProviderValue(array $user, string $provider): string {
    $meta = oauthAccountProviderMeta($provider);
    return trim((string)($user[$meta['column']] ?? ''));
}

function oauthAccountProfileFromPending(array $pending): array {
    if (($pending['provider'] ?? '') === 'qq') {
        return [
            'openid' => trim((string)($pending['subject'] ?? '')),
            'unionid' => trim((string)($pending['unionid'] ?? '')),
            'username' => trim((string)($pending['username'] ?? '')),
            'avatar_url' => trim((string)($pending['avatar_url'] ?? '')),
        ];
    }

    if (($pending['provider'] ?? '') === 'discord') {
        return [
            'discord_id' => trim((string)($pending['subject'] ?? '')),
            'username' => trim((string)($pending['username'] ?? '')),
            'avatar_url' => trim((string)($pending['avatar_url'] ?? '')),
        ];
    }

    throw new InvalidArgumentException('不支持的 OAuth provider');
}

function oauthAccountHasPassword(array $user): bool {
    return trim((string)($user['password_hash'] ?? '')) !== '';
}

function oauthAccountCredentialsComplete(array $user): bool {
    return oauthAccountHasPassword($user) && !empty($user['email_verified_at']);
}

function oauthAccountGenerateUsername(PDO $db, string $provider, array $profile): string {
    $meta = oauthAccountProviderMeta($provider);
    $subject = trim((string)($profile[$meta['subject_key']] ?? ''));
    $rawUsername = trim((string)($profile['username'] ?? ''));
    $baseUsername = preg_replace('/[^a-zA-Z0-9_\x{4e00}-\x{9fff}]/u', '', $rawUsername);
    if (!is_string($baseUsername) || oauthAccountStringLength($baseUsername) < 2) {
        $baseUsername = $provider . '_' . substr($subject, 0, 8);
    }
    $baseUsername = oauthAccountStringSubstr($baseUsername, 0, 200);
    $username = $baseUsername;
    $suffix = 1;
    while (true) {
        $stmt = $db->prepare('SELECT id FROM users WHERE username = ? LIMIT 1');
        $stmt->execute([$username]);
        if (!$stmt->fetch()) {
            return $username;
        }
        $username = $baseUsername . $suffix;
        $suffix++;
    }
}

function oauthAccountCreateSocialUser(PDO $db, string $provider, array $profile): array {
    $meta = oauthAccountProviderMeta($provider);
    $subject = trim((string)($profile[$meta['subject_key']] ?? ''));
    if ($subject === '') {
        return ['success' => false, 'code' => 'OAUTH_PROVIDER_ID_MISSING', 'message' => '第三方身份无效'];
    }

    try {
        $db->beginTransaction();

        $owner = oauthAccountFindProviderOwner($db, $provider, $subject, true);
        if ($owner) {
            $db->rollBack();
            return ['success' => false, 'code' => 'PROVIDER_CONFLICT', 'message' => '该第三方账号已绑定其他账号'];
        }

        $username = oauthAccountGenerateUsername($db, $provider, $profile);
        $nickname = trim((string)($profile['username'] ?? '')) ?: $username;
        $avatarUrl = trim((string)($profile['avatar_url'] ?? ''));
        $unionid = $provider === 'qq' ? trim((string)($profile['unionid'] ?? '')) : '';

        if ($provider === 'qq') {
            $stmt = $db->prepare(
                "INSERT INTO users
                    (username, nickname, qq_openid, qq_unionid, role, status, avatar_url,
                     email, email_verified_at, password_hash, credentials_completed_at,
                     created_at, updated_at, last_login_at)
                 VALUES (?, ?, ?, ?, 'visitor', 'active', ?, NULL, NULL, NULL, NULL,
                         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            );
            $stmt->execute([$username, $nickname, $subject, $unionid !== '' ? $unionid : null, $avatarUrl]);
        } else {
            $stmt = $db->prepare(
                "INSERT INTO users
                    (username, nickname, discord_id, role, status, avatar_url,
                     email, email_verified_at, password_hash, credentials_completed_at,
                     created_at, updated_at, last_login_at)
                 VALUES (?, ?, ?, 'visitor', 'active', ?, NULL, NULL, NULL, NULL,
                         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            );
            $stmt->execute([$username, $nickname, $subject, $avatarUrl]);
        }

        $userId = (int)$db->lastInsertId();
        $db->commit();
        return ['success' => true, 'user_id' => $userId, 'username' => $username, 'created' => true];
    } catch (Throwable $error) {
        if ($db->inTransaction()) $db->rollBack();

        // Provider 身份的唯一约束可能在并发请求之间先被另一请求占用。
        try {
            if (oauthAccountFindProviderOwner($db, $provider, $subject)) {
                return ['success' => false, 'code' => 'PROVIDER_CONFLICT', 'message' => '该第三方账号已绑定其他账号'];
            }
        } catch (Throwable $conflictCheckError) {
            // 保留原始错误的通用处理，不把数据库细节返回给客户端。
        }
        error_log('OAuth social-only account creation failed: ' . $error->getMessage());
        return ['success' => false, 'code' => 'OAUTH_ACCOUNT_CREATE_FAILED', 'message' => '账号创建失败，请稍后再试'];
    }
}

function oauthAccountCreateCompletedUser(
    PDO $db,
    string $provider,
    array $profile,
    string $email,
    string $passwordHash,
    ?string $challengeHash = null
): array {
    $meta = oauthAccountProviderMeta($provider);
    $subject = trim((string)($profile[$meta['subject_key']] ?? ''));
    $email = oauthAccountNormalizeEmail($email);
    if ($subject === '' || $email === '') {
        return ['success' => false, 'code' => 'OAUTH_ACCOUNT_INPUT_INVALID', 'message' => '账号信息无效'];
    }

    try {
        $db->beginTransaction();

        $stmt = $db->prepare('SELECT id FROM users WHERE email = ? LIMIT 1');
        $stmt->execute([$email]);
        if ($stmt->fetch()) {
            $db->rollBack();
            return ['success' => false, 'code' => 'EMAIL_EXISTS', 'message' => '该邮箱已经绑定账号'];
        }

        $owner = oauthAccountFindProviderOwner($db, $provider, $subject, true);
        if ($owner) {
            $db->rollBack();
            return ['success' => false, 'code' => 'PROVIDER_CONFLICT', 'message' => '该第三方账号已绑定其他账号'];
        }

        $username = oauthAccountGenerateUsername($db, $provider, $profile);
        $nickname = trim((string)($profile['username'] ?? '')) ?: $username;
        $avatarUrl = trim((string)($profile['avatar_url'] ?? ''));
        $unionid = $provider === 'qq' ? trim((string)($profile['unionid'] ?? '')) : '';

        if ($provider === 'qq') {
            $stmt = $db->prepare(
                "INSERT INTO users
                    (username, nickname, password_hash, qq_openid, qq_unionid, role, status, avatar_url,
                     email, email_verified_at, credentials_completed_at, created_at, updated_at, last_login_at)
                 VALUES (?, ?, ?, ?, ?, 'visitor', 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            );
            $stmt->execute([
                $username,
                $nickname,
                $passwordHash,
                $subject,
                $unionid !== '' ? $unionid : null,
                $avatarUrl,
                $email,
            ]);
        } else {
            $stmt = $db->prepare(
                "INSERT INTO users
                    (username, nickname, password_hash, discord_id, role, status, avatar_url,
                     email, email_verified_at, credentials_completed_at, created_at, updated_at, last_login_at)
                 VALUES (?, ?, ?, ?, 'visitor', 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            );
            $stmt->execute([
                $username,
                $nickname,
                $passwordHash,
                $subject,
                $avatarUrl,
                $email,
            ]);
        }

        $userId = (int)$db->lastInsertId();
        if ($challengeHash !== null && $challengeHash !== '') {
            if (!oauthAccountConsumeChallenge($db, $challengeHash)) {
                $db->rollBack();
                return ['success' => false, 'code' => 'OAUTH_CHALLENGE_CONSUMED', 'message' => '本次授权已完成或已失效'];
            }
        }
        $db->commit();

        return ['success' => true, 'user_id' => $userId, 'username' => $username];
    } catch (Throwable $error) {
        if ($db->inTransaction()) $db->rollBack();
        // 邮箱或 provider 可能在本事务检查后被另一请求抢先占用；把
        // 唯一约束竞争转换成稳定业务错误，而不是笼统的 500。
        try {
            $emailCheck = $db->prepare('SELECT id FROM users WHERE email = ? LIMIT 1');
            $emailCheck->execute([$email]);
            if ($emailCheck->fetch()) {
                return ['success' => false, 'code' => 'EMAIL_EXISTS', 'message' => '该邮箱已经绑定账号'];
            }
            if (oauthAccountFindProviderOwner($db, $provider, $subject)) {
                return ['success' => false, 'code' => 'PROVIDER_CONFLICT', 'message' => '该第三方账号已绑定其他账号'];
            }
        } catch (Throwable $conflictCheckError) {
            // 保留原始错误的通用处理，不把数据库细节返回给客户端。
        }
        error_log('OAuth completed account creation failed: ' . $error->getMessage());
        return ['success' => false, 'code' => 'OAUTH_ACCOUNT_CREATE_FAILED', 'message' => '账号创建失败，请稍后再试'];
    }
}

function oauthAccountLinkPendingToExisting(
    PDO $db,
    string $provider,
    array $profile,
    string $email,
    int $targetUserId,
    string $challengeHash
): array {
    $meta = oauthAccountProviderMeta($provider);
    $subject = trim((string)($profile[$meta['subject_key']] ?? ''));
    $email = oauthAccountNormalizeEmail($email);
    if ($subject === '' || $email === '' || $challengeHash === '') {
        return ['success' => false, 'code' => 'OAUTH_PROVIDER_ID_MISSING', 'message' => '第三方身份无效'];
    }

    try {
        $db->beginTransaction();
        $target = oauthAccountFindUser($db, $targetUserId, true);
        if (!$target || ($target['status'] ?? '') !== 'active' || oauthAccountNormalizeEmail((string)($target['email'] ?? '')) !== $email) {
            $db->rollBack();
            return ['success' => false, 'code' => 'TARGET_ACCOUNT_UNAVAILABLE', 'message' => '目标账号当前不可用'];
        }

        $targetValue = oauthAccountProviderValue($target, $provider);
        if ($targetValue !== '' && $targetValue !== $subject) {
            $db->rollBack();
            return ['success' => false, 'code' => 'TARGET_PROVIDER_ALREADY_BOUND', 'message' => '目标账号已经绑定了另一个同类账号'];
        }

        $owner = oauthAccountFindProviderOwner($db, $provider, $subject, true);
        if ($owner && (int)$owner['id'] !== $targetUserId) {
            $db->rollBack();
            return ['success' => false, 'code' => 'PROVIDER_CONFLICT', 'message' => '该第三方账号已被其他账号占用'];
        }

        if ($targetValue === '') {
            $unionid = $provider === 'qq' ? trim((string)($profile['unionid'] ?? '')) : '';
            if ($provider === 'qq') {
                $db->prepare(
                    'UPDATE users SET qq_openid = ?, qq_unionid = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
                )->execute([$subject, $unionid !== '' ? $unionid : null, $targetUserId]);
            } else {
                $db->prepare(
                    'UPDATE users SET discord_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
                )->execute([$subject, $targetUserId]);
            }
        }

        if (!oauthAccountConsumeChallenge($db, $challengeHash)) {
            $db->rollBack();
            return ['success' => false, 'code' => 'OAUTH_CHALLENGE_CONSUMED', 'message' => '本次授权已完成或已失效'];
        }
        $db->commit();
        return ['success' => true, 'target_id' => $targetUserId];
    } catch (Throwable $error) {
        if ($db->inTransaction()) $db->rollBack();
        try {
            if (oauthAccountFindProviderOwner($db, $provider, $subject)) {
                return ['success' => false, 'code' => 'PROVIDER_CONFLICT', 'message' => '该第三方账号已被其他账号占用'];
            }
        } catch (Throwable $conflictCheckError) {
            // 使用通用错误处理，避免把数据库细节暴露给客户端。
        }
        error_log('OAuth existing account link failed: ' . $error->getMessage());
        return ['success' => false, 'code' => 'OAUTH_LINK_FAILED', 'message' => '绑定已有账号失败，请稍后再试'];
    }
}

function oauthAccountAttachProviderToUser(PDO $db, string $provider, array $profile, int $targetUserId): array {
    $meta = oauthAccountProviderMeta($provider);
    $subject = trim((string)($profile[$meta['subject_key']] ?? ''));
    $unionid = $provider === 'qq' ? trim((string)($profile['unionid'] ?? '')) : '';
    if ($subject === '') {
        return ['success' => false, 'code' => 'OAUTH_PROVIDER_ID_MISSING', 'message' => '第三方身份无效'];
    }

    try {
        $db->beginTransaction();
        $target = oauthAccountFindUser($db, $targetUserId, true);
        if (!$target || ($target['status'] ?? '') !== 'active') {
            $db->rollBack();
            return ['success' => false, 'code' => 'TARGET_ACCOUNT_UNAVAILABLE', 'message' => '目标账号当前不可用'];
        }

        $targetValue = oauthAccountProviderValue($target, $provider);
        if ($targetValue !== '' && $targetValue !== $subject) {
            $db->rollBack();
            return ['success' => false, 'code' => 'TARGET_PROVIDER_ALREADY_BOUND', 'message' => '当前账号已经绑定了另一个同类账号'];
        }

        $owner = oauthAccountFindProviderOwner($db, $provider, $subject, true);
        if ($owner && (int)$owner['id'] !== $targetUserId) {
            $db->rollBack();
            return ['success' => false, 'code' => 'PROVIDER_CONFLICT', 'message' => '该第三方账号已绑定其他账号'];
        }

        if ($targetValue === '') {
            if ($provider === 'qq') {
                $db->prepare(
                    'UPDATE users SET qq_openid = ?, qq_unionid = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
                )->execute([$subject, $unionid !== '' ? $unionid : null, $targetUserId]);
            } else {
                $db->prepare(
                    'UPDATE users SET discord_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
                )->execute([$subject, $targetUserId]);
            }
        }

        $db->commit();
        return ['success' => true, 'target' => $target];
    } catch (Throwable $error) {
        if ($db->inTransaction()) $db->rollBack();
        try {
            if (oauthAccountFindProviderOwner($db, $provider, $subject)) {
                return ['success' => false, 'code' => 'PROVIDER_CONFLICT', 'message' => '该第三方账号已绑定其他账号'];
            }
        } catch (Throwable $conflictCheckError) {
            // 使用通用错误处理，避免把数据库细节暴露给客户端。
        }
        error_log('OAuth provider attach failed: ' . $error->getMessage());
        return ['success' => false, 'code' => 'PROVIDER_BIND_FAILED', 'message' => '第三方账号绑定失败，请稍后再试'];
    }
}

function oauthAccountTransferProviderToUser(PDO $db, string $provider, array $pending, int $targetUserId, ?string $challengeHash = null): array {
    $meta = oauthAccountProviderMeta($provider);
    $subject = trim((string)($pending['subject'] ?? ''));
    if ($subject === '') {
        return ['success' => false, 'code' => 'OAUTH_PROVIDER_ID_MISSING', 'message' => '第三方身份无效'];
    }

    try {
        $db->beginTransaction();
        $target = oauthAccountFindUser($db, $targetUserId, true);
        if (!$target || ($target['status'] ?? '') !== 'active') {
            $db->rollBack();
            return ['success' => false, 'code' => 'TARGET_ACCOUNT_UNAVAILABLE', 'message' => '当前账号不可用'];
        }
        if (empty($target['email_verified_at'])) {
            $db->rollBack();
            return ['success' => false, 'code' => 'TARGET_EMAIL_REQUIRED', 'message' => '请先验证当前账号邮箱'];
        }

        $owner = oauthAccountFindProviderOwner($db, $provider, $subject, true);
        if (!$owner) {
            $db->rollBack();
            return ['success' => false, 'code' => 'PROVIDER_CONFLICT', 'message' => '第三方账号归属已发生变化，请重新绑定'];
        }
        $ownerId = (int)$owner['id'];
        if ($ownerId === $targetUserId) {
            if ($challengeHash !== null && $challengeHash !== '') {
                if (!oauthAccountConsumeChallenge($db, $challengeHash)) {
                    $db->rollBack();
                    return ['success' => false, 'code' => 'OAUTH_CHALLENGE_CONSUMED', 'message' => '本次授权已完成或已失效'];
                }
            }
            $db->commit();
            return ['success' => true, 'source_id' => null, 'target_id' => $targetUserId];
        }
        if (($owner['status'] ?? '') !== 'active') {
            $db->rollBack();
            return ['success' => false, 'code' => 'PROVIDER_OWNER_UNAVAILABLE', 'message' => '该第三方账号当前不可转移'];
        }

        $targetValue = oauthAccountProviderValue($target, $provider);
        if ($targetValue !== '' && $targetValue !== $subject) {
            $db->rollBack();
            return ['success' => false, 'code' => 'TARGET_PROVIDER_ALREADY_BOUND', 'message' => '当前账号已经绑定了另一个同类账号'];
        }

        if ($provider === 'qq') {
            $unionid = trim((string)($owner['qq_unionid'] ?? ''));
            $db->prepare(
                'UPDATE users SET qq_openid = NULL, qq_unionid = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            )->execute([$ownerId]);
            $db->prepare(
                'UPDATE users SET qq_openid = ?, qq_unionid = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            )->execute([$subject, $unionid !== '' ? $unionid : null, $targetUserId]);
        } else {
            $db->prepare(
                'UPDATE users SET discord_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            )->execute([$ownerId]);
            $db->prepare(
                'UPDATE users SET discord_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            )->execute([$subject, $targetUserId]);
        }

        if ($challengeHash !== null && $challengeHash !== '') {
            if (!oauthAccountConsumeChallenge($db, $challengeHash)) {
                $db->rollBack();
                return ['success' => false, 'code' => 'OAUTH_CHALLENGE_CONSUMED', 'message' => '本次授权已完成或已失效'];
            }
        }
        $db->commit();
        return ['success' => true, 'source_id' => $ownerId, 'target_id' => $targetUserId];
    } catch (Throwable $error) {
        if ($db->inTransaction()) $db->rollBack();
        error_log('OAuth provider transfer failed: ' . $error->getMessage());
        return ['success' => false, 'code' => 'PROVIDER_TRANSFER_FAILED', 'message' => '第三方账号转移失败，请稍后再试'];
    }
}

function oauthAccountProcessCallback(string $provider, array $profile): void {
    $meta = oauthAccountProviderMeta($provider);
    initSession();

    $mode = (string)($_SESSION['oauth_mode'] ?? 'login');
    if (!in_array($mode, ['login', 'bind'], true)) $mode = 'login';
    $returnTo = oauthAccountSafeReturnTo($_SESSION['oauth_return_to'] ?? null, $meta['default_return']);
    $contextProvider = (string)($_SESSION['oauth_provider'] ?? '');
    if ($contextProvider !== $meta['provider']) {
        oauthAccountClearOAuthContext();
        header('Location: ' . oauthAccountCallbackRedirect($returnTo, 'error', '授权流程已失效，请重新开始'));
        exit();
    }
    unset($_SESSION['oauth_mode'], $_SESSION['oauth_return_to'], $_SESSION['oauth_provider'], $_SESSION['oauth_started_at']);

    $subject = trim((string)($profile[$meta['subject_key']] ?? ''));
    if ($subject === '') {
        header('Location: ' . oauthAccountCallbackRedirect($returnTo, 'error', '第三方身份无效'));
        exit();
    }

    try {
        $db = getDB();
        $owner = oauthAccountFindProviderOwner($db, $provider, $subject);

        if ($mode === 'bind') {
            $currentUser = getCurrentUser();
            if (!$currentUser) {
                header('Location: ' . oauthAccountCallbackRedirect('login.html', 'error', '请先登录再绑定' . $meta['label']));
                exit();
            }

            $currentUserId = (int)$currentUser['id'];
            if ($owner && (int)$owner['id'] === $currentUserId) {
                logAction('user.bind_' . $provider, 'user', $currentUserId, ['provider' => 'oauth_callback', 'result' => 'already_bound']);
                header('Location: ' . oauthAccountCallbackRedirect($returnTo, 'success', $meta['bind_message']));
                exit();
            }

            if ($owner && ($owner['status'] ?? '') !== 'active') {
                header('Location: ' . oauthAccountCallbackRedirect($returnTo, 'error', '该' . $meta['label'] . '账号当前不可转移'));
                exit();
            }

            if ($owner) {
                oauthAccountCreateChallenge($db, $provider, $profile, 'provider_transfer', $currentUserId, $returnTo);
                logAction('user.oauth_provider_transfer_started', 'user', $currentUserId, ['provider' => $provider]);
                header('Location: ' . oauthAccountPendingRedirect('provider-conflict'));
                exit();
            }

            $result = oauthAccountAttachProviderToUser($db, $provider, $profile, $currentUserId);
            if (!$result['success']) {
                header('Location: ' . oauthAccountCallbackRedirect($returnTo, 'error', (string)$result['message']));
                exit();
            }
            logAction('user.bind_' . $provider, 'user', $currentUserId, ['provider' => 'oauth_callback']);
            header('Location: ' . oauthAccountCallbackRedirect($returnTo, 'success', $meta['bind_message']));
            exit();
        }

        if ($owner) {
            if (($owner['status'] ?? '') !== 'active') {
                header('Location: ' . oauthAccountCallbackRedirect($returnTo, 'error', '该' . $meta['label'] . '账号当前不可登录'));
                exit();
            }
            createSession((int)$owner['id']);
            $db->prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([(int)$owner['id']]);
            logAction('user.login', 'user', (int)$owner['id'], ['provider' => $provider]);
            header('Location: ' . oauthAccountCallbackRedirect($returnTo, 'success', $meta['login_message']));
            exit();
        }

        $created = oauthAccountCreateSocialUser($db, $provider, $profile);
        if ($created['success']) {
            $userId = (int)$created['user_id'];
            createSession($userId);
            logAction('user.register', 'user', $userId, ['provider' => $provider, 'result' => 'social_only']);
            logAction('user.login', 'user', $userId, ['provider' => $provider]);
            if (function_exists('backfillAnnouncements')) backfillAnnouncements($userId);
            header('Location: ' . oauthAccountCallbackRedirect($returnTo, 'success', $meta['login_message']));
            exit();
        }

        if (($created['code'] ?? '') === 'PROVIDER_CONFLICT') {
            // 并发 OAuth 回调可能在首次查询后才创建账号。重新读取后按普通登录处理。
            $owner = oauthAccountFindProviderOwner($db, $provider, $subject);
            if ($owner && ($owner['status'] ?? '') === 'active') {
                createSession((int)$owner['id']);
                $db->prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([(int)$owner['id']]);
                logAction('user.login', 'user', (int)$owner['id'], ['provider' => $provider]);
                header('Location: ' . oauthAccountCallbackRedirect($returnTo, 'success', $meta['login_message']));
                exit();
            }
            if ($owner) {
                header('Location: ' . oauthAccountCallbackRedirect($returnTo, 'error', '该' . $meta['label'] . '账号当前不可登录'));
                exit();
            }
        }

        header('Location: ' . oauthAccountCallbackRedirect($returnTo, 'error', (string)($created['message'] ?? '账号创建失败，请稍后重试')));
        exit();
    } catch (Throwable $error) {
        error_log('OAuth account callback failed: ' . $error->getMessage());
        header('Location: ' . oauthAccountCallbackRedirect($returnTo, 'error', '登录服务暂时不可用，请稍后再试'));
        exit();
    }
}
