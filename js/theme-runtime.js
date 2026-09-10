(function (global) {
  'use strict';

  var STORAGE_KEY = 'themePreference';
  var LEGACY_KEYS = ['vnfest-theme', 'galonly-theme'];
  var VALID_PREFERENCES = { light: true, dark: true, system: true };
  var subscribers = [];
  var mediaQuery = null;
  var themeTransitionInProgress = false;

  function installThemeTransitionStyles() {
    if (!document || document.getElementById('vn-theme-transition-styles')) return;
    var style = document.createElement('style');
    style.id = 'vn-theme-transition-styles';
    style.textContent = [
      '::view-transition-old(root),',
      '::view-transition-new(root) {',
      '  animation: none;',
      '  mix-blend-mode: normal;',
      '}',
      '::view-transition-old(root) {',
      '  z-index: 1;',
      '}',
      '::view-transition-new(root) {',
      '  z-index: 999;',
      '  clip-path: circle(0 at var(--vn-theme-transition-x, 50vw) var(--vn-theme-transition-y, 50vh));',
      '  animation: vn-theme-reveal 560ms cubic-bezier(0.22, 1, 0.36, 1) forwards;',
      '}',
      '@keyframes vn-theme-reveal {',
      '  to { clip-path: circle(var(--vn-theme-transition-radius, 150vmax) at var(--vn-theme-transition-x, 50vw) var(--vn-theme-transition-y, 50vh)); }',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  ::view-transition-new(root) { animation-duration: 1ms; }',
      '}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function getTransitionOrigin(origin) {
    var element = origin && typeof origin.getBoundingClientRect === 'function'
      ? origin
      : document.querySelector('[data-theme-toggle], #themeToggle');
    var rect = element && element.getBoundingClientRect ? element.getBoundingClientRect() : null;
    var x = rect ? rect.left + rect.width / 2 : global.innerWidth / 2;
    var y = rect ? rect.top + rect.height / 2 : global.innerHeight / 2;
    var radius = Math.hypot(Math.max(x, global.innerWidth - x), Math.max(y, global.innerHeight - y));
    return { x: x, y: y, radius: radius };
  }

  function safeLocalStorage(method, key, value) {
    try {
      if (!global.localStorage) return null;
      if (method === 'get') return global.localStorage.getItem(key);
      if (method === 'set') global.localStorage.setItem(key, value);
      if (method === 'remove') global.localStorage.removeItem(key);
    } catch (error) {}
    return null;
  }

  function getMediaQuery() {
    if (mediaQuery) return mediaQuery;
    try {
      mediaQuery = global.matchMedia ? global.matchMedia('(prefers-color-scheme: dark)') : null;
    } catch (error) {
      mediaQuery = null;
    }
    return mediaQuery;
  }

  function normalizePreference(value) {
    return VALID_PREFERENCES[value] ? value : null;
  }

  function readPreference() {
    var saved = normalizePreference(safeLocalStorage('get', STORAGE_KEY));
    if (saved) return saved;

    for (var i = 0; i < LEGACY_KEYS.length; i += 1) {
      var legacy = normalizePreference(safeLocalStorage('get', LEGACY_KEYS[i]));
      if (legacy && legacy !== 'system') {
        safeLocalStorage('set', STORAGE_KEY, legacy);
        return legacy;
      }
    }

    return 'system';
  }

  function resolveTheme(preference) {
    var pref = normalizePreference(preference) || readPreference();
    if (pref === 'light' || pref === 'dark') return pref;
    var mq = getMediaQuery();
    return mq && mq.matches ? 'dark' : 'light';
  }

  function applyTheme(preference) {
    var pref = normalizePreference(preference) || readPreference();
    var theme = resolveTheme(pref);
    var root = document.documentElement;

    root.setAttribute('data-theme', theme);
    root.setAttribute('data-theme-preference', pref);
    root.style.colorScheme = theme;

    var themeColor = theme === 'dark' ? '#140913' : '#9b59b6';
    document.querySelectorAll('meta[name="theme-color"]:not([media])').forEach(function (meta) {
      meta.setAttribute('content', themeColor);
    });

    var detail = { preference: pref, theme: theme };
    subscribers.slice().forEach(function (callback) {
      try { callback(detail); } catch (error) {}
    });
    try {
      global.dispatchEvent(new CustomEvent('vn-theme-change', { detail: detail }));
    } catch (error) {}
    return detail;
  }

  function setPreference(preference) {
    var pref = normalizePreference(preference) || 'system';
    safeLocalStorage('set', STORAGE_KEY, pref);
    var origin = arguments.length > 1 && arguments[1] && arguments[1].origin;
    var startViewTransition = document && document.startViewTransition;
    var reducedMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (typeof startViewTransition !== 'function' || reducedMotion || themeTransitionInProgress) {
      return applyTheme(pref);
    }

    installThemeTransitionStyles();
    var transitionOrigin = getTransitionOrigin(origin);
    var root = document.documentElement;
    root.style.setProperty('--vn-theme-transition-x', transitionOrigin.x + 'px');
    root.style.setProperty('--vn-theme-transition-y', transitionOrigin.y + 'px');
    root.style.setProperty('--vn-theme-transition-radius', transitionOrigin.radius + 'px');
    themeTransitionInProgress = true;
    try {
      var transition = startViewTransition(function () { applyTheme(pref); });
      transition.finished.finally(function () {
        themeTransitionInProgress = false;
      });
      return { preference: pref, theme: resolveTheme(pref) };
    } catch (error) {
      themeTransitionInProgress = false;
      return applyTheme(pref);
    }
  }

  function subscribe(callback) {
    if (typeof callback !== 'function') return function () {};
    subscribers.push(callback);
    callback({ preference: readPreference(), theme: resolveTheme(readPreference()) });
    return function () {
      subscribers = subscribers.filter(function (item) { return item !== callback; });
    };
  }

  function toggle(origin) {
    return setPreference(
      resolveTheme(readPreference()) === 'dark' ? 'light' : 'dark',
      { origin: origin }
    );
  }

  function handleSystemChange() {
    if (readPreference() === 'system') applyTheme('system');
  }

  var api = {
    applyEarly: applyTheme,
    apply: applyTheme,
    getPreference: readPreference,
    setPreference: setPreference,
    getEffectiveTheme: function () { return resolveTheme(readPreference()); },
    subscribe: subscribe,
    toggle: toggle
  };

  global.VNFTheme = api;
  installThemeTransitionStyles();
  applyTheme(readPreference());

  var mq = getMediaQuery();
  if (mq) {
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', handleSystemChange);
    else if (typeof mq.addListener === 'function') mq.addListener(handleSystemChange);
  }
})(window);
