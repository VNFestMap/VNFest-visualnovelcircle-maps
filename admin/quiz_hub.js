// admin/quiz_hub.js - 题库区：本站公开题库 + 共享题库 + makoquiz 市集连携
// 市集请求走本站 quiz_hub.php 代理（避免跨域），转译在服务端完成。
// 共享题库：登录用户可上传（答案由服务端剥离），所有人可下载。
(function () {
  'use strict';

  var TYPE_LABEL = { single: '单选', multiple: '多选', judge: '判断', fill_blank: '填空', order: '排序', fill_multi: '多空填空' };
  // makoquiz 题型名（仅用于市集卡片标签展示）
  var MAKO_LABEL = { single: '单选', multi: '多选', truefalse: '是非', match: '配对', categorize: '分类', order: '顺序', type: '填空', list: '复数答案', number: '数字', soup: '海龟汤', reveal: '猜图', music: '音乐', scale: '评分', open: '开放', qa: '提问', content: '内容页' };
  var DIRECT_KEY = 'recog_qd_direct'; // 与设计器约定的直连导入键

  var state = { tab: 'local', localItems: [], sharedItems: [], sharedLoaded: false, galleryLoaded: false, q: '', userId: 0 };

  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg) {
    var el = $('#hubToast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 3600);
  }
  function api(path) {
    return fetch('../api/' + path, { credentials: 'same-origin' }).then(function (r) { return r.json(); });
  }
  function showLoginHint() { $('#hubLoginHint').hidden = false; }

  // ---------- 载入设计器 / 下载 ----------
  function openInDesigner(quiz, title) {
    try {
      localStorage.setItem(DIRECT_KEY, JSON.stringify({ ts: Date.now(), title: title, quiz: quiz }));
    } catch (e) {
      toast('浏览器存储不可用，请改用下载后导入');
      return;
    }
    window.open('quiz_designer.html', '_blank');
    toast('已载入设计器，题目将在打开后自动导入');
  }

  function downloadJson(quiz, filename) {
    var blob = new Blob([JSON.stringify(quiz, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'quiz_questions.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }

  // ---------- 登录态 ----------
  function checkLogin() {
    api('quiz_hub.php?action=login_state').then(function (res) {
      if (res && res.logged_in) {
        state.userId = res.user_id || 0;
        $('#hubUpload').hidden = false;
      } else {
        showLoginHint();
      }
    }).catch(function () { /* 登录态查询失败不阻塞浏览 */ });
  }

  // ---------- 本站题库 ----------
  function renderLocal() {
    var body = $('#hubBody');
    body.innerHTML = '<div class="empty">加载中…</div>';
    api('quiz_hub.php?action=local').then(function (res) {
      if (!res || !res.success) { body.innerHTML = '<div class="empty">' + esc((res && res.message) || '加载失败') + '</div>'; return; }
      state.localItems = res.items || [];
      paintLocal();
    }).catch(function () { body.innerHTML = '<div class="empty">加载失败，请刷新重试</div>'; });
  }

  function paintLocal() {
    var body = $('#hubBody');
    var q = state.q.toLowerCase();
    var items = state.localItems.filter(function (it) {
      return !q || (it.title + it.club_name).toLowerCase().indexOf(q) >= 0;
    });
    if (!items.length) { body.innerHTML = '<div class="empty">' + (q ? '没有匹配的题库' : '还没有已发布的答题考核题库') + '</div>'; return; }
    body.innerHTML = '<div class="grid">' + items.map(function (it) {
      var tags = Object.keys(it.type_counts || {}).map(function (t) {
        return '<span class="tag">' + esc(TYPE_LABEL[t] || t) + ' ×' + it.type_counts[t] + '</span>';
      }).join('');
      return '<div class="card">' +
        '<h3>' + esc(it.title) + '</h3>' +
        '<div class="desc">' + esc(it.intro || '') + '</div>' +
        '<div class="meta"><span>' + esc(it.club_name) + '</span><span>' + it.question_count + ' 题</span>' + (it.time_limit > 0 ? '<span>限时 ' + it.time_limit + ' 分</span>' : '') + '</div>' +
        '<div class="tags">' + tags + '</div>' +
        '<div class="actions">' +
          '<button class="btn primary" data-local-open="' + it.id + '">载入设计器</button>' +
          '<button class="btn" data-local-dl="' + it.id + '">下载 JSON</button>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  // ---------- 共享题库（列表与搜索都走服务端） ----------
  function renderShared() {
    var body = $('#hubBody');
    body.innerHTML = '<div class="empty">加载中…</div>';
    var qs = state.q ? '&q=' + encodeURIComponent(state.q) : '';
    api('quiz_hub.php?action=shared_list' + qs).then(function (res) {
      if (!res || !res.success) { body.innerHTML = '<div class="empty">' + esc((res && res.message) || '加载失败') + '</div>'; return; }
      state.sharedItems = res.items || [];
      state.sharedLoaded = true;
      paintShared();
    }).catch(function () { body.innerHTML = '<div class="empty">加载失败，请刷新重试</div>'; });
  }

  function paintShared() {
    var body = $('#hubBody');
    var items = state.sharedItems;
    if (!items.length) {
      body.innerHTML = '<div class="empty">' + (state.q ? '没有匹配的题库' : '还没有共享题库，点右上角「上传题库」分享第一份') + '</div>';
      return;
    }
    body.innerHTML = '<div class="grid">' + items.map(function (it) {
      var tags = Object.keys(it.type_counts || {}).map(function (t) {
        return '<span class="tag">' + esc(TYPE_LABEL[t] || t) + ' ×' + it.type_counts[t] + '</span>';
      }).join('');
      var mine = state.userId > 0 && it.uploader_id === state.userId;
      return '<div class="card">' +
        '<h3>' + esc(it.title) + (mine ? ' <span class="tag gold">我上传的</span>' : '') + '</h3>' +
        '<div class="desc">' + esc(it.description || '') + '</div>' +
        '<div class="meta"><span>' + esc(it.uploader_name || '匿名') + '</span><span>' + it.question_count + ' 题</span><span>下载 ' + it.downloads + '</span></div>' +
        '<div class="tags">' + tags + '</div>' +
        '<div class="actions">' +
          '<button class="btn primary" data-shared-open="' + it.id + '">载入设计器</button>' +
          '<button class="btn" data-shared-dl="' + it.id + '">下载 JSON</button>' +
          (mine ? '<button class="btn" data-shared-del="' + it.id + '">删除</button>' : '') +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  // ---------- 上传共享题库 ----------
  var pendingUpload = null; // { file, questions }

  function pickUploadFile() {
    if (!state.userId) {
      showLoginHint();
      toast('上传共享题库需要先登录');
      return;
    }
    $('#hubUploadFile').click();
  }

  function onUploadPicked(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var data;
      try { data = JSON.parse(fr.result); } catch (e) { toast('这个文件不是合法的 JSON'); return; }
      var quiz = data && data.quiz && typeof data.quiz === 'object' ? data.quiz : data;
      if (!quiz || !Array.isArray(quiz.questions) || !quiz.questions.length) {
        toast('题库里需要有 questions 数组，且至少 1 道题');
        return;
      }
      pendingUpload = { file: file, questions: quiz.questions.length };
      $('#hubModalFile').textContent = file.name + ' · ' + pendingUpload.questions + ' 道题';
      $('#hubShareTitle').value = file.name.replace(/\.json$/i, '');
      $('#hubShareDesc').value = '';
      $('#hubModal').hidden = false;
    };
    fr.readAsText(file);
  }

  function confirmUpload() {
    if (!pendingUpload) return;
    var ok = $('#hubModalOk');
    ok.disabled = true;
    var fd = new FormData();
    fd.append('file', pendingUpload.file);
    fd.append('title', $('#hubShareTitle').value.trim());
    fd.append('description', $('#hubShareDesc').value.trim());
    fetch('../api/quiz_hub.php?action=shared_upload', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (out) {
        ok.disabled = false;
        var res = out.j;
        if (!res) { toast('上传失败：服务器返回了无法解析的响应（HTTP ' + out.status + '）'); return; }
        if (out.status === 401 || res.logged_in === false) { showLoginHint(); toast('登录状态已失效，请重新登录后再上传'); return; }
        if (!res.success) { toast(res.message || '上传失败'); return; }
        $('#hubModal').hidden = true;
        pendingUpload = null;
        toast('已上传到共享题库（答案已剥离）');
        state.sharedLoaded = false;
        if (state.tab === 'shared') renderShared();
      })
      .catch(function () { ok.disabled = false; toast('上传失败：网络错误，请稍后重试'); });
  }

  // ---------- makoquiz 市集 ----------
  function renderGallery() {
    var body = $('#hubBody');
    body.innerHTML = '<div class="empty">正在连接市集…</div>';
    var qs = state.q ? '&q=' + encodeURIComponent(state.q) : '';
    api('quiz_hub.php?action=gallery&limit=36&sort=new' + qs).then(function (res) {
      if (!res || !res.success) {
        body.innerHTML = '<div class="empty">' + esc((res && res.message) || '市集暂时连不上') + '</div>';
        return;
      }
      state.galleryLoaded = true;
      var items = res.items || [];
      if (!items.length) { body.innerHTML = '<div class="empty">市集里还没有题库，去 makoquiz 发布第一份吧</div>'; return; }
      body.innerHTML = '<div class="grid">' + items.map(function (it) {
        var tags = Object.keys(it.typeCounts || {}).slice(0, 6).map(function (t) {
          return '<span class="tag">' + esc(MAKO_LABEL[t] || t) + ' ×' + it.typeCounts[t] + '</span>';
        }).join('');
        return '<div class="card">' +
          '<img class="cover" src="../api/quiz_hub.php?action=cover&id=' + encodeURIComponent(it.id) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' +
          '<h3>' + esc(it.title) + '</h3>' +
          '<div class="desc">' + esc(it.description || '') + '</div>' +
          '<div class="meta"><span>' + esc(it.author || '匿名') + '</span><span>' + (it.slideCount || 0) + ' 页</span><span>下载 ' + (it.downloads || 0) + '</span></div>' +
          '<div class="tags">' + tags + '</div>' +
          '<div class="actions">' +
            '<button class="btn primary" data-mako-import="' + esc(it.id) + '" data-mako-title="' + esc(it.title) + '">转译并载入</button>' +
            '<button class="btn" data-mako-dl="' + esc(it.id) + '" data-mako-title="' + esc(it.title) + '">转译并下载</button>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
    }).catch(function () { body.innerHTML = '<div class="empty">市集请求失败，请稍后重试</div>'; });
  }

  // 市集题库转译（服务端解包转换），成功后交给回调。
  // 错误分类处理：网络失败 / 响应无法解析 / 未登录 / 业务失败，各自给出真实原因，
  // 避免"已登录却被提示需要登录"的误导。
  async function convertMako(id, title, cb) {
    toast('正在转译「' + title + '」…');
    var resp;
    try {
      resp = await fetch('../api/quiz_hub.php?action=import&id=' + encodeURIComponent(id), { credentials: 'same-origin' });
    } catch (e) {
      toast('转译失败：请求没有发出（网络错误），请稍后重试');
      return;
    }
    var text = '';
    try { text = await resp.text(); } catch (e) { /* 忽略 */ }
    var res = null;
    try { res = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    if (!res || typeof res !== 'object') {
      toast('转译失败：服务器返回了无法解析的响应（HTTP ' + resp.status + '），请稍后重试');
      return;
    }
    if (resp.status === 401 || res.logged_in === false) {
      showLoginHint();
      toast('需要先登录才能转译市集题库（登录状态可能已过期，请重新登录）');
      return;
    }
    if (!res.success) {
      var notes = (res.notes && res.notes.length) ? '（' + res.notes.join('；') + '）' : '';
      toast((res.message || '转译失败') + notes);
      return;
    }
    if (res.notes && res.notes.length) toast('转译完成：' + res.converted_count + ' 题。' + res.notes[0]);
    else toast('转译完成：' + res.converted_count + ' 题');
    cb(res.quiz, res.source_title || title);
  }

  // ---------- 事件 ----------
  function switchTab(tab, activeEl) {
    state.tab = tab;
    ['#tabLocal', '#tabShared', '#tabGallery'].forEach(function (sel) { $(sel).classList.remove('active'); });
    activeEl.classList.add('active');
    $('#hubSearch').hidden = false;
  }

  function bind() {
    $('#tabLocal').addEventListener('click', function () {
      switchTab('local', this);
      if (!state.localItems.length) renderLocal(); else paintLocal();
    });
    $('#tabShared').addEventListener('click', function () {
      switchTab('shared', this);
      renderShared();
    });
    $('#tabGallery').addEventListener('click', function () {
      switchTab('gallery', this);
      renderGallery();
    });
    var debounce = null;
    $('#hubSearch').addEventListener('input', function () {
      state.q = this.value.trim();
      clearTimeout(debounce);
      debounce = setTimeout(function () {
        if (state.tab === 'local') paintLocal();
        else if (state.tab === 'shared') renderShared();
        else renderGallery();
      }, 300);
    });

    // 上传
    $('#hubUpload').addEventListener('click', pickUploadFile);
    $('#hubUploadFile').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (f) onUploadPicked(f);
    });
    $('#hubModalOk').addEventListener('click', confirmUpload);
    $('#hubModalCancel').addEventListener('click', function () { $('#hubModal').hidden = true; pendingUpload = null; });
    $('#hubModal').addEventListener('click', function (e) {
      if (e.target === this) { this.hidden = true; pendingUpload = null; }
    });

    $('#hubBody').addEventListener('click', function (e) {
      var t = e.target;
      if (t.matches('[data-local-open]') || t.matches('[data-local-dl]')) {
        var id = t.dataset.localOpen || t.dataset.localDl;
        var it = state.localItems.find(function (x) { return String(x.id) === String(id); });
        if (!it) return;
        t.disabled = true;
        api('quiz_hub.php?action=local_quiz&id=' + id).then(function (res) {
          t.disabled = false;
          if (!res || !res.success) { toast((res && res.message) || '加载题库失败'); return; }
          if (t.matches('[data-local-open]')) openInDesigner(res.quiz, res.title);
          else downloadJson(res.quiz, 'quiz_' + id + '.json');
        }).catch(function () { t.disabled = false; toast('加载题库失败'); });
      } else if (t.matches('[data-shared-open]') || t.matches('[data-shared-dl]')) {
        var sid = t.dataset.sharedOpen || t.dataset.sharedDl;
        t.disabled = true;
        api('quiz_hub.php?action=shared_quiz&id=' + sid).then(function (res) {
          t.disabled = false;
          if (!res || !res.success) { toast((res && res.message) || '加载题库失败'); return; }
          if (t.matches('[data-shared-open]')) openInDesigner(res.quiz, res.title);
          else downloadJson(res.quiz, 'quiz_shared_' + sid + '.json');
          var item = state.sharedItems.find(function (x) { return String(x.id) === String(sid); });
          if (item) { item.downloads++; paintShared(); }
        }).catch(function () { t.disabled = false; toast('加载题库失败'); });
      } else if (t.matches('[data-shared-del]')) {
        var did = t.dataset.sharedDel;
        if (!confirm('确定删除这份共享题库？删除后不可恢复。')) return;
        t.disabled = true;
        fetch('../api/quiz_hub.php?action=shared_delete', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: Number(did) })
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (!res || !res.success) { t.disabled = false; toast((res && res.message) || '删除失败'); return; }
          toast('已删除');
          renderShared();
        }).catch(function () { t.disabled = false; toast('删除失败：网络错误'); });
      } else if (t.matches('[data-mako-import]')) {
        var btn = t; btn.disabled = true;
        convertMako(btn.dataset.makoImport, btn.dataset.makoTitle, function (quiz, title) {
          btn.disabled = false;
          openInDesigner(quiz, title);
        });
      } else if (t.matches('[data-mako-dl]')) {
        var btn2 = t; btn2.disabled = true;
        convertMako(btn2.dataset.makoDl, btn2.dataset.makoTitle, function (quiz, title) {
          btn2.disabled = false;
          downloadJson(quiz, 'quiz_mako_' + Date.now() + '.json');
        });
      }
    });
  }

  bind();
  checkLogin();
  renderLocal();
})();
