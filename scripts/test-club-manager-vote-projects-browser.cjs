/*
 * Electron regression coverage for the migrated 赛事活动 tab.  The fixture
 * deliberately exposes the same endpoint families as the production page so
 * this test checks the React view, club scoping, URL-selected tab and the
 * responsive workbench without touching a real account or database.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;

const projectRoot = path.resolve(__dirname, '..');
const baseUrlFromEnv = process.env.CLUB_MANAGER_BROWSER_BASE_URL || '';
if (app?.on) app.on('window-all-closed', (event) => event.preventDefault());

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'narrow-mobile', width: 360, height: 800 },
  { name: 'screenshot', width: 582, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1366, height: 900 },
];

const PROJECT = {
  id: 501,
  club_id: 1,
  country: 'china',
  project_type: 'moe',
  title: '浏览器 fixture 萌战',
  year_label: '2026',
  status: 'running',
  visibility: 'public',
  eligibility_mode: 'club_member',
  result_visibility: 'live_rank_only',
  guest_vote: 1,
  description: '用于赛事活动浏览器回归的确定性活动。',
  can_manage: true,
};

const STAGES = [
  { id: 10, project_id: 501, stage_type: 'nomination', title: '提名', status: 'settled', vote_mode: 'nomination', advance_count: 16, group_count: 1, max_select: 3, score_min: 1, score_max: 10, result_visibility: 'live_rank_only', ends_at: '2026-09-10 23:59:59', config_json: '{}' },
  { id: 11, project_id: 501, stage_type: 'qualifier', title: '海选', status: 'open', vote_mode: 'multi_select', advance_count: 8, group_count: 2, max_select: 3, score_min: 1, score_max: 10, result_visibility: 'live_rank_only', ends_at: '2026-09-30 23:59:59', config_json: '{}' },
  { id: 13, project_id: 501, stage_type: 'group_vote', title: '分组赛', status: 'locked', vote_mode: 'multi_select', advance_count: 4, group_count: 2, max_select: 2, score_min: 1, score_max: 10, result_visibility: 'after_stage', ends_at: '2026-10-10 23:59:59', config_json: '{"allow_zero_fill":true}' },
  { id: 14, project_id: 501, stage_type: 'bracket', title: '淘汰赛', status: 'open', vote_mode: 'match_single', advance_count: 2, group_count: 1, max_select: 1, score_min: 1, score_max: 10, result_visibility: 'after_stage', ends_at: '2026-10-20 23:59:59', config_json: '{"bracket_size":4,"tie_rule":"manual"}' },
  { id: 12, project_id: 501, stage_type: 'final', title: '决赛', status: 'pending', vote_mode: 'match_single', advance_count: 1, group_count: 1, max_select: 1, score_min: 1, score_max: 10, result_visibility: 'after_event', ends_at: '2026-10-31 23:59:59', config_json: '{"bracket_size":2,"tie_rule":"manual"}' },
];

const ENTRIES = Array.from({ length: 20 }, (_, index) => ({
  id: 701 + index,
  entry_id: 701 + index,
  title_cn: `候选${甲码(index)}`,
  work_title_cn: `fixture 作品 ${index + 1}`,
  entry_status: index === 19 ? 'removed' : 'approved',
  subtitle: index % 3 === 0 ? '来源说明：浏览器 fixture' : '',
  source_note: index % 4 === 0 ? '提名人：测试管理员' : '',
  image_url: index === 0 ? 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="80" height="100"%3E%3Crect width="80" height="100" fill="%236f69c7"/%3E%3C/svg%3E' : '',
}));

function 甲码(index) {
  const chars = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉';
  return chars[index] || `${index + 1}`;
}

const STAGE_ENTRIES = {
  10: ENTRIES.slice(0, 16).map((entry, index) => ({ ...entry, rank: index + 1, votes: 0, group_key: '提名池', seed_no: index + 1, source_rank: index + 1 })),
  11: ENTRIES.slice(0, 12).map((entry, index) => ({ ...entry, rank: index + 1, votes: 12 - index, group_key: index < 6 ? 'A组' : 'B组', seed_no: index + 1, source_rank: index + 1 })),
  13: ENTRIES.slice(0, 8).map((entry, index) => ({ ...entry, rank: index + 1, votes: 9 - (index % 4), group_key: index < 4 ? 'A组' : 'B组', seed_no: index + 1, source_rank: index + 1 })),
  14: ENTRIES.slice(0, 4).map((entry, index) => ({ ...entry, rank: index + 1, votes: 8 - index, group_key: '淘汰赛', seed_no: index + 1, source_rank: index + 1 })),
  12: ENTRIES.slice(0, 2).map((entry, index) => ({ ...entry, rank: index + 1, votes: index === 0 ? 15 : 11, group_key: '冠军赛', seed_no: index + 1, source_rank: index + 1 })),
};

const MATCHES = [
  { id: 801, stage_id: 14, slot_a_entry_id: 701, slot_b_entry_id: 702, status: 'open', slot_a_votes: 5, slot_b_votes: 3, round_no: 1 },
  { id: 802, stage_id: 14, slot_a_entry_id: 703, slot_b_entry_id: 704, status: 'settled', slot_a_votes: 7, slot_b_votes: 7, winner_entry_id: 703, round_no: 1, is_tie: true },
  { id: 803, stage_id: 14, slot_a_entry_id: 701, slot_b_entry_id: null, status: 'pending', slot_a_votes: 0, slot_b_votes: 0, round_no: 2 },
  { id: 804, stage_id: 12, slot_a_entry_id: 701, slot_b_entry_id: 702, status: 'open', slot_a_votes: 8, slot_b_votes: 8, round_no: 1, is_tie: true },
];

const fixture = { requests: [], identity: 'super', flowStatusFails: false, readOnly: false };

function clone(value) { return JSON.parse(JSON.stringify(value)); }

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
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
  });
}

function startFixtureServer() {
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;
    const action = requestUrl.searchParams.get('action') || '';
    if (pathname.startsWith('/api/')) fixture.requests.push({ pathname, action, method: req.method });

    if (pathname === '/api/auth.php') return json(res, { logged_in: true, user: { id: 1, username: 'fixture-admin', role: 'super_admin' }, memberships: [{ club_id: 1, country: 'china', role: 'representative', status: 'active' }, { club_id: 2, country: 'china', role: 'representative', status: 'active' }] });
    if (pathname === '/api/clubs.php') return json(res, { data: [{ id: 1, name: '测试同好会', school: '测试学校', country: 'china' }, { id: 2, name: '第二同好会', school: '第二学校', country: 'china' }] });
    if (pathname === '/api/clubs_japan.php') return json(res, { data: [{ id: 1, name: '日本测试同好会', school: '日本学校', country: 'japan' }] });
    if (pathname === '/api/membership.php' && action === 'pending') return json(res, { success: true, memberships: [] });
    if (pathname === '/api/membership.php' && action === 'members') return json(res, { success: true, members: [] });

    if (pathname === '/api/vote_projects.php') {
      if (action === 'my_manageable') return json(res, { success: true, data: [clone(PROJECT)] });
      if (action === 'get') return json(res, { success: true, can_manage: !fixture.readOnly, data: { ...clone(PROJECT), can_manage: !fixture.readOnly }, stages: clone(STAGES) });
      if (action === 'share') return json(res, { success: true, share_token: 'fixture-share', guest_vote: 1, status: 'running' });
      if (req.method === 'POST') {
        await readJsonBody(req);
        return json(res, { success: true, data: clone(PROJECT) });
      }
      return json(res, { success: true, data: [] });
    }
    if (pathname === '/api/vote_nominations.php') {
      if (action === 'list') return json(res, { success: true, data: clone(ENTRIES) });
      return json(res, { success: true });
    }
    if (pathname === '/api/vote_matches.php') {
      if (action === 'list') return json(res, { success: true, data: clone(MATCHES) });
      return json(res, { success: true });
    }
    if (pathname === '/api/vote_stages.php') {
      if (action === 'flow_status') {
        if (fixture.flowStatusFails) return json(res, { success: false, message: '阶段不存在' }, 404);
        return json(res, { success: true, pools: [
          { id: 901, project_id: 501, stage_id: 11, status: 'open', entry_count: 12, vote_count: 72, match_count: 0, result_count: 0, runtime: {} },
          { id: 902, project_id: 501, stage_id: 13, status: 'settled', entry_count: 8, vote_count: 48, match_count: 0, result_count: 8, runtime: { tie_breaks: [] } },
          { id: 903, project_id: 501, stage_id: 14, status: 'open', entry_count: 4, vote_count: 30, match_count: 3, result_count: 1, runtime: {} },
          { id: 904, project_id: 501, stage_id: 12, status: 'pending', entry_count: 2, vote_count: 16, match_count: 1, result_count: 0, runtime: {} },
        ] });
      }
      if (action === 'stage_entries') return json(res, { success: true, data: clone(STAGE_ENTRIES[Number(requestUrl.searchParams.get('stage_id'))] || ENTRIES) });
      return json(res, { success: true });
    }
    if (pathname === '/api/vote_votes.php') return json(res, { success: true, data: [{ entry_id: 701, title_cn: '候选甲', rank_no: 1, votes: 15, score_avg: 9.2, source_id: 701 }, { entry_id: 702, title_cn: '候选乙', rank_no: 2, votes: 11, score_avg: 8.5, source_id: 702 }] });
    if (pathname === '/api/club_moe_king.php') return json(res, { success: true, data: null });
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

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(win, expression, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await win.webContents.executeJavaScript(expression)) return true;
    await wait(100);
  }
  return false;
}

async function inspect(win) {
  return win.webContents.executeJavaScript(`(() => {
    const root = document.documentElement;
    const menu = [...document.querySelectorAll('.cm-nav-wrap .ant-menu-item')];
    const selected = document.querySelector('.cm-nav-wrap .ant-menu-item-selected');
    return {
      url: location.href,
      hasPage: Boolean(document.querySelector('.cm-vote-page')),
      body: document.body.innerText,
      overflow: root.scrollWidth > innerWidth + 1,
      broken: [...document.images].filter((image) => !image.complete || image.naturalWidth === 0).length,
      selected: selected?.innerText?.trim() || '',
      menu: menu.map((item) => item.innerText.trim()),
      tabCount: document.querySelectorAll('.cm-vote-tabs .ant-tabs-tab').length,
    };
  })()`);
}

async function runViewport(baseUrl, viewport) {
  fixture.requests = [];
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: viewport.width,
    height: viewport.height,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const consoleErrors = [];
  const onConsole = (_event, level, message) => { if (level >= 2 && !message.includes('Electron Security Warning')) consoleErrors.push(message); };
  win.webContents.on('console-message', onConsole);
  try {
    await win.loadURL(`${baseUrl}/admin/club_manager.html?tab=vote_projects&vote_projects_test=1`);
    const booted = await waitFor(win, `Boolean(document.querySelector('.cm-vote-page'))`);
    if (!booted) {
      const diagnostic = await win.webContents.executeJavaScript(`({ url: location.href, body: document.body.innerText.slice(0, 600), html: document.body.innerHTML.slice(0, 600) })`);
      throw new Error(`${viewport.name}: 赛事活动页未加载 (${JSON.stringify(diagnostic)}; requests=${JSON.stringify(fixture.requests)}; console=${consoleErrors.join(' | ')})`);
    }
    await wait(250);
    if (viewport.width <= 768) {
      const hasToggle = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.cm-menu-toggle'))`);
      if (hasToggle) {
        await win.webContents.executeJavaScript(`document.querySelector('.cm-menu-toggle')?.click()`);
        assert.equal(await waitFor(win, `Boolean(document.querySelector('.ant-drawer-content'))`), true, `${viewport.name}: mobile drawer did not open`);
      }
    }
    let state = await inspect(win);
    assert.equal(state.hasPage, true, `${viewport.name}: missing vote-project page`);
    assert.match(state.body, /浏览器 fixture 萌战/, `${viewport.name}: fixture project missing`);
    assert.match(state.body, /赛事活动/, `${viewport.name}: tab label missing`);
    assert.match(state.selected, /赛事活动/, `${viewport.name}: sidebar active state missing`);
    assert.ok(state.menu.some((label) => label.includes('企划枢纽')), `${viewport.name}: generic project hub disappeared`);
    assert.equal(state.overflow, false, `${viewport.name}: horizontal overflow`);
    assert.equal(state.broken, 0, `${viewport.name}: broken image`);
    assert.equal(state.tabCount, 3, `${viewport.name}: hybrid vote detail tabs missing`);

    await win.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll('button')].find((node) => node.innerText.includes('新建赛事活动')); button?.click(); })()`);
    assert.equal(await waitFor(win, `Boolean(document.querySelector('.cm-vote-inline-form'))`), true, `${viewport.name}: inline create form did not open`);
    await win.webContents.executeJavaScript(`(() => { const moe = [...document.querySelectorAll('.cm-vote-type-switch button')].find((node) => node.innerText.includes('萌战')); moe?.click(); const twelve = [...document.querySelectorAll('.cm-vote-type-switch button')].find((node) => node.innerText.includes('十二器')); twelve?.click(); const input = document.querySelector('input[aria-label="十二器名称后缀"]'); if (input) { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '秋季篇'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
    assert.equal(await waitFor(win, `document.querySelector('.cm-vote-inline-form')?.innerText.includes('秋季篇')`), true, `${viewport.name}: twelve-weapon suffix preview did not update`);
    await win.webContents.executeJavaScript(`(() => { const selector = document.querySelectorAll('.cm-vote-inline-form .ant-select-selector')[0]; selector?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); })()`);
    const selectorState = await win.webContents.executeJavaScript(`({ body: document.body.innerText.slice(-800), selects: document.querySelectorAll('.cm-vote-inline-form .ant-select').length, form: document.querySelector('.cm-vote-inline-form')?.innerText || '' })`);
    assert.equal(await waitFor(win, `document.body.innerText.includes('第二同好会')`), true, `${viewport.name}: club selector options did not open (${JSON.stringify(selectorState)})`);
    await win.webContents.executeJavaScript(`(() => { const option = [...document.querySelectorAll('.ant-select-item-option')].find((node) => node.innerText.includes('第二同好会')); option?.click(); })()`);
    assert.equal(await waitFor(win, `document.querySelectorAll('.cm-vote-inline-form .ant-select-selector')[0]?.innerText.includes('第二同好会')`), true, `${viewport.name}: club association selection did not update`);
    await win.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll('.cm-vote-inline-form button')].find((node) => node.innerText.includes('收起新建')); button?.click(); })()`);
    assert.equal(await waitFor(win, `!document.querySelector('.cm-vote-inline-form')`), true, `${viewport.name}: inline create form did not close`);

    await win.webContents.executeJavaScript(`(() => { const item = [...document.querySelectorAll('.cm-vote-tabs .ant-tabs-tab')].find((node) => node.innerText.includes('赛程工作台')); item?.click(); })()`);
    assert.equal(await waitFor(win, `document.body.innerText.includes('赛程流水线')`), true, `${viewport.name}: workbench did not open`);
    assert.match((await inspect(win)).body, /提名池/, `${viewport.name}: nomination pool missing`);
    assert.match((await inspect(win)).body, /全选有效候选/, `${viewport.name}: batch nomination controls missing`);
    assert.match((await inspect(win)).body, /每页 16 项/, `${viewport.name}: nomination pagination affordance missing`);
    await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('.cm-vote-pool-search input'); if (input) { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '候选甲'); input.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
    assert.equal(await waitFor(win, `document.querySelector('.cm-vote-candidate-grid')?.innerText.includes('候选甲')`), true, `${viewport.name}: nomination search did not filter`);
    await win.webContents.executeJavaScript(`(() => { const item = [...document.querySelectorAll('.cm-vote-pipeline-step')].find((node) => node.innerText.includes('决赛')); item?.click(); })()`);
    assert.equal(await waitFor(win, `document.body.innerText.includes('对阵工作台')`), true, `${viewport.name}: final match workbench did not open`);
    assert.match((await inspect(win)).body, /缺槽|平票/, `${viewport.name}: match warnings missing`);
    await win.webContents.executeJavaScript(`(() => { const share = [...document.querySelectorAll('.cm-vote-detail-head button')].find((node) => node.innerText.includes('分享')); share?.click(); })()`);
    assert.equal(await waitFor(win, `Boolean(document.querySelector('img[alt="活动分享二维码"]'))`), true, `${viewport.name}: share QR area did not open`);
    await win.webContents.executeJavaScript(`document.querySelector('.ant-modal-close')?.click()`);

    await win.webContents.executeJavaScript(`(() => { const item = [...document.querySelectorAll('.cm-vote-tabs .ant-tabs-tab')].find((node) => node.innerText.includes('概览与设置')); item?.click(); })()`);
    assert.equal(await waitFor(win, `document.body.innerText.includes('概览与设置')`), true, `${viewport.name}: overview did not return`);
    await win.webContents.executeJavaScript(`(() => { const item = [...document.querySelectorAll('.cm-vote-tabs .ant-tabs-tab')].find((node) => node.innerText.includes('结果与奖项')); item?.click(); })()`);
    assert.equal(await waitFor(win, `document.body.innerText.includes('读取决赛结果')`), true, `${viewport.name}: awards tab did not open`);

    assert.equal(consoleErrors.length, 0, `${viewport.name}: console errors: ${consoleErrors.join(' | ')}`);
    console.log(`OK ${viewport.name} ${viewport.width}px requests=${fixture.requests.length}`);
  } finally {
    win.webContents.removeListener('console-message', onConsole);
    await win.close();
  }
}

async function runReadOnly(baseUrl) {
  const win = new BrowserWindow({ show: false, useContentSize: true, width: 768, height: 900, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const consoleErrors = [];
  const onConsole = (_event, level, text) => { if (level >= 2 && !text.includes('Electron Security Warning')) consoleErrors.push(text); };
  win.webContents.on('console-message', onConsole);
  try {
    await win.loadURL(`${baseUrl}/admin/club_manager.html?tab=vote_projects&vote_projects_test=readonly`);
    assert.equal(await waitFor(win, `Boolean(document.querySelector('.cm-vote-page'))`), true, 'readonly: page did not load');
    await wait(250);
    assert.equal(await win.webContents.executeJavaScript(`Boolean([...document.querySelectorAll('.cm-vote-detail-head button')].find((node) => node.innerText.includes('设置'))?.disabled)`), true, 'readonly: settings action was not disabled');
    assert.equal(await win.webContents.executeJavaScript(`Boolean([...document.querySelectorAll('.cm-vote-detail-head button')].find((node) => node.innerText.includes('分享'))?.disabled)`), true, 'readonly: share action was not disabled');
    await win.webContents.executeJavaScript(`(() => { const item = [...document.querySelectorAll('.cm-vote-tabs .ant-tabs-tab')].find((node) => node.innerText.includes('赛程工作台')); item?.click(); })()`);
    assert.equal(await waitFor(win, `Boolean(document.querySelector('.cm-vote-stage-actions'))`), true, 'readonly: stage workbench did not open');
    assert.equal(await win.webContents.executeJavaScript(`Boolean(document.querySelector('.cm-vote-stage-actions .ant-btn')?.disabled)`), true, 'readonly: stage configuration action was not disabled');
    assert.equal(consoleErrors.length, 0, `readonly: console errors: ${consoleErrors.join(' | ')}`);
    console.log('OK read-only 768px');
  } finally {
    win.webContents.removeListener('console-message', onConsole);
    await win.close();
  }
}

app.whenReady().then(async () => {
  let server;
  try {
    let baseUrl = baseUrlFromEnv;
    if (!baseUrl) {
      server = await startFixtureServer();
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
    }
    const requested = process.argv.includes('--all-viewports') ? viewports : [viewports[0]];
    for (const viewport of requested) await runViewport(baseUrl, viewport);
    // Production has previously returned 404 "阶段不存在" for flow_status
    // while the base activity endpoint was healthy. It must remain usable.
    fixture.flowStatusFails = true;
    await runViewport(baseUrl, { name: 'degraded-flow', width: 390, height: 844 });
    fixture.flowStatusFails = false;
    fixture.readOnly = true;
    await runReadOnly(baseUrl);
    fixture.readOnly = false;
    server?.close();
    app.quit();
  } catch (error) {
    console.error(error.stack || error.message);
    server?.close();
    app.exit(1);
  }
});
