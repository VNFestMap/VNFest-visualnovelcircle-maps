<?php
declare(strict_types=1);

require_once __DIR__ . '/../../config.php';
require_once __DIR__ . '/../../includes/db.php';
require_once __DIR__ . '/../../includes/posts/schema.php';

$db = getDB();
postsMigrateSchema($db);

echo "posts schema ready (" . $db->getAttribute(PDO::ATTR_DRIVER_NAME) . ")\n";
