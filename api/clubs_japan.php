<?php
// api_japan.php - 日本同好会数据管理API
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Admin-Token');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

$dataFile = __DIR__ . '/../data/clubs_japan.json';
require_once __DIR__ . '/../includes/japan_prefectures.php';

// GET - 读取数据
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    require_once __DIR__ . '/../includes/auth.php';
    if (!file_exists($dataFile)) {
        echo json_encode(['success' => true, 'total' => 0, 'data' => []]);
        exit();
    }
    $json = json_decode(file_get_contents($dataFile), true);
    $rows = $json['data'] ?? [];

    // 检查当前用户的绑定状态和角色
    $user = getCurrentUser();
    $effectiveLevel = $user ? (ROLE_HIERARCHY[$user['role']] ?? -1) : -1;
    $memberLevel = ROLE_HIERARCHY['member'];

    $memberships = [];
    $memberRoles = [];
    if ($user) {
        $db = getDB();
        $stmt = $db->prepare("SELECT club_id, COALESCE(country, 'china') AS country, status, role FROM club_memberships WHERE user_id = ?");
        $stmt->execute([$user['id']]);
        foreach ($stmt->fetchAll() as $m) {
            $key = $m['club_id'] . ':' . ($m['country'] ?? 'china');
            $memberships[$key] = $m['status'];
            $memberRoles[$key] = $m['role'] ?? '';
            // 取俱乐部角色中的最高等级
            if ($m['status'] === 'active') {
                $clubLevel = ROLE_HIERARCHY[$m['role']] ?? -1;
                if ($clubLevel > $effectiveLevel) $effectiveLevel = $clubLevel;
            }
        }
    }
    $canSeeAllInfo = $effectiveLevel >= $memberLevel;

    foreach ($rows as &$item) {
        $clubId = $item['id'] ?? 0;
        $clubCountry = $item['country'] ?? 'japan';
        $membershipKey = $clubId . ':' . $clubCountry;
        $membershipStatus = $memberships[$membershipKey] ?? null;
        $hasPending = $membershipStatus === 'pending';
        $isMember = $membershipStatus === 'active' && ($memberRoles[$membershipKey] ?? '') !== 'external';
        $visibleByDefault = !empty($item['visible_by_default']);
        // 管理员及以上系统角色可查看所有学校的信息

        // 联系方式可见性: 非成员 + 非公开 + 非管理员 → 隐藏
        // 新增：已提交绑定申请（pending）的用户可临时查看联系方式
        $isProtected = !empty($item['protected']);
        if ($isProtected) {
            // 保护模式：成员、待审核申请人或 负责人级别及以上 可见
            $canSeeProtected = $effectiveLevel >= ROLE_HIERARCHY['representative'];
            $item['info_hidden'] = !$isMember && !$hasPending && !$canSeeProtected;
        } else {
            $item['info_hidden'] = !$isMember && !$hasPending && !$visibleByDefault && !$canSeeAllInfo;
        }
        // 申请资格: 已登录 + 非该俱乐部成员 + 无待审核申请 → 可申请（与可见性解耦）
        $item['can_apply'] = ($user !== null) && !$isMember && !$hasPending;
        $item['membership_status'] = $membershipStatus;
        if ($item['info_hidden']) {
            $item['info'] = '申请绑定后可见';
        }
    }
    unset($item);

    $json['data'] = $rows;
    echo json_encode($json, JSON_UNESCAPED_UNICODE);
    exit();
}

// 以下需要验证
require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/audit.php';

// POST - 添加（仅 super_admin）
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $authUser = requireAdmin();
    if ($authUser['role'] !== 'super_admin') {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => '无权添加同好会']);
        exit();
    }
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input || !isset($input['name']) || !isset($input['info'])) {
        echo json_encode(['success' => false, 'message' => '缺少必填字段']);
        exit();
    }
    
    // 日本数据使用 prefecture，兼容旧的 province 字段
    $prefecture = normalizeJapanPrefectureName($input['prefecture'] ?? $input['province'] ?? '');
    if (empty($prefecture)) {
        echo json_encode(['success' => false, 'message' => '请填写都道府县']);
        exit();
    }
    
    $current = json_decode(file_get_contents($dataFile), true);
    $rows = $current['data'] ?? [];
    
    $maxId = 0;
    foreach ($rows as $item) {
        if (($item['id'] ?? 0) > $maxId) $maxId = $item['id'];
    }
    
    $newItem = [
        'id' => $maxId + 1,
        'prefecture' => $prefecture,           // 日本县/都/府/道
        'province' => $prefecture,              // 兼容旧字段
        'school' => $input['school'] ?? '',
        'name' => $input['name'],
        'display_name' => $input['name'],
        'info' => $input['info'],
        'type' => $input['type'] ?? 'school',
        'verified' => 1,
        'raw_text' => $input['name'] . ' ' . $input['info'],
        'created_at' => date('Y-m-d H:i:s'),
        'project' => 'galgame',
        'remark' => $input['remark'] ?? '',
        'country' => 'japan',
        'logo_url' => $input['logo_url'] ?? '',
        'external_links' => $input['external_links'] ?? '',
        'protected' => $input['protected'] ?? false,
    ];
    
    $rows[] = $newItem;
    $result = ['success' => true, 'total' => count($rows), 'data' => $rows];
    
    file_put_contents($dataFile, json_encode($result, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    echo json_encode(['success' => true, 'message' => '添加成功', 'id' => $newItem['id'], 'data' => $newItem]);
    exit();
}

// PUT - 更新
if ($_SERVER['REQUEST_METHOD'] === 'PUT') {
    $authUser = requireLogin();
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input || !isset($input['id'])) {
        echo json_encode(['success' => false, 'message' => '无效数据']);
        exit();
    }

    // 权限检查：仅 super_admin 或可管理该俱乐部者
    $clubId = (int)$input['id'];
    if ($authUser['role'] !== 'super_admin' && !canManageClubInCountry($authUser, $clubId, 'japan')) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => '无权修改此同好会']);
        exit();
    }
    
    $current = json_decode(file_get_contents($dataFile), true);
    $rows = $current['data'] ?? [];
    $updated = false;
    
    foreach ($rows as $i => $item) {
        if ($item['id'] == $input['id']) {
            // 日本数据使用 prefecture
            $prefecture = normalizeJapanPrefectureName($input['prefecture'] ?? $input['province'] ?? $item['prefecture']);
            $rows[$i]['prefecture'] = $prefecture;
            $rows[$i]['province'] = $prefecture;  // 兼容旧字段
            $rows[$i]['school'] = $input['school'] ?? $item['school'];
            $rows[$i]['name'] = $input['name'] ?? $item['name'];
            $rows[$i]['display_name'] = $input['name'] ?? $item['name'];
            $rows[$i]['info'] = $input['info'] ?? $item['info'];
            $rows[$i]['type'] = $input['type'] ?? $item['type'];
            $rows[$i]['raw_text'] = ($input['name'] ?? $item['name']) . ' ' . ($input['info'] ?? $item['info']);
            $rows[$i]['created_at'] = $input['created_at'] ?? $item['created_at'] ?? '';
            $rows[$i]['remark'] = $input['remark'] ?? $item['remark'];
            $rows[$i]['logo_url'] = $input['logo_url'] ?? $item['logo_url'] ?? '';
            $rows[$i]['external_links'] = $input['external_links'] ?? $item['external_links'] ?? '';
            if (isset($input['visible_by_default'])) {
                $rows[$i]['visible_by_default'] = $input['visible_by_default'] ? true : false;
            }
            if (isset($input['protected'])) {
                $rows[$i]['protected'] = $input['protected'] ? true : false;
            }
            $rows[$i]['country'] = 'japan';
            $updated = true;
            break;
        }
    }
    
    if (!$updated) {
        echo json_encode(['success' => false, 'message' => '未找到要更新的数据']);
        exit();
    }
    
    $result = ['success' => true, 'total' => count($rows), 'data' => $rows];
    file_put_contents($dataFile, json_encode($result, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    echo json_encode(['success' => true, 'message' => '更新成功']);
    exit();
}

// DELETE - 删除
if ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
    $authUser = requireAdmin();
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input || !isset($input['id'])) {
        echo json_encode(['success' => false, 'message' => '无效数据']);
        exit();
    }

    // 权限检查：仅 super_admin
    if ($authUser['role'] !== 'super_admin') {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => '无权删除同好会']);
        exit();
    }
    
    $current = json_decode(file_get_contents($dataFile), true);
    $rows = $current['data'] ?? [];
    $newRows = [];
    
    foreach ($rows as $item) {
        if ($item['id'] != $input['id']) {
            $newRows[] = $item;
        }
    }
    
    $result = ['success' => true, 'total' => count($newRows), 'data' => $newRows];
    file_put_contents($dataFile, json_encode($result, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    echo json_encode(['success' => true, 'message' => '删除成功']);
    exit();
}

echo json_encode(['success' => false, 'message' => '不支持的请求方法']);
?>
