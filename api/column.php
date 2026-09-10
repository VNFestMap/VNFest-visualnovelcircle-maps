<?php
declare(strict_types=1);

require_once __DIR__ . '/../includes/column/helpers.php';

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function columnAudit(string $action, ?int $targetId = null, array $details = []): void
{
    try {
        logAction($action, 'column_document', $targetId, $details);
    } catch (Throwable $e) {
        error_log('column audit failed: ' . $e->getMessage());
    }
}

function columnRequireUser(?array $user): array
{
    if (!$user) columnFail('login_required', '请先登录', 401);
    return $user;
}

function columnRequireAdmin(?array $user): array
{
    $user = columnRequireUser($user);
    if (!columnCanManage($user)) columnFail('permission_denied', '无权执行此操作', 403);
    return $user;
}

function columnQueryType(array $query): ?string
{
    $type = strtolower(trim((string)($query['type'] ?? '')));
    if ($type === '') return null;
    if (!array_key_exists($type, COLUMN_ARTICLE_TYPES)) columnFail('invalid_type', '文章类型无效', 422);
    return $type;
}

function columnListDocuments(array $query, ?array $user, string $scope = 'public'): array
{
    $db = columnDb();
    [$page, $perPage, $offset] = columnPagination($query);
    $where = ['1 = 1'];
    $params = [];

    if ($scope === 'public') {
        $where[] = "d.status = 'published'";
        $where[] = 'd.deleted_at IS NULL';
    } elseif ($scope === 'mine') {
        $user = columnRequireUser($user);
        $where[] = 'd.author_id = ?';
        $params[] = (int)$user['id'];
    } elseif ($scope === 'admin') {
        columnRequireAdmin($user);
        $status = strtolower(trim((string)($query['status'] ?? '')));
        if ($status !== '') {
            if (!in_array($status, COLUMN_STATUSES, true)) columnFail('invalid_status', '文章状态无效', 422);
            $where[] = 'd.status = ?';
            $params[] = $status;
        }
    }

    $keyword = trim((string)($query['q'] ?? ''));
    if ($keyword !== '') {
        $keyword = columnString($keyword, 100);
        $like = '%' . $keyword . '%';
        $where[] = '(d.title LIKE ? OR d.summary LIKE ? OR d.body_text LIKE ? OR u.username LIKE ? OR u.nickname LIKE ?)';
        array_push($params, $like, $like, $like, $like, $like);
    }
    $type = columnQueryType($query);
    if ($type !== null) {
        $where[] = 'd.type = ?';
        $params[] = $type;
    }

    $whereSql = implode(' AND ', $where);
    $count = $db->prepare("SELECT COUNT(*) FROM column_documents d JOIN users u ON u.id = d.author_id WHERE {$whereSql}");
    $count->execute($params);
    $total = (int)$count->fetchColumn();

    if ($scope === 'public') {
        $order = 'CASE WHEN d.featured_rank IS NULL THEN 1 ELSE 0 END ASC, d.featured_rank ASC, d.published_at DESC, d.id DESC';
    } else {
        $order = 'd.updated_at DESC, d.id DESC';
    }
    $sql = columnBaseSelect() . " WHERE {$whereSql} ORDER BY {$order} LIMIT {$perPage} OFFSET {$offset}";
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    $articles = array_map(
        static fn(array $row): array => columnSerializeArticle($row, $user, false),
        $stmt->fetchAll(PDO::FETCH_ASSOC)
    );

    return [
        'articles' => $articles,
        'total' => $total,
        'page' => $page,
        'per_page' => $perPage,
        'pages' => $total > 0 ? (int)ceil($total / $perPage) : 0,
    ];
}

function columnRelatedDocuments(array $article, ?array $user = null): array
{
    $db = columnDb();
    $stmt = $db->prepare(
        columnBaseSelect() .
        " WHERE d.status = 'published' AND d.deleted_at IS NULL AND d.type = ? AND d.id <> ?
          ORDER BY d.published_at DESC, d.id DESC LIMIT 4"
    );
    $stmt->execute([(string)$article['type'], (int)$article['id']]);
    return array_map(
        static fn(array $row): array => columnSerializeArticle($row, $user, false),
        $stmt->fetchAll(PDO::FETCH_ASSOC)
    );
}

function columnWalineServerUrl(): string
{
    $value = defined('COLUMN_WALINE_SERVER_URL') ? (string)constant('COLUMN_WALINE_SERVER_URL') : (string)(getenv('COLUMN_WALINE_SERVER_URL') ?: '');
    $value = trim($value);
    if ($value === '' || preg_match('/^https?:\/\/[^\s]+$/i', $value) || preg_match('#^/[a-zA-Z0-9/_-]*$#', $value)) return $value;
    return '';
}

function columnWalineAdminUrl(): string
{
    $serverUrl = columnWalineServerUrl();
    return $serverUrl === '' ? '' : rtrim($serverUrl, '/') . '/ui';
}

function columnSaveDocument(PDO $db, array $user, array $input, string $targetStatus): array
{
    if (!in_array($targetStatus, ['draft', 'published'], true)) columnFail('invalid_status', '文章状态无效', 422);
    $id = max(0, (int)($input['id'] ?? 0));
    $existing = $id > 0 ? columnFetchDocument($id) : null;
    if ($id > 0 && !$existing) columnFail('not_found', '文章不存在', 404);
    if ($existing && !columnArticleCanEdit($existing, $user)) columnFail('permission_denied', '只能编辑自己的文章', 403);

    $merged = $input;
    if ($existing) {
        foreach (['title', 'summary', 'type', 'body_markdown', 'cover_path'] as $key) {
            if (!array_key_exists($key, $merged)) $merged[$key] = $existing[$key] ?? '';
        }
    }
    $payload = columnInputPayload($merged);
    $club = [
        'club_id' => $existing['club_id'] ?? null,
        'club_country' => $existing['club_country'] ?? null,
    ];
    if (array_key_exists('club_membership_id', $input)) {
        $club = columnResolveClubSelection($db, (int)$user['id'], $input['club_membership_id']);
    }
    $uploadToken = trim((string)($input['upload_token'] ?? ''));
    $now = date('Y-m-d H:i:s');
    $publishedAt = $targetStatus === 'published'
        ? (($existing['published_at'] ?? null) ?: $now)
        : null;
    $pathKey = $existing['path_key'] ?? null;

    $db->beginTransaction();
    try {
        if ($existing) {
            $stmt = $db->prepare(
                'UPDATE column_documents
                 SET club_id=?,club_country=?,type=?,title=?,summary=?,body_markdown=?,body_html=?,body_text=?,toc_json=?,cover_path=?,read_minutes=?,status=?,published_at=?,updated_at=?,deleted_at=NULL
                 WHERE id=?'
            );
            $stmt->execute([
                $club['club_id'], $club['club_country'], $payload['type'], $payload['title'], $payload['summary'],
                $payload['body_markdown'], $payload['body_html'], $payload['body_text'], $payload['toc_json'],
                $payload['cover_path'], $payload['read_minutes'], $targetStatus, $publishedAt, $now, $id,
            ]);
            $documentId = $id;
        } else {
            $stmt = $db->prepare(
                'INSERT INTO column_documents
                 (path_key,author_id,club_id,club_country,type,title,summary,body_markdown,body_html,body_text,toc_json,cover_path,read_minutes,status,featured_rank,published_at,created_at,updated_at,deleted_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
            );
            $stmt->execute([
                null, (int)$user['id'], $club['club_id'], $club['club_country'], $payload['type'], $payload['title'],
                $payload['summary'], $payload['body_markdown'], $payload['body_html'], $payload['body_text'],
                $payload['toc_json'], $payload['cover_path'], $payload['read_minutes'], $targetStatus, null,
                $publishedAt, $now, $now, null,
            ]);
            $documentId = (int)$db->lastInsertId();
        }

        if ($targetStatus === 'published' && $pathKey === null) {
            $pathKey = 'a-' . columnBase36($documentId);
            $db->prepare('UPDATE column_documents SET path_key=? WHERE id=?')->execute([$pathKey, $documentId]);
        }
        columnAttachmentPaths($db, (int)$user['id'], $documentId, $payload['body_markdown'], $payload['cover_path'], $uploadToken);
        $revision = $db->prepare(
            'INSERT INTO column_document_revisions
             (document_id,editor_id,title,summary,body_markdown,body_html,body_text,toc_json,status,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)'
        );
        $revision->execute([
            $documentId, (int)$user['id'], $payload['title'], $payload['summary'], $payload['body_markdown'],
            $payload['body_html'], $payload['body_text'], $payload['toc_json'], $targetStatus, $now,
        ]);
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }

    $row = columnFetchDocument($documentId);
    if (!$row) columnFail('save_failed', '文章保存后无法读取', 500);
    columnAudit($existing ? 'column.document.update' : 'column.document.create', $documentId, ['status' => $targetStatus]);
    return columnSerializeArticle($row, $user, true, true);
}

function columnUploadImage(PDO $db, array $user): never
{
    checkRateLimit('column:upload', 40, 10);
    $file = $_FILES['image'] ?? null;
    if (!is_array($file) || !isset($file['tmp_name']) || !is_uploaded_file((string)$file['tmp_name'])) columnFail('invalid_upload', '请选择要上传的图片', 422);
    if ((int)($file['error'] ?? UPLOAD_ERR_OK) !== UPLOAD_ERR_OK) columnFail('invalid_upload', '图片上传失败', 422);
    if ((int)($file['size'] ?? 0) <= 0 || (int)$file['size'] > COLUMN_IMAGE_MAX_BYTES) columnFail('invalid_upload', '图片大小必须不超过 10MB', 422);
    $info = @getimagesize((string)$file['tmp_name']);
    if (!$info || empty($info['mime'])) columnFail('invalid_upload', '文件不是有效图片', 422);
    $width = (int)($info[0] ?? 0);
    $height = (int)($info[1] ?? 0);
    if ($width < 1 || $height < 1 || $width > COLUMN_IMAGE_MAX_DIMENSION || $height > COLUMN_IMAGE_MAX_DIMENSION || $width * $height > COLUMN_IMAGE_MAX_PIXELS) columnFail('invalid_upload', '图片尺寸过大', 422);
    $allowed = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp'];
    $mime = strtolower((string)$info['mime']);
    if (!isset($allowed[$mime])) columnFail('invalid_upload', '仅支持 JPG、PNG、GIF 或 WebP 图片', 422);
    $token = trim((string)($_POST['upload_token'] ?? ''));
    if ($token === '') $token = 'column-' . bin2hex(random_bytes(12));
    if (!preg_match('/^[a-zA-Z0-9_-]{8,64}$/', $token)) columnFail('invalid_upload_token', '上传标识无效', 422);
    $countStmt = $db->prepare('SELECT COUNT(*) FROM column_attachments WHERE uploader_id=? AND upload_token=? AND document_id IS NULL');
    $countStmt->execute([(int)$user['id'], $token]);
    if ((int)$countStmt->fetchColumn() >= COLUMN_IMAGE_MAX_COUNT) columnFail('upload_limit', '单次编辑最多上传 30 张图片', 422);

    $relativeDir = 'uploads/column/' . date('Y/m');
    $absoluteDir = columnProjectRoot() . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativeDir);
    if (!is_dir($absoluteDir) && !mkdir($absoluteDir, 0755, true) && !is_dir($absoluteDir)) columnFail('upload_failed', '无法创建图片目录', 500);
    $filename = bin2hex(random_bytes(20)) . '.' . $allowed[$mime];
    $relativePath = $relativeDir . '/' . $filename;
    $absolutePath = columnProjectRoot() . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativePath);
    if (!move_uploaded_file((string)$file['tmp_name'], $absolutePath)) columnFail('upload_failed', '无法保存图片', 500);
    try {
        $stmt = $db->prepare(
            'INSERT INTO column_attachments
             (uploader_id,document_id,upload_token,relative_path,mime_type,width,height,file_size,original_name,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)'
        );
        $stmt->execute([
            (int)$user['id'], null, $token, $relativePath, $mime, $width, $height,
            (int)$file['size'], columnSlice((string)($file['name'] ?? ''), 255), date('Y-m-d H:i:s'),
        ]);
    } catch (Throwable $e) {
        @unlink($absolutePath);
        throw $e;
    }
    $attachmentId = (int)$db->lastInsertId();
    columnAudit('column.attachment.upload', $attachmentId, ['mime_type' => $mime]);
    columnJson([
        'success' => true,
        'data' => [
            'upload_token' => $token,
            'attachment' => [
                'id' => $attachmentId,
                'relative_path' => $relativePath,
                'url' => '/' . $relativePath,
                'alt' => (string)($file['name'] ?? '文章配图'),
                'width' => $width,
                'height' => $height,
            ],
        ],
    ]);
}

function columnDeleteUpload(PDO $db, array $user, array $input): never
{
    checkRateLimit('column:upload_delete', 40, 10);
    $id = max(0, (int)($input['id'] ?? $input['attachment_id'] ?? 0));
    $stmt = $db->prepare('SELECT id,relative_path FROM column_attachments WHERE id=? AND uploader_id=? AND document_id IS NULL LIMIT 1');
    $stmt->execute([$id, (int)$user['id']]);
    $attachment = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$attachment) columnFail('not_found', '图片不存在或已经绑定文章', 404);
    $base = realpath(columnProjectRoot() . '/uploads/column');
    $path = realpath(columnProjectRoot() . '/' . $attachment['relative_path']);
    if (!$base || !$path || !str_starts_with($path, $base . DIRECTORY_SEPARATOR)) columnFail('invalid_upload', '图片路径无效', 500);
    $db->prepare('DELETE FROM column_attachments WHERE id=? AND uploader_id=? AND document_id IS NULL')->execute([$id, (int)$user['id']]);
    @unlink($path);
    columnAudit('column.attachment.delete', $id);
    columnJson(['success' => true, 'data' => ['message' => '图片已删除']]);
}

function columnModerateDocument(PDO $db, array $user, array $input): never
{
    columnRequireAdmin($user);
    $id = max(0, (int)($input['id'] ?? 0));
    $row = columnFetchDocument($id);
    if (!$row) columnFail('not_found', '文章不存在', 404);
    $status = strtolower(trim((string)($input['status'] ?? $row['status'])));
    if (!in_array($status, COLUMN_STATUSES, true)) columnFail('invalid_status', '文章状态无效', 422);
    $rank = array_key_exists('featured_rank', $input) && $input['featured_rank'] !== ''
        ? max(0, (int)$input['featured_rank']) : null;
    $now = date('Y-m-d H:i:s');
    $publishedAt = $status === 'published' ? (($row['published_at'] ?? null) ?: $now) : null;
    $deletedAt = $status === 'deleted' ? (($row['deleted_at'] ?? null) ?: $now) : null;
    $pathKey = $row['path_key'];
    if ($status === 'published' && $pathKey === null) $pathKey = 'a-' . columnBase36($id);
    $db->prepare('UPDATE column_documents SET path_key=?,status=?,featured_rank=?,published_at=?,updated_at=?,deleted_at=? WHERE id=?')
        ->execute([$pathKey, $status, $rank, $publishedAt, $now, $deletedAt, $id]);
    columnAudit('column.document.moderate', $id, ['status' => $status, 'featured_rank' => $rank]);
    columnJson(['success' => true, 'data' => ['message' => '文章状态已更新']]);
}

function columnSetFeatured(PDO $db, array $user, array $input): never
{
    columnRequireAdmin($user);
    $id = max(0, (int)($input['id'] ?? 0));
    if (!columnFetchDocument($id)) columnFail('not_found', '文章不存在', 404);
    $rank = array_key_exists('featured_rank', $input) && $input['featured_rank'] !== ''
        ? max(0, (int)$input['featured_rank']) : null;
    $now = date('Y-m-d H:i:s');
    $db->prepare('UPDATE column_documents SET featured_rank=?,updated_at=? WHERE id=?')->execute([$rank, $now, $id]);
    columnAudit('column.document.featured', $id, ['featured_rank' => $rank]);
    columnJson(['success' => true, 'data' => ['message' => '精选顺序已更新']]);
}

try {
    $input = columnInput();
    $action = strtolower(trim((string)($_GET['action'] ?? $input['action'] ?? 'bootstrap')));
    $db = columnDb();
    $currentUser = getCurrentUser();

    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
        if ($action === 'bootstrap') {
            columnJson([
                'success' => true,
                'data' => [
                    'user' => columnUserPayload($currentUser),
                    'types' => array_map(static fn(string $value, string $label): array => ['value' => $value, 'label' => $label], array_keys(COLUMN_ARTICLE_TYPES), COLUMN_ARTICLE_TYPES),
                    'clubs' => $currentUser ? columnSelectableClubs((int)$currentUser['id']) : [],
                    'waline' => ['server_url' => columnWalineServerUrl(), 'admin_url' => columnWalineAdminUrl(), 'login' => 'force'],
                ],
            ]);
        }
        if ($action === 'feed') columnJson(['success' => true, 'data' => columnListDocuments($_GET, $currentUser, 'public')]);
        if ($action === 'article') {
            $pathKey = trim((string)($_GET['path_key'] ?? ''));
            $row = columnFetchDocumentByPath($pathKey);
            if (!columnArticleStatusVisible($row, $currentUser)) columnFail('not_found', '文章不存在或暂不可见', 404);
            columnJson([
                'success' => true,
                'data' => [
                    'article' => columnSerializeArticle($row, $currentUser, true, true),
                    'related' => columnRelatedDocuments($row, $currentUser),
                    'waline' => ['server_url' => columnWalineServerUrl(), 'path' => '/column/article/' . $pathKey . '/', 'admin_url' => columnWalineAdminUrl()],
                ],
            ]);
        }
        if ($action === 'mine') {
            if (isset($_GET['id']) && (int)$_GET['id'] > 0) {
                $user = columnRequireUser($currentUser);
                $row = columnFetchDocument((int)$_GET['id']);
                if (!$row || ((int)$row['author_id'] !== (int)$user['id'] && !columnCanManage($user))) columnFail('not_found', '文章不存在', 404);
                columnJson(['success' => true, 'data' => ['article' => columnSerializeArticle($row, $user, true, true)]]);
            }
            columnJson(['success' => true, 'data' => columnListDocuments($_GET, $currentUser, 'mine')]);
        }
        if ($action === 'admin') columnJson(['success' => true, 'data' => columnListDocuments($_GET, $currentUser, 'admin')]);
        columnFail('unknown_action', '未知操作', 400);
    }

    columnRequireMethod('POST');
    columnRequireSameOrigin();
    $user = columnRequireUser($currentUser);

    if ($action === 'save_draft') {
        checkRateLimit('column:document_save', 30, 10);
        columnJson(['success' => true, 'data' => ['article' => columnSaveDocument($db, $user, $input, 'draft'), 'message' => '草稿已保存']]);
    }
    if ($action === 'publish') {
        checkRateLimit('column:document_publish', 20, 10);
        columnJson(['success' => true, 'data' => ['article' => columnSaveDocument($db, $user, $input, 'published'), 'message' => '文章已发布']]);
    }
    if ($action === 'update') {
        checkRateLimit('column:document_update', 30, 10);
        $id = max(0, (int)($input['id'] ?? 0));
        $row = columnFetchDocument($id);
        if (!$row || !columnArticleCanEdit($row, $user)) columnFail('permission_denied', '无权编辑这篇文章', 403);
        $status = $row['status'] === 'published' ? 'published' : 'draft';
        columnJson(['success' => true, 'data' => ['article' => columnSaveDocument($db, $user, $input, $status), 'message' => '文章已更新']]);
    }
    if ($action === 'withdraw') {
        checkRateLimit('column:document_withdraw', 20, 10);
        $id = max(0, (int)($input['id'] ?? 0));
        $row = columnFetchDocument($id);
        if (!$row || !columnArticleCanEdit($row, $user)) columnFail('permission_denied', '无权操作这篇文章', 403);
        if ($row['status'] !== 'published') columnFail('invalid_status', '当前文章不是已发布状态', 409);
        $now = date('Y-m-d H:i:s');
        $db->prepare("UPDATE column_documents SET status='draft',published_at=NULL,updated_at=?,deleted_at=NULL WHERE id=?")->execute([$now, $id]);
        columnAudit('column.document.withdraw', $id);
        columnJson(['success' => true, 'data' => ['message' => '文章已撤回']]);
    }
    if ($action === 'delete') {
        checkRateLimit('column:document_delete', 20, 10);
        $id = max(0, (int)($input['id'] ?? 0));
        $row = columnFetchDocument($id);
        if (!$row || !columnArticleCanEdit($row, $user)) columnFail('permission_denied', '无权删除这篇文章', 403);
        $now = date('Y-m-d H:i:s');
        $db->prepare("UPDATE column_documents SET status='deleted',deleted_at=?,updated_at=? WHERE id=?")->execute([$now, $now, $id]);
        columnAudit('column.document.delete', $id);
        columnJson(['success' => true, 'data' => ['message' => '文章已移入回收状态']]);
    }
    if ($action === 'moderate_article') columnModerateDocument($db, $user, $input);
    if ($action === 'set_featured') columnSetFeatured($db, $user, $input);
    if ($action === 'upload_image') columnUploadImage($db, $user);
    if ($action === 'delete_upload') columnDeleteUpload($db, $user, $input);
    columnFail('unknown_action', '未知操作', 400);
} catch (Throwable $e) {
    error_log('[column] ' . $e->getMessage());
    if ($e instanceof PDOException) columnFail('database_unavailable', '数据库暂时不可用，请稍后重试', 500);
    if (str_contains($e->getMessage(), 'league/commonmark')) columnFail('dependency_missing', '文章解析服务尚未就绪，请稍后重试', 503);
    columnFail('column_unavailable', '专栏操作失败，请稍后重试', 500);
}
