'use strict';

function $vote(id) { return document.getElementById(id); }
function escVote(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function toastVote(el, message) {
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  setTimeout(function () { el.classList.remove('show'); }, 1800);
}
function apiVote(url, options) {
  return fetch(url, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {})).then(function (r) {
    return r.text().then(function (text) {
      try {
        return JSON.parse(text);
      } catch (e) {
        console.error('[apiVote] JSON parse failed for: ' + url);
        console.error('[apiVote] HTTP status: ' + r.status);
        console.error('[apiVote] Response preview (first 500 chars): ' + text.substring(0, 500));
        throw new Error('JSON parse failed (HTTP ' + r.status + '): ' + text.substring(0, 120));
      }
    });
  }).catch(function (error) {
    if (error && /^JSON parse failed/.test(error.message || '')) throw error;
    throw new Error('网络异常或接口不可用，请稍后重试');
  });
}
function postVote(url, body) {
  return apiVote(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
}
function typeLabelVote(type) { return type === 'moe' ? '萌战' : '十二器'; }
function sourceLabelVote(type) {
  return ({ bangumi_subject: 'Bangumi 作品', bangumi_character: 'Bangumi 角色', vndb_vn: 'VNDB', vndb_character: 'VNDB', manual: '手动' })[type] || type || '来源';
}
function statusLabelVote(status) {
  return ({ draft: '草稿', published: '已发布', running: '进行中', ended: '已结束', archived: '已归档', suspended: '已暂停', reviewing: '待裁定', locked: '已锁定' })[status] || status || '未知';
}
function tokenBadgeVote(type) {
  return '<span class="token ' + (type === 'moe' ? 'moe' : '') + '">' + (type === 'moe' ? '萌' : '12') + '</span>';
}
function openVotingStageVote(stages) {
  return stages.find(function (s) { return s.status === 'open' && s.vote_mode !== 'nomination'; });
}
function openNominationStageVote(stages) {
  return stages.find(function (s) { return s.status === 'open' && s.stage_type === 'nomination'; });
}
function parseConfigVote(s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (_) { return {}; }
}

// === Club name resolver (lazy, shared across vote pages) ===
var _clubNameMap = null;
var _clubNamePromise = null;

function _voteApiBase() {
  var scripts = document.getElementsByTagName('script');
  for (var i = 0; i < scripts.length; i++) {
    var src = scripts[i].src || '';
    if (/vote-common\.js(?:$|\?)/.test(src)) {
      // Script loaded as e.g. "../js/vote-common.js" or "./js/vote-common.js"
      // API lives one level up from js/ directory
      var idx = src.lastIndexOf('/js/vote-common.js');
      if (idx >= 0) return src.substring(0, idx) + '/api';
    }
  }
  return './api';
}

function ensureClubNamesLoaded() {
  if (_clubNamePromise) return _clubNamePromise;
  _clubNameMap = {};
  var base = _voteApiBase();
  _clubNamePromise = Promise.all([
    fetch(base + '/clubs.php', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).catch(function () { return { data: [] }; }),
    fetch(base + '/clubs_japan.php', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).catch(function () { return { data: [] }; })
  ]).then(function (results) {
    var countries = ['china', 'japan'];
    results.forEach(function (res, idx) {
      var country = countries[idx];
      var list = (res && res.data) || [];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c && c.id != null) {
          _clubNameMap[Number(c.id) + '_' + country] = c.display_name || c.name || null;
        }
      }
    });
  });
  return _clubNamePromise;
}

function resolveClubName(clubId, country) {
  if (!clubId && clubId !== 0) return '';
  var id = Number(clubId);
  var c = (country === 'japan') ? 'japan' : 'china';
  var name = _clubNameMap && (_clubNameMap[id + '_' + c]);
  if (name) return name;
  // Fallback: try the other country
  var other = c === 'china' ? 'japan' : 'china';
  var otherName = _clubNameMap && (_clubNameMap[id + '_' + other]);
  if (otherName) return otherName;
  return '同好会 #' + id;
}

// === Theme ===
(function () {
  var html = document.documentElement;
  var themeApi = window.VNFTheme;
  var MQ = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function resolveTheme() {
    if (themeApi && typeof themeApi.getEffectiveTheme === 'function') {
      return themeApi.getEffectiveTheme();
    }
    var saved = localStorage.getItem('themePreference');
    if (saved === 'light' || saved === 'dark') return saved;
    return MQ && MQ.matches ? 'dark' : 'light';
  }

  function applyTheme(t) {
    if (themeApi && typeof themeApi.apply === 'function') {
      themeApi.apply(t);
      return;
    }
    html.setAttribute('data-theme', t);
    html.setAttribute('data-theme-preference', t);
    html.style.colorScheme = t;
  }

  function handleChange() {
    var saved = localStorage.getItem('themePreference');
    if (!saved || saved === 'system') applyTheme(resolveTheme());
  }

  if (themeApi && typeof themeApi.subscribe === 'function') {
    themeApi.subscribe(function () {
      window.dispatchEvent(new CustomEvent('vote-theme-updated'));
    });
  } else {
    applyTheme(resolveTheme());
  }
  if (MQ && typeof MQ.addEventListener === 'function') {
    MQ.addEventListener('change', handleChange);
  } else if (MQ && typeof MQ.addListener === 'function') {
    MQ.addListener(handleChange);
  }
})();

function initVoteThemeToggle(buttonId) {
  var btn = document.getElementById(buttonId);
  if (!btn) return;
  var html = document.documentElement;
  var sun = btn.querySelector('.icon-sun');
  var moon = btn.querySelector('.icon-moon');
  function updateIcon() {
    var isDark = html.getAttribute('data-theme') === 'dark';
    if (sun) sun.style.display = isDark ? 'none' : '';
    if (moon) moon.style.display = isDark ? '' : 'none';
  }
  updateIcon();
  if (window.VNFTheme && typeof window.VNFTheme.subscribe === 'function') {
    window.VNFTheme.subscribe(updateIcon);
  }
  btn.addEventListener('click', function () {
    var next = html.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    if (window.VNFTheme && typeof window.VNFTheme.setPreference === 'function') {
      window.VNFTheme.setPreference(next);
    } else {
      html.setAttribute('data-theme', next);
      html.setAttribute('data-theme-preference', next);
      html.style.colorScheme = next;
      try { localStorage.setItem('themePreference', next); } catch (e) {}
    }
    updateIcon();
  });
}
