(function () {
  'use strict';
  var $ = $vote, esc = escVote, api = apiVote, toast = function (m) { toastVote($('toast'), m); };

  var STAGE_META = {
    nomination: { label: '提名期', color: 'nomination' },
    qualifier:  { label: '海选', color: 'qualifier' },
    group_vote: { label: '分组投票', color: 'group_vote' },
    final:      { label: '最终十二器', color: 'final' }
  };

  var STATE = { filter: 'running', page: 1, projects: [], total: 0 };

  function init() {
    var chips = $('mhChips');
    if (chips) {
      chips.addEventListener('click', function (e) {
        var chip = e.target.closest('.mh-chip');
        if (!chip) return;
        chips.querySelectorAll('.mh-chip').forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
        STATE.filter = chip.dataset.status;
        STATE.page = 1;
        loadProjects();
      });
    }

    var loadMore = $('mhLoadMore');
    if (loadMore) {
      loadMore.addEventListener('click', function () {
        STATE.page++;
        loadProjects(true);
      });
    }

    loadProjects();
  }

  function loadProjects(append) {
    var list = $('mhCardList');
    if (!list) return;
    if (!append) list.innerHTML = '<div class="mh-loading">加载中...</div>';
    ensureClubNamesLoaded().then(function () {
      var params = '?action=list&project_type=twelve&status=' + STATE.filter + '&page=' + STATE.page;
      api('../api/twelve_contests.php' + params).then(function (data) {
        var projects = (data && data.data) || [];
        if (!projects.length) {
          if (!append) list.innerHTML = '<div class="mh-empty">暂无活动</div>';
          return;
        }
        STATE.total = data.total || projects.length;
        STATE.projects = append ? STATE.projects.concat(projects) : projects;
        renderCards(projects, append);
        var loadMore = $('mhLoadMore');
        if (loadMore) loadMore.style.display = (STATE.projects.length < STATE.total && projects.length > 0) ? '' : 'none';
        updateStats();
      }).catch(function () {
        list.innerHTML = '<div class="mh-empty">加载失败，请刷新重试</div>';
      });
    });
  }

  function renderCards(projects, append) {
    var list = $('mhCardList');
    if (!append) list.innerHTML = '';
    if (!projects.length && !append) {
      list.innerHTML = '<div class="mh-empty">暂无活动</div>';
      return;
    }

    projects.forEach(function (p) {
      var stageType = (p.current_stage && p.current_stage.stage_type) || 'nomination';
      var meta = STAGE_META[stageType] || STAGE_META.nomination;
      var isEnded = p.status === 'ended';
      var card = document.createElement('div');
      card.className = 'mh-card' + (isEnded ? ' dim' : '');
      card.dataset.id = p.id;
      card.innerHTML =
        '<div class="mh-card-bar ' + meta.color + '"></div>' +
        '<div class="mh-card-body">' +
          '<div class="mh-card-row">' +
            '<span class="mh-card-tag">十二器</span>' +
            '<span class="mh-card-club">' + esc(resolveClubName(p.club_id, p.country)) + '</span>' +
            '<span class="mh-card-stage ' + meta.color + '"' + (isEnded ? ' ended' : '') + '>' + (isEnded ? '已结束' : meta.label) + '</span>' +
          '</div>' +
          '<div class="mh-card-title">' + esc(p.title) + '</div>' +
          '<div class="mh-card-desc">' + buildDesc(p) + '</div>' +
        '</div>';
      card.addEventListener('click', function () {
        window.location.href = 'contest.html?id=' + card.dataset.id;
      });
      list.appendChild(card);
    });
  }

  function buildDesc(p) {
    var parts = [];
    var stage = p.current_stage;
    if (stage && stage.stage_type !== 'nomination') {
      parts.push((p.entry_count || '多') + '部作品参选');
    }
    if (stage && stage.end_time) {
      var remaining = Math.max(0, Math.ceil((new Date(stage.end_time) - Date.now()) / 86400000));
      parts.push('剩余 ' + remaining + ' 天');
    }
    return parts.join(' · ') || '即将开始';
  }

  function updateStats() {
    api('../api/twelve_contests.php?action=list&project_type=twelve&status=running').then(function (d) {
      var el = $('mhStatRunning');
      if (el) el.textContent = (d && d.data) ? d.data.length : 0;
    }).catch(function () {});

    api('../api/twelve_contests.php?action=list&project_type=twelve').then(function (d) {
      var el1 = $('mhStatTotal');
      var el2 = $('mhStatClubs');
      if (el1) el1.textContent = (d && d.data) ? d.data.length : 0;
      if (el2) el2.textContent = (d && d.data) ? d.data.map(function (p) { return p.club_id; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).length : 0;
    }).catch(function () {});
  }

  init();
})();
