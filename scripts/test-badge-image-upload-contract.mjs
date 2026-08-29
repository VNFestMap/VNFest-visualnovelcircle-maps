import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

const endpoint = read('api/badge_image.php');
assert.ok(endpoint.includes("action=upload") || endpoint.includes("'upload'"), 'badge image endpoint should expose an upload action');
assert.ok(endpoint.includes('2 * 1024 * 1024'), 'badge image upload should cap files at 2MB');
assert.ok(endpoint.includes('exif_imagetype') && endpoint.includes('getimagesize'), 'badge image upload should sniff real image types with a getimagesize fallback');
assert.ok(endpoint.includes('IMAGETYPE_JPEG') && endpoint.includes('IMAGETYPE_PNG') && endpoint.includes('IMAGETYPE_GIF') && endpoint.includes('IMAGETYPE_WEBP'), 'badge image upload should only accept JPEG/PNG/GIF/WebP');
assert.ok(endpoint.includes("recogHasRole($user, $clubId, $country, 'badge_manager')") && endpoint.includes('canManageClub'), 'badge image upload should reuse badge manager authorization');
assert.ok(endpoint.includes('data/badge_images'), 'badge images should be stored under data/badge_images');
assert.ok(endpoint.includes('image_url'), 'badge image upload should return a site-relative image_url');

assert.ok(fs.existsSync(path.join(root, 'data/badge_images/.gitkeep')), 'data/badge_images/.gitkeep should keep the upload directory in git');

const programs = read('api/recognition_programs.php');
assert.ok(programs.includes("case 'badge_update'"), 'recognition programs API should expose badge_update');
assert.ok(programs.includes('image_url'), 'recognition programs API should persist badge image_url');
assert.ok(programs.includes("case 'caps_reference'"), 'recognition programs API should expose the three-tier capability reference');

const recogTab = read('admin/club_manager_recognition.js');
assert.ok(recogTab.includes('badge_image.php?action=upload'), 'recognition tab should upload badge images through badge_image.php');

console.log('badge image upload contract tests passed');
