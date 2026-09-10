import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

const helper = read('includes/image_host.php');
const migration = read('scripts/migrate-images-to-picui.php');
const compose = read('docker-compose.yml');
const dockerfile = read('Dockerfile');
const config = read('config.example.php');
const envExample = read('.env.example');

assert.match(helper, /Authorization: Bearer/);
assert.match(helper, /Accept: application\/json/);
assert.match(helper, /\/upload/);
assert.match(helper, /\['data'\]\['links'\]\['url'\]/);
assert.match(helper, /imageHostIsTrustedUrl/);
assert.match(helper, /PICUI_FALLBACK_LOCAL/);
assert.match(helper, /sha256/);
assert.match(helper, /Retry-After|retry-after/);
assert.match(helper, /local_backup/);
assert.match(migration, /--dry-run/);
assert.match(migration, /--resume/);
assert.match(migration, /--rewrite/);
assert.match(migration, /--verify/);
assert.match(migration, /galonly_applications WHERE status IN/);
assert.match(migration, /publication_previews\.json/);
assert.match(compose, /PICUI_TOKEN=\$\{PICUI_TOKEN/);
assert.match(dockerfile, /curl/);
for (const source of [helper, migration, config, envExample, compose]) {
  assert.doesNotMatch(source, /3102\|h9RbcWqdfG6gRl7dzD7LPhUJAHHyUNmfQHsWX0pb/);
}

for (const endpoint of ['api/avatar.php', 'api/club_avatar.php', 'api/wiki.php', 'api/galonly.php', 'api/publication_previews.php']) {
  assert.match(read(endpoint), /image_host\.php/);
}

assert.match(read('api/publication_previews.php'), /page_urls/);
assert.match(read('api/galonly.php'), /galonlyPromotePublicImages/);
assert.doesNotMatch(read('api/avatar.php'), /@unlink\(/);
assert.doesNotMatch(read('api/club_avatar.php'), /@unlink\(/);

console.log('image host contract tests passed');
