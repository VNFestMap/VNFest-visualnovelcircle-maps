const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('./serve-auth-ui-qa.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  await app.whenReady();
  const { server, state } = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { backgroundThrottling: false, offscreen: true } });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const run = async code => {
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (error) { throw new Error(`${code.slice(0, 180)}\n${errors.join('\n')}\n${error.message}`); }
  };
  const until = async code => {
    for (let i = 0; i < 80; i++) { if (await run(code)) return; await wait(50); }
    throw new Error('Timed out: ' + code);
  };
  const out = process.env.AUTH_UI_OUTPUT || path.resolve(__dirname, '../../_codex-auth-ui-20261001');
  fs.mkdirSync(out, { recursive: true });
  let layoutCount = 0;
  try {
    for (const page of ['auth-preview.html', 'login.html']) {
      await win.loadURL(base + '/' + page);
      await until(`!!document.querySelector('.auth-password-toggle')`);
      if (page === 'login.html') {
        await run(`localStorage.setItem('vnfestWallpaperPreference','images/a9b7bf991c6688102abd0059eba3c3f8.jpeg')`);
        await win.loadURL(base + '/login.html');
        await until(`!!document.querySelector('.auth-password-toggle')`);
        assert.equal(await run(`getComputedStyle(document.documentElement).getPropertyValue('--login-wallpaper').includes('url(')`), false, 'old wallpaper preference must not load an image');
        assert.equal(await run(`!!document.getElementById('wallpaperSelect')`), false, 'random wallpaper selector removed');
        await until(`window.VNFWallpaper && window.VNFWallpaper.getState().status !== 'loading'`);
        assert.ok(await run(`window.VNFWallpaper.getState().activeUrl.endsWith('/image/background/Defaultwallpaper.jpg')`), 'guest uses the common default background and ignores saved random wallpaper');
      }
      for (const theme of ['light', 'dark']) {
        await run(`document.documentElement.dataset.theme='${theme}'`);
        for (const width of [1440, 768, 390, 320]) {
          win.setContentSize(width, width <= 320 ? 640 : width <= 390 ? 844 : 1000);
          if (page === 'login.html') {
            await until(`window.VNFWallpaper.getState().mobileDisabled === ${width <= 720}`);
            if (width <= 720) assert.equal(await run(`!!document.getElementById('vnfestWallpaperLayer')`), false, 'common mobile background guard');
            else await until(`!!document.getElementById('vnfestWallpaperLayer')`);
          }
          for (const view of page.startsWith('auth') ? ['login','register'] : ['login','register','forgot','oauth']) {
            await run(page.startsWith('auth') ? `openAccountModal('${view}')` : ({ login: "document.getElementById('goLogin').click()", register: "document.getElementById('goRegister').click()", forgot: "document.getElementById('goForgot').click()", oauth: "document.querySelectorAll('.auth-view').forEach(e=>e.classList.add('inactive'));document.getElementById('oauthSetupForm').classList.remove('inactive')" })[view]);
            await wait(400);
            // Hidden Chromium windows can pause animation timelines. Inspect the settled state.
            await run(`document.getAnimations().filter(a=>a.effect.getComputedTiming().iterations!==Infinity).forEach(a=>a.finish())`);
            const box = await run(`(() => {
              const view=[...document.querySelectorAll('.auth-view')].find(e=>e.getClientRects().length);
              const input=view.querySelector('.auth-input'); input.focus();
              const css=getComputedStyle(input);
              const overflow=[...view.querySelectorAll('input,button,.auth-input-row')].filter(e=>e.getClientRects().length).filter(e=>e.getBoundingClientRect().right>innerWidth+1 || e.getBoundingClientRect().left< -1).map(e=>e.id||e.className);
              const socialHeights=[...view.querySelectorAll('.auth-social-row .auth-btn')].filter(e=>e.getClientRects().length).map(e=>e.getBoundingClientRect().height);
              return { socialHeights, overflow, outline:css.outlineStyle, height:input.getBoundingClientRect().height, opacity:getComputedStyle(view).opacity, visible:getComputedStyle(view).visibility, card:document.querySelector('.calendar-modal-card')?.getBoundingClientRect().toJSON(), pageOverflow:document.documentElement.scrollWidth>innerWidth+1 };
            })()`);
            assert.equal(box.outline, 'none', `${page}/${view}/${width}/${theme}: duplicate focus outline`);
            assert.ok(box.height >= 47.9, `${page}/${view}/${width}/${theme}: input touch size ${JSON.stringify(box)}`);
            assert.deepEqual(box.overflow, [], `${page}/${view}/${width}/${theme}: control overflow`);
            assert.equal(box.pageOverflow, false, 'page overflow');
            assert.equal(box.visible, 'visible', 'form must be visible');
            assert.equal(box.opacity, '1', `${page}/${view}/${width}/${theme}: form opacity`);
            for (const height of box.socialHeights) assert.ok(height >= 47.9 && height <= 48.1, `${page}/${view}/${width}/${theme}: social button height ${height}`);
            if(box.card) { assert.ok(box.card.left>=15.5,'mobile and desktop card margins'); assert.ok(box.card.right<=width-15.5,'right card margin'); }
            if (page === 'login.html') {
              const centered = await run(`(() => { const c=document.getElementById('gateCard').getBoundingClientRect();return {offset:Math.abs((c.left+c.right)/2-document.documentElement.clientWidth/2),width:c.width,icons:[...document.querySelectorAll('#socialRow button')].map(b=>({svg:!!b.querySelector('svg[aria-hidden="true"]'),label:!!b.querySelector('span')?.textContent.trim()}))}; })()`);
              assert.ok(centered.offset <= 5 && centered.width <= 480.1, 'centered standalone card');
              assert.ok(centered.icons.every(i=>i.svg && i.label), 'provider entries have decorative SVG and readable text');
            }
            layoutCount++;
            if ((width === 390 || width === 1440) && view === 'login') {
              const shot = await win.webContents.capturePage();
              fs.writeFileSync(path.join(out, `${page.split('.')[0]}-${theme}-${width}.png`), shot.toPNG());
            }
          }
        }
      }
      // Japanese labels and long messages at the narrowest supported viewport.
      win.setContentSize(320, 640);
      await run(`document.documentElement.lang='ja'`);
      await run(page.startsWith('auth') ? "openAccountModal('register')" : "document.getElementById('goRegister').click()");
      await wait(220);
      assert.equal(await run(`document.documentElement.scrollWidth > innerWidth + 1`), false, 'Japanese narrow layout');
      assert.equal(await run(`document.querySelector('.auth-password-toggle').textContent`), '表示');
      await run(`window.authLabelMutations=0;window.authLabelObserver=new MutationObserver(m=>window.authLabelMutations+=m.length);window.authLabelObserver.observe(document.querySelector('.auth-password-toggle'),{childList:true});document.documentElement.lang='ja'`);
      await wait(150);
      assert.equal(await run(`window.authLabelMutations`), 0, 'unchanged language must not rewrite password labels');
      await run(`window.authLabelObserver.disconnect()`);
      const narrowMsg = page.startsWith('auth') ? 'accRegMessage' : 'regMsg';
      await run(`window.VNAuthUI.message(document.getElementById('${narrowMsg}'),'入力内容を確認してもう一度お試しください。'.repeat(5),'error');document.getElementById('${narrowMsg}').style.display='block'`);
      assert.equal(await run(`document.getElementById('${narrowMsg}').scrollWidth > document.getElementById('${narrowMsg}').clientWidth + 1`), false, 'long Japanese message wraps');
      if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      assert.equal(await run(`getComputedStyle(document.querySelector('.auth-password-toggle')).transitionDuration`), '0s', 'reduced motion');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      await run(`document.documentElement.lang='zh-CN'`);
      // Keyboard and busy-state tests run against actual handlers and local API responses.
      win.setContentSize(768, 1000);
      await run(page.startsWith('auth') ? `openAccountModal('login')` : "document.getElementById('goLogin').click()");
      await wait(60);
      const prefix = page.startsWith('auth') ? 'accLogin' : 'login';
      const btn = prefix + 'Btn';
      const msg = page.startsWith('auth') ? 'accLoginMessage' : 'loginMsg';
      const submit = page.startsWith('auth') ? 'submitAccountLogin()' : "document.getElementById('loginBtn').click()";
      await run(`document.getElementById('${btn}').click()`);
      assert.equal(await run(`document.activeElement.id`), prefix + 'Username', 'empty required input gets focus');
      await run(`document.getElementById('${prefix}Username').value='fixture';document.getElementById('${prefix}Password').value='fixture-password'`);
      await run(`document.querySelector('#${prefix}Password').parentElement.querySelector('button').click()`);
      assert.equal(await run(`document.getElementById('${prefix}Password').type`), 'text');
      assert.equal(await run(`document.activeElement.id`), prefix + 'Password');
      state.mode = 'error'; state.delay = 350;
      const before = state.calls.login_local || 0;
      await run(`${submit};${submit};document.getElementById('${prefix}Password').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
      assert.equal(await run(`document.getElementById('${btn}').disabled`), true);
      await until(`!document.getElementById('${btn}').disabled`);
      assert.equal(state.calls.login_local - before, 1, 'duplicate submissions must produce one request');
      assert.equal(await run(`document.getElementById('${msg}').classList.contains('error')`), true);
      const count = state.calls.login_local;
      await run(`document.getElementById('${prefix}Password').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true}));`);
      await wait(100); assert.equal(state.calls.login_local, count, 'IME Enter must not submit');
      state.mode = 'network'; await run(submit);
      await until(`!document.getElementById('${btn}').disabled`);
      assert.ok(await run(`document.getElementById('${msg}').textContent.includes('网络')`), 'network failure feedback');
      if (page.startsWith('auth')) {
        await run(`document.getElementById('accShowRegisterBtn').click()`);
        await wait(60);
        assert.equal(await run(`document.activeElement.id`), 'accRegUsername');
        await run(`for(const [id,value] of Object.entries({accRegUsername:'fixture',accRegPassword:'fixture-password',accRegEmail:'fixture@example.com',accRegCode:'123456'}))document.getElementById(id).value=value`);
        state.mode = 'error'; const beforeReg = state.calls.register_local || 0;
        await run(`submitAccountRegister();submitAccountRegister();`);
        await until(`!document.getElementById('accRegisterBtn').disabled`);
        assert.equal(state.calls.register_local - beforeReg, 1, 'register duplicate suppression');
        await run(`document.getElementById('accShowLoginBtn').click()`);
        await run(`document.getElementById('accountModalClose').focus()`);
        await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}))`);
        await wait(50);
        assert.equal(await run(`document.activeElement.id`), 'accShowRegisterBtn', 'Shift Tab wraps focus');
        await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
        assert.equal(await run(`document.getElementById('accountModal').classList.contains('open')`), false);
        assert.equal(await run(`document.activeElement.id`), 'previewLogin', 'close returns focus');
        assert.equal(await run(`document.getElementById('accLoginPassword').type`), 'password', 'closing hides password');
        await run(`openAccountModal('login')`);
        await run(`document.documentElement.lang='ja'`); await wait(30);
        assert.equal(await run(`document.querySelector('.auth-password-toggle').textContent`), '表示');
        await run(`document.documentElement.lang='zh-CN'`);
      }
      state.mode = 'success'; state.delay = 80;
      await run(`${submit};${submit};`);
      if (page.startsWith('auth')) await until(`!document.getElementById('accountModal').classList.contains('open')`);
      else await until(`document.getElementById('${msg}').textContent.includes('成功')`);
      await wait(800);
    }
    const unexpected = errors.filter(e => !/ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|Failed to load resource|wallpaper|404/.test(e));
    assert.deepEqual(unexpected, [], 'unexpected renderer errors');
    console.log('Fixture layouts and authentication interactions passed.');
    // The successful login has navigated to the media-heavy homepage. Stop its
    // remaining resources before starting the separate Japanese login check.
    win.webContents.stop();
    await wait(100);
    await win.loadURL(base + '/login.html?lang=ja');
    await until(`document.documentElement.lang==='ja' && !!document.querySelector('.auth-password-toggle')`);
    win.setContentSize(320, 640);
    for (const theme of ['light', 'dark']) {
      await run(`document.documentElement.dataset.theme='${theme}'`);
      for (const id of ['goLogin', 'goRegister', 'goForgot']) {
        await run(`document.getElementById('${id}').click()`);
        await wait(200);
        await run(`document.getAnimations().filter(a=>a.effect.getComputedTiming().iterations!==Infinity).forEach(a=>a.finish())`);
        assert.equal(await run(`document.documentElement.scrollWidth > innerWidth+1`), false, 'actual Japanese translation layout');
      }
    }
    console.log('Japanese translated layouts passed.');
    // Full homepage integration: real script loader, real login trigger and scoped styles.
    win.setContentSize(1440, 1000);
    const homeLoad = win.loadURL(base + '/index.html?guest=1&lang=zh').catch(error => {
      if (!/ERR_ABORTED|\(-3\)/.test(String(error))) throw error;
    });
    // The load event can wait for unrelated remote homepage media; bound that wait.
    let homeTimer;
    await Promise.race([homeLoad, new Promise(resolve => { homeTimer = setTimeout(() => { win.webContents.stop(); resolve(); }, 20000); })]);
    clearTimeout(homeTimer);
    await until(`typeof openAccountModal==='function' && !!window.VNAuthUI`);
    await run(`document.getElementById('topLoginBtn').click()`);
    await until(`document.getElementById('accountModal').classList.contains('account-auth')`);
    assert.equal(await run(`document.activeElement.id`), 'accLoginUsername', 'full homepage initial focus');
    for (const width of [1440, 390, 320]) {
      win.setContentSize(width, width === 320 ? 640 : 844);
      await wait(400);
      await run(`document.getAnimations().filter(a=>a.effect.getComputedTiming().iterations!==Infinity).forEach(a=>a.finish())`);
      const bounds = await run(`document.querySelector('#accountModal .calendar-modal-card').getBoundingClientRect().toJSON()`);
      assert.ok(bounds.left >= 15.5 && bounds.right <= width - 15.5, 'full homepage centered card');
      fs.writeFileSync(path.join(out, `index-login-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await run(`document.getElementById('accShowRegisterBtn').click()`);
    assert.equal(await run(`document.activeElement.id`), 'accRegUsername', 'full homepage register focus');
    await run(`closeAccountModal()`);
    assert.equal(await run(`document.getElementById('accountModal').classList.contains('account-auth')`), false, 'auth styling removed on close');
    console.log(`Auth UI browser passed: ${layoutCount} layout/theme/view checks; Japanese, reduced motion, busy, errors, IME, password, registration, focus, success and full homepage integration.`);
    console.log('Screenshots: ' + out);
  } finally { win.destroy(); server.close(); app.quit(); }
}
main().catch(error => { console.error(error.stack); app.exit(1); });
