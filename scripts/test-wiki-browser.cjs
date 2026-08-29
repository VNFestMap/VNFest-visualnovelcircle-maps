const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const externalBaseUrl = String(process.env.WIKI_BASE_URL || '').replace(/\/$/, '');
const articlePath = String(process.env.WIKI_BROWSER_ARTICLE || '/wiki/pages/china-210.html');
const articleRequiresImage = process.env.WIKI_BROWSER_REQUIRE_IMAGE !== '0';
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'compact', width: 1200, height: 800 },
  { name: 'compact-edge', width: 1121, height: 800 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'mobile', width: 390, height: 844 },
];
const mime = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function createStaticServer() {
  return http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname.startsWith('/api/')) {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end('{"success":false,"message":"browser contract stub"}');
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vnfest-wiki-chrome-'));
  const child = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--ignore-certificate-errors', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const websocketUrl = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Chrome DevTools endpoint did not start. ${output}`)), 10000);
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { if (code) { clearTimeout(timer); reject(new Error(`Chrome exited with code ${code}. ${output}`)); } });
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
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result || {});
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

async function waitFor(cdp, sessionId, expression, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, sessionId, `Boolean(${expression})`)) return;
    } catch (error) {
      if (!/Inspected target navigated or closed/.test(error.message || '')) throw error;
    }
    await sleep(80);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function navigate(cdp, sessionId, url, readyExpression, label) {
  await cdp.send('Page.navigate', { url }, sessionId);
  await waitFor(cdp, sessionId, `document.readyState === 'complete' && (${readyExpression})`, label);
  await sleep(250);
}

async function inspectArticle(cdp, sessionId, baseUrl, viewport) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.name === 'mobile',
  }, sessionId);
  await navigate(cdp, sessionId, `${baseUrl}${articlePath.startsWith('/') ? articlePath : `/${articlePath}`}`, "document.querySelector('.wiki-article[data-wiki-lang=\"zh\"]:not([hidden])')", 'wiki article');
  const result = await evaluate(cdp, sessionId, `(() => {
    const article = document.querySelector('.wiki-article[data-wiki-lang="zh"]:not([hidden])');
    const nav = article?.querySelector('.wiki-article-nav');
    const main = article?.querySelector('.wiki-article-main');
    const railShell = article?.querySelector('.wiki-article-rail');
    const rail = article?.querySelector('.wiki-appearance-rail');
    const toc = article?.querySelector('.wiki-toc');
    const launcher = document.querySelector('[data-appearance-launcher]');
    const image = article?.querySelector('.wiki-image-card img');
    const facts = article?.querySelector('.wiki-entry-facts');
    const summary = article?.querySelector('.wiki-summary');
    const footer = article?.querySelector('.wiki-footer');
    const rect = (node) => node ? { left: node.getBoundingClientRect().left, top: node.getBoundingClientRect().top, right: node.getBoundingClientRect().right, bottom: node.getBoundingClientRect().bottom, width: node.getBoundingClientRect().width } : null;
    const factsBottom = facts ? facts.getBoundingClientRect().bottom : 0;
    const sectionHeadings = Array.from(article?.querySelectorAll('.wiki-section > h2, .wiki-section > h3') || []).map(rect);
    const mediaBlocks = Array.from(article?.querySelectorAll('.wiki-article-main > .wiki-image-gallery, .wiki-section > .wiki-inline-image-gallery') || []).map(rect);
    const sectionBarWidth = article?.querySelector('.wiki-section') ? getComputedStyle(article.querySelector('.wiki-section')).borderLeftWidth : '';
    return {
      nav: rect(nav), main: rect(main), railShell: rect(railShell), rail: rect(rail), image: rect(image), facts: rect(facts), summary: rect(summary), footer: rect(footer),
      factsBottom, sectionHeadings, mediaBlocks, sectionBarWidth,
      factsInMain: facts ? facts.closest('.wiki-article-main') === main : false,
      factsInRail: facts ? Boolean(facts.closest('.wiki-article-rail')) : false,
      articleCount: document.querySelectorAll('.wiki-article').length,
      visibleArticles: Array.from(document.querySelectorAll('.wiki-article')).filter((node) => !node.hidden).length,
      visibleJapanese: document.querySelector('.wiki-article[data-wiki-lang="ja"]:not([hidden])') !== null,
      navPosition: nav ? getComputedStyle(nav).position : '',
      tocOverflowY: toc ? getComputedStyle(toc).overflowY : '',
      tocMaxHeight: toc ? getComputedStyle(toc).maxHeight : '',
      tocScrollHeight: toc?.scrollHeight || 0,
      tocClientHeight: toc?.clientHeight || 0,
      railPosition: rail ? getComputedStyle(rail).position : '',
      factsFloat: facts ? getComputedStyle(facts).float : '',
      launcherPosition: launcher ? getComputedStyle(launcher).position : '',
      launcherInHeader: Boolean(launcher?.closest('.wiki-header')),
      tocLinks: article?.querySelectorAll('.wiki-toc a').length || 0,
      tocSubitems: article?.querySelectorAll('.wiki-toc-sublist .wiki-toc-level-3').length || 0,
      level3Sections: article?.querySelectorAll('[data-wiki-section] h3').length || 0,
      inlineImages: article?.querySelectorAll('.wiki-inline-image-gallery').length || 0,
      sectionIds: Array.from(article?.querySelectorAll('[data-wiki-section]') || []).map((node) => node.id),
      languageSwitch: document.querySelectorAll('.wiki-language-switch [data-wiki-language]').length,
      appearanceControls: article?.querySelectorAll('[data-appearance-key]').length || 0,
      articleLaunchers: article ? article.querySelectorAll(':scope > [data-appearance-launcher]').length : 0,
      headerLaunchers: document.querySelectorAll('.wiki-header [data-appearance-launcher]').length,
      overflow: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - document.documentElement.clientWidth,
      viewportWidth: document.documentElement.clientWidth,
    };
  })()`);
  const structuralBlocks = result ? [...result.sectionHeadings, ...result.mediaBlocks] : [];
  const intersectsFacts = (block) => block && result?.facts && block.top < result.facts.bottom - 1 && block.bottom > result.facts.top + 1;
  const structuralAvoidsFacts = result && structuralBlocks.filter(intersectsFacts).every((block) => block.right <= result.facts.left + 1);
  const structuralUsesFloatLane = result && result.factsFloat !== 'right'
    ? true
    : structuralBlocks.some((block) => block.top < result.facts.bottom - 1);
  const footerClearsFacts = result && result.footer && result.footer.top >= result.facts.bottom - 1;
  if (!result || result.articleCount !== 1 || result.visibleArticles !== 1 || result.visibleJapanese || result.tocLinks < 1 || result.tocSubitems !== result.level3Sections || (articleRequiresImage && !result.image) || !result.facts || !result.factsInMain || result.factsInRail || result.languageSwitch !== 2 || result.appearanceControls < 4 || result.articleLaunchers !== 0 || result.headerLaunchers !== 1 || result.launcherPosition !== 'static' || !result.launcherInHeader || result.tocOverflowY === 'auto' || result.tocOverflowY === 'scroll' || result.tocMaxHeight !== 'none' || result.overflow > 1 || result.sectionBarWidth !== '0px' || !structuralAvoidsFacts || !structuralUsesFloatLane || !footerClearsFacts) {
    throw new Error(`${viewport.name} article shell invalid: ${JSON.stringify(result)}`);
  }
  if (!result.sectionIds.every((id) => id.startsWith('zh-section-'))) {
    throw new Error(`language-prefixed section anchors invalid: ${JSON.stringify(result)}`);
  }
  if (viewport.name === 'desktop') {
    if (!(result.nav.left < result.main.left && result.main.left < result.rail.left) || result.navPosition !== 'sticky' || result.railPosition !== 'sticky' || result.factsFloat !== 'right') {
      throw new Error(`desktop article columns invalid: ${JSON.stringify(result)}`);
    }
  } else if (viewport.name === 'compact' || viewport.name === 'compact-edge') {
    if (!(result.nav.left < result.main.left) || Math.abs(result.railShell.left - result.main.left) > 1 || result.rail.top <= result.main.bottom - 1 || result.railPosition !== 'static' || result.factsFloat !== 'right') {
      throw new Error(`compact article columns invalid: ${JSON.stringify(result)}`);
    }
  } else if (viewport.name === 'tablet') {
    if (!(result.nav.left < result.main.left) || Math.abs(result.railShell.left - result.main.left) > 1 || result.rail.top <= result.main.bottom - 1 || result.railPosition !== 'static' || result.factsFloat !== 'none') {
      throw new Error(`tablet article columns invalid: ${JSON.stringify(result)}`);
    }
  } else {
    if (!(result.main.top < result.nav.top && result.nav.top < result.rail.top) || result.factsFloat !== 'none' || (articleRequiresImage && (!result.image || result.image.right > result.viewportWidth + 1))) {
      throw new Error(`mobile article order or image width invalid: ${JSON.stringify(result)}`);
    }
  }
  const interaction = await evaluate(cdp, sessionId, `(() => {
    const link = document.querySelector('.wiki-article[data-wiki-lang="zh"]:not([hidden]) [data-wiki-section-link]');
    link?.click();
    const large = document.querySelector('[data-appearance-key="font"][data-appearance-value="large"]');
    large?.click();
    const paper = document.querySelector('[data-appearance-key="theme"][data-appearance-value="paper"]');
    paper?.click();
    const styleOf = (node) => node ? getComputedStyle(node) : null;
    const bodyStyle = styleOf(document.body);
    const headerStyle = styleOf(document.querySelector('.wiki-header'));
    const tocStyle = styleOf(document.querySelector('.wiki-toc'));
    const factsStyle = styleOf(document.querySelector('.wiki-entry-facts'));
    const railStyle = styleOf(document.querySelector('.wiki-appearance-rail'));
    return {
      highlighted: document.querySelector('.wiki-article[data-wiki-lang="zh"]:not([hidden]) .wiki-section.is-jump-target') !== null,
      activeSection: document.querySelector('.wiki-article[data-wiki-lang="zh"]:not([hidden]) .wiki-toc a[aria-current="location"]') !== null,
      font: document.querySelector('.wiki-reading-page')?.dataset.wikiFont || '',
      stored: JSON.parse(localStorage.getItem('vnfestWikiAppearance') || '{}').font || '',
      theme: document.documentElement.dataset.wikiReaderTheme || '',
      bodyBackground: bodyStyle?.backgroundColor || '',
      headerBackground: headerStyle?.backgroundColor || '',
      tocBackground: tocStyle?.backgroundColor || '',
      factsBackground: factsStyle?.backgroundColor || '',
      railBackground: railStyle?.backgroundColor || '',
      wallpaperLayer: Boolean(document.getElementById('vnfestWallpaperLayer')),
    };
  })()`);
  if (!interaction.highlighted || !interaction.activeSection || interaction.font !== 'large' || interaction.stored !== 'large' || interaction.theme !== 'paper' || interaction.bodyBackground !== 'rgb(241, 238, 230)' || interaction.headerBackground !== 'rgb(251, 250, 245)' || interaction.tocBackground !== 'rgb(241, 238, 230)' || interaction.factsBackground !== 'rgb(251, 250, 245)' || interaction.railBackground !== 'rgb(251, 250, 245)' || interaction.wallpaperLayer) {
    throw new Error(`article interaction invalid: ${JSON.stringify(interaction)}`);
  }
  const appearanceInteraction = await evaluate(cdp, sessionId, `(() => {
    const article = document.querySelector('.wiki-article[data-wiki-lang="zh"]:not([hidden])');
    const rail = article?.querySelector('[data-wiki-appearance]');
    const launcher = document.querySelector('[data-appearance-launcher]');
    const hide = rail?.querySelector('[data-appearance-hide]');
    hide?.click();
    const hidden = { railHidden: rail?.classList.contains('is-hidden'), launcherVisible: launcher ? !launcher.hidden : false, articleClass: article?.classList.contains('wiki-appearance-hidden') };
    launcher?.click();
    const headerBottom = document.querySelector('.wiki-header')?.getBoundingClientRect().bottom || 0;
    const popupTop = rail?.getBoundingClientRect().top || 0;
    const opened = { popover: rail?.classList.contains('is-popover-open'), ariaHidden: rail?.getAttribute('aria-hidden'), dockVisible: rail?.querySelector('[data-appearance-dock]')?.hidden === false, popupBelowHeader: popupTop >= headerBottom - 2, popupPosition: rail ? getComputedStyle(rail).position : '' };
    rail?.querySelector('[data-appearance-dock]')?.click();
    const restored = { railHidden: rail?.classList.contains('is-hidden'), launcherHidden: launcher?.hidden, articleClass: article?.classList.contains('wiki-appearance-hidden'), overflow: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - document.documentElement.clientWidth };
    return { hidden, opened, restored };
  })()`);
  if (!appearanceInteraction.hidden.railHidden || !appearanceInteraction.hidden.launcherVisible || !appearanceInteraction.hidden.articleClass || !appearanceInteraction.opened.popover || appearanceInteraction.opened.ariaHidden !== 'false' || !appearanceInteraction.opened.dockVisible || !appearanceInteraction.opened.popupBelowHeader || appearanceInteraction.opened.popupPosition !== 'fixed' || appearanceInteraction.restored.railHidden || !appearanceInteraction.restored.launcherHidden || appearanceInteraction.restored.articleClass || appearanceInteraction.restored.overflow > 1) {
    throw new Error(`appearance rail hide/popover/restore invalid: ${JSON.stringify(appearanceInteraction)}`);
  }
  const stability = await evaluate(cdp, sessionId, `(async () => {
    const article = document.querySelector('.wiki-article[data-wiki-lang="zh"]:not([hidden])');
    const sections = Array.from(article?.querySelectorAll('[data-wiki-section]') || []);
    const order = new Map(sections.map((section, index) => [section.id, index]));
    const samples = [];
    window.scrollTo({ top: 0, behavior: 'auto' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    for (let top = 0; top <= Math.max(0, document.documentElement.scrollHeight - window.innerHeight); top += 24) {
      window.scrollTo({ top, behavior: 'auto' });
      await new Promise((resolve) => setTimeout(resolve, 18));
      const active = article.querySelector('[data-wiki-section-link][aria-current="location"]');
      if (active) samples.push(order.get(active.dataset.wikiSectionLink));
    }
    return { samples, backtracks: samples.reduce((count, value, index) => count + (index && value < samples[index - 1] ? 1 : 0), 0) };
  })()`);
  if (!stability || stability.backtracks !== 0) {
    throw new Error(`section highlight should not backtrack while scrolling down: ${JSON.stringify(stability)}`);
  }
  await navigate(cdp, sessionId, `${baseUrl}/wiki/pages/china-114-ja.html`, "document.querySelector('.wiki-article[data-wiki-lang=\"ja\"]:not([hidden])')", 'Japanese wiki article');
  const japanese = await evaluate(cdp, sessionId, `(() => ({
    articleCount: document.querySelectorAll('.wiki-article').length,
    visibleJapanese: document.querySelectorAll('.wiki-article[data-wiki-lang="ja"]:not([hidden])').length,
    visibleChinese: document.querySelectorAll('.wiki-article[data-wiki-lang="zh"]:not([hidden])').length,
    tocPrefix: Array.from(document.querySelectorAll('.wiki-article[data-wiki-lang="ja"]:not([hidden]) [data-wiki-section]')).every((node) => node.id.startsWith('ja-section-')),
    path: window.location.pathname,
  }))()`);
  if (japanese.articleCount !== 1 || japanese.visibleJapanese !== 1 || japanese.visibleChinese !== 0 || !japanese.tocPrefix || !japanese.path.endsWith('-ja.html')) {
    throw new Error(`Japanese language isolation invalid: ${JSON.stringify(japanese)}`);
  }
  await navigate(cdp, sessionId, `${baseUrl}/wiki/pages/china-114.html?lang=ja`, "location.pathname.endsWith('-ja.html') && document.querySelector('.wiki-article[data-wiki-lang=\"ja\"]')", 'legacy Japanese language URL redirect');
  console.log(`OK ${viewport.name} article ${viewport.width}x${viewport.height}`);
}

async function inspectEditor(cdp, sessionId, baseUrl, viewport) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.name === 'mobile' }, sessionId);
  await navigate(cdp, sessionId, `${baseUrl}/admin/wiki_editor.html?club_key=china-114`, "document.getElementById('toggleImportBtn')", 'wiki editor');

  const validJson = JSON.stringify({
    title: '块编辑器测试',
    summary: '用于验证正文内容块、预览 Tab 和 JSON 实时检查。',
    infobox: { 学校: '测试大学' },
    sections: [{
      heading: '正文测试',
      level: 2,
      blocks: [
        { type: 'paragraph', text: '第一段内容。', note: '这是编辑器脚注。' },
        { type: 'image', url: '../uploads/china-114/20260515024009_0d31e26a.png', alt: '正文示例图', caption: '正文图片说明', width_percent: 75, aspect_ratio: '16/10', align: 'center', fit: 'contain' },
      ],
    }],
    images: [],
    references: [],
  });
  const invalidResult = await evaluate(cdp, sessionId, `(() => {
    document.getElementById('toggleImportBtn').click();
    const input = document.getElementById('jsonToolsInput');
    input.value = '{\\n  "title": "坏 JSON",\\n}';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const output = document.getElementById('jsonValidation');
    return { invalid: output.classList.contains('is-invalid'), message: output.textContent };
  })()`);
  if (!invalidResult.invalid || !/第\s*\d+\s*行.*第\s*\d+\s*列/.test(invalidResult.message)) {
    throw new Error(`editor JSON error location invalid: ${JSON.stringify(invalidResult)}`);
  }

  const validResult = await evaluate(cdp, sessionId, `(() => {
    const input = document.getElementById('jsonToolsInput');
    input.value = ${JSON.stringify(validJson)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { valid: document.getElementById('jsonValidation').classList.contains('is-valid'), message: document.getElementById('jsonValidation').textContent };
  })()`);
  if (!validResult.valid) throw new Error(`editor valid JSON rejected: ${JSON.stringify(validResult)}`);

  await evaluate(cdp, sessionId, "document.getElementById('importJsonBtn').click()");
  await waitFor(cdp, sessionId, "document.querySelectorAll('#sectionRows .content-block').length === 2", 'imported content blocks');
  const initial = await evaluate(cdp, sessionId, `(() => ({
    blocks: document.querySelectorAll('#sectionRows .content-block').length,
    paragraph: document.querySelectorAll('#sectionRows [data-block-type="paragraph"]').length,
    image: document.querySelectorAll('#sectionRows [data-block-type="image"]').length,
  }))()`);
  if (initial.blocks !== 2 || initial.paragraph !== 1 || initial.image !== 1) throw new Error(`editor block import invalid: ${JSON.stringify(initial)}`);

  await evaluate(cdp, sessionId, "document.querySelector('[data-action=\"add-paragraph-block\"]').click(); document.querySelector('[data-action=\"add-image-block\"]').click();");
  const afterAdd = await evaluate(cdp, sessionId, "document.querySelectorAll('#sectionRows .content-block').length");
  if (afterAdd !== 4) throw new Error(`editor block add invalid: ${afterAdd}`);
  await evaluate(cdp, sessionId, "document.querySelector('#sectionRows .content-block [data-action=\"move-down\"]').click(); document.querySelectorAll('#sectionRows .content-block')[1].querySelector('[data-action=\"duplicate-row\"]').click();");
  const afterCopy = await evaluate(cdp, sessionId, "document.querySelectorAll('#sectionRows .content-block').length");
  if (afterCopy !== 5) throw new Error(`editor block copy/move invalid: ${afterCopy}`);
  await evaluate(cdp, sessionId, "document.querySelectorAll('#sectionRows .content-block')[1].querySelector('[data-action=\"remove\"]').click()");
  const afterDelete = await evaluate(cdp, sessionId, "document.querySelectorAll('#sectionRows .content-block').length");
  if (afterDelete !== 4) throw new Error(`editor block delete invalid: ${afterDelete}`);

  const preview = await evaluate(cdp, sessionId, `(() => ({
    hidden: document.getElementById('previewView').hidden,
    paragraph: document.querySelectorAll('#previewPane .wiki-section p').length,
    image: document.querySelectorAll('#previewPane .wiki-image-card').length,
    footnote: document.querySelectorAll('#previewPane .wiki-footnote-marker').length,
    readerArticle: document.querySelectorAll('#previewPane .wiki-article').length,
    editHidden: document.getElementById('editorView').hidden,
    markdownHidden: document.getElementById('markdownView').hidden,
    outlineCount: document.querySelectorAll('#editorOutline [data-editor-outline-index]').length,
    editorColumn: (() => { const node = document.querySelector('.editor-column'); const rect = node?.getBoundingClientRect(); return rect ? { left: rect.left, right: rect.right, width: rect.width } : null; })(),
    previewColumn: (() => { const node = document.getElementById('previewView'); const rect = node?.getBoundingClientRect(); return rect ? { left: rect.left, right: rect.right, width: rect.width } : null; })(),
    overflow: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - document.documentElement.clientWidth,
  }))()`);
  const splitValid = viewport.width < 1100
    ? preview.editorColumn?.left === preview.previewColumn?.left || preview.previewColumn?.top > 0
    : Boolean(preview.editorColumn && preview.previewColumn && preview.editorColumn.left < preview.previewColumn.left && preview.editorColumn.width > 0 && preview.previewColumn.width > 0);
  if (preview.hidden || preview.editHidden || !preview.markdownHidden || preview.paragraph < 1 || preview.image < 1 || preview.footnote < 1 || preview.readerArticle !== 1 || preview.outlineCount < 1 || !splitValid || preview.overflow > 1) {
    throw new Error(`editor split preview invalid: ${JSON.stringify(preview)}`);
  }

  await evaluate(cdp, sessionId, "document.getElementById('editorModeMarkdown').click()");
  const markdownState = await evaluate(cdp, sessionId, `(() => {
    const input = document.getElementById('markdownSourceInput');
    input.value = '## 概要\\n\\n第一段 **加粗**。\\n\\n### 细节\\n\\n第二段 [链接](https://example.com)。';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      visualHidden: document.getElementById('editorView').hidden,
      markdownVisible: !document.getElementById('markdownView').hidden,
      previewVisible: !document.getElementById('previewView').hidden,
      outlineCount: document.querySelectorAll('#editorOutline [data-editor-outline-index]').length,
      markdownStatus: document.getElementById('markdownStatus').textContent,
    };
  })()`);
  await sleep(80);
  const markdownPreview = await evaluate(cdp, sessionId, `({
    strong: document.querySelectorAll('#previewPane strong').length,
    links: document.querySelectorAll('#previewPane a[href="https://example.com"]').length,
    sections: document.querySelectorAll('#previewPane .wiki-section').length,
  })`);
  if (!markdownState.visualHidden || !markdownState.markdownVisible || !markdownState.previewVisible || markdownState.outlineCount !== 2 || markdownPreview.strong < 1 || markdownPreview.links < 1 || markdownPreview.sections < 2 || /无法应用/.test(markdownState.markdownStatus)) {
    throw new Error(`editor Markdown mode invalid: ${JSON.stringify({ markdownState, markdownPreview })}`);
  }

  const outlineScrollState = await evaluate(cdp, sessionId, `(() => {
    const input = document.getElementById('markdownSourceInput');
    const longSource = Array.from({ length: 40 }, (_, index) => '## 章节 ' + (index + 1) + '\\n\\n快速跳转测试段落。').join('\\n\\n');
    input.value = longSource;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const nav = document.querySelector('.editor-outline-nav');
    const style = nav ? getComputedStyle(nav) : null;
    return {
      count: document.querySelectorAll('#editorOutline [data-editor-outline-index]').length,
      overflowY: style?.overflowY || '',
      scrollHeight: nav?.scrollHeight || 0,
      clientHeight: nav?.clientHeight || 0,
    };
  })()`);
  if (viewport.width >= 1100 && (outlineScrollState.count !== 40 || !['auto', 'scroll'].includes(outlineScrollState.overflowY) || outlineScrollState.scrollHeight <= outlineScrollState.clientHeight)) {
    throw new Error(`editor outline scroll invalid: ${JSON.stringify(outlineScrollState)}`);
  }
  await evaluate(cdp, sessionId, `(() => {
    const input = document.getElementById('markdownSourceInput');
    input.value = '## 概要\\n\\n第一段 **加粗**。\\n\\n### 细节\\n\\n第二段 [链接](https://example.com)。';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  await evaluate(cdp, sessionId, "document.getElementById('editorModeVisual').click()");
  await waitFor(cdp, sessionId, "document.querySelectorAll('#sectionRows > .row-card').length === 2", 'Markdown sections converted to visual blocks');
  const visualRoundTrip = await evaluate(cdp, sessionId, `({
    visualVisible: !document.getElementById('editorView').hidden,
    markdownHidden: document.getElementById('markdownView').hidden,
    headings: Array.from(document.querySelectorAll('#sectionRows [data-field="heading"]')).map((node) => node.value),
    levels: Array.from(document.querySelectorAll('#sectionRows [data-field="level"]')).map((node) => node.value),
    previewVisible: !document.getElementById('previewView').hidden,
  })`);
  if (!visualRoundTrip.visualVisible || !visualRoundTrip.markdownHidden || visualRoundTrip.headings.join('|') !== '概要|细节' || visualRoundTrip.levels.join('|') !== '2|3' || !visualRoundTrip.previewVisible) {
    throw new Error(`editor Markdown round trip invalid: ${JSON.stringify(visualRoundTrip)}`);
  }
  await evaluate(cdp, sessionId, "document.querySelectorAll('#editorOutline [data-editor-outline-index]')[1].click()");
  const outlineJump = await evaluate(cdp, sessionId, `({
    focusedHeading: document.activeElement?.value || '',
    activeOutline: document.querySelector('#editorOutline [aria-current="location"]')?.textContent || '',
  })`);
  if (outlineJump.focusedHeading !== '细节' || outlineJump.activeOutline !== '细节') {
    throw new Error(`editor outline jump invalid: ${JSON.stringify(outlineJump)}`);
  }
  const previewAppearance = await evaluate(cdp, sessionId, `(() => {
    const article = document.querySelector('#previewPane .wiki-article');
    const rail = article?.querySelector('[data-wiki-appearance]');
    const launcher = document.querySelector('#previewPane [data-appearance-launcher]');
    rail?.querySelector('[data-appearance-hide]')?.click();
    const hidden = { rail: rail?.classList.contains('is-hidden'), launcher: launcher ? !launcher.hidden : false };
    launcher?.click();
    const opened = rail?.classList.contains('is-popover-open');
    rail?.querySelector('[data-appearance-dock]')?.click();
    const restored = { rail: rail?.classList.contains('is-hidden'), launcher: launcher?.hidden };
    return { hidden, opened, restored };
  })()`);
  if (!previewAppearance.hidden.rail || !previewAppearance.hidden.launcher || !previewAppearance.opened || previewAppearance.restored.rail || !previewAppearance.restored.launcher) {
    throw new Error(`editor preview appearance invalid: ${JSON.stringify(previewAppearance)}`);
  }
  console.log(`OK editor ${viewport.width}px split preview, Markdown round trip, outline and JSON validation`);
}

async function inspect(cdp, baseUrl, viewport, index) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const errors = [];
  const listener = (message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails?.text || 'Runtime exception');
    if (message.method === 'Log.entryAdded' && message.params.entry?.level === 'error') {
      const text = `${message.params.entry.text} ${message.params.entry.url || ''}`.trim();
      if (!text.includes("Blocked attempt to show a 'beforeunload' confirmation panel")) errors.push(text);
    }
  };
  cdp.listeners.add(listener);
  try {
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId);
    if (index === 0 && !externalBaseUrl) await inspectEditor(cdp, sessionId, baseUrl, viewport);
    await inspectArticle(cdp, sessionId, baseUrl, viewport);
    if (errors.length) throw new Error(`${viewport.name} browser console errors: ${errors.join(' | ')}`);
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
    for (let index = 0; index < viewports.length; index += 1) await inspect(cdp, baseUrl, viewports[index], index);
  } finally {
    cdp.close();
    const chromeExited = new Promise((resolve) => chrome.child.once('exit', resolve));
    chrome.child.kill();
    await Promise.race([chromeExited, sleep(3000)]);
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(chrome.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
