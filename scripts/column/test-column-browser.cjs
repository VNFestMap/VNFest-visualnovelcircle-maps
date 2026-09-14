const { app, BrowserWindow } = require('electron');

const baseUrl = process.env.COLUMN_BROWSER_BASE_URL || 'http://127.0.0.1:8098';
const viewports = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'small-desktop', width: 1024, height: 900 },
  { name: 'desktop', width: 1366, height: 900 },
];
const pages = [
  { name: 'home', path: '/column/', selector: '.pt-app' },
  { name: 'activity', path: '/column/?tab=activity', selector: '.pt-activity-page' },
  { name: 'search', path: '/column/search/?q=test', selector: '.pt-search-box' },
  { name: 'post', path: '/column/post/0/', selector: '.pt-empty' },
  { name: 'mine', path: '/column/my/', selector: '.pt-app' },
  { name: 'messages', path: '/column/messages/', selector: '.pt-empty' },
  { name: 'thread', path: '/column/messages/1/', selector: '.pt-empty' },
  { name: 'user', path: '/column/user/not-found/', selector: '.pt-empty' },
  { name: 'forum-plaza', path: '/Forum/forum-plaza.html', selector: '.column-legacy-notice' },
  { name: 'forum-post', path: '/Forum/forum-post.html', selector: '.column-legacy-notice' },
  { name: 'forum-create', path: '/Forum/forum-create.html', selector: '.column-legacy-notice' },
];

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function checkPage(win, viewport, page) {
  win.setSize(viewport.width, viewport.height);
  const consoleErrors = [];
  const loadErrors = [];
  const onConsole = (_event, level, message) => { if (level === 3) consoleErrors.push(message); };
  const onLoad = (_event, webContents, details) => { if (details.errorCode < 0) loadErrors.push(`${details.errorCode}: ${details.validatedURL}`); };
  win.webContents.on('console-message', onConsole);
  win.webContents.on('did-fail-load', onLoad);
  await win.loadURL(`${baseUrl}${page.path}`);
  await wait(800);
  const result = await win.webContents.executeJavaScript(`(() => {
    const selector = ${JSON.stringify(page.selector)};
    const node = document.querySelector(selector);
    const width = document.documentElement.scrollWidth;
    const viewport = window.innerWidth;
    // Native lazy-loading may report complete=false after the image has already
    // decoded and exposed dimensions.  Only a completed image with no intrinsic
    // width is a failed resource; unfinished lazy images are not broken.
    const broken = [...document.images].filter((image) => image.complete && image.naturalWidth === 0).length;
    return { hasSelector: Boolean(node), overflow: width > viewport + 1, broken, text: document.body?.innerText?.trim().length || 0, url: location.href, body: document.body?.innerText?.trim().slice(0, 240) || '' };
  })()`);
  win.webContents.removeListener('console-message', onConsole);
  win.webContents.removeListener('did-fail-load', onLoad);
  if (!result.hasSelector) throw new Error(`${viewport.name}/${page.name}: missing ${page.selector} (${result.url}; ${result.body}; console=${consoleErrors.join(' | ')}; load=${loadErrors.join(' | ')})`);
  if (result.overflow) throw new Error(`${viewport.name}/${page.name}: horizontal overflow`);
  if (result.broken) throw new Error(`${viewport.name}/${page.name}: ${result.broken} broken image(s)`);
  if (result.text < 20) throw new Error(`${viewport.name}/${page.name}: page body is unexpectedly empty (${result.url}; body=${JSON.stringify(result.body)}; console=${consoleErrors.join(' | ')}; load=${loadErrors.join(' | ')})`);
  if (consoleErrors.length || loadErrors.length) throw new Error(`${viewport.name}/${page.name}: ${[...consoleErrors, ...loadErrors].join(' | ')}`);
}

async function checkDeniedSpace(win, viewport, mode) {
  win.setSize(viewport.width, viewport.height);
  const consoleErrors = [];
  const onConsole = (_event, level, message) => { if (level === 3) consoleErrors.push(message); };
  win.webContents.on('console-message', onConsole);
  try {
    await win.loadURL(`${baseUrl}/column/?qa=${mode}`);
    await wait(700);
    const result = await win.webContents.executeJavaScript(`(() => {
      const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
      const protectedRequests = resources.filter((name) => /\\/api\\/(?:posts|messages)\\.php/i.test(name) && !/[?&]action=bootstrap(?:&|$)/i.test(name));
      return {
        gate: Boolean(document.querySelector('.pt-space-access-gate')),
        app: Boolean(document.querySelector('.pt-app')),
        title: document.querySelector('#space-access-title')?.textContent || '',
        protectedRequests,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        broken: [...document.images].filter((image) => image.complete && image.naturalWidth === 0).length,
      };
    })()`);
    if (!result.gate || result.app) throw new Error(`${viewport.name}/${mode}: denied space did not render the access gate (${JSON.stringify({ ...result, consoleErrors })})`);
    if (mode === 'space-guest' && !result.title.includes('登录后')) throw new Error(`${viewport.name}/${mode}: missing login-required message`);
    if (mode !== 'space-guest' && !result.title.includes('成员及以上')) throw new Error(`${viewport.name}/${mode}: missing membership-required message`);
    if (result.protectedRequests.length) throw new Error(`${viewport.name}/${mode}: protected API requested before access (${result.protectedRequests.join(', ')})`);
    if (result.overflow) throw new Error(`${viewport.name}/${mode}: horizontal overflow`);
    if (result.broken) throw new Error(`${viewport.name}/${mode}: ${result.broken} broken image(s)`);
    if (consoleErrors.length) throw new Error(`${viewport.name}/${mode}: console errors: ${consoleErrors.join(' | ')}`);
  } finally {
    win.webContents.removeListener('console-message', onConsole);
  }
}

async function checkAllowedFixture(win, viewport, mode) {
  win.setSize(viewport.width, viewport.height);
  const consoleErrors = [];
  const onConsole = (_event, level, message) => { if (level === 3) consoleErrors.push(message); };
  win.webContents.on('console-message', onConsole);
  try {
    await win.loadURL(`${baseUrl}/column/?qa=${mode}`);
    await wait(700);
    const result = await win.webContents.executeJavaScript(`(() => ({
      app: Boolean(document.querySelector('.pt-app')),
      gate: Boolean(document.querySelector('.pt-space-access-gate')),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    }))()`);
    if (!result.app || result.gate) throw new Error(`${viewport.name}/${mode}: allowed space did not render the app (${JSON.stringify(result)})`);
    if (result.overflow) throw new Error(`${viewport.name}/${mode}: horizontal overflow`);
    if (consoleErrors.length) throw new Error(`${viewport.name}/${mode}: console errors: ${consoleErrors.join(' | ')}`);
  } finally {
    win.webContents.removeListener('console-message', onConsole);
  }
}

async function checkActivityNavigation(win, viewport) {
  win.setSize(viewport.width, viewport.height);
  const consoleErrors = [];
  const onConsole = (_event, level, message) => { if (level === 3) consoleErrors.push(message); };
  win.webContents.on('console-message', onConsole);
  try {
    await win.loadURL(`${baseUrl}/column/?tab=activity`);
    await wait(700);
    const initial = await win.webContents.executeJavaScript(`(() => ({
      url: location.href,
      active: document.querySelector('.pt-leftnav .pt-nav-item.is-active')?.textContent || '',
      bottomCount: document.querySelectorAll('.pt-bottomnav-item').length,
      bottomActive: document.querySelector('.pt-bottomnav-item.is-active')?.textContent || '',
      centerTabs: document.querySelectorAll('.pt-section-tab').length,
    }))()`);
    if (!initial.url.includes('/column/?tab=activity') || !initial.active.includes('活动')) throw new Error(`${viewport.name}/activity: initial activity tab was not active`);
    if (initial.bottomCount !== 5 || initial.bottomActive !== '活动') throw new Error(`${viewport.name}/activity: mobile five-item navigation is not active (${JSON.stringify(initial)})`);
    if (initial.centerTabs !== 0) throw new Error(`${viewport.name}/activity: activity must not render a center tab bar`);

    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.pt-leftnav .pt-nav-item')).find((item) => item.textContent.includes('首页'))?.click()`);
    await wait(180);
    const dynamic = await win.webContents.executeJavaScript(`(() => ({ url: location.href, active: document.querySelector('.pt-leftnav .pt-nav-item.is-active')?.textContent || '' }))()`);
    if (dynamic.url.includes('tab=activity') || !dynamic.active.includes('首页')) throw new Error(`${viewport.name}/activity: dynamic tab switch failed (${JSON.stringify(dynamic)})`);

    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.pt-leftnav .pt-nav-item')).find((item) => item.textContent.includes('活动'))?.click()`);
    await wait(180);
    await win.webContents.executeJavaScript('history.back()');
    await wait(220);
    const back = await win.webContents.executeJavaScript(`(() => ({ url: location.href, active: document.querySelector('.pt-leftnav .pt-nav-item.is-active')?.textContent || '' }))()`);
    if (back.url.includes('tab=activity') || !back.active.includes('首页')) throw new Error(`${viewport.name}/activity: browser back failed (${JSON.stringify(back)})`);

    await win.webContents.executeJavaScript('history.forward()');
    await wait(220);
    const forward = await win.webContents.executeJavaScript(`(() => ({ url: location.href, active: document.querySelector('.pt-leftnav .pt-nav-item.is-active')?.textContent || '' }))()`);
    if (!forward.url.includes('tab=activity') || !forward.active.includes('活动')) throw new Error(`${viewport.name}/activity: browser forward failed (${JSON.stringify(forward)})`);

    await win.webContents.reload();
    await wait(700);
    const refreshed = await win.webContents.executeJavaScript(`(() => ({ url: location.href, active: document.querySelector('.pt-leftnav .pt-nav-item.is-active')?.textContent || '' }))()`);
    if (!refreshed.url.includes('tab=activity') || !refreshed.active.includes('活动')) throw new Error(`${viewport.name}/activity: refresh did not retain activity tab (${JSON.stringify(refreshed)})`);
    if (consoleErrors.length) throw new Error(`${viewport.name}/activity: console errors: ${consoleErrors.join(' | ')}`);
  } finally {
    win.webContents.removeListener('console-message', onConsole);
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  try {
    for (const viewport of viewports) {
      for (const mode of ['space-guest', 'space-visitor', 'space-external', 'space-inactive']) {
        await checkDeniedSpace(win, viewport, mode);
        process.stdout.write(`ok ${viewport.name} denied-${mode}\n`);
      }
    }
    for (const mode of ['space-member', 'space-club-member', 'space-manager', 'space-representative', 'space-super-admin']) {
      await checkAllowedFixture(win, viewports[0], mode);
      process.stdout.write(`ok mobile allowed-${mode}\n`);
    }
    await win.loadURL(`${baseUrl}/column/?qa=space-member`);
    await wait(300);
    for (const viewport of viewports) for (const page of pages) {
      await checkPage(win, viewport, page);
      process.stdout.write(`ok ${viewport.name} ${page.name}\n`);
    }
    for (const viewport of viewports) {
      await checkActivityNavigation(win, viewport);
      process.stdout.write(`ok ${viewport.name} activity-navigation\n`);
    }
    await win.close();
    app.quit();
  } catch (error) {
    console.error(error.stack || error.message);
    await win.close();
    app.exit(1);
  }
});
