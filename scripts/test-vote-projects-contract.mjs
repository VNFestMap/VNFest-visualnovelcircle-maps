import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const core = read('includes/vote_projects.php');
const stagesApi = read('api/vote_stages.php');
const votesApi = read('api/vote_votes.php');
const matchesApi = read('api/vote_matches.php');
const sourcesApi = read('api/vote_sources.php');
const managerJs = read('js/club-project-manager.js');
const moeJs = read('js/moe-contest.js');
const twelveDetailJs = read('twelve/twelve-detail.js');
const moeDetailHtml = read('moe/contest.html');
const moeDetailJs = read('moe/moe-detail.js');
const moeDetailCss = read('moe/moe-detail.css');
const moeBracketHtml = read('moe/bracket.html');
const moeBracketJs = read('moe/moe-bracket.js');
const twelveJs = read('js/twelve-contest.js');
const vndbProxy = read('api/vndb_proxy.php');
const settlementCli = read('scripts/settle-moe-contests.php');

[
  'vote_flow_runs',
  'vote_flow_pools',
  'vote_flow_pool_entries',
  'vote_flow_results',
  'vote_flow_matches',
  'vote_flow_events',
].forEach((table) => {
  assert.ok(core.includes(table), `new post-nomination flow should define ${table}`);
});

assert.ok(core.includes('function voteFlowRebuildFromNominationAndOpen'), 'core should expose one atomic nomination-to-qualifier command');
assert.ok(core.includes('bool $forceRebuild = false'), 'atomic rebuild should default to idempotent reuse');
assert.ok(core.includes('voteFlowPoolForStage($db, (int)$qualifier'), 'atomic rebuild should check for an existing qualifier flow pool');
assert.ok(core.includes("'existing' => true"), 'atomic rebuild should report when it reused an existing qualifier pool');
assert.ok(core.includes("entry_status = 'approved'"), 'atomic rebuild should only read approved nominations');
assert.ok(core.includes('voteFlowSeedPoolEntries($db, $pool, $entryIds'), 'atomic rebuild should seed vote_flow_pool_entries');
assert.ok(core.includes('voteFlowPoolEntryCount($db, (int)$pool'), 'atomic rebuild should read back the generated flow pool');
assert.ok(core.includes('FLOW_POOL_READBACK_MISMATCH'), 'atomic rebuild should fail if seeded and readback counts diverge');
assert.ok(core.includes("UPDATE vote_flow_pools SET status = 'open'"), 'atomic rebuild should open the qualifier pool in the same transaction');
assert.ok(core.includes("UPDATE vote_stages SET status = 'open'"), 'atomic rebuild should open the qualifier stage in the same transaction');
assert.ok(core.includes('starts_at = COALESCE(starts_at'), 'flow stage openings should record the first actual open time without overwriting a scheduled start');
assert.ok(core.includes("UPDATE vote_flow_runs SET status = 'archived'"), 'rebuild should archive the previous active flow run');
assert.ok(core.includes("eventType") || core.includes('rebuild_from_nomination_and_open'), 'atomic rebuild should write a flow event');

assert.ok(stagesApi.includes("case 'rebuild_from_nomination_and_open'"), 'stage API should expose rebuild_from_nomination_and_open');
assert.ok(stagesApi.includes('voteFlowRebuildFromNominationAndOpen($db, $project'), 'stage API should call the atomic flow command');
assert.ok(stagesApi.includes('force_rebuild'), 'stage API should require an explicit force flag for rebuilds');
assert.ok(stagesApi.includes("'readback_count'"), 'stage API should return readback_count');
assert.ok(stagesApi.includes("'pool_id'") && stagesApi.includes("'stage_id'"), 'stage API should return pool and stage identifiers');
assert.ok(stagesApi.includes("'qualifier_stage_id'"), 'stage API should return the qualifier stage id');
assert.ok(stagesApi.includes("case 'advance_from_nomination'"), 'legacy one-click action should remain compatible');
assert.ok(stagesApi.includes('starts_at = COALESCE(starts_at'), 'stage API openings should record the first actual open time without overwriting a scheduled start');
assert.ok(stagesApi.includes("case 'flow_status'"), 'stage API should expose flow_status');
assert.ok(stagesApi.includes("case 'stage_entries'"), 'stage API should expose stage_entries');
assert.ok(stagesApi.includes("'pool_status' => 'missing'"), 'stage_entries should clearly report a missing flow pool');
assert.ok(stagesApi.includes('阶段池尚未生成，请联系负责人'), 'empty flow pools should have an explicit operator-facing message');
assert.ok(stagesApi.includes("'code' => 'STAGE_POOL_NOT_GENERATED'"), 'ordinary open should reject post-nomination stages without a flow pool');
assert.ok(stagesApi.includes("($stage['stage_type'] ?? '') !== 'nomination'"), 'ordinary open should only allow nomination stages without a flow pool');

const missingPoolIndex = stagesApi.indexOf("'pool_status' => 'missing'");
const oldStageEntryFallbackIndex = stagesApi.indexOf('FROM vote_stage_entries vse');
assert.ok(missingPoolIndex >= 0, 'stage_entries should include a missing flow-pool response');
assert.ok(oldStageEntryFallbackIndex === -1 || missingPoolIndex < oldStageEntryFallbackIndex, 'stage_entries should return the flow-pool missing response before any legacy stage-entry fallback can run');

assert.ok(votesApi.includes('vote_flow_pool_entries'), 'public voting should validate candidates against flow pool entries');
assert.ok(votesApi.includes('vote_flow_matches'), 'match voting should validate candidates against flow matches');
assert.ok(votesApi.includes("'match_results'") && votesApi.includes('slot_a_votes') && votesApi.includes('slot_b_votes'), 'results API should expose per-match vote counts');
assert.ok(votesApi.includes('result_visibility'), 'results API should return result visibility for frontend display rules');
assert.ok(matchesApi.includes('voteFlowGenerateMatches'), 'moe match generation should use flow pools');
assert.ok(matchesApi.includes('voteFlowSettleMatch'), 'moe match settling should use flow matches');
assert.ok(matchesApi.includes("case 'settle_by_votes'"), 'match API should support manager-triggered vote-count settlement');
assert.ok(matchesApi.includes("status = 'open'"), 'vote-count settlement should only process open matches');
assert.ok(core.includes('voteFlowOpenNextReadyMatches') && core.includes("status = 'open'"), 'flow matches should open the next ready round after settlement');
assert.ok(core.includes('voteFlowRankRowsForPool') && core.includes('group_advance_count'), 'flow settlement should support grouped qualifier advancement');
assert.ok(core.includes('generate_final_matches'), 'moe final generation should create explicit champion and third-place matches');

assert.ok(managerJs.includes("action=rebuild_from_nomination_and_open"), 'manager should call the atomic rebuild-and-open API');
assert.ok(managerJs.includes('rebuildFlowInFlight'), 'manager should ignore repeated rebuild clicks while a request is in flight');
assert.ok(managerJs.includes('boundRebuildFlow'), 'manager should prevent duplicate rebuild button bindings');
assert.ok(managerJs.includes('seeded !== readback') && managerJs.includes('seeded !== entries.length'), 'manager should verify backend write count against frontend read count');
assert.ok(managerJs.includes('海选池生成异常'), 'manager should surface count mismatches instead of pretending success');
assert.ok(managerJs.includes('生成海选池并打开海选'), 'manager should expose the one-click nomination-to-qualifier action');
assert.equal((managerJs.match(/function renderPoolContent\(/g) || []).length, 1, 'manager should keep a single active pool renderer');
assert.ok(!managerJs.includes('copy.entry_id = Number(entry.id)'), 'manager should not hydrate qualifier entries from nominations on the client');
assert.ok(!managerJs.includes('[data-advance-from-nomination]'), 'manager should not bind the deprecated nomination advancement button');
assert.ok(!managerJs.includes('function advanceFromNomination'), 'manager should not keep the deprecated nomination advancement function');
assert.ok(managerJs.includes('action=flow_status'), 'manager should refresh flow_status after operations');
assert.ok(managerJs.includes('loadStageEntries(qualifierId)'), 'manager should reread stage_entries after generation');
assert.ok(managerJs.includes("var canUseLegacySettlement = s.stage_type !== 'nomination';") && managerJs.includes("canUseLegacySettlement && s.status !== 'reviewing'"), 'manager should not expose legacy settle actions for nomination stages');
assert.ok(managerJs.includes("if (stage.stage_type === 'nomination')") && managerJs.includes('data-rebuild-flow') && managerJs.includes('生成海选池并打开海选'), 'manager should expose an actionable nomination handoff instead of direct stage settlement');

assert.ok(moeJs.includes('moe_stages.php?action=stage_entries'), 'moe page should read candidates from stage_entries compatibility API');
assert.ok(twelveJs.includes('twelve_rounds.php?action=stage_entries'), 'twelve page should read candidates from stage_entries compatibility API');
assert.ok(moeJs.includes('moe_votes.php?action=results'), 'moe page should load vote statistics');
assert.ok(twelveJs.includes('twelve_votes.php?action=results'), 'twelve page should load vote statistics');
assert.ok(twelveJs.includes('renderScoreVoting') && twelveJs.includes('tw-score-input') && twelveJs.includes('payload.scores'), 'twelve page should support top-N score voting with score payloads');
assert.ok(twelveJs.includes('最终十二器排行榜') && twelveJs.includes('rows = rows.slice(0, 12)'), 'twelve final results should render a top-12 leaderboard');
assert.ok(!twelveJs.includes('vote_matches.php?action=list'), 'twelve page should not use bracket match APIs');
assert.ok(moeJs.includes('currentOpenRoundMatches') && moeJs.includes("m.status === 'open'") && moeJs.includes('matchHasBothSlots'), 'moe bracket page should vote only on the current open round with complete slots');
assert.ok(moeJs.includes('请选择本轮全部对阵') && moeJs.includes('requiredMatches.length'), 'moe bracket submit should require only the current round');
assert.ok(moeJs.includes('renderReadonlyMatchSummary'), 'moe bracket page should show settled and future matches as a read-only schedule');
assert.ok(managerJs.includes('allowedVoteModesForStage'), 'manager stage editor should restrict vote modes by stage type');
assert.ok(managerJs.includes('live_votes') && managerJs.includes('after_event'), 'manager stage editor should expose all result visibility options');
assert.ok(managerJs.includes('settle_by_votes'), 'manager should expose vote-count match settlement');
assert.ok(managerJs.includes('loadMoeMatchesForStages') && managerJs.includes("stage.stage_type === 'final'"), 'manager should load bracket and final match lists for the active workbench stage');
assert.ok(managerJs.includes('lastSettleIssues') && managerJs.includes('平票/缺槽'), 'manager should surface unresolved match settlement issues');
assert.ok(
  managerJs.includes('mfEndsAt')
    && !managerJs.includes('checkTimedSettle')
    && !managerJs.includes('timedSettleTimer'),
  'manager should edit ends_at without retaining page-driven settlement polling'
);
assert.ok(settlementCli.includes("PHP_SAPI !== 'cli'") && settlementCli.includes('voteFlowSettleOpenMatchesByVotes') && settlementCli.includes('flock'), 'CLI settlement should be exclusive, idempotent, and handle match pools');
assert.ok(core.includes("'rule_version' => 2") && core.includes("'group_ticket_scope' => 'per_group'"), 'new moe pools should snapshot rule version 2 and per-group tickets');
assert.ok(core.includes('score_total') && core.includes('rating_count') && core.includes('voteFlowResolvePoolTie'), 'flow results should persist score metrics and support manual tie resolution');
assert.ok(stagesApi.includes('update_and_rebuild') && stagesApi.includes('POOL_HAS_ACTIVITY'), 'stage API should expose atomic no-data rebuild and reject active pools');
assert.ok(votesApi.includes('rank_visible') && votesApi.includes('metrics_visible') && votesApi.includes('voteTrimMoeResultRows'), 'results API should enforce rank and metric visibility');
assert.ok(twelveDetailJs.includes('vote_sources.php?action=search&project_type=twelve') && twelveDetailJs.includes("work.source_type || 'manual'") && twelveDetailJs.includes('sourceLabelVote(work.source_type)'), 'twelve detail nomination search should use unified Bangumi/VNDB source search and preserve source type');
assert.ok(twelveJs.includes('vote_sources.php?action=search&project_type=twelve') && twelveJs.includes("work.source_type || 'manual'") && twelveJs.includes('sourceLabelVote(work.source_type)'), 'legacy twelve contest nomination search should use unified Bangumi/VNDB source search and preserve source type');
assert.ok(sourcesApi.includes('https://api.vndb.org/kana/vn') && sourcesApi.includes("'source_type' => 'vndb_vn'") && sourcesApi.includes("['search', '=', $keyword]"), 'vote source API should query VNDB Kana API for twelve works');
assert.ok(vndbProxy.includes('ignore_errors') && vndbProxy.includes("'_error'") && vndbProxy.includes('https://api.vndb.org/kana/vn'), 'VNDB standalone proxy should surface upstream failures instead of silently returning empty data');
assert.ok(moeJs.includes('renderScoreVoting') && moeJs.includes('mo-score-input') && moeJs.includes('group_rank'), 'moe page should support grouped score voting and grouped results');
assert.ok(moeDetailHtml.includes('id="mdBracketLink"') && moeDetailJs.includes('bracket.html?project_id='), 'moe detail page should link to the standalone live bracket board by project id');
assert.ok(moeDetailHtml.includes('活动启动') && moeDetailHtml.includes('id="mdInfoLaunch"') && moeDetailHtml.includes('阶段开始'), 'moe detail should expose activity launch and stage start as separate fields');
assert.ok(moeDetailJs.includes('data.data.published_at') && moeDetailJs.includes('fmtDate(stage.starts_at)') && moeDetailJs.includes('fmtDate(stage.ends_at)'), 'moe detail should keep published_at separate from stage scheduling');
assert.ok(moeDetailHtml.includes('<ol class="md-stage-list"') && moeDetailJs.includes('md-stage-step') && moeDetailJs.includes('aria-current'), 'moe detail should render semantic fishbone stage steps');
assert.ok(moeDetailJs.includes('md-inline-spinner') && !/btn\.innerHTML\s*=\s*[^;]*md-loading/.test(moeDetailJs) && moeDetailCss.includes('.md-inline-spinner'), 'moe detail search should use a dedicated inline spinner instead of the full loading region');
assert.ok(moeDetailJs.includes('data-selectable') && moeDetailJs.includes('entryIdOf') && moeDetailJs.includes('toggleNominationSelection'), 'moe detail selection mode should normalize and select owned entries');
assert.ok(moeDetailCss.includes('.md-stage-step:not(:last-child)::after') && moeDetailCss.includes('body.md-select-mode .md-char-item:not([data-selectable="true"])'), 'moe detail CSS should provide fishbone connectors and selection-mode weakening');
assert.ok(moeBracketHtml.includes('moe-bracket.css') && moeBracketHtml.includes('moe-bracket.js'), 'standalone bracket page should use dedicated bracket assets');
assert.ok(moeBracketJs.includes("params.get('project_id')") && moeBracketJs.includes("params.get('id')") && moeBracketJs.includes("params.get('contest_id')"), 'standalone bracket page should accept project_id, id, and contest_id');
assert.ok(moeBracketJs.includes('moe_contests.php?action=get') && moeBracketJs.includes('moe_stages.php?action=list') && moeBracketJs.includes('moe_matches.php?action=list') && moeBracketJs.includes('moe_votes.php?action=results'), 'standalone bracket page should load real contest, stage, match, and result APIs');
assert.ok(moeBracketJs.includes("stage.status === 'open'") && moeBracketJs.includes('matches.length'), 'standalone bracket page should choose open bracket/final stages before falling back to stages with generated matches');
assert.ok(moeBracketJs.includes('result.rank_visible') && moeBracketJs.includes('result.metrics_visible'), 'standalone bracket page should obey backend result visibility for winners and vote counts');
assert.ok(!moeBracketJs.includes('古河渚') && !moeBracketJs.includes('2026 夏季萌战'), 'standalone bracket page should not retain Open Design sample entrants or sample titles');
assert.ok(managerJs.includes('renderMoeAwardsFromResults') && managerJs.includes("club_moe_king.php?action=set"), 'manager should fill final awards from results and sync champion to moe king');
assert.ok(votesApi.includes('score_avg DESC, votes DESC'), 'results API should order live score stages by average score before vote count');
assert.ok(moeJs.includes('阶段池尚未生成，请联系负责人') || moeJs.includes('闃舵姹犲皻鏈敓鎴愶紝璇疯仈绯昏礋璐ｄ汉'), 'moe page should explain missing pools');
assert.ok(twelveJs.includes('阶段池尚未生成，请联系负责人') || twelveJs.includes('闃舵姹犲皻鏈敓鎴愶紝璇疯仈绯昏礋璐ｄ汉'), 'twelve page should explain missing pools');

console.log('stable vote flow contract checks passed');
