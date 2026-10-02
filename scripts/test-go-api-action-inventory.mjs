import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const mainRouter = read('backend/internal/httpapi/galonly.go');
const staffHandler = read('backend/internal/httpapi/galonly_staff.go');
const phpBaseline = read('api/galonly.php');
const auditPage = read('admin/Galonly_audit.html');
const frontendStaffPages = [
  'Galgame_events/galonly_staff_submit.html',
  'Galgame_events/Beijing_Galonly_staff_submit.html',
  'Galgame_events/galgameonly_list.html',
].map(read).join('\n');

const staffActions = [
  'get_staff_application',
  'submit_staff',
  'list_staff_applications',
  'update_staff',
  'delete_staff_application',
  'vote_staff',
  'withdraw_staff_vote',
  'finalize_staff_roster',
  'unlock_staff_roster',
  'update_staff_event_config',
];

for (const action of staffActions) {
  assert.ok(phpBaseline.includes(action), `PHP 兼容基线缺少 Staff action: ${action}`);
  assert.ok(staffHandler.includes(`"${action}"`), `Staff 处理器缺少 action: ${action}`);
  assert.ok(mainRouter.includes(`"${action}"`), `主 galonly.php 分发缺少 Staff action: ${action}`);
}

assert.match(
  mainRouter,
  /case\s+"get_staff_application"[\s\S]*?"update_staff_event_config":\s*\n\s*s\.galonlyStaff\(w, r\)/,
  '所有 Staff action 必须进入同一个 Staff 处理器',
);
assert.match(
  auditPage,
  /action=list_staff_applications&event_id=/,
  '审核页加载 Staff 列表时必须传递当前活动 event_id',
);

for (const action of staffActions) {
  if (frontendStaffPages.includes(`action=${action}`)) {
    assert.ok(mainRouter.includes(`"${action}"`), `前端调用的 Staff action 未接入主入口: ${action}`);
  }
}

console.log(`Go API action inventory passed: ${staffActions.length} GalOnly Staff actions are routed and covered`);
