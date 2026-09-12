import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'club-manager-react/src/tabs/MembersTab.jsx'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'club-manager-react/src/styles.css'), 'utf8');
const components = fs.readFileSync(path.join(root, 'club-manager-react/src/components.jsx'), 'utf8');

/* ========== 成员条目结构：身份、资料、设置/角色、操作分别占位 ========== */
assert.match(source, /<ManagementItem/, 'member rows must use the business item layout');
assert.match(source, /className="cm-member-item"/, 'member rows must keep the cm-member-item hook');
assert.match(source, /<MetaLine className="cm-member-meta-primary">/, 'member rows must have a primary metadata line');
assert.match(source, /<MetaLine className="cm-member-meta-secondary">/, 'super-admin member metadata must have a secondary line');
assert.match(source, /status=\{<Chip/, 'member role must use the dedicated status slot');
assert.match(source, /settings=\{memberSettings\}/, 'mail recipient setting must use the dedicated settings slot');
assert.match(source, /<ActionCluster className="cm-member-actions">/, 'member actions must have a dedicated action cluster');
assert.doesNotMatch(source, /<RecordRow|<InfoRows|<ActionBar/, 'members must not use the removed generic record components');
assert.doesNotMatch(source, /<FieldGrid/, 'the boxed field grid must be gone');
assert.doesNotMatch(source, /<Card/, 'member rows must not be heavy antd cards');
assert.doesNotMatch(source, /<Space wrap/, 'actions must not fall back to a Space wrap');
assert.doesNotMatch(source, /innerHTML|dangerouslySetInnerHTML/, 'member rendering must not build HTML strings');

/* ========== 字段与可见性契约不变 ========== */
for (const label of ['昵称', '邮箱', 'QQ', '申请身份', '学生', '加入于']) {
  assert.ok(source.includes(`label="${label}"`), `missing ${label}`);
}
assert.match(source, /superAdmin && \([\s\S]*member\.email/, 'email visibility must stay super-admin only');
assert.match(source, /superAdmin && \([\s\S]*member\.qq_account/, 'QQ visibility must stay super-admin only');
assert.match(source, /superAdmin && \([\s\S]*member\.apply_role/, 'application role must stay super-admin only');
assert.match(source, /superAdmin && \([\s\S]*member\.is_student !== undefined/, 'student status must stay super-admin only');

/* ========== 四个动作端点与权限判定不变 ========== */
for (const action of ['set_application_email_recipient', 'change_role', 'transfer', 'kick']) {
  assert.ok(source.includes(action), `missing ${action}`);
}
assert.match(source, /const canChangeRole = !isSelf && \(superAdmin \|\| myRole === 'representative'\)/, 'role changes must keep the representative gate');
assert.match(source, /const canKick = !isSelf && \(superAdmin \|\| myRole === 'representative'/, 'kick must keep the representative/manager gates');
assert.match(source, /const canTransfer = !isSelf && \(superAdmin \|\| myRole === 'representative'\)/, 'transfer must stay representative-only');
assert.match(source, /const canEmail = \(superAdmin \|\| myRole === 'representative'\)/, 'email recipients must stay representative-only');
assert.equal((source.match(/type="primary"/g) || []).length, 1, 'the member row must expose exactly one primary action (转让)');

/* ========== 共享条目组件契约 ========== */
for (const component of ['ManagementItem', 'MetaLine', 'MetaItem', 'ActionCluster', 'Chip', 'Identity']) {
  assert.match(components, new RegExp(`export function ${component}\\b`), `${component} must exist`);
}
assert.match(components, /className="cm-item-identity"/, 'management items must expose an identity slot');
assert.match(components, /className="cm-item-content"/, 'management items must expose a content slot');
assert.match(components, /className="cm-item-context"/, 'management items must expose a context slot');
assert.match(components, /className="cm-item-actions"/, 'management items must expose an actions slot');
for (const slot of ['summary', 'details', 'status', 'settings']) {
  assert.match(components, new RegExp(`data-slot="${slot}"`), `management items must expose a ${slot} slot`);
}
assert.doesNotMatch(components, /export function (InfoRows|RecordRow|ActionBar)\b/, 'old generic record components must be removed');
assert.doesNotMatch(components, /export function FieldGrid\b/, 'the boxed field grid must be removed');

/* ========== 桌面列与移动降级 ========== */
assert.match(styles, /\.cm-management-item \{[\s\S]*grid-template-columns: minmax\(190px, \.78fr\) minmax\(0, 1\.72fr\) minmax\(140px, \.58fr\) auto;/, 'member items must use explicit identity/content/context/action columns');
assert.match(styles, /\.cm-action-cluster \{ display: flex;[\s\S]*max-width: 260px;/, 'member actions must be a bounded wrapping cluster');
assert.match(styles, /\.cm-setting-line \{ display: flex;/, 'mail recipient setting must stay a separate setting line');
assert.match(styles, /\.cm-item-details \{/, 'secondary details must stay inside the content area');
assert.match(styles, /\.cm-item-context-stack \{/, 'status and settings must share a dedicated context area');
assert.match(styles, /@media \(max-width: 899px\)[\s\S]*\.cm-management-item, \.cm-management-item\.is-readonly \{ grid-template-columns: minmax\(0, 1fr\);/, 'member items must stack before the tablet breakpoint');
assert.doesNotMatch(styles, /\.cm-action-bar\s*\{/, 'the old generic action bar must be removed');
assert.doesNotMatch(styles, /\.cm-info-row\s*\{/, 'the old vertical info rows must be removed');

console.log('club manager React members contract tests passed');
