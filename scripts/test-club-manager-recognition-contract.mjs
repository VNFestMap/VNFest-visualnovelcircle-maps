import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

const manager = read('admin/club_manager.html');
assert.match(manager, /data-tab="recognition"/, 'club manager sidebar must expose the recognition tab');
assert.match(manager, /recognition:'考核设置'/, 'tab name map must label the recognition tab');
assert.match(manager, /if \(tab === 'recognition'\) \{\s*renderRecognition\(\);/, 'renderList must dispatch the recognition tab');
assert.match(manager, /<script src="club_manager_recognition\.js/, 'recognition tab logic must live in the external script');
assert.match(manager, /\?tab=.*recognition/, 'club manager must document the recognition deep link');
assert.ok(!manager.includes('galonly-poster-theme.css'), 'club manager must not import the poster theme globally');

const recog = read('admin/club_manager_recognition.js');
assert.match(recog, /async function renderRecognition\s*\(/, 'recognition tab must define renderRecognition');
for (const tier of ['standard', 'advanced', 'expert']) {
  assert.match(recog, new RegExp(`data-tier="${tier}"`), `tier selector must offer the ${tier} tier`);
}
assert.match(recog, /即将开放/, 'unreleased advanced/expert features must show a coming-soon placeholder');
assert.match(recog, /badge_image\.php\?action=upload/, 'badge image upload must call api/badge_image.php');
assert.match(recog, /\.recog-/, 'recognition tab styles must use scoped .recog-* classes');
assert.match(recog, /recognition_programs\.php/, 'recognition tab must call the recognition programs API');
const collectPayload = recog.match(/function recogCollectPayload\s*\([\s\S]*?\n\}/)?.[0] || '';
assert.ok(collectPayload, 'recognition tab must build the save payload via recogCollectPayload');
assert.ok(!/^\s*tier:/m.test(collectPayload), 'save payload must not persist a tier field (tier is derived from capabilities)');

console.log('club manager recognition contract tests passed');
