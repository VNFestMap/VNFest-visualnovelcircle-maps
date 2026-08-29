import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const userPages = [
  'index.html',
  'submit.html',
  'feedback.html',
  'user.html',
  'club_share.html',
  'club_square.html',
  'admin/club_project_manager.html',
  'star_map.html',
  'submit_event.html',
  'submit_publication.html',
  'wiki/index.html',
  'exam/index.html',
  'verify.html',
];

const attrPattern = /\b(?:href|src)=["']([^"']+)["']/gi;
const missing = [];

function isLocalReference(value) {
  if (!value || value === '#') return false;
  if (value.startsWith('#')) return false;
  if (/^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(value)) return false;
  return true;
}

function stripUrlSuffix(value) {
  return value.split('#')[0].split('?')[0];
}

for (const page of userPages) {
  const pagePath = path.join(root, page);
  assert.ok(fs.existsSync(pagePath), `${page} should exist`);
  const html = fs.readFileSync(pagePath, 'utf8');
  const pageDir = path.dirname(pagePath);

  for (const match of html.matchAll(attrPattern)) {
    const rawRef = match[1].trim();
    if (!isLocalReference(rawRef)) continue;
    const cleanRef = stripUrlSuffix(rawRef);
    if (!cleanRef) continue;
    const resolved = path.resolve(pageDir, cleanRef);
    if (!resolved.startsWith(root)) continue;
    if (!fs.existsSync(resolved)) {
      missing.push(`${page} -> ${rawRef}`);
    }
  }
}

assert.deepEqual(missing, [], `Missing local user-page assets:\n${missing.join('\n')}`);

const userSource = fs.readFileSync(path.join(root, 'user.html'), 'utf8');
const jsAsset = userSource.match(/src=["']\.\/(user-v2-assets\/[^"']+\.js)["']/)?.[1];
assert.ok(jsAsset, 'user center should load a built JavaScript asset');
const jsSource = fs.readFileSync(path.join(root, jsAsset), 'utf8');
const languageRuntime = fs.readFileSync(path.join(root, 'js/language-runtime.js'), 'utf8');
const languageCatalog = fs.readFileSync(path.join(root, 'js/language-catalog.js'), 'utf8');
const reactSource = fs.readFileSync(path.join(root, 'user-v2-react/src/App.jsx'), 'utf8');

assert.match(jsSource, /接口返回的不是 JSON/, 'user center should validate backend JSON responses');
assert.match(jsSource, /api\/auth\.php\?action=me/, 'user center should initialize from the backend auth session');
assert.match(jsSource, /credentials:"same-origin"/, 'user center should keep same-origin PHP session credentials');
assert.doesNotMatch(jsSource, /mockUser|showDemoMode\s*\(/, 'user center should not fall back to offline demo data');
assert.doesNotMatch(jsSource, /Promise\.race\(\[/, 'user center should not hide backend failures behind a timeout demo mode');
assert.match(jsSource, /VNFWallpaper/, 'user center build should use the shared wallpaper runtime');
assert.match(jsSource, /VNFDisplayPreferences/, 'user center build should use shared display preferences');
assert.match(jsSource, /preferences/, 'user center build should include the preferences navigation');
assert.match(jsSource, /VNFLanguage/, 'user center build should use the shared account language runtime');
assert.match(languageRuntime, /update_language_preference/, 'shared language runtime should save language through the account API');
assert.match(languageCatalog, /'common\.chinese'/, 'shared catalog should include the Chinese language option');
assert.match(languageCatalog, /'common\.japanese'/, 'shared catalog should include the Japanese language option');
assert.match(reactSource, /antd\/locale\/zh_CN/, 'user center source should import the Ant Design Chinese locale');
assert.match(reactSource, /antd\/locale\/ja_JP/, 'user center source should import the Ant Design Japanese locale');
assert.match(reactSource, /locale=\{antdLocale\}/, 'user center should pass the active language to Ant Design');
assert.match(jsSource, /今日/, 'user center build should contain the compiled Ant Design Japanese locale');
assert.match(userSource, /js\/display-preferences\.js/, 'user center shell should load display preferences');
assert.match(userSource, /js\/page-background\.js/, 'user center shell should load the wallpaper runtime');
assert.match(userSource, /js\/language-runtime\.js/, 'user center shell should load the shared language runtime');
assert.match(userSource, /js\/language-catalog\.js/, 'user center shell should load the shared language catalog');
assert.match(userSource, /js\/page-i18n\.js/, 'user center shell should load the DOM language adapter');
assert.match(userSource, /data-language-managed=["']react["']/, 'user center shell should identify React-managed language content');

const inlineScripts = [...userSource.matchAll(/<script(?![^>]+\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
for (const script of inlineScripts) {
  new Function(script);
}

console.log('user page asset checks passed');
