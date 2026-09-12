/* ==========================================================================
   谁是卧底 · 共享常量（此前散在 gameMock 与各屏里的三份文案合并于此）
   [HERE] Game/spy-react/src/data/constants.js
   服务端只发 role 码与 out_by 码，文案全部在前端。
   ========================================================================== */

export const PLAYER_RANGE = { min: 4, max: 12 };

export const ROLE_LABEL = {
  civilian: '好人',
  spy: '卧底',
  blank: '白板',
  host: '主持人',
};

export const OUT_LABEL = {
  vote: '投票出局',
  kill: '夜晚出局',
  'self-kill': '夜晚自刀出局',
};

export const WIN_COPY = {
  civilian: { title: '好人阵营获胜', reason: '卧底与白板已全部出局，场上仅存好人。' },
  spy: { title: '卧底阵营获胜', reason: '坚持到好人无法在一次投票中同时淘汰卧底与白板。' },
  blank: { title: '白板获胜', reason: '同时猜中正常词与卧底词，立即单独获胜。' },
};

export const PHASE_META = {
  day: { label: '描述', full: '按座位号顺序依次发言，每人提交一句。', ink: 'var(--phase-day)' },
  discuss: { label: '讨论', full: '自由讨论，举手排队后由主持人点名。', ink: 'var(--phase-discuss)' },
  vote: { label: '投票', full: '点击座位进行投票，票数自动统计。', ink: 'var(--phase-vote)' },
  night: { label: '夜晚', full: '全员闭眼，所有座位均可提交刀人指令。', ink: 'var(--phase-night)' },
  over: { label: '结算', full: '本局已结束', ink: 'var(--phase-discuss)' },
};

export const PHASE_ORDER = ['day', 'discuss', 'vote', 'night'];

export const TIMER_PROFILES = {
  fast: { label: '快节奏' },
  standard: { label: '标准' },
  slow: { label: '慢节奏' },
};

/* 服务端配置了身份配额时用 room.distribution，这里只做兜底显示。 */
export function distributionOf(room, cap) {
  if (room && room.distribution) return room.distribution;
  const n = Math.max(4, Math.min(12, cap || 8));
  const table = {
    4: [3, 1, 0], 5: [4, 1, 0], 6: [4, 1, 1], 7: [5, 1, 1], 8: [5, 2, 1],
    9: [6, 2, 1], 10: [7, 2, 1], 11: [7, 2, 2], 12: [8, 2, 2],
  };
  const [c, s, b] = table[n] || table[8];
  return { civilian: c, spy: s, blank: b };
}

export const RULE_SNAPSHOT = [
  {
    t: '身份与词对分配',
    d: '每位玩家只能看到自己所持有的一个词，且不知道自己属于哪一方。所持有的词与多数人的描述不符者即为卧底，需要自行推断。白板不持有任何词，需要自行猜出两个词。只有主持人掌握全部身份。',
  },
  {
    t: '白天流程',
    d: '全程以文字发言。描述阶段按座位号顺序，每人只提交一句与自己词相关的描述，且不得包含词本身；随后每人投票一次，票数最高者出局，平票由主持人裁决。',
  },
  {
    t: '夜晚与自刀',
    d: '全员闭眼，任何座位都可提交刀人指令，但只有卧底的指令生效；好人或白板提交将判定为自刀，本人出局。',
  },
  {
    t: '胜负条件',
    d: '好人淘汰全部卧底与白板即获胜；卧底坚持到好人无法一次投票清场即获胜；白板同时猜中两个词则立即单独获胜。',
  },
];
