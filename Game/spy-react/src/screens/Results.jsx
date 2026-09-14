/* ==========================================================================
   结算复盘 —— 胜负 / 身份揭示 / 回合摘要 / 出口
   [HERE] Game/spy-react/src/screens/Results.jsx
   数据来自快照的 result（winner/reason/rounds/awards/reveal）与 words。
   ========================================================================== */
import React, { useMemo } from 'react';
import { Button } from 'sparkdesign';

import {
  IconArrow,
  IconBlank,
  IconDagger,
  IconShield,
  Note,
  RoleTag,
  SectionHead,
} from '@/components/shared.jsx';
import { WIN_COPY, OUT_LABEL } from '@/data/constants.js';
import ResultsMobile from '@/screens/ResultsMobile.jsx';

export default function Results({ snapshot, act, onLeave, view }) {
  const room = snapshot.room;
  const result = snapshot.result || { winner: room.winner || 'civilian', reason: '本局已结束。', rounds: room.round, awards: [], reveal: [] };
  const words = snapshot.words || { civilian_word: '？', spy_word: '？' };
  const win = WIN_COPY[result.winner] || { title: '本局结束', reason: result.reason };
  const WinIcon = result.winner === 'spy' ? IconDagger : result.winner === 'blank' ? IconBlank : IconShield;
  const reveal = result.reveal || [];
  const awards = result.awards || [];

  /* 累计得票：从各回合投票裁决的 tally 里汇总 */
  const votesBySeat = useMemo(() => {
    const m = new Map();
    (snapshot.outcomes || []).forEach((o) => {
      (o.tally?.rows || []).forEach((row) => {
        m.set(row.seat, (m.get(row.seat) || 0) + row.votes);
      });
    });
    return m;
  }, [snapshot.outcomes]);

  const summary = (snapshot.outcomes || []).map((o, i) => {
    const who = o.eliminated_seat != null ? reveal.find((r) => r.seat === o.eliminated_seat) : null;
    const stageText = o.stage === 'night' ? '夜晚' : '投票';
    return {
      key: `${o.round}-${o.stage}-${i}`,
      round: o.round,
      phase: o.stage,
      text: who
        ? `第 ${o.round} 回合 ${stageText}：${who.nick}（${o.eliminated_seat} 号）出局：${OUT_LABEL[o.out_by] || ''}，身份为 ${who.role_label}。`
        : `第 ${o.round} 回合 ${stageText}：${o.host_ruling || (o.tie ? '平票' : '无人出局')}。`,
    };
  });

  const goLobby = () => {
    onLeave();
  };

  if (view === 'mobile') {
    return (
      <div className="page page--mobile" data-component="Spy/Results">
        <ResultsMobile
          win={win}
          winner={result.winner}
          Ico={WinIcon}
          reveal={reveal}
          words={words}
          votesBySeat={votesBySeat}
          summary={summary}
          onLeave={goLobby}
        />
      </div>
    );
  }

  return (
    <div className="page" data-component="Spy/Results">
      <div className="page__inner">
        <div className="verdict" data-winner={result.winner} role="status">
          <span className="verdict__icon"><WinIcon /></span>
          <div>
            <h2 className="verdict__title">{win.title}</h2>
            <p className="verdict__why">{result.reason || win.reason}</p>
          </div>
          <span className="stat-chip stat-chip--live">
            <span className="pulse-dot" />
            {result.rounds} 个回合
          </span>
        </div>

        <section className="section">
          <SectionHead
            title="身份揭示"
            count={reveal.length}
            lead={`本局词对：正常词「${words.civilian_word}」，卧底词「${words.spy_word}」`}
          />
          <div className="card" style={{ padding: 'var(--gap-2) var(--gap-4)' }}>
            <table className="role-table">
              <caption className="sr-only">全部玩家的身份、词、存活回合与得票数</caption>
              <thead>
                <tr>
                  <th scope="col">座位</th>
                  <th scope="col">昵称</th>
                  <th scope="col">身份</th>
                  <th scope="col">所持有的词</th>
                  <th scope="col">存活至</th>
                  <th scope="col">出局方式</th>
                  <th scope="col">得票</th>
                </tr>
              </thead>
              <tbody>
                {reveal.map((p) => (
                  <tr key={p.seat}>
                    <td>{p.seat}</td>
                    <td style={{ color: 'var(--text)' }}>
                      {p.nick}
                      {snapshot.me && snapshot.me.seat === p.seat && <span className="mini-tag" data-role="host" style={{ marginLeft: 6 }}>我</span>}
                    </td>
                    <td><RoleTag role={p.role} /></td>
                    <td className="role-table__word">
                      {p.role === 'civilian' ? words.civilian_word : p.role === 'spy' ? words.spy_word : '未持有词'}
                    </td>
                    <td className="num">{p.out_round == null ? '终局' : `第 ${p.out_round} 回合`}</td>
                    <td>{p.out_by ? OUT_LABEL[p.out_by] || p.out_label || '出局' : '—'}</td>
                    <td className="num">{votesBySeat.get(p.seat) || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

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

        <section className="section">
          <div className="card">
            <div className="row row--between">
              <div>
                <h3 className="card__title" style={{ marginBottom: 2 }}>下一局</h3>
                <p className="card__sub">返回大厅创建新房间，或将房间码分享给朋友再来一局。</p>
              </div>
              <div className="row row--tight">
                <Button variant="primary" rounded="pill" onClick={goLobby}>返回大厅</Button>
                <a href="../../column/?tab=activity"><Button variant="text" rounded="pill" suffixIcon={<IconArrow />}>返回活动</Button></a>
              </div>
            </div>
            {awards.length > 0 && (
              <div style={{ marginTop: 'var(--gap-3)' }} className="stack">
                {awards.map((a) => (
                  <Note key={a.key} tone="muted" icon={IconShield}>
                    <b>{a.label}</b>：{a.seat} 号 {a.nick || a.name}，{a.why}
                  </Note>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
