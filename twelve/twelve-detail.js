(function () {
  'use strict';
  var $ = $vote, esc = escVote, api = apiVote, post = postVote;
  var toast = function (m) { toastVote($('toast'), m); };

  var STAGE_META = {
    nomination: { label: '提名期', color: 'nomination' },
    qualifier:  { label: '海选', color: 'qualifier' },
    group_vote: { label: '分组投票', color: 'group_vote' },
    final:      { label: '最终十二器', color: 'final' }
  };

  var COVER_GRADIENTS = [
    'linear-gradient(135deg,#dbeafe,#bfdbfe)', 'linear-gradient(135deg,#ede9fe,#d8cef8)',
    'linear-gradient(135deg,#fefce8,#fef08a)', 'linear-gradient(135deg,#f1f5f9,#e2e8f0)',
    'linear-gradient(135deg,#e8f5e9,#c8e6c9)', 'linear-gradient(135deg,#fff3e0,#ffe0b2)',
    'linear-gradient(135deg,#f3e5f5,#e1bee7)', 'linear-gradient(135deg,#ccfbf1,#99f6e4)'
  ];

  var CHECK_SVG = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="3"><polyline points="3,8 7,12 13,4"/></svg>';

  var STATE = {
    shareToken: '',
    guestMode: false,
    project: null,
    stages: [],
    currentStage: null,
    works: [],
    myVotes: {},
    myScores: {},
    myNominations: [],
    groups: [],
    currentGroup: 0,
    resultRows: [],
    resultMap: {},
    votingLocked: false,
    countdownTimer: null
  };

  function coverGradient(idx) { return COVER_GRADIENTS[idx % 8]; }
  function fmtDate(s) {
    if (!s) return '-';
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function init() {
    var params = new URLSearchParams(window.location.search);
    var id = params.get('id');
    STATE.shareToken = params.get('share') || '';
    if (!id) { renderEmpty('缺少活动ID'); return; }
    bindSubmit();
    loadProject(id);
  }

  function renderEmpty(message) {
    $('mdMainPanel').innerHTML = '<div class="md-empty">' + esc(message || '暂无内容') + '</div>';
    $('mdStatusBadge').textContent = '-';
  }

  // 免登录参与模式：持有有效分享链接 + 企划开启 guest_vote 且当前账号无参与资格。
  function applyGuestMode(data) {
    STATE.guestMode = false;
    var banner = $('twGuestBanner');
    if (!banner) return;
    STATE.authenticated = !!data.authenticated;
    var guestAllowed = !!data.guest_vote_enabled && !!data.share_valid;
    var canParticipate = !!data.can_participate;
    if (guestAllowed && !canParticipate && !STATE.authenticated) {
      STATE.guestMode = true;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  function loadProject(projectId) {
    ensureClubNamesLoaded();
    var getUrl = '../api/twelve_contests.php?action=get&project_id=' + encodeURIComponent(projectId);
    if (STATE.shareToken) getUrl += '&share=' + encodeURIComponent(STATE.shareToken);
    api(getUrl).then(function (data) {
      if (!data || !data.data) { renderEmpty('活动不存在'); return; }
      STATE.project = data.data;
      applyGuestMode(data);
      $('mdContestTitle').textContent = data.data.title;
      $('mdInfoClub').textContent = resolveClubName(data.data.club_id, data.data.country);
      loadStages(projectId);
    }).catch(function () {
      renderEmpty('加载失败，请刷新重试');
    });
  }

  function loadStages(projectId) {
    api('../api/twelve_rounds.php?action=list&project_id=' + projectId).then(function (data) {
      STATE.stages = (data && data.data) || [];
      renderStageNav();
      renderTimeline();

      var openStage = null;
      for (var i = 0; i < STATE.stages.length; i++) {
        if (STATE.stages[i].status === 'open') { openStage = STATE.stages[i]; break; }
      }
      if (!openStage) {
        var resultStage = null;
        for (var j = STATE.stages.length - 1; j >= 0; j--) {
          if (STATE.stages[j].status === 'settled' || STATE.stages[j].status === 'reviewing') { resultStage = STATE.stages[j]; break; }
        }
        if (resultStage) {
          setActiveStage(resultStage);
          renderStageResults(resultStage);
          return;
        }
        renderEmpty('当前没有进行中的阶段');
        updateStatusBadge('未开始');
        return;
      }
      setActiveStage(openStage);
      renderStage(openStage);
    }).catch(function () {
      renderEmpty('阶段加载失败');
    });
  }

  function setActiveStage(stage) {
    STATE.currentStage = stage;
    updateStatusBadge(
      stage.status === 'open' ? '进行中' :
      (stage.status === 'pending' || stage.status === 'locked') ? '未开始' : '已结束'
    );
    $('mdInfoStage').textContent = (STAGE_META[stage.stage_type] || {}).label || stage.stage_type;
    $('mdInfoStart').textContent = fmtDate(stage.starts_at);
    $('mdInfoEnd').textContent = fmtDate(stage.ends_at);
    startCountdown(stage.ends_at);

    var chips = document.querySelectorAll('.md-stage-chip');
    for (var i = 0; i < chips.length; i++) {
      var active = Number(chips[i].dataset.stageId) === Number(stage.id);
      chips[i].classList.toggle('active', active);
    }
  }

  function updateStatusBadge(text) {
    var badge = $('mdStatusBadge');
    if (!badge) return;
    badge.textContent = text;
    if (text === '进行中') {
      badge.style.background = '#e6f7ed';
      badge.style.color = 'var(--brand-2)';
      badge.style.borderColor = 'var(--brand-2)';
    } else if (text === '已结束') {
      badge.style.background = 'var(--gold-bg)';
      badge.style.color = 'var(--gold)';
      badge.style.borderColor = 'var(--gold)';
    } else {
      badge.style.background = 'var(--bg)';
      badge.style.color = 'var(--muted)';
      badge.style.borderColor = 'var(--line)';
    }
  }

  function startCountdown(endTime) {
    if (STATE.countdownTimer) clearInterval(STATE.countdownTimer);
    var el = $('mdCountdown');
    if (!endTime) { el.textContent = '--天 --:--:--'; return; }

    function tick() {
      var diff = new Date(endTime) - Date.now();
      if (diff <= 0) {
        el.textContent = '已结束';
        el.classList.add('ended');
        return;
      }
      el.classList.remove('ended');
      var days = Math.floor(diff / 86400000);
      var hours = Math.floor((diff % 86400000) / 3600000);
      var minutes = Math.floor((diff % 3600000) / 60000);
      var seconds = Math.floor((diff % 60000) / 1000);
      el.textContent = (days > 0 ? days + '天 ' : '') +
        String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }
    tick();
    STATE.countdownTimer = setInterval(tick, 1000);
  }

  function renderStageNav() {
    var list = $('mdStageList');
    list.innerHTML = '';
    for (var i = 0; i < STATE.stages.length; i++) {
      var s = STATE.stages[i];
      var meta = STAGE_META[s.stage_type] || { label: s.stage_type };
      var chip = document.createElement('span');
      chip.className = 'md-stage-chip' + (s.status === 'settled' || s.status === 'reviewing' ? ' settled' : '');
      chip.dataset.stageId = s.id;
      chip.textContent = meta.label;
      chip.addEventListener('click', (function (stage) {
        return function () {
          setActiveStage(stage);
          if (stage.status === 'settled' || stage.status === 'reviewing') {
            renderStageResults(stage);
          } else if (stage.status !== 'open') {
            renderEmpty('该阶段尚未开始，开始后可在此参与');
          } else {
            renderStage(stage);
          }
        };
      })(s));
      list.appendChild(chip);
    }
  }

  function renderTimeline() {
    var wrap = $('mdTimeline');
    wrap.innerHTML = '';
    for (var i = 0; i < STATE.stages.length; i++) {
      var s = STATE.stages[i];
      var meta = STAGE_META[s.stage_type] || { label: s.stage_type };
      var item = document.createElement('div');
      item.className = 'md-timeline-item' + (s.status === 'open' ? ' open' : '') + (s.status === 'settled' || s.status === 'reviewing' ? ' settled' : '');
      item.innerHTML =
        '<div class="md-timeline-dot"></div>' +
        '<div>' +
          '<div class="md-timeline-label">' + esc(meta.label) + '</div>' +
          '<div class="md-timeline-meta">' + fmtDate(s.starts_at) + ' ~ ' + fmtDate(s.ends_at) + '</div>' +
        '</div>';
      wrap.appendChild(item);
    }
  }

  function renderStage(stage) {
    resetBottomBar();
    if (stage.vote_mode === 'score' && stage.stage_type !== 'nomination') {
      renderScoreVoting(stage);
      return;
    }
    switch (stage.stage_type) {
      case 'nomination': renderNomination(stage); break;
      case 'qualifier': renderVoting(stage); break;
      case 'group_vote': renderGroupVote(stage); break;
      case 'final': renderFinal(stage); break;
      default: renderEmpty('未知阶段类型');
    }
  }

  // ==================== Nomination ====================
  function renderNomination(stage) {
    // 提名需登录：免登录分享模式仅覆盖投票阶段
    if (STATE.guestMode || STATE.authenticated === false) {
      $('mdMainPanel').innerHTML =
        '<div class="md-empty">' +
          '<p style="font-weight:600;">提名需要登录后参与</p>' +
          '<p style="color:var(--muted);font-size:13px;margin:6px 0 14px;">免登录分享链接仅用于投票阶段，登录后即可提名作品</p>' +
          '<a class="md-btn md-btn--primary" href="../login.html">登录 / 注册</a>' +
        '</div>';
      return;
    }
    var maxNoms = Number(stage.max_select) || 1;
    $('mdMainPanel').innerHTML =
      '<div class="md-action">' +
        '<div class="md-action-hint">每人可提名 <strong>' + maxNoms + '</strong> 个作品 · 已提名 <strong id="mdNomCount">0</strong> 个</div>' +
        '<div class="md-search-row">' +
          '<input class="md-input" id="mdNomSearch" placeholder="搜索作品名，如 沙耶の唄" autocomplete="off">' +
          '<button class="md-btn md-btn--primary" id="mdNomBtn">搜索</button>' +
        '</div>' +
      '</div>' +
      '<div class="md-nom-list" id="mdSearchResults" style="display:none;"></div>' +
      '<h3 class="md-section-title">我的提名</h3>' +
      '<div class="md-nom-list" id="mdNomList"><div class="md-nom-empty">尚未提名，请搜索并提交作品</div></div>';

    loadMyNominations(stage);

    $('mdNomBtn').addEventListener('click', function () { doSearch(stage); });
    $('mdNomSearch').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doSearch(stage);
    });
  }

  function doSearch(stage) {
    var q = $('mdNomSearch').value.trim();
    if (!q) { toast('请输入作品名'); return; }
    searchAndNominate(q, stage);
  }

  function loadMyNominations(stage) {
    return api('../api/twelve_works.php?action=my_nominations&contest_id=' + STATE.project.id).then(function (data) {
      var noms = data.data || [];
      STATE.myNominations = noms;
      var list = $('mdNomList');
      var countEl = $('mdNomCount');
      if (countEl) countEl.textContent = noms.length;
      if (!list) return;
      if (!noms.length) {
        list.innerHTML = '<div class="md-nom-empty">尚未提名，请搜索并提交作品</div>';
        return;
      }
      list.innerHTML = '';
      for (var i = 0; i < noms.length; i++) {
        var n = noms[i];
        var item = document.createElement('div');
        item.className = 'md-nom-item';
        item.innerHTML =
          '<div class="md-nom-cover" style="background:' + (n.image_url ? 'url(' + esc(n.image_url) + ') center/cover' : coverGradient(i)) + '"></div>' +
          '<div class="md-nom-info">' +
            '<div class="md-nom-name">' + esc(n.title) + '</div>' +
            '<div class="md-nom-meta">' + esc(n.subtitle || '') + '</div>' +
          '</div>' +
          '<span class="md-nom-status ' + (n.entry_status === 'approved' ? 'approved' : 'pending') + '">' + esc(n.entry_status === 'approved' ? '已通过' : '待审核') + '</span>' +
          '<button class="md-nom-remove" data-entry-id="' + Number(n.entry_id) + '" title="撤销提名">×</button>';
        list.appendChild(item);
      }
      list.querySelectorAll('.md-nom-remove').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var entryId = this.getAttribute('data-entry-id');
          if (!entryId || !confirm('确定撤销该提名吗？')) return;
          post('../api/twelve_works.php?action=withdraw_nomination', { entry_id: Number(entryId), contest_id: STATE.project.id }).then(function (r) {
            if (r && r.success) { toast('已撤销提名'); loadMyNominations(STATE.currentStage); }
            else { toast((r && r.message) || '撤销失败'); }
          }).catch(function () { toast('撤销失败'); });
        });
      });
    }).catch(function () {
      var el = $('mdNomCount');
      if (el) el.textContent = '加载失败';
    });
  }

  function searchAndNominate(keyword, stage) {
    var panel = $('mdSearchResults');
    panel.style.display = '';
    panel.innerHTML = '<div class="md-nom-empty">搜索中...</div>';

    api('../api/vote_sources.php?action=search&project_type=twelve&limit=12&keyword=' + encodeURIComponent(keyword)).then(function (data) {
      var results = ((data && data.data) || []).slice(0, 12);
      if (!results.length) {
        panel.innerHTML = '<div class="md-nom-empty">未找到匹配作品，请尝试其他关键词</div>';
        return;
      }
      renderSearchResults(results, stage);
    }).catch(function () {
      panel.innerHTML = '<div class="md-nom-empty">搜索失败：网络异常或服务器未响应</div>';
    });
  }

  function renderSearchResults(results, stage) {
    var panel = $('mdSearchResults');
    var maxNoms = Number(stage.max_select) || 1;
    var currentCount = STATE.myNominations.length;
    var remaining = Math.max(0, maxNoms - currentCount);

    var html =
      '<div class="md-result-header">' +
        '<div class="md-action-hint" style="margin:0;">搜索到 <strong>' + results.length + '</strong> 个结果' + (remaining > 0 ? '（还可提名 <strong>' + remaining + '</strong> 个）' : '（已达上限）') + '</div>' +
        '<button class="md-btn md-btn--ghost" id="mdClearSearch">清除结果</button>' +
      '</div>';

    for (var i = 0; i < results.length; i++) {
      var work = results[i];
      var year = work.air_date ? String(work.air_date).slice(0, 4) : (work.subtitle && /^\d{4}/.test(work.subtitle) ? String(work.subtitle).slice(0, 4) : '');
      var sourceLabel = sourceLabelVote(work.source_type);
      html +=
        '<div class="md-nom-item search" data-idx="' + i + '">' +
          '<div class="md-nom-cover" style="background:' + (work.image_url ? 'url(' + esc(work.image_url) + ') center/cover' : coverGradient(i)) + '"></div>' +
          '<div class="md-nom-info">' +
            '<div class="md-nom-name">' + esc(work.title_cn || work.title || '') + '</div>' +
            '<div class="md-nom-meta">' + esc([sourceLabel, work.title && work.title_cn ? work.title : '', work.subtitle || year].filter(Boolean).join(' · ')) + '</div>' +
          '</div>' +
          '<span class="md-pill md-pill--brand">提名</span>' +
        '</div>';
    }
    panel.innerHTML = html;

    panel.querySelectorAll('.md-nom-item.search').forEach(function (el, idx) {
      el.addEventListener('click', function () { nominateWork(results[idx], stage); });
    });

    $('mdClearSearch').addEventListener('click', function () {
      panel.style.display = 'none';
      panel.innerHTML = '';
    });
  }

  function nominateWork(work, stage) {
    var maxNoms = Number(stage.max_select) || 1;
    if (STATE.myNominations.length >= maxNoms) { toast('已达到最大提名数（' + maxNoms + '个）'); return; }
    var payload = {
      contest_id: STATE.project.id,
      title: work.title || work.title_cn || '',
      title_cn: work.title_cn || '',
      subtitle: work.subtitle || (work.title && work.title_cn ? work.title : ''),
      source_type: work.source_type || 'manual',
      source_id: String(work.source_id || work.bangumi_id || ''),
      image_url: work.image_url || '',
      summary: work.summary || '',
      external_url: work.external_url || (work.bangumi_id ? 'https://bgm.tv/subject/' + work.bangumi_id : '')
    };
    post('../api/twelve_works.php?action=nominate', payload).then(function (r) {
      if (r && r.success) {
        toast('提名成功');
        loadMyNominations(stage);
        var panel = $('mdSearchResults');
        if (panel) panel.style.display = 'none';
      } else {
        toast((r && r.message) || '提名失败');
      }
    }).catch(function () { toast('提名提交失败'); });
  }

  // ==================== Helpers ====================
  function normalizeWork(row) {
    row.id = Number(row.entry_id || row.id);
    return row;
  }

  function loadStageWorks(stage) {
    return api('../api/twelve_rounds.php?action=stage_entries&stage_id=' + stage.id).then(function (data) {
      return ((data && data.data) || []).map(normalizeWork);
    });
  }

  function loadMyStageVotes(stage) {
    return api('../api/twelve_votes.php?action=my_votes&project_id=' + STATE.project.id).then(function (data) {
      return ((data && data.data) || []).filter(function (v) { return Number(v.stage_id) === Number(stage.id); });
    }).catch(function () { return []; });
  }

  function loadStageResults(stage) {
    return api('../api/twelve_votes.php?action=results&stage_id=' + stage.id).then(function (data) {
      var rows = (data && data.data) || [];
      var map = {};
      for (var i = 0; i < rows.length; i++) map[Number(rows[i].entry_id || rows[i].id)] = rows[i];
      STATE.resultRows = rows;
      STATE.resultMap = map;
      return data || { data: [] };
    }).catch(function (error) {
      STATE.resultRows = [];
      STATE.resultMap = {};
      return { data: [], error: error && error.message ? error.message : '结果加载失败' };
    });
  }

  function canShowVoteNumbers(stage, resultData) {
    var visibility = stage.result_visibility || (resultData && resultData.result_visibility) || 'live_rank_only';
    var status = (resultData && resultData.stage_status) || stage.status || '';
    if (visibility === 'hidden') return false;
    if (visibility === 'live_votes') return true;
    if (visibility === 'after_stage') return status === 'settled';
    if (visibility === 'after_event') return STATE.project && STATE.project.status === 'ended';
    return false;
  }

  function applyResultStats(works, rows) {
    var map = {};
    for (var i = 0; i < (rows || []).length; i++) map[Number(rows[i].entry_id || rows[i].id)] = rows[i];
    return works.map(function (work) {
      var stat = map[Number(work.id)] || {};
      work.votes = Number(stat.votes || 0);
      work.score_avg = stat.score_avg != null ? Number(stat.score_avg) : null;
      work.rank_no = stat.rank_no ? Number(stat.rank_no) : null;
      work.advanced = Number(stat.advanced || 0);
      return work;
    });
  }

  function isScoreStage(stage) { return stage && stage.vote_mode === 'score'; }
  function scoreBounds(stage) { return { min: Number(stage.score_min || 1), max: Number(stage.score_max || 10) }; }
  function selectedVoteIds() { return Object.keys(STATE.myVotes).filter(function (k) { return STATE.myVotes[k]; }); }

  // 阶段是否允许改票（stage 列或池 runtime）
  function stageAllowChange(stage) {
    if (!stage) return false;
    var v = stage.allow_vote_change;
    return v === 1 || v === true || v === '1';
  }

  // ==================== Score Voting ====================
  function renderScoreVoting(stage) {
    var maxVotes = Number(stage.max_select || 12);
    var bounds = scoreBounds(stage);
    STATE.myVotes = {};
    STATE.myScores = {};
    STATE.votingLocked = false;

    $('mdMainPanel').innerHTML =
      '<div class="md-action">' +
        '<div class="md-action-hint">选择最多 <strong>' + maxVotes + '</strong> 部作品，并为已选作品评分（' + bounds.min + '-' + bounds.max + ' 分） · 已选 <strong id="mdVoteCount">0</strong> 部</div>' +
      '</div>' +
      '<div class="md-work-grid" id="mdScoreGrid"><div class="md-loading" style="grid-column:1/-1">加载中...</div></div>';
    showBottomBar(maxVotes);

    Promise.all([loadStageWorks(stage), loadMyStageVotes(stage), loadStageResults(stage)]).then(function (results) {
      var works = results[0] || [];
      var votes = results[1] || [];
      var resultData = results[2] || {};
      var showVotes = canShowVoteNumbers(stage, resultData);
      STATE.showVotes = showVotes;
      STATE.works = applyResultStats(works, resultData.data || []);
      votes.forEach(function (vote) {
        var entryId = Number(vote.entry_id);
        STATE.myVotes[entryId] = true;
        STATE.myScores[entryId] = Number(vote.score_value || bounds.max);
      });
      STATE.votingLocked = votes.length > 0 && !stageAllowChange(stage);
      renderRankPanel(STATE.works);
      renderScoreGrid(STATE.works, maxVotes, bounds, STATE.votingLocked, showVotes);
    }).catch(function (error) {
      $('mdScoreGrid').innerHTML = '<div class="md-empty" style="grid-column:1/-1">' + esc(error && error.message ? error.message : '评分加载失败') + '</div>';
    });
  }

  function renderScoreGrid(works, maxVotes, bounds, locked, showVotes) {
    var grid = $('mdScoreGrid');
    grid.innerHTML = '';
    if (!works.length) { grid.innerHTML = '<div class="md-empty" style="grid-column:1/-1">阶段池尚未生成，请联系负责人</div>'; return; }

    works.forEach(function (work, idx) {
      var selected = !!STATE.myVotes[work.id];
      var score = Number(STATE.myScores[work.id] || bounds.max);
      var div = document.createElement('div');
      div.className = 'md-work-item' + (selected ? ' selected' : '');
      div.dataset.workId = work.id;
      div.innerHTML =
        '<div class="md-work-cover" style="background:' + (work.image_url ? 'url(' + esc(work.image_url) + ') center/cover' : coverGradient(idx)) + '">' +
          '<div class="md-work-check">' + CHECK_SVG + '</div>' +
        '</div>' +
        '<div class="md-work-name">' + esc(work.title) + '</div>' +
        '<div class="md-work-brand">' + esc(work.subtitle || '') + '</div>' +
        (showVotes ? '<div class="md-work-stats">' + (work.score_avg != null ? '均分 ' + work.score_avg.toFixed(2) : '暂无均分') + ' · ' + Number(work.votes || 0) + '票' + (work.rank_no ? ' · #' + work.rank_no : '') + '</div>' : '') +
        '<div class="md-score-panel" data-score-panel="' + work.id + '" style="display:' + (selected ? 'block' : 'none') + '">' +
          '<label>评分 <input class="md-score-input" type="number" min="' + bounds.min + '" max="' + bounds.max + '" step="1" value="' + score + '" data-score-entry="' + work.id + '"></label>' +
        '</div>';
      div.addEventListener('click', function (event) {
        if (locked || event.target.closest('[data-score-entry]')) return;
        toggleScoreSelection(work.id, div, maxVotes, bounds);
      });
      grid.appendChild(div);
    });

    grid.querySelectorAll('[data-score-entry]').forEach(function (input) {
      input.addEventListener('input', function () {
        var entryId = Number(this.dataset.scoreEntry);
        var value = Math.max(bounds.min, Math.min(bounds.max, Number(this.value || bounds.min)));
        STATE.myScores[entryId] = value;
        updateBottomBar(selectedVoteIds().length, maxVotes);
      });
    });
    updateVoteCount(maxVotes);
    updateScorePanels(bounds);
    if (locked) lockSubmit();
  }

  function toggleScoreSelection(workId, el, maxVotes, bounds) {
    var count = selectedVoteIds().length;
    if (STATE.myVotes[workId]) {
      STATE.myVotes[workId] = false;
      delete STATE.myScores[workId];
      el.classList.remove('selected');
    } else if (count < maxVotes) {
      STATE.myVotes[workId] = true;
      STATE.myScores[workId] = Number(STATE.myScores[workId] || bounds.max);
      el.classList.add('selected');
    }
    updateVoteCount(maxVotes);
    updateGridDimmed('mdScoreGrid', maxVotes);
    updateScorePanels(bounds);
  }

  function updateScorePanels(bounds) {
    document.querySelectorAll('[data-score-panel]').forEach(function (panel) {
      var entryId = Number(panel.dataset.scorePanel);
      panel.style.display = STATE.myVotes[entryId] ? 'block' : 'none';
      var input = panel.querySelector('[data-score-entry]');
      if (input && STATE.myVotes[entryId]) {
        input.value = String(Math.max(bounds.min, Math.min(bounds.max, Number(STATE.myScores[entryId] || bounds.max))));
      }
    });
  }

  // ==================== Voting ====================
  function renderVoting(stage) {
    var maxVotes = Number(stage.max_select || 12);
    STATE.myVotes = {};

    $('mdMainPanel').innerHTML =
      '<div class="md-action">' +
        '<div class="md-action-hint">每人可选 <strong>' + maxVotes + '</strong> 部 · 已选 <strong id="mdVoteCount">0</strong> 部</div>' +
      '</div>' +
      '<div class="md-work-grid" id="mdVoteGrid"><div class="md-loading" style="grid-column:1/-1">加载中...</div></div>';
    showBottomBar(maxVotes);

    Promise.all([loadStageWorks(stage), loadMyStageVotes(stage), loadStageResults(stage)]).then(function (results) {
      var works = results[0] || [];
      var votes = results[1] || [];
      var resultData = results[2] || {};
      var showVotes = canShowVoteNumbers(stage, resultData);
      STATE.showVotes = showVotes;
      STATE.works = applyResultStats(works, resultData.data || []);
      votes.forEach(function (v) { STATE.myVotes[Number(v.entry_id)] = true; });
      STATE.votingLocked = votes.length > 0 && !stageAllowChange(stage);
      renderRankPanel(STATE.works);
      renderWorkGrid(STATE.works, maxVotes, 'mdVoteGrid', 'md-work-grid', stage, STATE.votingLocked, showVotes);
    });
  }

  function renderWorkGrid(works, maxVotes, gridId, gridClass, stage, locked, showVotes) {
    var grid = $(gridId);
    grid.className = gridClass;
    grid.innerHTML = '';
    if (!works.length) { grid.innerHTML = '<div class="md-empty" style="grid-column:1/-1">阶段池尚未生成，请联系负责人</div>'; return; }

    works.forEach(function (work, idx) {
      var div = document.createElement('div');
      div.className = 'md-work-item' + (STATE.myVotes[work.id] ? ' selected' : '');
      div.dataset.workId = work.id;
      div.innerHTML =
        '<div class="md-work-cover" style="background:' + (work.image_url ? 'url(' + esc(work.image_url) + ') center/cover' : coverGradient(idx)) + '">' +
          '<div class="md-work-check">' + CHECK_SVG + '</div>' +
        '</div>' +
        '<div class="md-work-name">' + esc(work.title) + '</div>' +
        '<div class="md-work-brand">' + esc(work.subtitle || '') + '</div>' +
        (showVotes ? '<div class="md-work-stats">' + Number(work.votes || 0) + '票' + (work.rank_no ? ' · #' + work.rank_no : '') + '</div>' : '');
      div.addEventListener('click', function () {
        if (locked) return;
        toggleWorkSelection(work.id, div, maxVotes, gridId);
      });
      grid.appendChild(div);
    });
    updateVoteCount(maxVotes);
    updateGridDimmed(gridId, maxVotes);
    if (locked) lockSubmit();
  }

  function toggleWorkSelection(workId, el, maxVotes, gridId) {
    if (STATE.myVotes[workId]) {
      STATE.myVotes[workId] = false;
      el.classList.remove('selected');
    } else if (selectedVoteIds().length < maxVotes) {
      STATE.myVotes[workId] = true;
      el.classList.add('selected');
    }
    updateVoteCount(maxVotes);
    updateGridDimmed(gridId, maxVotes);
  }

  function updateVoteCount(maxVotes) {
    var count = selectedVoteIds().length;
    var el = $('mdVoteCount');
    if (el) el.textContent = count;
    updateBottomBar(count, maxVotes);
  }

  function updateGridDimmed(gridId, maxVotes) {
    var grid = $(gridId);
    if (!grid) return;
    var count = selectedVoteIds().length;
    grid.querySelectorAll('.md-work-item').forEach(function (item) {
      item.classList.toggle('dimmed', count >= maxVotes && !item.classList.contains('selected'));
    });
  }

  function showBottomBar(maxVotes) {
    $('mdBottomBar').style.display = 'flex';
    updateBottomBar(0, maxVotes);
  }

  function resetBottomBar() {
    var bar = $('mdBottomBar');
    var btn = $('mdBottomSubmit');
    if (bar) bar.style.display = 'none';
    if (btn) {
      btn.disabled = false;
      btn.textContent = '提交投票';
      btn.className = 'md-btn md-btn--primary';
      btn.style.background = '';
      btn.style.borderColor = '';
      btn.style.color = '';
      btn.style.boxShadow = '';
    }
    var main = $('mdMainPanel');
    if (main) main.classList.remove('md-panel--final');
  }

  function lockSubmit() {
    var btn = $('mdBottomSubmit');
    if (btn) { btn.disabled = true; btn.textContent = '已投票'; }
  }

  function updateBottomBar(count, maxVotes) {
    var hint = $('mdBottomHint');
    var btn = $('mdBottomSubmit');
    if (hint) hint.innerHTML = '已选 <strong>' + count + '</strong> / ' + maxVotes;
    if (btn) {
      btn.disabled = count === 0;
      btn.style.opacity = count === 0 ? '0.5' : '1';
    }
  }

  // ==================== Group Vote ====================
  function renderGroupVote(stage) {
    var maxVotes = Number(stage.max_select || 12);
    var groupCount = Number(stage.group_count || 4);
    STATE.myVotes = {};
    STATE.votingLocked = false;
    STATE.currentGroup = 0;

    $('mdMainPanel').innerHTML =
      '<div class="md-group-tabs" id="mdGroupTabs"></div>' +
      '<div class="md-action" style="padding-top:0;">' +
        '<div class="md-action-hint" id="mdGroupHint"></div>' +
      '</div>' +
      '<div class="md-group-grid" id="mdGroupGrid"><div class="md-loading" style="grid-column:1/-1">加载中...</div></div>';
    showBottomBar(maxVotes);

    Promise.all([loadStageWorks(stage), loadMyStageVotes(stage), loadStageResults(stage)]).then(function (results) {
      var works = results[0] || [];
      var votes = results[1] || [];
      var resultData = results[2] || {};
      var showVotes = canShowVoteNumbers(stage, resultData);
      works = applyResultStats(works, resultData.data || []);
      STATE.works = works;
      STATE.showVotes = showVotes;
      votes.forEach(function (v) { STATE.myVotes[Number(v.entry_id)] = true; });
      STATE.votingLocked = votes.length > 0 && !stageAllowChange(stage);
      STATE.groups = groupWorksByKey(works, groupCount);
      renderRankPanel(works);
      renderGroupTabs(maxVotes);
      if (!STATE.groups.length) {
        $('mdGroupGrid').innerHTML = '<div class="md-empty" style="grid-column:1/-1">暂无候选作品</div>';
        return;
      }
      renderGroupGrid(STATE.groups[0], maxVotes, showVotes);
      if (STATE.votingLocked) lockSubmit();
    });
  }

  function groupWorksByKey(works, groupCount) {
    var index = {};
    var groups = [];
    works.forEach(function (w, i) {
      var key = w.group_key || ('G' + ((i % Math.max(1, groupCount)) + 1));
      if (!index[key]) {
        index[key] = [];
        groups.push(index[key]);
      }
      index[key].push(w);
    });
    return groups;
  }

  function renderGroupTabs(maxVotes) {
    var tabs = $('mdGroupTabs');
    tabs.innerHTML = '';
    STATE.groups.forEach(function (_, idx) {
      var tab = document.createElement('span');
      tab.className = 'md-group-tab' + (idx === STATE.currentGroup ? ' active' : '');
      tab.textContent = '第' + (idx + 1) + '组';
      tab.addEventListener('click', function () {
        STATE.currentGroup = idx;
        tabs.querySelectorAll('.md-group-tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        renderGroupGrid(STATE.groups[idx], maxVotes, STATE.showVotes);
      });
      tabs.appendChild(tab);
    });
  }

  function renderGroupGrid(groupWorks, maxVotes, showVotes) {
    var grid = $('mdGroupGrid');
    var hint = $('mdGroupHint');
    var count = selectedVoteIds().length;
    if (hint) hint.innerHTML = '第' + (STATE.currentGroup + 1) + '组 · 总计已选 <strong>' + count + '</strong> / ' + maxVotes + ' 部';

    grid.innerHTML = '';
    if (!groupWorks.length) { grid.innerHTML = '<div class="md-empty" style="grid-column:1/-1">该组暂无作品</div>'; return; }

    groupWorks.forEach(function (work, idx) {
      var div = document.createElement('div');
      div.className = 'md-work-item' + (STATE.myVotes[work.id] ? ' selected' : '');
      div.dataset.workId = work.id;
      div.innerHTML =
        '<div class="md-work-cover" style="background:' + (work.image_url ? 'url(' + esc(work.image_url) + ') center/cover' : coverGradient(STATE.currentGroup * groupWorks.length + idx)) + '">' +
          '<div class="md-work-check">' + CHECK_SVG + '</div>' +
        '</div>' +
        '<div class="md-work-name">' + esc(work.title) + '</div>' +
        '<div class="md-work-brand">' + esc(work.subtitle || '') + '</div>' +
        (showVotes ? '<div class="md-work-stats">' + Number(work.votes || 0) + '票' + (work.rank_no ? ' · #' + work.rank_no : '') + '</div>' : '');
      div.addEventListener('click', function () { toggleGroupSelection(work.id, div, maxVotes); });
      grid.appendChild(div);
    });
    updateGroupDimmed(maxVotes);
  }

  function toggleGroupSelection(workId, el, maxVotes) {
    if (STATE.votingLocked) return;
    var count = selectedVoteIds().length;
    if (STATE.myVotes[workId]) {
      STATE.myVotes[workId] = false;
      el.classList.remove('selected');
    } else if (count < maxVotes) {
      STATE.myVotes[workId] = true;
      el.classList.add('selected');
    }
    var newCount = selectedVoteIds().length;
    var hint = $('mdGroupHint');
    if (hint) hint.innerHTML = '第' + (STATE.currentGroup + 1) + '组 · 总计已选 <strong>' + newCount + '</strong> / ' + maxVotes + ' 部';
    updateBottomBar(newCount, maxVotes);
    updateGroupDimmed(maxVotes);
  }

  function updateGroupDimmed(maxVotes) {
    var grid = $('mdGroupGrid');
    if (!grid) return;
    var count = selectedVoteIds().length;
    grid.querySelectorAll('.md-work-item').forEach(function (item) {
      item.classList.toggle('dimmed', count >= maxVotes && !item.classList.contains('selected'));
    });
  }

  // ==================== Final ====================
  function renderFinal(stage) {
    var maxVotes = Number(stage.max_select || 12);
    STATE.myVotes = {};

    var main = $('mdMainPanel');
    main.classList.add('md-panel--final');
    main.innerHTML =
      '<div class="md-action">' +
        '<div class="md-action-hint">选出你心中最优秀的 <strong>' + maxVotes + '</strong> 部作品 · 已选 <strong id="mdVoteCount">0</strong> 部</div>' +
      '</div>' +
      '<div class="md-work-grid" id="mdFinalGrid"><div class="md-loading" style="grid-column:1/-1">加载中...</div></div>';

    var btn = $('mdBottomSubmit');
    if (btn) {
      btn.className = 'md-btn md-btn--primary';
      btn.style.background = 'var(--gold)';
      btn.style.borderColor = 'var(--gold)';
      btn.style.color = '#fff';
      btn.style.boxShadow = '0 4px 14px rgba(199,147,43,0.25)';
    }
    showBottomBar(maxVotes);

    Promise.all([loadStageWorks(stage), loadMyStageVotes(stage), loadStageResults(stage)]).then(function (results) {
      var works = results[0] || [];
      var votes = results[1] || [];
      var resultData = results[2] || {};
      var showVotes = canShowVoteNumbers(stage, resultData);
      STATE.showVotes = showVotes;
      STATE.works = applyResultStats(works, resultData.data || []);
      votes.forEach(function (v) { STATE.myVotes[Number(v.entry_id)] = true; });
      renderRankPanel(STATE.works);
      renderWorkGrid(STATE.works, maxVotes, 'mdFinalGrid', 'md-work-grid', stage, votes.length > 0, showVotes);
    });
  }

  // ==================== Rank Panel ====================
  function renderRankPanel(works) {
    var panel = $('mdRankPanel');
    var list = $('mdRankList');
    // 票数指标未公开（result_visibility 裁剪）时不渲染，避免误导性的“0票”
    if (STATE.showVotes === false) { panel.style.display = 'none'; return; }
    var ranked = works.filter(function (w) { return w.rank_no; }).sort(function (a, b) { return (a.rank_no || 9999) - (b.rank_no || 9999); }).slice(0, 5);
    if (!ranked.length) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    list.innerHTML = '';
    ranked.forEach(function (w) {
      var row = document.createElement('div');
      row.className = 'md-rank-item';
      row.innerHTML =
        '<div class="md-rank-pos">#' + Number(w.rank_no) + '</div>' +
        '<div class="md-rank-cover" style="background:' + (w.image_url ? 'url(' + esc(w.image_url) + ') center/cover' : 'var(--line)') + '"></div>' +
        '<div class="md-rank-info">' +
          '<div class="md-rank-title">' + esc(w.title) + '</div>' +
          '<div class="md-rank-meta">' + Number(w.votes || 0) + '票' + (w.score_avg != null ? ' · 均分 ' + w.score_avg.toFixed(2) : '') + '</div>' +
        '</div>';
      list.appendChild(row);
    });
  }

  // ==================== Submit ====================
  function bindSubmit() {
    var btn = $('mdBottomSubmit');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var stage = STATE.currentStage;
      if (!stage) return;
      var selectedIds = selectedVoteIds().map(Number);
      if (!selectedIds.length) { toast('请至少选择一个作品'); return; }

      var payload = { stage_id: Number(stage.id), entry_ids: selectedIds };
      if (isScoreStage(stage)) {
        var bounds = scoreBounds(stage);
        var scores = {};
        for (var i = 0; i < selectedIds.length; i++) {
          var entryId = selectedIds[i];
          var score = Number(STATE.myScores[entryId] || 0);
          if (score < bounds.min || score > bounds.max) {
            toast('请为已选作品填写 ' + bounds.min + '-' + bounds.max + ' 分');
            return;
          }
          scores[entryId] = score;
        }
        payload.scores = scores;
      }

      if (STATE.shareToken) payload.share = STATE.shareToken;

      // 提交期间禁用按钮，防重复点击造成重复提交
      btn.disabled = true;
      post('../api/twelve_votes.php?action=cast', payload).then(function (r) {
        if (r && r.success) {
          if (stageAllowChange(stage)) {
            btn.disabled = false;
            btn.textContent = '修改投票';
            toast('投票成功，可再次修改');
          } else {
            toast('投票成功');
            lockSubmit();
          }
        } else {
          btn.disabled = false;
          toast((r && r.message) || '投票失败');
        }
      }).catch(function (error) {
        btn.disabled = false;
        toast(error && error.message ? error.message : '投票提交失败');
      });
    });
  }

  // ==================== Results ====================
  function renderStageResults(stage) {
    var panel = $('mdMainPanel');
    $('mdBottomBar').style.display = 'none';
    panel.innerHTML = '<div class="md-loading">加载结果中...</div>';
    loadStageResults(stage).then(function (data) {
      var rows = (data && data.data) || [];
      var showVotes = canShowVoteNumbers(stage, data);
      if (!rows.length) { panel.innerHTML = '<div class="md-empty">暂无结算结果</div>'; return; }
      var title = stage.stage_type === 'final' ? '最终十二器排行榜' : '阶段结果';
      if (stage.stage_type === 'final') rows = rows.slice(0, 12);
      renderRankPanel(rows.map(function (r) { return Object.assign({ id: Number(r.entry_id || r.id) }, r); }));

      var html =
        '<div class="md-result-header">' +
          '<h2 class="md-result-title">' + title + '</h2>' +
        '</div>' +
        '<div class="md-result-grid">';
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var rank = Number(row.rank_no || i + 1);
        html +=
          '<div class="md-work-item selected">' +
            '<div class="md-work-cover" style="background:' + (row.image_url ? 'url(' + esc(row.image_url) + ') center/cover' : coverGradient(i)) + '">' +
              '<div class="md-work-check">' + rank + '</div>' +
            '</div>' +
            '<div class="md-work-name">' + esc(row.title_cn || row.title || '?') + '</div>' +
            '<div class="md-work-brand">#' + rank + (showVotes ? ' · ' + (row.score_avg != null ? '均分 ' + Number(row.score_avg).toFixed(2) + ' · ' : '') + Number(row.votes || 0) + '票' : '') + '</div>' +
          '</div>';
      }
      html += '</div>';
      panel.innerHTML = html;
    });
  }

  init();
})();
