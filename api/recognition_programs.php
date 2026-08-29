<?php
// api/recognition_programs.php - 同好会考核（认可项目）创建与管理
// 动作: list / detail / create / update / publish / set_status / manage
//       badge_create / badge_update / badge_list / caps_reference
// 权限: 读公开；写要求该同好会 Program Designer 角色（见 includes/recognition/roles.php）

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
require_once __DIR__ . '/../includes/recognition/capability.php';
require_once __DIR__ . '/../includes/recognition/roles.php';
require_once __DIR__ . '/../includes/recognition/rules.php';
require_once __DIR__ . '/../includes/recognition/pipeline.php';

const RECOG_PROGRAM_TYPES = ['assessment', 'activity', 'mission', 'submission', 'competition', 'award', 'external'];

function recogRespond(array $payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

function recogInput(): array {
    return json_decode(file_get_contents('php://input'), true) ?: [];
}

/**
 * 从内容推导 capabilities（不存 mode 字段，层级由能力集合判断）
 */
function recogDeriveCapabilities(array $content, string $type, array $fields = []): array {
    $caps = [];
    $questions = $content['quiz']['questions'] ?? [];
    if ($questions) {
        $caps[] = 'quiz.basic';
        foreach ($questions as $q) {
            $t = $q['type'] ?? '';
            if ($t === 'multiple') $caps[] = 'quiz.multiple_choice';
            if ($t === 'judge') $caps[] = 'quiz.judgement';
            if ($t === 'fill_blank') $caps[] = 'quiz.fill_blank';
        }
    }
    foreach (($content['rules']['conditions'] ?? []) as $c) {
        if (($c['op'] ?? '') === 'score_gte') $caps[] = 'rule.score_threshold';
        if (in_array($c['op'] ?? '', ['time_window'], true)) $caps[] = 'rule.time_window';
    }
    if (!empty($content['claim']['enabled'])) $caps[] = 'activity.claim_code';
    if ($type === 'submission') { $caps[] = 'submission.text'; $caps[] = 'review.manual'; }
    if ($type === 'award') $caps[] = 'award.manual';
    if ((int)($fields['credential_ttl_days'] ?? 0) > 0) $caps[] = 'credential.expiring';
    if ((int)($fields['max_issuance'] ?? 0) > 0) $caps[] = 'credential.limited';
    $caps[] = 'credential.single';
    $caps[] = 'stats.basic';
    return recogValidCapabilities(array_values(array_unique($caps)));
}

/**
 * 回读时补充项目字段对应的能力（历史行的 capabilities 列可能未含）
 */
function recogAugmentCapsWithFields(array $caps, array $row): array {
    if ((int)($row['credential_ttl_days'] ?? 0) > 0 && !in_array('credential.expiring', $caps, true)) $caps[] = 'credential.expiring';
    if ((int)($row['max_issuance'] ?? 0) > 0 && !in_array('credential.limited', $caps, true)) $caps[] = 'credential.limited';
    return $caps;
}

/**
 * 校验并规范化版本内容（题目 + 规则 + 奖励）
 * @return string|null 错误信息
 */
function recogValidateContent(array $content, string $type, int $clubId, string $country): ?string {
    $questions = $content['quiz']['questions'] ?? [];
    if ($questions) {
        if (!is_array($questions) || count($questions) > 200) {
            return '题目数量非法（最多 200 题）';
        }
        foreach ($questions as $i => $q) {
            $t = $q['type'] ?? '';
            if (!in_array($t, ['single', 'multiple', 'judge', 'fill_blank'], true)) {
                return '第 ' . ($i + 1) . ' 题题型不支持';
            }
            if (trim((string)($q['question'] ?? '')) === '') {
                return '第 ' . ($i + 1) . ' 题题干为空';
            }
            if (in_array($t, ['single', 'multiple', 'judge'], true)) {
                $options = $q['options'] ?? [];
                if (!is_array($options) || count($options) < 2) {
                    return '第 ' . ($i + 1) . ' 题选项不足';
                }
                $answer = $q['answer'] ?? [];
                if (!is_array($answer) || !$answer) {
                    return '第 ' . ($i + 1) . ' 题未设置答案';
                }
                foreach ($answer as $a) {
                    if (!is_int($a) || $a < 0 || $a >= count($options)) {
                        return '第 ' . ($i + 1) . ' 题答案索引越界';
                    }
                }
                if ($t === 'single' && count($answer) !== 1) {
                    return '第 ' . ($i + 1) . ' 题单选题只能有一个答案';
                }
            } else {
                if (trim((string)($q['answer_text'] ?? '')) === '') {
                    return '第 ' . ($i + 1) . ' 题填空题缺少参考答案';
                }
            }
        }
    }

    $rules = $content['rules'] ?? null;
    if (!is_array($rules)) {
        return '缺少完成规则（rules）';
    }
    $err = recogValidateRuleSet($rules);
    if ($err !== null) {
        return $err;
    }

    // 奖励徽章必须属于同一同好会
    $badgeId = (int)($rules['award']['badge_id'] ?? 0);
    $db = getDB();
    $stmt = $db->prepare('SELECT id FROM recognition_badges WHERE id = ? AND club_id = ? AND country = ?');
    $stmt->execute([$badgeId, $clubId, $country]);
    if (!$stmt->fetch()) {
        return '奖励徽章不存在或不属于该同好会';
    }
    return null;
}

/**
 * 公开输出时剥离答案
 */
function recogStripAnswers(array $content): array {
    foreach (($content['quiz']['questions'] ?? []) as $i => $q) {
        unset($content['quiz']['questions'][$i]['answer']);
        unset($content['quiz']['questions'][$i]['answer_text']);
    }
    return $content;
}

$action = $_GET['action'] ?? '';
$db = getDB();

switch ($action) {

    // ---- 公开：已发布考核列表 ----
    case 'list': {
        $clubId = (int)($_GET['club_id'] ?? 0);
        $country = displayClubCountry((string)($_GET['country'] ?? 'china')) ?? 'china';
        $type = (string)($_GET['type'] ?? '');

        $sql = "SELECT p.id, p.club_id, p.country, p.type, p.title, p.intro, p.participant_difficulty,
                       p.open_at, p.close_at, p.status, p.capabilities, p.credential_ttl_days, p.max_issuance, p.created_at
                FROM recognition_programs p
                WHERE p.status = 'published' AND p.visibility = 'public'";
        $params = [];
        if ($clubId > 0) { $sql .= ' AND p.club_id = ? AND p.country = ?'; $params[] = $clubId; $params[] = $country; }
        if (in_array($type, RECOG_PROGRAM_TYPES, true)) { $sql .= ' AND p.type = ?'; $params[] = $type; }
        $sql .= ' ORDER BY p.created_at DESC LIMIT 100';
        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        $programs = [];
        foreach ($stmt->fetchAll() as $row) {
            $club = displayClubRecord((int)$row['club_id'], (string)$row['country']);
            $row['club_name'] = $club['name'] ?? '同好会 #' . $row['club_id'];
            $row['capabilities'] = recogAugmentCapsWithFields(json_decode($row['capabilities'], true) ?: [], $row);
            $row['tier'] = recogDetectTier($row['capabilities']);
            // 参与人数与签发数
            $c = $db->prepare('SELECT COUNT(*) AS c FROM recognition_credentials WHERE program_id = ? AND status = ?');
            $c->execute([(int)$row['id'], 'active']);
            $row['issued_count'] = (int)$c->fetch()['c'];
            unset($row['capabilities']);
            $programs[] = $row;
        }
        recogRespond(['success' => true, 'programs' => $programs]);
    }

    // ---- 公开：考核详情（不含答案） ----
    case 'detail': {
        $programId = (int)($_GET['id'] ?? 0);
        $stmt = $db->prepare('SELECT * FROM recognition_programs WHERE id = ?');
        $stmt->execute([$programId]);
        $program = $stmt->fetch();
        if (!$program) {
            recogRespond(['success' => false, 'message' => '考核不存在'], 404);
        }

        $isManager = false;
        $viewer = getCurrentUser();
        if ($viewer) {
            $isManager = recogCanDesign($viewer, (int)$program['club_id'], (string)$program['country']);
        }
        if ($program['status'] === 'draft' && !$isManager) {
            recogRespond(['success' => false, 'message' => '考核不存在'], 404);
        }

        $version = recogPublishedVersion($db, $programId);
        if (!$version && $isManager) {
            // 管理者可查看最新草稿
            $stmt = $db->prepare('SELECT id FROM recognition_program_versions WHERE program_id = ? ORDER BY id DESC LIMIT 1');
            $stmt->execute([$programId]);
            $row = $stmt->fetch();
            if ($row) $version = recogLoadVersion($db, (int)$row['id']);
        }

        $content = $version['content'] ?? [];
        if (!$isManager) {
            $content = recogStripAnswers($content);
        }

        $club = displayClubRecord((int)$program['club_id'], (string)$program['country']);
        $caps = recogAugmentCapsWithFields(json_decode($program['capabilities'], true) ?: [], $program);

        $payload = [
            'success' => true,
            'program' => [
                'id' => (int)$program['id'],
                'club_id' => (int)$program['club_id'],
                'country' => $program['country'],
                'club_name' => $club['name'] ?? '',
                'type' => $program['type'],
                'title' => $program['title'],
                'intro' => $program['intro'],
                'participant_difficulty' => $program['participant_difficulty'],
                'status' => $program['status'],
                'open_at' => $program['open_at'],
                'close_at' => $program['close_at'],
                'max_attempts' => (int)$program['max_attempts'],
                'cooldown_minutes' => (int)$program['cooldown_minutes'],
                'tier' => recogDetectTier($caps),
                'is_manager' => $isManager,
            ],
            'version' => $version ? [
                'id' => (int)$version['id'],
                'version_no' => $version['version_no'],
                'status' => $version['status'],
                'content' => $content,
            ] : null,
        ];

        // 登录用户附带参与状态
        if ($viewer && $version) {
            $stmt = $db->prepare('SELECT COUNT(*) AS c FROM recognition_attempts WHERE program_version_id = ? AND user_id = ?');
            $stmt->execute([(int)$version['id'], (int)$viewer['id']]);
            $payload['my_attempts'] = (int)$stmt->fetch()['c'];
            $stmt = $db->prepare("SELECT credential_uid FROM recognition_credentials WHERE program_version_id = ? AND holder_user_id = ? AND status = 'active'");
            $stmt->execute([(int)$version['id'], (int)$viewer['id']]);
            $cred = $stmt->fetch();
            $payload['my_credential_uid'] = $cred['credential_uid'] ?? null;
        }
        recogRespond($payload);
    }

    // ---- 创建认可项目（草稿） ----
    case 'create': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = recogInput();

        $clubId = (int)($input['club_id'] ?? 0);
        $country = displayClubCountry((string)($input['country'] ?? 'china')) ?? 'china';
        if (!recogCanDesign($user, $clubId, $country)) {
            recogRespond(['success' => false, 'message' => '无权为该同好会创建考核'], 403);
        }
        if (!displayClubRecord($clubId, $country)) {
            recogRespond(['success' => false, 'message' => '同好会不存在']);
        }
        $type = in_array($input['type'] ?? '', RECOG_PROGRAM_TYPES, true) ? $input['type'] : 'assessment';
        $title = trim((string)($input['title'] ?? ''));
        if ($title === '' || recogSafeStrlen($title) > 100) {
            recogRespond(['success' => false, 'message' => '标题必填且不超过 100 字']);
        }
        $content = $input['content'] ?? [];
        $err = recogValidateContent($content, $type, $clubId, $country);
        if ($err !== null) recogRespond(['success' => false, 'message' => $err]);

        $capabilities = recogDeriveCapabilities($content, $type, [
            'credential_ttl_days' => max(0, (int)($input['credential_ttl_days'] ?? 0)),
            'max_issuance' => max(0, (int)($input['max_issuance'] ?? 0)),
        ]);

        $db->beginTransaction();
        try {
            $stmt = $db->prepare(
                'INSERT INTO recognition_programs
                    (club_id, country, type, title, intro, participant_difficulty, visibility, status,
                     capabilities, max_attempts, cooldown_minutes, open_at, close_at, max_issuance,
                     credential_ttl_days, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            );
            $stmt->execute([
                $clubId, $country, $type, $title,
                trim((string)($input['intro'] ?? '')),
                in_array($input['participant_difficulty'] ?? '', ['easy', 'normal', 'hard', 'extreme'], true) ? $input['participant_difficulty'] : 'normal',
                'public', 'draft',
                json_encode($capabilities),
                max(0, (int)($input['max_attempts'] ?? 0)),
                max(0, (int)($input['cooldown_minutes'] ?? 0)),
                !empty($input['open_at']) ? $input['open_at'] : null,
                !empty($input['close_at']) ? $input['close_at'] : null,
                max(0, (int)($input['max_issuance'] ?? 0)),
                max(0, (int)($input['credential_ttl_days'] ?? 0)),
                $user['id'],
            ]);
            $programId = (int)$db->lastInsertId();

            $stmt = $db->prepare(
                'INSERT INTO recognition_program_versions (program_id, version_no, status, content_snapshot)
                 VALUES (?, ?, ?, ?)'
            );
            $stmt->execute([$programId, 'v0.1', 'draft', json_encode($content, JSON_UNESCAPED_UNICODE)]);
            $db->commit();
        } catch (Throwable $e) {
            $db->rollBack();
            error_log('[recog] create program failed: ' . $e->getMessage());
            recogRespond(['success' => false, 'message' => '创建失败'], 500);
        }

        logAction('recog_program_created', 'recognition_program', $programId, ['club_id' => $clubId, 'country' => $country, 'type' => $type]);
        recogRespond(['success' => true, 'program_id' => $programId, 'tier' => recogDetectTier($capabilities)]);
    }

    // ---- 更新草稿（已发布版本不可变，修改进入新草稿版本） ----
    case 'update': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = recogInput();
        $programId = (int)($input['program_id'] ?? 0);

        $stmt = $db->prepare('SELECT * FROM recognition_programs WHERE id = ?');
        $stmt->execute([$programId]);
        $program = $stmt->fetch();
        if (!$program) recogRespond(['success' => false, 'message' => '考核不存在'], 404);
        if (!recogCanDesign($user, (int)$program['club_id'], (string)$program['country'])) {
            recogRespond(['success' => false, 'message' => '无权修改该考核'], 403);
        }

        $type = isset($input['type']) && in_array($input['type'], RECOG_PROGRAM_TYPES, true) ? $input['type'] : $program['type'];
        $content = $input['content'] ?? null;

        $db->beginTransaction();
        try {
            // 项目字段更新
            $updates = [];
            $params = [];
            foreach (['title', 'intro', 'participant_difficulty', 'open_at', 'close_at'] as $f) {
                if (array_key_exists($f, $input)) {
                    $updates[] = "$f = ?";
                    $params[] = $f === 'title' ? trim((string)$input[$f]) : $input[$f];
                }
            }
            foreach (['max_attempts', 'cooldown_minutes', 'max_issuance', 'credential_ttl_days'] as $f) {
                if (array_key_exists($f, $input)) {
                    $updates[] = "$f = ?";
                    $params[] = max(0, (int)$input[$f]);
                }
            }
            $effTtl = array_key_exists('credential_ttl_days', $input) ? max(0, (int)$input['credential_ttl_days']) : (int)$program['credential_ttl_days'];
            $effMax = array_key_exists('max_issuance', $input) ? max(0, (int)$input['max_issuance']) : (int)$program['max_issuance'];
            if ($content !== null) {
                $err = recogValidateContent($content, $type, (int)$program['club_id'], (string)$program['country']);
                if ($err !== null) { $db->rollBack(); recogRespond(['success' => false, 'message' => $err]); }
                $capabilities = recogDeriveCapabilities($content, $type, [
                    'credential_ttl_days' => $effTtl,
                    'max_issuance' => $effMax,
                ]);
                $updates[] = 'capabilities = ?';
                $params[] = json_encode($capabilities);
                $updates[] = 'type = ?';
                $params[] = $type;
            } elseif (array_key_exists('credential_ttl_days', $input) || array_key_exists('max_issuance', $input)) {
                // 仅字段变化：同步增删 credential.expiring / credential.limited 能力
                $caps = json_decode((string)$program['capabilities'], true) ?: [];
                $caps = array_values(array_filter($caps, function ($c) use ($effTtl, $effMax) {
                    if ($c === 'credential.expiring') return $effTtl > 0;
                    if ($c === 'credential.limited') return $effMax > 0;
                    return true;
                }));
                $caps = recogAugmentCapsWithFields($caps, ['credential_ttl_days' => $effTtl, 'max_issuance' => $effMax]);
                $updates[] = 'capabilities = ?';
                $params[] = json_encode(array_values(array_unique($caps)));
            }
            if ($updates) {
                $params[] = $programId;
                $db->prepare('UPDATE recognition_programs SET ' . implode(', ', $updates) . ' WHERE id = ?')
                    ->execute($params);
            }

            // 内容进入草稿版本
            if ($content !== null) {
                $stmt = $db->prepare(
                    "SELECT id FROM recognition_program_versions WHERE program_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1"
                );
                $stmt->execute([$programId]);
                $draft = $stmt->fetch();
                if ($draft) {
                    $db->prepare('UPDATE recognition_program_versions SET content_snapshot = ? WHERE id = ?')
                        ->execute([json_encode($content, JSON_UNESCAPED_UNICODE), $draft['id']]);
                } else {
                    // 无草稿：基于版本数创建新草稿版本（旧已发布版本保持不变）
                    $stmt = $db->prepare('SELECT COUNT(*) AS c FROM recognition_program_versions WHERE program_id = ?');
                    $stmt->execute([$programId]);
                    $nextNo = 'v0.' . (((int)$stmt->fetch()['c']) + 1);
                    $db->prepare(
                        'INSERT INTO recognition_program_versions (program_id, version_no, status, content_snapshot) VALUES (?, ?, ?, ?)'
                    )->execute([$programId, $nextNo, 'draft', json_encode($content, JSON_UNESCAPED_UNICODE)]);
                }
            }
            $db->commit();
        } catch (Throwable $e) {
            $db->rollBack();
            error_log('[recog] update program failed: ' . $e->getMessage());
            recogRespond(['success' => false, 'message' => '更新失败'], 500);
        }

        logAction('recog_program_updated', 'recognition_program', $programId);
        recogRespond(['success' => true]);
    }

    // ---- 发布：草稿版本 → published，旧 published → superseded ----
    case 'publish': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = recogInput();
        $programId = (int)($input['program_id'] ?? 0);

        $stmt = $db->prepare('SELECT * FROM recognition_programs WHERE id = ?');
        $stmt->execute([$programId]);
        $program = $stmt->fetch();
        if (!$program) recogRespond(['success' => false, 'message' => '考核不存在'], 404);
        if (!recogCanDesign($user, (int)$program['club_id'], (string)$program['country'])) {
            recogRespond(['success' => false, 'message' => '无权发布该考核'], 403);
        }

        $stmt = $db->prepare(
            "SELECT * FROM recognition_program_versions WHERE program_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1"
        );
        $stmt->execute([$programId]);
        $draft = $stmt->fetch();
        if (!$draft) recogRespond(['success' => false, 'message' => '没有可发布的草稿版本']);

        // 发布前再次校验快照内容
        $content = json_decode($draft['content_snapshot'], true) ?: [];
        $err = recogValidateContent($content, (string)$program['type'], (int)$program['club_id'], (string)$program['country']);
        if ($err !== null) recogRespond(['success' => false, 'message' => '发布校验失败：' . $err]);

        $db->beginTransaction();
        try {
            $db->prepare("UPDATE recognition_program_versions SET status = 'superseded' WHERE program_id = ? AND status = 'published'")
                ->execute([$programId]);
            $db->prepare(
                "UPDATE recognition_program_versions SET status = 'published', published_by = ?, published_at = ? WHERE id = ?"
            )->execute([$user['id'], date('Y-m-d H:i:s'), $draft['id']]);
            $newStatus = $program['status'] === 'archived' ? 'published' : ($program['status'] === 'draft' ? 'published' : $program['status']);
            if (in_array($program['status'], ['draft', 'paused', 'archived'], true)) {
                $newStatus = 'published';
            }
            $db->prepare('UPDATE recognition_programs SET status = ? WHERE id = ?')->execute([$newStatus, $programId]);
            $db->commit();
        } catch (Throwable $e) {
            $db->rollBack();
            error_log('[recog] publish failed: ' . $e->getMessage());
            recogRespond(['success' => false, 'message' => '发布失败'], 500);
        }

        logAction('recog_program_published', 'recognition_program', $programId, ['version_id' => (int)$draft['id'], 'version_no' => $draft['version_no']]);
        recogRespond(['success' => true, 'version_id' => (int)$draft['id'], 'version_no' => $draft['version_no']]);
    }

    // ---- 暂停 / 恢复 / 归档 ----
    case 'set_status': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = recogInput();
        $programId = (int)($input['program_id'] ?? 0);
        $target = (string)($input['status'] ?? '');
        if (!in_array($target, ['paused', 'published', 'archived'], true)) {
            recogRespond(['success' => false, 'message' => '目标状态非法']);
        }

        $stmt = $db->prepare('SELECT * FROM recognition_programs WHERE id = ?');
        $stmt->execute([$programId]);
        $program = $stmt->fetch();
        if (!$program) recogRespond(['success' => false, 'message' => '考核不存在'], 404);
        if (!recogCanDesign($user, (int)$program['club_id'], (string)$program['country'])) {
            recogRespond(['success' => false, 'message' => '无权操作'], 403);
        }
        $db->prepare('UPDATE recognition_programs SET status = ? WHERE id = ?')->execute([$target, $programId]);
        logAction('recog_program_status_' . $target, 'recognition_program', $programId);
        recogRespond(['success' => true]);
    }

    // ---- 同好会管理列表（含全部状态） ----
    case 'manage': {
        $user = requireLogin();
        $clubId = (int)($_GET['club_id'] ?? 0);
        $country = displayClubCountry((string)($_GET['country'] ?? 'china')) ?? 'china';
        if (!recogCanDesign($user, $clubId, $country) && $user['role'] !== 'super_admin') {
            recogRespond(['success' => false, 'message' => '权限不足'], 403);
        }
        $stmt = $db->prepare(
            'SELECT id, type, title, status, capabilities, open_at, close_at, credential_ttl_days, max_issuance, created_at
             FROM recognition_programs WHERE club_id = ? AND country = ? ORDER BY created_at DESC'
        );
        $stmt->execute([$clubId, $country]);
        $rows = [];
        foreach ($stmt->fetchAll() as $row) {
            $caps = recogAugmentCapsWithFields(json_decode($row['capabilities'], true) ?: [], $row);
            $row['tier'] = recogDetectTier($caps);
            $c = $db->prepare('SELECT COUNT(*) AS c FROM recognition_credentials WHERE program_id = ?');
            $c->execute([(int)$row['id']]);
            $row['issued_total'] = (int)$c->fetch()['c'];
            unset($row['capabilities']);
            $rows[] = $row;
        }
        recogRespond(['success' => true, 'programs' => $rows]);
    }

    // ---- 徽章定义：创建 ----
    case 'badge_create': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = recogInput();
        $clubId = (int)($input['club_id'] ?? 0);
        $country = displayClubCountry((string)($input['country'] ?? 'china')) ?? 'china';
        if (!recogHasRole($user, $clubId, $country, 'badge_manager') && $user['role'] !== 'super_admin' && !canManageClub($user, $clubId)) {
            recogRespond(['success' => false, 'message' => '无权管理该同好会徽章'], 403);
        }
        $name = trim((string)($input['name'] ?? ''));
        if ($name === '' || recogSafeStrlen($name) > 60) {
            recogRespond(['success' => false, 'message' => '徽章名称必填且不超过 60 字']);
        }
        $categories = ['knowledge', 'skill', 'participation', 'contribution', 'competition', 'honor', 'memorial', 'joint'];
        $category = in_array($input['category'] ?? '', $categories, true) ? $input['category'] : 'participation';

        $stmt = $db->prepare(
            'INSERT INTO recognition_badges (club_id, country, name, category, description, image_url, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $clubId, $country, $name, $category,
            trim((string)($input['description'] ?? '')),
            trim((string)($input['image_url'] ?? '')),
            $user['id'],
        ]);
        $badgeId = (int)$db->lastInsertId();
        logAction('recog_badge_created', 'recognition_badge', $badgeId, ['club_id' => $clubId, 'name' => $name]);
        recogRespond(['success' => true, 'badge_id' => $badgeId]);
    }

    // ---- 徽章定义：更新 ----
    case 'badge_update': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = recogInput();
        $badgeId = (int)($input['badge_id'] ?? 0);
        $clubId = (int)($input['club_id'] ?? 0);
        $country = displayClubCountry((string)($input['country'] ?? 'china')) ?? 'china';
        if (!recogHasRole($user, $clubId, $country, 'badge_manager') && $user['role'] !== 'super_admin' && !canManageClub($user, $clubId)) {
            recogRespond(['success' => false, 'message' => '无权管理该同好会徽章'], 403);
        }
        $stmt = $db->prepare('SELECT * FROM recognition_badges WHERE id = ?');
        $stmt->execute([$badgeId]);
        $badge = $stmt->fetch();
        if (!$badge || (int)$badge['club_id'] !== $clubId || (string)$badge['country'] !== $country) {
            recogRespond(['success' => false, 'message' => '徽章不存在或不属于该同好会'], 404);
        }

        $sets = [];
        $params = [];
        if (array_key_exists('name', $input)) {
            $name = trim((string)$input['name']);
            if ($name === '' || recogSafeStrlen($name) > 60) {
                recogRespond(['success' => false, 'message' => '徽章名称必填且不超过 60 字']);
            }
            $sets[] = 'name = ?';
            $params[] = $name;
        }
        if (array_key_exists('category', $input)) {
            $categories = ['knowledge', 'skill', 'participation', 'contribution', 'competition', 'honor', 'memorial', 'joint'];
            $sets[] = 'category = ?';
            $params[] = in_array($input['category'], $categories, true) ? $input['category'] : 'participation';
        }
        if (array_key_exists('description', $input)) {
            $sets[] = 'description = ?';
            $params[] = trim((string)$input['description']);
        }
        if (array_key_exists('image_url', $input)) {
            $sets[] = 'image_url = ?';
            $params[] = trim((string)$input['image_url']);
        }
        if (!$sets) recogRespond(['success' => false, 'message' => '没有需要更新的字段']);

        $sets[] = 'version = version + 1';
        $params[] = $badgeId;
        $db->prepare('UPDATE recognition_badges SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($params);
        logAction('recog_badge_updated', 'recognition_badge', $badgeId, ['club_id' => $clubId]);
        recogRespond(['success' => true, 'version' => (int)$badge['version'] + 1]);
    }

    // ---- 徽章定义：同好会列表 ----
    case 'badge_list': {
        $clubId = (int)($_GET['club_id'] ?? 0);
        $country = displayClubCountry((string)($_GET['country'] ?? 'china')) ?? 'china';
        $stmt = $db->prepare(
            'SELECT id, name, category, description, image_url, version, created_at
             FROM recognition_badges WHERE club_id = ? AND country = ? ORDER BY created_at DESC'
        );
        $stmt->execute([$clubId, $country]);
        recogRespond(['success' => true, 'badges' => $stmt->fetchAll()]);
    }

    // ---- 档位能力参考（公开）：标准/进阶/专家三档能力清单与标签 ----
    case 'caps_reference': {
        recogRespond([
            'success' => true,
            'tiers' => [
                ['key' => 'standard', 'label' => '标准', 'caps' => array_values(RECOGNITION_STANDARD_CAPS)],
                ['key' => 'advanced', 'label' => '进阶', 'caps' => array_values(RECOGNITION_ADVANCED_CAPS)],
                ['key' => 'expert', 'label' => '专家', 'caps' => array_values(RECOGNITION_EXPERT_CAPS)],
            ],
            'cap_labels' => RECOGNITION_CAP_LABELS,
            'implemented' => array_values(RECOGNITION_IMPLEMENTED_CAPS),
            'note' => '层级不落库：保存时按实际使用能力自动判定，档位选择器仅控制编辑器可见范围。',
        ]);
    }

    default:
        recogRespond(['success' => false, 'message' => '未知操作'], 400);
}
