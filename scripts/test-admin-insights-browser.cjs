const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const projectRoot = path.resolve(__dirname, '..');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnfest-admin-insights-'));
app.setPath('userData', userDataDir);
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.on('window-all-closed', event => event.preventDefault());

const viewports = {
  desktop: { width: 1366, height: 900 },
  mobile: { width: 390, height: 844 },
};

function json(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function parseDate(value, fallback) {
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : fallback;
  return new Date(`${text}T00:00:00Z`);
}

function daysBetween(from, to) {
  const start = parseDate(from, '2026-08-08');
  const end = parseDate(to, '2026-09-06');
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}

function insightPayload(url) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : '2026-08-08';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('to') || '') ? url.searchParams.get('to') : '2026-09-06';
  const length = daysBetween(from, to);
  const trend = Array.from({ length }, (_, index) => {
    const date = new Date(`${from}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index);
    return {
      date: date.toISOString().slice(0, 10),
      incoming: index % 3 === 0 ? 3 : 1,
      processed: index % 2 === 0 ? 2 : 1,
      backlog: 4,
    };
  });
  const byType = [
    { type: 'club', pending: 2, overdue_24h: 1, overdue_72h: 1, oldest_wait_hours: 121, incoming: 5, processed: 4 },
    { type: 'event', pending: 1, overdue_24h: 0, overdue_72h: 0, oldest_wait_hours: 8, incoming: 3, processed: 3 },
    { type: 'publication', pending: 0, overdue_24h: 0, overdue_72h: 0, oldest_wait_hours: null, incoming: 1, processed: 1 },
    { type: 'membership', pending: 3, overdue_24h: 2, overdue_72h: 1, oldest_wait_hours: 190, incoming: 6, processed: 2 },
    { type: 'feedback', pending: 0, overdue_24h: 0, overdue_72h: 0, oldest_wait_hours: null, incoming: 2, processed: 2 },
  ];
  return {
    success: true,
    meta: {
      timezone: 'Asia/Shanghai',
      generated_at: '2026-09-06T12:00:00+08:00',
      range: { from, to },
      sources: {},
      review_time_coverage: { reliable: 8, terminal_records: 10, percentage: 80 },
    },
    queue: { pending: 6, overdue_24h: 3, overdue_72h: 2, oldest_wait_hours: 190, by_type: byType },
    review: {
      processed: 12, approved: 9, rejected: 3, terminal_records: 10,
      pass_rate_pct: 75, median_hours: 18, p90_hours: 49,
      trend, by_type: byType,
    },
    quality: {
      public: {
        average_score: 68.4, evaluated: 292,
        buckets: [{ label: '90-100', count: 34 }, { label: '70-89', count: 106 }, { label: '50-69', count: 89 }, { label: '0-49', count: 63 }],
        missing_dimensions: [{ dimension: 'logo', count: 63 }, { dimension: 'external_links', count: 51 }],
        low_score_clubs: [{ club_id: 7, country: 'china', title: '南风同好会', score: 22, missing: ['logo'], action_url: 'reviews.html?module=clubs&country=china&club_id=7&search=%E5%8D%97%E9%A3%8E%E5%90%8C%E5%A5%BD%E4%BC%9A' }],
      },
      governance: {
        average_score: 61.2, evaluated: 292, unknown_freshness: 12,
        buckets: [{ label: '90-100', count: 80 }, { label: '70-89', count: 102 }, { label: '50-69', count: 70 }, { label: '0-49', count: 40 }],
        issue_counts: [{ issue_code: 'no_representative', count: 21 }, { issue_code: 'overdue_membership', count: 8 }],
      },
    },
    priority_items: [],
  };
}

function issuePayload(url) {
  const all = [
    { severity: 'urgent', type: 'queue', issue_code: 'pending_membership', type_label: '成员绑定', title: '星海同好会', message: '待处理超过 72 小时', age_hours: 190, record_id: 123, country: 'china', action_url: 'reviews.html?module=review&tab=membership&status=pending&id=123' },
    { severity: 'urgent', type: 'governance', issue_code: 'no_representative', type_label: '治理', title: '东京视觉小说社', message: '没有有效负责人或管理员', score: 42, country: 'japan', club_id: 42, action_url: 'reviews.html?module=clubs&country=japan&club_id=42&search=%E6%9D%B1%E4%BA%AC%E8%A7%86%E8%A7%89%E5%B0%8F%E8%AF%B4%E7%A4%BE' },
    { severity: 'warning', type: 'public_quality', issue_code: 'missing_logo', type_label: '公开资料', title: '南风同好会', message: '缺少 Logo', score: 52, country: 'china', club_id: 7, action_url: 'reviews.html?module=clubs&country=china&club_id=7&search=%E5%8D%97%E9%A3%8E%E5%90%8C%E5%A5%BD%E4%BC%9A' },
  ];
  const type = url.searchParams.get('type') || 'all';
  const severity = url.searchParams.get('severity') || 'all';
  const country = url.searchParams.get('country') || 'all';
  const filtered = all.filter(item => (type === 'all' || item.type === type) && (severity === 'all' || item.severity === severity) && (country === 'all' || item.country === country));
  return { success: true, meta: { timezone: 'Asia/Shanghai', generated_at: '2026-09-06T12:00:00+08:00', sources: {} }, issues: filtered, total: filtered.length, page: 1, per_page: 50 };
}

async function startServer() {
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;
    const referer = req.headers.referer || '';
    const isManager = /role=manager|role=representative/.test(referer);
    if (pathname === '/api/auth.php') {
      return json(res, { logged_in: true, user: { id: 1, username: 'fixture-admin', nickname: '测试管理员', role: isManager ? 'manager' : 'super_admin' } });
    }
    if (pathname === '/api/admin_insights.php') {
      if (isManager) return json(res, { success: false, message: '权限不足' }, 403);
      if (/insights_fail=1/.test(referer)) return json(res, { success: false, message: 'fixture unavailable' }, 503);
      if (requestUrl.searchParams.get('action') === 'summary') return json(res, insightPayload(requestUrl));
      if (requestUrl.searchParams.get('action') === 'issues') return json(res, issuePayload(requestUrl));
      return json(res, { success: false, message: '未知操作' }, 400);
    }
    if (pathname === '/api/clubs.php' || pathname === '/api/clubs_japan.php') {
      const japan = pathname.endsWith('_japan.php');
      return json(res, { success: true, data: japan ? [{ id: 42, name: '东京视觉小说社', display_name: '东京视觉小说社', school: '东京大学' }] : [{ id: 7, name: '南风同好会', display_name: '南风同好会', school: '南方大学' }] });
    }
    if (pathname === '/api/submit.php' || pathname === '/api/submit_event.php' || pathname === '/api/submit_publication.php' || pathname === '/api/feedback.php') return json(res, []);
    if (pathname === '/api/membership.php') return json(res, { success: true, memberships: [] });
    if (pathname.startsWith('/api/')) return json(res, { success: true, data: [], submissions: [], memberships: [], feedback: [], total: 0 });
    const relativePath = pathname.replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(projectRoot, relativePath);
    if (!filePath.startsWith(projectRoot + path.sep) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitFor(win, expression, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    } catch (error) {
      throw new Error(`${message}: renderer expression failed (${error.message})`);
    }
    await wait(100);
  }
  throw new Error(message);
}

async function testSuperAdminViewport(baseUrl, name, size) {
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: size.width,
    height: size.height,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const consoleErrors = [];
  try {
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2 && !message.includes('Electron Security Warning')) consoleErrors.push(message);
    });
    await win.loadURL(`${baseUrl}/admin/reviews.html?module=insights&role=super_admin`);
    await waitFor(win, `currentModule === 'insights' && insightsData && insightsData.queue.pending === 6 && document.getElementById('insightIssuesBody').innerText.includes('星海同好会')`, `${name}: insights did not load fixture data`);
    const initial = await win.webContents.executeJavaScript(`(() => {
      const overflowers = Array.from(document.querySelectorAll('body *')).map(el => { const rect = el.getBoundingClientRect(); return { id: el.id, right: Math.round(rect.right), width: Math.round(rect.width) }; }).filter(item => item.right > innerWidth + 1).slice(0, 12);
      return {
        nav: getComputedStyle(document.getElementById('insightsNav')).display,
        pending: document.getElementById('insightKpiPending').textContent,
        processed: document.getElementById('insightKpiProcessed').textContent,
        median: document.getElementById('insightKpiMedian').textContent,
      queueRows: document.querySelectorAll('#insightQueueBody tr').length,
      reviewByTypeRows: document.querySelectorAll('#insightReviewByTypeBody tr').length,
      issueText: document.getElementById('insightIssuesBody').innerText,
      lowListText: document.getElementById('insightPublicLowList').innerText,
        chartPoints: document.querySelectorAll('#insightReviewChart circle').length,
        quality: document.getElementById('insightPublicAverage').textContent,
        documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        viewportWidth: innerWidth,
        overflowers
      };
    })()`);
    assert.equal(initial.nav, 'flex', `${name}: super admin should see insights nav`);
    assert.equal(initial.pending, '6', `${name}: pending KPI should render`);
    assert.equal(initial.processed, '12', `${name}: processed KPI should render`);
    assert.equal(initial.median, '18 小时', `${name}: median KPI should render`);
    assert.equal(initial.queueRows, 5, `${name}: five queue categories should render`);
    assert.equal(initial.reviewByTypeRows, 5, `${name}: per-type review metrics should render`);
    assert.match(initial.issueText, /星海同好会/);
    assert.match(initial.lowListText, /南风同好会/);
    assert.ok(initial.chartPoints > 0, `${name}: compact review chart should render real fixture points`);
    assert.equal(initial.quality, '68.4', `${name}: public quality score should render`);
    assert.ok(initial.documentWidth <= initial.viewportWidth, `${name}: page must not overflow (${initial.documentWidth} > ${initial.viewportWidth}): ${JSON.stringify(initial.overflowers)}`);

    await win.webContents.executeJavaScript('insightsSetPreset(7)');
    await waitFor(win, `insightsData && insightsData.meta.range.from === '2026-08-31' && insightsData.meta.range.to === '2026-09-06'`, `${name}: 7-day preset did not reload insights`);
    await win.webContents.executeJavaScript(`(() => { document.getElementById('insightsFrom').value = '2026-09-01'; document.getElementById('insightsTo').value = '2026-09-03'; insightsSetCustomRange(); })()`);
    await waitFor(win, `insightsData && insightsData.meta.range.from === '2026-09-01' && insightsData.meta.range.to === '2026-09-03'`, `${name}: custom range did not reload insights`);
    const filtered = await win.webContents.executeJavaScript(`({ trend: insightsData.review.trend.length, label: document.getElementById('insightsRangeLabel').textContent, issuePage: document.getElementById('insightIssuePageInfo').textContent })`);
    assert.equal(filtered.trend, 3, `${name}: review trend should follow selected date range`);
    assert.match(filtered.label, /2026-09-01.*2026-09-03/);
    assert.match(filtered.issuePage, /共 3 条/);

    await win.webContents.executeJavaScript(`insightsNavigate('reviews.html?module=review&tab=club&status=pending&id=7')`);
    await waitFor(win, `currentModule === 'review'`, `${name}: issue action should navigate to review center`);
    await win.webContents.executeJavaScript(`history.pushState({}, '', 'reviews.html?module=insights'); applyAdminDeepLink()`);
    await waitFor(win, `currentModule === 'insights'`, `${name}: deep-link should restore insights module`);
    if (name === 'mobile') {
      const controls = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#module-insights button, #module-insights input, #module-insights select')).filter(el => getComputedStyle(el).display !== 'none').map(el => ({ id: el.id, height: Math.round(el.getBoundingClientRect().height) }))`);
      assert.ok(controls.filter(item => item.id !== '').every(item => item.height >= 44), `${name}: insight controls must be at least 44px high: ${JSON.stringify(controls)}`);
    }
    assert.equal(consoleErrors.length, 0, `${name}: console errors: ${consoleErrors.join(' | ')}`);
    return { initial, filtered };
  } finally {
    win.destroy();
  }
}

async function testManagerAccess(baseUrl) {
  const win = new BrowserWindow({ show: false, useContentSize: true, width: 390, height: 844, webPreferences: { contextIsolation: true, sandbox: true } });
  try {
    await win.loadURL(`${baseUrl}/admin/reviews.html?module=insights&role=manager`);
    await waitFor(win, `Boolean(currentUser)`, 'manager fixture did not authenticate');
    const result = await win.webContents.executeJavaScript(`(async () => ({ display: getComputedStyle(document.getElementById('insightsNav')).display, module: currentModule, status: await fetch('../api/admin_insights.php?action=summary', { credentials: 'same-origin' }).then(r => r.status) }))()`);
    assert.equal(result.display, 'none', 'manager should not see insights nav');
    assert.equal(result.module, 'dashboard', 'manager deep link should fall back to dashboard');
    assert.equal(result.status, 403, 'manager direct insights request should be forbidden');
  } finally {
    win.destroy();
  }
}

async function testFailureState(baseUrl) {
  const win = new BrowserWindow({ show: false, useContentSize: true, width: 390, height: 844, webPreferences: { contextIsolation: true, sandbox: true } });
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) consoleErrors.push(message);
  });
  try {
    await win.loadURL(`${baseUrl}/admin/reviews.html?module=insights&role=super_admin&insights_fail=1`);
    await waitFor(win, `document.getElementById('insightsNotice').innerText.includes('加载失败')`, 'insights failure state did not render');
    assert.equal(consoleErrors.length, 0, `failure state should not produce console errors: ${consoleErrors.join(' | ')}`);
  } finally {
    win.destroy();
  }
}

app.whenReady().then(async () => {
  const server = await startServer();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let exitCode = 0;
  try {
    for (const [name, size] of Object.entries(viewports)) {
      const result = await testSuperAdminViewport(baseUrl, name, size);
      console.log(`OK ${name}: ${result.initial.pending} pending, ${result.initial.quality} public score, ${result.filtered.trend} trend days`);
    }
    await testManagerAccess(baseUrl);
    console.log('OK manager: insights nav hidden, deep link fallback and direct API forbidden');
    await testFailureState(baseUrl);
    console.log('OK failure state: explainable error rendered without unhandled renderer errors');
  } catch (error) {
    exitCode = 1;
    console.error(error.stack || error.message);
  } finally {
    await new Promise(resolve => server.close(resolve));
    app.exit(exitCode);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* Electron may still hold cache files on Windows. */ }
  }
});
