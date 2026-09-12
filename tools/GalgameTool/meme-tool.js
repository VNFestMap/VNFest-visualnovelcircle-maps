/* GalgameTool MEME board. This page deliberately keeps its data domain
   separate from the resume editor while reusing the same first-party APIs. */
(() => {
  'use strict';

  const MEME_SCHEMA_VERSION = 1;
  const MEME_MAX_CELLS = 120;
  const MEME_MAX_CARDS_PER_LIST = 100;
  const MEME_MAX_LOCAL_IMAGE_BYTES = 8 * 1024 * 1024;
  const MEME_STORAGE_GUEST = 'vnfest_galgame_meme_data:guest';
  const MEME_STORAGE_PREFIX = 'vnfest_galgame_meme_data:user:';
  const MEME_STORAGE_BACKUP_SUFFIX = ':backup';
  const MEME_MIGRATION_PROMPT_SUFFIX = ':migration-prompted';
  const LEGACY_RESUME_PREFIX = 'bishoujo_resume_data:user:';
  const LEGACY_RESUME_GUEST = 'bishoujo_resume_data:guest';
  const MEME_API_URL = new URL('../../api/galgame_meme.php', document.baseURI).href;
  const AUTH_API_URL = new URL('../../api/auth.php', document.baseURI).href;
  const RESUME_API_URL = new URL('../../api/galgame_resume.php', document.baseURI).href;
  const BANGUMI_PROXY_URL = new URL('../../api/bangumi_proxy.php', document.baseURI).href;
  const BANGUMI_ACCOUNT_URL = new URL('../../api/bangumi_account.php', document.baseURI).href;
  const VNDB_PROXY_URL = new URL('../../api/vndb_proxy.php', document.baseURI).href;
  const IMAGE_PROXY_URL = new URL('../../api/image_proxy.php', document.baseURI).href;
  const IMAGE_PROXY_HOSTS = new Set([
    'lain.bgm.tv', 't.vndb.org', 's.vndb.org', 'tucang.cngal.top', 'image.cngal.org'
  ]);

  const DEFAULT_LABELS = [
    '最喜欢的作品', '最佳动作', '喜欢的画风', '最佳剧本',
    '最令人印象深刻', '最喜欢的路线', '喜欢恋爱描写', '最佳喜剧',
    '评价不高但我喜欢', '我认为被高估了', '没有打动我', '喜欢的 BGM',
    '喜欢的氛围', '喜欢的女主角', '喜欢的主人公', '舒适的 UI',
    '最失望的作品', '最初接触的作品', '不是最棒但很有趣', '不起眼但我喜欢',
    '最佳致郁/催泪作', '喜欢的系列', '期待接下来玩的作品', '平时不玩但喜欢'
  ];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  let state = createDefaultMeme();
  let sessionUser = null;
  let activeStorageKey = MEME_STORAGE_GUEST;
  let cloudEnabled = false;
  let serverLoadPending = true;
  let serverSaveTimer = null;
  let serverSaveInFlight = false;
  let serverSaveQueued = false;
  let searchController = null;
  let searchTimer = null;
  let searchGeneration = 0;
  let pendingCellId = null;
  let draggedCardId = null;
  let pointerDrag = null;
  let suppressNextClickId = null;
  const removingCards = new Set();
  let toastTimer = null;
  let importOffset = 0;
  let importHasMore = false;
  let importLoading = false;
  const importRows = new Map();
  const importSelected = new Set();
  let customImageData = '';

  function uid(prefix = 'meme') {
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

  function defaultCell(index) {
    return { id: `cell-${index + 1}`, title: DEFAULT_LABELS[index] || `自定义分类 ${index + 1}`, cards: [] };
  }

  function createDefaultMeme() {
    return {
      schema_version: MEME_SCHEMA_VERSION,
      board: {
        title: 'Galgame MEME',
        colsMode: 'fixed',
        cols: 6,
        rows: 4,
        cells: DEFAULT_LABELS.map((_, index) => defaultCell(index)),
        unranked: []
      },
      settings: { cardSize: 'md', showTitles: true, showPopup: true }
    };
  }

  function isLegacyDefaultBoard(board, rawCells) {
    if (!board || board.colsMode !== 'auto' || Number(board.cols) !== 2 || Number(board.rows) !== 12) return false;
    if (!Array.isArray(rawCells) || rawCells.length !== DEFAULT_LABELS.length) return false;
    return rawCells.every((cell, index) => {
      if (!cell || typeof cell !== 'object') return false;
      const title = text(cell.title, DEFAULT_LABELS[index]);
      return title === DEFAULT_LABELS[index] && (!Array.isArray(cell.cards) || cell.cards.length === 0);
    });
  }

  function normalizeCard(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title = text(raw.title || raw.name);
    if (!title) return null;
    const kind = ['work', 'character', 'custom'].includes(raw.kind) ? raw.kind : (raw.cv ? 'character' : 'work');
    const source = ['bangumi', 'cngal', 'resume', 'custom'].includes(raw.source) ? raw.source : 'custom';
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

  function normalizeCell(raw, index) {
    const fallback = defaultCell(index);
    const cards = Array.isArray(raw?.cards) ? raw.cards.map(normalizeCard).filter(Boolean).slice(0, MEME_MAX_CARDS_PER_LIST) : [];
    return {
      id: text(raw?.id, fallback.id),
      title: text(raw?.title, fallback.title),
      cards
    };
  }

  function normalizeMeme(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const sourceBoard = source.board && typeof source.board === 'object' ? source.board : source;
    const sourceSettings = source.settings && typeof source.settings === 'object' ? source.settings : {};
    const result = createDefaultMeme();
    const rawCells = Array.isArray(sourceBoard.cells) ? sourceBoard.cells : [];
    const legacyDefault = isLegacyDefaultBoard(sourceBoard, rawCells);
    result.board.title = text(sourceBoard.title, result.board.title).slice(0, 80);
    result.board.colsMode = legacyDefault ? 'fixed' : (sourceBoard.colsMode === 'fixed' ? 'fixed' : (sourceBoard.colsMode === 'auto' ? 'auto' : 'fixed'));
    result.board.cols = legacyDefault ? 6 : Math.max(1, Math.min(6, Number(sourceBoard.cols) || 6));
    const maxRows = Math.min(30, Math.floor(120 / (result.board.colsMode === 'fixed' ? result.board.cols : 6)));
    result.board.rows = legacyDefault ? 4 : Math.max(1, Math.min(maxRows, Number(sourceBoard.rows) || 4));
    if (rawCells.length) {
      result.board.cells = rawCells.slice(0, MEME_MAX_CELLS).map(normalizeCell);
    }
    result.board.unranked = Array.isArray(sourceBoard.unranked)
      ? sourceBoard.unranked.map(normalizeCard).filter(Boolean).slice(0, MEME_MAX_CARDS_PER_LIST)
      : [];
    result.settings.cardSize = ['sm', 'md', 'lg'].includes(sourceSettings.cardSize) ? sourceSettings.cardSize : 'md';
    result.settings.showTitles = sourceSettings.showTitles !== false;
    result.settings.showPopup = sourceSettings.showPopup !== false;
    ensureCellCount(result.board.cells.length || 24, result);
    return result;
  }

  function ensureCellCount(count, target = state) {
    const board = target.board;
    const safeCount = Math.max(1, Math.min(MEME_MAX_CELLS, Number(count) || 24));
    while (board.cells.length > safeCount) {
      const removed = board.cells.pop();
      if (removed?.cards?.length) board.unranked.push(...removed.cards);
    }
    while (board.cells.length < safeCount) board.cells.push(defaultCell(board.cells.length));
    board.unranked = board.unranked.slice(0, MEME_MAX_CARDS_PER_LIST);
  }

  function serializeMeme() {
    return normalizeMeme(state);
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
      localStorage.setItem(activeStorageKey, JSON.stringify(serializeMeme()));
    } catch (error) {
      console.warn('MEME local save failed:', error);
      showToast('本机空间不足，云端同步仍会继续尝试', 'error');
    }
  }

  function writeLocalBackup(value) {
    if (!value) return;
    try {
      localStorage.setItem(`${activeStorageKey}${MEME_STORAGE_BACKUP_SUFFIX}`, JSON.stringify(normalizeMeme(value)));
    } catch (_) {
      // A backup is best-effort; the active local draft must remain unaffected.
    }
  }

  function setSyncStatus(status) {
    const el = $('#memeSyncStatus');
    if (!el) return;
    const labels = {
      loading: '正在加载 MEME 看板',
      local: '本机保存',
      syncing: '正在同步',
      synced: '已同步',
      error: '同步失败，已保留本机看板'
    };
    el.dataset.state = status;
    el.textContent = labels[status] || labels.local;
    el.title = sessionUser?.username ? `当前账号：${sessionUser.username}` : '未登录，仅保存到本机';
  }

  async function saveServer() {
    if (!cloudEnabled || !sessionUser?.id) return false;
    const response = await fetchJson(`${MEME_API_URL}?action=save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meme: serializeMeme() })
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

  async function loadResumeSource() {
    let resume = null;
    if (sessionUser?.id) {
      const remote = await fetchJson(`${RESUME_API_URL}?action=load`);
      if (remote.ok && remote.success && remote.resume) resume = remote.resume;
    }
    if (!resume) {
      resume = readLocal(sessionUser?.id ? `${LEGACY_RESUME_PREFIX}${sessionUser.id}` : LEGACY_RESUME_GUEST);
    }
    const profile = resume?.profile;
    const rows = [];
    if (Array.isArray(profile?.works)) rows.push(...profile.works.map(item => ({ ...item, kind: 'work', source: item.source || 'resume' })));
    if (Array.isArray(profile?.heroines)) rows.push(...profile.heroines.map(item => ({ ...item, kind: 'character', source: item.source || 'resume', subtitle: item.cv ? `CV ${item.cv}` : '' })));
    return rows.map(normalizeCard).filter(Boolean);
  }

  async function bootstrap() {
    const auth = await fetchJson(`${AUTH_API_URL}?action=me`);
    if (auth.logged_in && auth.user?.id) {
      sessionUser = auth.user;
      activeStorageKey = `${MEME_STORAGE_PREFIX}${sessionUser.id}`;
      cloudEnabled = true;
    } else {
      sessionUser = null;
      activeStorageKey = MEME_STORAGE_GUEST;
      cloudEnabled = false;
    }

    const local = readLocal(activeStorageKey);
    if (!sessionUser && !local) {
      const legacy = readLocal('bishoujo_resume_meme_data:guest');
      if (legacy) state = normalizeMeme(legacy);
    } else if (local) {
      state = normalizeMeme(local);
    }

    let initialSyncStatus = cloudEnabled ? 'synced' : 'local';
    if (cloudEnabled) {
      const remote = await fetchJson(`${MEME_API_URL}?action=load`);
      if (remote.ok && remote.success && remote.meme) {
        if (local) writeLocalBackup(local);
        state = normalizeMeme(remote.meme);
      } else if (remote.ok && remote.success && !remote.meme && local) {
        let prompted = false;
        try { prompted = localStorage.getItem(`${activeStorageKey}${MEME_MIGRATION_PROMPT_SUFFIX}`) === '1'; } catch (_) { /* ignore */ }
        if (!prompted) {
          try { localStorage.setItem(`${activeStorageKey}${MEME_MIGRATION_PROMPT_SUFFIX}`, '1'); } catch (_) { /* ignore */ }
          if (window.confirm('发现本机 MEME 看板，是否上传到当前账号？')) {
            await saveServer();
          } else {
            writeLocalBackup(local);
            state = createDefaultMeme();
          }
        } else {
          state = createDefaultMeme();
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

  function allCards() {
    const result = [];
    state.board.cells.forEach(cell => cell.cards.forEach(card => result.push({ card, location: cell.id })));
    state.board.unranked.forEach(card => result.push({ card, location: 'unranked' }));
    return result;
  }

  function cardKey(card) {
    if (!card) return '';
    if (card.bangumiId) return `bangumi:${card.bangumiId}`;
    if (card.sourceId) return `${card.source}:${card.sourceId}`;
    return `${card.source}:${card.title}:${card.image || ''}`.toLowerCase();
  }

  function hasCard(card) {
    const key = cardKey(card);
    return !!key && allCards().some(entry => cardKey(entry.card) === key);
  }

  function takeCard(cardId) {
    for (const cell of state.board.cells) {
      const index = cell.cards.findIndex(card => card.id === cardId);
      if (index >= 0) return cell.cards.splice(index, 1)[0];
    }
    const index = state.board.unranked.findIndex(card => card.id === cardId);
    if (index >= 0) return state.board.unranked.splice(index, 1)[0];
    return null;
  }

  function addCard(raw, targetCellId = pendingCellId, options = {}) {
    const { silent = false, deferRender = false } = options;
    const card = normalizeCard(raw);
    if (!card) return false;
    if (hasCard(card)) {
      if (!silent) showToast('这张卡片已经在素材池或看板中', 'error');
      return false;
    }
    const target = targetCellId && state.board.cells.find(cell => cell.id === targetCellId);
    const destination = target ? target.cards : state.board.unranked;
    if (destination.length >= MEME_MAX_CARDS_PER_LIST) {
      if (!silent) showToast(`每个素材列表最多保存 ${MEME_MAX_CARDS_PER_LIST} 项`, 'error');
      return false;
    }
    destination.push(card);
    pendingCellId = null;
    if (!deferRender) {
      persist();
      renderAll();
    }
    return true;
  }

  function moveCard(cardId, targetCellId) {
    const entry = allCards().find(item => item.card.id === cardId);
    if (!entry || entry.location === targetCellId) return;
    const target = targetCellId === 'unranked' ? null : state.board.cells.find(cell => cell.id === targetCellId);
    const destination = target ? target.cards : state.board.unranked;
    if (destination.length >= MEME_MAX_CARDS_PER_LIST) {
      showToast(`每个素材列表最多保存 ${MEME_MAX_CARDS_PER_LIST} 项`, 'error');
      return;
    }
    const card = takeCard(cardId);
    if (!card) return;
    if (target) target.cards.push(card);
    else state.board.unranked.push(card);
    persist();
    renderAll();
  }

  function moveCardByKeyboard(cardId, key) {
    const entry = allCards().find(item => item.card.id === cardId);
    if (!entry) return;
    const currentIndex = entry.location === 'unranked'
      ? 0
      : Math.max(0, state.board.cells.findIndex(cell => cell.id === entry.location) + 1);
    const visibleCols = Math.max(1, Number.parseInt(getComputedStyle($('#memeGrid')).getPropertyValue('--meme-cols'), 10) || 1);
    const delta = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : key === 'ArrowUp' ? -visibleCols : visibleCols;
    const nextIndex = Math.max(0, Math.min(state.board.cells.length, currentIndex + delta));
    if (nextIndex === currentIndex) return;
    const targetCellId = nextIndex === 0 ? 'unranked' : state.board.cells[nextIndex - 1].id;
    moveCard(cardId, targetCellId);
    window.setTimeout(() => $$('.meme-card').find(element => element.dataset.cardId === cardId)?.focus(), 0);
  }

  function pointerDropLocation(x, y) {
    const target = document.elementFromPoint(x, y);
    const cell = target?.closest?.('.meme-cell');
    if (cell?.dataset.cellId) return cell.dataset.cellId;
    const pool = target?.closest?.('#memeUnrankedPanel');
    if (pool && !pool.hidden) return 'unranked';
    return null;
  }

  function clearPointerDrag() {
    if (!pointerDrag) return;
    try { pointerDrag.item.releasePointerCapture(pointerDrag.pointerId); } catch (_) { /* ignore */ }
    pointerDrag.item.classList.remove('is-pointer-dragging');
    $$('.is-drag-over').forEach(element => element.classList.remove('is-drag-over'));
    pointerDrag = null;
  }

  function handlePointerDown(event, item, card) {
    if (!event.isPrimary || event.pointerType === 'mouse' || event.target.closest('.meme-card-remove')) return;
    pointerDrag = {
      cardId: card.id,
      item,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      targetCellId: null
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
    const location = pointerDropLocation(event.clientX, event.clientY);
    pointerDrag.targetCellId = location;
    $$('.is-drag-over').forEach(element => element.classList.remove('is-drag-over'));
    if (location) {
      const target = location === 'unranked'
        ? $('#memeUnrankedPanel')
        : $(`.meme-cell[data-cell-id="${CSS.escape(location)}"]`);
      target?.classList.add('is-drag-over');
    }
  }

  function handlePointerUp(event) {
    if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
    const drag = pointerDrag;
    if (drag.started && drag.targetCellId) moveCard(drag.cardId, drag.targetCellId);
    clearPointerDrag();
  }

  function removeCard(cardId) {
    if (removingCards.has(cardId)) return;
    const item = $(`.meme-card[data-card-id="${CSS.escape(cardId)}"]`);
    const commit = () => {
      removingCards.delete(cardId);
      if (!takeCard(cardId)) return;
      persist();
      renderAll();
      showToast('已从 MEME 看板移除');
    };
    if (!item || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      commit();
      return;
    }
    removingCards.add(cardId);
    item.classList.add('is-card-leaving');
    window.setTimeout(commit, 180);
  }

  function makeImage(image, alt, kind) {
    const media = document.createElement('div');
    media.className = 'meme-card-media';
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

  function makeCardElement(card) {
    const item = document.createElement('article');
    item.className = 'meme-card';
    item.classList.add('is-card-entering');
    item.dataset.cardId = card.id;
    item.dataset.kind = card.kind;
    item.draggable = true;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `${card.title}，拖拽、按 Enter 预览，方向键移动`);
    item.setAttribute('aria-keyshortcuts', 'Enter Space ArrowLeft ArrowRight ArrowUp ArrowDown');
    item.appendChild(makeImage(card.image, card.title, card.kind));
    if (state.settings.showTitles) {
      const label = document.createElement('span');
      label.className = 'meme-card-label';
      label.textContent = card.title;
      item.appendChild(label);
    }
    const remove = document.createElement('button');
    remove.className = 'meme-card-remove';
    remove.type = 'button';
    remove.title = '移除卡片';
    remove.setAttribute('aria-label', `移除 ${card.title}`);
    remove.textContent = '×';
    remove.addEventListener('click', event => {
      event.stopPropagation();
      removeCard(card.id);
    });
    item.appendChild(remove);
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
    item.addEventListener('pointerdown', event => handlePointerDown(event, item, card));
    item.addEventListener('pointermove', handlePointerMove, { passive: false });
    item.addEventListener('pointerup', handlePointerUp);
    item.addEventListener('pointercancel', clearPointerDrag);
    item.addEventListener('click', event => {
      if (event.target.closest('.meme-card-remove') || !state.settings.showPopup) return;
      if (suppressNextClickId === card.id) {
        suppressNextClickId = null;
        return;
      }
      openCardPreview(card);
    });
    item.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && state.settings.showPopup) {
        event.preventDefault();
        openCardPreview(card);
      } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        moveCardByKeyboard(card.id, event.key);
      }
    });
    return item;
  }

  function renderGrid() {
    const board = $('#memeBoard');
    const grid = $('#memeGrid');
    if (!board || !grid) return;
    const available = Math.max(260, board.clientWidth - 48);
    const minWidths = { sm: 84, md: 112, lg: 148 };
    const autoCols = Math.max(1, Math.min(6, Math.floor((available + 10) / (minWidths[state.settings.cardSize] + 10))));
    const cols = state.board.colsMode === 'fixed' ? state.board.cols : autoCols;
    grid.style.setProperty('--meme-cols', String(cols));
    board.dataset.gridMode = state.board.colsMode;
    board.dataset.cardSize = state.settings.cardSize;
    grid.innerHTML = '';
    state.board.cells.forEach(cell => {
      const cellEl = document.createElement('section');
      cellEl.className = 'meme-cell';
      cellEl.dataset.cellId = cell.id;
      cellEl.tabIndex = 0;
      cellEl.setAttribute('aria-label', `${cell.title}分类格`);
      const head = document.createElement('div');
      head.className = 'meme-cell-head';
      const title = document.createElement('button');
      title.type = 'button';
      title.className = 'meme-cell-title';
      title.textContent = cell.title;
      title.title = '点击编辑分类标题';
      title.addEventListener('click', () => editCellTitle(cell.id));
      head.appendChild(title);
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'meme-cell-add';
      add.textContent = '+';
      add.title = '向此格添加卡片';
      add.setAttribute('aria-label', `向${cell.title}添加卡片`);
      add.addEventListener('click', () => openSearchForCell(cell.id));
      head.appendChild(add);
      cellEl.appendChild(head);
      const cards = document.createElement('div');
      cards.className = 'meme-cell-cards';
      if (!cell.cards.length) {
        const empty = document.createElement('div');
        empty.className = 'meme-cell-empty';
        empty.textContent = '拖入卡片';
        cards.appendChild(empty);
      } else {
        cell.cards.forEach(card => cards.appendChild(makeCardElement(card)));
      }
      cellEl.appendChild(cards);
      installDropTarget(cellEl, cell.id);
      grid.appendChild(cellEl);
    });
  }

  function renderUnranked() {
    const container = $('#memeUnrankedGrid');
    const count = $('#memeUnrankedCount');
    if (!container) return;
    if (count) count.textContent = String(state.board.unranked.length);
    container.innerHTML = '';
    if (!state.board.unranked.length) {
      const empty = document.createElement('div');
      empty.className = 'meme-empty-state';
      empty.textContent = '素材池为空。可以搜索作品、角色，或从履历书载入素材。';
      container.appendChild(empty);
    } else {
      state.board.unranked.forEach(card => container.appendChild(makeCardElement(card)));
    }
    installDropTarget($('#memeUnrankedPanel'), 'unranked');
  }

  function renderAll() {
    const title = $('#memeBoardTitle');
    if (title) title.textContent = state.board.title;
    const workspace = $('#memeView');
    if (workspace) workspace.dataset.cardSize = state.settings.cardSize;
    $$('.meme-segment').forEach(button => {
      const selected = button.dataset.cardSize === state.settings.cardSize;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    $('#memeShowTitles')?.classList.toggle('is-active', state.settings.showTitles);
    $('#memeShowPopup')?.classList.toggle('is-active', state.settings.showPopup);
    $('#memeShowTitles')?.setAttribute('aria-pressed', String(state.settings.showTitles));
    $('#memeShowPopup')?.setAttribute('aria-pressed', String(state.settings.showPopup));
    const colsValue = $('#memeColsValue');
    if (colsValue) {
      colsValue.textContent = state.board.colsMode === 'fixed' ? `${state.board.cols} 列` : '自动';
      colsValue.title = state.board.colsMode === 'fixed' ? '点击切换到自动列数' : '点击切换到固定列数';
      colsValue.setAttribute('aria-label', state.board.colsMode === 'fixed'
        ? `固定 ${state.board.cols} 列，点击切换自动列数`
        : '自动列数，点击切换固定列数');
    }
    const rowsValue = $('#memeRowsValue');
    if (rowsValue) {
      rowsValue.textContent = `${state.board.rows} 行`;
      rowsValue.setAttribute('aria-label', `当前 ${state.board.rows} 行`);
    }
    const maxRows = Math.min(30, Math.floor(MEME_MAX_CELLS / (state.board.colsMode === 'fixed' ? state.board.cols : 6)));
    const updateGridButton = (id, disabled, enabledTitle, disabledTitle) => {
      const button = $(`#${id}`);
      if (!button) return;
      button.disabled = disabled;
      button.title = disabled ? disabledTitle : enabledTitle;
    };
    updateGridButton('memeColsDown', state.board.colsMode === 'fixed' && state.board.cols <= 1, '减少列数', '已是最少列数');
    updateGridButton('memeColsUp', state.board.colsMode === 'fixed' && state.board.cols >= 6, '增加列数', '已是最多列数');
    updateGridButton('memeRowsDown', state.board.rows <= 1, '减少行数', '已是最少行数');
    updateGridButton('memeRowsUp', state.board.rows >= maxRows, '增加行数', '已达到当前列数允许的最多行数');
    renderGrid();
    renderUnranked();
    renderSearchResults();
  }

  function installDropTarget(element, location) {
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
      if (id) moveCard(id, location);
    });
  }

  function editCellTitle(cellId) {
    const cell = state.board.cells.find(item => item.id === cellId);
    if (!cell) return;
    const value = window.prompt('编辑分类标题', cell.title);
    if (value === null) return;
    const title = text(value).slice(0, 80);
    if (!title) return;
    cell.title = title;
    persist();
    renderAll();
  }

  function editBoardTitle() {
    const value = window.prompt('编辑看板标题', state.board.title);
    if (value === null) return;
    const title = text(value).slice(0, 80);
    if (!title) return;
    state.board.title = title;
    persist();
    renderAll();
  }

  function openSearchForCell(cellId) {
    pendingCellId = cellId;
    $('#memeSearchInput')?.focus();
    document.querySelector('[data-pool-tab="search"]')?.click();
    showToast('搜索结果会直接加入当前分类格');
  }

  function renderSearchResults(results = window.memeLastSearchResults || []) {
    const container = $('#memeSearchResults');
    if (!container) return;
    window.memeLastSearchResults = results;
    container.innerHTML = '';
    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'meme-empty-state';
      empty.textContent = $('#memeSearchInput')?.value.trim() ? '没有找到可用结果。' : '输入关键词开始搜索，或从履历书载入已有作品和角色。';
      container.appendChild(empty);
      return;
    }
    results.forEach(result => {
      const card = document.createElement('article');
      card.className = 'meme-pool-result';
      if (hasCard(result)) card.classList.add('is-added');
      card.appendChild(makeImage(result.image, result.title, result.kind));
      const media = card.firstElementChild;
      media.className = 'meme-pool-result-media';
      const copy = document.createElement('div');
      copy.className = 'meme-pool-result-copy';
      const title = document.createElement('strong');
      title.textContent = result.title;
      const sub = document.createElement('span');
      sub.textContent = [result.sourceLabel || result.source, result.subtitle || result.sub || ''].filter(Boolean).join(' · ');
      copy.append(title, sub);
      card.appendChild(copy);
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'meme-button meme-button-secondary';
      add.textContent = hasCard(result) ? '已添加' : '添加';
      add.disabled = hasCard(result);
      add.addEventListener('click', () => addCard(result));
      card.appendChild(add);
      container.appendChild(card);
    });
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
        subtitle: character ? (item.cv ? `CV ${item.cv}` : text(item.name, '')) : text(item.title, '')
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
        subtitle: text(entry.briefIntroduction, '')
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
      subtitle: text(item.brand || item.release_year, '')
    }));
  }

  async function performSearch() {
    const input = $('#memeSearchInput');
    const query = text(input?.value);
    const generation = ++searchGeneration;
    searchController?.abort();
    if (!query) {
      window.memeLastSearchResults = [];
      renderSearchResults([]);
      return;
    }
    const controller = new AbortController();
    searchController = controller;
    const kind = $('#memeSearchKind')?.value || 'work';
    const source = $('#memeSearchSource')?.value || 'all';
    const tasks = [];
    if (source === 'all' || source === 'bangumi') tasks.push(searchBangumi(query, kind, controller.signal));
    if (source === 'all' || source === 'cngal') tasks.push(searchCnGal(query, kind, controller.signal));
    if ((source === 'all' || source === 'vndb') && kind === 'work') tasks.push(searchVndb(query, controller.signal));
    const settled = await Promise.allSettled(tasks);
    if (generation !== searchGeneration || controller.signal.aborted) return;
    const results = [];
    settled.forEach(item => { if (item.status === 'fulfilled') results.push(...item.value); });
    const seen = new Set();
    const unique = results.filter(item => {
      const key = cardKey(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 30);
    window.memeLastSearchResults = unique;
    renderSearchResults(unique);
    if (!unique.length) $('#memeSearchNote').textContent = kind === 'character'
      ? '没有结果。角色搜索使用 Bangumi + CnGal，VNDB 角色 API 保持禁用。'
      : '没有找到结果，请换一个关键词。';
  }

  function queueSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(performSearch, 420);
  }

  async function loadResumeIntoPool() {
    const rows = await loadResumeSource();
    let added = 0;
    rows.forEach(card => { if (addCard(card, '', { silent: true, deferRender: true })) added++; });
    if (added) {
      persist();
      renderAll();
    }
    showToast(added ? `已载入 ${added} 张履历素材` : '履历书中没有可载入的新作品或角色', added ? 'success' : 'error');
  }

  function openModal(id) {
    const modal = $(`#${id}`);
    if (!modal) return;
    const closeTimer = Number(modal.dataset.closeTimer || 0);
    if (closeTimer) window.clearTimeout(closeTimer);
    delete modal.dataset.closeTimer;
    modal.classList.remove('is-closing');
    modal.hidden = false;
    document.body.classList.add('meme-modal-open');
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
      if (!$$('.meme-modal-overlay:not([hidden])').length) document.body.classList.remove('meme-modal-open');
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish();
      return;
    }
    modal.classList.remove('is-opening');
    modal.classList.add('is-closing');
    modal.dataset.closeTimer = String(window.setTimeout(finish, 220));
  }

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
    $('#memeImportResults').innerHTML = '';
    $('#memeImportStatus').textContent = '正在读取 Bangumi 收藏…';
    $('#memeImportMore').hidden = true;
    updateImportCount();
    openModal('memeImportModal');
    await loadImportPage();
  }

  async function loadImportPage() {
    if (importLoading || !importHasMore) return;
    importLoading = true;
    const data = await fetchJson(`${BANGUMI_ACCOUNT_URL}?action=collections&limit=100&offset=${importOffset}`);
    importLoading = false;
    if (!data.ok || !data.success) {
      $('#memeImportStatus').textContent = data.message || 'Bangumi 收藏读取失败';
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
    $('#memeImportStatus').textContent = `已加载 ${importRows.size} 项${importHasMore ? '，还可以继续加载' : ''}`;
    $('#memeImportMore').hidden = !importHasMore;
  }

  function renderImportRows() {
    const container = $('#memeImportResults');
    container.innerHTML = '';
    if (!importRows.size) {
      const empty = document.createElement('div');
      empty.className = 'meme-empty-state';
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
      row.className = 'meme-import-item';
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
    const count = $('#memeImportCount');
    const confirm = $('#memeImportConfirm');
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
    let capacitySkipped = 0;
    importSelected.forEach(id => {
      const item = importRows.get(id);
      const card = normalizeCard({ id: `bgm_vn_${id}`, sourceId: `bgm_vn_${id}`, bangumiId: id, kind: 'work', source: 'bangumi', title: item?.title_cn || item?.title || `Bangumi #${id}`, image: item?.image || '' });
      if (hasCard(card)) {
        skipped++;
      } else if (state.board.unranked.length >= MEME_MAX_CARDS_PER_LIST) {
        skipped++;
        capacitySkipped++;
      } else if (addCard(card, '', { silent: true, deferRender: true })) {
        added++;
      } else {
        skipped++;
      }
    });
    if (added) {
      persist();
      renderAll();
    }
    closeModal('memeImportModal');
    const suffix = capacitySkipped ? `，素材池已达到 ${MEME_MAX_CARDS_PER_LIST} 项上限` : '';
    showToast(`Bangumi 导入完成：新增 ${added} 项，跳过 ${skipped} 项${suffix}`, capacitySkipped ? 'error' : 'success');
    importSelected.clear();
  }

  function openImageModal() {
    customImageData = '';
    $('#memeImageInput').value = '';
    $('#memeCustomTitle').value = '';
    $('#memeImageConfirm').disabled = true;
    openModal('memeImageModal');
  }

  function readCustomImage(file) {
    if (!file) return;
    if (!/^image\/(?:png|jpeg|gif|webp)$/i.test(file.type) || file.size > MEME_MAX_LOCAL_IMAGE_BYTES) {
      showToast('请选择 PNG、JPEG、GIF 或 WebP，且单张不超过 8 MiB', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      customImageData = String(reader.result || '');
      $('#memeCustomTitle').value ||= file.name.replace(/\.[^.]+$/, '');
      $('#memeImageConfirm').disabled = !customImageData;
    };
    reader.readAsDataURL(file);
  }

  function confirmCustomImage() {
    if (!customImageData) return;
    const title = text($('#memeCustomTitle').value, '自定义图片');
    if (addCard({ id: uid('custom'), kind: 'custom', source: 'custom', sourceId: '', title, image: customImageData }, pendingCellId)) {
      closeModal('memeImageModal');
      showToast('已添加自定义卡片');
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    const payload = { app: 'VNFest GalgameTool MEME', version: MEME_SCHEMA_VERSION, meme: serializeMeme() };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'galgame-meme-board.json');
    showToast('看板文件已导出');
  }

  function importJson(file) {
    if (!file || file.size > 15 * 1024 * 1024) {
      showToast('看板文件不能超过 15 MiB', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || '{}'));
        const imported = parsed.meme || parsed.board ? normalizeMeme(parsed.meme || parsed) : null;
        if (!imported) throw new Error('invalid');
        if (!window.confirm('导入会覆盖当前 MEME 看板，是否继续？')) return;
        state = imported;
        persist();
        renderAll();
        showToast('看板文件已导入');
      } catch (_) {
        showToast('看板文件格式无效', 'error');
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

  function shareMemePayload() {
    const snapshot = serializeMeme();
    const slimCard = card => ({
      id: card.id, kind: card.kind, source: card.source, sourceId: card.sourceId,
      bangumiId: card.bangumiId, title: card.title, subtitle: card.subtitle
    });
    const payload = {
      schema_version: MEME_SCHEMA_VERSION,
      board: {
        title: snapshot.board.title,
        colsMode: snapshot.board.colsMode,
        cols: snapshot.board.cols,
        rows: snapshot.board.rows,
        cells: snapshot.board.cells.map(cell => ({ id: cell.id, title: cell.title, cards: cell.cards.map(slimCard) })),
        unranked: snapshot.board.unranked.map(slimCard)
      },
      settings: snapshot.settings
    };
    return payload;
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
    const encoded = base64UrlEncode(JSON.stringify(shareMemePayload()));
    const url = `${location.origin}${location.pathname}#meme=${encoded}`;
    if (await copyText(url)) showToast('看板结构链接已复制');
    else showToast('复制失败，请手动复制地址栏链接', 'error');
  }

  async function hydrateSharedHash() {
    const match = location.hash.match(/^#meme=([A-Za-z0-9_-]+)$/);
    if (!match) return;
    try {
      const shared = normalizeMeme(JSON.parse(base64UrlDecode(match[1])));
      if (!window.confirm('发现一个 MEME 看板链接，是否载入？')) return;
      state = shared;
      persist();
      showToast('已载入看板结构；链接不会携带本地图片');
    } catch (_) {
      showToast('看板链接无效或已损坏', 'error');
    }
  }

  async function shareX() {
    const encoded = base64UrlEncode(JSON.stringify(shareMemePayload()));
    const url = `${location.origin}${location.pathname}#meme=${encoded}`;
    const text = `我的 Galgame MEME 看板：${state.board.title}`;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Galgame MEME', text, url });
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

  function setProgress(value, label) {
    const root = $('#memeExportProgress');
    const bar = $('#memeExportProgressBar');
    const valueEl = $('#memeExportProgressValue');
    const labelEl = $('#memeExportProgressLabel');
    root.classList.add('is-active');
    root.setAttribute('aria-hidden', 'false');
    bar.style.width = `${Math.max(0, Math.min(100, value))}%`;
    valueEl.textContent = `${Math.round(value)}%`;
    labelEl.textContent = label;
  }

  function finishProgress(label = '下载完成') {
    setProgress(100, label);
    window.setTimeout(() => {
      $('#memeExportProgress')?.classList.remove('is-active');
      $('#memeExportProgress')?.setAttribute('aria-hidden', 'true');
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

  async function renderMemeCanvas() {
    if (typeof window.html2canvas !== 'function') {
      showToast('图片渲染组件尚未加载，请刷新后重试', 'error');
      return null;
    }
    const source = $('#memeBoard');
    const host = document.createElement('div');
    host.className = 'meme-export-host';
    host.style.position = 'fixed';
    host.style.left = '-20000px';
    host.style.top = '0';
    host.style.zIndex = '-1';
    host.style.background = '#fffdf9';
    const clone = source.cloneNode(true);
    clone.removeAttribute('id');
    clone.classList.add('meme-export-mode');
    const width = Math.max(source.clientWidth, source.scrollWidth, 560);
    clone.style.width = `${width}px`;
    clone.style.maxWidth = 'none';
    clone.style.overflow = 'visible';
    host.appendChild(clone);
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
    setProgress(8, '准备看板');
    try {
      setProgress(28, '加载卡片图片');
      setProgress(58, '渲染看板');
      const canvas = await renderMemeCanvas();
      if (!canvas) { finishProgress(); return; }
      setProgress(82, '生成 PNG');
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG conversion failed');
      setProgress(94, '准备下载');
      downloadBlob(blob, 'galgame-meme-board.png');
      finishProgress();
      showToast('MEME 看板图片已保存');
    } catch (error) {
      console.warn('MEME export failed:', error);
      finishProgress('保存失败');
      showToast('图片保存失败，请确认图片加载完成后重试', 'error');
    }
  }

  async function shareToPosts() {
    const canvas = await renderMemeCanvas();
    if (!canvas) return;
    if (window.VNFPostShare) {
      const title = (state.board && state.board.title) || '我的 MEME 看板';
      window.VNFPostShare.share({ canvas, defaultText: `【MEME 看板】${title} #Galgame` });
    } else {
      showToast('转发组件尚未加载，请刷新后重试', 'error');
    }
  }

  async function resetBoard() {
    if (!window.confirm('确定要重置整个 MEME 看板吗？')) return;
    clearTimeout(serverSaveTimer);
    state = createDefaultMeme();
    try { localStorage.removeItem(activeStorageKey); } catch (_) { /* ignore */ }
    if (cloudEnabled && sessionUser?.id) {
      const response = await fetchJson(`${MEME_API_URL}?action=reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (!response.ok || !response.success) setSyncStatus('error');
    }
    writeLocal();
    renderAll();
    setSyncStatus(cloudEnabled ? 'synced' : 'local');
    showToast('MEME 看板已重置');
  }

  function adjustCols(delta) {
    const current = state.board.colsMode === 'fixed' ? state.board.cols : 6;
    state.board.colsMode = 'fixed';
    state.board.cols = Math.max(1, Math.min(6, current + delta));
    state.board.rows = Math.min(state.board.rows, Math.max(1, Math.floor(MEME_MAX_CELLS / state.board.cols)));
    ensureCellCount(state.board.cols * state.board.rows);
    persist();
    renderAll();
  }

  function adjustRows(delta) {
    const logicalCols = state.board.colsMode === 'fixed' ? state.board.cols : 6;
    const maxRows = Math.min(30, Math.floor(MEME_MAX_CELLS / logicalCols));
    state.board.rows = Math.max(1, Math.min(maxRows, state.board.rows + delta));
    const count = (state.board.colsMode === 'fixed' ? state.board.cols : logicalCols) * state.board.rows;
    ensureCellCount(count);
    persist();
    renderAll();
  }

  function toggleColsMode() {
    state.board.colsMode = state.board.colsMode === 'fixed' ? 'auto' : 'fixed';
    if (state.board.colsMode === 'fixed') {
      state.board.rows = Math.min(state.board.rows, Math.max(1, Math.floor(MEME_MAX_CELLS / state.board.cols)));
      ensureCellCount(state.board.cols * state.board.rows);
    }
    persist();
    renderAll();
  }

  function showToast(message, type = 'success') {
    const toast = $('#memeToast');
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle('is-error', type === 'error');
    toast.classList.add('is-visible');
    toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
  }

  function openCardPreview(card) {
    const body = $('#memeCardPreviewBody');
    if (!body) return;
    body.innerHTML = '';
    body.appendChild(makeCardElement(card));
    openModal('memeCardPreviewModal');
  }

  function bindEvents() {
    $('#memeToolMenuToggle')?.addEventListener('click', () => {
      const sidebar = $('#memeToolSidebar');
      const open = sidebar.classList.toggle('is-open');
      $('#memeToolMenuToggle').setAttribute('aria-expanded', String(open));
    });
    $('#memeBoardTitle')?.addEventListener('click', editBoardTitle);
    $$('.meme-segment').forEach(button => button.addEventListener('click', () => {
      state.settings.cardSize = button.dataset.cardSize;
      persist();
      renderAll();
    }));
    $('#memeShowTitles')?.addEventListener('click', () => { state.settings.showTitles = !state.settings.showTitles; persist(); renderAll(); });
    $('#memeShowPopup')?.addEventListener('click', () => { state.settings.showPopup = !state.settings.showPopup; persist(); renderAll(); });
    $('#memeColsDown')?.addEventListener('click', () => adjustCols(-1));
    $('#memeColsUp')?.addEventListener('click', () => adjustCols(1));
    $('#memeRowsDown')?.addEventListener('click', () => adjustRows(-1));
    $('#memeRowsUp')?.addEventListener('click', () => adjustRows(1));
    $('#memeColsValue')?.addEventListener('click', toggleColsMode);
    $('#memeSearchInput')?.addEventListener('input', queueSearch);
    $('#memeSearchKind')?.addEventListener('change', performSearch);
    $('#memeSearchSource')?.addEventListener('change', performSearch);
    $('#memeBangumiImport')?.addEventListener('click', openBangumiImport);
    $('#memeAddImage')?.addEventListener('click', openImageModal);
    $('#memeResumeSource')?.addEventListener('click', loadResumeIntoPool);
    $('#memeFileExport')?.addEventListener('click', () => $('#memeJsonInput')?.click());
    $('#memeJsonInput')?.addEventListener('change', event => { importJson(event.target.files?.[0]); event.target.value = ''; });
    $('#memeCopyUrl')?.addEventListener('click', copyShareUrl);
    $('#memeShareX')?.addEventListener('click', shareX);
    $('#memeSharePosts')?.addEventListener('click', shareToPosts);
    $('#memeSaveImage')?.addEventListener('click', exportImage);
    $('#memeReset')?.addEventListener('click', resetBoard);
    $('#memeImageInput')?.addEventListener('change', event => readCustomImage(event.target.files?.[0]));
    $('#memeImageConfirm')?.addEventListener('click', confirmCustomImage);
    $('#memeImportSelectAll')?.addEventListener('click', () => selectAllImport(true));
    $('#memeImportClear')?.addEventListener('click', () => selectAllImport(false));
    $('#memeImportMore')?.addEventListener('click', loadImportPage);
    $('#memeImportConfirm')?.addEventListener('click', confirmImport);
    $$('.meme-pool-tab').forEach(tab => tab.addEventListener('click', () => {
      $$('.meme-pool-tab').forEach(item => { item.classList.remove('is-active'); item.setAttribute('aria-selected', 'false'); });
      tab.classList.add('is-active');
      tab.setAttribute('aria-selected', 'true');
      const search = tab.dataset.poolTab === 'search';
      $('#memeSearchPanel').hidden = !search;
      $('#memeUnrankedPanel').hidden = search;
    }));
    $$('.meme-modal-overlay').forEach(overlay => overlay.addEventListener('click', event => {
      if (event.target === overlay) closeModal(overlay.id);
    }));
    $$('[data-close-modal]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.closeModal)));
    window.addEventListener('resize', () => renderGrid());
    window.addEventListener('vnfest-tool-viewchange', event => {
      if (event.detail === 'meme') window.requestAnimationFrame(() => renderAll());
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    await bootstrap();
  });
})();
