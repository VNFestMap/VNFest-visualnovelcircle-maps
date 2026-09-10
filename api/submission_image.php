<?php
// api/submission_image.php - 作品提交图片上传（参与者本人可传，随作品进入人工审核）
// 动作: upload
// 前端选图时已压缩（最长边 1600px / JPEG 0.85，GIF 原样 ≤5MB），端点只负责鉴权、类型校验与落盘。
// URL 为站点根相对路径（data/submission_images/...），随提交内容保存在 recognition_submissions。

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

$action = $_GET['action'] ?? '';

switch ($action) {
    case 'upload': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $user = requireLogin();
        checkRateLimit('submission_image_upload', 30, 1);

        if (!isset($_FILES['image']) || $_FILES['image']['error'] !== UPLOAD_ERR_OK) {
            $errMsg = $_FILES['image']['error'] ?? -1;
            echo json_encode(['success' => false, 'message' => '上传失败，错误码: ' . $errMsg], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $file = $_FILES['image'];
        // 前端已压缩，10MB 为服务端兜底（实际极限仍受 upload_max_filesize / post_max_size 约束）
        if ($file['size'] > 10 * 1024 * 1024) {
            echo json_encode(['success' => false, 'message' => '图片不能超过 10MB'], JSON_UNESCAPED_UNICODE);
            exit;
        }

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

        $dir = __DIR__ . '/../data/submission_images';
        if (!is_dir($dir)) {
            mkdir($dir, 0755, true);
        }

        $fileName = 'sub_' . (int)$user['id'] . '_' . bin2hex(random_bytes(6)) . '.' . $ext;
        $destPath = $dir . '/' . $fileName;
        if (!move_uploaded_file($file['tmp_name'], $destPath)) {
            echo json_encode(['success' => false, 'message' => '文件保存失败'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        logAction('recog_submission_image_uploaded', 'recognition_submission', (int)$user['id'], ['file' => $fileName]);

        echo json_encode([
            'success' => true,
            'message' => '图片上传成功',
            'image_url' => 'data/submission_images/' . $fileName,
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    default:
        echo json_encode(['success' => false, 'message' => '未知动作'], JSON_UNESCAPED_UNICODE);
        exit;
}
