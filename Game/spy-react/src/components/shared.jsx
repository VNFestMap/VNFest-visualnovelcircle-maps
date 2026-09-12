/* ==========================================================================
   共享组件与图标
   [HERE] Game/spy-react/src/components/shared.jsx
   ========================================================================== */
import React from 'react';
import { Button, Tooltip, Tag, Skeleton } from 'sparkdesign';
import { ROLE_LABEL, distributionOf } from '@/data/constants.js';

/* --------------------------------------------------------------------------
   圆桌几何：1 号固定在 6 点方向（我的视角），其余按顺时针排布
   -------------------------------------------------------------------------- */
/* 数字 → px；字符串（min()/clamp()/calc() 等）原样透传，便于响应式圆桌 */
export function len(v) {
  return typeof v === 'number' ? `${v}px` : v;
}

export function seatOffsets(count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const theta = Math.PI + (i * 2 * Math.PI) / count;
    out.push({ dx: Math.sin(theta), dy: -Math.cos(theta) });
  }
  return out;
}

/* 圆桌椅间距：按弦长反解半径
   相邻座位中心距 = 2·R·sin(π/n)，要求 ≥ 座位直径 + 目标间距，
   故 R = (seat + gap) / (2·sin(π/n))。放大 R 只会更松散，不会重叠。 */
export function tableMetrics(count) {
  const n = Math.max(4, Math.min(12, count || 8));
  const seat = n <= 6 ? 84 : n <= 8 ? 76 : n <= 10 ? 68 : 62;
  const gap = n <= 8 ? 44 : 34;
  const chordMin = seat + gap;
  const radius = Math.max(156, Math.round(chordMin / (2 * Math.sin(Math.PI / n))));
  return { seat, gap, radius };
}

export function initials(name) {
  const trimmed = String(name || '').trim();
  const cjk = trimmed.match(/[一-鿿ァ-ヶー]/);
  if (cjk) return trimmed.slice(cjk.index, cjk.index + 1);
  return trimmed.slice(0, 1).toUpperCase() || '?';
}

/* 座位头像地址。站点库里存的是站点根相对路径，本应用挂在 /Game/spy/ 两层深处，
   http(s)/data: 与根相对（/开头）原样可用，其余补 ../../ 回到站点根。 */
export function avatarSrc(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (/^(https?:|data:|blob:)/i.test(v) || v.startsWith('/')) return v;
  return `../../${v}`;
}

/* --------------------------------------------------------------------------
   图标 —— 全部沿用站点线性风格：stroke currentColor、无填充
   -------------------------------------------------------------------------- */
const S = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' };

export const IconSpy = ({ size = 24 }) => (
  <svg viewBox="0 0 48 48" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <path d="M8 22a8 8 0 0 1 8-8h4" />
    <path d="M40 22a8 8 0 0 0-8-8h-4" />
    <rect x="7" y="21" width="15" height="12" rx="3" />
    <rect x="26" y="25" width="15" height="12" rx="3" />
    <circle cx="12.5" cy="27" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="19" cy="27" r="1.4" fill="currentColor" stroke="none" />
    <path d="M31.5 31h6" opacity="0.5" />
    <path d="M24 6l1.8 4.2L30 12l-4.2 1.8L24 18l-1.8-4.2L18 12l4.2-1.8z" opacity="0.45" />
  </svg>
);

export const IconSun = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" {...S} strokeWidth="2" aria-hidden="true">
    <circle cx="12" cy="12" r="5" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5" />
  </svg>
);

export const IconMoon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" {...S} strokeWidth="2" aria-hidden="true">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);

export const IconMonitor = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" {...S} strokeWidth="2" aria-hidden="true">
    <rect x="2.5" y="4" width="19" height="13" rx="2" />
    <path d="M9 21h6M12 17v4" />
  </svg>
);

export const IconPhone = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" {...S} strokeWidth="2" aria-hidden="true">
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </svg>
);

export const IconGavel = ({ size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <path d="M13.5 3.5l7 7M17 6.5l-3 3M10.5 6.5l7 7" />
    <path d="M3 21h9M6.5 17.5l4.5-8.5 4 4-4.5 4.5z" />
  </svg>
);

export const IconDagger = ({ size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <path d="M12 2.5l3 5-3 13-3-13z" />
    <path d="M7.5 14.5h9M12 21.5v-1" />
  </svg>
);

export const IconSend = ({ size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <path d="M21.5 3.5L10.8 14.2" />
    <path d="M21.5 3.5L14.8 21l-4-6.8-6.8-4z" />
  </svg>
);

export const IconChat = ({ size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <path d="M20.5 12.2c0 4-3.8 7.2-8.5 7.2a9.8 9.8 0 0 1-2.7-.4L4 21l1.3-3.4A6.9 6.9 0 0 1 3.5 12.2C3.5 8.2 7.3 5 12 5s8.5 3.2 8.5 7.2z" />
    <path d="M8.5 11.8h.01M12 11.8h.01M15.5 11.8h.01" />
  </svg>
);

export const IconHand = ({ size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <path d="M9 11V5.5a1.6 1.6 0 0 1 3.2 0V11" />
    <path d="M12.2 10.6V4.8a1.6 1.6 0 0 1 3.2 0v6.2" />
    <path d="M15.4 11V7.4a1.6 1.6 0 0 1 3.2 0V14a6.4 6.4 0 0 1-6.4 6.4h-1A5.8 5.8 0 0 1 5.4 14.6l-.9-2.2a1.6 1.6 0 0 1 2.9-1.4l1 1.6" />
  </svg>
);

export const IconEye = ({ size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </svg>
);

export const IconEyeClosed = ({ size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <path d="M3.5 8.5c3-2 5.5-3 8.5-3s5.5 1 8.5 3" />
    <path d="M6 12.5l-1.2 2M10 12.9l-.4 2.4M14 12.9l.4 2.4M18 12.5l1.2 2" />
  </svg>
);

export const IconEyeOff = ({ size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <path d="M4 4l16 16" />
    <path d="M9.5 5.9A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.9 3.7M6.4 8.1A17 17 0 0 0 2.5 12S6 18.5 12 18.5a9.4 9.4 0 0 0 3.2-.5" />
  </svg>
);

export const IconUsers = ({ size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20a6 6 0 0 1 12 0" />
    <path d="M16.5 5.2a3.2 3.2 0 0 1 0 5.6M18 20a6 6 0 0 0-2.2-4.6" />
  </svg>
);

export const IconCheck = ({ size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2.4" aria-hidden="true">
    <path d="M4.5 12.5l5 5 10-11" />
  </svg>
);

export const IconX = ({ size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2.2" aria-hidden="true">
    <path d="M5.5 5.5l13 13M18.5 5.5l-13 13" />
  </svg>
);

export const IconAlert = ({ size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <path d="M12 3.5l9 16H3z" />
    <path d="M12 9.5v4.5M12 17h.01" />
  </svg>
);

export const IconInfo = ({ size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.8h.01" />
  </svg>
);

export const IconLock = ({ size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <rect x="4.5" y="10.5" width="15" height="10.5" rx="3" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    <path d="M12 14.5v2.5" />
  </svg>
);

export const IconWifiOff = ({ size = 14 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <path d="M3 3l18 18" />
    <path d="M5 11.5a12 12 0 0 1 4-2.4M19 11.5a12 12 0 0 0-6.6-3.1" />
    <path d="M8.5 15.2a7 7 0 0 1 2.2-1.3M12 19.5h.01" />
  </svg>
);

export const IconArrow = ({ size = 14, dir = 'right' }) => {
  const rot = { right: 0, down: 90, left: 180, up: 270 }[dir] || 0;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      {...S}
      strokeWidth="2.4"
      aria-hidden="true"
      style={{ transform: `rotate(${rot}deg)` }}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
};

export const IconClock = ({ size = 14 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5V12l3.5 2" />
  </svg>
);

export const IconShield = ({ size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <path d="M12 3l7 2.5v6c0 4.5-3 7.8-7 9.5-4-1.7-7-5-7-9.5v-6z" />
    <path d="M9 12l2.2 2.2L15.5 10" />
  </svg>
);

export const IconRules = ({ size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <path d="M5 4.5h9a3 3 0 0 1 3 3V21H8a3 3 0 0 1-3-3z" />
    <path d="M17 7.5h2v13.5H8" opacity="0.5" />
    <path d="M8.5 9h5M8.5 13h5M8.5 16.5h3" />
  </svg>
);

export const IconBlank = ({ size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...S} strokeWidth="2" aria-hidden="true">
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <path d="M9.6 10.2a2.6 2.6 0 1 1 3.4 2.5c-.6.2-.9.6-.9 1.2" />
    <path d="M12 17h.01" />
  </svg>
);

/* --------------------------------------------------------------------------
   小部件
   -------------------------------------------------------------------------- */
const FISH_STEPS = [
  { key: 'day', label: '描述', ink: 'var(--phase-day)' },
  { key: 'discuss', label: '讨论', ink: 'var(--phase-discuss)' },
  { key: 'vote', label: '投票', ink: 'var(--phase-vote)' },
  { key: 'night', label: '夜晚', ink: 'var(--phase-night)' },
];

/* 阶段进度。onPhase 缺省时为纯展示，房主可点击直达某阶段由后端裁决合法性。 */
export function PhaseFishbone({ phase, onPhase, compact = false }) {
  const currentIdx = FISH_STEPS.findIndex((s) => s.key === phase);
  const interactive = typeof onPhase === 'function';
  const Tag = interactive ? 'button' : 'span';

  return (
    <div
      className={`fishbone${compact ? ' fishbone--compact' : ''}`}
      role="group"
      aria-label={`本回合阶段进度：描述、讨论、投票、夜晚，当前为 ${FISH_STEPS.find((s) => s.key === phase)?.label || '未开始'}`}
    >
      {FISH_STEPS.map((s, i) => {
        const state = currentIdx < 0 ? 'todo' : i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'todo';
        return (
          <Tag
            key={s.key}
            {...(interactive ? { type: 'button', onClick: () => onPhase(s.key) } : {})}
            className="fish-step"
            data-state={state}
            data-phase={s.key}
            style={{ '--step-ink': s.ink }}
            aria-current={state === 'current' ? 'step' : undefined}
            aria-label={`${s.label}${state === 'done' ? '（已完成）' : state === 'current' ? '（进行中）' : '（未开始）'}`}
          >
            <span className="fish-step__no" aria-hidden="true">
              {state === 'done' ? '✓' : i + 1}
            </span>
            <span className="fish-step__t">{s.label}</span>
          </Tag>
        );
      })}
    </div>
  );
}

export function PhaseBadge({ phase, label, round }) {
  return (
    <span className="phase-badge" data-phase={phase}>
      <span className="phase-badge__dot" aria-hidden="true" />
      {label}
      {round != null && <span className="num" style={{ opacity: 0.75 }}>· 第 {round} 回合</span>}
    </span>
  );
}

export function CountdownRing({ progress = 100, ink }) {
  return (
    <svg className="ring" viewBox="0 0 100 100" style={{ '--ring-progress': progress, '--ring-ink': ink }}>
      <circle className="ring__track" cx="50" cy="50" r="46" pathLength="100" />
      <circle className="ring__bar" cx="50" cy="50" r="46" pathLength="100" />
    </svg>
  );
}

export function RoleTag({ role }) {
  return (
    <span className="mini-tag" data-role={role}>
      {ROLE_LABEL[role] || role}
    </span>
  );
}

export function Note({ tone = 'muted', icon, children }) {
  const Ico = icon;
  return (
    <p className="inline-note" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      {Ico && <Ico />}
      <span>{children}</span>
    </p>
  );
}

export function SectionHead({ title, count, action, lead }) {
  return (
    <>
      <div className="section__head">
        <h2>{title}</h2>
        {count != null && <span className="count-badge num">{count}</span>}
        {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
      </div>
      {lead && <p className="section__lead">{lead}</p>}
    </>
  );
}

/* --------------------------------------------------------------------------
   桌面圆桌座位
   -------------------------------------------------------------------------- */
export function Seat({
  player,
  dx,
  dy,
  tableR,
  seatSize,
  phase,
  speaking,
  ringProgress,
  selected,
  onVote,
  ballotCount,
  showRole,
  turnState,
  sentence,
  sentenceTone,
}) {
  const alive = player.alive !== false;
  const cls = [
    'seat',
    player.me && 'seat--me',
    speaking && 'seat--speaking',
    turnState === 'waiting' && 'seat--waiting',
    turnState === 'spoken' && 'seat--spoken',
    !alive && 'seat--out',
    !player.online && 'seat--lag',
    onVote && alive && 'seat--votable',
    selected && 'seat--selected',
  ]
    .filter(Boolean)
    .join(' ');

  const TURN_TEXT = { speaking: '正在发言', spoken: '已发言', waiting: '待发言' };

  const statusText =
    TURN_TEXT[turnState] ||
    (!player.online ? '重连中' : !alive ? `出局${player.out_round != null ? ` · 第 ${player.out_round} 回合` : ''}` : null);

  const inkFor = {
    day: 'var(--phase-day)',
    discuss: 'var(--phase-discuss)',
    vote: 'var(--phase-vote)',
    night: 'var(--phase-night)',
  }[phase];

  const aria = [
    `座位 ${player.seat}`,
    player.nick,
    alive ? '存活' : '已出局',
    player.online ? '' : '断线重连中',
    showRole && player.role ? ROLE_LABEL[player.role] : '身份未知',
    sentence ? `描述：${sentence}` : sentenceTone === 'typing' ? '正在输入' : '',
  ]
    .filter(Boolean)
    .join('，');

  return (
    <button
      type="button"
      className={`${cls}${onVote ? '' : ' seat--static'}`}
      style={{
        '--dx': dx,
        '--dy': dy,
        '--table-r': len(tableR),
        '--seat': len(seatSize),
        '--speaking-ink': inkFor,
      }}
      aria-label={aria}
      aria-pressed={onVote ? !!selected : undefined}
      aria-disabled={onVote ? undefined : true}
      onClick={onVote}
    >
      <span className="seat__avatar">
        {avatarSrc(player.avatar) && (
          <img
            className="seat__img"
            src={avatarSrc(player.avatar)}
            alt=""
            loading="lazy"
            onError={(e) => { e.currentTarget.remove(); }}
          />
        )}
        <span className="seat__initial">{initials(player.nick)}</span>
        <span className="seat__no num">{player.seat}</span>
        {speaking && <CountdownRing progress={ringProgress ?? 100} ink={inkFor} />}
        {phase === 'night' && alive && <span className="seat__eyes" aria-hidden="true">−‿−</span>}
        <span className="seat__flags">
          {!player.online && (
            <span className="mini-tag" data-tone="lag">断线</span>
          )}
          {showRole && player.role && <RoleTag role={player.role} />}
        </span>
        {ballotCount > 0 && <span className="seat__ballot num">{ballotCount}</span>}
      </span>
      <span className="seat__name">{player.me ? `${player.nick}（我）` : player.nick}</span>

      {sentence || sentenceTone === 'typing' ? (
        <span
          className={`seat__line${sentenceTone === 'mine' ? ' seat__line--mine' : ''}${sentenceTone === 'typing' ? ' seat__line--typing' : ''}`}
          aria-hidden="true"
        >
          {sentenceTone === 'typing' ? '正在输入…' : `“${sentence}”`}
        </span>
      ) : null}

      {statusText && <span className="seat__status">{statusText}</span>}
    </button>
  );
}

export function RoundTable({ players, tableR, seatSize, seatProps, hub, ...rest }) {
  const offsets = seatOffsets(players.length);
  return (
    <div
      className={rest?.className}
      style={{ '--table-r': len(tableR), '--seat': len(seatSize), ...(rest?.style || {}) }}
      {...rest}
    >
      <span className="round-table__ring" aria-hidden="true" />
      {players.map((p, i) => (
        <Seat
          key={p.seat}
          player={p}
          dx={offsets[i].dx}
          dy={offsets[i].dy}
          tableR={tableR}
          seatSize={seatSize}
          {...rest}
          {...(seatProps ? seatProps(p, i) : {})}
        />
      ))}
      {hub}
    </div>
  );
}

/* --------------------------------------------------------------------------
   发言流
   -------------------------------------------------------------------------- */
export function FeedItem({ seat, name, text, phase, phaseLabel, mine, time, tag }) {
  return (
    <article className={`feed__item${mine ? ' feed__item--mine' : ''}`}>
      <span className="feed__seat num" aria-hidden="true">
        {seat ?? '—'}
      </span>
      <div className="feed__body">
        <p className="feed__text">{text}</p>
        <div className="feed__meta">
          <span className="feed__phase-tag" data-phase={phase}>
            {name || '系统'}
          </span>
          {phaseLabel && <span>{phaseLabel}</span>}
          {tag && <RoleTag role={tag} />}
          {time && <span className="num">{time}</span>}
        </div>
      </div>
    </article>
  );
}

/* --------------------------------------------------------------------------
   票型
   -------------------------------------------------------------------------- */
export function tallyOf(ballots, aliveSeats) {
  const map = new Map();
  ballots.forEach((b) => {
    const key = b.to ?? 'abstain';
    map.set(key, (map.get(key) || 0) + 1);
  });
  const rows = aliveSeats
    .map((s) => ({ seat: s, votes: map.get(s) || 0 }))
    .sort((a, b) => b.votes - a.votes);
  return { rows, abstain: map.get('abstain') || 0, total: ballots.length };
}

export function BallotPanel({ tally, aliveSeats, players, lead, bySeat = false, className }) {
  const rows = bySeat ? [...tally.rows].sort((a, b) => a.seat - b.seat) : tally.rows;
  const max = Math.max(1, ...tally.rows.map((r) => r.votes), tally.abstain);
  const nameOf = (seat) => players.find((p) => p.seat === seat)?.nick || '';

  return (
    <div className={['ballot', bySeat ? 'ballot--seat' : null, className].filter(Boolean).join(' ')}>
      {lead ? <p className="ballot__lead">{lead}</p> : null}

      {rows.map((r) => (
        <div className="ballot__row" key={r.seat}>
          <span className="ballot__who">
            <b className="num">{r.seat} 号</b>
            {nameOf(r.seat)}
          </span>
          <span className="ballot__count num">{r.votes}</span>
          <span className="ballot__bar">
            <span className="ballot__fill" style={{ '--w': `${(r.votes / max) * 100}%` }} />
          </span>
        </div>
      ))}

      {tally.abstain > 0 ? (
        <div className="ballot__row">
          <span className="ballot__who">
            <b>弃票</b>
          </span>
          <span className="ballot__count num">{tally.abstain}</span>
          <span className="ballot__bar">
            <span className="ballot__fill ballot__fill--abstain" style={{ '--w': `${(tally.abstain / max) * 100}%` }} />
          </span>
        </div>
      ) : null}

      <p className="t-12 soft">
        已回收 <b className="num">{tally.total}</b> 张选票，剩余{' '}
        <b className="num">{Math.max(0, aliveSeats.length - tally.total)}</b> 人未投票。
      </p>
    </div>
  );
}

/* --------------------------------------------------------------------------
   身份分配预览（准备房 / 建房弹窗共用）
   -------------------------------------------------------------------------- */
export function DistributionPreview({ cap, override }) {
  const d = override || distributionOf(null, cap);
  const sum = d.civilian + d.spy + d.blank;
  const valid = sum === cap;
  return (
    <>
      <div className="role-grid">
        <div className="role-cell" data-role="civilian">
          <span className="role-cell__n num">{d.civilian}</span>
          <span className="role-cell__l">好人</span>
        </div>
        <div className="role-cell" data-role="spy">
          <span className="role-cell__n num">{d.spy}</span>
          <span className="role-cell__l">卧底</span>
        </div>
        <div className="role-cell" data-role="blank">
          <span className="role-cell__n num">{d.blank}</span>
          <span className="role-cell__l">白板</span>
        </div>
      </div>
      <Note tone={valid ? 'ok' : 'error'} icon={valid ? IconCheck : IconAlert}>
        {valid
          ? `${cap} 人局：${d.civilian} 好人 + ${d.spy} 卧底 + ${d.blank} 白板，合计 ${cap} 人。`
          : `身份合计 ${sum} 人，与 ${cap} 人不符。`}
      </Note>
    </>
  );
}

export function ListSkeleton({ rows = 4 }) {
  return (
    <div className="stack" aria-busy="true" aria-label="加载中">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} style={{ height: 66, borderRadius: 'var(--radius-card)' }} />
      ))}
    </div>
  );
}

export function EmptyState({ icon: Ico = IconSpy, title, sub, action }) {
  return (
    <div className="card card--flat" style={{ textAlign: 'center', padding: 'var(--gap-6)' }}>
      <div style={{ display: 'grid', placeItems: 'center', gap: 'var(--gap-2)' }}>
        <span style={{ color: 'var(--text-soft)' }}>
          <Ico size={28} />
        </span>
        <p style={{ margin: 0, fontWeight: 600, fontSize: 'calc(14px * var(--seed-type-scale))' }}>{title}</p>
        {sub && <p className="t-13 muted" style={{ margin: 0 }}>{sub}</p>}
        {action}
      </div>
    </div>
  );
}

export { Button, Tooltip, Tag };
