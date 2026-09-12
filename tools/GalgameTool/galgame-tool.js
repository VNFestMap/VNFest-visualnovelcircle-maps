// ===== State Management =====
const LEGACY_STORAGE_KEY = 'bishoujo_resume_data';
const GUEST_STORAGE_KEY = 'bishoujo_resume_data:guest';
const STORAGE_KEY_PREFIX = 'bishoujo_resume_data:user:';
const RESUME_SCHEMA_VERSION = 1;
const RESUME_API_URL = new URL('../../api/galgame_resume.php', document.baseURI).href;
const BANGUMI_PROXY_URL = new URL('../../api/bangumi_proxy.php', document.baseURI).href;
const BANGUMI_ACCOUNT_API_URL = new URL('../../api/bangumi_account.php', document.baseURI).href;
const IMAGE_PROXY_URL = new URL('../../api/image_proxy.php', document.baseURI).href;
const BILIBILI_ACCOUNT_ICON_URL = new URL('./assets/bilibili-account.svg', document.baseURI).href;
const IMAGE_PROXY_HOSTS = new Set(['lain.bgm.tv', 't.vndb.org', 's.vndb.org']);
const DEFAULT_ACCOUNT_TYPE = 'bgm';
const CHARACTER_SEARCH_RESULT_LIMIT = 15;
const CHARACTER_CV_PREFETCH_LIMIT = 6;
const CHARACTER_CV_PREFETCH_CONCURRENCY = 2;
let activeStorageKey = GUEST_STORAGE_KEY;
let sessionUser = null;
let cloudResumeEnabled = false;
let serverResumeExists = false;
let serverLoadPending = true;
let serverSaveTimer = null;
let serverSaveInFlight = false;
let serverSaveQueued = false;
let exportProgressHideTimer = null;
let activeSearchController = null;
let searchGeneration = 0;
const bangumiCvCache = new Map();
let bangumiImportItems = [];
let bangumiImportSelectedIds = new Set();
let bangumiImportOffset = 0;
let bangumiImportHasMore = false;
let bangumiImportLoading = false;
let state = {
  mode: 'resume',
  moreItems: false,
  popupEnabled: true,
  enabledApis: ['bangumi', 'vndb'], // CnGal always enabled; bangumi/vndb are selectable
  profile: {
    name: '',
    handle: '',
    accountType: DEFAULT_ACCOUNT_TYPE,
    avatar: '',
    avatarShape: 'square',
    avatarPosX: 50,
    avatarPosY: 50,
    genres: [],
    brands: [],
    works: [],
    heroines: [],
    historyYears: '',
    playCount: '0',
    voiceActors: [],
    artists: [],
    writers: [],
    songs: [],
    attributes: [],
    other: ''
  },
  sections: [
    { id: 'name', type: 'name', label: '姓名（昵称）', span: 1 },
    { id: 'genres', type: 'multiselect', label: '喜欢的类型', span: 1, field: 'genres' },
    { id: 'brands', type: 'list', label: '喜欢的厂商', span: 1, field: 'brands' },
    { id: 'works', type: 'thumbs', label: '喜欢的作品', span: 1, field: 'works', searchType: 'vn' },
    { id: 'heroines', type: 'thumbs', label: '喜欢的女主角', span: 1, field: 'heroines', searchType: 'character' },
    { id: 'history', type: 'stats', label: 'Galgame履历 / 游玩数量', span: 1 },
    { id: 'voiceActors', type: 'list', label: '喜欢的声优', span: 1, field: 'voiceActors' },
    { id: 'artists', type: 'list', label: '喜欢的原画家', span: 1, field: 'artists' },
    { id: 'writers', type: 'list', label: '喜欢的剧本家', span: 1, field: 'writers' },
    { id: 'songs', type: 'list', label: '喜欢的Galgame歌曲', span: 1, field: 'songs' },
    { id: 'attributes', type: 'list', label: '喜欢的属性', span: 1, field: 'attributes' },
    { id: 'other', type: 'textarea', label: '其他', span: 1, field: 'other' }
  ],
  currentSearchField: null,
  searchResults: [],
  selectedItems: [],
  currentFilter: 'all',
  searchDebounce: null
};

function normalizeAccountType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'x' || normalized === 'twitter') return 'x';
  if (normalized === 'bgm' || normalized === 'bangumi') return 'bgm';
  if (normalized === 'bilibili' || normalized === 'b站' || normalized === 'bili') return 'bilibili';
  return DEFAULT_ACCOUNT_TYPE;
}

function getAccountPlatformLabel(value) {
  const accountType = normalizeAccountType(value);
  if (accountType === 'x') return 'X / Twitter';
  if (accountType === 'bilibili') return 'Bilibili';
  return 'Bangumi';
}

function getAccountPlatformIcon(value) {
  const accountType = normalizeAccountType(value);
  if (accountType === 'x') {
    return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
  }
  if (accountType === 'bilibili') {
    return `<img class="account-platform-icon-image" src="${BILIBILI_ACCOUNT_ICON_URL}" alt="" aria-hidden="true">`;
  }
  return '<svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true"><path d="M228.115 615.4a12.3 12.3 0 0 0 11.355 7.569 12.471 12.471 0 0 0 4.75-.965l147.61-61.883a12.3 12.3 0 0 0 .264-22.557l-147.61-66.235a12.3 12.3 0 1 0-10.067 22.444l121.74 54.634-121.456 50.907a12.3 12.3 0 0 0-6.586 16.085zm170.906 12.565H239.47a12.3 12.3 0 0 0 0 24.602h159.55a12.3 12.3 0 0 0 0-24.602zm0 39.495H239.47a12.3 12.3 0 0 0 0 24.602h159.55a12.3 12.3 0 0 0 0-24.602zm473.92-190.568l-133.283 58.382a12.3 12.3 0 0 0-.397 22.35l133.302 64.058a12.074 12.074 0 0 0 5.318 1.23 12.3 12.3 0 0 0 5.337-23.39l-109.156-52.42 108.834-47.633a12.3 12.3 0 1 0-9.954-22.577zm4.94 151.073H729.78a12.3 12.3 0 0 0 0 24.602h148.1a12.3 12.3 0 0 0 0-24.602zm0 39.495H729.78a12.3 12.3 0 0 0 0-24.602h148.1a12.3 12.3 0 0 0 0-24.602zM644.866 537.128h-162.92a12.282 12.282 0 0 0-10.71 18.32l81.374 145.13a12.3 12.3 0 0 0 21.46 0l81.375-145.13a12.3 12.3 0 0 0-10.73-18.32zm-81.374 132.3L503.047 561.73h120.889z"/></svg>';
}

function updateAccountPlatformControl() {
  const button = document.getElementById('accountPlatformToggle');
  if (!button) return;
  const accountType = normalizeAccountType(state.profile?.accountType);
  const label = getAccountPlatformLabel(accountType);
  button.dataset.accountType = accountType;
  button.title = `切换账号平台（当前：${label}）`;
  button.setAttribute('aria-label', `切换账号平台，当前为 ${label}`);
  button.innerHTML = `<span class="account-platform-toolbar-icon" aria-hidden="true">${getAccountPlatformIcon(accountType)}</span><span class="account-platform-toolbar-label">${label}</span>`;
}

/*
function getAccountPlatformLabel(value) {
  const accountType = normalizeAccountType(value);
  if (accountType === 'x') return 'X / Twitter';
  if (accountType === 'bilibili') return 'Bilibili';
  return 'Bangumi';
}

function getAccountPlatformIcon(value) {
  if (normalizeAccountType(value) === 'bilibili') {
    return `<img class="account-platform-icon-image" src="${BILIBILI_ACCOUNT_ICON_URL}" alt="" aria-hidden="true">`;
  }
  if (normalizeAccountType(value) === 'x') {
    return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
  }
  return '<svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true"><path d="M228.115 615.4a12.3 12.3 0 0 0 11.355 7.569 12.471 12.471 0 0 0 4.75-.965l147.61-61.883a12.3 12.3 0 0 0 .264-22.557l-147.61-66.235a12.3 12.3 0 1 0-10.067 22.444l121.74 54.634-121.456 50.907a12.3 12.3 0 0 0-6.586 16.085zm170.906 12.565H239.47a12.3 12.3 0 0 0 0 24.602h159.55a12.3 12.3 0 0 0 0-24.602zm0 39.495H239.47a12.3 12.3 0 0 0 0 24.602h159.55a12.3 12.3 0 0 0 0-24.602zm473.92-190.568l-133.283 58.382a12.3 12.3 0 0 0-.397 22.35l133.302 64.058a12.074 12.074 0 0 0 5.318 1.23 12.3 12.3 0 0 0 5.337-23.39l-109.156-52.42 108.834-47.633a12.3 12.3 0 1 0-9.954-22.577zm4.94 151.073H729.78a12.3 12.3 0 0 0 0-24.602h148.1a12.3 12.3 0 0 0 0-24.602zm0 39.495H729.78a12.3 12.3 0 0 0 0-24.602h148.1a12.3 12.3 0 0 0 0-24.602zM644.866 537.128h-162.92a12.282 12.282 0 0 0-10.71 18.32l81.374 145.13a12.3 12.3 0 0 0 21.46 0l81.375-145.13a12.3 12.3 0 0 0-10.73-18.32zm-81.374 132.3L503.047 561.73h120.889z"/></svg>';
}

function updateAccountPlatformControl() {
  const button = document.getElementById('accountPlatformToggle');
  if (!button) return;
  const accountType = normalizeAccountType(state.profile?.accountType);
  const label = getAccountPlatformLabel(accountType);
  button.dataset.accountType = accountType;
  button.title = `切换账号平台（当前：${label}）`;
  button.setAttribute('aria-label', `切换账号平台，当前为 ${label}`);
  button.innerHTML = `<span class="account-platform-toolbar-icon" aria-hidden="true">${getAccountPlatformIcon(accountType)}</span><span class="account-platform-toolbar-label">${label}</span>`;
}
*/

function readStoredState(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn('Failed to parse stored state:', error);
    return null;
  }
}

function hasMeaningfulResume(data) {
  const profile = data?.profile || {};
  return Boolean(
    profile.name || profile.handle || profile.avatar || profile.historyYears ||
    Number(profile.playCount || 0) > 0 ||
    ['genres', 'brands', 'works', 'heroines', 'voiceActors', 'artists', 'writers', 'songs', 'attributes']
      .some(field => Array.isArray(profile[field]) && profile[field].length > 0) ||
    profile.other
  );
}

function resolveAccountMediaUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || /^(?:data|blob):/i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return new URL(raw, window.location.origin).href;
  const clean = raw.replace(/^\.\//, '');
  return new URL(`../../${clean}`, document.baseURI).href;
}

async function fetchJson(url, options = {}) {
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      return { ok: false, status: response.status, unavailable: true };
    }
    return { ...data, ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, unavailable: true, error };
  }
}

function applyAuthenticatedDefaults() {
  if (!sessionUser?.id) return;
  const profile = state.profile;
  const displayName = sessionUser.nickname || sessionUser.username || '';
  if (!profile.name) profile.name = displayName;
  if (!profile.handle) profile.handle = sessionUser.username || '';
  if (!profile.avatar && sessionUser.avatar_url) {
    profile.avatar = resolveAccountMediaUrl(sessionUser.avatar_url);
  }
}

function updateResumeSyncStatus(status) {
  const element = document.getElementById('resumeSyncStatus');
  if (!element) return;
  const labels = {
    loading: '正在加载账号履历',
    local: '本机草稿',
    syncing: '正在同步',
    synced: '已同步',
    error: '同步失败，已保留本机草稿'
  };
  element.dataset.state = status;
  element.textContent = labels[status] || labels.local;
  element.title = sessionUser?.username ? `当前账号：${sessionUser.username}` : '未登录，仅保存到本机';
}

async function loadServerResume() {
  return fetchJson(`${RESUME_API_URL}?action=load`);
}

async function saveServerResume() {
  if (!cloudResumeEnabled || !sessionUser?.id) return false;
  const response = await fetchJson(`${RESUME_API_URL}?action=save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resume: serializeState() })
  });
  if (!response.ok || !response.success) {
    updateResumeSyncStatus('error');
    return false;
  }
  serverResumeExists = true;
  updateResumeSyncStatus('synced');
  return true;
}

function scheduleServerSave() {
  if (!cloudResumeEnabled || serverLoadPending) return;
  serverSaveQueued = true;
  updateResumeSyncStatus('syncing');
  clearTimeout(serverSaveTimer);
  serverSaveTimer = setTimeout(async () => {
    serverSaveTimer = null;
    if (serverSaveInFlight) return;
    serverSaveInFlight = true;
    serverSaveQueued = false;
    try {
      await saveServerResume();
    } finally {
      serverSaveInFlight = false;
      if (serverSaveQueued) scheduleServerSave();
    }
  }, 800);
}

async function bootstrapAccountState() {
  activeStorageKey = GUEST_STORAGE_KEY;
  sessionUser = null;
  cloudResumeEnabled = false;
  serverResumeExists = false;
  serverLoadPending = true;

  const auth = await fetchJson('../../api/auth.php?action=me');
  if (!auth.logged_in || !auth.user?.id) {
    const guest = readStoredState(GUEST_STORAGE_KEY);
    if (!guest) {
      const legacy = readStoredState(LEGACY_STORAGE_KEY);
      if (legacy) localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(legacy));
    }
    updateResumeSyncStatus('local');
    serverLoadPending = false;
    return;
  }

  sessionUser = auth.user;
  cloudResumeEnabled = true;
  activeStorageKey = `${STORAGE_KEY_PREFIX}${sessionUser.id}`;
  updateResumeSyncStatus('loading');

  const remote = await loadServerResume();
  if (remote.ok && remote.success && remote.resume) {
    loadState(remote.resume);
    applyAuthenticatedDefaults();
    writeLocalState();
    serverResumeExists = true;
    return;
  }

  const accountLocal = readStoredState(activeStorageKey);
  const legacy = readStoredState(LEGACY_STORAGE_KEY);
  if (accountLocal) {
    loadState(accountLocal);
  } else if (legacy && hasMeaningfulResume(legacy)) {
    loadState(legacy);
    applyAuthenticatedDefaults();
    writeLocalState();
    if (window.confirm('发现本机旧版履历草稿，是否上传到当前账号？')) {
      await saveServerResume();
    }
  }
  applyAuthenticatedDefaults();
  writeLocalState();
}

// ===== Load / Save =====
function loadState(source = activeStorageKey) {
  try {
    const saved = typeof source === 'string' ? localStorage.getItem(source) : source;
    if (saved) {
      const data = typeof saved === 'string' ? JSON.parse(saved) : saved;
      state = { ...state, ...data };
      // Migrate section labels to Chinese (preserve order)
      const labelMap = {
        '名前（ハンドルネーム）': '姓名（昵称）',
        '好きなジャンル': '喜欢的类型',
        '好きなブランド': '喜欢的厂商',
        '好きな作品': '喜欢的作品',
        '好きなヒロイン': '喜欢的女主角',
        '美少女游戏履历 / 游玩数量': 'Galgame履历 / 游玩数量',
        '美少ゲ歴 / プレイ本数': 'Galgame履历 / 游玩数量',
        '好きな声優': '喜欢的声优',
        '好きな原画家': '喜欢的原画家',
        '好きなシナリオライター': '喜欢的剧本家',
        '喜欢的美少女游戏歌曲': '喜欢的Galgame歌曲',
        '好きな美少女ゲームソング': '喜欢的Galgame歌曲',
        '好きな属性': '喜欢的属性',
        'その他': '其他'
      };
      if (state.sections) {
        state.sections.forEach(s => {
          if (labelMap[s.label]) {
            s.label = labelMap[s.label];
          }
          if (s.id === 'history') {
            s.label = 'Galgame履历 / 游玩数量';
          } else if (s.id === 'songs') {
            s.label = '喜欢的Galgame歌曲';
          }
        });
      }
      // Normalize platform values from old/local/server saves. Domestic
      // users default to Bangumi; only an explicit X/Twitter value stays X.
      state.profile.accountType = normalizeAccountType(state.profile.accountType);
      // Migrate string fields to arrays for list-type sections
      const listFields = ['brands', 'voiceActors', 'artists', 'writers', 'songs', 'attributes'];
      listFields.forEach(field => {
        if (typeof state.profile[field] === 'string') {
          const val = state.profile[field].trim();
          state.profile[field] = val ? val.split(/[・、,，\n]+/).map(s => s.trim()).filter(Boolean) : [];
        }
        if (!Array.isArray(state.profile[field])) {
          state.profile[field] = [];
        }
      });
      // Migrate genres to valid multiselect options
      if (typeof state.profile.genres === 'string') {
        const val = state.profile.genres.trim();
        state.profile.genres = val ? val.split(/[・、,，\n]+/).map(s => s.trim()).filter(Boolean) : [];
      }
      if (!Array.isArray(state.profile.genres)) {
        state.profile.genres = [];
      }
      // Keep heroine entries compatible with older saves and reserve a field
      // for the voice actor shown below each character name.
      if (!Array.isArray(state.profile.heroines)) {
        state.profile.heroines = [];
      }
      state.profile.heroines = state.profile.heroines
        .map(item => {
          if (typeof item === 'string') {
            return { title: item, image: '', source: 'custom', id: '', cv: '' };
          }
          if (!item || typeof item !== 'object') return null;
          return { ...item, cv: normalizeCv(item.cv || '') };
        })
        .filter(Boolean);
      // Clean up removed API sources (kungal, ymgal)
      if (Array.isArray(state.enabledApis)) {
        state.enabledApis = state.enabledApis.filter(api => api === 'bangumi' || api === 'vndb');
      } else {
        state.enabledApis = ['bangumi', 'vndb'];
      }
      // Migrate section types: text -> list, tags -> multiselect
      if (state.sections) {
        const typeMap = {
          'genres': 'multiselect',
          'brands': 'list',
          'voiceActors': 'list',
          'artists': 'list',
          'writers': 'list',
          'songs': 'list',
          'attributes': 'list'
        };
        state.sections.forEach(s => {
          if (typeMap[s.id]) {
            s.type = typeMap[s.id];
          }
        });
      }
      // Keep the four preset genres, but also preserve user-defined genres.
      // Older versions discarded every value outside MULTISELECT_OPTIONS.
      state.profile.genres = [...new Set(state.profile.genres
        .map(value => String(value || '').trim())
        .filter(Boolean))];
    }
  } catch(e) { console.warn('Failed to load state:', e); }
}

function serializeState() {
  const toSave = { ...state };
  toSave.schema_version = RESUME_SCHEMA_VERSION;
  delete toSave.searchResults;
  delete toSave.selectedItems;
  delete toSave.currentSearchField;
  delete toSave.searchDebounce;
  return toSave;
}

function getBangumiIdFromWork(item) {
  if (!item || typeof item !== 'object') return 0;
  const direct = Number(item.bangumiId || item.bangumi_id || 0);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const match = String(item.id || '').match(/^bgm_vn_(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

function writeLocalState() {
  try {
    localStorage.setItem(activeStorageKey, JSON.stringify(serializeState()));
  } catch(e) { console.warn('Failed to save state:', e); }
}

function saveState() {
  writeLocalState();
  scheduleServerSave();
}

// ===== Initialize =====
async function init() {
  // Install the mobile scale guard before the account request. On a public
  // connection the session check may take longer than the first paint, and
  // the static 800px paper must not briefly create horizontal overflow.
  initMobileResumeScale();
  await bootstrapAccountState();
  loadState();
  updateAccountPlatformControl();
  populateYearSelect();
  renderResume();
  applyMode();
  applyToggles();
  scheduleMobileResumeScale();
  serverLoadPending = false;
  updateResumeSyncStatus(cloudResumeEnabled ? 'synced' : 'local');
}

function populateYearSelect() {
  const select = document.getElementById('yearSelect');
  const currentYear = new Date().getFullYear();
  for (let y = currentYear; y >= 1990; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y + '年';
    select.appendChild(opt);
  }
}

// ===== Mode Switching =====
function switchMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  applyMode();
  saveState();
}

function applyMode() {
  const container = document.getElementById('resumeContainer');
  container.classList.toggle('card-mode', state.mode === 'card');
  renderResume();
}

function toggleMobileEditMode(force) {
  const button = document.getElementById('mobileEditToggle');
  const isOpen = typeof force === 'boolean'
    ? force
    : !document.body.classList.contains('mobile-editor-open');
  document.body.classList.toggle('mobile-editor-open', isOpen);
  button?.classList.toggle('active', isOpen);
  button?.setAttribute('aria-pressed', String(isOpen));
  const label = button?.querySelector('.mobile-edit-toggle-label');
  if (label) label.textContent = isOpen ? '退出放大编辑' : '等倍编辑（放大）';
  if (button) button.title = isOpen ? '退出等倍编辑' : '移动端放大编辑履历书';
  // Apply the new scale in the same event turn so the editor never flashes
  // the fitted width before the next animation frame (especially on 360px).
  updateMobileResumeScale();
  scheduleMobileResumeScale();
}

let mobileResumeScaleFrame = 0;
let mobileResumeScaleObserver = null;
let exportLayoutLocked = false;

function scheduleMobileResumeScale() {
  if (mobileResumeScaleFrame) cancelAnimationFrame(mobileResumeScaleFrame);
  mobileResumeScaleFrame = requestAnimationFrame(() => {
    mobileResumeScaleFrame = 0;
    updateMobileResumeScale();
  });
}

function updateMobileResumeScale() {
  const container = document.getElementById('resumeContainer');
  const stage = document.getElementById('resumeScaleStage');
  const paper = document.getElementById('resumePaper');
  if (!container || !stage || !paper) return;
  if (exportLayoutLocked) return;

  const isMobile = window.matchMedia?.('(max-width: 900px)').matches;
  if (!isMobile) {
    paper.style.transform = '';
    stage.style.width = '';
    stage.style.height = '';
    return;
  }

  const paperWidth = paper.offsetWidth || 800;
  const paperHeight = paper.offsetHeight || paper.scrollHeight || 900;
  const isEqualScaleEditing = document.body.classList.contains('mobile-editor-open');
  const availableWidth = Math.max(280, container.clientWidth - 2);
  const scale = isEqualScaleEditing ? 1 : Math.min(1, availableWidth / paperWidth);

  stage.style.width = `${Math.ceil(paperWidth * scale)}px`;
  stage.style.height = `${Math.ceil(paperHeight * scale)}px`;
  paper.style.transform = scale === 1 ? 'none' : `scale(${scale})`;
}

function initMobileResumeScale() {
  const paper = document.getElementById('resumePaper');
  if (!paper) return;

  if (typeof ResizeObserver === 'function') {
    mobileResumeScaleObserver = new ResizeObserver(() => scheduleMobileResumeScale());
    mobileResumeScaleObserver.observe(paper);
  }
  window.addEventListener('resize', scheduleMobileResumeScale, { passive: true });
  window.addEventListener('orientationchange', scheduleMobileResumeScale, { passive: true });
  scheduleMobileResumeScale();
}

// ===== Toggles =====
function toggleMoreItems() {
  state.moreItems = !state.moreItems;
  document.getElementById('moreItemsToggle').classList.toggle('active', state.moreItems);
  document.getElementById('maxCount').textContent = state.moreItems ? '30' : '15';
  saveState();
  renderResume();
}

function togglePopup() {
  state.popupEnabled = !state.popupEnabled;
  document.getElementById('popupToggle').classList.toggle('active', state.popupEnabled);
  saveState();
}

function applyToggles() {
  document.getElementById('moreItemsToggle').classList.toggle('active', state.moreItems);
  document.getElementById('popupToggle').classList.toggle('active', state.popupEnabled);
  document.getElementById('maxCount').textContent = state.moreItems ? '30' : '15';
}

// ===== Render Resume =====
function renderResume() {
  const paper = document.getElementById('resumePaper');
  
  if (state.mode === 'card') {
    paper.innerHTML = renderCardMode();
  } else {
    paper.innerHTML = renderResumeMode();
  }
  updateRenderedAccountIcons();
  
  attachEventListeners();
  scheduleMobileResumeScale();
}

function updateRenderedAccountIcons() {
  if (normalizeAccountType(state.profile?.accountType) !== 'bilibili') return;
  document.querySelectorAll('.card-user-handle').forEach(handle => {
    const svg = handle.querySelector('svg');
    if (!svg) return;
    const image = document.createElement('img');
    image.className = 'account-platform-icon-image';
    image.src = BILIBILI_ACCOUNT_ICON_URL;
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    svg.replaceWith(image);
  });
}

function renderResumeMode() {
  const p = state.profile;
  let html = '';
  
  // Header: Title (left) + Avatar (right)
  const isCircle = p.avatarShape === 'circle';
  const avatarRadius = isCircle ? '50%' : '0';
  html += '<div class="resume-header">';
  html += '<div class="resume-title">Galgame履历书</div>';
  html += '<div class="resume-avatar-wrap">';
  html += `<div class="resume-avatar ${isCircle ? 'avatar-circle' : ''}" data-avatar-container onclick="document.getElementById('resumeAvatarInput').click()" title="点击上传头像，拖动调整位置" style="border-radius:${avatarRadius};">`;
  if (p.avatar) {
    html += `<img src="${p.avatar}" alt="头像" style="object-position:${p.avatarPosX || 50}% ${p.avatarPosY || 50}%;" draggable="false" data-avatar-img>`;
  } else {
    html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  }
  html += '</div>';
  // Edit badge (outside avatar to avoid circular clipping)
  html += '<div class="resume-avatar-edit-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></div>';
  // Shape toggle button (only when avatar exists, outside avatar to avoid circular clipping)
  if (p.avatar) {
    html += `<button class="avatar-shape-toggle" onclick="event.stopPropagation();toggleAvatarShape()" title="${isCircle ? '切换为正方形' : '切换为圆形'}">`;
    if (isCircle) {
      html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="1"/></svg>';
    } else {
      html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>';
    }
    html += '</button>';
  }
  html += '</div></div>';
  
  html += '<div class="resume-grid">';
  
  // Name section (full width, has bottom border)
  html += renderNameSection();
  
  // Genres + Brands row
  html += '<div style="display:grid;grid-template-columns:1fr 2fr;">';
  html += renderSection(state.sections.find(s => s.id === 'genres'), 'has-right-border');
  html += renderSection(state.sections.find(s => s.id === 'brands'), '');
  html += '</div>';
  
  // Works section (full width)
  html += renderSection(state.sections.find(s => s.id === 'works'), '');
  
  // Heroines section (full width)
  html += renderSection(state.sections.find(s => s.id === 'heroines'), '');
  
  // Stats row (history + play count + voice actors)
  html += '<div style="display:grid;grid-template-columns:1fr 1fr 1.5fr;">';
  html += renderStatsSubSection('Galgame履历', 'historyYears', '例如：8年', '', 'has-right-border');
  html += renderStatsSubSection('游玩数量', 'playCount', '0', '部', 'has-right-border');
  html += renderSection(state.sections.find(s => s.id === 'voiceActors'), '');
  html += '</div>';
  
  // Artists + Writers row: keep the four metadata sections on a shared 2x2 grid.
  html += '<div class="resume-half-grid">';
  html += renderSection(state.sections.find(s => s.id === 'artists'), 'has-right-border');
  html += renderSection(state.sections.find(s => s.id === 'writers'), '');
  html += '</div>';
  
  // Songs + Attributes row: same centered half-width split as artists/writers.
  html += '<div class="resume-half-grid">';
  html += renderSection(state.sections.find(s => s.id === 'songs'), 'has-right-border');
  html += renderSection(state.sections.find(s => s.id === 'attributes'), '');
  html += '</div>';
  
  // Other section (full width, LAST row - no bottom border)
  html += renderSection(state.sections.find(s => s.id === 'other'), 'no-bottom-border');
  
  html += '</div>';
  html += '<div class="resume-footer">' +
    '<span class="footer-line"><span class="footer-label">原作者</span>小鳥遊俊</span>' +
    '<span class="footer-line"><span class="footer-label">参考来源</span>Bishoujo DB · 个人资料生成器</span>' +
    '<span class="footer-line"><span class="footer-label">中文版本制作</span>VNFest</span>' +
    '</div>';
  
  // Hidden avatar input
  html += '<input type="file" id="resumeAvatarInput" accept="image/*" style="display:none" onchange="handleResumeAvatar(event)">';
  
  return html;
}

function renderNameSection() {
  const p = state.profile;
  const isX = p.accountType !== 'bgm';
  const accountType = normalizeAccountType(p.accountType);
  const platformIcon = isX 
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>'
    : '<svg viewBox="0 0 1024 1024" fill="currentColor" width="16" height="16"><path d="M228.115 615.4a12.3 12.3 0 0 0 11.355 7.569 12.471 12.471 0 0 0 4.75-.965l147.61-61.883a12.3 12.3 0 0 0 .264-22.557l-147.61-66.235a12.3 12.3 0 1 0-10.067 22.444l121.74 54.634-121.456 50.907a12.3 12.3 0 0 0-6.586 16.085zm170.906 12.565H239.47a12.3 12.3 0 0 0 0 24.602h159.55a12.3 12.3 0 0 0 0-24.602zm0 39.495H239.47a12.3 12.3 0 0 0 0 24.602h159.55a12.3 12.3 0 0 0 0-24.602zm473.92-190.568l-133.283 58.382a12.3 12.3 0 0 0-.397 22.35l133.302 64.058a12.074 12.074 0 0 0 5.318 1.23 12.3 12.3 0 0 0 5.337-23.39l-109.156-52.42 108.834-47.633a12.3 12.3 0 1 0-9.954-22.577zm4.94 151.073H729.78a12.3 12.3 0 0 0 0 24.602h148.1a12.3 12.3 0 0 0 0-24.602zm0 39.495H729.78a12.3 12.3 0 0 0 0 24.602h148.1a12.3 12.3 0 0 0 0-24.602zM644.866 537.128h-162.92a12.282 12.282 0 0 0-10.71 18.32l81.374 145.13a12.3 12.3 0 0 0 21.46 0l81.375-145.13a12.3 12.3 0 0 0-10.73-18.32zm-81.374 132.3L503.047 561.73h120.889z"/><path d="M891.412 334.96H648.405c-6.813-15.14-19.814-28.386-36.864-38.019L803.092 19.284a12.3 12.3 0 0 0-20.249-13.966L588.566 286.873a147.723 147.723 0 0 0-45.418-7.002 151.508 151.508 0 0 0-31.887 3.369L239.98 4.712a12.3 12.3 0 0 0-17.543 17.164L485.164 291.68c-22.141 9.822-39.116 25.113-47.31 43.242H132.547a91.764 91.764 0 0 0-91.783 91.783v414.442a91.764 91.764 0 0 0 91.783 91.821h268.024l-19.908 46.989c-12.641 29.881 22.615 57.095 48.295 37.3l109.515-84.289h352.938a91.764 91.764 0 0 0 91.783-91.783V426.743a91.764 91.764 0 0 0-91.783-91.783zm34.84 463.816a60.71 60.71 0 0 1-60.71 60.709H585.671l-97.8 73.483-77.004 57.852 24.413-57.852 31.017-73.483H198.082a60.728 60.728 0 0 1-60.803-60.747V440.33a60.728 60.728 0 0 1 60.728-60.728h667.46a60.71 60.71 0 0 1 60.709 60.728z"/></svg>';
  
  return `
    <div class="resume-section" data-section-id="name">
      <div class="section-toolbar">
        <button class="toolbar-mini-btn" title="更改颜色" onclick="event.stopPropagation();openColorPicker(this)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg></button>
        </div>
      <div class="section-label">
        姓名（昵称）
      </div>
      <div class="editable-text" contenteditable="true" data-field="name" data-placeholder="昵称" style="font-size:22px;font-weight:700;">${escapeHtml(p.name)}</div>
      <div class="account-row">
        <button class="account-platform-btn" data-account-type="${accountType}" onclick="event.stopPropagation();toggleAccountType()" title="点击切换平台（当前：${getAccountPlatformLabel(accountType)}）">${accountType === 'bilibili' ? getAccountPlatformIcon(accountType) : platformIcon}</button>
        <span class="account-at">@</span>
        <div class="editable-text" contenteditable="true" data-field="handle" data-placeholder="用户名" style="font-size:13px;min-width:100px;outline:none;">${escapeHtml(p.handle)}</div>
      </div>
    </div>
  `;
}

function renderStatsSubSection(label, field, placeholder, unit, extraClass) {
  return `
    <div class="resume-section ${extraClass || ''}" data-section-id="${field}">
      <div class="section-toolbar">
        <button class="toolbar-mini-btn" title="更改颜色" onclick="event.stopPropagation();openColorPicker(this)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg></button>
      </div>
      <div class="section-label">
        ${label}
      </div>
      <div class="number-input">
        <div class="editable-text" contenteditable="true" data-field="${field}" data-placeholder="${placeholder}">${escapeHtml(state.profile[field])}</div>
        ${unit ? `<span class="number-unit">${unit}</span>` : ''}
      </div>
    </div>
  `;
}

// ===== List section render (artists/writers/voice actors/songs/brands/attributes) =====
function renderListSection(section) {
  const items = Array.isArray(state.profile[section.field]) ? state.profile[section.field] : [];
  const isSongs = section.field === 'songs';
  const gridClass = isSongs ? 'list-grid single-column' : 'list-grid';
  
  let html = `<div class="${gridClass}" data-list-field="${section.field}">`;
  items.forEach((item, i) => {
    const isEmptyItem = !String(item ?? '').trim();
    html += `
      <div class="list-item${isEmptyItem ? ' list-item-empty' : ''}" data-item-index="${i}" data-field="${section.field}"${isEmptyItem ? ' data-empty-list-item="true" data-export-hide="true"' : ''} draggable="true">
        <span class="list-bullet"></span>
        <span class="list-text" contenteditable="true" data-list-field="${section.field}" data-list-index="${i}" data-placeholder="输入内容" onblur="handleListItemBlur(this)" onkeydown="handleListItemKeydown(event)">${escapeHtml(item)}</span>
        <button class="list-remove" data-export-hide="true" draggable="false" onclick="removeListItem('${section.field}', ${i})" title="删除">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    `;
  });
  html += `<button class="list-add" data-export-hide="true" onclick="addListItem('${section.field}')">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    添加…
  </button>`;
  html += '</div>';
  return html;
}

function addListItem(field) {
  if (!Array.isArray(state.profile[field])) state.profile[field] = [];
  state.profile[field].push('');
  saveState();
  renderResume();
  // Focus the new item
  setTimeout(() => {
    const items = document.querySelectorAll(`.list-text[data-list-field="${field}"]`);
    if (items.length > 0) items[items.length - 1].focus();
  }, 50);
}

function removeListItem(field, index) {
  if (Array.isArray(state.profile[field])) {
    state.profile[field].splice(index, 1);
    saveState();
    renderResume();
  }
}

function handleListItemBlur(el) {
  const field = el.dataset.listField;
  const index = parseInt(el.dataset.listIndex);
  const values = normalizeListValues(el.textContent);
  if (!Array.isArray(state.profile[field]) || index < 0) return;

  // Pasting a line break or a separator is treated as multiple entries. A
  // normal space remains part of the same entry, so names such as "Key 社"
  // never turn into extra bullets or accidental wrapped rows.
  if (values.length <= 1) {
    state.profile[field][index] = values[0] || '';
    saveState();
    return;
  }

  state.profile[field].splice(index, 1, ...values);
  saveState();
  renderResume();
}

function normalizeListValues(value) {
  return String(value || '')
    // One bullet represents one information element. Punctuation such as
    // Chinese/Japanese enumeration marks belongs to the element itself; only
    // an explicit line break creates multiple elements in resume mode.
    .split(/\r?\n+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function handleListItemKeydown(event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();

  const el = event.currentTarget;
  const field = el?.dataset?.listField;
  const index = parseInt(el?.dataset?.listIndex, 10);
  if (!field || !Array.isArray(state.profile[field]) || index < 0) return;

  const values = normalizeListValues(el.textContent);
  const currentValues = values.length ? values : [''];
  state.profile[field].splice(index, 1, ...currentValues, '');
  const nextIndex = index + currentValues.length;
  saveState();
  renderResume();

  requestAnimationFrame(() => {
    const next = document.querySelector(`.list-text[data-list-field="${field}"][data-list-index="${nextIndex}"]`);
    next?.focus();
  });
}

// ===== Multiselect section render (genres) =====
const MULTISELECT_OPTIONS = [
  { value: '角色作', label: '角色作' },
  { value: '剧情作', label: '剧情作' },
  { value: '拔作', label: '拔作' },
  { value: '其他', label: '其他' }
];

function renderMultiselectSection(section) {
  const selected = Array.isArray(state.profile[section.field]) ? state.profile[section.field] : [];
  let html = `<div class="multiselect-container" data-multiselect-field="${section.field}">`;
  
  selected.forEach((item, i) => {
    html += `
      <span class="multiselect-pill">
        ${escapeHtml(item)}
        <button class="multiselect-pill-remove" data-export-hide="true" onclick="removeMultiselectItem('${section.field}', ${i})" title="移除">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </span>
    `;
  });
  
  // Keep the add control visible even when all presets are selected so that
  // custom genres remain available at any time.
  html += `<button class="multiselect-add" data-export-hide="true" type="button" onclick="toggleMultiselectDropdown('${section.field}', this)">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    标签
  </button>`;
  
  // Dropdown
  html += `<div class="multiselect-dropdown" id="multiselect-dropdown-${section.field}">`;
  MULTISELECT_OPTIONS.forEach(opt => {
    const isSelected = selected.includes(opt.value);
    html += `<div class="multiselect-option ${isSelected ? 'selected' : ''}" onclick="toggleMultiselectItem('${section.field}', '${opt.value}')">${opt.label}</div>`;
  });
  html += `
    <div class="multiselect-custom" data-export-hide="true">
      <label class="multiselect-custom-label" for="multiselect-custom-${section.field}">自定义类型</label>
      <div class="multiselect-custom-row">
        <input class="multiselect-custom-input" id="multiselect-custom-${section.field}" type="text" maxlength="40" placeholder="输入其他类型" onkeydown="handleCustomMultiselectKeydown(event, '${section.field}')">
        <button class="multiselect-custom-submit" type="button" onclick="addCustomMultiselectItem('${section.field}')">添加</button>
      </div>
      <span class="multiselect-custom-hint">按回车添加</span>
    </div>
  `;
  html += '</div>';
  
  html += '</div>';
  return html;
}

function toggleMultiselectDropdown(field, btn) {
  const dropdown = document.getElementById(`multiselect-dropdown-${field}`);
  if (!dropdown) return;
  
  // Close all other dropdowns
  document.querySelectorAll('.multiselect-dropdown.active').forEach(d => {
    if (d !== dropdown) d.classList.remove('active');
  });
  
  dropdown.classList.toggle('active');
  
  // Position dropdown below the button
  if (dropdown.classList.contains('active')) {
    const rect = btn.getBoundingClientRect();
    const container = btn.closest('.multiselect-container');
    const containerRect = container.getBoundingClientRect();
    dropdown.style.position = 'absolute';
    dropdown.style.top = (rect.bottom - containerRect.top + 4) + 'px';
    dropdown.style.left = (rect.left - containerRect.left) + 'px';
  }
}

function toggleMultiselectItem(field, value) {
  if (!Array.isArray(state.profile[field])) state.profile[field] = [];
  const idx = state.profile[field].indexOf(value);
  if (idx > -1) {
    state.profile[field].splice(idx, 1);
  } else {
    state.profile[field].push(value);
  }
  saveState();
  renderResume();
}

function addCustomMultiselectItem(field) {
  const input = document.getElementById(`multiselect-custom-${field}`);
  const value = input?.value.trim() || '';
  if (!value) {
    input?.focus();
    return;
  }
  if (!Array.isArray(state.profile[field])) state.profile[field] = [];
  if (!state.profile[field].includes(value)) {
    state.profile[field].push(value);
    saveState();
  }
  renderResume();
  requestAnimationFrame(() => {
    const button = document.querySelector(`[data-multiselect-field="${field}"] .multiselect-add`);
    if (button) toggleMultiselectDropdown(field, button);
    document.getElementById(`multiselect-custom-${field}`)?.focus();
  });
}

function handleCustomMultiselectKeydown(event, field) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  addCustomMultiselectItem(field);
}

function removeMultiselectItem(field, index) {
  if (Array.isArray(state.profile[field])) {
    state.profile[field].splice(index, 1);
    saveState();
    renderResume();
  }
}

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.multiselect-container')) {
    document.querySelectorAll('.multiselect-dropdown.active').forEach(d => d.classList.remove('active'));
  }
});

function renderSection(section, extraClass) {
  if (!section) return '';
  
  let contentHtml = '';
  
  switch(section.type) {
    case 'text':
      contentHtml = `<div class="editable-text" contenteditable="true" data-field="${section.field}" data-placeholder="输入内容">${escapeHtml(state.profile[section.field] || '')}</div>`;
      break;
    case 'textarea':
      contentHtml = `<div class="editable-text" contenteditable="true" data-field="${section.field}" data-placeholder="自由填写" style="min-height:60px;">${escapeHtml(state.profile[section.field] || '')}</div>`;
      break;
    case 'tags':
      contentHtml = renderTags(section.field);
      break;
    case 'list':
      contentHtml = renderListSection(section);
      break;
    case 'multiselect':
      contentHtml = renderMultiselectSection(section);
      break;
    case 'thumbs':
      contentHtml = renderThumbs(section);
      break;
    default:
      contentHtml = `<div class="editable-text" contenteditable="true" data-field="${section.field}">${escapeHtml(state.profile[section.field] || '')}</div>`;
  }
  
  const sectionStyleClass = section.field === 'heroines'
    ? ' heroine-section'
    : (section.field === 'works' ? ' works-section' : '');
  return `
    <div class="resume-section ${extraClass || ''}${sectionStyleClass}" data-section-id="${section.id}">
      <div class="section-toolbar">
        <button class="toolbar-mini-btn" title="更改颜色" onclick="event.stopPropagation();openColorPicker(this)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg></button>
        </div>
      <div class="section-label">
        ${section.label}
      </div>
      ${contentHtml}
    </div>
  `;
}

function renderTags(field) {
  const tags = state.profile[field] || [];
  let html = '<div class="tag-container"><div class="tag-list">';
  tags.forEach((tag, i) => {
    html += `<span class="tag">${escapeHtml(tag)}<span class="tag-remove" data-export-hide="true" onclick="removeTag('${field}', ${i})"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span></span>`;
  });
  html += `</div><div class="tag-entry" data-export-hide="true" onclick="document.querySelector('[data-tag-field=\"${field}\"]')?.focus()">
    <input type="text" class="tag-input" data-export-hide="true" placeholder="添加标签" enterkeyhint="done" onkeydown="handleTagInput(event, '${field}')" data-tag-field="${field}">
    <button class="tag-submit" data-export-hide="true" type="button" onclick="event.stopPropagation();addTagFromInput('${field}', this.previousElementSibling)">添加</button>
  </div></div>`;
  return html;
}

function renderThumbs(section) {
  const items = state.profile[section.field] || [];
  const maxItems = state.moreItems ? 30 : 15;
  const isWorks = section.field === 'works';
  const isHeroines = section.field === 'heroines';
  const sizeClass = isWorks ? ' works-thumb' : '';
  // Works use contain + letterboxing; heroine portraits deliberately fill
  // their square frame and are cropped to keep the card grid compact.
  const fitClass = isWorks ? ' contain' : '';
  
  const gridClass = isWorks ? 'thumb-grid works-grid' : (isHeroines ? 'thumb-grid heroine-grid' : 'thumb-grid');
  let html = '<div class="' + gridClass + '">';
  items.forEach((item, i) => {
    const cv = isHeroines ? normalizeCv(item.cv || '') : '';
    const imageSrc = getImageProxyUrl(item.image);
    const thumbImageHtml = imageSrc
      ? `<img src="${escapeHtml(imageSrc)}" alt="${escapeHtml(item.title)}" loading="lazy" draggable="false">`
      : `<div class="thumb-placeholder" style="width:100%;background:#eee;display:flex;align-items:center;justify-content:center;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#999" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="11" x2="10" y2="11"/><line x1="8" y1="9" x2="8" y2="13"/><line x1="15" y1="12" x2="15.01" y2="12"/><line x1="18" y1="10" x2="18.01" y2="10"/><rect x="2" y="6" width="20" height="12" rx="2"/></svg></div>`;
    const mediaHtml = isHeroines
      ? `<div class="thumb-image-frame">${thumbImageHtml}</div>`
      : isWorks
        ? `<div class="thumb-image-frame">${thumbImageHtml}</div>`
        : thumbImageHtml;
    const labelHtml = isHeroines
      ? `<div class="thumb-label heroine-thumb-label" onmousedown="event.stopPropagation()">
          <span class="thumb-name" contenteditable="true" data-field="${section.field}" data-index="${i}" data-part="name" onblur="handleThumbLabelEdit(this)" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}" onmousedown="event.stopPropagation()">${escapeHtml(item.title)}</span>
          <span class="thumb-cv" contenteditable="true" data-field="${section.field}" data-index="${i}" data-part="cv" data-placeholder="CV 未收录" onblur="handleThumbLabelEdit(this)" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}" onmousedown="event.stopPropagation()">${cv ? `CV ${escapeHtml(cv)}` : 'CV 未收录'}</span>
        </div>`
      : `<div class="thumb-label works-thumb-label" onmousedown="event.stopPropagation()">
          <span class="thumb-name" contenteditable="true" data-field="${section.field}" data-index="${i}" data-part="name" onblur="handleThumbLabelEdit(this)" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}" onmousedown="event.stopPropagation()">${escapeHtml(item.title)}</span>
        </div>`;
    html += `
      <div class="thumb-item${sizeClass}${fitClass}" data-item-index="${i}" data-field="${section.field}" draggable="true">
        ${mediaHtml}
        ${labelHtml}
        <button class="thumb-remove" data-export-hide="true" draggable="false" onclick="removeThumb('${section.field}', ${i})"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    `;
  });
  
  if (items.length < maxItems) {
    html += `
      <button class="thumb-add${sizeClass}" data-export-hide="true" draggable="false" onclick="openAddMenu(event, '${section.field}', '${section.searchType}')">
        +
        <span>添加</span>
      </button>
    `;
  }
  
  html += '</div>';
  return html;
}

// Handle editable thumb label (works/heroines)
function handleThumbLabelEdit(el) {
  const field = el.dataset.field;
  const index = parseInt(el.dataset.index);
  const item = state.profile[field] && state.profile[field][index];
  if (!item) return;

  const newValue = el.textContent.trim();
  if (field === 'heroines' && el.dataset.part === 'cv') {
    item.cv = normalizeCv(newValue);
  } else {
    item.title = newValue;
  }
  saveState();
}

// ===== Card Mode Render =====
function renderCardMode() {
  const p = state.profile;
  
  // Helper: render a card panel
  function panel(label, content, fullWidth = false) {
    return `
      <div class="card-panel ${fullWidth ? 'full-width' : ''}">
        <div class="card-panel-label">${label}</div>
        <div class="card-panel-content">${content}</div>
      </div>
    `;
  }
  
  // Helper: editable text
  function editable(field, placeholder = '') {
    const val = state.profile[field] || '';
    return `<span class="editable-text" contenteditable="true" data-field="${field}" data-placeholder="${placeholder}">${escapeHtml(val)}</span>`;
  }
  
  // Helper: editable list field (array -> joined string, filter empty)
  function listEditable(field, placeholder = '', separator = '、') {
    const arr = Array.isArray(state.profile[field]) ? state.profile[field] : [];
    const val = arr.filter(s => s && s.trim()).join(separator);
    return `<span class="editable-text" contenteditable="true" data-field="${field}" data-placeholder="${placeholder}">${escapeHtml(val)}</span>`;
  }
  
  let html = `
    <div class="card-header">
      <div class="card-avatar-wrap">
        <div class="card-avatar">
          ${p.avatar ? `<img src="${p.avatar}" alt="avatar">` : `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>`}
        </div>
        <div class="card-avatar-edit" onclick="document.getElementById('cardAvatarInput').click()" title="更换头像">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <path d="m21 15-5-5L5 21"/>
          </svg>
        </div>
      </div>
      <div class="card-user-info">
        <div class="card-profile-kicker">PROFILE</div>
        <div class="card-user-name editable-text" contenteditable="true" data-field="name" data-placeholder="无名玩家">${escapeHtml(p.name || '')}</div>
        <div class="card-user-handle">
          ${p.accountType === 'bgm' 
            ? '<svg viewBox="0 0 1024 1024" fill="currentColor" width="14" height="14"><path d="M228.115 615.4a12.3 12.3 0 0 0 11.355 7.569 12.471 12.471 0 0 0 4.75-.965l147.61-61.883a12.3 12.3 0 0 0 .264-22.557l-147.61-66.235a12.3 12.3 0 1 0-10.067 22.444l121.74 54.634-121.456 50.907a12.3 12.3 0 0 0-6.586 16.085zm170.906 12.565H239.47a12.3 12.3 0 0 0 0 24.602h159.55a12.3 12.3 0 0 0 0-24.602zm0 39.495H239.47a12.3 12.3 0 0 0 0 24.602h159.55a12.3 12.3 0 0 0 0-24.602zm473.92-190.568l-133.283 58.382a12.3 12.3 0 0 0-.397 22.35l133.302 64.058a12.074 12.074 0 0 0 5.318 1.23 12.3 12.3 0 0 0 5.337-23.39l-109.156-52.42 108.834-47.633a12.3 12.3 0 1 0-9.954-22.577zm4.94 151.073H729.78a12.3 12.3 0 0 0 0 24.602h148.1a12.3 12.3 0 0 0 0-24.602zm0 39.495H729.78a12.3 12.3 0 0 0 0 24.602h148.1a12.3 12.3 0 0 0 0-24.602zM644.866 537.128h-162.92a12.282 12.282 0 0 0-10.71 18.32l81.374 145.13a12.3 12.3 0 0 0 21.46 0l81.375-145.13a12.3 12.3 0 0 0-10.73-18.32zm-81.374 132.3L503.047 561.73h120.889z"/><path d="M891.412 334.96H648.405c-6.813-15.14-19.814-28.386-36.864-38.019L803.092 19.284a12.3 12.3 0 0 0-20.249-13.966L588.566 286.873a147.723 147.723 0 0 0-45.418-7.002 151.508 151.508 0 0 0-31.887 3.369L239.98 4.712a12.3 12.3 0 0 0-17.543 17.164L485.164 291.68c-22.141 9.822-39.116 25.113-47.31 43.242H132.547a91.764 91.764 0 0 0-91.783 91.783v414.442a91.764 91.764 0 0 0 91.783 91.821h268.024l-19.908 46.989c-12.641 29.881 22.615 57.095 48.295 37.3l109.515-84.289h352.938a91.764 91.764 0 0 0 91.783-91.783V426.743a91.764 91.764 0 0 0-91.783-91.783zm34.84 463.816a60.71 60.71 0 0 1-60.71 60.709H585.671l-97.8 73.483-77.004 57.852 24.413-57.852 31.017-73.483H198.082a60.728 60.728 0 0 1-60.803-60.747V440.33a60.728 60.728 0 0 1 60.728-60.728h667.46a60.71 60.71 0 0 1 60.709 60.728z"/></svg>'
            : '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>'}
          <span>@</span>
          <span class="editable-text" contenteditable="true" data-field="handle" data-placeholder="用户名" style="display:inline;min-width:60px;outline:none;">${escapeHtml(p.handle || '')}</span>
        </div>
      </div>
    </div>
    <div class="card-grid" style="margin-top:16px;">
  `;
  
  // 喜欢的类型 - full width
  const genresText = p.genres && p.genres.length ? p.genres.join('・') : '';
  html += panel('喜欢的类型', `<span class="editable-text" contenteditable="true" data-field="genres" data-placeholder="输入内容">${escapeHtml(genresText)}</span>`, true);
  
  // 喜欢的厂商 - full width
  html += panel('喜欢的厂商', listEditable('brands', '输入内容'), true);
  
  // 喜欢的作品 - full width
  const worksText = p.works && p.works.length ? p.works.map(w => escapeHtml(w.title)).join('、') : '';
  html += panel('喜欢的作品', worksText || '<span style="color:#b0b0b0;">选择作品</span>', true);
  
  // 喜欢的女主角 - full width
  const heroinesText = p.heroines && p.heroines.length ? p.heroines.map(h => escapeHtml(h.title)).join('、') : '';
  html += panel('喜欢的女主角', heroinesText || '<span style="color:#b0b0b0;">选择角色</span>', true);
  
  // Galgame履历 - half
  html += panel('Galgame履历', editable('historyYears', '输入内容'), false);
  
  // 游玩数量 - half
  html += `
    <div class="card-panel">
      <div class="card-panel-label">游玩数量</div>
      <div class="card-panel-content" style="display:flex;align-items:baseline;gap:4px;">
        <span class="card-stat-number editable-text" contenteditable="true" data-field="playCount" data-placeholder="0">${escapeHtml(p.playCount || '')}</span>
        <span class="card-stat-unit">部</span>
      </div>
    </div>
  `;
  
  // 喜欢的剧本家 - full width
  html += panel('喜欢的剧本家', listEditable('writers', '输入内容'), true);
  
  // 喜欢的原画家 - half
  html += panel('喜欢的原画家', listEditable('artists', '输入内容'), false);
  
  // 喜欢的声优 - half
  html += panel('喜欢的声优', listEditable('voiceActors', '输入内容'), false);
  
  // 喜欢的Galgame歌曲 - half
  html += panel('喜欢的Galgame歌曲', listEditable('songs', '输入内容'), false);
  
  // 喜欢的属性 - half
  const attrText = p.attributes && p.attributes.length ? p.attributes.join('、') : '';
  html += panel('喜欢的属性', attrText || '<span style="color:#b0b0b0;">未设置标签</span>', false);
  
  // 其他 - full width
  html += panel('其他', editable('other', '输入内容'), true);
  
  html += '</div>';
  
  // Credit footer
  html += '<div class="card-credit">' +
    '<span class="footer-line"><span class="footer-label">原作者</span>小鳥遊俊</span>' +
    '<span class="footer-line"><span class="footer-label">参考来源</span>Bishoujo DB · 个人资料生成器</span>' +
    '<span class="footer-line"><span class="footer-label">中文版本制作</span>VNFest</span>' +
    '</div>';
  
  // Hidden avatar input
  html += '<input type="file" id="cardAvatarInput" accept="image/*" style="display:none" onchange="handleCardAvatar(event)">';
  
  return html;
}

// Handle card avatar upload
function handleCardAvatar(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    openAvatarCrop(event.target.result, 'card');
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

// Handle resume mode avatar upload
function handleResumeAvatar(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    openAvatarCrop(event.target.result, 'resume');
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

// Toggle avatar shape between square and circle
function toggleAvatarShape() {
  state.profile.avatarShape = state.profile.avatarShape === 'circle' ? 'square' : 'circle';
  saveState();
  renderResume();
}

// ===== Avatar drag-to-reposition (crop) =====
let avatarDragState = null;

function initAvatarDrag() {
  const avatar = document.querySelector('[data-avatar-container]');
  if (!avatar || !avatar.querySelector('img')) return;
  
  avatar.addEventListener('mousedown', handleAvatarMouseDown);
}

function handleAvatarMouseDown(e) {
  // Don't start drag if clicking on a button
  if (e.target.closest('button')) return;
  
  const avatar = e.currentTarget;
  const img = avatar.querySelector('img');
  if (!img) return;
  
  e.preventDefault();
  avatarDragState = {
    avatar: avatar,
    img: img,
    startX: e.clientX,
    startY: e.clientY,
    startPosX: state.profile.avatarPosX || 50,
    startPosY: state.profile.avatarPosY || 50
  };
  avatar.classList.add('dragging-avatar');
  
  document.addEventListener('mousemove', handleAvatarMouseMove);
  document.addEventListener('mouseup', handleAvatarMouseUp);
}

function handleAvatarMouseMove(e) {
  if (!avatarDragState) return;
  
  const { startX, startY, startPosX, startPosY, avatar } = avatarDragState;
  const rect = avatar.getBoundingClientRect();
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  
  // Convert pixel movement to percentage (avatar is 112px, but image may be larger)
  // Use a sensitivity factor
  const sensitivity = 100 / rect.width; // percent per pixel
  let newX = startPosX - dx * sensitivity;
  let newY = startPosY - dy * sensitivity;
  
  // Clamp to 0-100
  newX = Math.max(0, Math.min(100, newX));
  newY = Math.max(0, Math.min(100, newY));
  
  // Update image position in real-time
  const img = avatarDragState.img;
  img.style.objectPosition = `${newX}% ${newY}%`;
  
  // Store for saving on mouseup
  avatarDragState.currentX = newX;
  avatarDragState.currentY = newY;
}

function handleAvatarMouseUp(e) {
  if (!avatarDragState) return;
  
  const { avatar, currentX, currentY } = avatarDragState;
  avatar.classList.remove('dragging-avatar');
  
  if (currentX !== undefined && currentY !== undefined) {
    state.profile.avatarPosX = Math.round(currentX);
    state.profile.avatarPosY = Math.round(currentY);
    saveState();
  }
  
  avatarDragState = null;
  document.removeEventListener('mousemove', handleAvatarMouseMove);
  document.removeEventListener('mouseup', handleAvatarMouseUp);
}

// ===== Avatar Crop Modal =====
let avatarCropState = {
  imageSrc: null,
  mode: 'resume',
  scale: 1,
  posX: 0,
  posY: 0,
  shape: 'square',
  isDragging: false,
  startX: 0,
  startY: 0,
  imgNaturalWidth: 0,
  imgNaturalHeight: 0,
  baseWidth: 0,
  baseHeight: 0
};

function openAvatarCrop(imageSrc, mode) {
  avatarCropState = {
    imageSrc: imageSrc,
    mode: mode || 'resume',
    scale: 1,
    posX: 0,
    posY: 0,
    shape: state.profile.avatarShape || 'square',
    isDragging: false,
    startX: 0,
    startY: 0,
    imgNaturalWidth: 0,
    imgNaturalHeight: 0,
    baseWidth: 0,
    baseHeight: 0
  };
  
  const cropModal = document.getElementById('avatarCropModal');
  cropModal.classList.add('active');
  document.body.classList.add('avatar-crop-open');

  const img = document.getElementById('avatarCropImage');
  img.onload = function() {
    avatarCropState.imgNaturalWidth = this.naturalWidth;
    avatarCropState.imgNaturalHeight = this.naturalHeight;
    // Calculate the base size from the rendered crop area. Mobile uses a
    // shorter responsive area, so a hard-coded 320px would mis-size the image.
    const cropArea = document.getElementById('avatarCropArea');
    const areaHeight = cropArea.offsetHeight || 320;
    const areaWidth = cropArea.offsetWidth;
    const scaleByHeight = areaHeight / this.naturalHeight;
    const scaleByWidth = areaWidth / this.naturalWidth;
    const baseScale = Math.max(scaleByHeight, scaleByWidth);
    avatarCropState.baseWidth = this.naturalWidth * baseScale;
    avatarCropState.baseHeight = this.naturalHeight * baseScale;
    avatarCropState.scale = 1;
    avatarCropState.posX = 0;
    avatarCropState.posY = 0;
    updateAvatarCropDisplay();
  };
  // Set shape buttons
  document.querySelectorAll('.avatar-shape-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.shape === avatarCropState.shape);
  });
  document.getElementById('avatarCropFrame').classList.toggle('circle', avatarCropState.shape === 'circle');
  document.getElementById('avatarCropPreview').classList.toggle('circle', avatarCropState.shape === 'circle');
  
  // Reset zoom
  document.getElementById('avatarCropZoom').value = 1;
  document.getElementById('avatarCropZoomValue').textContent = '100%';
  
  img.src = imageSrc;
  
  // Setup drag events
  setupAvatarCropDrag();
}

function setupAvatarCropDrag() {
  const area = document.getElementById('avatarCropArea');
  area.onpointerdown = function(e) {
    if (e.target.closest('button') || e.target.closest('input')) return;
    avatarCropState.isDragging = true;
    avatarCropState.startX = e.clientX;
    avatarCropState.startY = e.clientY;
    area.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  document.onpointermove = function(e) {
    if (!avatarCropState.isDragging) return;
    const dx = e.clientX - avatarCropState.startX;
    const dy = e.clientY - avatarCropState.startY;
    avatarCropState.posX += dx;
    avatarCropState.posY += dy;
    avatarCropState.startX = e.clientX;
    avatarCropState.startY = e.clientY;
    updateAvatarCropDisplay();
  };
  document.onpointerup = function(e) {
    avatarCropState.isDragging = false;
    area.releasePointerCapture?.(e.pointerId);
  };
  document.onpointercancel = function() {
    avatarCropState.isDragging = false;
  };
}

function updateAvatarCropDisplay() {
  const img = document.getElementById('avatarCropImage');
  const w = avatarCropState.baseWidth * avatarCropState.scale;
  const h = avatarCropState.baseHeight * avatarCropState.scale;
  img.style.width = w + 'px';
  img.style.height = h + 'px';
  // Center + offset
  const area = document.getElementById('avatarCropArea');
  const areaW = area.offsetWidth;
  const areaH = area.offsetHeight;
  const left = (areaW - w) / 2 + avatarCropState.posX;
  const top = (areaH - h) / 2 + avatarCropState.posY;
  img.style.transform = 'none';
  img.style.left = left + 'px';
  img.style.top = top + 'px';
  
  // Update preview
  updateAvatarCropPreview();
}

function updateAvatarCropPreview() {
  const preview = document.getElementById('avatarCropPreview');
  const img = document.getElementById('avatarCropImage');
  if (!img.src) return;
  
  // Calculate the crop frame position relative to the image
  const area = document.getElementById('avatarCropArea');
  const frame = document.getElementById('avatarCropFrame');
  const areaRect = area.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  
  const frameLeft = frameRect.left - areaRect.left;
  const frameTop = frameRect.top - areaRect.top;
  const frameSize = frameRect.width;
  
  const imgLeft = parseFloat(img.style.left);
  const imgTop = parseFloat(img.style.top);
  const imgWidth = parseFloat(img.style.width);
  const imgHeight = parseFloat(img.style.height);
  
  // Calculate what part of the image is in the frame (as ratios)
  const cropX = (frameLeft - imgLeft) / imgWidth;
  const cropY = (frameTop - imgTop) / imgHeight;
  const cropSizeRatio = frameSize / imgWidth;
  
  // Preview size is 56px
  const previewSize = 56;
  // Background image size: scale so that crop area = previewSize
  const bgSize = previewSize / cropSizeRatio;
  // Background position: negative offset to align crop area with preview top-left
  const bgPosX = -cropX * bgSize;
  const bgPosY = -cropY * bgSize;
  
  preview.style.backgroundImage = `url(${img.src})`;
  preview.style.backgroundSize = `${bgSize}px ${bgSize * (imgHeight / imgWidth)}px`;
  preview.style.backgroundPosition = `${bgPosX}px ${bgPosY}px`;
  preview.style.backgroundRepeat = 'no-repeat';
}

function updateAvatarCropZoom(value) {
  avatarCropState.scale = parseFloat(value);
  document.getElementById('avatarCropZoom').value = value;
  document.getElementById('avatarCropZoomValue').textContent = Math.round(value * 100) + '%';
  updateAvatarCropDisplay();
}

function setAvatarCropShape(shape) {
  avatarCropState.shape = shape;
  document.querySelectorAll('.avatar-shape-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.shape === shape);
  });
  document.getElementById('avatarCropFrame').classList.toggle('circle', shape === 'circle');
  document.getElementById('avatarCropPreview').classList.toggle('circle', shape === 'circle');
  updateAvatarCropPreview();
}

function closeAvatarCrop() {
  document.getElementById('avatarCropModal').classList.remove('active');
  avatarCropState.isDragging = false;
  document.body.classList.remove('avatar-crop-open');
  document.onpointermove = null;
  document.onpointerup = null;
  document.onpointercancel = null;
  document.onmousemove = null;
  document.onmouseup = null;
}

function confirmAvatarCrop() {
  const img = document.getElementById('avatarCropImage');
  if (!img.src) { closeAvatarCrop(); return; }
  
  // Calculate crop area in image coordinates
  const area = document.getElementById('avatarCropArea');
  const frame = document.getElementById('avatarCropFrame');
  const areaRect = area.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  
  const frameLeft = frameRect.left - areaRect.left;
  const frameTop = frameRect.top - areaRect.top;
  const frameSize = frameRect.width;
  
  const imgLeft = parseFloat(img.style.left);
  const imgTop = parseFloat(img.style.top);
  const imgWidth = parseFloat(img.style.width);
  const imgHeight = parseFloat(img.style.height);
  
  // Convert to natural image coordinates
  const scaleX = avatarCropState.imgNaturalWidth / imgWidth;
  const scaleY = avatarCropState.imgNaturalHeight / imgHeight;
  
  const cropX = Math.max(0, (frameLeft - imgLeft) * scaleX);
  const cropY = Math.max(0, (frameTop - imgTop) * scaleY);
  const cropW = Math.min(frameSize * scaleX, avatarCropState.imgNaturalWidth - cropX);
  const cropH = Math.min(frameSize * scaleY, avatarCropState.imgNaturalHeight - cropY);
  
  // Create canvas and crop
  const canvas = document.createElement('canvas');
  const outputSize = 512;
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, outputSize, outputSize);
  
  const croppedDataUrl = canvas.toDataURL('image/png');
  
  // Save to state
  state.profile.avatar = croppedDataUrl;
  state.profile.avatarShape = avatarCropState.shape;
  state.profile.avatarPosX = 50;
  state.profile.avatarPosY = 50;
  saveState();
  renderResume();
  
  closeAvatarCrop();
}

// Toggle account platform between X/Twitter and Bangumi
function toggleAccountType() {
  const accountTypes = ['bgm', 'x', 'bilibili'];
  const currentType = normalizeAccountType(state.profile.accountType);
  const nextIndex = (accountTypes.indexOf(currentType) + 1) % accountTypes.length;
  state.profile.accountType = accountTypes[nextIndex];
  updateAccountPlatformControl();
  saveState();
  renderResume();
  if (state.popupEnabled) {
    showToast(`已切换为 ${getAccountPlatformLabel(state.profile.accountType)}`, 'success');
  }
}

// ===== Event Listeners =====
function attachEventListeners() {
  // Editable text
  document.querySelectorAll('.editable-text').forEach(el => {
    el.addEventListener('blur', handleEditableBlur);
    el.addEventListener('input', handleEditableInput);
  });
  
  // Drag and drop for items (thumb items and list items within same section)
  document.querySelectorAll('.thumb-item, .list-item').forEach(item => {
    item.addEventListener('dragstart', handleThumbDragStart);
    item.addEventListener('dragend', handleThumbDragEnd);
    item.addEventListener('dragover', handleThumbDragOver);
    item.addEventListener('dragleave', handleThumbDragLeave);
    item.addEventListener('drop', handleThumbDrop);
  });
  
  // Avatar drag-to-reposition
  initAvatarDrag();
}

function handleEditableBlur(e) {
  const field = e.target.dataset.field;
  if (field) {
    let value = e.target.textContent.trim();
    // Convert tag fields (genres, attributes) from string to array. A normal
    // space belongs to a custom type name; only visible separators create a
    // new type.
    if (field === 'genres' || field === 'attributes') {
      if (value) {
        value = value.split(/[・、,，\n]+/).map(t => t.trim()).filter(Boolean);
      } else {
        value = [];
      }
    }
    // Convert list fields (brands, voiceActors, artists, writers, songs) from string to array
    const listFields = ['brands', 'voiceActors', 'artists', 'writers', 'songs'];
    if (listFields.includes(field)) {
      if (value) {
        value = value.split(/[・、,，\n]+/).map(s => s.trim()).filter(Boolean);
      } else {
        value = [];
      }
    }
    state.profile[field] = value;
    saveState();
  }
}

function handleEditableInput(e) {
  const field = e.target.dataset.field;
  if (field) {
    let value = e.target.textContent.trim();
    // For tag fields, store as string temporarily during editing
    if (field === 'genres' || field === 'attributes') {
      state.profile[field] = value
        ? value.split(/[・、,，\n]+/).map(t => t.trim()).filter(Boolean)
        : [];
    } else {
      state.profile[field] = value;
    }
  }
}

// ===== Drag and Drop (items within same section - thumbs or lists) =====
let draggedThumb = null;
const DRAG_ITEM_SELECTOR = '.thumb-item, .list-item';

function handleThumbDragStart(e) {
  draggedThumb = e.target.closest(DRAG_ITEM_SELECTOR);
  if (!draggedThumb) return;
  draggedThumb.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', JSON.stringify({
    field: draggedThumb.dataset.field,
    index: parseInt(draggedThumb.dataset.itemIndex)
  }));
}

function handleThumbDragEnd(e) {
  if (draggedThumb) {
    draggedThumb.classList.remove('dragging');
  }
  document.querySelectorAll(DRAG_ITEM_SELECTOR).forEach(t => t.classList.remove('drag-over'));
  draggedThumb = null;
}

function handleThumbDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const target = e.target.closest(DRAG_ITEM_SELECTOR);
  if (target && target !== draggedThumb) {
    if (draggedThumb && target.dataset.field === draggedThumb.dataset.field) {
      target.classList.add('drag-over');
    }
  }
}

function handleThumbDragLeave(e) {
  const target = e.target.closest(DRAG_ITEM_SELECTOR);
  if (target) {
    target.classList.remove('drag-over');
  }
}

function handleThumbDrop(e) {
  e.preventDefault();
  const target = e.target.closest(DRAG_ITEM_SELECTOR);
  if (!target || !draggedThumb || target === draggedThumb) {
    document.querySelectorAll(DRAG_ITEM_SELECTOR).forEach(t => t.classList.remove('drag-over'));
    return;
  }
  
  if (target.dataset.field !== draggedThumb.dataset.field) {
    document.querySelectorAll(DRAG_ITEM_SELECTOR).forEach(t => t.classList.remove('drag-over'));
    return;
  }
  
  const field = target.dataset.field;
  const draggedIndex = parseInt(draggedThumb.dataset.itemIndex);
  const targetIndex = parseInt(target.dataset.itemIndex);
  
  if (draggedIndex > -1 && targetIndex > -1 && draggedIndex !== targetIndex) {
    const items = state.profile[field] || [];
    const [removed] = items.splice(draggedIndex, 1);
    items.splice(targetIndex, 0, removed);
    state.profile[field] = items;
    saveState();
    renderResume();
    if (state.popupEnabled) {
      showToast('已重新排序', 'success');
    }
  }
  
  document.querySelectorAll(DRAG_ITEM_SELECTOR).forEach(t => t.classList.remove('drag-over'));
}

// ===== Tag Management =====
function addTagFromInput(field, input) {
  const target = input || document.querySelector(`[data-tag-field="${field}"]`);
  const value = target?.value.trim() || '';
  if (!value) {
    target?.focus();
    return false;
  }
  if (!Array.isArray(state.profile[field])) state.profile[field] = [];
  if (!state.profile[field].includes(value)) state.profile[field].push(value);
  target.value = '';
  saveState();
  renderResume();
  requestAnimationFrame(() => document.querySelector(`[data-tag-field="${field}"]`)?.focus());
  return true;
}

function handleTagInput(e, field) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  e.stopPropagation();
  addTagFromInput(field, e.target);
}

function removeTag(field, index) {
  state.profile[field].splice(index, 1);
  saveState();
  renderResume();
}

// ===== Thumbnail Management =====
function removeThumb(field, index) {
  state.profile[field].splice(index, 1);
  saveState();
  renderResume();
}

// ===== Add Menu =====
let addMenuField = null;
let addMenuSearchType = null;

function openAddMenu(e, field, searchType) {
  e.stopPropagation();
  addMenuField = field;
  addMenuSearchType = searchType;
  
  const popup = document.getElementById('addMenuPopup');
  const anchor = e.currentTarget || e.target.closest?.('.thumb-add') || e.target;
  const rect = anchor.getBoundingClientRect();
  const popupWidth = Math.min(260, Math.max(180, window.innerWidth - 16));
  const left = Math.max(8, Math.min(window.innerWidth - popupWidth - 8, rect.left));
  const estimatedHeight = 108;
  const top = rect.bottom + 4;
  popup.style.width = `${popupWidth}px`;
  popup.style.left = `${left}px`;
  popup.style.right = 'auto';
  popup.style.top = `${Math.min(top, Math.max(8, window.innerHeight - estimatedHeight - 8))}px`;
  popup.classList.add('active');
}

function closeAddMenu() {
  document.getElementById('addMenuPopup').classList.remove('active');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.add-menu-popup') && !e.target.closest('.thumb-add')) {
    closeAddMenu();
  }
  if (!e.target.closest('.color-picker-popup') && !e.target.closest('.toolbar-mini-btn')) {
    document.getElementById('colorPickerPopup').classList.remove('active');
  }
});

function openSearchFromMenu() {
  closeAddMenu();
  openSearchModal(addMenuField, addMenuSearchType);
}

function addCustomItem() {
  closeAddMenu();
  document.getElementById('customImageInput').click();
}

// ===== Bangumi completed-game import =====
function bangumiImportApiUrl(params = {}) {
  const url = new URL(BANGUMI_ACCOUNT_API_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  return url.href;
}

function setBangumiImportStatus(text, type = '') {
  const element = document.getElementById('bangumiImportStatus');
  if (!element) return;
  element.textContent = text;
  element.dataset.state = type;
}

function getExistingBangumiIds() {
  const ids = new Set();
  (Array.isArray(state.profile?.works) ? state.profile.works : []).forEach(item => {
    const id = getBangumiIdFromWork(item);
    if (id > 0) ids.add(id);
  });
  return ids;
}

function renderBangumiImportResults() {
  const results = document.getElementById('bangumiImportResults');
  if (!results) return;
  if (!bangumiImportItems.length) {
    results.innerHTML = '<div class="modal-results-empty">没有找到已标记为“看过”的游戏。</div>';
    return;
  }

  const existingIds = getExistingBangumiIds();
  results.innerHTML = '<div class="bangumi-import-grid">' + bangumiImportItems.map(item => {
    const id = Number(item.bangumi_id || 0);
    const exists = existingIds.has(id);
    const checked = !exists && bangumiImportSelectedIds.has(id);
    const title = item.title_cn || item.title || `Bangumi #${id}`;
    const originalTitle = item.title && item.title !== title ? item.title : '';
    const image = getImageProxyUrl(item.image || '');
    return `<label class="bangumi-import-card${exists ? ' is-existing' : ''}">
      <input type="checkbox" value="${id}" ${checked ? 'checked' : ''} ${exists ? 'disabled' : ''} onchange="toggleBangumiImportSelection(${id}, this.checked)">
      <span class="bangumi-import-cover">${image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" onerror="this.closest('.bangumi-import-cover').classList.add('is-missing');this.remove()">` : '<span class="bangumi-import-cover-placeholder">BG</span>'}</span>
      <span class="bangumi-import-card-body">
        <strong>${escapeHtml(title)}</strong>
        ${originalTitle ? `<span>${escapeHtml(originalTitle)}</span>` : ''}
        <small>${exists ? '已在喜欢的作品中' : `Bangumi #${id}`}</small>
      </span>
    </label>`;
  }).join('') + '</div>';
  updateBangumiImportSelectionUi();
}

function updateBangumiImportSelectionUi() {
  const existingIds = getExistingBangumiIds();
  [...bangumiImportSelectedIds].forEach(id => {
    if (existingIds.has(id) || !bangumiImportItems.some(item => Number(item.bangumi_id) === id)) {
      bangumiImportSelectedIds.delete(id);
    }
  });
  const count = document.getElementById('bangumiImportSelectedCount');
  const confirm = document.getElementById('bangumiImportConfirm');
  if (count) count.textContent = String(bangumiImportSelectedIds.size);
  if (confirm) confirm.disabled = bangumiImportLoading || bangumiImportSelectedIds.size === 0;
}

async function openBangumiImportModal() {
  if (!sessionUser?.id) {
    showToast('请先登录 VNFmap 账号，再使用 Bangumi 导入', 'error');
    return;
  }
  if (!sessionUser.bangumi_bound) {
    if (window.confirm('当前账号尚未绑定 Bangumi，是否前往账号设置？')) {
      window.location.href = '../../user.html?tab=account';
    }
    return;
  }

  bangumiImportItems = [];
  bangumiImportSelectedIds = new Set();
  bangumiImportOffset = 0;
  bangumiImportHasMore = false;
  bangumiImportLoading = false;
  document.getElementById('bangumiImportModal')?.classList.add('active');
  setBangumiImportStatus('正在读取收藏…', 'loading');
  const results = document.getElementById('bangumiImportResults');
  if (results) results.innerHTML = '<div class="results-loading"><div class="loading-spinner"></div><p style="margin-top:8px;">正在读取 Bangumi 收藏…</p></div>';
  const loadMoreWrap = document.getElementById('bangumiImportLoadMoreWrap');
  if (loadMoreWrap) loadMoreWrap.hidden = true;
  updateBangumiImportSelectionUi();
  await loadBangumiImportPage(true);
}

function closeBangumiImportModal() {
  document.getElementById('bangumiImportModal')?.classList.remove('active');
  bangumiImportLoading = false;
}

async function loadBangumiImportPage(reset = false) {
  if (bangumiImportLoading || (!reset && !bangumiImportHasMore)) return;
  bangumiImportLoading = true;
  updateBangumiImportSelectionUi();
  const offset = reset ? 0 : bangumiImportOffset;
  try {
    const result = await fetchJson(bangumiImportApiUrl({ action: 'collections', limit: 100, offset }));
    if (!result.ok || !result.success) throw new Error(result.message || '读取 Bangumi 收藏失败');
    const incoming = Array.isArray(result.items) ? result.items : [];
    const seen = new Set(bangumiImportItems.map(item => Number(item.bangumi_id)));
    incoming.forEach(item => {
      const id = Number(item.bangumi_id || 0);
      if (id > 0 && !seen.has(id)) {
        seen.add(id);
        bangumiImportItems.push(item);
        if (!getExistingBangumiIds().has(id)) bangumiImportSelectedIds.add(id);
      }
    });
    const pagination = result.pagination || {};
    bangumiImportOffset = offset + incoming.length;
    bangumiImportHasMore = Boolean(pagination.has_more) && incoming.length > 0;
    const total = Number(pagination.total || bangumiImportItems.length);
    setBangumiImportStatus(`${bangumiImportItems.length}${total ? ` / ${total}` : ''} 项已加载`, 'ready');
    renderBangumiImportResults();
    const loadMoreWrap = document.getElementById('bangumiImportLoadMoreWrap');
    const loadMore = document.getElementById('bangumiImportLoadMore');
    if (loadMoreWrap) loadMoreWrap.hidden = !bangumiImportHasMore;
    if (loadMore) loadMore.disabled = false;
  } catch (error) {
    setBangumiImportStatus(error.message || '读取失败', 'error');
    if (!bangumiImportItems.length) {
      const results = document.getElementById('bangumiImportResults');
      if (results) results.innerHTML = `<div class="modal-results-empty is-error">${escapeHtml(error.message || '暂时无法读取 Bangumi 收藏')}</div>`;
    }
  } finally {
    bangumiImportLoading = false;
    updateBangumiImportSelectionUi();
  }
}

function toggleBangumiImportSelection(id, checked) {
  const numericId = Number(id);
  if (checked) bangumiImportSelectedIds.add(numericId);
  else bangumiImportSelectedIds.delete(numericId);
  updateBangumiImportSelectionUi();
}

function selectAllBangumiImport() {
  const existingIds = getExistingBangumiIds();
  bangumiImportItems.forEach(item => {
    const id = Number(item.bangumi_id || 0);
    if (id > 0 && !existingIds.has(id)) bangumiImportSelectedIds.add(id);
  });
  renderBangumiImportResults();
}

function clearBangumiImportSelection() {
  bangumiImportSelectedIds.clear();
  renderBangumiImportResults();
}

function confirmBangumiImport() {
  const existingIds = getExistingBangumiIds();
  const selected = bangumiImportItems.filter(item => {
    const id = Number(item.bangumi_id || 0);
    return id > 0 && bangumiImportSelectedIds.has(id) && !existingIds.has(id);
  });
  if (!selected.length) {
    showToast('请选择需要导入的作品', 'error');
    return;
  }
  if (!Array.isArray(state.profile.works)) state.profile.works = [];
  selected.forEach(item => {
    const id = Number(item.bangumi_id);
    state.profile.works.push({
      title: item.title_cn || item.title || `Bangumi #${id}`,
      image: getImageProxyUrl(item.image || ''),
      source: 'bangumi',
      id: `bgm_vn_${id}`,
      bangumiId: id,
      cv: ''
    });
  });
  saveState();
  renderResume();
  closeBangumiImportModal();
  showToast(`已导入 ${selected.length} 项 Bangumi 已玩作品`, 'success');
}

function handleCustomImage(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = (event) => {
    const title = prompt('请输入项目名称:', file.name.replace(/\.[^/.]+$/, ''));
    if (title && addMenuField) {
      if (!state.profile[addMenuField]) state.profile[addMenuField] = [];
      state.profile[addMenuField].push({
        title: title,
        image: event.target.result,
        source: 'custom'
      });
      saveState();
      renderResume();
      showToast('已添加自定义项目', 'success');
    }
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

// ===== Search Modal =====
function openSearchModal(field, searchType) {
  addMenuSearchType = searchType;
  state.currentSearchField = field;
  state.selectedItems = [];
  state.searchResults = [];
  
  const title = searchType === 'character' ? '选择喜欢的角色' : '选择喜欢的作品';
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalSearchInput').value = '';
  document.getElementById('modalResults').innerHTML = '<div class="modal-results-empty">输入作品名或厂商名搜索，或选择发售年份</div>';
  updateSelectedCount();
  updateApiSourceUI();
  document.getElementById('searchModal').classList.add('active');
  document.body.classList.add('search-modal-open');
  
  setTimeout(() => document.getElementById('modalSearchInput').focus(), 100);
}

function closeModal() {
  cancelActiveSearch();
  document.getElementById('searchModal').classList.remove('active');
  document.body.classList.remove('search-modal-open');
  state.currentSearchField = null;
  state.selectedItems = [];
}

document.getElementById('searchModal').addEventListener('click', (e) => {
  if (e.target.id === 'searchModal') closeModal();
});

function setFilter(filter) {
  state.currentFilter = filter;
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.filter === filter);
  });
  if (document.getElementById('modalSearchInput').value.trim()) {
    performSearch();
  }
}

function handleSearchInput(e) {
  clearTimeout(state.searchDebounce);
  const query = e.target.value.trim();
  if (query.length >= 2) {
    state.searchDebounce = setTimeout(() => performSearch(), 280);
  } else if (query.length === 0) {
    cancelActiveSearch();
    state.searchResults = [];
    document.getElementById('modalResults').innerHTML = '<div class="modal-results-empty">输入作品名或厂商名搜索，或选择发售年份</div>';
  } else {
    cancelActiveSearch();
    state.searchResults = [];
    document.getElementById('modalResults').innerHTML = '<div class="modal-results-empty">请输入至少 2 个字符</div>';
  }
}

// ===== API Source Selection =====
function toggleApiSource(api) {
  if (api === 'vndb' && addMenuSearchType === 'character') {
    return;
  }
  const idx = state.enabledApis.indexOf(api);
  if (idx > -1) {
    state.enabledApis.splice(idx, 1);
  } else {
    state.enabledApis.push(api);
  }
  saveState();
  updateApiSourceUI();
}

function updateApiSourceUI() {
  document.querySelectorAll('.api-source-chip[data-api]').forEach(chip => {
    const api = chip.dataset.api;
    const disabledForCharacter = api === 'vndb' && addMenuSearchType === 'character';
    chip.hidden = disabledForCharacter;
    chip.setAttribute('aria-hidden', String(disabledForCharacter));
    if (state.enabledApis.includes(api)) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });
}

// ===== Perform Search =====
function cancelActiveSearch() {
  if (activeSearchController) {
    activeSearchController.abort();
    activeSearchController = null;
  }
  searchGeneration += 1;
}

function isSearchAborted(error, signal) {
  return Boolean(signal?.aborted || error?.name === 'AbortError');
}

function mergeSearchResults(items) {
  const sourceOrder = { bangumi: 0, vndb: 1, cngal: 2 };
  const resultMap = new Map(state.searchResults.map(item => [item.id, item]));
  (Array.isArray(items) ? items : []).forEach(item => {
    if (item?.id) resultMap.set(item.id, item);
  });
  state.searchResults = [...resultMap.values()].sort((a, b) => {
    const sourceDiff = (sourceOrder[a.source] ?? 99) - (sourceOrder[b.source] ?? 99);
    return sourceDiff || String(a.title || '').localeCompare(String(b.title || ''));
  });
}

function buildCharacterSub(originalName, cv) {
  return [originalName, cv ? `CV ${cv}` : ''].filter(Boolean).join(' · ');
}

async function prefetchBangumiCharacterCvs(items, requestId, signal) {
  const candidates = (Array.isArray(items) ? items : [])
    .filter(item => item?.source === 'bangumi' && item.bangumiId && !item.cv)
    .slice(0, CHARACTER_CV_PREFETCH_LIMIT);
  if (!candidates.length) return;

  await mapWithConcurrency(candidates, CHARACTER_CV_PREFETCH_CONCURRENCY, async item => {
    if (isSearchAborted(null, signal)) return;
    try {
      const cv = await fetchBangumiCharacterCv(item.bangumiId, signal);
      if (cv && requestId === searchGeneration && !signal?.aborted) {
        item.cv = cv;
        item.sub = buildCharacterSub(item.originalName, cv);
        renderSearchResults();
      }
    } catch (error) {
      if (!isSearchAborted(error, signal)) console.warn('Bangumi character CV prefetch failed:', error);
    }
  });
}

async function performSearch() {
  const query = document.getElementById('modalSearchInput').value.trim();
  const year = document.getElementById('yearSelect').value;
  const searchType = addMenuSearchType || 'vn';
  
  if (!query && !year) {
    cancelActiveSearch();
    state.searchResults = [];
    return;
  }

  cancelActiveSearch();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const signal = controller?.signal;
  activeSearchController = controller;
  const requestId = searchGeneration;
  
  const resultsEl = document.getElementById('modalResults');
  resultsEl.innerHTML = '<div class="results-loading"><div class="loading-spinner"></div><p style="margin-top:8px;">搜索中...</p></div>';
  state.searchResults = [];
  
  // Render each source as soon as it returns instead of waiting for the
  // slowest API. Character CV enrichment is intentionally deferred so the
  // initial result list is not blocked by one request per character.
  const searchTasks = [];
  const options = { signal, deferCharacterCv: searchType === 'character' };
  const apiMap = { bangumi: searchBangumi, vndb: searchVNDB };
  ['bangumi', 'vndb'].forEach(api => {
    if (api === 'vndb' && searchType === 'character') return;
    if (state.enabledApis.includes(api) && apiMap[api]) {
      searchTasks.push(() => apiMap[api](query, year, searchType, options));
    }
  });
  searchTasks.push(() => searchCnGal(query, year, searchType, options));

  await Promise.all(searchTasks.map(async runSearch => {
    try {
      const results = await runSearch();
      if (requestId !== searchGeneration || signal?.aborted) return;
      mergeSearchResults(results);
      if (state.searchResults.length) {
        renderSearchResults();
        if (searchType === 'character') {
          void prefetchBangumiCharacterCvs(results, requestId, signal);
        }
      }
    } catch (error) {
      if (!isSearchAborted(error, signal)) console.warn('Search source failed:', error);
    }
  }));

  if (requestId === searchGeneration && !signal?.aborted && state.searchResults.length === 0) {
    renderSearchResults();
  }
  if (activeSearchController === controller) activeSearchController = null;
}

// ===== Image source normalization =====
// Search APIs return CDN URLs from different origins. Keep the URL in the
// resume data, but route known Bangumi/VNDB image hosts through our same-origin
// proxy so the browser can render and html2canvas can export them reliably.
function getImageProxyUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value, document.baseURI);
    if (parsed.origin === location.origin && parsed.pathname.endsWith('/api/image_proxy.php')) {
      return value;
    }
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && IMAGE_PROXY_HOSTS.has(parsed.hostname.toLowerCase())) {
      return `${IMAGE_PROXY_URL}?url=${encodeURIComponent(parsed.href)}`;
    }
  } catch (error) {
    console.warn('Invalid image URL:', value, error);
  }
  return value;
}

// ===== Bangumi API =====
async function fetchBangumiProxy(action, params = {}, options = {}) {
  const url = new URL(BANGUMI_PROXY_URL);
  url.searchParams.set('action', action);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  const result = await fetchJson(url.href, options);
  if (isSearchAborted(result.error, options.signal)) throw result.error || new DOMException('Aborted', 'AbortError');
  if (!result.ok || !result.success) {
    throw new Error(result.message || `Bangumi proxy action failed: ${action}`);
  }
  return result;
}

async function searchBangumi(query, year, searchType, options = {}) {
  const isCharacter = searchType === 'character';
  const { signal, deferCharacterCv = false } = options;
  try {
    const data = await fetchBangumiProxy(isCharacter ? 'search_character' : 'search', {
      keyword: query,
      type: isCharacter ? undefined : 4,
      limit: isCharacter ? CHARACTER_SEARCH_RESULT_LIMIT : 25
    }, { signal });

    if (isCharacter) {
      const characterItems = Array.isArray(data.data) ? data.data : [];
      return mapWithConcurrency(characterItems, 4, async item => {
        const cv = normalizeCv(item.cv || '') || (deferCharacterCv ? '' : await fetchBangumiCharacterCv(item.character_id, signal));
        const originalName = item.name && item.name_cn && item.name !== item.name_cn ? item.name : '';
        return {
          id: 'bgm_char_' + item.character_id,
          bangumiId: item.character_id,
          title: item.name_cn || item.name || 'Unknown',
          image: getImageProxyUrl(item.image_url || item.image_url_raw || ''),
          source: 'bangumi',
          sourceLabel: 'Bangumi',
          cv,
          originalName,
          sub: buildCharacterSub(originalName, cv)
        };
      });
    }

    return (data.data || []).map(item => ({
      id: 'bgm_vn_' + item.bangumi_id,
      bangumiId: item.bangumi_id,
      title: item.title_cn || item.title || 'Unknown',
      image: getImageProxyUrl(item.image_url || ''),
      source: 'bangumi',
      sourceLabel: 'Bangumi',
      sub: [item.title && item.title_cn && item.title !== item.title_cn ? item.title : '', item.air_date || '']
        .filter(Boolean).join(' · ')
    }));
  } catch (proxyError) {
    if (isSearchAborted(proxyError, signal)) throw proxyError;
    // Keep the static test server and older installations usable while
    // preferring the same server-side proxy as club_manager.html in public.
    console.warn('Bangumi proxy search failed, using direct API fallback:', proxyError);
    return searchBangumiDirect(query, year, searchType, options);
  }
}

async function searchBangumiDirect(query, year, searchType, options = {}) {
  try {
    const isCharacter = searchType === 'character';
    const { signal, deferCharacterCv = false } = options;
    const endpoint = isCharacter
      ? 'https://api.bgm.tv/v0/search/characters'
      : 'https://api.bgm.tv/v0/search/subjects';
    const body = isCharacter ? {
      keyword: query,
      filter: { nsfw: true },
      limit: isCharacter ? CHARACTER_SEARCH_RESULT_LIMIT : 25
    } : {
      keyword: query,
      filter: {
        type: [4],
        ...(year ? { date: [`>=${year}-01-01`, `<=${year}-12-31`] } : {})
      },
      limit: 25
    };
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      signal,
      body: JSON.stringify(body)
    });
    if (!response.ok) return [];
    const data = await response.json();
    if (isCharacter) {
      return mapWithConcurrency(data.data || [], 4, async item => {
        const inlineCv = extractCvFromInfobox(item.infobox) || extractCvFromText(item.summary);
        const cv = inlineCv || (deferCharacterCv ? '' : await fetchBangumiCharacterCv(item.id, signal));
        const originalName = item.name && item.name_cn && item.name !== item.name_cn ? item.name : '';
        return {
          id: 'bgm_char_' + item.id,
          bangumiId: item.id,
          title: item.name_cn || item.name || 'Unknown',
          image: getImageProxyUrl(item.images ? (item.images.large || item.images.medium || item.images.common || '') : ''),
          source: 'bangumi',
          sourceLabel: 'Bangumi',
          cv,
          originalName,
          sub: buildCharacterSub(originalName, cv)
        };
      });
    }
    return (data.data || []).map(item => ({
      id: 'bgm_vn_' + item.id,
      bangumiId: item.id,
      title: item.name_cn || item.name || 'Unknown',
      image: getImageProxyUrl(item.images ? (item.images.large || item.images.medium || item.images.common || '') : ''),
      source: 'bangumi',
      sourceLabel: 'Bangumi',
      sub: item.name && item.name_cn && item.name !== item.name_cn ? item.name : ''
    }));
  } catch (error) {
    if (isSearchAborted(error, options.signal)) throw error;
    console.warn('Bangumi direct search failed:', error);
    return [];
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const values = Array.isArray(items) ? items : [];
  const results = new Array(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency || 1), values.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index], index);
    }
  }));

  return results;
}

async function fetchBangumiCharacterCv(characterId, signal) {
  if (!characterId) return '';
  const cacheKey = String(characterId);
  if (bangumiCvCache.has(cacheKey)) return bangumiCvCache.get(cacheKey);
  try {
    const proxy = await fetchJson(`${BANGUMI_PROXY_URL}?action=character_persons&id=${encodeURIComponent(characterId)}`, { signal });
    if (isSearchAborted(proxy.error, signal)) throw proxy.error || new DOMException('Aborted', 'AbortError');
    if (proxy.ok && proxy.success) {
      const proxyValue = proxy.data?.cv || proxy.cv || '';
      if (proxyValue) {
        const value = normalizeCv(proxyValue);
        bangumiCvCache.set(cacheKey, value);
        return value;
      }
    }
  } catch (err) {
    console.warn('Bangumi proxy character CV lookup failed:', err);
  }
  try {
    const response = await fetch(`https://api.bgm.tv/v0/characters/${encodeURIComponent(characterId)}/persons`, {
      headers: {
        'Accept': 'application/json',
      },
      signal
    });
    if (!response.ok) return '';
    const people = await response.json();
    if (!Array.isArray(people)) return '';

    const names = people
      .filter(person => person && (person.type === undefined || person.type === 1))
      .map(person => person.name || person.name_cn || '')
      .map(normalizeCv)
      .filter(Boolean);
    const value = [...new Set(names)].join('、');
    bangumiCvCache.set(cacheKey, value);
    return value;
  } catch (err) {
    if (isSearchAborted(err, signal)) throw err;
    console.warn('Bangumi character CV lookup failed:', err);
    return '';
  }
}

function extractMaker(infobox) {
  if (!Array.isArray(infobox)) return '';
  const maker = infobox.find(i => i.key === '开发商' || i.key === 'メーカー' || i.key === '开发');
  return maker ? (typeof maker.value === 'string' ? maker.value : JSON.stringify(maker.value)) : '';
}

function normalizeCv(value) {
  if (Array.isArray(value)) value = value.join('、');
  return String(value || '')
    .replace(/^\s*(?:CV|声优|配音)\s*[:：]?\s*/i, '')
    .trim();
}

function extractCvFromText(text) {
  if (!text) return '';
  const match = String(text).match(/(?:CV|声优|配音)\s*[:：]?\s*([^\n]+)/i);
  return match ? normalizeCv(match[1]) : '';
}

function extractCvFromInfobox(infobox) {
  if (!Array.isArray(infobox)) return '';
  const cvInfo = infobox.find(item =>
    item && typeof item.key === 'string' && /^(?:CV|声优|配音)$/i.test(item.key.trim())
  );
  return cvInfo ? normalizeCv(cvInfo.value) : '';
}

function extractCvFromCnGalEntry(entry) {
  if (!entry || !Array.isArray(entry.addInfors)) return '';
  const voiceInfo = entry.addInfors.find(info =>
    info && typeof info.modifier === 'string' && /^(?:CV|声优|配音)$/i.test(info.modifier.trim())
  );
  if (!voiceInfo || !Array.isArray(voiceInfo.contents)) return '';
  return normalizeCv(voiceInfo.contents.map(content => {
    if (typeof content === 'string') return content;
    return content?.displayName || content?.name || content?.value || '';
  }).filter(Boolean));
}

// ===== VNDB API =====
async function searchVNDB(query, year, searchType, options = {}) {
  // VNDB character search is intentionally disabled. Its character data is
  // not useful for this editor and the extra remote request makes the mobile
  // picker feel slow. VNDB remains available for work searches.
  if (searchType === 'character') return [];
  try {
    const { signal } = options;
    const endpoint = 'https://api.vndb.org/kana/vn';
    
    // `released` is a VN-only filter and is only applied for work searches.
    const filters = year
      ? ["and",
        ["search", "=", query],
        ["released", ">=", `${year}-01-01`],
        ["released", "<=", `${year}-12-31`]
      ]
      : ["search", "=", query];
    
    const body = {
      filters: filters,
      fields: 'id,title,alttitle,image.url,image.sexual,image.violence,developers.name',
      sort: 'searchrank',
      results: 25
    };
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal,
      body: JSON.stringify(body)
    });
    
    if (!response.ok) return [];
    const data = await response.json();
    
    return (data.results || []).map(item => ({
      id: 'vndb_vn_' + item.id,
      title: item.title || item.alttitle || 'Unknown',
      image: getImageProxyUrl(item.image?.url || item.image?.thumbnail || ''),
      source: 'vndb',
      sourceLabel: 'VNDB',
      sub: item.developers ? item.developers.map(d => d.name).join(', ') : ''
    }));
  } catch(err) {
    if (isSearchAborted(err, options.signal)) throw err;
    console.warn('VNDB search failed:', err);
    return [];
  }
}

// ===== CnGal API =====
async function searchCnGal(query, year, searchType, options = {}) {
  try {
    const { signal } = options;
    const isCharacter = searchType === 'character';
    const typeParam = isCharacter ? 'Role' : 'Game';
    const encodedQuery = encodeURIComponent(query);
    const url = `https://api.cngal.org/api/home/Search?Page=1&Types=${typeParam}&Text=${encodedQuery}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      },
      signal
    });
    
    if (!response.ok) return [];
    const data = await response.json();
    const items = data?.pagedResultDto?.data || [];
    
    return items
      .filter(item => item.entry && item.entry.type === typeParam)
      .map(item => {
        const entry = item.entry;
        return {
          id: 'cngal_' + (isCharacter ? 'char_' : 'vn_') + entry.id,
          title: entry.name || 'Unknown',
          image: getImageProxyUrl(entry.mainImage || ''),
          source: 'cngal',
          sourceLabel: 'CnGal',
          cv: isCharacter ? extractCvFromCnGalEntry(entry) : '',
          sub: [
            (entry.briefIntroduction || '').substring(0, 50),
            isCharacter && extractCvFromCnGalEntry(entry) ? `CV ${extractCvFromCnGalEntry(entry)}` : ''
          ].filter(Boolean).join(' · ')
        };
      });
  } catch(err) {
    if (isSearchAborted(err, options.signal)) throw err;
    console.warn('CnGal search failed:', err);
    return [];
  }
}


// ===== Render Search Results =====
function renderSearchResults() {
  const resultsEl = document.getElementById('modalResults');
  
  if (state.searchResults.length === 0) {
    resultsEl.innerHTML = '<div class="modal-results-empty">没有找到搜索结果。请尝试其他关键词。</div>';
    return;
  }
  
  let html = '<div class="result-grid' + (addMenuSearchType === 'character' ? ' character-mode' : '') + '">';
  state.searchResults.forEach(item => {
    const isSelected = state.selectedItems.some(s => s.id === item.id);
    const imageSrc = getImageProxyUrl(item.image);
    html += `
      <div class="result-card ${isSelected ? 'selected' : ''}" onclick="toggleSelectItem('${item.id}')">
        <span class="result-card-source ${item.source}">${item.sourceLabel}</span>
        ${imageSrc ? `<img class="result-card-image" src="${escapeHtml(imageSrc)}" alt="${escapeHtml(item.title)}" loading="lazy" onerror="this.style.display='none'">` : '<div class="result-card-image" style="display:flex;align-items:center;justify-content:center;"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="11" x2="10" y2="11"/><line x1="8" y1="9" x2="8" y2="13"/><line x1="15" y1="12" x2="15.01" y2="12"/><line x1="18" y1="10" x2="18.01" y2="10"/><rect x="2" y="6" width="20" height="12" rx="2"/></svg></div>'}
        <div class="result-card-info">
          <div class="result-card-title">${escapeHtml(item.title)}</div>
          ${item.sub ? `<div class="result-card-sub">${escapeHtml(item.sub)}</div>` : ''}
        </div>
      </div>
    `;
  });
  html += '</div>';
  resultsEl.innerHTML = html;
}

function toggleSelectItem(id) {
  const maxItems = state.moreItems ? 30 : 15;
  const idx = state.selectedItems.findIndex(s => s.id === id);
  
  if (idx > -1) {
    state.selectedItems.splice(idx, 1);
  } else {
    if (state.selectedItems.length >= maxItems) {
      showToast(`最多可选择 ${maxItems} 项`, 'error');
      return;
    }
    const item = state.searchResults.find(r => r.id === id);
    if (item) state.selectedItems.push(item);
  }
  
  updateSelectedCount();
  renderSearchResults();
}

function updateSelectedCount() {
  document.getElementById('selectedCount').textContent = state.selectedItems.length;
}

async function confirmSelection() {
  if (state.currentSearchField && state.selectedItems.length > 0) {
    if (!state.profile[state.currentSearchField]) {
      state.profile[state.currentSearchField] = [];
    }
    const selectedItems = await Promise.all(state.selectedItems.map(async item => {
      let cv = state.currentSearchField === 'heroines' ? normalizeCv(item.cv || '') : '';
      if (!cv && state.currentSearchField === 'heroines' && item.bangumiId) {
        cv = await fetchBangumiCharacterCv(item.bangumiId);
      }
      return {
        title: item.title,
        image: getImageProxyUrl(item.image),
        source: item.source,
        id: item.id,
        cv,
        ...(Number(item.bangumiId || item.bangumi_id || 0) > 0
          ? { bangumiId: Number(item.bangumiId || item.bangumi_id) }
          : {})
      };
    }));
    selectedItems.forEach(item => state.profile[state.currentSearchField].push(item));
    saveState();
    renderResume();
    showToast(`已添加 ${selectedItems.length} 项`, 'success');
  }
  closeModal();
}

// ===== Color Picker =====
const sectionColors = ['#ffffff', '#fff5f5', '#f0f7ff', '#f5fff0', '#fffbf0', '#f5f0ff', '#fff0f5'];

function openColorPicker(btn) {
  const popup = document.getElementById('colorPickerPopup');
  const rect = btn.getBoundingClientRect();
  popup.style.left = rect.left + 'px';
  popup.style.top = (rect.bottom + 4) + 'px';
  
  const row = document.getElementById('colorSwatchRow');
  row.innerHTML = '';
  sectionColors.forEach(color => {
    const swatch = document.createElement('div');
    swatch.className = 'color-swatch';
    swatch.style.background = color;
    swatch.style.border = color === '#ffffff' ? '1px solid #ddd' : '2px solid transparent';
    swatch.onclick = () => {
      const section = btn.closest('.resume-section');
      if (section) {
        section.style.background = color;
      }
      popup.classList.remove('active');
    };
    row.appendChild(swatch);
  });
  
  popup.classList.add('active');
}

// ===== Section Management =====
function removeSection(id) {
  if (id === 'name') {
    showToast('姓名项目无法删除', 'error');
    return;
  }
  if (confirm('确定要删除此项目吗？')) {
    state.sections = state.sections.filter(s => s.id !== id);
    saveState();
    renderResume();
    showToast('已删除项目', 'success');
  }
}

// ===== Image Base64 Conversion (for html2canvas cross-origin fix) =====
async function convertImageToBase64(img, timeout = 15000) {
  return new Promise((resolve) => {
    if (!img.src || img.src.startsWith('data:') || img.src.startsWith('blob:')) {
      resolve();
      return;
    }
    
    const originalSrc = img.src;
    let settled = false;
    
    const timeoutId = setTimeout(() => {
      if (!settled) { settled = true; console.warn('Image conversion timeout:', originalSrc); resolve(); }
    }, timeout);
    
    function applyBase64(dataUrl) {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        img.dataset.originalSrc = originalSrc;
        let imageSettled = false;
        const finishImage = () => {
          if (imageSettled) return;
          imageSettled = true;
          img.onload = null;
          img.onerror = null;
          resolve();
        };
        img.onload = finishImage;
        img.onerror = finishImage;
        img.src = dataUrl;
        if (typeof img.decode === 'function') {
          img.decode().then(finishImage).catch(finishImage);
        } else if (img.complete) {
          finishImage();
        }
        // A broken/unsupported decoder must not block the whole export.
        setTimeout(finishImage, 5000);
      }
    }
    
    function blobToBase64(blob) {
      return new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onloadend = () => res(reader.result);
        reader.onerror = rej;
        reader.readAsDataURL(blob);
      });
    }
    
    // List of proxy URLs to try (in order)
    const proxies = [
      // Old local drafts may still contain raw Bangumi URLs. Reuse the same
      // server-side image proxy as the Bangumi search results so html2canvas
      // receives a same-origin, non-tainted image.
      (url) => /^(?:https?:\/\/lain\.bgm\.tv\/(?:r\/\d+\/)?pic\/|https?:\/\/(?:t|s)\.vndb\.org\/)/i.test(url)
        ? `${IMAGE_PROXY_URL}?url=${encodeURIComponent(url)}`
        : '',
      (url) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
      (url) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url),
      (url) => 'https://thingproxy.freeboard.io/fetch/' + url,
    ];
    
    async function tryProxies(index) {
      if (settled || index >= proxies.length) {
        if (!settled) { settled = true; clearTimeout(timeoutId); resolve(); }
        return;
      }
      try {
        const proxyUrl = proxies[index](originalSrc);
        if (!proxyUrl) return tryProxies(index + 1);
        const res = await fetch(proxyUrl);
        if (!res.ok) throw new Error('Proxy ' + index + ' failed: ' + res.status);
        const blob = await res.blob();
        if (blob.size > 0) {
          const dataUrl = await blobToBase64(blob);
          applyBase64(dataUrl);
          return;
        }
        throw new Error('Empty blob');
      } catch(e) {
        console.warn('Proxy ' + index + ' failed:', e.message);
        await tryProxies(index + 1);
      }
    }
    
    // First try direct fetch with CORS (works if server supports CORS)
    fetch(originalSrc, { mode: 'cors' })
      .then(res => {
        if (!res.ok) throw new Error('Direct fetch failed');
        return res.blob();
      })
      .then(blob => blobToBase64(blob))
      .then(dataUrl => applyBase64(dataUrl))
      .catch(() => {
        // Direct fetch failed, try proxies
        tryProxies(0);
      });
  });
}

async function convertAllImagesToBase64(container) {
  const images = container.querySelectorAll('img');
  const tasks = [];
  images.forEach(img => {
    if (img.src && !img.src.startsWith('data:') && !img.src.startsWith('blob:')) {
      tasks.push(convertImageToBase64(img));
    }
  });
  if (tasks.length > 0) {
    await Promise.all(tasks);
  }
}

function waitForImageReady(img, timeout = 5000) {
  if (!img || !img.src || (img.complete && img.naturalWidth > 0)) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      img.onload = null;
      img.onerror = null;
      resolve();
    };
    img.addEventListener('load', finish, { once: true });
    img.addEventListener('error', finish, { once: true });
    setTimeout(finish, timeout);
  });
}

function parseExportObjectPosition(value) {
  const tokens = String(value || '50% 50%').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 1) tokens.push('50%');
  const resolve = (token, axis) => {
    const normalized = String(token).toLowerCase();
    if (normalized === 'center') return 0.5;
    if (normalized === (axis === 'x' ? 'left' : 'top')) return 0;
    if (normalized === (axis === 'x' ? 'right' : 'bottom')) return 1;
    const percent = Number.parseFloat(normalized);
    return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) / 100 : 0.5;
  };
  return { x: resolve(tokens[0], 'x'), y: resolve(tokens[1], 'y') };
}

function getExportImageFrame(img) {
  return img.closest('.thumb-image-frame, .resume-avatar, .card-avatar');
}

async function prepareExportImageLayout(container) {
  const images = [...container.querySelectorAll('img')];
  await Promise.all(images.map(async img => {
    const frame = getExportImageFrame(img);
    if (!frame || !img.src) return;
    await waitForImageReady(img);
    if (!img.naturalWidth || !img.naturalHeight) return;

    const frameRect = frame.getBoundingClientRect();
    const targetWidth = Math.max(1, Math.round(frameRect.width * 2));
    const targetHeight = Math.max(1, Math.round(frameRect.height * 2));
    const imageStyle = getComputedStyle(img);
    const frameStyle = getComputedStyle(frame);
    const fit = imageStyle.objectFit === 'cover' ? 'cover' : 'contain';
    const position = parseExportObjectPosition(imageStyle.objectPosition);
    const scale = fit === 'cover'
      ? Math.max(targetWidth / img.naturalWidth, targetHeight / img.naturalHeight)
      : Math.min(targetWidth / img.naturalWidth, targetHeight / img.naturalHeight);
    const drawWidth = img.naturalWidth * scale;
    const drawHeight = img.naturalHeight * scale;
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.fillStyle = frameStyle.backgroundColor || '#ffffff';
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.drawImage(
      img,
      (targetWidth - drawWidth) * position.x,
      (targetHeight - drawHeight) * position.y,
      drawWidth,
      drawHeight
    );

    if (!Object.prototype.hasOwnProperty.call(img.dataset, 'exportPreviousStyle')) {
      img.dataset.exportPreviousStyle = img.getAttribute('style') || '';
    }
    // html2canvas does not consistently honor object-fit on replaced elements.
    // Replace the source with a pre-composed frame-sized bitmap so the export
    // uses exactly the same contain/cover rule as the editor.
    img.style.objectFit = 'fill';
    img.style.objectPosition = 'center';
    img.src = canvas.toDataURL('image/png');
    await waitForImageReady(img);
  }));
}

function restoreExportImageStyles(container) {
  container.querySelectorAll('img[data-export-previous-style]').forEach(img => {
    const previousStyle = img.dataset.exportPreviousStyle;
    if (previousStyle) img.setAttribute('style', previousStyle);
    else img.removeAttribute('style');
    delete img.dataset.exportPreviousStyle;
  });
}

function restoreOriginalImages(container) {
  const images = container.querySelectorAll('img[data-original-src]');
  images.forEach(img => {
    img.src = img.dataset.originalSrc;
    delete img.dataset.originalSrc;
  });
}

// ===== Export Image =====

function setExportProgress(percent, label, indeterminate = false) {
  const progress = document.getElementById('exportProgress');
  const bar = document.getElementById('exportProgressBar');
  const labelEl = document.getElementById('exportProgressLabel');
  const track = progress?.querySelector('.export-progress-track');
  if (!progress || !bar || !labelEl) return;

  clearTimeout(exportProgressHideTimer);
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  bar.style.width = `${value}%`;
  track?.setAttribute('aria-valuenow', String(Math.round(value)));
  track?.setAttribute('aria-valuetext', label || '正在保存');
  labelEl.textContent = label || '正在保存';
  progress.classList.toggle('is-indeterminate', Boolean(indeterminate));
  progress.classList.add('is-active');
  progress.setAttribute('aria-hidden', 'false');
}

function finishExportProgress(label = '已完成') {
  const progress = document.getElementById('exportProgress');
  if (!progress) return;
  setExportProgress(100, label);
  exportProgressHideTimer = setTimeout(() => {
    progress.classList.remove('is-active', 'is-indeterminate');
    progress.setAttribute('aria-hidden', 'true');
  }, 520);
}

function hideExportControls() {
  const selectors = [
    '[data-export-hide]',
    '.section-toolbar',
    '.thumb-remove',
    '.resume-avatar-edit-badge',
    '.avatar-shape-toggle',
    '.card-avatar-edit',
    '.list-remove',
    '.list-add',
    '.multiselect-add',
    '.multiselect-dropdown',
    '.tag-remove',
    '.tag-input'
  ];
  const elements = [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))];
  elements.forEach(element => {
    element.dataset.exportPreviousDisplay = element.style.display;
    element.style.display = 'none';
  });
  return elements;
}

function restoreExportControls(elements) {
  elements.forEach(element => {
    element.style.display = element.dataset.exportPreviousDisplay || '';
    delete element.dataset.exportPreviousDisplay;
  });
}

function prepareExportLayout(paper) {
  const container = document.getElementById('resumeContainer');
  const stage = document.getElementById('resumeScaleStage');
  if (!paper || !container || !stage) return () => {};

  const isMobile = window.matchMedia?.('(max-width: 900px)').matches;
  if (!isMobile) return () => {};

  const previous = {
    containerStyle: container.getAttribute('style'),
    stageStyle: stage.getAttribute('style'),
    paperStyle: paper.getAttribute('style')
  };

  exportLayoutLocked = true;
  // The fitted mobile paper is a visual transform, not the document layout.
  // html2canvas can preserve fractional transform edges as dark/transparent
  // strips. Capture the natural paper instead, then restore the fit afterwards.
  paper.style.transform = 'none';
  stage.style.width = `${paper.offsetWidth}px`;
  stage.style.height = `${paper.offsetHeight}px`;
  stage.style.margin = '0';
  container.style.justifyContent = 'flex-start';
  container.style.overflow = 'visible';

  return () => {
    if (previous.containerStyle === null) container.removeAttribute('style');
    else container.setAttribute('style', previous.containerStyle);
    if (previous.stageStyle === null) stage.removeAttribute('style');
    else stage.setAttribute('style', previous.stageStyle);
    if (previous.paperStyle === null) paper.removeAttribute('style');
    else paper.setAttribute('style', previous.paperStyle);
    exportLayoutLocked = false;
  };
}

function getExportFrameMetrics(paper, canvas) {
  const paperRect = paper.getBoundingClientRect();
  const scaleX = canvas.width / Math.max(paperRect.width, 1);
  const frame = paper.querySelector('.resume-grid');
  const frameRect = frame?.getBoundingClientRect();
  if (!frameRect) {
    return { frameLeft: 0, frameRight: canvas.width, lineWidth: 2 };
  }

  const clamp = value => Math.max(0, Math.min(canvas.width, Math.round(value)));
  return {
    frameLeft: clamp((frameRect.left - paperRect.left) * scaleX),
    frameRight: clamp((frameRect.right - paperRect.left) * scaleX),
    lineWidth: Math.max(1, Math.round(1.5 * scaleX))
  };
}

function buildExportParts(canvas, paper) {
  // Keep each downloaded image readable on social platforms. Long resumes are
  // split into balanced vertical parts, so the second image never becomes a
  // tiny leftover strip.
  const maxPartHeight = Math.max(canvas.width * 1.35, 1600);
  const partCount = Math.max(1, Math.ceil(canvas.height / maxPartHeight));
  const partHeight = Math.ceil(canvas.height / partCount);
  const parts = [];
  let splitPositions = Array.from({ length: partCount + 1 }, (_, index) => Math.min(canvas.height, index * partHeight));

  // For the common two-image case, prefer a real section boundary before the
  // midpoint. This keeps the heroine/work blocks together instead of cutting
  // a card row in half.
  if (partCount === 2 && paper) {
    const paperRect = paper.getBoundingClientRect();
    const scale = canvas.height / paperRect.height;
    const midpoint = canvas.height / 2;
    const boundaries = [...paper.querySelectorAll('.resume-header, .resume-grid > *, .resume-footer')]
      .flatMap(element => {
        const rect = element.getBoundingClientRect();
        return [rect.top, rect.bottom];
      })
      .map(position => Math.round((position - paperRect.top) * scale))
      .filter(position => position > canvas.height * 0.3 && position < canvas.height * 0.7);
    const beforeMidpoint = boundaries.filter(position => position <= midpoint).sort((a, b) => b - a);
    const safeSplit = beforeMidpoint[0] || boundaries.sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint))[0];
    if (safeSplit) splitPositions = [0, safeSplit, canvas.height];
  }

  for (let index = 0; index < partCount; index++) {
    const sourceY = splitPositions[index];
    const height = splitPositions[index + 1] - sourceY;
    const part = document.createElement('canvas');
    part.width = canvas.width;
    part.height = height;
    const context = part.getContext('2d');
    context.drawImage(canvas, 0, sourceY, canvas.width, height, 0, 0, part.width, part.height);
    parts.push(part);
  }

  return parts;
}

let exportParts = [];
let exportDisplayParts = [];

function downloadCanvasImage(canvas, filename) {
  const link = document.createElement('a');
  link.download = filename;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function buildCombinedExportCanvas(parts) {
  if (!parts.length) return null;
  const combined = document.createElement('canvas');
  combined.width = parts[0].width;
  combined.height = parts.reduce((total, part) => total + part.height, 0);
  const context = combined.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, combined.width, combined.height);
  let offsetY = 0;
  parts.forEach(part => {
    context.drawImage(part, 0, offsetY);
    offsetY += part.height;
  });
  return combined;
}

function buildStandaloneExportPart(source, index, total, frameMetrics) {
  // Give each downloaded part its own breathing room. The first page gets a
  // bottom margin and the following page gets a top margin, preventing the
  // two files from looking like a raw crop at the split line.
  const pageTop = index === 0 ? 24 : 48;
  const pageBottom = index === total - 1 ? 32 : 48;
  const page = document.createElement('canvas');
  page.width = source.width;
  page.height = source.height + pageTop + pageBottom;
  const context = page.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, page.width, page.height);
  context.drawImage(source, 0, pageTop);

  // Continuation pages need their own top cap. Align it to the actual inner
  // resume frame instead of drawing across the full bitmap width, which used
  // to create a visibly overhanging black line on the second image.
  if (index > 0) {
    context.fillStyle = '#1a1a2e';
    const frameLeft = Math.max(0, Math.min(page.width, frameMetrics?.frameLeft ?? 0));
    const frameRight = Math.max(frameLeft, Math.min(page.width, frameMetrics?.frameRight ?? page.width));
    const lineWidth = Math.max(1, Math.min(page.height - pageTop, frameMetrics?.lineWidth ?? 2));
    context.fillRect(frameLeft, pageTop, frameRight - frameLeft, lineWidth);
  }

  context.fillStyle = '#8b8490';
  context.font = '20px "Noto Sans SC", "Noto Sans JP", sans-serif';
  context.textAlign = 'right';
  context.textBaseline = 'bottom';
  context.fillText(`${index + 1}/${total}`, page.width - 16, page.height - 12);
  return page;
}

function openExportModal(parts, frameMetrics) {
  exportParts = parts;
  exportDisplayParts = parts.map((part, index) => buildStandaloneExportPart(part, index, parts.length, frameMetrics));
  const modal = document.getElementById('exportModal');
  const grid = document.getElementById('exportPreviewGrid');
  const note = document.getElementById('exportModalNote');
  grid.innerHTML = '';
  note.textContent = parts.length > 1
    ? `履历书较长，已从上到下分割成 ${parts.length} 张图片，每张均已独立渲染。`
    : '这份履历书无需分割，可以直接保存。';

  exportDisplayParts.forEach((part, index) => {
    const item = document.createElement('article');
    item.className = 'export-part';
    const title = document.createElement('h3');
    title.className = 'export-part-title';
    title.textContent = `第${index + 1}张`;
    const preview = document.createElement('div');
    preview.className = 'export-part-preview';
    const image = document.createElement('img');
    image.src = part.toDataURL('image/png');
    image.alt = `Galgame履历书第${index + 1}张预览`;
    preview.appendChild(image);
    const meta = document.createElement('p');
    meta.className = 'export-part-meta';
    meta.textContent = `${part.width}×${part.height}px`;
    const saveButton = document.createElement('button');
    saveButton.className = 'export-part-save';
    saveButton.type = 'button';
    saveButton.textContent = '保存';
    saveButton.setAttribute('aria-label', `保存第${index + 1}张图片`);
    saveButton.addEventListener('click', () => saveExportPart(index));
    const shareButton = document.createElement('button');
    shareButton.className = 'export-part-save export-part-share';
    shareButton.type = 'button';
    shareButton.textContent = '转发到动态';
    shareButton.setAttribute('aria-label', `转发第${index + 1}张图片到同好会动态`);
    shareButton.addEventListener('click', () => shareExportPart(index));
    item.append(title, preview, meta, saveButton, shareButton);
    grid.appendChild(item);
  });

  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
  modal.querySelector('.modal-close')?.focus();
}

function closeExportModal() {
  const modal = document.getElementById('exportModal');
  if (!modal) return;
  modal.classList.remove('active');
  document.body.style.overflow = '';
  const grid = document.getElementById('exportPreviewGrid');
  if (grid) grid.innerHTML = '';
  exportParts = [];
  exportDisplayParts = [];
}

function shareExportPart(index) {
  const part = exportDisplayParts[index];
  if (!part) return;
  if (window.VNFPostShare) {
    window.VNFPostShare.share({ canvas: part, defaultText: '【Galgame 履历书】我的游玩履历 #Galgame #履历书' });
  } else {
    showToast('转发组件尚未加载，请刷新后重试', 'error');
  }
}

function saveExportPart(index) {
  const part = exportDisplayParts[index];
  if (!part) return;
  setExportProgress(35, `正在保存第${index + 1}张`);
  downloadCanvasImage(part, `galgame-resume-${String(index + 1).padStart(2, '0')}-of-${String(exportDisplayParts.length).padStart(2, '0')}.png`);
  finishExportProgress('已保存');
  showToast(`第${index + 1}张图片已保存`, 'success');
}

function saveAllExportParts() {
  if (!exportDisplayParts.length) return;
  const total = exportDisplayParts.length;
  setExportProgress(10, `正在保存 0/${total} 张`);
  exportDisplayParts.forEach((part, index) => {
    downloadCanvasImage(part, `galgame-resume-${String(index + 1).padStart(2, '0')}-of-${String(total).padStart(2, '0')}.png`);
    setExportProgress(((index + 1) / total) * 100, `正在保存 ${index + 1}/${total} 张`);
  });
  finishExportProgress('已全部保存');
  showToast(`已保存 ${total} 张图片`, 'success');
}

function saveCombinedExportImage() {
  const combined = buildCombinedExportCanvas(exportParts);
  if (!combined) return;
  setExportProgress(45, '正在保存合并图片');
  downloadCanvasImage(combined, 'galgame-resume-full.png');
  finishExportProgress('已保存');
  showToast('合并图片已保存', 'success');
}

async function exportImage() {
  const paper = document.getElementById('resumePaper');
  if (!paper) return;
  setExportProgress(5, '准备保存');
  const exportControls = hideExportControls();
  const restoreExportLayout = prepareExportLayout(paper);
  
  try {
    setExportProgress(12, '准备图片');
    // Force all images to load (remove lazy loading)
    const allImgs = paper.querySelectorAll('img');
    allImgs.forEach(img => {
      if (img.loading === 'lazy') img.loading = 'eager';
      if (!img.complete && img.src) {
        const src = img.src;
        img.src = 'about:blank';
        img.src = src;
      }
    });
    
    // Convert cross-origin images to base64 for html2canvas
    setExportProgress(28, '处理图片', true);
    await convertAllImagesToBase64(paper);
    
    // Wait for all images to finish loading
    await Promise.all(Array.from(allImgs).map(img => waitForImageReady(img)));
    await prepareExportImageLayout(paper);
    setExportProgress(52, '整理履历布局');
    
    // Check if any images still could not be converted
    let unconverted = 0;
    allImgs.forEach(img => {
      if (img.src && !img.src.startsWith('data:') && !img.src.startsWith('blob:') && !img.src.startsWith('about:')) {
        unconverted++;
      }
    });
    if (unconverted > 0) {
      console.warn(`${unconverted} images could not be converted to base64`);
      showToast('部分外部图片无法转换，预览中可能为空；请检查图片地址或网络连接', 'error');
    }
    
    const canvas = await html2canvas(paper, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      allowTaint: false,
      imageTimeout: 0,
      logging: false
    });
    setExportProgress(76, '生成分割图片');
    const frameMetrics = getExportFrameMetrics(paper, canvas);
    const parts = buildExportParts(canvas, paper);
    openExportModal(parts, frameMetrics);
    setExportProgress(92, '打开保存预览');
    finishExportProgress('可以保存');
  } catch(err) {
    console.error('Export error:', err);
    finishExportProgress('保存失败');
    showToast('图片保存失败', 'error');
  } finally {
    // Restore editor-only controls exactly to their pre-export display state.
    restoreExportControls(exportControls);
    restoreExportLayout();
    // Restore original image srcs
    restoreOriginalImages(paper);
    restoreExportImageStyles(paper);
  }
}

// ===== Share on X =====
async function shareResumeToPosts(btn) {
  const paper = document.getElementById('resumePaper');
  if (!paper) return;
  if (!window.VNFPostShare) {
    showToast('转发组件尚未加载，请刷新后重试', 'error');
    return;
  }
  if (btn) { btn.classList.add('is-busy'); btn.disabled = true; }
  const clearBusy = () => { if (btn) { btn.classList.remove('is-busy'); btn.disabled = false; } };
  setExportProgress(5, '准备转发');
  const exportControls = hideExportControls();
  const restoreExportLayout = prepareExportLayout(paper);

  try {
    setExportProgress(20, '处理图片', true);
    const allImgs = paper.querySelectorAll('img');
    allImgs.forEach(img => {
      if (img.loading === 'lazy') img.loading = 'eager';
    });
    await convertAllImagesToBase64(paper);
    await Promise.all(Array.from(allImgs).map(img => waitForImageReady(img)));
    await prepareExportImageLayout(paper);
    setExportProgress(55, '渲染履历');
    const canvas = await html2canvas(paper, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      allowTaint: false,
      imageTimeout: 0,
      logging: false
    });
    setExportProgress(80, '生成分页图片');
    const parts = buildExportParts(canvas, paper);
    finishExportProgress('已生成');
    const name = state.profile.name || 'Galgame玩家';
    window.VNFPostShare.share({
      canvases: parts.slice(0, 4),
      defaultText: `【Galgame履历书】
${name}的履历书制作完成！

#Galgame #履历书`
    });
  } catch (err) {
    console.error('Resume share failed:', err);
    finishExportProgress('转发失败');
    showToast('生成图片失败，请重试', 'error');
  } finally {
    clearBusy();
    restoreExportControls(exportControls);
    restoreExportLayout();
    restoreOriginalImages(paper);
    restoreExportImageStyles(paper);
  }
}

// ===== Reset =====
async function resetAll() {
  if (confirm('确定要重置所有数据吗？此操作无法撤销。')) {
    clearTimeout(serverSaveTimer);
    serverSaveQueued = false;
    localStorage.removeItem(activeStorageKey);
    state.profile = {
      name: '', handle: '', accountType: DEFAULT_ACCOUNT_TYPE, avatar: '',
      genres: [], brands: [], works: [], heroines: [],
      historyYears: '', playCount: '0',
      voiceActors: [], artists: [], writers: [],
      songs: [], attributes: [], other: ''
    };
    applyAuthenticatedDefaults();
    writeLocalState();
    renderResume();
    if (cloudResumeEnabled) {
      updateResumeSyncStatus('syncing');
      const response = await fetchJson(`${RESUME_API_URL}?action=reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (response.ok && response.success) {
        serverResumeExists = false;
        updateResumeSyncStatus('synced');
      } else {
        updateResumeSyncStatus('error');
      }
    } else {
      updateResumeSyncStatus('local');
    }
    showToast('已重置', 'success');
  }
}

// ===== Theme Toggle =====
// Older public pages may still load a shared theme-runtime without the
// view-transition stylesheet. Keep this tool self-contained so the theme
// button still has the same radial reveal after a partial deployment.
function ensureToolThemeTransitionStyles() {
  if (document.getElementById('vn-theme-transition-styles')) return;
  const style = document.createElement('style');
  style.id = 'vn-theme-transition-styles';
  style.textContent = [
    '::view-transition-old(root), ::view-transition-new(root) { animation: none; mix-blend-mode: normal; }',
    '::view-transition-old(root) { z-index: 1; }',
    '::view-transition-new(root) { z-index: 999; clip-path: circle(0 at var(--vn-theme-transition-x, 50vw) var(--vn-theme-transition-y, 50vh)); animation: vn-theme-reveal 560ms cubic-bezier(0.22, 1, 0.36, 1) forwards; }',
    '.vn-theme-reveal-layer { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; background: var(--vn-theme-reveal-color, var(--vn-bg)); clip-path: circle(0 at var(--vn-theme-transition-x, 50vw) var(--vn-theme-transition-y, 50vh)); animation: vn-theme-reveal 560ms cubic-bezier(0.22, 1, 0.36, 1) forwards; }',
    '@keyframes vn-theme-reveal { to { clip-path: circle(var(--vn-theme-transition-radius, 150vmax) at var(--vn-theme-transition-x, 50vw) var(--vn-theme-transition-y, 50vh)); } }',
    '@media (prefers-reduced-motion: reduce) { ::view-transition-new(root), .vn-theme-reveal-layer { animation-duration: 1ms; } }'
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);
}

function getToolThemeTransitionOrigin(button) {
  const rect = button?.getBoundingClientRect?.();
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const root = document.documentElement;
  root.style.setProperty('--vn-theme-transition-x', `${x}px`);
  root.style.setProperty('--vn-theme-transition-y', `${y}px`);
  root.style.setProperty('--vn-theme-transition-radius', `${radius}px`);
}

function runToolThemeRevealFallback(button, revealColor) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  getToolThemeTransitionOrigin(button);
  const layer = document.createElement('div');
  layer.className = 'vn-theme-reveal-layer';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.setProperty('--vn-theme-reveal-color', revealColor || 'var(--vn-bg)');
  document.body.appendChild(layer);
  window.setTimeout(() => layer.remove(), 620);
}

function toggleTheme(event) {
  if (window.VNFTheme && typeof window.VNFTheme.toggle === 'function') {
    const button = event?.currentTarget || document.getElementById('themeToggle');
    const runtimeHasTransition = Boolean(document.getElementById('vn-theme-transition-styles'));
    const oldBackground = runtimeHasTransition ? '' : getComputedStyle(document.body).backgroundColor;
    if (!runtimeHasTransition) ensureToolThemeTransitionStyles();
    window.VNFTheme.toggle(button);
    if (!runtimeHasTransition) runToolThemeRevealFallback(button, oldBackground);
    return;
  }
  showToast('主题切换暂不可用', 'error');
}

// ===== Toast =====
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const icons = {
    success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };
  const icon = icons[type] || icons.info;
  toast.innerHTML = '<span class="toast-icon">' + icon + '</span><span class="toast-message">' + message + '</span>';
  toast.className = 'toast ' + type + ' show';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

// ===== Utilities =====
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ===== Keyboard shortcuts =====
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal();
    closeExportModal();
    closeAddMenu();
  }
});

// ===== Initialize on load =====
init().catch(error => {
  console.error('GalgameTool initialization failed:', error);
  serverLoadPending = false;
  updateResumeSyncStatus(cloudResumeEnabled ? 'error' : 'local');
  loadState();
  updateAccountPlatformControl();
  populateYearSelect();
  renderResume();
  applyMode();
  applyToggles();
  initMobileResumeScale();
});
