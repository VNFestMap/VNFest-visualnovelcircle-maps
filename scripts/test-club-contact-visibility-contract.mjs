import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const mainland = read('api/clubs.php');
const japan = read('api/clubs_japan.php');
const membership = read('api/membership.php');

for (const [name, source] of [['mainland', mainland], ['japan', japan]]) {
  assert.match(source, /\$canSeeProtected = \$effectiveLevel >= ROLE_HIERARCHY\['manager'\];/, `${name}: managers and representatives must see protected club contact/group information`);
  assert.match(source, /\$item\['info_hidden'\] = !\$isMember && !\$hasPending && !\$canSeeProtected;/, `${name}: protected contact visibility must continue to use the scoped visibility decision`);
}

assert.doesNotMatch(membership, /unset\(\$m\['qq_account'\], \$m\['contact_account'\]/, 'the authorized member roster must retain contact/group accounts for the club management UI');
assert.match(membership, /仅隐藏与成员管理无关的敏感申请资料/, 'the roster contact disclosure must be documented as a scoped management exception');

console.log('club contact visibility contract tests passed');
