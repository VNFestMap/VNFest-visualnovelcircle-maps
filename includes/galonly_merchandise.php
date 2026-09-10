<?php

/**
 * Beijing GalOnly material-version and review-round helpers.
 *
 * Material changes are kept as immutable JSON snapshots.  The application row
 * remains the fast current-state projection consumed by the existing pages.
 */
function galonlyMerchandiseDriver(PDO $db): string
{
    return strtolower((string)$db->getAttribute(PDO::ATTR_DRIVER_NAME));
}

function galonlyMerchandiseColumnExists(PDO $db, string $table, string $column): bool
{
    if (galonlyMerchandiseDriver($db) === 'mysql') {
        $stmt = $db->query("SHOW COLUMNS FROM `$table` LIKE " . $db->quote($column));
        return (bool)$stmt->fetch(PDO::FETCH_ASSOC);
    }

    $stmt = $db->query("PRAGMA table_info(`$table`)");
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        if (($row['name'] ?? '') === $column) return true;
    }
    return false;
}

function galonlyMerchandiseEnsureColumn(PDO $db, string $table, string $column, string $definition): void
{
    if (galonlyMerchandiseColumnExists($db, $table, $column)) return;
    try {
        $db->exec("ALTER TABLE `$table` ADD COLUMN `$column` $definition");
    } catch (Throwable $e) {
        if (!galonlyMerchandiseColumnExists($db, $table, $column)) throw $e;
    }
}

function galonlyMerchandiseDecodeList($value): array
{
    if (is_array($value)) return array_values($value);
    $decoded = json_decode((string)($value ?? ''), true);
    return is_array($decoded) ? array_values($decoded) : [];
}

function galonlyMerchandiseJson(array $value): string
{
    return json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

function galonlyMerchandiseNormalizeItems(array $items): array
{
    $normalized = [];
    foreach ($items as $item) {
        if (!is_array($item)) continue;
        $name = trim((string)($item['name'] ?? ''));
        if ($name === '') continue;
        $images = [];
        foreach (galonlyMerchandiseDecodeList($item['images'] ?? []) as $image) {
            $image = trim((string)$image);
            if ($image !== '' && count($images) < 6) $images[] = $image;
        }
        $normalized[] = [
            'name' => $name,
            'category' => trim((string)($item['category'] ?? '')),
            'description' => trim((string)($item['description'] ?? '')),
            'images' => $images,
        ];
    }
    return $normalized;
}

function galonlyMerchandiseCanonicalItem(array $item): string
{
    return json_encode($item, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_LINE_TERMINATORS);
}

/** Return true when every prior item remains unchanged in the new list. */
function galonlyMerchandiseContainsPriorItems(array $prior, array $next): bool
{
    $available = [];
    foreach (galonlyMerchandiseNormalizeItems($next) as $item) {
        $key = galonlyMerchandiseCanonicalItem($item);
        $available[$key] = ($available[$key] ?? 0) + 1;
    }
    foreach (galonlyMerchandiseNormalizeItems($prior) as $item) {
        $key = galonlyMerchandiseCanonicalItem($item);
        if (($available[$key] ?? 0) < 1) return false;
        $available[$key]--;
    }
    return true;
}

function galonlyMerchandiseReviewStatus(string $status): string
{
    return match ($status) {
        'confirmed', 'shared' => 'approved',
        'phase2_revision' => 'revision',
        'rejected' => 'rejected',
        default => 'pending',
    };
}

function galonlyMerchandiseEnsureHistoryTable(PDO $db): void
{
    if (galonlyMerchandiseDriver($db) === 'mysql') {
        $db->exec("CREATE TABLE IF NOT EXISTS galonly_merchandise_revisions (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            application_id INT NOT NULL,
            material_version INT NOT NULL,
            submitted_by INT NULL,
            submitted_at DATETIME NOT NULL,
            source_status VARCHAR(40) NOT NULL DEFAULT 'phase2_pending',
            review_status VARCHAR(20) NOT NULL DEFAULT 'pending',
            reviewed_at DATETIME NULL,
            reviewed_by INT NULL,
            review_feedback TEXT NULL,
            merchandise_items LONGTEXT NOT NULL,
            merchandise_attachments TEXT NULL,
            display_image VARCHAR(500) NULL,
            UNIQUE KEY uk_galonly_merch_revision (application_id, material_version),
            INDEX idx_galonly_merch_revision_app (application_id, submitted_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
        return;
    }

    $db->exec("CREATE TABLE IF NOT EXISTS galonly_merchandise_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL,
        material_version INTEGER NOT NULL,
        submitted_by INTEGER NULL,
        submitted_at TEXT NOT NULL,
        source_status TEXT NOT NULL DEFAULT 'phase2_pending',
        review_status TEXT NOT NULL DEFAULT 'pending',
        reviewed_at TEXT NULL,
        reviewed_by INTEGER NULL,
        review_feedback TEXT NULL,
        merchandise_items TEXT NOT NULL,
        merchandise_attachments TEXT NULL,
        display_image TEXT NULL,
        UNIQUE(application_id, material_version)
    )");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_galonly_merch_revision_app
        ON galonly_merchandise_revisions(application_id, submitted_at)");
}

function galonlyMerchandiseRecordRevision(PDO $db, array $data): void
{
    $sql = 'INSERT INTO galonly_merchandise_revisions
        (application_id, material_version, submitted_by, submitted_at, source_status,
         review_status, merchandise_items, merchandise_attachments, display_image)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
    $stmt = $db->prepare($sql);
    $stmt->execute([
        (int)$data['application_id'],
        (int)$data['material_version'],
        !empty($data['submitted_by']) ? (int)$data['submitted_by'] : null,
        (string)$data['submitted_at'],
        (string)($data['source_status'] ?? 'phase2_pending'),
        (string)($data['review_status'] ?? 'pending'),
        galonlyMerchandiseJson(galonlyMerchandiseNormalizeItems(galonlyMerchandiseDecodeList($data['merchandise_items'] ?? []))),
        galonlyMerchandiseJson(galonlyMerchandiseDecodeList($data['merchandise_attachments'] ?? [])),
        trim((string)($data['display_image'] ?? '')) ?: null,
    ]);
}

function galonlyMerchandiseUpdateRevisionReview(PDO $db, int $applicationId, int $version, string $status, ?int $reviewedBy, string $feedback): void
{
    $stmt = $db->prepare('UPDATE galonly_merchandise_revisions
        SET review_status = ?, reviewed_at = ?, reviewed_by = ?, review_feedback = ?
        WHERE application_id = ? AND material_version = ?');
    $stmt->execute([
        galonlyMerchandiseReviewStatus($status),
        date('Y-m-d H:i:s'),
        $reviewedBy,
        $feedback !== '' ? $feedback : null,
        $applicationId,
        $version,
    ]);
}

function galonlyMerchandiseBackfill(PDO $db): void
{
    $rows = $db->query('SELECT id, status, merchandise_items, merchandise_attachments, display_image,
        merchandise_version, merchandise_updated_at, updated_at, created_at
        FROM galonly_applications')->fetchAll(PDO::FETCH_ASSOC);
    $update = $db->prepare('UPDATE galonly_applications
        SET merchandise_version = ?, merchandise_updated_at = ? WHERE id = ?');
    $exists = $db->prepare('SELECT id FROM galonly_merchandise_revisions
        WHERE application_id = ? AND material_version = ? LIMIT 1');

    foreach ($rows as $row) {
        $items = galonlyMerchandiseDecodeList($row['merchandise_items'] ?? []);
        $attachments = galonlyMerchandiseDecodeList($row['merchandise_attachments'] ?? []);
        $hasMaterial = $items || $attachments || trim((string)($row['display_image'] ?? '')) !== '';
        $version = (int)($row['merchandise_version'] ?? 0);
        $submittedAt = trim((string)($row['merchandise_updated_at'] ?? ''))
            ?: trim((string)($row['updated_at'] ?? ''))
            ?: trim((string)($row['created_at'] ?? ''))
            ?: date('Y-m-d H:i:s');

        if ($hasMaterial && $version < 1) {
            $version = 1;
            $update->execute([$version, $submittedAt, (int)$row['id']]);
        }
        if (!$hasMaterial || $version < 1) continue;

        $exists->execute([(int)$row['id'], $version]);
        if ($exists->fetchColumn()) continue;
        galonlyMerchandiseRecordRevision($db, [
            'application_id' => (int)$row['id'],
            'material_version' => $version,
            'submitted_at' => $submittedAt,
            'source_status' => (string)($row['status'] ?? 'phase2_pending'),
            'review_status' => galonlyMerchandiseReviewStatus((string)($row['status'] ?? 'phase2_pending')),
            'merchandise_items' => $items,
            'merchandise_attachments' => $attachments,
            'display_image' => $row['display_image'] ?? '',
        ]);
    }
}

function galonlyEnsureMerchandiseSchema(PDO $db): void
{
    $mysql = galonlyMerchandiseDriver($db) === 'mysql';
    galonlyMerchandiseEnsureColumn($db, 'galonly_applications', 'merchandise_version', $mysql ? 'INT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0');
    galonlyMerchandiseEnsureColumn($db, 'galonly_applications', 'merchandise_updated_at', $mysql ? 'DATETIME NULL' : 'TEXT NULL');
    galonlyMerchandiseEnsureColumn($db, 'galonly_applications', 'phase2_approved_status', $mysql ? 'VARCHAR(20) DEFAULT NULL' : 'TEXT DEFAULT NULL');
    galonlyMerchandiseEnsureColumn($db, 'galonly_votes', 'merchandise_version', $mysql ? 'INT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0');
    galonlyMerchandiseEnsureHistoryTable($db);
    galonlyMerchandiseBackfill($db);
}

function galonlyMerchandiseVersion(array $app): int
{
    return max(0, (int)($app['merchandise_version'] ?? 0));
}

function galonlyMerchandiseIsUpdatePending(array $app): bool
{
    $status = (string)($app['status'] ?? '');
    return $status === 'phase2_additional_pending'
        || (galonlyMerchandiseVersion($app) > 1 && in_array($status, ['phase2_pending', 'phase2_revision'], true));
}

function galonlyMerchandiseDeadlineMode(?DateTimeImmutable $now = null): string
{
    $now = $now ?: new DateTimeImmutable('now', new DateTimeZone('Asia/Shanghai'));
    $fullEditEnd = new DateTimeImmutable('2026-09-19 00:00:00', new DateTimeZone('Asia/Shanghai'));
    $appendEnd = new DateTimeImmutable('2026-10-01 00:00:00', new DateTimeZone('Asia/Shanghai'));
    if ($now < $fullEditEnd) return 'full';
    if ($now < $appendEnd) return 'append';
    return 'closed';
}
