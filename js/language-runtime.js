(function () {
  'use strict';

  if (window.VNFLanguage) return;

  var STORAGE_KEY = 'language';
  var ACCOUNT_KEY = 'vnfestLanguageAccountId';
  var SESSION_OVERRIDE_KEY = 'vnfestLanguageOverride';
  var listeners = new Set();
  var catalogs = { zh: {}, ja: {} };
  var apiMessages = { zh: {}, ja: {} };
  var authPromise = null;

  function normalize(value) {
    if (value === 'ja' || value === 'ja-JP') return 'ja';
    if (value === 'zh' || value === 'zh-CN') return 'zh';
    return null;
  }

  function safeGet(storage, key) {
    try { return storage.getItem(key); } catch (error) { return null; }
  }

  function safeSet(storage, key, value) {
    try {
      if (value === null || value === undefined || value === '') storage.removeItem(key);
      else storage.setItem(key, String(value));
    } catch (error) {}
  }

  function browserLanguage() {
    var values = [];
    try { values = Array.isArray(navigator.languages) ? navigator.languages : []; } catch (error) {}
    if (!values.length) {
      try { values = [navigator.language]; } catch (error) { values = []; }
    }
    // Only the primary browser preference should drive automatic selection.
    // A secondary Japanese fallback must not override the site's Chinese default.
    return /^ja(?:-|$)/i.test(String(values[0] || '')) ? 'ja' : 'zh';
  }

  function urlOverride() {
    var value = null;
    try {
      value = normalize(new URLSearchParams(window.location.search).get('lang'));
      if (!value) {
        var match = decodeURIComponent(window.location.hash || '').match(/^#\/?(zh-CN|ja-JP)(?:\/|$)/i);
        value = match ? normalize(match[1]) : null;
      }
      if (value) safeSet(sessionStorage, SESSION_OVERRIDE_KEY, value);
    } catch (error) {}
    return value || normalize(safeGet(sessionStorage, SESSION_OVERRIDE_KEY));
  }

  var override = urlOverride();
  var cached = normalize(safeGet(localStorage, STORAGE_KEY));
  var initial = override || cached || browserLanguage() || 'zh';
  var state = {
    status: 'loading',
    effective: initial,
    accountPreference: null,
    source: override ? 'url' : (cached ? 'legacy-local' : (initial ? 'browser' : 'default')),
    authenticated: false,
    saving: false,
    error: null
  };

  function snapshot() {
    return {
      status: state.status,
      effective: state.effective,
      accountPreference: state.accountPreference,
      source: state.source,
      authenticated: state.authenticated,
      saving: state.saving,
      error: state.error
    };
  }

  function applyDocumentLanguage() {
    if (!document.documentElement) return;
    document.documentElement.lang = state.effective === 'ja' ? 'ja' : 'zh-CN';
    document.documentElement.setAttribute('data-language', state.effective);
  }

  function emit(reason) {
    applyDocumentLanguage();
    var detail = Object.assign(snapshot(), { reason: reason || 'change', language: state.effective });
    listeners.forEach(function (callback) {
      try { callback(detail); } catch (error) { console.error('[VNFLanguage] subscriber failed', error); }
    });
    try { window.dispatchEvent(new CustomEvent('vnfest:language-changed', { detail: detail })); } catch (error) {}
    try { window.dispatchEvent(new CustomEvent('language:changed', { detail: detail })); } catch (error) {}
  }

  function setEffective(language, source, reason) {
    var next = normalize(language) || 'zh';
    var changed = state.effective !== next || state.source !== source;
    state.effective = next;
    state.source = source || state.source;
    if (changed) emit(reason);
    else applyDocumentLanguage();
  }

  function interpolate(value, params) {
    if (!params) return value;
    return String(value).replace(/\{([a-zA-Z0-9_]+)\}/g, function (_, key) {
      return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : _;
    });
  }

  function translate(key, params, language) {
    var lang = normalize(language) || state.effective;
    var value = catalogs[lang] && catalogs[lang][key];
    if (value === undefined && catalogs.zh) value = catalogs.zh[key];
    return interpolate(value === undefined ? key : value, params);
  }

  function apply(root) {
    var scope = root || document;
    if (!scope || !scope.querySelectorAll) return;
    var nodes = [];
    if (scope.nodeType === 1 && scope.matches && scope.matches('[data-i18n]')) nodes.push(scope);
    scope.querySelectorAll('[data-i18n]').forEach(function (node) { nodes.push(node); });
    nodes.forEach(function (node) {
      var key = node.getAttribute('data-i18n');
      if (key) node.textContent = translate(key);
    });
    [
      ['data-i18n-title', 'title'],
      ['data-i18n-placeholder', 'placeholder'],
      ['data-i18n-aria-label', 'aria-label'],
      ['data-i18n-alt', 'alt']
    ].forEach(function (pair) {
      var selector = '[' + pair[0] + ']';
      var matches = [];
      if (scope.nodeType === 1 && scope.matches && scope.matches(selector)) matches.push(scope);
      scope.querySelectorAll(selector).forEach(function (node) { matches.push(node); });
      matches.forEach(function (node) { node.setAttribute(pair[1], translate(node.getAttribute(pair[0]))); });
    });
  }

  function register(language, messages, serverMessages) {
    var lang = normalize(language);
    if (!lang || !messages || typeof messages !== 'object') return;
    Object.assign(catalogs[lang], messages);
    if (serverMessages && typeof serverMessages === 'object') Object.assign(apiMessages[lang], serverMessages);
    if (document.body) apply(document);
  }

  function localizeApiMessage(message, fallbackKey) {
    var raw = String(message || '').trim();
    if (raw && apiMessages[state.effective] && apiMessages[state.effective][raw]) {
      return apiMessages[state.effective][raw];
    }
    if (state.effective === 'zh' && raw) return raw;
    if (raw) console.warn('[VNFLanguage] unmapped API message:', raw);
    return translate(fallbackKey || 'errors.unknown');
  }

  function runtimeBaseUrl() {
    var src = '';
    try {
      var script = document.currentScript || Array.from(document.scripts).find(function (item) {
        return /\/js\/language-runtime\.js(?:\?|$)/.test(item.src || '');
      });
      src = script && script.src ? script.src : new URL('./js/language-runtime.js', window.location.href).href;
      return new URL('../', src);
    } catch (error) {
      return new URL('./', window.location.href);
    }
  }

  var siteRoot = runtimeBaseUrl();
  var authUrl = new URL('api/auth.php', siteRoot);

  function requestMe() {
    if (authPromise) return authPromise;
    authPromise = fetch(authUrl.href + '?action=me&_=' + Date.now(), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
    return authPromise;
  }

  function postPreference(language) {
    return fetch(authUrl.href + '?action=update_language_preference', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ language: language })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok || !payload.success) {
          var error = new Error(payload.message || ('HTTP ' + response.status));
          error.payload = payload;
          throw error;
        }
        return payload;
      });
    });
  }

  function accountIdOf(user) {
    var id = user && Number(user.id);
    return Number.isFinite(id) && id > 0 ? String(id) : null;
  }

  function hydrateAccount(payload) {
    var user = payload && payload.logged_in && payload.user ? payload.user : null;
    var accountId = accountIdOf(user);
    state.authenticated = !!user;
    state.accountPreference = user ? normalize(user.language_preference) : null;

    if (!user) {
      state.status = 'ready';
      state.error = null;
      if (!override) setEffective(cached || browserLanguage(), cached ? 'legacy-local' : 'browser', 'guest-ready');
      return Promise.resolve(snapshot());
    }

    if (state.accountPreference) {
      cached = state.accountPreference;
      safeSet(localStorage, STORAGE_KEY, cached);
      safeSet(localStorage, ACCOUNT_KEY, accountId);
      state.status = 'ready';
      state.error = null;
      if (!override) setEffective(cached, 'account', 'account-ready');
      return Promise.resolve(snapshot());
    }

    var cachedAccountId = safeGet(localStorage, ACCOUNT_KEY);
    if (cached && (!cachedAccountId || cachedAccountId === accountId)) {
      return postPreference(cached).then(function () {
        state.accountPreference = cached;
        safeSet(localStorage, ACCOUNT_KEY, accountId);
        state.status = 'ready';
        state.error = null;
        if (!override) setEffective(cached, 'account', 'legacy-migrated');
        return snapshot();
      }).catch(function (error) {
        state.status = 'error';
        state.error = error.message || 'Unable to migrate language preference';
        if (!override) setEffective(cached, 'legacy-local', 'legacy-migration-failed');
        return snapshot();
      });
    }

    state.status = 'ready';
    state.error = null;
    if (!override) setEffective(browserLanguage(), 'browser', 'account-unset');
    return Promise.resolve(snapshot());
  }

  function setPreference(language) {
    var next = normalize(language);
    if (!next) return Promise.resolve({ success: false, language: state.effective, error: translate('errors.invalidLanguage') });
    if (!state.authenticated) return Promise.resolve({ success: false, language: state.effective, error: translate('errors.loginRequired') });

    var previous = snapshot();
    override = null;
    safeSet(sessionStorage, SESSION_OVERRIDE_KEY, null);
    state.saving = true;
    state.status = 'saving';
    state.error = null;
    setEffective(next, 'account', 'preference-preview');
    emit('preference-saving');

    return postPreference(next).then(function () {
      state.accountPreference = next;
      state.saving = false;
      state.status = 'ready';
      state.error = null;
      cached = next;
      safeSet(localStorage, STORAGE_KEY, next);
      requestMe().then(function (payload) {
        var id = accountIdOf(payload && payload.user);
        if (id) safeSet(localStorage, ACCOUNT_KEY, id);
      }).catch(function () {});
      emit('preference-saved');
      return { success: true, language: next, error: null };
    }).catch(function (error) {
      state.accountPreference = previous.accountPreference;
      state.saving = false;
      state.status = 'error';
      state.error = localizeApiMessage(error.message, 'errors.saveLanguage');
      setEffective(previous.effective, previous.source, 'preference-reverted');
      emit('preference-save-failed');
      return { success: false, language: previous.effective, error: state.error };
    });
  }

  function subscribe(callback) {
    if (typeof callback !== 'function') return function () {};
    listeners.add(callback);
    return function () { listeners.delete(callback); };
  }

  applyDocumentLanguage();

  var ready = requestMe().then(hydrateAccount).catch(function (error) {
    state.status = 'error';
    state.authenticated = false;
    state.error = error.message || 'Unable to load language preference';
    if (!override) setEffective(cached || browserLanguage(), cached ? 'legacy-local' : 'browser', 'auth-failed');
    return snapshot();
  }).then(function (value) {
    if (document.body) apply(document);
    emit('ready');
    return value;
  });

  window.addEventListener('storage', function (event) {
    if (event.key !== STORAGE_KEY) return;
    var next = normalize(event.newValue);
    if (!next || override || (state.authenticated && state.accountPreference)) return;
    cached = next;
    setEffective(next, 'legacy-local', 'storage');
  });

  window.VNFLanguage = {
    ready: ready,
    getState: snapshot,
    getLanguage: function () { return state.effective; },
    setPreference: setPreference,
    subscribe: subscribe,
    t: translate,
    apply: apply,
    localizeApiMessage: localizeApiMessage,
    register: register,
    hydrateAccount: hydrateAccount
  };
  try { window.dispatchEvent(new CustomEvent('vnfest:language-runtime-ready')); } catch (error) {}
})();
