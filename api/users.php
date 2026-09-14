<?php
// api/users.php - 用户管理 API（仅超级管理员可用）
// 动作: list, get, update, delete

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/audit.php';

// 仅超级管理员可访问
$currentUser = requireLogin();
if ($currentUser['role'] !== 'super_admin') {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => '权限不足']);
    exit();
}

$action = $_GET['action'] ?? '';

switch ($action) {

    case 'stats':
        try {
            $db = getDB();
            $stats = [
                'total'         => (int)$db->query("SELECT COUNT(*) FROM users")->fetchColumn(),
                'super_admins'  => (int)$db->query("SELECT COUNT(*) FROM users WHERE role = 'super_admin'")->fetchColumn(),
                'managers'      => (int)$db->query("SELECT COUNT(*) FROM users WHERE role IN ('representative','manager')")->fetchColumn(),
                'members'       => (int)$db->query("SELECT COUNT(*) FROM users WHERE role = 'member'")->fetchColumn(),
                'visitors'      => (int)$db->query("SELECT COUNT(*) FROM users WHERE role = 'visitor'")->fetchColumn(),
                'banned'        => (int)$db->query("SELECT COUNT(*) FROM users WHERE status = 'banned'")->fetchColumn(),
            ];
            echo json_encode(['success' => true, 'stats' => $stats], JSON_UNESCAPED_UNICODE);
        } catch (Exception $e) {
            echo json_encode(['success' => false, 'message' => '查询失败', 'error' => $e->getMessage()]);
        }
        exit();

    case 'list':
        try {
        // 分页列出用户
        $page = max(1, (int)($_GET['page'] ?? 1));
        $perPage = min(100, max(1, (int)($_GET['per_page'] ?? 20)));
        $search = trim($_GET['search'] ?? '');
        $roleFilter = $_GET['role'] ?? '';
        $statusFilter = $_GET['status'] ?? '';
        $offset = ($page - 1) * $perPage;

        $db = getDB();

        $where = [];
        $params = [];

        if ($search !== '') {
            $where[] = '(u.username LIKE ? OR u.nickname LIKE ? OR u.email LIKE ?)';
            $like = '%' . $search . '%';
            $params[] = $like;
            $params[] = $like;
            $params[] = $like;
        }
        $validRoleFilters = ['visitor', 'external', 'member', 'manager', 'representative', 'super_admin'];
        if ($roleFilter !== '' && in_array($roleFilter, $validRoleFilters)) {
            if ($roleFilter === 'super_admin') {
                $where[] = 'u.role = ?';
                $params[] = 'super_admin';
            } elseif ($roleFilter === 'visitor') {
                $where[] = "u.role = 'visitor' AND NOT EXISTS (SELECT 1 FROM club_memberships cm WHERE cm.user_id = u.id AND cm.status = 'active')";
            } else {
                // external / member / manager / representative → 通过 club_memberships 过滤
                $where[] = "EXISTS (SELECT 1 FROM club_memberships cm WHERE cm.user_id = u.id AND cm.role = ? AND cm.status = 'active')";
                $params[] = $roleFilter;
            }
        }
        if ($statusFilter !== '' && in_array($statusFilter, ['active', 'disabled', 'banned'])) {
            $where[] = 'u.status = ?';
            $params[] = $statusFilter;
        }

        $whereClause = count($where) ? 'WHERE ' . implode(' AND ', $where) : '';

        // 总数
        $countStmt = $db->prepare("SELECT COUNT(*) FROM users u $whereClause");
        $countStmt->execute($params);
        $total = (int)$countStmt->fetchColumn();

        // 分页数据（LIMIT/OFFSET 需用 PARAM_INT 绑定）
        $dataStmt = $db->prepare(
            "SELECT u.id, u.username, u.nickname, u.email, u.avatar_url,
                    u.role, u.status, u.is_audit, u.created_at, u.updated_at, u.last_login_at
             FROM users u
             $whereClause
             ORDER BY u.id DESC
             LIMIT ? OFFSET ?"
        );
        $bindIdx = 1;
        foreach ($params as $p) {
            $dataStmt->bindValue($bindIdx++, $p, PDO::PARAM_STR);
        }
        $dataStmt->bindValue($bindIdx++, $perPage, PDO::PARAM_INT);
        $dataStmt->bindValue($bindIdx++, $offset, PDO::PARAM_INT);
        $dataStmt->execute();
        $users = $dataStmt->fetchAll();

        // 类型转换
        foreach ($users as &$u) {
            $u['id'] = (int)$u['id'];
        }

        // 批量获取 club_memberships 并计算 display_role
        $userIds = array_column($users, 'id');
        $userMemberships = [];
        if (!empty($userIds)) {
            $placeholders = implode(',', array_fill(0, count($userIds), '?'));
            $memStmt = $db->prepare(
                "SELECT cm.user_id, cm.id, cm.club_id, cm.country, cm.role, cm.status, cm.joined_at
                 FROM club_memberships cm
                 WHERE cm.user_id IN ($placeholders) AND cm.status = 'active'
                 ORDER BY cm.joined_at DESC"
            );
            $memStmt->execute($userIds);
            foreach ($memStmt->fetchAll() as $m) {
                $uid = (int)$m['user_id'];
                if (!isset($userMemberships[$uid])) $userMemberships[$uid] = [];
                $userMemberships[$uid][] = [
                    'id' => (int)$m['id'],
                    'club_id' => (int)$m['club_id'],
                    'country' => $m['country'],
                    'role' => $m['role'],
                    'status' => $m['status'],
                    'joined_at' => $m['joined_at'],
                ];
            }
        }
        foreach ($users as &$u) {
            $uid = $u['id'];
            $memberships = $userMemberships[$uid] ?? [];
            $u['memberships'] = $memberships;
            $u['display_role'] = computeDisplayRole($u['role'], $memberships);
        }
        unset($u);

        echo json_encode([
            'success' => true,
            'users' => $users,
            'total' => $total,
            'page' => $page,
            'per_page' => $perPage,
            'total_pages' => max(1, (int)ceil($total / $perPage)),
        ], JSON_UNESCAPED_UNICODE);
        exit();
        } catch (Exception $e) {
            echo json_encode(['success' => false, 'message' => '查询失败', 'error' => $e->getMessage()]);
            exit();
        }

    case 'get':
        // 获取单个用户详情
        $id = (int)($_GET['id'] ?? 0);
        if (!$id) {
            echo json_encode(['success' => false, 'message' => '缺少用户 ID']);
            exit();
        }

        $db = getDB();
        $stmt = $db->prepare(
            "SELECT u.id, u.username, u.nickname, u.email, u.avatar_url,
                    u.role, u.status, u.is_audit, u.created_at, u.updated_at, u.last_login_at
             FROM users u WHERE u.id = ?"
        );
        $stmt->execute([$id]);
        $user = $stmt->fetch();

        if (!$user) {
            echo json_encode(['success' => false, 'message' => '用户不存在']);
            exit();
        }

        $user['id'] = (int)$user['id'];

        // 获取该用户的 club_memberships
        $memStmt = $db->prepare(
            "SELECT cm.id, cm.club_id, cm.country, cm.role, cm.status, cm.joined_at
             FROM club_memberships cm
             WHERE cm.user_id = ? AND cm.status = 'active'
             ORDER BY cm.joined_at DESC"
        );
        $memStmt->execute([$id]);
        $memberships = $memStmt->fetchAll();
        foreach ($memberships as &$m) {
            $m['id'] = (int)$m['id'];
            $m['club_id'] = (int)$m['club_id'];
        }
        $user['memberships'] = $memberships;
        $user['display_role'] = computeDisplayRole($user['role'], $memberships);

        echo json_encode(['success' => true, 'user' => $user], JSON_UNESCAPED_UNICODE);
        exit();

    case 'update':
        // 修改用户信息
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }

        $input = json_decode(file_get_contents('php://input'), true);
        $id = (int)($input['id'] ?? 0);

        if (!$id) {
            echo json_encode(['success' => false, 'message' => '缺少用户 ID']);
            exit();
        }

        // self-protection
        if ($id === (int)$currentUser['id']) {
            if (isset($input['role']) && $input['role'] !== 'super_admin') {
                echo json_encode(['success' => false, 'message' => '不能降低自己的管理员权限']);
                exit();
            }
            if (isset($input['status']) && $input['status'] !== 'active') {
                echo json_encode(['success' => false, 'message' => '不能禁用或封禁自己的账号']);
                exit();
            }
        }

        $db = getDB();

        // 检查用户存在
        $stmt = $db->prepare('SELECT id FROM users WHERE id = ?');
        $stmt->execute([$id]);
        if (!$stmt->fetch()) {
            echo json_encode(['success' => false, 'message' => '用户不存在']);
            exit();
        }

        $updates = [];
        $params = [];

        $allowedRoles = ['visitor', 'member', 'manager', 'representative', 'super_admin'];
        if (isset($input['role']) && in_array($input['role'], $allowedRoles)) {
            $updates[] = 'role = ?';
            $params[] = $input['role'];
        }

        $allowedStatuses = ['active', 'disabled', 'banned'];
        if (isset($input['status']) && in_array($input['status'], $allowedStatuses)) {
            $updates[] = 'status = ?';
            $params[] = $input['status'];
        }

        if (isset($input['nickname'])) {
            $nickname = trim($input['nickname']);
            if (mb_strlen($nickname) > 0 && mb_strlen($nickname) <= 30) {
                $updates[] = 'nickname = ?';
                $params[] = $nickname;
            }
        }

        if (isset($input['is_audit'])) {
            $isAuditOn = (int)(bool)$input['is_audit'];
            $updates[] = 'is_audit = ?';
            $params[] = $isAuditOn;
            // 联动撤销：关闭「审核成员」身份时，同时清除其总审/陪审细分权限
            if (!$isAuditOn) {
                try {
                    $db->prepare("DELETE FROM galonly_reviewers WHERE user_id = ?")->execute([$id]);
                    logAction('users.revoke_audit_reviewer', 'user', $id, ['removed_reviewer_roles' => true]);
                } catch (Exception $e) {
                    // galonly_reviewers 表可能不存在（旧库），忽略
                }
            }
        }

        if (empty($updates)) {
            echo json_encode(['success' => false, 'message' => '没有可更新的字段']);
            exit();
        }

        $updates[] = "updated_at = CURRENT_TIMESTAMP";
        $params[] = $id;

        $db->prepare("UPDATE users SET " . implode(', ', $updates) . " WHERE id = ?")
            ->execute($params);

        logAction('users.update', 'user', $id, [
            'updated_fields' => array_keys($input),
            'by_user_id' => $currentUser['id'],
        ]);

        echo json_encode(['success' => true, 'message' => '用户信息已更新']);
        exit();

    case 'delete':
        // 软封禁用户
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }

        $input = json_decode(file_get_contents('php://input'), true);
        $id = (int)($input['id'] ?? 0);

        if (!$id) {
            echo json_encode(['success' => false, 'message' => '缺少用户 ID']);
            exit();
        }

        // 不能封禁自己
        if ($id === (int)$currentUser['id']) {
            echo json_encode(['success' => false, 'message' => '不能封禁自己的账号']);
            exit();
        }

        $db = getDB();

        $stmt = $db->prepare('SELECT id, username FROM users WHERE id = ?');
        $stmt->execute([$id]);
        $user = $stmt->fetch();

        if (!$user) {
            echo json_encode(['success' => false, 'message' => '用户不存在']);
            exit();
        }

        $db->prepare("UPDATE users SET status = 'banned', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            ->execute([$id]);

        logAction('users.ban', 'user', $id, [
            'username' => $user['username'],
            'by_user_id' => $currentUser['id'],
        ]);

        echo json_encode(['success' => true, 'message' => '用户已封禁']);
        exit();

    default:
        echo json_encode([
            'success' => false,
            'message' => '未知动作',
            'available_actions' => ['list', 'get', 'update', 'delete'],
        ]);
        exit();
}

/**
 * 根据账号角色和有效同好会关系计算权限等级
 */
function computeDisplayRole(string $systemRole, array $memberships): string {
    $hierarchy = ['visitor' => 0, 'external' => 1, 'member' => 2, 'manager' => 3, 'representative' => 4, 'super_admin' => 5];
    $highest = array_key_exists($systemRole, $hierarchy) ? $systemRole : 'visitor';
    $highestLevel = $hierarchy[$highest];
    foreach ($memberships as $m) {
        if (($m['status'] ?? 'active') !== 'active') continue;
        $level = $hierarchy[$m['role']] ?? 0;
        if ($level > $highestLevel) {
            $highestLevel = $level;
            $highest = $m['role'];
        }
    }
    return $highest;
}
