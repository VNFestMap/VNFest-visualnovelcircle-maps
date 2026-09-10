<?php
// api/submit_publication.php - 刊物征集投稿 API
// POST（公开）: 提交刊物征集
// PUT / POST ?action=save（管理员）: 批量更新状态
// GET（管理员）: 读取全部投稿

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Admin-Token');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

$dataFile = __DIR__ . '/../data/submissions_publication.json';

// GET - 管理员读取
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    require_once __DIR__ . '/../includes/auth.php';
    requireAdmin();
    if (file_exists($dataFile)) {
        echo file_get_contents($dataFile);
    } else {
        echo json_encode([]);
    }
    exit();
}

// POST - 公开提交
if ($_SERVER['REQUEST_METHOD'] === 'POST' && !isset($_GET['action'])) {
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input || empty($input['clubName']) || empty($input['publicationName'])) {
        echo json_encode(['success' => false, 'message' => '请填写同好会名称和刊物名称']);
        exit();
    }

    $current = [];
    if (file_exists($dataFile)) {
        $content = json_decode(file_get_contents($dataFile), true);
        if (is_array($content)) $current = $content;
    }

    $maxId = 0;
    foreach ($current as $item) {
        if (($item['id'] ?? 0) > $maxId) $maxId = $item['id'];
    }

    $newItem = [
        'id' => $maxId + 1,
        'clubName' => $input['clubName'],
        'publicationName' => $input['publicationName'],
        'submitContact' => $input['submitContact'] ?? '',
        'submitLink' => $input['submitLink'] ?? '',
        'deadline' => $input['deadline'] ?? '',
        'description' => $input['description'] ?? '',
        'image_url' => $input['image_url'] ?? '',
        'club_ids' => $input['club_ids'] ?? [],
        'status' => 'pending',
        'submitted_at' => date('Y-m-d H:i:s'),
        'approved_at' => null,
        'rejected_at' => null,
        'publication_id' => null
    ];

    $current[] = $newItem;
    file_put_contents($dataFile, json_encode($current, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    echo json_encode(['success' => true, 'message' => '投稿成功' . "，" . '请等待管理员审核']);
    exit();
}

// PUT / POST ?action=save - 管理员批量保存
require_once __DIR__ . '/../includes/auth.php';
$currentUser = requireAdmin();

if ($_SERVER['REQUEST_METHOD'] === 'PUT' || ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_GET['action']) && $_GET['action'] === 'save')) {
    $input = json_decode(file_get_contents('php://input'), true);
    if (!is_array($input)) {
        echo json_encode(['success' => false, 'message' => '无效数据']);
        exit();
    }
    require_once __DIR__ . '/../includes/admin_insights.php';
    $previous = [];
    if (file_exists($dataFile)) {
        $decoded = json_decode((string)file_get_contents($dataFile), true);
        if (is_array($decoded)) $previous = $decoded;
    }
    $input = adminInsightsStampReviewTransitions($previous, $input, (int)($currentUser['id'] ?? 0));
    file_put_contents($dataFile, json_encode($input, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    echo json_encode(['success' => true, 'message' => '保存成功']);
    exit();
}

echo json_encode(['success' => false, 'message' => '不支持的请求方法']);
