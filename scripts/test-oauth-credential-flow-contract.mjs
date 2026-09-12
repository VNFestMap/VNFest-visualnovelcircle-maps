import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const qqCallback = read('api/qq_callback.php');
const discordCallback = read('api/discord_callback.php');
const authApi = read('api/auth.php');
const authSession = read('includes/auth.php');
const migration = read('scripts/migrate.php');
const loginPage = read('login.html');
const userSource = read('user-v2-react/src/App.jsx');
const oauthHelper = read('includes/oauth_account.php');

assert.doesNotMatch(qqCallback, /INSERT\s+INTO\s+users/i, 'QQ callback must not create an incomplete user directly');
assert.doesNotMatch(discordCallback, /INSERT\s+INTO\s+users/i, 'Discord callback must not create an incomplete user directly');
assert.match(qqCallback, /oauthAccountProcessCallback/, 'QQ callback should use the shared OAuth finalizer');
assert.match(discordCallback, /oauthAccountProcessCallback/, 'Discord callback should use the shared OAuth finalizer');

for (const action of [
  'oauth_pending',
  'oauth_send_code',
  'oauth_verify_code',
  'oauth_complete_account',
  'oauth_link_existing',
  'oauth_transfer_provider',
  'set_password',
]) {
  assert.match(authApi, new RegExp(`case ['"]${action}['"]`), `${action} should be exposed by auth.php`);
}

assert.match(authApi, /OAUTH_BIND_REQUIRED/, 'legacy client-submitted provider IDs must be rejected');
assert.doesNotMatch(authApi, /const\s+openid\s*=\s*trim\(\$input\['openid'\]/, 'QQ OpenID must not come from request JSON');
assert.doesNotMatch(authApi, /const\s+discordId\s*=\s*trim\(\$input\['discord_id'\]/, 'Discord ID must not come from request JSON');

assert.match(authSession, /credentials_completed_at/, 'auth session data should expose credential completion state');
assert.match(migration, /oauth_account_challenges/, 'migration should create the OAuth challenge table');
assert.match(migration, /credentials_completed_at/, 'migration should add credential completion state');
assert.match(loginPage, /oauthSetupForm/, 'login page should contain the OAuth credential setup view');
assert.match(userSource, /setPassword/, 'user center should expose the optional legacy password upgrade');
assert.match(oauthHelper, /function\s+oauthAccountProcessCallback/, 'shared OAuth account helper should own callback routing');

console.log('OAuth credential flow contract checks passed');
