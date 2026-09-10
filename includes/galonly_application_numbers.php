<?php

function galonlyApplicationNumberDriver(PDO $db): string {
    return strtolower((string)$db->getAttribute(PDO::ATTR_DRIVER_NAME));
}

function galonlyApplicationNumberColumnExists(PDO $db): bool {
    if (galonlyApplicationNumberDriver($db) === 'mysql') {
        $stmt = $db->query("SHOW COLUMNS FROM `galonly_applications` LIKE 'event_number'");
        return (bool)$stmt->fetch();
    }

    $stmt = $db->query('PRAGMA table_info(galonly_applications)');
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $column) {
        if (($column['name'] ?? '') === 'event_number') return true;
    }
    return false;
}

function galonlyApplicationNumberIndexExists(PDO $db): bool {
    if (galonlyApplicationNumberDriver($db) === 'mysql') {
        $stmt = $db->query("SHOW INDEX FROM `galonly_applications` WHERE Key_name = 'uk_galonly_app_event_number'");
        return (bool)$stmt->fetch();
    }

    $stmt = $db->query('PRAGMA index_list(galonly_applications)');
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $index) {
        if (($index['name'] ?? '') === 'uk_galonly_app_event_number') return true;
    }
    return false;
}

function galonlyBeginApplicationWrite(PDO $db): void {
    if ($db->inTransaction()) return;
    if (galonlyApplicationNumberDriver($db) === 'sqlite') {
        $db->exec('BEGIN IMMEDIATE TRANSACTION');
        return;
    }
    $db->beginTransaction();
}

function galonlyRollbackApplicationWrite(PDO $db): void {
    if ($db->inTransaction()) $db->rollBack();
}

function galonlyLockApplicationEvent(PDO $db, int $eventId): void {
    if (galonlyApplicationNumberDriver($db) !== 'mysql') return;
    $stmt = $db->prepare('SELECT id FROM galonly_events WHERE id = ? FOR UPDATE');
    $stmt->execute([$eventId]);
    if (!$stmt->fetchColumn()) {
        throw new RuntimeException('活动不存在');
    }
}

function galonlyNextApplicationNumber(PDO $db, int $eventId): int {
    galonlyLockApplicationEvent($db, $eventId);
    $stmt = $db->prepare(
        'SELECT COALESCE(MAX(event_number), 0) + 1 FROM galonly_applications WHERE event_id = ?'
    );
    $stmt->execute([$eventId]);
    return max(1, (int)$stmt->fetchColumn());
}

function galonlyBackfillApplicationNumbers(PDO $db): void {
    $missing = (int)$db->query(
        'SELECT COUNT(*) FROM galonly_applications WHERE event_number IS NULL OR event_number < 1'
    )->fetchColumn();
    if ($missing === 0) return;

    $startedHere = !$db->inTransaction();
    if ($startedHere) galonlyBeginApplicationWrite($db);

    try {
        $eventIds = $db->query(
            'SELECT DISTINCT event_id FROM galonly_applications '
            . 'WHERE event_number IS NULL OR event_number < 1 ORDER BY event_id'
        )->fetchAll(PDO::FETCH_COLUMN);
        $maxStmt = $db->prepare(
            'SELECT COALESCE(MAX(event_number), 0) FROM galonly_applications WHERE event_id = ?'
        );
        $missingStmt = $db->prepare(
            'SELECT id FROM galonly_applications '
            . 'WHERE event_id = ? AND (event_number IS NULL OR event_number < 1) '
            . 'ORDER BY created_at ASC, id ASC'
        );
        $updateStmt = $db->prepare(
            'UPDATE galonly_applications SET event_number = ? WHERE id = ? '
            . 'AND (event_number IS NULL OR event_number < 1)'
        );

        foreach ($eventIds as $eventIdValue) {
            $eventId = (int)$eventIdValue;
            galonlyLockApplicationEvent($db, $eventId);
            $maxStmt->execute([$eventId]);
            $next = (int)$maxStmt->fetchColumn() + 1;
            $missingStmt->execute([$eventId]);
            foreach ($missingStmt->fetchAll(PDO::FETCH_COLUMN) as $applicationId) {
                $updateStmt->execute([$next, (int)$applicationId]);
                if ($updateStmt->rowCount() > 0) $next++;
            }
        }

        if ($startedHere) $db->commit();
    } catch (Throwable $e) {
        if ($startedHere) galonlyRollbackApplicationWrite($db);
        throw $e;
    }
}

function galonlyEnsureApplicationNumberSchema(PDO $db): void {
    if (!galonlyApplicationNumberColumnExists($db)) {
        $definition = galonlyApplicationNumberDriver($db) === 'mysql' ? 'INT DEFAULT NULL' : 'INTEGER DEFAULT NULL';
        try {
            $db->exec("ALTER TABLE galonly_applications ADD COLUMN event_number $definition");
        } catch (Throwable $e) {
            if (!galonlyApplicationNumberColumnExists($db)) throw $e;
        }
    }

    galonlyBackfillApplicationNumbers($db);

    if (!galonlyApplicationNumberIndexExists($db)) {
        if (galonlyApplicationNumberDriver($db) === 'mysql') {
            $db->exec(
                'ALTER TABLE galonly_applications '
                . 'ADD UNIQUE KEY uk_galonly_app_event_number (event_id, event_number)'
            );
        } else {
            $db->exec(
                'CREATE UNIQUE INDEX IF NOT EXISTS uk_galonly_app_event_number '
                . 'ON galonly_applications(event_id, event_number)'
            );
        }
    }
}
