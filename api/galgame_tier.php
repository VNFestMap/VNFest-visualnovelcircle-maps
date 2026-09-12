<?php
// api/galgame_tier.php - 登录用户的 Galgame Tier 表读写接口
// 动作: load, save, reset（结构沿用 galgame_meme.php）

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit();
}

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/rate_limit.php';

const GALGAME_TIER_MAX_BYTES = 15728640; // 15 MiB
const GALGAME_TIER_SCHEMA_VERSION = 1;
const GALGAME_TIER_MAX_ROWS = 12;
const GALGAME_TIER_MAX_CARDS_PER_ROW = 60;
const GALGAME_TIER_MAX_UNRANKED = 100;

function galgameTierRespond(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit();
}

function galgameTierFail(string $message, int $status = 400): void
{
    galgameTierRespond(['success' => false, 'message' => $message], $status);
}

function galgameTierString($value, int $maxBytes = 240): string
{
    if ($value === null || !is_scalar($value)) return '';
    $value = trim((string)$value);
    if (strlen($value) <= $maxBytes) return $value;
    return function_exists('mb_substr') ? mb_substr($value, 0, $maxBytes, 'UTF-8') : substr($value, 0, $maxBytes);
}

function galgameTierImage($value): string
{
    $image = galgameTierString($value, 12582912);
    if ($image === '') return '';
    if (preg_match('/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+\/\s=]+$/i', $image)) return $image;
    if (preg_match('/^(?:https?:\/\/|\/|\.\/|\.\.\/)[^\s<>"\']+$/i', $image)) return $image;
    return '';
}

function galgameTierColor($value, string $fallback): string
{
    $color = strtolower(trim((string)$value));
    return preg_match('/^#[0-9a-f]{6}$/', $color) ? $color : $fallback;
}

function galgameTierList($value, int $maxItems): array
{
    if (!is_array($value)) return [];
    $items = [];
    foreach ($value as $item) {
        if (count($items) >= $maxItems || !is_array($item)) continue;
        $title = galgameTierString($item['title'] ?? '', 240);
        if ($title === '') continue;
        $kind = (string)($item['kind'] ?? 'work');
        $source = (string)($item['source'] ?? 'custom');
        if (!in_array($kind, ['work', 'character', 'custom'], true)) $kind = 'custom';
        if (!in_array($source, ['bangumi', 'cngal', 'vndb', 'resume', 'custom'], true)) $source = 'custom';
        $clean = [
            'id' => galgameTierString($item['id'] ?? '', 120),
            'kind' => $kind,
            'source' => $source,
            'sourceId' => galgameTierString($item['sourceId'] ?? $item['source_id'] ?? '', 160),
            'title' => $title,
            'subtitle' => galgameTierString($item['subtitle'] ?? $item['sub'] ?? '', 240),
            'image' => galgameTierImage($item['image'] ?? $item['imageUrl'] ?? ''),
        ];
        $bangumiId = (int)($item['bangumiId'] ?? $item['bangumi_id'] ?? 0);
        if ($bangumiId > 0) $clean['bangumiId'] = $bangumiId;
        if ($clean['id'] === '') $clean['id'] = 'tier-' . substr(hash('sha256', json_encode($clean)), 0, 18);
        $items[] = $clean;
    }
    return $items;
}

function galgameTierRows($value): array
{
    if (!is_array($value)) return [];
    $rows = [];
    foreach ($value as $row) {
        if (count($rows) >= GALGAME_TIER_MAX_ROWS || !is_array($row)) continue;
        $rows[] = [
            'id' => galgameTierString($row['id'] ?? '', 80) ?: 'row-' . (count($rows) + 1),
            'label' => galgameTierString($row['label'] ?? '', 24) ?: 'ROW ' . (count($rows) + 1),
            'color' => galgameTierColor($row['color'] ?? '', '#d9d3de'),
            'cards' => galgameTierList($row['cards'] ?? [], GALGAME_TIER_MAX_CARDS_PER_ROW),
        ];
    }
    return $rows;
}

function galgameTierSanitize(array $value): array
{
    $board = is_array($value['board'] ?? null) ? $value['board'] : [];
    $settings = is_array($value['settings'] ?? null) ? $value['settings'] : [];
    $cardSize = (string)($settings['cardSize'] ?? 'md');
    if (!in_array($cardSize, ['sm', 'md', 'lg'], true)) $cardSize = 'md';

    return [
        'schema_version' => GALGAME_TIER_SCHEMA_VERSION,
        'board' => [
            'title' => galgameTierString($board['title'] ?? 'Galgame Tier 表', 80) ?: 'Galgame Tier 表',
            'rows' => galgameTierRows($board['rows'] ?? []),
            'unranked' => galgameTierList($board['unranked'] ?? [], GALGAME_TIER_MAX_UNRANKED),
        ],
        'settings' => [
            'cardSize' => $cardSize,
            'showTitles' => array_key_exists('showTitles', $settings) ? !empty($settings['showTitles']) : true,
        ],
    ];
}

function galgameTierSameOrigin(): bool
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

function galgameTierReadPayload(): array
{
    $contentType = strtolower(trim(explode(';', (string)($_SERVER['CONTENT_TYPE'] ?? ''), 2)[0]));
    if ($contentType !== 'application/json') galgameTierFail('请求必须使用 application/json', 415);
    $contentLength = isset($_SERVER['CONTENT_LENGTH']) ? (int)$_SERVER['CONTENT_LENGTH'] : 0;
    if ($contentLength > GALGAME_TIER_MAX_BYTES) galgameTierFail('Tier 表数据不能超过 15 MiB', 413);
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') galgameTierFail('请求内容为空');
    if (strlen($raw) > GALGAME_TIER_MAX_BYTES) galgameTierFail('Tier 表数据不能超过 15 MiB', 413);
    try {
        $payload = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    } catch (Throwable $error) {
        galgameTierFail('请求必须是有效的 JSON');
    }
    if (!is_array($payload) || !is_array($payload['tier'] ?? null)) {
        galgameTierFail('缺少有效的 tier 表对象');
    }
    return $payload['tier'];
}

$action = strtolower(trim((string)($_GET['action'] ?? '')));
$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$user = requireLogin();
$userId = (int)$user['id'];

if ($action === 'load') {
    if ($method !== 'GET') galgameTierFail('load 仅支持 GET 请求', 405);
    try {
        $stmt = getDB()->prepare('SELECT payload, schema_version, updated_at FROM galgame_tiers WHERE user_id = ? LIMIT 1');
        $stmt->execute([$userId]);
        $row = $stmt->fetch();
        if (!$row) galgameTierRespond(['success' => true, 'tier' => null, 'updated_at' => null]);
        $tier = json_decode((string)$row['payload'], true);
        if (!is_array($tier)) galgameTierFail('服务器 Tier 数据损坏，请重置后重新保存', 500);
        galgameTierRespond([
            'success' => true,
            'tier' => galgameTierSanitize($tier),
            'schema_version' => (int)$row['schema_version'],
            'updated_at' => $row['updated_at'],
        ]);
    } catch (Throwable $error) {
        galgameTierFail('暂时无法读取服务器 Tier 表', 500);
    }
}

if (!in_array($action, ['save', 'reset'], true)) galgameTierFail('不支持的操作', 400);
if ($method !== 'POST') galgameTierFail($action . ' 仅支持 POST 请求', 405);
if (!galgameTierSameOrigin()) galgameTierFail('请求来源校验失败', 403);

if ($action === 'reset') {
    checkRateLimit('galgame_tier_reset', 10, 1);
    try {
        $stmt = getDB()->prepare('DELETE FROM galgame_tiers WHERE user_id = ?');
        $stmt->execute([$userId]);
        galgameTierRespond(['success' => true, 'reset' => true]);
    } catch (Throwable $error) {
        galgameTierFail('暂时无法重置服务器 Tier 表', 500);
    }
}

checkRateLimit('galgame_tier_save', 60, 1);
$tier = galgameTierSanitize(galgameTierReadPayload());
try {
    $encoded = json_encode($tier, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    if (strlen($encoded) > GALGAME_TIER_MAX_BYTES) galgameTierFail('Tier 表数据不能超过 15 MiB', 413);
    $db = getDB();
    $db->beginTransaction();
    $existing = $db->prepare('SELECT user_id FROM galgame_tiers WHERE user_id = ? LIMIT 1');
    $existing->execute([$userId]);
    if ($existing->fetch()) {
        $stmt = $db->prepare('UPDATE galgame_tiers SET payload = ?, schema_version = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?');
        $stmt->execute([$encoded, (string)GALGAME_TIER_SCHEMA_VERSION, $userId]);
    } else {
        $stmt = $db->prepare('INSERT INTO galgame_tiers (user_id, payload, schema_version, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)');
        $stmt->execute([$userId, $encoded, (string)GALGAME_TIER_SCHEMA_VERSION]);
    }
    $db->commit();
    $updated = $db->prepare('SELECT updated_at FROM galgame_tiers WHERE user_id = ? LIMIT 1');
    $updated->execute([$userId]);
    $row = $updated->fetch();
    galgameTierRespond(['success' => true, 'saved' => true, 'schema_version' => GALGAME_TIER_SCHEMA_VERSION, 'updated_at' => $row['updated_at'] ?? null]);
} catch (Throwable $error) {
    if (isset($db) && $db instanceof PDO && $db->inTransaction()) $db->rollBack();
    galgameTierFail('暂时无法保存服务器 Tier 表', 500);
}
