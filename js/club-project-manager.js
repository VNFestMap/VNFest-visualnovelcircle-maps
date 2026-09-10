(function () {
  'use strict';
  var $ = $vote, esc = escVote, api = apiVote, post = postVote;
  var toast = function (m) { toastVote($('toast'), m); };
  var typeLabel = typeLabelVote, statusLabel = statusLabelVote, parseConfig = parseConfigVote;

  /* ===== State ===== */
  var state = {
    projects: [],
    selected: null,
    stages: [],
    entries: [],
    matches: [],
    flow: null,
    clubData: null,
    selectedClub: null,
    createType: 'twelve',
    editingStageId: null,
    poolFilter: 'all',
    poolPage: 1,
    poolStageTab: 'all',
    poolGroupTab: 'all',
    nominationQuery: '',
    stageEntriesCache: {},
    rebuildFlowInFlight: false,
    lastSettleIssues: [],
    moeAwardSyncKey: '',
    modalReturnFocus: null,
    tieDecision: null
  };
  var POOL_PAGE_SIZE = 16;

  function setButtonBusy(btn, label) {
    if (!btn) return function () {};
    var oldText = btn.textContent;
    btn.disabled = true;
    if (label) btn.textContent = label;
    return function () {
      btn.disabled = false;
      btn.textContent = oldText;
    };
  }

  function loadingMarkup(text) {
    return '<div class="loading-state">' + esc(text || '加载中...') + '</div>';
  }

  function setClubSearchExpanded(expanded) {
    var input = $('clubSearchInput');
    if (input) input.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function setCreateCardOpen(open) {
    var card = $('createCard');
    var toggle = $('createToggle');
    if (!card || !toggle) return;
    card.classList.toggle('open', !!open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /* ===== Theme Toggle ===== */
  initVoteThemeToggle('themeToggle');

  /* ===== Club Data ===== */
  function loadClubData() {
    if (state.clubData) return Promise.resolve(state.clubData);
    var empty = { data: [] };
    return Promise.all([
      fetch('../api/clubs.php', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : empty; }).catch(function () { return empty; }),
      fetch('../api/clubs_japan.php', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : empty; }).catch(function () { return empty; })
    ]).then(function (results) {
      state.clubData = {
        china: ((results[0] || empty).data || []).map(function (club) { return Object.assign({ country: 'china' }, club); }),
        japan: ((results[1] || empty).data || []).map(function (club) { return Object.assign({ country: 'japan' }, club); })
      };
      var realInput = $('clubSearchReal');
      if (realInput && realInput.value.trim() && !state.selectedClub) {
        performClubSearch(realInput.value.trim());
      }
      return state.clubData;
    }).catch(function () {
      state.clubData = { china: [], japan: [] };
      return state.clubData;
    });
  }

  function allClubs() {
    if (!state.clubData) return [];
    return (state.clubData.china || []).concat(state.clubData.japan || []);
  }

  function clubDisplayName(clubId, country) {
    var rows = state.clubData ? (state.clubData[country || 'china'] || []) : [];
    var club = rows.find(function (item) { return Number(item.id) === Number(clubId); });
    return club ? (club.name || club.display_name || club.school || ('同好会 ' + clubId)) : ('同好会 ' + clubId);
  }

  function clubSearchName(club) {
    return club ? (club.display_name || club.name || club.school || ('同好会 ' + club.id)) : '';
  }

  function clubSearchMeta(club) {
    if (!club) return '';
    var parts = [];
    if (club.school && clubSearchName(club).indexOf(club.school) === -1) parts.push(club.school);
    if (club.prefecture) parts.push(club.prefecture);
    if (club.province) parts.push(club.province);
    if (Array.isArray(club.provinces) && club.provinces.length) parts.push(club.provinces.join('、'));
    parts.push((club.country || 'china') === 'japan' ? '日本' : '中国');
    return parts.filter(Boolean).join(' · ');
  }

  function normalizeSearchText(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, '');
  }

  function clubMatchesQuery(club, query) {
    if (!query) return true;
    var countryLabel = (club.country || 'china') === 'japan' ? '日本 japan jp' : '中国 china cn';
    var haystack = [
      club.name,
      club.display_name,
      club.school,
      club.raw_text,
      club.info,
      club.province,
      Array.isArray(club.provinces) ? club.provinces.join(' ') : '',
      club.prefecture,
      countryLabel
    ].map(normalizeSearchText).join(' ');
    return haystack.indexOf(query) !== -1;
  }

  function emptyStateMarkup(text, hint) {
    return '<div class="empty-state"><div class="empty-state-inner"><p>' + esc(text) + '</p>' +
      (hint ? '<p class="hint">' + esc(hint) + '</p>' : '') + '</div></div>';
  }

  /* ===== Project List ===== */
  function loadManageable() {
    $('manageList').innerHTML = loadingMarkup('正在加载可管理企划');
    return api('../api/vote_projects.php?action=my_manageable').then(function (data) {
      state.projects = data.success ? (data.data || []) : [];
      renderProjectList();
      if (!state.selected && state.projects.length) selectProject(state.projects[0].id);
      return state.projects;
    }).catch(function () {
      $('manageList').innerHTML = emptyStateMarkup('请先登录负责人/管理员账号', '登录后会显示可管理的十二器/萌战企划。');
    });
  }

  function selectProject(id) {
    $('detailArea').innerHTML = loadingMarkup('正在加载企划详情');
    return api('../api/vote_projects.php?action=get&id=' + encodeURIComponent(id)).then(function (data) {
      if (!data.success) { toast(data.message || '加载失败'); return; }
      state.selected = data.data;
      state.stages = data.stages || [];
      state.poolPage = 1;
      state.poolFilter = 'all';
      state.poolStageTab = 'all';
      state.poolGroupTab = 'all';
      state.nominationQuery = '';
      state.stageEntriesCache = {};
      state.lastSettleIssues = [];
      return Promise.all([
        api('../api/vote_nominations.php?action=list&project_id=' + encodeURIComponent(id)),
        api('../api/vote_matches.php?action=list&project_id=' + encodeURIComponent(id)),
        api('../api/vote_stages.php?action=flow_status&project_id=' + encodeURIComponent(id))
      ]).then(function (results) {
        state.entries = results[0].success ? (results[0].data || []) : [];
        state.matches = results[1].success ? (results[1].data || []) : [];
        state.flow = results[2].success ? results[2] : null;
        state.lastSettleIssues = [];
        if (state.flow && Array.isArray(state.flow.pools)) {
          state.flow.pools.forEach(function (pool) {
            var runtime = pool.runtime || {};
            if (Array.isArray(runtime.match_tie_breaks)) {
              state.lastSettleIssues = state.lastSettleIssues.concat(runtime.match_tie_breaks);
            }
          });
        }
        return loadMoeMatchesForStages().then(function () {
          renderProjectList();
          renderDetail();
        });
      });
    }).catch(function () {
      $('detailArea').innerHTML = emptyStateMarkup('企划详情加载失败', '请刷新后重试。');
      toast('企划详情加载失败');
    });
  }

  function loadMoeMatchesForStages() {
    if (!state.selected || state.selected.project_type !== 'moe') return Promise.resolve();
    var matchStages = state.stages.filter(function (stage) {
      return stage.stage_type === 'bracket' || stage.stage_type === 'final';
    });
    if (!matchStages.length) return Promise.resolve();
    return Promise.all(matchStages.map(function (stage) {
      return api('../api/vote_matches.php?action=list&stage_id=' + encodeURIComponent(stage.id));
    })).then(function (results) {
      var rows = [];
      results.forEach(function (result) {
        if (result && result.success && Array.isArray(result.data)) rows = rows.concat(result.data);
      });
      state.matches = rows;
    }).catch(function () {});
  }

  function reloadProjectWithQualifierPool(projectId, qualifierId, qualifierEntries) {
    return Promise.all([
      api('../api/vote_projects.php?action=get&id=' + encodeURIComponent(projectId)),
      api('../api/vote_nominations.php?action=list&project_id=' + encodeURIComponent(projectId)),
      api('../api/vote_matches.php?action=list&project_id=' + encodeURIComponent(projectId)),
      api('../api/vote_stages.php?action=flow_status&project_id=' + encodeURIComponent(projectId))
    ]).then(function (results) {
      var projectData = results[0] || {};
      if (!projectData.success) { toast(projectData.message || '加载失败'); return; }
      state.selected = projectData.data;
      state.stages = projectData.stages || [];
      state.entries = results[1].success ? (results[1].data || []) : [];
      state.matches = results[2].success ? (results[2].data || []) : [];
      state.flow = results[3].success ? results[3] : null;
      state.poolPage = 1;
      state.poolFilter = 'all';
      state.poolStageTab = qualifierId ? String(qualifierId) : 'all';
      state.poolGroupTab = 'all';
      state.nominationQuery = '';
      state.stageEntriesCache = {};
      state.lastSettleIssues = [];
      if (qualifierId) {
        state.stageEntriesCache[String(qualifierId)] = qualifierEntries || [];
      }
      return loadMoeMatchesForStages().then(function () {
        renderProjectList();
        renderDetail();
      });
    });
  }

  function renderProjectList() {
    var host = $('manageList');
    var count = $('projectCount');
    if (count) count.textContent = state.projects.length + ' 个';
    if (!state.projects.length) {
      host.innerHTML = emptyStateMarkup('暂无可管理企划', '可以先创建草稿，或确认当前账号的同好会权限。');
      return;
    }
    host.innerHTML = state.projects.map(function (p) {
      var isMoe = p.project_type === 'moe';
      var active = state.selected && Number(state.selected.id) === Number(p.id);
      return '<div class="project-list-item' + (active ? ' active' : '') + '" data-project-id="' + Number(p.id) + '" role="button" tabindex="0" aria-current="' + (active ? 'true' : 'false') + '">' +
        '<span class="project-token ' + (isMoe ? 'moe' : 'twelve') + '">' + (isMoe ? '萌' : '12') + '</span>' +
        '<div class="project-info">' +
          '<div class="project-name">' + esc(p.title) + '</div>' +
          '<div class="project-meta">' + esc(clubDisplayName(p.club_id, p.country || 'china')) + ' · ' + statusLabel(p.status) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  /* ===== Create Form ===== */
  $('createType').addEventListener('click', function (e) {
    var btn = e.target.closest('.segmented-btn');
    if (!btn) return;
    var type = btn.dataset.type;
    state.createType = type;
    this.querySelectorAll('.segmented-btn').forEach(function (b) {
      b.classList.remove('active');
      var selected = b.dataset.type === type;
      b.setAttribute('aria-pressed', selected ? 'true' : 'false');
      if (selected) b.classList.add('active');
    });
    $('suffixField').style.display = type === 'twelve' ? 'block' : 'none';
    var submitBtn = $('createBtn');
    submitBtn.className = 'btn-submit ' + type;
    updateTitlePlaceholder();
  });

  $('suffixInput').addEventListener('input', function () {
    var val = this.value.replace(/[^一-龥]/g, '').slice(0, 1);
    this.value = val;
    var preview = $('suffixPreview');
    if (preview) preview.textContent = val || '器';
    updateTitlePlaceholder();
  });

  function updateTitlePlaceholder() {
    var title = $('createTitle');
    var isTwelve = state.createType === 'twelve';
    var suffix = ($('suffixInput').value || '器');
    if (isTwelve) {
      title.placeholder = '例如 2026 年度 Galgame 十二' + suffix + '评选';
    } else {
      title.placeholder = '例如 第二届年度萌王决定战';
    }
  }

  $('createToggle').addEventListener('click', function () {
    setCreateCardOpen(!$('createCard').classList.contains('open'));
  });

  $('createBtn').addEventListener('click', function () {
    var btn = this;
    var title = $('createTitle').value.trim();
    if (!title) { toast('请填写标题'); return; }
    if (!state.selectedClub) { toast('请选择所属同好会'); return; }
    var body = {
      project_type: state.createType,
      club_id: Number(state.selectedClub.id),
      country: state.selectedClub.country || $('createCountry').value,
      title: title,
      year_label: $('createYear').value.trim() || String(new Date().getFullYear()),
      visibility: $('createVisibility').value,
      eligibility_mode: $('createEligibility').value,
      result_visibility: $('createResultVisibility').value,
      description: $('createDescription').value.trim()
    };
    var restore = setButtonBusy(btn, '创建中...');
    post('../api/vote_projects.php?action=create', body).then(function (data) {
      toast(data.success ? '企划已创建' : (data.message || '创建失败'));
      if (data.success) {
        setCreateCardOpen(false);
        $('createTitle').value = '';
        $('createDescription').value = '';
        $('suffixInput').value = '';
        clearClubSelection();
        loadManageable().then(function () {
          if (data.id) selectProject(data.id);
        });
      }
    }).finally(function () {
      restore();
    });
  });

  /* ===== Club Search ===== */
  var clubSearchTimer = null;

  (function initClubSearch() {
    var wrap = $('clubSearchInput');
    var outer = $('clubSearchWrap');
    var realInput = $('clubSearchReal');
    if (!realInput) return;
    realInput.autocomplete = 'off';
    realInput.setAttribute('aria-label', '搜索同好会');
    realInput.setAttribute('aria-controls', 'clubSearchResults');

    realInput.addEventListener('input', function () {
      clearTimeout(clubSearchTimer);
      var q = this.value.trim();
      clubSearchTimer = setTimeout(function () { performClubSearch(q); }, 200);
    });

    realInput.addEventListener('focus', function () {
      if (!state.selectedClub) performClubSearch(this.value.trim());
    });

    realInput.addEventListener('keydown', function (e) {
      var results = $('clubSearchResults');
      if (e.key === 'Escape') {
        results.classList.remove('visible');
        setClubSearchExpanded(false);
      } else if (e.key === 'Enter') {
        var first = results.querySelector('.search-result-item');
        if (first && results.classList.contains('visible')) {
          e.preventDefault();
          first.click();
        }
      }
    });

    wrap.addEventListener('click', function (e) {
      if (e.target.closest('#clubSearchClear')) return;
      if (!state.selectedClub) realInput.focus();
    });

    document.addEventListener('click', function (e) {
      if (!outer.contains(e.target)) {
        $('clubSearchResults').classList.remove('visible');
        setClubSearchExpanded(false);
      }
    });
  })();

  function performClubSearch(query) {
    var results = $('clubSearchResults');
    var clubs = allClubs();
    if (!clubs.length) {
      results.innerHTML = loadingMarkup('俱乐部数据加载中');
      results.classList.add('visible');
      setClubSearchExpanded(true);
      return;
    }
    var q = normalizeSearchText(query);
    var filtered = clubs.filter(function (c) { return clubMatchesQuery(c, q); }).slice(0, 10);

    if (!filtered.length) {
      results.innerHTML = '<div class="search-result-empty">未找到匹配的同好会<br><span>可尝试输入学校名、同好会简称或地区。</span></div>';
      results.classList.add('visible');
      setClubSearchExpanded(true);
      return;
    }

    results.innerHTML = filtered.map(function (c, index) {
      var country = c.country || 'china';
      var name = clubSearchName(c);
      var meta = clubSearchMeta(c);
      return '<div class="search-result-item" role="option" tabindex="0" data-result-index="' + index + '">' +
        '<div class="search-result-token" style="background:' + (country === 'japan' ? 'rgba(244,114,182,0.1)' : 'rgba(47,111,237,0.1)') + ';color:' + (country === 'japan' ? 'var(--am-moe-color)' : 'var(--am-twelve-color)') + ';">' + (country === 'japan' ? '日' : '中') + '</div>' +
        '<div class="search-result-copy"><div class="search-result-name">' + esc(name || '未命名') + '</div>' +
        '<div class="search-result-meta">' + esc(meta) + '</div></div>' +
      '</div>';
    }).join('');

    results.classList.add('visible');
    setClubSearchExpanded(true);

    results.querySelectorAll('.search-result-item').forEach(function (item) {
      item.addEventListener('click', function () {
        var club = filtered[Number(this.dataset.resultIndex)];
        if (!club) return;
        selectClub({
          id: club.id,
          name: clubSearchName(club),
          country: club.country || 'china'
        });
        results.classList.remove('visible');
        setClubSearchExpanded(false);
        $('clubSearchReal').value = '';
      });
      item.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.click();
        } else if (e.key === 'Escape') {
          results.classList.remove('visible');
          setClubSearchExpanded(false);
          $('clubSearchReal').focus();
        }
      });
    });
  }

  function selectClub(club) {
    state.selectedClub = club;
    $('clubSearchPlaceholder').style.display = 'none';
    var chip = $('clubSearchChip');
    chip.style.display = 'inline-flex';
    $('clubSearchChipName').textContent = club.name;
    $('clubSearchReal').style.display = 'none';
    if ($('createCountry')) $('createCountry').value = club.country || 'china';
  }

  function clearClubSelection() {
    state.selectedClub = null;
    $('clubSearchPlaceholder').style.display = '';
    $('clubSearchChip').style.display = 'none';
    $('clubSearchReal').style.display = '';
    $('clubSearchReal').value = '';
    $('clubSearchResults').classList.remove('visible');
    setClubSearchExpanded(false);
    $('clubSearchReal').focus();
  }

  $('clubSearchClear').addEventListener('click', function (e) {
    e.stopPropagation();
    clearClubSelection();
  });

  /* ===== Stage Labels ===== */
  var STAGE_TYPE_LABELS = {
    nomination: '提名期',
    qualifier: '海选池',
    group_vote: '分组投票',
    bracket: '淘汰赛',
    final: '决赛'
  };

  var VOTE_MODE_LABELS = {
    nomination: '提名投票',
    multi_select: '多选投票',
    score: '评分制',
    match_single: '1v1对决'
  };

  /* ===== Detail Rendering ===== */
  function renderDetail() {
    var host = $('detailArea');
    var p = state.selected;
    if (!p) {
      host.innerHTML = '<div class="empty-state"><div class="empty-state-inner"><svg width="48" height="48" viewBox="0 0 48 48" fill="none" style="margin:0 auto 12px;opacity:0.3;"><rect x="8" y="8" width="32" height="32" rx="4" stroke="var(--am-text-secondary)" stroke-width="1.5" fill="none"/><line x1="24" y1="16" x2="24" y2="32" stroke="var(--am-text-secondary)" stroke-width="1.5"/><line x1="16" y1="24" x2="32" y2="24" stroke="var(--am-text-secondary)" stroke-width="1.5"/></svg><p>选择一个企划开始管理</p></div></div>';
      return;
    }
    var isMoe = p.project_type === 'moe';
    var stageRows = state.stages.map(function (s) { return renderStageRow(s, isMoe); }).join('');

    host.innerHTML =
      renderProjectHeader(p) +
      renderProjectSettingsCard(p) +
      '<div class="card"><div class="card-header"><span>赛程阶段</span></div>' +
      '<div class="card-body card-body--stack">' + (stageRows || '<div class="workbench-empty">暂无阶段数据</div>') + '</div></div>' +
      renderPoolCard() +
      (isMoe ? renderAwardsCard() : '');

    bindDetailEvents();
    renderPoolContent();
    renderMatchContent();
    if (isMoe) loadCurrentMoeKing();
  }

  function renderProjectHeader(p) {
    return '<div class="card"><div class="card-body">' +
      '<div class="project-header">' +
        '<div><h3>' + esc(p.title) + '</h3>' +
        '<div class="project-header-meta">' +
          '<span>' + typeLabel(p.project_type) + '</span><span>·</span>' +
          '<span>' + esc(clubDisplayName(p.club_id, p.country || 'china')) + '</span><span>·</span>' +
          '<span>' + (p.country === 'japan' ? '日本' : '中国') + '</span><span>·</span>' +
          '<span>' + esc(p.year_label || '') + '</span><span>·</span>' +
          '<span class="' + (p.status === 'running' ? 'project-header-status' : '') + '">' + statusLabel(p.status) + '</span>' +
        '</div></div>' +
        '<div class="project-header-actions">' +
          '<button class="stage-btn" data-action="share">分享</button>' +
          '<button class="stage-btn primary" data-action="publish">发布</button>' +
          '<button class="stage-btn" data-action="archive">归档</button>' +
          '<button class="stage-btn danger" data-action="delete">删除</button>' +
        '</div>' +
      '</div></div></div>';
  }

  function resultVisibilityOptions(current) {
    var options = [
      ['live_rank_only', '实时排名'],
      ['live_votes', '实时票数'],
      ['after_stage', '阶段后公开'],
      ['after_event', '活动结束后公开'],
      ['hidden', '隐藏']
    ];
    return options.map(function (item) {
      return '<option value="' + item[0] + '"' + (current === item[0] ? ' selected' : '') + '>' + item[1] + '</option>';
    }).join('');
  }

  function renderProjectSettingsCard(p) {
    var eligibility = p.eligibility_mode === 'public' ? 'public' : 'club_member';
    var unsupportedEligibility = p.eligibility_mode && ['club_member', 'public'].indexOf(p.eligibility_mode) === -1;
    return '<div class="card"><div class="card-header"><span>活动设置</span><span class="card-header-note">影响活动基础信息与默认公开策略</span></div>' +
      '<div class="card-body card-body--stack project-settings" id="projectSettings">' +
        '<div class="form-row">' +
          '<div class="form-field"><label class="field-label" for="projectTitle">标题</label><input class="form-input" id="projectTitle" value="' + esc(p.title || '') + '"></div>' +
          '<div class="form-field"><label class="field-label" for="projectYear">年份</label><input class="form-input" id="projectYear" value="' + esc(p.year_label || '') + '"></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-field"><label class="field-label" for="projectVisibility">可见性</label><select class="form-select" id="projectVisibility">' +
            '<option value="public"' + (p.visibility === 'public' ? ' selected' : '') + '>公开浏览</option>' +
            '<option value="club_only"' + (p.visibility === 'club_only' ? ' selected' : '') + '>成员可见</option>' +
            '<option value="unlisted"' + (p.visibility === 'unlisted' ? ' selected' : '') + '>不列入广场</option>' +
          '</select></div>' +
          '<div class="form-field"><label class="field-label" for="projectEligibility">参与资格</label><select class="form-select" id="projectEligibility">' +
            '<option value="club_member"' + (eligibility === 'club_member' ? ' selected' : '') + '>同好会成员</option>' +
            '<option value="public"' + (eligibility === 'public' ? ' selected' : '') + '>登录用户</option>' +
          '</select>' + (unsupportedEligibility ? '<div class="modal-field-hint">当前历史配置为未开放模式，保存后会改为可用模式。</div>' : '') + '</div>' +
        '</div>' +
        '<div class="form-field"><label class="field-label" for="projectResultVisibility">默认结果公开</label><select class="form-select" id="projectResultVisibility">' + resultVisibilityOptions(p.result_visibility || 'live_rank_only') + '</select><div class="modal-field-hint">用于活动级默认值；已生成阶段仍以各阶段配置为准。</div></div>' +
        '<div class="form-field"><span class="field-label">分享参与</span>' +
          '<label class="guest-vote-toggle"><input type="checkbox" id="projectGuestVote"' + (Number(p.guest_vote) === 1 ? ' checked' : '') + '>' +
          '<span>允许通过分享链接免登录投票</span></label>' +
          '<div class="modal-field-hint">开启后，持有分享链接的访客无需注册登录即可参与各阶段投票；同一设备计一票。使用管理页「分享」按钮生成链接与二维码。</div></div>' +
        '<div class="form-field"><label class="field-label" for="projectDescription">说明</label><textarea class="form-textarea" id="projectDescription">' + esc(p.description || '') + '</textarea></div>' +
        '<div class="project-settings-actions"><button class="stage-btn primary" id="projectSettingsSave" type="button">保存活动设置</button></div>' +
      '</div></div>';
  }

  function deprecatedNominationFlow(btn) {
    return rebuildFlowFromNomination(btn);
  }

  function rebuildFlowFromNomination(btn) {
    console.log('[rebuildFlowFromNomination] clicked, project=' + (state.selected ? state.selected.id : 'null'));
    if (!state.selected) return;
    if (state.rebuildFlowInFlight) {
      console.log('[rebuildFlowFromNomination] skipped: already in flight');
      return;
    }
    state.rebuildFlowInFlight = true;
    if (btn) { btn.disabled = true; btn.textContent = '生成中...'; }
    return post('../api/vote_stages.php?action=rebuild_from_nomination_and_open', { project_id: Number(state.selected.id) }).then(function (data) {
      console.log('[rebuildFlowFromNomination] response', data);
      if (!data.success) {
        toast(data.message || '生成海选池失败');
        if (state.selected) selectProject(state.selected.id);
        return;
      }
      state.stageEntriesCache = {};
      var qualifierId = Number(data.qualifier_stage_id || data.stage_id || data.target_stage_id || 0);
      return (qualifierId ? loadStageEntries(qualifierId) : Promise.resolve([])).then(function (entries) {
        var seeded = Number(data.seeded_count || 0);
        var readback = Number(data.readback_count || entries.rawCount || entries.length || 0);
        if (seeded !== readback || seeded !== entries.length) {
          toast('海选池生成异常：写入 ' + seeded + '，读取 ' + readback + '，请刷新后重试');
          if (state.selected) return selectProject(state.selected.id);
          return;
        }
        toast('已生成并打开海选池 · ' + seeded);
        if (state.selected) return reloadProjectWithQualifierPool(state.selected.id, qualifierId, entries);
      });
    }).catch(function (error) {
      console.error('[rebuildFlowFromNomination] request failed', error);
      toast('生成海选池失败，请刷新后重试');
      if (state.selected) selectProject(state.selected.id);
    }).finally(function () {
      state.rebuildFlowInFlight = false;
      if (btn) { btn.disabled = false; btn.textContent = '生成海选池并打开海选'; }
    });
  }

  function entryLabelById(entryId) {
    var id = Number(entryId);
    var row = (state.entries || []).find(function (item) {
      return Number(item.entry_id || item.id) === id;
    });
    if (!row) return '候选 #' + id;
    return row.title_cn || row.title || row.name || ('候选 #' + id);
  }

  function closeTieModal() {
    $('tieModal').style.display = 'none';
    state.tieDecision = null;
  }

  function openTieModal(poolId, btn) {
    var reviewingPool = state.flow && Array.isArray(state.flow.pools)
      ? state.flow.pools.find(function (pool) { return Number(pool.id) === Number(poolId); })
      : null;
    var tieBreaks = reviewingPool && reviewingPool.runtime && reviewingPool.runtime.tie_breaks;
    if (!Array.isArray(tieBreaks) || !tieBreaks.length) {
      toast('没有可裁定的晋级线同分');
      return;
    }
    state.tieDecision = { poolId: Number(poolId), button: btn, tieBreaks: tieBreaks };
    var body = '<div class="tie-modal-list">';
    tieBreaks.forEach(function (tie, index) {
      var group = String(tie.group_key || ('G' + (index + 1)));
      var slots = Math.max(1, Number(tie.slots || 1));
      body += '<section class="tie-group" data-tie-index="' + index + '" data-slots="' + slots + '">' +
        '<div class="tie-group-head"><strong>' + esc(group) + '</strong><span>请选择 ' + slots + ' 项晋级</span></div>' +
        '<div class="tie-candidate-list">';
      (tie.entry_ids || []).forEach(function (entryId) {
        var id = Number(entryId);
        body += '<label class="tie-candidate">' +
          '<input type="checkbox" data-tie-choice="' + index + '" value="' + id + '">' +
          '<span><strong>' + esc(entryLabelById(id)) + '</strong><small>#' + id + '</small></span>' +
        '</label>';
      });
      body += '</div></section>';
    });
    body += '</div>';
    $('tieModalBody').innerHTML = body;
    $('tieModal').style.display = 'flex';
    var first = $('tieModal').querySelector('input, button');
    if (first) first.focus();
  }

  function submitTieDecision() {
    if (!state.tieDecision) return;
    var decisions = [];
    for (var i = 0; i < state.tieDecision.tieBreaks.length; i++) {
      var tie = state.tieDecision.tieBreaks[i];
      var slots = Math.max(1, Number(tie.slots || 1));
      var checked = Array.prototype.slice.call(document.querySelectorAll('[data-tie-choice="' + i + '"]:checked'));
      if (checked.length !== slots) {
        toast(String(tie.group_key || '分组') + ' 需要选择 ' + slots + ' 项');
        return;
      }
      decisions.push({
        group_key: tie.group_key,
        entry_ids: checked.map(function (input) { return Number(input.value); })
      });
    }
    var submit = $('tieModalSubmit');
    var restoreModalBtn = setButtonBusy(submit, '提交中...');
    var flowBtn = state.tieDecision.button;
    var restoreFlowBtn = setButtonBusy(flowBtn, '提交中...');
    post('../api/vote_stages.php?action=resolve_flow_tie', {
      pool_id: state.tieDecision.poolId,
      decisions: decisions
    }).then(function (data) {
      toast(data.success ? '同分裁定已提交' : (data.message || '裁定失败'));
      closeTieModal();
      if (state.selected) selectProject(state.selected.id);
    }).finally(function () {
      restoreModalBtn();
      restoreFlowBtn();
    });
  }

  function runFlowAction(action, poolId, btn) {
    if (!state.selected || !poolId) return;
    if (action === 'resolve_flow_tie') {
      openTieModal(poolId, btn);
      return;
    }
    if (action === 'generate_matches') {
      var stage = state.stages.find(function (s) {
        var pool = getFlowPoolForStage(s);
        return pool && Number(pool.id) === Number(poolId);
      });
      if (!stage) return;
      var restoreGenerateBtn = setButtonBusy(btn, '生成中...');
      post('../api/vote_matches.php?action=generate', { stage_id: Number(stage.id) }).then(function (data) {
        toast(data.success ? '对阵已生成' : (data.message || '生成失败'));
        if (state.selected) selectProject(state.selected.id);
      }).finally(function () {
        restoreGenerateBtn();
      });
      return;
    }
    if (action === 'settle_by_votes') {
      var settleStage = state.stages.find(function (s) {
        var pool = getFlowPoolForStage(s);
        return pool && Number(pool.id) === Number(poolId);
      });
      if (!settleStage) return;
      var restoreSettleBtn = setButtonBusy(btn, '结算中...');
      post('../api/vote_matches.php?action=settle_by_votes', { stage_id: Number(settleStage.id) }).then(function (data) {
        var msg = data.success ? ('已按票数结算 ' + Number(data.settled_count || 0) + ' 场') : (data.message || '结算失败');
        if (data.success && Number(data.unresolved_count || 0) > 0) msg += ' · 平票/缺项 ' + Number(data.unresolved_count || 0) + ' 场';
        var issues = data.success ? (data.unresolved || []) : [];
        toast(msg);
        if (state.selected) {
          selectProject(state.selected.id).then(function () {
            state.lastSettleIssues = issues;
            renderMatchContent();
          });
        }
      }).finally(function () {
        restoreSettleBtn();
      });
      return;
    }
    var restoreFlowBtn = setButtonBusy(btn, '处理中...');
    post('../api/vote_stages.php?action=' + encodeURIComponent(action), { pool_id: Number(poolId) }).then(function (data) {
      var flowMsg = data.success ? '流程已更新' : (data.message || '操作失败');
      if (data.success && data.status === 'reviewing') flowMsg = '已结算：存在同分，请完成平票裁定';
      else if (data.success && data.status === 'settled') flowMsg = '已结算完成';
      toast(flowMsg);
      if (state.selected) selectProject(state.selected.id);
    }).catch(function () {
      toast('操作失败，请重试');
    }).finally(function () {
      restoreFlowBtn();
    });
  }

  function renderStageRow(s, isMoe) {
    var typeLabelText = STAGE_TYPE_LABELS[s.stage_type] || s.stage_type;
    var typeClass = s.stage_type;
    var isNominationStage = s.stage_type === 'nomination';
    var canUseLegacySettlement = s.stage_type !== 'nomination';
    if (isMoe && s.stage_type === 'qualifier') { typeClass = 'qualifier'; typeLabelText = '海选池'; }
    var summary = buildStageSummary(s);
    var flowPool = getFlowPoolForStage(s);
    var shouldRebuild = s.stage_type === 'qualifier' && !flowPool;
    var primaryAction = shouldRebuild
      ? '<button class="stage-btn primary" data-rebuild-flow>生成海选池并打开海选</button>'
      : (s.status !== 'open' ? '<button class="stage-btn primary" data-stage-action="open" data-stage-id="' + Number(s.id) + '">开放</button>' : '');
    var flowActions = flowPool ? renderStageActions(s).replace('<span class="stage-actions">', '').replace('</span>', '') : '';
    var rowActions = '<button class="stage-btn edit-active" data-stage-edit="' + Number(s.id) + '">编辑</button>' +
      (flowPool ? flowActions : (
        primaryAction +
        (s.status === 'open' ? '<button class="stage-btn" data-stage-action="lock" data-stage-id="' + Number(s.id) + '">锁定</button>' : '') +
        (isNominationStage ? '<button class="stage-btn primary" data-rebuild-flow>生成海选池并打开海选</button>' : '') +
        (canUseLegacySettlement && s.status !== 'reviewing' ? '<button class="stage-btn success" data-stage-action="settle" data-stage-id="' + Number(s.id) + '">结算</button>' : '') +
        (canUseLegacySettlement && s.status === 'reviewing' ? '<button class="stage-btn primary" data-stage-action="resolve_tie" data-stage-id="' + Number(s.id) + '">裁定平票</button>' : '')
      ));
    return '<div class="stage-row" data-stage-id="' + Number(s.id) + '">' +
      '<span class="stage-tag ' + typeClass + '">' + typeLabelText + '</span>' +
      '<span class="stage-main">' +
        '<span class="stage-title" title="' + esc(s.title) + '">' + esc(s.title) + '</span>' +
        '<span class="stage-summary" title="' + esc(summary) + '">' + esc(summary) + '</span>' +
      '</span>' +
      '<span class="stage-status ' + (s.status === 'open' ? 'open' : (s.status === 'reviewing' ? 'reviewing' : 'pending')) + '">' + (s.status === 'open' ? '开放中' : (s.status === 'locked' ? '已锁定' : (s.status === 'reviewing' ? '待裁定' : '待开放'))) + '</span>' +
      '<span class="stage-actions">' +
        rowActions +
      '</span>' +
    '</div>';
  }

  function buildStageSummary(s) {
    var flowPool = getFlowPoolForStage(s);
    if (flowPool && flowPool.runtime) s = Object.assign({}, s, flowPool.runtime);
    if (state.selected && state.selected.project_type === 'moe' && s.vote_mode === 'match_single') {
      if (s.stage_type === 'final') return '1v1 · 冠军赛 + 季军赛';
      if (flowPool) {
        s = Object.assign({}, s, {
          config_json: JSON.stringify({ bracket_size: Number(flowPool.entry_count || 0) })
        });
      }
    }
    var parts = [];
    var modeLabel = VOTE_MODE_LABELS[s.vote_mode] || s.vote_mode;
    parts.push(modeLabel);
    if (s.vote_mode === 'nomination') {
      parts.push('每人' + Number(s.max_select || 1) + '个');
    } else if (s.vote_mode === 'multi_select') {
      parts.push('每人' + Number(s.max_select || 1) + '票');
      if (Number(s.group_count) > 1) parts.push(Number(s.group_count) + '组');
    } else if (s.vote_mode === 'score') {
      parts.push(Number(s.score_min || 1) + '~' + Number(s.score_max || 10) + '分');
      if (Number(s.group_count) > 1) parts.push(Number(s.group_count) + '组');
    } else if (s.vote_mode === 'match_single') {
      var config = parseConfig(s.config_json);
      var size = Number(config.bracket_size || s.advance_count || 16);
      parts.push(size + '强');
    }
    parts.push('晋级' + Number(s.advance_count || 0));
    return parts.join(' · ');
  }

  /* ===== Share Modal ===== */
  function shareLinkFor(p, token) {
    var base = p.project_type === 'moe' ? '../moe/contest.html' : '../twelve/contest.html';
    return new URL(base + '?id=' + encodeURIComponent(p.id) + '&share=' + encodeURIComponent(token), window.location.href).href;
  }

  function openShareModal(btn) {
    var p = state.selected;
    if (!p) return;
    var restore = btn ? setButtonBusy(btn, '生成中...') : function () {};
    post('../api/vote_projects.php?action=share&id=' + encodeURIComponent(p.id), {}).then(function (data) {
      if (!data || !data.success || !data.share_token) {
        toast((data && data.message) || '获取分享链接失败');
        return;
      }
      renderShareModal(p, String(data.share_token), Number(data.guest_vote) === 1, String(data.status || ''));
    }).catch(function (err) {
      toast((err && err.message) || '获取分享链接失败');
    }).finally(restore);
  }

  function renderShareModal(p, token, guestVote, status) {
    var link = shareLinkFor(p, token);
    var isMoe = p.project_type === 'moe';
    var tag = $('shareModalTag');
    tag.textContent = isMoe ? '萌战' : '十二器';
    tag.className = 'stage-tag ' + (isMoe ? 'nomination' : 'reviewing');
    $('shareModalTitle').textContent = '分享 · ' + (p.title || '企划');
    var guestNote = guestVote
      ? (status === 'running'
        ? '免登录投票已开启：访客打开此链接即可直接参与投票，无需登录。'
        : '免登录投票已开启；活动发布并处于进行中后，分享链接即可免登录参与。')
      : '免登录投票未开启：访客打开链接需要登录并满足参与资格。可在「活动设置 → 分享参与」中开启。';
    $('shareModalBody').innerHTML =
      '<div class="share-qr-wrap"><div id="shareQrHost" class="share-qr" role="img" aria-label="分享链接二维码"></div></div>' +
      '<div class="share-field"><span class="field-label">分享链接</span>' +
        '<div class="share-link-row"><input class="form-input" id="shareLinkInput" readonly value="' + esc(link) + '" aria-label="分享链接">' +
        '<button class="stage-btn primary" id="shareCopyBtn" type="button">复制</button></div></div>' +
      '<div class="share-note">' +
        '<p class="' + (guestVote ? 'share-note-ok' : 'share-note-warn') + '">' + esc(guestNote) + '</p>' +
        '<p class="modal-field-hint">二维码与链接指向活动详情页，访客按阶段参与投票；免登录模式下同一设备每个阶段计一票。</p>' +
      '</div>';
    var qrHost = $('shareQrHost');
    try {
      var qr = qrcode(0, 'M');
      qr.addData(link);
      qr.make();
      qrHost.innerHTML = qr.createSvgTag(4, 2);
    } catch (e) {
      qrHost.innerHTML = '<div class="modal-field-hint">二维码生成失败，请直接复制链接。</div>';
    }
    $('shareModal').style.display = 'flex';
    $('shareCopyBtn').addEventListener('click', function () {
      copyShareText($('shareLinkInput').value).then(function (ok) {
        toast(ok ? '链接已复制' : '复制失败，请手动选择链接复制');
      });
    });
  }

  function copyShareText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return legacyCopyShareText(text); });
    }
    return Promise.resolve(legacyCopyShareText(text));
  }

  function legacyCopyShareText(text) {
    var input = $('shareLinkInput');
    if (!input) return false;
    input.removeAttribute('readonly');
    input.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    input.setAttribute('readonly', 'readonly');
    if (window.getSelection) window.getSelection().removeAllRanges();
    return ok;
  }

  function closeShareModal() {
    $('shareModal').style.display = 'none';
  }

  // ===== Legacy 平票裁定弹窗（非 flow 阶段 reviewing → resolve_tie） =====
  function openLegacyTieModal(stageId) {
    var stage = (state.stages || []).find(function (s) { return Number(s.id) === Number(stageId); });
    if (!stage) { toast('阶段数据未加载，请刷新后重试'); return; }
    var tie = parseConfig(stage.config_json || '{}').tie_break;
    if (!tie || !Array.isArray(tie.candidate_entry_ids) || !tie.candidate_entry_ids.length) {
      toast('未找到平票候选信息，请尝试重新结算');
      return;
    }
    var slots = Math.max(1, Number(tie.slots || 1));
    var nameOf = function (id) {
      var e = (state.entries || []).find(function (en) { return Number(en.id) === Number(id); });
      return e ? (e.title_cn || e.title || ('#' + id)) : ('#' + id);
    };
    $('legacyTieTitle').textContent = '同分裁定 · ' + (stage.title || '');
    var rows = tie.candidate_entry_ids.map(function (id) {
      return '<label class="legacy-tie-choice"><input type="checkbox" value="' + Number(id) + '" data-legacy-tie-candidate> <span>' + esc(nameOf(id)) + '</span></label>';
    }).join('');
    $('legacyTieBody').innerHTML =
      '<p class="modal-field-hint">晋级名额剩 ' + slots + ' 个，请从同分候选中选择；确认后阶段完成结算。</p>' +
      '<div class="legacy-tie-list">' + rows + '</div>';
    $('legacyTieModal').style.display = 'flex';
    $('legacyTieSubmit').onclick = function () {
      var picked = Array.prototype.slice.call($('legacyTieBody').querySelectorAll('input[data-legacy-tie-candidate]:checked')).map(function (i) { return Number(i.value); });
      if (picked.length !== slots) { toast('请选择 ' + slots + ' 个晋级'); return; }
      var restoreTie = setButtonBusy($('legacyTieSubmit'), '提交中...');
      post('../api/vote_stages.php?action=resolve_tie&id=' + encodeURIComponent(stageId), { entry_ids: picked }).then(function (data) {
        if (data && data.success) {
          closeLegacyTieModal();
          toast('裁定完成，阶段已结算');
          if (state.selected) selectProject(state.selected.id);
        } else {
          toast((data && data.message) || '裁定失败');
        }
      }).catch(function () { toast('裁定失败'); }).finally(restoreTie);
    };
  }
  function closeLegacyTieModal() { $('legacyTieModal').style.display = 'none'; }
  $('legacyTieClose').addEventListener('click', closeLegacyTieModal);
  $('legacyTieCancel').addEventListener('click', closeLegacyTieModal);
  $('legacyTieModal').addEventListener('click', function (e) { if (e.target === this) closeLegacyTieModal(); });
  $('shareModalClose').addEventListener('click', closeShareModal);
  $('shareModalCloseBtn').addEventListener('click', closeShareModal);
  $('shareModal').addEventListener('click', function (e) {
    if (e.target === this) closeShareModal();
  });

  /* ===== Detail Event Binding ===== */
  function bindDetailEvents() {
    var settingsSave = $('projectSettingsSave');
    if (settingsSave) {
      settingsSave.addEventListener('click', function () {
        if (!state.selected) return;
        var body = {
          title: $('projectTitle').value.trim(),
          year_label: $('projectYear').value.trim(),
          visibility: $('projectVisibility').value,
          eligibility_mode: $('projectEligibility').value,
          result_visibility: $('projectResultVisibility').value,
          guest_vote: $('projectGuestVote') && $('projectGuestVote').checked ? 1 : 0,
          description: $('projectDescription').value.trim(),
          config: state.selected.config || {}
        };
        if (!body.title) { toast('请填写活动标题'); return; }
        var restore = setButtonBusy(settingsSave, '保存中...');
        post('../api/vote_projects.php?action=update&id=' + encodeURIComponent(state.selected.id), body).then(function (data) {
          toast(data.success ? '活动设置已保存' : (data.message || '保存失败'));
          if (data.success) selectProject(state.selected.id);
        }).finally(function () {
          restore();
        });
      });
    }

    document.querySelectorAll('[data-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = this.dataset.action;
        if (!state.selected) return;
        if (action === 'share') { openShareModal(this); return; }
        if (action === 'delete' && !confirm('确定删除该企划及全部数据？此操作不可撤销。')) return;
        if (action === 'publish') {
          var stageTotal = (state.stages || []).length;
          if (!stageTotal) { toast('请先配置赛程阶段再发布'); return; }
          var stageOpen = (state.stages || []).filter(function (s) { return s.status === 'open'; }).length;
          if (!confirm('确认发布该企划？共 ' + stageTotal + ' 个阶段（开放中 ' + stageOpen + '）。发布后用户即可访问。')) return;
        }
        var restore = setButtonBusy(this, action === 'delete' ? '删除中...' : '处理中...');
        post('../api/vote_projects.php?action=' + action + '&id=' + state.selected.id, {}).then(function (data) {
          toast(data.success ? '操作完成' : (data.message || '操作失败'));
          state.selected = null;
          loadManageable();
        }).finally(function () {
          restore();
        });
      });
    });

    document.querySelectorAll('[data-stage-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () { openStageModal(this.dataset.stageEdit); });
    });

    document.querySelectorAll('[data-stage-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = this.dataset.stageAction;
        var id = this.dataset.stageId;
        if (action === 'resolve_tie') { openLegacyTieModal(id); return; }
        var restore = setButtonBusy(this, action === 'settle' ? '结算中...' : '处理中...');
        post('../api/vote_stages.php?action=' + action + '&id=' + encodeURIComponent(id), {}).then(function (data) {
          var msg = data.success ? '阶段已更新' : (data.message || '操作失败');
          if (data.success && action === 'open' && data.seeded_count != null) msg += ' · 候选 ' + Number(data.seeded_count);
          if (data.success && action === 'settle' && data.advanced_count != null) msg += ' · 晋级 ' + Number(data.advanced_count);
          if (data.success && (data.status === 'reviewing' || (data.config && data.config.tie_break))) msg = '已结算：存在同分，请对该阶段完成裁定';
          toast(msg);
          if (state.selected) selectProject(state.selected.id);
        }).catch(function () {
          toast('操作失败，请重试');
        }).finally(function () {
          restore();
        });
      });
    });

    document.querySelectorAll('[data-flow-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        runFlowAction(this.dataset.flowAction, this.dataset.poolId, btn);
      });
    });

    document.querySelectorAll('[data-match-winner]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        settleMatch(this.dataset.matchWinner, this.dataset.winnerId);
      });
    });
  }

  /* ===== Modal ===== */
  function allowedVoteModesForStage(s) {
    if (!s) return [];
    if (s.stage_type === 'nomination') return [{ value: 'nomination', label: '提名投票' }];
    if (s.stage_type === 'bracket' || (s.stage_type === 'final' && state.selected && state.selected.project_type === 'moe')) {
      return [{ value: 'match_single', label: '1v1 对决' }];
    }
    return [
      { value: 'multi_select', label: '多选投票' },
      { value: 'score', label: '评分制' }
    ];
  }

  function openStageModal(stageId) {
    var s = state.stages.find(function (st) { return Number(st.id) === Number(stageId); });
    if (!s) return;
    state.editingStageId = stageId;
    state.modalReturnFocus = document.activeElement;
    var config = parseConfig(s.config_json);

    var tag = $('modalStageTag');
    tag.textContent = STAGE_TYPE_LABELS[s.stage_type] || s.stage_type;
    tag.className = 'stage-tag ' + (s.stage_type);
    $('modalStageTitle').textContent = '编辑：' + (s.title || '');

    var voteModes = allowedVoteModesForStage(s);
    if (!voteModes.some(function (m) { return m.value === s.vote_mode; })) s.vote_mode = voteModes[0].value;

    var html = '<div class="form-field modal-mode-field"><label class="field-label">投票方式</label><div class="segmented" id="modalVoteMode">';
    voteModes.forEach(function (m) {
      var active = s.vote_mode === m.value;
      html += '<button class="segmented-btn' + (active ? ' active' : '') + '" type="button" data-mode="' + m.value + '" aria-pressed="' + (active ? 'true' : 'false') + '">' + m.label + '</button>';
    });
    html += '</div></div>';
    html += '<div id="modalFields" class="modal-field-stack">';
    html += buildModalFields(s, config);
    html += '</div>';
    html += '<div class="modal-logic-hint" id="modalLogicHint"></div>';

    $('modalBody').innerHTML = html;
    updateModalFieldVisibility(s.vote_mode);
    updateModalLogicHint(s.vote_mode);
    updateGroupAdvancePreview();
    $('modalBody').addEventListener('input', function (e) {
      if (e.target.id === 'mfGroupCount' || e.target.id === 'mfAdvance') {
        updateGroupAdvancePreview();
      }
    });

    $('stageModal').style.display = 'flex';
    setTimeout(function () {
      var firstInput = $('stageModal').querySelector('input, select, button');
      if (firstInput) firstInput.focus();
    }, 0);

    $('modalVoteMode').addEventListener('click', function (e) {
      var btn = e.target.closest('.segmented-btn');
      if (!btn) return;
      var mode = btn.dataset.mode;
      this.querySelectorAll('.segmented-btn').forEach(function (b) {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      s.vote_mode = mode;
      $('modalFields').innerHTML = buildModalFields(s, config);
      updateModalFieldVisibility(mode);
      updateModalLogicHint(mode);
    });
  }

  function toDateTimeLocalValue(value) {
    if (!value) return '';
    return String(value).replace(' ', 'T').slice(0, 16);
  }

  function normalizeDateTimeLocal(value) {
    if (!value) return null;
    return String(value).replace('T', ' ') + ':00';
  }

  function isPowerOfTwo(value) {
    value = Number(value || 0);
    return value > 0 && (value & (value - 1)) === 0;
  }

  function knownStageEntryCount(stage) {
    var flowPool = getFlowPoolForStage(stage);
    if (flowPool && flowPool.entry_count != null) return Number(flowPool.entry_count || 0);
    if (flowPool && flowPool.raw_count != null) return Number(flowPool.raw_count || 0);
    return 0;
  }

  function buildModalFields(s, config) {
    var html = '';
    var mode = s.vote_mode;

    html += '<div class="form-row"><div class="form-field"><label class="field-label">阶段标题</label><input class="form-input" id="mfTitle" value="' + esc(s.title) + '"></div>';
    html += '<div class="form-field"><label class="field-label">晋级数</label><input class="form-input" id="mfAdvance" type="number" min="0" value="' + Number(s.advance_count || 0) + '"></div></div>';
    html += '<div class="form-field"><label class="field-label">结束时间 <span class="modal-field-hint">到点后停止投票</span></label><input class="form-input" id="mfEndsAt" type="datetime-local" value="' + esc(toDateTimeLocalValue(s.ends_at || '')) + '"></div>';
    if (getFlowPoolForStage(s)) {
      html += '<div class="modal-logic-hint"><strong>运行池已生成：</strong>投票方式、晋级数、分组数、评分范围和改票规则属于核心配置；无投票/对阵/结果时会重建运行池，已有数据后只能改标题、结束时间和结果公开。</div>';
    }

    if (mode !== 'match_single') {
      var maxLabel = mode === 'nomination' ? '每人可提名' : '每人可选';
      html += '<div class="form-field" data-field-group="multi"><label class="field-label">' + maxLabel + '</label><input class="form-input" id="mfMaxSelect" type="number" min="1" value="' + Number(s.max_select || 1) + '"></div>';
    }

    if (mode === 'multi_select' || mode === 'score') {
      html += '<div class="form-field" data-field-group="group"><label class="field-label">分组数 <span class="modal-field-hint">输入 1 表示不分组</span></label>';
      html += '<input class="form-input" id="mfGroupCount" type="number" min="1" value="' + Number(s.group_count || 1) + '">';
      if (s.stage_type === 'qualifier' || s.stage_type === 'group_vote') {
        html += '<div class="modal-field-hint" id="mfGroupAdvancePreview">每组晋级 ' + Math.floor(Number(s.advance_count || 0) / Number(s.group_count || 1)) + ' 人</div>';
      }
      html += '</div>';
    }

    if (mode === 'score') {
      html += '<div class="form-row"><div class="form-field" data-field-group="score"><label class="field-label">最低分 <span class="modal-field-hint">评分制</span></label><input class="form-input" id="mfScoreMin" type="number" min="1" value="' + Number(s.score_min || 1) + '"></div>';
      html += '<div class="form-field" data-field-group="score"><label class="field-label">最高分 <span class="modal-field-hint">评分制</span></label><input class="form-input" id="mfScoreMax" type="number" min="1" value="' + Number(s.score_max || 10) + '"></div></div>';
    }

    if (mode === 'match_single' && state.selected && state.selected.project_type === 'moe') {
      var qualifier = getStageByType('qualifier');
      var derivedSize = s.stage_type === 'final' ? 4 : Number((qualifier && qualifier.advance_count) || 0);
      html += '<div class="form-field" data-field-group="bracket"><label class="field-label">对阵规模</label><div class="modal-field-hint">' +
        (s.stage_type === 'final' ? '固定生成冠军赛和季军赛' : '由海选晋级数推导：' + derivedSize + ' 强') +
        '</div></div>';
    }

    if (mode === 'match_single' && (!state.selected || state.selected.project_type !== 'moe')) {
      var bracketSize = Number(config.bracket_size || s.advance_count || 16);
      html += '<div class="form-field" data-field-group="bracket"><label class="field-label">对阵规模 <span class="modal-field-hint">1v1</span></label>';
      html += '<div class="segmented" id="mfBracketSize">';
      [16, 32].forEach(function (n) {
        html += '<button class="segmented-btn' + (bracketSize === n ? ' active' : '') + '" data-value="' + n + '">' + n + ' 强</button>';
      });
      html += '</div></div>';
    }

    html += '<div class="form-field"><label class="field-label">结果公开</label><select class="form-select" id="mfResultVisibility">' +
      '<option value="live_votes"' + (s.result_visibility === 'live_votes' ? ' selected' : '') + '>实时票数</option>' +
      '<option value="live_rank_only"' + (s.result_visibility === 'live_rank_only' ? ' selected' : '') + '>实时排名</option>' +
      '<option value="after_stage"' + (s.result_visibility === 'after_stage' ? ' selected' : '') + '>阶段后公开</option>' +
      '<option value="after_event"' + (s.result_visibility === 'after_event' ? ' selected' : '') + '>活动结束后公开</option>' +
      '<option value="hidden"' + (s.result_visibility === 'hidden' ? ' selected' : '') + '>隐藏</option>' +
      '</select></div>';

    html += '<div class="modal-check-row">';
    html += '<label style="display:flex;align-items:center;gap:6px;font-size:13px;"><input type="checkbox" id="mfAllowChange"' + (Number(s.allow_vote_change) ? ' checked' : '') + '> 允许改票</label>';
    html += '<label style="display:flex;align-items:center;gap:6px;font-size:13px;"><input type="checkbox" id="mfZeroFill"' + (config.allow_zero_fill ? ' checked' : '') + '> 0票补位</label>';
    html += '</div>';

    return html;
  }

  function updateModalFieldVisibility(mode) {
    var scoreFields = document.querySelectorAll('[data-field-group="score"]');
    var groupFields = document.querySelectorAll('[data-field-group="group"]');
    var bracketFields = document.querySelectorAll('[data-field-group="bracket"]');
    var multiFields = document.querySelectorAll('[data-field-group="multi"]');

    scoreFields.forEach(function (el) { el.style.display = mode === 'score' ? '' : 'none'; });
    groupFields.forEach(function (el) { el.style.display = (mode === 'multi_select' || mode === 'score') ? '' : 'none'; });
    bracketFields.forEach(function (el) { el.style.display = mode === 'match_single' ? '' : 'none'; });
    multiFields.forEach(function (el) { el.style.display = mode !== 'match_single' ? '' : 'none'; });
  }

  function updateModalLogicHint(mode) {
    var hint = $('modalLogicHint');
    if (!hint) return;
    var hints = {
      nomination: '<strong>提名投票模式：</strong>用户提交提名，自动进入候选池。不涉及评分和分组。',
      multi_select: '<strong>多选投票模式：</strong>用户选择多个条目。可配置任意分组数（输入 1 表示不分组）。不涉及评分。',
      score: '<strong>评分制模式：</strong>用户对每个条目打分。显示最低分/最高分字段。可配置分组。',
      match_single: '<strong>1v1 对决模式：</strong>两两对决投票。显示对阵规模（16/32强）。不显示评分和分组字段。'
    };
    hint.innerHTML = hints[mode] || '';
  }

  function updateGroupAdvancePreview() {
    var groupEl = $('mfGroupCount');
    var advanceEl = $('mfAdvance');
    var previewEl = $('mfGroupAdvancePreview');
    if (!previewEl) return;
    var groupCount = Math.max(1, Number(groupEl ? groupEl.value : 1) || 1);
    var advanceCount = Math.max(0, Number(advanceEl ? advanceEl.value : 0) || 0);
    previewEl.textContent = '每组晋级 ' + (groupCount > 0 ? Math.floor(advanceCount / groupCount) : 0) + ' 人';
  }

  function closeStageModal() {
    $('stageModal').style.display = 'none';
    state.editingStageId = null;
    if (state.modalReturnFocus && typeof state.modalReturnFocus.focus === 'function') {
      state.modalReturnFocus.focus();
    }
    state.modalReturnFocus = null;
  }

  $('modalClose').addEventListener('click', closeStageModal);
  $('modalCancel').addEventListener('click', closeStageModal);
  $('stageModal').addEventListener('click', function (e) {
    if (e.target === this) closeStageModal();
  });
  $('tieModalClose').addEventListener('click', closeTieModal);
  $('tieModalCancel').addEventListener('click', closeTieModal);
  $('tieModalSubmit').addEventListener('click', submitTieDecision);
  $('tieModal').addEventListener('click', function (e) {
    if (e.target === this) closeTieModal();
  });
  $('tieModal').addEventListener('change', function (e) {
    var input = e.target.closest('[data-tie-choice]');
    if (!input || !input.checked) return;
    var group = input.closest('.tie-group');
    if (!group) return;
    var slots = Math.max(1, Number(group.dataset.slots || 1));
    var checked = group.querySelectorAll('[data-tie-choice]:checked');
    if (checked.length > slots) {
      input.checked = false;
      toast('该分组最多选择 ' + slots + ' 项');
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && $('stageModal').style.display === 'flex') {
      closeStageModal();
    }
    if (e.key === 'Escape' && $('tieModal').style.display === 'flex') {
      closeTieModal();
    }
    if (e.key === 'Escape' && $('shareModal').style.display === 'flex') {
      closeShareModal();
    }
    if (e.key === 'Escape' && $('legacyTieModal').style.display === 'flex') {
      closeLegacyTieModal();
    }
  });

  $('modalSave').addEventListener('click', function () {
    if (!state.editingStageId) return;
    var s = state.stages.find(function (st) { return Number(st.id) === Number(state.editingStageId); });
    if (!s) return;

    function val(id) { var el = $(id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : ''; }

    var groupCount = Number(s.group_count || 1);
    var groupInput = $('mfGroupCount');
    if (groupInput) groupCount = Math.max(1, Number(groupInput.value) || 1);

    var originalConfig = parseConfig(s.config_json);
    var bracketSize = Number(originalConfig.bracket_size || 0);
    var bracketEl = document.querySelector('#mfBracketSize .segmented-btn.active');
    if (bracketEl) bracketSize = Number(bracketEl.dataset.value);

    var body = {
      id: Number(state.editingStageId),
      title: val('mfTitle'),
      ends_at: normalizeDateTimeLocal(val('mfEndsAt')),
      vote_mode: s.vote_mode,
      max_select: Number(val('mfMaxSelect')) || 1,
      advance_count: Number(val('mfAdvance')) || 0,
      group_count: groupCount,
      score_min: Number(val('mfScoreMin')) || 1,
      score_max: Number(val('mfScoreMax')) || 10,
      allow_vote_change: val('mfAllowChange') ? 1 : 0,
      result_visibility: val('mfResultVisibility'),
      config: { allow_zero_fill: val('mfZeroFill') ? true : false, bracket_size: bracketSize, tie_rule: 'manual' }
    };

    if (s.vote_mode === 'multi_select' && (s.stage_type === 'qualifier' || s.stage_type === 'group_vote')) {
      if (groupCount < 1) {
        toast('分组数必须大于 0');
        return;
      }
      if (body.advance_count <= 0 || body.advance_count % groupCount !== 0) {
        toast('晋级数必须大于 0 且能被分组数整除');
        return;
      }
      var knownCount = knownStageEntryCount(s);
      if (knownCount > 0 && body.advance_count > knownCount) {
        toast('晋级数不能超过当前候选数 ' + knownCount);
        return;
      }
      if (knownCount > 0 && Math.floor(body.advance_count / groupCount) > Math.floor(knownCount / groupCount)) {
        toast('每组候选数不足以满足晋级名额');
        return;
      }
    }

    var flowPool = getFlowPoolForStage(s);
    var coreChanged =
      String(s.vote_mode || '') !== String(body.vote_mode || '') ||
      Number(s.max_select || 1) !== Number(body.max_select || 1) ||
      Number(s.advance_count || 0) !== Number(body.advance_count || 0) ||
      Number(s.group_count || 1) !== Number(body.group_count || 1) ||
      Number(s.score_min || 1) !== Number(body.score_min || 1) ||
      Number(s.score_max || 10) !== Number(body.score_max || 10) ||
      Number(s.allow_vote_change || 0) !== Number(body.allow_vote_change || 0) ||
      !!originalConfig.allow_zero_fill !== !!body.config.allow_zero_fill;
    var updateAction = 'update';
    if (flowPool && coreChanged) {
      if (flowPool.can_rebuild === false) {
        toast('该阶段已有投票、对阵或结果，只能修改标题、结束时间和结果可见性');
        return;
      }
      updateAction = 'update_and_rebuild';
    }

    var restore = setButtonBusy(this, '保存中...');
    post('../api/vote_stages.php?action=' + updateAction + '&id=' + encodeURIComponent(state.editingStageId), body).then(function (data) {
      toast(data.success ? '阶段配置已保存' : (data.message || '保存失败'));
      closeStageModal();
      if (state.selected) selectProject(state.selected.id);
    }).finally(function () {
      restore();
    });
  });

  /* ===== Pool Card ===== */
  function renderPoolCard() {
    return '<div class="card" id="poolCard"><div class="card-header"><span>活动工作台</span><span style="font-size:11px;color:var(--am-text-secondary);font-weight:400;" id="poolStats"></span></div><div class="pool-pipeline" id="poolPipeline"></div><div class="card-body activity-workbench" id="poolContent">' + loadingMarkup('加载中') + '</div></div>';
  }

  function getSelectedEntryIds() {
    var key = 'pool-selected-' + (state.selected ? state.selected.id : 0);
    try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; }
  }

  function setSelectedEntryIds(ids) {
    var key = 'pool-selected-' + (state.selected ? state.selected.id : 0);
    localStorage.setItem(key, JSON.stringify(ids));
  }

  /** Build pipeline: stages flow with entry counts */
  function updatePoolPipeline(p) {
    var el = $('poolPipeline');
    if (!el) return;
    if (!state.stages.length) { el.innerHTML = ''; return; }
    var stageMap = {};
    state.stages.forEach(function (s) { stageMap[s.stage_type] = s; });
    var types = ['nomination', 'qualifier', 'group_vote', 'bracket', 'final'];
    var labels = { nomination: '提名', qualifier: '海选', group_vote: '分组', bracket: '淘汰赛', final: '决赛' };
    var isMoe = p && p.project_type === 'moe';
    var filtered = types.filter(function (t) {
      if (!stageMap[t]) return false;
      if (isMoe && t === 'group_vote') return false;
      if (!isMoe && t === 'bracket') return false;
      return true;
    });
    var steps = filtered.map(function (t) {
      var sid = String(stageMap[t].id);
      var cnt = '?';
      if (t === 'nomination') {
        cnt = state.entries.length;
      } else if (state.stageEntriesCache[sid]) {
        cnt = state.stageEntriesCache[sid].length;
      }
      var active = (t === 'nomination' && state.poolStageTab === 'all') ||
                   state.poolStageTab === sid;
      return '<span class="pipeline-step' + (active ? ' active' : '') + '">' + labels[t] + ' <strong>' + cnt + '</strong></span>';
    });
    el.innerHTML = steps.join('<span class="pipeline-arrow">&rarr;</span>');
  }

  /** Fetch & cache stage entries from backend */
  function loadStageEntries(stageId) {
    if (state.stageEntriesCache[stageId]) {
      return Promise.resolve(state.stageEntriesCache[stageId]);
    }
    return api('../api/vote_stages.php?action=stage_entries&stage_id=' + encodeURIComponent(stageId) + '&_=' + Date.now()).then(function (data) {
      var entries = data.success ? (data.data || []) : [];
      entries.rawCount = Number(data.raw_count || entries.length || 0);
      entries.canManage = !!data.can_manage;
      state.stageEntriesCache[stageId] = entries;
      return entries;
    }).catch(function () {
      state.stageEntriesCache[stageId] = [];
      return [];
    });
  }

  function togglePoolEntry(entryId) {
    var ids = getSelectedEntryIds();
    var idx = ids.indexOf(Number(entryId));
    if (idx === -1) { ids.push(Number(entryId)); }
    else { ids.splice(idx, 1); }
    setSelectedEntryIds(ids);
    renderPoolContent();
  }

  function renderLegacyPoolContentUnused() {
    var content = $('poolContent');
    if (!content) return;
    var p = state.selected;
    if (!p) return;
    var isMoe = p.project_type === 'moe';

    // === Pipeline ===
    updatePoolPipeline(p);

    // === Build tabs from available stages ===
    var stageMap = {};
    state.stages.forEach(function (s) { stageMap[s.stage_type] = s; });

    var TAB_ORDER = ['nomination', 'qualifier', 'group_vote', 'bracket', 'final'];
    var TAB_LABELS = { nomination: '提名候选池', qualifier: '海选池', group_vote: '分组投票', bracket: '淘汰赛', final: '决赛' };

    var tabTypes = TAB_ORDER.filter(function (t) {
      if (!stageMap[t]) return false;
      if (isMoe && t === 'group_vote') return false;
      if (!isMoe && t === 'bracket') return false;
      return true;
    });

    var tabHtml = '<div class="pool-tabs">';
    tabTypes.forEach(function (t) {
      var tabId = t === 'nomination' ? 'all' : String(stageMap[t].id);
      var label = TAB_LABELS[t];
      var active = state.poolStageTab === tabId;
      tabHtml += '<span class="pool-tab' + (active ? ' active' : '') + '" data-stage-tab="' + tabId + '">' + label + '</span>';
    });
    tabHtml += '</div>';

    // === Render content based on active tab ===
    if (state.poolStageTab === 'all') {
      // Nomination pool — current behavior
      var allEntries = state.entries;
      var selectedIds = getSelectedEntryIds();

      var filtered = allEntries.filter(function (e) {
        if (state.poolFilter === 'selected') return selectedIds.indexOf(Number(e.id)) !== -1;
        if (state.poolFilter === 'removed') return e.entry_status === 'removed';
        if (state.poolFilter === 'pending') return e.entry_status !== 'removed' && selectedIds.indexOf(Number(e.id)) === -1;
        return true;
      });

      var total = filtered.length;
      var paged = filtered.slice(0, state.poolPage * POOL_PAGE_SIZE);
      var hasMore = paged.length < total;

      $('poolStats').textContent = allEntries.length + '条 · 已选' + selectedIds.length;

      var html = tabHtml;
      html += '<div class="pool-toolbar">';
      html += '<div class="pool-filter">';
      var filters = [
        { key: 'all', label: '全部 ' + allEntries.length },
        { key: 'selected', label: '已选 ' + selectedIds.length },
        { key: 'pending', label: '待处理' },
        { key: 'removed', label: '已移除' }
      ];
      filters.forEach(function (f) {
        html += '<span class="pool-filter-item' + (state.poolFilter === f.key ? ' active' : '') + '" data-pool-filter="' + f.key + '">' + f.label + '</span>';
      });
      html += '</div>';
      html += '<div style="display:flex;gap:6px;">';
      html += '<button class="stage-btn" id="poolSelectAll">全选</button>';
      html += '<button class="stage-btn primary" id="poolRemove" style="background:var(--am-tag-nomination-text);color:#fff;border-color:transparent;">排除选中</button>';
      html += '<button class="stage-btn" id="poolRestore">恢复选中</button>';
      html += '</div></div>';

      html += '<div class="pool-grid">';
      paged.forEach(function (e) {
        var isSelected = selectedIds.indexOf(Number(e.id)) !== -1;
        var isRemoved = e.entry_status === 'removed';
        html += '<div class="pool-item' + (isSelected ? ' selected' : '') + (isRemoved ? ' removed' : '') + '" data-entry-id="' + Number(e.id) + '">';
        html += '<div class="pool-check"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="4"><path d="M20 6L9 17l-5-5"/></svg></div>';
        if (isMoe) {
          html += '<div class="pool-avatar" style="background-image:' + (e.image_url ? 'url(' + esc(e.image_url) + ')' : 'linear-gradient(135deg,#e8d8f0,#d8c8e8)') + ';"></div>';
        } else {
          if (e.image_url) {
            html += '<div class="pool-avatar twelve" style="background-image:url(' + esc(e.image_url) + ');"></div>';
          } else {
            html += '<div class="pool-avatar twelve" style="background-image:linear-gradient(135deg,#2f6fed,#5090f0);display:grid;place-items:center;color:#fff;font-size:8px;">' + esc((e.title || '?').slice(0, 2)) + '</div>';
          }
        }
        html += '<div class="pool-name">' + esc(e.title_cn || e.title || '未命名') + '</div>';
        html += '<div class="pool-work">' + esc(e.source_title || '') + '</div>';
        html += '</div>';
      });

      if (hasMore) {
        html += '<div class="pool-expand" id="poolExpand">+ ' + (total - paged.length) + ' 个<br>展开更多</div>';
      }
      html += '</div>';

      html += '<div class="pool-footer">';
      html += '<span>显示 ' + paged.length + ' / ' + total + ' · <span style="color:var(--am-tag-nomination-text);cursor:pointer;" id="poolShowAll">展开全部</span></span>';
      html += '<span>第 ' + state.poolPage + ' 页</span>';
      html += '</div>';

      content.innerHTML = html;
      bindPoolTabEvents();
      bindPoolEvents();
      return;
    }

    // === Stage-specific pool (qualifier / bracket / group_vote / final) ===
    var stageId = Number(state.poolStageTab);
    var stageEntries = state.stageEntriesCache[stageId];

    if (!stageEntries) {
      content.innerHTML = tabHtml + '<div style="text-align:center;padding:20px;color:var(--am-text-secondary);font-size:13px;">加载中...</div>';
      bindPoolTabEvents();
      loadStageEntries(stageId).then(function () { renderPoolContent(); });
      return;
    }

    var totalStage = stageEntries.length;
    $('poolStats').textContent = totalStage + '条';

    var html = tabHtml;
    html += '<div class="pool-grid">';
    stageEntries.forEach(function (e) {
      var meta = '';
      if (e.group_key) meta += e.group_key + ' · ';
      meta += '#' + Number(e.seed_no || 0);
      if (Number(e.source_result_rank || 0) > 0) meta += ' · R' + Number(e.source_result_rank);

      html += '<div class="pool-item" data-entry-id="' + Number(e.entry_id) + '">';
      if (isMoe) {
        html += '<div class="pool-avatar" style="background-image:' + (e.image_url ? 'url(' + esc(e.image_url) + ')' : 'linear-gradient(135deg,#e8d8f0,#d8c8e8)') + ';"></div>';
      } else {
        if (e.image_url) {
          html += '<div class="pool-avatar twelve" style="background-image:url(' + esc(e.image_url) + ');"></div>';
        } else {
          html += '<div class="pool-avatar twelve" style="background-image:linear-gradient(135deg,#2f6fed,#5090f0);display:grid;place-items:center;color:#fff;font-size:8px;">' + esc((e.title || '?').slice(0, 2)) + '</div>';
        }
      }
      html += '<div class="pool-name">' + esc(e.title_cn || e.title || '未命名') + '</div>';
      html += '<div class="pool-meta">' + esc(meta) + '</div>';
      html += '</div>';
    });
    html += '</div>';

    html += '<div class="pool-footer">';
    html += '<span>共 ' + totalStage + ' 条</span>';
    html += '</div>';

    content.innerHTML = html;
    bindPoolTabEvents();
  }

  function getStageByType(type) {
    return state.stages.find(function (stage) { return stage.stage_type === type; }) || null;
  }

  function getFlowPoolForStage(stage) {
    if (!stage || !state.flow || !Array.isArray(state.flow.pools)) return null;
    return state.flow.pools.find(function (pool) { return Number(pool.stage_id) === Number(stage.id); }) || null;
  }

  function flowActionButton(label, action, pool, cls) {
    return '<button class="stage-btn ' + (cls || '') + '" data-flow-action="' + esc(action) + '" data-pool-id="' + Number(pool.id) + '">' + esc(label) + '</button>';
  }

  function renderStageActions(stage) {
    if (!stage) return '';
    if (stage.stage_type === 'nomination') {
      return '<span class="stage-actions"><button class="stage-btn primary" data-rebuild-flow>生成海选池并打开海选</button></span>';
    }
    var flowPool = getFlowPoolForStage(stage);
    if (flowPool) {
      var buttons = [];
      if (flowPool.status === 'draft' || flowPool.status === 'locked') {
        buttons.push(flowActionButton('打开阶段池', 'open_pool', flowPool, 'primary'));
      }
      if (flowPool.status === 'open' && stage.vote_mode !== 'match_single') {
        buttons.push(flowActionButton('结算阶段池', 'settle_pool', flowPool, 'success'));
      }
      if (flowPool.status === 'settled' && stage.stage_type !== 'final') {
        buttons.push(flowActionButton('生成下一阶段池', 'generate_next_pool', flowPool, 'primary'));
      }
      if (flowPool.status === 'reviewing' && flowPool.runtime && flowPool.runtime.tie_breaks && flowPool.runtime.tie_breaks.length) {
        buttons.push(flowActionButton('人工裁定晋级线同分', 'resolve_flow_tie', flowPool, 'success'));
      }
      if ((stage.stage_type === 'bracket' || stage.stage_type === 'final') && flowPool.status !== 'settled') {
        buttons.push(flowActionButton('生成对阵', 'generate_matches', flowPool, 'primary'));
        buttons.push(flowActionButton('按票数结算对阵', 'settle_by_votes', flowPool, 'success'));
      }
      return '<span class="stage-actions">' + buttons.join('') + '</span>';
    }
    if (stage.stage_type === 'qualifier') {
      return '<span class="stage-actions"><button class="stage-btn primary" data-rebuild-flow>生成海选池并打开海选</button></span>';
    }
    return '<span class="stage-actions">' +
      (stage.status !== 'open' ? '<button class="stage-btn primary" data-workbench-stage-action="open" data-stage-id="' + Number(stage.id) + '">开放</button>' : '') +
      (stage.status === 'open' ? '<button class="stage-btn" data-workbench-stage-action="lock" data-stage-id="' + Number(stage.id) + '">锁定</button>' : '') +
      '<button class="stage-btn success" data-workbench-stage-action="settle" data-stage-id="' + Number(stage.id) + '">结算</button>' +
    '</span>';
  }

  function renderEntryGrid(entries, options) {
    options = options || {};
    var isMoe = state.selected && state.selected.project_type === 'moe';
    if (!entries.length) {
      return '<div class="workbench-empty">' + esc(options.empty || '暂无条目') + '</div>';
    }
    var selectedIds = getSelectedEntryIds();
    var html = '<div class="pool-grid workbench-grid">';
    entries.forEach(function (e) {
      var entryId = Number(e.entry_id || e.id);
      var isSelected = selectedIds.indexOf(entryId) !== -1;
      var isRemoved = e.entry_status === 'removed' || e.status === 'removed';
      var title = e.title_cn || e.title || '未命名';
      var meta = options.meta ? options.meta(e) : (e.subtitle || e.source_title || '');
      html += '<div class="pool-item' + (options.selectable ? ' nomination-pool-item' : '') + (isSelected ? ' selected' : '') + (isRemoved ? ' removed' : '') + '" data-entry-id="' + entryId + '">';
      if (options.selectable) {
        html += '<div class="pool-check"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="4"><path d="M20 6L9 17l-5-5"/></svg></div>';
      }
      if (isMoe) {
        html += '<div class="pool-avatar" style="background-image:' + (e.image_url ? 'url(' + esc(e.image_url) + ')' : 'linear-gradient(135deg,#e8d8f0,#d8c8e8)') + ';"></div>';
      } else if (e.image_url) {
        html += '<div class="pool-avatar twelve" style="background-image:url(' + esc(e.image_url) + ');"></div>';
      } else {
        html += '<div class="pool-avatar twelve" style="background-image:linear-gradient(135deg,#2f6fed,#5090f0);display:grid;place-items:center;color:#fff;font-size:8px;">' + esc(title.slice(0, 2)) + '</div>';
      }
      html += '<div class="pool-name">' + esc(title) + '</div>';
      html += '<div class="pool-meta">' + esc(meta) + '</div>';
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  function renderWorkbenchSection(title, stage, body, hint) {
    return '<section class="workbench-section">' +
      '<div class="workbench-section-header">' +
        '<div><h4>' + esc(title) + '</h4>' + (hint ? '<p>' + esc(hint) + '</p>' : '') + '</div>' +
        '<div class="workbench-section-actions">' + (stage ? '<span class="stage-status ' + (stage.status === 'open' ? 'open' : 'pending') + '">' + esc(stage.status || 'pending') + '</span>' + renderStageActions(stage) : '') + '</div>' +
      '</div>' +
      body +
    '</section>';
  }

  function renderNominationWorkbench() {
    var selectedIds = getSelectedEntryIds();
    var qualifier = getStageByType('qualifier');
    var qualifierEntryIds = {};
    if (qualifier) {
      (state.stageEntriesCache[String(qualifier.id)] || []).forEach(function (e) {
        qualifierEntryIds[Number(e.entry_id || e.id)] = true;
      });
    }
    var entries = state.entries.filter(function (e) {
      var q = state.nominationQuery.toLowerCase();
      var matchesQuery = !q || String(e.title_cn || e.title || '').toLowerCase().indexOf(q) !== -1 || String(e.subtitle || e.source_title || '').toLowerCase().indexOf(q) !== -1;
      if (!matchesQuery) return false;
      if (state.poolFilter === 'removed') return e.entry_status === 'removed';
      if (state.poolFilter === 'selected') return selectedIds.indexOf(Number(e.id)) !== -1;
      return e.entry_status !== 'removed' && e.entry_status !== 'rejected';
    });
    var activeCount = state.entries.filter(function (e) { return e.entry_status !== 'removed' && e.entry_status !== 'rejected'; }).length;
    var removedCount = state.entries.filter(function (e) { return e.entry_status === 'removed'; }).length;
    var body = '<div class="pool-toolbar workbench-toolbar">' +
      '<div class="pool-filter">' +
        '<span class="pool-filter-item' + (state.poolFilter === 'all' ? ' active' : '') + '" data-pool-filter="all">有效 ' + activeCount + '</span>' +
        '<span class="pool-filter-item' + (state.poolFilter === 'selected' ? ' active' : '') + '" data-pool-filter="selected">已选 ' + selectedIds.length + '</span>' +
        '<span class="pool-filter-item' + (state.poolFilter === 'removed' ? ' active' : '') + '" data-pool-filter="removed">已排除 ' + removedCount + '</span>' +
      '</div>' +
      '<input class="form-input workbench-search" id="nominationSearchInput" placeholder="搜索提名" value="' + esc(state.nominationQuery) + '">' +
      '<div style="display:flex;gap:6px;">' +
        '<button class="stage-btn" id="poolSelectAll">全选有效</button>' +
        '<button class="stage-btn primary" id="poolRemove" style="background:var(--am-tag-nomination-text);color:#fff;border-color:transparent;">排除选中</button>' +
        '<button class="stage-btn" id="poolRestore">恢复选中</button>' +
      '</div>' +
    '</div>';
    body += renderEntryGrid(entries, {
      selectable: true,
      empty: state.poolFilter === 'removed' ? '暂无已排除提名' : '暂无有效提名',
      meta: function (e) {
        var entryId = Number(e.id);
        var status = e.entry_status === 'removed' ? '已排除' : (qualifierEntryIds[entryId] ? '已进入海选' : '有效');
        var detail = e.subtitle || e.source_title || '';
        return status + (detail ? ' · ' + detail : '');
      }
    });
    return renderWorkbenchSection('提名列表', null, body, '用户提名默认有效，管理员只需要排除有问题的条目。');
  }

  function getPoolStageTypes() {
    if (!state.selected) return [];
    return state.selected.project_type === 'moe'
      ? ['nomination', 'qualifier', 'bracket', 'final']
      : ['nomination', 'qualifier', 'group_vote', 'final'];
  }

  function renderPoolStageTabs() {
    var labels = { nomination: '提名', qualifier: '海选', group_vote: '分组投票', bracket: '淘汰赛', final: '决赛' };
    var html = '<div class="pool-tabs">';
    getPoolStageTypes().forEach(function (type) {
      var stage = type === 'nomination' ? null : getStageByType(type);
      if (type !== 'nomination' && !stage) return;
      var tabId = type === 'nomination' ? 'all' : String(stage.id);
      html += '<span class="pool-tab' + (state.poolStageTab === tabId ? ' active' : '') + '" data-stage-tab="' + tabId + '">' + esc(labels[type] || type) + '</span>';
    });
    html += '</div>';
    return html;
  }

  function stageTypeForTab(tabId) {
    if (tabId === 'all') return 'nomination';
    var stage = state.stages.find(function (s) { return String(s.id) === String(tabId); });
    return stage ? stage.stage_type : 'nomination';
  }

  function groupKeysForEntries(entries) {
    var keys = [];
    var seen = {};
    entries.forEach(function (entry) {
      var key = entry.group_key || '';
      if (!key || seen[key]) return;
      seen[key] = true;
      keys.push(key);
    });
    return keys;
  }

  function renderPoolGroupTabs(entries) {
    var keys = groupKeysForEntries(entries);
    if (keys.length <= 1) return '';
    var html = '<div class="pool-group-tabs">';
    html += '<span class="pool-group-tab' + (state.poolGroupTab === 'all' ? ' active' : '') + '" data-pool-group="all">全部</span>';
    keys.forEach(function (key) {
      var count = entries.filter(function (entry) { return (entry.group_key || '') === key; }).length;
      html += '<span class="pool-group-tab' + (state.poolGroupTab === key ? ' active' : '') + '" data-pool-group="' + esc(key) + '">' + esc(key) + ' ' + count + '</span>';
    });
    html += '</div>';
    return html;
  }

  function filterEntriesByGroup(entries) {
    if (!state.poolGroupTab || state.poolGroupTab === 'all') return entries;
    return entries.filter(function (entry) { return (entry.group_key || '') === state.poolGroupTab; });
  }

  function renderStageWorkbench(title, stageType, hint) {
    var stage = getStageByType(stageType);
    if (!stage) return '';
    var entries = state.stageEntriesCache[String(stage.id)] || [];
    var visibleEntries = filterEntriesByGroup(entries);
    var canManage = !!entries.canManage;
    if (canManage) {
      visibleEntries = visibleEntries.slice().sort(function (a, b) {
        var va = a.votes != null ? Number(a.votes || 0) : 0;
        var vb = b.votes != null ? Number(b.votes || 0) : 0;
        if (vb !== va) return vb - va;
        var sa = Number(a.seed_no || 0);
        var sb = Number(b.seed_no || 0);
        if (sa !== sb) return sa - sb;
        return Number(a.entry_id || a.id || 0) - Number(b.entry_id || b.id || 0);
      });
    }
    var flowPool = getFlowPoolForStage(stage);
    var canRebuild = stageType === 'qualifier' && !flowPool;
    var emptyText = canRebuild
      ? '尚未生成，点击生成海选池并打开海选。'
      : (state.poolGroupTab && state.poolGroupTab !== 'all' ? '该分组暂无候选。' : '阶段池尚未生成，请联系负责人。');
    var body = renderPoolGroupTabs(entries);
    body += renderEntryGrid(visibleEntries, {
      empty: emptyText,
      meta: function (e) {
        var parts = [];
        if (canManage && e.rank != null) parts.push('第' + Number(e.rank) + '名');
        if (e.group_key) parts.push(e.group_key);
        if (e.seed_no) parts.push('#' + Number(e.seed_no));
        if (e.votes != null) parts.push(Number(e.votes || 0) + '票');
        if (e.source_result_rank) parts.push('R' + Number(e.source_result_rank));
        return parts.join(' · ');
      }
    });
    if (canRebuild) {
      body += '<div class="workbench-flow-actions"><button class="stage-btn primary" data-rebuild-flow>生成海选池并打开海选</button></div>';
    }
    return renderWorkbenchSection(title, stage, body, hint);
  }

  function renderPoolContent() {
    var content = $('poolContent');
    if (!content || !state.selected) return;
    updatePoolPipeline(state.selected);
    var isMoe = state.selected.project_type === 'moe';
    var stageTypes = isMoe ? ['qualifier', 'bracket', 'final'] : ['qualifier', 'group_vote', 'final'];
    var stagesToLoad = stageTypes.map(getStageByType).filter(Boolean).filter(function (stage) {
      return !state.stageEntriesCache[String(stage.id)];
    });
    if (stagesToLoad.length) {
      content.innerHTML = '<div style="text-align:center;padding:20px;color:var(--am-text-secondary);font-size:13px;">加载阶段池...</div>';
      Promise.all(stagesToLoad.map(function (stage) { return loadStageEntries(stage.id); })).then(function () {
        renderPoolContent();
      });
      return;
    }
    var validTabs = ['all'];
    stageTypes.map(getStageByType).filter(Boolean).forEach(function (stage) { validTabs.push(String(stage.id)); });
    if (validTabs.indexOf(String(state.poolStageTab)) === -1) {
      state.poolStageTab = 'all';
      state.poolGroupTab = 'all';
    }
    var activeCount = state.entries.filter(function (e) { return e.entry_status !== 'removed' && e.entry_status !== 'rejected'; }).length;
    var qualifier = getStageByType('qualifier');
    var middle = isMoe ? getStageByType('bracket') : getStageByType('group_vote');
    var finalStage = getStageByType('final');
    var counts = [
      '提名 ' + activeCount,
      '海选 ' + (qualifier ? (state.stageEntriesCache[String(qualifier.id)] || []).length : 0),
      (isMoe ? '淘汰赛 ' : '分组 ') + (middle ? (state.stageEntriesCache[String(middle.id)] || []).length : 0),
      '决赛 ' + (finalStage ? (state.stageEntriesCache[String(finalStage.id)] || []).length : 0)
    ];
    var stats = $('poolStats');
    if (stats) stats.textContent = counts.join(' · ');
    var activeType = stageTypeForTab(state.poolStageTab);
    var body = '';
    if (activeType === 'nomination') {
      body = renderNominationWorkbench();
    } else if (activeType === 'qualifier') {
      body = renderStageWorkbench('海选池', 'qualifier', '从剩余有效提名自动生成，用户投票只读取这里的候选。');
    } else if (activeType === 'bracket') {
      body = renderStageWorkbench('淘汰赛池', 'bracket', '海选结算后播种，生成 1v1 对阵。') + renderMoeMatchesWorkbench();
    } else if (activeType === 'group_vote') {
      body = renderStageWorkbench('分组投票', 'group_vote', '海选结算后按后端 group_key 分组。');
    } else if (activeType === 'final') {
      body = renderStageWorkbench('决赛池', 'final', '上一阶段结算后播种最终候选。') + renderMoeMatchesWorkbench();
    }
    content.innerHTML = renderPoolStageTabs() + body;
    bindPoolTabEvents();
    bindPoolEvents();
    renderMatchContent();
  }

  function renderMoeMatchesWorkbench() {
    var activeType = stageTypeForTab(state.poolStageTab);
    var title = activeType === 'final' ? '决赛对阵' : '淘汰赛对阵';
    var hint = activeType === 'final' ? '冠军赛和季军赛在这里结算。' : '按轮次查看状态，平票或缺槽场次需要人工指定胜者。';
    return '<section class="workbench-section"><div class="workbench-section-header"><div><h4>' + esc(title) + '</h4><p>' + esc(hint) + '</p></div><button class="stage-btn primary" id="generateMatchesBtn">生成对阵</button></div><div id="matchContent" class="workbench-match-list"><div class="workbench-empty">暂无对阵数据</div></div></section>';
  }

  function bindPoolTabEvents() {
    document.querySelectorAll('[data-stage-tab]').forEach(function (el) {
      el.addEventListener('click', function () {
        var tabId = this.dataset.stageTab;
        if (tabId === state.poolStageTab) return;
        state.poolStageTab = tabId;
        state.poolGroupTab = 'all';
        state.poolPage = 1;
        renderPoolContent();
      });
    });
  }

  function bindPoolEvents() {
    document.querySelectorAll('[data-pool-filter]').forEach(function (el) {
      el.addEventListener('click', function () {
        state.poolFilter = this.dataset.poolFilter;
        state.poolPage = 1;
        renderPoolContent();
      });
    });

    document.querySelectorAll('[data-pool-group]').forEach(function (el) {
      el.addEventListener('click', function () {
        state.poolGroupTab = this.dataset.poolGroup || 'all';
        renderPoolContent();
      });
    });

    document.querySelectorAll('.nomination-pool-item').forEach(function (el) {
      el.addEventListener('click', function () {
        togglePoolEntry(this.dataset.entryId);
      });
    });

    var searchInput = $('nominationSearchInput');
    if (searchInput) searchInput.addEventListener('input', function () {
      state.nominationQuery = this.value.trim();
      renderPoolContent();
    });

    document.querySelectorAll('[data-flow-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        runFlowAction(this.dataset.flowAction, this.dataset.poolId, btn);
      });
    });

    document.querySelectorAll('[data-workbench-stage-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = this.dataset.workbenchStageAction;
        var id = this.dataset.stageId;
        var restoreWb = setButtonBusy(this, '处理中...');
        post('../api/vote_stages.php?action=' + action + '&id=' + encodeURIComponent(id), {}).then(function (data) {
          var msg = data.success ? '阶段已更新' : (data.message || '操作失败');
          if (data.success && action === 'open' && data.seeded_count != null) msg += ' · 候选 ' + Number(data.seeded_count);
          if (data.success && action === 'settle' && data.advanced_count != null) msg += ' · 晋级 ' + Number(data.advanced_count);
          if (data.success && data.status === 'reviewing') msg = '已结算：存在同分，请完成裁定';
          toast(msg);
          if (state.selected) selectProject(state.selected.id);
        }).catch(function () {
          toast('操作失败，请重试');
        }).finally(function () {
          restoreWb();
        });
      });
    });

    var selectAllBtn = $('poolSelectAll');
    if (selectAllBtn) selectAllBtn.addEventListener('click', function () {
      var allIds = state.entries.filter(function (e) { return e.entry_status !== 'removed'; }).map(function (e) { return Number(e.id); });
      setSelectedEntryIds(allIds);
      renderPoolContent();
    });

    var restoreBtn = $('poolRestore');
    if (restoreBtn) restoreBtn.addEventListener('click', function () {
      var ids = getSelectedEntryIds();
      if (!ids.length) { toast('请先选择条目'); return; }
      Promise.all(ids.map(function (id) {
        return post('../api/vote_nominations.php?action=restore', { entry_id: id });
      })).then(function () {
        toast('已恢复');
        if (state.selected) selectProject(state.selected.id);
      });
    });

    var removeBtn = $('poolRemove');
    if (removeBtn) removeBtn.addEventListener('click', function () {
      var ids = getSelectedEntryIds();
      if (!ids.length) { toast('请先选择条目'); return; }
      Promise.all(ids.map(function (id) {
        return post('../api/vote_nominations.php?action=remove', { entry_id: id });
      })).then(function () {
        setSelectedEntryIds([]);
        toast('已移除');
        if (state.selected) selectProject(state.selected.id);
      });
    });

    var expandBtn = $('poolExpand');
    if (expandBtn) expandBtn.addEventListener('click', function () {
      state.poolPage++;
      renderPoolContent();
    });

    var showAll = $('poolShowAll');
    if (showAll) showAll.addEventListener('click', function () {
      state.poolPage = Math.ceil(state.entries.length / POOL_PAGE_SIZE) + 1;
      renderPoolContent();
    });
  }

  /* ===== Match Card ===== */
  function renderMatchCard() {
    return '<div class="card" id="matchCard"><div class="card-header"><span>萌战对阵</span><button class="stage-btn primary" id="generateMatchesBtn">生成对阵</button></div><div class="card-body" id="matchContent"><div style="text-align:center;padding:20px;color:var(--am-text-secondary);font-size:13px;">暂无对阵数据</div></div></div>';
  }

  function renderTwelveSettleCard() {
    return '<div class="card"><div class="card-header"><span>阶段结算</span></div><div class="card-body"><div style="text-align:center;padding:20px;color:var(--am-text-secondary);font-size:13px;">各阶段结算后根据投票/评分自动产生晋级作品。</div></div></div>';
  }

  function renderMatchContent() {
    var host = $('matchContent');
    if (!host) return;
    var activeType = stageTypeForTab(state.poolStageTab);
    var activeStage = activeType === 'bracket' || activeType === 'final' ? getStageByType(activeType) : null;
    var matches = activeStage
      ? state.matches.filter(function (m) { return Number(m.stage_id) === Number(activeStage.id); })
      : state.matches;
    bindGenerateMatchesButton();
    if (!matches.length) {
      host.innerHTML = '<div class="workbench-empty">暂无对阵数据</div>';
      return;
    }
    var issueMap = {};
    (state.lastSettleIssues || []).forEach(function (issue) {
      issueMap[Number(issue.match_id)] = issue;
    });
    var rounds = {};
    matches.forEach(function (m) {
      var roundNo = Number(m.round_no || 1);
      if (!rounds[roundNo]) rounds[roundNo] = [];
      rounds[roundNo].push(m);
    });
    var html = Object.keys(rounds).sort(function (a, b) { return Number(a) - Number(b); }).map(function (roundKey) {
      var rows = rounds[roundKey];
      var openCount = rows.filter(function (m) { return m.status === 'open'; }).length;
      var settledCount = rows.filter(function (m) { return m.status === 'settled'; }).length;
      var pendingCount = rows.length - openCount - settledCount;
      var roundTitle = activeType === 'final'
        ? (Number(roundKey) === 1 ? '冠军赛' : '季军赛')
        : '第 ' + Number(roundKey) + ' 轮';
      var body = rows.map(function (m) {
        var a = esc(m.slot_a_title_cn || m.slot_a_title || '待定');
        var b = esc(m.slot_b_title_cn || m.slot_b_title || '待定');
        var hasVotes = m.slot_a_votes != null || m.slot_b_votes != null;
        var aVotes = hasVotes ? Number(m.slot_a_votes || 0) : null;
        var bVotes = hasVotes ? Number(m.slot_b_votes || 0) : null;
        if (hasVotes) {
          a += ' <span style="font-size:11px;color:var(--am-text-secondary);">(' + aVotes + '票)</span>';
          b += ' <span style="font-size:11px;color:var(--am-text-secondary);">(' + bVotes + '票)</span>';
        }
        var issue = issueMap[Number(m.id)];
        var issueText = issue ? (issue.reason === 'tie' ? '平票待处理' : '缺槽待处理') : '';
        var missingSlot = !Number(m.slot_a_entry_id || 0) || !Number(m.slot_b_entry_id || 0);
        var winnerName = esc(m.winner_title_cn || m.winner_title || m.winner_entry_id || '');
        var winnerVotes = '';
        if (hasVotes && m.status === 'settled' && Number(m.winner_entry_id || 0)) {
          winnerVotes = ' <span style="font-size:11px;color:var(--am-text-secondary);">(' + (Number(m.winner_entry_id || 0) === Number(m.slot_a_entry_id || 0) ? aVotes : bVotes) + '票)</span>';
        }
        var controls = m.status === 'settled'
          ? '<span class="stage-status open">胜者：' + winnerName + winnerVotes + '</span>'
          : '<span class="stage-actions"><button class="stage-btn success" data-match-winner="' + Number(m.id) + '" data-winner-id="' + Number(m.slot_a_entry_id || 0) + '"' + (!Number(m.slot_a_entry_id || 0) ? ' disabled' : '') + '>' + esc(m.slot_a_title_cn || m.slot_a_title || '待定') + ' 胜</button><button class="stage-btn success" data-match-winner="' + Number(m.id) + '" data-winner-id="' + Number(m.slot_b_entry_id || 0) + '"' + (!Number(m.slot_b_entry_id || 0) ? ' disabled' : '') + '>' + esc(m.slot_b_title_cn || m.slot_b_title || '待定') + ' 胜</button></span>';
        return '<div style="display:grid;grid-template-columns:64px 1fr auto auto;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--am-card-border);opacity:' + (missingSlot && m.status !== 'settled' ? '.65' : '1') + ';">' +
          '<strong style="font-size:12px;">R' + Number(m.round_no) + '-' + Number(m.match_no) + '</strong>' +
          '<span style="font-size:13px;">' + a + ' vs ' + b + (issueText ? '<em style="font-style:normal;color:#d97706;margin-left:8px;">' + esc(issueText) + '</em>' : '') + '</span>' +
          '<span class="stage-status ' + (m.status === 'open' ? 'open' : 'pending') + '">' + esc(m.status) + '</span>' +
          controls +
        '</div>';
      }).join('');
      return '<div style="padding:10px 0 4px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
        '<strong style="font-size:13px;">' + esc(roundTitle) + '</strong>' +
        '<span style="font-size:11px;color:var(--am-text-secondary);">投票中 ' + openCount + ' · 已结算 ' + settledCount + ' · 待开放 ' + pendingCount + '</span>' +
      '</div>' + body + '</div>';
    }).join('');
    if (state.lastSettleIssues && state.lastSettleIssues.length) {
      html = '<div style="margin-bottom:10px;padding:8px 10px;border:1px solid rgba(217,119,6,.25);background:rgba(217,119,6,.08);border-radius:8px;font-size:12px;color:#92400e;">有 ' + state.lastSettleIssues.length + ' 场平票/缺槽，需要人工指定胜者。</div>' + html;
    }
    host.innerHTML = html;
    bindMatchWinnerButtons();

  }

  function bindMatchWinnerButtons() {
    document.querySelectorAll('[data-match-winner]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        settleMatch(this.dataset.matchWinner, this.dataset.winnerId);
      });
    });
  }

  function bindGenerateMatchesButton() {
    var genBtn = $('generateMatchesBtn');
    if (genBtn) genBtn.addEventListener('click', function () {
      if (!state.selected) return;
      var activeType = stageTypeForTab(state.poolStageTab);
      var stage = (activeType === 'bracket' || activeType === 'final') ? getStageByType(activeType) : null;
      if (!stage) stage = state.stages.find(function (s) { return s.stage_type === 'bracket'; }) || state.stages.find(function (s) { return s.vote_mode === 'match_single'; });
      if (!stage) { toast('该企划没有 1v1 阶段'); return; }
      var config = parseConfig(stage.config_json);
      var stagePool = getFlowPoolForStage(stage);
      var qualifier = getStageByType('qualifier');
      var size = Number(
        (stagePool && stagePool.entry_count) ||
        (stage.stage_type === 'bracket' && qualifier && qualifier.advance_count) ||
        config.bracket_size ||
        4
      );
      post('../api/vote_matches.php?action=generate', { stage_id: Number(stage.id), size: size }).then(function (data) {
        toast(data.success ? '对阵已生成' : (data.message || '生成失败'));
        if (state.selected) selectProject(state.selected.id);
      });
    });
  }

  function settleMatch(matchId, winnerId) {
    winnerId = Number(winnerId);
    if (!winnerId) { toast('该槽位还没有条目'); return; }
    post('../api/vote_matches.php?action=settle&id=' + encodeURIComponent(matchId), { winner_entry_id: winnerId }).then(function (data) {
      toast(data.success ? '对阵已结算' : (data.message || '结算失败'));
      if (state.selected) selectProject(state.selected.id);
    });
  }

  /* ===== Awards Card ===== */
  function renderAwardsCard() {
    return '<div class="card" id="awardsCard"><div class="card-header"><span>奖项设置</span><span style="font-size:11px;color:var(--am-text-secondary);font-weight:400;">决赛结算后记录</span></div><div class="card-body"><div class="awards-row">' +
      '<div class="award-slot gold"><svg width="28" height="28" viewBox="0 0 48 48" fill="none" style="margin-bottom:4px;"><path d="M24 6L30 14L40 18L32 26L34 36L24 30L14 36L16 26L8 18L18 14L24 6Z" stroke="#c7932b" stroke-width="1.5" fill="rgba(199,147,43,0.15)"/><circle cx="24" cy="22" r="8" stroke="#c7932b" stroke-width="1" fill="none"/></svg><div class="award-title gold">冠军 · 萌王</div><div class="award-value" id="championName">待定</div></div>' +
      '<div class="award-slot silver"><svg width="26" height="26" viewBox="0 0 48 48" fill="none" style="margin-bottom:4px;"><path d="M24 8L28 18L38 20L30 28L32 38L24 32L16 38L18 28L10 20L20 18L24 8Z" stroke="#98a0b0" stroke-width="1.5" fill="rgba(160,160,180,0.1)"/></svg><div class="award-title silver">亚军</div><div class="award-value" id="runnerUpName">待定</div></div>' +
      '<div class="award-slot bronze"><svg width="24" height="24" viewBox="0 0 48 48" fill="none" style="margin-bottom:4px;"><path d="M24 10L26 20L34 22L27 28L28 38L24 34L20 38L21 28L14 22L22 20L24 10Z" stroke="#b08860" stroke-width="1.5" fill="rgba(180,140,100,0.08)"/></svg><div class="award-title bronze">季军</div><div class="award-value" id="thirdPlaceName">待定</div></div>' +
    '</div></div></div>';
  }

  function loadCurrentMoeKing() {
    if (!state.selected || state.selected.project_type !== 'moe') return;
    var finalStage = getStageByType('final');
    if (finalStage) {
      api('../api/vote_votes.php?action=results&stage_id=' + encodeURIComponent(finalStage.id)).then(function (result) {
        var rows = (result && result.data) || [];
        if (rows.length && ((result && result.stage_status) === 'settled' || finalStage.status === 'settled')) {
          renderMoeAwardsFromResults(rows);
          syncChampionToMoeKing(rows[0]);
          return;
        }
        loadStoredMoeKing();
      }).catch(loadStoredMoeKing);
      return;
    }
    loadStoredMoeKing();
  }

  function loadStoredMoeKing() {
    if (!state.selected || state.selected.project_type !== 'moe') return;
    api('../api/club_moe_king.php?action=get&club_id=' + encodeURIComponent(state.selected.club_id) + '&country=' + encodeURIComponent(state.selected.country || 'china')).then(function (data) {
      if (data.success && data.data) {
        var el = $('championName');
        if (el) el.textContent = data.data.name_cn || data.data.name;
      }
    }).catch(function () {});
  }

  function renderMoeAwardsFromResults(rows) {
    var champion = rows.find(function (r) { return Number(r.rank_no) === 1; }) || rows[0];
    var runner = rows.find(function (r) { return Number(r.rank_no) === 2; }) || rows[1];
    var third = rows.find(function (r) { return Number(r.rank_no) === 3; }) || rows[2];
    setAwardText('championName', champion);
    setAwardText('runnerUpName', runner);
    setAwardText('thirdPlaceName', third);
  }

  function setAwardText(id, row) {
    var el = $(id);
    if (!el) return;
    el.textContent = row ? (row.title_cn || row.title || ('#' + row.entry_id)) : '待定';
  }

  function syncChampionToMoeKing(row) {
    if (!state.selected || !row) return;
    var key = state.selected.id + ':' + Number(row.entry_id || row.id || 0);
    if (!Number(row.rank_no || 0) || Number(row.rank_no) !== 1 || state.moeAwardSyncKey === key) return;
    state.moeAwardSyncKey = key;
    post('../api/club_moe_king.php?action=set', {
      club_id: Number(state.selected.club_id),
      country: state.selected.country || 'china',
      character_id: Number(row.source_id || row.entry_id || row.id || 0),
      name: row.title || row.title_cn || ('entry-' + Number(row.entry_id || row.id || 0)),
      name_cn: row.title_cn || row.title || '',
      image_url: row.image_url || '',
      summary: row.summary || '由萌战决赛结果自动同步'
    }).then(function (data) {
      if (!data || !data.success) toast((data && data.message) || '萌王同步失败');
    }).catch(function () {
      toast('萌王同步失败');
    });
  }

  /* ===== Global Click Delegation ===== */
  document.addEventListener('click', function (event) {
    var item = event.target.closest('[data-project-id]');
    if (item) selectProject(item.dataset.projectId);
  });

  // boundRebuildFlow: use a single delegated listener to avoid duplicate per-render bindings
  document.addEventListener('click', function (event) {
    var rebuildBtn = event.target.closest('[data-rebuild-flow]');
    if (rebuildBtn) {
      event.preventDefault();
      rebuildFlowFromNomination(rebuildBtn);
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var item = event.target.closest('[data-project-id]');
    if (!item) return;
    event.preventDefault();
    selectProject(item.dataset.projectId);
  });

  /* ===== Init ===== */
  $('createYear').value = String(new Date().getFullYear());
  loadClubData().then(loadManageable);
})();
