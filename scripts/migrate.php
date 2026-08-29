<?php
// scripts/migrate.php - 创建数据库表（CLI 脚本）
// 用法: php scripts/migrate.php
// 支持 SQLite 和 MySQL 两种驱动，由 config.php 中 DB_DRIVER 控制

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/moe.php';
require_once __DIR__ . '/../includes/twelve.php';
require_once __DIR__ . '/../Forum/includes/forum_schema.php';

echo "开始创建数据库表... (驱动: " . (defined('DB_DRIVER') ? DB_DRIVER : 'sqlite') . ")\n";

$db = getDB();
$isMysql = defined('DB_DRIVER') && DB_DRIVER === 'mysql';

if ($isMysql) {
    // ==================== MySQL 建表 ====================

    // MySQL 不支持 CREATE INDEX IF NOT EXISTS，用 try-catch 包装
    $tryIndex = function (string $sql) use ($db) {
        try { $db->exec($sql); } catch (PDOException $e) { /* 索引已存在，忽略 */ }
    };

    $db->exec("
        CREATE TABLE IF NOT EXISTS users (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            qq_openid     VARCHAR(255) UNIQUE,
            discord_id    VARCHAR(255) UNIQUE,
            qq_unionid    VARCHAR(255),
            password_hash VARCHAR(255),
            username      VARCHAR(255) NOT NULL UNIQUE,
            avatar_url    VARCHAR(500) DEFAULT '',
            role          VARCHAR(50) NOT NULL DEFAULT 'visitor',
            status        VARCHAR(50) NOT NULL DEFAULT 'active',
            language_preference VARCHAR(5) NULL DEFAULT NULL,
            created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_login_at DATETIME
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    echo "[OK] users 表已创建\n";

    // 迁移：添加新列（安全，列已存在时忽略）
    $tryAlter = function (string $sql) use ($db) {
        try { $db->exec($sql); } catch (PDOException $e) { /* 列已存在，忽略 */ }
    };
    $tryAlter("ALTER TABLE users ADD COLUMN email VARCHAR(255) UNIQUE");
    $tryAlter("ALTER TABLE users ADD COLUMN email_verified_at DATETIME");
    $tryAlter("ALTER TABLE users ADD COLUMN avatar_updated_at DATETIME");
    $tryAlter("ALTER TABLE users ADD COLUMN nickname VARCHAR(255) DEFAULT '' AFTER username");
    $tryAlter("ALTER TABLE users ADD COLUMN profile_bio VARCHAR(300) DEFAULT ''");
    $tryAlter("ALTER TABLE users ADD COLUMN membership_application_email_enabled TINYINT(1) NOT NULL DEFAULT 1");
    $tryAlter("ALTER TABLE users ADD COLUMN display_membership_id INT NULL");
    $tryAlter("ALTER TABLE users ADD COLUMN language_preference VARCHAR(5) NULL DEFAULT NULL");
    $tryIndex("CREATE INDEX idx_users_display_membership ON users(display_membership_id)");

    $db->exec("
        CREATE TABLE IF NOT EXISTS sessions (
            id           VARCHAR(128) PRIMARY KEY,
            user_id      INT NOT NULL,
            ip_address   VARCHAR(45),
            user_agent   TEXT,
            created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at   DATETIME NOT NULL,
            is_valid     TINYINT(1) NOT NULL DEFAULT 1,
            FOREIGN KEY (user_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_sessions_user ON sessions(user_id)");
    $tryIndex("CREATE INDEX idx_sessions_expires ON sessions(expires_at)");
    echo "[OK] sessions 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS clubs (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            province      VARCHAR(255) NOT NULL DEFAULT '',
            prefecture    VARCHAR(255) DEFAULT '',
            representative_id INT,
            visibility    VARCHAR(50) DEFAULT 'public',
            country       VARCHAR(50) DEFAULT 'china'
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    echo "[OK] clubs 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS audit_logs (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            user_id     INT,
            action      VARCHAR(255) NOT NULL,
            target_type VARCHAR(255),
            target_id   INT,
            details     TEXT,
            ip_address  VARCHAR(45),
            created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_audit_user ON audit_logs(user_id)");
    $tryIndex("CREATE INDEX idx_audit_created ON audit_logs(created_at)");
    echo "[OK] audit_logs 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS rate_limits (
            ip_address   VARCHAR(45) NOT NULL,
            endpoint     VARCHAR(255) NOT NULL,
            hit_count    INT DEFAULT 1,
            window_start DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (ip_address, endpoint)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    echo "[OK] rate_limits 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS notifications (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            user_id       INT NOT NULL,
            type          VARCHAR(50) NOT NULL,
            title         VARCHAR(255) NOT NULL,
            message       TEXT NOT NULL,
            link          VARCHAR(500) DEFAULT '',
            related_type  VARCHAR(50) DEFAULT '',
            related_id    INT DEFAULT 0,
            is_read       TINYINT(1) NOT NULL DEFAULT 0,
            created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            read_at       DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_notif_user ON notifications(user_id, is_read, created_at)");
    echo "[OK] notifications 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS club_memberships (
            id       INT AUTO_INCREMENT PRIMARY KEY,
            user_id  INT NOT NULL,
            club_id  INT NOT NULL,
            role     VARCHAR(50) NOT NULL DEFAULT 'member',
            status   VARCHAR(50) NOT NULL DEFAULT 'active',
            qq_account VARCHAR(255) DEFAULT '',
            contact_account VARCHAR(255) DEFAULT '',
            apply_role VARCHAR(50) DEFAULT 'member',
            is_student INT DEFAULT 0,
            country  VARCHAR(20) DEFAULT 'china',
            join_method VARCHAR(50) DEFAULT 'school_no_code',
            external_club_name VARCHAR(255) DEFAULT '',
            external_club_role VARCHAR(255) DEFAULT '',
            apply_reason TEXT,
            application_email_enabled TINYINT(1) NOT NULL DEFAULT 1,
            joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            left_at  DATETIME,
            UNIQUE(user_id, club_id, country),
            FOREIGN KEY (user_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_memberships_user ON club_memberships(user_id)");
    $tryIndex("CREATE INDEX idx_memberships_club ON club_memberships(club_id)");
    echo "[OK] club_memberships 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS club_verification_codes (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            club_id     INT NOT NULL,
            code        VARCHAR(255) NOT NULL,
            created_by  INT NOT NULL,
            max_uses    INT DEFAULT 50,
            use_count   INT DEFAULT 0,
            expires_at  DATETIME,
            is_active   TINYINT(1) NOT NULL DEFAULT 1,
            created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_verify_codes_club ON club_verification_codes(club_id)");
    echo "[OK] club_verification_codes 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS club_bot_tokens (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            club_id      INT NOT NULL,
            country      VARCHAR(20) DEFAULT 'china',
            name         VARCHAR(120) DEFAULT '',
            token_prefix VARCHAR(64) NOT NULL,
            token_hash   VARCHAR(255) NOT NULL,
            permissions  TEXT,
            created_by   INT NOT NULL,
            created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_used_at DATETIME NULL,
            revoked_at   DATETIME NULL,
            FOREIGN KEY (created_by) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_club_bot_tokens_club ON club_bot_tokens(club_id, country)");
    $tryIndex("CREATE INDEX idx_club_bot_tokens_prefix ON club_bot_tokens(token_prefix)");
    echo "[OK] club_bot_tokens 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS club_recommendations (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            club_id     INT NOT NULL,
            country     VARCHAR(20) DEFAULT 'china',
            bangumi_id  INT NOT NULL,
            title       VARCHAR(255) NOT NULL,
            image_url   VARCHAR(500) DEFAULT '',
            rating      DECIMAL(3,1) DEFAULT 0,
            summary     TEXT,
            sort_order  INT DEFAULT 0,
            created_by  INT NOT NULL,
            created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_recommendations_club ON club_recommendations(club_id, sort_order)");
    echo "[OK] club_recommendations 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS club_moe_kings (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            club_id       INT NOT NULL,
            country       VARCHAR(20) DEFAULT 'china',
            character_id  INT NOT NULL,
            name          VARCHAR(255) NOT NULL,
            name_cn       VARCHAR(255) DEFAULT '',
            image_url     VARCHAR(500) DEFAULT '',
            summary       TEXT,
            updated_by    INT NOT NULL,
            updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_moe_king_club (club_id, country),
            FOREIGN KEY (updated_by) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_moe_kings_club ON club_moe_kings(club_id, country)");
    echo "[OK] club_moe_kings 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS club_comments (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            club_id     INT NOT NULL,
            country     VARCHAR(20) DEFAULT 'china',
            user_id     INT NOT NULL,
            content     TEXT NOT NULL,
            created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at  DATETIME,
            is_deleted  TINYINT(1) DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_comments_club ON club_comments(club_id, created_at)");
    echo "[OK] club_comments 表已创建\n";

    $tryAlter("ALTER TABLE club_verification_codes ADD COLUMN country VARCHAR(20) DEFAULT 'china'");
    echo "[OK] club_verification_codes.country 列已添加\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS email_verifications (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            user_id     INT NOT NULL,
            email       VARCHAR(255) NOT NULL,
            code        VARCHAR(10) NOT NULL,
            expires_at  DATETIME NOT NULL,
            used        TINYINT(1) NOT NULL DEFAULT 0,
            created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_email_verify_user ON email_verifications(user_id)");
    echo "[OK] email_verifications 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS galonly_events (
            id                INT AUTO_INCREMENT PRIMARY KEY,
            name              VARCHAR(255) NOT NULL,
            location          VARCHAR(255) NOT NULL DEFAULT '',
            date              DATE NOT NULL,
            registration_open TINYINT(1) NOT NULL DEFAULT 1,
            staff_only        TINYINT(1) NOT NULL DEFAULT 0,
            event_code        VARCHAR(32) NOT NULL DEFAULT '',
            description       TEXT,
            created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    echo "[OK] galonly_events 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS galonly_applications (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            event_id      INT NOT NULL,
            user_id       INT NOT NULL,
            is_joint      TINYINT(1) NOT NULL DEFAULT 0,
            joint_name    VARCHAR(255) NOT NULL DEFAULT '',
            wants_upgrade TINYINT(1) NOT NULL DEFAULT 0,
            contact       VARCHAR(255) NOT NULL DEFAULT '',
            notes         TEXT,
            image_path    VARCHAR(500) NOT NULL DEFAULT '',
            status        VARCHAR(20) NOT NULL DEFAULT 'pending',
            created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (event_id) REFERENCES galonly_events(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_galonly_app_event ON galonly_applications(event_id)");
    $tryIndex("CREATE INDEX idx_galonly_app_user ON galonly_applications(user_id)");
    $tryIndex("CREATE INDEX idx_galonly_app_status ON galonly_applications(status)");
    echo "[OK] galonly_applications 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS galonly_application_clubs (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            application_id  INT NOT NULL,
            club_id         INT NOT NULL,
            club_country    VARCHAR(50) NOT NULL DEFAULT '',
            UNIQUE(application_id, club_id),
            FOREIGN KEY (application_id) REFERENCES galonly_applications(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_galonly_app_clubs_app ON galonly_application_clubs(application_id)");
    echo "[OK] galonly_application_clubs 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS galonly_votes (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            application_id  INT NOT NULL,
            auditer_id      INT NOT NULL,
            vote            VARCHAR(10) NOT NULL,
            created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(application_id, auditer_id),
            FOREIGN KEY (application_id) REFERENCES galonly_applications(id),
            FOREIGN KEY (auditer_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_galonly_votes_app ON galonly_votes(application_id)");
    echo "[OK] galonly_votes 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS galonly_public_votes (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            event_id        INT NOT NULL,
            application_id  INT NOT NULL,
            ip_address      VARCHAR(45) NOT NULL,
            created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(event_id, ip_address, application_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_galonly_public_votes_event ON galonly_public_votes(event_id)");
    $tryIndex("CREATE INDEX idx_galonly_public_votes_app ON galonly_public_votes(application_id)");
    echo "[OK] galonly_public_votes 表已创建\n";

    $tryAlter("ALTER TABLE galonly_events ADD COLUMN staff_deadline DATETIME NULL");
    $tryAlter("ALTER TABLE galonly_events ADD COLUMN staff_max_applicants INT DEFAULT NULL");
    $tryAlter("ALTER TABLE galonly_events ADD COLUMN staff_required_count INT NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_events ADD COLUMN staff_registration_open TINYINT(1) NOT NULL DEFAULT 1");
    $tryAlter("ALTER TABLE galonly_events ADD COLUMN staff_roster_finalized TINYINT(1) NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_events ADD COLUMN staff_only TINYINT(1) NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_events ADD COLUMN event_code VARCHAR(32) NOT NULL DEFAULT ''");
    echo "[OK] galonly_events Staff 配置列已添加\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS galonly_staff_applications (
            id INT AUTO_INCREMENT PRIMARY KEY,
            event_id INT NOT NULL,
            user_id INT NOT NULL,
            cn_name VARCHAR(255) NOT NULL DEFAULT '',
            qq_number VARCHAR(32) NOT NULL DEFAULT '',
            phone_number VARCHAR(32) NOT NULL DEFAULT '',
            email VARCHAR(255) NOT NULL DEFAULT '',
            club_id INT NOT NULL DEFAULT 0,
            club_country VARCHAR(50) NOT NULL DEFAULT 'china',
            positions TEXT NOT NULL,
            confirm_schedule TINYINT(1) NOT NULL DEFAULT 0,
            is_cosplay TINYINT(1) NOT NULL DEFAULT 0,
            three_day_available TINYINT(1) NOT NULL DEFAULT 0,
            self_intro TEXT,
            gender VARCHAR(20) NOT NULL DEFAULT '',
            staff_experience TINYINT(1) NOT NULL DEFAULT 0,
            skills TEXT,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            voted_by INT DEFAULT NULL,
            vote VARCHAR(20) DEFAULT NULL,
            resubmitted TINYINT(1) NOT NULL DEFAULT 0,
            has_update TINYINT(1) NOT NULL DEFAULT 0,
            active_key VARCHAR(64) GENERATED ALWAYS AS (
                CASE WHEN status IN ('pending','pooled') THEN CONCAT(event_id, ':', user_id) ELSE NULL END
            ) STORED,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY idx_staff_app_active (active_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN event_id INT NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN user_id INT NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN cn_name VARCHAR(255) NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN qq_number VARCHAR(32) NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN phone_number VARCHAR(32) NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN email VARCHAR(255) NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN club_id INT NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN club_country VARCHAR(50) NOT NULL DEFAULT 'china'");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN positions TEXT NULL");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN confirm_schedule TINYINT(1) NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN is_cosplay TINYINT(1) NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN three_day_available TINYINT(1) NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN self_intro TEXT NULL");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN gender VARCHAR(20) NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN staff_experience TINYINT(1) NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN skills TEXT NULL");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'pending'");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN voted_by INT DEFAULT NULL");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN vote VARCHAR(20) DEFAULT NULL");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN resubmitted TINYINT(1) NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN has_update TINYINT(1) NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN created_at DATETIME NULL");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN updated_at DATETIME NULL");
    $tryIndex("CREATE INDEX idx_staff_app_event ON galonly_staff_applications(event_id)");
    $tryIndex("CREATE INDEX idx_staff_app_user ON galonly_staff_applications(user_id)");
    $tryIndex("CREATE INDEX idx_staff_app_status ON galonly_staff_applications(status)");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN active_key VARCHAR(64) GENERATED ALWAYS AS (CASE WHEN status IN ('pending','pooled') THEN CONCAT(event_id, ':', user_id) ELSE NULL END) STORED");
    $tryIndex("CREATE UNIQUE INDEX idx_staff_app_active ON galonly_staff_applications(active_key)");
    echo "[OK] galonly_staff_applications 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS announcements (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            title         VARCHAR(255) NOT NULL,
            content       TEXT NOT NULL,
            type          VARCHAR(50) NOT NULL DEFAULT 'info',
            status        VARCHAR(50) NOT NULL DEFAULT 'draft',
            is_persistent TINYINT(1) NOT NULL DEFAULT 1,
            created_by    INT NOT NULL,
            created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            published_at  DATETIME,
            FOREIGN KEY (created_by) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_announce_status ON announcements(status)");
    echo "[OK] announcements 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS star_unions (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            name        VARCHAR(255) NOT NULL,
            description TEXT,
            region      VARCHAR(100) DEFAULT '',
            country     VARCHAR(50) DEFAULT 'china',
            created_by  INT NOT NULL,
            created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_star_unions_country ON star_unions(country)");
    $tryIndex("CREATE INDEX idx_star_unions_created_by ON star_unions(created_by)");
    echo "[OK] star_unions 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS star_union_members (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            union_id     INT NOT NULL,
            club_id      INT NOT NULL,
            club_country VARCHAR(50) DEFAULT 'china',
            added_by     INT,
            added_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(union_id, club_id, club_country),
            FOREIGN KEY (union_id) REFERENCES star_unions(id) ON DELETE CASCADE,
            FOREIGN KEY (added_by) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_star_union_members_union ON star_union_members(union_id)");
    echo "[OK] star_union_members 表已创建\n";

    $tryAlter("ALTER TABLE star_unions ADD COLUMN bound_club_id INT DEFAULT NULL");
    $tryAlter("ALTER TABLE star_unions ADD COLUMN bound_club_country VARCHAR(50) DEFAULT 'china'");
    $tryAlter("ALTER TABLE star_unions ADD COLUMN star_color VARCHAR(20) DEFAULT '#f0c060'");
    echo "[OK] star_unions 新列已添加 (bound_club_id, bound_club_country, star_color)\n";

    $tryAlter("ALTER TABLE users ADD COLUMN is_audit TINYINT(1) NOT NULL DEFAULT 0");
    echo "[OK] users.is_audit 列已添加\n";

    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN booth_name VARCHAR(255) NOT NULL DEFAULT ''");
    echo "[OK] galonly_applications.booth_name 列已添加\n";
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN resubmitted TINYINT(1) NOT NULL DEFAULT 0");
    echo "[OK] galonly_applications.resubmitted 列已添加\n";
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN has_update TINYINT(1) NOT NULL DEFAULT 0");
    echo "[OK] galonly_applications.has_update 列已添加\n";
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN display_image VARCHAR(500) DEFAULT NULL AFTER image_path");
    echo "[OK] galonly_applications.display_image 列已添加\n";

    // ===== GalOnly 摊位两阶段审核 v2 =====
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN booth_type VARCHAR(50) NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN expected_members INT NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN layout_notes TEXT NULL");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN needs_power VARCHAR(10) NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN attachment_paths TEXT NULL");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN phase TINYINT(1) NOT NULL DEFAULT 1");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN rejected_at DATETIME NULL");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN revision_at DATETIME NULL");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN phase1_feedback TEXT NULL");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN phase2_feedback TEXT NULL");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN merchandise_items TEXT NULL");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN merchandise_attachments TEXT NULL");
    echo "[OK] galonly_applications 两阶段审核列已添加\n";

    // ===== GalOnly 北京 2.0：联系方式 QQ+手机号、参展经历 =====
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN qq_number VARCHAR(64) NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN phone_number VARCHAR(32) NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN exhibition_experience TEXT NULL");
    echo "[OK] galonly_applications 北京 2.0 列已添加 (qq_number, phone_number, exhibition_experience)\n";

    $tryAlter("ALTER TABLE galonly_votes ADD COLUMN comment TEXT NULL");
    $tryAlter("ALTER TABLE galonly_votes ADD COLUMN phase TINYINT(1) NOT NULL DEFAULT 1");
    echo "[OK] galonly_votes 意见/阶段列已添加\n";
    // 2026-08 陪审分阶段审核：唯一约束需包含 phase，否则同一陪审无法在两个阶段分别发表意见。
    // 旧库唯一索引名为首列名 application_id（未命名 UNIQUE）；此处 phase 列已确保存在后重建索引。
    $tryAlter("ALTER TABLE galonly_votes DROP INDEX application_id");
    $tryAlter("ALTER TABLE galonly_votes ADD UNIQUE KEY uk_galonly_votes_app_phase (application_id, auditer_id, phase)");
    $db->exec("
        CREATE TABLE IF NOT EXISTS galonly_reviewers (
            id INT AUTO_INCREMENT PRIMARY KEY,
            event_id INT NOT NULL DEFAULT 0,
            user_id INT NOT NULL,
            role VARCHAR(10) NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_galonly_reviewer (event_id, user_id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    echo "[OK] galonly_reviewers 表已创建\n";

    $tryAlter("ALTER TABLE galonly_events ADD COLUMN image_url VARCHAR(500) NOT NULL DEFAULT '' AFTER description");
    echo "[OK] galonly_events.image_url 列已添加\n";

    // ===== Makoquiz 答题游戏战绩 =====
    // rank 是 MySQL 8 保留字，列名用 player_rank；
    // UNIQUE(room_code, vnfest_user_id, ended_at) 让重试/重复提交在数据库层就去重
    $db->exec("
        CREATE TABLE IF NOT EXISTS quiz_results (
            id             INT AUTO_INCREMENT PRIMARY KEY,
            vnfest_user_id INT NOT NULL,
            room_code      VARCHAR(16) NOT NULL,
            quiz_title     VARCHAR(255) NOT NULL DEFAULT '',
            player_name    VARCHAR(64) NOT NULL DEFAULT '',
            score          INT NOT NULL DEFAULT 0,
            player_rank    INT NOT NULL DEFAULT 0,
            players_count  INT NOT NULL DEFAULT 0,
            ended_at       BIGINT NOT NULL,
            created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_quiz_result (room_code, vnfest_user_id, ended_at),
            FOREIGN KEY (vnfest_user_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_quiz_results_user ON quiz_results(vnfest_user_id)");
    echo "[OK] quiz_results 表已创建\n";

    // ===== 同好会试炼（Recognition）核心模型 =====
    // 统一核心对象：RecognitionProgram / ProgramVersion / Event / RuleSet / Credential
    // RuleSet 以版本快照 JSON（content_snapshot）承载，已发布版本不可变。
    // 注意：clubs 主数据在 JSON 文件中按 (id, country) 标识，故相关表均携带 country。
    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_programs (
            id                 INT AUTO_INCREMENT PRIMARY KEY,
            club_id            INT NOT NULL,
            country            VARCHAR(50) NOT NULL DEFAULT 'china',
            type               VARCHAR(30) NOT NULL DEFAULT 'assessment',
            title              VARCHAR(255) NOT NULL,
            intro              TEXT,
            participant_difficulty VARCHAR(20) NOT NULL DEFAULT 'normal',
            visibility         VARCHAR(20) NOT NULL DEFAULT 'public',
            status             VARCHAR(20) NOT NULL DEFAULT 'draft',
            capabilities       TEXT NOT NULL,
            participation_rules TEXT,
            max_attempts       INT NOT NULL DEFAULT 0,
            cooldown_minutes   INT NOT NULL DEFAULT 0,
            open_at            DATETIME NULL,
            close_at           DATETIME NULL,
            max_issuance       INT NOT NULL DEFAULT 0,
            credential_ttl_days INT NOT NULL DEFAULT 0,
            security_level     VARCHAR(20) NOT NULL DEFAULT 'normal',
            created_by         INT NOT NULL,
            created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_recog_prog_club ON recognition_programs(club_id, country, status)");
    $tryIndex("CREATE INDEX idx_recog_prog_status ON recognition_programs(status)");
    echo "[OK] recognition_programs 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_program_versions (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            program_id       INT NOT NULL,
            version_no       VARCHAR(20) NOT NULL,
            status           VARCHAR(20) NOT NULL DEFAULT 'draft',
            content_snapshot TEXT NOT NULL,
            published_by     INT NULL,
            published_at     DATETIME NULL,
            created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_recog_ver (program_id, version_no),
            FOREIGN KEY (program_id) REFERENCES recognition_programs(id),
            FOREIGN KEY (published_by) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_recog_ver_prog ON recognition_program_versions(program_id, status)");
    echo "[OK] recognition_program_versions 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_badges (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            club_id     INT NOT NULL,
            country     VARCHAR(50) NOT NULL DEFAULT 'china',
            name        VARCHAR(255) NOT NULL,
            category    VARCHAR(30) NOT NULL DEFAULT 'participation',
            description TEXT,
            image_url   VARCHAR(500) NOT NULL DEFAULT '',
            version     INT NOT NULL DEFAULT 1,
            created_by  INT NOT NULL,
            created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_recog_badge_club ON recognition_badges(club_id, country)");
    echo "[OK] recognition_badges 表已创建\n";

    // Connector 接入器：只做 identify / verify_source / receive_event / normalize_event，
    // 禁止直接写凭证；secret 仅存哈希，scope 限定可提交的事件类型与项目。
    // 注意：MySQL 要求被引用表先存在，故必须建在 recognition_events 之前。
    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_connectors (
            id             INT AUTO_INCREMENT PRIMARY KEY,
            club_id        INT NOT NULL,
            country        VARCHAR(50) NOT NULL DEFAULT 'china',
            name           VARCHAR(128) NOT NULL,
            type           VARCHAR(40) NOT NULL DEFAULT 'webhook',
            token_prefix   VARCHAR(16) NOT NULL,
            token_hash     VARCHAR(128) NOT NULL,
            hmac_secret    VARCHAR(255) NOT NULL DEFAULT '',
            scope          TEXT NOT NULL,
            status         VARCHAR(20) NOT NULL DEFAULT 'active',
            created_by     INT NOT NULL,
            created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_used_at   DATETIME NULL,
            revoked_at     DATETIME NULL,
            FOREIGN KEY (created_by) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_recog_conn_club ON recognition_connectors(club_id, country)");
    $tryIndex("CREATE INDEX idx_recog_conn_prefix ON recognition_connectors(token_prefix)");
    echo "[OK] recognition_connectors 表已创建\n";

    // 统一事件 Event：event_id / idempotency_key 唯一，重复提交在数据库层去重（对齐架构文档 9.4）
    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_events (
            id                  INT AUTO_INCREMENT PRIMARY KEY,
            event_id            VARCHAR(64) NOT NULL,
            idempotency_key     VARCHAR(128) NOT NULL DEFAULT '',
            schema_version      VARCHAR(10) NOT NULL DEFAULT '1.0',
            type                VARCHAR(128) NOT NULL,
            club_id             INT NULL,
            country             VARCHAR(50) NOT NULL DEFAULT 'china',
            user_id             INT NULL,
            program_id          INT NULL,
            program_version_id  INT NULL,
            badge_id            INT NULL,
            connector_id        INT NULL,
            occurred_at         DATETIME NOT NULL,
            data                TEXT,
            evidence_refs       TEXT,
            source_verified     TINYINT(1) NOT NULL DEFAULT 0,
            status              VARCHAR(20) NOT NULL DEFAULT 'processed',
            error_message       VARCHAR(500) NOT NULL DEFAULT '',
            created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_recog_evt_event (event_id),
            UNIQUE KEY uq_recog_evt_idem (idempotency_key),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (program_version_id) REFERENCES recognition_program_versions(id),
            FOREIGN KEY (connector_id) REFERENCES recognition_connectors(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_recog_evt_user ON recognition_events(user_id)");
    $tryIndex("CREATE INDEX idx_recog_evt_prog ON recognition_events(program_version_id)");
    $tryIndex("CREATE INDEX idx_recog_evt_type ON recognition_events(type)");
    echo "[OK] recognition_events 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_attempts (
            id                 INT AUTO_INCREMENT PRIMARY KEY,
            program_version_id INT NOT NULL,
            user_id            INT NOT NULL,
            status             VARCHAR(20) NOT NULL DEFAULT 'created',
            score              INT NULL,
            answers            TEXT,
            attempt_no         INT NOT NULL DEFAULT 1,
            started_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            finished_at        DATETIME NULL,
            UNIQUE KEY uq_recog_att_sess (program_version_id, user_id, attempt_no),
            FOREIGN KEY (program_version_id) REFERENCES recognition_program_versions(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_recog_att_user ON recognition_attempts(user_id)");
    $tryIndex("CREATE INDEX idx_recog_att_status ON recognition_attempts(program_version_id, status)");
    echo "[OK] recognition_attempts 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_submissions (
            id                 INT AUTO_INCREMENT PRIMARY KEY,
            program_version_id INT NOT NULL,
            user_id            INT NOT NULL,
            content            TEXT,
            file_path          VARCHAR(500) NOT NULL DEFAULT '',
            status             VARCHAR(20) NOT NULL DEFAULT 'pending',
            reviewed_at        DATETIME NULL,
            created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (program_version_id) REFERENCES recognition_program_versions(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_recog_sub_prog_user ON recognition_submissions(program_version_id, user_id)");
    $tryIndex("CREATE INDEX idx_recog_sub_status ON recognition_submissions(status)");
    echo "[OK] recognition_submissions 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_reviews (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            submission_id INT NOT NULL,
            reviewer_id   INT NOT NULL,
            decision      VARCHAR(20) NOT NULL,
            comment       TEXT,
            created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_recog_rev (submission_id, reviewer_id),
            FOREIGN KEY (submission_id) REFERENCES recognition_submissions(id),
            FOREIGN KEY (reviewer_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_recog_rev_sub ON recognition_reviews(submission_id)");
    echo "[OK] recognition_reviews 表已创建\n";

    // 凭证 Credential：签发唯一性——同一版本同一用户同一徽章只保留一份 active；
    // revoked/expired/superseded 历史保留，撤销不物理删除（对齐架构文档 14.4）。
    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_credentials (
            id                   INT AUTO_INCREMENT PRIMARY KEY,
            credential_uid       VARCHAR(64) NOT NULL,
            holder_user_id       INT NOT NULL,
            badge_id             INT NOT NULL,
            badge_version        INT NOT NULL DEFAULT 1,
            issuer_club_id       INT NOT NULL,
            issuer_country       VARCHAR(50) NOT NULL DEFAULT 'china',
            program_id           INT NOT NULL,
            program_version_id   INT NOT NULL,
            credential_type      VARCHAR(30) NOT NULL DEFAULT 'participation',
            verification_level   VARCHAR(30) NOT NULL DEFAULT 'auto',
            status               VARCHAR(20) NOT NULL DEFAULT 'active',
            condition_snapshot   TEXT,
            evidence_refs        TEXT,
            public_visibility    TINYINT(1) NOT NULL DEFAULT 1,
            issued_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at           DATETIME NULL,
            revocation_reason    VARCHAR(255) NULL,
            revoked_at           DATETIME NULL,
            revoked_by           INT NULL,
            superseded_by        INT NULL,
            active_key           VARCHAR(191) GENERATED ALWAYS AS (
                CASE WHEN status = 'active' THEN CONCAT(program_version_id, ':', holder_user_id, ':', badge_id) ELSE NULL END
            ) STORED,
            UNIQUE KEY uq_recog_cred_uid (credential_uid),
            UNIQUE KEY uq_recog_cred_active (active_key),
            FOREIGN KEY (holder_user_id) REFERENCES users(id),
            FOREIGN KEY (badge_id) REFERENCES recognition_badges(id),
            FOREIGN KEY (program_version_id) REFERENCES recognition_program_versions(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_recog_cred_holder ON recognition_credentials(holder_user_id, status)");
    $tryIndex("CREATE INDEX idx_recog_cred_club ON recognition_credentials(issuer_club_id, issuer_country)");
    $tryIndex("CREATE INDEX idx_recog_cred_expires ON recognition_credentials(status, expires_at)");
    echo "[OK] recognition_credentials 表已创建\n";

    // 事务 Outbox：签发成功后的异步动作（通知、过期扫描补偿），由 scripts/recognition_worker.php 消费
    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_outbox (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            task_type    VARCHAR(40) NOT NULL,
            payload      TEXT,
            status       VARCHAR(20) NOT NULL DEFAULT 'pending',
            attempts     INT NOT NULL DEFAULT 0,
            last_error   VARCHAR(500) NOT NULL DEFAULT '',
            created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            processed_at DATETIME NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_recog_outbox_status ON recognition_outbox(status)");
    echo "[OK] recognition_outbox 表已创建\n";

    // 外部身份绑定 IdentityLink：新外部身份一律走此表；users.qq_openid / discord_id 为历史只读字段。
    // 一个外部主体同一时间只能绑定一个 VNFMap 用户（revoked 历史保留）。
    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_identity_links (
            id                  INT AUTO_INCREMENT PRIMARY KEY,
            external_provider   VARCHAR(40) NOT NULL,
            external_subject_id VARCHAR(191) NOT NULL,
            vnfmap_user_id      INT NULL,
            verification_status VARCHAR(20) NOT NULL DEFAULT 'pending',
            linked_at           DATETIME NULL,
            revoked_at          DATETIME NULL,
            created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_recog_idl_active (external_provider, external_subject_id),
            FOREIGN KEY (vnfmap_user_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_recog_idl_user ON recognition_identity_links(vnfmap_user_id)");
    echo "[OK] recognition_identity_links 表已创建\n";

    // 先参与、后领取：现场发放一次性兑换码，事后登录兑换绑定凭证。
    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_claim_codes (
            id                 INT AUTO_INCREMENT PRIMARY KEY,
            code               VARCHAR(32) NOT NULL,
            program_id         INT NOT NULL,
            program_version_id INT NOT NULL,
            badge_id           INT NOT NULL,
            redeemed_by        INT NULL,
            redeemed_at        DATETIME NULL,
            expires_at         DATETIME NULL,
            created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_recog_claim_code (code),
            FOREIGN KEY (program_version_id) REFERENCES recognition_program_versions(id),
            FOREIGN KEY (redeemed_by) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_recog_claim_prog ON recognition_claim_codes(program_version_id)");
    echo "[OK] recognition_claim_codes 表已创建\n";

    // 同好会侧认可角色（文档 16.1 的 8 角色），MVP 阶段由 club_memberships 角色隐式映射，本表承载显式细分。
    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_club_roles (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            club_id    INT NOT NULL,
            country    VARCHAR(50) NOT NULL DEFAULT 'china',
            user_id    INT NOT NULL,
            role       VARCHAR(30) NOT NULL,
            granted_by INT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_recog_role (club_id, country, user_id, role),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (granted_by) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $tryIndex("CREATE INDEX idx_recog_role_user ON recognition_club_roles(user_id)");
    echo "[OK] recognition_club_roles 表已创建\n";

} else {
    // ==================== SQLite 建表 ====================

    $db->exec("
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            qq_openid     TEXT UNIQUE,
            discord_id    TEXT UNIQUE,
            qq_unionid    TEXT,
            password_hash TEXT,
            username      TEXT NOT NULL UNIQUE,
            avatar_url    TEXT DEFAULT '',
            role          TEXT NOT NULL DEFAULT 'visitor'
                          CHECK(role IN ('visitor','member','manager','representative','super_admin')),
            status        TEXT NOT NULL DEFAULT 'active'
                          CHECK(status IN ('active','disabled','banned')),
            language_preference TEXT NULL,
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
            last_login_at TEXT
        )
    ");
    echo "[OK] users 表已创建\n";

    // 迁移：为已有数据库添加新列（如果尚不存在）
    $tryAlter = function (string $sql) use ($db) {
        try { $db->exec($sql); } catch (PDOException $e) { /* 列已存在，忽略 */ }
    };
    $tryAlter("ALTER TABLE users ADD COLUMN password_hash TEXT");
    $tryAlter("ALTER TABLE users ADD COLUMN email TEXT");
    $tryAlter("ALTER TABLE users ADD COLUMN email_verified_at TEXT");
    $tryAlter("ALTER TABLE users ADD COLUMN avatar_updated_at TEXT");
    $tryAlter("ALTER TABLE users ADD COLUMN nickname TEXT DEFAULT ''");
    $tryAlter("ALTER TABLE users ADD COLUMN profile_bio TEXT DEFAULT ''");
    $tryAlter("ALTER TABLE users ADD COLUMN membership_application_email_enabled INTEGER NOT NULL DEFAULT 1");
    $tryAlter("ALTER TABLE users ADD COLUMN display_membership_id INTEGER");
    $tryAlter("ALTER TABLE users ADD COLUMN language_preference TEXT NULL");

    $db->exec("CREATE INDEX IF NOT EXISTS idx_users_qq ON users(qq_openid)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_users_discord ON users(discord_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_users_display_membership ON users(display_membership_id)");
    $db->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)");

    $db->exec("
        CREATE TABLE IF NOT EXISTS sessions (
            id           TEXT PRIMARY KEY,
            user_id      INTEGER NOT NULL REFERENCES users(id),
            ip_address   TEXT,
            user_agent   TEXT,
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at   TEXT NOT NULL,
            is_valid     INTEGER NOT NULL DEFAULT 1
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)");
    echo "[OK] sessions 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS clubs (
            id            INTEGER PRIMARY KEY,
            province      TEXT NOT NULL DEFAULT '',
            prefecture    TEXT DEFAULT '',
            representative_id INTEGER REFERENCES users(id),
            visibility    TEXT DEFAULT 'public' CHECK(visibility IN ('public','members_only')),
            country       TEXT DEFAULT 'china'
        )
    ");
    echo "[OK] clubs 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS audit_logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER REFERENCES users(id),
            action      TEXT NOT NULL,
            target_type TEXT,
            target_id   INTEGER,
            details     TEXT,
            ip_address  TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)");
    echo "[OK] audit_logs 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS rate_limits (
            ip_address  TEXT NOT NULL,
            endpoint    TEXT NOT NULL,
            hit_count   INTEGER DEFAULT 1,
            window_start TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (ip_address, endpoint)
        )
    ");
    echo "[OK] rate_limits 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS notifications (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id       INTEGER NOT NULL REFERENCES users(id),
            type          TEXT NOT NULL,
            title         TEXT NOT NULL,
            message       TEXT NOT NULL,
            link          TEXT DEFAULT '',
            related_type  TEXT DEFAULT '',
            related_id    INTEGER DEFAULT 0,
            is_read       INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            read_at       TEXT
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read, created_at)");
    echo "[OK] notifications 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS announcements (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            title         TEXT NOT NULL,
            content       TEXT NOT NULL,
            type          TEXT NOT NULL DEFAULT 'info'
                          CHECK(type IN ('info','warning','important','update')),
            status        TEXT NOT NULL DEFAULT 'draft'
                          CHECK(status IN ('draft','published')),
            is_persistent INTEGER NOT NULL DEFAULT 1,
            created_by    INTEGER NOT NULL REFERENCES users(id),
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            published_at  TEXT
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_announce_status ON announcements(status)");
    echo "[OK] announcements 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS club_memberships (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id),
            club_id     INTEGER NOT NULL,
            role        TEXT NOT NULL DEFAULT 'member'
                        CHECK(role IN ('external','member','manager','representative')),
            status      TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','pending','rejected','left','kicked')),
            qq_account  TEXT DEFAULT '',
            contact_account TEXT DEFAULT '',
            apply_role  TEXT DEFAULT 'member',
            is_student  INTEGER DEFAULT 0,
            country     TEXT DEFAULT 'china',
            join_method TEXT DEFAULT 'school_no_code',
            external_club_name TEXT DEFAULT '',
            external_club_role TEXT DEFAULT '',
            apply_reason TEXT,
            application_email_enabled INTEGER NOT NULL DEFAULT 1,
            joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
            left_at     TEXT,
            UNIQUE(user_id, club_id, country)
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_memberships_user ON club_memberships(user_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_memberships_club ON club_memberships(club_id)");
    echo "[OK] club_memberships 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS club_verification_codes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            club_id     INTEGER NOT NULL,
            code        TEXT NOT NULL,
            created_by  INTEGER NOT NULL REFERENCES users(id),
            max_uses    INTEGER DEFAULT 50,
            use_count   INTEGER DEFAULT 0,
            expires_at  TEXT,
            is_active   INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_verify_codes_club ON club_verification_codes(club_id)");
    echo "[OK] club_verification_codes 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS club_bot_tokens (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            club_id      INTEGER NOT NULL,
            country      TEXT DEFAULT 'china',
            name         TEXT DEFAULT '',
            token_prefix TEXT NOT NULL,
            token_hash   TEXT NOT NULL,
            permissions  TEXT DEFAULT '[]',
            created_by   INTEGER NOT NULL REFERENCES users(id),
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            last_used_at TEXT,
            revoked_at   TEXT
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_club_bot_tokens_club ON club_bot_tokens(club_id, country)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_club_bot_tokens_prefix ON club_bot_tokens(token_prefix)");
    echo "[OK] club_bot_tokens 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS club_recommendations (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            club_id     INTEGER NOT NULL,
            country     TEXT DEFAULT 'china',
            bangumi_id  INTEGER NOT NULL,
            title       TEXT NOT NULL,
            image_url   TEXT DEFAULT '',
            rating      REAL DEFAULT 0,
            summary     TEXT DEFAULT '',
            sort_order  INTEGER DEFAULT 0,
            created_by  INTEGER NOT NULL REFERENCES users(id),
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recommendations_club ON club_recommendations(club_id, sort_order)");
    echo "[OK] club_recommendations 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS club_moe_kings (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            club_id       INTEGER NOT NULL,
            country       TEXT DEFAULT 'china',
            character_id  INTEGER NOT NULL,
            name          TEXT NOT NULL,
            name_cn       TEXT DEFAULT '',
            image_url     TEXT DEFAULT '',
            summary       TEXT DEFAULT '',
            updated_by    INTEGER NOT NULL REFERENCES users(id),
            updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(club_id, country)
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_moe_kings_club ON club_moe_kings(club_id, country)");
    echo "[OK] club_moe_kings 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS club_comments (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            club_id     INTEGER NOT NULL,
            country     TEXT DEFAULT 'china',
            user_id     INTEGER NOT NULL REFERENCES users(id),
            content     TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT,
            is_deleted  INTEGER DEFAULT 0
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_comments_club ON club_comments(club_id, created_at)");
    echo "[OK] club_comments 表已创建\n";

    $tryAlter("ALTER TABLE club_verification_codes ADD COLUMN country TEXT DEFAULT 'china'");
    echo "[OK] club_verification_codes.country 列已添加\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS email_verifications (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id),
            email       TEXT NOT NULL,
            code        TEXT NOT NULL,
            expires_at  TEXT NOT NULL,
            used        INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_email_verify_user ON email_verifications(user_id)");
    echo "[OK] email_verifications 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS galonly_events (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            name              TEXT NOT NULL,
            location          TEXT NOT NULL DEFAULT '',
            date              TEXT NOT NULL,
            registration_open INTEGER NOT NULL DEFAULT 1,
            staff_only        INTEGER NOT NULL DEFAULT 0,
            event_code        TEXT NOT NULL DEFAULT '',
            description       TEXT,
            created_at        TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    echo "[OK] galonly_events 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS galonly_applications (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id      INTEGER NOT NULL REFERENCES galonly_events(id),
            user_id       INTEGER NOT NULL REFERENCES users(id),
            is_joint      INTEGER NOT NULL DEFAULT 0,
            joint_name    TEXT NOT NULL DEFAULT '',
            wants_upgrade INTEGER NOT NULL DEFAULT 0,
            contact       TEXT NOT NULL DEFAULT '',
            notes         TEXT,
            image_path    TEXT NOT NULL DEFAULT '',
            status        TEXT NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending','approved','rejected')),
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_galonly_app_event ON galonly_applications(event_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_galonly_app_user ON galonly_applications(user_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_galonly_app_status ON galonly_applications(status)");
    echo "[OK] galonly_applications 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS galonly_application_clubs (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            application_id  INTEGER NOT NULL REFERENCES galonly_applications(id),
            club_id         INTEGER NOT NULL,
            club_country    TEXT NOT NULL DEFAULT '',
            UNIQUE(application_id, club_id)
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_galonly_app_clubs_app ON galonly_application_clubs(application_id)");
    echo "[OK] galonly_application_clubs 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS galonly_votes (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            application_id  INTEGER NOT NULL REFERENCES galonly_applications(id),
            auditer_id      INTEGER NOT NULL REFERENCES users(id),
            vote            TEXT NOT NULL CHECK(vote IN ('approve','reject')),
            comment         TEXT NULL,
            phase           INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(application_id, auditer_id, phase)
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_galonly_votes_app ON galonly_votes(application_id)");
    echo "[OK] galonly_votes 表已创建\n";
    // 2026-08 陪审分阶段审核：旧 SQLite 库唯一约束不含 phase，需重建表升级
    try {
        $oldUnique = $db->query("SELECT sql FROM sqlite_master WHERE type='table' AND name='galonly_votes'")->fetchColumn();
        if (is_string($oldUnique) && strpos($oldUnique, 'UNIQUE(application_id, auditer_id)') !== false
            && strpos($oldUnique, 'phase') === false) {
            $db->exec("ALTER TABLE galonly_votes RENAME TO galonly_votes_old");
            $db->exec("CREATE TABLE galonly_votes (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                application_id  INTEGER NOT NULL REFERENCES galonly_applications(id),
                auditer_id      INTEGER NOT NULL REFERENCES users(id),
                vote            TEXT NOT NULL CHECK(vote IN ('approve','reject')),
                comment         TEXT NULL,
                phase           INTEGER NOT NULL DEFAULT 1,
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(application_id, auditer_id, phase)
            )");
            $db->exec("INSERT INTO galonly_votes (id, application_id, auditer_id, vote, created_at) SELECT id, application_id, auditer_id, vote, created_at FROM galonly_votes_old");
            $db->exec("DROP TABLE galonly_votes_old");
            $db->exec("CREATE INDEX IF NOT EXISTS idx_galonly_votes_app ON galonly_votes(application_id)");
            echo "[OK] galonly_votes 唯一约束已升级为 (application_id, auditer_id, phase)\n";
        }
    } catch (Exception $e) {
        // best-effort：旧库升级失败不阻断后续建表
    }

    $db->exec("
        CREATE TABLE IF NOT EXISTS galonly_public_votes (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id        INTEGER NOT NULL,
            application_id  INTEGER NOT NULL,
            ip_address      TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(event_id, ip_address, application_id)
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_galonly_public_votes_event ON galonly_public_votes(event_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_galonly_public_votes_app ON galonly_public_votes(application_id)");
    echo "[OK] galonly_public_votes 表已创建\n";

    $tryAlter("ALTER TABLE galonly_events ADD COLUMN staff_deadline TEXT DEFAULT NULL");
    $tryAlter("ALTER TABLE galonly_events ADD COLUMN staff_max_applicants INTEGER DEFAULT NULL");
    $tryAlter("ALTER TABLE galonly_events ADD COLUMN staff_required_count INTEGER NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_events ADD COLUMN staff_registration_open INTEGER NOT NULL DEFAULT 1");
    $tryAlter("ALTER TABLE galonly_events ADD COLUMN staff_roster_finalized INTEGER NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_events ADD COLUMN staff_only INTEGER NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_events ADD COLUMN event_code TEXT NOT NULL DEFAULT ''");
    echo "[OK] galonly_events Staff 配置列已添加\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS galonly_staff_applications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL REFERENCES galonly_events(id),
            user_id INTEGER NOT NULL REFERENCES users(id),
            cn_name TEXT NOT NULL DEFAULT '',
                qq_number TEXT NOT NULL DEFAULT '',
                phone_number TEXT NOT NULL DEFAULT '',
                email TEXT NOT NULL DEFAULT '',
                club_id INTEGER NOT NULL DEFAULT 0,
            club_country TEXT NOT NULL DEFAULT 'china',
            positions TEXT NOT NULL DEFAULT '[]',
            confirm_schedule INTEGER NOT NULL DEFAULT 0,
            is_cosplay INTEGER NOT NULL DEFAULT 0,
            three_day_available INTEGER NOT NULL DEFAULT 0,
            self_intro TEXT,
            gender TEXT NOT NULL DEFAULT '',
            staff_experience INTEGER NOT NULL DEFAULT 0,
            skills TEXT,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending','pooled','rejected','confirmed')),
            voted_by INTEGER DEFAULT NULL,
            vote TEXT DEFAULT NULL,
            resubmitted INTEGER NOT NULL DEFAULT 0,
            has_update INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN event_id INTEGER NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN cn_name TEXT NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN qq_number TEXT NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN phone_number TEXT NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN email TEXT NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN club_id INTEGER NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN club_country TEXT NOT NULL DEFAULT 'china'");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN positions TEXT NOT NULL DEFAULT '[]'");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN confirm_schedule INTEGER NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN is_cosplay INTEGER NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN three_day_available INTEGER NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN self_intro TEXT");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN gender TEXT NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN staff_experience INTEGER NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN skills TEXT");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN voted_by INTEGER DEFAULT NULL");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN vote TEXT DEFAULT NULL");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN resubmitted INTEGER NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN has_update INTEGER NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN created_at TEXT");
    $tryAlter("ALTER TABLE galonly_staff_applications ADD COLUMN updated_at TEXT");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_staff_app_event ON galonly_staff_applications(event_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_staff_app_user ON galonly_staff_applications(user_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_staff_app_status ON galonly_staff_applications(status)");
    $db->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_app_active ON galonly_staff_applications(event_id, user_id) WHERE status IN ('pending','pooled')");
    echo "[OK] galonly_staff_applications 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS star_unions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            description TEXT DEFAULT '',
            region      TEXT DEFAULT '',
            country     TEXT DEFAULT 'china',
            created_by  INTEGER NOT NULL REFERENCES users(id),
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            bound_club_id INTEGER DEFAULT NULL,
            bound_club_country TEXT DEFAULT 'china',
            star_color  TEXT DEFAULT '#f0c060'
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_star_unions_country ON star_unions(country)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_star_unions_created_by ON star_unions(created_by)");
    echo "[OK] star_unions 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS star_union_members (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            union_id     INTEGER NOT NULL REFERENCES star_unions(id) ON DELETE CASCADE,
            club_id      INTEGER NOT NULL,
            club_country TEXT DEFAULT 'china',
            added_by     INTEGER REFERENCES users(id),
            added_at     TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(union_id, club_id, club_country)
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_star_union_members_union ON star_union_members(union_id)");
    echo "[OK] star_union_members 表已创建\n";

    $tryAlter("ALTER TABLE star_unions ADD COLUMN bound_club_id INTEGER DEFAULT NULL");
    $tryAlter("ALTER TABLE star_unions ADD COLUMN bound_club_country TEXT DEFAULT 'china'");
    $tryAlter("ALTER TABLE star_unions ADD COLUMN star_color TEXT DEFAULT '#f0c060'");
    echo "[OK] star_unions 新列已添加 (bound_club_id, bound_club_country, star_color)\n";

    $tryAlter("ALTER TABLE users ADD COLUMN is_audit INTEGER NOT NULL DEFAULT 0");
    echo "[OK] users.is_audit 列已添加\n";

    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN booth_name TEXT NOT NULL DEFAULT ''");
    echo "[OK] galonly_applications.booth_name 列已添加\n";
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN resubmitted INTEGER NOT NULL DEFAULT 0");
    echo "[OK] galonly_applications.resubmitted 列已添加\n";
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN has_update INTEGER NOT NULL DEFAULT 0");
    echo "[OK] galonly_applications.has_update 列已添加\n";
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN display_image TEXT DEFAULT NULL");
    echo "[OK] galonly_applications.display_image 列已添加\n";

    // ===== GalOnly 摊位两阶段审核 v2 =====
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN booth_type TEXT NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN expected_members INTEGER NOT NULL DEFAULT 0");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN layout_notes TEXT NULL");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN needs_power TEXT NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN attachment_paths TEXT NULL");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN phase INTEGER NOT NULL DEFAULT 1");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN rejected_at TEXT NULL");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN revision_at TEXT NULL");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN phase1_feedback TEXT NULL");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN phase2_feedback TEXT NULL");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN merchandise_items TEXT NULL");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN merchandise_attachments TEXT NULL");
    echo "[OK] galonly_applications 两阶段审核列已添加\n";

    // ===== GalOnly 北京 2.0：联系方式 QQ+手机号、参展经历 =====
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN qq_number TEXT NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN phone_number TEXT NOT NULL DEFAULT ''");
    $tryAlter("ALTER TABLE galonly_applications ADD COLUMN exhibition_experience TEXT NULL");
    echo "[OK] galonly_applications 北京 2.0 列已添加 (qq_number, phone_number, exhibition_experience)\n";

    $tryAlter("ALTER TABLE galonly_votes ADD COLUMN comment TEXT NULL");
    $tryAlter("ALTER TABLE galonly_votes ADD COLUMN phase INTEGER NOT NULL DEFAULT 1");
    echo "[OK] galonly_votes 意见/阶段列已添加\n";
    $db->exec("
        CREATE TABLE IF NOT EXISTS galonly_reviewers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL DEFAULT 0,
            user_id INTEGER NOT NULL REFERENCES users(id),
            role TEXT NOT NULL CHECK(role IN ('chief','jury')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(event_id, user_id)
        )
    ");
    echo "[OK] galonly_reviewers 表已创建\n";

    $tryAlter("ALTER TABLE galonly_events ADD COLUMN image_url TEXT NOT NULL DEFAULT ''");
    echo "[OK] galonly_events.image_url 列已添加\n";

    // ===== Makoquiz 答题游戏战绩 =====
    $db->exec("
        CREATE TABLE IF NOT EXISTS quiz_results (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            vnfest_user_id INTEGER NOT NULL REFERENCES users(id),
            room_code      TEXT NOT NULL,
            quiz_title     TEXT NOT NULL DEFAULT '',
            player_name    TEXT NOT NULL DEFAULT '',
            score          INTEGER NOT NULL DEFAULT 0,
            player_rank    INTEGER NOT NULL DEFAULT 0,
            players_count  INTEGER NOT NULL DEFAULT 0,
            ended_at       INTEGER NOT NULL,
            created_at     TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(room_code, vnfest_user_id, ended_at)
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_quiz_results_user ON quiz_results(vnfest_user_id)");
    echo "[OK] quiz_results 表已创建\n";

    // ===== 同好会试炼（Recognition）核心模型（SQLite 方言，与 MySQL 分支保持一致）=====
    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_programs (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            club_id            INTEGER NOT NULL,
            country            TEXT NOT NULL DEFAULT 'china',
            type               TEXT NOT NULL DEFAULT 'assessment',
            title              TEXT NOT NULL,
            intro              TEXT,
            participant_difficulty TEXT NOT NULL DEFAULT 'normal',
            visibility         TEXT NOT NULL DEFAULT 'public',
            status             TEXT NOT NULL DEFAULT 'draft',
            capabilities       TEXT NOT NULL,
            participation_rules TEXT,
            max_attempts       INTEGER NOT NULL DEFAULT 0,
            cooldown_minutes   INTEGER NOT NULL DEFAULT 0,
            open_at            TEXT,
            close_at           TEXT,
            max_issuance       INTEGER NOT NULL DEFAULT 0,
            credential_ttl_days INTEGER NOT NULL DEFAULT 0,
            security_level     TEXT NOT NULL DEFAULT 'normal',
            created_by         INTEGER NOT NULL REFERENCES users(id),
            created_at         TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_prog_club ON recognition_programs(club_id, country, status)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_prog_status ON recognition_programs(status)");
    echo "[OK] recognition_programs 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_program_versions (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            program_id       INTEGER NOT NULL REFERENCES recognition_programs(id),
            version_no       TEXT NOT NULL,
            status           TEXT NOT NULL DEFAULT 'draft',
            content_snapshot TEXT NOT NULL,
            published_by     INTEGER REFERENCES users(id),
            published_at     TEXT,
            created_at       TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(program_id, version_no)
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_ver_prog ON recognition_program_versions(program_id, status)");
    echo "[OK] recognition_program_versions 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_badges (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            club_id     INTEGER NOT NULL,
            country     TEXT NOT NULL DEFAULT 'china',
            name        TEXT NOT NULL,
            category    TEXT NOT NULL DEFAULT 'participation',
            description TEXT,
            image_url   TEXT NOT NULL DEFAULT '',
            version     INTEGER NOT NULL DEFAULT 1,
            created_by  INTEGER NOT NULL REFERENCES users(id),
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_badge_club ON recognition_badges(club_id, country)");
    echo "[OK] recognition_badges 表已创建\n";

    // 与 MySQL 分支保持一致的顺序：connectors 建在 events 之前。
    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_connectors (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            club_id        INTEGER NOT NULL,
            country        TEXT NOT NULL DEFAULT 'china',
            name           TEXT NOT NULL,
            type           TEXT NOT NULL DEFAULT 'webhook',
            token_prefix   TEXT NOT NULL,
            token_hash     TEXT NOT NULL,
            hmac_secret    TEXT NOT NULL DEFAULT '',
            scope          TEXT NOT NULL,
            status         TEXT NOT NULL DEFAULT 'active',
            created_by     INTEGER NOT NULL REFERENCES users(id),
            created_at     TEXT NOT NULL DEFAULT (datetime('now')),
            last_used_at   TEXT,
            revoked_at     TEXT
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_conn_club ON recognition_connectors(club_id, country)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_conn_prefix ON recognition_connectors(token_prefix)");
    echo "[OK] recognition_connectors 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_events (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id            TEXT NOT NULL UNIQUE,
            idempotency_key     TEXT NOT NULL DEFAULT '' UNIQUE,
            schema_version      TEXT NOT NULL DEFAULT '1.0',
            type                TEXT NOT NULL,
            club_id             INTEGER,
            country             TEXT NOT NULL DEFAULT 'china',
            user_id             INTEGER REFERENCES users(id),
            program_id          INTEGER,
            program_version_id  INTEGER REFERENCES recognition_program_versions(id),
            badge_id            INTEGER,
            connector_id        INTEGER REFERENCES recognition_connectors(id),
            occurred_at         TEXT NOT NULL,
            data                TEXT,
            evidence_refs       TEXT,
            source_verified     INTEGER NOT NULL DEFAULT 0,
            status              TEXT NOT NULL DEFAULT 'processed',
            error_message       TEXT NOT NULL DEFAULT '',
            created_at          TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_evt_user ON recognition_events(user_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_evt_prog ON recognition_events(program_version_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_evt_type ON recognition_events(type)");
    echo "[OK] recognition_events 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_attempts (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            program_version_id INTEGER NOT NULL REFERENCES recognition_program_versions(id),
            user_id            INTEGER NOT NULL REFERENCES users(id),
            status             TEXT NOT NULL DEFAULT 'created',
            score              INTEGER,
            answers            TEXT,
            attempt_no         INTEGER NOT NULL DEFAULT 1,
            started_at         TEXT NOT NULL DEFAULT (datetime('now')),
            finished_at        TEXT,
            UNIQUE(program_version_id, user_id, attempt_no)
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_att_user ON recognition_attempts(user_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_att_status ON recognition_attempts(program_version_id, status)");
    echo "[OK] recognition_attempts 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_submissions (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            program_version_id INTEGER NOT NULL REFERENCES recognition_program_versions(id),
            user_id            INTEGER NOT NULL REFERENCES users(id),
            content            TEXT,
            file_path          TEXT NOT NULL DEFAULT '',
            status             TEXT NOT NULL DEFAULT 'pending',
            reviewed_at        TEXT,
            created_at         TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_sub_prog_user ON recognition_submissions(program_version_id, user_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_sub_status ON recognition_submissions(status)");
    echo "[OK] recognition_submissions 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_reviews (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            submission_id INTEGER NOT NULL REFERENCES recognition_submissions(id),
            reviewer_id   INTEGER NOT NULL REFERENCES users(id),
            decision      TEXT NOT NULL,
            comment       TEXT,
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(submission_id, reviewer_id)
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_rev_sub ON recognition_reviews(submission_id)");
    echo "[OK] recognition_reviews 表已创建\n";

    // 签发唯一性：SQLite 用部分唯一索引（仅 active）替代 MySQL 生成列方案，语义一致。
    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_credentials (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            credential_uid       TEXT NOT NULL UNIQUE,
            holder_user_id       INTEGER NOT NULL REFERENCES users(id),
            badge_id             INTEGER NOT NULL REFERENCES recognition_badges(id),
            badge_version        INTEGER NOT NULL DEFAULT 1,
            issuer_club_id       INTEGER NOT NULL,
            issuer_country       TEXT NOT NULL DEFAULT 'china',
            program_id           INTEGER NOT NULL,
            program_version_id   INTEGER NOT NULL REFERENCES recognition_program_versions(id),
            credential_type      TEXT NOT NULL DEFAULT 'participation',
            verification_level   TEXT NOT NULL DEFAULT 'auto',
            status               TEXT NOT NULL DEFAULT 'active',
            condition_snapshot   TEXT,
            evidence_refs        TEXT,
            public_visibility    INTEGER NOT NULL DEFAULT 1,
            issued_at            TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at           TEXT,
            revocation_reason    TEXT,
            revoked_at           TEXT,
            revoked_by           INTEGER,
            superseded_by        INTEGER
        )
    ");
    $db->exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_recog_cred_active ON recognition_credentials(program_version_id, holder_user_id, badge_id) WHERE status = 'active'");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_cred_holder ON recognition_credentials(holder_user_id, status)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_cred_club ON recognition_credentials(issuer_club_id, issuer_country)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_cred_expires ON recognition_credentials(status, expires_at)");
    echo "[OK] recognition_credentials 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_outbox (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            task_type    TEXT NOT NULL,
            payload      TEXT,
            status       TEXT NOT NULL DEFAULT 'pending',
            attempts     INTEGER NOT NULL DEFAULT 0,
            last_error   TEXT NOT NULL DEFAULT '',
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            processed_at TEXT
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_outbox_status ON recognition_outbox(status)");
    echo "[OK] recognition_outbox 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_identity_links (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            external_provider   TEXT NOT NULL,
            external_subject_id TEXT NOT NULL,
            vnfmap_user_id      INTEGER REFERENCES users(id),
            verification_status TEXT NOT NULL DEFAULT 'pending',
            linked_at           TEXT,
            revoked_at          TEXT,
            created_at          TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    $db->exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_recog_idl_active ON recognition_identity_links(external_provider, external_subject_id) WHERE revoked_at IS NULL");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_idl_user ON recognition_identity_links(vnfmap_user_id)");
    echo "[OK] recognition_identity_links 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_claim_codes (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            code               TEXT NOT NULL UNIQUE,
            program_id         INTEGER NOT NULL,
            program_version_id INTEGER NOT NULL REFERENCES recognition_program_versions(id),
            badge_id           INTEGER NOT NULL,
            redeemed_by        INTEGER REFERENCES users(id),
            redeemed_at        TEXT,
            expires_at         TEXT,
            created_at         TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_claim_prog ON recognition_claim_codes(program_version_id)");
    echo "[OK] recognition_claim_codes 表已创建\n";

    $db->exec("
        CREATE TABLE IF NOT EXISTS recognition_club_roles (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            club_id    INTEGER NOT NULL,
            country    TEXT NOT NULL DEFAULT 'china',
            user_id    INTEGER NOT NULL REFERENCES users(id),
            role       TEXT NOT NULL,
            granted_by INTEGER REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(club_id, country, user_id, role)
        )
    ");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_recog_role_user ON recognition_club_roles(user_id)");
    echo "[OK] recognition_club_roles 表已创建\n";
}

moeEnsureSchema($db);
echo "[OK] moe contest tables ready\n";

twelveEnsureSchema($db);
echo "[OK] twelve contest tables ready\n";

forumEnsureSchema($db);
echo "[OK] forum tables and search indexes ready\n";

// ===== 北京视觉小说Only 第二届（摊位与 Staff 并行项目种子）=====
$stmt = $db->prepare("SELECT id, location, staff_deadline, date, event_code, staff_only FROM galonly_events WHERE name = ?");
$stmt->execute(['北京视觉小说Only 第二届']);
$beijingEvent = $stmt->fetch();
$beijingLocation = '北京市朝阳区 北投购物公园（北京市朝阳区安定路5号院20号楼）';
$beijingStaffDeadline = '2026-10-01 23:59:59';
$beijingEventDate = '2026-10-05';
if (!$beijingEvent) {
    $db->prepare("INSERT INTO galonly_events
        (name, location, date, registration_open, description, staff_registration_open, staff_only, event_code, staff_deadline)
        VALUES (?, ?, ?, 0, ?, 1, 0, 'beijing', ?)")
        ->execute([
            '北京视觉小说Only 第二届',
            $beijingLocation,
            $beijingEventDate,
            '北京视觉小说Only第二届正在筹备中~！这是一场由我们视觉小说同好自发筹办的非营利交流活动，希望为北京及周边地区的同好提供一个轻松、友好的线下交流空间。如果你也希望参与一场属于同好的活动，并愿意和我们一起完善它，欢迎加入Staff团队~！',
            $beijingStaffDeadline,
        ]);
    echo "[OK] 北京视觉小说Only 第二届 活动种子已添加\n";
} else {
    $updates = [];
    $params = [];
    $oldLocation = trim((string)($beijingEvent['location'] ?? ''));
    if ($oldLocation === '' || $oldLocation === '北京市（场地待定）') {
        $updates[] = 'location = ?';
        $params[] = $beijingLocation;
    }
    if (empty($beijingEvent['staff_deadline'])) {
        $updates[] = 'staff_deadline = ?';
        $params[] = $beijingStaffDeadline;
    }
    if ((string)($beijingEvent['date'] ?? '') === '2026-09-19') {
        $updates[] = 'date = ?';
        $params[] = $beijingEventDate;
    }
    if (strtolower(trim((string)($beijingEvent['event_code'] ?? ''))) !== 'beijing') {
        $updates[] = 'event_code = ?';
        $params[] = 'beijing';
    }
    if ((int)($beijingEvent['staff_only'] ?? 0) !== 0) {
        $updates[] = 'staff_only = 0';
    }
    if ($updates) {
        $params[] = (int)$beijingEvent['id'];
        $db->prepare("UPDATE galonly_events SET " . implode(', ', $updates) . " WHERE id = ?")->execute($params);
        echo "[OK] 北京视觉小说Only 第二届 活动场地/截止时间已更新\n";
    } else {
        echo "[OK] 北京视觉小说Only 第二届 活动已存在，跳过种子\n";
    }
}

echo "\n所有数据库表创建完成！\n";
