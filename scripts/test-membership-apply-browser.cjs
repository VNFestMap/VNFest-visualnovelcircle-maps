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
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;

    if (pathname === '/api/auth.php') {
      return json(res, {
        logged_in: true,
        user: { id: 1, username: 'membership-ui-test', role: 'member' },
        memberships: [],
      });
    }
    if (pathname === '/api/clubs.php') {
      return json(res, {
        success: true,
        data: [{ id: 1, name: '三列绑定方式测试同好会', school: '测试学校', country: 'china' }],
      });
    }
    if (pathname === '/api/clubs_japan.php') {
      return json(res, { success: true, data: [] });
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
    res.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cache-Control': 'no-store',
    });
    return fs.createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(win, expression, label) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = await win.webContents.executeJavaScript(expression);
    if (ready) return;
    await wait(100);
  }
  throw new Error(`${label} timed out`);
}

async function inspectViewport(baseUrl, name, size) {
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
    await win.loadURL(`${baseUrl}/index.html?guest=1&membership_apply_test=1`);
    await waitFor(win, `typeof window.openMembershipApplyModal === 'function'`, 'membership apply modal API');
    await win.webContents.executeJavaScript(`
      openMembershipApplyModal({ id: 1, name: '三列绑定方式测试同好会', country: 'china' });
    `);
    await wait(120);

    const result = await win.webContents.executeJavaScript(`(() => {
      const wrapper = document.querySelector('.membership-apply-tabs');
      const tabs = [...document.querySelectorAll('.membership-apply-tab')];
      const modal = document.querySelector('#membershipApplyModal .calendar-modal-card');
      if (!wrapper || !modal) return { missing: true };

      const wrapperRect = wrapper.getBoundingClientRect();
      const tabRects = tabs.map((tab) => {
        const rect = tab.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          text: tab.textContent.trim(),
          scrollWidth: tab.scrollWidth,
          clientWidth: tab.clientWidth,
          whiteSpace: getComputedStyle(tab).whiteSpace,
          textRectCount: (() => {
            const range = document.createRange();
            range.selectNodeContents(tab);
            return range.getClientRects().length;
          })(),
        };
      });

      const switches = tabs.map((tab) => {
        tab.click();
        return {
          method: tab.dataset.joinMethod,
          activeCount: document.querySelectorAll('.membership-apply-tab.active').length,
          activeMethod: document.querySelector('.membership-apply-tab.active')?.dataset.joinMethod || '',
        };
      });

      return {
        missing: false,
        tabCount: tabs.length,
        labels: tabs.map((tab) => tab.textContent.trim()),
        wrapper: {
          left: wrapperRect.left,
          right: wrapperRect.right,
          width: wrapperRect.width,
          scrollWidth: wrapper.scrollWidth,
          clientWidth: wrapper.clientWidth,
        },
        tabRects,
        switches,
        modalWidth: modal.getBoundingClientRect().width,
        bodyOverflow: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - window.innerWidth,
        innerWidth: window.innerWidth,
      };
    })()`);

    assert.equal(result.missing, false, `${name} should render the membership apply modal`);
    assert.equal(result.tabCount, 3, `${name} should render exactly three join method tabs`);
    assert.deepEqual(result.labels, ['本校无绑定码', '本校有绑定码', '外校交流'], `${name} labels should remain complete`);
    assert.ok(result.wrapper.scrollWidth <= result.wrapper.clientWidth + 1, `${name} tabs should not horizontally scroll`);
    assert.ok(result.bodyOverflow <= 1, `${name} page should not horizontally overflow: ${result.bodyOverflow}`);

    const widths = result.tabRects.map((tab) => tab.width);
    assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `${name} tabs should use equal columns`);
    for (const tab of result.tabRects) {
      assert.ok(tab.left >= result.wrapper.left - 1, `${name} tab should stay inside the left edge`);
      assert.ok(tab.right <= result.wrapper.right + 1, `${name} tab should stay inside the right edge`);
      assert.ok(tab.scrollWidth <= tab.clientWidth + 1, `${name} tab text should not be clipped`);
      if (size.width <= 720) {
        assert.equal(tab.whiteSpace, 'nowrap', `${name} tab text should remain on one line`);
        assert.ok(tab.height >= 44, `${name} mobile tab should be touch-safe`);
      } else {
        assert.equal(tab.textRectCount, 1, `${name} tab text should not wrap`);
      }
    }
    for (const switchResult of result.switches) {
      assert.equal(switchResult.activeCount, 1, `${name} should keep exactly one active tab`);
      assert.equal(switchResult.activeMethod, switchResult.method, `${name} should switch to the clicked join method`);
    }

    return { name, consoleErrors, result };
  } finally {
    win.destroy();
  }
}

async function main() {
  const liveBaseUrl = String(process.env.MEMBERSHIP_APPLY_BASE_URL || '').replace(/\/$/, '');
  const server = liveBaseUrl ? null : await startFixtureServer();
  const baseUrl = liveBaseUrl || `http://127.0.0.1:${server.address().port}`;
  const requested = process.argv.includes('--all-viewports')
    ? Object.entries(viewportSizes)
    : [['mobile', viewportSizes.mobile], ['tablet', viewportSizes.tablet], ['desktop', viewportSizes.desktop]];
  const results = [];

  try {
    await app.whenReady();
    for (const [name, size] of requested) {
      const result = await inspectViewport(baseUrl, name, size);
      assert.equal(result.consoleErrors.length, 0, `${name} should not add console errors: ${result.consoleErrors.join('; ')}`);
      console.log(`OK ${name} ${JSON.stringify(result.result)}`);
      results.push(result);
    }
  } finally {
    if (server) server.close();
    await app.quit();
  }

  console.log(`membership apply browser checks passed for ${results.length} viewport(s)`);
}

if (app?.whenReady && BrowserWindow) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
} else {
  console.error('Run this browser test with Electron, for example: npx electron scripts/test-membership-apply-browser.cjs --all-viewports');
  process.exitCode = 1;
}
