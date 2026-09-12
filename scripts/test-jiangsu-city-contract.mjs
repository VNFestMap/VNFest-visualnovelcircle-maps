import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');

// ============================================================
// 江苏 13 地级市钻取 — 契约测试
// ============================================================

const jiangsuSource = read('js/jiangsu.js');
const appSource = read('js/app.js');
const indexSource = read('index.html');
const cssSource = read('css/styles.css');
const chinaSource = read('js/china.js');
const clubsApi = read('api/clubs.php');
const adminSource = [
  read('club-manager-react/src/tabs/SettingsTab.jsx'),
  read('club-manager-react/src/tabs/JiangsuTab.jsx'),
  read('club-manager-react/src/model.js'),
  read('club-manager-react/src/App.jsx'),
  read('club-manager-react/src/Shell.jsx'),
].join('\n');
const jaSource = read('js/language-static-ja.js');

// ── 1. jiangsu.js 模块契约 ──
assert.match(jiangsuSource, /global\.jiangsu\s*=/);
assert.match(jiangsuSource, /JIANGSU_CITIES\s*=\s*\[/);
assert.match(jiangsuSource, /JIANGSU_SCHOOL_CITY_RULES\s*=\s*\[/);
assert.match(jiangsuSource, /JIANGSU_BADGE_OFFSETS\s*=\s*\{/);
assert.equal(jiangsuSource.includes('JIANGSU_LABEL_OFFSETS'), false, 'label offsets must be renamed to badge offsets');
assert.equal(jiangsuSource.includes('jiangsu-city-label'), false, 'city labels must not be rendered');
assert.equal(jiangsuSource.includes('brightness(1.07)'), false, 'Jiangsu hover must not brighten the map');
assert.match(jiangsuSource, /cityFill\s*=\s*options\.cityFill\s*\|\|\s*['"]var\(--jiangsu-map-fill\)['"]/);
assert.match(jiangsuSource, /\.attr\(['"]fill['"],\s*cityFill\)/);
assert.match(jiangsuSource, /var strokeWidth = 1\.5/);
assert.match(jiangsuSource, /var isCompactViewport = width <= 520/);
assert.match(jiangsuSource, /var badgeRadius = \(isCompactViewport \? 4\.5 : 7\.5\) \/ zoomK/);
assert.match(jiangsuSource, /var badgeRadiusLarge = \(isCompactViewport \? 5\.5 : 8\.5\) \/ zoomK/);
assert.match(jiangsuSource, /\.attr\(['"]stroke-opacity['"],\s*1\)/);
assert.match(jiangsuSource, /\.attr\(['"]shape-rendering['"],\s*['"]geometricPrecision['"]\)/);
assert.match(jiangsuSource, /\.attr\(['"]stroke['"],\s*['"]#ffffff['"]\)/, 'Jiangsu city and province strokes must be pure white');
assert.match(jiangsuSource, /\.attr\(['"]opacity['"],\s*1\)/, 'Jiangsu province outline must stay fully opaque');
assert.match(jiangsuSource, /class['"]?,\s*['"]jiangsu-badge-layer['"]/);

// 加载模块（draw 依赖 d3，但仅 getCityForSchool/getCityForClub 为纯逻辑，加载期无需 d3）
globalThis.d3 = {};
eval(jiangsuSource);
const jiangsu = globalThis.jiangsu;
assert.ok(jiangsu, 'jiangsu module not exposed');
assert.equal(jiangsu.CITIES.length, 13, 'must define exactly 13 prefecture-level cities');
assert.equal(jiangsu.PATHS.length, 13, 'must embed exactly 13 converted SVG city paths');
assert.deepEqual(jiangsu.VIEW_BOX, [0, 0, 878, 434], 'converted SVG viewBox mismatch');
assert.equal(jiangsuSource.includes('JIANGSU_GEO'), false, 'jiangsu.js must not depend on GeoJSON globals');
assert.equal(/DataV|geo\.datav|jiangsu-geo\.js/i.test(jiangsuSource), false, 'jiangsu.js must not reference DataV or legacy geo assets');
assert.match(jiangsuSource, /d3\.zoom\(\)/, 'jiangsu.js must use the shared D3 zoom interaction');
assert.match(jiangsuSource, /scaleExtent\(\[fitScale,\s*fitScale \* 12\]\)/, 'Jiangsu zoom extent must match China');
assert.match(jiangsuSource, /\.on\(['"]dblclick\.zoom['"],\s*null\)/, 'Jiangsu double-click zoom must be disabled');
assert.match(jiangsuSource, /baseTranslate:\s*\[tx, ty\]/, 'Jiangsu draw must expose its fit transform');

const sourceOrder = ['南京','无锡','徐州','常州','苏州','南通','连云港','淮安','盐城','扬州','镇江','泰州','宿迁'];
assert.deepEqual(jiangsu.PATHS.map((city) => city.name), sourceOrder, 'converted SVG path order mismatch');
for (const city of jiangsu.PATHS) {
  assert.match(city.id, /^[a-z]+$/, 'city id must be stable and machine-readable');
  assert.ok(city.d && city.d.length > 10, 'city path data missing: ' + city.name);
  assert.ok(city.tw_name && city.en_name, 'city display metadata missing: ' + city.name);
}
const badgeOffsets = Object.fromEntries(jiangsu.PATHS.map((city) => [city.name, city.badgeOffset]));
assert.deepEqual(badgeOffsets['常州'], { dx: -23, dy: 10 }, 'Changzhou badge offset mismatch');
assert.deepEqual(badgeOffsets['无锡'], { dx: -21, dy: 18 }, 'Wuxi badge offset mismatch');

// 13 市齐全
const names = jiangsu.cityNames();
for (const city of ['南京','无锡','徐州','常州','苏州','南通','连云港','淮安','盐城','扬州','镇江','泰州','宿迁']) {
  assert.ok(names.includes(city), 'missing city: ' + city);
}

// ── 2. 学校 → 城市 匹配契约 ──
const schoolCases = [
  ['南京大学', '南京'], ['东南大学', '南京'], ['河海大学', '南京'], ['中国药科大学', '南京'], ['三江学院', '南京'],
  ['南京信息工程大学', '南京'], ['南京邮电大学', '南京'], ['南京师范大学', '南京'], ['南京工业大学', '南京'],
  ['江南大学', '无锡'], ['中国矿业大学', '徐州'], ['江苏师范大学', '徐州'],
  ['常州大学', '常州'], ['江苏理工学院', '常州'],
  ['苏州大学', '苏州'], ['苏州农业职业技术学院', '苏州'], ['星海实验高级中学', '苏州'],
  ['通理工TimeForever', '南通'],
  ['江苏海洋大学', '连云港'], ['淮安大学', '淮安'], ['淮阴师范学院', '淮安'],
  ['盐城工学院', '盐城'], ['扬州大学', '扬州'],
  ['江苏大学', '镇江'], ['江苏科技大学', '镇江'], ['镇江高校联合', '镇江'],
  ['泰州彼方Gal同好会', '泰州'],
  ['完全未知的学校', '']
];
for (const [school, expected] of schoolCases) {
  assert.equal(jiangsu.getCityForSchool(school), expected, 'school→city mismatch: ' + school);
}
// 显式 city 字段优先
assert.equal(jiangsu.getCityForClub({ school: '某某大学', city: '盐城' }), '盐城');
assert.equal(jiangsu.getCityForClub({ school: '某某大学', city: '盐城市' }), '盐城');
assert.equal(jiangsu.getCityForClub({ school: '某某大学', city: '不存在市' }), '');
assert.equal(jiangsu.getCityForClub({ school: '南京大学' }), '南京');
assert.equal(jiangsu.getCityForClub(null), '');

// ── 3. 存量数据契约：江苏同好会全部能归入 12 市，宿迁为 0 ──
const clubs = JSON.parse(read('data/clubs.json')).data || [];
const jiangsuClubs = clubs.filter((c) => {
  const provs = c.provinces && c.provinces.length ? c.provinces : (c.province ? [c.province] : []);
  return provs.some((p) => String(p).includes('江苏'));
});
assert.ok(jiangsuClubs.length >= 30, 'expected a rich Jiangsu club dataset, got ' + jiangsuClubs.length);
const cityCounts = {};
let unassigned = 0;
for (const club of jiangsuClubs) {
  const city = jiangsu.getCityForClub(club);
  if (!city) { unassigned++; continue; }
  cityCounts[city] = (cityCounts[city] || 0) + 1;
}
assert.equal(cityCounts['宿迁'] || 0, 0, '宿迁 must have no clubs in the seed data');
assert.ok(unassigned <= 2, 'too many unassigned Jiangsu clubs: ' + unassigned);
const coveredCities = Object.keys(cityCounts).length;
assert.ok(coveredCities >= 11, 'expected 11+ cities covered by school matching, got ' + coveredCities);
console.log('Jiangsu seed data: ' + jiangsuClubs.length + ' clubs, ' + coveredCities + ' cities covered, ' + unassigned + ' unassigned');

// ── 4. 后端契约：city 字段贯通 ──
assert.match(clubsApi, /'city' => \$input\['city'\] \?\? ''/);          // POST
assert.match(clubsApi, /\$rows\[\$i\]\['city'\] = \$input\['city'\] \?\? \$item\['city'\] \?\? ''/); // PUT
assert.match(clubsApi, /jiangsu_city_bulk/);
assert.match(clubsApi, /仅超级管理员可用/);

// ── 5. 前端契约：钻取交互与渲染 ──
assert.ok(indexSource.includes('./js/jiangsu.js'), 'index.html must load jiangsu.js');
assert.ok(indexSource.includes('id="jiangsuContextMenu"'), 'index.html must contain jiangsu context menu');
assert.equal(indexSource.includes('id="jiangsuBackBtn"'), false, 'index.html must remove the fixed Jiangsu back button');
assert.ok(indexSource.includes('data-action="expand-jiangsu"'), 'index.html must wire the expand action');
assert.equal(indexSource.includes('jiangsu-geo.js'), false, 'index.html must not load legacy geo data');
assert.match(appSource, /getJiangsuExpandActionHtml/);
assert.match(appSource, /getJiangsuViewActionHtml/);
assert.match(appSource, /data-action=\\?['"]exit-jiangsu/);
assert.match(appSource, /animateMapCountrySwitch\(renderChinaMap/);
assert.match(appSource, /jiangsu-expand-inline/);
assert.equal(appSource.includes('JIANGSU_GEO'), false, 'app.js must not depend on GeoJSON globals');
assert.equal(appSource.includes('jiangsu-geo.js'), false, 'app.js must not load legacy geo data');

for (const fn of ['renderJiangsuSubMap', 'enterJiangsuSubView', 'exitJiangsuSubView', 'animateZoomToJiangsu', 'showJiangsuContextMenu', 'hideJiangsuContextMenu', 'showJiangsuCityDetails', 'showJiangsuProvinceList', 'buildJiangsuCityGroups', 'getClubCity']) {
  assert.ok(appSource.includes('function ' + fn), 'app.js missing function: ' + fn);
}
assert.match(appSource, /jiangsuCityGroupsMap:\s*new Map\(\)/);
assert.match(appSource, /jiangsuSubViewActive:\s*false/);
assert.match(appSource, /function isPointOnJiangsu/);             // 命中判定
assert.match(appSource, /contextmenu[\s\S]*isPointOnJiangsu/);   // 右键拦截
assert.match(appSource, /touchstart[\s\S]*isPointOnJiangsu/);    // 长按
assert.match(appSource, /jiangsu-zoom-in/);                       // 放大转场
assert.match(appSource, /map-switch-in/);                         // 入段转场

// 全国返回后的 tooltip 必须取 datum，而不是把 D3 event 当成省份数据
assert.match(chinaSource, /const mouseOver = \(event, datum\)/);
assert.match(chinaSource, /tooltipHtml\(data\)/);
assert.match(appSource, /State\.mapViewState = \{[\s\S]*?bindMapTooltip\(\)/);

// 首页编辑面板：江苏城市字段与省份多选联动
assert.ok(indexSource.includes('id="cityGroup"'), 'index.html must contain the Jiangsu city group');
assert.ok(indexSource.includes('id="editCity"'), 'index.html must contain the city select');
for (const city of ['南京','无锡','徐州','常州','苏州','南通','连云港','淮安','盐城','扬州','镇江','泰州','宿迁']) {
  assert.ok(indexSource.includes('value="' + city + '"'), 'index.html missing Jiangsu city option: ' + city);
}
assert.match(appSource, /syncJiangsuEditorCityField/);
assert.match(appSource, /clubData\.city/);
assert.match(appSource, /normalizeJiangsuEditorCity/);
const jiangsuRenderStart = appSource.indexOf('function renderJiangsuSubMap');
const jiangsuRenderEnd = appSource.indexOf('// 进入江苏子视图', jiangsuRenderStart);
assert.ok(jiangsuRenderStart >= 0 && jiangsuRenderEnd > jiangsuRenderStart, 'Jiangsu render function bounds missing');
assert.equal(appSource.slice(jiangsuRenderStart, jiangsuRenderEnd).includes('colorByCount'), false, 'Jiangsu must not use count color scales');

// ── 6. 样式契约 ──
assert.match(cssSource, /\.jiangsu-city\s*\{/);
assert.match(cssSource, /\.jiangsu-context-menu\s*\{/);
assert.equal(cssSource.includes('jiangsu-back-btn'), false, 'fixed Jiangsu back button styles must be removed');
assert.equal(cssSource.includes('brightness(1.07)'), false, 'Jiangsu CSS must not brighten hovered cities');
assert.match(cssSource, /\.jiangsu-backdrop:hover\s*\{[\s\S]*?fill:\s*transparent;/);
assert.match(cssSource, /\.jiangsu-city-path\s*\{[\s\S]*?stroke:\s*#ffffff\s*!important[\s\S]*?stroke-opacity:\s*1\s*!important/);
assert.match(cssSource, /\.jiangsu-city:hover \.jiangsu-city-path\s*\{[\s\S]*?stroke:\s*#ffffff\s*!important/);
assert.match(cssSource, /--jiangsu-map-fill:\s*color-mix\(/, 'Jiangsu needs a light-orange unselected fill token');
assert.match(cssSource, /\.jiangsu-city\.selected \.jiangsu-city-path\s*\{[\s\S]*?fill:\s*var\(--md-primary\)/, 'selected Jiangsu city must use deep primary orange');
assert.match(cssSource, /\.jiangsu-city\.selected \.jiangsu-city-path\s*\{[\s\S]*?stroke:\s*#ffffff\s*!important/);
assert.match(cssSource, /\.jiangsu-province-outline\s*\{[\s\S]*?stroke:\s*#ffffff\s*!important[\s\S]*?stroke-opacity:\s*1\s*!important/);
assert.match(cssSource, /\.jiangsu-badge-layer\s*\{/);
assert.match(cssSource, /\.jiangsu-badge circle\s*\{[\s\S]*?stroke:\s*#ffffff\s*!important[\s\S]*?stroke-opacity:\s*1\s*!important/);
assert.equal(cssSource.includes('.jiangsu-city-label'), false, 'city label styles must be removed');
assert.match(cssSource, /@keyframes jiangsuZoomIn/);
assert.match(cssSource, /#mapSvg\.map-switch-in/);
assert.match(cssSource, /prefers-reduced-motion[\s\S]*jiangsu-zoom-in/s);

// ── 7. 管理后台契约 ──
assert.match(adminSource, /name="city"/, 'React admin settings must include the city input');
assert.match(adminSource, /name="provinces"/, 'React admin settings must include the multi-select province picker');
assert.match(adminSource, /mode="multiple"/, 'admin province picker must support multiple searchable choices');
assert.match(adminSource, /payload\.city\s*=/, 'admin save must include city');
assert.ok(adminSource.includes('JIANGSU_CITIES'), 'admin must define Jiangsu city options');
assert.match(adminSource, /key: 'jiangsu',[^\n]*superAdmin: true/, 'Jiangsu tab must be permission-gated');
assert.match(adminSource, /key: 'jiangsu'[\s\S]*key: 'users'/, 'Jiangsu tab must be directly above User Management');
assert.match(adminSource, /operation:\s*'jiangsu_city_bulk'/);
assert.match(adminSource, /next === 'users' \|\| next === 'jiangsu'/);

// ── 8. i18n 契约 ──
assert.match(jaSource, /'展开江苏地区':\s*'江蘇エリアを展開'/);
assert.match(jaSource, /'展开江苏 13 地级市视图':\s*'江蘇13市ビューを展開'/);
assert.match(jaSource, /'返回全国地图':\s*'全国地図に戻る'/);

console.log('jiangsu 13-city drill-down contracts passed');
