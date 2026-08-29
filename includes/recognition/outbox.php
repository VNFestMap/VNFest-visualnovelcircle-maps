<?php
// includes/recognition/outbox.php - 事务 Outbox（架构文档 19.3）
// 签发等关键动作与后续异步任务（站内通知等）写入同一数据库连接，
// 由 scripts/recognition_worker.php（cron）消费，保证"业务写入成功 + 后续动作完成"。

require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../notifications.php';

const RECOGNITION_OUTBOX_MAX_ATTEMPTS = 5;

/**
 * 入队一条异步任务（与业务写入共用同一连接/事务）
 */
function recogEnqueueOutbox(PDO $db, string $taskType, array $payload): void {
    $stmt = $db->prepare(
        'INSERT INTO recognition_outbox (task_type, payload) VALUES (?, ?)'
    );
    $stmt->execute([$taskType, json_encode($payload, JSON_UNESCAPED_UNICODE)]);
}

/**
 * 消费待处理任务（由 recognition_worker.php 调用）
 * @return array ['processed' => int, 'failed' => int]
 */
function recogProcessOutbox(PDO $db, int $limit = 50): array {
    $stmt = $db->prepare(
        "SELECT id, task_type, payload FROM recognition_outbox
         WHERE status = 'pending' ORDER BY id ASC LIMIT " . (int)$limit
    );
    $stmt->execute();
    $rows = $stmt->fetchAll();

    $processed = 0;
    $failed = 0;

    foreach ($rows as $row) {
        $payload = json_decode($row['payload'] ?? '[]', true) ?: [];
        try {
            recogHandleOutboxTask($db, $row['task_type'], $payload);
            $db->prepare(
                "UPDATE recognition_outbox SET status = 'done', processed_at = " .
                ((defined('DB_DRIVER') && DB_DRIVER === 'mysql') ? 'NOW()' : "datetime('now')") .
                ' WHERE id = ?'
            )->execute([$row['id']]);
            $processed++;
        } catch (Throwable $e) {
            $failed++;
            $attempts = 0;
            $cnt = $db->prepare('SELECT attempts FROM recognition_outbox WHERE id = ?');
            $cnt->execute([$row['id']]);
            if ($r = $cnt->fetch()) {
                $attempts = (int)$r['attempts'] + 1;
            }
            $newStatus = $attempts >= RECOGNITION_OUTBOX_MAX_ATTEMPTS ? 'failed' : 'pending';
            $db->prepare('UPDATE recognition_outbox SET attempts = ?, status = ?, last_error = ? WHERE id = ?')
                ->execute([
                    $attempts,
                    $newStatus,
                    function_exists('mb_substr') ? mb_substr($e->getMessage(), 0, 480) : substr($e->getMessage(), 0, 480),
                    $row['id'],
                ]);
            error_log('[recog] outbox task ' . $row['task_type'] . ' failed: ' . $e->getMessage());
        }
    }

    return ['processed' => $processed, 'failed' => $failed];
}

/**
 * 任务分发
 */
function recogHandleOutboxTask(PDO $db, string $taskType, array $payload): void {
    switch ($taskType) {
        case 'notify_credential_issued':
            createNotification(
                (int)$payload['user_id'],
                'recognition_issued',
                '获得新徽章：' . ($payload['badge_name'] ?? ''),
                '你通过了「' . ($payload['program_title'] ?? '') . '」，获得来自同好会的认可。',
                '/verify.html?uid=' . urlencode((string)($payload['credential_uid'] ?? '')),
                'recognition_credential',
                (int)($payload['credential_id'] ?? 0)
            );
            break;
        case 'notify_credential_revoked':
            createNotification(
                (int)$payload['user_id'],
                'recognition_revoked',
                '凭证状态变更：' . ($payload['badge_name'] ?? ''),
                '你的凭证已被签发方撤销（' . ($payload['reason'] ?? '未说明原因') . '）。该记录仍保留在你的履历中。',
                '/user.html?tab=achievements',
                'recognition_credential',
                (int)($payload['credential_id'] ?? 0)
            );
            break;
        case 'notify_credential_expired':
            createNotification(
                (int)$payload['user_id'],
                'recognition_expired',
                '凭证已过期：' . ($payload['badge_name'] ?? ''),
                '你在「' . ($payload['program_title'] ?? '') . '」获得的凭证已过有效期，历史记录仍可在成就库查看。',
                '/user.html?tab=achievements',
                'recognition_credential',
                (int)($payload['credential_id'] ?? 0)
            );
            break;
        default:
            throw new RuntimeException('未知任务类型：' . $taskType);
    }
}
