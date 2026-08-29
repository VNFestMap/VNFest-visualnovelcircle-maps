/* Normalize first-party page headers without replacing page-specific behavior. */
(function () {
  'use strict';

  var path = window.location.pathname || '';
  if (/\/(?:user-v2\.html|canvas-design\.html|docs|Game|club-operation-portrait|tools\/pdf-reader|node_modules)(?:\/|$)/i.test(path)) return;

  var headerSelectors = [
    '[data-page-header]',
    '.starmap-topbar',
    '.topbar',
    '.poster-header',
    '.wiki-header',
    '.guide-header',
    '.admin-topbar',
    '.top-header',
    '.mh-topbar',
    '.md-topbar',
    '.mb-topbar'
  ];
  var root = document.querySelector(headerSelectors.join(','));
  var hadHeader = Boolean(root);

  function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function pageName() {
    var explicit = clean(document.body && document.body.getAttribute('data-page-name'));
    if (explicit) return explicit;
    if (root && root.classList.contains('wiki-header')) {
      if (document.body && document.body.classList.contains('wiki-index-body')) return 'WIKI';
      if (document.querySelector('.wiki-reading-page')) return document.documentElement.lang === 'ja' ? 'サークルWiki' : '同好会维基';
    }
    var heading = root && root.querySelector('h1, [data-page-title], .page-title, .site-title, .guide-header-brand strong');
    var fromHeading = clean(heading && heading.textContent);
    if (fromHeading && !/^VNFest$/i.test(fromHeading)) return fromHeading;
    var fromTitle = clean(document.title)
      .replace(/\s*[-|｜]\s*VNFest.*$/i, '')
      .replace(/^VNFest\s*[-|｜]\s*/i, '');
    return fromTitle || '页面';
  }

  function rootPrefix() {
    var directory = new URL('.', window.location.href).pathname;
    var segments = directory.split('/').filter(Boolean);
    return '../'.repeat(segments.length);
  }

  function makeBrand(label) {
    var brand = document.createElement('a');
    brand.className = 'vn-topbar-brand';
    brand.href = rootPrefix() + 'index.html?guest=1';
    brand.setAttribute('aria-label', '返回地图');
    brand.innerHTML = '<span class="vn-topbar-name">VNFest</span>'
      + '<span class="vn-topbar-divider" aria-hidden="true"></span>'
      + '<span class="vn-topbar-sub"></span>';
    brand.querySelector('.vn-topbar-sub').textContent = label || pageName();
    return brand;
  }

  function isInteractive(node) {
    return node && /^(A|BUTTON|INPUT|SELECT|TEXTAREA|FORM)$/.test(node.tagName);
  }

  function isLegacyBrand(node) {
    return node && node.nodeType === 1 && node.matches(
      '.topbar-brand, .brand, .site-title, .guide-header-brand, .header-left, .admin-brand, .header-brand'
    );
  }

  function findActions() {
    if (!root) return null;
    var direct = Array.prototype.slice.call(root.children);
    return direct.find(function (node) {
      return node.matches('nav, .topbar-nav, .header-nav, .guide-header-tools, .topbar-right, .topbar-actions, .header-actions, .header-tools, .admin-topbar-actions, .actions');
    }) || null;
  }

  function addActionClass(node) {
    if (!isInteractive(node)) return;
    node.classList.add('vn-topbar-action');
    var label = clean(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent);
    if (!label && node.tagName === 'BUTTON') node.setAttribute('aria-label', '页面操作');
    if (!clean(node.textContent) && !node.querySelector('svg, img')) node.classList.add('is-icon');
  }

  function defaultActions() {
    var actions = document.createElement('nav');
    actions.className = 'vn-topbar-actions';
    actions.setAttribute('aria-label', '页面操作');
    [
      ['返回地图', rootPrefix() + 'index.html?guest=1'],
      ['用户中心', rootPrefix() + 'user.html']
    ].forEach(function (item) {
      var link = document.createElement('a');
      link.className = 'vn-topbar-action';
      link.href = item[1];
      link.textContent = item[0];
      actions.appendChild(link);
    });
    return actions;
  }

  function removeSharedActionClasses(actions) {
    if (!actions) return;
    actions.classList.remove('vn-topbar-actions');
    Array.prototype.slice.call(actions.querySelectorAll('a, button, input, select, textarea, form')).forEach(function (node) {
      node.classList.remove('vn-topbar-action', 'is-icon');
    });
  }

  function clearSharedHeaderMetadata() {
    if (!root) return;
    root.classList.remove('vn-topbar', 'vn-topbar--overlay', 'admin-topbar--manual', 'forum-topbar');
    root.removeAttribute('data-page-header');
    root.removeAttribute('data-header-manual');
  }

  function unwrapSharedLeading(selector) {
    var leading = root && root.querySelector(selector);
    if (!leading) return;
    var brand = leading.querySelector('.vn-topbar-brand');
    if (brand) brand.remove();
    while (leading.firstChild) root.insertBefore(leading.firstChild, leading);
    leading.remove();
  }

  // Manual desktop headers keep their original page-specific DOM in the
  // mobile layout. This runs before paint so the shared desktop skeleton does
  // not alter the existing mobile toolbar, spacing, or control order.
  function restoreManualMobileHeader() {
    if (!root || !root.hasAttribute('data-header-manual')) return;

    if (root.classList.contains('forum-topbar')) {
      var forumBrand = root.querySelector('.vn-topbar-brand');
      if (forumBrand) {
        forumBrand.className = 'topbar-brand';
        forumBrand.href = './forum-plaza.html';
        forumBrand.setAttribute('aria-current', 'page');
        forumBrand.setAttribute('aria-label', '返回论坛广场');
        forumBrand.textContent = '论坛';
      }
      var forumLeading = root.querySelector('.forum-topbar-leading');
      if (forumLeading) forumLeading.classList.remove('vn-topbar-leading', 'forum-topbar-leading');
      var forumActions = root.querySelector('.forum-topbar-actions');
      if (forumActions) {
        forumActions.classList.remove('vn-topbar-actions', 'forum-topbar-actions');
        forumActions.classList.add('topbar-right');
        removeSharedActionClasses(forumActions);
      }
      clearSharedHeaderMetadata();
      return;
    }

    if (root.classList.contains('wiki-site-header')) {
      var wikiBrand = root.querySelector('.vn-topbar-brand');
      var wikiActions = root.querySelector('.vn-topbar-actions');
      var wikiGuide = wikiActions && wikiActions.querySelector('.wiki-guide-entry');
      if (wikiBrand) {
        wikiBrand.className = '';
        wikiBrand.href = '../index.html';
        wikiBrand.removeAttribute('aria-label');
        wikiBrand.textContent = 'Galgame 同好会地图';
      }
      if (wikiActions) {
        Array.prototype.slice.call(wikiActions.querySelectorAll('a:not(.wiki-guide-entry)')).forEach(function (node) { node.remove(); });
        removeSharedActionClasses(wikiActions);
        wikiActions.remove();
      }
      if (wikiBrand) {
        var wikiLabel = document.createElement('span');
        wikiLabel.textContent = 'VNFest WIKI';
        root.insertBefore(wikiLabel, wikiBrand.nextSibling);
      }
      if (wikiGuide) {
        wikiGuide.classList.remove('vn-topbar-action');
        root.appendChild(wikiGuide);
      }
      clearSharedHeaderMetadata();
      return;
    }

    if (root.classList.contains('guide-header')) {
      var guideSharedBrand = root.querySelector('.vn-topbar-brand');
      var guideActions = root.querySelector('.guide-header-tools') || root.querySelector('.vn-topbar-actions');
      var guideBrand = document.createElement('div');
      guideBrand.className = 'guide-header-brand';
      guideBrand.innerHTML = '<a href="../../index.html" class="guide-site-link">VNFest</a>'
        + '<span aria-hidden="true">/</span>'
        + '<a href="../index.html" class="guide-site-link" data-i18n="wikiHome">WIKI</a>'
        + '<span aria-hidden="true">/</span>'
        + '<strong data-i18n="guideName">使用文档</strong>';
      if (guideSharedBrand) guideSharedBrand.remove();
      if (guideActions) {
        guideActions.classList.remove('vn-topbar-actions');
        guideActions.classList.add('guide-header-tools');
        removeSharedActionClasses(guideActions);
      }
      root.insertBefore(guideBrand, root.firstChild);
      clearSharedHeaderMetadata();
      return;
    }

    // Club manager and GalOnly audit headers retain their original breadcrumb
    // and action controls; only the shared brand/leading wrapper is removed.
    unwrapSharedLeading('.admin-topbar-leading, .galonly-topbar-leading');
    var legacyActions = root.querySelector('.vn-topbar-actions');
    removeSharedActionClasses(legacyActions);
    clearSharedHeaderMetadata();
  }

  function normalizeLegacyWikiHeader() {
    var children = Array.prototype.slice.call(root.children);
    var actions = document.createElement('nav');
    actions.className = 'vn-topbar-actions';
    actions.setAttribute('aria-label', document.documentElement.lang === 'ja' ? 'ページ操作' : '页面操作');

    // Wiki article headers predate the shared skeleton. Their direct spans are
    // labels, while the direct links and appearance button are real controls.
    children.forEach(function (node) {
      if (!isInteractive(node)) return;
      if (node.tagName === 'A' || node.tagName === 'BUTTON') actions.appendChild(node);
    });
    children.forEach(function (node) {
      if (node.parentElement === root) node.remove();
    });

    root.classList.add('vn-topbar');
    root.setAttribute('data-page-header', '');
    root.insertBefore(makeBrand(), root.firstChild);
    root.appendChild(actions);
    Array.prototype.slice.call(actions.querySelectorAll('a, button, input, select, textarea, form')).forEach(addActionClass);
  }

  var isMobileViewport = window.matchMedia && window.matchMedia('(max-width: 680px)').matches;
  if (isMobileViewport) {
    restoreManualMobileHeader();
    return;
  }

  if (!root) {
    root = document.createElement('header');
    root.className = 'vn-topbar';
    root.setAttribute('data-page-header', '');
    root.appendChild(makeBrand());
    root.appendChild(defaultActions());
    document.body.insertBefore(root, document.body.firstChild);
    return;
  }

  if (root.hasAttribute('data-page-header') || root.hasAttribute('data-header-manual')) return;

  if (root.classList.contains('wiki-header')) {
    normalizeLegacyWikiHeader();
    return;
  }

  var legacyBrands = Array.prototype.slice.call(root.querySelectorAll(
    '.topbar-brand, .brand, .site-title, .guide-header-brand, .header-left, .admin-brand, .header-brand'
  ));
  var actions = findActions();
  if (!actions) {
    actions = document.createElement('nav');
    actions.className = 'vn-topbar-actions';
    actions.setAttribute('aria-label', '页面操作');
    Array.prototype.slice.call(root.children).forEach(function (child) {
      if (isInteractive(child) && !isLegacyBrand(child)) actions.appendChild(child);
    });
  } else {
    actions.classList.add('vn-topbar-actions');
    actions.setAttribute('aria-label', actions.getAttribute('aria-label') || '页面操作');
  }

  // Preserve existing controls and their listeners, including dynamically wired buttons.
  Array.prototype.slice.call(root.querySelectorAll('a, button, input, select, textarea, form')).forEach(function (node) {
    if (actions.contains(node) || legacyBrands.some(function (brand) { return brand.contains(node); })) return;
    if (node.parentElement === root || node.closest('.topbar-right, .header-tools, .admin-topbar-actions')) {
      actions.appendChild(node);
    }
  });

  legacyBrands.forEach(function (node) {
    if (node !== root && node.parentElement) node.remove();
  });

  if (!actions.children.length) actions = defaultActions();
  Array.prototype.slice.call(actions.querySelectorAll('a, button, input, select, textarea, form')).forEach(addActionClass);

  root.classList.add('vn-topbar');
  if (root.classList.contains('starmap-topbar')) root.classList.add('vn-topbar--overlay');
  root.setAttribute('data-page-header', '');
  root.insertBefore(makeBrand(), root.firstChild);
  if (!actions.parentElement) root.appendChild(actions);
})();
