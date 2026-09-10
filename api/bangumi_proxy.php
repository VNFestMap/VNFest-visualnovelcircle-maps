<?php
// api/bangumi_proxy.php - Bangumi API 代理（参考版风格：简单透传 + 缓存）
// 核心原则：不配置 SSL context（用 PHP 默认值），直接透传 API 返回的 image_url

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

$action = $_GET['action'] ?? '';

// 缓存目录
$cacheDir = __DIR__ . '/../data/cache/bangumi';
if (!is_dir($cacheDir)) {
    @mkdir($cacheDir, 0755, true);
}

/**
 * 带缓存的 Bangumi API 请求（参考版风格）
 * - 不设 SSL context，依赖 PHP 默认配置
 * - 失败时返回空数组，降级到过期缓存
 * - 支持 GET/POST
 */
function bgmFetch(string $url, string $cacheKey, int $ttl, ?array $postBody = null): array
{
    global $cacheDir;

    $cacheFile = $cacheDir . '/' . $cacheKey . '.json';

    // 命中缓存
    if (file_exists($cacheFile) && time() - filemtime($cacheFile) < $ttl) {
        $cached = json_decode(file_get_contents($cacheFile), true);
        if (is_array($cached)) {
            return $cached;
        }
    }

    $method = $postBody ? 'POST' : 'GET';
    $httpOpts = [
        'method' => $method,
        'timeout' => 10,
        'user_agent' => 'VNFest/1.0 (https://map.vnfest.top; contact@vnfest.top)',
        'ignore_errors' => true,
    ];

    $headers = [];
    if ($postBody) {
        $headers[] = 'Content-Type: application/json';
        $httpOpts['content'] = json_encode($postBody, JSON_UNESCAPED_UNICODE);
    }
    if (!empty($headers)) {
        $httpOpts['header'] = implode("\r\n", $headers) . "\r\n";
    }

    // 不设 ssl context — 依赖 PHP 默认配置（与参考版一致）
    $context = stream_context_create(['http' => $httpOpts]);
    $raw = @file_get_contents($url, false, $context);

    if ($raw === false) {
        // 降级到过期缓存
        if (file_exists($cacheFile)) {
            $cached = json_decode(file_get_contents($cacheFile), true);
            if (is_array($cached)) return $cached;
        }
        return [];
    }

    $data = json_decode($raw, true);
    if (!is_array($data)) {
        // JSON 解析失败，降级到过期缓存
        if (file_exists($cacheFile)) {
            $cached = json_decode(file_get_contents($cacheFile), true);
            if (is_array($cached)) return $cached;
        }
        return [];
    }

    file_put_contents($cacheFile, json_encode($data, JSON_UNESCAPED_UNICODE));
    return $data;
}

/** 安全截断字符串 */
function cutText(string $text, int $len): string {
    return function_exists('mb_substr') ? mb_substr($text, 0, $len) : substr($text, 0, $len);
}

/** 从 item 中提取图片 URL，通过服务端代理输出（绕过 CDN HTTPS 限制） */
function bgmImage(array $item): string {
    $imgs = $item['images'] ?? [];
    $url = $imgs['medium'] ?? $imgs['large'] ?? $imgs['small'] ?? $imgs['grid'] ?? $imgs['common'] ?? '';
    if ($url === '') return '';
    return '/api/image_proxy.php?url=' . urlencode($url);
}

/** 将 Bangumi infobox 中的字符串、数组或对象值统一展开为文本 */
function bgmValueTexts($value): array {
    if (is_string($value) || is_numeric($value)) {
        $text = trim((string)$value);
        return $text === '' ? [] : [$text];
    }
    if (!is_array($value)) return [];

    $texts = [];
    // v0 infobox values may be objects with one of these display fields.
    foreach (['value', 'v', 'name_cn', 'name'] as $key) {
        if (array_key_exists($key, $value)) {
            $texts = array_merge($texts, bgmValueTexts($value[$key]));
        }
    }
    if (!$texts) {
        foreach ($value as $part) {
            $texts = array_merge($texts, bgmValueTexts($part));
        }
    }
    return array_values(array_unique(array_filter(array_map('trim', $texts))));
}

/** 从角色详情/搜索结果的 infobox 中提取 CV */
function extractCharacterCv(array $item): string {
    $infobox = $item['infobox'] ?? [];
    if (!is_array($infobox)) return '';

    $names = [];
    foreach ($infobox as $entry) {
        if (!is_array($entry)) continue;
        $key = trim((string)($entry['key'] ?? ''));
        if (!preg_match('/^(?:CV|声优|配音)$/iu', $key)) continue;
        $names = array_merge($names, bgmValueTexts($entry['value'] ?? ''));
    }
    return implode('、', array_values(array_unique(array_filter($names))));
}

/** 查询角色关联的声优，兼容 Bangumi v0 persons 返回数组/分页对象 */
function fetchCharacterVoiceActors(int $characterId): array {
    if ($characterId <= 0) return [];
    $data = bgmFetch(
        'https://api.bgm.tv/v0/characters/' . $characterId . '/persons',
        'char_persons_' . $characterId,
        86400
    );
    $people = isset($data['data']) && is_array($data['data']) ? $data['data'] : $data;
    if (!is_array($people)) return [];

    $names = [];
    foreach ($people as $person) {
        if (!is_array($person)) continue;
        $type = $person['type'] ?? null;
        if ($type !== null && (int)$type !== 1) continue;
        $name = trim((string)($person['name'] ?? $person['name_cn'] ?? ''));
        if ($name !== '') $names[] = $name;
    }
    return array_values(array_unique($names));
}

/** 标准化角色数据 */
function normalizeCharacter(array $item): array {
    $imgs = $item['images'] ?? [];
    $rawUrl = $imgs['medium'] ?? $imgs['large'] ?? $imgs['small'] ?? $imgs['grid'] ?? $imgs['common'] ?? '';
    return [
        'character_id'  => (int)($item['id'] ?? 0),
        'name'          => $item['name'] ?? '',
        'name_cn'       => $item['name_cn'] ?? '',
        'image_url'     => bgmImage($item),
        'image_url_raw' => $rawUrl,
        'summary'       => cutText($item['summary'] ?? '', 240),
        'cv'            => extractCharacterCv($item),
        'relation'      => $item['relation'] ?? '',
        'type'          => $item['type'] ?? '',
    ];
}

// =========================================================
//  Action 路由
// =========================================================

// ===== 搜索作品（旧版 GET API） =====
if ($action === 'search' || $action === 'search_subject') {
    $keyword = trim($_GET['keyword'] ?? '');
    $type = (int)($_GET['type'] ?? 4);

    if ($keyword === '') {
        echo json_encode(['success' => false, 'message' => '请输入关键词']);
        exit();
    }

    $data = bgmFetch(
        'https://api.bgm.tv/search/subject/' . urlencode($keyword) . '?type=' . $type . '&responseGroup=large',
        'search_v2_' . md5(strtolower($keyword) . '_' . $type),
        3600
    );

    $items = $data['list'] ?? [];
    $results = [];
    foreach ($items as $item) {
        if (!is_array($item)) continue;
        $rating = $item['rating'] ?? [];
        $results[] = [
            'bangumi_id' => (int)$item['id'],
            'title'      => $item['name'] ?? '',
            'title_cn'   => $item['name_cn'] ?? '',
            'image_url'  => bgmImage($item),
            'rating'     => $rating['score'] ?? $item['score'] ?? 0,
            'summary'    => cutText($item['summary'] ?? '', 200),
            'air_date'   => $item['air_date'] ?? '',
        ];
    }

    echo json_encode(['success' => true, 'data' => $results], JSON_UNESCAPED_UNICODE);
    exit();
}

// ===== 搜索角色（POST） =====
if ($action === 'search_character') {
    $keyword = trim($_GET['keyword'] ?? '');
    $limit = max(1, min(50, (int)($_GET['limit'] ?? 20)));
    $offset = max(0, (int)($_GET['offset'] ?? 0));

    if ($keyword === '') {
        echo json_encode(['success' => false, 'message' => '请输入角色关键词']);
        exit();
    }

    $data = bgmFetch(
        'https://api.bgm.tv/v0/search/characters?limit=' . $limit . '&offset=' . $offset,
        'character_search_v0_' . md5(strtolower($keyword) . '_' . $limit . '_' . $offset),
        3600,
        ['keyword' => $keyword, 'filter' => ['nsfw' => true]]
    );

    $rows = $data['data'] ?? [];
    $results = [];
    $detailCount = 0;
    $voiceLookupCount = 0;

    foreach ($rows as $item) {
        if (!is_array($item)) continue;
        $normalized = normalizeCharacter($item);

        // v0 角色搜索结果不含 images，从详情补全（最多 5 次）
        if (empty($normalized['image_url']) && !empty($normalized['character_id']) && $detailCount < 5) {
            $detail = bgmFetch(
                'https://api.bgm.tv/v0/characters/' . $normalized['character_id'],
                'char_' . $normalized['character_id'],
                86400
            );
            $detailCount++;
            if (!empty($detail['images'])) {
                $normalized['image_url'] = bgmImage($detail);
                $imgs = $detail['images'];
                $normalized['image_url_raw'] = $imgs['medium'] ?? $imgs['large'] ?? $imgs['small'] ?? $imgs['grid'] ?? $imgs['common'] ?? '';
            }
        }

        // Some search responses omit the infobox CV. Fill a bounded number
        // of rows from /persons so one search does not fan out indefinitely.
        if ($normalized['cv'] === '' && !empty($normalized['character_id']) && $voiceLookupCount < 8) {
            $voiceActors = fetchCharacterVoiceActors((int)$normalized['character_id']);
            $voiceLookupCount++;
            if ($voiceActors) $normalized['cv'] = implode('、', $voiceActors);
        }

        $results[] = $normalized;
    }

    echo json_encode([
        'success' => true,
        'total'   => (int)($data['total'] ?? count($results)),
        'data'    => $results,
    ], JSON_UNESCAPED_UNICODE);
    exit();
}

// ===== 获取作品角色列表 =====
if ($action === 'subject_characters') {
    $subjectId = (int)($_GET['subject_id'] ?? $_GET['id'] ?? 0);
    if ($subjectId <= 0) {
        echo json_encode(['success' => false, 'message' => '无效作品 ID']);
        exit();
    }

    $data = bgmFetch(
        'https://api.bgm.tv/v0/subjects/' . $subjectId . '/characters',
        'subj_chars_' . $subjectId,
        86400
    );

    $results = [];
    foreach ($data as $item) {
        if (!is_array($item)) continue;
        $character = $item['character'] ?? $item;
        if (!is_array($character)) continue;
        $normalized = normalizeCharacter($character);
        $normalized['relation'] = $item['relation'] ?? ($normalized['relation'] ?? '');
        $results[] = $normalized;
    }

    echo json_encode(['success' => true, 'data' => $results], JSON_UNESCAPED_UNICODE);
    exit();
}

// ===== 获取角色详情 =====
if ($action === 'get_character') {
    $id = (int)($_GET['id'] ?? $_GET['character_id'] ?? 0);
    if ($id <= 0) {
        echo json_encode(['success' => false, 'message' => '无效角色 ID']);
        exit();
    }

    $data = bgmFetch(
        'https://api.bgm.tv/v0/characters/' . $id,
        'char_' . $id,
        86400
    );

    $cv = extractCharacterCv($data);
    if ($cv === '') {
        $cv = implode('、', fetchCharacterVoiceActors($id));
    }
    if ($cv !== '') $data['cv'] = $cv;

    echo json_encode(['success' => true, 'data' => $data], JSON_UNESCAPED_UNICODE);
    exit();
}

// ===== 获取角色声优 =====
if ($action === 'character_persons') {
    $id = (int)($_GET['id'] ?? $_GET['character_id'] ?? 0);
    if ($id <= 0) {
        echo json_encode(['success' => false, 'message' => '无效角色 ID']);
        exit();
    }

    $names = fetchCharacterVoiceActors($id);
    echo json_encode([
        'success' => true,
        'data' => [
            'cv' => implode('、', $names),
            'names' => $names,
        ],
    ], JSON_UNESCAPED_UNICODE);
    exit();
}

// ===== 获取条目详情 =====
if ($action === 'get') {
    $id = (int)($_GET['id'] ?? 0);
    if ($id <= 0) {
        echo json_encode(['success' => false, 'message' => '无效 ID']);
        exit();
    }

    $data = bgmFetch(
        'https://api.bgm.tv/v0/subjects/' . $id,
        'subject_' . $id,
        86400
    );

    // 回退旧版 API
    if (empty($data)) {
        $data = bgmFetch(
            'https://api.bgm.tv/subject/' . $id . '?responseGroup=large',
            'subject_' . $id . '_v0',
            86400
        );
    }

    echo json_encode(['success' => true, 'data' => $data], JSON_UNESCAPED_UNICODE);
    exit();
}

// ===== 诊断：Bangumi API 连通性 =====
if ($action === 'ping') {
    $start = microtime(true);
    $data = bgmFetch(
        'https://api.bgm.tv/v0/characters/1',
        '_ping_char_1',
        30
    );
    $elapsed = round((microtime(true) - $start) * 1000);

    echo json_encode([
        'success'          => !empty($data),
        'bangumi_reachable' => !empty($data),
        'elapsed_ms'       => $elapsed,
        'php_allow_url_fopen' => (bool)ini_get('allow_url_fopen'),
    ], JSON_UNESCAPED_UNICODE);
    exit();
}

// ===== 诊断：缓存状态 =====
if ($action === 'debug') {
    $cacheFiles = glob($cacheDir . '/*.json');
    $cacheInfo = [];
    foreach (($cacheFiles ?: []) as $f) {
        $cacheInfo[basename($f)] = [
            'size'  => filesize($f),
            'mtime' => date('Y-m-d H:i:s', filemtime($f)),
            'age_s' => time() - filemtime($f),
        ];
    }
    echo json_encode([
        'success'            => true,
        'cache_dir'          => $cacheDir,
        'cache_dir_exists'   => is_dir($cacheDir),
        'cache_dir_writable' => is_writable($cacheDir),
        'cache_files_count'  => count($cacheInfo),
        'cache_files'        => $cacheInfo,
        'php_allow_url_fopen' => (bool)ini_get('allow_url_fopen'),
    ], JSON_UNESCAPED_UNICODE);
    exit();
}

echo json_encode(['success' => false, 'message' => '未知操作 action=' . $action]);
