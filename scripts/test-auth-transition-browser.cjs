const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = process.env.AUTH_UI_OUTPUT || path.resolve(root, '../_codex-auth-transition-20261001');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, process.env.AUTH_TRANSITION_PREVIEW ? 'preview-profile' : 'browser-profile'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const state = { delay: 120, success: false, readyDelay: 500, calls: 0 };
const tags = fs.readFileSync(path.join(root, 'index.html'), 'utf8').split('\n').filter(l => /js\/theme-runtime|auth-transition\.(js|css)/.test(l)).join('\n').replaceAll('src="./','src="/').replaceAll('href="./','href="/');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/wiki/index.html') { res.writeHead(301, { Location: '/wiki/' + u.search }); return res.end(); }
  const json = v => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (['/user.html','/column/','/column/index.html','/admin/club_manager.html','/wiki/','/feedback.html'].includes(u.pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'+tags+'<script>window.__coveredAtHead=document.documentElement.classList.contains("vn-auth-arriving");</script></head><body><div id="root"><div class="vn-loading-screen">加载中…</div></div><script>setTimeout(function(){document.getElementById("root").innerHTML=\'<h1>本地页面转场演示</h1><a id="returnHome" href="/index.html?guest=1">返回地图</a>\'},'+Math.max(0,state.readyDelay)+');</script></body></html>');
  }
  if (u.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html lang="${u.searchParams.get('lang') === 'ja' ? 'ja' : 'zh-CN'}"><head><meta name="viewport" content="width=device-width,initial-scale=1">${tags}<script>window.__coveredAtHead=document.documentElement.classList.contains('vn-auth-arriving');</script></head><body><h1>首页 · 本地转场演示</h1><p>模拟登录成功，无真实账号请求。</p><button id="homeButton">首页入口</button><script>${state.readyDelay < 0 ? '' : `setTimeout(()=>{window.__vnfestMapReady=true;window.dispatchEvent(new CustomEvent('vnfest:map-ready'))},${state.readyDelay});`}</script></body></html>`);
  }
  if (u.pathname.startsWith('/api/')) {
    const action = u.searchParams.get('action');
    if (action === 'me') return json({ logged_in: false });
    if (action === 'oauth_config') return json({ qq_configured: true, discord_configured: true });
    if (u.pathname === '/api/backgrounds.php') return json({ images: [{ file: 'Defaultwallpaper.jpg', url: 'image/background/Defaultwallpaper.jpg' }] });
    if (action === 'login_local') {
      state.calls++;
      return setTimeout(() => json(state.success ? { success: true, user: { id: 1 } } : { success: false, message: '模拟凭据错误' }), state.delay);
    }
    return json({ success: true });
  }
  const file = path.resolve(root, '.' + decodeURIComponent(u.pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  if (process.env.AUTH_TRANSITION_PREVIEW && u.pathname === '/login.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const demo = `<button type="button" style="position:fixed;bottom:12px;left:12px;z-index:10000;padding:12px 16px;border:1px solid #e74c3c;border-radius:12px;background:#fff;color:#b93528;cursor:pointer" onclick="document.getElementById('loginUsername').value='动画预览';document.getElementById('loginPassword').value='demo-password';document.getElementById('loginBtn').click()">本地模拟 · 播放登录成功转场</button>`;
    return res.end(fs.readFileSync(file, 'utf8').replace('</body>', demo + '</body>'));
  }
  const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.jpg': 'image/jpeg', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type }); fs.createReadStream(file).pipe(res);
});
async function main() {
  await app.whenReady(); await new Promise(r => server.listen(process.env.AUTH_TRANSITION_PREVIEW ? 18745 : 0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  if (process.env.AUTH_TRANSITION_PREVIEW) {
    state.success = true; state.readyDelay = 1200;
    console.log('Local mock preview: ' + base + '/login.html?redirect=index.html%3Fguest%3D1');
    return;
  }
  fs.mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const until = async (code, timeout = 8000) => { for (let i = 0; i < timeout / 20; i++) { if (await run(code)) return; await wait(20); } throw Error('Timeout: ' + code); };
  const loadLogin = async lang => { await win.loadURL(base + '/login.html?redirect=index.html%3Fguest%3D1' + (lang ? '%26lang%3Dja&lang=ja' : '')); await until("!!window.VNFPageTransition && !!document.querySelector('.auth-password-toggle')"); };
  const submit = "document.getElementById('loginUsername').value='fixture';document.getElementById('loginPassword').value='fixture-password';document.getElementById('loginBtn').click();document.getElementById('loginBtn').click();document.getElementById('loginPassword').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))";
  let count = 0;
  try {
    // Failed credentials and a slow authentication request never start a curtain.
    await loadLogin(); await run(submit); await wait(50);
    assert.equal(await run("!!document.querySelector('.vn-auth-transition')"), false, 'no animation before authentication succeeds');
    await until("!document.getElementById('loginBtn').disabled");
    assert.equal(await run("!!document.querySelector('.vn-auth-transition')"), false, 'failed login stays usable');
    assert.equal(state.calls, 1, 'duplicate submission suppressed');
    state.success = true;
    for (const theme of ['light', 'dark']) for (const width of [1440, 768, 390, 320]) {
      win.setContentSize(width, width <= 390 ? 844 : 900);
      await loadLogin(width === 320);
      await run(`localStorage.setItem('themePreference','${theme}');document.documentElement.dataset.theme='${theme}'`);
      const before = state.calls; await run(submit);
      await until("document.querySelector('.vn-auth-transition')?.dataset.phase==='covering'");
      assert.equal(state.calls, before + 1);
      await until("location.pathname==='/index.html' && document.querySelector('.vn-auth-transition')?.dataset.phase==='arriving'");
      assert.equal(await run('window.__coveredAtHead'), true, 'homepage first paint is covered');
      assert.equal(await run("sessionStorage.getItem('vnfestAuthTransition')"), null, 'arrival marker consumed');
      assert.equal(await run("document.body.getAttribute('aria-busy')"), 'true');
      const box = await run("document.querySelector('.vn-auth-transition').getBoundingClientRect().toJSON()");
      assert.ok(box.left >= -1 && box.right <= width + 1 && box.width >= width - 1);
      if (width === 390 || width === 1440) fs.writeFileSync(path.join(out, `transition-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG());
      await until("document.querySelector('.vn-auth-transition')?.dataset.phase==='revealing'");
      await wait(60);
      assert.ok(await run("new DOMMatrix(getComputedStyle(document.querySelector('.vn-auth-transition')).transform).m42 < 0"), 'homepage curtain continues upwards');
      await until("!document.querySelector('.vn-auth-transition')");
      assert.equal(await run("document.documentElement.classList.contains('vn-auth-transitioning')"), false);
      assert.equal(await run("document.body.hasAttribute('aria-busy')"), false);
      assert.equal(await run('window.__vnfestMapReady'), true);
      await run("document.getElementById('homeButton').focus()"); assert.equal(await run('document.activeElement.id'), 'homeButton');
      count++;
    }
    // Direct visits, reloads, stale markers and malformed storage do not animate.
    await win.loadURL(base + '/index.html?guest=1'); assert.equal(await run('window.__coveredAtHead'), false);
    for (const marker of ['invalid-json', JSON.stringify({ version: 1, time: Date.now() - 30000, target: '/index.html?guest=1' })]) {
      await run(`sessionStorage.setItem('vnfestAuthTransition',${JSON.stringify(marker)})`); await win.loadURL(base + '/index.html?guest=1');
      assert.equal(await run("!!document.querySelector('.vn-auth-transition')"), false);
    }
    // No artificial transition delay for reduced motion.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await loadLogin(); await run(submit); await until("location.pathname==='/index.html'");
    assert.equal(await run("!!document.querySelector('.vn-auth-transition') || window.__coveredAtHead"), false);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    win.webContents.debugger.detach();
    // Storage blocked: the outgoing effect still navigates and the next page is usable.
    await loadLogin(); await run("Object.defineProperty(window,'sessionStorage',{get(){throw Error('blocked storage')}});void 0");
    await run(submit); await until("location.pathname==='/index.html'"); assert.equal(await run('window.__coveredAtHead'), false);
    // Missing homepage readiness cannot trap the user indefinitely.
    state.readyDelay = -1; await loadLogin(); await run(submit);
    await until("location.pathname==='/index.html' && !!document.querySelector('.vn-auth-transition')");
    await until("!document.querySelector('.vn-auth-transition')", 6500);
    assert.equal(await run("document.documentElement.classList.contains('vn-auth-transitioning')"), false);
    // Restoring a cached page clears its old curtain and keyboard lock.
    await loadLogin(); await run(submit);
    await until("location.pathname==='/index.html' && !!document.querySelector('.vn-auth-transition')");
    await run("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))");
    assert.equal(await run("!!document.querySelector('.vn-auth-transition')"), false);
    // Native homepage entries and return links retain normal browser history.
    state.readyDelay = 450;
    let pageCount = 0;
    for (const theme of ['light','dark']) for (const width of [1440,320]) for (const target of ['/user.html','/column/','/admin/club_manager.html?tab=pending','/wiki/index.html','/feedback.html']) {
      win.setContentSize(width,844); await win.loadURL(base+'/index.html?guest=1');
      await run("localStorage.setItem('themePreference','"+theme+"');document.documentElement.dataset.theme='"+theme+"'");
      const historyBefore = await run('history.length');
      await run("document.body.insertAdjacentHTML('beforeend','<a id=\"pageEntry\" href=\""+target+"\">页面入口</a>');document.getElementById('pageEntry').click()");
      await until("location.pathname!=='/index.html' && document.querySelector('.vn-auth-transition')?.dataset.phase==='arriving'");
      assert.equal(await run('window.__coveredAtHead'),true,'destination first paint covered');
      assert.equal(await run("document.querySelector('.vn-auth-transition__label').textContent.includes('登录成功')"),false,'page navigation label is generic');
      await until("document.querySelector('.vn-auth-transition')?.dataset.phase==='revealing'"); await wait(60);
      assert.ok(await run("new DOMMatrix(getComputedStyle(document.querySelector('.vn-auth-transition')).transform).m42<0"));
      await until("!document.querySelector('.vn-auth-transition')");
      assert.ok(await run('history.length')>=historyBefore,'navigation retains history');
      await run("document.getElementById('returnHome').click()");
      await until("location.pathname==='/index.html' && !document.querySelector('.vn-auth-transition') && window.__vnfestMapReady===true");
      pageCount++;
    }
    // Modified/new-window clicks and same-page React tabs keep their own behavior.
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    await win.loadURL(base+'/column/');
    await run("document.body.insertAdjacentHTML('beforeend','<a id=\"samePage\" href=\"/column/?tab=activity\">活动</a><a id=\"newWindow\" target=\"_blank\" href=\"/user.html\">新窗口</a>');document.getElementById('samePage').addEventListener('click',e=>e.preventDefault());document.getElementById('samePage').click();document.getElementById('newWindow').click()");
    assert.equal(await run("!!document.querySelector('.vn-auth-transition')"),false,'tabs and new-window links do not start a curtain');
    console.log('Shared page transition passed: '+pageCount+' homepage/account/space/admin/wiki/feedback routes and return links.');
    console.log(`Auth transition passed: ${count} desktop/mobile/theme paths; first paint, readiness, failure, duplicate requests, reduced motion, stale storage, blocked storage, fallback and cached-page recovery.`);
  } finally { win.destroy(); server.close(); app.quit(); }
}
main().catch(e => { console.error(e.stack); server.close(); app.exit(1); });
