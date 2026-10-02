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
  'function showLogDetail', 'function detectLogOutcome', 'function detectClient', 'function getLogActionDefinition',
  'function startLogAutoRefresh', 'function stopLogAutoRefresh', 'setInterval(function()', '15000',
  "document.addEventListener('visibilitychange'", "window.addEventListener('focus'",
  'new AbortController()', 'logRequestSequence', 'currentModule === \'logs\'', 'document.hidden'
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

// Exercise the same table against the Go audit middleware's action families.
// The middleware derives `name.<verb>` from the API module and action, so a new
// module must still produce a readable label instead of 「未归类操作」.
const auditGoPath = path.join(root, 'backend', 'internal', 'httpapi', 'audit.go');
const auditSource = fs.readFileSync(auditGoPath, 'utf8');
const goModules = new Set();
for (const match of auditSource.matchAll(/case "([a-z_]+)":/g)) goModules.add(match[1]);
for (const match of auditSource.matchAll(/"([a-z_]+)",\s*"([a-z_]+)"/g)) {
  goModules.add(match[1]);
  goModules.add(match[2]);
}
for (const match of auditSource.matchAll(/"([a-z_]+)\.\+"/g)) goModules.add(match[1]);
const goVerbs = ['create', 'update', 'delete', 'publish', 'submit', 'withdraw', 'reorder',
  'share', 'grant', 'revoke', 'set', 'remove', 'add', 'approve', 'reject', 'cast',
  'vote', 'ban', 'transfer', 'resolve', 'settle', 'advance', 'reseed', 'generate'];
const goActions = new Set();
for (const moduleName of goModules) {
  if (!/^[a-z][a-z_]*$/.test(moduleName)) continue;
  for (const verb of goVerbs) goActions.add(moduleName + '.' + verb);
}
for (const literal of auditSource.matchAll(/"((?:user|users|recog|bot_token|vote|membership|club|galonly|generate_club_code|revoke_club_code|redeem_club_code|delete_club_comment|add_recommendation|remove_recommendation|reorder_recommendations)[a-z_.]*)"/g)) {
  if (literal[1].includes('.')) goActions.add(literal[1]);
}
const goContext = { actions: [...goActions] };
vm.createContext(goContext);
vm.runInContext(
  reviews.slice(definitionStart, definitionEnd) +
    '; globalThis.goCoverage = actions.map(action => [action, getLogActionDefinition(action).label]);',
  goContext
);
const goUnknown = goContext.goCoverage.filter(([, label]) => label === '未归类操作').map(([action]) => action);
assert(goUnknown.length === 0, `Go audit actions missing explanations: ${goUnknown.join(', ')}`);
console.log(`Go audit action families covered: ${goActions.size} synthetic actions explained`);

const outcomeStart = reviews.indexOf('function detectLogOutcome');
const outcomeEnd = reviews.indexOf('function detectClient', outcomeStart);
assert(outcomeStart !== -1 && outcomeEnd > outcomeStart, 'could not locate log outcome function');
vm.runInContext(reviews.slice(outcomeStart, outcomeEnd) +
  '; globalThis.rejected = detectLogOutcome("galonly.resolve", { result: "success", decision: "reject" });', context);
assert(context.rejected.label === '拒绝', 'business rejection must not display as request success');
for (const field of ["event_code: '活动标识'", "booth_id: '摊位 ID'", "storage: '图片存储位置'", "fallback: '已回退本地'"]) {
  assert(reviews.includes(field), `log detail label missing: ${field}`);
}

console.log(`Admin log inspector contract OK (${actions.size} static actions explained)`);
