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
require_once __DIR__ . '/../includes/recognition/quiz.php';

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
    if (!$program) return ['error' => '考核不存在'];
    if ($program['status'] !== 'published') return ['error' => '考核当前不可参与'];

    $now = time();
    if (!empty($program['open_at']) && $now < strtotime($program['open_at'])) {
        return ['error' => '考核尚未开放（' . $program['open_at'] . ' 开始）'];
    }
    if (!empty($program['close_at']) && $now > strtotime($program['close_at'])) {
        return ['error' => '考核已截止'];
    }

    $version = recogPublishedVersion($db, $programId);
    if (!$version) return ['error' => '考核暂无已发布版本'];
    return ['program' => $program, 'version' => $version, 'error' => null];
}

/**
 * 计算考试截止时间戳（不限时返回 0）
 */
function recogQuizDeadline(array $settings, string $startedAt): int {
    if ((int)$settings['time_limit'] <= 0) return 0;
    return strtotime($startedAt) + (int)$settings['time_limit'] * 60;
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
        if (!$questions) recogRespond(['success' => false, 'message' => '该项目不是答题类考核']);

        $versionId = (int)$version['id'];
        $settings = recogQuizSettings($content['quiz']);

        // 续答：已有进行中的尝试直接复用（不消耗次数），返回试卷与暂存答案；
        // 试卷以开始时的快照保存在 answers 列，保证乱序/抽题下题目不变。
        $stmt = $db->prepare(
            "SELECT * FROM recognition_attempts
             WHERE program_version_id = ? AND user_id = ? AND status = 'in_progress'
             ORDER BY id DESC LIMIT 1"
        );
        $stmt->execute([$versionId, (int)$user['id']]);
        $ongoing = $stmt->fetch();
        if ($ongoing) {
            $saved = json_decode((string)$ongoing['answers'], true);
            $paper = is_array($saved['quiz_paper'] ?? null) ? $saved['quiz_paper'] : recogBuildPaper($content);
            recogRespond([
                'success' => true,
                'attempt_id' => (int)$ongoing['id'],
                'questions' => $paper,
                'settings' => $settings,
                'deadline' => recogQuizDeadline($settings, (string)$ongoing['started_at']),
                'saved_answers' => is_array($saved['answers'] ?? null) ? $saved['answers'] : [],
                'resumed' => true,
            ]);
        }

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

        // 组卷（乱序/抽题/选项乱序由考试设置驱动，见 includes/recognition/quiz.php）
        $paper = recogBuildPaper($content);

        $startedAt = date('Y-m-d H:i:s');
        $stmt = $db->prepare(
            'INSERT INTO recognition_attempts (program_version_id, user_id, status, attempt_no, started_at, answers)
             VALUES (?, ?, ?, ?, ?, ?)'
        );
        // answers 列暂存试卷快照（续答用），提交后覆写为正式答案，格式不变兼容旧数据读取方
        $stmt->execute([
            $versionId, (int)$user['id'], 'in_progress', $used + 1, $startedAt,
            json_encode(['quiz_paper' => $paper], JSON_UNESCAPED_UNICODE),
        ]);
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

        recogRespond([
            'success' => true,
            'attempt_id' => $attemptId,
            'questions' => $paper,
            'settings' => $settings,
            'deadline' => recogQuizDeadline($settings, $startedAt),
        ]);
    }

    // ---- 暂存答案（续答支持，不影响判分与次数） ----
    case 'temp_save': {
        checkRateLimit('recog_temp_save', 20, 1);
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $attemptId = (int)($input['attempt_id'] ?? 0);
        $answers = is_array($input['answers'] ?? null) ? $input['answers'] : [];

        $stmt = $db->prepare('SELECT * FROM recognition_attempts WHERE id = ? AND user_id = ?');
        $stmt->execute([$attemptId, (int)$user['id']]);
        $attempt = $stmt->fetch();
        if (!$attempt) recogRespond(['success' => false, 'message' => '答题记录不存在'], 404);
        if ($attempt['status'] !== 'in_progress') recogRespond(['success' => false, 'message' => '该次答题已结束']);

        // 保留试卷快照，只更新答案部分；大小限制防止滥用（按题号 ≤ 500 题）
        $saved = json_decode((string)$attempt['answers'], true) ?: [];
        if (count($answers) > 500) recogRespond(['success' => false, 'message' => '暂存内容非法']);
        $saved['answers'] = $answers;
        $db->prepare('UPDATE recognition_attempts SET answers = ? WHERE id = ?')
            ->execute([json_encode($saved, JSON_UNESCAPED_UNICODE), $attemptId]);
        recogRespond(['success' => true]);
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
        $settings = recogQuizSettings($version['content']['quiz'] ?? []);

        // 限时校验（服务端为准，允许 60 秒网络宽限）；超时照常记分但强制不通过、不签发
        $deadline = recogQuizDeadline($settings, (string)$attempt['started_at']);
        $overdue = $deadline > 0 && time() > $deadline + 60;

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

        // 判分按实际下发的试卷（抽题/乱序后参与者所见题目），而非全量题库：
        // 抽题时若按全量折算百分制，会把得分压低，造成“实际考核与最终得分不一致”。
        // 试卷快照只含 orig 索引（不含答案），expected 仍取自版本快照的原始题目。
        // 以原始索引为键构建判分集合：判分函数按 $i 取答案、detail 也以 $i 为键，自然对齐。
        $savedAttempt = json_decode((string)$attempt['answers'], true);
        $paperSnapshot = is_array($savedAttempt['quiz_paper'] ?? null) ? $savedAttempt['quiz_paper'] : null;
        if ($paperSnapshot) {
            $picked = [];
            foreach ($paperSnapshot as $item) {
                $orig = (int)($item['orig'] ?? -1);
                if ($orig >= 0 && isset($questions[$orig])) {
                    $picked[$orig] = $questions[$orig];
                }
            }
            if ($picked) {
                $questions = $picked; // 键 = 题库原始索引
            } else {
                $questions = array_values($questions); // 快照异常时退回全量题库
            }
        }

        $grade = recogGradeQuestions($questions, $origAnswers, $settings);

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

        // 规则评估与签发（同步）；超时强制不通过且不评估签发
        if ($overdue) {
            $award = ['passed' => false, 'issued' => false, 'duplicate' => false, 'credential' => null, 'reasons' => [], 'error' => null];
        } else {
            $award = recogEvaluateAndAward((int)$attempt['program_version_id'], (int)$user['id'], [
                'score' => $grade['score'],
                'source' => 'site',
            ]);
        }
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

        // 成绩展示模式（immediate=分数+逐题解析 / pass_only=仅结果 / hidden=只提示已提交）
        $resultMode = $settings['result_mode'];
        if ($resultMode === 'hidden') {
            recogRespond(['success' => true, 'mode' => 'hidden', 'message' => '已提交，结果请稍后在考核详情页查看']);
        }

        $payload = [
            'success' => true,
            'mode' => $resultMode,
            'passed' => $passed,
            'issued' => $award['issued'],
            'already_held' => $award['duplicate'],
            'credential' => $award['credential'],
        ];
        if ($resultMode === 'immediate') {
            $payload['score'] = $grade['score'];
            $payload['detail'] = $grade['detail'];
            $payload['reasons'] = $award['reasons'];
        }
        if ($overdue) {
            $payload['message'] = '已超出考试限时，本次作答不计通过';
        } else {
            $payload['message'] = $award['error'] ?: ($passed ? '恭喜，考核通过' : '未满足通过条件，可再次尝试');
        }
        recogRespond($payload);
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

        // 附图（最多 4 张，须为本站 submission_image.php 落盘的路径，防注入/外链）
        $images = [];
        if (isset($input['images']) && is_array($input['images'])) {
            foreach (array_slice($input['images'], 0, 4) as $img) {
                $img = trim((string)$img);
                if ($img === '') continue;
                if (!preg_match('#^data/submission_images/[A-Za-z0-9_\-.]+\.(jpe?g|png|gif|webp)$#', $img)) {
                    recogRespond(['success' => false, 'message' => '图片地址不合法']);
                }
                $images[] = $img;
            }
            if (count($images) > 4) {
                recogRespond(['success' => false, 'message' => '图片最多 4 张']);
            }
        }

        if (($content === '' && !$images) || recogSafeStrlen($content) > 5000) {
            recogRespond(['success' => false, 'message' => '请填写说明或上传图片，文字不超过 5000 字']);
        }

        $version = recogLoadVersion($db, $versionId);
        if (!$version || $version['status'] !== 'published') {
            recogRespond(['success' => false, 'message' => '项目版本不存在或未发布']);
        }
        $stmt = $db->prepare('SELECT * FROM recognition_programs WHERE id = ?');
        $stmt->execute([(int)$version['program_id']]);
        $program = $stmt->fetch();
        if (!$program || $program['status'] !== 'published') {
            recogRespond(['success' => false, 'message' => '考核当前不可参与']);
        }

        // 同一版本同一用户只保留一份待审提交；已有有效凭证则不再重复提交
        $stmt = $db->prepare(
            "SELECT id FROM recognition_credentials
             WHERE program_version_id = ? AND holder_user_id = ? AND status = 'active'"
        );
        $stmt->execute([$versionId, (int)$user['id']]);
        if ($stmt->fetch()) {
            recogRespond(['success' => false, 'message' => '你已获得该考核的凭证']);
        }
        $stmt = $db->prepare(
            "SELECT id FROM recognition_submissions WHERE program_version_id = ? AND user_id = ? AND status = 'pending'"
        );
        $stmt->execute([$versionId, (int)$user['id']]);
        if ($stmt->fetch()) {
            recogRespond(['success' => false, 'message' => '你已有一份待审提交，请等待审核结果']);
        }

        // 有图时 content 存 JSON {text, images}（审核端兼容解析），纯文本保持原样；
        // file_path 同步记录图片路径（竖线分隔），便于列表快速识别附件
        $storeContent = $images
            ? json_encode(['text' => $content, 'images' => $images], JSON_UNESCAPED_UNICODE)
            : $content;

        $db->prepare(
            'INSERT INTO recognition_submissions (program_version_id, user_id, content, file_path, status) VALUES (?, ?, ?, ?, ?)'
        )->execute([$versionId, (int)$user['id'], $storeContent, $images ? implode('|', $images) : '', 'pending']);
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

    // ---- 查询我对某考核的参与状态 ----
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
