import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const auth = read('api/auth.php');
const callback = read('api/bangumi_callback.php');
const accountApi = read('api/bangumi_account.php');
const oauth = read('includes/oauth_bangumi.php');
const migration = read('scripts/migrate.php');
const resumeApi = read('api/galgame_resume.php');
const configExample = read('config.example.php');
const toolHtml = read('tools/GalgameTool/index.html');
const toolJs = read('tools/GalgameTool/galgame-tool.js');
const toolCss = read('tools/GalgameTool/galgame-tool.css');
const userApp = read('user-v2-react/src/App.jsx');

assert.match(auth, /bangumi_bound/);
assert.match(auth, /bangumi_username/);
assert.match(auth, /case ['"]bangumi_auth['"]/);
assert.match(auth, /case ['"]unbind_bangumi['"]/);
assert.match(auth, /authRequireSameOrigin\(\)/, 'Bangumi unbind must be same-origin protected');
assert.match(oauth, /hash_equals\(/, 'OAuth callback flow must verify state with a timing-safe comparison');
assert.match(callback, /bangumiFetchCurrentUser\(/, 'OAuth callback must verify the authorized Bangumi account');
assert.match(callback, /bangumi_user_id\s*=\s*\?\s+AND\s+vnfmap_user_id\s*!=\s*\?/, 'OAuth callback must reject a binding owned by another VNFmap user');
assert.match(callback, /user\.html\?tab=account/, 'OAuth callback should return to account settings');

assert.match(oauth, /Authorization: Bearer/, 'Bangumi API calls must use Bearer authentication');
assert.match(oauth, /bangumiEncryptToken/);
assert.match(oauth, /bangumiDecryptToken/);
assert.match(oauth, /BANGUMI_TOKEN_ENCRYPTION_KEY/);
assert.doesNotMatch(oauth, /echo[^;]*(?:access_token|refresh_token)/i, 'OAuth helper must not echo tokens');

assert.equal((migration.match(/CREATE TABLE IF NOT EXISTS bangumi_bindings/g) || []).length, 2, 'migration should cover MySQL and SQLite');
assert.match(migration, /UNIQUE KEY uq_bangumi_vnfmap_user/);
assert.match(migration, /UNIQUE KEY uq_bangumi_user/);
assert.match(migration, /vnfmap_user_id\s+INTEGER NOT NULL UNIQUE/);
assert.match(migration, /bangumi_user_id\s+INTEGER NOT NULL UNIQUE/);

assert.match(accountApi, /requireLogin\(\)/);
assert.match(accountApi, /subject_type.*4/);
assert.match(accountApi, /type.*2/);
assert.match(oauth, /Authorization: Bearer/);
assert.doesNotMatch(accountApi, /\$_(?:GET|POST)\s*\[\s*['"](?:user_id|bangumi_user_id|access_token)['"]\s*\]/i, 'collections API must not trust client identity or token parameters');
assert.match(accountApi, /image_proxy\.php/);

assert.match(resumeApi, /bangumiId/);
assert.match(resumeApi, /'bgm'/);
assert.match(resumeApi, /'bilibili'/);
assert.match(configExample, /getenv\('BANGUMI_CLIENT_ID'\)/);
assert.match(configExample, /getenv\('BANGUMI_CLIENT_SECRET'\)/);
assert.match(configExample, /getenv\('BANGUMI_TOKEN_ENCRYPTION_KEY'\)/);
assert.doesNotMatch(configExample, /BANGUMI_CLIENT_SECRET['"]\s*,\s*['"][^'"]+['"]/, 'config example must not contain a real client secret');

assert.match(toolHtml, /id="bangumiImportModal"/);
assert.match(toolHtml, /从 Bangumi 导入/);
assert.match(toolHtml, /mobile-tool-action/);
assert.match(toolJs, /BANGUMI_ACCOUNT_API_URL/);
assert.match(toolJs, /action: 'collections'/);
assert.match(toolJs, /bangumiId: id/);
assert.match(toolJs, /item\.bangumiId/);
assert.match(toolCss, /\.bangumi-import-modal/);
assert.match(toolCss, /object-fit: contain/);
assert.match(userApp, /name="Bangumi"/);
assert.match(userApp, /bangumi_auth&mode=bind/);

console.log('Bangumi binding/import contract checks passed');
