// admin/quiz_designer.js - 题目设计器（文档式）
// 题型：单选 / 多选 / 判断 / 填空 / 排序 / 多空填空；题干与选项支持图片。
// 点选项前字母设正确答案；排序题直接按正确顺序排列选项。
// 与考核编辑器的数据交换走 localStorage（recog_qd_input / recog_qd_output）。
(function () {
  'use strict';

  var TYPE_LABEL = { single: '单选', multiple: '多选', judge: '判断', fill_blank: '填空', order: '排序', fill_multi: '多空填空' };
  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var KEY_IN = 'recog_qd_input';
  var KEY_OUT = 'recog_qd_output';
  var KEY_DIRECT = 'recog_qd_direct'; // 题库区直连导入（优先级最高，读完即删）
  var MAX_QUESTIONS = 500;
  var MAX_OPTIONS = 20;
  var MAX_BLANKS = 10;
  var IMG_RE = /^data\/quiz_images\/[A-Za-z0-9_\-.]+\.(jpe?g|png|gif|webp)$/i;

  // 图片上传需要同好会上下文：由考核编辑器以 ?club=&country= 打开
  var urlp = new URLSearchParams(location.search);
  var CLUB = parseInt(urlp.get('club'), 10) || 0;
  var COUNTRY = urlp.get('country') || 'china';

  var state = { questions: [], preview: false };
  var pendingImg = null; // { qi, oi } oi=-1 表示题干图

  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg) {
    var el = $('#qdToast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  function defaultQuestion() {
    return { type: 'single', question: '', options: ['', ''], answer: [], points: 10, explanation: '' };
  }

  // ---------- 与考核编辑器 / 题库区的数据交换 ----------
  function applyQuizPayload(data) {
    var quiz = data.quiz || data;
    if (!(quiz && Array.isArray(quiz.questions))) return false;
    state.questions = quiz.questions.map(function (q) {
      return {
        type: TYPE_LABEL[q.type] ? q.type : 'single',
        question: String(q.question || ''),
        options: Array.isArray(q.options) ? q.options.map(String) : [],
        answer: Array.isArray(q.answer) ? q.answer.map(function (n) { return parseInt(n, 10); }).filter(function (n) { return !isNaN(n); }) : [],
        answer_text: String(q.answer_text || ''),
        answer_texts: Array.isArray(q.answer_texts) ? q.answer_texts.map(String) : [],
        points: parseInt(q.points, 10) || 10,
        explanation: String(q.explanation || ''),
        image: typeof q.image === 'string' ? q.image : '',
        option_images: Array.isArray(q.option_images) ? q.option_images.map(String) : []
      };
    });
    var s = quiz.settings || {};
    $('#qdShuffle').value = s.shuffle ? '1' : '0';
    $('#qdShuffleOpt').value = s.shuffle_options ? '1' : '0';
    $('#qdPick').value = String(parseInt(s.pick_count, 10) || 0);
    $('#qdTimeLimit').value = String(parseInt(s.time_limit, 10) || 0);
    $('#qdPartial').value = s.multiple_partial ? '1' : '0';
    $('#qdResultMode').value = ['immediate', 'pass_only', 'hidden'].indexOf(s.result_mode) >= 0 ? s.result_mode : 'immediate';
    return true;
  }

  function loadInput() {
    // 题库区直连导入优先：读完即删，避免下次打开重复导入。
    try {
      var direct = localStorage.getItem(KEY_DIRECT);
      if (direct) {
        localStorage.removeItem(KEY_DIRECT);
        var d = JSON.parse(direct);
        if (applyQuizPayload(d)) return;
      }
    } catch (e) {}
    try {
      var raw = localStorage.getItem(KEY_IN);
      if (!raw) return;
      var data = JSON.parse(raw);
      applyQuizPayload(data);
    } catch (e) { /* 输入损坏则从空白开始 */ }
  }

  function collectSettings() {
    return {
      shuffle: $('#qdShuffle').value === '1',
      shuffle_options: $('#qdShuffleOpt').value === '1',
      pick_count: parseInt($('#qdPick').value, 10) || 0,
      time_limit: parseInt($('#qdTimeLimit').value, 10) || 0,
      multiple_partial: $('#qdPartial').value === '1',
      result_mode: $('#qdResultMode').value
    };
  }

  function collectQuiz() {
    // 只携带有效字段，保持快照干净
    var questions = state.questions.map(function (q) {
      var out = { type: q.type, question: q.question, points: q.points, explanation: q.explanation };
      if (q.type === 'fill_multi') {
        out.answer_texts = q.answer_texts;
      } else if (q.type === 'fill_blank') {
        out.answer_text = q.answer_text;
      } else if (q.type !== 'order') {
        out.options = q.options;
        out.answer = q.answer;
      } else {
        out.options = q.options;
      }
      if (q.image) out.image = q.image;
      if (q.option_images && q.option_images.some(function (u) { return u; })) out.option_images = q.option_images;
      return out;
    });
    return { questions: questions, settings: collectSettings() };
  }

  // ---------- 校验（与后端 recogValidateQuizContent 对齐） ----------
  function validate() {
    var qs = state.questions;
    if (!qs.length) return '至少需要一道题';
    if (qs.length > MAX_QUESTIONS) return '题目数量不能超过 ' + MAX_QUESTIONS;
    for (var i = 0; i < qs.length; i++) {
      var q = qs[i], no = '第 ' + (i + 1) + ' 题';
      if (!q.question.trim()) return no + '题干为空';
      var points = parseInt(q.points, 10);
      if (isNaN(points) || points < 1 || points > 100) return no + '分值需在 1–100 之间';
      if (q.image && !IMG_RE.test(q.image)) return no + '题干图片地址异常，请重新上传';
      if (q.type === 'fill_blank') {
        if (!String(q.answer_text || '').trim()) return no + '缺少参考答案';
      } else if (q.type === 'fill_multi') {
        if (!q.answer_texts.length) return no + '至少需要一个空';
        for (var bi = 0; bi < q.answer_texts.length; bi++) {
          if (!q.answer_texts[bi].trim()) return no + '第 ' + (bi + 1) + ' 个空缺少参考答案';
        }
      } else {
        if (!q.options || q.options.length < 2) return no + '选项不足（至少 2 个）';
        if (q.type === 'order' && q.options.length > MAX_OPTIONS) return no + '排序题选项不能超过 ' + MAX_OPTIONS + ' 个';
        if (q.type !== 'order' && !q.answer.length) return no + '未标记正确答案';
        for (var k = 0; k < q.answer.length; k++) {
          if (q.answer[k] < 0 || q.answer[k] >= q.options.length) return no + '答案索引越界';
        }
        if (q.type === 'single' && q.answer.length !== 1) return no + '单选题只能有一个正确答案';
      }
      if (q.option_images && q.option_images.length) {
        if (q.option_images.length !== (q.options || []).length) return no + '选项图数量与选项不一致';
        for (var oi = 0; oi < q.option_images.length; oi++) {
          if (q.option_images[oi] && !IMG_RE.test(q.option_images[oi])) return no + '选项图地址异常，请重新上传';
        }
      }
    }
    var s = collectSettings();
    if (s.pick_count > qs.length) return '抽题数量不能超过总题数（' + qs.length + '）';
    if (s.time_limit > 180) return '限时不能超过 180 分钟';
    return null;
  }

  // ---------- 编辑态：文档流渲染 ----------
  function typeOptionsHtml(cur) {
    return Object.keys(TYPE_LABEL).map(function (t) {
      return '<option value="' + t + '"' + (t === cur ? ' selected' : '') + '>' + TYPE_LABEL[t] + '</option>';
    }).join('');
  }

  // 图片缩略图（带删除）
  function thumbHtml(url, rmAttr) {
    if (!url) return '';
    return '<span class="qd-img-thumb"><img src="' + esc(url) + '" alt=""><button type="button" class="rm" ' + rmAttr + ' title="移除图片">×</button></span>';
  }

  function optImgBtn(q, oi) {
    var url = (q.option_images || [])[oi] || '';
    return thumbHtml(url, 'data-rmoptimg="' + oi + '"') +
      '<button class="btn btn-xs" data-optimg="' + oi + '" type="button">' + (url ? '换图' : '图') + '</button>';
  }

  function questionCardHtml(q, i) {
    var body = '';

    if (q.type === 'fill_blank') {
      body = '<div class="qd-opts"><div class="qd-opt">' +
        '<input type="text" class="form-input" data-answer-text value="' + esc(q.answer_text || '') + '" placeholder="参考答案（判分忽略大小写与首尾空格）">' +
      '</div></div>';
    } else if (q.type === 'fill_multi') {
      var blanks = q.answer_texts.map(function (t, bi) {
        return '<div class="qd-blank"><span class="lbl">第 ' + (bi + 1) + ' 空</span>' +
          '<input type="text" class="form-input" data-blank="' + bi + '" value="' + esc(t) + '" placeholder="参考答案">' +
          (q.answer_texts.length > 1 ? '<button class="btn btn-xs danger-ghost" data-delblank="' + bi + '" type="button">删</button>' : '') +
        '</div>';
      }).join('');
      body = '<div class="qd-opts">' + blanks +
        (q.answer_texts.length < MAX_BLANKS ? '<button class="btn btn-sm qd-add-opt" data-addblank type="button">+ 加一个空</button>' : '') +
      '</div>';
    } else if (q.type === 'order') {
      // 排序题：选项当前排列即正确答案，拖动（或 ↑↓）调整
      var rows = q.options.map(function (opt, oi) {
        return '<div class="qd-opt qd-order-row" draggable="true">' +
          '<span class="drag" title="拖动调整顺序">⋮⋮</span>' +
          '<span class="letter no-mark">' + (oi + 1) + '</span>' +
          '<input type="text" data-opt="' + oi + '" value="' + esc(opt) + '" placeholder="选项 ' + (oi + 1) + '">' +
          optImgBtn(q, oi) +
          '<button class="btn btn-xs mv" data-omove="-1" data-ooi="' + oi + '" type="button">↑</button>' +
          '<button class="btn btn-xs mv" data-omove="1" data-ooi="' + oi + '" type="button">↓</button>' +
          (q.options.length > 2 ? '<button class="btn btn-sm danger-ghost" data-delopt="' + oi + '" type="button">删</button>' : '') +
        '</div>';
      }).join('');
      body = '<div class="qd-opts">' + rows +
        (q.options.length < MAX_OPTIONS ? '<button class="btn btn-sm qd-add-opt" data-addopt type="button">+ 添加选项</button>' : '') +
        '<div class="qd-opt-mark">按正确顺序排列（1 在最前），拖动或用 ↑↓ 调整</div>' +
      '</div>';
    } else {
      var letters = q.options.map(function (opt, oi) {
        var correct = q.answer.indexOf(oi) >= 0;
        var letter = q.type === 'judge' ? (oi === 0 ? '✓' : '✗') : LETTERS[oi];
        return '<div class="qd-opt">' +
          '<span class="letter' + (correct ? ' correct' : '') + '" data-mark="' + oi + '" title="设为正确答案">' + letter + '</span>' +
          '<input type="text" data-opt="' + oi + '" value="' + esc(opt) + '" placeholder="选项 ' + LETTERS[oi] + '"' + (q.type === 'judge' ? ' readonly' : '') + '>' +
          optImgBtn(q, oi) +
          (q.type !== 'judge' && q.options.length > 2 ? '<button class="btn btn-sm danger-ghost" data-delopt="' + oi + '" type="button">删</button>' : '') +
        '</div>';
      }).join('');
      var addOptBtn = q.type !== 'judge' && q.options.length < MAX_OPTIONS
        ? '<button class="btn btn-sm qd-add-opt" data-addopt type="button">+ 添加选项</button>' : '';
      var hint = q.type === 'multiple' ? '点字母设为正确答案，多选可标记多个' : '点字母设为正确答案';
      body = '<div class="qd-opts">' + letters + addOptBtn + '<div class="qd-opt-mark">' + hint + '</div></div>';
    }

    // 题干图
    var stemImg = '<div class="qd-img-row">' + thumbHtml(q.image, 'data-rmimg') +
      '<button class="btn btn-xs" data-stemimg type="button">' + (q.image ? '换题干图' : '+ 题干图片') + '</button></div>';

    return '<div class="qd-q" data-qi="' + i + '">' +
      '<div class="qd-q-head">' +
        '<span class="qd-q-no">' + (i + 1) + '</span>' +
        '<select class="form-input qd-type" data-type style="width:96px">' + typeOptionsHtml(q.type) + '</select>' +
        '<span class="pts-wrap">分值 <input type="number" class="form-input" data-points min="1" max="100" value="' + (parseInt(q.points, 10) || 10) + '"></span>' +
        '<span class="qd-q-tools">' +
          '<button class="btn btn-sm" data-move="-1" type="button"' + (i === 0 ? ' disabled' : '') + ' title="上移">↑</button>' +
          '<button class="btn btn-sm" data-move="1" type="button"' + (i >= state.questions.length - 1 ? ' disabled' : '') + ' title="下移">↓</button>' +
          '<button class="btn btn-sm" data-dup type="button" title="复制本题">复制</button>' +
          '<button class="btn btn-sm danger-ghost" data-del type="button" title="删除本题">删</button>' +
        '</span>' +
      '</div>' +
      '<div class="qd-stem"><textarea class="form-input" data-question rows="2" placeholder="输入题干">' + esc(q.question) + '</textarea></div>' +
      stemImg + body +
      '<div class="qd-expl-row"><span class="lbl">解析</span><input type="text" class="form-input" data-explanation maxlength="500" value="' + esc(q.explanation || '') + '" placeholder="交卷后展示给参与者（可选）"></div>' +
    '</div>';
  }

  function renderDoc() {
    var box = $('#qdDoc');
    $('#qdDocCount').textContent = state.questions.length + ' 题';
    if (!state.questions.length) {
      box.innerHTML = '<div class="qd-empty">还没有题目，点击下方「+ 添加题目」开始</div>';
      return;
    }
    box.innerHTML = state.questions.map(questionCardHtml).join('');
  }

  // ---------- 预览（考生视角试卷纸） ----------
  function pvOptImg(q, oi) {
    var url = (q.option_images || [])[oi] || '';
    return url ? '<img src="' + esc(url) + '" alt="">' : '';
  }

  function renderPreview() {
    var s = collectSettings();
    var meta = [];
    meta.push('共 ' + state.questions.length + ' 题');
    if (s.pick_count > 0) meta.push('随机抽 ' + s.pick_count + ' 题');
    if (s.time_limit > 0) meta.push('限时 ' + s.time_limit + ' 分钟');
    if (s.shuffle) meta.push('题目乱序');
    if (s.shuffle_options) meta.push('选项乱序');
    if (s.multiple_partial) meta.push('多选漏选得部分分');

    var questionsHtml = state.questions.map(function (q, i) {
      var img = q.image ? '<div class="qd-pv-img"><img src="' + esc(q.image) + '" alt=""></div>' : '';
      var body = '';
      if (q.type === 'fill_blank') {
        body = '<div class="qd-pv-fill">填写答案：__________</div>' +
          '<div class="qd-pv-ans">参考答案：' + esc(q.answer_text || '') + '</div>';
      } else if (q.type === 'fill_multi') {
        body = q.answer_texts.map(function (t, bi) {
          return '<div class="qd-pv-fill">第 ' + (bi + 1) + ' 空：__________</div>';
        }).join('') + '<div class="qd-pv-ans">参考答案：' + q.answer_texts.map(esc).join('；') + '</div>';
      } else if (q.type === 'order') {
        body = q.options.map(function (opt, oi) {
          return '<div class="qd-pv-opt correct"><span class="mark">' + (oi + 1) + '</span>' + pvOptImg(q, oi) + '<span>' + esc(opt) + '</span></div>';
        }).join('') + '<div class="qd-pv-ans">正确顺序：1 → ' + q.options.length + '</div>';
      } else {
        body = q.options.map(function (opt, oi) {
          var correct = q.answer.indexOf(oi) >= 0;
          var mark = q.type === 'judge' ? (oi === 0 ? '✓' : '✗') : LETTERS[oi];
          return '<div class="qd-pv-opt' + (correct ? ' correct' : '') + '">' +
            '<span class="mark">' + (correct ? '● ' : '') + mark + '</span>' + pvOptImg(q, oi) + '<span>' + esc(opt) + '</span></div>';
        }).join('') +
        '<div class="qd-pv-ans">正确答案：' + q.answer.map(function (a) { return q.type === 'judge' ? (a === 0 ? '对' : '错') : LETTERS[a]; }).join('、') + '</div>';
      }
      return '<div class="qd-pv-q">' +
        '<div class="qd-pv-qt"><span class="no">' + (i + 1) + '.</span>' + esc(q.question || '（未填写题干）') +
          '<span class="pts">【' + TYPE_LABEL[q.type] + ' · ' + (parseInt(q.points, 10) || 10) + ' 分】</span></div>' +
        img + body +
        (q.explanation ? '<div class="qd-pv-expl">解析：' + esc(q.explanation) + '</div>' : '') +
      '</div>';
    }).join('');

    $('#qdDoc').innerHTML = '<div class="qd-pv-paper">' +
      '<div class="qd-pv-title">知识问答试卷</div>' +
      '<div class="qd-pv-meta">' + esc(meta.join(' · ')) + '</div>' +
      questionsHtml +
      '<div class="qd-pv-note">预览 · 绿色为正确答案</div>' +
    '</div>';
  }

  function renderAll() {
    if (state.preview) renderPreview(); else renderDoc();
    $('#qdAdd').style.display = state.preview ? 'none' : '';
  }

  // 排序题选项移动（from/to 为当前排列下标），同步迁移选项图
  function moveOrderOpt(q, from, to) {
    if (from === to || from < 0 || to < 0 || from >= q.options.length) return;
    var moved = q.options.splice(from, 1)[0];
    q.options.splice(to, 0, moved);
    if (q.option_images && q.option_images.length === q.options.length) {
      var mi = q.option_images.splice(from, 1)[0];
      q.option_images.splice(to, 0, mi);
    }
    renderDoc();
  }

  // ---------- 图片上传 ----------
  async function uploadQuizImage(file, qi, oi) {
    if (!CLUB) { toast('请从考核编辑器打开设计器后再上传图片'); return; }
    var fd = new FormData();
    fd.append('image', file);
    fd.append('club_id', String(CLUB));
    fd.append('country', COUNTRY);
    toast('上传中…');
    try {
      var r = await fetch('../api/quiz_image.php?action=upload', { method: 'POST', body: fd, credentials: 'same-origin' });
      var res = await r.json();
      if (!res || !res.success) { toast((res && res.message) || '上传失败'); return; }
      var q = state.questions[qi];
      if (!q) return;
      if (oi < 0) {
        q.image = res.image_url;
      } else {
        if (!Array.isArray(q.option_images) || q.option_images.length !== q.options.length) {
          q.option_images = q.options.map(function () { return ''; });
        }
        q.option_images[oi] = res.image_url;
      }
      renderDoc();
      toast('图片已添加');
    } catch (e) { toast('上传失败，请稍后重试'); }
  }

  // ---------- 事件（文档区委托） ----------
  function bind() {
    $('#qdAdd').addEventListener('click', function () {
      if (state.questions.length >= MAX_QUESTIONS) { toast('最多 ' + MAX_QUESTIONS + ' 道题'); return; }
      state.questions.push(defaultQuestion());
      renderAll();
      var cards = document.querySelectorAll('.qd-q');
      if (cards.length) cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
      var stem = document.querySelector('.qd-q:last-of-type [data-question]');
      if (stem) stem.focus();
    });

    var doc = $('#qdDoc');

    doc.addEventListener('click', function (e) {
      if (state.preview) return;
      var card = e.target.closest('.qd-q');
      if (!card) return;
      var qi = parseInt(card.dataset.qi, 10);
      var q = state.questions[qi];
      if (!q) return;
      var t = e.target;

      if (t.matches('[data-mark]')) {
        var oi = parseInt(t.dataset.mark, 10);
        if (q.type === 'multiple') {
          var idx = q.answer.indexOf(oi);
          if (idx >= 0) q.answer.splice(idx, 1); else q.answer.push(oi);
        } else {
          q.answer = q.answer.length === 1 && q.answer[0] === oi ? [] : [oi];
        }
        renderDoc();
      } else if (t.matches('[data-addopt]')) {
        q.options.push('');
        renderDoc();
      } else if (t.matches('[data-delopt]')) {
        var di = parseInt(t.dataset.delopt, 10);
        q.options.splice(di, 1);
        q.answer = q.answer.filter(function (a) { return a !== di; }).map(function (a) { return a > di ? a - 1 : a; });
        if (q.option_images && q.option_images.length) q.option_images.splice(di, 1);
        renderDoc();
      } else if (t.matches('[data-omove]')) {
        // 排序题选项上下移：同时迁移选项图
        var oi2 = parseInt(t.dataset.ooi, 10);
        var ni = oi2 + parseInt(t.dataset.omove, 10);
        if (ni < 0 || ni >= q.options.length) return;
        var tmpT = q.options[oi2]; q.options[oi2] = q.options[ni]; q.options[ni] = tmpT;
        if (q.option_images && q.option_images.length === q.options.length) {
          var tmpI = q.option_images[oi2]; q.option_images[oi2] = q.option_images[ni]; q.option_images[ni] = tmpI;
        }
        renderDoc();
      } else if (t.matches('[data-addblank]')) {
        q.answer_texts.push('');
        renderDoc();
      } else if (t.matches('[data-delblank]')) {
        q.answer_texts.splice(parseInt(t.dataset.delblank, 10), 1);
        renderDoc();
      } else if (t.matches('[data-stemimg]')) {
        pendingImg = { qi: qi, oi: -1 };
        $('#qdImgFile').click();
      } else if (t.matches('[data-optimg]')) {
        pendingImg = { qi: qi, oi: parseInt(t.dataset.optimg, 10) };
        $('#qdImgFile').click();
      } else if (t.matches('[data-rmimg]')) {
        q.image = '';
        renderDoc();
      } else if (t.matches('[data-rmoptimg]')) {
        var ri = parseInt(t.dataset.rmoptimg, 10);
        if (q.option_images && q.option_images[ri] !== undefined) q.option_images[ri] = '';
        renderDoc();
      } else if (t.matches('[data-move]')) {
        var step = parseInt(t.dataset.move, 10);
        var ni2 = qi + step;
        if (ni2 < 0 || ni2 >= state.questions.length) return;
        var tmp = state.questions[qi];
        state.questions[qi] = state.questions[ni2];
        state.questions[ni2] = tmp;
        renderDoc();
      } else if (t.matches('[data-dup]')) {
        state.questions.splice(qi + 1, 0, JSON.parse(JSON.stringify(q)));
        renderDoc();
        toast('已复制第 ' + (qi + 1) + ' 题');
      } else if (t.matches('[data-del]')) {
        if (!confirm('删除第 ' + (qi + 1) + ' 题？')) return;
        state.questions.splice(qi, 1);
        renderDoc();
      }
    });

    // 排序题拖拽：drop 后更新 state 并重绘（↑↓ 按钮仍可用）
    var qdDrag = null;
    function clearQdHints() {
      doc.querySelectorAll('.qd-drop-top,.qd-drop-bottom').forEach(function (el) {
        el.classList.remove('qd-drop-top', 'qd-drop-bottom');
      });
    }
    doc.addEventListener('dragstart', function (e) {
      var row = e.target.closest('.qd-order-row');
      if (!row || state.preview) return;
      qdDrag = { card: row.closest('.qd-q'), el: row };
      row.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', 'order'); } catch (err) {}
      e.dataTransfer.effectAllowed = 'move';
    });
    doc.addEventListener('dragend', function () {
      if (qdDrag) { qdDrag.el.classList.remove('dragging'); qdDrag = null; }
      clearQdHints();
    });
    doc.addEventListener('dragover', function (e) {
      if (!qdDrag) return;
      var row = e.target.closest('.qd-order-row');
      if (!row || row === qdDrag.el || row.closest('.qd-q') !== qdDrag.card) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var rect = row.getBoundingClientRect();
      clearQdHints();
      row.classList.add(e.clientY < rect.top + rect.height / 2 ? 'qd-drop-top' : 'qd-drop-bottom');
    });
    doc.addEventListener('drop', function (e) {
      if (!qdDrag) return;
      e.preventDefault();
      var row = e.target.closest('.qd-order-row');
      if (row && row !== qdDrag.el && row.closest('.qd-q') === qdDrag.card) {
        var q = state.questions[parseInt(qdDrag.card.dataset.qi, 10)];
        if (q) {
          var rows = Array.prototype.slice.call(qdDrag.card.querySelectorAll('.qd-order-row'));
          var from = rows.indexOf(qdDrag.el);
          var to = rows.indexOf(row);
          var rect = row.getBoundingClientRect();
          if (e.clientY >= rect.top + rect.height / 2) to++;
          if (to > from) to--;
          moveOrderOpt(q, from, to);
        }
      }
      if (qdDrag) { qdDrag.el.classList.remove('dragging'); qdDrag = null; }
      clearQdHints();
    });

    // 输入直接写入状态（不重渲染，避免光标跳动）
    doc.addEventListener('input', function (e) {
      if (state.preview) return;
      var card = e.target.closest('.qd-q');
      if (!card) return;
      var q = state.questions[parseInt(card.dataset.qi, 10)];
      if (!q) return;
      var t = e.target;
      if (t.matches('[data-question]')) q.question = t.value;
      else if (t.matches('[data-points]')) q.points = parseInt(t.value, 10) || 10;
      else if (t.matches('[data-explanation]')) q.explanation = t.value;
      else if (t.matches('[data-answer-text]')) q.answer_text = t.value;
      else if (t.matches('[data-blank]')) q.answer_texts[parseInt(t.dataset.blank, 10)] = t.value;
      else if (t.matches('[data-opt]')) q.options[parseInt(t.dataset.opt, 10)] = t.value;
    });

    doc.addEventListener('change', function (e) {
      if (state.preview) return;
      var t = e.target;
      if (!t.matches('[data-type]')) return;
      var card = t.closest('.qd-q');
      var q = state.questions[parseInt(card.dataset.qi, 10)];
      if (!q) return;
      q.type = t.value;
      if (q.type === 'judge') { q.options = ['对', '错']; q.answer = []; }
      else if (q.type === 'fill_blank' || q.type === 'fill_multi') {
        q.answer = [];
        if (q.type === 'fill_multi' && (!q.answer_texts || !q.answer_texts.length)) q.answer_texts = ['', ''];
      } else {
        // 排序题转为选择题：保留选项，答案需重新标记
        if (q.type === 'single' && q.answer.length > 1) q.answer = [q.answer[0]];
        q.answer = q.answer.filter(function (a) { return a < q.options.length; });
        if (q.options.length < 2) q.options = ['', ''];
      }
      renderDoc();
    });

    // 图片选择 → 上传
    $('#qdImgFile').addEventListener('change', function () {
      var file = this.files && this.files[0];
      this.value = '';
      if (!file || !pendingImg) return;
      var p = pendingImg; pendingImg = null;
      uploadQuizImage(file, p.qi, p.oi);
    });

    // ---------- 顶栏 ----------
    $('#qdTogglePreview').addEventListener('click', function () {
      state.preview = !state.preview;
      this.textContent = state.preview ? '继续编辑' : '预览';
      renderAll();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    $('#qdExport').addEventListener('click', function () {
      var err = validate();
      if (err) { toast('无法导出：' + err); return; }
      var blob = new Blob([JSON.stringify(collectQuiz(), null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'quiz_questions.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
      toast('已导出 quiz_questions.json');
    });

    $('#qdImport').addEventListener('click', function () { $('#qdImportFile').click(); });
    $('#qdImportFile').addEventListener('change', function () {
      var file = this.files && this.files[0];
      this.value = '';
      if (!file) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var data = JSON.parse(fr.result);
          localStorage.setItem(KEY_IN, JSON.stringify({ ts: Date.now(), quiz: data.quiz || data }));
          loadInput();
          state.preview = false;
          $('#qdTogglePreview').textContent = '预览';
          renderAll();
          toast('导入成功：' + state.questions.length + ' 道题');
        } catch (e) { toast('导入失败：JSON 格式不正确'); }
      };
      fr.readAsText(file);
    });

    $('#qdDone').addEventListener('click', function () {
      var err = validate();
      if (err) {
        state.preview = false;
        $('#qdTogglePreview').textContent = '预览';
        renderAll();
        toast('无法带回：' + err);
        return;
      }
      localStorage.setItem(KEY_OUT, JSON.stringify({ ts: Date.now(), quiz: collectQuiz() }));
      toast('已带回考核编辑器');
      setTimeout(function () { window.close(); }, 600);
      // 若浏览器拦截 window.close（非脚本打开的标签页），提示手动切回
      setTimeout(function () { toast('请切回考核编辑器标签页，题目将自动导入'); }, 1500);
    });
  }

  loadInput();
  bind();
  renderAll();
})();
