<?php
// api/vote_stages.php - shared voting stage API.

require_once __DIR__ . '/../includes/vote_projects.php';
require_once __DIR__ . '/../includes/audit.php';
require_once __DIR__ . '/../includes/image_proxy_helper.php';

voteBootstrap();
voteEnsureSchema();
$action = trim((string)($_GET['action'] ?? ''));
$db = getDB();

function voteStagePayload(array $input, array $base = []): array {
    $mode = voteNormalize((string)($input['vote_mode'] ?? ($base['vote_mode'] ?? 'multi_select')), VOTE_MODES, 'multi_select');
    $baseConfig = voteDecode($base['config_json'] ?? '{}');
    $inputConfig = is_array($input['config'] ?? null) ? $input['config'] : [];
    $config = array_merge($baseConfig, $inputConfig);
    foreach (['allow_zero_fill', 'allow_vote_change'] as $flag) {
        if (array_key_exists($flag, $input)) {
            $config[$flag] = !empty($input[$flag]);
        }
    }
    foreach (['tie_rule', 'result_visibility'] as $key) {
        if (isset($input[$key])) {
            $config[$key] = trim((string)$input[$key]);
        }
    }
    foreach (['bracket_size', 'source_stage_id'] as $key) {
        if (isset($input[$key])) {
            $config[$key] = max(0, (int)$input[$key]);
        }
    }
    if (!isset($config['tie_rule'])) $config['tie_rule'] = 'manual';
    if (!array_key_exists('allow_zero_fill', $config)) $config['allow_zero_fill'] = false;
    if (isset($config['bracket_size']) && $config['bracket_size'] > 0 && !voteIsPowerOfTwo((int)$config['bracket_size'])) {
        voteRespond(['success' => false, 'message' => '萌战对阵人数必须是 2 的幂'], 400);
    }
    $scoreMin = max(0, (int)($input['score_min'] ?? ($base['score_min'] ?? 1)));
    $scoreMax = max(1, (int)($input['score_max'] ?? ($base['score_max'] ?? 10)));
    if ($scoreMin > $scoreMax) {
        voteRespond(['success' => false, 'message' => '评分下限不能高于评分上限'], 400);
    }
    return [
        'stage_type' => voteNormalize((string)($input['stage_type'] ?? ($base['stage_type'] ?? 'group_vote')), VOTE_STAGE_TYPES, 'group_vote'),
        'title' => trim((string)($input['title'] ?? ($base['title'] ?? '未命名阶段'))),
        'starts_at' => $input['starts_at'] ?? ($base['starts_at'] ?? null),
        'ends_at' => $input['ends_at'] ?? ($base['ends_at'] ?? null),
        'vote_mode' => $mode,
        'max_select' => max(1, (int)($input['max_select'] ?? ($base['max_select'] ?? 1))),
        'advance_count' => max(0, (int)($input['advance_count'] ?? ($base['advance_count'] ?? 0))),
        'group_count' => max(1, (int)($input['group_count'] ?? ($base['group_count'] ?? 1))),
        'score_min' => $scoreMin,
        'score_max' => $scoreMax,
        'allow_vote_change' => array_key_exists('allow_vote_change', $input) ? (!empty($input['allow_vote_change']) ? 1 : 0) : (int)($base['allow_vote_change'] ?? 0),
        'result_visibility' => voteNormalize((string)($input['result_visibility'] ?? ($base['result_visibility'] ?? 'live_rank_only')), VOTE_RESULT_VISIBILITIES, 'live_rank_only'),
        'config_json' => voteJson($config),
    ];
}

function voteStageCoreChanged(array $stage, array $payload): bool {
    foreach (['stage_type', 'starts_at', 'vote_mode', 'max_select', 'advance_count', 'group_count', 'score_min', 'score_max', 'allow_vote_change'] as $key) {
        if ((string)($stage[$key] ?? '') !== (string)($payload[$key] ?? '')) return true;
    }
    $oldConfig = voteDecode($stage['config_json'] ?? '{}');
    $newConfig = voteDecode($payload['config_json'] ?? '{}');
    foreach (['allow_zero_fill', 'bracket_size', 'source_stage_id', 'tie_rule'] as $key) {
        if (($oldConfig[$key] ?? null) !== ($newConfig[$key] ?? null)) return true;
    }
    return false;
}

switch ($action) {
    case 'list':
        $project = voteGetProject((int)($_GET['project_id'] ?? $_GET['contest_id'] ?? 0));
        if (!$project) voteRespond(['success' => false, 'message' => '企划不存在'], 404);
        $user = getCurrentUser();
        if (!voteCanReadProject($user, $project)) voteRespond(['success' => false, 'message' => '无权查看该企划'], 403);
        $canManage = $user ? voteCanManageProject($user, $project) : false;
        $stmt = $db->prepare('SELECT * FROM vote_stages WHERE project_id = ? ORDER BY sort_order ASC, id ASC');
        $stmt->execute([(int)$project['id']]);
        $stageRows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        if (!$canManage) {
            // 非管理者剥离结算裁定候选等内部信息，保留 bracket_size 等展示配置
            $stageRows = array_map(function ($row) {
                $config = voteDecode($row['config_json'] ?? '{}');
                unset($config['tie_break'], $config['tie_breaks']);
                $row['config_json'] = voteJson($config);
                return $row;
            }, $stageRows);
        }
        voteRespond(['success' => true, 'data' => $stageRows, 'can_manage' => $canManage]);

    case 'create':
        $input = voteReadJson();
        [$user, $project] = voteRequireProjectManager((int)($input['project_id'] ?? $input['contest_id'] ?? 0));
        $payload = voteStagePayload($input);
        if ($payload['title'] === '') voteRespond(['success' => false, 'message' => '请填写阶段标题'], 400);
        $orderStmt = $db->prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 FROM vote_stages WHERE project_id = ?');
        $orderStmt->execute([(int)$project['id']]);
        $sortOrder = (int)$orderStmt->fetchColumn();
        $stmt = $db->prepare(
            "INSERT INTO vote_stages
             (project_id, stage_type, title, sort_order, status, starts_at, ends_at, vote_mode, max_select, advance_count, group_count, score_min, score_max, allow_vote_change, result_visibility, config_json)
             VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        );
        $stmt->execute([(int)$project['id'], $payload['stage_type'], $payload['title'], $sortOrder, $payload['starts_at'], $payload['ends_at'], $payload['vote_mode'], $payload['max_select'], $payload['advance_count'], $payload['group_count'], $payload['score_min'], $payload['score_max'], $payload['allow_vote_change'], $payload['result_visibility'], $payload['config_json']]);
        $id = (int)$db->lastInsertId();
        logAction('vote_stage.create', 'vote_stages', $id, ['project_id' => (int)$project['id']]);
        voteRespond(['success' => true, 'id' => $id]);

    case 'update':
    case 'update_and_rebuild':
        $input = voteReadJson();
        $stage = voteFetchStage((int)($_GET['id'] ?? $input['id'] ?? 0));
        if (!$stage) voteRespond(['success' => false, 'message' => '阶段不存在'], 404);
        [$user, $project] = voteRequireProjectManager((int)$stage['project_id']);
        $payload = voteStagePayload($input, $stage);
        $flowPool = voteFlowPoolForStage($db, (int)$stage['id']);
        $coreChanged = voteStageCoreChanged($stage, $payload);
        if ($flowPool && $coreChanged && $action !== 'update_and_rebuild') {
            voteRespond([
                'success' => false,
                'code' => 'POOL_REBUILD_REQUIRED',
                'message' => '阶段池生成后核心配置已锁定，请使用更新并重建',
                'usage' => voteFlowPoolUsageCounts($db, $flowPool),
            ], 409);
        }
        if ($flowPool && $action === 'update_and_rebuild') {
            $usage = voteFlowPoolUsageCounts($db, $flowPool);
            if (!voteFlowPoolCanRebuild($db, $flowPool)) {
                voteRespond([
                    'success' => false,
                    'code' => 'POOL_HAS_ACTIVITY',
                    'message' => '该阶段已有投票、对阵或结果，不能重建',
                    'usage' => $usage,
                ], 409);
            }
            $entryRows = voteFlowPoolEntries($db, (int)$flowPool['id']);
            $entryIds = array_map('intval', array_column($entryRows, 'entry_id'));
            $rankMap = [];
            $sourcePoolId = null;
            foreach ($entryRows as $entryRow) {
                if ($sourcePoolId === null && !empty($entryRow['source_pool_id'])) {
                    $sourcePoolId = (int)$entryRow['source_pool_id'];
                }
                if (isset($entryRow['source_rank'])) {
                    $rankMap[(int)$entryRow['entry_id']] = (int)$entryRow['source_rank'];
                }
            }
            $runStmt = $db->prepare('SELECT * FROM vote_flow_runs WHERE id = ?');
            $runStmt->execute([(int)$flowPool['run_id']]);
            $run = $runStmt->fetch(PDO::FETCH_ASSOC) ?: [
                'id' => (int)$flowPool['run_id'],
                'project_id' => (int)$project['id'],
            ];
            $updatedStage = array_merge($stage, $payload);
            $isMoe = ($project['project_type'] ?? '') === 'moe';
            $runtimeConfig = $isMoe ? voteMoeRuntimeConfig($run, $updatedStage) : voteStageConfig($updatedStage);
            $previewPool = array_merge($flowPool, [
                'stage_type' => $payload['stage_type'],
                'vote_mode' => $payload['vote_mode'],
                'group_count' => $payload['group_count'],
                'max_select' => $payload['max_select'],
                'advance_count' => $payload['advance_count'],
                'config_json' => voteJson($runtimeConfig),
            ]);
            try {
                voteValidateMoePoolConfig($previewPool, count($entryIds));
            } catch (Throwable $e) {
                voteRespond(['success' => false, 'code' => 'INVALID_POOL_CONFIG', 'message' => $e->getMessage()], 400);
            }
            $now = voteNowExpr();
            $db->beginTransaction();
            try {
                $stmt = $db->prepare(
                    "UPDATE vote_stages SET stage_type = ?, title = ?, starts_at = ?, ends_at = ?, vote_mode = ?, max_select = ?, advance_count = ?, group_count = ?, score_min = ?, score_max = ?, allow_vote_change = ?, result_visibility = ?, config_json = ?, updated_at = $now WHERE id = ?"
                );
                $stmt->execute([$payload['stage_type'], $payload['title'], $payload['starts_at'], $payload['ends_at'], $payload['vote_mode'], $payload['max_select'], $payload['advance_count'], $payload['group_count'], $payload['score_min'], $payload['score_max'], $payload['allow_vote_change'], $payload['result_visibility'], $payload['config_json'], (int)$stage['id']]);
                $db->prepare(
                    'UPDATE vote_flow_pools SET stage_type = ?, title = ?, vote_mode = ?, group_count = ?, max_select = ?, advance_count = ?, config_json = ? WHERE id = ?'
                )->execute([$payload['stage_type'], $payload['title'], $payload['vote_mode'], $payload['group_count'], $payload['max_select'], $payload['advance_count'], voteJson($runtimeConfig), (int)$flowPool['id']]);
                $db->prepare('DELETE FROM vote_flow_pool_entries WHERE pool_id = ?')->execute([(int)$flowPool['id']]);
                $rebuiltPool = array_merge($previewPool, ['config_json' => voteJson($runtimeConfig)]);
                $seededCount = voteFlowSeedPoolEntries($db, $rebuiltPool, $entryIds, $sourcePoolId, $rankMap);
                voteFlowLog($db, (int)$flowPool['run_id'], (int)$flowPool['id'], (int)$project['id'], 'update_and_rebuild_pool', [
                    'seeded_count' => $seededCount,
                ]);
                $db->commit();
            } catch (Throwable $e) {
                if ($db->inTransaction()) $db->rollBack();
                voteRespond(['success' => false, 'code' => 'UPDATE_AND_REBUILD_FAILED', 'message' => $e->getMessage()], 400);
            }
            logAction('vote_stage.update_and_rebuild', 'vote_stages', (int)$stage['id'], ['pool_id' => (int)$flowPool['id']]);
            $freshPool = voteFlowPoolById($db, (int)$flowPool['id']);
            voteRespond([
                'success' => true,
                'rebuilt' => true,
                'seeded_count' => $seededCount,
                'pool_id' => (int)$flowPool['id'],
                'runtime' => voteFlowPoolRuntime($freshPool, voteFetchStage((int)$stage['id'])),
            ]);
        }
        if ($flowPool) {
            $config = voteDecode($flowPool['config_json'] ?? '{}');
            $config['ends_at'] = $payload['ends_at'];
            $config['result_visibility'] = $payload['result_visibility'];
            $now = voteNowExpr();
            $db->beginTransaction();
            try {
                $db->prepare("UPDATE vote_stages SET title = ?, ends_at = ?, result_visibility = ?, updated_at = $now WHERE id = ?")
                    ->execute([$payload['title'], $payload['ends_at'], $payload['result_visibility'], (int)$stage['id']]);
                $db->prepare('UPDATE vote_flow_pools SET title = ?, config_json = ? WHERE id = ?')
                    ->execute([$payload['title'], voteJson($config), (int)$flowPool['id']]);
                $db->commit();
            } catch (Throwable $e) {
                if ($db->inTransaction()) $db->rollBack();
                voteRespond(['success' => false, 'code' => 'UPDATE_SAFE_FIELDS_FAILED', 'message' => $e->getMessage()], 400);
            }
            logAction('vote_stage.update_safe_fields', 'vote_stages', (int)$stage['id'], ['pool_id' => (int)$flowPool['id']]);
            voteRespond(['success' => true, 'rebuilt' => false, 'pool_id' => (int)$flowPool['id']]);
        }
        $now = voteNowExpr();
        $stmt = $db->prepare(
            "UPDATE vote_stages SET stage_type = ?, title = ?, starts_at = ?, ends_at = ?, vote_mode = ?, max_select = ?, advance_count = ?, group_count = ?, score_min = ?, score_max = ?, allow_vote_change = ?, result_visibility = ?, config_json = ?, updated_at = $now WHERE id = ?"
        );
        $stmt->execute([$payload['stage_type'], $payload['title'], $payload['starts_at'], $payload['ends_at'], $payload['vote_mode'], $payload['max_select'], $payload['advance_count'], $payload['group_count'], $payload['score_min'], $payload['score_max'], $payload['allow_vote_change'], $payload['result_visibility'], $payload['config_json'], (int)$stage['id']]);
        logAction('vote_stage.update', 'vote_stages', (int)$stage['id'], null);
        voteRespond(['success' => true]);

    case 'reorder':
        $input = voteReadJson();
        [$user, $project] = voteRequireProjectManager((int)($input['project_id'] ?? $input['contest_id'] ?? 0));
        foreach (($input['stage_ids'] ?? []) as $index => $stageId) {
            $db->prepare('UPDATE vote_stages SET sort_order = ? WHERE id = ? AND project_id = ?')->execute([$index + 1, (int)$stageId, (int)$project['id']]);
        }
        voteRespond(['success' => true]);

    case 'flow_status':
        $project = voteGetProject((int)($_GET['project_id'] ?? $_GET['contest_id'] ?? 0));
        if (!$project) voteRespond(['success' => false, 'message' => '企划不存在'], 404);
        $user = getCurrentUser();
        if (!voteCanReadProject($user, $project)) voteRespond(['success' => false, 'message' => '无权查看'], 403);
        $canManageFlow = $user ? voteCanManageProject($user, $project) : false;
        $flowStatus = voteFlowStatus($db, (int)$project['id']);
        if (!$canManageFlow) {
            foreach ($flowStatus['pools'] as &$poolStrip) {
                if (isset($poolStrip['runtime'])) $poolStrip['runtime'] = voteStripTieBreaks($poolStrip['runtime']);
            }
            unset($poolStrip);
            if (isset($flowStatus['active_pool']['runtime'])) {
                $flowStatus['active_pool']['runtime'] = voteStripTieBreaks($flowStatus['active_pool']['runtime']);
            }
        }
        voteRespond(array_merge(['success' => true, 'can_manage' => $canManageFlow], $flowStatus));

    case 'rebuild_from_nomination_and_open':
        $input = voteReadJson();
        [$user, $project] = voteRequireProjectManager((int)($_GET['project_id'] ?? $_GET['contest_id'] ?? $input['project_id'] ?? $input['contest_id'] ?? 0));
        try {
            $forceRebuild = filter_var($input['force_rebuild'] ?? $_GET['force_rebuild'] ?? false, FILTER_VALIDATE_BOOLEAN);
            $result = voteFlowRebuildFromNominationAndOpen($db, $project, (int)$user['id'], $forceRebuild);
            voteRespond([
                'success' => true,
                'status' => 'open',
                'run' => $result['run'],
                'pool' => $result['pool'],
                'flow_run_id' => (int)$result['run']['id'],
                'pool_id' => (int)$result['pool']['id'],
                'stage_id' => (int)$result['pool']['stage_id'],
                'seeded_count' => (int)$result['seeded_count'],
                'readback_count' => (int)$result['readback_count'],
                'pool_count_after' => (int)$result['readback_count'],
                'source_stage_id' => $result['source_stage_id'],
                'target_stage_id' => (int)$result['pool']['stage_id'],
                'nomination_stage_id' => $result['source_stage_id'],
                'qualifier_stage_id' => (int)$result['pool']['stage_id'],
                'existing' => !empty($result['existing']),
            ]);
        } catch (Throwable $e) {
            $messages = [
                'QUALIFIER_STAGE_NOT_FOUND' => '缺少海选阶段配置',
                'NO_ELIGIBLE_NOMINATIONS' => '没有有效提名，不能生成海选池',
                'FLOW_POOL_CREATE_FAILED' => '海选池创建失败',
                'FLOW_POOL_READBACK_MISMATCH' => '海选池写入后读取数量不一致，已回滚',
            ];
            $message = $messages[$e->getMessage()] ?? $e->getMessage();
            $validationHints = ['晋级数必须大于 0 且不能超过候选数', '晋级数必须能被分组数整除', '每组候选数不足以满足晋级名额', '阶段池没有可用候选'];
            foreach ($validationHints as $hint) {
                if (strpos($message, $hint) !== false) {
                    $message .= '，请检查海选阶段配置（晋级数、分组数）是否与实际候选数匹配';
                    break;
                }
            }
            voteRespond(['success' => false, 'code' => 'REBUILD_FLOW_AND_OPEN_FAILED', 'message' => $message], 400);
        }

    case 'rebuild_from_nomination':
        $input = voteReadJson();
        [$user, $project] = voteRequireProjectManager((int)($_GET['project_id'] ?? $_GET['contest_id'] ?? $input['project_id'] ?? $input['contest_id'] ?? 0));
        try {
            $result = voteFlowRebuildFromNomination($db, $project, (int)$user['id']);
            voteRespond([
                'success' => true,
                'run' => $result['run'],
                'pool' => $result['pool'],
                'seeded_count' => (int)$result['seeded_count'],
                'readback_count' => voteFlowPoolEntryCount($db, (int)$result['pool']['id']),
                'target_stage_id' => (int)$result['pool']['stage_id'],
                'pool_id' => (int)$result['pool']['id'],
            ]);
        } catch (Throwable $e) {
            voteRespond(['success' => false, 'code' => 'REBUILD_FLOW_FAILED', 'message' => $e->getMessage()], 400);
        }

    case 'open_pool':
        $input = voteReadJson();
        $pool = voteFlowPoolById($db, (int)($_GET['pool_id'] ?? $input['pool_id'] ?? 0));
        if (!$pool) voteRespond(['success' => false, 'message' => '阶段池不存在'], 404);
        [$user, $project] = voteRequireProjectManager((int)$pool['project_id']);
        try {
            $pool = voteFlowOpenPool($db, $pool);
            voteRespond(['success' => true, 'status' => $pool['status'], 'pool' => $pool, 'stage_id' => (int)$pool['stage_id']]);
        } catch (Throwable $e) {
            voteRespond(['success' => false, 'code' => 'OPEN_POOL_FAILED', 'message' => $e->getMessage()], 400);
        }

    case 'settle_pool':
        $input = voteReadJson();
        $pool = voteFlowPoolById($db, (int)($_GET['pool_id'] ?? $input['pool_id'] ?? 0));
        if (!$pool) voteRespond(['success' => false, 'message' => '阶段池不存在'], 404);
        [$user, $project] = voteRequireProjectManager((int)$pool['project_id']);
        try {
            $result = voteFlowSettlePool($db, $pool);
            voteRespond(array_merge(['success' => true, 'status' => 'settled', 'pool_id' => (int)$pool['id']], $result));
        } catch (Throwable $e) {
            voteRespond(['success' => false, 'code' => 'SETTLE_POOL_FAILED', 'message' => $e->getMessage()], 400);
        }

    case 'generate_next_pool':
        $input = voteReadJson();
        $pool = voteFlowPoolById($db, (int)($_GET['pool_id'] ?? $input['pool_id'] ?? 0));
        if (!$pool) voteRespond(['success' => false, 'message' => '来源阶段池不存在'], 404);
        [$user, $project] = voteRequireProjectManager((int)$pool['project_id']);
        try {
            $result = voteFlowGenerateNextPool($db, $pool);
            voteRespond([
                'success' => true,
                'pool' => $result['pool'],
                'pool_id' => (int)$result['pool']['id'],
                'target_stage_id' => (int)$result['pool']['stage_id'],
                'source_pool_id' => (int)$pool['id'],
                'seeded_count' => (int)$result['seeded_count'],
                'existing' => !empty($result['existing']),
            ]);
        } catch (Throwable $e) {
            voteRespond(['success' => false, 'code' => 'GENERATE_NEXT_POOL_FAILED', 'message' => $e->getMessage()], 400);
        }

    case 'seed_entries':
        $input = voteReadJson();
        $stage = voteFetchStage((int)($_GET['id'] ?? $input['stage_id'] ?? 0));
        if (!$stage) voteRespond(['success' => false, 'message' => '阶段不存在'], 404);
        [$user, $project] = voteRequireProjectManager((int)$stage['project_id']);
        $entryIds = is_array($input['entry_ids'] ?? null) ? $input['entry_ids'] : [];
        $count = $entryIds ? voteSeedStageEntries($db, $stage, $entryIds, (int)($input['source_stage_id'] ?? 0) ?: null) : voteEnsureStageEntries($db, $stage);
        logAction('vote_stage.seed_entries', 'vote_stages', (int)$stage['id'], ['count' => $count]);
        voteRespond([
            'success' => true,
            'count' => $count,
            'seeded_count' => $count,
            'existing_count' => voteStageEntryCount($db, (int)$stage['id']),
            'reseeded' => false,
            'target_stage_id' => (int)$stage['id'],
            'source_stage_id' => (int)($input['source_stage_id'] ?? 0) ?: null,
        ]);

    case 'reseed_stage':
        $input = voteReadJson();
        $stage = voteFetchStage((int)($_GET['id'] ?? $input['stage_id'] ?? 0));
        if (!$stage) voteRespond(['success' => false, 'message' => '阶段不存在'], 404);
        [$user, $project] = voteRequireProjectManager((int)$stage['project_id']);
        if (!voteCanReseedStage($db, (int)$stage['id'])) {
            voteRespond([
                'success' => false,
                'code' => 'STAGE_HAS_ACTIVITY',
                'message' => '该阶段已有投票、对阵或结算结果，不能重新生成候选池',
                'usage' => voteStageUsageCounts($db, (int)$stage['id']),
            ], 400);
        }
        $existing = voteStageEntryCount($db, (int)$stage['id']);
        if (($stage['stage_type'] ?? '') === 'qualifier') {
            voteNormalizePendingEntries($db, (int)$project['id']);
            $stmt = $db->prepare("SELECT id FROM vote_entries WHERE project_id = ? AND entry_status = 'approved' ORDER BY reviewed_at ASC, id ASC");
            $stmt->execute([(int)$project['id']]);
            $count = voteSeedStageEntries($db, $stage, array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN)), null, [], true);
            $sourceStageId = null;
        } else {
            $sourceStageId = (int)($input['source_stage_id'] ?? 0);
            $sourceStage = $sourceStageId > 0 ? voteFetchStage($sourceStageId) : votePreviousStage($db, $stage);
            if (!$sourceStage) voteRespond(['success' => false, 'message' => '没有可用于生成候选池的来源阶段'], 400);
            $result = voteSeedStageFromResults($db, $sourceStage, $stage, true);
            $count = (int)$result['seeded_count'];
            $sourceStageId = (int)$sourceStage['id'];
        }
        if ($count <= 0) voteRespond(['success' => false, 'code' => 'NO_ELIGIBLE_ENTRIES', 'message' => '没有可生成的候选池', 'seeded_count' => 0], 400);
        logAction('vote_stage.reseed_stage', 'vote_stages', (int)$stage['id'], ['count' => $count, 'existing_count' => $existing]);
        voteRespond([
            'success' => true,
            'seeded_count' => $count,
            'existing_count' => $existing,
            'reseeded' => $existing > 0,
            'target_stage_id' => (int)$stage['id'],
            'source_stage_id' => $sourceStageId,
        ]);

    case 'advance_from_stage':
        $input = voteReadJson();
        $sourceStage = voteFetchStage((int)($_GET['id'] ?? $input['stage_id'] ?? $input['source_stage_id'] ?? 0));
        if (!$sourceStage) voteRespond(['success' => false, 'message' => '阶段不存在'], 404);
        [$user, $project] = voteRequireProjectManager((int)$sourceStage['project_id']);
        if (($sourceStage['status'] ?? '') !== 'settled') {
            voteRespond(['success' => false, 'code' => 'SOURCE_STAGE_NOT_SETTLED', 'message' => '来源阶段尚未结算，不能推进到下一阶段'], 400);
        }
        $targetStage = null;
        if (!empty($input['target_stage_id'])) {
            $targetStage = voteFetchStage((int)$input['target_stage_id']);
            if (!$targetStage || (int)$targetStage['project_id'] !== (int)$project['id']) $targetStage = null;
        }
        if (!$targetStage) $targetStage = voteNextStage($db, $sourceStage);
        if (!$targetStage) voteRespond(['success' => false, 'code' => 'NEXT_STAGE_NOT_FOUND', 'message' => '没有可推进的下一阶段'], 400);
        $result = voteSeedStageFromResults($db, $sourceStage, $targetStage, false);
        if ((int)$result['seeded_count'] <= 0) {
            voteRespond(['success' => false, 'code' => 'NO_ADVANCED_ENTRIES', 'message' => '来源阶段没有晋级条目', 'seeded_count' => 0], 400);
        }
        $now = voteNowExpr();
        $db->beginTransaction();
        $db->prepare("UPDATE vote_stages SET status = 'locked', updated_at = $now WHERE project_id = ? AND status = 'open' AND id <> ?")
            ->execute([(int)$project['id'], (int)$targetStage['id']]);
        $db->prepare("UPDATE vote_stages SET status = 'open', starts_at = COALESCE(starts_at, $now), updated_at = $now WHERE id = ?")
            ->execute([(int)$targetStage['id']]);
        $db->commit();
        logAction('vote_stage.advance_from_stage', 'vote_stages', (int)$targetStage['id'], $result);
        voteRespond(array_merge(['success' => true, 'status' => 'open'], $result));

    case 'advance_from_nomination':
        $input = voteReadJson();
        $projectId = (int)($_GET['project_id'] ?? $_GET['contest_id'] ?? $input['project_id'] ?? $input['contest_id'] ?? 0);
        [$user, $project] = voteRequireProjectManager($projectId);
        try {
            $forceRebuild = filter_var($input['force_rebuild'] ?? $_GET['force_rebuild'] ?? false, FILTER_VALIDATE_BOOLEAN);
            $rebuilt = voteFlowRebuildFromNominationAndOpen($db, $project, (int)$user['id'], $forceRebuild);
            $pool = $rebuilt['pool'];
            voteRespond([
                'success' => true,
                'status' => 'open',
                'seeded_count' => (int)$rebuilt['seeded_count'],
                'readback_count' => (int)$rebuilt['readback_count'],
                'existing_count' => 0,
                'pool_count_after' => (int)$rebuilt['readback_count'],
                'already_seeded' => false,
                'reseeded' => true,
                'flow_run_id' => (int)$rebuilt['run']['id'],
                'pool_id' => (int)$pool['id'],
                'target_stage_id' => (int)$pool['stage_id'],
                'source_stage_id' => $rebuilt['source_stage_id'],
                'nomination_stage_id' => $rebuilt['source_stage_id'],
                'qualifier_stage_id' => (int)$pool['stage_id'],
                'existing' => !empty($rebuilt['existing']),
            ]);
        } catch (Throwable $e) {
            $messages = [
                'QUALIFIER_STAGE_NOT_FOUND' => '缺少海选阶段配置',
                'NO_ELIGIBLE_NOMINATIONS' => '没有有效提名，不能生成海选池',
                'FLOW_POOL_CREATE_FAILED' => '海选池创建失败',
                'FLOW_POOL_READBACK_MISMATCH' => '海选池写入后读取数量不一致，已回滚',
            ];
            voteRespond(['success' => false, 'code' => 'ADVANCE_FROM_NOMINATION_FAILED', 'message' => $messages[$e->getMessage()] ?? $e->getMessage()], 400);
        }

        $stmt = $db->prepare("SELECT * FROM vote_stages WHERE project_id = ? AND stage_type = 'nomination' AND status IN ('open', 'locked', 'settled') ORDER BY sort_order ASC, id ASC LIMIT 1");
        $stmt->execute([(int)$project['id']]);
        $nominationStage = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$nominationStage) {
            voteRespond([
                'success' => false,
                'code' => 'NOMINATION_NOT_OPEN',
                'message' => '当前企划没有可转入海选的提名阶段',
            ], 400);
        }

        $stmt = $db->prepare("SELECT * FROM vote_stages WHERE project_id = ? AND stage_type = 'qualifier' ORDER BY sort_order ASC, id ASC LIMIT 1");
        $stmt->execute([(int)$project['id']]);
        $qualifierStage = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$qualifierStage) {
            voteRespond([
                'success' => false,
                'code' => 'QUALIFIER_NOT_FOUND',
                'message' => '当前企划没有海选阶段',
            ], 400);
        }

        $normalizedCount = voteNormalizePendingEntries($db, (int)$project['id']);
        $stmt = $db->prepare("SELECT id FROM vote_entries WHERE project_id = ? AND entry_status = 'approved' ORDER BY reviewed_at ASC, id ASC");
        $stmt->execute([(int)$project['id']]);
        $entryIds = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
        if (!$entryIds) {
            voteRespond([
                'success' => false,
                'code' => 'NO_ELIGIBLE_ENTRIES',
                'message' => '没有可进入海选的有效提名',
                'seeded_count' => 0,
            ], 400);
        }

        $voteStmt = $db->prepare('SELECT COUNT(*) FROM vote_votes WHERE stage_id = ?');
        $voteStmt->execute([(int)$qualifierStage['id']]);
        $hasQualifierVotes = (int)$voteStmt->fetchColumn() > 0;
        $existingStmt = $db->prepare("SELECT COUNT(*) FROM vote_stage_entries WHERE stage_id = ? AND status = 'active'");
        $existingStmt->execute([(int)$qualifierStage['id']]);
        $existingCount = (int)$existingStmt->fetchColumn();

        try {
            voteEnsureSchema($db);
            $db->beginTransaction();
            if ($existingCount > 0) {
                $seededCount = $existingCount;
                $alreadySeeded = true;
                $reseeded = false;
            } else {
                $seededCount = voteSeedStageEntries($db, $qualifierStage, $entryIds, (int)$nominationStage['id']);
                $alreadySeeded = false;
                $reseeded = false;
            }

            $afterStmt = $db->prepare("SELECT COUNT(*) FROM vote_stage_entries WHERE stage_id = ? AND status = 'active'");
            $afterStmt->execute([(int)$qualifierStage['id']]);
            $poolCountAfter = (int)$afterStmt->fetchColumn();

            if ($poolCountAfter <= 0) {
                $db->rollBack();
                voteRespond([
                    'success' => false,
                    'code' => 'NO_ELIGIBLE_ENTRIES',
                    'message' => '没有可进入海选的有效提名',
                    'seeded_count' => 0,
                ], 400);
            }

            $now = voteNowExpr();
            $db->prepare("UPDATE vote_stages SET status = 'locked', updated_at = $now WHERE project_id = ? AND status = 'open' AND id <> ?")
                ->execute([(int)$project['id'], (int)$qualifierStage['id']]);
            $db->prepare("UPDATE vote_stages SET status = 'locked', updated_at = $now WHERE id = ?")
                ->execute([(int)$nominationStage['id']]);
            $db->prepare("UPDATE vote_stages SET status = 'open', starts_at = COALESCE(starts_at, $now), updated_at = $now WHERE id = ?")
                ->execute([(int)$qualifierStage['id']]);
            $db->commit();
        } catch (Throwable $e) {
            if ($db->inTransaction()) {
                $db->rollBack();
            }
            voteRespond([
                'success' => false,
                'code' => 'ADVANCE_FROM_NOMINATION_FAILED',
                'message' => '生成海选池失败：' . $e->getMessage(),
            ], 500);
        }

        logAction('vote_stage.advance_from_nomination', 'vote_stages', (int)$qualifierStage['id'], [
            'project_id' => (int)$project['id'],
            'nomination_stage_id' => (int)$nominationStage['id'],
            'seeded_count' => $seededCount,
            'existing_count' => $existingCount,
            'pool_count_after' => $poolCountAfter,
            'already_seeded' => $alreadySeeded,
        ]);
        voteRespond([
            'success' => true,
            'status' => 'open',
            'seeded_count' => $seededCount,
            'existing_count' => $existingCount,
            'pool_count_after' => $poolCountAfter,
            'already_seeded' => $alreadySeeded,
            'reseeded' => $reseeded,
            'target_stage_id' => (int)$qualifierStage['id'],
            'source_stage_id' => (int)$nominationStage['id'],
            'nomination_stage_id' => (int)$nominationStage['id'],
            'qualifier_stage_id' => (int)$qualifierStage['id'],
            'flow_debug' => [
                'project_id' => (int)$project['id'],
                'nomination_stage_status' => (string)$nominationStage['status'],
                'qualifier_stage_status_before' => (string)$qualifierStage['status'],
                'normalized_pending_count' => $normalizedCount,
                'eligible_entry_count' => count($entryIds),
                'existing_pool_count_before' => $existingCount,
                'has_qualifier_votes' => $hasQualifierVotes,
            ],
        ]);

    case 'resolve_flow_tie':
        $input = voteReadJson();
        $pool = voteFlowPoolById($db, (int)($_GET['pool_id'] ?? $input['pool_id'] ?? 0));
        if (!$pool) voteRespond(['success' => false, 'message' => '阶段池不存在'], 404);
        [$user, $project] = voteRequireProjectManager((int)$pool['project_id']);
        try {
            $result = voteFlowResolvePoolTie(
                $db,
                $pool,
                is_array($input['decisions'] ?? null) ? $input['decisions'] : []
            );
            logAction('vote_stage.resolve_flow_tie', 'vote_flow_pools', (int)$pool['id'], $result);
            voteRespond(array_merge(['success' => true, 'pool_id' => (int)$pool['id']], $result));
        } catch (Throwable $e) {
            voteRespond(['success' => false, 'code' => 'RESOLVE_FLOW_TIE_FAILED', 'message' => $e->getMessage()], 400);
        }

    case 'resolve_tie':
        $input = voteReadJson();
        $stage = voteFetchStage((int)($_GET['id'] ?? $input['stage_id'] ?? 0));
        if (!$stage) voteRespond(['success' => false, 'message' => '阶段不存在'], 404);
        [$user, $project] = voteRequireProjectManager((int)$stage['project_id']);
        $selected = is_array($input['entry_ids'] ?? null) ? $input['entry_ids'] : [];
        voteResolveStageTie($db, $stage, $selected);
        logAction('vote_stage.resolve_tie', 'vote_stages', (int)$stage['id'], ['entry_ids' => array_map('intval', $selected)]);
        voteRespond(['success' => true, 'status' => 'settled']);

    case 'open':
    case 'lock':
    case 'close':
    case 'settle':
        $stage = voteFetchStage((int)($_GET['id'] ?? 0));
        if (!$stage) voteRespond(['success' => false, 'message' => '阶段不存在'], 404);
        [$user, $project] = voteRequireProjectManager((int)$stage['project_id']);
        $flowPool = voteFlowPoolForStage($db, (int)$stage['id']);
        if ($flowPool) {
            if ($action === 'settle') {
                try {
                    $result = voteFlowSettlePool($db, $flowPool);
                    voteRespond(array_merge([
                        'success' => true,
                        'status' => 'settled',
                        'pool_id' => (int)$flowPool['id'],
                        'flow_run_id' => (int)$flowPool['run_id'],
                    ], $result));
                } catch (Throwable $e) {
                    voteRespond(['success' => false, 'code' => 'SETTLE_POOL_FAILED', 'message' => $e->getMessage()], 400);
                }
            }
            if ($action === 'open') {
                try {
                    $opened = voteFlowOpenPool($db, $flowPool);
                    voteRespond([
                        'success' => true,
                        'status' => 'open',
                        'pool_id' => (int)$opened['id'],
                        'flow_run_id' => (int)$opened['run_id'],
                        'seeded_count' => voteFlowPoolEntryCount($db, (int)$opened['id']),
                    ]);
                } catch (Throwable $e) {
                    voteRespond(['success' => false, 'code' => 'OPEN_POOL_FAILED', 'message' => $e->getMessage()], 400);
                }
            }
            $now = voteNowExpr();
            $db->beginTransaction();
            $db->prepare("UPDATE vote_flow_pools SET status = 'locked' WHERE id = ?")->execute([(int)$flowPool['id']]);
            $db->prepare("UPDATE vote_stages SET status = 'locked', updated_at = $now WHERE id = ?")->execute([(int)$stage['id']]);
            $db->commit();
            voteRespond(['success' => true, 'status' => 'locked', 'pool_id' => (int)$flowPool['id']]);
        }
        if ($action === 'settle') {
            try {
                voteSettleStage($db, $stage);
            } catch (Throwable $e) {
                voteRespond(['success' => false, 'code' => 'SETTLE_FAILED', 'message' => $e->getMessage()], 400);
            }
            $fresh = voteFetchStage((int)$stage['id']);
            $advancedStmt = $db->prepare('SELECT COUNT(*) FROM vote_results WHERE stage_id = ? AND advanced = 1');
            $advancedStmt->execute([(int)$stage['id']]);
            $advancedCount = (int)$advancedStmt->fetchColumn();
            $next = voteNextStage($db, $stage);
            $nextSeededCount = 0;
            if ($next) {
                $nextStmt = $db->prepare("SELECT COUNT(*) FROM vote_stage_entries WHERE stage_id = ? AND status = 'active'");
                $nextStmt->execute([(int)$next['id']]);
                $nextSeededCount = (int)$nextStmt->fetchColumn();
            }
            logAction('vote_stage.settle', 'vote_stages', (int)$stage['id'], null);
            voteRespond([
                'success' => true,
                'status' => $fresh['status'] ?? 'settled',
                'config' => voteDecode($fresh['config_json'] ?? '{}'),
                'advanced_count' => $advancedCount,
                'next_stage_id' => $next ? (int)$next['id'] : null,
                'next_seeded_count' => $nextSeededCount,
            ]);
        }
        $status = $action === 'open' ? 'open' : 'locked';
        $seededCount = null;
        if ($action === 'open') {
            if (($stage['stage_type'] ?? '') !== 'nomination') {
                voteRespond([
                    'success' => false,
                    'code' => 'STAGE_POOL_NOT_GENERATED',
                    'message' => '阶段池尚未生成，请联系负责人',
                    'seeded_count' => 0,
                    'stage_id' => (int)$stage['id'],
                ], 400);
            }
            $seededCount = voteEnsureStageEntries($db, $stage);
            if (($stage['stage_type'] ?? '') !== 'nomination' && $seededCount <= 0) {
                voteRespond([
                    'success' => false,
                    'code' => 'NO_ELIGIBLE_ENTRIES',
                    'message' => '当前阶段没有可用候选池',
                    'seeded_count' => 0,
                ], 400);
            }
        }
        $now = voteNowExpr();
        $db->beginTransaction();
        if ($action === 'open') {
            $db->prepare("UPDATE vote_stages SET status = 'locked', updated_at = $now WHERE project_id = ? AND status = 'open' AND id <> ?")
                ->execute([(int)$stage['project_id'], (int)$stage['id']]);
        }
        $db->prepare("UPDATE vote_stages SET status = ?, starts_at = CASE WHEN ? = 'open' THEN COALESCE(starts_at, $now) ELSE starts_at END, updated_at = $now WHERE id = ?")->execute([$status, $status, (int)$stage['id']]);
        $db->commit();
        logAction('vote_stage.' . $action, 'vote_stages', (int)$stage['id'], null);
        voteRespond(['success' => true, 'status' => $status, 'seeded_count' => $seededCount]);

    case 'stage_entries':
        $stageId = (int)($_GET['stage_id'] ?? 0);
        if ($stageId <= 0) voteRespond(['success' => false, 'message' => '无效 stage_id'], 400);
        $stage = voteFetchStage($stageId);
        if (!$stage) voteRespond(['success' => false, 'message' => '阶段不存在'], 404);
        $user = getCurrentUser();
        $project = voteGetProject((int)$stage['project_id']);
        if (!$project || !voteCanReadProject($user, $project)) voteRespond(['success' => false, 'message' => '无权查看'], 403);
        $flowPool = voteFlowPoolForStage($db, $stageId);
        if ($flowPool) {
            $rows = voteFlowPoolEntries($db, (int)$flowPool['id']);
            $runtime = voteFlowPoolRuntime($flowPool, $stage);
            $visibility = voteResultVisibilityFlags(
                $project,
                (string)($flowPool['status'] ?? ''),
                (string)$runtime['result_visibility']
            );
            $canManage = $user && voteCanManageProject($user, $project);
            $voteStmt = $db->prepare('SELECT entry_id, COALESCE(SUM(vote_value), 0) AS votes FROM vote_votes WHERE stage_id = ? GROUP BY entry_id');
            $voteStmt->execute([$stageId]);
            $voteCounts = [];
            foreach ($voteStmt->fetchAll(PDO::FETCH_ASSOC) as $voteRow) {
                $voteCounts[(int)$voteRow['entry_id']] = (int)$voteRow['votes'];
            }
            $groups = [];
            $sourcePoolId = null;
            foreach ($rows as &$r) {
                if (!empty($r['image_url'])) $r['image_url'] = proxyImageUrl($r['image_url']);
                $r['stage_id'] = $stageId;
                $r['entry_id'] = (int)$r['entry_id'];
                if ($visibility['metrics_visible'] || $canManage) {
                    $r['votes'] = (int)($voteCounts[(int)$r['entry_id']] ?? 0);
                } else {
                    unset($r['votes']);
                }
                $groupKey = (string)($r['group_key'] ?? '');
                if ($groupKey === '') $groupKey = 'all';
                if (!isset($groups[$groupKey])) $groups[$groupKey] = 0;
                $groups[$groupKey]++;
                if ($sourcePoolId === null && !empty($r['source_pool_id'])) $sourcePoolId = (int)$r['source_pool_id'];
            }
            unset($r);
            if ($canManage) {
                usort($rows, function ($a, $b) use ($voteCounts) {
                    $va = (int)($voteCounts[(int)$a['entry_id']] ?? 0);
                    $vb = (int)($voteCounts[(int)$b['entry_id']] ?? 0);
                    if ($va !== $vb) return $vb <=> $va;
                    $sa = (int)($a['seed_no'] ?? 0);
                    $sb = (int)($b['seed_no'] ?? 0);
                    if ($sa !== $sb) return $sa <=> $sb;
                    return (int)$a['entry_id'] <=> (int)$b['entry_id'];
                });
                $rank = 1;
                foreach ($rows as &$r) {
                    $r['rank'] = $rank++;
                }
                unset($r);
            }
            voteRespond([
                'success' => true,
                'stage_id' => $stageId,
                'pool_id' => (int)$flowPool['id'],
                'flow_run_id' => (int)$flowPool['run_id'],
                'pool_status' => (string)$flowPool['status'],
                'source_pool_id' => $sourcePoolId,
                'source_stage_id' => null,
                'count' => count($rows),
                'raw_count' => voteFlowPoolEntryCount($db, (int)$flowPool['id']),
                'groups' => $groups,
                'runtime' => $runtime,
                'rank_visible' => $visibility['rank_visible'],
                'metrics_visible' => $visibility['metrics_visible'],
                'can_manage' => $canManage,
                'data' => $rows,
            ]);
        }
        voteRespond([
            'success' => true,
            'stage_id' => $stageId,
            'pool_id' => null,
            'pool_status' => 'missing',
            'source_pool_id' => null,
            'source_stage_id' => null,
            'count' => 0,
            'raw_count' => 0,
            'groups' => [],
            'data' => [],
            'message' => '阶段池尚未生成，请联系负责人',
        ]);
    default:
        voteRespond(['success' => false, 'message' => '未知 action=' . $action], 400);
}
