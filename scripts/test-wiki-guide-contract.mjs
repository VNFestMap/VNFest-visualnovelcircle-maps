import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const zh = JSON.parse(read('wiki', 'guide', 'seed', 'zh-CN', 'documents.json'));
const ja = JSON.parse(read('wiki', 'guide', 'seed', 'ja-JP', 'documents.json'));
const ids = catalog => catalog.articles.map(article => article.id);

assert.deepEqual(ids(zh), ids(ja), 'Chinese and Japanese guide articles must share the same order and IDs');
assert.deepEqual(
  zh.groups.map(group => group.articleIds),
  ja.groups.map(group => group.articleIds),
  'Chinese and Japanese guide groups must keep the same article order',
);
assert.equal(zh.groups.length, 6, 'guide must include five documentation groups and one release-history group');
assert.equal(zh.articles.length, 18, 'guide must include eleven documentation articles and seven release notes');
const historyIds = [
  'updates/2026-09-03',
  'updates/2026-08-16-wiki-reading-layout',
  'updates/2-1-0',
  'updates/2026-08-13-display-language-preferences',
  'updates/2-0-0',
  'updates/1-7-1',
  'updates/1-7-0',
];
const zhHistory = zh.groups.find(group => group.id === 'release-history');
const jaHistory = ja.groups.find(group => group.id === 'release-history');
assert.ok(zhHistory && jaHistory, 'both languages must expose the release-history group');
assert.equal(zhHistory.title, '历史更新记录');
assert.equal(jaHistory.titleJa, '更新履歴');
for (const history of [zhHistory, jaHistory]) {
  assert.equal(history.collapsible, true, 'release history must be collapsible');
  assert.equal(history.defaultExpanded, false, 'release history must be collapsed by default');
  assert.equal(history.navigationScope, 'group', 'release history navigation must remain inside the group');
  assert.deepEqual(history.articleIds, historyIds, 'release history must display newest first');
}
for (const [index, zhArticle] of zh.articles.entries()) {
  const jaArticle = ja.articles[index];
  assert.equal(zhArticle.sections.length, jaArticle.sections.length, `${zhArticle.id} must keep the same section count in both languages`);
  assert.deepEqual(
    zhArticle.sections.map(section => (section.blocks || []).map(block => block.type)),
    jaArticle.sections.map(section => (section.blocks || []).map(block => block.type)),
    `${zhArticle.id} must keep matching content block structure in both languages`,
  );
}
for (const catalog of [zh, ja]) {
  const known = new Set(ids(catalog));
  const scopedIds = new Set(catalog.groups.filter(group => group.navigationScope === 'group').flatMap(group => group.articleIds));
  const regularArticles = catalog.articles.filter(article => !scopedIds.has(article.id));
  const regularIndex = new Map(regularArticles.map((article, index) => [article.id, index]));
  for (const article of catalog.articles) {
    assert.match(article.id, /^[a-z0-9][a-z0-9/-]+$/, `invalid article ID: ${article.id}`);
    assert.ok(article.title && article.summary, `${article.id} needs title and summary`);
    assert.ok(Array.isArray(article.sections) && article.sections.length, `${article.id} needs sections`);
    for (const link of [article.previousId, article.nextId]) if (link) assert.ok(known.has(link), `${article.id} links to unknown article ${link}`);
    if (!scopedIds.has(article.id)) {
      const index = regularIndex.get(article.id);
      assert.equal(article.previousId || null, regularArticles[index - 1]?.id || null, `${article.id} previous link must follow regular catalog order`);
      assert.equal(article.nextId || null, regularArticles[index + 1]?.id || null, `${article.id} next link must follow regular catalog order`);
    }
    const sectionTitles = new Set();
    for (const section of article.sections) {
      assert.ok(section.title, `${article.id} has an untitled section`);
      assert.ok(!sectionTitles.has(section.title), `${article.id} has a duplicate section title: ${section.title}`);
      sectionTitles.add(section.title);
      for (const block of section.blocks || []) {
        assert.ok(['paragraph', 'heading', 'steps', 'list', 'code', 'table', 'tip', 'warning', 'image'].includes(block.type), `${article.id} has unsupported block type: ${block.type}`);
        if (block.type === 'paragraph' || block.type === 'heading' || block.type === 'code' || block.type === 'tip' || block.type === 'warning') {
          assert.ok(String(block.text || '').trim(), `${article.id} ${block.type} block needs text`);
        }
        if (block.type === 'steps' || block.type === 'list') {
          assert.ok(Array.isArray(block.items) && block.items.length, `${article.id} ${block.type} block needs items`);
          assert.ok(block.items.every(item => String(item || '').trim()), `${article.id} ${block.type} block has an empty item`);
        }
        if (block.type === 'table') {
          assert.ok(Array.isArray(block.headers) && block.headers.length, `${article.id} table needs headers`);
          assert.ok(Array.isArray(block.rows) && block.rows.length, `${article.id} table needs rows`);
          assert.ok(block.rows.every(row => Array.isArray(row) && row.length === block.headers.length), `${article.id} table rows must match its headers`);
        }
        if (block.type === 'image') {
          assert.ok(block.alt, `${article.id} image needs alt text`);
          assert.ok(block.caption, `${article.id} image needs caption`);
          if (String(block.src || '').startsWith('./assets/')) {
            const assetPath = path.join(root, 'wiki', 'guide', String(block.src).replace(/^\.\//, ''));
            assert.ok(fs.existsSync(assetPath), `${article.id} references a missing guide asset: ${block.src}`);
          }
        }
      }
    }
  }
  for (const group of catalog.groups.filter(group => group.navigationScope === 'group')) {
    group.articleIds.forEach((id, index) => {
      const article = catalog.articles.find(candidate => candidate.id === id);
      assert.ok(article, `scoped navigation article is missing: ${id}`);
      assert.equal(article.previousId || null, group.articleIds[index - 1] || null, `${id} previous link must remain inside ${group.id}`);
      assert.equal(article.nextId || null, group.articleIds[index + 1] || null, `${id} next link must remain inside ${group.id}`);
    });
  }
}

for (const catalog of [zh, ja]) {
  const historyArticles = historyIds.map(id => catalog.articles.find(article => article.id === id));
  assert.ok(historyArticles.every(Boolean), 'all seven release notes must exist');
  assert.equal(new Set(historyArticles.map(article => article.updatedAt)).size, 7, 'release-note dates must be unique');
  assert.ok(historyArticles.every(article => article.sections.length > 0), 'release notes must include content sections');
}

const api = read('api', 'wiki.php');
const guide = read('wiki', 'guide', 'guide.js');
const guideShell = read('wiki', 'guide', 'index.html');
const editor = read('admin', 'wiki_guide_editor.html');
const wikiIndex = read('wiki', 'index.html');
const library = JSON.parse(read('wiki', 'library', 'index.json'));

for (const token of ['guide_catalog', 'guide_article', 'guide_save_draft', 'guide_publish', 'guide_unpublish', 'guide_reset_seed', 'guide_diff', 'guide_upload', 'data/wiki-guide', 'wikiGuideRequireAdmin']) {
  assert.ok(api.includes(token), `guide API must include ${token}`);
}
for (const token of ['guideSearch', 'copyArticleLink', 'guideToc', 'guideSidebar', 'guide_catalog', 'guide_article', 'loadToken !== state.loadToken']) {
  assert.ok(guide.includes(token), `guide reader must include ${token}`);
}
for (const token of ['<details class="guide-nav-group guide-nav-group-collapsible"', '<summary class="guide-nav-group-title"', 'syncCollapsibleGroups', "details.addEventListener('toggle'", "summary.addEventListener('keydown'", "event.key !== 'Enter'", 'aria-expanded']) {
  assert.ok(guide.includes(token), `guide reader must implement collapsible history navigation: ${token}`);
}
for (const token of ['guide_admin_catalog', 'guide_save_draft', 'guide_publish', 'guide_unpublish', 'guide_reset_seed', 'guide_upload']) {
  assert.ok(editor.includes(token), `guide editor must include ${token}`);
}
assert.ok(library.docs.some(doc => doc.url === './guide/'), 'Wiki library must link the guide');
assert.ok(wikiIndex.includes('data-wiki-guide-link'), 'Wiki home must expose a direct guide entry');
assert.ok(wikiIndex.includes('./guide/#/'), 'Wiki home direct guide entry must lead to a guide article');
assert.ok(guideShell.includes('js/language-runtime.js'), 'guide must load the shared language runtime');
assert.ok(guideShell.includes('guide.css?v=20260813-history'), 'guide must cache-bust the history stylesheet');
assert.ok(guideShell.includes('guide.js?v=20260813-history'), 'guide must cache-bust the history runtime');
assert.ok(!guideShell.includes('langToggle'), 'guide must not expose a local language control');
assert.ok(!guide.includes('langToggle'), 'guide runtime must not create a local language control');

const syncScript = read('scripts', 'sync-wiki-guide-seed.php');
for (const token of ['--publish-new', 'dry-run', 'addedArticleIds', 'preservedArticleCount', 'writeJsonWithBackup']) {
  assert.ok(syncScript.includes(token), `guide seed sync must include ${token}`);
}

console.log('wiki guide contract tests passed');
