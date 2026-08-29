<?php
// includes/recognition/events.php - 统一事件模型（架构文档第 9 节）
// 事件命名：资源.动作；自定义事件必须为 custom.<club_id>.<event_name>。
// 幂等：event_id / idempotency_key UNIQUE，重复提交返回原记录而不重复处理。

require_once __DIR__ . '/../db.php';

/**
 * 多字节安全的长度/截断（部分环境未启用 mbstring 时降级为字节级处理）
 */
function recogSafeStrlen(string $text): int {
    return function_exists('mb_strlen') ? mb_strlen($text) : strlen($text);
}

function recogSafeSubstr(string $text, int $length): string {
    return function_exists('mb_substr') ? mb_substr($text, 0, $length) : substr($text, 0, $length);
}

// 平台标准事件白名单（资源.动作）
const RECOGNITION_STANDARD_EVENTS = [
    'assessment.started',
    'assessment.completed',
    'assessment.passed',
    'assessment.failed',
    'activity.registered',
    'activity.attended',
    'submission.created',
    'submission.approved',
    'submission.rejected',
    'review.completed',
    'award.approved',
    'credential.issued',
    'credential.revoked',
    'credential.expired',
    'credential.superseded',
];

/**
 * 校验事件类型命名（拒绝 done / success / pass2 等模糊命名）
 * @return string|null 错误信息，合法返回 null
 */
function recogValidateEventType(string $type, ?int $clubId = null): ?string {
    if ($type === '' || strlen($type) > 128) {
        return '事件类型长度非法';
    }
    // 标准事件
    if (in_array($type, RECOGNITION_STANDARD_EVENTS, true)) {
        return null;
    }
    // 自定义事件：custom.<club_id>.<event_name>
    if (str_starts_with($type, 'custom.')) {
        $parts = explode('.', $type, 3);
        if (count($parts) !== 3 || $parts[1] === '' || $parts[2] === '') {
            return '自定义事件必须使用 custom.<club_id>.<event_name> 命名空间';
        }
        if (!preg_match('/^[a-z0-9_]+$/', $parts[1]) || !preg_match('/^[a-z0-9_]+$/', $parts[2])) {
            return '自定义事件名只允许小写字母、数字和下划线';
        }
        // 提交方声明的 club 必须与命名空间一致
        if ($clubId !== null && 'club_' . $clubId !== $parts[1] && (string)$clubId !== $parts[1]) {
            return '自定义事件命名空间与同好会身份不一致';
        }
        return null;
    }
    // 其余通用事件必须是 资源.动作 且在白名单外不允许随意新增
    return '未知事件类型：' . $type;
}

/**
 * 生成事件唯一编号
 */
function recogGenerateEventId(): string {
    return 'evt_' . date('YmdHis') . '_' . bin2hex(random_bytes(6));
}

/**
 * 写入统一事件（站内与外部共用入口）
 * 返回 ['event' => array, 'duplicate' => bool, 'error' => string|null]
 */
function recogRecordEvent(array $e): array {
    $db = getDB();

    $eventId = $e['event_id'] ?? recogGenerateEventId();
    $idempotencyKey = (string)($e['idempotency_key'] ?? '');
    if ($idempotencyKey === '') {
        // 无显式幂等键时以 event_id 兜底，保证 UNIQUE 约束可用
        $idempotencyKey = $eventId;
    }

    $type = (string)($e['type'] ?? '');
    $err = recogValidateEventType($type, isset($e['club_id']) ? (int)$e['club_id'] : null);
    if ($err !== null) {
        return ['event' => null, 'duplicate' => false, 'error' => $err];
    }

    $occurredAt = $e['occurred_at'] ?? date('Y-m-d H:i:s');

    $sql = 'INSERT INTO recognition_events
        (event_id, idempotency_key, schema_version, type, club_id, country, user_id,
         program_id, program_version_id, badge_id, connector_id, occurred_at, data,
         evidence_refs, source_verified, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    $params = [
        $eventId,
        $idempotencyKey,
        (string)($e['schema_version'] ?? '1.0'),
        $type,
        isset($e['club_id']) ? (int)$e['club_id'] : null,
        (string)($e['country'] ?? 'china'),
        isset($e['user_id']) ? (int)$e['user_id'] : null,
        isset($e['program_id']) ? (int)$e['program_id'] : null,
        isset($e['program_version_id']) ? (int)$e['program_version_id'] : null,
        isset($e['badge_id']) ? (int)$e['badge_id'] : null,
        isset($e['connector_id']) ? (int)$e['connector_id'] : null,
        $occurredAt,
        isset($e['data']) ? json_encode($e['data'], JSON_UNESCAPED_UNICODE) : null,
        isset($e['evidence_refs']) ? json_encode($e['evidence_refs'], JSON_UNESCAPED_UNICODE) : null,
        !empty($e['source_verified']) ? 1 : 0,
        'processed',
    ];

    try {
        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        $id = (int)$db->lastInsertId();
        return ['event' => ['id' => $id, 'event_id' => $eventId, 'type' => $type], 'duplicate' => false, 'error' => null];
    } catch (PDOException $ex) {
        $msg = $ex->getMessage();
        if (stripos($msg, 'UNIQUE') !== false || stripos($msg, 'duplicate') !== false) {
            // 重复事件：返回原处理结果（架构文档 9.4）
            $stmt = $db->prepare('SELECT id, event_id, type, status FROM recognition_events WHERE event_id = ? OR idempotency_key = ?');
            $stmt->execute([$eventId, $idempotencyKey]);
            $existing = $stmt->fetch();
            return ['event' => $existing ?: null, 'duplicate' => true, 'error' => null];
        }
        error_log('[recog] event insert failed: ' . $msg);
        return ['event' => null, 'duplicate' => false, 'error' => '事件写入失败'];
    }
}

/**
 * 统计用户对某版本某事件类型的累计次数（规则引擎用）
 */
function recogCountUserEvents(int $userId, int $programVersionId, string $type): int {
    $db = getDB();
    $stmt = $db->prepare(
        'SELECT COUNT(*) AS c FROM recognition_events WHERE user_id = ? AND program_version_id = ? AND type = ?'
    );
    $stmt->execute([$userId, $programVersionId, $type]);
    return (int)($stmt->fetch()['c'] ?? 0);
}
