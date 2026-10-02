const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { createServer, artifacts } = require('./serve-user-card-shapes-qa.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.on('window-all-closed', event => event.preventDefault());
const output = process.env.USER_CARD_QA_OUTPUT ? path.resolve(process.env.USER_CARD_QA_OUTPUT) : path.join(artifacts, 'qa');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'electron-profile'));
async function until(win, expression) {
  for (let i = 0; i < 120; i++) { if (await win.webContents.executeJavaScript(expression)) return; await wait(100); }
  throw new Error(`Timed out: ${expression}`);
}
async function main() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const results = [];
  try {
    for (const width of [1440, 768, 390, 320]) for (const theme of ['light', 'dark']) {
      const win = new BrowserWindow({ show: false, width, height: 1000, useContentSize: true, webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false, partition: `cards-${width}-${theme}` } });
      win.setContentSize(width, 1000);
      try {
        for (const [tab, selector, display] of [['overview', '.vn-today-item', 'grid'], ['notifications', '.vn-notification-row', 'grid'], ['preferences', '.vn-wallpaper-option', 'block']]) {
          await win.loadURL(`${base}/user.html?tab=${tab}&theme=${theme}&duplicate=1`);
          await until(win, `document.querySelectorAll('${selector}').length > 0`);
          await wait(500);
          await win.webContents.executeJavaScript('document.getAnimations().filter(a=>a.effect.getComputedTiming().iterations !== Infinity).forEach(a=>a.finish())');
          const metrics = await win.webContents.executeJavaScript(`(() => ({ theme: document.documentElement.dataset.theme, width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1, cards: [...document.querySelectorAll('${selector}')].map(e => { const s=getComputedStyle(e), r=e.getBoundingClientRect(), p=e.querySelector('.vn-wallpaper-preview'), n=e.querySelector('.vn-wallpaper-name'); return { radius:s.borderRadius, display:s.display, align:s.textAlign, keep:e.dataset.buttonShape, width:r.width, left:r.left, right:r.right, vertical: !p || n.getBoundingClientRect().top >= p.getBoundingClientRect().bottom - 1, ratio: p ? p.getBoundingClientRect().width / p.getBoundingClientRect().height : null }; }), pills: [...document.querySelectorAll('.ant-btn:not(.ant-btn-link, .ant-btn-text)')].filter(e=>e.getBoundingClientRect().width>0).map(e=>getComputedStyle(e).borderRadius) }))()`);
          assert.equal(metrics.width, width); assert.equal(metrics.theme, theme); assert.equal(metrics.overflow, false, `${width}/${theme}/${tab} overflow`);
          for (const card of metrics.cards) {
            assert.equal(card.radius, '12px'); assert.equal(card.keep, 'keep'); assert.equal(card.display, display); assert.equal(card.align, 'left');
            assert.ok(card.width > 0 && card.left >= 0 && card.right <= width + 1, JSON.stringify({width,theme,tab,card})); assert.equal(card.vertical, true);
            if (card.ratio !== null) assert.ok(Math.abs(card.ratio - 16 / 9) < 0.01);
          }
          assert.ok(metrics.pills.every(r => r === '9999px'), `${tab} action pills`);
          results.push({ width, theme, tab, cards: metrics.cards.length });
          if ([1440, 390].includes(width) && theme === 'light') {
            await win.webContents.executeJavaScript(`document.querySelector('${selector}').scrollIntoView({block:'center'})`);
            await wait(300);
            fs.writeFileSync(path.join(output, `after-${tab}-${width}.png`), (await win.webContents.capturePage()).toPNG());
          }
        }
      } finally { win.destroy(); }
    }
    const win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });

    try {
      // Check external stylesheet alone and capture the exact delivered baseline.
      for (const tab of fs.existsSync(path.join(artifacts, 'delivered-baseline/index.html')) ? ['overview', 'notifications', 'preferences'] : []) {
        await win.loadURL(`${base}/user.html?tab=${tab}&baseline=1`);
        await until(win, `document.querySelector('.vn-${tab === 'overview' ? 'today-item' : tab === 'notifications' ? 'notification-row' : 'wallpaper-option'}')`);
        await wait(300);
        fs.writeFileSync(path.join(output, `before-${tab}-1440.png`), (await win.webContents.capturePage()).toPNG());
      }
      await win.loadURL(`${base}/user.html?tab=overview`);
      await until(win, `document.querySelectorAll('.vn-today-item').length===3`);
      await win.webContents.executeJavaScript(`document.querySelectorAll('.vn-today-item')[1].focus()`);
      win.webContents.focus();
      await win.webContents.executeJavaScript('document.activeElement.click()');
      await until(win, `document.querySelector('.vn-notification-row')`);
      await win.webContents.executeJavaScript(`document.querySelector('.vn-notification-row').focus()`);
      win.webContents.focus();
      await win.webContents.executeJavaScript('document.activeElement.click()');
      await until(win, `document.querySelector('.vn-notification-row[aria-pressed="true"]:not(.is-unread)')`);
      assert.ok(server.fixtureWrites.some(w=>w.action==='mark_read'));
      await win.loadURL(`${base}/user.html?tab=preferences`);
      await until(win, `document.querySelectorAll('.vn-wallpaper-option').length===8`);
      await win.webContents.executeJavaScript(`document.querySelectorAll('.vn-wallpaper-option')[1].focus()`);
      win.webContents.focus();
      await win.webContents.executeJavaScript('document.activeElement.click()');
      await until(win, `document.querySelectorAll('.vn-wallpaper-option')[1].getAttribute('aria-pressed')==='true'`);
      assert.match(await win.webContents.executeJavaScript(`localStorage.getItem('vnfestWallpaperPreference')`), /fixture-image/);
      await win.webContents.executeJavaScript(`document.querySelectorAll('.vn-wallpaper-option')[7].scrollIntoView()`);
      await until(win, `document.querySelectorAll('.vn-wallpaper-option')[7].disabled`);

    } finally { win.destroy(); }
    if (fs.existsSync(path.join(artifacts, 'qa-bundled/index.html'))) {
      const bundledWin = new BrowserWindow({show:false, width:390, height:1000, useContentSize:true, webPreferences:{sandbox:true, offscreen:true, backgroundThrottling:false}});
      try {
        for (const theme of ['light','dark']) for (const tab of ['overview','notifications','preferences']) {
          await bundledWin.loadURL(`${base}/user.html?tab=${tab}&theme=${theme}&bundled=1`);
          await until(bundledWin, `document.querySelector('[data-button-shape="keep"]')`);
          const radii = await bundledWin.webContents.executeJavaScript(`[...document.querySelectorAll('[data-button-shape="keep"]')].map(e=>getComputedStyle(e).borderRadius)`);
          assert.ok(radii.length && radii.every(r=>r==='12px'));
          results.push({width:390,theme,tab,bundled:true,cards:radii.length});
        }
      } finally { bundledWin.destroy(); }
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ layouts: results, interactions: ['today navigation', 'notification open and mark-read', 'wallpaper selection and local persistence', 'unavailable disabled'], sharedCSS: ['external', 'external plus identical inline cascade', ...(results.some(r=>r.bundled)?['Vite bundled plus external']:[])] }, null, 2));
    console.log(`PASS: ${results.length} layouts and card state regression checks`);
  } finally { await new Promise(resolve => server.close(resolve)); }
}
app.whenReady().then(main).then(()=>app.exit(0), error=>{ console.error(error); app.exit(1); });
