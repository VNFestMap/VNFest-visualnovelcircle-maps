<?php
// includes/vote_projects.php - shared annual voting project core.

require_once __DIR__ . '/auth.php';

const VOTE_PROJECT_TYPES = ['twelve', 'moe'];
const VOTE_PROJECT_STATUSES = ['draft', 'published', 'running', 'ended', 'archived', 'suspended'];
const VOTE_VISIBILITIES = ['public', 'unlisted', 'club_only'];
const VOTE_ELIGIBILITY_MODES = ['club_member', 'public', 'invite_code', 'whitelist'];
const VOTE_STAGE_TYPES = ['nomination', 'qualifier', 'group_vote', 'bracket', 'final'];
const VOTE_STAGE_STATUSES = ['pending', 'open', 'locked', 'reviewing', 'settled'];
const VOTE_MODES = ['nomination', 'multi_select', 'score', 'match_single'];
const VOTE_RESULT_VISIBILITIES = ['live_votes', 'live_rank_only', 'after_stage', 'after_event', 'hidden'];

function voteIsMysql(): bool {
    return defined('DB_DRIVER') && DB_DRIVER === 'mysql';
}

function voteNowExpr(): string {
    return voteIsMysql() ? 'NOW()' : "datetime('now')";
}

function voteTryExec(PDO $db, string $sql): void {
    try {
        $db->exec($sql);
    } catch (Throwable $e) {
        // Idempotent migrations ignore duplicate columns/indexes.
    }
}

function voteRespond(array $payload, int $status = 200): void {
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit();
}

function voteBootstrap(): void {
    header('Content-Type: application/json; charset=utf-8');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
        http_response_code(200);
        exit();
    }
}

function voteReadJson(): array {
    $raw = file_get_contents('php://input');
    $data = json_decode((string)$raw, true);
    return is_array($data) ? $data : [];
}

function voteNormalize(string $value, array $allowed, string $fallback): string {
    return in_array($value, $allowed, true) ? $value : $fallback;
}

function voteNormalizeCountry($value): string {
    $country = strtolower(trim((string)$value));
    return in_array($country, ['china', 'japan'], true) ? $country : 'china';
}

function voteLower(string $value): string {
    return function_exists('mb_strtolower') ? mb_strtolower($value, 'UTF-8') : strtolower($value);
}

function voteJson($value): string {
    if (is_string($value)) return $value;
    return json_encode(is_array($value) ? $value : [], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

function voteDecode($value): array {
    $decoded = json_decode((string)$value, true);
    return is_array($decoded) ? $decoded : [];
}

function voteEnsureFlowSchema(PDO $db): void {
    if (voteIsMysql()) {
        $db->exec("
            CREATE TABLE IF NOT EXISTS vote_flow_runs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                project_id INT NOT NULL,
                version_no INT NOT NULL DEFAULT 1,
                status VARCHAR(30) NOT NULL DEFAULT 'active',
                created_by INT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                archived_at DATETIME,
                snapshot_json TEXT,
                UNIQUE KEY uniq_vote_flow_run_version (project_id, version_no)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
        $db->exec("
            CREATE TABLE IF NOT EXISTS vote_flow_pools (
                id INT AUTO_INCREMENT PRIMARY KEY,
                run_id INT NOT NULL,
                project_id INT NOT NULL,
                stage_id INT NOT NULL,
                stage_type VARCHAR(40) NOT NULL,
                title VARCHAR(160) NOT NULL DEFAULT '',
                status VARCHAR(30) NOT NULL DEFAULT 'draft',
                vote_mode VARCHAR(40) NOT NULL DEFAULT 'multi_select',
                group_count INT NOT NULL DEFAULT 1,
                max_select INT NOT NULL DEFAULT 1,
                advance_count INT NOT NULL DEFAULT 0,
                config_json TEXT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                opened_at DATETIME,
                settled_at DATETIME,
                UNIQUE KEY uniq_vote_flow_pool_stage (run_id, stage_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
        $db->exec("
            CREATE TABLE IF NOT EXISTS vote_flow_pool_entries (
                id INT AUTO_INCREMENT PRIMARY KEY,
                run_id INT NOT NULL,
                pool_id INT NOT NULL,
                project_id INT NOT NULL,
                entry_id INT NOT NULL,
                group_key VARCHAR(80) DEFAULT '',
                seed_no INT NOT NULL DEFAULT 0,
                source_pool_id INT,
                source_rank INT,
                status VARCHAR(30) NOT NULL DEFAULT 'active',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_vote_flow_pool_entry (pool_id, entry_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
        $db->exec("
            CREATE TABLE IF NOT EXISTS vote_flow_results (
                id INT AUTO_INCREMENT PRIMARY KEY,
                run_id INT NOT NULL,
                pool_id INT NOT NULL,
                project_id INT NOT NULL,
                entry_id INT NOT NULL,
                rank_no INT NOT NULL DEFAULT 0,
                votes INT NOT NULL DEFAULT 0,
                score_total INT NOT NULL DEFAULT 0,
                rating_count INT NOT NULL DEFAULT 0,
                score_avg DECIMAL(8,3),
                advanced TINYINT(1) NOT NULL DEFAULT 0,
                snapshot_json TEXT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_vote_flow_result (pool_id, entry_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
        $db->exec("
            CREATE TABLE IF NOT EXISTS vote_flow_matches (
                id INT AUTO_INCREMENT PRIMARY KEY,
                run_id INT NOT NULL,
                pool_id INT NOT NULL,
                project_id INT NOT NULL,
                stage_id INT NOT NULL,
                round_no INT NOT NULL DEFAULT 1,
                match_no INT NOT NULL DEFAULT 1,
                slot_a_entry_id INT,
                slot_b_entry_id INT,
                winner_entry_id INT,
                status VARCHAR(30) NOT NULL DEFAULT 'pending',
                next_match_id INT,
                next_slot VARCHAR(1) DEFAULT '',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
        $db->exec("
            CREATE TABLE IF NOT EXISTS vote_flow_events (
                id INT AUTO_INCREMENT PRIMARY KEY,
                run_id INT,
                pool_id INT,
                project_id INT NOT NULL,
                event_type VARCHAR(80) NOT NULL,
                payload_json TEXT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
        voteTryExec($db, "CREATE INDEX idx_vote_flow_runs_project ON vote_flow_runs(project_id, status)");
        voteTryExec($db, "CREATE INDEX idx_vote_flow_pools_project ON vote_flow_pools(project_id, status, stage_type)");
        voteTryExec($db, "CREATE INDEX idx_vote_flow_pool_entries_pool ON vote_flow_pool_entries(pool_id, status, group_key)");
        voteTryExec($db, "CREATE INDEX idx_vote_flow_results_pool ON vote_flow_results(pool_id, advanced, rank_no)");
        voteTryExec($db, "CREATE INDEX idx_vote_flow_matches_pool ON vote_flow_matches(pool_id, round_no, match_no)");
        voteTryExec($db, "ALTER TABLE vote_flow_results ADD COLUMN score_total INT NOT NULL DEFAULT 0");
        voteTryExec($db, "ALTER TABLE vote_flow_results ADD COLUMN rating_count INT NOT NULL DEFAULT 0");
        voteTryExec($db, "ALTER TABLE vote_projects ADD COLUMN share_token VARCHAR(40) NOT NULL DEFAULT ''");
        voteTryExec($db, "ALTER TABLE vote_projects ADD COLUMN guest_vote TINYINT(1) NOT NULL DEFAULT 0");
        voteTryExec($db, "ALTER TABLE vote_votes ADD COLUMN guest_key VARCHAR(64) NOT NULL DEFAULT ''");
        // 免登录投票：访客票 user_id 置 NULL（外键允许 NULL），靠 guest_key 去重
        voteTryExec($db, "ALTER TABLE vote_votes MODIFY user_id INT NULL");
        voteTryExec($db, "CREATE INDEX idx_vote_projects_share ON vote_projects(share_token)");
        voteTryExec($db, "CREATE INDEX idx_vote_votes_match ON vote_votes(stage_id, match_id)");
        voteTryExec($db, "CREATE INDEX idx_vote_votes_user ON vote_votes(user_id)");
        voteTryExec($db, "CREATE INDEX idx_vote_votes_guest ON vote_votes(guest_key)");
        return;
    }

    $db->exec("
        CREATE TABLE IF NOT EXISTS vote_flow_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            version_no INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active',
            created_by INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            archived_at TEXT,
            snapshot_json TEXT DEFAULT '{}',
            UNIQUE(project_id, version_no)
        )
    ");
    $db->exec("
        CREATE TABLE IF NOT EXISTS vote_flow_pools (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            project_id INTEGER NOT NULL,
            stage_id INTEGER NOT NULL,
            stage_type TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'draft',
            vote_mode TEXT NOT NULL DEFAULT 'multi_select',
            group_count INTEGER NOT NULL DEFAULT 1,
            max_select INTEGER NOT NULL DEFAULT 1,
            advance_count INTEGER NOT NULL DEFAULT 0,
            config_json TEXT DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            opened_at TEXT,
            settled_at TEXT,
            UNIQUE(run_id, stage_id)
        )
    ");
    $db->exec("
        CREATE TABLE IF NOT EXISTS vote_flow_pool_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            pool_id INTEGER NOT NULL,
            project_id INTEGER NOT NULL,
            entry_id INTEGER NOT NULL,
            group_key TEXT DEFAULT '',
            seed_no INTEGER NOT NULL DEFAULT 0,
            source_pool_id INTEGER,
            source_rank INTEGER,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(pool_id, entry_id)
        )
    ");
    $db->exec("
        CREATE TABLE IF NOT EXISTS vote_flow_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            pool_id INTEGER NOT NULL,
            project_id INTEGER NOT NULL,
            entry_id INTEGER NOT NULL,
            rank_no INTEGER NOT NULL DEFAULT 0,
            votes INTEGER NOT NULL DEFAULT 0,
            score_total INTEGER NOT NULL DEFAULT 0,
            rating_count INTEGER NOT NULL DEFAULT 0,
            score_avg REAL,
            advanced INTEGER NOT NULL DEFAULT 0,
            snapshot_json TEXT DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(pool_id, entry_id)
        )
    ");
    $db->exec("
        CREATE TABLE IF NOT EXISTS vote_flow_matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            pool_id INTEGER NOT NULL,
            project_id INTEGER NOT NULL,
            stage_id INTEGER NOT NULL,
            round_no INTEGER NOT NULL DEFAULT 1,
            match_no INTEGER NOT NULL DEFAULT 1,
            slot_a_entry_id INTEGER,
            slot_b_entry_id INTEGER,
            winner_entry_id INTEGER,
            status TEXT NOT NULL DEFAULT 'pending',
            next_match_id INTEGER,
            next_slot TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    $db->exec("
        CREATE TABLE IF NOT EXISTS vote_flow_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER,
            pool_id INTEGER,
            project_id INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            payload_json TEXT DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_vote_flow_runs_project ON vote_flow_runs(project_id, status)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_vote_flow_pools_project ON vote_flow_pools(project_id, status, stage_type)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_vote_flow_pool_entries_pool ON vote_flow_pool_entries(pool_id, status, group_key)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_vote_flow_results_pool ON vote_flow_results(pool_id, advanced, rank_no)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_vote_flow_matches_pool ON vote_flow_matches(pool_id, round_no, match_no)");
    voteTryExec($db, "ALTER TABLE vote_flow_results ADD COLUMN score_total INTEGER NOT NULL DEFAULT 0");
    voteTryExec($db, "ALTER TABLE vote_flow_results ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0");
    voteTryExec($db, "ALTER TABLE vote_projects ADD COLUMN share_token TEXT NOT NULL DEFAULT ''");
    voteTryExec($db, "ALTER TABLE vote_projects ADD COLUMN guest_vote INTEGER NOT NULL DEFAULT 0");
    voteTryExec($db, "ALTER TABLE vote_votes ADD COLUMN guest_key TEXT NOT NULL DEFAULT ''");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_vote_projects_share ON vote_projects(share_token)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_vote_votes_match ON vote_votes(stage_id, match_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_vote_votes_user ON vote_votes(user_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_vote_votes_guest ON vote_votes(guest_key)");
    // 旧库 vote_votes.user_id 带 NOT NULL，重建为可空以支持免登录访客票（NULL 过外键）。
    $voteVotesSql = (string)$db->query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vote_votes'")->fetchColumn();
    if ($voteVotesSql && strpos($voteVotesSql, 'user_id INTEGER NOT NULL') !== false) {
        $db->exec('PRAGMA foreign_keys=OFF');
        $db->exec("
            CREATE TABLE vote_votes_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES vote_projects(id),
                stage_id INTEGER NOT NULL REFERENCES vote_stages(id),
                entry_id INTEGER NOT NULL REFERENCES vote_entries(id),
                match_id INTEGER,
                user_id INTEGER REFERENCES users(id),
                guest_key TEXT NOT NULL DEFAULT '',
                vote_value INTEGER NOT NULL DEFAULT 1,
                score_value INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        ");
        $db->exec("
            INSERT INTO vote_votes_new
                (id, project_id, stage_id, entry_id, match_id, user_id, guest_key, vote_value, score_value, created_at)
            SELECT id, project_id, stage_id, entry_id, match_id, user_id, COALESCE(guest_key, ''), vote_value, score_value, created_at
            FROM vote_votes
        ");
        $db->exec('DROP TABLE vote_votes');
        $db->exec('ALTER TABLE vote_votes_new RENAME TO vote_votes');
        $db->exec('PRAGMA foreign_keys=ON');
        $db->exec('CREATE INDEX IF NOT EXISTS idx_vote_votes_stage_user ON vote_votes(stage_id, user_id)');
        $db->exec('CREATE INDEX IF NOT EXISTS idx_vote_votes_entry ON vote_votes(stage_id, entry_id)');
        $db->exec('CREATE INDEX IF NOT EXISTS idx_vote_votes_guest ON vote_votes(stage_id, guest_key)');
    }
}

function voteEnsureSchema(?PDO $db = null): void {
    $db = $db ?: getDB();

    if (voteIsMysql()) {
        $db->exec("
            CREATE TABLE IF NOT EXISTS vote_projects (
                id INT AUTO_INCREMENT PRIMARY KEY,
                project_type VARCHAR(20) NOT NULL,
                club_id INT NOT NULL,
                country VARCHAR(20) NOT NULL DEFAULT 'china',
                title VARCHAR(255) NOT NULL,
                year_label VARCHAR(20) DEFAULT '',
                description TEXT,
                cover_url VARCHAR(500) DEFAULT '',
                status VARCHAR(30) NOT NULL DEFAULT 'draft',
                visibility VARCHAR(30) NOT NULL DEFAULT 'public',
                eligibility_mode VARCHAR(30) NOT NULL DEFAULT 'club_member',
                result_visibility VARCHAR(30) NOT NULL DEFAULT 'live_rank_only',
                config_json TEXT,
                created_by INT NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                published_at DATETIME,
                ended_at DATETIME,
                FOREIGN KEY (created_by) REFERENCES users(id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
        voteTryExec($db, "CREATE INDEX idx_vote_projects_public ON vote_projects(visibility, status, updated_at)");
        voteTryExec($db, "CREATE INDEX idx_vote_projects_club ON vote_projects(club_id, country, project_type)");

        $db->exec("
            CREATE TABLE IF NOT EXISTS vote_stages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                project_id INT NOT NULL,
                stage_type VARCHAR(30) NOT NULL,
                title VARCHAR(255) NOT NULL,
                sort_order INT NOT NULL DEFAULT 0,
                status VARCHAR(30) NOT NULL DEFAULT 'pending',
                starts_at DATETIME,
                ends_at DATETIME,
                vote_mode VARCHAR(30) NOT NULL DEFAULT 'multi_select',
                max_select INT NOT NULL DEFAULT 1,
                advance_count INT NOT NULL DEFAULT 0,
                group_count INT NOT NULL DEFAULT 1,
                score_min INT NOT NULL DEFAULT 1,
                score_max INT NOT NULL DEFAULT 10,
                allow_vote_change TINYINT(1) NOT NULL DEFAULT 0,
                result_visibility VARCHAR(30) NOT NULL DEFAULT 'live_rank_only',
                config_json TEXT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_id) REFERENCES vote_projects(id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
        voteTryExec($db, "CREATE INDEX idx_vote_stages_project ON vote_stages(project_id, sort_order)");

        $db->exec("
            CREATE TABLE IF NOT EXISTS vote_entries (
                id INT AUTO_INCREMENT PRIMARY KEY,
                project_id INT NOT NULL,
                source_type VARCHAR(40) NOT NULL DEFAULT 'manual',
                source_id VARCHAR(80) DEFAULT '',
                title VARCHAR(255) NOT NULL,
                title_cn VARCHAR(255) DEFAULT '',
                subtitle VARCHAR(255) DEFAULT '',
                image_url VARCHAR(500) DEFAULT '',
                summary TEXT,
                external_url VARCHAR(500) DEFAULT '',
                identity_key VARCHAR(500) NOT NULL,
                entry_status VARCHAR(30) NOT NULL DEFAULT 'pending',
                created_by INT NOT NULL,
                reviewed_by INT,
                reviewed_at DATETIME,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_vote_entry_identity (project_id, identity_key),
                FOREIGN KEY (project_id) REFERENCES vote_projects(id),
                FOREIGN KEY (created_by) REFERENCES users(id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
        voteTryExec($db, "CREATE INDEX idx_vote_entries_project ON vote_entries(project_id, entry_status)");

        $db->exec("
            CREATE TABLE IF NOT EXISTS vote_nominations (
                id INT AUTO_INCREMENT PRIMARY KEY,
                project_id INT NOT NULL,
                stage_id INT,
                entry_id INT NOT NULL,
                user_id INT NOT NULL,
                status VARCHAR(30) NOT NULL DEFAULT 'active',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_vote_nomination_user (project_id, entry_id, user_id),
                FOREIGN KEY (project_id) REFERENCES vote_projects(id),
                FOREIGN KEY (entry_id) REFERENCES vote_entries(id),
                FOREIGN KEY (user_id) REFERENCES users(id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");

        $db->exec("
            CREATE TABLE IF NOT EXISTS vote_votes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                project_id INT NOT NULL,
                stage_id INT NOT NULL,
                entry_id INT NOT NULL,
                match_id INT,
                user_id INT NOT NULL,
                vote_value INT NOT NULL DEFAULT 1,
                score_value INT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_id) REFERENCES vote_projects(id),
                FOREIGN KEY (stage_id) REFERENCES vote_stages(id),
                FOREIGN KEY (entry_id) REFERENCES vote_entries(id),
                FOREIGN KEY (user_id) REFERENCES users(id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
        voteTryExec($db, "CREATE INDEX idx_vote_votes_stage_user ON vote_votes(stage_id, user_id)");
        voteTryExec($db, "CREATE INDEX idx_vote_votes_entry ON vote_votes(stage_id, entry_id)");

        $db->exec("
            CREATE TABLE IF NOT EXISTS vote_stage_entries (
                id INT AUTO_INCREMENT PRIMARY KEY,
                project_id INT NOT NULL,
                stage_id INT NOT NULL,
                entry_id INT NOT NULL,
                group_key VARCHAR(80) DEFAULT '',
                seed_no INT NOT NULL DEFAULT 0,
                source_stage_id INT,
                source_result_rank INT,
                status VARCHAR(30) NOT NULL DEFAULT 'active',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_vote_stage_entry (stage_id, entry_id),
                FOREIGN KEY (project_id) REFERENCES vote_projects(id),
                FOREIGN KEY (stage_id) REFERENCES vote_stages(id),
                FOREIGN KEY (entry_id) REFERENCES vote_entries(id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
        voteTryExec($db, "CREATE INDEX idx_vote_stage_entries_project ON vote_stage_entries(project_id, stage_id, status)");
        voteTryExec($db, "ALTER TABLE vote_stage_entries ADD COLUMN group_key VARCHAR(80) DEFAULT ''");
        voteTryExec($db, "ALTER TABLE vote_stage_entries ADD COLUMN seed_no INT NOT NULL DEFAULT 0");
        voteTryExec($db, "ALTER TABLE vote_stage_entries ADD COLUMN source_stage_id INT");
        voteTryExec($db, "ALTER TABLE vote_stage_entries ADD COLUMN source_result_rank INT");

        $db->exec("
            CREATE TABLE IF NOT EXISTS vote_matches (
                id INT AUTO_INCREMENT PRIMARY KEY,
                project_id INT NOT NULL,
                stage_id INT NOT NULL,
                round_no INT NOT NULL DEFAULT 1,
                match_no INT NOT NULL DEFAULT 1,
                slot_a_entry_id INT,
                slot_b_entry_id INT,
                winner_entry_id INT,
                status VARCHAR(30) NOT NULL DEFAULT 'pending',
                next_match_id INT,
                next_slot VARCHAR(1) DEFAULT '',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_id) REFERENCES vote_projects(id),
                FOREIGN KEY (stage_id) REFERENCES vote_stages(id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
        voteTryExec($db, "ALTER TABLE vote_matches ADD COLUMN next_match_id INT");
        voteTryExec($db, "ALTER TABLE vote_matches ADD COLUMN next_slot VARCHAR(1) DEFAULT ''");
        voteTryExec($db, "CREATE INDEX idx_vote_matches_stage ON vote_matches(stage_id, round_no, match_no)");

        $db->exec("
            CREATE TABLE IF NOT EXISTS vote_results (
                id INT AUTO_INCREMENT PRIMARY KEY,
                project_id INT NOT NULL,
                stage_id INT NOT NULL,
                entry_id INT NOT NULL,
                rank_no INT NOT NULL DEFAULT 0,
                votes INT NOT NULL DEFAULT 0,
                score_avg DECIMAL(8,3),
                advanced TINYINT(1) NOT NULL DEFAULT 0,
                snapshot_json TEXT,
                settled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_vote_result (stage_id, entry_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
        voteEnsureFlowSchema($db);
        return;
    }

    $db->exec("
        CREATE TABLE IF NOT EXISTS vote_projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_type TEXT NOT NULL,
            club_id INTEGER NOT NULL,
            country TEXT NOT NULL DEFAULT 'china',
            title TEXT NOT NULL,
            year_label TEXT DEFAULT '',
            description TEXT DEFAULT '',
            cover_url TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'draft',
            visibility TEXT NOT NULL DEFAULT 'public',
            eligibility_mode TEXT NOT NULL DEFAULT 'club_member',
            result_visibility TEXT NOT NULL DEFAULT 'live_rank_only',
            config_json TEXT DEFAULT '{}',
            created_by INTEGER NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            published_at TEXT,
            ended_at TEXT
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_vote_projects_public ON vote_projects(visibility, status, updated_at)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_vote_projects_club ON vote_projects(club_id, country, project_type)");

    $db->exec("
        CREATE TABLE IF NOT EXISTS vote_stages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES vote_projects(id),
            stage_type TEXT NOT NULL,
            title TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            starts_at TEXT,
            ends_at TEXT,
            vote_mode TEXT NOT NULL DEFAULT 'multi_select',
            max_select INTEGER NOT NULL DEFAULT 1,
            advance_count INTEGER NOT NULL DEFAULT 0,
            group_count INTEGER NOT NULL DEFAULT 1,
            score_min INTEGER NOT NULL DEFAULT 1,
            score_max INTEGER NOT NULL DEFAULT 10,
            allow_vote_change INTEGER NOT NULL DEFAULT 0,
            result_visibility TEXT NOT NULL DEFAULT 'live_rank_only',
            config_json TEXT DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_vote_stages_project ON vote_stages(project_id, sort_order)");

    $db->exec("
        CREATE TABLE IF NOT EXISTS vote_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES vote_projects(id),
            source_type TEXT NOT NULL DEFAULT 'manual',
            source_id TEXT DEFAULT '',
            title TEXT NOT NULL,
            title_cn TEXT DEFAULT '',
            subtitle TEXT DEFAULT '',
            image_url TEXT DEFAULT '',
            summary TEXT DEFAULT '',
            external_url TEXT DEFAULT '',
            identity_key TEXT NOT NULL,
            entry_status TEXT NOT NULL DEFAULT 'pending',
            created_by INTEGER NOT NULL REFERENCES users(id),
            reviewed_by INTEGER,
            reviewed_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(project_id, identity_key)
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_vote_entries_project ON vote_entries(project_id, entry_status)");

    $db->exec("
        CREATE TABLE IF NOT EXISTS vote_nominations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES vote_projects(id),
            stage_id INTEGER,
            entry_id INTEGER NOT NULL REFERENCES vote_entries(id),
            user_id INTEGER NOT NULL REFERENCES users(id),
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(project_id, entry_id, user_id)
        )
    ");

    $db->exec("
        CREATE TABLE IF NOT EXISTS vote_votes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES vote_projects(id),
            stage_id INTEGER NOT NULL REFERENCES vote_stages(id),
            entry_id INTEGER NOT NULL REFERENCES vote_entries(id),
            match_id INTEGER,
            user_id INTEGER REFERENCES users(id),
            vote_value INTEGER NOT NULL DEFAULT 1,
            score_value INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_vote_votes_stage_user ON vote_votes(stage_id, user_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_vote_votes_entry ON vote_votes(stage_id, entry_id)");

    $db->exec("
        CREATE TABLE IF NOT EXISTS vote_stage_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES vote_projects(id),
            stage_id INTEGER NOT NULL REFERENCES vote_stages(id),
            entry_id INTEGER NOT NULL REFERENCES vote_entries(id),
            group_key TEXT DEFAULT '',
            seed_no INTEGER NOT NULL DEFAULT 0,
            source_stage_id INTEGER,
            source_result_rank INTEGER,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(stage_id, entry_id)
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_vote_stage_entries_project ON vote_stage_entries(project_id, stage_id, status)");
    voteTryExec($db, "ALTER TABLE vote_stage_entries ADD COLUMN group_key TEXT DEFAULT ''");
    voteTryExec($db, "ALTER TABLE vote_stage_entries ADD COLUMN seed_no INTEGER NOT NULL DEFAULT 0");
    voteTryExec($db, "ALTER TABLE vote_stage_entries ADD COLUMN source_stage_id INTEGER");
    voteTryExec($db, "ALTER TABLE vote_stage_entries ADD COLUMN source_result_rank INTEGER");

    $db->exec("
        CREATE TABLE IF NOT EXISTS vote_matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES vote_projects(id),
            stage_id INTEGER NOT NULL REFERENCES vote_stages(id),
            round_no INTEGER NOT NULL DEFAULT 1,
            match_no INTEGER NOT NULL DEFAULT 1,
            slot_a_entry_id INTEGER,
            slot_b_entry_id INTEGER,
            winner_entry_id INTEGER,
            status TEXT NOT NULL DEFAULT 'pending',
            next_match_id INTEGER,
            next_slot TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    voteTryExec($db, "ALTER TABLE vote_matches ADD COLUMN next_match_id INTEGER");
    voteTryExec($db, "ALTER TABLE vote_matches ADD COLUMN next_slot TEXT DEFAULT ''");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_vote_matches_stage ON vote_matches(stage_id, round_no, match_no)");

    $db->exec("
        CREATE TABLE IF NOT EXISTS vote_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES vote_projects(id),
            stage_id INTEGER NOT NULL REFERENCES vote_stages(id),
            entry_id INTEGER NOT NULL REFERENCES vote_entries(id),
            rank_no INTEGER NOT NULL DEFAULT 0,
            votes INTEGER NOT NULL DEFAULT 0,
            score_avg REAL,
            advanced INTEGER NOT NULL DEFAULT 0,
            snapshot_json TEXT DEFAULT '{}',
            settled_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(stage_id, entry_id)
        )
    ");
    voteEnsureFlowSchema($db);
}

function voteProjectRow(array $row): array {
    return [
        'id' => (int)$row['id'],
        'project_type' => $row['project_type'] ?? 'twelve',
        'club_id' => (int)$row['club_id'],
        'country' => $row['country'] ?? 'china',
        'title' => $row['title'] ?? '',
        'year_label' => $row['year_label'] ?? '',
        'description' => $row['description'] ?? '',
        'cover_url' => $row['cover_url'] ?? '',
        'status' => $row['status'] ?? 'draft',
        'visibility' => $row['visibility'] ?? 'public',
        'eligibility_mode' => $row['eligibility_mode'] ?? 'club_member',
        'result_visibility' => $row['result_visibility'] ?? 'live_rank_only',
        'guest_vote' => (int)($row['guest_vote'] ?? 0),
        'config' => voteDecode($row['config_json'] ?? '{}'),
        'created_by' => (int)($row['created_by'] ?? 0),
        'created_at' => $row['created_at'] ?? '',
        'updated_at' => $row['updated_at'] ?? '',
        'published_at' => $row['published_at'] ?? '',
        'ended_at' => $row['ended_at'] ?? '',
    ];
}

function voteGetProject(int $id): ?array {
    if ($id <= 0) return null;
    voteEnsureSchema();
    $stmt = getDB()->prepare('SELECT * FROM vote_projects WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function voteShareTokenMatches(array $project, string $token): bool {
    $token = trim($token);
    return $token !== '' && hash_equals(trim((string)($project['share_token'] ?? '')), $token);
}

// 非管理者剥离结算裁定候选（tie_breaks）等内部信息
function voteStripTieBreaks(array $runtime): array {
    unset($runtime['tie_breaks'], $runtime['match_tie_breaks']);
    return $runtime;
}

// 免登录投票的访客标识：首访签发长期 Cookie，服务端读取，用于同设备去重。
function voteGuestKey(): string {
    static $cached = null;
    if ($cached !== null) return $cached;
    $name = 'vnGuestVoteKey';
    $value = trim((string)($_COOKIE[$name] ?? ''));
    if (!preg_match('/^[a-f0-9]{32}$/', $value)) {
        $value = bin2hex(random_bytes(16));
        $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
            || stripos((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''), 'https') !== false;
        if (!headers_sent()) {
            setcookie($name, $value, [
                'expires' => time() + 63115200,
                'path' => '/',
                'secure' => $secure,
                'httponly' => true,
                'samesite' => 'Lax',
            ]);
        }
    }
    $cached = $value;
    return $value;
}

function voteCanManageProject(array $user, array $project): bool {
    return canManageClubInCountry($user, (int)$project['club_id'], $project['country'] ?? 'china');
}

function voteCanParticipateProject(?array $user, array $project): bool {
    $mode = $project['eligibility_mode'] ?? 'club_member';
    if ($mode === 'public') return (bool)$user;
    if (!$user) return false;
    if (voteCanManageProject($user, $project)) return true;
    if ($mode !== 'club_member') return false;
    $stmt = getDB()->prepare(
        "SELECT id FROM club_memberships
         WHERE user_id = ? AND club_id = ? AND country = ? AND status = 'active'
         LIMIT 1"
    );
    $stmt->execute([(int)$user['id'], (int)$project['club_id'], $project['country'] ?? 'china']);
    return (bool)$stmt->fetch();
}

function voteRequireProjectManager(int $projectId): array {
    $user = requireLogin();
    $project = voteGetProject($projectId);
    if (!$project) {
        voteRespond(['success' => false, 'message' => '企划不存在'], 404);
    }
    if (!voteCanManageProject($user, $project)) {
        voteRespond(['success' => false, 'message' => '无权管理该企划'], 403);
    }
    return [$user, $project];
}

function voteCanReadProject(?array $user, array $project): bool {
    if (($project['visibility'] ?? 'public') === 'public') return true;
    if (($project['visibility'] ?? '') === 'unlisted') return true;
    return $user ? voteCanParticipateProject($user, $project) : false;
}

function voteDefaultStages(PDO $db, int $projectId, string $type, string $resultVisibility = 'live_rank_only'): void {
    $resultVisibility = voteNormalize($resultVisibility, VOTE_RESULT_VISIBILITIES, 'live_rank_only');
    $rows = $type === 'moe'
        ? [
            ['nomination', '提名期', 1, 'nomination', 1, 0, 1],
            ['qualifier', '海选', 2, 'multi_select', 8, 32, 2],
            ['bracket', '32 强 1v1 淘汰赛', 3, 'match_single', 1, 1, 1],
            ['final', '萌王决赛', 4, 'match_single', 1, 1, 1],
        ]
        : [
            ['nomination', '提名期', 1, 'nomination', 1, 0, 1],
            ['qualifier', '海选', 2, 'multi_select', 12, 48, 2],
            ['group_vote', '分组投票', 3, 'multi_select', 12, 24, 4],
            ['final', '最终十二器', 4, 'multi_select', 12, 12, 1],
        ];
    $stmt = $db->prepare(
        "INSERT INTO vote_stages
         (project_id, stage_type, title, sort_order, status, vote_mode, max_select, advance_count, group_count, result_visibility, config_json)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, '{}')"
    );
    foreach ($rows as $row) {
        $stmt->execute([$projectId, $row[0], $row[1], $row[2], $row[3], $row[4], $row[5], $row[6], $resultVisibility]);
    }
}

function voteEntryIdentity(array $input): string {
    $sourceType = trim((string)($input['source_type'] ?? 'manual'));
    $sourceId = trim((string)($input['source_id'] ?? ''));
    if ($sourceType !== 'manual' && $sourceId !== '') {
        return $sourceType . ':' . $sourceId;
    }
    $title = voteLower(trim((string)($input['title'] ?? '')));
    $titleCn = voteLower(trim((string)($input['title_cn'] ?? '')));
    $subtitle = voteLower(trim((string)($input['subtitle'] ?? '')));
    return 'manual:' . md5($title . '|' . $titleCn . '|' . $subtitle);
}

function voteFetchStage(int $stageId): ?array {
    if ($stageId <= 0) return null;
    $stmt = getDB()->prepare('SELECT s.*, p.project_type, p.club_id, p.country, p.eligibility_mode, p.visibility, p.status AS project_status FROM vote_stages s JOIN vote_projects p ON p.id = s.project_id WHERE s.id = ?');
    $stmt->execute([$stageId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function voteIsPowerOfTwo(int $value): bool {
    return $value > 0 && ($value & ($value - 1)) === 0;
}

function voteStageConfig(array $stage): array {
    return voteDecode($stage['config_json'] ?? '{}');
}

function voteMetricEquals(array $a, array $b, string $mode): bool {
    if ($mode === 'score') {
        return (float)($a['score_avg'] ?? 0) === (float)($b['score_avg'] ?? 0)
            && (int)($a['votes'] ?? 0) === (int)($b['votes'] ?? 0);
    }
    return (int)($a['votes'] ?? 0) === (int)($b['votes'] ?? 0);
}

function votePreviousStage(PDO $db, array $stage): ?array {
    $stmt = $db->prepare('SELECT * FROM vote_stages WHERE project_id = ? AND sort_order < ? ORDER BY sort_order DESC, id DESC LIMIT 1');
    $stmt->execute([(int)$stage['project_id'], (int)$stage['sort_order']]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function voteNextStage(PDO $db, array $stage): ?array {
    $stmt = $db->prepare('SELECT * FROM vote_stages WHERE project_id = ? AND sort_order > ? ORDER BY sort_order ASC, id ASC LIMIT 1');
    $stmt->execute([(int)$stage['project_id'], (int)$stage['sort_order']]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function voteNormalizePendingEntries(PDO $db, int $projectId): int {
    $stmt = $db->prepare("UPDATE vote_entries SET entry_status = 'approved' WHERE project_id = ? AND entry_status = 'pending'");
    $stmt->execute([$projectId]);
    return $stmt->rowCount();
}

function voteStageEntryCount(PDO $db, int $stageId): int {
    $stmt = $db->prepare("SELECT COUNT(*) FROM vote_stage_entries WHERE stage_id = ? AND status = 'active'");
    $stmt->execute([$stageId]);
    return (int)$stmt->fetchColumn();
}

function voteStageUsageCounts(PDO $db, int $stageId): array {
    $voteStmt = $db->prepare('SELECT COUNT(*) FROM vote_votes WHERE stage_id = ?');
    $voteStmt->execute([$stageId]);
    $matchStmt = $db->prepare('SELECT COUNT(*) FROM vote_matches WHERE stage_id = ?');
    $matchStmt->execute([$stageId]);
    $resultStmt = $db->prepare('SELECT COUNT(*) FROM vote_results WHERE stage_id = ?');
    $resultStmt->execute([$stageId]);
    return [
        'votes' => (int)$voteStmt->fetchColumn(),
        'matches' => (int)$matchStmt->fetchColumn(),
        'results' => (int)$resultStmt->fetchColumn(),
    ];
}

function voteCanReseedStage(PDO $db, int $stageId): bool {
    $counts = voteStageUsageCounts($db, $stageId);
    return $counts['votes'] === 0 && $counts['matches'] === 0 && $counts['results'] === 0;
}

function voteSeedStageEntries(PDO $db, array $stage, array $entryIds, ?int $sourceStageId = null, array $rankMap = [], bool $force = false): int {
    $stageId = (int)$stage['id'];
    $projectId = (int)$stage['project_id'];
    $entryIds = array_values(array_unique(array_filter(array_map('intval', $entryIds))));
    $existing = voteStageEntryCount($db, $stageId);
    if ($existing > 0 && !$force) return $existing;
    if ($force) {
        $db->prepare('DELETE FROM vote_stage_entries WHERE stage_id = ?')->execute([$stageId]);
    }
    if (!$entryIds) return 0;

    $placeholders = implode(',', array_fill(0, count($entryIds), '?'));
    $stmt = $db->prepare("SELECT id FROM vote_entries WHERE project_id = ? AND entry_status = 'approved' AND id IN ($placeholders)");
    $stmt->execute(array_merge([$projectId], $entryIds));
    $valid = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    $validSet = array_flip($valid);
    $groupCount = max(1, (int)($stage['group_count'] ?? 1));
    $ins = $db->prepare(
        "INSERT INTO vote_stage_entries (project_id, stage_id, entry_id, group_key, seed_no, source_stage_id, source_result_rank, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')"
    );
    $seed = 1;
    foreach ($entryIds as $entryId) {
        if (!isset($validSet[$entryId])) continue;
        $groupKey = $groupCount > 1 ? 'G' . (($seed - 1) % $groupCount + 1) : '';
        $ins->execute([$projectId, $stageId, $entryId, $groupKey, $seed, $sourceStageId, $rankMap[$entryId] ?? null]);
        $seed++;
    }
    return $seed - 1;
}

function voteEnsureStageEntries(PDO $db, array $stage): int {
    $stageId = (int)$stage['id'];
    if (($stage['vote_mode'] ?? '') === 'nomination' || ($stage['stage_type'] ?? '') === 'nomination') {
        return 0;
    }
    $existing = voteStageEntryCount($db, $stageId);
    if ($existing > 0) return $existing;

    $projectId = (int)$stage['project_id'];
    if (($stage['stage_type'] ?? '') === 'qualifier') {
        voteNormalizePendingEntries($db, $projectId);
        $stmt = $db->prepare("SELECT id FROM vote_entries WHERE project_id = ? AND entry_status = 'approved' ORDER BY reviewed_at ASC, id ASC");
        $stmt->execute([$projectId]);
        return voteSeedStageEntries($db, $stage, array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN)));
    }

    $config = voteStageConfig($stage);
    $sourceStageId = (int)($config['source_stage_id'] ?? 0);
    $sourceStage = $sourceStageId > 0 ? voteFetchStage($sourceStageId) : votePreviousStage($db, $stage);
    if (!$sourceStage) return 0;
    $stmt = $db->prepare(
        "SELECT entry_id, rank_no
         FROM vote_results
         WHERE project_id = ? AND stage_id = ? AND advanced = 1
         ORDER BY rank_no ASC, entry_id ASC"
    );
    $stmt->execute([$projectId, (int)$sourceStage['id']]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $rankMap = [];
    $entryIds = [];
    foreach ($rows as $row) {
        $entryId = (int)$row['entry_id'];
        $entryIds[] = $entryId;
        $rankMap[$entryId] = (int)$row['rank_no'];
    }
    return voteSeedStageEntries($db, $stage, $entryIds, (int)$sourceStage['id'], $rankMap);
}

function voteSeedStageFromResults(PDO $db, array $sourceStage, array $targetStage, bool $force = false): array {
    $stmt = $db->prepare(
        "SELECT entry_id, rank_no
         FROM vote_results
         WHERE project_id = ? AND stage_id = ? AND advanced = 1
         ORDER BY rank_no ASC, entry_id ASC"
    );
    $stmt->execute([(int)$sourceStage['project_id'], (int)$sourceStage['id']]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $rankMap = [];
    $entryIds = [];
    foreach ($rows as $row) {
        $entryId = (int)$row['entry_id'];
        $entryIds[] = $entryId;
        $rankMap[$entryId] = (int)$row['rank_no'];
    }
    $existing = voteStageEntryCount($db, (int)$targetStage['id']);
    $seeded = voteSeedStageEntries($db, $targetStage, $entryIds, (int)$sourceStage['id'], $rankMap, $force);
    return [
        'seeded_count' => $seeded,
        'existing_count' => $existing,
        'reseeded' => $force && $existing > 0,
        'source_stage_id' => (int)$sourceStage['id'],
        'target_stage_id' => (int)$targetStage['id'],
        'eligible_entry_count' => count($entryIds),
    ];
}

function voteAdvanceNextStage(PDO $db, array $stage): ?array {
    $next = voteNextStage($db, $stage);
    if (!$next) return null;
    return voteSeedStageFromResults($db, $stage, $next, false);
}

function voteFlowLog(PDO $db, ?int $runId, ?int $poolId, int $projectId, string $eventType, array $payload = []): void {
    $stmt = $db->prepare('INSERT INTO vote_flow_events (run_id, pool_id, project_id, event_type, payload_json) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$runId, $poolId, $projectId, $eventType, voteJson($payload)]);
}

function voteFlowActiveRun(PDO $db, int $projectId): ?array {
    $stmt = $db->prepare("SELECT * FROM vote_flow_runs WHERE project_id = ? AND status = 'active' ORDER BY version_no DESC, id DESC LIMIT 1");
    $stmt->execute([$projectId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function voteFlowStageByType(PDO $db, int $projectId, string $stageType): ?array {
    $stmt = $db->prepare('SELECT * FROM vote_stages WHERE project_id = ? AND stage_type = ? ORDER BY sort_order ASC, id ASC LIMIT 1');
    $stmt->execute([$projectId, $stageType]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function voteFlowPoolById(PDO $db, int $poolId): ?array {
    $stmt = $db->prepare('SELECT * FROM vote_flow_pools WHERE id = ?');
    $stmt->execute([$poolId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function voteFlowPoolForStage(PDO $db, int $stageId): ?array {
    $stmt = $db->prepare(
        "SELECT p.*
         FROM vote_flow_pools p
         JOIN vote_flow_runs r ON r.id = p.run_id AND r.status = 'active'
         WHERE p.stage_id = ?
         ORDER BY r.version_no DESC, p.id DESC
         LIMIT 1"
    );
    $stmt->execute([$stageId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function voteFlowPoolRuntime(array $pool, ?array $stage = null): array {
    $config = voteDecode($pool['config_json'] ?? '{}');
    $stage = $stage ?: [];
    return [
        'rule_version' => max(1, (int)($config['rule_version'] ?? 1)),
        'vote_mode' => (string)($pool['vote_mode'] ?? $stage['vote_mode'] ?? 'multi_select'),
        'group_count' => max(1, (int)($pool['group_count'] ?? $stage['group_count'] ?? 1)),
        'max_select' => max(1, (int)($pool['max_select'] ?? $stage['max_select'] ?? 1)),
        'advance_count' => max(0, (int)($pool['advance_count'] ?? $stage['advance_count'] ?? 0)),
        'score_min' => max(0, (int)($config['score_min'] ?? $stage['score_min'] ?? 1)),
        'score_max' => max(1, (int)($config['score_max'] ?? $stage['score_max'] ?? 10)),
        'allow_vote_change' => array_key_exists('allow_vote_change', $config)
            ? !empty($config['allow_vote_change'])
            : !empty($stage['allow_vote_change']),
        'ends_at' => $config['ends_at'] ?? ($stage['ends_at'] ?? null),
        'result_visibility' => voteNormalize(
            (string)($config['result_visibility'] ?? $stage['result_visibility'] ?? 'live_rank_only'),
            VOTE_RESULT_VISIBILITIES,
            'live_rank_only'
        ),
        'group_ticket_scope' => (string)($config['group_ticket_scope'] ?? 'stage'),
        'scoring_method' => (string)($config['scoring_method'] ?? 'average'),
        'grouping_method' => (string)($config['grouping_method'] ?? 'round_robin'),
        'grouping_seed' => (string)($config['grouping_seed'] ?? ''),
        'tie_rule' => (string)($config['tie_rule'] ?? 'manual'),
        'tie_breaks' => is_array($config['tie_breaks'] ?? null) ? $config['tie_breaks'] : [],
        'match_tie_breaks' => is_array($config['match_tie_breaks'] ?? null) ? $config['match_tie_breaks'] : [],
    ];
}

function voteResultVisibilityFlags(array $project, string $stageStatus, string $visibility): array {
    $visibility = voteNormalize($visibility, VOTE_RESULT_VISIBILITIES, 'live_rank_only');
    if ($visibility === 'live_votes') return ['rank_visible' => true, 'metrics_visible' => true];
    if ($visibility === 'live_rank_only') return ['rank_visible' => true, 'metrics_visible' => false];
    if ($visibility === 'after_stage') {
        $visible = $stageStatus === 'settled';
        return ['rank_visible' => $visible, 'metrics_visible' => $visible];
    }
    if ($visibility === 'after_event') {
        $visible = ($project['status'] ?? '') === 'ended';
        return ['rank_visible' => $visible, 'metrics_visible' => $visible];
    }
    return ['rank_visible' => false, 'metrics_visible' => false];
}

function voteMoeRuntimeConfig(array $run, array $stage): array {
    $config = voteStageConfig($stage);
    $seedSource = implode(':', [
        (int)($run['project_id'] ?? $stage['project_id'] ?? 0),
        (int)($stage['id'] ?? 0),
        (int)($run['version_no'] ?? $run['id'] ?? 1),
    ]);
    return array_merge($config, [
        'rule_version' => 2,
        'score_min' => max(0, (int)($stage['score_min'] ?? 1)),
        'score_max' => max(1, (int)($stage['score_max'] ?? 10)),
        'allow_vote_change' => !empty($stage['allow_vote_change']),
        'ends_at' => $stage['ends_at'] ?? null,
        'result_visibility' => voteNormalize(
            (string)($stage['result_visibility'] ?? 'live_rank_only'),
            VOTE_RESULT_VISIBILITIES,
            'live_rank_only'
        ),
        'group_ticket_scope' => 'per_group',
        'scoring_method' => 'total_points',
        'grouping_method' => 'seeded_shuffle',
        'grouping_seed' => hash('sha256', $seedSource),
        'tie_rule' => 'manual',
    ]);
}

function voteFlowDeterministicShuffle(array $entryIds, string $seed): array {
    usort($entryIds, function ($a, $b) use ($seed) {
        $left = hash('sha256', $seed . ':' . (int)$a);
        $right = hash('sha256', $seed . ':' . (int)$b);
        $cmp = strcmp($left, $right);
        return $cmp !== 0 ? $cmp : ((int)$a <=> (int)$b);
    });
    return $entryIds;
}

function voteValidateMoePoolConfig(array $pool, int $entryCount): void {
    $runtime = voteFlowPoolRuntime($pool);
    if ($runtime['rule_version'] < 2) return;
    $groupCount = $runtime['group_count'];
    if ($groupCount < 1) {
        throw new RuntimeException('分组数必须大于 0');
    }
    if ($entryCount <= 0) throw new RuntimeException('阶段池没有可用候选');
    $advanceCount = $runtime['advance_count'];
    $stageType = (string)($pool['stage_type'] ?? '');
    if (in_array($stageType, ['qualifier', 'group_vote'], true)) {
        if ($advanceCount <= 0) {
            throw new RuntimeException('晋级数必须大于 0');
        }
    }
}

function voteFlowCreatePool(PDO $db, array $run, array $stage): array {
    $project = voteGetProject((int)($run['project_id'] ?? $stage['project_id'] ?? 0));
    $isMoe = ($project['project_type'] ?? $stage['project_type'] ?? '') === 'moe';
    $config = $isMoe ? voteMoeRuntimeConfig($run, $stage) : voteStageConfig($stage);
    $stmt = $db->prepare(
        'INSERT INTO vote_flow_pools (run_id, project_id, stage_id, stage_type, title, status, vote_mode, group_count, max_select, advance_count, config_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    $stmt->execute([
        (int)$run['id'],
        (int)$run['project_id'],
        (int)$stage['id'],
        (string)$stage['stage_type'],
        (string)($stage['title'] ?? ''),
        'draft',
        (string)($stage['vote_mode'] ?? 'multi_select'),
        max(1, (int)($stage['group_count'] ?? 1)),
        max(1, (int)($stage['max_select'] ?? 1)),
        max(0, (int)($stage['advance_count'] ?? 0)),
        voteJson($config),
    ]);
    return voteFlowPoolById($db, (int)$db->lastInsertId());
}

function voteFlowSeedPoolEntries(PDO $db, array $pool, array $entryIds, ?int $sourcePoolId = null, array $rankMap = []): int {
    $entryIds = array_values(array_unique(array_filter(array_map('intval', $entryIds))));
    if (!$entryIds) return 0;
    $placeholders = implode(',', array_fill(0, count($entryIds), '?'));
    $stmt = $db->prepare("SELECT id FROM vote_entries WHERE project_id = ? AND entry_status = 'approved' AND id IN ($placeholders)");
    $stmt->execute(array_merge([(int)$pool['project_id']], $entryIds));
    $valid = array_flip(array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN)));
    $runtime = voteFlowPoolRuntime($pool);
    $groupCount = $runtime['group_count'];
    if ($runtime['rule_version'] >= 2 && $runtime['grouping_method'] === 'seeded_shuffle') {
        $entryIds = voteFlowDeterministicShuffle($entryIds, $runtime['grouping_seed']);
    }
    voteValidateMoePoolConfig($pool, count($entryIds));
    $ins = $db->prepare(
        "INSERT INTO vote_flow_pool_entries (run_id, pool_id, project_id, entry_id, group_key, seed_no, source_pool_id, source_rank, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')"
    );
    $seed = 1;
    foreach ($entryIds as $entryId) {
        if (!isset($valid[$entryId])) continue;
        $groupKey = $groupCount > 1 ? 'G' . (($seed - 1) % $groupCount + 1) : '';
        $ins->execute([(int)$pool['run_id'], (int)$pool['id'], (int)$pool['project_id'], $entryId, $groupKey, $seed, $sourcePoolId, $rankMap[$entryId] ?? null]);
        $seed++;
    }
    return $seed - 1;
}

function voteFlowPoolEntries(PDO $db, int $poolId): array {
    $stmt = $db->prepare(
        "SELECT fpe.*, e.title, e.title_cn, e.subtitle, e.image_url, e.source_type, e.source_id, e.entry_status
         FROM vote_flow_pool_entries fpe
         JOIN vote_entries e ON e.id = fpe.entry_id
         WHERE fpe.pool_id = ? AND fpe.status = 'active' AND e.entry_status = 'approved'
         ORDER BY fpe.seed_no ASC, fpe.entry_id ASC"
    );
    $stmt->execute([$poolId]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function voteFlowPoolUsageCounts(PDO $db, array $pool): array {
    $voteStmt = $db->prepare('SELECT COUNT(*) FROM vote_votes WHERE stage_id = ?');
    $voteStmt->execute([(int)$pool['stage_id']]);
    $matchStmt = $db->prepare('SELECT COUNT(*) FROM vote_flow_matches WHERE pool_id = ?');
    $matchStmt->execute([(int)$pool['id']]);
    $resultStmt = $db->prepare('SELECT COUNT(*) FROM vote_flow_results WHERE pool_id = ?');
    $resultStmt->execute([(int)$pool['id']]);
    return [
        'votes' => (int)$voteStmt->fetchColumn(),
        'matches' => (int)$matchStmt->fetchColumn(),
        'results' => (int)$resultStmt->fetchColumn(),
    ];
}

function voteFlowPoolCanRebuild(PDO $db, array $pool): bool {
    $counts = voteFlowPoolUsageCounts($db, $pool);
    return $counts['votes'] === 0 && $counts['matches'] === 0 && $counts['results'] === 0;
}

function voteFlowStatus(PDO $db, int $projectId): array {
    $run = voteFlowActiveRun($db, $projectId);
    if (!$run) return ['run' => null, 'pools' => [], 'active_pool' => null];
    $stmt = $db->prepare(
        "SELECT p.*,
                COUNT(DISTINCT e.id) AS entry_count,
                COUNT(DISTINCT r.id) AS result_count,
                COUNT(DISTINCT m.id) AS match_count
         FROM vote_flow_pools p
         LEFT JOIN vote_flow_pool_entries e ON e.pool_id = p.id AND e.status = 'active'
         LEFT JOIN vote_flow_results r ON r.pool_id = p.id
         LEFT JOIN vote_flow_matches m ON m.pool_id = p.id
         WHERE p.run_id = ?
         GROUP BY p.id
         ORDER BY p.id ASC"
    );
    $stmt->execute([(int)$run['id']]);
    $pools = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $active = null;
    foreach ($pools as &$pool) {
        $pool['runtime'] = voteFlowPoolRuntime($pool);
        $pool['usage'] = voteFlowPoolUsageCounts($db, $pool);
        $pool['can_rebuild'] = $pool['usage']['votes'] === 0
            && $pool['usage']['matches'] === 0
            && $pool['usage']['results'] === 0;
        if ($active === null && ($pool['status'] ?? '') === 'open') {
            $active = $pool;
        }
    }
    return ['run' => $run, 'pools' => $pools, 'active_pool' => $active];
}

function voteFlowRebuildFromNomination(PDO $db, array $project, ?int $userId = null): array {
    $projectId = (int)$project['id'];
    $qualifier = voteFlowStageByType($db, $projectId, 'qualifier');
    if (!$qualifier) throw new RuntimeException('缺少海选阶段配置');
    voteNormalizePendingEntries($db, $projectId);
    $stmt = $db->prepare("SELECT id FROM vote_entries WHERE project_id = ? AND entry_status = 'approved' ORDER BY reviewed_at ASC, id ASC");
    $stmt->execute([$projectId]);
    $entryIds = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    if (!$entryIds) throw new RuntimeException('没有有效提名，不能生成海选池');
    $versionStmt = $db->prepare('SELECT COALESCE(MAX(version_no), 0) + 1 FROM vote_flow_runs WHERE project_id = ?');
    $versionStmt->execute([$projectId]);
    $version = (int)$versionStmt->fetchColumn();
    $now = voteNowExpr();
    $db->beginTransaction();
    $db->prepare("UPDATE vote_flow_runs SET status = 'archived', archived_at = $now WHERE project_id = ? AND status = 'active'")->execute([$projectId]);
    $runStmt = $db->prepare('INSERT INTO vote_flow_runs (project_id, version_no, status, created_by, snapshot_json) VALUES (?, ?, ?, ?, ?)');
    $runStmt->execute([$projectId, $version, 'active', $userId, voteJson(['rebuilt_from' => 'nomination'])]);
    $run = ['id' => (int)$db->lastInsertId(), 'project_id' => $projectId, 'version_no' => $version, 'status' => 'active'];
    $pool = voteFlowCreatePool($db, $run, $qualifier);
    $count = voteFlowSeedPoolEntries($db, $pool, $entryIds, null, []);
    $nomination = voteFlowStageByType($db, $projectId, 'nomination');
    if ($nomination) {
        $db->prepare("UPDATE vote_stages SET status = 'locked', updated_at = $now WHERE id = ?")->execute([(int)$nomination['id']]);
    }
    voteFlowLog($db, (int)$run['id'], (int)$pool['id'], $projectId, 'rebuild_from_nomination', ['seeded_count' => $count]);
    $db->commit();
    return ['run' => $run, 'pool' => voteFlowPoolById($db, (int)$pool['id']), 'seeded_count' => $count];
}

function voteFlowRebuildFromNominationAndOpen(PDO $db, array $project, ?int $userId = null, bool $forceRebuild = false): array {
    $projectId = (int)$project['id'];
    $qualifier = voteFlowStageByType($db, $projectId, 'qualifier');
    if (!$qualifier) throw new RuntimeException('QUALIFIER_STAGE_NOT_FOUND');

    voteNormalizePendingEntries($db, $projectId);

    if (!$forceRebuild) {
        $existingPool = voteFlowPoolForStage($db, (int)$qualifier['id']);
        if ($existingPool && in_array((string)($existingPool['status'] ?? ''), ['draft', 'open', 'locked'], true)) {
            $existingCount = voteFlowPoolEntryCount($db, (int)$existingPool['id']);
            if ($existingCount > 0 && !voteFlowPoolCanRebuild($db, $existingPool)) {
                $pool = (string)$existingPool['status'] === 'open' ? $existingPool : voteFlowOpenPool($db, $existingPool);
                $runStmt = $db->prepare('SELECT * FROM vote_flow_runs WHERE id = ?');
                $runStmt->execute([(int)$pool['run_id']]);
                $run = $runStmt->fetch(PDO::FETCH_ASSOC) ?: [
                    'id' => (int)$pool['run_id'],
                    'project_id' => $projectId,
                    'status' => 'active',
                ];
                $nomination = voteFlowStageByType($db, $projectId, 'nomination');
                return [
                    'run' => $run,
                    'pool' => $pool,
                    'seeded_count' => $existingCount,
                    'readback_count' => $existingCount,
                    'source_stage_id' => $nomination ? (int)$nomination['id'] : null,
                    'target_stage_id' => (int)$qualifier['id'],
                    'existing' => true,
                ];
            }
            // Pool exists but has no activity (or is empty): re-seed in place from current nominations.
            $stmt = $db->prepare("SELECT id FROM vote_entries WHERE project_id = ? AND entry_status = 'approved' ORDER BY reviewed_at ASC, id ASC");
            $stmt->execute([$projectId]);
            $entryIds = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
            if (!$entryIds) throw new RuntimeException('NO_ELIGIBLE_NOMINATIONS');

            $now = voteNowExpr();
            $db->beginTransaction();
            try {
                $db->prepare('DELETE FROM vote_flow_pool_entries WHERE pool_id = ?')->execute([(int)$existingPool['id']]);
                $seeded = voteFlowSeedPoolEntries($db, $existingPool, $entryIds, null, []);
                $readback = voteFlowPoolEntryCount($db, (int)$existingPool['id']);
                if ($seeded <= 0 || $readback <= 0 || $seeded !== $readback) {
                    throw new RuntimeException('FLOW_POOL_READBACK_MISMATCH');
                }
                $db->prepare("UPDATE vote_flow_pools SET status = 'open', opened_at = COALESCE(opened_at, $now) WHERE id = ?")
                    ->execute([(int)$existingPool['id']]);
                $db->prepare("UPDATE vote_stages SET status = 'locked', updated_at = $now WHERE project_id = ? AND status = 'open' AND id <> ?")
                    ->execute([$projectId, (int)$qualifier['id']]);
                $db->prepare("UPDATE vote_stages SET status = 'open', starts_at = COALESCE(starts_at, $now), updated_at = $now WHERE id = ?")
                    ->execute([(int)$qualifier['id']]);
                $nomination = voteFlowStageByType($db, $projectId, 'nomination');
                if ($nomination) {
                    $db->prepare("UPDATE vote_stages SET status = 'locked', updated_at = $now WHERE id = ?")
                        ->execute([(int)$nomination['id']]);
                }
                voteFlowLog($db, (int)$existingPool['run_id'], (int)$existingPool['id'], $projectId, 'reseed_from_nomination_and_open', ['seeded_count' => $seeded]);
                $db->commit();
                $runStmt = $db->prepare('SELECT * FROM vote_flow_runs WHERE id = ?');
                $runStmt->execute([(int)$existingPool['run_id']]);
                $run = $runStmt->fetch(PDO::FETCH_ASSOC) ?: [
                    'id' => (int)$existingPool['run_id'],
                    'project_id' => $projectId,
                    'status' => 'active',
                ];
                return [
                    'run' => $run,
                    'pool' => voteFlowPoolById($db, (int)$existingPool['id']),
                    'seeded_count' => $seeded,
                    'readback_count' => $readback,
                    'source_stage_id' => $nomination ? (int)$nomination['id'] : null,
                    'target_stage_id' => (int)$qualifier['id'],
                    'existing' => true,
                ];
            } catch (Throwable $e) {
                if ($db->inTransaction()) $db->rollBack();
                throw $e;
            }
        }
    }

    $stmt = $db->prepare("SELECT id FROM vote_entries WHERE project_id = ? AND entry_status = 'approved' ORDER BY reviewed_at ASC, id ASC");
    $stmt->execute([$projectId]);
    $entryIds = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    if (!$entryIds) throw new RuntimeException('NO_ELIGIBLE_NOMINATIONS');

    $versionStmt = $db->prepare('SELECT COALESCE(MAX(version_no), 0) + 1 FROM vote_flow_runs WHERE project_id = ?');
    $versionStmt->execute([$projectId]);
    $version = (int)$versionStmt->fetchColumn();
    $now = voteNowExpr();

    try {
        $db->beginTransaction();
        $db->prepare("UPDATE vote_flow_runs SET status = 'archived', archived_at = $now WHERE project_id = ? AND status = 'active'")->execute([$projectId]);

        $runStmt = $db->prepare('INSERT INTO vote_flow_runs (project_id, version_no, status, created_by, snapshot_json) VALUES (?, ?, ?, ?, ?)');
        $runStmt->execute([$projectId, $version, 'active', $userId, voteJson(['rebuilt_from' => 'nomination', 'opened' => true])]);
        $run = ['id' => (int)$db->lastInsertId(), 'project_id' => $projectId, 'version_no' => $version, 'status' => 'active'];

        $pool = voteFlowCreatePool($db, $run, $qualifier);
        if (!$pool) throw new RuntimeException('FLOW_POOL_CREATE_FAILED');

        $seeded = voteFlowSeedPoolEntries($db, $pool, $entryIds, null, []);
        $readback = voteFlowPoolEntryCount($db, (int)$pool['id']);
        if ($seeded <= 0 || $readback <= 0 || $seeded !== $readback) {
            throw new RuntimeException('FLOW_POOL_READBACK_MISMATCH');
        }

        $nomination = voteFlowStageByType($db, $projectId, 'nomination');
        if ($nomination) {
            $db->prepare("UPDATE vote_stages SET status = 'locked', updated_at = $now WHERE id = ?")->execute([(int)$nomination['id']]);
        }
        $db->prepare("UPDATE vote_stages SET status = 'locked', updated_at = $now WHERE project_id = ? AND status = 'open' AND id <> ?")->execute([$projectId, (int)$qualifier['id']]);
        $db->prepare("UPDATE vote_stages SET status = 'open', starts_at = COALESCE(starts_at, $now), updated_at = $now WHERE id = ?")->execute([(int)$qualifier['id']]);
        $db->prepare("UPDATE vote_flow_pools SET status = 'locked' WHERE run_id = ? AND status = 'open' AND id <> ?")->execute([(int)$run['id'], (int)$pool['id']]);
        $db->prepare("UPDATE vote_flow_pools SET status = 'open', opened_at = COALESCE(opened_at, $now) WHERE id = ?")->execute([(int)$pool['id']]);

        voteFlowLog($db, (int)$run['id'], (int)$pool['id'], $projectId, 'rebuild_from_nomination_and_open', [
            'seeded_count' => $seeded,
            'readback_count' => $readback,
            'nomination_stage_id' => $nomination ? (int)$nomination['id'] : null,
            'qualifier_stage_id' => (int)$qualifier['id'],
        ]);
        $db->commit();

        return [
            'run' => $run,
            'pool' => voteFlowPoolById($db, (int)$pool['id']),
            'seeded_count' => $seeded,
            'readback_count' => $readback,
            'source_stage_id' => $nomination ? (int)$nomination['id'] : null,
            'target_stage_id' => (int)$qualifier['id'],
            'existing' => false,
        ];
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
}

function voteFlowOpenPool(PDO $db, array $pool): array {
    if (voteFlowPoolEntryCount($db, (int)$pool['id']) <= 0) {
        throw new RuntimeException('阶段池尚未生成，请联系负责人');
    }
    $now = voteNowExpr();
    $db->beginTransaction();
    try {
        $db->prepare("UPDATE vote_flow_pools SET status = 'locked' WHERE run_id = ? AND status = 'open' AND id <> ?")->execute([(int)$pool['run_id'], (int)$pool['id']]);
        $db->prepare("UPDATE vote_flow_pools SET status = 'open', opened_at = COALESCE(opened_at, $now) WHERE id = ?")->execute([(int)$pool['id']]);
        $db->prepare("UPDATE vote_stages SET status = 'locked', updated_at = $now WHERE project_id = ? AND status = 'open' AND id <> ?")->execute([(int)$pool['project_id'], (int)$pool['stage_id']]);
        $db->prepare("UPDATE vote_stages SET status = 'open', starts_at = COALESCE(starts_at, $now), updated_at = $now WHERE id = ?")->execute([(int)$pool['stage_id']]);
        voteFlowLog($db, (int)$pool['run_id'], (int)$pool['id'], (int)$pool['project_id'], 'open_pool');
        $db->commit();
        return voteFlowPoolById($db, (int)$pool['id']);
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
}

function voteFlowSortResultRows(array &$rows, string $mode, int $ruleVersion = 1): void {
    usort($rows, function ($a, $b) use ($mode, $ruleVersion) {
        if ($mode === 'score') {
            if ($ruleVersion < 2) {
                $averageCmp = ((float)($b['score_avg'] ?? 0)) <=> ((float)($a['score_avg'] ?? 0));
                if ($averageCmp !== 0) return $averageCmp;
                $voteCmp = ((int)($b['votes'] ?? 0)) <=> ((int)($a['votes'] ?? 0));
                if ($voteCmp !== 0) return $voteCmp;
            }
            $totalCmp = ((int)($b['score_total'] ?? $b['votes'] ?? 0)) <=> ((int)($a['score_total'] ?? $a['votes'] ?? 0));
            if ($totalCmp !== 0) return $totalCmp;
            $countCmp = ((int)($b['rating_count'] ?? 0)) <=> ((int)($a['rating_count'] ?? 0));
            if ($countCmp !== 0) return $countCmp;
            $averageCmp = ((float)($b['score_avg'] ?? 0)) <=> ((float)($a['score_avg'] ?? 0));
            if ($averageCmp !== 0) return $averageCmp;
        }
        $voteCmp = ((int)($b['votes'] ?? 0)) <=> ((int)($a['votes'] ?? 0));
        if ($voteCmp !== 0) return $voteCmp;
        $seedCmp = ((int)($a['seed_no'] ?? 0)) <=> ((int)($b['seed_no'] ?? 0));
        if ($seedCmp !== 0) return $seedCmp;
        return ((int)($a['entry_id'] ?? 0)) <=> ((int)($b['entry_id'] ?? 0));
    });
}

function voteFlowResultMetricEquals(array $left, array $right, string $mode): bool {
    if ($mode === 'score') {
        return (int)($left['score_total'] ?? $left['votes'] ?? 0) === (int)($right['score_total'] ?? $right['votes'] ?? 0)
            && (int)($left['rating_count'] ?? 0) === (int)($right['rating_count'] ?? 0)
            && abs((float)($left['score_avg'] ?? 0) - (float)($right['score_avg'] ?? 0)) < 0.0005;
    }
    return (int)($left['votes'] ?? 0) === (int)($right['votes'] ?? 0);
}

function voteFlowRankRowsForPoolDetailed(array $pool, array $rows): array {
    $mode = (string)($pool['vote_mode'] ?? 'multi_select');
    $runtime = voteFlowPoolRuntime($pool);
    $advanceCount = (int)($pool['advance_count'] ?? 0);
    if (($pool['stage_type'] ?? '') === 'final' && $mode === 'match_single') $advanceCount = 1;
    if ($advanceCount <= 0) $advanceCount = count($rows);

    $groupCount = max(1, (int)($pool['group_count'] ?? 1));
    $groupedStage = in_array(($pool['stage_type'] ?? ''), ['qualifier', 'group_vote'], true)
        && ($groupCount > 1 || $runtime['rule_version'] >= 2)
        && $advanceCount > 0;

    if (!$groupedStage) {
        voteFlowSortResultRows($rows, $mode, (int)$runtime['rule_version']);
        $ranked = [];
        $rank = 1;
        foreach ($rows as $row) {
            $row['_rank_no'] = $rank;
            $row['_advanced'] = $rank <= $advanceCount ? 1 : 0;
            $ranked[] = $row;
            $rank++;
        }
        return ['rows' => $ranked, 'tie_breaks' => []];
    }

    $basePerGroup = intdiv($advanceCount, $groupCount);
    $extraSlots = $advanceCount % $groupCount;
    $groups = [];
    $order = [];
    foreach ($rows as $index => $row) {
        $key = trim((string)($row['group_key'] ?? ''));
        if ($key === '') $key = 'G' . (($index % $groupCount) + 1);
        if (!isset($groups[$key])) {
            $groups[$key] = [];
            $order[] = $key;
        }
        $row['group_key'] = $key;
        $groups[$key][] = $row;
    }
    natcasesort($order);

    $ranked = [];
    $tieBreaks = [];
    $rank = 1;
    foreach ($order as $groupIndex => $key) {
        $groupRows = $groups[$key];
        voteFlowSortResultRows($groupRows, $mode, (int)$runtime['rule_version']);
        $target = $basePerGroup + ($groupIndex < $extraSlots ? 1 : 0);
        if ($target > count($groupRows)) {
            $target = count($groupRows);
        }
        if ($runtime['rule_version'] >= 2 && $target > 0 && count($groupRows) > $target) {
            $inside = $groupRows[$target - 1];
            $outside = $groupRows[$target];
            if (voteFlowResultMetricEquals($inside, $outside, $mode)) {
                $boundaryCandidates = array_values(array_filter(
                    $groupRows,
                    fn($row) => voteFlowResultMetricEquals($inside, $row, $mode)
                ));
                $automatic = 0;
                foreach ($groupRows as $row) {
                    if (voteFlowResultMetricEquals($inside, $row, $mode)) break;
                    $automatic++;
                }
                $tieBreaks[] = [
                    'group_key' => $key,
                    'slots' => max(1, $target - $automatic),
                    'entry_ids' => array_values(array_map(fn($row) => (int)$row['entry_id'], $boundaryCandidates)),
                ];
            }
        }
        $groupRank = 1;
        foreach ($groupRows as $row) {
            $row['_rank_no'] = $rank;
            $row['_group_rank'] = $groupRank;
            $row['_group_advance_count'] = $target;
            $pendingTie = false;
            foreach ($tieBreaks as $tieBreak) {
                if ($tieBreak['group_key'] === $key && in_array((int)$row['entry_id'], $tieBreak['entry_ids'], true)) {
                    $pendingTie = true;
                    break;
                }
            }
            $row['_advanced'] = !$pendingTie && $groupRank <= $target ? 1 : 0;
            $ranked[] = $row;
            $rank++;
            $groupRank++;
        }
    }
    return ['rows' => $ranked, 'tie_breaks' => $tieBreaks];
}

function voteFlowRankRowsForPool(array $pool, array $rows): array {
    return voteFlowRankRowsForPoolDetailed($pool, $rows)['rows'];
}

function voteFlowSettlePool(PDO $db, array $pool): array {
    if (!in_array($pool['status'] ?? '', ['open', 'locked'], true)) throw new RuntimeException('阶段池尚未打开，不能结算');
    if (($pool['vote_mode'] ?? '') === 'match_single') throw new RuntimeException('1v1 对决池按对阵自动结算，不支持整池结算');
    $db->beginTransaction();
    try {
        // 事务内锁池行并复查状态：聚合与写入基于同一快照，防止与投票/并发结算竞态丢票或互相覆盖
        if (voteIsMysql()) {
            $db->prepare('SELECT status FROM vote_flow_pools WHERE id = ? FOR UPDATE')->execute([(int)$pool['id']]);
        } else {
            $db->prepare('UPDATE vote_flow_pools SET status = status WHERE id = ?')->execute([(int)$pool['id']]);
        }
        $stmt = $db->prepare('SELECT status FROM vote_flow_pools WHERE id = ?');
        $stmt->execute([(int)$pool['id']]);
        $currentStatus = (string)$stmt->fetchColumn();
        if (!in_array($currentStatus, ['open', 'locked'], true)) throw new RuntimeException('阶段池状态已变化，不能结算');

        $runtime = voteFlowPoolRuntime($pool);
        $aggregate = ($pool['vote_mode'] ?? '') === 'score'
            ? ($runtime['rule_version'] >= 2
                ? 'COALESCE(SUM(v.score_value), 0) AS votes, COALESCE(SUM(v.score_value), 0) AS score_total, COUNT(v.id) AS rating_count, AVG(v.score_value) AS score_avg'
                : 'COALESCE(SUM(v.vote_value), 0) AS votes, COALESCE(SUM(v.score_value), 0) AS score_total, COUNT(v.id) AS rating_count, AVG(v.score_value) AS score_avg')
            : 'COALESCE(SUM(v.vote_value), 0) AS votes, 0 AS score_total, COUNT(v.id) AS rating_count, NULL AS score_avg';
        $stmt = $db->prepare(
            "SELECT fpe.entry_id, fpe.seed_no, fpe.group_key, $aggregate
             FROM vote_flow_pool_entries fpe
             LEFT JOIN vote_votes v ON v.entry_id = fpe.entry_id AND v.stage_id = ?
             WHERE fpe.pool_id = ? AND fpe.status = 'active'
             GROUP BY fpe.entry_id, fpe.seed_no, fpe.group_key
             ORDER BY fpe.group_key ASC, fpe.seed_no ASC"
        );
        $stmt->execute([(int)$pool['stage_id'], (int)$pool['id']]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $config = voteDecode($pool['config_json'] ?? '{}');
        if (($pool['vote_mode'] ?? '') === 'score' && empty($config['allow_zero_fill'])) {
            $rows = array_values(array_filter($rows, fn($row) => (int)($row['rating_count'] ?? 0) > 0));
        }
        if (!$rows) throw new RuntimeException('阶段池没有候选，不能结算');
        $ranking = voteFlowRankRowsForPoolDetailed($pool, $rows);
        $rankedRows = $ranking['rows'];
        $tieBreaks = $ranking['tie_breaks'];
        $now = voteNowExpr();
        $db->prepare('DELETE FROM vote_flow_results WHERE pool_id = ?')->execute([(int)$pool['id']]);
        $ins = $db->prepare(
            'INSERT INTO vote_flow_results (run_id, pool_id, project_id, entry_id, rank_no, votes, score_total, rating_count, score_avg, advanced, snapshot_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $advancedCount = 0;
        foreach ($rankedRows as $row) {
            $advanced = (int)($row['_advanced'] ?? 0);
            if ($advanced) $advancedCount++;
            $snapshot = [
                'group_key' => $row['group_key'] ?? '',
                'seed_no' => (int)($row['seed_no'] ?? 0),
            ];
            if (isset($row['_group_rank'])) {
                $snapshot['group_rank'] = (int)$row['_group_rank'];
                $snapshot['group_advance_count'] = (int)($row['_group_advance_count'] ?? 0);
            }
            $ins->execute([
                (int)$pool['run_id'],
                (int)$pool['id'],
                (int)$pool['project_id'],
                (int)$row['entry_id'],
                (int)$row['_rank_no'],
                (int)($row['votes'] ?? 0),
                (int)($row['score_total'] ?? 0),
                (int)($row['rating_count'] ?? 0),
                $row['score_avg'],
                $advanced,
                voteJson($snapshot),
            ]);
        }
        $nextStatus = $tieBreaks ? 'reviewing' : 'settled';
        $config['tie_breaks'] = $tieBreaks;
        $settledAt = $tieBreaks ? 'NULL' : $now;
        $db->prepare("UPDATE vote_flow_pools SET status = ?, settled_at = $settledAt, config_json = ? WHERE id = ?")
            ->execute([$nextStatus, voteJson($config), (int)$pool['id']]);
        $db->prepare("UPDATE vote_stages SET status = ?, updated_at = $now WHERE id = ?")
            ->execute([$nextStatus, (int)$pool['stage_id']]);
        if (!$tieBreaks && ($pool['stage_type'] ?? '') === 'final') {
            $db->prepare("UPDATE vote_projects SET status = 'ended', ended_at = COALESCE(ended_at, $now), updated_at = $now WHERE id = ?")->execute([(int)$pool['project_id']]);
        }
        voteFlowLog($db, (int)$pool['run_id'], (int)$pool['id'], (int)$pool['project_id'], 'settle_pool', [
            'advanced_count' => $advancedCount,
            'status' => $nextStatus,
            'tie_breaks' => $tieBreaks,
        ]);
        $db->commit();
        return [
            'advanced_count' => $advancedCount,
            'result_count' => count($rankedRows),
            'status' => $nextStatus,
            'tie_breaks' => $tieBreaks,
        ];
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
}

function voteFlowResolvePoolTie(PDO $db, array $pool, array $decisions): array {
    if (($pool['status'] ?? '') !== 'reviewing') {
        throw new RuntimeException('当前阶段池不在待裁定状态');
    }
    $config = voteDecode($pool['config_json'] ?? '{}');
    $tieBreaks = is_array($config['tie_breaks'] ?? null) ? $config['tie_breaks'] : [];
    if (!$tieBreaks) throw new RuntimeException('当前阶段池没有待裁定候选');

    $decisionMap = [];
    foreach ($decisions as $decision) {
        if (!is_array($decision)) continue;
        $groupKey = trim((string)($decision['group_key'] ?? ''));
        $entryIds = $decision['entry_ids'] ?? [];
        if ($groupKey === '' || !is_array($entryIds)) continue;
        $decisionMap[$groupKey] = array_values(array_unique(array_filter(array_map('intval', $entryIds))));
    }

    $selected = [];
    foreach ($tieBreaks as $tieBreak) {
        $groupKey = trim((string)($tieBreak['group_key'] ?? ''));
        $slots = max(1, (int)($tieBreak['slots'] ?? 1));
        $candidates = array_values(array_unique(array_map('intval', $tieBreak['entry_ids'] ?? [])));
        $chosen = $decisionMap[$groupKey] ?? [];
        if (count($chosen) !== $slots || array_diff($chosen, $candidates)) {
            throw new RuntimeException("分组 {$groupKey} 必须从待裁定候选中选择 {$slots} 项");
        }
        $selected = array_merge($selected, $chosen);
    }
    $selected = array_values(array_unique($selected));

    $now = voteNowExpr();
    $db->beginTransaction();
    try {
        if ($selected) {
            $placeholders = implode(',', array_fill(0, count($selected), '?'));
            $params = array_merge([(int)$pool['id']], $selected);
            $db->prepare("UPDATE vote_flow_results SET advanced = 1 WHERE pool_id = ? AND entry_id IN ($placeholders)")
                ->execute($params);
        }
        $config['tie_breaks'] = [];
        $db->prepare("UPDATE vote_flow_pools SET status = 'settled', settled_at = $now, config_json = ? WHERE id = ?")
            ->execute([voteJson($config), (int)$pool['id']]);
        $db->prepare("UPDATE vote_stages SET status = 'settled', updated_at = $now WHERE id = ?")
            ->execute([(int)$pool['stage_id']]);
        if (($pool['stage_type'] ?? '') === 'final') {
            $db->prepare("UPDATE vote_projects SET status = 'ended', ended_at = COALESCE(ended_at, $now), updated_at = $now WHERE id = ?")
                ->execute([(int)$pool['project_id']]);
        }
        $advancedCountStmt = $db->prepare('SELECT COUNT(*) FROM vote_flow_results WHERE pool_id = ? AND advanced = 1');
        $advancedCountStmt->execute([(int)$pool['id']]);
        $advancedCount = (int)$advancedCountStmt->fetchColumn();
        voteFlowLog($db, (int)$pool['run_id'], (int)$pool['id'], (int)$pool['project_id'], 'resolve_pool_tie', [
            'selected_entry_ids' => $selected,
            'advanced_count' => $advancedCount,
        ]);
        $db->commit();
        return ['advanced_count' => $advancedCount, 'selected_entry_ids' => $selected, 'status' => 'settled'];
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
}

function voteFlowGenerateNextPool(PDO $db, array $sourcePool): array {
    if (($sourcePool['status'] ?? '') !== 'settled') throw new RuntimeException('来源阶段尚未结算，不能生成下一阶段');
    $sourceStage = voteFetchStage((int)$sourcePool['stage_id']);
    $targetStage = $sourceStage ? voteNextStage($db, $sourceStage) : null;
    if (!$targetStage) throw new RuntimeException('没有可生成的下一阶段');
    $existing = voteFlowPoolForStage($db, (int)$targetStage['id']);
    if ($existing && (int)$existing['run_id'] === (int)$sourcePool['run_id']) {
        return ['pool' => $existing, 'seeded_count' => voteFlowPoolEntryCount($db, (int)$existing['id']), 'existing' => true];
    }
    $includeNonAdvancedFinalists = ($sourcePool['stage_type'] ?? '') === 'bracket'
        && ($targetStage['stage_type'] ?? '') === 'final';
    $resultSql = $includeNonAdvancedFinalists
        ? "SELECT entry_id, rank_no FROM vote_flow_results WHERE pool_id = ? ORDER BY advanced DESC, rank_no ASC, entry_id ASC LIMIT 4"
        : "SELECT entry_id, rank_no FROM vote_flow_results WHERE pool_id = ? AND advanced = 1 ORDER BY rank_no ASC, entry_id ASC";
    $stmt = $db->prepare($resultSql);
    $stmt->execute([(int)$sourcePool['id']]);
    $entryIds = [];
    $rankMap = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $entryId = (int)$row['entry_id'];
        $entryIds[] = $entryId;
        $rankMap[$entryId] = (int)$row['rank_no'];
    }
    if (!$entryIds) throw new RuntimeException('来源阶段没有晋级条目');
    $run = ['id' => (int)$sourcePool['run_id'], 'project_id' => (int)$sourcePool['project_id']];
    $db->beginTransaction();
    $pool = voteFlowCreatePool($db, $run, $targetStage);
    $count = voteFlowSeedPoolEntries($db, $pool, $entryIds, (int)$sourcePool['id'], $rankMap);
    voteFlowLog($db, (int)$sourcePool['run_id'], (int)$pool['id'], (int)$sourcePool['project_id'], 'generate_next_pool', ['source_pool_id' => (int)$sourcePool['id'], 'seeded_count' => $count]);
    $db->commit();
    return ['pool' => voteFlowPoolById($db, (int)$pool['id']), 'seeded_count' => $count, 'existing' => false];
}

function voteFlowPoolEntryCount(PDO $db, int $poolId): int {
    $stmt = $db->prepare("SELECT COUNT(*) FROM vote_flow_pool_entries WHERE pool_id = ? AND status = 'active'");
    $stmt->execute([$poolId]);
    return (int)$stmt->fetchColumn();
}

function voteFlowMatchRows(PDO $db, int $stageId): array {
    $pool = voteFlowPoolForStage($db, $stageId);
    if (!$pool) return [];
    $stmt = $db->prepare(
        "SELECT m.*,
                a.title AS slot_a_title, a.title_cn AS slot_a_title_cn, a.image_url AS slot_a_image,
                b.title AS slot_b_title, b.title_cn AS slot_b_title_cn, b.image_url AS slot_b_image,
                w.title AS winner_title, w.title_cn AS winner_title_cn
         FROM vote_flow_matches m
         LEFT JOIN vote_entries a ON a.id = m.slot_a_entry_id
         LEFT JOIN vote_entries b ON b.id = m.slot_b_entry_id
         LEFT JOIN vote_entries w ON w.id = m.winner_entry_id
         WHERE m.pool_id = ?
         ORDER BY m.round_no ASC, m.match_no ASC"
    );
    $stmt->execute([(int)$pool['id']]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function voteFlowGenerateMatches(PDO $db, array $pool): array {
    $project = voteGetProject((int)$pool['project_id']);
    if (!$project || ($project['project_type'] ?? '') !== 'moe' || !in_array(($pool['stage_type'] ?? ''), ['bracket', 'final'], true)) {
        throw new RuntimeException('只有萌战淘汰赛/决赛阶段可以生成对阵');
    }
    $existing = voteFlowMatchRows($db, (int)$pool['stage_id']);
    if ($existing) return $existing;
    $entries = voteFlowPoolEntries($db, (int)$pool['id']);
    $entryIds = array_map('intval', array_column($entries, 'entry_id'));
    if (!voteIsPowerOfTwo(count($entryIds))) throw new RuntimeException('萌战 1v1 晋级人数必须是 2 的幂');
    if (($pool['stage_type'] ?? '') === 'bracket' && count($entryIds) <= 2) {
        throw new RuntimeException('淘汰赛池至少需要 4 个候选，2 个候选请生成决赛池');
    }
    if (($pool['stage_type'] ?? '') === 'final' && count($entryIds) === 4) {
        // 决赛：半决赛胜者争夺冠亚军，败者争夺季军。
        $sourcePoolId = (int)($entries[0]['source_pool_id'] ?? 0);
        $winners = [];
        $losers = [];
        if ($sourcePoolId) {
            $sourceStmt = $db->prepare(
                'SELECT entry_id, advanced FROM vote_flow_results WHERE pool_id = ? AND entry_id IN (?, ?, ?, ?) ORDER BY advanced DESC, rank_no ASC, entry_id ASC'
            );
            $sourceStmt->execute([$sourcePoolId, $entryIds[0], $entryIds[1], $entryIds[2], $entryIds[3]]);
            foreach ($sourceStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                if ((int)$row['advanced'] === 1) {
                    $winners[] = (int)$row['entry_id'];
                } else {
                    $losers[] = (int)$row['entry_id'];
                }
            }
        }
        if (count($winners) !== 2 || count($losers) !== 2) {
            // 回退到 source_rank：1-2 名为半决赛胜者，3-4 名为败者。
            $winners = [];
            $losers = [];
            foreach ($entries as $entry) {
                $sourceRank = (int)($entry['source_rank'] ?? 0);
                if ($sourceRank > 0 && $sourceRank <= 2) {
                    $winners[] = (int)$entry['entry_id'];
                } elseif ($sourceRank > 0) {
                    $losers[] = (int)$entry['entry_id'];
                }
            }
        }
        if (count($winners) !== 2 || count($losers) !== 2) {
            // 最终回退：保持原数组顺序。
            $winners = array_slice($entryIds, 0, 2);
            $losers = array_slice($entryIds, 2, 2);
        }
        $db->beginTransaction();
        $ins = $db->prepare(
            "INSERT INTO vote_flow_matches (run_id, pool_id, project_id, stage_id, round_no, match_no, slot_a_entry_id, slot_b_entry_id, status)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'open')"
        );
        $ins->execute([(int)$pool['run_id'], (int)$pool['id'], (int)$pool['project_id'], (int)$pool['stage_id'], 1, $winners[0] ?? null, $winners[1] ?? null]);
        $ins->execute([(int)$pool['run_id'], (int)$pool['id'], (int)$pool['project_id'], (int)$pool['stage_id'], 2, $losers[0] ?? null, $losers[1] ?? null]);
        voteFlowLog($db, (int)$pool['run_id'], (int)$pool['id'], (int)$pool['project_id'], 'generate_final_matches', ['count' => count($entryIds), 'winners' => $winners, 'losers' => $losers]);
        $db->commit();
        return voteFlowMatchRows($db, (int)$pool['stage_id']);
    }
    $stopSize = ($pool['stage_type'] ?? '') === 'bracket' ? 2 : 1;
    $db->beginTransaction();
    $ins = $db->prepare(
        "INSERT INTO vote_flow_matches (run_id, pool_id, project_id, stage_id, round_no, match_no, slot_a_entry_id, slot_b_entry_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    $matchIdsByRound = [];
    $round = 1;
    $roundSize = count($entryIds);
    while ($roundSize > $stopSize) {
        $matchIdsByRound[$round] = [];
        for ($i = 0, $matchNo = 1; $i < $roundSize; $i += 2, $matchNo++) {
            $a = $round === 1 ? ($entryIds[$i] ?? null) : null;
            $b = $round === 1 ? ($entryIds[$i + 1] ?? null) : null;
            $status = $round === 1 && $a && $b ? 'open' : 'pending';
            $ins->execute([(int)$pool['run_id'], (int)$pool['id'], (int)$pool['project_id'], (int)$pool['stage_id'], $round, $matchNo, $a, $b, $status]);
            $matchIdsByRound[$round][$matchNo] = (int)$db->lastInsertId();
        }
        $round++;
        $roundSize = (int)($roundSize / 2);
    }
    foreach ($matchIdsByRound as $roundNo => $matches) {
        if (!isset($matchIdsByRound[$roundNo + 1])) continue;
        foreach ($matches as $matchNo => $matchId) {
            $nextMatchNo = (int)ceil($matchNo / 2);
            $nextSlot = $matchNo % 2 === 1 ? 'A' : 'B';
            $nextMatchId = $matchIdsByRound[$roundNo + 1][$nextMatchNo] ?? null;
            if ($nextMatchId) {
                $db->prepare("UPDATE vote_flow_matches SET next_match_id = ?, next_slot = ? WHERE id = ?")->execute([$nextMatchId, $nextSlot, $matchId]);
            }
        }
    }
    voteFlowLog($db, (int)$pool['run_id'], (int)$pool['id'], (int)$pool['project_id'], 'generate_matches', ['count' => count($entryIds)]);
    $db->commit();
    return voteFlowMatchRows($db, (int)$pool['stage_id']);
}

function voteFlowOpenNextReadyMatches(PDO $db, int $poolId): void {
    $stmt = $db->prepare("SELECT MIN(round_no) FROM vote_flow_matches WHERE pool_id = ? AND status = 'pending'");
    $stmt->execute([$poolId]);
    $roundNo = (int)$stmt->fetchColumn();
    if ($roundNo <= 0) return;
    $stmt = $db->prepare("SELECT COUNT(*) FROM vote_flow_matches WHERE pool_id = ? AND round_no = ? AND status = 'pending' AND (slot_a_entry_id IS NULL OR slot_b_entry_id IS NULL)");
    $stmt->execute([$poolId, $roundNo]);
    if ((int)$stmt->fetchColumn() > 0) return;
    $now = voteNowExpr();
    $db->prepare("UPDATE vote_flow_matches SET status = 'open', updated_at = $now WHERE pool_id = ? AND round_no = ? AND status = 'pending'")
        ->execute([$poolId, $roundNo]);
}

function voteFlowMatchVoteCounts(PDO $db, array $match): array {
    $stmt = $db->prepare(
        'SELECT entry_id, COALESCE(SUM(vote_value), 0) AS votes
         FROM vote_votes
         WHERE stage_id = ? AND match_id = ?
         GROUP BY entry_id'
    );
    $stmt->execute([(int)$match['stage_id'], (int)$match['id']]);
    $counts = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $counts[(int)$row['entry_id']] = (int)$row['votes'];
    }
    return $counts;
}

function voteFlowMatchWinnerFromVotes(array $match, array $counts): array {
    $slotA = (int)($match['slot_a_entry_id'] ?? 0);
    $slotB = (int)($match['slot_b_entry_id'] ?? 0);
    $votesA = $slotA ? (int)($counts[$slotA] ?? 0) : 0;
    $votesB = $slotB ? (int)($counts[$slotB] ?? 0) : 0;
    if (!$slotA || !$slotB) {
        return ['winner' => 0, 'reason' => 'missing_slot', 'slot_a_votes' => $votesA, 'slot_b_votes' => $votesB];
    }
    if ($votesA === $votesB) {
        if ($votesA === 0) {
            return ['winner' => 0, 'reason' => 'no_votes', 'slot_a_votes' => 0, 'slot_b_votes' => 0];
        }
        return ['winner' => 0, 'reason' => 'tie', 'slot_a_votes' => $votesA, 'slot_b_votes' => $votesB];
    }
    return [
        'winner' => $votesA > $votesB ? $slotA : $slotB,
        'reason' => '',
        'slot_a_votes' => $votesA,
        'slot_b_votes' => $votesB,
    ];
}

function voteFlowSettleOpenMatchesByVotes(PDO $db, array $pool): array {
    $stmt = $db->prepare("SELECT * FROM vote_flow_matches WHERE pool_id = ? AND status = 'open' ORDER BY round_no ASC, match_no ASC");
    $stmt->execute([(int)$pool['id']]);
    $settled = [];
    $unresolved = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $match) {
        $decision = voteFlowMatchWinnerFromVotes($match, voteFlowMatchVoteCounts($db, $match));
        if (($decision['reason'] ?? '') === 'no_votes') continue;
        if (empty($decision['winner'])) {
            $unresolved[] = array_merge([
                'match_id' => (int)$match['id'],
                'entry_ids' => array_values(array_filter([
                    (int)($match['slot_a_entry_id'] ?? 0),
                    (int)($match['slot_b_entry_id'] ?? 0),
                ])),
            ], $decision);
            continue;
        }
        voteFlowSettleMatch($db, $match, (int)$decision['winner']);
        $settled[] = array_merge([
            'match_id' => (int)$match['id'],
            'winner_entry_id' => (int)$decision['winner'],
        ], $decision);
    }
    if ($unresolved) {
        $fresh = voteFlowPoolById($db, (int)$pool['id']) ?: $pool;
        $config = voteDecode($fresh['config_json'] ?? '{}');
        $config['match_tie_breaks'] = $unresolved;
        $now = voteNowExpr();
        $db->prepare("UPDATE vote_flow_pools SET status = 'reviewing', config_json = ? WHERE id = ? AND status <> 'settled'")
            ->execute([voteJson($config), (int)$pool['id']]);
        $db->prepare("UPDATE vote_stages SET status = 'reviewing', updated_at = $now WHERE id = ? AND status <> 'settled'")
            ->execute([(int)$pool['stage_id']]);
    }
    return ['settled' => $settled, 'unresolved' => $unresolved];
}

function voteFlowSettleMatch(PDO $db, array $match, int $winnerEntryId): array {
    $pool = voteFlowPoolById($db, (int)$match['pool_id']);
    if (!$pool) throw new RuntimeException('流程池不存在');
    $slotA = (int)($match['slot_a_entry_id'] ?? 0);
    $slotB = (int)($match['slot_b_entry_id'] ?? 0);
    if (!$winnerEntryId || !in_array($winnerEntryId, array_filter([$slotA, $slotB]), true)) {
        throw new RuntimeException('胜者必须来自当前对阵 A/B 槽位');
    }
    $now = voteNowExpr();
    $db->beginTransaction();
    try {
        $db->prepare("UPDATE vote_flow_matches SET winner_entry_id = ?, status = 'settled', updated_at = $now WHERE id = ?")
            ->execute([$winnerEntryId, (int)$match['id']]);
        if (!empty($match['next_match_id'])) {
            $field = ($match['next_slot'] ?? '') === 'B' ? 'slot_b_entry_id' : 'slot_a_entry_id';
            $db->prepare("UPDATE vote_flow_matches SET $field = ?, updated_at = $now WHERE id = ?")->execute([$winnerEntryId, (int)$match['next_match_id']]);
            voteFlowOpenNextReadyMatches($db, (int)$pool['id']);
        } else {
            voteFlowMaybeSettleTerminalMatches($db, $pool);
        }
        $freshPool = voteFlowPoolById($db, (int)$pool['id']) ?: $pool;
        $config = voteDecode($freshPool['config_json'] ?? '{}');
        if (is_array($config['match_tie_breaks'] ?? null)) {
            $config['match_tie_breaks'] = array_values(array_filter(
                $config['match_tie_breaks'],
                fn($tie) => (int)($tie['match_id'] ?? 0) !== (int)$match['id']
            ));
            $db->prepare("UPDATE vote_flow_pools SET config_json = ?, status = CASE WHEN status = 'reviewing' AND ? = 0 THEN 'open' ELSE status END WHERE id = ?")
                ->execute([voteJson($config), count($config['match_tie_breaks']), (int)$pool['id']]);
            if (!$config['match_tie_breaks']) {
                $db->prepare("UPDATE vote_stages SET status = CASE WHEN status = 'reviewing' THEN 'open' ELSE status END, starts_at = COALESCE(starts_at, CASE WHEN status = 'reviewing' THEN $now ELSE NULL END) WHERE id = ?")
                    ->execute([(int)$pool['stage_id']]);
            }
        }
        voteFlowLog($db, (int)$pool['run_id'], (int)$pool['id'], (int)$pool['project_id'], 'settle_match', ['match_id' => (int)$match['id'], 'winner_entry_id' => $winnerEntryId]);
        $db->commit();
        return voteFlowMatchRows($db, (int)$pool['stage_id']);
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
}

function voteFlowMaybeSettleTerminalMatches(PDO $db, array $pool): void {
    $stmt = $db->prepare("SELECT * FROM vote_flow_matches WHERE pool_id = ? AND next_match_id IS NULL ORDER BY match_no ASC");
    $stmt->execute([(int)$pool['id']]);
    $terminal = $stmt->fetchAll(PDO::FETCH_ASSOC);
    if (!$terminal) return;
    foreach ($terminal as $match) {
        if (($match['status'] ?? '') !== 'settled' || empty($match['winner_entry_id'])) return;
    }
    $db->prepare('DELETE FROM vote_flow_results WHERE pool_id = ?')->execute([(int)$pool['id']]);
    $ins = $db->prepare(
        'INSERT INTO vote_flow_results (run_id, pool_id, project_id, entry_id, rank_no, votes, score_avg, advanced, snapshot_json)
         VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)'
    );
    if (($pool['stage_type'] ?? '') === 'final') {
        foreach ($terminal as $index => $match) {
            $winner = (int)$match['winner_entry_id'];
            $loser = (int)$match['slot_a_entry_id'] === $winner ? (int)$match['slot_b_entry_id'] : (int)$match['slot_a_entry_id'];
            $winnerRank = $index === 0 ? 1 : 3;
            $loserRank = $index === 0 ? 2 : 4;
            $role = $index === 0 ? 'champion' : 'third_place';
            $ins->execute([(int)$pool['run_id'], (int)$pool['id'], (int)$pool['project_id'], $winner, $winnerRank, $winnerRank === 1 ? 1 : 0, voteJson(['match_id' => (int)$match['id'], 'role' => $role, 'result' => 'winner'])]);
            if ($loser) {
                $ins->execute([(int)$pool['run_id'], (int)$pool['id'], (int)$pool['project_id'], $loser, $loserRank, 0, voteJson(['match_id' => (int)$match['id'], 'role' => $role, 'result' => 'loser'])]);
            }
        }
    } else {
        $winners = [];
        $losers = [];
        foreach ($terminal as $match) {
            $winner = (int)$match['winner_entry_id'];
            $loser = (int)$match['slot_a_entry_id'] === $winner ? (int)$match['slot_b_entry_id'] : (int)$match['slot_a_entry_id'];
            $winners[] = ['entry_id' => $winner, 'match_id' => (int)$match['id']];
            if ($loser) $losers[] = ['entry_id' => $loser, 'match_id' => (int)$match['id']];
        }
        $rank = 1;
        foreach ($winners as $row) {
            $ins->execute([(int)$pool['run_id'], (int)$pool['id'], (int)$pool['project_id'], $row['entry_id'], $rank, 1, voteJson(['match_id' => $row['match_id'], 'role' => 'bracket_winner'])]);
            $rank++;
        }
        foreach ($losers as $row) {
            $ins->execute([(int)$pool['run_id'], (int)$pool['id'], (int)$pool['project_id'], $row['entry_id'], $rank, 0, voteJson(['match_id' => $row['match_id'], 'role' => 'bracket_loser'])]);
            $rank++;
        }
    }
    $now = voteNowExpr();
    $db->prepare("UPDATE vote_flow_pools SET status = 'settled', settled_at = $now WHERE id = ?")->execute([(int)$pool['id']]);
    $db->prepare("UPDATE vote_stages SET status = 'settled', updated_at = $now WHERE id = ?")->execute([(int)$pool['stage_id']]);
    if (($pool['stage_type'] ?? '') === 'final') {
        $db->prepare("UPDATE vote_projects SET status = 'ended', ended_at = COALESCE(ended_at, $now), updated_at = $now WHERE id = ?")->execute([(int)$pool['project_id']]);
    }
}

function voteSettleStage(PDO $db, array $stage): array {
    if (!in_array($stage['status'] ?? '', ['open', 'locked'], true)) {
        // 已 settled/reviewing 的阶段禁止重入结算，防止覆盖人工裁定结果
        throw new RuntimeException('当前阶段不在可结算状态（已结算或待裁定请走对应流程）');
    }
    $stageId = (int)$stage['id'];
    $projectId = (int)$stage['project_id'];
    $mode = $stage['vote_mode'] ?? 'multi_select';
    $db->beginTransaction();
    try {
        // 事务内锁阶段行并复查状态：聚合与写入基于同一快照，防并发结算竞态
        if (voteIsMysql()) {
            $db->prepare('SELECT status FROM vote_stages WHERE id = ? FOR UPDATE')->execute([$stageId]);
        } else {
            $db->prepare('UPDATE vote_stages SET status = status WHERE id = ?')->execute([$stageId]);
        }
        $stmt = $db->prepare('SELECT status FROM vote_stages WHERE id = ?');
        $stmt->execute([$stageId]);
        if (!in_array((string)$stmt->fetchColumn(), ['open', 'locked'], true)) {
            throw new RuntimeException('当前阶段状态已变化，不能结算');
        }
        if ($mode === 'nomination' || ($stage['stage_type'] ?? '') === 'nomination') {
        $stmt = $db->prepare(
            "SELECT id AS entry_id, 0 AS votes, NULL AS score_avg
             FROM vote_entries
             WHERE project_id = ? AND entry_status = 'approved'
             ORDER BY id ASC"
        );
        $stmt->execute([$projectId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } else {
        voteEnsureStageEntries($db, $stage);
        $aggregate = $mode === 'score'
            ? 'COUNT(v.id) AS votes, AVG(v.score_value) AS score_avg'
            : 'COALESCE(SUM(v.vote_value), 0) AS votes, NULL AS score_avg';
        $order = $mode === 'score' ? 'score_avg DESC, votes DESC, se.seed_no ASC, e.id ASC' : 'votes DESC, se.seed_no ASC, e.id ASC';
        $stmt = $db->prepare(
            "SELECT e.id AS entry_id, se.group_key, se.seed_no, $aggregate
             FROM vote_stage_entries se
             JOIN vote_entries e ON e.id = se.entry_id
             LEFT JOIN vote_votes v ON v.entry_id = e.id AND v.stage_id = se.stage_id
             WHERE se.project_id = ? AND se.stage_id = ? AND se.status = 'active' AND e.entry_status = 'approved'
             GROUP BY e.id, se.group_key, se.seed_no
             ORDER BY $order"
        );
        $stmt->execute([$projectId, $stageId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    }
    $config = voteStageConfig($stage);
    $allowZeroFill = !empty($config['allow_zero_fill']);
    if (!$allowZeroFill && $mode !== 'nomination') {
        $rows = array_values(array_filter($rows, fn($row) => (int)($row['votes'] ?? 0) > 0));
    }
    $aggregate = $mode === 'score'
        ? fn($row) => [(float)($row['score_avg'] ?? 0), (int)($row['votes'] ?? 0)]
        : fn($row) => [(int)($row['votes'] ?? 0)];
    $advance = max(0, (int)($stage['advance_count'] ?? 0));
    $tieBreak = null;
    $autoAdvanced = [];
    if ($advance > 0 && count($rows) > $advance && voteMetricEquals($rows[$advance - 1], $rows[$advance], $mode)) {
        $boundary = $rows[$advance - 1];
        $tieGroup = [];
        $beforeTie = [];
        foreach ($rows as $index => $row) {
            if (voteMetricEquals($row, $boundary, $mode)) {
                $tieGroup[] = (int)$row['entry_id'];
            } elseif ($index < $advance) {
                $beforeTie[] = (int)$row['entry_id'];
            }
        }
        $slots = max(0, $advance - count($beforeTie));
        if ($slots > 0 && count($tieGroup) > $slots) {
            $autoAdvanced = array_flip($beforeTie);
            $tieBreak = [
                'stage_id' => $stageId,
                'advance_count' => $advance,
                'slots' => $slots,
                'base_advanced_entry_ids' => $beforeTie,
                'candidate_entry_ids' => $tieGroup,
                'metric' => $aggregate($boundary),
            ];
        }
    }
    $db->prepare('DELETE FROM vote_results WHERE stage_id = ?')->execute([$stageId]);
    $ins = $db->prepare(
        "INSERT INTO vote_results (project_id, stage_id, entry_id, rank_no, votes, score_avg, advanced, snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    $rank = 1;
    foreach ($rows as $row) {
        $advanced = $advance > 0 && ($tieBreak ? isset($autoAdvanced[(int)$row['entry_id']]) : $rank <= $advance) ? 1 : 0;
        $ins->execute([
            $projectId,
            $stageId,
            (int)$row['entry_id'],
            $rank,
            (int)($row['votes'] ?? 0),
            $row['score_avg'] === null ? null : (float)$row['score_avg'],
            $advanced,
            voteJson($row),
        ]);
        $rank++;
    }
    $now = voteNowExpr();
    if ($tieBreak) {
        $config['tie_break'] = $tieBreak;
        $db->prepare("UPDATE vote_stages SET status = 'reviewing', config_json = ?, updated_at = $now WHERE id = ?")->execute([voteJson($config), $stageId]);
        $db->commit();
        return $rows;
    }
    unset($config['tie_break']);
    $db->prepare("UPDATE vote_stages SET status = 'settled', config_json = ?, updated_at = $now WHERE id = ?")->execute([voteJson($config), $stageId]);
    voteAdvanceNextStage($db, array_merge($stage, ['config_json' => voteJson($config)]));
    $db->commit();
    return $rows;
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
}

function voteResolveStageTie(PDO $db, array $stage, array $selectedEntryIds): void {
    $config = voteStageConfig($stage);
    $tie = is_array($config['tie_break'] ?? null) ? $config['tie_break'] : null;
    if (!$tie) {
        voteRespond(['success' => false, 'message' => '当前阶段没有待裁定的同票结果'], 400);
    }
    $slots = (int)($tie['slots'] ?? 0);
    $candidates = array_map('intval', $tie['candidate_entry_ids'] ?? []);
    $base = array_map('intval', $tie['base_advanced_entry_ids'] ?? []);
    $selectedEntryIds = array_values(array_unique(array_map('intval', $selectedEntryIds)));
    if (count($selectedEntryIds) !== $slots || array_diff($selectedEntryIds, $candidates)) {
        voteRespond(['success' => false, 'message' => '裁定条目数量或范围不正确'], 400);
    }
    $advanced = array_flip(array_merge($base, $selectedEntryIds));
    $stmt = $db->prepare('SELECT entry_id FROM vote_results WHERE stage_id = ?');
    $stmt->execute([(int)$stage['id']]);
    foreach (array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN)) as $entryId) {
        $db->prepare('UPDATE vote_results SET advanced = ? WHERE stage_id = ? AND entry_id = ?')
            ->execute([isset($advanced[$entryId]) ? 1 : 0, (int)$stage['id'], $entryId]);
    }
    unset($config['tie_break']);
    $now = voteNowExpr();
    $db->prepare("UPDATE vote_stages SET status = 'settled', config_json = ?, updated_at = $now WHERE id = ?")->execute([voteJson($config), (int)$stage['id']]);
    voteAdvanceNextStage($db, array_merge($stage, ['config_json' => voteJson($config)]));
}
