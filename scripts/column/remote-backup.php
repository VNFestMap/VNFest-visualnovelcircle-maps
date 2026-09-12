<?php
declare(strict_types=1);
// 部署前备份：column 三表 + （库不大时）整库 dump，输出到指定备份目录
require_once __DIR__ . '/config.php';

$dir = $argv[1] ?? '';
if ($dir === '' || !preg_match('#^_deploy_backup_posts_\d{8}-\d{6}$#', basename($dir))) {
    fwrite(STDERR, "invalid backup dir\n");
    exit(1);
}
if (!is_dir($dir) && !mkdir($dir, 0755, true)) {
    fwrite(STDERR, "cannot mkdir $dir\n");
    exit(1);
}

putenv('MYSQL_PWD=' . DB_PASS);

// 该主机 mysqldump 缺 RELOAD 权限（FLUSH TABLES 被拒），改用 PDO 留档：
// 三张专栏表的建表语句 + 全库行数清单。本次迁移不修改任何现有表的数据。
$db = new PDO('mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4', DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$out = "-- column removal pre-deploy snapshot " . date('Y-m-d H:i:s') . "\n";
$out .= "-- host=" . DB_HOST . " db=" . DB_NAME . "\n\n";
foreach (['column_documents', 'column_attachments', 'column_document_revisions'] as $t) {
    try {
        $row = $db->query('SHOW CREATE TABLE `' . $t . '`')->fetch(PDO::FETCH_NUM);
        $n = $db->query("SELECT COUNT(*) FROM `$t`")->fetchColumn();
        $out .= "-- table $t ($n rows)\n" . $row[1] . ";\n\n";
    } catch (Throwable $e) {
        $out .= "-- table $t missing\n\n";
    }
}
$out .= "-- row counts\n";
foreach ($db->query('SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name') as $row) {
    $out .= '-- ' . $row['table_name'] . ': ' . $row['table_rows'] . "\n";
}
file_put_contents($dir . '/column-tables-snapshot.sql', $out);
echo "[OK] schema snapshot written\n";
$size = 0;
foreach ($db->query('SELECT data_length + index_length AS s FROM information_schema.tables WHERE table_schema = DATABASE()') as $row) {
    $size += (int)$row['s'];
}
echo 'db size: ' . round($size / 1048576) . " MB\n";
