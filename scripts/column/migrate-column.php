<?php
declare(strict_types=1);

require_once __DIR__ . '/../../config.php';
require_once __DIR__ . '/../../includes/db.php';
require_once __DIR__ . '/../../includes/column/schema.php';

$db = getDB();
$backupDirectory = dirname(DB_PATH) . DIRECTORY_SEPARATOR . 'column-migration-backups';
columnMigrateSchema($db, $backupDirectory);

echo "column document schema ready (" . $db->getAttribute(PDO::ATTR_DRIVER_NAME) . ")\n";
