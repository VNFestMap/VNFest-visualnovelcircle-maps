import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const clubManager = readFileSync(new URL('../club-manager-react/src/tabs/MembershipsTab.jsx', import.meta.url), 'utf8');
const reviews = readFileSync(new URL('../admin/reviews.html', import.meta.url), 'utf8');
const membershipApi = readFileSync(new URL('../api/membership.php', import.meta.url), 'utf8');
const usersApi = readFileSync(new URL('../api/users.php', import.meta.url), 'utf8');

/* ========== club_manager.html: 新申请在上、旧申请在下 ========== */
assert.match(clubManager, /mode === 'pending'[\s\S]*mode === 'diplomatic'/, 'club manager should handle the three review tabs');
assert.match(clubManager, /String\(b\.joined_at[\s\S]*localeCompare\(String\(a\.joined_at/, 'club manager should sort newest joined_at first');
assert.match(clubManager, /申请时间[\s\S]*joined_at/, 'club manager cards should keep showing application time');

/* ========== reviews.html: 用户管理 API 对齐 ========== */
assert.match(reviews, /\.\.\/api\/users\.php\?action=stats/, 'reviews should load user KPIs from users.php stats');
assert.match(reviews, /\.\.\/api\/users\.php\?action=list&/, 'reviews should load the user table from users.php list');
assert.match(reviews, /function updateUserRole/, 'reviews should update user roles through users.php');
assert.match(reviews, /function banUser/, 'reviews should ban users through users.php delete');
assert.match(reviews, /function unbanUser/, 'reviews should unban users through users.php update');
assert.match(reviews, /data-module="users"[\s\S]*data-module="logs"/, 'reviews nav should include users and logs modules');
assert.match(reviews, /isSuperAdmin \? '' : 'none'/, 'reviews should hide super-admin-only modules from other roles');

/* ========== reviews.html: 同好会总览 成员数 + 查看成员 ========== */
assert.match(reviews, /\.\.\/api\/membership\.php\?action=club_member_counts/, 'reviews should load per-club member counts');
assert.match(reviews, /c\.member_count = data\.counts\[c\.id \+ ':(china|japan)'\] \|\| 0/, 'reviews should merge member counts by club id and country');
assert.match(reviews, /function openClubMembersModal/, 'reviews should implement the view-members modal');
assert.match(reviews, /\.\.\/api\/membership\.php\?action=members&club_id=/, 'reviews should load members from membership.php members');
assert.ok(reviews.includes('暂无成员'), 'reviews member modal should handle empty rosters');

/* ========== reviews.html: 操作日志 API 对齐 ========== */
assert.match(reviews, /\.\.\/api\/admin_logs\.php\?/, 'reviews should load operation logs from admin_logs.php');
assert.match(reviews, /const qs = 'action=list&page='[\s\S]*'&per_page='[\s\S]*'&type='/, 'reviews should pass pagination and type filters to the logs API');
assert.match(reviews, /function logTypeLabel/, 'reviews should classify log types');
assert.match(reviews, /<th>时间<\/th>[\s\S]*<th>检测到的操作<\/th>[\s\S]*<th>结果 \/ 影响<\/th>/, 'reviews logs table should include an explanation column');
assert.match(reviews, /l\.definition\.label/, 'reviews should render a readable explanation for every log row');
assert.match(reviews, /function showLogDetail/, 'reviews should open a per-entry explanation dialog');
assert.match(reviews, /log-detail-button/, 'reviews should expose a per-row explanation trigger');
assert.match(reviews, /function detailKeyText/, 'reviews should carry a detail-key dictionary');
assert.match(reviews, /old_role: '原角色'/, 'reviews explanations should enrich role changes');
assert.match(reviews, /function formatLogTarget/, 'reviews should render the affected target');

/* ========== 后端 API ========== */
assert.match(membershipApi, /case 'club_member_counts':/, 'membership API should expose per-club member counts');
assert.match(usersApi, /case 'stats':/, 'users API should expose user stats');
assert.ok(existsSync(new URL('../api/admin_logs.php', import.meta.url)), 'admin_logs API file should exist');
const adminLogs = readFileSync(new URL('../api/admin_logs.php', import.meta.url), 'utf8');
assert.match(adminLogs, /role'\] !== 'super_admin'/, 'admin_logs API should be super-admin only');
assert.match(adminLogs, /ORDER BY al\.created_at DESC/, 'admin_logs API should list newest logs first');
assert.match(adminLogs, /\$action !== 'list'/, 'admin_logs API should expose the list action');

console.log('admin console contract ok');
