import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const shell = read('admin/club_manager.html');
const app = read('club-manager-react/src/App.jsx');
const nav = read('club-manager-react/src/model.js');
const shellJsx = read('club-manager-react/src/Shell.jsx');
const css = read('club-manager-react/src/styles.css');
const components = read('club-manager-react/src/components.jsx');
const memberships = read('club-manager-react/src/tabs/MembershipsTab.jsx');
const members = read('club-manager-react/src/tabs/MembersTab.jsx');
const users = read('club-manager-react/src/tabs/UsersTab.jsx');
const recommendations = read('club-manager-react/src/tabs/RecommendationsTab.jsx');

/* ========== 入口外壳保持轻量，且不含旧全局业务代码 ========== */
assert.ok(shell.length < 1800, 'the entry shell must stay lightweight');
assert.match(shell, /id="root"/);
assert.doesNotMatch(shell, /onclick=|switchTab|onClubChange|club_manager_recognition/);
assert.doesNotMatch(shell, /club_manager_recognition\.js|data-tab="/);
assert.doesNotMatch(shell, /<script(?![^>]*\bsrc=)[^>]*>/i, 'the shell must not carry inline scripts');

/* ========== 外壳引用的哈希产物必须真实存在 ========== */
const js = shell.match(/\.\/club-manager-assets\/(index-[\w-]+\.js)/)?.[1];
const style = shell.match(/\.\/club-manager-assets\/(index-[\w-]+\.css)/)?.[1];
assert.ok(js && fs.existsSync(path.join(root, 'admin/club-manager-assets', js)), `missing entry script ${js}`);
assert.ok(style && fs.existsSync(path.join(root, 'admin/club-manager-assets', style)), `missing entry stylesheet ${style}`);

/* ========== 发行产物只保留清单内的资产 ========== */
const assetDir = path.join(root, 'admin', 'club-manager-assets');
const manifest = JSON.parse(read('admin/club-manager-assets/.generated-assets.json'));
const onDisk = fs.readdirSync(assetDir).filter((name) => name !== '.generated-assets.json');
for (const name of onDisk) assert.ok(manifest.includes(name), `stale build asset left on disk: ${name}`);
for (const name of manifest) assert.ok(onDisk.includes(name), `manifest entry missing on disk: ${name}`);

/* ========== Tab key 与顺序保持不变 ========== */
const expected = ['pending', 'diplomatic', 'approved', 'members', 'settings', 'codes', 'bot_tokens', 'recommendations', 'projects', 'recognition', 'jiangsu', 'users'];
let cursor = -1;
for (const key of expected) {
  const next = nav.indexOf(`key: '${key}'`, cursor + 1);
  assert.ok(next > cursor, `tab ${key} missing or out of order`);
  cursor = next;
}
assert.match(app, /syncTabUrl\(next\)/);
assert.match(nav, /url\.searchParams\.delete\('tab'\)/);
assert.match(nav, /url\.searchParams\.set\('tab', tab\)/);
assert.match(nav, /export const DEFAULT_TAB = 'approved';/, 'club manager must land on approved records instead of opening the pending review queue');

/* ========== 全宽第一层顶栏 + 第二层工作区 ========== */
assert.match(shellJsx, /<header[\s\S]*<Layout className="cm-workspace">/);
assert.doesNotMatch(shellJsx, /className="sidebar-brand"/);
assert.match(shellJsx, /max-width: 1100px/);
assert.match(css, /top:\s*var\(--cm-topbar-height\)/);
assert.match(css, /prefers-reduced-motion/);

/* ========== 设计令牌必须来自站点主题令牌，不得引用已删除的内联变量 ========== */
for (const token of ['primary', 'bg', 'surface', 'raised', 'line', 'text', 'muted']) {
  assert.match(css, new RegExp(`--cm-${token}:\\s*var\\(--vn-[a-z-]+`), `--cm-${token} must resolve from a --vn-* theme token`);
}
assert.doesNotMatch(
  css,
  /var\(--(accent|bg-primary|surface|surface-raised|text-primary|text-secondary|border)[,)\s]/,
  'styles must not reference the legacy inline tokens removed with the old page',
);
assert.match(app, /colorPrimary: tokens\.primary/, 'Ant Design must derive colorPrimary from the theme tokens');

/* ========== 当前轮统一头像、顶栏操作和选择器契约 ========== */
assert.match(components, /export function ProfileAvatar\b/, 'all identity surfaces must use the safe avatar component');
assert.match(components, /mediaUrl\(value\)/, 'safe avatars must continue to resolve media URLs');
assert.match(components, /onError=\{\(\) => \{ setFailed\(true\)/, 'safe avatars must fall back after image load failure');
assert.match(css, /\.cm-profile-avatar\.is-fallback\s*\{/, 'missing avatars must have a neutral patterned fallback');
assert.match(shellJsx, /className="cm-topbar-action"/, 'topbar actions must share one sizing hook');
assert.match(css, /\.cm-topbar-actions[\s\S]*gap: var\(--cm-sp-3\)/, 'topbar actions must use a fixed spacing token');
assert.match(shellJsx, /showSearch[\s\S]*optionFilterProp="label"[\s\S]*listHeight=\{420\}/, 'club selector must expose searchable, tall options');
assert.match(shellJsx, /className="cm-pending-badge"/, 'pending navigation count must keep a dedicated badge hook');
for (const [name, source] of [['memberships', memberships], ['members', members], ['users', users]]) {
  assert.match(source, /<ProfileAvatar/, `${name} must use the safe avatar component`);
}
assert.match(users, /const displayRole = user\.display_role \|\| getPermissionRole\(user\);/, 'user table must display the effective permission level');
assert.match(users, /data-label="权限等级"/, 'user table must rename the system role column to 权限等级');
assert.match(users, /<PermissionLevel role=\{displayRole\}/, 'user table must use the semantic permission-level badge');
assert.match(recommendations, /className="cm-character-avatar"/, 'Moe King avatars must have a dedicated crop hook');
assert.match(recommendations, /data-rank=\{index \+ 1\}/, 'recommendation slots must expose their rank for visual hierarchy');
assert.match(css, /\.cm-character-avatar img\s*\{[^}]*object-position: center top;/, 'character avatars must crop from the top');
assert.doesNotMatch(css, /\.cm-action-cluster\s*\{[^}]*repeat\(auto-fit/, 'action controls must not use free-flowing auto-fit grids');

/* ========== 生产源码中不得残留命令式 DOM 模板 ========== */
const sourceFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(jsx|js|css)$/.test(entry.name)) sourceFiles.push(full);
  }
}(path.join(root, 'club-manager-react', 'src')));
assert.ok(sourceFiles.length >= 15, `expected the full React source tree, found ${sourceFiles.length} files`);
for (const file of sourceFiles) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|\.innerHTML|onclick=|oninput=|onchange=/, `${relative} must not build HTML strings or inline handlers`);
  if (!relative.endsWith('main.jsx')) {
    assert.doesNotMatch(source, /document\.getElementById|document\.querySelector/, `${relative} must not query the document imperatively`);
  }
  assert.doesNotMatch(source, /window\.(switchTab|onClubChange|renderList|approveMembership|rejectMembership)\b/, `${relative} must not expose legacy globals`);
}
assert.match(read('club-manager-react/src/main.jsx'), /document\.getElementById\('root'\)/, 'only the mount point may query the document');

console.log('club manager React architecture contract tests passed');
