/* ==========================================================================
   桌面端圆桌游戏房 —— 全屏沉浸
   [HERE] Game/spy-react/src/screens/GameRoomDesktop.jsx
   两点硬规则（与原型一致）：
   1. 描述阶段严格「一人一句」：只有服务端认定的当前发言者可输入，
      已发言的句子逐条累积，未发言座位显示「待发言」且不泄露内容。
   2. 讨论阶段没有聊天通道 —— 口头/站外讨论，主持人推进到投票；
      界面展示描述存档与阶段提示。
   服务端权威：一切动作都打 API，本地不维护对局状态。
   ========================================================================== */
import React, { useMemo, useState } from 'react';
import { Button, Input } from 'sparkdesign';

import {
  BallotPanel,
  CountdownRing,
  FeedItem,
  IconAlert,
  IconChat,
  IconCheck,
  IconDagger,
  IconEyeOff,
  IconInfo,
  IconRules,
  IconSend,
  IconUsers,
  IconWifiOff,
  IconX,
  Note,
  PhaseFishbone,
  RoundTable,
  tableMetrics,
} from '@/components/shared.jsx';
import HostConsole from '@/components/HostConsole.jsx';
import { PHASE_META, OUT_LABEL, RULE_SNAPSHOT, distributionOf } from '@/data/constants.js';
import { advancePhase, blankGuess, castVote, nightAction, submitSentence } from '@/data/api.js';

const IMMERSIVE_SCALE = 1.5;

/* 倒计时：以快照时刻为基准本地递减，轮询回来后自动校正 */
function useCountdown(remaining, rev) {
  const [endAt] = useState(() => (remaining != null ? Date.now() + remaining * 1000 : 0));
  const [tick, setTick] = useState(0);
  React.useEffect(() => {
    if (!endAt) return undefined;
    const t = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [endAt]);
  void tick;
  return endAt ? Math.max(0, Math.round((endAt - Date.now()) / 1000)) : null;
}

export default function GameRoomDesktop({ snapshot, act, actError, onLeave }) {
  const room = snapshot.room;
  const me = snapshot.me;
  const phase = room.phase;
  const round = room.round;
  const code = room.code;

  const aliveSet = useMemo(() => new Set(room.targets), [room.targets]);
  const seats = useMemo(
    () => snapshot.seats.map((s) => ({ ...s, alive: aliveSet.has(s.seat), me: !!me && s.seat === me.seat })),
    [snapshot.seats, aliveSet, me],
  );
  const aliveSeats = seats.filter((s) => s.alive);
  const roundSentences = snapshot.sentences[String(round)] || {};
  const spokenCount = Object.keys(roundSentences).length;
  const totalSpeakers = (room.speaking_order || []).length;
  const votedCount = seats.filter((s) => s.has_voted).length;
  const night = snapshot.night || { required: 0, submitted: 0 };
  const meta = PHASE_META[phase] || PHASE_META.day;
  const remaining = useCountdown(room.remaining, snapshot.rev);

  const [panel, setPanel] = useState(null);
  const [draft, setDraft] = useState('');
  const [voteTarget, setVoteTarget] = useState(null);
  const [killTarget, setKillTarget] = useState(null);
  const [selfKillWarn, setSelfKillWarn] = useState(false);
  const [guessOpen, setGuessOpen] = useState(false);
  const [guessSeen, setGuessSeen] = useState(false);
  const [guessA, setGuessA] = useState('');
  const [guessB, setGuessB] = useState('');
  const [showHost, setShowHost] = useState(true);
  const [err, setErr] = useState('');

  const isMyTurn = !!me && phase === 'day' && me.can_speak;
  const myWord = me && me.word ? me.word : '';
  const d = distributionOf(room, room.cap);

  const feed = useMemo(() => {
    const items = [];
    Object.keys(snapshot.sentences).forEach((r) => {
      Object.keys(snapshot.sentences[r]).forEach((seat) => {
        const s = snapshot.sentences[r][seat];
        const who = snapshot.seats.find((x) => x.seat === Number(seat));
        if (s.skipped) return;
        items.push({
          round: Number(r),
          seat: Number(seat),
          name: who ? who.nick : `${seat} 号`,
          text: s.body,
          phase: 'day',
          phaseLabel: `第 ${r} 回合 · 描述`,
          mine: !!me && Number(seat) === me.seat,
        });
      });
    });
    items.sort((a, b) => a.round - b.round || a.seat - b.seat);
    (snapshot.outcomes || []).forEach((o) => {
      const who = o.eliminated_seat != null
        ? snapshot.seats.find((x) => x.seat === o.eliminated_seat)
        : null;
      items.push({
        round: o.round,
        seat: null,
        name: '裁决',
        text: who
          ? `${who.nick}（${o.eliminated_seat} 号）出局：${OUT_LABEL[o.out_by] || ''}`
          : o.host_ruling || (o.tie ? '平票，由主持人裁决' : '本阶段无人出局'),
        phase: o.stage,
        phaseLabel: `第 ${o.round} 回合 · ${o.stage === 'night' ? '夜晚' : '投票'}`,
      });
    });
    return items.sort((a, b) => a.round - b.round);
  }, [snapshot.sentences, snapshot.outcomes, snapshot.seats, me]);

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    setErr('');
    const ok = await act(() => submitSentence(code, text));
    if (ok) setDraft('');
    else setErr('发言未通过：描述可能包含所持有的词、超出长度限制或已超过时限。');
  };
  const skipTurn = () => act(() => submitSentence(code, '', true));
  const doVote = (seat) => {
    if (!me || !me.can_vote) return;
    setVoteTarget(seat);
  };
  const confirmVote = () => act(() => castVote(code, voteTarget));
  const abstain = () => act(() => castVote(code, null));
  const confirmKill = () => {
    setSelfKillWarn(false);
    act(() => nightAction(code, killTarget));
  };
  const passNight = () => act(() => nightAction(code, null));
  const sendGuess = () => {
    if (!guessA.trim() || !guessB.trim()) return;
    setGuessOpen(false);
    act(() => blankGuess(code, guessA.trim(), guessB.trim()));
  };

  const turnStateOf = (seat) => {
    if (phase !== 'day') return null;
    if (roundSentences[seat]) return 'spoken';
    if (room.speaker_seat === seat) return 'speaking';
    return 'waiting';
  };

  const speakerSeat = seats.find((s) => s.seat === room.speaker_seat);

  function renderAction() {
    if (!me) {
      return (
        <div className="turn-hint" style={{ height: 52 }}>
          <IconEyeOff size={14} /> 旁观视角（画面延迟 {room.spectate_delay} 秒），无法参与发言与投票。
        </div>
      );
    }
    if (phase === 'day') {
      if (isMyTurn) {
        return (
          <>
            <div className="action-bar__input">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={
                  myWord
                    ? `轮到 ${me.seat} 号发言：请提交一句与「${myWord}」相关但不包含该词的描述`
                    : `轮到 ${me.seat} 号发言：本席未持有词，请提交一句用于试探他人的描述`
                }
                aria-label="发言输入"
                maxLength={40}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              />
            </div>
            <span className="t-12 soft num">{draft.length}/40</span>
            <Button variant="outline" size="sm" rounded="pill" onClick={skipTurn}>跳过</Button>
            <Button variant="primary" rounded="pill" disabled={!draft.trim()} prefixIcon={<IconSend />} onClick={submit}>
              提交描述
            </Button>
          </>
        );
      }
      return (
        <>
          <div className="turn-hint">
            <IconChat size={14} />
            {phase === 'day'
              ? `等待 ${room.speaker_seat} 号发言 · ${speakerSeat ? speakerSeat.nick : ''}`
              : meta.full}
          </div>
          <div className="action-bar__actions">
            <span className="stat-chip">
              已发言 <b className="num">{spokenCount}</b>/<span className="num">{totalSpeakers}</span>
            </span>
          </div>
        </>
      );
    }
    if (phase === 'discuss') {
      return (
        <div className="turn-hint" style={{ height: 52 }}>
          <IconInfo size={14} /> 自由讨论阶段：请通过语音或线下讨论，由主持人确认后进入投票。已提交的描述见「发言记录」。
        </div>
      );
    }
    if (phase === 'vote') {
      return (
        <>
          <div className="turn-hint" style={{ height: 52 }}>
            <IconAlert size={14} />
            {!me.can_vote
              ? '你已投票或本轮不可投票，等待其他玩家'
              : voteTarget
                ? `已选择 ${voteTarget} 号：${seats.find((s) => s.seat === voteTarget)?.nick || ''}`
                : '点击圆桌中的座位进行投票，也可选择弃票'}
          </div>
          <div className="action-bar__actions">
            <Button variant="outline" size="sm" rounded="pill" onClick={() => setPanel('ballot')}>已投 {votedCount}/{aliveSeats.length}</Button>
            <Button variant="text" size="sm" rounded="pill" onClick={abstain} disabled={!me.can_vote}>弃票</Button>
            <Button variant="primary" size="sm" rounded="pill" disabled={!voteTarget || !me.can_vote} onClick={confirmVote}>确认投票</Button>
          </div>
        </>
      );
    }
    if (phase === 'night') {
      if (night.submitted >= night.required || (me && me.out_round != null)) {
        return (
          <>
            <div className="turn-hint">
              <IconCheck size={14} /> 夜晚阶段进行中：已提交 {night.submitted}/{night.required} 条指令，全部提交后自动结算
            </div>
            <span className="night-note"><IconEyeOff size={14} /> 夜晚 · 全员闭眼</span>
          </>
        );
      }
      return (
        <>
          <div className="turn-hint" style={{ height: 52 }}>
            <IconDagger size={14} />
            {killTarget
              ? `已选择目标 ${killTarget} 号：${seats.find((s) => s.seat === killTarget)?.nick || ''}`
              : '若判断自己为卧底，请点击圆桌中的座位指定刀人目标'}
          </div>
          <div className="action-bar__actions">
            <Button variant="outline" size="sm" rounded="pill" onClick={passNight}>本回合不提交刀人指令</Button>
            <Button
              variant="destructive"
              size="sm"
              rounded="pill"
              disabled={killTarget == null}
              prefixIcon={<IconDagger />}
              onClick={() => setSelfKillWarn(true)}
            >
              确认刀人
            </Button>
            {me.can_guess && (
              <Button variant="text" size="sm" rounded="pill" onClick={() => setGuessOpen(true)}>
                白板猜词
              </Button>
            )}
          </div>
        </>
      );
    }
    return null;
  }

  const metrics = tableMetrics(aliveSeats.length);

  return (
    <div className={`app-shell--desktop${phase === 'night' ? ' phase-night' : ''}`} data-component="Spy/GameRoomDesktop" data-phase={phase}>
      <header className="room-topbar">
        <PhaseFishbone phase={phase} />
        <span className="stat-chip num">第 {round} 回合</span>
        <span className="t-13 soft room-topbar__hint">{meta.full}</span>
        <span className="room-topbar__spacer" />
        {remaining != null && (
          <span className="stat-chip num">剩余 {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</span>
        )}
        <span className="stat-chip">
          存活 <b className="num">{aliveSeats.length}</b><span className="soft">/{seats.length}</span>
        </span>
        {seats.some((s) => !s.online) && (
          <span className="stat-chip" style={{ color: 'var(--status-lag)' }}>
            <IconWifiOff /> <span className="num">{seats.filter((s) => !s.online).length}</span>
          </span>
        )}
        {room.can_control && (
          <Button variant="secondary" size="sm" rounded="pill" onClick={() => setShowHost((v) => !v)}>
            主持人
          </Button>
        )}
      </header>

      <main className="room-stage">
        <div className="stage-toolbar">
          <button type="button" className="icon-btn" aria-pressed={panel === 'feed'} onClick={() => setPanel(panel === 'feed' ? null : 'feed')} aria-label="发言记录">
            <IconChat size={16} />
          </button>
          <button type="button" className="icon-btn" aria-pressed={panel === 'ballot'} onClick={() => setPanel(panel === 'ballot' ? null : 'ballot')} aria-label="票型统计">
            <IconUsers size={16} />
          </button>
          <button type="button" className="icon-btn" aria-pressed={panel === 'rules'} onClick={() => setPanel(panel === 'rules' ? null : 'rules')} aria-label="规则速览">
            <IconRules size={16} />
          </button>
        </div>

        <RoundTable
          players={aliveSeats}
          tableR={Math.round(metrics.radius * IMMERSIVE_SCALE)}
          seatSize={metrics.seat}
          phase={phase}
          showRole={room.host_seat === null && room.can_control}
          seatProps={(p) => {
            const turn = turnStateOf(p.seat);
            const sentence = roundSentences[p.seat] && !roundSentences[p.seat].skipped ? roundSentences[p.seat].body : undefined;
            const votable =
              (phase === 'vote' && !!me && me.can_vote && p.seat !== (me && me.seat)) ||
              (phase === 'night' && !!me && night.submitted < night.required && p.seat !== (me && me.seat));
            return {
              turnState: turn,
              sentence,
              sentenceTone: p.me ? 'mine' : undefined,
              speaking: turn === 'speaking',
              ringProgress: remaining != null ? Math.round((remaining / 60) * 100) : undefined,
              selected: phase === 'vote' ? voteTarget === p.seat : killTarget === p.seat,
              ballotCount: p.has_voted ? 1 : 0,
              onVote: votable
                ? () => {
                    if (phase === 'vote') doVote(p.seat);
                    else setKillTarget(p.seat === killTarget ? null : p.seat);
                  }
                : undefined,
            };
          }}
          hub={
            <div className="table-hub" style={{ '--hub-ink': meta.ink }}>
              <span className="table-hub__label">第 {round} 回合 · {meta.label}</span>
              <span style={{ position: 'relative', display: 'inline-grid', placeItems: 'center', width: 58, height: 58 }}>
                <CountdownRing progress={remaining != null ? Math.min(100, Math.round((remaining / Math.max(1, meta.length || 60)) * 100)) : 100} ink={meta.ink} />
                <span className="num" style={{ fontSize: 'calc(17px * var(--seed-type-scale))', fontWeight: 700 }}>
                  {remaining != null ? remaining : '—'}
                </span>
              </span>
              {phase === 'day' ? (
                <>
                  <span className="table-hub__main">
                    {room.speaker_seat} 号 {speakerSeat ? speakerSeat.nick : ''}
                  </span>
                  <span className="table-hub__sub num">每人一句：已发言 {spokenCount}/{totalSpeakers}</span>
                </>
              ) : (
                <span className="table-hub__sub">
                  {phase === 'vote'
                    ? (room.tie_open ? '平票，等待主持人裁决' : `已投 ${votedCount}/${aliveSeats.length} 票`)
                    : phase === 'night'
                      ? `夜晚指令 ${night.submitted}/${night.required}`
                      : meta.full}
                </span>
              )}
              {room.can_control && (
                <div className="row row--tight" style={{ justifyContent: 'center' }}>
                  <Button
                    variant="tertiary"
                    size="sm"
                    rounded="pill"
                    onClick={() => { act(() => advancePhase(code)); setErr(''); }}
                  >
                    进入下一阶段
                  </Button>
                </div>
              )}
            </div>
          }
        />
      </main>

      <footer className="action-bar" role="region" aria-label={`${meta.label}操作区`}>
        {(err || actError) && <span className="t-12" style={{ color: 'var(--status-out)' }}>{err || actError}</span>}
        {renderAction()}
      </footer>

      {panel && (
        <aside className="rail-drawer" role="complementary" aria-label={panel}>
          <div className="drawer__head">
            <span className="drawer__title">
              {panel === 'feed' ? '发言记录' : panel === 'ballot' ? '票型统计' : '规则速览'}
            </span>
            <button type="button" className="icon-btn" onClick={() => setPanel(null)} aria-label="关闭">
              <IconX size={14} />
            </button>
          </div>
          <div className="drawer__body">
            {panel === 'feed' && (
              <div className="feed">
                {feed.length === 0 && <p className="t-13 muted">暂无可公开的发言记录。</p>}
                {feed.map((f) => (
                  <FeedItem key={`${f.round}-${f.seat ?? 'sys'}`} {...f} />
                ))}
              </div>
            )}
            {panel === 'ballot' && (
              <BallotPanel
                tally={{ rows: aliveSeats.map((s) => ({ seat: s.seat, votes: 0 })), abstain: 0, total: votedCount }}
                aliveSeats={aliveSeats.map((s) => s.seat)}
                players={seats}
                lead={`已投 ${votedCount}/${aliveSeats.length} 票。投票截止前仅显示是否已投票，不显示投票对象。`}
              />
            )}
            {panel === 'rules' && (
              <div className="stack">
                {RULE_SNAPSHOT.map((x) => (
                  <div className="card card--flat" key={x.t}>
                    <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: 'calc(13.5px * var(--seed-type-scale))' }}>{x.t}</p>
                    <p className="t-13 muted" style={{ margin: 0, lineHeight: 1.65 }}>{x.d}</p>
                  </div>
                ))}
                <div className="card card--flat">
                  <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: 'calc(13.5px * var(--seed-type-scale))' }}>本局身份配额</p>
                  <p className="t-13 muted" style={{ margin: 0, lineHeight: 1.65 }}>
                    {seats.length} 人局：{d.civilian} 好人 · {d.spy} 卧底{d.blank > 0 ? ` · ${d.blank} 白板` : ''}
                  </p>
                </div>
              </div>
            )}
          </div>
        </aside>
      )}

      {room.can_control && showHost && (
        <HostConsole snapshot={snapshot} act={act} onClose={() => setShowHost(false)} />
      )}

      {selfKillWarn && (
        <div className="overlay overlay--fixed" role="alertdialog" aria-labelledby="selfkill-title">
          <div className="sheet sheet--night">
            <div className="row row--tight" style={{ color: 'var(--status-out)' }}>
              <IconAlert size={17} />
              <h3 id="selfkill-title" className="sheet__title" style={{ color: 'inherit' }}>
                确认对 {killTarget} 号提交刀人指令？
              </h3>
            </div>
            <div className="night-recap">
              <span className="night-recap__k">判断依据</span>
              <p className="night-recap__v">
                本席所持有的词为<b>{myWord ? `「${myWord}」` : '（未持有词）'}</b>。
                请根据本轮描述，判断自己与多数人所持有的词是否一致。
              </p>
            </div>
            <p className="t-13">
              仅卧底的刀人指令生效。若本席并非卧底，该指令将在结算时判定为
              <b style={{ color: 'var(--status-out)' }}>自刀</b>，出局者为本人。
            </p>
            <Note tone="muted" icon={IconInfo}>界面不显示身份，本提示对所有座位一致。</Note>
            <div className="sheet__foot">
              <Button variant="outline" rounded="pill" onClick={() => setSelfKillWarn(false)}>返回</Button>
              <Button variant="destructive" rounded="pill" onClick={confirmKill}>
                确认提交
              </Button>
            </div>
          </div>
        </div>
      )}

      {guessOpen && (
        <div className="overlay overlay--fixed" role="dialog" aria-label="白板猜词">
          <div className="sheet">
            <h3 className="sheet__title">请猜出两个词</h3>
            <p className="t-13 muted" style={{ margin: 0 }}>两个词均猜中：白板单独获胜；仅猜中一个：不淘汰，本局继续。每局仅有一次猜词机会。</p>
            <div className="stack" style={{ marginTop: 'var(--gap-3)' }}>
              <Input value={guessA} onChange={(e) => setGuessA(e.target.value)} placeholder="请输入猜测的正常词" aria-label="猜测的正常词" maxLength={16} />
              <Input value={guessB} onChange={(e) => setGuessB(e.target.value)} placeholder="请输入猜测的卧底词" aria-label="猜测的卧底词" maxLength={16} />
            </div>
            <div className="sheet__foot">
              <Button variant="outline" rounded="pill" onClick={() => setGuessOpen(false)}>取消</Button>
              <Button variant="primary" rounded="pill" disabled={!guessA.trim() || !guessB.trim()} onClick={sendGuess}>提交猜词</Button>
            </div>
          </div>
        </div>
      )}

      {me && me.guess && !guessSeen && (
        <div className="overlay overlay--fixed" role="dialog" aria-label="猜词结果">
          <div className="sheet">
            <h3 className="sheet__title">猜词结果</h3>
            <p className="t-13" style={{ margin: 0 }}>
              「{me.guess.guess_a}」 · 「{me.guess.guess_b}」：{me.guess.result === 'both' ? '两个词全部猜中' : me.guess.result === 'none' ? '两个词均未猜中。' : '仅猜中一个，本席继续在局。'}
            </p>
            <div className="sheet__foot">
              <Button variant="primary" rounded="pill" onClick={() => setGuessSeen(true)}>确认</Button>
            </div>
          </div>
        </div>
      )}

      <span aria-live="polite" className="sr-only">
        {meta.full}，第 {round} 回合，存活 {aliveSeats.length} 人。
        {phase === 'day' && isMyTurn && ` 当前轮到 ${me.seat} 号发言。`}
      </span>
    </div>
  );
}
