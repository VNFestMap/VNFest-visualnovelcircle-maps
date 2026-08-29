import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');

const app = read('js', 'app.js');
const index = read('index.html');
const announcementsApi = read('api', 'announcements.php');
const notifications = read('includes', 'notifications.php');
const notificationApi = read('api', 'notifications.php');
const adminReviews = read('admin', 'reviews.html');

// The map/list notification entry points must open the full center directly.
assert.match(app, /window\.openVnfNotificationCenter\s*=\s*openNotifCenter/);
assert.match(app, /openNotifCenter\(\{\s*notificationId:\s*id\s*\}\)/);
assert.match(app, /announcementId:\s*Number\(item\.dataset\.id\s*\|\|\s*0\)/);
assert.match(app, /announcementContent:\s*content/);
assert.match(app, /pendingCenterFocus/);
assert.match(index, /id="notifCenterOverlay"/);

// The intermediate dialogs remain only as unreachable legacy definitions while
// all current event handlers use the notification center entry point.
assert.equal((app.match(/openNotifDetail\s*\(/g) || []).length, 1, 'notification detail popup must have no runtime callers');
assert.equal((app.match(/openAnnounceDetail\s*\(/g) || []).length, 1, 'announcement detail popup must have no runtime callers');

// Announcement content is returned and propagated in full; only empty content
// is rejected, with no announcement-specific character limit.
assert.match(announcementsApi, /SELECT id, title, content, type, status/);
assert.doesNotMatch(announcementsApi, /mb_substr\s*\(\s*\$announce\s*\[\s*['"]content['"]\s*\]/);
assert.match(announcementsApi, /broadcastNotification\([\s\S]*?\$announce\s*\[\s*['"]content['"]\s*\][\s\S]*?['"]announcement['"][\s\S]*?\$id/);
assert.match(notifications, /SELECT id, title, content FROM announcements/);
assert.match(notifications, /\(string\)\(\$ann\[['"]content['"]\]\s*\?\?\s*['"]['"]\)/);
assert.match(notifications, /createNotification\([\s\S]*?\$relatedType[\s\S]*?\$relatedId/);
assert.match(notificationApi, /related_type/);

assert.match(adminReviews, /renderAdminMarkdown\(a\.content \|\| ['"]['"]\)/);
assert.match(adminReviews, /content:\s*a\.content \|\| ['"]['"]/);
assert.doesNotMatch(adminReviews, /\(a\.content \|\| ['"]['"]\)\.slice\(0,\s*200\)/);
assert.doesNotMatch(adminReviews, /maxlength\s*=\s*['"][^'"]+['"][^>]*announceContent/i);

// A cache bump is required so deployed clients receive the new routing logic.
assert.match(index, /20260814-announce-v1/);
assert.match(app, /20260814-announce-v1/);

console.log('announcement contract checks passed');
