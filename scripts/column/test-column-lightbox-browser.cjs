const assert = require('assert');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const baseUrl = process.env.COLUMN_BROWSER_BASE_URL || 'http://127.0.0.1:8098';

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function inspect(win) {
  await win.webContents.executeJavaScript("document.querySelector('.pt-dm-imgs img').click()");
  await wait(120);
  return win.webContents.executeJavaScript(`(() => {
    const lightbox = document.querySelector('.pt-lightbox');
    const image = lightbox && lightbox.querySelector('img');
    const header = document.querySelector('.pt-thread-header');
    const input = document.querySelector('.pt-thread-input');
    const lightboxRect = lightbox?.getBoundingClientRect();
    const imageRect = image?.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    const inputRect = input?.getBoundingClientRect();
    const probe = document.elementFromPoint(6, Math.min(window.innerHeight - 1, Math.max(1, (headerRect?.top || 0) + 10)));
    const computed = lightbox ? getComputedStyle(lightbox) : null;
    return {
      hasLightbox: Boolean(lightbox),
      parent: lightbox?.parentElement?.tagName || '',
      position: computed?.position || '',
      zIndex: computed?.zIndex || '',
      lightboxRect: lightboxRect && { left: lightboxRect.left, top: lightboxRect.top, width: lightboxRect.width, height: lightboxRect.height },
      imageRect: imageRect && { left: imageRect.left, top: imageRect.top, width: imageRect.width, height: imageRect.height },
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
        windowWidth: window.innerWidth,
      },
      headerRect: headerRect && { top: headerRect.top, bottom: headerRect.bottom },
      inputRect: inputRect && { top: inputRect.top, bottom: inputRect.bottom },
      probeInsideLightbox: Boolean(probe && probe.closest('.pt-lightbox')),
      bodyChildren: document.body.children.length,
    };
  })()`);
}

// Regression: ISSUE-001 — DM lightbox was trapped below sticky thread chrome.
// Found by /qa on 2026-09-13
// Report: .gstack/qa-reports/qa-report-column-2026-09-13.md
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: process.env.COLUMN_LIGHTBOX_SHOW === '1', webPreferences: { contextIsolation: true, sandbox: true } });
  try {
    win.setSize(768, 900);
    await win.loadURL(`${baseUrl}/column/messages/1/?qa=messages-lightbox`);
    await wait(900);
    const initial = await win.webContents.executeJavaScript(`(() => ({
      body: document.body?.innerText || '',
      imageCount: document.querySelectorAll('.pt-dm-imgs img').length,
      input: Boolean(document.querySelector('.pt-thread-input')),
    }))()`);
    assert.match(initial.body, /请查看这张图/);
    assert.equal(initial.imageCount, 1);
    assert.equal(initial.input, true);

    const result = await inspect(win);
    assert.equal(result.hasLightbox, true, 'clicking a DM image should open the lightbox');
    const details = JSON.stringify(result);
    assert.equal(result.parent, 'BODY', `the lightbox must escape the thread stacking context: ${details}`);
    assert.equal(result.position, 'fixed');
    assert.ok(Number(result.zIndex) >= 1000, `lightbox z-index should be in the app overlay layer: ${result.zIndex}`);
    assert.ok(Math.abs(result.lightboxRect.left) <= 1 && Math.abs(result.lightboxRect.top) <= 1);
    assert.ok(Math.abs(result.lightboxRect.width - result.viewport.width) <= 1, details);
    assert.ok(Math.abs(result.lightboxRect.height - result.viewport.height) <= 1, details);
    assert.ok(Math.abs((result.imageRect.left + result.imageRect.width / 2) - result.viewport.width / 2) <= 1, 'image should be horizontally centered');
    assert.ok(Math.abs((result.imageRect.top + result.imageRect.height / 2) - result.viewport.height / 2) <= 1, 'image should be vertically centered');
    assert.ok(result.imageRect.width <= result.viewport.windowWidth * 0.82 + 1, 'image should use the reduced max width');
    assert.ok(result.imageRect.height <= result.viewport.height * 0.72 + 1, 'image should use the reduced max height');
    assert.equal(result.probeInsideLightbox, true, 'overlay should cover the sticky header area');
    if (process.env.COLUMN_LIGHTBOX_SCREENSHOT) {
      await wait(500);
      const screenshot = await win.webContents.capturePage();
      fs.writeFileSync(process.env.COLUMN_LIGHTBOX_SCREENSHOT, screenshot.toPNG());
    }
    process.stdout.write(`ok DM lightbox ${JSON.stringify(result)}\n`);
    await win.close();
    app.quit();
  } catch (error) {
    console.error(error.stack || error.message);
    await win.close();
    app.exit(1);
  }
});
