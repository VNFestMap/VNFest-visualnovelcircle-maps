<?php
// api/vote_nominations.php - shared nomination and entry review API.

require_once __DIR__ . '/../includes/vote_projects.php';
require_once __DIR__ . '/../includes/audit.php';
require_once __DIR__ . '/../includes/image_proxy_helper.php';
require_once __DIR__ . '/../includes/rate_limit.php';

voteBootstrap();
voteEnsureSchema();
$action = trim((string)($_GET['action'] ?? ''));
$db = getDB();

// 提名提交按 IP 限频
if ($action === 'submit' || $action === 'nominate') {
    checkRateLimit('vote_nominate', 12, 1);
}

function voteEntryFromInput(array $input, array $project): array {
    $sourceType = trim((string)($input['source_type'] ?? 'manual'));
    $allowed = ($project['project_type'] ?? '') === 'moe'
        ? ['bangumi_character', 'manual']
        : ['bangumi_subject', 'vndb_vn', 'manual'];
    if (!in_array($sourceType, $allowed, true)) $sourceType = 'manual';
    $imageUrl = trim((string)($input['image_url'] ?? ''));
    $entry = [
        'source_type' => $sourceType,
        'source_id' => trim((string)($input['source_id'] ?? '')),
        'title' => trim((string)($input['title'] ?? '')),
        'title_cn' => trim((string)($input['title_cn'] ?? '')),
        'subtitle' => trim((string)($input['subtitle'] ?? '')),
        'image_url' => $imageUrl,
        'summary' => trim((string)($input['summary'] ?? '')),
        'external_url' => trim((string)($input['external_url'] ?? '')),
    ];
    $entry['identity_key'] = voteEntryIdentity($entry);
    return $entry;
}

switch ($action) {
    case 'list':
        $project = voteGetProject((int)($_GET['project_id'] ?? $_GET['contest_id'] ?? 0));
        if (!$project) voteRespond(['success' => false, 'message' => '企划不存在'], 404);
        $user = getCurrentUser();
        if (!voteCanReadProject($user, $project)) voteRespond(['success' => false, 'message' => '无权查看该企划'], 403);
        $status = trim((string)($_GET['status'] ?? ''));
        $where = ['project_id = ?'];
        $params = [(int)$project['id']];
        $canManage = $user ? voteCanManageProject($user, $project) : false;
        if ($status !== '') {
            $where[] = 'entry_status = ?';
            $params[] = $status;
            if (!$canManage && $status !== 'approved') {
                voteRespond(['success' => false, 'message' => '无权查看'], 403);
            }
        } elseif (!$canManage) {
            $where[] = "entry_status = 'approved'";
        }
        $stmt = $db->prepare('SELECT * FROM vote_entries WHERE ' . implode(' AND ', $where) . ' ORDER BY created_at DESC, id DESC');
        $stmt->execute($params);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$r) {
            if (!empty($r['image_url'])) $r['image_url'] = proxyImageUrl($r['image_url']);
        }
        voteRespond(['success' => true, 'data' => $rows]);

    case 'submit':
    case 'nominate':
        $user = requireLogin();
        $input = voteReadJson();
        $project = voteGetProject((int)($input['project_id'] ?? $input['contest_id'] ?? $_GET['project_id'] ?? 0));
        if (!$project) voteRespond(['success' => false, 'message' => '企划不存在'], 404);
        if (!voteCanParticipateProject($user, $project)) voteRespond(['success' => false, 'message' => '当前账号不符合提名资格'], 403);
        $entry = voteEntryFromInput($input, $project);
        if ($entry['title'] === '' && $entry['title_cn'] === '') voteRespond(['success' => false, 'message' => '请填写提名名称'], 400);
        $stageId = (int)($input['stage_id'] ?? 0);
        if ($stageId > 0) {
            $stmt = $db->prepare("SELECT * FROM vote_stages WHERE id = ? AND project_id = ? AND stage_type = 'nomination' AND status = 'open'");
            $stmt->execute([$stageId, (int)$project['id']]);
        } else {
            $stmt = $db->prepare("SELECT * FROM vote_stages WHERE project_id = ? AND stage_type = 'nomination' AND status = 'open' ORDER BY sort_order ASC LIMIT 2");
            $stmt->execute([(int)$project['id']]);
        }
        $openStages = $stmt->fetchAll(PDO::FETCH_ASSOC);
        if (count($openStages) !== 1) {
            voteRespond(['success' => false, 'message' => '当前企划没有唯一开放的提名阶段'], 400);
        }
        $stageId = (int)$openStages[0]['id'];
        $db->beginTransaction();
        try {
            $stmt = $db->prepare('SELECT * FROM vote_entries WHERE project_id = ? AND identity_key = ?');
            $stmt->execute([(int)$project['id'], $entry['identity_key']]);
            $existing = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($existing) {
                $entryId = (int)$existing['id'];
                if (in_array($existing['entry_status'] ?? '', ['removed', 'pending'], true)) {
                    $now = voteNowExpr();
                    $db->prepare("UPDATE vote_entries SET entry_status = 'approved', updated_at = $now WHERE id = ?")->execute([$entryId]);
                }
            } else {
                $ins = $db->prepare(
                    "INSERT INTO vote_entries
                     (project_id, source_type, source_id, title, title_cn, subtitle, image_url, summary, external_url, identity_key, entry_status, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?)"
                );
                $ins->execute([(int)$project['id'], $entry['source_type'], $entry['source_id'], $entry['title'], $entry['title_cn'], $entry['subtitle'], $entry['image_url'], $entry['summary'], $entry['external_url'], $entry['identity_key'], (int)$user['id']]);
                $entryId = (int)$db->lastInsertId();
            }
            // Check for existing nomination record (any status) to handle re-nomination after withdraw
            $existingNom = $db->prepare("SELECT id, status FROM vote_nominations WHERE project_id = ? AND entry_id = ? AND user_id = ?");
            $existingNom->execute([(int)$project['id'], $entryId, (int)$user['id']]);
            $existingNomRow = $existingNom->fetch(PDO::FETCH_ASSOC);
            // 提名数量上限后端强制（前端 stage.max_select 仅为引导，防绕过）
            $maxNoms = max(1, (int)($openStages[0]['max_select'] ?? 1));
            $cntStmt = $db->prepare("SELECT COUNT(DISTINCT entry_id) FROM vote_nominations WHERE project_id = ? AND user_id = ? AND status = 'active'");
            $cntStmt->execute([(int)$project['id'], (int)$user['id']]);
            $alreadyActiveThisEntry = $existingNomRow && $existingNomRow['status'] === 'active';
            if (!$alreadyActiveThisEntry && (int)$cntStmt->fetchColumn() >= $maxNoms) {
                $db->rollBack();
                voteRespond(['success' => false, 'message' => '已达到最大提名数（' . $maxNoms . ' 个）'], 400);
            }
            if ($existingNomRow) {
                if ($existingNomRow['status'] === 'withdrawn') {
                    $now = voteNowExpr();
                    $db->prepare("UPDATE vote_nominations SET status = 'active', created_at = $now WHERE id = ?")->execute([$existingNomRow['id']]);
                }
                // Already active: silently idempotent
            } else {
                $nom = $db->prepare("INSERT INTO vote_nominations (project_id, stage_id, entry_id, user_id, status) VALUES (?, ?, ?, ?, 'active')");
                $nom->execute([(int)$project['id'], $stageId, $entryId, (int)$user['id']]);
            }
            $db->commit();
        } catch (Throwable $e) {
            $db->rollBack();
            // Concurrent duplicate key → nomination already exists, treat as success
            if ($e instanceof PDOException && (int)$e->getCode() === 23000) {
                $eid = $entryId ?? 0;
                logAction('vote_nomination.submit', 'vote_entries', $eid, ['project_id' => (int)$project['id'], 'duplicate' => true]);
                voteRespond(['success' => true, 'entry_id' => $eid]);
            }
            throw $e;
        }
        logAction('vote_nomination.submit', 'vote_entries', $entryId, ['project_id' => (int)$project['id']]);
        voteRespond(['success' => true, 'entry_id' => $entryId]);

    case 'my':
    case 'my_nominations':
        $user = requireLogin();
        $projectId = (int)($_GET['project_id'] ?? $_GET['contest_id'] ?? 0);
        $stmt = $db->prepare(
            "SELECT n.*, e.title, e.title_cn, e.subtitle, e.image_url, e.entry_status
             FROM vote_nominations n JOIN vote_entries e ON e.id = n.entry_id
             WHERE n.user_id = ? AND (? = 0 OR n.project_id = ?) AND n.status = 'active'
             ORDER BY n.created_at DESC"
        );
        $stmt->execute([(int)$user['id'], $projectId, $projectId]);
        $myRows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($myRows as &$mr) {
            if (!empty($mr['image_url'])) $mr['image_url'] = proxyImageUrl($mr['image_url']);
        }
        voteRespond(['success' => true, 'data' => $myRows]);

    case 'nomination_summary':
        $projectId = (int)($_GET['project_id'] ?? $_GET['contest_id'] ?? 0);
        $project = voteGetProject($projectId);
        if (!$project) voteRespond(['success' => false, 'message' => '企划不存在'], 404);
        // 提名统计含 pending/rejected 内部状态，仅企划可读者可见
        if (!voteCanReadProject(getCurrentUser(), $project)) voteRespond(['success' => false, 'message' => '无权查看该企划'], 403);
        $stmt = $db->prepare(
            "SELECT entry_status, COUNT(*) AS count
             FROM vote_entries
             WHERE project_id = ?
             GROUP BY entry_status"
        );
        $stmt->execute([$projectId]);
        $summary = ['pending' => 0, 'approved' => 0, 'rejected' => 0];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $summary[$row['entry_status']] = (int)$row['count'];
        }
        voteRespond(['success' => true, 'data' => $summary]);

    case 'withdraw':
    case 'withdraw_nomination':
        $user = requireLogin();
        $entryId = (int)($_GET['entry_id'] ?? voteReadJson()['entry_id'] ?? 0);
        // 事务化：防“COUNT 与 UPDATE 之间并发新增提名”导致误移除条目
        $db->beginTransaction();
        try {
            $stmt = $db->prepare("UPDATE vote_nominations SET status = 'withdrawn' WHERE entry_id = ? AND user_id = ?");
            $stmt->execute([$entryId, (int)$user['id']]);
            $stmt2 = $db->prepare("SELECT COUNT(*) FROM vote_nominations WHERE entry_id = ? AND status = 'active'");
            $stmt2->execute([$entryId]);
            if ((int)$stmt2->fetchColumn() === 0) {
                $db->prepare("UPDATE vote_entries SET entry_status = 'removed' WHERE id = ? AND entry_status IN ('pending', 'approved')")
                    ->execute([$entryId]);
                // 已被播种进阶段池/已有票的条目同步下线，避免撤销后仍可被投
                $db->prepare("UPDATE vote_stage_entries SET status = 'removed' WHERE entry_id = ? AND status = 'active'")
                    ->execute([$entryId]);
            }
            $db->commit();
        } catch (Throwable $e) {
            if ($db->inTransaction()) $db->rollBack();
            throw $e;
        }
        voteRespond(['success' => true]);

    case 'approve':
    case 'reject':
        $input = voteReadJson();
        $entryId = (int)($_GET['entry_id'] ?? $_GET['id'] ?? $input['entry_id'] ?? $input['id'] ?? 0);
        $stmt = $db->prepare('SELECT e.*, p.club_id, p.country FROM vote_entries e JOIN vote_projects p ON p.id = e.project_id WHERE e.id = ?');
        $stmt->execute([$entryId]);
        $entry = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$entry) voteRespond(['success' => false, 'message' => '提名不存在'], 404);
        [$user, $project] = voteRequireProjectManager((int)$entry['project_id']);
        $status = $action === 'approve' ? 'approved' : 'rejected';
        $now = voteNowExpr();
        $db->prepare("UPDATE vote_entries SET entry_status = ?, reviewed_by = ?, reviewed_at = $now, updated_at = $now WHERE id = ?")
            ->execute([$status, (int)$user['id'], $entryId]);
        if ($status === 'rejected') {
            $db->prepare("UPDATE vote_stage_entries SET status = 'removed' WHERE entry_id = ?")->execute([$entryId]);
        }
        logAction('vote_entry.' . $action, 'vote_entries', $entryId, ['project_id' => (int)$entry['project_id']]);
        voteRespond(['success' => true, 'status' => $status]);

    case 'create':
    case 'import':
        $_GET['action'] = 'submit';
        voteRespond(['success' => false, 'message' => '请使用 action=submit 提交提名'], 400);

    case 'remove':
    case 'restore':
        $input = voteReadJson();
        $entryId = (int)($_GET['entry_id'] ?? $_GET['id'] ?? $input['entry_id'] ?? $input['id'] ?? 0);
        $stmt = $db->prepare('SELECT project_id FROM vote_entries WHERE id = ?');
        $stmt->execute([$entryId]);
        $projectId = (int)$stmt->fetchColumn();
        if (!$projectId) voteRespond(['success' => false, 'message' => '条目不存在'], 404);
        [$user, $project] = voteRequireProjectManager($projectId);
        $now = voteNowExpr();
        $status = $action === 'restore' ? 'approved' : 'removed';
        $db->beginTransaction();
        $db->prepare("UPDATE vote_entries SET entry_status = ?, updated_at = $now WHERE id = ?")->execute([$status, $entryId]);
        if ($action === 'remove') {
            $db->prepare("UPDATE vote_nominations SET status = 'withdrawn' WHERE entry_id = ?")->execute([$entryId]);
            $db->prepare("UPDATE vote_stage_entries SET status = 'removed' WHERE entry_id = ?")->execute([$entryId]);
        } else {
            $db->prepare("UPDATE vote_nominations SET status = 'active' WHERE entry_id = ?")->execute([$entryId]);
        }
        $db->commit();
        voteRespond(['success' => true, 'status' => $status]);

    default:
        voteRespond(['success' => false, 'message' => '未知 action=' . $action], 400);
}
