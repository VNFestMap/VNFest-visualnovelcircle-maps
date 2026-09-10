const { app, BrowserWindow } = require('electron');

const baseUrl = process.env.COLUMN_BROWSER_BASE_URL || 'http://127.0.0.1:8098';
const viewports = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'small-desktop', width: 1024, height: 900 },
  { name: 'desktop', width: 1366, height: 900 },
];
const pages = [
  { name: 'home', path: '/column/', selector: '.column-home-page' },
  { name: 'search', path: '/column/search/', selector: '.column-search-page' },
  { name: 'article', path: '/column/article/a-no-such-article/', selector: '.column-article-page [data-state="error"]' },
  { name: 'edit', path: '/column/edit/', selector: '.column-editor-page [data-state="muted"]' },
  { name: 'mine', path: '/column/my/', selector: '.column-management-page [data-state="muted"]' },
  { name: 'admin', path: '/column/admin/', selector: '.column-admin-page [data-state="muted"]' },
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
  await wait(350);
  const result = await win.webContents.executeJavaScript(`(() => {
    const selector = ${JSON.stringify(page.selector)};
    const node = document.querySelector(selector);
    const width = document.documentElement.scrollWidth;
    const viewport = window.innerWidth;
    const broken = [...document.images].filter((image) => !image.complete || image.naturalWidth === 0).length;
    return { hasSelector: Boolean(node), overflow: width > viewport + 1, broken, text: document.body?.innerText?.trim().length || 0 };
  })()`);
  win.webContents.removeListener('console-message', onConsole);
  win.webContents.removeListener('did-fail-load', onLoad);
  if (!result.hasSelector) throw new Error(`${viewport.name}/${page.name}: missing ${page.selector}`);
  if (result.overflow) throw new Error(`${viewport.name}/${page.name}: horizontal overflow`);
  if (result.broken) throw new Error(`${viewport.name}/${page.name}: ${result.broken} broken image(s)`);
  if (result.text < 20) throw new Error(`${viewport.name}/${page.name}: page body is unexpectedly empty`);
  if (consoleErrors.length || loadErrors.length) throw new Error(`${viewport.name}/${page.name}: ${[...consoleErrors, ...loadErrors].join(' | ')}`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  try {
    for (const viewport of viewports) for (const page of pages) {
      await checkPage(win, viewport, page);
      process.stdout.write(`ok ${viewport.name} ${page.name}\n`);
    }
    await win.close();
    app.quit();
  } catch (error) {
    console.error(error.stack || error.message);
    await win.close();
    app.exit(1);
  }
});
