<?php
// api/membership.php - 同好会绑定申请/审批 API
// 动作: my, apply, approve, reject, pending, members

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/audit.php';
require_once __DIR__ . '/../includes/mailer.php';
require_once __DIR__ . '/../includes/notifications.php';
require_once __DIR__ . '/../includes/display_club.php';

$action = $_GET['action'] ?? '';

/**
 * 从 JSON 文件中查找同好会名称
 */
function getClubName($clubId, $country = 'china') {
    $file = $country === 'japan'
        ? __DIR__ . '/../data/clubs_japan.json'
        : __DIR__ . '/../data/clubs.json';
    if (!file_exists($file)) return '同好会#' . $clubId;
    $json = json_decode(file_get_contents($file), true);
    if (!is_array($json)) return '同好会#' . $clubId;
    foreach (($json['data'] ?? []) as $club) {
        if (($club['id'] ?? 0) == $clubId) {
            return $club['name'] ?? $club['display_name'] ?? '同好会#' . $clubId;
        }
    }
    return '同好会#' . $clubId;
}

function membershipApplicationLabel(string $value, array $labels): string {
    return $labels[$value] ?? $value;
}

function membershipApplicationMailText(string $value): string {
    $value = trim(preg_replace('/[\r\n]+/', ' ', $value));
    return $value === '' ? '用户' : $value;
}

/**
 * 向目标同好会的有效负责人/管理员发送待审批申请提醒。
 * 邮件属于附加通知，所有异常均不得影响已经提交的申请。
 *
 * @return array{eligible:int,sent:int,failed:int}
 */
function notifyMembershipApplicationApprovers(
    PDO $db,
    array $applicant,
    int $clubId,
    string $country,
    string $applyRole,
    string $joinMethod,
    int $membershipId
): array {
    $result = ['eligible' => 0, 'sent' => 0, 'failed' => 0];
    $clubName = membershipApplicationMailText((string)getClubName($clubId, $country));
    $applicantName = membershipApplicationMailText((string)(
        !empty($applicant['nickname']) ? $applicant['nickname'] : ($applicant['username'] ?? '用户')
    ));
    $roleLabel = membershipApplicationLabel($applyRole, [
        'member' => '成员',
        'manager' => '管理员',
        'representative' => '负责人',
        'external' => '外交成员（IEM）',
    ]);
    $methodLabel = membershipApplicationLabel($joinMethod, [
        'school_no_code' => '校内申请',
        'external_exchange' => '校际交流申请',
    ]);
    $approvalUrl = (defined('SITE_URL') ? rtrim((string)SITE_URL, '/') : '') . '/index.html';
    $subject = '【VNFest】同好会「' . $clubName . '」有新的加入申请';
    $body = "您好：\n\n";
    $body .= '用户「' . $applicantName . '」提交了加入同好会「' . $clubName . "」的申请。\n";
    $body .= '申请身份：' . $roleLabel . "\n";
    $body .= '申请方式：' . $methodLabel . "\n\n";
    $body .= "请登录 VNFest 审批中心处理：\n" . $approvalUrl . "\n";

    try {
        $stmt = $db->prepare(
            "SELECT DISTINCT u.id, u.email
             FROM club_memberships cm
             JOIN users u ON u.id = cm.user_id
             WHERE cm.club_id = ?
               AND cm.country = ?
               AND cm.role IN ('representative', 'manager')
               AND cm.status = 'active'
               AND COALESCE(cm.application_email_enabled, 1) = 1
               AND u.status = 'active'
               AND COALESCE(u.membership_application_email_enabled, 1) = 1
               AND u.email IS NOT NULL
               AND TRIM(u.email) <> ''
               AND u.email_verified_at IS NOT NULL
               AND TRIM(u.email_verified_at) <> ''"
        );
        $stmt->execute([$clubId, $country]);
        $approvers = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        error_log('membership application email recipient lookup failed: ' . $e->getMessage());
        $result['failed'] = 1;
        membershipApplicationMailAudit($membershipId, $clubId, $country, $result);
        return $result;
    }

    $sentAddresses = [];
    foreach ($approvers as $approver) {
        $email = trim((string)($approver['email'] ?? ''));
        $emailKey = strtolower($email);
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || isset($sentAddresses[$emailKey])) {
            continue;
        }
        $sentAddresses[$emailKey] = true;
        $result['eligible']++;
        try {
            if (sendMail($email, $subject, $body)) {
                $result['sent']++;
            } else {
                $result['failed']++;
                error_log('membership application email send failed for membership_id=' . $membershipId);
            }
        } catch (Throwable $e) {
            $result['failed']++;
            error_log('membership application email send failed for membership_id=' . $membershipId . ': ' . $e->getMessage());
        }
    }

    membershipApplicationMailAudit($membershipId, $clubId, $country, $result);
    return $result;
}

function membershipApplicationMailAudit(int $membershipId, int $clubId, string $country, array $result): void {
    try {
        logAction('membership.application_email_notification', 'club_membership', $membershipId, [
            'club_id' => $clubId,
            'country' => $country,
            'eligible_recipients' => (int)($result['eligible'] ?? 0),
            'sent_count' => (int)($result['sent'] ?? 0),
            'failed_count' => (int)($result['failed'] ?? 0),
        ]);
    } catch (Throwable $e) {
        error_log('membership application email audit failed: ' . $e->getMessage());
    }
}

function ensureMembershipApplicationColumns(PDO $db): void {
    ensureColumnExists($db, 'club_memberships', 'qq_account', "VARCHAR(255) DEFAULT ''");
    ensureColumnExists($db, 'club_memberships', 'apply_role', "VARCHAR(50) DEFAULT 'member'");
    ensureColumnExists($db, 'club_memberships', 'is_student', "INT DEFAULT 0");
    ensureColumnExists($db, 'club_memberships', 'country', "VARCHAR(20) DEFAULT 'china'");
    ensureColumnExists($db, 'club_memberships', 'left_at', "DATETIME NULL");
    ensureColumnExists($db, 'club_memberships', 'join_method', "VARCHAR(50) DEFAULT 'school_no_code'");
    ensureColumnExists($db, 'club_memberships', 'contact_account', "VARCHAR(255) DEFAULT ''");
    ensureColumnExists($db, 'club_memberships', 'external_club_name', "VARCHAR(255) DEFAULT ''");
    ensureColumnExists($db, 'club_memberships', 'external_club_role', "VARCHAR(255) DEFAULT ''");
    ensureColumnExists($db, 'club_memberships', 'apply_reason', "TEXT");
    ensureColumnExists($db, 'club_memberships', 'application_email_enabled', "TINYINT(1) NOT NULL DEFAULT 1");
    ensureColumnExists($db, 'users', 'membership_application_email_enabled', "TINYINT(1) NOT NULL DEFAULT 1");
}

switch ($action) {
    case 'my':
        // 获取当前用户的所有绑定
        $user = getCurrentUser();
        if (!$user) {
            echo json_encode(['success' => true, 'memberships' => []]);
            exit();
        }
        $db = getDB();
        // 兼容 country 列尚未创建的情况
        try {
            $stmt = $db->prepare(
                "SELECT id, club_id, country, role, status, joined_at
                 FROM club_memberships WHERE user_id = ? ORDER BY joined_at DESC"
            );
            $stmt->execute([$user['id']]);
        } catch (Exception $e) {
            $stmt = $db->prepare(
                "SELECT id, club_id, role, status, joined_at
                 FROM club_memberships WHERE user_id = ? ORDER BY joined_at DESC"
            );
            $stmt->execute([$user['id']]);
        }
        echo json_encode(['success' => true, 'memberships' => $stmt->fetchAll()]);
        exit();

    case 'apply':
        // 申请绑定同好会
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input)) {
            echo json_encode(['success' => false, 'message' => '请求数据格式错误']);
            exit();
        }
        $clubId = (int)($input['club_id'] ?? 0);
        $country = $input['country'] ?? 'china';
        $joinMethod = $input['join_method'] ?? 'school_no_code';
        $qqAccount = trim((string)($input['qq_account'] ?? $input['contact_account'] ?? ''));
        $contactAccount = trim((string)($input['contact_account'] ?? $qqAccount));
        $externalClubName = trim((string)($input['external_club_name'] ?? ''));
        $externalClubRole = trim((string)($input['external_club_role'] ?? ''));
        $applyReason = trim((string)($input['apply_reason'] ?? ''));
        $applyRole = $input['apply_role'] ?? 'member';
        $isStudent = 1;

        // 验证申请身份
        $validMethods = ['school_no_code', 'external_exchange'];
        if (!in_array($joinMethod, $validMethods, true)) $joinMethod = 'school_no_code';
        $validRoles = ['member', 'manager', 'representative'];
        if ($joinMethod === 'external_exchange') {
            $applyRole = 'external';
            if ($externalClubName === '' || $externalClubRole === '' || $applyReason === '') {
                echo json_encode(['success' => false, 'message' => '请填写所属同好会、身份和申请理由']);
                exit();
            }
        }
        if (!in_array($applyRole, $validRoles)) $applyRole = 'member';
        if ($joinMethod === 'external_exchange') $applyRole = 'external';

        if (!$clubId) {
            echo json_encode(['success' => false, 'message' => '无效的同好会 ID']);
            exit();
        }

        $db = getDB();

        ensureMembershipApplicationColumns($db);

        // 升级唯一约束为包含 country
        ensureUniqueConstraintIncludesCountry($db);

        // 检查是否已经申请过（按 user_id + club_id + country）
        $stmt = $db->prepare(
            "SELECT id, status FROM club_memberships WHERE user_id = ? AND club_id = ? AND country = ?"
        );
        $stmt->execute([$user['id'], $clubId, $country]);
        $existing = $stmt->fetch();

        if ($existing) {
            if ($existing['status'] === 'active') {
                echo json_encode(['success' => false, 'message' => '你已绑定该同好会']);
                exit();
            } elseif ($existing['status'] === 'pending') {
                echo json_encode(['success' => false, 'message' => '绑定申请已提交，请等待审核']);
                exit();
            } else {
                $db->beginTransaction();
                try {
                    $stmt = $db->prepare(
                        "UPDATE club_memberships
                         SET role = ?, status = 'pending', qq_account = ?, contact_account = ?, apply_role = ?, is_student = ?,
                             country = ?, join_method = ?, external_club_name = ?, external_club_role = ?,
                             apply_reason = ?, joined_at = CURRENT_TIMESTAMP, left_at = NULL
                         WHERE id = ?"
                    );
                    $stmt->execute([
                        $applyRole, $qqAccount, $contactAccount, $applyRole, $isStudent, $country,
                        $joinMethod, $externalClubName, $externalClubRole, $applyReason, $existing['id']
                    ]);
                    displayClubClearSelection($db, (int)$existing['id']);

                    logAction('membership.reapply', 'club_membership', $existing['id'], [
                        'club_id' => $clubId,
                        'country' => $country,
                        'previous_status' => $existing['status'],
                        'apply_role' => $applyRole,
                        'join_method' => $joinMethod,
                    ]);

                    $db->commit();
                } catch (Exception $e) {
                    $db->rollBack();
                    echo json_encode(['success' => false, 'message' => '操作失败：' . $e->getMessage()]);
                    exit();
                }

                notifyMembershipApplicationApprovers(
                    $db, $user, $clubId, $country, $applyRole, $joinMethod, (int)$existing['id']
                );

                echo json_encode([
                    'success' => true,
                    'message' => '绑定申请已重新提交，等待管理员审核',
                    'membership' => [
                        'id' => (int)$existing['id'],
                        'status' => 'pending'
                    ]
                ]);
                exit();
            }
        }

        // 创建申请（事务保证原子性）
        $db->beginTransaction();
        try {
            $stmt = $db->prepare(
                "INSERT INTO club_memberships
                    (user_id, club_id, role, status, qq_account, contact_account, apply_role, is_student, country, join_method, external_club_name, external_club_role, apply_reason)
                 VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            );
            $stmt->execute([
                $user['id'], $clubId, $applyRole, $qqAccount, $contactAccount, $applyRole,
                $isStudent, $country, $joinMethod, $externalClubName, $externalClubRole, $applyReason
            ]);
            $membershipId = $db->lastInsertId();

            logAction('membership.apply', 'club_membership', $membershipId, [
                'club_id' => $clubId, 'country' => $country, 'apply_role' => $applyRole, 'join_method' => $joinMethod
            ]);

            $db->commit();
        } catch (Exception $e) {
            $db->rollBack();
            echo json_encode(['success' => false, 'message' => '操作失败：' . $e->getMessage()]);
            exit();
        }

        notifyMembershipApplicationApprovers(
            $db, $user, $clubId, $country, $applyRole, $joinMethod, (int)$membershipId
        );

        echo json_encode([
            'success' => true,
            'message' => '绑定申请已提交，等待管理员审核',
            'membership' => [
                'id' => (int)$membershipId,
                'status' => 'pending'
            ]
        ]);
        exit();

    case 'set_application_email_recipient':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        $currentUser = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $membershipId = (int)($input['membership_id'] ?? 0);
        $enabled = filter_var($input['enabled'] ?? null, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
        if ($membershipId <= 0 || $enabled === null) {
            echo json_encode(['success' => false, 'message' => '邮件提醒设置无效']);
            exit();
        }

        $db = getDB();
        ensureMembershipApplicationColumns($db);
        $stmt = $db->prepare(
            "SELECT id, user_id, club_id, country, role, status
             FROM club_memberships
             WHERE id = ?"
        );
        $stmt->execute([$membershipId]);
        $targetMembership = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$targetMembership
            || $targetMembership['status'] !== 'active'
            || !in_array($targetMembership['role'], ['representative', 'manager'], true)) {
            http_response_code(404);
            echo json_encode(['success' => false, 'message' => '未找到可配置邮件提醒的负责人或管理员']);
            exit();
        }

        if (($currentUser['role'] ?? '') !== 'super_admin') {
            $stmt = $db->prepare(
                "SELECT role FROM club_memberships
                 WHERE user_id = ? AND club_id = ? AND country = ? AND status = 'active'
                 LIMIT 1"
            );
            $stmt->execute([$currentUser['id'], $targetMembership['club_id'], $targetMembership['country']]);
            if ($stmt->fetchColumn() !== 'representative') {
                http_response_code(403);
                echo json_encode(['success' => false, 'message' => '只有本同好会负责人可以配置申请邮件收件人']);
                exit();
            }
        }

        try {
            $stmt = $db->prepare(
                "UPDATE club_memberships
                 SET application_email_enabled = ?
                 WHERE id = ? AND status = 'active' AND role IN ('representative', 'manager')"
            );
            $stmt->execute([$enabled ? 1 : 0, $membershipId]);
            logAction('membership.update_application_email_recipient', 'club_membership', $membershipId, [
                'club_id' => (int)$targetMembership['club_id'],
                'country' => $targetMembership['country'],
                'recipient_user_id' => (int)$targetMembership['user_id'],
                'enabled' => $enabled,
            ]);
        } catch (Throwable $e) {
            error_log('Unable to update membership application email recipient: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => '邮件提醒设置保存失败']);
            exit();
        }

        echo json_encode([
            'success' => true,
            'message' => $enabled ? '已开启本会申请邮件提醒' : '已关闭本会申请邮件提醒',
            'membership_id' => $membershipId,
            'enabled' => $enabled,
        ]);
        exit();

    case 'members':
        // 获取指定俱乐部的成员名单
        $clubId = (int)($_GET['club_id'] ?? 0);
        if (!$clubId) {
            echo json_encode(['success' => false, 'message' => '无效的俱乐部 ID']);
            exit();
        }

        // 权限：管理员/负责人可查看（按 club_id + country）
        $currentUser = requireLogin();
        $country = $_GET['country'] ?? 'china';
        if (!canManageClubInCountry($currentUser, $clubId, $country)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '权限不足']);
            exit();
        }

        $db = getDB();
        ensureMembershipApplicationColumns($db);

        // 兼容 country 列尚未创建的情况
        try {
            $stmt = $db->prepare(
                "SELECT cm.id, cm.user_id, cm.role, cm.status, cm.joined_at, cm.application_email_enabled,
                        cm.qq_account, cm.contact_account, cm.apply_role, cm.is_student,
                        cm.join_method, cm.external_club_name, cm.external_club_role, cm.apply_reason,
                        u.username, u.nickname, u.email, u.avatar_url
                 FROM club_memberships cm
                 JOIN users u ON u.id = cm.user_id
                 WHERE cm.club_id = ? AND cm.country = ? AND cm.status = 'active'
                 ORDER BY cm.joined_at ASC"
            );
            $stmt->execute([$clubId, $country]);
        } catch (Exception $e) {
            try {
                $stmt = $db->prepare(
                    "SELECT cm.id, cm.user_id, cm.role, cm.status, cm.joined_at,
                            cm.qq_account, cm.apply_role, cm.is_student,
                            u.username, u.nickname, u.email, u.avatar_url
                     FROM club_memberships cm
                     JOIN users u ON u.id = cm.user_id
                     WHERE cm.club_id = ? AND cm.status = 'active'
                     ORDER BY cm.joined_at ASC"
                );
                $stmt->execute([$clubId]);
            } catch (Exception $e2) {
                $stmt = $db->prepare(
                    "SELECT cm.id, cm.user_id, cm.role, cm.status, cm.joined_at,
                            u.username, u.avatar_url
                     FROM club_memberships cm
                     JOIN users u ON u.id = cm.user_id
                     WHERE cm.club_id = ? AND cm.status = 'active'
                     ORDER BY cm.joined_at ASC"
                );
                $stmt->execute([$clubId]);
            }
        }
        $members = $stmt->fetchAll();

        // 转换 int 类型
        foreach ($members as &$m) {
            $m['id'] = (int)$m['id'];
            $m['user_id'] = (int)$m['user_id'];
            $m['is_student'] = isset($m['is_student']) ? (int)$m['is_student'] : 0;
            $m['application_email_enabled'] = isset($m['application_email_enabled']) ? (int)$m['application_email_enabled'] : 1;
            if ($currentUser['role'] !== 'super_admin') {
                unset($m['qq_account'], $m['contact_account'], $m['apply_role'], $m['is_student'], $m['email'], $m['apply_reason']);
            }
        }

        echo json_encode(['success' => true, 'members' => $members]);
        exit();

    case 'club_member_counts':
        // 各同好会活跃成员数（供后台同好会总览展示成员数）
        $currentUser = requireLogin();
        $roleOk = in_array($currentUser['role'] ?? '', ['super_admin', 'representative', 'manager'], true)
            || hasAuditPermission($currentUser);
        if (!$roleOk) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '权限不足']);
            exit();
        }

        $db = getDB();
        try {
            $stmt = $db->query(
                "SELECT club_id, COALESCE(country, 'china') AS country, COUNT(*) AS cnt
                 FROM club_memberships
                 WHERE status = 'active'
                 GROUP BY club_id, country"
            );
            $counts = [];
            foreach ($stmt->fetchAll() as $row) {
                $counts[$row['club_id'] . ':' . $row['country']] = (int)$row['cnt'];
            }
            echo json_encode(['success' => true, 'counts' => $counts]);
        } catch (Exception $e) {
            echo json_encode(['success' => false, 'message' => '查询失败', 'error' => $e->getMessage()]);
        }
        exit();

    case 'pending':
        // 获取待审批列表
        $currentUser = requireLogin();
        $db = getDB();

        // 确保扩展列存在（兼容旧表结构）
        ensureMembershipApplicationColumns($db);

        // 支持按状态筛选（默认 pending，传 all 返回全部）
        $statusFilter = $_GET['status'] ?? 'pending';
        $statusCondition = $statusFilter === 'all' ? '' : "AND cm.status = 'pending'";

        if ($currentUser['role'] === 'super_admin') {
            // 超级管理员：查看所有
            $stmt = $db->query(
                "SELECT cm.id, cm.user_id, cm.club_id, cm.country, cm.status, cm.joined_at,
                        cm.apply_role, cm.qq_account, cm.contact_account, cm.is_student,
                        cm.join_method, cm.external_club_name, cm.external_club_role, cm.apply_reason, u.username
                 FROM club_memberships cm
                 JOIN users u ON u.id = cm.user_id
                 WHERE 1=1 $statusCondition
                 ORDER BY cm.joined_at ASC"
            );
        } else {
            // 负责人/管理员：只查看自己俱乐部的待审批（按 club_id + country 匹配）
            $stmt = $db->prepare(
                "SELECT cm.id, cm.user_id, cm.club_id, cm.country, cm.status, cm.joined_at,
                        cm.apply_role, cm.qq_account, cm.contact_account, cm.is_student,
                        cm.join_method, cm.external_club_name, cm.external_club_role, cm.apply_reason, u.username
                 FROM club_memberships cm
                 JOIN users u ON u.id = cm.user_id
                 WHERE 1=1 $statusCondition
                   AND EXISTS (
                       SELECT 1 FROM club_memberships mgr
                       WHERE mgr.user_id = ?
                         AND mgr.role IN ('representative', 'manager')
                         AND mgr.status = 'active'
                         AND mgr.club_id = cm.club_id
                         AND mgr.country = cm.country
                   )
                 ORDER BY cm.joined_at ASC"
            );
            $stmt->execute([$currentUser['id']]);
        }

        $memberships = $stmt->fetchAll();
        foreach ($memberships as &$m) {
            $m['id'] = (int)$m['id'];
            $m['user_id'] = (int)$m['user_id'];
            $m['club_id'] = (int)$m['club_id'];
        }

        echo json_encode(['success' => true, 'memberships' => $memberships]);
        exit();

    case 'approve':
        // 批准绑定
        $currentUser = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $membershipId = (int)($input['membership_id'] ?? 0);

        if (!$membershipId) {
            echo json_encode(['success' => false, 'message' => '无效的成员 ID']);
            exit();
        }

        $db = getDB();

        // 获取申请信息用于权限检查
        $stmt = $db->prepare("SELECT cm.*, cm.club_id FROM club_memberships cm WHERE cm.id = ?");
        $stmt->execute([$membershipId]);
        $membership = $stmt->fetch();

        if (!$membership || $membership['status'] !== 'pending') {
            echo json_encode(['success' => false, 'message' => '未找到待审批的申请']);
            exit();
        }
        $clubName = getClubName($membership['club_id'], $membership['country'] ?? 'china');

        // 权限检查（按 club_id + country，避免中日 ID 重叠）
        if (!canManageClubInCountry($currentUser, $membership['club_id'], $membership['country'] ?? 'china')) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '权限不足']);
            exit();
        }

        $db->beginTransaction();
        try {
            $stmt = $db->prepare(
                "UPDATE club_memberships SET status = 'active', left_at = NULL WHERE id = ? AND status = 'pending'"
            );
            $stmt->execute([$membershipId]);

            if ($stmt->rowCount() === 0) {
                $db->rollBack();
                echo json_encode(['success' => false, 'message' => '未找到待审批的申请']);
                exit();
            }

            logAction('membership.approve', 'club_membership', $membershipId, [
                'club_id' => $membership['club_id'],
            ]);
            $db->commit();

            // 发送通知
            createNotification(
                $membership['user_id'],
                'join_approved',
                '加入申请已通过',
                '你在同好会「' . $clubName . '」的加入申请已通过审核',
                'index.html',
                'club_membership',
                $membershipId
            );
        } catch (Exception $e) {
            $db->rollBack();
            echo json_encode(['success' => false, 'message' => '操作失败：' . $e->getMessage()]);
            exit();
        }
        echo json_encode(['success' => true, 'message' => '已批准绑定']);
        exit();

    case 'reject':
        // 拒绝绑定
        $currentUser = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $membershipId = (int)($input['membership_id'] ?? 0);

        if (!$membershipId) {
            echo json_encode(['success' => false, 'message' => '无效的成员 ID']);
            exit();
        }

        $db = getDB();

        // 获取申请信息用于权限检查
        $stmt = $db->prepare("SELECT cm.*, cm.club_id FROM club_memberships cm WHERE cm.id = ?");
        $stmt->execute([$membershipId]);
        $membership = $stmt->fetch();

        if (!$membership || $membership['status'] !== 'pending') {
            echo json_encode(['success' => false, 'message' => '未找到待审批的申请']);
            exit();
        }
        $clubName = getClubName($membership['club_id'], $membership['country'] ?? 'china');

        // 权限检查（按 club_id + country）
        if (!canManageClubInCountry($currentUser, $membership['club_id'], $membership['country'] ?? 'china')) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '权限不足']);
            exit();
        }

        $db->beginTransaction();
        try {
            $stmt = $db->prepare(
                "UPDATE club_memberships SET status = 'rejected' WHERE id = ? AND status = 'pending'"
            );
            $stmt->execute([$membershipId]);

            if ($stmt->rowCount() === 0) {
                $db->rollBack();
                echo json_encode(['success' => false, 'message' => '未找到待审批的申请']);
                exit();
            }

            logAction('membership.reject', 'club_membership', $membershipId, [
                'club_id' => $membership['club_id'],
            ]);
            $db->commit();

            // 发送通知
            createNotification(
                $membership['user_id'],
                'join_rejected',
                '加入申请未通过',
                '你在同好会「' . $clubName . '」的加入申请未通过审核',
                'index.html',
                'club_membership',
                $membershipId
            );
        } catch (Exception $e) {
            $db->rollBack();
            echo json_encode(['success' => false, 'message' => '操作失败：' . $e->getMessage()]);
            exit();
        }
        echo json_encode(['success' => true, 'message' => '已拒绝绑定']);
        exit();

    case 'leave':
        // 用户自行退出同好会
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        $currentUser = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $membershipId = (int)($input['membership_id'] ?? 0);
        $clubId = (int)($input['club_id'] ?? 0);
        $country = $input['country'] ?? 'china';

        $db = getDB();

        // 支持通过 club_id 查找 membership（按 club_id + country）
        if (!$membershipId && $clubId > 0) {
            $stmt = $db->prepare("SELECT id FROM club_memberships WHERE user_id = ? AND club_id = ? AND country = ? AND status = 'active'");
            $stmt->execute([$currentUser['id'], $clubId, $country]);
            $row = $stmt->fetch();
            if ($row) {
                $membershipId = (int)$row['id'];
            }
        }

        if (!$membershipId) {
            echo json_encode(['success' => false, 'message' => '无效的成员 ID']);
            exit();
        }

        // 获取申请信息
        $stmt = $db->prepare("SELECT * FROM club_memberships WHERE id = ?");
        $stmt->execute([$membershipId]);
        $membership = $stmt->fetch();

        if (!$membership) {
            echo json_encode(['success' => false, 'message' => '未找到绑定记录']);
            exit();
        }

        // 只能退出自己的绑定
        if ((int)$membership['user_id'] !== (int)$currentUser['id']) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '只能退出自己的同好会绑定']);
            exit();
        }

        // 只能退出 active 状态的绑定
        if ($membership['status'] !== 'active') {
            echo json_encode(['success' => false, 'message' => '该绑定记录已经处于非活跃状态']);
            exit();
        }

        $db->beginTransaction();
        try {
            $db->prepare(
                "UPDATE club_memberships SET status = 'left', left_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'"
            )->execute([$membershipId]);
            displayClubClearSelection($db, $membershipId);
            logAction('membership.leave', 'club_membership', $membershipId, [
                'club_id' => $membership['club_id'],
                'country' => $membership['country'] ?? 'china',
            ]);
            $db->commit();
        } catch (Throwable $e) {
            if ($db->inTransaction()) $db->rollBack();
            error_log('Unable to leave club: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => '退出同好会失败']);
            exit();
        }
        echo json_encode(['success' => true, 'message' => '已退出同好会']);
        exit();

    case 'kick':
        // 踢出成员（负责人/管理员操作）
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        $currentUser = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $membershipId = (int)($input['membership_id'] ?? 0);

        if (!$membershipId) {
            echo json_encode(['success' => false, 'message' => '无效的成员 ID']);
            exit();
        }

        $db = getDB();

        // 获取目标成员记录
        $stmt = $db->prepare("SELECT cm.*, cm.club_id FROM club_memberships cm WHERE cm.id = ?");
        $stmt->execute([$membershipId]);
        $membership = $stmt->fetch();

        if (!$membership || $membership['status'] !== 'active') {
            echo json_encode(['success' => false, 'message' => '未找到活跃的成员记录']);
            exit();
        }
        $clubName = getClubName($membership['club_id'], $membership['country'] ?? 'china');

        // 权限检查：是否可管理该俱乐部（按 club_id + country）
        if (!canManageClubInCountry($currentUser, $membership['club_id'], $membership['country'] ?? 'china')) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '权限不足']);
            exit();
        }

        // 不能踢自己
        if ((int)$membership['user_id'] === (int)$currentUser['id']) {
            echo json_encode(['success' => false, 'message' => '不能踢出自己']);
            exit();
        }

        // 非 super_admin 需要按角色限制可踢的目标
        if ($currentUser['role'] !== 'super_admin') {
            $stmt = $db->prepare("SELECT role FROM club_memberships WHERE user_id = ? AND club_id = ? AND country = ? AND status = 'active'");
            $stmt->execute([$currentUser['id'], $membership['club_id'], $membership['country'] ?? 'china']);
            $myRole = $stmt->fetchColumn();

            if ($myRole === 'manager' && !in_array($membership['role'], ['member', 'external'], true)) {
                echo json_encode(['success' => false, 'message' => '管理员只能踢出普通成员']);
                exit();
            }
            if ($myRole === 'representative' && !in_array($membership['role'], ['external', 'member', 'manager'], true)) {
                echo json_encode(['success' => false, 'message' => '无法踢出该角色的成员']);
                exit();
            }
        }

        $db->beginTransaction();
        try {
            $db->prepare("UPDATE club_memberships SET status = 'kicked', left_at = CURRENT_TIMESTAMP WHERE id = ?")
                ->execute([$membershipId]);
            displayClubClearSelection($db, $membershipId);
            logAction('membership.kick', 'club_membership', $membershipId, [
                'club_id' => $membership['club_id'],
                'country' => $membership['country'] ?? 'china',
                'target_user_id' => $membership['user_id'],
            ]);
            $db->commit();
        } catch (Throwable $e) {
            if ($db->inTransaction()) $db->rollBack();
            error_log('Unable to kick club member: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => '移出成员失败']);
            exit();
        }

        // 发送通知
        createNotification(
            $membership['user_id'],
            'member_kicked',
            '你已被移出同好会',
            '你已被移出同好会「' . $clubName . '」',
            'index.html',
            'club_membership',
            $membershipId
        );

        echo json_encode(['success' => true, 'message' => '已踢出成员']);
        exit();

    case 'change_role':
        // 修改成员角色（负责人操作）
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        $currentUser = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $membershipId = (int)($input['membership_id'] ?? 0);
        $newRole = $input['role'] ?? '';

        if (!$membershipId) {
            echo json_encode(['success' => false, 'message' => '无效的成员 ID']);
            exit();
        }

        $validRoles = ['member', 'manager', 'representative'];
        if (!in_array($newRole, $validRoles)) {
            echo json_encode(['success' => false, 'message' => '无效的角色']);
            exit();
        }

        $db = getDB();

        // 获取目标成员记录
        $stmt = $db->prepare("SELECT cm.*, cm.club_id FROM club_memberships cm WHERE cm.id = ?");
        $stmt->execute([$membershipId]);
        $membership = $stmt->fetch();

        if (!$membership || $membership['status'] !== 'active') {
            echo json_encode(['success' => false, 'message' => '未找到活跃的成员记录']);
            exit();
        }
        $clubName = getClubName($membership['club_id'], $membership['country'] ?? 'china');

        // 权限检查：是否可管理该俱乐部（按 club_id + country）
        if (!canManageClubInCountry($currentUser, $membership['club_id'], $membership['country'] ?? 'china')) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '权限不足']);
            exit();
        }

        // 非 super_admin 权限限制
        if ($currentUser['role'] !== 'super_admin') {
            // 获取当前用户在俱乐部中的角色（按 club_id + country）
            $stmt = $db->prepare("SELECT role FROM club_memberships WHERE user_id = ? AND club_id = ? AND country = ? AND status = 'active'");
            $stmt->execute([$currentUser['id'], $membership['club_id'], $membership['country'] ?? 'china']);
            $myRole = $stmt->fetchColumn();

            // 只有负责人可以修改角色
            if ($myRole !== 'representative') {
                echo json_encode(['success' => false, 'message' => '只有负责人可以修改成员角色']);
                exit();
            }

            // 不能设为负责人
            if ($newRole === 'representative') {
                echo json_encode(['success' => false, 'message' => '无权设置为负责人角色']);
                exit();
            }

            // 不能修改负责人的角色
            if ($membership['role'] === 'representative') {
                echo json_encode(['success' => false, 'message' => '无法修改负责人的角色']);
                exit();
            }
        }

        $oldRole = $membership['role'];
        $db->beginTransaction();
        try {
            $db->prepare("UPDATE club_memberships SET role = ? WHERE id = ?")
                ->execute([$newRole, $membershipId]);
            if (!in_array($newRole, DISPLAY_CLUB_ROLES, true)) {
                displayClubClearSelection($db, $membershipId);
            }
            logAction('membership.change_role', 'club_membership', $membershipId, [
                'club_id' => $membership['club_id'],
                'country' => $membership['country'] ?? 'china',
                'old_role' => $oldRole,
                'new_role' => $newRole,
            ]);
            $db->commit();
        } catch (Throwable $e) {
            if ($db->inTransaction()) $db->rollBack();
            error_log('Unable to change club member role: ' . $e->getMessage());
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => '角色更新失败']);
            exit();
        }

        // 发送通知
        $roleNames = ['member' => '成员', 'manager' => '管理员', 'representative' => '负责人'];
        $newRoleName = $roleNames[$newRole] ?? $newRole;
        createNotification(
            $membership['user_id'],
            'role_changed',
            '你的角色已变更',
            '你在同好会「' . $clubName . '」的角色已变更为「' . $newRoleName . '」',
            'index.html',
            'club_membership',
            $membershipId
        );

        echo json_encode(['success' => true, 'message' => '角色已更新']);
        exit();

    case 'transfer':
        // 转让负责人身份
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        $currentUser = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $targetMembershipId = (int)($input['membership_id'] ?? 0);
        $clubId = (int)($input['club_id'] ?? 0);
        $country = $input['country'] ?? 'china';

        if (!$targetMembershipId || !$clubId) {
            echo json_encode(['success' => false, 'message' => '参数不完整']);
            exit();
        }

        $db = getDB();

        // 验证当前用户是俱乐部的负责人（按 club_id + country）
        $stmt = $db->prepare("SELECT role FROM club_memberships WHERE user_id = ? AND club_id = ? AND country = ? AND status = 'active'");
        $stmt->execute([$currentUser['id'], $clubId, $country]);
        $myRole = $stmt->fetchColumn();
        if ($myRole !== 'representative') {
            echo json_encode(['success' => false, 'message' => '只有负责人可以转让身份']);
            exit();
        }

        // 获取目标成员记录
        $stmt = $db->prepare("SELECT * FROM club_memberships WHERE id = ? AND club_id = ? AND country = ? AND status = 'active'");
        $stmt->execute([$targetMembershipId, $clubId, $country]);
        $target = $stmt->fetch();

        if (!$target) {
            echo json_encode(['success' => false, 'message' => '未找到目标成员']);
            exit();
        }
        if ((int)$target['user_id'] === (int)$currentUser['id']) {
            echo json_encode(['success' => false, 'message' => '不能转让给自己']);
            exit();
        }
        if ($target['role'] === 'representative') {
            echo json_encode(['success' => false, 'message' => '目标已经是负责人']);
            exit();
        }

        // 事务：交换角色
        $db->beginTransaction();
        try {
            // 当前负责人降级为管理员
            $stmt = $db->prepare("UPDATE club_memberships SET role = 'manager' WHERE user_id = ? AND club_id = ? AND country = ? AND status = 'active'");
            $stmt->execute([$currentUser['id'], $clubId, $country]);

            // 目标升为负责人
            $stmt = $db->prepare("UPDATE club_memberships SET role = 'representative' WHERE id = ? AND club_id = ? AND status = 'active'");
            $stmt->execute([$targetMembershipId, $clubId]);

            logAction('membership.transfer', 'club_membership', $targetMembershipId, [
                'club_id' => $clubId,
                'from_user_id' => $currentUser['id'],
                'to_user_id' => $target['user_id'],
            ]);
            $db->commit();
        } catch (Exception $e) {
            $db->rollBack();
            echo json_encode(['success' => false, 'message' => '操作失败：' . $e->getMessage()]);
            exit();
        }

        echo json_encode(['success' => true, 'message' => '负责人已转让']);
        exit();

    case 'grant_from_submission':
        // 同好会信息提交审核通过后，由超级管理员自动为该提交用户绑定同好会身份
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }

        $admin = requireAdmin();
        if (($admin['role'] ?? '') !== 'super_admin') {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '仅超级管理员可执行此操作']);
            exit();
        }

        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input)) {
            echo json_encode(['success' => false, 'message' => '请求数据格式错误']);
            exit();
        }

        $userId = (int)($input['user_id'] ?? 0);
        $clubId = (int)($input['club_id'] ?? 0);
        $country = (string)($input['country'] ?? 'china');
        $role = (string)($input['role'] ?? ($input['apply_role'] ?? 'external'));
        $roleMap = [
            'other' => 'external',
            'external' => 'external',
            'member' => 'member',
            'manager' => 'manager',
            'representative' => 'representative',
        ];
        $role = $roleMap[$role] ?? 'external';
        if (!in_array($country, ['china', 'japan', 'overseas'], true)) $country = 'china';

        if ($userId <= 0 || $clubId <= 0) {
            echo json_encode(['success' => false, 'message' => '缺少有效的用户 ID 或同好会 ID']);
            exit();
        }

        $db = getDB();
        ensureMembershipApplicationColumns($db);
        ensureUniqueConstraintIncludesCountry($db);

        $stmt = $db->prepare("SELECT id FROM users WHERE id = ? AND status = 'active'");
        $stmt->execute([$userId]);
        if (!$stmt->fetch()) {
            http_response_code(404);
            echo json_encode(['success' => false, 'message' => '提交用户不存在或已停用']);
            exit();
        }

        $contact = trim((string)($input['contact_account'] ?? $input['qq_account'] ?? ''));

        $stmt = $db->prepare(
            "SELECT id, status FROM club_memberships WHERE user_id = ? AND club_id = ? AND country = ?"
        );
        $stmt->execute([$userId, $clubId, $country]);
        $existing = $stmt->fetch();

        $clubName = getClubName($clubId, $country);
        $membershipId = $existing ? (int)$existing['id'] : 0;

        $db->beginTransaction();
        try {
            if ($existing && $existing['status'] === 'active') {
                // 已经是该同好会成员，保持现有身份，不降级
                $grantMode = 'already_active';
            } elseif ($existing) {
                $db->prepare(
                    "UPDATE club_memberships
                     SET role = ?, status = 'active', apply_role = ?, join_method = 'club_submit',
                         qq_account = ?, contact_account = ?, left_at = NULL, joined_at = CURRENT_TIMESTAMP
                     WHERE id = ?"
                )->execute([$role, $role, $contact, $contact, $membershipId]);
                displayClubClearSelection($db, $membershipId);
                $grantMode = 'reactivated';
            } else {
                $stmt = $db->prepare(
                    "INSERT INTO club_memberships
                        (user_id, club_id, role, status, qq_account, contact_account, apply_role, is_student,
                         country, join_method, external_club_name, external_club_role, apply_reason)
                     VALUES (?, ?, ?, 'active', ?, ?, ?, 0, ?, 'club_submit', '', '', ?)"
                );
                $stmt->execute([
                    $userId, $clubId, $role, $contact, $contact, $role, $country,
                    '同好会信息提交通过后自动绑定'
                ]);
                $membershipId = (int)$db->lastInsertId();
                $grantMode = 'created';
            }

            logAction('membership.grant_from_submission', 'club_membership', $membershipId, [
                'club_id' => $clubId,
                'country' => $country,
                'target_user_id' => $userId,
                'role' => $role,
                'grant_mode' => $grantMode,
                'by_user_id' => (int)$admin['id'],
            ]);
            $db->commit();
        } catch (Exception $e) {
            $db->rollBack();
            echo json_encode(['success' => false, 'message' => '自动绑定身份失败：' . $e->getMessage()]);
            exit();
        }

        $roleNames = ['external' => '其他', 'member' => '成员', 'manager' => '管理员', 'representative' => '负责人'];
        $roleLabel = $roleNames[$role] ?? $role;
        createNotification(
            $userId,
            'join_approved',
            '同好会信息已通过',
            '你在同好会「' . $clubName . '」的信息提交已通过，已自动绑定为「' . $roleLabel . '」',
            'index.html',
            'club_membership',
            $membershipId
        );

        echo json_encode([
            'success' => true,
            'message' => '已自动绑定同好会身份',
            'membership_id' => $membershipId,
            'grant_mode' => $grantMode,
        ]);
        exit();

    default:
        echo json_encode(['success' => false, 'message' => '未知动作', 'available_actions' => [
            'my', 'apply', 'approve', 'reject', 'pending', 'members', 'set_application_email_recipient',
            'leave', 'kick', 'change_role', 'transfer', 'grant_from_submission'
        ]]);
        exit();
}

// ====== 辅助函数 ======

/**
 * 检查用户是否有权限管理指定国家的俱乐部（解决中日 ID 重叠问题）
 */
if (!function_exists('canManageClubInCountry')) {
function canManageClubInCountry(array $user, int $clubId, string $country): bool {
    if ($user['role'] === 'super_admin') return true;
    $db = getDB();
    try {
        $stmt = $db->prepare(
            "SELECT id FROM club_memberships WHERE user_id = ? AND club_id = ? AND country = ? AND role IN ('representative', 'manager') AND status = 'active'"
        );
        $stmt->execute([$user['id'], $clubId, $country]);
        return (bool)$stmt->fetch();
    } catch (Exception $e) {
        // country 列不存在时回退到不区分国家的检查
        return canManageClub($user, $clubId);
    }
}
}

/**
 * 将 club_memberships 的唯一约束升级为包含 country
 * 旧: UNIQUE(user_id, club_id) → 新: UNIQUE(user_id, club_id, country)
 */
function ensureUniqueConstraintIncludesCountry(PDO $db): void {
    try {
        // 尝试直接创建新索引——如果已存在则忽略错误
        $db->exec("ALTER TABLE club_memberships ADD UNIQUE INDEX `uk_user_club_country` (`user_id`, `club_id`, `country`)");
        // 创建成功 => 旧索引 'user_id' 还在，需要删除
        try { $db->exec("ALTER TABLE club_memberships DROP INDEX `user_id`"); } catch (Exception $e2) {}
        try { $db->exec("ALTER TABLE club_memberships DROP INDEX `uk_user_club`"); } catch (Exception $e2) {}
    } catch (Exception $e) {
        // uk_user_club_country 已存在 => 是最新格式，不需要改动
    }
}

/**
 * 检查列是否存在，不存在则添加（兼容 MySQL 和 SQLite）
 */
function ensureColumnExists(PDO $db, string $table, string $column, string $definition): void {
    try {
        // SQLite
        $stmt = $db->query("PRAGMA table_info($table)");
        $cols = $stmt->fetchAll(PDO::FETCH_COLUMN, 1);
        if (in_array($column, $cols)) return;
    } catch (Exception $e) {
        // MySQL
        try {
            $stmt = $db->query("SHOW COLUMNS FROM `$table` LIKE '$column'");
            if ($stmt->fetch()) return;
        } catch (Exception $e2) {}
    }
    try {
        $db->exec("ALTER TABLE `$table` ADD COLUMN `$column` $definition");
    } catch (Exception $e) {}
}

