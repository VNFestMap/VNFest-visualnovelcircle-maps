/* ==========================================================================
   结算复盘 · 移动端 —— 单列，身份一玩家一卡
   [HERE] Game/spy-react/src/screens/ResultsMobile.jsx
   ========================================================================== */
import React from 'react';

import { Button, IconArrow, RoleTag, SectionHead } from '@/components/shared.jsx';

export default function ResultsMobile({ win, winner, Ico, reveal, words, votesBySeat, summary, onLeave }) {
  return (
    <div className="recap-m" data-component="Spy/ResultsMobile">
      {/* ---- 胜负 ---- */}
      <section className="recap-m__verdict" data-winner={winner} role="status">
        <div className="recap-m__verdict-top">
          <span className="verdict__icon">
            <Ico />
          </span>
          <div className="recap-m__verdict-text">
            <h2 className="verdict__title">{win.title}</h2>
            <span className="stat-chip stat-chip--live">
              <span className="pulse-dot" />
              {summary.length} 项裁决
            </span>
          </div>
        </div>
        <p className="verdict__why">{win.reason}</p>
      </section>

      {/* ---- 身份揭示 ---- */}
      <section className="section">
        <SectionHead title="身份揭示" count={reveal.length} />
        <p className="t-12 soft recap-m__pair">
          正常词<b>{words.civilian_word}</b> · 卧底词<b>{words.spy_word}</b>
        </p>
        <div className="recap-m__list">
          {reveal.map((p) => {
            const votes = votesBySeat.get(p.seat) || 0;
            return (
              <div className="recap-m__row" key={p.seat} data-alive={p.out_round == null}>
                <span className="recap-m__seat num">{p.seat}</span>
                <div className="recap-m__main">
                  <div className="recap-m__line1">
                    <span className="recap-m__name">
                      {p.nick}
                    </span>
                    <RoleTag role={p.role} />
                  </div>
                  <div className="recap-m__line2">
                    <span className="role-table__word">
                      {p.role === 'civilian' ? words.civilian_word : p.role === 'spy' ? words.spy_word : '未持有词'}
                    </span>
                    <span className="recap-m__dot" aria-hidden="true">·</span>
                    <span>
                      {p.out_round == null ? '存活到终局' : `第 ${p.out_round} 回合 · ${p.out_by ? p.out_label || '出局' : '出局'}`}
                    </span>
                  </div>
                </div>
                <span className="recap-m__votes num" title="累计得票">
                  {votes || '—'}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* ---- 回合摘要 ---- */}
      {summary.length > 0 && (
        <section className="section">
          <SectionHead title="回合摘要" count={summary.length} />
          <div className="timeline">
            {summary.map((n) => (
              <div className="timeline__node" key={n.key} data-phase={n.phase} style={{ cursor: 'default' }}>
                <span className="timeline__round">第 {n.round} 回合</span>
                <p className="timeline__text">{n.text}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---- 出口 ---- */}
      <section className="section">
        <div className="recap-m__actions">
          <button type="button" className="recap-m__btn recap-m__btn--primary" onClick={onLeave}>返回大厅</button>
          <a href="../../club_square.html" style={{ display: 'contents' }}>
            <button type="button" className="recap-m__btn">
              返回活动 <IconArrow size={12} />
            </button>
          </a>
          <Button variant="text" rounded="pill" onClick={onLeave}>返回房间列表</Button>
        </div>
      </section>
    </div>
  );
}
