import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  ConfigProvider, Layout, Menu, Card, Avatar, Progress, Badge, Tag,
  Statistic, Button, Input, Upload, Empty, Drawer, Switch, Select,
  Tooltip, Typography, message, Space, Spin, Alert, Divider, Segmented, Skeleton,
} from 'antd';
import {
  HomeOutlined, SafetyOutlined, TeamOutlined, BellOutlined,
  LogoutOutlined, EnvironmentOutlined,
  CalendarOutlined, CheckOutlined, LockOutlined,
  MailOutlined, UploadOutlined, CameraOutlined,
  MenuOutlined, CopyOutlined, LinkOutlined,
  TagOutlined, SettingOutlined, FundOutlined, BookOutlined,
  ReloadOutlined, TranslationOutlined, SunOutlined, MoonOutlined,
} from '@ant-design/icons';
import { buildTheme, darkTokens, lightTokens } from './theme-tokens';
import zhCN from 'antd/locale/zh_CN';
import jaJP from 'antd/locale/ja_JP';

const { Sider } = Layout;
const { Text, Title } = Typography;
const { TextArea } = Input;

const loginUrl = './login.html?redirect=user.html';

const initialData = {
  user: null,
  memberships: [],
  clubs: [],
  clubDirectoryAvailability: { china: false, japan: false },
  notifications: [],
  unread: 0,
  pending: [],
  eventRegistrations: [],
  events: [],
  ownerDashboard: null,
};

async function readJsonResponse(resp, url) {
  const text = await resp.text();
  const trimmed = text.trim();
  let data = {};

  if (trimmed) {
    try {
      data = JSON.parse(trimmed);
    } catch (error) {
      const parseError = new Error(`接口返回的不是 JSON：${url}（HTTP ${resp.status}）`);
      parseError.status = resp.status;
      parseError.url = url;
      parseError.responseText = trimmed.slice(0, 260);
      throw parseError;
    }
  }

  if (!resp.ok) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      data.success = data.success === true;
      data.http_status = resp.status;
      return data;
    }
    const httpError = new Error(`接口请求失败：${url}（HTTP ${resp.status}）`);
    httpError.status = resp.status;
    httpError.url = url;
    httpError.responseText = trimmed.slice(0, 260);
    throw httpError;
  }

  return data;
}

function apiGet(url) {
  return fetch(url, { credentials: 'same-origin' }).then((resp) => readJsonResponse(resp, url));
}

function apiPost(url, body) {
  const options = { method: 'POST', credentials: 'same-origin' };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  return fetch(url, options).then((resp) => readJsonResponse(resp, url));
}

function safeGet(url, fallback) {
  return apiGet(url).catch((error) => {
    console.warn('Optional data request failed:', url, error);
    return fallback;
  });
}

function normalizeError(error) {
  if (!error) return '未知错误';
  const parts = [error.message || String(error)];
  if (error.responseText) parts.push(error.responseText);
  return parts.join('：');
}

function normalizeClubList(payload, country) {
  const list = Array.isArray(payload) ? payload : (payload && (payload.data || payload.clubs)) || [];
  return list.map((club) => ({ ...club, country: club.country || country }));
}

function responseMessage(data, fallback) {
  return (data && (data.message || data.error)) || fallback;
}

function roleLabel(role) {
  return {
    external: '外交成员（IEM）',
    visitor: '访客',
    member: '成员',
    manager: '管理员',
    representative: '负责人',
    super_admin: '超级管理员',
  }[role] || role || '访客';
}

function countryLabel(country) {
  return country === 'japan' ? '日本' : '中国';
}

function DisplayClubTag({ club, className = '' }) {
  if (!club?.name || !['china', 'japan'].includes(club.country)) return null;
  const label = `${club.name} · ${roleLabel(club.role)}`;
  const fullLabel = `${countryLabel(club.country)}代表同好会：${label}`;
  return (
    <Tag className={`vn-display-club-tag ${className}`.trim()} title={fullLabel} aria-label={fullLabel}>
      {label}
    </Tag>
  );
}

function roleColor(role) {
  return {
    super_admin: '#ff6b5c',
    representative: '#ff6b5c',
    manager: '#e6ac52',
    member: '#57c089',
    external: '#64bed2',
    visitor: '#999999',
  }[role] || '#999999';
}

const roleLevelMap = {
  super_admin: 5,
  representative: 4,
  manager: 3,
  member: 2,
  external: 1,
  visitor: 0,
};

function sortByRole(list) {
  return [...list].sort((a, b) => (roleLevelMap[b.role] || 0) - (roleLevelMap[a.role] || 0));
}

function canManageClub(user, memberships) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  return memberships.some((m) => m.role === 'manager' || m.role === 'representative');
}

function completionScore(user, memberships) {
  const fields = [
    !!(user?.nickname || user?.username),
    !!user?.avatar_url,
    !!user?.profile_bio,
    !!user?.email,
    !!user?.qq_bound,
    !!user?.discord_bound,
    memberships.filter((m) => m.status === 'active').length > 0,
  ];
  return Math.round((fields.filter(Boolean).length / fields.length) * 100);
}

function resolveMediaUrl(url) {
  if (!url) return '';
  if (/^(https?:)?\/\//.test(url) || String(url).startsWith('data:')) return url;
  return `./${String(url).replace(/^\.?\//, '')}`;
}

const quickAccessItems = [
  { icon: <CalendarOutlined />, title: '活动投稿', desc: '提交活动到日历', href: './submit_event.html', always: true },
  { icon: <TagOutlined />, title: 'GalOnly 通道', desc: '高校专属摊位申请', href: './Galgame_events/galgameonly_list.html', always: true },
  { icon: <TeamOutlined />, title: '同好会广场', desc: '十二器、萌战与大型企划', href: './club_square.html', always: true },
  { icon: <SettingOutlined />, title: '同好会管理', desc: '负责人可用', href: './admin/club_manager.html', managerOnly: true },
  { icon: <FundOutlined />, title: '企划管理', desc: '负责人可用', href: './admin/club_project_manager.html', managerOnly: true },
  { icon: <BookOutlined />, title: '刊物管理', desc: '负责人可用', href: './wiki/publication-manage.html', managerOnly: true },
];

export default function App() {
  const [activeTab, setActiveTab] = useState('overview');
  const [language, setLanguage] = useState(() => (
    window.VNFLanguage?.getLanguage?.() === 'ja' ? 'ja' : 'zh'
  ));
  const [remountKey, setRemountKey] = useState(0);
  const prevLanguageRef = useRef(
    window.VNFLanguage?.getLanguage?.() === 'ja' ? 'ja' : 'zh'
  );
  const [themePreference, setThemePreference] = useState(() => (
    window.VNFTheme?.getPreference?.() || localStorage.getItem('themePreference') || 'system'
  ));
  const [isDark, setIsDark] = useState(() => {
    if (window.VNFTheme && typeof window.VNFTheme.getEffectiveTheme === 'function') {
      return window.VNFTheme.getEffectiveTheme() === 'dark';
    }
    const saved = localStorage.getItem('themePreference');
    if (saved === 'light' || saved === 'dark') return saved === 'dark';
    const legacy = localStorage.getItem('vnfest-theme');
    if (legacy === 'light' || legacy === 'dark') {
      localStorage.setItem('themePreference', legacy);
      return legacy === 'dark';
    }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  const [isMobile, setIsMobile] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState(initialData);
  const [messageApi, contextHolder] = message.useMessage();

  const t = isDark ? darkTokens : lightTokens;
  const themeConfig = buildTheme(isDark);
  const antdLocale = language === 'ja' ? jaJP : zhCN;
  const activeMemberships = data.memberships.filter((m) => m.status === 'active');
  const isManager = canManageClub(data.user, activeMemberships);
  const completion = completionScore(data.user, activeMemberships);

  const reloadData = useCallback(async (options = {}) => {
    if (!options.silent) {
      setLoading(true);
      setError('');
    }

    try {
      const auth = await apiGet(`./api/auth.php?action=me&_=${Date.now()}`);
      if (!auth || !auth.logged_in) {
        window.location.replace(loginUrl);
        return false;
      }

      const user = auth.user || null;
      const authMemberships = Array.isArray(auth.memberships) ? auth.memberships : [];
      const membershipData = await safeGet('./api/membership.php?action=my', { success: false, memberships: authMemberships });
      const memberships = membershipData.success && Array.isArray(membershipData.memberships)
        ? membershipData.memberships
        : authMemberships;

      const results = await Promise.all([
        safeGet('./api/clubs.php', { success: false, data: [] }),
        safeGet('./api/clubs_japan.php', { success: false, data: [] }),
        safeGet('./api/notifications.php?action=count_unread', { success: false, count: 0 }),
        safeGet('./api/notifications.php?action=list&page=1&limit=100', { success: false, notifications: [] }),
        safeGet('./api/events.php?action=registrations', { success: false, registrations: [] }),
        safeGet('./api/events.php?action=list', { success: false, events: [] }),
      ]);

      const clubs = normalizeClubList(results[0], 'china').concat(normalizeClubList(results[1], 'japan'));
      const clubDirectoryAvailability = {
        china: results[0]?.success !== false && (Array.isArray(results[0]) || Array.isArray(results[0]?.data) || Array.isArray(results[0]?.clubs)),
        japan: results[1]?.success !== false && (Array.isArray(results[1]) || Array.isArray(results[1]?.data) || Array.isArray(results[1]?.clubs)),
      };
      const next = {
        user,
        memberships,
        clubs,
        clubDirectoryAvailability,
        unread: results[2].success ? Number(results[2].count || 0) : 0,
        notifications: Array.isArray(results[3].notifications) ? results[3].notifications : [],
        eventRegistrations: Array.isArray(results[4].registrations) ? results[4].registrations : [],
        events: Array.isArray(results[5].events) ? results[5].events : [],
        pending: [],
        ownerDashboard: null,
      };

      if (canManageClub(user, memberships.filter((m) => m.status === 'active'))) {
        const managerResults = await Promise.all([
          safeGet('./api/membership.php?action=pending', { success: false, memberships: [] }),
          safeGet('./api/growth.php?action=owner_dashboard', { success: false, clubs: [], analytics: {} }),
        ]);
        next.pending = managerResults[0].success ? (managerResults[0].memberships || []) : [];
        next.ownerDashboard = managerResults[1].success ? managerResults[1] : null;
      }

      setData(next);
      setLoading(false);
      return true;
    } catch (err) {
      setError(normalizeError(err));
      setLoading(false);
      return false;
    }
  }, []);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 1100);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    if (window.VNFTheme && typeof window.VNFTheme.subscribe === 'function') {
      return window.VNFTheme.subscribe((detail) => {
        setIsDark(detail.theme === 'dark');
        setThemePreference(detail.preference);
      });
    }
    return undefined;
  }, []);

  useEffect(() => {
    if (!window.VNFLanguage || typeof window.VNFLanguage.subscribe !== 'function') return undefined;
    // page-i18n 对 React 托管页面在 ja→zh 时不写回 DOM（其 DOM 翻译是单向的），
    // 而 React 的 VDOM 文本始终是中文，diff 不会更新已被就地改写为日文的文本节点，
    // 因此需要在 ja→zh 时强制重挂载，让 React 用 VDOM（中文）重建 DOM。
    const applyLanguage = (next) => {
      const lang = next === 'ja' ? 'ja' : 'zh';
      if (prevLanguageRef.current === 'ja' && lang === 'zh') {
        setRemountKey((key) => key + 1);
      }
      prevLanguageRef.current = lang;
      setLanguage(lang);
    };
    const unsubscribe = window.VNFLanguage.subscribe((detail) => {
      applyLanguage(detail?.language);
    });
    window.VNFLanguage.ready?.then?.(() => {
      applyLanguage(window.VNFLanguage.getLanguage());
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.PageI18n?.apply?.(document.body);
      document.title = language === 'ja' ? 'ユーザーセンター - VNFest' : '用户中心 - VNFest';
    }, 0);
    return () => window.clearTimeout(timer);
  }, [language, activeTab]);

  useEffect(() => {
    if (window.VNFTheme && typeof window.VNFTheme.apply === 'function') return;
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
    localStorage.setItem('themePreference', isDark ? 'dark' : 'light');
  }, [isDark]);

  const setThemeMode = useCallback((next) => {
    if (window.VNFTheme && typeof window.VNFTheme.setPreference === 'function') {
      window.VNFTheme.setPreference(next);
      return;
    }
    localStorage.setItem('themePreference', next);
    setThemePreference(next);
    setIsDark(next === 'dark');
  }, []);

  useEffect(() => {
    reloadData();
  }, [reloadData]);

  const handleTabChange = useCallback((key) => {
    setActiveTab(key);
    setSidebarOpen(false);
  }, []);

  const runAction = useCallback(async (action, successText) => {
    try {
      const dataResult = await action();
      if (dataResult && dataResult.success === false) {
        messageApi.error(responseMessage(dataResult, '操作失败'));
        return false;
      }
      messageApi.success(responseMessage(dataResult, successText));
      await reloadData({ silent: true });
      return true;
    } catch (err) {
      messageApi.error(normalizeError(err));
      return false;
    }
  }, [messageApi, reloadData]);

  const actions = useMemo(() => ({
    async logout() {
      await apiGet('./api/auth.php?action=logout').catch(() => null);
      // 登出后回到登录页；重新登录后仍返回用户中心
      window.location.href = loginUrl;
    },
    saveProfile(nickname, profileBio) {
      return runAction(
        () => apiPost('./api/auth.php?action=update_profile', { nickname: nickname.trim(), profile_bio: profileBio.trim() }),
        '资料已保存'
      );
    },
    sendEmailCode(email) {
      return runAction(
        () => apiPost('./api/auth.php?action=send_code', { email: email.trim() }),
        '验证码已发送'
      );
    },
    bindEmail(email, code) {
      return runAction(
        () => apiPost('./api/auth.php?action=bind_email', { email: email.trim(), code: code.trim() }),
        '邮箱已绑定'
      );
    },
    unbindEmail() {
      return runAction(() => apiPost('./api/auth.php?action=unbind_email'), '邮箱已解绑');
    },
    setMembershipApplicationEmailPreference(enabled) {
      return runAction(
        () => apiPost('./api/auth.php?action=update_membership_application_email_preference', { enabled }),
        enabled ? '已开启同好会申请邮件提醒' : '已关闭同好会申请邮件提醒'
      );
    },
    saveDisplayClub(membershipId) {
      return runAction(
        () => apiPost('./api/auth.php?action=update_display_club', { membership_id: membershipId }),
        membershipId == null ? '已取消展示代表同好会' : '代表同好会已更新'
      );
    },
    reload() {
      return reloadData();
    },
    changePassword(currentPassword, newPassword) {
      return runAction(
        () => apiPost('./api/auth.php?action=change_password', { current_password: currentPassword, new_password: newPassword }),
        '密码已修改'
      );
    },
    unbindProvider(provider) {
      return runAction(() => apiPost(`./api/auth.php?action=unbind_${provider}`), '绑定已解除');
    },
    redeemCode(code) {
      return runAction(
        () => apiPost('./api/club_codes.php?action=redeem', { code: code.trim() }),
        '加入同好会成功'
      );
    },
    approveMembership(id) {
      return runAction(
        () => apiPost('./api/membership.php?action=approve', { membership_id: Number(id) }),
        '申请已通过'
      );
    },
    rejectMembership(id) {
      return runAction(
        () => apiPost('./api/membership.php?action=reject', { membership_id: Number(id) }),
        '申请已拒绝'
      );
    },
    markNoticeRead(id) {
      return runAction(
        () => apiPost('./api/notifications.php?action=mark_read', { id: Number(id) }),
        '通知已标记为已读'
      );
    },
    markAllRead() {
      return runAction(() => apiPost('./api/notifications.php?action=mark_all_read'), '全部通知已标记为已读');
    },
    async uploadAvatar(file) {
      try {
        const form = new FormData();
        form.append('avatar', file);
        const resp = await fetch('./api/avatar.php?action=upload', {
          method: 'POST',
          credentials: 'same-origin',
          body: form,
        });
        const result = await readJsonResponse(resp, './api/avatar.php?action=upload');
        if (result.success === false) {
          messageApi.error(responseMessage(result, '头像上传失败'));
          return Upload.LIST_IGNORE;
        }
        messageApi.success(responseMessage(result, '头像已更新'));
        await reloadData({ silent: true });
      } catch (err) {
        messageApi.error(normalizeError(err));
      }
      return Upload.LIST_IGNORE;
    },
    async copyShare(url, clubKey) {
      try {
        await navigator.clipboard.writeText(new URL(url, window.location.href).toString());
        messageApi.success('分享链接已复制');
        if (clubKey) {
          apiPost('./api/growth.php?action=record', {
            event: 'club_share_copy',
            club_key: clubKey,
            source: 'user_center',
          }).catch(() => null);
        }
      } catch (err) {
        messageApi.error('复制失败，请手动复制链接');
      }
    },
  }), [messageApi, reloadData, runAction]);

  const sidebarContent = (
    <div className="vn-sider-inner">
      <div className="vn-nav-wrap">
        <Menu
          mode="inline"
          selectedKeys={[activeTab]}
          onClick={({ key }) => handleTabChange(key)}
          style={{ border: 'none', background: 'transparent' }}
          items={[
            { key: 'overview', icon: <HomeOutlined />, label: '总览' },
            { key: 'account', icon: <SafetyOutlined />, label: '账户' },
            { key: 'preferences', icon: <SettingOutlined />, label: '偏好设置' },
            { key: 'clubs', icon: <TeamOutlined />, label: '同好会' },
            {
              key: 'notifications',
              icon: <BellOutlined />,
              label: data.unread > 0 ? (
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                  通知
                  <Badge count={data.unread} size="small" style={{ backgroundColor: t.primary }} />
                </span>
              ) : '通知',
            },
          ]}
        />
      </div>

      <div className="vn-sider-footer">
        <Button icon={<EnvironmentOutlined />} block href="./index.html?guest=1">
          返回地图
        </Button>
        <Button icon={<LogoutOutlined />} danger block onClick={actions.logout}>
          退出登录
        </Button>
      </div>
    </div>
  );

  if (loading) {
    return (
      <ConfigProvider theme={themeConfig} locale={antdLocale}>
        <div className="vn-loading-screen">
          <Spin size="large" />
          <Text type="secondary">正在连接用户中心后端...</Text>
        </div>
      </ConfigProvider>
    );
  }

  if (error) {
    return (
      <ConfigProvider theme={themeConfig} locale={antdLocale}>
        <div className="vn-loading-screen">
          <Alert
            type="error"
            showIcon
            message="用户中心加载失败"
            description={error}
            action={<Button icon={<ReloadOutlined />} onClick={() => reloadData()}>重试</Button>}
          />
        </div>
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider theme={themeConfig} locale={antdLocale}>
      {contextHolder}
      <Layout key={remountKey} style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
        <header className="vn-topbar" data-page-header>
          <div className={isMobile ? undefined : 'vn-topbar-leading'}>
            <a className="vn-topbar-brand" href="./index.html?guest=1">
              <span className="vn-topbar-name">VNFest</span>
              <span className="vn-topbar-divider" />
              <span className="vn-topbar-sub">用户中心</span>
            </a>
            {isMobile && (
              <Button
                className="vn-menu-toggle"
                type="text"
                icon={<MenuOutlined />}
                onClick={() => setSidebarOpen(true)}
              />
            )}
          </div>
          <Space className={isMobile ? undefined : 'vn-topbar-actions'} size={4}>
            {isMobile && (
              <Tooltip title={language === 'ja' ? '切换到中文' : '切换到日本語'}>
                <Button
                  className="vn-topbar-action vn-topbar-quick is-icon"
                  type="text"
                  icon={<TranslationOutlined />}
                  onClick={() => {
                    const next = language === 'ja' ? 'zh' : 'ja';
                    if (!window.VNFLanguage?.setPreference) return;
                    window.VNFLanguage.setPreference(next).then((result) => {
                      if (result && result.success === false && result.error) {
                        messageApi.error(result.error);
                      }
                    }).catch(() => {});
                  }}
                  aria-label={language === 'ja' ? '切换到中文' : '切换到日本語'}
                />
              </Tooltip>
            )}
            {isMobile && (
              <Tooltip title={isDark ? '切换到浅色' : '切换到深色'}>
                <Button
                  className="vn-topbar-action vn-topbar-quick is-icon"
                  type="text"
                  icon={isDark ? <SunOutlined /> : <MoonOutlined />}
                  onClick={() => setThemeMode(isDark ? 'light' : 'dark')}
                  aria-label={isDark ? '切换到浅色' : '切换到深色'}
                />
              </Tooltip>
            )}
            <Tooltip title="刷新数据">
              <Button className={isMobile ? undefined : 'vn-topbar-action is-icon'} type="text" icon={<ReloadOutlined />} onClick={() => reloadData({ silent: true })} aria-label="刷新数据" />
            </Tooltip>
          </Space>
        </header>

        <Layout style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row' }}>
          {isMobile ? (
            <Drawer
              placement="left"
              open={sidebarOpen}
              onClose={() => setSidebarOpen(false)}
              width={280}
              styles={{ body: { padding: 0 } }}
              closable={false}
            >
              <div className="vn-sider">{sidebarContent}</div>
            </Drawer>
          ) : (
            <Sider
              width={252}
              style={{
                background: t.bg,
                borderRight: `1px solid ${t.border}`,
                height: '100%',
                overflow: 'hidden',
              }}
            >
              <div className="vn-sider">{sidebarContent}</div>
            </Sider>
          )}

          <div className="vn-content-scroll">
            <div className="vn-page-inner">
              {activeTab === 'overview' && (
                <OverviewPage
                  data={data}
                  activeMemberships={activeMemberships}
                  isManager={isManager}
                  completion={completion}
                  themeTokens={t}
                  onSwitchTab={handleTabChange}
                  onCopyShare={actions.copyShare}
                />
              )}

              {activeTab === 'account' && (
                <section className="vn-animate-in" data-component="账户设置" data-od-id="account">
                  <AccountTab
                    user={data.user}
                    memberships={data.memberships}
                    clubs={data.clubs}
                    clubDirectoryAvailability={data.clubDirectoryAvailability}
                    themeTokens={t}
                    messageApi={messageApi}
                    actions={actions}
                    onSwitchTab={handleTabChange}
                  />
                </section>
              )}

              {activeTab === 'preferences' && (
                <section className="vn-animate-in" data-component="偏好设置" data-od-id="preferences">
                  <PreferencesTab
                    language={language}
                    themePreference={themePreference}
                    setThemeMode={setThemeMode}
                    messageApi={messageApi}
                  />
                </section>
              )}

              {activeTab === 'clubs' && (
                <section className="vn-animate-in" data-component="同好会管理" data-od-id="clubs">
                  <ClubsTab
                    memberships={activeMemberships}
                    clubs={data.clubs}
                    pending={data.pending}
                    isManager={isManager}
                    actions={actions}
                  />
                </section>
              )}

              {activeTab === 'notifications' && (
                <section className="vn-animate-in" data-component="通知中心" data-od-id="notifications">
                  <NotificationsTab
                    notifications={data.notifications}
                    actions={actions}
                  />
                </section>
              )}
            </div>
          </div>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}

function OverviewPage({ data, activeMemberships, isManager, completion, themeTokens, onSwitchTab, onCopyShare }) {
  const user = data.user || {};
  const eventCount = data.eventRegistrations.filter((item) => Number(item.user_id) === Number(user.id)).length;

  return (
    <>
      <section className="vn-hero vn-animate-in" data-component="个人驾驶舱" data-od-id="hero">
        <Card className="vn-identity-card" bordered={false}>
          <div className="vn-identity-inner">
            <div className="vn-avatar-wrap">
              <Avatar
                size={88}
                style={{
                  borderRadius: 8,
                  backgroundColor: themeTokens.avatarBg,
                  color: themeTokens.avatarFg,
                  fontSize: 34,
                  fontWeight: 700,
                }}
                src={user.avatar_url ? resolveMediaUrl(user.avatar_url) : undefined}
              >
                {(user.nickname || user.username || 'U').charAt(0)}
              </Avatar>
            </div>
            <div>
              <div className="vn-kicker">用户中心</div>
              <Title level={1} className="vn-hero-name">
                {user.nickname || user.username || '用户'}
              </Title>
              <p className="vn-hero-bio">
                {user.profile_bio || '还没有填写签名。'}
              </p>

              <div className="vn-hero-foot">
                <div className="vn-badges">
                  <Tag color={themeTokens.primary} style={{ fontWeight: 600 }}>
                    {roleLabel(user.role)}
                  </Tag>
                  <Tag>{user.email ? '邮箱已绑定' : '邮箱未绑定'}</Tag>
                  <Tag>{user.qq_bound ? 'QQ 已绑定' : 'QQ 未绑定'}</Tag>
                  <Tag>{user.discord_bound ? 'Discord 已绑定' : 'Discord 未绑定'}</Tag>
                  <DisplayClubTag club={user.display_club} />
                </div>
                <div className="vn-completion">
                  <div className="vn-completion-top">
                    <span>账号完整度</span>
                    <strong>{completion}%</strong>
                  </div>
                  <Progress
                    percent={completion}
                    showInfo={false}
                    strokeColor={themeTokens.primary}
                    trailColor={themeTokens.overlay}
                    size={['100%', 6]}
                  />
                </div>
              </div>

              <div className="vn-cockpit-stats">
                <div className="vn-stat-chip">
                  <Statistic title="我的同好会" value={activeMemberships.length} />
                </div>
                <div className="vn-stat-chip">
                  <Statistic title="未读通知" value={data.unread} />
                </div>
                <div className="vn-stat-chip">
                  <Statistic title="已报名活动" value={eventCount} />
                </div>
                <div className="vn-stat-chip">
                  <Statistic title="资料完整度" value={completion} suffix="%" />
                </div>
              </div>
            </div>
          </div>
        </Card>

        <Card
          title="今日待办"
          extra={
            <Text type="secondary" style={{ fontSize: 12 }}>
              {new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short' })}
            </Text>
          }
          bordered={false}
          size="small"
        >
          <button className="vn-today-item" type="button" onClick={() => onSwitchTab('clubs')}>
            <span className="vn-today-token urgent">审</span>
            <span className="vn-today-label"><strong>成员申请</strong><span>负责人待处理</span></span>
            <span className="vn-today-count urgent">{isManager ? data.pending.length : 0}</span>
          </button>
          <button className="vn-today-item" type="button" onClick={() => onSwitchTab('notifications')}>
            <span className="vn-today-token warn">信</span>
            <span className="vn-today-label"><strong>未读通知</strong><span>系统与审核反馈</span></span>
            <span className="vn-today-count warn">{data.unread}</span>
          </button>
          <button className="vn-today-item" type="button" onClick={() => onSwitchTab('overview')}>
            <span className="vn-today-token good">活</span>
            <span className="vn-today-label"><strong>报名活动</strong><span>已登记活动记录</span></span>
            <span className="vn-today-count good">{eventCount}</span>
          </button>
        </Card>
      </section>

      <section className="vn-animate-in vn-stagger-1">
        <div className="vn-qa-label">Quick Access</div>
        <div className="vn-qa-grid" style={{ marginTop: 10 }}>
          {quickAccessItems
            .filter((item) => item.always || !item.managerOnly || isManager)
            .map((item) => (
              <a className="vn-qa-card" href={item.href} key={item.title}>
                <span className="vn-qa-icon">{item.icon}</span>
                <span><strong>{item.title}</strong><span>{item.desc}</span></span>
              </a>
            ))}
        </div>
      </section>

      <OverviewTab
        memberships={activeMemberships}
        clubs={data.clubs}
        notifications={data.notifications}
        eventRegs={data.eventRegistrations}
        events={data.events}
        userId={user.id}
        isManager={isManager}
        ownerDashboard={data.ownerDashboard}
        onSwitchTab={onSwitchTab}
        onCopyShare={onCopyShare}
      />
    </>
  );
}

function OverviewTab({ memberships, clubs, notifications, eventRegs, events, userId, isManager, ownerDashboard, onSwitchTab, onCopyShare }) {
  const findClub = (membership) => clubs.find((c) => (
    Number(c.id) === Number(membership.club_id)
    && (c.country || 'china') === (membership.country || 'china')
  ));

  const clubListItems = sortByRole(memberships).slice(0, 4).map((m) => {
    const club = findClub(m);
    const name = club?.display_name || club?.name || m.club_name || `同好会 #${m.club_id}`;
    return {
      key: m.id,
      name,
      subtitle: `${countryLabel(m.country || club?.country)} · ${club?.school || '同好会成员'}`,
      role: roleLabel(m.role),
      roleColor: roleColor(m.role),
      initial: name.charAt(0),
    };
  });

  const eventItems = eventRegs.filter((reg) => Number(reg.user_id) === Number(userId)).slice(0, 4);

  return (
    <div className="vn-panel-grid vn-animate-in vn-stagger-2">
      <Card
        title="我的同好会"
        size="small"
        bordered={false}
        extra={<Button type="link" size="small" onClick={() => onSwitchTab('clubs')}>查看</Button>}
      >
        {clubListItems.length > 0 ? (
          clubListItems.map((item) => (
            <div key={item.key} className="vn-list-item">
              <span className="vn-mini-avatar">{item.initial}</span>
              <div className="vn-list-body">
                <strong>{item.name}</strong>
                <span>{item.subtitle}</span>
              </div>
              <Tag color={item.roleColor}>{item.role}</Tag>
            </div>
          ))
        ) : (
          <Empty description="暂无同好会" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>

      {isManager && ownerDashboard?.clubs?.length > 0 && (
        <Card
          title="负责人工作台"
          size="small"
          bordered={false}
          extra={<Button type="link" size="small" href="./admin/club_manager.html">管理</Button>}
        >
          {ownerDashboard.clubs.slice(0, 3).map((club) => {
            const shareUrl = club.share_url || `./club_share.html?club=${encodeURIComponent(club.key || '')}`;
            return (
              <div key={club.key || club.name} className="vn-list-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div className="vn-list-body" style={{ flex: 1 }}>
                  <strong>{club.name || club.key || '同好会'}</strong>
                  <span>{club.region || club.school || ''}</span>
                </div>
                <Space wrap style={{ marginTop: 8 }}>
                  <Tag color="green">完整度 {club.completeness?.score || 0}%</Tag>
                  <Tag>待审核 {club.pending_members || 0}</Tag>
                  <Tag>成员 {club.member_count || 0}</Tag>
                  <Tag>访问 {club.analytics?.club_share_view || 0}</Tag>
                </Space>
                <Space wrap style={{ marginTop: 8 }}>
                  <Button size="small" type="text" icon={<LinkOutlined />} href={shareUrl}>分享页</Button>
                  <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => onCopyShare(shareUrl, club.key)}>复制邀请</Button>
                  <Button size="small" type="text" icon={<CalendarOutlined />} href="./submit_event.html">发活动</Button>
                </Space>
              </div>
            );
          })}
        </Card>
      )}

      <Card
        title="最近通知"
        size="small"
        bordered={false}
        extra={<Button type="link" size="small" onClick={() => onSwitchTab('notifications')}>查看</Button>}
      >
        {notifications.length > 0 ? (
          notifications.slice(0, 4).map((n) => (
            <div key={n.id} className="vn-list-item">
              <div className="vn-list-body" style={{ flex: 1 }}>
                <strong>{n.title || '通知'}</strong>
                <span>{n.message || ''}</span>
              </div>
              <Tag color={Number(n.is_read) ? undefined : 'red'}>{Number(n.is_read) ? '已读' : '未读'}</Tag>
            </div>
          ))
        ) : (
          <Empty description="暂无通知" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>

      <Card
        title="报名活动"
        size="small"
        bordered={false}
        extra={<Button type="link" size="small" href="./Galgame_events/galgameonly_list.html">活动日历</Button>}
      >
        {eventItems.length > 0 ? (
          eventItems.map((reg) => {
            const ev = events.find((e) => Number(e.id) === Number(reg.event_id));
            return (
              <div key={reg.id} className="vn-list-item">
                <span className="vn-mini-avatar"><CalendarOutlined /></span>
                <div className="vn-list-body">
                  <strong>{ev?.event || ev?.title || `活动 #${reg.event_id}`}</strong>
                  <span>{(reg.registered_at || '').split(' ')[0] || '已报名'}</span>
                </div>
                <Tag color="green">已报名</Tag>
              </div>
            );
          })
        ) : (
          <Empty description="暂无报名记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>
    </div>
  );
}

function PreferencesTab({ language, themePreference, setThemeMode, messageApi }) {
  const displayPreferences = window.VNFDisplayPreferences;
  const wallpaperRuntime = window.VNFWallpaper;
  const [mapInvert, setMapInvert] = useState(() => displayPreferences?.getMapInvert?.() ?? true);
  const [wallpaperState, setWallpaperState] = useState(() => wallpaperRuntime?.getState?.() || ({
    status: 'loading', images: [], preference: '__random__', activeUrl: '',
    authenticated: true, mobileDisabled: false, error: null,
  }));
  const [failedImages, setFailedImages] = useState(() => new Set());
  const [selecting, setSelecting] = useState('');
  const [languageSaving, setLanguageSaving] = useState(false);
  const l = useCallback((key, params) => window.VNFLanguage?.t?.(key, params) || key, [language]);

  useEffect(() => displayPreferences?.subscribe?.(setMapInvert), [displayPreferences]);
  useEffect(() => wallpaperRuntime?.subscribe?.(setWallpaperState), [wallpaperRuntime]);

  const chooseLanguage = async (next) => {
    if (next === language || languageSaving || !window.VNFLanguage?.setPreference) return;
    setLanguageSaving(true);
    try {
      const result = await window.VNFLanguage.setPreference(next);
      if (result?.success) messageApi.success(l('preferences.language.saved'));
      else messageApi.error(result?.error || l('preferences.language.saveFailed'));
    } catch (error) {
      messageApi.error(l('preferences.language.saveFailed'));
    } finally {
      setLanguageSaving(false);
    }
  };

  const chooseWallpaper = async (value) => {
    if (!wallpaperRuntime?.setPreference || selecting) return;
    setSelecting(value);
    try {
      const result = await wallpaperRuntime.setPreference(value);
      if (!result?.success) messageApi.error(result?.error || '壁纸应用失败，已恢复之前的设置。');
    } catch (error) {
      messageApi.error('壁纸应用失败，已恢复之前的设置。');
    } finally {
      setSelecting('');
    }
  };

  const markImageFailed = (url) => {
    setFailedImages((current) => {
      const next = new Set(current);
      next.add(url);
      return next;
    });
  };

  const renderGallery = () => {
    if (!wallpaperRuntime) {
      return <Alert type="error" showIcon message="壁纸运行时未加载" description="请刷新页面后重试。" />;
    }
    if (wallpaperState.status === 'loading') {
      return (
        <div className="vn-wallpaper-grid" aria-label="正在加载壁纸">
          {Array.from({ length: 6 }, (_, index) => <Skeleton.Button key={index} active block className="vn-wallpaper-skeleton" />)}
        </div>
      );
    }
    if (wallpaperState.status === 'error') {
      return (
        <Alert
          type="error"
          showIcon
          message="壁纸列表加载失败"
          description={wallpaperState.error || '请检查网络后重新加载。'}
          action={<Button icon={<ReloadOutlined />} onClick={() => wallpaperRuntime.reload()}>重新加载</Button>}
        />
      );
    }
    if (wallpaperState.status === 'empty') {
      return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可选壁纸" />;
    }

    const options = [
      { name: '随机壁纸', url: '__random__', random: true },
      ...wallpaperState.images,
    ];
    return (
      <div className="vn-wallpaper-grid" role="list" aria-busy={!!selecting}>
        {options.map((item) => {
          const value = item.random ? '__random__' : item.url;
          const selected = wallpaperState.preference === value;
          const unavailable = !item.random && failedImages.has(item.url);
          return (
            <button
              type="button"
              role="listitem"
              key={value}
              className={`vn-wallpaper-option${selected ? ' is-selected' : ''}${unavailable ? ' is-unavailable' : ''}`}
              aria-label={`${item.name}${selected ? '，当前已选择' : ''}${unavailable ? '，图片不可用' : ''}`}
              aria-pressed={selected}
              disabled={unavailable || !!selecting}
              title={item.name}
              onClick={() => chooseWallpaper(value)}
            >
              <span className="vn-wallpaper-preview">
                {item.random ? (
                  <span className="vn-wallpaper-random"><ReloadOutlined /><span>每次随机</span></span>
                ) : (
                  <img src={item.url} alt="" loading="lazy" onError={() => markImageFailed(item.url)} />
                )}
                {selected && <span className="vn-wallpaper-check" aria-hidden="true"><CheckOutlined /></span>}
                {selecting === value && <Spin className="vn-wallpaper-spinner" size="small" />}
              </span>
              <span className="vn-wallpaper-name">{item.name}</span>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="vn-preferences-page">
      <header className="vn-preferences-header">
        <Title level={2}>偏好设置</Title>
        <Text type="secondary">{l('preferences.browserOnly')}</Text>
      </header>

      <div className="vn-preferences-stack">
        <Card title={l('preferences.language.title')} size="small" bordered={false}>
          <div className="vn-setting-row vn-setting-row-wide">
            <div>
              <strong>{l('preferences.language.title')}</strong>
              <span>{l('preferences.language.description')}</span>
            </div>
            <div className="vn-language-control">
              <Segmented
                className="vn-language-segmented"
                value={language}
                disabled={languageSaving}
                onChange={chooseLanguage}
                aria-label={l('preferences.language.title')}
                options={[
                  { label: l('common.chinese'), value: 'zh' },
                  { label: l('common.japanese'), value: 'ja' },
                ]}
              />
              <Text type="secondary" aria-live="polite">
                {languageSaving ? l('common.saving') : l('preferences.language.current', {
                  language: language === 'ja' ? l('common.japanese') : l('common.chinese'),
                })}
              </Text>
            </div>
          </div>
        </Card>

        <Card title="外观" size="small" bordered={false}>
          <div className="vn-setting-row vn-setting-row-wide">
            <div>
              <strong>颜色模式</strong>
              <span>选择浅色、深色，或跟随设备的系统设置。</span>
            </div>
            <Segmented
              className="vn-theme-segmented"
              value={themePreference}
              onChange={setThemeMode}
              aria-label="颜色模式"
              options={[
                { label: '浅色', value: 'light' },
                { label: '深色', value: 'dark' },
                { label: '跟随系统', value: 'system' },
              ]}
            />
          </div>
        </Card>

        <Card title="地图操作" size="small" bordered={false}>
          <div className="vn-setting-row vn-setting-row-wide">
            <div>
              <strong>{mapInvert ? '普通点击进入详情' : '普通点击显示地图气泡'}</strong>
              <span>
                {mapInvert
                  ? '已开启反转操作：普通点击进入详情，Ctrl + 点击显示地图气泡。'
                  : '已关闭反转操作：普通点击显示地图气泡，Ctrl + 点击进入详情。'}
              </span>
            </div>
            <Switch
              checked={mapInvert}
              aria-label="切换地图反转操作"
              onChange={(enabled) => displayPreferences?.setMapInvert?.(enabled)}
            />
          </div>
        </Card>

        <Card title="壁纸" size="small" bordered={false}>
          <div className="vn-wallpaper-heading">
            <Text type="secondary">选择后立即应用到支持壁纸的页面。随机壁纸会在每次页面初始化时重新选择。</Text>
            {wallpaperState.mobileDisabled && (
              <Alert type="info" showIcon message="你可以在手机上修改选择；壁纸将在支持壁纸的桌面设备上生效。" />
            )}
          </div>
          {renderGallery()}
        </Card>
      </div>
    </div>
  );
}

function AccountTab({ user, memberships, clubs, clubDirectoryAvailability, themeTokens, messageApi, actions, onSwitchTab }) {
  const [nickname, setNickname] = useState(user?.nickname || user?.username || '');
  const [bio, setBio] = useState(user?.profile_bio || '');
  const [email, setEmail] = useState(user?.email || '');
  const [applicationEmailEnabled, setApplicationEmailEnabled] = useState(user?.membership_application_email_enabled !== false);
  const [displayMembershipId, setDisplayMembershipId] = useState(user?.display_membership_id || null);
  const [displaySaving, setDisplaySaving] = useState(false);
  const [code, setCode] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  useEffect(() => {
    setNickname(user?.nickname || user?.username || '');
    setBio(user?.profile_bio || '');
    setEmail(user?.email || '');
    setApplicationEmailEnabled(user?.membership_application_email_enabled !== false);
    setDisplayMembershipId(user?.display_membership_id || null);
  }, [user]);

  const formalDisplayMemberships = (memberships || []).filter((membership) => (
    membership.status === 'active'
    && ['member', 'manager', 'representative'].includes(membership.role)
  ));
  const eligibleDisplayMemberships = formalDisplayMemberships.map((membership) => {
    const club = (clubs || []).find((item) => (
      Number(item.id) === Number(membership.club_id)
      && (item.country || 'china') === (membership.country || 'china')
    ));
    return club ? { membership, club } : null;
  }).filter(Boolean);
  const selectedDisplayEntry = eligibleDisplayMemberships.find(({ membership }) => (
    Number(membership.id) === Number(displayMembershipId)
  ));
  const savedDisplayMembershipId = user?.display_membership_id || null;
  const effectiveDisplayMembershipId = selectedDisplayEntry ? displayMembershipId : null;
  const displaySelectionChanged = Number(effectiveDisplayMembershipId || 0) !== Number(savedDisplayMembershipId || 0);
  const hasUnresolvedDirectory = formalDisplayMemberships.some((membership) => {
    const country = membership.country || 'china';
    if (!clubDirectoryAvailability?.[country]) return true;
    return !eligibleDisplayMemberships.some(({ membership: candidate }) => Number(candidate.id) === Number(membership.id));
  });
  const hasInvalidSavedSelection = savedDisplayMembershipId && !eligibleDisplayMemberships.some(({ membership }) => (
    Number(membership.id) === Number(savedDisplayMembershipId)
  ));

  return (
    <div className="vn-account-grid">
      <div className="vn-account-primary">
      <Card title="个人资料" size="small" bordered={false} extra={<Text type="secondary" style={{ fontSize: 12 }}>公开展示信息</Text>}>
        <div style={{ display: 'grid', gap: 14 }}>
          <div>
            <Text type="secondary" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>头像</Text>
            <Upload
              accept="image/jpeg,image/png,image/gif,image/webp"
              showUploadList={false}
              beforeUpload={(file) => {
                if (file.size > 2 * 1024 * 1024) {
                  messageApi.error('图片大小不能超过 2MB');
                  return Upload.LIST_IGNORE;
                }
                return actions.uploadAvatar(file);
              }}
            >
              <Space align="center" size={16}>
                <Avatar
                  size={72}
                  style={{
                    borderRadius: 8,
                    backgroundColor: themeTokens.avatarBg,
                    color: themeTokens.avatarFg,
                    fontSize: 28,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                  src={user?.avatar_url ? resolveMediaUrl(user.avatar_url) : undefined}
                  icon={!user?.avatar_url ? <CameraOutlined /> : undefined}
                />
                <Button icon={<UploadOutlined />}>选择并上传</Button>
              </Space>
            </Upload>
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>昵称</Text>
            <Input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={30} placeholder="输入昵称" />
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>签名</Text>
            <TextArea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={300} rows={3} placeholder="介绍一下自己" />
          </div>
          <div className="vn-display-club-setting">
            <div className="vn-display-club-heading">
              <div>
                <strong>代表同好会</strong>
                <span>选择一个用于公开展示的正式隶属同好会；该信息会显示在账号总览和论坛作者信息中。</span>
              </div>
              <DisplayClubTag club={selectedDisplayEntry ? {
                name: selectedDisplayEntry.club.display_name || selectedDisplayEntry.club.name || selectedDisplayEntry.club.school,
                country: selectedDisplayEntry.membership.country || 'china',
                role: selectedDisplayEntry.membership.role,
              } : null} className="vn-display-club-preview" />
            </div>
            {hasInvalidSavedSelection && (
              <Alert type="warning" showIcon message="原代表同好会会籍已失效，请重新选择。" />
            )}
            {hasUnresolvedDirectory && (
              <Alert
                type="warning"
                showIcon
                message="同好会资料暂不可用，当前设置不会被清除。"
                action={<Button size="small" onClick={actions.reload}>重新加载</Button>}
              />
            )}
            <Select
              value={effectiveDisplayMembershipId || 0}
              onChange={(value) => setDisplayMembershipId(Number(value) > 0 ? Number(value) : null)}
              disabled={displaySaving || hasUnresolvedDirectory}
              aria-label="选择代表同好会"
              options={[
                { value: 0, label: '不展示' },
                ...eligibleDisplayMemberships.map(({ membership, club }) => ({
                  value: Number(membership.id),
                  label: `${countryLabel(membership.country || 'china')} · ${club.display_name || club.name || club.school} · ${roleLabel(membership.role)}`,
                })),
              ]}
            />
            {!hasUnresolvedDirectory && eligibleDisplayMemberships.length === 0 && (
              <div className="vn-display-club-empty">
                <span>暂无可展示的正式活跃会籍。</span>
                <Button size="small" onClick={() => onSwitchTab('clubs')}>前往同好会管理</Button>
              </div>
            )}
            <Button
              onClick={async () => {
                setDisplaySaving(true);
                await actions.saveDisplayClub(effectiveDisplayMembershipId);
                setDisplaySaving(false);
              }}
              loading={displaySaving}
              disabled={!displaySelectionChanged || hasUnresolvedDirectory}
            >
              保存展示设置
            </Button>
          </div>
          <Button
            type="primary"
            icon={<CheckOutlined />}
            onClick={() => {
              if (!nickname.trim()) {
                messageApi.error('昵称不能为空');
                return;
              }
              actions.saveProfile(nickname, bio);
            }}
          >
            保存资料
          </Button>
        </div>
      </Card>
      </div>

      <div className="vn-account-secondary">
      <Card title="账户安全" size="small" bordered={false} extra={<Text type="secondary" style={{ fontSize: 12 }}>邮箱与密码</Text>}>
        <div style={{ display: 'grid', gap: 14 }}>
          <div className="vn-list-item">
            <div className="vn-list-body" style={{ flex: 1 }}>
              <strong>{user?.email || '未绑定邮箱'}</strong>
              <span>用于找回账号与重要通知</span>
            </div>
            {user?.email && <Button size="small" danger onClick={actions.unbindEmail}>解绑</Button>}
          </div>
          <div className="vn-list-item">
            <div className="vn-list-body" style={{ flex: 1 }}>
              <strong>同好会申请邮件提醒</strong>
              <span>仅影响负责人和管理员的申请审批提醒；验证码和账号安全邮件不受影响。</span>
            </div>
            <Switch
              checked={applicationEmailEnabled}
              onChange={async (enabled) => {
                const previous = applicationEmailEnabled;
                setApplicationEmailEnabled(enabled);
                const ok = await actions.setMembershipApplicationEmailPreference(enabled);
                if (!ok) setApplicationEmailEnabled(previous);
              }}
            />
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>绑定 / 更换邮箱</Text>
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              <Text className="vn-field-label">邮箱地址</Text>
              <Input prefix={<MailOutlined />} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
              <Space wrap>
                <label className="vn-inline-field">
                  <span className="vn-field-label">验证码</span>
                  <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 位验证码" maxLength={6} style={{ width: 132 }} />
                </label>
                <Button onClick={() => actions.sendEmailCode(email)}>发送验证码</Button>
                <Button type="primary" onClick={() => actions.bindEmail(email, code)}>绑定邮箱</Button>
              </Space>
            </Space>
          </div>
          <div className="vn-account-divider" style={{ paddingTop: 14 }}>
            <Text type="secondary" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>修改密码</Text>
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              <Text className="vn-field-label">当前密码</Text>
              <Input.Password value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} prefix={<LockOutlined />} placeholder="当前密码" />
              <Text className="vn-field-label">新密码</Text>
              <Input.Password value={newPassword} onChange={(e) => setNewPassword(e.target.value)} prefix={<LockOutlined />} placeholder="新密码" />
              <Button
                type="primary"
                onClick={async () => {
                  const ok = await actions.changePassword(currentPassword, newPassword);
                  if (ok) {
                    setCurrentPassword('');
                    setNewPassword('');
                  }
                }}
              >
                修改密码
              </Button>
            </Space>
          </div>
        </div>
      </Card>

      <Card title="社交账号" size="small" bordered={false} extra={<Text type="secondary" style={{ fontSize: 12 }}>第三方登录绑定</Text>}>
        <div style={{ display: 'grid', gap: 10 }}>
          <SocialRow
            name="QQ"
            bound={!!user?.qq_bound}
            bindUrl="./api/auth.php?action=qq_auth&mode=bind"
            onUnbind={() => actions.unbindProvider('qq')}
          />
          <SocialRow
            name="Discord"
            bound={!!user?.discord_bound}
            bindUrl="./api/auth.php?action=discord_auth&mode=bind"
            onUnbind={() => actions.unbindProvider('discord')}
          />
        </div>
      </Card>
      </div>
    </div>
  );
}

function SocialRow({ name, bound, bindUrl, onUnbind }) {
  return (
    <div className="vn-list-item">
      <div className="vn-list-body" style={{ flex: 1 }}>
        <strong>{name}</strong>
        <span>{bound ? '已绑定' : '未绑定'}</span>
      </div>
      <Space>
        {!bound && <Button size="small" href={bindUrl}>绑定</Button>}
        {bound && <Button size="small" danger onClick={onUnbind}>解绑</Button>}
      </Space>
    </div>
  );
}

function ClubsTab({ memberships, clubs, pending, isManager, actions }) {
  const [code, setCode] = useState('');
  const findClub = (membership) => clubs.find((c) => (
    Number(c.id) === Number(membership.club_id)
    && (c.country || 'china') === (membership.country || 'china')
  ));

  return (
    <div className="vn-panel-grid">
      <Card title="绑定同好会" size="small" bordered={false} extra={<Text type="secondary" style={{ fontSize: 12 }}>使用负责人提供的绑定码</Text>}>
        <div style={{ display: 'grid', gap: 10 }}>
          <div>
            <Text type="secondary" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>绑定码</Text>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="输入绑定码" maxLength={40} />
          </div>
          <Button
            type="primary"
            icon={<CheckOutlined />}
            onClick={async () => {
              const ok = await actions.redeemCode(code);
              if (ok) setCode('');
            }}
          >
            加入同好会
          </Button>
        </div>
      </Card>

      <Card title="我的同好会" size="small" bordered={false} extra={<Text type="secondary" style={{ fontSize: 12 }}>{memberships.length} 个</Text>}>
        {memberships.length > 0 ? (
          sortByRole(memberships).map((m) => {
            const club = findClub(m);
            const name = club?.display_name || club?.name || m.club_name || `同好会 #${m.club_id}`;
            return (
              <div key={m.id} className="vn-list-item">
                <span className="vn-mini-avatar">{name.charAt(0)}</span>
                <div className="vn-list-body">
                  <strong>{name}</strong>
                  <span>{countryLabel(m.country || club?.country)} · {club?.school || '同好会成员'}</span>
                </div>
                <Tag color={roleColor(m.role)}>{roleLabel(m.role)}</Tag>
              </div>
            );
          })
        ) : (
          <Empty description="暂无同好会" image={Empty.PRESENTED_IMAGE_SIMPLE}>
            <Text type="secondary">在上方输入绑定码，或从地图详情页提交申请。</Text>
          </Empty>
        )}
      </Card>

      {isManager && (
        <Card
          title="成员申请"
          size="small"
          bordered={false}
          extra={<Text type="secondary" style={{ fontSize: 12 }}>{pending.length} 条</Text>}
          style={{ gridColumn: '1 / -1' }}
        >
          {pending.length > 0 ? pending.map((p) => (
            <div key={p.id} className="vn-list-item">
              <span className="vn-mini-avatar">{(p.nickname || p.username || '申').charAt(0)}</span>
              <div className="vn-list-body">
                <strong>{p.nickname || p.username || `用户 #${p.user_id}`}</strong>
                <span>{p.club_name || `同好会 #${p.club_id}`} · 申请 {roleLabel(p.apply_role || p.role)}</span>
              </div>
              <Space>
                <Button type="primary" size="small" icon={<CheckOutlined />} onClick={() => actions.approveMembership(p.id)}>通过</Button>
                <Button danger size="small" onClick={() => actions.rejectMembership(p.id)}>拒绝</Button>
              </Space>
            </div>
          )) : (
            <Empty description="暂无待处理申请" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </Card>
      )}
    </div>
  );
}

function NotificationsTab({ notifications, actions }) {
  return (
    <Card
      title="通知中心"
      size="small"
      bordered={false}
      extra={
        <Button type="text" size="small" icon={<CheckOutlined />} onClick={actions.markAllRead}>
          全部已读
        </Button>
      }
    >
      {notifications.length > 0 ? (
        notifications.map((n) => (
          <button
            key={n.id}
            className={`vn-notice-button${Number(n.is_read) ? '' : ' vn-notice-unread'}`}
            type="button"
            onClick={() => !Number(n.is_read) && actions.markNoticeRead(n.id)}
          >
            <div className="vn-list-body" style={{ flex: 1 }}>
              <strong>{n.title || '通知'}</strong>
              <span>{n.message || ''}</span>
            </div>
            <Tag color={Number(n.is_read) ? undefined : 'red'}>{Number(n.is_read) ? '已读' : '未读'}</Tag>
          </button>
        ))
      ) : (
        <Empty description="暂无通知" image={Empty.PRESENTED_IMAGE_SIMPLE}>
          <Text type="secondary">审核结果、绑定反馈和系统消息会出现在这里。</Text>
        </Empty>
      )}
      <Divider />
      <Button href="./index.html?guest=1" icon={<EnvironmentOutlined />}>返回地图</Button>
    </Card>
  );
}
