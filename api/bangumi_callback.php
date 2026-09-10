<?php
// api/bangumi_callback.php - Bangumi OAuth 绑定回调

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/oauth_bangumi.php';
require_once __DIR__ . '/../includes/audit.php';

initSession();

function bangumiCallbackRedirect(string $status, string $message): never
{
    $query = http_build_query([
        'oauth' => $status,
        'message' => $message,
    ]);
    header('Location: ../user.html?tab=account&' . $query);
    exit();
}

$mode = (string)($_SESSION['bangumi_oauth_mode'] ?? '');
unset($_SESSION['bangumi_oauth_mode']);
if ($mode !== 'bind') {
    bangumiCallbackRedirect('error', 'Bangumi 绑定流程已失效，请重新发起绑定');
}

$providerError = trim((string)($_GET['error'] ?? ''));
if ($providerError !== '') {
    bangumiCallbackRedirect('error', 'Bangumi 授权被取消');
}

$code = trim((string)($_GET['code'] ?? ''));
$state = trim((string)($_GET['state'] ?? ''));
if ($code === '' || $state === '') {
    bangumiCallbackRedirect('error', 'Bangumi 授权返回参数不完整');
}

$currentUser = getCurrentUser();
if (!$currentUser) {
    bangumiCallbackRedirect('error', '请先登录 VNFmap 账号再绑定 Bangumi');
}

try {
    $tokenData = bangumiExchangeAuthorizationCode($code, $state);
    $accessToken = trim((string)($tokenData['access_token'] ?? ''));
    $bangumiUser = bangumiFetchCurrentUser($accessToken);
    $bangumiUserId = (int)($bangumiUser['id'] ?? $tokenData['user_id'] ?? 0);
    $bangumiUsername = trim((string)($bangumiUser['username'] ?? ''));
    $bangumiNickname = trim((string)($bangumiUser['nickname'] ?? $bangumiUsername));
    if ($bangumiUserId <= 0 || $bangumiUsername === '') {
        throw new RuntimeException('Bangumi 用户资料不完整');
    }

    $db = getDB();
    $conflict = $db->prepare(
        'SELECT vnfmap_user_id FROM bangumi_bindings WHERE bangumi_user_id = ? AND vnfmap_user_id != ? LIMIT 1'
    );
    $conflict->execute([$bangumiUserId, (int)$currentUser['id']]);
    if ($conflict->fetch()) {
        bangumiCallbackRedirect('error', '该 Bangumi 账号已绑定到其他 VNFmap 账号');
    }

    $db->beginTransaction();
    try {
        bangumiStoreTokens(
            $db,
            (int)$currentUser['id'],
            $bangumiUserId,
            $bangumiUsername,
            $bangumiNickname,
            $tokenData
        );
        $db->commit();
    } catch (Throwable $error) {
        if ($db->inTransaction()) $db->rollBack();
        throw $error;
    }

    logAction('user.bind_bangumi', 'user', (int)$currentUser['id'], ['provider' => 'bangumi']);
    bangumiCallbackRedirect('success', 'Bangumi 绑定成功');
} catch (Throwable $error) {
    error_log('Bangumi OAuth callback failed: ' . $error->getMessage());
    bangumiCallbackRedirect('error', $error->getMessage() ?: 'Bangumi 绑定失败');
}
