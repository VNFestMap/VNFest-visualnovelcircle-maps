<?php
/**
 * 通知系统工具函数
 * 依赖 db.php 和 config.php
 */

/**
 * 创建一条通知
 *
 * @param int    $toUserId    接收者用户 ID
 * @param string $type        通知类型 (galonly_approved, galonly_rejected, join_*, role_changed, member_kicked, system)
 * @param string $title       通知标题
 * @param string $message     通知正文（可选）
 * @param string $link        点击跳转链接（可选）
 * @param string $relatedType 关联类型（可选，如 'galonly_application'）
 * @param int    $relatedId   关联 ID（可选）
 * @return bool
 */
function createNotification(
    int $toUserId,
    string $type,
    string $title,
    string $message = '',
    string $link = '',
    string $relatedType = '',
    int $relatedId = 0
): bool {
    if ($toUserId <= 0 || empty($type) || empty($title)) {
        return false;
    }

    try {
        $db = getDB();
        $stmt = $db->prepare("
            INSERT INTO notifications (user_id, type, title, message, link, related_type, related_id)
            VALUES (:user_id, :type, :title, :message, :link, :related_type, :related_id)
        ");
        $stmt->execute([
            ':user_id'      => $toUserId,
            ':type'         => $type,
            ':title'        => $title,
            ':message'      => $message,
            ':link'         => $link,
            ':related_type' => $relatedType,
            ':related_id'   => $relatedId,
        ]);
        return true;
    } catch (PDOException $e) {
        error_log('createNotification failed: ' . $e->getMessage());
        return false;
    }
}

/**
 * 向所有活跃用户广播通知
 *
 * @param string $type    通知类型
 * @param string $title   通知标题
 * @param string $message 通知正文
 * @param string $link    跳转链接
 * @return int 成功发送数
 */
function broadcastNotification(
    string $type,
    string $title,
    string $message = '',
    string $link = '',
    string $relatedType = '',
    int $relatedId = 0
): int {
    $sent = 0;
    try {
        $db = getDB();
        $stmt = $db->query("SELECT id FROM users WHERE status = 'active'");
        while ($row = $stmt->fetch()) {
            if (createNotification((int)$row['id'], $type, $title, $message, $link, $relatedType, $relatedId)) {
                $sent++;
            }
        }
    } catch (PDOException $e) {
        error_log('broadcastNotification failed: ' . $e->getMessage());
    }
    return $sent;
}

/**
 * 为新用户回填全站公告通知
 *
 * @param int $userId 新注册用户 ID
 * @return int 回填成功数
 */
function backfillAnnouncements(int $userId): int {
    $count = 0;
    try {
        $db = getDB();
        $stmt = $db->query("SELECT id, title, content FROM announcements WHERE status = 'published' AND is_persistent = 1");
        while ($ann = $stmt->fetch()) {
            if (createNotification(
                (int)$userId,
                'system',
                '📢 全站公告：' . $ann['title'],
                (string)($ann['content'] ?? ''),
                '',
                'announcement',
                (int)$ann['id']
            )) {
                $count++;
            }
        }
    } catch (PDOException $e) {
        error_log('backfillAnnouncements failed: ' . $e->getMessage());
    }
    return $count;
}
