<?php
declare(strict_types=1);

// Regression test for the cookie-scope migration from a host-only PHPSESSID
// to the shared .map.vnfest.top session cookie.

$repoRoot = dirname(__DIR__);
$sessionPath = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'vnfest-auth-session-' . bin2hex(random_bytes(6));
if (!mkdir($sessionPath, 0700, true) && !is_dir($sessionPath)) {
    throw new RuntimeException('Unable to create temporary session directory');
}

$dbPath = $sessionPath . DIRECTORY_SEPARATOR . 'fixture.db';
$db = new PDO('sqlite:' . $dbPath);
$db->exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, expires_at TEXT, is_valid INTEGER DEFAULT 1)');
$db->exec('CREATE TABLE vnfest_session_bridge (session_id TEXT PRIMARY KEY, user_id INTEGER, payload_json TEXT, expires_at TEXT, is_valid INTEGER, created_at TEXT, updated_at TEXT)');
$db->exec("INSERT INTO sessions(id,user_id,expires_at) VALUES ('preserve-session',123,datetime('now','+1 hour'))");
$db = null;
$router = $sessionPath . DIRECTORY_SEPARATOR . 'router.php';
file_put_contents($router, '<?php define("DB_PATH",' . var_export($dbPath,true) . '); define("DB_DRIVER","sqlite"); require ' . var_export($repoRoot . '/includes/auth.php',true) . '; initSession(); header("Content-Type: application/json"); echo json_encode(["session_id"=>session_id()]);');
$socket = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
if (!$socket) throw new RuntimeException($errstr);
$port = (int)substr(strrchr(stream_socket_get_name($socket,false), ':'),1); fclose($socket);
$command = [PHP_BINARY, '-d', 'session.save_path=' . $sessionPath, '-S', '127.0.0.1:' . $port, $router];

$pipes = [];
$process = proc_open(
    $command,
    [0 => ['pipe', 'r'], 1 => ['file', $sessionPath . '/server.log', 'a'], 2 => ['file', $sessionPath . '/server.log', 'a']],
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
    foreach (glob($sessionPath . DIRECTORY_SEPARATOR . '*') ?: [] as $sessionFile) {
        @unlink($sessionFile);
    }
    @rmdir($sessionPath);
}
