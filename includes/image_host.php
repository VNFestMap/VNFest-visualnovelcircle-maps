<?php
// includes/image_host.php - 公开图片的本地备份与 picui 上传适配层

if (!defined('DB_PATH') && is_file(__DIR__ . '/../config.php')) {
    require_once __DIR__ . '/../config.php';
}

function imageHostConfig(string $name, $default = null)
{
    $env = getenv($name);
    if ($env !== false && $env !== '') {
        return $env;
    }
    if (defined($name)) {
        return constant($name);
    }
    return $default;
}

function imageHostBool($value, bool $default = false): bool
{
    if ($value === null || $value === '') {
        return $default;
    }
    return filter_var($value, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE) ?? $default;
}

function imageHostEnabled(): bool
{
    return imageHostBool(imageHostConfig('PICUI_ENABLED', false), false)
        && trim((string)imageHostConfig('PICUI_TOKEN', '')) !== ''
        && function_exists('curl_init');
}

function imageHostApiUrl(): string
{
    return rtrim((string)imageHostConfig('PICUI_API_URL', 'https://picui.cn/api/v1'), '/');
}

function imageHostTimeout(): int
{
    return max(5, min(60, (int)imageHostConfig('PICUI_TIMEOUT', 30)));
}

function imageHostAllowedHosts(): array
{
    $raw = (string)imageHostConfig('PICUI_ALLOWED_HOSTS', 'picui.cn,www.picui.cn');
    $hosts = array_values(array_filter(array_map(static function ($host) {
        return strtolower(trim((string)$host));
    }, explode(',', $raw))));
    return $hosts ?: ['picui.cn', 'www.picui.cn'];
}

function imageHostIsTrustedUrl(string $url): bool
{
    $parts = parse_url(trim($url));
    if (!is_array($parts) || !in_array(strtolower((string)($parts['scheme'] ?? '')), ['http', 'https'], true)) {
        return false;
    }
    $host = strtolower((string)($parts['host'] ?? ''));
    if ($host === '') {
        return false;
    }
    foreach (imageHostAllowedHosts() as $allowed) {
        if ($host === $allowed || str_ends_with($host, '.' . ltrim($allowed, '.'))) {
            return true;
        }
    }
    return false;
}

function imageHostMimeExtension(string $mime): ?string
{
    return [
        'image/jpeg' => 'jpg',
        'image/png' => 'png',
        'image/gif' => 'gif',
        'image/webp' => 'webp',
    ][strtolower(trim($mime))] ?? null;
}

function imageHostDetectImage(string $path): ?array
{
    if (!is_file($path)) {
        return null;
    }
    $type = function_exists('exif_imagetype') ? @exif_imagetype($path) : null;
    if (!$type && function_exists('getimagesize')) {
        $info = @getimagesize($path);
        $type = $info[2] ?? null;
    }
    $mimeByType = [
        IMAGETYPE_JPEG => 'image/jpeg',
        IMAGETYPE_PNG => 'image/png',
        IMAGETYPE_GIF => 'image/gif',
        IMAGETYPE_WEBP => 'image/webp',
    ];
    $mime = $type !== null && isset($mimeByType[$type]) ? $mimeByType[$type] : null;
    $extension = $mime ? imageHostMimeExtension($mime) : null;
    return $mime && $extension ? ['mime' => $mime, 'extension' => $extension] : null;
}

function imageHostHash(string $path): string
{
    $hash = @hash_file('sha256', $path);
    return is_string($hash) ? $hash : '';
}

function imageHostRuntimeDir(): string
{
    $root = dirname(__DIR__);
    $dir = $root . '/data/image-host';
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    return $dir;
}

function imageHostRecordPending(string $context, string $localUrl, string $localPath, string $error): void
{
    $dir = imageHostRuntimeDir();
    $file = $dir . '/pending.json';
    $rows = [];
    if (is_file($file)) {
        $decoded = json_decode((string)@file_get_contents($file), true);
        if (is_array($decoded)) {
            $rows = $decoded;
        }
    }
    $key = $localUrl . '|' . imageHostHash($localPath);
    $rows[$key] = [
        'context' => $context,
        'local_url' => $localUrl,
        'sha256' => imageHostHash($localPath),
        'size' => (int)@filesize($localPath),
        'error' => preg_replace('/[^\x20-\x7E\x{4E00}-\x{9FFF}]+/u', ' ', $error),
        'updated_at' => date('c'),
    ];
    @file_put_contents($file, json_encode($rows, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT), LOCK_EX);
}

function imageHostRemoteUpload(string $localPath, string $originalName, string $mime, string $context): array
{
    if (!imageHostEnabled()) {
        return ['ok' => false, 'error' => 'picui 未启用或 PHP cURL 不可用'];
    }

    $token = trim((string)imageHostConfig('PICUI_TOKEN', ''));
    $endpoint = imageHostApiUrl() . '/upload';
    $attempts = 0;
    $lastError = '未知错误';

    while ($attempts < 3) {
        $attempts++;
        $responseHeaders = [];
        $curl = curl_init($endpoint);
        $post = [
            'file' => curl_file_create($localPath, $mime, $originalName ?: basename($localPath)),
            'permission' => (string)(int)imageHostConfig('PICUI_PERMISSION', 1),
        ];
        curl_setopt_array($curl, [
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => [
                'Accept: application/json',
                'Authorization: Bearer ' . $token,
            ],
            CURLOPT_POSTFIELDS => $post,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => min(10, imageHostTimeout()),
            CURLOPT_TIMEOUT => imageHostTimeout(),
            CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$responseHeaders): int {
                $pos = strpos($line, ':');
                if ($pos !== false) {
                    $responseHeaders[strtolower(trim(substr($line, 0, $pos)))] = trim(substr($line, $pos + 1));
                }
                return strlen($line);
            },
        ]);
        $body = curl_exec($curl);
        $curlError = curl_error($curl);
        $httpCode = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
        curl_close($curl);

        if ($body !== false && $httpCode >= 200 && $httpCode < 300) {
            $decoded = json_decode((string)$body, true);
            $url = is_array($decoded) ? trim((string)($decoded['data']['links']['url'] ?? '')) : '';
            if (($decoded['status'] ?? false) === true && imageHostIsTrustedUrl($url)) {
                return [
                    'ok' => true,
                    'url' => $url,
                    'remote_key' => trim((string)($decoded['data']['key'] ?? '')),
                    'http_code' => $httpCode,
                ];
            }
            $message = is_array($decoded) ? trim((string)($decoded['message'] ?? $decoded['error'] ?? '')) : '';
            if (preg_match('/每小时|限流|rate[\s_-]*limit|too many requests/i', $message)) {
                $lastError = 'picui 限流';
                error_log('[VNFmap image-host] upload rate limited: context=' . preg_replace('/[^A-Za-z0-9_.:-]/', '_', $context));
                return ['ok' => false, 'error' => $lastError, 'rate_limited' => true, 'http_code' => $httpCode];
            }
            $lastError = 'picui 返回成功但缺少受信任的图片 URL';
        } elseif ($curlError !== '') {
            $lastError = 'picui 网络错误';
        } else {
            $lastError = 'picui HTTP ' . $httpCode;
        }

        $retryable = $curlError !== '' || $httpCode === 429 || $httpCode >= 500;
        if (!$retryable || $attempts >= 3) {
            break;
        }
        $retryAfter = (int)($responseHeaders['retry-after'] ?? 0);
        $delayMs = $retryAfter > 0 ? min(3000, $retryAfter * 1000) : $attempts * 500;
        usleep($delayMs * 1000);
    }

    error_log('[VNFmap image-host] upload failed: context=' . preg_replace('/[^A-Za-z0-9_.:-]/', '_', $context) . ' error=' . $lastError);
    return ['ok' => false, 'error' => $lastError];
}

/**
 * Copy the uploaded temporary file to its unique local backup and optionally
 * upload that backup to picui. The returned URL is always safe to persist.
 */
function imageHostStoreUploadedFile(
    string $sourcePath,
    string $localPath,
    string $localUrl,
    string $originalName,
    string $context,
    ?string $expectedMime = null
): array {
    $detected = imageHostDetectImage($sourcePath);
    if (!$detected) {
        return ['ok' => false, 'error' => '不是受支持的图片文件'];
    }
    if ($expectedMime !== null && imageHostMimeExtension($expectedMime) === null) {
        return ['ok' => false, 'error' => '图片 MIME 类型不受支持'];
    }

    $dir = dirname($localPath);
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
        return ['ok' => false, 'error' => '无法创建本地图片备份目录'];
    }
    if (!@copy($sourcePath, $localPath)) {
        return ['ok' => false, 'error' => '本地图片备份保存失败'];
    }

    // 本地开发或未配置 picui 时只保留本地副本，不制造待重试记录。
    if (!imageHostEnabled()) {
        return [
            'ok' => true,
            'url' => $localUrl,
            'storage' => 'local',
            'local_backup' => $localUrl,
            'remote_key' => '',
        ];
    }

    $remote = imageHostRemoteUpload($localPath, $originalName, $detected['mime'], $context);
    if ($remote['ok']) {
        return [
            'ok' => true,
            'url' => $remote['url'],
            'storage' => 'picui',
            'local_backup' => $localUrl,
            'remote_key' => $remote['remote_key'] ?? '',
        ];
    }

    imageHostRecordPending($context, $localUrl, $localPath, (string)($remote['error'] ?? 'picui 上传失败'));
    if (!imageHostBool(imageHostConfig('PICUI_FALLBACK_LOCAL', true), true)) {
        return ['ok' => false, 'error' => '图片上传失败，请稍后重试'];
    }
    return [
        'ok' => true,
        'url' => $localUrl,
        'storage' => 'local',
        'local_backup' => $localUrl,
        'remote_key' => '',
        'fallback' => true,
    ];
}
