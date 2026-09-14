// Shared configuration and small utility helpers used by app.js.
var CONFIG = window.CONFIG || {
  BASE_WIDTH: 960,
  BASE_HEIGHT: 700,
  API_URL: './api/clubs.php',
  FALLBACK_URLS: ['./api/clubs.php'],
  POLYMERIZATION_URL: '',
  PUBLIC_BASE_URL: 'https://www.map.vnfest.top'
};

var VNFEST_MEDIA_PRELOADS = window.VNFEST_MEDIA_PRELOADS || new Set();
var VNFEST_IMAGE_URL_RE = /\.(?:avif|gif|ico|jpe?g|png|svg|webp)(?:[?#].*)?$/i;

var JAPAN_PREFECTURES = window.JAPAN_PREFECTURES || [
  { id: 'JP-01', jaName: '北海道', zhName: '北海道', regionJa: '北海道・東北', regionZh: '北海道・东北', aliases: ['北海道'] },
  { id: 'JP-02', jaName: '青森県', zhName: '青森县', regionJa: '北海道・東北', regionZh: '北海道・东北', aliases: ['青森縣', '青森'] },
  { id: 'JP-03', jaName: '岩手県', zhName: '岩手县', regionJa: '北海道・東北', regionZh: '北海道・东北', aliases: ['岩手縣', '岩手'] },
  { id: 'JP-04', jaName: '宮城県', zhName: '宫城县', regionJa: '北海道・東北', regionZh: '北海道・东北', aliases: ['宫城県', '宮城县', '宮城縣', '宫城縣', '宫城'] },
  { id: 'JP-05', jaName: '秋田県', zhName: '秋田县', regionJa: '北海道・東北', regionZh: '北海道・东北', aliases: ['秋田縣', '秋田'] },
  { id: 'JP-06', jaName: '山形県', zhName: '山形县', regionJa: '北海道・東北', regionZh: '北海道・东北', aliases: ['山形縣', '山形'] },
  { id: 'JP-07', jaName: '福島県', zhName: '福岛县', regionJa: '北海道・東北', regionZh: '北海道・东北', aliases: ['福岛県', '福島县', '福島縣', '福岛縣', '福岛'] },
  { id: 'JP-08', jaName: '茨城県', zhName: '茨城县', regionJa: '関東', regionZh: '关东', aliases: ['茨城縣', '茨城'] },
  { id: 'JP-09', jaName: '栃木県', zhName: '栃木县', regionJa: '関東', regionZh: '关东', aliases: ['枥木县', '栃木縣', '枥木縣', '枥木', '栃木'] },
  { id: 'JP-10', jaName: '群馬県', zhName: '群马县', regionJa: '関東', regionZh: '关东', aliases: ['群马県', '群馬县', '群馬縣', '群马縣', '群马'] },
  { id: 'JP-11', jaName: '埼玉県', zhName: '埼玉县', regionJa: '関東', regionZh: '关东', aliases: ['埼玉縣', '埼玉'] },
  { id: 'JP-12', jaName: '千葉県', zhName: '千叶县', regionJa: '関東', regionZh: '关东', aliases: ['千叶県', '千葉县', '千葉縣', '千叶縣', '千叶'] },
  { id: 'JP-13', jaName: '東京都', zhName: '东京都', regionJa: '関東', regionZh: '关东', aliases: ['東京', '东京', '東京郡'] },
  { id: 'JP-14', jaName: '神奈川県', zhName: '神奈川县', regionJa: '関東', regionZh: '关东', aliases: ['神奈川縣', '神奈川'] },
  { id: 'JP-15', jaName: '新潟県', zhName: '新潟县', regionJa: '中部', regionZh: '中部', aliases: ['新潟縣', '新潟'] },
  { id: 'JP-16', jaName: '富山県', zhName: '富山县', regionJa: '中部', regionZh: '中部', aliases: ['富山縣', '富山'] },
  { id: 'JP-17', jaName: '石川県', zhName: '石川县', regionJa: '中部', regionZh: '中部', aliases: ['石川縣', '石川'] },
  { id: 'JP-18', jaName: '福井県', zhName: '福井县', regionJa: '中部', regionZh: '中部', aliases: ['福井縣', '福井'] },
  { id: 'JP-19', jaName: '山梨県', zhName: '山梨县', regionJa: '中部', regionZh: '中部', aliases: ['山梨縣', '山梨'] },
  { id: 'JP-20', jaName: '長野県', zhName: '长野县', regionJa: '中部', regionZh: '中部', aliases: ['长野県', '長野县', '長野縣', '长野縣', '长野'] },
  { id: 'JP-21', jaName: '岐阜県', zhName: '岐阜县', regionJa: '中部', regionZh: '中部', aliases: ['岐阜縣', '岐阜'] },
  { id: 'JP-22', jaName: '静岡県', zhName: '静冈县', regionJa: '中部', regionZh: '中部', aliases: ['静冈県', '静岡县', '静岡縣', '静冈縣', '静冈'] },
  { id: 'JP-23', jaName: '愛知県', zhName: '爱知县', regionJa: '中部', regionZh: '中部', aliases: ['爱知県', '愛知县', '愛知縣', '爱知縣', '爱知'] },
  { id: 'JP-24', jaName: '三重県', zhName: '三重县', regionJa: '中部', regionZh: '中部', aliases: ['三重縣', '三重'] },
  { id: 'JP-25', jaName: '滋賀県', zhName: '滋贺县', regionJa: '関西・近畿', regionZh: '关西・近畿', aliases: ['滋贺県', '滋賀县', '滋賀縣', '滋贺縣', '滋贺'] },
  { id: 'JP-26', jaName: '京都府', zhName: '京都府', regionJa: '関西・近畿', regionZh: '关西・近畿', aliases: ['京都'] },
  { id: 'JP-27', jaName: '大阪府', zhName: '大阪府', regionJa: '関西・近畿', regionZh: '关西・近畿', aliases: ['大阪'] },
  { id: 'JP-28', jaName: '兵庫県', zhName: '兵库县', regionJa: '関西・近畿', regionZh: '关西・近畿', aliases: ['兵库県', '兵庫县', '兵庫縣', '兵库縣', '兵库'] },
  { id: 'JP-29', jaName: '奈良県', zhName: '奈良县', regionJa: '関西・近畿', regionZh: '关西・近畿', aliases: ['奈良縣', '奈良'] },
  { id: 'JP-30', jaName: '和歌山県', zhName: '和歌山县', regionJa: '関西・近畿', regionZh: '关西・近畿', aliases: ['和歌山縣', '和歌山'] },
  { id: 'JP-31', jaName: '鳥取県', zhName: '鸟取县', regionJa: '中国・四国', regionZh: '中国・四国', aliases: ['鸟取県', '鳥取县', '鳥取縣', '鸟取縣', '鸟取'] },
  { id: 'JP-32', jaName: '島根県', zhName: '岛根县', regionJa: '中国・四国', regionZh: '中国・四国', aliases: ['岛根県', '島根县', '島根縣', '岛根縣', '岛根'] },
  { id: 'JP-33', jaName: '岡山県', zhName: '冈山县', regionJa: '中国・四国', regionZh: '中国・四国', aliases: ['冈山県', '岡山县', '岡山縣', '冈山縣', '冈山'] },
  { id: 'JP-34', jaName: '広島県', zhName: '广岛县', regionJa: '中国・四国', regionZh: '中国・四国', aliases: ['广岛県', '広島县', '広島縣', '广岛縣', '广岛'] },
  { id: 'JP-35', jaName: '山口県', zhName: '山口县', regionJa: '中国・四国', regionZh: '中国・四国', aliases: ['山口縣', '山口'] },
  { id: 'JP-36', jaName: '徳島県', zhName: '德岛县', regionJa: '中国・四国', regionZh: '中国・四国', aliases: ['德岛県', '徳島县', '徳島縣', '德岛縣', '德岛'] },
  { id: 'JP-37', jaName: '香川県', zhName: '香川县', regionJa: '中国・四国', regionZh: '中国・四国', aliases: ['香川縣', '香川'] },
  { id: 'JP-38', jaName: '愛媛県', zhName: '爱媛县', regionJa: '中国・四国', regionZh: '中国・四国', aliases: ['爱媛県', '愛媛县', '愛媛縣', '爱媛縣', '爱媛'] },
  { id: 'JP-39', jaName: '高知県', zhName: '高知县', regionJa: '中国・四国', regionZh: '中国・四国', aliases: ['高知縣', '高知'] },
  { id: 'JP-40', jaName: '福岡県', zhName: '福冈县', regionJa: '九州・沖縄', regionZh: '九州・冲绳', aliases: ['福冈県', '福岡县', '福岡縣', '福冈縣', '福冈'] },
  { id: 'JP-41', jaName: '佐賀県', zhName: '佐贺县', regionJa: '九州・沖縄', regionZh: '九州・冲绳', aliases: ['佐贺県', '佐賀县', '佐賀縣', '佐贺縣', '佐贺'] },
  { id: 'JP-42', jaName: '長崎県', zhName: '长崎县', regionJa: '九州・沖縄', regionZh: '九州・冲绳', aliases: ['长崎県', '長崎县', '長崎縣', '长崎縣', '长崎'] },
  { id: 'JP-43', jaName: '熊本県', zhName: '熊本县', regionJa: '九州・沖縄', regionZh: '九州・冲绳', aliases: ['熊本縣', '熊本'] },
  { id: 'JP-44', jaName: '大分県', zhName: '大分县', regionJa: '九州・沖縄', regionZh: '九州・冲绳', aliases: ['大分縣', '大分'] },
  { id: 'JP-45', jaName: '宮崎県', zhName: '宫崎县', regionJa: '九州・沖縄', regionZh: '九州・冲绳', aliases: ['宫崎県', '宮崎县', '宮崎縣', '宫崎縣', '宫崎'] },
  { id: 'JP-46', jaName: '鹿児島県', zhName: '鹿儿岛县', regionJa: '九州・沖縄', regionZh: '九州・冲绳', aliases: ['鹿儿岛県', '鹿児島县', '鹿兒島縣', '鹿儿岛縣', '鹿儿岛'] },
  { id: 'JP-47', jaName: '沖縄県', zhName: '冲绳县', regionJa: '九州・沖縄', regionZh: '九州・冲绳', aliases: ['冲绳県', '沖縄县', '沖繩縣', '冲绳縣', '冲绳'] }
];

var JAPAN_PREFECTURE_BY_ID = new Map(JAPAN_PREFECTURES.map((item) => [item.id, item]));
var JAPAN_PREFECTURE_ALIAS_MAP = new Map();

function normalizeJapanPrefectureLookupKey(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[・·]/g, '');
}

JAPAN_PREFECTURES.forEach((item) => {
  [item.jaName, item.zhName, ...(item.aliases || [])].forEach((alias) => {
    const key = normalizeJapanPrefectureLookupKey(alias);
    if (key) JAPAN_PREFECTURE_ALIAS_MAP.set(key, item.jaName);
  });
});

function normalizeJapanPrefecture(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return JAPAN_PREFECTURE_ALIAS_MAP.get(normalizeJapanPrefectureLookupKey(raw)) || raw;
}

function getJapanPrefectureById(id) {
  return JAPAN_PREFECTURE_BY_ID.get(id) || null;
}

function getJapanPrefectureByName(value) {
  const normalized = normalizeJapanPrefecture(value);
  return JAPAN_PREFECTURES.find((item) => item.jaName === normalized) || null;
}

function formatJapanPrefecture(value, lang) {
  const item = getJapanPrefectureByName(value);
  if (!item) return String(value || '').trim();
  return lang === 'ja' ? item.jaName : item.zhName;
}

var Utils = window.Utils || {
  isMobileViewport: () => window.matchMedia('(max-width: 720px)').matches,
  extractUrl: (item) => {
    const source = `${item?.name || ''} ${item?.raw_text || ''} ${item?.info || ''}`;
    const match = source.match(/https?:\/\/[^\s]+|discord\.gg\/[^\s]+|discord\.com\/invite\/[^\s]+/i);
    if (!match) return null;
    const raw = match[0];
    return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  },
  normalizeProvinceName: (name) => {
    if (!name) return '';
    return String(name).trim().replace(/(壮族自治区|回族自治区|维吾尔自治区|特别行政区|自治区|省|市)$/g, '');
  },
  normalizeJapanPrefecture,
  formatJapanPrefecture,
  getJapanPrefectureById,
  getJapanPrefectureByName,
  getClubProvinceNames: (club) => {
    const values = [];
    const isJapan = club?.country === 'japan' || Boolean(club?.prefecture);
    if (isJapan) {
      values.push(club.prefecture || club.province);
    } else if (Array.isArray(club?.provinces)) {
      values.push(...club.provinces);
    } else if (club?.province) {
      values.push(...String(club.province).split(/[+＋/／、,，;；|｜]/));
    } else if (club?.prefecture) {
      values.push(club.prefecture);
    }
    const seen = new Set();
    return values
      .map((value) => isJapan ? Utils.normalizeJapanPrefecture(value) : Utils.normalizeProvinceName(value))
      .filter((value) => {
        if (!value || seen.has(value)) return false;
        seen.add(value);
        return true;
      });
  },
  groupTypeText: (type) => {
    const map = { school: 'typeSchool', region: 'typeRegion', vnfest: 'typeVnfest' };
    return window.__ ? window.__(map[type] || 'typeSchool') : (map[type] || 'typeSchool');
  },
  typeFilterValue: (type) => ({ school: 'school', region: 'region', vnfest: 'vnfest' }[type] || 'other'),
  formatCreatedAt: (value) => {
    if (!value) return window.__ ? window.__('detailUnknownDate') : '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  },
  escapeHTML: (value) => String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  normalizeMediaUrl: (value) => {
    let url = String(value || '').trim();
    if (!url) return '';
    // Repair legacy records containing an escaped protocol before the browser
    // resolves the value relative to the current page.
    url = url.replace(/\\\//g, '/');
    const protocol = url.match(/^\/*(https?)(?:\\+)?:(.*)$/i);
    if (protocol) url = `${protocol[1].toLowerCase()}://${protocol[2].replace(/^[\\/]+/, '')}`;
    return url;
  },
  resolveMediaUrl: (value) => {
    const url = Utils.normalizeMediaUrl(value);
    if (!url) return '';
    if (/^(https?:|data:|blob:)/i.test(url)) return url;
    const cleanPath = url.replace(/^\.?\//, '');
    const isBundledClient = window.location.protocol === 'file:' ||
      window.location.protocol === 'capacitor:' ||
      window.location.protocol === 'ionic:' ||
      window.location.protocol === 'app:' ||
      Boolean(window.Capacitor);
    if (isBundledClient && /^(data|uploads)\//.test(cleanPath)) {
      return CONFIG.PUBLIC_BASE_URL.replace(/\/$/, '') + '/' + cleanPath;
    }
    return url;
  },
  preloadMediaUrl: (value) => {
    const url = Utils.resolveMediaUrl(value);
    if (!url || !VNFEST_IMAGE_URL_RE.test(url) || VNFEST_MEDIA_PRELOADS.has(url)) return url;
    VNFEST_MEDIA_PRELOADS.add(url);
    if (typeof Image === 'undefined') return url;
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    return url;
  },
  enhanceImages: (root) => {
    const scope = root && root.querySelectorAll ? root : document;
    const images = scope.tagName === 'IMG' ? [scope] : Array.from(scope.querySelectorAll('img'));
    images.forEach((img) => {
      if (!img.hasAttribute('decoding')) img.setAttribute('decoding', 'async');
      if (
        !img.hasAttribute('loading') &&
        !img.closest('[data-eager-images]') &&
        !img.closest('[style*="display:none"]') &&
        !img.id
      ) {
        img.setAttribute('loading', 'lazy');
      }
    });
  },
  debounce: (fn, delay) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }
};

window.CONFIG = CONFIG;
window.Utils = Utils;
window.JAPAN_PREFECTURES = JAPAN_PREFECTURES;
window.JAPAN_PREFECTURE_BY_ID = JAPAN_PREFECTURE_BY_ID;
window.normalizeJapanPrefecture = normalizeJapanPrefecture;
window.formatJapanPrefecture = formatJapanPrefecture;
window.AppCore = { CONFIG, Utils, JAPAN_PREFECTURES };
window.VNFEST_MEDIA_PRELOADS = VNFEST_MEDIA_PRELOADS;

function setupVNFestImageDefaults() {
  if (!document.querySelectorAll) return;
  Utils.enhanceImages(document);
  if (!window.MutationObserver) return;
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) Utils.enhanceImages(node);
      });
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupVNFestImageDefaults, { once: true });
  } else {
    setupVNFestImageDefaults();
  }
}
