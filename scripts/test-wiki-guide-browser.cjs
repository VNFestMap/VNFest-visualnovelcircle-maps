const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const currentId = 'updates/2-2-0';
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const externalBaseUrl = String(process.env.GUIDE_BASE_URL || '').replace(/\/$/, '');
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'mobile', width: 390, height: 844 },
];
const mime = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function createStaticServer() {
  return http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname.startsWith('/api/')) {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end('{"success":false}');
      return;
    }
    const relative = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const target = path.resolve(root, `.${relative}`);
    if (!target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': mime[path.extname(target).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(target).pipe(response);
  });
}

async function launchChrome() {
  if (!fs.existsSync(chromePath)) throw new Error(`Chrome was not found at ${chromePath}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vnfest-guide-chrome-'));
  const child = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--ignore-certificate-errors', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const websocketUrl = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Chrome DevTools endpoint did not start. ${output}`)), 10000);
    child.stderr.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { if (code) { clearTimeout(timer); reject(new Error(`Chrome exited with code ${code}. ${output}`)); } });
  });
  return { child, profile, websocketUrl };
}

class CdpClient {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.socket = new WebSocket(url);
  }
  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result || {});
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }
  close() { this.socket.close(); }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function waitFor(cdp, sessionId, expression, message) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, sessionId, `Boolean(${expression})`)) return;
    await sleep(80);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function navigate(cdp, sessionId, url, readyExpression, label) {
  await cdp.send('Page.navigate', { url }, sessionId);
  await waitFor(cdp, sessionId, `document.readyState === 'complete' && (${readyExpression})`, label);
  await waitFor(cdp, sessionId, `!window.VNFLanguage || ['ready', 'error'].includes(window.VNFLanguage.getState().status)`, `${label} language runtime`);
  await sleep(300);
  await waitFor(cdp, sessionId, readyExpression, `${label} stable render`);
}

async function inspectViewport(cdp, baseUrl, viewport) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const errors = [];
  const listener = message => {
    if (message.sessionId !== sessionId) return;
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails?.text || 'Runtime exception');
    if (message.method === 'Log.entryAdded' && ['error', 'warning'].includes(message.params.entry?.level)) errors.push(message.params.entry.text);
  };
  cdp.listeners.add(listener);
  try {
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.name === 'mobile',
    }, sessionId);
    await navigate(cdp, sessionId, `${baseUrl}/wiki/guide/?lang=zh#/platform/getting-started`, "document.querySelector('details[data-guide-group]') && !document.getElementById('guideArticle').hidden", 'Chinese guide');
    const initial = await evaluate(cdp, sessionId, `(() => {
      const details = document.querySelector('details[data-guide-group="release-history"]');
      const summary = details && details.querySelector('summary');
      return { title: document.querySelector('#guideArticle h1')?.textContent || '', open: Boolean(details?.open), linkCount: details?.querySelectorAll('a[data-guide-id]').length || 0, summaryHeight: summary?.getBoundingClientRect().height || 0, overflow: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - document.documentElement.clientWidth };
    })()`);
    if (initial.open || initial.linkCount !== 8 || initial.summaryHeight < 44 || initial.overflow > 1) throw new Error(`${viewport.name} initial state invalid: ${JSON.stringify(initial)}`);

    await evaluate(cdp, sessionId, `document.querySelector('details[data-guide-group="release-history"] > summary').click()`);
    if (!await evaluate(cdp, sessionId, `document.querySelector('details[data-guide-group="release-history"]').open`)) throw new Error(`${viewport.name} click did not open release history`);
    await evaluate(cdp, sessionId, `document.querySelector('details[data-guide-group="release-history"] > summary').focus()`);
    await sleep(50);
    if (!await evaluate(cdp, sessionId, `document.activeElement === document.querySelector('details[data-guide-group="release-history"] > summary')`)) throw new Error(`${viewport.name} summary did not receive keyboard focus`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
    await sleep(100);
    if (!await evaluate(cdp, sessionId, `!document.querySelector('details[data-guide-group="release-history"]').open`)) throw new Error(`${viewport.name} Enter did not close release history`);
    await evaluate(cdp, sessionId, `document.querySelector('details[data-guide-group="release-history"] > summary').focus()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ', unmodifiedText: ' ' }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }, sessionId);
    await sleep(100);
    if (!await evaluate(cdp, sessionId, `document.querySelector('details[data-guide-group="release-history"]').open`)) throw new Error(`${viewport.name} Space did not open release history`);

    await navigate(cdp, sessionId, `${baseUrl}/wiki/guide/?lang=zh#/${currentId}`, `document.querySelector('a[data-guide-id="${currentId}"].active')`, 'active Chinese release note');
    if (!await evaluate(cdp, sessionId, `document.querySelector('details[data-guide-group="release-history"]').open`)) {
      const diagnostic = await evaluate(cdp, sessionId, `(() => { const details = document.querySelector('details[data-guide-group="release-history"]'); return { url: location.href, title: document.querySelector('#guideArticle h1')?.textContent || '', activeId: document.querySelector('a[data-guide-id].active')?.getAttribute('data-guide-id') || '', open: details?.open, defaultExpanded: details?.getAttribute('data-default-expanded'), scripts: Array.from(document.scripts).map(script => script.src).filter(Boolean) }; })()`);
      throw new Error(`${viewport.name} direct release route did not expand history: ${JSON.stringify(diagnostic)}`);
    }
    await evaluate(cdp, sessionId, `location.hash = '#/platform/getting-started'`);
    await waitFor(cdp, sessionId, `document.querySelector('a[data-guide-id="platform/getting-started"].active')`, 'normal article after release note');
    if (!await evaluate(cdp, sessionId, `!document.querySelector('details[data-guide-group="release-history"]').open`)) throw new Error(`${viewport.name} history stayed open after leaving`);

    await navigate(cdp, sessionId, `${baseUrl}/wiki/guide/?lang=ja#/${currentId}`, `document.querySelector('a[data-guide-id="${currentId}"].active') && document.documentElement.lang === 'ja'`, 'Japanese release note');
    const japanese = await evaluate(cdp, sessionId, `(() => ({ title: document.querySelector('#guideArticle h1')?.textContent || '', groupTitle: document.querySelector('details[data-guide-group="release-history"] > summary span')?.textContent || '', open: document.querySelector('details[data-guide-group="release-history"]')?.open || false, overflow: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - document.documentElement.clientWidth }))()`);
    if (!japanese.title.includes('2.2.0') || japanese.groupTitle !== '更新履歴' || !japanese.open || japanese.overflow > 1) throw new Error(`${viewport.name} Japanese state invalid: ${JSON.stringify(japanese)}`);
    if (errors.length) throw new Error(`${viewport.name} console errors: ${errors.join(' | ')}`);

    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
    const screenshot = path.join(os.tmpdir(), `vnfest-guide-history-${viewport.name}.png`);
    fs.writeFileSync(screenshot, Buffer.from(data, 'base64'));
    console.log(`OK ${viewport.name} ${viewport.width}x${viewport.height} screenshot=${screenshot}`);
  } finally {
    cdp.listeners.delete(listener);
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

(async () => {
  const server = externalBaseUrl ? null : createStaticServer();
  if (server) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = externalBaseUrl || `http://127.0.0.1:${server.address().port}`;
  const chrome = await launchChrome();
  const cdp = new CdpClient(chrome.websocketUrl);
  try {
    await cdp.connect();
    for (const viewport of viewports) await inspectViewport(cdp, baseUrl, viewport);
  } finally {
    cdp.close();
    const chromeExited = new Promise(resolve => chrome.child.once('exit', resolve));
    chrome.child.kill();
    await Promise.race([chromeExited, sleep(3000)]);
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(chrome.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
