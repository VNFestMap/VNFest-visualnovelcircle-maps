<?php
// api/galgame_meme.php - 登录用户的 Galgame MEME 看板读写接口
// 动作: load, save, reset

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit();
}

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/rate_limit.php';

const GALGAME_MEME_MAX_BYTES = 15728640; // 15 MiB
const GALGAME_MEME_SCHEMA_VERSION = 1;

function galgameMemeRespond(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit();
}

function galgameMemeFail(string $message, int $status = 400): void
{
    galgameMemeRespond(['success' => false, 'message' => $message], $status);
}

function galgameMemeString($value, int $maxBytes = 240): string
{
    if ($value === null || !is_scalar($value)) return '';
    $value = trim((string)$value);
    if (strlen($value) <= $maxBytes) return $value;
    return function_exists('mb_substr') ? mb_substr($value, 0, $maxBytes, 'UTF-8') : substr($value, 0, $maxBytes);
}

function galgameMemeImage($value): string
{
    $image = galgameMemeString($value, 12582912);
    if ($image === '') return '';
    if (preg_match('/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+\/\s=]+$/i', $image)) return $image;
    if (preg_match('/^(?:https?:\/\/|\/|\.\/|\.\.\/)[^\s<>"\']+$/i', $image)) return $image;
    return '';
}

function galgameMemeList($value, int $maxItems = 100): array
{
    if (!is_array($value)) return [];
    $items = [];
    foreach ($value as $item) {
        if (count($items) >= $maxItems || !is_array($item)) continue;
        $title = galgameMemeString($item['title'] ?? '', 240);
        if ($title === '') continue;
        $kind = (string)($item['kind'] ?? 'work');
        $source = (string)($item['source'] ?? 'custom');
        if (!in_array($kind, ['work', 'character', 'custom'], true)) $kind = 'custom';
        if (!in_array($source, ['bangumi', 'cngal', 'resume', 'custom'], true)) $source = 'custom';
        $clean = [
            'id' => galgameMemeString($item['id'] ?? '', 120),
            'kind' => $kind,
            'source' => $source,
            'sourceId' => galgameMemeString($item['sourceId'] ?? $item['source_id'] ?? '', 160),
            'title' => $title,
            'subtitle' => galgameMemeString($item['subtitle'] ?? $item['sub'] ?? '', 240),
            'image' => galgameMemeImage($item['image'] ?? $item['imageUrl'] ?? ''),
        ];
        $bangumiId = (int)($item['bangumiId'] ?? $item['bangumi_id'] ?? 0);
        if ($bangumiId > 0) $clean['bangumiId'] = $bangumiId;
        if ($clean['id'] === '') $clean['id'] = 'meme-' . substr(hash('sha256', json_encode($clean)), 0, 18);
        $items[] = $clean;
    }
    return $items;
}

function galgameMemeCells($value): array
{
    if (!is_array($value)) return [];
    $cells = [];
    foreach ($value as $cell) {
        if (count($cells) >= 120 || !is_array($cell)) continue;
        $cells[] = [
            'id' => galgameMemeString($cell['id'] ?? '', 80) ?: 'cell-' . count($cells),
            'title' => galgameMemeString($cell['title'] ?? '', 120),
            'cards' => galgameMemeList($cell['cards'] ?? [], 100),
        ];
    }
    return $cells;
}

function galgameMemeSanitize(array $value): array
{
    $board = is_array($value['board'] ?? null) ? $value['board'] : [];
    $settings = is_array($value['settings'] ?? null) ? $value['settings'] : [];
    $colsMode = ($board['colsMode'] ?? 'fixed') === 'auto' ? 'auto' : 'fixed';
    $cardSize = (string)($settings['cardSize'] ?? 'md');
    if (!in_array($cardSize, ['sm', 'md', 'lg'], true)) $cardSize = 'md';

    $safeCols = max(1, min(6, (int)($board['cols'] ?? 6)));
    $safeRows = max(1, min(30, (int)($board['rows'] ?? 4)));
    $maxRows = max(1, min(30, intdiv(120, $colsMode === 'fixed' ? $safeCols : 6)));

    return [
        'schema_version' => GALGAME_MEME_SCHEMA_VERSION,
        'board' => [
            'title' => galgameMemeString($board['title'] ?? 'Galgame MEME', 80) ?: 'Galgame MEME',
            'colsMode' => $colsMode,
            'cols' => $safeCols,
            'rows' => min($safeRows, $maxRows),
            'cells' => galgameMemeCells($board['cells'] ?? []),
            'unranked' => galgameMemeList($board['unranked'] ?? [], 100),
        ],
        'settings' => [
            'cardSize' => $cardSize,
            'showTitles' => array_key_exists('showTitles', $settings) ? !empty($settings['showTitles']) : true,
            'showPopup' => array_key_exists('showPopup', $settings) ? !empty($settings['showPopup']) : true,
        ],
    ];
}

function galgameMemeSameOrigin(): bool
{
    $source = trim((string)($_SERVER['HTTP_ORIGIN'] ?? ''));
    if ($source === '') $source = trim((string)($_SERVER['HTTP_REFERER'] ?? ''));
    if ($source === '' || $source === 'null') return false;
    $parts = parse_url($source);
    if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) return false;

    $requestScheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $forwarded = strtolower(trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0] ?? ''));
    if (in_array($forwarded, ['http', 'https'], true)) $requestScheme = $forwarded;
    $requestHost = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    $sourceHost = strtolower((string)$parts['host']);
    $sourcePort = isset($parts['port']) ? (int)$parts['port'] : null;
    $requestPort = null;
    if (strpos($requestHost, ':') !== false) {
        [$requestHost, $port] = explode(':', $requestHost, 2);
        $requestPort = (int)$port;
    }
    $defaultPort = static fn(string $scheme): int => strtolower($scheme) === 'https' ? 443 : 80;
    return strtolower((string)$parts['scheme']) === strtolower($requestScheme)
        && $sourceHost === $requestHost
        && ($sourcePort ?? $defaultPort((string)$parts['scheme'])) === ($requestPort ?? $defaultPort($requestScheme));
}

function galgameMemeReadPayload(): array
{
    $contentType = strtolower(trim(explode(';', (string)($_SERVER['CONTENT_TYPE'] ?? ''), 2)[0]));
    if ($contentType !== 'application/json') galgameMemeFail('请求必须使用 application/json', 415);
    $contentLength = isset($_SERVER['CONTENT_LENGTH']) ? (int)$_SERVER['CONTENT_LENGTH'] : 0;
    if ($contentLength > GALGAME_MEME_MAX_BYTES) galgameMemeFail('MEME 看板数据不能超过 15 MiB', 413);
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') galgameMemeFail('请求内容为空');
    if (strlen($raw) > GALGAME_MEME_MAX_BYTES) galgameMemeFail('MEME 看板数据不能超过 15 MiB', 413);
    try {
        $payload = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    } catch (Throwable $error) {
        galgameMemeFail('请求必须是有效的 JSON');
    }
    if (!is_array($payload) || !is_array($payload['meme'] ?? null)) {
        galgameMemeFail('缺少有效的 meme 看板对象');
    }
    return $payload['meme'];
}

$action = strtolower(trim((string)($_GET['action'] ?? '')));
$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$user = requireLogin();
$userId = (int)$user['id'];

if ($action === 'load') {
    if ($method !== 'GET') galgameMemeFail('load 仅支持 GET 请求', 405);
    try {
        $stmt = getDB()->prepare('SELECT payload, schema_version, updated_at FROM galgame_memes WHERE user_id = ? LIMIT 1');
        $stmt->execute([$userId]);
        $row = $stmt->fetch();
        if (!$row) galgameMemeRespond(['success' => true, 'meme' => null, 'updated_at' => null]);
        $meme = json_decode((string)$row['payload'], true);
        if (!is_array($meme)) galgameMemeFail('服务器 MEME 数据损坏，请重置后重新保存', 500);
        galgameMemeRespond([
            'success' => true,
            'meme' => galgameMemeSanitize($meme),
            'schema_version' => (int)$row['schema_version'],
            'updated_at' => $row['updated_at'],
        ]);
    } catch (Throwable $error) {
        galgameMemeFail('暂时无法读取服务器 MEME 看板', 500);
    }
}

if (!in_array($action, ['save', 'reset'], true)) galgameMemeFail('不支持的操作', 400);
if ($method !== 'POST') galgameMemeFail($action . ' 仅支持 POST 请求', 405);
if (!galgameMemeSameOrigin()) galgameMemeFail('请求来源校验失败', 403);

if ($action === 'reset') {
    checkRateLimit('galgame_meme_reset', 10, 1);
    try {
        $stmt = getDB()->prepare('DELETE FROM galgame_memes WHERE user_id = ?');
        $stmt->execute([$userId]);
        galgameMemeRespond(['success' => true, 'reset' => true]);
    } catch (Throwable $error) {
        galgameMemeFail('暂时无法重置服务器 MEME 看板', 500);
    }
}

checkRateLimit('galgame_meme_save', 60, 1);
$meme = galgameMemeSanitize(galgameMemeReadPayload());
try {
    $encoded = json_encode($meme, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    if (strlen($encoded) > GALGAME_MEME_MAX_BYTES) galgameMemeFail('MEME 看板数据不能超过 15 MiB', 413);
    $db = getDB();
    $db->beginTransaction();
    $existing = $db->prepare('SELECT user_id FROM galgame_memes WHERE user_id = ? LIMIT 1');
    $existing->execute([$userId]);
    if ($existing->fetch()) {
        $stmt = $db->prepare('UPDATE galgame_memes SET payload = ?, schema_version = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?');
        $stmt->execute([$encoded, (string)GALGAME_MEME_SCHEMA_VERSION, $userId]);
    } else {
        $stmt = $db->prepare('INSERT INTO galgame_memes (user_id, payload, schema_version, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)');
        $stmt->execute([$userId, $encoded, (string)GALGAME_MEME_SCHEMA_VERSION]);
    }
    $db->commit();
    $updated = $db->prepare('SELECT updated_at FROM galgame_memes WHERE user_id = ? LIMIT 1');
    $updated->execute([$userId]);
    $row = $updated->fetch();
    galgameMemeRespond(['success' => true, 'saved' => true, 'schema_version' => GALGAME_MEME_SCHEMA_VERSION, 'updated_at' => $row['updated_at'] ?? null]);
} catch (Throwable $error) {
    if (isset($db) && $db instanceof PDO && $db->inTransaction()) $db->rollBack();
    galgameMemeFail('暂时无法保存服务器 MEME 看板', 500);
}
