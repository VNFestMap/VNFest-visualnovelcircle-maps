import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const candidates = [
  path.resolve(process.cwd(), 'astrbot_plugin_galgamemap'),
  path.resolve(process.cwd(), '..', 'astrbot_plugin_galgamemap'),
];
const pluginDir = candidates.find((dir) => fs.existsSync(path.join(dir, 'main.py')));
assert.ok(pluginDir, 'astrbot_plugin_galgamemap should be available next to the VNFmap checkout');

const main = fs.readFileSync(path.join(pluginDir, 'main.py'), 'utf8');
const metadata = fs.readFileSync(path.join(pluginDir, 'metadata.yaml'), 'utf8');
const commands = [...main.matchAll(/@command\("([^"]+)"(?:,\s*alias=\{([^}]*)\})?\)/g)];

assert.equal(commands.length, 1, 'the plugin should expose one consolidated command handler');
assert.equal(commands[0][1], 'galmap', 'galmap should remain the active primary command');
assert.match(commands[0][2] || '', /"gal地图"/, 'gal地图 should be registered as an alias');
assert.doesNotMatch(main, /@command\("gal地图"\)/, 'gal地图 must not have a separate handler');
assert.doesNotMatch(main, /async def gal_map_command\b/, 'the duplicate gal_map_command handler must be removed');
assert.match(metadata, /^version:\s*beta0\.6\s*$/m, 'plugin metadata should advertise beta0.6');

console.log('astrbot command alias regression test passed');
