<?php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/image_host.php';

$dataFile = __DIR__ . '/../data/publication_previews.json';
$uploadRoot = __DIR__ . '/../uploads/publication_previews';

function previewRespond(array $payload, int $status = 200): void {
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit();
}

function previewNow(): string {
    return date('Y-m-d H:i:s');
}

function previewCleanString($value, int $limit = 500): string {
    $value = trim((string)($value ?? ''));
    $value = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/u', '', $value);
    if (function_exists('mb_substr')) {
        return mb_substr($value, 0, $limit, 'UTF-8');
    }
    return substr($value, 0, $limit);
}

function previewLoadAll(): array {
    global $dataFile;
    if (!is_file($dataFile)) {
        return ['previews' => []];
    }
    $json = json_decode((string)file_get_contents($dataFile), true);
    if (!is_array($json)) {
        return ['previews' => []];
    }
    if (!isset($json['previews']) || !is_array($json['previews'])) {
        $json['previews'] = [];
    }
    return $json;
}

function previewSaveAll(array $data): void {
    global $dataFile;
    $dir = dirname($dataFile);
    if (!is_dir($dir)) {
        mkdir($dir, 0755, true);
    }
    file_put_contents($dataFile, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));
}

function previewFindIndex(array $rows, int $id): int {
    foreach ($rows as $i => $row) {
        if ((int)($row['id'] ?? 0) === $id) {
            return $i;
        }
    }
    return -1;
}

function previewNormalizeClubIds($clubIds): array {
    if (!is_array($clubIds)) {
        return [];
    }
    $out = [];
    foreach ($clubIds as $club) {
        if (!is_array($club)) {
            continue;
        }
        $id = max(0, (int)($club['id'] ?? $club['club_id'] ?? 0));
        if ($id <= 0) {
            continue;
        }
        $country = previewCleanString($club['country'] ?? 'china', 20);
        $out[] = ['id' => $id, 'country' => $country ?: 'china'];
    }
    return $out;
}

function previewDefaultReaderSettings(): array {
    return [
        'page_size' => [
            'preset' => 'a4',
            'width_mm' => 210,
            'height_mm' => 297,
            'orientation' => 'portrait',
        ],
        'theme' => 'wiki',
        'fit_mode' => 'fit-page',
        'flip_sound' => true,
    ];
}

function previewReaderBackgrounds(): array {
    $dir = realpath(__DIR__ . '/../tools/pdf-reader/vendor/pdfReader/images/background');
    $base = realpath(__DIR__ . '/..');
    if (!$dir || !$base || strncmp($dir, $base, strlen($base)) !== 0 || !is_dir($dir)) {
        return [];
    }

    $items = scandir($dir) ?: [];
    $backgrounds = [];
    foreach ($items as $item) {
        if ($item === '.' || $item === '..') {
            continue;
        }
        $path = $dir . DIRECTORY_SEPARATOR . $item;
        if (!is_file($path)) {
            continue;
        }
        $ext = strtolower(pathinfo($item, PATHINFO_EXTENSION));
        if (!in_array($ext, ['jpg', 'jpeg', 'png', 'webp', 'gif'], true)) {
            continue;
        }
        $name = pathinfo($item, PATHINFO_FILENAME);
        $backgrounds[] = [
            'id' => $item,
            'name' => $name,
            'path' => 'tools/pdf-reader/vendor/pdfReader/images/background/' . rawurlencode($item),
        ];
    }
    usort($backgrounds, fn($a, $b) => strnatcasecmp($a['name'], $b['name']));
    return $backgrounds;
}

function previewPageSizePresets(): array {
    return [
        'a4' => [210, 297],
        'b5' => [176, 250],
        'a5' => [148, 210],
        'square' => [210, 210],
    ];
}

function previewNormalizeReaderSettings($settings): array {
    $defaults = previewDefaultReaderSettings();
    if (!is_array($settings)) {
        return $defaults;
    }

    $pageSize = is_array($settings['page_size'] ?? null) ? $settings['page_size'] : [];
    $preset = strtolower(previewCleanString($pageSize['preset'] ?? $defaults['page_size']['preset'], 20));
    $presets = previewPageSizePresets();
    if (!isset($presets[$preset]) && $preset !== 'custom') {
        $preset = 'a4';
    }

    $orientation = strtolower(previewCleanString($pageSize['orientation'] ?? $defaults['page_size']['orientation'], 20));
    if (!in_array($orientation, ['portrait', 'landscape'], true)) {
        $orientation = 'portrait';
    }

    if ($preset === 'custom') {
        $width = (float)($pageSize['width_mm'] ?? 0);
        $height = (float)($pageSize['height_mm'] ?? 0);
        if ($width <= 0 || $height <= 0) {
            $preset = 'a4';
            [$width, $height] = $presets[$preset];
        }
    } else {
        [$width, $height] = $presets[$preset];
    }

    if ($orientation === 'landscape' && $height > $width) {
        [$width, $height] = [$height, $width];
    }
    if ($orientation === 'portrait' && $width > $height) {
        [$width, $height] = [$height, $width];
    }

    $theme = strtolower(previewCleanString($settings['theme'] ?? $defaults['theme'], 20));
    if (!in_array($theme, ['wiki', 'dark', 'warm'], true)) {
        $theme = $defaults['theme'];
    }

    $fitMode = strtolower(previewCleanString($settings['fit_mode'] ?? $defaults['fit_mode'], 20));
    if (!in_array($fitMode, ['fit-page', 'fit-width'], true)) {
        $fitMode = $defaults['fit_mode'];
    }

    return [
        'page_size' => [
            'preset' => $preset,
            'width_mm' => round($width, 2),
            'height_mm' => round($height, 2),
            'orientation' => $orientation,
        ],
        'theme' => $theme,
        'fit_mode' => $fitMode,
        'flip_sound' => filter_var($settings['flip_sound'] ?? $defaults['flip_sound'], FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE) ?? $defaults['flip_sound'],
    ];
}

function previewUserCanManageClubs(array $user, array $clubIds): bool {
    if (!$clubIds) {
        return false;
    }
    if (($user['role'] ?? '') === 'super_admin') {
        return true;
    }
    foreach ($clubIds as $club) {
        if (canManageClubInCountry($user, (int)$club['id'], (string)($club['country'] ?? 'china'))) {
            return true;
        }
    }
    return false;
}

function previewPublicRow(array $row): array {
    return [
        'id' => (int)($row['id'] ?? 0),
        'title' => $row['title'] ?? '',
        'club_ids' => $row['club_ids'] ?? [],
        'description' => $row['description'] ?? '',
        'cover_path' => $row['cover_path'] ?? '',
        'page_count' => (int)($row['page_count'] ?? 0),
        'pages_base_path' => $row['pages_base_path'] ?? '',
        'created_by_name' => $row['created_by_name'] ?? '',
        'created_at' => $row['created_at'] ?? '',
        'updated_at' => $row['updated_at'] ?? '',
        'status' => $row['status'] ?? 'uploading',
    ];
}

function previewManageRow(array $row, array $user): array {
    $public = previewPublicRow($row);
    $public['can_delete'] = ($public['status'] !== 'deleted') && previewUserCanManageClubs($user, previewNormalizeClubIds($row['club_ids'] ?? []));
    return $public;
}

function previewPageDir(int $id): string {
    global $uploadRoot;
    return $uploadRoot . DIRECTORY_SEPARATOR . $id . DIRECTORY_SEPARATOR . 'pages';
}

function previewPageBasePath(int $id): string {
    return 'uploads/publication_previews/' . $id . '/pages/';
}

function previewRemoveDir(string $dir): void {
    $base = realpath(__DIR__ . '/../uploads/publication_previews');
    $path = realpath($dir);
    if (!$base || !$path || strncmp($path, $base, strlen($base)) !== 0) {
        return;
    }
    $items = scandir($path);
    if (!$items) {
        return;
    }
    foreach ($items as $item) {
        if ($item === '.' || $item === '..') {
            continue;
        }
        $full = $path . DIRECTORY_SEPARATOR . $item;
        if (is_dir($full)) {
            previewRemoveDir($full);
        } elseif (is_file($full)) {
            unlink($full);
        }
    }
    rmdir($path);
}

$action = $_GET['action'] ?? $_POST['action'] ?? 'list';

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    if ($action === 'backgrounds') {
        previewRespond(['success' => true, 'backgrounds' => previewReaderBackgrounds()]);
    }

    $data = previewLoadAll();

    if ($action === 'manage_list') {
        $user = requireLogin();
        $rows = $data['previews'];
        if (($user['role'] ?? '') !== 'super_admin') {
            $rows = array_values(array_filter($rows, fn($row) => previewUserCanManageClubs($user, previewNormalizeClubIds($row['club_ids'] ?? []))));
        }
        usort($rows, fn($a, $b) => strcmp((string)($b['updated_at'] ?? ''), (string)($a['updated_at'] ?? '')));
        previewRespond(['success' => true, 'previews' => array_map(fn($row) => previewManageRow($row, $user), $rows)]);
    }

    $active = array_values(array_filter($data['previews'], fn($row) => ($row['status'] ?? '') === 'active'));

    if ($action === 'list') {
        usort($active, fn($a, $b) => strcmp((string)($b['updated_at'] ?? ''), (string)($a['updated_at'] ?? '')));
        previewRespond(['success' => true, 'previews' => array_map('previewPublicRow', $active)]);
    }

    if ($action === 'detail' || $action === 'book_data') {
        $id = max(0, (int)($_GET['id'] ?? $_GET['preview_id'] ?? 0));
        $match = null;
        foreach ($active as $row) {
            if ((int)($row['id'] ?? 0) === $id) {
                $match = $row;
                break;
            }
        }
        if (!$match) {
            previewRespond(['success' => false, 'message' => '预览不存在或尚未发布'], 404);
        }
        $public = previewPublicRow($match);
        if ($action === 'book_data') {
            $pages = [];
            $count = (int)($public['page_count'] ?? 0);
            $storedPages = is_array($match['page_urls'] ?? null) ? $match['page_urls'] : [];
            for ($i = 1; $i <= $count; $i++) {
                $pages[] = trim((string)($storedPages[$i - 1] ?? '')) ?: ($public['pages_base_path'] . $i . '.jpg');
            }
            $public['pages'] = $pages;
            $public['toc'] = array_map(fn($page) => ['caption' => '第 ' . $page . ' 页', 'page' => (string)$page], range(1, max(1, $count)));
            $public['reader_settings'] = previewNormalizeReaderSettings($match['reader_settings'] ?? null);
        }
        previewRespond(['success' => true, 'preview' => $public]);
    }

    previewRespond(['success' => false, 'message' => '未知 action'], 400);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    previewRespond(['success' => false, 'message' => '不支持的请求方法'], 405);
}

$user = requireLogin();
$input = [];
$contentType = $_SERVER['CONTENT_TYPE'] ?? '';
if (stripos($contentType, 'application/json') !== false) {
    $input = json_decode((string)file_get_contents('php://input'), true);
    if (!is_array($input)) {
        $input = [];
    }
} else {
    $input = $_POST;
}
$action = $input['action'] ?? $action;

if ($action === 'create') {
    $clubIds = previewNormalizeClubIds($input['club_ids'] ?? []);
    if (!previewUserCanManageClubs($user, $clubIds)) {
        previewRespond(['success' => false, 'message' => '权限不足，无法为该同好会发布刊物预览'], 403);
    }

    $data = previewLoadAll();
    $maxId = 0;
    foreach ($data['previews'] as $row) {
        $maxId = max($maxId, (int)($row['id'] ?? 0));
    }
    $id = $maxId + 1;
    $title = previewCleanString($input['title'] ?? '', 120);
    if ($title === '') {
        previewRespond(['success' => false, 'message' => '请填写刊物标题'], 400);
    }

    $row = [
        'id' => $id,
        'title' => $title,
        'club_ids' => $clubIds,
        'description' => previewCleanString($input['description'] ?? '', 2000),
        'reader_settings' => previewNormalizeReaderSettings($input['reader_settings'] ?? null),
        'cover_path' => '',
        'page_count' => 0,
        'pages_base_path' => previewPageBasePath($id),
        'page_urls' => [],
        'page_local_paths' => [],
        'created_by' => (int)$user['id'],
        'created_by_name' => $user['nickname'] ?: ($user['username'] ?? ''),
        'created_at' => previewNow(),
        'updated_at' => previewNow(),
        'status' => 'uploading',
    ];
    $dir = previewPageDir($id);
    if (!is_dir($dir)) {
        mkdir($dir, 0755, true);
    }
    $data['previews'][] = $row;
    previewSaveAll($data);
    previewRespond(['success' => true, 'preview' => previewPublicRow($row)]);
}

$data = previewLoadAll();
$previewId = max(0, (int)($input['preview_id'] ?? $input['id'] ?? 0));
$idx = previewFindIndex($data['previews'], $previewId);
if ($idx < 0) {
    previewRespond(['success' => false, 'message' => '预览不存在'], 404);
}
$row = $data['previews'][$idx];
if (!previewUserCanManageClubs($user, previewNormalizeClubIds($row['club_ids'] ?? []))) {
    previewRespond(['success' => false, 'message' => '权限不足'], 403);
}

if ($action === 'upload_page') {
    $page = max(1, (int)($input['page'] ?? 0));
    if (empty($_FILES['image']) || !is_uploaded_file($_FILES['image']['tmp_name'])) {
        previewRespond(['success' => false, 'message' => '缺少页面图片'], 400);
    }
    $info = @getimagesize($_FILES['image']['tmp_name']);
    $mime = $info['mime'] ?? '';
    if ($mime !== 'image/jpeg') {
        previewRespond(['success' => false, 'message' => '页面图片必须是 JPG'], 400);
    }
    $dir = previewPageDir($previewId);
    if (!is_dir($dir)) {
        mkdir($dir, 0755, true);
    }
    $fileName = 'page_' . $page . '_' . date('YmdHis') . '_' . bin2hex(random_bytes(4)) . '.jpg';
    $dest = $dir . DIRECTORY_SEPARATOR . $fileName;
    $localUrl = previewPageBasePath($previewId) . $fileName;
    $stored = imageHostStoreUploadedFile(
        $_FILES['image']['tmp_name'],
        $dest,
        $localUrl,
        (string)($_FILES['image']['name'] ?? ($page . '.jpg')),
        'publication_preview:' . $previewId . ':' . $page,
        'image/jpeg'
    );
    if (!$stored['ok']) {
        previewRespond(['success' => false, 'message' => $stored['error'] ?? '保存页面失败'], 500);
    }
    $data['previews'][$idx]['page_urls'] = is_array($data['previews'][$idx]['page_urls'] ?? null)
        ? $data['previews'][$idx]['page_urls'] : [];
    $data['previews'][$idx]['page_local_paths'] = is_array($data['previews'][$idx]['page_local_paths'] ?? null)
        ? $data['previews'][$idx]['page_local_paths'] : [];
    $data['previews'][$idx]['page_urls'][$page - 1] = $stored['url'];
    $data['previews'][$idx]['page_local_paths'][$page - 1] = $localUrl;
    $data['previews'][$idx]['page_count'] = max((int)($row['page_count'] ?? 0), $page);
    $data['previews'][$idx]['cover_path'] = $data['previews'][$idx]['page_urls'][0] ?? $data['previews'][$idx]['cover_path'];
    $data['previews'][$idx]['updated_at'] = previewNow();
    $data['previews'][$idx]['status'] = 'uploading';
    previewSaveAll($data);
    previewRespond(['success' => true, 'page' => $page]);
}

if ($action === 'publish') {
    $pageCount = max(0, (int)($input['page_count'] ?? $row['page_count'] ?? 0));
    if ($pageCount < 1) {
        previewRespond(['success' => false, 'message' => '页数无效'], 400);
    }
    $dir = previewPageDir($previewId);
    $pageUrls = is_array($row['page_urls'] ?? null) ? $row['page_urls'] : [];
    $pageLocalPaths = is_array($row['page_local_paths'] ?? null) ? $row['page_local_paths'] : [];
    for ($i = 1; $i <= $pageCount; $i++) {
        $localRelative = (string)($pageLocalPaths[$i - 1] ?? '');
        $localAbsolute = $localRelative !== '' ? dirname(__DIR__) . '/' . ltrim($localRelative, '/') : '';
        if (!is_file($localAbsolute) && trim((string)($pageUrls[$i - 1] ?? '')) === '' && !is_file($dir . DIRECTORY_SEPARATOR . $i . '.jpg')) {
            previewRespond(['success' => false, 'message' => '第 ' . $i . ' 页尚未上传'], 400);
        }
    }
    $data['previews'][$idx]['page_count'] = $pageCount;
    $data['previews'][$idx]['cover_path'] = $pageUrls[0] ?? ($data['previews'][$idx]['cover_path'] ?: previewPageBasePath($previewId) . '1.jpg');
    $data['previews'][$idx]['pages_base_path'] = previewPageBasePath($previewId);
    $data['previews'][$idx]['status'] = 'active';
    $data['previews'][$idx]['updated_at'] = previewNow();
    previewSaveAll($data);
    previewRespond(['success' => true, 'preview' => previewPublicRow($data['previews'][$idx])]);
}

if ($action === 'delete') {
    $data['previews'][$idx]['status'] = 'deleted';
    $data['previews'][$idx]['updated_at'] = previewNow();
    previewSaveAll($data);
    // 本地图片是长期备份，删除预览记录时不删除文件。
    previewRespond(['success' => true]);
}

previewRespond(['success' => false, 'message' => '未知 action'], 400);
