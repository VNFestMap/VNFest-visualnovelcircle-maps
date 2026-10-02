import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'galonly-booth-react', 'dist');
const publicRoot = path.join(root, 'Galgame_events');
const assetSource = path.join(dist, 'galonly-booth-assets');
const assetTarget = path.join(publicRoot, 'galonly-booth-assets');

await mkdir(publicRoot, { recursive: true });
await rm(assetTarget, { recursive: true, force: true });
await cp(assetSource, assetTarget, { recursive: true });
for (const [sourceName, targetName] of [['admin.html', 'Beijing_GalOnly_booth_admin.html'], ['portal.html', 'Beijing_GalOnly_booth_portal.html']]) {
  const html = await readFile(path.join(dist, sourceName), 'utf8');
  await writeFile(path.join(publicRoot, targetName), html, 'utf8');
}
console.log(`synced GalOnly booth portal build to ${publicRoot}`);
