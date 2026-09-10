const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const repoRoot = path.resolve(__dirname, '..');
const projectId = '7001';
const emptyNominationsProjectId = '7002';
const viewportSizes = [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'mobile-360', width: 360, height: 780 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1366', width: 1366, height: 900 },
];

const stages = [
  { id: 701, project_id: 7001, stage_type: 'nomination', status: 'open', max_select: 3, starts_at: null, ends_at: '2026-09-11 22:59:00' },
  { id: 702, project_id: 7001, stage_type: 'qualifier', status: 'settled', max_select: 1, starts_at: '2026-09-12 00:00:00', ends_at: '2026-09-13 22:59:00' },
  { id: 703, project_id: 7001, stage_type: 'bracket', status: 'pending', max_select: 1, starts_at: '2026-09-14 00:00:00', ends_at: '2026-09-15 22:59:00' },
  { id: 704, project_id: 7001, stage_type: 'final', status: 'pending', max_select: 1, starts_at: '2026-09-16 00:00:00', ends_at: '2026-09-17 22:59:00' },
];

const candidates = [
  { id: 101, title: 'My Character', title_cn: '我的角色', subtitle: 'Fixture Work', image_url: '' },
  { id: 102, title: 'Other Character', title_cn: '普通角色', subtitle: 'Another Work', image_url: '' },
];

let withdrawRequests = [];

function json(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const action = url.searchParams.get('action') || '';

  if (url.pathname.endsWith('/moe_contests.php') && action === 'get') {
    const requestedProjectId = url.searchParams.get('project_id') || projectId;
    return json(res, {
      success: true,
      authenticated: true,
      can_participate: true,
      guest_vote_enabled: false,
      share_valid: false,
      data: {
        id: Number(requestedProjectId),
        project_type: 'moe',
        title: '浏览器 Fixture 萌战',
        club_id: null,
        country: 'china',
        status: 'running',
        published_at: '2026-09-03 07:03:36',
        created_at: '2026-09-02 12:00:00',
      },
    });
  }

  if (url.pathname.endsWith('/moe_stages.php') && action === 'list') {
    return json(res, { success: true, data: stages });
  }

  if (url.pathname.endsWith('/clubs.php') || url.pathname.endsWith('/clubs_japan.php')) {
    return json(res, { success: true, data: [] });
  }

  if (url.pathname.endsWith('/moe_candidates.php')) {
    if (req.method === 'POST' && action === 'withdraw_nomination') {
      const raw = await readRequestBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      withdrawRequests.push(Number(payload.entry_id));
      return json(res, { success: true, message: 'fixture withdrawn' });
    }
    if (action === 'my_nominations') {
      const isEmpty = url.searchParams.get('contest_id') === emptyNominationsProjectId;
      return json(res, { success: true, data: isEmpty ? [] : [{ entry_id: '101', status: 'active' }] });
    }
    if (action === 'list') {
      return json(res, { success: true, data: candidates });
    }
  }

  if (url.pathname.endsWith('/vote_sources.php') && action === 'search') {
    const keyword = (url.searchParams.get('keyword') || '').toLowerCase();
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (keyword === 'fixture') {
      return json(res, {
        success: true,
        data: [{ id: 's-1', title: 'Search Character', title_cn: '搜索角色', subtitle: 'Search Work', source_type: 'bangumi_character', image_url: '' }],
      });
    }
    return json(res, { success: true, data: [] });
  }

  if (url.pathname.endsWith('/moe_votes.php')) {
    return json(res, { success: true, data: [], match_results: [] });
  }

  return json(res, { success: true, data: [] });
}

function createFixtureServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }

      const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html';
      const filePath = path.resolve(repoRoot, relativePath);
      if (filePath !== repoRoot && !filePath.startsWith(repoRoot + path.sep)) {
        json(res, { success: false, message: 'forbidden' }, 403);
        return;
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const contentTypes = {
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
      };
      res.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error && error.message || error));
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDetail(win, requireMine = true) {
  await win.webContents.executeJavaScript(`
    (async () => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (document.querySelector('#mdNomSelectBtn') && ${requireMine ? 'document.querySelector(\'[data-entry-id="101"]\')' : 'document.querySelector(\'#mdNomGrid .md-char-item\')'}) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    })()
  `).then((ready) => assert.equal(ready, true, 'fixture nomination page should finish loading'));
}

async function inspectEmptyNominations(baseUrl) {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    width: 390,
    height: 844,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) consoleErrors.push(message);
  });
  try {
    await win.loadURL(`${baseUrl}/moe/contest.html?id=${emptyNominationsProjectId}`, { userAgent: 'VNFmapMoeFixture/1.0' });
    await waitForDetail(win, false);
    const result = await win.webContents.executeJavaScript(`
      (() => {
        const button = document.querySelector('#mdNomSelectBtn');
        button.click();
        const grid = document.querySelector('#mdNomGrid');
        return {
          buttonText: button.textContent,
          pressed: button.getAttribute('aria-pressed'),
          message: grid.textContent.trim(),
          selectableCount: grid.querySelectorAll('[data-selectable="true"]').length,
          barVisible: getComputedStyle(document.querySelector('#mdSelectBar')).display !== 'none',
        };
      })()
    `);
    assert.equal(result.buttonText, '取消选择', 'empty nomination fixture should enter selection mode');
    assert.equal(result.pressed, 'true', 'empty nomination fixture should update aria-pressed');
    assert.equal(result.message, '暂无本人提名可选择', 'empty nomination fixture should explain that there is nothing to withdraw');
    assert.equal(result.selectableCount, 0, 'empty nomination fixture should not mark ordinary candidates as selectable');
    assert.equal(result.barVisible, true, 'empty nomination fixture should still show the selection toolbar');
    assert.equal(consoleErrors.length, 0, `empty nomination fixture should not log console errors: ${consoleErrors.join('; ')}`);
  } finally {
    win.destroy();
  }
}

async function inspectViewport(baseUrl, viewport) {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    width: viewport.width,
    height: viewport.height,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) consoleErrors.push(message);
  });

  try {
    await win.loadURL(`${baseUrl}/moe/contest.html?id=${projectId}`, { userAgent: 'VNFmapMoeFixture/1.0' });
    await waitForDetail(win);
    const withdrawalsBefore = withdrawRequests.length;
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const qs = (selector) => document.querySelector(selector);
        const rect = (selector) => {
          const node = qs(selector);
          const box = node && node.getBoundingClientRect();
          return box ? { width: box.width, height: box.height } : null;
        };
        const layout = {
          launch: qs('#mdInfoLaunch') && qs('#mdInfoLaunch').textContent,
          stageStart: qs('#mdInfoStart') && qs('#mdInfoStart').textContent,
          stageCount: document.querySelectorAll('#mdStageList > .md-stage-step').length,
          chipCount: document.querySelectorAll('#mdStageList > .md-stage-step > .md-stage-chip').length,
          activeAria: qs('#mdStageList .md-stage-chip[aria-current="step"]') && qs('#mdStageList .md-stage-chip[aria-current="step"]').textContent,
          bodyOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
          stageOverflow: qs('#mdStageNav') ? qs('#mdStageNav').scrollWidth - qs('#mdStageNav').clientWidth : 0,
          searchRow: rect('#mdNomSearch'),
          searchButton: rect('#mdNomBtn'),
        };

        const stageButtons = Array.from(document.querySelectorAll('#mdStageList .md-stage-chip'));
        stageButtons[1].click();
        await sleep(40);
        const settledStage = {
          active: qs('#mdStageList .md-stage-chip[aria-current="step"]') && qs('#mdStageList .md-stage-chip[aria-current="step"]').textContent,
          info: qs('#mdInfoStage') && qs('#mdInfoStage').textContent,
          start: qs('#mdInfoStart') && qs('#mdInfoStart').textContent,
        };
        stageButtons[2].click();
        await sleep(20);
        const pendingStage = {
          active: qs('#mdStageList .md-stage-chip[aria-current="step"]') && qs('#mdStageList .md-stage-chip[aria-current="step"]').textContent,
          info: qs('#mdInfoStage') && qs('#mdInfoStage').textContent,
          start: qs('#mdInfoStart') && qs('#mdInfoStart').textContent,
        };
        stageButtons[0].click();
        const nominationDeadline = Date.now() + 1500;
        while (Date.now() < nominationDeadline && !qs('[data-entry-id="101"]')) await sleep(30);

        qs('#mdNomSelectBtn').click();
        const selectState = {
          buttonText: qs('#mdNomSelectBtn').textContent,
          pressed: qs('#mdNomSelectBtn').getAttribute('aria-pressed'),
          barVisible: getComputedStyle(qs('#mdSelectBar')).display !== 'none',
          mineSelectable: qs('[data-entry-id="101"]') && qs('[data-entry-id="101"]').getAttribute('data-selectable'),
          mineRole: qs('[data-entry-id="101"]') && qs('[data-entry-id="101"]').getAttribute('role'),
          mineTabIndex: qs('[data-entry-id="101"]') && qs('[data-entry-id="101"]').getAttribute('tabindex'),
          otherPointerEvents: getComputedStyle(qs('[data-entry-id="101"]').nextElementSibling).pointerEvents,
          otherOpacity: Number.parseFloat(getComputedStyle(qs('[data-entry-id="101"]').nextElementSibling).opacity),
        };
        const mine = qs('[data-entry-id="101"]');
        mine.click();
        const selectedByClick = { count: qs('#mdSelectHint').textContent, aria: mine.getAttribute('aria-selected'), checked: mine.classList.contains('md-char-item--checked') };
        mine.click();
        mine.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const selectedByEnter = { count: qs('#mdSelectHint').textContent, aria: mine.getAttribute('aria-selected') };
        mine.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        const deselectedBySpace = { count: qs('#mdSelectHint').textContent, aria: mine.getAttribute('aria-selected') };

        // Verify that a non-owned card cannot join the withdrawal set even if a synthetic click is dispatched.
        qs('[data-entry-id="101"]').nextElementSibling.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const nonMineIgnored = qs('#mdSelectHint').textContent;

        // Select the owned card again and exercise the existing per-entry withdrawal endpoint.
        mine.click();
        window.confirm = () => true;
        qs('#mdSelectDelete').click();
        await sleep(350);
        const withdrawState = {
          buttonText: qs('#mdNomSelectBtn').textContent,
          barVisible: getComputedStyle(qs('#mdSelectBar')).display !== 'none',
        };

        async function search(keyword) {
          const input = qs('#mdNomSearch');
          const button = qs('#mdNomBtn');
          input.value = keyword;
          const before = { row: rect('#mdNomSearch').height, button: rect('#mdNomBtn').height, input: rect('#mdNomSearch').height };
          button.click();
          const during = {
            row: rect('#mdNomSearch').height,
            button: rect('#mdNomBtn').height,
            input: rect('#mdNomSearch').height,
            hasSpinner: Boolean(qs('#mdNomBtn .md-inline-spinner')),
            ariaBusy: qs('#mdNomBtn').getAttribute('aria-busy'),
          };
          await sleep(260);
          return {
            before,
            during,
            after: { row: rect('#mdNomSearch').height, button: rect('#mdNomBtn').height, input: rect('#mdNomSearch').height, disabled: button.disabled, ariaBusy: button.getAttribute('aria-busy') },
            message: qs('#mdNomGrid').textContent.trim(),
          };
        }
        const searchSuccess = await search('fixture');
        const searchEmpty = await search('none');
        const originalFetch = window.fetch;
        window.fetch = (url, options) => String(url).includes('vote_sources.php')
          ? Promise.reject(new Error('fixture search failure'))
          : originalFetch(url, options);
        const searchFailure = await search('fail');
        window.fetch = originalFetch;

        const stageNavigation = {
          settled: settledStage,
          pending: pendingStage,
          nomination: {
            active: qs('#mdStageList .md-stage-chip[aria-current="step"]') && qs('#mdStageList .md-stage-chip[aria-current="step"]').textContent,
            info: qs('#mdInfoStage') && qs('#mdInfoStage').textContent,
            start: qs('#mdInfoStart') && qs('#mdInfoStart').textContent,
          },
        };
        return { layout, stageNavigation, selectState, selectedByClick, selectedByEnter, deselectedBySpace, nonMineIgnored, withdrawState, searchSuccess, searchEmpty, searchFailure };
      })()
    `);

    assert.equal(result.layout.launch, '2026/09/03 07:03', `${viewport.name}: activity launch time should use published_at`);
    assert.equal(result.layout.stageStart, '-', `${viewport.name}: null stage starts_at should remain '-'`);
    assert.equal(result.layout.stageCount, 4, `${viewport.name}: should render four stage steps`);
    assert.equal(result.layout.chipCount, 4, `${viewport.name}: should render four stage buttons`);
    assert.equal(result.layout.activeAria, '提名阶段', `${viewport.name}: nomination should be the active ARIA step`);
    assert.equal(result.stageNavigation.settled.active, '资格赛', `${viewport.name}: settled stage button should become active when clicked`);
    assert.equal(result.stageNavigation.settled.info, '资格赛', `${viewport.name}: settled stage info should follow the clicked stage`);
    assert.equal(result.stageNavigation.settled.start, '2026/09/12 00:00', `${viewport.name}: stage start should update for the clicked settled stage`);
    assert.equal(result.stageNavigation.pending.active, '淘汰赛', `${viewport.name}: pending stage button should become active when clicked`);
    assert.equal(result.stageNavigation.pending.info, '淘汰赛', `${viewport.name}: pending stage info should follow the clicked stage`);
    assert.equal(result.stageNavigation.pending.start, '2026/09/14 00:00', `${viewport.name}: stage start should update for the clicked pending stage`);
    assert.equal(result.stageNavigation.nomination.active, '提名阶段', `${viewport.name}: nomination stage should remain reachable after stage navigation`);
    assert.equal(result.stageNavigation.nomination.start, '-', `${viewport.name}: returning to nomination should restore its empty stage start`);
    assert.ok(result.layout.bodyOverflow <= 1, `${viewport.name}: page should not horizontally overflow (${result.layout.bodyOverflow}px)`);
    assert.ok(result.selectState.buttonText.includes('取消选择'), `${viewport.name}: select mode should change button label`);
    assert.equal(result.selectState.pressed, 'true', `${viewport.name}: select mode should set aria-pressed`);
    assert.equal(result.selectState.barVisible, true, `${viewport.name}: select bar should be visible`);
    assert.equal(result.selectState.mineSelectable, 'true', `${viewport.name}: owned card should be selectable`);
    assert.equal(result.selectState.mineRole, 'button', `${viewport.name}: owned card should be keyboard-usable`);
    assert.equal(result.selectState.mineTabIndex, '0', `${viewport.name}: owned card should be focusable`);
    assert.equal(result.selectState.otherPointerEvents, 'none', `${viewport.name}: non-owned card should be disabled in select mode`);
    assert.ok(result.selectState.otherOpacity < 0.5, `${viewport.name}: non-owned card should be visually weakened`);
    assert.equal(result.selectedByClick.count, '已选 1 个', `${viewport.name}: click should select one owned card`);
    assert.equal(result.selectedByClick.aria, 'true', `${viewport.name}: click should update aria-selected`);
    assert.equal(result.selectedByClick.checked, true, `${viewport.name}: click should add checked styling`);
    assert.equal(result.selectedByEnter.count, '已选 1 个', `${viewport.name}: Enter should select one owned card`);
    assert.equal(result.deselectedBySpace.count, '已选 0 个', `${viewport.name}: Space should deselect the card`);
    assert.equal(result.nonMineIgnored, '已选 0 个', `${viewport.name}: non-owned card should not be added`);
    assert.deepEqual(withdrawRequests.slice(withdrawalsBefore), [101], `${viewport.name}: batch withdrawal should submit only the selected entry_id`);
    assert.equal(result.withdrawState.buttonText, '选择模式', `${viewport.name}: withdrawal should leave select mode`);
    assert.equal(result.withdrawState.barVisible, false, `${viewport.name}: withdrawal should hide select bar`);

    for (const [label, searchResult] of Object.entries({ success: result.searchSuccess, empty: result.searchEmpty, failure: result.searchFailure })) {
      assert.ok(Math.abs(searchResult.during.row - searchResult.before.row) <= 1, `${viewport.name}/${label}: search row height changed while loading`);
      assert.ok(Math.abs(searchResult.during.button - searchResult.before.button) <= 1, `${viewport.name}/${label}: search button grew while loading`);
      assert.ok(Math.abs(searchResult.during.input - searchResult.before.input) <= 1, `${viewport.name}/${label}: search input grew while loading`);
      assert.equal(searchResult.during.hasSpinner, true, `${viewport.name}/${label}: inline spinner should be present`);
      assert.equal(searchResult.during.ariaBusy, 'true', `${viewport.name}/${label}: search button should expose aria-busy`);
      assert.ok(Math.abs(searchResult.after.row - searchResult.before.row) <= 1, `${viewport.name}/${label}: search row height should recover`);
      assert.ok(Math.abs(searchResult.after.button - searchResult.before.button) <= 1, `${viewport.name}/${label}: search button height should recover`);
      assert.ok(Math.abs(searchResult.after.input - searchResult.before.input) <= 1, `${viewport.name}/${label}: search input height should recover`);
      assert.equal(searchResult.after.disabled, false, `${viewport.name}/${label}: search button should recover enabled`);
      assert.equal(searchResult.after.ariaBusy, null, `${viewport.name}/${label}: aria-busy should be cleared`);
    }
    assert.ok(result.searchSuccess.message.includes('搜索角色'), `${viewport.name}: search success should render a result`);
    assert.equal(result.searchEmpty.message, '未找到匹配角色', `${viewport.name}: empty search should render the empty state`);
    assert.equal(result.searchFailure.message, '搜索失败，请重试', `${viewport.name}: rejected search should render the failure state`);
    assert.equal(consoleErrors.length, 0, `${viewport.name}: fixture page should not log console errors: ${consoleErrors.join('; ')}`);

    return { viewport: viewport.name, bodyOverflow: result.layout.bodyOverflow, stageOverflow: result.layout.stageOverflow };
  } finally {
    win.destroy();
  }
}

async function main() {
  const server = createFixtureServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const results = [];

  app.on('window-all-closed', (event) => event.preventDefault());
  try {
    await app.whenReady();
    for (const viewport of viewportSizes) results.push(await inspectViewport(baseUrl, viewport));
    await inspectEmptyNominations(baseUrl);
    assert.deepEqual(withdrawRequests, [101, 101, 101, 101], 'each viewport should exercise one selected-entry withdrawal');
    console.log(`moe detail browser checks passed: ${results.map((item) => `${item.viewport} overflow=${item.bodyOverflow}px`).join(', ')}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await app.quit();
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
