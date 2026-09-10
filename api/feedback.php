<?php
// api/feedback.php - bug reports and feature suggestions

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Admin-Token');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

$feedbackFile = __DIR__ . '/../data/feedback.json';

function readFeedback(string $file): array {
    if (!file_exists($file)) return [];
    $rows = json_decode(file_get_contents($file), true);
    return is_array($rows) ? $rows : [];
}

function writeFeedback(string $file, array $rows): bool {
    $dir = dirname($file);
    if (!is_dir($dir)) mkdir($dir, 0755, true);
    $json = json_encode($rows, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    return file_put_contents($file, $json, LOCK_EX) !== false;
}

function textLength(string $value): int {
    return function_exists('mb_strlen') ? mb_strlen($value, 'UTF-8') : strlen($value);
}

// GET + action=read — 管理员读取反馈数据
if ($_SERVER['REQUEST_METHOD'] === 'GET' && ($_GET['action'] ?? '') === 'read') {
    require_once __DIR__ . '/../includes/auth.php';
    requireAdmin();

    echo json_encode(readFeedback($feedbackFile), JSON_UNESCAPED_UNICODE);
    exit();
}

if ($_SERVER['REQUEST_METHOD'] === 'PUT' && ($_GET['action'] ?? '') === 'save') {
    require_once __DIR__ . '/../includes/auth.php';
    require_once __DIR__ . '/../includes/admin_insights.php';
    $reviewer = requireAdmin();

    $input = json_decode(file_get_contents('php://input'), true);
    if (!is_array($input)) {
        echo json_encode(['success' => false, 'message' => '无效数据']);
        exit();
    }

    $previous = readFeedback($feedbackFile);
    $input = adminInsightsStampReviewTransitions($previous, $input, (int)($reviewer['id'] ?? 0));
    echo json_encode(['success' => writeFeedback($feedbackFile, $input)]);
    exit();
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'message' => '仅支持 POST 请求']);
    exit();
}

$input = json_decode(file_get_contents('php://input'), true);
if (!is_array($input)) {
    echo json_encode(['success' => false, 'message' => '无效数据']);
    exit();
}

$type = trim((string)($input['type'] ?? ''));
$title = trim((string)($input['title'] ?? ''));
$content = trim((string)($input['content'] ?? ''));

if (!in_array($type, ['bug', 'feature', 'other'], true)) {
    echo json_encode(['success' => false, 'message' => '请选择反馈类型']);
    exit();
}
if ($title === '' || textLength($title) > 120) {
    echo json_encode(['success' => false, 'message' => '请填写 1-120 字的标题']);
    exit();
}
if ($content === '' || textLength($content) > 3000) {
    echo json_encode(['success' => false, 'message' => '请填写 1-3000 字的说明']);
    exit();
}

$rows = readFeedback($feedbackFile);
$maxId = 0;
foreach ($rows as $row) {
    $maxId = max($maxId, (int)($row['id'] ?? 0));
}

$entry = [
    'id' => $maxId + 1,
    'type' => $type,
    'title' => $title,
    'content' => $content,
    'page_url' => trim((string)($input['page_url'] ?? '')),
    'contact' => trim((string)($input['contact'] ?? '')),
    'device' => trim((string)($input['device'] ?? '')),
    'status' => 'pending',
    'submitted_at' => date('Y-m-d H:i:s'),
    'user_agent' => $_SERVER['HTTP_USER_AGENT'] ?? '',
];

$rows[] = $entry;

if (!writeFeedback($feedbackFile, $rows)) {
    echo json_encode(['success' => false, 'message' => '保存失败，请稍后重试']);
    exit();
}

echo json_encode(['success' => true, 'message' => '提交成功', 'id' => $entry['id']]);
