/* ==========================================================================
   主持人控制台 —— 可缩略浮窗
   [HERE] Game/spy-react/src/components/HostConsole.jsx
   只有 room.can_control 的用户看得到。阶段推进、平票裁决都打服务端，
   界面不维护任何本地游戏状态。
   ========================================================================== */
import React, { useState } from 'react';
import { Button } from 'sparkdesign';

import {
  IconAlert,
  IconArrow,
  IconCheck,
  IconGavel,
  IconInfo,
  IconX,
  Note,
  PhaseFishbone,
} from '@/components/shared.jsx';
import { PHASE_META, distributionOf } from '@/data/constants.js';
import { advancePhase, resolveTie } from '@/data/api.js';

export default function HostConsole({ snapshot, act, onClose }) {
  const [collapsed, setCollapsed] = useState(false);
  const [err, setErr] = useState('');
  const room = snapshot.room;
  const me = snapshot.me;
  const phase = room.phase;
  const showRoles = room.host_seat === null; // 裁判才看得到身份；入座房主也在局里
  const seats = snapshot.seats || [];
  const targets = room.targets || [];
  const alive = seats.filter((s) => targets.includes(s.seat));
  const words = snapshot.words;
  const d = distributionOf(room, room.cap);
  const night = snapshot.night || { required: 0, submitted: 0 };

  const advance = () => act(() => advancePhase(room.code));
  const rule = (ruling, seat) => act(() => resolveTie(room.code, ruling, seat));

  if (collapsed) {
    return (
      <div className="host-float host-float--collapsed">
        <button type="button" className="host-pill" onClick={() => setCollapsed(false)} aria-label="展开主持人控制台">
          <span className="host-pill__ico"><IconGavel size={14} /></span>
          <span className="host-pill__phase">{PHASE_META[phase]?.label || phase} · 第 {room.round} 回合</span>
          {phase === 'night' && <span className="host-pill__meta num">{night.submitted}/{night.required}</span>}
          {room.tie_open && <span className="host-pill__flag">平</span>}
          <span className="host-pill__expand"><IconArrow dir="up" size={13} /></span>
        </button>
      </div>
    );
  }

  const tieSeat = (room.tie_open && targets[0]) || null;

  return (
    <aside className="host-float" role="dialog" aria-label="主持人控制台" data-component="Spy/HostConsole">
      <header className="host-float__head">
        <span className="host-float__ico"><IconGavel size={15} /></span>
        <h2 className="host-float__title">主持人</h2>
        <span className="mini-tag" data-role="host">仅主持人可见</span>
        <div className="host-float__tools">
          <Button variant="ghost" size="sm" rounded="pill" onClick={() => setCollapsed(true)} aria-label="收起控制台">
            <IconArrow dir="down" size={14} />
          </Button>
          <Button variant="ghost" size="sm" rounded="pill" onClick={onClose} aria-label="关闭控制台">
            <IconX size={14} />
          </Button>
        </div>
      </header>

      <div className="host-float__body">
        {err && <Note tone="error">{err}</Note>}

        <section className="host-group">
          <div className="host-group__row">
            <PhaseFishbone phase={phase} onPhase={() => advance()} />
          </div>
          {phase === 'day' && (
            <p className="t-12 soft" style={{ margin: '4px 0 0' }}>
              发言进度与描述时限到达后由系统自动推进；「进入下一阶段」可提前推进。
            </p>
          )}
          <div className="row row--tight" style={{ marginTop: 'var(--gap-2)' }}>
            <Button variant="primary" size="sm" rounded="pill" prefixIcon={<IconCheck />} onClick={advance}>
              进入下一阶段
            </Button>
          </div>

          {phase === 'vote' && room.tie_open && (
            <div className="row row--tight" style={{ marginTop: 'var(--gap-2)' }}>
              <Button variant="outline" size="sm" rounded="pill" onClick={() => rule('revote')} disabled={room.revote_used}>
                {room.revote_used ? '本轮已重新投票' : '重新投票'}
              </Button>
              <Button variant="outline" size="sm" rounded="pill" onClick={() => rule('pass')}>无人出局</Button>
              <Button
                variant="primary"
                size="sm"
                rounded="pill"
                onClick={() => {
                  const seat = Number(window.prompt('平票裁决：请输入要淘汰的座位号，取消则不淘汰任何玩家。', tieSeat || ''));
                  if (seat) rule('eliminate', seat);
                }}
              >
                指定淘汰
              </Button>
            </div>
          )}

          {phase === 'night' && (
            <p className="t-12 soft" style={{ margin: '4px 0 0' }}>
              夜晚指令 {night.submitted}/{night.required}：全部卧底提交后自动结算，无需额外操作。
            </p>
          )}
        </section>

        <section className="host-group">
          <h3 className="host-group__title">词对与配额</h3>
          {words ? (
            <div className="stack">
              <p className="t-13" style={{ margin: 0 }}>
                正常词「<b>{words.civilian_word}</b>」 · 卧底词「<b>{words.spy_word}</b>」
              </p>
            </div>
          ) : (
            <Note tone="muted">词对在开局后显示。</Note>
          )}
          <div className="role-grid" style={{ marginTop: 'var(--gap-2)' }}>
            <div className="role-cell" data-role="civilian"><span className="role-cell__n num">{d.civilian}</span><span className="role-cell__l">好人</span></div>
            <div className="role-cell" data-role="spy"><span className="role-cell__n num">{d.spy}</span><span className="role-cell__l">卧底</span></div>
            <div className="role-cell" data-role="blank"><span className="role-cell__n num">{d.blank}</span><span className="role-cell__l">白板</span></div>
          </div>
        </section>

        <section className="host-group" style={{ marginBottom: 0 }}>
          <h3 className="host-group__title">座位（{room.cap} 人局）</h3>
          <div className="assign-list assign-list--compact">
            {seats.map((s) => (
              <div className="assign-row assign-row--4" key={s.seat}>
                <span className="assign-row__no num">{s.seat}</span>
                <span className="assign-row__name" style={targets.includes(s.seat) ? undefined : { color: 'var(--text-soft)' }}>
                  {s.nick}
                </span>
                {showRoles && s.role ? <span className="mini-tag" data-role={s.role}>{s.role === 'civilian' ? '好人' : s.role === 'spy' ? '卧底' : '白板'}</span> : <span className="t-12 soft">未揭示</span>}
                <span className="assign-row__word">
                  {!targets.includes(s.seat) ? '出局' : s.has_voted ? '已投票' : s.ready ? '就绪' : ''}
                </span>
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 'var(--gap-3)' }}>
            <Button
              variant="text"
              size="sm"
              rounded="pill"
              onClick={() => {
                if (window.confirm('确认提前结束本局并进入结算？好人将按剩余身份判定为负。')) {
                  act(() => advancePhase(room.code));
                }
              }}
            >
              结束并结算
            </Button>
          </div>
        </section>
      </div>
    </aside>
  );
}
