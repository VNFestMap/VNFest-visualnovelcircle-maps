<?php
// includes/oauth_discord.php - Discord OAuth2 登录
// 参考: https://discord.com/developers/docs/topics/oauth2

require_once __DIR__ . '/../config.php';

function discord_get_authorization_url(): string {
    $state = bin2hex(random_bytes(16));
    $_SESSION['discord_state'] = $state;

    $params = http_build_query([
        'client_id' => DISCORD_CLIENT_ID,
        'redirect_uri' => DISCORD_REDIRECT_URI,
        'response_type' => 'code',
        'scope' => 'identify',
        'state' => $state,
    ]);

    return 'https://discord.com/api/oauth2/authorize?' . $params;
}

function discord_handle_callback(string $code, string $state): ?array {
    // 验证 state 防止 CSRF
    $expectedState = (string)($_SESSION['discord_state'] ?? '');
    if ($expectedState === '' || !hash_equals($expectedState, $state)) {
        return null;
    }
    unset($_SESSION['discord_state']);

    // 用 code 换 access_token
    $postData = http_build_query([
        'client_id' => DISCORD_CLIENT_ID,
        'client_secret' => DISCORD_CLIENT_SECRET,
        'grant_type' => 'authorization_code',
        'code' => $code,
        'redirect_uri' => DISCORD_REDIRECT_URI,
    ]);

    $opts = [
        'http' => [
            'method' => 'POST',
            'header' => 'Content-Type: application/x-www-form-urlencoded',
            'content' => $postData,
            'timeout' => 10,
        ],
    ];
    $context = stream_context_create($opts);
    $tokenResp = @file_get_contents('https://discord.com/api/oauth2/token', false, $context);
    if (!$tokenResp) return null;
    $tokenData = json_decode($tokenResp, true);
    if (!isset($tokenData['access_token'])) return null;

    $accessToken = $tokenData['access_token'];

    // 获取用户信息
    $opts = [
        'http' => [
            'method' => 'GET',
            'header' => 'Authorization: Bearer ' . $accessToken,
            'timeout' => 10,
        ],
    ];
    $context = stream_context_create($opts);
    $userResp = @file_get_contents('https://discord.com/api/users/@me', false, $context);
    if (!$userResp) return null;
    $userData = json_decode($userResp, true);
    if (!isset($userData['id'])) return null;

    $username = $userData['global_name'] ?? $userData['username'] ?? '';

    return [
        'discord_id' => $userData['id'],
        'username' => $username,
        'avatar_url' => !empty($userData['avatar'])
            ? 'https://cdn.discordapp.com/avatars/' . $userData['id'] . '/' . $userData['avatar'] . '.png'
            : '',
    ];
}
