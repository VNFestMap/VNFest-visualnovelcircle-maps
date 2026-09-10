import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const php = String.raw`
<?php
define('DB_PATH', ':memory:');
require_once getcwd() . '/includes/vote_projects.php';

$db = getDB();
$db->exec("CREATE TABLE vote_projects (id INTEGER PRIMARY KEY, project_type TEXT, club_id INTEGER, country TEXT, title TEXT, year_label TEXT, status TEXT, eligibility_mode TEXT DEFAULT 'public', visibility TEXT DEFAULT 'public', ended_at TEXT, updated_at TEXT)");
$db->exec("CREATE TABLE vote_stages (id INTEGER PRIMARY KEY, project_id INTEGER, stage_type TEXT, title TEXT, status TEXT, sort_order INTEGER, starts_at TEXT, vote_mode TEXT, group_count INTEGER, max_select INTEGER, advance_count INTEGER, score_min INTEGER DEFAULT 1, score_max INTEGER DEFAULT 10, config_json TEXT DEFAULT '{}', updated_at TEXT)");
$db->exec("CREATE TABLE vote_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, source_type TEXT, source_id TEXT, title TEXT, title_cn TEXT, subtitle TEXT, image_url TEXT, summary TEXT, external_url TEXT, identity_key TEXT, entry_status TEXT, reviewed_at TEXT, created_by INTEGER)");
$db->exec("CREATE TABLE vote_flow_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, version_no INTEGER, status TEXT, created_by INTEGER, snapshot_json TEXT, archived_at TEXT)");
$db->exec("CREATE TABLE vote_flow_pools (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, project_id INTEGER, stage_id INTEGER, stage_type TEXT, title TEXT, status TEXT, vote_mode TEXT, group_count INTEGER, max_select INTEGER, advance_count INTEGER, config_json TEXT, opened_at TEXT, settled_at TEXT)");
$db->exec("CREATE TABLE vote_flow_pool_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, pool_id INTEGER, project_id INTEGER, entry_id INTEGER, group_key TEXT, seed_no INTEGER, source_pool_id INTEGER, source_rank INTEGER, status TEXT)");
$db->exec("CREATE TABLE vote_flow_results (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, pool_id INTEGER, project_id INTEGER, entry_id INTEGER, rank_no INTEGER, votes INTEGER, score_total INTEGER DEFAULT 0, rating_count INTEGER DEFAULT 0, score_avg REAL, advanced INTEGER, snapshot_json TEXT)");
$db->exec("CREATE TABLE vote_flow_matches (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, pool_id INTEGER, project_id INTEGER, stage_id INTEGER, round_no INTEGER, match_no INTEGER, slot_a_entry_id INTEGER, slot_b_entry_id INTEGER, winner_entry_id INTEGER, status TEXT, next_match_id INTEGER, next_slot TEXT, updated_at TEXT)");
$db->exec("CREATE TABLE vote_votes (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, stage_id INTEGER, entry_id INTEGER, match_id INTEGER, user_id INTEGER, vote_value INTEGER, score_value INTEGER)");
$db->exec("CREATE TABLE vote_flow_events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, pool_id INTEGER, project_id INTEGER, event_type TEXT, payload_json TEXT)");

$db->exec("INSERT INTO vote_projects (id, project_type, club_id, country, title, year_label, status) VALUES (1, 'twelve', 1, 'china', 'test', '2026', 'running')");
$db->exec("INSERT INTO vote_stages (id, project_id, stage_type, title, status, sort_order, vote_mode, group_count, max_select, advance_count) VALUES (11, 1, 'nomination', '提名', 'open', 1, 'nomination', 1, 1, 0)");
$db->exec("INSERT INTO vote_stages (id, project_id, stage_type, title, status, sort_order, vote_mode, group_count, max_select, advance_count) VALUES (12, 1, 'qualifier', '海选', 'pending', 2, 'multi_select', 2, 3, 4)");
for ($i = 1; $i <= 6; $i++) {
    $db->prepare("INSERT INTO vote_entries (project_id, source_type, source_id, title, identity_key, entry_status) VALUES (1, 'manual', ?, ?, ?, 'approved')")
        ->execute([$i, '作品'.$i, 'manual:'.$i]);
}

$first = voteFlowRebuildFromNominationAndOpen($db, ['id' => 1], 1);
$second = voteFlowRebuildFromNominationAndOpen($db, ['id' => 1], 1);
$db->prepare("UPDATE vote_entries SET entry_status = 'removed' WHERE id = ?")->execute([1]);
$forced = voteFlowRebuildFromNominationAndOpen($db, ['id' => 1], 1, true);
foreach (voteFlowPoolEntries($db, (int)$forced['pool']['id']) as $entry) {
    $votes = (int)$entry['entry_id'];
    $db->prepare("INSERT INTO vote_votes (project_id, stage_id, entry_id, user_id, vote_value) VALUES (1, 12, ?, ?, ?)")
        ->execute([(int)$entry['entry_id'], 1000 + (int)$entry['entry_id'], $votes]);
}
$settled = voteFlowSettlePool($db, $forced['pool']);
$groupAdvanceRows = [];
foreach ($db->query("SELECT snapshot_json FROM vote_flow_results WHERE advanced = 1")->fetchAll(PDO::FETCH_ASSOC) as $row) {
    $snapshot = json_decode((string)$row['snapshot_json'], true) ?: [];
    $key = (string)($snapshot['group_key'] ?? '');
    $groupAdvanceRows[$key] = ($groupAdvanceRows[$key] ?? 0) + 1;
}
ksort($groupAdvanceRows);

$db->exec("INSERT INTO vote_projects (id, project_type, club_id, country, title, year_label, status) VALUES (2, 'moe', 1, 'china', 'moe', '2026', 'running')");
$db->exec("INSERT INTO vote_stages (id, project_id, stage_type, title, status, sort_order, vote_mode, group_count, max_select, advance_count, config_json) VALUES (21, 2, 'bracket', '淘汰赛', 'open', 1, 'match_single', 1, 1, 2, '{}')");
$db->exec("INSERT INTO vote_stages (id, project_id, stage_type, title, status, sort_order, vote_mode, group_count, max_select, advance_count, config_json) VALUES (22, 2, 'final', '决赛', 'pending', 2, 'match_single', 1, 1, 1, '{}')");
for ($i = 1; $i <= 4; $i++) {
    $db->prepare("INSERT INTO vote_entries (project_id, source_type, source_id, title, identity_key, entry_status) VALUES (2, 'manual', ?, ?, ?, 'approved')")
        ->execute([$i, '角色'.$i, 'moe:'.$i]);
}
$db->exec("INSERT INTO vote_flow_runs (project_id, version_no, status, created_by, snapshot_json) VALUES (2, 1, 'active', 1, '{}')");
$moeRunId = (int)$db->lastInsertId();
$bracketStage = voteFetchStage(21);
$bracketPool = voteFlowCreatePool($db, ['id' => $moeRunId, 'project_id' => 2], $bracketStage);
$moeEntryIds = array_map('intval', $db->query("SELECT id FROM vote_entries WHERE project_id = 2 ORDER BY id ASC")->fetchAll(PDO::FETCH_COLUMN));
voteFlowSeedPoolEntries($db, $bracketPool, $moeEntryIds);
$semiMatches = voteFlowGenerateMatches($db, $bracketPool);
voteFlowSettleMatch($db, $semiMatches[0], (int)$semiMatches[0]['slot_a_entry_id']);
voteFlowSettleMatch($db, $semiMatches[1], (int)$semiMatches[1]['slot_b_entry_id']);
$finalPoolResult = voteFlowGenerateNextPool($db, voteFlowPoolById($db, (int)$bracketPool['id']));
$finalMatches = voteFlowGenerateMatches($db, $finalPoolResult['pool']);
voteFlowSettleMatch($db, $finalMatches[0], (int)$finalMatches[0]['slot_a_entry_id']);
voteFlowSettleMatch($db, $finalMatches[1], (int)$finalMatches[1]['slot_b_entry_id']);
$finalRanks = $db->query("SELECT rank_no FROM vote_flow_results WHERE pool_id = ".(int)$finalPoolResult['pool']['id']." ORDER BY rank_no ASC")->fetchAll(PDO::FETCH_COLUMN);

$db->exec("INSERT INTO vote_projects (id, project_type, club_id, country, title, year_label, status) VALUES (5, 'moe', 1, 'china', 'moe qualifier low', '2026', 'running')");
$db->exec("INSERT INTO vote_stages (id, project_id, stage_type, title, status, sort_order, vote_mode, group_count, max_select, advance_count, config_json) VALUES (41, 5, 'nomination', '提名', 'open', 1, 'nomination', 1, 1, 0, '{}')");
$db->exec("INSERT INTO vote_stages (id, project_id, stage_type, title, status, sort_order, vote_mode, group_count, max_select, advance_count, config_json) VALUES (42, 5, 'qualifier', '海选', 'pending', 2, 'multi_select', 2, 8, 32, '{}')");
$db->prepare("UPDATE vote_stages SET starts_at = ? WHERE id = ?")->execute(['2099-01-01 00:00:00', 42]);
for ($i = 1; $i <= 5; $i++) {
    $db->prepare("INSERT INTO vote_entries (project_id, source_type, source_id, title, identity_key, entry_status) VALUES (5, 'manual', ?, ?, ?, 'approved')")
        ->execute([$i, 'moe候选'.$i, 'moe_low:'.$i]);
}
$moeLowFirst = voteFlowRebuildFromNominationAndOpen($db, ['id' => 5], 1);
$db->prepare("INSERT INTO vote_entries (project_id, source_type, source_id, title, identity_key, entry_status) VALUES (5, 'manual', ?, ?, ?, 'approved')")
    ->execute([6, 'moe候选6', 'moe_low:6']);
$moeLowSecond = voteFlowRebuildFromNominationAndOpen($db, ['id' => 5], 1);
$moeLowQualifierStatus = $db->query("SELECT status FROM vote_stages WHERE id = 42")->fetchColumn();
$moeLowNominationStatus = $db->query("SELECT status FROM vote_stages WHERE id = 41")->fetchColumn();

$db->exec("INSERT INTO vote_projects (id, project_type, club_id, country, title, year_label, status) VALUES (3, 'twelve', 1, 'china', 'score', '2026', 'running')");
$db->exec("INSERT INTO vote_stages (id, project_id, stage_type, title, status, sort_order, vote_mode, group_count, max_select, advance_count, score_min, score_max, config_json) VALUES (31, 3, 'final', '评分', 'open', 1, 'score', 1, 3, 2, 1, 10, '{}')");
for ($i = 1; $i <= 3; $i++) {
    $db->prepare("INSERT INTO vote_entries (project_id, source_type, source_id, title, identity_key, entry_status) VALUES (3, 'manual', ?, ?, ?, 'approved')")
        ->execute([$i, '评分作品'.$i, 'score:'.$i]);
}
$db->exec("INSERT INTO vote_flow_runs (project_id, version_no, status, created_by, snapshot_json) VALUES (3, 1, 'active', 1, '{}')");
$scoreRunId = (int)$db->lastInsertId();
$scoreStage = voteFetchStage(31);
$scorePool = voteFlowCreatePool($db, ['id' => $scoreRunId, 'project_id' => 3], $scoreStage);
$db->prepare("UPDATE vote_flow_pools SET status = 'open' WHERE id = ?")->execute([(int)$scorePool['id']]);
$scorePool = voteFlowPoolById($db, (int)$scorePool['id']);
$scoreEntryIds = array_map('intval', $db->query("SELECT id FROM vote_entries WHERE project_id = 3 ORDER BY id ASC")->fetchAll(PDO::FETCH_COLUMN));
voteFlowSeedPoolEntries($db, $scorePool, $scoreEntryIds);
$db->prepare("INSERT INTO vote_votes (project_id, stage_id, entry_id, user_id, vote_value, score_value) VALUES (3, 31, ?, 1, 1, 8)")->execute([$scoreEntryIds[0]]);
$db->prepare("INSERT INTO vote_votes (project_id, stage_id, entry_id, user_id, vote_value, score_value) VALUES (3, 31, ?, 2, 1, 10)")->execute([$scoreEntryIds[1]]);
$db->prepare("INSERT INTO vote_votes (project_id, stage_id, entry_id, user_id, vote_value, score_value) VALUES (3, 31, ?, 3, 1, 9)")->execute([$scoreEntryIds[2]]);
$db->prepare("INSERT INTO vote_votes (project_id, stage_id, entry_id, user_id, vote_value, score_value) VALUES (3, 31, ?, 4, 1, 9)")->execute([$scoreEntryIds[2]]);
$scoreSettle = voteFlowSettlePool($db, $scorePool);
$scoreOrder = array_map('intval', $db->query("SELECT entry_id FROM vote_flow_results WHERE pool_id = ".(int)$scorePool['id']." ORDER BY rank_no ASC")->fetchAll(PDO::FETCH_COLUMN));
$scoreAvgs = array_map('floatval', $db->query("SELECT score_avg FROM vote_flow_results WHERE pool_id = ".(int)$scorePool['id']." ORDER BY rank_no ASC")->fetchAll(PDO::FETCH_COLUMN));

$out = [
    'first_pool_id' => (int)$first['pool']['id'],
    'first_seeded' => (int)$first['seeded_count'],
    'first_readback' => (int)$first['readback_count'],
    'second_pool_id' => (int)$second['pool']['id'],
    'second_existing' => !empty($second['existing']),
    'second_seeded' => (int)$second['seeded_count'],
    'active_runs_after_second' => (int)$db->query("SELECT COUNT(*) FROM vote_flow_runs WHERE project_id = 1 AND status = 'active'")->fetchColumn(),
    'first_pool_rows_after_second' => (int)$db->query("SELECT COUNT(*) FROM vote_flow_pool_entries WHERE pool_id = ".(int)$first['pool']['id']." AND status = 'active'")->fetchColumn(),
    'forced_pool_id' => (int)$forced['pool']['id'],
    'forced_seeded' => (int)$forced['seeded_count'],
    'forced_readback' => (int)$forced['readback_count'],
    'forced_removed_entry_count' => (int)$db->query("SELECT COUNT(*) FROM vote_flow_pool_entries WHERE pool_id = ".(int)$forced['pool']['id']." AND entry_id = 1")->fetchColumn(),
    'forced_stage_entries' => count(voteFlowPoolEntries($db, (int)$forced['pool']['id'])),
    'forced_pool_status' => $db->query("SELECT status FROM vote_flow_pools WHERE id = ".(int)$forced['pool']['id'])->fetchColumn(),
    'qualifier_status' => $db->query("SELECT status FROM vote_stages WHERE id = 12")->fetchColumn(),
    'qualifier_start_at' => $db->query("SELECT starts_at FROM vote_stages WHERE id = 12")->fetchColumn(),
    'settled_advanced_count' => (int)$settled['advanced_count'],
    'group_advance_rows' => array_map('intval', $groupAdvanceRows),
    'moe_final_seeded' => (int)$finalPoolResult['seeded_count'],
    'moe_final_match_count' => count($finalMatches),
    'moe_final_ranks' => array_map('intval', $finalRanks),
    'moe_low_first_seeded' => (int)$moeLowFirst['seeded_count'],
    'moe_low_second_seeded' => (int)$moeLowSecond['seeded_count'],
    'moe_low_qualifier_status' => (string)$moeLowQualifierStatus,
    'moe_low_qualifier_start_at' => $db->query("SELECT starts_at FROM vote_stages WHERE id = 42")->fetchColumn(),
    'moe_low_nomination_status' => (string)$moeLowNominationStatus,
    'score_order' => $scoreOrder,
    'score_avgs' => $scoreAvgs,
    'score_advanced_count' => (int)$scoreSettle['advanced_count'],
];
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
`;

const result = spawnSync('php', { input: php, encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr || result.stdout);
const jsonStart = result.stdout.indexOf('{');
assert.ok(jsonStart >= 0, `expected JSON output, got: ${result.stdout}`);
const data = JSON.parse(result.stdout.slice(jsonStart));

assert.equal(data.first_seeded, 6, 'first generation should seed all approved nominations');
assert.equal(data.first_readback, 6, 'first generation should read back all seeded entries');
assert.equal(data.second_pool_id, data.first_pool_id, 'repeat generation should reuse the existing qualifier pool');
assert.equal(data.second_existing, true, 'repeat generation should be reported as existing');
assert.equal(data.second_seeded, 6, 'repeat generation should report the existing pool count');
assert.equal(data.active_runs_after_second, 1, 'repeat generation should not archive and recreate the flow run');
assert.equal(data.first_pool_rows_after_second, 6, 'repeat generation should not duplicate or clear pool entries');
assert.notEqual(data.forced_pool_id, data.first_pool_id, 'force rebuild should create a new qualifier pool');
assert.equal(data.forced_seeded, 5, 'force rebuild should omit removed nominations');
assert.equal(data.forced_readback, 5, 'force rebuild should read back the rebuilt pool');
assert.equal(data.forced_removed_entry_count, 0, 'removed nomination should not enter rebuilt qualifier pool');
assert.equal(data.forced_stage_entries, 5, 'flow pool reader should return rebuilt qualifier entries');
assert.equal(data.forced_pool_status, 'settled', 'rebuilt qualifier pool should settle after vote counting');
assert.equal(data.qualifier_status, 'settled', 'qualifier stage should settle after vote counting');
assert.ok(data.qualifier_start_at, 'automatically opened qualifier stage should record its actual start time');
assert.equal(data.settled_advanced_count, 4, 'two-group qualifier should advance the configured total');
assert.deepEqual(data.group_advance_rows, { G1: 2, G2: 2 }, 'two-group qualifier should advance an equal count per group');
assert.equal(data.moe_final_seeded, 4, 'moe final pool should include champion and third-place candidates');
assert.equal(data.moe_final_match_count, 2, 'moe final should generate champion and third-place matches');
assert.deepEqual(data.moe_final_ranks, [1, 2, 3, 4], 'moe final should settle champion, runner-up, third, and fourth places');
assert.equal(data.moe_low_first_seeded, 5, 'moe qualifier with default 32 advance count should seed all 5 nominations');
assert.equal(data.moe_low_second_seeded, 6, 'moe qualifier should re-seed with the new nomination when no votes exist');
assert.equal(data.moe_low_qualifier_status, 'open', 'moe qualifier stage should be open after rebuild');
assert.equal(data.moe_low_qualifier_start_at, '2099-01-01 00:00:00', 'a manually scheduled stage start should not be overwritten when the stage opens');
assert.equal(data.moe_low_nomination_status, 'locked', 'moe nomination stage should be locked after rebuild');
assert.deepEqual(data.score_avgs, [10, 9, 8], 'score stages should rank by average score before vote count');
assert.equal(data.score_advanced_count, 2, 'score stages should advance the configured top count');

console.log('vote flow behavior checks passed');
