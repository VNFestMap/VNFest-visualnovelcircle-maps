import { readFileSync } from 'fs';
import vm from 'vm';

const source = readFileSync(new URL('../js/app-core.js', import.meta.url), 'utf8');

function loadCore(protocol = 'https:', capacitor = false) {
  const sandbox = {
    window: {
      location: { protocol },
      matchMedia: () => ({ matches: false }),
      Capacitor: capacitor ? {} : undefined,
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'js/app-core.js' });
  return sandbox.window.AppCore;
}

const core = loadCore();
if (!core || !core.CONFIG || !core.Utils) {
  throw new Error('AppCore should expose CONFIG and Utils');
}

const html = core.Utils.escapeHTML('<b>"x"&</b>');
if (html !== '&lt;b&gt;&quot;x&quot;&amp;&lt;/b&gt;') {
  throw new Error(`escapeHTML returned ${html}`);
}

const webUrl = core.Utils.resolveMediaUrl('uploads/avatar.png');
if (webUrl !== 'uploads/avatar.png') {
  throw new Error(`web media URL should stay relative, got ${webUrl}`);
}

const escapedPicUi = core.Utils.resolveMediaUrl(String.raw`https\:/free.picui.cn/free/example.webp`);
if (escapedPicUi !== 'https://free.picui.cn/free/example.webp') {
  throw new Error(`escaped external media URL should be repaired, got ${escapedPicUi}`);
}
const escapedWithLeadingSlash = core.Utils.resolveMediaUrl(String.raw`/https\:/free.picui.cn/free/example.webp`);
if (escapedWithLeadingSlash !== 'https://free.picui.cn/free/example.webp') {
  throw new Error(`leading-slash escaped media URL should be repaired, got ${escapedWithLeadingSlash}`);
}
const escapedDoubleSlash = core.Utils.resolveMediaUrl(String.raw`https\://free.picui.cn/free/example.webp`);
if (escapedDoubleSlash !== 'https://free.picui.cn/free/example.webp') {
  throw new Error(`escaped double-slash media URL should be repaired, got ${escapedDoubleSlash}`);
}

const fileCore = loadCore('file:');
const bundledUrl = fileCore.Utils.resolveMediaUrl('./uploads/avatar.png');
if (bundledUrl !== 'https://www.map.vnfest.top/uploads/avatar.png') {
  throw new Error(`bundled media URL should become absolute, got ${bundledUrl}`);
}

const multiProvinceNames = core.Utils.getClubProvinceNames({ province: '四川省', provinces: ['四川省', '重庆市', '四川省'] });
if (JSON.stringify(multiProvinceNames) !== JSON.stringify(['四川', '重庆'])) {
  throw new Error(`multi province names should be normalized and deduped, got ${JSON.stringify(multiProvinceNames)}`);
}

const legacyProvinceNames = core.Utils.getClubProvinceNames({ province: '四川+重庆' });
if (JSON.stringify(legacyProvinceNames) !== JSON.stringify(['四川', '重庆'])) {
  throw new Error(`legacy compound province should split into multiple provinces, got ${JSON.stringify(legacyProvinceNames)}`);
}

if (!Array.isArray(core.JAPAN_PREFECTURES) || core.JAPAN_PREFECTURES.length !== 47) {
  throw new Error(`Japan prefecture table should contain 47 rows, got ${core.JAPAN_PREFECTURES?.length}`);
}

const missingJapanIds = core.JAPAN_PREFECTURES
  .filter((item) => !/^JP-\d{2}$/.test(item.id) || !item.jaName || !item.zhName)
  .map((item) => item.id);
if (missingJapanIds.length) {
  throw new Error(`Japan prefecture rows should include id, jaName, and zhName: ${missingJapanIds.join(', ')}`);
}

const aichiAliases = ['愛知県', '爱知県', '愛知县', '爱知县'];
for (const alias of aichiAliases) {
  const normalized = core.Utils.normalizeJapanPrefecture(alias);
  if (normalized !== '愛知県') {
    throw new Error(`Japan prefecture alias ${alias} should normalize to 愛知県, got ${normalized}`);
  }
}

if (core.Utils.normalizeJapanPrefecture('冲绳县') !== '沖縄県') {
  throw new Error('Chinese Okinawa alias should normalize to 沖縄県');
}

if (core.Utils.formatJapanPrefecture('愛知県', 'zh') !== '爱知县') {
  throw new Error(`formatJapanPrefecture zh failed: ${core.Utils.formatJapanPrefecture('愛知県', 'zh')}`);
}

if (core.Utils.formatJapanPrefecture('爱知县', 'ja') !== '愛知県') {
  throw new Error(`formatJapanPrefecture ja failed: ${core.Utils.formatJapanPrefecture('爱知县', 'ja')}`);
}

const japanProvinceNames = core.Utils.getClubProvinceNames({ country: 'japan', prefecture: '爱知县', province: '愛知県' });
if (JSON.stringify(japanProvinceNames) !== JSON.stringify(['愛知県'])) {
  throw new Error(`Japanese province names should use normalized standard keys, got ${JSON.stringify(japanProvinceNames)}`);
}

console.log('app core tests passed');
