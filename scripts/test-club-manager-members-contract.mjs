import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'admin', 'club_manager.html'), 'utf8');

assert.match(source, /<div class="card member-card">/, 'member renderer should use a dedicated member card class');
assert.match(source, /<div class="member-head">[\s\S]*member-info[\s\S]*member-details[\s\S]*member-role/, 'member card should have an identity head with role');
assert.match(source, /<div class="member-actions">/, 'member card should have a dedicated actions region');
assert.match(source, /const memberDetailFields = \[/, 'member details should be rendered from structured fields');

for (const label of ['昵称', '邮箱', 'QQ', '申请身份', '学生', '加入于']) {
  assert.match(source, new RegExp(`label: '${label}'`), `member details should keep the ${label} field`);
}

assert.match(source, /isSuperAdmin && m\.email/, 'email visibility should remain limited to super admins');
assert.match(source, /isSuperAdmin && m\.qq_account/, 'QQ visibility should remain limited to super admins');
assert.match(source, /isSuperAdmin && m\.apply_role/, 'application role visibility should remain limited to super admins');
assert.match(source, /isSuperAdmin && typeof m\.is_student !== 'undefined'/, 'student status visibility should remain limited to super admins');
assert.match(source, /changeMemberRole\(/, 'role change actions should remain available through the existing handler');
assert.match(source, /setMembershipApplicationEmailRecipient\(/, 'email recipient action should remain available through the existing handler');
assert.match(source, /transferRepresentative\(/, 'transfer action should remain available through the existing handler');
assert.match(source, /kickMember\(/, 'kick action should remain available through the existing handler');

const tabletStart = source.indexOf('@media (max-width: 899px) {');
const mobileStart = source.indexOf('@media (max-width: 640px) {', tabletStart + 1);
const narrowMobileStart = source.indexOf('@media (max-width: 380px) {', mobileStart + 1);
const tabletCss = tabletStart >= 0 && mobileStart > tabletStart ? source.slice(tabletStart, mobileStart) : '';
assert.match(tabletCss, /\.member-item\s*\{[^}]*flex-wrap:\s*wrap/, 'tablet member rows should wrap instead of overflowing');
assert.match(tabletCss, /\.member-actions\s*\{[^}]*width:\s*100%/, 'tablet actions should occupy a full wrapping row');

const mobileCss = mobileStart >= 0 && narrowMobileStart > mobileStart ? source.slice(mobileStart, narrowMobileStart) : '';
assert.match(mobileCss, /\.member-item\s*\{[^}]*flex-direction:\s*column/, 'mobile member cards should use a vertical layout');
assert.match(mobileCss, /\.member-details\s*\{[^}]*display:\s*grid/, 'mobile member details should use a field grid');
assert.match(mobileCss, /\.member-actions\s*> \*\s*\{[^}]*min-height:\s*44px/, 'mobile member actions should have touch-friendly targets');
assert.match(mobileCss, /\.member-actions\s*> \*\s*\{[^}]*white-space:\s*normal/, 'mobile member actions should allow button text to wrap');
assert.match(mobileCss, /\.member-detail-value\s*\{[^}]*overflow-wrap:\s*anywhere|\.member-detail-value\s*\{/, 'member values should be allowed to wrap');
assert.match(source, /@media \(max-width: 380px\) \{[\s\S]*\.member-details\s*\{[^}]*grid-template-columns:\s*1fr/, 'very narrow phones should use one detail column');

assert.doesNotMatch(source, /<div class="detail">\$\{memberDetails\}<\/div>/, 'legacy squeezed plain-text details should not be rendered');

console.log('club manager members contract tests passed');
