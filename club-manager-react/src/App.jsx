import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { Button, ConfigProvider, Result, Spin, message, theme } from 'antd';
import Shell from './Shell.jsx';
import { ClubManagerContext } from './context.jsx';
import { api, normalizeError } from './api.js';
import {
  DEFAULT_TAB, ROLE_LEVEL, ROLE_NAMES, TAB_KEYS, clubKey, getEffectiveLevel, initialTab,
  isSuperAdmin, parseClubKey, syncTabUrl,
} from './model.js';

const MembershipsTab = lazy(() => import('./tabs/MembershipsTab.jsx'));
const MembersTab = lazy(() => import('./tabs/MembersTab.jsx'));
const SettingsTab = lazy(() => import('./tabs/SettingsTab.jsx'));
const CodesTab = lazy(() => import('./tabs/CodesTab.jsx'));
const BotTokensTab = lazy(() => import('./tabs/BotTokensTab.jsx'));
const RecommendationsTab = lazy(() => import('./tabs/RecommendationsTab.jsx'));
const ProjectsTab = lazy(() => import('./tabs/ProjectsTab.jsx'));
const VoteProjectsTab = lazy(() => import('./tabs/VoteProjectsTab.jsx'));
const RecognitionTab = lazy(() => import('./tabs/RecognitionTab.jsx'));
const JiangsuTab = lazy(() => import('./tabs/JiangsuTab.jsx'));
const UsersTab = lazy(() => import('./tabs/UsersTab.jsx'));

const renderers = {
  pending: MembershipsTab, diplomatic: MembershipsTab, approved: MembershipsTab,
  members: MembersTab, settings: SettingsTab, codes: CodesTab, bot_tokens: BotTokensTab,
  recommendations: RecommendationsTab, projects: ProjectsTab, vote_projects: VoteProjectsTab, recognition: RecognitionTab,
  jiangsu: JiangsuTab, users: UsersTab,
};

function readEffectiveTheme() {
  if (window.VNFTheme?.getEffectiveTheme) return window.VNFTheme.getEffectiveTheme() === 'dark';
  const saved = localStorage.getItem('themePreference');
  if (saved === 'dark' || saved === 'light') return saved === 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

/* Ant Design tokens are derived from the site theme tokens in
   css/theme-tokens.css so the shell, the antd components and the map site all
   share one palette in both themes. */
const FALLBACK_TOKENS = {
  primary: '#e74c3c', bg: '#f5f5f5', surface: '#ffffff',
  border: 'rgba(0, 0, 0, 0.08)', text: '#1a1a1a',
};

function readThemeTokens() {
  if (typeof document === 'undefined' || !document.documentElement) return FALLBACK_TOKENS;
  const style = getComputedStyle(document.documentElement);
  const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    primary: read('--vn-primary', FALLBACK_TOKENS.primary),
    bg: read('--vn-bg', FALLBACK_TOKENS.bg),
    surface: read('--vn-surface', FALLBACK_TOKENS.surface),
    border: read('--vn-border', FALLBACK_TOKENS.border),
    text: read('--vn-text', FALLBACK_TOKENS.text),
  };
}

export default function App() {
  const [messageApi, messageContext] = message.useMessage();
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [auth, setAuth] = useState(null);
  const [directory, setDirectory] = useState(new Map());
  const [managedClubs, setManagedClubs] = useState([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [activeTab, setActiveTab] = useState(initialTab);
  const [allData, setAllData] = useState([]);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [isDark, setIsDark] = useState(readEffectiveTheme);
  const [tokens, setTokens] = useState(readThemeTokens);
  const [memberCount, setMemberCount] = useState(null);

  useEffect(() => {
    if (!window.VNFTheme?.subscribe) return undefined;
    return window.VNFTheme.subscribe((detail) => {
      setIsDark(detail.theme === 'dark');
      setTokens(readThemeTokens());
    });
  }, []);

  const reloadMemberships = useCallback(async () => {
    const result = await api.get(`membership.php?action=pending&status=all&_=${Date.now()}`);
    const rows = result.memberships || [];
    setAllData(rows);
    return rows;
  }, []);

  const bootstrap = useCallback(async () => {
    setStatus('loading');
    setError('');
    try {
      const identity = await api.get(`auth.php?action=me&_=${Date.now()}`);
      if (!identity.logged_in) {
        setStatus('login');
        return;
      }
      if (getEffectiveLevel(identity) < ROLE_LEVEL.manager) {
        setAuth(identity);
        setStatus('forbidden');
        return;
      }
      const [chinaResult, japanResult] = await Promise.all([
        api.get(`clubs.php?t=${Date.now()}`),
        api.get(`clubs_japan.php?t=${Date.now()}`),
      ]);
      const china = chinaResult.data || chinaResult.clubs || [];
      const japan = japanResult.data || japanResult.clubs || [];
      const nameMap = new Map();
      for (const club of china) nameMap.set(clubKey(club.id, 'china'), club.name || club.school || `同好会 #${club.id}`);
      for (const club of japan) nameMap.set(clubKey(club.id, 'japan'), club.name || club.school || `同好会 #${club.id}`);

      let available;
      if (isSuperAdmin(identity)) {
        available = [
          { all: true, name: '所有同好会', roleLabel: '超级管理员' },
          ...china.map((club) => ({ ...club, club_id: club.id, country: 'china', role: 'super_admin', roleLabel: '超级管理员' })),
          ...japan.map((club) => ({ ...club, club_id: club.id, country: 'japan', role: 'super_admin', roleLabel: '超级管理员' })),
        ];
      } else {
        available = (identity.memberships || [])
          .filter((item) => item.status === 'active' && (item.role === 'manager' || item.role === 'representative'))
          .map((item) => ({
            ...item,
            name: nameMap.get(clubKey(item.club_id, item.country)) || `同好会 #${item.club_id}`,
            roleLabel: ROLE_NAMES[item.role] || item.role,
          }));
        if (available.length > 1) available.unshift({ all: true, name: '所有同好会', roleLabel: '' });
      }
      if (!available.length) {
        setAuth(identity);
        setStatus('forbidden');
        return;
      }
      const requestedTab = initialTab();
      const allowedTab = (!isSuperAdmin(identity) && (requestedTab === 'users' || requestedTab === 'jiangsu')) ? DEFAULT_TAB : requestedTab;
      if (allowedTab !== requestedTab) messageApi.warning('该功能仅限超级管理员使用');
      setAuth(identity);
      setDirectory(nameMap);
      setManagedClubs(available);
      setSelectedKey(available[0].all ? 'all' : clubKey(available[0].club_id, available[0].country));
      setActiveTab(allowedTab);
      syncTabUrl(allowedTab);
      await reloadMemberships();
      setStatus('ready');
    } catch (bootstrapError) {
      setError(normalizeError(bootstrapError, '无法连接同好会管理后端'));
      setStatus('error');
    }
  }, [messageApi, reloadMemberships]);

  useEffect(() => { bootstrap(); }, [bootstrap]);

  const selected = useMemo(() => parseClubKey(selectedKey), [selectedKey]);
  const scopedMemberships = useMemo(() => {
    if (selected.clubId <= 0) return allData;
    return allData.filter((item) => Number(item.club_id) === selected.clubId && (item.country || 'china') === selected.country);
  }, [allData, selected]);

  /* 「成员」统计沿用旧后台语义：花名册中非外交成员的人数；「所有同好会」显示 —。 */
  const loadMemberCount = useCallback(async () => {
    if (selected.clubId <= 0) { setMemberCount(null); return; }
    try {
      const result = await api.get(`membership.php?action=members&club_id=${selected.clubId}&country=${encodeURIComponent(selected.country)}`);
      setMemberCount((result.members || []).filter((member) => member.role !== 'external').length);
    } catch { setMemberCount(null); }
  }, [selected]);
  useEffect(() => { loadMemberCount(); }, [loadMemberCount]);

  const stats = useMemo(() => ({
    pending: scopedMemberships.filter((item) => (item.status || 'pending') === 'pending').length,
    approved: scopedMemberships.filter((item) => item.status === 'active').length,
    members: memberCount === null ? '—' : memberCount,
    total: scopedMemberships.length,
  }), [memberCount, scopedMemberships]);

  const switchTab = useCallback((next) => {
    if (!TAB_KEYS.includes(next)) next = DEFAULT_TAB;
    if (!isSuperAdmin(auth) && (next === 'users' || next === 'jiangsu')) {
      messageApi.error('仅超级管理员可用');
      next = DEFAULT_TAB;
    }
    setActiveTab(next);
    syncTabUrl(next);
  }, [auth, messageApi]);

  useEffect(() => {
    const onPopState = () => switchTab(initialTab());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [switchTab]);

  const refresh = useCallback(async () => {
    try {
      await Promise.all([reloadMemberships(), loadMemberCount()]);
      setRefreshVersion((value) => value + 1);
      messageApi.success('数据已刷新');
    } catch (refreshError) {
      messageApi.error(normalizeError(refreshError));
    }
  }, [loadMemberCount, messageApi, reloadMemberships]);

  const toggleTheme = useCallback(() => {
    const next = isDark ? 'light' : 'dark';
    if (window.VNFTheme?.setPreference) window.VNFTheme.setPreference(next);
    else {
      document.documentElement.dataset.theme = next;
      localStorage.setItem('themePreference', next);
      setIsDark(next === 'dark');
      setTokens(readThemeTokens());
    }
  }, [isDark]);

  const configTheme = useMemo(() => ({
    algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: tokens.primary,
      colorBgBase: tokens.bg,
      colorBgContainer: tokens.surface,
      colorBorder: tokens.border,
      colorTextBase: tokens.text,
      /* 密度基线：与 styles.css 的 --cm-sp/--cm-r/--cm-fs 刻度对齐 */
      borderRadius: 8,
      borderRadiusSM: 6,
      borderRadiusLG: 12,
      controlHeight: 32,
      controlHeightSM: 26,
      controlHeightXS: 22,
      controlHeightLG: 38,
      fontSize: 13,
      fontSizeSM: 12,
      fontSizeLG: 14,
      sizeUnit: 4,
      sizeStep: 4,
      lineHeight: 1.5,
      padding: 12,
      paddingSM: 8,
      paddingXS: 6,
      marginXS: 8,
      marginSM: 12,
      fontFamily: '"Noto Sans SC", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    },
    components: {
      Card: { bodyPadding: 14, headerHeight: 40, headerPadding: '0 14px', headerFontSize: 13 },
      Menu: { itemHeight: 36, itemMarginInline: 4, itemBorderRadius: 6, iconSize: 15, collapsedIconSize: 16, itemPaddingInline: 10 },
      Table: { cellPaddingBlock: 8, cellPaddingInline: 12, headerBg: 'transparent', headerSplitColor: 'transparent', rowHoverBg: 'transparent' },
      Tabs: { horizontalItemPadding: '8px 12px', horizontalItemGutter: 4, cardPadding: '10px 14px', titleFontSize: 13 },
      Form: { itemMarginBottom: 14, verticalLabelPadding: '0 0 3px', labelFontSize: 12 },
      Statistic: { contentFontSize: 22, titleFontSize: 11 },
      Modal: { padding: 16, titleFontSize: 15, titleLineHeight: 1.35 },
      Select: { optionHeight: 28, optionFontSize: 13, optionPadding: '3px 10px' },
      Pagination: { itemSize: 28, itemSizeSM: 26 },
      List: { itemPadding: '10px 0', contentWidth: 220 },
      Descriptions: { itemPaddingBottom: 8, labelBg: 'transparent', titleMarginBottom: 10 },
      Button: { paddingInline: 12, paddingInlineSM: 8, fontWeight: 600 },
      Input: { paddingBlock: 4, paddingInline: 10 },
      Alert: { withDescriptionPadding: '12px 14px' },
      Empty: { colorTextDescription: 'var(--cm-muted)' },
    },
  }), [isDark, tokens]);

  if (status !== 'ready') {
    const content = status === 'loading'
      ? <div className="cm-full-state"><Spin size="large" /><span>正在连接同好会管理后端…</span></div>
      : status === 'login'
        ? <Result status="403" title="请先登录" extra={<Button type="primary" href="../login.html?redirect=admin/club_manager.html">前往登录</Button>} />
        : status === 'forbidden'
          ? <Result status="403" title="没有管理权限" subTitle="只有同好会管理员、负责人或超级管理员可以访问。" extra={<Button href="../index.html">返回地图</Button>} />
          : <Result status="error" title="同好会管理加载失败" subTitle={error} extra={<Button type="primary" onClick={bootstrap}>重试</Button>} />;
    return <ConfigProvider theme={configTheme}>{messageContext}{content}</ConfigProvider>;
  }

  const ActiveTab = renderers[activeTab] || MembershipsTab;
  const context = {
    auth, directory, managedClubs, selected, selectedKey, allData, scopedMemberships,
    activeTab, refreshVersion, messageApi, reloadMemberships, refresh,
  };
  return (
    <ConfigProvider theme={configTheme}>
      {messageContext}
      <ClubManagerContext.Provider value={context}>
        <Shell
          state={{ auth, managedClubs, selectedKey, activeTab, stats, isDark }}
          actions={{
            /* Switching club must remount the active module so no data from the
               previous club survives; an explicit refresh keeps the module
               mounted and pushes a new refreshToken instead. */
            selectClub: (key) => setSelectedKey(key),
            switchTab, refresh, toggleTheme,
          }}
        >
          <Suspense fallback={<div className="cm-tab-loading"><Spin /></div>}>
            {/* Remounting on tab/club change replays the page-enter transition. */}
            <div className="cm-page-enter" key={`${activeTab}:${selectedKey}`}>
              <ActiveTab mode={activeTab} />
            </div>
          </Suspense>
        </Shell>
      </ClubManagerContext.Provider>
    </ConfigProvider>
  );
}
