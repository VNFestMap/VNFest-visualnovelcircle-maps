import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.join(root, 'api');
const server = fs.readFileSync(path.join(root, 'backend', 'internal', 'httpapi', 'server.go'), 'utf8');
const phpRoutes = fs.readdirSync(apiDir)
  .filter((name) => name.endsWith('.php'))
  .map((name) => `/api/${name}`)
  .sort();
const goRoutes = [...server.matchAll(/"(\/api\/[^"\s]+\.php)"/g)].map((match) => match[1]);
const goSet = new Set(goRoutes);
const missing = phpRoutes.filter((route) => !goSet.has(route));
if (missing.length) {
  throw new Error(`Go route inventory is missing: ${missing.join(', ')}`);
}
if (phpRoutes.length !== 87) {
  throw new Error(`Expected the current API baseline to contain 87 files, found ${phpRoutes.length}`);
}
for (const route of ['/api/health.php', '/api/test.php', '/api/auth.php', '/api/galonly.php']) {
  if (!goSet.has(route)) throw new Error(`critical Go route is missing: ${route}`);
}
for (const route of ['/api/public/v1/clubs.php', '/api/public/v1/club.php', '/api/public/v1/manifest.php']) {
  if (!goSet.has(route)) throw new Error(`remote public API route is missing: ${route}`);
}
console.log(`Go route inventory passed: ${phpRoutes.length} PHP paths have explicit Go registrations`);
