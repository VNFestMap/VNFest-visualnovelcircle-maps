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
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (requestUrl.pathname === '/api/auth.php' && requestUrl.searchParams.get('action') === 'me') {
      return json(response, {
        logged_in: true,
        user: {
          id: 1,
          username: 'tab-slider-test',
          nickname: 'Tab 滑块测试',
          role: 'visitor',
          email: 'slider@example.com',
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

async function main() {
  await app.whenReady();
  const server = startFixtureServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cases = [
    { width: 1366, height: 900, mobile: false },
    { width: 390, height: 844, mobile: true },
  ];

  try {
    for (const testCase of cases) {
      const window = new BrowserWindow({
        show: false,
        width: testCase.width,
        height: testCase.height,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
          partition: `tab-slider-test-${Date.now()}-${testCase.width}`,
        },
      });

      try {
        await window.loadURL(`${baseUrl}/user.html?tab=notifications`);
        if (testCase.mobile) {
          await waitFor(window, `Boolean(document.querySelector('.vn-menu-toggle'))`, 'mobile menu toggle');
          await execute(window, `document.querySelector('.vn-menu-toggle').click()`, 'open mobile menu');
        }
        await waitFor(window, `Boolean(document.querySelector('.vn-nav-wrap .ant-menu-item-selected'))`, 'selected menu item');
        await wait(350);

        const geometry = await execute(window, `(() => {
          const nav = document.querySelector('.vn-nav-wrap');
          const selected = nav?.querySelector('.ant-menu-item-selected');
          const navRect = nav?.getBoundingClientRect();
          const selectedRect = selected?.getBoundingClientRect();
          return {
            viewport: { width: window.innerWidth, height: window.innerHeight },
            navTop: navRect?.top,
            selectedTop: selectedRect?.top,
            selectedHeight: selectedRect?.height,
            selectedOffsetTop: selected?.offsetTop,
            selectedOffsetHeight: selected?.offsetHeight,
            sliderHeight: Number.parseFloat(getComputedStyle(nav, '::before').height),
            inlinePosition: nav?.style.getPropertyValue('--vn-tab-slider-y') || '',
            sliderReady: nav?.hasAttribute('data-slider-ready'),
          };
        })()`, 'read slider geometry');

        console.log(JSON.stringify(geometry));
        assert.equal(geometry.sliderReady, true, 'slider should be ready after the menu mounts');
        const expectedSliderY = geometry.selectedOffsetTop
          + Math.max(0, (geometry.selectedOffsetHeight - geometry.sliderHeight) / 2);
        assert.ok(Math.abs(Number.parseFloat(geometry.inlinePosition) - expectedSliderY) <= 1,
          'slider should be vertically centered inside the selected menu item');
        assert.ok(Math.abs(
          (geometry.navTop + Number.parseFloat(geometry.inlinePosition) + (geometry.sliderHeight / 2))
            - (geometry.selectedTop + (geometry.selectedHeight / 2))
        ) <= 1, 'slider center should align with the selected menu item center');

        await execute(window, `(() => {
          const item = [...document.querySelectorAll('.vn-nav-wrap .ant-menu-item')]
            .find((candidate) => candidate.textContent.includes('账户'));
          if (!item) throw new Error('account menu item not found');
          item.click();
        })()`, 'switch to account tab');
        await waitFor(window, `document.querySelector('.vn-nav-wrap .ant-menu-item-selected')?.textContent.includes('账户')`, 'account tab selection');
        await wait(350);
        const switched = await execute(window, `(() => {
          const nav = document.querySelector('.vn-nav-wrap');
          const selected = nav?.querySelector('.ant-menu-item-selected');
          const selectedRect = selected?.getBoundingClientRect();
          const navRect = nav?.getBoundingClientRect();
          return {
            inlinePosition: nav?.style.getPropertyValue('--vn-tab-slider-y') || '',
            selectedOffsetTop: selected?.offsetTop,
            selectedOffsetHeight: selected?.offsetHeight,
            sliderHeight: Number.parseFloat(getComputedStyle(nav, '::before').height),
            navTop: navRect?.top,
            selectedTop: selectedRect?.top,
            selectedHeight: selectedRect?.height,
          };
        })()`, 'read switched slider geometry');
        const expectedSwitchedY = switched.selectedOffsetTop
          + Math.max(0, (switched.selectedOffsetHeight - switched.sliderHeight) / 2);
        assert.ok(Math.abs(Number.parseFloat(switched.inlinePosition) - expectedSwitchedY) <= 1,
          'slider should stay centered after a tab switch');
        assert.ok(Math.abs(
          (switched.navTop + Number.parseFloat(switched.inlinePosition) + (switched.sliderHeight / 2))
            - (switched.selectedTop + (switched.selectedHeight / 2))
        ) <= 1, 'slider center should remain aligned after a tab switch');
      } finally {
        window.destroy();
      }
    }
    console.log('user tab slider browser regression passed');
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
