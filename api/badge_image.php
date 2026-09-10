<?php
// api/badge_image.php - 同好会考核徽章图片上传
// 动作: upload
// 端点只负责落盘并返回站点根相对路径，image_url 由 badge_create / badge_update 持久化。

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/rate_limit.php';
require_once __DIR__ . '/../includes/audit.php';
require_once __DIR__ . '/../includes/display_club.php';
require_once __DIR__ . '/../includes/recognition/roles.php';

$action = $_GET['action'] ?? '';

switch ($action) {
    case 'upload': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $user = requireLogin();
        checkRateLimit('badge_image_upload', 10, 1);

        $clubId = (int)($_POST['club_id'] ?? 0);
        $country = displayClubCountry((string)($_POST['country'] ?? 'china')) ?? 'china';
        if ($clubId <= 0 || !displayClubRecord($clubId, $country)) {
            echo json_encode(['success' => false, 'message' => '同好会不存在'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        if (!recogHasRole($user, $clubId, $country, 'badge_manager') && !canManageClub($user, $clubId) && $user['role'] !== 'super_admin') {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '无权管理该同好会徽章'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        if (!isset($_FILES['image']) || $_FILES['image']['error'] !== UPLOAD_ERR_OK) {
            $errMsg = $_FILES['image']['error'] ?? -1;
            echo json_encode(['success' => false, 'message' => '上传失败，错误码: ' . $errMsg], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $file = $_FILES['image'];
        // 不设文件大小上限：前端已强制裁剪为 512×512 再上传，体积可控；
        // 实际极限仍受 PHP upload_max_filesize / post_max_size 环境配置约束。

        $detectedType = null;
        if (function_exists('exif_imagetype')) {
            $detectedType = @exif_imagetype($file['tmp_name']);
        } elseif (function_exists('getimagesize')) {
            $info = @getimagesize($file['tmp_name']);
            $detectedType = $info[2] ?? null;
        } else {
            $extMap = [
                'jpg' => IMAGETYPE_JPEG, 'jpeg' => IMAGETYPE_JPEG,
                'png' => IMAGETYPE_PNG, 'gif' => IMAGETYPE_GIF, 'webp' => IMAGETYPE_WEBP,
            ];
            $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
            $detectedType = $extMap[$ext] ?? null;
        }

        $allowedTypes = [IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_GIF, IMAGETYPE_WEBP];
        if (!in_array($detectedType, $allowedTypes, true)) {
            echo json_encode(['success' => false, 'message' => '仅支持 JPEG、PNG、GIF、WebP 格式'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $extMap = [
            IMAGETYPE_JPEG => 'jpg',
            IMAGETYPE_PNG => 'png',
            IMAGETYPE_GIF => 'gif',
            IMAGETYPE_WEBP => 'webp',
        ];
        $ext = $extMap[$detectedType];

        $dir = __DIR__ . '/../data/badge_images';
        if (!is_dir($dir)) {
            mkdir($dir, 0755, true);
        }

        $fileName = 'badge_' . $clubId . '_' . $country . '_' . bin2hex(random_bytes(6)) . '.' . $ext;
        $destPath = $dir . '/' . $fileName;
        if (!move_uploaded_file($file['tmp_name'], $destPath)) {
            echo json_encode(['success' => false, 'message' => '文件保存失败'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        logAction('recog_badge_image_uploaded', 'recognition_badge', $clubId, ['country' => $country, 'file' => $fileName]);

        echo json_encode([
            'success' => true,
            'message' => '徽章图片上传成功',
            'image_url' => 'data/badge_images/' . $fileName,
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    default:
        echo json_encode(['success' => false, 'message' => '未知动作'], JSON_UNESCAPED_UNICODE);
        exit;
}
