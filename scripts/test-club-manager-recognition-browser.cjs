/*
 * Electron browser regression suite for the club-manager 「考核设置」(recognition) module.
 *
 * It boots the real built SPA (admin/club_manager.html -> admin/club-manager-assets) against a
 * local fixture server, drives the UI only (no React internals, no window.* app helpers) and
 * asserts both the rendered DOM and the exact HTTP payloads the module sends.
 *
 * Run: npx electron scripts/test-club-manager-recognition-browser.cjs --all-viewports
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;

const projectRoot = path.resolve(__dirname, '..');
if (app?.on) app.on('window-all-closed', (event) => event.preventDefault());
/* The suite only ever renders into hidden windows, so the GPU process buys nothing and its
   memory footprint makes long multi-viewport runs flaky. */
if (app?.disableHardwareAcceleration) app.disableHardwareAcceleration();

const viewportSizes = {
  mobile: { width: 390, height: 844 },
  narrowMobile: { width: 360, height: 800 },
  screenshotWidth: { width: 582, height: 900 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1366, height: 900 },
};

const CLUB_NAME = '考核测试同好会';
const MANAGE_FAILURE_MESSAGE = '考核服务暂时不可用';

let fixtureState;
let recorder = null;

function resetFixtureState() {
  fixtureState = {
    programs: [
      { id: 11, title: '入门知识问答', type: 'assessment', status: 'published', issued_count: 3 },
      { id: 12, title: '活动签到', type: 'activity', status: 'draft', issued_count: 0 },
    ],
    badges: [
      { id: 21, name: '入门徽章', category: 'knowledge', version: 1, image_url: '' },
    ],
    credentials: [
      { id: 31, holder_name: '张三', badge_name: '入门徽章', program_title: '入门知识问答', status: 'active', public_visibility: '1', issued_at: '2026-09-01 12:00:00' },
    ],
    submissions: [
      { id: 41, program_title: '作品提交赛', holder_username: '李四', holder_user_id: 7, content: '作品说明', created_at: '2026-09-02 12:00:00' },
    ],
    connectors: [
      { id: 51, name: '站外 Webhook', type: 'webhook', token_prefix: 'abc123', revoked_at: null },
    ],
    manageFailure: false,
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

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = [];
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const payload = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload), 0);
  return Buffer.concat([length, payload, crc]);
}

/* The recognition module renders the URL returned by badge_image.php, so the fixture set has to
   contain a real image instead of a 404. Generated in-process to avoid binary fixtures. */
function badgeFixturePng(size = 8) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const pixel = row + 1 + x * 4;
      raw[pixel] = 231; raw[pixel + 1] = 76; raw[pixel + 2] = 60; raw[pixel + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function readRawBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

/* Every recognition endpoint the tab touches. Mutating actions also move the mutable
   fixture state so the next `manage`/`badge_list`/`connector_list` reload reflects them. */
function apiResponse(pathname, action, searchParams, body) {
  if (pathname === '/api/auth.php') {
    return {
      payload: {
        logged_in: true,
        user: { id: 1, username: 'super-admin', role: 'super_admin' },
        memberships: [{ club_id: 1, country: 'china', role: 'representative', status: 'active' }],
      },
    };
  }
  if (pathname === '/api/clubs.php') {
    return { payload: { data: [{ id: 1, name: CLUB_NAME, school: '测试学校', country: 'china' }] } };
  }
  if (pathname === '/api/clubs_japan.php') {
    return { payload: { data: [] } };
  }
  if (pathname === '/api/membership.php' && action === 'pending') {
    return { payload: { success: true, memberships: [] } };
  }
  if (pathname === '/api/membership.php' && action === 'members') {
    return { payload: { success: true, members: [] } };
  }

  if (pathname === '/api/recognition_programs.php') {
    if (action === 'manage') {
      if (fixtureState.manageFailure) {
        return { status: 500, payload: { success: false, message: MANAGE_FAILURE_MESSAGE } };
      }
      return { payload: { success: true, programs: fixtureState.programs.map((item) => ({ ...item })) } };
    }
    if (action === 'badge_list') {
      return { payload: { success: true, badges: fixtureState.badges.map((item) => ({ ...item })) } };
    }
    if (action === 'caps_reference') {
      return { payload: { success: true, data: [] } };
    }
    if (action === 'detail') {
      const id = Number(searchParams.get('id'));
      const program = fixtureState.programs.find((item) => Number(item.id) === id) || { id, title: '考核方案', type: 'assessment', status: 'draft' };
      return {
        payload: {
          success: true,
          program: {
            id,
            title: program.title,
            type: program.type || 'assessment',
            status: program.status || 'draft',
          },
          version: {
            id: 101,
            version_no: 'v0.1',
            status: 'draft',
            content: {
              quiz: {
                questions: [{ id: 'q1', type: 'single', question: '1+1=?', score: 10, options: ['1', '2'], answer: [1] }],
                settings: {},
              },
              rules: { conditions: [], award: {} },
            },
          },
        },
      };
    }
    if (action === 'create') {
      fixtureState.programs = fixtureState.programs.concat([{
        id: 99,
        title: body?.title || '新方案',
        type: body?.type || 'assessment',
        status: 'draft',
        issued_count: 0,
      }]);
      return { payload: { success: true, program_id: 99 } };
    }
    if (action === 'update') {
      const id = Number(body?.program_id);
      fixtureState.programs = fixtureState.programs.map((item) => (Number(item.id) === id && body?.title ? { ...item, title: body.title } : item));
      return { payload: { success: true } };
    }
    if (action === 'publish') {
      const id = Number(body?.program_id);
      fixtureState.programs = fixtureState.programs.map((item) => (Number(item.id) === id ? { ...item, status: 'published' } : item));
      return { payload: { success: true } };
    }
    if (action === 'set_status') {
      const id = Number(body?.program_id);
      fixtureState.programs = fixtureState.programs.map((item) => (Number(item.id) === id ? { ...item, status: body?.status || item.status } : item));
      return { payload: { success: true } };
    }
    if (action === 'badge_create') {
      fixtureState.badges = fixtureState.badges.concat([{
        id: 22,
        name: body?.name || '新徽章',
        category: body?.category || 'participation',
        version: 1,
        image_url: body?.image_url || '',
      }]);
      return { payload: { success: true } };
    }
    if (action === 'badge_update') {
      return { payload: { success: true } };
    }
  }

  if (pathname === '/api/badge_image.php' && action === 'upload') {
    return { payload: { success: true, image_url: 'uploads/badge_images/cropped.png' } };
  }

  if (pathname === '/api/recognition_credentials.php') {
    if (action === 'club_list') {
      return { payload: { success: true, credentials: fixtureState.credentials.map((item) => ({ ...item })) } };
    }
    if (action === 'grant') {
      return { payload: { success: true } };
    }
  }

  if (pathname === '/api/recognition_admin.php') {
    if (action === 'submissions') {
      return { payload: { success: true, submissions: fixtureState.submissions.map((item) => ({ ...item })) } };
    }
    if (action === 'import_participants') {
      return { payload: { success: true } };
    }
    if (action === 'review') {
      return { payload: { success: true } };
    }
    if (action === 'claim_list') {
      return { payload: { success: true, codes: [{ code: 'CLAIM-OLD' }] } };
    }
    if (action === 'claim_generate') {
      return { payload: { success: true, codes: ['CLAIM-NEW-1', 'CLAIM-NEW-2'] } };
    }
  }

  if (pathname === '/api/recognition_events.php') {
    if (action === 'connector_list') {
      return { payload: { success: true, connectors: fixtureState.connectors.map((item) => ({ ...item })) } };
    }
    if (action === 'connector_create') {
      return { payload: { success: true, token: 'secret-token-value', hmac_secret: 'secret-hmac-value' } };
    }
    if (action === 'connector_revoke') {
      const id = Number(body?.connector_id);
      fixtureState.connectors = fixtureState.connectors.map((item) => (Number(item.id) === id ? { ...item, revoked_at: '2026-09-03 12:00:00' } : item));
      return { payload: { success: true } };
    }
    if (action === 'quiz_sync') {
      return { payload: { success: true } };
    }
  }

  return { payload: { success: true, data: [] } };
}

function startFixtureServer() {
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;
    const searchParams = requestUrl.searchParams;
    const action = searchParams.get('action') || '';
    const requestContentType = req.headers['content-type'] || '';
    const rawBody = req.method === 'GET' || req.method === 'HEAD' ? '' : await readRawBody(req);

    if (pathname.startsWith('/api/')) {
      let parsedBody = null;
      if (rawBody && requestContentType.includes('application/json')) {
        try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = null; }
      }
      if (recorder) {
        if (process.env.RECOG_DEBUG) process.stdout.write(`[req] ${req.method} ${pathname}?${action}\n`);
        recorder({
          path: pathname,
          action,
          method: req.method,
          query: Object.fromEntries(searchParams.entries()),
          body: parsedBody,
          contentType: requestContentType,
        });
      }
      const { payload, status } = apiResponse(pathname, action, searchParams, parsedBody);
      return json(res, payload, status || 200);
    }

    const relativePath = pathname.replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(projectRoot, relativePath);
    if (pathname.startsWith('/uploads/badge_images/')) {
      const badgeImage = badgeFixturePng();
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': badgeImage.length, 'Cache-Control': 'no-store' });
      return res.end(badgeImage);
    }
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

/* Local helpers injected into every executeJavaScript payload. They only touch the DOM that a
   human would touch; no React internals and no application globals are used. */
const clientHelpers = `
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate, label, attempts = 100) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let value = null;
      try { value = predicate(); } catch (error) { value = null; }
      if (value) return value;
      await wait(100);
    }
    throw new Error('timed out waiting for ' + label + ' | buttons=[' + nodes('button').map((node) => textOf(node)).slice(0, 30).join(' / ') + '] | text=' + textOf(document.body).slice(0, 260));
  };
  const nodes = (selector, root) => Array.from((root || document).querySelectorAll(selector));
  const textOf = (node) => (node ? String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim() : '');
  const visible = (node) => Boolean(node) && node.offsetParent !== null;
  const findText = (selector, text, root) => nodes(selector, root).find((node) => textOf(node).includes(text)) || null;
  /* antd inserts a space between two Chinese characters of a primary button (「授予」 renders as
     「授 予」), so button labels are compared with all whitespace removed. */
  const compactText = (node) => textOf(node).replace(/\\s+/g, '');
  const buttonByText = (text, root) => nodes('button', root).find((node) => compactText(node) === text.replace(/\\s+/g, '')) || null;
  const click = (node, label) => {
    if (!node) throw new Error('missing click target: ' + label);
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return node;
  };
  const setValue = (element, value) => {
    if (!element) throw new Error('missing form control');
    const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return element;
  };
  const visibleModal = (titlePart) => {
    const list = nodes('.ant-modal').filter((modal) => {
      const wrap = modal.closest('.ant-modal-wrap');
      if (wrap && getComputedStyle(wrap).display === 'none') return false;
      const title = textOf(modal.querySelector('.ant-modal-title'));
      return titlePart ? title.includes(titlePart) : true;
    });
    return list[list.length - 1] || null;
  };
  const openModal = (titlePart) => waitFor(() => visibleModal(titlePart), 'modal ' + titlePart);
  const formItem = (root, labelText) => nodes('.ant-form-item', root).find((item) => textOf(item.querySelector('.ant-form-item-label')).includes(labelText)) || null;
  const pickSelect = async (root, labelText, optionText) => {
    const item = formItem(root, labelText);
    if (!item) throw new Error('missing form item ' + labelText);
    const selector = item.querySelector('.ant-select-selector');
    if (!selector) throw new Error('missing select ' + labelText);
    selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    const option = await waitFor(() => {
      const dropdowns = nodes('.ant-select-dropdown').filter((dropdown) => !dropdown.classList.contains('ant-select-dropdown-hidden') && getComputedStyle(dropdown).display !== 'none');
      for (let index = dropdowns.length - 1; index >= 0; index -= 1) {
        const found = nodes('.ant-select-item-option', dropdowns[index]).find((node) => textOf(node).includes(optionText));
        if (found) return found;
      }
      return null;
    }, 'option ' + optionText);
    click(option, 'option ' + optionText);
    await wait(150);
  };
  const closeModal = async (modal, label) => {
    if (modal) click(modal.querySelector('.ant-modal-close'), 'close ' + label);
    await wait(250);
  };
  const questionCards = (modal) => nodes('.cm-question-list > .ant-card', modal);
  const visibleButton = (label) => waitFor(() => nodes('button').find((node) => compactText(node) === label.replace(/\\s+/g, '') && visible(node)), 'button ' + label);
  /* load() only swaps the pane body for a loading state; the active tab itself is
     held in component state, so whichever tab was open stays open. React can skip
     the intermediate loading commit and reuse the pane element, so the reload is
     tracked by waiting for the rendered pane to stop changing instead of by a
     timing or DOM-identity guess. */
  const settledPane = async () => {
    let last = null;
    let stable = 0;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await wait(100);
      const pane = document.querySelector('.ant-tabs-tabpane-active');
      const loading = document.querySelector('.cm-tab-loading') ? 'L' : 'R';
      /* 这里必须用字符串拼接：clientHelpers 本身是模板字符串，嵌套模板会让占位符
         在 Node 加载阶段就被插入进注入脚本。 */
      const signature = pane
        ? loading + ':' + textOf(pane).length + ':' + nodes('.ant-card, .ant-table-row', pane).length + ':' + nodes('button', pane).length
        : loading + ':none';
      if (signature === last) {
        stable += 1;
        if (stable >= 3) return;
      } else {
        stable = 0;
        last = signature;
      }
    }
    throw new Error('the active pane never settled after a reload');
  };
  const activeTabLabel = () => {
    const tab = document.querySelector('.ant-tabs-tab-active');
    return tab ? textOf(tab) : '';
  };
  const selectTab = async (label) => {
    const tab = await waitFor(() => nodes('.ant-tabs-tab').find((node) => textOf(node).includes(label)), 'tab ' + label);
    click(tab.querySelector('.ant-tabs-tab-btn') || tab, 'tab ' + label);
    await waitFor(() => {
      const pane = document.querySelector('.ant-tabs-tabpane-active');
      return pane && visible(pane) ? pane : null;
    }, 'active pane after ' + label);
    await wait(200);
  };
  const rowWith = (text) => waitFor(() => nodes('.ant-table-row').find((row) => visible(row) && textOf(row).includes(text)), 'table row ' + text);
  const rowButton = (row, label) => nodes('button', row).find((node) => compactText(node) === label.replace(/\\s+/g, '')) || null;
  const cardByTitle = (titleText) => nodes('.ant-card').find((card) => {
    const head = card.querySelector('.ant-card-head');
    return visible(card) && head && textOf(head).includes(titleText);
  }) || null;
  const refreshData = async () => {
    click(document.querySelector('[aria-label="刷新当前数据"]'), 'refresh button');
  };
`;

async function evaluate(win, body) {
  return win.webContents.executeJavaScript(`(async () => {\n${clientHelpers}\n${body}\n})()`);
}

function recordedRequests(action) {
  return (recorded || []).filter((entry) => entry.action === action);
}

let recorded = [];

function setupScript(theme) {
  return `
    document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    const menuToggle = document.querySelector('.cm-menu-toggle');
    if (menuToggle) { click(menuToggle, 'menu toggle'); await wait(250); }
    const clubInput = await waitFor(() => document.querySelector('#clubSelector'), 'club selector');
    const clubSelector = clubInput.closest('.ant-select').querySelector('.ant-select-selector');
    clubSelector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    const clubOption = await waitFor(() => nodes('.ant-select-item-option').find((option) => textOf(option).includes(${JSON.stringify(CLUB_NAME)})), 'club option');
    click(clubOption, 'club option');
    await wait(250);
    const menuItem = await waitFor(() => nodes('.ant-menu-item').find((item) => textOf(item).includes('考核设置')), 'recognition menu item');
    click(menuItem, 'recognition menu item');
    await waitFor(() => document.querySelector('.cm-recog-stats'), 'recognition statistics');
    await waitFor(() => nodes('.ant-tabs-tab').length >= 5, 'recognition tabs');
    await wait(200);
    // every tab must actually render its pane: visit 已签发凭证 and come back
    await selectTab('已签发凭证');
    const credentialsVisible = Boolean(await waitFor(() => nodes('.ant-table-row').find((row) => visible(row) && textOf(row).includes('张三')), 'credential row'));
    await selectTab('考核方案');
    await waitFor(() => nodes('.cm-template-card button').length >= 5, 'template buttons');
    await wait(150);
    return {
      innerWidth,
      bodyWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      clientWidth: document.documentElement.clientWidth,
      stats: nodes('.cm-recog-stats .ant-statistic').map((node) => ({ title: textOf(node.querySelector('.ant-statistic-title')), value: textOf(node.querySelector('.ant-statistic-content')) })),
      tabs: nodes('.ant-tabs-tab').map((node) => textOf(node)),
      templates: nodes('.cm-template-card button').map((node) => textOf(node)),
      heading: textOf(document.querySelector('.cm-page-heading')),
      credentialsVisible,
    };
  `;
}

/* Requirement 4/5/6/9 – 考核方案 tab: templates, question editor, draft save, publish, QR, claim codes. */
function programsScript() {
  return `
    // publish #1: the 发布 link on the draft activity program row
    const activityRow = await rowWith('活动签到');
    click(rowButton(activityRow, '发布'), 'publish 活动签到');
    await wait(400);

    // template flow: the 快速模板 buttons open a prefilled editor and can save a new program
    const templateButton = nodes('.cm-template-card button').find((node) => textOf(node) === '知识问答');
    click(templateButton, 'template 知识问答');
    const createModal = await openModal('新建考核方案');
    const createEditorPresent = Boolean(createModal.querySelector('.cm-question-list'));
    const createRowsBefore = questionCards(createModal).length;
    const templateTitle = formItem(createModal, '标题').querySelector('input').value;
    await pickSelect(createModal, '奖励徽章', '入门徽章');
    click(findText('button', '添加题目', createModal), 'add question (template)');
    await waitFor(() => questionCards(createModal).length === 1, 'template question card');
    click(findText('.ant-modal-footer button', '保存草稿', createModal), 'save draft (template)');
    await waitFor(() => !visibleModal('新建考核方案'), 'template modal closed');

    // edit flow: the detail fixture preloads one question
    const assessmentRow = await rowWith('入门知识问答');
    click(rowButton(assessmentRow, '编辑'), 'edit 入门知识问答');
    const editModal = await openModal('编辑考核方案');
    await waitFor(() => questionCards(editModal).length === 1, 'preloaded question');
    const preloadedText = questionCards(editModal)[0].querySelector('textarea.ant-input').value;
    const preloadedCards = questionCards(editModal).length;
    if (preloadedText !== '1+1=?') throw new Error('existing assessment question was not loaded from version.content');
    await pickSelect(editModal, '奖励徽章', '入门徽章');
    click(findText('button', '添加题目', editModal), 'add question (edit)');
    await waitFor(() => questionCards(editModal).length === 2, 'second question card');
    setValue(questionCards(editModal)[1].querySelector('textarea.ant-input'), '2+2=?');
    await wait(150);
    click(findText('.ant-modal-footer button', '保存草稿', editModal), 'save draft (edit)');
    await waitFor(() => !visibleModal('编辑考核方案'), 'edit modal closed after draft save');

    // publish #2: 保存并发布 inside the editor modal
    const publishRow = await rowWith('入门知识问答');
    click(rowButton(publishRow, '编辑'), 'edit for publish');
    const publishModal = await openModal('编辑考核方案');
    await waitFor(() => questionCards(publishModal).length === 1, 'publish modal questions');
    await pickSelect(publishModal, '奖励徽章', '入门徽章');
    click(findText('.ant-modal-footer button', '保存并发布', publishModal), 'save and publish');
    await waitFor(() => !visibleModal('编辑考核方案'), 'edit modal closed after publish');
    await wait(300);

    // QR code for the published program
    const qrRow = await rowWith('入门知识问答');
    click(rowButton(qrRow, '二维码'), 'qr button');
    const qrModal = await waitFor(() => {
      const modal = visibleModal('入门知识问答');
      return modal && modal.querySelector('img[src^="data:image/png"]') ? modal : null;
    }, 'qr modal');
    const qrImage = qrModal.querySelector('img').getAttribute('src').slice(0, 24);
    const qrCode = textOf(qrModal.querySelector('code'));
    await closeModal(qrModal, 'qr modal');

    // claim codes on the activity program
    const claimRow = await rowWith('活动签到');
    click(rowButton(claimRow, '兑换码'), 'claim button');
    const claimModal = await openModal('兑换码');
    const claimOld = await waitFor(() => (textOf(claimModal).includes('CLAIM-OLD') ? textOf(claimModal) : null), 'existing claim code');
    click(claimModal.querySelector('.ant-modal-footer .ant-btn-primary'), 'generate claim codes');
    const claimNew = await waitFor(() => {
      const text = textOf(claimModal);
      return text.includes('CLAIM-NEW-1') && text.includes('CLAIM-NEW-2') ? text : null;
    }, 'generated claim codes');
    await closeModal(claimModal, 'claim modal');

    return {
      createEditorPresent,
      createRowsBefore,
      templateTitle,
      preloadedText,
      preloadedCards,
      qrImage,
      qrCode,
      claimOld: claimOld.slice(0, 160),
      claimNew: claimNew.slice(0, 200),
      bodyWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    };
  `;
}

/* Requirement 7 – 成就徽章: badge create payload plus the 1:1 crop -> multipart upload path. */
function badgesScript() {
  return `
    await selectTab('成就徽章');
    click(await visibleButton('创建徽章'), 'create badge');
    const badgeModal = await openModal('创建徽章');
    setValue(formItem(badgeModal, '名称').querySelector('input.ant-input'), '测试徽章');
    await wait(150);
    click(badgeModal.querySelector('.ant-modal-footer .ant-btn-primary'), 'save badge');
    await waitFor(() => !visibleModal('创建徽章'), 'badge modal closed');
    await settledPane();
    /* Regression guard: the badges tab must survive the post-save reload. */
    const tabAfterBadgeSave = activeTabLabel();

    // second pass: synthetic file selection -> crop dialog -> confirm -> multipart upload
    await selectTab('成就徽章');
    click(await visibleButton('创建徽章'), 'create badge again');
    const cropHost = await openModal('创建徽章');
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 64; sourceCanvas.height = 64;
    const sourceContext = sourceCanvas.getContext('2d');
    sourceContext.fillStyle = '#e74c3c'; sourceContext.fillRect(0, 0, 64, 64);
    const sourceBlob = await new Promise((resolve) => sourceCanvas.toBlob(resolve, 'image/png'));
    const sourceFile = new File([sourceBlob], 'badge-source.png', { type: 'image/png' });
    const fileInput = cropHost.querySelector('input[type="file"]');
    if (!fileInput) throw new Error('badge modal is missing the hidden file input');
    const transfer = new DataTransfer();
    transfer.items.add(sourceFile);
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    const cropModal = await waitFor(() => {
      const modal = visibleModal('裁剪徽章图片');
      return modal && modal.querySelector('canvas') ? modal : null;
    }, 'crop modal');
    const canvas = cropModal.querySelector('canvas');
    await wait(400);
    const painted = (() => {
      try {
        const data = canvas.getContext('2d').getImageData(150, 150, 1, 1).data;
        return data[3] > 0;
      } catch (error) { return false; }
    })();
    click(cropModal.querySelector('.ant-modal-footer .ant-btn-primary'), 'confirm crop');
    await waitFor(() => !visibleModal('裁剪徽章图片'), 'crop modal closed');
    await wait(300);
    await closeModal(cropHost, 'badge modal');
    click(findText('.ant-tabs-tab', '成就徽章'), 'badges tab again');
    return {
      cropModalTitle: textOf(cropModal.querySelector('.ant-modal-title')),
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      painted,
      tabAfterBadgeSave,
      bodyWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    };
  `;
}

/* Requirement 8 – 签发与审核: grant, CSV import and submission review payloads. */
function operationsScript() {
  return `
    await selectTab('签发与审核');
    const grantCard = await waitFor(() => cardByTitle('人工授予'), 'grant card');
    await pickSelect(grantCard, '授予项目', '活动签到');
    setValue(formItem(grantCard, '用户名').querySelector('textarea.ant-input'), '李四, 王五\\n赵六');
    await wait(150);
    click(buttonByText('授予', grantCard), 'grant');
    await settledPane();

    await selectTab('签发与审核');
    const importCard = await waitFor(() => cardByTitle('CSV 名单导入'), 'import card');
    await pickSelect(importCard, '导入项目', '活动签到');
    setValue(formItem(importCard, '名单').querySelector('textarea.ant-input'), 'name,email\\n李四,lisi@example.com');
    await wait(150);
    click(buttonByText('导入并签发', importCard), 'import participants');
    await settledPane();

    await selectTab('签发与审核');
    const reviewCard = await waitFor(() => cardByTitle('待审核提交'), 'review card');
    const submissionRendered = textOf(reviewCard).includes('作品提交赛') && textOf(reviewCard).includes('李四');
    click(buttonByText('通过', reviewCard), 'approve submission');
    await settledPane();
    return {
      submissionRendered,
      bodyWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    };
  `;
}

/* Requirement 10 – 连接器: load, create (one-time secret) and revoke. */
function connectorsScript() {
  return `
    await selectTab('连接器');
    click(await visibleButton('加载 Connector'), 'load connectors');
    const connectorRow = await waitFor(() => nodes('.ant-table-row').find((row) => visible(row) && textOf(row).includes('站外 Webhook')), 'connector row');
    const connectorRowText = textOf(connectorRow);
    const connectorCard = connectorRow.closest('.ant-card');
    setValue(formItem(connectorCard, '名称').querySelector('input.ant-input'), '站外通知');
    await wait(150);
    click(buttonByText('创建 Connector', connectorCard), 'create connector');
    const secretText = await waitFor(() => {
      const block = document.querySelector('.cm-secret');
      return block && textOf(block).includes('secret-token-value') ? textOf(block) : null;
    }, 'one-time connector secret');
    const revokeRow = await waitFor(() => nodes('.ant-table-row').find((row) => visible(row) && textOf(row).includes('站外 Webhook')), 'connector row (revoke)');
    click(buttonByText('吊销', revokeRow), 'revoke connector');
    const popconfirm = await waitFor(() => nodes('.ant-popconfirm').find((node) => getComputedStyle(node).display !== 'none'), 'revoke popconfirm');
    click(popconfirm.querySelector('.ant-btn-primary'), 'confirm revoke');
    await settledPane();
    return {
      connectorRowText,
      secretText,
      bodyWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    };
  `;
}

/* Requirement 11 – resilience: forced 500 + retry, then the empty-state paths. */
function forcedErrorScript() {
  return `
    await refreshData();
    const alert = await waitFor(() => document.querySelector('.ant-alert-error'), 'recognition error alert');
    const retryButton = buttonByText('重试', alert);
    return {
      alertText: textOf(alert),
      alertMessage: textOf(alert.querySelector('.ant-alert-message')),
      hasRetry: Boolean(retryButton) && visible(retryButton),
      statsGone: !document.querySelector('.cm-recog-stats'),
    };
  `;
}

function retryRecoveryScript() {
  return `
    const alert = document.querySelector('.ant-alert-error');
    click(buttonByText('重试', alert), 'retry button');
    await waitFor(() => document.querySelector('.cm-recog-stats'), 'statistics after retry');
    await waitFor(() => nodes('.ant-tabs-tab').length >= 5, 'tabs after retry');
    await wait(250);
    return {
      stats: nodes('.cm-recog-stats .ant-statistic').map((node) => ({ title: textOf(node.querySelector('.ant-statistic-title')), value: textOf(node.querySelector('.ant-statistic-content')) })),
      tabs: nodes('.ant-tabs-tab').map((node) => textOf(node)),
    };
  `;
}

function emptyStateScript() {
  return `
    await refreshData();
    /* The active tab survives a reload, so the programs pane has to be selected
       explicitly before its empty table can be asserted. */
    await selectTab('考核方案');
    await waitFor(() => textOf(document.querySelector('.ant-table-placeholder') || document.createElement('i')).includes('暂无考核方案'), 'empty program table');
    await wait(250);
    const programTab = nodes('.ant-tabs-tab').find((node) => textOf(node).includes('考核方案'));
    const badgeTab = nodes('.ant-tabs-tab').find((node) => textOf(node).includes('成就徽章'));
    await selectTab('成就徽章');
    const grid = document.querySelector('.cm-badge-grid');
    return {
      programEmptyText: textOf(document.querySelector('.ant-table-placeholder')),
      programTabLabel: textOf(programTab),
      badgeTabLabel: textOf(badgeTab),
      badgeGridPresent: Boolean(grid) && visible(grid),
      badgeGridCards: grid ? nodes('.ant-card', grid).length : -1,
      badgeEmptyText: textOf(document.querySelector('.ant-tabs-tabpane-active') || document.body).slice(0, 200),
      tabs: nodes('.ant-tabs-tab').map((node) => textOf(node)),
      bodyWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      innerWidth,
    };
  `;
}

function statMap(stats) {
  return Object.fromEntries((stats || []).map((item) => [item.title, item.value]));
}

/* One progress line per phase: a multi-viewport run is long, and a silent driver makes a
   mid-run failure impossible to localise. */
function progress(label, phase) {
  console.log(`.. ${label} ${phase}`);
}

async function inspectViewport(baseUrl, name, size, theme) {
  resetFixtureState();
  recorded = [];
  recorder = (entry) => recorded.push(entry);

  const label = `${name}/${theme}`;
  progress(label, 'start');
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
  const consoleMessages = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) consoleMessages.push(message);
  });

  const summary = { name, theme, innerWidth: size.width };

  try {
    await win.loadURL(`${baseUrl}/admin/club_manager.html?recognition_test=1`);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('#root .cm-app'))`);
      if (ready) break;
      await wait(100);
      if (attempt === 79) throw new Error(`${label}: the club manager shell never rendered`);
    }

    // Requirement 1-3: club selection, sidebar navigation, statistics and tab labels.
    progress(label, 'setup');
    const setup = await evaluate(win, setupScript(theme));
    assert.equal(setup.stats.length, 4, `${label} should render four statistic tiles`);
    const stats = statMap(setup.stats);
    assert.equal(stats['方案'], '2', `${label} 方案 statistic should count the fixture programs`);
    assert.equal(stats['徽章'], '1', `${label} 徽章 statistic should count the fixture badges`);
    assert.equal(stats['凭证'], '1', `${label} 凭证 statistic should count the fixture credentials`);
    assert.equal(stats['待审核'], '1', `${label} 待审核 statistic should count the pending submissions`);
    assert.equal(setup.tabs.length, 5, `${label} should render five recognition tabs: ${setup.tabs.join(' | ')}`);
    assert.match(setup.tabs.join(' | '), /考核方案 \(2\)/, `${label} 考核方案 tab should carry its count`);
    assert.match(setup.tabs.join(' | '), /成就徽章 \(1\)/, `${label} 成就徽章 tab should carry its count`);
    assert.match(setup.tabs.join(' | '), /签发与审核 \(1\)/, `${label} 签发与审核 tab should carry its count`);
    assert.match(setup.tabs.join(' | '), /已签发凭证 \(1\)/, `${label} 已签发凭证 tab should carry its count`);
    assert.match(setup.tabs.join(' | '), /连接器/, `${label} should render the 连接器 tab`);
    assert.equal(setup.heading.includes('考核设置'), true, `${label} should render the 考核设置 heading`);
    assert.equal(setup.credentialsVisible, true, `${label} should render the fixture credential row`);
    const templateLabels = setup.templates.join(' | ');
    for (const expected of ['知识问答', '活动签到', '作品提交', '纪念徽章', '人工授予', '自定义新建']) {
      assert.equal(templateLabels.includes(expected), true, `${label} template buttons should include ${expected}: ${templateLabels}`);
    }
    assert.equal(setup.bodyWidth <= setup.innerWidth + 1, true, `${label} should not horizontally overflow after the tab loaded`);

    // Requirement 4-6, 9: program editor, draft save, publish, QR code, claim codes.
    progress(label, 'programs');
    const programs = await evaluate(win, programsScript());
    assert.equal(programs.createEditorPresent, true, `${label} the 知识问答 template should open the editor with the QuestionEditor mounted`);
    assert.equal(programs.createRowsBefore, 0, `${label} a fresh template should start without questions`);
    assert.equal(programs.templateTitle, '知识问答', `${label} the template should prefill the program title`);

    const createRequests = recordedRequests('create');
    const programCountAfterCreate = fixtureState.programs.length;
    assert.equal(createRequests.length, 1, `${label} saving the template draft should POST a single create request`);
    const createBody = createRequests[0].body;
    assert.equal(createBody.club_id, 1, `${label} create body must carry club_id 1`);
    assert.equal(createBody.country, 'china', `${label} create body must carry country china`);
    assert.equal(createBody.content.quiz.questions.length, 1, `${label} create body should carry the template question`);
    assert.equal(createBody.program_id, undefined, `${label} a create body must not carry program_id`);

    assert.equal(programs.preloadedCards, 1, `${label} opening an existing program should preload its one question`);
    assert.equal(programs.preloadedText, '1+1=?', `${label} the QuestionEditor should render the preloaded question text (got ${programs.preloadedText})`);

    const updateRequests = recordedRequests('update');
    assert.equal(updateRequests.length >= 1, true, `${label} saving the edited program should POST an update request`);
    const editBody = updateRequests[0].body;
    assert.equal(editBody.club_id, 1, `${label} update body must carry club_id 1`);
    assert.equal(editBody.country, 'china', `${label} update body must carry country china`);
    assert.equal(editBody.program_id, 11, `${label} update body must target the edited program`);
    assert.equal(editBody.content.quiz.questions.length, 2, `${label} update body must carry two questions`);
    assert.equal(editBody.content.quiz.questions[1].question, '2+2=?', `${label} the second question edit must be sent`);
    const scoreCondition = (editBody.content.rules.conditions || []).find((condition) => condition.op === 'score_gte');
    assert.ok(scoreCondition, `${label} update body rules must include a score_gte condition`);
    assert.equal(typeof scoreCondition.value, 'number', `${label} the score_gte condition value must be numeric`);

    const publishRequests = recordedRequests('publish');
    assert.equal(publishRequests.length >= 2, true, `${label} expected two publish requests, saw ${publishRequests.length}`);
    assert.deepEqual(publishRequests[0].body, { program_id: 12 }, `${label} the first publish should come from the draft row`);
    assert.deepEqual(publishRequests[1].body, { program_id: 11 }, `${label} 保存并发布 should publish the edited program`);

    assert.equal(programs.qrImage.startsWith('data:image/png'), true, `${label} the QR dialog should embed a PNG data URL (got ${programs.qrImage})`);
    assert.equal(programs.qrCode.includes('/exam/index.html#/program/'), true, `${label} the QR dialog should show the participant URL (got ${programs.qrCode})`);

    assert.equal(programs.claimOld.includes('CLAIM-OLD'), true, `${label} the claim dialog should list the existing code`);
    const claimRequests = recordedRequests('claim_generate');
    assert.equal(claimRequests.length, 1, `${label} generating claim codes should POST once`);
    assert.deepEqual(claimRequests[0].body, { program_id: 12, count: 20, ttl_hours: 72 }, `${label} claim_generate body mismatch`);
    assert.equal(programs.claimNew.includes('CLAIM-NEW-1') && programs.claimNew.includes('CLAIM-NEW-2'), true, `${label} the freshly generated codes should render`);

    // Requirement 7: badge create + crop upload.
    progress(label, 'badges');
    const badges = await evaluate(win, badgesScript());
    const badgeRequests = recordedRequests('badge_create');
    assert.equal(badgeRequests.length, 1, `${label} saving a badge should POST badge_create once`);
    assert.equal(badgeRequests[0].body.name, '测试徽章', `${label} badge_create body must carry the name`);
    assert.equal(badgeRequests[0].body.club_id, 1, `${label} badge_create body must carry club_id 1`);
    assert.equal(badgeRequests[0].body.country, 'china', `${label} badge_create body must carry country china`);
    assert.equal(badges.cropModalTitle.includes('裁剪徽章图片（1:1）'), true, `${label} choosing an image should open the 1:1 crop dialog (got ${badges.cropModalTitle})`);
    assert.equal(badges.canvasWidth, 300, `${label} the crop canvas should be 300px wide`);
    assert.equal(badges.canvasHeight, 300, `${label} the crop canvas should be 300px tall`);
    assert.equal(badges.painted, true, `${label} the crop canvas should have painted the selected image`);
    /* Regression guard: saving a badge re-runs load(); the 成就徽章 tab must stay selected
       instead of snapping back to 考核方案. */
    assert.equal(badges.tabAfterBadgeSave.includes('成就徽章'), true, `${label} the active tab must survive the post-save reload (got ${badges.tabAfterBadgeSave})`);
    const uploadRequests = recordedRequests('upload');
    assert.equal(uploadRequests.length, 1, `${label} confirming the crop should upload once`);
    assert.equal(uploadRequests[0].method, 'POST', `${label} the crop upload must be a POST`);
    assert.equal(uploadRequests[0].contentType.startsWith('multipart/form-data'), true, `${label} the crop upload must be multipart (got ${uploadRequests[0].contentType})`);

    // Requirement 8: grant / import / review.
    progress(label, 'operations');
    const operations = await evaluate(win, operationsScript());
    assert.equal(operations.submissionRendered, true, `${label} the pending submission should render in 签发与审核`);
    const grantRequests = recordedRequests('grant');
    assert.equal(grantRequests.length, 1, `${label} 授予 should POST once`);
    assert.deepEqual(grantRequests[0].body.usernames, ['李四', '王五', '赵六'], `${label} grant body should split the usernames`);
    assert.equal(grantRequests[0].body.program_id, 12, `${label} grant body should carry the chosen program`);
    const importRequests = recordedRequests('import_participants');
    assert.equal(importRequests.length, 1, `${label} 导入并签发 should POST once`);
    assert.equal(importRequests[0].body.csv, 'name,email\n李四,lisi@example.com', `${label} import body should carry the CSV blob`);
    assert.equal(importRequests[0].body.program_id, 12, `${label} import body should carry the chosen program`);
    const reviewRequests = recordedRequests('review');
    assert.equal(reviewRequests.length, 1, `${label} 通过 should POST once`);
    assert.equal(reviewRequests[0].body.submission_id, 41, `${label} review body should carry the submission id`);
    assert.equal(reviewRequests[0].body.decision, 'approved', `${label} review body should carry the approved decision`);

    // Requirement 10: connectors.
    progress(label, 'connectors');
    const connectors = await evaluate(win, connectorsScript());
    assert.equal(connectors.connectorRowText.includes('站外 Webhook'), true, `${label} loading connectors should render the fixture row`);
    assert.equal(connectors.connectorRowText.includes('abc123'), true, `${label} the connector row should render the token prefix`);
    const createConnectorRequests = recordedRequests('connector_create');
    assert.equal(createConnectorRequests.length, 1, `${label} 创建 Connector should POST once`);
    assert.deepEqual(createConnectorRequests[0].body, { club_id: 1, country: 'china', name: '站外通知', type: 'webhook', event_types: [], enable_hmac: false }, `${label} connector_create body mismatch`);
    assert.equal(connectors.secretText.includes('secret-token-value'), true, `${label} the one-time secret block should show the token (got ${connectors.secretText})`);
    assert.equal(connectors.secretText.includes('密钥只展示这一次'), true, `${label} the one-time secret block should warn that the key is shown once`);
    const revokeRequests = recordedRequests('connector_revoke');
    assert.equal(revokeRequests.length, 1, `${label} 吊销 should POST once`);
    assert.deepEqual(revokeRequests[0].body, { connector_id: 51 }, `${label} connector_revoke body mismatch`);
    assert.equal(connectors.bodyWidth <= size.width + 1, true, `${label} should not horizontally overflow after the connectors tab`);

    // The main flow must be console clean; the deliberately forced 500 is checked separately below.
    assert.equal(consoleMessages.length, 0, `${label} should not add console errors: ${consoleMessages.join('; ')}`);

    // Requirement 11a: forced HTTP 500 renders the error panel and 重试 recovers.
    progress(label, 'error-state');
    fixtureState.manageFailure = true;
    const failed = await evaluate(win, forcedErrorScript());
    assert.equal(failed.alertText.includes(MANAGE_FAILURE_MESSAGE), true, `${label} the error panel should surface the server message (got ${failed.alertText})`);
    assert.equal(failed.alertMessage.includes('加载失败'), true, `${label} the error panel should be the 加载失败 panel`);
    assert.equal(failed.hasRetry, true, `${label} the error panel should offer a 重试 button`);
    assert.equal(failed.statsGone, true, `${label} the statistics should be replaced by the error panel`);

    fixtureState.manageFailure = false;
    progress(label, 'retry');
    const recovered = await evaluate(win, retryRecoveryScript());
    const recoveredStats = statMap(recovered.stats);
    assert.equal(recoveredStats['方案'], String(fixtureState.programs.length), `${label} 重试 should restore the program statistics`);
    assert.equal(recoveredStats['凭证'], String(fixtureState.credentials.length), `${label} 重试 should restore the credential statistics`);
    assert.equal(recoveredStats['待审核'], String(fixtureState.submissions.length), `${label} 重试 should restore the submission statistics`);
    assert.equal(recovered.tabs.length, 5, `${label} 重试 should restore all five tabs`);

    // Requirement 11b: empty programs/badges must render their empty states instead of crashing.
    progress(label, 'empty-state');
    fixtureState.programs = [];
    fixtureState.badges = [];
    const empty = await evaluate(win, emptyStateScript());
    assert.equal(empty.programEmptyText.includes('暂无考核方案'), true, `${label} an empty program list should render 暂无考核方案 (got ${empty.programEmptyText})`);
    assert.equal(empty.programTabLabel.includes('(0)'), true, `${label} the empty program tab should show a zero count (got ${empty.programTabLabel})`);
    assert.equal(empty.badgeEmptyText.includes('暂无徽章'), true, `${label} the empty badge pane should render 暂无徽章 (got ${empty.badgeEmptyText})`);
    assert.equal(empty.badgeGridCards <= 0, true, `${label} the empty badge pane must hold no cards (got ${empty.badgeGridCards})`);
    assert.equal(empty.badgeTabLabel.includes('(0)'), true, `${label} the empty badge tab should show a zero count (got ${empty.badgeTabLabel})`);
    assert.equal(empty.bodyWidth <= empty.innerWidth + 1, true, `${label} should not horizontally overflow in the empty state`);

    /* The forced 500 must not leak into the console either: Electron does not report the HTTP
       status of a failed fetch through console-message, so the list has to stay empty. */
    assert.equal(consoleMessages.length, 0, `${label} should stay console clean through the error and empty states: ${consoleMessages.join('; ')}`);

    summary.programs = programCountAfterCreate;
    summary.publishes = publishRequests.length;
    summary.consoleErrors = consoleMessages.length;
    return summary;
  } finally {
    recorder = null;
    win.destroy();
    await wait(300);
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
        console.log(`OK ${name}/${theme} programs=${result.programs} publish=${result.publishes} width=${result.innerWidth} console=${result.consoleErrors}`);
      }
    }
    console.log('club manager recognition browser tests passed');
  } finally {
    await app.quit();
    await new Promise((resolve) => server.close(resolve));
  }
}

if (app?.whenReady && BrowserWindow) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
    /* Electron's app.quit() always terminates with code 0, so a failing run has to force the
       non-zero code explicitly or the suite would report success. */
    if (app?.exit) app.exit(1);
  });
}
