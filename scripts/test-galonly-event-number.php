<?php

require_once __DIR__ . '/../includes/galonly_application_numbers.php';

function expectSame($actual, $expected, string $message): void {
    if ($actual === $expected) return;
    fwrite(STDERR, $message . "\nExpected: " . json_encode($expected) . "\nActual: " . json_encode($actual) . "\n");
    exit(1);
}

$db = new PDO('sqlite::memory:');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->exec('PRAGMA foreign_keys = ON');
$db->exec('CREATE TABLE galonly_events (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
$db->exec(
    'CREATE TABLE galonly_applications ('
    . 'id INTEGER PRIMARY KEY AUTOINCREMENT, '
    . 'event_id INTEGER NOT NULL REFERENCES galonly_events(id), '
    . 'created_at TEXT NOT NULL)'
);
$db->exec("INSERT INTO galonly_events (id, name) VALUES (2, '上海'), (3, '北京')");
$db->exec(
    "INSERT INTO galonly_applications (id, event_id, created_at) VALUES "
    . "(13, 2, '2026-05-12 16:19:43'), "
    . "(14, 2, '2026-05-12 16:29:33'), "
    . "(53, 3, '2026-08-14 21:33:31'), "
    . "(54, 3, '2026-08-15 08:30:34'), "
    . "(56, 3, '2026-08-17 18:16:36')"
);

galonlyEnsureApplicationNumberSchema($db);

$readNumbers = function (int $eventId) use ($db): array {
    $stmt = $db->prepare('SELECT event_number FROM galonly_applications WHERE event_id = ? ORDER BY created_at, id');
    $stmt->execute([$eventId]);
    return array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
};

expectSame($readNumbers(2), [1, 2], '上海编号应从 1 开始');
expectSame($readNumbers(3), [1, 2, 3], '北京编号应独立从 1 开始');

galonlyEnsureApplicationNumberSchema($db);
expectSame($readNumbers(3), [1, 2, 3], '重复运行 schema guard 不应重排已分配编号');

$db->exec('DELETE FROM galonly_applications WHERE event_id = 3 AND event_number = 2');
galonlyBeginApplicationWrite($db);
$beijingNext = galonlyNextApplicationNumber($db, 3);
$stmt = $db->prepare('INSERT INTO galonly_applications (id, event_id, event_number, created_at) VALUES (?, ?, ?, ?)');
$stmt->execute([57, 3, $beijingNext, '2026-08-18 15:23:50']);
$db->commit();
expectSame($beijingNext, 4, '删除申请后不应复用旧编号');
expectSame($readNumbers(3), [1, 3, 4], '北京新申请应继续递增');

galonlyBeginApplicationWrite($db);
$shanghaiNext = galonlyNextApplicationNumber($db, 2);
$stmt->execute([15, 2, $shanghaiNext, '2026-05-12 16:40:51']);
$db->commit();
expectSame($shanghaiNext, 3, '上海编号不应受北京申请影响');
expectSame($readNumbers(2), [1, 2, 3], '上海应保持自己的连续序列');

$duplicateRejected = false;
try {
    $db->exec("INSERT INTO galonly_applications (id, event_id, event_number, created_at) VALUES (58, 3, 4, '2026-08-19 00:00:00')");
} catch (PDOException $e) {
    $duplicateRejected = true;
}
expectSame($duplicateRejected, true, '数据库应拒绝同一活动内的重复编号');

$ids = array_map('intval', $db->query('SELECT id FROM galonly_applications ORDER BY id')->fetchAll(PDO::FETCH_COLUMN));
expectSame($ids, [13, 14, 15, 53, 56, 57], '内部主键不应被活动编号改写');

$contracts = [
    '../api/galonly.php' => [
        "require_once __DIR__ . '/../includes/galonly_application_numbers.php';",
        'galonlyBeginApplicationWrite($db);',
        '$eventNumber = galonlyNextApplicationNumber($db, $eventId);',
        'INSERT INTO galonly_applications (event_id, event_number, user_id',
        "'application_id' => \$appId",
        "'event_number' => \$eventNumber",
    ],
    '../scripts/migrate.php' => [
        'event_number  INT DEFAULT NULL',
        'event_number  INTEGER DEFAULT NULL',
        'galonlyEnsureApplicationNumberSchema($db);',
    ],
    '../Galgame_events/Galonly_status.html' => [
        'parseInt(app.event_number, 10) || parseInt(app.id, 10)',
    ],
    '../Galgame_events/Galonly_confirmation.html' => [
        'parseInt(application.event_number, 10) || parseInt(applicationId, 10)',
        "'Application #' + displayNumber",
    ],
    '../admin/Galonly_audit.html' => [
        'function boothApplicationNumber(app)',
        "['申请编号', '内部ID'",
        "申请 #' + boothApplicationNumber(app)",
    ],
];
foreach ($contracts as $relativePath => $needles) {
    $source = file_get_contents(__DIR__ . '/' . $relativePath);
    foreach ($needles as $needle) {
        if (str_contains($source, $needle)) continue;
        fwrite(STDERR, "$relativePath missing contract marker: $needle\n");
        exit(1);
    }
}

echo "GalOnly event number contract ok\n";
