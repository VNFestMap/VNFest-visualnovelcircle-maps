import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'club-manager-react', 'dist', 'club-manager-assets');
const target = path.join(root, 'admin', 'club-manager-assets');
const shellPath = path.join(root, 'admin', 'club_manager.html');
const manifestPath = path.join(target, '.generated-assets.json');

async function listFiles(dir, prefix = '') {
  const result = [];
  for (const name of await readdir(dir)) {
    const absolute = path.join(dir, name); const relative = path.join(prefix, name); const info = await stat(absolute);
    if (info.isDirectory()) result.push(...await listFiles(absolute, relative)); else result.push(relative.replaceAll('\\', '/'));
  }
  return result;
}

const files = await listFiles(dist);
const entryJs = files.find((name) => /^index-[\w-]+\.js$/.test(name));
const entryCss = files.find((name) => /^index-[\w-]+\.css$/.test(name));
if (!entryJs || !entryCss) throw new Error(`Vite entry assets missing in ${dist}`);

await mkdir(target, { recursive: true });
let previous = [];
try { previous = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { /* First managed build: preserve every pre-existing asset. */ }
for (const relative of previous.filter((name) => !files.includes(name))) {
  const stale = path.resolve(target, relative);
  if (stale.startsWith(`${path.resolve(target)}${path.sep}`)) await rm(stale, { force: true });
}
for (const relative of files) {
  const destination = path.join(target, relative); await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(dist, relative), destination, { force: true });
}
await writeFile(manifestPath, `${JSON.stringify(files, null, 2)}\n`, 'utf8');

let shell = await readFile(shellPath, 'utf8');
shell = shell
  .replace(/\.\/club-manager-assets\/index-[\w-]+\.css/g, `./club-manager-assets/${entryCss}`)
  .replace(/\.\/club-manager-assets\/index-[\w-]+\.js/g, `./club-manager-assets/${entryJs}`);
await writeFile(shellPath, shell, 'utf8');
for (const relative of [entryJs, entryCss]) await stat(path.join(target, relative));
console.log(`club_manager.html -> ${entryJs}, ${entryCss}; copied ${files.length} assets without deleting existing files.`);
