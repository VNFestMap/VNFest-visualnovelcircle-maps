import fs from 'fs';
import assert from 'assert/strict';

const authApi = fs.readFileSync('api/auth.php', 'utf8');
const authInclude = fs.readFileSync('includes/auth.php', 'utf8');
const appJs = fs.readFileSync('js/app.js', 'utf8');

assert.match(authInclude, /session\.cookie_samesite/, 'sessions should set a SameSite cookie policy');
assert.match(authInclude, /\$newId\s*=\s*session_create_id\s*\(/, 'login should create a fresh PHP session id');
assert.match(authInclude, /session_id\s*\(\s*\$newId\s*\)/, 'login should switch to the fresh session after saving it');
assert.doesNotMatch(authInclude, /\$_REQUEST\s*\[\s*['"]admin_token['"]\s*\]/, 'legacy admin token must not be accepted from query/body params');

assert.match(authApi, /function\s+publicAuthUser\s*\(/, 'auth API should centralize public user serialization');
assert.doesNotMatch(authApi, /['"]debug_code['"]\s*=>/, 'email verification codes must never be returned by API responses');
assert.doesNotMatch(authApi, /['"]qq_openid['"]\s*=>/, 'QQ OpenID must not be serialized to frontend responses');
assert.doesNotMatch(authApi, /['"]discord_id['"]\s*=>/, 'Discord ID must not be serialized to frontend responses');
assert.match(authApi, /['"]qq_bound['"]\s*=>/, 'frontend should receive only QQ bind state');
assert.match(authApi, /['"]discord_bound['"]\s*=>/, 'frontend should receive only Discord bind state');
assert.match(authApi, /case\s+['"]send_password_reset_code['"]\s*:/, 'auth API should support sending password reset codes');
assert.match(authApi, /case\s+['"]reset_password['"]\s*:/, 'auth API should support resetting passwords');
assert.match(authApi, /password_hash\s*=\s*\?/, 'password reset should update only the password hash through a prepared statement');
assert.match(authApi, /invalidateUserSessions\s*\(\s*\(int\)\$user\['id'\]\s*\)/, 'password reset should revoke all sessions through the shared helper');
assert.match(authInclude, /UPDATE\s+sessions\s+SET\s+is_valid\s*=\s*0\s+WHERE\s+user_id\s*=\s*\?/i, 'global revocation should invalidate existing sessions');

assert.match(appJs, /qq_bound/, 'frontend should read QQ bind state without raw OpenID');
assert.match(appJs, /discord_bound/, 'frontend should read Discord bind state without raw Discord ID');

console.log('Backend privacy contract checks passed');
