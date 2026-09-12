<?php
// includes/oauth_qq.php - QQ OAuth2 登录
// 参考 QQ 互联 OAuth2.0 文档: https://wiki.connect.qq.com/

require_once __DIR__ . '/../config.php';

function qq_get_authorization_url(): string {
    $state = bin2hex(random_bytes(16));
    $_SESSION['qq_state'] = $state;

    $params = http_build_query([
        'response_type' => 'code',
        'client_id' => QQ_APPID,
        'redirect_uri' => QQ_REDIRECT_URI,
        'state' => $state,
        'scope' => 'get_user_info',
    ]);

    return 'https://graph.qq.com/oauth2.0/authorize?' . $params;
}

function qq_http_get(string $url): ?string {
    if (function_exists('curl_init')) {
        $curl = curl_init($url);
        if ($curl === false) {
            return null;
        }
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => 15,
            CURLOPT_HTTPHEADER => [
                'Accept: application/json',
                'User-Agent: VNFest/1.0 QQ OAuth',
            ],
        ]);
        $response = curl_exec($curl);
        curl_close($curl);
    } else {
        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'header' => "Accept: application/json\r\nUser-Agent: VNFest/1.0 QQ OAuth\r\n",
                'timeout' => 15,
                'ignore_errors' => true,
            ],
        ]);
        $response = @file_get_contents($url, false, $context);
    }

    if (!is_string($response) || trim($response) === '') {
        return null;
    }
    return trim($response);
}

function qq_decode_response(string $response): ?array {
    $body = trim($response);
    if (strncmp($body, "\xEF\xBB\xBF", 3) === 0) {
        $body = substr($body, 3);
    }

    $data = json_decode($body, true);
    if (is_array($data)) {
        return $data;
    }

    // 兼容 QQ 某些接口返回的 JSONP：callback({ ... });
    if (preg_match('/\A[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(\s*(.*)\s*\)\s*;?\s*\z/s', $body, $matches)) {
        $data = json_decode(trim($matches[1]), true);
        if (is_array($data)) {
            return $data;
        }
    }

    // token 接口在部分兼容路径上可能返回 application/x-www-form-urlencoded。
    if (strpos($body, '=') === false) {
        return null;
    }
    parse_str($body, $data);
    return is_array($data) && $data !== [] ? $data : null;
}

function qq_log_api_failure(string $stage, ?array $data = null): void {
    $details = [];
    if (is_array($data)) {
        foreach (['error', 'ret', 'error_description', 'msg'] as $key) {
            if (!isset($data[$key]) || !is_scalar($data[$key])) {
                continue;
            }
            $value = preg_replace('/[\r\n\t]+/', ' ', trim((string) $data[$key]));
            if ($value !== '') {
                $details[] = $key . '=' . substr($value, 0, 160);
            }
        }
    }
    error_log('QQ OAuth ' . $stage . ' failed' . ($details ? ': ' . implode(', ', $details) : ''));
}

function qq_handle_callback(string $code, string $state): ?array {
    // 验证 state 防止 CSRF
    $expectedState = (string)($_SESSION['qq_state'] ?? '');
    if ($expectedState === '' || !hash_equals($expectedState, $state)) {
        qq_log_api_failure('state validation');
        return null;
    }
    unset($_SESSION['qq_state']);

    // 用 code 换 access_token
    $tokenUrl = 'https://graph.qq.com/oauth2.0/token?' . http_build_query([
        'grant_type' => 'authorization_code',
        'client_id' => QQ_APPID,
        'client_secret' => QQ_APPSECRET,
        'code' => $code,
        'redirect_uri' => QQ_REDIRECT_URI,
        'fmt' => 'json',
    ]);

    $tokenResp = qq_http_get($tokenUrl);
    $tokenData = $tokenResp !== null ? qq_decode_response($tokenResp) : null;
    if (!is_array($tokenData) || !isset($tokenData['access_token'])) {
        qq_log_api_failure('token exchange', $tokenData);
        return null;
    }

    $accessToken = $tokenData['access_token'];

    // 获取 openid
    $openidUrl = 'https://graph.qq.com/oauth2.0/me?access_token=' . urlencode($accessToken) . '&fmt=json';
    $openidResp = qq_http_get($openidUrl);
    $openidData = $openidResp !== null ? qq_decode_response($openidResp) : null;
    if (!is_array($openidData) || !isset($openidData['openid'])) {
        qq_log_api_failure('openid lookup', $openidData);
        return null;
    }

    $openid = $openidData['openid'];
    $unionid = $openidData['unionid'] ?? null;

    // 获取用户信息
    $userInfoUrl = 'https://graph.qq.com/user/get_user_info?' . http_build_query([
        'access_token' => $accessToken,
        'oauth_consumer_key' => QQ_APPID,
        'openid' => $openid,
        'fmt' => 'json',
    ]);

    $userInfoResp = qq_http_get($userInfoUrl);
    $userInfo = $userInfoResp !== null ? qq_decode_response($userInfoResp) : null;
    if (!is_array($userInfo) || !isset($userInfo['nickname'])) {
        qq_log_api_failure('user info lookup', $userInfo);
        return null;
    }

    return [
        'openid' => $openid,
        'unionid' => $unionid,
        'username' => $userInfo['nickname'],
        'avatar_url' => $userInfo['figureurl_qq_2'] ?? $userInfo['figureurl_qq_1'] ?? '',
    ];
}
