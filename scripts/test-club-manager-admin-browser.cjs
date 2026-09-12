/* Electron browser regression suite for the super-admin-only club manager
   modules: 用户管理 (UsersTab) and 江苏专项 (JiangsuTab), plus the permission
   gating that hides / refuses them for a plain club manager.

   Everything is driven through the real UI: menu clicks, antd selects,
   popconfirms and modals. No React internals and no application window.*
   helpers are called. */
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

const CHINA_CLUBS = [
  { id: 1, name: '江苏测试同好会', school: '南京测试学校', country: 'china', provinces: ['江苏'], city: '' },
  { id: 2, name: '北京测试同好会', school: '北京测试学校', country: 'china', provinces: ['北京'], city: '' },
  { id: 3, name: '苏州测试同好会', school: '苏州测试学校', country: 'china', province: '江苏', city: '苏州' },
];

const USER_FIVE = {
  id: 5,
  username: 'zhangsan',
  nickname: '张三',
  email: 'z@example.com',
  avatar_url: '',
  role: 'visitor',
  display_role: 'member',
  status: 'active',
  memberships: [
    { id: 61, club_id: 1, country: 'china', role: 'member', status: 'active' },
    { id: 62, club_id: 2, country: 'china', role: 'manager', status: 'active' },
    { id: 63, club_id: 3, country: 'china', role: 'member', status: 'active' },
  ],
};

const USER_SIX = {
  id: 6,
  username: 'lisi',
  nickname: '李四',
  email: 'l@example.com',
  role: 'visitor',
  status: 'banned',
  memberships: [],
};

const USER_SEVEN = {
  id: 7,
  username: 'international-table-user-with-an-extra-long-username',
  nickname: '王五',
  email: 'very-long-user-account-email-address-for-layout@example.vnfest.top',
  role: 'visitor',
  status: 'active',
  memberships: [
    { id: 64, club_id: 3, country: 'china', role: 'member', status: 'active' },
  ],
};

const NEW_NICKNAME = '张三改名';

const fixtureState = {
  identity: 'super',
  requests: [],
  failPutClubIds: [],
  flashProbe: false,
};

/* Injected only for the manager deep-link run: it samples the mounted module
   from the very first paint so a transient render of a restricted tab cannot
   hide between two polls. */
const FLASH_PROBE = `<script>
(function () {
  window.__cmAdminProbe = { flash: [], components: [] };
  function sample() {
    var content = document.getElementById('clubManagerContent');
    if (!content) return;
    var page = content.querySelector('.cm-page');
    var component = page ? (page.getAttribute('data-component') || '') : '';
    if (component && window.__cmAdminProbe.components.indexOf(component) === -1) window.__cmAdminProbe.components.push(component);
    if (content.querySelector('[data-component="江苏同好会专项设置"], [data-component="全站用户管理"]')) {
      window.__cmAdminProbe.flash.push(component || 'restricted');
    }
  }
  document.addEventListener('DOMContentLoaded', function () {
    sample();
    new MutationObserver(sample).observe(document.documentElement, { childList: true, subtree: true });
  });
})();
</script>`;

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

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function identityPayload() {
  if (fixtureState.identity === 'manager') {
    return {
      logged_in: true,
      user: { id: 9, username: 'club-manager', role: 'member' },
      memberships: [{ club_id: 1, country: 'china', role: 'manager', status: 'active' }],
    };
  }
  return {
    logged_in: true,
    user: { id: 1, username: 'super-admin', role: 'super_admin' },
    memberships: [{ club_id: 1, country: 'china', role: 'representative', status: 'active' }],
  };
}

function startFixtureServer() {
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;
    const action = requestUrl.searchParams.get('action') || '';
    let rawBody = '';
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') rawBody = await readBody(req);
    if (pathname.startsWith('/api/')) {
      fixtureState.requests.push({
        method: req.method,
        pathname,
        search: requestUrl.search,
        action,
        body: rawBody,
        arrivedAt: Date.now(),
      });
    }

    if (pathname === '/api/auth.php') return json(res, identityPayload());
    if (pathname === '/api/clubs_japan.php') return json(res, { data: [] });
    if (pathname === '/api/clubs.php') {
      if (req.method === 'PUT') {
        const payload = parseJson(rawBody) || {};
        if (fixtureState.failPutClubIds.includes(Number(payload.id))) {
          return json(res, { success: false, message: 'fixture 江苏城市保存失败' }, 500);
        }
        return json(res, { success: true });
      }
      return json(res, { data: CHINA_CLUBS });
    }
    if (pathname === '/api/users.php') {
      if (action === 'list') {
        return json(res, { success: true, users: [USER_FIVE, USER_SIX, USER_SEVEN], total: 42 });
      }
      if (action === 'get') {
        const id = Number(requestUrl.searchParams.get('id'));
        return json(res, { success: true, user: id === 6 ? USER_SIX : USER_FIVE });
      }
      if (action === 'update' || action === 'delete') return json(res, { success: true });
      return json(res, { success: true });
    }
    if (pathname === '/api/membership.php') {
      if (action === 'pending') return json(res, { success: true, memberships: [] });
      if (action === 'members') return json(res, { success: true, members: [] });
      if (action === 'change_role' || action === 'kick') return json(res, { success: true });
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
    if (fixtureState.flashProbe && relativePath === 'admin/club_manager.html') {
      const html = fs.readFileSync(filePath, 'utf8').replace('<head>', `<head>${FLASH_PROBE}`);
      res.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    res.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-store' });
    return fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ page helpers */

const PAGE_HELPERS = `
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));
const norm = (node) => (node ? String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim() : '');
/* antd inserts a space between the two CJK characters of an icon-less button
   (更新 -> 更 新), so label matching must ignore whitespace. */
const flat = (value) => String(value || '').replace(/\\s+/g, '');
const byText = (selector, text, root) => $$(selector, root).find((node) => flat(norm(node)).indexOf(flat(text)) !== -1) || null;
const mustByText = (selector, text, root) => {
  const found = byText(selector, text, root);
  if (!found) throw new Error('missing ' + selector + ' containing "' + text + '", candidates: ' + $$(selector, root).map(norm).join(' | '));
  return found;
};
const waitFor = async (check, label, attempts) => {
  const limit = attempts || 60;
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const value = check();
    if (value) return value;
    await sleep(60);
  }
  throw new Error('timeout waiting for ' + label);
};
const click = (node) => {
  if (!node) throw new Error('cannot click a missing element');
  node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
};
const setValue = (input, value) => {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  descriptor.set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const pressEnter = (input) => {
  const options = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  input.dispatchEvent(new KeyboardEvent('keydown', options));
  input.dispatchEvent(new KeyboardEvent('keyup', options));
};
const filterSelect = (label) => {
  const found = $$('.cm-filterbar .ant-select').find((node) => norm(node).indexOf(label) !== -1);
  if (!found) throw new Error('missing filter select showing ' + label + ', candidates: ' + $$('.cm-filterbar .ant-select').map(norm).join(' | '));
  return found;
};
const visibleDropdowns = () => $$('.ant-select-dropdown').filter((node) => !node.classList.contains('ant-select-dropdown-hidden') && getComputedStyle(node).display !== 'none');
let activeDropdown = null;
const openSelect = async (node) => {
  const before = visibleDropdowns();
  const wrapper = node.closest ? (node.closest('.ant-select') || node) : node;
  const selector = wrapper.querySelector('.ant-select-selector') || wrapper;
  selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  await sleep(140);
  const after = visibleDropdowns();
  /* only the dropdown that just opened may receive the option click: several
     selects on the page share option labels (e.g. 超级管理员) */
  activeDropdown = after.find((item) => before.indexOf(item) === -1) || after[after.length - 1] || null;
  return activeDropdown;
};
const dropdownOptions = () => (activeDropdown ? [activeDropdown] : visibleDropdowns())
  .flatMap((dropdown) => $$('.ant-select-item-option', dropdown));
const pickOption = async (text) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const options = dropdownOptions();
    const option = options.find((node) => norm(node) === text) || options.find((node) => norm(node).indexOf(text) !== -1);
    if (option) {
      option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      await sleep(200);
      return true;
    }
    await sleep(60);
  }
  throw new Error('missing select option "' + text + '", candidates: ' + dropdownOptions().map(norm).join(' | '));
};
const selectText = (node) => norm((node.closest ? node.closest('.ant-select') : node).querySelector('.ant-select-selection-item'));
const visiblePopover = () => $$('.ant-popover').find((node) => !node.classList.contains('ant-popover-hidden')
  && !/leave/.test(String(node.className)) && getComputedStyle(node).display !== 'none'
  && node.querySelector('button.ant-btn')) || null;
const confirmPopover = async (label) => {
  let popover;
  try {
    popover = await waitFor(visiblePopover, 'the popconfirm for ' + label);
  } catch (error) {
    throw new Error(error.message + ' (popover candidates: '
      + $$('.ant-popover').map((node) => String(node.className) + ' :: ' + norm(node).slice(0, 60)).join(' ;; ') + ')');
  }
  const text = norm(popover);
  const buttons = $$('button.ant-btn', popover);
  const confirm = buttons.find((node) => String(node.className).indexOf('ant-btn-primary') !== -1) || buttons[buttons.length - 1];
  click(confirm);
  await sleep(260);
  return text;
};
const menuItems = () => $$('.cm-nav-wrap .ant-menu-item');
const openNav = async () => {
  if (document.querySelector('.cm-menu-toggle')) {
    click(document.querySelector('.cm-menu-toggle'));
    await waitFor(() => {
      const wrapper = document.querySelector('.ant-drawer-content-wrapper');
      return wrapper && getComputedStyle(wrapper).display !== 'none' ? wrapper : null;
    }, 'navigation drawer');
    await sleep(140);
  }
  return waitFor(() => (menuItems().length ? menuItems() : null), 'navigation menu items');
};
const switchTab = async (label) => {
  await openNav();
  click(mustByText('.cm-nav-wrap .ant-menu-item', label));
  await sleep(220);
};
const visibleModal = () => {
  const wrap = $$('.ant-modal-wrap').find((node) => getComputedStyle(node).display !== 'none');
  return wrap ? wrap.querySelector('.ant-modal') : null;
};
const formItem = (label) => {
  const modal = visibleModal();
  if (!modal) throw new Error('no visible modal while looking for form item ' + label);
  return mustByText('.ant-form-item', label, modal);
};
const closeModal = async () => {
  const modal = visibleModal();
  if (!modal) return 0;
  const startedAt = Date.now();
  const cancel = $$('.ant-modal-footer button', modal).find((node) => String(node.className).indexOf('ant-btn-primary') === -1);
  click(cancel || $$('.ant-modal-footer button', modal)[0]);
  await waitFor(() => (visibleModal() ? null : true), 'editor modal to close', 250);
  return Date.now() - startedAt;
};
const userCard = (username) => mustByText('.cm-user-table-row', username);
const bodyWidth = () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
`;

function page(win, body) {
  return win.webContents.executeJavaScript(`(async () => {\n${PAGE_HELPERS}\n${body}\n})()`);
}

async function waitUntil(check, label, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return true;
    await wait(60);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function waitForShell(win) {
  const ready = await waitUntil(() => page(win, `return Boolean(document.querySelector('#root .cm-app'));`), 'club manager shell', 40);
  if (!ready) throw new Error('shell did not boot');
}

function apiRequests(predicate) {
  return fixtureState.requests.filter(predicate);
}

function putRequests() {
  return apiRequests((entry) => entry.method === 'PUT' && entry.pathname === '/api/clubs.php');
}

function listRequests() {
  return apiRequests((entry) => entry.pathname === '/api/users.php' && entry.action === 'list');
}

function membershipRequests(action) {
  return apiRequests((entry) => entry.pathname === '/api/membership.php' && entry.action === action);
}

function userMutationRequests(action) {
  return apiRequests((entry) => entry.pathname === '/api/users.php' && entry.action === action);
}

async function messageTexts(win) {
  return win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.ant-message-notice')).map((node) => String(node.innerText || '').replace(/\\s+/g, ' ').trim())`);
}

async function waitForNewMessage(win, text, initialCount, label) {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const list = await messageTexts(win);
    if (list.filter((item) => item.includes(text)).length > initialCount) return true;
    await wait(100);
  }
  const list = await messageTexts(win);
  throw new Error(`timeout waiting for the message ${label} (visible: ${JSON.stringify(list)})`);
}

function assertExactBody(entry, expected, label) {
  assert.ok(entry, `${label}: no recorded request`);
  assert.equal(entry.method, 'POST', `${label}: expected POST, got ${entry.method}`);
  const parsed = parseJson(entry.body);
  assert.ok(parsed, `${label}: body is not JSON (${entry.body})`);
  assert.deepEqual(parsed, expected, `${label}: body must be exactly ${JSON.stringify(expected)} (got ${entry.body})`);
  assert.deepEqual(Object.keys(parsed).sort(), Object.keys(expected).sort(), `${label}: body must not carry extra keys (got ${entry.body})`);
}

/* ------------------------------------------------------------------ super-admin run */

async function runSuperAdmin(baseUrl, name, size, theme) {
  const label = `${name}/${theme}`;
  fixtureState.identity = 'super';
  fixtureState.failPutClubIds = [];
  fixtureState.flashProbe = false;
  fixtureState.requests = [];

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
    await win.loadURL(`${baseUrl}/admin/club_manager.html?admin_test=1`);
    await waitForShell(win);

    /* ---------- 1. open 用户管理 through the navigation ---------- */
    const nav = await page(win, `
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      await sleep(120);
      await switchTab('用户管理');
      await waitFor(() => (document.querySelectorAll('.cm-user-table-row').length === 3 ? true : null), 'the three fixture user rows');
      return {
        menuLabels: menuItems().map(norm),
        activeItem: norm(document.querySelector('.cm-nav-wrap .ant-menu-item-selected')),
        component: document.querySelector('#clubManagerContent .cm-page').dataset.component || '',
        drawerUsable: Boolean(document.querySelector('.cm-menu-toggle')),
      };
    `);
    assert.ok(nav.menuLabels.some((text) => text.includes('用户管理')), `${label} the navigation must expose 用户管理 for a super admin`);
    assert.ok(nav.menuLabels.some((text) => text.includes('江苏专项')), `${label} the navigation must expose 江苏专项 for a super admin`);
    assert.equal(nav.component, '全站用户管理', `${label} clicking 用户管理 must mount the users module`);
    assert.ok(nav.activeItem.includes('用户管理'), `${label} 用户管理 must become the active menu item (got ${nav.activeItem})`);
    assert.equal(nav.drawerUsable, size.width <= 1100, `${label} narrow viewports must navigate through the drawer`);

    /* ---------- 2. the user list, membership tags and the pagination total ---------- */
    const list = await page(win, `
      const cards = $$('.cm-user-table-row').map((card) => ({
        text: norm(card),
        systemRole: norm(card.querySelector('td[data-label="系统角色"]')),
        tags: $$('.cm-user-membership', card).map(norm),
        more: $$('.cm-chip-more', card).map(norm),
      }));
      return {
        cards,
        total: norm(document.querySelector('.ant-pagination-total-text')),
        columnCount: document.querySelectorAll('.cm-user-table thead th').length,
        tableWidth: Math.round(document.querySelector('.cm-user-table')?.getBoundingClientRect().width || 0),
        tableWrapWidth: Math.round(document.querySelector('.cm-user-table-wrap')?.getBoundingClientRect().width || 0),
        tableWrapScrollWidth: Math.round(document.querySelector('.cm-user-table-wrap')?.scrollWidth || 0),
        actionButtonHeights: Array.from(document.querySelectorAll('.cm-user-table-row:first-child .cm-user-table-actions .ant-btn')).map((node) => Math.round(node.getBoundingClientRect().height)),
        fallbackAvatarCount: document.querySelectorAll('.cm-user-table .cm-profile-avatar.is-fallback').length,
        brokenFallbackImageCount: document.querySelectorAll('.cm-user-table .cm-profile-avatar.is-fallback img').length,
        bodyWidth: bodyWidth(),
        innerWidth,
      };
    `);
    assert.equal(list.cards.length, 3, `${label} the user list must render all fixture users`);
    assert.equal(list.total, '共 42 人', `${label} the pagination must show 共 42 人 (got ${list.total})`);
    const zhangsan = list.cards.find((card) => card.text.includes('zhangsan'));
    const lisi = list.cards.find((card) => card.text.includes('lisi'));
    const wangwu = list.cards.find((card) => card.text.includes('international-table-user-with-an-extra-long-username'));
    assert.ok(zhangsan, `${label} user 5 (zhangsan) must be rendered`);
    assert.ok(lisi, `${label} user 6 (lisi) must be rendered`);
    assert.ok(wangwu, `${label} user 7 must be rendered`);
    assert.ok(zhangsan.text.includes('张三') && zhangsan.text.includes('z@example.com'), `${label} user 5 must show its nickname and email`);
    assert.equal(zhangsan.systemRole, '访客', `${label} user 5 must show its account role as 访客 while membership roles stay in the relationship column`);
    assert.ok(zhangsan.tags.includes('江苏测试同好会 · 成员'), `${label} membership 61 must render as 江苏测试同好会 · 成员 (got ${JSON.stringify(zhangsan.tags)})`);
    assert.ok(zhangsan.tags.includes('北京测试同好会 · 管理员'), `${label} membership 62 must render as 北京测试同好会 · 管理员 (got ${JSON.stringify(zhangsan.tags)})`);
    assert.deepEqual(zhangsan.more, ['+1'], `${label} user 5 must collapse the third membership into +1`);
    assert.ok(lisi.text.includes('李四') && lisi.text.includes('已封禁'), `${label} user 6 must render as banned`);
    assert.equal(lisi.systemRole, '访客', `${label} an unbound visitor must not be labelled as 成员`);
    assert.ok(wangwu.tags.includes('苏州测试同好会 · 成员'), `${label} user 7 must render its single membership inline`);
    assert.deepEqual(wangwu.more, [], `${label} user 7 must not show a membership overflow chip`);
    assert.equal(list.columnCount, 6, `${label} 用户管理 must keep six semantic columns`);
    assert.ok(list.fallbackAvatarCount >= 1, `${label} users without avatars must render a fallback pattern`);
    assert.equal(list.brokenFallbackImageCount, 0, `${label} fallback avatars must not contain broken images`);
    assert.ok(list.tableWidth <= list.tableWrapWidth + 1, `${label} user table must fit its visible container (${list.tableWidth} > ${list.tableWrapWidth})`);
    assert.ok(list.tableWrapScrollWidth <= list.tableWrapWidth + 1, `${label} user management must not require a horizontal scrollbar (${list.tableWrapScrollWidth} > ${list.tableWrapWidth})`);
    assert.ok(list.actionButtonHeights.length >= 1 && list.actionButtonHeights.every((height) => height === list.actionButtonHeights[0]), `${label} user actions must share one height`);
    if (size.width <= 899) assert.ok(list.actionButtonHeights.every((height) => height >= 44), `${label} mobile user actions must keep 44px touch targets`);
    assert.ok(list.bodyWidth <= list.innerWidth + 1, `${label} 用户管理 must not overflow horizontally (${list.bodyWidth} > ${list.innerWidth})`);

    /* ---------- 3. search + role/status filters + 清除筛选 ---------- */
    await page(win, `
      const search = $$('.cm-filterbar input').find((node) => !node.closest('.ant-select'));
      if (!search) throw new Error('missing the search input');
      setValue(search, 'zhang');
      pressEnter(search);
      return true;
    `);
    await waitUntil(() => listRequests().some((entry) => entry.search.includes('search=zhang')), `${label} the searched users.php request`);
    const searched = listRequests().filter((entry) => entry.search.includes('search=zhang')).pop();
    assert.ok(searched.search.includes('action=list'), `${label} the search request must carry action=list (got ${searched.search})`);
    assert.ok(searched.search.includes('page=1'), `${label} the search request must carry page=1 (got ${searched.search})`);
    assert.ok(searched.search.includes('per_page=20'), `${label} the search request must carry per_page=20 (got ${searched.search})`);
    assert.ok(/[?&]search=zhang(&|$)/.test(searched.search), `${label} the search request must carry search=zhang (got ${searched.search})`);

    await page(win, `
      await openSelect(filterSelect('所有角色'));
      await pickOption('访客');
      return true;
    `);
    await waitUntil(() => listRequests().some((entry) => entry.search.includes('role=visitor')), `${label} the role filtered users.php request`);
    await page(win, `
      await openSelect(filterSelect('所有状态'));
      await pickOption('正常');
      return true;
    `);
    await waitUntil(() => listRequests().some((entry) => entry.search.includes('status=active')), `${label} the status filtered users.php request`);
    const filtered = listRequests().filter((entry) => entry.search.includes('status=active')).pop();
    assert.ok(filtered.search.includes('role=visitor'), `${label} the filtered request must combine role and status (got ${filtered.search})`);
    assert.ok(filtered.search.includes('search=zhang'), `${label} the filtered request must keep the search term (got ${filtered.search})`);

    const listCountBeforeClear = listRequests().length;
    await page(win, `
      click(mustByText('.cm-filterbar button', '清除筛选'));
      return true;
    `);
    await waitUntil(() => listRequests().length > listCountBeforeClear, `${label} a fresh users.php request after 清除筛选`);
    const cleared = listRequests()[listRequests().length - 1];
    assert.equal(cleared.search, '?action=list&page=1&per_page=20', `${label} 清除筛选 must issue an unfiltered list request`);
    const clearedUi = await page(win, `
      return {
        search: $$('.cm-filterbar input').find((node) => !node.closest('.ant-select')).value,
        role: norm(filterSelect('所有角色')),
        status: norm(filterSelect('所有状态')),
      };
    `);
    assert.equal(clearedUi.search, '', `${label} 清除筛选 must empty the search box`);
    assert.ok(clearedUi.role.includes('所有角色'), `${label} 清除筛选 must reset the role filter`);
    assert.ok(clearedUi.status.includes('所有状态'), `${label} 清除筛选 must reset the status filter`);

    /* ---------- 4. edit user 5 and save the changed fields ---------- */
    const editor = await page(win, `
      click(mustByText('button', '编辑', userCard('zhangsan')));
      const modal = await waitFor(() => {
        const current = visibleModal();
        const input = current && current.querySelector('.ant-form-item input');
        return input && input.value === 'zhangsan' ? current : null;
      }, 'the user editor modal');
      const read = (field) => {
        const input = formItem(field).querySelector('input');
        return { value: input.value, disabled: input.disabled };
      };
      const result = { username: read('用户名'), email: read('邮箱'), nickname: read('昵称') };
      setValue(formItem('昵称').querySelector('input'), ${JSON.stringify(NEW_NICKNAME)});
      await openSelect(formItem('系统角色').querySelector('.ant-select'));
      await pickOption('超级管理员');
      await openSelect(formItem('账号状态').querySelector('.ant-select'));
      await pickOption('已禁用');
      result.roleValue = selectText(formItem('系统角色').querySelector('.ant-select'));
      result.statusValue = selectText(formItem('账号状态').querySelector('.ant-select'));
      if (result.roleValue !== '超级管理员' || result.statusValue !== '已禁用') {
        throw new Error('the editor selects did not accept the picked values: role=' + result.roleValue + ' status=' + result.statusValue);
      }
      const clickAt = Date.now();
      click($$('.ant-modal-footer button', visibleModal()).find((node) => String(node.className).indexOf('ant-btn-primary') !== -1));
      await waitFor(() => ($$('.ant-message-notice').some((node) => norm(node).indexOf('用户信息已更新') !== -1) ? true : null), 'the save message', 250);
      result.noticeMs = Date.now() - clickAt;
      await waitFor(() => (visibleModal() ? null : true), 'the editor modal to close after saving', 250);
      result.closeMs = Date.now() - clickAt;
      result.clickAt = clickAt;
      return result;
    `);
    assert.deepEqual(editor.username, { value: 'zhangsan', disabled: true }, `${label} the username must be shown disabled`);
    assert.deepEqual(editor.email, { value: 'z@example.com', disabled: true }, `${label} the email must be shown disabled`);
    assert.deepEqual(editor.nickname, { value: '张三', disabled: false }, `${label} the nickname must be prefilled and editable`);
    assert.equal(editor.roleValue, '超级管理员', `${label} the role select must accept 超级管理员`);
    assert.equal(editor.statusValue, '已禁用', `${label} the status select must accept 已禁用`);
    await waitUntil(() => userMutationRequests('update').length > 0, `${label} the users.php?action=update request`);
    const updateEntry = userMutationRequests('update').pop();
    assertExactBody(updateEntry, {
      id: 5,
      status: 'disabled',
      nickname: NEW_NICKNAME,
      role: 'super_admin',
    }, `${label} users.php?action=update`);

    /* ---------- 5a. change a membership role from the editor card ---------- */
    const membership = await page(win, `
      click(mustByText('button', '编辑', userCard('zhangsan')));
      const editors = await waitFor(() => {
        const list = $$('.cm-membership-editor');
        return list.length === 3 ? list : null;
      }, 'the three membership editor cards');
      const target = editors.find((node) => norm(node).includes('江苏测试同好会'));
      if (!target) throw new Error('missing the 江苏测试同好会 membership card');
      const roleBefore = selectText(target.querySelector('.ant-select'));
      await openSelect(target.querySelector('.ant-select'));
      await pickOption('负责人');
      const roleAfter = selectText(target.querySelector('.ant-select'));
      if (roleAfter !== '负责人') throw new Error('the membership role select did not accept 负责人 (got ' + roleAfter + ')');
      click(mustByText('button', '更新', target));
      const popover = await confirmPopover('membership 更新');
      return { titles: editors.map((node) => norm(node.querySelector('.ant-card-head-title'))), roleBefore, roleAfter, popover };
    `);
    assert.deepEqual(membership.titles, ['江苏测试同好会 · 中国', '北京测试同好会 · 中国', '苏州测试同好会 · 中国'], `${label} the editor must list all memberships`);
    assert.equal(membership.roleBefore, '成员', `${label} the membership role select must start on the current role`);
    assert.equal(membership.roleAfter, '负责人', `${label} picking a membership role must update the select`);
    assert.ok(membership.popover.includes('确定更新该成员角色？'), `${label} 更新 must ask for confirmation (got ${membership.popover})`);
    await waitUntil(() => membershipRequests('change_role').length > 0, `${label} the membership.php?action=change_role request`);
    assertExactBody(membershipRequests('change_role').pop(), { membership_id: 61, role: 'representative' }, `${label} membership.php?action=change_role`);

    /* ---------- 5b. kick the other membership ---------- */
    const kick = await page(win, `
      const editors = await waitFor(() => {
        const list = $$('.cm-membership-editor');
        return list.length === 3 ? list : null;
      }, 'the membership editor cards after the role change');
      const target = editors.find((node) => norm(node).includes('北京测试同好会'));
      if (!target) throw new Error('missing the 北京测试同好会 membership card');
      click(mustByText('button', '踢出', target));
      return { popover: await confirmPopover('membership 踢出') };
    `);
    assert.ok(kick.popover.includes('确定将用户移出该同好会？'), `${label} 踢出 must ask for confirmation (got ${kick.popover})`);
    await waitUntil(() => membershipRequests('kick').length > 0, `${label} the membership.php?action=kick request`);
    assertExactBody(membershipRequests('kick').pop(), { membership_id: 62 }, `${label} membership.php?action=kick`);

    /* ---------- 6. banned users must not offer 封禁 ---------- */
    const banned = await page(win, `
      await closeModal();
      const five = userCard('zhangsan');
      const six = userCard('lisi');
      const cardState = { banOnFive: Boolean(byText('button', '封禁', five)), banOnSix: Boolean(byText('button', '封禁', six)) };
      click(mustByText('button', '编辑', six));
      const modal = await waitFor(() => {
        const current = visibleModal();
        const input = current && current.querySelector('.ant-form-item input');
        return input && input.value === 'lisi' ? current : null;
      }, 'the editor modal for the banned user');
      const result = { ...cardState, modalBan: Boolean(byText('button', '封禁', modal)), modalUsername: formItem('用户名').querySelector('input').value };
      await closeModal();
      return result;
    `);
    assert.equal(banned.banOnFive, true, `${label} an active user must offer 封禁`);
    assert.equal(banned.banOnSix, false, `${label} a banned user must not offer 封禁`);
    assert.equal(banned.modalBan, false, `${label} the banned user editor must not offer 封禁`);
    assert.equal(banned.modalUsername, 'lisi', `${label} the banned user editor must show the right account`);

    const ban = await page(win, `
      click(mustByText('button', '封禁', userCard('zhangsan')));
      return { popover: await confirmPopover('user 封禁') };
    `);
    assert.ok(ban.popover.includes('确定封禁用户「zhangsan」？'), `${label} 封禁 must confirm the target account (got ${ban.popover})`);
    await waitUntil(() => userMutationRequests('delete').length > 0, `${label} the users.php?action=delete request`);
    assertExactBody(userMutationRequests('delete').pop(), { id: 5 }, `${label} users.php?action=delete`);

    /* ---------- 7. 江苏专项 lists only the Jiangsu clubs ---------- */
    const jiangsu = await page(win, `
      await switchTab('江苏专项');
      const rows = await waitFor(() => {
        const found = $$('.ant-table-tbody tr.ant-table-row');
        return found.length ? found : null;
      }, 'the Jiangsu club table');
      const findRow = (text) => rows.find((node) => norm(node).includes(text)) || null;
      const cityOf = (text) => {
        const row = findRow(text);
        if (!row) throw new Error('missing city row for ' + text);
        return norm(row.querySelector('.ant-select-selection-item'));
      };
      return {
        count: rows.length,
        texts: rows.map(norm),
        hasBeijing: rows.some((node) => norm(node).includes('北京测试同好会')),
        cityClubOne: cityOf('江苏测试同好会'),
        cityClubThree: cityOf('苏州测试同好会'),
        component: document.querySelector('#clubManagerContent .cm-page').dataset.component || '',
        bodyWidth: bodyWidth(),
        innerWidth,
      };
    `);
    assert.equal(jiangsu.component, '江苏同好会专项设置', `${label} clicking 江苏专项 must mount the Jiangsu module`);
    assert.equal(jiangsu.count, 2, `${label} the Jiangsu table must list exactly the two Jiangsu clubs (got ${JSON.stringify(jiangsu.texts)})`);
    assert.ok(jiangsu.texts.some((text) => text.includes('江苏测试同好会')), `${label} 江苏测试同好会 must be listed`);
    assert.ok(jiangsu.texts.some((text) => text.includes('苏州测试同好会')), `${label} 苏州测试同好会 must be listed`);
    assert.equal(jiangsu.hasBeijing, false, `${label} 北京测试同好会 must not be listed`);
    assert.equal(jiangsu.cityClubThree, '苏州', `${label} club 3 must keep its preset city 苏州 (got ${jiangsu.cityClubThree})`);
    assert.ok(jiangsu.bodyWidth <= jiangsu.innerWidth + 1, `${label} 江苏专项 must not overflow horizontally (${jiangsu.bodyWidth} > ${jiangsu.innerWidth})`);

    /* ---------- 8. saving the city bulk update ---------- */
    const cityPicked = await page(win, `
      const row = $$('.ant-table-tbody tr.ant-table-row').find((node) => norm(node).includes('江苏测试同好会'));
      await openSelect(row.querySelector('.ant-select'));
      await pickOption('南京');
      return norm(row.querySelector('.ant-select-selection-item'));
    `);
    assert.equal(cityPicked, '南京', `${label} club 1 must accept the city 南京`);

    const firstSave = await saveAll(win, 2, label);
    assert.deepEqual(firstSave.map((entry) => parseJson(entry.body)), [
      { id: 1, country: 'china', city: '南京', operation: 'jiangsu_city_bulk' },
      { id: 3, country: 'china', city: '苏州', operation: 'jiangsu_city_bulk' },
    ], `${label} 保存全部 must PUT every listed club`);

    /* ---------- 8b. a partially failing save must report both counters ---------- */
    fixtureState.failPutClubIds = [3];
    const errorBefore = (await messageTexts(win)).filter((text) => text.includes('已保存 1 个，失败 1 个')).length;
    await saveAll(win, 2, label);
    await waitForNewMessage(win, '已保存 1 个，失败 1 个', errorBefore, `${label} 已保存 1 个，失败 1 个`);

    fixtureState.failPutClubIds = [];
    const successBefore = (await messageTexts(win)).filter((text) => text.includes('已保存全部 2 个同好会')).length;
    await saveAll(win, 2, label);
    await waitForNewMessage(win, '已保存全部 2 个同好会', successBefore, `${label} 已保存全部 2 个同好会`);

    assert.equal(consoleErrors.length, 0, `${label} must not log errors or warnings: ${consoleErrors.join('; ')}`);
    console.log(`OK ${label} users=${list.cards.length} jiangsu=${jiangsu.count} puts=${putRequests().length} menu=${nav.menuLabels.length} width=${jiangsu.innerWidth} saveNotice=${editor.noticeMs}ms close=${editor.closeMs}ms`);
  } finally {
    win.destroy();
  }
}

async function saveAll(win, expectedPuts, label) {
  const before = putRequests().length;
  await page(win, `
    const button = mustByText('#clubManagerContent .cm-page-heading button', '保存全部');
    if (String(button.className).includes('ant-btn-loading')) throw new Error('保存全部 was clicked while already saving');
    click(button);
    return true;
  `);
  await waitUntil(() => putRequests().length >= before + expectedPuts, `${label} ${expectedPuts} clubs.php PUT requests`);
  await waitUntil(() => page(win, `
    const button = document.querySelector('#clubManagerContent .cm-page-heading button');
    return Boolean(button) && !String(button.className).includes('ant-btn-loading');
  `), `${label} the 保存全部 button to become idle`);
  return putRequests().slice(before, before + expectedPuts);
}

/* ------------------------------------------------------------------ manager run */

async function runManager(baseUrl, name, size, theme) {
  const label = `${name}/${theme}`;
  fixtureState.identity = 'manager';
  fixtureState.failPutClubIds = [];
  fixtureState.flashProbe = true;
  fixtureState.requests = [];

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
    await win.loadURL(`${baseUrl}/admin/club_manager.html?admin_test=1&identity=manager&tab=jiangsu`);
    await waitForShell(win);
    await page(win, `document.documentElement.dataset.theme = ${JSON.stringify(theme)};`);

    const noticeSeen = await waitForNewMessage(win, '该功能仅限超级管理员使用', 0, `${label} the super-admin-only notice`);
    assert.equal(noticeSeen, true, `${label} a deep link to a super-admin tab must warn the manager`);

    const state = await page(win, `
      await sleep(200);
      const menuLabels = (await openNav()).map(norm);
      const content = document.querySelector('#clubManagerContent');
      return {
        menuLabels,
        activeItem: norm(document.querySelector('.cm-nav-wrap .ant-menu-item-selected')),
        component: content.querySelector('.cm-page') ? (content.querySelector('.cm-page').dataset.component || '') : '',
        headings: $$('.cm-page-heading', content).map(norm),
        hasJiangsuSave: Boolean(byText('#clubManagerContent button', '保存全部')),
        hasTable: Boolean(content.querySelector('.ant-table')),
        contentText: norm(content),
        probe: window.__cmAdminProbe || null,
        url: window.location.search,
        bodyWidth: bodyWidth(),
        innerWidth,
      };
    `);
    for (const shared of ['待审核', '成员', '设置']) {
      assert.ok(state.menuLabels.some((text) => text.includes(shared)), `${label} the navigation must keep ${shared}`);
    }
    for (const restricted of ['江苏专项', '用户管理']) {
      assert.equal(state.menuLabels.some((text) => text.includes(restricted)), false, `${label} the navigation must hide ${restricted} from a manager`);
    }
    assert.ok(state.activeItem.includes('待审核'), `${label} ?tab=jiangsu must fall back to 待审核 (got ${state.activeItem})`);
    assert.equal(state.component, '同好会管理-pending', `${label} ?tab=jiangsu must mount the pending module (got ${state.component})`);
    assert.equal(state.hasTable, false, `${label} ?tab=jiangsu must never render the Jiangsu table`);
    assert.equal(state.hasJiangsuSave, false, `${label} ?tab=jiangsu must never render the 保存全部 action`);
    assert.equal(state.contentText.includes('未设置（自动匹配）'), false, `${label} ?tab=jiangsu must not render Jiangsu rows`);
    assert.equal(state.contentText.includes('用户管理'), false, `${label} ?tab=jiangsu must not render the user management module`);
    assert.equal(state.url.includes('tab=jiangsu'), false, `${label} the refused tab must be dropped from the URL (got ${state.url})`);
    assert.ok(state.probe, `${label} the flash probe must be installed`);
    assert.deepEqual(state.probe.flash, [], `${label} a restricted tab must never flash for a manager`);
    assert.ok(state.probe.components.includes('同好会管理-pending'), `${label} the pending module must be the first and only module mounted (got ${JSON.stringify(state.probe.components)})`);
    assert.equal(state.probe.components.some((item) => item === '江苏同好会专项设置' || item === '全站用户管理'), false, `${label} no restricted module may ever mount for a manager (got ${JSON.stringify(state.probe.components)})`);
    assert.ok(state.bodyWidth <= state.innerWidth + 1, `${label} the manager view must not overflow horizontally (${state.bodyWidth} > ${state.innerWidth})`);
    assert.equal(consoleErrors.length, 0, `${label} must not log errors or warnings: ${consoleErrors.join('; ')}`);
    console.log(`OK ${label} manager=restricted menu=${state.menuLabels.length} fallback=${state.activeItem} width=${state.innerWidth}`);
  } finally {
    fixtureState.flashProbe = false;
    fixtureState.identity = 'super';
    win.destroy();
  }
}

/* ------------------------------------------------------------------ entrypoint */

async function main() {
  const server = await startFixtureServer();
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const requested = process.argv.includes('--all-viewports')
    ? Object.entries(viewportSizes)
    : [['mobile', viewportSizes.mobile], ['tablet', viewportSizes.tablet], ['desktop', viewportSizes.desktop]];

  try {
    await app.whenReady();
    for (const [name, size] of requested) {
      for (const theme of ['dark', 'light']) {
        await runSuperAdmin(baseUrl, name, size, theme);
      }
    }
    for (const theme of ['dark', 'light']) {
      await runManager(baseUrl, 'narrowMobile', viewportSizes.narrowMobile, theme);
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
    /* app.quit() always terminates Electron with code 0, so a failing run has to
       force the exit status or a chained `&&` script would report success. */
    if (app?.exit) app.exit(1);
  });
}
