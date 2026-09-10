/* exam/exam.js - 同好会考核前端（列表 / 详情 / 答题 / 兑换） */
(function () {
  'use strict';

  var API = '../api/';
  var URLP = new URLSearchParams(location.search);
  var state = {
    user: null,
    typeFilter: '',
    clubFilter: {
      club_id: parseInt(URLP.get('club_id'), 10) || 0,
      country: URLP.get('country') || ''
    }
  };

  var TYPE_LABEL = {
    assessment: '知识考核', activity: '活动签到', mission: '连续任务',
    submission: '作品提交', competition: '竞赛评选', award: '人工授予', external: '外部联动'
  };
  var DIFF_LABEL = { easy: '简单', normal: '普通', hard: '困难', extreme: '极难' };
  // 只有答题/任务类有客观难度；活动、作品、竞赛（评审）、授予类不展示难度
  var DIFF_VISIBLE = { assessment: 1, mission: 1 };
  var STATUS_LABEL = { draft: '草稿', published: '进行中', paused: '已暂停', archived: '已归档' };
  var VERIFY_LABEL = {
    auto: '自动验证', single_review: '单人审核', multi_review: '多人审核',
    owner_grant: '负责人签发', external_system: '外部系统证明', joint_issue: '联名签发', platform: '平台合作验证'
  };

  // ---------- 工具 ----------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.hidden = true; }, 3200);
  }
  function api(path, opts) {
    opts = opts || {};
    return fetch(API + path, {
      method: opts.body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) { return r.json(); });
  }
  function showView(name) {
    ['list', 'detail', 'quiz'].forEach(function (v) {
      $('#view-' + v).hidden = v !== name;
    });
    window.scrollTo(0, 0);
  }

  // ---------- 登录态 ----------
  function loadLoginState() {
    // 本地回归专用：静态页不经过 auto_prepend，需把 _recog_autologin 透传给首个 API 建立会话（生产环境无此参数）
    var autologin = URLP.get('_recog_autologin');
    var qs = 'auth.php?action=me' + (autologin ? '&_recog_autologin=' + encodeURIComponent(autologin) : '');
    return api(qs).then(function (res) {
      state.user = (res && res.logged_in && res.user) ? res.user : null;
      var box = $('#login-state');
      if (state.user) {
        box.innerHTML = '<span class="muted">欢迎，' + esc(state.user.nickname || state.user.username) + '</span> ' +
          '<a class="btn" href="../user.html?tab=achievements">我的成就</a>';
        $('#manage-entry').hidden = false;
      }
    }).catch(function () { state.user = null; });
  }

  // ---------- 考核广场 ----------
  function renderFilterNote() {
    var note = $('#club-filter-note');
    if (!note) return;
    if (state.clubFilter.club_id > 0) {
      note.hidden = false;
      note.innerHTML = '当前只显示该同好会的考核 <button class="btn btn-ghost" id="clear-club-filter" style="padding:2px 10px;font-size:12px">查看全部</button>';
      var btn = $('#clear-club-filter');
      if (btn) btn.addEventListener('click', function () {
        state.clubFilter = { club_id: 0, country: '' };
        var u = new URL(location.href);
        u.searchParams.delete('club_id');
        u.searchParams.delete('country');
        history.replaceState(null, '', u.pathname + u.search + u.hash);
        renderFilterNote();
        renderList();
      });
    } else {
      note.hidden = true;
      note.innerHTML = '';
    }
  }

  function renderList() {
    showView('list');
    renderFilterNote();
    var list = $('#program-list');
    list.innerHTML = '<p class="empty">加载中…</p>';
    var qs = 'recognition_programs.php?action=list' + (state.typeFilter ? '&type=' + state.typeFilter : '');
    if (state.clubFilter.club_id > 0) {
      qs += '&club_id=' + state.clubFilter.club_id;
      if (state.clubFilter.country) qs += '&country=' + encodeURIComponent(state.clubFilter.country);
    }
    api(qs).then(function (res) {
      var programs = (res && res.programs) || [];
      if (!programs.length) {
        list.innerHTML = '<p class="empty">' + (state.clubFilter.club_id > 0
          ? '该同好会还没有已发布的考核。'
          : '还没有已发布的考核。同好会负责人可在管理面板创建。') + '</p>';
        return;
      }
      list.innerHTML = programs.map(function (p) {
        return '<article class="card">' +
          '<span class="club">' + esc(p.club_name) + '</span>' +
          '<h3><a href="#/program/' + p.id + '">' + esc(p.title) + '</a></h3>' +
          '<p class="intro">' + esc(p.intro || '') + '</p>' +
          '<div class="meta">' +
            '<span class="tag tag-blue">' + esc(TYPE_LABEL[p.type] || p.type) + '</span>' +
            (DIFF_VISIBLE[p.type] ? '<span class="tag">' + esc(DIFF_LABEL[p.participant_difficulty] || '普通') + '</span>' : '') +
            '<span class="tag tag-gold">已签发 ' + p.issued_count + '</span>' +
          '</div>' +
          '<a class="btn btn-primary btn-block" href="#/program/' + p.id + '">查看考核</a>' +
        '</article>';
      }).join('');
    }).catch(function () { list.innerHTML = '<p class="empty">加载失败，请刷新重试。</p>'; });
  }

  // ---------- 考核详情 ----------
  function renderDetail(programId) {
    showView('detail');
    var body = $('#detail-body');
    body.innerHTML = '<p class="empty">加载中…</p>';
    api('recognition_programs.php?action=detail&id=' + programId).then(function (res) {
      if (!res || !res.success) { body.innerHTML = '<p class="empty">' + esc(res && res.message || '考核不存在') + '</p>'; return; }
      var p = res.program, v = res.version, content = (v && v.content) || {};
      var quizCount = ((content.quiz || {}).questions || []).length;
      var quizSettings = (content.quiz || {}).settings || {};
      var timeLimit = parseInt(quizSettings.time_limit, 10) || 0;
      var html = '<div class="panel">' +
        '<span class="club" style="color:var(--blue);font-weight:700">' + esc(p.club_name) + '</span>' +
        '<h2>' + esc(p.title) + '</h2>' +
        '<div class="row">' +
          '<span class="tag tag-blue">' + esc(TYPE_LABEL[p.type] || p.type) + '</span>' +
          (DIFF_VISIBLE[p.type] ? '<span class="tag">参与者难度：' + esc(DIFF_LABEL[p.participant_difficulty] || '普通') + '</span>' : '') +
          '<span class="tag tag-gold">构建层级：' + esc(p.tier === 'standard' ? '标准' : p.tier === 'advanced' ? '进阶' : '专家') + '</span>' +
          '<span class="tag">' + esc(STATUS_LABEL[p.status] || p.status) + ' ' + esc(v ? v.version_no : '') + '</span>' +
        '</div>' +
        (p.intro ? '<p>' + esc(p.intro) + '</p>' : '') +
        '<p class="muted">' +
          (quizCount ? quizCount + ' 道题目 · ' : '') +
          (timeLimit > 0 ? '限时 ' + timeLimit + ' 分钟 · ' : '') +
          (p.max_attempts > 0 ? '最多尝试 ' + p.max_attempts + ' 次 · ' : '不限尝试次数 · ') +
          (p.cooldown_minutes > 0 ? '冷却 ' + p.cooldown_minutes + ' 分钟 · ' : '') +
          (p.open_at ? p.open_at + ' 开放 · ' : '') +
          (p.close_at ? p.close_at + ' 截止' : '长期开放') +
        '</p>';

      if (!state.user) {
        html += '<a class="btn btn-primary" href="../login.html">登录后参与</a>';
      } else if (res.my_credential_uid) {
        html += '<div class="result-banner result-pass">你已获得该考核的徽章 ' +
          '<a href="../verify.html?uid=' + encodeURIComponent(res.my_credential_uid) + '">查看凭证</a></div>';
      } else if (p.status === 'published') {
        if (quizCount) {
          html += '<button class="btn btn-primary" id="start-quiz">开始答题（已尝试 ' + (res.my_attempts || 0) + ' 次）</button>';
        }
        html += renderRedeemBox(p);
        if (p.type === 'submission' && v) {
          html += renderSubmissionBox(v);
        }
      }

      if (p.is_manager) {
        html += '<hr style="border:none;border-top:1px dashed var(--line);margin:18px 0">' +
          '<div class="row">' +
            '<span class="muted">管理者操作：</span>' +
            (p.status === 'published'
              ? '<button class="btn" data-admin-status="paused">暂停</button>'
              : '<button class="btn" data-admin-status="published">恢复</button>') +
            '<button class="btn" data-admin-status="archived">归档</button>' +
          '</div>';
      }
      html += '</div>';
      body.innerHTML = html;

      var startBtn = $('#start-quiz');
      if (startBtn) startBtn.addEventListener('click', function () { startQuiz(p, v); });

      var redeemBtn = $('#redeem-btn');
      var copyBtn = $('#copy-checkin');
      var qrCanvas = $('#checkin-qr');
      if (qrCanvas) drawQr(qrCanvas, ($('#checkin-url') || {}).value || (location.origin + location.pathname + '#/program/' + programId), 150);
      if (copyBtn) copyBtn.addEventListener('click', function () {
        var input = $('#checkin-url');
        input.select();
        try { navigator.clipboard.writeText(input.value); toast('签到入口已复制，可制作成二维码'); }
        catch (e) { document.execCommand('copy'); toast('签到入口已复制'); }
      });
      if (redeemBtn) redeemBtn.addEventListener('click', function () {
        var code = $('#redeem-code').value.trim();
        if (!code) { toast('请输入兑换码'); return; }
        redeemBtn.disabled = true;
        api('recognition_participate.php?action=redeem', { body: { code: code } }).then(function (r) {
          toast(r.message || (r.success ? '兑换成功' : '兑换失败'));
          if (r.success) renderDetail(programId);
          else redeemBtn.disabled = false;
        }).catch(function () { redeemBtn.disabled = false; toast('网络错误'); });
      });

      var subBtn = $('#submit-work-btn');
      if (subBtn) {
        subImages = []; // 详情重渲染时清空未提交的图片选择
        bindSubmissionBox(v.id, subBtn);
      }

      body.querySelectorAll('[data-admin-status]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          api('recognition_programs.php?action=set_status', { body: { program_id: p.id, status: btn.dataset.adminStatus } })
            .then(function (r) { toast(r.success ? '状态已更新' : r.message); renderDetail(programId); });
        });
      });
    }).catch(function () { body.innerHTML = '<p class="empty">加载失败</p>'; });
  }

  // 画二维码到 canvas（依赖 ../js/vendor/qrcode.min.js 提供的全局 qrcode）
  function drawQr(canvas, text, sizePx) {
    if (typeof window.qrcode !== 'function') { canvas.hidden = true; return; }
    try {
      var qr = window.qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      var n = qr.getModuleCount(), margin = 2;
      var cell = Math.max(2, Math.floor(sizePx / (n + margin * 2)));
      var real = (n + margin * 2) * cell;
      canvas.width = real;
      canvas.height = real;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, real, real);
      ctx.fillStyle = '#111';
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          if (qr.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
        }
      }
    } catch (e) { canvas.hidden = true; }
  }

  function renderRedeemBox(p) {
    var checkinUrl = location.origin + location.pathname + '#/program/' + p.id;
    return '<h3>兑换码 / 二维码签到</h3>' +
      '<div class="row">' +
        '<input id="redeem-code" class="inline-input" placeholder="输入现场获得的兑换码" style="flex:1;min-width:180px">' +
        '<button class="btn" id="redeem-btn">兑换</button>' +
      '</div>' +
      '<p class="muted">同好会现场展示下方二维码（或复制链接自制二维码），参与者扫码打开本页后输入兑换码即可。</p>' +
      '<div class="row" style="align-items:flex-start">' +
        '<div style="flex:1;min-width:180px">' +
          '<input id="checkin-url" class="inline-input" readonly value="' + esc(checkinUrl) + '" style="width:100%">' +
          '<button class="btn btn-ghost" id="copy-checkin" style="margin-top:6px">复制签到入口</button>' +
        '</div>' +
        '<div class="qr-inline"><canvas id="checkin-qr" aria-label="签到入口二维码"></canvas><span>现场投屏扫码签到</span></div>' +
      '</div>';
  }

  // ---------- 作品提交（文本 + 图片，图片选后即压缩上传，最多 4 张） ----------
  var SUB_MAX_IMAGES = 4;
  var subImages = []; // { status: 'uploading'|'done', url }，url 为站点根相对路径

  function renderSubmissionBox(v) {
    return '<h3>提交作品</h3>' +
      '<div class="field"><textarea id="submit-work-text" rows="4" placeholder="粘贴作品链接或填写说明（可附最多 4 张图片，上传时自动压缩）"></textarea></div>' +
      '<div class="field">' +
        '<div class="row">' +
          '<button class="btn btn-ghost" id="sub-img-btn" type="button">＋ 添加图片（≤' + SUB_MAX_IMAGES + ' 张）</button>' +
          '<input type="file" id="sub-img-input" accept="image/jpeg,image/png,image/gif,image/webp" multiple hidden>' +
          '<span class="muted" style="font-size:12px">支持 JPG/PNG/WebP/GIF，自动压缩到 1600px</span>' +
        '</div>' +
        '<div id="sub-img-list" class="sub-img-list"></div>' +
      '</div>' +
      '<button class="btn" id="submit-work-btn">提交，等待同好会审核</button>';
  }

  function renderSubImages() {
    var box = $('#sub-img-list');
    if (!box) return;
    box.innerHTML = subImages.map(function (item, i) {
      var inner = item.url
        ? '<img src="' + esc('../' + item.url) + '" alt="作品图片">'
        : '<span class="sub-img-loading">上传中…</span>';
      return '<div class="sub-img-item">' + inner +
        '<button type="button" class="sub-img-del" data-i="' + i + '" title="移除">×</button></div>';
    }).join('');
    box.querySelectorAll('.sub-img-del').forEach(function (btn) {
      btn.addEventListener('click', function () {
        subImages.splice(parseInt(btn.dataset.i, 10), 1);
        renderSubImages();
      });
    });
  }

  // 客户端压缩：JPEG/PNG/WebP 缩到最长边 1600px 转 JPEG；GIF 不压缩（超 5MB 拒收）
  function compressImageFile(file) {
    return new Promise(function (resolve, reject) {
      if (file.type === 'image/gif') {
        if (file.size > 5 * 1024 * 1024) { reject(new Error('GIF 图片请小于 5MB')); return; }
        resolve(file);
        return;
      }
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error('读取图片失败')); };
      fr.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('图片解析失败')); };
        img.onload = function () {
          var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff'; // PNG 透明区铺白底，避免转 JPEG 后变黑
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (blob) {
            if (blob) resolve(blob); else reject(new Error('图片压缩失败'));
          }, 'image/jpeg', 0.85);
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  function handleSubImageFiles(files) {
    Array.prototype.forEach.call(files || [], function (file) {
      if (subImages.length >= SUB_MAX_IMAGES) { toast('最多上传 ' + SUB_MAX_IMAGES + ' 张图片'); return; }
      if (!/^image\//.test(file.type || '')) { toast('仅支持图片文件'); return; }
      var item = { status: 'uploading', url: '' };
      subImages.push(item);
      renderSubImages();
      compressImageFile(file).then(function (blob) {
        var fd = new FormData();
        fd.append('image', blob, 'image.jpg');
        return fetch('../api/submission_image.php?action=upload', { method: 'POST', body: fd, credentials: 'same-origin' })
          .then(function (r) { return r.json(); });
      }).then(function (res) {
        if (res && res.success) {
          item.status = 'done';
          item.url = res.image_url;
        } else {
          toast((res && res.message) || '图片上传失败');
          subImages.splice(subImages.indexOf(item), 1);
        }
        renderSubImages();
      }).catch(function (err) {
        toast((err && err.message) || '图片上传失败');
        var idx = subImages.indexOf(item);
        if (idx >= 0) subImages.splice(idx, 1);
        renderSubImages();
      });
    });
  }

  function bindSubmissionBox(versionId, btn) {
    var imgBtn = $('#sub-img-btn');
    var imgInput = $('#sub-img-input');
    if (imgBtn && imgInput) {
      imgBtn.addEventListener('click', function () { imgInput.click(); });
      imgInput.addEventListener('change', function () {
        handleSubImageFiles(this.files);
        this.value = '';
      });
    }
    btn.addEventListener('click', function () {
      var text = $('#submit-work-text').value.trim();
      if (subImages.some(function (it) { return !it.url; })) { toast('有图片还在上传中，请稍候'); return; }
      if (!text && !subImages.length) { toast('请填写内容或上传图片'); return; }
      btn.disabled = true;
      api('recognition_participate.php?action=submit_work', {
        body: {
          program_version_id: versionId,
          content: text,
          images: subImages.map(function (it) { return it.url; })
        }
      }).then(function (r) {
        toast(r.message || (r.success ? '已提交，等待审核' : '提交失败'));
        btn.disabled = false;
        if (r.success) {
          subImages = [];
          $('#submit-work-text').value = '';
          renderSubImages();
        }
      }).catch(function () { btn.disabled = false; toast('网络错误'); });
    });
  }

  // ---------- 答题（考试引擎：乱序/抽题/限时/暂存续答/成绩展示模式） ----------
  var quizSession = null;

  function startQuiz(program, version) {
    api('recognition_participate.php?action=start', { body: { program_id: program.id } }).then(function (res) {
      if (!res || !res.success) { toast(res && res.message || '无法开始'); return; }
      quizSession = {
        attemptId: res.attempt_id,
        paper: res.questions,
        program: program,
        settings: res.settings || {},
        deadline: res.deadline || 0,
        submitted: false,
        timer: null
      };
      showView('quiz');
      var body = $('#quiz-body');
      var fullScore = 0;
      res.questions.forEach(function (q) { fullScore += q.points || 0; });
      var meta = ['共 ' + res.questions.length + ' 题', '满分 ' + fullScore + ' 分'];
      if (quizSession.settings.time_limit > 0) meta.push('限时 ' + quizSession.settings.time_limit + ' 分钟');
      body.innerHTML = '<div class="panel"><h2>' + esc(program.title) + '</h2>' +
        '<p class="muted">' + esc(meta.join(' · ')) + '，' +
        (res.resumed ? '已恢复上次作答进度，交卷后自动判分。' : '提交后自动判分。') + '</p>' +
        '<div class="row" style="justify-content:space-between;align-items:center;margin-bottom:10px">' +
          '<span class="muted" id="quiz-progress"></span>' +
          '<span class="muted" id="quiz-countdown" style="font-variant-numeric:tabular-nums"' + (quizSession.deadline ? '' : ' hidden') + '></span>' +
        '</div>' +
        res.questions.map(function (q) { return renderQuestion(q); }).join('') +
        '<button class="btn btn-primary" id="quiz-submit" style="margin-top:16px">提交答卷</button>' +
        '<div id="quiz-result"></div></div>';
      $('#quiz-submit').addEventListener('click', submitQuiz);
      if (res.saved_answers && Object.keys(res.saved_answers).length) restoreAnswers(res.saved_answers);
      bindQuizInputs();
      updateProgress();
      startCountdown();
    });
  }

  function renderQuestion(q) {
    var inputType = q.type === 'multiple' ? 'checkbox' : 'radio';
    // 题干图（可选）
    var stemImg = q.image ? '<div class="q-image"><img src="' + esc(q.image) + '" alt="题目图片" loading="lazy"></div>' : '';
    // 选项图（可选，按原始索引取）
    function optImg(opt) {
      var url = q.option_images ? q.option_images[opt.oi] : '';
      return url ? '<img class="opt-img" src="' + esc(url) + '" alt="" loading="lazy">' : '';
    }
    var options;
    if (q.type === 'fill_blank') {
      options = '<input type="text" class="fill-input" data-seq="' + q.seq + '" placeholder="填写答案" style="width:100%">';
    } else if (q.type === 'fill_multi') {
      // 多空填空：空位数随试卷下发，逐空作答（顺序即空位）
      var blanks = parseInt(q.blanks, 10) || 1;
      options = '';
      for (var b = 0; b < blanks; b++) {
        options += '<div class="fill-row"><span class="muted">第 ' + (b + 1) + ' 空</span>' +
          '<input type="text" class="fill-input" data-seq="' + q.seq + '" data-blank="' + b + '" placeholder="填写答案" style="flex:1"></div>';
      }
    } else if (q.type === 'order') {
      // 排序题：拖动（或 ↑↓ 按钮）调整选项顺序，提交按当前排列的原始索引序列判分（服务端已打乱呈现）
      options = (q.options || []).map(function (opt, idx) {
        return '<div class="order-row" draggable="true" data-oi="' + opt.oi + '">' +
          '<span class="order-drag" title="拖动排序">⋮⋮</span>' +
          '<button type="button" class="order-move" data-dir="-1" title="上移">↑</button>' +
          '<button type="button" class="order-move" data-dir="1" title="下移">↓</button>' +
          '<span class="order-no">' + (idx + 1) + '</span>' + optImg(opt) + '<span>' + esc(opt.text) + '</span></div>';
      }).join('') + '<div class="muted" style="font-size:12px;margin-top:4px">拖动选项排出正确顺序（触屏也可用 ↑↓ 按钮）</div>';
    } else {
      options = (q.options || []).map(function (opt) {
        return '<label class="quiz-option"><input type="' + inputType + '" name="q' + q.seq + '" value="' + opt.oi + '">' + optImg(opt) + ' ' + esc(opt.text) + '</label>';
      }).join('');
    }
    return '<div class="quiz-question" data-seq="' + q.seq + '" data-type="' + q.type + '" data-orig="' + q.orig + '">' +
      '<div class="q-title">' + (q.seq + 1) + '. ' + esc(q.question) + ' <span class="muted">(' + q.points + ' 分)</span></div>' +
      stemImg + options + '</div>';
  }

  // 收集当前作答（暂存与提交共用）
  function collectAnswers() {
    var answers = {}, paper = [];
    $('#quiz-body').querySelectorAll('.quiz-question').forEach(function (el) {
      var seq = el.dataset.seq, type = el.dataset.type, orig = parseInt(el.dataset.orig, 10);
      paper.push({ seq: seq, orig: orig });
      if (type === 'fill_blank') {
        answers[seq] = el.querySelector('.fill-input').value;
      } else if (type === 'fill_multi') {
        answers[seq] = Array.prototype.map.call(el.querySelectorAll('.fill-input'), function (i) { return i.value; });
      } else if (type === 'order') {
        answers[seq] = Array.prototype.map.call(el.querySelectorAll('.order-row'), function (r) { return parseInt(r.dataset.oi, 10); });
      } else if (type === 'multiple') {
        answers[seq] = Array.prototype.map.call(el.querySelectorAll('input:checked'), function (i) { return parseInt(i.value, 10); });
      } else {
        var checked = el.querySelector('input:checked');
        answers[seq] = checked ? parseInt(checked.value, 10) : null;
      }
    });
    return { answers: answers, paper: paper };
  }

  // 还原暂存答案（续答）
  function restoreAnswers(saved) {
    $('#quiz-body').querySelectorAll('.quiz-question').forEach(function (el) {
      var seq = el.dataset.seq, type = el.dataset.type, val = saved[seq];
      if (val === undefined || val === null) return;
      if (type === 'fill_blank') {
        el.querySelector('.fill-input').value = String(val);
      } else if (type === 'fill_multi') {
        var arr = Array.isArray(val) ? val : [];
        el.querySelectorAll('.fill-input').forEach(function (i) {
          i.value = String(arr[parseInt(i.dataset.blank, 10)] || '');
        });
      } else if (type === 'order') {
        // 按暂存排列重排选项行（仅当索引集合完全一致时还原，避免脏数据错位）
        var arr2 = Array.isArray(val) ? val.map(function (v) { return parseInt(v, 10); }) : [];
        var rows = Array.prototype.slice.call(el.querySelectorAll('.order-row'));
        var ois = rows.map(function (r) { return parseInt(r.dataset.oi, 10); });
        if (arr2.length === ois.length && arr2.slice().sort().join(',') === ois.slice().sort().join(',')) {
          arr2.forEach(function (oi) {
            var row = rows.find(function (r) { return parseInt(r.dataset.oi, 10) === oi; });
            if (row) el.appendChild(row);
          });
          el.querySelectorAll('.order-row').forEach(function (r, i) { r.querySelector('.order-no').textContent = i + 1; });
          el.dataset.touched = '1';
        }
      } else if (type === 'multiple') {
        var arr3 = Array.isArray(val) ? val : [];
        el.querySelectorAll('input').forEach(function (i) { i.checked = arr3.indexOf(parseInt(i.value, 10)) >= 0; });
      } else {
        el.querySelectorAll('input').forEach(function (i) { i.checked = parseInt(i.value, 10) === val; });
      }
    });
  }

  // 作答变化：更新进度 + 防抖自动暂存（失败静默，不影响交卷）
  function bindQuizInputs() {
    var body = $('#quiz-body');
    var debounce = null;
    function onChange() {
      updateProgress();
      clearTimeout(debounce);
      debounce = setTimeout(tempSave, 1500);
    }
    body.addEventListener('input', onChange);
    body.addEventListener('change', onChange);
    // 排序题：↑↓ 按钮交换相邻选项行，并重编号；调整过即视为已作答（用于进度统计）
    body.addEventListener('click', function (e) {
      var btn = e.target.closest('.order-move');
      if (!btn) return;
      e.preventDefault();
      var row = btn.closest('.order-row'), container = row.parentElement;
      var dir = parseInt(btn.dataset.dir, 10);
      var sibling = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
      if (!sibling || !sibling.classList || !sibling.classList.contains('order-row')) return;
      if (dir < 0) container.insertBefore(row, sibling);
      else container.insertBefore(sibling, row);
      container.querySelectorAll('.order-row').forEach(function (r, i) { r.querySelector('.order-no').textContent = i + 1; });
      container.closest('.quiz-question').dataset.touched = '1';
      onChange();
    });
    // 排序题：拖拽调整顺序（HTML5 DnD，桌面端直接拖行即可）
    var dragRow = null;
    function clearOrderHints() {
      body.querySelectorAll('.order-drop-top,.order-drop-bottom').forEach(function (el) {
        el.classList.remove('order-drop-top', 'order-drop-bottom');
      });
    }
    body.addEventListener('dragstart', function (e) {
      var row = e.target.closest('.order-row');
      if (!row) return;
      dragRow = row;
      row.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', row.dataset.oi || ''); } catch (err) {}
      e.dataTransfer.effectAllowed = 'move';
    });
    body.addEventListener('dragend', function () {
      if (dragRow) { dragRow.classList.remove('dragging'); dragRow = null; }
      clearOrderHints();
    });
    body.addEventListener('dragover', function (e) {
      if (!dragRow) return;
      var row = e.target.closest('.order-row');
      if (!row || row === dragRow) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var rect = row.getBoundingClientRect();
      clearOrderHints();
      row.classList.add(e.clientY < rect.top + rect.height / 2 ? 'order-drop-top' : 'order-drop-bottom');
    });
    body.addEventListener('drop', function (e) {
      if (!dragRow) return;
      e.preventDefault();
      var row = e.target.closest('.order-row');
      if (row && row !== dragRow && row.parentElement === dragRow.parentElement) {
        var container = row.parentElement;
        var rect = row.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) container.insertBefore(dragRow, row);
        else container.insertBefore(dragRow, row.nextElementSibling);
        container.querySelectorAll('.order-row').forEach(function (r, i) { r.querySelector('.order-no').textContent = i + 1; });
        container.closest('.quiz-question').dataset.touched = '1';
        onChange();
      }
      if (dragRow) { dragRow.classList.remove('dragging'); dragRow = null; }
      clearOrderHints();
    });
  }

  function updateProgress() {
    var total = 0, done = 0;
    $('#quiz-body').querySelectorAll('.quiz-question').forEach(function (el) {
      total++;
      var type = el.dataset.type, answered;
      if (type === 'fill_blank') {
        answered = el.querySelector('.fill-input').value.trim() !== '';
      } else if (type === 'fill_multi') {
        var inputs = el.querySelectorAll('.fill-input');
        answered = inputs.length > 0;
        inputs.forEach(function (i) { if (i.value.trim() === '') answered = false; });
      } else if (type === 'order') {
        answered = !!el.dataset.touched; // 调整过顺序才算作答，避免默认排列被误计为已答
      } else {
        answered = !!el.querySelector('input:checked');
      }
      if (answered) done++;
    });
    var el = $('#quiz-progress');
    if (el) el.textContent = '已答 ' + done + ' / ' + total + ' · 作答自动保存';
  }

  function tempSave() {
    if (!quizSession || quizSession.submitted) return;
    var data = collectAnswers();
    api('recognition_participate.php?action=temp_save', {
      body: { attempt_id: quizSession.attemptId, answers: data.answers }
    }).catch(function () {});
  }

  // 倒计时（服务端下发截止时间，归零自动交卷）
  function startCountdown() {
    if (!quizSession || !quizSession.deadline) return;
    var el = $('#quiz-countdown');
    function tick() {
      var left = quizSession.deadline * 1000 - Date.now();
      if (left <= 0) {
        el.textContent = '已到时，正在交卷…';
        clearInterval(quizSession.timer);
        if (!quizSession.submitted) submitQuiz();
        return;
      }
      var m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      el.textContent = '剩余 ' + m + ':' + (s < 10 ? '0' : '') + s;
      el.style.color = left < 60000 ? '#c00' : '';
    }
    tick();
    quizSession.timer = setInterval(tick, 1000);
  }

  function submitQuiz() {
    if (!quizSession || quizSession.submitted) return;
    var data = collectAnswers();
    var btn = $('#quiz-submit');
    btn.disabled = true;
    quizSession.submitted = true;
    if (quizSession.timer) clearInterval(quizSession.timer);
    api('recognition_participate.php?action=submit', {
      body: { attempt_id: quizSession.attemptId, answers: data.answers, paper: data.paper }
    }).then(function (res) {
      var box = $('#quiz-result');
      if (!res || !res.success) {
        box.innerHTML = '<div class="result-banner result-fail">' + esc(res && res.message || '提交失败') + '</div>';
        btn.disabled = false;
        quizSession.submitted = false;
        return;
      }
      var mode = res.mode || 'immediate';
      var html = '';
      if (mode === 'hidden') {
        html = '<div class="result-banner result-pass">' + esc(res.message || '已提交') + '</div>';
      } else {
        var head = mode === 'immediate' ? ('得分：' + res.score + ' 分 —— ') : '';
        html = '<div class="result-banner ' + (res.passed ? 'result-pass' : 'result-fail') + '">' + head + esc(res.message);
        if (res.credential && res.credential.credential_uid) {
          html += '<br><a href="../verify.html?uid=' + encodeURIComponent(res.credential.credential_uid) + '">查看我的凭证</a> · ' +
            '<a href="../user.html?tab=achievements">前往我的成就</a>';
        }
        html += '</div>';
        // 逐题解析（立即显示模式）
        if (mode === 'immediate' && res.detail) {
          html += '<div style="margin-top:12px">';
          quizSession.paper.forEach(function (q) {
            var d = res.detail[q.orig];
            if (!d) return;
            html += '<div style="border-top:1px dashed var(--line);padding:8px 0">' +
              '<span style="color:' + (d.correct ? 'var(--success)' : 'var(--danger)') + ';font-weight:700">' + (d.correct ? '✓ 正确' : '✗ 错误') + '</span> ' +
              '<span class="muted">第 ' + (q.seq + 1) + ' 题（' + d.earned + '/' + q.points + ' 分）</span>' +
              (d.explanation ? '<div class="muted" style="margin-top:2px">解析：' + esc(d.explanation) + '</div>' : '') +
              '</div>';
          });
          html += '</div>';
        }
      }
      box.innerHTML = html;
      btn.textContent = '已完成本次作答';
    }).catch(function () { btn.disabled = false; quizSession.submitted = false; toast('网络错误'); });
  }

  // ---------- 路由 ----------
  function route() {
    var hash = location.hash || '#/';
    var m;
    if ((m = hash.match(/^#\/program\/(\d+)/))) renderDetail(parseInt(m[1], 10));
    else renderList();
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('#type-filter').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      this.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('active'); });
      chip.classList.add('active');
      state.typeFilter = chip.dataset.type;
      renderList();
    });
    $('#manage-entry').addEventListener('click', function () { location.href = '../admin/club_manager.html?tab=recognition'; });
    $('#back-to-list').addEventListener('click', function () { location.hash = '#/'; });
    window.addEventListener('hashchange', route);

    loadLoginState().then(route);
  });
})();
