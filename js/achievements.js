/* js/achievements.js - 认可图鉴（我的成就库） */
(function () {
  'use strict';

  var all = [];
  var filter = '';

  var STATUS_TEXT = { active: '有效', expired: '已过期', revoked: '已撤销', superseded: '已被替代' };
  var VERIFY_TEXT = {
    auto: '自动验证', single_review: '单人审核', multi_review: '多人审核',
    owner_grant: '负责人签发', external_system: '外部系统证明', joint_issue: '联名签发', platform: '平台合作验证'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch('api/' + path, {
      method: opts.body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) { return r.json(); });
  }

  function load() {
    api('auth.php?action=me').then(function (res) {
      if (!res || !res.logged_in) {
        document.getElementById('credential-list').innerHTML =
          '<p class="empty">请先 <a href="login.html" style="color:var(--red)">登录</a> 后查看你的认可图鉴。</p>';
        return;
      }
      api('recognition_credentials.php?action=my').then(function (r) {
        if (!r || !r.success) return;
        all = r.credentials || [];
        renderSummary(r.summary || {});
        renderList();
      });
    });
  }

  function renderSummary(s) {
    document.getElementById('summary').innerHTML =
      '<div><div style="font-size:26px;font-weight:900;color:var(--gold)">' + (s.total || 0) + '</div><div class="muted">徽章总数</div></div>' +
      '<div><div style="font-size:26px;font-weight:900;color:var(--green)">' + (s.active || 0) + '</div><div class="muted">当前有效</div></div>' +
      '<div><div style="font-size:26px;font-weight:900;color:var(--blue)">' + (s.club_count || 0) + '</div><div class="muted">认可同好会数</div></div>';
  }

  function renderList() {
    var box = document.getElementById('credential-list');
    var rows = all.filter(function (c) {
      if (filter === 'active') return c.status === 'active';
      if (filter === 'history') return c.status !== 'active';
      return true;
    });
    if (!rows.length) {
      box.innerHTML = '<p class="empty">' +
        (all.length ? '该筛选下没有凭证。' : '还没有获得任何认可。去 <a href="trial/index.html" style="color:var(--red)">同好会试炼</a> 看看吧。') + '</p>';
      return;
    }
    box.innerHTML = rows.map(function (c) {
      var statusCls = c.status === 'active' ? 'status-active' : (c.status === 'revoked' ? 'status-revoked' : 'status-expired');
      var statusText = c.status === 'revoked' ? '历史凭证，当前已撤销' : (STATUS_TEXT[c.status] || c.status);
      var visibilityBtn = c.status === 'active'
        ? '<button class="btn btn-ghost" data-vis="' + esc(c.credential_uid) + '" data-current="' + (c.public_visibility ? 1 : 0) + '">' +
          (c.public_visibility ? '设为私密' : '设为公开') + '</button>'
        : '';
      return '<div class="cred-card">' +
        (c.badge_image ? '<img src="' + esc(c.badge_image) + '" alt="" style="width:44px;height:44px;border-radius:50%;object-fit:cover">' : '<div class="badge-dot"></div>') +
        '<div style="flex:1">' +
          '<div style="font-weight:700">' + esc(c.badge_name) + '</div>' +
          '<div class="muted">' + esc(c.club_name) + ' · ' + esc(c.program_title) + '</div>' +
          '<div class="muted">' +
            '<span class="' + statusCls + '">' + esc(statusText) + '</span>' +
            ' · ' + esc(VERIFY_TEXT[c.verification_level] || c.verification_level) +
            ' · 签发于 ' + esc((c.issued_at || '').slice(0, 10)) +
            (c.expires_at ? ' · 有效期至 ' + esc(c.expires_at.slice(0, 10)) : '') +
          '</div>' +
          (c.revocation_reason ? '<div class="muted status-revoked">撤销原因：' + esc(c.revocation_reason) + '</div>' : '') +
        '</div>' +
        '<div class="row">' +
          '<a class="btn" href="verify.html?uid=' + encodeURIComponent(c.credential_uid) + '">验证页</a>' +
          visibilityBtn +
        '</div>' +
      '</div>';
    }).join('');

    box.querySelectorAll('[data-vis]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        api('recognition_credentials.php?action=set_visibility', {
          body: { credential_uid: btn.dataset.vis, public_visibility: btn.dataset.current === '1' ? 0 : 1 }
        }).then(function (r) { if (r.success) load(); });
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-filter]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        document.querySelectorAll('[data-filter]').forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
        filter = chip.dataset.filter;
        renderList();
      });
    });
    load();
  });
})();
