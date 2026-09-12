/* GalgameTool → 同好会动态 一键转发共享组件
 * 用法：window.VNFPostShare.share({ canvas | blob, defaultText })
 * 依赖同域 session（未登录自动跳登录页），产物上传 api/post_images.php 后经 api/posts.php?action=create 发布。
 */
(function () {
  'use strict';

  var POSTS_API = '../../api/posts.php';
  var IMAGES_API = '../../api/post_images.php';
  var LOGIN_URL = '../../../login.html';
  var CONTENT_MAX = 280;

  var modal = null;
  var state = { busy: false };

  function makeToken() {
    var bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return 'post-' + Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function jsonOf(res) {
    return res.json().catch(function () { return null; });
  }

  function apiPost(action, payload) {
    return fetch(POSTS_API + '?action=' + encodeURIComponent(action), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(jsonOf);
  }

  function toast(message, isError) {
    var el = document.createElement('div');
    el.className = 'vnf-share-toast' + (isError ? ' vnf-share-toast-error' : '');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add('is-visible'); }, 10);
    setTimeout(function () {
      el.classList.remove('is-visible');
      setTimeout(function () { el.remove(); }, 300);
    }, 2800);
  }

  function ensureSession() {
    if (sessionReady()) return Promise.resolve(true);
    return fetch(POSTS_API + '?action=bootstrap', { credentials: 'same-origin' })
      .then(jsonOf)
      .then(function (data) {
        if (data && data.success && data.data && data.data.user) {
          window.__vnShareSession = { user: data.data.user, clubs: data.data.clubs || [] };
          return true;
        }
        toast('请先登录后再转发到动态', true);
        setTimeout(function () { window.open(LOGIN_URL, '_blank'); }, 600);
        return false;
      })
      .catch(function () {
        toast('网络异常，请稍后重试', true);
        return false;
      });
  }

  function sessionReady() {
    return !!(window.__vnShareSession && window.__vnShareSession.user);
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('toBlob failed')); }, 'image/png');
        return;
      }
      reject(new Error('canvas.toBlob unavailable'));
    });
  }

  function ensureStyles() {
    if (document.getElementById('vnf-share-style')) return;
    var style = document.createElement('style');
    style.id = 'vnf-share-style';
    style.textContent = [
      '.vnf-share-mask{position:fixed;inset:0;z-index:99990;background:rgba(15,15,16,.6);display:flex;align-items:flex-start;justify-content:center;padding:48px 16px;overflow-y:auto;}',
      '.vnf-share-panel{width:520px;max-width:100%;background:var(--vn-surface,#fff);color:var(--vn-text,#1a1a1a);border:1px solid var(--vn-border,rgba(0,0,0,.08));border-radius:18px;padding:14px 16px 16px;box-shadow:var(--vn-shadow,rgba(0,0,0,.15));}',
      '[data-theme="dark"] .vnf-share-panel{background:var(--vn-surface,#1a1a1c);color:var(--vn-text,#f0f0f0);}',
      '.vnf-share-head{display:flex;align-items:center;gap:10px;font-weight:700;margin-bottom:12px;}',
      '.vnf-share-close{margin-left:auto;width:32px;height:32px;border-radius:999px;border:none;background:transparent;color:inherit;font-size:18px;cursor:pointer;}',
      '.vnf-share-close:hover{background:var(--vn-overlay,rgba(0,0,0,.05));}',
      '.vnf-share-preview{max-width:100%;max-height:300px;border:1px solid var(--vn-border,rgba(0,0,0,.08));border-radius:14px;display:block;margin:0 auto 10px;}',
      '.vnf-share-text{width:100%;min-height:88px;resize:vertical;border:1px solid var(--vn-border-strong,rgba(0,0,0,.14));border-radius:12px;padding:10px 12px;font:inherit;background:transparent;color:inherit;box-sizing:border-box;}',
      '.vnf-share-text:focus{outline:2px solid var(--vn-primary,#e74c3c);}',
      '.vnf-share-row{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap;}',
      '.vnf-share-count{margin-left:auto;font-size:13px;color:var(--vn-text-muted,#666);}',
      '.vnf-share-count.is-over{color:var(--vn-danger,#c73545);font-weight:700;}',
      '.vnf-share-select{max-width:190px;border:1px solid var(--vn-border-strong,rgba(0,0,0,.14));border-radius:999px;padding:6px 12px;background:transparent;color:inherit;font:inherit;font-size:13px;}',
      '.vnf-share-submit{border:none;border-radius:999px;padding:9px 22px;font-weight:700;font-size:14px;color:#fff;background:var(--vn-primary,#e74c3c);cursor:pointer;}',
      '.vnf-share-submit:hover{background:var(--vn-primary-strong,#c0392b);}',
      '.vnf-share-submit:disabled{opacity:.45;cursor:not-allowed;}',
      '.vnf-share-toast{position:fixed;left:50%;bottom:36px;transform:translateX(-50%) translateY(12px);z-index:99991;background:var(--vn-surface,#fff);color:var(--vn-text,#1a1a1a);border:1px solid var(--vn-border,rgba(0,0,0,.08));border-radius:999px;padding:9px 18px;font-size:14px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.2);opacity:0;transition:.25s;}',
      '.vnf-share-toast.is-visible{opacity:1;transform:translateX(-50%);}',
      '.vnf-share-toast-error{color:var(--vn-danger,#c73545);}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function ensureModal() {
    ensureStyles();
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'vnf-share-mask';
    modal.style.display = 'none';
    modal.innerHTML = [
      '<div class="vnf-share-panel" role="dialog" aria-modal="true">',
      '  <div class="vnf-share-head"><span>转发到同好会动态</span><button type="button" class="vnf-share-close" title="关闭">✕</button></div>',
      '  <img class="vnf-share-preview" alt="" />',
      '  <textarea class="vnf-share-text" maxlength="' + (CONTENT_MAX + 40) + '" placeholder="说点什么…"></textarea>',
      '  <div class="vnf-share-row">',
      '    <select class="vnf-share-select"><option value="">不署名</option></select>',
      '    <span class="vnf-share-count"></span>',
      '    <button type="button" class="vnf-share-submit">发布</button>',
      '  </div>',
      '</div>'
    ].join('');
    document.body.appendChild(modal);

    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    modal.querySelector('.vnf-share-close').addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modal.style.display !== 'none') close(); });

    var text = modal.querySelector('.vnf-share-text');
    var count = modal.querySelector('.vnf-share-count');
    function syncCount() {
      var remaining = CONTENT_MAX - Array.from(text.value).length;
      count.textContent = remaining <= 20 ? String(remaining) : '';
      count.classList.toggle('is-over', remaining < 0);
      modal.querySelector('.vnf-share-submit').disabled = state.busy || remaining < 0 || (!text.value.trim() && !modal.querySelector('.vnf-share-preview').src);
    }
    text.addEventListener('input', syncCount);
    return modal;
  }

  function close() {
    if (!modal) return;
    modal.style.display = 'none';
  }

  function toBlob(item) {
    if (item && item.blob) return Promise.resolve(item.blob);
    return canvasToBlob(item.canvas || item);
  }

  function share(options) {
    options = options || {};
    ensureSession().then(function (ok) {
      if (!ok) return;
      var sources = [];
      if (options.blobs || options.canvases) {
        sources = (options.blobs || options.canvases).slice(0, 4).map(toBlob);
      } else {
        sources = [toBlob(options.blob ? { blob: options.blob } : { canvas: options.canvas })];
      }
      Promise.all(sources)
        .then(function (blobs) {
          blobs = blobs.filter(Boolean);
          if (!blobs.length) throw new Error('no image');
          openModal(blobs, options.defaultText || '');
        })
        .catch(function () { toast('图片生成失败，请重试', true); });
    });
  }

  function openModal(blobsArg, defaultText) {
    var blobs = Array.isArray(blobsArg) ? blobsArg : [blobsArg];
    var panel = ensureModal();
    var preview = panel.querySelector('.vnf-share-preview');
    var text = panel.querySelector('.vnf-share-text');
    var select = panel.querySelector('.vnf-share-select');
    var submit = panel.querySelector('.vnf-share-submit');
    var count = panel.querySelector('.vnf-share-count');

    if (preview.dataset.url) URL.revokeObjectURL(preview.dataset.url);
    preview.dataset.url = URL.createObjectURL(blobs[0]);
    preview.src = preview.dataset.url;
    if (blobs.length > 1) {
      var badge = panel.querySelector('.vnf-share-count');
      badge.textContent = blobs.length + ' 张图片';
    }
    text.value = defaultText.slice(0, CONTENT_MAX + 40);

    var session = window.__vnShareSession || { clubs: [] };
    select.innerHTML = '<option value="">不署名</option>';
    (session.clubs || []).forEach(function (club) {
      var opt = document.createElement('option');
      opt.value = String(club.membership_id);
      opt.textContent = club.name;
      select.appendChild(opt);
    });

    var uploadToken = makeToken();
    state.busy = false;
    submit.disabled = false;
    count.textContent = '';
    panel.style.display = 'flex';
    setTimeout(function () { text.focus(); }, 50);

    submit.onclick = function () {
      var content = text.value.trim();
      var remaining = CONTENT_MAX - Array.from(content).length;
      if (remaining < 0 || (!content && !preview.src)) return;
      state.busy = true;
      submit.disabled = true;
      submit.textContent = '发布中…';

      var uploadOne = function (blob, index) {
        var form = new FormData();
        form.append('image', blob, 'board' + (index ? index + 1 : '') + '.png');
        form.append('upload_token', uploadToken);
        return fetch(IMAGES_API, { method: 'POST', credentials: 'same-origin', body: form })
          .then(jsonOf)
          .then(function (up) {
            if (!up || !up.success) throw new Error((up && up.error && up.error.message) || '图片上传失败');
            return up.data.attachment.relative_path;
          });
      };
      Promise.all(blobs.map(uploadOne))
        .then(function (paths) {
          return apiPost('create', {
            content: content,
            images: paths,
            upload_token: uploadToken,
            club_membership_id: select.value || undefined
          });
        })
        .then(function (done) {
          if (!done || !done.success) throw new Error((done && done.error && done.error.message) || '发布失败');
          close();
          var postId = done.data && done.data.post && done.data.post.id;
          toast('已转发到同好会动态');
          if (postId) setTimeout(function () { window.open('../../column/post/' + postId + '/', '_blank'); }, 800);
        })
        .catch(function (err) {
          toast(err.message || '转发失败，请稍后重试', true);
        })
        .finally(function () {
          state.busy = false;
          submit.disabled = false;
          submit.textContent = '发布';
        });
    };
  }

  window.VNFPostShare = { share: share };
})();
