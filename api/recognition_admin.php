<?php
// api/recognition_admin.php - 同好会运营：提交审核 / 兑换码管理
// 动作: submissions / review / claim_generate / claim_list
// 审核与兑换码生成均要求该同好会的相应角色权限。

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/audit.php';
require_once __DIR__ . '/../includes/display_club.php';
require_once __DIR__ . '/../includes/recognition/roles.php';
require_once __DIR__ . '/../includes/recognition/events.php';
require_once __DIR__ . '/../includes/recognition/pipeline.php';
require_once __DIR__ . '/../includes/recognition/credential.php';

function recogRespond(array $payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * 生成不含易混淆字符的兑换码
 */
function recogGenerateClaimCode(): string {
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $code = '';
    for ($i = 0; $i < 10; $i++) {
        $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    }
    return $code;
}

$action = $_GET['action'] ?? '';
$db = getDB();

switch ($action) {

    // ---- 待审核提交列表 ----
    case 'submissions': {
        $user = requireLogin();
        $clubId = (int)($_GET['club_id'] ?? 0);
        $country = displayClubCountry((string)($_GET['country'] ?? 'china')) ?? 'china';
        if (!recogCanReview($user, $clubId, $country) && $user['role'] !== 'super_admin') {
            recogRespond(['success' => false, 'message' => '权限不足'], 403);
        }
        $status = in_array($_GET['status'] ?? '', ['pending', 'approved', 'rejected'], true) ? $_GET['status'] : 'pending';

        $stmt = $db->prepare(
            "SELECT s.id, s.content, s.file_path, s.status, s.created_at,
                    v.id AS program_version_id, v.program_id,
                    p.title AS program_title,
                    u.username AS holder_username, u.nickname AS holder_nickname, u.id AS holder_user_id
             FROM recognition_submissions s
             JOIN recognition_program_versions v ON v.id = s.program_version_id
             JOIN recognition_programs p ON p.id = v.program_id
             JOIN users u ON u.id = s.user_id
             WHERE p.club_id = ? AND p.country = ? AND s.status = ?
             ORDER BY s.created_at ASC LIMIT 200"
        );
        $stmt->execute([$clubId, $country, $status]);
        recogRespond(['success' => true, 'submissions' => $stmt->fetchAll()]);
    }

    // ---- 审核通过 / 驳回（通过后触发规则评估与签发） ----
    case 'review': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $submissionId = (int)($input['submission_id'] ?? 0);
        $decision = in_array($input['decision'] ?? '', ['approved', 'rejected'], true) ? $input['decision'] : '';
        $comment = trim((string)($input['comment'] ?? ''));
        if (!$decision) recogRespond(['success' => false, 'message' => '审核结论非法']);

        $stmt = $db->prepare(
            'SELECT s.*, v.id AS program_version_id, v.program_id
             FROM recognition_submissions s
             JOIN recognition_program_versions v ON v.id = s.program_version_id
             WHERE s.id = ?'
        );
        $stmt->execute([$submissionId]);
        $submission = $stmt->fetch();
        if (!$submission) recogRespond(['success' => false, 'message' => '提交不存在'], 404);
        if ($submission['status'] !== 'pending') recogRespond(['success' => false, 'message' => '该提交已审核']);

        $stmt = $db->prepare('SELECT * FROM recognition_programs WHERE id = ?');
        $stmt->execute([(int)$submission['program_id']]);
        $program = $stmt->fetch();
        if (!recogCanReview($user, (int)$program['club_id'], (string)$program['country']) && $user['role'] !== 'super_admin') {
            recogRespond(['success' => false, 'message' => '无权审核该提交'], 403);
        }

        $db->beginTransaction();
        try {
            $db->prepare('UPDATE recognition_submissions SET status = ?, reviewed_at = ? WHERE id = ?')
                ->execute([$decision, date('Y-m-d H:i:s'), $submissionId]);
            $db->prepare('INSERT INTO recognition_reviews (submission_id, reviewer_id, decision, comment) VALUES (?, ?, ?, ?)')
                ->execute([$submissionId, (int)$user['id'], $decision, $comment]);
            $db->commit();
        } catch (Throwable $e) {
            $db->rollBack();
            error_log('[recog] review failed: ' . $e->getMessage());
            recogRespond(['success' => false, 'message' => '审核失败'], 500);
        }

        $eventType = $decision === 'approved' ? 'submission.approved' : 'submission.rejected';
        recogRecordEvent([
            'type' => $eventType,
            'idempotency_key' => 'review_' . $submissionId,
            'club_id' => (int)$program['club_id'],
            'country' => (string)$program['country'],
            'user_id' => (int)$submission['user_id'],
            'program_id' => (int)$submission['program_id'],
            'program_version_id' => (int)$submission['program_version_id'],
            'data' => ['submission_id' => $submissionId, 'reviewer_id' => (int)$user['id']],
            'source_verified' => true,
        ]);
        logAction('recog_submission_' . $decision, 'recognition_submission', $submissionId, ['reviewer_id' => (int)$user['id']]);

        $award = ['passed' => false, 'issued' => false, 'credential' => null, 'duplicate' => false, 'error' => null];
        if ($decision === 'approved') {
            // 审核通过 → 规则评估（含提交通过与审核人数条件）
            $stmt = $db->prepare('SELECT COUNT(*) AS c FROM recognition_reviews WHERE submission_id = ? AND decision = ?');
            $stmt->execute([$submissionId, 'approved']);
            $reviewerCount = (int)$stmt->fetch()['c'];

            $award = recogEvaluateAndAward((int)$submission['program_version_id'], (int)$submission['user_id'], [
                'submission_status' => 'approved',
                'reviewer_count' => $reviewerCount,
                'source' => 'site',
            ]);
        }

        recogRespond([
            'success' => true,
            'decision' => $decision,
            'issued' => $award['issued'],
            'already_held' => $award['duplicate'],
            'credential' => $award['credential'],
            'message' => $decision === 'approved'
                ? ($award['error'] ?: ($award['passed'] ? '已通过并签发凭证' : '已通过，未满足签发条件'))
                : '已驳回',
        ]);
    }

    // ---- 生成兑换码（线下活动先参与、后领取） ----
    case 'claim_generate': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $programId = (int)($input['program_id'] ?? 0);
        $count = min(500, max(1, (int)($input['count'] ?? 0)));
        $ttlHours = max(0, (int)($input['ttl_hours'] ?? 0));

        $stmt = $db->prepare('SELECT * FROM recognition_programs WHERE id = ?');
        $stmt->execute([$programId]);
        $program = $stmt->fetch();
        if (!$program) recogRespond(['success' => false, 'message' => '项目不存在'], 404);
        if (!recogCanIssue($user, (int)$program['club_id'], (string)$program['country']) && $user['role'] !== 'super_admin') {
            recogRespond(['success' => false, 'message' => '无权为该项目生成兑换码'], 403);
        }
        $version = recogPublishedVersion($db, $programId);
        if (!$version) recogRespond(['success' => false, 'message' => '该项目尚无已发布版本']);
        $badgeId = (int)($version['content']['rules']['award']['badge_id'] ?? 0);
        if ($badgeId <= 0) recogRespond(['success' => false, 'message' => '项目未配置奖励徽章']);

        $codes = [];
        $expiresAt = $ttlHours > 0 ? date('Y-m-d H:i:s', time() + $ttlHours * 3600) : null;
        $stmt = $db->prepare(
            'INSERT INTO recognition_claim_codes (code, program_id, program_version_id, badge_id, expires_at)
             VALUES (?, ?, ?, ?, ?)'
        );
        for ($i = 0; $i < $count; $i++) {
            // 碰撞重试
            for ($retry = 0; $retry < 5; $retry++) {
                $code = recogGenerateClaimCode();
                try {
                    $stmt->execute([$code, $programId, (int)$version['id'], $badgeId, $expiresAt]);
                    $codes[] = $code;
                    break;
                } catch (PDOException $e) {
                    if ($retry === 4) throw $e;
                }
            }
        }
        logAction('recog_claim_generated', 'recognition_program', $programId, ['count' => count($codes)]);
        recogRespond(['success' => true, 'codes' => $codes, 'expires_at' => $expiresAt]);
    }

    // ---- 批量导入活动参与名单（CSV 名单 → 直接签发，对齐架构文档 4.1 标准能力）----
    // 输入：usernames（数组）或 csv（用户名每行一个的文本，兼容逗号分隔）
    case 'import_participants': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $programId = (int)($input['program_id'] ?? 0);

        $usernames = (array)($input['usernames'] ?? []);
        if (!$usernames && !empty($input['csv'])) {
            // 兼容 CSV 粘贴：支持换行与逗号两种分隔，去除可能的表头列分隔符之外的引号/空格/UTF-8 BOM
            $raw = preg_replace('/^\xEF\xBB\xBF/', '', (string)$input['csv']);
            $usernames = preg_split('/[\r\n,]+/', $raw);
        }
        $usernames = array_values(array_filter(array_map(function ($s) {
            return trim((string)$s, " \t\"'");
        }, $usernames)));

        if (!$usernames) recogRespond(['success' => false, 'message' => '请提供参与名单（用户名列表或 CSV 文本）']);
        if (count($usernames) > 2000) recogRespond(['success' => false, 'message' => '单次导入最多 2000 人']);

        $stmt = $db->prepare('SELECT * FROM recognition_programs WHERE id = ?');
        $stmt->execute([$programId]);
        $program = $stmt->fetch();
        if (!$program) recogRespond(['success' => false, 'message' => '项目不存在'], 404);
        if (!in_array($program['type'], ['activity', 'award'], true)) {
            recogRespond(['success' => false, 'message' => '名单导入仅支持 activity / award 类型项目']);
        }
        if (!recogCanIssue($user, (int)$program['club_id'], (string)$program['country']) && $user['role'] !== 'super_admin') {
            recogRespond(['success' => false, 'message' => '无权为该项目导入名单'], 403);
        }
        $version = recogPublishedVersion($db, $programId);
        if (!$version) recogRespond(['success' => false, 'message' => '该项目尚无已发布版本']);
        $badgeId = (int)($version['content']['rules']['award']['badge_id'] ?? 0);
        if ($badgeId <= 0) recogRespond(['success' => false, 'message' => '项目未配置奖励徽章']);

        $imported = 0; $skipped = [];
        foreach ($usernames as $username) {
            $stmt = $db->prepare("SELECT id FROM users WHERE username = ? AND status = 'active'");
            $stmt->execute([$username]);
            $target = $stmt->fetch();
            if (!$target) { $skipped[] = $username . '（账号不存在）'; continue; }

            // activity.attended 事实事件（幂等键绑定导入名单条目）
            recogRecordEvent([
                'type' => 'activity.attended',
                'idempotency_key' => 'import_' . $version['id'] . '_' . $target['id'],
                'club_id' => (int)$program['club_id'],
                'country' => (string)$program['country'],
                'user_id' => (int)$target['id'],
                'program_id' => $programId,
                'program_version_id' => (int)$version['id'],
                'badge_id' => $badgeId,
                'data' => ['imported_by' => (int)$user['id']],
                'source_verified' => true,
            ]);

            $issue = issueCredential($db, [
                'holder_user_id' => (int)$target['id'],
                'badge_id' => $badgeId,
                'issuer_club_id' => (int)$program['club_id'],
                'issuer_country' => (string)$program['country'],
                'program_id' => $programId,
                'program_version_id' => (int)$version['id'],
                'credential_type' => 'participation',
                'verification_level' => 'batch_import',
                'condition_summary' => ['活动参与名单批量导入'],
                'source_type' => 'batch_import',
                'actor_user_id' => (int)$user['id'],
            ]);
            if ($issue['ok'] && !$issue['duplicate']) $imported++;
            if ($issue['duplicate']) $skipped[] = $username . '（已持有）';
        }

        logAction('recog_participants_imported', 'recognition_program', $programId, [
            'imported' => $imported, 'skipped' => count($skipped),
        ]);
        recogRespond(['success' => true, 'imported' => $imported, 'skipped' => array_slice($skipped, 0, 50), 'skipped_total' => count($skipped)]);
    }

    // ---- 兑换码核销情况 ----
    case 'claim_list': {
        $user = requireLogin();
        $programId = (int)($_GET['program_id'] ?? 0);
        $stmt = $db->prepare('SELECT * FROM recognition_programs WHERE id = ?');
        $stmt->execute([$programId]);
        $program = $stmt->fetch();
        if (!$program) recogRespond(['success' => false, 'message' => '项目不存在'], 404);
        if (!recogCanIssue($user, (int)$program['club_id'], (string)$program['country']) && $user['role'] !== 'super_admin') {
            recogRespond(['success' => false, 'message' => '权限不足'], 403);
        }
        $stmt = $db->prepare(
            'SELECT code, redeemed_by, redeemed_at, expires_at FROM recognition_claim_codes
             WHERE program_id = ? ORDER BY id DESC LIMIT 1000'
        );
        $stmt->execute([$programId]);
        $rows = $stmt->fetchAll();
        $redeemed = count(array_filter($rows, fn($r) => $r['redeemed_by'] !== null));
        recogRespond(['success' => true, 'total' => count($rows), 'redeemed' => $redeemed, 'codes' => $rows]);
    }

    default:
        recogRespond(['success' => false, 'message' => '未知操作'], 400);
}
