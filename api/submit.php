<?php
// submit_api.php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Admin-Token');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

$submissions_file = __DIR__ . '/../data/submissions.json';

// GET + action=read — 管理员读取提交数据
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

// PUT + action=save — 管理员保存提交数据
if ($_SERVER['REQUEST_METHOD'] === 'PUT' && isset($_GET['action']) && $_GET['action'] === 'save') {
    require_once __DIR__ . '/../includes/auth.php';
    requireAdmin();

    $input = json_decode(file_get_contents('php://input'), true);
    if ($input && is_array($input)) {
        file_put_contents($submissions_file, json_encode($input, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
        echo json_encode(['success' => true]);
    } else {
        echo json_encode(['success' => false, 'message' => '无效数据']);
    }
    exit();
}

// 获取 POST 数据
$input = json_decode(file_get_contents('php://input'), true);

if (!$input) {
    echo json_encode(['success' => false, 'message' => '无效的数据']);
    exit;
}

// 同好会提交需要登录：审批通过后需要自动为该用户绑定对应同好会身份
require_once __DIR__ . '/../includes/auth.php';
$submitUser = requireLogin();

// 申请人角色：其他/成员/管理员/负责人 → external/member/manager/representative
$applicantRole = (string)($input['applicant_role'] ?? ($input['role'] ?? 'external'));
$roleMap = [
    'other' => 'external',
    'external' => 'external',
    'member' => 'member',
    'manager' => 'manager',
    'representative' => 'representative',
];
$applicantRole = $roleMap[$applicantRole] ?? 'external';

$input['user_id'] = (int)$submitUser['id'];
$input['applicant_role'] = $applicantRole;
$input['submitter_username'] = $submitUser['username'] ?? '';
$input['submitter_nickname'] = $submitUser['nickname'] ?? '';

// 读取已有提交记录
$submissions = [];
if (file_exists($submissions_file)) {
    $content = file_get_contents($submissions_file);
    $submissions = json_decode($content, true);
    if (!is_array($submissions)) $submissions = [];
}

// 生成新ID
$maxId = 0;
foreach ($submissions as $item) {
    if (($item['id'] ?? 0) > $maxId) $maxId = $item['id'];
}

// 添加新记录
$input['id'] = $maxId + 1;
$input['status'] = 'pending';
$input['submitted_at'] = date('Y-m-d H:i:s');
$submissions[] = $input;

// 保存
$success = file_put_contents($submissions_file, json_encode($submissions, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));

if ($success !== false) {
    echo json_encode(['success' => true, 'message' => '提交成功', 'id' => $input['id']]);
} else {
    echo json_encode(['success' => false, 'message' => '保存失败，请检查文件权限']);
}
?>