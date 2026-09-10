<?php
/**
 * 谁是卧底表结构冒烟测试（SQLite 方言）。
 * [HERE] scripts/test-spy-schema.php
 *
 * 用法： php scripts/test-spy-schema.php
 * 在临时库里建一遍表、跑两遍证明幂等、写读一条完整房间状态，
 * 并核对词库种子确实是原型 WORD_BANK 那 22 对。
 *
 * 注意：这只覆盖 SQLite 分支。MySQL 分支靠 includes/spy_schema.php
 * 里的方言三元生成，语法在部署前需要在真 MySQL 上跑一次 migrate.php。
 */

declare(strict_types=1);

require __DIR__ . '/../includes/spy_schema.php';

$passed = 0;
$failures = [];

function check(string $name, bool $ok, string $detail = ''): void {
    global $passed, $failures;
    if ($ok) { $passed++; return; }
    $failures[] = $name . ($detail !== '' ? ' -> ' . $detail : '');
}

$db = new PDO('sqlite::memory:');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->exec('PRAGMA foreign_keys = ON');

// 词库外键到 users 表在真实库里存在，这里建一张最小替身。
$db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, nickname TEXT NOT NULL DEFAULT "")');
$db->exec("INSERT INTO users (id, nickname) VALUES (1, '阿澄'), (2, '柚子'), (3, '白河'), (4, '折枝'), (5, '路人')");

try {
    spyEnsureSchema($db, false);
    check('首次建表不报错', true);
} catch (Throwable $e) {
    check('首次建表不报错', false, $e->getMessage());
}

try {
    // 走 spyApplySchema 而不是 spyEnsureSchema：后者有进程内 static 守卫，
    // 重复调用会直接返回，测的就不是 DDL 幂等而是那个守卫了。
    spyApplySchema($db, false);
    check('重复执行幂等（第二次不报错）', true);
} catch (Throwable $e) {
    check('重复执行幂等（第二次不报错）', false, $e->getMessage());
}

$expected = [
    'spy_rooms', 'spy_seats', 'spy_words', 'spy_word_pairs', 'spy_sentences',
    'spy_votes', 'spy_night_actions', 'spy_blank_guesses', 'spy_round_outcomes',
    'spy_events', 'spy_results', 'spy_idempotency',
];
foreach ($expected as $table) {
    $hit = $db->query("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = " . $db->quote($table))->fetchColumn();
    check("表 {$table} 已创建", (int)$hit === 1);
}

// 词库种子必须逐条对上原型的 22 对，used 计数也要带过来。
// 期望值直接从 spyDefaultWordPairs() 求，避免把数字抄第二遍抄错或日后走样。
$source = spyDefaultWordPairs();
$expectedCount = count($source);
$expectedUsed = array_sum(array_column($source, 4));

$count = (int)$db->query('SELECT COUNT(*) FROM spy_word_pairs')->fetchColumn();
check('词库种子条数与来源一致', $count === $expectedCount, "got {$count}, expected {$expectedCount}");
$usedSum = (int)$db->query('SELECT SUM(used_count) FROM spy_word_pairs')->fetchColumn();
check('词库 used 计数完整迁移', $usedSum === $expectedUsed, "sum={$usedSum} expected={$expectedUsed}");
$first = $db->query("SELECT a, b, level, similarity FROM spy_word_pairs WHERE a = '视觉小说'")->fetch(PDO::FETCH_ASSOC);
check('原型首对词存在且属性未走样',
    $first && $first['b'] === '轻小说' && $first['level'] === 'mid' && $first['similarity'] === 'near',
    json_encode($first, JSON_UNESCAPED_UNICODE));
$dupes = (int)$db->query('SELECT COUNT(*) FROM (SELECT a, b FROM spy_word_pairs GROUP BY a, b HAVING COUNT(*) > 1)')->fetchColumn();
check('词库无重复词对', $dupes === 0);

// 种子只灌一次：再跑一遍完整建表流程不应让词库翻倍。
spyApplySchema($db, false);
$after = (int)$db->query('SELECT COUNT(*) FROM spy_word_pairs')->fetchColumn();
check('词库种子不重复灌入', $after === 22, "got {$after}");

// 一轮完整写读：建房 → 入座 → 发身份 → 提交句子与票 → bump rev → 记事件。
try {
    $now = time();
    $db->prepare('INSERT INTO spy_rooms
        (code, name, host_user_id, cap, joined, dist_civilian, dist_spy, dist_blank,
         phase, round, deadline_at, status, rev, last_activity_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        ->execute(['VN0821', '周五游戏夜', 1, 8, 4, 3, 1, 0, 'day', 1, $now + 160, 'living', 1, $now]);
    $roomId = (int)$db->lastInsertId();
    check('插入房间', $roomId > 0);

    $seatStmt = $db->prepare('INSERT INTO spy_seats (room_id, seat, user_id, nick, role, ready_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)');
    foreach ([[1, 2, '柚子', 'civilian'], [2, 3, '白河', 'spy'], [3, 4, '折枝', 'civilian'], [4, 5, '路人', 'civilian']] as [$seat, $uid, $nick, $role]) {
        $seatStmt->execute([$roomId, $seat, $uid, $nick, $role, $now, $now]);
    }
    check('插入 4 个座位', (int)$db->query("SELECT COUNT(*) FROM spy_seats WHERE room_id = {$roomId}")->fetchColumn() === 4);

    $db->prepare('INSERT INTO spy_words (room_id, pair_id, civilian_word, spy_word, dealt_at) VALUES (?, ?, ?, ?, ?)')
        ->execute([$roomId, 1, '视觉小说', '轻小说', $now]);

    // 同一座位重复提交同一回合的句子必须被 UNIQUE 挡住（幂等后盾）。
    $sent = $db->prepare('INSERT INTO spy_sentences (room_id, round, seat, body, submitted_at) VALUES (?, ?, ?, ?, ?)');
    $sent->execute([$roomId, 1, 1, '我一般周末一口气看完一整部。', $now]);
    $blocked = false;
    try { $sent->execute([$roomId, 1, 1, '重复提交', $now]); }
    catch (Throwable $e) { $blocked = true; }
    check('同座位重复提交句子被 UNIQUE 挡住', $blocked);

    // 弃权（to_seat NULL）与正常票共存。
    $vote = $db->prepare('INSERT INTO spy_votes (room_id, round, from_seat, to_seat, submitted_at) VALUES (?, ?, ?, ?, ?)');
    $vote->execute([$roomId, 1, 1, 2, $now]);
    $vote->execute([$roomId, 1, 3, 2, $now]);
    $vote->execute([$roomId, 1, 4, null, $now]);
    check('票数与弃权分别落库',
        (int)$db->query("SELECT COUNT(*) FROM spy_votes WHERE room_id = {$roomId} AND to_seat = 2")->fetchColumn() === 2
        && (int)$db->query("SELECT COUNT(*) FROM spy_votes WHERE room_id = {$roomId} AND to_seat IS NULL")->fetchColumn() === 1);

    // 白板猜词每局限一次。
    $guess = $db->prepare('INSERT INTO spy_blank_guesses (room_id, round, seat, guess_a, guess_b, result, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)');
    $guess->execute([$roomId, 1, 2, '视觉小说', '轻小说', 'only-one', $now]);
    $guessBlocked = false;
    try { $guess->execute([$roomId, 2, 2, 'a', 'b', 'miss', $now]); }
    catch (Throwable $e) { $guessBlocked = true; }
    check('白板猜词每局限一次', $guessBlocked);

    // rev 游标与事件日志同事务递增。
    $db->prepare('UPDATE spy_rooms SET rev = rev + 1 WHERE id = ?')->execute([$roomId]);
    $db->prepare('INSERT INTO spy_events (room_id, rev, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)')
        ->execute([$roomId, 2, 'vote:cast', '{"seat":1}', $now]);
    $rev = (int)$db->query("SELECT rev FROM spy_rooms WHERE id = {$roomId}")->fetchColumn();
    check('rev 递增到 2', $rev === 2, "got {$rev}");
    $eventBlocked = false;
    try {
        $db->prepare('INSERT INTO spy_events (room_id, rev, kind, created_at) VALUES (?, ?, ?, ?)')
            ->execute([$roomId, 2, 'dup', $now]);
    } catch (Throwable $e) { $eventBlocked = true; }
    check('同一 rev 不能重复写事件', $eventBlocked);

    // 级联删除：只删房间，所有子表行必须被带走，不留孤儿状态。
    $db->prepare('DELETE FROM spy_rooms WHERE id = ?')->execute([$roomId]);
    check('删除房间级联清干净子表',
        (int)$db->query("SELECT COUNT(*) FROM spy_seats WHERE room_id = {$roomId}")->fetchColumn() === 0
        && (int)$db->query("SELECT COUNT(*) FROM spy_words WHERE room_id = {$roomId}")->fetchColumn() === 0
        && (int)$db->query("SELECT COUNT(*) FROM spy_votes WHERE room_id = {$roomId}")->fetchColumn() === 0
        && (int)$db->query("SELECT COUNT(*) FROM spy_sentences WHERE room_id = {$roomId}")->fetchColumn() === 0
        && (int)$db->query("SELECT COUNT(*) FROM spy_blank_guesses WHERE room_id = {$roomId}")->fetchColumn() === 0
        && (int)$db->query("SELECT COUNT(*) FROM spy_events WHERE room_id = {$roomId}")->fetchColumn() === 0);
} catch (Throwable $e) {
    check('写读一轮房间状态', false, $e->getMessage());
}

$total = $passed + count($failures);
echo "spy schema: {$total} assertions, {$passed} passed\n";
if ($failures) {
    echo "\nFAILURES:\n";
    foreach ($failures as $f) echo "  - {$f}\n";
    exit(1);
}
echo "spy schema: all green\n";
exit(0);
