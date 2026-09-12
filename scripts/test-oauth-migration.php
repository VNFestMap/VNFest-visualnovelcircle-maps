<?php
// scripts/test-oauth-migration.php - 在隔离临时 SQLite 数据库上验证迁移

declare(strict_types=1);

$tempRoot = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'vnfest-oauth-migration-' . bin2hex(random_bytes(8));
$dbPath = $tempRoot . DIRECTORY_SEPARATOR . 'migration.db';

function oauthMigrationRemoveTree(string $path): void {
    if (!is_dir($path)) {
        if (is_file($path)) @unlink($path);
        return;
    }
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($iterator as $item) {
        if ($item->isDir()) {
            @rmdir($item->getPathname());
        } else {
            @unlink($item->getPathname());
        }
    }
    @rmdir($path);
}

try {
    if (!mkdir($tempRoot, 0755, true) && !is_dir($tempRoot)) {
        throw new RuntimeException('无法创建迁移测试目录');
    }

    // migrate.php 会 require 项目 config.php；预先定义这些常量即可让
    // 同一迁移代码指向隔离数据库，而不会读取或修改工作区 data/。
    error_reporting(0);
    define('DB_DRIVER', 'sqlite');
    define('DB_PATH', $dbPath);
    define('DATA_PATH', $tempRoot . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR);

    ob_start();
    require __DIR__ . '/migrate.php';
    $migrationOutput = (string)ob_get_clean();

    $db = new PDO('sqlite:' . $dbPath);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $columns = $db->query('PRAGMA table_info(users)')->fetchAll(PDO::FETCH_COLUMN, 1);
    $challengeTable = $db->query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oauth_account_challenges'"
    )->fetchColumn();
    $emailIndex = $db->query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uq_users_email'"
    )->fetchColumn();

    if (!in_array('credentials_completed_at', $columns, true)) {
        throw new RuntimeException('users.credentials_completed_at 未创建');
    }
    if (!$challengeTable) {
        throw new RuntimeException('oauth_account_challenges 未创建');
    }
    if (!$emailIndex) {
        throw new RuntimeException('SQLite 邮箱唯一索引未创建');
    }

    echo "OAuth migration checks passed\n";
    echo 'migration output lines=' . count(preg_split('/\R/', trim($migrationOutput))) . "\n";
} catch (Throwable $error) {
    fwrite(STDERR, 'OAuth migration checks failed: ' . $error->getMessage() . "\n");
    exit(1);
} finally {
    oauthMigrationRemoveTree($tempRoot);
}
