/* Real page/layout checks with local read-only API fixtures; no production data. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, session } = require('electron');
const { homepageFixture } = require('./serve-auth-ui-qa.cjs');
const root = path.resolve(__dirname, '..');
const output = path.resolve(root, '../_codex-button-shapes-20261002/qa');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.setPath('userData', path.join(output, 'electron-profile'));
app.on('window-all-closed', event => event.preventDefault());

function startServer() {
  let currentPage = '';
  const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.endsWith('.html')) currentPage = url.pathname;
    if (url.pathname === '/auth-preview.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(homepageFixture().replace('</head>', '<link rel="stylesheet" href="css/button-shapes.css"></head>'));
    }
    if (url.pathname.startsWith('/api/')) {
      const action = url.searchParams.get('action');
      let body = { success: true, data: [], clubs: [], memberships: [], notifications: [], events: [], registrations: [], posts: [], users: [], count: 0, total: 0 };
      if (url.pathname === '/api/auth.php') body = action === 'oauth_config'
        ? { success: true, qq_configured: true, discord_configured: true }
        : { success: true, logged_in: !['/index.html', '/login.html'].includes(currentPage), user: { id: 1, username: 'shape-fixture', nickname: '按钮样式测试', role: 'super_admin', email: 'shapes@example.com', email_verified: true }, memberships: [] };
      if (url.pathname === '/api/galonly_booths.php' && /session|me/.test(action || '')) body = { success: true, logged_in: false, session: null };
      if (['/api/clubs.php', '/api/clubs_japan.php'].includes(url.pathname)) body = { success: true, data: [{ id: 1, name: '按钮样式测试同好会', school: '测试大学', province: '江苏', city: '南京', country: url.pathname.includes('japan') ? 'japan' : 'china', description: '本地布局测试', members: 5 }] };
      if (currentPage === '/admin/club_manager.html' && url.pathname === '/api/auth.php') {
        body.user.role = 'member';
        body.memberships = [{ club_id: 1, country: 'china', role: 'manager', status: 'active' }];
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(body));
    }
    const file = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html');
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': (mime[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Inspect the actual selectors shipped in the page, including Vite CSS bundles.
const inspect = `(() => {
  const selectors = [];
  function visit(rules) { for (const rule of rules) {
    if (rule.selectorText && rule.style?.getPropertyValue('border-radius').includes('--vn-button-radius')) selectors.push(rule.selectorText);
    if (rule.cssRules) visit(rule.cssRules);
  }}
  for (const sheet of document.styleSheets) { try { visit(sheet.cssRules); } catch {} }
  const matched = [...new Set(selectors.flatMap(s => [...document.querySelectorAll(s)]))];
  const visible = matched.filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  const failures = visible.filter(e => parseFloat(getComputedStyle(e).borderTopLeftRadius) < Math.min(e.offsetWidth, e.offsetHeight) / 2 - 0.5)
    .map(e => ({ tag: e.tagName, id: e.id, class: e.className, radius: getComputedStyle(e).borderRadius }));
  const alignmentFailures = visible.filter(e => {
    const css = getComputedStyle(e);
    return css.textAlign !== 'center' || css.justifyContent !== 'center' || css.alignItems !== 'center';
  }).map(e => ({ id: e.id, class: e.className, align: getComputedStyle(e).textAlign }));
  const contentOffsets = visible.flatMap(e => {
    const rects = []; const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    while(walker.nextNode()) {
      const node=walker.currentNode;
      if(!node.textContent.trim() || node.parentElement.closest('svg')) continue;
      if (!node.parentElement.getBoundingClientRect().width || parseFloat(getComputedStyle(node.parentElement).opacity) < 0.01) continue;
      const range=document.createRange(); range.selectNodeContents(node);
      rects.push(...[...range.getClientRects()].filter(r=>r.width>0&&r.height>0));
    }
    for(const icon of e.querySelectorAll('svg,img')) { const r=icon.getBoundingClientRect(); if(r.width&&r.height&&parseFloat(getComputedStyle(icon).opacity)>0.01)rects.push(r); }
    if(!rects.length)return [];
    // Inline decorative markers occupy space just like icons (MEME headings).
    const before=getComputedStyle(e,'::before'),bw=parseFloat(before.width);
    if(before.content!=='none'&&before.position!=='absolute'&&before.position!=='fixed'&&bw>0){
      const left=Math.min(...rects.map(r=>r.left)),top=Math.min(...rects.map(r=>r.top)),bottom=Math.max(...rects.map(r=>r.bottom));
      rects.push({left:left-bw-(parseFloat(before.marginLeft)||0)-(parseFloat(before.marginRight)||0),right:left,top,bottom});
    }
    const b=e.getBoundingClientRect(),l=Math.min(...rects.map(r=>r.left)),r=Math.max(...rects.map(r=>r.right)),t=Math.min(...rects.map(r=>r.top)),bottom=Math.max(...rects.map(r=>r.bottom));
    return [{ id:e.id, class:e.className, text:e.innerText, dx:((l+r-b.left-b.right)/2), dy:((t+bottom-b.top-b.bottom)/2) }];
  });
  return { url: location.pathname, selectors: selectors.length, matched: matched.length, visible: visible.length, failures,
    alignmentFailures, contentOffsets,
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    buttons: visible.map(e => ({ text: e.innerText || e.value || e.getAttribute('aria-label'), width: e.offsetWidth, height: e.offsetHeight, radius: getComputedStyle(e).borderRadius })) };
})()`;

async function main() {
  await app.whenReady(); fs.mkdirSync(output, { recursive: true });
  const server = await startServer(); const base = `http://127.0.0.1:${server.address().port}`;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(base) && /^https?:/.test(details.url) }));
  const win = new BrowserWindow({ show: false, width: 1440, height: 1000, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const pages = ['index.html', 'login.html', 'auth-preview.html', 'user.html', 'wiki/index.html', 'wiki/pages/china-2.html', 'Galgame_events/Beijing_Galonly_submit.html', 'Galgame_events/Beijing_GalOnly_booth_portal.html', 'moe/index.html', 'twelve/vote.html', 'tools/GalgameTool/index.html#meme', 'admin/club_manager.html', 'admin/reviews.html', 'column/index.html'];
  const results = [];
  try {
    for (const page of pages.filter(page => !process.env.BUTTON_SHAPES_PAGES || process.env.BUTTON_SHAPES_PAGES.split(',').includes(page))) {
      console.log('Checking ' + page);
      win.setContentSize(1440, 1000);
      await win.loadURL(base + '/' + page + (page === 'index.html' ? '?guest=1' : page === 'user.html' ? '?tab=account' : '')); await wait(800);
      if (page === 'admin/club_manager.html') {
        await win.loadURL(base + '/' + page + '?tab=settings&club_id=1&country=china'); await wait(800);
      }
      if (['user.html', 'admin/club_manager.html', 'column/index.html', 'Galgame_events/Beijing_GalOnly_booth_portal.html', 'Game/spy/index.html'].includes(page)) {
        for (let i = 0; i < 40; i++) {
          if (await run('Boolean(document.querySelector("#root button"))')) break;
          await wait(100);
        }
        assert.ok(await run('Boolean(document.querySelector("#root button"))'), page + ': React controls rendered');
      }
      for (const theme of ['light', 'dark']) {
        await run(`document.documentElement.dataset.theme='${theme}'; if(window.VNFTheme?.setTheme) VNFTheme.setTheme('${theme}');`);
        for (const width of [1440, 390, 360]) {
          win.setContentSize(width, width === 1440 ? 1000 : 844); await wait(120);
          await run('document.getAnimations().filter(a => a.effect.getComputedTiming().iterations !== Infinity).forEach(a => a.finish())');
          const result = await run(inspect);
          if (!result.matched) {
            fs.writeFileSync(path.join(output, 'unmatched.html'), await run('document.documentElement.outerHTML'));
            console.log(await run('document.body.innerText.slice(0, 300)'));
          }
          assert.ok(result.selectors > 0, page + ': common shapes loaded');
          assert.equal(result.url, '/' + page.split('#')[0], page + ': remained on the intended page');
          assert.ok(result.matched > 0, page + ': actions found ' + JSON.stringify(result));
          assert.deepEqual(result.failures, [], page + '/' + theme + '/' + width + ': pill radii');
          assert.deepEqual(result.alignmentFailures, [], page + '/' + theme + '/' + width + ': centered content');
          assert.deepEqual(result.contentOffsets.filter(c => Math.abs(c.dx)>2 || Math.abs(c.dy)>3), [], page + '/' + theme + '/' + width + ': visible text/icon group centered');
          results.push({ page, theme, width, ...result });
          fs.writeFileSync(path.join(output, 'progress.json'), JSON.stringify(results, null, 2));
          if (theme === 'light' && [1440, 390].includes(width) && ['login.html', 'auth-preview.html', 'admin/club_manager.html', 'column/index.html'].includes(page)) {
            fs.writeFileSync(path.join(output, page.replaceAll('/', '-') + '-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
          }
        }
      }
    }
    // Dynamic controls and exceptions must inherit the same contract without JS.
    await win.loadURL(base + '/login.html');
    const sample = await run(`(() => {
      const box = document.createElement('div'); box.id='shape-fixtures';
      box.innerHTML = '<style>#shape-fixtures button,#shape-fixtures input,#shape-fixtures a,#shape-fixtures .card {border-radius:8px;padding:8px;} #shape-fixtures .square{width:44px;height:44px;}</style><button id="dynamic-action" style="border-radius:4px">动态操作</button><button id="disabled-action" disabled>暂不可用</button><button id="circle-action" data-button-shape="circle" class="square">×</button><a id="link-action" class="btn" href="#">操作链接</a><button id="tab-exception" role="tab">分段</button><button id="switch-exception" role="switch">开关</button><button id="card-exception" class="insights-kpi">卡片</button><button id="keep-exception" data-button-shape="keep">自定义</button><div data-button-shape="keep"><button id="container-exception">第三方控件</button></div><button id="text-exception" class="auth-text-button">文字链接</button><input id="input-exception"><div id="panel-exception" class="card">面板</div>';
      document.body.append(box); const radius=id=>getComputedStyle(document.getElementById(id)).borderTopLeftRadius;
      document.getElementById('dynamic-action').focus();
      return Object.fromEntries([...box.querySelectorAll('[id]')].map(e=>[e.id,radius(e.id)]));
    })()`);
    assert.ok(await run(`(() => {
      const e=document.createElement('button');e.hidden=true;e.textContent='hidden';document.body.append(e);
      const hidden=!e.getClientRects().length;e.remove();return hidden;
    })()`), 'hidden actions remain hidden with the flex default');
    for (const id of ['dynamic-action', 'disabled-action', 'link-action']) assert.equal(sample[id], '9999px', id);
    assert.equal(sample['circle-action'], '50%');
    for (const id of ['tab-exception', 'switch-exception', 'card-exception', 'keep-exception', 'container-exception', 'text-exception', 'input-exception', 'panel-exception']) assert.equal(sample[id], '8px', id + ' preserves its shape');
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ cases: results.length, results, dynamic: sample }, null, 2));
    console.log(`PASS: ${results.length} real page/theme/viewport cases plus dynamic, disabled, circle and exception controls. Screenshots: ${output}`);
  } finally { win.destroy(); server.close(); }
}
main().then(() => app.exit(0), error => { console.error(error.stack); app.exit(1); });
