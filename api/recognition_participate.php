<?php
// api/recognition_participate.php - 用户参与：答题 / 签到兑换
// 动作: start / submit / redeem / status
// 站内事件写入与签发在同一请求内同步完成（事件 → 规则评估 → 凭证签发）。

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
require_once __DIR__ . '/../includes/rate_limit.php';
require_once __DIR__ . '/../includes/recognition/events.php';
require_once __DIR__ . '/../includes/recognition/pipeline.php';

function recogRespond(array $payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * 取可参与的项目与已发布版本，并完成开放时间校验
 */
function recogOpenVersion(int $programId): array {
    $db = getDB();
    $stmt = $db->prepare('SELECT * FROM recognition_programs WHERE id = ?');
    $stmt->execute([$programId]);
    $program = $stmt->fetch();
    if (!$program) return ['error' => '试炼不存在'];
    if ($program['status'] !== 'published') return ['error' => '试炼当前不可参与'];

    $now = time();
    if (!empty($program['open_at']) && $now < strtotime($program['open_at'])) {
        return ['error' => '试炼尚未开放（' . $program['open_at'] . ' 开始）'];
    }
    if (!empty($program['close_at']) && $now > strtotime($program['close_at'])) {
        return ['error' => '试炼已截止'];
    }

    $version = recogPublishedVersion($db, $programId);
    if (!$version) return ['error' => '试炼暂无已发布版本'];
    return ['program' => $program, 'version' => $version, 'error' => null];
}

/**
 * 判分：单选题/判断题精确匹配，多选题集合完全一致，填空题忽略首尾空白与大小写
 */
function recogGradeQuestions(array $questions, array $answers): array {
    $score = 0;
    $total = 0;
    $detail = [];
    foreach ($questions as $i => $q) {
        $points = max(1, (int)($q['points'] ?? 10));
        $total += $points;
        $given = $answers[(string)$i] ?? $answers[$i] ?? null;
        $correct = false;
        if (in_array($q['type'], ['single', 'judge'], true)) {
            $expected = ($q['answer'] ?? [])[0] ?? null;
            $correct = ($given !== null && (int)$given === (int)$expected);
        } elseif ($q['type'] === 'multiple') {
            $expected = $q['answer'] ?? [];
            $givenArr = is_array($given) ? array_map('intval', $given) : [];
            sort($expected); sort($givenArr);
            $correct = $expected === $givenArr && $expected !== [];
        } elseif ($q['type'] === 'fill_blank') {
            $expected = mb_strtolower(trim((string)($q['answer_text'] ?? '')));
            $correct = $expected !== '' && mb_strtolower(trim((string)$given)) === $expected;
        }
        if ($correct) $score += $points;
        $detail[$i] = $correct;
    }
    // 折算为百分制
    $percent = $total > 0 ? (int)round($score * 100 / $total) : 0;
    return ['score' => $percent, 'raw' => $score, 'total' => $total, 'detail' => $detail];
}

$action = $_GET['action'] ?? '';
$db = getDB();

switch ($action) {

    // ---- 开始一次答题 ----
    case 'start': {
        checkRateLimit('recog_start', 30, 1);
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $programId = (int)($input['program_id'] ?? 0);

        $open = recogOpenVersion($programId);
        if ($open['error']) recogRespond(['success' => false, 'message' => $open['error']]);
        $program = $open['program'];
        $version = $open['version'];
        $content = $version['content'];
        $questions = $content['quiz']['questions'] ?? [];
        if (!$questions) recogRespond(['success' => false, 'message' => '该项目不是答题类试炼']);

        $versionId = (int)$version['id'];

        // 尝试次数限制
        $stmt = $db->prepare('SELECT COUNT(*) AS c FROM recognition_attempts WHERE program_version_id = ? AND user_id = ?');
        $stmt->execute([$versionId, (int)$user['id']]);
        $used = (int)$stmt->fetch()['c'];
        $maxAttempts = (int)$program['max_attempts'];
        if ($maxAttempts > 0 && $used >= $maxAttempts) {
            recogRespond(['success' => false, 'message' => '已达最大尝试次数（' . $maxAttempts . ' 次）']);
        }

        // 失败冷却
        $cooldown = (int)$program['cooldown_minutes'];
        if ($cooldown > 0) {
            $stmt = $db->prepare(
                'SELECT finished_at FROM recognition_attempts
                 WHERE program_version_id = ? AND user_id = ? AND finished_at IS NOT NULL
                 ORDER BY finished_at DESC LIMIT 1'
            );
            $stmt->execute([$versionId, (int)$user['id']]);
            $last = $stmt->fetch();
            if ($last && strtotime($last['finished_at']) + $cooldown * 60 > time()) {
                $waitSec = strtotime($last['finished_at']) + $cooldown * 60 - time();
                recogRespond(['success' => false, 'message' => '冷却中，请 ' . ceil($waitSec / 60) . ' 分钟后再试']);
            }
        }

        // 组卷（可选乱序）
        $indexes = range(0, count($questions) - 1);
        if (!empty($content['quiz']['shuffle'])) {
            shuffle($indexes);
        }
        $pick = (int)($content['quiz']['pick_count'] ?? 0);
        if ($pick > 0 && $pick < count($indexes)) {
            $indexes = array_slice($indexes, 0, $pick);
        }
        $paper = [];
        foreach ($indexes as $seq => $origIdx) {
            $q = $questions[$origIdx];
            $paper[] = [
                'seq' => $seq,
                'orig' => $origIdx, // 判分用原始索引
                'type' => $q['type'],
                'question' => $q['question'],
                'options' => $q['options'] ?? [],
                'points' => (int)($q['points'] ?? 10),
            ];
        }

        $stmt = $db->prepare(
            'INSERT INTO recognition_attempts (program_version_id, user_id, status, attempt_no, started_at)
             VALUES (?, ?, ?, ?, ?)'
        );
        $stmt->execute([$versionId, (int)$user['id'], 'in_progress', $used + 1, date('Y-m-d H:i:s')]);
        $attemptId = (int)$db->lastInsertId();

        recogRecordEvent([
            'type' => 'assessment.started',
            'idempotency_key' => 'attempt_start_' . $attemptId,
            'club_id' => (int)$program['club_id'],
            'country' => (string)$program['country'],
            'user_id' => (int)$user['id'],
            'program_id' => $programId,
            'program_version_id' => $versionId,
            'source_verified' => true,
        ]);

        recogRespond(['success' => true, 'attempt_id' => $attemptId, 'questions' => $paper]);
    }

    // ---- 提交答卷：判分 → 事件 → 规则评估 → 签发 ----
    case 'submit': {
        checkRateLimit('recog_submit', 30, 1);
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $attemptId = (int)($input['attempt_id'] ?? 0);
        $answers = $input['answers'] ?? [];

        $stmt = $db->prepare('SELECT * FROM recognition_attempts WHERE id = ? AND user_id = ?');
        $stmt->execute([$attemptId, (int)$user['id']]);
        $attempt = $stmt->fetch();
        if (!$attempt) recogRespond(['success' => false, 'message' => '答题记录不存在'], 404);
        if ($attempt['status'] !== 'in_progress') recogRespond(['success' => false, 'message' => '该次答题已结束']);

        $version = recogLoadVersion($db, (int)$attempt['program_version_id']);
        if (!$version) recogRespond(['success' => false, 'message' => '项目版本不存在'], 404);
        $questions = $version['content']['quiz']['questions'] ?? [];

        // 客户端按 seq 提交，还原为原始索引
        $paper = $input['paper'] ?? null;
        $origAnswers = [];
        if (is_array($paper)) {
            foreach ($paper as $item) {
                $orig = (int)($item['orig'] ?? -1);
                $seq = (string)($item['seq'] ?? '');
                if ($orig >= 0 && array_key_exists($seq, $answers)) {
                    $origAnswers[$orig] = $answers[$seq];
                }
            }
        } else {
            $origAnswers = $answers;
        }

        $grade = recogGradeQuestions($questions, $origAnswers);

        $passed = false;
        $credential = null;

        $db->beginTransaction();
        try {
            $db->prepare(
                'UPDATE recognition_attempts SET status = ?, score = ?, answers = ?, finished_at = ? WHERE id = ?'
            )->execute([
                'submitted',
                $grade['score'],
                json_encode($origAnswers, JSON_UNESCAPED_UNICODE),
                date('Y-m-d H:i:s'),
                $attemptId,
            ]);
            $db->commit();
        } catch (Throwable $e) {
            $db->rollBack();
            error_log('[recog] attempt submit failed: ' . $e->getMessage());
            recogRespond(['success' => false, 'message' => '提交失败'], 500);
        }

        // assessment.completed 事实事件
        recogRecordEvent([
            'type' => 'assessment.completed',
            'idempotency_key' => 'attempt_done_' . $attemptId,
            'club_id' => null,
            'user_id' => (int)$user['id'],
            'program_id' => (int)$version['program_id'],
            'program_version_id' => (int)$attempt['program_version_id'],
            'data' => ['score' => $grade['score'], 'attempt_id' => $attemptId],
            'source_verified' => true,
        ]);

        // 规则评估与签发（同步）
        $award = recogEvaluateAndAward((int)$attempt['program_version_id'], (int)$user['id'], [
            'score' => $grade['score'],
            'source' => 'site',
        ]);
        $passed = $award['passed'];

        recogRecordEvent([
            'type' => $passed ? 'assessment.passed' : 'assessment.failed',
            'idempotency_key' => 'attempt_result_' . $attemptId,
            'user_id' => (int)$user['id'],
            'program_id' => (int)$version['program_id'],
            'program_version_id' => (int)$attempt['program_version_id'],
            'data' => ['score' => $grade['score']],
            'source_verified' => true,
        ]);

        $db->prepare('UPDATE recognition_attempts SET status = ? WHERE id = ?')
            ->execute([$passed ? 'passed' : 'failed', $attemptId]);

        recogRespond([
            'success' => true,
            'score' => $grade['score'],
            'passed' => $passed,
            'issued' => $award['issued'],
            'already_held' => $award['duplicate'],
            'credential' => $award['credential'],
            'reasons' => $award['reasons'],
            'message' => $award['error'] ?: ($passed ? '恭喜，试炼通过' : '未满足通过条件，可再次尝试'),
        ]);
    }

    // ---- 兑换码 / 二维码签到（先参与、后领取） ----
    case 'redeem': {
        checkRateLimit('recog_redeem', 30, 1);
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $code = strtoupper(trim((string)($input['code'] ?? '')));
        if ($code === '' || strlen($code) > 32) {
            recogRespond(['success' => false, 'message' => '请输入兑换码']);
        }

        $stmt = $db->prepare('SELECT * FROM recognition_claim_codes WHERE code = ?');
        $stmt->execute([$code]);
        $claim = $stmt->fetch();
        if (!$claim) recogRespond(['success' => false, 'message' => '兑换码无效']);
        if ($claim['redeemed_by'] !== null) recogRespond(['success' => false, 'message' => '兑换码已被使用']);
        if (!empty($claim['expires_at']) && time() > strtotime($claim['expires_at'])) {
            recogRespond(['success' => false, 'message' => '兑换码已过期']);
        }

        $open = recogOpenVersion((int)$claim['program_id']);
        if ($open['error']) recogRespond(['success' => false, 'message' => $open['error']]);

        $db->beginTransaction();
        try {
            // 原子兑换：仅当未被他人兑换时成功
            $stmt = $db->prepare(
                'UPDATE recognition_claim_codes SET redeemed_by = ?, redeemed_at = ? WHERE id = ? AND redeemed_by IS NULL'
            );
            $stmt->execute([(int)$user['id'], date('Y-m-d H:i:s'), $claim['id']]);
            if ($stmt->rowCount() === 0) {
                $db->rollBack();
                recogRespond(['success' => false, 'message' => '兑换码已被使用']);
            }
            $db->commit();
        } catch (Throwable $e) {
            $db->rollBack();
            error_log('[recog] redeem failed: ' . $e->getMessage());
            recogRespond(['success' => false, 'message' => '兑换失败'], 500);
        }

        // activity.attended 事实事件（幂等键绑定兑换码）
        recogRecordEvent([
            'type' => 'activity.attended',
            'idempotency_key' => 'claim_' . $code,
            'club_id' => (int)$open['program']['club_id'],
            'country' => (string)$open['program']['country'],
            'user_id' => (int)$user['id'],
            'program_id' => (int)$claim['program_id'],
            'program_version_id' => (int)$claim['program_version_id'],
            'badge_id' => (int)$claim['badge_id'],
            'data' => ['claim_code' => $code],
            'source_verified' => true,
        ]);

        // 规则评估与签发（活动类规则通常为空条件 = 自动满足）
        $award = recogEvaluateAndAward((int)$claim['program_version_id'], (int)$user['id'], [
            'source' => 'site',
        ]);

        recogRespond([
            'success' => true,
            'issued' => $award['issued'],
            'already_held' => $award['duplicate'],
            'credential' => $award['credential'],
            'message' => $award['error'] ?: ($award['passed'] ? '签到成功，凭证已发放' : '签到已记录'),
        ]);
    }

    // ---- 作品/文字提交（进入人工审核，审核通过事件由 recognition_admin.php 触发） ----
    case 'submit_work': {
        checkRateLimit('recog_submit_work', 20, 1);
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $versionId = (int)($input['program_version_id'] ?? 0);
        $content = trim((string)($input['content'] ?? ''));

        if ($content === '' || recogSafeStrlen($content) > 5000) {
            recogRespond(['success' => false, 'message' => '提交内容必填且不超过 5000 字']);
        }

        $version = recogLoadVersion($db, $versionId);
        if (!$version || $version['status'] !== 'published') {
            recogRespond(['success' => false, 'message' => '项目版本不存在或未发布']);
        }
        $stmt = $db->prepare('SELECT * FROM recognition_programs WHERE id = ?');
        $stmt->execute([(int)$version['program_id']]);
        $program = $stmt->fetch();
        if (!$program || $program['status'] !== 'published') {
            recogRespond(['success' => false, 'message' => '试炼当前不可参与']);
        }

        // 同一版本同一用户只保留一份待审提交；已有有效凭证则不再重复提交
        $stmt = $db->prepare(
            "SELECT id FROM recognition_credentials
             WHERE program_version_id = ? AND holder_user_id = ? AND status = 'active'"
        );
        $stmt->execute([$versionId, (int)$user['id']]);
        if ($stmt->fetch()) {
            recogRespond(['success' => false, 'message' => '你已获得该试炼的凭证']);
        }
        $stmt = $db->prepare(
            "SELECT id FROM recognition_submissions WHERE program_version_id = ? AND user_id = ? AND status = 'pending'"
        );
        $stmt->execute([$versionId, (int)$user['id']]);
        if ($stmt->fetch()) {
            recogRespond(['success' => false, 'message' => '你已有一份待审提交，请等待审核结果']);
        }

        $db->prepare(
            'INSERT INTO recognition_submissions (program_version_id, user_id, content, status) VALUES (?, ?, ?, ?)'
        )->execute([$versionId, (int)$user['id'], $content, 'pending']);
        $submissionId = (int)$db->lastInsertId();

        recogRecordEvent([
            'type' => 'submission.created',
            'idempotency_key' => 'submission_' . $submissionId,
            'club_id' => (int)$program['club_id'],
            'country' => (string)$program['country'],
            'user_id' => (int)$user['id'],
            'program_id' => (int)$program['id'],
            'program_version_id' => $versionId,
            'data' => ['submission_id' => $submissionId],
            'source_verified' => true,
        ]);

        recogRespond(['success' => true, 'submission_id' => $submissionId, 'message' => '已提交，等待同好会审核']);
    }

    // ---- 查询我对某试炼的参与状态 ----
    case 'status': {
        $user = requireLogin();
        $programId = (int)($_GET['program_id'] ?? 0);
        $open = recogOpenVersion($programId);
        if ($open['error']) recogRespond(['success' => false, 'message' => $open['error']]);
        $versionId = (int)$open['version']['id'];

        $stmt = $db->prepare('SELECT COUNT(*) AS c FROM recognition_attempts WHERE program_version_id = ? AND user_id = ?');
        $stmt->execute([$versionId, (int)$user['id']]);
        $attempts = (int)$stmt->fetch()['c'];

        $stmt = $db->prepare(
            "SELECT credential_uid, status FROM recognition_credentials
             WHERE program_version_id = ? AND holder_user_id = ? AND status = 'active'"
        );
        $stmt->execute([$versionId, (int)$user['id']]);
        $cred = $stmt->fetch();

        recogRespond([
            'success' => true,
            'attempts' => $attempts,
            'max_attempts' => (int)$open['program']['max_attempts'],
            'credential_uid' => $cred['credential_uid'] ?? null,
        ]);
    }

    default:
        recogRespond(['success' => false, 'message' => '未知操作'], 400);
}
