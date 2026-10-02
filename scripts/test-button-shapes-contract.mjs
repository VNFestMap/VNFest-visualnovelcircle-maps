import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = new Set(['node_modules', '.git', 'www', 'dist', 'dist2', 'vendor', '_local', 'artifacts', 'exports', 'build', '参考', '.codex', '.agents', '.gstack', '.opensquilla', '.opensquilla-cache', '.workbuddy', 'downloads', 'uploads', 'docs']);
const reactRoots = ['club-manager-react', 'user-v2-react', 'column-react', 'galonly-booth-react'];
const css = fs.readFileSync(path.join(root, 'css/button-shapes.css'), 'utf8');
assert.match(css, /--vn-button-radius:\s*9999px/);
assert.match(css, /\[data-button-shape="keep"\] \*/);
assert.match(css, /border-radius:\s*50% !important/);
// Shape/alignment CSS must never reset typography, dimensions or colors.
for (const declaration of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([\w-]+)\s*:\s*[^{};]+;/g)) {
  assert.ok(['--vn-button-radius', 'border-radius', 'display', 'vertical-align', 'align-items', 'justify-content', 'align-content', 'text-align'].includes(declaration[1]), declaration[1]);
}
let count = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replaceAll('\\', '/');
    if (reactRoots.includes(relative) || relative === 'Game/spy' || relative === 'Game/spy-react') continue;
    if (entry.isDirectory()) { walk(absolute); continue; }
    if (!relative.endsWith('.html') || /(?:canvas-design|rank-demo|Prototype)\.html$/.test(relative)) continue;
    const html = fs.readFileSync(absolute, 'utf8');
    if (!/<\/head>/i.test(html)) continue;
    const link = html.match(/<link\b[^>]*href="([^"]*button-shapes\.css)(?:\?[^"]*)?"[^>]*>/i);
    if (link) {
      assert.equal(path.resolve(path.dirname(absolute), link[1]), path.join(root, 'css/button-shapes.css'), relative + ': relative CSS path');
    } else {
      // Vite runtime entries ship the common stylesheet inside their CSS bundle.
      const bundledStyles = [...html.matchAll(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/gi)];
      assert.ok(bundledStyles.some(([, href]) => {
        const file = href.startsWith('/') ? path.join(root, href) : path.resolve(path.dirname(absolute), href);
        return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('--vn-button-radius');
      }), relative + ': missing common button shapes');
    }
    count++;
  }
}
walk(root);
for (const module of reactRoots) assert.ok(fs.readFileSync(path.join(root, module, 'src/main.jsx'), 'utf8').includes('button-shapes.css'), module + ': source import');
const generator = fs.readFileSync(path.join(root, 'scripts/generate-wiki-pages.mjs'), 'utf8');
assert.ok(generator.includes('../../css/button-shapes.css') && generator.includes('../css/button-shapes.css'), 'both Wiki generation templates');
console.log(`PASS: ${count} runtime HTML entries, ${reactRoots.length} React source imports, Wiki generation templates and shape/alignment stylesheet.`);
