<?php
// api/quiz_hub.php - 题库区：本地公开题库 + 共享题库 + makoquiz 市集连携
//
// 动作：
//   login_state    GET  当前登录态（供前端提示）
//   local          GET  本站已发布的答题考核题库清单（题数/题型分布，不含答案）
//   local_quiz     GET  某考核的题目内容（剥离答案），供设计器导入
//   shared_list    GET  用户上传的共享题库清单（不含内容）
//   shared_quiz    GET  某共享题库的题目（剥离答案）
//   shared_upload  POST 上传共享题库（登录，multipart：file + title + description）
//   shared_delete  POST 删除自己上传的共享题库（或平台管理员）
//   gallery        GET  代理 makoquiz 市集列表（避免跨域）
//   cover          GET  代理市集封面图（二进制透传）
//   import         下载市集题库包 → 解出 presentation.json → 转译为本站题库格式
//
// 共享题库入库前一律剥离答案，下载方拿到的是纯题目，答案由使用者自行补齐。
// makoquiz 地址：config.php 的 MAKOQUIZ_URL（默认 http://127.0.0.1:3001，同机部署）

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/audit.php';
require_once __DIR__ . '/../includes/rate_limit.php';
require_once __DIR__ . '/../includes/display_club.php';
require_once __DIR__ . '/../includes/recognition/pipeline.php';
require_once __DIR__ . '/../includes/recognition/quiz.php';
require_once __DIR__ . '/../includes/recognition/quiz_import.php';

function quizHubRespond(array $payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

function makoquizBase(): string {
    return defined('MAKOQUIZ_URL') ? rtrim((string)MAKOQUIZ_URL, '/') : 'http://127.0.0.1:3001';
}

// 按字符数截断（无 mbstring 的环境退回 preg_split 逐字符处理，不会切坏 UTF-8）
function quizHubClip(string $s, int $max): string {
    if (function_exists('mb_substr')) return mb_substr($s, 0, $max);
    $chars = preg_split('//u', $s, -1, PREG_SPLIT_NO_EMPTY);
    return is_array($chars) ? implode('', array_slice($chars, 0, $max)) : substr($s, 0, $max);
}

// 共享题库表（首次访问时建表，双驱动 DDL）
function quizHubEnsureSharedTable(PDO $db): void {
    static $done = false;
    if ($done) return;
    $done = true;
    $isMysql = defined('DB_DRIVER') && DB_DRIVER === 'mysql';
    $ddl = $isMysql
        ? "CREATE TABLE IF NOT EXISTS quiz_shares (
             id INT AUTO_INCREMENT PRIMARY KEY,
             title VARCHAR(200) NOT NULL,
             description VARCHAR(500) NOT NULL DEFAULT '',
             uploader_id INT NOT NULL,
             uploader_name VARCHAR(100) NOT NULL DEFAULT '',
             question_count INT NOT NULL DEFAULT 0,
             type_counts VARCHAR(500) NOT NULL DEFAULT '{}',
             content MEDIUMTEXT NOT NULL,
             upload_token VARCHAR(32) NOT NULL DEFAULT '',
             downloads INT NOT NULL DEFAULT 0,
             created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
           )"
        : "CREATE TABLE IF NOT EXISTS quiz_shares (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             title TEXT NOT NULL,
             description TEXT NOT NULL DEFAULT '',
             uploader_id INTEGER NOT NULL,
             uploader_name TEXT NOT NULL DEFAULT '',
             question_count INTEGER NOT NULL DEFAULT 0,
             type_counts TEXT NOT NULL DEFAULT '{}',
             content TEXT NOT NULL,
             upload_token TEXT NOT NULL DEFAULT '',
             downloads INTEGER NOT NULL DEFAULT 0,
             created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
           )";
    try {
        $db->exec($ddl);
    } catch (\Throwable $e) {
        // 建表失败不在这里中断，后续 SQL 会报更具体的错
    }
    // 历史库可能缺 upload_token 列（幂等补列；不带默认值以兼容 MySQL 5.7 的 TEXT 限制）
    try { $db->exec('ALTER TABLE quiz_shares ADD COLUMN upload_token TEXT'); } catch (\Throwable $e) { /* 已有该列 */ }
}

// 服务端代理请求（短超时 + UA 标识）
function makoquizFetch(string $path): ?array {
    $ctx = stream_context_create(['http' => [
        'method' => 'GET',
        'timeout' => 15,
        'ignore_errors' => true,
        'header' => "User-Agent: VNFmap-QuizHub/1.0\r\n",
    ]]);
    $raw = @file_get_contents(makoquizBase() . $path, false, $ctx);
    if ($raw === false) return null;
    return [$raw, $http_response_header ?? []];
}

$action = $_GET['action'] ?? '';
$db = getDB();

switch ($action) {

    // ---- 登录态（题库区上传/市集导入需要登录，页面据此提示） ----
    case 'login_state': {
        $user = getCurrentUser();
        quizHubRespond([
            'success' => true,
            'logged_in' => (bool)$user,
            'user_id' => $user ? (int)$user['id'] : 0,
            'username' => $user ? (string)$user['username'] : '',
        ]);
    }

    // ---- 共享题库清单 ----
    case 'shared_list': {
        quizHubEnsureSharedTable($db);
        $q = trim((string)($_GET['q'] ?? ''));
        if ($q !== '') {
            $stmt = $db->prepare(
                "SELECT id, title, description, uploader_id, uploader_name, question_count, type_counts, downloads, created_at
                 FROM quiz_shares WHERE title LIKE ? OR uploader_name LIKE ? ORDER BY id DESC LIMIT 200"
            );
            $stmt->execute(['%' . $q . '%', '%' . $q . '%']);
        } else {
            $stmt = $db->query(
                "SELECT id, title, description, uploader_id, uploader_name, question_count, type_counts, downloads, created_at
                 FROM quiz_shares ORDER BY id DESC LIMIT 200"
            );
        }
        $items = [];
        foreach ($stmt->fetchAll() as $row) {
            $row['id'] = (int)$row['id'];
            $row['question_count'] = (int)$row['question_count'];
            $row['downloads'] = (int)$row['downloads'];
            $row['type_counts'] = json_decode((string)$row['type_counts'], true) ?: [];
            $row['uploader_id'] = (int)$row['uploader_id'];
            $items[] = $row;
        }
        quizHubRespond(['success' => true, 'items' => $items]);
    }

    // ---- 共享题库内容（剥离答案后下发） ----
    case 'shared_quiz': {
        quizHubEnsureSharedTable($db);
        $id = (int)($_GET['id'] ?? 0);
        $stmt = $db->prepare('SELECT id, title, content FROM quiz_shares WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        if (!$row) quizHubRespond(['success' => false, 'message' => '题库不存在'], 404);
        $quiz = json_decode((string)$row['content'], true);
        if (!is_array($quiz) || empty($quiz['questions'])) quizHubRespond(['success' => false, 'message' => '题库内容已损坏'], 500);
        // 入库时已剥离答案，这里双保险再剥一次（防止历史脏数据）
        foreach ($quiz['questions'] as &$qq) unset($qq['answer'], $qq['answer_text'], $qq['answer_texts']);
        unset($qq);
        $db->prepare('UPDATE quiz_shares SET downloads = downloads + 1 WHERE id = ?')->execute([$id]);
        quizHubRespond(['success' => true, 'title' => (string)$row['title'], 'quiz' => $quiz]);
    }

    // ---- 上传共享题库 ----
    case 'shared_upload': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') quizHubRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        checkRateLimit('quiz_hub_share', 20, 1);
        quizHubEnsureSharedTable($db);

        $file = $_FILES['file'] ?? null;
        if (!$file || ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            quizHubRespond(['success' => false, 'message' => '请选择要上传的题库 JSON 文件']);
        }
        if ((int)$file['size'] > 5 * 1024 * 1024) quizHubRespond(['success' => false, 'message' => '文件超过 5MB 上限'], 413);
        $raw = file_get_contents((string)$file['tmp_name']);
        $data = json_decode((string)$raw, true);
        if (!is_array($data)) quizHubRespond(['success' => false, 'message' => '文件不是合法的 JSON']);

        // 兼容 {quiz:{questions,settings}} 与 {questions,...} 两种包装（与设计器导入一致）
        $quiz = isset($data['quiz']) && is_array($data['quiz']) ? $data['quiz'] : $data;
        if (empty($quiz['questions']) || !is_array($quiz['questions'])) {
            quizHubRespond(['success' => false, 'message' => '题库里没有题目（需包含 questions 数组）']);
        }
        if (!isset($quiz['settings']) || !is_array($quiz['settings'])) $quiz['settings'] = [];
        $err = recogValidateQuizContent($quiz);
        if ($err !== null) quizHubRespond(['success' => false, 'message' => '题库校验不通过：' . $err]);

        // 共享出库的答案对所有人可见，入库前一律剥离（校验已过，剩纯题目）
        foreach ($quiz['questions'] as &$qq) unset($qq['answer'], $qq['answer_text'], $qq['answer_texts']);
        unset($qq);

        $typeCounts = [];
        foreach ($quiz['questions'] as $qq) {
            $t = (string)($qq['type'] ?? '');
            $typeCounts[$t] = ($typeCounts[$t] ?? 0) + 1;
        }
        $title = trim((string)($_POST['title'] ?? ''));
        if ($title === '') $title = '未命名题库';
        $title = quizHubClip($title, 60);
        $desc = quizHubClip(trim((string)($_POST['description'] ?? '')), 200);
        $displayName = ((string)($user['nickname'] ?? '')) !== '' ? (string)$user['nickname'] : (string)$user['username'];

        $token = bin2hex(random_bytes(8));
        $stmt = $db->prepare(
            'INSERT INTO quiz_shares (title, description, uploader_id, uploader_name, question_count, type_counts, content, upload_token)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $title, $desc, (int)$user['id'], quizHubClip($displayName, 100),
            count($quiz['questions']), json_encode($typeCounts, JSON_UNESCAPED_UNICODE),
            json_encode(['questions' => $quiz['questions'], 'settings' => $quiz['settings']], JSON_UNESCAPED_UNICODE),
            $token,
        ]);
        // 回查新行 id（不依赖 lastInsertId，避免多表交叉插入时取到别的表的行 id）
        $st = $db->prepare('SELECT id FROM quiz_shares WHERE upload_token = ?');
        $st->execute([$token]);
        $newId = (int)$st->fetchColumn();
        if ($newId <= 0) quizHubRespond(['success' => false, 'message' => '保存失败，请重试'], 500);
        logAction('recog_quiz_share_uploaded', 'quiz_share', $newId, ['title' => $title]);
        quizHubRespond(['success' => true, 'id' => $newId, 'message' => '已上传，答案已剥离']);
    }

    // ---- 删除共享题库（上传者本人或平台管理员） ----
    case 'shared_delete': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') quizHubRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        quizHubEnsureSharedTable($db);
        $id = (int)((json_decode(file_get_contents('php://input'), true) ?: [])['id'] ?? 0);
        $stmt = $db->prepare('SELECT id, uploader_id FROM quiz_shares WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        if (!$row) quizHubRespond(['success' => false, 'message' => '题库不存在'], 404);
        if ((int)$row['uploader_id'] !== (int)$user['id'] && $user['role'] !== 'super_admin') {
            quizHubRespond(['success' => false, 'message' => '只能删除自己上传的题库'], 403);
        }
        $db->prepare('DELETE FROM quiz_shares WHERE id = ?')->execute([$id]);
        logAction('recog_quiz_share_deleted', 'quiz_share', $id, []);
        quizHubRespond(['success' => true]);
    }

    // ---- 本站公开题库清单 ----
    case 'local': {
        $stmt = $db->query(
            "SELECT id, club_id, country, title, intro FROM recognition_programs
             WHERE type = 'assessment' AND status = 'published' ORDER BY id DESC LIMIT 100"
        );
        $items = [];
        foreach ($stmt->fetchAll() as $p) {
            $version = recogPublishedVersion($db, (int)$p['id']);
            if (!$version) continue;
            $quiz = $version['content']['quiz'] ?? [];
            $questions = $quiz['questions'] ?? [];
            if (!count($questions)) continue;
            $typeCounts = [];
            foreach ($questions as $q) {
                $t = (string)($q['type'] ?? '');
                $typeCounts[$t] = ($typeCounts[$t] ?? 0) + 1;
            }
            $club = displayClubRecord((int)$p['club_id'], (string)$p['country']);
            $items[] = [
                'id' => (int)$p['id'],
                'title' => (string)$p['title'],
                'intro' => (string)($p['intro'] ?? ''),
                'club_name' => $club['name'] ?? ('同好会 #' . $p['club_id']),
                'question_count' => count($questions),
                'type_counts' => $typeCounts,
                'time_limit' => (int)($quiz['settings']['time_limit'] ?? 0),
            ];
        }
        quizHubRespond(['success' => true, 'items' => $items]);
    }

    // ---- 单个考核的题目（剥离答案） ----
    case 'local_quiz': {
        $programId = (int)($_GET['id'] ?? 0);
        $stmt = $db->prepare("SELECT * FROM recognition_programs WHERE id = ? AND type = 'assessment' AND status = 'published'");
        $stmt->execute([$programId]);
        $program = $stmt->fetch();
        if (!$program) quizHubRespond(['success' => false, 'message' => '题库不存在'], 404);
        $version = recogPublishedVersion($db, $programId);
        $quiz = $version['content']['quiz'] ?? [];
        // 剥离答案后交给前端；设置保留原考核的考试设置作为参考
        $safe = ['questions' => [], 'settings' => $quiz['settings'] ?? []];
        foreach (($quiz['questions'] ?? []) as $q) {
            unset($q['answer'], $q['answer_text'], $q['answer_texts']);
            $safe['questions'][] = $q;
        }
        quizHubRespond(['success' => true, 'title' => (string)$program['title'], 'quiz' => $safe]);
    }

    // ---- 市集列表（代理） ----
    case 'gallery': {
        $qs = [];
        foreach (['q', 'type', 'sort', 'limit', 'offset'] as $k) {
            if (isset($_GET[$k]) && $_GET[$k] !== '') $qs[] = $k . '=' . urlencode((string)$_GET[$k]);
        }
        $got = makoquizFetch('/api/gallery' . ($qs ? '?' . implode('&', $qs) : ''));
        if ($got === null) quizHubRespond(['success' => false, 'message' => '连不上题库市集服务（makoquiz）'], 502);
        [$raw] = $got;
        $data = json_decode($raw, true);
        if (!is_array($data)) quizHubRespond(['success' => false, 'message' => '市集返回了无法解析的数据'], 502);
        $data['success'] = true;
        $data['base_url'] = makoquizBase();
        quizHubRespond($data);
    }

    // ---- 市集封面（二进制透传） ----
    case 'cover': {
        $id = (string)($_GET['id'] ?? '');
        if ($id === '' || !preg_match('/^[A-Za-z0-9_\-]+$/', $id)) quizHubRespond(['success' => false, 'message' => '参数非法'], 400);
        $got = makoquizFetch('/api/gallery/' . urlencode($id) . '/cover');
        if ($got === null) { http_response_code(502); exit; }
        [$raw, $headers] = $got;
        foreach ($headers as $h) {
            if (stripos($h, 'Content-Type:') === 0) { header(trim($h)); break; }
        }
        header('Cache-Control: public, max-age=86400');
        echo $raw;
        exit;
    }

    // ---- 市集题库转译导入 ----
    case 'import': {
        $user = requireLogin();
        checkRateLimit('quiz_hub_import', 10, 1);
        $id = (string)($_GET['id'] ?? '');
        if ($id === '' || !preg_match('/^[A-Za-z0-9_\-]+$/', $id)) quizHubRespond(['success' => false, 'message' => '参数非法'], 400);

        $got = makoquizFetch('/api/gallery/' . urlencode($id) . '/download');
        if ($got === null) quizHubRespond(['success' => false, 'message' => '连不上题库市集服务（makoquiz）'], 502);
        [$raw] = $got;
        if (strlen($raw) > 50 * 1024 * 1024) quizHubRespond(['success' => false, 'message' => '题库包超过 50MB 上限'], 413);
        if (substr($raw, 0, 2) !== 'PK') quizHubRespond(['success' => false, 'message' => '市集返回的不是有效的题库包'], 502);

        if (!class_exists('ZipArchive')) quizHubRespond(['success' => false, 'message' => '服务器缺少 zip 扩展，无法解析题库包'], 500);

        // 落到临时文件再解包（ZipArchive 需要路径）
        $tmp = tempnam(sys_get_temp_dir(), 'quizhub_');
        file_put_contents($tmp, $raw);
        $zip = new ZipArchive();
        if ($zip->open($tmp) !== true) { @unlink($tmp); quizHubRespond(['success' => false, 'message' => '题库包损坏，无法解压'], 502); }

        $pres = null;
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $name = $zip->getNameIndex($i);
            if (strtolower(basename($name)) === 'presentation.json') {
                $pres = json_decode((string)$zip->getFromIndex($i), true);
                break;
            }
        }
        $zip->close();
        @unlink($tmp);
        if (!is_array($pres)) quizHubRespond(['success' => false, 'message' => '题库包里找不到 presentation.json'], 502);

        $converted = recogConvertMakoquizPresentation($pres);
        if (!count($converted['questions'])) {
            $converted['notes'][] = '这份题库没有可转译的题目';
            quizHubRespond(['success' => false, 'message' => '没有可转译的题目', 'notes' => $converted['notes']], 422);
        }

        quizHubRespond([
            'success' => true,
            'source_title' => (string)($pres['title'] ?? ''),
            'quiz' => ['questions' => $converted['questions'], 'settings' => $converted['settings']],
            'converted_count' => count($converted['questions']),
            'notes' => $converted['notes'],
        ]);
    }

    default:
        quizHubRespond(['success' => false, 'message' => '未知动作'], 400);
}
