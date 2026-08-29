import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manager = fs.readFileSync(path.join(root, 'admin', 'club_manager.html'), 'utf8');
const api = fs.readFileSync(path.join(root, 'api', 'club_recommendations.php'), 'utf8');

assert.match(manager, /const REC_SLOT_COUNT = 12/, 'recommendation board should define twelve fixed slots');
assert.match(manager, /function buildRecommendationSlots\(\)/, 'manager should map sort_order into fixed slots');
assert.match(manager, /Number\(rec\.sort_order\)/, 'manager should use the server sort_order as the slot position');
assert.match(manager, /data-rec-slot=/, 'recommendation cards should expose their slot index');
assert.match(manager, /draggable="true"/, 'occupied recommendation cards should be draggable');
assert.match(manager, /function moveRecommendationSlot\(/, 'manager should provide click and drag movement');
assert.match(manager, /slots: recommendationSlotsPayload\(nextSlots\)/, 'manager should persist the complete twelve-slot payload');
assert.match(manager, /position: targetSlot \+ 1/, 'new recommendations should include a one-based target position');
assert.match(manager, /rec-card-empty/, 'manager should render empty slots instead of compacting the list');
assert.match(manager, /手机端点击条目，再点击目标位置/, 'manager should explain the mobile click-to-move fallback');
assert.doesNotMatch(manager, /for \(let i = filledCount; i < 12; i\+\+\)/, 'manager must not append empty placeholders after the filled list');
assert.match(manager, /removeRecommendation\(\$\{rec\.id\}\)/, 'existing remove handler should remain available');

assert.match(api, /const CLUB_RECOMMENDATION_SLOT_COUNT = 12/, 'API should share the twelve-slot limit');
assert.match(api, /\$input\['position'\]/, 'add API should accept a requested position');
assert.match(api, /推荐位置必须是 1 到 12/, 'add API should validate the one-based position');
assert.match(api, /第一个空槽/, 'add API should fill the first empty slot when position is omitted');
assert.match(api, /isset\(\$input\['slots'\]\)/, 'reorder API should accept the complete slots payload');
assert.match(api, /count\(\$slots\) !== CLUB_RECOMMENDATION_SLOT_COUNT/, 'reorder API should require exactly twelve slots');
assert.match(api, /推荐槽位不能包含重复条目/, 'reorder API should reject duplicate entry IDs');
assert.match(api, /不能跨同好会或国家混合排序/, 'reorder API should keep club and country boundaries');
assert.match(api, /推荐槽位必须完整包含该同好会当前的全部条目/, 'reorder API should reject partial entry sets');
assert.match(api, /canManageRecommendations\(\$user, \$clubId, \$country\)/, 'reorder API should check management permission for the resolved club');
assert.match(api, /\$db->beginTransaction\(\)/, 'reorder API should update positions transactionally');
assert.match(api, /\$db->commit\(\)/, 'reorder API should commit a successful position update');
assert.match(api, /\$db->rollBack\(\)/, 'reorder API should roll back a failed position update');
assert.match(api, /\$input\['ids'\]/, 'reorder API should retain the legacy ids payload path');

const removeStart = api.indexOf("case 'remove':");
const reorderStart = api.indexOf("case 'reorder':");
const removeBlock = removeStart >= 0 && reorderStart > removeStart ? api.slice(removeStart, reorderStart) : '';
assert.doesNotMatch(removeBlock, /sort_order\s*=/, 'remove API should leave remaining sort_order values untouched');

console.log('club recommendation fixed-slot contract tests passed');
