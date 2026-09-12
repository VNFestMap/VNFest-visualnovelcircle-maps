/*
 * Electron browser regression suite for the 企划枢纽 (project hub) module of the
 * migrated React club manager (club-manager-react/src/tabs/ProjectsTab.jsx).
 *
 * The suite boots admin/club_manager.html from a throw-away http fixture server,
 * drives the real UI (club selector, sidebar menu, cards, drawer, modal,
 * popconfirm, filters) and asserts both the rendered DOM and the request bodies
 * the tab posts back to the fixture API.
 */
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

const CLUB_SELECTED = '发起同好会';
const CLUB_JOINT = '联合同好会';
const PROJECT_A = '发起企划A';
const PROJECT_A_EDITED = '发起企划A·已改名';
const PROJECT_B = '联合企划B';
const PROJECT_C_DELETED = '已删除企划C';
const ITEM_ACTIVE = '有效子项目';
const ITEM_DELETED = '已删除子项目';
const PARTICIPATION_PENDING = '待审参与者';
const PARTICIPATION_WITHDRAWN = '已撤回参与者';
const PARTICIPATION_JOINT = '联合会申请者';
const NEW_PROJECT_TITLE = '自动化新建的联合企划';
const REVIEW_NOTE = '自动化审核备注：同意联合申请';
const EMPTY_STATE = '当前筛选下没有企划';
const CLUB_PROMPT = '请先在上方选择一个同好会';
const SERVICE_ERROR = '企划服务暂时不可用';

/* ------------------------------------------------------------------ *
 * DOM driving helpers injected into every executeJavaScript() step.  *
 * They are local to each step IIFE: no window globals are created.    *
 * ------------------------------------------------------------------ */
const PAGE_HELPERS = `
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isVisible = (node) => Boolean(node) && getComputedStyle(node).display !== 'none';
  const projectCards = () => Array.from(document.querySelectorAll('.ant-card')).filter((card) => card.querySelector('.ant-card-meta-title'));
  const cardTitles = () => projectCards().map((card) => card.querySelector('.ant-card-meta-title').innerText.trim());
  const cardByText = (needle) => projectCards().find((card) => card.innerText.includes(needle)) || null;
  const visibleDropdown = () => Array.from(document.querySelectorAll('.ant-select-dropdown')).filter((node) => !node.classList.contains('ant-select-dropdown-hidden') && isVisible(node)).at(-1) || null;
  const dropdownOptions = () => { const dropdown = visibleDropdown(); return dropdown ? Array.from(dropdown.querySelectorAll('.ant-select-item-option')).map((node) => node.innerText.trim()) : []; };
  const openSelect = async (select) => { if (!select) throw new Error('select element is missing'); select.querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); await sleep(220); };
  const pickOption = async (needle) => { const dropdown = visibleDropdown(); const option = dropdown ? Array.from(dropdown.querySelectorAll('.ant-select-item-option')).find((node) => node.innerText.includes(needle)) : null; if (!option) throw new Error('select option not found: ' + needle); option.dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(260); };
  const closePopups = async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await sleep(140); };
  const toolbarSelect = (index) => document.querySelectorAll('.cm-toolbar .ant-select')[index] || null;
  const clubSelect = () => document.querySelector('#clubSelector')?.closest('.ant-select') || null;
  const clubSelectText = () => clubSelect()?.innerText.trim() || '';
  const openMenu = async () => { const toggle = document.querySelector('.cm-menu-toggle'); if (toggle) { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(380); } };
  const clickMenuItem = async (label) => { const item = Array.from(document.querySelectorAll('.ant-menu-item')).find((node) => node.innerText.includes(label)); if (!item) throw new Error('sidebar menu item not found: ' + label); item.dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(340); };
  const selectClub = async (needle) => { await openSelect(clubSelect()); await pickOption(needle); };
  const detailDrawer = () => Array.from(document.querySelectorAll('.ant-drawer-content-wrapper')).find((node) => node.innerText.includes('发起组织')) || null;
  const closeDetail = async () => { const drawer = detailDrawer(); const close = drawer?.querySelector('.ant-drawer-close'); if (close) close.dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(360); };
  const openCard = async (needle) => { const card = cardByText(needle); if (!card) throw new Error('project card not found: ' + needle); card.dispatchEvent(new MouseEvent('click', { bubbles: true })); for (let i = 0; i < 40; i += 1) { await sleep(80); if (detailDrawer()) return; } throw new Error('project detail drawer did not open for ' + needle); };
  const visibleModal = () => Array.from(document.querySelectorAll('.ant-modal-wrap')).filter((node) => isVisible(node)).at(-1) || null;
  const formItem = (root, label) => Array.from(root.querySelectorAll('.ant-form-item')).find((node) => node.querySelector('.ant-form-item-label')?.innerText.trim() === label) || null;
  const setInput = (input, value) => { if (!input) throw new Error('input element is missing'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); };
  const buttonByText = (root, label) => root ? Array.from(root.querySelectorAll('button')).find((node) => node.innerText.trim() === label) || null : null;
  const drawerExtraButton = (drawer, label) => { const extra = drawer?.querySelector('.ant-drawer-extra'); return buttonByText(extra, label); };
  const participationRow = (drawer, needle) => drawer ? Array.from(drawer.querySelectorAll('.ant-list-item')).find((node) => node.innerText.includes(needle)) || null : null;
  const statValue = (title) => { const node = Array.from(document.querySelectorAll('.cm-stat-row .ant-statistic')).find((item) => item.querySelector('.ant-statistic-title')?.innerText.trim() === title); if (!node) return null; const raw = node.querySelector('.ant-statistic-content-value')?.innerText || ''; return Number(raw.replace(/[^0-9.-]/g, '')); };
  const kpiValues = () => ({ related: statValue('关联企划'), activity: statValue('活动企划'), pending: statValue('待审核'), joint: statValue('联合企划') });
  const waitForText = async (needle) => { for (let i = 0; i < 50; i += 1) { if (document.body.innerText.includes(needle)) return true; await sleep(80); } return false; };
  const waitForCards = async (count) => { for (let i = 0; i < 50; i += 1) { if (projectCards().length === count) return true; await sleep(80); } return false; };
  const clickRefresh = async () => { const button = document.querySelector('button[aria-label="刷新当前数据"]'); if (!button) throw new Error('topbar refresh button is missing'); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(250); };
`;

/* ------------------------------------------------------------------ *
 * Fixture state.                                                      *
 * ------------------------------------------------------------------ */
let fixtureState;

function fixtureProjectA() {
  return {
    id: 101,
    title: `${PROJECT_A}：同好会联动活动`,
    summary: '由发起同好会组织的活动企划',
    description: '企划 A 的详细说明',
    project_type: 'activity',
    status: 'ongoing',
    calendar_event_id: null,
    organizer_club: { id: 1, country: 'china', name: CLUB_SELECTED },
    participant_clubs: [{ id: 2, country: 'china', name: CLUB_JOINT }],
    event_date: '2026-10-01',
    event_date_end: null,
    deadline: null,
    deleted_at: null,
  };
}

function fixtureProjectB() {
  return {
    id: 102,
    title: `${PROJECT_B}：联合刊物征稿`,
    summary: '由联合同好会组织、发起同好会联合参加',
    description: '企划 B 的详细说明',
    project_type: 'publication',
    status: 'collecting',
    calendar_event_id: null,
    organizer_club: { id: 2, country: 'china', name: CLUB_JOINT },
    participant_clubs: [{ id: 1, country: 'china', name: CLUB_SELECTED }],
    event_date: null,
    event_date_end: null,
    deadline: '2026-11-20',
    deleted_at: null,
  };
}

function fixtureProjectCDeleted() {
  return {
    id: 103,
    title: `${PROJECT_C_DELETED}：不应渲染`,
    summary: '软删除企划',
    description: '',
    project_type: 'activity',
    status: 'ongoing',
    calendar_event_id: null,
    organizer_club: { id: 1, country: 'china', name: CLUB_SELECTED },
    participant_clubs: [{ id: 2, country: 'china', name: CLUB_JOINT }],
    event_date: '2026-08-01',
    event_date_end: null,
    deadline: null,
    deleted_at: '2026-09-01 10:00:00',
  };
}

function resetFixtureState() {
  fixtureState = {
    nextId: 900,
    projectsFail: false,
    noRelatedProjects: false,
    requests: [],
    projects: [fixtureProjectA(), fixtureProjectB(), fixtureProjectCDeleted()],
    items: [
      {
        id: 201,
        project_id: 101,
        label: `${ITEM_ACTIVE}：投稿征集`,
        type: 'submission',
        status: 'open',
        deadline: null,
        deleted_at: null,
      },
      {
        id: 202,
        project_id: 101,
        label: `${ITEM_DELETED}：不应渲染`,
        type: 'submission',
        status: 'open',
        deadline: null,
        deleted_at: '2026-09-02 10:00:00',
      },
    ],
    participations: [
      {
        id: 301,
        project_id: 101,
        status: 'submitted',
        display_name: PARTICIPATION_PENDING,
        participant_type: 'individual',
        created_at: '2026-09-03 10:00:00',
      },
      {
        id: 302,
        project_id: 101,
        status: 'withdrawn',
        display_name: PARTICIPATION_WITHDRAWN,
        participant_type: 'individual',
        created_at: '2026-09-03 11:00:00',
      },
      {
        id: 303,
        project_id: 102,
        status: 'submitted',
        display_name: PARTICIPATION_JOINT,
        participant_type: 'individual',
        created_at: '2026-09-04 09:00:00',
      },
    ],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/* Only the unaffected project survives so the tab has to render its empty state. */
function unrelatedProjects() {
  return [{
    id: 199,
    title: '无关企划：其他同好会',
    summary: '',
    description: '',
    project_type: 'activity',
    status: 'ongoing',
    calendar_event_id: null,
    organizer_club: { id: 9, country: 'china', name: '其他同好会' },
    participant_clubs: [],
    event_date: null,
    event_date_end: null,
    deadline: null,
    deleted_at: null,
  }];
}

function applyProjectMutation(body) {
  const method = String(body.ph_method || 'POST').toUpperCase();
  if (method === 'DELETE') {
    fixtureState.projects = fixtureState.projects.filter((project) => Number(project.id) !== Number(body.id));
    fixtureState.items = fixtureState.items.filter((item) => Number(item.project_id) !== Number(body.id));
    fixtureState.participations = fixtureState.participations.filter((entry) => Number(entry.project_id) !== Number(body.id));
    return;
  }
  if (method === 'PUT') {
    const target = fixtureState.projects.find((project) => Number(project.id) === Number(body.id));
    if (target) Object.assign(target, body);
    return;
  }
  fixtureState.projects.push({ deleted_at: null, ...body, id: fixtureState.nextId });
  fixtureState.nextId += 1;
}

function applyItemMutation(body) {
  const method = String(body.ph_method || 'POST').toUpperCase();
  if (method === 'DELETE') {
    fixtureState.items = fixtureState.items.filter((item) => Number(item.id) !== Number(body.id));
    return;
  }
  if (method === 'PUT') {
    const target = fixtureState.items.find((item) => Number(item.id) === Number(body.id));
    if (target) Object.assign(target, body);
    return;
  }
  fixtureState.items.push({ deleted_at: null, ...body, id: fixtureState.nextId });
  fixtureState.nextId += 1;
}

function applyParticipationMutation(body) {
  const method = String(body.ph_method || 'POST').toUpperCase();
  if (method === 'DELETE') {
    fixtureState.participations = fixtureState.participations.filter((entry) => Number(entry.id) !== Number(body.id));
    return;
  }
  const target = fixtureState.participations.find((entry) => Number(entry.id) === Number(body.id));
  if (target) Object.assign(target, body);
}

/* ------------------------------------------------------------------ *
 * Fixture server.                                                     *
 * ------------------------------------------------------------------ */
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

    if (pathname === '/api/auth.php') {
      return json(res, {
        logged_in: true,
        user: { id: 1, username: 'super-admin', role: 'super_admin' },
        memberships: [{ club_id: 1, country: 'china', role: 'representative', status: 'active' }],
      });
    }
    if (pathname === '/api/clubs.php') {
      return json(res, {
        data: [
          { id: 1, name: CLUB_SELECTED, school: '测试学校', country: 'china' },
          { id: 2, name: CLUB_JOINT, school: '联合学校', country: 'china' },
        ],
      });
    }
    if (pathname === '/api/clubs_japan.php') {
      return json(res, { data: [] });
    }
    if (pathname === '/api/membership.php' && action === 'members') {
      return json(res, { success: true, members: [] });
    }
    if (pathname === '/api/membership.php' && action === 'pending') {
      return json(res, { success: true, memberships: [] });
    }
    if (pathname === '/api/projects.php') {
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        fixtureState.requests.push({ path: pathname, method: 'POST', body });
        applyProjectMutation(body);
        return json(res, { success: true });
      }
      if (fixtureState.projectsFail) {
        return json(res, { success: false, message: SERVICE_ERROR }, 500);
      }
      const projects = fixtureState.noRelatedProjects ? unrelatedProjects() : fixtureState.projects.map(clone);
      return json(res, { success: true, projects });
    }
    if (pathname === '/api/project_items.php') {
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        fixtureState.requests.push({ path: pathname, method: 'POST', body });
        applyItemMutation(body);
        return json(res, { success: true });
      }
      return json(res, { success: true, items: fixtureState.items.map(clone) });
    }
    if (pathname === '/api/project_participations.php') {
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        fixtureState.requests.push({ path: pathname, method: 'POST', body });
        applyParticipationMutation(body);
        return json(res, { success: true });
      }
      return json(res, { success: true, participations: fixtureState.participations.map(clone) });
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
    res.on('error', () => {});
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => { try { res.destroy(); } catch { /* the client is already gone */ } });
    return stream.pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ *
 * Page driving.                                                       *
 * ------------------------------------------------------------------ */
async function evaluate(win, label, body) {
  const script = `(async () => {\n${PAGE_HELPERS}\n${body}\n})()`;
  try {
    return await win.webContents.executeJavaScript(script);
  } catch (error) {
    throw new Error(`[${label}] ${error?.message || error}`);
  }
}

function lastRequest(suffix) {
  return fixtureState.requests.filter((entry) => entry.path.endsWith(suffix)).at(-1) || null;
}

async function createWindow(baseUrl, size) {
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
  await win.loadURL(`${baseUrl}/admin/club_manager.html?projects_test=1`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('#root .cm-app'))`);
    if (ready) break;
    await wait(100);
  }
  return { win, consoleErrors };
}

async function inspectViewport(baseUrl, name, size, theme) {
  resetFixtureState();
  const where = `${name}/${theme}`;
  const { win, consoleErrors } = await createWindow(baseUrl, size);
  try {
    /* --- Requirement 12: 「所有同好会」 selected -> club prompt, no cards. --- */
    const initial = await evaluate(win, 'all-clubs-prompt', `
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      const hasMenuToggle = Boolean(document.querySelector('.cm-menu-toggle'));
      await openMenu();
      await clickMenuItem('企划枢纽');
      await waitForText(${JSON.stringify(CLUB_PROMPT)});
      return {
        hasMenuToggle,
        innerWidth,
        bodyWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        clubText: clubSelectText(),
        prompt: document.body.innerText.includes(${JSON.stringify(CLUB_PROMPT)}),
        cards: projectCards().length,
        statRow: Boolean(document.querySelector('.cm-stat-row')),
        contentText: (document.querySelector('#clubManagerContent')?.innerText || '').slice(0, 400),
      };
    `);
    assert.equal(initial.clubText.includes('所有同好会'), true, `${where} club selector should default to 所有同好会 (got "${initial.clubText}")`);
    assert.equal(initial.prompt, true, `${where} 所有同好会 must render the club prompt (got "${initial.contentText}")`);
    assert.equal(initial.cards, 0, `${where} 所有同好会 must not render project cards`);
    assert.equal(initial.statRow, false, `${where} 所有同好会 must not render the project KPI row`);
    assert.equal(initial.bodyWidth <= initial.innerWidth + 1, true, `${where} should not horizontally overflow before club selection`);

    /* --- Requirement 1: pick club 1 in the visible selector, then the tab. --- */
    const club = await evaluate(win, 'select-club-and-open-tab', `
      await openMenu();
      await selectClub(${JSON.stringify(CLUB_SELECTED)});
      await clickMenuItem('企划枢纽');
      for (let i = 0; i < 60; i += 1) { if (document.querySelector('.cm-stat-row')) break; await sleep(100); }
      return {
        clubText: clubSelectText(),
        kpi: kpiValues(),
        titles: cardTitles(),
        cardCount: projectCards().length,
        statRow: Boolean(document.querySelector('.cm-stat-row')),
        bodyText: document.body.innerText.slice(0, 900),
      };
    `);
    assert.equal(club.clubText.includes(CLUB_SELECTED), true, `${where} club selector should show 发起同好会 (got "${club.clubText}")`);
    assert.equal(club.statRow, true, `${where} 企划枢纽 should render the KPI row after selecting a club (got "${club.bodyText}")`);

    /* --- Requirement 2: KPI counters. --- */
    assert.deepEqual(
      { related: club.kpi.related, activity: club.kpi.activity, joint: club.kpi.joint },
      { related: 2, activity: 1, joint: 2 },
      `${where} 关联企划/活动企划/联合企划 should count the two related fixture projects`,
    );
    /*
     * 待审核 is 2 by design: it counts pending participations of every *related*
     * project, exactly like the pre-migration page
     * (`pendingTotal = rows.reduce(... projectPendingParticipations(project.id).length, 0)`
     * over the same related-project rows), so a 联合 project's application is
     * included even though this club cannot review it. Only participation 301 on
     * the club's own project 101 is actionable; 303 on project 102 is counted but
     * has no review buttons — asserted by the pendingHasButtons checks below.
     */
    assert.equal(club.kpi.pending, 2, `${where} 待审核 must count pending applications across every related project (pre-migration behaviour)`);

    /* --- Requirement 3 (first half): soft-deleted rows never render. --- */
    const hidden = await evaluate(win, 'soft-deleted-hidden', `
      return {
        deletedProject: document.body.innerText.includes(${JSON.stringify(PROJECT_C_DELETED)}),
        deletedItem: document.body.innerText.includes(${JSON.stringify(ITEM_DELETED)}),
        withdrawn: document.body.innerText.includes(${JSON.stringify(PARTICIPATION_WITHDRAWN)}),
        titles: cardTitles(),
      };
    `);
    assert.equal(hidden.deletedProject, false, `${where} soft-deleted project ${PROJECT_C_DELETED} must never render`);
    assert.equal(hidden.deletedItem, false, `${where} soft-deleted sub-item must never render`);
    assert.equal(hidden.withdrawn, false, `${where} withdrawn participation must never render`);
    assert.equal(hidden.titles.length, 2, `${where} should render exactly the two live related projects (got ${JSON.stringify(hidden.titles)})`);

    /* --- Requirements 3 + 4: project 101 is organised by the club. --- */
    const detailA = await evaluate(win, 'detail-101-organiser-view', `
      await openCard(${JSON.stringify(PROJECT_A)});
      const drawer = detailDrawer();
      const extra = drawer.querySelector('.ant-drawer-extra');
      const pending = participationRow(drawer, ${JSON.stringify(PARTICIPATION_PENDING)});
      return {
        text: drawer.innerText,
        headerButtons: extra ? Array.from(extra.querySelectorAll('button')).map((node) => node.innerText.trim()) : [],
        dangerButton: Boolean(extra && extra.querySelector('.ant-btn-dangerous')),
        activeItem: drawer.innerText.includes(${JSON.stringify(ITEM_ACTIVE)}),
        deletedItem: drawer.innerText.includes(${JSON.stringify(ITEM_DELETED)}),
        pendingParticipation: drawer.innerText.includes(${JSON.stringify(PARTICIPATION_PENDING)}),
        withdrawnParticipation: drawer.innerText.includes(${JSON.stringify(PARTICIPATION_WITHDRAWN)}),
        reviewInput: Boolean(drawer.querySelector('input[aria-label="审核备注 #301"]')),
        pendingActions: pending ? Array.from(pending.querySelectorAll('button')).map((node) => node.innerText.trim()) : [],
        jointChip: drawer.innerText.includes('联合参加视图'),
      };
    `);
    assert.equal(detailA.activeItem, true, `${where} project 101 detail must list ${ITEM_ACTIVE}`);
    assert.equal(detailA.deletedItem, false, `${where} project 101 detail must not list the soft-deleted sub-item`);
    assert.equal(detailA.pendingParticipation, true, `${where} project 101 detail must list ${PARTICIPATION_PENDING}`);
    assert.equal(detailA.withdrawnParticipation, false, `${where} project 101 detail must not list the withdrawn participation`);
    assert.equal(detailA.jointChip, false, `${where} project 101 is organised by the club, so no 联合参加视图 chip`);
    assert.equal(detailA.headerButtons.includes('编辑'), true, `${where} project 101 must offer 编辑 (got ${JSON.stringify(detailA.headerButtons)})`);
    assert.equal(detailA.headerButtons.includes('删除'), true, `${where} project 101 must offer 删除 (got ${JSON.stringify(detailA.headerButtons)})`);
    assert.equal(detailA.dangerButton, true, `${where} project 101 delete action must stay a danger button`);
    assert.deepEqual(detailA.pendingActions, ['通过', '拒绝'], `${where} the club's own pending application must be reviewable`);
    assert.equal(detailA.reviewInput, true, `${where} the pending application must expose a 审核备注 input`);

    /* --- Requirement 5: project 102 is only a joint participation. --- */
    const detailB = await evaluate(win, 'detail-102-joint-view', `
      await closeDetail();
      await openCard(${JSON.stringify(PROJECT_B)});
      const drawer = detailDrawer();
      const pending = participationRow(drawer, ${JSON.stringify(PARTICIPATION_JOINT)});
      const extra = drawer.querySelector('.ant-drawer-extra');
      return {
        text: drawer.innerText,
        headerButtons: extra ? Array.from(extra.querySelectorAll('button')).map((node) => node.innerText.trim()) : [],
        anyEdit: Array.from(drawer.querySelectorAll('button')).some((node) => node.innerText.trim() === '编辑'),
        anyDelete: Array.from(drawer.querySelectorAll('button')).some((node) => node.innerText.trim() === '删除'),
        addItem: drawer.innerText.includes('添加子项目'),
        jointChip: drawer.innerText.includes('联合参加视图'),
        pendingRow: Boolean(pending),
        pendingText: pending ? pending.innerText : '',
        pendingActions: pending ? Array.from(pending.querySelectorAll('button')).map((node) => node.innerText.trim()) : [],
      };
    `);
    assert.equal(detailB.jointChip, true, `${where} project 102 must show 联合参加视图`);
    assert.deepEqual(detailB.headerButtons, [], `${where} project 102 must not offer 编辑/删除 in the drawer header`);
    assert.equal(detailB.anyEdit, false, `${where} project 102 must not offer 编辑 anywhere`);
    assert.equal(detailB.anyDelete, false, `${where} project 102 must not offer 删除 anywhere`);
    assert.equal(detailB.addItem, false, `${where} project 102 must not offer 添加子项目`);
    assert.equal(detailB.pendingRow, true, `${where} project 102 must list its pending ${PARTICIPATION_JOINT}`);
    assert.deepEqual(detailB.pendingActions, [], `${where} a joint project's pending application must not be reviewable (row: ${detailB.pendingText.replace(/\n/g, ' | ')})`);

    /* --- Requirement 10: type and status filters drive the visible cards. --- */
    const filters = await evaluate(win, 'type-and-status-filters', `
      await closeDetail();
      const before = projectCards().length;
      const typeSelect = toolbarSelect(0);
      const statusSelect = toolbarSelect(1);
      if (!typeSelect || !statusSelect) throw new Error('toolbar filter selects are missing');
      await openSelect(typeSelect);
      await pickOption('活动企划');
      const activity = { count: projectCards().length, titles: cardTitles() };
      await openSelect(typeSelect);
      await pickOption('刊物企划');
      const publication = { count: projectCards().length, titles: cardTitles() };
      await openSelect(typeSelect);
      await pickOption('全部类型');
      const restoredType = projectCards().length;
      await openSelect(statusSelect);
      await pickOption('进行中');
      const ongoing = { count: projectCards().length, titles: cardTitles() };
      await openSelect(statusSelect);
      await pickOption('征集中');
      const collecting = projectCards().length;
      await openSelect(statusSelect);
      await pickOption('已完成');
      const completed = projectCards().length;
      const empty = document.body.innerText.includes(${JSON.stringify(EMPTY_STATE)});
      await openSelect(statusSelect);
      await pickOption('全部状态');
      return { before, activity, publication, restoredType, ongoing, collecting, completed, empty, finalCount: projectCards().length };
    `);
    assert.equal(filters.before, 2, `${where} both related projects should be visible before filtering`);
    assert.equal(filters.activity.count, 1, `${where} 活动企划 filter should keep exactly one card`);
    assert.equal(filters.activity.titles[0].includes(PROJECT_A), true, `${where} 活动企划 filter should keep project 101`);
    assert.equal(filters.publication.count, 1, `${where} 刊物企划 filter should keep exactly one card`);
    assert.equal(filters.restoredType, 2, `${where} 全部类型 filter should restore both cards`);
    assert.equal(filters.ongoing.count, 1, `${where} 进行中 filter should keep exactly one card`);
    assert.equal(filters.ongoing.titles[0].includes(PROJECT_A), true, `${where} 进行中 filter should keep project 101`);
    assert.equal(filters.collecting, 1, `${where} 征集中 filter should keep exactly one card`);
    assert.equal(filters.completed, 0, `${where} 已完成 filter should render no cards`);
    assert.equal(filters.empty, true, `${where} an empty filter result should render ${EMPTY_STATE}`);
    assert.equal(filters.finalCount, 2, `${where} 全部状态 filter should restore both cards`);

    /* --- Requirement 11: service failure, retry recovery and empty fixtures. --- */
    fixtureState.projectsFail = true;
    const failure = await evaluate(win, 'projects-service-failure', `
      await closePopups();
      await clickRefresh();
      for (let i = 0; i < 50; i += 1) { if (document.querySelector('.ant-alert-error')) break; await sleep(100); }
      const alert = document.querySelector('.ant-alert-error');
      return {
        hasAlert: Boolean(alert),
        text: alert ? alert.innerText : '',
        retry: Boolean(buttonByText(alert, '重试')),
        cards: projectCards().length,
        kpi: kpiValues(),
      };
    `);
    assert.equal(failure.hasAlert, true, `${where} a failing projects.php must render the error panel`);
    assert.equal(failure.text.includes(SERVICE_ERROR), true, `${where} error panel must surface the API message (got "${failure.text}")`);
    assert.equal(failure.retry, true, `${where} error panel must offer 重试`);
    assert.equal(failure.cards, 0, `${where} the error state must not render project cards`);
    assert.deepEqual(
      failure.kpi,
      { related: null, activity: null, pending: null, joint: null },
      `${where} the error state must not render the KPI row`,
    );

    fixtureState.projectsFail = false;
    const recovered = await evaluate(win, 'projects-retry-recovery', `
      const alert = document.querySelector('.ant-alert-error');
      const retry = buttonByText(alert, '重试');
      if (!retry) throw new Error('重试 button disappeared before the recovery click');
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 60; i += 1) { if (document.querySelector('.cm-stat-row') && projectCards().length === 2) break; await sleep(100); }
      return { titles: cardTitles(), kpi: kpiValues(), hasAlert: Boolean(document.querySelector('.ant-alert-error')) };
    `);
    assert.equal(recovered.hasAlert, false, `${where} 重试 must clear the error panel`);
    assert.equal(recovered.titles.length, 2, `${where} 重试 must restore the project cards (got ${JSON.stringify(recovered.titles)})`);
    assert.equal(recovered.kpi.related, 2, `${where} 重试 must restore the KPI counts`);

    fixtureState.noRelatedProjects = true;
    const empty = await evaluate(win, 'no-related-projects-empty-state', `
      await clickRefresh();
      await waitForText(${JSON.stringify(EMPTY_STATE)});
      return { empty: document.body.innerText.includes(${JSON.stringify(EMPTY_STATE)}), cards: projectCards().length, related: statValue('关联企划') };
    `);
    assert.equal(empty.empty, true, `${where} fixtures without related projects must render ${EMPTY_STATE}`);
    assert.equal(empty.cards, 0, `${where} fixtures without related projects must render no cards`);
    assert.equal(empty.related, 0, `${where} 关联企划 must be 0 without related projects`);

    fixtureState.noRelatedProjects = false;
    const restored = await evaluate(win, 'fixtures-restored', `
      await clickRefresh();
      await waitForCards(2);
      return { titles: cardTitles() };
    `);
    assert.equal(restored.titles.length, 2, `${where} restoring the fixtures must restore both cards`);

    /* --- Requirement 6: approve participation 301 with a review note. --- */
    const review = await evaluate(win, 'review-participation-301', `
      await openCard(${JSON.stringify(PROJECT_A)});
      const drawer = detailDrawer();
      const input = drawer.querySelector('input[aria-label="审核备注 #301"]');
      setInput(input, ${JSON.stringify(REVIEW_NOTE)});
      await sleep(160);
      const row = participationRow(drawer, ${JSON.stringify(PARTICIPATION_PENDING)});
      const accept = buttonByText(row, '通过');
      if (!accept) throw new Error('通过 button is missing on the pending application');
      accept.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 60; i += 1) {
        await sleep(100);
        const current = participationRow(detailDrawer(), ${JSON.stringify(PARTICIPATION_PENDING)});
        if (current && !buttonByText(current, '通过')) {
          return { rowText: current.innerText, actions: Array.from(current.querySelectorAll('button')).length, kpi: kpiValues() };
        }
      }
      throw new Error('the reviewed application still offers review actions');
    `);
    const reviewRequest = lastRequest('project_participations.php');
    assert.deepEqual(
      reviewRequest?.body,
      { ph_method: 'PUT', id: 301, status: 'accepted', review_note: REVIEW_NOTE },
      `${where} 通过 must post the reviewed status and the typed remark`,
    );
    assert.equal(review.actions, 0, `${where} an accepted application must lose its review buttons`);
    assert.equal(review.rowText.includes('已通过'), true, `${where} the accepted application must read 已通过 (got "${review.rowText.replace(/\n/g, ' | ')}")`);
    assert.equal(review.rowText.includes(REVIEW_NOTE), true, `${where} the accepted application must keep the review note`);
    assert.equal(review.kpi.pending, 1, `${where} 待审核 must drop to the joint application only after the review`);

    /* --- Requirement 7: create a joint project from the 新建企划 modal. --- */
    const create = await evaluate(win, 'create-joint-project', `
      await closeDetail();
      const trigger = Array.from(document.querySelectorAll('.cm-page-heading button')).find((node) => node.innerText.trim() === '新建企划');
      if (!trigger) throw new Error('新建企划 button is missing');
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(420);
      const modal = visibleModal();
      if (!modal) throw new Error('project modal did not open');
      setInput(formItem(modal, '企划名称').querySelector('input'), ${JSON.stringify(NEW_PROJECT_TITLE)});
      await sleep(120);
      const jointItem = formItem(modal, '联合同好会');
      if (!jointItem) throw new Error('联合同好会 form item is missing');
      await openSelect(jointItem.querySelector('.ant-select'));
      const options = dropdownOptions();
      await pickOption(${JSON.stringify(CLUB_JOINT)});
      const ok = modal.querySelector('.ant-modal-footer .ant-btn-primary');
      if (!ok) throw new Error('project modal confirm button is missing');
      ok.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 60; i += 1) { await sleep(100); if (cardByText(${JSON.stringify(NEW_PROJECT_TITLE)})) break; }
      return { options, titles: cardTitles(), modalOpen: Boolean(visibleModal()), kpi: kpiValues() };
    `);
    assert.deepEqual(
      create.options,
      [CLUB_JOINT],
      `${where} 联合同好会 must offer only the other club and never the selected one (got ${JSON.stringify(create.options)})`,
    );
    const createRequest = lastRequest('projects.php');
    assert.equal(createRequest?.method, 'POST', `${where} saving a new project must post it to projects.php`);
    assert.equal(createRequest?.body?.title, NEW_PROJECT_TITLE, `${where} the created project must carry the typed title`);
    assert.deepEqual(createRequest?.body?.organizer_club, { id: 1, country: 'china' }, `${where} the organiser must be the selected club`);
    assert.equal(createRequest?.body?.is_joint, true, `${where} choosing a 联合同好会 must mark the project as joint`);
    assert.deepEqual(
      createRequest?.body?.participant_clubs,
      [{ id: 2, country: 'china', name: CLUB_JOINT }],
      `${where} the joint club payload must be exact`,
    );
    assert.equal(createRequest?.body?.ph_method, undefined, `${where} creating a project must not send ph_method`);
    assert.equal(create.modalOpen, false, `${where} the project modal must close after saving`);
    assert.equal(create.titles.includes(NEW_PROJECT_TITLE), true, `${where} the created project must appear as a card (got ${JSON.stringify(create.titles)})`);
    assert.equal(create.titles.length, 3, `${where} the created joint project must join the two fixture projects`);
    assert.equal(create.kpi.related, 3, `${where} 关联企划 must count the created project`);

    /* --- Requirement 8: edit project 101's title. --- */
    const edit = await evaluate(win, 'edit-project-101', `
      await openCard(${JSON.stringify(PROJECT_A)});
      const editButton = drawerExtraButton(detailDrawer(), '编辑');
      if (!editButton) throw new Error('编辑 button is missing on project 101');
      editButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(420);
      const modal = visibleModal();
      if (!modal) throw new Error('edit modal did not open');
      const input = formItem(modal, '企划名称').querySelector('input');
      const prefilled = input.value;
      setInput(input, ${JSON.stringify(PROJECT_A_EDITED)});
      await sleep(140);
      modal.querySelector('.ant-modal-footer .ant-btn-primary').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 60; i += 1) { await sleep(100); if (cardByText(${JSON.stringify(PROJECT_A_EDITED)})) break; }
      return { prefilled, titles: cardTitles(), modalOpen: Boolean(visibleModal()) };
    `);
    assert.equal(edit.prefilled.includes(PROJECT_A), true, `${where} the edit modal must prefill the current title (got "${edit.prefilled}")`);
    const editRequest = lastRequest('projects.php');
    assert.equal(editRequest?.body?.ph_method, 'PUT', `${where} editing a project must post ph_method PUT`);
    assert.equal(editRequest?.body?.id, 101, `${where} the edit payload must carry the edited project id`);
    assert.equal(editRequest?.body?.title, PROJECT_A_EDITED, `${where} the edit payload must carry the new title`);
    assert.equal(edit.modalOpen, false, `${where} the edit modal must close after saving`);
    assert.equal(edit.titles.includes(PROJECT_A_EDITED), true, `${where} the renamed project must render its new title`);

    /* --- Requirement 9: delete project 101 through the Popconfirm. --- */
    const remove = await evaluate(win, 'delete-project-101', `
      if (!detailDrawer()) await openCard(${JSON.stringify(PROJECT_A_EDITED)});
      const deleteButton = drawerExtraButton(detailDrawer(), '删除');
      if (!deleteButton) throw new Error('删除 button is missing on project 101');
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(400);
      const popconfirm = Array.from(document.querySelectorAll('.ant-popconfirm')).filter((node) => !node.classList.contains('ant-popover-hidden')).at(-1);
      if (!popconfirm) throw new Error('delete popconfirm did not open');
      const confirm = popconfirm.querySelector('.ant-popconfirm-buttons .ant-btn-primary');
      if (!confirm) throw new Error('popconfirm confirm button is missing');
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 60; i += 1) { await sleep(100); if (!cardByText(${JSON.stringify(PROJECT_A_EDITED)})) break; }
      return {
        titles: cardTitles(),
        kpi: kpiValues(),
        drawerOpen: Boolean(detailDrawer()),
        stillVisible: document.body.innerText.includes(${JSON.stringify(PROJECT_A_EDITED)}),
      };
    `);
    const deleteRequest = lastRequest('projects.php');
    assert.deepEqual(deleteRequest?.body, { ph_method: 'DELETE', id: 101 }, `${where} deleting must post ph_method DELETE for project 101`);
    assert.equal(remove.titles.includes(PROJECT_A_EDITED), false, `${where} the deleted project must disappear from the cards`);
    assert.equal(remove.titles.length, 2, `${where} two projects should remain after the delete (got ${JSON.stringify(remove.titles)})`);
    assert.equal(remove.drawerOpen, false, `${where} deleting the open project must close the detail drawer`);
    assert.equal(remove.kpi.related, 2, `${where} 关联企划 must drop after deleting project 101`);

    /* --- Layout guard: nothing may push the page wider than the viewport. --- */
    const layout = await evaluate(win, 'final-layout', `
      await closePopups();
      await sleep(220);
      return {
        innerWidth,
        bodyWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        bodyRight: Math.round(document.body.getBoundingClientRect().right),
      };
    `);
    assert.equal(layout.bodyWidth <= layout.innerWidth + 1, true, `${where} should not horizontally overflow (page ${layout.bodyWidth} > viewport ${layout.innerWidth})`);

    assert.equal(consoleErrors.length, 0, `${where} should not add console errors: ${consoleErrors.join('; ')}`);
    return { name, theme, innerWidth: initial.innerWidth, hasMenuToggle: initial.hasMenuToggle, kpi: club.kpi, cards: remove.titles.length };
  } finally {
    win.destroy();
    await wait(400);
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
        console.log(`OK ${name}/${theme} width=${result.innerWidth} menu=${result.hasMenuToggle ? 'drawer' : 'sidebar'} kpi=${result.kpi.related}/${result.kpi.activity}/${result.kpi.pending}/${result.kpi.joint} cards=${result.cards}`);
      }
    }
    console.log('club manager project hub browser tests passed');
  } finally {
    await app.quit();
    await new Promise((resolve) => server.close(resolve));
  }
}

if (app?.whenReady && BrowserWindow) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
    /* app.quit() always terminates Electron with code 0, so a failing run has to
       force the exit status or a chained `&&` script would report success. */
    if (app?.exit) app.exit(1);
  });
}
