import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapPath = path.join(root, 'Galgame_events', 'Beijing_galo_map', 'beitou-visitor-v0.1.html');
const map = fs.readFileSync(mapPath, 'utf8');
const start = map.indexOf('function collapseDuplicatePlaceholderBindings(project){');
const end = map.indexOf('\nlet publicReadInFlight=', start);
assert.ok(start >= 0 && end > start, '无法提取公开地图的桌位去重函数');

const tableIdsOf = booth => Array.isArray(booth?.tableIds) && booth.tableIds.length ? booth.tableIds : [booth?.id].filter(Boolean);
const collapseDuplicatePlaceholderBindings = Function(
  'tableIdsOf',
  `${map.slice(start, end)}\nreturn collapseDuplicatePlaceholderBindings;`
)(tableIdsOf);

const booth = (id, tableIds, name = `${id} · 待填写`) => ({
  id,
  tableIds,
  name,
  circleName: '参展资料待填写',
  placeholder: true,
});

const source = {
  catalog: {
    booths: [
      booth('B01', ['B01', 'B02', 'B03'], 'Marine Iris'),
      booth('B02', ['B02'], 'BUCT号星空列车'),
      booth('B03', ['B03'], '次世代中古部'),
      booth('F02', ['F02', 'F03'], '视觉小说棉花娃娃论坛'),
      booth('F03', ['F03'], '视觉小说棉花娃娃论坛'),
      booth('C06', ['C06'], 'TGU视觉小说同好会'),
      booth('C07', ['C06', 'C07'], '北洋gal同好会'),
    ],
  },
};

const result = collapseDuplicatePlaceholderBindings(source);
const ids = result.catalog.booths.map(item => item.id);
assert.deepEqual(ids, ['B01', 'B02', 'B03', 'F02', 'F03', 'C07'], '未明确合并的 B/F 桌位不能被静默删除，C06/C07 仍只保留一个名称');
assert.equal(result.catalog.booths.find(item => item.id === 'C07').name, '北洋gal同好会');

const configured = collapseDuplicatePlaceholderBindings({
  settings: { placeholderMerges: [{ from: 'F03', to: 'F02' }] },
  catalog: { booths: [booth('F02', ['F02', 'F03']), booth('F03', ['F03'])] },
});
assert.deepEqual(configured.catalog.booths.map(item => item.id), ['F02'], '新增合并必须通过显式项目设置声明');

console.log('Beijing GalOnly table binding regression: ok');
