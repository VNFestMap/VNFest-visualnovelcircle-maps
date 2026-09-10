import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const reviews = read('admin/reviews.html');
const api = read('api/admin_insights.php');
const include = read('includes/admin_insights.php');
const migration = read('scripts/migrate.php');
const membership = read('api/membership.php');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const inlineScripts = [...reviews.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(Boolean);
assert(inlineScripts.length > 0, 'reviews.html must contain an inline application script');
inlineScripts.forEach((source, index) => new vm.Script(source, { filename: `reviews-inline-${index}.js` }));

for (const token of [
  'data-module="insights"', 'id="module-insights"', 'insightKpiPending', 'insightQueueBody',
  'insightReviewChart', 'insightReviewByTypeBody', 'insightPublicBuckets', 'insightPublicLowList', 'insightGovernanceBuckets', 'insightIssuesBody',
  'applyAdminDeepLink', 'insightsNavigate', "addEventListener('popstate'"
]) assert(reviews.includes(token), `missing operational insights UI contract: ${token}`);
for (const token of ['summary', 'issues', 'requireLogin', "role'] ?? '') !== 'super_admin'", 'adminInsightsSummary', 'adminInsightsIssues']) {
  assert(api.includes(token), `missing operational insights API contract: ${token}`);
}
for (const token of ['adminInsightsQueueAndReview', 'adminInsightsQuality', 'adminInsightsStampReviewTransitions', 'Asia/Shanghai', 'reviewed_at', 'reviewed_by', 'overdue_72h']) {
  assert(include.includes(token) || membership.includes(token), `missing operational insights implementation token: ${token}`);
}
assert(!api.includes('logAction('), 'operational insights read API must not write audit logs');
assert(api.includes("['summary', 'issues']"), 'API action list must remain explicit');
assert((migration.match(/reviewed_at/g) || []).length >= 2 && (migration.match(/reviewed_by/g) || []).length >= 2, 'membership review fields must exist in both migration branches');
assert(membership.includes('reviewed_at = CURRENT_TIMESTAMP') && membership.includes('reviewed_by = ?'), 'membership approval/rejection must stamp review metadata');
assert(reviews.includes('暂无可用审核趋势数据') && !reviews.slice(reviews.indexOf('function renderInsightReview'), reviews.indexOf('function renderInsightQuality')).includes('Math.random'), 'insight trend must not generate random data');
assert(reviews.includes('min-height: 44px') && reviews.includes('insights-kpi-grid'), 'mobile touch sizing and dense layout contract missing');

console.log('Admin insights contract OK');
