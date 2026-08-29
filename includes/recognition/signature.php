<?php
// includes/recognition/signature.php - 外部请求签名校验（架构文档 18.1）
// HMAC-SHA256 签名 + 时间戳防重放窗口；事件重放另由 idempotency_key 唯一约束兜底。

require_once __DIR__ . '/../db.php';

const RECOGNITION_TIMESTAMP_WINDOW = 300; // 秒

/**
 * 生成签名（接入方与平台共用算法）
 * 签名内容：timestamp + '.' + raw_body
 */
function recogSignPayload(string $secret, string $rawBody, string $timestamp): string {
    return hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
}

/**
 * 校验请求签名
 * @return array ['ok' => bool, 'error' => string|null]
 */
function recogVerifySignature(string $secret, string $rawBody, ?string $signature, ?string $timestamp): array {
    if ($secret === '') {
        return ['ok' => false, 'error' => '服务端未配置签名密钥'];
    }
    if (!$signature || !$timestamp) {
        return ['ok' => false, 'error' => '缺少签名或时间戳'];
    }
    if (!ctype_digit($timestamp)) {
        return ['ok' => false, 'error' => '时间戳格式非法'];
    }
    $delta = abs(time() - (int)$timestamp);
    if ($delta > RECOGNITION_TIMESTAMP_WINDOW) {
        return ['ok' => false, 'error' => '请求时间戳超出允许窗口，可能为重放'];
    }
    $expected = recogSignPayload($secret, $rawBody, $timestamp);
    if (!hash_equals($expected, $signature)) {
        return ['ok' => false, 'error' => '签名校验失败'];
    }
    return ['ok' => true, 'error' => null];
}

/**
 * 按 Bearer Token 定位活跃 Connector（token 仅存哈希，参照 club_bot_tokens 模式）
 * @return array|null connector 行；未找到返回 null
 */
function recogFindConnectorByToken(string $token): ?array {
    if ($token === '' || strlen($token) < 24) {
        return null;
    }
    $prefix = substr($token, 0, 12);
    $db = getDB();
    $stmt = $db->prepare(
        "SELECT * FROM recognition_connectors WHERE token_prefix = ? AND status = 'active' AND revoked_at IS NULL"
    );
    $stmt->execute([$prefix]);
    foreach ($stmt->fetchAll() as $row) {
        if (hash_equals($row['token_hash'], hash('sha256', $token))) {
            // 更新最后使用时间（失败不影响主流程）
            try {
                $db->prepare('UPDATE recognition_connectors SET last_used_at = ? WHERE id = ?')
                    ->execute([date('Y-m-d H:i:s'), $row['id']]);
            } catch (PDOException $e) {
            }
            $row['scope'] = json_decode($row['scope'] ?? '[]', true) ?: [];
            return $row;
        }
    }
    return null;
}

/**
 * 校验 Connector 的事件写入范围（API Scope，最小权限）
 * @return bool
 */
function recogConnectorAllowsEvent(array $connector, string $eventType, ?int $programId): bool {
    $scope = $connector['scope'] ?? [];
    if (!in_array('event:write', $scope['permissions'] ?? [], true)) {
        return false;
    }
    $allowedTypes = $scope['event_types'] ?? [];
    if (!empty($allowedTypes) && !in_array($eventType, $allowedTypes, true)) {
        return false;
    }
    $allowedPrograms = $scope['program_ids'] ?? [];
    if (!empty($allowedPrograms) && $programId !== null && !in_array($programId, array_map('intval', $allowedPrograms), true)) {
        return false;
    }
    return true;
}
