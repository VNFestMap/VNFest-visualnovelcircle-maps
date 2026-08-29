/* trial/trial.js - 同好会试炼前端（列表 / 详情 / 答题 / 兑换 / 管理） */
(function () {
  'use strict';

  var API = '../api/';
  var state = { user: null, typeFilter: '' };

  var TYPE_LABEL = {
    assessment: '知识试炼', activity: '活动签到', mission: '连续任务',
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
    ['list', 'detail', 'quiz', 'manage'].forEach(function (v) {
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
          '<a class="btn" href="../achievements.html">我的认可图鉴</a>';
        $('#manage-entry').hidden = false;
      }
    }).catch(function () { state.user = null; });
  }

  // ---------- 试炼广场 ----------
  function renderList() {
    showView('list');
    var list = $('#program-list');
    list.innerHTML = '<p class="empty">加载中…</p>';
    var qs = 'recognition_programs.php?action=list' + (state.typeFilter ? '&type=' + state.typeFilter : '');
    api(qs).then(function (res) {
      var programs = (res && res.programs) || [];
      if (!programs.length) {
        list.innerHTML = '<p class="empty">还没有已发布的试炼。同好会负责人可在管理面板创建。</p>';
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
          '<a class="btn btn-primary btn-block" href="#/program/' + p.id + '">查看试炼</a>' +
        '</article>';
      }).join('');
    }).catch(function () { list.innerHTML = '<p class="empty">加载失败，请刷新重试。</p>'; });
  }

  // ---------- 试炼详情 ----------
  function renderDetail(programId) {
    showView('detail');
    var body = $('#detail-body');
    body.innerHTML = '<p class="empty">加载中…</p>';
    api('recognition_programs.php?action=detail&id=' + programId).then(function (res) {
      if (!res || !res.success) { body.innerHTML = '<p class="empty">' + esc(res && res.message || '试炼不存在') + '</p>'; return; }
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
        html += '<div class="result-banner result-pass">你已获得该试炼的徽章 ' +
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
          '<a href="../achievements.html">前往认可图鉴</a>';
      }
      html += '</div>';
      box.innerHTML = html;
      btn.textContent = '已完成本次作答';
    }).catch(function () { btn.disabled = false; toast('网络错误'); });
  }

  // ---------- 管理面板（标准模式创建） ----------
  function renderManage() {
    if (!state.user) { location.href = '../login.html'; return; }
    showView('manage');
    var body = $('#manage-body');
    body.innerHTML = '<div class="panel"><h2>同好会试炼管理</h2>' +
      '<p class="muted">当前为标准设置：基础题型、固定及格线、尝试次数、单枚徽章。更复杂的流程将随进阶/专家阶段开放。</p>' +
      '<div class="row">' +
        '<div class="field" style="flex:1;min-width:140px"><label>同好会 ID</label><input id="mg-club-id" type="number" placeholder="俱乐部编号"></div>' +
        '<div class="field" style="width:130px"><label>地区</label><select id="mg-country"><option value="china">中国</option><option value="japan">日本</option></select></div>' +
        '<button class="btn" id="mg-load" style="margin-top:20px">载入</button>' +
      '</div>' +
      '<div id="mg-content"></div></div>';
    $('#mg-load').addEventListener('click', loadManageClub);
  }

  function loadManageClub() {
    var clubId = parseInt($('#mg-club-id').value, 10), country = $('#mg-country').value;
    if (!clubId) { toast('请填写同好会 ID'); return; }
    var box = $('#mg-content');
    box.innerHTML = '<p class="empty">加载中…</p>';
    Promise.all([
      api('recognition_programs.php?action=manage&club_id=' + clubId + '&country=' + country),
      api('recognition_programs.php?action=badge_list&club_id=' + clubId + '&country=' + country)
    ]).then(function (results) {
      var progs = results[0], badges = results[1];
      if (!progs.success) { box.innerHTML = '<p class="empty">' + esc(progs.message) + '</p>'; return; }
      var badgeOptions = ((badges.badges) || []).map(function (b) {
        return '<option value="' + b.id + '">' + esc(b.name) + '</option>';
      }).join('');

      var html = '<h3>已创建的项目</h3>';
      if (!progs.programs.length) html += '<p class="muted">暂无</p>';
      html += '<table class="simple"><tr><th>标题</th><th>类型</th><th>层级</th><th>状态</th><th>已签发</th><th>操作</th></tr>' +
        progs.programs.map(function (p) {
          return '<tr><td><a href="#/program/' + p.id + '">' + esc(p.title) + '</a></td>' +
            '<td>' + esc(TYPE_LABEL[p.type] || p.type) + '</td><td>' + esc(p.tier) + '</td>' +
            '<td>' + esc(STATUS_LABEL[p.status] || p.status) + '</td><td>' + p.issued_total + '</td>' +
            '<td>' + (p.status === 'draft' ? '<button class="btn" data-publish="' + p.id + '">发布</button>' : '') +
            ' <button class="btn" data-codes="' + p.id + '">生成兑换码</button>' +
            (p.type === 'assessment' ? ' <button class="btn" data-sync="' + p.id + '">同步答题战绩</button>' : '') + '</td></tr>';
        }).join('') + '</table>';

      html += '<h3>创建徽章</h3>' +
        '<div class="row">' +
          '<input id="mg-badge-name" placeholder="徽章名称" style="flex:1;border:1px solid var(--line);border-radius:8px;padding:8px">' +
          '<button class="btn" id="mg-badge-create">创建徽章</button>' +
        '</div>';

      html += '<h3>创建试炼（标准设置）</h3>' +
        '<div class="field"><label>标题</label><input id="np-title"></div>' +
        '<div class="field"><label>介绍</label><textarea id="np-intro" rows="2"></textarea></div>' +
        '<div class="row">' +
          '<div class="field" style="flex:1"><label>类型</label><select id="np-type">' +
            '<option value="assessment">知识试炼（答题）</option>' +
            '<option value="activity">活动（兑换码/签到）</option>' +
            '<option value="award">人工授予</option>' +
          '</select></div>' +
          '<div class="field" style="width:120px"><label>及格分</label><input id="np-pass" type="number" value="60" min="0" max="100"></div>' +
          '<div class="field" style="flex:1"><label>奖励徽章</label><select id="np-badge">' + badgeOptions + '</select></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="field" style="width:140px"><label>尝试次数（0=不限）</label><input id="np-attempts" type="number" value="3" min="0"></div>' +
          '<div class="field" style="width:160px"><label>冷却分钟（0=无）</label><input id="np-cooldown" type="number" value="30" min="0"></div>' +
        '</div>' +
        '<div id="np-questions"></div>' +
        '<div class="row">' +
          '<button class="btn" id="np-add-q">+ 添加题目</button>' +
          '<button class="btn btn-primary" id="np-save">保存草稿</button>' +
          '<button class="btn btn-primary" id="np-publish">保存并发布</button>' +
        '</div>' +
        '<div class="field" style="margin-top:16px"><label>人工授予：用户名（逗号分隔，最多 200 个）</label>' +
          '<div class="row"><input id="mg-grant-names" placeholder="user_a, user_b" style="flex:1;border:1px solid var(--line);border-radius:8px;padding:8px">' +
          '<select id="mg-grant-program" style="border:1px solid var(--line);border-radius:8px;padding:8px">' +
            progs.programs.filter(function (p) { return p.type === 'award' || p.type === 'activity'; }).map(function (p) {
              return '<option value="' + p.id + '">' + esc(p.title) + '</option>';
            }).join('') +
          '</select>' +
          '<button class="btn" id="mg-grant">授予</button></div></div>' +
        '<div class="field" style="margin-top:12px"><label>批量导入活动参与名单（CSV：用户名每行一个或逗号分隔）</label>' +
          '<textarea id="mg-import-csv" rows="3" placeholder="user_a&#10;user_b&#10;user_c" style="border:1px solid var(--line);border-radius:8px;padding:8px;width:100%"></textarea>' +
          '<div class="row" style="margin-top:8px">' +
            '<select id="mg-import-program" style="border:1px solid var(--line);border-radius:8px;padding:8px">' +
              progs.programs.filter(function (p) { return p.type === 'activity' || p.type === 'award'; }).map(function (p) {
                return '<option value="' + p.id + '">' + esc(p.title) + '</option>';
              }).join('') +
            '</select>' +
            '<button class="btn" id="mg-import">导入并签发</button>' +
          '</div></div>';

      box.innerHTML = html;

      var qIndex = 0;
      function addQuestionRow() {
        var div = document.createElement('div');
        div.className = 'panel';
        div.style.marginTop = '10px';
        div.innerHTML = '<div class="field"><label>题干</label><input class="qq-text"></div>' +
          '<div class="row">' +
            '<select class="qq-type" style="border:1px solid var(--line);border-radius:8px;padding:8px">' +
              '<option value="single">单选</option><option value="multiple">多选</option><option value="judge">判断</option>' +
            '</select>' +
            '<input class="qq-options" placeholder="选项，用 | 分隔（判断题自动为 对/错）" style="flex:1;border:1px solid var(--line);border-radius:8px;padding:8px">' +
            '<input class="qq-answer" type="number" value="0" min="0" title="正确答案序号（多选逗号分隔）" style="width:110px;border:1px solid var(--line);border-radius:8px;padding:8px">' +
            '<button class="btn btn-ghost qq-del">删除</button>' +
          '</div>';
        div.querySelector('.qq-del').addEventListener('click', function () { div.remove(); });
        div.querySelector('.qq-type').addEventListener('change', function (e) {
          var opt = div.querySelector('.qq-options');
          if (e.target.value === 'judge') { opt.value = '对|错'; opt.disabled = true; } else { opt.disabled = false; }
        });
        $('#np-questions').appendChild(div);
        qIndex++;
      }
      $('#np-add-q').addEventListener('click', addQuestionRow);
      addQuestionRow();

      function collectPayload() {
        var type = $('#np-type').value;
        var badgeId = parseInt($('#np-badge').value, 10);
        if (!badgeId) { toast('请先创建并选择奖励徽章'); return null; }
        var questions = [];
        $('#np-questions').querySelectorAll('.panel').forEach(function (panel) {
          var text = panel.querySelector('.qq-text').value.trim();
          if (!text) return;
          var qtype = panel.querySelector('.qq-type').value;
          var options = qtype === 'judge' ? ['对', '错'] :
            panel.querySelector('.qq-options').value.split('|').map(function (s) { return s.trim(); }).filter(Boolean);
          var answerRaw = panel.querySelector('.qq-answer').value || '0';
          var answer = answerRaw.split(',').map(function (s) { return parseInt(s.trim(), 10); }).filter(function (n) { return !isNaN(n); });
          questions.push({ type: qtype, question: text, options: options, answer: answer, points: 10 });
        });
        var rules = { logic: 'all', conditions: [], award: { badge_id: badgeId, verification_level: 'auto' } };
        if (type === 'assessment') {
          if (!questions.length) { toast('答题试炼至少需要一道题'); return null; }
          rules.conditions.push({ op: 'score_gte', value: parseInt($('#np-pass').value, 10) || 60 });
        }
        return {
          club_id: clubId, country: country, type: type,
          title: $('#np-title').value.trim(), intro: $('#np-intro').value.trim(),
          max_attempts: parseInt($('#np-attempts').value, 10) || 0,
          cooldown_minutes: parseInt($('#np-cooldown').value, 10) || 0,
          content: { quiz: { questions: questions, shuffle: false }, claim: { enabled: type === 'activity' }, rules: rules }
        };
      }

      function saveProgram(publishAfter) {
        var payload = collectPayload();
        if (!payload) return;
        api('recognition_programs.php?action=create', { body: payload }).then(function (res) {
          if (!res.success) { toast(res.message || '创建失败'); return; }
          if (!publishAfter) { toast('草稿已保存（层级：' + res.tier + '）'); loadManageClub(); return; }
          api('recognition_programs.php?action=publish', { body: { program_id: res.program_id } }).then(function (pub) {
            toast(pub.success ? '已发布' : (pub.message || '发布失败'));
            loadManageClub();
          });
        });
      }
      $('#np-save').addEventListener('click', function () { saveProgram(false); });
      $('#np-publish').addEventListener('click', function () { saveProgram(true); });

      $('#mg-badge-create').addEventListener('click', function () {
        var name = $('#mg-badge-name').value.trim();
        if (!name) return;
        api('recognition_programs.php?action=badge_create', { body: { club_id: clubId, country: country, name: name, category: 'participation' } })
          .then(function (r) { toast(r.success ? '徽章已创建' : r.message); if (r.success) loadManageClub(); });
      });

      box.querySelectorAll('[data-publish]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          api('recognition_programs.php?action=publish', { body: { program_id: parseInt(btn.dataset.publish, 10) } })
            .then(function (r) { toast(r.success ? '已发布 ' + r.version_no : r.message); loadManageClub(); });
        });
      });
      box.querySelectorAll('[data-codes]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var pid = parseInt(btn.dataset.codes, 10);
          var n = parseInt(prompt('生成多少个兑换码？（最多 500）', '20'), 10);
          if (!n) return;
          api('recognition_admin.php?action=claim_generate', { body: { program_id: pid, count: n, ttl_hours: 72 } })
            .then(function (r) {
              if (!r.success) { toast(r.message); return; }
              var shareUrl = location.origin + location.pathname + '#/program/' + pid;
              prompt('签到入口（可制作成二维码）：', shareUrl);
              prompt('兑换码列表：', r.codes.join(','));
              loadManageClub();
            });
        });
      });
      box.querySelectorAll('[data-sync]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var pid = parseInt(btn.dataset.sync, 10);
          btn.disabled = true;
          api('recognition_events.php?action=quiz_sync', { body: { program_id: pid, limit: 500 } })
            .then(function (r) {
              toast(r.success ? r.message : (r.message || '同步失败'));
              btn.disabled = false;
              if (r.success) loadManageClub();
            }).catch(function () { btn.disabled = false; toast('网络错误'); });
        });
      });
      var importBtn = $('#mg-import');
      if (importBtn) importBtn.addEventListener('click', function () {
        var csv = $('#mg-import-csv').value;
        var pid = parseInt($('#mg-import-program').value, 10);
        if (!csv.trim() || !pid) { toast('请填写名单并选择项目'); return; }
        importBtn.disabled = true;
        api('recognition_admin.php?action=import_participants', { body: { program_id: pid, csv: csv } })
          .then(function (r) {
            importBtn.disabled = false;
            if (!r.success) { toast(r.message); return; }
            toast('已导入签发 ' + r.imported + ' 人' + (r.skipped_total ? '；跳过 ' + r.skipped_total + ' 人' : ''));
            if (r.imported > 0) $('#mg-import-csv').value = '';
            loadManageClub();
          }).catch(function () { importBtn.disabled = false; toast('网络错误'); });
      });
      var grantBtn = $('#mg-grant');
      if (grantBtn) grantBtn.addEventListener('click', function () {
        var names = $('#mg-grant-names').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        var pid = parseInt($('#mg-grant-program').value, 10);
        if (!names.length || !pid) { toast('请填写用户名并选择授予项目'); return; }
        api('recognition_credentials.php?action=grant', { body: { usernames: names, program_id: pid } })
          .then(function (r) { toast(r.success ? ('已授予 ' + r.granted + ' 人' + (r.skipped.length ? '；跳过：' + r.skipped.join('、') : '')) : r.message); });
      });
    }).catch(function () { box.innerHTML = '<p class="empty">加载失败（可能无权限）</p>'; });
  }

  // ---------- 路由 ----------
  function route() {
    var hash = location.hash || '#/';
    var m;
    if ((m = hash.match(/^#\/program\/(\d+)/))) renderDetail(parseInt(m[1], 10));
    else if (hash === '#/manage') renderManage();
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
    $('#manage-entry').addEventListener('click', function () { location.hash = '#/manage'; });
    $('#back-to-list').addEventListener('click', function () { location.hash = '#/'; });
    $('#back-from-manage').addEventListener('click', function () { location.hash = '#/'; });
    window.addEventListener('hashchange', route);

    loadLoginState().then(route);
  });
})();
