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
  'api/posts.php',
  'api/post_images.php',
  'api/user_banner.php',
  'api/messages.php',
  'includes/posts/schema.php',
  'includes/posts/helpers.php',
  'scripts/column/migrate-column.php',
  'scripts/column/sync-column-build.mjs',
]) check(exists(relative), `missing ${relative}`);

const api = read('api/posts.php');
for (const action of ['bootstrap', 'feed', 'detail', 'mine', 'create', 'delete', 'like', 'unlike']) {
  contains('api/posts.php', `'${action}'`);
}

const schema = read('includes/posts/schema.php');
for (const table of ['posts', 'post_likes', 'post_attachments']) contains('includes/posts/schema.php', table);

contains('scripts/migrate.php', 'postsMigrateSchema');
check(!read('scripts/migrate.php').includes('columnMigrateSchema'), 'old column migration must be unhooked');

const helpers = read('includes/posts/helpers.php');
contains('includes/posts/helpers.php', 'POSTS_CONTENT_MAX');
contains('includes/posts/helpers.php', 'postsRequireSameOrigin');
contains('includes/posts/helpers.php', 'post_attachments');

const react = read('column-react/src/main.jsx');
for (const route of ['/column/', '/column/post/', '/column/my/', '/column/user/', '/column/messages/', '/column/search/']) check(react.includes(route), `React route missing: ${route}`);
for (const phrase of ['有什么新鲜事', '同好会动态', '个人空间', '引用转发', '已经到底啦', '关注', '为你推荐', '关联同好会', '消息', '好友']) contains('column-react/src/main.jsx', phrase);
check(!react.includes('推文'), '推文 wording must stay replaced by 动态');
check(react.includes('CropModal'), 'crop modal must exist');
check(!react.includes("pt-side-search"), 'right sidebar search box must stay removed');

const styles = read('column-react/src/styles.css');
for (const token of ['--pt-accent', 'var(--vn-primary)', 'prefers-reduced-motion', '@media (max-width: 680px)']) {
  check(styles.includes(token), `style contract missing: ${token}`);
}
check(!styles.includes('has-vnfest-wallpaper'), 'wallpaper stays disabled on this page');

const entry = read('column-react/index.html');
for (const required of ['site-header.js', 'site-header.css', 'topbar', 'data-page-name']) check(entry.includes(required), `entry missing: ${required}`);
check(!entry.includes('page-background.js'), 'page background must stay disabled');

const built = read('column/index.html');
for (const required of ['/js/theme-runtime.js', '/column/assets/']) check(built.includes(required), `built entry missing: ${required}`);
check(!built.includes('page-background.js'), 'built entry must not load the wallpaper');

for (const relative of ['Forum/forum-plaza.html', 'Forum/forum-post.html', 'Forum/forum-create.html']) {
  contains(relative, '../column/legacy.css');
  contains(relative, '论坛功能已停止');
}

console.log('posts contract checks passed');
