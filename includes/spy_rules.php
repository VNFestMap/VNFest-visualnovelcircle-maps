<?php
/**
 * 谁是卧底规则引擎 —— 纯函数，不碰 DB、不碰 HTTP、不碰 session。
 * [HERE] includes/spy_rules.php
 *
 * 所有判定都在这一层完成，api/spy_table.php 与 scripts/spy_worker.php 共用它，
 * 保证「主持人点结算」和「cron 到点推进」走出同一个结果。
 * 单测见 scripts/test-spy-rules.php。
 *
 * 随机性通过 $rand 回调注入，测试可传确定性生成器。
 */

namespace Spy;

const ROLE_CIVILIAN = 'civilian';
const ROLE_SPY = 'spy';
const ROLE_BLANK = 'blank';

const WIN_CIVILIAN = 'civilian';
const WIN_SPY = 'spy';
const WIN_BLANK = 'blank';
const WIN_DRAW = 'draw';

const OUT_BY_VOTE = 'vote';
const OUT_BY_KILL = 'kill';
const OUT_BY_SELF_KILL = 'self-kill';

/** 阶段顺序。'over' 是终态，不在循环里。 */
const PHASES = ['day', 'discuss', 'vote', 'night'];
const PHASE_OVER = 'over';

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 12;

const SENTENCE_MAX = 40;

/** 三档计时（秒）。描述阶段是「每人 N 秒」，其余是整阶段。 */
const TIMER_PROFILES = [
    'fast'     => ['day' => 25, 'discuss' => 90,  'vote' => 40, 'night' => 30],
    'standard' => ['day' => 40, 'discuss' => 180, 'vote' => 60, 'night' => 45],
    'slow'     => ['day' => 60, 'discuss' => 300, 'vote' => 90, 'night' => 60],
];
const DEFAULT_TIMER_PROFILE = 'standard';

/** 默认身份分配表：人数 => [好人, 卧底, 白板] */
const DEFAULT_DISTRIBUTION = [
    4  => [3, 1, 0],
    5  => [4, 1, 0],
    6  => [4, 1, 1],
    7  => [5, 1, 1],
    8  => [5, 2, 1],
    9  => [6, 2, 1],
    10 => [7, 2, 1],
    11 => [7, 2, 2],
    12 => [8, 2, 2],
];

/**
 * 按实际人数取默认配额。这就是「配额自适应」的全部实现：
 * 开局人数不足房间上限时，直接按实际人数查表，不补空位。
 */
function default_distribution(int $players): ?array {
    if (!isset(DEFAULT_DISTRIBUTION[$players])) return null;
    [$c, $s, $b] = DEFAULT_DISTRIBUTION[$players];
    return ['civilian' => $c, 'spy' => $s, 'blank' => $b];
}

/** 校验主持人手改的配额。返回 null 表示合法，否则返回可直接回给前端的中文原因。 */
function validate_distribution(int $players, array $dist): ?string {
    $c = (int)($dist['civilian'] ?? 0);
    $s = (int)($dist['spy'] ?? 0);
    $b = (int)($dist['blank'] ?? 0);
    if ($c + $s + $b !== $players) return '身份人数之和必须等于开局人数';
    if ($s < 1) return '至少 1 名卧底';
    if ($c < 1) return '至少 1 名好人';
    if ($b < 0) return '白板人数不能为负';
    if ($c + $b > $players) return '身份人数超出开局人数';
    return null;
}

/** 开局门槛。返回 null 表示可以开，否则返回原因。 */
function can_start(int $joined, int $cap): ?string {
    if ($joined < MIN_PLAYERS) return '至少 ' . MIN_PLAYERS . ' 人才能开局';
    if ($joined > $cap) return '入座人数超过房间上限';
    return null;
}

/**
 * 发身份。$seats 是参与开局的座位号列表。
 * $rand 是返回 [0,1) 的回调，测试可注入。
 * 返回 [seat => role]。
 */
function deal_roles(array $seats, array $dist, ?callable $rand = null): array {
    $rand = $rand ?? static fn(): float => mt_rand() / mt_getrandmax();

    $pool = [];
    for ($i = 0; $i < (int)($dist['civilian'] ?? 0); $i++) $pool[] = ROLE_CIVILIAN;
    for ($i = 0; $i < (int)($dist['spy'] ?? 0); $i++)      $pool[] = ROLE_SPY;
    for ($i = 0; $i < (int)($dist['blank'] ?? 0); $i++)    $pool[] = ROLE_BLANK;

    $seats = array_values($seats);
    // Fisher-Yates 两边都洗，避免「座位顺序」和「身份顺序」相关性。
    shuffle_with($seats, $rand);
    shuffle_with($pool, $rand);

    $dealt = [];
    foreach ($seats as $i => $seat) {
        $dealt[$seat] = $pool[$i] ?? ROLE_CIVILIAN;
    }
    ksort($dealt);
    return $dealt;
}

/** 用注入的随机源做 Fisher-Yates。 */
function shuffle_with(array &$arr, callable $rand): void {
    for ($i = count($arr) - 1; $i > 0; $i--) {
        $j = (int)floor($rand() * ($i + 1));
        if ($j > $i) $j = $i;
        [$arr[$i], $arr[$j]] = [$arr[$j], $arr[$i]];
    }
}

/**
 * 某回合开始时的存活判定。
 *
 * 出局发生在回合内：第 R 回合被投出或被刀的人，仍然参与第 R 回合的发言与投票，
 * 从第 R+1 回合起不再存活。所以这里是 >= 而不是 >。
 */
function alive_at_round(?int $outRound, int $round): bool {
    return $outRound === null || $outRound >= $round;
}

/** 当前存活（不再区分回合）。 */
function is_alive(?int $outRound): bool {
    return $outRound === null;
}

/** 描述阶段的发言顺序：该回合存活者按座位号升序。 */
function speaking_order(array $seats, int $round): array {
    $order = [];
    foreach ($seats as $seat) {
        if (alive_at_round($seat['outRound'] ?? null, $round)) {
            $order[] = (int)$seat['seat'];
        }
    }
    sort($order);
    return $order;
}

/**
 * 白天计票。
 *
 * $ballots: [['from' => int, 'to' => int|null]]  to 为 null 表示弃权
 * $targets: 可被投票的存活座位号列表
 *
 * 平票只在「最高票 >= 1 且并列」时成立 —— 原型把 0:0 也判成平票，
 * 全员弃权会被错误地当成需要主持人裁决。
 */
function tally_votes(array $ballots, array $targets): array {
    $targets = array_values(array_map('intval', $targets));
    $counts = array_fill_keys($targets, 0);
    $abstain = 0;
    $cast = 0;

    foreach ($ballots as $ballot) {
        $to = $ballot['to'] ?? null;
        $from = (int)($ballot['from'] ?? 0);
        if ($to === null || $to === '') { $abstain++; continue; }
        $to = (int)$to;
        // 自投与投给不在场者一律记为无效票，不计入任何座位。
        if ($to === $from || !isset($counts[$to])) continue;
        $counts[$to]++;
        $cast++;
    }

    $rows = [];
    foreach ($counts as $seat => $votes) {
        $rows[] = ['seat' => $seat, 'votes' => $votes];
    }
    usort($rows, static fn(array $a, array $b): int => $b['votes'] <=> $a['votes'] ?: $a['seat'] <=> $b['seat']);

    $top = $rows[0]['votes'] ?? 0;
    $leaders = array_values(array_column(array_filter($rows, static fn($r) => $r['votes'] === $top), 'seat'));
    sort($leaders);

    $tie = $top >= 1 && count($leaders) > 1;

    return [
        'rows'      => $rows,
        'abstain'   => $abstain,
        'cast'      => $cast,
        'top'       => $top,
        'leaders'   => $leaders,
        'tie'       => $tie,
        'eliminated' => ($top >= 1 && !$tie) ? $leaders[0] : null,
    ];
}

/**
 * 夜晚结算。
 *
 * $actions: [['seat' => int, 'role' => string, 'target' => int|null]]
 * $targets: 可被刀的存活座位号
 *
 * 只有存活卧底提交的刀计入众数；非卧底提交了有效目标即判**提交者本人**自刀
 * （对应原型里 7 号平民交刀、7 号自己出局那条）。卧底之间意见不一致 = 平安夜。
 */
function resolve_night(array $actions, array $targets): array {
    $targets = array_values(array_map('intval', $targets));
    $knifeTally = [];
    $selfKills = [];
    $notes = [];

    foreach ($actions as $action) {
        $seat = (int)($action['seat'] ?? 0);
        $role = (string)($action['role'] ?? '');
        $target = $action['target'] ?? null;

        if ($target === null || $target === '') {
            $notes[] = sprintf('%d 号本回合选择不刀人。', $seat);
            continue;
        }
        $target = (int)$target;

        if (!in_array($target, $targets, true)) {
            $notes[] = sprintf('%d 号指向的 %d 号已不在场，该刀作废。', $seat, $target);
            continue;
        }

        if ($role !== ROLE_SPY) {
            // 自刀落在提交者自己身上，不是他指向的人 —— 别人不为这次误操作陪葬。
            $selfKills[] = $seat;
            $notes[] = sprintf('%d 号不具备刀人资格，其提交判定为 %d 号自刀。', $seat, $seat);
            continue;
        }
        $knifeTally[$target] = ($knifeTally[$target] ?? 0) + 1;
    }

    $killed = [];
    if ($knifeTally) {
        arsort($knifeTally);
        $max = reset($knifeTally);
        $leaders = array_keys(array_filter($knifeTally, static fn($v) => $v === $max));
        if (count($leaders) === 1) {
            $killed = [(int)$leaders[0]];
            $notes[] = sprintf('夜晚共识：刀 %d 号。', $killed[0]);
        } else {
            $notes[] = '卧底意见分裂，本夜无人被刀。';
        }
    } else {
        $notes[] = '无人提交有效目标，平安夜。';
    }

    $selfKills = array_values(array_unique(array_filter(
        $selfKills,
        static fn(int $s): bool => !in_array($s, $killed, true)
    )));

    return [
        'killed'    => $killed,
        'selfKills' => $selfKills,
        'peace'     => !$killed && !$selfKills,
        'notes'     => $notes,
    ];
}

/** 词面归一：全角转半角、去空白、统一小写，避免「轻 小说」和「轻小说」判成不同。 */
function normalize_word(string $w): string {
    $w = trim($w);
    if (function_exists('mb_convert_kana')) {
        $w = mb_convert_kana($w, 'asKV', 'UTF-8');
    }
    $w = preg_replace('/\s+/u', '', $w) ?? $w;
    return function_exists('mb_strtolower') ? mb_strtolower($w, 'UTF-8') : strtolower($w);
}

/**
 * 白板猜词判定。两词全中才单独获胜，猜错不淘汰。
 * 比对是双向的：白板可能把 A 词猜成 B 词的位置，只要两个真词都说到就算中。
 */
function evaluate_blank_guess(string $guessA, string $guessB, string $civilianWord, string $spyWord): array {
    $g = [normalize_word($guessA), normalize_word($guessB)];
    $c = normalize_word($civilianWord);
    $s = normalize_word($spyWord);

    $direct = in_array($c, $g, true);
    $spied  = in_array($s, $g, true);
    $allHit = $direct && $spied;

    return [
        'hit_civilian' => $direct,
        'hit_spy'      => $spied,
        'all_hit'      => $allHit,
        'result'       => $allHit ? 'only-one' : 'miss',
    ];
}

/**
 * 胜负判定。$seats: [['seat','role','outRound']]
 *
 * 好人胜 = 卧底与白板全部出局；
 * 卧底胜 = 存活卧底数 >= 存活好人数（好人无法一次投票清场）；
 * 白板胜不在这里出，它由 evaluate_blank_guess 触发、立即结束。
 */
function evaluate_win(array $seats): array {
    $alive = ['civilian' => 0, 'spy' => 0, 'blank' => 0];
    foreach ($seats as $seat) {
        if (!is_alive($seat['outRound'] ?? null)) continue;
        $role = (string)($seat['role'] ?? '');
        if (isset($alive[$role])) $alive[$role]++;
    }

    if ($alive['spy'] === 0 && $alive['blank'] === 0) {
        if ($alive['civilian'] === 0) {
            return ['over' => true, 'winner' => WIN_DRAW, 'alive' => $alive,
                    'reason' => '场上已无存活玩家，判定和局。'];
        }
        return ['over' => true, 'winner' => WIN_CIVILIAN, 'alive' => $alive,
                'reason' => '卧底与白板已全部出局，好人阵营胜利。'];
    }

    if ($alive['spy'] > 0 && $alive['spy'] >= $alive['civilian']) {
        return ['over' => true, 'winner' => WIN_SPY, 'alive' => $alive,
                'reason' => sprintf('存活卧底 %d 人已达存活好人 %d 人，好人无法一次投票清场，卧底胜利。',
                    $alive['spy'], $alive['civilian'])];
    }

    return ['over' => false, 'winner' => null, 'alive' => $alive, 'reason' => ''];
}

/** 下一阶段的纯函数。夜晚之后进入下一回合的描述阶段。 */
function next_phase(string $phase, int $round): array {
    $idx = array_search($phase, PHASES, true);
    if ($idx === false) {
        return ['phase' => PHASE_OVER, 'round' => $round];
    }
    if ($idx === count(PHASES) - 1) {
        return ['phase' => PHASES[0], 'round' => $round + 1];
    }
    return ['phase' => PHASES[$idx + 1], 'round' => $round];
}

/**
 * 阶段时限（秒）。描述阶段是「每人 N 秒 × 存活发言人数」，其余阶段是整阶段固定值。
 * 未知阶段回落到讨论阶段时长，而不是静默变成 40 秒。
 */
function phase_seconds(string $profile, string $phase, int $aliveSpeakers = 1): int {
    $table = TIMER_PROFILES[$profile] ?? TIMER_PROFILES[DEFAULT_TIMER_PROFILE];
    $fallback = (int)($table['discuss'] ?? 180);
    $seconds = (int)($table[$phase] ?? $fallback);

    if ($phase === 'day') {
        return max(1, $seconds) * max(1, $aliveSpeakers);
    }
    return max(1, $seconds);
}

/** 供前端展示的身份标签，服务端只回 role 码，文案在前端。 */
function role_label(string $role): string {
    return [ROLE_CIVILIAN => '好人', ROLE_SPY => '卧底', ROLE_BLANK => '白板'][$role] ?? $role;
}

/** 出局方式文案。结算屏与揭示卡共用。 */
function out_label(string $by): string {
    return [
        OUT_BY_VOTE      => '投票淘汰',
        OUT_BY_KILL      => '夜晚被刀',
        OUT_BY_SELF_KILL => '夜晚自刀',
    ][$by] ?? '出局';
}
