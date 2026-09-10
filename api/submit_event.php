<?php
// submit_event_api.php - 活动提交后端API（完整版）
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, PUT');
header('Access-Control-Allow-Headers: Content-Type, X-Admin-Token');

// 处理 OPTIONS 预检请求
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

$submissions_file = __DIR__ . '/../data/submissions_event.json';

// GET + action=read — 管理员读取活动提交数据
if ($_SERVER['REQUEST_METHOD'] === 'GET' && isset($_GET['action']) && $_GET['action'] === 'read') {
    require_once __DIR__ . '/../includes/auth.php';
    requireAdmin();

    $submissions = [];
    if (file_exists($submissions_file)) {
        $content = file_get_contents($submissions_file);
        $submissions = json_decode($content, true);
        if (!is_array($submissions)) $submissions = [];
    }
    echo json_encode($submissions, JSON_UNESCAPED_UNICODE);
    exit();
}

// 保存提交记录（管理员）
if ($_SERVER['REQUEST_METHOD'] === 'PUT' || ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_GET['action']) && $_GET['action'] === 'save')) {
    require_once __DIR__ . '/../includes/auth.php';
    require_once __DIR__ . '/../includes/admin_insights.php';
    $reviewer = requireAdmin();
    
    $input = json_decode(file_get_contents('php://input'), true);
    if ($input && is_array($input)) {
        $previous = [];
        if (file_exists($submissions_file)) {
            $decoded = json_decode((string)file_get_contents($submissions_file), true);
            if (is_array($decoded)) $previous = $decoded;
        }
        $input = adminInsightsStampReviewTransitions($previous, $input, (int)($reviewer['id'] ?? 0));
        file_put_contents($submissions_file, json_encode($input, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
        echo json_encode(['success' => true]);
    } else {
        echo json_encode(['success' => false, 'message' => '无效数据']);
    }
    exit();
}

// 普通提交
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = json_decode(file_get_contents('php://input'), true);
    
    if (!$input) {
        echo json_encode(['success' => false, 'message' => '无效的数据']);
        exit;
    }
    
    // 验证必填字段
    if (empty($input['event']) || empty($input['date']) || empty($input['clubName']) || empty($input['description'])) {
        echo json_encode(['success' => false, 'message' => '请填写所有必填字段']);
        exit;
    }
    
    // 读取已有提交记录
    $submissions = [];
    if (file_exists($submissions_file)) {
        $submissions = json_decode(file_get_contents($submissions_file), true);
        if (!is_array($submissions)) {
            $submissions = [];
        }
    }
    
    // 生成新ID
    $maxId = 0;
    foreach ($submissions as $item) {
        if (($item['id'] ?? 0) > $maxId) $maxId = $item['id'];
    }
    
    // 添加新记录
    $newSubmission = [
        'id' => $maxId + 1,
        'event' => $input['event'],
        'date' => $input['date'],
        'clubName' => $input['clubName'],
        'location' => $input['location'] ?? '',
        'link' => $input['link'] ?? '',
        'description' => $input['description'],
        'image' => $input['image'] ?? '',
        'submitter' => $input['submitter'] ?? '',
        'offical' => 0,
        'status' => 'pending',
        'submitted_at' => date('Y-m-d H:i:s')
    ];
    $submissions[] = $newSubmission;
    
    // 保存
    $success = file_put_contents($submissions_file, json_encode($submissions, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    
    if ($success !== false) {
        echo json_encode(['success' => true, 'message' => '提交成功']);
    } else {
        echo json_encode(['success' => false, 'message' => '保存失败，请检查文件权限']);
    }
    exit();
}

echo json_encode(['success' => false, 'message' => '不支持的请求方法']);
?>
