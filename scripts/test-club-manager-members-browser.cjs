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

/* Two members: one manager (three action controls plus the mail setting) and one
   plain member (three action controls), both with every super-admin-only field. */
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

const membershipRows = [
  {
    id: 21,
    club_id: 1,
    country: 'china',
    username: '本校待审核用户',
    status: 'pending',
    join_method: 'school_code',
    apply_role: 'member',
    contact_account: 'qq-pending-123',
    joined_at: '2026-06-01 12:30:00',
    apply_reason: '',
    avatar_url: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
  },
  {
    id: 22,
    club_id: 1,
    country: 'china',
    username: '外交申请长用户名测试账号',
    status: 'pending',
    join_method: 'external_exchange',
    external_club_name: '一个名称很长的外校同好会交流组织示例',
    external_club_role: '外校社团负责人兼联络人',
    contact_account: 'discord: vnfest-diplomatic-contact',
    joined_at: '2026-06-02 14:45:00',
    apply_reason: '希望与贵校同好会建立长期交流关系，围绕作品分享、线下活动协作和新生入门经验开展合作，并先通过线上会议确认双方的活动安排与联系人。',
  },
  {
    id: 23,
    club_id: 1,
    country: 'china',
    username: '已通过历史用户',
    status: 'active',
    join_method: 'normal',
    apply_role: 'member',
    contact_account: '未填写',
    joined_at: '2026-05-20 09:15:00',
    apply_reason: '',
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
      return json(res, { success: true, memberships: membershipRows });
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
    const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('#root .cm-app'))`);
    if (ready) return;
    await wait(100);
  }
  const diagnostic = await win.webContents.executeJavaScript(`({ text: document.body.innerText.slice(0, 500), html: document.body.innerHTML.slice(0, 500) })`);
  throw new Error(`fixture club option did not load: ${JSON.stringify(diagnostic)}`);
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
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        document.documentElement.dataset.theme = ${JSON.stringify(theme)};
        const needsDrawer = Boolean(document.querySelector('.cm-menu-toggle'));
        if (needsDrawer) {
          document.querySelector('.cm-menu-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await wait(220);
        }
        document.querySelector('#clubSelector').closest('.ant-select').querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await wait(120);
        Array.from(document.querySelectorAll('.ant-select-item-option')).find(node => node.innerText.includes('成员布局测试同好会'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await wait(140);

        const clickTab = async (label, selector) => {
          Array.from(document.querySelectorAll('.ant-menu-item')).find(node => node.innerText.includes(label))?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          for (let attempt = 0; attempt < 30; attempt += 1) {
            if (document.querySelector(selector)) break;
            await wait(100);
          }
          await wait(160);
        };
        const columnCount = (node) => {
          if (!node) return 0;
          const tracks = getComputedStyle(node).gridTemplateColumns;
          return tracks && tracks !== 'none' ? tracks.split(' ').filter(Boolean).length : 0;
        };
        const inspectItems = (selector, { expectedRows, expectedActions, requiredText = [] } = {}) => {
          const rows = Array.from(document.querySelectorAll(selector));
          const firstRow = rows[0] || null;
          const actionSlots = rows.flatMap((row) => Array.from(row.querySelectorAll('.cm-item-actions')));
          const controls = actionSlots.flatMap((slot) => Array.from(slot.querySelectorAll('button')));
          const actionOverflow = rows.some((row) => {
            const rowRect = row.getBoundingClientRect();
            return Array.from(row.querySelectorAll('.cm-item-actions button')).some((control) => {
              const rect = control.getBoundingClientRect();
              return rect.left < rowRect.left - 1 || rect.right > rowRect.right + 1;
            });
          });
          const actionDocked = actionSlots.every((slot) => {
            const row = slot.closest('.cm-management-item');
            const rowRect = row.getBoundingClientRect();
            const slotRect = slot.getBoundingClientRect();
            const paddingRight = parseFloat(getComputedStyle(row).paddingRight) || 0;
            return rowRect.right - slotRect.right <= paddingRight + 2;
          });
          return {
            rows: rows.length,
            expectedRows,
            expectedActions,
            actions: controls.length,
            actionSlots: actionSlots.length,
            actionOverflow,
            actionDocked,
            rowColumns: columnCount(firstRow),
            rowHeight: firstRow ? Math.round(firstRow.getBoundingClientRect().height) : 0,
            requiredText: requiredText.every((item) => document.body.innerText.includes(item)),
            approvedActionSlotCount: rows.filter((row) => row.classList.contains('is-readonly')).reduce((count, row) => count + row.querySelectorAll('.cm-item-actions').length, 0),
            cardCount: rows.reduce((count, row) => count + row.querySelectorAll('.ant-card').length, 0),
          };
        };

        await clickTab('成员', '.cm-member-item');
        const memberRows = Array.from(document.querySelectorAll('.cm-member-list .cm-member-item'));
        const memberControls = memberRows.flatMap((row) => Array.from(row.querySelectorAll('.cm-member-actions button')));
        const memberActionOverflow = memberRows.some((row) => {
          const rowRect = row.getBoundingClientRect();
          return Array.from(row.querySelectorAll('.cm-member-actions button')).some((control) => {
            const rect = control.getBoundingClientRect();
            return rect.left < rowRect.left - 1 || rect.right > rowRect.right + 1;
          });
        });
        const memberFirst = memberRows[0] || null;
        const member = {
          rows: memberRows.length,
          metaItemCount: document.querySelectorAll('.cm-member-list .cm-meta-item').length,
          actionCount: memberControls.length,
          settingCount: document.querySelectorAll('.cm-member-list .cm-setting-line').length,
          actionOverflow: memberActionOverflow,
          rowColumns: columnCount(memberFirst),
          rowHeight: memberFirst ? Math.round(memberFirst.getBoundingClientRect().height) : 0,
          metaValueWidths: Array.from(document.querySelectorAll('.cm-member-list .cm-meta-value')).map((node) => Math.round(node.getBoundingClientRect().width)),
          primaryMinHeights: Array.from(document.querySelectorAll('.cm-member-actions .ant-btn-primary, .cm-member-actions .ant-btn-dangerous')).map((item) => Math.round(item.getBoundingClientRect().height)),
          secondaryMinHeights: Array.from(document.querySelectorAll('.cm-member-actions .ant-btn-default:not(.ant-btn-dangerous)')).map((item) => Math.round(item.getBoundingClientRect().height)),
          chipCount: document.querySelectorAll('.cm-member-list .cm-chip').length,
          cardCount: document.querySelectorAll('.cm-member-list .ant-card').length,
          hasRequiredFields: ['昵称', '邮箱', 'QQ', '申请身份', '学生', '加入于'].every(label => document.body.innerText.includes(label)),
        };

        await clickTab('待审核', '.cm-membership-list.is-pending .cm-membership-item');
        const pending = inspectItems('.cm-membership-list.is-pending .cm-membership-item', { requiredText: ['本校待审核用户', '申请方式', '申请身份', '联系方式', '申请时间', '待审核'] });
        pending.hasAvatarImage = Boolean(document.querySelector('.cm-membership-list.is-pending .cm-identity .ant-avatar img[src^="data:image/"]'));
        pending.hasFallbackAvatar = Boolean(document.querySelector('.cm-membership-list.is-pending .cm-profile-avatar.is-fallback'));
        pending.hasBrokenFallbackImage = Boolean(document.querySelector('.cm-membership-list.is-pending .cm-profile-avatar.is-fallback img'));
        await clickTab('外交申请', '.cm-membership-list.is-diplomatic .cm-membership-item');
        const diplomaticReason = document.querySelector('.cm-membership-list.is-diplomatic .cm-disclosure-copy');
        const diplomaticToggle = document.querySelector('.cm-membership-list.is-diplomatic .cm-disclosure-toggle');
        const diplomaticToggleInitially = diplomaticToggle?.innerText || '';
        const diplomaticCollapsedHeight = diplomaticReason ? Math.round(diplomaticReason.getBoundingClientRect().height) : 0;
        const diplomaticLineHeight = diplomaticReason ? parseFloat(getComputedStyle(diplomaticReason).lineHeight) : 0;
        diplomaticToggle?.click();
        await wait(60);
        const diplomaticExpandedHeight = diplomaticReason ? Math.round(diplomaticReason.getBoundingClientRect().height) : 0;
        const diplomatic = inspectItems('.cm-membership-list.is-diplomatic .cm-membership-item', { requiredText: ['外交申请长用户名测试账号', '外校身份', '联系方式', '申请时间', '收起理由', '待审核'] });
        diplomatic.toggleInitially = diplomaticToggleInitially;
        diplomatic.expandedReasonText = diplomaticReason?.innerText || '';
        diplomatic.reasonCollapsedToTwoLines = diplomaticCollapsedHeight <= diplomaticLineHeight * 2.2;
        diplomatic.reasonExpanded = diplomaticExpandedHeight >= diplomaticCollapsedHeight;
        diplomatic.hasFallbackAvatar = Boolean(document.querySelector('.cm-membership-list.is-diplomatic .cm-profile-avatar.is-fallback'));
        diplomatic.hasBrokenFallbackImage = Boolean(document.querySelector('.cm-membership-list.is-diplomatic .cm-profile-avatar.is-fallback img'));
        await clickTab('已通过', '.cm-membership-list.is-approved .cm-membership-item');
        const approved = inspectItems('.cm-membership-list.is-approved .cm-membership-item', { requiredText: ['已通过历史用户', '申请方式', '申请身份', '联系方式', '申请时间', '已通过'] });

        const bodyWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
        const headerRect = document.querySelector('.cm-topbar').getBoundingClientRect();
        let navTop = document.querySelector('.cm-sidebar')?.getBoundingClientRect().top ?? null;
        let duplicateBrand = Boolean(document.querySelector('.cm-sidebar')?.innerText.includes('VNFest'));
        if (needsDrawer) {
          const drawer = Array.from(document.querySelectorAll('.ant-drawer-content-wrapper')).find(node => getComputedStyle(node).display !== 'none');
          if (drawer) {
            navTop = drawer.getBoundingClientRect().top;
            duplicateBrand = Boolean(drawer.innerText.includes('VNFest'));
          } else {
            /* Selecting a tab closes the mobile drawer; the hidden navigation has
               no visible rectangle, so the shell's top edge is the stable boundary. */
            navTop = headerRect.bottom;
          }
        }
        return {
          innerWidth,
          bodyRight: Math.round(document.body.getBoundingClientRect().right),
          bodyWidth,
          member,
          pending,
          diplomatic,
          approved,
          headerLeft: Math.round(headerRect.left),
          headerRight: Math.round(headerRect.right),
          headerHeight: Math.round(headerRect.height),
          navTop: navTop === null ? null : Math.round(navTop),
          duplicateBrand,
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
        const where = `${name}/${theme}`;
        assert.equal(result.consoleErrors.length, 0, `${where} should not add console errors: ${result.consoleErrors.join('; ')}`);
        assert.equal(result.member.rows, 2, `${where} should render fixture members`);
        assert.equal(result.member.metaItemCount, 12, `${where} each member row should expose compact metadata items`);
        assert.equal(result.member.actionCount, 6, `${where} the two member rows should expose six row actions`);
        assert.equal(result.member.settingCount, 1, `${where} only the manager row should expose the mail setting`);
        assert.equal(result.member.actionOverflow, false, `${where} member actions should stay inside the row`);
        assert.equal(result.member.chipCount, 2, `${where} each member row should show a role chip`);
        assert.equal(result.member.cardCount, 0, `${where} member rows must not nest heavy antd cards`);
        assert.equal(result.pending.rows, 1, `${where} should render the ordinary pending application`);
        assert.equal(result.pending.actions, 2, `${where} pending applications should expose approve and reject`);
        assert.equal(result.pending.actionSlots, 1, `${where} pending applications should use one fixed action slot`);
        assert.equal(result.pending.actionOverflow, false, `${where} pending actions should stay inside the row`);
        assert.equal(result.pending.requiredText, true, `${where} pending applications should keep their core fields`);
        assert.equal(result.pending.hasAvatarImage, true, `${where} pending applications should render the supplied avatar image`);
        assert.equal(result.pending.hasFallbackAvatar, false, `${where} pending applications with a valid avatar should not use the fallback`);
        assert.equal(result.pending.hasBrokenFallbackImage, false, `${where} pending fallback avatars must not contain broken images`);
        assert.equal(result.diplomatic.rows, 1, `${where} should render the diplomatic application`);
        assert.equal(result.diplomatic.actions, 2, `${where} diplomatic applications should expose approve and reject`);
        assert.equal(result.diplomatic.actionSlots, 1, `${where} diplomatic applications should use one fixed action slot`);
        assert.equal(result.diplomatic.actionOverflow, false, `${where} diplomatic actions should stay inside the row`);
        assert.equal(result.diplomatic.requiredText, true, `${where} diplomatic applications should keep their relation fields`);
        assert.equal(result.diplomatic.toggleInitially, '展开理由', `${where} diplomatic reason should be collapsed by default`);
        assert.equal(result.diplomatic.reasonCollapsedToTwoLines, true, `${where} diplomatic reason should be limited to two lines`);
        assert.equal(result.diplomatic.reasonExpanded, true, `${where} diplomatic reason should expand after activation`);
        assert.ok(result.diplomatic.expandedReasonText.includes('长期交流关系'), `${where} expanded diplomatic reason should expose the full text`);
        assert.equal(result.diplomatic.hasFallbackAvatar, true, `${where} missing diplomatic avatars should render the fallback pattern`);
        assert.equal(result.diplomatic.hasBrokenFallbackImage, false, `${where} diplomatic fallback avatars must not contain broken images`);
        assert.equal(result.approved.rows, 1, `${where} should render the approved history record`);
        assert.equal(result.approved.actions, 0, `${where} approved history must not expose review actions`);
        assert.equal(result.approved.actionSlots, 0, `${where} approved history must not reserve an action slot`);
        assert.equal(result.approved.approvedActionSlotCount, 0, `${where} approved history must remain read-only`);
        assert.equal(result.approved.requiredText, true, `${where} approved history should keep its compact fields`);
        assert.equal(result.approved.cardCount, 0, `${where} membership rows must not nest heavy antd cards`);
        assert.equal(result.bodyWidth <= result.innerWidth + 1, true, `${where} should not horizontally overflow`);
        assert.equal(result.member.hasRequiredFields, true, `${where} should keep all super-admin member fields`);
        assert.equal(result.headerLeft, 0, `${where} topbar must start at the viewport edge`);
        assert.equal(result.headerRight, result.bodyRight, `${where} topbar must span the page content width`);
        assert.equal(result.navTop >= result.headerHeight - 1, true, `${where} navigation must start below the topbar (nav=${result.navTop}, height=${result.headerHeight})`);
        assert.equal(result.duplicateBrand, false, `${where} sidebar/drawer must not repeat the VNFest brand`);
        /* Density regression guards: desktop rows use explicit columns; stacked phone
           rows may grow, but long values must still have measurable space. */
        assert.equal(result.member.rowHeight <= (size.width <= 899 ? 470 : 270), true, `${where} member rows must stay compact (got ${result.member.rowHeight}px)`);
        assert.equal(result.member.metaValueWidths.every((width) => width > 0), true, `${where} member metadata values must not collapse (${result.member.metaValueWidths.join(',')})`);
        for (const [kind, item] of [['pending', result.pending], ['diplomatic', result.diplomatic], ['approved', result.approved]]) {
          assert.equal(item.rowHeight <= (size.width <= 899 ? 500 : 300), true, `${where} ${kind} rows must stay within the item density budget (got ${item.rowHeight}px)`);
        }
        if (size.width <= 899) {
          assert.equal(result.member.rowColumns, 1, `${where} member rows must stack before the tablet breakpoint`);
          assert.equal(result.pending.rowColumns, 1, `${where} pending rows must stack before the tablet breakpoint`);
          assert.equal(result.diplomatic.rowColumns, 1, `${where} diplomatic rows must stack before the tablet breakpoint`);
          assert.equal(result.approved.rowColumns, 1, `${where} approved rows must stack before the tablet breakpoint`);
        } else {
          assert.equal(result.member.rowColumns, 4, `${where} desktop member rows must keep identity / info / context / action columns`);
          assert.equal(result.pending.rowColumns, 4, `${where} pending rows must keep the fixed review column`);
          assert.equal(result.diplomatic.rowColumns, 4, `${where} diplomatic rows must keep the fixed review column`);
          assert.equal(result.approved.rowColumns, 3, `${where} approved rows must drop the empty action column`);
          assert.equal(result.pending.actionDocked, true, `${where} pending actions must stay at the right edge`);
          assert.equal(result.diplomatic.actionDocked, true, `${where} diplomatic actions must stay at the right edge`);
        }
        if (size.width <= 680) {
          assert.equal(result.member.primaryMinHeights.every((height) => height >= 44), true, `${where} primary/destructive member actions must keep 44px targets (${result.member.primaryMinHeights.join(',')})`);
          assert.equal(result.member.secondaryMinHeights.every((height) => height >= 26), true, `${where} secondary member actions must stay compact but tappable (${result.member.secondaryMinHeights.join(',')})`);
        }
        console.log(`OK ${where} members=${result.member.rows} review=${result.pending.rows}/${result.diplomatic.rows}/${result.approved.rows} memberHeight=${result.member.rowHeight} cols=${result.member.rowColumns} width=${result.innerWidth}`);
      }
    }
    const desktop = results.find((item) => item.name === 'desktop');
    assert.equal(desktop.headerHeight, 56, `the desktop topbar must be tightened to 56px (got ${desktop.headerHeight})`);
  } finally {
    await app.quit();
    await new Promise((resolve) => server.close(resolve));
  }
}

if (app?.whenReady && BrowserWindow) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
    if (app?.exit) app.exit(1);
  });
}
