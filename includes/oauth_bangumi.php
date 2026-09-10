<?php
// includes/oauth_bangumi.php - Bangumi OAuth 绑定与用户收藏访问
//
// Bangumi OAuth access/refresh tokens never leave the server.  The local
// runtime used by this project does not always provide OpenSSL or Sodium, so
// the token seal uses an authenticated HMAC-derived stream as a portable
// fallback.  The ciphertext is integrity checked before it is ever used.

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/db.php';

function bangumiConfigValue(string $name, string $default = ''): string
{
    $env = getenv($name);
    if ($env !== false && $env !== '') {
        return trim((string)$env);
    }
    return defined($name) ? trim((string)constant($name)) : $default;
}

function bangumiOAuthConfigured(): bool
{
    return bangumiConfigValue('BANGUMI_CLIENT_ID') !== ''
        && bangumiConfigValue('BANGUMI_CLIENT_SECRET') !== ''
        && bangumiConfigValue('BANGUMI_TOKEN_ENCRYPTION_KEY') !== '';
}

function bangumiOAuthClientConfigured(): bool
{
    return bangumiConfigValue('BANGUMI_CLIENT_ID') !== ''
        && bangumiConfigValue('BANGUMI_CLIENT_SECRET') !== '';
}

function bangumiBase64UrlEncode(string $value): string
{
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

function bangumiBase64UrlDecode(string $value): string|false
{
    $padding = strlen($value) % 4;
    if ($padding > 0) $value .= str_repeat('=', 4 - $padding);
    return base64_decode(strtr($value, '-_', '+/'), true);
}

function bangumiTokenKey(): string
{
    $configured = bangumiConfigValue('BANGUMI_TOKEN_ENCRYPTION_KEY');
    if ($configured === '') {
        throw new RuntimeException('Bangumi Token 加密密钥未配置');
    }
    return hash('sha256', $configured, true);
}

/**
 * Encrypt one OAuth token without requiring an optional PHP crypto extension.
 * Each token gets a fresh nonce and an HMAC tag, so tampering fails closed.
 */
function bangumiEncryptToken(string $plainText): string
{
    if ($plainText === '') return '';

    $key = bangumiTokenKey();
    $nonce = random_bytes(16);
    $cipherText = '';
    $length = strlen($plainText);

    for ($offset = 0, $counter = 0; $offset < $length; $offset += 32, $counter++) {
        $stream = hash_hmac('sha256', "vnfest-bangumi-v1|{$nonce}|{$counter}", $key, true);
        $chunk = substr($plainText, $offset, 32);
        $sealedChunk = '';
        for ($i = 0, $chunkLength = strlen($chunk); $i < $chunkLength; $i++) {
            $sealedChunk .= chr(ord($chunk[$i]) ^ ord($stream[$i]));
        }
        $cipherText .= $sealedChunk;
    }

    $tag = hash_hmac('sha256', "vnfest-bangumi-v1|{$nonce}|{$cipherText}", $key, true);
    return 'v1.' . bangumiBase64UrlEncode($nonce) . '.'
        . bangumiBase64UrlEncode($cipherText) . '.' . bangumiBase64UrlEncode($tag);
}

function bangumiDecryptToken(string $encoded): string
{
    if ($encoded === '') return '';

    $parts = explode('.', $encoded, 4);
    if (count($parts) !== 4 || $parts[0] !== 'v1') {
        throw new RuntimeException('Bangumi Token 格式无效');
    }

    $nonce = bangumiBase64UrlDecode($parts[1]);
    $cipherText = bangumiBase64UrlDecode($parts[2]);
    $tag = bangumiBase64UrlDecode($parts[3]);
    if ($nonce === false || $cipherText === false || $tag === false || strlen($nonce) !== 16) {
        throw new RuntimeException('Bangumi Token 数据无效');
    }

    $key = bangumiTokenKey();
    $expectedTag = hash_hmac('sha256', "vnfest-bangumi-v1|{$nonce}|{$cipherText}", $key, true);
    if (!hash_equals($expectedTag, $tag)) {
        throw new RuntimeException('Bangumi Token 校验失败');
    }

    $plainText = '';
    $length = strlen($cipherText);
    for ($offset = 0, $counter = 0; $offset < $length; $offset += 32, $counter++) {
        $stream = hash_hmac('sha256', "vnfest-bangumi-v1|{$nonce}|{$counter}", $key, true);
        $chunk = substr($cipherText, $offset, 32);
        for ($i = 0, $chunkLength = strlen($chunk); $i < $chunkLength; $i++) {
            $plainText .= chr(ord($chunk[$i]) ^ ord($stream[$i]));
        }
    }
    return $plainText;
}

function bangumiHttpJson(string $method, string $url, array $headers = [], ?string $body = null): array
{
    $headerLines = array_merge([
        'Accept: application/json',
        'User-Agent: VNFest/1.0 (https://map.vnfest.top; contact@vnfest.top)',
    ], $headers);
    $options = [
        'method' => strtoupper($method),
        'timeout' => 15,
        'ignore_errors' => true,
        'header' => implode("\r\n", $headerLines) . "\r\n",
    ];
    if ($body !== null) $options['content'] = $body;

    $context = stream_context_create(['http' => $options]);
    $http_response_header = [];
    $raw = @file_get_contents($url, false, $context);
    $status = 0;
    foreach ($http_response_header as $responseHeader) {
        if (preg_match('/^HTTP\/\S+\s+(\d{3})/', (string)$responseHeader, $matches)) {
            $status = (int)$matches[1];
        }
    }
    $data = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
    return [
        'ok' => $status >= 200 && $status < 300 && is_array($data),
        'status' => $status,
        'data' => is_array($data) ? $data : null,
    ];
}

function bangumiAuthorizationUrl(): string
{
    if (!bangumiOAuthClientConfigured()) {
        throw new RuntimeException('Bangumi OAuth 尚未配置');
    }

    $state = bin2hex(random_bytes(24));
    $_SESSION['bangumi_oauth_state'] = $state;
    $_SESSION['bangumi_oauth_started_at'] = time();
    $_SESSION['bangumi_oauth_mode'] = 'bind';

    $params = http_build_query([
        'client_id' => bangumiConfigValue('BANGUMI_CLIENT_ID'),
        'response_type' => 'code',
        'redirect_uri' => bangumiConfigValue('BANGUMI_REDIRECT_URI', SITE_URL . '/api/bangumi_callback.php'),
        'state' => $state,
    ]);
    return 'https://bgm.tv/oauth/authorize?' . $params;
}

function bangumiExchangeAuthorizationCode(string $code, string $state): array
{
    $expectedState = (string)($_SESSION['bangumi_oauth_state'] ?? '');
    $startedAt = (int)($_SESSION['bangumi_oauth_started_at'] ?? 0);
    unset($_SESSION['bangumi_oauth_state'], $_SESSION['bangumi_oauth_started_at']);

    if ($expectedState === '' || !hash_equals($expectedState, $state) || $startedAt <= 0 || time() - $startedAt > 300) {
        throw new RuntimeException('Bangumi 授权状态已失效，请重新绑定');
    }
    if (!bangumiOAuthClientConfigured()) {
        throw new RuntimeException('Bangumi OAuth 尚未配置');
    }

    $body = http_build_query([
        'grant_type' => 'authorization_code',
        'client_id' => bangumiConfigValue('BANGUMI_CLIENT_ID'),
        'client_secret' => bangumiConfigValue('BANGUMI_CLIENT_SECRET'),
        'code' => $code,
        'redirect_uri' => bangumiConfigValue('BANGUMI_REDIRECT_URI', SITE_URL . '/api/bangumi_callback.php'),
        'state' => $state,
    ]);
    $response = bangumiHttpJson('POST', 'https://bgm.tv/oauth/access_token', [
        'Content-Type: application/x-www-form-urlencoded',
    ], $body);
    if (!$response['ok'] || empty($response['data']['access_token'])) {
        throw new RuntimeException('Bangumi 授权码交换失败');
    }
    return $response['data'];
}

function bangumiRefreshAccessToken(string $refreshToken): array
{
    if (!bangumiOAuthClientConfigured() || $refreshToken === '') {
        throw new RuntimeException('Bangumi Refresh Token 不可用');
    }
    $body = http_build_query([
        'grant_type' => 'refresh_token',
        'client_id' => bangumiConfigValue('BANGUMI_CLIENT_ID'),
        'client_secret' => bangumiConfigValue('BANGUMI_CLIENT_SECRET'),
        'refresh_token' => $refreshToken,
        'redirect_uri' => bangumiConfigValue('BANGUMI_REDIRECT_URI', SITE_URL . '/api/bangumi_callback.php'),
    ]);
    $response = bangumiHttpJson('POST', 'https://bgm.tv/oauth/access_token', [
        'Content-Type: application/x-www-form-urlencoded',
    ], $body);
    if (!$response['ok'] || empty($response['data']['access_token'])) {
        throw new RuntimeException('Bangumi 授权已过期，请重新绑定', 401);
    }
    return $response['data'];
}

function bangumiFetchCurrentUser(string $accessToken): array
{
    if ($accessToken === '') throw new RuntimeException('Bangumi Access Token 为空');
    $response = bangumiHttpJson('GET', 'https://api.bgm.tv/v0/me', [
        'Authorization: Bearer ' . $accessToken,
    ]);
    if (!$response['ok'] || !is_array($response['data']) || empty($response['data']['id'])) {
        throw new RuntimeException('无法读取 Bangumi 用户信息');
    }
    return $response['data'];
}

function bangumiBindingForUser(PDO $db, int $userId): ?array
{
    $stmt = $db->prepare('SELECT * FROM bangumi_bindings WHERE vnfmap_user_id = ? LIMIT 1');
    $stmt->execute([$userId]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function bangumiPublicBindingForUser(int $userId): array
{
    if ($userId <= 0) return ['bound' => false, 'username' => ''];
    try {
        $binding = bangumiBindingForUser(getDB(), $userId);
        return [
            'bound' => (bool)$binding,
            'username' => $binding ? (string)($binding['bangumi_username'] ?? '') : '',
        ];
    } catch (Throwable $error) {
        // Before the migration has run, the account API should remain usable.
        return ['bound' => false, 'username' => ''];
    }
}

function bangumiTokenExpiresAt(array $tokenData, ?string $fallback = null): ?string
{
    $expiresIn = (int)($tokenData['expires_in'] ?? 0);
    if ($expiresIn > 0) return date('Y-m-d H:i:s', time() + $expiresIn);
    return $fallback;
}

function bangumiStoreTokens(PDO $db, int $userId, int $bangumiUserId, string $username, string $nickname, array $tokenData, ?string $createdAt = null): void
{
    $accessToken = trim((string)($tokenData['access_token'] ?? ''));
    if ($accessToken === '') throw new RuntimeException('Bangumi Access Token 为空');
    $refreshToken = trim((string)($tokenData['refresh_token'] ?? ''));
    $accessCipher = bangumiEncryptToken($accessToken);
    $refreshCipher = $refreshToken === '' ? '' : bangumiEncryptToken($refreshToken);
    $expiresAt = bangumiTokenExpiresAt($tokenData);

    $existing = $db->prepare('SELECT id, bangumi_user_id, refresh_token_ciphertext, token_expires_at FROM bangumi_bindings WHERE vnfmap_user_id = ? LIMIT 1');
    $existing->execute([$userId]);
    $existingRow = $existing->fetch() ?: null;
    if ($existingRow) {
        // Some OAuth providers omit refresh_token on a repeat authorization.
        // Keep the previous refresh token only when it belongs to the same
        // Bangumi account; never carry a token across an account switch.
        if ($refreshCipher === '' && (int)$existingRow['bangumi_user_id'] === $bangumiUserId) {
            $refreshCipher = (string)($existingRow['refresh_token_ciphertext'] ?? '');
        }
        if ($expiresAt === null && (int)$existingRow['bangumi_user_id'] === $bangumiUserId) {
            $expiresAt = $existingRow['token_expires_at'] ?? null;
        }
        $stmt = $db->prepare(
            'UPDATE bangumi_bindings SET bangumi_user_id = ?, bangumi_username = ?, bangumi_nickname = ?,
             access_token_ciphertext = ?, refresh_token_ciphertext = ?, token_expires_at = ?, updated_at = CURRENT_TIMESTAMP
             WHERE vnfmap_user_id = ?'
        );
        $stmt->execute([$bangumiUserId, $username, $nickname, $accessCipher, $refreshCipher, $expiresAt, $userId]);
        return;
    }

    $stmt = $db->prepare(
        'INSERT INTO bangumi_bindings
         (vnfmap_user_id, bangumi_user_id, bangumi_username, bangumi_nickname, access_token_ciphertext,
          refresh_token_ciphertext, token_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)'
    );
    $stmt->execute([$userId, $bangumiUserId, $username, $nickname, $accessCipher, $refreshCipher, $expiresAt, $createdAt]);
}

function bangumiUpdateRefreshedTokens(PDO $db, int $userId, array $tokenData, array $binding): void
{
    $accessToken = trim((string)($tokenData['access_token'] ?? ''));
    if ($accessToken === '') throw new RuntimeException('Bangumi 刷新结果无 Access Token', 401);
    $refreshToken = trim((string)($tokenData['refresh_token'] ?? ''));
    if ($refreshToken === '') $refreshToken = bangumiDecryptToken((string)($binding['refresh_token_ciphertext'] ?? ''));

    $stmt = $db->prepare(
        'UPDATE bangumi_bindings SET access_token_ciphertext = ?, refresh_token_ciphertext = ?,
         token_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE vnfmap_user_id = ?'
    );
    $stmt->execute([
        bangumiEncryptToken($accessToken),
        $refreshToken === '' ? '' : bangumiEncryptToken($refreshToken),
        bangumiTokenExpiresAt($tokenData, $binding['token_expires_at'] ?? null),
        $userId,
    ]);
}

function bangumiAccessToken(PDO $db, int $userId, array $binding, bool $forceRefresh = false): string
{
    $expiresAt = strtotime((string)($binding['token_expires_at'] ?? '')) ?: 0;
    if (!$forceRefresh && $expiresAt > time() + 90) {
        return bangumiDecryptToken((string)$binding['access_token_ciphertext']);
    }

    $refreshToken = bangumiDecryptToken((string)($binding['refresh_token_ciphertext'] ?? ''));
    if ($refreshToken === '') {
        return bangumiDecryptToken((string)$binding['access_token_ciphertext']);
    }
    $tokenData = bangumiRefreshAccessToken($refreshToken);
    bangumiUpdateRefreshedTokens($db, $userId, $tokenData, $binding);
    return (string)$tokenData['access_token'];
}

function bangumiApiGet(string $path, string $accessToken): array
{
    return bangumiHttpJson('GET', 'https://api.bgm.tv' . $path, [
        'Authorization: Bearer ' . $accessToken,
    ]);
}
