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

/* Club id 1 deliberately exists in both China and Japan: every club-scoped view
   must key on club_id + country, never on the id alone. */
const CHINA_CLUBS = [
  { id: 1, name: '中国测试同好会', school: '中国测试学校', country: 'china' },
  { id: 2, name: '第二同好会', school: '第二学校', country: 'china' },
];
const JAPAN_CLUBS = [{ id: 1, name: '日本测试同好会', school: '日本テスト', country: 'japan' }];

const MEMBERSHIPS = [
  { id: 1, club_id: 1, country: 'china', username: 'pending-one', status: 'pending', join_method: 'school_no_code', apply_role: 'member', joined_at: '2026-09-01 10:00:00' },
  { id: 2, club_id: 1, country: 'china', username: 'pending-external', status: 'pending', join_method: 'external_exchange', apply_role: 'external', joined_at: '2026-09-02 10:00:00' },
  { id: 3, club_id: 1, country: 'china', username: 'active-china', status: 'active', join_method: 'school_code', apply_role: 'member', joined_at: '2026-09-03 10:00:00' },
  { id: 4, club_id: 1, country: 'japan', username: 'active-japan', status: 'active', join_method: 'school_code', apply_role: 'member', joined_at: '2026-09-04 10:00:00' },
  { id: 5, club_id: 2, country: 'china', username: 'pending-two', status: 'pending', join_method: 'school_no_code', apply_role: 'member', joined_at: '2026-09-05 10:00:00' },
];

const ROSTERS = {
  '1|china': [
    { id: 11, user_id: 11, username: 'member-a', role: 'representative', status: 'active' },
    { id: 12, user_id: 12, username: 'member-b', role: 'member', status: 'active' },
    { id: 13, user_id: 13, username: 'member-external', role: 'external', status: 'active' },
  ],
  '1|japan': [
    { id: 21, user_id: 21, username: 'nihon-a', role: 'representative', status: 'active' },
    { id: 22, user_id: 22, username: 'nihon-b', role: 'member', status: 'active' },
  ],
  '2|china': [],
};

const SHARED_TABS = ['待审核', '外交申请', '已通过', '成员', '设置', '绑定码', 'Bot 接入', '神器榜', '企划枢纽', '考核设置'];
const SUPER_ONLY_TABS = ['江苏专项', '用户管理'];

const fixtureState = { requests: [], identity: 'super' };

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
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;
    const action = requestUrl.searchParams.get('action') || '';
    if (pathname.startsWith('/api/')) {
      fixtureState.requests.push({ pathname, search: requestUrl.search, action });
    }

    if (pathname === '/api/auth.php') return json(res, identityPayload());
    if (pathname === '/api/clubs.php') return json(res, { data: CHINA_CLUBS });
    if (pathname === '/api/clubs_japan.php') return json(res, { data: JAPAN_CLUBS });
    if (pathname === '/api/membership.php' && action === 'pending') {
      return json(res, { success: true, memberships: MEMBERSHIPS });
    }
    if (pathname === '/api/membership.php' && action === 'members') {
      const clubId = requestUrl.searchParams.get('club_id') || '0';
      const country = requestUrl.searchParams.get('country') || 'china';
      return json(res, { success: true, members: ROSTERS[`${clubId}|${country}`] || [] });
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

async function settle(win, expression, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await win.webContents.executeJavaScript(expression)) return true;
    await wait(100);
  }
  return false;
}

async function openShell(baseUrl, size, theme, query = '') {
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: size.width,
    height: size.height,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) consoleErrors.push(message);
  });
  await win.loadURL(`${baseUrl}/admin/club_manager.html?shell_test=1${query}`);
  const booted = await settle(win, `Boolean(document.querySelector('#root .cm-app'))`);
  if (!booted) {
    const diagnostic = await win.webContents.executeJavaScript(`document.body.innerText.slice(0, 400)`);
    win.destroy();
    throw new Error(`shell did not boot: ${diagnostic}`);
  }
  /* Drive the real theme runtime so the app's own theme subscription — and the
     Ant Design token refresh behind it — runs exactly as a user toggle would. */
  await win.webContents.executeJavaScript(`window.VNFTheme.setPreference(${JSON.stringify(theme)})`);
  await wait(280);
  /* Below 1100px the navigation lives in a drawer, so it has to be opened before
     any sidebar metric can be read. */
  const needsDrawer = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.cm-menu-toggle'))`);
  if (needsDrawer) {
    await win.webContents.executeJavaScript(`document.querySelector('.cm-menu-toggle').click()`);
    const opened = await settle(win, `Boolean(document.querySelector('.cm-nav-wrap'))`);
    if (!opened) { win.destroy(); throw new Error('the mobile drawer did not expose the navigation'); }
    await wait(220);
  }
  return { win, consoleErrors, needsDrawer };
}

function inspectScript() {
  return `
    (() => {
      /* Chromium serialises color-mix() results as color(srgb r g b / a) with
         0-1 components, while plain tokens come back as rgb()/rgba(). */
      const parseColor = (value) => {
        const text = String(value || '').trim();
        const legacy = text.match(/rgba?\\(([^)]+)\\)/);
        if (legacy) {
          const parts = legacy[1].split(/[\\s,/]+/).filter(Boolean).map((item) => parseFloat(item));
          if (parts.length >= 3 && parts.slice(0, 3).every((item) => Number.isFinite(item))) return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
          return null;
        }
        const modern = text.match(/color\\(srgb\\s+([^)]+)\\)/);
        if (modern) {
          const parts = modern[1].split(/[\\s,/]+/).filter(Boolean).map((item) => parseFloat(item));
          if (parts.length >= 3 && parts.slice(0, 3).every((item) => Number.isFinite(item))) return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a: parts.length > 3 ? parts[3] : 1 };
          return null;
        }
        return null;
      };
      const luminance = (value) => {
        const rgb = parseColor(value);
        if (!rgb) return null;
        const lin = (channel) => { const s = channel / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
        return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
      };
      const hexToRgb = (value) => {
        const hex = String(value || '').trim().replace('#', '');
        if (hex.length !== 6) return null;
        return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
      };
      const root = document.documentElement;
      const rootStyle = getComputedStyle(root);
      const header = document.querySelector('.cm-topbar');
      const headerRect = header.getBoundingClientRect();
      const sider = document.querySelector('.cm-sidebar');
      const drawerWrapper = document.querySelector('.ant-drawer-content-wrapper');
      const drawerPanel = document.querySelector('.ant-drawer-content');
      const navHost = sider || drawerPanel;
      const navWrap = document.querySelector('.cm-nav-wrap');
      const activeItem = navWrap ? navWrap.querySelector('.ant-menu-item-selected') : null;
      const sliderY = navWrap ? parseFloat(getComputedStyle(navWrap).getPropertyValue('--cm-slider-y')) : null;
      const sliderHeight = navWrap ? (parseFloat(getComputedStyle(navWrap).getPropertyValue('--cm-slider-height')) || 20) : 20;
      const expectedSliderY = activeItem ? activeItem.offsetTop + Math.max(0, (activeItem.offsetHeight - sliderHeight) / 2) : null;
      const clubSelect = document.querySelector('#clubSelector');
      const menuItems = Array.from(document.querySelectorAll('.cm-nav-wrap .ant-menu-item'));
      const primaryToken = rootStyle.getPropertyValue('--vn-primary').trim();
      return {
        theme: root.getAttribute('data-theme'),
        isDark: root.getAttribute('data-theme') === 'dark',
        cmPrimary: rootStyle.getPropertyValue('--cm-primary').trim(),
        vnPrimary: primaryToken,
        cmSurface: rootStyle.getPropertyValue('--cm-surface').trim(),
        vnSurface: rootStyle.getPropertyValue('--vn-surface').trim(),
        cmBg: rootStyle.getPropertyValue('--cm-bg').trim(),
        vnBg: rootStyle.getPropertyValue('--vn-bg').trim(),
        headerLuminance: luminance(getComputedStyle(header).backgroundColor),
        navLuminance: navHost ? luminance(getComputedStyle(navHost).backgroundColor) : null,
        bodyLuminance: luminance(getComputedStyle(document.body).backgroundColor),
        headerLeft: Math.round(headerRect.left),
        headerRight: Math.round(headerRect.right),
        headerHeight: Math.round(headerRect.height),
        bodyRight: Math.round(document.body.getBoundingClientRect().right),
        innerWidth,
        bodyWidth: Math.max(root.scrollWidth, document.body.scrollWidth),
        navTop: navHost ? Math.round(navHost.getBoundingClientRect().top) : null,
        drawerTop: drawerWrapper ? Math.round(drawerWrapper.getBoundingClientRect().top) : null,
        navText: navHost ? navHost.innerText : '',
        sliderReady: navWrap ? navWrap.dataset.sliderReady === 'true' : false,
        sliderDriver: navWrap ? navWrap.dataset.sliderDriver || '' : '',
        sliderHeight,
        sliderWidth: navWrap ? parseFloat(getComputedStyle(navWrap, '::before').width) || 0 : 0,
        sliderOpacity: navWrap ? parseFloat(getComputedStyle(navWrap, '::before').opacity) : null,
        sliderTransform: navWrap ? getComputedStyle(navWrap, '::before').transform : '',
        sliderMatchesActive: activeItem !== null && sliderY !== null && expectedSliderY !== null && Math.abs(sliderY - expectedSliderY) <= 1.5,
        sliderInActive: activeItem !== null && sliderY !== null && sliderY >= activeItem.offsetTop - 1 && sliderY + sliderHeight <= activeItem.offsetTop + activeItem.offsetHeight + 1,
        sliderColor: navWrap ? parseColor(getComputedStyle(navWrap, '::before').backgroundColor) : null,
        expectedPrimary: hexToRgb(primaryToken),
        clubSelectLabel: clubSelect ? (clubSelect.closest('.ant-select')?.querySelector('.ant-select-selection-item')?.textContent || '') : '',
        activeLabel: activeItem?.innerText.replace(/\s+/g, ' ').trim() || '',
        statValues: Array.from(document.querySelectorAll('.cm-stats .ant-statistic')).map((node) => ({
          title: node.querySelector('.ant-statistic-title')?.textContent?.trim() || '',
          value: node.querySelector('.ant-statistic-content-value')?.textContent?.trim() || '',
        })),
        menuLabels: menuItems.map((node) => node.innerText.replace(/\\s+/g, ' ').trim()),
        menuMinHeights: menuItems.map((node) => Math.round(node.getBoundingClientRect().height)),
        topbarButtonHeights: Array.from(document.querySelectorAll('.cm-topbar-actions .ant-btn')).map((node) => Math.round(node.getBoundingClientRect().height)),
        topbarButtonRects: Array.from(document.querySelectorAll('.cm-topbar-actions .ant-btn')).map((node) => {
          const rect = node.getBoundingClientRect();
          return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
        }),
        pendingBadge: (() => {
          const node = document.querySelector('.cm-pending-badge .ant-badge-count');
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          return { text: node.innerText.trim(), width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
        })(),
        clubSelectSearch: Boolean(document.querySelector('#clubSelector').closest('.ant-select')?.querySelector('input[role="combobox"]')),
        themeButton: Boolean(document.querySelector('.cm-topbar-actions [aria-label="切换主题"]')),
        reloadButton: Boolean(document.querySelector('.cm-topbar-actions [aria-label="刷新当前数据"]')),
      };
    })();
  `;
}

function assertTheme(result, label) {
  assert.equal(result.cmPrimary, result.vnPrimary, `${label} --cm-primary must resolve to --vn-primary (got ${result.cmPrimary} vs ${result.vnPrimary})`);
  assert.equal(result.cmSurface, result.vnSurface, `${label} --cm-surface must resolve to --vn-surface`);
  assert.equal(result.cmBg, result.vnBg, `${label} --cm-bg must resolve to --vn-bg`);
  assert.ok(result.sliderReady, `${label} the navigation selection slider must be measured`);
  assert.equal(result.sliderDriver, 'transform', `${label} the slider must be driven by transform, not top`);
  assert.ok(result.sliderHeight === 20, `${label} the slider must keep the shared 20px height (got ${result.sliderHeight})`);
  assert.ok(result.sliderWidth <= 2.5, `${label} the slider must stay thinned to ~2px (got ${result.sliderWidth})`);
  assert.ok(result.sliderOpacity !== null && result.sliderOpacity <= 0.5 && result.sliderOpacity > 0.2, `${label} the slider must stay subtle (opacity ${result.sliderOpacity})`);
  assert.match(result.sliderTransform || '', /matrix/, `${label} the slider offset must be expressed as a transform (got ${result.sliderTransform})`);
  assert.ok(result.sliderMatchesActive, `${label} the selection slider must align with the active menu item`);
  assert.ok(result.sliderInActive, `${label} the selection slider must sit inside the active menu item`);
  assert.ok(result.sliderColor && result.sliderColor.a > 0.5, `${label} the selection slider must be painted`);
  if (result.expectedPrimary) {
    assert.deepEqual(
      { r: Math.round(result.sliderColor.r), g: Math.round(result.sliderColor.g), b: Math.round(result.sliderColor.b) },
      result.expectedPrimary,
      `${label} the selection slider must use the theme primary token`,
    );
  }
  for (const key of ['headerLuminance', 'navLuminance', 'bodyLuminance']) {
    assert.ok(result[key] !== null, `${label} ${key} must resolve to a colour`);
  }
  if (result.isDark) {
    assert.ok(result.headerLuminance < 0.35, `${label} dark topbar must be dark (${result.headerLuminance})`);
    assert.ok(result.navLuminance < 0.35, `${label} dark navigation must be dark (${result.navLuminance})`);
    assert.ok(result.bodyLuminance < 0.35, `${label} dark body must be dark (${result.bodyLuminance})`);
  } else {
    assert.ok(result.headerLuminance > 0.6, `${label} light topbar must be light (${result.headerLuminance})`);
    assert.ok(result.navLuminance > 0.6, `${label} light navigation must be light (${result.navLuminance})`);
    assert.ok(result.bodyLuminance > 0.6, `${label} light body must be light (${result.bodyLuminance})`);
  }
}

function assertLayout(result, label, size) {
  assert.equal(result.headerLeft, 0, `${label} the topbar must start at the viewport edge`);
  assert.equal(result.headerRight, result.bodyRight, `${label} the topbar must span the full content width`);
  assert.ok(result.bodyWidth <= result.innerWidth + 1, `${label} must not overflow horizontally (${result.bodyWidth} > ${result.innerWidth})`);
  assert.ok(result.navTop >= result.headerHeight - 1, `${label} navigation must start below the topbar (nav=${result.navTop}, topbar=${result.headerHeight})`);
  if (size.width <= 1100) {
    assert.ok(result.drawerTop !== null && result.drawerTop >= result.headerHeight - 1, `${label} the drawer must start below the topbar (drawer=${result.drawerTop}, topbar=${result.headerHeight})`);
  }
  assert.equal(result.navText.includes('VNFest'), false, `${label} the navigation must not repeat the VNFest brand`);
  assert.equal(result.navText.includes('同好会管理'), false, `${label} the navigation must not repeat the 同好会管理 brand`);
  assert.ok(result.themeButton, `${label} the topbar must keep the theme toggle`);
  assert.ok(result.reloadButton, `${label} the topbar must keep the refresh action`);
  assert.equal(result.topbarButtonRects.length, 4, `${label} the topbar must expose four aligned actions`);
  assert.ok(result.topbarButtonRects.every((rect) => rect.height === result.topbarButtonRects[0].height), `${label} topbar actions must share one height`);
  for (let index = 1; index < result.topbarButtonRects.length; index += 1) {
    const gap = result.topbarButtonRects[index].left - result.topbarButtonRects[index - 1].right;
    assert.ok(gap >= 7 && gap <= 9, `${label} topbar actions must keep an 8px gap (got ${gap}px)`);
  }
  assert.equal(result.clubSelectSearch, true, `${label} the club selector must expose a searchable combobox`);
  assert.ok(result.pendingBadge && /^\d+\+?$/.test(result.pendingBadge.text), `${label} the pending badge must keep its readable count`);
  assert.ok(result.pendingBadge.height >= 18 && result.pendingBadge.height <= 22, `${label} the pending badge must have a compact pill height`);
  assert.ok(result.menuMinHeights.length >= SHARED_TABS.length, `${label} every shared tab must render in the navigation`);
  assert.ok(result.menuMinHeights.every((height) => height >= 36 && height <= 44), `${label} navigation items must keep the tightened 36px density (${result.menuMinHeights.join(',')})`);
  if (size.width <= 680) {
    assert.ok(result.topbarButtonHeights.length && result.topbarButtonHeights.every((height) => height >= 44), `${label} topbar actions must keep 44px touch targets (${result.topbarButtonHeights.join(',')})`);
    assert.ok(result.topbarButtonRects.every((rect) => rect.width === 44 && rect.height === 44), `${label} mobile topbar actions must be 44px squares`);
  }
}

function assertTabs(result, label, { superAdmin }) {
  /* The 待审核 entry carries a badge count, so digits are stripped before the
     label is compared; matching must stay exact, otherwise 考核设置 would be
     mistaken for 设置. */
  const normalize = (text) => String(text || '').replace(/[0-9]+/g, '').replace(/\s+/g, '');
  const labels = result.menuLabels.map(normalize);
  const order = [];
  for (const tab of SHARED_TABS) {
    const index = labels.indexOf(normalize(tab));
    assert.ok(index >= 0, `${label} the navigation must expose ${tab} (got ${result.menuLabels.join(' | ')})`);
    order.push(index);
  }
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(order[index] > order[index - 1], `${label} the tab order must stay stable`);
  }
  for (const tab of SUPER_ONLY_TABS) {
    assert.equal(labels.includes(normalize(tab)), superAdmin, `${label} ${tab} visibility must require super admin`);
  }
}

function assertStats(result, expected, label) {
  for (const [title, value] of Object.entries(expected)) {
    const entry = result.statValues.find((item) => item.title === title);
    assert.ok(entry, `${label} the sidebar must render the ${title} statistic`);
    assert.equal(entry.value, value, `${label} ${title} must be ${value} (got ${entry.value})`);
  }
}

async function main() {
  const server = await startFixtureServer();
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const requested = process.argv.includes('--all-viewports')
    ? Object.entries(viewportSizes)
    : [['mobile', viewportSizes.mobile], ['tablet', viewportSizes.tablet], ['desktop', viewportSizes.desktop]];
  const chromeLuminance = {};

  try {
    await app.whenReady();

    /* ---------- layout + theme + tabs across every viewport and theme ---------- */
    for (const [name, size] of requested) {
      for (const theme of ['dark', 'light']) {
        const { win, consoleErrors } = await openShell(baseUrl, size, theme);
        try {
          const result = await win.webContents.executeJavaScript(inspectScript());
          const label = `${name}/${theme}`;
          assert.equal(result.theme, theme, `${label} the theme runtime must apply the requested theme`);
          assertLayout(result, label, size);
          assertTheme(result, label);
          assertTabs(result, label, { superAdmin: true });
          assertStats(result, { 待审核: '3', 已通过: '2', 成员: '—', 总计: '5' }, `${label} 所有同好会`);
          assert.ok(result.clubSelectLabel.includes('所有同好会'), `${label} the default club must be 所有同好会 (got ${result.clubSelectLabel})`);
          assert.ok(result.activeLabel.includes('已通过'), `${label} an unparameterized club-manager URL must land on 已通过 (got ${result.activeLabel})`);
          assert.equal(consoleErrors.length, 0, `${label} must not log errors or warnings: ${consoleErrors.join('; ')}`);
          chromeLuminance[name] = chromeLuminance[name] || {};
          chromeLuminance[name][theme] = result.headerLuminance;
          console.log(`OK ${label} topbar=${result.headerHeight}px tabs=${result.menuLabels.length} nav=${result.drawerTop === null ? 'sider' : 'drawer'} width=${result.innerWidth}`);
        } finally {
          win.destroy();
        }
      }
      const pair = chromeLuminance[name];
      assert.ok(pair.dark < pair.light - 0.25, `${name} dark and light chrome must differ (dark=${pair.dark}, light=${pair.light})`);
    }

    /* ---------- club switching must key on club_id + country ---------- */
    {
      const { win, consoleErrors } = await openShell(baseUrl, viewportSizes.desktop, 'dark', '&tab=pending');
      try {
        const scoped = await win.webContents.executeJavaScript(`
          (async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const pick = async (label) => {
              document.querySelector('#clubSelector').closest('.ant-select').querySelector('.ant-select-selector')
                .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              await wait(150);
              const option = Array.from(document.querySelectorAll('.ant-select-item-option'))
                .find((node) => node.innerText.includes(label));
              if (!option) throw new Error('missing club option: ' + label);
              option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              await wait(340);
            };
            const read = () => ({
              active: document.querySelector('#clubSelector').closest('.ant-select').querySelector('.ant-select-selection-item')?.textContent || '',
              statValues: Array.from(document.querySelectorAll('.cm-stats .ant-statistic')).map((node) => ({
                title: node.querySelector('.ant-statistic-title')?.textContent?.trim() || '',
                value: node.querySelector('.ant-statistic-content-value')?.textContent?.trim() || '',
              })),
          rowTitles: Array.from(document.querySelectorAll('.cm-membership-item .cm-identity-text strong')).map((node) => node.innerText.trim()),
            });
            await pick('中国测试同好会'); const china = read();
            await pick('日本测试同好会'); const japan = read();
            await pick('所有同好会'); const all = read();
            return { china, japan, all };
          })();
        `);
        assert.ok(scoped.china.active.includes('中国测试同好会'), `the club selector must show the China club (got ${scoped.china.active})`);
        assert.ok(scoped.japan.active.includes('日本测试同好会'), `the club selector must show the Japan club (got ${scoped.japan.active})`);
        assertStats(scoped.china, { 待审核: '2', 已通过: '1', 成员: '2', 总计: '3' }, 'china club #1');
        assertStats(scoped.japan, { 待审核: '0', 已通过: '1', 成员: '2', 总计: '1' }, 'japan club #1 (same id, other country)');
        assertStats(scoped.all, { 待审核: '3', 已通过: '2', 成员: '—', 总计: '5' }, '所有同好会');
        assert.equal(scoped.china.rowTitles.filter((title) => title.includes('pending-one')).length, 1, 'the pending tab must list the club\'s own pending application');
        assert.equal(scoped.china.rowTitles.some((title) => title.includes('pending-two')), false, 'the pending tab must not leak another club\'s applications');
        assert.equal(scoped.japan.rowTitles.length, 0, 'the Japan club has no pending applications');

        const memberCalls = fixtureState.requests.filter((entry) => entry.action === 'members');
        assert.ok(memberCalls.some((entry) => entry.search.includes('club_id=1') && entry.search.includes('country=china')), 'the 成员 statistic must query club 1 china');
        assert.ok(memberCalls.some((entry) => entry.search.includes('club_id=1') && entry.search.includes('country=japan')), 'the 成员 statistic must query club 1 japan (composite identity)');
        assert.equal(scoped.all.statValues.find((item) => item.title === '成员').value, '—', '所有同好会 must render 成员 as —');
        assert.equal(consoleErrors.length, 0, `club switching must not log errors: ${consoleErrors.join('; ')}`);
        console.log(`OK club-switch china=${JSON.stringify(scoped.china.statValues)} japan=${JSON.stringify(scoped.japan.statValues)} all=${JSON.stringify(scoped.all.statValues)}`);
      } finally {
        win.destroy();
      }
    }

    /* ---------- a plain manager must never see the restricted tabs ---------- */
    for (const [name, size] of [['desktop', viewportSizes.desktop], ['mobile', viewportSizes.mobile]]) {
      fixtureState.identity = 'manager';
      const { win, consoleErrors } = await openShell(baseUrl, size, 'dark');
      try {
        const result = await win.webContents.executeJavaScript(inspectScript());
        const label = `${name}/manager`;
        assertLayout(result, label, size);
        assertTheme(result, label);
        assertTabs(result, label, { superAdmin: false });
        assert.equal(consoleErrors.length, 0, `${label} must not log errors: ${consoleErrors.join('; ')}`);
        console.log(`OK ${label} tabs=${result.menuLabels.length} restricted=hidden`);
      } finally {
        win.destroy();
      }

      const deepLink = await openShell(baseUrl, size, 'dark', '&tab=jiangsu');
      try {
        const state = await deepLink.win.webContents.executeJavaScript(`
          (async () => {
            await new Promise((resolve) => setTimeout(resolve, 320));
            return {
              bodyText: document.body.innerText,
              hasJiangsuTable: Array.from(document.querySelectorAll('.ant-table')).some((node) => node.innerText.includes('未设置（自动匹配）')),
              selectedTab: document.querySelector('.cm-nav-wrap .ant-menu-item-selected')?.innerText?.replace(/\\s+/g, ' ').trim() || '',
            };
          })();
        `);
        assert.equal(state.hasJiangsuTable, false, `${name}/manager ?tab=jiangsu must never render the Jiangsu table`);
        assert.equal(state.bodyText.includes('未设置（自动匹配）'), false, `${name}/manager ?tab=jiangsu must not render Jiangsu content`);
        assert.ok(state.selectedTab.includes('已通过'), `${name}/manager ?tab=jiangsu must fall back to 已通过 (got ${state.selectedTab})`);
        assert.equal(deepLink.consoleErrors.length, 0, `${name}/manager deep link must not log errors: ${deepLink.consoleErrors.join('; ')}`);
        console.log(`OK ${name}/manager ?tab=jiangsu -> ${state.selectedTab}`);
      } finally {
        deepLink.win.destroy();
      }
    }
    fixtureState.identity = 'super';

    /* ---------- the drawer must expose every tab with touch-sized targets ---------- */
    {
      const { win, consoleErrors } = await openShell(baseUrl, viewportSizes.mobile, 'dark');
      try {
        const result = await win.webContents.executeJavaScript(inspectScript());
        assertTabs(result, 'mobile/drawer', { superAdmin: true });
        assert.ok(result.menuMinHeights.every((height) => height >= 36 && height <= 44), `mobile/drawer menu items must keep the 36px density (${result.menuMinHeights.join(',')})`);
        assert.equal(consoleErrors.length, 0, `mobile/drawer must not log errors: ${consoleErrors.join('; ')}`);
        console.log(`OK mobile/drawer items=${result.menuMinHeights.length} top=${result.drawerTop}`);
      } finally {
        win.destroy();
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
    /* app.quit() always terminates Electron with code 0, so a failing run has to
       force the exit status or a chained `&&` script would report success. */
    if (app?.exit) app.exit(1);
  });
}
