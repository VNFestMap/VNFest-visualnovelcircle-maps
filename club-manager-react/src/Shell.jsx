import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Button, Drawer, Layout, Menu, Select, Space, Statistic, Tooltip,
} from 'antd';
import {
  ApartmentOutlined, BellOutlined, CheckCircleOutlined, ClockCircleOutlined,
  CodeOutlined, DashboardOutlined, GlobalOutlined, KeyOutlined, LeftOutlined,
  MenuOutlined, MoonOutlined, ReloadOutlined, SafetyCertificateOutlined,
  SettingOutlined, SkinOutlined, SunOutlined, TeamOutlined, TrophyOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { TAB_META, clubKey, isSuperAdmin } from './model.js';

/* Slider geometry lives here so the measured offset and the rendered height can
   never drift apart; the indicator itself is positioned purely by transform. */
const SLIDER_HEIGHT = 20;

const iconMap = {
  pending: <ClockCircleOutlined />, diplomatic: <GlobalOutlined />, approved: <CheckCircleOutlined />,
  members: <TeamOutlined />, settings: <SettingOutlined />, codes: <KeyOutlined />,
  bot_tokens: <CodeOutlined />, recommendations: <TrophyOutlined />, projects: <ApartmentOutlined />, vote_projects: <TrophyOutlined />,
  recognition: <SafetyCertificateOutlined />, jiangsu: <DashboardOutlined />, users: <UserOutlined />,
};

export default function Shell({ state, actions, children }) {
  const [isMobile, setIsMobile] = useState(() => matchMedia('(max-width: 1100px)').matches);
  useEffect(() => {
    const query = matchMedia('(max-width: 1100px)');
    const update = () => setIsMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const navRef = useRef(null);
  const [slider, setSlider] = useState(null);
  const superAdmin = isSuperAdmin(state.auth);
  const visibleTabs = useMemo(() => TAB_META.filter((item) => !item.superAdmin || superAdmin), [superAdmin]);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const update = () => {
      const active = nav?.querySelector('.ant-menu-item-selected');
      if (!nav || !active || active.offsetParent === null) return setSlider(null);
      setSlider({ top: active.offsetTop + Math.max(0, (active.offsetHeight - SLIDER_HEIGHT) / 2), height: SLIDER_HEIGHT });
    };
    update();
    const frame = requestAnimationFrame(update);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    if (nav) observer?.observe(nav);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [state.activeTab, drawerOpen, collapsed, visibleTabs.length]);

  const selectOptions = state.managedClubs.map((item) => ({
    value: item.all ? 'all' : clubKey(item.club_id, item.country),
    label: item.all ? '所有同好会' : `${item.country === 'japan' ? '日本 · ' : ''}${item.name} · ${item.roleLabel}`,
  }));

  const sidebar = (
    <div className={`cm-sidebar-inner${collapsed && !isMobile ? ' is-collapsed' : ''}`}>
      <div className="cm-club-select">
        <Select
          id="clubSelector"
          aria-label="选择同好会"
          value={state.selectedKey}
          options={selectOptions}
          showSearch
          optionFilterProp="label"
          listHeight={420}
          placeholder="搜索同好会"
          popupClassName="cm-club-select-dropdown"
          onChange={actions.selectClub}
          popupMatchSelectWidth={false}
        />
      </div>
      <div className="cm-stats" aria-label="管理统计">
        <Statistic title="待审核" value={state.stats.pending} />
        <Statistic title="已通过" value={state.stats.approved} />
        <Statistic title="成员" value={state.stats.members} />
        <Statistic title="总计" value={state.stats.total} />
      </div>
      <div
        className="cm-nav-wrap"
        ref={navRef}
        data-slider-ready={slider ? 'true' : undefined}
        data-slider-driver="transform"
        style={{ '--cm-slider-y': `${slider?.top || 0}px`, '--cm-slider-height': `${slider?.height || SLIDER_HEIGHT}px` }}
      >
        <Menu
          mode="inline"
          inlineCollapsed={collapsed && !isMobile}
          selectedKeys={[state.activeTab]}
          onClick={({ key }) => { actions.switchTab(key); setDrawerOpen(false); }}
          items={visibleTabs.map((item) => ({
            key: item.key,
            icon: iconMap[item.key],
              label: item.key === 'pending' && state.stats.pending > 0
              ? <span className="cm-menu-label">{item.label}<Badge className="cm-pending-badge" count={state.stats.pending} overflowCount={99} size="small" /></span>
              : item.label,
          }))}
        />
      </div>
      {!isMobile && (
        <Button className="cm-collapse" size="small" type="text" icon={<LeftOutlined rotate={collapsed ? 180 : 0} />} onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? '展开导航' : '折叠导航'}>
          {!collapsed && '折叠'}
        </Button>
      )}
    </div>
  );

  return (
    <Layout className="cm-app">
      <header className="cm-topbar vn-topbar" data-page-header>
        <div className="cm-topbar-leading">
          {isMobile && (
            <Button className="cm-menu-toggle" type="text" icon={<MenuOutlined />} onClick={() => setDrawerOpen(true)} aria-label="打开功能导航" />
          )}
          <a className="cm-brand vn-topbar-brand" href="../index.html?guest=1">
            <span className="vn-topbar-name">VNFest</span>
            <span className="vn-topbar-divider" />
            <span className="vn-topbar-sub">同好会管理</span>
          </a>
        </div>
        <Space className="cm-topbar-actions" size={0}>
          <Tooltip title="刷新当前数据"><Button className="cm-topbar-action" type="text" icon={<ReloadOutlined />} onClick={actions.refresh} aria-label="刷新当前数据" /></Tooltip>
          <Button className="cm-topbar-action" type="text" icon={<GlobalOutlined />} href="../index.html" aria-label="返回地图">返回地图</Button>
          <Button className="cm-topbar-action" type="text" icon={<BellOutlined />} href="./reviews.html" aria-label="审核中心">审核中心</Button>
          <Tooltip title={state.isDark ? '切换到浅色' : '切换到深色'}>
            <Button className="cm-topbar-action" type="text" icon={state.isDark ? <SunOutlined /> : <MoonOutlined />} onClick={actions.toggleTheme} aria-label="切换主题" />
          </Tooltip>
        </Space>
      </header>
      <Layout className="cm-workspace">
        {isMobile ? (
          <Drawer
            className="cm-mobile-drawer"
            rootClassName="cm-mobile-drawer-root"
            placement="left"
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            width={280}
            closable={false}
            styles={{ body: { padding: 0 } }}
          >{sidebar}</Drawer>
        ) : (
          <Layout.Sider className="cm-sidebar" width={collapsed ? 64 : 244} collapsedWidth={64} collapsed={collapsed} trigger={null}>
            {sidebar}
          </Layout.Sider>
        )}
        <main className="cm-content" id="clubManagerContent">{children}</main>
      </Layout>
    </Layout>
  );
}
