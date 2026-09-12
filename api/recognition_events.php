<?php
// api/recognition_events.php - 统一事件接入（外部唯一官方入口，对齐架构文档 12.3）
// 动作:
//   submit          - 外部 Connector 提交事实事件（Bearer Token，可选 HMAC 签名）
//   connector_create / connector_list / connector_revoke - 同好会 Connector 管理
//
// 边界（架构文档 11.3）：Connector 只提交事实，不直接写凭证、不改成就库；
// 是否满足条件由规则引擎判断，签发由凭证服务执行。

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Recog-Signature, X-Recog-Timestamp');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/audit.php';
require_once __DIR__ . '/../includes/rate_limit.php';
require_once __DIR__ . '/../includes/recognition/events.php';
require_once __DIR__ . '/../includes/recognition/signature.php';
require_once __DIR__ . '/../includes/recognition/pipeline.php';
require_once __DIR__ . '/../includes/recognition/roles.php';

function recogRespond(array $payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

$action = $_GET['action'] ?? '';
$db = getDB();

switch ($action) {

    // ---- 外部系统提交事实事件 ----
    case 'submit': {
        checkRateLimit('recog_event_submit', 120, 1);
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);

        // 1. Bearer Token 定位 Connector（identify + verify_source）
        $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
        if (!preg_match('/^Bearer\s+(.+)$/', $auth, $m)) {
            recogRespond(['success' => false, 'message' => '未提供 API Token'], 401);
        }
        $connector = recogFindConnectorByToken(trim($m[1]));
        if (!$connector) {
            recogRespond(['success' => false, 'message' => 'Token 无效或已吊销'], 403);
        }

        $rawBody = file_get_contents('php://input');
        $body = json_decode($rawBody, true);
        if (!is_array($body)) {
            recogRespond(['success' => false, 'message' => '请求体必须为 JSON'], 400);
        }

        // 2. 可选 HMAC 签名校验（配置了 hmac_secret 的 Connector 强制校验）
        if (($connector['hmac_secret'] ?? '') !== '') {
            $verify = recogVerifySignature(
                $connector['hmac_secret'],
                $rawBody,
                $_SERVER['HTTP_X_RECOG_SIGNATURE'] ?? null,
                $_SERVER['HTTP_X_RECOG_TIMESTAMP'] ?? null
            );
            if (!$verify['ok']) {
                recogRespond(['success' => false, 'message' => $verify['error']], 403);
            }
        }

        // 3. 规范化为标准事件结构（架构文档 9.2）
        $type = (string)($body['type'] ?? '');
        $subject = $body['subject'] ?? [];
        $resource = $body['resource'] ?? [];

        // 主体解析：vnfmap_user 直接用；外部主体经 IdentityLink 映射
        $userId = null;
        if (($subject['type'] ?? '') === 'vnfmap_user') {
            $userId = (int)($subject['id'] ?? 0) ?: null;
        } elseif (!empty($subject['type']) && !empty($subject['id'])) {
            $stmt = $db->prepare(
                "SELECT vnfmap_user_id FROM recognition_identity_links
                 WHERE external_provider = ? AND external_subject_id = ? AND revoked_at IS NULL
                   AND verification_status = 'verified'"
            );
            $stmt->execute([(string)$subject['type'], (string)$subject['id']]);
            $link = $stmt->fetch();
            if (!$link || $link['vnfmap_user_id'] === null) {
                recogRespond(['success' => false, 'message' => '外部主体未绑定 VNFMap 账号'], 422);
            }
            $userId = (int)$link['vnfmap_user_id'];
        }

        $versionId = null;
        if (($resource['type'] ?? '') === 'program_version' && !empty($resource['id'])) {
            $versionId = (int)$resource['id'];
            $stmt = $db->prepare("SELECT id, program_id FROM recognition_program_versions WHERE id = ? AND status = 'published'");
            $stmt->execute([$versionId]);
            if (!$stmt->fetch()) {
                recogRespond(['success' => false, 'message' => '项目版本不存在或未发布'], 422);
            }
        }

        // 4. API Scope 校验（最小权限）
        $programIdForScope = null;
        if ($versionId !== null) {
            $stmt = $db->prepare('SELECT program_id FROM recognition_program_versions WHERE id = ?');
            $stmt->execute([$versionId]);
            $programIdForScope = (int)$stmt->fetch()['program_id'];
        }
        if (!recogConnectorAllowsEvent($connector, $type, $programIdForScope)) {
            recogRespond(['success' => false, 'message' => '该事件类型不在 Connector 授权范围内'], 403);
        }

        // 5. 写入统一事件（幂等）
        $record = recogRecordEvent([
            'event_id' => $body['event_id'] ?? null,
            'idempotency_key' => $body['idempotency_key'] ?? null,
            'schema_version' => $body['schema_version'] ?? '1.0',
            'type' => $type,
            'club_id' => (int)$connector['club_id'],
            'country' => (string)$connector['country'],
            'user_id' => $userId,
            'program_id' => $programIdForScope,
            'program_version_id' => $versionId,
            'connector_id' => (int)$connector['id'],
            'occurred_at' => isset($body['occurred_at']) ? date('Y-m-d H:i:s', strtotime($body['occurred_at'])) : date('Y-m-d H:i:s'),
            'data' => $body['data'] ?? null,
            'evidence_refs' => $body['evidence_refs'] ?? null,
            'source_verified' => true,
        ]);
        if ($record['error']) {
            recogRespond(['success' => false, 'message' => $record['error']], 422);
        }
        if ($record['duplicate']) {
            recogRespond(['success' => true, 'duplicate' => true, 'message' => '事件已处理过，返回原结果']);
        }

        // 6. 同步规则评估（携带数据中的 score 等上下文）；是否签发由规则决定
        $award = ['passed' => false, 'issued' => false, 'credential' => null, 'duplicate' => false, 'error' => null];
        if ($versionId !== null && $userId !== null) {
            $data = is_array($body['data'] ?? null) ? $body['data'] : [];
            $award = recogEvaluateAndAward($versionId, $userId, [
                'score' => isset($data['score']) ? (float)$data['score'] : null,
                'source' => 'external',
            ]);
        }

        recogRespond([
            'success' => true,
            'event_id' => $record['event']['event_id'] ?? null,
            'passed' => $award['passed'],
            'issued' => $award['issued'],
            'message' => $award['error'] ?: '事件已受理',
        ]);
    }

    // ---- makoquiz 战绩桥接（首个正式 Connector，对齐落地方案建议决策）----
    // 将 quiz_results 中的历史/新增战绩规范化为 assessment.completed 标准事件，
    // 再由规则引擎决定是否签发；不直接写凭证。
    case 'quiz_sync': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $programId = (int)($input['program_id'] ?? 0);
        $since = (int)($input['since'] ?? 0); // 毫秒时间戳，只同步该时刻之后的战绩；0 = 全部（限量）
        $limit = min(500, max(1, (int)($input['limit'] ?? 200)));

        $stmt = $db->prepare('SELECT * FROM recognition_programs WHERE id = ?');
        $stmt->execute([$programId]);
        $program = $stmt->fetch();
        if (!$program) recogRespond(['success' => false, 'message' => '项目不存在'], 404);
        if ($program['type'] !== 'assessment') {
            recogRespond(['success' => false, 'message' => '答题战绩只能桥接到 assessment 类型项目']);
        }
        if (!recogCanIssue($user, (int)$program['club_id'], (string)$program['country'])
            && !recogHasRole($user, (int)$program['club_id'], (string)$program['country'], 'integration_manager')
            && $user['role'] !== 'super_admin') {
            recogRespond(['success' => false, 'message' => '无权为该项目同步答题战绩'], 403);
        }
        $version = recogPublishedVersion($db, $programId);
        if (!$version) recogRespond(['success' => false, 'message' => '该项目尚无已发布版本']);
        if (empty($version['content']['quiz'])) {
            recogRespond(['success' => false, 'message' => '目标项目未配置答题内容，无法桥接战绩']);
        }

        $sql = 'SELECT * FROM quiz_results WHERE vnfest_user_id > 0';
        $params = [];
        if ($since > 0) { $sql .= ' AND ended_at >= ?'; $params[] = $since; }
        $sql .= ' ORDER BY ended_at ASC LIMIT ?';
        $params[] = $limit;
        $stmt = $db->prepare($sql);
        foreach ($params as $i => $p) {
            $stmt->bindValue($i + 1, $p, PDO::PARAM_INT);
        }
        $stmt->execute();
        $rows = $stmt->fetchAll();

        $synced = 0; $awarded = 0; $skipped = 0;
        foreach ($rows as $r) {
            // 规范化为标准事件（幂等键绑定战绩唯一三元组，重复同步不重复处理）
            $record = recogRecordEvent([
                'type' => 'assessment.completed',
                'idempotency_key' => 'makoquiz_' . $r['room_code'] . '_' . $r['vnfest_user_id'] . '_' . $r['ended_at'],
                'club_id' => (int)$program['club_id'],
                'country' => (string)$program['country'],
                'user_id' => (int)$r['vnfest_user_id'],
                'program_id' => $programId,
                'program_version_id' => (int)$version['id'],
                'occurred_at' => date('Y-m-d H:i:s', (int)((int)$r['ended_at'] / 1000)),
                'data' => [
                    'score' => (int)$r['score'],
                    'room_code' => $r['room_code'],
                    'quiz_title' => $r['quiz_title'],
                    'player_rank' => (int)$r['player_rank'],
                ],
                'source_verified' => true,
            ]);
            if ($record['error'] !== null) { $skipped++; continue; }
            $synced++;
            if ($record['duplicate']) continue;

            // 规则评估与签发（外部来源）
            $award = recogEvaluateAndAward((int)$version['id'], (int)$r['vnfest_user_id'], [
                'score' => (float)$r['score'],
                'source' => 'external',
            ]);
            if ($award['issued']) $awarded++;
        }

        logAction('recog_quiz_sync', 'recognition_program', $programId, [
            'synced' => $synced, 'awarded' => $awarded, 'skipped' => $skipped,
        ]);
        recogRespond([
            'success' => true,
            'synced' => $synced,
            'awarded' => $awarded,
            'skipped' => $skipped,
            'message' => "已同步 {$synced} 条战绩，新签发 {$awarded} 份凭证（重复提交已幂等去重）",
        ]);
    }

    // ---- Connector 管理：创建 ----
    case 'connector_create': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $clubId = (int)($input['club_id'] ?? 0);
        $country = in_array($input['country'] ?? 'china', ['china', 'japan'], true) ? $input['country'] : 'china';

        // Integration Manager 角色（MVP 阶段由同好会管理员兼任）
        if (!recogHasRole($user, $clubId, $country, 'integration_manager')
            && !canManageClub($user, $clubId)
            && $user['role'] !== 'super_admin') {
            recogRespond(['success' => false, 'message' => '无权管理该同好会的 Connector'], 403);
        }

        $name = trim((string)($input['name'] ?? ''));
        if ($name === '' || recogSafeStrlen($name) > 128) recogRespond(['success' => false, 'message' => '请填写 Connector 名称']);
        $types = ['webhook', 'rest_api', 'discord', 'qq', 'csv', 'qr', 'claim_code', 'game', 'manual', 'event_platform'];
        $type = in_array($input['type'] ?? '', $types, true) ? $input['type'] : 'webhook';

        // scope：默认只允许 event:write，可限定事件类型与项目
        $scope = [
            'permissions' => ['event:write'],
            'event_types' => array_values(array_filter((array)($input['event_types'] ?? []))),
            'program_ids' => array_map('intval', (array)($input['program_ids'] ?? [])),
        ];

        // Token 只返回一次，数据库仅存哈希
        $token = 'recog_' . bin2hex(random_bytes(24));
        $prefix = substr($token, 0, 12);
        $hmacSecret = !empty($input['enable_hmac']) ? bin2hex(random_bytes(24)) : '';

        $stmt = $db->prepare(
            'INSERT INTO recognition_connectors (club_id, country, name, type, token_prefix, token_hash, hmac_secret, scope, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $clubId, $country, $name, $type, $prefix,
            hash('sha256', $token), $hmacSecret,
            json_encode($scope), (int)$user['id'],
        ]);
        $connectorId = (int)$db->lastInsertId();
        logAction('recog_connector_created', 'recognition_connector', $connectorId, ['club_id' => $clubId]);

        recogRespond([
            'success' => true,
            'connector_id' => $connectorId,
            'token' => $token,
            'hmac_secret' => $hmacSecret,
            'message' => 'Token 只展示这一次，请妥善保存',
        ]);
    }

    // ---- Connector 管理：列表 ----
    case 'connector_list': {
        $user = requireLogin();
        $clubId = (int)($_GET['club_id'] ?? 0);
        $country = in_array($_GET['country'] ?? 'china', ['china', 'japan'], true) ? $_GET['country'] : 'china';
        if (!canManageClub($user, $clubId) && $user['role'] !== 'super_admin') {
            recogRespond(['success' => false, 'message' => '权限不足'], 403);
        }
        $stmt = $db->prepare(
            'SELECT id, name, type, scope, status, created_at, last_used_at, revoked_at
             FROM recognition_connectors WHERE club_id = ? AND country = ? ORDER BY id DESC'
        );
        $stmt->execute([$clubId, $country]);
        $rows = $stmt->fetchAll();
        foreach ($rows as &$r) {
            $r['scope'] = json_decode($r['scope'], true) ?: [];
        }
        unset($r);
        recogRespond(['success' => true, 'connectors' => $rows]);
    }

    // ---- Connector 管理：吊销 ----
    case 'connector_revoke': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $connectorId = (int)($input['connector_id'] ?? 0);

        $stmt = $db->prepare('SELECT * FROM recognition_connectors WHERE id = ?');
        $stmt->execute([$connectorId]);
        $connector = $stmt->fetch();
        if (!$connector) recogRespond(['success' => false, 'message' => 'Connector 不存在'], 404);
        if (!canManageClub($user, (int)$connector['club_id']) && $user['role'] !== 'super_admin') {
            recogRespond(['success' => false, 'message' => '权限不足'], 403);
        }
        $db->prepare("UPDATE recognition_connectors SET status = 'revoked', revoked_at = ? WHERE id = ?")
            ->execute([date('Y-m-d H:i:s'), $connectorId]);
        logAction('recog_connector_revoked', 'recognition_connector', $connectorId);
        recogRespond(['success' => true]);
    }

    default:
        recogRespond(['success' => false, 'message' => '未知操作'], 400);
}
