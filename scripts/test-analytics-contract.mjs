import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const reviews = read('admin/reviews.html');
const analyticsApi = read('api/analytics.php');
const analyticsInclude = read('includes/analytics.php');
const analyticsJs = read('js/analytics.js');
const migration = read('scripts/migrate.php');
const backfill = read('scripts/backfill-analytics.php');
const configExample = read('config.example.php');
const wikiGenerator = read('scripts/generate-wiki-pages.mjs');
const adminLogsApi = read('api/admin_logs.php');
const audit = read('includes/audit.php');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function walkHtml(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'vendor'].includes(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkHtml(entryPath, output);
    else if (entry.name.endsWith('.html')) output.push(entryPath);
  }
  return output;
}

function isPublicPage(filePath) {
  const relative = path.relative(root, filePath).replaceAll(path.sep, '/');
  if (/^(admin|docs|tests|artifacts|data|uploads|node_modules|vendor)\//.test(relative)) return false;
  if (/^(tools\/pdf-reader|Game\/spy-react|user-v2-react|club-operation-portrait|trial)\//.test(relative)) return false;
  if (/(^|\/)dist\//i.test(relative)) return false;
  if (/(^|\/)(mockup|mockups|prototype|prototypes|fixture|fixtures)(\/|_|$)/i.test(relative)) return false;
  return true;
}

const publicPages = walkHtml(root).filter(isPublicPage);
assert(publicPages.length > 0, 'no public HTML pages found for analytics coverage');
for (const filePath of publicPages) {
  const source = fs.readFileSync(filePath, 'utf8');
  const analyticsRefs = [...source.matchAll(/<script[^>]+src=["']([^"']*analytics\.js(?:\?[^"']*)?)["']/gi)].map(match => match[1]);
  assert(analyticsRefs.length === 1, `public page must reference analytics.js exactly once: ${path.relative(root, filePath)}`);
  const target = path.resolve(path.dirname(filePath), analyticsRefs[0].split('?')[0]);
  assert(fs.existsSync(target), `analytics.js reference does not resolve: ${path.relative(root, filePath)} -> ${analyticsRefs[0]}`);
}

const inlineScripts = [...reviews.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(Boolean);
assert(inlineScripts.length > 0, 'reviews.html must contain an inline application script');
inlineScripts.forEach((source, index) => new vm.Script(source, { filename: `reviews-inline-${index}.js` }));

for (const action of ['track', 'summary', 'export']) {
  assert(analyticsApi.includes(`$action === '${action}'`) || analyticsApi.includes(`$action !== '${action}'`), `analytics API missing action: ${action}`);
}
for (const token of [
  'analytics_pageviews', 'event_id', 'visitor_hash', 'day_key', 'created_at',
  'analyticsVisitorHash', 'analyticsNormalizePath', 'analyticsNormalizeHost',
  'analyticsRequireSuperAdmin', 'ON CONFLICT(event_id) DO NOTHING', 'ON DUPLICATE KEY UPDATE'
]) assert(analyticsApi.includes(token) || analyticsInclude.includes(token), `analytics implementation missing: ${token}`);

assert(analyticsApi.includes("$_GET['action']"), 'analytics API must dispatch by action');
assert(analyticsJs.includes('__vnfestAnalyticsTracked'), 'analytics collector must guard against duplicate page-view execution');
assert(analyticsApi.includes("$user['role'] ?? '') !== 'super_admin'"), 'summary/export must remain super-admin-only');
assert(!analyticsApi.includes('logAction('), 'analytics API must not write administrator audit logs');
assert(!/INSERT\s+INTO\s+analytics_pageviews[\s\S]{0,600}\bvisitor_id\b/i.test(analyticsApi), 'raw visitor_id must not be stored');
for (const forbidden of ['HTTP_USER_AGENT', 'HTTP_REFERER', '$_SERVER[\'REMOTE_ADDR\']', 'user_agent']) {
  assert(!analyticsApi.includes(forbidden) && !analyticsInclude.includes(forbidden), `analytics must not persist raw request field: ${forbidden}`);
}
assert(analyticsApi.includes('analyticsIsExistingSession'), 'track must inspect an existing session without forcing login session creation');
assert(analyticsInclude.includes('Asia/Shanghai') && analyticsInclude.includes('day_key'), 'analytics must use China-local day_key');
assert((migration.match(/analytics_pageviews/g) || []).length >= 2, 'both MySQL and SQLite migrations must create analytics_pageviews');
assert((migration.match(/analytics_historical_pv/g) || []).length >= 2, 'both MySQL and SQLite migrations must create analytics_historical_pv');
for (const field of ['event_id', 'visitor_hash', 'page_path', 'page_title', 'source_category', 'referrer_host', 'device_type', 'browser_name', 'is_authenticated', 'day_key', 'created_at']) {
  assert((migration.match(new RegExp(`\\b${field}\\b`, 'g')) || []).length >= 2, `migration missing field in both database branches: ${field}`);
}
assert(/event_id\s+CHAR\(36\)[^\n]+UNIQUE/.test(migration) && /event_id\s+TEXT[^\n]+UNIQUE/.test(migration), 'event_id must be unique in both database branches');
assert(configExample.includes('ANALYTICS_HASH_KEY'), 'config.example.php must document ANALYTICS_HASH_KEY');
assert(wikiGenerator.includes('../../js/analytics.js') && wikiGenerator.includes('../js/analytics.js'), 'Wiki generator must include analytics.js in detail and index templates');
assert(backfill.includes('historical_uv') && backfill.includes('does not create historical UV'), 'historical importer must explicitly preserve unavailable UV');
for (const forbidden of ['visitor_hash', 'REMOTE_ADDR', 'HTTP_USER_AGENT', 'HTTP_REFERER']) {
  assert(!backfill.includes(forbidden), `historical importer must not persist raw visitor identifiers or request headers: ${forbidden}`);
}
assert(backfill.includes('pv_count') && backfill.includes('analytics_historical_pv'), 'historical importer must write PV aggregates only');

const trendStart = reviews.indexOf('function renderReviewTrendChart');
const trendEnd = reviews.indexOf('function renderReviewStats', trendStart);
assert(trendStart !== -1 && trendEnd > trendStart, 'real review trend function not found');
assert(!reviews.slice(trendStart, trendEnd).includes('Math.random'), 'review trend must not generate random mock data');
for (const token of ['data-module="analytics"', 'id="module-analytics"', 'analyticsLifetimeUv', 'analyticsTrendChart', 'exportAnalytics', '暂无统计数据']) {
  assert(reviews.includes(token), `reviews.html missing analytics UI contract: ${token}`);
}

// Existing administrator log contracts are intentionally checked without changing their source.
assert(adminLogsApi.includes("$currentUser['role'] !== 'super_admin'"), 'admin_logs.php permission contract changed');
assert(audit.includes('parse_url((string)$_SERVER[\'REQUEST_URI\'], PHP_URL_PATH)'), 'audit path safety contract changed');
assert(!audit.includes("'query' =>"), 'audit must not persist request query strings');

console.log(`Analytics contract OK (${publicPages.length} public HTML pages reference analytics.js)`);
