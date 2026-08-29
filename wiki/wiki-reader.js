// Browser-safe ES module shared by the editor preview and Wiki reader contract.
const IMAGE_RATIOS = ['auto', '16/9', '4/3', '1/1', '3/4', '16/10'];
const IMAGE_ALIGNS = ['left', 'center', 'right'];
const IMAGE_FITS = ['cover', 'contain'];

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatWikiText(value) {
  let normalized = String(value ?? '').replaceAll('\\r\\n', '\n').replaceAll('\\n', '\n').replaceAll('\\r', '\r');
  const tokens = [];
  const token = (html) => {
    const index = tokens.push(html) - 1;
    return `@@WIKIMARKDOWN${index}@@`;
  };

  normalized = normalized.replace(/`([^`\r\n]+)`/g, (_, code) => token(`<code>${escapeHtml(code)}</code>`));
  normalized = normalized.replace(/\[([^\]\r\n]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    const safe = safeHref(href);
    return safe === '#' ? match : token(`<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
  });

  let html = escapeHtml(normalized)
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '<strong>$2</strong>')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<del>$1</del>')
    .replace(/(^|[^\w])([*_])(?=\S)(.+?)(?<=\S)\2(?!\w)/g, '$1<em>$3</em>')
    .replace(/\r\n|\r|\n/g, '<br>');

  return html.replace(/@@WIKIMARKDOWN(\d+)@@/g, (_, index) => tokens[Number(index)]);
}

export function safeImageUrl(value) {
  const url = String(value ?? '').trim();
  if (!url || /^\s*(?:javascript|vbscript|data:text\/html):/i.test(url)) return '';
  return url;
}

export function safeHref(value) {
  const url = String(value ?? '').trim();
  if (!url || /^\s*(?:javascript|vbscript|data:text\/html):/i.test(url)) return '#';
  return url;
}

function imageWidthPercent(value) {
  const width = Number.parseInt(value, 10);
  if (!Number.isFinite(width)) return 100;
  return Math.min(100, Math.max(25, width));
}

function option(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeParagraphs(body) {
  const lines = Array.isArray(body) ? body : String(body ?? '').split(/\r\n|\r|\n/);
  return lines.map((line) => String(line ?? '').trim()).filter(Boolean);
}

function normalizeImage(image, assetRoot = '') {
  if (!image || typeof image !== 'object') return null;
  const rawUrl = safeImageUrl(image.url);
  const url = assetRoot && rawUrl.startsWith('../uploads/') ? `${assetRoot}${rawUrl.slice('../uploads/'.length)}` : rawUrl;
  if (!url) return null;
  return {
    type: 'image',
    url,
    caption: String(image.caption ?? '').trim(),
    alt: String(image.alt ?? '').trim(),
    width_percent: imageWidthPercent(image.width_percent ?? 100),
    aspect_ratio: option(image.aspect_ratio || '16/10', IMAGE_RATIOS, '16/10'),
    align: option(image.align || 'center', IMAGE_ALIGNS, 'center'),
    fit: option(image.fit || 'cover', IMAGE_FITS, 'cover'),
  };
}

export function normalizeBlocks(section = {}, assetRoot = '') {
  const explicit = Array.isArray(section.blocks) && section.blocks.length ? section.blocks : [];
  const normalized = [];
  for (const block of explicit) {
    if (!block || typeof block !== 'object') continue;
    const type = String(block.type || '').trim().toLowerCase();
    if (type === 'paragraph') {
      const text = String(block.text ?? '').trim();
      if (text) normalized.push({ type: 'paragraph', text, note: String(block.note ?? '').trim() });
      continue;
    }
    if (type === 'image') {
      const image = normalizeImage(block, assetRoot);
      if (image) normalized.push(image);
    }
  }
  if (normalized.length) return normalized;
  return [
    ...normalizeParagraphs(section.body).map((text) => ({ type: 'paragraph', text, note: '' })),
    ...(Array.isArray(section.images) ? section.images.map((image) => normalizeImage(image, assetRoot)).filter(Boolean) : []),
  ];
}

export function localizedContent(content = {}, lang = 'zh') {
  const localized = lang === 'ja' && content.i18n?.ja && typeof content.i18n.ja === 'object'
    ? content.i18n.ja
    : {};
  return {
    ...content,
    ...localized,
    title: localized.title || content.title || '',
    summary: localized.summary || content.summary || '',
    infobox: localized.infobox && Object.keys(localized.infobox).length ? localized.infobox : (content.infobox || {}),
    sections: Array.isArray(localized.sections) && localized.sections.length ? localized.sections : (content.sections || []),
    images: Array.isArray(localized.images) && localized.images.length ? localized.images : (content.images || []),
    references: Array.isArray(localized.references) && localized.references.length ? localized.references : (content.references || []),
    updated_at: content.updated_at || '',
  };
}

function renderImage(image, className = 'wiki-image-gallery wiki-inline-image-gallery', label = '正文图片', assetRoot = '') {
  const normalized = normalizeImage(image, assetRoot);
  if (!normalized) return '';
  const ratioStyle = normalized.aspect_ratio === 'auto' ? '--wiki-image-ratio:auto;' : `--wiki-image-ratio:${normalized.aspect_ratio};`;
  const caption = normalized.caption ? `<figcaption>${formatWikiText(normalized.caption)}</figcaption>` : '';
  const alt = normalized.alt || normalized.caption || '';
  return `<section class="${escapeHtml(className)}" aria-label="${escapeHtml(label)}"><figure class="wiki-image-card wiki-image-align-${normalized.align} wiki-image-fit-${normalized.fit}" style="--wiki-image-width:${normalized.width_percent}%;${ratioStyle}"><img src="${escapeHtml(normalized.url)}" alt="${escapeHtml(alt)}" loading="lazy">${caption}</figure></section>`;
}

function renderImages(images, className = 'wiki-image-gallery', label = '图片', assetRoot = '') {
  const items = (Array.isArray(images) ? images : []).map((image) => {
    const normalized = normalizeImage(image, assetRoot);
    if (!normalized) return '';
    const ratioStyle = normalized.aspect_ratio === 'auto' ? '--wiki-image-ratio:auto;' : `--wiki-image-ratio:${normalized.aspect_ratio};`;
    const caption = normalized.caption ? `<figcaption>${formatWikiText(normalized.caption)}</figcaption>` : '';
    const alt = normalized.alt || normalized.caption || '';
    return `<figure class="wiki-image-card wiki-image-align-${normalized.align} wiki-image-fit-${normalized.fit}" style="--wiki-image-width:${normalized.width_percent}%;${ratioStyle}"><img src="${escapeHtml(normalized.url)}" alt="${escapeHtml(alt)}" loading="lazy">${caption}</figure>`;
  }).filter(Boolean).join('\n');
  return items ? `<section class="${escapeHtml(className)}" aria-label="${escapeHtml(label)}">${items}</section>` : '';
}

function renderInfobox(content, club, lang = 'zh') {
  const customRows = content.infobox && typeof content.infobox === 'object' ? content.infobox : {};
  const rows = lang === 'ja' && Object.keys(customRows).length
    ? customRows
    : {
      学校: club?.school || customRows.学校 || '',
      地区: club?.province || club?.prefecture || customRows.地区 || '',
      类型: customRows.类型 || (club?.type === 'school' ? '高校同好会' : '同好会'),
      成立时间: club?.created_at || customRows.成立时间 || '',
      状态: customRows.状态 || (Number(club?.verified) ? '已认证' : '未认证'),
      ...customRows,
    };
  const body = Object.entries(rows)
    .filter(([, value]) => String(value || '').trim())
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${formatWikiText(value)}</td></tr>`)
    .join('\n');
  return `<div class="wiki-infobox"><div class="wiki-infobox-title">${escapeHtml(content.title)}</div><table>${body}</table></div>`;
}

function renderAvatar(avatar, assetRoot = '', lang = 'zh') {
  if (!avatar || typeof avatar !== 'object') return '';
  const normalized = normalizeImage({
    ...avatar,
    width_percent: 100,
    aspect_ratio: avatar.aspect_ratio || '1/1',
    fit: avatar.fit || 'contain',
  }, assetRoot);
  if (!normalized) return '';
  const caption = normalized.caption ? `<figcaption>${escapeHtml(normalized.caption)}</figcaption>` : '';
  const alt = normalized.alt || normalized.caption || (lang === 'ja' ? '項目画像' : '条目头像');
  return `<figure class="wiki-entry-avatar wiki-image-fit-${normalized.fit}" aria-label="条目头像"><img src="${escapeHtml(normalized.url)}" alt="${escapeHtml(alt)}" loading="lazy">${caption}</figure>`;
}

function renderToc(sections, lang) {
  const tree = [];
  (Array.isArray(sections) ? sections : []).forEach((section, index) => {
    const id = `${lang}-section-${index + 1}`;
    const level = Number.parseInt(section?.level, 10) === 3 ? 3 : 2;
    const item = { id, level, heading: section?.heading || '', children: [] };
    if (level === 3 && tree.length) tree[tree.length - 1].children.push(item);
    else tree.push(item);
  });
  const renderItems = (items) => items.map((item) => {
    const children = item.children.length
      ? `<ol class="wiki-toc-sublist">${renderItems(item.children)}</ol>`
      : '';
    return `<li class="wiki-toc-item wiki-toc-level-${item.level}"><a href="#${item.id}" data-wiki-section-link="${item.id}">${escapeHtml(item.heading)}</a>${children}</li>`;
  }).join('\n');
  const label = lang === 'ja' ? '目次' : '目录';
  return `<nav class="wiki-toc" aria-label="${label}"><div class="wiki-toc-title">${label}</div><ol>${renderItems(tree)}</ol></nav>`;
}

function renderSectionBlocks(section, lang, footnotes, assetRoot) {
  return normalizeBlocks(section, assetRoot).map((block) => {
    if (block.type === 'image') return renderImage(block, 'wiki-image-gallery wiki-inline-image-gallery', lang === 'ja' ? '本文画像' : '正文图片', assetRoot);
  const text = `<p>${formatWikiText(block.text)}`;
    if (!block.note) return `${text}</p>`;
    const number = footnotes.push(block.note);
    const footnoteId = `${lang}-footnote-${number}`;
    const referenceId = `${lang}-footnote-ref-${number}`;
    const label = lang === 'ja' ? `注釈 ${number}を表示` : `查看注释 ${number}`;
    return `${text}<sup class="wiki-footnote-marker"><a href="#${footnoteId}" id="${referenceId}" aria-label="${label}">${number}</a></sup></p>`;
  }).join('\n');
}

function renderSections(sections, lang, footnotes, assetRoot) {
  return (Array.isArray(sections) ? sections : []).map((section, index) => {
    const level = Number.parseInt(section.level, 10) === 3 ? 3 : 2;
    const id = `${lang}-section-${index + 1}`;
    return `<section class="wiki-section" id="${id}" data-wiki-section="${id}"><h${level}>${escapeHtml(section.heading)}</h${level}>${renderSectionBlocks(section, lang, footnotes, assetRoot)}</section>`;
  }).join('\n');
}

function renderFootnotes(footnotes, lang) {
  if (!footnotes.length) return '';
  const items = footnotes.map((note, index) => {
    const number = index + 1;
    const label = lang === 'ja' ? '本文に戻る' : '返回正文';
    return `<li id="${lang}-footnote-${number}"><a class="wiki-footnote-backlink" href="#${lang}-footnote-ref-${number}" aria-label="${label}">${number}.</a> ${formatWikiText(note)}</li>`;
  }).join('');
  const heading = lang === 'ja' ? '注釈' : '注释';
  return `<section class="wiki-section wiki-footnotes" aria-labelledby="${lang}-footnotes-title"><h2 id="${lang}-footnotes-title">${heading}</h2><ol>${items}</ol></section>`;
}

function renderReferences(references, lang = 'zh') {
  const fallback = lang === 'ja' ? '参考資料' : '参考资料';
  const items = (Array.isArray(references) ? references : []).map((ref) => {
    const label = escapeHtml(ref?.label || ref?.url || fallback);
    const url = escapeHtml(safeHref(ref?.url || '#'));
    return `<li><a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a></li>`;
  }).join('');
  const heading = lang === 'ja' ? '参考資料' : '参考资料';
  return items ? `<section class="wiki-section wiki-references"><h2>${heading}</h2><ol>${items}</ol></section>` : '';
}

function appearanceOption(key, value, label) {
  return `<button type="button" data-appearance-key="${key}" data-appearance-value="${value}">${label}</button>`;
}

export function renderAppearanceLauncher(lang = 'zh') {
  const label = lang === 'ja' ? '閲覧設定を開く' : '打开阅读外观';
  return `<button type="button" class="wiki-appearance-launcher" data-appearance-launcher aria-label="${label}" aria-expanded="false" hidden><svg viewBox="0 0 24 24" width="18" height="18" role="img" aria-hidden="true" focusable="false"><title>${label}</title><path d="M4 5.5h16v13H4zM8 9v3m0 0 2-2m-2 2 2 2m6-3v3m0 0 2-2m-2 2 2 2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
}

function renderAppearanceRail(lang = 'zh') {
  const ja = lang === 'ja';
  const labels = ja ? {
    rail: '閲覧設定', close: '閲覧設定を閉じる', hide: '非表示', open: '閲覧設定を開く',
    font: '文字サイズ', small: '小', medium: '標準', large: '大',
    width: '本文幅', narrow: '狭い', standard: '標準', wide: '広い',
    leading: '行間', compact: '狭い', loose: '広い', theme: '閲覧テーマ',
    light: 'ライト', paper: 'ペーパー', dark: 'ダーク', reset: '初期設定に戻す', dock: 'サイドバーに戻す',
  } : {
    rail: '阅读外观', close: '关闭阅读设置', hide: '隐藏', open: '展开阅读设置',
    font: '字号', small: '小', medium: '标准', large: '大',
    width: '正文宽度', narrow: '窄', standard: '标准', wide: '宽',
    leading: '行距', compact: '紧凑', loose: '宽松', theme: '阅读主题',
    light: '明亮', paper: '纸张', dark: '深色', reset: '恢复默认', dock: '恢复到侧栏',
  };
  return `<aside class="wiki-appearance-rail" aria-label="${labels.rail}" data-wiki-appearance aria-hidden="false"><div class="wiki-appearance-header"><div class="wiki-rail-heading">${labels.rail}</div><div class="wiki-appearance-header-actions"><button type="button" class="wiki-appearance-close" data-appearance-close aria-label="${labels.close}" hidden>×</button><button type="button" class="wiki-appearance-hide" data-appearance-hide>${labels.hide}</button></div></div><button class="wiki-appearance-toggle" type="button" data-appearance-toggle aria-expanded="false">${labels.open}</button><div class="wiki-appearance-panel" data-appearance-panel><fieldset><legend>${labels.font}</legend><div class="wiki-appearance-options" role="group" aria-label="${labels.font}">${appearanceOption('font', 'small', labels.small)} ${appearanceOption('font', 'medium', labels.medium)} ${appearanceOption('font', 'large', labels.large)}</div></fieldset><fieldset><legend>${labels.width}</legend><div class="wiki-appearance-options" role="group" aria-label="${labels.width}">${appearanceOption('width', 'narrow', labels.narrow)} ${appearanceOption('width', 'standard', labels.standard)} ${appearanceOption('width', 'wide', labels.wide)}</div></fieldset><fieldset><legend>${labels.leading}</legend><div class="wiki-appearance-options" role="group" aria-label="${labels.leading}">${appearanceOption('leading', 'compact', labels.compact)} ${appearanceOption('leading', 'standard', labels.standard)} ${appearanceOption('leading', 'loose', labels.loose)}</div></fieldset><fieldset><legend>${labels.theme}</legend><div class="wiki-appearance-options" role="group" aria-label="${labels.theme}">${appearanceOption('theme', 'light', labels.light)} ${appearanceOption('theme', 'paper', labels.paper)} ${appearanceOption('theme', 'dark', labels.dark)}</div></fieldset><button type="button" class="wiki-appearance-reset" data-appearance-reset>${labels.reset}</button><button type="button" class="wiki-appearance-dock" data-appearance-dock hidden>${labels.dock}</button></div></aside>`;
}

export function renderReaderArticle(content = {}, club = {}, lang = 'zh', options = {}) {
  const footnotes = [];
  const article = localizedContent(content, lang);
  const hidden = options.hidden ? ' hidden' : '';
  const assetRoot = options.assetRoot || '';
  const sections = renderSections(article.sections, lang, footnotes, assetRoot);
  const label = lang === 'ja' ? '日本語' : '中文';
  const updatedLabel = lang === 'ja' ? '最終更新' : '最后更新';
  const avatar = renderAvatar(article.avatar, assetRoot, lang);
  const avatarPosition = article.avatar?.position === 'bottom' ? 'bottom' : 'top';
  const avatarTop = avatarPosition === 'top' ? avatar : '';
  const avatarBottom = avatarPosition === 'bottom' ? avatar : '';
  const factsLabel = lang === 'ja' ? '項目情報' : '条目资料';
  const entryFacts = `<aside class="wiki-entry-facts" aria-label="${factsLabel}"><div class="wiki-rail-heading">${factsLabel}</div>${avatarTop}${renderInfobox(article, club, lang)}${avatarBottom}</aside>`;
  return `<article class="wiki-article" data-wiki-lang="${lang}" data-wiki-article="true"${hidden}><aside class="wiki-article-nav">${renderToc(article.sections, lang)}</aside><div class="wiki-article-main"><header class="wiki-article-header"><p class="wiki-index-kicker">VNFest WIKI · ${label}</p><h1>${escapeHtml(article.title)}</h1></header><p class="wiki-summary">${formatWikiText(article.summary)}</p>${entryFacts}${renderImages(article.images, 'wiki-image-gallery', lang === 'ja' ? '画像' : '图片', assetRoot)}${sections}${renderFootnotes(footnotes, lang)}${renderReferences(article.references, lang)}<footer class="wiki-footer">${updatedLabel}：${escapeHtml(article.updated_at || '未记录')}</footer></div><aside class="wiki-article-rail">${renderAppearanceRail(lang)}</aside></article>`;
}
