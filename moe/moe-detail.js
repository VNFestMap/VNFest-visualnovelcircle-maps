(function () {
  'use strict';
  var $ = $vote, esc = escVote, api = apiVote, post = postVote, toast = function (m) { toastVote($('toast'), m); };

  var STAGE_META = {
    nomination:  { label: '提名阶段', color: 'nomination' },
    qualifier:   { label: '资格赛', color: 'pool' },
    group_vote:  { label: '海选投票', color: 'pool' },
    bracket:     { label: '淘汰赛', color: 'bracket' },
    final:       { label: '决赛', color: 'final' }
  };

  var AVATAR_GRADIENTS = [
    'linear-gradient(135deg,#fce4ec,#f8bbd0)', 'linear-gradient(135deg,#ede9fe,#d8cef8)',
    'linear-gradient(135deg,#fefce8,#fef08a)', 'linear-gradient(135deg,#f1f5f9,#e2e8f0)',
    'linear-gradient(135deg,#e8f5e9,#c8e6c9)', 'linear-gradient(135deg,#fff3e0,#ffe0b2)',
    'linear-gradient(135deg,#f3e5f5,#e1bee7)', 'linear-gradient(135deg,#e0f2f1,#b2dfdb)'
  ];

  var CHECK_SVG = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="3"><polyline points="3,8 7,12 13,4"/></svg>';

  var STATE = {
    project: null,
    stages: [],
    currentStage: null,
    entries: [],
    matches: [],
    allMatches: [],
    myVotes: {},
    myScores: {},
    myNominations: [],
    groups: [],
    currentGroup: 0,
    resultRows: [],
    resultMap: {},
    runtime: null,
    rankVisible: false,
    metricsVisible: false,
    voteLocked: false,
    preVotedCurrentRound: false,
    countdownTimer: null,
    bracketSize: 0,
    showVotes: false,
    shareToken: '',
    guestMode: false,
    authenticated: true
  };

  var SELECT_MODE = false;
  var SELECTED_ENTRIES = new Set();

  function avatarGradient(idx) { return AVATAR_GRADIENTS[idx % 8]; }

  function fmtDate(s) {
    if (!s) return '-';
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // 提名接口历史上同时出现过 entry_id 和 id，统一成稳定的字符串键，
  // 这样候选列表和本人提名列表在数字/字符串混用时仍能正确匹配。
  function entryIdOf(row) {
    if (!row) return '';
    var value = row.entry_id != null ? row.entry_id : row.id;
    if (value == null || value === '') return '';
    var numeric = Number(value);
    return isNaN(numeric) ? String(value) : String(numeric);
  }

  function init() {
    ensureClubNamesLoaded();
    var params = new URLSearchParams(window.location.search);
    var id = params.get('id');
    STATE.shareToken = params.get('share') || '';
    if (!id) { renderEmpty('缺少活动ID'); return; }
    loadProject(id);
  }

  function renderEmpty(message) {
    $('mdMainPanel').innerHTML = '<div class="md-empty">' + esc(message || '暂无内容') + '</div>';
    $('mdStatusBadge').textContent = '-';
  }

  // 免登录参与模式：未登录访客持有效分享链接 + 企划开启 guest_vote 且无参与资格。
  function applyGuestMode(data) {
    STATE.guestMode = false;
    STATE.authenticated = !!data.authenticated;
    var banner = $('mdGuestBanner');
    if (!banner) return;
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
    var getUrl = '../api/moe_contests.php?action=get&project_id=' + encodeURIComponent(projectId);
    if (STATE.shareToken) getUrl += '&share=' + encodeURIComponent(STATE.shareToken);
    api(getUrl).then(function (data) {
      if (!data || !data.data) { renderEmpty('活动不存在'); return; }
      STATE.project = data.data;
      applyGuestMode(data);
      $('mdContestTitle').textContent = data.data.title;
      $('mdInfoClub').textContent = resolveClubName(data.data.club_id, data.data.country);
      $('mdInfoLaunch').textContent = fmtDate(data.data.published_at);
      var bracketLink = $('mdBracketLink');
      if (bracketLink) {
        bracketLink.href = 'bracket.html?project_id=' + encodeURIComponent(projectId);
        bracketLink.style.display = 'inline-flex';
      }
      loadStages(projectId);
    }).catch(function () {
      renderEmpty('加载失败，请刷新重试');
    });
  }

  function loadStages(projectId) {
    api('../api/moe_stages.php?action=list&project_id=' + projectId).then(function (data) {
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
    var meta = STAGE_META[stage.stage_type] || { label: stage.stage_type };
    $('mdInfoStage').textContent = meta.label;
    $('mdInfoStart').textContent = fmtDate(stage.starts_at);
    $('mdInfoEnd').textContent = fmtDate(stage.ends_at);
    startCountdown(stage.ends_at);

    var chips = document.querySelectorAll('.md-stage-chip');
    for (var i = 0; i < chips.length; i++) {
      var isActive = Number(chips[i].dataset.stageId) === Number(stage.id);
      chips[i].classList.toggle('active', isActive);
      if (isActive) chips[i].setAttribute('aria-current', 'step');
      else chips[i].removeAttribute('aria-current');
      var step = chips[i].closest('.md-stage-step');
      if (step) step.classList.toggle('is-active', isActive);
    }
  }

  function updateStatusBadge(text) {
    var badge = $('mdStatusBadge');
    if (!badge) return;
    badge.textContent = text;
    if (text === '进行中') {
      badge.style.background = 'var(--moe-bg)';
      badge.style.color = 'var(--moe)';
      badge.style.borderColor = 'var(--moe)';
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
    var endMs = endTime ? new Date(endTime).getTime() : NaN;
    if (isNaN(endMs)) { el.textContent = '--天 --:--:--'; return; }
    function tick() {
      var diff = endMs - Date.now();
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
      var step = document.createElement('li');
      step.className = 'md-stage-step' +
        (s.status === 'settled' || s.status === 'reviewing' ? ' is-settled' : '') +
        (s.status === 'open' ? ' is-open' : '') +
        (s.status === 'pending' || s.status === 'locked' ? ' is-pending' : '');
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'md-stage-chip' + (s.status === 'settled' || s.status === 'reviewing' ? ' settled' : '');
      chip.dataset.stageId = String(s.id);
      chip.setAttribute('aria-label', meta.label);
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
      step.appendChild(chip);
      list.appendChild(step);
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
    resetSelectBar();
    switch (stage.stage_type) {
      case 'nomination': renderNomination(stage); break;
      case 'qualifier':
      case 'group_vote':
        if (stage.vote_mode === 'score') renderScoreVoting(stage);
        else renderVoting(stage);
        break;
      case 'bracket': renderBracket(stage); break;
      case 'final': renderFinal(stage); break;
      default: renderEmpty('未知阶段类型');
    }
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
      btn.style.opacity = '';
      btn.onclick = null;
    }
    var main = $('mdMainPanel');
    if (main) main.classList.remove('md-panel--final');
  }

  function resetSelectBar() {
    SELECT_MODE = false;
    SELECTED_ENTRIES.clear();
    var bar = $('mdSelectBar');
    if (bar) bar.style.display = 'none';
    document.body.classList.remove('md-select-mode');
  }

  function showBottomBar() {
    var bar = $('mdBottomBar');
    if (bar) bar.style.display = 'flex';
  }

  // ==================== Nomination ====================
  function renderNomination(stage) {
    // 提名需登录：免登录分享模式仅覆盖投票阶段，未登录访客展示引导而非可交互表单
    if (STATE.guestMode || STATE.authenticated === false) {
      $('mdMainPanel').innerHTML =
        '<div class="md-empty">' +
          '<p style="font-weight:600;">提名需要登录后参与</p>' +
          '<p style="color:var(--muted);font-size:13px;margin:6px 0 14px;">免登录分享链接仅用于投票阶段，登录后即可提名角色</p>' +
          '<a class="md-btn md-btn--primary" href="../login.html">登录 / 注册</a>' +
        '</div>';
      return;
    }
    var maxNoms = Number(stage.max_select) || 3;
    $('mdMainPanel').innerHTML =
      '<div class="md-action">' +
        '<div class="md-action-hint">每人可提名 <strong>' + maxNoms + '</strong> 个角色 · 已提名 <strong id="mdNomCount">0</strong> 个</div>' +
        '<div class="md-search-row">' +
          '<input class="md-input" id="mdNomSearch" placeholder="搜索角色名称..." autocomplete="off">' +
          '<button type="button" class="md-btn md-btn--primary" id="mdNomBtn">搜索并提名</button>' +
        '</div>' +
        '<div class="md-search-row" style="margin-top:10px;">' +
          '<button type="button" class="md-btn md-btn--ghost" id="mdNomSelectBtn" aria-pressed="false">选择模式</button>' +
        '</div>' +
      '</div>' +
      '<div class="md-char-grid" id="mdNomGrid"><div class="md-loading" style="grid-column:1/-1">加载中...</div></div>';

    loadMyMoNominations(stage).then(function () {
      return api('../api/moe_candidates.php?action=list&contest_id=' + STATE.project.id);
    }).then(function (data) {
      STATE.entries = (data && data.data) || [];
      renderNomGrid(STATE.entries, maxNoms);
    }).catch(function () {
      $('mdNomGrid').innerHTML = '<div class="md-empty" style="grid-column:1/-1">加载失败</div>';
    });

    var grid = $('mdNomGrid');
    grid.onclick = function (ev) {
      var target = ev.target;
      var remove = target && target.closest ? target.closest('.md-char-remove') : null;
      if (!SELECT_MODE && remove && grid.contains(remove)) {
        var entryId = remove.getAttribute('data-entry-id');
        if (!entryId) return;
        if (!confirm('确定撤销对该角色的提名吗？')) return;
        remove.style.opacity = '0.3';
        remove.style.pointerEvents = 'none';
        post('../api/moe_candidates.php?action=withdraw_nomination', { entry_id: Number(entryId) }).then(function (r) {
          remove.style.opacity = '';
          remove.style.pointerEvents = '';
          if (r && r.success) {
            toast('已撤销提名');
            reloadNominations(stage, maxNoms);
          } else {
            toast((r && r.message) || '撤销失败');
          }
        }).catch(function () {
          remove.style.opacity = '';
          remove.style.pointerEvents = '';
          toast('撤销失败');
        });
        return;
      }
      if (!SELECT_MODE) return;
      var item = target && target.closest ? target.closest('[data-selectable="true"]') : null;
      if (!item || !grid.contains(item)) return;
      toggleNominationSelection(item);
    };
    grid.onkeydown = function (ev) {
      if (!SELECT_MODE || (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar')) return;
      var item = ev.target && ev.target.closest ? ev.target.closest('[data-selectable="true"]') : null;
      if (!item || !grid.contains(item)) return;
      ev.preventDefault();
      toggleNominationSelection(item);
    };

    $('mdNomBtn').addEventListener('click', function () { doSearch(stage); });
    $('mdNomSearch').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doSearch(stage);
    });
    $('mdNomSelectBtn').addEventListener('click', function () { toggleSelectMode(stage, maxNoms); });
  }

  function reloadNominations(stage, maxNoms) {
    loadMyMoNominations(stage).then(function () {
      return api('../api/moe_candidates.php?action=list&contest_id=' + STATE.project.id);
    }).then(function (data) {
      STATE.entries = (data && data.data) || [];
      var q = $('mdNomSearch').value.trim().toLowerCase();
      var filtered = q ? STATE.entries.filter(function (e) {
        return (e.title || '').toLowerCase().indexOf(q) !== -1 ||
               (e.title_cn || '').toLowerCase().indexOf(q) !== -1;
      }) : STATE.entries;
      renderNomGrid(filtered, maxNoms);
    });
  }

  function loadMyMoNominations(stage) {
    return api('../api/moe_candidates.php?action=my_nominations&contest_id=' + STATE.project.id).then(function (data) {
      var noms = (data && data.data) || [];
      STATE.myNominations = noms;
      var countEl = $('mdNomCount');
      if (countEl) countEl.textContent = noms.length;
    }).catch(function () {
      var countEl = $('mdNomCount');
      if (countEl) countEl.textContent = '加载失败';
    });
  }

  function doSearch(stage) {
    var q = $('mdNomSearch').value.trim();
    var maxNoms = Number(stage.max_select) || 3;
    if (!q) { toast('请输入角色名称'); return; }
    searchMoCharacter(q, stage, maxNoms);
  }

  function searchMoCharacter(keyword, stage, maxNoms) {
    var grid = $('mdNomGrid');
    if (grid) grid.innerHTML = '<div class="md-loading" style="grid-column:1/-1">搜索中...</div>';
    var btn = $('mdNomBtn');
    if (btn) {
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.innerHTML = '<span class="md-inline-spinner" aria-hidden="true"></span><span>搜索中...</span>';
    }

    api('../api/vote_sources.php?action=search&project_type=moe&keyword=' + encodeURIComponent(keyword)).then(function (data) {
      var results = (data && data.data) || [];
      // 过滤掉手动提名项
      results = results.filter(function(r) { return r.source_type !== 'manual'; });
      if (!results.length) {
        if (grid) grid.innerHTML = '<div class="md-empty" style="grid-column:1/-1">未找到匹配角色</div>';
        return;
      }
      if (grid) {
        grid.innerHTML = '';
        for (var i = 0; i < Math.min(results.length, 12); i++) {
          (function (item, idx) {
            var div = document.createElement('div');
            div.className = 'md-char-item md-char-search-result';
            div.innerHTML =
              '<div class="md-char-avatar" style="background-image:' + (item.image_url ? 'url(' + esc(item.image_url) + ')' : avatarGradient(idx)) + '">' +
                '<div class="md-char-check">' + CHECK_SVG + '</div>' +
              '</div>' +
              '<div class="md-char-name">' + esc(item.title_cn || item.title || '?') + '</div>' +
              '<div class="md-char-work">' + esc(item.subtitle || '') + '</div>';
            div.addEventListener('click', function () {
              div.classList.add('md-char-item--loading');
              nominateMoCharacter(item, stage, maxNoms, div);
            });
            grid.appendChild(div);
          })(results[i], i);
        }
      }
    }).catch(function () {
      if (grid) grid.innerHTML = '<div class="md-empty" style="grid-column:1/-1">搜索失败，请重试</div>';
    }).then(function () {
      if (btn) {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        btn.textContent = '搜索并提名';
      }
    });
  }

  function nominateMoCharacter(item, stage, maxNoms, cardEl) {
    var currentCount = STATE.myNominations.length;
    if (currentCount >= maxNoms) { toast('已达到最大提名数（' + maxNoms + '个）'); return; }

    function cleanupCard() { if (cardEl) cardEl.classList.remove('md-char-item--loading'); }

    function resolveImage() {
      // image_url 已存在直接用
      if (item.image_url) return Promise.resolve(item.image_url);
      // Bangumi 角色可以补拉详情获取图片
      if (item.source_type === 'bangumi_character' && item.source_id) {
        return api('../api/bangumi_proxy.php?action=get_character&id=' + item.source_id).then(function (data) {
          if (data && data.data && data.data.images) {
            var imgs = data.data.images;
            var raw = imgs.medium || imgs.large || imgs.small || imgs.grid || '';
            if (raw) return raw;
          }
          return '';
        });
      }
      return Promise.resolve('');
    }

    resolveImage().then(function (imageUrl) {
      var payload = {
        project_id: STATE.project.id,
        contest_id: STATE.project.id,
        stage_id: stage.id,
        title: item.title_cn || item.title || '',
        title_cn: item.title || '',
        subtitle: item.subtitle || '',
        image_url: imageUrl,
        source_type: item.source_type || 'manual',
        source_id: String(item.source_id || '')
      };
      return post('../api/moe_candidates.php?action=submit', payload);
    }).then(function (r) {
      cleanupCard();
      if (r && r.success) {
        toast('提名成功');
        $('mdNomSearch').value = '';
        reloadNominations(stage, maxNoms);
      } else {
        toast((r && r.message) || '提名失败');
      }
    }).catch(function () { cleanupCard(); toast('提名失败'); });
  }

  function toggleSelectMode(stage, maxNoms) {
    SELECT_MODE = !SELECT_MODE;
    SELECTED_ENTRIES.clear();
    var btn = $('mdNomSelectBtn');
    var bar = $('mdSelectBar');
    if (SELECT_MODE) {
      if (btn) {
        btn.type = 'button';
        btn.textContent = '取消选择';
        btn.className = 'md-btn md-btn--danger';
        btn.setAttribute('aria-pressed', 'true');
      }
      document.body.classList.add('md-select-mode');
      if (bar) bar.style.display = 'flex';
    } else {
      if (btn) {
        btn.type = 'button';
        btn.textContent = '选择模式';
        btn.className = 'md-btn md-btn--ghost';
        btn.setAttribute('aria-pressed', 'false');
      }
      document.body.classList.remove('md-select-mode');
      if (bar) bar.style.display = 'none';
    }
    var q = $('mdNomSearch').value.trim().toLowerCase();
    var filtered = q ? STATE.entries.filter(function (e) {
      return (e.title || '').toLowerCase().indexOf(q) !== -1 ||
             (e.title_cn || '').toLowerCase().indexOf(q) !== -1;
    }) : STATE.entries;
    renderNomGrid(filtered, maxNoms);
    updateSelectBar();
  }

  function toggleNominationSelection(item) {
    var eid = item && item.getAttribute('data-entry-id');
    if (!eid) return;
    if (SELECTED_ENTRIES.has(eid)) {
      SELECTED_ENTRIES.delete(eid);
      item.classList.remove('md-char-item--checked');
      item.setAttribute('aria-selected', 'false');
    } else {
      SELECTED_ENTRIES.add(eid);
      item.classList.add('md-char-item--checked');
      item.setAttribute('aria-selected', 'true');
    }
    updateSelectBar();
  }

  function updateSelectBar() {
    var hint = $('mdSelectHint');
    var btn = $('mdSelectDelete');
    var count = SELECTED_ENTRIES.size;
    if (hint) hint.textContent = '已选 ' + count + ' 个';
    if (btn) {
      btn.disabled = count === 0;
      btn.textContent = count > 0 ? '删除选中（' + count + '）' : '删除选中';
    }
  }

  function batchWithdrawNominations(stage, maxNoms) {
    if (!SELECTED_ENTRIES.size) return;
    if (!confirm('确定撤销选中的 ' + SELECTED_ENTRIES.size + ' 个提名吗？')) return;
    var ids = Array.from(SELECTED_ENTRIES).map(Number);
    var done = 0, failed = 0;
    var delBtn = $('mdSelectDelete');
    if (delBtn) { delBtn.disabled = true; delBtn.textContent = '处理中...'; }

    function withdrawNext() {
      if (done >= ids.length) {
        if (delBtn) { delBtn.disabled = false; delBtn.textContent = '删除选中'; }
        if (failed) toast('已撤销 ' + (done - failed) + ' 个，' + failed + ' 个失败');
        else toast('已撤销 ' + done + ' 个提名');
        SELECTED_ENTRIES.clear();
        toggleSelectMode(stage, maxNoms);
        reloadNominations(stage, maxNoms);
        return;
      }
      post('../api/moe_candidates.php?action=withdraw_nomination', { entry_id: ids[done] }).then(function (r) {
        if (!r || !r.success) failed++;
      }).catch(function () { failed++; }).finally(function () {
        done++;
        withdrawNext();
      });
    }
    withdrawNext();
  }

  function renderNomGrid(entries, maxNoms) {
    var grid = $('mdNomGrid');
    if (!grid) return;

    var myEntryIds = {};
    for (var ni = 0; ni < STATE.myNominations.length; ni++) {
      var nom = STATE.myNominations[ni];
      var nominationId = entryIdOf(nom);
      if (nom.status !== 'withdrawn' && nominationId) myEntryIds[nominationId] = true;
    }
    if (!entries.length || (SELECT_MODE && !Object.keys(myEntryIds).length)) {
      grid.innerHTML = '<div class="md-empty" style="grid-column:1/-1">' +
        (SELECT_MODE ? '暂无本人提名可选择' : '暂无可提名角色') +
        '</div>';
      return;
    }

    grid.innerHTML = '';
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var entryId = entryIdOf(e);
      var isMine = !!entryId && !!myEntryIds[entryId];
      var isChecked = SELECT_MODE && !!entryId && SELECTED_ENTRIES.has(entryId);
      var cls = 'md-char-item';
      if (isMine) cls += ' md-char-item--mine';
      if (isChecked) cls += ' md-char-item--checked';
      var div = document.createElement('div');
      div.className = cls;
      if (isMine) {
        div.setAttribute('data-entry-id', entryId);
        div.setAttribute('data-selectable', 'true');
        div.setAttribute('role', 'button');
        div.setAttribute('tabindex', '0');
        div.setAttribute('aria-selected', isChecked ? 'true' : 'false');
      }
      div.innerHTML =
        '<div class="md-char-avatar" style="background-image:' + (e.image_url ? 'url(' + esc(e.image_url) + ')' : avatarGradient(i)) + '">' +
          '<div class="md-char-check">' + CHECK_SVG + '</div>' +
        '</div>' +
        '<div class="md-char-name">' + esc(e.title || '?') + '</div>' +
        '<div class="md-char-work">' + esc(e.subtitle || '') + '</div>' +
        (isMine && !SELECT_MODE ? '<div class="md-char-remove" data-entry-id="' + esc(entryId) + '">×</div>' : '');
      grid.appendChild(div);
    }
  }

  // ==================== Voting helpers ====================
  function normalizeStageEntry(row) {
    row.id = Number(row.entry_id || row.id);
    return row;
  }

  function loadMyStageVotes(stage) {
    return api('../api/moe_votes.php?action=my_votes&project_id=' + STATE.project.id).then(function (data) {
      var rows = (data && data.data) || [];
      return rows.filter(function (v) { return Number(v.stage_id) === Number(stage.id); });
    }).catch(function () { return []; });
  }

  function loadStageResults(stage) {
    return api('../api/moe_votes.php?action=results&stage_id=' + stage.id).then(function (data) {
      var rows = (data && data.data) || [];
      var map = {};
      for (var i = 0; i < rows.length; i++) {
        map[Number(rows[i].entry_id || rows[i].id)] = rows[i];
      }
      STATE.resultRows = rows;
      STATE.resultMap = map;
      return data || { data: [], match_results: [] };
    }).catch(function () {
      STATE.resultRows = [];
      STATE.resultMap = {};
      return { data: [], match_results: [] };
    });
  }

  function canShowVoteNumbers(stage, resultData) {
    if (resultData && typeof resultData.metrics_visible === 'boolean') return resultData.metrics_visible;
    var visibility = stage.result_visibility || (resultData && resultData.result_visibility) || 'live_rank_only';
    var status = (resultData && resultData.stage_status) || stage.status || '';
    if (visibility === 'hidden') return false;
    if (visibility === 'live_votes') return true;
    if (visibility === 'after_stage') return status === 'settled';
    if (visibility === 'after_event') return STATE.project && STATE.project.status === 'ended';
    return false;
  }

  function canShowRank(stage, resultData) {
    if (resultData && typeof resultData.rank_visible === 'boolean') return resultData.rank_visible;
    var visibility = (resultData && resultData.result_visibility) || stage.result_visibility || 'live_rank_only';
    if (visibility === 'hidden') return false;
    if (visibility === 'live_votes' || visibility === 'live_rank_only') return true;
    if (visibility === 'after_stage') return ((resultData && resultData.stage_status) || stage.status) === 'settled';
    if (visibility === 'after_event') return STATE.project && STATE.project.status === 'ended';
    return false;
  }

  function applyResultStats(entries, rows) {
    var map = {};
    for (var i = 0; i < (rows || []).length; i++) map[Number(rows[i].entry_id || rows[i].id)] = rows[i];
    return entries.map(function (entry) {
      var stat = map[Number(entry.id)] || {};
      if (Object.prototype.hasOwnProperty.call(stat, 'votes')) entry.votes = Number(stat.votes || 0);
      if (Object.prototype.hasOwnProperty.call(stat, 'score_total')) entry.score_total = Number(stat.score_total || 0);
      if (Object.prototype.hasOwnProperty.call(stat, 'rating_count')) entry.rating_count = Number(stat.rating_count || 0);
      if (Object.prototype.hasOwnProperty.call(stat, 'score_avg')) entry.score_avg = Number(stat.score_avg || 0);
      entry.rank_no = stat.rank_no ? Number(stat.rank_no) : null;
      entry.group_rank = stat.group_rank ? Number(stat.group_rank) : null;
      entry.advanced = Number(stat.advanced || 0);
      return entry;
    });
  }

  function groupEntriesByKey(entries, groupCount) {
    var buckets = {};
    var order = [];
    var count = Math.max(1, Number(groupCount || 1));
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var key = String(entry.group_key || entry.group || '');
      if (!key || key === 'null' || key === 'undefined') key = count > 1 ? ('G' + ((i % count) + 1)) : 'all';
      if (!buckets[key]) {
        buckets[key] = { key: key, label: key === 'all' ? '全部' : key, entries: [] };
        order.push(key);
      }
      buckets[key].entries.push(entry);
    }
    return order.map(function (key) { return buckets[key]; });
  }

  function selectedCountForEntries(entries) {
    var allowed = {};
    for (var i = 0; i < entries.length; i++) allowed[Number(entries[i].id)] = true;
    return Object.keys(STATE.myVotes).filter(function (key) {
      return STATE.myVotes[key] && allowed[Number(key)];
    }).length;
  }

  // ==================== Simple voting ====================
  function renderVoting(stage) {
    STATE.myVotes = {};
    // 重置跨阶段残留的提交锁：上一阶段投完票不应锁死当前阶段的提交按钮
    STATE.voteLocked = false;
    var maxVotes = Number(stage.max_select) || 8;
    STATE.myVotes = {};
    $('mdMainPanel').innerHTML =
      '<div class="md-action">' +
        '<div class="md-action-hint">本组最多选择 <strong>' + maxVotes + '</strong> 项 · 当前组已选 <strong id="mdVoteCount">0</strong> 项</div>' +
      '</div>' +
      '<div class="md-char-grid" id="mdVoteGrid"><div class="md-loading" style="grid-column:1/-1">加载中...</div></div>';
    showBottomBar();

    Promise.all([
      api('../api/moe_stages.php?action=stage_entries&stage_id=' + stage.id),
      loadMyStageVotes(stage),
      loadStageResults(stage)
    ]).then(function (results) {
      var entryData = results[0] || {};
      var runtime = entryData.runtime || stage;
      STATE.runtime = runtime;
      maxVotes = Number(runtime.max_select || stage.max_select) || 1;
      var entries = (entryData.data || []).map(normalizeStageEntry);
      var votes = results[1] || [];
      var resultData = results[2] || {};
      var showVotes = canShowVoteNumbers(stage, resultData);
      STATE.rankVisible = canShowRank(stage, resultData);
      STATE.metricsVisible = showVotes;
      STATE.showVotes = showVotes;
      entries = applyResultStats(entries, resultData.data || []);
      for (var i = 0; i < votes.length; i++) {
        STATE.myVotes[Number(votes[i].entry_id)] = true;
      }
      STATE.groups = groupEntriesByKey(entries, runtime.group_count);
      STATE.currentGroup = 0;
      var locked = votes.length > 0 && !runtime.allow_vote_change;
      if (STATE.groups.length > 1) {
        var action = $('mdMainPanel').querySelector('.md-action');
        if (action && !$('mdGroupTabs')) {
          action.insertAdjacentHTML('afterend', '<div class="md-group-tabs" id="mdGroupTabs"></div>');
        }
        renderVoteGroupTabs(maxVotes, locked, showVotes);
        renderVoteGrid(STATE.groups[0].entries, maxVotes, locked, showVotes);
      } else {
        renderVoteGrid(entries, maxVotes, locked, showVotes);
      }
      var firstGroupEntries = STATE.groups.length > 1 ? STATE.groups[0].entries : entries;
      updateVoteBottomBar(selectedCountForEntries(firstGroupEntries), maxVotes);
      if (locked) lockSubmit();
    }).catch(function () {
      $('mdVoteGrid').innerHTML = '<div class="md-empty" style="grid-column:1/-1">加载失败</div>';
    });

    $('mdBottomSubmit').onclick = function () { submitSimpleVotes(stage); };
  }

  function renderVoteGroupTabs(maxVotes, locked, showVotes) {
    var tabs = $('mdGroupTabs');
    if (!tabs) return;
    tabs.innerHTML = '';
    for (var i = 0; i < STATE.groups.length; i++) {
      (function (idx) {
        var group = STATE.groups[idx];
        var tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'md-group-tab' + (idx === STATE.currentGroup ? ' active' : '');
        tab.textContent = group.label || ('G' + (idx + 1));
        tab.addEventListener('click', function () {
          STATE.currentGroup = idx;
          var buttons = tabs.querySelectorAll('.md-group-tab');
          for (var j = 0; j < buttons.length; j++) buttons[j].classList.remove('active');
          tab.classList.add('active');
          renderVoteGrid(group.entries, maxVotes, locked, showVotes);
          updateVoteBottomBar(selectedCountForEntries(group.entries), maxVotes);
        });
        tabs.appendChild(tab);
      })(i);
    }
  }

  function renderVoteGrid(entries, maxVotes, locked, showVotes) {
    var grid = $('mdVoteGrid');
    if (!grid) return;
    grid.innerHTML = '';
    if (!entries.length) { grid.innerHTML = '<div class="md-empty" style="grid-column:1/-1">阶段池尚未生成，请联系负责人</div>'; return; }
    for (var i = 0; i < entries.length; i++) {
      (function (entry, idx) {
        var div = document.createElement('div');
        div.className = 'md-char-item' + (STATE.myVotes[entry.id] ? ' selected' : '');
        div.setAttribute('data-entry-id', entry.id);
        div.innerHTML =
          '<div class="md-char-avatar" style="background-image:' + (entry.image_url ? 'url(' + esc(entry.image_url) + ')' : avatarGradient(idx)) + '">' +
            '<div class="md-char-check">' + CHECK_SVG + '</div>' +
          '</div>' +
          '<div class="md-char-name">' + esc(entry.title || '?') + '</div>' +
          '<div class="md-char-work">' + esc(entry.subtitle || '') + '</div>' +
          (showVotes
            ? '<div class="md-char-stats">' + (entry.score_total != null ? ('积分 ' + Number(entry.score_total || 0) + ' · ' + Number(entry.rating_count || 0) + '人评分') : ('票数 ' + Number(entry.votes || 0))) + '</div>'
            : (STATE.rankVisible && (entry.group_rank || entry.rank_no)
              ? '<div class="md-char-stats">组内 #' + Number(entry.group_rank || entry.rank_no) + '</div>'
              : ''));
        div.addEventListener('click', function () {
          if (locked) return;
          var count = selectedCountForEntries(entries);
          if (STATE.myVotes[entry.id]) {
            STATE.myVotes[entry.id] = false;
            div.classList.remove('selected');
          } else if (count < maxVotes) {
            STATE.myVotes[entry.id] = true;
            div.classList.add('selected');
          }
          var newCount = selectedCountForEntries(entries);
          $('mdVoteCount').textContent = newCount;
          updateVoteBottomBar(newCount, maxVotes);
          updateGridDimmed(grid, maxVotes);
        });
        grid.appendChild(div);
      })(entries[i], i);
    }
    var selectedCount = selectedCountForEntries(entries);
    var countEl = $('mdVoteCount');
    if (countEl) countEl.textContent = selectedCount;
    updateGridDimmed(grid, maxVotes);
  }

  function updateGridDimmed(grid, maxVotes) {
    if (!grid) return;
    var count = 0;
    grid.querySelectorAll('.md-char-item.selected').forEach(function (item) {
      var id = Number(item.getAttribute('data-entry-id'));
      if (STATE.myVotes[id]) count++;
    });
    grid.querySelectorAll('.md-char-item').forEach(function (item) {
      item.classList.toggle('dimmed', count >= maxVotes && !item.classList.contains('selected'));
    });
  }

  function updateVoteBottomBar(count, maxVotes) {
    var hint = $('mdBottomHint');
    var btn = $('mdBottomSubmit');
    if (hint) hint.innerHTML = '已选 <strong>' + count + '</strong> / ' + maxVotes;
    if (btn) {
      btn.disabled = count === 0 || STATE.voteLocked;
      btn.style.opacity = (count === 0 || STATE.voteLocked) ? '0.5' : '1';
    }
  }

  function submitSimpleVotes(stage) {
    var selected = Object.keys(STATE.myVotes).filter(function (k) { return STATE.myVotes[k]; }).map(Number);
    if (!selected.length) { toast('请至少选择一个角色'); return; }
    var btn = $('mdBottomSubmit');
    setBtnLoading(btn, true);
    post('../api/moe_votes.php?action=cast', { stage_id: stage.id, entry_ids: selected, share: STATE.shareToken }).then(function (r) {
      if (r && r.success) {
        toast('投票成功');
        if (STATE.runtime && STATE.runtime.allow_vote_change) {
          btn.textContent = '修改投票';
          btn.disabled = false;
          btn.style.opacity = '1';
        } else {
          lockSubmit();
        }
      } else {
        setBtnLoading(btn, false);
        btn.textContent = '提交投票';
        toast((r && r.message) || '投票失败');
      }
    }).catch(function () {
      setBtnLoading(btn, false);
      btn.textContent = '提交投票';
      toast('投票失败');
    });
  }

  function setBtnLoading(btn, loading) {
    if (!btn) return;
    btn.disabled = loading;
    if (loading) {
      btn.innerHTML = '<span style="display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 1s linear infinite;vertical-align:middle;margin-right:6px;"></span>提交中...';
    }
  }

  function lockSubmit() {
    var btn = $('mdBottomSubmit');
    if (btn) { btn.disabled = true; btn.textContent = '已投票'; btn.style.opacity = '1'; }
    STATE.voteLocked = true;
  }

  // ==================== Score voting ====================
  function renderScoreVoting(stage) {
    STATE.myVotes = {};
    STATE.myScores = {};
    STATE.voteLocked = false;
    $('mdMainPanel').innerHTML =
      '<div class="md-action">' +
        '<div class="md-action-hint" id="mdScoreHint">加载评分规则中...</div>' +
      '</div>' +
      '<div class="md-group-tabs" id="mdScoreGroupTabs"></div>' +
      '<div class="md-char-grid" id="mdScoreGrid"><div class="md-loading" style="grid-column:1/-1">加载中...</div></div>';
    showBottomBar();

    Promise.all([
      api('../api/moe_stages.php?action=stage_entries&stage_id=' + stage.id),
      loadMyStageVotes(stage),
      loadStageResults(stage)
    ]).then(function (results) {
      var entryData = results[0] || {};
      var runtime = entryData.runtime || stage;
      var entries = (entryData.data || []).map(normalizeStageEntry);
      var votes = results[1] || [];
      var resultData = results[2] || {};
      STATE.runtime = runtime;
      STATE.rankVisible = canShowRank(stage, resultData);
      STATE.metricsVisible = canShowVoteNumbers(stage, resultData);
      entries = applyResultStats(entries, resultData.data || []);
      for (var i = 0; i < votes.length; i++) {
        var entryId = Number(votes[i].entry_id);
        STATE.myVotes[entryId] = true;
        STATE.myScores[entryId] = Number(votes[i].score_value);
      }
      STATE.groups = groupEntriesByKey(entries, runtime.group_count);
      STATE.currentGroup = 0;
      var allGroupsVoted = STATE.groups.every(function (g) {
        return (g.entries || []).every(function (e) { return !!STATE.myVotes[e.id]; });
      });
      STATE.voteLocked = allGroupsVoted && !runtime.allow_vote_change;
      renderScoreGroupTabs(runtime);
      renderScoreGrid(STATE.groups[0] ? STATE.groups[0].entries : [], runtime);
      if (votes.length > 0 && runtime.allow_vote_change) {
        var btn = $('mdBottomSubmit');
        if (btn) btn.textContent = '修改评分';
      }
    }).catch(function () {
      $('mdScoreGrid').innerHTML = '<div class="md-empty" style="grid-column:1/-1">加载失败</div>';
    });

    $('mdBottomSubmit').onclick = function () { submitScoreVotes(stage); };
  }

  function renderScoreGroupTabs(runtime) {
    var tabs = $('mdScoreGroupTabs');
    if (!tabs) return;
    tabs.innerHTML = '';
    for (var i = 0; i < STATE.groups.length; i++) {
      (function (index) {
        var group = STATE.groups[index];
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'md-group-tab' + (index === STATE.currentGroup ? ' active' : '');
        var voted = (group.entries || []).every(function (e) { return !!STATE.myVotes[e.id]; });
        button.textContent = (group.label || ('G' + (index + 1))) + (voted ? ' ✓' : '');
        button.addEventListener('click', function () {
          STATE.currentGroup = index;
          var buttons = tabs.querySelectorAll('.md-group-tab');
          for (var j = 0; j < buttons.length; j++) buttons[j].classList.remove('active');
          button.classList.add('active');
          renderScoreGrid(group.entries, runtime);
        });
        tabs.appendChild(button);
      })(i);
    }
  }

  function renderScoreGrid(entries, runtime) {
    var grid = $('mdScoreGrid');
    if (!grid) return;
    var maxSelect = Number(runtime.max_select || 1);
    var scoreMin = Number(runtime.score_min || 1);
    var scoreMax = Number(runtime.score_max || 10);
    var hint = $('mdScoreHint');
    var currentCount = selectedCountForEntries(entries);
    // 已提交过的不允许修改（除非 allow_vote_change）
    var entryLocked = STATE.voteLocked || (!runtime.allow_vote_change && currentCount > 0 && STATE.myVotesSubmitted);
    if (hint) hint.textContent = '本组最多评分 ' + maxSelect + ' 项，分值范围 ' + scoreMin + ' - ' + scoreMax + '；已选 ' + currentCount + ' 项';
    grid.innerHTML = '';
    for (var i = 0; i < entries.length; i++) {
      (function (entry, index) {
        var card = document.createElement('div');
        card.className = 'md-char-item' + (STATE.myVotes[entry.id] ? ' selected' : '');
        var resultMeta = '';
        if (STATE.metricsVisible && entry.score_total != null) {
          resultMeta = '<div class="md-char-stats">积分 ' + Number(entry.score_total || 0) + ' · ' + Number(entry.rating_count || 0) + '人 · 均分 ' + Number(entry.score_avg || 0).toFixed(2) + '</div>';
        } else if (STATE.rankVisible && (entry.group_rank || entry.rank_no)) {
          resultMeta = '<div class="md-char-stats">组内 #' + Number(entry.group_rank || entry.rank_no) + '</div>';
        }
        var alreadyVoted = !!STATE.myVotes[entry.id];
        var disableInput = STATE.voteLocked || (!runtime.allow_vote_change && alreadyVoted && STATE.myVotesSubmitted);
        card.innerHTML =
          '<div class="md-char-avatar" style="background-image:' + (entry.image_url ? 'url(' + esc(entry.image_url) + ')' : avatarGradient(index)) + '">' +
            '<div class="md-char-check">' + CHECK_SVG + '</div>' +
          '</div>' +
          '<div class="md-char-name">' + esc(entry.title_cn || entry.title || '?') + '</div>' +
          '<div class="md-char-work">' + esc(entry.subtitle || '') + '</div>' +
          '<div class="md-score-panel">' +
            '<label>评分 <input class="md-score-input" type="number" min="' + scoreMin + '" max="' + scoreMax + '" step="1" placeholder="' + scoreMin + '-' + scoreMax + '"' +
              (alreadyVoted ? ' value="' + Number(STATE.myScores[entry.id]) + '"' : '') +
              (disableInput ? ' disabled' : '') + '></label>' +
          '</div>' + resultMeta;
        var input = card.querySelector('.md-score-input');
        input.addEventListener('change', function () {
          var raw = input.value.trim();
          if (raw === '') {
            delete STATE.myVotes[entry.id];
            delete STATE.myScores[entry.id];
            card.classList.remove('selected');
          } else {
            var value = Number(raw);
            if (!Number.isInteger(value) || value < scoreMin || value > scoreMax) {
              toast('评分必须在 ' + scoreMin + ' - ' + scoreMax + ' 之间');
              input.value = STATE.myVotes[entry.id] ? STATE.myScores[entry.id] : '';
              return;
            }
            if (!STATE.myVotes[entry.id] && selectedCountForEntries(entries) >= maxSelect) {
              toast('本组最多评分 ' + maxSelect + ' 项');
              input.value = '';
              return;
            }
            STATE.myVotes[entry.id] = true;
            STATE.myScores[entry.id] = value;
            card.classList.add('selected');
          }
          var count = selectedCountForEntries(entries);
          if (hint) hint.textContent = '本组最多评分 ' + maxSelect + ' 项，分值范围 ' + scoreMin + ' - ' + scoreMax + '；已选 ' + count + ' 项';
          updateVoteBottomBar(count, maxSelect);
        });
        grid.appendChild(card);
      })(entries[i], i);
    }
    updateVoteBottomBar(currentCount, maxSelect);
    if (STATE.voteLocked) lockSubmit();
  }

  function submitScoreVotes(stage) {
    var entryIds = Object.keys(STATE.myVotes).filter(function (key) { return STATE.myVotes[key]; }).map(Number);
    if (!entryIds.length) { toast('请至少选择一项并评分'); return; }
    var scores = {};
    var bounds = { min: Number(stage.score_min || 1), max: Number(stage.score_max || 10) };
    for (var i = 0; i < entryIds.length; i++) {
      var score = Number(STATE.myScores[entryIds[i]]);
      if (score < bounds.min || score > bounds.max) {
        toast('请为已选角色填写 ' + bounds.min + '-' + bounds.max + ' 分');
        return;
      }
      scores[entryIds[i]] = score;
    }
    var btn = $('mdBottomSubmit');
    setBtnLoading(btn, true);
    post('../api/moe_votes.php?action=cast', { stage_id: stage.id, entry_ids: entryIds, scores: scores, share: STATE.shareToken }).then(function (result) {
      if (!result || !result.success) {
        setBtnLoading(btn, false);
        btn.textContent = '提交评分';
        toast((result && result.message) || '评分失败');
        return;
      }
      // 标记已提交过，已投票项不可修改（除非开启 allow_vote_change）
      STATE.myVotesSubmitted = true;
      var allowScoreChange = STATE.runtime && STATE.runtime.allow_vote_change;
      // 后端按阶段整体去重：一次提交即完成本阶段评分，不存在“切换组继续投票”
      toast(allowScoreChange ? '评分已提交，可再次修改' : '评分已提交');
      if (allowScoreChange) {
        setBtnLoading(btn, false);
        btn.textContent = '修改评分';
        updateVoteBottomBar(entryIds.length, entryIds.length);
      } else {
        lockSubmit();
      }
      // 刷新组标签显示勾号
      renderScoreGroupTabs(STATE.runtime || stage);
    }).catch(function () {
      setBtnLoading(btn, false);
      btn.textContent = '提交评分';
      toast('评分失败');
    });
  }

  // ==================== Bracket / Final ====================
  function mergeMatchStats(matches, stats, showVotes) {
    var map = {};
    for (var i = 0; i < (stats || []).length; i++) map[Number(stats[i].id)] = stats[i];
    return (matches || []).map(function (match) {
      var stat = map[Number(match.id)] || {};
      match.slot_a_votes = Number(stat.slot_a_votes || 0);
      match.slot_b_votes = Number(stat.slot_b_votes || 0);
      match.total_votes = Number(stat.total_votes || 0);
      match._show_votes = !!showVotes;
      return match;
    });
  }

  function matchHasBothSlots(match) {
    return Number(match.slot_a_entry_id || 0) > 0 && Number(match.slot_b_entry_id || 0) > 0;
  }

  function bracketRoundLabel(roundNo, bracketSize) {
    var size = Math.max(2, Math.floor(Number(bracketSize || 0) / Math.pow(2, Math.max(0, Number(roundNo || 1) - 1))));
    if (size === 4) return '半决赛';
    if (size === 2) return '最终轮';
    return size + ' 强';
  }

  function currentOpenRoundMatches(matches) {
    var voteable = (matches || []).filter(function (m) {
      return m.status === 'open' && matchHasBothSlots(m);
    });
    if (!voteable.length) return [];
    var roundNo = Math.min.apply(null, voteable.map(function (m) { return Number(m.round_no || 1); }));
    return voteable.filter(function (m) { return Number(m.round_no || 1) === roundNo; });
  }

  function hydrateMatchVoteState(matches, votes) {
    STATE.myVotes = {};
    var matchMap = {};
    (matches || []).forEach(function (m) { matchMap[Number(m.id)] = m; });
    (votes || []).forEach(function (vote) {
      var matchId = Number(vote.match_id || 0);
      var match = matchMap[matchId];
      if (!match) return;
      var entryId = Number(vote.entry_id || 0);
      if (entryId === Number(match.slot_a_entry_id || 0)) STATE.myVotes[matchId] = 'a';
      if (entryId === Number(match.slot_b_entry_id || 0)) STATE.myVotes[matchId] = 'b';
    });
    STATE.preVotedCurrentRound = (matches || []).length > 0 && Object.keys(STATE.myVotes).length >= (matches || []).length;
  }

  function renderReadonlyMatchSummary(matches, bracketSize, activeRoundNo) {
    if (!matches || !matches.length) return '';
    var html = '<div class="md-action" style="margin-top:10px;"><div class="md-action-hint">赛程概览 · 已结算对阵显示胜者，未开放对阵仅作预览</div></div>';
    var byRound = {};
    matches.forEach(function (m) {
      var roundNo = Number(m.round_no || 1);
      if (!byRound[roundNo]) byRound[roundNo] = [];
      byRound[roundNo].push(m);
    });
    Object.keys(byRound).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (roundKey) {
      var roundNo = Number(roundKey);
      var weak = activeRoundNo && roundNo !== Number(activeRoundNo);
      var roundMatches = byRound[roundKey].filter(function (m) {
        return !(activeRoundNo && roundNo === Number(activeRoundNo) && m.status === 'open' && matchHasBothSlots(m));
      });
      if (!roundMatches.length) return;
      html += '<div style="padding:10px 0 4px;color:var(--muted);font-size:12px;font-weight:700;">' + esc(bracketRoundLabel(roundNo, bracketSize)) + '</div>';
      html += '<div class="md-match-list"' + (weak ? ' style="opacity:.68;"' : '') + '>';
      roundMatches.forEach(function (m) {
        var a = esc(m.slot_a_title_cn || m.slot_a_title || '待定');
        var b = esc(m.slot_b_title_cn || m.slot_b_title || '待定');
        var winner = m.status === 'settled' ? esc(m.winner_title_cn || m.winner_title || m.winner_entry_id || '') : '';
        var votes = m._show_votes ? ' · ' + Number(m.slot_a_votes || 0) + ':' + Number(m.slot_b_votes || 0) + '票' : '';
        html += '<div class="md-match-row" style="pointer-events:none;">' +
          '<span class="md-match-num">R' + roundNo + '-' + Number(m.match_no || 0) + '</span>' +
          '<div class="md-match-side"><span class="md-match-name">' + a + '</span></div>' +
          '<span class="md-match-vs">VS</span>' +
          '<div class="md-match-side"><span class="md-match-name">' + b + '</span></div>' +
          '<span class="md-match-name" style="min-width:88px;font-size:11px;color:var(--muted);">' + esc(m.status || 'pending') + (winner ? ' · 胜者 ' + winner : '') + votes + '</span>' +
        '</div>';
      });
      html += '</div>';
    });
    return html;
  }

  function renderBracket(stage) {
    STATE.bracketSize = 0;
    STATE.myVotes = {};
    $('mdMainPanel').innerHTML = '<div class="md-loading">加载对阵中...</div>';

    Promise.all([
      api('../api/moe_matches.php?action=list&stage_id=' + stage.id),
      loadStageResults(stage),
      loadMyStageVotes(stage)
    ]).then(function (results) {
      var data = results[0] || {};
      var resultData = results[1] || {};
      var votes = results[2] || [];
      var matchStats = resultData.match_results || [];
      var matches = (data && data.data) || [];
      var firstRound = matches.filter(function (match) { return Number(match.round_no || 1) === 1; });
      STATE.bracketSize = Math.max(2, firstRound.length * 2 || matches.length * 2 || 2);
      var showVotes = canShowVoteNumbers(stage, resultData);
      STATE.runtime = resultData.runtime || stage;
      matches = mergeMatchStats(matches, matchStats, showVotes);
      var currentMatches = currentOpenRoundMatches(matches);
      // 只检查当前轮次的投票状态，不因上一轮已投票就锁定
      var currentMatchIds = {};
      currentMatches.forEach(function (m) { currentMatchIds[Number(m.id)] = true; });
      var currentRoundVoted = votes.filter(function (v) { return currentMatchIds[Number(v.match_id || 0)]; });
      var currentComplete = currentMatches.length > 0 && currentRoundVoted.length >= currentMatches.length;
      STATE.voteLocked = currentComplete && !STATE.runtime.allow_vote_change;
      STATE.allMatches = matches;
      STATE.matches = currentMatches;
      if (!matches.length) {
        $('mdMainPanel').innerHTML = '<div class="md-empty">淘汰赛对阵尚未生成，请联系负责人在管理端生成对阵</div>';
        return;
      }
      if (!currentMatches.length) {
        if ((resultData.data || []).length) {
          renderStageResults(stage);
          return;
        }
        $('mdMainPanel').innerHTML = '<div class="md-empty">当前没有开放中的淘汰赛对阵，等待负责人结算或开放下一轮。</div>' + renderReadonlyMatchSummary(matches, STATE.bracketSize, null);
        return;
      }
      hydrateMatchVoteState(currentMatches, votes);
      buildMatchList(currentMatches, STATE.bracketSize, matches);
      showBottomBar();
      $('mdBottomSubmit').onclick = function () { submitMatchVotes(stage); };
    }).catch(function () {
      $('mdMainPanel').innerHTML = '<div class="md-empty">加载失败</div>';
    });
  }

  function buildMatchList(matches, bracketSize, allMatches) {
    var content = $('mdMainPanel');
    var avatarSize = bracketSize <= 8 ? 56 : (bracketSize <= 32 ? 48 : 40);
    var totalMatches = matches.length;
    var roundNo = matches[0] ? Number(matches[0].round_no || 1) : 1;
    var html = '<div class="md-action"><div class="md-action-hint">当前轮次：<strong>' + esc(bracketRoundLabel(roundNo, bracketSize)) + '</strong> · 请选择本轮全部开放对阵</div></div>';
    html += '<div class="md-match-list" id="mdMatchList">';
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      var selectedSide = STATE.myVotes[Number(m.id)];
      html +=
        '<div class="md-match-row" data-match-id="' + m.id + '">' +
          '<span class="md-match-num">#' + (i + 1) + '</span>' +
          '<div class="md-match-side' + (selectedSide === 'a' ? ' winner' : (selectedSide === 'b' ? ' loser' : '')) + '" data-side="a" data-match-id="' + m.id + '">' +
            '<div class="md-match-avatar" style="background-image:' + (m.slot_a_image ? 'url(' + esc(m.slot_a_image) + ')' : avatarGradient(i * 2)) + ';width:' + avatarSize + 'px;height:' + avatarSize + 'px;"></div>' +
            '<span class="md-match-name">' + esc(m.slot_a_title || '角色A') + '</span>' +
            (m._show_votes ? '<span class="md-match-name" style="font-size:10px;color:var(--muted);">' + Number(m.slot_a_votes || 0) + '票</span>' : '') +
            '<div class="md-match-check">' + CHECK_SVG + '</div>' +
          '</div>' +
          '<span class="md-match-vs">VS</span>' +
          '<div class="md-match-side' + (selectedSide === 'b' ? ' winner' : (selectedSide === 'a' ? ' loser' : '')) + '" data-side="b" data-match-id="' + m.id + '">' +
            '<div class="md-match-avatar" style="background-image:' + (m.slot_b_image ? 'url(' + esc(m.slot_b_image) + ')' : avatarGradient(i * 2 + 1)) + ';width:' + avatarSize + 'px;height:' + avatarSize + 'px;"></div>' +
            '<span class="md-match-name">' + esc(m.slot_b_title || '角色B') + '</span>' +
            (m._show_votes ? '<span class="md-match-name" style="font-size:10px;color:var(--muted);">' + Number(m.slot_b_votes || 0) + '票</span>' : '') +
            '<div class="md-match-check">' + CHECK_SVG + '</div>' +
          '</div>' +
        '</div>';
    }
    html += '</div>';
    html += renderReadonlyMatchSummary(allMatches || matches, bracketSize, roundNo);
    content.innerHTML = html;

    var rows = document.querySelectorAll('.md-match-row');
    for (var r = 0; r < rows.length; r++) {
      var sides = rows[r].querySelectorAll('.md-match-side');
      sides[0].addEventListener('click', function (ev) {
        selectMatchSide(ev.currentTarget.getAttribute('data-match-id'), 'a', totalMatches);
      });
      sides[1].addEventListener('click', function (ev) {
        selectMatchSide(ev.currentTarget.getAttribute('data-match-id'), 'b', totalMatches);
      });
    }
    updateBracketBottomBar(totalMatches);
  }

  function selectMatchSide(matchId, side, totalMatches) {
    if (STATE.voteLocked) return;
    STATE.preVotedCurrentRound = false;
    STATE.myVotes[matchId] = side;
    var row = document.querySelector('.md-match-row[data-match-id="' + matchId + '"]');
    if (!row) return;
    var sides = row.querySelectorAll('.md-match-side');
    if (side === 'a') {
      sides[0].classList.add('winner'); sides[0].classList.remove('loser');
      sides[1].classList.add('loser'); sides[1].classList.remove('winner');
    } else {
      sides[1].classList.add('winner'); sides[1].classList.remove('loser');
      sides[0].classList.add('loser'); sides[0].classList.remove('winner');
    }
    updateBracketBottomBar(totalMatches);
  }

  function updateBracketBottomBar(totalMatches) {
    var selected = Object.keys(STATE.myVotes).length;
    var hint = $('mdBottomHint');
    var btn = $('mdBottomSubmit');
    var complete = selected >= totalMatches;
    var voted = STATE.voteLocked || (STATE.preVotedCurrentRound && complete);
    if (hint) hint.innerHTML = (voted ? '本轮已投票' : (complete ? '本轮已选完' : '已选')) + ' <strong>' + selected + '</strong> / ' + totalMatches + ' 组';
    if (btn) {
      btn.disabled = !complete || STATE.voteLocked;
      btn.style.opacity = complete && !STATE.voteLocked ? '1' : '0.5';
      btn.textContent = voted ? '已投票' : (complete ? '提交本轮投票' : '选择本轮全部对阵');
    }
  }

  function renderFinal(stage) {
    STATE.myVotes = {};
    $('mdMainPanel').innerHTML = '<div class="md-loading">加载对阵中...</div>';

    Promise.all([
      api('../api/moe_matches.php?action=list&stage_id=' + stage.id),
      loadStageResults(stage),
      loadMyStageVotes(stage)
    ]).then(function (results) {
      var data = results[0] || {};
      var resultData = results[1] || {};
      var matchStats = resultData.match_results || [];
      var matches = (data && data.data) || [];
      var votes = results[2] || [];
      matches = mergeMatchStats(matches, matchStats, canShowVoteNumbers(stage, resultData));
      STATE.matches = matches;
      STATE.runtime = resultData.runtime || stage;
      hydrateMatchVoteState(matches, votes);
      var finalVoted = Object.keys(STATE.myVotes).length >= matches.length;
      STATE.voteLocked = finalVoted && !STATE.runtime.allow_vote_change;
      if (!matches.length) { $('mdMainPanel').innerHTML = '<div class="md-empty">决赛对阵尚未生成，请联系负责人在管理端生成对阵</div>'; return; }
      var main = $('mdMainPanel');
      main.innerHTML = '';
      for (var i = 0; i < matches.length; i++) {
        var m = matches[i];
        var isChampion = (m.match_type === 'final' || i === 0);
        var card = buildMatchCard(m, i, isChampion ? 'final' : 'third');
        main.appendChild(card);
        if (STATE.myVotes[Number(m.id)]) {
          selectMatchCardSide(Number(m.id), STATE.myVotes[Number(m.id)]);
        }
      }
      showBottomBar();
      var btn = $('mdBottomSubmit');
      if (btn) {
        btn.className = 'md-btn md-btn--primary';
        btn.style.background = 'var(--gold)';
        btn.style.borderColor = 'var(--gold)';
        btn.style.color = '#fff';
        btn.style.boxShadow = '0 4px 14px rgba(199,147,43,0.25)';
      }
      $('mdBottomSubmit').onclick = function () { submitMatchVotes(stage); };
      updateFinalBottomBar();
    }).catch(function () {
      $('mdMainPanel').innerHTML = '<div class="md-empty">加载失败</div>';
    });
  }

  function buildMatchCard(match, idx, type) {
    var card = document.createElement('div');
    card.className = 'md-match-card';
    var headerCls = type === 'final' ? 'final' : 'third';
    var headerLabel = type === 'final' ? '冠军争夺战' : '季军争夺战';
    var headerIcon = type === 'final'
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2"><path d="M8 21h8M12 3v12M8 7h8M6 11h12"/><circle cx="12" cy="16" r="3"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 24 24" fill="#cd7f32"><circle cx="12" cy="12" r="10" opacity="0.15"/><circle cx="12" cy="12" r="6" opacity="0.25"/><circle cx="12" cy="12" r="3"/></svg>';
    var avatarSize = type === 'final' ? '72px' : '48px';
    card.setAttribute('data-match-id', match.id);
    card.innerHTML =
      '<div class="md-match-card-header ' + headerCls + '">' + headerIcon + ' ' + headerLabel + '</div>' +
      '<div class="md-match-card-body">' +
        '<div class="md-match-card-side" data-side="a" data-match-id="' + match.id + '">' +
          '<div class="md-match-avatar" style="background-image:' + (match.slot_a_image ? 'url(' + esc(match.slot_a_image) + ')' : avatarGradient(idx * 2)) + ';width:' + avatarSize + ';height:' + avatarSize + ';"></div>' +
          '<div style="font-size:' + (type === 'final' ? '14px' : '12px') + ';font-weight:700;">' + esc(match.slot_a_title || '角色A') + '</div>' +
          '<div style="font-size:11px;color:var(--muted);">' + esc(match.slot_a_title_cn || '') + '</div>' +
          (match._show_votes ? '<div style="font-size:10px;color:var(--muted);margin-top:4px;">' + Number(match.slot_a_votes || 0) + '票</div>' : '') +
        '</div>' +
        '<span style="font-size:15px;font-weight:800;color:var(--muted);">VS</span>' +
        '<div class="md-match-card-side" data-side="b" data-match-id="' + match.id + '">' +
          '<div class="md-match-avatar" style="background-image:' + (match.slot_b_image ? 'url(' + esc(match.slot_b_image) + ')' : avatarGradient(idx * 2 + 1)) + ';width:' + avatarSize + ';height:' + avatarSize + ';"></div>' +
          '<div style="font-size:' + (type === 'final' ? '14px' : '12px') + ';font-weight:700;">' + esc(match.slot_b_title || '角色B') + '</div>' +
          '<div style="font-size:11px;color:var(--muted);">' + esc(match.slot_b_title_cn || '') + '</div>' +
          (match._show_votes ? '<div style="font-size:10px;color:var(--muted);margin-top:4px;">' + Number(match.slot_b_votes || 0) + '票</div>' : '') +
        '</div>' +
      '</div>';

    var sides = card.querySelectorAll('.md-match-card-side');
    sides[0].addEventListener('click', function () { selectMatchCardSide(match.id, 'a'); });
    sides[1].addEventListener('click', function () { selectMatchCardSide(match.id, 'b'); });
    return card;
  }

  function selectMatchCardSide(matchId, side) {
    if (STATE.voteLocked) return;
    STATE.myVotes[matchId] = side;
    var card = document.querySelector('.md-match-card[data-match-id="' + matchId + '"]');
    if (!card) return;
    var sides = card.querySelectorAll('.md-match-card-side');
    if (side === 'a') {
      sides[0].style.border = '2px solid var(--gold)'; sides[0].style.background = 'var(--gold-bg)'; sides[0].style.borderRadius = 'var(--md-radius-xs)';
      sides[1].style.border = '1px solid transparent'; sides[1].style.background = 'transparent'; sides[1].style.opacity = '0.4';
    } else {
      sides[1].style.border = '2px solid var(--gold)'; sides[1].style.background = 'var(--gold-bg)'; sides[1].style.borderRadius = 'var(--md-radius-xs)';
      sides[0].style.border = '1px solid transparent'; sides[0].style.background = 'transparent'; sides[0].style.opacity = '0.4';
    }
    updateFinalBottomBar();
  }

  function updateFinalBottomBar() {
    var selected = Object.keys(STATE.myVotes).length;
    var total = STATE.matches.length;
    var hint = $('mdBottomHint');
    var btn = $('mdBottomSubmit');
    var championPicked = STATE.matches[0] && STATE.myVotes[STATE.matches[0].id];
    var thirdPicked = STATE.matches[1] && STATE.myVotes[STATE.matches[1].id];
    if (hint) hint.innerHTML = STATE.voteLocked
      ? '本轮已投票'
      : '冠军赛 <strong style="color:var(--gold)">' + (championPicked ? '已选' : '待选') + '</strong> · 季军赛 <strong style="color:var(--muted)">' + (thirdPicked ? '已选' : '待选') + '</strong>';
    if (btn) {
      btn.disabled = selected < total || STATE.voteLocked;
      btn.style.opacity = selected >= total && !STATE.voteLocked ? '1' : '0.5';
      btn.textContent = STATE.voteLocked ? '已投票' : '提交投票';
    }
  }

  function submitMatchVotes(stage) {
    var requiredMatches = STATE.matches || [];
    var requiredMap = {};
    requiredMatches.forEach(function (m) { requiredMap[Number(m.id)] = true; });
    var matchIds = Object.keys(STATE.myVotes).filter(function (id) { return requiredMap[Number(id)]; });
    if (matchIds.length < requiredMatches.length) { toast('请选择本轮全部对阵'); return; }
    var btn = $('mdBottomSubmit');
    setBtnLoading(btn, true);
    var matches = STATE.matches;
    var done = 0, failed = 0;
    function submitOne() {
      if (done >= matchIds.length) {
        setBtnLoading(btn, false);
        if (failed) {
          btn.textContent = '失败 ' + failed + ' 个';
          toast(failed + ' 个对阵投票失败');
        } else {
          var allowChange = STATE.runtime
            ? STATE.runtime.allow_vote_change
            : stage.allow_vote_change;
          if (allowChange) {
            // 允许改票：保持可提交，按钮转为修改入口（后端按 allow_vote_change 覆盖旧票）
            btn.textContent = '修改投票';
            btn.disabled = false;
            STATE.voteLocked = false;
            toast('全部投票成功，可再次修改');
          } else {
            btn.textContent = '已投票';
            btn.disabled = true;
            STATE.voteLocked = true;
            toast('全部投票成功');
          }
        }
        return;
      }
      var matchId = Number(matchIds[done]);
      var side = STATE.myVotes[matchId];
      var match = null;
      for (var i = 0; i < matches.length; i++) {
        if (Number(matches[i].id) === matchId) { match = matches[i]; break; }
      }
      if (!match) { failed++; done++; submitOne(); return; }
      var entryId = side === 'a' ? Number(match.slot_a_entry_id) : Number(match.slot_b_entry_id);
      if (!entryId) { failed++; done++; submitOne(); return; }
      post('../api/moe_votes.php?action=cast', { stage_id: stage.id, match_id: matchId, entry_ids: [entryId], share: STATE.shareToken }).then(function (r) {
        if (!r || !r.success) failed++;
      }).catch(function () { failed++; }).finally(function () {
        done++;
        submitOne();
      });
    }
    submitOne();
  }

  // ==================== Results ====================
  function renderStageResults(stage) {
    var panel = $('mdMainPanel');
    $('mdBottomBar').style.display = 'none';
    resetSelectBar();
    panel.innerHTML = '<div class="md-loading">加载结果中...</div>';
    loadStageResults(stage).then(function (data) {
      var rows = (data && data.data) || [];
      var showVotes = canShowVoteNumbers(stage, data);
      var showRank = canShowRank(stage, data);
      if (!showRank && !showVotes) {
        panel.innerHTML = '<div class="md-empty">结果暂未公开</div>';
        return;
      }
      if (!rows.length) {
        panel.innerHTML = '<div class="md-empty">暂无结算结果</div>';
        return;
      }
      var title = stage.stage_type === 'final' ? '最终结果' : '阶段结果';
      var runtime = (data && data.runtime) || stage;
      var groups = groupEntriesByKey(rows, runtime.group_count);
      renderRankPanel(rows.map(function (r) { return Object.assign({ id: Number(r.entry_id || r.id) }, r); }));

      var html = '<div class="md-result-header"><h2 class="md-result-title">' + title + '</h2></div>';
      for (var groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        var group = groups[groupIndex];
        if (groups.length > 1) html += '<div class="md-result-group-title">' + esc(group.label) + '</div>';
        html += '<div class="md-result-grid">';
        for (var i = 0; i < group.entries.length; i++) {
          var row = group.entries[i];
          var rank = Number(row.group_rank || row.rank_no || i + 1);
          var medal = stage.stage_type === 'final'
            ? (rank === 1 ? '冠军' : (rank === 2 ? '亚军' : (rank === 3 ? '季军' : ('#' + rank))))
            : ('组内 #' + rank);
          var metric = '';
          if (showVotes) {
            metric = row.score_total != null
              ? ' · 积分 ' + Number(row.score_total || 0) + ' · ' + Number(row.rating_count || 0) + '人 · 均分 ' + Number(row.score_avg || 0).toFixed(2)
              : ' · ' + Number(row.votes || 0) + '票';
          }
          html += '<div class="md-char-item selected">' +
            '<div class="md-char-avatar" style="background-image:' + (row.image_url ? 'url(' + esc(row.image_url) + ')' : avatarGradient(i)) + '">' +
              '<div class="md-char-check">' + (showRank ? rank : '') + '</div>' +
            '</div>' +
            '<div class="md-char-name">' + esc(row.title_cn || row.title || '?') + '</div>' +
            '<div class="md-char-work">' + (showRank ? medal : '') + metric + '</div>' +
          '</div>';
        }
        html += '</div>';
      }
      panel.innerHTML = html;
    });
  }

  $('mdSelectDelete').addEventListener('click', function () {
    if (!STATE.currentStage || STATE.currentStage.stage_type !== 'nomination') return;
    var maxNoms = Number(STATE.currentStage.max_select) || 3;
    batchWithdrawNominations(STATE.currentStage, maxNoms);
  });

  function renderRankPanel(entries) {
    var panel = $('mdRankPanel');
    var list = $('mdRankList');
    // 票数指标未公开（result_visibility 裁剪）时不渲染，避免误导性的“0票”
    if (!STATE.metricsVisible) { panel.style.display = 'none'; return; }
    var ranked = entries.filter(function (w) { return w.rank_no; }).sort(function (a, b) { return (a.rank_no || 9999) - (b.rank_no || 9999); }).slice(0, 5);
    if (!ranked.length) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    list.innerHTML = '';
    ranked.forEach(function (w) {
      var row = document.createElement('div');
      row.className = 'md-rank-item';
      row.innerHTML =
        '<div class="md-rank-pos">#' + Number(w.rank_no) + '</div>' +
        '<div class="md-rank-avatar" style="background-image:' + (w.image_url ? 'url(' + esc(w.image_url) + ')' : avatarGradient(w.rank_no)) + '"></div>' +
        '<div class="md-rank-info">' +
          '<div class="md-rank-title">' + esc(w.title || w.title_cn || '?') + '</div>' +
          '<div class="md-rank-meta">' + Number(w.votes || 0) + '票' + (w.score_avg != null ? ' · 均分 ' + Number(w.score_avg).toFixed(2) : '') + '</div>' +
        '</div>';
      list.appendChild(row);
    });
  }

  init();
})();
