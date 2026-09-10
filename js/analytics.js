(function () {
  'use strict';

  if (window.__vnfestAnalyticsTracked) return;
  window.__vnfestAnalyticsTracked = true;

  // This collector is intentionally independent from the site's language,
  // theme, and header runtimes. A failed analytics request must never affect
  // the page that the visitor is trying to use.
  var script = document.currentScript;
  var endpoint = '';
  try {
    if (!script) {
      var scripts = document.getElementsByTagName('script');
      for (var i = scripts.length - 1; i >= 0; i -= 1) {
        if (/\/js\/analytics\.js(?:\?|$)/.test(scripts[i].src || '')) {
          script = scripts[i];
          break;
        }
      }
    }
    endpoint = new URL('../api/analytics.php?action=track', (script && script.src) || window.location.href).href;
  } catch (error) {
    endpoint = '/api/analytics.php?action=track';
  }

  function randomUuid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        var bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        var hex = Array.prototype.map.call(bytes, function (byte) {
          return ('0' + byte.toString(16)).slice(-2);
        }).join('');
        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-' + ((parseInt(hex.slice(16, 18), 16) & 3 | 8).toString(16)) + hex.slice(17, 20) + '-' + hex.slice(20);
      }
    } catch (error) {}
    return '00000000-0000-4000-8000-' + String(Date.now()).slice(-12).padStart(12, '0');
  }

  function getCookie(name) {
    var prefix = name + '=';
    var cookies = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < cookies.length; i += 1) {
      var value = cookies[i].replace(/^\s+/, '');
      if (value.indexOf(prefix) === 0) return decodeURIComponent(value.slice(prefix.length));
    }
    return '';
  }

  function setCookie(name, value) {
    var cookie = name + '=' + encodeURIComponent(value) + '; Max-Age=31536000; Path=/; SameSite=Lax';
    if (window.location.protocol === 'https:') cookie += '; Secure';
    document.cookie = cookie;
  }

  function visitorId() {
    var current = getCookie('vnfest_visitor_id');
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(current)) return current;
    current = randomUuid();
    setCookie('vnfest_visitor_id', current);
    return current;
  }

  function hostOf(referrer) {
    try { return referrer ? new URL(referrer).hostname.toLowerCase() : ''; } catch (error) { return ''; }
  }

  function sourceCategory(referrerHost) {
    if (!referrerHost) return 'direct';
    if (referrerHost === window.location.hostname.toLowerCase()) return 'internal';
    if (/(^|\.)(google|bing|baidu|sogou|yahoo|duckduckgo)\./i.test(referrerHost)) return 'search';
    if (/(^|\.)(twitter|x|facebook|instagram|youtube|bilibili|weibo|reddit|discord)\./i.test(referrerHost)) return 'social';
    return 'external';
  }

  function deviceType() {
    var ua = navigator.userAgent || '';
    if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
    if (/Android|iPhone|iPod|Mobile|Windows Phone/i.test(ua)) return 'mobile';
    if (ua) return 'desktop';
    return 'unknown';
  }

  function browserName() {
    var ua = navigator.userAgent || '';
    if (/Edg\//i.test(ua)) return 'edge';
    if (/Firefox\//i.test(ua)) return 'firefox';
    if (/Chrome\//i.test(ua) || /Chromium\//i.test(ua)) return 'chrome';
    if (/Safari\//i.test(ua)) return 'safari';
    return 'other';
  }

  function shouldSkip(path) {
    return !/^https?:$/i.test(window.location.protocol)
      || /\/(?:admin|api|scripts|includes|data|uploads|node_modules|vendor)(?:\/|$)/i.test(path)
      || /(?:^|\/)(?:test|tests|fixture|fixtures)(?:\/|[-_.]|$)/i.test(path);
  }

  function send(payload) {
    var serialized = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([serialized], { type: 'application/json' });
        if (navigator.sendBeacon(endpoint, blob)) return;
      }
    } catch (error) {}
    try {
      fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: serialized,
        keepalive: true
      }).catch(function () {});
    } catch (error) {}
  }

  try {
    var path = window.location.pathname || '/';
    if (shouldSkip(path)) return;
    var referrerHost = hostOf(document.referrer || '');
    send({
      event_id: randomUuid(),
      visitor_id: visitorId(),
      page_path: path,
      page_title: document.title || '',
      source_category: sourceCategory(referrerHost),
      referrer_host: referrerHost,
      device_type: deviceType(),
      browser_name: browserName()
    });
  } catch (error) {}
})();
