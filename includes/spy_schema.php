<?php
/**
 * 谁是卧底（Spy）表结构与词库种子。
 * [HERE] includes/spy_schema.php
 *
 * 单独成文件而不是塞进 scripts/migrate.php 的 91KB 主体，理由有二：
 *   1. 沿用仓库里较新的做法 —— api/vote_projects.php:8 调 voteEnsureSchema()
 *      在首次请求时自建表，端点不依赖有人手动跑迁移。
 *   2. 新玩法的表全部集中一处，MySQL / SQLite 方言分支也集中一处，
 *      不至于在 migrate.php 的两条分支里各改一半、留下漂移。
 *
 * scripts/migrate.php 与 api/spy_*.php 都调用本文件的 spyEnsureSchema()。
 * 全部语句幂等（IF NOT EXISTS + 吞掉重复索引错误），可反复执行。
 *
 * 为什么状态一律落库而不是 data/*.json：.htaccess 只挡 includes/ 与 data/*.db，
 * data/*.json 可以被 URL 直读，词对与身份写进 JSON 等于公开。
 *
 * 为什么比较用的时间戳一律 epoch 秒 BIGINT 而不是 DATETIME：
 * 阶段截止、座位最后心跳、封票时刻都要参与算术比较，
 * 用 BIGINT 就免去 MySQL DATETIME 与 SQLite TEXT 之间的来回转换。
 * 先例：quiz_results.ended_at BIGINT。
 */

declare(strict_types=1);

/**
 * 请求侧入口：每个进程只真正跑一次 DDL。
 * 想做「重复执行是否安全」的验证，请直接调 spyApplySchema()。
 */
function spyEnsureSchema(PDO $db, bool $isMysql): void {
    static $done = false;
    if ($done) return;
    spyApplySchema($db, $isMysql);
    $done = true;
}

/**
 * 实际建表 + 灌种子。全部语句幂等，可反复执行。
 *
 * @param PDO  $db
 * @param bool $isMysql 由调用方按 DB_DRIVER 传入（见 includes/db.php）
 */
function spyApplySchema(PDO $db, bool $isMysql): void {
    $db->exec('CREATE TABLE IF NOT EXISTS spy_rooms (
        ' . ($isMysql ? 'id INT AUTO_INCREMENT PRIMARY KEY,' : 'id INTEGER PRIMARY KEY AUTOINCREMENT,') . '
        code        ' . ($isMysql ? "VARCHAR(16) NOT NULL" : "TEXT NOT NULL") . ',
        name        ' . ($isMysql ? "VARCHAR(80) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        host_user_id ' . ($isMysql ? 'INT NOT NULL' : 'INTEGER NOT NULL') . ',
        club_id     ' . ($isMysql ? 'INT NULL' : 'INTEGER NULL') . ',
        country     ' . ($isMysql ? "VARCHAR(50) NOT NULL DEFAULT 'china'" : "TEXT NOT NULL DEFAULT 'china'") . ',
        cap         ' . ($isMysql ? 'INT NOT NULL DEFAULT 8' : 'INTEGER NOT NULL DEFAULT 8') . ',
        joined      ' . ($isMysql ? 'INT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        dist_civilian ' . ($isMysql ? 'INT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        dist_spy    ' . ($isMysql ? 'INT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        dist_blank  ' . ($isMysql ? 'INT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        phase       ' . ($isMysql ? "VARCHAR(16) NOT NULL DEFAULT 'lobby'" : "TEXT NOT NULL DEFAULT 'lobby'") . ',
        round       ' . ($isMysql ? 'INT NOT NULL DEFAULT 1' : 'INTEGER NOT NULL DEFAULT 1') . ',
        timer_profile ' . ($isMysql ? "VARCHAR(16) NOT NULL DEFAULT 'standard'" : "TEXT NOT NULL DEFAULT 'standard'") . ',
        deadline_at ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        speaker_seat ' . ($isMysql ? 'INT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        vote_sealed_at ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        revote_used ' . ($isMysql ? 'TINYINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        spectate    ' . ($isMysql ? 'TINYINT NOT NULL DEFAULT 1' : 'INTEGER NOT NULL DEFAULT 1') . ',
        spectate_delay ' . ($isMysql ? 'INT NOT NULL DEFAULT 60' : 'INTEGER NOT NULL DEFAULT 60') . ',
        need_code   ' . ($isMysql ? 'TINYINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        join_code   ' . ($isMysql ? "VARCHAR(16) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        word_a      ' . ($isMysql ? "VARCHAR(64) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        word_b      ' . ($isMysql ? "VARCHAR(64) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        status      ' . ($isMysql ? "VARCHAR(16) NOT NULL DEFAULT 'waiting'" : "TEXT NOT NULL DEFAULT 'waiting'") . ',
        winner      ' . ($isMysql ? "VARCHAR(16) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        host_last_seen_at ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        rev         ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 1' : 'INTEGER NOT NULL DEFAULT 1') . ',
        last_activity_at ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        created_at  ' . ($isMysql ? 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' : "TEXT NOT NULL DEFAULT (datetime('now'))") . ',
        updated_at  ' . ($isMysql ? 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' : "TEXT NOT NULL DEFAULT (datetime('now'))") . ',
        ' . ($isMysql ? 'UNIQUE KEY uq_spy_room_code (code)' : 'UNIQUE(code)') . '
    )' . ($isMysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : ''));

    $db->exec('CREATE TABLE IF NOT EXISTS spy_seats (
        ' . ($isMysql ? 'id INT AUTO_INCREMENT PRIMARY KEY,' : 'id INTEGER PRIMARY KEY AUTOINCREMENT,') . '
        room_id     ' . ($isMysql
            ? 'INT NOT NULL, FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE,'
            : 'INTEGER NOT NULL REFERENCES spy_rooms(id) ON DELETE CASCADE,') . '
        seat        ' . ($isMysql ? 'INT NOT NULL' : 'INTEGER NOT NULL') . ',
        user_id     ' . ($isMysql ? 'INT NULL' : 'INTEGER NULL') . ',
        nick        ' . ($isMysql ? "VARCHAR(64) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        avatar      ' . ($isMysql ? "VARCHAR(255) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        role        ' . ($isMysql ? "VARCHAR(16) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        role_preset ' . ($isMysql ? "VARCHAR(16) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        ready_at    ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        viewed_at   ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        out_round   ' . ($isMysql ? 'INT NULL' : 'INTEGER NULL') . ',
        out_by      ' . ($isMysql ? "VARCHAR(16) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        last_seen_at ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        joined_at   ' . ($isMysql ? 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' : "TEXT NOT NULL DEFAULT (datetime('now'))") . ',
        ' . ($isMysql
            ? 'UNIQUE KEY uq_spy_seat (room_id, seat), UNIQUE KEY uq_spy_seat_user (room_id, user_id)'
            : 'UNIQUE(room_id, seat), UNIQUE(room_id, user_id)') . '
    )' . ($isMysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : ''));

    // 词对独立成表：只有主持人可读，玩家快照永不带这几列。
    $db->exec('CREATE TABLE IF NOT EXISTS spy_words (
        room_id       ' . ($isMysql
            ? 'INT NOT NULL PRIMARY KEY, FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE,'
            : 'INTEGER NOT NULL PRIMARY KEY REFERENCES spy_rooms(id) ON DELETE CASCADE,') . '
        pair_id       ' . ($isMysql ? 'INT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        civilian_word ' . ($isMysql ? "VARCHAR(64) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        spy_word      ' . ($isMysql ? "VARCHAR(64) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        difficulty    ' . ($isMysql ? "VARCHAR(16) NOT NULL DEFAULT 'mid'" : "TEXT NOT NULL DEFAULT 'mid'") . ',
        similarity    ' . ($isMysql ? "VARCHAR(16) NOT NULL DEFAULT 'near'" : "TEXT NOT NULL DEFAULT 'near'") . ',
        dealt_at      ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . '
    )' . ($isMysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : ''));

    $db->exec('CREATE TABLE IF NOT EXISTS spy_word_pairs (
        ' . ($isMysql ? 'id INT AUTO_INCREMENT PRIMARY KEY,' : 'id INTEGER PRIMARY KEY AUTOINCREMENT,') . '
        a          ' . ($isMysql ? 'VARCHAR(64) NOT NULL' : 'TEXT NOT NULL') . ',
        b          ' . ($isMysql ? 'VARCHAR(64) NOT NULL' : 'TEXT NOT NULL') . ',
        level      ' . ($isMysql ? "VARCHAR(16) NOT NULL DEFAULT 'mid'" : "TEXT NOT NULL DEFAULT 'mid'") . ',
        similarity ' . ($isMysql ? "VARCHAR(16) NOT NULL DEFAULT 'near'" : "TEXT NOT NULL DEFAULT 'near'") . ',
        used_count ' . ($isMysql ? 'INT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        enabled    ' . ($isMysql ? 'TINYINT NOT NULL DEFAULT 1' : 'INTEGER NOT NULL DEFAULT 1') . ',
        created_at ' . ($isMysql ? 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' : "TEXT NOT NULL DEFAULT (datetime('now'))") . ',
        ' . ($isMysql ? 'UNIQUE KEY uq_spy_pair (a, b)' : 'UNIQUE(a, b)') . '
    )' . ($isMysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : ''));

    // 描述阶段每人一句。UNIQUE(room_id, round, seat) 让重试在库层就幂等。
    $db->exec('CREATE TABLE IF NOT EXISTS spy_sentences (
        ' . ($isMysql ? 'id INT AUTO_INCREMENT PRIMARY KEY,' : 'id INTEGER PRIMARY KEY AUTOINCREMENT,') . '
        room_id      ' . ($isMysql
            ? 'INT NOT NULL, FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE,'
            : 'INTEGER NOT NULL REFERENCES spy_rooms(id) ON DELETE CASCADE,') . '
        round        ' . ($isMysql ? 'INT NOT NULL' : 'INTEGER NOT NULL') . ',
        seat         ' . ($isMysql ? 'INT NOT NULL' : 'INTEGER NOT NULL') . ',
        body         ' . ($isMysql ? 'VARCHAR(160) NOT NULL' : 'TEXT NOT NULL') . ',
        skipped      ' . ($isMysql ? 'TINYINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        submitted_at ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        ' . ($isMysql ? 'UNIQUE KEY uq_spy_sentence (room_id, round, seat)' : 'UNIQUE(room_id, round, seat)') . '
    )' . ($isMysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : ''));

    // to_seat 为 NULL 表示弃权。
    $db->exec('CREATE TABLE IF NOT EXISTS spy_votes (
        ' . ($isMysql ? 'id INT AUTO_INCREMENT PRIMARY KEY,' : 'id INTEGER PRIMARY KEY AUTOINCREMENT,') . '
        room_id      ' . ($isMysql
            ? 'INT NOT NULL, FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE,'
            : 'INTEGER NOT NULL REFERENCES spy_rooms(id) ON DELETE CASCADE,') . '
        round        ' . ($isMysql ? 'INT NOT NULL' : 'INTEGER NOT NULL') . ',
        from_seat    ' . ($isMysql ? 'INT NOT NULL' : 'INTEGER NOT NULL') . ',
        to_seat      ' . ($isMysql ? 'INT NULL' : 'INTEGER NULL') . ',
        sealed       ' . ($isMysql ? 'TINYINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        submitted_at ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        ' . ($isMysql ? 'UNIQUE KEY uq_spy_vote (room_id, round, from_seat)' : 'UNIQUE(room_id, round, from_seat)') . '
    )' . ($isMysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : ''));

    $db->exec('CREATE TABLE IF NOT EXISTS spy_night_actions (
        ' . ($isMysql ? 'id INT AUTO_INCREMENT PRIMARY KEY,' : 'id INTEGER PRIMARY KEY AUTOINCREMENT,') . '
        room_id      ' . ($isMysql
            ? 'INT NOT NULL, FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE,'
            : 'INTEGER NOT NULL REFERENCES spy_rooms(id) ON DELETE CASCADE,') . '
        round        ' . ($isMysql ? 'INT NOT NULL' : 'INTEGER NOT NULL') . ',
        from_seat    ' . ($isMysql ? 'INT NOT NULL' : 'INTEGER NOT NULL') . ',
        target_seat  ' . ($isMysql ? 'INT NULL' : 'INTEGER NULL') . ',
        submitted_at ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        ' . ($isMysql ? 'UNIQUE KEY uq_spy_night (room_id, round, from_seat)' : 'UNIQUE(room_id, round, from_seat)') . '
    )' . ($isMysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : ''));

    // 白板猜词每局限一次，靠 UNIQUE(room_id, seat) 兜住。
    $db->exec('CREATE TABLE IF NOT EXISTS spy_blank_guesses (
        ' . ($isMysql ? 'id INT AUTO_INCREMENT PRIMARY KEY,' : 'id INTEGER PRIMARY KEY AUTOINCREMENT,') . '
        room_id  ' . ($isMysql
            ? 'INT NOT NULL, FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE,'
            : 'INTEGER NOT NULL REFERENCES spy_rooms(id) ON DELETE CASCADE,') . '
        round    ' . ($isMysql ? 'INT NOT NULL' : 'INTEGER NOT NULL') . ',
        seat     ' . ($isMysql ? 'INT NOT NULL' : 'INTEGER NOT NULL') . ',
        guess_a  ' . ($isMysql ? "VARCHAR(64) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        guess_b  ' . ($isMysql ? "VARCHAR(64) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        hit_a    ' . ($isMysql ? 'TINYINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        hit_b    ' . ($isMysql ? 'TINYINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        result   ' . ($isMysql ? "VARCHAR(16) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        host_confirmed ' . ($isMysql ? 'TINYINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        created_at ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        ' . ($isMysql ? 'UNIQUE KEY uq_spy_blank_guess (room_id, seat)' : 'UNIQUE(room_id, seat)') . '
    )' . ($isMysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : ''));

    // 每回合裁决结果（投票出局 + 夜晚出局各一条），结算复盘按它渲染。
    $db->exec('CREATE TABLE IF NOT EXISTS spy_round_outcomes (
        ' . ($isMysql ? 'id INT AUTO_INCREMENT PRIMARY KEY,' : 'id INTEGER PRIMARY KEY AUTOINCREMENT,') . '
        room_id         ' . ($isMysql
            ? 'INT NOT NULL, FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE,'
            : 'INTEGER NOT NULL REFERENCES spy_rooms(id) ON DELETE CASCADE,') . '
        round           ' . ($isMysql ? 'INT NOT NULL' : 'INTEGER NOT NULL') . ',
        stage           ' . ($isMysql ? 'VARCHAR(16) NOT NULL' : 'TEXT NOT NULL') . ',
        eliminated_seat ' . ($isMysql ? 'INT NULL' : 'INTEGER NULL') . ',
        eliminated_role ' . ($isMysql ? "VARCHAR(16) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        out_by          ' . ($isMysql ? "VARCHAR(16) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        tie             ' . ($isMysql ? 'TINYINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        host_ruling     ' . ($isMysql ? "VARCHAR(64) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        tally           ' . ($isMysql ? 'TEXT NULL' : 'TEXT NULL') . ',
        created_at      ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        ' . ($isMysql ? 'UNIQUE KEY uq_spy_round_outcome (room_id, round, stage)' : 'UNIQUE(room_id, round, stage)') . '
    )' . ($isMysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : ''));

    // 变更日志：rev 与 spy_rooms.rev 同事务递增，客户端 ?since= 只取增量。
    $db->exec('CREATE TABLE IF NOT EXISTS spy_events (
        ' . ($isMysql ? 'id INT AUTO_INCREMENT PRIMARY KEY,' : 'id INTEGER PRIMARY KEY AUTOINCREMENT,') . '
        room_id    ' . ($isMysql
            ? 'INT NOT NULL, FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE,'
            : 'INTEGER NOT NULL REFERENCES spy_rooms(id) ON DELETE CASCADE,') . '
        rev        ' . ($isMysql ? 'BIGINT NOT NULL' : 'INTEGER NOT NULL') . ',
        kind       ' . ($isMysql ? 'VARCHAR(32) NOT NULL' : 'TEXT NOT NULL') . ',
        payload    ' . ($isMysql ? 'TEXT NULL' : 'TEXT NULL') . ',
        created_at ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        ' . ($isMysql ? 'UNIQUE KEY uq_spy_event_rev (room_id, rev)' : 'UNIQUE(room_id, rev)') . '
    )' . ($isMysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : ''));

    $db->exec('CREATE TABLE IF NOT EXISTS spy_results (
        room_id    ' . ($isMysql
            ? 'INT NOT NULL PRIMARY KEY, FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE,'
            : 'INTEGER NOT NULL PRIMARY KEY REFERENCES spy_rooms(id) ON DELETE CASCADE,') . '
        winner     ' . ($isMysql ? "VARCHAR(16) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        reason     ' . ($isMysql ? "VARCHAR(255) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''") . ',
        rounds     ' . ($isMysql ? 'INT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        awards     ' . ($isMysql ? 'TEXT NULL' : 'TEXT NULL') . ',
        reveal     ' . ($isMysql ? 'TEXT NULL' : 'TEXT NULL') . ',
        settled_at ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . '
    )' . ($isMysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : ''));

    // 写操作幂等：同一 Idempotency-Key 重放直接回缓存响应。
    $db->exec('CREATE TABLE IF NOT EXISTS spy_idempotency (
        ' . ($isMysql ? 'id INT AUTO_INCREMENT PRIMARY KEY,' : 'id INTEGER PRIMARY KEY AUTOINCREMENT,') . '
        idem_key   ' . ($isMysql ? 'VARCHAR(64) NOT NULL' : 'TEXT NOT NULL') . ',
        room_id    ' . ($isMysql ? 'INT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        response   ' . ($isMysql ? 'TEXT NULL' : 'TEXT NULL') . ',
        created_at ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        expires_at ' . ($isMysql ? 'BIGINT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0') . ',
        ' . ($isMysql ? 'UNIQUE KEY uq_spy_idem (idem_key)' : 'UNIQUE(idem_key)') . '
    )' . ($isMysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : ''));

    // 增量列：老库靠这里补列；新库建表语句已包含，重复添加的报错与重复索引一样吞掉。
    // SQLite 的 ADD COLUMN 带 NOT NULL 必须给默认值，两方言都给 DEFAULT ''。
    $addCols = [
        'ALTER TABLE spy_rooms ADD COLUMN word_a ' . ($isMysql ? "VARCHAR(64) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''"),
        'ALTER TABLE spy_rooms ADD COLUMN word_b ' . ($isMysql ? "VARCHAR(64) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''"),
        'ALTER TABLE spy_seats ADD COLUMN role_preset ' . ($isMysql ? "VARCHAR(16) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''"),
    ];
    foreach ($addCols as $ddl) {
        try {
            $db->exec($ddl);
        } catch (Throwable $e) {
            // 列已存在，忽略。
        }
    }

    foreach ([
        'CREATE INDEX idx_spy_rooms_status ON spy_rooms(status, last_activity_at)',
        'CREATE INDEX idx_spy_rooms_host ON spy_rooms(host_user_id)',
        // cron 只扫「有截止时间的活房间」。
        'CREATE INDEX idx_spy_rooms_deadline ON spy_rooms(deadline_at, status)',
        'CREATE INDEX idx_spy_seats_room ON spy_seats(room_id)',
        'CREATE INDEX idx_spy_seats_user ON spy_seats(user_id)',
        'CREATE INDEX idx_spy_votes_round ON spy_votes(room_id, round)',
        'CREATE INDEX idx_spy_sentences_round ON spy_sentences(room_id, round)',
        'CREATE INDEX idx_spy_events_room ON spy_events(room_id, rev)',
        'CREATE INDEX idx_spy_idem_expiry ON spy_idempotency(expires_at)',
    ] as $idx) {
        try {
            $db->exec($isMysql ? $idx : preg_replace('/CREATE INDEX (\w+)/', 'CREATE INDEX IF NOT EXISTS $1', $idx));
        } catch (Throwable $e) {
            // MySQL 没有 CREATE INDEX IF NOT EXISTS，重复索引直接忽略。
        }
    }

    spySeedWordBank($db);
}

/**
 * 词库种子：把原先写死在 gameMock.js 里的 22 对词搬进 DB。
 * 只在表为空时灌一次，之后由主持人/管理员在库里维护。
 */
function spySeedWordBank(PDO $db): void {
    $row = $db->query('SELECT COUNT(*) FROM spy_word_pairs')->fetchColumn();
    if ((int)$row > 0) return;

    $pairs = spyDefaultWordPairs();
    $stmt = $db->prepare('INSERT INTO spy_word_pairs (a, b, level, similarity, used_count) VALUES (?, ?, ?, ?, ?)');
    foreach ($pairs as [$a, $b, $level, $sim, $used]) {
        $stmt->execute([$a, $b, $level, $sim, $used]);
    }
}

/**
 * 默认词库，逐条取自原型 Game/spy-react/src/data/gameMock.js 的 WORD_BANK（w01-w22）。
 * 元组为 [a 好人词, b 卧底词, level, similarity, used]，
 * used 一并带过来，「已用 N 局」的展示才不会在把数据搬出前端时丢掉。
 */
function spyDefaultWordPairs(): array {
    return [
        ['视觉小说', '轻小说', 'mid', 'near', 14],
        ['冰淇淋', '雪糕', 'easy', 'near', 38],
        ['微信', 'QQ', 'easy', 'mid', 31],
        ['猫', '老虎', 'easy', 'mid', 22],
        ['咖啡', '奶茶', 'easy', 'near', 27],
        ['小说', '散文', 'mid', 'far', 9],
        ['地铁', '轻轨', 'easy', 'near', 18],
        ['大学老师', '高中老师', 'mid', 'near', 12],
        ['香水', '花露水', 'mid', 'mid', 16],
        ['牛奶', '豆浆', 'easy', 'near', 25],
        ['吉他', '贝斯', 'mid', 'near', 11],
        ['原神', '崩坏：星穹铁道', 'mid', 'mid', 20],
        ['声优', '唱见', 'hard', 'near', 6],
        ['漫展', '同人展', 'mid', 'near', 13],
        ['剧本杀', '密室逃脱', 'mid', 'mid', 15],
        ['手办', '景品', 'hard', 'near', 7],
        ['东京', '大阪', 'mid', 'far', 10],
        ['泡面', '米线', 'easy', 'mid', 21],
        ['同人本', '画集', 'hard', 'near', 4],
        ['弹幕', '评论', 'hard', 'mid', 8],
        ['VNFest 地图', 'VNFest 论坛', 'hard', 'near', 2],
        ['温泉', '澡堂', 'mid', 'near', 17],
    ];
}
