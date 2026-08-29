<?php
// includes/recognition/roles.php - 同好会认可角色与权限
// MVP 角色映射（架构文档 16.1）：
//   representative = Owner + Program Designer；manager = Reviewer + Issuer；
//   is_audit = Auditor；Integration Manager / Integration Bot 随专家阶段启用。
// 细分角色可显式写入 recognition_club_roles，查询时先查显式角色再回退隐式映射。

require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../auth.php';

const RECOGNITION_ROLES = [
    'owner', 'program_designer', 'reviewer', 'badge_manager',
    'integration_manager', 'issuer', 'auditor', 'integration_bot',
];

// 隐式映射：club_memberships.role / users 属性 → 认可角色集合
const RECOGNITION_ROLE_FALLBACK = [
    'representative' => ['owner', 'program_designer', 'badge_manager', 'issuer', 'reviewer'],
    'manager'        => ['reviewer', 'issuer'],
];

/**
 * 获取用户在指定同好会拥有的认可角色集合
 */
function recogUserRoles(array $user, int $clubId, string $country = 'china'): array {
    $roles = [];
    if ($user['role'] === 'super_admin') {
        return RECOGNITION_ROLES;
    }

    $db = getDB();

    // 显式角色
    try {
        $stmt = $db->prepare(
            'SELECT role FROM recognition_club_roles WHERE club_id = ? AND country = ? AND user_id = ?'
        );
        $stmt->execute([$clubId, $country, $user['id']]);
        foreach ($stmt->fetchAll() as $row) {
            $roles[] = $row['role'];
        }
    } catch (PDOException $e) {
        error_log('[recog] roles query failed: ' . $e->getMessage());
    }

    // 隐式回退：社团成员角色
    try {
        $stmt = $db->prepare(
            "SELECT role FROM club_memberships
             WHERE user_id = ? AND club_id = ? AND country = ? AND status = 'active'"
        );
        $stmt->execute([$user['id'], $clubId, $country]);
        if ($m = $stmt->fetch()) {
            foreach (RECOGNITION_ROLE_FALLBACK[$m['role']] ?? [] as $r) {
                $roles[] = $r;
            }
        }
    } catch (PDOException $e) {
        error_log('[recog] membership query failed: ' . $e->getMessage());
    }

    // Auditor
    if (!empty($user['is_audit'])) {
        $roles[] = 'auditor';
    }

    return array_values(array_unique($roles));
}

/**
 * 是否拥有指定认可角色
 */
function recogHasRole(array $user, int $clubId, string $country, string $role): bool {
    return in_array($role, recogUserRoles($user, $clubId, $country), true);
}

/**
 * 是否可管理（创建/编辑/发布）指定同好会的认可项目
 */
function recogCanDesign(array $user, int $clubId, string $country = 'china'): bool {
    if ($user['role'] === 'super_admin') return true;
    return recogHasRole($user, $clubId, $country, 'program_designer')
        || canManageClub($user, $clubId);
}

/**
 * 是否可审核指定同好会的提交
 */
function recogCanReview(array $user, int $clubId, string $country = 'china'): bool {
    if ($user['role'] === 'super_admin') return true;
    return recogHasRole($user, $clubId, $country, 'reviewer')
        || canManageClub($user, $clubId);
}

/**
 * 是否可执行人工授予 / 撤销凭证
 */
function recogCanIssue(array $user, int $clubId, string $country = 'china'): bool {
    if ($user['role'] === 'super_admin') return true;
    return recogHasRole($user, $clubId, $country, 'issuer')
        || canManageClub($user, $clubId);
}
