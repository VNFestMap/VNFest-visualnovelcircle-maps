import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const index = read('index.html');
const css = read('css/styles.css');
const app = read('js/app.js');

const tabMatches = [...index.matchAll(
  /<button\s+class="membership-apply-tab(?:\s+active)?"[^>]*data-join-method="([^"]+)"[^>]*>([^<]+)<\/button>/g
)];
assert.equal(tabMatches.length, 3, '申请绑定弹窗应保留三种绑定方式');
assert.deepEqual(
  tabMatches.map((match) => match[1]),
  ['school_no_code', 'school_code', 'external_exchange'],
  '绑定方式顺序和值不能变化'
);
assert.deepEqual(
  tabMatches.map((match) => match[2].trim()),
  ['本校无绑定码', '本校有绑定码', '外校交流'],
  '绑定方式文案不能变化'
);

assert.match(index, /styles\.css\?v=20260826-membership-tabs-v3/, 'CSS 缓存版本应更新');
assert.equal(
  (index.match(/styles\.css\?v=20260826-membership-tabs-v3/g) || []).length,
  2,
  'preload 和 stylesheet 应使用同一个 CSS 缓存版本'
);

const marker = '移动端申请绑定：三列单行布局';
const mobileStart = css.indexOf(marker);
assert.ok(mobileStart >= 0, '移动端申请绑定专用覆盖规则缺失');
const mobileCss = css.slice(mobileStart);
assert.match(mobileCss, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/, '移动端应使用三列等宽网格');
assert.match(mobileCss, /overflow:\s*visible/, '移动端绑定方式不应横向滚动');
assert.match(mobileCss, /flex:\s*initial/, '移动端不应保留固定 flex 宽度');
assert.match(mobileCss, /min-height:\s*48px/, '移动端按钮高度应满足触控要求');
assert.match(mobileCss, /white-space:\s*nowrap/, '移动端按钮文字必须保持单行');
assert.match(mobileCss, /font-size:\s*clamp\(10px,\s*3vw,\s*12px\)/, '移动端应通过字号缩放适配窄屏');
assert.doesNotMatch(mobileCss, /overflow-x:\s*auto/, '移动端绑定方式不得横向滚动');
assert.doesNotMatch(mobileCss, /flex:\s*0\s+0\s+min\(58vw,\s*210px\)/, '移动端不得使用旧固定宽度');

const visualStart = css.lastIndexOf('申请绑定按钮：分段控件视觉优化');
assert.ok(visualStart >= 0, '申请绑定按钮视觉优化规则缺失');
const visualCss = css.slice(visualStart);
assert.match(visualCss, /border-radius:\s*14px/, '绑定按钮应使用紧凑分段圆角');
assert.match(visualCss, /color:\s*var\(--md-on-surface-variant\)/, '未选中按钮应使用次级文字颜色');
assert.match(visualCss, /\.membership-apply-tab:focus-visible\s*\{[\s\S]*outline:/, '按钮应提供键盘焦点态');
assert.match(visualCss, /\.membership-apply-tab\.active\s*\{[\s\S]*box-shadow:/, '激活按钮应有克制的层次阴影');
assert.match(visualCss, /animation:\s*membershipApplyTabActivate\s+220ms\s+var\(--ease-spring\)/, '激活按钮应沿用站点弹性动效');
assert.match(visualCss, /prefers-reduced-motion:\s*reduce[\s\S]*animation:\s*none\s*!important/, '动效应尊重减少动态偏好');

assert.match(app, /function setMembershipApplyMethod\(/, '绑定方式切换逻辑必须保留');
assert.match(app, /function submitMembershipApply\(/, '绑定申请提交逻辑必须保留');
assert.match(app, /api\/club_codes\.php\?action=redeem/, '绑定码验证 API 必须保留');

console.log('membership apply mobile contract checks passed');
