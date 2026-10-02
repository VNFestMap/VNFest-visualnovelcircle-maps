<?php
declare(strict_types=1);

$root = dirname(__DIR__);
$temp = sys_get_temp_dir() . '/vnfest-multi-device-' . bin2hex(random_bytes(6));
mkdir($temp, 0700, true);
mkdir($temp . '/sessions', 0700);
$dbPath = $temp . '/fixture.db';
$db = new PDO('sqlite:' . $dbPath);
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->exec('PRAGMA journal_mode=WAL');
$db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, nickname TEXT, avatar_url TEXT, role TEXT, status TEXT, email TEXT, email_verified_at TEXT, password_hash TEXT, qq_openid TEXT, discord_id TEXT, is_audit INTEGER, profile_bio TEXT, membership_application_email_enabled INTEGER, display_membership_id INTEGER, language_preference TEXT)');
$db->exec("INSERT INTO users(id,username,role,status,email) VALUES (1,'fixture','member','active','fixture@example.com')");
$db->exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, ip_address TEXT, user_agent TEXT, expires_at TEXT, is_valid INTEGER DEFAULT 1)');
$db->exec('CREATE TABLE vnfest_session_bridge (session_id TEXT PRIMARY KEY, user_id INTEGER, payload_json TEXT, expires_at TEXT, is_valid INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT)');
$router = '<?php define("DB_PATH",' . var_export($dbPath, true) . '); define("DB_DRIVER","sqlite"); define("SESSION_LIFETIME",3600); require ' . var_export($root . '/includes/auth.php', true) . '; header("Content-Type: application/json"); try { $action=$_GET["action"]??"me"; if ($action==="login") createSession(1); elseif ($action==="logout") destroySession(); elseif ($action==="revoke") invalidateUserSessions(1); $user=getCurrentUser(); echo json_encode(["user_id"=>$user["id"]??null,"session_id"=>session_id()]); } catch(Throwable $e) { http_response_code(500); echo json_encode(["error"=>$e->getMessage()]); }';
file_put_contents($temp . '/router.php', $router);
$socket = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
if (!$socket) throw new RuntimeException($errstr);
$port = (int)substr(strrchr(stream_socket_get_name($socket, false), ':'), 1); fclose($socket);
$command = [PHP_BINARY, '-d', 'session.save_path=' . $temp . '/sessions', '-S', '127.0.0.1:' . $port, $temp . '/router.php'];
$pipes = [];
$process = proc_open($command, [0 => ['pipe','r'], 1 => ['file',$temp . '/server.log','a'], 2 => ['file',$temp . '/server.log','a']], $pipes, $root);
if (!is_resource($process)) throw new RuntimeException('Fixture server failed');

function check(bool $ok, string $message): void { if (!$ok) throw new RuntimeException($message); }
function requestFixture(int $port, string $action, ?string $cookie = null): array {
    $headers = 'Connection: close' . "\r\n" . ($cookie ? 'Cookie: PHPSESSID=' . $cookie . "\r\n" : '');
    $context = stream_context_create(['http'=>['header'=>$headers,'ignore_errors'=>true,'timeout'=>5]]);
    $body = file_get_contents('http://127.0.0.1:' . $port . '/?action=' . $action, false, $context);
    $responseHeaders = function_exists('http_get_last_response_headers') ? http_get_last_response_headers() : (get_defined_vars()['http_response_header'] ?? []);
    $newCookie = null;
    foreach ($responseHeaders as $header) if (preg_match('/^Set-Cookie: PHPSESSID=([^;]+)/i', $header, $m)) $newCookie = $m[1];
    return ['body'=>json_decode($body, true, 512, JSON_THROW_ON_ERROR),'cookie'=>$newCookie,'status'=>$responseHeaders[0]];
}
function activeFixture(int $port, string $cookie, bool $expected): void {
    $r = requestFixture($port, 'me', $cookie);
    check(($r['body']['user_id'] === 1) === $expected, 'Unexpected session access: ' . json_encode($r));
}
try {
    for ($i=0;$i<50;$i++) { $ready=@fsockopen('127.0.0.1',$port,$errno,$errstr,.1); if ($ready) { fclose($ready); break; } usleep(50000); }
    $cookies=[];
    for ($i=0;$i<3;$i++) { $r=requestFixture($port,'login'); check($r['body']['user_id']===1 && $r['cookie']!==null,'Login failed'); $cookies[]=$r['cookie']; }
    foreach ($cookies as $cookie) activeFixture($port,$cookie,true);
    foreach (['sessions','vnfest_session_bridge'] as $table) {
        $db->exec("CREATE TRIGGER fail_login BEFORE INSERT ON $table BEGIN SELECT RAISE(ABORT, 'injected write failure'); END");
        $failed=requestFixture($port,'login',$cookies[0]); check(str_contains($failed['status'],'500'),'Failure was swallowed');
        check($failed['cookie']===null || $failed['cookie']===$cookies[0],'Failed login changed cookie');
        foreach ($cookies as $cookie) activeFixture($port,$cookie,true);
        $db->exec('DROP TRIGGER fail_login');
    }
    $rotated=requestFixture($port,'login',$cookies[0]); check($rotated['cookie']!==$cookies[0],'Cookie not rotated');
    activeFixture($port,$cookies[0],false); activeFixture($port,$rotated['cookie'],true);
    activeFixture($port,$cookies[1],true); activeFixture($port,$cookies[2],true);
    requestFixture($port,'logout',$rotated['cookie']); activeFixture($port,$rotated['cookie'],false); activeFixture($port,$cookies[1],true);
    requestFixture($port,'revoke'); foreach ($cookies as $cookie) { activeFixture($port,$cookie,false); activeFixture($port,$cookie,false); }
    foreach (['sessions','vnfest_session_bridge'] as $table) {
        $key=$table==='sessions'?'id':'session_id'; $stmt=$db->prepare("SELECT is_valid FROM $table WHERE $key=?");
        $stmt->execute([$cookies[1]]); check((int)$stmt->fetchColumn()===0,'Revoked PHP session was resurrected'); $stmt->closeCursor();
    }
    $a=requestFixture($port,'login')['cookie']; $b=requestFixture($port,'login')['cookie'];
    $db->exec("UPDATE sessions SET expires_at='2000-01-01 00:00:00' WHERE id=" . $db->quote($a)); activeFixture($port,$a,false); activeFixture($port,$b,true);
    $db->exec("UPDATE users SET status='banned' WHERE id=1"); activeFixture($port,$b,false);
    $db->exec("UPDATE users SET status='active' WHERE id=1");
    $db->exec('DROP TABLE vnfest_session_bridge');
    $legacyA=requestFixture($port,'login')['cookie']; $legacyB=requestFixture($port,'login')['cookie']; activeFixture($port,$legacyA,true);activeFixture($port,$legacyB,true);
    echo "PHP multi-device session tests passed: independent cookies, transactional failure, rotation, logout, global revocation, expiry, deactivation and legacy-only compatibility.\n";
} finally {
    proc_terminate($process); foreach ($pipes as $pipe) if (is_resource($pipe)) fclose($pipe); proc_close($process);
    $stmt=null; $db=null;
    $files=new RecursiveIteratorIterator(new RecursiveDirectoryIterator($temp,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($files as $file) { if ($file->isDir()) rmdir($file->getPathname()); else unlink($file->getPathname()); } rmdir($temp);
}
