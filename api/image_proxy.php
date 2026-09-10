<?php
// api/image_proxy.php - Bangumi / VNDB 图片服务端代理
// 解决：第三方图片 CDN 在 HTTPS 页面、CORS 和 html2canvas 导出时不稳定。
// 方案：服务端抓取允许列表中的图片，通过本站同源输出。

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

$url = $_GET['url'] ?? '';

// 安全校验：只允许 Bangumi / VNDB / CnGal 的图片 CDN。
// Bangumi: lain.bgm.tv/pic/... 或 lain.bgm.tv/r/400/pic/...
// VNDB:    t.vndb.org/cv/...、t.vndb.org/v/... 等图片路径
// CnGal:   tucang.cngal.top/api/image/show/...、image.cngal.org/images/... 等
$parts = parse_url($url);
$host = strtolower((string)($parts['host'] ?? ''));
$path = (string)($parts['path'] ?? '');
$isBangumiImage = $host === 'lain.bgm.tv' && preg_match('#^/(r/\d+/)?pic/#i', $path);
$isVndbImage = in_array($host, ['t.vndb.org', 's.vndb.org'], true)
    && preg_match('#^/[a-z0-9._-]+(?:/[a-z0-9._-]+)*\.(?:jpe?g|png|gif|webp)$#i', $path);
$isCngalImage = ($host === 'tucang.cngal.top' && preg_match('#^/api/image/show/[a-z0-9_-]+$#i', $path))
    || ($host === 'image.cngal.org' && preg_match('#^/(?:images|upload)/[a-z0-9._/-]+$#i', $path));
if (!$isBangumiImage && !$isVndbImage && !$isCngalImage) {
    http_response_code(403);
    header('Content-Type: text/plain');
    echo 'invalid url';
    exit();
}

// 缓存目录
$cacheDir = __DIR__ . '/../data/cache/images';
if (!is_dir($cacheDir)) {
    @mkdir($cacheDir, 0755, true);
}

$cacheFile = $cacheDir . '/' . md5($url) . '.img';

// 缓存命中（24小时）
if (file_exists($cacheFile) && time() - filemtime($cacheFile) < 86400) {
    $img = file_get_contents($cacheFile);
    if ($img !== false && strlen($img) > 0) {
        outputImage($img, $cacheFile);
        exit();
    }
}

// 服务端抓取图片（先原协议，失败换协议）
$opts = [
    'http' => [
        'method' => 'GET',
        'timeout' => 10,
        'user_agent' => 'VNFest/1.0 (https://map.vnfest.top; contact@vnfest.top)',
    ],
];

$context = stream_context_create($opts);

// CnGal 的 tucang 地址有时只是一个包装器，查询字符串中带着真实的
// image.cngal.org 原图地址。优先请求包装器，失败后只回退到同样在白名单
// 内的原图，避免把任意查询参数变成 SSRF 入口。
$fetchUrls = [$url];
if ($host === 'tucang.cngal.top') {
    $wrappedOriginal = trim((string)($parts['query'] ?? ''));
    $wrappedParts = parse_url($wrappedOriginal);
    $wrappedHost = strtolower((string)($wrappedParts['host'] ?? ''));
    $wrappedPath = (string)($wrappedParts['path'] ?? '');
    if ($wrappedHost === 'image.cngal.org' && preg_match('#^/(?:images|upload)/[a-z0-9._/-]+$#i', $wrappedPath)) {
        $fetchUrls[] = $wrappedOriginal;
    }
}

$raw = false;
foreach ($fetchUrls as $fetchUrl) {
    $raw = @file_get_contents($fetchUrl, false, $context);
    if ($raw !== false && strlen($raw) > 0) break;
}

// 失败则换协议重试
if ($raw === false || strlen($raw) === 0) {
    foreach ($fetchUrls as $fetchUrl) {
        $altUrl = '';
        if (strncasecmp($fetchUrl, 'https://', 8) === 0) {
            $altUrl = 'http://' . substr($fetchUrl, 8);
        } elseif (strncasecmp($fetchUrl, 'http://', 7) === 0) {
            $altUrl = 'https://' . substr($fetchUrl, 7);
        }
        if ($altUrl !== '') {
            $raw = @file_get_contents($altUrl, false, $context);
            if ($raw !== false && strlen($raw) > 0) break;
        }
    }
}

if ($raw === false || strlen($raw) === 0) {
    // 返回过期缓存兜底
    if (file_exists($cacheFile)) {
        $cached = file_get_contents($cacheFile);
        if ($cached !== false && strlen($cached) > 0) {
            outputImage($cached, $cacheFile);
            exit();
        }
    }
    http_response_code(404);
    header('Content-Type: text/plain');
    echo 'image not found';
    exit();
}

file_put_contents($cacheFile, $raw);
outputImage($raw, $cacheFile);

function outputImage(string $data, string $cacheFile): void {
    // 从缓存文件名推断 Content-Type
    $ext = '';
    if (preg_match('/\.(\w+)\.img$/', $cacheFile, $m)) {
        $ext = strtolower($m[1]);
    } else {
        // 从图片数据 magic bytes 推断
        $header = substr($data, 0, 8);
        if (strncmp($header, "\x89PNG", 4) === 0) $ext = 'png';
        elseif (strncmp($header, "\xFF\xD8\xFF", 3) === 0) $ext = 'jpg';
        elseif (strncmp($header, 'GIF', 3) === 0) $ext = 'gif';
        elseif (strncmp($header, 'RIFF', 4) === 0) $ext = 'webp';
    }

    $mimeTypes = [
        'jpg'  => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'png'  => 'image/png',
        'gif'  => 'image/gif',
        'webp' => 'image/webp',
    ];

    $mime = $mimeTypes[$ext] ?? 'image/jpeg';

    header('Content-Type: ' . $mime);
    header('Content-Length: ' . strlen($data));
    header('Cache-Control: public, max-age=86400');
    header('ETag: "' . md5($data) . '"');

    // 条件请求
    if (isset($_SERVER['HTTP_IF_NONE_MATCH']) && trim($_SERVER['HTTP_IF_NONE_MATCH'], '"') === md5($data)) {
        http_response_code(304);
        exit();
    }

    echo $data;
}
