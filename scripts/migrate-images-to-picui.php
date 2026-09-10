<?php
// 将公开历史图片上传到 picui，并在上传成功后替换公开引用。
// 用法：php scripts/migrate-images-to-picui.php --dry-run
//      php scripts/migrate-images-to-picui.php --resume --limit=100
//      php scripts/migrate-images-to-picui.php --resume --rewrite
//      php scripts/migrate-images-to-picui.php --verify
//      php scripts/migrate-images-to-picui.php --include-publications --resume --limit=100

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "This script must run from CLI.\n");
    exit(1);
}

require_once __DIR__ . '/../includes/image_host.php';

$root = realpath(__DIR__ . '/..');
$runtimeDir = $root . '/data/image-host';
$manifestFile = $runtimeDir . '/manifest.json';
$backupRoot = $runtimeDir . '/backups';

function migrationArg(string $name, ?string $default = null): ?string {
    global $argv;
    foreach ($argv as $arg) {
        if ($arg === '--' . $name) return 'true';
        if (str_starts_with($arg, '--' . $name . '=')) return substr($arg, strlen($name) + 3);
    }
    return $default;
}

function migrationBool(string $name, bool $default = false): bool {
    return filter_var(migrationArg($name, $default ? 'true' : 'false'), FILTER_VALIDATE_BOOLEAN);
}

function migrationNormalizePath(string $path): string {
    $path = str_replace('\\', '/', trim($path));
    $path = preg_replace('#^\./#', '', $path);
    return ltrim($path, '/');
}

function migrationReadJson(string $file, array $default = []): array {
    if (!is_file($file)) return $default;
    $decoded = json_decode((string)file_get_contents($file), true);
    return is_array($decoded) ? $decoded : $default;
}

function migrationSaveJson(string $file, array $data): void {
    $dir = dirname($file);
    if (!is_dir($dir)) mkdir($dir, 0755, true);
    file_put_contents($file, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT), LOCK_EX);
}

function migrationAddFile(array &$files, string $root, string $absolute): void {
    $absolute = realpath($absolute) ?: '';
    if ($absolute === '' || !is_file($absolute)) return;
    $detected = imageHostDetectImage($absolute);
    if (!$detected) return;
    $relative = migrationNormalizePath(str_replace('\\', '/', substr($absolute, strlen($root) + 1)));
    if ($relative === '' || str_starts_with($relative, 'data/image-host/')) return;
    $files[$relative] = ['path' => $absolute, 'mime' => $detected['mime'], 'size' => (int)filesize($absolute)];
}

function migrationAddDirectory(array &$files, string $root, string $relativeDir): void {
    $dir = $root . '/' . $relativeDir;
    if (!is_dir($dir)) return;
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
    foreach ($iterator as $item) {
        if ($item->isFile()) migrationAddFile($files, $root, $item->getPathname());
    }
}

function migrationCollectStrings($value, array &$paths): void {
    if (is_string($value)) {
        $decoded = json_decode($value, true);
        if (is_array($decoded)) {
            migrationCollectStrings($decoded, $paths);
            return;
        }
        $candidate = migrationNormalizePath((string)(parse_url($value, PHP_URL_PATH) ?: $value));
        if (str_starts_with($candidate, 'uploads/galonly/') && !str_contains($candidate, '..')) $paths[] = $candidate;
        return;
    }
    if (is_array($value)) foreach ($value as $child) migrationCollectStrings($child, $paths);
}

function migrationAddPublicGalonlyFiles(array &$files, string $root): void {
    $config = $root . '/config.php';
    if (!is_file($config)) return;
    try {
        require_once $config;
        require_once $root . '/includes/db.php';
        $db = getDB();
        $stmt = $db->query("SELECT id, image_path, display_image, merchandise_items FROM galonly_applications WHERE status IN ('approved','confirmed','shared')");
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $paths = [];
            migrationCollectStrings($row['image_path'] ?? '', $paths);
            migrationCollectStrings($row['display_image'] ?? '', $paths);
            migrationCollectStrings($row['merchandise_items'] ?? '', $paths);
            foreach (array_unique($paths) as $relative) {
                migrationAddFile($files, $root, $root . '/' . $relative);
                $stem = pathinfo($relative, PATHINFO_FILENAME);
                $thumb = dirname($relative) . '/thumbs/' . $stem . '.webp';
                migrationAddFile($files, $root, $root . '/' . $thumb);
            }
        }
    } catch (Throwable $error) {
        fwrite(STDERR, "WARN: unable to inspect public GalOnly rows: " . $error->getMessage() . "\n");
    }
}

function migrationCollectFiles(string $root, bool $includePublications = false): array {
    $files = [];
    foreach (['data/avatars', 'data/club_avatars', 'data/event_images', 'data/publication_images', 'wiki/uploads'] as $dir) {
        migrationAddDirectory($files, $root, $dir);
    }

    if ($includePublications) {
        $previewData = migrationReadJson($root . '/data/publication_previews.json', ['previews' => []]);
        foreach (($previewData['previews'] ?? []) as $preview) {
            if (($preview['status'] ?? '') !== 'active') continue;
            $id = (int)($preview['id'] ?? 0);
            if ($id > 0) migrationAddDirectory($files, $root, 'uploads/publication_previews/' . $id . '/pages');
        }
    }
    migrationAddPublicGalonlyFiles($files, $root);
    ksort($files, SORT_NATURAL);
    return $files;
}

function migrationManifest(string $file): array {
    $manifest = migrationReadJson($file, ['version' => 1, 'entries' => []]);
    $manifest['version'] = 1;
    $manifest['entries'] = is_array($manifest['entries'] ?? null) ? $manifest['entries'] : [];
    return $manifest;
}

function migrationRemoteMap(array $manifest, bool $includePublications = false): array {
    $map = [];
    foreach ($manifest['entries'] as $local => $entry) {
        $normalizedLocal = migrationNormalizePath($local);
        if (!$includePublications && str_starts_with($normalizedLocal, 'uploads/publication_previews/')) continue;
        if (($entry['status'] ?? '') === 'uploaded' && imageHostIsTrustedUrl((string)($entry['url'] ?? ''))) {
            $map[$normalizedLocal] = $entry['url'];
        }
    }
    return $map;
}

function migrationAliases(string $local): array {
    $local = migrationNormalizePath($local);
    $aliases = [$local, './' . $local, '../' . $local];
    if (str_starts_with($local, 'wiki/uploads/')) {
        $aliases[] = '../uploads/' . substr($local, strlen('wiki/uploads/'));
        $aliases[] = './uploads/' . substr($local, strlen('wiki/uploads/'));
    }
    if (str_starts_with($local, 'uploads/')) {
        $aliases[] = '../' . $local;
    }
    if (str_starts_with($local, 'data/')) {
        $aliases[] = '../' . $local;
    }
    return array_values(array_unique($aliases));
}

function migrationReplaceText(string $text, array $map): array {
    $aliases = [];
    foreach ($map as $local => $remote) {
        foreach (migrationAliases($local) as $alias) $aliases[$alias] = $remote;
    }
    if (!$aliases) return [$text, 0];
    uksort($aliases, static fn($a, $b) => strlen($b) <=> strlen($a));
    $count = 0;
    // Compile one small expression per alias instead of one giant alternation.
    // A large migration manifest can otherwise exceed PCRE's pattern-size limit.
    foreach ($aliases as $alias => $remote) {
        $pattern = '#(?<![A-Za-z0-9_])' . preg_quote($alias, '#') . '(?![A-Za-z0-9_])#';
        $next = preg_replace_callback($pattern, static function () use ($remote, &$count) {
            $count++;
            return $remote;
        }, $text);
        if ($next !== null) $text = $next;
    }
    return [$text, $count];
}

function migrationBackupFile(string $root, string $backupRoot, string $relative): void {
    $source = $root . '/' . migrationNormalizePath($relative);
    if (!is_file($source)) return;
    $target = $backupRoot . '/' . migrationNormalizePath($relative);
    if (!is_dir(dirname($target))) mkdir(dirname($target), 0755, true);
    if (!is_file($target)) copy($source, $target);
}

function migrationRewriteJsonValue($value, array $map, int &$changed) {
    if (is_string($value)) {
        [$next, $replacements] = migrationReplaceText($value, $map);
        $changed += $replacements;
        return $next;
    }
    if (is_array($value)) {
        foreach ($value as $key => $child) {
            $value[$key] = migrationRewriteJsonValue($child, $map, $changed);
        }
    }
    return $value;
}

function migrationShouldSkipRewritePath(string $relative): bool {
    $relative = migrationNormalizePath($relative);
    return preg_match('#^(?:\\.codex-backups(?:/|$)|data/image-host(?:/|$)|wiki\\.bak-[^/]*(?:/|$)|_deploy_backup_[^/]*(?:/|$)|_archify_work(?:/|$)|tools/pdf-reader/vendor(?:/|$))#i', $relative) === 1;
}

function migrationRewriteFiles(string $root, string $backupRoot, array $map): int {
    $changed = 0;
    $targets = [];
    foreach (glob($root . '/data/*.json') ?: [] as $file) $targets[] = $file;
    foreach (['wiki/content', 'wiki/guide/seed'] as $dir) {
        $base = $root . '/' . $dir;
        if (!is_dir($base)) continue;
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($base, FilesystemIterator::SKIP_DOTS));
        foreach ($iterator as $item) if ($item->isFile() && strtolower($item->getExtension()) === 'json') $targets[] = $item->getPathname();
    }
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS));
    foreach ($iterator as $item) {
        if (!$item->isFile() || strtolower($item->getExtension()) !== 'html') continue;
        $path = str_replace('\\', '/', $item->getPathname());
        $relative = migrationNormalizePath(str_replace('\\', '/', substr($path, strlen($root) + 1)));
        if (!migrationShouldSkipRewritePath($relative)) $targets[] = $item->getPathname();
    }
    $targets = array_unique($targets);
    foreach ($targets as $file) {
        $text = (string)file_get_contents($file);
        $relative = migrationNormalizePath(str_replace('\\', '/', substr($file, strlen($root) + 1)));
        if (migrationShouldSkipRewritePath($relative)) continue;
        $next = $text;
        $replacements = 0;
        if (strtolower(pathinfo($file, PATHINFO_EXTENSION)) === 'json') {
            $decoded = json_decode($text, true);
            if (json_last_error() === JSON_ERROR_NONE && is_array($decoded)) {
                $rewritten = migrationRewriteJsonValue($decoded, $map, $replacements);
                $next = json_encode($rewritten, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
                if ($next === false) $next = $text;
            } else {
                [$next, $replacements] = migrationReplaceText($text, $map);
            }
        } else {
            [$next, $replacements] = migrationReplaceText($text, $map);
        }
        if ($replacements <= 0 || $next === $text) continue;
        migrationBackupFile($root, $backupRoot, $relative);
        file_put_contents($file, $next, LOCK_EX);
        $changed += $replacements;
        echo "rewrote {$relative}: {$replacements}\n";
    }
    return $changed;
}

function migrationRewritePublicationPreviewMetadata(string $root, string $backupRoot, array $map): int {
    $file = $root . '/data/publication_previews.json';
    if (!is_file($file)) return 0;
    $data = migrationReadJson($file, ['previews' => []]);
    $changed = 0;
    foreach ($data['previews'] as &$preview) {
        $count = (int)($preview['page_count'] ?? 0);
        if ($count < 1) continue;
        $base = migrationNormalizePath((string)($preview['pages_base_path'] ?? ''));
        if ($base === '') continue;
        $pageUrls = is_array($preview['page_urls'] ?? null) ? $preview['page_urls'] : [];
        $localPaths = is_array($preview['page_local_paths'] ?? null) ? $preview['page_local_paths'] : [];
        for ($i = 1; $i <= $count; $i++) {
            $local = rtrim($base, '/') . '/' . $i . '.jpg';
            foreach (migrationAliases($local) as $alias) {
                $localMap = null;
                foreach ($map as $source => $remote) {
                    if (in_array($alias, migrationAliases($source), true)) {
                        $localMap = $remote;
                        break;
                    }
                }
                if ($localMap) {
                    if (($pageUrls[$i - 1] ?? '') !== $localMap) {
                        $pageUrls[$i - 1] = $localMap;
                        $changed++;
                    }
                    $localPaths[$i - 1] = $local;
                    break;
                }
            }
        }
        if ($pageUrls) {
            $preview['page_urls'] = $pageUrls;
            $preview['page_local_paths'] = $localPaths;
            if (!empty($pageUrls[0]) && ($preview['cover_path'] ?? '') !== $pageUrls[0]) {
                $preview['cover_path'] = $pageUrls[0];
                $changed++;
            }
        }
    }
    unset($preview);
    if ($changed > 0) {
        migrationBackupFile($root, $backupRoot, 'data/publication_previews.json');
        migrationSaveJson($file, $data);
    }
    return $changed;
}

function migrationRewriteDatabase(string $root, string $backupRoot, array $map): int {
    $config = $root . '/config.php';
    if (!is_file($config)) return 0;
    require_once $config;
    require_once $root . '/includes/db.php';
    $db = getDB();
    $isMysql = defined('DB_DRIVER') && DB_DRIVER === 'mysql';
    $tables = $isMysql ? $db->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN) : $db->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")->fetchAll(PDO::FETCH_COLUMN);
    $allowedColumns = ['avatar_url', 'image_url', 'cover_image', 'display_image', 'image_path', 'merchandise_items', 'option_images'];
    $changed = 0;
    $backup = [];
    foreach ($tables as $table) {
        $quotedTable = $isMysql ? '`' . str_replace('`', '``', $table) . '`' : '"' . str_replace('"', '""', $table) . '"';
        $columns = $isMysql
            ? $db->query('SHOW COLUMNS FROM ' . $quotedTable)->fetchAll(PDO::FETCH_ASSOC)
            : $db->query('PRAGMA table_info(' . $quotedTable . ')')->fetchAll(PDO::FETCH_ASSOC);
        $names = [];
        $primary = null;
        foreach ($columns as $column) {
            $name = (string)($column['Field'] ?? $column['name'] ?? '');
            if ($name !== '') $names[] = $name;
            if (($column['Key'] ?? '') === 'PRI' || (int)($column['pk'] ?? 0) === 1) $primary = $name;
        }
        $targets = array_values(array_intersect($allowedColumns, $names));
        if (!$primary || !$targets) continue;
        $select = implode(', ', array_map(static fn($name) => $isMysql ? '`' . str_replace('`', '``', $name) . '`' : '"' . str_replace('"', '""', $name) . '"', array_merge([$primary], $targets)));
        foreach ($db->query('SELECT ' . $select . ' FROM ' . $quotedTable)->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $sets = [];
            $params = [];
            $before = [];
            foreach ($targets as $column) {
                [$next, $replacements] = migrationReplaceText((string)($row[$column] ?? ''), $map);
                if ($replacements > 0 && $next !== (string)($row[$column] ?? '')) {
                    $before[$column] = $row[$column];
                    $sets[] = ($isMysql ? '`' . str_replace('`', '``', $column) . '`' : '"' . str_replace('"', '""', $column) . '"') . ' = ?';
                    $params[] = $next;
                    $changed += $replacements;
                }
            }
            if (!$sets) continue;
            $backup[] = ['table' => $table, 'id_column' => $primary, 'id' => $row[$primary], 'values' => $before];
            $where = $isMysql ? '`' . str_replace('`', '``', $primary) . '`' : '"' . str_replace('"', '""', $primary) . '"';
            $stmt = $db->prepare('UPDATE ' . $quotedTable . ' SET ' . implode(', ', $sets) . ' WHERE ' . $where . ' = ?');
            $params[] = $row[$primary];
            $stmt->execute($params);
        }
    }
    if ($backup) migrationSaveJson($backupRoot . '/database-before-rewrite.json', $backup);
    return $changed;
}

$dryRun = migrationBool('dry-run');
$rewrite = migrationBool('rewrite');
$verify = migrationBool('verify');
$includePublications = migrationBool('include-publications');
$limit = max(0, (int)(migrationArg('limit', '0') ?? 0));
$manifest = migrationManifest($manifestFile);
$files = migrationCollectFiles($root, $includePublications);

echo 'public image files discovered: ' . count($files) . "\n";
if ($dryRun) {
    foreach ($files as $relative => $file) echo $relative . "\t" . $file['size'] . "\t" . $file['mime'] . "\n";
    exit(0);
}

if ($verify) {
    $checked = 0;
    $failed = 0;
    foreach ($manifest['entries'] as $relative => $entry) {
        if (($entry['status'] ?? '') !== 'uploaded') continue;
        $checked++;
        $curl = curl_init((string)$entry['url']);
        curl_setopt_array($curl, [CURLOPT_NOBODY => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => 30]);
        curl_exec($curl);
        $code = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
        $mime = strtolower((string)curl_getinfo($curl, CURLINFO_CONTENT_TYPE));
        curl_close($curl);
        $ok = $code >= 200 && $code < 400 && str_starts_with($mime, 'image/');
        $manifest['entries'][$relative]['verified_at'] = date('c');
        $manifest['entries'][$relative]['verify_status'] = $ok ? 'ok' : 'failed';
        if (!$ok) $failed++;
    }
    migrationSaveJson($manifestFile, $manifest);
    echo "remote URLs checked: {$checked}, failed: {$failed}\n";
    exit($failed ? 1 : 0);
}

if (!imageHostEnabled()) {
    fwrite(STDERR, "PICUI_ENABLED and PICUI_TOKEN must be configured for upload/rewrite. Use --dry-run for an inventory.\n");
    exit(2);
}

$uploaded = 0;
$seenHashes = [];
foreach ($files as $relative => $file) {
    $hash = imageHostHash($file['path']);
    $existing = $manifest['entries'][$relative] ?? null;
    if (($existing['sha256'] ?? '') === $hash && ($existing['status'] ?? '') === 'uploaded' && imageHostIsTrustedUrl((string)($existing['url'] ?? ''))) {
        $seenHashes[$hash] = $existing['url'];
        continue;
    }
    if (isset($seenHashes[$hash])) {
        $manifest['entries'][$relative] = ['sha256' => $hash, 'size' => $file['size'], 'url' => $seenHashes[$hash], 'status' => 'uploaded', 'deduplicated' => true, 'updated_at' => date('c')];
        continue;
    }
    $remote = imageHostRemoteUpload($file['path'], basename($relative), $file['mime'], 'migration');
    if ($remote['ok']) {
        $seenHashes[$hash] = $remote['url'];
        $manifest['entries'][$relative] = ['sha256' => $hash, 'size' => $file['size'], 'url' => $remote['url'], 'remote_key' => $remote['remote_key'] ?? '', 'status' => 'uploaded', 'updated_at' => date('c')];
        $uploaded++;
        echo "uploaded {$relative}\n";
    } else {
        $manifest['entries'][$relative] = ['sha256' => $hash, 'size' => $file['size'], 'status' => 'failed', 'error' => $remote['error'] ?? 'upload failed', 'updated_at' => date('c')];
        fwrite(STDERR, "FAILED {$relative}: " . ($remote['error'] ?? 'upload failed') . "\n");
    }
    migrationSaveJson($manifestFile, $manifest);
    if (($remote['rate_limited'] ?? false) === true) {
        fwrite(STDERR, "STOPPED: picui rate limit reached; resume after the provider window resets.\n");
        break;
    }
    if ($limit > 0 && $uploaded >= $limit) break;
}

echo "uploaded this run: {$uploaded}\n";
if ($rewrite) {
    $map = migrationRemoteMap($manifest, $includePublications);
    $stamp = date('YmdHis');
    $backupDir = $backupRoot . '/' . $stamp;
    $previewRewrites = $includePublications ? migrationRewritePublicationPreviewMetadata($root, $backupDir, $map) : 0;
    $fileRewrites = migrationRewriteFiles($root, $backupDir, $map);
    $dbRewrites = migrationRewriteDatabase($root, $backupDir, $map);
    echo "reference replacements: previews={$previewRewrites}, files={$fileRewrites}, database={$dbRewrites}\n";
}
