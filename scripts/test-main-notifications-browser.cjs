const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const projectRoot = path.resolve(__dirname, '..');
const longMessage = [
  '通知正文测试：主站通知中心保留完整阅读能力。',
  '',
  '这一段用于验证列表摘要不会撑破行高，点击通知后详情区域仍然可以展示完整正文。',
  '第二段用于验证正文的换行和段落间距。',
].join('\n');

const fixtureNotifications = [
  {
    id: 201,
    type: 'system',
    title: '📢 全站公告：网站维护通知',
    message: longMessage,
    link: './index.html?guest=1',
    related_type: 'announcement',
    related_id: 8,
    is_read: 0,
    created_at: '2026-09-10 12:30:00',
  },
  {
    id: 202,
    type: 'galonly_phase2_submitted',
    title: '制品表单已提交',
    message: '你的制品审核表单已经提交，正在审核中，请耐心等待。',
    link: '',
    related_type: 'galonly_application',
    related_id: 22,
    is_read: 1,
    created_at: '2026-09-09 09:15:00',
  },
  {
    id: 203,
    type: 'join_approved',
    title: '同好会申请已通过',
    message: '你加入同好会的申请已通过审核。',
    link: '',
    related_type: 'club_membership',
    related_id: 31,
    is_read: 0,
    created_at: '2026-09-08 18:05:00',
  },
];

let activeNotifications = [];
let markReadIds = [];

function resetNotifications() {
  activeNotifications = fixtureNotifications.map((notification) => ({ ...notification }));
  markReadIds = [];
}

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

function readBody(request) {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
  });
}

function startFixtureServer() {
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    const action = requestUrl.searchParams.get('action');

    if (requestUrl.pathname === '/api/auth.php' && action === 'me') {
      return json(response, {
        logged_in: true,
        user: {
          id: 1,
          username: 'main-notification-test',
          nickname: '主站通知测试用户',
          role: 'visitor',
          email: 'notification@example.com',
          email_verified: true,
          avatar_url: '',
          profile_bio: '',
          qq_bound: false,
          discord_bound: false,
          bangumi_bound: false,
          membership_application_email_enabled: true,
        },
        memberships: [],
        success: true,
      });
    }

    if (requestUrl.pathname === '/api/notifications.php') {
      if (action === 'list') {
        const unreadCount = activeNotifications.filter((notification) => Number(notification.is_read) !== 1).length;
        return json(response, {
          success: true,
          notifications: activeNotifications,
          unread_count: unreadCount,
          total: activeNotifications.length,
          page: 1,
          limit: 20,
          total_pages: 1,
        });
      }
      if (action === 'count_unread') {
        return json(response, {
          success: true,
          count: activeNotifications.filter((notification) => Number(notification.is_read) !== 1).length,
        });
      }
      if (action === 'mark_read' && request.method === 'POST') {
        const body = await readBody(request);
        const id = Number(body.id);
        markReadIds.push(id);
        activeNotifications = activeNotifications.map((notification) => (
          Number(notification.id) === id ? { ...notification, is_read: 1 } : notification
        ));
        return json(response, {
          success: true,
          unread_count: activeNotifications.filter((notification) => Number(notification.is_read) !== 1).length,
        });
      }
      return json(response, { success: true, unread_count: 0 });
    }

    if (requestUrl.pathname.startsWith('/api/')) {
      return json(response, { success: true, data: [], memberships: [], notifications: [], count: 0 });
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

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function execute(window, expression, label) {
  try { return await window.webContents.executeJavaScript(expression); } catch (error) {
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

async function runCase(server, testCase) {
  resetNotifications();
  const window = new BrowserWindow({
    show: false,
    width: testCase.width,
    height: testCase.height,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      partition: `main-notification-test-${Date.now()}-${testCase.width}`,
    },
  });
  const consoleMessages = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) consoleMessages.push(message);
  });

  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}/index.html?guest=1&notification-test=1`);
    await waitFor(window, `typeof window.openVnfNotificationCenter === 'function'`, 'notification center entry point');
    await execute(window, 'window.openVnfNotificationCenter()', 'open notification center');
    await waitFor(window, `document.querySelectorAll('#notifCenterList .notif-item').length === 3`, 'notification rows');
    await wait(180);

    const initial = await execute(window, `(() => {
      const modal = document.querySelector('.notif-center-modal');
      const list = document.getElementById('notifCenterList');
      const detail = document.getElementById('notifCenterDetail');
      const typeLabels = [...document.querySelectorAll('#notifCenterList .notif-type-label')].map((node) => node.textContent.trim());
      const iconClasses = [...document.querySelectorAll('#notifCenterList .notif-icon')].map((node) => [...node.classList].find((name) => ['announcement','approved','rejected','audit','role','system'].includes(name)) || '');
      const style = modal ? getComputedStyle(modal) : null;
      return {
        rowCount: document.querySelectorAll('#notifCenterList .notif-item').length,
        annotationCount: typeLabels.length,
        typeLabels,
        iconClasses,
        titleText: document.querySelector('#notifCenterList .notif-title')?.textContent || '',
        topBorderWidth: style?.borderTopWidth || '',
        topBorderColor: style?.borderTopColor || '',
        borderColor: style?.borderColor || '',
        listOverflow: list ? list.scrollWidth > list.clientWidth : true,
        detailOverflow: detail ? detail.scrollWidth > detail.clientWidth : true,
      };
    })()`, 'read initial notification layout');

    assert.equal(initial.rowCount, 3, `${testCase.name}: fixture should render all rows`);
    assert.equal(initial.annotationCount, 3, `${testCase.name}: every row should have a visible annotation`);
    assert.deepEqual(initial.typeLabels, ['全站公告', 'GalOnly审核', '同好会'], `${testCase.name}: notification annotations should be semantic`);
    assert.ok(new Set(initial.iconClasses).size >= 3, `${testCase.name}: notification icons should not collapse to one generic icon`);
    assert.equal(initial.titleText.includes('📢'), false, `${testCase.name}: announcement emoji should not duplicate the icon`);
    assert.equal(initial.topBorderWidth, '1px', `${testCase.name}: modal should not use the old accent line`);
    assert.equal(initial.topBorderColor, initial.borderColor, `${testCase.name}: modal top border should use the neutral outline`);
    assert.equal(initial.listOverflow, false, `${testCase.name}: notification list should not overflow horizontally`);
    assert.equal(initial.detailOverflow, false, `${testCase.name}: notification detail should not overflow horizontally`);

    await execute(window, `document.querySelector('#notifCenterList .notif-item').click()`, 'open first notification');
    await waitFor(window, `Boolean(document.querySelector('#notifCenterDetail .nd-body'))`, 'notification detail');
    const detail = await execute(window, `(() => {
      const body = document.querySelector('#notifCenterDetail .nd-body');
      return {
        fullText: body?.textContent || '',
        hasBreaks: Boolean(body?.innerHTML.includes('<br>')),
        annotation: document.querySelector('#notifCenterDetail .nd-kicker')?.textContent || '',
        status: document.querySelector('#notifCenterDetail .nd-status')?.textContent || '',
        hasLink: Boolean(document.querySelector('#notifCenterDetail .nd-footer a')),
        mobileDetail: document.querySelector('.notif-center-modal')?.classList.contains('showing-detail') || false,
      };
    })()`, 'read notification detail');
    assert.equal(detail.fullText.replace(/\s+/g, ''), longMessage.replace(/\s+/g, ''), `${testCase.name}: notification detail should preserve full text`);
    assert.equal(detail.hasBreaks, true, `${testCase.name}: notification detail should preserve paragraph breaks`);
    assert.equal(detail.annotation, '全站公告', `${testCase.name}: detail should preserve notification annotation`);
    assert.equal(detail.status, '已读', `${testCase.name}: opened notification should show read state`);
    assert.equal(detail.hasLink, true, `${testCase.name}: existing notification link should remain available`);
    assert.ok(markReadIds.includes(201), `${testCase.name}: opening an unread notification should mark it read`);
    if (testCase.mobile) assert.equal(detail.mobileDetail, true, `${testCase.name}: mobile should switch to detail view`);

    return { name: testCase.name, rows: initial.rowCount, annotations: initial.typeLabels, icons: initial.iconClasses, mobileDetail: detail.mobileDetail, consoleMessages };
  } finally {
    window.destroy();
  }
}

app.whenReady().then(async () => {
  const server = startFixtureServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const results = [];
    for (const testCase of [
      { name: 'desktop', width: 1366, height: 900, mobile: false },
      { name: 'mobile', width: 390, height: 844, mobile: true },
    ]) results.push(await runCase(server, testCase));
    for (const result of results) {
      assert.deepEqual(result.consoleMessages, [], `${result.name}: browser console should have no errors or warnings`);
      console.log(`${result.name}: rows=${result.rows} annotations=${result.annotations.join('|')} icons=${result.icons.join('|')} mobileDetail=${result.mobileDetail}`);
    }
    console.log('main site notifications browser regression passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await app.quit();
  }
}).catch((error) => {
  console.error(error.stack || error);
  app.exit(1);
});
