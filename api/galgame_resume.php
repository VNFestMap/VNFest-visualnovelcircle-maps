<?php
// api/galgame_resume.php - 登录用户的 Galgame 履历读写接口
// 动作: load, save, reset

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit();
}

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/rate_limit.php';

const GALGAME_RESUME_MAX_BYTES = 10485760; // 10 MiB
const GALGAME_RESUME_SCHEMA_VERSION = 1;

function galgameResumeRespond(array $payload, int $status = 200): void {
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit();
}

function galgameResumeFail(string $message, int $status = 400): void {
    galgameResumeRespond(['success' => false, 'message' => $message], $status);
}

/**
 * 浏览器的同源 JSON POST 必须带 Origin/Referer，且 authority 要与当前请求一致。
 * 这样即使会话 Cookie 被浏览器自动携带，跨站页面也不能替用户保存或重置履历。
 */
function galgameResumeIsSameOrigin(): bool {
    $source = trim((string)($_SERVER['HTTP_ORIGIN'] ?? ''));
    if ($source === '') {
        $source = trim((string)($_SERVER['HTTP_REFERER'] ?? ''));
    }
    if ($source === '' || $source === 'null') {
        return false;
    }

    $parts = parse_url($source);
    if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
        return false;
    }

    $requestScheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    if (!empty($_SERVER['HTTP_X_FORWARDED_PROTO'])) {
        $requestScheme = strtolower(trim(explode(',', (string)$_SERVER['HTTP_X_FORWARDED_PROTO'])[0]));
    }
    $requestHost = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    $sourceHost = strtolower((string)$parts['host']);
    $sourcePort = isset($parts['port']) ? (int)$parts['port'] : null;
    $requestPort = null;
    if (strpos($requestHost, ':') !== false) {
        [$requestHost, $port] = explode(':', $requestHost, 2);
        $requestPort = (int)$port;
    }

    $defaultPort = static function (string $scheme): int {
        return strtolower($scheme) === 'https' ? 443 : 80;
    };
    $sourcePort = $sourcePort ?? $defaultPort((string)$parts['scheme']);
    $requestPort = $requestPort ?? $defaultPort($requestScheme);

    return strtolower((string)$parts['scheme']) === strtolower($requestScheme)
        && $sourceHost === $requestHost
        && $sourcePort === $requestPort;
}

function galgameResumeString($value, int $maxBytes = 240): string {
    if ($value === null) {
        return '';
    }
    if (!is_scalar($value)) {
        return '';
    }
    $value = trim((string)$value);
    if (strlen($value) > $maxBytes) {
        if (function_exists('mb_substr')) {
            return mb_substr($value, 0, $maxBytes, 'UTF-8');
        }
        return substr($value, 0, $maxBytes);
    }
    return $value;
}

function galgameResumeList($value, int $maxItems = 40, int $maxBytes = 240): array {
    if (!is_array($value)) {
        return [];
    }
    $result = [];
    foreach ($value as $item) {
        if (count($result) >= $maxItems) {
            break;
        }
        if (is_array($item) && isset($item['title'])) {
            $item = $item['title'];
        }
        if (!is_scalar($item)) {
            continue;
        }
        $item = galgameResumeString($item, $maxBytes);
        if ($item !== '') {
            $result[] = $item;
        }
    }
    return $result;
}

function galgameResumeImage($value, int $maxBytes = 8388608): string {
    $image = galgameResumeString($value, $maxBytes);
    if ($image === '') {
        return '';
    }
    // 只允许当前履历实际使用的图片来源，避免把可执行协议保存进后续 innerHTML。
    if (preg_match('/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+\/=\s]+$/i', $image)) {
        return $image;
    }
    if (preg_match('/^(?:https?:\/\/|\/|\.\/|\.\.\/)[^\s<>"\']+$/i', $image)) {
        return $image;
    }
    return '';
}

function galgameResumeItems($value, int $maxItems = 30): array {
    if (!is_array($value)) {
        return [];
    }
    $result = [];
    foreach ($value as $item) {
        if (count($result) >= $maxItems) {
            break;
        }
        if (is_scalar($item)) {
            $title = galgameResumeString($item, 240);
            if ($title !== '') {
                $result[] = ['title' => $title, 'image' => '', 'source' => 'custom', 'id' => '', 'cv' => ''];
            }
            continue;
        }
        if (!is_array($item)) {
            continue;
        }
        $title = galgameResumeString($item['title'] ?? '', 240);
        if ($title === '') {
            continue;
        }
        $cleanItem = [
            'title' => $title,
            'image' => galgameResumeImage($item['image'] ?? ''),
            'source' => galgameResumeString($item['source'] ?? 'custom', 32),
            'id' => galgameResumeString($item['id'] ?? '', 120),
            'cv' => galgameResumeString($item['cv'] ?? '', 240),
        ];
        $bangumiId = (int)($item['bangumiId'] ?? $item['bangumi_id'] ?? 0);
        if ($bangumiId > 0) {
            $cleanItem['bangumiId'] = $bangumiId;
        }
        $result[] = $cleanItem;
    }
    return $result;
}

function galgameResumeSections($value): array {
    if (!is_array($value)) {
        return [];
    }
    $result = [];
    foreach ($value as $section) {
        if (!is_array($section) || count($result) >= 30) {
            continue;
        }
        $id = galgameResumeString($section['id'] ?? '', 40);
        $type = galgameResumeString($section['type'] ?? '', 40);
        if ($id === '' || $type === '') {
            continue;
        }
        $entry = [
            'id' => $id,
            'type' => $type,
            'label' => galgameResumeString($section['label'] ?? '', 120),
            'span' => max(1, min(2, (int)($section['span'] ?? 1))),
        ];
        if (isset($section['field'])) {
            $entry['field'] = galgameResumeString($section['field'], 40);
        }
        if (isset($section['searchType'])) {
            $entry['searchType'] = galgameResumeString($section['searchType'], 40);
        }
        $result[] = $entry;
    }
    return $result;
}

function galgameResumeSanitize(array $resume): array {
    $profile = is_array($resume['profile'] ?? null) ? $resume['profile'] : [];
    $cleanProfile = [
        'name' => galgameResumeString($profile['name'] ?? '', 240),
        'handle' => galgameResumeString($profile['handle'] ?? '', 120),
        'accountType' => in_array(($profile['accountType'] ?? 'bgm'), ['x', 'bgm', 'bilibili', 'discord', 'qq'], true)
            ? $profile['accountType'] : 'bgm',
        'avatar' => galgameResumeImage($profile['avatar'] ?? ''),
        'avatarShape' => ($profile['avatarShape'] ?? 'square') === 'circle' ? 'circle' : 'square',
        'avatarPosX' => max(0, min(100, (int)($profile['avatarPosX'] ?? 50))),
        'avatarPosY' => max(0, min(100, (int)($profile['avatarPosY'] ?? 50))),
        'genres' => galgameResumeList($profile['genres'] ?? [], 20, 80),
        'brands' => galgameResumeList($profile['brands'] ?? [], 40, 240),
        'works' => galgameResumeItems($profile['works'] ?? [], 30),
        'heroines' => galgameResumeItems($profile['heroines'] ?? [], 30),
        'historyYears' => galgameResumeString($profile['historyYears'] ?? '', 80),
        'playCount' => galgameResumeString($profile['playCount'] ?? '0', 40),
        'voiceActors' => galgameResumeList($profile['voiceActors'] ?? [], 40, 240),
        'artists' => galgameResumeList($profile['artists'] ?? [], 40, 240),
        'writers' => galgameResumeList($profile['writers'] ?? [], 40, 240),
        'songs' => galgameResumeList($profile['songs'] ?? [], 40, 240),
        'attributes' => galgameResumeList($profile['attributes'] ?? [], 40, 120),
        'other' => galgameResumeString($profile['other'] ?? '', 4000),
    ];

    $clean = [
        'schema_version' => GALGAME_RESUME_SCHEMA_VERSION,
        'mode' => ($resume['mode'] ?? 'resume') === 'card' ? 'card' : 'resume',
        'moreItems' => !empty($resume['moreItems']),
        'popupEnabled' => array_key_exists('popupEnabled', $resume) ? !empty($resume['popupEnabled']) : true,
        'enabledApis' => [],
        'profile' => $cleanProfile,
        'sections' => galgameResumeSections($resume['sections'] ?? []),
    ];

    if (is_array($resume['enabledApis'] ?? null)) {
        foreach ($resume['enabledApis'] as $api) {
            if (in_array($api, ['bangumi', 'vndb'], true) && !in_array($api, $clean['enabledApis'], true)) {
                $clean['enabledApis'][] = $api;
            }
        }
    }
    if (!$clean['enabledApis']) {
        $clean['enabledApis'] = ['bangumi', 'vndb'];
    }
    return $clean;
}

function galgameResumeReadPayload(): array {
    $contentLength = isset($_SERVER['CONTENT_LENGTH']) ? (int)$_SERVER['CONTENT_LENGTH'] : 0;
    if ($contentLength > GALGAME_RESUME_MAX_BYTES) {
        galgameResumeFail('履历数据不能超过 10 MiB', 413);
    }
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        galgameResumeFail('请求内容为空');
    }
    if (strlen($raw) > GALGAME_RESUME_MAX_BYTES) {
        galgameResumeFail('履历数据不能超过 10 MiB', 413);
    }
    try {
        $payload = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    } catch (Throwable $error) {
        galgameResumeFail('请求必须是有效的 JSON');
    }
    if (!is_array($payload) || !is_array($payload['resume'] ?? null)) {
        galgameResumeFail('缺少有效的 resume 履历对象');
    }
    return $payload['resume'];
}

function galgameResumeEncoded(array $resume): string {
    try {
        $encoded = json_encode(
            galgameResumeSanitize($resume),
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
        );
    } catch (Throwable $error) {
        galgameResumeFail('履历内容无法保存');
    }
    if (strlen($encoded) > GALGAME_RESUME_MAX_BYTES) {
        galgameResumeFail('履历数据不能超过 10 MiB', 413);
    }
    return $encoded;
}

$action = strtolower(trim((string)($_GET['action'] ?? '')));
$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));

if ($action === 'load') {
    if ($method !== 'GET') {
        galgameResumeFail('load 仅支持 GET 请求', 405);
    }
    $user = requireLogin();
    try {
        $stmt = getDB()->prepare(
            'SELECT payload, schema_version, updated_at FROM galgame_resumes WHERE user_id = ? LIMIT 1'
        );
        $stmt->execute([(int)$user['id']]);
        $row = $stmt->fetch();
        if (!$row) {
            galgameResumeRespond(['success' => true, 'resume' => null, 'updated_at' => null]);
        }
        $resume = json_decode((string)$row['payload'], true);
        if (!is_array($resume)) {
            galgameResumeFail('服务器履历数据损坏，请重置后重新保存', 500);
        }
        galgameResumeRespond([
            'success' => true,
            'resume' => $resume,
            'schema_version' => (int)$row['schema_version'],
            'updated_at' => $row['updated_at'],
        ]);
    } catch (Throwable $error) {
        galgameResumeFail('暂时无法读取服务器履历', 500);
    }
}

if (!in_array($action, ['save', 'reset'], true)) {
    galgameResumeFail('不支持的操作', 400);
}
if ($method !== 'POST') {
    galgameResumeFail($action . ' 仅支持 POST 请求', 405);
}
$user = requireLogin();
if (!galgameResumeIsSameOrigin()) {
    galgameResumeFail('请求来源校验失败', 403);
}

$userId = (int)$user['id'];

if ($action === 'reset') {
    checkRateLimit('galgame_resume_reset', 10, 1);
    try {
        $stmt = getDB()->prepare('DELETE FROM galgame_resumes WHERE user_id = ?');
        $stmt->execute([$userId]);
        galgameResumeRespond(['success' => true, 'reset' => true]);
    } catch (Throwable $error) {
        galgameResumeFail('暂时无法重置服务器履历', 500);
    }
}

checkRateLimit('galgame_resume_save', 60, 1);
$encoded = galgameResumeEncoded(galgameResumeReadPayload());

try {
    $db = getDB();
    $db->beginTransaction();
    $existing = $db->prepare('SELECT user_id FROM galgame_resumes WHERE user_id = ? LIMIT 1');
    $existing->execute([$userId]);
    if ($existing->fetch()) {
        $stmt = $db->prepare(
            'UPDATE galgame_resumes
             SET payload = ?, schema_version = ?, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ?'
        );
        $stmt->execute([$encoded, (string)GALGAME_RESUME_SCHEMA_VERSION, $userId]);
    } else {
        $stmt = $db->prepare(
            'INSERT INTO galgame_resumes
             (user_id, payload, schema_version, created_at, updated_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'
        );
        $stmt->execute([$userId, $encoded, (string)GALGAME_RESUME_SCHEMA_VERSION]);
    }
    $db->commit();

    $updated = $db->prepare('SELECT updated_at FROM galgame_resumes WHERE user_id = ? LIMIT 1');
    $updated->execute([$userId]);
    $row = $updated->fetch();
    galgameResumeRespond([
        'success' => true,
        'saved' => true,
        'schema_version' => GALGAME_RESUME_SCHEMA_VERSION,
        'updated_at' => $row['updated_at'] ?? null,
    ]);
} catch (Throwable $error) {
    if (isset($db) && $db instanceof PDO && $db->inTransaction()) {
        $db->rollBack();
    }
    galgameResumeFail('暂时无法保存服务器履历', 500);
}
