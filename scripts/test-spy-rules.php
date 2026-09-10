<?php
/**
 * 谁是卧底规则引擎单测 —— 纯 PHP，不起 HTTP、不连 DB。
 * [HERE] scripts/test-spy-rules.php
 *
 * 用法： php scripts/test-spy-rules.php
 * 退出码非 0 表示有断言失败。
 */

declare(strict_types=1);

require __DIR__ . '/../includes/spy_rules.php';

use function Spy\default_distribution;
use function Spy\validate_distribution;
use function Spy\can_start;
use function Spy\deal_roles;
use function Spy\alive_at_round;
use function Spy\is_alive;
use function Spy\speaking_order;
use function Spy\tally_votes;
use function Spy\resolve_night;
use function Spy\evaluate_blank_guess;
use function Spy\evaluate_win;
use function Spy\next_phase;
use function Spy\phase_seconds;
use function Spy\role_label;
use function Spy\out_label;

$passed = 0;
$failures = [];

function check(string $name, bool $ok, string $detail = ''): void {
    global $passed, $failures;
    if ($ok) { $passed++; return; }
    $failures[] = $name . ($detail !== '' ? ' -> ' . $detail : '');
}

function eq(string $name, $expected, $actual): void {
    $ok = $expected === $actual;
    check($name, $ok, $ok ? '' : 'expected ' . var_export($expected, true) . ', got ' . var_export($actual, true));
}

/** 确定性随机源：按给定序列循环取值。 */
function seq_rand(array $values): callable {
    $i = 0;
    return function () use ($values, &$i): float {
        $v = $values[$i % count($values)];
        $i++;
        return $v;
    };
}

/* =====================================================================
   1. 配额表与自适应
   ===================================================================== */

$expectedTable = [
    4  => ['civilian' => 3, 'spy' => 1, 'blank' => 0],
    5  => ['civilian' => 4, 'spy' => 1, 'blank' => 0],
    6  => ['civilian' => 4, 'spy' => 1, 'blank' => 1],
    7  => ['civilian' => 5, 'spy' => 1, 'blank' => 1],
    8  => ['civilian' => 5, 'spy' => 2, 'blank' => 1],
    9  => ['civilian' => 6, 'spy' => 2, 'blank' => 1],
    10 => ['civilian' => 7, 'spy' => 2, 'blank' => 1],
    11 => ['civilian' => 7, 'spy' => 2, 'blank' => 2],
    12 => ['civilian' => 8, 'spy' => 2, 'blank' => 2],
];
foreach ($expectedTable as $n => $dist) {
    eq("配额表 {$n} 人", $dist, default_distribution($n));
}
eq('3 人不在表内', null, default_distribution(3));
eq('13 人不在表内', null, default_distribution(13));

// 自适应：8 人房只来 5 人，应按 5 人配额而不是查 8。
eq('8 人房实际 5 人时按 5 人配额', ['civilian' => 4, 'spy' => 1, 'blank' => 0], default_distribution(5));

foreach ($expectedTable as $n => $dist) {
    check("配额表 {$n} 人之和等于人数", array_sum($dist) === $n);
}

/* =====================================================================
   2. 配额校验
   ===================================================================== */

eq('合法默认配额通过', null, validate_distribution(8, ['civilian' => 5, 'spy' => 2, 'blank' => 1]));
check('人数之和不符被拒', validate_distribution(8, ['civilian' => 5, 'spy' => 2, 'blank' => 0]) !== null);
check('零卧底被拒', validate_distribution(8, ['civilian' => 7, 'spy' => 0, 'blank' => 1]) !== null);
check('负白板被拒', validate_distribution(8, ['civilian' => 7, 'spy' => 1, 'blank' => -1]) !== null);
eq('4 人双卧底无白板合法', null, validate_distribution(4, ['civilian' => 2, 'spy' => 2, 'blank' => 0]));
check('超出开局人数被拒', validate_distribution(5, ['civilian' => 4, 'spy' => 1, 'blank' => 1]) !== null);

/* =====================================================================
   3. 开局门槛
   ===================================================================== */

check('3 人不能开局', can_start(3, 8) !== null);
eq('4 人可以开局', null, can_start(4, 8));
eq('5 人可开 8 人房（不满员）', null, can_start(5, 8));
check('超过上限不能开局', can_start(9, 8) !== null);

/* =====================================================================
   4. 发身份
   ===================================================================== */

$seats8 = [1, 2, 3, 4, 5, 6, 7, 8];
$dist8 = default_distribution(8);
$dealt = deal_roles($seats8, $dist8, seq_rand([0.0]));

$counts = array_count_values($dealt);
eq('发身份：好人数', $dist8['civilian'], (int)($counts['civilian'] ?? 0));
eq('发身份：卧底数', $dist8['spy'], (int)($counts['spy'] ?? 0));
eq('发身份：白板数', $dist8['blank'], (int)($counts['blank'] ?? 0));
eq('发身份：每个座位都有身份', 8, count($dealt));
eq('发身份：座位号有序', array_keys($dealt), [1, 2, 3, 4, 5, 6, 7, 8]);
check('发身份：卧底与白板都发到了词位（role 值合法）',
    !array_diff(array_values($dealt), ['civilian', 'spy', 'blank']));

// 注入不同随机源应产出不同分布，但配额恒定。
$a = deal_roles($seats8, $dist8, seq_rand([0.01, 0.99, 0.02, 0.98, 0.03, 0.97, 0.04, 0.96]));
$b = deal_roles($seats8, $dist8, seq_rand([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]));
$ca = array_count_values($a); $cb = array_count_values($b);
eq('随机源 A 卧底数', 2, (int)$ca['spy']);
eq('随机源 B 卧底数', 2, (int)$cb['spy']);

// 4 人局无白板。
$d4 = deal_roles([1, 2, 3, 4], default_distribution(4), seq_rand([0.3]));
check('4 人局没有白板', !in_array('blank', $d4, true));
eq('4 人局恰好 1 卧底', 1, count(array_keys($d4, 'spy')));

/* =====================================================================
   5. 存活与发言顺序（修掉原型的 outRound >= round）
   ===================================================================== */

eq('未被淘汰者始终存活', true, alive_at_round(null, 3));
eq('第 2 回合出局者在第 2 回合仍算活着', true, alive_at_round(2, 2));
eq('第 2 回合出局者在第 3 回合不再存活', false, alive_at_round(2, 3));
eq('第 1 回合出局者在第 1 回合算活着', true, alive_at_round(1, 1));
eq('is_alive：未出局', true, is_alive(null));
eq('is_alive：已出局', false, is_alive(4));

$seats = [
    ['seat' => 1, 'outRound' => null],
    ['seat' => 2, 'outRound' => 1],
    ['seat' => 3, 'outRound' => null],
    ['seat' => 4, 'outRound' => 2],
];
eq('第 1 回合发言顺序（含本回合将出局者）', [1, 2, 3, 4], speaking_order($seats, 1));
eq('第 2 回合发言顺序', [1, 3, 4], speaking_order($seats, 2));
eq('第 3 回合发言顺序', [1, 3], speaking_order($seats, 3));

/* =====================================================================
   6. 白天计票
   ===================================================================== */

$targets = [1, 3, 4, 5];

$r = tally_votes([
    ['from' => 1, 'to' => 3], ['from' => 4, 'to' => 3],
    ['from' => 5, 'to' => 1], ['from' => 3, 'to' => null],
], $targets);
eq('计票：最高票出局', 3, $r['eliminated']);
eq('计票：3 号得 2 票', 2, $r['rows'][0]['votes']);
eq('计票：弃权计数', 1, $r['abstain']);
eq('计票：有效票数', 3, $r['cast']);
eq('计票：非平票', false, $r['tie']);

$r = tally_votes([['from' => 1, 'to' => 3], ['from' => 4, 'to' => 5]], $targets);
eq('平票：不出局', null, $r['eliminated']);
eq('平票：tie 为真', true, $r['tie']);
eq('平票：并列者按座位升序', [3, 5], $r['leaders']);

// 原型把 0:0 也判成平票，这里必须不是。
$r = tally_votes([['from' => 1, 'to' => null], ['from' => 3, 'to' => null]], $targets);
eq('全员弃权不算平票', false, $r['tie']);
eq('全员弃权不出局', null, $r['eliminated']);
eq('全员弃权弃权数为 2', 2, $r['abstain']);

$r = tally_votes([['from' => 1, 'to' => 2]], $targets);
eq('投给不在场者作废', 0, $r['cast']);
eq('投给不在场者不出局', null, $r['eliminated']);

$r = tally_votes([['from' => 1, 'to' => 1]], $targets);
eq('自投作废', 0, $r['cast']);

$r = tally_votes([], $targets);
eq('无票：rows 覆盖全部可投座位', 4, count($r['rows']));
eq('无票：tie 为假', false, $r['tie']);
eq('无票：rows 按座位升序（票数全 0）', [1, 3, 4, 5], array_column($r['rows'], 'seat'));

/* =====================================================================
   7. 夜晚结算
   ===================================================================== */

$alive = [1, 2, 3, 4];

$n = resolve_night([
    ['seat' => 2, 'role' => 'spy', 'target' => 3],
    ['seat' => 4, 'role' => 'spy', 'target' => 3],
], $alive);
eq('卧底共识刀 3 号', [3], $n['killed']);
eq('有刀则非平安夜', false, $n['peace']);
eq('无自刀', [], $n['selfKills']);

$n = resolve_night([
    ['seat' => 2, 'role' => 'spy', 'target' => 3],
    ['seat' => 4, 'role' => 'spy', 'target' => 1],
], $alive);
eq('卧底意见分裂：平安夜', [], $n['killed']);
eq('意见分裂 peace', true, $n['peace']);

$n = resolve_night([['seat' => 2, 'role' => 'spy', 'target' => null]], $alive);
eq('卧底选择不刀：平安夜', true, $n['peace']);

// 非卧底交了有效目标 -> 判**提交者本人**自刀，被指向的人不受影响。
$n = resolve_night([
    ['seat' => 2, 'role' => 'spy', 'target' => 3],
    ['seat' => 4, 'role' => 'civilian', 'target' => 2],
], $alive);
eq('卧底的刀正常生效', [3], $n['killed']);
eq('平民交刀判自己自刀', [4], $n['selfKills']);
eq('被平民指向的卧底不受影响', false,
    in_array(2, $n['killed'], true) || in_array(2, $n['selfKills'], true));

$n = resolve_night([['seat' => 1, 'role' => 'blank', 'target' => 3]], $alive);
eq('白板交刀判自己自刀', [1], $n['selfKills']);
eq('白板交刀不算卧底刀', [], $n['killed']);

$n = resolve_night([['seat' => 2, 'role' => 'spy', 'target' => 9]], $alive);
eq('指向不在场者作废', true, $n['peace']);

$n = resolve_night([], $alive);
eq('无人提交：平安夜', true, $n['peace']);

/* =====================================================================
   8. 白板猜词
   ===================================================================== */

$g = evaluate_blank_guess('视觉小说', '轻小说', '视觉小说', '轻小说');
eq('两词全中', true, $g['all_hit']);
eq('全中结果 only-one', 'only-one', $g['result']);

$g = evaluate_blank_guess('轻小说', '视觉小说', '视觉小说', '轻小说');
eq('猜词顺序颠倒仍算全中', true, $g['all_hit']);

$g = evaluate_blank_guess('视觉小说', '推理小说', '视觉小说', '轻小说');
eq('只中一个不算', false, $g['all_hit']);
eq('半中结果 miss', 'miss', $g['result']);
eq('半中：命中好人词', true, $g['hit_civilian']);
eq('半中：未命中卧底词', false, $g['hit_spy']);

$g = evaluate_blank_guess('  视觉小说 ', '轻　小说', '视觉小说', '轻小说');
eq('空白与全角空格归一后全中', true, $g['all_hit']);

$g = evaluate_blank_guess('视觉小说', '视觉小说', '视觉小说', '轻小说');
eq('重复猜同一个词不算全中', false, $g['all_hit']);

$g = evaluate_blank_guess('', '', '视觉小说', '轻小说');
eq('空输入不算全中', false, $g['all_hit']);

/* =====================================================================
   9. 胜负判定
   ===================================================================== */

$w = evaluate_win([
    ['seat' => 1, 'role' => 'civilian', 'outRound' => null],
    ['seat' => 2, 'role' => 'spy', 'outRound' => 2],
    ['seat' => 3, 'role' => 'civilian', 'outRound' => null],
]);
eq('卧底全灭但无白板：好人胜', 'civilian', $w['winner']);

$w = evaluate_win([
    ['seat' => 1, 'role' => 'civilian', 'outRound' => null],
    ['seat' => 2, 'role' => 'spy', 'outRound' => 2],
    ['seat' => 4, 'role' => 'blank', 'outRound' => null],
]);
eq('白板仍在场时好人不胜', false, $w['over']);

$w = evaluate_win([
    ['seat' => 1, 'role' => 'civilian', 'outRound' => 3],
    ['seat' => 2, 'role' => 'spy', 'outRound' => 2],
    ['seat' => 4, 'role' => 'blank', 'outRound' => 1],
]);
eq('卧底与白板全灭且好人也全灭：和局', 'draw', $w['winner']);

$w = evaluate_win([
    ['seat' => 1, 'role' => 'civilian', 'outRound' => null],
    ['seat' => 2, 'role' => 'spy', 'outRound' => null],
]);
eq('卧底数等于好人数：卧底胜', 'spy', $w['winner']);

$w = evaluate_win([
    ['seat' => 1, 'role' => 'civilian', 'outRound' => null],
    ['seat' => 2, 'role' => 'civilian', 'outRound' => null],
    ['seat' => 3, 'role' => 'spy', 'outRound' => null],
]);
eq('卧底少于好人：未结束', false, $w['over']);

$w = evaluate_win([
    ['seat' => 1, 'role' => 'civilian', 'outRound' => null],
    ['seat' => 2, 'role' => 'spy', 'outRound' => null],
    ['seat' => 4, 'role' => 'blank', 'outRound' => null],
]);
eq('白板在场时卧底数等于好人数仍判卧底胜', 'spy', $w['winner']);

$w = evaluate_win([
    ['seat' => 1, 'role' => 'civilian', 'outRound' => null],
    ['seat' => 2, 'role' => 'civilian', 'outRound' => null],
    ['seat' => 3, 'role' => 'civilian', 'outRound' => null],
    ['seat' => 4, 'role' => 'blank', 'outRound' => null],
]);
eq('只剩好人与白板：未结束（白板需被投出或猜词）', false, $w['over']);

$w = evaluate_win([
    ['seat' => 1, 'role' => 'civilian', 'outRound' => null],
    ['seat' => 2, 'role' => 'spy', 'outRound' => null],
]);
eq('胜负原因可展示', true, $w['reason'] !== '');

/* =====================================================================
   10. 阶段流转
   ===================================================================== */

eq('描述 -> 讨论', ['phase' => 'discuss', 'round' => 1], next_phase('day', 1));
eq('讨论 -> 投票', ['phase' => 'vote', 'round' => 1], next_phase('discuss', 1));
eq('投票 -> 夜晚', ['phase' => 'night', 'round' => 1], next_phase('vote', 1));
$np = next_phase('night', 1);
eq('夜晚 -> 下一回合描述', 'day', $np['phase']);
eq('夜晚后回合 +1', 2, $np['round']);
eq('未知阶段 -> over', 'over', next_phase('bogus', 3)['phase']);
eq('over 阶段保持回合', 3, next_phase('over', 3)['round']);

/* =====================================================================
   11. 计时
   ===================================================================== */

eq('标准档描述每人 40 秒', 40, phase_seconds('standard', 'day', 1));
eq('标准档描述 5 人 = 200 秒', 200, phase_seconds('standard', 'day', 5));
eq('标准档讨论 180 秒', 180, phase_seconds('standard', 'discuss', 5));
eq('标准档投票 60 秒', 60, phase_seconds('standard', 'vote'));
eq('标准档夜晚 45 秒', 45, phase_seconds('standard', 'night'));
eq('快档描述 25 秒', 25, phase_seconds('fast', 'day', 1));
eq('慢档讨论 300 秒', 300, phase_seconds('slow', 'discuss'));
eq('未知档位回落标准档', 180, phase_seconds('bogus', 'discuss'));
eq('未知阶段回落讨论时长', 180, phase_seconds('standard', 'bogus'));
eq('0 个存活发言者至少给 1 人份', 40, phase_seconds('standard', 'day', 0));
eq('负数存活发言者不为负', 40, phase_seconds('standard', 'day', -3));

/* =====================================================================
   12. 文案
   ===================================================================== */

eq('身份标签：好人', '好人', role_label('civilian'));
eq('身份标签：卧底', '卧底', role_label('spy'));
eq('身份标签：白板', '白板', role_label('blank'));
eq('身份标签：未知原样返回', 'host', role_label('host'));
eq('出局标签：投票', '投票淘汰', out_label('vote'));
eq('出局标签：被刀', '夜晚被刀', out_label('kill'));
eq('出局标签：自刀', '夜晚自刀', out_label('self-kill'));
eq('出局标签：未知', '出局', out_label('bogus'));

/* =====================================================================
   汇总
   ===================================================================== */

$total = $passed + count($failures);
echo "spy rules: {$total} assertions, {$passed} passed\n";
if ($failures) {
    echo "\nFAILURES:\n";
    foreach ($failures as $f) echo "  - {$f}\n";
    exit(1);
}
echo "spy rules: all green\n";
exit(0);
