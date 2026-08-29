import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

const app = read('user-v2-react/src/App.jsx');
assert.ok(app.includes("['overview', 'account', 'preferences', 'clubs', 'notifications', 'achievements']"), 'user center should whitelist tab deep links including achievements');
assert.ok(app.includes("new URLSearchParams(window.location.search).get('tab')"), 'user center should honor ?tab= deep links for outbox notification links');
assert.ok(app.includes("key: 'achievements'"), 'user center menu should expose an achievements entry');
assert.ok(app.includes('AchievementsTab'), 'user center should render the achievements tab component');

const achievements = read('user-v2-react/src/AchievementsTab.jsx');
assert.ok(achievements.includes('recognition_credentials.php'), 'achievements tab should read credentials through the recognition credentials API');
assert.ok(achievements.includes('?action=my'), 'achievements tab should load the caller credential list');
assert.ok(achievements.includes('?action=set_visibility'), 'achievements tab should let users toggle credential visibility');
assert.ok(achievements.includes('verify.html?uid='), 'achievements tab should link each credential to the public verify page');

const assetFiles = fs.readdirSync(path.join(root, 'user-v2-assets')).filter((file) => file.endsWith('.js'));
assert.ok(assetFiles.length > 0, 'user-v2-assets should contain built JS bundles');
const bundle = assetFiles.map((file) => read(path.join('user-v2-assets', file))).join('\n');
assert.ok(bundle.includes('recognition_credentials.php'), 'built user center bundle should include the achievements API calls');

const outbox = read('includes/recognition/outbox.php');
assert.ok(outbox.includes('/user.html?tab=achievements'), 'outbox notifications should deep-link into the user center achievements tab');
assert.ok(!outbox.includes('/achievements.html'), 'outbox notifications must not link to the removed achievements.html page');

const credentialsApi = read('api/recognition_credentials.php');
assert.ok(credentialsApi.includes('includes/recognition/pipeline.php'), 'credential API should load the recognition pipeline (grant/manual issuance helpers)');

console.log('recognition user contract tests passed');
