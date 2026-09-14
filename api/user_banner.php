<?php
declare(strict_types=1);

// 个人空间装饰横幅上传：multipart image → uploads/banners/{Y/m}/ → users.banner_url
require_once __DIR__ . '/../includes/posts/helpers.php';

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function bannerJson(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

try {
    postsRequireMethod('POST');
    postsRequireSameOrigin();
    $user = getCurrentUser() ?: bannerJson(['success' => false, 'error' => ['code' => 'login_required', 'message' => '请先登录']], 401);
    postsRequireSpaceAccess($user);
    $db = postsDb();

    if (strtolower(trim((string)($_GET['action'] ?? 'upload'))) === 'remove') {
        $db->prepare("UPDATE users SET banner_url = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?")->execute([(int)$user['id']]);
        postsAudit('posts.banner.remove', (int)$user['id']);
        bannerJson(['success' => true, 'data' => ['banner_url' => '', 'message' => '已移除横幅']]);
    }

    checkRateLimit('posts:banner', 15, 10);
    $file = $_FILES['image'] ?? null;
    if (!is_array($file) || !isset($file['tmp_name']) || !is_uploaded_file((string)$file['tmp_name'])) {
        bannerJson(['success' => false, 'error' => ['code' => 'invalid_upload', 'message' => '请选择要上传的图片']], 422);
    }
    if ((int)($file['error'] ?? UPLOAD_ERR_OK) !== UPLOAD_ERR_OK) {
        bannerJson(['success' => false, 'error' => ['code' => 'invalid_upload', 'message' => '图片上传失败']], 422);
    }
    if ((int)($file['size'] ?? 0) <= 0 || (int)$file['size'] > POSTS_IMAGE_MAX_BYTES) {
        bannerJson(['success' => false, 'error' => ['code' => 'invalid_upload', 'message' => '图片大小必须不超过 10MB']], 422);
    }
    $info = @getimagesize((string)$file['tmp_name']);
    if (!$info || empty($info['mime'])) {
        bannerJson(['success' => false, 'error' => ['code' => 'invalid_upload', 'message' => '文件不是有效图片']], 422);
    }
    $allowed = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp'];
    $mime = strtolower((string)$info['mime']);
    if (!isset($allowed[$mime])) {
        bannerJson(['success' => false, 'error' => ['code' => 'invalid_upload', 'message' => '仅支持 JPG、PNG、GIF 或 WebP 图片']], 422);
    }

    $relativeDir = 'uploads/banners/' . date('Y/m');
    $absoluteDir = postsProjectRoot() . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativeDir);
    if (!is_dir($absoluteDir) && !mkdir($absoluteDir, 0755, true) && !is_dir($absoluteDir)) {
        bannerJson(['success' => false, 'error' => ['code' => 'upload_failed', 'message' => '无法创建图片目录']], 500);
    }
    $filename = bin2hex(random_bytes(20)) . '.' . $allowed[$mime];
    $relativePath = $relativeDir . '/' . $filename;
    $absolutePath = postsProjectRoot() . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativePath);
    if (!move_uploaded_file((string)$file['tmp_name'], $absolutePath)) {
        bannerJson(['success' => false, 'error' => ['code' => 'upload_failed', 'message' => '无法保存图片']], 500);
    }

    try {
        $db->prepare('UPDATE users SET banner_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            ->execute(['/' . $relativePath, (int)$user['id']]);
    } catch (Throwable $e) {
        @unlink($absolutePath);
        throw $e;
    }
    postsAudit('posts.banner.upload', (int)$user['id']);
    bannerJson([
        'success' => true,
        'data' => [
            'banner_url' => '/' . $relativePath,
            'message' => '横幅已更新',
        ],
    ]);
} catch (Throwable $e) {
    error_log('[user_banner] ' . $e->getMessage());
    bannerJson(['success' => false, 'error' => ['code' => 'banner_unavailable', 'message' => '横幅上传失败，请稍后重试']], 500);
}
