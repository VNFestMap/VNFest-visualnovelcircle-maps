import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pages = [
  'index.html', 'login.html', 'user.html', 'user-v2.html', 'club_square.html', 'club_share.html',
  'feedback.html', 'submit.html', 'submit_event.html', 'submit_publication.html', 'vote.html', 'star_map.html',
  'Forum/forum-create.html', 'Forum/forum-plaza.html', 'Forum/forum-post.html',
  'Galgame_events/Beijing_Galonly_staff_guidelines.html', 'Galgame_events/Beijing_Galonly_staff_submit.html',
  'Galgame_events/galgameonly_list.html', 'Galgame_events/galo_poster.html',
  'Galgame_events/galonly_staff_guidelines.html', 'Galgame_events/galonly_staff_submit.html',
  'Galgame_events/Shanghai_Galonly_staff.html', 'Galgame_events/Shanghai_Galonly_submit.html',
  'moe/bracket.html', 'moe/contest.html', 'moe/index.html', 'twelve/contest.html', 'twelve/index.html', 'twelve/vote.html',
  'club-operation-portrait/index.html', 'Game/galgame_club_sim/index.html', 'Game/spy/index.html',
  'Game/galgame_club_sim/card-creator/index.html', 'JUYOU/HAIGUITANG.html',
  'wiki/index.html', 'wiki/guide/index.html', 'wiki/library/wiki-writing-guide.html',
  'wiki/publications.html', 'wiki/publication-upload.html', 'wiki/publication-manage.html', 'tools/pdf-reader/index.html',
  ...fs.readdirSync(path.join(root, 'wiki/pages')).filter((file) => file.endsWith('.html')).map((file) => `wiki/pages/${file}`),
];

for (const file of pages) {
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(html, /js\/language-runtime\.js/, `${file} must load the shared language runtime`);
  assert.match(html, /js\/language-catalog\.js/, `${file} must load the shared language catalog`);
  assert.match(html, /js\/language-static-ja\.js/, `${file} must load the first-party Japanese text catalog`);
  assert.doesNotMatch(html, /data-i18n-lang|data-wiki-switch-lang|data-wiki-index-lang|langToggle/, `${file} must not expose an ad-hoc page-local language selector`);
}

const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
for (const id of ['langZhBtn', 'langJaBtn', 'listLangZhBtn', 'listLangJaBtn', 'langZhBtnDrawer', 'langJaBtnDrawer']) {
  assert.doesNotMatch(index, new RegExp(`id=["']${id}["']`), `index must not render ${id}`);
}
assert.match(index, /VNFIndexUIContract/, 'index must expose its centralized preference UI contract');
assert.match(index, /addEventListener\(['"]pageshow['"],\s*enforceCentralizedPreferences\)/,
  'index must re-enforce centralized preferences when a cached page is restored');

const runtime = fs.readFileSync(path.join(root, 'js/language-runtime.js'), 'utf8');
for (const token of ['VNFLanguage', 'vnfestLanguageAccountId', 'update_language_preference', 'navigator.languages', 'sessionStorage', 'localizeApiMessage']) {
  assert.ok(runtime.includes(token), `language runtime must include ${token}`);
}

const adapter = fs.readFileSync(path.join(root, 'js/page-i18n.js'), 'utf8');
assert.match(adapter, /VNFLanguage/, 'legacy DOM adapter must consume the shared runtime');
assert.doesNotMatch(adapter, /localStorage\.getItem\(STORAGE_KEY\)/, 'legacy DOM adapter must not own language storage');
assert.match(adapter, /if \(!value\.trim\(\)\) return value;/,
  'DOM language adapter must leave whitespace-only text nodes unchanged to prevent observer feedback loops');
assert.match(adapter, /script,style,textarea,code,pre,svg,canvas,\[data-i18n-skip\]/,
  'DOM language adapter must ignore SVG and canvas subtrees managed by rendering engines');
assert.match(adapter, /if \(observer\) observer\.disconnect\(\);[\s\S]*observer\.observe\(document\.body/,
  'DOM language adapter must not observe its own translation writes');

const editor = fs.readFileSync(path.join(root, 'admin/wiki_editor.html'), 'utf8');
assert.match(editor, /wiki-lang-tabs/, 'Wiki editor content-language tabs must remain available');

console.log('page i18n contract tests passed');
