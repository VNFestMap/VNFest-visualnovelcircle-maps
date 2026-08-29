/* ===========================================================================
   VNFest WIKI · 每日日报逻辑（读者页 + 往期查询页共用）
   数据来源：./data/reports.json（由 Notion 抓取生成，reports 按日期倒序）
   页面通过 <body data-daily-mode="reader|archive"> 选择行为。
   =========================================================================== */
(function () {
  'use strict';

  var DATA_URL = './data/reports.json';
  var mode = document.body.getAttribute('data-daily-mode') || 'reader';
  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  var state = { reports: [], source: {}, updated: '' };

  /* ----------------------------- 工具函数 ----------------------------- */
  function esc(value) {
    var d = document.createElement('div');
    d.textContent = value == null ? '' : String(value);
    return d.innerHTML;
  }
  function byId(id) { return document.getElementById(id); }
  function dotDate(s) { return String(s).replaceAll('-', '.'); }
  function weekdayCn(s) {
    var d = new Date(String(s) + 'T00:00:00');
    return isNaN(d) ? '' : WEEKDAYS[d.getDay()];
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch (e) { return ''; }
  }
  function splitMeta(meta) {
    meta = String(meta || '');
    var i = meta.indexOf('｜');
    if (i === -1) return { date: '', rest: meta };
    return { date: meta.slice(0, i).trim(), rest: meta.slice(i + 1).trim() };
  }
  function sortedReports() {
    return state.reports.slice().sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    });
  }
  function findReport(date) {
    for (var i = 0; i < state.reports.length; i++) {
      if (state.reports[i].date === date) return state.reports[i];
    }
    return null;
  }

  /* ------------------------------ 单条情报 ----------------------------- */
  function renderItem(item, index) {
    var m = splitMeta(item.meta);
    var src = item.url
      ? '<a class="vn-daily-src" href="' + esc(item.url) + '" target="_blank" rel="noreferrer">' +
        esc(domainOf(item.url)) + '</a>'
      : '';
    return (
      '<article class="vn-daily-item" data-search="' +
      esc([item.title, item.summary, item.meta].join(' ').toLowerCase()) + '">' +
      '<h3><span class="vn-daily-index">' + pad(index + 1) + '</span>' +
      '<span>' + esc(item.title) + '</span></h3>' +
      '<p class="vn-daily-summary">' + esc(item.summary) + '</p>' +
      (item.meta || src
        ? '<div class="vn-daily-meta">' +
          (m.date ? '<span class="vn-daily-date">' + esc(m.date) + '</span>' : '') +
          (m.rest ? '<span>' + esc(m.rest) + '</span>' : '') + src + '</div>'
        : '') +
      '</article>'
    );
  }

  /* ------------------------------- 读者页 ------------------------------ */
  function initReader() {
    var requested = new URLSearchParams(location.search).get('date') || '';
    var reports = sortedReports();
    var latest = reports[0];
    var report = requested ? findReport(requested) : latest;
    var current = report ? report.date : (requested || '');
    var dates = reports.map(function (r) { return r.date; }); // 倒序
    var idx = dates.indexOf(current);
    var older = idx >= 0 && idx < dates.length - 1 ? dates[idx + 1] : '';
    var newer = idx > 0 ? dates[idx - 1] : '';
    var total = dates.length;

    // 期号导航
    var nav = byId('digestNav');
    if (nav) {
      var links = '';
      links += older
        ? '<a class="wiki-button" href="./index.html?date=' + esc(older) + '">← 上一期 · ' + esc(dotDate(older)) + '</a>'
        : '<span class="wiki-button" aria-disabled="true" style="opacity:.5">← 已无更早</span>';
      links += '<a class="wiki-button" href="./archive.html">查看往期</a>';
      if (latest && current !== latest.date) {
        links += '<a class="wiki-button primary" href="./index.html">回到最新 · ' + esc(dotDate(latest.date)) + '</a>';
      } else if (latest && current === latest.date) {
        links += '<span class="wiki-button primary" style="opacity:.85">最新一期</span>';
      }
      links += newer
        ? '<a class="wiki-button" href="./index.html?date=' + esc(newer) + '">' + esc(dotDate(newer)) + ' · 更新 →</a>'
        : '<span class="wiki-button" aria-disabled="true" style="opacity:.5">已无更新 →</span>';
      nav.innerHTML =
        '<span class="vn-daily-nav-date">全 ' + total + ' 期 · 当前 ' + (current ? dotDate(current) : '—') + '</span>' +
        '<span class="vn-daily-nav-links">' + links + '</span>';
    }

    // 标题区
    if (byId('digestDate')) byId('digestDate').textContent = current ? dotDate(current) : '—';
    if (byId('digestSub')) {
      byId('digestSub').textContent = report
        ? weekdayCn(current) + ' · 行业新闻，每天 3 分钟 · 共 ' + report.items.length + ' 条'
        : '本期暂无内容';
    }

    // 侧栏统计
    if (byId('statReportCount')) byId('statReportCount').textContent = total;
    if (byId('statItemCount')) {
      byId('statItemCount').textContent = state.reports.reduce(function (n, r) { return n + r.items.length; }, 0);
    }

    // 来源说明
    if (byId('sourceName')) byId('sourceName').textContent = state.source.name || 'Notion 信息台';
    var srcLink = byId('sourceLink');
    if (srcLink) { srcLink.href = state.source.url || '#'; srcLink.textContent = state.source.name || 'Notion 信息台'; }
    if (byId('sourceUpdated')) byId('sourceUpdated').textContent = state.updated || current || '';

    // 列表
    var list = byId('digestList');
    var status = byId('digestStatus');
    function paint(items) {
      if (!report) {
        list.innerHTML = '<p class="vn-archive-empty">' +
          (requested ? '未找到 ' + esc(dotDate(requested)) + ' 的日报。' : '暂无日报数据。') +
          ' <a class="vn-daily-src" href="./archive.html">查看往期列表</a></p>';
        if (status) status.textContent = '0 条';
        return;
      }
      if (!items.length) {
        list.innerHTML = '<p class="vn-archive-empty">没有匹配的情报，试试其他关键词。</p>';
      } else {
        list.innerHTML = items.map(renderItem).join('');
      }
      if (status) status.textContent = items.length + ' 条';
    }
    paint(report ? report.items : []);

    var search = byId('digestSearch');
    if (search) {
      search.addEventListener('input', function () {
        var kw = search.value.trim().toLowerCase();
        if (!report) return;
        paint(!kw ? report.items : report.items.filter(function (it) {
          return [it.title, it.summary, it.meta].join(' ').toLowerCase().indexOf(kw) !== -1;
        }));
      });
    }
  }

  /* ----------------------------- 往期查询页 ---------------------------- */
  function initArchive() {
    var list = byId('archiveList');
    var status = byId('archiveStatus');
    var search = byId('archiveSearch');

    if (byId('statArchiveCount')) byId('statArchiveCount').textContent = state.reports.length;

    function headlineOf(r) { return r.items.length ? r.items[0].title : '（本期暂无内容）'; }
    function summaryOf(r) { return r.items.length ? r.items[0].summary : ''; }
    function tagsOf(r) {
      var cats = [];
      r.items.forEach(function (it) {
        var m = splitMeta(it.meta);
        var brand = (m.rest || '').split('（')[0].split('／')[0].split('/')[0].trim();
        if (brand && cats.indexOf(brand) === -1) cats.push(brand);
      });
      return cats.slice(0, 6);
    }

    function paint(items) {
      status.textContent = items.length + ' 期';
      if (!items.length) {
        list.innerHTML = '<p class="vn-archive-empty">没有匹配的往期日报。</p>';
        return;
      }
      list.innerHTML = items.map(function (r) {
        var tags = tagsOf(r).map(function (t) {
          return '<span class="vn-archive-tag">' + esc(t) + '</span>';
        }).join('');
        return '<a class="vn-archive-card" href="./index.html?date=' + esc(r.date) + '">' +
          '<div class="vn-archive-date">' + esc(dotDate(r.date)) +
          '<span class="vn-archive-week">' + esc(weekdayCn(r.date)) + ' · ' + esc(r.items.length) + ' 条</span></div>' +
          '<div><h3>' + esc(headlineOf(r)) + '</h3><p>' + esc(summaryOf(r)) + '</p>' +
          '<div class="vn-archive-tags">' + tags + '</div></div></a>';
      }).join('');
    }

    function all() { return sortedReports(); }
    paint(all());

    if (search) {
      search.addEventListener('input', function () {
        var kw = search.value.trim().toLowerCase();
        if (!kw) return paint(all());
        paint(all().filter(function (r) {
          var hay = [r.date, dotDate(r.date)].concat(
            r.items.map(function (it) { return [it.title, it.summary, it.meta].join(' '); })
          ).join(' ').toLowerCase();
          return hay.indexOf(kw) !== -1;
        }));
      });
    }
  }

  /* ------------------------------- 引导 -------------------------------- */
  function renderAll() {
    if (mode === 'archive') initArchive();
    else initReader();
  }

  fetch(DATA_URL, { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (json) {
      state.reports = (json && json.reports) || [];
      state.source = (json && json.source) || {};
      state.updated = (json && json.updated) || '';
      renderAll();
    })
    .catch(function (err) {
      var box = byId(mode === 'archive' ? 'archiveList' : 'digestList');
      if (box) {
        box.innerHTML = '<p class="vn-archive-empty">日报数据加载失败：' + esc(err.message) +
          '。请通过 HTTP 访问本页面（file:// 会拦截 JSON 读取）。</p>';
      }
    });
})();
