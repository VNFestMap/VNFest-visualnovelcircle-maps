<?php
declare(strict_types=1);

// Regression test for the cookie-scope migration from a host-only PHPSESSID
// to the shared .map.vnfest.top session cookie.

$repoRoot = dirname(__DIR__);
$sessionPath = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'vnfest-auth-session-' . bin2hex(random_bytes(6));
if (!mkdir($sessionPath, 0700, true) && !is_dir($sessionPath)) {
    throw new RuntimeException('Unable to create temporary session directory');
}

$port = random_int(18080, 18980);
$command = sprintf(
    '%s -d session.save_path=%s -S 127.0.0.1:%d -t %s',
    escapeshellarg(PHP_BINARY),
    escapeshellarg($sessionPath),
    $port,
    escapeshellarg($repoRoot)
);

$pipes = [];
$process = proc_open(
    $command,
    [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
    $pipes,
    $repoRoot
);
if (!is_resource($process)) {
    throw new RuntimeException('Unable to start PHP fixture server');
}

try {
    $url = "http://127.0.0.1:{$port}/api/auth.php?action=me";
    $context = stream_context_create([
        'http' => [
            'method' => 'GET',
            'header' => implode("\r\n", [
                'Host: www.map.vnfest.top',
                'Cookie: PHPSESSID=legacy-host-only-session',
                'Connection: close',
            ]),
            'ignore_errors' => true,
            'timeout' => 3,
        ],
    ]);

    $response = false;
    $deadline = microtime(true) + 5;
    do {
        $response = @file_get_contents($url, false, $context);
        if ($response !== false || microtime(true) >= $deadline) {
            break;
        }
        usleep(100000);
    } while (true);

    if ($response === false) {
        throw new RuntimeException('PHP fixture server did not respond');
    }

    $setCookies = array_values(array_filter(
        $http_response_header ?? [],
        static fn(string $header): bool => stripos($header, 'Set-Cookie:') === 0
    ));
    $hostOnlyDeletion = false;
    $sharedSessionCookie = false;
    foreach ($setCookies as $header) {
        $value = trim(substr($header, strlen('Set-Cookie:')));
        $isDeletion = preg_match('/^PHPSESSID=(?:\s*|deleted);/i', $value) === 1
            && preg_match('/(?:expires|max-age)\s*=\s*(?:Thu, 01 Jan 1970|0|-\d+)/i', $value) === 1;
        if ($isDeletion && stripos($value, 'domain=') === false) {
            $hostOnlyDeletion = true;
        }
        if (preg_match('/^PHPSESSID=[^;]+;/i', $value) === 1
            && stripos($value, 'domain=.map.vnfest.top') !== false) {
            $sharedSessionCookie = true;
        }
    }

    if (!$hostOnlyDeletion) {
        throw new RuntimeException('Expected host-only PHPSESSID deletion cookie during migration');
    }
    if (!$sharedSessionCookie) {
        throw new RuntimeException('Expected shared .map.vnfest.top PHPSESSID cookie');
    }
    $scopeMarker = array_filter(
        $setCookies,
        static fn(string $header): bool => stripos($header, 'Set-Cookie: VNFEST_SESSION_SCOPE=shared;') === 0
    );
    if (!$scopeMarker) {
        throw new RuntimeException('Expected session scope migration marker cookie');
    }

    file_put_contents($sessionPath . DIRECTORY_SEPARATOR . 'sess_preserve-session', 'user_id|i:123;');
    $preserveContext = stream_context_create([
        'http' => [
            'method' => 'GET',
            'header' => implode("\r\n", [
                'Host: www.map.vnfest.top',
                'Cookie: PHPSESSID=preserve-session',
                'Connection: close',
            ]),
            'ignore_errors' => true,
            'timeout' => 3,
        ],
    ]);
    @file_get_contents($url, false, $preserveContext);
    $preserveSetCookies = array_values(array_filter(
        $http_response_header ?? [],
        static fn(string $header): bool => stripos($header, 'Set-Cookie:') === 0
    ));
    $preservedSession = array_filter(
        $preserveSetCookies,
        static fn(string $header): bool => stripos($header, 'Set-Cookie: PHPSESSID=preserve-session;') === 0
            && stripos($header, 'domain=.map.vnfest.top') !== false
    );
    if (!$preservedSession) {
        throw new RuntimeException('Legacy session identity must be preserved in the shared cookie');
    }

    $secondContext = stream_context_create([
        'http' => [
            'method' => 'GET',
            'header' => implode("\r\n", [
                'Host: www.map.vnfest.top',
                'Cookie: PHPSESSID=shared-session; VNFEST_SESSION_SCOPE=shared',
                'Connection: close',
            ]),
            'ignore_errors' => true,
            'timeout' => 3,
        ],
    ]);
    @file_get_contents($url, false, $secondContext);
    $secondSetCookies = array_values(array_filter(
        $http_response_header ?? [],
        static fn(string $header): bool => stripos($header, 'Set-Cookie:') === 0
    ));
    foreach ($secondSetCookies as $header) {
        $value = trim(substr($header, strlen('Set-Cookie:')));
        if (preg_match('/^PHPSESSID=(?:\s*|deleted);/i', $value) === 1
            && preg_match('/(?:expires|max-age)\s*=\s*(?:Thu, 01 Jan 1970|0|-\d+)/i', $value) === 1
            && stripos($value, 'domain=') === false) {
            throw new RuntimeException('Session scope migration must not repeat after marker is present');
        }
    }

    echo "auth session cookie contract passed\n";
} finally {
    foreach ($pipes as $pipe) {
        if (is_resource($pipe)) {
            fclose($pipe);
        }
    }
    proc_terminate($process);
    proc_close($process);
    foreach (glob($sessionPath . DIRECTORY_SEPARATOR . 'sess_*') ?: [] as $sessionFile) {
        @unlink($sessionFile);
    }
    @rmdir($sessionPath);
}
