const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;

const projectRoot = path.resolve(__dirname, '..');
if (app?.on) app.on('window-all-closed', event => event.preventDefault());
const viewportSizes = {
  mobile: { width: 390, height: 844 },
  narrowMobile: { width: 360, height: 800 },
  screenshotWidth: { width: 582, height: 900 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1366, height: 900 },
};

let fixtureState;

function resetFixtureState() {
  fixtureState = {
    nextId: 999,
    failNextReorder: false,
    recommendations: [
      { id: 101, bangumi_id: 101, title: '第一个作品', image_url: '', rating: 9.1, summary: '', sort_order: 0 },
      { id: 104, bangumi_id: 104, title: '第四个作品', image_url: '', rating: 8.8, summary: '', sort_order: 3 },
      { id: 112, bangumi_id: 112, title: '第十二个作品', image_url: '', rating: 8.5, summary: '', sort_order: 11 },
    ],
  };
}

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

function readJsonBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
  });
}

async function startFixtureServer() {
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;
    const action = requestUrl.searchParams.get('action') || '';

    if (pathname === '/api/auth.php') {
      return json(res, {
        logged_in: true,
        user: { id: 1, username: 'recommendations-test-admin', role: 'super_admin' },
        memberships: [{ club_id: 1, country: 'china', role: 'representative', status: 'active' }],
      });
    }
    if (pathname === '/api/clubs.php') {
      return json(res, { success: true, data: [{ id: 1, name: '固定槽位测试同好会', school: '测试学校', country: 'china' }] });
    }
    if (pathname === '/api/clubs_japan.php') {
      return json(res, { success: true, data: [] });
    }
    if (pathname === '/api/club_recommendations.php') {
      if (action === 'list') return json(res, { success: true, data: fixtureState.recommendations.map(item => ({ ...item })) });
      const input = await readJsonBody(req);
      if (action === 'add') {
        const position = Number(input.position || 0);
        const sortOrder = position - 1;
        if (!Number.isInteger(position) || position < 1 || position > 12) {
          return json(res, { success: false, message: '位置无效' });
        }
        if (fixtureState.recommendations.some(item => item.sort_order === sortOrder)) {
          return json(res, { success: false, message: '位置已占用' });
        }
        fixtureState.recommendations.push({
          id: fixtureState.nextId,
          bangumi_id: Number(input.bangumi_id),
          title: input.title || '新增作品',
          image_url: input.image_url || '',
          rating: Number(input.rating || 0),
          summary: input.summary || '',
          sort_order: sortOrder,
        });
        fixtureState.nextId += 1;
        return json(res, { success: true, id: fixtureState.nextId - 1 });
      }
      if (action === 'remove') {
        fixtureState.recommendations = fixtureState.recommendations.filter(item => item.id !== Number(input.id));
        return json(res, { success: true });
      }
      if (action === 'reorder') {
        if (fixtureState.failNextReorder) {
          fixtureState.failNextReorder = false;
          return json(res, { success: false, message: '模拟排序失败' });
        }
        const slots = Array.isArray(input.slots) ? input.slots : [];
        for (let slot = 0; slot < slots.length; slot += 1) {
          const item = fixtureState.recommendations.find(entry => entry.id === Number(slots[slot]));
          if (item) item.sort_order = slot;
        }
        return json(res, { success: true });
      }
      return json(res, { success: true, data: [] });
    }
    if (pathname === '/api/club_moe_king.php' && action === 'get') {
      return json(res, {
        success: true,
        data: {
          character_id: 77,
          name: 'Top Cropped Character',
          name_cn: '顶部裁剪角色',
          image_url: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
          summary: '用于验证角色头像从顶部开始裁剪。',
        },
      });
    }
    if (pathname === '/api/bangumi_proxy.php') {
      if (action === 'search') {
        return json(res, {
          success: true,
          data: [{ bangumi_id: 999, title: 'Test Added Work', title_cn: '指定位置作品', image_url: '', rating: 8.8, summary: '' }],
        });
      }
      if (action === 'get') return json(res, { success: true, data: { rating: { score: 8.8 } } });
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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForBoard(win) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.rec-list [data-rec-slot="0"]'))`);
    if (ready) return;
    await wait(100);
  }
  throw new Error('recommendation board did not render');
}

async function openManager(baseUrl, size, theme) {
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
  await win.loadURL(`${baseUrl}/admin/club_manager.html?recommendations_test=1`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('#root .cm-app'))`);
    if (ready) break;
    await wait(100);
  }
  await win.webContents.executeJavaScript(`
    (async () => {
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      document.querySelector('.cm-menu-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 150));
      document.querySelector('#clubSelector').closest('.ant-select').querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 100));
      Array.from(document.querySelectorAll('.ant-select-item-option')).find(node => node.innerText.includes('测试同好会'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 100));
      Array.from(document.querySelectorAll('.ant-menu-item')).find(node => node.innerText.includes('神器榜'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (document.querySelector('.rec-list [data-rec-slot="0"]')) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('recommendation board did not render after tab switch');
    })();
  `);
  await waitForBoard(win);
  return { win, consoleErrors };
}

async function inspectViewport(baseUrl, name, size, theme) {
  resetFixtureState();
  const { win, consoleErrors } = await openManager(baseUrl, size, theme);
  try {
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        const cards = Array.from(document.querySelectorAll('.rec-list [data-rec-slot]'));
        return {
          innerWidth,
          bodyWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          slotCount: cards.length,
          emptySlots: cards.filter(card => card.classList.contains('rec-card-empty')).map(card => Number(card.dataset.recSlot)),
          touchTargets: cards.map(card => Math.round(card.getBoundingClientRect().height)),
          filledRanks: cards.filter(card => card.classList.contains('is-filled')).map(card => card.dataset.rank),
          moeObjectPosition: (() => {
            const image = document.querySelector('.cm-character-avatar img');
            return image ? getComputedStyle(image).objectPosition : '';
          })(),
          statusText: document.getElementById('recSlotStatus')?.innerText || '',
        };
      })();
    `);
    return { name, theme, consoleErrors, ...result };
  } finally {
    win.destroy();
  }
}

async function testMobileInteractions(baseUrl) {
  resetFixtureState();
  const { win, consoleErrors } = await openManager(baseUrl, viewportSizes.mobile, 'dark');
  try {
    await win.webContents.executeJavaScript(`
      (async () => {
        document.querySelector('[data-rec-slot="6"]').click();
        const input = document.querySelector('.ant-input-search input');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '指定位置'); input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.ant-input-search-button').click();
        for (let i = 0; i < 30; i++) { if (Array.from(document.querySelectorAll('button')).some(b => b.innerText.includes('添加到第 7 位'))) break; await new Promise(r => setTimeout(r, 50)); }
        Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('添加到第 7 位'))?.click();
      })();
    `);
    for (let attempt = 0; attempt < 40; attempt += 1) { if (fixtureState.recommendations.some(item => item.id === 999)) break; await wait(50); }
    await win.webContents.executeJavaScript(`document.querySelector('[data-rec-slot="3"] button').click()`);
    await wait(120);
    const confirmPoint = await win.webContents.executeJavaScript(`(() => { const node = Array.from(document.querySelectorAll('.ant-modal-confirm-btns .ant-btn-primary')).filter(n => n.offsetParent !== null).at(-1); if (!node) return null; const r = node.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    assert.ok(confirmPoint, 'remove confirmation should be visible');
    win.webContents.sendInputEvent({ type: 'mouseDown', x: confirmPoint.x, y: confirmPoint.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: confirmPoint.x, y: confirmPoint.y, button: 'left', clickCount: 1 });
    await wait(250);
    await win.webContents.executeJavaScript(`(async () => { document.querySelector('[data-rec-slot="0"]').click(); await new Promise(r => setTimeout(r, 60)); document.querySelector('[data-rec-slot="1"]').click(); })()`);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (fixtureState.recommendations.some(item => item.id === 101 && item.sort_order === 1)) break;
      await wait(50);
    }
    assert.equal(fixtureState.recommendations.find(item => item.id === 999)?.sort_order, 6, 'targeted add should occupy slot 7');
    assert.equal(fixtureState.recommendations.some(item => item.id === 104), false, 'remove should delete only the selected item');
    assert.equal(fixtureState.recommendations.find(item => item.id === 112)?.sort_order, 11, 'deleting slot 4 must not compact slot 12');
    assert.equal(fixtureState.recommendations.find(item => item.id === 101)?.sort_order, 1, 'mobile click-to-move should move the item');

    fixtureState.failNextReorder = true;
    await win.webContents.executeJavaScript(`(async () => { document.querySelector('[data-rec-slot="1"]').click(); await new Promise(r => setTimeout(r, 60)); document.querySelector('[data-rec-slot="2"]').click(); })()`);
    await wait(120);
    assert.equal(fixtureState.recommendations.find(item => item.id === 101)?.sort_order, 1, 'failed reorder should leave server order unchanged');
    const uiSlot = await win.webContents.executeJavaScript(`document.querySelector('[data-rec-slot="1"]')?.innerText || ''`);
    assert.match(uiSlot, /第一个作品/, 'failed reorder should restore the original UI slot');
    assert.equal(consoleErrors.length, 0, `mobile interaction should not add console errors: ${consoleErrors.join('; ')}`);
  } finally {
    win.destroy();
  }
}

async function testDesktopDrag(baseUrl) {
  resetFixtureState();
  const { win, consoleErrors } = await openManager(baseUrl, viewportSizes.desktop, 'light');
  try {
    await win.webContents.executeJavaScript(`
      (async () => {
        const source = document.querySelector('[data-rec-slot="11"]');
        const target = document.querySelector('[data-rec-slot="0"]');
        const transfer = new DataTransfer();
        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
        await new Promise(resolve => setTimeout(resolve, 60));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
      })();
    `);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (fixtureState.recommendations.find(item => item.id === 112)?.sort_order === 0) break;
      await wait(50);
    }
    assert.equal(fixtureState.recommendations.find(item => item.id === 112)?.sort_order, 0, 'dragging onto an occupied slot should move the source into the target');
    assert.equal(fixtureState.recommendations.find(item => item.id === 101)?.sort_order, 11, 'dragging onto an occupied slot should swap the target item');
    assert.equal(consoleErrors.length, 0, `desktop drag should not add console errors: ${consoleErrors.join('; ')}`);
  } finally {
    win.destroy();
  }
}

async function main() {
  resetFixtureState();
  const server = await startFixtureServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const requested = process.argv.includes('--all-viewports')
    ? Object.entries(viewportSizes)
    : [['mobile', viewportSizes.mobile], ['tablet', viewportSizes.tablet], ['desktop', viewportSizes.desktop]];

  try {
    await app.whenReady();
    for (const [name, size] of requested) {
      for (const theme of ['dark', 'light']) {
        const result = await inspectViewport(baseUrl, name, size, theme);
        assert.equal(result.consoleErrors.length, 0, `${name}/${theme} should not add console errors: ${result.consoleErrors.join('; ')}`);
        assert.equal(result.slotCount, 12, `${name}/${theme} should render all twelve recommendation slots`);
        assert.equal(result.bodyWidth <= result.innerWidth + 1, true, `${name}/${theme} should not horizontally overflow`);
        assert.deepEqual(result.emptySlots, [1, 2, 4, 5, 6, 7, 8, 9, 10], `${name}/${theme} should preserve the sparse fixture slots`);
        assert.deepEqual(result.filledRanks, ['1', '4', '12'], `${name}/${theme} recommendation rank metadata must remain stable`);
        assert.ok(result.moeObjectPosition.includes('0%'), `${name}/${theme} character avatars should crop from the top (got ${result.moeObjectPosition})`);
        if (size.width <= 640) {
          assert.equal(result.touchTargets.every(height => height >= 44), true, `${name}/${theme} recommendation slots should remain touch-friendly`);
        }
        console.log(`OK ${name}/${theme} slots=${result.slotCount} width=${result.innerWidth}`);
      }
    }
    await testMobileInteractions(baseUrl);
    await testDesktopDrag(baseUrl);
    console.log('club manager recommendation browser tests passed');
  } finally {
    await app.quit();
    await new Promise(resolve => server.close(resolve));
  }
}

if (app?.whenReady && BrowserWindow) {
  main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
    /* app.quit() always terminates Electron with code 0, so a failing run has to
       force the exit status or a chained `&&` script would report success. */
    if (app?.exit) app.exit(1);
  });
}
