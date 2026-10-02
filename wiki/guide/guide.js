(function () {
  'use strict';

  var API = '../../api/wiki.php';
  var FALLBACK = './seed/';
  var state = { language: window.VNFLanguage && window.VNFLanguage.getLanguage() === 'ja' ? 'ja-JP' : 'zh-CN', catalog: null, article: null, index: new Map(), loadToken: 0 };
  var ui = {
    article: document.getElementById('guideArticle'), loading: document.getElementById('guideLoading'),
    notFound: document.getElementById('guideNotFound'), nav: document.getElementById('guideNav'),
    toc: document.getElementById('guideToc'), search: document.getElementById('guideSearch'),
    results: document.getElementById('searchResults'), sidebar: document.getElementById('guideSidebar'),
    backdrop: document.getElementById('sidebarBackdrop'), toast: document.getElementById('guideToast')
  };
  var copy = {
    'zh-CN': { guideName: '使用文档', guideSubtitle: '主站、活动与工具的统一操作说明', wikiHome: 'WIKI', backToMap: '返回主站', searchLabel: '搜索文档', searchPlaceholder: '搜索功能、角色或关键词', loading: '正在加载文档…', contents: '本页目录', copyLink: '复制此页链接', copied: '已复制当前页面链接', previous: '上一页', next: '下一页', noResults: '没有找到匹配的文档。', notFound: '没有找到这篇文档', notFoundText: '请从左侧目录重新选择，或回到开始使用。', updated: '最后更新', error: '文档暂时无法加载，请稍后重试。' },
    'ja-JP': { guideName: '利用ガイド', guideSubtitle: 'メインサイト・イベント・ツールの統合操作ガイド', wikiHome: 'WIKI', backToMap: 'メインサイトへ', searchLabel: 'ドキュメントを検索', searchPlaceholder: '機能・役割・キーワードを検索', loading: 'ドキュメントを読み込んでいます…', contents: 'このページの目次', copyLink: 'このページのリンクをコピー', copied: 'ページのリンクをコピーしました', previous: '前のページ', next: '次のページ', noResults: '一致するドキュメントはありません。', notFound: 'このドキュメントは見つかりません', notFoundText: '左の目次から選択するか、最初のガイドに戻ってください。', updated: '最終更新', error: 'ドキュメントを読み込めません。時間をおいて再度お試しください。' }
  };

  function t(key) { return copy[state.language][key] || key; }
  function escapeHtml(value) { var el = document.createElement('div'); el.textContent = value == null ? '' : String(value); return el.innerHTML; }
  function route() {
    var raw = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    var parts = raw.split('/').filter(Boolean);
    if (parts[0] === 'ja-JP' || parts[0] === 'zh-CN') parts.shift();
    return { id: parts.join('/') || 'platform/getting-started' };
  }
  function href(id) { return '#/' + id; }
  function setLanguageText() {
    document.documentElement.lang = state.language === 'ja-JP' ? 'ja' : 'zh-CN';
    document.title = state.language === 'ja-JP' ? 'VNFest 利用ガイド' : 'VNFest 使用文档';
    document.querySelectorAll('[data-i18n]').forEach(function (node) { node.textContent = t(node.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (node) { node.placeholder = t(node.getAttribute('data-i18n-placeholder')); });
    ui.loading.textContent = t('loading');
  }
  function showToast(message) { ui.toast.textContent = message; ui.toast.classList.add('show'); window.clearTimeout(showToast.timer); showToast.timer = window.setTimeout(function () { ui.toast.classList.remove('show'); }, 2200); }
  function hashRevision(value) { var text = JSON.stringify(value || {}), hash = 0; for (var i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash) + text.charCodeAt(i) | 0; return String(hash >>> 0); }

  async function getJson(url) { var response = await fetch(url, { headers: { Accept: 'application/json' } }); if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); }
  function normalizeArticle(value, fallbackId) {
    if (!value || typeof value !== 'object') return null;
    var source = value.published && typeof value.published === 'object' ? value.published : value;
    var article = Object.assign({}, source);
    if (!article.id && fallbackId) article.id = fallbackId;
    return article.id ? article : null;
  }
  function normalizeCatalog(value) {
    if (!value || typeof value !== 'object') return null;
    var articleMap = {};
    if (Array.isArray(value.articles)) {
      value.articles.forEach(function (article) {
        var normalized = normalizeArticle(article, article && article.id);
        if (normalized) articleMap[normalized.id] = normalized;
      });
    } else if (value.articles && typeof value.articles === 'object') {
      Object.keys(value.articles).forEach(function (id) {
        var record = value.articles[id];
        if (!record || typeof record !== 'object' || (record.status && record.status !== 'published')) return;
        var normalized = normalizeArticle(record, id);
        if (normalized) articleMap[normalized.id] = normalized;
      });
    }
    var orderedIds = [];
    (Array.isArray(value.groups) ? value.groups : []).forEach(function (group) {
      (Array.isArray(group.articleIds) ? group.articleIds : []).forEach(function (id) {
        if (articleMap[id] && orderedIds.indexOf(id) === -1) orderedIds.push(id);
      });
    });
    Object.keys(articleMap).forEach(function (id) { if (orderedIds.indexOf(id) === -1) orderedIds.push(id); });
    if (!orderedIds.length) return null;
    return Object.assign({}, value, { groups: Array.isArray(value.groups) ? value.groups : [], articles: orderedIds.map(function (id) { return articleMap[id]; }) });
  }
  async function loadCatalog(language) {
    try {
      var payload = await getJson(API + '?action=guide_catalog&lang=' + encodeURIComponent(language));
      var catalog = payload && payload.success ? normalizeCatalog(payload.catalog) : null;
      if (catalog) return catalog;
    } catch (error) { /* local seed is a deliberate offline fallback */ }
    var fallback = normalizeCatalog(await getJson(FALLBACK + language + '/documents.json'));
    if (!fallback) throw new Error('invalid guide catalog');
    return fallback;
  }
  async function loadArticle(id, language) {
    try {
      var payload = await getJson(API + '?action=guide_article&lang=' + encodeURIComponent(language) + '&id=' + encodeURIComponent(id));
      var article = payload && payload.success ? normalizeArticle(payload.article, id) : null;
      if (article) return article;
    } catch (error) { /* catalog includes the seed article for fallback rendering */ }
    return state.index.get(id) || null;
  }
  function updateIndex(catalog) { state.index = new Map(); (catalog && Array.isArray(catalog.articles) ? catalog.articles : []).forEach(function (article) { state.index.set(article.id, article); }); }
  function localizedGroup(group) { return state.language === 'ja-JP' ? (group.titleJa || group.title) : group.title; }
  function syncCollapsibleGroups(activeArticleId) {
    ui.nav.querySelectorAll('details[data-guide-group]').forEach(function (details) {
      var containsActiveArticle = Array.from(details.querySelectorAll('a[data-guide-id]')).some(function (link) {
        return link.getAttribute('data-guide-id') === activeArticleId;
      });
      details.open = containsActiveArticle || details.getAttribute('data-default-expanded') === 'true';
      var summary = details.querySelector('summary');
      if (summary) summary.setAttribute('aria-expanded', details.open ? 'true' : 'false');
    });
  }
  function renderNav() {
    var groups = state.catalog.groups || [];
    var activeArticleId = route().id;
    ui.nav.innerHTML = groups.map(function (group, index) {
      var items = (group.articleIds || []).map(function (id) { var article = state.index.get(id); if (!article) return ''; return '<a href="' + href(id) + '" data-guide-id="' + escapeHtml(id) + '">' + escapeHtml(article.title) + '</a>'; }).join('');
      if (group.collapsible === true) {
        var groupId = group.id || ('guide-group-' + index);
        var isOpen = group.defaultExpanded === true || (group.articleIds || []).indexOf(activeArticleId) !== -1;
        return '<details class="guide-nav-group guide-nav-group-collapsible" data-guide-group="' + escapeHtml(groupId) + '" data-default-expanded="' + (group.defaultExpanded === true ? 'true' : 'false') + '"' + (isOpen ? ' open' : '') + '><summary class="guide-nav-group-title" aria-expanded="' + (isOpen ? 'true' : 'false') + '"><span>' + escapeHtml(localizedGroup(group)) + '</span><span class="guide-nav-chevron" aria-hidden="true"></span></summary><div class="guide-nav-group-items">' + items + '</div></details>';
      }
      return '<section class="guide-nav-group"><div class="guide-nav-group-title">' + escapeHtml(localizedGroup(group)) + '</div>' + items + '</section>';
    }).join('');
    ui.nav.querySelectorAll('details[data-guide-group]').forEach(function (details) {
      var summary = details.querySelector('summary');
      details.addEventListener('toggle', function () {
        if (summary) summary.setAttribute('aria-expanded', details.open ? 'true' : 'false');
      });
      if (summary) summary.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        details.open = !details.open;
      });
    });
  }
  function renderToc(article) {
    var items = (article.sections || []).map(function (section, index) { return '<a href="#guide-section-' + (index + 1) + '">' + escapeHtml(section.title) + '</a>'; }).join('');
    ui.toc.innerHTML = items ? '<nav class="guide-toc"><div class="guide-toc-title">' + escapeHtml(t('contents')) + '</div>' + items + '</nav>' : '';
  }
  function renderBlock(block) {
    if (!block || !block.type) return '';
    if (block.type === 'paragraph') return '<p>' + escapeHtml(block.text) + '</p>';
    if (block.type === 'heading') return '<h3>' + escapeHtml(block.text) + '</h3>';
    if (block.type === 'tip' || block.type === 'warning') return '<aside class="guide-callout"><strong>' + escapeHtml(block.label || (block.type === 'warning' ? '注意' : '提示')) + '</strong>' + escapeHtml(block.text) + '</aside>';
    if (block.type === 'steps') return '<ol class="guide-steps">' + (block.items || []).map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join('') + '</ol>';
    if (block.type === 'list') return '<ul>' + (block.items || []).map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join('') + '</ul>';
    if (block.type === 'code') return '<code class="guide-code">' + escapeHtml(block.text) + '</code>';
    if (block.type === 'table') return '<div class="guide-table-wrap"><table class="guide-table"><thead><tr>' + (block.headers || []).map(function (cell) { return '<th>' + escapeHtml(cell) + '</th>'; }).join('') + '</tr></thead><tbody>' + (block.rows || []).map(function (row) { return '<tr>' + row.map(function (cell) { return '<td>' + escapeHtml(cell) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
    if (block.type === 'image' && block.src) return '<figure class="guide-screenshot"><img src="' + escapeHtml(block.src) + '" alt="' + escapeHtml(block.alt || '') + '"><figcaption>' + escapeHtml(block.caption || block.alt || '') + '</figcaption></figure>';
    return '';
  }
  function renderArticle(article) {
    state.article = article;
    ui.loading.hidden = true; ui.notFound.hidden = true; ui.article.hidden = false;
    var sections = (article.sections || []).map(function (section, index) { return '<section class="guide-section" id="guide-section-' + (index + 1) + '"><h2>' + escapeHtml(section.title) + '</h2>' + (section.blocks || []).map(renderBlock).join('') + '</section>'; }).join('');
    var previous = article.previousId ? state.index.get(article.previousId) : null;
    var next = article.nextId ? state.index.get(article.nextId) : null;
    var pagination = (previous || next) ? '<nav class="guide-pagination" aria-label="文章导航">' + (previous ? '<a href="' + href(previous.id) + '"><span>' + escapeHtml(t('previous')) + '</span><strong>' + escapeHtml(previous.title) + '</strong></a>' : '<span></span>') + (next ? '<a href="' + href(next.id) + '"><span>' + escapeHtml(t('next')) + '</span><strong>' + escapeHtml(next.title) + '</strong></a>' : '') + '</nav>' : '';
    ui.article.innerHTML = '<p class="guide-eyebrow">' + escapeHtml(article.product || 'VNFest') + '</p><h1>' + escapeHtml(article.title) + '</h1><p class="guide-summary">' + escapeHtml(article.summary || '') + '</p><div class="guide-meta"><span class="guide-badge">' + escapeHtml(article.audience || '') + '</span><span>' + escapeHtml(t('updated')) + ' · ' + escapeHtml(article.updatedAt || '') + '</span></div>' + sections + '<div class="guide-page-actions"><button id="copyArticleLink" class="guide-action-button" type="button">' + escapeHtml(t('copyLink')) + '</button></div>' + pagination;
    renderToc(article);
    ui.nav.querySelectorAll('a[data-guide-id]').forEach(function (link) { link.classList.toggle('active', link.getAttribute('data-guide-id') === article.id); });
    syncCollapsibleGroups(article.id);
    var copyButton = document.getElementById('copyArticleLink');
    if (copyButton) copyButton.addEventListener('click', function () { navigator.clipboard && navigator.clipboard.writeText(location.href).then(function () { showToast(t('copied')); }).catch(function () { showToast(location.href); }); });
  }
  function renderNotFound() { ui.loading.hidden = true; ui.article.hidden = true; ui.notFound.hidden = false; ui.toc.innerHTML = ''; ui.notFound.innerHTML = '<h1>' + escapeHtml(t('notFound')) + '</h1><p>' + escapeHtml(t('notFoundText')) + '</p><p><a href="' + href('platform/getting-started') + '">' + escapeHtml(t('guideName')) + '</a></p>'; }
  function renderSearch() {
    var q = (ui.search.value || '').trim().toLowerCase();
    if (!q) { ui.results.hidden = true; ui.results.innerHTML = ''; return; }
    var matches = Array.from(state.index.values()).filter(function (article) { return [article.title, article.summary, article.product, article.audience, (article.search || []).join(' ')].join(' ').toLowerCase().indexOf(q) !== -1; }).slice(0, 8);
    ui.results.hidden = false;
    ui.results.innerHTML = matches.length ? matches.map(function (article) { return '<button class="guide-search-result" type="button" data-search-id="' + escapeHtml(article.id) + '"><strong>' + escapeHtml(article.title) + '</strong><span>' + escapeHtml(article.product || '') + ' · ' + escapeHtml(article.audience || '') + '</span><small>' + escapeHtml(article.summary || '') + '</small></button>'; }).join('') : '<div class="guide-search-result"><span>' + escapeHtml(t('noResults')) + '</span></div>';
    ui.results.querySelectorAll('[data-search-id]').forEach(function (button) { button.addEventListener('click', function () { location.hash = href(button.getAttribute('data-search-id')); ui.search.value = ''; renderSearch(); closeSidebar(); }); });
  }
  function closeSidebar() { ui.sidebar.classList.remove('is-open'); ui.backdrop.classList.remove('is-open'); }
  function bindUi() {
    document.getElementById('menuToggle').addEventListener('click', function () { ui.sidebar.classList.add('is-open'); ui.backdrop.classList.add('is-open'); });
    ui.backdrop.addEventListener('click', closeSidebar);
    ui.search.addEventListener('input', renderSearch);
    document.getElementById('themeToggle').addEventListener('click', function () { var next = document.documentElement.dataset.guideTheme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.guideTheme = next; localStorage.setItem('vnfest-guide-theme', next); });
    window.addEventListener('hashchange', bootRoute);
  }
  async function bootRoute() {
    var loadToken = ++state.loadToken;
    var current = route(); closeSidebar();
    var runtimeLanguage = window.VNFLanguage && window.VNFLanguage.getLanguage() === 'ja' ? 'ja-JP' : 'zh-CN';
    if (state.language !== runtimeLanguage || !state.catalog) {
      state.language = runtimeLanguage; setLanguageText(); ui.loading.hidden = false; ui.article.hidden = true; ui.notFound.hidden = true;
      try {
        var catalog = await loadCatalog(state.language);
        if (loadToken !== state.loadToken) return;
        state.catalog = catalog; updateIndex(state.catalog); renderNav();
      } catch (error) {
        if (loadToken === state.loadToken) ui.loading.textContent = t('error');
        return;
      }
    }
    var article = await loadArticle(current.id, state.language);
    if (loadToken !== state.loadToken) return;
    if (article) renderArticle(article); else renderNotFound();
  }
  var savedTheme = localStorage.getItem('vnfest-guide-theme');
  if (savedTheme) document.documentElement.dataset.guideTheme = savedTheme;
  bindUi();
  if (window.VNFLanguage) {
    window.VNFLanguage.subscribe(function () { state.catalog = null; bootRoute(); });
    window.VNFLanguage.ready.then(function () { state.catalog = null; bootRoute(); });
  }
  bootRoute();
}());
