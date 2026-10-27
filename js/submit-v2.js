/* ==========================================================================
   VNFest · submit-v2.js
   「SIGNAL」—— 黑屏邀请 → 遮罩揭开 → 逐屏表单 → 完成
   submit-v2.html 为独立演示；submit.html 通过 data-submit-mode="production"
   接入原有同源登录与提交接口。正式成功状态仅在接口确认后出现。
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var gsap = window.gsap;
  var reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  var reduced = reducedQuery.matches;
  var compactQuery = window.matchMedia('(max-width: 1080px)');

  var TOTAL = 6;
  var production = document.body.getAttribute('data-submit-mode') === 'production';
  var authReady = !production;
  var authChecking = false;
  var experienceStarted = false;
  var returnToReview = false;
  var state = { step: 0, busy: false, done: false };
  var bootStart = 0;
  var bootTimeline = null;
  var bootEnded = false;
  var els = {};
  var canvasApi = null;
  var datePickerApi = null;
  var stepDirection = 1;

  // 每屏一位 Q 版角色（取自 image/chibi-web；场景含义参考 js/chibi-assets.js）
  var DECO_CHIBI = [12, 60, 40, 101, 127, 66];
  var decoLoaded = {};
  var decoShown = -1;

  /* ------------------------------------------------------------ 主题 */
  /* 明暗跟随系统（prefers-color-scheme），不做手动切换，也不记忆选择。
     两套主题共用同一份 DOM 与动画，只切换 body 上的 .theme-light / .theme-dark。 */

  var themeQuery = window.matchMedia('(prefers-color-scheme: light)');
  var theme = 'dark';

  function applyTheme(value) {
    theme = value === 'light' ? 'light' : 'dark';
    var body = document.body;
    body.classList.toggle('theme-light', theme === 'light');
    body.classList.toggle('theme-dark', theme === 'dark');
    if (canvasApi && canvasApi.refreshPalette) canvasApi.refreshPalette();
  }

  function syncSystemTheme() {
    applyTheme(themeQuery.matches ? 'light' : 'dark');
  }

  /* ------------------------------------------------------------ 工具 */

  function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function typeValue() {
    var checked = document.querySelector('input[name="clubType"]:checked');
    return checked ? checked.value : 'school';
  }

  function normalizePrefecture(value) {
    if (window.Utils && typeof window.Utils.normalizeJapanPrefecture === 'function') {
      return window.Utils.normalizeJapanPrefecture(value);
    }
    return value;
  }

  /* ------------------------------------------------------------ 数据 */

  function collectPayload() {
    var type = typeValue();
    var country = $('country').value;
    var province = country === 'china' ? $('province').value : '';
    var prefecture = country === 'japan' ? normalizePrefecture($('prefecture').value) : '';
    if (country === 'overseas') province = '海外';
    return {
      name: $('clubName').value.trim(),
      school: type === 'school' ? $('schoolName').value.trim() : '',
      country: country,
      province: province,
      prefecture: prefecture,
      info: $('contact').value.trim(),
      type: type,
      created_at: $('createdAt').value || '',
      remark: $('remark').value.trim(),
      submitter: $('submitter').value.trim(),
      applicant_role: $('applicantRole').value,
      timestamp: new Date().toISOString(),
      status: 'pending'
    };
  }

  /* ------------------------------------------------------------ 联动 */

  function syncChoices() {
    var choices = document.querySelectorAll('.v2-choice');
    for (var i = 0; i < choices.length; i++) {
      var input = choices[i].querySelector('input');
      choices[i].classList.toggle('is-selected', !!(input && input.checked));
    }
  }

  // 字段显隐用高度动画，避免下方的读数条、说明条突然跳动
  function toggleField(group, show, instant) {
    if (!group) return;
    if (!gsap || reduced || instant) {
      gsap && gsap.killTweensOf(group);
      group.hidden = !show;
      if (gsap) gsap.set(group, { clearProps: 'height,opacity,transform,overflow' });
      else { group.style.height = ''; group.style.opacity = ''; group.style.overflow = ''; }
      return;
    }
    gsap.killTweensOf(group);
    if (show) {
      group.hidden = false;
      var target = group.scrollHeight;
      gsap.fromTo(group,
        { height: 0, opacity: 0, y: -8 },
        {
          height: target, opacity: 1, y: 0, duration: 0.42, ease: 'power3.out',
          onComplete: function () { gsap.set(group, { clearProps: 'height,opacity,transform,overflow' }); }
        });
    } else {
      gsap.to(group, {
        height: 0, opacity: 0, y: -8, duration: 0.3, ease: 'power2.in',
        onStart: function () { group.style.overflow = 'hidden'; },
        onComplete: function () {
          group.hidden = true;
          gsap.set(group, { clearProps: 'height,opacity,transform,overflow' });
        }
      });
    }
  }

  function updateSchool() {
    var isSchool = typeValue() === 'school';
    if (!isSchool) {
      els.schoolName.value = '';
      clearFieldError('schoolName');
    }
    toggleField(els.schoolGroup, isSchool, !bootEnded);
    syncChoices();
  }

  function updateCountry() {
    var country = els.country.value;
    toggleField(els.provinceGroup, country === 'china', !bootEnded);
    toggleField(els.prefectureGroup, country === 'japan', !bootEnded);
    els.province.required = country === 'china';
    els.prefecture.required = country === 'japan';
    updateOriginReadout();
  }

  // 读数条换值：旧值向上淡出、新值从下方对焦，圆点同时脉冲一下
  function setReadoutValue(value, text, isEmpty) {
    if (!value) return;
    if (gsap && !reduced && value.textContent !== text) {
      gsap.killTweensOf(value);
      gsap.timeline()
        .to(value, { y: -7, opacity: 0, duration: 0.14, ease: 'power2.in' })
        .call(function () {
          value.textContent = text;
          value.classList.toggle('is-empty', isEmpty);
        })
        .fromTo(value, { y: 9, opacity: 0 }, { y: 0, opacity: 1, duration: 0.36, ease: 'power3.out' });
    } else {
      value.textContent = text;
      value.classList.toggle('is-empty', isEmpty);
    }
  }

  function pulseDot(dot) {
    if (!gsap || reduced || !dot) return;
    gsap.killTweensOf(dot);
    gsap.fromTo(dot, { scale: 0.6 }, { scale: 1, duration: 0.5, ease: 'back.out(2.4)' });
    // 一圈扩散光晕：用 halo 令牌，两套主题都合适
    var halo = window.getComputedStyle(dot).getPropertyValue('--halo').trim() || 'rgba(192,54,42,.14)';
    gsap.fromTo(dot,
      { boxShadow: '0 0 0 0 ' + halo },
      { boxShadow: '0 0 0 8px rgba(0,0,0,0)', duration: 0.65, ease: 'power2.out' });
  }

  function updateOriginReadout() {
    var box = $('v2OriginReadout');
    var value = $('v2OriginValue');
    if (!box || !value) return;
    var country = els.country.value;
    var text = '';
    if (country === 'china') {
      text = els.province.value ? '中国 · ' + els.province.value : '';
    } else if (country === 'japan') {
      var option = els.prefecture.options[els.prefecture.selectedIndex];
      text = els.prefecture.value && option ? '日本 · ' + option.textContent : '';
    } else {
      text = '海外';
    }
    var wasReady = box.classList.contains('is-ready');
    var ready = !!text;
    setReadoutValue(value, text || '尚未定位', !text);
    box.classList.toggle('is-ready', ready);
    if (ready && !wasReady) pulseDot(box.querySelector('.v2-readout-dot'));
  }

  function updateRoleReadout() {
    var box = $('v2RoleReadout');
    var value = $('v2RoleValue');
    if (!box || !value) return;
    var role = els.applicantRole.value;
    var wasReady = box.classList.contains('is-ready');
    setReadoutValue(value, ROLE_LABEL[role] || role, false);
    box.classList.add('is-ready');
    if (!wasReady) pulseDot(box.querySelector('.v2-readout-dot'));
  }

  function renderPrefectures() {
    var list = window.JAPAN_PREFECTURES;
    if (!Array.isArray(list) || !list.length) return;
    var groups = {};
    var order = [];
    list.forEach(function (item) {
      var region = item.regionZh || '其他';
      if (!groups[region]) { groups[region] = []; order.push(region); }
      groups[region].push(item);
    });
    var html = '<option value="">请选择都道府县</option>';
    order.forEach(function (region) {
      html += '<optgroup label="' + escapeHTML(region) + '">';
      groups[region].forEach(function (item) {
        html += '<option value="' + escapeHTML(item.jaName) + '">' + escapeHTML(item.zhName) + '</option>';
      });
      html += '</optgroup>';
    });
    els.prefecture.innerHTML = html;
  }

  /* ------------------------------------------------------------ 校验 */

  function clearFieldError(id) {
    var error = $('e-' + id);
    var field = $(id);
    if (error) {
      if (gsap && !reduced && !error.hidden) {
        gsap.killTweensOf(error);
        gsap.to(error, {
          height: 0, opacity: 0, y: -4, duration: 0.22, ease: 'power2.in',
          onComplete: function () { error.hidden = true; error.textContent = ''; gsap.set(error, { clearProps: 'height,opacity,transform' }); }
        });
      } else {
        error.hidden = true;
        error.textContent = '';
      }
    }
    if (field) field.removeAttribute('aria-invalid');
  }

  function clearErrors() {
    ['clubName', 'schoolName', 'province', 'prefecture', 'contact', 'applicantRole'].forEach(clearFieldError);
  }

  function shake(field) {
    if (!gsap || reduced || !field) return;
    gsap.timeline()
      .to(field, { x: -5, duration: 0.07, ease: 'power2.out' })
      .to(field, { x: 5, duration: 0.09 })
      .to(field, { x: -3, duration: 0.08 })
      .to(field, { x: 0, duration: 0.14, ease: 'power2.out' });
  }

  function showFieldError(id, message) {
    var error = $('e-' + id);
    var field = $(id);
    if (error) {
      var alreadyOpen = !error.hidden;
      error.textContent = message;
      error.hidden = false;
      if (gsap && !reduced && !alreadyOpen) {
        gsap.killTweensOf(error);
        // 从零高度展开，避免提示突然把下方内容顶开
        gsap.fromTo(error,
          { height: 0, opacity: 0, y: -5 },
          { height: 'auto', opacity: 1, y: 0, duration: 0.34, ease: 'power3.out' });
      }
    }
    if (field) field.setAttribute('aria-invalid', 'true');
    shake(field);
  }

  function validate(step) {
    var errors = [];
    if (step === 0) {
      if (!els.clubName.value.trim()) errors.push(['clubName', '请填写同好会名称']);
      if (typeValue() === 'school' && !els.schoolName.value.trim()) errors.push(['schoolName', '请填写学校名称']);
    } else if (step === 1) {
      var country = els.country.value;
      if (country === 'china' && !els.province.value) errors.push(['province', '请选择省份']);
      if (country === 'japan' && !els.prefecture.value) errors.push(['prefecture', '请选择都道府县']);
    } else if (step === 2) {
      if (!els.contact.value.trim()) errors.push(['contact', '请填写群号或联系方式']);
    } else if (step === 4) {
      if (!els.applicantRole.value) errors.push(['applicantRole', '请选择你在同好会中的角色']);
    }
    return errors;
  }

  function validateUpTo(step) {
    var all = [];
    for (var i = 0; i <= step; i++) all = all.concat(validate(i));
    return all;
  }

  /* ------------------------------------------------------------ 核对 */

  var RAIL_NAMES = ['INTAKE', 'ORIGIN', 'SIGNAL', 'ARCHIVE', 'OPERATOR', 'CONFIRM'];
  var ORBIT_TAGS = ['NAME', 'PLACE', 'LINK', 'STORY', 'YOU', 'CHECK'];
  var TYPE_LABEL = { school: '高校同好会', region: '地区高校联合', vnfest: '视觉小说学园祭' };
  var ROLE_LABEL = { external: '其他', member: '成员', manager: '管理员', representative: '负责人' };
  var COUNTRY_LABEL = { china: '中国', japan: '日本', overseas: '海外' };

  function renderReview() {
    var data = collectPayload();
    var location = data.country === 'japan' ? data.prefecture
      : data.country === 'overseas' ? '海外'
        : data.province;

    var groups = [
      { step: 0, title: 'INTAKE / 组织', rows: [['组织类型', TYPE_LABEL[data.type] || data.type], ['名称', data.name], ['学校', data.school]] },
      { step: 1, title: 'ORIGIN / 坐标', rows: [['国家', COUNTRY_LABEL[data.country] || data.country], ['地区', location]] },
      { step: 2, title: 'SIGNAL / 联络', rows: [['联系方式', data.info]] },
      { step: 3, title: 'ARCHIVE / 故事', rows: [['成立时间', data.created_at], ['群简介', data.remark]] },
      { step: 4, title: 'OPERATOR / 填写者', rows: [['角色', ROLE_LABEL[data.applicant_role] || data.applicant_role], ['联系方式', data.submitter]] }
    ];

    var html = groups.map(function (group) {
      var rows = group.rows.map(function (row) {
        var value = row[1];
        var cell = value ? escapeHTML(value) : '<span class="is-empty">未填写</span>';
        return '<dt>' + escapeHTML(row[0]) + '</dt><dd' + (value ? '' : ' class="is-empty"') + '>' + cell + '</dd>';
      }).join('');
      return '<div class="v2-review-group">'
        + '<div class="v2-review-head"><h3>' + escapeHTML(group.title) + '</h3>'
        + '<button type="button" class="v2-review-edit" data-goto="' + group.step + '">修改 ↗</button></div>'
        + '<dl>' + rows + '</dl></div>';
    }).join('');

    els.review.innerHTML = html;

    // 五组卡片逐组浮起，读起来像在逐条核对
    if (gsap && !reduced) {
      var groups = els.review.querySelectorAll('.v2-review-group');
      var rows = els.review.querySelectorAll('.v2-review-group dd');
      gsap.killTweensOf([groups, rows]);
      gsap.fromTo(groups,
        { y: 22, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.55, stagger: 0.06, ease: 'power3.out', clearProps: 'transform' });
      gsap.fromTo(rows,
        { opacity: 0, x: -6 },
        { opacity: 1, x: 0, duration: 0.4, stagger: 0.03, delay: 0.16, ease: 'power2.out', clearProps: 'transform' });
    }
  }

  /* ------------------------------------------------------------ 界面 */

  function syncButtons() {
    els.back.disabled = state.step === 0 || state.busy || state.done;
    els.next.disabled = state.busy || state.done || !authReady;
  }

  // 章节栏角色：仅在切换章节时换图，预载下一张，避免闪白
  function chibiSrc(id, size) {
    return './image/chibi-web/character-' + id + '-' + size + '.webp';
  }

  function preloadChibi(id) {
    if (!id || decoLoaded[id]) return;
    decoLoaded[id] = true;
    var img = new Image();
    img.src = chibiSrc(id, 384);
  }

  function updateDecoChibi() {
    var img = els.decoChibi;
    if (!img) return;
    var id = DECO_CHIBI[state.step];
    if (!id || decoShown === id) return;
    decoShown = id;

    preloadChibi(DECO_CHIBI[state.step + 1]);

    img.classList.remove('is-visible');
    var swap = function () {
      img.src = chibiSrc(id, 384);
      img.srcset = chibiSrc(id, 256) + ' 256w, ' + chibiSrc(id, 384) + ' 384w';
      img.classList.add('is-visible');
      if (gsap && !reduced) {
        gsap.fromTo(img, { y: 14, scale: .9 }, { y: 0, scale: 1, duration: .55, ease: 'back.out(1.6)' });
      }
    };
    if (img.getAttribute('src')) swap();
    else window.setTimeout(swap, 400);
  }

  // 换文字时做一次轻量的「翻页」，比直接替换更有节奏（竖排文字用 x 轴）
  function swapText(el, text, axis) {
    if (!el || el.textContent === text) return;
    if (!gsap || reduced) { el.textContent = text; return; }

    var vertical = axis === 'x';
    gsap.killTweensOf(el);
    var outProps = { opacity: 0, duration: 0.11, ease: 'power1.in' };
    outProps[vertical ? 'x' : 'y'] = vertical ? -9 : -6;

    gsap.timeline()
      .to(el, outProps)
      .call(function () { el.textContent = text; })
      .fromTo(el,
        (function () { var o = { opacity: 0 }; o[vertical ? 'x' : 'y'] = vertical ? 10 : 7; return o; })(),
        (function () { var o = { opacity: 1, duration: 0.3, ease: 'power3.out' }; o[vertical ? 'x' : 'y'] = 0; return o; })());
  }

  // 轨道插图：标签随章节换，圆环按不同速度回正，形成「轨道在转」的错觉
  function updateOrbit(direction) {
    if (els.orbitTag) swapText(els.orbitTag, ORBIT_TAGS[state.step] || '');
    if (!gsap || reduced) return;
    var rings = els.orbitRings;
    if (!rings || !rings.length) return;
    var spins = [14, 9, 5];
    for (var i = 0; i < rings.length && i < spins.length; i++) {
      gsap.fromTo(rings[i],
        { rotation: -(direction || 1) * spins[i], scale: 0.94 },
        { rotation: 0, scale: 1, duration: 1 + i * 0.12, ease: 'power2.out', overwrite: 'auto' });
    }
  }

  // 左栏叙事随步骤切换：出门的往上走、进门的从下方淡入，节奏比右栏慢半拍
  function updateTales(direction) {
    if (!compactQuery.matches) updateOrbit(direction);
    var list = els.taleEls;
    if (!list || !list.length) return;
    var next = list[state.step];
    if (!next) return;

    for (var i = 0; i < list.length; i++) {
      var active = i === state.step;
      // Mobile tales occupy separate rows: transparency alone still takes up space.
      list[i].classList.toggle('is-current', active);
      list[i].setAttribute('aria-hidden', active ? 'false' : 'true');
      list[i].inert = !active;
      if (gsap) {
        gsap.killTweensOf([list[i]].concat(Array.from(list[i].children)));
        gsap.set(list[i].children, { clearProps: 'transform,filter,opacity' });
        gsap.set(list[i], { autoAlpha: active ? 1 : 0, clearProps: 'transform,filter' });
      }
    }

    if (!gsap || reduced) {
      return;
    }

    if (compactQuery.matches) {
      gsap.fromTo(next,
        { autoAlpha: 0, y: (direction || 1) * 6 },
        { autoAlpha: 1, y: 0, duration: 0.24, ease: 'power3.out', clearProps: 'transform' });
      return;
    }

    var title = next.querySelector('.v2-tale-title');
    var lede = next.querySelector('.v2-tale-lede');
    var kicker = next.querySelector('.v2-kicker');
    gsap.killTweensOf([next, title, lede, kicker]);

    gsap.fromTo(next,
      { autoAlpha: 0, y: (direction || 1) * 26, filter: 'blur(8px)' },
      { autoAlpha: 1, y: 0, filter: 'blur(0px)', duration: 0.72, ease: 'power3.out', delay: 0.04 });
    if (title) {
      gsap.fromTo(title,
        { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.62, ease: 'power3.out', delay: 0.1, clearProps: 'transform' });
    }
    if (lede) {
      gsap.fromTo(lede,
        { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.58, ease: 'power2.out', delay: 0.16, clearProps: 'transform' });
    }
    if (kicker) {
      gsap.fromTo(kicker,
        { y: 10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: 'power2.out', delay: 0.06, clearProps: 'transform' });
    }
  }

  function updateChrome() {
    var items = document.querySelectorAll('.v2-rail-item');
    for (var i = 0; i < items.length; i++) {
      var index = Number(items[i].getAttribute('data-rail'));
      var wasActive = items[i].classList.contains('is-active');
      items[i].classList.toggle('is-active', index === state.step);
      items[i].classList.toggle('is-done', index < state.step);
      if (index !== state.step) items[i].removeAttribute('aria-current');
      // 新选中的那一项数字弹一下
      if (!wasActive && index === state.step && gsap && !reduced && !compactQuery.matches) {
        var num = items[i].querySelector('.v2-rail-num');
        if (num) {
          gsap.killTweensOf(num);
          gsap.fromTo(num, { scale: 0.72, opacity: 0.4 }, { scale: 1, opacity: 1, duration: 0.5, ease: 'back.out(2)' });
        }
      }
    }
    var railActive = document.querySelector('.v2-rail-item.is-active');
    if (railActive) railActive.setAttribute('aria-current', 'step');

    // 中缝刻度：当前章节那格换成红色
    if (els.ruleTicks && els.ruleTicks.length) {
      for (var t = 0; t < els.ruleTicks.length; t++) {
        var on = Number(els.ruleTicks[t].getAttribute('data-tick')) === state.step;
        if (on && !els.ruleTicks[t].classList.contains('is-current') && gsap && !reduced) {
          gsap.fromTo(els.ruleTicks[t], { scaleX: 0.2, opacity: 0 }, { scaleX: 1, opacity: 1, duration: 0.5, ease: 'back.out(2)' });
        }
        els.ruleTicks[t].classList.toggle('is-current', on);
      }
    }

    if (gsap) {
      gsap.to(els.progress, { scaleX: (state.step + 1) / TOTAL, duration: 0.7, ease: 'power3.out' });
    } else {
      els.progress.style.transform = 'scaleX(' + ((state.step + 1) / TOTAL) + ')';
    }

    var nextLabel = els.next.querySelector('.v2-next-label');
    if (nextLabel) swapText(nextLabel, state.step === TOTAL - 1 ? (production ? '确认提交' : '模拟提交') : returnToReview ? '返回核对' : '继续');
    syncButtons();

    var stepText = ('0' + (state.step + 1)).slice(-2);
    if (els.navCount) els.navCount.textContent = stepText + ' / ' + ('0' + TOTAL).slice(-2);
    if (els.decoNum) {
      if (els.decoNum.textContent !== stepText) {
        els.decoNum.textContent = stepText;
        if (gsap && !reduced) gsap.fromTo(els.decoNum, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: 'power3.out' });
      }
    }
    if (els.decoName) swapText(els.decoName, RAIL_NAMES[state.step] || '', 'x');
    updateDecoChibi();

    var live = state.step === TOTAL - 1
      ? '第 ' + TOTAL + ' 步，共 ' + TOTAL + ' 步。核对信息后提交。'
      : '第 ' + (state.step + 1) + ' 步，共 ' + TOTAL + ' 步。';
    els.live.textContent = live;
    els.stepEls[state.step].scrollTop = 0;
  }

  /* 右栏只剩字段，按「整块 → 单个控件」分两层：
     0 = 分组标题/说明，1 = 字段与控件。左栏叙事自己在 updateTales 里做景深。 */
  function depthLayers(section) {
    var layers = [[], []];
    var children = section ? section.children : [];
    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      var depth = 1;
      if (el.classList.contains('v2-fieldset') || el.classList.contains('v2-review')) depth = 0;
      layers[depth].push(el);
    }
    return layers;
  }

  function goTo(target, options) {
    options = options || {};
    if (state.busy || state.done || target < 0 || target >= TOTAL || target === state.step) return;

    var from = els.stepEls[state.step];
    var to = els.stepEls[target];
    var direction = target > state.step ? 1 : -1;
    stepDirection = direction;
    var previous = state.step;
    state.step = target;
    state.busy = true;
    els.stepEls.forEach(function (section, index) { section.inert = index !== target; });

    updateChrome();
    updateTales(direction);
    clearErrors();
    // 背景光晕按累计偏移缓慢移动，比内容慢一拍
    if (canvasApi) canvasApi.parallax(direction * -34);

    if (!gsap || reduced) {
      els.stepEls.forEach(function (section, index) {
        var active = index === target;
        section.style.visibility = active ? 'visible' : 'hidden';
        section.style.opacity = active ? '1' : '0';
        section.style.filter = 'none';
        section.style.transform = 'none';
      });
      state.busy = false;
      syncButtons();
      focusHeading(target, options.focus);
      return;
    }

    // Compact screens move as one group, keeping controls steady and the next step ready in 280ms.
    if (compactQuery.matches) {
      gsap.killTweensOf([from, to, els.rail, els.tales]);
      gsap.set([els.rail, els.tales], { clearProps: 'transform' });
      gsap.set(from.children, { clearProps: 'transform,filter,opacity' });
      gsap.set(to.children, { clearProps: 'transform,filter,opacity' });
      gsap.set([from, to], { clearProps: 'transform,filter' });
      gsap.timeline({ onComplete: function () {
        gsap.set([from, to], { clearProps: 'transform,filter' });
        gsap.set(from, { autoAlpha: 0 });
        state.busy = false;
        syncButtons();
        focusHeading(target, options.focus);
      } })
        .to(from, { autoAlpha: 0, y: -direction * 6, duration: 0.1, ease: 'power1.in' }, 0)
        .fromTo(to, { autoAlpha: 0, y: direction * 8 },
          { autoAlpha: 1, y: 0, duration: 0.2, ease: 'power3.out' }, 0.08);
      return;
    }

    var outLayers = depthLayers(from);
    var inLayers = depthLayers(to);
    // 越靠近观察者的层退得越多、糊得越重（outDepth 给的是正距离，方向由 direction 决定）
    var outDepth = [
      { y: 24, blur: 4, duration: 0.28 },
      { y: 48, blur: 8, duration: 0.32 }
    ];
    // 越近的层起始位移越大、落定略晚，形成层次
    var inDepth = [
      { y: 28, blur: 3, duration: 0.54, delay: 0.2 },
      { y: 56, blur: 6, duration: 0.64, delay: 0.24 }
    ];

    var tl = gsap.timeline({
      onComplete: function () {
        state.busy = false;
        syncButtons();
        // 清掉内联样式，避免残留 transform 影响日期浮层的层叠上下文
        gsap.set(from.children, { clearProps: 'transform,filter,opacity' });
        gsap.set(to.children, { clearProps: 'transform,filter,opacity' });
        gsap.set(from, { clearProps: 'transform,filter' });
        gsap.set(to, { clearProps: 'transform,filter' });
        // clearProps 会把 visibility 一并还原，这里按当前步骤重新钉住
        els.stepEls.forEach(function (section, index) {
          if (index === target) return;
          section.style.visibility = 'hidden';
          section.style.opacity = '0';
        });
      }
    });

    // 旧屏：整体轻微后缩（相机拉远），两层各按景深退场
    tl.to(from, { scale: 0.94, duration: 0.42, ease: 'power2.in' }, 0);
    for (var d = 0; d < outDepth.length; d++) {
      if (!outLayers[d].length) continue;
      tl.to(outLayers[d], {
        y: direction * outDepth[d].y * -1,
        opacity: 0,
        filter: 'blur(' + outDepth[d].blur + 'px)',
        duration: outDepth[d].duration,
        ease: 'power2.in'
      }, d * 0.02);
    }
    tl.set(from, { visibility: 'hidden' }, 0.42);

    // 新屏：从更近处推入（scale > 1），三层依次对焦
    tl.fromTo(to,
      { autoAlpha: 0, scale: 1.045 },
      { autoAlpha: 1, scale: 1, duration: 0.85, ease: 'power3.out' }, 0.14);

    for (var e = 0; e < inDepth.length; e++) {
      if (!inLayers[e].length) continue;
      tl.fromTo(inLayers[e],
        { y: direction * inDepth[e].y, opacity: 0, filter: 'blur(' + inDepth[e].blur + 'px)' },
        {
          y: 0, opacity: 1, filter: 'blur(0px)',
          duration: inDepth[e].duration, ease: 'power3.out'
        }, inDepth[e].delay);
    }

    tl.fromTo(els.shutter,
      { y: -10, opacity: 0.14 },
      { y: window.innerHeight, opacity: 0, duration: 0.55, ease: 'power1.in' }, 0.1)
      // 左右两侧逆向微移，把中间推得更前（左栏叙事比右栏慢）
      .fromTo([els.rail, els.tales], { x: direction * 10 }, { x: 0, duration: 0.7, ease: 'power3.out' }, 0.1)
      .call(function () { focusHeading(target, options.focus); }, null, 0.78);

    els.stepEls[target].scrollTop = 0;
    void previous;
  }

  function focusHeading(index, fieldId) {
    if (fieldId && $(fieldId)) {
      $(fieldId).focus({ preventScroll: false });
      return;
    }
    var heading = $('v2h' + index);
    if (heading) heading.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------ 流程 */

  function clearSubmitError() {
    var message = $('v2SubmitError');
    if (message) { message.hidden = true; message.textContent = ''; }
  }

  function showSubmitError(text) {
    var message = $('v2SubmitError');
    if (!message) return;
    message.textContent = text;
    message.hidden = false;
    message.focus({ preventScroll: false });
    els.live.textContent = text;
  }

  function redirectToLogin() {
    authReady = false;
    syncButtons();
    window.location.replace('./login.html?redirect=submit.html');
  }

  async function checkAuth() {
    if (!production || authChecking) return;
    authChecking = true;
    var message = $('v2AuthMessage');
    var retry = $('v2AuthRetry');
    if (message) message.textContent = '正在确认登录状态…';
    if (retry) retry.hidden = true;
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 12000);
    try {
      var response = await fetch('./api/auth.php?action=me', {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal
      });
      if (response.status === 401 || response.status === 403) { redirectToLogin(); return; }
      if (!response.ok) throw new Error('auth-unavailable');
      var result = await response.json();
      if (result && result.logged_in === false) { redirectToLogin(); return; }
      if (!result || result.logged_in !== true) throw new Error('auth-invalid');
      authReady = true;
      var gate = $('v2AuthGate');
      if (gate) gate.hidden = true;
      els.boot.inert = false;
      beginExperience();
    } catch (error) {
      if (message) message.textContent = '暂时无法确认登录状态，请检查网络后重试。';
      if (retry) retry.hidden = false;
    } finally {
      window.clearTimeout(timeout);
      authChecking = false;
    }
  }

  async function submitLive() {
    if (state.busy || state.done || !authReady) return;
    var payload = collectPayload();
    state.busy = true;
    els.form.inert = true;
    syncButtons();
    clearSubmitError();
    var label = els.next.querySelector('.v2-next-label');
    if (label) {
      if (gsap) gsap.killTweensOf(label);
      label.textContent = '正在提交…';
    }
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 20000);
    try {
      var response = await fetch('./api/submit.php', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal
      });
      if (response.status === 401) { redirectToLogin(); return; }
      var result;
      try { result = await response.json(); }
      catch (error) { throw new Error('尚未确认提交结果。请先到个人中心查看提交记录，再决定是否重试。'); }
      if (result && result.logged_in === false) { redirectToLogin(); return; }
      if (!response.ok || !result || result.success !== true) {
        throw new Error(result && typeof result.message === 'string' ? result.message.slice(0, 400) : '提交未成功，请稍后重试。');
      }
      var receipt = $('v2Receipt');
      if (receipt) receipt.textContent = '提交成功 · 等待管理员审核' + (result.id ? ' · 编号 ' + String(result.id) : '');
      showDone();
    } catch (error) {
      showSubmitError(error instanceof TypeError || error.name === 'AbortError'
        ? '网络中断或请求超时，尚未确认提交结果。请先到个人中心查看提交记录，再决定是否重试。'
        : error.message || '提交未成功，请稍后重试。');
    } finally {
      window.clearTimeout(timeout);
      state.busy = false;
      els.form.inert = false;
      syncButtons();
      if (label) label.textContent = '确认提交';
    }
  }

  function next() {
    if (state.busy || state.done || !authReady) return;
    var errors = validate(state.step);
    if (errors.length) {
      errors.forEach(function (pair) { showFieldError(pair[0], pair[1]); });
      if (errors[0][0]) focusHeading(state.step, errors[0][0]);
      return;
    }
    clearErrors();
    clearSubmitError();
    if (returnToReview && state.step < TOTAL - 1) {
      returnToReview = false;
      renderReview();
      goTo(TOTAL - 1);
      return;
    }
    if (state.step === 4) renderReview();
    if (state.step < TOTAL - 1) goTo(state.step + 1);
    else submit();
  }

  function back() {
    if (state.busy || state.done || state.step === 0) return;
    goTo(state.step - 1);
  }

  function submit() {
    var errors = validateUpTo(TOTAL - 1);
    if (errors.length) {
      var firstId = errors[0][0];
      var section = $(firstId).closest('[data-step]');
      var target = Number(section.getAttribute('data-step'));
      if (target !== state.step) goTo(target, { focus: firstId });
      errors.forEach(function (pair) { showFieldError(pair[0], pair[1]); });
      if (target === state.step && !state.busy) focusHeading(target, firstId);
      return;
    }
    if (production) { submitLive(); return; }
    state.busy = true;
    els.next.disabled = true;

    if (!gsap || reduced) { showDone(); return; }

    gsap.timeline()
      .fromTo(els.shutter, { y: -10, opacity: 0.2 }, { y: window.innerHeight, opacity: 0, duration: 0.5, ease: 'power1.in' }, 0)
      .to(els.stepEls[state.step].children, { y: 34, opacity: 0, duration: 0.42, stagger: 0.035, ease: 'power2.in' }, 0.06)
      .call(showDone, null, 0.62);
  }

  function showDone() {
    state.done = true;
    state.busy = false;
    els.stage.inert = true;
    var done = els.done;
    done.hidden = false;

    if (!gsap || reduced) {
      done.style.opacity = '1';
      var title = done.querySelector('#v2DoneTitle');
      if (title) title.focus({ preventScroll: true });
      return;
    }

    gsap.timeline()
      .fromTo(done, { opacity: 0 }, { opacity: 1, duration: 0.55, ease: 'power2.out' }, 0)
      .fromTo(done.querySelectorAll('.v2-done-beam'),
        { scaleX: 0, opacity: 0 }, { scaleX: 1, opacity: 1, duration: 1, ease: 'expo.out' }, 0.1)
      .fromTo(done.querySelectorAll('.v2-kicker, .v2-done-status, .v2-done-desc, .v2-done-demo, .v2-done-actions'),
        { y: 22, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, stagger: 0.08, ease: 'power2.out' }, 0.24)
      .fromTo(done.querySelector('#v2DoneTitle'),
        { y: 34, opacity: 0, filter: 'blur(16px)', scale: 0.98 },
        { y: 0, opacity: 1, filter: 'blur(0px)', scale: 1, duration: 1.15, ease: 'power3.out' }, 0.18)
      .call(function () {
        var title = done.querySelector('#v2DoneTitle');
        if (title) title.focus({ preventScroll: true });
      }, null, 0.2);
  }

  function restart() {
    els.done.hidden = true;
    els.form.reset();
    state.step = 0;
    state.busy = false;
    state.done = false;
    returnToReview = false;
    els.form.inert = false;
    els.stage.inert = false;
    clearSubmitError();
    els.stepEls.forEach(function (section, index) { section.inert = index !== 0; });
    clearErrors();
    applyDefaults();
    renderPrefectures();
    if (els.prefecture.options.length > 1) els.prefecture.value = '';
    if (datePickerApi) datePickerApi.reset();
    updateOriginReadout();
    updateRoleReadout();

    if (gsap) {
      gsap.set(els.stepEls, { autoAlpha: 0, visibility: 'hidden', y: 0, filter: 'blur(0px)' });
      gsap.set(els.stepEls[0], { autoAlpha: 1, visibility: 'visible' });
    } else {
      els.stepEls.forEach(function (section, index) {
        section.style.visibility = index === 0 ? 'visible' : 'hidden';
        section.style.opacity = index === 0 ? '1' : '0';
      });
    }
    updateChrome();
    updateTales(1);
    focusHeading(0);
  }

  function applyDefaults() {
    var school = document.querySelector('input[name="clubType"][value="school"]');
    if (school) school.checked = true;
    els.country.value = 'china';
    els.applicantRole.value = 'member';
    updateSchool();
    updateCountry();
  }

  /* ------------------------------------------------------------ 邀请 */


  function playBoot() {
    var lines = els.bootLines;
    var loadTime = 1.3;
    var entryStart = 1.75;
    var gap = 3.2;
    bootStart = (window.performance && performance.now) ? performance.now() : Date.now();
    els.boot.classList.add('is-playing');

    if (!gsap) { endBoot(null, true); return; }

    var tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    bootTimeline = tl;

    var inkPieces = document.querySelectorAll('#bootLogo .mark-ink .piece');
    var accentPieces = document.querySelectorAll('#bootLogo .mark-accent .piece');

    // 阶段一：百分比加载
    var progress = { value: 0 };
    var ringLength = 2 * Math.PI * 54;
    tl.to(progress, {
      value: 100,
      duration: loadTime,
      ease: 'power1.inOut',
      onUpdate: function () {
        var pct = Math.round(progress.value);
        if (els.bootPct) els.bootPct.textContent = pct;
        if (els.bootRing) els.bootRing.style.strokeDashoffset = String(ringLength * (1 - progress.value / 100));
      }
    }, 0)
      .call(function () {
        if (els.bootPct) els.bootPct.textContent = '100';
        if (els.bootRing) els.bootRing.style.strokeDashoffset = '0';
        els.boot.classList.add('is-complete');
      }, null, loadTime)
      .to(els.bootLoading, { opacity: 0, y: -16, duration: 0.42, ease: 'power2.in' }, loadTime + 0.28)
      .set(els.bootLoading, { display: 'none' })

      // 阶段二：入场
      .fromTo(inkPieces,
        { opacity: 0, y: 22, filter: 'blur(12px)' },
        { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.85, stagger: 0.045, ease: 'power3.out' }, entryStart)
      .fromTo(accentPieces,
        { opacity: 0, y: 14, filter: 'blur(10px)' },
        { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.75, stagger: 0.06, ease: 'back.out(1.7)' }, entryStart + 0.45);

    // logo 单独占一段，播完退场，再进入逐句文案
    var logoOut = entryStart + 1.2;
    var linesStart = logoOut + 0.7;
    tl.to('#bootLogo', { opacity: 0, y: -24, filter: 'blur(9px)', duration: 0.7, ease: 'power2.in' }, logoOut);

    lines.forEach(function (line, index) {
      var at = linesStart + index * gap;
      var text = line.querySelector('.v2-boot-text');
      var meta = line.querySelector('.v2-boot-meta');

      tl.to(line, {
        autoAlpha: 1, filter: 'blur(0px)', y: 0,
        duration: 0.85, ease: 'power2.out'
      }, at);

      if (text) {
        tl.fromTo(text,
          { letterSpacing: '0.34em', textIndent: '0.34em' },
          { letterSpacing: '0.03em', textIndent: '0.03em', duration: 1.2, ease: 'power2.out' }, at);
      }
      if (meta) {
        tl.fromTo(meta, { opacity: 0 }, { opacity: 0.6, duration: 0.9, ease: 'power1.out' }, at + 0.3);
      }

      if (index < lines.length - 1) {
        tl.to(line, {
          autoAlpha: 0, filter: 'blur(10px)', y: -10,
          duration: 0.65, ease: 'power1.in'
        }, at + 2.55);
      }
    });

    // 最后一句出完后显示入口，不再自动跳转；右上角的跳过随之收起
    var ctaAt = linesStart + (lines.length - 1) * gap + 1.35;
    tl.call(function () {
      var cta = $('bootEnter');

      if (els.bootSkip) {
        if (gsap && !reduced) {
          gsap.to(els.bootSkip, { autoAlpha: 0, duration: 0.5, ease: 'power2.in', delay: 0.2 });
        } else {
          els.bootSkip.style.opacity = '0';
          els.bootSkip.style.visibility = 'hidden';
        }
      }

      if (!cta) return;
      cta.hidden = false;
      if (gsap && !reduced) {
        gsap.fromTo(cta, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.7, ease: 'power2.out' });
      } else {
        cta.style.opacity = '1';
      }
    }, null, ctaAt);
  }

  function bootExitAllowed() {
    if (bootEnded) return false;
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    return now - bootStart > 1200;
  }

  function endBoot(origin, immediate) {
    if (bootEnded) return;
    bootEnded = true;
    if (bootTimeline) { bootTimeline.kill(); bootTimeline = null; }

    var proceed = function () {
      document.body.classList.add('is-boot-done');
      revealStage(origin);
    };

    if (immediate || !gsap || reduced) { proceed(); return; }

    gsap.to(els.boot, {
      opacity: 0, duration: 0.45, ease: 'power2.in',
      onComplete: function () {
        els.boot.style.pointerEvents = 'none';
        proceed();
      }
    });
  }

  function revealStage(origin) {
    var x = origin && typeof origin.x === 'number' ? origin.x : window.innerWidth / 2;
    var y = origin && typeof origin.y === 'number' ? origin.y : window.innerHeight / 2;

    els.veil.style.setProperty('--ox', x + 'px');
    els.veil.style.setProperty('--oy', y + 'px');
    document.body.classList.add('is-stage-on');

    var clearVeil = function () { els.veil.style.display = 'none'; };

    if (!gsap || reduced) {
      clearVeil();
      stageOn();
      return;
    }

    // 洞的半径按「圆心到最远屏幕角」算：从右上角出发时左下角需要的距离，
    // 比固定 70vmax 大得多，否则扩到终点也盖不满，边缘会留下一条黑色。
    var vmax = Math.max(window.innerWidth, window.innerHeight) / 100;
    var holeRadius = 70 * vmax;
    var farX = Math.max(x, window.innerWidth - x);
    var farY = Math.max(y, window.innerHeight - y);
    var targetScale = (Math.hypot(farX, farY) + 32) / holeRadius;

    gsap.set(els.hole, { scale: 0 });
    var firstTale = els.taleEls && els.taleEls[0];
    gsap.timeline({ onComplete: clearVeil })
      // power2.out 而不是 expo.inOut：后者尾段几乎不动，看起来像卡住
      .to(els.hole, { scale: targetScale, duration: 0.85, ease: 'power2.out' }, 0)
      .fromTo(els.stage, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'power2.out' }, 0.08)
      .fromTo(els.top, { y: -18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.75, ease: 'power3.out' }, 0.3)
      .fromTo(els.rail, { y: -12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, ease: 'power3.out' }, 0.34)
      // 左栏叙事先到，右栏字段随后落定，视线由左向右
      .fromTo(firstTale ? firstTale.children : [],
        { y: 26, opacity: 0, filter: 'blur(9px)' },
        { y: 0, opacity: 1, filter: 'blur(0px)', duration: 0.85, stagger: 0.07, ease: 'power3.out', clearProps: 'transform,filter' }, 0.38)
      .fromTo(els.column, { y: 30, opacity: 0, filter: 'blur(10px)' }, { y: 0, opacity: 1, filter: 'blur(0px)', duration: 0.9, ease: 'power3.out' }, 0.5)
      .fromTo(els.stepEls[0].children, { y: 22, opacity: 0 }, { y: 0, opacity: 1, duration: 0.65, stagger: 0.05, ease: 'power2.out', clearProps: 'transform' }, 0.62)
      .call(stageOn, null, 0.42);

    // 兜底：标签页被挂起或时钟异常时，遮罩也必须消失
    window.setTimeout(clearVeil, 1500);

    if (canvasApi) canvasApi.start();
  }

  function stageOn() {
    els.boot.inert = true;
    els.stage.inert = false;
    els.stepEls.forEach(function (section, index) { section.inert = index !== state.step; });
    els.stage.style.opacity = '1';
    els.stage.style.pointerEvents = 'auto';
    updateChrome();
    if (!gsap || reduced) {
      els.stepEls.forEach(function (section, index) {
        section.style.visibility = index === 0 ? 'visible' : 'hidden';
        section.style.opacity = index === 0 ? '1' : '0';
      });
    } else if (els.taleEls) {
      // 叙事已由 revealStage 逐个入场，这里只把非当前项钉成隐藏
      els.taleEls.forEach(function (tale, index) {
        if (index === state.step) {
          gsap.set(tale, { autoAlpha: 1, visibility: 'visible' });
        } else {
          gsap.set(tale, { autoAlpha: 0, visibility: 'hidden' });
        }
      });
    }
    focusHeading(0);
  }

  /* ------------------------------------------------------------ 背景 */

  function initCanvas() {
    var canvas = $('v2Canvas');
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    var width = 0;
    var height = 0;
    var dpr = 1;
    var dots = [];
    var pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
    var offset = { value: 0, target: 0 };
    var running = false;
    var frameId = 0;
    var glare = $('v2Glare');
    var palette = { grid: 'rgba(255,255,255,0.03)', base: '255,255,255', hot: '255,122,99', hotAmount: 0.12, link: '255,122,99' };

    // 背景层配色由 CSS 变量提供，亮色/深色开屏共用同一份绘制逻辑
    function readPalette() {
      var style = window.getComputedStyle(document.body);
      var read = function (name, fallback) {
        var value = style.getPropertyValue(name).trim();
        return value || fallback;
      };
      palette.grid = read('--grid-line', 'rgba(255,255,255,0.03)');
      palette.base = read('--dot-base', '255,255,255');
      palette.hot = read('--dot-hot', '255,122,99');
      palette.hotAmount = parseFloat(read('--dot-hot-amount', '0.12')) || 0.12;
      palette.link = read('--link-ink', '255,122,99');
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth || window.innerWidth;
      height = canvas.clientHeight || window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!dots.length) {
        var count = Math.round(Math.min(150, Math.max(60, (width * height) / 12000)));
        for (var i = 0; i < count; i++) {
          dots.push({
            x: Math.random() * width,
            y: Math.random() * height,
            vx: (Math.random() - 0.5) * 0.16,
            vy: (Math.random() - 0.5) * 0.16,
            r: Math.random() * 1.1 + 0.35
          });
        }
      }
    }

    function draw() {
      ctx.clearRect(0, 0, width, height);
      pointer.x += (pointer.tx - pointer.x) * 0.06;
      pointer.y += (pointer.ty - pointer.y) * 0.06;
      offset.value += (offset.target - offset.value) * 0.055;

      var gap = 76;
      var shiftX = (pointer.x - 0.5) * 64;
      var shiftY = (pointer.y - 0.5) * 42 + offset.value;
      var startX = ((shiftX % gap) + gap) % gap - gap;
      var startY = ((shiftY % gap) + gap) % gap - gap;
      var x;
      var y;

      ctx.lineWidth = 1;
      ctx.strokeStyle = palette.grid;
      for (x = startX; x < width + gap; x += gap) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      }
      for (y = startY; y < height + gap; y += gap) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      }

      var mx = pointer.x * width;
      var my = pointer.y * height;

      for (var i = 0; i < dots.length; i++) {
        var dot = dots[i];
        dot.x += dot.vx;
        dot.y += dot.vy;
        if (dot.x < -24) dot.x = width + 24;
        if (dot.x > width + 24) dot.x = -24;
        if (dot.y < -24) dot.y = height + 24;
        if (dot.y > height + 24) dot.y = -24;

        var dx = dot.x - mx;
        var dy = dot.y - my;
        var distance = Math.sqrt(dx * dx + dy * dy);
        var heat = Math.max(0, 1 - distance / 200);

        ctx.beginPath();
        ctx.arc(dot.x, dot.y, dot.r + heat * 0.9, 0, Math.PI * 2);
        ctx.fillStyle = heat > 0.06
          ? 'rgba(' + palette.hot + ',' + (palette.hotAmount + heat * 0.6).toFixed(3) + ')'
          : 'rgba(' + palette.base + ',' + (0.1 + heat * 0.2).toFixed(3) + ')';
        ctx.fill();

        if (heat > 0.28) {
          for (var j = i + 1; j < dots.length; j++) {
            var other = dots[j];
            var ddx = other.x - dot.x;
            var ddy = other.y - dot.y;
            var squared = ddx * ddx + ddy * ddy;
            if (squared < 14000) {
              ctx.beginPath();
              ctx.moveTo(dot.x, dot.y);
              ctx.lineTo(other.x, other.y);
              ctx.strokeStyle = 'rgba(' + palette.link + ',' + (0.09 * heat).toFixed(3) + ')';
              ctx.lineWidth = 0.6;
              ctx.stroke();
            }
          }
        }
      }

      if (glare) {
        glare.style.setProperty('--gx', (pointer.x * 100).toFixed(2) + '%');
        glare.style.setProperty('--gy', (pointer.y * 100).toFixed(2) + '%');
      }

      if (running) frameId = window.requestAnimationFrame(draw);
    }

    function start() {
      if (running) return;
      if (reduced) { draw(); return; }
      running = true;
      frameId = window.requestAnimationFrame(draw);
    }

    function stop() {
      running = false;
      if (frameId) { window.cancelAnimationFrame(frameId); frameId = 0; }
    }

    window.addEventListener('resize', function () {
      resize();
      if (reduced) draw();
    }, { passive: true });

    window.addEventListener('pointermove', function (event) {
      pointer.tx = event.clientX / Math.max(1, window.innerWidth);
      pointer.ty = event.clientY / Math.max(1, window.innerHeight);
    }, { passive: true });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop();
      else start();
    });

    resize();
    readPalette();
    if (!reduced) draw();

    canvasApi = {
      start: start,
      stop: stop,
      refreshPalette: readPalette,
      parallax: function (value) {
        offset.target = value;
        if (els.stage) {
          els.stage.style.setProperty('--px', (value * 0.9).toFixed(1) + 'px');
          els.stage.style.setProperty('--py', (value * -0.7).toFixed(1) + 'px');
        }
      }
    };
  }

  /* ------------------------------------------------------------ 日期选择 */

  function injectMarks() {
    var svg = window.VNFEST_LOGO_SVG;
    if (!svg) return false;
    var boot = $('bootLogo');
    var brand = $('brandMark');
    if (boot) boot.innerHTML = svg;
    if (brand) brand.innerHTML = svg;
    return true;
  }
  function initDatePicker() {
    var trigger = $('v2DateTrigger');
    var panel = $('v2DatePanel');
    var textEl = $('v2DateText');
    var hidden = $('createdAt');
    var yearSel = $('v2DateYear');
    var monthSel = $('v2DateMonth');
    var grid = $('v2DateGrid');
    if (!trigger || !panel || !hidden || !yearSel || !monthSel || !grid) return null;

    // 外层容器（抬高层叠上下文用），之前一直没取到，导致 is-open 类从未生效
    var v2Datepicker = $('v2Datepicker') || panel.parentElement;

    var today = new Date();
    var todayStr = stamp(today.getFullYear(), today.getMonth(), today.getDate());
    var view = { y: today.getFullYear(), m: today.getMonth() };
    var draft = '';

    var yearHTML = '';
    for (var y = today.getFullYear() + 1; y >= today.getFullYear() - 40; y--) {
      yearHTML += '<option value="' + y + '">' + y + ' 年</option>';
    }
    yearSel.innerHTML = yearHTML;

    var monthHTML = '';
    for (var m = 0; m < 12; m++) {
      monthHTML += '<option value="' + m + '">' + (m + 1) + ' 月</option>';
    }
    monthSel.innerHTML = monthHTML;

    function pad(value) { return (value < 10 ? '0' : '') + value; }
    function stamp(year, month, day) { return year + '-' + pad(month + 1) + '-' + pad(day); }

    function parseDate(value) {
      var match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value || '');
      if (!match) return null;
      return { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) };
    }

    function labelText(value) {
      var parsed = parseDate(value);
      return parsed ? parsed.y + ' 年 ' + (parsed.m + 1) + ' 月 ' + parsed.d + ' 日' : '选择日期';
    }

    function cellHTML(date, isOut) {
      var value = stamp(date.getFullYear(), date.getMonth(), date.getDate());
      var classes = 'v2-date-cell';
      if (isOut) classes += ' is-out';
      if (value === todayStr) classes += ' is-today';
      if (value === draft) classes += ' is-selected';
      return '<button type="button" class="' + classes + '" data-value="' + value + '"'
        + (value === draft ? ' aria-pressed="true"' : '') + '>' + date.getDate() + '</button>';
    }

    function render() {
      yearSel.value = String(view.y);
      monthSel.value = String(view.m);
      var startIndex = (new Date(view.y, view.m, 1).getDay() + 6) % 7;
      var daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
      var prevDays = new Date(view.y, view.m, 0).getDate();
      var html = '';
      var i;
      for (i = 0; i < startIndex; i++) {
        html += cellHTML(new Date(view.y, view.m - 1, prevDays - startIndex + 1 + i), true);
      }
      for (i = 1; i <= daysInMonth; i++) {
        html += cellHTML(new Date(view.y, view.m, i), false);
      }
      var tail = (7 - ((startIndex + daysInMonth) % 7)) % 7;
      for (i = 0; i < tail; i++) {
        html += cellHTML(new Date(view.y, view.m + 1, i + 1), true);
      }
      grid.innerHTML = html;
    }

    function syncTrigger() {
      var value = hidden.value;
      textEl.textContent = labelText(value);
      textEl.classList.toggle('is-empty', !value);
    }

    function open() {
      var parsed = parseDate(hidden.value);
      if (parsed) { view.y = parsed.y; view.m = parsed.m; draft = hidden.value; }
      else { view.y = today.getFullYear(); view.m = today.getMonth(); draft = ''; }
      render();
      panel.hidden = false;
      var picker = v2Datepicker;
      if (picker) picker.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      if (gsap && !reduced) {
        gsap.killTweensOf(panel);
        // 从触发框底部展开，像 M3 的菜单那样有方向感
        gsap.fromTo(panel,
          { autoAlpha: 0, y: -10, scale: 0.97, transformOrigin: '50% 0%' },
          { autoAlpha: 1, y: 0, scale: 1, duration: 0.32, ease: 'power3.out' });
        var cells = panel.querySelectorAll('.v2-date-cell');
        gsap.fromTo(cells,
          { opacity: 0, scale: 0.86 },
          { opacity: 1, scale: 1, duration: 0.26, stagger: 0.004, delay: 0.06, ease: 'power2.out', clearProps: 'transform' });
      }
      window.requestAnimationFrame(function () {
        if (panel.scrollIntoView) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }

    function close() {
      var picker = v2Datepicker;
      if (picker) picker.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      if (gsap && !reduced) {
        gsap.killTweensOf(panel);
        gsap.to(panel, {
          autoAlpha: 0, y: -8, scale: 0.98, duration: 0.18, ease: 'power2.in',
          onComplete: function () {
            panel.hidden = true;
            gsap.set(panel, { clearProps: 'opacity,visibility,transform' });
          }
        });
      } else {
        panel.hidden = true;
      }
    }

    function commit(value) {
      hidden.value = value;
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
      syncTrigger();
      close();
      trigger.focus({ preventScroll: true });
    }

    trigger.addEventListener('click', function () {
      // 以 is-open 判断，close() 是异步收起的，不能用 panel.hidden
      if (isOpen()) close(); else open();
    });

    grid.addEventListener('click', function (event) {
      var button = event.target.closest('[data-value]');
      if (!button) return;
      draft = button.getAttribute('data-value');
      var parsed = parseDate(draft);
      if (parsed) { view.y = parsed.y; view.m = parsed.m; }
      render();
    });

    yearSel.addEventListener('change', function () { view.y = Number(yearSel.value); render(); });
    monthSel.addEventListener('change', function () { view.m = Number(monthSel.value); render(); });

    $('v2DatePrev').addEventListener('click', function () {
      view.m -= 1;
      if (view.m < 0) { view.m = 11; view.y -= 1; }
      render();
    });
    $('v2DateNext').addEventListener('click', function () {
      view.m += 1;
      if (view.m > 11) { view.m = 0; view.y += 1; }
      render();
    });
    $('v2DateToday').addEventListener('click', function () {
      draft = todayStr;
      view.y = today.getFullYear();
      view.m = today.getMonth();
      render();
    });
    $('v2DateClear').addEventListener('click', function () { commit(''); });
    $('v2DateDone').addEventListener('click', function () { commit(draft); });

    function isOpen() {
      return !!(v2Datepicker && v2Datepicker.classList.contains('is-open'));
    }

    document.addEventListener('click', function (event) {
      if (!isOpen()) return;
      if (event.target.closest && event.target.closest('#v2Datepicker')) return;
      if (draft) commit(draft); else close();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || !isOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.focus({ preventScroll: true });
    }, true);

    hidden.addEventListener('change', syncTrigger);
    syncTrigger();

    return {
      reset: function () { draft = ''; close(); syncTrigger(); },
      refresh: syncTrigger
    };
  }

  /* ------------------------------------------------------------ 事件 */

  function bindEvents() {
    els.form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (state.step === TOTAL - 1) next();
    });

    els.form.addEventListener('input', function (event) {
      if (event.target && event.target.id) clearFieldError(event.target.id);
    });

    els.form.addEventListener('change', function (event) {
      if (!event.target) return;
      if (event.target.name === 'clubType') updateSchool();
      if (event.target.id === 'country') { updateCountry(); clearFieldError('province'); clearFieldError('prefecture'); }
      if (event.target.id === 'province' || event.target.id === 'prefecture') updateOriginReadout();
      if (event.target.id === 'applicantRole') updateRoleReadout();
      if (event.target.id) clearFieldError(event.target.id);
    });

    els.form.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      if (event.target && /^(TEXTAREA|SELECT|BUTTON)$/.test(event.target.tagName)) return;
      event.preventDefault();
      next();
    });

    els.next.addEventListener('click', next);
    els.back.addEventListener('click', back);

    els.review.addEventListener('click', function (event) {
      var button = event.target.closest('[data-goto]');
      if (!button || state.busy || state.done) return;
      returnToReview = true;
      goTo(Number(button.getAttribute('data-goto')), { focus: null });
    });

    document.querySelectorAll('.v2-rail-item').forEach(function (item) {
      item.addEventListener('click', function () {
        var index = Number(item.getAttribute('data-rail'));
        if (index <= state.step) goTo(index);
      });
    });

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || !bootEnded) return;
      if (!state.done) back();
    });

    els.bootSkip.addEventListener('click', function (event) {
      event.stopPropagation();
      endBoot(eventPoint(event), false);
    });

    var enterBtn = $('bootEnter');
    if (enterBtn) {
      enterBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        endBoot(eventPoint(event), false);
      });
    }

    // 跳过只认右上角按钮（及其 ESC 快捷键），页面其他位置不响应
    document.addEventListener('keydown', function (event) {
      if (bootEnded || !bootExitAllowed()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        endBoot(null, false);
      }
    });

    els.restart.addEventListener('click', restart);

    // 系统明暗变化时实时跟随（不需要重新加载页面）
    if (typeof themeQuery.addEventListener === 'function') themeQuery.addEventListener('change', syncSystemTheme);
    else if (typeof themeQuery.addListener === 'function') themeQuery.addListener(syncSystemTheme);

    var motionHandler = function () {
      reduced = reducedQuery.matches;
    };
    if (typeof reducedQuery.addEventListener === 'function') reducedQuery.addEventListener('change', motionHandler);
    else if (typeof reducedQuery.addListener === 'function') reducedQuery.addListener(motionHandler);
  }

  function eventPoint(event) {
    if (!event) return null;
    if (typeof event.clientX === 'number' && (event.clientX || event.clientY)) {
      return { x: event.clientX, y: event.clientY };
    }
    if (event.touches && event.touches[0]) {
      return { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }
    return null;
  }

  function updateClock() {
    var now = new Date();
    var text = ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2);
    if (els.clock) els.clock.textContent = text;
  }

  /* ------------------------------------------------------------ 启动 */

  function cacheDom() {
    els.boot = $('v2Boot');
    els.bootSkip = $('bootSkip');
    els.bootEnter = $('bootEnter');
    els.bootLines = Array.prototype.slice.call(document.querySelectorAll('[data-line]'));
    els.bootRing = $('bootRing');
    els.bootPct = $('bootPct');
    els.bootLoading = $('bootLoading');
    els.veil = $('v2Veil');
    els.hole = $('v2VeilHole');
    els.stage = $('v2Stage');
    els.top = document.querySelector('.v2-top');
    els.rail = document.querySelector('.v2-rail');
    els.column = document.querySelector('.v2-column');
    els.form = $('v2Form');
    els.stepEls = Array.prototype.slice.call(document.querySelectorAll('.v2-step'));
    els.review = $('v2Review');
    els.next = $('v2Next');
    els.back = $('v2Back');
    els.progress = $('v2Progress');
    els.shutter = $('v2Shutter');
    els.live = $('v2Live');
    els.done = $('v2Done');
    els.restart = $('v2Restart');
    els.clock = $('v2Clock');
    els.decoNum = $('v2DecoNum');
    els.decoName = $('v2DecoName');
    els.decoChibi = $('v2DecoImg');
    els.tales = document.querySelector('.v2-tales');
    els.orbitTag = $('v2OrbitTag');
    els.orbitRings = document.querySelectorAll('.v2-orbit-ring');
    els.ruleTicks = document.querySelectorAll('.v2-tales-rule i');
    els.taleEls = Array.prototype.slice.call(document.querySelectorAll('.v2-tale'));
    els.navCount = $('v2NavCount');
    els.clubName = $('clubName');
    els.schoolName = $('schoolName');
    els.schoolGroup = $('schoolGroup');
    els.country = $('country');
    els.province = $('province');
    els.provinceGroup = $('provinceGroup');
    els.prefecture = $('prefecture');
    els.prefectureGroup = $('prefectureGroup');
    els.contact = $('contact');
    els.createdAt = $('createdAt');
    els.remark = $('remark');
    els.submitter = $('submitter');
    els.applicantRole = $('applicantRole');
  }

  function init() {
    cacheDom();
    syncSystemTheme();
    injectMarks();
    renderPrefectures();
    applyDefaults();
    updateRoleReadout();
    bindEvents();
    datePickerApi = initDatePicker();
    updateClock();
    window.setInterval(updateClock, 30000);
    window.__vnfestV2 = true;

    if (!els.form || !els.stepEls.length) return;
    els.stage.inert = true;
    els.boot.inert = production;
    els.stepEls.forEach(function (section, index) { section.inert = index !== 0; });
    syncButtons();

    if (gsap) {
      gsap.set(els.stepEls, { autoAlpha: 0, visibility: 'hidden' });
      gsap.set(els.stepEls[0], { autoAlpha: 1, visibility: 'visible' });
    } else {
      els.stepEls.forEach(function (section, index) {
        section.style.visibility = index === 0 ? 'visible' : 'hidden';
        section.style.opacity = index === 0 ? '1' : '0';
      });
    }
    if (production) {
      var retry = $('v2AuthRetry');
      if (retry) retry.addEventListener('click', checkAuth);
      checkAuth();
    } else beginExperience();
  }

  function beginExperience() {
    if (experienceStarted) return;
    experienceStarted = true;
    if (gsap) initCanvas();
    if (reduced || !gsap) {
      endBoot(null, true);
      return;
    }

    playBoot();
  }

  window.VNFestSubmitV2 = Object.freeze({
    collectPayload: collectPayload,
    bootTimeline: function () { return bootTimeline; },
    goTo: function (index) { goTo(index); },
    state: function () { return { step: state.step, busy: state.busy, done: state.done }; }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
