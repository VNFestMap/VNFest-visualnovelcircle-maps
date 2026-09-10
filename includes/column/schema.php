<?php
declare(strict_types=1);

function columnTableExists(PDO $db, string $table): bool
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

function columnTableCount(PDO $db, string $table): int
{
    if (!columnTableExists($db, $table)) return 0;
    $quoted = (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql'
        ? '`' . str_replace('`', '``', $table) . '`'
        : '"' . str_replace('"', '""', $table) . '"';
    return (int)$db->query('SELECT COUNT(*) FROM ' . $quoted)->fetchColumn();
}

function columnEnsureSchema(PDO $db): void
{
    static $ensured = [];
    $driver = (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME);
    $key = $driver . ':' . spl_object_id($db);
    if (!empty($ensured[$key])) return;
    if (!columnTableExists($db, 'column_documents')) {
        throw new RuntimeException('专栏数据表尚未迁移，请先运行专栏迁移脚本');
    }
    if ($driver === 'mysql') {
        columnEnsureMysqlSchema($db);
    } elseif ($driver === 'sqlite') {
        columnEnsureSqliteSchema($db);
    } else {
        throw new RuntimeException('Unsupported column database driver: ' . $driver);
    }
    $ensured[$key] = true;
}

function columnBackupForMigration(PDO $db, ?string $backupDirectory = null): ?string
{
    $driver = (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($driver !== 'sqlite' || !defined('DB_PATH') || !is_file(DB_PATH)) return null;
    $backupDirectory = $backupDirectory ?: dirname(DB_PATH) . DIRECTORY_SEPARATOR . 'column-migration-backups';
    if (!is_dir($backupDirectory) && !mkdir($backupDirectory, 0755, true) && !is_dir($backupDirectory)) {
        throw new RuntimeException('无法创建专栏迁移备份目录');
    }
    $target = rtrim($backupDirectory, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'column-before-' . date('Ymd-His') . '-' . bin2hex(random_bytes(3)) . '.db';
    if (!copy(DB_PATH, $target)) throw new RuntimeException('无法备份 SQLite 数据库');
    return $target;
}

function columnMigrateSchema(PDO $db, ?string $backupDirectory = null): void
{
    if (columnTableExists($db, 'column_documents')) {
        columnEnsureSchema($db);
        return;
    }

    $legacyTables = [
        'column_series',
        'column_articles',
        'column_tags',
        'column_article_tags',
        'column_attachments',
        'column_article_revisions',
        'column_comments',
    ];
    $counts = [];
    foreach ($legacyTables as $table) {
        $count = columnTableCount($db, $table);
        if ($count > 0) $counts[$table] = $count;
    }
    if ($counts) {
        throw new RuntimeException('旧专栏表仍有数据，迁移已中止：' . json_encode($counts, JSON_UNESCAPED_UNICODE));
    }

    columnBackupForMigration($db, $backupDirectory);
    $driver = (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($driver === 'sqlite') $db->exec('PRAGMA foreign_keys = OFF');
    if ($driver === 'mysql') $db->exec('SET FOREIGN_KEY_CHECKS = 0');
    try {
        foreach (array_reverse($legacyTables) as $table) {
            if (columnTableExists($db, $table)) $db->exec('DROP TABLE IF EXISTS `' . $table . '`');
        }
    } finally {
        if ($driver === 'mysql') $db->exec('SET FOREIGN_KEY_CHECKS = 1');
        if ($driver === 'sqlite') $db->exec('PRAGMA foreign_keys = ON');
    }

    if ($driver === 'mysql') {
        columnCreateMysqlSchema($db);
    } elseif ($driver === 'sqlite') {
        columnCreateSqliteSchema($db);
    } else {
        throw new RuntimeException('Unsupported column database driver: ' . $driver);
    }
}

function columnEnsureMysqlSchema(PDO $db): void
{
    columnCreateMysqlSchema($db);
}

function columnCreateMysqlSchema(PDO $db): void
{
    $tables = [
        "CREATE TABLE IF NOT EXISTS column_documents (
            id INT AUTO_INCREMENT PRIMARY KEY,
            path_key VARCHAR(80) NULL,
            author_id INT NOT NULL,
            club_id INT NULL,
            club_country VARCHAR(20) NULL,
            type VARCHAR(20) NOT NULL,
            title VARCHAR(180) NOT NULL,
            summary VARCHAR(1200) NOT NULL DEFAULT '',
            body_markdown MEDIUMTEXT NOT NULL,
            body_html MEDIUMTEXT NOT NULL,
            body_text MEDIUMTEXT NOT NULL,
            toc_json TEXT NOT NULL,
            cover_path VARCHAR(500) NOT NULL DEFAULT '',
            read_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 1,
            status VARCHAR(20) NOT NULL DEFAULT 'draft',
            featured_rank INT NULL,
            published_at DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            deleted_at DATETIME NULL,
            UNIQUE KEY uk_column_document_path_key (path_key),
            INDEX idx_column_document_listing (status, featured_rank, published_at, id),
            INDEX idx_column_document_author (author_id, status, updated_at),
            INDEX idx_column_document_type (type, status, published_at),
            CONSTRAINT fk_column_document_author FOREIGN KEY (author_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS column_attachments (
            id INT AUTO_INCREMENT PRIMARY KEY,
            uploader_id INT NOT NULL,
            document_id INT NULL,
            upload_token VARCHAR(64) NOT NULL,
            relative_path VARCHAR(500) NOT NULL,
            mime_type VARCHAR(80) NOT NULL,
            width INT NOT NULL DEFAULT 0,
            height INT NOT NULL DEFAULT 0,
            file_size INT UNSIGNED NOT NULL DEFAULT 0,
            original_name VARCHAR(255) NOT NULL DEFAULT '',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_column_attachment_upload (uploader_id, upload_token, document_id),
            INDEX idx_column_attachment_document (document_id),
            CONSTRAINT fk_column_attachment_uploader FOREIGN KEY (uploader_id) REFERENCES users(id),
            CONSTRAINT fk_column_attachment_document FOREIGN KEY (document_id) REFERENCES column_documents(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS column_document_revisions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            document_id INT NOT NULL,
            editor_id INT NOT NULL,
            title VARCHAR(180) NOT NULL,
            summary VARCHAR(1200) NOT NULL DEFAULT '',
            body_markdown MEDIUMTEXT NOT NULL,
            body_html MEDIUMTEXT NOT NULL,
            body_text MEDIUMTEXT NOT NULL,
            toc_json TEXT NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'draft',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_column_revision_document (document_id, created_at),
            CONSTRAINT fk_column_revision_document FOREIGN KEY (document_id) REFERENCES column_documents(id) ON DELETE CASCADE,
            CONSTRAINT fk_column_revision_editor FOREIGN KEY (editor_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    ];
    foreach ($tables as $sql) $db->exec($sql);
}

function columnEnsureSqliteSchema(PDO $db): void
{
    columnCreateSqliteSchema($db);
}

function columnCreateSqliteSchema(PDO $db): void
{
    $tables = [
        "CREATE TABLE IF NOT EXISTS column_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path_key TEXT UNIQUE,
            author_id INTEGER NOT NULL REFERENCES users(id),
            club_id INTEGER NULL,
            club_country TEXT NULL,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL DEFAULT '',
            body_markdown TEXT NOT NULL,
            body_html TEXT NOT NULL,
            body_text TEXT NOT NULL,
            toc_json TEXT NOT NULL,
            cover_path TEXT NOT NULL DEFAULT '',
            read_minutes INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'draft',
            featured_rank INTEGER NULL,
            published_at TEXT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            deleted_at TEXT NULL
        )",
        "CREATE TABLE IF NOT EXISTS column_attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uploader_id INTEGER NOT NULL REFERENCES users(id),
            document_id INTEGER NULL REFERENCES column_documents(id) ON DELETE SET NULL,
            upload_token TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            file_size INTEGER NOT NULL DEFAULT 0,
            original_name TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        "CREATE TABLE IF NOT EXISTS column_document_revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id INTEGER NOT NULL REFERENCES column_documents(id) ON DELETE CASCADE,
            editor_id INTEGER NOT NULL REFERENCES users(id),
            title TEXT NOT NULL,
            summary TEXT NOT NULL DEFAULT '',
            body_markdown TEXT NOT NULL,
            body_html TEXT NOT NULL,
            body_text TEXT NOT NULL,
            toc_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
    ];
    foreach ($tables as $sql) $db->exec($sql);
    $indexes = [
        'CREATE INDEX IF NOT EXISTS idx_column_document_listing ON column_documents(status, featured_rank, published_at, id)',
        'CREATE INDEX IF NOT EXISTS idx_column_document_author ON column_documents(author_id, status, updated_at)',
        'CREATE INDEX IF NOT EXISTS idx_column_document_type ON column_documents(type, status, published_at)',
        'CREATE INDEX IF NOT EXISTS idx_column_attachment_upload ON column_attachments(uploader_id, upload_token, document_id)',
        'CREATE INDEX IF NOT EXISTS idx_column_attachment_document ON column_attachments(document_id)',
        'CREATE INDEX IF NOT EXISTS idx_column_revision_document ON column_document_revisions(document_id, created_at)',
    ];
    foreach ($indexes as $sql) $db->exec($sql);
}
