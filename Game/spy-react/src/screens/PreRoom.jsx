/* ==========================================================================
   游戏准备房间 —— 主持人 / 玩家 / 旁观 三个视角共用一套快照
   [HERE] Game/spy-react/src/screens/PreRoom.jsx
   主持人 = room.can_control；未入座的主持人是裁判，看得见身份，但本屏
   只显示配额与词对锁定，词对内容属于对局信息，开局后由主持人端另行可见。
   ========================================================================== */
import React, { useEffect, useState } from 'react';
import { Button, Input, Label } from 'sparkdesign';

import {
  IconCheck,
  IconEye,
  IconEyeOff,
  IconLock,
  IconUsers,
  Note,
  avatarSrc,
  initials,
  seatOffsets,
  tableMetrics,
} from '@/components/shared.jsx';
import { PLAYER_RANGE, TIMER_PROFILES, distributionOf } from '@/data/constants.js';
import { assignRole, closeRoom, configRoom, joinRoom, leaveRoom, setReady, startGame } from '@/data/api.js';

function PovBar({ host, referee, right }) {
  return (
    <div className="povbar" data-pov={host ? 'host' : 'player'}>
      <span className="povbar__label">{host ? '主持人视角' : '玩家视角'}</span>
      <span className="povbar__sub">{host ? (referee ? '主持人未入座，仅负责主持' : '可见全部身份与词对') : '等待主持人开局'}</span>
      <span className="povbar__right">{right}</span>
    </div>
  );
}

function CardHead({ title, action }) {
  return (
    <div className="card__head">
      <h3 className="card__title">{title}</h3>
      {action ? <span className="card__head-action">{action}</span> : null}
    </div>
  );
}

function CapStepper({ cap, onCap, disabled }) {
  const change = (next) => {
    const v = Math.max(PLAYER_RANGE.min, Math.min(PLAYER_RANGE.max, next));
    if (v !== cap) onCap(v);
  };
  return (
    <span className="stepper" role="group" aria-label="玩家人数">
      <button type="button" className="stepper__btn" onClick={() => change(cap - 1)} disabled={disabled || cap <= PLAYER_RANGE.min} aria-label="减少人数">−</button>
      <span className="stepper__val num">{cap}</span>
      <button type="button" className="stepper__btn" onClick={() => change(cap + 1)} disabled={disabled || cap >= PLAYER_RANGE.max} aria-label="增加人数">+</button>
    </span>
  );
}

/* seats: 快照里的座位行；空位补到 cap */
function filledSeats(seats, cap, mySeat) {
  const rows = seats.map((s) => ({ ...s, filled: true, me: s.seat === mySeat }));
  for (let i = rows.length + 1; i <= cap; i += 1) {
    rows.push({ seat: i, filled: false, me: false, ready: false });
  }
  return rows;
}

function SeatRing({ seats, cap, showRole, code }) {
  const filled = seats.filter((s) => s.filled);
  const { seat, radius } = tableMetrics(seats.length);
  const tableR = Math.round(radius * 1.15);
  const offsets = seatOffsets(seats.length);

  return (
    <div className="seat-circle">
      <div className="round-table" style={{ '--table-r': `${tableR}px`, '--seat': `${seat}px` }} role="list" aria-label={`${cap} 个座位`}>
        <span className="round-table__ring" aria-hidden="true" />
        <div className="table-hub" style={{ '--hub-ink': 'var(--phase-day)' }}>
          <span className="table-hub__label">准备中</span>
          <span className="table-hub__main num">{filled.length}/{cap}</span>
          <span className="table-hub__sub">{code}</span>
        </div>
        {seats.map((s, i) => (
          <div
            key={s.seat}
            className={`seat${s.filled ? '' : ' seat--empty'}${s.me ? ' seat--me' : ''}`}
            style={{ '--dx': offsets[i].dx, '--dy': offsets[i].dy, cursor: 'default' }}
            role="listitem"
            aria-label={s.filled ? `座位 ${s.seat}，${s.nick}，${s.ready ? '已就绪' : '未就绪'}` : `座位 ${s.seat} 空位`}
          >
            <span className="seat__avatar">
              {s.filled && avatarSrc(s.avatar) && (
                <img className="seat__img" src={avatarSrc(s.avatar)} alt="" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} />
              )}
              {s.filled ? <span className="seat__initial">{initials(s.nick)}</span> : <IconUsers size={19} />}
              <span className="seat__no num">{s.seat}</span>
              {s.filled && (showRole ? s.role : s.ready) && (
                <span className="seat__flags">
                  {showRole && s.role ? <span className="mini-tag" data-role={s.role}>{s.role === 'civilian' ? '好人' : s.role === 'spy' ? '卧底' : '白板'}</span> : null}
                  {s.ready ? <span className="mini-tag" data-role="civilian">就绪</span> : null}
                </span>
              )}
            </span>
            <span className="seat__name">{s.filled ? (s.me ? `${s.nick}（我）` : s.nick) : '空位'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SeatStrip({ seats }) {
  return (
    <div className="seat-rail">
      {seats.map((x) => (
        <div className={`m-seat${x.me ? ' m-seat--me' : ''}${x.filled ? '' : ' m-seat--out'}`} key={x.seat}>
          <span className="m-seat__avatar">
            {x.filled && avatarSrc(x.avatar) && (
              <img className="m-seat__img" src={avatarSrc(x.avatar)} alt="" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} />
            )}
            <span className="m-seat__initial">{x.filled ? initials(x.nick) : '+'}</span>
          </span>
          <span className="m-seat__no num">{x.seat}</span>
          <span className="m-seat__name">{x.filled ? (x.me ? '我' : x.nick) : '空位'}</span>
          {x.filled && x.ready ? <span className="m-seat__order num">✓</span> : null}
        </div>
      ))}
    </div>
  );
}

/* 私密词卡：me.word 为空且 role 为 blank 时是白板 */
function WordCard({ me, size = 'lg' }) {
  const [revealed, setRevealed] = useState(false);
  const isBlank = !!me && me.role === 'blank';
  const word = me && me.word ? me.word : '';

  return (
    <div className="card card--identity">
      <CardHead title="我的词" action={<span className="mini-tag" data-role="host"><IconLock size={11} /> 仅自己可见</span>} />
      <div
        className={`secret-card secret-card--${size}${revealed ? ' secret-card--revealed' : ''}`}
        data-word={revealed ? (isBlank ? 'no' : 'yes') : undefined}
      >
        {revealed ? (
          <>
            <span className="secret-card__word">{isBlank ? '白板：未持有词' : word}</span>
            {isBlank && <span className="secret-card__hint">两个词均不可见。白天可主动猜词，同时猜中两个词即立即获胜。</span>}
            <Button variant="outline" size="sm" rounded="pill" prefixIcon={<IconEyeOff />} onClick={() => setRevealed(false)}>收起</Button>
          </>
        ) : (
          <>
            <span className="secret-card__hint">长按查看，松开后自动隐藏</span>
            <Button variant="primary" rounded="pill" prefixIcon={<IconEye />} onPointerDown={() => setRevealed(true)}>查看我的词</Button>
          </>
        )}
      </div>
      <dl className="def def--3">
        <div className="def__row"><dt>座位</dt><dd className="num">{me ? `${me.seat} 号` : '未入座'}</dd></div>
        <div className="def__row"><dt>状态</dt><dd>{me && me.ready ? '已就绪' : '未就绪'}</dd></div>
        <div className="def__row"><dt>词</dt><dd style={{ color: revealed ? 'var(--status-alive)' : 'var(--status-lag)' }}>{revealed ? '已查看' : '未查看'}</dd></div>
      </dl>
    </div>
  );
}

function WordLockCard({ room }) {
  const custom = !!(room && room.word_a && room.word_b);
  return (
    <div className="card card--hidden-slot">
      <CardHead title="本局词对" action={<span className="mini-tag" data-tone={custom ? 'ok' : 'out'}><IconLock size={11} /> {custom ? '主持人已设置' : '开局时下发'}</span>} />
      <div className="hidden-pair">
        <div className="hidden-pair__cell">
          <span className="t-12 soft">正常词</span>
          <span className="hidden-pair__value">· · · · · ·</span>
        </div>
        <span className="wordpair__vs" aria-hidden="true">VS</span>
        <div className="hidden-pair__cell">
          <span className="t-12 soft">卧底词</span>
          <span className="hidden-pair__value">· · · · · ·</span>
        </div>
      </div>
      <p className="t-12 soft" style={{ margin: 0 }}>持有正常词者为好人，持有卧底词者为卧底，两者均未持有者为白板。开局前无法预知获得哪一类词。</p>
    </div>
  );
}

/* 主持人自定义词对：两词成对填写即开局生效，任一为空则回退词库 */
function WordConfigCard({ room, act }) {
  const [wordA, setWordA] = useState(room.word_a || '');
  const [wordB, setWordB] = useState(room.word_b || '');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    setWordA(room.word_a || '');
    setWordB(room.word_b || '');
  }, [room.word_a, room.word_b]);

  const custom = !!(room.word_a && room.word_b);
  const save = async () => {
    setMsg('');
    const a = wordA.trim();
    const b = wordB.trim();
    if ((a && !b) || (!a && b)) { setMsg('两个词需同时填写，或同时留空。'); return; }
    if (a.length > 24 || b.length > 24) { setMsg('每个词不得超过 24 字。'); return; }
    if (a && a === b) { setMsg('两个词不能相同。'); return; }
    const ok = await act(() => configRoom(room.code, { word_a: a, word_b: b }));
    if (ok) setMsg(a ? '词对已保存，开局将使用该词对。' : '已清除，开局时改为由词库下发。');
  };
  const clear = async () => {
    setMsg('');
    const ok = await act(() => configRoom(room.code, { word_a: '', word_b: '' }));
    if (ok) { setWordA(''); setWordB(''); setMsg('已清除，开局时改为由词库下发。'); }
  };

  return (
    <div className="card card--hidden-slot">
      <CardHead
        title="自定义词对"
        action={<span className="mini-tag" data-tone={custom ? 'ok' : 'out'}>{custom ? '已设置' : '未设置，使用词库'}</span>}
      />
      <div className="pair-edit">
        <div className="pair-edit__row">
          <Label htmlFor="cfg-word-a">好人词</Label>
          <Input id="cfg-word-a" value={wordA} onChange={(e) => setWordA(e.target.value)} maxLength={24} placeholder="留空时由词库下发" aria-label="好人词" />
        </div>
        <div className="pair-edit__row">
          <Label htmlFor="cfg-word-b">卧底词</Label>
          <Input id="cfg-word-b" value={wordB} onChange={(e) => setWordB(e.target.value)} maxLength={24} placeholder="与好人词接近时效果更佳" aria-label="卧底词" />
        </div>
      </div>
      <div className="row" style={{ marginTop: 'var(--gap-2)' }}>
        <Button variant="primary" size="sm" rounded="pill" onClick={save}>保存词对</Button>
        {custom && <Button variant="outline" size="sm" rounded="pill" onClick={clear}>清除</Button>}
      </div>
      {msg && <p className="t-12 soft" style={{ margin: 'var(--gap-2) 0 0' }}>{msg}</p>}
      <p className="t-12 soft" style={{ margin: 'var(--gap-2) 0 0' }}>两个词均已填写时，开局使用该词对；任一为空时由词库下发。词对内容在开局前对玩家不可见。</p>
    </div>
  );
}

/* 主持人逐座点名身份：留空为随机，点名后开局按点名落位 */
function PresetRows({ room, seats, me, act }) {
  return (
    <div className="assign-list" style={{ maxHeight: 'none' }}>
      {seats.map((s) => (
        <div className="assign-row assign-row--preset" key={s.seat}>
          <span className="assign-row__no num">{s.seat}</span>
          <span className="assign-row__name">{me && s.seat === me.seat ? `${s.nick}（我）` : s.nick}</span>
          {s.ready ? <span className="mini-tag assign-row__ok">就绪</span> : <span className="mini-tag" data-tone="lag">未就绪</span>}
          <select
            className="preset-select"
            value={s.preset || ''}
            onChange={(e) => act(() => assignRole(room.code, s.seat, e.target.value))}
            aria-label={`座位 ${s.seat} 身份预设`}
          >
            <option value="">随机</option>
            <option value="civilian">好人</option>
            <option value="spy">卧底</option>
            <option value="blank">白板</option>
          </select>
        </div>
      ))}
    </div>
  );
}

function RoleQuota({ cap, distribution }) {
  const d = distribution || distributionOf(null, cap);
  return (
    <div className="role-grid">
      <div className="role-cell" data-role="civilian"><span className="role-cell__n num">{d.civilian}</span><span className="role-cell__l">好人</span></div>
      <div className="role-cell" data-role="spy"><span className="role-cell__n num">{d.spy}</span><span className="role-cell__l">卧底</span></div>
      <div className="role-cell" data-role="blank"><span className="role-cell__n num">{d.blank}</span><span className="role-cell__l">白板</span></div>
    </div>
  );
}

export default function PreRoom({ snapshot, act, onLeave, view }) {
  const room = snapshot.room;
  const me = snapshot.me;
  const seats = snapshot.seats || [];
  const isHost = !!room.can_control;
  const referee = isHost && room.host_seat === null;
  const joined = seats.length;
  const readyCount = seats.filter((s) => s.ready).length;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const changeCap = (next) => act(() => configRoom(room.code, { cap: next }));
  const start = async () => {
    setBusy(true);
    setErr('');
    const ok = await act(() => startGame(room.code));
    if (!ok) setErr('无法开局：至少需要 4 人入座，且本局尚未开始。');
    setBusy(false);
  };
  const toggleReady = () => act(() => setReady(room.code, !(me && me.ready)));
  const takeSeat = () => act(() => joinRoom(room.code));
  const backToReferee = () => act(() => leaveRoom(room.code));
  const quit = async () => {
    await act(() => leaveRoom(room.code));
    onLeave();
  };
  const dissolve = async () => {
    await act(() => closeRoom(room.code));
    onLeave();
  };

  const blockers = [];
  if (joined < PLAYER_RANGE.min) blockers.push(`还需 ${PLAYER_RANGE.min - joined} 人，开局至少需要 ${PLAYER_RANGE.min} 人`);
  if (joined > room.cap) blockers.push('入座人数已超过上限，请调高人数上限');

  const seatsFilled = filledSeats(seats, room.cap, me ? me.seat : null);
  const quota = <RoleQuota cap={room.cap} distribution={room.distribution} />;

  if (view === 'mobile') {
    return (
      <div className="app-shell--mobile" data-component="Spy/PreRoomMobile">
        <header className="m-topbar">
          <span className="m-topbar__title">{room.name}</span>
          <span className="m-topbar__code">{room.code}</span>
        </header>
        <div className="m-phasebar" data-phase="day">
          <PovBar host={isHost} referee={referee} />
          <span className="m-phasebar__count num">{joined}/{room.cap}</span>
        </div>
        <div className="m-scroll">
          {me ? <WordCard me={me} size="md" /> : (
            <div className="m-card">
              <div className="m-card__head"><span>旁观视角</span></div>
              <p className="t-12 soft" style={{ margin: 0 }}>当前未入座，开局后可观战。</p>
            </div>
          )}
          <div className="m-card">
            <div className="m-card__head">
              <span>座位</span>
              {isHost && <CapStepper cap={room.cap} onCap={changeCap} disabled={joined > room.cap} />}
            </div>
            <SeatStrip seats={seatsFilled} />
          </div>
          <div className="m-card">
            <div className="m-card__head"><span>身份配额 · 随实际人数自适应</span></div>
            {quota}
          </div>
          {isHost && (
            <div className="m-card">
              <div className="m-card__head"><span>身份点名 · 开局时生效</span></div>
              <PresetRows room={room} seats={seats} me={me} act={act} />
              <p className="t-12 soft" style={{ margin: 'var(--gap-2) 0 0' }}>留空表示随机分配；点名身份与配额冲突时，将自动提高该身份人数。</p>
            </div>
          )}
          {isHost ? <WordConfigCard room={room} act={act} /> : <WordLockCard room={room} />}
        </div>
        <footer className="m-actionbar">
          {isHost ? (
            <>
              <div className="m-actionbar__hint">
                <span>{blockers.length ? blockers[0] : '条件齐备'}</span>
                <span className="num">{readyCount}/{joined} 就绪</span>
              </div>
              <Button variant="primary" rounded="pill" size="lg" style={{ width: '100%' }} disabled={blockers.length > 0 || busy} onClick={start}>
                {busy ? '开局中…' : '开始游戏'}
              </Button>
              <div className="row row--tight" style={{ marginTop: 'var(--gap-2)' }}>
                {referee ? (
                  <Button variant="outline" size="sm" rounded="pill" onClick={takeSeat}>入座参战</Button>
                ) : (
                  <>
                    <Button variant="outline" size="sm" rounded="pill" onClick={toggleReady}>{me && me.ready ? '取消就绪' : '我已就绪'}</Button>
                    <Button variant="outline" size="sm" rounded="pill" onClick={backToReferee}>离座回裁判</Button>
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="m-actionbar__hint">
                <span>{me ? '等待就绪' : '等待开局'}</span>
                <span className="num">{readyCount}/{joined} 就绪</span>
              </div>
              {me ? (
                <Button variant={me.ready ? 'outline' : 'primary'} rounded="pill" size="lg" style={{ width: '100%' }} onClick={toggleReady}>
                  {me.ready ? '取消就绪' : '我已就绪'}
                </Button>
              ) : (
                <Button variant="outline" rounded="pill" size="lg" style={{ width: '100%' }} onClick={quit}>离开房间</Button>
              )}
            </>
          )}
        </footer>
      </div>
    );
  }

  return (
    <div className="page" data-component="Spy/PreRoom">
      <div className="page__inner">
        <PovBar
          host={isHost}
          referee={referee}
          right={
            <span className="row row--tight">
              <span className="stat-chip">{TIMER_PROFILES[room.timer_profile]?.label || '标准节奏'}</span>
              <span className="stat-chip num">{joined}/{room.cap} 人</span>
              {isHost && <CapStepper cap={room.cap} onCap={changeCap} disabled={joined > room.cap} />}
            </span>
          }
        />

        {err && <Note tone="error">{err}</Note>}

        <div className="prep-grid">
          <div className="card">
            <CardHead title="座位" action={<span className="room-row__code">{room.code}</span>} />
            <SeatRing seats={seatsFilled} cap={room.cap} showRole={referee} code={room.code} />
          </div>
          <div className="card">
            <CardHead title="身份配额" action={<span className="t-12 soft num">{joined} 人已入座</span>} />
            {quota}
            <Note tone="muted">配额随实际入座人数自动调整，开局时按此分配身份。</Note>
            {isHost ? (
              <div className="row" style={{ marginTop: 'var(--gap-3)' }}>
                <Button variant="primary" rounded="pill" size="lg" disabled={blockers.length > 0 || busy} onClick={start}>
                  {busy ? '开局中…' : '开始游戏'}
                </Button>
                <Button variant="outline" rounded="pill" size="lg" onClick={dissolve}>解散房间</Button>
                {referee ? (
                  <Button variant="text" rounded="pill" onClick={takeSeat}>入座参战</Button>
                ) : (
                  <>
                    <Button variant="text" rounded="pill" onClick={toggleReady}>{me && me.ready ? '取消就绪' : '我已就绪'}</Button>
                    <Button variant="text" rounded="pill" onClick={backToReferee}>离座回裁判</Button>
                  </>
                )}
              </div>
            ) : me ? (
              <div className="row row--between" style={{ marginTop: 'var(--gap-3)' }}>
                <Button variant={me.ready ? 'outline' : 'primary'} rounded="pill" size="lg" onClick={toggleReady}>
                  {me.ready ? '取消就绪' : '我已就绪'}
                </Button>
                <Button variant="text" rounded="pill" onClick={quit}>离开房间</Button>
              </div>
            ) : (
              <div className="row" style={{ marginTop: 'var(--gap-3)' }}>
                <Button variant="outline" rounded="pill" size="lg" onClick={quit}>离开房间</Button>
              </div>
            )}
            {isHost && blockers.length > 0 && (
              <div className="chip-wrap" style={{ marginTop: 'var(--gap-2)' }}>
                {blockers.map((t) => <span className="mini-tag" data-tone="lag" key={t}>{t}</span>)}
              </div>
            )}
            {isHost && blockers.length === 0 && (
              <div style={{ marginTop: 'var(--gap-2)' }}>
                <Note tone="ok" icon={IconCheck}>条件已满足，可以开始游戏。</Note>
              </div>
            )}
          </div>
        </div>

        <div className="prep-grid">
          {isHost ? <WordConfigCard room={room} act={act} /> : <WordLockCard room={room} />}
          <div className="card">
            <CardHead title={isHost ? '身份点名' : '其他玩家'} action={<span className="t-12 soft num">{readyCount}/{joined} 就绪</span>} />
            {isHost ? (
              <>
                <PresetRows room={room} seats={seats} me={me} act={act} />
                <p className="t-12 soft" style={{ margin: 'var(--gap-2) 0 0' }}>留空为随机；点名的身份开局时生效，配额不足时自动抬高。</p>
              </>
            ) : (
              <div className="assign-list" style={{ maxHeight: 'none' }}>
                {seats.map((s) => (
                  <div className="assign-row" key={s.seat}>
                    <span className="assign-row__no num">{s.seat}</span>
                    <span className="assign-row__name">{me && s.seat === me.seat ? `${s.nick}（我）` : s.nick}</span>
                    <span className={`mini-tag ${s.ready ? 'assign-row__ok' : ''}`} data-tone={s.ready ? undefined : 'lag'}>
                      {s.ready ? '就绪' : '未就绪'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
