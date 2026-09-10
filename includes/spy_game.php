<?php
/**
 * 谁是卧底（Spy）端点共享层。
 * [HERE] includes/spy_game.php
 *
 * 职责：请求骨架、房间加锁、阶段推进、**可见性投影**。
 * 规则算术在 includes/spy_rules.php（纯函数），表结构在 includes/spy_schema.php，
 * 本文件是把两者接到 HTTP 上的那一层。
 *
 * ------------------------------------------------------------------
 * 三条不能违反的约束
 *
 * 1. 会话锁必须在业务逻辑之前释放。
 *    PHP 默认把会话存文件并整请求持锁。一个 12 人房每 3 秒轮询一次，
 *    若沿用 auth.php 的 requireLogin()，12 个轮询请求会在同一把会话锁上串行，
 *    表现就是「所有人一起卡住」。spyBootstrap() 读完用户即 session_write_close()。
 *    交还之后任何代码都不许再碰 $_SESSION —— 包括 auth.php 的 requireLogin()/requireRole()，
 *    它们内部的 initSession() 会把会话重新打开、锁也就回来了。
 *
 * 2. 事务里不许 exit。
 *    spyRespond()/spyFail() 以 exit() 收尾，在 spyTransact() 内调用会让事务既不提交
 *    也不显式回滚，全靠连接销毁时隐式回滚 —— 而错误信息照常发出，看起来像成功了。
 *    事务内的失败一律 throw SpyError，由 spyTransact() 回滚后再在事务外响应。
 *
 * 3. 快照与事件日志永不携带他人的身份或词对。
 *    状态之所以落库而不是 data/*.json，是因为 .htaccess 不挡 data/*.json、URL 可直读。
 *    同理，spy_events 是所有客户端都要读的，往 payload 里塞 role 等于把答案广播。
 *    身份只在两种情况下出：本局结束（phase=over），或收件人是裁判。
 * ------------------------------------------------------------------
 *
 * 可见性规则（对齐原型 RULE_SNAPSHOT「你只会看到自己拿到的那一个词」）：
 *   · 平民与卧底的快照里都没有 role 字段 —— 卧底不知道自己是卧底，否则玩法崩塌。
 *   · 白板例外：他必须知道自己是白板，才知道要猜两个词，所以拿到 role='blank' 且 word=''。
 *   · 词对与 seat→role 映射只发给裁判。裁判 = 房主 **且自己没有入座**。
 *     房主一旦入座就降级为普通玩家，拿到的投影与别人完全相同（只多一项推进阶段的权利），
 *     否则「主持人掌握全部身份」会退化成「入场的主持人必胜」。
 */

declare(strict_types=1);

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/spy_rules.php';
require_once __DIR__ . '/spy_schema.php';

use Spy as SpyRules;

/** 服务端文案表。js/language-runtime.js 的 localizeApiMessage 按原文匹配，
 *  所以这里必须是**定长、无插值**的短句：要带数字就放进 extra，别拼进句子。 */
const SPY_MESSAGES = [
    'not_login'           => '请先登录',
    'invalid_action'      => '操作名称无法识别',
    'invalid_params'      => '请求参数不完整',
    'room_not_found'      => '房间不存在',
    'room_closed'         => '房间已关闭',
    'room_full'           => '房间座位已满',
    'join_code_invalid'   => '房间码不正确',
    'spectate_off'        => '该房间未开放观战',
    'not_member'          => '你不在该房间内',
    'not_host'            => '仅房主可执行该操作',
    'already_joined'      => '你已在该房间内',
    'game_started'        => '本局已经开始',
    'game_not_started'    => '本局尚未开始',
    'phase_wrong'         => '当前阶段不支持该操作',
    'already_out'         => '你已出局',
    'not_your_turn'       => '当前未轮到你发言',
    'already_spoken'      => '本回合你已提交过描述',
    'sentence_empty'      => '描述不能为空',
    'sentence_too_long'   => '描述超出长度限制',
    'word_spill'          => '描述中不得出现自己所持有的词',
    'already_voted'       => '你已投过票',
    'vote_target_invalid' => '投票目标无效',
    'vote_already_settled' => '本轮投票已结束',
    'guess_exists'        => '你已提交过猜词',
    'not_blank'           => '仅白板可提交猜词',
    'distribution_invalid' => '身份分配与入座人数不一致',
    'players_not_enough'  => '入座人数不足，无法开局',
    'word_bank_empty'     => '词库为空，请联系管理员',
    'no_revote_left'      => '重新投票次数已用完',
    'server_error'        => '服务器繁忙，请稍后重试',
];

/** 阶段全序，用于判断「某条回合裁决记录是否已经可以公开」。 */
const SPY_PHASE_RANK = [
    'lobby' => -1, 'day' => 0, 'discuss' => 1, 'vote' => 2, 'night' => 3, 'over' => 4,
];

/** 裁决公开的门槛：第 R 回合的 vote 记录要等 rank 越过它自己才公开。pass 与 vote 同门槛。 */
const SPY_SETTLE_RANK = ['vote' => 2, 'pass' => 2, 'night' => 3];

/** 房主可改的房间配置白名单。不在此列的键一律拒写。word_a/word_b 为空串表示走词库。 */
const SPY_ROOM_SETTINGS = [
    'name', 'cap', 'timer_profile', 'spectate', 'spectate_delay',
    'need_code', 'dist_civilian', 'dist_spy', 'dist_blank', 'club_id', 'country',
    'word_a', 'word_b',
];

/** 房号字符集去掉易混字符（0/O、1/I）。 */
const SPY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 超过这个秒数没心跳就标灰。前端 3 秒轮询，留 4 倍余量。 */
const SPY_ONLINE_WINDOW = 12;

/**
 * 心跳落库的最小间隔。必须小于 SPY_ONLINE_WINDOW ——
 * 否则两次写库之间正好越过在线窗口，一直在轮询的人也会被显示成离线。
 */
const SPY_HEARTBEAT_WRITE_MIN = 6;

/** 无人打理的房间由 scripts/spy_worker.php 回收。 */
const SPY_IDLE_LIMIT = ['playing' => 7200, 'waiting' => 86400, 'ended' => 604800];

/* ==========================================================================
 * 一、失败类型与请求骨架
 * ========================================================================== */

final class SpyError extends RuntimeException
{
    public function __construct(
        private readonly string $key,
        private readonly int $status = 400,
        private readonly array $extra = [],
    ) {
        parent::__construct($key);
    }

    public function key(): string
    {
        return $this->key;
    }

    public function status(): int
    {
        return $this->status;
    }

    public function extra(): array
    {
        return $this->extra;
    }
}

function spyIsMysql(): bool
{
    return defined('DB_DRIVER') && DB_DRIVER === 'mysql';
}

function spyNow(): int
{
    return time();
}

/**
 * 取库并确保表在位。
 * 沿用 api/vote_projects.php 首次请求自建表的做法，生产上不必依赖有人手动跑迁移。
 */
function spyBoot(): PDO
{
    $db = getDB();
    spyEnsureSchema($db, spyIsMysql());
    return $db;
}

function spyMessage(string $key): string
{
    return SPY_MESSAGES[$key] ?? SPY_MESSAGES['server_error'];
}

/** 供 i18n 契约测试枚举：前端文案表必须覆盖这里的每一条。 */
function spyMessageCatalog(): array
{
    return SPY_MESSAGES;
}

/**
 * 读一次登录态就交还会话锁。
 * 之后要用户信息请用 spyUser()，它走进程内缓存，不会把会话重新打开。
 */
function spyBootstrap(): void
{
    header('Content-Type: application/json; charset=utf-8');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Idempotency-Key');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
        http_response_code(200);
        exit();
    }
    spyUser();
}

/** @return array|null 当前登录用户，未登录为 null */
function spyUser(): ?array
{
    static $resolved = false;
    static $user = null;
    if ($resolved) return $user;

    $resolved = true;
    $user = getCurrentUser();
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    return $user;
}

/** @return array 未登录时直接结束请求 */
function spyRequireLogin(): array
{
    $user = spyUser();
    if (!$user) spyFail('not_login', 401);
    return $user;
}

function spyRespond(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit();
}

function spyOk(array $data = []): void
{
    spyRespond(['success' => true] + $data, 200);
}

function spyFail(string $key, int $status = 400, array $extra = []): void
{
    spyRespond(['success' => false, 'message' => spyMessage($key)] + $extra, $status);
}

/**
 * 事务执行的唯一入口。回调只 return 数据；要中断就 throw SpyError。
 * 返回结果封套而不是直接响应，好让 CLI 测试也能跑这条路径。
 *
 * @return array{ok:bool,data?:mixed,key?:string,status?:int,extra?:array}
 */
function spyRun(PDO $db, callable $fn): array
{
    try {
        spyBegin($db);
        $data = $fn();
        spyCommit($db);
        return ['ok' => true, 'data' => $data];
    } catch (SpyError $e) {
        spyRollback($db);
        return ['ok' => false, 'key' => $e->key(), 'status' => $e->status(), 'extra' => $e->extra()];
    } catch (Throwable $e) {
        spyRollback($db);
        error_log('[spy] ' . $e->getMessage());
        return ['ok' => false, 'key' => 'server_error', 'status' => 500, 'extra' => []];
    }
}

/**
 * HTTP 侧包装。
 *
 * SQLite 用 BEGIN IMMEDIATE —— 延迟事务里「先读后写」会在升级写锁时撞上
 * 别人的写事务而直接 SQLITE_BUSY，busy_timeout 对已持读锁的升级不生效。
 */
function spyTransact(PDO $db, callable $fn): mixed
{
    $result = spyRun($db, $fn);
    if (!$result['ok']) {
        spyFail($result['key'], $result['status'], $result['extra']);
    }
    return $result['data'];
}

function spyBegin(PDO $db): void
{
    if (spyIsMysql()) {
        $db->beginTransaction();
    } else {
        $db->exec('BEGIN IMMEDIATE');
    }
}

function spyCommit(PDO $db): void
{
    if (spyIsMysql()) {
        $db->commit();
    } else {
        $db->exec('COMMIT');
    }
}

function spyRollback(PDO $db): void
{
    try {
        if (spyIsMysql()) {
            if ($db->inTransaction()) $db->rollBack();
        } else {
            $db->exec('ROLLBACK');
        }
    } catch (Throwable $e) {
        // 已经没有活动事务，无需处理。
    }
}

/* ==========================================================================
 * 二、入参清洗
 * ========================================================================== */

function spyReadJson(): array
{
    $raw = file_get_contents('php://input');
    $data = json_decode((string)$raw, true);
    return is_array($data) ? $data : [];
}

/** GET 与 POST body 合并取值，GET 优先（便于 ?action= 路由）。 */
function spyParam(array $body, string $key, mixed $default = null): mixed
{
    if (isset($_GET[$key])) return $_GET[$key];
    return array_key_exists($key, $body) ? $body[$key] : $default;
}

function spyStr(mixed $value, int $maxLen = 200): string
{
    $s = trim(str_replace("\x00", '', (string)$value));
    $s = function_exists('mb_substr') ? mb_substr($s, 0, $maxLen, 'UTF-8') : substr($s, 0, $maxLen);
    return preg_replace('/\R/u', ' ', $s) ?? '';
}

function spyInt(mixed $value, int $default = 0): int
{
    return is_numeric($value) ? (int)$value : $default;
}

function spyBool(mixed $value): int
{
    return in_array($value, [true, 1, '1', 'true', 'yes', 'on'], true) ? 1 : 0;
}

/**
 * 幂等键：请求头优先，其次 body 字段。
 * 只允许出现在写操作的响应重放里，不参与任何权限判断。
 */
function spyIdempotencyKey(array $body): string
{
    $hdr = (string)($_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? $_SERVER['HTTP_X_IDEMPOTENCY_KEY'] ?? '');
    $raw = $hdr !== '' ? $hdr : (string)($body['idempotency_key'] ?? '');
    return substr(preg_replace('/[^A-Za-z0-9_\-:]/', '', $raw) ?? '', 0, 64);
}

/**
 * 从请求里取房间 id（房号或自增 id 都接受）。
 *
 * 放在共享层而不是某个端点里：每个 api/*.php 都是独立请求，
 * 一个端点定义的函数另一个端点看不见。
 * 只可在事务内调用，所以取不到时抛 SpyError —— spyFail() 以 exit() 收尾，
 * 会把一个还没提交的事务留在连接上（见文件头约束 2）。
 */
function spyRefId(PDO $db, array $body): int
{
    $ref = spyStr(spyParam($body, 'code', '') ?: spyParam($body, 'room', ''), 16);
    if ($ref === '') throw new SpyError('invalid_params', 400);
    $room = spyLoadRoom($db, $ref);
    if (!$room) throw new SpyError('room_not_found', 404);
    return (int)$room['id'];
}

/* ==========================================================================
 * 三、房间与座位
 * ========================================================================== */

function spyGenerateRoomCode(PDO $db, int $length = 6): string
{
    $max = strlen(SPY_CODE_ALPHABET) - 1;
    $hit = $db->prepare('SELECT id FROM spy_rooms WHERE code = ?');
    for ($attempt = 0; $attempt < 12; $attempt++) {
        $code = '';
        for ($i = 0; $i < $length; $i++) {
            $code .= SPY_CODE_ALPHABET[random_int(0, $max)];
        }
        $hit->execute([$code]);
        if (!$hit->fetchColumn()) return $code;
    }
    throw new SpyError('server_error', 500);
}

function spyGenerateJoinCode(): string
{
    return (string)random_int(1000, 9999);
}

/** 按自增 id（数字串）或房号（code）取房间。 */
function spyLoadRoom(PDO $db, string $ref): ?array
{
    if (ctype_digit($ref)) {
        $stmt = $db->prepare('SELECT * FROM spy_rooms WHERE id = ?');
        $stmt->execute([(int)$ref]);
    } else {
        $stmt = $db->prepare('SELECT * FROM spy_rooms WHERE code = ?');
        $stmt->execute([mb_strtoupper($ref, 'UTF-8')]);
    }
    $row = $stmt->fetch();
    return $row ?: null;
}

/**
 * 行锁取房间。MySQL 走 FOR UPDATE；
 * SQLite 的写锁由 BEGIN IMMEDIATE 在整个事务粒度上承担，无需行锁。
 */
function spyLockRoom(PDO $db, int $roomId): ?array
{
    $sql = 'SELECT * FROM spy_rooms WHERE id = ?';
    if (spyIsMysql()) $sql .= ' FOR UPDATE';
    $stmt = $db->prepare($sql);
    $stmt->execute([$roomId]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function spySeats(PDO $db, int $roomId): array
{
    $stmt = $db->prepare('SELECT * FROM spy_seats WHERE room_id = ? ORDER BY seat');
    $stmt->execute([$roomId]);
    return $stmt->fetchAll();
}

function spySeatOf(PDO $db, int $roomId, int $userId): ?array
{
    $stmt = $db->prepare('SELECT * FROM spy_seats WHERE room_id = ? AND user_id = ?');
    $stmt->execute([$roomId, $userId]);
    $row = $stmt->fetch();
    return $row ?: null;
}

/** out_round 空串/NULL 都算存活（MySQL 无严格模式时可能读出 ''）。 */
function spyOutRound(mixed $raw): ?int
{
    return ($raw === null || $raw === '' || $raw === 0) ? null : (int)$raw;
}

/** 转成 spy_rules.php 期望的形状：[['seat'=>int,'role'=>string,'outRound'=>?int]] */
function spyRuleSeats(array $rows): array
{
    $out = [];
    foreach ($rows as $r) {
        $out[] = [
            'seat'     => (int)$r['seat'],
            'role'     => (string)($r['role'] ?? ''),
            'outRound' => spyOutRound($r['out_round'] ?? null),
        ];
    }
    return $out;
}

/** 该回合存活（出局当回合仍算存活，见 spy_rules.php:129）。 */
function spyAliveTargets(array $rows, int $round): array
{
    $targets = [];
    foreach ($rows as $r) {
        if (SpyRules\alive_at_round(spyOutRound($r['out_round'] ?? null), $round)) {
            $targets[] = (int)$r['seat'];
        }
    }
    sort($targets);
    return $targets;
}

/** 房主身份与是否入座无关 —— 入座后仍能推进阶段，只是不再看得到身份。 */
function spyIsHost(array $room, array $user): bool
{
    return (int)$room['host_user_id'] === (int)$user['id'];
}

/**
 * 心跳：座位在线状态与房主活跃度。
 *
 * 快照端点大约每 3 秒被每个客户端拉一次，每次都写会把只读轮询变成写事务、
 * 和真正的状态变更抢 SQLite 的写锁。所以把节流放进 WHERE —— 超过阈值才落笔，
 * 仍然是单条语句，不需要先读后判。
 */
function spyTouch(PDO $db, array $room, ?array $mySeat, ?array $user): int
{
    $now = spyNow();
    $stale = $now - SPY_HEARTBEAT_WRITE_MIN;
    $writes = 0;

    if ($mySeat !== null) {
        $stmt = $db->prepare(
            'UPDATE spy_seats SET last_seen_at = ? WHERE room_id = ? AND seat = ? AND last_seen_at < ?'
        );
        $stmt->execute([$now, (int)$room['id'], (int)$mySeat['seat'], $stale]);
        $writes += $stmt->rowCount();
    }

    if ($user !== null && (int)$user['id'] === (int)$room['host_user_id']) {
        $stmt = $db->prepare('UPDATE spy_rooms SET host_last_seen_at = ? WHERE id = ? AND host_last_seen_at < ?');
        $stmt->execute([$now, (int)$room['id'], $stale]);
        $writes += $stmt->rowCount();
    }

    return $writes;
}

/* ==========================================================================
 * 四、rev 与事件日志
 * ========================================================================== */

/**
 * 递增房间 rev 并记一条变更事件。必须与引起变更的写操作同事务。
 *
 * $payload 只放公开信息（阶段名、回合数、座位号）。见文件头约束 3。
 */
function spyBump(PDO $db, int $roomId, string $kind, array $payload = []): int
{
    $now = spyNow();
    $db->prepare('UPDATE spy_rooms SET rev = rev + 1, last_activity_at = ? WHERE id = ?')
        ->execute([$now, $roomId]);
    $stmt = $db->prepare('SELECT rev FROM spy_rooms WHERE id = ?');
    $stmt->execute([$roomId]);
    $rev = (int)$stmt->fetchColumn();

    $db->prepare('INSERT INTO spy_events (room_id, rev, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)')
        ->execute([
            $roomId, $rev, $kind,
            json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            $now,
        ]);
    return $rev;
}

function spyEventsSince(PDO $db, int $roomId, int $since, int $limit = 60): array
{
    $stmt = $db->prepare(
        'SELECT rev, kind, payload FROM spy_events WHERE room_id = ? AND rev > ? ORDER BY rev LIMIT ?'
    );
    $stmt->bindValue(1, $roomId, PDO::PARAM_INT);
    $stmt->bindValue(2, $since, PDO::PARAM_INT);
    $stmt->bindValue(3, max(1, min(200, $limit)), PDO::PARAM_INT);
    $stmt->execute();
    $rows = [];
    foreach ($stmt->fetchAll() as $r) {
        $rows[] = [
            'rev'     => (int)$r['rev'],
            'kind'    => (string)$r['kind'],
            'payload' => spyDecodeJson((string)$r['payload']),
        ];
    }
    return $rows;
}

function spyDecodeJson(mixed $raw): array
{
    $v = json_decode((string)$raw, true);
    return is_array($v) ? $v : [];
}

/**
 * upsert 语句。MySQL 与 SQLite 语法不同，生产的 MySQL 版本未知，
 * 不能假装有 8.0 的 VALUES() 之外的写法，所以按方言分支。
 *
 * 单独成函数是为了让 CLI 测试能断言 MySQL 那条分支 —— 本地跑的是 SQLite，
 * 而方言写错恰恰是只有在生产才会暴露的那类错误。
 */
function spyUpsertSql(string $table, string $conflictCol, array $names, array $updateCols, bool $isMysql): string
{
    $sql = 'INSERT INTO ' . $table . ' (' . implode(', ', $names) . ') VALUES ('
        . implode(', ', array_fill(0, count($names), '?')) . ')';
    $cols = $updateCols ?: array_values(array_diff($names, [$conflictCol]));
    if (!$cols) return $sql;

    if ($isMysql) {
        $dup = array_map(static fn(string $c): string => "$c = VALUES($c)", $cols);
        return $sql . ' ON DUPLICATE KEY UPDATE ' . implode(', ', $dup);
    }
    $set = array_map(static fn(string $c): string => "$c = excluded.$c", $cols);
    return $sql . ' ON CONFLICT(' . $conflictCol . ') DO UPDATE SET ' . implode(', ', $set);
}

function spyUpsert(PDO $db, string $table, string $conflictCol, array $cols, array $updateCols = []): void
{
    $sql = spyUpsertSql($table, $conflictCol, array_keys($cols), $updateCols, spyIsMysql());
    $db->prepare($sql)->execute(array_values($cols));
}

/* ==========================================================================
 * 五、阶段推进 —— 房主提前推进与 cron 超时推进共用
 * ========================================================================== */

/** 打开当前阶段的计时；描述阶段还要定首位发言人。 */
function spyOpenPhase(PDO $db, array $room): array
{
    $roomId = (int)$room['id'];
    $round = (int)$room['round'];
    $phase = (string)$room['phase'];
    $seats = spySeats($db, $roomId);
    $targets = spyAliveTargets($seats, $round);
    $seconds = SpyRules\phase_seconds((string)$room['timer_profile'], $phase, max(1, count($targets)));

    $speakerSeat = 0;
    if ($phase === 'day' && $targets) {
        // 起点每回合后移一位，没有人会连着三回合第一个发言。
        $speakerSeat = $targets[($round - 1) % count($targets)];
    }

    $deadline = ($phase === 'lobby' || $phase === 'over') ? 0 : spyNow() + $seconds;
    $db->prepare('UPDATE spy_rooms SET deadline_at = ?, speaker_seat = ? WHERE id = ?')
        ->execute([$deadline, $speakerSeat, $roomId]);

    $room['deadline_at'] = $deadline;
    $room['speaker_seat'] = $speakerSeat;
    return $room;
}

function spyStageSettled(PDO $db, int $roomId, int $round, string $stage): bool
{
    $stmt = $db->prepare('SELECT id FROM spy_round_outcomes WHERE room_id = ? AND round = ? AND stage = ?');
    $stmt->execute([$roomId, $round, $stage]);
    return (bool)$stmt->fetchColumn();
}

function spyWriteOutcome(PDO $db, int $roomId, int $round, string $stage, array $data): void
{
    $stmt = $db->prepare(
        'INSERT INTO spy_round_outcomes
            (room_id, round, stage, eliminated_seat, eliminated_role, out_by, tie, host_ruling, tally, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    $stmt->execute([
        $roomId, $round, $stage,
        $data['eliminated_seat'] ?? null,
        (string)($data['eliminated_role'] ?? ''),
        (string)($data['out_by'] ?? ''),
        !empty($data['tie']) ? 1 : 0,
        (string)($data['host_ruling'] ?? ''),
        isset($data['tally']) ? json_encode($data['tally'], JSON_UNESCAPED_UNICODE) : null,
        spyNow(),
    ]);
}

function spyMarkOut(PDO $db, int $roomId, int $seat, int $round, string $by): void
{
    $stmt = $db->prepare('UPDATE spy_seats SET out_round = ?, out_by = ? WHERE room_id = ? AND seat = ?');
    $stmt->execute([$round, $by, $roomId, $seat]);
}

/**
 * 投票阶段结算。已有裁决记录（房主平票裁决过）时不重复计票。
 *
 * @return array{tie:bool,eliminated:?int}
 */
function spySettleVote(PDO $db, array $room): array
{
    $roomId = (int)$room['id'];
    $round = (int)$room['round'];
    if (spyStageSettled($db, $roomId, $round, 'vote')) {
        return ['tie' => false, 'eliminated' => null];
    }

    $seats = spySeats($db, $roomId);
    $targets = spyAliveTargets($seats, $round);

    $stmt = $db->prepare('SELECT from_seat, to_seat FROM spy_votes WHERE room_id = ? AND round = ?');
    $stmt->execute([$roomId, $round]);
    $ballots = [];
    foreach ($stmt->fetchAll() as $r) {
        $to = $r['to_seat'];
        $ballots[] = [
            'from' => (int)$r['from_seat'],
            'to'   => ($to === null || $to === '') ? null : (int)$to,
        ];
    }

    $tally = SpyRules\tally_votes($ballots, $targets);
    $eliminated = $tally['eliminated'] === null ? null : (int)$tally['eliminated'];
    $role = '';
    if ($eliminated !== null) {
        foreach ($seats as $s) {
            if ((int)$s['seat'] === $eliminated) { $role = (string)$s['role']; break; }
        }
        spyMarkOut($db, $roomId, $eliminated, $round, SpyRules\OUT_BY_VOTE);
    }

    spyWriteOutcome($db, $roomId, $round, 'vote', [
        'eliminated_seat' => $eliminated,
        'eliminated_role' => $role,
        'out_by'          => $eliminated !== null ? SpyRules\OUT_BY_VOTE : '',
        'tie'             => $tally['tie'],
        'tally'           => ['rows' => $tally['rows'], 'abstain' => $tally['abstain'], 'cast' => $tally['cast']],
    ]);
    $db->prepare('UPDATE spy_rooms SET vote_sealed_at = ? WHERE id = ?')->execute([spyNow(), $roomId]);

    return ['tie' => (bool)$tally['tie'], 'eliminated' => $eliminated];
}

/** 夜晚结算：卧底众数刀，非卧底交刀判自刀。 */
function spySettleNight(PDO $db, array $room): void
{
    $roomId = (int)$room['id'];
    $round = (int)$room['round'];
    if (spyStageSettled($db, $roomId, $round, 'night')) return;

    $seats = spySeats($db, $roomId);
    $targets = spyAliveTargets($seats, $round);
    $bySeat = [];
    foreach ($seats as $s) $bySeat[(int)$s['seat']] = $s;

    $stmt = $db->prepare('SELECT from_seat, target_seat FROM spy_night_actions WHERE room_id = ? AND round = ?');
    $stmt->execute([$roomId, $round]);
    $actions = [];
    foreach ($stmt->fetchAll() as $r) {
        $from = (int)$r['from_seat'];
        $target = $r['target_seat'];
        $actions[] = [
            'seat'   => $from,
            'role'   => (string)($bySeat[$from]['role'] ?? ''),
            'target' => ($target === null || $target === '') ? null : (int)$target,
        ];
    }

    $night = SpyRules\resolve_night($actions, $targets);
    foreach ($night['killed'] as $seat) {
        spyMarkOut($db, $roomId, (int)$seat, $round, SpyRules\OUT_BY_KILL);
    }
    foreach ($night['selfKills'] as $seat) {
        spyMarkOut($db, $roomId, (int)$seat, $round, SpyRules\OUT_BY_SELF_KILL);
    }

    $killed = $night['killed'][0] ?? null;
    $selfKill = $night['selfKills'][0] ?? null;
    $first = $killed ?? $selfKill;

    spyWriteOutcome($db, $roomId, $round, 'night', [
        'eliminated_seat' => $first === null ? null : (int)$first,
        'eliminated_role' => $first === null ? '' : (string)($bySeat[(int)$first]['role'] ?? ''),
        'out_by'          => $killed !== null ? SpyRules\OUT_BY_KILL
            : ($selfKill !== null ? SpyRules\OUT_BY_SELF_KILL : ''),
        'tally'           => [
            'killed'     => $night['killed'],
            'self_kills' => $night['selfKills'],
            'notes'      => $night['notes'],
        ],
    ]);
}

/**
 * 推进一个阶段。房主的「提前进入下一阶段」与 cron 的「超时自动推进」都走这里，
 * 保证两条路径裁决一致。前置：调用方已在事务内。
 *
 * @return array{phase:string,round:int,ended:bool,winner:?string,tie:bool}
 */
function spyAdvance(PDO $db, int $roomId, string $trigger = 'host'): array
{
    $room = spyLockRoom($db, $roomId);
    if (!$room) throw new SpyError('room_not_found', 404);
    if ((string)$room['status'] !== 'playing') {
        return [
            'phase'  => (string)$room['phase'],
            'round'  => (int)$room['round'],
            'ended'  => (string)$room['status'] === 'ended',
            'winner' => (string)$room['winner'] !== '' ? (string)$room['winner'] : null,
            'tie'    => false,
        ];
    }

    $phase = (string)$room['phase'];
    $round = (int)$room['round'];
    $tie = false;
    $out = null;

    if ($phase === 'vote') {
        $settled = spySettleVote($db, $room);
        $tie = $settled['tie'];
        $out = $settled['eliminated'];
    } elseif ($phase === 'night') {
        spySettleNight($db, $room);
    }

    // 白板猜词等外部路径可能已经在这中间结束了本局。
    $room = spyLockRoom($db, $roomId);
    if (!$room || (string)$room['status'] !== 'playing') {
        return [
            'phase'  => SpyRules\PHASE_OVER,
            'round'  => (int)($room['round'] ?? $round),
            'ended'  => true,
            'winner' => (string)($room['winner'] ?? '') ?: null,
            'tie'    => false,
        ];
    }

    $win = SpyRules\evaluate_win(spyRuleSeats(spySeats($db, $roomId)));
    if ($win['over']) {
        spyFinish($db, $roomId, (string)$win['winner'], (string)$win['reason']);
        return [
            'phase' => SpyRules\PHASE_OVER, 'round' => $round,
            'ended' => true, 'winner' => (string)$win['winner'], 'tie' => false,
        ];
    }

    // 平票且无人裁决：停在投票阶段等房主，不自动进夜晚。
    if ($tie) {
        spyBump($db, $roomId, 'vote-tie', ['round' => $round, 'trigger' => $trigger]);
        return ['phase' => 'vote', 'round' => $round, 'ended' => false, 'winner' => null, 'tie' => true];
    }

    $next = SpyRules\next_phase($phase, $round);
    $db->prepare('UPDATE spy_rooms SET phase = ?, round = ? WHERE id = ?')
        ->execute([$next['phase'], $next['round'], $roomId]);
    $room = spyLoadRoom($db, (string)$roomId);
    $room = spyOpenPhase($db, $room);
    spyBump($db, $roomId, 'phase', [
        'phase'   => $next['phase'],
        'round'   => $next['round'],
        'trigger' => $trigger,
        'out'     => $out,
    ]);

    return ['phase' => $next['phase'], 'round' => $next['round'], 'ended' => false, 'winner' => null, 'tie' => false];
}

/** 描述阶段：当前发言人交卷后把话筒交给下一位存活者。 */
function spyAdvanceSpeaker(PDO $db, array $room, int $seat): array
{
    $seats = spySeats($db, (int)$room['id']);
    $order = SpyRules\speaking_order(spyRuleSeats($seats), (int)$room['round']);
    $idx = array_search($seat, $order, true);
    $done = $idx === false || $idx === count($order) - 1;

    $nextSeat = 0;
    if (!$done) {
        // 只跳过本回合还没交卷的人，重复交卷不会把话筒推过头。
        for ($i = $idx + 1; $i < count($order); $i++) {
            $stmt = $db->prepare('SELECT id FROM spy_sentences WHERE room_id = ? AND round = ? AND seat = ?');
            $stmt->execute([(int)$room['id'], (int)$room['round'], $order[$i]]);
            if (!$stmt->fetchColumn()) { $nextSeat = $order[$i]; break; }
        }
        $done = $nextSeat === 0;
    }

    $db->prepare('UPDATE spy_rooms SET speaker_seat = ? WHERE id = ?')
        ->execute([$nextSeat, (int)$room['id']]);
    $room['speaker_seat'] = $nextSeat;
    return ['room' => $room, 'complete' => $done];
}

/* ==========================================================================
 * 六、开局与结束
 * ========================================================================== */

/** 从词库取一对词：优先取用得最少的，同数量者随机。 */
function spyPickPair(PDO $db): ?array
{
    $stmt = $db->prepare('SELECT id, a, b, level, similarity, used_count FROM spy_word_pairs WHERE enabled = 1');
    $stmt->execute();
    $rows = $stmt->fetchAll();
    if (!$rows) return null;

    $min = min(array_column($rows, 'used_count'));
    $pool = array_values(array_filter($rows, static fn(array $r): bool => (int)$r['used_count'] === (int)$min));
    return $pool[array_rand($pool)] ?? null;
}

/** 有效身份分配：房主显式配置且与入座人数相符则采纳，否则套默认表。 */
function spyResolveDistribution(array $room, int $players): array
{
    $stated = [
        'civilian' => (int)$room['dist_civilian'],
        'spy'      => (int)$room['dist_spy'],
        'blank'    => (int)$room['dist_blank'],
    ];
    if (array_sum($stated) === $players && SpyRules\validate_distribution($players, $stated) === null) {
        return $stated;
    }
    return SpyRules\default_distribution($players) ?? $stated;
}

/**
 * 开局：发身份、发词、进入描述阶段。前置：调用方已在事务内。
 *
 * @return array{players:int,distribution:array}
 */
function spyStart(PDO $db, int $roomId): array
{
    $room = spyLockRoom($db, $roomId);
    if (!$room) throw new SpyError('room_not_found', 404);
    if ((string)$room['status'] === 'playing') throw new SpyError('game_started', 409);
    if ((string)$room['status'] === 'ended') throw new SpyError('room_closed', 409);

    $seats = spySeats($db, $roomId);
    $players = count($seats);
    if ($players < SpyRules\MIN_PLAYERS) throw new SpyError('players_not_enough', 409);
    if ($players > (int)$room['cap']) throw new SpyError('room_full', 409);

    $dist = spyResolveDistribution($room, $players);

    // 主持人点名的身份优先：先数各 preset 数量，配置配额不足时抬到 preset 数，
    // 好人数随 playing 总数回推（players − spy − blank），再统一过 validate_distribution。
    $presetOf = [];
    foreach ($seats as $s) {
        $preset = (string)($s['role_preset'] ?? '');
        if ($preset !== '') $presetOf[(int)$s['seat']] = $preset;
    }
    if ($presetOf) {
        $need = ['spy' => 0, 'blank' => 0];
        foreach ($presetOf as $preset) {
            if (isset($need[$preset])) $need[$preset]++;
        }
        foreach ($need as $role => $count) {
            $dist[$role] = max((int)$dist[$role], $count);
        }
        $dist['civilian'] = $players - (int)$dist['spy'] - (int)$dist['blank'];
        if (SpyRules\validate_distribution($players, $dist) !== null) {
            throw new SpyError('distribution_invalid', 409);
        }
    } elseif (SpyRules\validate_distribution($players, $dist) !== null) {
        throw new SpyError('distribution_invalid', 409);
    }

    // 已点名座位直接落库；其余座位把剩余配额随机分掉。
    $dealt = [];
    foreach ($presetOf as $seat => $preset) $dealt[$seat] = $preset;
    $open = array_values(array_filter(
        array_map(static fn(array $s): int => (int)$s['seat'], $seats),
        static fn(int $seat): bool => !isset($presetOf[$seat])
    ));
    if ($open) {
        $rest = [
            'civilian' => max(0, (int)$dist['civilian'] - count(array_filter($presetOf, static fn($p) => $p === 'civilian'))),
            'spy'      => max(0, (int)$dist['spy'] - count(array_filter($presetOf, static fn($p) => $p === 'spy'))),
            'blank'    => max(0, (int)$dist['blank'] - count(array_filter($presetOf, static fn($p) => $p === 'blank'))),
        ];
        foreach (SpyRules\deal_roles($open, $rest) as $seat => $role) $dealt[$seat] = $role;
    }
    $upd = $db->prepare('UPDATE spy_seats SET role = ?, role_preset = ?, out_round = NULL, out_by = ? WHERE room_id = ? AND seat = ?');
    foreach ($seats as $s) {
        $seat = (int)$s['seat'];
        $upd->execute([(string)$dealt[$seat], $presetOf[$seat] ?? '', '', $roomId, $seat]);
    }

    $wordA = (string)$room['word_a'];
    $wordB = (string)$room['word_b'];
    $now = spyNow();
    if ($wordA !== '' && $wordB !== '') {
        // 主持人自定义词对：不入词库、不涨 used_count。
        spyUpsert($db, 'spy_words', 'room_id', [
            'room_id'       => $roomId,
            'pair_id'       => 0,
            'civilian_word' => $wordA,
            'spy_word'      => $wordB,
            'difficulty'    => 'custom',
            'similarity'    => 'custom',
            'dealt_at'      => $now,
        ]);
    } else {
        $pair = spyPickPair($db);
        if (!$pair) throw new SpyError('word_bank_empty', 500);
        spyUpsert($db, 'spy_words', 'room_id', [
            'room_id'       => $roomId,
            'pair_id'       => (int)$pair['id'],
            'civilian_word' => (string)$pair['a'],
            'spy_word'      => (string)$pair['b'],
            'difficulty'    => (string)$pair['level'],
            'similarity'    => (string)$pair['similarity'],
            'dealt_at'      => $now,
        ]);
        // 「已用 N 局」从这里来，不再由前端假装一个数。
        $db->prepare('UPDATE spy_word_pairs SET used_count = used_count + 1 WHERE id = ?')
            ->execute([(int)$pair['id']]);
    }

    // 上一局的痕迹必须清干净，否则新局第 1 回合会直接读到旧裁决而拒绝结算。
    $db->prepare('DELETE FROM spy_round_outcomes WHERE room_id = ?')->execute([$roomId]);
    $db->prepare('DELETE FROM spy_sentences WHERE room_id = ?')->execute([$roomId]);
    $db->prepare('DELETE FROM spy_votes WHERE room_id = ?')->execute([$roomId]);
    $db->prepare('DELETE FROM spy_night_actions WHERE room_id = ?')->execute([$roomId]);
    $db->prepare('DELETE FROM spy_blank_guesses WHERE room_id = ?')->execute([$roomId]);
    $db->prepare('DELETE FROM spy_results WHERE room_id = ?')->execute([$roomId]);

    $db->prepare(
        "UPDATE spy_rooms SET status = 'playing', phase = 'day', round = 1,
            dist_civilian = ?, dist_spy = ?, dist_blank = ?,
            winner = '', revote_used = 0, joined = ?
         WHERE id = ?"
    )->execute([(int)$dist['civilian'], (int)$dist['spy'], (int)$dist['blank'], $players, $roomId]);

    $room = spyLoadRoom($db, (string)$roomId);
    spyOpenPhase($db, $room);
    spyBump($db, $roomId, 'game-started', ['players' => $players]);

    return ['players' => $players, 'distribution' => $dist];
}

/**
 * 结算奖励。三条与原型 Results 屏的 key 一一对应：
 *   best-civilian / best-spy —— 同阵营内「存活到最后 > 出局回合更晚 > 被票更少」，
 *   self-kill —— 最近一次自刀者，没有就不发。
 * 原型把这三条连文案一起写死在 gameMock.js:349，这里改为从 spy_votes/spy_seats 真实算出。
 */
function spyComputeAwards(PDO $db, int $roomId, array $seats): array
{
    $stmt = $db->prepare(
        'SELECT to_seat, COUNT(*) AS n FROM spy_votes WHERE room_id = ? AND to_seat IS NOT NULL GROUP BY to_seat'
    );
    $stmt->execute([$roomId]);
    $votesAgainst = [];
    foreach ($stmt->fetchAll() as $r) {
        $votesAgainst[(int)$r['to_seat']] = (int)$r['n'];
    }

    $rank = static function (array $a, array $b) use ($votesAgainst): int {
        $ao = spyOutRound($a['out_round'] ?? null);
        $bo = spyOutRound($b['out_round'] ?? null);
        if (($ao === null) !== ($bo === null)) return $ao === null ? -1 : 1;
        if ($ao !== $bo) return $bo <=> $ao;
        return ($votesAgainst[(int)$a['seat']] ?? 0) <=> ($votesAgainst[(int)$b['seat']] ?? 0);
    };

    $why = static function (array $s) use ($votesAgainst): string {
        $seat = (int)$s['seat'];
        $n = $votesAgainst[$seat] ?? 0;
        $out = spyOutRound($s['out_round'] ?? null);
        return $out === null
            ? sprintf('全程未出局，累计只收到 %d 票。', $n)
            : sprintf('撑到第 %d 回合，累计收到 %d 票。', $out, $n);
    };

    $byRole = [];
    foreach ($seats as $s) $byRole[(string)$s['role']][] = $s;

    $awards = [];
    foreach ([
        SpyRules\ROLE_CIVILIAN => ['best-civilian', '最会描述的好人'],
        SpyRules\ROLE_SPY      => ['best-spy', '最隐蔽的卧底'],
    ] as $role => [$key, $label]) {
        $rows = $byRole[$role] ?? [];
        if (!$rows) continue;
        usort($rows, $rank);
        $best = $rows[0];
        $awards[] = [
            'key'   => $key,
            'label' => $label,
            'seat'  => (int)$best['seat'],
            'name'  => (string)$best['nick'],
            'why'   => $why($best),
        ];
    }

    $selfKill = null;
    foreach ($seats as $s) {
        if ((string)$s['out_by'] !== SpyRules\OUT_BY_SELF_KILL) continue;
        $round = (int)spyOutRound($s['out_round'] ?? null);
        if ($selfKill === null || $round > $selfKill['round']) {
            $selfKill = [
                'seat'  => (int)$s['seat'],
                'name'  => (string)$s['nick'],
                'round' => $round,
            ];
        }
    }
    if ($selfKill !== null) {
        $awards[] = [
            'key'   => 'self-kill',
            'label' => '本轮自刀',
            'seat'  => $selfKill['seat'],
            'name'  => $selfKill['name'],
            'why'   => sprintf('第 %d 回合夜晚误提交刀人指令，按规则判定自刀出局。', $selfKill['round']),
        ];
    }

    return $awards;
}

/**
 * 结束一局。由 spyAdvance 内的胜负判定调用，也可能由白板猜中两词直接触发。
 * 前置：调用方已在事务内。
 */
function spyFinish(PDO $db, int $roomId, string $winner, string $reason): void
{
    $room = spyLockRoom($db, $roomId);
    if (!$room || (string)$room['status'] === 'ended') return;

    $seats = spySeats($db, $roomId);
    $round = (int)$room['round'];

    $reveal = [];
    foreach ($seats as $s) {
        $outBy = (string)$s['out_by'];
        $reveal[] = [
            'seat'       => (int)$s['seat'],
            'nick'       => (string)$s['nick'],
            'role'       => (string)$s['role'],
            'role_label' => SpyRules\role_label((string)$s['role']),
            'out_round'  => spyOutRound($s['out_round'] ?? null),
            'out_by'     => $outBy,
            'out_label'  => $outBy === '' ? '' : SpyRules\out_label($outBy),
        ];
    }

    spyUpsert($db, 'spy_results', 'room_id', [
        'room_id'    => $roomId,
        'winner'     => $winner,
        'reason'     => $reason,
        'rounds'     => $round,
        'awards'     => json_encode(spyComputeAwards($db, $roomId, $seats), JSON_UNESCAPED_UNICODE),
        'reveal'     => json_encode($reveal, JSON_UNESCAPED_UNICODE),
        'settled_at' => spyNow(),
    ]);

    $db->prepare("UPDATE spy_rooms SET status = 'ended', phase = 'over', winner = ?, deadline_at = 0, speaker_seat = 0 WHERE id = ?")
        ->execute([$winner, $roomId]);
    spyBump($db, $roomId, 'game-over', ['winner' => $winner, 'rounds' => $round]);
}

/* ==========================================================================
 * 七、可见性投影
 * ========================================================================== */

/**
 * 第 R 回合某阶段的裁决记录是否已可对普通玩家公开。
 * 不公开就不会带出「他是被投出去的还是被刀出去的」，也就不会反推出身份。
 */
function spyOutcomeVisible(array $room, int $outRound, string $stage): bool
{
    $rank = SPY_PHASE_RANK[(string)$room['phase']] ?? -1;
    $gate = SPY_SETTLE_RANK[$stage] ?? 99;
    if ($outRound < (int)$room['round']) return true;
    if ($outRound > (int)$room['round']) return false;
    return $rank > $gate;
}

/** 房主平票裁决留下的记录：投票阶段已封票且无人出局。 */
function spyTieOpen(PDO $db, array $room): bool
{
    if ((string)$room['phase'] !== 'vote') return false;
    $stmt = $db->prepare('SELECT eliminated_seat, tie FROM spy_round_outcomes WHERE room_id = ? AND round = ? AND stage = ?');
    $stmt->execute([(int)$room['id'], (int)$room['round'], 'vote']);
    $row = $stmt->fetch();
    return $row !== false && (int)$row['tie'] === 1 && $row['eliminated_seat'] === null;
}

/**
 * 圆桌快照：一次请求拿到「我看到的那个房间」。
 *
 * 泄露面全在这一个函数里，所以它只读不写，并逐字段挑着往外发。
 *
 * @param array|null $mySeat 我的座位行；旁观者为 null
 * @param bool       $referee 未入座的房主
 */
function spyTableSnapshot(PDO $db, array $room, ?array $mySeat, bool $referee = false, int $since = 0, bool $isHost = false): array
{
    $roomId = (int)$room['id'];
    $now = spyNow();
    $round = (int)$room['round'];
    $phase = (string)$room['phase'];
    $over = (string)$room['status'] === 'ended' || $phase === SpyRules\PHASE_OVER;
    $reveal = $over || $referee;
    // 开局前没有任何身份可泄，房主（含已入座）此时可以管理词对与点名；
    // 开局后这两类信息只回裁判，避免入座房主借快照作弊。
    $hostWaiting = $isHost && (string)$room['status'] === 'waiting';

    $seats = spySeats($db, $roomId);
    $targets = spyAliveTargets($seats, $round);
    $order = SpyRules\speaking_order(spyRuleSeats($seats), $round);

    // ---- 描述 ----
    $stmt = $db->prepare('SELECT round, seat, body, skipped, submitted_at FROM spy_sentences WHERE room_id = ?');
    $stmt->execute([$roomId]);
    $sentences = [];
    $spectateDelay = max(0, (int)$room['spectate_delay']);
    $lagged = ($mySeat === null) && !$referee;
    foreach ($stmt->fetchAll() as $r) {
        // 旁观者视图按 spectate_delay 滞后，防止「站在人背后看正在打的局」。
        if ($lagged && (int)$r['submitted_at'] > $now - $spectateDelay) continue;
        $sentences[(int)$r['round']][(int)$r['seat']] = [
            'body'    => (string)$r['body'],
            'skipped' => (int)$r['skipped'] === 1,
        ];
    }

    // ---- 投票：只发「投没投」，票面在封票前不发 ----
    $stmt = $db->prepare('SELECT from_seat FROM spy_votes WHERE room_id = ? AND round = ?');
    $stmt->execute([$roomId, $round]);
    $voted = array_fill_keys(array_map('intval', array_column($stmt->fetchAll(), 'from_seat')), true);

    // ---- 夜晚：只发进度计数。required 用发牌数而不是存活卧底数，
    //      否则「还剩几个卧底没行动」会直接泄露昨夜谁死了。 ----
    $stmt = $db->prepare('SELECT COUNT(*) FROM spy_night_actions WHERE room_id = ? AND round = ?');
    $stmt->execute([$roomId, $round]);
    $nightRequired = (int)$room['dist_spy'];
    $nightSubmitted = min((int)$stmt->fetchColumn(), $nightRequired);

    // ---- 白板猜词：只发「这个座位交过」，内容只回给本人 ----
    $stmt = $db->prepare('SELECT seat, guess_a, guess_b, result FROM spy_blank_guesses WHERE room_id = ?');
    $stmt->execute([$roomId]);
    $guesses = [];
    foreach ($stmt->fetchAll() as $r) {
        $guesses[(int)$r['seat']] = ['submitted' => true, 'result' => (string)$r['result'],
                                     'guess_a' => (string)$r['guess_a'], 'guess_b' => (string)$r['guess_b']];
    }

    $seatView = [];
    foreach ($seats as $s) {
        $seat = (int)$s['seat'];
        $outRound = spyOutRound($s['out_round'] ?? null);
        $outBy = (string)$s['out_by'];
        $row = [
            'seat'       => $seat,
            'nick'       => (string)$s['nick'],
            'avatar'     => (string)$s['avatar'],
            'ready'      => (int)$s['ready_at'] > 0,
            'online'     => (int)$s['last_seen_at'] >= $now - SPY_ONLINE_WINDOW,
            'out_round'  => $outRound,
            'speaking'   => $phase === 'day' && (int)$room['speaker_seat'] === $seat,
            'has_voted'  => isset($voted[$seat]),
            'has_spoken' => isset($sentences[$round][$seat]),
            'guessed'    => isset($guesses[$seat]),
            // 裁决公开前 out_by 留空：「他被投出去」和「他被刀」是两条不同的信息量。
            'out_by'     => $outRound === null || spyOutcomeVisible($room, $outRound, $outBy === SpyRules\OUT_BY_KILL || $outBy === SpyRules\OUT_BY_SELF_KILL ? 'night' : 'vote')
                ? $outBy : '',
        ];
        if ($reveal) $row['role'] = (string)$s['role'];
        if ($referee || $hostWaiting) $row['preset'] = (string)($s['role_preset'] ?? '');
        if ($lagged) {
            $row['has_voted'] = false;
            $row['has_spoken'] = false;
            $row['guessed'] = false;
        }
        $seatView[] = $row;
    }

    // ---- 我 ----
    $me = null;
    if ($mySeat !== null) {
        $mySeatNo = (int)$mySeat['seat'];
        $myRole = (string)$mySeat['role'];
        $alive = in_array($mySeatNo, $targets, true);
        $me = [
            'seat'      => $mySeatNo,
            'nick'      => (string)$mySeat['nick'],
            'ready'     => (int)$mySeat['ready_at'] > 0,
            'out_round' => spyOutRound($mySeat['out_round'] ?? null),
            'is_speaking' => $phase === 'day' && (int)$room['speaker_seat'] === $mySeatNo && $alive,
            'can_speak' => $phase === 'day' && (int)$room['speaker_seat'] === $mySeatNo && $alive
                          && !isset($sentences[$round][$mySeatNo]),
            'can_vote'  => $phase === 'vote' && $alive && !isset($voted[$mySeatNo]) && !spyTieOpen($db, $room),
            'can_guess' => false,
        ];
        if ($reveal) $me['role'] = $myRole;

        if ($myRole === SpyRules\ROLE_BLANK) {
            // 白板必须知道自己是谁，否则不知道该猜什么。
            $me['role'] = SpyRules\ROLE_BLANK;
            $me['word'] = '';
            $me['can_guess'] = !$over && !isset($guesses[$mySeatNo]);
            if (isset($guesses[$mySeatNo])) {
                $me['guess'] = [
                    'guess_a' => $guesses[$mySeatNo]['guess_a'],
                    'guess_b' => $guesses[$mySeatNo]['guess_b'],
                ];
            }
        } elseif ($myRole !== '') {
            // 平民与卧底同样只拿到一个词，拿不到 role —— 卧底由此不知道自己是谁。
            $me['word'] = spyMyWord($db, $roomId, $myRole);
        }
    }

    // ---- 历史裁决 ----
    $outcomes = [];
    $stmt = $db->prepare(
        'SELECT round, stage, eliminated_seat, out_by, tie, host_ruling, tally
         FROM spy_round_outcomes WHERE room_id = ? ORDER BY round, stage'
    );
    $stmt->execute([$roomId]);
    foreach ($stmt->fetchAll() as $r) {
        $oRound = (int)$r['round'];
        $stage = (string)$r['stage'];
        if (!$reveal && !spyOutcomeVisible($room, $oRound, $stage)) continue;
        $outcomes[] = [
            'round'           => $oRound,
            'stage'           => $stage,
            'eliminated_seat' => ($r['eliminated_seat'] === null || $r['eliminated_seat'] === '') ? null : (int)$r['eliminated_seat'],
            'out_by'          => (string)$r['out_by'],
            'tie'             => (int)$r['tie'] === 1,
            'host_ruling'     => (string)$r['host_ruling'],
            'tally'           => spyDecodeJson($r['tally']),
        ];
    }

    // ---- 结果与词对 ----
    $result = null;
    $words = null;
    if ($over) {
        $stmt = $db->prepare('SELECT winner, reason, rounds, awards, reveal, settled_at FROM spy_results WHERE room_id = ?');
        $stmt->execute([$roomId]);
        $r = $stmt->fetch();
        if ($r) {
            $result = [
                'winner'     => (string)$r['winner'],
                'reason'     => (string)$r['reason'],
                'rounds'     => (int)$r['rounds'],
                'awards'     => spyDecodeJson($r['awards']),
                'reveal'     => spyDecodeJson($r['reveal']),
                'settled_at' => (int)$r['settled_at'],
            ];
        }
    }
    if ($referee || $over) {
        $words = spyWordPair($db, $roomId);
    }

    $deadline = (int)$room['deadline_at'];
    $distribution = (int)$room['dist_civilian'] > 0 || (int)$room['dist_spy'] > 0 || (int)$room['dist_blank'] > 0
        ? [
            'civilian' => (int)$room['dist_civilian'],
            'spy'      => (int)$room['dist_spy'],
            'blank'    => (int)$room['dist_blank'],
        ]
        : SpyRules\default_distribution(max(SpyRules\MIN_PLAYERS, count($seats)));

    return [
        'rev'     => (int)$room['rev'],
        'changed' => true,
        'room'    => [
            'id'             => $roomId,
            'code'           => (string)$room['code'],
            'name'           => (string)$room['name'],
            'phase'          => $phase,
            'round'          => $round,
            'status'         => (string)$room['status'],
            'cap'            => (int)$room['cap'],
            'joined'         => count($seats),
            'distribution'   => $distribution,
            'timer_profile'  => (string)$room['timer_profile'],
            'speaker_seat'   => (int)$room['speaker_seat'],
            'speaking_order' => $order,
            'targets'        => $targets,
            'revote_used'    => (int)$room['revote_used'] === 1,
            'tie_open'       => spyTieOpen($db, $room),
            'spectate'       => (int)$room['spectate'] === 1,
            'spectate_delay' => $spectateDelay,
            'need_code'      => (int)$room['need_code'] === 1,
            'host_user_id'   => (int)$room['host_user_id'],
            'host_seat'      => spyHostSeat($db, $roomId, (int)$room['host_user_id']),
            'can_control'    => $isHost,
            'word_a'         => ($referee || $hostWaiting) ? (string)$room['word_a'] : '',
            'word_b'         => ($referee || $hostWaiting) ? (string)$room['word_b'] : '',
            'server_now'     => $now,
            'deadline_at'    => $deadline,
            'remaining'      => $deadline > 0 ? max(0, $deadline - $now) : null,
            'winner'         => $over ? (string)$room['winner'] : '',
        ],
        'seats'     => $seatView,
        'me'        => $me,
        'sentences' => $sentences,
        'outcomes'  => $outcomes,
        'night'     => ['required' => $nightRequired, 'submitted' => $nightSubmitted],
        'words'     => $words,
        'result'    => $result,
        'events'    => $since > 0 ? spyEventsSince($db, $roomId, $since) : [],
    ];
}

/** @return array{civilian_word:string,spy_word:string,difficulty:string,similarity:string}|null */
function spyWordPair(PDO $db, int $roomId): ?array
{
    $stmt = $db->prepare('SELECT civilian_word, spy_word, difficulty, similarity FROM spy_words WHERE room_id = ?');
    $stmt->execute([$roomId]);
    $w = $stmt->fetch();
    if (!$w) return null;
    return [
        'civilian_word' => (string)$w['civilian_word'],
        'spy_word'      => (string)$w['spy_word'],
        'difficulty'    => (string)$w['difficulty'],
        'similarity'    => (string)$w['similarity'],
    ];
}

/** 我拿到的那一个词。白板没有词。 */
function spyMyWord(PDO $db, int $roomId, string $role): string
{
    $pair = spyWordPair($db, $roomId);
    if ($pair === null) return '';
    if ($role === SpyRules\ROLE_SPY) return $pair['spy_word'];
    if ($role === SpyRules\ROLE_CIVILIAN) return $pair['civilian_word'];
    return '';
}

/** 房主坐在第几号；没入座返回 null（也就是裁判）。 */
function spyHostSeat(PDO $db, int $roomId, int $hostUserId): ?int
{
    $stmt = $db->prepare('SELECT seat FROM spy_seats WHERE room_id = ? AND user_id = ?');
    $stmt->execute([$roomId, $hostUserId]);
    $seat = $stmt->fetchColumn();
    return $seat === false ? null : (int)$seat;
}

/** 大厅列表：只出公开字段，永远不带词。 */
function spyLobbyRooms(PDO $db, int $userId): array
{
    $stmt = $db->prepare(
        'SELECT r.id, r.code, r.name, r.phase, r.round, r.cap, r.status, r.timer_profile,
                r.spectate, r.need_code, r.last_activity_at,
                (SELECT COUNT(*) FROM spy_seats s WHERE s.room_id = r.id) AS seated,
                (SELECT COUNT(*) FROM spy_seats s WHERE s.room_id = r.id AND s.user_id = ?) AS mine,
                (r.host_user_id = ?) AS is_host
         FROM spy_rooms r
         WHERE r.status <> \'ended\'
         ORDER BY r.last_activity_at DESC
         LIMIT 40'
    );
    $stmt->execute([$userId, $userId]);
    $rooms = [];
    foreach ($stmt->fetchAll() as $r) {
        $seated = (int)$r['seated'];
        $rooms[] = [
            'id'       => (int)$r['id'],
            'code'     => (string)$r['code'],
            'name'     => (string)$r['name'],
            'phase'    => (string)$r['phase'],
            'round'    => (int)$r['round'],
            'cap'      => (int)$r['cap'],
            'seated'   => $seated,
            'status'   => (string)$r['status'],
            'mine'     => (int)$r['mine'] > 0,
            'is_host'  => (int)$r['is_host'] === 1,
            'joinable' => (string)$r['status'] === 'waiting' && $seated < (int)$r['cap'],
            'spectate' => (int)$r['spectate'] === 1,
            'need_code' => (int)$r['need_code'] === 1,
            'timer'    => (string)$r['timer_profile'],
        ];
    }
    return $rooms;
}

/* ==========================================================================
 * 八、幂等与回收
 * ========================================================================== */

/**
 * 写操作幂等：同一键重放直接回缓存响应，不再动状态。
 * $key 为空串时两函数都静默跳过，调用方无需判空。
 */
function spyIdemLookup(PDO $db, string $key): ?array
{
    if ($key === '') return null;
    $stmt = $db->prepare('SELECT response, expires_at FROM spy_idempotency WHERE idem_key = ?');
    $stmt->execute([$key]);
    $row = $stmt->fetch();
    if (!$row) return null;
    if ((int)$row['expires_at'] < spyNow()) {
        $db->prepare('DELETE FROM spy_idempotency WHERE idem_key = ?')->execute([$key]);
        return null;
    }
    $decoded = spyDecodeJson($row['response']);
    return $decoded ?: null;
}

function spyIdemRemember(PDO $db, string $key, int $roomId, array $payload, int $ttl = 600): void
{
    if ($key === '') return;
    $now = spyNow();
    spyUpsert($db, 'spy_idempotency', 'idem_key', [
        'idem_key'   => $key,
        'room_id'    => $roomId,
        'response'   => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        'created_at' => $now,
        'expires_at' => $now + $ttl,
    ], ['response', 'created_at']);
}

function spyIdemPrune(PDO $db): int
{
    $stmt = $db->prepare('DELETE FROM spy_idempotency WHERE expires_at < ?');
    $stmt->execute([spyNow()]);
    return $stmt->rowCount();
}

/**
 * 写操作统一包装：认人 → 查幂等缓存 → 事务执行 → 缓存并回发。
 *
 * 说清楚它的边界：这是省掉重复往返的优化，不是防重复执行的保险。
 * 「查缓存 → 执行 → 写缓存」三步之间有窗口，两个带同一个 key 的并发请求
 * 会都未命中而各执行一次。真正挡住重复执行的是状态机自己的约束 ——
 * spy_sentences / spy_votes / spy_night_actions 上的 UNIQUE(room_id, round, seat)
 * 让同一回合的第二次提交在库层就被拒。
 *
 * @param callable(PDO,array):array  返回要回给客户端的 payload（不含 success 键也行）
 */
function spyWrite(PDO $db, array $body, callable $fn): void
{
    $user = spyRequireLogin();
    $idemKey = spyIdempotencyKey($body);
    $cached = spyIdemLookup($db, $idemKey);
    if ($cached !== null) {
        spyRespond($cached, 200);
    }

    $payload = spyTransact($db, static fn() => $fn($db, $user, $body));
    if (!isset($payload['success'])) $payload = ['success' => true] + $payload;
    spyIdemRemember($db, $idemKey, 0, $payload);
    spyRespond($payload, 200);
}

/**
 * cron 主循环：把所有已过截止时刻的活房间各推进一个阶段。
 * 每个房间一个独立事务，一个失败不影响其余。
 *
 * @return array{advanced:int,errors:string[]}
 */
function spyTick(PDO $db, int $now = 0, int $limit = 50): array
{
    $now = $now > 0 ? $now : spyNow();
    $stmt = $db->prepare(
        "SELECT id FROM spy_rooms
         WHERE status = 'playing' AND deadline_at > 0 AND deadline_at <= ?
         ORDER BY deadline_at LIMIT " . max(1, min(200, $limit))
    );
    $stmt->execute([$now]);
    $ids = array_map('intval', array_column($stmt->fetchAll(), 'id'));

    $advanced = 0;
    $errors = [];
    foreach ($ids as $roomId) {
        try {
            spyBegin($db);
            $room = spyLockRoom($db, $roomId);
            if ($room && (int)$room['deadline_at'] <= $now) {
                spyAdvance($db, $roomId, 'timeout');
                $advanced++;
            }
            spyCommit($db);
        } catch (Throwable $e) {
            spyRollback($db);
            $errors[] = $roomId . ': ' . $e->getMessage();
        }
    }
    return ['advanced' => $advanced, 'errors' => $errors];
}

/**
 * 回收无人打理的房间。子表随 ON DELETE CASCADE 一起走。
 */
function spyReap(PDO $db, bool $dryRun = false): array
{
    $now = spyNow();
    $conds = [];
    foreach (SPY_IDLE_LIMIT as $status => $limit) {
        $conds[] = sprintf("(status = '%s' AND ? - last_activity_at > %d)", $status, $limit);
    }
    $stmt = $db->prepare('SELECT id FROM spy_rooms WHERE ' . implode(' OR ', $conds));
    $stmt->execute(array_fill(0, count($conds), $now));
    $ids = array_map('intval', array_column($stmt->fetchAll(), 'id'));

    if (!$dryRun && $ids) {
        $in = implode(',', array_fill(0, count($ids), '?'));
        $db->prepare("DELETE FROM spy_rooms WHERE id IN ($in)")->execute($ids);
    }
    return ['count' => count($ids), 'ids' => $ids, 'dry_run' => $dryRun];
}

/* ==========================================================================
 * 九、写命令
 *
 * 放在共享层而不是 api/ 里，是为了让整局游戏能在没有 HTTP 服务器的情况下
 * 被一路驱动并断言（scripts/test-spy-game.php）。端点只剩三件事：
 * 认人、取参、分发。
 * ========================================================================== */

/**
 * 载入房间与我的座位。前置：调用方已在事务内。
 *
 * @return array{room:array,seat:?array,seats:array,referee:bool}
 */
function spyContext(PDO $db, int $roomId, array $user): array
{
    $room = spyLockRoom($db, $roomId);
    if (!$room) throw new SpyError('room_not_found', 404);
    $seat = spySeatOf($db, $roomId, (int)$user['id']);
    return [
        'room'    => $room,
        'seat'    => $seat,
        'seats'   => spySeats($db, $roomId),
        'referee' => $seat === null && (int)$room['host_user_id'] === (int)$user['id'],
    ];
}

function spyRequireHost(array $room, array $user): void
{
    if ((int)$room['host_user_id'] !== (int)$user['id']) throw new SpyError('not_host', 403);
}

function spyRequirePlaying(array $room): void
{
    if ((string)$room['status'] === 'ended') throw new SpyError('room_closed', 409);
    if ((string)$room['status'] !== 'playing') throw new SpyError('game_not_started', 409);
}

function spyRequireWaiting(array $room): void
{
    if ((string)$room['status'] === 'playing') throw new SpyError('game_started', 409);
    if ((string)$room['status'] === 'ended') throw new SpyError('room_closed', 409);
}

function spyRequirePhase(array $room, array $phases): void
{
    if (!in_array((string)$room['phase'], $phases, true)) throw new SpyError('phase_wrong', 409);
}

/** 我的座位；未入座时抛错。旁观者不能代替某个座位提交动作。 */
function spyRequireSeat(array $ctx): array
{
    if ($ctx['seat'] === null) throw new SpyError('not_member', 403);
    return $ctx['seat'];
}

function spyRequireAlive(array $seat): void
{
    if (spyOutRound($seat['out_round'] ?? null) !== null) throw new SpyError('already_out', 409);
}

/** 最小空座位号。 */
function spyNextSeat(PDO $db, int $roomId, int $cap): int
{
    $taken = array_map('intval', array_column(spySeats($db, $roomId), 'seat'));
    for ($seat = 1; $seat <= $cap; $seat++) {
        if (!in_array($seat, $taken, true)) return $seat;
    }
    throw new SpyError('room_full', 409);
}

/**
 * 建房。建房者默认**不入座**，所以开局前他扮演裁判（能看词对、能推进阶段）。
 * 想下场玩就在自己房里再点一次入座，届时裁判权限立即失效。
 */
function spyCreateRoom(PDO $db, array $user, array $in): array
{
    $cap = max(SpyRules\MIN_PLAYERS, min(SpyRules\MAX_PLAYERS, spyInt($in['cap'] ?? 8, 8)));
    $profile = spyStr($in['timer_profile'] ?? SpyRules\DEFAULT_TIMER_PROFILE, 16);
    if (!array_key_exists($profile, SpyRules\TIMER_PROFILES)) $profile = SpyRules\DEFAULT_TIMER_PROFILE;
    $wantCountry = spyStr($in['country'] ?? 'china', 12);
    $country = in_array($wantCountry, ['china', 'japan'], true) ? $wantCountry : 'china';
    $needCode = spyBool($in['need_code'] ?? 0);
    $now = spyNow();

    $stmt = $db->prepare(
        "INSERT INTO spy_rooms
            (code, name, host_user_id, club_id, country, cap, timer_profile,
             spectate, spectate_delay, need_code, join_code, status, phase,
             host_last_seen_at, last_activity_at, rev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', 'lobby', ?, ?, 1)"
    );
    $stmt->execute([
        spyGenerateRoomCode($db),
        spyStr($in['name'] ?? '', 40) ?: '未命名房间',
        (int)$user['id'],
        spyInt($in['club_id'] ?? 0) > 0 ? spyInt($in['club_id']) : null,
        $country,
        $cap,
        $profile,
        spyBool($in['spectate'] ?? 1),
        max(0, min(600, spyInt($in['spectate_delay'] ?? 60, 60))),
        $needCode ? 1 : 0,
        $needCode ? spyGenerateJoinCode() : '',
        $now,
        $now,
    ]);

    $roomId = (int)$db->lastInsertId();
    spyBump($db, $roomId, 'room-created', ['cap' => $cap, 'timer' => $profile]);

    return ['room_id' => $roomId, 'code' => spyLoadRoom($db, (string)$roomId)['code'], 'referee' => true];
}

/** 入座。游戏中途不能补位 —— 词已按开局人数发完，补进来的人拿不到匹配的词。 */
function spyJoinRoom(PDO $db, int $roomId, array $user, string $joinCode = ''): array
{
    $ctx = spyContext($db, $roomId, $user);
    $room = $ctx['room'];

    if ($ctx['seat'] !== null) {
        // 重连：座位按 user_id 绑定，回到原位即可，不产生新座位。
        $db->prepare('UPDATE spy_seats SET last_seen_at = ? WHERE room_id = ? AND seat = ?')
            ->execute([spyNow(), $roomId, (int)$ctx['seat']['seat']]);
        return ['seat' => (int)$ctx['seat']['seat'], 'rejoined' => true, 'referee' => false];
    }

    spyRequireWaiting($room);
    if ((int)$room['need_code'] === 1) {
        $want = spyStr($room['join_code'], 16);
        if ($want !== '' && spyStr($joinCode, 16) !== $want) throw new SpyError('join_code_invalid', 403);
    }
    $seated = count($ctx['seats']);
    if ($seated >= (int)$room['cap']) throw new SpyError('room_full', 409);

    $seat = spyNextSeat($db, $roomId, (int)$room['cap']);
    $nick = spyStr($user['nickname'] ?: $user['username'], 64);
    $db->prepare('INSERT INTO spy_seats (room_id, seat, user_id, nick, avatar, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
        ->execute([$roomId, $seat, (int)$user['id'], $nick, spyStr($user['avatar_url'] ?? '', 255), spyNow()]);
    $db->prepare('UPDATE spy_rooms SET joined = ? WHERE id = ?')->execute([$seated + 1, $roomId]);
    spyBump($db, $roomId, 'seat-joined', ['seat' => $seat, 'nick' => $nick]);

    return ['seat' => $seat, 'rejoined' => false, 'referee' => false];
}

/**
 * 离座。仅限开局前 —— 游戏中离座会留下空位，
 * 而配额按开局人数算定，补位或留空都会破坏它，所以游戏中只能弃权不能离席。
 */
function spyLeaveRoom(PDO $db, int $roomId, array $user): array
{
    $ctx = spyContext($db, $roomId, $user);
    $seat = spyRequireSeat($ctx);
    spyRequireWaiting($ctx['room']);

    $db->prepare('DELETE FROM spy_seats WHERE room_id = ? AND seat = ?')->execute([$roomId, (int)$seat['seat']]);
    $db->prepare('UPDATE spy_rooms SET joined = (SELECT COUNT(*) FROM spy_seats WHERE room_id = ?) WHERE id = ?')
        ->execute([$roomId, $roomId]);
    spyBump($db, $roomId, 'seat-left', ['seat' => (int)$seat['seat']]);
    return ['seat' => (int)$seat['seat']];
}

/** 改配置。只允许开局前 —— 开局后改 cap/timer 等于中途换规则。 */
function spyUpdateRoom(PDO $db, int $roomId, array $user, array $patch): array
{
    $ctx = spyContext($db, $roomId, $user);
    spyRequireHost($ctx['room'], $user);
    spyRequireWaiting($ctx['room']);

    $allowed = [];
    foreach (SPY_ROOM_SETTINGS as $key) {
        if (array_key_exists($key, $patch)) $allowed[$key] = $patch[$key];
    }
    if (!$allowed) return ['changed' => []];

    if (isset($allowed['name'])) $allowed['name'] = spyStr($allowed['name'], 40) ?: '未命名房间';
    if (isset($allowed['cap'])) {
        $cap = max(SpyRules\MIN_PLAYERS, min(SpyRules\MAX_PLAYERS, spyInt($allowed['cap'], 8)));
        if ($cap < count($ctx['seats'])) throw new SpyError('room_full', 409);
        $allowed['cap'] = $cap;
    }
    if (isset($allowed['timer_profile']) && !array_key_exists($allowed['timer_profile'], SpyRules\TIMER_PROFILES)) {
        throw new SpyError('invalid_params', 400);
    }
    foreach (['spectate', 'need_code'] as $flag) {
        if (isset($allowed[$flag])) $allowed[$flag] = spyBool($allowed[$flag]);
    }
    if (isset($allowed['spectate_delay'])) {
        $allowed['spectate_delay'] = max(0, min(600, spyInt($allowed['spectate_delay'], 60)));
    }
    if (isset($allowed['country']) && !in_array($allowed['country'], ['china', 'japan'], true)) {
        throw new SpyError('invalid_params', 400);
    }
    // 自定义词对：两个一起给（或一起清空），词长 ≤24，归一化后不得相同。
    // 词面就是平民词/卧底词本身，所以它和词对一样只进裁判可见的通道，不进公开快照。
    if (isset($allowed['word_a']) || isset($allowed['word_b'])) {
        $a = spyStr($allowed['word_a'] ?? $ctx['room']['word_a'], 64);
        $b = spyStr($allowed['word_b'] ?? $ctx['room']['word_b'], 64);
        $len = static function (string $w): int {
            return function_exists('mb_strlen') ? mb_strlen($w, 'UTF-8') : strlen($w);
        };
        if ($len($a) > 24 || $len($b) > 24) throw new SpyError('invalid_params', 400);
        if (($a === '') !== ($b === '')) throw new SpyError('invalid_params', 400);
        if ($a !== '' && SpyRules\normalize_word($a) === SpyRules\normalize_word($b)) {
            throw new SpyError('invalid_params', 400);
        }
        $allowed['word_a'] = $a;
        $allowed['word_b'] = $b;
    }
    foreach (['dist_civilian', 'dist_spy', 'dist_blank'] as $k) {
        if (isset($allowed[$k])) $allowed[$k] = max(0, min(SpyRules\MAX_PLAYERS, spyInt($allowed[$k])));
    }
    if (array_key_exists('club_id', $allowed)) $allowed['club_id'] = spyInt($allowed['club_id']) ?: null;

    if (isset($allowed['dist_civilian']) || isset($allowed['dist_spy']) || isset($allowed['dist_blank'])) {
        $room = $ctx['room'];
        $trial = [
            'civilian' => spyInt($allowed['dist_civilian'] ?? $room['dist_civilian']),
            'spy'      => spyInt($allowed['dist_spy'] ?? $room['dist_spy']),
            'blank'    => spyInt($allowed['dist_blank'] ?? $room['dist_blank']),
        ];
        // 配额为 0 表示「按入座人数自适应」，此时不做等式校验。
        if (array_sum($trial) > 0 && count($ctx['seats']) > 0
            && SpyRules\validate_distribution(count($ctx['seats']), $trial) !== null) {
            throw new SpyError('distribution_invalid', 400);
        }
    }

    $sets = [];
    $args = [];
    foreach ($allowed as $k => $v) {
        $sets[] = "$k = ?";
        $args[] = $v;
    }
    // 口令一旦开启就固定下来，避免中途换码把已拿到旧码的人关在门外。
    if ((int)($allowed['need_code'] ?? 0) === 1 && spyStr($ctx['room']['join_code'], 16) === '') {
        $sets[] = 'join_code = ?';
        $args[] = spyGenerateJoinCode();
    }
    $args[] = $roomId;
    $db->prepare('UPDATE spy_rooms SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($args);
    spyBump($db, $roomId, 'room-config', ['changed' => array_keys($allowed)]);

    return ['changed' => array_keys($allowed)];
}

/** 开局前举手。就绪与否不构成开局门槛，房主随时可以开 —— 与原型一致。 */
function spySetReady(PDO $db, int $roomId, array $user, bool $ready): array
{
    $ctx = spyContext($db, $roomId, $user);
    $seat = spyRequireSeat($ctx);
    spyRequireWaiting($ctx['room']);

    $db->prepare('UPDATE spy_seats SET ready_at = ? WHERE room_id = ? AND seat = ?')
        ->execute([$ready ? spyNow() : 0, $roomId, (int)$seat['seat']]);
    spyBump($db, $roomId, 'seat-ready', ['seat' => (int)$seat['seat'], 'ready' => $ready ? 1 : 0]);
    return ['seat' => (int)$seat['seat'], 'ready' => $ready];
}

/**
 * 主持人手动点名身份。role 为空串表示撤销点名、该座位回到随机分配。
 * 点名只在开局前有效；开局时 spyStart 会按 preset 抬高配额再随机补满其余座位。
 */
function spyAssignRole(PDO $db, int $roomId, array $user, int $seat, string $role): array
{
    $ctx = spyContext($db, $roomId, $user);
    spyRequireHost($ctx['room'], $user);
    spyRequireWaiting($ctx['room']);
    if (!in_array($role, ['', 'civilian', 'spy', 'blank'], true)) {
        throw new SpyError('invalid_params', 400);
    }

    $occupied = [];
    foreach ($ctx['seats'] as $s) $occupied[(int)$s['seat']] = true;
    if (!isset($occupied[$seat])) throw new SpyError('seat_not_found', 404);

    $db->prepare('UPDATE spy_seats SET role_preset = ? WHERE room_id = ? AND seat = ?')
        ->execute([$role, $roomId, $seat]);
    spyBump($db, $roomId, 'seat-preset', ['seat' => $seat, 'role' => $role]);
    return ['seat' => $seat, 'role' => $role];
}

function spyHostStart(PDO $db, int $roomId, array $user): array
{
    $ctx = spyContext($db, $roomId, $user);
    spyRequireHost($ctx['room'], $user);
    return spyStart($db, $roomId);
}

/** 房主推进一个阶段 —— 与 cron 的超时推进共用 spyAdvance，两条路径裁决一致。 */
function spyHostAdvance(PDO $db, int $roomId, array $user): array
{
    $ctx = spyContext($db, $roomId, $user);
    spyRequireHost($ctx['room'], $user);
    spyRequirePlaying($ctx['room']);
    if (in_array((string)$ctx['room']['phase'], ['lobby', SpyRules\PHASE_OVER], true)) {
        throw new SpyError('phase_wrong', 409);
    }
    return spyAdvance($db, $roomId, 'host');
}

function spyHostClose(PDO $db, int $roomId, array $user): array
{
    $ctx = spyContext($db, $roomId, $user);
    spyRequireHost($ctx['room'], $user);
    $db->prepare('UPDATE spy_rooms SET status = ?, phase = ?, deadline_at = 0, speaker_seat = 0 WHERE id = ?')
        ->execute(['ended', SpyRules\PHASE_OVER, $roomId]);
    spyBump($db, $roomId, 'room-closed', []);
    return ['closed' => true];
}

/**
 * 描述阶段交卷。
 *
 * 「不能说出自己的词」必须在服务端判：只在客户端禁用等于没禁，
 * 而且词就躺在自己的快照里，客户端要绕过去毫无阻力。
 */
function spySubmitSentence(PDO $db, int $roomId, array $user, string $body, bool $skip = false): array
{
    $ctx = spyContext($db, $roomId, $user);
    $room = $ctx['room'];
    $seat = spyRequireSeat($ctx);
    spyRequirePlaying($room);
    spyRequirePhase($room, ['day']);
    spyRequireAlive($seat);

    $seatNo = (int)$seat['seat'];
    if ((int)$room['speaker_seat'] !== $seatNo) throw new SpyError('not_your_turn', 409);

    $round = (int)$room['round'];
    $text = spyStr($body, SpyRules\SENTENCE_MAX * 3);
    $skipped = 0;

    if ($skip) {
        $text = '';
        $skipped = 1;
    } else {
        if ($text === '') throw new SpyError('sentence_empty', 400);
        $len = function_exists('mb_strlen') ? mb_strlen($text, 'UTF-8') : strlen($text);
        if ($len > SpyRules\SENTENCE_MAX) throw new SpyError('sentence_too_long', 400);
        $mine = spyMyWord($db, $roomId, (string)$seat['role']);
        if ($mine !== '' && str_contains(SpyRules\normalize_word($text), SpyRules\normalize_word($mine))) {
            throw new SpyError('word_spill', 400);
        }
    }

    $ins = $db->prepare('INSERT INTO spy_sentences (room_id, round, seat, body, skipped, submitted_at) VALUES (?, ?, ?, ?, ?, ?)');
    try {
        $ins->execute([$roomId, $round, $seatNo, $text, $skipped, spyNow()]);
    } catch (PDOException $e) {
        // UNIQUE(room_id, round, seat)：同一句话重发按成功处理，但不重复推进话筒。
        return ['seat' => $seatNo, 'replay' => true, 'advanced' => null];
    }

    spyBump($db, $roomId, 'sentence', ['seat' => $seatNo, 'round' => $round, 'skipped' => $skipped]);

    $advanced = null;
    $fresh = spyLoadRoom($db, (string)$roomId);
    if ($fresh !== null) {
        $moved = spyAdvanceSpeaker($db, $fresh, $seatNo);
        if ($moved['complete']) $advanced = spyAdvance($db, $roomId, 'speakers-done');
    }

    return ['seat' => $seatNo, 'replay' => false, 'advanced' => $advanced];
}

/** 本回合仍存活的卧底座位号。只在服务端私有判断里用，绝不进快照。 */
function spyAliveSpies(PDO $db, int $roomId, int $round): array
{
    $stmt = $db->prepare(
        'SELECT seat FROM spy_seats
         WHERE room_id = ? AND role = ? AND (out_round IS NULL OR out_round = ? OR out_round >= ?)'
    );
    $stmt->execute([$roomId, SpyRules\ROLE_SPY, '', $round]);
    return array_map('intval', array_column($stmt->fetchAll(), 'seat'));
}

/**
 * 投票。to_seat 为 null 表示弃权。
 * 票面在封票前不进快照，所以这里不回任何计票信息。
 */
function spyCastVote(PDO $db, int $roomId, array $user, ?int $target): array
{
    $ctx = spyContext($db, $roomId, $user);
    $room = $ctx['room'];
    $seat = spyRequireSeat($ctx);
    spyRequirePlaying($room);
    spyRequirePhase($room, ['vote']);
    spyRequireAlive($seat);
    if (spyTieOpen($db, $room)) throw new SpyError('vote_already_settled', 409);

    $round = (int)$room['round'];
    $seatNo = (int)$seat['seat'];
    $stmt = $db->prepare('SELECT id FROM spy_votes WHERE room_id = ? AND round = ? AND from_seat = ?');
    $stmt->execute([$roomId, $round, $seatNo]);
    if ($stmt->fetchColumn()) throw new SpyError('already_voted', 409);

    $targets = spyAliveTargets($ctx['seats'], $round);
    if ($target !== null) {
        if (!in_array($target, $targets, true) || $target === $seatNo) {
            throw new SpyError('vote_target_invalid', 400);
        }
    }

    $db->prepare('INSERT INTO spy_votes (room_id, round, from_seat, to_seat, sealed, submitted_at) VALUES (?, ?, ?, ?, 0, ?)')
        ->execute([$roomId, $round, $seatNo, $target, spyNow()]);
    spyBump($db, $roomId, 'vote-cast', ['seat' => $seatNo, 'round' => $round]);

    $advanced = null;
    if ($targets) {
        $stmt = $db->prepare('SELECT COUNT(*) FROM spy_votes WHERE room_id = ? AND round = ?');
        $stmt->execute([$roomId, $round]);
        if ((int)$stmt->fetchColumn() >= count($targets)) {
            $advanced = spyAdvance($db, $roomId, 'votes-complete');
        }
    }
    return ['seat' => $seatNo, 'advanced' => $advanced];
}

/**
 * 夜晚行动。
 *
 * 面板对所有存活玩家开放 —— 若只给卧底显示刀人按钮，UI 本身就泄露了身份；
 * 平民能提交、提交即判自刀，正是原型「7 号平民误提交刀人指令」那条规则成立的前提。
 *
 * 推进条件用「存活卧底是否全部交卷」在服务端私下判断，不能数行数：
 * 平民的自刀行同样占一行，会让最后一个卧底的刀被提前封掉。
 */
function spyNightAction(PDO $db, int $roomId, array $user, ?int $target): array
{
    $ctx = spyContext($db, $roomId, $user);
    $room = $ctx['room'];
    $seat = spyRequireSeat($ctx);
    spyRequirePlaying($room);
    spyRequirePhase($room, ['night']);
    spyRequireAlive($seat);

    $round = (int)$room['round'];
    $seatNo = (int)$seat['seat'];
    $stmt = $db->prepare('SELECT id FROM spy_night_actions WHERE room_id = ? AND round = ? AND from_seat = ?');
    $stmt->execute([$roomId, $round, $seatNo]);
    if ($stmt->fetchColumn()) throw new SpyError('already_voted', 409);

    if ($target !== null && !in_array($target, spyAliveTargets($ctx['seats'], $round), true)) {
        throw new SpyError('vote_target_invalid', 400);
    }

    $db->prepare('INSERT INTO spy_night_actions (room_id, round, from_seat, target_seat, submitted_at) VALUES (?, ?, ?, ?, ?)')
        ->execute([$roomId, $round, $seatNo, $target, spyNow()]);
    // 不写角色也不写目标：这条事件所有人都要读。
    spyBump($db, $roomId, 'night-action', ['round' => $round]);

    $advanced = null;
    $aliveSpies = spyAliveSpies($db, $roomId, $round);
    if ($aliveSpies) {
        $in = implode(',', array_fill(0, count($aliveSpies), '?'));
        $stmt = $db->prepare(
            "SELECT COUNT(*) FROM spy_night_actions WHERE room_id = ? AND round = ? AND from_seat IN ($in)"
        );
        $stmt->execute(array_merge([$roomId, $round], $aliveSpies));
        if ((int)$stmt->fetchColumn() >= count($aliveSpies)) {
            $advanced = spyAdvance($db, $roomId, 'night-complete');
        }
    }
    return ['seat' => $seatNo, 'advanced' => $advanced];
}

/**
 * 白板猜词。每局一次（UNIQUE(room_id, seat) 兜底）。
 * 两词全中立即单独获胜并结束本局；猜错不淘汰，游戏继续。
 */
function spyBlankGuess(PDO $db, int $roomId, array $user, string $guessA, string $guessB): array
{
    $ctx = spyContext($db, $roomId, $user);
    $room = $ctx['room'];
    $seat = spyRequireSeat($ctx);
    spyRequirePlaying($room);

    $seatNo = (int)$seat['seat'];
    if ((string)$seat['role'] !== SpyRules\ROLE_BLANK) throw new SpyError('not_blank', 403);
    if (spyOutRound($seat['out_round'] ?? null) !== null) throw new SpyError('already_out', 409);

    $stmt = $db->prepare('SELECT id FROM spy_blank_guesses WHERE room_id = ? AND seat = ?');
    $stmt->execute([$roomId, $seatNo]);
    if ($stmt->fetchColumn()) throw new SpyError('guess_exists', 409);

    $pair = spyWordPair($db, $roomId);
    if ($pair === null) throw new SpyError('word_bank_empty', 500);

    $verdict = SpyRules\evaluate_blank_guess($guessA, $guessB, $pair['civilian_word'], $pair['spy_word']);
    $db->prepare(
        'INSERT INTO spy_blank_guesses
            (room_id, round, seat, guess_a, guess_b, hit_a, hit_b, result, host_confirmed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)'
    )->execute([
        $roomId, (int)$room['round'], $seatNo,
        spyStr($guessA, 64), spyStr($guessB, 64),
        !empty($verdict['hit_civilian']) ? 1 : 0, !empty($verdict['hit_spy']) ? 1 : 0,
        (string)$verdict['result'], spyNow(),
    ]);
    // 只发「几号交了猜词」；猜的什么、中没中都不进事件日志。
    spyBump($db, $roomId, 'blank-guess', ['seat' => $seatNo, 'round' => (int)$room['round']]);

    $ended = false;
    if (!empty($verdict['all_hit'])) {
        spyFinish($db, $roomId, SpyRules\WIN_BLANK, sprintf('%d 号白板一次猜中两个词，单独获胜。', $seatNo));
        $ended = true;
    }

    return ['seat' => $seatNo, 'result' => (string)$verdict['result'], 'ended' => $ended];
}

/**
 * 平票裁决。
 *
 *   ruling='eliminate' + seat —— 指定出局者，改写本轮那条 tie 记录（不再插第二条）
 *   ruling='revote'           —— 重开本轮投票
 *   ruling='pass'             —— 本轮无人出局，直接进入夜晚
 *
 * revote 会删掉本轮票面：平票本身就是「本轮没产生结果」，这些票没有裁决价值，
 * 而 UNIQUE(room_id, round, from_seat) 又不允许同轮二次投票。
 * 删除由 'vote-reopened' 事件留痕，审计链没断。
 */
function spyResolveTie(PDO $db, int $roomId, array $user, string $ruling, ?int $seat = null): array
{
    $ctx = spyContext($db, $roomId, $user);
    $room = $ctx['room'];
    spyRequireHost($room, $user);
    spyRequirePlaying($room);
    spyRequirePhase($room, ['vote']);
    if (!spyTieOpen($db, $room)) throw new SpyError('phase_wrong', 409);

    $round = (int)$room['round'];

    if ($ruling === 'revote') {
        if ((int)$room['revote_used'] === 1) throw new SpyError('no_revote_left', 409);
        $db->prepare('DELETE FROM spy_votes WHERE room_id = ? AND round = ?')->execute([$roomId, $round]);
        $db->prepare('DELETE FROM spy_round_outcomes WHERE room_id = ? AND round = ? AND stage = ?')
            ->execute([$roomId, $round, 'vote']);
        $db->prepare('UPDATE spy_rooms SET revote_used = 1 WHERE id = ?')->execute([$roomId]);
        $fresh = spyLoadRoom($db, (string)$roomId);
        if ($fresh !== null) spyOpenPhase($db, $fresh);
        spyBump($db, $roomId, 'vote-reopened', ['round' => $round]);
        return ['ruling' => 'revote', 'advanced' => null];
    }

    if ($ruling === 'pass') {
        // 另写一条 pass 裁决，保留 vote 那条 tie 记录，复盘才知道本轮平过票。
        spyWriteOutcome($db, $roomId, $round, 'pass', ['host_ruling' => '本轮无人出局', 'tie' => false]);
        spyBump($db, $roomId, 'vote-ruled', ['round' => $round, 'ruling' => 'pass']);
        return ['ruling' => 'pass', 'advanced' => spyAdvance($db, $roomId, 'ruling')];
    }

    if ($ruling !== 'eliminate' || $seat === null) throw new SpyError('invalid_params', 400);
    $targets = spyAliveTargets($ctx['seats'], $round);
    if (!in_array($seat, $targets, true)) throw new SpyError('vote_target_invalid', 400);

    $role = '';
    foreach ($ctx['seats'] as $s) {
        if ((int)$s['seat'] === $seat) { $role = (string)$s['role']; break; }
    }
    spyMarkOut($db, $roomId, $seat, $round, SpyRules\OUT_BY_VOTE);
    $db->prepare(
        'UPDATE spy_round_outcomes SET eliminated_seat = ?, eliminated_role = ?, out_by = ?, tie = 0, host_ruling = ?
         WHERE room_id = ? AND round = ? AND stage = ?'
    )->execute([$seat, $role, SpyRules\OUT_BY_VOTE, '房主裁决平票', $roomId, $round, 'vote']);
    spyBump($db, $roomId, 'vote-ruled', ['round' => $round, 'ruling' => 'eliminate', 'seat' => $seat]);

    return ['ruling' => 'eliminate', 'advanced' => spyAdvance($db, $roomId, 'ruling')];
}
