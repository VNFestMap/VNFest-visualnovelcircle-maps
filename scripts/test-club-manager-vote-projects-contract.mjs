import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const model = read('club-manager-react/src/model.js');
const app = read('club-manager-react/src/App.jsx');
const shell = read('club-manager-react/src/Shell.jsx');
const tab = read('club-manager-react/src/tabs/VoteProjectsTab.jsx');
const genericProjects = read('club-manager-react/src/tabs/ProjectsTab.jsx');
const legacy = read('admin/club_project_manager.html');

assert.match(model, /key: 'vote_projects', label: '赛事活动'/, 'the admin model must register the vote-projects tab');
assert.match(app, /VoteProjectsTab/, 'the app must lazy-load the vote-projects tab');
assert.match(app, /vote_projects: VoteProjectsTab/, 'the app must render the vote-projects tab');
assert.match(shell, /vote_projects: <TrophyOutlined \/>/, 'the sidebar must have a vote-projects icon');

for (const endpoint of [
  'vote_projects.php?action=my_manageable',
  'vote_projects.php?action=get',
  'vote_projects.php?action=create',
  'vote_projects.php?action=update',
  'vote_projects.php?action=share',
  'vote_nominations.php?action=list',
  'vote_stages.php?action=flow_status',
  'vote_stages.php?action=stage_entries',
  'vote_stages.php?action=rebuild_from_nomination_and_open',
  'vote_matches.php?action=list',
  'vote_votes.php?action=results',
  'club_moe_king.php?action=set',
]) {
  assert.ok(tab.includes(endpoint), `赛事活动必须继续使用 ${endpoint}`);
}
for (const action of ['publish', 'archive', 'delete', 'remove', 'restore', 'update_and_rebuild', 'resolve_flow_tie', 'resolve_tie', 'generate_matches', 'settle', 'settle_by_votes']) {
  assert.ok(tab.includes(action), `赛事活动必须保留 ${action} 操作`);
}
assert.match(tab, /vote_matches\.php\?action=\$\{action === 'generate_matches' \? 'generate' : action\}/, 'match generation must keep the legacy generate API action');
assert.match(tab, /const flowRequest = request\(`vote_stages\.php\?action=flow_status&project_id=\$\{encodeURIComponent\(id\)\}`\)\.catch\(\(flowError\) => \(\{/, 'a missing flow-status endpoint must not make the entire activity detail fail');
assert.match(tab, /flowUnavailable: Boolean\(flow\.error\)/, 'the UI must preserve a visible degraded-flow state rather than pretending the workflow loaded');
assert.match(tab, /流程工作台暂不可用/, 'the workflow tab must explain the recoverable server compatibility state');

for (const phrase of ['萌战', '十二器', '活动标题', '年份', '可见性', '参与资格', '默认结果显示', '允许分享链接免登录投票', '阶段标题', '投票模式', '晋级数量', '截止时间', '每人可提名数量', '每人最多选择', '分组数量', '评分下限', '评分上限', '结果显示', '允许改票', '零票补位', '生成海选池', '锁定', '提名池', '阶段池', '赛程流水线', '流程工作台暂不可用', '处理流程平票', '对阵工作台', '同步萌王']) {
  assert.ok(tab.includes(phrase), `赛事活动界面缺少 ${phrase}`);
}

for (const area of ['概览与设置', '赛程工作台', '结果与奖项']) {
  assert.ok(tab.includes(area), `赛事活动必须保留 ${area} 区域`);
}
assert.ok(tab.includes('const detailItems = ['), 'detail navigation must use the three-area hybrid layout');
assert.match(tab, /ProjectEditorForm/, 'creation and activity settings must be inline forms');
assert.match(tab, /StageEditorInline/, 'stage editing must be inline');
assert.doesNotMatch(tab, /ProjectEditorModal|StageEditorModal/, 'the main activity and stage editors must not remain modal editors');
assert.match(tab, /vote-project-selected-\$\{selectedProject\.id\}/, 'selected nomination state must be persisted per activity');
assert.ok(tab.includes('setExpanded(true)'), 'nomination pool must support expanding all entries');
assert.match(tab, /filter === 'removed'/, 'nomination pool must expose the removed filter');
assert.match(tab, /group_key/, 'stage pool must expose group filtering');
assert.match(tab, /MatchWorkbench/, 'bracket and final stages must render the match workbench');

assert.match(tab, /can_manage/, 'the UI must consume the API can_manage permission result');
assert.match(tab, /canManageProject/, 'project actions must be gated by the effective management permission');
assert.match(tab, /Modal\.confirm/, 'destructive and state-changing operations must require confirmation');
assert.match(tab, /confirmLoading/, 'modal operations must expose an in-flight state');
assert.match(tab, /disabled=\{!canManage/, 'management controls must be disabled for read-only projects');
assert.doesNotMatch(tab, /innerHTML|dangerouslySetInnerHTML/, 'the React migration must not copy string-template rendering');

assert.match(tab, /selected\.clubId <= 0 \|\|/, 'project data must be filtered by the selected club');
assert.match(tab, /club\.all/, 'super administrators must be able to use the all-clubs selection');
assert.match(tab, /parseClubKey\(value\)/, 'club association selection must parse the pipe-delimited club key');
assert.doesNotMatch(tab, /value\.split\('\:'\)/, 'club association selection must not split the pipe-delimited key on a colon');
assert.match(tab, /update_and_rebuild/, 'core stage changes must use the atomic rebuild endpoint');
assert.match(tab, /hasPool && coreChanged/, 'only core changes with an existing pool may request a rebuild');

assert.match(genericProjects, /projects\.php/, 'the generic project hub must remain in its original data model');
assert.match(model, /key: 'projects', label: '企划枢纽'/, 'the generic project hub tab must remain registered');
assert.match(legacy, /club_manager\.html\?tab=vote_projects/, 'the old project-manager page must redirect to the new tab');
assert.match(legacy, /<a href="\.\/club_manager\.html\?tab=vote_projects">/, 'the old project-manager page must keep a visible no-script fallback link');

console.log('club manager vote-projects contract tests passed');
