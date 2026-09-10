const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const projectRoot = path.resolve(__dirname, '..');
const longMessage = [
  '维护公告：通知正文支持完整阅读。',
  '',
  '第一段用于验证列表摘要不会把长文本撑开；点击通知后，详情区域会保留原始换行。',
  '第二段用于验证桌面端阅读区和移动端详情抽屉都能显示全文。',
  '',
  '如果通知包含关联页面，详情底部还会显示查看相关内容按钮。',
].join('\n');

const fixtureNotifications = [
  {
    id: 101,
    type: 'system',
    title: '全站公告：通知中心改版测试',
    message: longMessage,
    link: './index.html?guest=1',
    related_type: 'announcement',
    related_id: 7,
    is_read: 0,
    created_at: '2026-09-10 12:30:00',
  },
  {
    id: 102,
    type: 'galonly_approved',
    title: '摊位申请通过第一阶段',
    message: '你的摊位申请已经通过审核，请提交后续材料。',
    link: '',
    related_type: 'galonly_application',
    related_id: 22,
    is_read: 1,
    created_at: '2026-09-09 09:15:00',
  },
  {
    id: 103,
    type: 'column_comment_reply',
    title: '你的专栏评论收到回复',
    message: '有人回复了你的文章评论。',
    link: './column/article.html?id=8#column-comments',
    related_type: 'column_comment',
    related_id: 31,
    is_read: 0,
    created_at: '2026-09-08 18:05:00',
  },
];

let activeNotifications = [];
let markReadIds = [];
let markAllReadCount = 0;

function resetNotifications(withData = true) {
  activeNotifications = withData ? fixtureNotifications.map((notification) => ({ ...notification })) : [];
  markReadIds = [];
  markAllReadCount = 0;
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
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
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
          username: 'notification-test',
          nickname: '通知测试用户',
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
          limit: 100,
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
        return json(response, { success: true, unread_count: activeNotifications.filter((notification) => Number(notification.is_read) !== 1).length });
      }
      if (action === 'mark_all_read' && request.method === 'POST') {
        markAllReadCount += 1;
        activeNotifications = activeNotifications.map((notification) => ({ ...notification, is_read: 1 }));
        return json(response, { success: true, unread_count: 0 });
      }
    }

    if (requestUrl.pathname.startsWith('/api/')) {
      return json(response, {
        success: true,
        data: [],
        memberships: [],
        notifications: [],
        registrations: [],
        events: [],
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
  resetNotifications(testCase.withData);
  const window = new BrowserWindow({
    show: false,
    width: testCase.width,
    height: testCase.height,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      partition: `notification-test-${Date.now()}-${testCase.width}`,
    },
  });
  const consoleMessages = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) {
      consoleMessages.push({ level, message });
    }
  });

  try {
    await window.loadURL(`${baseUrl}/user.html?tab=notifications`);
    await waitFor(window, `Boolean(document.querySelector('[data-od-id="notifications"]'))`, 'notification page');
    await wait(350);
    assert.deepEqual(consoleMessages, [], `browser console should have no warnings or errors: ${JSON.stringify(consoleMessages)}`);

    if (!testCase.withData) {
      const emptyState = await execute(window, `(() => ({
        hasEmpty: Boolean(document.querySelector('.vn-notification-filter-empty')),
        text: document.querySelector('.vn-notification-filter-empty')?.textContent || '',
      }))()`, 'read empty notification state');
      assert.equal(emptyState.hasEmpty, true, 'empty notification list should render an empty state');
      assert.match(emptyState.text, /暂无通知/);
      return;
    }

    const initial = await execute(window, `(() => {
      const notificationCard = document.querySelector('.vn-notification-card');
      const notificationHeader = document.querySelector('.vn-notification-header');
      const notificationHeaderActions = document.querySelector('.vn-notification-header-actions');
      const notificationTitle = document.querySelector('#notification-center-title');
      const notificationSummary = document.querySelector('.vn-notification-summary');
      const notificationFilterLabel = document.querySelector('.vn-notification-filter-button');
      const notificationMarkAll = document.querySelector('.vn-notification-mark-all');
      const notificationFilter = document.querySelector('.vn-notification-filter');
      const notificationFilterButtons = [...document.querySelectorAll('.vn-notification-filter-button')];
      const workspace = document.querySelector('.vn-notification-workspace');
      const list = document.querySelector('.vn-notification-list');
      const detailPane = document.querySelector('.vn-notification-detail-pane');
      const pageInner = document.querySelector('.vn-page-inner');
      const firstRow = document.querySelector('.vn-notification-row');
      const firstExcerpt = firstRow?.querySelector('.vn-notification-row-excerpt');
      const detail = document.querySelector('.vn-notification-detail-content');
      return {
        viewportWidth: window.innerWidth,
        cardTag: notificationCard?.tagName || '',
        cardBorderWidth: notificationCard ? getComputedStyle(notificationCard).borderWidth : '',
        cardBoxShadow: notificationCard ? getComputedStyle(notificationCard).boxShadow : '',
        headerHeight: notificationHeader?.getBoundingClientRect().height || 0,
        headerActionsHeight: notificationHeaderActions?.getBoundingClientRect().height || 0,
        headerFontSizes: [notificationTitle, notificationSummary, notificationFilterLabel, notificationMarkAll]
          .map((element) => element ? getComputedStyle(element).fontSize : ''),
        filterButtonCount: notificationFilterButtons.length,
        filterHeight: notificationFilter?.getBoundingClientRect().height || 0,
        filterOverflow: notificationFilter ? getComputedStyle(notificationFilter).overflow : '',
        filterButtonHeights: notificationFilterButtons.map((element) => element.getBoundingClientRect().height),
        filterFontSizes: notificationFilterButtons.map((element) => getComputedStyle(element).fontSize),
        filterActive: notificationFilterButtons.find((element) => element.getAttribute('aria-pressed') === 'true')?.dataset.filter || '',
        workspaceDisplay: workspace ? getComputedStyle(workspace).display : '',
        pageInnerFull: pageInner?.classList.contains('vn-page-inner-full') || false,
        pageInnerWidth: pageInner?.getBoundingClientRect().width || 0,
        workspaceWidth: workspace?.getBoundingClientRect().width || 0,
        listWidth: list?.getBoundingClientRect().width || 0,
        detailWidth: detailPane?.getBoundingClientRect().width || 0,
        detailDisplay: detailPane ? getComputedStyle(detailPane).display : '',
        rowCount: document.querySelectorAll('.vn-notification-row').length,
        unreadRows: document.querySelectorAll('.vn-notification-row.is-unread').length,
        summaryLineClamp: getComputedStyle(firstExcerpt).webkitLineClamp,
        summaryClientHeight: firstExcerpt?.clientHeight || 0,
        summaryScrollHeight: firstExcerpt?.scrollHeight || 0,
        hasPlaceholder: Boolean(document.querySelector('.vn-notification-empty-detail')),
        hasFullTextBeforeSelection: detail?.textContent.includes('第一段用于验证') || false,
      };
    })()`, 'read initial notification layout');

    console.log(JSON.stringify({ viewport: initial.viewportWidth, layout: initial.workspaceDisplay, rows: initial.rowCount, unreadRows: initial.unreadRows, headerHeight: initial.headerHeight, headerActionsHeight: initial.headerActionsHeight, headerFontSizes: initial.headerFontSizes, filterActive: initial.filterActive, filterHeight: initial.filterHeight }));
    assert.equal(initial.rowCount, 3, 'fixture should render all notification rows');
    assert.equal(initial.unreadRows, 2, 'fixture should render unread notification state');
    assert.equal(initial.cardTag, 'SECTION', 'notification center should use an integrated semantic section instead of a card shell');
    assert.equal(initial.cardBorderWidth, '0px', 'notification center should not render an outer card border');
    assert.equal(initial.cardBoxShadow, 'none', 'notification center should not render an outer card shadow');
    assert.ok(initial.headerHeight < (testCase.mobile ? 104 : 76), 'notification center header should stay compact');
    assert.ok(initial.headerActionsHeight < 58, 'notification header actions should stay compact');
    assert.deepEqual(initial.headerFontSizes, ['14px', '14px', '14px', '14px'], 'notification header typography should use one unified font size');
    assert.equal(initial.hasPlaceholder, true, 'desktop notification page should start with a detail placeholder');
    assert.equal(initial.hasFullTextBeforeSelection, false, 'full notification text should not be shown before selection');
    assert.equal(initial.summaryLineClamp, '2', 'notification summary should be clamped to two lines');
    assert.ok(initial.summaryScrollHeight >= initial.summaryClientHeight, 'notification summary should remain contained in its row');
    assert.equal(initial.filterButtonCount, 2, 'notification filter should render all and unread controls');
    assert.equal(initial.filterActive, 'all', 'all notifications should be the initial filter');
    assert.equal(initial.filterHeight, 32, 'notification filter should use a fixed compact height');
    assert.equal(initial.filterOverflow, 'visible', 'notification filter should not clip its controls');
    assert.deepEqual(initial.filterButtonHeights, [26, 26], 'notification filter buttons should fit inside the filter track');
    assert.deepEqual(initial.filterFontSizes, ['14px', '14px'], 'notification filter typography should use one unified font size');

    await execute(window, `document.querySelector('.vn-notification-filter-button[data-filter="unread"]').click()`, 'show unread notifications');
    await wait(120);
    assert.equal(await execute(window, `document.querySelectorAll('.vn-notification-row').length`, 'unread notification rows'), 2, 'unread filter should only show unread notifications');
    assert.equal(await execute(window, `document.querySelector('.vn-notification-filter-button[data-filter="unread"]')?.getAttribute('aria-pressed') === 'true'`, 'unread filter state'), true, 'unread filter should expose its selected state');
    await execute(window, `document.querySelector('.vn-notification-filter-button[data-filter="all"]').click()`, 'show all notifications');
    await wait(120);
    assert.equal(await execute(window, `document.querySelectorAll('.vn-notification-row').length`, 'all notification rows'), 3, 'all filter should restore every notification');

    await execute(window, `document.querySelector('.vn-notification-row').click()`, 'open first notification');
    await wait(350);
    const detail = await execute(window, `(() => {
      const drawer = document.querySelector('.ant-drawer-open');
      const content = (drawer || document).querySelector('.vn-notification-detail-content');
      const link = (drawer || document).querySelector('.vn-notification-detail-actions a');
      return {
        fullText: content?.textContent || '',
        hasLink: Boolean(link),
        linkHref: link?.getAttribute('href') || '',
        unreadState: (drawer || document).querySelector('.vn-notification-read-state')?.textContent || '',
        drawerOpen: Boolean(drawer),
        drawerWidth: drawer?.getBoundingClientRect().width || 0,
      };
    })()`, 'read notification detail');

    assert.equal(detail.fullText, longMessage, 'notification detail should show the complete message with line breaks');
    assert.equal(detail.hasLink, true, 'notification detail should show an existing related link');
    assert.match(detail.linkHref, /index\.html\?guest=1/);
    assert.match(detail.unreadState, /已读/);
    assert.ok(markReadIds.includes(101), 'opening an unread notification should mark it as read');

    if (testCase.mobile) {
      assert.equal(initial.workspaceDisplay, 'block', 'mobile notification page should collapse to one column');
      assert.equal(initial.detailDisplay, 'none', 'mobile page should hide the persistent detail pane');
      assert.equal(detail.drawerOpen, true, 'mobile notification click should open the detail drawer');
      assert.ok(Math.abs(detail.drawerWidth - initial.viewportWidth) <= 2, 'mobile detail drawer should use the full viewport width');
      await execute(window, `document.querySelector('.ant-drawer-close')?.click()`, 'close notification detail drawer');
      await wait(180);
      assert.equal(await execute(window, `!document.querySelector('.ant-drawer-open')`, 'drawer close state'), true, 'closing the drawer should return to the notification list');
      assert.equal(await execute(window, `document.querySelector('.vn-notification-row.is-selected')?.getAttribute('aria-pressed') === 'true'`, 'selected row state'), true, 'selected notification should remain selected after closing the drawer');
    } else {
      assert.equal(initial.workspaceDisplay, 'grid', 'desktop notification page should use a split reading layout');
      assert.equal(initial.pageInnerFull, true, 'desktop notification page should opt into the full-width page container');
      assert.ok(initial.pageInnerWidth > 1200, 'desktop notification page should exceed the default 1200px content cap on wide screens');
      assert.ok(Math.abs(initial.workspaceWidth - initial.pageInnerWidth) <= 2, 'notification workspace should fill the desktop page container');
      assert.ok(initial.listWidth > 250 && initial.detailWidth > 350, 'desktop list and detail panes should both have readable widths');
      assert.equal(detail.drawerOpen, false, 'desktop should use the persistent detail pane instead of a drawer');
      await execute(window, `document.querySelector('.vn-notification-mark-all').click()`, 'mark all notifications read');
      await wait(350);
      assert.equal(markAllReadCount, 1, 'mark all read should keep its existing action');
      assert.equal(await execute(window, `document.querySelectorAll('.vn-notification-row.is-unread').length === 0`, 'all read state'), true, 'mark all read should update the rendered list');
    }
  } finally {
    window.destroy();
  }
}

async function main() {
  await app.whenReady();
  const server = startFixtureServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await runCase(baseUrl, { width: 1920, height: 1080, mobile: false, withData: true });
    await runCase(baseUrl, { width: 390, height: 844, mobile: true, withData: true });
    await runCase(baseUrl, { width: 1920, height: 1080, mobile: false, withData: false });
    console.log('user notifications browser regression passed');
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
