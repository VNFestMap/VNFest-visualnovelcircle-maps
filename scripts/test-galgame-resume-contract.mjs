import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const html = read('tools/GalgameTool/index.html');
const css = read('tools/GalgameTool/galgame-tool.css');
const js = read('tools/GalgameTool/galgame-tool.js');
const api = read('api/galgame_resume.php');
const migration = read('scripts/migrate.php');
const clubSquare = read('club_square.html');

assert.match(html, /href="\.\/galgame-tool\.css\?v=/, 'tool HTML should use the split stylesheet');
assert.match(html, /src="\.\/galgame-tool\.js\?v=/, 'tool HTML should use the split application script');
assert.match(html, /id="resumeSyncStatus"/, 'tool HTML should expose cloud sync status');
assert.match(html, /id="exportProgress"/, 'tool HTML should expose export progress');
assert.match(clubSquare, /href="\.\/tools\/GalgameTool\/index\.html"[^>]*aria-label="自助工具/, 'club square should retain the tool entry');

assert.match(js, /bishoujo_resume_data:guest/, 'guest drafts should be isolated');
assert.match(js, /bishoujo_resume_data:user:/, 'account drafts should be isolated by user id');
assert.match(js, /\.\.\/api\/galgame_resume\.php/, 'tool should resolve the resume API from its current directory');
assert.match(js, /setTimeout\(async \(\) => \{[\s\S]*?\}, 800\)/, 'cloud saves should be debounced');
assert.match(js, /delete toSave\.searchResults/, 'runtime search results must not be saved');
assert.match(js, /delete toSave\.selectedItems/, 'runtime selections must not be saved');

assert.match(css, /--vn-primary:\s*#e67e22/i, 'GalgameTool should use VNFest orange');
assert.match(css, /\.resume-section\.works-section \.section-label::before/, 'works title should have an accent bar');
assert.match(css, /\.resume-section\.heroine-section \.section-label::before/, 'heroine title should have an accent bar');
assert.match(css, /\.export-progress\.is-active/, 'export progress should have an active animation state');
assert.match(css, /repeating-linear-gradient/, 'export progress should show stage markers');
assert.match(css, /export-progress-glow/, 'export progress should have a custom motion treatment');

assert.match(api, /requireLogin\(\)/, 'resume API must require an authenticated session');
assert.match(api, /galgameResumeIsSameOrigin/, 'resume writes must be same-origin protected');
assert.match(api, /GALGAME_RESUME_MAX_BYTES\s*=\s*10485760/, 'resume API must enforce the 10 MiB limit');
for (const action of ['load', 'save', 'reset']) {
  assert.match(api, new RegExp(`['"]${action}['"]`), `resume API should support ${action}`);
}
assert.doesNotMatch(api, /\$_(?:GET|POST)\s*\[\s*['"]user_id['"]\s*\]/, 'resume API must not trust a client user id');
assert.match(api, /FROM galgame_resumes WHERE user_id = \?/i, 'resume API should scope reads to the session user');
assert.match(api, /DELETE FROM galgame_resumes WHERE user_id = \?/i, 'resume reset should scope deletes to the session user');

assert.equal((migration.match(/galgame_resumes/g) || []).length >= 2, true, 'migration should cover MySQL and SQLite');
assert.match(migration, /payload\s+LONGTEXT/i, 'MySQL should use LONGTEXT for image-bearing JSON');
assert.match(migration, /payload\s+TEXT/i, 'SQLite should use TEXT for image-bearing JSON');
assert.match(migration, /CREATE TABLE IF NOT EXISTS galgame_resumes/i, 'migration should be idempotent');

console.log('Galgame resume contract checks passed');
