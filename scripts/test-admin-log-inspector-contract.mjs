import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const reviewsPath = path.join(root, 'admin', 'reviews.html');
const apiPath = path.join(root, 'api', 'admin_logs.php');
const auditPath = path.join(root, 'includes', 'audit.php');

const reviews = fs.readFileSync(reviewsPath, 'utf8');
const api = fs.readFileSync(apiPath, 'utf8');
const audit = fs.readFileSync(auditPath, 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function walkPhp(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'vendor'].includes(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkPhp(entryPath, output);
    else if (entry.name.endsWith('.php')) output.push(entryPath);
  }
  return output;
}

// Parse the page's inline script as JavaScript before checking individual contracts.
const inlineScripts = [...reviews.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
assert(inlineScripts.length > 0, 'reviews.html must contain an inline application script');
inlineScripts.forEach((source, index) => new vm.Script(source, { filename: `reviews-inline-${index}.js` }));

for (const token of [
  'id="logSearch"', 'id="logTypeFilter"', 'id="logDateFrom"', 'id="logDateTo"',
  'id="logHighRiskCount"', 'id="logContextCount"', 'id="logPrevPage"', 'id="logNextPage"',
  'function showLogDetail', 'function detectLogOutcome', 'function detectClient', 'function getLogActionDefinition'
]) {
  assert(reviews.includes(token), `reviews.html missing log inspector contract: ${token}`);
}

for (const category of ['auth', 'review', 'club', 'vote', 'recognition', 'forum', 'integration', 'system']) {
  assert(reviews.includes(`option value="${category}"`), `reviews.html missing category option: ${category}`);
  assert(api.includes(`'${category}'`), `admin_logs.php missing category filter: ${category}`);
}

for (const field of ['al.target_type LIKE ?', 'CAST(al.target_id AS CHAR)', 'al.ip_address LIKE ?', 'u.role AS current_role', "['details_decoded']", "['request_context']"]) {
  assert(api.includes(field), `admin_logs.php missing enriched search/output field: ${field}`);
}
assert(api.includes("$currentUser['role'] !== 'super_admin'"), 'admin_logs.php must remain restricted to super administrators');

for (const field of ["'method'", "'path'", "'user_agent'", "'actor_role'"]) {
  assert(audit.includes(field), `audit.php missing request context field: ${field}`);
}
assert(audit.includes('parse_url((string)$_SERVER[\'REQUEST_URI\'], PHP_URL_PATH)'), 'audit.php must store the path without the query string');
assert(!audit.includes("'query' =>"), 'audit.php must not persist request query strings');

// Exercise the real explanation table against every statically declared action in PHP.
const definitionStart = reviews.indexOf('const LOG_ACTION_DEFINITIONS');
const definitionEnd = reviews.indexOf('function parseLogDetails', definitionStart);
assert(definitionStart !== -1 && definitionEnd > definitionStart, 'could not locate action definition block');
const actions = new Set();
for (const phpPath of walkPhp(root)) {
  const source = fs.readFileSync(phpPath, 'utf8');
  for (const match of source.matchAll(/logAction\(\s*['"]([^'"]+)['"]/g)) actions.add(match[1]);
}
const context = { actions: [...actions] };
vm.createContext(context);
vm.runInContext(
  reviews.slice(definitionStart, definitionEnd) +
    '; globalThis.coverage = actions.map(action => [action, getLogActionDefinition(action).label]);',
  context
);
const unknown = context.coverage.filter(([, label]) => label === '未归类操作').map(([action]) => action);
assert(unknown.length === 0, `missing action explanations: ${unknown.join(', ')}`);

console.log(`Admin log inspector contract OK (${actions.size} static actions explained)`);
