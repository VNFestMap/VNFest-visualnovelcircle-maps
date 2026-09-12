<?php
declare(strict_types=1);

function postsTableExists(PDO $db, string $table): bool
{
    $driver = (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($driver === 'mysql') {
        $stmt = $db->prepare('SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?');
        $stmt->execute([$table]);
        return (int)$stmt->fetchColumn() > 0;
    }
    $stmt = $db->prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?");
    $stmt->execute([$table]);
    return (int)$stmt->fetchColumn() > 0;
}

function postsTableCount(PDO $db, string $table): int
{
    if (!postsTableExists($db, $table)) return 0;
    $quoted = (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql'
        ? '`' . str_replace('`', '``', $table) . '`'
        : '"' . str_replace('"', '""', $table) . '"';
    return (int)$db->query('SELECT COUNT(*) FROM ' . $quoted)->fetchColumn();
}

function postsEnsureSchema(PDO $db): void
{
    static $ensured = [];
    $driver = (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME);
    $key = $driver . ':' . spl_object_id($db);
    if (!empty($ensured[$key])) return;
    if ($driver === 'mysql') {
        postsCreateMysqlSchema($db);
    } elseif ($driver === 'sqlite') {
        postsCreateSqliteSchema($db);
    } else {
        throw new RuntimeException('Unsupported posts database driver: ' . $driver);
    }
    postsEnsureUserBannerColumn($db);
    postsEnsureDmImagesColumn($db);
    $ensured[$key] = true;
}

function postsEnsureDmImagesColumn(PDO $db): void
{
    // 私信图片（增量列；dm_messages 建表早于该功能的线上库需要补齐）
    $driver = (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($driver === 'mysql') {
        $exists = $db->query(
            "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'dm_messages' AND column_name = 'images_json'"
        )->fetchColumn();
        if (!(int)$exists) {
            $db->exec('ALTER TABLE dm_messages ADD COLUMN images_json TEXT NOT NULL');
        }
        return;
    }
    $columns = $db->query('PRAGMA table_info(dm_messages)')->fetchAll(PDO::FETCH_ASSOC);
    foreach ($columns as $column) {
        if (($column['name'] ?? '') === 'images_json') return;
    }
    $db->exec("ALTER TABLE dm_messages ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]'");
}

function postsEnsureUserBannerColumn(PDO $db): void
{
    // 个人空间装饰横幅（users 表的增量列，动态系统启用时补齐）
    $driver = (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($driver === 'mysql') {
        $exists = $db->query(
            "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'banner_url'"
        )->fetchColumn();
        if (!(int)$exists) {
            $db->exec("ALTER TABLE users ADD COLUMN banner_url VARCHAR(500) NOT NULL DEFAULT ''");
        }
        return;
    }
    $columns = $db->query("PRAGMA table_info(users)")->fetchAll(PDO::FETCH_ASSOC);
    foreach ($columns as $column) {
        if (($column['name'] ?? '') === 'banner_url') return;
    }
    $db->exec("ALTER TABLE users ADD COLUMN banner_url TEXT NOT NULL DEFAULT ''");
}

function postsBackupForMigration(?string $backupDirectory = null): ?string
{
    $driver = (string)getDB()->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($driver !== 'sqlite' || !defined('DB_PATH') || !is_file(DB_PATH)) return null;
    $backupDirectory = $backupDirectory ?: dirname(DB_PATH) . DIRECTORY_SEPARATOR . 'posts-migration-backups';
    if (!is_dir($backupDirectory) && !mkdir($backupDirectory, 0755, true) && !is_dir($backupDirectory)) {
        throw new RuntimeException('无法创建动态迁移备份目录');
    }
    $target = rtrim($backupDirectory, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'posts-before-' . date('Ymd-His') . '-' . bin2hex(random_bytes(3)) . '.db';
    if (!copy(DB_PATH, $target)) throw new RuntimeException('无法备份 SQLite 数据库');
    return $target;
}

function postsMigrateSchema(PDO $db, ?string $backupDirectory = null): void
{
    postsEnsureSchema($db);

    // 旧专栏（杂志式长文）已下线：备份后清理遗留表，避免与新动态模型混淆。
    $legacyTables = ['column_documents', 'column_attachments', 'column_document_revisions'];
    $hasLegacy = false;
    foreach ($legacyTables as $table) {
        if (postsTableExists($db, $table)) {
            $hasLegacy = true;
            break;
        }
    }
    if (!$hasLegacy) return;

    postsBackupForMigration($backupDirectory);
    $driver = (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($driver === 'sqlite') $db->exec('PRAGMA foreign_keys = OFF');
    if ($driver === 'mysql') $db->exec('SET FOREIGN_KEY_CHECKS = 0');
    try {
        foreach (array_reverse($legacyTables) as $table) {
            if (postsTableExists($db, $table)) $db->exec('DROP TABLE IF EXISTS `' . $table . '`');
        }
    } finally {
        if ($driver === 'mysql') $db->exec('SET FOREIGN_KEY_CHECKS = 1');
        if ($driver === 'sqlite') $db->exec('PRAGMA foreign_keys = ON');
    }
}

function postsCreateMysqlSchema(PDO $db): void
{
    $tables = [
        "CREATE TABLE IF NOT EXISTS posts (
            id INT AUTO_INCREMENT PRIMARY KEY,
            author_id INT NOT NULL,
            club_id INT NULL,
            club_country VARCHAR(20) NULL,
            content TEXT NOT NULL,
            images_json TEXT NOT NULL,
            reply_to_id INT NULL,
            quoted_post_id INT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'published',
            like_count INT UNSIGNED NOT NULL DEFAULT 0,
            reply_count INT UNSIGNED NOT NULL DEFAULT 0,
            repost_count INT UNSIGNED NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            deleted_at DATETIME NULL,
            INDEX idx_posts_listing (status, id),
            INDEX idx_posts_author (author_id, status, id),
            INDEX idx_posts_reply (reply_to_id, status, id),
            INDEX idx_posts_quoted (quoted_post_id),
            CONSTRAINT fk_posts_author FOREIGN KEY (author_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS post_likes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            post_id INT NOT NULL,
            user_id INT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_post_like (post_id, user_id),
            CONSTRAINT fk_post_like_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
            CONSTRAINT fk_post_like_user FOREIGN KEY (user_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS post_attachments (
            id INT AUTO_INCREMENT PRIMARY KEY,
            uploader_id INT NOT NULL,
            post_id INT NULL,
            upload_token VARCHAR(64) NOT NULL,
            relative_path VARCHAR(500) NOT NULL,
            mime_type VARCHAR(80) NOT NULL,
            width INT NOT NULL DEFAULT 0,
            height INT NOT NULL DEFAULT 0,
            file_size INT UNSIGNED NOT NULL DEFAULT 0,
            original_name VARCHAR(255) NOT NULL DEFAULT '',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_post_attachment_upload (uploader_id, upload_token, post_id),
            INDEX idx_post_attachment_post (post_id),
            CONSTRAINT fk_post_attachment_uploader FOREIGN KEY (uploader_id) REFERENCES users(id),
            CONSTRAINT fk_post_attachment_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS user_follows (
            id INT AUTO_INCREMENT PRIMARY KEY,
            follower_id INT NOT NULL,
            following_id INT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_user_follow (follower_id, following_id),
            INDEX idx_user_follow_following (following_id),
            CONSTRAINT fk_user_follow_follower FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
            CONSTRAINT fk_user_follow_following FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS dm_conversations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_a_id INT NOT NULL,
            user_b_id INT NOT NULL,
            last_message_id INT NULL,
            last_message_at DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_dm_conversation_pair (user_a_id, user_b_id),
            INDEX idx_dm_conversation_a (user_a_id, last_message_at),
            INDEX idx_dm_conversation_b (user_b_id, last_message_at),
            CONSTRAINT fk_dm_conv_a FOREIGN KEY (user_a_id) REFERENCES users(id) ON DELETE CASCADE,
            CONSTRAINT fk_dm_conv_b FOREIGN KEY (user_b_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS dm_messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT NOT NULL,
            sender_id INT NOT NULL,
            content TEXT NOT NULL,
            images_json TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            read_at DATETIME NULL,
            INDEX idx_dm_message_thread (conversation_id, id),
            INDEX idx_dm_message_unread (conversation_id, read_at),
            CONSTRAINT fk_dm_message_conversation FOREIGN KEY (conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
            CONSTRAINT fk_dm_message_sender FOREIGN KEY (sender_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    ];
    foreach ($tables as $sql) $db->exec($sql);
}

function postsCreateSqliteSchema(PDO $db): void
{
    $tables = [
        "CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            author_id INTEGER NOT NULL REFERENCES users(id),
            club_id INTEGER NULL,
            club_country TEXT NULL,
            content TEXT NOT NULL,
            images_json TEXT NOT NULL DEFAULT '[]',
            reply_to_id INTEGER NULL REFERENCES posts(id),
            quoted_post_id INTEGER NULL REFERENCES posts(id),
            status TEXT NOT NULL DEFAULT 'published',
            like_count INTEGER NOT NULL DEFAULT 0,
            reply_count INTEGER NOT NULL DEFAULT 0,
            repost_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            deleted_at TEXT NULL
        )",
        "CREATE TABLE IF NOT EXISTS post_likes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        "CREATE TABLE IF NOT EXISTS post_attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uploader_id INTEGER NOT NULL REFERENCES users(id),
            post_id INTEGER NULL REFERENCES posts(id) ON DELETE SET NULL,
            upload_token TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            file_size INTEGER NOT NULL DEFAULT 0,
            original_name TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        "CREATE TABLE IF NOT EXISTS user_follows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        "CREATE TABLE IF NOT EXISTS dm_conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_a_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            user_b_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            last_message_id INTEGER NULL,
            last_message_at TEXT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        "CREATE TABLE IF NOT EXISTS dm_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
            sender_id INTEGER NOT NULL REFERENCES users(id),
            content TEXT NOT NULL,
            images_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            read_at TEXT NULL
        )",
    ];
    foreach ($tables as $sql) $db->exec($sql);
    $indexes = [
        'CREATE INDEX IF NOT EXISTS idx_posts_listing ON posts(status, id)',
        'CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, status, id)',
        'CREATE INDEX IF NOT EXISTS idx_posts_reply ON posts(reply_to_id, status, id)',
        'CREATE INDEX IF NOT EXISTS idx_posts_quoted ON posts(quoted_post_id)',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_post_like_unique ON post_likes(post_id, user_id)',
        'CREATE INDEX IF NOT EXISTS idx_post_attachment_upload ON post_attachments(uploader_id, upload_token, post_id)',
        'CREATE INDEX IF NOT EXISTS idx_post_attachment_post ON post_attachments(post_id)',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_user_follow_unique ON user_follows(follower_id, following_id)',
        'CREATE INDEX IF NOT EXISTS idx_user_follow_following ON user_follows(following_id)',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_conversation_pair ON dm_conversations(user_a_id, user_b_id)',
        'CREATE INDEX IF NOT EXISTS idx_dm_message_thread ON dm_messages(conversation_id, id)',
        'CREATE INDEX IF NOT EXISTS idx_dm_message_unread ON dm_messages(conversation_id, read_at)',
    ];
    foreach ($indexes as $sql) $db->exec($sql);
}
