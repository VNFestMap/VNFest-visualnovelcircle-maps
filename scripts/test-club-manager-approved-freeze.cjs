const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;

const projectRoot = path.resolve(__dirname, '..');
const optionValue = (name, fallback) => {
  const prefix = `--${name}=`;
  const argument = process.argv.find((item) => item.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
};
const approvedCount = Number(optionValue('count', process.env.CLUB_MANAGER_APPROVED_COUNT || 5000));
const switchBudgetMs = Number(optionValue('budget', process.env.CLUB_MANAGER_APPROVED_SWITCH_BUDGET_MS || 2500));
const viewport = process.argv.includes('--mobile') ? { width: 390, height: 844 } : { width: 1366, height: 900 };

if (!Number.isInteger(approvedCount) || approvedCount < 100) {
  throw new Error('CLUB_MANAGER_APPROVED_COUNT must be an integer >= 100');
}

if (app?.on) app.on('window-all-closed', (event) => event.preventDefault());

const approvedRows = Array.from({ length: approvedCount }, (_, index) => ({
  id: 10000 + index,
  club_id: 1,
  country: 'china',
  username: `历史成员-${String(index + 1).padStart(4, '0')}`,
  status: 'active',
  join_method: index % 3 === 0 ? 'school_code' : 'normal',
  apply_role: index % 5 === 0 ? 'manager' : 'member',
  contact_account: index % 7 === 0 ? '' : `qq-${index + 1}`,
  joined_at: `2026-${String((index % 9) + 1).padStart(2, '0')}-${String((index % 27) + 1).padStart(2, '0')} 09:15:00`,
}));

const membershipRows = [
  {
    id: 9999,
    club_id: 1,
    country: 'china',
    username: '待审核触发器',
    status: 'pending',
    join_method: 'school_code',
    apply_role: 'member',
    contact_account: 'qq-pending',
    joined_at: '2026-10-01 12:30:00',
    apply_reason: '',
  },
  ...approvedRows,
];

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
  return 'application/octet-stream';
}

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;
    const action = requestUrl.searchParams.get('action') || '';

    if (pathname === '/api/auth.php') {
      return json(res, {
        logged_in: true,
        user: { id: 1, username: 'super-admin', role: 'super_admin' },
        memberships: [{ club_id: 1, country: 'china', role: 'representative', status: 'active' }],
      });
    }
    if (pathname === '/api/clubs.php') {
      return json(res, { data: [{ id: 1, name: '已通过压力测试同好会', school: '测试学校', country: 'china' }] });
    }
    if (pathname === '/api/clubs_japan.php') return json(res, { data: [] });
    if (pathname === '/api/membership.php' && action === 'members') return json(res, { success: true, members: [] });
    if (pathname === '/api/membership.php' && action === 'pending') return json(res, { success: true, memberships: membershipRows });
    if (pathname.startsWith('/api/')) return json(res, { success: true, data: [], memberships: [], users: [], total: 0 });

    const relativePath = pathname.replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(projectRoot, relativePath);
    if (!filePath.startsWith(projectRoot + path.sep) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-store' });
    return fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const server = await startFixtureServer();
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: viewport.width,
    height: viewport.height,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) consoleErrors.push(message);
  });

  try {
    await win.loadURL(`${baseUrl}/admin/club_manager.html?tab=pending&approved_freeze_test=1`);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('#root .cm-app'))`);
      if (ready) break;
      await wait(100);
      if (attempt === 49) throw new Error('fixture club manager did not load');
    }

    const evaluation = win.webContents.executeJavaScript(`
      (async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const menuToggle = document.querySelector('.cm-menu-toggle');
        if (menuToggle) {
          menuToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await wait(220);
        }
        const menuItem = Array.from(document.querySelectorAll('.ant-menu-item')).find((node) => node.innerText.includes('已通过'));
        if (!menuItem) throw new Error('已通过 menu item was not found');
        await wait(120);
        const startedAt = performance.now();
        let timerAt = 0;
        setTimeout(() => { timerAt = performance.now(); }, 0);
        menuItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const list = document.querySelector('.cm-membership-list.is-approved');
          if (list && Number(list.dataset.totalRecords || 0) === ${approvedCount} && list.querySelectorAll('.cm-membership-item').length > 0) break;
          await wait(25);
        }
        const list = document.querySelector('.cm-membership-list.is-approved');
        const finishedAt = performance.now();
        await wait(0);
        const firstRow = list?.querySelector('.cm-membership-item');
        const rowStyle = firstRow ? getComputedStyle(firstRow) : null;
        const rowAnimation = rowStyle?.animation || '';
        const rowTransition = rowStyle?.transition || '';
        const bodyWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
        const pagination = document.querySelector('.cm-membership-pagination');
        const firstPageFirstUser = list?.querySelector('.cm-membership-item .cm-identity-text strong')?.innerText || '';
        const secondPageButton = Array.from(document.querySelectorAll('.cm-pagination-item, .ant-pagination-item')).find((node) => node.innerText.trim() === '2');
        secondPageButton?.click();
        await wait(80);
        const secondPageFirstUser = list?.querySelector('.cm-membership-item .cm-identity-text strong')?.innerText || '';
        return {
          switchMs: Math.round(finishedAt - startedAt),
          timerDelayMs: timerAt ? Math.round(timerAt - startedAt) : null,
          rowCount: list ? list.querySelectorAll('.cm-membership-item').length : 0,
          totalCount: list ? Number(list.dataset.totalRecords || 0) : 0,
          pageSize: list ? Number(list.dataset.pageSize || 0) : 0,
          paginationText: pagination?.innerText || '',
          secondPageRowCount: list ? list.querySelectorAll('.cm-membership-item').length : 0,
          secondPageChanged: Boolean(secondPageFirstUser && secondPageFirstUser !== firstPageFirstUser),
          domNodeCount: document.querySelectorAll('*').length,
          bodyWidth,
          innerWidth,
          rowAnimation,
          rowTransition,
          activeTab: document.querySelector('.ant-menu-item-selected')?.innerText || '',
        };
      })();
    `);
    const result = await Promise.race([
      evaluation,
      wait(20000).then(() => { throw new Error('approved tab did not finish rendering within 20s'); }),
    ]);

    console.log(JSON.stringify({ approvedCount, switchBudgetMs, consoleErrors, ...result }));
    assert.equal(consoleErrors.length, 0, `approved switch should not add console errors: ${consoleErrors.join('; ')}`);
    assert.equal(result.activeTab.includes('已通过'), true, 'approved tab should become active');
    assert.equal(result.totalCount, approvedCount, `approved tab should retain all ${approvedCount} fixture rows in the list model`);
    assert.equal(result.rowCount <= 100, true, `approved tab should render at most one page in the DOM (got ${result.rowCount})`);
    assert.equal(result.pageSize, 100, 'approved history should use a bounded page size');
    assert.equal(result.paginationText.includes(`共 ${approvedCount} 条`), true, 'approved pagination should expose the full history count');
    assert.equal(result.secondPageRowCount, 100, 'approved history page two should keep the bounded row count');
    assert.equal(result.secondPageChanged, true, 'approved history pagination should change the visible records');
    assert.equal(result.bodyWidth <= result.innerWidth + 1, true, 'approved list should not horizontally overflow');
    assert.equal(result.rowAnimation.includes('none'), true, 'approved rows should not run an entry animation');
    assert.equal(result.rowTransition.includes('none'), true, 'approved rows should not run an initial transition');
    assert.ok(result.switchMs < switchBudgetMs, `approved tab switch should finish under ${switchBudgetMs}ms (got ${result.switchMs}ms)`);
  } finally {
    win.destroy();
    await app.quit();
    await new Promise((resolve) => server.close(resolve));
  }
}

if (app?.whenReady && BrowserWindow) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
    if (app?.exit) app.exit(1);
  });
}
