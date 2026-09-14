/* ==========================================================================
   谁是卧底 · 主壳
   [HERE] Game/spy-react/src/App.jsx
   屏幕不再由调试导航切换，完全跟随服务端房间状态：
   无房 → 大厅；等待中 → 准备房；对局中 → 圆桌；结束 → 结算。
   ?room=CODE 可直达房间，进房后写回地址栏，刷新不掉线。
   ========================================================================== */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, ThemeStyleProvider } from 'sparkdesign';

import { IconSpy, ListSkeleton, Note } from '@/components/shared.jsx';
import Lobby from '@/screens/Lobby.jsx';
import PreRoom from '@/screens/PreRoom.jsx';
import GameRoomDesktop from '@/screens/GameRoomDesktop.jsx';
import GameRoomMobile from '@/screens/GameRoomMobile.jsx';
import Results from '@/screens/Results.jsx';
import { ApiError, listRooms } from '@/data/api.js';
import { useMediaQuery, useTable } from '@/state/useTable.js';

/* 站点 js/theme-runtime.js 是同步脚本，早于 React 执行；主题由站点顶栏管辖。 */
const SITE_OWNS_THEME = typeof window !== 'undefined' && !!window.VNFTheme;

function roomFromUrl() {
  try {
    const code = new URLSearchParams(window.location.search).get('room');
    return code ? String(code).toUpperCase().slice(0, 16) : '';
  } catch {
    return '';
  }
}

function setRoomUrl(code) {
  try {
    const url = new URL(window.location.href);
    if (code) url.searchParams.set('room', code);
    else url.searchParams.delete('room');
    window.history.replaceState(null, '', url);
  } catch {
    /* 忽略：无地址栏的环境（iframe 沙箱） */
  }
}

export default function App() {
  const [code, setCode] = useState(roomFromUrl);
  const [resumeDone, setResumeDone] = useState(!!roomFromUrl());
  const { snapshot, error, loading, refresh } = useTable(code);
  const isMobile = useMediaQuery('(max-width: 760px)');

  useEffect(() => {
    document.documentElement.setAttribute('data-style', 'soft');
    if (!SITE_OWNS_THEME) document.documentElement.setAttribute('data-theme', 'dark');
  }, []);

  /* 无 ?room= 时自动续上自己还坐着的房间（列表里 mine=true 的那间）。 */
  useEffect(() => {
    if (resumeDone || code) return;
    let alive = true;
    listRooms()
      .then((data) => {
        if (!alive) return;
        const mine = (data.rooms || []).find((r) => r.mine && r.status !== 'ended');
        if (mine) enterRoom(mine.code);
      })
      .catch(() => {})
      .finally(() => { if (alive) setResumeDone(true); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeDone, code]);

  const enterRoom = useCallback((next) => {
    const c = String(next || '').toUpperCase();
    setCode(c);
    setRoomUrl(c);
  }, []);

  const leave = useCallback(() => {
    setCode('');
    setRoomUrl('');
  }, []);

  /* 各屏共享的动作包装：发完请求立刻拉一次增量，界面跟手；失败信息回传给界面。 */
  const [actError, setActError] = useState('');
  const act = useCallback(async (fn) => {
    setActError('');
    try {
      await fn();
      await refresh();
      return true;
    } catch (e) {
      setActError(e.message || '操作失败，请稍后重试。');
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) leave();
      return false;
    }
  }, [refresh, leave]);

  const needLogin = error instanceof ApiError && error.status === 401;

  let content;
  if (!code || (!snapshot && !loading && !needLogin && (!error || error.status === 404))) {
    content = <Lobby view={isMobile ? 'mobile' : 'desktop'} currentCode={code} onEnterRoom={enterRoom} />;
  } else if (needLogin) {
    content = (
      <div className="page">
        <div className="page__inner">
          <div className="card" style={{ textAlign: 'center', padding: 'var(--gap-6)' }}>
            <IconSpy size={34} />
            <h2 style={{ margin: 'var(--gap-3) 0 var(--gap-2)' }}>请先登录</h2>
            <Note tone="muted">谁是卧底使用站点账号，登录后返回本页即可继续。</Note>
            <div className="row" style={{ justifyContent: 'center', marginTop: 'var(--gap-3)' }}>
              <a href="../../user/login.php"><Button variant="primary" rounded="pill">前往登录</Button></a>
              <Button variant="outline" rounded="pill" onClick={leave}>返回大厅</Button>
            </div>
          </div>
        </div>
      </div>
    );
  } else if (loading || (!snapshot && !error)) {
    content = (
      <div className="page">
        <div className="page__inner">
          <ListSkeleton rows={4} />
        </div>
      </div>
    );
  } else if (error && !snapshot) {
    content = (
      <div className="page">
        <div className="page__inner">
          <div className="card">
            <Note tone="error">无法连接房间：{error.message}</Note>
            <div className="row" style={{ marginTop: 'var(--gap-3)' }}>
              <Button variant="secondary" rounded="pill" onClick={refresh}>重新加载</Button>
              <Button variant="outline" rounded="pill" onClick={leave}>返回大厅</Button>
            </div>
          </div>
        </div>
      </div>
    );
  } else {
    const room = snapshot.room;
    const common = { snapshot, act, actError, onLeave: leave, view: isMobile ? 'mobile' : 'desktop' };
    if (room.phase === 'over' || room.status === 'ended') {
      content = <Results {...common} />;
    } else if (room.status !== 'playing') {
      content = <PreRoom {...common} />;
    } else if (isMobile) {
      content = <GameRoomMobile {...common} />;
    } else {
      content = <GameRoomDesktop {...common} />;
    }
  }

  return (
    <ThemeStyleProvider appearance="dark" theme="mint" style="soft">
      <div className="proto">
        <header className="proto-bar">
          <a className="proto-back" href="../../column/?tab=activity">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
            返回活动
          </a>
          <span className="proto-bar__brand">
            <span style={{ color: 'var(--seed-primary)', display: 'inline-flex' }}><IconSpy size={18} /></span>
            <b>谁是卧底</b>
            {snapshot ? <span className="room-row__code">{snapshot.room.code}</span> : <span>VNFmap 活动</span>}
          </span>
        </header>
        <div className={`proto-stage${snapshot && snapshot.room.status === 'playing' && snapshot.room.phase !== 'over' ? ' proto-stage--fill' : ''}`}>
          {content}
        </div>
      </div>
    </ThemeStyleProvider>
  );
}
