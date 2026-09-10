<?php
// api/vote_votes.php - shared voting and results API.

require_once __DIR__ . '/../includes/vote_projects.php';
require_once __DIR__ . '/../includes/audit.php';
require_once __DIR__ . '/../includes/image_proxy_helper.php';
require_once __DIR__ . '/../includes/rate_limit.php';

voteBootstrap();
voteEnsureSchema();
$action = trim((string)($_GET['action'] ?? ''));
$db = getDB();

// 投票提交按 IP 限频（正常用户远低于此阈值，用于抬高脚本化刷票成本）
if ($action === 'cast') {
    checkRateLimit('vote_cast', 30, 1);
}

function voteResultsMatchRows(PDO $db, int $stageId, ?int $poolId = null): array {
    $table = $poolId ? 'vote_flow_matches' : 'vote_matches';
    $where = $poolId ? 'm.pool_id = ?' : 'm.stage_id = ?';
    $params = [$poolId ?: $stageId];
    $stmt = $db->prepare(
        "SELECT m.*,
                a.title AS slot_a_title, a.title_cn AS slot_a_title_cn, a.image_url AS slot_a_image,
                b.title AS slot_b_title, b.title_cn AS slot_b_title_cn, b.image_url AS slot_b_image,
                w.title AS winner_title, w.title_cn AS winner_title_cn,
                COALESCE(SUM(CASE WHEN v.entry_id = m.slot_a_entry_id THEN v.vote_value ELSE 0 END), 0) AS slot_a_votes,
                COALESCE(SUM(CASE WHEN v.entry_id = m.slot_b_entry_id THEN v.vote_value ELSE 0 END), 0) AS slot_b_votes,
                COALESCE(SUM(v.vote_value), 0) AS total_votes
         FROM $table m
         LEFT JOIN vote_entries a ON a.id = m.slot_a_entry_id
         LEFT JOIN vote_entries b ON b.id = m.slot_b_entry_id
         LEFT JOIN vote_entries w ON w.id = m.winner_entry_id
         LEFT JOIN vote_votes v ON v.match_id = m.id AND v.stage_id = m.stage_id
         WHERE $where
         GROUP BY m.id
         ORDER BY m.round_no ASC, m.match_no ASC"
    );
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$row) {
        $row['slot_a_image'] = proxyImageUrl($row['slot_a_image'] ?? '');
        $row['slot_b_image'] = proxyImageUrl($row['slot_b_image'] ?? '');
        $row['slot_a_votes'] = (int)($row['slot_a_votes'] ?? 0);
        $row['slot_b_votes'] = (int)($row['slot_b_votes'] ?? 0);
        $row['total_votes'] = (int)($row['total_votes'] ?? 0);
    }
    return $rows;
}

function voteTrimMoeResultRows(array &$rows, array $visibility): void {
    foreach ($rows as &$row) {
        if (empty($visibility['rank_visible'])) {
            unset($row['rank_no'], $row['group_rank'], $row['advanced'], $row['role'], $row['snapshot_json']);
        }
        if (empty($visibility['metrics_visible'])) {
            unset($row['votes'], $row['score_total'], $row['rating_count'], $row['score_avg']);
        }
    }
    unset($row);
}

function voteTrimMoeMatchRows(array &$rows, array $visibility): void {
    foreach ($rows as &$row) {
        if (empty($visibility['rank_visible'])) {
            unset($row['winner_entry_id'], $row['winner_title'], $row['winner_title_cn']);
        }
        if (empty($visibility['metrics_visible'])) {
            unset($row['slot_a_votes'], $row['slot_b_votes'], $row['total_votes']);
        }
    }
    unset($row);
}

function voteStageDeadlinePassed(?string $endsAt): bool {
    $endsAt = trim((string)$endsAt);
    if ($endsAt === '') return false;
    $deadline = strtotime($endsAt);
    return $deadline !== false && $deadline <= time();
}

switch ($action) {
    case 'eligibility':
        $user = getCurrentUser();
        $project = voteGetProject((int)($_GET['project_id'] ?? $_GET['contest_id'] ?? 0));
        if (!$project) voteRespond(['success' => true, 'eligible' => false, 'reason' => 'project_not_found']);
        $shareParam = trim((string)($_GET['share'] ?? ''));
        $guestEligible = (int)($project['guest_vote'] ?? 0) === 1
            && voteShareTokenMatches($project, $shareParam)
            && ($project['status'] ?? '') === 'running';
        voteRespond([
            'success' => true,
            'eligible' => ($user && voteCanParticipateProject($user, $project)) || $guestEligible,
            'guest_eligible' => $guestEligible,
            'reason' => $user ? '' : ($guestEligible ? 'guest_share' : 'login_required'),
        ]);

    case 'cast':
        $user = getCurrentUser();
        $input = voteReadJson();
        $stage = voteFetchStage((int)($input['stage_id'] ?? 0));
        if (!$stage) voteRespond(['success' => false, 'message' => '阶段不存在'], 404);
        $project = voteGetProject((int)$stage['project_id']);
        if (!$project) voteRespond(['success' => false, 'message' => '企划不存在'], 404);
        // 免登录投票：企划开启 guest_vote + 携带匹配的分享令牌 + 活动进行中。
        $guestKey = '';
        if (!$user) {
            $shareToken = trim((string)($input['share'] ?? $_GET['share'] ?? ''));
            if ((int)($project['guest_vote'] ?? 0) !== 1 || !voteShareTokenMatches($project, $shareToken)) {
                voteRespond(['success' => false, 'message' => '该企划未开放免登录投票，请先登录', 'logged_in' => false], 401);
            }
            if (($project['status'] ?? '') !== 'running') {
                voteRespond(['success' => false, 'message' => '活动不在进行中，无法投票'], 400);
            }
            $guestKey = voteGuestKey();
        } else {
            if (!voteCanParticipateProject($user, $project)) voteRespond(['success' => false, 'message' => '当前账号不符合投票资格'], 403);
        }
        $voterId = $user ? (int)$user['id'] : 0;
        $guestVote = $guestKey !== '';
        // 访客票 user_id 为 NULL（MySQL 外键允许 NULL），以 guest_key 做同设备去重。
        $voterWhere = $guestVote ? 'user_id IS NULL AND guest_key = ?' : "user_id = ? AND guest_key = ''";
        $voterParams = $guestVote ? [$guestKey] : [$voterId];

        $flowPool = voteFlowPoolForStage($db, (int)$stage['id']);
        if ($flowPool) {
            $runtime = voteFlowPoolRuntime($flowPool, $stage);
            if (($flowPool['status'] ?? '') !== 'open') voteRespond(['success' => false, 'message' => '当前阶段池未开放投票'], 400);
            if (voteStageDeadlinePassed($runtime['ends_at'] ?? ($stage['ends_at'] ?? null))) {
                voteRespond(['success' => false, 'message' => '当前阶段已到截止时间，不能继续投票'], 400);
            }
            $entryIds = $input['entry_ids'] ?? (isset($input['entry_id']) ? [$input['entry_id']] : []);
            if (!is_array($entryIds)) $entryIds = [];
            $entryIds = array_values(array_unique(array_map('intval', $entryIds)));
            if (count($entryIds) > 200) voteRespond(['success' => false, 'message' => '投票数量不符合当前阶段设置'], 400);
            $maxSelect = max(1, (int)$runtime['max_select']);
            if (($flowPool['vote_mode'] ?? '') === 'match_single') $maxSelect = 1;
            $groupMaxSelect = $maxSelect;
            $perGroupLimit = $runtime['rule_version'] >= 2
                && $runtime['group_ticket_scope'] === 'per_group'
                && ($flowPool['vote_mode'] ?? '') !== 'match_single';
            if ($perGroupLimit) $maxSelect = count($entryIds);
            if (!$entryIds || count($entryIds) > $maxSelect) voteRespond(['success' => false, 'message' => '投票数量不符合当前阶段设置'], 400);

            $maxSelect = $groupMaxSelect;
            $placeholders = implode(',', array_fill(0, count($entryIds), '?'));
            $stmt = $db->prepare(
                "SELECT fpe.entry_id, fpe.group_key
                 FROM vote_flow_pool_entries fpe
                 JOIN vote_entries e ON e.id = fpe.entry_id
                 WHERE fpe.pool_id = ? AND fpe.status = 'active'
                   AND e.entry_status = 'approved' AND fpe.entry_id IN ($placeholders)"
            );
            $stmt->execute(array_merge([(int)$flowPool['id']], $entryIds));
            $selectedRows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            if (count($selectedRows) !== count($entryIds)) {
                voteRespond(['success' => false, 'message' => '投票条目不属于当前阶段池'], 400);
            }

            if ($perGroupLimit) {
                $groupCounts = [];
                foreach ($selectedRows as $selectedRow) {
                    $groupKey = trim((string)($selectedRow['group_key'] ?? '')) ?: 'all';
                    $groupCounts[$groupKey] = ($groupCounts[$groupKey] ?? 0) + 1;
                    if ($groupCounts[$groupKey] > $maxSelect) {
                        voteRespond(['success' => false, 'message' => "每组最多选择 {$maxSelect} 项"], 400);
                    }
                }
            }

            $matchId = (int)($input['match_id'] ?? 0);
            if (($flowPool['vote_mode'] ?? '') === 'match_single') {
                if ($matchId <= 0) voteRespond(['success' => false, 'message' => '1v1 投票必须指定对阵'], 400);
                $stmt = $db->prepare('SELECT * FROM vote_flow_matches WHERE id = ? AND project_id = ? AND pool_id = ?');
                $stmt->execute([$matchId, (int)$project['id'], (int)$flowPool['id']]);
                $match = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$match || ($match['status'] ?? '') !== 'open') voteRespond(['success' => false, 'message' => '对阵不存在或不可投票'], 400);
                $slots = array_filter([(int)($match['slot_a_entry_id'] ?? 0), (int)($match['slot_b_entry_id'] ?? 0)]);
                if (count($entryIds) !== 1 || !in_array($entryIds[0], $slots, true)) voteRespond(['success' => false, 'message' => '投票条目不属于当前对阵'], 400);
            } else {
                // 非 1v1 模式忽略 match_id，防止借不同 match_id 绕过阶段级去重刷票
                $matchId = 0;
            }

            $scoreMap = is_array($input['scores'] ?? null) ? $input['scores'] : [];
            $db->beginTransaction();
            // 事务内锁池行：串行化同池去重检查（防并发快照读漏判），并复查池状态（防与结算竞态产生幽灵票）
            if (voteIsMysql()) {
                $db->prepare('SELECT status FROM vote_flow_pools WHERE id = ? FOR UPDATE')->execute([(int)$flowPool['id']]);
            } else {
                $db->prepare('UPDATE vote_flow_pools SET status = status WHERE id = ?')->execute([(int)$flowPool['id']]);
            }
            $stmt = $db->prepare('SELECT status FROM vote_flow_pools WHERE id = ?');
            $stmt->execute([(int)$flowPool['id']]);
            if ((string)$stmt->fetchColumn() !== 'open') {
                $db->rollBack();
                voteRespond(['success' => false, 'message' => '当前阶段池未开放投票'], 400);
            }
            if (!empty($runtime['allow_vote_change'])) {
                $deleteSql = "DELETE FROM vote_votes WHERE stage_id = ? AND $voterWhere";
                $deleteParams = array_merge([(int)$stage['id']], $voterParams);
                if ($matchId > 0) {
                    $deleteSql .= ' AND match_id = ?';
                    $deleteParams[] = $matchId;
                }
                $db->prepare($deleteSql)->execute($deleteParams);
            } else {
                $existsSql = "SELECT COUNT(*) FROM vote_votes WHERE stage_id = ? AND $voterWhere";
                $existsParams = array_merge([(int)$stage['id']], $voterParams);
                if ($matchId > 0) {
                    $existsSql .= ' AND match_id = ?';
                    $existsParams[] = $matchId;
                }
                $stmt = $db->prepare($existsSql);
                $stmt->execute($existsParams);
                if ((int)$stmt->fetchColumn() > 0) {
                    $db->rollBack();
                    voteRespond(['success' => false, 'message' => '本阶段已投票'], 400);
                }
            }
            $ins = $db->prepare('INSERT INTO vote_votes (project_id, stage_id, entry_id, match_id, user_id, guest_key, vote_value, score_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
            foreach ($entryIds as $entryId) {
                $score = null;
                if (($flowPool['vote_mode'] ?? '') === 'score') {
                    $score = (int)($scoreMap[$entryId] ?? $input['score_value'] ?? 0);
                    if ($score < (int)$runtime['score_min'] || $score > (int)$runtime['score_max']) {
                        $db->rollBack();
                        voteRespond(['success' => false, 'message' => '评分超出范围'], 400);
                    }
                }
                $ins->execute([(int)$project['id'], (int)$stage['id'], $entryId, $matchId ?: null, $guestVote ? null : $voterId, $guestKey, 1, $score]);
            }
            $db->commit();
            logAction('vote.cast.flow', 'vote_stages', (int)$stage['id'], ['project_id' => (int)$project['id'], 'pool_id' => (int)$flowPool['id'], 'count' => count($entryIds), 'match_id' => $matchId ?: null, 'guest' => $guestVote]);
            voteRespond(['success' => true, 'count' => count($entryIds), 'pool_id' => (int)$flowPool['id']]);
        }

        if (($stage['status'] ?? '') !== 'open') voteRespond(['success' => false, 'message' => '当前阶段未开放投票'], 400);
        if (voteStageDeadlinePassed($stage['ends_at'] ?? null)) {
            voteRespond(['success' => false, 'message' => '当前阶段已到截止时间，不能继续投票'], 400);
        }

        $entryIds = $input['entry_ids'] ?? (isset($input['entry_id']) ? [$input['entry_id']] : []);
        if (!is_array($entryIds)) $entryIds = [];
        $entryIds = array_values(array_unique(array_map('intval', $entryIds)));
        if (count($entryIds) > 200) voteRespond(['success' => false, 'message' => '投票数量不符合当前阶段设置'], 400);
        $maxSelect = max(1, (int)($stage['max_select'] ?? 1));
        if (($stage['vote_mode'] ?? '') === 'match_single') $maxSelect = 1;
        if (!$entryIds || count($entryIds) > $maxSelect) {
            voteRespond(['success' => false, 'message' => '投票数量不符合当前阶段设置'], 400);
        }

        voteEnsureStageEntries($db, $stage);
        $placeholders = implode(',', array_fill(0, count($entryIds), '?'));
        $stmt = $db->prepare(
            "SELECT se.entry_id
             FROM vote_stage_entries se
             JOIN vote_entries e ON e.id = se.entry_id
             WHERE se.project_id = ? AND se.stage_id = ? AND se.status = 'active'
               AND e.entry_status = 'approved' AND se.entry_id IN ($placeholders)"
        );
        $stmt->execute(array_merge([(int)$project['id'], (int)$stage['id']], $entryIds));
        $allowedEntryIds = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
        if (count($allowedEntryIds) !== count($entryIds)) {
            voteRespond(['success' => false, 'message' => '投票条目不属于当前阶段候选池'], 400);
        }

        $matchId = (int)($input['match_id'] ?? 0);
        if (($stage['vote_mode'] ?? '') === 'match_single') {
            if ($matchId <= 0) voteRespond(['success' => false, 'message' => '1v1 投票必须指定对阵'], 400);
            $stmt = $db->prepare('SELECT * FROM vote_matches WHERE id = ? AND project_id = ? AND stage_id = ?');
            $stmt->execute([$matchId, (int)$project['id'], (int)$stage['id']]);
            $match = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$match || ($match['status'] ?? '') !== 'open') {
                voteRespond(['success' => false, 'message' => '对阵不存在或不可投票'], 400);
            }
            $slots = array_filter([(int)($match['slot_a_entry_id'] ?? 0), (int)($match['slot_b_entry_id'] ?? 0)]);
            if (count($entryIds) !== 1 || !in_array($entryIds[0], $slots, true)) {
                voteRespond(['success' => false, 'message' => '投票条目不属于当前对阵'], 400);
            }
        } else {
            // 非 1v1 模式忽略 match_id，防止借不同 match_id 绕过阶段级去重刷票
            $matchId = 0;
        }

        $scoreMap = is_array($input['scores'] ?? null) ? $input['scores'] : [];
        $db->beginTransaction();
        // 事务内锁阶段行：串行化去重检查（防并发快照读漏判），并复查阶段状态
        if (voteIsMysql()) {
            $db->prepare('SELECT status FROM vote_stages WHERE id = ? FOR UPDATE')->execute([(int)$stage['id']]);
        } else {
            $db->prepare('UPDATE vote_stages SET status = status WHERE id = ?')->execute([(int)$stage['id']]);
        }
        $stmt = $db->prepare('SELECT status FROM vote_stages WHERE id = ?');
        $stmt->execute([(int)$stage['id']]);
        if ((string)$stmt->fetchColumn() !== 'open') {
            $db->rollBack();
            voteRespond(['success' => false, 'message' => '当前阶段未开放投票'], 400);
        }
        if (!empty($stage['allow_vote_change'])) {
            $deleteSql = "DELETE FROM vote_votes WHERE stage_id = ? AND $voterWhere";
            $deleteParams = array_merge([(int)$stage['id']], $voterParams);
            if ($matchId > 0) {
                $deleteSql .= ' AND match_id = ?';
                $deleteParams[] = $matchId;
            }
            $db->prepare($deleteSql)->execute($deleteParams);
        } else {
            $existsSql = "SELECT COUNT(*) FROM vote_votes WHERE stage_id = ? AND $voterWhere";
            $existsParams = array_merge([(int)$stage['id']], $voterParams);
            if ($matchId > 0) {
                $existsSql .= ' AND match_id = ?';
                $existsParams[] = $matchId;
            }
            $stmt = $db->prepare($existsSql);
            $stmt->execute($existsParams);
            if ((int)$stmt->fetchColumn() > 0) {
                $db->rollBack();
                voteRespond(['success' => false, 'message' => '本阶段已投票'], 400);
            }
        }

        $ins = $db->prepare('INSERT INTO vote_votes (project_id, stage_id, entry_id, match_id, user_id, guest_key, vote_value, score_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        foreach ($entryIds as $entryId) {
            $score = null;
            if (($stage['vote_mode'] ?? '') === 'score') {
                $score = (int)($scoreMap[$entryId] ?? $input['score_value'] ?? 0);
                if ($score < (int)$stage['score_min'] || $score > (int)$stage['score_max']) {
                    $db->rollBack();
                    voteRespond(['success' => false, 'message' => '评分超出范围'], 400);
                }
            }
            $ins->execute([(int)$project['id'], (int)$stage['id'], $entryId, $matchId ?: null, $guestVote ? null : $voterId, $guestKey, 1, $score]);
        }
        $db->commit();
        logAction('vote.cast', 'vote_stages', (int)$stage['id'], ['project_id' => (int)$project['id'], 'count' => count($entryIds), 'match_id' => $matchId ?: null, 'guest' => $guestVote]);
        voteRespond(['success' => true, 'count' => count($entryIds), 'guest' => $guestVote]);

    case 'my_votes':
        $user = getCurrentUser();
        $projectId = (int)($_GET['project_id'] ?? $_GET['contest_id'] ?? 0);
        if (!$user) {
            // 访客：按设备 Cookie 返回其免登录投票记录
            $guestKey = voteGuestKey();
            $stmt = $db->prepare(
                "SELECT v.*, e.title, e.title_cn, s.title AS stage_title
                 FROM vote_votes v
                 JOIN vote_entries e ON e.id = v.entry_id
                 JOIN vote_stages s ON s.id = v.stage_id
                 WHERE v.user_id IS NULL AND v.guest_key = ? AND (? = 0 OR v.project_id = ?)
                 ORDER BY v.created_at DESC"
            );
            $stmt->execute([$guestKey, $projectId, $projectId]);
            voteRespond(['success' => true, 'data' => $stmt->fetchAll(PDO::FETCH_ASSOC), 'guest' => true]);
        }
        $stmt = $db->prepare(
            "SELECT v.*, e.title, e.title_cn, s.title AS stage_title
             FROM vote_votes v
             JOIN vote_entries e ON e.id = v.entry_id
             JOIN vote_stages s ON s.id = v.stage_id
             WHERE v.user_id = ? AND (? = 0 OR v.project_id = ?)
             ORDER BY v.created_at DESC"
        );
        $stmt->execute([(int)$user['id'], $projectId, $projectId]);
        voteRespond(['success' => true, 'data' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);

    case 'results':
    case 'stage_results':
    case 'round_results':
    case 'final_results':
    case 'match_results':
        $stageId = (int)($_GET['stage_id'] ?? $_GET['round_id'] ?? 0);
        if ($stageId <= 0 && isset($_GET['project_id'])) {
            $stmt = $db->prepare('SELECT id FROM vote_stages WHERE project_id = ? ORDER BY sort_order DESC LIMIT 1');
            $stmt->execute([(int)$_GET['project_id']]);
            $stageId = (int)$stmt->fetchColumn();
        }
        $stage = voteFetchStage($stageId);
        if (!$stage) voteRespond(['success' => false, 'message' => '阶段不存在'], 404);
        $project = voteGetProject((int)$stage['project_id']);
        $flowPool = voteFlowPoolForStage($db, $stageId);
        if ($flowPool) {
            $runtime = voteFlowPoolRuntime($flowPool, $stage);
            $stmt = $db->prepare(
                "SELECT r.*, e.title, e.title_cn, e.subtitle, e.image_url, e.source_type, e.source_id, e.summary
                 FROM vote_flow_results r JOIN vote_entries e ON e.id = r.entry_id
                 WHERE r.pool_id = ?
                 ORDER BY r.rank_no ASC, r.votes DESC"
            );
            $stmt->execute([(int)$flowPool['id']]);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            if (!$rows) {
                $aggregate = ($flowPool['vote_mode'] ?? '') === 'score'
                    ? ($runtime['rule_version'] >= 2
                        ? 'COALESCE(SUM(v.score_value), 0) AS votes, COALESCE(SUM(v.score_value), 0) AS score_total, COUNT(v.id) AS rating_count, AVG(v.score_value) AS score_avg'
                        : 'COALESCE(SUM(v.vote_value), 0) AS votes, COALESCE(SUM(v.score_value), 0) AS score_total, COUNT(v.id) AS rating_count, AVG(v.score_value) AS score_avg')
                    : 'COALESCE(SUM(v.vote_value), 0) AS votes, 0 AS score_total, COUNT(v.id) AS rating_count, NULL AS score_avg';
                $order = 'fpe.group_key ASC, fpe.seed_no ASC';
                $stmt = $db->prepare(
                    "SELECT e.id AS entry_id, e.title, e.title_cn, e.subtitle, e.image_url, e.source_type, e.source_id, e.summary, fpe.group_key, fpe.seed_no, $aggregate
                     FROM vote_flow_pool_entries fpe
                     JOIN vote_entries e ON e.id = fpe.entry_id
                     LEFT JOIN vote_votes v ON v.entry_id = e.id AND v.stage_id = ?
                     WHERE fpe.pool_id = ? AND fpe.status = 'active' AND e.entry_status = 'approved'
                     GROUP BY e.id, fpe.group_key, fpe.seed_no
                     ORDER BY $order"
                );
                $stmt->execute([$stageId, (int)$flowPool['id']]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
                $rows = voteFlowRankRowsForPoolDetailed($flowPool, $rows)['rows'];
            }
            foreach ($rows as &$row) {
                $snapshot = voteDecode($row['snapshot_json'] ?? '{}');
                if (!isset($row['group_key']) && isset($snapshot['group_key'])) $row['group_key'] = $snapshot['group_key'];
                if (isset($snapshot['group_rank'])) $row['group_rank'] = (int)$snapshot['group_rank'];
                if (isset($row['_rank_no'])) $row['rank_no'] = (int)$row['_rank_no'];
                if (isset($row['_group_rank'])) $row['group_rank'] = (int)$row['_group_rank'];
                unset($row['_rank_no'], $row['_group_rank'], $row['_group_advance_count'], $row['_advanced']);
                if (isset($snapshot['role'])) $row['role'] = $snapshot['role'];
                $row['image_url'] = proxyImageUrl($row['image_url'] ?? '');
            }
            unset($row);
            $visibility = voteResultVisibilityFlags(
                $project ?: [],
                (string)($flowPool['status'] ?? ''),
                (string)$runtime['result_visibility']
            );
            $userForRuntime = getCurrentUser();
            $canManageRuntime = $userForRuntime && $project ? voteCanManageProject($userForRuntime, $project) : false;
            $matchResults = voteResultsMatchRows($db, $stageId, (int)$flowPool['id']);
            if (empty($visibility['rank_visible'])) {
                $rows = [];
                $matchResults = [];
            } else {
                voteTrimMoeResultRows($rows, $visibility);
                voteTrimMoeMatchRows($matchResults, $visibility);
            }
            voteRespond([
                'success' => true,
                'data' => $rows,
                'match_results' => $matchResults,
                'stage_status' => $flowPool['status'] ?? '',
                'pool_id' => (int)$flowPool['id'],
                'runtime' => $canManageRuntime ? $runtime : voteStripTieBreaks($runtime),
                'result_visibility' => $runtime['result_visibility'],
                'rank_visible' => $visibility['rank_visible'],
                'metrics_visible' => $visibility['metrics_visible'],
            ]);
        }
        $stmt = $db->prepare(
            "SELECT r.*, e.title, e.title_cn, e.subtitle, e.image_url, e.source_type, e.source_id, e.summary
             FROM vote_results r JOIN vote_entries e ON e.id = r.entry_id
             WHERE r.stage_id = ?
             ORDER BY r.rank_no ASC, r.votes DESC"
        );
        $stmt->execute([$stageId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        if (!$rows) {
            voteEnsureStageEntries($db, $stage);
            $order = ($stage['vote_mode'] ?? '') === 'score'
                ? 'score_avg DESC, votes DESC, e.id ASC'
                : 'votes DESC, score_avg DESC, e.id ASC';
            $stmt = $db->prepare(
                "SELECT e.id AS entry_id, e.title, e.title_cn, e.subtitle, e.image_url, e.source_type, e.source_id, e.summary, COALESCE(SUM(v.vote_value), 0) AS votes, AVG(v.score_value) AS score_avg
                 FROM vote_stage_entries se
                 JOIN vote_entries e ON e.id = se.entry_id
                 LEFT JOIN vote_votes v ON v.entry_id = e.id AND v.stage_id = se.stage_id
                 WHERE se.stage_id = ? AND se.project_id = ? AND se.status = 'active' AND e.entry_status = 'approved'
                 GROUP BY e.id
                 ORDER BY $order"
            );
            $stmt->execute([$stageId, (int)$stage['project_id']]);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        }
        foreach ($rows as &$row) {
            $snapshot = voteDecode($row['snapshot_json'] ?? '{}');
            if (!isset($row['group_key']) && isset($snapshot['group_key'])) $row['group_key'] = $snapshot['group_key'];
            if (isset($snapshot['group_rank'])) $row['group_rank'] = (int)$snapshot['group_rank'];
            if (isset($snapshot['role'])) $row['role'] = $snapshot['role'];
            $row['image_url'] = proxyImageUrl($row['image_url'] ?? '');
        }
        unset($row);
        $visibility = voteResultVisibilityFlags(
            $project ?: [],
            (string)($stage['status'] ?? ''),
            (string)($stage['result_visibility'] ?? 'live_rank_only')
        );
        $matchResults = voteResultsMatchRows($db, $stageId, null);
        if (empty($visibility['rank_visible'])) {
            $rows = [];
            $matchResults = [];
        } else {
            voteTrimMoeResultRows($rows, $visibility);
            voteTrimMoeMatchRows($matchResults, $visibility);
        }
        voteRespond([
            'success' => true,
            'data' => $rows,
            'match_results' => $matchResults,
            'stage_status' => $stage['status'] ?? '',
            'result_visibility' => $stage['result_visibility'] ?? 'live_rank_only',
            'rank_visible' => $visibility['rank_visible'],
            'metrics_visible' => $visibility['metrics_visible'],
        ]);

    default:
        voteRespond(['success' => false, 'message' => '未知 action=' . $action], 400);
}
