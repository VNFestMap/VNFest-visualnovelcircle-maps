import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const index = read('index.html');
const app = read('js/app.js');
const siteHeader = read('js/site-header.js');
const account = read('user-v2-react/src/App.jsx');
const i18n = read('js/page-i18n.js');
const column = read('column-react/src/main.jsx');
const square = read('club_square.html');
const share = read('club_share.html');

assert.equal((index.match(/class="top-admin-btn" href="\.\/column\/" data-space-entry="true" style="display:none;">空间/g) || []).length, 2, 'map and list headers must each expose one hidden 空间 link');
assert.doesNotMatch(index, /data-action="forum"/, 'the main site must not keep the duplicate forum/dynamic action');
assert.doesNotMatch(index, /同好会动态/, 'the main site must use 空间 for the unified entry');
assert.doesNotMatch(index, /club_square\.html/, 'the main site must not point at the legacy activity shell');
assert.match(app, /window\.location\.href = '\.\/column\/'/, 'main-site column navigation must target the space root');
assert.doesNotMatch(app, /club_square\.html/, 'app navigation must not point at the legacy activity shell');
assert.match(app, /data-space-entry/, 'map navigation must mark space entries');
assert.match(app, /hasRole\('member'\)/, 'map navigation must use the effective member role');
assert.match(account, /spaceMemberOnly: true/, 'account quick access must be member-only');
assert.match(account, /canEnterSpace/, 'account quick access must use system or active membership role');
assert.match(account, /canEnterSpace=\{canEnterSpace\}/, 'overview must receive the space access predicate explicitly');
assert.match(account, /function OverviewPage\(\{[^}]*canEnterSpace[^}]*\}\)/s, 'overview must declare the space access predicate in its props');
assert.match(siteHeader, /gateSpaceEntries/, 'shared page header must gate space links');
assert.ok(siteHeader.includes('column(?:\\/|$)'), 'shared page header must recognize column links');

assert.match(column, /\/column\/\?tab=activity/, 'the space must expose the activity route');
assert.match(column, /活动/, 'the React space must expose the activity label');
assert.match(column, /key: 'activity'.*path: '\/column\/\?tab=activity'/s, 'activity must be a primary left-nav item');
assert.doesNotMatch(column, /pt-section-tab/, 'activity must not be split into a center tab bar');
assert.match(index, /topAdminBtn[^>]+club_manager\.html\?tab=(?:pending|vote_projects)/, 'map admin entry must keep a valid club manager target');
assert.match(index, /listAdminBtn[^>]+club_manager\.html\?tab=(?:pending|vote_projects)/, 'list admin entry must keep a valid club manager target');
assert.doesNotMatch(square, /meta http-equiv="refresh"[^>]+column\/\?tab=activity/i, 'club_square must not unconditionally redirect');
assert.match(square, /space_access/, 'club_square must check the bootstrap space access result');
assert.match(square, /location\.replace\('\.\/column\/\?tab=activity'\)/, 'club_square must use an automatic client-side redirect');
assert.match(square, /spaceGateLink/, 'club_square must keep a visible access/return fallback');
assert.match(share, /href="\.\/column\/\?tab=activity"/, 'club share activity entry must use the new activity tab');

for (const [key, value] of [['空间', 'スペース'], ['活动', 'イベント'], ['赛事活动', 'イベント管理'], ['进行中', '開催中']]) {
  assert.match(i18n, new RegExp(`'${key}': '${value}'`), `Japanese translation missing for ${key}`);
}

console.log('space navigation contract tests passed');
