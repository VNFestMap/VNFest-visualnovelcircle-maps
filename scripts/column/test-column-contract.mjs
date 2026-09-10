import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(root, relative));
const check = (condition, message) => assert.ok(condition, message);
const contains = (relative, value) => check(read(relative).includes(value), `${relative} should contain ${value}`);

for (const relative of [
  'column-react/package.json',
  'column-react/index.html',
  'column-react/src/main.jsx',
  'column-react/src/styles.css',
  'column/index.html',
  'column/.htaccess',
  'column/legacy.css',
  'api/column.php',
  'api/waline-sso.php',
  'includes/column/schema.php',
  'includes/column/helpers.php',
  'scripts/column/migrate-column.php',
  'scripts/column/sync-column-build.mjs',
]) check(exists(relative), `missing ${relative}`);

const api = read('api/column.php');
for (const action of ['bootstrap', 'feed', 'article', 'mine', 'admin', 'save_draft', 'publish', 'update', 'withdraw', 'delete', 'upload_image', 'delete_upload', 'moderate_article', 'set_featured']) {
  contains('api/column.php', `'${action}'`);
}
check(!api.includes('column_articles'), 'new API must not use the legacy article table');
check(!api.includes('column_comments'), 'new API must not create a local comment system');

const schema = read('includes/column/schema.php');
for (const table of ['column_documents', 'column_attachments', 'column_document_revisions']) contains('includes/column/schema.php', table);
for (const legacy of ['column_series', 'column_tags', 'column_article_tags', 'column_comments']) contains('includes/column/schema.php', legacy);
check(!schema.includes('CREATE TABLE IF NOT EXISTS column_series'), 'series must remain deferred');
check(!schema.includes('CREATE TABLE IF NOT EXISTS column_comments'), 'comments must remain external to the MVP');
contains('scripts/migrate.php', 'columnMigrateSchema');

const helpers = read('includes/column/helpers.php');
contains('includes/column/helpers.php', 'League\\CommonMark\\CommonMarkConverter');
contains('includes/column/helpers.php', 'body_markdown');
contains('includes/column/helpers.php', 'allow_unsafe_links');
contains('includes/column/helpers.php', 'column-section-');

const react = read('column-react/src/main.jsx');
for (const route of ['/column/', '/column/search/', '/column/article/', '/column/edit/', '/column/my/', '/column/admin/']) check(react.includes(route), `React route missing: ${route}`);
for (const phrase of ['开始编辑', '保存草稿', '发布文章', '我的文章', '最新文章', '按类型浏览', '暂时没有文章']) contains('column-react/src/main.jsx', phrase);
for (const deferred of ['/column/series/', '/column/category/', '/column/tag/', '/column/archive/']) check(!react.includes(deferred), `deferred route should not be linked: ${deferred}`);
for (const required of ['ReactMarkdown', 'vnfestWikiAppearance', 'login: \'force\'', 'imageUploader: false', 'data-reader-theme']) check(react.includes(required), `React behavior missing: ${required}`);

const styles = read('column-react/src/styles.css');
for (const token of ['--vn-primary', '--md-primary', '--md-surface', 'prefers-reduced-motion', 'min-height: 44px', '.column-layout', '.column-page']) check(styles.includes(token), `style contract missing: ${token}`);
check(!styles.includes('#f97316') && !styles.includes('#ff7a18'), 'do not restore an independent orange palette');

const built = read('column/index.html');
for (const required of ['/js/theme-runtime.js', '/js/page-background.js', '/column/assets/']) check(built.includes(required), `built entry missing: ${required}`);
check(!built.includes('language-runtime.js'), 'column entry must stay Chinese-only');

for (const relative of ['Forum/forum-plaza.html', 'Forum/forum-post.html', 'Forum/forum-create.html']) {
  contains(relative, '../column/legacy.css');
  contains(relative, '论坛功能已停止');
}
for (const legacy of ['column/article.html', 'column/write.html', 'column/my.html', 'column/series.html']) check(!exists(legacy), `legacy column entry should be removed: ${legacy}`);

console.log('column contract checks passed');
