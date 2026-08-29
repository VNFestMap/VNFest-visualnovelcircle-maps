<?php
// api/announcements.php - 全站公告系统 API
// 动作: list, create, update, publish, delete, active

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/notifications.php';

$action = $_GET['action'] ?? '';

switch ($action) {

    // ---- 超级管理员：获取全部公告列表 ----
    case 'list':
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            echo json_encode(['success' => false, 'message' => '仅支持 GET 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        $user = requireLogin();
        if ($user['role'] !== 'super_admin') {
            echo json_encode(['success' => false, 'message' => '权限不足'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        $db = getDB();
        $stmt = $db->query("SELECT id, title, content, type, status, is_persistent, created_by, created_at, published_at FROM announcements ORDER BY created_at DESC");
        $list = $stmt->fetchAll();
        echo json_encode(['success' => true, 'announcements' => $list], JSON_UNESCAPED_UNICODE);
        break;

    // ---- 超级管理员：创建公告草稿 ----
    case 'create':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        $user = requireLogin();
        if ($user['role'] !== 'super_admin') {
            echo json_encode(['success' => false, 'message' => '权限不足'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        $input = json_decode(file_get_contents('php://input'), true);
        $title = trim($input['title'] ?? '');
        $content = trim($input['content'] ?? '');
        $type = in_array($input['type'] ?? '', ['info', 'warning', 'important', 'update']) ? $input['type'] : 'info';
        $isPersistent = isset($input['is_persistent']) ? (int)(bool)$input['is_persistent'] : 1;

        if (empty($title)) {
            echo json_encode(['success' => false, 'message' => '公告标题不能为空'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if (empty($content)) {
            echo json_encode(['success' => false, 'message' => '公告内容不能为空'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();
        $stmt = $db->prepare("INSERT INTO announcements (title, content, type, status, is_persistent, created_by) VALUES (:title, :content, :type, 'draft', :is_persistent, :created_by)");
        $stmt->execute([
            ':title' => $title,
            ':content' => $content,
            ':type' => $type,
            ':is_persistent' => $isPersistent,
            ':created_by' => $user['id'],
        ]);
        $id = $db->lastInsertId();
        echo json_encode(['success' => true, 'id' => $id, 'message' => '草稿已保存'], JSON_UNESCAPED_UNICODE);
        break;

    // ---- 超级管理员：更新公告草稿 ----
    case 'update':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        $user = requireLogin();
        if ($user['role'] !== 'super_admin') {
            echo json_encode(['success' => false, 'message' => '权限不足'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        $input = json_decode(file_get_contents('php://input'), true);
        $id = (int)($input['id'] ?? 0);
        if ($id <= 0) {
            echo json_encode(['success' => false, 'message' => '无效的公告 ID'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        $title = trim($input['title'] ?? '');
        $content = trim($input['content'] ?? '');
        $type = in_array($input['type'] ?? '', ['info', 'warning', 'important', 'update']) ? $input['type'] : 'info';
        $isPersistent = isset($input['is_persistent']) ? (int)(bool)$input['is_persistent'] : 1;

        if (empty($title)) {
            echo json_encode(['success' => false, 'message' => '公告标题不能为空'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();
        $stmt = $db->prepare("UPDATE announcements SET title = :title, content = :content, type = :type, is_persistent = :is_persistent WHERE id = :id AND status = 'draft'");
        $stmt->execute([
            ':title' => $title,
            ':content' => $content,
            ':type' => $type,
            ':is_persistent' => $isPersistent,
            ':id' => $id,
        ]);
        echo json_encode(['success' => true, 'message' => '草稿已更新'], JSON_UNESCAPED_UNICODE);
        break;

    // ---- 超级管理员：发布公告 ----
    case 'publish':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        $user = requireLogin();
        if ($user['role'] !== 'super_admin') {
            echo json_encode(['success' => false, 'message' => '权限不足'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        $input = json_decode(file_get_contents('php://input'), true);
        $id = (int)($input['id'] ?? 0);
        if ($id <= 0) {
            echo json_encode(['success' => false, 'message' => '无效的公告 ID'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();
        $stmt = $db->prepare("SELECT title, content, type FROM announcements WHERE id = :id");
        $stmt->execute([':id' => $id]);
        $announce = $stmt->fetch();

        if (!$announce) {
            echo json_encode(['success' => false, 'message' => '公告不存在'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        // 更新状态为已发布
        $updateStmt = $db->prepare("UPDATE announcements SET status = 'published', published_at = " . (DB_DRIVER === 'mysql' ? "NOW()" : "datetime('now')") . " WHERE id = :id");
        $updateStmt->execute([':id' => $id]);

        // 广播通知给所有活跃用户
        $typeLabel = ['info' => '信息', 'warning' => '警告', 'important' => '重要', 'update' => '更新'];
        $sent = broadcastNotification(
            'system',
            '📢 全站公告：' . $announce['title'],
            (string)$announce['content'],
            '',
            'announcement',
            $id
        );

        echo json_encode(['success' => true, 'message' => '公告已发布', 'notified' => $sent], JSON_UNESCAPED_UNICODE);
        break;

    // ---- 超级管理员：删除公告 ----
    case 'delete':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        $user = requireLogin();
        if ($user['role'] !== 'super_admin') {
            echo json_encode(['success' => false, 'message' => '权限不足'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        $input = json_decode(file_get_contents('php://input'), true);
        $id = (int)($input['id'] ?? 0);
        if ($id <= 0) {
            echo json_encode(['success' => false, 'message' => '无效的公告 ID'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();
        $stmt = $db->prepare("DELETE FROM announcements WHERE id = :id");
        $stmt->execute([':id' => $id]);
        echo json_encode(['success' => true, 'message' => '公告已删除'], JSON_UNESCAPED_UNICODE);
        break;

    // ---- 公开接口：获取活跃公告（无需登录） ----
    case 'active':
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            echo json_encode(['success' => false, 'message' => '仅支持 GET 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        $db = getDB();
        $stmt = $db->query("SELECT id, title, content, type, is_persistent, created_at, published_at FROM announcements WHERE status = 'published' AND is_persistent = 1 ORDER BY published_at DESC LIMIT 20");
        $list = $stmt->fetchAll();
        echo json_encode(['success' => true, 'announcements' => $list], JSON_UNESCAPED_UNICODE);
        break;

    default:
        echo json_encode(['success' => false, 'message' => '未知操作'], JSON_UNESCAPED_UNICODE);
        break;
}
