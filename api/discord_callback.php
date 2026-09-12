<?php
// api/discord_callback.php - Discord OAuth 回调处理

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/oauth_discord.php';
require_once __DIR__ . '/../includes/oauth_account.php';
require_once __DIR__ . '/../includes/audit.php';
require_once __DIR__ . '/../includes/notifications.php';

initSession();

$code = is_string($_GET['code'] ?? null) ? $_GET['code'] : '';
$state = is_string($_GET['state'] ?? null) ? $_GET['state'] : '';

if (!$code || !$state) {
    $returnTo = oauthAccountContextReturnTo('index.html');
    oauthAccountClearOAuthContext();
    header('Location: ' . oauthAccountCallbackRedirect($returnTo, 'error', '缺少参数'));
    exit();
}

// 处理回调，获取 Discord 用户信息
$discordUser = discord_handle_callback($code, $state);
if (!$discordUser) {
    $returnTo = oauthAccountContextReturnTo('index.html');
    oauthAccountClearOAuthContext();
    header('Location: ' . oauthAccountCallbackRedirect($returnTo, 'error', 'Discord授权失败'));
    exit();
}

oauthAccountProcessCallback('discord', $discordUser);
