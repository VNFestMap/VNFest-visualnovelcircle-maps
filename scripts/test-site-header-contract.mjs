import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const siteRoot = dirname(root);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return entry.isFile() && entry.name.toLowerCase().endsWith('.html') ? [absolute] : [];
  });
}

function relativeName(absolute) {
  return relative(siteRoot, absolute).split(sep).join('/');
}

function isFormalPage(name) {
  if (name === 'index.html' || name === 'user.html' || name === 'user-v2.html') return false;
  if (name === 'login.html' || name === 'submit.html' || name === 'admin/reviews.html' || name === 'Galgame_events/Beijing_Galonly_staff_submit.html') return false;
  if (name.startsWith('.tmp-wiki-test/')) return false;
  return !/(^|\/)(club-operation-portrait|Game|tools\/pdf-reader|user-v2-react|vendor|docs|node_modules)(\/|$)/i.test(name);
}

function resolveAsset(page, value) {
  const cleanValue = value.split('?')[0];
  return fileURLToPath(new URL(cleanValue, pathToFileURL(page).href));
}

const pages = walk(siteRoot).filter((file) => isFormalPage(relativeName(file)));
assert.ok(pages.length >= 70, `expected the first-party page set, found only ${pages.length}`);

for (const page of pages) {
  const name = relativeName(page);
  const html = readFileSync(page, 'utf8');
  const cssMatches = [...html.matchAll(/<link\b[^>]*href=["']([^"']*site-header\.css[^"']*)["'][^>]*>/gi)];
  const jsMatches = [...html.matchAll(/<script\b[^>]*src=["']([^"']*site-header\.js[^"']*)["'][^>]*>/gi)];

  assert.equal(cssMatches.length, 1, `${name}: shared header CSS must be loaded exactly once`);
  assert.equal(jsMatches.length, 1, `${name}: shared header runtime must be loaded exactly once`);
  assert.ok(existsSync(resolveAsset(page, cssMatches[0][1])), `${name}: shared header CSS target is missing`);
  assert.ok(existsSync(resolveAsset(page, jsMatches[0][1])), `${name}: shared header runtime target is missing`);
}

const rootIndex = readFileSync(join(siteRoot, 'index.html'), 'utf8');
assert.doesNotMatch(rootIndex, /site-header\.(?:css|js)/i, 'main map index.html must not opt into the shared header');

const runtime = readFileSync(join(siteRoot, 'js/site-header.js'), 'utf8');
for (const marker of ['data-page-header', 'vn-topbar-brand', 'vn-topbar-name', 'vn-topbar-divider', 'vn-topbar-sub', 'vn-topbar-actions', 'restoreManualMobileHeader', 'max-width: 680px']) {
  assert.match(runtime, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `runtime missing ${marker}`);
}

const headerCss = readFileSync(join(siteRoot, 'css/site-header.css'), 'utf8');
for (const marker of ['.vn-topbar', '.vn-topbar-brand', '.vn-topbar-actions', ':focus-visible', 'prefers-reduced-motion']) {
  assert.match(headerCss, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `shared CSS missing ${marker}`);
}

const generator = readFileSync(join(siteRoot, 'scripts/generate-wiki-pages.mjs'), 'utf8');
for (const marker of ['site-header.css', 'site-header.js', 'class="wiki-header vn-topbar"', 'data-page-header', 'vn-topbar-divider']) {
  assert.match(generator, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `Wiki generator missing ${marker}`);
}

const user = readFileSync(join(siteRoot, 'user.html'), 'utf8');
const userJs = user.match(/src=["']\.\/user-v2-assets\/(index-[^"']+\.js)["']/i)?.[1];
const userCss = user.match(/href=["']\.\/user-v2-assets\/(index-[^"']+\.css)["']/i)?.[1];
assert.ok(userJs && existsSync(join(siteRoot, 'user-v2-assets', userJs)), 'user.html JS bundle must exist');
assert.ok(userCss && existsSync(join(siteRoot, 'user-v2-assets', userCss)), 'user.html CSS bundle must exist');
assert.match(user, /css\/site-header\.css/i, 'user.html must load shared header CSS');

for (const page of pages.filter((file) => /wiki\/pages\/.*-ja\.html$/i.test(relativeName(file)))) {
  const html = readFileSync(page, 'utf8');
  assert.match(html, /<html\b[^>]*lang=["']ja["']/i, `${relativeName(page)} must remain Japanese`);
}

const manualPages = [
  'admin/club_manager.html',
  'admin/Galonly_audit.html',
  'Forum/forum-plaza.html',
  'wiki/index.html',
  'wiki/guide/index.html',
];
for (const name of manualPages) {
  const html = readFileSync(join(siteRoot, name), 'utf8');
  assert.equal((html.match(/data-header-manual/g) || []).length, 1, `${name}: manual header marker must be unique`);
  assert.equal((html.match(/class=["'][^"']*vn-topbar-brand/g) || []).length, 1, `${name}: manual brand must be unique`);
  assert.match(html, /class=["'][^"']*vn-topbar-actions/, `${name}: manual action area is missing`);
}
for (const name of ['submit.html', 'login.html', 'admin/reviews.html', 'Galgame_events/Beijing_Galonly_staff_submit.html']) {
  const html = readFileSync(join(siteRoot, name), 'utf8');
  assert.doesNotMatch(html, /site-header\.(?:css|js)/i, `${name}: requested rollback must not retain shared header assets`);
}

console.log(`Site header contract passed for ${pages.length} formal pages.`);
