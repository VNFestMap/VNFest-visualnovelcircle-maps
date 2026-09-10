<?php
declare(strict_types=1);

require_once __DIR__ . '/../includes/auth.php';

header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');
header('X-Content-Type-Options: nosniff');
header('Content-Type: application/json; charset=utf-8');

function walineSsoJson(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function walineSsoFail(string $code, string $message, int $status = 400): never
{
    walineSsoJson(['success' => false, 'error' => ['code' => $code, 'message' => $message]], $status);
}

function walineSsoSecret(): string
{
    return defined('COLUMN_WALINE_SSO_SECRET') ? (string)constant('COLUMN_WALINE_SSO_SECRET') : (string)(getenv('COLUMN_WALINE_SSO_SECRET') ?: '');
}

function walineSsoAllowedRedirect(string $redirect): bool
{
    $configured = defined('COLUMN_WALINE_ALLOWED_REDIRECTS')
        ? (string)constant('COLUMN_WALINE_ALLOWED_REDIRECTS')
        : (string)(getenv('COLUMN_WALINE_ALLOWED_REDIRECTS') ?: '');
    $allowed = array_values(array_filter(array_map('trim', explode(',', $configured))));
    if ($allowed) return in_array($redirect, $allowed, true);
    $url = parse_url($redirect);
    $host = strtolower((string)($url['host'] ?? ''));
    $requestHost = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    return in_array((string)($url['scheme'] ?? ''), ['http', 'https'], true)
        && $host !== '' && $host === preg_replace('/:\d+$/', '', $requestHost);
}

function walineSsoCodeFile(): string
{
    return dirname(__DIR__) . '/data/waline-sso-codes.json';
}

function walineSsoReadCodes(): array
{
    $file = walineSsoCodeFile();
    if (!is_file($file)) return [];
    $rows = json_decode((string)file_get_contents($file), true);
    return is_array($rows) ? $rows : [];
}

function walineSsoWriteCodes(array $rows): void
{
    $file = walineSsoCodeFile();
    $directory = dirname($file);
    if (!is_dir($directory) && !mkdir($directory, 0755, true) && !is_dir($directory)) walineSsoFail('storage_unavailable', '登录服务暂时不可用', 503);
    if (file_put_contents($file, json_encode($rows, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX) === false) walineSsoFail('storage_unavailable', '登录服务暂时不可用', 503);
}

function walineSsoUserPayload(array $user): array
{
    return [
        'id' => (int)$user['id'],
        'username' => (string)($user['username'] ?? ''),
        'nickname' => trim((string)($user['nickname'] ?? '')) ?: (string)($user['username'] ?? ''),
        'avatar_url' => (string)($user['avatar_url'] ?? ''),
    ];
}

function walineSsoToken(array $user): string
{
    $payload = rtrim(strtr(base64_encode(json_encode([
        'sub' => (int)$user['id'],
        'exp' => time() + 900,
    ], JSON_UNESCAPED_SLASHES)), '+/', '-_'), '=');
    return $payload . '.' . hash_hmac('sha256', $payload, walineSsoSecret());
}

function walineSsoTokenPayload(string $token): ?array
{
    [$payload, $signature] = array_pad(explode('.', $token, 2), 2, '');
    if ($payload === '' || $signature === '' || walineSsoSecret() === '' || !hash_equals(hash_hmac('sha256', $payload, walineSsoSecret()), $signature)) return null;
    $decoded = base64_decode(strtr($payload, '-_', '+/') . str_repeat('=', (4 - strlen($payload) % 4) % 4), true);
    $data = is_string($decoded) ? json_decode($decoded, true) : null;
    if (!is_array($data) || (int)($data['exp'] ?? 0) < time()) return null;
    return $data;
}

function walineSsoAuthorize(): never
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') walineSsoFail('method_not_allowed', '请求方法不允许', 405);
    $redirect = trim((string)($_GET['redirect_uri'] ?? ''));
    $state = trim((string)($_GET['state'] ?? ''));
    $nonce = trim((string)($_GET['nonce'] ?? ''));
    if (!walineSsoAllowedRedirect($redirect)) walineSsoFail('invalid_redirect', '回调地址无效', 400);
    if (!preg_match('/^[a-zA-Z0-9._~-]{8,200}$/', $state) || !preg_match('/^[a-zA-Z0-9._~-]{8,200}$/', $nonce)) walineSsoFail('invalid_state', '登录状态无效', 400);
    $user = getCurrentUser();
    if (!$user) {
        $target = 'api/waline-sso.php?action=authorize&redirect_uri=' . rawurlencode($redirect) . '&state=' . rawurlencode($state) . '&nonce=' . rawurlencode($nonce);
        header('Location: ../login.html?redirect=' . rawurlencode($target), true, 302);
        exit;
    }
    $code = bin2hex(random_bytes(24));
    $rows = array_values(array_filter(walineSsoReadCodes(), static fn(array $row): bool => (int)($row['expires_at'] ?? 0) > time() && empty($row['used_at'])));
    $rows[] = [
        'code_hash' => hash('sha256', $code),
        'state' => $state,
        'nonce' => $nonce,
        'redirect_uri' => $redirect,
        'user' => walineSsoUserPayload($user),
        'expires_at' => time() + 60,
        'used_at' => null,
    ];
    walineSsoWriteCodes($rows);
    $separator = str_contains($redirect, '?') ? '&' : '?';
    header('Location: ' . $redirect . $separator . 'code=' . rawurlencode($code) . '&state=' . rawurlencode($state), true, 302);
    exit;
}

function walineSsoExchange(): never
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') walineSsoFail('method_not_allowed', '请求方法不允许', 405);
    $secret = walineSsoSecret();
    $provided = (string)($_SERVER['HTTP_X_VNFEST_WALINE_SECRET'] ?? '');
    if ($secret === '' || $provided === '' || !hash_equals($secret, $provided)) walineSsoFail('invalid_client', '客户端身份无效', 401);
    $input = json_decode((string)file_get_contents('php://input'), true);
    if (!is_array($input)) $input = $_POST;
    $code = trim((string)($input['code'] ?? ''));
    $state = trim((string)($input['state'] ?? ''));
    $nonce = trim((string)($input['nonce'] ?? ''));
    $redirect = trim((string)($input['redirect_uri'] ?? ''));
    if ($code === '' || $state === '' || $nonce === '' || $redirect === '') walineSsoFail('invalid_grant', '授权信息不完整', 400);
    $rows = walineSsoReadCodes();
    $found = null;
    foreach ($rows as $index => $row) {
        if (!hash_equals((string)($row['code_hash'] ?? ''), hash('sha256', $code))) continue;
        if (!empty($row['used_at']) || (int)($row['expires_at'] ?? 0) < time()) walineSsoFail('invalid_grant', '授权码已失效', 400);
        if (!hash_equals((string)($row['state'] ?? ''), $state) || !hash_equals((string)($row['nonce'] ?? ''), $nonce) || !hash_equals((string)($row['redirect_uri'] ?? ''), $redirect)) walineSsoFail('invalid_grant', '授权信息校验失败', 400);
        $rows[$index]['used_at'] = time();
        $found = $row;
        break;
    }
    if (!$found) walineSsoFail('invalid_grant', '授权码无效', 400);
    walineSsoWriteCodes($rows);
    walineSsoJson(['success' => true, 'data' => ['access_token' => walineSsoToken($found['user']), 'token_type' => 'Bearer', 'expires_in' => 900, 'user' => $found['user']]]);
}

function walineSsoProfile(): never
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') walineSsoFail('method_not_allowed', '请求方法不允许', 405);
    $header = trim((string)($_SERVER['HTTP_AUTHORIZATION'] ?? ''));
    if (!preg_match('/^Bearer\s+(.+)$/i', $header, $match)) walineSsoFail('unauthorized', '缺少评论登录凭证', 401);
    $payload = walineSsoTokenPayload(trim($match[1]));
    if (!$payload) walineSsoFail('unauthorized', '评论登录凭证已失效', 401);
    $db = getDB();
    $stmt = $db->prepare('SELECT id,username,nickname,avatar_url FROM users WHERE id=? AND status=\'active\' LIMIT 1');
    $stmt->execute([(int)$payload['sub']]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
    if (!$user) walineSsoFail('unauthorized', 'VNFest 登录状态已失效', 401);
    walineSsoJson(['success' => true, 'data' => ['user' => walineSsoUserPayload($user)]]);
}

$action = strtolower(trim((string)($_GET['action'] ?? 'authorize')));
try {
    if ($action === 'authorize') walineSsoAuthorize();
    if ($action === 'exchange') walineSsoExchange();
    if ($action === 'profile') walineSsoProfile();
    walineSsoFail('unknown_action', '未知操作', 400);
} catch (Throwable $e) {
    error_log('[waline-sso] ' . $e->getMessage());
    walineSsoFail('service_unavailable', '登录服务暂时不可用', 503);
}
