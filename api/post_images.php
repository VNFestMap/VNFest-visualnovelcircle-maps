<?php
declare(strict_types=1);

// 动态（posts）配图上传/删除。JSON 之外的两个 multipart 动作独立成文件，
// 校验与落盘规则沿用旧专栏上传的加固措施（真实 MIME、尺寸上限、本人附件强绑定）。
require_once __DIR__ . '/../includes/posts/helpers.php';

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function postsImageJson(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

try {
    postsRequireMethod('POST');
    postsRequireSameOrigin();
    $user = getCurrentUser() ?: postsImageJson(['success' => false, 'error' => ['code' => 'login_required', 'message' => '请先登录']], 401);
    postsRequireSpaceAccess($user);
    $db = postsDb();

    if (strtolower(trim((string)($_GET['action'] ?? 'upload'))) === 'delete') {
        checkRateLimit('posts:upload_delete', 40, 10);
        $input = postsInput();
        $id = max(0, (int)($input['id'] ?? 0));
        $stmt = $db->prepare('SELECT id, relative_path FROM post_attachments WHERE id = ? AND uploader_id = ? AND post_id IS NULL LIMIT 1');
        $stmt->execute([$id, (int)$user['id']]);
        $attachment = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$attachment) postsImageJson(['success' => false, 'error' => ['code' => 'not_found', 'message' => '图片不存在或已随推文发布']], 404);
        $base = realpath(postsProjectRoot() . '/uploads/posts');
        $path = realpath(postsProjectRoot() . '/' . $attachment['relative_path']);
        if (!$base || !$path || !str_starts_with($path, $base . DIRECTORY_SEPARATOR)) postsImageJson(['success' => false, 'error' => ['code' => 'invalid_upload', 'message' => '图片路径无效']], 500);
        $db->prepare('DELETE FROM post_attachments WHERE id = ? AND uploader_id = ? AND post_id IS NULL')->execute([$id, (int)$user['id']]);
        @unlink($path);
        postsAudit('posts.attachment.delete', (int)$attachment['id']);
        postsImageJson(['success' => true, 'data' => ['message' => '图片已删除']]);
    }

    checkRateLimit('posts:upload', 40, 10);
    $file = $_FILES['image'] ?? null;
    if (!is_array($file) || !isset($file['tmp_name']) || !is_uploaded_file((string)$file['tmp_name'])) postsImageJson(['success' => false, 'error' => ['code' => 'invalid_upload', 'message' => '请选择要上传的图片']], 422);
    if ((int)($file['error'] ?? UPLOAD_ERR_OK) !== UPLOAD_ERR_OK) postsImageJson(['success' => false, 'error' => ['code' => 'invalid_upload', 'message' => '图片上传失败']], 422);
    if ((int)($file['size'] ?? 0) <= 0 || (int)$file['size'] > POSTS_IMAGE_MAX_BYTES) postsImageJson(['success' => false, 'error' => ['code' => 'invalid_upload', 'message' => '图片大小必须不超过 10MB']], 422);
    $info = @getimagesize((string)$file['tmp_name']);
    if (!$info || empty($info['mime'])) postsImageJson(['success' => false, 'error' => ['code' => 'invalid_upload', 'message' => '文件不是有效图片']], 422);
    $width = (int)($info[0] ?? 0);
    $height = (int)($info[1] ?? 0);
    if ($width < 1 || $height < 1 || $width > POSTS_IMAGE_MAX_DIMENSION || $height > POSTS_IMAGE_MAX_DIMENSION || $width * $height > POSTS_IMAGE_MAX_PIXELS) {
        postsImageJson(['success' => false, 'error' => ['code' => 'invalid_upload', 'message' => '图片尺寸过大']], 422);
    }
    $allowed = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp'];
    $mime = strtolower((string)$info['mime']);
    if (!isset($allowed[$mime])) postsImageJson(['success' => false, 'error' => ['code' => 'invalid_upload', 'message' => '仅支持 JPG、PNG、GIF 或 WebP 图片']], 422);

    $token = trim((string)($_POST['upload_token'] ?? ''));
    if ($token === '') $token = 'post-' . bin2hex(random_bytes(12));
    if (!preg_match('/^[a-zA-Z0-9_-]{8,64}$/', $token)) postsImageJson(['success' => false, 'error' => ['code' => 'invalid_upload_token', 'message' => '上传标识无效']], 422);

    $countStmt = $db->prepare('SELECT COUNT(*) FROM post_attachments WHERE uploader_id = ? AND upload_token = ? AND post_id IS NULL');
    $countStmt->execute([(int)$user['id'], $token]);
    if ((int)$countStmt->fetchColumn() >= POSTS_IMAGES_MAX * 3) {
        postsImageJson(['success' => false, 'error' => ['code' => 'upload_limit', 'message' => '本次编辑上传图片过多，请先发布或移除部分图片']], 422);
    }

    $relativeDir = 'uploads/posts/' . date('Y/m');
    $absoluteDir = postsProjectRoot() . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativeDir);
    if (!is_dir($absoluteDir) && !mkdir($absoluteDir, 0755, true) && !is_dir($absoluteDir)) {
        postsImageJson(['success' => false, 'error' => ['code' => 'upload_failed', 'message' => '无法创建图片目录']], 500);
    }
    $filename = bin2hex(random_bytes(20)) . '.' . $allowed[$mime];
    $relativePath = $relativeDir . '/' . $filename;
    $absolutePath = postsProjectRoot() . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativePath);
    if (!move_uploaded_file((string)$file['tmp_name'], $absolutePath)) {
        postsImageJson(['success' => false, 'error' => ['code' => 'upload_failed', 'message' => '无法保存图片']], 500);
    }
    try {
        $stmt = $db->prepare(
            'INSERT INTO post_attachments
             (uploader_id, post_id, upload_token, relative_path, mime_type, width, height, file_size, original_name, created_at)
             VALUES (?,NULL,?,?,?,?,?,?,?,?)'
        );
        $stmt->execute([
            (int)$user['id'], $token, $relativePath, $mime, $width, $height,
            (int)$file['size'], postsSlice((string)($file['name'] ?? ''), 255), date('Y-m-d H:i:s'),
        ]);
    } catch (Throwable $e) {
        @unlink($absolutePath);
        throw $e;
    }
    $attachmentId = (int)$db->lastInsertId();
    postsAudit('posts.attachment.upload', $attachmentId, ['mime_type' => $mime]);
    postsImageJson([
        'success' => true,
        'data' => [
            'upload_token' => $token,
            'attachment' => [
                'id' => $attachmentId,
                'relative_path' => $relativePath,
                'url' => '/' . $relativePath,
                'width' => $width,
                'height' => $height,
            ],
        ],
    ]);
} catch (Throwable $e) {
    error_log('[post_images] ' . $e->getMessage());
    postsImageJson(['success' => false, 'error' => ['code' => 'upload_unavailable', 'message' => '图片上传失败，请稍后重试']], 500);
}
