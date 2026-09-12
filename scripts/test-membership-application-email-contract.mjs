import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(path.join(process.cwd(), 'api', 'membership.php'), 'utf8');
const authSource = readFileSync(path.join(process.cwd(), 'api', 'auth.php'), 'utf8');
const authInclude = readFileSync(path.join(process.cwd(), 'includes', 'auth.php'), 'utf8');
const managerSource = readFileSync(path.join(process.cwd(), 'club-manager-react', 'src', 'tabs', 'MembersTab.jsx'), 'utf8');
const userSource = readFileSync(path.join(process.cwd(), 'user-v2-react', 'src', 'App.jsx'), 'utf8');
const migrateSource = readFileSync(path.join(process.cwd(), 'scripts', 'migrate.php'), 'utf8');

assert.match(source, /require_once __DIR__ \. '\/\.\.\/includes\/mailer\.php';/, 'membership API should load the shared mailer');
assert.match(source, /function notifyMembershipApplicationApprovers\(/, 'membership API should centralize approver email notifications');
assert.match(source, /cm\.club_id = \?\s+AND cm\.country = \?/, 'recipient lookup should be scoped to the target club and country');
assert.match(source, /cm\.role IN \('representative', 'manager'\)\s+AND cm\.status = 'active'/, 'only active representatives and managers should receive the email');
assert.match(source, /u\.status = 'active'[\s\S]*?u\.email_verified_at IS NOT NULL/, 'recipient lookup should require active users with verified email');
assert.match(source, /filter_var\(\$email, FILTER_VALIDATE_EMAIL\)/, 'recipient email addresses should be validated before sending');
assert.match(source, /SELECT DISTINCT u\.id, u\.email/, 'recipient lookup should avoid duplicate approver rows');
assert.match(source, /sendMail\(\$email, \$subject, \$body\)/, 'shared mailer should deliver each approver notification');
assert.match(source, /membership\.application_email_notification/, 'delivery outcomes should be audited without logging recipient addresses');
assert.match(source, /membership application email send failed/, 'mail delivery failures should be logged server-side');
assert.match(source, /COALESCE\(cm\.application_email_enabled, 1\) = 1/, 'club-level recipient preference should gate delivery');
assert.match(source, /COALESCE\(u\.membership_application_email_enabled, 1\) = 1/, 'personal recipient preference should gate delivery');
assert.match(source, /case 'set_application_email_recipient'/, 'membership API should expose the club-level recipient preference action');
assert.match(source, /targetMembership\['role'\], \['representative', 'manager'\]/, 'club-level preference should only target approver roles');
assert.match(source, /fetchColumn\(\) !== 'representative'/, 'only a representative may change their club recipients');
assert.match(source, /targetMembership\['club_id'\].*targetMembership\['country'\]/s, 'recipient permission should stay scoped to club and country');
assert.match(source, /membership\.update_application_email_recipient/, 'club-level preference changes should be audited');

assert.match(authSource, /case 'update_membership_application_email_preference'/, 'auth API should expose the personal preference action');
assert.match(authSource, /authEnsureMembershipApplicationEmailPreferenceColumn/, 'auth API should self-heal the preference column for old deployments');
assert.match(authSource, /membership_application_email_enabled.*enabled/s, 'personal preference should be persisted from the enabled value');
assert.match(authInclude, /membership_application_email_enabled/, 'authenticated user data should load the personal preference');
assert.match(authSource, /'membership_application_email_enabled'/, 'auth responses should expose the personal preference to the user center');

assert.match(managerSource, /canEmail = \(superAdmin \|\| myRole === 'representative'\)/, 'only representatives and super admins should see club recipient controls');
assert.match(managerSource, /membership\.php\?action=set_application_email_recipient/, 'club manager should submit a recipient preference change');
assert.match(managerSource, /接收申请邮件/, 'club manager should label the recipient preference clearly');
assert.match(userSource, /setMembershipApplicationEmailPreference/, 'user center should save the personal preference');
assert.match(userSource, /同好会申请邮件提醒/, 'user center should expose the personal preference');
assert.match(userSource, /验证码和账号安全邮件不受影响/, 'user center should explain the preference scope');

assert.match(migrateSource, /membership_application_email_enabled TINYINT\(1\) NOT NULL DEFAULT 1/, 'MySQL migration should default personal preference to enabled');
assert.match(migrateSource, /membership_application_email_enabled INTEGER NOT NULL DEFAULT 1/, 'SQLite migration should default personal preference to enabled');
assert.match(migrateSource, /application_email_enabled TINYINT\(1\) NOT NULL DEFAULT 1/, 'MySQL migration should default club recipient preference to enabled');
assert.match(migrateSource, /application_email_enabled INTEGER NOT NULL DEFAULT 1/, 'SQLite migration should default club recipient preference to enabled');

const reapplyStart = source.indexOf("logAction('membership.reapply'");
const reapplyCommit = source.indexOf('$db->commit();', reapplyStart);
const reapplyNotify = source.indexOf('notifyMembershipApplicationApprovers(', reapplyCommit);
assert.ok(reapplyStart >= 0 && reapplyCommit > reapplyStart && reapplyNotify > reapplyCommit, 'reapplications should notify only after their transaction commits');

const applyStart = source.indexOf("logAction('membership.apply'");
const applyCommit = source.indexOf('$db->commit();', applyStart);
const applyNotify = source.indexOf('notifyMembershipApplicationApprovers(', applyCommit);
assert.ok(applyStart >= 0 && applyCommit > applyStart && applyNotify > applyCommit, 'new applications should notify only after their transaction commits');

const notifierStart = source.indexOf('function notifyMembershipApplicationApprovers(');
const notifierEnd = source.indexOf('function membershipApplicationMailAudit(', notifierStart);
const notifier = source.slice(notifierStart, notifierEnd);
assert.match(notifier, /catch \(Throwable \$e\)/, 'mail errors should be contained so a submitted application remains pending');
assert.doesNotMatch(notifier, /qq_account|contact_account|apply_reason/, 'application emails must not include contact details or application reasons');

console.log('membership application email contract checks passed');
