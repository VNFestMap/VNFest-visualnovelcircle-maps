/* ==========================================================================
   匹配大厅 —— 入口卡 / 房间列表 / 创建房间 / 房间码加入
   [HERE] Game/spy-react/src/screens/Lobby.jsx
   数据来自 api/spy_rooms.php?action=list，5 秒轮询。
   ========================================================================== */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Switch,
} from 'sparkdesign';

import {
  DistributionPreview,
  IconCheck,
  IconEye,
  IconSpy,
  ListSkeleton,
  Note,
  SectionHead,
} from '@/components/shared.jsx';
import { PLAYER_RANGE, TIMER_PROFILES } from '@/data/constants.js';
import { ApiError, createRoom, joinRoom, listRooms } from '@/data/api.js';

function phaseLabel(r) {
  if (r.status === 'waiting') return r.need_code ? '需要房间码' : '等待玩家入座';
  if (r.status === 'playing') return r.phase === 'night' ? `夜晚 · 第 ${r.round} 回合` : '对局进行中';
  if (r.status === 'ended') return '已结束';
  return r.phase;
}

function RoomRow({ room, onJoin }) {
  const disabled = !room.is_host && !room.joinable && !room.spectate;
  return (
    <button
      type="button"
      className="room-row"
      onClick={() => onJoin(room)}
      disabled={disabled}
      aria-label={`${room.name}，${room.seated}/${room.cap} 人，${phaseLabel(room)}`}
    >
      <span className="cap-bar" aria-hidden="true">
        {Array.from({ length: room.cap }).map((_, i) => (
          <span key={i} className="cap-bar__pip" data-on={i < room.seated} data-host={false} />
        ))}
      </span>

      <span className="room-row__name">
        <span className="room-row__title">
          {room.name}
          {room.is_host
            ? <span className="mini-tag" data-role="host">我主持</span>
            : room.mine ? <span className="mini-tag" data-role="host">我的房</span> : null}
        </span>
        <span className="room-row__meta">房主担任主持人 · {TIMER_PROFILES[room.timer]?.label || '标准节奏'}</span>
      </span>

      <span className="room-row__cap">
        <span className={`cap-num${room.seated >= room.cap ? ' is-full' : ''}`}>{room.seated}/{room.cap}</span>
      </span>

      <span className="room-row__code">{room.need_code ? '私密房间' : room.code}</span>

      <span className="room-row__badge">
        {room.status === 'waiting' && (
          <span className="stat-chip"><span className="pulse-dot" />{phaseLabel(room)}</span>
        )}
        {room.status === 'playing' && (
          <span className="stat-chip stat-chip--live">{phaseLabel(room)}</span>
        )}
        {room.status === 'ended' && <span className="stat-chip">已结束</span>}
      </span>
    </button>
  );
}

function CreateRoomDialog({ open, onOpenChange, onCreated }) {
  const [cap, setCap] = useState(8);
  const [spectate, setSpectate] = useState(true);
  const [needCode, setNeedCode] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      const data = await createRoom({
        name: name.trim() || '未命名房间',
        cap,
        spectate: spectate ? 1 : 0,
        need_code: needCode ? 1 : 0,
      });
      onOpenChange(false);
      onCreated(data.code);
    } catch (e) {
      setErr(e.message || '房间创建失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="default" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>创建房间</DialogTitle>
          <DialogDescription>创建后你将成为该房间的主持人，负责设置词对、推进阶段与裁决平票。</DialogDescription>
        </DialogHeader>

        <div className="stack" style={{ marginTop: 'var(--gap-3)' }}>
          <div>
            <Label htmlFor="room-name">房间名称</Label>
            <Input id="room-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：周五游戏夜" maxLength={40} />
          </div>

          <div>
            <Label htmlFor="cap-input">玩家人数</Label>
            <div className="row row--between" style={{ gap: 'var(--gap-3)' }}>
              <span className="stepper" role="group" aria-label="玩家人数">
                <button type="button" className="stepper__btn" onClick={() => setCap((v) => Math.max(PLAYER_RANGE.min, v - 1))} disabled={cap <= PLAYER_RANGE.min} aria-label="减少人数">−</button>
                <span className="stepper__val num" id="cap-input">{cap}</span>
                <button type="button" className="stepper__btn" onClick={() => setCap((v) => Math.min(PLAYER_RANGE.max, v + 1))} disabled={cap >= PLAYER_RANGE.max} aria-label="增加人数">+</button>
              </span>
              <span className="t-12 soft">4–12 人，不含主持人</span>
            </div>
          </div>

          <DistributionPreview cap={cap} />

          <div className="row row--between" style={{ padding: 'var(--gap-2) 0' }}>
            <Label htmlFor="spectate">允许观战（延迟 60 秒）</Label>
            <Switch id="spectate" checked={spectate} onCheckedChange={setSpectate} />
          </div>
          <div className="row row--between" style={{ padding: 'var(--gap-2) 0' }}>
            <Label htmlFor="need-code">私密房间（仅持房间码者可入座）</Label>
            <Switch id="need-code" checked={needCode} onCheckedChange={setNeedCode} />
          </div>

          {err && <Note tone="error">{err}</Note>}
        </div>

        <DialogFooter>
          <DialogClose asChild><Button variant="outline" rounded="pill">取消</Button></DialogClose>
          <Button variant="primary" rounded="pill" prefixIcon={<IconCheck />} disabled={busy} onClick={submit}>
            {busy ? '创建中…' : '创建并生成房间码'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Lobby({ onEnterRoom, currentCode }) {
  const [rooms, setRooms] = useState(null);
  const [err, setErr] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [code, setCode] = useState('');
  const [joinErr, setJoinErr] = useState('');
  const [joining, setJoining] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let timer = null;
    const load = async () => {
      try {
        const data = await listRooms();
        if (!mounted.current) return;
        setRooms(data.rooms || []);
        setErr(null);
      } catch (e) {
        if (mounted.current) setErr(e);
      } finally {
        if (mounted.current) timer = setTimeout(load, 5000);
      }
    };
    load();
    return () => {
      mounted.current = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const doJoin = useCallback(async (room) => {
    /* 房主点自己的房是回房主持，不是入座；入座由准备房的显式按钮负责。 */
    if (room.is_host && !room.mine) {
      setJoinErr('');
      onEnterRoom(room.code);
      return;
    }
    setJoinErr('');
    setJoining(true);
    try {
      await joinRoom(room.code);
      onEnterRoom(room.code);
    } catch (e) {
      if (e instanceof ApiError && room.need_code && (e.status === 400 || e.status === 403)) {
        setCode(room.code);
        setJoinErr('该房间为私密房间，请输入房间码。');
      } else {
        setJoinErr(e.message || '加入房间失败，请稍后重试。');
      }
    } finally {
      setJoining(false);
    }
  }, [onEnterRoom]);

  const doJoinByCode = useCallback(async () => {
    const c = code.trim().toUpperCase();
    if (!c) return;
    setJoinErr('');
    setJoining(true);
    try {
      await joinRoom(c);
      onEnterRoom(c);
    } catch (e) {
      setJoinErr(e.message || '加入房间失败，请稍后重试。');
    } finally {
      setJoining(false);
    }
  }, [code, onEnterRoom]);

  const live = (rooms || []).filter((r) => r.status === 'playing');
  const waiting = (rooms || []).filter((r) => r.status === 'waiting');

  return (
    <div className={currentCode ? 'page page--mobile' : 'page'} data-component="Spy/Lobby">
      <div className="page__inner">
        <section className="section">
          <SectionHead
            title="房间"
            count={rooms ? rooms.length : undefined}
            lead="进行中的房间仅支持观战。点击房间即入座；自己创建的房间将进入主持视角。"
            action={
              <Button variant="primary" size="sm" rounded="pill" prefixIcon={<IconSpy size={15} />} onClick={() => setCreateOpen(true)}>
                创建房间
              </Button>
            }
          />

          {rooms === null && !err && <ListSkeleton rows={3} />}
          {err && rooms === null && (
            <div className="card">
              <Note tone="error">房间列表拉取失败：{err.message}</Note>
            </div>
          )}
          {rooms !== null && rooms.length === 0 && (
            <div className="card" style={{ textAlign: 'center', padding: 'var(--gap-5)' }}>
              <p style={{ margin: 0 }}>当前没有公开房间。创建房间后，将房间码分享给朋友即可加入。</p>
            </div>
          )}
          {rooms !== null && rooms.length > 0 && (
            <div className="room-list">
              {[...waiting, ...live].map((room) => (
                <RoomRow key={room.id} room={room} onJoin={doJoin} />
              ))}
            </div>
          )}
          {joinErr && <div style={{ marginTop: 'var(--gap-2)' }}><Note tone="error">{joinErr}</Note></div>}
        </section>

        <section className="section">
          <SectionHead title="用房间码加入" />
          <div className="card">
            <div className="row">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="房间码"
                maxLength={16}
                aria-label="房间码"
                style={{ flex: '1 1 auto', minWidth: 160, letterSpacing: '0.12em' }}
              />
              <span className="stat-chip"><IconEye size={13} /> 私密房间需输入房间码</span>
              <Button variant="primary" rounded="pill" disabled={code.trim().length < 4 || joining} onClick={doJoinByCode}>
                {joining ? '正在加入…' : '加入'}
              </Button>
            </div>
          </div>
        </section>
      </div>

      <CreateRoomDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={onEnterRoom} />
    </div>
  );
}
