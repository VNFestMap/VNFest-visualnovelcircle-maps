const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const projectRoot = path.resolve(__dirname, '..');

if (app?.on) app.on('window-all-closed', (event) => event.preventDefault());

function json(response, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function startFixtureServer() {
  let activeMode = 'visitor';
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (requestUrl.pathname === '/user.html') {
      activeMode = requestUrl.searchParams.get('fixture') === 'member' ? 'member' : 'visitor';
    }
    const mode = requestUrl.searchParams.get('fixture') === 'member' ? 'member' : activeMode;
    if (requestUrl.pathname === '/api/auth.php' && requestUrl.searchParams.get('action') === 'me') {
      return json(response, {
        logged_in: true,
        user: {
          id: mode === 'member' ? 2 : 1,
          username: `${mode}-overview-test`,
          nickname: mode === 'member' ? '成员首页测试' : '访客首页测试',
          role: 'visitor',
          email: `${mode}@example.com`,
          email_verified: true,
          avatar_url: '',
          profile_bio: '',
          qq_bound: false,
          discord_bound: false,
          bangumi_bound: false,
          membership_application_email_enabled: true,
        },
        memberships: mode === 'member'
          ? [{ club_id: 1, country: 'china', role: 'member', status: 'active' }]
          : [],
        success: true,
      });
    }
    if (requestUrl.pathname === '/api/membership.php' && requestUrl.searchParams.get('action') === 'my') {
      return json(response, {
        success: true,
        memberships: mode === 'member'
          ? [{ club_id: 1, country: 'china', role: 'member', status: 'active' }]
          : [],
        data: mode === 'member'
          ? [{ club_id: 1, country: 'china', role: 'member', status: 'active' }]
          : [],
      });
    }
    if (requestUrl.pathname.startsWith('/api/')) {
      return json(response, {
        success: true,
        data: [],
        memberships: [],
        notifications: [],
        events: [],
        registrations: [],
        count: 0,
      });
    }

    const relativePath = requestUrl.pathname.replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(projectRoot, relativePath);
    if (!filePath.startsWith(projectRoot + path.sep) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(response);
  });
  return server;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function execute(window, expression, label) {
  try {
    return await window.webContents.executeJavaScript(expression);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

async function waitFor(window, expression, label) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await execute(window, expression, label)) return;
    await wait(100);
  }
  throw new Error(`${label} timed out`);
}

async function runCase(baseUrl, testCase) {
  const consoleErrors = [];
  const window = new BrowserWindow({
    show: false,
    width: testCase.width,
    height: testCase.height,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      partition: `user-overview-test-${testCase.mode}-${testCase.width}-${Date.now()}`,
    },
  });
  const onConsoleMessage = (_event, level, message) => {
    // Electron's development-only CSP warning is emitted by the test shell,
    // not by the user center bundle under test.
    if (level >= 2 && !message.includes('Electron Security Warning')) consoleErrors.push(message);
  };
  window.webContents.on('console-message', onConsoleMessage);

  try {
    await window.loadURL(`${baseUrl}/user.html?tab=overview&fixture=${testCase.mode}`);
    await waitFor(window, `Boolean(document.querySelector('[data-component="个人驾驶舱"]'))`, 'overview dashboard');
    await waitFor(window, `Boolean(document.querySelector('.vn-qa-grid'))`, 'quick access grid');
    await wait(250);

    const result = await execute(window, `(() => ({
      bodyText: document.body?.innerText || '',
      quickAccess: [...document.querySelectorAll('.vn-qa-card strong')].map((node) => node.textContent.trim()),
      dashboard: Boolean(document.querySelector('[data-component="个人驾驶舱"]')),
      blank: !(document.body?.innerText || '').trim(),
    }))()`, 'read overview state');

    assert.equal(result.dashboard, true, `${testCase.mode} ${testCase.width}px should render the dashboard`);
    assert.equal(result.blank, false, `${testCase.mode} ${testCase.width}px should not be blank`);
    if (testCase.mode === 'member') {
      assert.ok(result.quickAccess.includes('同好会空间'), 'member should see the Space quick access entry');
    } else {
      assert.ok(!result.quickAccess.includes('同好会空间'), 'visitor should not see the Space quick access entry');
    }
    assert.deepEqual(consoleErrors, [], `${testCase.mode} ${testCase.width}px should have no browser console errors`);
    console.log(JSON.stringify({ mode: testCase.mode, viewport: testCase.width, quickAccess: result.quickAccess }));
  } finally {
    window.webContents.removeListener('console-message', onConsoleMessage);
    window.destroy();
  }
}

async function main() {
  await app.whenReady();
  const server = startFixtureServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cases = [
    { mode: 'visitor', width: 1366, height: 900 },
    { mode: 'visitor', width: 390, height: 844 },
    { mode: 'member', width: 1366, height: 900 },
    { mode: 'member', width: 390, height: 844 },
  ];

  try {
    for (const testCase of cases) await runCase(baseUrl, testCase);
    console.log('user overview browser regression passed');
  } finally {
    server.close();
    await app.quit();
  }
}

if (app?.whenReady && BrowserWindow) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
} else {
  console.error('Run this browser test with Electron.');
  process.exitCode = 1;
}
