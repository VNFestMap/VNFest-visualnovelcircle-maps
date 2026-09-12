import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const css = read('club-manager-react/src/styles.css');
const app = read('club-manager-react/src/App.jsx');
const shell = read('club-manager-react/src/Shell.jsx');
const components = read('club-manager-react/src/components.jsx');
const memberships = read('club-manager-react/src/tabs/MembershipsTab.jsx');
const members = read('club-manager-react/src/tabs/MembersTab.jsx');
const users = read('club-manager-react/src/tabs/UsersTab.jsx');
const model = read('club-manager-react/src/model.js');
const shellHtml = read('admin/club_manager.html');

/* ========== 令牌刻度 ========== */
for (const token of ['--cm-sp-1: 4px', '--cm-sp-2: 6px', '--cm-sp-3: 8px', '--cm-sp-4: 12px', '--cm-sp-5: 14px', '--cm-sp-6: 18px', '--cm-sp-7: 24px']) {
  assert.ok(css.includes(token), `spacing scale must define ${token}`);
}
for (const token of ['--cm-r-xs: 4px', '--cm-r-sm: 6px', '--cm-r-md: 8px', '--cm-r-lg: 12px', '--cm-r-pill: 999px']) {
  assert.ok(css.includes(token), `shape scale must define ${token}`);
}
for (const token of ['--cm-fs-num: 22px', '--cm-fs-title: 19px', '--cm-fs-body: 13px', '--cm-fs-meta: 11px']) {
  assert.ok(css.includes(token), `type scale must define ${token}`);
}
for (const token of ['--cm-dur-1:', '--cm-dur-2:', '--cm-dur-3:', '--cm-ease-out:', '--cm-ease-smooth:']) {
  assert.ok(css.includes(token), `motion scale must define ${token}`);
}

/* 只允许刻度内的间距值；1/2px 作为字排微调（细缝）显式放行 */
const spacingLiterals = [...css.matchAll(/(?:padding|padding-top|padding-bottom|padding-left|padding-right|margin|margin-top|margin-bottom|gap|row-gap|column-gap)\s*:\s*([^;}]+)/g)]
  .flatMap((match) => [...match[1].matchAll(/(\d+)px/g)].map((value) => Number(value[1])));
const allowedSpacing = new Set([0, 1, 2, 4, 6, 8, 12, 14, 18, 24, 26, 32, 34, 36, 40, 44, 64, 72, 92, 96, 200, 300]);
for (const value of spacingLiterals) {
  assert.ok(allowedSpacing.has(value) || value >= 100, `off-scale spacing value ${value}px found in styles.css`);
}

/* ========== Chrome 尺寸收紧 ========== */
assert.match(css, /--cm-topbar-height: 56px/, 'the topbar must be tightened to 56px');
assert.match(shell, /width=\{collapsed \? 64 : 244\}/, 'the sidebar must be tightened to 244px / 64px collapsed');
assert.match(app, /controlHeight: 32/, 'antd controlHeight must be pinned to 32');
assert.match(app, /controlHeightSM: 26/, 'antd controlHeightSM must be pinned to 26');
assert.match(app, /fontSize: 13/, 'antd base fontSize must be 13');
assert.match(app, /borderRadius: 8/, 'antd borderRadius must be 8');
assert.match(app, /itemHeight: 36/, 'sidebar menu items must be 36px');
assert.match(app, /bodyPadding: 14/, 'card body padding must be 14');
assert.match(app, /cellPaddingBlock: 8/, 'table rows must be tightened');
assert.match(app, /itemMarginBottom: 14/, 'form items must be tightened');
assert.match(model, /visitor:\s*'访客'/, 'visitor must have a distinct display label');
assert.doesNotMatch(users, /const displayRole = user\.display_role \|\| user\.role;/, 'users system role must not use effective membership display_role');
assert.match(users, /const displayRole = user\.role;/, 'users system role must use the account role');
assert.doesNotMatch(shellHtml, /page-background\.js/, 'club manager must not load the wallpaper runtime');

/* ========== 骨架间距由父级 gap 驱动，不再双份 ========== */
assert.match(css, /\.cm-page \{ display: flex; flex-direction: column; gap: var\(--cm-sp-5\);[\s\S]*width: min\(100%, 1280px\);/, 'page skeleton must use a single flex gap and a readable max width');
assert.match(css, /\.cm-panel, \.cm-toolbar, \.cm-section-card, \.cm-template-card \{ margin-bottom: 0; \}/, 'panels must not add their own bottom margin');
assert.match(css, /\.cm-management-list \{[\s\S]*display: grid; gap: 0;[\s\S]*border: 1px solid var\(--cm-line\);/, 'business lists must use one surface with dividers');
assert.match(css, /\.cm-page-heading \{[^}]*margin: 0; \}/, 'page headings must not add their own bottom margin');

/* ========== 五类业务条目结构 ========== */
for (const token of ['cm-management-list', 'cm-management-item', 'cm-item-identity', 'cm-item-content', 'cm-item-context', 'cm-item-actions', 'cm-meta-line', 'cm-meta-item', 'cm-chip', 'cm-action-cluster', 'cm-disclosure', 'cm-user-table', 'cm-identity']) {
  assert.ok(css.includes(`.${token}`), `styles must define .${token}`);
  assert.ok(components.includes(token) || css.includes(`.${token}`), `${token} must be wired up`);
}
assert.match(css, /\.cm-management-item \{[\s\S]*grid-template-columns: minmax\(190px, \.78fr\) minmax\(0, 1\.72fr\) minmax\(140px, \.58fr\) auto;/, 'management items must use explicit desktop columns');
assert.match(css, /\.cm-management-item\.is-readonly \{ grid-template-columns: minmax\(190px, \.78fr\) minmax\(0, 1\.9fr\) minmax\(140px, \.58fr\);/, 'approved history rows must remove the action column');
assert.match(css, /\.cm-membership-list\.is-approved \.cm-management-item \{ animation: none; transition: none; \}/, 'approved history rows must not animate in bulk');
assert.match(css, /\.cm-chip \{ display: inline-flex; align-items: center; height: 22px;/, 'chips must be 22px tall');
assert.match(css, /\.cm-action-cluster \{ display: flex;[\s\S]*flex-wrap: wrap;[\s\S]*max-width: 260px;/, 'action clusters must use a bounded wrapping flex layout');
assert.doesNotMatch(css, /\.cm-action-cluster\s*\{[^}]*repeat\(auto-fit/, 'action clusters must not use an auto-fit grid');

/* ========== 列表页按业务类型使用不同条目变体 ========== */
for (const [name, source] of [['MembershipsTab', memberships], ['MembersTab', members], ['UsersTab', users]]) {
  assert.ok(source.includes('<ManagementItem') || source.includes('<table className="cm-user-table">'), `${name} must render a business-specific item structure`);
  assert.ok(source.includes('<ActionCluster') || name === 'MembershipsTab', `${name} must keep actions in a dedicated action cluster where applicable`);
  assert.doesNotMatch(source, /<FieldGrid/, `${name} must not use the removed boxed field grid`);
  assert.doesNotMatch(source, /actions=\{\[/, `${name} must not use the antd Card actions strip`);
  assert.doesNotMatch(source, /<Space wrap>/, `${name} must not fall back to a plain Space wrap for actions`);
}
assert.ok(memberships.includes('className={`cm-membership-item cm-membership-item-${mode}`}'), 'membership rows must keep per-mode hooks');
assert.match(memberships, /const APPROVED_PAGE_SIZE = 100;/, 'approved history must use a bounded page size');
assert.ok(memberships.includes('<Pagination'), 'approved history must expose pagination when the record set is large');
assert.ok(users.includes('className="cm-user-table-row"'), 'user rows must keep the table-row hook');
assert.ok(members.includes('className="cm-member-item"'), 'member rows must keep the member-item hook');
assert.ok(memberships.includes('className="cm-review-actions"'), 'pending and diplomatic rows must expose a fixed review action cluster');
assert.match(memberships, /const actions = mode !== 'approved' \?/, 'approved history rows must not reserve an action slot');
assert.ok(users.includes('<table className="cm-user-table">'), 'users must expose semantic table structure');
assert.match(components, /variant = 'panel'/, 'loading panels must support shape-specific variants');
assert.match(members, /<LoadingPanel variant="management"/, 'members must use a management-shaped loading skeleton');
assert.match(users, /<LoadingPanel variant="table"/, 'users must use a table-shaped loading skeleton');
assert.match(css, /\.cm-loading-item \{/, 'management loading skeletons must share the item surface');
assert.match(css, /\.cm-loading-table-row \{/, 'user table loading skeletons must share table row geometry');
for (const [name, source] of [['MembershipsTab', memberships], ['MembersTab', members], ['UsersTab', users]]) {
  if (name !== 'MembershipsTab') assert.ok(source.includes('ActionCluster'), `${name} must expose an action cluster when it has row actions`);
}

/* ========== 滑动条：transform 驱动 + 淡化 ========== */
assert.match(css, /\.cm-nav-wrap::before \{[\s\S]*?transform: translate3d\(0, var\(--cm-slider-y, 0px\), 0\)/, 'the slider must be positioned by transform, not top');
assert.match(css, /\.cm-nav-wrap::before \{[\s\S]*?top: 0;/, 'the slider must anchor at top: 0 so transform drives the offset');
assert.match(css, /\.cm-nav-wrap::before \{[\s\S]*?width: 2px;/, 'the slider must be thinned to 2px');
assert.match(css, /\.cm-nav-wrap\[data-slider-ready="true"\]::before \{ opacity: \.45; \}/, 'the slider must stay subtle when ready');
assert.match(css, /transition: transform var\(--cm-dur-3\) var\(--cm-ease-slide\), height var\(--cm-dur-3\) var\(--cm-ease-smooth\);/, 'the slider must animate transform and height on the motion scale');
assert.doesNotMatch(css, /\.cm-nav-wrap::before \{[^}]*transition:[^}]*opacity/, 'the slider reveal must not depend on an opacity transition');
assert.match(shell, /const SLIDER_HEIGHT = 20;/, 'slider height must be a single shared constant');
assert.match(shell, /data-slider-driver="transform"/, 'the slider driver must be observable for regression tests');

/* ========== 动效 ========== */
assert.match(css, /@keyframes cmPageIn/, 'tab switching must have an enter animation');
assert.match(css, /@keyframes cmRowIn/, 'record lists must have an enter animation');
assert.match(css, /\.cm-management-item:nth-child\(2\) \{ animation-delay: 16ms; \}/, 'business rows must stagger in');
assert.match(css, /\.cm-management-item \{[\s\S]*animation: cmRowIn var\(--cm-dur-2\) var\(--cm-ease-out\) backwards;/, 'management rows must have an enter animation');
assert.match(css, /\.cm-user-table tbody tr \{[^}]*animation: cmRowIn var\(--cm-dur-2\) var\(--cm-ease-out\) backwards;/, 'user rows must have an enter animation');
assert.match(app, /className="cm-page-enter"/, 'the active tab must be wrapped for the enter animation');
assert.match(css, /\.cm-management-item:nth-child\(n\+5\) \{ animation-delay: 64ms; \}/, 'stagger must be capped for long lists');
assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.cm-page-enter, \.cm-management-item, \.cm-user-table tbody tr \{ animation: none !important; \}/, 'reduced motion must disable the enter animations');

/* ========== 触控底线：只保关键操作，不再一刀切 44px ========== */
assert.doesNotMatch(css, /\.ant-btn, \.ant-input, \.ant-select-selector, \.ant-picker \{ min-height: 44px; \}/, 'the blanket 44px rule must be gone');
assert.match(css, /@media \(max-width: 680px\)[\s\S]*\.cm-topbar \.ant-btn,\n  \.ant-btn-primary,\n  \.ant-btn-dangerous,/, 'only key and destructive controls must keep a 44px touch target');
assert.doesNotMatch(css, /\.cm-action-cluster > \.ant-btn,/, 'secondary row actions must not be forced to 44px on phones');

console.log('club manager density contract tests passed');
