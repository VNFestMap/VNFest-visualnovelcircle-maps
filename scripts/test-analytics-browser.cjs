const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const projectRoot = path.resolve(__dirname, '..');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnfest-analytics-'));
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
let analyticsRequests = 0;

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

function daysBetween(from, to) {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  return Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) ? 30 : Math.max(1, Math.round((end - start) / 86400000) + 1);
}

function analyticsPayload(url) {
  const from = url.searchParams.get('from') || '2026-08-07';
  const to = url.searchParams.get('to') || '2026-09-05';
  const length = daysBetween(from, to);
  const trend = Array.from({ length }, (_, index) => ({
    date: index === length - 1 ? to : from,
    uv: index === length - 1 ? 4 : 0,
    pv: index === length - 1 ? 7 : 0,
    authenticated_pv: index === length - 1 ? 2 : 0,
    anonymous_pv: index === length - 1 ? 5 : 0,
  }));
  return {
    success: true,
    meta: { timezone: 'Asia/Shanghai', tracking_started_at: '2026-09-05', range: { from, to } },
    periods: {
      lifetime: { uv: 42, pv: 108 },
      today: { uv: 4, pv: 7, uv_delta_pct: 33.3, pv_delta_pct: 40 },
      week: { uv: 12, pv: 28, uv_delta_pct: null, pv_delta_pct: null },
      month: { uv: 25, pv: 65, uv_delta_pct: -5, pv_delta_pct: 2.5 },
    },
    selected: { from, to, uv: 4, pv: 7, authenticated_pv: 2, anonymous_pv: 5 },
    trend,
    breakdowns: {
      pages: [{ page_path: '/index.html', page_title: '全国Galgame同好会地图', uv: 4, pv: 7 }],
      sources: [{ source_category: 'direct', referrer_host: '', uv: 3, pv: 5 }, { source_category: 'search', referrer_host: 'www.google.com', uv: 1, pv: 2 }],
      devices: [{ device_type: 'desktop', uv: 3, pv: 5 }, { device_type: 'mobile', uv: 1, pv: 2 }],
      browsers: [{ browser_name: 'chrome', uv: 4, pv: 7 }],
      auth: { authenticated_pv: 2, anonymous_pv: 5 },
    },
  };
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
    if (pathname === '/api/analytics.php') {
      analyticsRequests += 1;
      if (/analytics_fail=1/.test(referer) && requestUrl.searchParams.get('action') === 'summary') return json(res, { success: false, message: 'fixture unavailable' }, 503);
      if (isManager && requestUrl.searchParams.get('action') !== 'track') return json(res, { success: false, message: '权限不足' }, 403);
      if (requestUrl.searchParams.get('action') === 'summary') return json(res, analyticsPayload(requestUrl));
      if (requestUrl.searchParams.get('action') === 'export') {
        res.writeHead(200, { 'Content-Type': requestUrl.searchParams.get('format') === 'csv' ? 'text/csv' : 'application/json', 'Content-Disposition': 'attachment; filename="analytics.fixture"' });
        return res.end(requestUrl.searchParams.get('format') === 'csv' ? 'date,uv,pv\n2026-09-05,4,7\n' : JSON.stringify({ success: true, rows: [{ date: '2026-09-05', uv: 4, pv: 7 }] }));
      }
      return json(res, { success: true }, 204);
    }
    if (pathname === '/api/clubs.php' || pathname === '/api/clubs_japan.php') return json(res, { success: true, data: [] });
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
  for (let attempt = 0; attempt < 80; attempt += 1) {
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
  let downloadCount = 0;
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) consoleErrors.push(message);
  });
  win.webContents.session.on('will-download', (_event, item) => { downloadCount += 1; item.cancel(); });
  try {
    console.log(`START ${name}: load admin`);
    await win.loadURL(`${baseUrl}/admin/reviews.html?role=super_admin`);
    console.log(`START ${name}: authenticated`);
    await waitFor(win, `typeof switchModule === 'function' && Boolean(currentUser)`, `${name}: admin page did not authenticate`);
    console.log(`START ${name}: switch analytics`);
    await win.webContents.executeJavaScript('switchModule("analytics")');
    console.log(`START ${name}: wait analytics`);
    await waitFor(win, `analyticsData && analyticsData.periods.lifetime.uv === 42`, `${name}: analytics data did not render`);
    const initial = await win.webContents.executeJavaScript(`(() => ({
      nav: getComputedStyle(document.getElementById('analyticsNav')).display,
      lifetime: document.getElementById('analyticsLifetimeUv').textContent,
      todayPv: document.getElementById('analyticsTodayPv').textContent,
      trendPoints: document.querySelectorAll('#analyticsTrendChart circle').length,
      pageText: document.getElementById('analyticsPagesBody').innerText,
      sourceText: document.getElementById('analyticsSourcesBody').innerText,
      documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      viewportWidth: innerWidth,
      overflowers: Array.from(document.querySelectorAll('body *')).map(el => { const rect = el.getBoundingClientRect(); return { id: el.id, right: Math.round(rect.right), width: Math.round(rect.width) }; }).filter(item => item.right > innerWidth + 1).slice(0, 10)
    }))()`);
    assert.equal(initial.nav, 'flex', `${name}: super admin should see analytics nav`);
    assert.equal(initial.lifetime, '42', `${name}: lifetime UV should render`);
    assert.equal(initial.todayPv, 'PV 7', `${name}: today PV should render`);
    assert.ok(initial.trendPoints > 0, `${name}: trend should render real fixture points`);
    assert.match(initial.pageText, /全国Galgame同好会地图/);
    assert.match(initial.sourceText, /www\.google\.com/);
    assert.ok(initial.documentWidth <= initial.viewportWidth, `${name}: page must not overflow (${initial.documentWidth} > ${initial.viewportWidth}): ${JSON.stringify(initial.overflowers)}`);

    await win.webContents.executeJavaScript('analyticsSetPreset(7)');
    await waitFor(win, 'analyticsData && analyticsData.trend.length === 7', `${name}: 7-day preset did not reload analytics`);
    await win.webContents.executeJavaScript('analyticsSetPreset(90)');
    await waitFor(win, 'analyticsData && analyticsData.trend.length === 90', `${name}: 90-day preset did not reload analytics`);
    await win.webContents.executeJavaScript(`(() => { document.getElementById('analyticsFrom').value = '2026-09-01'; document.getElementById('analyticsTo').value = '2026-09-03'; analyticsSetCustomRange(); })()`);
    await waitFor(win, `analyticsData && analyticsData.meta.range.from === '2026-09-01' && analyticsData.meta.range.to === '2026-09-03'`, `${name}: custom range did not reload analytics`);
    const filtered = await win.webContents.executeJavaScript(`({ trend: analyticsData.trend.length, range: document.getElementById('analyticsRangeLabel').textContent, page: document.getElementById('analyticsPagesBody').innerText })`);
    assert.equal(filtered.trend, 3, `${name}: trend should follow selected date range`);
    assert.match(filtered.range, /2026-09-01.*2026-09-03/);
    assert.match(filtered.page, /全国Galgame同好会地图/);

    await win.webContents.executeJavaScript('exportAnalytics("trend", "csv")');
    for (let attempt = 0; attempt < 40 && downloadCount === 0; attempt += 1) await wait(100);
    assert.ok(downloadCount > 0, `${name}: export did not start a download`);
    if (name === 'mobile') {
      const controls = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#module-analytics .btn, #module-analytics .chip, #module-analytics .log-filter')).map(el => Math.round(el.getBoundingClientRect().height))`);
      assert.ok(controls.every(height => height >= 44), `${name}: analytics controls must be at least 44px high: ${controls.join(',')}`);
    }
    assert.equal(consoleErrors.length, 0, `${name}: console errors: ${consoleErrors.join(' | ')}`);
    return { name, initial, filtered, downloadCount };
  } finally {
    win.destroy();
  }
}

async function testManagerAccess(baseUrl) {
  const win = new BrowserWindow({ show: false, useContentSize: true, width: 390, height: 844, webPreferences: { contextIsolation: true, sandbox: true } });
  try {
    await win.loadURL(`${baseUrl}/admin/reviews.html?role=manager`);
    await waitFor(win, 'Boolean(currentUser)', 'manager fixture did not authenticate');
    const result = await win.webContents.executeJavaScript(`(async () => ({ display: getComputedStyle(document.getElementById('analyticsNav')).display, status: await fetch('../api/analytics.php?action=summary', { credentials: 'same-origin' }).then(r => r.status) }))()`);
    assert.equal(result.display, 'none', 'manager should not see analytics nav');
    assert.equal(result.status, 403, 'manager direct analytics request should be forbidden');
    await win.webContents.executeJavaScript('switchModule("analytics")');
    const activeModule = await win.webContents.executeJavaScript('currentModule');
    assert.equal(activeModule, 'dashboard', 'manager should not activate analytics from the page');
  } finally {
    win.destroy();
  }
}

async function testAnalyticsFailure(baseUrl) {
  const win = new BrowserWindow({ show: false, useContentSize: true, width: 390, height: 844, webPreferences: { contextIsolation: true, sandbox: true } });
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) consoleErrors.push(message);
  });
  try {
    await win.loadURL(`${baseUrl}/admin/reviews.html?role=super_admin&analytics_fail=1`);
    await waitFor(win, 'Boolean(currentUser)', 'failure fixture did not authenticate');
    await win.webContents.executeJavaScript('switchModule("analytics")');
    await waitFor(win, `document.getElementById('analyticsTrendChart').innerText.includes('加载失败')`, 'analytics failure state did not render');
    assert.equal(consoleErrors.length, 0, `failure state should not produce console errors: ${consoleErrors.join(' | ')}`);
    console.log('OK failure state: explainable error rendered without unhandled renderer errors');
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
      console.log(`OK ${name}: ${result.initial.lifetime} lifetime UV, ${result.filtered.trend} selected trend days, export=${result.downloadCount}`);
    }
    await testManagerAccess(baseUrl);
    console.log(`OK manager: nav hidden and direct API forbidden; analytics requests=${analyticsRequests}`);
    await testAnalyticsFailure(baseUrl);
  } catch (error) {
    exitCode = 1;
    console.error(error.stack || error.message);
  } finally {
    await new Promise(resolve => server.close(resolve));
    app.exit(exitCode);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* Electron may still hold cache files on Windows. */ }
  }
});
