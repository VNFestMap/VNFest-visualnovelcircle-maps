<?php
// api/recognition_credentials.php - 成就库与凭证管理
// 动作: my / verify / set_visibility / revoke / grant / batch_import / club_list
// 签发一律经 includes/recognition/credential.php 的 issueCredential()（统一签发）。

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
require_once __DIR__ . '/../includes/display_club.php';
require_once __DIR__ . '/../includes/recognition/roles.php';
require_once __DIR__ . '/../includes/recognition/credential.php';
require_once __DIR__ . '/../includes/recognition/events.php';

function recogRespond(array $payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * 凭证展示用的联表查询（徽章 + 项目 + 同好会名）
 */
function recogFetchCredentials(string $where, array $params, int $limit = 200): array {
    $db = getDB();
    $stmt = $db->prepare(
        "SELECT c.id, c.credential_uid, c.holder_user_id, c.badge_version, c.issuer_club_id, c.issuer_country,
                c.program_id, c.program_version_id, c.credential_type, c.verification_level, c.status,
                c.condition_snapshot, c.public_visibility, c.issued_at, c.expires_at,
                c.revocation_reason, c.revoked_at, c.superseded_by,
                b.name AS badge_name, b.category AS badge_category, b.image_url AS badge_image,
                p.title AS program_title, p.type AS program_type
         FROM recognition_credentials c
         JOIN recognition_badges b ON b.id = c.badge_id
         JOIN recognition_programs p ON p.id = c.program_id
         WHERE $where
         ORDER BY c.issued_at DESC
         LIMIT " . (int)$limit
    );
    $stmt->execute($params);
    $rows = [];
    foreach ($stmt->fetchAll() as $row) {
        $club = displayClubRecord((int)$row['issuer_club_id'], (string)$row['issuer_country']);
        $row['club_name'] = $club['name'] ?? '同好会 #' . $row['issuer_club_id'];
        $row['conditions'] = (json_decode($row['condition_snapshot'] ?? '', true) ?: [])['conditions'] ?? [];
        unset($row['condition_snapshot']);
        $rows[] = $row;
    }
    return $rows;
}

$action = $_GET['action'] ?? '';
$db = getDB();

switch ($action) {

    // ---- 我的成就库（含过期 / 撤销 / 替代的历史凭证） ----
    case 'my': {
        $user = requireLogin();
        $credentials = recogFetchCredentials('c.holder_user_id = ?', [(int)$user['id']]);
        $summary = [
            'total' => count($credentials),
            'active' => 0,
            'clubs' => [],
        ];
        foreach ($credentials as $c) {
            if ($c['status'] === 'active') {
                $summary['active']++;
                $summary['clubs'][$c['issuer_club_id'] . ':' . $c['issuer_country']] = $c['club_name'];
            }
        }
        $summary['club_count'] = count($summary['clubs']);
        unset($summary['clubs']);
        recogRespond(['success' => true, 'summary' => $summary, 'credentials' => $credentials]);
    }

    // ---- 公开验证页数据（无需登录，仅暴露必要字段） ----
    case 'verify': {
        checkRateLimit('recog_verify', 60, 1);
        $uid = trim((string)($_GET['uid'] ?? ''));
        if ($uid === '') recogRespond(['success' => false, 'message' => '缺少凭证编号']);

        $credentials = recogFetchCredentials('c.credential_uid = ?', [$uid], 1);
        if (!$credentials) recogRespond(['success' => false, 'message' => '未找到该凭证编号'], 404);
        $c = $credentials[0];

        if (!(int)$c['public_visibility'] && $c['status'] === 'active') {
            // 持有人关闭公开：验证页仅确认存在性与状态，不展示细节
            recogRespond([
                'success' => true,
                'credential' => [
                    'credential_uid' => $c['credential_uid'],
                    'status' => $c['status'],
                    'public_visibility' => 0,
                    'status_text' => '该凭证持有人选择不公开详情',
                ],
            ]);
        }

        $statusText = [
            'active' => '有效',
            'expired' => '已过期',
            'revoked' => '历史凭证，当前已撤销',
            'superseded' => '已被新版本替代',
        ][$c['status']] ?? $c['status'];

        recogRespond([
            'success' => true,
            'credential' => [
                'credential_uid' => $c['credential_uid'],
                'badge_name' => $c['badge_name'],
                'badge_category' => $c['badge_category'],
                'badge_image' => $c['badge_image'],
                'club_name' => $c['club_name'],
                'program_title' => $c['program_title'],
                'credential_type' => $c['credential_type'],
                'verification_level' => $c['verification_level'],
                'status' => $c['status'],
                'status_text' => $statusText,
                'issued_at' => $c['issued_at'],
                'expires_at' => $c['expires_at'],
                'revoked_at' => $c['revoked_at'],
                'conditions' => $c['conditions'],
            ],
        ]);
    }

    // ---- 持有人设置公开可见性 ----
    case 'set_visibility': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $uid = trim((string)($input['credential_uid'] ?? ''));
        $visible = !empty($input['public_visibility']) ? 1 : 0;

        $stmt = $db->prepare('SELECT id, holder_user_id FROM recognition_credentials WHERE credential_uid = ?');
        $stmt->execute([$uid]);
        $cred = $stmt->fetch();
        if (!$cred || (int)$cred['holder_user_id'] !== (int)$user['id']) {
            recogRespond(['success' => false, 'message' => '凭证不存在或不属于你'], 404);
        }
        $db->prepare('UPDATE recognition_credentials SET public_visibility = ? WHERE id = ?')
            ->execute([$visible, $cred['id']]);
        logAction('recog_credential_visibility', 'recognition_credential', (int)$cred['id'], ['public_visibility' => $visible]);
        recogRespond(['success' => true]);
    }

    // ---- 撤销凭证（签发同好会负责人/管理员或平台管理员，必须填写原因） ----
    case 'revoke': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $uid = trim((string)($input['credential_uid'] ?? ''));
        $reason = trim((string)($input['reason'] ?? ''));

        $stmt = $db->prepare('SELECT * FROM recognition_credentials WHERE credential_uid = ?');
        $stmt->execute([$uid]);
        $cred = $stmt->fetch();
        if (!$cred) recogRespond(['success' => false, 'message' => '凭证不存在'], 404);

        $isIssuerAdmin = recogCanIssue($user, (int)$cred['issuer_club_id'], (string)$cred['issuer_country']);
        if (!$isIssuerAdmin && $user['role'] !== 'super_admin') {
            recogRespond(['success' => false, 'message' => '只有签发同好会管理员或平台管理员可撤销'], 403);
        }

        $result = revokeCredential($db, $uid, $reason, (int)$user['id']);
        if (!$result['ok']) recogRespond(['success' => false, 'message' => $result['error']]);
        recogRespond(['success' => true, 'message' => '凭证已撤销，历史记录保留']);
    }

    // ---- 人工授予（award.manual）----
    case 'grant': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') recogRespond(['success' => false, 'message' => '仅支持 POST']);
        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $usernames = array_filter(array_map('trim', (array)($input['usernames'] ?? [])));
        $programId = (int)($input['program_id'] ?? 0);

        if (!$usernames) recogRespond(['success' => false, 'message' => '请填写至少一个用户名']);
        if (count($usernames) > 200) recogRespond(['success' => false, 'message' => '单次最多授予 200 人']);

        $stmt = $db->prepare('SELECT * FROM recognition_programs WHERE id = ?');
        $stmt->execute([$programId]);
        $program = $stmt->fetch();
        if (!$program) recogRespond(['success' => false, 'message' => '认可项目不存在'], 404);
        if ($program['type'] !== 'award' && $program['type'] !== 'activity') {
            recogRespond(['success' => false, 'message' => '人工授予仅支持 award / activity 类型项目']);
        }
        if (!recogCanIssue($user, (int)$program['club_id'], (string)$program['country']) && $user['role'] !== 'super_admin') {
            recogRespond(['success' => false, 'message' => '无权为该同好会授予凭证'], 403);
        }
        $version = recogPublishedVersion($db, $programId);
        if (!$version) recogRespond(['success' => false, 'message' => '该项目尚无已发布版本']);

        $badgeId = (int)($version['content']['rules']['award']['badge_id'] ?? 0);
        if ($badgeId <= 0) recogRespond(['success' => false, 'message' => '项目未配置奖励徽章']);

        $granted = 0; $skipped = [];
        foreach ($usernames as $username) {
            $stmt = $db->prepare("SELECT id FROM users WHERE username = ? AND status = 'active'");
            $stmt->execute([$username]);
            $target = $stmt->fetch();
            if (!$target) { $skipped[] = $username; continue; }

            // award.approved 事实事件（人工授予事实）
            recogRecordEvent([
                'type' => 'award.approved',
                'idempotency_key' => 'grant_' . $version['id'] . '_' . $target['id'],
                'club_id' => (int)$program['club_id'],
                'country' => (string)$program['country'],
                'user_id' => (int)$target['id'],
                'program_id' => $programId,
                'program_version_id' => (int)$version['id'],
                'badge_id' => $badgeId,
                'data' => ['granted_by' => $user['id']],
                'source_verified' => true,
            ]);

            $issue = issueCredential($db, [
                'holder_user_id' => (int)$target['id'],
                'badge_id' => $badgeId,
                'issuer_club_id' => (int)$program['club_id'],
                'issuer_country' => (string)$program['country'],
                'program_id' => $programId,
                'program_version_id' => (int)$version['id'],
                'credential_type' => 'honor',
                'verification_level' => 'owner_grant',
                'condition_summary' => ['同好会负责人特别授予'],
                'source_type' => 'manual_grant',
                'actor_user_id' => (int)$user['id'],
            ]);
            if ($issue['ok'] && !$issue['duplicate']) $granted++;
            if ($issue['duplicate']) $skipped[] = $username . '（已持有）';
        }
        recogRespond(['success' => true, 'granted' => $granted, 'skipped' => $skipped]);
    }

    // ---- 同好会凭证列表（管理视图） ----
    case 'club_list': {
        $user = requireLogin();
        $clubId = (int)($_GET['club_id'] ?? 0);
        $country = displayClubCountry((string)($_GET['country'] ?? 'china')) ?? 'china';
        if (!recogHasRole($user, $clubId, $country, 'auditor')
            && !recogCanIssue($user, $clubId, $country)
            && $user['role'] !== 'super_admin') {
            recogRespond(['success' => false, 'message' => '权限不足'], 403);
        }
        $credentials = recogFetchCredentials('c.issuer_club_id = ? AND c.issuer_country = ?', [$clubId, $country]);
        // 管理视图补充持有人用户名
        $userIds = array_unique(array_map(fn($c) => (int)$c['holder_user_id'], $credentials));
        $names = [];
        if ($userIds) {
            $placeholders = implode(',', array_fill(0, count($userIds), '?'));
            $stmt = $db->prepare("SELECT id, username, nickname FROM users WHERE id IN ($placeholders)");
            $stmt->execute($userIds);
            foreach ($stmt->fetchAll() as $u) {
                $names[(int)$u['id']] = $u['nickname'] !== '' && $u['nickname'] !== null ? $u['nickname'] : $u['username'];
            }
        }
        foreach ($credentials as &$c) {
            $c['holder_name'] = $names[(int)$c['holder_user_id']] ?? ('user#' . $c['holder_user_id']);
        }
        unset($c);
        recogRespond(['success' => true, 'credentials' => $credentials]);
    }

    default:
        recogRespond(['success' => false, 'message' => '未知操作'], 400);
}
