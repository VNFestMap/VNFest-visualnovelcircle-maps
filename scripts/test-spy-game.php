<?php
/**
 * 谁是卧底共享层集成测试（SQLite 方言）。
 * [HERE] scripts/test-spy-game.php
 *
 * 用法： php scripts/test-spy-game.php
 *
 * 覆盖 includes/spy_game.php 的命令层与投影层：建房入座、开局发牌、
 * 描述/投票/夜晚/平票裁决的完整流转、白板猜词、整局驱动到分出胜负、
 * rev 增量、cron 超时推进、回收与级联、越权。
 *
 * 最重要的一组断言是「泄露检查」。玩法的前提是卧底不知道自己是谁，
 * 所以玩家快照里不能出现他人的身份，也不能出现自己拿不到的那个词。
 * 为了让这类断言可以精确判定，测试把词库换成两个哨兵词 ——
 * 它们不可能因为别的原因出现在任何字段里，命中即泄露。
 *
 * 注意：MySQL 分支只在 spyUpsertSql 生成的语句字符串层面断言。
 * 真正的 MySQL 行为要在部署前拿真库跑一次 scripts/migrate.php。
 */

declare(strict_types=1);

require __DIR__ . '/../includes/spy_game.php';

use Spy as SpyRules;

const CIV_WORD = 'SENTINELCIVILIANWORD';
const SPY_WORD = 'SENTINELSPYWORD';

$passed = 0;
$failures = [];

function check(string $name, bool $ok, string $detail = ''): void
{
    global $passed, $failures;
    if ($ok) { $passed++; return; }
    $failures[] = $name . ($detail !== '' ? ' -> ' . $detail : '');
}

/*
 * 任何一条 notice/warning 都直接判失败。
 * 这次写出的一批「假绿」断言，全都是先以警告的形式冒出来的：
 * $label）被当成变量名、对 int 取下标、字符串被内部的双引号提前截断。
 * 只看最终计数会把这些一律当成通过。
 */
set_error_handler(static function (int $no, string $str, string $file, int $line): bool {
    check('PHP 诊断信息：' . $str, false, basename($file) . ':' . $line);
    return true;
});
error_reporting(E_ALL);

/** 跑一段期望成功的事务并返回数据；意外失败记一条后中止。 */
function okRun(PDO $db, callable $fn, string $label = ''): mixed
{
    $r = spyRun($db, $fn);
    if (empty($r['ok'])) {
        $key = (string)($r['key'] ?? '?');
        check('期望成功：' . ($label ?: '事务'), false, $key);
        throw new RuntimeException("unexpected SpyError: $key");
    }
    return $r['data'];
}

/** 跑一段期望失败的事务，返回错误键；若成功返回空串。 */
function failRun(PDO $db, callable $fn): string
{
    $r = spyRun($db, $fn);
    return empty($r['ok']) ? (string)$r['key'] : '';
}

function user(int $id): array
{
    return ['id' => $id, 'username' => "u$id", 'nickname' => "玩家$id", 'avatar_url' => '', 'role' => 'member'];
}

/** 建房 + 一批人入座 + 可选开局，返回房间 id。 */
function makeRoom(PDO $db, array $host, array $uids, bool $start = false, int $cap = 6): int
{
    return (int)okRun($db, static function () use ($db, $host, $uids, $start, $cap) {
        $r = spyCreateRoom($db, $host, ['cap' => $cap]);
        $roomId = (int)$r['room_id'];
        foreach ($uids as $uid) spyJoinRoom($db, $roomId, user($uid));
        if ($start) spyStart($db, $roomId);
        return $roomId;
    }, '建房');
}

function seatRoles(PDO $db, int $roomId): array
{
    $stmt = $db->prepare('SELECT seat, role FROM spy_seats WHERE room_id = ? ORDER BY seat');
    $stmt->execute([$roomId]);
    $map = [];
    foreach ($stmt->fetchAll() as $r) $map[(int)$r['seat']] = (string)$r['role'];
    return $map;
}

/** user_id 按座位号索引。 */
function userIdBySeat(PDO $db, int $roomId): array
{
    $stmt = $db->prepare('SELECT seat, user_id FROM spy_seats WHERE room_id = ? ORDER BY seat');
    $stmt->execute([$roomId]);
    $map = [];
    foreach ($stmt->fetchAll() as $r) $map[(int)$r['seat']] = (int)$r['user_id'];
    return $map;
}

function seatsWithRole(array $roles, string $role): array
{
    return array_map('intval', array_keys(array_filter($roles, static fn($r) => $r === $role)));
}

function roomRow(PDO $db, int $roomId): array
{
    $stmt = $db->prepare('SELECT * FROM spy_rooms WHERE id = ?');
    $stmt->execute([$roomId]);
    return $stmt->fetch();
}

function outRoundOf(PDO $db, int $roomId, int $seat): ?int
{
    $stmt = $db->prepare('SELECT out_round FROM spy_seats WHERE room_id = ? AND seat = ?');
    $stmt->execute([$roomId, $seat]);
    return spyOutRound($stmt->fetch()['out_round'] ?? null);
}

function outByOf(PDO $db, int $roomId, int $seat): string
{
    $stmt = $db->prepare('SELECT out_by FROM spy_seats WHERE room_id = ? AND seat = ?');
    $stmt->execute([$roomId, $seat]);
    return (string)($stmt->fetch()['out_by'] ?? '');
}

function countRows(PDO $db, string $sql, array $args = []): int
{
    $stmt = $db->prepare($sql);
    $stmt->execute($args);
    return (int)$stmt->fetchColumn();
}

/** 把描述阶段的发言按座位号顺序全部交完。 */
function speakAll(PDO $db, int $roomId, array $uidBySeat, array $seats, int $round): void
{
    foreach ($seats as $s) {
        spyRun($db, static fn() => spySubmitSentence($db, $roomId, user($uidBySeat[$s]), "第{$round}回合座位{$s}的描述"));
    }
}

/**
 * 泄露断言：玩家快照里不该有他人身份，也不该出现自己拿不到的那个词。
 *
 * @param string $allowedWord 该玩家被允许看到的词；平民/卧底各一个，白板与旁观者为空串
 */
function checkNoLeak(PDO $db, int $roomId, int $uid, string $allowedWord, string $label): void
{
    $room = roomRow($db, $roomId);
    $seat = spySeatOf($db, $roomId, $uid);
    $referee = $seat === null && (int)$room['host_user_id'] === $uid;
    $snap = spyTableSnapshot($db, $room, $seat, $referee);

    $leakRole = false;
    foreach ($snap['seats'] as $s) {
        if (array_key_exists('role', $s)) $leakRole = true;
    }
    check("{$label}：他人座位不带 role", !$leakRole);

    // 允许出现在自己 me.word 里的那个词先抹掉，剩下的 JSON 不该再含任何一个词。
    $json = json_encode($snap, JSON_UNESCAPED_UNICODE);
    $stripped = $allowedWord === '' ? $json : str_replace('"' . $allowedWord . '"', '""', $json);
    $hidden = SPY_WORD === $allowedWord ? CIV_WORD : SPY_WORD;
    check("{$label}：快照不含另一个词", !str_contains($stripped, $hidden), substr($stripped, 0, 200));
    $myRole = $snap['me']['role'] ?? null;
    check("{$label}：me 的 role 只可能是 blank",
        $myRole === null || $myRole === SpyRules\ROLE_BLANK, var_export($myRole, true));
    check("{$label}：进行中的对局不透露词对", $snap['words'] === null);
}

$db = new PDO('sqlite::memory:');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
$db->exec('PRAGMA foreign_keys = ON');

spyApplySchema($db, false);

// 换成哨兵词库：命中词面只能来自代码泄露，不可能来自巧合。
$db->exec('DELETE FROM spy_word_pairs');
$db->prepare('INSERT INTO spy_word_pairs (a, b, level, similarity, used_count, enabled) VALUES (?, ?, ?, ?, 0, 1)')
    ->execute([CIV_WORD, SPY_WORD, 'easy', 'near']);

$host = user(1);
$PLAYER_IDS = [2, 3, 4, 5, 6, 7];

/* ---------- 1. 建房与入座 ---------- */
echo "1. 建房与入座\n";

$created = okRun($db, static fn() => spyCreateRoom($db, $host, ['name' => '测试房', 'cap' => 6]), '建房');
$roomId = (int)$created['room_id'];
check('建房返回合规房号', preg_match('/^[A-Z2-9]{6}$/', (string)$created['code']) === 1, (string)$created['code']);
check('建房者默认不入座，即为裁判', $created['referee'] === true);
check('裁判座位表为空', spySeats($db, $roomId) === []);

$second = okRun($db, static fn() => spyCreateRoom($db, $host, ['name' => '第二间']), '建房2');
check('两次建号码不重复', (string)$second['code'] !== (string)$created['code']);

foreach ($PLAYER_IDS as $i => $uid) {
    okRun($db, static fn() => spyJoinRoom($db, $roomId, user($uid)), '入座');
}
$seats = spySeats($db, $roomId);
check('六个座位号连续从 1 开始', array_map('intval', array_column($seats, 'seat')) === range(1, 6),
    implode(',', array_column($seats, 'seat')));
check('入座写入昵称', (string)$seats[0]['nick'] === '玩家2');
$rejoin = okRun($db, static fn() => spyJoinRoom($db, $roomId, user(3)), '重连');
check('重复入座回到原座位而不是新建',
    (int)$rejoin['seat'] === 2 && (bool)$rejoin['rejoined'] && count(spySeats($db, $roomId)) === 6,
    json_encode($rejoin));
check('超过上限拒绝入座', failRun($db, static fn() => spyJoinRoom($db, $roomId, user(99))) === 'room_full');

/*
 * 大厅列表必须区分「我是房主」与「我已入座」：前端靠 is_host 决定
 * 点自己建的房是回房主持（不入座）还是入座参战。
 * 用独立房间，避免多出的座位影响后续小节对 $roomId 人数的前提。
 */
$lobbyRoom = makeRoom($db, $host, []);
okRun($db, static fn() => spyJoinRoom($db, $lobbyRoom, user(2)), '玩家入座');
$lobbyRowOf = static function (int $uid) use ($db, $lobbyRoom): array {
    foreach (spyLobbyRooms($db, $uid) as $row) {
        if ((int)$row['id'] === $lobbyRoom) return $row;
    }
    return [];
};
$hostRow = $lobbyRowOf(1);
check('未入座的房主 is_host 为真', ($hostRow['is_host'] ?? null) === true, json_encode($hostRow));
check('未入座的房主 mine 为假', ($hostRow['mine'] ?? null) === false, json_encode($hostRow));
$playerRow = $lobbyRowOf(2);
check('已入座的玩家 is_host 假且 mine 真',
    ($playerRow['is_host'] ?? null) === false && ($playerRow['mine'] ?? null) === true,
    json_encode($playerRow));
okRun($db, static fn() => spyJoinRoom($db, $lobbyRoom, $host), '房主入座');
$hostSeatedRow = $lobbyRowOf(1);
check('房主入座后 is_host 与 mine 同时为真',
    ($hostSeatedRow['is_host'] ?? null) === true && ($hostSeatedRow['mine'] ?? null) === true,
    json_encode($hostSeatedRow));

$codeRoom = makeRoom($db, $host, []);
okRun($db, static fn() => spyUpdateRoom($db, $codeRoom, $host, ['need_code' => 1]), '开口令');
$joinCode = (string)roomRow($db, $codeRoom)['join_code'];
check('开启口令后生成了 4 位口令', preg_match('/^\d{4}$/', $joinCode) === 1, $joinCode);
check('口令错误拒绝入座', failRun($db, static fn() => spyJoinRoom($db, $codeRoom, user(2), '0000')) === 'join_code_invalid');
$okJoin = okRun($db, static fn() => spyJoinRoom($db, $codeRoom, user(2), $joinCode), '口令入座');
check('口令正确允许入座', (int)$okJoin['seat'] === 1);
$keepCode = (string)roomRow($db, $codeRoom)['join_code'];
okRun($db, static fn() => spyUpdateRoom($db, $codeRoom, $host, ['need_code' => 1]), '再次开口令');
check('重复开启口令不换码', (string)roomRow($db, $codeRoom)['join_code'] === $keepCode);

/* ---------- 2. 开局与发牌 ---------- */
echo "2. 开局与发牌\n";

$smallRoom = makeRoom($db, $host, [2, 3, 4]);
check('不足 4 人不能开局', failRun($db, static fn() => spyHostStart($db, $smallRoom, $host)) === 'players_not_enough');

$started = okRun($db, static fn() => spyHostStart($db, $roomId, $host), '开局');
check('开局人数为 6', (int)$started['players'] === 6);
check('6 人默认配额 4/1/1',
    $started['distribution'] === ['civilian' => 4, 'spy' => 1, 'blank' => 1],
    json_encode($started['distribution']));

$roles = seatRoles($db, $roomId);
check('每个座位都发了身份', count(array_filter($roles, static fn($r) => $r !== '')) === 6);
check('身份数量与配额一致',
    count(seatsWithRole($roles, SpyRules\ROLE_CIVILIAN)) === 4
    && count(seatsWithRole($roles, SpyRules\ROLE_SPY)) === 1
    && count(seatsWithRole($roles, SpyRules\ROLE_BLANK)) === 1,
    json_encode($roles));

$room = roomRow($db, $roomId);
check('开局进入描述阶段第 1 回合', (string)$room['phase'] === 'day' && (int)$room['round'] === 1);
check('描述阶段有截止时间', (int)$room['deadline_at'] > spyNow());
check('首位发言人是 1 号', (int)$room['speaker_seat'] === 1);
check('词对已发放', spyWordPair($db, $roomId) !== null);
check('词库 used_count 自增', countRows($db, 'SELECT used_count FROM spy_word_pairs WHERE a = ?', [CIV_WORD]) === 1);
check('开局后 joined 与实际座位数一致', (int)roomRow($db, $roomId)['joined'] === 6);

// 房主手改配额且与人数相符时应当采纳，而不是套用默认表。
$customRoom = makeRoom($db, $host, $PLAYER_IDS);
okRun($db, static fn() => spyUpdateRoom($db, $customRoom, $host,
    ['dist_civilian' => 3, 'dist_spy' => 2, 'dist_blank' => 1]), '自定义配额');
$custom = okRun($db, static fn() => spyHostStart($db, $customRoom, $host), '自定义开局');
check('与人数相符的手改配额被采纳',
    $custom['distribution'] === ['civilian' => 3, 'spy' => 2, 'blank' => 1],
    json_encode($custom['distribution']));
$customRoles = seatRoles($db, $customRoom);
check('双卧底局发出两个卧底', count(seatsWithRole($customRoles, SpyRules\ROLE_SPY)) === 2);
check('与人数不符的配额被拒', failRun($db, static fn() => spyUpdateRoom($db, $codeRoom, $host,
    ['dist_civilian' => 9, 'dist_spy' => 1, 'dist_blank' => 1])) === 'distribution_invalid');

/* ---------- 3. 泄露检查（核心） ---------- */
echo "3. 泄露检查\n";

$uidBySeat = userIdBySeat($db, $roomId);
$spySeat = seatsWithRole($roles, SpyRules\ROLE_SPY)[0];
$blankSeat = seatsWithRole($roles, SpyRules\ROLE_BLANK)[0];
$civSeat = seatsWithRole($roles, SpyRules\ROLE_CIVILIAN)[0];

checkNoLeak($db, $roomId, (int)$uidBySeat[$civSeat], CIV_WORD, '平民');
checkNoLeak($db, $roomId, (int)$uidBySeat[$spySeat], SPY_WORD, '卧底');
checkNoLeak($db, $roomId, (int)$uidBySeat[$blankSeat], '', '白板');
// 首位座位身份是随机的，允许的词跟着身份走；断言的是「不泄露另一个词」。
$firstSeatNo = (int)array_key_first($uidBySeat);
$firstAllowed = $roles[$firstSeatNo] === SpyRules\ROLE_SPY ? SPY_WORD
    : ($roles[$firstSeatNo] === SpyRules\ROLE_BLANK ? '' : CIV_WORD);
checkNoLeak($db, $roomId, (int)$uidBySeat[$firstSeatNo], $firstAllowed, '首位座位');
checkNoLeak($db, $roomId, 99, '', '旁观者');

// 卧底与平民的 me 必须形状一致，否则「我为什么没有 role」本身就是泄露。
$civSnap = spyTableSnapshot($db, roomRow($db, $roomId), spySeatOf($db, $roomId, (int)$uidBySeat[$civSeat]));
$spySnap = spyTableSnapshot($db, roomRow($db, $roomId), spySeatOf($db, $roomId, (int)$uidBySeat[$spySeat]));
check('平民与卧底的 me 字段集合完全相同',
    array_diff_key($civSnap['me'], $spySnap['me']) === [] && array_diff_key($spySnap['me'], $civSnap['me']) === [],
    implode('/', array_keys($civSnap['me'])) . ' vs ' . implode('/', array_keys($spySnap['me'])));
check('平民拿到好人词', (string)$civSnap['me']['word'] === CIV_WORD);
check('卧底拿到卧底词', (string)$spySnap['me']['word'] === SPY_WORD);
check('白板没有词但知道自己身份',
    ($b = spyTableSnapshot($db, roomRow($db, $roomId), spySeatOf($db, $roomId, (int)$uidBySeat[$blankSeat])))['me']['word'] === ''
    && $b['me']['role'] === SpyRules\ROLE_BLANK);
check('白板被允许立即猜词', $b['me']['can_guess'] === true);
check('双卧底局里卧底互相不认识',
    !str_contains(json_encode($spySnap, JSON_UNESCAPED_UNICODE), 'partner'));
check('裁判看得到完整词对', spyTableSnapshot($db, roomRow($db, $roomId), null, true)['words']['spy_word'] === SPY_WORD);
check('裁判（未入座的房主）掌握全部身份',
    array_key_exists('role', spyTableSnapshot($db, roomRow($db, $roomId), null, true)['seats'][0]));

// 房主一旦入座就降级为普通玩家，否则「主持人掌握全部身份」会退化成「入场的主持人必胜」。
$hostRoom = makeRoom($db, $host, $PLAYER_IDS, false, 8);
$hostJoined = okRun($db, static fn() => spyJoinRoom($db, $hostRoom, $host), '房主入座');
okRun($db, static fn() => spyStart($db, $hostRoom), '房主房开局');
check('房主入座后不再是裁判', (bool)$hostJoined['rejoined'] === false && (int)$hostJoined['seat'] === 7);
check('入座的房主看不到任何身份',
    !array_key_exists('role', spyTableSnapshot($db, roomRow($db, $hostRoom), spySeatOf($db, $hostRoom, 1))['seats'][0]));
check('入座的房主也看不到词对',
    spyTableSnapshot($db, roomRow($db, $hostRoom), spySeatOf($db, $hostRoom, 1))['words'] === null);

/* ---------- 4. 描述阶段 ---------- */
echo "4. 描述阶段\n";

check('未到发言顺序不能交卷', failRun($db, static fn() => spySubmitSentence($db, $roomId, user((int)$uidBySeat[3]), '抢先说话')) === 'not_your_turn');
check('描述不能为空', failRun($db, static fn() => spySubmitSentence($db, $roomId, user((int)$uidBySeat[1]), '   ')) === 'sentence_empty');

$advanced = null;

/*
 * 词面泄露的检查放在 $customRoom 而不是主房间：
 * 其中「提到另一个词不算泄露」这条是一次**成功提交**，会把话筒推给下一位。
 * 在主房间跑它，下面的交卷循环就会从 1 号开始撞 not_your_turn。
 * 另外角色是随机发的，必须拿当前发言人真正持有的词去测，
 * 否则「我的词是平民词」对抽到卧底词的座位根本不成立，同样会提交成功。
 */
$cusRoles = seatRoles($db, $customRoom);
$cusUid = userIdBySeat($db, $customRoom);
$firstSeat = 1;
$firstRole = (string)$cusRoles[$firstSeat];
$firstWord = $firstRole === SpyRules\ROLE_SPY ? SPY_WORD
    : ($firstRole === SpyRules\ROLE_BLANK ? '' : CIV_WORD);
if ($firstWord === '') {
    check('白板没有词可泄露，任何描述都不被词面规则拦截',
        failRun($db, static fn() => spySubmitSentence($db, $customRoom, user((int)$cusUid[$firstSeat]), '随便说点什么')) !== 'word_spill');
} else {
    check('说出自己的词被拒',
        failRun($db, static fn() => spySubmitSentence($db, $customRoom, user((int)$cusUid[$firstSeat]), '我的词是' . $firstWord)) === 'word_spill');
    check('把词包进句子里同样被拒',
        failRun($db, static fn() => spySubmitSentence($db, $customRoom, user((int)$cusUid[$firstSeat]), '前缀' . $firstWord . '后缀')) === 'word_spill');
    $otherWord = $firstWord === CIV_WORD ? SPY_WORD : CIV_WORD;
    check('提到另一个词不算泄露自己的词',
        failRun($db, static fn() => spySubmitSentence($db, $customRoom, user((int)$cusUid[$firstSeat]), '前缀' . $otherWord . '后缀')) === '');
}

foreach (range(1, 6) as $s) {
    $r = okRun($db, static fn() => spySubmitSentence($db, $roomId, user((int)$uidBySeat[$s]), "第 1 回合座位 $s 的描述"), "交卷$s");
    if ($r['advanced'] !== null) $advanced = $r['advanced'];
}
check('最后一人交卷后自动进入讨论阶段', ($advanced['phase'] ?? '') === 'discuss', json_encode($advanced));
check('讨论阶段再交描述被判越序', failRun($db, static fn() => spySubmitSentence($db, $roomId, user((int)$uidBySeat[1]), '再说一次')) === 'phase_wrong');
$sentSnap = spyTableSnapshot($db, roomRow($db, $roomId), spySeatOf($db, $roomId, (int)$uidBySeat[1]));
check('六条描述都在玩家快照里', count($sentSnap['sentences'][1] ?? []) === 6);
check('旁观者按延迟看不到刚提交的描述',
    count(spyTableSnapshot($db, roomRow($db, $roomId), null)['sentences'][1] ?? []) === 0);
check('裁判不受延迟影响',
    count(spyTableSnapshot($db, roomRow($db, $roomId), null, true)['sentences'][1] ?? []) === 6);

okRun($db, static fn() => spyHostAdvance($db, $roomId, $host), '讨论推进到投票');
check('讨论结束后进入投票阶段', (string)roomRow($db, $roomId)['phase'] === 'vote');

/* ---------- 5. 投票 ---------- */
echo "5. 投票\n";

check('投票阶段不能交描述', failRun($db, static fn() => spySubmitSentence($db, $roomId, user((int)$uidBySeat[2]), '插一句')) === 'phase_wrong');
check('不能投给自己', failRun($db, static fn() => spyCastVote($db, $roomId, user((int)$uidBySeat[1]), 1)) === 'vote_target_invalid');
check('不能投给不在场的人', failRun($db, static fn() => spyCastVote($db, $roomId, user((int)$uidBySeat[1]), 9)) === 'vote_target_invalid');
$earlyVote = okRun($db, static fn() => spyCastVote($db, $roomId, user((int)$uidBySeat[1]), null), '1 号先投弃权');
check('同一人不能投两次票',
    (int)$earlyVote['seat'] === 1 && failRun($db, static fn() => spyCastVote($db, $roomId, user((int)$uidBySeat[1]), 2)) === 'already_voted');

$firstVictim = seatsWithRole($roles, SpyRules\ROLE_CIVILIAN)[0];
$voteAdvanced = null;
foreach (range(2, 6) as $s) {
    $target = $s === $firstVictim ? null : $firstVictim;
    $r = okRun($db, static fn() => spyCastVote($db, $roomId, user((int)$uidBySeat[$s]), $target), "投票{$s}");
    if ($r['advanced'] !== null) $voteAdvanced = $r['advanced'];
}
check('最后一票投出后自动结算并进入夜晚', ($voteAdvanced['phase'] ?? '') === 'night', json_encode($voteAdvanced));
check('被投出者记为第 1 回合投票出局',
    outRoundOf($db, $roomId, $firstVictim) === 1 && outByOf($db, $roomId, $firstVictim) === SpyRules\OUT_BY_VOTE);
$sealedJson = json_encode(spyTableSnapshot($db, roomRow($db, $roomId), spySeatOf($db, $roomId, (int)$uidBySeat[1])), JSON_UNESCAPED_UNICODE);
check('快照从不外发票面字段', !str_contains($sealedJson, '"to_seat"'), substr($sealedJson, 0, 200));
check('已出局者不能再参与夜晚行动',
    failRun($db, static fn() => spyNightAction($db, $roomId, user((int)$uidBySeat[$firstVictim]), 2)) === 'already_out');

/* ---------- 6. 夜晚 ---------- */
echo "6. 夜晚\n";

$aliveAfterVote = array_values(array_filter(range(1, 6), static fn($s) => $s !== $firstVictim));
$knifeTarget = null;
foreach ($aliveAfterVote as $c) {
    if ($roles[$c] === SpyRules\ROLE_CIVILIAN) { $knifeTarget = $c; break; }
}
$preNightSeats = spyTableSnapshot($db, roomRow($db, $roomId), spySeatOf($db, $roomId, (int)$uidBySeat[$spySeat]))['seats'];
check('夜晚结算前，快照里没有任何刀 mark',
    !in_array(SpyRules\OUT_BY_KILL, array_column($preNightSeats, 'out_by'), true),
    implode(',', array_column($preNightSeats, 'out_by')));

$spyUid = (int)$uidBySeat[$spySeat];
$nightAdvanced = okRun($db, static fn() => spyNightAction($db, $roomId, user($spyUid), $knifeTarget), '卧底交刀')['advanced'];
check('卧底交完刀自动结算并进入下一回合描述',
    ($nightAdvanced['phase'] ?? '') === 'day' && (int)($nightAdvanced['round'] ?? 0) === 2,
    json_encode($nightAdvanced));
check('被刀者第 1 回合夜晚出局',
    outRoundOf($db, $roomId, $knifeTarget) === 1 && outByOf($db, $roomId, $knifeTarget) === SpyRules\OUT_BY_KILL);
$postNightSeats = spyTableSnapshot($db, roomRow($db, $roomId), spySeatOf($db, $roomId, (int)$uidBySeat[$spySeat]))['seats'];
check('天亮后死法对所有人公开，复盘才画得出谁怎么死的',
    in_array(SpyRules\OUT_BY_KILL, array_column($postNightSeats, 'out_by'), true));
$nightBlock = spyTableSnapshot($db, roomRow($db, $roomId), spySeatOf($db, $roomId, (int)$uidBySeat[$spySeat]))['night'];
check('夜晚进度只报计数、不报座位号（报座位等于指认卧底）',
    array_keys($nightBlock) === ['required', 'submitted'], json_encode($nightBlock));

// 夜晚行动面板对所有存活者开放，平民误交即判自刀。
$skRoom = makeRoom($db, $host, $PLAYER_IDS, true);
$skRoles = seatRoles($db, $skRoom);
$skUid = userIdBySeat($db, $skRoom);
speakAll($db, $skRoom, $skUid, range(1, 6), 1);
okRun($db, static fn() => spyHostAdvance($db, $skRoom, $host), '到投票');
// 本回合故意全员弃权，只为把房间推进到夜晚阶段来验自刀规则。
okRun($db, static function () use ($db, $skRoom, $skUid) {
    foreach (range(1, 6) as $s) {
        spyCastVote($db, $skRoom, user((int)$skUid[$s]), null);
    }
}, '全员弃权到夜晚');
check('全员弃权不淘汰任何人', (string)roomRow($db, $skRoom)['phase'] === 'night');
$civ = seatsWithRole($skRoles, SpyRules\ROLE_CIVILIAN)[0];
$otherCiv = seatsWithRole($skRoles, SpyRules\ROLE_CIVILIAN)[1];
okRun($db, static fn() => spyNightAction($db, $skRoom, user((int)$skUid[$civ]), $otherCiv), '平民误交刀');
okRun($db, static function () use ($db, $skRoom, $skUid, $skRoles) {
    foreach (seatsWithRole($skRoles, SpyRules\ROLE_SPY) as $s) {
        spyNightAction($db, $skRoom, user($skUid[$s]), null);
    }
}, '卧底选择不刀');
check('平民提交刀人指令被判自刀', outByOf($db, $skRoom, $civ) === SpyRules\OUT_BY_SELF_KILL,
    outByOf($db, $skRoom, $civ));

/* ---------- 7. 平票与裁决 ---------- */
echo "7. 平票与裁决\n";

$tieRoom = makeRoom($db, $host, $PLAYER_IDS, true);
$tieRoles = seatRoles($db, $tieRoom);
$tieUid = userIdBySeat($db, $tieRoom);
speakAll($db, $tieRoom, $tieUid, range(1, 6), 1);
okRun($db, static fn() => spyHostAdvance($db, $tieRoom, $host), '到投票');

// 1/3/5 投 2，2/4/6 投 1 → 3:3 平票。
foreach ([1 => 2, 3 => 2, 5 => 2, 2 => 1, 4 => 1, 6 => 1] as $from => $to) {
    okRun($db, static fn() => spyCastVote($db, $tieRoom, user((int)$tieUid[$from]), $to), "平票$from");
}
$tieSnap = spyTableSnapshot($db, roomRow($db, $tieRoom), spySeatOf($db, $tieRoom, (int)$tieUid[1]));
check('平票时停在投票阶段等房主',
    (string)$tieSnap['room']['phase'] === 'vote' && $tieSnap['room']['tie_open'] === true);
check('平票后普通玩家不能再投票', failRun($db, static fn() => spyCastVote($db, $tieRoom, user((int)$tieUid[3]), 5)) === 'vote_already_settled');
check('非房主不能裁决', failRun($db, static fn() => spyResolveTie($db, $tieRoom, user((int)$tieUid[1]), 'pass')) === 'not_host');

okRun($db, static fn() => spyResolveTie($db, $tieRoom, $host, 'revote'), '重开投票');
check('重开后本轮票面清空', countRows($db, 'SELECT COUNT(*) FROM spy_votes WHERE room_id = ? AND round = 1', [$tieRoom]) === 0);
check('重开后 revote_used 置位', (int)roomRow($db, $tieRoom)['revote_used'] === 1);
check('重开后重新开放投票', (int)okRun($db, static fn() => spyCastVote($db, $tieRoom, user((int)$tieUid[1]), 2), '重投')['seat'] === 1);

// 再次平票，此时机会已用完，只能指定出局或放行。
foreach ([3 => 2, 5 => 2, 4 => 1, 6 => 1, 2 => 1] as $from => $to) {
    spyRun($db, static fn() => spyCastVote($db, $tieRoom, user((int)$tieUid[$from]), $to));
}
check('第二次平票不能再重开', failRun($db, static fn() => spyResolveTie($db, $tieRoom, $host, 'revote')) === 'no_revote_left');
$ruled = okRun($db, static fn() => spyResolveTie($db, $tieRoom, $host, 'eliminate', 2), '房主指定出局');
check('裁决后进入夜晚', ($ruled['advanced']['phase'] ?? '') === 'night', json_encode($ruled['advanced']));
check('被裁决者记为投票出局', outByOf($db, $tieRoom, 2) === SpyRules\OUT_BY_VOTE);
$tieOutcomes = spyTableSnapshot($db, roomRow($db, $tieRoom), null, true)['outcomes'];
$ruledRow = null;
foreach ($tieOutcomes as $o) {
    if ((int)$o['round'] === 1 && (string)$o['stage'] === 'vote') $ruledRow = $o;
}
check('裁决改写的是同一条记录而不是新增一条',
    $ruledRow !== null && (int)$ruledRow['eliminated_seat'] === 2 && $ruledRow['tie'] === false
    && countRows($db, 'SELECT COUNT(*) FROM spy_round_outcomes WHERE room_id = ? AND round = 1 AND stage = ?', [$tieRoom, 'vote']) === 1,
    json_encode($ruledRow));
check('裁决出局者仍是第 1 回合存活，第 2 回合才离场', outRoundOf($db, $tieRoom, 2) === 1);

$passRoom = makeRoom($db, $host, $PLAYER_IDS, true);
$passUid = userIdBySeat($db, $passRoom);
speakAll($db, $passRoom, $passUid, range(1, 6), 1);
okRun($db, static fn() => spyHostAdvance($db, $passRoom, $host), '到投票');
foreach ([1 => 2, 3 => 2, 5 => 2, 2 => 1, 4 => 1, 6 => 1] as $from => $to) {
    spyRun($db, static fn() => spyCastVote($db, $passRoom, user((int)$passUid[$from]), $to));
}
$passed2 = okRun($db, static fn() => spyResolveTie($db, $passRoom, $host, 'pass'), '放行');
check('放行也进入夜晚且无人出局', ($passed2['advanced']['phase'] ?? '') === 'night'
    && countRows($db, 'SELECT COUNT(*) FROM spy_seats WHERE room_id = ? AND out_round IS NOT NULL', [$passRoom]) === 0,
    json_encode($passed2['advanced']));

/* ---------- 8. 白板猜词 ---------- */
echo "8. 白板猜词\n";

$bgRoom = makeRoom($db, $host, $PLAYER_IDS, true);
$bgRoles = seatRoles($db, $bgRoom);
$bgUid = userIdBySeat($db, $bgRoom);
$bgBlank = seatsWithRole($bgRoles, SpyRules\ROLE_BLANK)[0];
$bgCiv = seatsWithRole($bgRoles, SpyRules\ROLE_CIVILIAN)[0];
check('非白板不能猜词', failRun($db, static fn() => spyBlankGuess($db, $bgRoom, user((int)$bgUid[$bgCiv]), CIV_WORD, SPY_WORD)) === 'not_blank');

$wrong = okRun($db, static fn() => spyBlankGuess($db, $bgRoom, user((int)$bgUid[$bgBlank]), '完全不相干', '也不相干'), '猜错');
check('猜错不结束本局', $wrong['ended'] === false && (string)roomRow($db, $bgRoom)['status'] === 'playing');
check('猜错不淘汰白板', outRoundOf($db, $bgRoom, $bgBlank) === null);
check('每局只能猜一次', failRun($db, static fn() => spyBlankGuess($db, $bgRoom, user((int)$bgUid[$bgBlank]), CIV_WORD, SPY_WORD)) === 'guess_exists');
$bgSnap = spyTableSnapshot($db, roomRow($db, $bgRoom), spySeatOf($db, $bgRoom, (int)$bgUid[$bgBlank]));
check('交过猜词后白板不能再猜', $bgSnap['me']['can_guess'] === false);
check('白板只回看自己的猜词内容', ($bgSnap['me']['guess']['guess_a'] ?? '') === '完全不相干');
check('猜词内容不外发给他人',
    !str_contains(json_encode(spyTableSnapshot($db, roomRow($db, $bgRoom), spySeatOf($db, $bgRoom, (int)$bgUid[$bgCiv])), JSON_UNESCAPED_UNICODE), '完全不相干'));

$hitRoom = makeRoom($db, $host, $PLAYER_IDS, true);
$hitRoles = seatRoles($db, $hitRoom);
$hitUid = userIdBySeat($db, $hitRoom);
$hitBlank = seatsWithRole($hitRoles, SpyRules\ROLE_BLANK)[0];
$hit = okRun($db, static fn() => spyBlankGuess($db, $hitRoom, user((int)$hitUid[$hitBlank]), CIV_WORD, SPY_WORD), '猜对');
check('两词全中立即结束本局', $hit['ended'] === true && (string)roomRow($db, $hitRoom)['status'] === 'ended');
check('胜方记为白板', (string)roomRow($db, $hitRoom)['winner'] === SpyRules\WIN_BLANK);
$hitSnap = spyTableSnapshot($db, roomRow($db, $hitRoom), spySeatOf($db, $hitRoom, (int)$hitUid[$hitBlank]));
check('结束后所有人都能看到身份', array_key_exists('role', $hitSnap['seats'][0]));
check('结束后快照带出词对', (string)($hitSnap['words']['civilian_word'] ?? '') === CIV_WORD);
check('结束后结果卡带出奖励', count($hitSnap['result']['awards'] ?? []) >= 2);
check('结束后结果卡带出六条揭示', count($hitSnap['result']['reveal'] ?? []) === 6);
check('结束后的事件日志依然干净',
    countRows($db, 'SELECT COUNT(*) FROM spy_events WHERE room_id = ? AND (payload LIKE ? OR payload LIKE ?)',
        [$hitRoom, '%' . CIV_WORD . '%', '%' . SPY_WORD . '%']) === 0);

/* ---------- 9. 整局驱动 ---------- */
echo "9. 整局驱动到分出胜负\n";

$fullRoom = makeRoom($db, $host, $PLAYER_IDS, true);
$fullRoles = seatRoles($db, $fullRoom);
$fullUid = userIdBySeat($db, $fullRoom);

$guard = 0;
while ($guard++ < 20) {
    $room = roomRow($db, $fullRoom);
    if ((string)$room['status'] !== 'playing') break;
    $round = (int)$room['round'];
    $alive = array_values(array_filter(range(1, 6), static fn($s) =>
        (outRoundOf($db, $fullRoom, $s) ?? 99) >= $round));
    if (!$alive) break;

    $phase = (string)$room['phase'];
    if ($phase === 'day') {
        foreach ($alive as $s) {
            spyRun($db, static fn() => spySubmitSentence($db, $fullRoom, user((int)$fullUid[$s]), "回合 $round 座位 $s"));
        }
        $phase = (string)roomRow($db, $fullRoom)['phase'];
    }
    if ($phase === 'discuss') {
        spyRun($db, static fn() => spyHostAdvance($db, $fullRoom, $host));
        $phase = (string)roomRow($db, $fullRoom)['phase'];
    }
    if ($phase === 'vote') {
        $victim = null;
        foreach ($alive as $s) {
            if ($fullRoles[$s] === SpyRules\ROLE_CIVILIAN) { $victim = $s; break; }
        }
        foreach ($alive as $s) {
            spyRun($db, static fn() => spyCastVote($db, $fullRoom, user((int)$fullUid[$s]), $s === $victim ? null : $victim));
        }
        $room = roomRow($db, $fullRoom);
        if ((string)$room['phase'] === 'vote' && spyTieOpen($db, $room)) {
            spyRun($db, static fn() => spyResolveTie($db, $fullRoom, $host, 'pass'));
        }
        $phase = (string)roomRow($db, $fullRoom)['phase'];
    }
    if ($phase === 'night') {
        foreach ($alive as $s) {
            if ($fullRoles[$s] !== SpyRules\ROLE_SPY) continue;
            $target = null;
            foreach ($alive as $c) {
                if ($fullRoles[$c] === SpyRules\ROLE_CIVILIAN) { $target = $c; break; }
            }
            spyRun($db, static fn() => spyNightAction($db, $fullRoom, user((int)$fullUid[$s]), $target));
        }
    }
}

$final = roomRow($db, $fullRoom);
check('整局能在有限回合内分出胜负', (string)$final['status'] === 'ended', "phase={$final['phase']} guard=$guard");
check('胜方是合法阵营',
    in_array((string)$final['winner'], [SpyRules\WIN_CIVILIAN, SpyRules\WIN_SPY, SpyRules\WIN_DRAW], true),
    (string)$final['winner']);
$finalSnap = spyTableSnapshot($db, $final, spySeatOf($db, $fullRoom, (int)$fullUid[1]));
check('结算屏带出六条身份揭示', count($finalSnap['result']['reveal'] ?? []) === 6);
$awardKeys = array_column($finalSnap['result']['awards'] ?? [], 'key');
check('奖励含 best-civilian 与 best-spy',
    in_array('best-civilian', $awardKeys, true) && in_array('best-spy', $awardKeys, true), implode(',', $awardKeys));
$award0 = $finalSnap['result']['awards'][0] ?? [];
check('奖励理由由真实票数生成',
    ($award0['why'] ?? '') !== '' && preg_match('/\d+ 票/', (string)($award0['why'] ?? '')) === 1,
    (string)($award0['why'] ?? ''));
check('奖励指向真实存在的座位与昵称',
    (int)($award0['seat'] ?? -1) >= 1 && (int)($award0['seat'] ?? -1) <= 6 && ($award0['name'] ?? '') !== '');
$revealWinnerRoles = array_column($finalSnap['result']['reveal'] ?? [], 'role');
check('揭示表角色分布与开局配额一致',
    count(array_filter($revealWinnerRoles, static fn($r) => $r === SpyRules\ROLE_CIVILIAN)) === 4);

/* ---------- 10. rev 与事件日志 ---------- */
echo "10. rev 与事件日志\n";

$revBefore = (int)roomRow($db, $fullRoom)['rev'];
$revAfter = okRun($db, static fn() => spyBump($db, $fullRoom, 'probe', ['ping' => 1]), '递增 rev');
check('spyBump 单调递增 rev', (int)$revAfter === $revBefore + 1, "$revBefore -> $revAfter");
$evs = spyEventsSince($db, $fullRoom, $revBefore);
check('增量只取比 since 新的事件', count($evs) === 1 && (int)$evs[0]['rev'] === (int)$revAfter, json_encode($evs));
check('事件按 rev 升序', (function () use ($db, $fullRoom) {
    $prev = 0;
    foreach (spyEventsSince($db, $fullRoom, 1, 200) as $e) {
        if ((int)$e['rev'] <= $prev) return false;
        $prev = (int)$e['rev'];
    }
    return true;
})());
check('since 超过当前 rev 时返回空', spyEventsSince($db, $fullRoom, $revAfter + 1000) === []);
check('同一 rev 不能重复写入', failRun($db, static fn() =>
    $db->prepare('INSERT INTO spy_events (room_id, rev, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)')
        ->execute([$fullRoom, $revAfter, 'dupe', '{}', spyNow()])) !== '');
$dirty = [];
foreach ($db->query('SELECT kind, payload FROM spy_events')->fetchAll() as $e) {
    $payload = (string)$e['payload'];
    $decoded = spyDecodeJson($payload);
    foreach (['role', 'word', 'civilian_word', 'spy_word', 'guess_a', 'guess_b', 'to_seat', 'target_seat'] as $secretKey) {
        if (array_key_exists($secretKey, $decoded)) $dirty[] = $e['kind'] . ' 带出键 ' . $secretKey;
    }
    if (str_contains($payload, CIV_WORD) || str_contains($payload, SPY_WORD)) $dirty[] = $e['kind'] . ' 带出词面';
}
// winner 的值与身份码同名（civilian/spy/blank），那是公开的胜负结论，不算泄露。
check('全库事件日志不含身份键与哨兵词', $dirty === [], implode(' | ', array_slice($dirty, 0, 4)));

/* ---------- 11. 方言分支 ---------- */
echo "11. 方言分支\n";

$names = ['room_id', 'winner', 'rounds'];
$sqlMysql = spyUpsertSql('spy_results', 'room_id', $names, [], true);
$sqlSqlite = spyUpsertSql('spy_results', 'room_id', $names, [], false);
check('MySQL 走 ON DUPLICATE KEY UPDATE', str_contains($sqlMysql, 'ON DUPLICATE KEY UPDATE winner = VALUES(winner)'), $sqlMysql);
check('SQLite 走 ON CONFLICT DO UPDATE', str_contains($sqlSqlite, 'ON CONFLICT(room_id) DO UPDATE SET winner = excluded.winner'), $sqlSqlite);
check('MySQL 语句里不混进 SQLite 语法', !str_contains($sqlMysql, 'excluded.'), $sqlMysql);
check('SQLite 语句里不混进 MySQL 语法', !str_contains($sqlSqlite, 'VALUES(winner)'), $sqlSqlite);
check('只更新指定列', str_contains(spyUpsertSql('spy_idempotency', 'idem_key',
    ['idem_key', 'response', 'created_at'], ['response', 'created_at'], true),
    'ON DUPLICATE KEY UPDATE response = VALUES(response), created_at = VALUES(created_at)'));
check('冲突列自身不出现在更新列表里',
    !str_contains(spyUpsertSql('spy_words', 'room_id', ['room_id', 'spy_word'], [], false), 'room_id = excluded.room_id'));

/* ---------- 12. cron 超时推进 ---------- */
echo "12. cron 超时推进\n";

$tickRoom = makeRoom($db, $host, $PLAYER_IDS, true);
$tickBefore = (string)roomRow($db, $tickRoom)['phase'];
$futureRoom = makeRoom($db, $host, $PLAYER_IDS, true);
$futureBefore = roomRow($db, $futureRoom);
$db->prepare('UPDATE spy_rooms SET deadline_at = ? WHERE id = ?')->execute([spyNow() - 5, $tickRoom]);

$ticked = spyTick($db);
$after = roomRow($db, $tickRoom);
check('超时房间被推进一个阶段', $ticked['advanced'] >= 1 && (string)$after['phase'] !== $tickBefore,
    json_encode([$ticked['advanced'], $tickBefore, $after['phase']]));
check('推进后重置了截止时间', (int)$after['deadline_at'] > spyNow());
$futureAfter = roomRow($db, $futureRoom);
check('未到时的房间原样不动',
    (int)$futureAfter['rev'] === (int)$futureBefore['rev'] && (string)$futureAfter['phase'] === (string)$futureBefore['phase']);
check('cron 推进无错误', $ticked['errors'] === [], implode(';', $ticked['errors']));
check('推进不重复：再跑一次时未到期', spyTick($db)['advanced'] === 0);

$lobbyRoom = makeRoom($db, $host, [2, 3]);
$db->prepare('UPDATE spy_rooms SET deadline_at = ? WHERE id = ?')->execute([spyNow() - 5, $lobbyRoom]);
check('未开局的房间即使 deadline 有值也不被推进',
    (function () use ($db, $lobbyRoom) {
        $before = (string)roomRow($db, $lobbyRoom)['phase'];
        spyTick($db);
        return (string)roomRow($db, $lobbyRoom)['phase'] === $before;
    })());

/* ---------- 13. 回收与级联 ---------- */
echo "13. 回收与级联\n";

$oldRoom = makeRoom($db, $host, [2, 3]);
$db->prepare('UPDATE spy_rooms SET last_activity_at = ? WHERE id = ?')
    ->execute([spyNow() - SPY_IDLE_LIMIT['waiting'] - 10, $oldRoom]);
$preview = spyReap($db, true);
check('回收预演列出过期房间', in_array($oldRoom, $preview['ids'], true));
check('回收预演不删除', countRows($db, 'SELECT COUNT(*) FROM spy_rooms WHERE id = ?', [$oldRoom]) === 1);
$reaped = spyReap($db, false);
check('回收删除过期房间', countRows($db, 'SELECT COUNT(*) FROM spy_rooms WHERE id = ?', [$oldRoom]) === 0);
check('子表随级联一起清空',
    countRows($db, 'SELECT COUNT(*) FROM spy_seats WHERE room_id = ?', [$oldRoom]) === 0
    && countRows($db, 'SELECT COUNT(*) FROM spy_events WHERE room_id = ?', [$oldRoom]) === 0);
check('活跃房间不被回收', countRows($db, 'SELECT COUNT(*) FROM spy_rooms WHERE id = ?', [$fullRoom]) === 1
    && in_array($oldRoom, $reaped['ids'], true));

/* ---------- 14. 幂等 ---------- */
echo "14. 幂等\n";

okRun($db, static fn() => spyIdemRemember($db, 'k-test', 1, ['success' => true, 'echo' => 'SENTINEL-IDEM']), '记录幂等响应');
check('重放命中缓存响应', (spyIdemLookup($db, 'k-test')['echo'] ?? '') === 'SENTINEL-IDEM');
okRun($db, static fn() => spyIdemRemember($db, 'k-test', 1, ['success' => true, 'echo' => 'SENTINEL-SECOND']), '覆盖幂等响应');
check('同键二次写入是更新而不是报错', (spyIdemLookup($db, 'k-test')['echo'] ?? '') === 'SENTINEL-SECOND');
check('空键不查不写', spyIdemLookup($db, '') === null);
$db->prepare('UPDATE spy_idempotency SET expires_at = ? WHERE idem_key = ?')->execute([spyNow() - 1, 'k-test']);
check('过期记录视为未命中', spyIdemLookup($db, 'k-test') === null);
check('lookup 顺带清掉了过期行', countRows($db, 'SELECT COUNT(*) FROM spy_idempotency WHERE idem_key = ?', ['k-test']) === 0);
spyIdemRemember($db, 'k-prune', 1, ['success' => true], -1);
$db->prepare('UPDATE spy_idempotency SET expires_at = ? WHERE idem_key = ?')->execute([spyNow() - 1, 'k-prune']);
check('修剪清掉未被 lookup 触碰的过期行', spyIdemPrune($db) >= 1
    && countRows($db, 'SELECT COUNT(*) FROM spy_idempotency WHERE idem_key = ?', ['k-prune']) === 0);

/* ---------- 15. 越权与状态门槛 ---------- */
echo "15. 越权与状态门槛\n";

$authRoom = makeRoom($db, $host, $PLAYER_IDS, true);
$authUid = userIdBySeat($db, $authRoom);
check('非房主不能开局', failRun($db, static fn() => spyHostStart($db, $authRoom, user(2))) === 'not_host');
check('非房主不能推进阶段', failRun($db, static fn() => spyHostAdvance($db, $authRoom, user(2))) === 'not_host');
check('非房主不能改配置', failRun($db, static fn() => spyUpdateRoom($db, $authRoom, user(2), ['cap' => 5])) === 'not_host');
check('非房主不能关闭房间', failRun($db, static fn() => spyHostClose($db, $authRoom, user(2))) === 'not_host');
check('旁观者不能交描述', failRun($db, static fn() => spySubmitSentence($db, $authRoom, user(99), '路过')) === 'not_member');
check('旁观者不能投票', failRun($db, static fn() => spyCastVote($db, $authRoom, user(99), 1)) === 'not_member');
check('游戏中不能离座', failRun($db, static fn() => spyLeaveRoom($db, $authRoom, user(2))) === 'game_started');
check('开局后不能改配置', failRun($db, static fn() => spyUpdateRoom($db, $authRoom, $host, ['cap' => 4])) === 'game_started');
check('已开局不能重复开局', failRun($db, static fn() => spyHostStart($db, $authRoom, $host)) === 'game_started');
check('不存在的房间返回 not found', failRun($db, static fn() => spyContext($db, 999999, $host)) === 'room_not_found');

$lobbyOnly = makeRoom($db, $host, [2, 3, 4, 5]);
check('未开局时推进被判「游戏还没有开始」', failRun($db, static fn() => spyHostAdvance($db, $lobbyOnly, $host)) === 'game_not_started');
check('开局前可以离座', (int)okRun($db, static fn() => spyLeaveRoom($db, $lobbyOnly, user(5)), '离座')['seat'] === 4);
check('离座后计数回落', countRows($db, 'SELECT COUNT(*) FROM spy_seats WHERE room_id = ?', [$lobbyOnly]) === 3);
check('未知配置键被忽略',
    okRun($db, static fn() => spyUpdateRoom($db, $lobbyOnly, $host, ['phase' => 'over', 'winner' => 'spy']))['changed'] === []);
$afterHack = roomRow($db, $lobbyOnly);
check('被忽略的键确实没写进去', (string)$afterHack['phase'] === 'lobby' && (string)$afterHack['winner'] === '');

$endedRoom = makeRoom($db, $host, $PLAYER_IDS);
okRun($db, static fn() => spyStart($db, $endedRoom), '开局');
okRun($db, static fn() => spyHostClose($db, $endedRoom, $host), '封房');
check('已结束的房间不能入座', failRun($db, static fn() => spyJoinRoom($db, $endedRoom, user(20))) === 'room_closed');
check('已结束的房间不能开局', failRun($db, static fn() => spyStart($db, $endedRoom)) === 'room_closed');
check('已结束的房间不能推进', failRun($db, static fn() => spyHostAdvance($db, $endedRoom, $host)) === 'room_closed');
check('已结束的房间返回上一局的结局而不是重新开局',
    (string)spyTableSnapshot($db, roomRow($db, $endedRoom), null)['room']['status'] === 'ended');

/* ---------- 16. 主持人自定义词与点名 ---------- */
echo "16. 主持人自定义词与点名\n";

const CUST_CIV = '自定义好人词';
const CUST_SPY = '自定义卧底词';

$cwRoom = makeRoom($db, $host, [2, 3, 4, 5, 6]);
check('只给一个词被拒绝', failRun($db, static fn() => spyUpdateRoom($db, $cwRoom, $host, ['word_a' => CUST_CIV])) === 'invalid_params');
check('归一化后相同的词被拒绝',
    failRun($db, static fn() => spyUpdateRoom($db, $cwRoom, $host, ['word_a' => '苹果', 'word_b' => '苹果 '])) === 'invalid_params');
check('超长词被拒绝',
    failRun($db, static fn() => spyUpdateRoom($db, $cwRoom, $host, ['word_a' => str_repeat('长', 25), 'word_b' => CUST_SPY])) === 'invalid_params');
$cwChanged = okRun($db, static fn() => spyUpdateRoom($db, $cwRoom, $host, ['word_a' => CUST_CIV, 'word_b' => CUST_SPY]), '设置自定义词');
check('自定义词写库', in_array('word_a', $cwChanged['changed'], true) && in_array('word_b', $cwChanged['changed'], true));

$usedBefore = countRows($db, 'SELECT used_count FROM spy_word_pairs WHERE a = ?', [CIV_WORD]);
okRun($db, static fn() => spyStart($db, $cwRoom), '自定义词房开局');
$stmt = $db->prepare('SELECT pair_id, civilian_word, spy_word, difficulty FROM spy_words WHERE room_id = ?');
$stmt->execute([$cwRoom]);
$cwWords = $stmt->fetch();
check('自定义词不进词库（pair_id=0）', $cwWords && (int)$cwWords['pair_id'] === 0);
check('自定义词按主持人给的发', (string)$cwWords['civilian_word'] === CUST_CIV && (string)$cwWords['spy_word'] === CUST_SPY);
check('自定义词标记为 custom', (string)$cwWords['difficulty'] === 'custom');
check('词库 used_count 未被自定义局污染',
    countRows($db, 'SELECT used_count FROM spy_word_pairs WHERE a = ?', [CIV_WORD]) === $usedBefore);

$cwRef = spyTableSnapshot($db, roomRow($db, $cwRoom), null, true);
check('裁判快照带自定义词', (string)$cwRef['room']['word_a'] === CUST_CIV && (string)$cwRef['room']['word_b'] === CUST_SPY);
$cwUid = userIdBySeat($db, $cwRoom);
$cwWordOk = true;
foreach ($cwRef['seats'] as $s) {
    $seatRole = (string)$s['role'];
    $seatSnap = spyTableSnapshot($db, roomRow($db, $cwRoom), spySeatOf($db, $cwRoom, (int)$cwUid[(int)$s['seat']]));
    $want = $seatRole === 'civilian' ? CUST_CIV : ($seatRole === 'spy' ? CUST_SPY : '');
    if ((string)$seatSnap['me']['word'] !== $want
        || (string)$seatSnap['room']['word_a'] !== '') $cwWordOk = false;
}
check('各身份拿到对应词且玩家快照不带词配置', $cwWordOk);

$prRoom = makeRoom($db, $host, [2, 3, 4, 5]);
check('非房主不能点名', failRun($db, static fn() => spyAssignRole($db, $prRoom, user(2), 1, 'spy')) === 'not_host');
check('非法身份被拒绝', failRun($db, static fn() => spyAssignRole($db, $prRoom, $host, 1, 'boss')) === 'invalid_params');
check('空座位不能点名', failRun($db, static fn() => spyAssignRole($db, $prRoom, $host, 6, 'spy')) === 'seat_not_found');
okRun($db, static fn() => spyAssignRole($db, $prRoom, $host, 1, 'spy'), '点名1号卧底');
okRun($db, static fn() => spyAssignRole($db, $prRoom, $host, 2, 'blank'), '点名2号白板');
$prRef = spyTableSnapshot($db, roomRow($db, $prRoom), null, true);
$prPreset = [];
foreach ($prRef['seats'] as $s) $prPreset[(int)$s['seat']] = (string)$s['preset'];
check('裁判快照带点名', $prPreset[1] === 'spy' && $prPreset[2] === 'blank' && $prPreset[3] === '');
check('玩家快照不带点名', !array_key_exists('preset', spyTableSnapshot($db, roomRow($db, $prRoom), spySeatOf($db, $prRoom, 4))['seats'][0]));
okRun($db, static fn() => spyAssignRole($db, $prRoom, $host, 1, ''), '撤销1号点名');
$prRef = spyTableSnapshot($db, roomRow($db, $prRoom), null, true);
$prPreset = [];
foreach ($prRef['seats'] as $s) $prPreset[(int)$s['seat']] = (string)$s['preset'];
check('撤销后点名清空', $prPreset[1] === '' && $prPreset[2] === 'blank');
okRun($db, static fn() => spyAssignRole($db, $prRoom, $host, 1, 'spy'), '重新点名1号卧底');

okRun($db, static fn() => spyStart($db, $prRoom), '点名房开局');
$prRoles = seatRoles($db, $prRoom);
check('点名座位按点名身份落库', $prRoles[1] === 'spy' && $prRoles[2] === 'blank');
check('其余座位按剩余配额随机补满', $prRoles[3] === 'civilian' && $prRoles[4] === 'civilian');
$prRoomRow = roomRow($db, $prRoom);
check('配额按点名抬高', (int)$prRoomRow['dist_spy'] === 1 && (int)$prRoomRow['dist_blank'] === 1 && (int)$prRoomRow['dist_civilian'] === 2);
check('开局后不能点名', failRun($db, static fn() => spyAssignRole($db, $prRoom, $host, 1, 'civilian')) === 'game_started');

$oqRoom = makeRoom($db, $host, [2, 3, 4, 5]);
for ($s = 1; $s <= 4; $s++) okRun($db, static fn() => spyAssignRole($db, $oqRoom, $host, $s, 'spy'), "点名{$s}号卧底");
check('全员点满卧底时开局被判配额非法', failRun($db, static fn() => spyStart($db, $oqRoom)) === 'distribution_invalid');

/* ---------- 汇总 ---------- */
echo "\n";
if ($failures) {
    echo "spy game: $passed passed, " . count($failures) . " FAILED\n";
    foreach ($failures as $f) echo "  [FAIL] $f\n";
    exit(1);
}
echo "spy game: $passed assertions, $passed passed\n";
echo "spy game: all green\n";
