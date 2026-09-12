/* ==========================================================================
   移动端游戏房 —— 单列流式
   吸顶阶段条 → 横向座位带 → 记录/票型 → 底部行动条
   [HERE] Game/spy-react/src/screens/GameRoomMobile.jsx
   与桌面同源同契约：动作全部打 API，本地不维护对局状态。
   ========================================================================== */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input } from 'sparkdesign';

import {
  FeedItem,
  IconAlert,
  IconCheck,
  IconDagger,
  IconEye,
  IconEyeOff,
  IconSend,
  IconWifiOff,
  Note,
  PhaseFishbone,
  avatarSrc,
  initials,
} from '@/components/shared.jsx';
import HostConsole from '@/components/HostConsole.jsx';
import { PHASE_META, OUT_LABEL, RULE_SNAPSHOT } from '@/data/constants.js';
import { advancePhase, blankGuess, castVote, nightAction, submitSentence } from '@/data/api.js';

function SeatRail({ players, phase, turnStateOf, onSelect, selectedSeat, sentences }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mine = el.querySelector('.m-seat--me');
    if (mine) el.scrollLeft = mine.offsetLeft - el.clientWidth / 2 + mine.clientWidth / 2;
  }, [players.length]);

  return (
    <div className="seat-rail" ref={ref} role="list" aria-label="座位带">
      {players.map((p) => {
        const turn = turnStateOf(p.seat);
        const sent = sentences[p.seat] && !sentences[p.seat].skipped ? sentences[p.seat].body : null;
        return (
          <button
            type="button"
            key={p.seat}
            role="listitem"
            className={[
              'm-seat',
              p.me && 'm-seat--me',
              turn === 'speaking' && 'm-seat--speaking',
              turn === 'waiting' && 'm-seat--waiting',
              turn === 'spoken' && 'm-seat--spoken',
              !p.alive && 'm-seat--out',
              phase !== 'day' && 'm-seat--votable',
              selectedSeat === p.seat && 'm-seat--selected',
            ].filter(Boolean).join(' ')}
            onClick={() => onSelect(p.seat)}
            aria-label={`座位 ${p.seat}，${p.nick}，${p.alive ? '存活' : '已出局'}${sent ? `，说：${sent}` : ''}`}
          >
            <span className="m-seat__avatar">
              {avatarSrc(p.avatar) && (
                <img
                  className="m-seat__img"
                  src={avatarSrc(p.avatar)}
                  alt=""
                  loading="lazy"
                  onError={(e) => { e.currentTarget.remove(); }}
                />
              )}
              <span className="m-seat__initial">{initials(p.nick)}</span>
              {selectedSeat === p.seat && (
                <span className={`m-seat__vote${phase === 'night' ? ' m-seat__vote--kill' : ''}`}>
                  {phase === 'night' ? '刀' : '✓'}
                </span>
              )}
            </span>
            <span className="m-seat__no num">{p.seat}</span>
            <span className="m-seat__name">{p.me ? '我' : p.nick}</span>
            {sent ? <span className="m-seat__line" aria-hidden="true">“{sent}”</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export default function GameRoomMobile({ snapshot, act, actError, onLeave }) {
  const room = snapshot.room;
  const me = snapshot.me;
  const phase = room.phase;
  const round = room.round;
  const code = room.code;
  const meta = PHASE_META[phase] || PHASE_META.day;

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

  const [voteTarget, setVoteTarget] = useState(null);
  const [killTarget, setKillTarget] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [wordPress, setWordPress] = useState(false);
  const [draft, setDraft] = useState('');
  const [guessA, setGuessA] = useState('');
  const [guessB, setGuessB] = useState('');
  const [tab, setTab] = useState('table');
  const [showHost, setShowHost] = useState(false);
  const [err, setErr] = useState('');

  const myWord = me && me.word ? me.word : '';
  const isMyTurn = !!me && phase === 'day' && me.can_speak;
  const speaker = seats.find((s) => s.seat === room.speaker_seat);
  const outFeed = (snapshot.outcomes || []).map((o) => {
    const who = o.eliminated_seat != null ? seats.find((x) => x.seat === o.eliminated_seat) : null;
    return {
      round: o.round,
      seat: null,
      name: '裁决',
      text: who ? `${who.nick}（${o.eliminated_seat} 号）出局：${OUT_LABEL[o.out_by] || ''}` : o.host_ruling || '平票，等待主持人裁决',
      phase: o.stage,
      phaseLabel: `第 ${o.round} 回合 · ${o.stage === 'night' ? '夜晚' : '投票'}`,
    };
  });

  const turnStateOf = (seat) => {
    if (phase !== 'day') return null;
    if (roundSentences[seat]) return 'spoken';
    if (room.speaker_seat === seat) return 'speaking';
    return 'waiting';
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    setErr('');
    const ok = await act(() => submitSentence(code, text));
    if (ok) setDraft('');
    else setErr('发言未通过：描述可能包含所持有的词、超出长度限制或已超过时限。');
  };
  const skipTurn = () => act(() => submitSentence(code, '', true));
  const confirmVote = () => act(() => castVote(code, voteTarget));
  const abstain = () => act(() => castVote(code, null));
  const confirmKill = () => {
    setSheet(null);
    act(() => nightAction(code, killTarget));
  };
  const passNight = () => act(() => nightAction(code, null));
  const sendGuess = () => {
    if (!guessA.trim() || !guessB.trim()) return;
    setSheet(null);
    act(() => blankGuess(code, guessA.trim(), guessB.trim()));
  };
  const onSelect = (seat) => {
    if (phase === 'vote') { if (me && me.can_vote) setVoteTarget(seat === voteTarget ? null : seat); }
    else if (phase === 'night' && me && night.submitted < night.required && seat !== me.seat) {
      setKillTarget(seat === killTarget ? null : seat);
    }
  };

  function actionbar() {
    if (!me) {
      return (
        <div className="turn-hint" style={{ height: 44, justifyContent: 'center' }}>
          <IconEyeOff size={14} /> 旁观视角（延迟 {room.spectate_delay} 秒）
        </div>
      );
    }
    if (phase === 'day') {
      return (
        <>
          <button
            type="button"
            className="m-word"
            data-hidden={wordPress ? 'false' : 'true'}
            onPointerDown={() => setWordPress(true)}
            onPointerUp={() => setWordPress(false)}
            onPointerLeave={() => setWordPress(false)}
            onPointerCancel={() => setWordPress(false)}
            aria-label={wordPress ? (myWord ? `本席所持有的词为 ${myWord}` : '本席为白板，未持有词') : '按住查看本席的词'}
          >
            <span className="m-word__k">{wordPress ? '本席词' : '按住查看'}</span>
            <span className="m-word__v">{wordPress ? (myWord || '白板：未持有词') : '· · · ·'}</span>
            {wordPress ? <IconEyeOff size={16} /> : <IconEye size={16} />}
          </button>
          {isMyTurn ? (
            <>
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="请输入与词相关的描述" maxLength={40} aria-label="发言输入" />
              <div className="row">
                <Button variant="outline" rounded="pill" onClick={skipTurn}>跳过</Button>
                <Button variant="primary" rounded="pill" style={{ flex: 1 }} disabled={!draft.trim()} prefixIcon={<IconSend />} onClick={submit}>
                  提交描述
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="turn-hint" style={{ height: 44, justifyContent: 'center' }}>
                <IconCheck size={14} /> 等待 {room.speaker_seat} 号 · {speaker ? speaker.nick : ''}
              </div>
              <div className="m-actionbar__hint">
                <span>每人一句</span>
                <span className="num">已发言 {spokenCount}/{totalSpeakers}</span>
              </div>
            </>
          )}
        </>
      );
    }
    if (phase === 'discuss') {
      return (
        <div className="turn-hint" style={{ height: 44, justifyContent: 'center' }}>
          <IconCheck size={14} /> 自由讨论进行中，由主持人确认后进入投票
        </div>
      );
    }
    if (phase === 'vote') {
      return (
        <>
          <div className="m-actionbar__hint">
            <span>{!me.can_vote ? '已投票或不可投票' : voteTarget ? `已选择 ${voteTarget} 号，确认后生效` : '点击上方座位进行投票'}</span>
            <span className="num">{votedCount}/{aliveSeats.length}</span>
          </div>
          <div className="row">
            <Button variant="outline" rounded="pill" size="lg" style={{ flex: 1 }} onClick={abstain} disabled={!me.can_vote}>弃票</Button>
            <Button variant="primary" rounded="pill" size="lg" style={{ flex: 2 }} disabled={!voteTarget || !me.can_vote} onClick={confirmVote}>确认投票</Button>
          </div>
        </>
      );
    }
    if (phase === 'night') {
      if (night.submitted >= night.required || me.out_round != null) {
        return (
          <div className="turn-hint" style={{ height: 44, justifyContent: 'center' }}>
            <IconCheck size={14} /> 夜晚进行中 · 指令 {night.submitted}/{night.required}
          </div>
        );
      }
      return (
        <>
          <div className="m-actionbar__hint">
            <span>{killTarget ? `已选 ${killTarget} 号` : '若判断自己为卧底，请点击座位指定目标'}</span>
            <span>{myWord ? `本席词 ${myWord}` : '本席未持有词'}</span>
          </div>
          <div className="row">
            <Button variant="outline" rounded="pill" size="lg" style={{ flex: 1 }} onClick={passNight}>不提交指令</Button>
            <Button variant="destructive" rounded="pill" size="lg" style={{ flex: 2 }} disabled={killTarget == null} prefixIcon={<IconDagger />} onClick={() => setSheet('selfkill')}>
              确认刀人
            </Button>
          </div>
          {me.can_guess && (
            <Button variant="text" rounded="pill" size="lg" onClick={() => setSheet('guess')}>
              白板猜词
            </Button>
          )}
        </>
      );
    }
    return null;
  }

  return (
    <div className={`app-shell--mobile${phase === 'night' ? ' phase-night' : ''}`} data-component="Spy/GameRoomMobile" data-phase={phase}>
      <header className="m-topbar">
        <span className="m-topbar__title">{room.name}</span>
        <span className="m-topbar__code">{room.code}</span>
        {room.can_control && (
          <button type="button" className="icon-btn" style={{ width: 32, height: 28 }} onClick={() => setShowHost(true)} aria-label="主持人控制台">
            ☰
          </button>
        )}
      </header>

      <div className="m-phasebar" data-phase={phase} style={{ position: 'sticky', top: 0, zIndex: 6 }}>
        <PhaseFishbone phase={phase} compact />
        <span className="m-phasebar__count num">
          {phase === 'night' ? `${night.submitted}/${night.required}` : `${aliveSeats.length}人`}
        </span>
      </div>

      <div className="m-stage" data-tab={tab}>
        {tab === 'table' && (
          <div className="m-card">
            <div className="m-card__head">
              <span>第 {round} 回合 · {aliveSeats.length} 人存活</span>
              {seats.some((s) => !s.online) && (
                <span style={{ color: 'var(--status-lag)' }}><IconWifiOff size={13} /> {seats.filter((s) => !s.online).length} 人重连中</span>
              )}
            </div>
            <SeatRail
              players={aliveSeats}
              phase={phase}
              turnStateOf={turnStateOf}
              onSelect={onSelect}
              selectedSeat={phase === 'vote' ? voteTarget : killTarget}
              sentences={roundSentences}
            />
            <p className="t-12 soft" style={{ margin: 0 }}>
              {phase === 'day'
                ? `每人一句：已发言 ${spokenCount}/${totalSpeakers}`
                : phase === 'vote'
                  ? (room.tie_open ? '平票，等待主持人裁决' : '点击座位进行投票，可弃票')
                  : phase === 'night'
                    ? (killTarget ? `目标 ${killTarget} 号` : '点击座位指定刀人目标')
                    : '等待主持人推进'}
            </p>
          </div>
        )}

        {tab === 'feed' && (
          <div className="m-card">
            <div className="m-card__head"><span>发言与裁决</span></div>
            <div className="feed">
              {Object.keys(snapshot.sentences).length === 0 && outFeed.length === 0 && (
                <p className="t-13 muted">暂无记录。</p>
              )}
              {Object.keys(snapshot.sentences).map((r) => (
                Object.keys(snapshot.sentences[r]).map((seat) => {
                  const s = snapshot.sentences[r][seat];
                  if (s.skipped) return null;
                  const who = seats.find((x) => x.seat === Number(seat));
                  return (
                    <FeedItem
                      key={`s${r}-${seat}`}
                      seat={Number(seat)}
                      name={who ? who.nick : `${seat} 号`}
                      text={s.body}
                      phase="day"
                      phaseLabel={`第 ${r} 回合 · 描述`}
                      mine={!!me && Number(seat) === me.seat}
                    />
                  );
                })
              ))}
              {outFeed.map((o) => <FeedItem key={`o${o.round}-${o.phaseLabel}`} {...o} />)}
            </div>
          </div>
        )}

        {tab === 'rules' && (
          <div className="m-card">
            <div className="m-card__head"><span>规则速览</span></div>
            <div className="stack">
              {RULE_SNAPSHOT.map((x) => (
                <div key={x.t}>
                  <p style={{ margin: '0 0 2px', fontWeight: 600 }}>{x.t}</p>
                  <p className="t-13 muted" style={{ margin: 0, lineHeight: 1.6 }}>{x.d}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <footer className="m-actionbar">
        {(err || actError) && <Note tone="error">{err || actError}</Note>}
        {actionbar()}
      </footer>

      <nav className="m-tabbar" role="tablist" aria-label="视图切换">
        {[
          { k: 'table', t: '圆桌' },
          { k: 'feed', t: '记录' },
          { k: 'rules', t: '规则' },
        ].map((x) => (
          <button
            key={x.k}
            type="button"
            role="tab"
            className="m-tabbar__item"
            aria-selected={tab === x.k}
            onClick={() => setTab(x.k)}
          >
            {x.t}
          </button>
        ))}
      </nav>

      {sheet === 'selfkill' && (
        <div className="overlay overlay--fixed" role="alertdialog" aria-labelledby="m-selfkill">
          <div className="sheet sheet--night" style={{ width: 'calc(100% - 2 * var(--gap-3))' }}>
            <div className="row row--tight" style={{ color: 'var(--status-out)' }}>
              <IconAlert size={17} />
              <h3 id="m-selfkill" className="sheet__title" style={{ color: 'inherit', fontSize: 'calc(16px * var(--seed-type-scale))' }}>
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
            <p className="t-13" style={{ margin: 0 }}>
              仅卧底的刀人指令生效。若本席并非卧底，该指令判定为
              <b style={{ color: 'var(--status-out)' }}>自刀</b>，出局的是本席。
            </p>
            <div className="sheet__foot">
              <Button variant="outline" rounded="pill" size="lg" onClick={() => setSheet(null)}>返回</Button>
              <Button variant="destructive" rounded="pill" size="lg" onClick={confirmKill}>
                确认提交
              </Button>
            </div>
          </div>
        </div>
      )}

      {sheet === 'guess' && (
        <div className="overlay overlay--fixed" role="dialog" aria-labelledby="m-guess">
          <div className="sheet" style={{ width: 'calc(100% - 2 * var(--gap-3))' }}>
            <h3 id="m-guess" className="sheet__title" style={{ fontSize: 'calc(16px * var(--seed-type-scale))' }}>请猜出两个词</h3>
            <p className="t-13 muted" style={{ margin: 0 }}>两个词均猜中：白板单独获胜；仅猜中一个：不淘汰，本局继续。</p>
            <div className="m-stack">
              <Input value={guessA} onChange={(e) => setGuessA(e.target.value)} placeholder="请输入猜测的正常词" aria-label="猜测的正常词" maxLength={16} />
              <Input value={guessB} onChange={(e) => setGuessB(e.target.value)} placeholder="请输入猜测的卧底词" aria-label="猜测的卧底词" maxLength={16} />
            </div>
            <div className="sheet__foot">
              <Button variant="outline" rounded="pill" onClick={() => setSheet(null)}>取消</Button>
              <Button variant="primary" rounded="pill" disabled={!guessA.trim() || !guessB.trim()} onClick={sendGuess}>提交</Button>
            </div>
          </div>
        </div>
      )}

      {room.can_control && showHost && (
        <HostConsole snapshot={snapshot} act={act} onClose={() => setShowHost(false)} />
      )}

      <span aria-live="polite" className="sr-only">{meta.label}，第 {round} 回合，存活 {aliveSeats.length} 人</span>
    </div>
  );
}
