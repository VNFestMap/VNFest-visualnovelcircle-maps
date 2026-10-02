(function () {
  'use strict';
  var key = 'vnfestAuthTransition';
  var root = document.documentElement;
  var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var layer = null;
  var active = false;
  var navigating = false;
  var arrivalTimer = null;
  var oldBusy = null;
  var arrival = null;
  var bodyObserver = null;
  var revealTimer = null;
  var revealQueued = false;
  var spinStartedAt = 0;
  var pageObserver = null;
  var jumpKind = 'page';
  var rootUrl = new URL('../', document.currentScript.src);
  var pagePaths = ['index.html', 'login.html', 'user.html', 'column/', 'column/index.html', 'admin/club_manager.html', 'wiki/', 'wiki/index.html', 'feedback.html'].map(function (path) { return new URL(path, rootUrl).pathname; });
  pagePaths.push(rootUrl.pathname);
  function canonicalPath(path) {
    var aliases = ['index.html', 'column/index.html', 'wiki/index.html'];
    for (var i = 0; i < aliases.length; i++) {
      if (path === new URL(aliases[i], rootUrl).pathname) return path.slice(0, -10);
    }
    return path;
  }
  function isSupported(url) { return url.origin === location.origin && pagePaths.indexOf(url.pathname) !== -1; }
  function isHome() { return location.pathname === new URL('index.html', rootUrl).pathname || location.pathname === rootUrl.pathname; }

  function clearMarker() { try { sessionStorage.removeItem(key); } catch (_) {} }
  function readArrival() {
    try {
      var raw = sessionStorage.getItem(key);
      if (!raw) return null;
      clearMarker(); // A transition can be consumed only once.
      var value = JSON.parse(raw);
      if (value.version !== 1 || typeof value.time !== 'number' ||
          Date.now() - value.time > 20000 || value.time > Date.now() ||
          value.target !== canonicalPath(location.pathname) + location.search || !isSupported(new URL(location.href))) return null;
      return value;
    } catch (_) { clearMarker(); return null; }
  }
  function setBusy(value) {
    active = value;
    root.classList.toggle('vn-auth-transitioning', value);
    if (!document.body) return;
    if (value) {
      oldBusy = document.body.getAttribute('aria-busy');
      document.body.setAttribute('aria-busy', 'true');
    } else if (oldBusy === null) document.body.removeAttribute('aria-busy');
    else document.body.setAttribute('aria-busy', oldBusy);
  }
  function mount(phase) {
    if (layer) return layer;
    layer = document.createElement('div');
    layer.className = 'vn-auth-transition is-visible';
    layer.dataset.phase = phase;
    layer.setAttribute('role', 'status');
    layer.setAttribute('aria-live', 'polite');
    layer.setAttribute('aria-atomic', 'true');
    var japanese = root.lang.toLowerCase().indexOf('ja') === 0;
    var auth = (arrival ? arrival.kind || 'auth' : jumpKind) === 'auth';
    var message = auth ? (japanese ? 'ログインしました。ページを開いています…' : '登录成功，正在跳转…') : (japanese ? 'ページを開いています…' : '正在打开页面…');
    layer.innerHTML = '<div class="vn-auth-transition__brand" aria-hidden="true">VN<span>Fest</span></div>' +
      '<div class="vn-auth-transition__ring" aria-hidden="true"></div>' +
      '<p class="vn-auth-transition__label">' + message + '</p>';
    document.body.prepend(layer);
    spinStartedAt = arrival && typeof arrival.startedAt === 'number' ? arrival.startedAt : Date.now();
    layer.querySelector('.vn-auth-transition__ring').style.animationDelay = '-' + (Math.max(0, Date.now() - spinStartedAt) % 900) + 'ms';
    setBusy(true);
    return layer;
  }
  function cleanup() {
    clearTimeout(arrivalTimer);
    arrivalTimer = null;
    clearTimeout(revealTimer);
    revealTimer = null;
    revealQueued = false;
    window.removeEventListener('vnfest:map-ready', reveal);
    if (bodyObserver) { bodyObserver.disconnect(); bodyObserver = null; }
    if (pageObserver) { pageObserver.disconnect(); pageObserver = null; }
    if (layer) { layer.remove(); layer = null; }
    root.classList.remove('vn-auth-arriving');
    if (active) setBusy(false);
    navigating = false;
    arrival = null;
  }
  function waitForSlide(element, callback) {
    var done = false;
    var timer;
    function finish(event) {
      if (event && (event.target !== element || event.propertyName !== 'transform')) return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      element.removeEventListener('transitionend', finish);
      callback();
    }
    element.addEventListener('transitionend', finish);
    // Hidden tabs and interrupted transitions must still complete navigation.
    var duration = getComputedStyle(element).transitionDuration.split(',').reduce(function (longest, value) {
      var ms = parseFloat(value) * (value.trim().slice(-2) === 'ms' ? 1 : 1000);
      return Math.max(longest, isFinite(ms) ? ms : 0);
    }, 0);
    timer = setTimeout(finish, motion.matches ? 0 : duration + 120);
  }
  function reveal() {
    if (!arrival || !layer || layer.dataset.phase === 'revealing') return;
    clearTimeout(arrivalTimer);
    window.removeEventListener('vnfest:map-ready', reveal);
    if (motion.matches) { cleanup(); return; }
    if (revealQueued) return;
    revealQueued = true;
    // Let the homepage paint before its compositor-driven curtain starts.
    requestAnimationFrame(function () { requestAnimationFrame(startReveal); });
    // Background tabs may suspend animation frames; always finish the handoff.
    revealTimer = setTimeout(startReveal, 120);
  }
  function startReveal() {
    if (!arrival || !layer || layer.dataset.phase === 'revealing') return;
    clearTimeout(revealTimer);
    layer.dataset.phase = 'revealing';
    layer.classList.remove('is-arriving');
    void layer.offsetHeight;
    waitForSlide(layer, cleanup);
    layer.classList.add('is-revealing');
    layer.classList.remove('is-covered');
  }
  function beginArrival() {
    if (!arrival || layer || !document.body) return;
    mount('arriving').classList.add('is-arriving', 'is-covered');
    root.classList.remove('vn-auth-arriving');
    if (isHome()) window.addEventListener('vnfest:map-ready', reveal);
    // The homepage's own map-ready event is the primary release signal.
    // A failed optional resource must not leave a permanent blocking curtain.
    arrivalTimer = setTimeout(reveal, 5000);
    function checkReady() {
      if (isHome()) {
        if (window.__vnfestMapReady) requestAnimationFrame(reveal);
        return;
      }
      var host = document.getElementById('root');
      if (!host) { reveal(); return; }
      function checkRendered() {
        var text = host.textContent.trim();
        var loadingOnly = host.querySelector('.vn-loading-screen') && /加载|読み込|loading/i.test(text);
        if (host.firstElementChild && text && !loadingOnly) reveal();
      }
      pageObserver = new MutationObserver(checkRendered);
      pageObserver.observe(host, { childList: true, subtree: true, characterData: true });
      checkRendered();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkReady, { once: true });
    else checkReady();
    if (bodyObserver) { bodyObserver.disconnect(); bodyObserver = null; }
  }
  function navigate(target, options) {
    if (navigating) return;
    var url;
    try { url = new URL(target, location.href); } catch (_) { url = new URL('index.html', location.href); }
    if (url.origin !== location.origin) url = new URL('index.html', location.href);
    jumpKind = options && options.kind === 'auth' ? 'auth' : 'page';
    var replace = !!(options && options.replace);
    function go() { if (replace) location.replace(url.href); else location.assign(url.href); }
    navigating = true;
    if (motion.matches || !isSupported(url) || !document.body) {
      clearMarker();
      go();
      return;
    }
    var curtain = mount('covering');
    void curtain.offsetHeight;
    waitForSlide(curtain, function () {
      if (!navigating) return;
      try { sessionStorage.setItem(key, JSON.stringify({ version: 1, time: Date.now(), startedAt: spinStartedAt, kind: jumpKind, theme: root.dataset.theme, target: canonicalPath(url.pathname) + url.search })); } catch (_) {}
      go();
    });
    curtain.classList.add('is-covered');
  }

  window.VNFPageTransition = Object.freeze({ navigate: navigate });
  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    var node = event.target.closest && event.target.closest('a[href], button[data-action="column"], button[data-action="forum"]');
    if (!node || node.hasAttribute('download') || node.getAttribute('aria-disabled') === 'true' || node.closest('[inert]') || !node.getClientRects().length) return;
    var target = node.getAttribute('target');
    if (target && target !== '_self') return;
    var href = node.getAttribute('href');
    if (!href && isHome()) href = new URL('column/', rootUrl).href;
    if (!href) return;
    var url;
    try { url = new URL(href, location.href); } catch (_) { return; }
    if (!isSupported(url) || canonicalPath(url.pathname) === canonicalPath(location.pathname)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    navigate(url.href);
  }, true);
  document.addEventListener('keydown', function (event) {
    if (active) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) { clearMarker(); cleanup(); }
  });
  if (motion.addEventListener) motion.addEventListener('change', function () {
    if (motion.matches && arrival) cleanup();
  });
  arrival = readArrival();
  if (arrival && !root.dataset.theme && arrival.theme === 'dark') {
    root.style.setProperty('--vn-jump-bg', '#161719');
    root.style.setProperty('--vn-jump-text', '#f4f1eb');
    root.style.setProperty('--vn-jump-muted', '#aaa7a1');
  }
  if (arrival && !motion.matches) {
    root.classList.add('vn-auth-arriving');
    if (document.body) beginArrival();
    else {
      bodyObserver = new MutationObserver(beginArrival);
      bodyObserver.observe(root, { childList: true });
    }
  } else arrival = null;
})();
