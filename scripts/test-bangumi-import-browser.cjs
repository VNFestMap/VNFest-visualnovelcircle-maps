const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const port = 4174;
const fixtureResume = {
  mode: 'resume',
  profile: {
    name: 'Bangumi 导入测试',
    handle: 'fixture-user',
    accountType: 'bgm',
    works: [{ title: '已存在作品', image: '', source: 'bangumi', id: 'bgm_vn_100', bangumiId: 100 }]
  }
};

const collectionItems = [
  { bangumi_id: 100, title: 'Existing', title_cn: '已存在作品', image: '', source: 'bangumi', collection_type: 2 },
  { bangumi_id: 101, title: 'Imported Game', title_cn: '待导入作品', image: '', source: 'bangumi', collection_type: 2 }
];

function json(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://127.0.0.1:${port}`);
  if (requestUrl.pathname === '/api/auth.php') {
    json(res, {
      logged_in: true,
      user: {
        id: 7,
        username: 'fixture-user',
        nickname: '导入测试账号',
        avatar_url: '',
        bangumi_bound: true,
        bangumi_username: 'fixture-bangumi'
      }
    });
    return;
  }
  if (requestUrl.pathname === '/api/galgame_resume.php') {
    if (req.method === 'GET') {
      json(res, { success: true, resume: fixtureResume });
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      server.lastResume = parsed.resume;
      json(res, { success: true });
    });
    return;
  }
  if (requestUrl.pathname === '/api/bangumi_account.php') {
    if (requestUrl.searchParams.get('action') === 'collections') {
      json(res, {
        success: true,
        items: collectionItems,
        pagination: { limit: 100, offset: 0, total: collectionItems.length, has_more: false }
      });
      return;
    }
    json(res, { success: true, bound: true, account: { user_id: 99, username: 'fixture-bangumi' } });
    return;
  }

  const relative = decodeURIComponent(requestUrl.pathname.replace(/^\//, '')) || 'index.html';
  const filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const extensions = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': extensions[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

function pause(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

app.on('window-all-closed', (event) => event.preventDefault());

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const win = new BrowserWindow({
    show: false,
    width: 390,
    height: 844,
    webPreferences: { contextIsolation: false, sandbox: false, backgroundThrottling: false }
  });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) errors.push(message);
  });

  try {
    await win.loadURL(`http://127.0.0.1:${port}/tools/GalgameTool/index.html?import-check=${Date.now()}`);
    await pause(800);
    const result = await win.webContents.executeJavaScript(`(async () => {
      await openBangumiImportModal();
      await new Promise(resolve => setTimeout(resolve, 250));
      const modal = document.getElementById('bangumiImportModal');
      const mobileMenuAction = document.querySelector('.mobile-tool-action');
      const toolbarImport = document.getElementById('bangumiImportButton');
      const cards = [...document.querySelectorAll('.bangumi-import-card')];
      const existing = cards.find(card => card.textContent.includes('已存在作品'));
      const imported = cards.find(card => card.textContent.includes('待导入作品'));
      const countBefore = document.getElementById('bangumiImportSelectedCount').textContent;
      const modalRect = modal.querySelector('.bangumi-import-modal').getBoundingClientRect();
      const viewport = { width: innerWidth, height: innerHeight };
      document.getElementById('bangumiImportClear')?.click();
      clearBangumiImportSelection();
      const importedCheckbox = imported?.querySelector('input');
      if (importedCheckbox) {
        importedCheckbox.checked = true;
        importedCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.getElementById('bangumiImportConfirm').click();
      await new Promise(resolve => setTimeout(resolve, 1000));
      return {
        cardCount: cards.length,
        existingDisabled: existing?.querySelector('input')?.disabled || false,
        countBefore,
        mobileMenuVisible: getComputedStyle(mobileMenuAction).display !== 'none',
        toolbarImportHidden: getComputedStyle(toolbarImport).display === 'none',
        modalWithinViewport: modalRect.left >= 0 && modalRect.top >= 0 && modalRect.right <= viewport.width + 1 && modalRect.bottom <= viewport.height + 1,
        importedWorks: state.profile.works.map(item => ({ title: item.title, bangumiId: item.bangumiId })),
        modalClosed: !modal.classList.contains('active')
      };
    })()`);

    assert.equal(result.cardCount, 2, 'import preview should render all collection items');
    assert.equal(result.existingDisabled, true, 'existing Bangumi works should be disabled in preview');
    assert.equal(result.countBefore, '1', 'new works should be selected by default');
    assert.equal(result.mobileMenuVisible, true, 'mobile menu should expose Bangumi import');
    assert.equal(result.toolbarImportHidden, true, 'mobile layout should keep the import action in the menu');
    assert.equal(result.modalWithinViewport, true, 'mobile import modal should stay within the viewport');
    assert.deepEqual(result.importedWorks, [
      { title: '已存在作品', bangumiId: 100 },
      { title: '待导入作品', bangumiId: 101 }
    ], 'selected Bangumi work should append while preserving the existing work');
    assert.equal(result.modalClosed, true, 'import modal should close after importing');
    assert.equal(server.lastResume.profile.works[1].bangumiId, 101, 'saved resume should keep bangumiId');
    assert.deepEqual(errors, [], `browser console should stay clean: ${errors.join(' | ')}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    win.destroy();
    server.close();
    app.quit();
  }
}).catch((error) => {
  console.error(error.stack || error);
  server.close();
  app.quit();
  process.exitCode = 1;
});
