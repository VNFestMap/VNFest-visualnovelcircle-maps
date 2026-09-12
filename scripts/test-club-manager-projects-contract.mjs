import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const projects = fs.readFileSync(path.join(root, 'club-manager-react', 'src', 'tabs', 'ProjectsTab.jsx'), 'utf8');
const api = fs.readFileSync(path.join(root, 'api', 'projects.php'), 'utf8');
const hub = fs.readFileSync(path.join(root, 'includes', 'project_hub.php'), 'utf8');

/* ========== 端点与请求体 ========== */
for (const endpoint of ['projects.php', 'project_items.php', 'project_participations.php', 'club_avatar.php?scope=event']) {
  assert.ok(projects.includes(endpoint), `project hub should call ${endpoint}`);
}
assert.ok(projects.includes("'projects.php?include_deleted=1'"), 'projects should be requested with include_deleted');
assert.ok(projects.includes("'project_items.php?include_deleted=1'"), 'items should be requested with include_deleted');
assert.ok(projects.includes("'project_participations.php?include_withdrawn=1'"), 'participations should be requested with include_withdrawn');
assert.match(projects, /ph_method: 'PUT'/, 'updates should keep the ph_method POST override');
assert.match(projects, /ph_method: 'DELETE'/, 'deletes should keep the ph_method POST override');
assert.match(projects, /ph_method: 'PUT'[\s\S]*review_note/, 'participation review should send status plus a review note');
assert.match(projects, /organizer_club: organizer/, 'new projects should send the organizer club');
assert.match(projects, /is_joint: participant_clubs\.length > 0/, 'joint mode should be derived from the participant list');
assert.match(projects, /form\.append\('id', `project_\$\{projectEditor\?\.id \|\| Date\.now\(\)\}`\)/, 'the poster upload id must keep the project_ prefix convention');
assert.match(projects, /form\.append\('country', selected\.country\)/, 'the poster upload must send the club country');

/* ========== 服务端字段名兼容（不得重命名字段） ========== */
assert.match(hub, /\$value\['id'\] \?\? \$value\['club_id'\]/, 'the API resolves participant ids from id or club_id');
assert.match(projects, /club: \{ id, country, name \}/, 'participant payloads should keep the original id/country/name shape');

/* ========== 软删除与撤回记录不得渲染 ========== */
assert.match(projects, /\.filter\(\(project\) => !project\.deleted_at\)/, 'soft-deleted projects must be filtered out at load');
assert.match(projects, /\.filter\(\(item\) => !item\.deleted_at\)/, 'soft-deleted items must be filtered out at load');
assert.match(projects, /if \(project\.deleted_at\) return false;/, 'the related filter must also drop soft-deleted projects');
assert.match(projects, /item\.status !== 'withdrawn'/, 'withdrawn participations must stay out of the review list');

/* ========== 发起方权限 ========== */
assert.match(projects, /const organizerIdOf = \(project\) => clubIdOf\(project\?\.organizer_club\) \|\| Number\(project\?\.organizer_club_id \|\| 0\)/, 'organizer id must resolve from organizer_club or the flat fallback');
assert.match(projects, /const organizerCountryOf = \(project\) => \(project\?\.organizer_club/, 'organizer country must resolve from organizer_club or the flat fallback');
assert.match(projects, /const canManageSelected = Boolean\(selectedProject\) && Number\(organizerIdOf\(selectedProject\)\) === selected\.clubId/, 'edit/delete must require the club to be the organizer');
assert.match(projects, /canManageSelected && <Space size=\{6\}><Button size="small" icon=\{<EditOutlined \/>\}/, 'the edit/delete toolbar must be organizer-gated');
assert.match(projects, /!canManageSelected && <Tag className="cm-project-chip">联合参加视图<\/Tag>/, 'non-organizers must see the joint-participation view marker');
assert.match(projects, /canManageSelected \? \[<Button type="link" onClick=\{\(\) => openItem\(item\)\}/, 'item edit/delete must be organizer-gated');
assert.match(projects, /canManageSelected && PENDING_STATUSES\.includes\(entry\.status \|\| 'submitted'\)/, 'participation review actions must be organizer-gated');
assert.match(projects, /const PENDING_STATUSES = \['submitted', 'reviewing'\]/, 'only submitted/reviewing participations are reviewable');

/* ========== 「所有同好会」必须要求选定具体同好会 ========== */
assert.match(projects, /const CLUB_REQUIRED = '请先在上方选择一个同好会，再进入企划枢纽。'/, 'the club-required prompt must keep the original wording');
assert.match(projects, /if \(!hasClub\) return <section className="cm-page" data-component="同好会企划枢纽">/, 'the aggregate club option must render the prompt instead of every project');
assert.match(projects, /\.filter\(\(club\) => clubKey\(clubIdOf\(club\), clubCountryOf\(club\)\) !== selectedKey\)/, 'joint options must exclude the selected club itself');

/* ========== 筛选 / KPI / 日历同步 ========== */
assert.match(projects, /const \[type, setType\] = useState\('all'\)/, 'the type filter must be available');
assert.match(projects, /aria-label="按类型筛选"/, 'the type filter must be reachable from the UI');
assert.match(projects, /\(type === 'all' \|\| project\.project_type === type\)/, 'the type filter must narrow the list');
assert.ok(projects.includes('关联企划') && projects.includes('活动企划') && projects.includes('待审核') && projects.includes('联合企划'), 'the KPI row must keep the four original counters');
assert.match(projects, /const projectSyncLabel = \(project\) => \{[\s\S]*非活动企划[\s\S]*未同步：缺少日期[\s\S]*日历 #[\s\S]*等待同步/, 'the calendar-sync label must keep the original states');
assert.ok(projects.includes('日历同步'), 'the detail view must show the calendar sync state');

/* ========== 宣传图客户端校验（与原实现一致） ========== */
assert.match(projects, /const POSTER_TYPES = \['image\/jpeg', 'image\/png', 'image\/gif', 'image\/webp'\]/, 'poster uploads must keep the image type whitelist');
assert.match(projects, /const POSTER_MAX_BYTES = 2 \* 1024 \* 1024/, 'poster uploads must keep the 2MB cap');
assert.match(projects, /if \(file\.size > POSTER_MAX_BYTES\)/, 'the 2MB cap must be enforced before uploading');

/* ========== 标签文案 ========== */
assert.match(projects, /other: '其他企划'/, 'the project type label must keep the original wording');
assert.match(projects, /submitted: '待审核'/, 'the participation status label must keep the original wording');
assert.doesNotMatch(projects, /innerHTML|dangerouslySetInnerHTML/, 'project rendering must not build HTML strings');

/* ========== 后端契约未变 ========== */
assert.match(api, /projectHubNormalizeClubs\(\$input\['participant_clubs'\] \?\? \[\]\)/, 'the API still normalises participant_clubs');
assert.match(api, /'is_joint' => !empty\(\$input\['is_joint'\]\)/, 'the API still stores is_joint from the request');

console.log('club manager project hub contract tests passed');
