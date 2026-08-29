const { app, BrowserWindow } = require('electron');

const baseUrl = process.env.ANNOUNCEMENT_BASE_URL || 'http://127.0.0.1:8097';
const viewports = {
  desktop: { width: 1366, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};
const selected = process.argv.includes('--all-viewports')
  ? Object.keys(viewports)
  : [process.env.ANNOUNCEMENT_VIEWPORT || 'desktop'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.on('window-all-closed', (event) => event.preventDefault());

async function testViewport(name) {
  const win = new BrowserWindow({
    show: false,
    width: viewports[name].width,
    height: viewports[name].height,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) consoleErrors.push(message);
  });

  let loadError = null;
  try {
    await win.loadURL(`${baseUrl}/index.html?guest=1&announcement-test=1`);
    await sleep(1200);
  } catch (error) {
    loadError = error.message;
  }

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const bannerBody = document.getElementById('announcementBannerBody');
      const longContent = '公告正文测试 '.repeat(1000);
      const item = document.createElement('div');
      item.className = 'announcement-item announcement-type-info';
      item.dataset.id = '987654';
      item.dataset.title = '长正文公告';
      item.dataset.content = longContent;
      item.dataset.time = '2026-08-14 12:00:00';
      item.innerHTML = '<span class="announcement-item-title">长正文公告</span>';
      bannerBody.appendChild(item);
      item.click();
      const center = document.getElementById('notifCenterOverlay');
      const classSamples = [center ? center.className : ''];
      await new Promise((resolve) => requestAnimationFrame(resolve));
      classSamples.push(center ? center.className : '');
      await new Promise((resolve) => setTimeout(resolve, 250));
      classSamples.push(center ? center.className : '');
      const detailBody = document.querySelector('#notifCenterDetail .nd-body');
      return {
        centerOpen: Boolean(center && center.classList.contains('open')),
        centerVisible: Boolean(center && getComputedStyle(center).display !== 'none'),
        centerClassName: center ? center.className : '',
        centerInlineDisplay: center ? center.style.display : '',
        classSamples,
        intermediatePopupCount: document.querySelectorAll('.notif-detail-overlay').length,
        detailTextLength: detailBody ? detailBody.textContent.length : 0,
        hasLongContent: Boolean(detailBody && detailBody.textContent.includes('公告正文测试')),
        hasCenterEntryPoint: typeof window.openVnfNotificationCenter === 'function',
      };
    })();
  `);

  win.destroy();
  return { viewport: name, loadError, consoleErrors, ...result };
}

app.whenReady().then(async () => {
  const results = [];
  for (const viewport of selected) results.push(await testViewport(viewport));
  await app.quit();

  let failed = false;
  for (const result of results) {
    const pass = !result.loadError && result.centerOpen && result.centerVisible &&
      result.intermediatePopupCount === 0 && result.hasCenterEntryPoint && result.hasLongContent;
    if (!pass) failed = true;
    console.log(`${pass ? 'OK' : 'FAIL'} ${result.viewport} center=${result.centerOpen} visible=${result.centerVisible} class=${result.centerClassName} samples=${result.classSamples.join('>')} display=${result.centerInlineDisplay} intermediate=${result.intermediatePopupCount} content=${result.detailTextLength}`);
    if (result.loadError) console.error(`  load error: ${result.loadError}`);
    if (result.consoleErrors.length) console.error(`  console errors: ${result.consoleErrors.join(' | ')}`);
  }
  process.exitCode = failed ? 1 : 0;
});
