import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readPage = (name) => readFileSync(new URL(`../Galgame_events/${name}`, import.meta.url), 'utf8');

const pages = {
  guidelines: readPage('Beijing_Galonly_guidelines.html'),
  booth: readPage('Beijing_Galonly_submit.html'),
  merchandise: readPage('Beijing_Galonly_merchandise.html'),
  status: readPage('Galonly_status.html'),
};

assert.match(pages.guidelines, /2026 年 9 月 12 日/, 'guidelines should show the booth application deadline');
assert.match(pages.guidelines, /2026 年 9 月 19 日/, 'guidelines should show the first merchandise submission deadline');
assert.match(pages.guidelines, /2026 年 10 月 1 日/, 'guidelines should show the individual merchandise addition deadline');
assert.match(pages.guidelines, /追加个别制品/, 'guidelines should limit post-deadline changes to individual merchandise');
assert.match(pages.guidelines, /报备并提交审核/, 'guidelines should require reporting and review for additions');

assert.match(pages.booth, /摊位申请截止：2026 年 9 月 12 日/, 'booth form should show the booth deadline');
assert.match(pages.booth, /首轮制品审核材料提交截止：2026 年 9 月 19 日/, 'booth form should show the merchandise deadline');
assert.match(pages.merchandise, /2026 年 9 月 19 日前/, 'merchandise form should show its submission cutoff');
assert.match(pages.merchandise, /2026 年 10 月 1 日前/, 'merchandise form should show the addition cutoff');
assert.match(pages.status, /2026 年 9 月 19 日前/, 'status page should show the merchandise submission cutoff');
assert.match(pages.status, /2026 年 10 月 1 日前/, 'status page should show the addition cutoff');
assert.match(pages.status, /追加个别制品/, 'status page should describe individual additions');

for (const [name, page] of Object.entries(pages)) {
  assert.ok(!page.includes('8.14'), `${name} page should not retain the old 8.14 schedule copy`);
  assert.ok(!page.includes('8.21'), `${name} page should not retain the old 8.21 schedule copy`);
  assert.ok(!page.includes('报名截止日（待定）'), `${name} page should not retain the undetermined booth deadline`);
  assert.ok(!page.includes('终审截止日，待定'), `${name} page should not retain the undetermined merchandise deadline`);
}

console.log('Beijing GalOnly schedule contract ok');
