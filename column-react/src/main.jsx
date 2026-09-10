import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import '@waline/client/waline.css';
import './styles.css';

const API_URL = '/api/column.php';
const TYPE_LABELS = {
  essay: '论',
  review: '评',
  translation: '译',
  interview: '访',
  community: '社',
};
const STATUS_LABELS = {
  draft: '草稿',
  published: '已发布',
  hidden: '已隐藏',
  deleted: '已删除',
};
const READER_DEFAULTS = { font: 'medium', width: 'standard', leading: 'standard', theme: 'light' };
const READER_OPTIONS = {
  font: ['small', 'medium', 'large'],
  width: ['narrow', 'standard', 'wide'],
  leading: ['compact', 'standard', 'loose'],
  theme: ['light', 'paper', 'dark'],
};

async function apiRequest(action, { query = {}, method = 'GET', body, signal } = {}) {
  const url = new URL(API_URL, window.location.origin);
  url.searchParams.set('action', action);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== '' && value !== null && value !== undefined) url.searchParams.set(key, String(value));
  });
  const options = { method, credentials: 'same-origin', signal, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  let payload = {};
  try { payload = await response.json(); } catch { throw new Error('服务器返回了无法读取的响应'); }
  if (!response.ok || payload.success === false) {
    const error = new Error(payload.error?.message || payload.message || (response.status === 401 ? '请先登录' : '请求失败，请稍后重试'));
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload.data ?? payload;
}

function navigate(path, replace = false) {
  if (replace) window.history.replaceState({}, '', path);
  else window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function hrefFor(path) {
  return path.startsWith('/') ? path : `/${path}`;
}

function Link({ to, children, className = '', onClick, ...props }) {
  const href = hrefFor(to);
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        onClick?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        navigate(href);
      }}
      {...props}
    >
      {children}
    </a>
  );
}

function useRoute() {
  const read = () => {
    const path = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/+$/, '') || '/';
    if (path === '/column' || path === '/') return { name: 'home' };
    if (path === '/column/search') return { name: 'search' };
    if (path === '/column/edit') return { name: 'edit', id: null };
    if (path.startsWith('/column/edit/')) return { name: 'edit', id: decodeURIComponent(path.slice('/column/edit/'.length)) };
    if (path === '/column/my') return { name: 'my' };
    if (path === '/column/admin') return { name: 'admin' };
    if (path.startsWith('/column/article/')) return { name: 'article', pathKey: decodeURIComponent(path.slice('/column/article/'.length).replace(/\/+$/, '')) };
    return { name: 'home' };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const update = () => setRoute(read());
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return { ...route, search: window.location.search };
}

function useBootstrap() {
  const [state, setState] = useState({ loading: true, error: null, data: { user: null, types: [], clubs: [], waline: { server_url: '' } } });
  useEffect(() => {
    const controller = new AbortController();
    apiRequest('bootstrap', { signal: controller.signal })
      .then((data) => setState({ loading: false, error: null, data }))
      .catch((error) => {
        if (error.name !== 'AbortError') setState((current) => ({ ...current, loading: false, error }));
      });
    return () => controller.abort();
  }, []);
  return state;
}

function useDocumentTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · VNFest 专栏` : 'VNFest 专栏';
  }, [title]);
}

function ThemeToggle() {
  const [dark, setDark] = useState(document.documentElement.dataset.theme === 'dark');
  useEffect(() => {
    if (window.VNFTheme?.subscribe) return window.VNFTheme.subscribe(({ theme }) => setDark(theme === 'dark'));
    const observer = new MutationObserver(() => setDark(document.documentElement.dataset.theme === 'dark'));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return (
    <button
      className="column-topbar-control"
      type="button"
      aria-label={dark ? '切换到亮色主题' : '切换到深色主题'}
      onClick={(event) => window.VNFTheme?.toggle?.(event.currentTarget)}
    >
      {dark ? '亮色' : '深色'}
    </button>
  );
}

function Sidebar({ route, user, onClose }) {
  const items = [
    { name: 'home', label: '专栏首页', to: '/column/' },
    { name: 'search', label: '最新文章', to: '/column/search/' },
    { name: 'types', label: '按类型浏览', to: '/column/search/?type=essay' },
  ];
  if (user) items.push({ name: 'edit', label: '开始编辑', to: '/column/edit/' });
  if (user) items.push({ name: 'my', label: '我的文章', to: '/column/my/' });
  if (user?.can_manage) items.push({ name: 'admin', label: '管理文章', to: '/column/admin/' });
  return (
    <nav className="column-sidebar-nav" aria-label="专栏导航">
      <div className="column-sidebar-heading">
        <span className="column-sidebar-label">专栏</span>
        <span className="column-sidebar-caption">VNFest</span>
      </div>
      <div className="column-sidebar-links">
        {items.map((item) => {
          const hasTypeFilter = new URLSearchParams(route.search || '').has('type');
          const active = item.name === 'types' ? route.name === 'search' && hasTypeFilter : item.name === 'search' ? route.name === 'search' && !hasTypeFilter : route.name === item.name;
          return (
            <Link key={item.label} to={item.to} className={`column-sidebar-link${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClose}>
              <span>{item.label}</span>
              <span className="column-sidebar-arrow" aria-hidden="true">›</span>
            </Link>
          );
        })}
      </div>
      <div className="column-sidebar-note">文章和评论都保留在各自的内容页面中。</div>
    </nav>
  );
}

function DocsShell({ route, bootstrap, children, title }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuRef = useRef(null);
  const user = bootstrap.user;
  useDocumentTitle(title);
  useEffect(() => {
    if (!mobileOpen) return undefined;
    const close = (event) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [mobileOpen]);
  useEffect(() => {
    const details = menuRef.current;
    if (!details) return undefined;
    const close = (event) => { if (!details.contains(event.target)) details.open = false; };
    const escape = (event) => { if (event.key === 'Escape') details.open = false; };
    document.addEventListener('click', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', escape);
    };
  }, [user]);
  const loginTarget = `${window.location.pathname}${window.location.search}`.replace(/^\//, '');
  return (
    <div className="column-app">
      <header className="column-topbar" data-page-header>
        <div className="column-topbar-leading">
          <button className="column-mobile-menu" type="button" aria-label="打开专栏导航" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}>目录</button>
          <Link to="/index.html?guest=1" className="column-brand" aria-label="返回 VNFest 地图">
            <span className="column-brand-name">VNFest</span>
            <span className="column-brand-divider" aria-hidden="true" />
            <span className="column-brand-section">专栏</span>
          </Link>
        </div>
        <nav className="column-topbar-actions" aria-label="顶部导航">
          <Link to="/column/" className={`column-topbar-link${route.name === 'home' ? ' is-current' : ''}`} aria-current={route.name === 'home' ? 'page' : undefined}>专栏</Link>
          <Link to="/column/search/" className={`column-topbar-link${route.name === 'search' ? ' is-current' : ''}`} aria-current={route.name === 'search' ? 'page' : undefined}>搜索</Link>
          {user ? (
            <details className="column-user-menu" ref={menuRef}>
              <summary className="column-topbar-link"><span>{user.nickname || user.username || '我的专栏'}</span></summary>
              <div className="column-user-menu-panel" role="menu">
                <Link to="/column/edit/" role="menuitem">开始编辑</Link>
                <Link to="/column/my/" role="menuitem">我的文章</Link>
                {user.can_manage ? <Link to="/column/admin/" role="menuitem">管理文章</Link> : null}
              </div>
            </details>
          ) : (
            <a className="column-topbar-link" href={`/login.html?redirect=${encodeURIComponent(loginTarget)}`}>登录</a>
          )}
          <ThemeToggle />
        </nav>
      </header>
      {mobileOpen ? (
        <div className="column-mobile-drawer-backdrop" role="presentation" onMouseDown={() => setMobileOpen(false)}>
          <aside className="column-mobile-drawer" aria-label="专栏导航" onMouseDown={(event) => event.stopPropagation()}>
            <div className="column-mobile-drawer-head"><strong>专栏导航</strong><button type="button" aria-label="关闭专栏导航" onClick={() => setMobileOpen(false)}>关闭</button></div>
            <Sidebar route={route} user={user} onClose={() => setMobileOpen(false)} />
          </aside>
        </div>
      ) : null}
      <div className="column-layout">
        <aside className="column-desktop-sidebar"><Sidebar route={route} user={user} /></aside>
        <main className="column-main-content">
          {bootstrap.error ? <div className="column-system-notice is-warning" role="status">专栏接口暂时不可用，页面仍可浏览已加载内容。</div> : null}
          {children}
        </main>
      </div>
      <footer className="column-footer">
        <Link to="/column/">专栏首页</Link>
        <Link to="/index.html?guest=1">返回地图</Link>
        <span>VNFest 专栏</span>
      </footer>
    </div>
  );
}

function PageState({ kind = 'empty', title, message, action }) {
  return (
    <div className={`column-page-state is-${kind}`} data-state={kind}>
      <strong>{title}</strong>
      {message ? <span>{message}</span> : null}
      {action ? <div className="column-page-state-action">{action}</div> : null}
    </div>
  );
}

function formatDate(value) {
  const raw = String(value || '').replace('T', ' ');
  return raw ? raw.slice(0, 10) : '未发布';
}

function articleHref(article) {
  if (article.path_key) return `/column/article/${encodeURIComponent(article.path_key)}/`;
  return `/column/edit/${encodeURIComponent(article.id)}/`;
}

function Cover({ article, className = '' }) {
  const [failed, setFailed] = useState(false);
  const source = article.cover_url || '';
  if (!source || failed) {
    return <div className={`column-cover column-cover-placeholder ${className}`} aria-hidden="true"><span>{article.type_label || TYPE_LABELS[article.type] || '论'}</span></div>;
  }
  return <div className={`column-cover ${className}`}><img src={source} alt={`${article.title || '文章'}封面`} loading="lazy" decoding="async" onError={() => setFailed(true)} /></div>;
}

function ArticleMeta({ article, compact = false }) {
  return (
    <div className={`column-article-meta${compact ? ' is-compact' : ''}`}>
      <span className="column-type-chip">{article.type_label || TYPE_LABELS[article.type] || '论'}</span>
      <span>{article.author?.nickname || article.author?.username || 'VNFest 作者'}</span>
      <span>{formatDate(article.published_at || article.updated_at)}</span>
      <span>{article.read_minutes || 1} 分钟阅读</span>
    </div>
  );
}

function ArticleListItem({ article }) {
  return (
    <article className="column-article-list-item">
      <div className="column-article-list-main">
        <ArticleMeta article={article} compact />
        <h3><Link to={articleHref(article)}>{article.title || '未命名文章'}</Link></h3>
        <p>{article.summary || article.excerpt || '这篇文章还没有摘要。'}</p>
      </div>
      <Link to={articleHref(article)} className="column-article-list-more" aria-label={`阅读：${article.title || '未命名文章'}`}>阅读</Link>
    </article>
  );
}

function FeaturedArticle({ article }) {
  if (!article) return <PageState title="暂时没有精选文章" message="管理员选出文章后，会显示在这里。" />;
  return (
    <article className="column-featured-article">
      <div className="column-featured-copy">
        <div className="column-kicker"><span className="column-type-chip">{article.type_label || TYPE_LABELS[article.type] || '论'}</span><span>编辑推荐</span></div>
        <h2><Link to={articleHref(article)}>{article.title}</Link></h2>
        <p>{article.summary || article.excerpt || '打开文章阅读全文。'}</p>
        <ArticleMeta article={article} compact />
        <Link to={articleHref(article)} className="column-text-link">阅读文章 <span aria-hidden="true">→</span></Link>
      </div>
      <Cover article={article} className="is-featured" />
    </article>
  );
}

function TypeOptions({ types = [], includeAll = true }) {
  const values = types.length ? types : Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }));
  return <>{includeAll ? <option value="">全部类型</option> : null}{values.map((type) => <option key={type.value} value={type.value}>{type.label} · {type.value === 'essay' ? '论述' : type.value === 'review' ? '评论' : type.value === 'translation' ? '翻译' : type.value === 'interview' ? '访谈' : '社群记录'}</option>)}</>;
}

function SearchForm({ types, initialQuery = '', initialType = '', onSubmit, compact = false }) {
  const [query, setQuery] = useState(initialQuery);
  const [type, setType] = useState(initialType);
  useEffect(() => { setQuery(initialQuery); setType(initialType); }, [initialQuery, initialType]);
  return (
    <form className={`column-search-form${compact ? ' is-compact' : ''}`} role="search" onSubmit={(event) => { event.preventDefault(); onSubmit({ query: query.trim(), type }); }}>
      <label className="column-visually-hidden" htmlFor="column-search-input">搜索专栏文章</label>
      <input id="column-search-input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、摘要或正文" autoComplete="off" />
      <label className="column-visually-hidden" htmlFor="column-search-type">文章类型</label>
      <select id="column-search-type" value={type} onChange={(event) => setType(event.target.value)} aria-label="文章类型"><TypeOptions types={types} /></select>
      <button className="column-button is-primary" type="submit">搜索</button>
    </form>
  );
}

function HomePage({ bootstrap }) {
  const [feed, setFeed] = useState(null);
  const [error, setError] = useState(null);
  useDocumentTitle('专栏');
  useEffect(() => {
    const controller = new AbortController();
    apiRequest('feed', { query: { per_page: 12 }, signal: controller.signal }).then(setFeed).catch((reason) => { if (reason.name !== 'AbortError') setError(reason); });
    return () => controller.abort();
  }, []);
  const articles = feed?.articles || [];
  const featured = feed?.featured?.[0] || articles.find((article) => article.featured_rank !== null);
  return (
    <div className="column-page column-home-page">
      <section className="column-intro-block">
        <div>
          <p className="column-eyebrow">VNFEST / COLUMN</p>
          <h1>专栏文章</h1>
          <p className="column-intro-copy">这里记录作品、观点、翻译、访谈和同好会经验。</p>
        </div>
        <div className="column-intro-aside"><span>按类型阅读</span><span>持续更新</span></div>
      </section>

      <section className="column-section column-home-search" aria-labelledby="column-search-heading">
        <div className="column-section-heading"><div><span className="column-section-index">01</span><h2 id="column-search-heading">搜索</h2></div><span>标题、摘要和正文</span></div>
        <SearchForm types={bootstrap.types} onSubmit={({ query, type }) => navigate(`/column/search/?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(type ? { type } : {}) }).toString()}`)} />
      </section>

      <section className="column-section" aria-labelledby="column-featured-heading">
        <div className="column-section-heading"><div><span className="column-section-index">02</span><h2 id="column-featured-heading">精选文章</h2></div><span>编辑推荐</span></div>
        {error ? <PageState kind="error" title="文章暂时无法加载" message="请稍后再试。" /> : feed ? <FeaturedArticle article={featured} /> : <div className="column-loading-line" aria-label="精选文章加载中" />}
      </section>

      <section className="column-section" aria-labelledby="column-latest-heading">
        <div className="column-section-heading"><div><span className="column-section-index">03</span><h2 id="column-latest-heading">最新文章</h2></div><Link to="/column/search/" className="column-section-link">查看全部 <span aria-hidden="true">→</span></Link></div>
        {feed ? (articles.length ? <div className="column-article-list">{articles.slice(0, 6).map((article) => <ArticleListItem key={article.id} article={article} />)}</div> : <PageState title="暂时没有文章" message="新的文章发布后，会显示在这里。" />) : <div className="column-loading-list"><span /><span /><span /></div>}
      </section>
    </div>
  );
}

function SearchPage({ bootstrap }) {
  const params = useMemo(() => new URLSearchParams(window.location.search), [window.location.search]);
  const query = params.get('q') || '';
  const type = params.get('type') || '';
  const page = Math.max(1, Number(params.get('page') || 1));
  const [feed, setFeed] = useState(null);
  const [error, setError] = useState(null);
  useDocumentTitle(query || type ? '搜索结果' : '最新文章');
  useEffect(() => {
    const controller = new AbortController();
    setFeed(null);
    setError(null);
    apiRequest('feed', { query: { q: query, type, page, per_page: 12 }, signal: controller.signal }).then(setFeed).catch((reason) => { if (reason.name !== 'AbortError') setError(reason); });
    return () => controller.abort();
  }, [query, type, page]);
  const updateSearch = ({ query: nextQuery, type: nextType }) => {
    const next = new URLSearchParams();
    if (nextQuery) next.set('q', nextQuery);
    if (nextType) next.set('type', nextType);
    navigate(`/column/search/${next.toString() ? `?${next}` : ''}`);
  };
  const goPage = (nextPage) => {
    const next = new URLSearchParams(window.location.search);
    next.set('page', String(nextPage));
    navigate(`/column/search/?${next}`);
  };
  return (
    <div className="column-page column-search-page">
      <section className="column-page-heading"><p className="column-eyebrow">VNFEST / READ</p><h1>{query || type ? '搜索结果' : '最新文章'}</h1><p>{query ? `“${query}”的搜索结果` : '按发布时间阅读近期公开文章。'}</p></section>
      <section className="column-search-panel"><SearchForm types={bootstrap.types} initialQuery={query} initialType={type} onSubmit={updateSearch} compact /></section>
      <section className="column-section" aria-labelledby="column-results-heading">
        <div className="column-section-heading"><div><span className="column-section-index">01</span><h2 id="column-results-heading">文章</h2></div><span>{feed ? `${feed.total || 0} 篇` : '正在加载'}</span></div>
        {error ? <PageState kind="error" title="搜索暂时无法完成" message="请稍后再试。" /> : feed ? (feed.articles?.length ? <div className="column-article-list">{feed.articles.map((article) => <ArticleListItem key={article.id} article={article} />)}</div> : <PageState title="暂时没有文章" message="换个关键词，或先看看其他类型。" />) : <div className="column-loading-list"><span /><span /><span /></div>}
        {feed?.pages > 1 ? <div className="column-pagination"><button type="button" disabled={page <= 1} onClick={() => goPage(page - 1)}>上一页</button><span>{page} / {feed.pages}</span><button type="button" disabled={page >= feed.pages} onClick={() => goPage(page + 1)}>下一页</button></div> : null}
      </section>
    </div>
  );
}

function ReaderSettings({ appearance, onChange, mobile = false }) {
  const groups = [
    ['font', '字号', [['small', '小'], ['medium', '标准'], ['large', '大']]],
    ['width', '正文宽度', [['narrow', '窄'], ['standard', '标准'], ['wide', '宽']]],
    ['leading', '行距', [['compact', '紧凑'], ['standard', '标准'], ['loose', '宽松']]],
    ['theme', '阅读主题', [['light', '明亮'], ['paper', '纸张'], ['dark', '深色']]],
  ];
  return (
    <div className={`column-reader-settings${mobile ? ' is-mobile' : ''}`}>
      <div className="column-reader-settings-title">阅读设置</div>
      {groups.map(([key, label, values]) => (
        <div className="column-reader-setting" key={key}>
          <span>{label}</span>
          <div className="column-reader-setting-options" role="group" aria-label={label}>
            {values.map(([value, text]) => <button key={value} type="button" className={appearance[key] === value ? 'is-active' : ''} aria-pressed={appearance[key] === value} onClick={() => onChange(key, value)}>{text}</button>)}
          </div>
        </div>
      ))}
      <button className="column-text-button" type="button" onClick={() => onChange(null, null)}>恢复默认</button>
    </div>
  );
}

function readReaderAppearance() {
  try {
    const stored = JSON.parse(localStorage.getItem('vnfestWikiAppearance') || '{}');
    return Object.fromEntries(Object.entries(READER_DEFAULTS).map(([key, value]) => [key, READER_OPTIONS[key].includes(stored[key]) ? stored[key] : value]));
  } catch {
    return { ...READER_DEFAULTS };
  }
}

function ArticleToc({ items, activeId, onSelect }) {
  if (!items?.length) return <div className="column-toc-empty">本文暂无目录</div>;
  return <ol className="column-toc">{items.map((item) => <li key={item.id} className={item.level === 3 ? 'is-child' : ''}><a href={`#${item.id}`} className={activeId === item.id ? 'is-active' : ''} aria-current={activeId === item.id ? 'location' : undefined} onClick={(event) => { event.preventDefault(); onSelect(item.id); }}>{item.text}</a></li>)}</ol>;
}

function WalineComments({ config }) {
  const elementRef = useRef(null);
  const [state, setState] = useState({ loading: Boolean(config?.server_url), error: null });
  useEffect(() => {
    let alive = true;
    let instance = null;
    if (!config?.server_url) {
      setState({ loading: false, error: '评论服务尚未配置' });
      return undefined;
    }
    setState({ loading: true, error: null });
    import('@waline/client').then(({ init }) => {
      if (!alive || !elementRef.current) return;
      instance = init({
        el: elementRef.current,
        serverURL: config.server_url,
        path: config.path,
        login: 'force',
        commentSorting: 'latest',
        imageUploader: false,
        reaction: false,
        emoji: false,
        search: false,
        dark: document.documentElement.dataset.theme === 'dark',
      });
      setState({ loading: false, error: null });
    }).catch((error) => {
      if (alive) setState({ loading: false, error: error.message || '评论服务暂时不可用' });
    });
    return () => {
      alive = false;
      if (instance?.destroy) instance.destroy();
      if (elementRef.current) elementRef.current.innerHTML = '';
    };
  }, [config?.server_url, config?.path]);
  return (
    <div className="column-waline-wrap">
      <p className="column-waline-note">评论使用 VNFest 账号登录，内容按时间顺序显示。</p>
      {state.error ? <PageState kind="muted" title={state.error} message="文章正文不受影响。" /> : null}
      {state.loading ? <div className="column-loading-line" aria-label="评论加载中" /> : null}
      <div ref={elementRef} className="column-waline" aria-label="文章评论" />
    </div>
  );
}

function ArticlePage({ pathKey, bootstrap }) {
  const [article, setArticle] = useState(null);
  const [related, setRelated] = useState([]);
  const [waline, setWaline] = useState(null);
  const [error, setError] = useState(null);
  const [appearance, setAppearance] = useState(readReaderAppearance);
  const [activeId, setActiveId] = useState('');
  useDocumentTitle(article?.title || '文章');
  useEffect(() => {
    const controller = new AbortController();
    setArticle(null);
    setError(null);
    apiRequest('article', { query: { path_key: pathKey }, signal: controller.signal }).then((data) => { setArticle(data.article); setRelated(data.related || []); setWaline(data.waline || null); }).catch((reason) => { if (reason.name !== 'AbortError') setError(reason); });
    return () => controller.abort();
  }, [pathKey]);
  useEffect(() => {
    try { localStorage.setItem('vnfestWikiAppearance', JSON.stringify(appearance)); } catch {}
  }, [appearance]);
  useEffect(() => {
    if (!article?.toc?.length) return undefined;
    const headings = Array.from(document.querySelectorAll('.column-reader-content h2[id], .column-reader-content h3[id]'));
    if (!headings.length) return undefined;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActiveId(visible.target.id);
    }, { rootMargin: '-96px 0px -65% 0px', threshold: [0, .2, .7] });
    headings.forEach((heading) => observer.observe(heading));
    setActiveId(article.toc[0].id);
    return () => observer.disconnect();
  }, [article]);
  const updateAppearance = (key, value) => setAppearance(key ? { ...appearance, [key]: value } : { ...READER_DEFAULTS });
  const selectHeading = (id) => {
    const target = document.getElementById(id);
    if (!target) return;
    setActiveId(id);
    target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    window.history.replaceState({}, '', `#${id}`);
  };
  if (error) return <div className="column-page column-article-page"><PageState kind="error" title="文章不存在或暂不可见" message="请返回专栏首页继续阅读。" action={<Link to="/column/" className="column-button is-primary">返回专栏</Link>} /></div>;
  if (!article) return <div className="column-page column-article-page"><div className="column-loading-article"><span /><span /><span /></div></div>;
  return (
    <div className="column-page column-article-page">
      <div className="column-breadcrumb"><Link to="/column/">专栏</Link><span aria-hidden="true">/</span><span>{article.type_label || TYPE_LABELS[article.type] || '文章'}</span></div>
      <header className="column-article-header">
        <div className="column-kicker"><span className="column-type-chip">{article.type_label || TYPE_LABELS[article.type] || '论'}</span><span>文章</span></div>
        <h1>{article.title}</h1>
        {article.summary ? <p className="column-article-summary">{article.summary}</p> : null}
        <ArticleMeta article={article} />
        {article.club ? <div className="column-article-club">同好会 · {article.club.name}</div> : null}
        {article.cover_url ? <Cover article={article} className="is-article-cover" /> : null}
      </header>
      <details className="column-mobile-reader-panel"><summary>目录与阅读设置</summary><div className="column-mobile-reader-panel-body"><ArticleToc items={article.toc} activeId={activeId} onSelect={selectHeading} /><ReaderSettings appearance={appearance} onChange={updateAppearance} mobile /></div></details>
      <div className="column-reader-layout">
        <aside className="column-reader-aside column-reader-toc-aside" aria-label="文章目录"><div className="column-aside-block"><h2>目录</h2><ArticleToc items={article.toc} activeId={activeId} onSelect={selectHeading} /></div></aside>
        <article className="column-reader-surface" data-reader-theme={appearance.theme} data-reader-font={appearance.font} data-reader-width={appearance.width} data-reader-leading={appearance.leading}>
          <div className="column-reader-content" dangerouslySetInnerHTML={{ __html: article.body_html || '' }} />
          <div className="column-reader-endnote">本文由作者发布于 VNFest 专栏，内容以页面当前版本为准。</div>
          {article.capabilities?.edit ? <div className="column-article-actions"><Link to={`/column/edit/${article.id}/`} className="column-button">编辑文章</Link></div> : null}
        </article>
        <aside className="column-reader-aside column-reader-settings-aside" aria-label="阅读设置"><ReaderSettings appearance={appearance} onChange={updateAppearance} /></aside>
      </div>
      <section className="column-related-section" aria-labelledby="column-related-heading"><div className="column-section-heading"><div><span className="column-section-index">02</span><h2 id="column-related-heading">继续阅读</h2></div><span>同类型文章</span></div>{related.length ? <div className="column-related-list">{related.map((item) => <ArticleListItem key={item.id} article={item} />)}</div> : <PageState title="暂无相关文章" message="可以回到专栏首页看看最新文章。" action={<Link to="/column/" className="column-button">返回专栏</Link>} />}</section>
      <section className="column-comments-section" aria-labelledby="column-comments-heading"><div className="column-section-heading"><div><span className="column-section-index">03</span><h2 id="column-comments-heading">评论</h2></div><span>文章下的交流</span></div><WalineComments config={waline || { server_url: bootstrap.waline?.server_url || '' }} /></section>
    </div>
  );
}

const PREVIEW_ALLOWED = ['p', 'h2', 'h3', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'img', 'hr', 'br'];

function MarkdownPreview({ value }) {
  return (
    <div className="column-markdown-preview">
      {value.trim() ? (
        <ReactMarkdown
          skipHtml
          allowedElements={PREVIEW_ALLOWED}
          urlTransform={(url, key) => {
            if (key === 'src') return /^\/?uploads\/column\/[a-zA-Z0-9/_\-.]+$/.test(url) ? (url.startsWith('/') ? url : `/${url}`) : '';
            return /^https?:\/\/[^\s]+$/i.test(url) ? url : '';
          }}
          components={{
            h1: ({ children }) => <h2>{children}</h2>,
            a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>,
            img: ({ src, alt }) => src ? <img src={src} alt={alt || '文章配图'} /> : null,
            code: ({ className, children, ...props }) => <code className={className} {...props}>{children}</code>,
          }}
        >
          {value}
        </ReactMarkdown>
      ) : <p className="column-preview-empty">预览会显示在这里。</p>}
    </div>
  );
}

function insertAtSelection(textarea, value) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const next = textarea.value.slice(0, start) + value + textarea.value.slice(end);
  textarea.value = next;
  textarea.focus();
  const cursor = start + value.length;
  textarea.setSelectionRange(cursor, cursor);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function EditorToolbar({ textareaRef, onImage }) {
  const commands = [
    ['H2', (area) => insertAtSelection(area, '## 小标题\n\n')],
    ['H3', (area) => insertAtSelection(area, '### 小标题\n\n')],
    ['粗体', (area) => wrapSelection(area, '**', '**')],
    ['斜体', (area) => wrapSelection(area, '*', '*')],
    ['列表', (area) => insertAtSelection(area, '- 列表项\n- 列表项\n\n')],
    ['引用', (area) => insertAtSelection(area, '> 引用内容\n\n')],
    ['代码', (area) => wrapSelection(area, '`', '`')],
    ['代码块', (area) => insertAtSelection(area, '```text\n代码\n```\n\n')],
    ['链接', (area) => insertAtSelection(area, '[链接文字](https://example.com)')],
    ['分隔线', (area) => insertAtSelection(area, '\n---\n\n')],
  ];
  return <div className="column-editor-toolbar" role="toolbar" aria-label="Markdown 工具栏">{commands.map(([label, action]) => <button key={label} type="button" title={label} onClick={() => action(textareaRef.current)}>{label}</button>)}<button type="button" title="插入图片" onClick={onImage}>图片</button></div>;
}

function wrapSelection(area, before, after) {
  const start = area.selectionStart;
  const end = area.selectionEnd;
  const selected = area.value.slice(start, end) || '文字';
  insertAtSelection(area, `${before}${selected}${after}`);
  area.setSelectionRange(start + before.length, start + before.length + selected.length);
}

function AuthNotice({ text = '登录后才能进行编辑。' }) {
  const target = `${window.location.pathname}${window.location.search}`.replace(/^\//, '');
  return <PageState kind="muted" title="需要登录" message={text} action={<a className="column-button is-primary" href={`/login.html?redirect=${encodeURIComponent(target)}`}>去登录</a>} />;
}

function EditorPage({ id, bootstrap }) {
  const user = bootstrap.user;
  const [article, setArticle] = useState(null);
  const [form, setForm] = useState({ title: '', summary: '', type: 'essay', club_membership_id: '', cover_path: '', body_markdown: '' });
  const [mode, setMode] = useState('write');
  const [status, setStatus] = useState({ kind: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const bodyRef = useRef(null);
  const imageRef = useRef(null);
  const coverRef = useRef(null);
  useDocumentTitle(id ? '编辑文章' : '开始编辑');
  useEffect(() => {
    if (!user || !id) return undefined;
    const controller = new AbortController();
    apiRequest('mine', { query: { id }, signal: controller.signal }).then((data) => {
      const next = data.article;
      if (!next) throw new Error('文章不存在');
      setArticle(next);
      setForm({ title: next.title || '', summary: next.summary || '', type: next.type || 'essay', club_membership_id: next.club_membership_id || '', cover_path: next.cover_url || '', body_markdown: next.body_markdown || '' });
      setDirty(false);
    }).catch((reason) => { if (reason.name !== 'AbortError') setStatus({ kind: 'error', text: reason.message }); });
    return () => controller.abort();
  }, [user, id]);
  useEffect(() => {
    const leave = (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty]);
  if (!user) return <div className="column-page column-editor-page"><section className="column-page-heading"><p className="column-eyebrow">VNFEST / EDIT</p><h1>开始编辑</h1></section><AuthNotice /></div>;
  if (id && status.kind === 'error' && !article) return <div className="column-page column-editor-page"><PageState kind="error" title="文章无法读取" message={status.text} action={<Link to="/column/my/" className="column-button is-primary">返回我的文章</Link>} /></div>;
  const update = (key, value) => { setForm((current) => ({ ...current, [key]: value })); setDirty(true); setStatus({ kind: '', text: '' }); };
  const requestImage = () => imageRef.current?.click();
  const requestCover = () => coverRef.current?.click();
  const upload = async (file, isCover = false) => {
    if (!file) return;
    const data = new FormData();
    data.append('image', file);
    data.append('upload_token', form.upload_token || `column-${Math.random().toString(36).slice(2, 14)}`);
    try {
      setStatus({ kind: '', text: '图片上传中…' });
      const url = new URL(API_URL, window.location.origin);
      url.searchParams.set('action', 'upload_image');
      const response = await fetch(url, { method: 'POST', credentials: 'same-origin', body: data });
      const payload = await response.json();
      if (!response.ok || payload.success === false) throw new Error(payload.error?.message || payload.message || '图片上传失败');
      const result = payload.data;
      setForm((current) => ({ ...current, upload_token: result.upload_token, ...(isCover ? { cover_path: result.attachment.relative_path } : {}) }));
      if (!isCover && bodyRef.current) insertAtSelection(bodyRef.current, `![${file.name}](${result.attachment.url})`);
      setDirty(true);
      setStatus({ kind: 'success', text: '图片已上传' });
    } catch (error) {
      setStatus({ kind: 'error', text: error.message || '图片上传失败' });
    }
  };
  const save = async (action) => {
    if (!form.title.trim() || !form.body_markdown.trim()) { setStatus({ kind: 'error', text: '请先填写标题和正文' }); return; }
    setBusy(true);
    setStatus({ kind: '', text: action === 'publish' ? '发布中…' : '保存中…' });
    try {
      const data = await apiRequest(action, { method: 'POST', body: { id: id ? Number(id) : undefined, title: form.title.trim(), summary: form.summary.trim(), type: form.type, club_membership_id: form.club_membership_id || 0, cover_path: form.cover_path, body_markdown: form.body_markdown, upload_token: form.upload_token || '' } });
      const next = data.article;
      setArticle(next);
      setForm((current) => ({ ...current, ...next, type: next.type || current.type, cover_path: next.cover_url || '', body_markdown: next.body_markdown || current.body_markdown }));
      setDirty(false);
      setStatus({ kind: 'success', text: data.message || (action === 'publish' ? '文章已发布' : '草稿已保存') });
      if (!id && next.id) navigate(action === 'publish' && next.path_key ? articleHref(next) : `/column/edit/${next.id}/`, true);
      if (action === 'publish' && next.path_key) setTimeout(() => navigate(articleHref(next)), 350);
    } catch (error) {
      setStatus({ kind: 'error', text: error.message });
    } finally {
      setBusy(false);
    }
  };
  const perform = async (action, message) => {
    if (!article?.id) return;
    if (!window.confirm(message)) return;
    setBusy(true);
    try {
      const data = await apiRequest(action, { method: 'POST', body: { id: article.id } });
      setStatus({ kind: 'success', text: data.message || '操作已完成' });
      if (action === 'withdraw') setArticle((current) => ({ ...current, status: 'draft', published_at: null }));
      if (action === 'delete') navigate('/column/my/');
    } catch (error) {
      setStatus({ kind: 'error', text: error.message });
    } finally { setBusy(false); }
  };
  const editorStatus = article?.status === 'published' ? '已发布 · 修改会直接更新公开内容' : article?.status === 'hidden' ? '已隐藏 · 请联系管理员处理' : '草稿';
  return (
    <div className="column-page column-editor-page">
      <section className="column-editor-heading"><div><p className="column-eyebrow">VNFEST / EDIT</p><h1>{id ? '编辑文章' : '开始编辑'}</h1></div><span className="column-editor-status">{editorStatus}</span></section>
      <section className="column-editor-workbench" aria-label="文章编辑工作台">
        <div className="column-editor-fields">
          <label className="column-editor-title-field">标题<input value={form.title} onChange={(event) => update('title', event.target.value)} maxLength={180} placeholder="输入文章标题" /></label>
          <label>摘要 <span className="column-field-hint">可选</span><textarea value={form.summary} onChange={(event) => update('summary', event.target.value)} maxLength={1200} rows={2} placeholder="用一两句话介绍文章内容" /></label>
        </div>
        <div className="column-editor-meta-fields">
          <label>文章类型<select value={form.type} onChange={(event) => update('type', event.target.value)}><TypeOptions types={bootstrap.types} includeAll={false} /></select></label>
          <label>同好会归属 <span className="column-field-hint">可选</span><select value={form.club_membership_id} onChange={(event) => update('club_membership_id', event.target.value)}><option value="">不添加</option>{(bootstrap.clubs || []).map((club) => <option key={club.membership_id} value={club.membership_id}>{club.name}</option>)}</select></label>
          <div className="column-cover-field"><span>封面 <span className="column-field-hint">可选</span></span><div className="column-cover-upload"><div className="column-cover-mini">{form.cover_path ? <img src={form.cover_path.startsWith('/') ? form.cover_path : `/${form.cover_path}`} alt="封面预览" /> : <span>无封面</span>}</div><button className="column-button" type="button" onClick={requestCover}>上传封面</button></div><input ref={coverRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" hidden onChange={(event) => upload(event.target.files?.[0], true)} /></div>
        </div>
        <div className="column-editor-switch" role="tablist" aria-label="编辑模式"><button type="button" role="tab" aria-selected={mode === 'write'} className={mode === 'write' ? 'is-active' : ''} onClick={() => setMode('write')}>写作</button><button type="button" role="tab" aria-selected={mode === 'preview'} className={mode === 'preview' ? 'is-active' : ''} onClick={() => setMode('preview')}>预览</button></div>
        {mode === 'write' ? <><EditorToolbar textareaRef={bodyRef} onImage={requestImage} /><textarea ref={bodyRef} className="column-markdown-editor" value={form.body_markdown} onChange={(event) => update('body_markdown', event.target.value)} onKeyDown={(event) => { if (event.key === 'Tab') { event.preventDefault(); insertAtSelection(event.currentTarget, '  '); } }} placeholder="从这里开始编辑正文……" aria-label="Markdown 正文编辑区" /><input ref={imageRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" hidden onChange={(event) => upload(event.target.files?.[0])} /><p className="column-editor-help">支持标题、列表、引用、代码、HTTP(S) 链接和专栏附件图片。</p></> : <MarkdownPreview value={form.body_markdown} />}
        <div className="column-editor-footer"><span className={`column-editor-feedback is-${status.kind || 'muted'}`} aria-live="polite">{status.text || (dirty ? '有未保存的修改' : '已保存')}</span><div className="column-editor-actions"><Link to="/column/my/" className="column-button" onClick={(event) => { if (dirty && !window.confirm('还有未保存的修改，确定离开吗？')) event.preventDefault(); }}>返回我的文章</Link><button className="column-button" type="button" onClick={() => save(article?.status === 'published' ? 'update' : 'save_draft')} disabled={busy}>{article?.status === 'published' ? '保存修改' : '保存草稿'}</button><button className="column-button is-primary" type="button" onClick={() => save('publish')} disabled={busy}>发布文章</button>{article?.status === 'published' ? <button className="column-button is-quiet" type="button" onClick={() => perform('withdraw', '确定撤回这篇文章吗？') } disabled={busy}>撤回</button> : null}{article?.id && article.status !== 'deleted' ? <button className="column-button is-danger" type="button" onClick={() => perform('delete', '确定删除这篇文章吗？') } disabled={busy}>删除</button> : null}</div></div>
      </section>
    </div>
  );
}

function StatusChip({ status }) {
  return <span className={`column-status-chip is-${status}`}>{STATUS_LABELS[status] || status}</span>;
}

function MyArticlesPage({ bootstrap }) {
  const [filter, setFilter] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useDocumentTitle('我的文章');
  useEffect(() => {
    if (!bootstrap.user) return undefined;
    const controller = new AbortController();
    setData(null);
    apiRequest('mine', { query: { status: filter }, signal: controller.signal }).then(setData).catch((reason) => { if (reason.name !== 'AbortError') setError(reason); });
    return () => controller.abort();
  }, [bootstrap.user, filter]);
  if (!bootstrap.user) return <div className="column-page column-management-page"><section className="column-page-heading"><p className="column-eyebrow">VNFEST / ARTICLES</p><h1>我的文章</h1></section><AuthNotice /></div>;
  return <div className="column-page column-management-page"><section className="column-page-heading"><p className="column-eyebrow">VNFEST / ARTICLES</p><h1>我的文章</h1><p>查看草稿、已发布和已撤回的文章。</p></section><div className="column-management-toolbar"><select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="文章状态"><option value="">全部状态</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><Link to="/column/edit/" className="column-button is-primary">开始编辑</Link></div>{error ? <PageState kind="error" title="文章列表暂时无法加载" message={error.message} /> : data ? (data.articles?.length ? <div className="column-management-list">{data.articles.map((article) => <article className="column-management-row" key={article.id}><div><div className="column-management-row-meta"><StatusChip status={article.status} /><ArticleMeta article={article} compact /></div><h2><Link to={articleHref(article)}>{article.title || '未命名文章'}</Link></h2><p>{article.summary || article.excerpt || '没有摘要。'}</p></div><Link to={articleHref(article)} className="column-button">{article.status === 'published' ? '查看文章' : '编辑'}</Link></article>)}</div> : <PageState title="暂时没有文章" message="开始编辑一篇文章，它会显示在这里。" action={<Link to="/column/edit/" className="column-button is-primary">开始编辑</Link>} />) : <div className="column-loading-list"><span /><span /><span /></div>}</div>;
}

function AdminPage({ bootstrap }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [data, setData] = useState(null);
  const [notice, setNotice] = useState(null);
  useDocumentTitle('管理文章');
  const load = () => apiRequest('admin', { query: { q: query.trim(), status, per_page: 30 } }).then(setData).catch((error) => setNotice({ kind: 'error', text: error.message }));
  useEffect(() => { if (bootstrap.user?.can_manage) load(); }, [bootstrap.user]);
  if (!bootstrap.user) return <div className="column-page column-admin-page"><section className="column-page-heading"><p className="column-eyebrow">VNFEST / ADMIN</p><h1>管理文章</h1></section><AuthNotice /></div>;
  if (!bootstrap.user.can_manage) return <div className="column-page column-admin-page"><PageState kind="muted" title="没有管理权限" message="只有管理员可以查看专栏管理页面。" /></div>;
  const update = async (article, nextStatus, rank) => {
    try { await apiRequest('moderate_article', { method: 'POST', body: { id: article.id, status: nextStatus, featured_rank: rank } }); setNotice({ kind: 'success', text: '文章状态已更新' }); load(); } catch (error) { setNotice({ kind: 'error', text: error.message }); }
  };
  return <div className="column-page column-admin-page"><section className="column-page-heading"><p className="column-eyebrow">VNFEST / ADMIN</p><h1>管理文章</h1><p>处理文章状态和首页精选顺序。</p></section><form className="column-admin-filter" onSubmit={(event) => { event.preventDefault(); load(); }}><input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="搜索标题、摘要或作者" /><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button className="column-button is-primary" type="submit">筛选</button></form>{notice ? <div className={`column-system-notice is-${notice.kind}`} role="status">{notice.text}</div> : null}{data ? (data.articles?.length ? <div className="column-admin-list">{data.articles.map((article) => <article className="column-admin-row" key={article.id}><div><div className="column-management-row-meta"><StatusChip status={article.status} /><ArticleMeta article={article} compact /></div><h2><Link to={articleHref(article)}>{article.title || '未命名文章'}</Link></h2><p>{article.summary || article.excerpt || '没有摘要。'}</p></div><div className="column-admin-controls"><label>状态<select defaultValue={article.status} onChange={(event) => update(article, event.target.value, article.featured_rank ?? '')}>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>精选位次<input type="number" min="0" defaultValue={article.featured_rank ?? ''} onBlur={(event) => update(article, article.status, event.target.value)} placeholder="不精选" /></label></div></article>)}</div> : <PageState title="暂时没有文章" message="没有符合条件的文章。" />) : <div className="column-loading-list"><span /><span /><span /></div>}</div>;
}

function App() {
  const route = useRoute();
  const bootstrap = useBootstrap();
  const pageKey = `${route.name}:${route.pathKey || route.id || 'new'}:${route.search}`;
  let page;
  if (route.name === 'article') page = <ArticlePage key={pageKey} pathKey={route.pathKey} bootstrap={bootstrap.data} />;
  else if (route.name === 'search') page = <SearchPage key={pageKey} bootstrap={bootstrap.data} />;
  else if (route.name === 'edit') page = <EditorPage key={pageKey} id={route.id} bootstrap={bootstrap.data} />;
  else if (route.name === 'my') page = <MyArticlesPage key={pageKey} bootstrap={bootstrap.data} />;
  else if (route.name === 'admin') page = <AdminPage key={pageKey} bootstrap={bootstrap.data} />;
  else page = <HomePage key={pageKey} bootstrap={bootstrap.data} />;
  return <DocsShell route={route} bootstrap={bootstrap.data} title="专栏">{page}</DocsShell>;
}

createRoot(document.getElementById('root')).render(<App />);
