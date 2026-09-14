const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const baseUrl = process.env.GALGAME_TOOL_BASE_URL || 'http://127.0.0.1:4173';
const targetUrl = `${baseUrl}/tools/GalgameTool/index.html?browser-check=20260903`;
const screenshotDir = path.resolve('artifacts/galgame-tool-browser');
const shouldCapture = process.env.GALGAME_TOOL_CAPTURE === '1';
if (shouldCapture) fs.mkdirSync(screenshotDir, { recursive: true });

app.on('window-all-closed', event => event.preventDefault());

function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function inspectViewport(width, height) {
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: {
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) consoleErrors.push(message);
  });

  await win.loadURL(`${targetUrl}&viewport=${width}-${Date.now()}`);
  await pause(900);
  await win.webContents.executeJavaScript(`(() => {
    localStorage.removeItem('bishoujo_resume_data');
    localStorage.removeItem('bishoujo_resume_data:guest');
    state.profile.accountType = '';
    loadState();
    updateAccountPlatformControl();
    renderResume();
    applyMode();
    applyToggles();
  })()`);
  await pause(250);
  const initial = await win.webContents.executeJavaScript(`(() => {
    const paper = document.getElementById('resumePaper');
    const stage = document.getElementById('resumeScaleStage');
    const menu = document.querySelector('.tool-sidebar');
    const rect = paper.getBoundingClientRect();
    return {
      viewport: innerWidth,
      bodyOverflow: document.body.scrollWidth <= innerWidth + 1,
      paperWidth: Math.round(rect.width),
      stageWidth: Math.round(stage.getBoundingClientRect().width),
      paperNaturalWidth: paper.offsetWidth,
      menuPosition: getComputedStyle(menu).position,
      menuWidth: Math.round(menu.getBoundingClientRect().width),
      editButtonVisible: getComputedStyle(document.getElementById('mobileEditToggle').parentElement).display !== 'none',
      topbar: (() => {
        const topbar = document.querySelector('.vn-topbar');
        const brand = document.querySelector('.vn-topbar-brand');
        const actions = document.querySelector('.vn-topbar-actions');
        const subtitle = document.querySelector('.vn-topbar-sub');
        const divider = document.querySelector('.vn-topbar-divider');
        const topbarRect = topbar.getBoundingClientRect();
        const brandRect = brand.getBoundingClientRect();
        const actionsRect = actions.getBoundingClientRect();
        return {
          height: Math.round(topbarRect.height),
          brandTop: Math.round(brandRect.top),
          actionsTop: Math.round(actionsRect.top),
          actionsBottom: Math.round(actionsRect.bottom),
          subtitleDisplay: getComputedStyle(subtitle).display,
          dividerDisplay: getComputedStyle(divider).display,
          accountPlatform: (() => {
            const button = document.getElementById('accountPlatformToggle');
            return {
              present: Boolean(button),
              title: button?.title || '',
              label: button?.querySelector('.account-platform-toolbar-label')?.textContent.trim() || '',
              type: button?.dataset.accountType || ''
            };
          })()
        };
      })(),
      accountControlInToolbar: (() => {
        const toolbar = document.querySelector('.toolbar');
        const button = document.getElementById('accountPlatformToggle');
        if (!toolbar || !button) return false;
        const toolbarRect = toolbar.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        return button.closest('.toolbar') === toolbar && buttonRect.top >= toolbarRect.top - 1 && buttonRect.bottom <= toolbarRect.bottom + 1;
      })(),
      metadataHalfWidths: Array.from(document.querySelectorAll('.resume-half-grid')).map(grid =>
        Array.from(grid.children).map(child => Math.round(child.getBoundingClientRect().width))
      ),
      worksTitleBar: (() => {
        const label = document.querySelector('.works-section .section-label');
        const bar = label ? getComputedStyle(label, '::before') : null;
        return bar ? { width: bar.width, background: bar.backgroundColor } : null;
      })(),
      heroineTitleBar: (() => {
        const label = document.querySelector('.heroine-section .section-label');
        const bar = label ? getComputedStyle(label, '::before') : null;
        return bar ? { width: bar.width, background: bar.backgroundColor } : null;
      })(),
      attributesList: (() => {
        const list = document.querySelector('[data-section-id="attributes"] .list-grid');
        const add = document.querySelector('[data-section-id="attributes"] .list-add');
        if (!list || !add) return null;
        const listRect = list.getBoundingClientRect();
        return {
          width: Math.round(listRect.width),
          addHeight: Math.round(add.getBoundingClientRect().height),
          addMinHeight: parseFloat(getComputedStyle(add).minHeight),
          addText: add.textContent.trim()
        };
      })()
    };
  })()`);

  let directory = null;
  let avatarCrop = null;
  if (width <= 900) {
    if (shouldCapture) {
      const screenshot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(screenshotDir, `${width}-fit.png`), screenshot.toPNG());
    }
    assert.equal(initial.bodyOverflow, true, `${width}px should not overflow horizontally`);
    assert.ok(initial.paperWidth <= width - 12, `${width}px paper should fit the viewport`);
    assert.equal(initial.stageWidth, initial.paperWidth, `${width}px stage should track the scaled paper`);
    assert.equal(initial.menuPosition, 'sticky', `${width}px menu should stay under the top-level header`);
    assert.ok(initial.menuWidth >= initial.viewport - 10, `${width}px menu should span the content width`);
    assert.equal(initial.editButtonVisible, true, `${width}px equal-scale edit action should be visible`);
    assert.ok(initial.topbar.height <= 60, `${width}px top-level header should stay compact`);
    assert.equal(initial.topbar.brandTop, initial.topbar.actionsTop, `${width}px top-level header brand and actions should share one row`);
    assert.ok(initial.topbar.actionsBottom <= initial.topbar.height + 1, `${width}px top-level header actions should stay inside the header`);
    assert.equal(initial.topbar.subtitleDisplay, 'none', `${width}px tool subtitle should be hidden in the top-level header`);
    assert.equal(initial.topbar.dividerDisplay, 'none', `${width}px tool subtitle divider should be hidden in the top-level header`);
    assert.equal(initial.topbar.accountPlatform.present, true, `${width}px top-level account platform toggle should be present`);
    assert.match(initial.topbar.accountPlatform.title, /Bangumi/);
    assert.equal(initial.topbar.accountPlatform.type, 'bgm');
    assert.equal(initial.accountControlInToolbar, true, `${width}px account platform toggle should be inside the editor toolbar`);
    assert.equal(initial.metadataHalfWidths.length, 2, `${width}px should have two metadata half-width rows`);
    initial.metadataHalfWidths.forEach((row, index) => {
      assert.equal(row.length, 2, `${width}px metadata row ${index + 1} should have two sections`);
      assert.ok(Math.abs(row[0] - row[1]) <= 1, `${width}px metadata row ${index + 1} should be split evenly`);
    });
    assert.equal(initial.worksTitleBar.width, '3px', `${width}px works title should have a 3px accent bar`);
    assert.equal(initial.heroineTitleBar.width, '3px', `${width}px heroine title should have a 3px accent bar`);
    assert.ok(initial.attributesList.addMinHeight >= 44, `${width}px attributes add control should be touch-sized`);
    assert.match(initial.attributesList.addText, /添加/);

    const equalScale = await win.webContents.executeJavaScript(`(() => {
      document.getElementById('mobileEditToggle').click();
      return new Promise(resolve => requestAnimationFrame(() => {
        const paper = document.getElementById('resumePaper');
        const stage = document.getElementById('resumeScaleStage');
        const container = document.getElementById('resumeContainer');
        resolve({
          active: document.body.classList.contains('mobile-editor-open'),
          paperWidth: Math.round(paper.getBoundingClientRect().width),
          stageWidth: Math.round(stage.getBoundingClientRect().width),
          scrollWidth: Math.round(container.scrollWidth),
          label: document.querySelector('.mobile-edit-toggle-label').textContent
        });
      }));
    })()`);
    assert.equal(equalScale.active, true, `${width}px equal-scale mode should activate`);
    assert.equal(equalScale.paperWidth, initial.paperNaturalWidth, `${width}px equal-scale mode should restore natural width`);
    assert.equal(equalScale.stageWidth, initial.paperNaturalWidth, `${width}px equal-scale stage should restore natural width`);
    assert.ok(equalScale.scrollWidth >= initial.paperNaturalWidth, `${width}px equal-scale mode should allow horizontal editing`);
    assert.match(equalScale.label, /退出放大编辑/);

    await pause(120);
    if (shouldCapture) {
      const editScreenshot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(screenshotDir, `${width}-equal-scale.png`), editScreenshot.toPNG());
    }

    await win.webContents.executeJavaScript(`document.getElementById('mobileEditToggle').click()`);
    await pause(100);

    directory = await win.webContents.executeJavaScript(`(() => {
      const add = document.querySelector('.thumb-add');
      add.click();
      const popup = document.getElementById('addMenuPopup');
      const popupRect = popup.getBoundingClientRect();
      document.querySelector('.add-menu-item').click();
      const modal = document.querySelector('#searchModal .modal');
      const modalRect = modal.getBoundingClientRect();
      const result = {
        popupWithinViewport: popupRect.left >= 0 && popupRect.right <= innerWidth + 1,
        popupTouchTarget: getComputedStyle(document.querySelector('.add-menu-item')).minHeight,
        modalWidth: Math.round(modalRect.width),
        modalHeight: Math.round(modalRect.height),
        viewportHeight: innerHeight,
        modalActive: document.getElementById('searchModal').classList.contains('active'),
        bodyLocked: getComputedStyle(document.body).overflow === 'hidden'
      };
      return result;
    })()`);
    if (shouldCapture) {
      await pause(120);
      const screenshot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(screenshotDir, `${width}-directory-picker.png`), screenshot.toPNG());
    }
    await win.webContents.executeJavaScript('closeModal()');
    assert.equal(directory.popupWithinViewport, true, `${width}px directory menu should stay within the viewport`);
    assert.equal(directory.popupTouchTarget, '44px', `${width}px directory menu item should have a touch-sized target`);
    assert.ok(directory.modalWidth >= initial.viewport - 1, `${width}px directory picker should use the mobile width`);
    assert.ok(directory.modalHeight >= directory.viewportHeight - 2, `${width}px directory picker should use the mobile height`);
    assert.equal(directory.modalActive, true, `${width}px directory picker should open`);
    assert.equal(directory.bodyLocked, true, `${width}px directory picker should lock background scrolling`);

    avatarCrop = await win.webContents.executeJavaScript(`(async () => {
      const source = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640"><rect width="100%" height="100%" fill="#93c5fd"/></svg>');
      openAvatarCrop(source, 'resume');
      await new Promise(resolve => setTimeout(resolve, 80));
      await new Promise(resolve => requestAnimationFrame(resolve));
      const container = document.querySelector('#avatarCropModal .avatar-crop-container');
      const area = document.getElementById('avatarCropArea');
      const frame = document.getElementById('avatarCropFrame');
      const footerButton = document.querySelector('#avatarCropModal .avatar-crop-footer .btn');
      const containerRect = container.getBoundingClientRect();
      const areaRect = area.getBoundingClientRect();
      const frameRect = frame.getBoundingClientRect();
      const result = {
        active: document.getElementById('avatarCropModal').classList.contains('active'),
        containerWidth: Math.round(containerRect.width),
        viewportWidth: innerWidth,
        containerHeight: Math.round(containerRect.height),
        viewportHeight: innerHeight,
        areaHeight: Math.round(areaRect.height),
        frameWithinArea: frameRect.left >= areaRect.left && frameRect.right <= areaRect.right && frameRect.top >= areaRect.top && frameRect.bottom <= areaRect.bottom,
        touchAction: getComputedStyle(area).touchAction,
        pointerDragReady: typeof document.onpointermove === 'function',
        footerButtonHeight: Math.round(footerButton.getBoundingClientRect().height),
        bodyLocked: getComputedStyle(document.body).overflow === 'hidden'
      };
      return result;
    })()`);
    if (shouldCapture) {
      await pause(120);
      const screenshot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(screenshotDir, `${width}-avatar-crop.png`), screenshot.toPNG());
    }
    await win.webContents.executeJavaScript('closeAvatarCrop()');
    assert.equal(avatarCrop.active, true, `${width}px avatar crop should open`);
    assert.equal(avatarCrop.containerWidth, avatarCrop.viewportWidth, `${width}px avatar crop should use the mobile width`);
    assert.equal(avatarCrop.containerHeight, avatarCrop.viewportHeight, `${width}px avatar crop should use the mobile height`);
    assert.equal(avatarCrop.frameWithinArea, true, `${width}px crop frame should stay inside the image area`);
    assert.equal(avatarCrop.touchAction, 'none', `${width}px crop surface should reserve touch gestures`);
    assert.equal(avatarCrop.pointerDragReady, true, `${width}px crop surface should use pointer drag events`);
    assert.ok(avatarCrop.footerButtonHeight >= 44, `${width}px crop actions should have touch-sized buttons`);
    assert.equal(avatarCrop.bodyLocked, true, `${width}px avatar crop should lock background scrolling`);
  } else {
    assert.equal(initial.editButtonVisible, false, `${width}px equal-scale action should stay mobile-only`);
    assert.equal(initial.worksTitleBar.width, '3px', `${width}px works title should have a 3px accent bar`);
    assert.equal(initial.heroineTitleBar.width, '3px', `${width}px heroine title should have a 3px accent bar`);
    assert.ok(initial.attributesList.addMinHeight >= 34, `${width}px attributes add control should have a usable control height`);
    assert.match(initial.attributesList.addText, /添加/);
  }

  const themeState = await win.webContents.executeJavaScript(`(() => {
    const before = document.documentElement.getAttribute('data-theme');
    document.getElementById('themeToggle').click();
    return new Promise(resolve => setTimeout(() => resolve({
      before,
      after: document.documentElement.getAttribute('data-theme'),
      transitionStyle: Boolean(document.getElementById('vn-theme-transition-styles')),
      originX: document.documentElement.style.getPropertyValue('--vn-theme-transition-x')
    }), 80));
  })()`);
  assert.notEqual(themeState.after, themeState.before, `${width}px theme should toggle`);
  assert.equal(themeState.transitionStyle, true, `${width}px theme transition style should be installed`);
  assert.ok(themeState.originX, `${width}px theme transition should record the button origin`);

  await pause(650);
  win.destroy();
  return { width, initial, equalScale: width <= 900, themeState, directory, avatarCrop, consoleErrors };
}

async function inspectBangumiCv() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  await win.loadURL(`${targetUrl}&api-check=${Date.now()}`);
  await pause(700);
  const result = await win.webContents.executeJavaScript(`searchBangumi('古河渚', '', 'character')`);
  const nagisa = result.find(item => item.title === '古河渚' || item.title === '古河 渚');
  assert.ok(nagisa, 'Bangumi should return 古河渚');
  assert.match(nagisa.cv, /中原麻衣/, 'Bangumi character result should include the associated CV');
  assert.match(nagisa.sub, /CV 中原麻衣/);
  win.destroy();
  return { title: nagisa.title, cv: nagisa.cv };
}

async function inspectCharacterSearchSources() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  await win.loadURL(`${targetUrl}&character-source-check=${Date.now()}`);
  await pause(700);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const originalFetch = window.fetch;
    const calls = [];
    window.fetch = (...args) => {
      calls.push(String(args[0] || ''));
      return originalFetch(...args);
    };
    try {
      openSearchModal('heroines', 'character');
      const chip = document.querySelector('.api-source-chip[data-api="vndb"]');
      const blockedResult = await searchVNDB('Sakura', '2020', 'character');
      return {
        blockedResult,
        vndbCalls: calls.filter(url => /api\\.vndb\\.org/i.test(url)).length,
        vndbChipHidden: Boolean(chip?.hidden),
        vndbEnabled: state.enabledApis.includes('vndb')
      };
    } finally {
      window.fetch = originalFetch;
    }
  })()`);
  assert.deepEqual(result.blockedResult, [], 'VNDB character search should be disabled');
  assert.equal(result.vndbCalls, 0, 'disabled VNDB character search should not make a network request');
  assert.equal(result.vndbChipHidden, true, 'VNDB source chip should be hidden in character search');
  win.destroy();
  return result;
}

async function inspectAccountTypePersistence() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  const url = `${baseUrl}/tools/GalgameTool/index.html?account-type-check=${Date.now()}`;
  await win.loadURL(url);
  await pause(500);
  await win.webContents.executeJavaScript(`(() => {
    const seed = JSON.stringify({ profile: { accountType: '' } });
    localStorage.setItem('bishoujo_resume_data:guest', seed);
    localStorage.setItem('bishoujo_resume_data', seed);
  })()`);
  await win.loadURL(url);
  await pause(700);
  const initial = await win.webContents.executeJavaScript(`({
    paper: document.querySelector('.account-platform-btn')?.title || '',
    toolbar: document.querySelector('#accountPlatformToggle')?.title || ''
  })`);
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#accountPlatformToggle')?.click();
    return new Promise(resolve => requestAnimationFrame(resolve));
  })()`);
  const switched = await win.webContents.executeJavaScript(`({
    paper: document.querySelector('.account-platform-btn')?.title || '',
    toolbar: document.querySelector('#accountPlatformToggle')?.title || '',
    stored: JSON.parse(localStorage.getItem('bishoujo_resume_data:guest') || '{}')?.profile?.accountType || ''
  })`);
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#accountPlatformToggle')?.click();
    return new Promise(resolve => requestAnimationFrame(resolve));
  })()`);
  const bilibili = await win.webContents.executeJavaScript(`({
    paper: document.querySelector('.account-platform-btn')?.title || '',
    toolbar: document.querySelector('#accountPlatformToggle')?.title || '',
    toolbarType: document.querySelector('#accountPlatformToggle')?.dataset.accountType || '',
    toolbarIcon: document.querySelector('#accountPlatformToggle .account-platform-icon-image')?.getAttribute('src') || '',
    paperIcon: document.querySelector('.account-platform-btn .account-platform-icon-image')?.getAttribute('src') || '',
    stored: JSON.parse(localStorage.getItem('bishoujo_resume_data:guest') || '{}')?.profile?.accountType || ''
  })`);
  await win.loadURL(url);
  await pause(700);
  const restored = await win.webContents.executeJavaScript(`({
    paper: document.querySelector('.account-platform-btn')?.title || '',
    toolbar: document.querySelector('#accountPlatformToggle')?.title || '',
    toolbarType: document.querySelector('#accountPlatformToggle')?.dataset.accountType || '',
    toolbarIcon: document.querySelector('#accountPlatformToggle .account-platform-icon-image')?.getAttribute('src') || ''
  })`);
  win.destroy();
  assert.match(initial.paper, /Bangumi/, 'missing platform value should default to Bangumi in the resume');
  assert.match(initial.toolbar, /Bangumi/, 'missing platform value should default to Bangumi in the toolbar');
  assert.match(switched.paper, /X \/ Twitter/, 'top-level platform button should update the resume button');
  assert.match(switched.toolbar, /X \/ Twitter/, 'toolbar platform button should switch to X/Twitter');
  assert.equal(switched.stored, 'x', 'toolbar platform switch should save the X/Twitter value');
  assert.match(bilibili.paper, /Bilibili/, 'platform button should switch to Bilibili');
  assert.match(bilibili.toolbar, /Bilibili/, 'toolbar platform button should switch to Bilibili');
  assert.equal(bilibili.toolbarType, 'bilibili', 'Bilibili platform value should be stored in the toolbar button');
  assert.match(bilibili.toolbarIcon, /bilibili-account\.svg/, 'toolbar Bilibili icon should use the supplied asset');
  assert.match(bilibili.paperIcon, /bilibili-account\.svg/, 'resume Bilibili icon should use the supplied asset');
  assert.equal(bilibili.stored, 'bilibili', 'Bilibili platform switch should save the Bilibili value');
  assert.match(restored.paper, /Bilibili/, 'Bilibili selection should survive a page reload in the resume');
  assert.match(restored.toolbar, /Bilibili/, 'Bilibili selection should survive a page reload in the toolbar');
  assert.equal(restored.toolbarType, 'bilibili', 'Bilibili type should survive a page reload');
  assert.match(restored.toolbarIcon, /bilibili-account\.svg/, 'Bilibili icon should survive a page reload');
  return { initial, switched, bilibili, restored };
}

async function inspectAttributeListSubmission() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  const url = `${baseUrl}/tools/GalgameTool/index.html?attribute-list-check=${Date.now()}`;
  await win.loadURL(url);
  await pause(400);
  await win.webContents.executeJavaScript(`(() => {
    localStorage.setItem('bishoujo_resume_data:guest', JSON.stringify({ profile: { attributes: [] } }));
  })()`);
  await win.loadURL(url);
  await pause(600);
  const result = await win.webContents.executeJavaScript(`(() => {
    const add = document.querySelector('[data-section-id="attributes"] .list-add');
    const value = '移动端测试属性';
    add.click();
    const input = document.querySelector('[data-section-id="attributes"] .list-text:last-of-type');
    input.textContent = value;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return {
      savedByEnter: state.profile.attributes.includes(value),
      renderedByEnter: [...document.querySelectorAll('[data-section-id="attributes"] .list-text')].some(item => item.textContent.includes(value)),
      newEmptyElement: state.profile.attributes.at(-1) === ''
    };
  })()`);
  win.destroy();
  assert.equal(result.savedByEnter, true, 'mobile attribute Enter should add one list element to state');
  assert.equal(result.renderedByEnter, true, 'added attribute should render as a list element');
  assert.equal(result.newEmptyElement, true, 'attribute Enter should create the next empty list element');
  return result;
}

async function inspectEditorAndExport() {
  const win = new BrowserWindow({
    show: false,
    width: 390,
    height: 844,
    webPreferences: {
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  const exportConsoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) exportConsoleErrors.push(message);
  });
  const svg = (color, width, height) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><rect width="100%" height="100%" fill="' + color + '"/></svg>'
  );
  const portrait = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640"><rect width="100%" height="150" fill="#ef4444"/><rect y="150" width="100%" height="490" fill="#2563eb"/></svg>'
  );
  const sample = {
    mode: 'resume',
    profile: {
      name: '导出检查', handle: '', accountType: '', avatar: '', avatarShape: 'square',
      avatarPosX: 50, avatarPosY: 50, genres: ['剧情作'],
      brands: ['Key、社'],
      works: [{ title: 'API 横向封面', image: svg('#d8b4fe', 640, 360), source: 'bangumi', id: 'fixture-work' }],
      heroines: [{ title: '测试角色', cv: '测试 CV', image: portrait, source: 'bangumi', id: 'fixture-character' }],
      historyYears: '5', playCount: '12',
      voiceActors: ['中原麻衣'], artists: ['樋上いたる'], writers: ['麻枝准'],
      songs: ['鸟之诗'], attributes: ['治愈', ''],
      other: Array.from({ length: 90 }, (_, index) => `移动端导出边界回归测试第 ${index + 1} 行：检查长履历分割后的页面边缘。`).join('\n')
    }
  };
  await win.loadURL(`${baseUrl}/tools/GalgameTool/index.html?export-seed=${Date.now()}`);
  await pause(700);
  await win.webContents.executeJavaScript(`(() => {
    const seed = ${JSON.stringify(JSON.stringify(sample))};
    localStorage.setItem('bishoujo_resume_data', seed);
    localStorage.setItem('bishoujo_resume_data:guest', seed);
  })()`);
  await win.loadURL(`${baseUrl}/tools/GalgameTool/index.html?export-check=${Date.now()}`);
  await pause(700);

  const probe = await win.webContents.executeJavaScript(`(async () => {
    const platformButton = document.querySelector('.account-platform-btn');
    const platformInitial = platformButton.title;
    platformButton.click();
    await new Promise(resolve => requestAnimationFrame(resolve));
    const platformAfterToggle = document.querySelector('.account-platform-btn').title;
    const storedPlatformAfterToggle = JSON.parse(localStorage.getItem('bishoujo_resume_data:guest') || '{}')?.profile?.accountType || '';
    const first = document.querySelector('.list-text[data-list-field="brands"]');
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const listAfterEnter = [...document.querySelectorAll('.list-text[data-list-field="brands"]')].map(el => ({
      text: el.textContent,
      whiteSpace: getComputedStyle(el).whiteSpace,
      index: el.dataset.listIndex
    }));
    const genreAdd = document.querySelector('.resume-section[data-section-id="genres"] .multiselect-add');
    genreAdd.click();
    const customGenreInput = document.getElementById('multiselect-custom-genres');
    customGenreInput.value = '悬疑 解谜';
    customGenreInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const genrePills = [...document.querySelectorAll('.resume-section[data-section-id="genres"] .multiselect-pill')]
      .map(el => [...el.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim());
    const savedGuestGenres = JSON.parse(localStorage.getItem('bishoujo_resume_data:guest') || '{}')?.profile?.genres || [];
    const themeBeforeGenreProbe = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', 'dark');
    const darkGenreStyle = (() => {
      const dropdown = document.querySelector('.multiselect-dropdown.active');
      const option = dropdown?.querySelector('.multiselect-option');
      const input = document.getElementById('multiselect-custom-genres');
      return {
        dropdownBackground: getComputedStyle(dropdown).backgroundColor,
        dropdownColor: getComputedStyle(dropdown).color,
        optionColor: getComputedStyle(option).color,
        inputBackground: getComputedStyle(input).backgroundColor,
        inputColor: getComputedStyle(input).color
      };
    })();
    document.documentElement.setAttribute('data-theme', themeBeforeGenreProbe || 'light');
    const tagButtonText = document.querySelector('.multiselect-add')?.textContent.trim() || '';

    let hiddenProbe = null;
    const originalHtml2Canvas = window.html2canvas;
    let renderProbe = null;
    window.html2canvas = async (...args) => {
      hiddenProbe = [...args[0].querySelectorAll('.tag-input, .tag-remove, .list-add, .thumb-add, .list-item[data-empty-list-item]')]
        .map(el => ({ className: el.className, display: getComputedStyle(el).display }));
      const canvas = await originalHtml2Canvas(...args);
      const sample = (selector, fx, fy) => {
        const element = args[0].querySelector(selector);
        const rect = element?.getBoundingClientRect();
        if (!rect || !canvas.width || !canvas.height) return null;
        const x = Math.max(0, Math.min(canvas.width - 1, Math.round((rect.left - args[0].getBoundingClientRect().left + rect.width * fx) * canvas.width / args[0].getBoundingClientRect().width)));
        const y = Math.max(0, Math.min(canvas.height - 1, Math.round((rect.top - args[0].getBoundingClientRect().top + rect.height * fy) * canvas.height / args[0].getBoundingClientRect().height)));
        return Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data).slice(0, 3);
      };
      renderProbe = {
        worksTop: sample('.works-grid .thumb-image-frame', 0.5, 0.04),
        worksCenter: sample('.works-grid .thumb-image-frame', 0.5, 0.5),
        heroineTop: sample('.heroine-grid .thumb-image-frame', 0.5, 0.08),
        heroineObjectFit: getComputedStyle(args[0].querySelector('.heroine-grid .thumb-image-frame img')).objectFit,
        heroineObjectPosition: getComputedStyle(args[0].querySelector('.heroine-grid .thumb-image-frame img')).objectPosition,
        workImageSrc: args[0].querySelector('.works-grid .thumb-image-frame img')?.src || '',
        captureRect: (() => { const r = args[0].getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
        captureOffset: [args[0].offsetWidth, args[0].offsetHeight]
      };
      return canvas;
    };
    await exportImage();
    const edgeDarkPixels = canvas => {
      const context = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;
      const edge = 3;
      const data = context.getImageData(0, 0, width, height).data;
      let count = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (x >= edge && x < width - edge && y >= edge && y < height - edge) continue;
          const offset = (y * width + x) * 4;
          if (data[offset + 3] > 0 && data[offset] < 48 && data[offset + 1] < 48 && data[offset + 2] < 48) count += 1;
        }
      }
      return count;
    };
    const exportEdges = (typeof exportDisplayParts === 'undefined' ? [] : exportDisplayParts).map(part => ({
      width: part.width,
      height: part.height,
      edgeDarkPixels: edgeDarkPixels(part)
    }));
    const beforeExportLayout = {
      innerWidth,
      mobile: Boolean(window.matchMedia?.('(max-width: 900px)').matches),
      transform: getComputedStyle(document.getElementById('resumePaper')).transform,
      paperRect: (() => { const r = document.getElementById('resumePaper').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()
    };
    const exportState = {
      progressVisibleAfterExport: document.getElementById('exportProgress').classList.contains('is-active'),
      progressStyle: (() => {
        const progress = document.getElementById('exportProgress');
        const track = progress?.querySelector('.export-progress-track');
        const rect = progress?.getBoundingClientRect();
        const style = progress ? getComputedStyle(progress) : null;
        return {
          position: style?.position,
          width: Math.round(rect?.width || 0),
          bottom: style?.bottom,
          trackHeight: track ? getComputedStyle(track).height : null,
          trackBackground: track ? getComputedStyle(track).backgroundImage : null,
          visibleFixed: [...document.querySelectorAll('*')]
            .filter(el => getComputedStyle(el).position === 'fixed' && getComputedStyle(el).visibility !== 'hidden')
            .map(el => ({
              id: el.id,
              className: String(el.className || ''),
              rect: (() => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })(),
              background: getComputedStyle(el).backgroundColor
            }))
        };
      })(),
      exportModalActive: document.getElementById('exportModal').classList.contains('active'),
      hiddenProbe,
      renderProbe,
      heroineLabelLayout: [...document.querySelectorAll('.heroine-grid .heroine-thumb-label')].map(label => ({
        height: label.offsetHeight,
        scrollHeight: label.scrollHeight,
        overflow: getComputedStyle(label).overflow,
        maxHeight: getComputedStyle(label).maxHeight,
        minHeight: getComputedStyle(label).minHeight,
        display: getComputedStyle(label).display,
        parentClass: label.parentElement?.className || ''
      })),
      exportEdges,
      beforeExportLayout,
      worksFrameRatio: (() => {
        const frame = document.querySelector('.works-grid .thumb-image-frame');
        const rect = frame?.getBoundingClientRect();
        return rect ? Number((rect.width / rect.height).toFixed(3)) : null;
      })(),
      imageFit: {
        works: getComputedStyle(document.querySelector('.works-grid .thumb-image-frame img')).objectFit,
        heroines: getComputedStyle(document.querySelector('.heroine-grid .thumb-image-frame img')).objectFit,
        heroineObjectPosition: getComputedStyle(document.querySelector('.heroine-grid .thumb-image-frame img')).objectPosition
      },
      proxiedApiImages: {
        vndb: getImageProxyUrl('https://t.vndb.org/cv/95/75895.jpg'),
        bangumi: getImageProxyUrl('https://lain.bgm.tv/r/400/pic/crt/l/e9/cf/4_crt_ZeUZW.jpg')
      },
      continuationCapProbe: (() => {
        const source = document.createElement('canvas');
        source.width = 1600; source.height = 300;
        const page = buildStandaloneExportPart(source, 1, 2, { frameLeft: 80, frameRight: 1520, lineWidth: 3 });
        const ctx = page.getContext('2d');
        return { outside: ctx.getImageData(20, 48, 1, 1).data[0], inside: ctx.getImageData(100, 48, 1, 1).data[0] };
      })()
    };
    return { platformInitial, platformAfterToggle, storedPlatformAfterToggle, listAfterEnter, genrePills, savedGuestGenres, darkGenreStyle, tagButtonText, exportState };
  })()`);

  if (!probe.exportState.exportModalActive) {
    console.error('Export diagnostic:', JSON.stringify({ toast: probe.exportState, consoleErrors: exportConsoleErrors }));
  }

  if (shouldCapture) {
    await pause(120);
    win.show();
    await pause(220);
    const screenshot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(screenshotDir, 'export-modal.png'), screenshot.toPNG());
    win.hide();
  }

  assert.match(probe.platformInitial, /Bangumi/, 'domestic/default platform should be Bangumi');
  assert.match(probe.platformAfterToggle, /X \/ Twitter/, 'platform button should switch to X/Twitter');
  assert.equal(probe.storedPlatformAfterToggle, 'x', 'platform switch should be persisted in local storage');
  assert.equal(probe.listAfterEnter.length, 2, 'Enter should create a new list information element');
  assert.equal(probe.listAfterEnter[0].text, 'Key、社', 'enumeration punctuation should stay within one list element');
  assert.equal(probe.listAfterEnter[1].text, '', 'new list element should start empty');
  assert.equal(probe.listAfterEnter[0].whiteSpace, 'nowrap', 'list information elements should stay on one line');
  assert.ok(probe.genrePills.includes('悬疑 解谜'), 'custom genre should be added as one type even when its name contains a space');
  assert.ok(probe.savedGuestGenres.includes('悬疑 解谜'), 'custom genre should persist in the local resume data');
  assert.notEqual(probe.darkGenreStyle.dropdownBackground, 'rgb(255, 255, 255)', 'genre dropdown should adapt its background in dark mode');
  assert.notEqual(probe.darkGenreStyle.dropdownColor, 'rgb(0, 0, 0)', 'genre dropdown should adapt its text color in dark mode');
  assert.notEqual(probe.darkGenreStyle.optionColor, 'rgb(0, 0, 0)', 'genre options should adapt their text color in dark mode');
  assert.notEqual(probe.darkGenreStyle.inputBackground, 'rgb(255, 255, 255)', 'custom genre input should adapt its background in dark mode');
  assert.notEqual(probe.darkGenreStyle.inputColor, 'rgb(0, 0, 0)', 'custom genre input should adapt its text color in dark mode');
  assert.match(probe.tagButtonText, /标签/, 'multiselect add control should use Chinese text');
  assert.equal(probe.exportState.exportModalActive, true, 'export should open the save preview modal');
  assert.ok(probe.exportState.heroineLabelLayout.length > 0, 'export fixture should include a heroine CV label');
  assert.ok(probe.exportState.heroineLabelLayout.every(label => label.height >= label.scrollHeight && label.maxHeight === 'none'), `heroine name and CV labels should not clip during export: ${JSON.stringify(probe.exportState.heroineLabelLayout)}`);
  assert.ok(probe.exportState.exportEdges.length >= 2, 'mobile long resume should split into multiple export images');
  assert.ok(probe.exportState.exportEdges.every(edge => edge.width === 1600), `mobile export should use the natural paper width instead of the fitted width: ${JSON.stringify(probe.exportState.exportEdges)}`);
  assert.ok(probe.exportState.exportEdges.every(edge => edge.edgeDarkPixels === 0), 'mobile export images should not have dark pixels on the outer edge');
  assert.equal(probe.exportState.progressVisibleAfterExport, true, 'progress should remain visible briefly after export completes');
  assert.equal(probe.exportState.progressStyle.position, 'fixed', 'export progress should float outside the resume paper');
  assert.ok(parseFloat(probe.exportState.progressStyle.bottom) >= 70, 'export progress should stay above the mobile export footer');
  assert.match(probe.exportState.progressStyle.trackHeight, /8px/, 'export progress should use a thicker visual track');
  assert.match(probe.exportState.progressStyle.trackBackground, /repeating-linear-gradient/, 'export progress should show stage markers');
    assert.ok(probe.exportState.hiddenProbe.some(item => item.className.includes('list-item')), 'empty list items should be marked for export hiding');
    assert.ok(probe.exportState.hiddenProbe.every(item => item.display === 'none'), 'editor-only add controls and empty list items should be hidden during export');
  assert.equal(probe.exportState.renderProbe.captureRect[0], 800, 'mobile export should capture the natural paper width');
  assert.equal(probe.exportState.renderProbe.captureOffset[0], 800, 'mobile export should keep the natural paper layout width');
  assert.deepEqual(probe.exportState.renderProbe.worksTop, [245, 245, 245], 'exported work image should preserve the frame whitespace above a contained image');
  assert.deepEqual(probe.exportState.renderProbe.worksCenter, [216, 180, 254], 'exported work image should render its image inside the fixed frame');
  assert.deepEqual(probe.exportState.renderProbe.heroineTop, [239, 68, 68], 'exported heroine image should render from the top of the filled portrait frame');
  assert.ok(probe.exportState.renderProbe.workImageSrc.startsWith('data:'), 'export should embed work images before rasterizing the paper');
  assert.ok(Math.abs(probe.exportState.worksFrameRatio - 268 / 221) < 0.02, 'API work image should use the fixed layout frame');
  assert.equal(probe.exportState.imageFit.works, 'contain', 'work images should use contain with whitespace fill');
  assert.equal(probe.exportState.imageFit.heroines, 'cover', 'heroine images should fill and crop their portrait frame');
  assert.match(probe.exportState.imageFit.heroineObjectPosition, /(?:^|\s)0(?:%|px)?(?:$|\s)/, 'heroine images should crop from the top of the portrait');
  assert.match(probe.exportState.proxiedApiImages.vndb, /\/api\/image_proxy\.php\?url=/, 'VNDB images should use the same-origin image proxy');
  assert.match(probe.exportState.proxiedApiImages.bangumi, /\/api\/image_proxy\.php\?url=/, 'Bangumi images should use the same-origin image proxy');
  assert.equal(probe.exportState.continuationCapProbe.outside, 255, 'continuation cap should not extend outside the resume frame');
  assert.equal(probe.exportState.continuationCapProbe.inside, 26, 'continuation cap should be drawn inside the resume frame');
  win.destroy();
  return probe.exportState;
}

async function inspectLegacyRedirect() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  const query = `legacy-check=${Date.now()}`;
  await win.loadURL(`${baseUrl}/vn-resume/bishoujo-resume/index.html?${query}#main`);
  await pause(250);
  const finalUrl = win.webContents.getURL();
  assert.match(finalUrl, new RegExp(`/tools/GalgameTool/index\\.html\\?${query}#main$`), 'legacy resume URL should preserve query and hash');
  win.destroy();
  return finalUrl;
}

async function inspectMemeRepeatedRanking() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  const storageKey = 'vnfest_galgame_meme_data:guest';
  const previous = await (async () => {
    await win.loadURL(`${targetUrl}&meme-repeat-prepare=${Date.now()}`);
    await pause(700);
    return win.webContents.executeJavaScript(`localStorage.getItem(${JSON.stringify(storageKey)})`);
  })();
  const seedCard = {
    id: 'seed-card',
    kind: 'work',
    source: 'bangumi',
    sourceId: 'bgm_vn_42',
    bangumiId: 42,
    title: '重复作品',
    subtitle: '',
    image: ''
  };
  const seed = {
    schema_version: 1,
    board: {
      title: 'MEME regression',
      colsMode: 'fixed',
      cols: 6,
      rows: 4,
      cells: Array.from({ length: 24 }, (_, index) => ({
        id: `cell-${index + 1}`,
        title: `分类 ${index + 1}`,
        cards: index === 0 ? [seedCard] : []
      })),
      unranked: []
    },
    settings: { cardSize: 'md', showTitles: true, showPopup: true }
  };

  try {
    await win.webContents.executeJavaScript(`(() => {
      localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(JSON.stringify(seed))});
      location.reload();
      return true;
    })()`);
    await pause(1000);
    const result = await win.webContents.executeJavaScript(`(async () => {
      switchToolView('meme', false);
      await new Promise(resolve => requestAnimationFrame(resolve));
      const originalFetch = window.fetch;
      window.fetch = (input, init) => {
        if (String(input || '').includes('/api/bangumi_proxy.php')) {
          return Promise.resolve(new Response(JSON.stringify({
            success: true,
            data: [{ id: 42, title_cn: '重复作品', title: 'Repeat Work', image_url: '' }]
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return originalFetch(input, init);
      };
      try {
        const cellAdd = document.querySelector('.meme-cell[data-cell-id="cell-2"] .meme-cell-add');
        cellAdd.click();
        const source = document.getElementById('memeSearchSource');
        source.value = 'bangumi';
        source.dispatchEvent(new Event('change', { bubbles: true }));
        const input = document.getElementById('memeSearchInput');
        input.value = '重复作品';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 650));
        const add = document.querySelector('#memeSearchResults .meme-pool-result button');
        const before = {
          present: Boolean(add),
          disabled: Boolean(add?.disabled),
          cellCounts: [...document.querySelectorAll('.meme-cell')].slice(0, 2).map(cell => cell.querySelectorAll('.meme-card').length)
        };
        add?.click();
        await new Promise(resolve => setTimeout(resolve, 90));
        const firstTwo = [...document.querySelectorAll('.meme-cell')].slice(0, 2);
        return {
          before,
          afterCellCounts: firstTwo.map(cell => cell.querySelectorAll('.meme-card').length),
          afterCardIds: firstTwo.map(cell => cell.querySelector('.meme-card')?.dataset.cardId || '')
        };
      } finally {
        window.fetch = originalFetch;
      }
    })()`);
    assert.equal(result.before.present, true, 'MEME repeated-ranking search should return the seeded work');
    assert.equal(result.before.disabled, false, 'a work already ranked in another cell should remain addable');
    assert.deepEqual(result.before.cellCounts, [1, 0], 'regression fixture should start with one ranked card');
    assert.deepEqual(result.afterCellCounts, [1, 1], 'the same work should be addable to a second category cell');
    assert.notEqual(result.afterCardIds[0], result.afterCardIds[1], 'repeated placements should have independent card IDs');
    return result;
  } finally {
    await win.webContents.executeJavaScript(`(() => {
      const previous = ${JSON.stringify(previous)};
      if (previous === null) localStorage.removeItem(${JSON.stringify(storageKey)});
      else localStorage.setItem(${JSON.stringify(storageKey)}, previous);
      return true;
    })()`).catch(() => {});
    win.destroy();
  }
}

app.whenReady().then(async () => {
  try {
    if (process.env.GALGAME_TOOL_MEME_ONLY === '1') {
      const memeRepeatedRanking = await inspectMemeRepeatedRanking();
      console.log(JSON.stringify({ memeRepeatedRanking }, null, 2));
      return;
    }
    const viewports = [];
    for (const [width, height] of [[390, 844], [360, 780], [1366, 900]]) {
      viewports.push(await inspectViewport(width, height));
    }
    const bangumi = await inspectBangumiCv();
    const characterSearchSources = await inspectCharacterSearchSources();
    const accountType = await inspectAccountTypePersistence();
    const attributeList = await inspectAttributeListSubmission();
    const editorAndExport = await inspectEditorAndExport();
    const memeRepeatedRanking = await inspectMemeRepeatedRanking();
    const legacyRedirect = await inspectLegacyRedirect();
    console.log(JSON.stringify({ viewports, bangumi, characterSearchSources, accountType, attributeList, editorAndExport, memeRepeatedRanking, legacyRedirect }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    await app.quit();
  }
});
