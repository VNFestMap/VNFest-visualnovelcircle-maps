import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');
const notifications = read('backend', 'internal', 'httpapi', 'notifications.go');
const bot = read('backend', 'internal', 'httpapi', 'bot.go');
const phpBot = read('api', 'bot.php');
const bangumi = read('backend', 'internal', 'httpapi', 'bangumi.go');
const posts = read('backend', 'internal', 'httpapi', 'posts.go');
const column = read('column-react', 'src', 'main.jsx');
const recognition = read('club-manager-react', 'src', 'tabs', 'RecognitionTab.jsx');

assert.ok(notifications.includes('"title": databaseValueString(title)') && notifications.includes('"message": databaseValueString(message)'), 'Go notification text fields must be converted from database byte slices before JSON encoding');
assert.ok(bot.includes('revoked_at) VALUES(?,?,?,?,?,?,?,NULL)'), 'Go Bot token creation must explicitly initialize revoked_at to NULL');
assert.ok(bot.includes('revokedAt == nil') && !bot.includes('databaseValueString(revoked) == ""'), 'Go Bot token listing must treat SQL NULL revoked_at as active');
assert.ok(phpBot.includes('created_by, revoked_at)') && phpBot.includes('VALUES (?, ?, ?, ?, ?, ?, ?, NULL)'), 'PHP Bot token creation must explicitly initialize revoked_at to NULL');
assert.ok(bangumi.includes('func bangumiImageURLForRow') && bangumi.includes('row["images"]'), 'Bangumi normalization must read the v0 images object');
assert.ok(bangumi.includes('strings.HasPrefix(value, "/api/image_proxy.php?")'), 'Bangumi normalization must preserve existing image proxy paths');
assert.ok(posts.includes('"name": s.clubCodeClubName(r.Context(), cid, country)'), 'selectable clubs for the post composer must include a display name');
assert.ok(posts.includes('"club": club') && posts.includes('club = map[string]any'), 'serialized posts must expose the associated club to the feed UI');
assert.ok(column.includes('function clubDisplayName') && column.includes('clubDisplayName(c).toLowerCase()'), 'the club picker must tolerate APIs that omit the legacy name field');
assert.ok(column.includes('return data.posts || { posts: [], next_before_id: null }'), 'search results must unwrap the nested post timeline before feeding the cursor list');
assert.ok(column.includes('登录后即可查看自己的动态。'), 'the unauthenticated mine route must render a visible login state');
assert.ok(recognition.includes('result.version?.content') && recognition.includes('content: returnedProgram.content || versionContent'), 'recognition editor must read version.content from the detail API');

console.log('club regression contract checks passed');
