import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(root, 'column-react', 'dist');
const target = path.join(root, 'column');

if (!fs.existsSync(path.join(source, 'index.html'))) throw new Error('column-react/dist/index.html not found; build React first');

for (const relative of ['index.html', 'legacy.css', '.htaccess', 'article.html', 'write.html', 'my.html', 'series.html']) {
  const file = path.join(target, relative);
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
}
for (const relative of ['assets', 'css', 'js']) {
  const directory = path.join(target, relative);
  if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
}

fs.mkdirSync(path.join(target, 'assets'), { recursive: true });
for (const file of ['index.html', 'legacy.css', '.htaccess']) fs.copyFileSync(path.join(source, file), path.join(target, file));
for (const file of fs.readdirSync(path.join(source, 'assets'))) fs.copyFileSync(path.join(source, 'assets', file), path.join(target, 'assets', file));

console.log('column React build synced to column/');
