/* js/verify.js - 凭证公开验证页 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render(c) {
    var box = document.getElementById('verify-result');
    if (!c) { box.innerHTML = ''; return; }

    // 持有人选择不公开：仅确认存在性与状态
    if (c.public_visibility === 0) {
      box.innerHTML = '<div class="cred-card">' +
        '<div class="badge-dot"></div>' +
        '<div><div style="font-weight:700">' + esc(c.credential_uid) + '</div>' +
        '<div class="muted">' + esc(c.status_text || '该凭证持有人选择不公开详情') + '</div></div></div>';
      return;
    }

    var statusCls = c.status === 'active' ? 'status-active' : (c.status === 'revoked' ? 'status-revoked' : 'status-expired');
    var verifyText = {
      auto: '自动验证', single_review: '单人审核', multi_review: '多人审核',
      owner_grant: '负责人签发', external_system: '外部系统证明', joint_issue: '联名签发', platform: '平台合作验证'
    }[c.verification_level] || c.verification_level;

    var conditions = (c.conditions || []).map(function (s) {
      return '<li>' + esc(s) + '</li>';
    }).join('');

    box.innerHTML = '<div class="cred-card">' +
      (c.badge_image ? '<img src="' + esc(c.badge_image) + '" alt="" style="width:64px;height:64px;border-radius:50%;object-fit:cover">' : '<div class="badge-dot" style="width:64px;height:64px"></div>') +
      '<div style="flex:1">' +
        '<div style="font-size:18px;font-weight:900">' + esc(c.badge_name) + '</div>' +
        '<div class="muted">' + esc(c.club_name) + ' 签发 · 项目「' + esc(c.program_title) + '」</div>' +
        '<div class="muted">编号：' + esc(c.credential_uid) + '</div>' +
      '</div>' +
      '<div style="text-align:right">' +
        '<div class="' + statusCls + '" style="font-weight:900;font-size:16px">' + esc(c.status_text || c.status) + '</div>' +
        '<div class="muted">验证强度：' + esc(verifyText) + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="panel" style="margin-top:10px">' +
      '<p><strong>签发时间：</strong>' + esc(c.issued_at) +
        (c.expires_at ? '　<strong>有效期至：</strong>' + esc(c.expires_at) : '') +
        (c.revoked_at ? '　<strong>撤销时间：</strong>' + esc(c.revoked_at) : '') + '</p>' +
      (conditions ? '<p style="margin-bottom:4px"><strong>获得条件：</strong></p><ul style="margin:0">' + conditions + '</ul>' : '') +
    '</div>';
  }

  function verify(uid) {
    var box = document.getElementById('verify-result');
    box.innerHTML = '<p class="empty">验证中…</p>';
    fetch('api/recognition_credentials.php?action=verify&uid=' + encodeURIComponent(uid), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || !res.success) {
          box.innerHTML = '<div class="result-banner result-fail">' + esc(res && res.message || '未找到该凭证编号') + '</div>';
          return;
        }
        render(res.credential);
      })
      .catch(function () {
        box.innerHTML = '<div class="result-banner result-fail">网络错误，请稍后重试</div>';
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var input = document.getElementById('verify-uid');
    document.getElementById('verify-btn').addEventListener('click', function () {
      var uid = input.value.trim();
      if (uid) verify(uid);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && input.value.trim()) verify(input.value.trim());
    });

    // 支持 ?uid= 直达
    var uid = new URLSearchParams(location.search).get('uid');
    if (uid) {
      input.value = uid;
      verify(uid);
    }
  });
})();
