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
    return api('auth.php?action=me').then(function (res) {
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
            '<span class="tag">' + esc(DIFF_LABEL[p.participant_difficulty] || '普通') + '</span>' +
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
      var html = '<div class="panel">' +
        '<span class="club" style="color:var(--blue);font-weight:700">' + esc(p.club_name) + '</span>' +
        '<h2>' + esc(p.title) + '</h2>' +
        '<div class="row">' +
          '<span class="tag tag-blue">' + esc(TYPE_LABEL[p.type] || p.type) + '</span>' +
          '<span class="tag">参与者难度：' + esc(DIFF_LABEL[p.participant_difficulty] || '普通') + '</span>' +
          '<span class="tag tag-gold">构建层级：' + esc(p.tier === 'standard' ? '标准' : p.tier === 'advanced' ? '进阶' : '专家') + '</span>' +
          '<span class="tag">' + esc(STATUS_LABEL[p.status] || p.status) + ' ' + esc(v ? v.version_no : '') + '</span>' +
        '</div>' +
        (p.intro ? '<p>' + esc(p.intro) + '</p>' : '') +
        '<p class="muted">' +
          (quizCount ? quizCount + ' 道题目 · ' : '') +
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
      if (subBtn) subBtn.addEventListener('click', function () {
        var text = $('#submit-work-text').value.trim();
        if (!text) { toast('请填写内容'); return; }
        subBtn.disabled = true;
        api('recognition_participate.php?action=submit_work', { body: { program_version_id: v.id, content: text } })
          .then(function (r) {
            toast(r.message || (r.success ? '已提交，等待审核' : '提交失败'));
            subBtn.disabled = false;
          }).catch(function () { subBtn.disabled = false; toast('网络错误'); });
      });

      body.querySelectorAll('[data-admin-status]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          api('recognition_programs.php?action=set_status', { body: { program_id: p.id, status: btn.dataset.adminStatus } })
            .then(function (r) { toast(r.success ? '状态已更新' : r.message); renderDetail(programId); });
        });
      });
    }).catch(function () { body.innerHTML = '<p class="empty">加载失败</p>'; });
  }

  function renderRedeemBox(p) {
    var checkinUrl = location.origin + location.pathname + '#/program/' + p.id;
    return '<h3>兑换码 / 二维码签到</h3>' +
      '<div class="row">' +
        '<input id="redeem-code" placeholder="输入现场获得的兑换码" style="flex:1;min-width:180px;border:1px solid var(--line);border-radius:8px;padding:9px 10px">' +
        '<button class="btn" id="redeem-btn">兑换</button>' +
      '</div>' +
      '<p class="muted">同好会可将下方签到入口制作成二维码在现场展示；参与者扫码打开本页后输入兑换码即可。</p>' +
      '<div class="row">' +
        '<input id="checkin-url" readonly value="' + esc(checkinUrl) + '" style="flex:1;min-width:180px;border:1px dashed var(--line);border-radius:8px;padding:8px 10px;font-size:12px;background:#fff">' +
        '<button class="btn btn-ghost" id="copy-checkin">复制签到入口</button>' +
      '</div>';
  }

  function renderSubmissionBox(v) {
    return '<h3>提交作品</h3>' +
      '<div class="field"><textarea id="submit-work-text" rows="4" placeholder="粘贴作品链接或填写说明（文件上传将在后续版本支持）"></textarea></div>' +
      '<button class="btn" id="submit-work-btn">提交，等待同好会审核</button>';
  }

  // ---------- 答题 ----------
  var quizSession = null;
  function startQuiz(program, version) {
    api('recognition_participate.php?action=start', { body: { program_id: program.id } }).then(function (res) {
      if (!res || !res.success) { toast(res && res.message || '无法开始'); return; }
      quizSession = { attemptId: res.attempt_id, paper: res.questions, program: program };
      showView('quiz');
      var body = $('#quiz-body');
      body.innerHTML = '<div class="panel"><h2>' + esc(program.title) + '</h2>' +
        '<p class="muted">共 ' + res.questions.length + ' 题，提交后自动判分。</p>' +
        res.questions.map(function (q) { return renderQuestion(q); }).join('') +
        '<button class="btn btn-primary" id="quiz-submit" style="margin-top:16px">提交答卷</button>' +
        '<div id="quiz-result"></div></div>';
      $('#quiz-submit').addEventListener('click', submitQuiz);
    });
  }

  function renderQuestion(q) {
    var inputType = q.type === 'multiple' ? 'checkbox' : 'radio';
    var options = (q.options || []).map(function (opt, i) {
      return '<label class="quiz-option"><input type="' + inputType + '" name="q' + q.seq + '" value="' + i + '"> ' + esc(opt) + '</label>';
    }).join('');
    if (q.type === 'fill_blank') {
      options = '<input type="text" class="fill-input" data-seq="' + q.seq + '" placeholder="填写答案" style="border:1px solid var(--line);border-radius:8px;padding:8px;width:100%">';
    }
    return '<div class="quiz-question" data-seq="' + q.seq + '" data-type="' + q.type + '" data-orig="' + q.orig + '">' +
      '<div class="q-title">' + (q.seq + 1) + '. ' + esc(q.question) + ' <span class="muted">(' + q.points + ' 分)</span></div>' +
      options + '</div>';
  }

  function submitQuiz() {
    if (!quizSession) return;
    var answers = {}, paper = [];
    $('#quiz-body').querySelectorAll('.quiz-question').forEach(function (el) {
      var seq = el.dataset.seq, type = el.dataset.type, orig = parseInt(el.dataset.orig, 10);
      paper.push({ seq: seq, orig: orig });
      if (type === 'fill_blank') {
        answers[seq] = el.querySelector('.fill-input').value;
      } else if (type === 'multiple') {
        answers[seq] = Array.prototype.map.call(el.querySelectorAll('input:checked'), function (i) { return parseInt(i.value, 10); });
      } else {
        var checked = el.querySelector('input:checked');
        answers[seq] = checked ? parseInt(checked.value, 10) : null;
      }
    });
    var btn = $('#quiz-submit');
    btn.disabled = true;
    api('recognition_participate.php?action=submit', {
      body: { attempt_id: quizSession.attemptId, answers: answers, paper: paper }
    }).then(function (res) {
      var box = $('#quiz-result');
      if (!res || !res.success) { box.innerHTML = '<div class="result-banner result-fail">' + esc(res && res.message || '提交失败') + '</div>'; btn.disabled = false; return; }
      var html = '<div class="result-banner ' + (res.passed ? 'result-pass' : 'result-fail') + '">' +
        '得分：' + res.score + ' 分 —— ' + esc(res.message);
      if (res.credential && res.credential.credential_uid) {
        html += '<br><a href="../verify.html?uid=' + encodeURIComponent(res.credential.credential_uid) + '">查看我的凭证</a> · ' +
          '<a href="../user.html?tab=achievements">前往我的成就</a>';
      }
      html += '</div>';
      box.innerHTML = html;
      btn.textContent = '已完成本次作答';
    }).catch(function () { btn.disabled = false; toast('网络错误'); });
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
