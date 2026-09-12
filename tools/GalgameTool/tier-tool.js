/* GalgameTool Tier board. Data domain is separate from resume/MEME while
   reusing the same first-party APIs and interaction conventions. */
(() => {
  'use strict';

  const TIER_SCHEMA_VERSION = 1;
  const TIER_MAX_ROWS = 12;
  const TIER_MAX_CARDS_PER_ROW = 60;
  const TIER_MAX_UNRANKED = 100;
  const TIER_MAX_LOCAL_IMAGE_BYTES = 8 * 1024 * 1024;
  const TIER_STORAGE_GUEST = 'vnfest_galgame_tier_data:guest';
  const TIER_STORAGE_PREFIX = 'vnfest_galgame_tier_data:user:';
  const TIER_STORAGE_BACKUP_SUFFIX = ':backup';
  const TIER_MIGRATION_PROMPT_SUFFIX = ':migration-prompted';
  const TIER_API_URL = new URL('../../api/galgame_tier.php', document.baseURI).href;
  const AUTH_API_URL = new URL('../../api/auth.php', document.baseURI).href;
  const BANGUMI_PROXY_URL = new URL('../../api/bangumi_proxy.php', document.baseURI).href;
  const BANGUMI_ACCOUNT_URL = new URL('../../api/bangumi_account.php', document.baseURI).href;
  const VNDB_PROXY_URL = new URL('../../api/vndb_proxy.php', document.baseURI).href;
  const IMAGE_PROXY_URL = new URL('../../api/image_proxy.php', document.baseURI).href;
  const IMAGE_PROXY_HOSTS = new Set([
    'lain.bgm.tv', 't.vndb.org', 's.vndb.org', 'tucang.cngal.top', 'image.cngal.org'
  ]);

  const DEFAULT_ROWS = [
    { label: 'S', color: '#ff7f7f' },
    { label: 'A', color: '#ffbf7f' },
    { label: 'B', color: '#ffdf7f' },
    { label: 'C', color: '#bfff7f' },
    { label: 'D', color: '#7fbfff' }
  ];

  const COLOR_PALETTE = [
    '#ff7f7f', '#ffbf7f', '#ffdf7f', '#feff7f',
    '#bfff7f', '#7fff7f', '#7fffff', '#7fbfff',
    '#bf7fff', '#ff7fff', '#d9d3de', '#404040'
  ];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  let state = createDefaultTier();
  let sessionUser = null;
  let activeStorageKey = TIER_STORAGE_GUEST;
  let cloudEnabled = false;
  let serverLoadPending = true;
  let serverSaveTimer = null;
  let serverSaveInFlight = false;
  let serverSaveQueued = false;
  let searchController = null;
  let searchTimer = null;
  let searchGeneration = 0;
  let draggedCardId = null;
  let pointerDrag = null;
  let suppressNextClickId = null;
  let previewContext = null;
  let colorPopRowId = null;
  let importOffset = 0;
  let importHasMore = false;
  let importLoading = false;
  const importRows = new Map();
  const importSelected = new Set();
  let customImageData = '';
  let toastTimer = null;

  function uid(prefix = 'tier') {
    if (window.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function text(value, fallback = '') {
    const result = String(value ?? '').trim();
    return result || fallback;
  }

  function safeImage(value) {
    const raw = text(value);
    if (!raw) return '';
    if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+\/\s=]+$/i.test(raw)) return raw;
    try {
      const url = new URL(raw, document.baseURI);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
      if (url.origin === location.origin && url.pathname.startsWith('/')) return url.href;
    } catch (_) {
      return '';
    }
    return '';
  }

  function proxyImage(value) {
    const raw = safeImage(value);
    if (!raw || /^data:/i.test(raw)) return raw;
    try {
      const url = new URL(raw, document.baseURI);
      if (url.origin === location.origin && url.pathname.endsWith('/api/image_proxy.php')) return url.href;
      if (IMAGE_PROXY_HOSTS.has(url.hostname.toLowerCase())) {
        return `${IMAGE_PROXY_URL}?url=${encodeURIComponent(url.href)}`;
      }
    } catch (_) {
      return '';
    }
    return raw;
  }

  function contrastInk(hex) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!match) return '#1c1b1f';
    const value = Number.parseInt(match[1], 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 150 ? '#1c1b1f' : '#ffffff';
  }

  async function fetchJson(url, options = {}) {
    try {
      const response = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options
      });
      const raw = await response.text();
      let data = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch (_) {
        return { ok: false, status: response.status, unavailable: true };
      }
      return { ...data, ok: response.ok, status: response.status };
    } catch (error) {
      return { ok: false, unavailable: true, error };
    }
  }

  function defaultRow(index) {
    const preset = DEFAULT_ROWS[index] || { label: `ROW ${index + 1}`, color: '#d9d3de' };
    return {
      id: `row-${index + 1}`,
      label: preset.label,
      color: preset.color,
      cards: []
    };
  }

  function createDefaultTier() {
    return {
      schema_version: TIER_SCHEMA_VERSION,
      board: {
        title: 'Galgame Tier 表',
        rows: DEFAULT_ROWS.map((_, index) => defaultRow(index)),
        unranked: []
      },
      settings: { cardSize: 'sm', showTitles: true }
    };
  }

  function normalizeCard(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title = text(raw.title || raw.name);
    if (!title) return null;
    const kind = ['work', 'character', 'custom'].includes(raw.kind) ? raw.kind : (raw.cv ? 'character' : 'work');
    const source = ['bangumi', 'cngal', 'vndb', 'resume', 'custom'].includes(raw.source) ? raw.source : 'custom';
    const bangumiId = Number(raw.bangumiId || raw.bangumi_id || 0);
    return {
      id: text(raw.id, uid('card')),
      kind,
      source,
      sourceId: text(raw.sourceId || raw.source_id || raw.id, ''),
      bangumiId: Number.isInteger(bangumiId) && bangumiId > 0 ? bangumiId : undefined,
      title,
      subtitle: text(raw.subtitle || raw.sub || (raw.cv ? `CV ${raw.cv}` : ''), ''),
      image: proxyImage(raw.image || raw.imageUrl || raw.image_url || '')
    };
  }

  function normalizeRow(raw, index) {
    const fallback = defaultRow(index);
    const cards = Array.isArray(raw?.cards) ? raw.cards.map(normalizeCard).filter(Boolean).slice(0, TIER_MAX_CARDS_PER_ROW) : [];
    return {
      id: text(raw?.id, fallback.id),
      label: text(raw?.label, fallback.label).slice(0, 24),
      color: normalizeColor(raw?.color, fallback.color),
      cards
    };
  }

  function normalizeColor(value, fallback) {
    return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : fallback;
  }

  function normalizeTier(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const sourceBoard = source.board && typeof source.board === 'object' ? source.board : source;
    const sourceSettings = source.settings && typeof source.settings === 'object' ? source.settings : {};
    const result = createDefaultTier();
    result.board.title = text(sourceBoard.title, result.board.title).slice(0, 80);
    const rawRows = Array.isArray(sourceBoard.rows) ? sourceBoard.rows : [];
    if (rawRows.length) {
      result.board.rows = rawRows.slice(0, TIER_MAX_ROWS).map(normalizeRow);
    }
    result.board.unranked = Array.isArray(sourceBoard.unranked)
      ? sourceBoard.unranked.map(normalizeCard).filter(Boolean).slice(0, TIER_MAX_UNRANKED)
      : [];
    result.settings.cardSize = ['sm', 'md', 'lg'].includes(sourceSettings.cardSize) ? sourceSettings.cardSize : 'sm';
    result.settings.showTitles = sourceSettings.showTitles !== false;
    return result;
  }

  function serializeTier() {
    return normalizeTier(state);
  }

  function readLocal(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function writeLocal() {
    try {
      localStorage.setItem(activeStorageKey, JSON.stringify(serializeTier()));
    } catch (error) {
      console.warn('Tier local save failed:', error);
      showToast('本机空间不足，云端同步仍会继续尝试', 'error');
    }
  }

  function writeLocalBackup(value) {
    if (!value) return;
    try {
      localStorage.setItem(`${activeStorageKey}${TIER_STORAGE_BACKUP_SUFFIX}`, JSON.stringify(normalizeTier(value)));
    } catch (_) {
      // A backup is best-effort; the active local draft must remain unaffected.
    }
  }

  function setSyncStatus(status) {
    const el = $('#tierSyncStatus');
    if (!el) return;
    const labels = {
      loading: '正在加载 Tier 表',
      local: '本机保存',
      syncing: '正在同步',
      synced: '已同步',
      error: '同步失败，已保留本机 Tier 表'
    };
    el.dataset.state = status;
    el.textContent = labels[status] || labels.local;
    el.title = sessionUser?.username ? `当前账号：${sessionUser.username}` : '未登录，仅保存到本机';
  }

  async function saveServer() {
    if (!cloudEnabled || !sessionUser?.id) return false;
    const response = await fetchJson(`${TIER_API_URL}?action=save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: serializeTier() })
    });
    if (!response.ok || !response.success) {
      setSyncStatus('error');
      return false;
    }
    setSyncStatus('synced');
    return true;
  }

  function scheduleServerSave() {
    if (!cloudEnabled || serverLoadPending) return;
    serverSaveQueued = true;
    setSyncStatus('syncing');
    clearTimeout(serverSaveTimer);
    serverSaveTimer = setTimeout(async () => {
      serverSaveTimer = null;
      if (serverSaveInFlight) return;
      serverSaveInFlight = true;
      serverSaveQueued = false;
      try {
        await saveServer();
      } finally {
        serverSaveInFlight = false;
        if (serverSaveQueued) scheduleServerSave();
      }
    }, 800);
  }

  function persist() {
    writeLocal();
    scheduleServerSave();
  }

  async function bootstrap() {
    const auth = await fetchJson(`${AUTH_API_URL}?action=me`);
    if (auth.logged_in && auth.user?.id) {
      sessionUser = auth.user;
      activeStorageKey = `${TIER_STORAGE_PREFIX}${sessionUser.id}`;
      cloudEnabled = true;
    } else {
      sessionUser = null;
      activeStorageKey = TIER_STORAGE_GUEST;
      cloudEnabled = false;
    }

    const local = readLocal(activeStorageKey);
    if (local) state = normalizeTier(local);

    let initialSyncStatus = cloudEnabled ? 'synced' : 'local';
    if (cloudEnabled) {
      const remote = await fetchJson(`${TIER_API_URL}?action=load`);
      if (remote.ok && remote.success && remote.tier) {
        if (local) writeLocalBackup(local);
        state = normalizeTier(remote.tier);
      } else if (remote.ok && remote.success && !remote.tier && local && localHasContent(local)) {
        let prompted = false;
        try { prompted = localStorage.getItem(`${activeStorageKey}${TIER_MIGRATION_PROMPT_SUFFIX}`) === '1'; } catch (_) { /* ignore */ }
        if (!prompted) {
          try { localStorage.setItem(`${activeStorageKey}${TIER_MIGRATION_PROMPT_SUFFIX}`, '1'); } catch (_) { /* ignore */ }
          if (window.confirm('发现本机 Tier 表，是否上传到当前账号？')) {
            await saveServer();
          } else {
            writeLocalBackup(local);
          }
        }
      } else if (!remote.ok) {
        initialSyncStatus = 'error';
      }
    }

    writeLocal();
    renderAll();
    serverLoadPending = false;
    setSyncStatus(initialSyncStatus);
    await hydrateSharedHash();
    renderAll();
  }

  function localHasContent(raw) {
    const board = raw?.board || raw;
    if (!board) return false;
    const rows = Array.isArray(board.rows) ? board.rows : [];
    const unranked = Array.isArray(board.unranked) ? board.unranked : [];
    return rows.some(row => Array.isArray(row?.cards) && row.cards.length) || unranked.length > 0;
  }

  function allCards() {
    const result = [];
    state.board.rows.forEach(row => row.cards.forEach(card => result.push({ card, location: row.id })));
    state.board.unranked.forEach(card => result.push({ card, location: 'unranked' }));
    return result;
  }

  function cardKey(card) {
    if (!card) return '';
    if (card.bangumiId) return `bangumi:${card.bangumiId}`;
    if (card.sourceId && card.source !== 'custom') return `${card.source}:${card.sourceId}`;
    return `${card.source}:${card.title}:${card.image || ''}`.toLowerCase();
  }

  function hasCard(card) {
    const key = cardKey(card);
    return !!key && allCards().some(entry => cardKey(entry.card) === key);
  }

  function takeCard(cardId) {
    for (const row of state.board.rows) {
      const index = row.cards.findIndex(card => card.id === cardId);
      if (index >= 0) return row.cards.splice(index, 1)[0];
    }
    const index = state.board.unranked.findIndex(card => card.id === cardId);
    if (index >= 0) return state.board.unranked.splice(index, 1)[0];
    return null;
  }

  function destinationList(targetId) {
    if (targetId === 'unranked') return state.board.unranked;
    return state.board.rows.find(row => row.id === targetId)?.cards || null;
  }

  function moveCard(cardId, targetId, index = null) {
    const destination = destinationList(targetId);
    if (!destination) return;
    const limit = targetId === 'unranked' ? TIER_MAX_UNRANKED : TIER_MAX_CARDS_PER_ROW;
    const moving = allCards().find(item => item.card.id === cardId);
    if (moving && moving.location === targetId && index === null) return;
    if (moving?.location !== targetId && destination.length >= limit) {
      showToast(targetId === 'unranked'
        ? `未分类最多保存 ${TIER_MAX_UNRANKED} 项`
        : `每个梯队最多保存 ${TIER_MAX_CARDS_PER_ROW} 项`, 'error');
      return;
    }
    const card = takeCard(cardId);
    if (!card) return;
    const insertAt = index === null ? destination.length : Math.max(0, Math.min(index, destination.length));
    destination.splice(insertAt, 0, card);
    persist();
    renderAll();
  }

  function moveCardWithin(cardId, delta) {
    const entry = allCards().find(item => item.card.id === cardId);
    if (!entry) return;
    const list = destinationList(entry.location);
    const from = list.findIndex(card => card.id === cardId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= list.length) return;
    const [card] = list.splice(from, 1);
    list.splice(to, 0, card);
    persist();
    renderAll();
  }

  function moveCardByKeyboard(cardId, key) {
    const entry = allCards().find(item => item.card.id === cardId);
    if (!entry) return;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      moveCardWithin(cardId, key === 'ArrowLeft' ? -1 : 1);
      window.setTimeout(() => $$('.tier-card').find(element => element.dataset.cardId === cardId)?.focus(), 0);
      return;
    }
    // The unranked pool sits visually BELOW the board, so it is the last
    // stop: ArrowDown from the bottom row reaches the pool, ArrowUp escapes it.
    const rowIds = [...state.board.rows.map(row => row.id), 'unranked'];
    const currentIndex = rowIds.indexOf(entry.location);
    const nextIndex = Math.max(0, Math.min(rowIds.length - 1, currentIndex + (key === 'ArrowUp' ? -1 : 1)));
    if (nextIndex === currentIndex) return;
    moveCard(cardId, rowIds[nextIndex]);
    window.setTimeout(() => $$('.tier-card').find(element => element.dataset.cardId === cardId)?.focus(), 0);
  }

  function rowIdsAfter(rowId) {
    const ids = state.board.rows.map(row => row.id);
    const index = ids.indexOf(rowId);
    return index >= 0 ? index : ids.length;
  }

  function addRow(afterRowId) {
    if (state.board.rows.length >= TIER_MAX_ROWS) {
      showToast(`最多 ${TIER_MAX_ROWS} 个梯队`, 'error');
      return;
    }
    const used = new Set(state.board.rows.map(row => row.label.toLowerCase()));
    const letters = 'SABCDEFGHIJKL'.split('');
    const letter = letters.find(item => !used.has(item.toLowerCase())) || `ROW ${state.board.rows.length + 1}`;
    const usedColors = new Set(state.board.rows.map(row => row.color));
    const color = COLOR_PALETTE.find(item => !usedColors.has(item)) || '#d9d3de';
    const row = { id: uid('row'), label: letter, color, cards: [] };
    const insertAt = afterRowId ? rowIdsAfter(afterRowId) + 1 : state.board.rows.length;
    state.board.rows.splice(Math.min(insertAt, state.board.rows.length), 0, row);
    persist();
    renderAll();
  }

  function moveRow(rowId, delta) {
    const index = state.board.rows.findIndex(row => row.id === rowId);
    const to = index + delta;
    if (index < 0 || to < 0 || to >= state.board.rows.length) return;
    const [row] = state.board.rows.splice(index, 1);
    state.board.rows.splice(to, 0, row);
    persist();
    renderAll();
  }

  function deleteRow(rowId) {
    const row = state.board.rows.find(item => item.id === rowId);
    if (!row) return;
    if (state.board.unranked.length + row.cards.length > TIER_MAX_UNRANKED) {
      showToast('未分类池放不下这一行的卡片，请先移出部分卡片', 'error');
      return;
    }
    if (!window.confirm(`删除「${row.label}」梯队？行内卡片会退回未分类。`)) return;
    state.board.unranked.push(...row.cards);
    state.board.rows = state.board.rows.filter(item => item.id !== rowId);
    persist();
    renderAll();
  }

  function renameRow(rowId) {
    const row = state.board.rows.find(item => item.id === rowId);
    if (!row) return;
    const value = window.prompt('编辑梯队标签', row.label);
    if (value === null) return;
    const label = text(value).slice(0, 24);
    if (!label) return;
    row.label = label;
    persist();
    renderAll();
  }

  function recolorRow(rowId, color) {
    const row = state.board.rows.find(item => item.id === rowId);
    if (!row) return;
    row.color = normalizeColor(color, row.color);
    persist();
    renderAll();
  }

  function openColorPop(rowId, anchor) {
    const pop = $('#tierColorPop');
    if (!pop) return;
    colorPopRowId = rowId;
    pop.innerHTML = '';
    COLOR_PALETTE.forEach(color => {
      const button = document.createElement('button');
      button.type = 'button';
      button.style.background = color;
      button.title = color;
      button.setAttribute('aria-label', `换为 ${color}`);
      button.addEventListener('click', () => {
        recolorRow(colorPopRowId, color);
        closeColorPop();
      });
      pop.appendChild(button);
    });
    pop.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const width = pop.offsetWidth || 220;
    const height = pop.offsetHeight || 110;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left));
    const top = rect.bottom + 8 + height > window.innerHeight ? Math.max(8, rect.top - height - 8) : rect.bottom + 8;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function closeColorPop() {
    colorPopRowId = null;
    const pop = $('#tierColorPop');
    if (pop) pop.hidden = true;
  }

  function addCard(raw, targetId = 'unranked', options = {}) {
    const { silent = false, deferRender = false } = options;
    const card = normalizeCard(raw);
    if (!card) return false;
    if (hasCard(card)) {
      if (!silent) showToast('这张卡片已经在 Tier 表中', 'error');
      return false;
    }
    const destination = destinationList(targetId) || state.board.unranked;
    const limit = destination === state.board.unranked ? TIER_MAX_UNRANKED : TIER_MAX_CARDS_PER_ROW;
    if (destination.length >= limit) {
      if (!silent) showToast(`列表最多保存 ${limit} 项`, 'error');
      return false;
    }
    destination.push(card);
    if (!deferRender) {
      persist();
      renderAll();
    }
    return true;
  }

  function removeCardCompletely(cardId) {
    const card = takeCard(cardId);
    if (!card) return;
    persist();
    renderAll();
    showToast('已从 Tier 表移除');
  }

  function cardLink(card) {
    if (card.source === 'bangumi') {
      if (card.bangumiId) return card.kind === 'character'
        ? `https://bgm.tv/character/${card.bangumiId}`
        : `https://bgm.tv/subject/${card.bangumiId}`;
      return '';
    }
    if (card.source === 'vndb' && card.sourceId) return `https://vndb.org/${encodeURIComponent(card.sourceId)}`;
    if (card.source === 'cngal' && card.sourceId) return `https://www.cngal.com/entries/show/${encodeURIComponent(card.sourceId)}`;
    return '';
  }

  function pointerDropTarget(x, y) {
    const target = document.elementFromPoint(x, y);
    const row = target?.closest?.('.tier-row');
    if (row?.dataset.rowId) return { location: row.dataset.rowId, rowElement: row };
    if (target?.closest?.('#tierUnrankedPanel')) return { location: 'unranked', rowElement: null };
    return null;
  }

  function computeDropIndex(rowElement, clientX, cardId) {
    const container = $('.tier-row-cards', rowElement);
    if (!container) return null;
    const elements = $$('.tier-card', container);
    let index = elements.length;
    for (let i = 0; i < elements.length; i++) {
      const rect = elements[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        index = i;
        break;
      }
    }
    const from = elements.findIndex(el => el.dataset.cardId === cardId);
    if (from >= 0 && from < index) index -= 1;
    return Math.max(0, index);
  }

  function clearPointerDrag() {
    if (!pointerDrag) return;
    try { pointerDrag.item.releasePointerCapture(pointerDrag.pointerId); } catch (_) { /* ignore */ }
    pointerDrag.item.classList.remove('is-pointer-dragging');
    $$('.is-drag-over').forEach(element => element.classList.remove('is-drag-over'));
    pointerDrag = null;
  }

  function handlePointerDown(event, item, card) {
    if (!event.isPrimary || event.pointerType === 'mouse' || event.target.closest('.tier-card-remove')) return;
    pointerDrag = {
      cardId: card.id,
      item,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      target: null,
      dropIndex: null
    };
    try { item.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }
  }

  function handlePointerMove(event) {
    if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
    const distance = Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY);
    if (!pointerDrag.started && distance < 8) return;
    if (!pointerDrag.started) {
      pointerDrag.started = true;
      suppressNextClickId = pointerDrag.cardId;
      pointerDrag.item.classList.add('is-pointer-dragging');
    }
    event.preventDefault();
    const target = pointerDropTarget(event.clientX, event.clientY);
    pointerDrag.target = target;
    pointerDrag.dropIndex = target?.rowElement ? computeDropIndex(target.rowElement, event.clientX, pointerDrag.cardId) : null;
    $$('.is-drag-over').forEach(element => element.classList.remove('is-drag-over'));
    if (target) {
      (target.rowElement || $('#tierUnrankedPanel'))?.classList.add('is-drag-over');
    }
  }

  function handlePointerUp(event) {
    if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
    const drag = pointerDrag;
    if (drag.started && drag.target) moveCard(drag.cardId, drag.target.location, drag.dropIndex);
    clearPointerDrag();
  }

  function makeImage(image, alt, kind) {
    const media = document.createElement('div');
    media.className = 'tier-card-media';
    if (image) {
      const img = document.createElement('img');
      img.src = image;
      img.alt = alt;
      img.loading = 'lazy';
      img.addEventListener('error', () => media.classList.add('is-missing'), { once: true });
      media.appendChild(img);
    } else {
      media.classList.add('is-missing');
    }
    return media;
  }

  function makeCardElement(card, options = {}) {
    const { previewOnly = false } = options;
    const item = document.createElement('article');
    item.className = 'tier-card';
    item.dataset.cardId = card.id;
    item.dataset.kind = card.kind;
    if (!previewOnly) item.classList.add('is-card-entering');
    item.draggable = !previewOnly;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `${card.title}，拖拽、按 Enter 预览，方向键移动，双击退回未分类`);
    item.setAttribute('aria-keyshortcuts', 'Enter Space ArrowLeft ArrowRight ArrowUp ArrowDown');
    item.appendChild(makeImage(card.image, card.title, card.kind));
    if (state.settings.showTitles) {
      const label = document.createElement('span');
      label.className = 'tier-card-label';
      label.textContent = card.title;
      item.appendChild(label);
    }
    if (!previewOnly) {
      const remove = document.createElement('button');
      remove.className = 'tier-card-remove';
      remove.type = 'button';
      remove.title = '彻底移除卡片';
      remove.setAttribute('aria-label', `移除 ${card.title}`);
      remove.textContent = '×';
      remove.addEventListener('click', event => {
        event.stopPropagation();
        removeCardCompletely(card.id);
      });
      item.appendChild(remove);
    }
    item.addEventListener('dragstart', event => {
      draggedCardId = card.id;
      item.classList.add('is-dragging');
      event.dataTransfer?.setData('text/plain', card.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      draggedCardId = null;
      item.classList.remove('is-dragging');
      $$('.is-drag-over').forEach(el => el.classList.remove('is-drag-over'));
    });
    if (!previewOnly) {
      item.addEventListener('pointerdown', event => handlePointerDown(event, item, card));
      item.addEventListener('pointermove', handlePointerMove, { passive: false });
      item.addEventListener('pointerup', handlePointerUp);
      item.addEventListener('pointercancel', clearPointerDrag);
    }
    item.addEventListener('dblclick', event => {
      if (previewOnly || event.target.closest('.tier-card-remove')) return;
      const entry = allCards().find(item2 => item2.card.id === card.id);
      if (entry && entry.location !== 'unranked') {
        moveCard(card.id, 'unranked');
        showToast('已退回未分类');
      }
    });
    item.addEventListener('click', event => {
      if (previewOnly || event.target.closest('.tier-card-remove')) return;
      if (suppressNextClickId === card.id) {
        suppressNextClickId = null;
        return;
      }
      openCardPreview(card);
    });
    item.addEventListener('keydown', event => {
      if (previewOnly) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openCardPreview(card);
      } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        moveCardByKeyboard(card.id, event.key);
      }
    });
    return item;
  }

  function installRowDropTarget(rowElement, rowId) {
    if (!rowElement || rowElement.dataset.dropInstalled) return;
    rowElement.dataset.dropInstalled = '1';
    rowElement.addEventListener('dragover', event => {
      event.preventDefault();
      rowElement.classList.add('is-drag-over');
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    rowElement.addEventListener('dragleave', event => {
      if (!rowElement.contains(event.relatedTarget)) rowElement.classList.remove('is-drag-over');
    });
    rowElement.addEventListener('drop', event => {
      event.preventDefault();
      rowElement.classList.remove('is-drag-over');
      const id = event.dataTransfer?.getData('text/plain') || draggedCardId;
      if (!id) return;
      const index = computeDropIndex(rowElement, event.clientX, id);
      moveCard(id, rowId, index);
    });
  }

  function installPoolDropTarget(element) {
    if (!element || element.dataset.dropInstalled) return;
    element.dataset.dropInstalled = '1';
    element.addEventListener('dragover', event => {
      event.preventDefault();
      element.classList.add('is-drag-over');
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    element.addEventListener('dragleave', event => {
      if (!element.contains(event.relatedTarget)) element.classList.remove('is-drag-over');
    });
    element.addEventListener('drop', event => {
      event.preventDefault();
      element.classList.remove('is-drag-over');
      const id = event.dataTransfer?.getData('text/plain') || draggedCardId;
      if (id) moveCard(id, 'unranked');
    });
  }

  function renderRows() {
    const container = $('#tierRows');
    if (!container) return;
    container.innerHTML = '';
    state.board.rows.forEach(row => {
      const rowEl = document.createElement('section');
      rowEl.className = 'tier-row';
      rowEl.dataset.rowId = row.id;
      rowEl.tabIndex = 0;
      rowEl.setAttribute('aria-label', `${row.label}梯队`);
      const label = document.createElement('div');
      label.className = 'tier-row-label';
      label.style.setProperty('--row-color', row.color);
      label.style.setProperty('--row-contrast', contrastInk(row.color));
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'tier-row-name';
      name.textContent = row.label;
      name.title = '双击编辑梯队标签';
      name.addEventListener('click', () => renameRow(row.id));
      label.appendChild(name);
      const color = document.createElement('button');
      color.type = 'button';
      color.className = 'tier-row-color';
      color.style.background = row.color;
      color.title = '更换梯队颜色';
      color.setAttribute('aria-label', `更换 ${row.label} 梯队颜色`);
      color.addEventListener('click', event => {
        event.stopPropagation();
        openColorPop(row.id, color);
      });
      label.appendChild(color);
      const ops = document.createElement('div');
      ops.className = 'tier-row-ops';
      const opButtons = [
        { text: '↑', title: '上移梯队', action: () => moveRow(row.id, -1), danger: false },
        { text: '↓', title: '下移梯队', action: () => moveRow(row.id, 1), danger: false },
        { text: '+', title: '在此行下方添加梯队', action: () => addRow(row.id), danger: false },
        { text: '✕', title: '删除梯队', action: () => deleteRow(row.id), danger: true }
      ];
      opButtons.forEach(op => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = op.text;
        button.title = op.title;
        button.setAttribute('aria-label', `${op.title}（${row.label}）`);
        if (op.danger) button.classList.add('is-danger');
        button.addEventListener('click', event => {
          event.stopPropagation();
          closeColorPop();
          op.action();
        });
        ops.appendChild(button);
      });
      label.appendChild(ops);
      rowEl.appendChild(label);
      const cards = document.createElement('div');
      cards.className = 'tier-row-cards';
      if (!row.cards.length) {
        const empty = document.createElement('div');
        empty.className = 'tier-row-empty';
        empty.textContent = '拖入卡片';
        cards.appendChild(empty);
      } else {
        row.cards.forEach(card => cards.appendChild(makeCardElement(card)));
      }
      rowEl.appendChild(cards);
      installRowDropTarget(rowEl, row.id);
      container.appendChild(rowEl);
    });
  }

  function renderUnranked() {
    const container = $('#tierUnrankedGrid');
    const count = $('#tierUnrankedCount');
    if (!container) return;
    if (count) count.textContent = String(state.board.unranked.length);
    container.innerHTML = '';
    if (!state.board.unranked.length) {
      const empty = document.createElement('div');
      empty.className = 'tier-empty-state';
      empty.textContent = '未分类为空。可以搜索作品、角色、导入 Bangumi 收藏或添加本地图片。';
      container.appendChild(empty);
    } else {
      state.board.unranked.forEach(card => container.appendChild(makeCardElement(card)));
    }
    installPoolDropTarget($('#tierUnrankedPanel'));
  }

  function renderAll() {
    const title = $('#tierBoardTitle');
    if (title) title.textContent = state.board.title;
    const workspace = $('#tierView');
    if (workspace) workspace.dataset.cardSize = state.settings.cardSize;
    const board = $('#tierBoard');
    if (board) board.dataset.cardSize = state.settings.cardSize;
    $$('.tier-segment').forEach(button => {
      const selected = button.dataset.cardSize === state.settings.cardSize;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    $('#tierShowTitles')?.classList.toggle('is-active', state.settings.showTitles);
    $('#tierShowTitles')?.setAttribute('aria-pressed', String(state.settings.showTitles));
    renderRows();
    renderUnranked();
    renderSearchResults();
  }

  function editBoardTitle() {
    const value = window.prompt('编辑 Tier 表标题', state.board.title);
    if (value === null) return;
    const title = text(value).slice(0, 80);
    if (!title) return;
    state.board.title = title;
    persist();
    renderAll();
  }

  function openTierSearch() {
    document.querySelector('[data-pool-tab="search"]')?.click();
    $('#tierSearchInput')?.focus();
    $('#tierSearchInput')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /* ---------------- Search ---------------- */

  function resultYear(item) {
    return String(item.year || '').slice(0, 4);
  }

  async function searchBangumi(query, kind, signal) {
    const action = kind === 'character' ? 'search_character' : 'search';
    const params = new URLSearchParams({ action, keyword: query });
    if (kind === 'work') params.set('type', '4');
    if (kind === 'character') params.set('limit', '15');
    const data = await fetchJson(`${BANGUMI_PROXY_URL}?${params}`, { signal });
    if (!data.ok || !data.success) return [];
    return (data.data || []).map(item => {
      const id = Number(item.bangumi_id || item.character_id || item.id || 0);
      const character = kind === 'character';
      return {
        id: `bgm_${character ? 'char' : 'vn'}_${id}`,
        sourceId: `bgm_${character ? 'char' : 'vn'}_${id}`,
        bangumiId: id,
        kind: character ? 'character' : 'work',
        source: 'bangumi',
        sourceLabel: 'Bangumi',
        title: text(character ? (item.name_cn || item.name) : (item.title_cn || item.title), '未命名'),
        image: proxyImage(item.image_url || item.image_url_raw || ''),
        subtitle: character ? (item.cv ? `CV ${item.cv}` : text(item.name, '')) : text(item.title, ''),
        year: character ? '' : String(item.air_date || '').slice(0, 4)
      };
    }).filter(item => item.bangumiId > 0);
  }

  async function searchCnGal(query, kind, signal) {
    const typeParam = kind === 'character' ? 'Role' : 'Game';
    const url = `https://api.cngal.org/api/home/Search?Page=1&Types=${typeParam}&Text=${encodeURIComponent(query)}`;
    const data = await fetchJson(url, { signal });
    if (!data.ok) return [];
    return (data.pagedResultDto?.data || []).filter(item => item.entry?.type === typeParam).map(item => {
      const entry = item.entry;
      return {
        id: `cngal_${kind === 'character' ? 'char' : 'vn'}_${entry.id}`,
        sourceId: String(entry.id),
        kind: kind === 'character' ? 'character' : 'work',
        source: 'cngal',
        sourceLabel: 'CnGal',
        title: text(entry.name, '未命名'),
        image: proxyImage(entry.mainImage || ''),
        subtitle: text(entry.briefIntroduction, ''),
        year: ''
      };
    });
  }

  async function searchVndb(query, signal) {
    const params = new URLSearchParams({ action: 'search', keyword: query, limit: '15' });
    const data = await fetchJson(`${VNDB_PROXY_URL}?${params}`, { signal });
    if (!data.ok || !data.success) return [];
    return (data.data || []).map(item => ({
      id: `vndb_${text(item.vndb_id, uid('vn'))}`,
      sourceId: text(item.vndb_id),
      kind: 'work',
      source: 'vndb',
      sourceLabel: 'VNDB',
      title: text(item.title, '未命名'),
      image: proxyImage(item.cover_url || ''),
      subtitle: text(item.brand || item.release_year, ''),
      year: String(item.release_year || '').slice(0, 4)
    }));
  }

  function renderSearchResults(results = window.tierLastSearchResults || []) {
    const container = $('#tierSearchResults');
    if (!container) return;
    window.tierLastSearchResults = results;
    container.innerHTML = '';
    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'tier-empty-state';
      empty.textContent = $('#tierSearchInput')?.value.trim() ? '没有找到可用结果。' : '输入关键词开始搜索。';
      container.appendChild(empty);
      return;
    }
    results.forEach(result => {
      const card = document.createElement('article');
      card.className = 'tier-pool-result';
      if (hasCard(result)) card.classList.add('is-added');
      const media = makeImage(result.image, result.title, result.kind);
      media.classList.add('tier-pool-result-media');
      card.appendChild(media);
      const copy = document.createElement('div');
      copy.className = 'tier-pool-result-copy';
      const title = document.createElement('strong');
      title.textContent = result.title;
      const sub = document.createElement('span');
      sub.textContent = [result.sourceLabel || result.source, result.year, result.subtitle].filter(Boolean).join(' · ');
      copy.append(title, sub);
      card.appendChild(copy);
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'tier-button tier-button-secondary';
      add.textContent = hasCard(result) ? '已添加' : '添加';
      add.disabled = hasCard(result);
      add.addEventListener('click', () => addCard(result));
      card.appendChild(add);
      container.appendChild(card);
    });
  }

  async function performSearch() {
    const input = $('#tierSearchInput');
    const query = text(input?.value);
    const generation = ++searchGeneration;
    searchController?.abort();
    if (!query) {
      window.tierLastSearchResults = [];
      renderSearchResults([]);
      return;
    }
    const controller = new AbortController();
    searchController = controller;
    const kind = $('#tierSearchKind')?.value || 'work';
    const year = $('#tierSearchYear')?.value || '';
    const activeSources = new Set($$('.tier-source-chip.is-active').map(chip => chip.dataset.source));
    const note = $('#tierSearchNote');
    const tasks = [];
    if (activeSources.has('bangumi')) tasks.push(searchBangumi(query, kind, controller.signal));
    if (activeSources.has('cngal')) tasks.push(searchCnGal(query, kind, controller.signal));
    if (activeSources.has('vndb') && kind === 'work') tasks.push(searchVndb(query, controller.signal));
    if (!tasks.length) {
      if (note) note.textContent = '至少选择一个检索来源。';
      return;
    }
    if (note) note.textContent = '搜索结果会加入未分类素材池，不会直接修改 Tier 表。';
    const settled = await Promise.allSettled(tasks);
    if (generation !== searchGeneration || controller.signal.aborted) return;
    let results = [];
    settled.forEach(item => { if (item.status === 'fulfilled') results.push(...item.value); });
    if (year) {
      results = results.filter(item => resultYear(item) === year);
      if (note) note.textContent = '已按发售年筛选（CnGal 结果不带年份信息，已一并过滤）。';
    }
    const seen = new Set();
    const unique = results.filter(item => {
      const key = cardKey(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 30);
    window.tierLastSearchResults = unique;
    renderSearchResults(unique);
    if (!unique.length) {
      if (note) note.textContent = kind === 'character'
        ? '没有结果。角色搜索使用 Bangumi + CnGal，VNDB 角色搜索保持禁用。'
        : '没有找到结果，请换一个关键词或调整筛选。';
    }
  }

  function queueSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(performSearch, 420);
  }

  function populateYearSelect() {
    const select = $('#tierSearchYear');
    if (!select || select.options.length > 1) return;
    const currentYear = new Date().getFullYear();
    for (let year = currentYear; year >= 1995; year--) {
      const option = document.createElement('option');
      option.value = String(year);
      option.textContent = `${year} 年`;
      select.appendChild(option);
    }
  }

  /* ---------------- Bangumi collection import ---------------- */

  function openModal(id) {
    const modal = $(`#${id}`);
    if (!modal) return;
    const closeTimer = Number(modal.dataset.closeTimer || 0);
    if (closeTimer) window.clearTimeout(closeTimer);
    delete modal.dataset.closeTimer;
    modal.classList.remove('is-closing');
    modal.hidden = false;
    document.body.classList.add('tier-modal-open');
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      modal.classList.remove('is-opening');
      window.requestAnimationFrame(() => modal.classList.add('is-opening'));
      window.setTimeout(() => modal.classList.remove('is-opening'), 240);
    }
  }

  function closeModal(id) {
    const modal = $(`#${id}`);
    if (!modal || modal.hidden) return;
    const finish = () => {
      delete modal.dataset.closeTimer;
      modal.hidden = true;
      modal.classList.remove('is-closing', 'is-opening');
      if (!$$('.tier-modal-overlay:not([hidden])').length) document.body.classList.remove('tier-modal-open');
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish();
      return;
    }
    modal.classList.remove('is-opening');
    modal.classList.add('is-closing');
    modal.dataset.closeTimer = String(window.setTimeout(finish, 220));
  }

  /* ---------------- Bangumi collection import ---------------- */

  async function openBangumiImport() {
    if (!sessionUser?.id) {
      showToast('请先登录 VNFmap 账号，再导入 Bangumi 收藏', 'error');
      return;
    }
    if (!sessionUser.bangumi_bound) {
      showToast('请先在用户中心绑定 Bangumi 账号', 'error');
      window.setTimeout(() => { window.location.href = '../../user.html#social-accounts'; }, 500);
      return;
    }
    importRows.clear();
    importSelected.clear();
    importOffset = 0;
    importHasMore = true;
    $('#tierImportResults').innerHTML = '';
    $('#tierImportStatus').textContent = '正在读取 Bangumi 收藏…';
    $('#tierImportMore').hidden = true;
    updateImportCount();
    openModal('tierImportModal');
    await loadImportPage();
  }

  async function loadImportPage() {
    if (importLoading || !importHasMore) return;
    importLoading = true;
    const data = await fetchJson(`${BANGUMI_ACCOUNT_URL}?action=collections&limit=100&offset=${importOffset}`);
    importLoading = false;
    if (!data.ok || !data.success) {
      $('#tierImportStatus').textContent = data.message || 'Bangumi 收藏读取失败';
      showToast(data.message || 'Bangumi 收藏读取失败', 'error');
      return;
    }
    (data.items || []).forEach(item => {
      const id = Number(item.bangumi_id || 0);
      if (id > 0) importRows.set(id, item);
    });
    importOffset += Number(data.pagination?.limit || 100);
    importHasMore = Boolean(data.pagination?.has_more);
    renderImportRows();
    $('#tierImportStatus').textContent = `已加载 ${importRows.size} 项${importHasMore ? '，还可以继续加载' : ''}`;
    $('#tierImportMore').hidden = !importHasMore;
  }

  function renderImportRows() {
    const container = $('#tierImportResults');
    container.innerHTML = '';
    if (!importRows.size) {
      const empty = document.createElement('div');
      empty.className = 'tier-empty-state';
      empty.textContent = '没有找到 Bangumi 中标记为“看过”的游戏。';
      container.appendChild(empty);
      return;
    }
    importRows.forEach((item, id) => {
      const card = normalizeCard({
        id: `bgm_vn_${id}`,
        sourceId: `bgm_vn_${id}`,
        bangumiId: id,
        kind: 'work',
        source: 'bangumi',
        title: item.title_cn || item.title || `Bangumi #${id}`,
        image: item.image || ''
      });
      const row = document.createElement('label');
      row.className = 'tier-import-item';
      if (hasCard(card)) row.classList.add('is-existing');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = importSelected.has(id);
      checkbox.disabled = hasCard(card);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) importSelected.add(id);
        else importSelected.delete(id);
        updateImportCount();
      });
      const image = document.createElement('img');
      image.src = card.image || '';
      image.alt = '';
      image.loading = 'lazy';
      image.addEventListener('error', () => { image.style.opacity = '.25'; }, { once: true });
      const copy = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = card.title;
      const meta = document.createElement('span');
      meta.textContent = `Bangumi #${id}${item.title && item.title !== card.title ? ` · ${item.title}` : ''}`;
      copy.append(title, meta);
      row.append(checkbox, image, copy);
      container.appendChild(row);
    });
  }

  function updateImportCount() {
    const count = $('#tierImportCount');
    const confirm = $('#tierImportConfirm');
    if (count) count.textContent = String(importSelected.size);
    if (confirm) confirm.disabled = importSelected.size === 0;
  }

  function selectAllImport(value) {
    importRows.forEach((item, id) => {
      const card = normalizeCard({ id: `bgm_vn_${id}`, sourceId: `bgm_vn_${id}`, bangumiId: id, kind: 'work', source: 'bangumi', title: item.title_cn || item.title, image: item.image });
      if (!hasCard(card) && value) importSelected.add(id);
      if (!value) importSelected.delete(id);
    });
    renderImportRows();
    updateImportCount();
  }

  function confirmImport() {
    let added = 0;
    let skipped = 0;
    importSelected.forEach(id => {
      const item = importRows.get(id);
      const card = normalizeCard({ id: `bgm_vn_${id}`, sourceId: `bgm_vn_${id}`, bangumiId: id, kind: 'work', source: 'bangumi', title: item?.title_cn || item?.title || `Bangumi #${id}`, image: item?.image || '' });
      if (hasCard(card) || !addCard(card, 'unranked', { silent: true, deferRender: true })) skipped++;
      else added++;
    });
    if (added) {
      persist();
      renderAll();
    }
    closeModal('tierImportModal');
    showToast(`Bangumi 导入完成：新增 ${added} 项，跳过 ${skipped} 项`, added ? 'success' : 'error');
    importSelected.clear();
  }

  /* ---------------- Custom image ---------------- */

  function openImageModal() {
    customImageData = '';
    $('#tierImageInput').value = '';
    $('#tierCustomTitle').value = '';
    $('#tierImageConfirm').disabled = true;
    openModal('tierImageModal');
  }

  function readCustomImage(file) {
    if (!file) return;
    if (!/^image\/(?:png|jpeg|gif|webp)$/i.test(file.type) || file.size > TIER_MAX_LOCAL_IMAGE_BYTES) {
      showToast('请选择 PNG、JPEG、GIF 或 WebP，且单张不超过 8 MiB', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      customImageData = String(reader.result || '');
      $('#tierCustomTitle').value ||= file.name.replace(/\.[^.]+$/, '');
      $('#tierImageConfirm').disabled = !customImageData;
    };
    reader.readAsDataURL(file);
  }

  function confirmCustomImage() {
    if (!customImageData) return;
    const title = text($('#tierCustomTitle').value, '自定义图片');
    if (addCard({ id: uid('custom'), kind: 'custom', source: 'custom', sourceId: '', title, image: customImageData }, 'unranked')) {
      closeModal('tierImageModal');
      showToast('已添加自定义卡片');
    }
  }

  /* ---------------- Card preview ---------------- */

  function openCardPreview(card) {
    const body = $('#tierCardPreviewBody');
    if (!body) return;
    body.innerHTML = '';
    body.appendChild(makeCardElement(card, { previewOnly: true }));
    const entry = allCards().find(item => item.card.id === card.id);
    previewContext = { cardId: card.id, inUnranked: entry?.location === 'unranked' };
    const unrankButton = $('#tierPreviewUnrank');
    if (unrankButton) unrankButton.hidden = previewContext.inUnranked;
    const link = cardLink(card);
    const linkButton = $('#tierPreviewLink');
    if (linkButton) {
      linkButton.hidden = !link;
      linkButton.onclick = link ? () => window.open(link, '_blank', 'noopener,noreferrer') : null;
    }
    openModal('tierCardPreviewModal');
  }

  function unrankFromPreview() {
    if (!previewContext) return;
    if (previewContext.inUnranked) return;
    moveCard(previewContext.cardId, 'unranked');
    previewContext = null;
    closeModal('tierCardPreviewModal');
    showToast('已退回未分类');
  }

  /* ---------------- Share / files ---------------- */

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    const payload = { app: 'VNFest GalgameTool Tier', version: TIER_SCHEMA_VERSION, tier: serializeTier() };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'galgame-tier-board.json');
    showToast('Tier 表文件已导出');
  }

  function importJson(file) {
    if (!file || file.size > 15 * 1024 * 1024) {
      showToast('表文件不能超过 15 MiB', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || '{}'));
        const imported = parsed.tier || parsed.board ? normalizeTier(parsed.tier || parsed) : null;
        if (!imported) throw new Error('invalid');
        if (!window.confirm('导入会覆盖当前 Tier 表，是否继续？')) return;
        state = imported;
        persist();
        renderAll();
        showToast('Tier 表文件已导入');
      } catch (_) {
        showToast('表文件格式无效', 'error');
      }
    };
    reader.readAsText(file);
  }

  function base64UrlEncode(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlDecode(value) {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function shareTierPayload() {
    const snapshot = serializeTier();
    const slimCard = card => ({
      id: card.id, kind: card.kind, source: card.source, sourceId: card.sourceId,
      bangumiId: card.bangumiId, title: card.title, subtitle: card.subtitle
    });
    return {
      schema_version: TIER_SCHEMA_VERSION,
      board: {
        title: snapshot.board.title,
        rows: snapshot.board.rows.map(row => ({ id: row.id, label: row.label, color: row.color, cards: row.cards.map(slimCard) })),
        unranked: snapshot.board.unranked.map(slimCard)
      },
      settings: snapshot.settings
    };
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (_) {
      const input = document.createElement('textarea');
      input.value = value;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      const ok = document.execCommand('copy');
      input.remove();
      return ok;
    }
  }

  async function copyShareUrl() {
    const encoded = base64UrlEncode(JSON.stringify(shareTierPayload()));
    const url = `${location.origin}${location.pathname}#tier=${encoded}`;
    if (await copyText(url)) showToast('Tier 表结构链接已复制');
    else showToast('复制失败，请手动复制地址栏链接', 'error');
  }

  async function hydrateSharedHash() {
    const match = location.hash.match(/^#tier=([A-Za-z0-9_-]+)$/);
    if (!match) return;
    try {
      const shared = normalizeTier(JSON.parse(base64UrlDecode(match[1])));
      if (!window.confirm('发现一个 Tier 表链接，是否载入？')) return;
      state = shared;
      persist();
      showToast('已载入 Tier 表结构；链接不会携带本地图片');
    } catch (_) {
      showToast('Tier 表链接无效或已损坏', 'error');
    }
  }

  async function shareX() {
    const encoded = base64UrlEncode(JSON.stringify(shareTierPayload()));
    const url = `${location.origin}${location.pathname}#tier=${encoded}`;
    const text = `我的 Galgame Tier 表：${state.board.title}`;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Galgame Tier 表', text, url });
        showToast('已打开系统分享');
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
    }
    const shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
    const popup = window.open(shareUrl, '_blank', 'noopener,noreferrer');
    if (!popup && await copyText(url)) showToast('X 未能打开，链接已复制');
  }

  /* ---------------- Export image ---------------- */

  function setProgress(value, label) {
    const root = $('#tierExportProgress');
    const bar = $('#tierExportProgressBar');
    const valueEl = $('#tierExportProgressValue');
    const labelEl = $('#tierExportProgressLabel');
    root.classList.add('is-active');
    root.setAttribute('aria-hidden', 'false');
    bar.style.width = `${Math.max(0, Math.min(100, value))}%`;
    valueEl.textContent = `${Math.round(value)}%`;
    labelEl.textContent = label;
  }

  function finishProgress(label = '下载完成') {
    setProgress(100, label);
    window.setTimeout(() => {
      $('#tierExportProgress')?.classList.remove('is-active');
      $('#tierExportProgress')?.setAttribute('aria-hidden', 'true');
    }, 900);
  }

  function waitForImage(image) {
    if (!image || !image.src) return Promise.resolve();
    if (image.complete && image.naturalWidth > 0) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => resolve();
      image.addEventListener('load', done, { once: true });
      image.addEventListener('error', done, { once: true });
      window.setTimeout(done, 5000);
    });
  }

  /* Chromium serializes modern color functions (color-mix etc.) as
     "color(srgb r g b / a)", which html2canvas 1.4.1 cannot parse. Rewrite
     those computed values back to rgba() on the export clone. */
  function fixColorFunctions(root) {
    const props = [
      'color', 'background-color', 'border-top-color', 'border-right-color',
      'border-bottom-color', 'border-left-color', 'outline-color',
      'text-decoration-color', 'box-shadow'
    ];
    const convert = value => value.replace(/color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)/g, (_, r, g, b, a) => {
      const to255 = v => Math.round(parseFloat(v) * 255);
      return `rgba(${to255(r)},${to255(g)},${to255(b)},${a === undefined ? '1' : a})`;
    });
    const walk = el => {
      if (getComputedStyle(el).display !== 'none') {
        const cs = getComputedStyle(el);
        for (const prop of props) {
          const raw = cs.getPropertyValue(prop);
          if (raw && raw.includes('color(')) el.style.setProperty(prop, convert(raw));
        }
      }
      [...el.children].forEach(walk);
    };
    walk(root);
  }

  async function renderTierCanvas() {
    if (typeof window.html2canvas !== 'function') {
      showToast('图片渲染组件尚未加载，请刷新后重试', 'error');
      return null;
    }
    const source = $('#tierBoard');
    const host = document.createElement('div');
    host.className = 'tier-export-host';
    host.style.position = 'fixed';
    host.style.left = '-20000px';
    host.style.top = '0';
    host.style.zIndex = '-1';
    host.style.background = '#fffdf9';
    const clone = source.cloneNode(true);
    clone.removeAttribute('id');
    clone.classList.add('tier-export-mode');
    const width = Math.max(source.clientWidth, source.scrollWidth, 560);
    clone.style.width = `${width}px`;
    clone.style.maxWidth = 'none';
    clone.style.overflow = 'visible';
    host.appendChild(clone);
    // Sanitize only after mount: detached nodes have no computed document styles.
    fixColorFunctions(clone);
    document.body.appendChild(host);
    try {
      const images = $$('img', clone);
      images.forEach(image => { image.loading = 'eager'; image.crossOrigin = 'anonymous'; });
      await Promise.all(images.map(waitForImage));
      const canvas = await window.html2canvas(clone, {
        backgroundColor: '#fffdf9',
        scale: Math.min(2, window.devicePixelRatio || 1.5),
        useCORS: true,
        allowTaint: false,
        logging: false,
        width,
        height: clone.scrollHeight,
        windowWidth: width,
        windowHeight: clone.scrollHeight
      });
      return canvas;
    } finally {
      host.remove();
    }
  }

  async function exportImage() {
    setProgress(8, '准备 Tier 表');
    try {
      setProgress(28, '加载卡片图片');
      setProgress(58, '渲染 Tier 表');
      const canvas = await renderTierCanvas();
      if (!canvas) { finishProgress(); return; }
      setProgress(82, '生成 PNG');
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG conversion failed');
      setProgress(94, '准备下载');
      downloadBlob(blob, 'galgame-tier-board.png');
      finishProgress();
      showToast('Tier 表图片已保存');
    } catch (error) {
      console.warn('Tier export failed:', error);
      finishProgress('保存失败');
      showToast('图片保存失败，请确认图片加载完成后重试', 'error');
    }
  }

  async function shareToPosts() {
    const canvas = await renderTierCanvas();
    if (!canvas) return;
    if (window.VNFPostShare) {
      window.VNFPostShare.share({ canvas, defaultText: `【Tier 表】${(state.board && state.board.title) || '我的 Tier 表'} #Galgame` });
    } else {
      showToast('转发组件尚未加载，请刷新后重试', 'error');
    }
  }

  async function resetBoard() {
    if (!window.confirm('确定要重置整个 Tier 表吗？')) return;
    clearTimeout(serverSaveTimer);
    state = createDefaultTier();
    try { localStorage.removeItem(activeStorageKey); } catch (_) { /* ignore */ }
    if (cloudEnabled && sessionUser?.id) {
      const response = await fetchJson(`${TIER_API_URL}?action=reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (!response.ok || !response.success) setSyncStatus('error');
    }
    writeLocal();
    renderAll();
    setSyncStatus(cloudEnabled ? 'synced' : 'local');
    showToast('Tier 表已重置');
  }

  function showToast(message, type = 'success') {
    const toast = $('#tierToast');
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle('is-error', type === 'error');
    toast.classList.add('is-visible');
    toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
  }

  function bindEvents() {
    $('#tierBoardTitle')?.addEventListener('click', editBoardTitle);
    $$('.tier-segment').forEach(button => button.addEventListener('click', () => {
      state.settings.cardSize = button.dataset.cardSize;
      persist();
      renderAll();
    }));
    $('#tierShowTitles')?.addEventListener('click', () => { state.settings.showTitles = !state.settings.showTitles; persist(); renderAll(); });
    $('#tierAddCard')?.addEventListener('click', openTierSearch);
    $('#tierAddImage')?.addEventListener('click', openImageModal);
    $('#tierPoolImage')?.addEventListener('click', openImageModal);
    $('#tierBangumiImport')?.addEventListener('click', openBangumiImport);
    $('#tierFileExport')?.addEventListener('click', () => $('#tierJsonInput')?.click());
    $('#tierJsonInput')?.addEventListener('change', event => { importJson(event.target.files?.[0]); event.target.value = ''; });
    $('#tierCopyUrl')?.addEventListener('click', copyShareUrl);
    $('#tierShareX')?.addEventListener('click', shareX);
    $('#tierSharePosts')?.addEventListener('click', shareToPosts);
    $('#tierSaveImage')?.addEventListener('click', exportImage);
    $('#tierReset')?.addEventListener('click', resetBoard);
    $('#tierImageInput')?.addEventListener('change', event => readCustomImage(event.target.files?.[0]));
    $('#tierImageConfirm')?.addEventListener('click', confirmCustomImage);
    $('#tierImportSelectAll')?.addEventListener('click', () => selectAllImport(true));
    $('#tierImportClear')?.addEventListener('click', () => selectAllImport(false));
    $('#tierImportMore')?.addEventListener('click', loadImportPage);
    $('#tierImportConfirm')?.addEventListener('click', confirmImport);
    $('#tierPreviewUnrank')?.addEventListener('click', unrankFromPreview);
    $('#tierSearchInput')?.addEventListener('input', queueSearch);
    $('#tierSearchKind')?.addEventListener('change', performSearch);
    $('#tierSearchYear')?.addEventListener('change', performSearch);
    $$('.tier-source-chip').forEach(chip => chip.addEventListener('click', () => {
      const others = $$('.tier-source-chip').filter(item => item !== chip);
      const willActivate = !chip.classList.contains('is-active');
      if (!willActivate && others.every(item => !item.classList.contains('is-active'))) return;
      chip.classList.toggle('is-active', willActivate);
      chip.setAttribute('aria-pressed', String(willActivate));
      performSearch();
    }));
    $$('.tier-pool-tab').forEach(tab => tab.addEventListener('click', () => {
      $$('.tier-pool-tab').forEach(item => { item.classList.remove('is-active'); item.setAttribute('aria-selected', 'false'); });
      tab.classList.add('is-active');
      tab.setAttribute('aria-selected', 'true');
      const search = tab.dataset.poolTab === 'search';
      $('#tierSearchPanel').hidden = !search;
      $('#tierUnrankedPanel').hidden = search;
    }));
    $$('.tier-modal-overlay').forEach(overlay => overlay.addEventListener('click', event => {
      if (event.target === overlay) closeModal(overlay.id);
    }));
    $$('[data-tier-close-modal]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.tierCloseModal)));
    document.addEventListener('click', event => {
      const pop = $('#tierColorPop');
      if (pop && !pop.hidden && !event.target.closest('#tierColorPop') && !event.target.closest('.tier-row-color')) closeColorPop();
    });
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        closeColorPop();
        $$('.tier-modal-overlay:not([hidden])').forEach(overlay => closeModal(overlay.id));
      }
    });
    window.addEventListener('vnfest-tool-viewchange', event => {
      if (event.detail === 'tier') window.requestAnimationFrame(() => renderAll());
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    populateYearSelect();
    bindEvents();
    await bootstrap();
  });
})();
