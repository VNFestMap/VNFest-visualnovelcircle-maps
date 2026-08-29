<?php
// includes/recognition/credential.php - 凭证签发服务（架构文档 17.3）
// 唯一允许创建/变更凭证状态的服务。任何 API、Connector、后台页面不得绕过。

require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../audit.php';
require_once __DIR__ . '/events.php';
require_once __DIR__ . '/outbox.php';

/**
 * 生成公开凭证编号
 */
function recogGenerateCredentialUid(): string {
    $prefix = defined('RECOGNITION_CRED_PREFIX') ? RECOGNITION_CRED_PREFIX : 'VNF-CRED-';
    return $prefix . date('Ymd') . '-' . strtoupper(bin2hex(random_bytes(4)));
}

/**
 * 签发凭证（唯一入口）
 * $args 必填：holder_user_id, badge_id, issuer_club_id, program_id, program_version_id
 * $args 可选：issuer_country, credential_type, verification_level, condition_summary(array),
 *            evidence_refs(array), expires_at, source_type, actor_user_id
 * @return array ['ok' => bool, 'duplicate' => bool, 'credential' => array|null, 'error' => string|null]
 */
function issueCredential(PDO $db, array $args): array {
    $holderId   = (int)($args['holder_user_id'] ?? 0);
    $badgeId    = (int)($args['badge_id'] ?? 0);
    $versionId  = (int)($args['program_version_id'] ?? 0);
    $programId  = (int)($args['program_id'] ?? 0);
    $clubId     = (int)($args['issuer_club_id'] ?? 0);

    if ($holderId <= 0 || $badgeId <= 0 || $versionId <= 0 || $clubId <= 0) {
        return ['ok' => false, 'duplicate' => false, 'credential' => null, 'error' => '签发参数不完整'];
    }

    // 持有人必须是活跃用户
    $stmt = $db->prepare("SELECT id FROM users WHERE id = ? AND status = 'active'");
    $stmt->execute([$holderId]);
    if (!$stmt->fetch()) {
        return ['ok' => false, 'duplicate' => false, 'credential' => null, 'error' => '持有人账号不存在或不可用'];
    }

    // 徽章定义与版本
    $stmt = $db->prepare('SELECT id, name, version FROM recognition_badges WHERE id = ?');
    $stmt->execute([$badgeId]);
    $badge = $stmt->fetch();
    if (!$badge) {
        return ['ok' => false, 'duplicate' => false, 'credential' => null, 'error' => '徽章定义不存在'];
    }

    // 限量签发：同版本同徽章已签发总量（含历史）不得超过 max_issuance（>0 时）
    $stmt = $db->prepare('SELECT max_issuance, credential_ttl_days, title FROM recognition_programs WHERE id = ?');
    $stmt->execute([$programId]);
    $program = $stmt->fetch();
    if ($program) {
        $maxIssuance = (int)$program['max_issuance'];
        if ($maxIssuance > 0) {
            $stmt = $db->prepare('SELECT COUNT(*) AS c FROM recognition_credentials WHERE program_version_id = ? AND badge_id = ?');
            $stmt->execute([$versionId, $badgeId]);
            if ((int)$stmt->fetch()['c'] >= $maxIssuance) {
                return ['ok' => false, 'duplicate' => false, 'credential' => null, 'error' => '该徽章已达限量签发上限'];
            }
        }
    }

    $expiresAt = $args['expires_at'] ?? null;
    if (!$expiresAt && $program && (int)$program['credential_ttl_days'] > 0) {
        $expiresAt = date('Y-m-d H:i:s', time() + (int)$program['credential_ttl_days'] * 86400);
    }

    $uid = recogGenerateCredentialUid();
    $conditionSnapshot = json_encode([
        'conditions' => $args['condition_summary'] ?? [],
        'verification_level' => $args['verification_level'] ?? 'auto',
        'source_type' => $args['source_type'] ?? 'auto_rule',
    ], JSON_UNESCAPED_UNICODE);

    // 预检：已持有同版本同徽章的 active 凭证 → 直接返回重复，不写入（双方言一致）
    $stmt = $db->prepare(
        "SELECT id, credential_uid FROM recognition_credentials
         WHERE program_version_id = ? AND holder_user_id = ? AND badge_id = ? AND status = 'active'"
    );
    $stmt->execute([$versionId, $holderId, $badgeId]);
    if ($existing = $stmt->fetch()) {
        return ['ok' => true, 'duplicate' => true, 'credential' => $existing, 'error' => null];
    }

    $isMysql = defined('DB_DRIVER') && DB_DRIVER === 'mysql';
    $sql = 'INSERT INTO recognition_credentials
        (credential_uid, holder_user_id, badge_id, badge_version, issuer_club_id, issuer_country,
         program_id, program_version_id, credential_type, verification_level, status,
         condition_snapshot, evidence_refs, public_visibility, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)';
    if ($isMysql) {
        // 并发窗口兜底：MySQL 用 INSERT IGNORE，冲突时 rowCount = 0
        $sql = str_replace('INSERT INTO', 'INSERT IGNORE INTO', $sql);
    }

    try {
        $stmt = $db->prepare($sql);
        $stmt->execute([
            $uid,
            $holderId,
            $badgeId,
            (int)$badge['version'],
            $clubId,
            (string)($args['issuer_country'] ?? 'china'),
            $programId,
            $versionId,
            (string)($args['credential_type'] ?? 'participation'),
            (string)($args['verification_level'] ?? 'auto'),
            'active',
            $conditionSnapshot,
            isset($args['evidence_refs']) ? json_encode($args['evidence_refs'], JSON_UNESCAPED_UNICODE) : null,
            $expiresAt,
        ]);
    } catch (PDOException $e) {
        $msg = $e->getMessage();
        if (stripos($msg, 'UNIQUE') !== false || stripos($msg, 'duplicate') !== false) {
            // SQLite 并发窗口：唯一约束冲突同样视为重复签发，返回已有凭证（架构文档 9.4 语义）
            $stmt = $db->prepare(
                "SELECT id, credential_uid FROM recognition_credentials
                 WHERE program_version_id = ? AND holder_user_id = ? AND badge_id = ? AND status = 'active'"
            );
            $stmt->execute([$versionId, $holderId, $badgeId]);
            return ['ok' => true, 'duplicate' => true, 'credential' => $stmt->fetch() ?: null, 'error' => null];
        }
        error_log('[recog] issue credential failed: ' . $msg);
        return ['ok' => false, 'duplicate' => false, 'credential' => null, 'error' => '凭证写入失败'];
    }

    // MySQL INSERT IGNORE 冲突时 rowCount = 0，此时同样视为重复签发
    if ($isMysql && $stmt->rowCount() === 0) {
        $stmt = $db->prepare(
            "SELECT id, credential_uid FROM recognition_credentials
             WHERE program_version_id = ? AND holder_user_id = ? AND badge_id = ? AND status = 'active'"
        );
        $stmt->execute([$versionId, $holderId, $badgeId]);
        return ['ok' => true, 'duplicate' => true, 'credential' => $stmt->fetch() ?: null, 'error' => null];
    }

    $credId = (int)$db->lastInsertId();
    if ($credId <= 0) {
        return ['ok' => false, 'duplicate' => false, 'credential' => null, 'error' => '凭证写入失败'];
    }

    $credential = [
        'id' => $credId,
        'credential_uid' => $uid,
        'badge_name' => $badge['name'],
        'program_title' => $program['title'] ?? '',
        'expires_at' => $expiresAt,
    ];

    // credential.issued 事件（幂等键绑定本次签发）
    recogRecordEvent([
        'type' => 'credential.issued',
        'idempotency_key' => 'cred_issue_' . $credId,
        'club_id' => $clubId,
        'country' => (string)($args['issuer_country'] ?? 'china'),
        'user_id' => $holderId,
        'program_id' => $programId,
        'program_version_id' => $versionId,
        'badge_id' => $badgeId,
        'data' => ['credential_uid' => $uid, 'verification_level' => $args['verification_level'] ?? 'auto'],
        'source_verified' => true,
    ]);

    logAction('recog_credential_issued', 'recognition_credential', $credId, [
        'credential_uid' => $uid,
        'holder_user_id' => $holderId,
        'badge_id' => $badgeId,
        'program_version_id' => $versionId,
        'verification_level' => $args['verification_level'] ?? 'auto',
        'source_type' => $args['source_type'] ?? 'auto_rule',
        'actor_user_id' => $args['actor_user_id'] ?? null,
    ]);

    // 通知走 outbox，与签发同库，失败可补偿
    recogEnqueueOutbox($db, 'notify_credential_issued', [
        'credential_id' => $credId,
        'credential_uid' => $uid,
        'user_id' => $holderId,
        'badge_name' => $badge['name'],
        'program_title' => $program['title'] ?? '',
    ]);

    return ['ok' => true, 'duplicate' => false, 'credential' => $credential, 'error' => null];
}

/**
 * 撤销凭证（保留历史记录，不物理删除；架构文档 14.4）
 * 权限由调用方（API 层）校验：签发同好会 manager/representative 或 super_admin。
 */
function revokeCredential(PDO $db, string $credentialUid, string $reason, int $actorUserId): array {
    if (trim($reason) === '') {
        return ['ok' => false, 'error' => '撤销必须填写原因'];
    }

    $stmt = $db->prepare('SELECT * FROM recognition_credentials WHERE credential_uid = ?');
    $stmt->execute([$credentialUid]);
    $cred = $stmt->fetch();
    if (!$cred) {
        return ['ok' => false, 'error' => '凭证不存在'];
    }
    if ($cred['status'] !== 'active') {
        return ['ok' => false, 'error' => '凭证当前状态为 ' . $cred['status'] . '，不可撤销'];
    }

    $db->prepare(
        'UPDATE recognition_credentials SET status = ?, revocation_reason = ?, revoked_at = ?, revoked_by = ? WHERE id = ?'
    )->execute(['revoked', recogSafeSubstr(trim($reason), 250), date('Y-m-d H:i:s'), $actorUserId, $cred['id']]);

    recogRecordEvent([
        'type' => 'credential.revoked',
        'idempotency_key' => 'cred_revoke_' . $cred['id'],
        'club_id' => (int)$cred['issuer_club_id'],
        'country' => (string)$cred['issuer_country'],
        'user_id' => (int)$cred['holder_user_id'],
        'program_id' => (int)$cred['program_id'],
        'program_version_id' => (int)$cred['program_version_id'],
        'badge_id' => (int)$cred['badge_id'],
        'data' => ['credential_uid' => $credentialUid, 'reason' => $reason],
        'source_verified' => true,
    ]);

    logAction('recog_credential_revoked', 'recognition_credential', (int)$cred['id'], [
        'credential_uid' => $credentialUid,
        'reason' => $reason,
    ]);

    $stmt = $db->prepare('SELECT name FROM recognition_badges WHERE id = ?');
    $stmt->execute([(int)$cred['badge_id']]);
    $badgeName = $stmt->fetch()['name'] ?? '';
    recogEnqueueOutbox($db, 'notify_credential_revoked', [
        'credential_id' => (int)$cred['id'],
        'user_id' => (int)$cred['holder_user_id'],
        'badge_name' => $badgeName,
        'reason' => $reason,
    ]);

    return ['ok' => true, 'error' => null];
}

/**
 * 过期扫描（由 worker 定期调用）：将到期的 active 凭证置为 expired，并通知持有人。
 */
function expireDueCredentials(PDO $db, int $limit = 200): int {
    $stmt = $db->prepare(
        "SELECT id, credential_uid, holder_user_id, badge_id, program_id FROM recognition_credentials
         WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ? LIMIT " . (int)$limit
    );
    $stmt->execute([date('Y-m-d H:i:s')]);
    $rows = $stmt->fetchAll();

    foreach ($rows as $cred) {
        $db->prepare("UPDATE recognition_credentials SET status = 'expired' WHERE id = ?")->execute([$cred['id']]);

        recogRecordEvent([
            'type' => 'credential.expired',
            'idempotency_key' => 'cred_expire_' . $cred['id'],
            'user_id' => (int)$cred['holder_user_id'],
            'program_id' => (int)$cred['program_id'],
            'badge_id' => (int)$cred['badge_id'],
            'data' => ['credential_uid' => $cred['credential_uid']],
            'source_verified' => true,
        ]);

        $b = $db->prepare('SELECT name FROM recognition_badges WHERE id = ?');
        $b->execute([(int)$cred['badge_id']]);
        $badgeName = $b->fetch()['name'] ?? '';
        $p = $db->prepare('SELECT title FROM recognition_programs WHERE id = ?');
        $p->execute([(int)$cred['program_id']]);
        $programTitle = $p->fetch()['title'] ?? '';

        recogEnqueueOutbox($db, 'notify_credential_expired', [
            'credential_id' => (int)$cred['id'],
            'user_id' => (int)$cred['holder_user_id'],
            'badge_name' => $badgeName,
            'program_title' => $programTitle,
        ]);
    }

    if ($rows) {
        logAction('recog_credentials_expired', 'recognition_credential', null, ['count' => count($rows)]);
    }
    return count($rows);
}
