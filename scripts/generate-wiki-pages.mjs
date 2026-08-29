import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { localizedContent, normalizeBlocks, renderAppearanceLauncher, renderReaderArticle } from '../wiki/wiki-reader.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..');

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function pageNameForClubKey(clubKey) {
  const clean = String(clubKey || '').trim().toLowerCase();
  if (!/^(china|japan)-\d+$/.test(clean)) {
    throw new Error(`Invalid club_key: ${clubKey}`);
  }
  return `${clean}.html`;
}

export function languagePageNameForClubKey(clubKey, lang = 'zh') {
  const pageName = pageNameForClubKey(clubKey);
  return lang === 'ja' ? pageName.replace(/\.html$/, '-ja.html') : pageName;
}

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readClubMap(rootDir) {
  const china = readJson(join(rootDir, 'data/clubs.json'), { data: [] }).data || [];
  const japan = readJson(join(rootDir, 'data/clubs_japan.json'), { data: [] }).data || [];
  const map = new Map();

  for (const row of china) {
    map.set(`china-${row.id}`, { ...row, country: 'china' });
  }
  for (const row of japan) {
    map.set(`japan-${row.id}`, { ...row, country: 'japan' });
  }

  return map;
}

function validateContent(content, fileName) {
  if (!content || typeof content !== 'object') {
    throw new Error(`${fileName}: content must be an object`);
  }
  if (!content.club_key) {
    throw new Error(`${fileName}: missing club_key`);
  }
  if (!content.title) {
    throw new Error(`${fileName}: missing title`);
  }
  if (!content.summary) {
    throw new Error(`${fileName}: missing summary`);
  }
  if (!Array.isArray(content.sections) || content.sections.length === 0) {
    throw new Error(`${fileName}: sections must be a non-empty array`);
  }
}

function manifestJapaneseMetadata(content) {
  const ja = content.i18n?.ja || {};
  if (!ja || typeof ja !== 'object') return null;
  const hasContent = String(ja.title || '').trim() || String(ja.summary || '').trim() ||
    Object.keys(ja.infobox || {}).length || (Array.isArray(ja.sections) && ja.sections.length);
  if (!hasContent) return null;
  return {
    title: String(ja.title || content.title || ''),
    summary: String(ja.summary || content.summary || ''),
    region: String(ja.region || ja.infobox?.Region || ja.infobox?.地域 || ''),
  };
}

function countryLabel(country) {
  return country === 'japan' ? '日本' : '中国';
}

function normalizeRegionName(value, country = 'china') {
  const text = String(value || '').trim();
  if (!text) return '';
  if (country === 'japan') return text;
  return text.replace(/(壮族自治区|回族自治区|维吾尔自治区|特别行政区|自治区|省|市)$/u, '');
}

function regionForClub(club, content) {
  const country = club.country || String(content.club_key || '').split('-')[0] || 'china';
  return normalizeRegionName(club.province || club.prefecture || content.infobox?.地区 || content.infobox?.地域 || '', country);
}

function displayNameForClub(club) {
  return club.display_name || club.name || club.school || '';
}

function renderPage(content, club, lang = 'zh') {
  const articleContent = localizedContent(content, lang);
  const pageName = languagePageNameForClubKey(content.club_key, lang);
  const zhPageName = languagePageNameForClubKey(content.club_key, 'zh');
  const jaPageName = languagePageNameForClubKey(content.club_key, 'ja');
  const isJapanese = lang === 'ja';
  const interfaceLabels = isJapanese
    ? { map: 'Galgame同好会地図', wiki: 'VNFest WIKI', page: 'サークルWiki', pageLanguage: 'ページ言語' }
    : { map: 'Galgame 同好会地图', wiki: 'VNFest WIKI', page: '同好会维基', pageLanguage: '页面语言' };
  return `<!DOCTYPE html>
<html lang="${isJapanese ? 'ja' : 'zh-CN'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="../../js/language-runtime.js?v=20260813-language"></script>
  <script src="../../js/language-catalog.js?v=20260813-language"></script>
  <script src="../../js/language-static-ja.js?v=20260813-language"></script>
  <title>${escapeHtml(articleContent.title)} - ${interfaceLabels.page}</title>
  <link rel="stylesheet" href="../../css/site-header.css?v=20260827-site-header">
  <script defer src="../../js/site-header.js?v=20260827-site-header"></script>
  <link rel="stylesheet" href="../wiki.css?v=20260817-editor-workbench">
</head>
<body>
  <header class="wiki-header vn-topbar" data-page-header>
    <a class="vn-topbar-brand" href="../../index.html?guest=1" aria-label="${isJapanese ? '地図に戻る' : '返回地图'}">
      <span class="vn-topbar-name">VNFest</span>
      <span class="vn-topbar-divider" aria-hidden="true"></span>
      <span class="vn-topbar-sub">${interfaceLabels.page}</span>
    </a>
    <nav class="vn-topbar-actions" aria-label="${isJapanese ? 'ページ操作' : '页面操作'}">
      <a class="vn-topbar-action" href="../../index.html?guest=1">${interfaceLabels.map}</a>
      <a class="vn-topbar-action" href="../index.html">${interfaceLabels.wiki}</a>
      ${renderAppearanceLauncher(lang).replace('class="wiki-appearance-launcher"', 'class="wiki-appearance-launcher vn-topbar-action is-icon"')}
    </nav>
  </header>
  <main class="wiki-page wiki-reading-page" data-wiki-page-lang="${lang}" data-wiki-page-name="${escapeHtml(pageName)}">
    <nav class="wiki-language-switch" role="tablist" aria-label="${interfaceLabels.pageLanguage}">
      <a role="tab" data-wiki-language="zh" aria-selected="${isJapanese ? 'false' : 'true'}" class="${isJapanese ? '' : 'is-active'}" href="./${zhPageName}">中文</a>
      <a role="tab" data-wiki-language="ja" aria-selected="${isJapanese ? 'true' : 'false'}" class="${isJapanese ? 'is-active' : ''}" href="./${jaPageName}">日本語</a>
    </nav>
    ${renderReaderArticle(articleContent, club, lang)}
  </main>
  <script src="../wiki-page.js?v=20260816-motion"></script>
</body>
</html>
`.replace(/^[ \t]+$/gm, '');
}

function readLibraryIndex(rootDir) {
  const libraryDir = join(rootDir, 'wiki/library');
  mkdirSync(libraryDir, { recursive: true });
  const libraryIndex = readJson(join(libraryDir, 'index.json'), { docs: [] });
  const docs = Array.isArray(libraryIndex.docs) ? libraryIndex.docs : [];
  return docs
    .filter((doc) => doc && doc.title && doc.url)
    .map((doc) => ({
      title: String(doc.title || ''),
      url: String(doc.url || ''),
      category: String(doc.category || '文档'),
      description: String(doc.description || ''),
      updated_at: String(doc.updated_at || ''),
    }));
}

function readFeatureSlots(rootDir) {
  const slots = readJson(join(rootDir, 'wiki/feature-slots.json'), { slots: [] }).slots;
  const defaults = [
    { key: 'featured', title: '精选 Wiki', description: '后续可展示完成度较高或资料较完整的高校页面。', status: 'reserved' },
    { key: 'recent', title: '最近更新', description: '后续可按 updated_at 自动聚合近期修改内容。', status: 'reserved' },
    { key: 'todo', title: '待完善页面', description: '后续可根据摘要、章节、图片、参考资料完整度生成维护队列。', status: 'reserved' },
    { key: 'contributors', title: '贡献者与修订记录', description: '后续可接入编辑历史、审核记录和贡献统计。', status: 'reserved' },
    { key: 'templates', title: '模板中心', description: '后续可维护学校 Wiki、活动记录、社团介绍等内容模板。', status: 'reserved' },
    { key: 'taxonomy', title: '分类与标签', description: '后续可按国家、地区、学校类型、活动类型、作品方向组织内容。', status: 'reserved' },
  ];
  const list = Array.isArray(slots) && slots.length ? slots : defaults;
  return list.map((slot) => ({
    key: String(slot.key || ''),
    title: String(slot.title || ''),
    description: String(slot.description || ''),
    status: String(slot.status || 'reserved'),
    url: String(slot.url || ''),
  })).filter((slot) => slot.key && slot.title);
}

function dateValue(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : 0;
}

function wikiCompleteness(content) {
  const missing = [];
  let score = 0;
  const infoboxCount = Object.values(content.infobox || {}).filter((value) => String(value || '').trim()).length;
  const sectionCount = (content.sections || []).filter((section) => section.heading && normalizeBlocks(section).length).length;
  const sectionImageCount = (content.sections || [])
    .flatMap((section) => normalizeBlocks(section))
    .filter((block) => block.type === 'image' && block.url).length;
  const imageCount = (content.images || []).filter((image) => image.url).length + sectionImageCount;
  const referenceCount = (content.references || []).filter((ref) => ref.url || ref.label).length;

  if (String(content.summary || '').trim().length >= 20) score += 20;
  else missing.push('补充摘要');

  if (infoboxCount >= 3) score += 15;
  else missing.push('完善信息框');

  if (sectionCount >= 3) score += 25;
  else if (sectionCount >= 2) score += 18;
  else {
    score += sectionCount * 8;
    missing.push('增加章节');
  }

  if (imageCount > 0) score += 15;
  else missing.push('添加图片');

  if (referenceCount > 0) score += 15;
  else missing.push('补充参考资料');

  if (content.updated_at) score += 10;
  else missing.push('记录更新时间');

  return {
    score: Math.min(100, score),
    missing,
  };
}

function renderRecentUpdates(entries, libraryDocs) {
  const wikiItems = entries.map((item) => ({
    title: item.title,
    description: item.summary || item.club_name || item.school || '高校 Wiki 页面',
    url: item.url,
    kind: 'Wiki',
    updated_at: item.updated_at || '',
  }));
  const docItems = libraryDocs.map((doc) => ({
    title: doc.title,
    description: doc.description || doc.category || '文档库条目',
    url: doc.url,
    kind: doc.category || '文档',
    updated_at: doc.updated_at || '',
  }));
  const items = wikiItems.concat(docItems)
    .filter((item) => item.title && item.url)
    .sort((a, b) => dateValue(b.updated_at) - dateValue(a.updated_at) || String(a.title).localeCompare(String(b.title), 'zh-CN'))
    .slice(0, 6);

  const cards = items.map((item) => `<article class="wiki-index-card wiki-entry" data-search="${escapeHtml([
    item.title,
    item.description,
    item.kind,
  ].join(' ').toLowerCase())}">
    <div class="wiki-index-card-meta">${escapeHtml(item.kind)} · ${escapeHtml(item.updated_at || '未记录更新')}</div>
    <h3><a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a></h3>
    <p>${escapeHtml(item.description)}</p>
  </article>`).join('\n');

  return `<section class="wiki-index-country wiki-article-shell" id="recent-updates">
    <div class="wiki-index-section-heading">
      <h2>最近更新</h2>
      <span>${items.length} 条动态</span>
    </div>
    <div class="wiki-entry-list" id="recentUpdates">${cards || '<p class="wiki-index-empty">暂无最近更新。</p>'}</div>
  </section>`;
}

function renderMaintenanceQueue(entries) {
  const items = entries
    .filter((item) => Number(item.completeness_score || 0) < 85)
    .sort((a, b) => Number(a.completeness_score || 0) - Number(b.completeness_score || 0) || String(a.title).localeCompare(String(b.title), 'zh-CN'))
    .slice(0, 6);

  const cards = items.map((item) => {
    const score = Number(item.completeness_score || 0);
    const missing = (item.missing_fields || []).slice(0, 3).join('、') || '继续补充内容';
    return `<article class="wiki-extension-card wiki-maintenance-item" data-search="${escapeHtml([
      item.title,
      item.club_name,
      item.school,
      missing,
    ].join(' ').toLowerCase())}">
      <div class="wiki-index-card-meta">完整度 ${score}% · ${escapeHtml(item.updated_at || '未记录更新')}</div>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(missing)}</p>
      <div class="wiki-completeness-bar" style="--wiki-completeness:${score}%"><span></span></div>
      <a href="${escapeHtml(item.url)}">去完善</a>
    </article>`;
  }).join('\n');

  return cards || '<p class="wiki-index-empty">当前没有明显待完善页面。</p>';
}

function renderWikiHome(manifest, libraryDocs, featureSlots) {
  const entries = Object.entries(manifest)
    .map(([clubKey, item]) => ({ club_key: clubKey, ...item }))
    .sort((a, b) => {
      if (a.country !== b.country) return String(a.country).localeCompare(String(b.country));
      if (a.region !== b.region) return String(a.region).localeCompare(String(b.region), 'zh-CN');
      return String(a.title).localeCompare(String(b.title), 'zh-CN');
    });

  const countries = [
    ['china', '中国'],
    ['japan', '日本'],
  ];

  const total = entries.length;
  const countryBlocks = countries.map(([country, label]) => {
    const countryEntries = entries.filter((item) => item.country === country);
    const regions = [...new Set(countryEntries.map((item) => item.region || '未标注地区'))];
    const regionBlocks = regions.map((region) => {
      const cards = countryEntries
        .filter((item) => (item.region || '未标注地区') === region)
        .map((item) => `<article class="wiki-index-card wiki-entry" data-search="${escapeHtml([
          item.title,
          item.club_name,
          item.school,
          item.region,
          item.summary,
        ].join(' ').toLowerCase())}">
          <div class="wiki-index-card-meta">${escapeHtml(item.school || item.club_name || '未标注学校')} · ${escapeHtml(item.region || '未标注地区')} · ${escapeHtml(item.updated_at || '未记录更新')}</div>
          <h3><a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a></h3>
          <p>${escapeHtml(String(item.summary || '该页面已建立，内容可继续补充。').split(/\r?\n/).filter(Boolean)[0] || '该页面已建立，内容可继续补充。')}</p>
        </article>`).join('\n');
      return `<section class="wiki-index-region">
        <h3>${escapeHtml(region)} <span>${countryEntries.filter((item) => (item.region || '未标注地区') === region).length}</span></h3>
        <div class="wiki-entry-list">${cards}</div>
      </section>`;
    }).join('\n');
    return `<section class="wiki-index-country wiki-article-shell" id="country-${country}">
      <div class="wiki-index-section-heading">
        <h2>${label}</h2>
        <span>${countryEntries.length} 个页面</span>
      </div>
      ${regionBlocks || '<p class="wiki-index-empty">暂无已生成的高校 Wiki 页面。</p>'}
    </section>`;
  }).join('\n');

  const libraryCards = libraryDocs.map((doc) => `<article class="wiki-library-card wiki-entry" data-search="${escapeHtml([
    doc.title,
    doc.category,
    doc.description,
  ].join(' ').toLowerCase())}">
    <div class="wiki-index-card-meta">${escapeHtml(doc.category)} · ${escapeHtml(doc.updated_at || '未记录更新')}</div>
    <h3><a href="${escapeHtml(doc.url)}">${escapeHtml(doc.title)}</a></h3>
    <p>${escapeHtml(doc.description || '文档库条目')}</p>
  </article>`).join('\n');

  const reservedFeatureSlots = featureSlots.filter((slot) => !['recent', 'todo'].includes(slot.key));
  const extensionCards = reservedFeatureSlots.map((slot) => {
    const enabled = slot.status === 'active' && slot.url;
    return `<article class="wiki-extension-card wiki-maintenance-item${enabled ? '' : ' is-disabled'}">
      <div class="wiki-index-card-meta">${escapeHtml(enabled ? '已启用' : '预留模块')} · ${escapeHtml(slot.key)}</div>
      <h3>${escapeHtml(slot.title)}</h3>
      <p>${escapeHtml(slot.description)}</p>
      <a href="${escapeHtml(enabled ? slot.url : '#')}">${enabled ? '进入模块' : '等待后续开发'}</a>
    </article>`;
  }).join('\n');

  const allPages = entries.map((item) => `<a class="wiki-page-index-item wiki-index-card" href="${escapeHtml(item.url)}" data-search="${escapeHtml([
    item.title,
    item.club_name,
    item.school,
    item.region,
    item.summary,
  ].join(' ').toLowerCase())}">${escapeHtml(item.title)}<span>${escapeHtml(item.school || item.region || '未标注')}</span></a>`).join('\n') || '<p class="wiki-index-empty">暂无已生成的高校 Wiki 页面。</p>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="../js/language-runtime.js?v=20260813-language"></script>
  <script src="../js/language-catalog.js?v=20260813-language"></script>
  <script src="../js/language-static-ja.js?v=20260813-language"></script>
  <title>VNFest WIKI</title>
  <link rel="stylesheet" href="./wiki.css">
</head>
<body class="wiki-index-body">
  <header class="wiki-header wiki-site-header">
    <a href="../index.html">Galgame 同好会地图</a>
    <span>VNFest WIKI</span>
  </header>
  <main class="wiki-index-page wiki-encyclopedia-layout">
    <aside class="wiki-index-sidebar" aria-label="站点目录">
      <div class="wiki-sidebar-card">
        <p class="wiki-index-kicker">VNFest WIKI</p>
        <h1>高校同好会百科</h1>
        <p>集中整理高校视觉小说、Galgame 与相关同好会资料。</p>
      </div>
      <nav class="wiki-nav wiki-index-toc" aria-label="首页目录">
        <a href="#recent-updates">最近更新</a>
        <a href="#country-china">中国</a>
        <a href="#country-japan">日本</a>
        <a href="#all-pages">全部页面</a>
        <a href="#wiki-library">文档库</a>
        <a href="#maintenance">维护中心</a>
      </nav>
    </aside>

    <section class="wiki-index-main">
    <section class="wiki-index-hero wiki-article-shell">
      <div>
        <p class="wiki-index-kicker">百科索引</p>
        <h2>VNFest WIKI 首页</h2>
        <p>按地区、学校、文档和维护状态浏览同好会 Wiki。新增页面后，首页会从 JSON 索引自动同步。</p>
      </div>
      <div class="wiki-index-stats" aria-label="统计">
        <div><strong id="statWiki">${total}</strong><span>高校 Wiki</span></div>
        <div><strong id="statLib">${libraryDocs.length}</strong><span>文档条目</span></div>
      </div>
    </section>

    <section class="wiki-index-tools wiki-article-shell" aria-label="检索">
      <label class="wiki-search-label" for="wikiIndexSearch">搜索条目</label>
      <input id="wikiIndexSearch" type="search" placeholder="搜索学校、同好会、地区或文档">
      <p>搜索会同时过滤地区索引、全部页面和文档库。</p>
    </section>

    <section class="wiki-index-notice wiki-article-shell">
      <strong>索引规则</strong>
      <span>本页由生成器检测 wiki/content 中已填写的高校 Wiki 内容后生成。新增或保存学校 Wiki 后，重新运行生成器即可同步到这里。</span>
    </section>

    ${renderRecentUpdates(entries, libraryDocs)}

    <div id="wikiCountries">
    ${countryBlocks}
    </div>

    <section class="wiki-index-country wiki-article-shell" id="all-pages">
      <div class="wiki-index-section-heading">
        <h2>全部页面索引</h2>
        <span id="allPagesCount">${total} 个页面</span>
      </div>
      <div class="wiki-page-index" id="allPagesList">${allPages}</div>
    </section>

    <div id="wikiLibrary">
    <section class="wiki-index-country wiki-article-shell" id="wiki-library">
      <div class="wiki-index-section-heading">
        <h2>文档库</h2>
        <span>${libraryDocs.length} 个文档</span>
      </div>
      <div class="wiki-entry-list">
        ${libraryCards || '<p class="wiki-index-empty">暂无文档。可以在 wiki/library/index.json 中添加文档条目。</p>'}
      </div>
    </section>
    </div>
    <div class="wiki-empty-search" id="emptySearch">没有找到匹配的结果，试试其他关键词。</div>
    </section>

    <aside class="wiki-index-aside" aria-label="维护与编写">
      <section class="wiki-sidebar-card" id="maintenance">
        <div class="wiki-index-section-heading">
          <h2>维护中心</h2>
          <span id="statExt">${reservedFeatureSlots.length} 个扩展位</span>
        </div>
        <div class="wiki-maintenance-list" id="extensionsGrid">
          ${extensionCards || '<p class="wiki-index-empty">暂无扩展预留。</p>'}
          ${renderMaintenanceQueue(entries)}
        </div>
      </section>
      <section class="wiki-sidebar-card">
        <h2>编写指南</h2>
        <p>建议优先补充简介、发展沿革、活动记录、公开链接和参考资料。</p>
        <a class="wiki-text-link" href="./library/wiki-writing-guide.html">查看编写说明</a>
      </section>
    </aside>
  </main>
  <script>
  (function () {
    var input = document.getElementById('wikiIndexSearch');
    var empty = document.getElementById('emptySearch');
    var cards = Array.prototype.slice.call(document.querySelectorAll('.wiki-index-card, .wiki-library-card'));
    if (!input) return;
    input.addEventListener('input', function () {
      var keyword = input.value.trim().toLowerCase();
      var anyVisible = false;
      cards.forEach(function (card) {
        var hit = !keyword || card.getAttribute('data-search').indexOf(keyword) !== -1;
        card.style.display = hit ? '' : 'none';
        if (hit && card.closest('#wikiCountries, #wikiLibrary, #all-pages')) anyVisible = true;
      });
      document.querySelectorAll('.wiki-index-region').forEach(function (region) {
        var hasVisible = Array.prototype.some.call(region.querySelectorAll('.wiki-index-card'), function (card) {
          return card.style.display !== 'none';
        });
        region.classList.toggle('is-hidden', !hasVisible);
      });
      if (empty) empty.classList.toggle('is-visible', !!keyword && !anyVisible);
    });
  })();
  </script>
</body>
</html>
`;
}

export function generateWikiPages({ rootDir = DEFAULT_ROOT, onlyClubKeys = null } = {}) {
  const contentDir = join(rootDir, 'wiki/content');
  const pagesDir = join(rootDir, 'wiki/pages');
  const manifestPath = join(rootDir, 'wiki/index.json');
  const homePath = join(rootDir, 'wiki/index.html');
  const clubMap = readClubMap(rootDir);
  const only = Array.isArray(onlyClubKeys) && onlyClubKeys.length
    ? new Set(onlyClubKeys.map((key) => String(key || '').trim()).filter(Boolean))
    : null;
  const manifest = only ? readJson(manifestPath, {}) : {};

  mkdirSync(contentDir, { recursive: true });
  mkdirSync(pagesDir, { recursive: true });

  const sourceFiles = readdirSync(contentDir).filter((file) => file.endsWith('.json'));
  const contentFiles = [];
  for (const file of sourceFiles) {
    const content = readJson(join(contentDir, file), null);
    validateContent(content, file);
    if (only && !only.has(content.club_key)) continue;
    contentFiles.push(file);
    const pageName = pageNameForClubKey(content.club_key);
    const club = clubMap.get(content.club_key) || {};
    const html = renderPage(content, club, 'zh');
    const jaHtml = renderPage(content, club, 'ja');
    const completeness = wikiCompleteness(content);
    const jaManifest = manifestJapaneseMetadata(content);
    writeFileSync(join(pagesDir, pageName), html, 'utf8');
    writeFileSync(join(pagesDir, languagePageNameForClubKey(content.club_key, 'ja')), jaHtml, 'utf8');
    manifest[content.club_key] = {
      title: content.title,
      url: `./pages/${pageName}`,
      country: club.country || String(content.club_key).split('-')[0],
      country_label: countryLabel(club.country || String(content.club_key).split('-')[0]),
      school: club.school || content.infobox?.学校 || '',
      club_name: displayNameForClub(club),
      region: regionForClub(club, content),
      summary: content.summary || '',
      updated_at: content.updated_at || '',
      completeness_score: completeness.score,
      missing_fields: completeness.missing,
      ...(jaManifest ? { i18n: { ja: { ...jaManifest, url: `./pages/${languagePageNameForClubKey(content.club_key, 'ja')}` } } } : {}),
    };
  }

  const libraryDocs = readLibraryIndex(rootDir);
  const featureSlots = readFeatureSlots(rootDir);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  if (!existsSync(homePath)) {
    writeFileSync(homePath, renderWikiHome(manifest, libraryDocs, featureSlots), 'utf8');
  }
  return { count: contentFiles.length, manifest, libraryDocs, featureSlots };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const onlyArgs = process.argv.slice(2).flatMap((arg, index, args) => {
    if (arg === '--only') return args[index + 1] ? [args[index + 1]] : [];
    if (arg.startsWith('--only=')) return [arg.slice('--only='.length)];
    return [];
  });
  const result = generateWikiPages({ onlyClubKeys: onlyArgs.length ? onlyArgs : null });
  console.log(`Generated ${result.count} wiki page(s).`);
}
