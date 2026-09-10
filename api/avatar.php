<?php
// api/avatar.php - 头像上传与获取
// 动作: upload, get

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/rate_limit.php';
require_once __DIR__ . '/../includes/audit.php';
require_once __DIR__ . '/../includes/image_host.php';

$action = $_GET['action'] ?? '';

switch ($action) {
    case 'upload':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
            exit();
        }
        $user = requireLogin();
        checkRateLimit('avatar_upload', 5, 1);

        if (!isset($_FILES['avatar']) || $_FILES['avatar']['error'] !== UPLOAD_ERR_OK) {
            $errMsg = $_FILES['avatar']['error'] ?? -1;
            echo json_encode(['success' => false, 'message' => '上传失败，错误码: ' . $errMsg]);
            exit();
        }

        $file = $_FILES['avatar'];

        // 验证文件大小（最大 2MB）
        if ($file['size'] > 2 * 1024 * 1024) {
            echo json_encode(['success' => false, 'message' => '图片大小不能超过 2MB']);
            exit();
        }

        // 验证图片类型
        $detectedType = null;
        if (function_exists('exif_imagetype')) {
            $detectedType = @exif_imagetype($file['tmp_name']);
        } elseif (function_exists('getimagesize')) {
            $info = @getimagesize($file['tmp_name']);
            $detectedType = $info[2] ?? null;
        } else {
            // 最后 fallback: 检查扩展名
            $extMap = [
                'jpg' => IMAGETYPE_JPEG, 'jpeg' => IMAGETYPE_JPEG,
                'png' => IMAGETYPE_PNG, 'gif' => IMAGETYPE_GIF, 'webp' => IMAGETYPE_WEBP,
            ];
            $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
            $detectedType = $extMap[$ext] ?? null;
        }

        $allowedTypes = [IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_GIF, IMAGETYPE_WEBP];
        if (!in_array($detectedType, $allowedTypes, true)) {
            echo json_encode(['success' => false, 'message' => '仅支持 JPEG、PNG、GIF、WebP 格式']);
            exit();
        }

        // 扩展名映射
        $extMap = [
            IMAGETYPE_JPEG => 'jpg',
            IMAGETYPE_PNG => 'png',
            IMAGETYPE_GIF => 'gif',
            IMAGETYPE_WEBP => 'webp',
        ];
        $ext = $extMap[$detectedType];

        // 保存唯一的本地副本；旧头像不删除，便于长期备份和回退。
        $avatarDir = __DIR__ . '/../data/avatars';
        if (!is_dir($avatarDir)) {
            mkdir($avatarDir, 0755, true);
        }

        // 旧头像文件不删除，保持长期本地备份。
        $userId = (int)$user['id'];
        $fileName = 'avatar_' . $userId . '_' . date('YmdHis') . '_' . bin2hex(random_bytes(4)) . '.' . $ext;
        $destPath = $avatarDir . '/' . $fileName;
        $localUrl = 'data/avatars/' . $fileName;
        $stored = imageHostStoreUploadedFile($file['tmp_name'], $destPath, $localUrl, (string)$file['name'], 'avatar');
        if (!$stored['ok']) {
            echo json_encode(['success' => false, 'message' => $stored['error'] ?? '文件保存失败']);
            exit();
        }

        $timestamp = time();
        $avatarUrl = $stored['url'] . (str_contains($stored['url'], '?') ? '&' : '?') . 't=' . $timestamp;

        // 更新数据库
        $db = getDB();
        $db->prepare(
            "UPDATE users SET avatar_url = ?, avatar_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )->execute([$avatarUrl, $userId]);

        logAction('user.change_avatar', 'user', $userId);

        echo json_encode([
            'success' => true,
            'message' => '头像上传成功',
            'avatar_url' => $avatarUrl,
            'storage' => $stored['storage'],
            'local_backup' => $stored['local_backup'],
        ]);
        exit();

    default:
        echo json_encode(['success' => false, 'message' => '未知动作']);
        exit();
}
