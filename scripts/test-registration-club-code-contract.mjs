import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const login = read('login.html');
const authApi = read('api/auth.php');
const clubCodesApi = read('api/club_codes.php');
const clubCodeHelper = read('includes/club_code.php');

assert.match(login, /id="regClubCode"/, 'registration should expose an optional club binding code field');
assert.match(login, /var clubCode = document\.getElementById\('regClubCode'\)\.value\.trim\(\)/,
  'registration should read the optional club binding code');
assert.match(login, /club_code:\s*clubCode/,
  'registration should send the optional club binding code to the auth API');
assert.match(login, /if \(!username \|\| !password \|\| !email \|\| !code\)/,
  'the optional club binding code must not become a required registration field');

assert.match(authApi, /require_once __DIR__ \. '\/\.\.\/includes\/club_code\.php';/,
  'auth API should load the shared club code service');
assert.match(authApi, /\$clubBindCode = trim\(\(string\)\(\$input\['club_code'\] \?\? ''\)\)/,
  'auth API should accept the club_code payload field');
assert.match(authApi, /\$db->beginTransaction\(\);[\s\S]*?clubCodeBindUser\(/,
  'registration and optional membership binding should share one transaction');
assert.match(authApi, /throw new ClubCodeBindingException\(\$clubBinding\['message'\]\)/,
  'an invalid optional code should roll back the new account instead of silently ignoring the input');
assert.match(authApi, /\$response\['club_binding'\]\s*=/,
  'successful registration should report the club binding result');

assert.match(clubCodesApi, /require_once __DIR__ \. '\/\.\.\/includes\/club_code\.php';/,
  'direct club code redemption should use the shared service');
assert.match(clubCodesApi, /clubCodeEnsureMembershipColumns\(\$db\)/,
  'direct club code redemption should retain old-schema compatibility');
assert.match(clubCodesApi, /clubCodeBindUser\(\$db, \(int\)\$user\['id'\], \$code\)/,
  'direct club code redemption should use the shared binding operation');

assert.match(clubCodeHelper, /FOR UPDATE/,
  'MySQL binding should lock the code row during a transaction');
assert.match(clubCodeHelper, /use_count < max_uses/,
  'binding should enforce the usage limit atomically');
assert.match(clubCodeHelper, /status = 'active'/,
  'binding should create or restore an active membership');
assert.match(clubCodeHelper, /join_method = 'school_code'/,
  'binding should record the existing school-code join method');

console.log('registration club code contract checks passed');
