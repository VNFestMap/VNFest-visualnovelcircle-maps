const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const projectRoot = path.resolve(__dirname, '..');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnfest-admin-logs-'));
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

const primaryLogs = [
  {
    id: 53, user_id: 7, username: 'security-admin', nickname: '安全管理员', current_role: 'super_admin',
    action: 'user.reset_password', target_type: 'user', target_id: 42,
    details: JSON.stringify({ email: 'member@example.test', _context: { method: 'POST', path: '/api/auth.php', user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0', actor_role: 'super_admin' } }),
    ip_address: '203.0.113.7', created_at: '2026-08-31 15:30:00',
  },
  {
    id: 52, user_id: 8, username: 'reviewer', nickname: '审核员', current_role: 'manager',
    action: 'galonly.vote', target_type: 'galonly_application', target_id: 118,
    details: JSON.stringify({ phase: 2, vote: 'approve', _context: { method: 'POST', path: '/api/galonly.php', user_agent: 'Mozilla/5.0 (Linux; Android 15) Chrome/128.0.0.0', actor_role: 'manager' } }),
    ip_address: '198.51.100.8', created_at: '2026-08-31 15:20:00',
  },
  {
    id: 51, user_id: null, username: null, nickname: null, current_role: null,
    action: 'recog_credentials_expired', target_type: 'recognition_credential', target_id: null,
    details: JSON.stringify({ count: 4 }), ip_address: '127.0.0.1', created_at: '2026-08-31 15:10:00',
  },
];

const fillerLogs = Array.from({ length: 50 }, (_, index) => ({
  id: 50 - index, user_id: 20 + (index % 3), username: `member-${index % 3}`, nickname: '', current_role: 'member',
  action: 'user.login', target_type: 'user', target_id: 20 + (index % 3),
  details: JSON.stringify({ provider: 'local', _context: { method: 'POST', path: '/api/auth.php', user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0', actor_role: 'member' } }),
  ip_address: `192.0.2.${20 + (index % 3)}`, created_at: `2026-08-30 12:${String(49 - index).padStart(2, '0')}:00`,
}));
const allLogs = primaryLogs.concat(fillerLogs);

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
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.ico')) return 'image/x-icon';
  return 'application/octet-stream';
}

function logCategory(action) {
  if (/^user\.(register|login|logout|send_|reset_password|change_password|bind_|unbind_)/.test(action)) return 'auth';
  if (/^(galonly|galonly_staff|review)[._]/.test(action)) return 'review';
  if (/^recog[._]/.test(action)) return 'recognition';
  return 'system';
}

async function startServer() {
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;
    if (pathname === '/api/auth.php') {
      return json(res, { logged_in: true, user: { id: 1, username: 'fixture-admin', nickname: '测试管理员', role: 'super_admin' } });
    }
    if (pathname === '/api/admin_logs.php') {
      const type = requestUrl.searchParams.get('type') || 'all';
      const search = (requestUrl.searchParams.get('search') || '').toLowerCase();
      const page = Math.max(1, Number(requestUrl.searchParams.get('page') || 1));
      const perPage = Math.max(1, Number(requestUrl.searchParams.get('per_page') || 50));
      const filtered = allLogs.filter(log => {
        if (type !== 'all' && logCategory(log.action) !== type) return false;
        const haystack = [log.action, log.target_type, log.target_id, log.user_id, log.ip_address, log.username, log.nickname, log.details].join(' ').toLowerCase();
        return !search || haystack.includes(search);
      });
      const logs = filtered.slice((page - 1) * perPage, page * perPage).map(log => {
        const detailsDecoded = JSON.parse(log.details);
        return { ...log, details_decoded: detailsDecoded, request_context: detailsDecoded._context || null };
      });
      return json(res, { success: true, logs, total: filtered.length, page, per_page: perPage });
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

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(win, expression, message) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await wait(100);
  }
  throw new Error(message);
}

async function testViewport(baseUrl, name, size) {
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: size.width,
    height: size.height,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) consoleErrors.push(message);
  });

  try {
    await win.loadURL(`${baseUrl}/admin/reviews.html?log_fixture=1`);
    await waitFor(win, `typeof switchModule === 'function' && Boolean(currentUser)`, 'admin page did not authenticate');
    await win.webContents.executeJavaScript(`switchModule('logs')`);
    await waitFor(win, `currentLogs.length === 50`, 'first log page did not render');

    const firstPage = await win.webContents.executeJavaScript(`(() => ({
      rows: document.querySelectorAll('#logsTableBody tr').length,
      total: document.getElementById('logTotalCount').textContent,
      page: document.getElementById('logPageInfo').textContent,
      nextDisabled: document.getElementById('logNextPage').disabled,
      documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      viewportWidth: innerWidth,
      overflowers: Array.from(document.querySelectorAll('body *')).map(el => {
        const rect = el.getBoundingClientRect();
        return { tag: el.tagName, id: el.id, className: String(el.className || '').slice(0, 80), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
      }).filter(item => item.right > innerWidth + 1).slice(0, 12)
    }))()`);
    assert.equal(firstPage.rows, 50, `${name}: first page should contain 50 logs`);
    assert.match(firstPage.total, /53/, `${name}: total count should be visible`);
    assert.equal(firstPage.nextDisabled, false, `${name}: next page should be enabled`);
    assert.ok(firstPage.documentWidth <= firstPage.viewportWidth, `${name}: document must not overflow horizontally (${firstPage.documentWidth}px > ${firstPage.viewportWidth}px): ${JSON.stringify(firstPage.overflowers)}`);

    await win.webContents.executeJavaScript(`document.getElementById('logSearch').value = 'reset_password'; filterLogs()`);
    await waitFor(win, `currentLogs.length === 1 && currentLogs[0].action === 'user.reset_password'`, 'search did not isolate the password reset log');
    const searchResult = await win.webContents.executeJavaScript(`(() => ({
      high: document.getElementById('logHighRiskCount').textContent,
      context: document.getElementById('logContextCount').textContent,
      tableText: document.getElementById('logsTableBody').innerText,
      detailHeight: Math.round(document.querySelector('.log-detail-button').getBoundingClientRect().height)
    }))()`);
    assert.equal(searchResult.high, '1', `${name}: password reset should be detected as high impact`);
    assert.equal(searchResult.context, '1', `${name}: request context should be detected`);
    assert.match(searchResult.tableText, /重置账号密码/, `${name}: explanation label should be shown`);
    assert.match(searchResult.tableText, /Windows · Chrome/, `${name}: client should be detected from User-Agent`);
    if (name === 'mobile') assert.ok(searchResult.detailHeight >= 44, 'mobile: detail control must be at least 44px high');

    await win.webContents.executeJavaScript(`showLogDetail(currentLogs[0].id)`);
    const modal = await win.webContents.executeJavaScript(`(() => ({
      visible: getComputedStyle(document.getElementById('infoModal')).display !== 'none',
      text: document.getElementById('infoModalBody').innerText,
      copyAvailable: Boolean(document.getElementById('infoModalFooter').dataset.copy)
    }))()`);
    assert.equal(modal.visible, true, `${name}: detail modal should open`);
    assert.match(modal.text, /原密码将不再可用/, `${name}: detail modal should explain impact`);
    assert.match(modal.text, /POST \/api\/auth\.php/, `${name}: request method and safe path should be shown`);
    assert.equal(modal.copyAvailable, true, `${name}: detail should support copying`);

    await win.webContents.executeJavaScript(`closeInfoModal(); resetLogFilters()`);
    await waitFor(win, `currentLogs.length === 50`, 'reset did not restore the full result set');
    await win.webContents.executeJavaScript(`changeLogPage(1)`);
    await waitFor(win, `logPage === 2 && currentLogs.length === 3`, 'second log page did not render');
    const secondPage = await win.webContents.executeJavaScript(`({ rows: document.querySelectorAll('#logsTableBody tr').length, page: document.getElementById('logPageInfo').textContent })`);
    assert.equal(secondPage.rows, 3, `${name}: second page should contain the remaining logs`);
    assert.match(secondPage.page, /第 2 \/ 2 页/, `${name}: pagination status should update`);
    assert.equal(consoleErrors.length, 0, `${name}: console errors: ${consoleErrors.join(' | ')}`);

    return { name, firstPage, searchResult, secondPage };
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
      const result = await testViewport(baseUrl, name, size);
      console.log(`OK ${name}: ${result.firstPage.total}, ${result.firstPage.page}; search high=${result.searchResult.high}; ${result.secondPage.page}`);
    }
  } catch (error) {
    exitCode = 1;
    console.error(error.stack || error.message);
  } finally {
    await new Promise(resolve => server.close(resolve));
    app.exit(exitCode);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* Electron may still hold cache files on Windows. */ }
  }
});
