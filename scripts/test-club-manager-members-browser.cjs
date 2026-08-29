const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;

const projectRoot = path.resolve(__dirname, '..');
if (app?.on) app.on('window-all-closed', (event) => event.preventDefault());
const viewportSizes = {
  mobile: { width: 390, height: 844 },
  narrowMobile: { width: 360, height: 800 },
  screenshotWidth: { width: 582, height: 900 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1366, height: 900 },
};

const members = [
  {
    id: 10,
    user_id: 2,
    username: '静致远管理账号',
    nickname: '静致远',
    email: 'very-long-member-email-address@example.vnfest.top',
    qq_account: '389951383',
    apply_role: 'manager',
    is_student: 1,
    joined_at: '2026-05-09 19:50:00',
    role: 'manager',
    application_email_enabled: 1,
    avatar_url: '',
  },
  {
    id: 11,
    user_id: 3,
    username: '普通成员',
    nickname: '普通成员昵称',
    email: 'member@example.com',
    qq_account: '1545786120',
    apply_role: 'member',
    is_student: 0,
    joined_at: '2026-05-10 10:20:00',
    role: 'member',
    application_email_enabled: 0,
    avatar_url: '',
  },
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
      return json(res, { data: [{ id: 1, name: '成员布局测试同好会', school: '测试学校', country: 'china' }] });
    }
    if (pathname === '/api/clubs_japan.php') {
      return json(res, { data: [] });
    }
    if (pathname === '/api/membership.php' && action === 'members') {
      return json(res, { success: true, members });
    }
    if (pathname === '/api/membership.php' && action === 'pending') {
      return json(res, { success: true, memberships: [] });
    }
    if (pathname.startsWith('/api/')) {
      return json(res, { success: true, data: [], memberships: [], users: [], total: 0 });
    }

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

async function waitForMembers(win) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('#clubSelector option[value="1|china"]'))`);
    if (ready) return;
    await wait(100);
  }
  throw new Error('fixture club option did not load');
}

async function inspectViewport(baseUrl, name, size, theme) {
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: size.width,
    height: size.height,
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
    await win.loadURL(`${baseUrl}/admin/club_manager.html?member_layout_test=1`);
    await waitForMembers(win);
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        document.documentElement.dataset.theme = ${JSON.stringify(theme)};
        const selector = document.getElementById('clubSelector');
        selector.value = '1|china';
        onClubChange();
        switchTab('members');
        for (let attempt = 0; attempt < 30; attempt += 1) {
          if (document.querySelector('.member-card')) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const cards = Array.from(document.querySelectorAll('.member-card'));
        const bodyWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
        const details = cards.flatMap(card => Array.from(card.querySelectorAll('.member-detail-item')));
        const actions = cards.flatMap(card => Array.from(card.querySelectorAll('.member-actions > *')));
        const actionOverflow = cards.some(card => {
          const cardRect = card.getBoundingClientRect();
          return Array.from(card.querySelectorAll('.member-actions > *')).some(control => {
            const rect = control.getBoundingClientRect();
            return rect.left < cardRect.left - 1 || rect.right > cardRect.right + 1;
          });
        });
        return {
          innerWidth,
          bodyWidth,
          cards: cards.length,
          details: details.length,
          actionCount: actions.length,
          actionOverflow,
          detailGrid: cards[0] ? getComputedStyle(cards[0].querySelector('.member-details')).display : '',
          memberDirection: cards[0] ? getComputedStyle(cards[0].querySelector('.member-item')).flexDirection : '',
          actionWrap: cards[0] ? getComputedStyle(cards[0].querySelector('.member-actions')).flexWrap : '',
          actionMinHeights: actions.map(item => Math.round(item.getBoundingClientRect().height)),
          hasRequiredFields: ['昵称', '邮箱', 'QQ', '申请身份', '学生', '加入于'].every(label => document.body.innerText.includes(label)),
          detailWidths: details.map(item => Math.round(item.getBoundingClientRect().width)),
        };
      })();
    `);
    return { name, theme, consoleErrors, ...result };
  } finally {
    win.destroy();
  }
}

async function main() {
  const server = await startFixtureServer();
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const requested = process.argv.includes('--all-viewports')
    ? Object.entries(viewportSizes)
    : [['mobile', viewportSizes.mobile], ['tablet', viewportSizes.tablet], ['desktop', viewportSizes.desktop]];
  const results = [];

  try {
    await app.whenReady();
    for (const [name, size] of requested) {
      for (const theme of ['dark', 'light']) {
        const result = await inspectViewport(baseUrl, name, size, theme);
        results.push(result);
        assert.equal(result.consoleErrors.length, 0, `${name}/${theme} should not add console errors: ${result.consoleErrors.join('; ')}`);
        assert.equal(result.cards, 2, `${name}/${theme} should render fixture members`);
        assert.equal(result.actionOverflow, false, `${name}/${theme} member actions should stay inside cards`);
        assert.equal(result.bodyWidth <= result.innerWidth + 1, true, `${name}/${theme} should not horizontally overflow`);
        assert.equal(result.hasRequiredFields, true, `${name}/${theme} should keep all super-admin member fields`);
        if (size.width <= 640) {
          assert.equal(result.memberDirection, 'column', `${name}/${theme} should use a vertical member card`);
          assert.equal(result.detailGrid, 'grid', `${name}/${theme} should use the mobile detail grid`);
          assert.equal(result.actionWrap, 'wrap', `${name}/${theme} actions should wrap`);
          assert.equal(result.actionMinHeights.every((height) => height >= 44), true, `${name}/${theme} actions should have 44px targets`);
          assert.equal(result.detailWidths.every((width) => width >= 100), true, `${name}/${theme} detail fields should not collapse to character-width columns`);
        } else if (size.width <= 899) {
          assert.equal(result.actionWrap, 'wrap', `${name}/${theme} tablet actions should wrap`);
        } else {
          assert.equal(result.memberDirection, 'row', `${name}/${theme} desktop member rows should remain horizontal`);
        }
        console.log(`OK ${name}/${theme} cards=${result.cards} actions=${result.actionCount} width=${result.innerWidth}`);
      }
    }
  } finally {
    await app.quit();
    await new Promise((resolve) => server.close(resolve));
  }
}

if (app?.whenReady && BrowserWindow) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
