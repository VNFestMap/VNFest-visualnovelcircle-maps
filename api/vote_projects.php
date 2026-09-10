<?php
// api/vote_projects.php - shared annual voting project API.

require_once __DIR__ . '/../includes/vote_projects.php';
require_once __DIR__ . '/../includes/audit.php';

voteBootstrap();
voteEnsureSchema();

$action = trim((string)($_GET['action'] ?? ''));
$typeFilter = isset($_GET['project_type']) ? voteNormalize((string)$_GET['project_type'], VOTE_PROJECT_TYPES, '') : '';
$db = getDB();

function voteProjectEligibilityInput(array $input, array $base = []): string {
    $eligibility = voteNormalize((string)($input['eligibility_mode'] ?? ($base['eligibility_mode'] ?? 'club_member')), VOTE_ELIGIBILITY_MODES, 'club_member');
    if (in_array($eligibility, ['invite_code', 'whitelist'], true)) {
        voteRespond(['success' => false, 'message' => '邀请码/白名单参与资格尚未开放，请先选择同好会成员或登录用户'], 400);
    }
    return $eligibility;
}

switch ($action) {
    case 'list':
        $country = strtolower(trim((string)($_GET['country'] ?? 'all')));
        $status = trim((string)($_GET['status'] ?? ''));
        $clubId = (int)($_GET['club_id'] ?? 0);
        $where = ["visibility = 'public'", "status <> 'draft'"];
        $params = [];
        if ($typeFilter !== '') {
            $where[] = 'project_type = ?';
            $params[] = $typeFilter;
        }
        if ($country !== '' && $country !== 'all') {
            $where[] = 'country = ?';
            $params[] = voteNormalizeCountry($country);
        }
        if ($clubId > 0) {
            $where[] = 'club_id = ?';
            $params[] = $clubId;
        }
        if ($status !== '' && in_array($status, VOTE_PROJECT_STATUSES, true)) {
            $where[] = 'status = ?';
            $params[] = $status;
        }
        $page = max(1, (int)($_GET['page'] ?? 1));
        $offset = ($page - 1) * 100;
        $stmt = $db->prepare('SELECT * FROM vote_projects WHERE ' . implode(' AND ', $where) . ' ORDER BY updated_at DESC, id DESC LIMIT 100 OFFSET ' . $offset);
        $stmt->execute($params);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $result = array_map('voteProjectRow', $rows);
        // 全量计数（不受 LIMIT 100 影响）：前端据此决定是否显示“加载更多”
        $totalStmt = $db->prepare('SELECT COUNT(*) FROM vote_projects WHERE ' . implode(' AND ', $where));
        $totalStmt->execute($params);
        $total = (int)$totalStmt->fetchColumn();

        // Enrich with current_stage (first non-settled stage)
        if (!empty($result)) {
            $ids = array_map(function ($r) { return $r['id']; }, $result);
            $idPlaceholders = implode(',', array_fill(0, count($ids), '?'));
            $stageStmt = $db->prepare(
                "SELECT project_id, stage_type, title, status, ends_at, ends_at AS end_time,
                        vote_mode, max_select, advance_count, group_count, result_visibility, config_json
                 FROM vote_stages
                 WHERE project_id IN ($idPlaceholders) AND status IN ('open', 'locked', 'pending')
                 ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'pending' THEN 1 WHEN 'locked' THEN 2 ELSE 3 END, sort_order ASC"
            );
            $stageStmt->execute(array_map('intval', $ids));
            $stageRows = $stageStmt->fetchAll(PDO::FETCH_ASSOC);
            $countStmt = $db->prepare(
                "SELECT project_id, COUNT(*) AS entry_count
                 FROM vote_entries
                 WHERE project_id IN ($idPlaceholders) AND entry_status = 'approved'
                 GROUP BY project_id"
            );
            $countStmt->execute(array_map('intval', $ids));
            $entryCounts = [];
            foreach ($countStmt->fetchAll(PDO::FETCH_ASSOC) as $countRow) {
                $entryCounts[(int)$countRow['project_id']] = (int)$countRow['entry_count'];
            }
            $stageIndex = [];
            foreach ($stageRows as $sr) {
                $pid = (int)$sr['project_id'];
                if (!isset($stageIndex[$pid])) $stageIndex[$pid] = $sr;
            }
            foreach ($result as &$r) {
                $pid = $r['id'];
                $r['entry_count'] = $entryCounts[$pid] ?? 0;
                $r['current_stage'] = $stageIndex[$pid] ?? null;
            }
        }

        voteRespond(['success' => true, 'data' => $result, 'total' => $total, 'limit' => 100]);

    case 'my_manageable':
        $user = requireLogin();
        if (($user['role'] ?? '') === 'super_admin') {
            $where = [];
            $params = [];
            if ($typeFilter !== '') {
                $where[] = 'project_type = ?';
                $params[] = $typeFilter;
            }
            $sql = 'SELECT * FROM vote_projects';
            if ($where) $sql .= ' WHERE ' . implode(' AND ', $where);
            $sql .= ' ORDER BY updated_at DESC, id DESC LIMIT 200';
            $stmt = $db->prepare($sql);
            $stmt->execute($params);
            voteRespond(['success' => true, 'data' => array_map('voteProjectRow', $stmt->fetchAll(PDO::FETCH_ASSOC))]);
        }
        $params = [(int)$user['id']];
        $typeSql = '';
        if ($typeFilter !== '') {
            $typeSql = ' AND p.project_type = ?';
            $params[] = $typeFilter;
        }
        $stmt = $db->prepare(
            "SELECT DISTINCT p.*
             FROM vote_projects p
             JOIN club_memberships m ON m.club_id = p.club_id AND m.country = p.country
             WHERE m.user_id = ? AND m.status = 'active' AND m.role IN ('representative', 'manager') $typeSql
             ORDER BY p.updated_at DESC, p.id DESC"
        );
        $stmt->execute($params);
        voteRespond(['success' => true, 'data' => array_map('voteProjectRow', $stmt->fetchAll(PDO::FETCH_ASSOC))]);

    case 'get':
        $project = voteGetProject((int)($_GET['id'] ?? $_GET['project_id'] ?? 0));
        if (!$project) voteRespond(['success' => false, 'message' => '企划不存在'], 404);
        if ($typeFilter !== '' && $project['project_type'] !== $typeFilter) voteRespond(['success' => false, 'message' => '企划不存在'], 404);
        $user = getCurrentUser();
        if (!voteCanReadProject($user, $project)) voteRespond(['success' => false, 'message' => '无权查看该企划'], 403);
        if (($project['status'] ?? '') === 'draft' && (!$user || !voteCanManageProject($user, $project))) {
            voteRespond(['success' => false, 'message' => '企划不存在'], 404);
        }
        $stmt = $db->prepare('SELECT * FROM vote_stages WHERE project_id = ? ORDER BY sort_order ASC, id ASC');
        $stmt->execute([(int)$project['id']]);
        $canManage = $user ? voteCanManageProject($user, $project) : false;
        $shareParam = trim((string)($_GET['share'] ?? ''));
        // 阶段输出白名单：config_json 仅管理者可见（内含 tie_break 裁定候选等内部信息）
        $stageRows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        if (!$canManage) {
            $stageRows = array_map(function ($row) {
                unset($row['config_json']);
                return $row;
            }, $stageRows);
        }
        voteRespond([
            'success' => true,
            'data' => voteProjectRow($project),
            'stages' => $stageRows,
            'can_manage' => $canManage,
            'can_participate' => voteCanParticipateProject($user, $project),
            'authenticated' => (bool)$user,
            'guest_vote_enabled' => (int)($project['guest_vote'] ?? 0) === 1,
            'share_valid' => voteShareTokenMatches($project, $shareParam),
            'share_token' => $canManage ? (string)($project['share_token'] ?? '') : null,
        ]);

    case 'create':
        $user = requireLogin();
        $input = voteReadJson();
        $projectType = voteNormalize((string)($input['project_type'] ?? $typeFilter), VOTE_PROJECT_TYPES, 'twelve');
        $clubId = (int)($input['club_id'] ?? 0);
        $country = voteNormalizeCountry($input['country'] ?? 'china');
        $title = trim((string)($input['title'] ?? ''));
        if ($clubId <= 0 || $title === '') voteRespond(['success' => false, 'message' => '请填写同好会和企划标题'], 400);
        if (!canManageClubInCountry($user, $clubId, $country)) voteRespond(['success' => false, 'message' => '只有负责人/管理员可创建本会企划'], 403);
        $visibility = voteNormalize((string)($input['visibility'] ?? 'public'), VOTE_VISIBILITIES, 'public');
        $eligibility = voteProjectEligibilityInput($input);
        $resultVisibility = voteNormalize((string)($input['result_visibility'] ?? 'live_rank_only'), VOTE_RESULT_VISIBILITIES, 'live_rank_only');
        $stmt = $db->prepare(
            "INSERT INTO vote_projects
             (project_type, club_id, country, title, year_label, description, cover_url, status, visibility, eligibility_mode, result_visibility, config_json, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)"
        );
        $stmt->execute([
            $projectType,
            $clubId,
            $country,
            $title,
            trim((string)($input['year_label'] ?? date('Y'))),
            trim((string)($input['description'] ?? '')),
            trim((string)($input['cover_url'] ?? '')),
            $visibility,
            $eligibility,
            $resultVisibility,
            voteJson($input['config'] ?? []),
            (int)$user['id'],
        ]);
        $id = (int)$db->lastInsertId();
        voteDefaultStages($db, $id, $projectType, $resultVisibility);
        logAction('vote_project.create', 'vote_projects', $id, ['project_type' => $projectType, 'club_id' => $clubId, 'country' => $country]);
        voteRespond(['success' => true, 'id' => $id, 'project_type' => $projectType]);

    case 'update':
        [$user, $project] = voteRequireProjectManager((int)($_GET['id'] ?? 0));
        $input = voteReadJson();
        $now = voteNowExpr();
        $guestVote = array_key_exists('guest_vote', $input)
            ? (int)(!empty($input['guest_vote']) ? 1 : 0)
            : (int)($project['guest_vote'] ?? 0);
        $stmt = $db->prepare(
            "UPDATE vote_projects
             SET title = ?, year_label = ?, description = ?, cover_url = ?, visibility = ?, eligibility_mode = ?, result_visibility = ?, guest_vote = ?, config_json = ?, updated_at = $now
             WHERE id = ?"
        );
        $stmt->execute([
            trim((string)($input['title'] ?? $project['title'])),
            trim((string)($input['year_label'] ?? ($project['year_label'] ?? ''))),
            trim((string)($input['description'] ?? ($project['description'] ?? ''))),
            trim((string)($input['cover_url'] ?? ($project['cover_url'] ?? ''))),
            voteNormalize((string)($input['visibility'] ?? ($project['visibility'] ?? 'public')), VOTE_VISIBILITIES, 'public'),
            voteProjectEligibilityInput($input, $project),
            voteNormalize((string)($input['result_visibility'] ?? ($project['result_visibility'] ?? 'live_rank_only')), VOTE_RESULT_VISIBILITIES, 'live_rank_only'),
            $guestVote,
            voteJson($input['config'] ?? voteDecode($project['config_json'] ?? '{}')),
            (int)$project['id'],
        ]);
        logAction('vote_project.update', 'vote_projects', (int)$project['id'], ['guest_vote' => $guestVote]);
        voteRespond(['success' => true]);

    case 'share':
        // 负责人获取（首次自动生成）企划分享令牌。
        [$user, $project] = voteRequireProjectManager((int)($_GET['id'] ?? 0));
        $token = trim((string)($project['share_token'] ?? ''));
        if ($token === '') {
            $token = bin2hex(random_bytes(16));
            $stmt = $db->prepare('UPDATE vote_projects SET share_token = ?, updated_at = ' . voteNowExpr() . ' WHERE id = ?');
            $stmt->execute([$token, (int)$project['id']]);
            logAction('vote_project.share_token_issue', 'vote_projects', (int)$project['id'], null);
        }
        voteRespond([
            'success' => true,
            'share_token' => $token,
            'guest_vote' => (int)($project['guest_vote'] ?? 0),
            'status' => (string)($project['status'] ?? ''),
        ]);

    case 'publish':
    case 'suspend':
    case 'archive':
    case 'delete':
        [$user, $project] = voteRequireProjectManager((int)($_GET['id'] ?? 0));
        if ($action === 'delete') {
            $projectId = (int)$project['id'];
            $db->beginTransaction();
            try {
                // flow 机制六表无外键约束，必须随企划一并清理，避免孤儿行
                $db->prepare('DELETE FROM vote_flow_events WHERE project_id = ?')->execute([$projectId]);
                $db->prepare('DELETE FROM vote_flow_results WHERE project_id = ?')->execute([$projectId]);
                $db->prepare('DELETE FROM vote_flow_pool_entries WHERE project_id = ?')->execute([$projectId]);
                $db->prepare('DELETE FROM vote_flow_matches WHERE project_id = ?')->execute([$projectId]);
                $db->prepare('DELETE FROM vote_flow_pools WHERE project_id = ?')->execute([$projectId]);
                $db->prepare('DELETE FROM vote_flow_runs WHERE project_id = ?')->execute([$projectId]);
                $db->prepare('DELETE FROM vote_results WHERE project_id = ?')->execute([$projectId]);
                $db->prepare('DELETE FROM vote_votes WHERE project_id = ?')->execute([$projectId]);
                $db->prepare('DELETE FROM vote_matches WHERE project_id = ?')->execute([$projectId]);
                $db->prepare('DELETE FROM vote_stage_entries WHERE project_id = ?')->execute([$projectId]);
                $db->prepare('DELETE FROM vote_nominations WHERE project_id = ?')->execute([$projectId]);
                $db->prepare('DELETE FROM vote_entries WHERE project_id = ?')->execute([$projectId]);
                $db->prepare('DELETE FROM vote_stages WHERE project_id = ?')->execute([$projectId]);
                $db->prepare('DELETE FROM vote_projects WHERE id = ?')->execute([$projectId]);
                $db->commit();
            } catch (Throwable $e) {
                if ($db->inTransaction()) $db->rollBack();
                throw $e;
            }
            logAction('vote_project.delete', 'vote_projects', $projectId, ['title' => $project['title'] ?? '']);
            voteRespond(['success' => true, 'deleted_id' => $projectId]);
        }
        $target = $action === 'publish' ? 'running' : ($action === 'suspend' ? 'suspended' : 'archived');
        if ($action === 'publish') {
            // 发布前置校验：至少配置一个阶段，避免用户端出现空活动
            $stageCountStmt = $db->prepare('SELECT COUNT(*) FROM vote_stages WHERE project_id = ?');
            $stageCountStmt->execute([(int)$project['id']]);
            if ((int)$stageCountStmt->fetchColumn() === 0) {
                voteRespond(['success' => false, 'message' => '请先配置赛程阶段再发布'], 400);
            }
        }
        $now = voteNowExpr();
        $publishedSql = $action === 'publish' ? ", published_at = COALESCE(published_at, $now)" : '';
        $db->prepare("UPDATE vote_projects SET status = ?, updated_at = $now $publishedSql WHERE id = ?")->execute([$target, (int)$project['id']]);
        logAction('vote_project.' . $action, 'vote_projects', (int)$project['id'], null);
        voteRespond(['success' => true, 'status' => $target]);

    default:
        voteRespond(['success' => false, 'message' => '未知 action=' . $action], 400);
}
