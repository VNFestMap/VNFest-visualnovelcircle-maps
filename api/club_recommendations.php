<?php
// api/club_recommendations.php - 同好会神器推荐榜 API
// 动作: list, add, remove, reorder

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
require_once __DIR__ . '/../includes/image_proxy_helper.php';

$action = $_GET['action'] ?? '';

const CLUB_RECOMMENDATION_SLOT_COUNT = 12;

/**
 * 从 bangumi_proxy 的缓存中读取评分，避免后端直连 Bangumi API
 */
function fetchBangumiRating(int $bangumiId): float {
    $cacheDir = __DIR__ . '/../data/cache/bangumi';

    // 检查 v3 缓存 (subject_{id}.json)
    $files = [
        $cacheDir . '/subject_' . $bangumiId . '.json',
        $cacheDir . '/subject_' . $bangumiId . '_v0.json',
    ];
    foreach ($files as $f) {
        if (file_exists($f)) {
            $data = json_decode(file_get_contents($f), true);
            if ($data) {
                $score = (float)($data['rating']['score'] ?? $data['score'] ?? 0);
                if ($score > 0) return $score;
            }
        }
    }
    return 0;
}

/**
 * 检查用户是否有权限管理推荐榜
 */
function canManageRecommendations(array $user, int $clubId, string $country): bool {
    if ($user['role'] === 'super_admin') return true;
    $db = getDB();
    try {
        $stmt = $db->prepare(
            "SELECT id FROM club_memberships WHERE user_id = ? AND club_id = ? AND country = ? AND role IN ('representative', 'manager') AND status = 'active'"
        );
        $stmt->execute([$user['id'], $clubId, $country]);
        return (bool)$stmt->fetch();
    } catch (Exception $e) {
        return false;
    }
}

switch ($action) {
    // ===== 获取推荐列表（公开可读） =====
    case 'list':
        $clubId = (int)($_GET['club_id'] ?? 0);
        $country = $_GET['country'] ?? 'china';

        if ($clubId <= 0) {
            echo json_encode(['success' => false, 'message' => '无效的同好会 ID']);
            exit();
        }

        $db = getDB();
        $stmt = $db->prepare(
            "SELECT r.id, r.bangumi_id, r.title, r.image_url, r.rating, r.summary, r.sort_order, r.created_at
             FROM club_recommendations r
             WHERE r.club_id = ? AND r.country = ?
             ORDER BY r.sort_order ASC, r.id ASC
             LIMIT 12"
        );
        $stmt->execute([$clubId, $country]);
        $list = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($list as &$row) {
            $row['image_url'] = proxyImageUrl($row['image_url'] ?? '');
        }

        echo json_encode(['success' => true, 'data' => $list], JSON_UNESCAPED_UNICODE);
        exit();

    // ===== 添加推荐 =====
    case 'add':
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input)) {
            echo json_encode(['success' => false, 'message' => '请求数据格式错误']);
            exit();
        }

        $clubId = (int)($input['club_id'] ?? 0);
        $country = $input['country'] ?? 'china';
        $bangumiId = (int)($input['bangumi_id'] ?? 0);
        $title = trim($input['title'] ?? '');
        $imageUrl = trim($input['image_url'] ?? '');
        $rating = (float)($input['rating'] ?? 0);
        $summary = trim($input['summary'] ?? '');
        $positionInput = $input['position'] ?? null;

        if ($clubId <= 0) {
            echo json_encode(['success' => false, 'message' => '无效的同好会 ID']);
            exit();
        }
        if ($bangumiId <= 0 || $title === '') {
            echo json_encode(['success' => false, 'message' => '请选择有效的游戏条目']);
            exit();
        }
        if (!canManageRecommendations($user, $clubId, $country)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '无权管理推荐榜']);
            exit();
        }

        $requestedSortOrder = null;
        if ($positionInput !== null && $positionInput !== '') {
            $position = filter_var($positionInput, FILTER_VALIDATE_INT);
            if (is_bool($positionInput) || $position === false) {
                echo json_encode(['success' => false, 'message' => '推荐位置必须是 1 到 12 的整数']);
                exit();
            }
            if ($position < 1 || $position > CLUB_RECOMMENDATION_SLOT_COUNT) {
                echo json_encode(['success' => false, 'message' => '推荐位置必须是 1 到 12']);
                exit();
            }
            $requestedSortOrder = $position - 1;
        }

        // Bangumi 搜索 API 不再返回评分，自动补抓
        if ($rating <= 0) {
            $fetched = fetchBangumiRating($bangumiId);
            if ($fetched > 0) $rating = $fetched;
        }

        $db = getDB();

        // 检查是否已达上限
        $countStmt = $db->prepare("SELECT COUNT(*) FROM club_recommendations WHERE club_id = ? AND country = ?");
        $countStmt->execute([$clubId, $country]);
        $count = (int)$countStmt->fetchColumn();

        if ($count >= 12) {
            echo json_encode(['success' => false, 'message' => '推荐榜已达上限（12 部）']);
            exit();
        }

        // 检查是否已添加过该条目
        $dupStmt = $db->prepare(
            "SELECT id FROM club_recommendations WHERE club_id = ? AND country = ? AND bangumi_id = ?"
        );
        $dupStmt->execute([$clubId, $country, $bangumiId]);
        if ($dupStmt->fetch()) {
            echo json_encode(['success' => false, 'message' => '该条目已在推荐榜中']);
            exit();
        }

        if ($requestedSortOrder !== null) {
            $slotStmt = $db->prepare(
                "SELECT id FROM club_recommendations WHERE club_id = ? AND country = ? AND sort_order = ? LIMIT 1"
            );
            $slotStmt->execute([$clubId, $country, $requestedSortOrder]);
            if ($slotStmt->fetchColumn() !== false) {
                echo json_encode(['success' => false, 'message' => '第 ' . ($requestedSortOrder + 1) . ' 位已有条目，请选择空位或使用排序']);
                exit();
            }
            $sortOrder = $requestedSortOrder;
        } else {
            // 未指定位置时填入第一个空槽，而不是简单追加到末尾。
            $occupiedStmt = $db->prepare(
                "SELECT sort_order FROM club_recommendations WHERE club_id = ? AND country = ?"
            );
            $occupiedStmt->execute([$clubId, $country]);
            $occupied = [];
            foreach ($occupiedStmt->fetchAll(PDO::FETCH_COLUMN) as $order) {
                $order = (int)$order;
                if ($order >= 0 && $order < CLUB_RECOMMENDATION_SLOT_COUNT) {
                    $occupied[$order] = true;
                }
            }
            $sortOrder = null;
            for ($candidate = 0; $candidate < CLUB_RECOMMENDATION_SLOT_COUNT; $candidate++) {
                if (!isset($occupied[$candidate])) {
                    $sortOrder = $candidate;
                    break;
                }
            }
            if ($sortOrder === null) {
                echo json_encode(['success' => false, 'message' => '没有可用的推荐榜位置，请先整理排序']);
                exit();
            }
        }

        $stmt = $db->prepare(
            "INSERT INTO club_recommendations (club_id, country, bangumi_id, title, image_url, rating, summary, sort_order, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        );
        $stmt->execute([$clubId, $country, $bangumiId, $title, $imageUrl, $rating, $summary, $sortOrder, $user['id']]);

        $newId = $db->lastInsertId();

        logAction('add_recommendation', 'club_recommendations', $newId,
            [
                'club_id' => $clubId,
                'bangumi_id' => $bangumiId,
                'title' => $title,
                'position' => $sortOrder + 1,
            ]);

        echo json_encode([
            'success' => true,
            'message' => '已添加推荐',
            'id' => (int)$newId,
        ]);
        exit();

    // ===== 移除推荐 =====
    case 'remove':
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input) || !isset($input['id'])) {
            echo json_encode(['success' => false, 'message' => '无效数据']);
            exit();
        }

        $id = (int)$input['id'];
        $db = getDB();

        $stmt = $db->prepare("SELECT id, club_id, country FROM club_recommendations WHERE id = ?");
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$row) {
            echo json_encode(['success' => false, 'message' => '推荐条目不存在']);
            exit();
        }

        if (!canManageRecommendations($user, (int)$row['club_id'], $row['country'] ?: 'china')) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '无权移除推荐']);
            exit();
        }

        $delStmt = $db->prepare("DELETE FROM club_recommendations WHERE id = ?");
        $delStmt->execute([$id]);

        logAction('remove_recommendation', 'club_recommendations', $id, null);

        echo json_encode(['success' => true, 'message' => '已移除推荐']);
        exit();

    // ===== 重新排序 =====
    case 'reorder':
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input)) {
            echo json_encode(['success' => false, 'message' => '无效数据']);
            exit();
        }

        $hasSlots = isset($input['slots']) && is_array($input['slots']);
        $hasLegacyIds = isset($input['ids']) && is_array($input['ids']);
        if (!$hasSlots && !$hasLegacyIds) {
            echo json_encode(['success' => false, 'message' => '请提供 12 个推荐槽位']);
            exit();
        }

        if ($hasSlots) {
            $slots = $input['slots'];
            if (count($slots) !== CLUB_RECOMMENDATION_SLOT_COUNT) {
                echo json_encode(['success' => false, 'message' => '推荐槽位必须恰好为 12 个']);
                exit();
            }
        } else {
            // 兼容旧版调用：旧 ids 数组表示从第 1 位开始的完整顺序。
            $legacyIds = $input['ids'];
            if (count($legacyIds) === 0 || count($legacyIds) > CLUB_RECOMMENDATION_SLOT_COUNT) {
                echo json_encode(['success' => false, 'message' => '推荐列表数量无效']);
                exit();
            }
            $slots = array_fill(0, CLUB_RECOMMENDATION_SLOT_COUNT, null);
            foreach ($legacyIds as $index => $legacyId) {
                $slots[$index] = $legacyId;
            }
        }

        $submittedIds = [];
        foreach ($slots as $slotIndex => $slotId) {
            if ($slotId === null || $slotId === '') {
                $slots[$slotIndex] = null;
                continue;
            }
            $normalizedId = filter_var($slotId, FILTER_VALIDATE_INT);
            if (is_bool($slotId) || $normalizedId === false || $normalizedId <= 0) {
                echo json_encode(['success' => false, 'message' => '推荐槽位包含无效条目']);
                exit();
            }
            $slots[$slotIndex] = $normalizedId;
            if (in_array($normalizedId, $submittedIds, true)) {
                echo json_encode(['success' => false, 'message' => '推荐槽位不能包含重复条目']);
                exit();
            }
            $submittedIds[] = $normalizedId;
        }

        if (count($submittedIds) === 0) {
            echo json_encode(['success' => false, 'message' => '推荐列表不能为空']);
            exit();
        }

        $db = getDB();
        $placeholders = implode(',', array_fill(0, count($submittedIds), '?'));
        $rowsStmt = $db->prepare(
            "SELECT id, club_id, country FROM club_recommendations WHERE id IN ($placeholders)"
        );
        $rowsStmt->execute($submittedIds);
        $rowsById = [];
        foreach ($rowsStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $rowsById[(int)$row['id']] = $row;
        }
        if (count($rowsById) !== count($submittedIds)) {
            echo json_encode(['success' => false, 'message' => '推荐槽位包含不存在的条目']);
            exit();
        }

        $firstRow = reset($rowsById);
        $clubId = (int)$firstRow['club_id'];
        $country = $firstRow['country'] ?: 'china';
        foreach ($rowsById as $row) {
            if ((int)$row['club_id'] !== $clubId || ($row['country'] ?: 'china') !== $country) {
                echo json_encode(['success' => false, 'message' => '不能跨同好会或国家混合排序']);
                exit();
            }
        }

        if (!canManageRecommendations($user, $clubId, $country)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '无权排序']);
            exit();
        }

        $currentStmt = $db->prepare(
            "SELECT id FROM club_recommendations WHERE club_id = ? AND country = ? ORDER BY id ASC"
        );
        $currentStmt->execute([$clubId, $country]);
        $currentIds = array_map('intval', $currentStmt->fetchAll(PDO::FETCH_COLUMN));
        $submittedSet = $submittedIds;
        sort($currentIds, SORT_NUMERIC);
        sort($submittedSet, SORT_NUMERIC);
        if ($currentIds !== $submittedSet) {
            echo json_encode(['success' => false, 'message' => '推荐槽位必须完整包含该同好会当前的全部条目']);
            exit();
        }

        try {
            $db->beginTransaction();
            $updateStmt = $db->prepare(
                "UPDATE club_recommendations SET sort_order = ? WHERE id = ? AND club_id = ? AND country = ?"
            );
            foreach ($slots as $sortOrder => $recId) {
                if ($recId === null) continue;
                $updateStmt->execute([$sortOrder, $recId, $clubId, $country]);
            }
            $db->commit();
        } catch (Throwable $e) {
            if ($db->inTransaction()) $db->rollBack();
            http_response_code(500);
            echo json_encode(['success' => false, 'message' => '排序保存失败，请稍后重试']);
            exit();
        }

        logAction('reorder_recommendations', 'club_recommendations', $clubId,
            ['club_id' => $clubId, 'country' => $country, 'slots' => $slots]);

        echo json_encode(['success' => true, 'message' => '排序已更新']);
        exit();

    default:
        echo json_encode(['success' => false, 'message' => '未知操作 action=' . $action]);
        exit();
}
