const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = process.cwd();
const externalBaseUrl = (process.env.SITE_HEADER_BASE_URL || '').replace(/\/$/, '');
const viewports = [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'mobile-360', width: 360, height: 800 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1366, height: 900 },
];
const allPages = [
  '/user.html',
  '/feedback.html',
  '/Forum/forum-plaza.html',
  '/admin/club_manager.html',
  '/admin/Galonly_audit.html',
  '/wiki/index.html',
  '/wiki/guide/index.html',
  '/wiki/pages/china-114.html',
  '/wiki/pages/china-114-ja.html',
  '/Galgame_events/galgameonly_list.html',
  '/moe/contest.html?id=999999',
  '/star_map.html',
];
const requestedPages = (process.env.SITE_HEADER_PAGES || '').split(',').map((page) => page.trim()).filter(Boolean);
const pages = requestedPages.length ? allPages.filter((page) => requestedPages.includes(page)) : allPages;

app.on('window-all-closed', (event) => event.preventDefault());

const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relativePath = decoded.replace(/^\/+/, '').replaceAll('/', path.sep);
  const candidate = path.resolve(root, relativePath);
  return candidate.startsWith(root + path.sep) ? candidate : null;
}

function createServer() {
  return http.createServer((request, response) => {
    const file = safeFile(request.url || '/');
    if (!file) {
      response.writeHead(400).end('bad path');
      return;
    }
    if (path.basename(file).endsWith('.php')) {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end('{"success":false,"message":"local browser contract"}');
      return;
    }
    const stat = fs.existsSync(file) && fs.statSync(file);
    if (!stat || !stat.isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
}

async function inspectPage(baseUrl, page, viewport) {
  const window = new BrowserWindow({
    show: false,
    width: viewport.width,
    height: viewport.height,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const consoleErrors = [];
  window.webContents.on('console-message', (_event, level, message, line, source) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) consoleErrors.push(`${message} (${source}:${line})`);
  });
  let loadError = null;
  try {
    await window.loadURL(`${baseUrl}${page}`);
    await sleep(1500);
  } catch (error) {
    loadError = error.message;
  }
  const finalUrl = window.webContents.getURL();
  const navigationTarget = `${finalUrl} ${loadError || ''}`;
  const authBoundary = /(?:\/login\.html|\/index\.html\?need_login=1)/i.test(navigationTarget)
    && (!loadError || /ERR_ABORTED/i.test(loadError));
  const mobileViewport = viewport.width <= 680;
  const result = (loadError && !authBoundary) ? null : (authBoundary ? null : await window.webContents.executeJavaScript(`(() => {
    const header = document.querySelector('[data-page-header]');
    const root = document.documentElement;
    return {
      pathname: location.pathname,
      mobileViewport: ${mobileViewport},
      headerCount: document.querySelectorAll('[data-page-header]').length,
      legacyHeaderCount: document.querySelectorAll('header.topbar:not(.vn-topbar), header.admin-topbar:not(.vn-topbar), header.top-header:not(.vn-topbar), header.wiki-header:not(.vn-topbar), header.guide-header:not(.vn-topbar), header.starmap-topbar:not(.vn-topbar)').length,
      unifiedNodeCount: document.querySelectorAll('.vn-topbar-brand, .vn-topbar-divider, .vn-topbar-sub, [data-header-manual]').length,
      brand: header ? header.querySelector('.vn-topbar-brand')?.textContent.trim() : '',
      name: header ? header.querySelector('.vn-topbar-name')?.textContent.trim() : '',
      divider: Boolean(header && header.querySelector('.vn-topbar-divider')),
      sub: header ? header.querySelector('.vn-topbar-sub')?.textContent.trim() : '',
      actionCount: header ? header.querySelectorAll('.vn-topbar-action').length : 0,
      overflow: { client: root.clientWidth, scroll: root.scrollWidth },
      stylesheet: Boolean(document.querySelector('link[href*="site-header.css"]')),
      bodyTextLength: (document.body?.innerText || '').trim().length,
    };
  })()`));
  window.destroy();
  return { page, viewport: viewport.name, loadError: authBoundary ? null : loadError, authBoundary, finalUrl, consoleErrors, result };
}

async function main() {
  const server = externalBaseUrl ? null : createServer();
  if (server) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server && server.address();
  const baseUrl = externalBaseUrl || `http://127.0.0.1:${address.port}`;
  const failures = [];
  try {
    for (const viewport of viewports) {
      for (const page of pages) {
        const result = await inspectPage(baseUrl, page, viewport);
        const check = result.result;
        const failed = Boolean(result.loadError)
          || (!check && !result.authBoundary)
          || (check && (
            check.mobileViewport
              ? (check.headerCount !== 0 || check.unifiedNodeCount !== 0)
              : (check.headerCount !== 1
                || !check.brand.includes('VNFest')
                || check.name !== 'VNFest'
                || !check.divider
                || !check.sub
                || check.actionCount < 1)
            || check.overflow.scroll > check.overflow.client + 1
            || check.bodyTextLength < 20
          ))
          || result.consoleErrors.length > 0;
        if (failed) failures.push(result);
        const headerState = check ? (check.mobileViewport ? 'legacy-mobile' : check.sub) : 'unavailable';
        console.log(`${failed ? 'FAIL' : 'OK'} ${viewport.name} ${page} header=${headerState} overflow=${check ? `${check.overflow.scroll}/${check.overflow.client}` : 'n/a'}`);
      }
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await app.quit();
  }
  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  } else {
    console.log(`Site header browser contract passed for ${pages.length} pages across ${viewports.length} viewports.`);
  }
}

app.whenReady().then(main).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
