<?php
// api/galonly.php - GalOnly 同好会出展申请 API
// 动作: list_events, check_eligibility, submit, get_application, update_application, upload_image, list_applications, vote
//
// 2026-08 北京 GalOnly 2.0 两阶段参展更新备注：
//   - 阶段一（资质审核）：联系方式拆分收集 QQ 号(qq_number) 与手机号(phone_number)；
//     新增参展经历(exhibition_experience, JSON {"has":0|1,"detail":"..."})；
//     摊位呈现形式改为 A/B/C/D 四选一（sell_only/activity_only/both_sell/both_activity）；
//     参展展示图(display_image)移至阶段二提交。
//   - 阶段二（制品审核）：接收参展展示图；每个制品条目支持多张图片（images 数组，上限 6 张）。
//   - 上海等旧活动不受影响（仍使用 contact 字段与旧摊位类型校验）。

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

set_exception_handler(function (Throwable $e): void {
    error_log('[galonly.php] ' . get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine() . ' action=' . ($_GET['action'] ?? ''));
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json');
    }
    echo json_encode([
        'success' => false,
        'message' => '服务器处理失败：' . $e->getMessage(),
        'error' => '服务器处理失败：' . $e->getMessage(),
    ], JSON_UNESCAPED_UNICODE);
    exit();
});

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/audit.php';

$action = $_GET['action'] ?? '';

/**
 * 解码 galonly_applications 表中的 image_path 字段为数组
 * 兼容旧数据（单路径字符串）和新数据（JSON 数组字符串）
 */
function decodeImagePaths($row): array {
    if (!$row || empty($row['image_path'])) {
        return [];
    }
    $decoded = json_decode($row['image_path'], true);
    return is_array($decoded) ? $decoded : [trim($row['image_path'])];
}

function galonlyPosterThumbnailPath(?string $relativePath): ?string {
    $relativePath = str_replace('\\', '/', trim((string)$relativePath));
    if ($relativePath === '' || !preg_match('#^uploads/galonly/(\d+)/([^/]+)$#', $relativePath, $matches)) {
        return null;
    }

    $stem = pathinfo($matches[2], PATHINFO_FILENAME);
    $thumbnail = 'uploads/galonly/' . $matches[1] . '/thumbs/' . $stem . '.webp';
    return is_file(__DIR__ . '/../' . $thumbnail) ? $thumbnail : null;
}

/**
 * 由原图生成 WebP 缩略图（最长边 480px，质量 82）。
 * 2026-08 性能修复：预览/列表一律使用缩略图，避免浏览器主线程解码 10MB 原图导致交互卡顿；
 * 原图始终保留，前端提供「查看/下载原图」入口。
 * 超大图（任一边 > 6000px）或 GD 不可用时跳过生成（前端回退原图）。
 */
function galonlyMakeThumbnail(string $srcPath, string $thumbPath): bool {
    if (!function_exists('imagecreatefromwebp') || !function_exists('imagewebp')) return false;
    $info = @getimagesize($srcPath);
    if (!$info) return false;
    $srcW = (int)$info[0];
    $srcH = (int)$info[1];
    if ($srcW <= 0 || $srcH <= 0 || max($srcW, $srcH) > 6000) return false;

    $createMap = [
        'image/png' => 'imagecreatefrompng',
        'image/jpeg' => 'imagecreatefromjpeg',
        'image/webp' => 'imagecreatefromwebp',
    ];
    $creator = $createMap[$info['mime'] ?? ''] ?? null;
    if ($creator === null || !function_exists($creator)) return false;

    $src = @$creator($srcPath);
    if (!$src) return false;

    $maxEdge = 480;
    if ($srcW <= $maxEdge && $srcH <= $maxEdge) {
        $dstW = $srcW;
        $dstH = $srcH;
    } else {
        $scale = min($maxEdge / $srcW, $maxEdge / $srcH);
        $dstW = max(1, (int)round($srcW * $scale));
        $dstH = max(1, (int)round($srcH * $scale));
    }

    $dst = imagecreatetruecolor($dstW, $dstH);
    if (!$dst) { imagedestroy($src); return false; }
    imagealphablending($dst, false);
    imagesavealpha($dst, true);
    imagecopyresampled($dst, $src, 0, 0, 0, 0, $dstW, $dstH, $srcW, $srcH);

    $dir = dirname($thumbPath);
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    $ok = @imagewebp($dst, $thumbPath, 82);
    imagedestroy($src);
    imagedestroy($dst);
    return $ok;
}

function galonlyIsMysql(): bool {
    return defined('DB_DRIVER') && DB_DRIVER === 'mysql';
}

function galonlyTryExec(PDO $db, string $sql): void {
    try {
        $db->exec($sql);
    } catch (Exception $e) {
        // Runtime schema guards are best-effort so older deployments keep serving JSON.
    }
}

function galonlyColumnExists(PDO $db, string $table, string $column): bool {
    try {
        if (galonlyIsMysql()) {
            $stmt = $db->query("SHOW COLUMNS FROM `$table` LIKE " . $db->quote($column));
            return (bool)$stmt->fetch();
        }
        $stmt = $db->query("PRAGMA table_info($table)");
        $cols = $stmt->fetchAll(PDO::FETCH_COLUMN, 1);
        return in_array($column, $cols, true);
    } catch (Exception $e) {
        return false;
    }
}

function galonlyEnsureColumn(PDO $db, string $table, string $column, string $definition): void {
    if (galonlyColumnExists($db, $table, $column)) return;
    galonlyTryExec($db, "ALTER TABLE `$table` ADD COLUMN `$column` $definition");
}

function galonlyEnsureStaffApplicationColumns(PDO $db): void {
    if (galonlyIsMysql()) {
        $columns = [
            'event_id' => 'INT NOT NULL DEFAULT 0',
            'user_id' => 'INT NOT NULL DEFAULT 0',
            'cn_name' => "VARCHAR(255) NOT NULL DEFAULT ''",
            'qq_number' => "VARCHAR(32) NOT NULL DEFAULT ''",
            'phone_number' => "VARCHAR(32) NOT NULL DEFAULT ''",
            'email' => "VARCHAR(255) NOT NULL DEFAULT ''",
            'club_id' => 'INT NOT NULL DEFAULT 0',
            'club_country' => "VARCHAR(50) NOT NULL DEFAULT 'china'",
            'positions' => 'TEXT NULL',
            'confirm_schedule' => 'TINYINT(1) NOT NULL DEFAULT 0',
            'is_cosplay' => 'TINYINT(1) NOT NULL DEFAULT 0',
            'three_day_available' => 'TINYINT(1) NOT NULL DEFAULT 0',
            'self_intro' => 'TEXT NULL',
            'gender' => "VARCHAR(20) NOT NULL DEFAULT ''",
            'staff_experience' => 'TINYINT(1) NOT NULL DEFAULT 0',
            'skills' => 'TEXT NULL',
            'status' => "VARCHAR(20) NOT NULL DEFAULT 'pending'",
            'voted_by' => 'INT DEFAULT NULL',
            'vote' => 'VARCHAR(20) DEFAULT NULL',
            'resubmitted' => 'TINYINT(1) NOT NULL DEFAULT 0',
            'has_update' => 'TINYINT(1) NOT NULL DEFAULT 0',
            'created_at' => 'DATETIME NULL',
            'updated_at' => 'DATETIME NULL',
        ];
    } else {
        $columns = [
            'event_id' => 'INTEGER NOT NULL DEFAULT 0',
            'user_id' => 'INTEGER NOT NULL DEFAULT 0',
            'cn_name' => "TEXT NOT NULL DEFAULT ''",
            'qq_number' => "TEXT NOT NULL DEFAULT ''",
            'phone_number' => "TEXT NOT NULL DEFAULT ''",
            'email' => "TEXT NOT NULL DEFAULT ''",
            'club_id' => 'INTEGER NOT NULL DEFAULT 0',
            'club_country' => "TEXT NOT NULL DEFAULT 'china'",
            'positions' => "TEXT NOT NULL DEFAULT '[]'",
            'confirm_schedule' => 'INTEGER NOT NULL DEFAULT 0',
            'is_cosplay' => 'INTEGER NOT NULL DEFAULT 0',
            'three_day_available' => 'INTEGER NOT NULL DEFAULT 0',
            'self_intro' => 'TEXT',
            'gender' => "TEXT NOT NULL DEFAULT ''",
            'staff_experience' => 'INTEGER NOT NULL DEFAULT 0',
            'skills' => 'TEXT',
            'status' => "TEXT NOT NULL DEFAULT 'pending'",
            'voted_by' => 'INTEGER DEFAULT NULL',
            'vote' => 'TEXT DEFAULT NULL',
            'resubmitted' => 'INTEGER NOT NULL DEFAULT 0',
            'has_update' => 'INTEGER NOT NULL DEFAULT 0',
            'created_at' => 'TEXT',
            'updated_at' => 'TEXT',
        ];
    }

    foreach ($columns as $column => $definition) {
        galonlyEnsureColumn($db, 'galonly_staff_applications', $column, $definition);
    }
}

function galonlyEnsureStaffSchema(PDO $db): void {
    if (galonlyIsMysql()) {
        $db->exec("
            CREATE TABLE IF NOT EXISTS galonly_staff_applications (
                id INT AUTO_INCREMENT PRIMARY KEY,
                event_id INT NOT NULL,
                user_id INT NOT NULL,
                cn_name VARCHAR(255) NOT NULL DEFAULT '',
                qq_number VARCHAR(32) NOT NULL DEFAULT '',
                phone_number VARCHAR(32) NOT NULL DEFAULT '',
                email VARCHAR(255) NOT NULL DEFAULT '',
                club_id INT NOT NULL DEFAULT 0,
                club_country VARCHAR(50) NOT NULL DEFAULT 'china',
                positions TEXT NOT NULL,
                confirm_schedule TINYINT(1) NOT NULL DEFAULT 0,
                is_cosplay TINYINT(1) NOT NULL DEFAULT 0,
                three_day_available TINYINT(1) NOT NULL DEFAULT 0,
                self_intro TEXT,
                gender VARCHAR(20) NOT NULL DEFAULT '',
                staff_experience TINYINT(1) NOT NULL DEFAULT 0,
                skills TEXT,
                status VARCHAR(20) NOT NULL DEFAULT 'pending',
                voted_by INT DEFAULT NULL,
                vote VARCHAR(20) DEFAULT NULL,
                resubmitted TINYINT(1) NOT NULL DEFAULT 0,
                has_update TINYINT(1) NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
        galonlyEnsureColumn($db, 'galonly_events', 'staff_deadline', 'DATETIME NULL');
        galonlyEnsureColumn($db, 'galonly_events', 'staff_max_applicants', 'INT DEFAULT NULL');
        galonlyEnsureColumn($db, 'galonly_events', 'staff_required_count', 'INT NOT NULL DEFAULT 0');
        galonlyEnsureColumn($db, 'galonly_events', 'staff_registration_open', 'TINYINT(1) NOT NULL DEFAULT 1');
        galonlyEnsureColumn($db, 'galonly_events', 'staff_roster_finalized', 'TINYINT(1) NOT NULL DEFAULT 0');
        galonlyEnsureColumn($db, 'galonly_events', 'staff_only', 'TINYINT(1) NOT NULL DEFAULT 0');
        galonlyEnsureColumn($db, 'galonly_events', 'event_code', "VARCHAR(32) NOT NULL DEFAULT ''");
    } else {
        $db->exec("
            CREATE TABLE IF NOT EXISTS galonly_staff_applications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id INTEGER NOT NULL REFERENCES galonly_events(id),
                user_id INTEGER NOT NULL REFERENCES users(id),
                cn_name TEXT NOT NULL DEFAULT '',
                qq_number TEXT NOT NULL DEFAULT '',
                phone_number TEXT NOT NULL DEFAULT '',
                email TEXT NOT NULL DEFAULT '',
                club_id INTEGER NOT NULL DEFAULT 0,
                club_country TEXT NOT NULL DEFAULT 'china',
                positions TEXT NOT NULL DEFAULT '[]',
                confirm_schedule INTEGER NOT NULL DEFAULT 0,
                is_cosplay INTEGER NOT NULL DEFAULT 0,
                three_day_available INTEGER NOT NULL DEFAULT 0,
                self_intro TEXT,
                gender TEXT NOT NULL DEFAULT '',
                staff_experience INTEGER NOT NULL DEFAULT 0,
                skills TEXT,
                status TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','pooled','rejected','confirmed')),
                voted_by INTEGER DEFAULT NULL,
                vote TEXT DEFAULT NULL,
                resubmitted INTEGER NOT NULL DEFAULT 0,
                has_update INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        ");
        galonlyEnsureColumn($db, 'galonly_events', 'event_code', "TEXT NOT NULL DEFAULT ''");
        galonlyTryExec($db, "CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_app_active ON galonly_staff_applications(event_id, user_id) WHERE status IN ('pending','pooled')");
    }

    galonlyEnsureStaffApplicationColumns($db);
    if (galonlyIsMysql()) {
        galonlyEnsureColumn($db, 'galonly_events', 'staff_deadline', 'DATETIME NULL');
        galonlyEnsureColumn($db, 'galonly_events', 'staff_max_applicants', 'INT DEFAULT NULL');
        galonlyEnsureColumn($db, 'galonly_events', 'staff_required_count', 'INT NOT NULL DEFAULT 0');
        galonlyEnsureColumn($db, 'galonly_events', 'staff_registration_open', 'TINYINT(1) NOT NULL DEFAULT 1');
        galonlyEnsureColumn($db, 'galonly_events', 'staff_roster_finalized', 'TINYINT(1) NOT NULL DEFAULT 0');
        galonlyEnsureColumn($db, 'galonly_events', 'staff_only', 'TINYINT(1) NOT NULL DEFAULT 0');
        galonlyEnsureColumn($db, 'galonly_events', 'event_code', "VARCHAR(32) NOT NULL DEFAULT ''");
    } else {
        galonlyEnsureColumn($db, 'galonly_events', 'staff_deadline', 'TEXT DEFAULT NULL');
        galonlyEnsureColumn($db, 'galonly_events', 'staff_max_applicants', 'INTEGER DEFAULT NULL');
        galonlyEnsureColumn($db, 'galonly_events', 'staff_required_count', 'INTEGER NOT NULL DEFAULT 0');
        galonlyEnsureColumn($db, 'galonly_events', 'staff_registration_open', 'INTEGER NOT NULL DEFAULT 1');
        galonlyEnsureColumn($db, 'galonly_events', 'staff_roster_finalized', 'INTEGER NOT NULL DEFAULT 0');
        galonlyEnsureColumn($db, 'galonly_events', 'staff_only', 'INTEGER NOT NULL DEFAULT 0');
        galonlyEnsureColumn($db, 'galonly_events', 'event_code', "TEXT NOT NULL DEFAULT ''");
    }
    galonlyTryExec($db, "CREATE INDEX idx_staff_app_event ON galonly_staff_applications(event_id)");
    galonlyTryExec($db, "CREATE INDEX idx_staff_app_user ON galonly_staff_applications(user_id)");
    galonlyTryExec($db, "CREATE INDEX idx_staff_app_status ON galonly_staff_applications(status)");
    // MySQL 与 SQLite 的局部唯一索引对齐：同一活动同一用户只允许一条 pending/pooled
    if (galonlyIsMysql()) {
        galonlyEnsureColumn($db, 'galonly_staff_applications', 'active_key', "VARCHAR(64) GENERATED ALWAYS AS (CASE WHEN status IN ('pending','pooled') THEN CONCAT(event_id, ':', user_id) ELSE NULL END) STORED");
        galonlyTryExec($db, "CREATE UNIQUE INDEX idx_staff_app_active ON galonly_staff_applications(active_key)");
    }
}

/**
 * 摊位呈现形式（北京 GalOnly 2.0 起，四选一）：
 * A 只贩售同人制品 / B 只进行活动 / C 二者均有贩售为主 / D 二者均有活动为主
 */
function galonlyBoothTypes(): array {
    return ['sell_only', 'activity_only', 'both_sell', 'both_activity'];
}

function galonlyBoothTypeLabel(?string $type): string {
    $map = [
        // 北京 GalOnly 2.0 新值
        'sell_only' => 'A · 只贩售同人制品',
        'activity_only' => 'B · 只进行活动（卡牌、游戏试玩、展示等）',
        'both_sell' => 'C · 二者均有，贩售为主',
        'both_activity' => 'D · 二者均有，活动为主',
        // 旧值兜底（存量记录仍可读，不再作为可选项）
        'doujin' => '同人社团摊位',
        'used' => '中古摊位',
        'activity' => '活动摊位',
        'consignment' => '寄售摊位',
    ];
    return $map[$type] ?? '';
}

function galonlyActiveStatuses(): array {
    // 存在有效申请（不可重复提交）的状态集合
    return ['pending', 'approved', 'phase2_pending', 'phase2_revision', 'confirmed', 'shared'];
}

function galonlyEnsureBoothSchema(PDO $db): void {
    // galonly_applications 两阶段审核 / 摊位信息新列
    // 2026-08 北京 GalOnly 2.0：联系方式拆分 QQ+手机号、新增参展经历；
    // 参展展示图(display_image)自阶段一移至阶段二制品表单
    $columns = [
        'booth_name' => galonlyIsMysql() ? "VARCHAR(255) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''",
        'display_image' => galonlyIsMysql() ? 'VARCHAR(500) DEFAULT NULL' : 'TEXT DEFAULT NULL',
        'resubmitted' => galonlyIsMysql() ? 'TINYINT(1) NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0',
        'has_update' => galonlyIsMysql() ? 'TINYINT(1) NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0',
        'booth_type' => galonlyIsMysql() ? "VARCHAR(50) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''",
        'expected_members' => galonlyIsMysql() ? 'INT NOT NULL DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0',
        'layout_notes' => 'TEXT NULL',
        'needs_power' => galonlyIsMysql() ? "VARCHAR(10) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''",
        'qq_number' => galonlyIsMysql() ? "VARCHAR(64) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''",
        'phone_number' => galonlyIsMysql() ? "VARCHAR(32) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''",
        'exhibition_experience' => 'TEXT NULL',
        'attachment_paths' => 'TEXT NULL',
        'phase' => galonlyIsMysql() ? 'TINYINT(1) NOT NULL DEFAULT 1' : 'INTEGER NOT NULL DEFAULT 1',
        'rejected_at' => galonlyIsMysql() ? 'DATETIME NULL' : 'TEXT NULL',
        'revision_at' => galonlyIsMysql() ? 'DATETIME NULL' : 'TEXT NULL',
        'phase1_feedback' => 'TEXT NULL',
        'phase2_feedback' => 'TEXT NULL',
        'merchandise_items' => 'TEXT NULL',
        'merchandise_attachments' => 'TEXT NULL',
    ];
    foreach ($columns as $column => $definition) {
        galonlyEnsureColumn($db, 'galonly_applications', $column, $definition);
    }

    // galonly_votes 审核意见与阶段
    galonlyEnsureColumn($db, 'galonly_votes', 'comment', 'TEXT NULL');
    galonlyEnsureColumn($db, 'galonly_votes', 'phase', galonlyIsMysql() ? 'TINYINT(1) NOT NULL DEFAULT 1' : 'INTEGER NOT NULL DEFAULT 1');
    // 2026-08 陪审分阶段审核：唯一约束需包含 phase（旧库为 (application_id, auditer_id)，
    // 否则同一陪审无法在两个阶段分别发表意见）；MySQL 幂等重建，失败不阻断
    if (galonlyIsMysql()) {
        galonlyTryExec($db, "ALTER TABLE galonly_votes DROP INDEX application_id");
        galonlyTryExec($db, "ALTER TABLE galonly_votes ADD UNIQUE KEY uk_galonly_votes_app_phase (application_id, auditer_id, phase)");
    }

    // 总审 / 陪审名单（event_id = 0 表示全局）
    if (galonlyIsMysql()) {
        $db->exec("
            CREATE TABLE IF NOT EXISTS galonly_reviewers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                event_id INT NOT NULL DEFAULT 0,
                user_id INT NOT NULL,
                role VARCHAR(10) NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uk_galonly_reviewer (event_id, user_id),
                FOREIGN KEY (user_id) REFERENCES users(id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
        galonlyTryExec($db, "CREATE INDEX idx_galonly_reviewers_role ON galonly_reviewers(role)");
    } else {
        $db->exec("
            CREATE TABLE IF NOT EXISTS galonly_reviewers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id INTEGER NOT NULL DEFAULT 0,
                user_id INTEGER NOT NULL REFERENCES users(id),
                role TEXT NOT NULL CHECK(role IN ('chief','jury')),
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(event_id, user_id)
            )
        ");
        galonlyTryExec($db, "CREATE INDEX IF NOT EXISTS idx_galonly_reviewers_role ON galonly_reviewers(role)");
    }
}

function galonlyReviewerRole(PDO $db, int $eventId, array $user): ?string {
    if (($user['role'] ?? '') === 'super_admin') return 'chief';
    try {
        $stmt = $db->prepare("SELECT role FROM galonly_reviewers WHERE user_id = ? AND (event_id = 0 OR event_id = ?) ORDER BY event_id DESC LIMIT 1");
        $stmt->execute([(int)$user['id'], $eventId]);
        $role = $stmt->fetchColumn();
        return $role ? (string)$role : null;
    } catch (Exception $e) {
        return null;
    }
}

function galonlyCanReview(PDO $db, int $eventId, array $user): bool {
    if (hasAuditPermission($user)) return true;
    return galonlyReviewerRole($db, $eventId, $user) !== null;
}

/**
 * 判断活动是否走北京两阶段审核流程。
 * 北京（event_code = 'beijing'）→ 两阶段（资质 + 制品）；上海等其他活动 → 原简单投票审核（无阶段）。
 */
function galonlyEventIsBeijing(PDO $db, int $eventId): bool {
    try {
        $stmt = $db->prepare("SELECT event_code FROM galonly_events WHERE id = ?");
        $stmt->execute([$eventId]);
        return strtolower((string)($stmt->fetchColumn() ?: '')) === 'beijing';
    } catch (Exception $e) {
        return false;
    }
}

/**
 * 解码附件路径字段（兼容 JSON 数组与单路径字符串）
 */
function galonlyDecodeJsonList($value): array {
    if (is_array($value)) {
        return array_values(array_filter($value, function ($item) {
            // 结构化条目（如制品对象）原样保留；字符串条目去除空值
            return is_array($item) ? true : trim((string)$item) !== '';
        }));
    }
    if (is_string($value) && trim($value) !== '') {
        $decoded = json_decode($value, true);
        if (is_array($decoded)) return galonlyDecodeJsonList($decoded);
        return [trim($value)];
    }
    return [];
}

/**
 * 规范化参展经历字段为 JSON 字符串 {"has":0|1,"detail":"..."}
 * 兼容旧数据：非 JSON 的原始文本视为「有参展经历」并把文本作为说明
 */
function galonlyNormalizeExhibitionExperience($raw): string {
    $text = trim((string)$raw);
    if ($text === '') {
        return json_encode(['has' => 0, 'detail' => ''], JSON_UNESCAPED_UNICODE);
    }
    $decoded = json_decode($text, true);
    if (is_array($decoded)) {
        $has = (int)($decoded['has'] ?? 0) ? 1 : 0;
        $detail = trim((string)($decoded['detail'] ?? ''));
    } else {
        $has = 1;
        $detail = $text;
    }
    return json_encode(['has' => $has, 'detail' => $detail], JSON_UNESCAPED_UNICODE);
}

/**
 * 解码参展经历字段为数组 ['has' => 0|1, 'detail' => '...']
 */
function galonlyDecodeExhibitionExperience($raw): array {
    if (is_array($raw)) {
        return [
            'has' => (int)($raw['has'] ?? 0) ? 1 : 0,
            'detail' => trim((string)($raw['detail'] ?? '')),
        ];
    }
    $decoded = json_decode((string)$raw, true);
    if (is_array($decoded)) {
        return [
            'has' => (int)($decoded['has'] ?? 0) ? 1 : 0,
            'detail' => trim((string)($decoded['detail'] ?? '')),
        ];
    }
    $text = trim((string)$raw);
    return $text === '' ? ['has' => 0, 'detail' => ''] : ['has' => 1, 'detail' => $text];
}

/**
 * 判断驳回/打回是否仍在 3 天修改期内
 */
function galonlyWithinDeadline(?string $markedAt): bool {
    if (empty($markedAt)) return true;
    $ts = strtotime((string)$markedAt);
    if (!$ts) return true;
    return (time() - $ts) <= 259200; // 72 小时
}

function galonlyBoothStatusMeta(string $status): array {
    $map = [
        'pending' => ['阶段一 · 资质审核中', '资质审核'],
        'approved' => ['阶段一通过 · 预选资格已锁定', '预选通过'],
        'rejected' => ['已驳回', '已驳回'],
        'phase2_pending' => ['阶段二 · 制品审核中', '制品审核中'],
        'phase2_revision' => ['阶段二 · 打回修改', '打回修改'],
        'confirmed' => ['正式摊主', '正式摊主'],
        'shared' => ['拼摊（保留摊主身份）', '拼摊'],
    ];
    return $map[$status] ?? [$status, $status];
}

function galonlyNotifyBoothApplicant(array $application, string $status, ?array $event = null, string $extra = ''): bool {
    $userId = (int)($application['user_id'] ?? 0);
    $applicationId = (int)($application['id'] ?? 0);
    if ($userId <= 0 || $applicationId <= 0) return false;

    $eventName = (string)($event['name'] ?? $application['event_name'] ?? 'GalOnly 活动');
    $boothName = (string)($application['booth_name'] ?? '');
    $boothText = $boothName !== '' ? '摊位「' . $boothName . '」' : '摊位申请';
    $link = 'Galgame_events/Galonly_status.html?event_id=' . (int)($application['event_id'] ?? 0);

    $phase = (int)($application['phase'] ?? 1);
    if ($status === 'rejected') {
        if ($phase === 2) {
            $type = 'galonly_phase2_rejected';
            $title = '制品审核未通过';
            $message = '你在「' . $eventName . '」的' . $boothText . '未通过制品审核：' . $extra . '。不合规制品本次不得放入菜单，不能参展；若多数制品仍不合规，将取消摊位参展资格。';
        } else {
            $type = 'galonly_phase1_rejected';
            $title = '摊位申请未通过第一阶段';
            $message = '你在「' . $eventName . '」的' . $boothText . '未通过第一阶段审核：' . $extra . '。可在驳回当天起三天内修改并重新提交。';
        }
        require_once __DIR__ . '/../includes/notifications.php';
        return createNotification($userId, $type, $title, $message, $link, 'galonly_application', $applicationId);
    }

    $map = [
        'approved' => [
            'type' => 'galonly_phase1_passed',
            'title' => '摊位申请通过第一阶段',
            'message' => '恭喜！你在「' . $eventName . '」的' . $boothText . '已通过第一阶段审核，预选资格已锁定。请提交制品审核表单进入第二阶段。',
        ],
        'phase2_pending' => [
            'type' => 'galonly_phase2_submitted',
            'title' => '制品表单已提交',
            'message' => '你在「' . $eventName . '」的制品审核表单已提交，正在审核中，请耐心等待。',
        ],
        'confirmed' => [
            'type' => 'galonly_phase2_passed',
            'title' => '你已成为正式摊主！',
            'message' => '恭喜！你在「' . $eventName . '」的' . $boothText . '已通过制品审核，成为本届活动正式摊主！请耐心等待摊位位置的分配。',
        ],
        'phase2_revision' => [
            'type' => 'galonly_phase2_revision',
            'title' => '制品审核打回修改',
            'message' => '你在「' . $eventName . '」的部分制品不合规，但资格保留：' . $extra . '。可在打回当天起三天内修改并重新提交。',
        ],
        'shared' => [
            'type' => 'galonly_shared',
            'title' => '制品过少，推荐拼摊',
            'message' => '你在「' . $eventName . '」提交的制品过少。因摊位数量有限，将保留你的摊主身份，并推荐你与其他摊位拼摊：' . $extra,
        ],
    ];
    if (!isset($map[$status])) return false;

    require_once __DIR__ . '/../includes/notifications.php';
    return createNotification(
        $userId,
        $map[$status]['type'],
        $map[$status]['title'],
        $map[$status]['message'],
        $link,
        'galonly_application',
        $applicationId
    );
}

function galonlyStaffPositions(): array {
    return [
        '检票发票 (布展日)', '检票发票 (开展日)', '场馆搭建搬货 (布展日)', '搭建协助 (开展日)',
        '物料发放 (游客)', '物料发放 (摊主)', '食品发放与看管', '巡场 (安保/应急)',
        '巡场检查 (内容合规)', '舞台管理', '问询处', '痛车区域管理', '交通指引',
        'VIP室服务', '活动摊位负责人员', '副屏控制', '场务', '签到', '摄影', '机动', '其他',
        '运营组', '摊位组', '活动组', '现场组', '后勤组',
    ];
}

function galonlyJsonArray($value): array {
    if (is_array($value)) return array_values(array_filter(array_map('trim', $value), fn($item) => $item !== ''));
    if (is_string($value) && trim($value) !== '') {
        $decoded = json_decode($value, true);
        if (is_array($decoded)) return galonlyJsonArray($decoded);
        return array_values(array_filter(array_map('trim', explode(',', $value)), fn($item) => $item !== ''));
    }
    return [];
}

function galonlyDecodeStaffRow(array $row): array {
    $row['positions'] = galonlyJsonArray($row['positions'] ?? []);
    $row['clubs'] = [];
    if (!empty($row['club_id'])) {
        $row['clubs'][] = [
            'club_id' => (int)$row['club_id'],
            'club_country' => $row['club_country'] ?? 'china',
        ];
    }
    $row['confirm_schedule'] = (int)($row['confirm_schedule'] ?? 0);
    $row['is_cosplay'] = (int)($row['is_cosplay'] ?? 0);
    $row['three_day_available'] = (int)($row['three_day_available'] ?? 0);
    $row['gender'] = (string)($row['gender'] ?? '');
    $row['staff_experience'] = (int)($row['staff_experience'] ?? 0);
    $row['skills'] = (string)($row['skills'] ?? '');
    $row['email'] = (string)($row['email'] ?? '');
    $row['resubmitted'] = (int)($row['resubmitted'] ?? 0);
    $row['has_update'] = (int)($row['has_update'] ?? 0);
    return $row;
}

function galonlyStaffPayload(array $input): array {
    $positions = $input['positions'] ?? $input['applied_positions'] ?? null;
    if ($positions === null && isset($input['position'])) $positions = [$input['position']];
    $positions = galonlyJsonArray($positions);
    $allowed = galonlyStaffPositions();
    $positions = array_values(array_unique(array_filter($positions, fn($p) => in_array($p, $allowed, true))));
    $clubCountry = (string)($input['club_country'] ?? 'china');
    $clubCountry = in_array($clubCountry, ['china', 'japan', 'none'], true) ? $clubCountry : 'china';
    $clubId = (int)($input['club_id'] ?? 0);
    if ($clubCountry === 'none') $clubId = 0;
    $genderMap = ['男' => 'male', '女' => 'female', 'male' => 'male', 'female' => 'female', '保密' => 'secret', 'secret' => 'secret'];
    $gender = $genderMap[trim((string)($input['gender'] ?? ''))] ?? '';

    return [
        'event_id' => (int)($input['event_id'] ?? 0),
        'cn_name' => trim((string)($input['cn_name'] ?? $input['nickname'] ?? '')),
        'qq_number' => trim((string)($input['qq_number'] ?? $input['qq'] ?? '')),
        'phone_number' => trim((string)($input['phone_number'] ?? $input['phone'] ?? $input['contact'] ?? '')),
        'email' => trim((string)($input['email'] ?? '')),
        'club_id' => $clubId,
        'club_country' => $clubCountry,
        'positions' => $positions,
        'confirm_schedule' => (int)($input['confirm_schedule'] ?? 0) ? 1 : 0,
        'is_cosplay' => (int)($input['is_cosplay'] ?? 0) ? 1 : 0,
        'three_day_available' => (int)($input['three_day_available'] ?? 0) ? 1 : 0,
        'gender' => $gender,
        'staff_experience' => (int)($input['staff_experience'] ?? 0) ? 1 : 0,
        'skills' => trim((string)($input['skills'] ?? '')),
        'self_intro' => trim((string)($input['self_intro'] ?? '')),
    ];
}

function galonlyStaffValidate(array $payload): ?string {
    if (galonlyStaffIsIndividualApplicant($payload)) $payload['club_id'] = 1;
    if ($payload['event_id'] <= 0) return '缺少活动 ID';
    if ($payload['cn_name'] === '') return '请填写 CN（昵称）';
    if (!preg_match('/^\d{5,12}$/', $payload['qq_number'])) return 'QQ号应为5-12位数字';
    if (!preg_match('/^1\d{10}$/', $payload['phone_number'])) return '手机号应为11位，且以1开头';
    if ($payload['email'] !== '' && !filter_var($payload['email'], FILTER_VALIDATE_EMAIL)) return '请填写有效的邮箱地址';
    if ($payload['club_id'] <= 0) return '请选择所属高校社团';
    if (count($payload['positions']) === 0) return '请至少选择一个报名岗位';
    if (!$payload['confirm_schedule']) return '请确认服务时间';
    return null;
}

function galonlyStaffIsIndividualApplicant(array $payload): bool {
    return ($payload['club_country'] ?? '') === 'none' && (int)($payload['club_id'] ?? 0) === 0;
}

function galonlyStaffUserHasClub(PDO $db, int $userId, int $clubId, string $country): bool {
    try {
        $stmt = $db->prepare("
            SELECT id FROM club_memberships
            WHERE user_id = ?
              AND club_id = ?
              AND COALESCE(country, 'china') = ?
              AND status = 'active'
              AND COALESCE(role, '') <> 'external'
            LIMIT 1
        ");
        $stmt->execute([$userId, $clubId, $country]);
        return (bool)$stmt->fetch();
    } catch (Exception $e) {
        $stmt = $db->prepare("
            SELECT id FROM club_memberships
            WHERE user_id = ?
              AND club_id = ?
              AND status = 'active'
              AND COALESCE(role, '') <> 'external'
            LIMIT 1
        ");
        $stmt->execute([$userId, $clubId]);
        return (bool)$stmt->fetch();
    }
}

function galonlyStaffFail(string $message, int $status = 200): void {
    http_response_code($status);
    echo json_encode(['success' => false, 'message' => $message, 'error' => $message], JSON_UNESCAPED_UNICODE);
    exit();
}

function galonlyStaffEvent(PDO $db, int $eventId): ?array {
    $stmt = $db->prepare("SELECT * FROM galonly_events WHERE id = ?");
    $stmt->execute([$eventId]);
    $event = $stmt->fetch();
    return $event ?: null;
}

function galonlyStaffRegistrationClosedReason(PDO $db, array $event): ?string {
    if ((int)($event['staff_registration_open'] ?? 1) === 0) return 'Staff 报名已被管理员关闭';
    if (!empty($event['staff_deadline'])) {
        $deadline = strtotime((string)$event['staff_deadline']);
        if ($deadline && time() > $deadline) return 'Staff 报名已于 ' . $event['staff_deadline'] . ' 截止';
    }
    if (!empty($event['staff_max_applicants'])) {
        $stmt = $db->prepare("SELECT COUNT(*) FROM galonly_staff_applications WHERE event_id = ? AND status IN ('pending','pooled')");
        $stmt->execute([(int)$event['id']]);
        if ((int)$stmt->fetchColumn() >= (int)$event['staff_max_applicants']) return 'Staff 报名人数已满';
    }
    return null;
}

function galonlyNotifyStaffApplicant(array $application, string $status, ?array $event = null): bool {
    $userId = (int)($application['user_id'] ?? 0);
    $applicationId = (int)($application['id'] ?? 0);
    if ($userId <= 0 || $applicationId <= 0) return false;

    $eventName = (string)($event['name'] ?? $application['event_name'] ?? 'GalOnly 活动');
    $positions = galonlyJsonArray($application['positions'] ?? []);
    $positionText = count($positions) ? '，岗位：' . implode('、', $positions) : '';
    $link = 'Galgame_events/galgameonly_list.html';

    $map = [
        'pooled' => [
            'type' => 'galonly_staff_pooled',
            'title' => 'Staff 申请已进入候选池',
            'message' => '你报名的「' . $eventName . '」Staff 申请已通过初审，已进入候选池。最终名单确认后会再次通知。',
        ],
        'rejected' => [
            'type' => 'galonly_staff_rejected',
            'title' => 'Staff 申请未通过',
            'message' => '你报名的「' . $eventName . '」Staff 申请未通过本轮审核。如需修改信息，可返回活动页查看是否仍可重新提交。',
        ],
        'pending' => [
            'type' => 'galonly_staff_pending',
            'title' => 'Staff 审核状态已更新',
            'message' => '你报名的「' . $eventName . '」Staff 申请已退回待审核状态，审核组会重新处理。',
        ],
        'confirmed' => [
            'type' => 'galonly_staff_confirmed',
            'title' => '你已被确定为活动工作人员',
            'message' => '恭喜！你已被确认为「' . $eventName . '」的工作人员' . $positionText . '。',
        ],
        'unlocked' => [
            'type' => 'galonly_staff_roster_unlocked',
            'title' => 'Staff 名单已解锁调整',
            'message' => '「' . $eventName . '」工作人员名单已解锁，你的申请状态已回到候选池，请等待最终确认。',
        ],
    ];
    if (!isset($map[$status])) return false;

    require_once __DIR__ . '/../includes/notifications.php';
    return createNotification(
        $userId,
        $map[$status]['type'],
        $map[$status]['title'],
        $map[$status]['message'],
        $link,
        'galonly_staff_application',
        $applicationId
    );
}

// 摊位两阶段审核 schema 自动迁移（幂等；失败不阻断后续 action）
try {
    galonlyEnsureBoothSchema(getDB());
} catch (Exception $e) {
    // best-effort: action 内部仍有独立守卫
}

switch ($action) {
    case 'list_events':
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            echo json_encode(['success' => false, 'message' => '仅支持 GET 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();
        galonlyEnsureStaffSchema($db);
        $stmt = $db->query("SELECT * FROM galonly_events ORDER BY date DESC, id DESC");
        $events = $stmt->fetchAll();

        $staffCounts = [];
        try {
            $countRows = $db->query("SELECT event_id, COUNT(*) AS cnt FROM galonly_staff_applications WHERE status IN ('pending','pooled') GROUP BY event_id")->fetchAll();
            foreach ($countRows as $row) {
                $staffCounts[(int)$row['event_id']] = (int)$row['cnt'];
            }
        } catch (Exception $e) {
            $staffCounts = [];
        }

        // 如果用户已登录，查询其在每个活动的申请状态
        $currentUser = getCurrentUser();
        if ($currentUser) {
            $stmt = $db->prepare("SELECT id, event_id, status FROM galonly_applications WHERE user_id = ? ORDER BY updated_at ASC, id ASC");
            $stmt->execute([$currentUser['id']]);
            $userApps = $stmt->fetchAll();
            $appMap = [];
            $appIdMap = [];
            foreach ($userApps as $app) {
                $appMap[$app['event_id']] = $app['status'];
                $appIdMap[$app['event_id']] = $app['id'];
            }
            foreach ($events as &$event) {
                $event['user_application_status'] = $appMap[$event['id']] ?? null;
                $event['user_application_id'] = $appIdMap[$event['id']] ?? null;
                $event['staff_current_applicants'] = $staffCounts[(int)$event['id']] ?? 0;
                $event['user_review_role'] = galonlyReviewerRole($db, (int)$event['id'], $currentUser);
            }
            unset($event);

            $stmt = $db->prepare("SELECT id, event_id, status FROM galonly_staff_applications WHERE user_id = ? ORDER BY updated_at DESC, id DESC");
            $stmt->execute([$currentUser['id']]);
            $staffApps = $stmt->fetchAll();
            $staffStatusMap = [];
            $staffIdMap = [];
            foreach ($staffApps as $app) {
                if (!isset($staffStatusMap[$app['event_id']])) {
                    $staffStatusMap[$app['event_id']] = $app['status'];
                    $staffIdMap[$app['event_id']] = $app['id'];
                }
            }
            foreach ($events as &$event) {
                $event['user_staff_application_status'] = $staffStatusMap[$event['id']] ?? null;
                $event['user_staff_application_id'] = $staffIdMap[$event['id']] ?? null;
            }
            unset($event);
        } else {
            foreach ($events as &$event) {
                $event['user_application_status'] = null;
                $event['user_application_id'] = null;
                $event['staff_current_applicants'] = $staffCounts[(int)$event['id']] ?? 0;
                $event['user_staff_application_status'] = null;
                $event['user_staff_application_id'] = null;
                $event['user_review_role'] = null;
            }
            unset($event);
        }

        echo json_encode(['success' => true, 'events' => $events], JSON_UNESCAPED_UNICODE);
        exit();

    case 'list_participants':
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            echo json_encode(['success' => false, 'message' => '仅支持 GET 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $eventId = (int)($_GET['event_id'] ?? 0);
        if (!$eventId) {
            echo json_encode(['success' => false, 'message' => '缺少 event_id 参数'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();

        // 获取活动信息
        $stmt = $db->prepare("SELECT * FROM galonly_events WHERE id = ?");
        $stmt->execute([$eventId]);
        $event = $stmt->fetch();

        if (!$event) {
            echo json_encode(['success' => false, 'message' => '活动不存在'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        // 获取已获得/保留摊主资格的申请（预选通过 / 正式摊主 / 拼摊）
        $stmt = $db->prepare(
            "SELECT id, booth_name, is_joint, joint_name, notes, image_path, display_image, created_at, booth_type, status
             FROM galonly_applications
             WHERE event_id = ? AND status IN ('approved','confirmed','shared')
             ORDER BY created_at ASC"
        );
        $stmt->execute([$eventId]);
        $applications = $stmt->fetchAll();

        // 加载 clubs.json + clubs_japan.json 建立 country_id => club 映射
        $clubsJsonPath = __DIR__ . '/../data/clubs.json';
        $clubsJapanPath = __DIR__ . '/../data/clubs_japan.json';
        $clubsMap = [];

        // 中国同好会
        if (file_exists($clubsJsonPath)) {
            $clubsData = json_decode(file_get_contents($clubsJsonPath), true);
            foreach (($clubsData['data'] ?? []) as $club) {
                $clubsMap['china_' . (int)$club['id']] = $club;
            }
        }

        // 日本同好会
        if (file_exists($clubsJapanPath)) {
            $clubsData = json_decode(file_get_contents($clubsJapanPath), true);
            foreach (($clubsData['data'] ?? []) as $club) {
                $clubsMap['japan_' . (int)$club['id']] = $club;
            }
        }

        // 当前访问者的 IP
        $ip = $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';

        // 查询该 IP 点赞了哪些摊位（一个 IP 可点赞多个）
        $stmt = $db->prepare("SELECT application_id FROM galonly_public_votes WHERE event_id = ? AND ip_address = ?");
        $stmt->execute([$eventId, $ip]);
        $myVoteAppIds = $stmt->fetchAll(PDO::FETCH_COLUMN);

        // 查询所有申请的投票数
        $stmt = $db->prepare("SELECT application_id, COUNT(*) as cnt FROM galonly_public_votes WHERE event_id = ? GROUP BY application_id");
        $stmt->execute([$eventId]);
        $voteRows = $stmt->fetchAll();
        $voteMap = [];
        foreach ($voteRows as $row) {
            $voteMap[(int)$row['application_id']] = (int)$row['cnt'];
        }

        // 每个申请附加上同好会信息和投票数
        foreach ($applications as &$app) {
            $stmt = $db->prepare("SELECT club_id, club_country FROM galonly_application_clubs WHERE application_id = ?");
            $stmt->execute([$app['id']]);
            $appClubs = $stmt->fetchAll();

            $app['clubs'] = [];
            foreach ($appClubs as $ac) {
                $clubId = (int)$ac['club_id'];
                $country = $ac['club_country'] ?? '';
                if (empty($country)) $country = 'china';
                $key = $country . '_' . $clubId;
                if (isset($clubsMap[$key])) {
                    $c = $clubsMap[$key];
                    $app['clubs'][] = [
                        'id'           => $clubId,
                        'name'         => $c['name'] ?? '',
                        'display_name' => $c['display_name'] ?? $c['name'] ?? '',
                        'school'       => $c['school'] ?? '',
                        'logo_url'     => $c['logo_url'] ?? '',
                        'info'         => $c['info'] ?? '',
                        'country'      => $country,
                    ];
                }
            }

            // 附加投票信息
            $appId = (int)$app['id'];
            $app['vote_count'] = $voteMap[$appId] ?? 0;
            $app['my_vote'] = in_array($appId, $myVoteAppIds);
            $app['image_paths'] = decodeImagePaths($app);
            $app['display_image'] = $app['display_image'] ?? null;
            $posterSource = $app['display_image'] ?: ($app['image_paths'][0] ?? null);
            $app['display_thumbnail'] = galonlyPosterThumbnailPath($posterSource);
        }
        unset($app);

        // 总票数
        $stmt = $db->prepare("SELECT COUNT(*) FROM galonly_public_votes WHERE event_id = ?");
        $stmt->execute([$eventId]);
        $totalVotes = (int)$stmt->fetchColumn();

        echo json_encode([
            'success'      => true,
            'event'        => $event,
            'participants' => $applications,
            'total'        => count($applications),
            'total_votes'  => $totalVotes,
        ], JSON_UNESCAPED_UNICODE);
        exit();

    case 'check_eligibility':
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            echo json_encode(['success' => false, 'message' => '仅支持 GET 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        $db = getDB();

        $stmt = $db->prepare("SELECT club_id, country FROM club_memberships WHERE user_id = ? AND status = 'active'");
        $stmt->execute([$user['id']]);
        $clubs = $stmt->fetchAll();

        if (empty($clubs)) {
            echo json_encode([
                'success' => true,
                'eligible' => false,
                'clubs' => [],
                'reason' => '请先加入或创建一个同好会',
            ], JSON_UNESCAPED_UNICODE);
            exit();
        }

        echo json_encode([
            'success' => true,
            'eligible' => true,
            'clubs' => $clubs,
            'reason' => null,
        ], JSON_UNESCAPED_UNICODE);
        exit();

    case 'submit':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);

        $eventId = (int)($input['event_id'] ?? 0);
        $clubIds = $input['club_ids'] ?? [];
        $clubCountries = $input['club_countries'] ?? [];
        $isJoint = (int)($input['is_joint'] ?? 0);
        $jointName = trim($input['joint_name'] ?? '');
        $contact = trim($input['contact'] ?? '');
        $notes = trim($input['notes'] ?? '');
        $boothName = trim($input['booth_name'] ?? '');
        $wantsUpgrade = (int)($input['wants_upgrade'] ?? 0);
        $boothType = trim((string)($input['booth_type'] ?? ''));
        $expectedMembers = max(0, (int)($input['expected_members'] ?? 0));
        $layoutNotes = trim((string)($input['layout_notes'] ?? ''));
        $needsPower = trim((string)($input['needs_power'] ?? 'unsure'));
        if (!in_array($needsPower, ['yes', 'no', 'unsure'], true)) $needsPower = 'unsure';
        // 2026-08 北京 GalOnly 2.0：联系方式拆分 QQ + 手机号；新增参展经历
        $qqNumber = trim((string)($input['qq_number'] ?? ''));
        $phoneNumber = trim((string)($input['phone_number'] ?? ''));
        $exhibitionExperience = galonlyNormalizeExhibitionExperience($input['exhibition_experience'] ?? '');
        $imagePaths = isset($input['image_paths']) && is_array($input['image_paths']) ? $input['image_paths'] : [];
        $attachmentPaths = isset($input['attachment_paths']) && is_array($input['attachment_paths']) ? $input['attachment_paths'] : [];
        $displayImage = trim($input['display_image'] ?? '');

        // 验证必填字段
        if (!$eventId) {
            echo json_encode(['success' => false, 'message' => '请选择活动'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if (!is_array($clubIds) || empty($clubIds)) {
            echo json_encode(['success' => false, 'message' => '请选择至少一个同好会'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();

        // Keep direct booth submissions subject to the event schema guard.
        galonlyEnsureColumn(
            $db,
            'galonly_events',
            'event_code',
            galonlyIsMysql() ? "VARCHAR(32) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''"
        );

        $eventStmt = $db->prepare("SELECT id, registration_open, staff_only, event_code FROM galonly_events WHERE id = ? LIMIT 1");
        $eventStmt->execute([$eventId]);
        $event = $eventStmt->fetch(PDO::FETCH_ASSOC);
        if (!$event) {
            echo json_encode(['success' => false, 'message' => '活动不存在'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        // 摊位类型四选一：仅北京活动强制（上海等活动保持旧表单）
        $isBeijingSubmit = strtolower((string)($event['event_code'] ?? '')) === 'beijing';
        if ($isBeijingSubmit && !in_array($boothType, galonlyBoothTypes(), true)) {
            echo json_encode(['success' => false, 'message' => '请选择摊位呈现形式（A 只贩售同人制品 / B 只进行活动 / C 二者均有贩售为主 / D 二者均有活动为主）'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        // 2026-08 北京 GalOnly 2.0：联系方式收集 QQ + 手机号；非北京沿用原 contact 字段
        if ($isBeijingSubmit) {
            if ($qqNumber === '') {
                echo json_encode(['success' => false, 'message' => '请填写 QQ 号'], JSON_UNESCAPED_UNICODE);
                exit();
            }
            if ($phoneNumber === '') {
                echo json_encode(['success' => false, 'message' => '请填写手机号'], JSON_UNESCAPED_UNICODE);
                exit();
            }
            $exp = json_decode($exhibitionExperience, true);
            if (!is_array($exp) || !isset($exp['has'])) {
                echo json_encode(['success' => false, 'message' => '请选择是否有参展经历'], JSON_UNESCAPED_UNICODE);
                exit();
            }
            // 兼容旧消费方：contact 由服务端组装为可读文本
            $contact = 'QQ: ' . $qqNumber . ' / 手机: ' . $phoneNumber;
        } elseif (!$contact) {
            echo json_encode(['success' => false, 'message' => '请输入联系方式'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if ((int)($event['staff_only'] ?? 0) === 1) {
            echo json_encode(['success' => false, 'message' => '该活动仅开放 Staff 申请'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if ((int)($event['registration_open'] ?? 0) !== 1) {
            echo json_encode(['success' => false, 'message' => '该活动暂未开放摊位申请'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        // 检查每个同好会是否已提交申请（禁止重复）
        $activeStatuses = galonlyActiveStatuses();
        $statusPlaceholders = implode(',', array_fill(0, count($activeStatuses), '?'));
        foreach ($clubIds as $clubId) {
            $stmt = $db->prepare(
                "SELECT COUNT(*) FROM galonly_application_clubs ac
                 JOIN galonly_applications a ON ac.application_id = a.id
                 WHERE a.event_id = ? AND ac.club_id = ? AND a.status IN ($statusPlaceholders)"
            );
            $stmt->execute(array_merge([$eventId, (int)$clubId], $activeStatuses));
            if ((int)$stmt->fetchColumn() > 0) {
                echo json_encode([
                    'success' => false,
                    'message' => "同好会 ID {$clubId} 已提交过申请",
                ], JSON_UNESCAPED_UNICODE);
                exit();
            }
        }

        $now = date('Y-m-d H:i:s');
        $db->beginTransaction();
        try {
            $stmt = $db->prepare(
                "INSERT INTO galonly_applications (event_id, user_id, is_joint, joint_name, wants_upgrade, contact, qq_number, phone_number, exhibition_experience, notes, image_path, display_image, booth_name, booth_type, expected_members, layout_notes, needs_power, attachment_paths, status, phase, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)"
            );
            $stmt->execute([
                $eventId, $user['id'], $isJoint, $jointName, $wantsUpgrade, $contact,
                $qqNumber, $phoneNumber, $exhibitionExperience,
                $notes,
                json_encode($imagePaths, JSON_UNESCAPED_UNICODE), $displayImage ?: null, $boothName,
                $boothType, $expectedMembers, $layoutNotes, $needsPower,
                json_encode($attachmentPaths, JSON_UNESCAPED_UNICODE),
                $now, $now,
            ]);
            $appId = (int)$db->lastInsertId();

            foreach ($clubIds as $i => $clubId) {
                $country = $clubCountries[$i] ?? '';
                $stmt = $db->prepare(
                    "INSERT INTO galonly_application_clubs (application_id, club_id, club_country) VALUES (?, ?, ?)"
                );
                $stmt->execute([$appId, (int)$clubId, $country]);
            }

            $db->commit();
            logAction('galonly.submit', 'galonly_application', $appId);

            echo json_encode(['success' => true, 'application_id' => $appId], JSON_UNESCAPED_UNICODE);
        } catch (Exception $e) {
            $db->rollBack();
            echo json_encode(['success' => false, 'message' => '提交失败：' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
        }
        exit();

    case 'get_application':
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            echo json_encode(['success' => false, 'message' => '仅支持 GET 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        $eventId = (int)($_GET['event_id'] ?? 0);
        $applicationId = (int)($_GET['application_id'] ?? 0);

        $db = getDB();

        if ($applicationId) {
            $stmt = $db->prepare("SELECT * FROM galonly_applications WHERE id = ? AND user_id = ?");
            $stmt->execute([$applicationId, $user['id']]);
        } elseif ($eventId) {
            $stmt = $db->prepare("SELECT * FROM galonly_applications WHERE user_id = ? AND event_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1");
            $stmt->execute([$user['id'], $eventId]);
        } else {
            echo json_encode(['success' => false, 'message' => '缺少 event_id 或 application_id 参数'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $application = $stmt->fetch();

        if ($application) {
            $stmt = $db->prepare("SELECT club_id, club_country FROM galonly_application_clubs WHERE application_id = ?");
            $stmt->execute([$application['id']]);
            $application['clubs'] = $stmt->fetchAll();
            $application['image_paths'] = decodeImagePaths($application);
            $application['attachment_paths'] = galonlyDecodeJsonList($application['attachment_paths'] ?? []);
            $application['merchandise_items'] = galonlyDecodeJsonList($application['merchandise_items'] ?? []);
            $application['merchandise_attachments'] = galonlyDecodeJsonList($application['merchandise_attachments'] ?? []);
            $application['phase'] = (int)($application['phase'] ?? 1);
            $application['exhibition_experience'] = galonlyDecodeExhibitionExperience($application['exhibition_experience'] ?? '');
            $application['booth_type_label'] = galonlyBoothTypeLabel((string)($application['booth_type'] ?? ''));

            // 审核意见列表（含投票人角色）——2026-08 陪审匿名：逐条意见仅对审核人可见，摊主等非审核人看不到
            $reviewRole = galonlyReviewerRole($db, (int)$application['event_id'], $user);
            $application['my_review_role'] = $reviewRole;
            if ($reviewRole !== null || hasAuditPermission($user)) {
                $stmt = $db->prepare(
                    "SELECT v.vote, v.comment, v.phase, v.created_at, u.nickname, u.username,
                            r.role AS reviewer_role
                     FROM galonly_votes v
                     LEFT JOIN users u ON v.auditer_id = u.id
                     LEFT JOIN galonly_reviewers r ON r.user_id = v.auditer_id AND (r.event_id = 0 OR r.event_id = ?)
                     WHERE v.application_id = ?
                     ORDER BY v.phase ASC, v.id ASC"
                );
                $stmt->execute([(int)$application['event_id'], $application['id']]);
                $application['votes'] = $stmt->fetchAll();
                foreach ($application['votes'] as &$vote) {
                    $vote['reviewer_role'] = $vote['reviewer_role'] ?? null;
                    $vote['reviewer_name'] = $vote['nickname'] ?: $vote['username'] ?: ('用户 #' . $vote['auditer_id']);
                }
                unset($vote);
            } else {
                $application['votes'] = [];
            }
        }

        echo json_encode(['success' => true, 'application' => $application ?: null], JSON_UNESCAPED_UNICODE);
        exit();

    case 'update_application':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);

        $applicationId = (int)($input['application_id'] ?? 0);
        if (!$applicationId) {
            echo json_encode(['success' => false, 'message' => '缺少 application_id'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();

        // 验证申请存在且属于当前用户
        $stmt = $db->prepare("SELECT status, event_id, phase, rejected_at, revision_at FROM galonly_applications WHERE id = ? AND user_id = ?");
        $stmt->execute([$applicationId, $user['id']]);
        $app = $stmt->fetch();

        if (!$app) {
            echo json_encode(['success' => false, 'message' => '申请不存在'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        // 2026-08 北京 GalOnly 2.0：联系方式 QQ+手机号、参展经历
        $evStmt = $db->prepare("SELECT event_code FROM galonly_events WHERE id = ?");
        $evStmt->execute([$app['event_id']]);
        $evCode = strtolower((string)($evStmt->fetchColumn() ?: ''));
        $isBeijingApp = $evCode === 'beijing';
        // 收集要更新的字段
        $fields = [];
        $params = [];

        if (isset($input['booth_name'])) {
            $fields[] = 'booth_name = ?';
            $params[] = trim($input['booth_name']);
        }
        if (isset($input['is_joint'])) {
            $fields[] = 'is_joint = ?';
            $params[] = (int)$input['is_joint'];
        }
        if (isset($input['joint_name'])) {
            $fields[] = 'joint_name = ?';
            $params[] = trim($input['joint_name']);
        }
        if (isset($input['wants_upgrade'])) {
            $fields[] = 'wants_upgrade = ?';
            $params[] = (int)$input['wants_upgrade'];
        }
        if (isset($input['booth_type'])) {
            $boothType = trim((string)$input['booth_type']);
            // 仅北京活动要求四选一
            if ($isBeijingApp && !in_array($boothType, galonlyBoothTypes(), true)) {
                echo json_encode(['success' => false, 'message' => '请选择摊位呈现形式（A 只贩售同人制品 / B 只进行活动 / C 二者均有贩售为主 / D 二者均有活动为主）'], JSON_UNESCAPED_UNICODE);
                exit();
            }
            $fields[] = 'booth_type = ?';
            $params[] = $boothType;
        }
        if (isset($input['expected_members'])) {
            $fields[] = 'expected_members = ?';
            $params[] = max(0, (int)$input['expected_members']);
        }
        if (isset($input['layout_notes'])) {
            $fields[] = 'layout_notes = ?';
            $params[] = trim((string)$input['layout_notes']);
        }
        if (isset($input['needs_power'])) {
            $needsPower = trim((string)$input['needs_power']);
            if (!in_array($needsPower, ['yes', 'no', 'unsure'], true)) $needsPower = 'unsure';
            $fields[] = 'needs_power = ?';
            $params[] = $needsPower;
        }
        if (isset($input['qq_number']) || isset($input['phone_number'])) {
            $qqNumber = trim((string)($input['qq_number'] ?? ''));
            $phoneNumber = trim((string)($input['phone_number'] ?? ''));
            if ($isBeijingApp) {
                if ($qqNumber === '' || $phoneNumber === '') {
                    echo json_encode(['success' => false, 'message' => '请填写 QQ 号与手机号'], JSON_UNESCAPED_UNICODE);
                    exit();
                }
                $fields[] = 'qq_number = ?';
                $params[] = $qqNumber;
                $fields[] = 'phone_number = ?';
                $params[] = $phoneNumber;
                // 兼容旧消费方：contact 同步为可读文本
                $fields[] = 'contact = ?';
                $params[] = 'QQ: ' . $qqNumber . ' / 手机: ' . $phoneNumber;
            } else {
                if (isset($input['qq_number'])) { $fields[] = 'qq_number = ?'; $params[] = $qqNumber; }
                if (isset($input['phone_number'])) { $fields[] = 'phone_number = ?'; $params[] = $phoneNumber; }
            }
        }
        if (isset($input['exhibition_experience'])) {
            $fields[] = 'exhibition_experience = ?';
            $params[] = galonlyNormalizeExhibitionExperience($input['exhibition_experience']);
        }
        if (isset($input['attachment_paths']) && is_array($input['attachment_paths'])) {
            $fields[] = 'attachment_paths = ?';
            $params[] = json_encode($input['attachment_paths'], JSON_UNESCAPED_UNICODE);
        }
        if (isset($input['contact'])) {
            $fields[] = 'contact = ?';
            $params[] = trim($input['contact']);
        }
        if (isset($input['notes'])) {
            $fields[] = 'notes = ?';
            $params[] = trim($input['notes']);
        }
        if (isset($input['image_paths']) && is_array($input['image_paths'])) {
            $fields[] = 'image_path = ?';
            $params[] = json_encode($input['image_paths'], JSON_UNESCAPED_UNICODE);
        }
        if (isset($input['display_image'])) {
            $fields[] = 'display_image = ?';
            $params[] = trim($input['display_image']) ?: null;
        }

        // 如果提供了同好会列表，检查唯一性约束
        $clubIdsChanged = isset($input['club_ids']) && is_array($input['club_ids']);
        if ($clubIdsChanged) {
            $newClubIds = $input['club_ids'];
            $newClubCountries = $input['club_countries'] ?? [];

            if (empty($newClubIds)) {
                echo json_encode(['success' => false, 'message' => '请选择至少一个同好会'], JSON_UNESCAPED_UNICODE);
                exit();
            }

            $activeStatuses = galonlyActiveStatuses();
            $statusPlaceholders = implode(',', array_fill(0, count($activeStatuses), '?'));
            foreach ($newClubIds as $clubId) {
                $stmt = $db->prepare(
                    "SELECT COUNT(*) FROM galonly_application_clubs ac
                     JOIN galonly_applications a ON ac.application_id = a.id
                     WHERE a.event_id = ? AND ac.club_id = ? AND a.status IN ($statusPlaceholders) AND a.id != ?"
                );
                $stmt->execute(array_merge([$app['event_id'], (int)$clubId], $activeStatuses, [$applicationId]));
                if ((int)$stmt->fetchColumn() > 0) {
                    echo json_encode([
                        'success' => false,
                        'message' => "同好会 ID {$clubId} 已提交过申请",
                    ], JSON_UNESCAPED_UNICODE);
                    exit();
                }
            }
        }

        // 阶段一驳回后 3 天内允许重提交；超期则最终驳回
        $now = date('Y-m-d H:i:s');
        $appPhase = (int)($app['phase'] ?? 1);
        $isResubmit = ($app['status'] === 'rejected' && $appPhase === 1);
        if ($isResubmit) {
            if (!galonlyWithinDeadline($app['rejected_at'] ?? null)) {
                echo json_encode(['success' => false, 'message' => '已超出驳回后的 3 天修改期限，很遗憾本次不能参展'], JSON_UNESCAPED_UNICODE);
                exit();
            }
            $fields[] = 'status = ?';
            $params[] = 'pending';
            $fields[] = 'resubmitted = 1';
            $fields[] = 'phase = 1';
        }
        // 已通过第一阶段且仍在资格期的申请被编辑时，标记更新但不改变状态
        if ($app['status'] === 'approved') {
            $fields[] = 'has_update = 1';
        }
        $fields[] = 'updated_at = ?';
        $params[] = $now;
        $params[] = $applicationId;

        $db->beginTransaction();
        try {
            // 重审时清除旧投票
            if ($isResubmit) {
                $db->prepare("DELETE FROM galonly_votes WHERE application_id = ?")->execute([$applicationId]);
            }

            $sql = "UPDATE galonly_applications SET " . implode(', ', $fields) . " WHERE id = ?";
            $stmt = $db->prepare($sql);
            $stmt->execute($params);

            if ($clubIdsChanged) {
                $db->prepare("DELETE FROM galonly_application_clubs WHERE application_id = ?")
                    ->execute([$applicationId]);

                foreach ($newClubIds as $i => $clubId) {
                    $country = $newClubCountries[$i] ?? '';
                    $stmt = $db->prepare(
                        "INSERT INTO galonly_application_clubs (application_id, club_id, club_country) VALUES (?, ?, ?)"
                    );
                    $stmt->execute([$applicationId, (int)$clubId, $country]);
                }
            }

            $db->commit();
            logAction('galonly.update_application', 'galonly_application', $applicationId);

            echo json_encode(['success' => true, 'message' => '申请已更新'], JSON_UNESCAPED_UNICODE);
        } catch (Exception $e) {
            $db->rollBack();
            echo json_encode(['success' => false, 'message' => '更新失败：' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
        }
        exit();

    case 'delete_application':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $applicationId = (int)($input['application_id'] ?? 0);

        if (!$applicationId) {
            echo json_encode(['success' => false, 'message' => '缺少 application_id'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();

        // 验证申请存在且属于当前用户
        $stmt = $db->prepare("SELECT id, status, image_path FROM galonly_applications WHERE id = ? AND user_id = ?");
        $stmt->execute([$applicationId, $user['id']]);
        $app = $stmt->fetch();

        if (!$app) {
            echo json_encode(['success' => false, 'message' => '申请不存在'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        // 2026-08 摊主可删除自己的申请（含已通过/正式摊主状态）；删除即释放社团名额、不可恢复
        $db->beginTransaction();
        try {
            $db->prepare("DELETE FROM galonly_votes WHERE application_id = ?")->execute([$applicationId]);
            $db->prepare("DELETE FROM galonly_public_votes WHERE application_id = ?")->execute([$applicationId]);
            $db->prepare("DELETE FROM galonly_application_clubs WHERE application_id = ?")->execute([$applicationId]);
            $db->prepare("DELETE FROM galonly_applications WHERE id = ?")->execute([$applicationId]);
            $db->commit();

            logAction('galonly.delete_application', 'galonly_application', $applicationId);
            echo json_encode(['success' => true, 'message' => '申请已删除'], JSON_UNESCAPED_UNICODE);
        } catch (Exception $e) {
            $db->rollBack();
            echo json_encode(['success' => false, 'message' => '删除失败：' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
        }
        exit();

    case 'upload_image':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();

        if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
            echo json_encode(['success' => false, 'message' => '文件上传失败'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $file = $_FILES['file'];
        $allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
        $maxSize = 10485760; // 10MB

        if (!in_array($file['type'], $allowedTypes)) {
            echo json_encode(['success' => false, 'message' => '仅支持 JPG、PNG、WebP 格式'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if ($file['size'] > $maxSize) {
            echo json_encode(['success' => false, 'message' => '文件大小不能超过 10MB'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $eventId = (int)($_POST['event_id'] ?? 0);
        if (!$eventId) {
            echo json_encode(['success' => false, 'message' => '缺少 event_id 参数'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        // 根据 MIME 类型确定扩展名
        $extMap = [
            'image/jpeg' => 'jpg',
            'image/png'  => 'png',
            'image/webp' => 'webp',
        ];
        $ext = $extMap[$file['type']];

        $filename = $user['id'] . '_' . time() . '_' . uniqid() . '.' . $ext;
        $uploadDir = __DIR__ . '/../uploads/galonly/' . $eventId;

        if (!is_dir($uploadDir)) {
            mkdir($uploadDir, 0755, true);
        }

        $destPath = $uploadDir . '/' . $filename;
        if (!move_uploaded_file($file['tmp_name'], $destPath)) {
            echo json_encode(['success' => false, 'message' => '文件保存失败'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $relativePath = 'uploads/galonly/' . $eventId . '/' . $filename;

        // 2026-08 性能修复：同步生成 WebP 缩略图（预览用小图，原图保留供查看/下载）
        $thumbRelative = null;
        $stem = pathinfo($filename, PATHINFO_FILENAME);
        $thumbPath = $uploadDir . '/thumbs/' . $stem . '.webp';
        if (galonlyMakeThumbnail($destPath, $thumbPath)) {
            $thumbRelative = 'uploads/galonly/' . $eventId . '/thumbs/' . $stem . '.webp';
        }

        echo json_encode([
            'success' => true,
            'path' => $relativePath,
            'thumb' => $thumbRelative,
        ], JSON_UNESCAPED_UNICODE);
        exit();

    case 'upload_file':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();

        if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
            echo json_encode(['success' => false, 'message' => '文件上传失败'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $file = $_FILES['file'];
        $allowedExt = ['xlsx', 'xls', 'docx', 'doc', 'pdf'];
        $maxSize = 20971520; // 20MB

        $ext = strtolower(pathinfo((string)($file['name'] ?? ''), PATHINFO_EXTENSION));
        if (!in_array($ext, $allowedExt, true)) {
            echo json_encode(['success' => false, 'message' => '仅支持 Excel / Word / PDF 文件（.xlsx .xls .docx .doc .pdf）'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if ($file['size'] > $maxSize) {
            echo json_encode(['success' => false, 'message' => '文件大小不能超过 20MB'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $eventId = (int)($_POST['event_id'] ?? 0);
        if (!$eventId) {
            echo json_encode(['success' => false, 'message' => '缺少 event_id 参数'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $filename = $user['id'] . '_' . time() . '_' . uniqid() . '.' . $ext;
        $uploadDir = __DIR__ . '/../uploads/galonly/' . $eventId;
        if (!is_dir($uploadDir)) {
            mkdir($uploadDir, 0755, true);
        }
        $destPath = $uploadDir . '/' . $filename;
        if (!move_uploaded_file($file['tmp_name'], $destPath)) {
            echo json_encode(['success' => false, 'message' => '文件保存失败'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $relativePath = 'uploads/galonly/' . $eventId . '/' . $filename;
        echo json_encode(['success' => true, 'path' => $relativePath, 'name' => $file['name']], JSON_UNESCAPED_UNICODE);
        exit();

    case 'list_applications':
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            echo json_encode(['success' => false, 'message' => '仅支持 GET 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        $db = getDB();
        $eventId = isset($_GET['event_id']) ? (int)$_GET['event_id'] : 0;
        if (!galonlyCanReview($db, $eventId, $user)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '权限不足'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $status = $_GET['status'] ?? '';
        $phase = $_GET['phase'] ?? '';

        $sql = "SELECT a.*, u.nickname, u.username, u.avatar_url
                FROM galonly_applications a
                JOIN users u ON a.user_id = u.id
                WHERE 1=1";
        $params = [];

        if ($eventId) {
            $sql .= " AND a.event_id = ?";
            $params[] = $eventId;
        }
        if ($status && $status !== 'all') {
            $sql .= " AND a.status = ?";
            $params[] = $status;
        }
        if ($phase !== '' && $phase !== 'all') {
            $sql .= " AND a.phase = ?";
            $params[] = (int)$phase;
        }
        $sql .= " ORDER BY a.created_at DESC";

        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        $applications = $stmt->fetchAll();

        foreach ($applications as &$app) {
            // 查询关联的同好会
            $stmt = $db->prepare("SELECT club_id, club_country FROM galonly_application_clubs WHERE application_id = ?");
            $stmt->execute([$app['id']]);
            $app['clubs'] = $stmt->fetchAll();

            // 查询投票统计（按阶段拆分）
            $stmt = $db->prepare("SELECT vote, phase, COUNT(*) as cnt FROM galonly_votes WHERE application_id = ? GROUP BY vote, phase");
            $stmt->execute([$app['id']]);
            $voteRows = $stmt->fetchAll();
            $voteCounts = ['approve' => 0, 'reject' => 0];
            $voteCountsByPhase = [
                1 => ['approve' => 0, 'reject' => 0],
                2 => ['approve' => 0, 'reject' => 0],
            ];
            foreach ($voteRows as $row) {
                $votePhase = (int)($row['phase'] ?? 1);
                $voteCounts[$row['vote']] = (int)$row['cnt'];
                if (isset($voteCountsByPhase[$votePhase])) {
                    $voteCountsByPhase[$votePhase][$row['vote']] = (int)$row['cnt'];
                }
            }
            $app['vote_counts'] = $voteCounts;
            $app['vote_counts_by_phase'] = $voteCountsByPhase;

            // 查询当前用户的投票（按阶段；北京两阶段各自独立）
            $stmt = $db->prepare("SELECT vote, phase FROM galonly_votes WHERE application_id = ? AND auditer_id = ?");
            $stmt->execute([$app['id'], $user['id']]);
            $myVotes = [1 => null, 2 => null];
            $myVote = null;
            foreach ($stmt->fetchAll() as $mv) {
                $mvPhase = (int)($mv['phase'] ?? 1);
                if (array_key_exists($mvPhase, $myVotes)) $myVotes[$mvPhase] = $mv['vote'];
                if ($myVote === null) $myVote = $mv['vote'];
            }
            $app['my_vote'] = $myVote ?: null;
            $app['my_votes'] = $myVotes;

            // 完整意见列表（投票人 + 角色 + 意见）
            $stmt = $db->prepare(
                "SELECT v.vote, v.comment, v.phase, v.created_at, v.auditer_id, u.nickname, u.username,
                        r.role AS reviewer_role
                 FROM galonly_votes v
                 LEFT JOIN users u ON v.auditer_id = u.id
                 LEFT JOIN galonly_reviewers r ON r.user_id = v.auditer_id AND (r.event_id = 0 OR r.event_id = ?)
                 WHERE v.application_id = ?
                 ORDER BY v.phase ASC, v.id ASC"
            );
            $stmt->execute([(int)$app['event_id'], $app['id']]);
            $app['votes'] = $stmt->fetchAll();
            foreach ($app['votes'] as &$vote) {
                $vote['reviewer_role'] = $vote['reviewer_role'] ?? null;
                $vote['reviewer_name'] = $vote['nickname'] ?: $vote['username'] ?: ('用户 #' . $vote['auditer_id']);
            }
            unset($vote);

            // 当前用户的审核角色（chief/jury/null）
            $app['my_review_role'] = galonlyReviewerRole($db, (int)$app['event_id'], $user);

            // 解码图片 / 附件 / 制品
            $app['image_paths'] = decodeImagePaths($app);
            $app['display_image'] = $app['display_image'] ?? null;
            $posterSource = $app['display_image'] ?: ($app['image_paths'][0] ?? null);
            $app['display_thumbnail'] = galonlyPosterThumbnailPath($posterSource);
            $app['attachment_paths'] = galonlyDecodeJsonList($app['attachment_paths'] ?? []);
            $app['merchandise_items'] = galonlyDecodeJsonList($app['merchandise_items'] ?? []);
            $app['merchandise_attachments'] = galonlyDecodeJsonList($app['merchandise_attachments'] ?? []);
            $app['phase'] = (int)($app['phase'] ?? 1);
            $app['exhibition_experience'] = galonlyDecodeExhibitionExperience($app['exhibition_experience'] ?? '');
            $app['booth_type_label'] = galonlyBoothTypeLabel((string)($app['booth_type'] ?? ''));
            $app['status_meta'] = galonlyBoothStatusMeta((string)($app['status'] ?? 'pending'));
        }
        unset($app);

        echo json_encode(['success' => true, 'applications' => $applications], JSON_UNESCAPED_UNICODE);
        exit();

    case 'vote':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $applicationId = (int)($input['application_id'] ?? 0);
        $vote = $input['vote'] ?? '';
        $comment = trim((string)($input['comment'] ?? ''));
        $phase = (int)($input['phase'] ?? 1);

        if (!$applicationId) {
            echo json_encode(['success' => false, 'message' => '缺少 application_id'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if (!in_array($vote, ['approve', 'reject'])) {
            echo json_encode(['success' => false, 'message' => '投票值必须为 approve 或 reject'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if (!in_array($phase, [1, 2], true)) {
            echo json_encode(['success' => false, 'message' => '无效的审核阶段'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();

        // 获取申请信息（权限与阶段一致性校验）
        $appStmt = $db->prepare("SELECT ga.*, ge.name AS event_name, ge.event_code FROM galonly_applications ga LEFT JOIN galonly_events ge ON ga.event_id = ge.id WHERE ga.id = ?");
        $appStmt->execute([$applicationId]);
        $appInfo = $appStmt->fetch();
        if (!$appInfo) {
            echo json_encode(['success' => false, 'message' => '申请不存在'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if (!galonlyCanReview($db, (int)$appInfo['event_id'], $user)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '权限不足'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $isBeijing = strtolower((string)($appInfo['event_code'] ?? '')) === 'beijing';
        $appStatus = (string)($appInfo['status'] ?? 'pending');

        // 上海等活动：恢复原简单投票制（无阶段，达到阈值自动判定）
        if (!$isBeijing) {
            if ($appStatus !== 'pending') {
                echo json_encode(['success' => false, 'message' => '该申请已审核完成'], JSON_UNESCAPED_UNICODE);
                exit();
            }
            $stmt = $db->prepare("SELECT id FROM galonly_votes WHERE application_id = ? AND auditer_id = ?");
            $stmt->execute([$applicationId, $user['id']]);
            if ($stmt->fetch()) {
                echo json_encode(['success' => false, 'message' => '您已对该申请投过票'], JSON_UNESCAPED_UNICODE);
                exit();
            }
            try {
                $stmt = $db->prepare("INSERT INTO galonly_votes (application_id, auditer_id, vote, comment, phase) VALUES (?, ?, ?, NULL, 1)");
                $stmt->execute([$applicationId, $user['id'], $vote]);

                $stmt = $db->prepare("SELECT vote, COUNT(*) as cnt FROM galonly_votes WHERE application_id = ? GROUP BY vote");
                $stmt->execute([$applicationId]);
                $voteRows = $stmt->fetchAll();
                $voteCounts = ['approve' => 0, 'reject' => 0];
                foreach ($voteRows as $row) {
                    $voteCounts[$row['vote']] = (int)$row['cnt'];
                }

                $now = date('Y-m-d H:i:s');
                $result = 'pending';
                if ($voteCounts['approve'] >= 4) {
                    $result = 'approved';
                    $db->prepare("UPDATE galonly_applications SET status = ?, updated_at = ? WHERE id = ?")->execute([$result, $now, $applicationId]);
                } elseif ($voteCounts['reject'] >= 4) {
                    $result = 'rejected';
                    $db->prepare("UPDATE galonly_applications SET status = ?, updated_at = ? WHERE id = ?")->execute([$result, $now, $applicationId]);
                }

                if (in_array($result, ['approved', 'rejected'], true)) {
                    require_once __DIR__ . '/../includes/notifications.php';
                    $type = $result === 'approved' ? 'galonly_approved' : 'galonly_rejected';
                    $title = $result === 'approved' ? '摊位申请已通过' : '摊位申请未通过';
                    $msg = $result === 'approved'
                        ? '你在「' . ($appInfo['event_name'] ?? '') . '」的摊位申请已通过审核'
                        : '你在「' . ($appInfo['event_name'] ?? '') . '」的摊位申请未通过审核';
                    createNotification(
                        (int)$appInfo['user_id'],
                        $type,
                        $title,
                        $msg,
                        'Galgame_events/galgameonly_list.html',
                        'galonly_application',
                        $applicationId
                    );
                }
                logAction('galonly.vote', 'galonly_application', $applicationId, ['vote' => $vote]);
                echo json_encode(['success' => true, 'result' => $result, 'votes' => $voteCounts], JSON_UNESCAPED_UNICODE);
            } catch (Exception $e) {
                echo json_encode(['success' => false, 'message' => '投票失败：' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
            }
            exit();
        }

        // 北京两阶段：阶段一致性——意见只能投给正在审核中的申请
        $appStatus = (string)($appInfo['status'] ?? 'pending');
        if ($phase === 1 && $appStatus !== 'pending') {
            echo json_encode(['success' => false, 'message' => '该申请不在阶段一待审状态，无法提交阶段一意见'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if ($phase === 2 && !in_array($appStatus, ['phase2_pending', 'phase2_revision'], true)) {
            echo json_encode(['success' => false, 'message' => '该申请不在阶段二审核状态，无法提交阶段二意见'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        // 检查是否已对该阶段投票
        $stmt = $db->prepare("SELECT id FROM galonly_votes WHERE application_id = ? AND auditer_id = ? AND phase = ?");
        $stmt->execute([$applicationId, $user['id'], $phase]);
        if ($stmt->fetch()) {
            echo json_encode(['success' => false, 'message' => '您已对该申请的本阶段投过票'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        try {
            // 插入意见（陪审与总审均可提交；总审的最终决定走 resolve / resolve_product）
            $stmt = $db->prepare("INSERT INTO galonly_votes (application_id, auditer_id, vote, comment, phase) VALUES (?, ?, ?, ?, ?)");
            $stmt->execute([$applicationId, $user['id'], $vote, $comment !== '' ? $comment : null, $phase]);

            // 统计该阶段意见
            $stmt = $db->prepare("SELECT vote, COUNT(*) as cnt FROM galonly_votes WHERE application_id = ? AND phase = ? GROUP BY vote");
            $stmt->execute([$applicationId, $phase]);
            $voteRows = $stmt->fetchAll();
            $voteCounts = ['approve' => 0, 'reject' => 0];
            foreach ($voteRows as $row) {
                $voteCounts[$row['vote']] = (int)$row['cnt'];
            }

            logAction('galonly.vote', 'galonly_application', $applicationId, ['phase' => $phase, 'vote' => $vote]);
            echo json_encode([
                'success' => true,
                'result' => $appStatus,
                'votes' => $voteCounts,
                'message' => '意见已记录',
            ], JSON_UNESCAPED_UNICODE);
        } catch (Exception $e) {
            echo json_encode(['success' => false, 'message' => '意见提交失败：' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
        }
        exit();

    case 'withdraw_vote':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $applicationId = (int)($input['application_id'] ?? 0);
        // 2026-08 陪审分阶段审核：撤回时可按阶段精确撤回；未传 phase 时兼容旧调用
        $phase = isset($input['phase']) ? (int)$input['phase'] : 0;

        if (!$applicationId) {
            echo json_encode(['success' => false, 'message' => '缺少 application_id'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();

        // 检查是否存在我的投票/意见（可按阶段）
        if ($phase === 1 || $phase === 2) {
            $stmt = $db->prepare("SELECT v.id, v.vote, v.phase, a.event_id FROM galonly_votes v JOIN galonly_applications a ON v.application_id = a.id WHERE v.application_id = ? AND v.auditer_id = ? AND v.phase = ?");
            $stmt->execute([$applicationId, $user['id'], $phase]);
        } else {
            $stmt = $db->prepare("SELECT v.id, v.vote, v.phase, a.event_id FROM galonly_votes v JOIN galonly_applications a ON v.application_id = a.id WHERE v.application_id = ? AND v.auditer_id = ?");
            $stmt->execute([$applicationId, $user['id']]);
        }
        $existingVote = $stmt->fetch();

        if (!$existingVote) {
            echo json_encode(['success' => false, 'message' => '你尚未对该申请投过票'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if (!galonlyCanReview($db, (int)$existingVote['event_id'], $user)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '权限不足'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $isBeijing = galonlyEventIsBeijing($db, (int)$existingVote['event_id']);

        try {
            $db->prepare("DELETE FROM galonly_votes WHERE id = ?")->execute([$existingVote['id']]);

            if (!$isBeijing) {
                // 上海等原流程：撤回后重新统计，未达阈值则回滚状态
                $now = date('Y-m-d H:i:s');
                $currentStatus = (string)$db->query("SELECT status FROM galonly_applications WHERE id = " . (int)$applicationId)->fetchColumn();

                $stmt = $db->prepare("SELECT vote, COUNT(*) as cnt FROM galonly_votes WHERE application_id = ? GROUP BY vote");
                $stmt->execute([$applicationId]);
                $voteRows = $stmt->fetchAll();
                $voteCounts = ['approve' => 0, 'reject' => 0];
                foreach ($voteRows as $row) {
                    $voteCounts[$row['vote']] = (int)$row['cnt'];
                }

                $newStatus = 'pending';
                if ($voteCounts['approve'] >= 4) {
                    $newStatus = 'approved';
                } elseif ($voteCounts['reject'] >= 4) {
                    $newStatus = 'rejected';
                }
                if ($newStatus !== $currentStatus) {
                    $db->prepare("UPDATE galonly_applications SET status = ?, updated_at = ? WHERE id = ?")
                        ->execute([$newStatus, $now, $applicationId]);
                }
                logAction('galonly.withdraw_vote', 'galonly_application', $applicationId);
                echo json_encode(['success' => true, 'result' => $newStatus, 'votes' => $voteCounts], JSON_UNESCAPED_UNICODE);
            } else {
                logAction('galonly.withdraw_vote', 'galonly_application', $applicationId, ['phase' => (int)$existingVote['phase']]);
                echo json_encode(['success' => true, 'result' => 'withdrawn', 'message' => '意见已撤回'], JSON_UNESCAPED_UNICODE);
            }
        } catch (Exception $e) {
            echo json_encode(['success' => false, 'message' => '撤回投票失败：' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
        }
        exit();

    case 'cast_public_vote':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $input = json_decode(file_get_contents('php://input'), true);
        $eventId = (int)($input['event_id'] ?? 0);
        $applicationId = (int)($input['application_id'] ?? 0);

        if (!$eventId || !$applicationId) {
            echo json_encode(['success' => false, 'message' => '缺少参数'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $ip = $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';
        $db = getDB();

        // 验证申请属于该活动且已获得/保留摊主资格（预选通过 / 正式摊主 / 拼摊）
        $stmt = $db->prepare("SELECT id FROM galonly_applications WHERE id = ? AND event_id = ? AND status IN ('approved','confirmed','shared')");
        $stmt->execute([$applicationId, $eventId]);
        if (!$stmt->fetch()) {
            echo json_encode(['success' => false, 'message' => '无效的申请'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        // 检查是否已点赞该摊位（同一摊位不可重复点赞，但可点赞多个不同摊位）
        $stmt = $db->prepare("SELECT id FROM galonly_public_votes WHERE event_id = ? AND ip_address = ? AND application_id = ?");
        $stmt->execute([$eventId, $ip, $applicationId]);
        if ($stmt->fetch()) {
            echo json_encode(['success' => false, 'message' => '您已赞过该摊位', 'already_voted' => true], JSON_UNESCAPED_UNICODE);
            exit();
        }

        // 插入投票
        $stmt = $db->prepare("INSERT INTO galonly_public_votes (event_id, application_id, ip_address) VALUES (?, ?, ?)");
        $stmt->execute([$eventId, $applicationId, $ip]);

        // 更新后的票数
        $stmt = $db->prepare("SELECT COUNT(*) FROM galonly_public_votes WHERE application_id = ?");
        $stmt->execute([$applicationId]);
        $voteCount = (int)$stmt->fetchColumn();

        $stmt = $db->prepare("SELECT COUNT(*) FROM galonly_public_votes WHERE event_id = ?");
        $stmt->execute([$eventId]);
        $totalVotes = (int)$stmt->fetchColumn();

        echo json_encode([
            'success' => true,
            'message' => '投票成功',
            'vote_count' => $voteCount,
            'total_votes' => $totalVotes,
        ], JSON_UNESCAPED_UNICODE);
            exit();

    case 'resolve':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $applicationId = (int)($input['application_id'] ?? 0);
        $decision = $input['decision'] ?? '';
        $feedback = trim((string)($input['feedback'] ?? ''));

        if (!$applicationId) {
            echo json_encode(['success' => false, 'message' => '缺少 application_id'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if (!in_array($decision, ['approve', 'reject'], true)) {
            echo json_encode(['success' => false, 'message' => 'decision 必须为 approve 或 reject'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();
        $stmt = $db->prepare("SELECT ga.*, ge.name AS event_name FROM galonly_applications ga LEFT JOIN galonly_events ge ON ga.event_id = ge.id WHERE ga.id = ?");
        $stmt->execute([$applicationId]);
        $app = $stmt->fetch();
        if (!$app) {
            echo json_encode(['success' => false, 'message' => '申请不存在'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if (!galonlyEventIsBeijing($db, (int)$app['event_id'])) {
            echo json_encode(['success' => false, 'message' => '该活动采用投票制审核，不支持总审最终决定'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if (galonlyReviewerRole($db, (int)$app['event_id'], $user) !== 'chief') {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '仅总审可做出最终决定'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if ((string)$app['status'] !== 'pending' || (int)($app['phase'] ?? 1) !== 1) {
            echo json_encode(['success' => false, 'message' => '该申请不在阶段一待审状态'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $now = date('Y-m-d H:i:s');
        if ($decision === 'approve') {
            $db->prepare("UPDATE galonly_applications SET status = 'approved', phase = 1, phase1_feedback = ?, rejected_at = NULL, updated_at = ? WHERE id = ?")
                ->execute([$feedback !== '' ? $feedback : null, $now, $applicationId]);
        } else {
            $db->prepare("UPDATE galonly_applications SET status = 'rejected', phase = 1, phase1_feedback = ?, rejected_at = ?, updated_at = ? WHERE id = ?")
                ->execute([$feedback !== '' ? $feedback : null, $now, $now, $applicationId]);
        }
        logAction('galonly.resolve', 'galonly_application', $applicationId, ['decision' => $decision]);
        galonlyNotifyBoothApplicant($app, $decision === 'approve' ? 'approved' : 'rejected', $app, $feedback);
        echo json_encode([
            'success' => true,
            'message' => $decision === 'approve' ? '已通过第一阶段，摊主已锁定预选资格并解锁制品表单' : '已驳回（摊主可在 3 天内修改并重新提交）',
        ], JSON_UNESCAPED_UNICODE);
        exit();

    case 'submit_merchandise':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $applicationId = (int)($input['application_id'] ?? 0);
        if (!$applicationId) {
            echo json_encode(['success' => false, 'message' => '缺少 application_id'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        // 规范化制品列表（2026-08 北京 GalOnly 2.0：每项支持多张制品图片）
        $normalized = [];
        if (isset($input['merchandise_items']) && is_array($input['merchandise_items'])) {
            foreach ($input['merchandise_items'] as $item) {
                if (!is_array($item)) continue;
                $name = trim((string)($item['name'] ?? ''));
                if ($name === '') continue;
                $images = [];
                if (isset($item['images']) && is_array($item['images'])) {
                    foreach ($item['images'] as $img) {
                        $img = trim((string)$img);
                        if ($img === '') continue;
                        if (count($images) >= 6) break; // 每项上限 6 张
                        $images[] = $img;
                    }
                }
                $normalized[] = [
                    'name' => $name,
                    'category' => trim((string)($item['category'] ?? '')),
                    'description' => trim((string)($item['description'] ?? '')),
                    'images' => $images,
                ];
            }
        }
        $attachments = isset($input['merchandise_attachments']) && is_array($input['merchandise_attachments'])
            ? array_values(array_filter($input['merchandise_attachments'], fn($p) => trim((string)$p) !== ''))
            : [];
        // 参展展示图自阶段一移至阶段二（2026-08 北京 GalOnly 2.0）
        $displayImage = trim((string)($input['display_image'] ?? ''));
        if (count($normalized) === 0 && count($attachments) === 0) {
            echo json_encode(['success' => false, 'message' => '请至少填写一个制品或上传制品名单文件'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();
        $stmt = $db->prepare("SELECT ga.*, ge.name AS event_name FROM galonly_applications ga LEFT JOIN galonly_events ge ON ga.event_id = ge.id WHERE ga.id = ? AND ga.user_id = ?");
        $stmt->execute([$applicationId, $user['id']]);
        $app = $stmt->fetch();
        if (!$app) {
            echo json_encode(['success' => false, 'message' => '申请不存在或无权操作'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if (!galonlyEventIsBeijing($db, (int)$app['event_id'])) {
            echo json_encode(['success' => false, 'message' => '该活动无制品审核阶段'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $status = (string)($app['status'] ?? '');
        $isInitial = $status === 'approved' && (int)($app['phase'] ?? 1) === 1;
        $isRevision = $status === 'phase2_revision';
        if (!$isInitial && !$isRevision) {
            echo json_encode(['success' => false, 'message' => '当前状态无法提交制品表单（仅阶段一通过或打回修改时可用）'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if ($isRevision && !galonlyWithinDeadline($app['revision_at'] ?? null)) {
            echo json_encode(['success' => false, 'message' => '已超出打回后的 3 天修改期限，不合规制品本次不得放入菜单'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $now = date('Y-m-d H:i:s');
        $db->beginTransaction();
        try {
            $db->prepare("UPDATE galonly_applications SET merchandise_items = ?, merchandise_attachments = ?, display_image = ?, status = 'phase2_pending', phase = 2, revision_at = NULL, phase2_feedback = NULL, updated_at = ? WHERE id = ?")
                ->execute([
                    json_encode($normalized, JSON_UNESCAPED_UNICODE),
                    json_encode($attachments, JSON_UNESCAPED_UNICODE),
                    $displayImage !== '' ? $displayImage : null,
                    $now,
                    $applicationId,
                ]);
            // 打回重提交时清空阶段二旧意见
            if ($isRevision) {
                $db->prepare("DELETE FROM galonly_votes WHERE application_id = ? AND phase = 2")->execute([$applicationId]);
            }
            $db->commit();
        } catch (Exception $e) {
            $db->rollBack();
            echo json_encode(['success' => false, 'message' => '提交失败：' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
            exit();
        }
        logAction('galonly.submit_merchandise', 'galonly_application', $applicationId);
        galonlyNotifyBoothApplicant($app, 'phase2_pending');
        echo json_encode(['success' => true, 'message' => '制品表单已提交，进入制品审核'], JSON_UNESCAPED_UNICODE);
        exit();

    case 'get_merchandise':
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            echo json_encode(['success' => false, 'message' => '仅支持 GET 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        $db = getDB();
        $applicationId = (int)($_GET['application_id'] ?? $_GET['app_id'] ?? 0);
        $eventId = (int)($_GET['event_id'] ?? 0);

        if ($applicationId) {
            $stmt = $db->prepare("SELECT id, event_id, status, phase, merchandise_items, merchandise_attachments, display_image, revision_at, phase2_feedback FROM galonly_applications WHERE id = ? AND user_id = ?");
            $stmt->execute([$applicationId, $user['id']]);
        } elseif ($eventId) {
            $stmt = $db->prepare("SELECT id, event_id, status, phase, merchandise_items, merchandise_attachments, display_image, revision_at, phase2_feedback FROM galonly_applications WHERE event_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1");
            $stmt->execute([$eventId, $user['id']]);
        } else {
            echo json_encode(['success' => false, 'message' => '缺少查询参数'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        $app = $stmt->fetch();
        if (!$app) {
            echo json_encode(['success' => false, 'message' => '申请不存在'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        $app['merchandise_items'] = galonlyDecodeJsonList($app['merchandise_items'] ?? []);
        $app['merchandise_attachments'] = galonlyDecodeJsonList($app['merchandise_attachments'] ?? []);
        $app['within_deadline'] = $app['status'] === 'phase2_revision'
            ? galonlyWithinDeadline($app['revision_at'] ?? null)
            : true;
        echo json_encode(['success' => true, 'application' => $app], JSON_UNESCAPED_UNICODE);
        exit();

    case 'resolve_product':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $applicationId = (int)($input['application_id'] ?? 0);
        $decision = $input['decision'] ?? '';
        $feedback = trim((string)($input['feedback'] ?? ''));

        if (!$applicationId) {
            echo json_encode(['success' => false, 'message' => '缺少 application_id'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if (!in_array($decision, ['approved', 'revision', 'rejected', 'shared'], true)) {
            echo json_encode(['success' => false, 'message' => 'decision 必须为 approved / revision / rejected / shared'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();
        $stmt = $db->prepare("SELECT ga.*, ge.name AS event_name FROM galonly_applications ga LEFT JOIN galonly_events ge ON ga.event_id = ge.id WHERE ga.id = ?");
        $stmt->execute([$applicationId]);
        $app = $stmt->fetch();
        if (!$app) {
            echo json_encode(['success' => false, 'message' => '申请不存在'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if (!galonlyEventIsBeijing($db, (int)$app['event_id'])) {
            echo json_encode(['success' => false, 'message' => '该活动无制品审核阶段'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if (galonlyReviewerRole($db, (int)$app['event_id'], $user) !== 'chief') {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '仅总审/专人可做出最终决定'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if (!in_array((string)$app['status'], ['phase2_pending', 'phase2_revision'], true)) {
            echo json_encode(['success' => false, 'message' => '该申请不在阶段二审核状态'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $now = date('Y-m-d H:i:s');
        switch ($decision) {
            case 'approved':
                $db->prepare("UPDATE galonly_applications SET status = 'confirmed', phase = 2, phase2_feedback = ?, revision_at = NULL, updated_at = ? WHERE id = ?")
                    ->execute([$feedback !== '' ? $feedback : null, $now, $applicationId]);
                break;
            case 'revision':
                $db->prepare("UPDATE galonly_applications SET status = 'phase2_revision', phase = 2, phase2_feedback = ?, revision_at = ?, updated_at = ? WHERE id = ?")
                    ->execute([$feedback !== '' ? $feedback : null, $now, $now, $applicationId]);
                break;
            case 'rejected':
                $db->prepare("UPDATE galonly_applications SET status = 'rejected', phase = 2, phase2_feedback = ?, rejected_at = ?, updated_at = ? WHERE id = ?")
                    ->execute([$feedback !== '' ? $feedback : null, $now, $now, $applicationId]);
                break;
            case 'shared':
                $db->prepare("UPDATE galonly_applications SET status = 'shared', phase = 2, phase2_feedback = ?, updated_at = ? WHERE id = ?")
                    ->execute([$feedback !== '' ? $feedback : null, $now, $applicationId]);
                break;
        }
        logAction('galonly.resolve_product', 'galonly_application', $applicationId, ['decision' => $decision]);
        galonlyNotifyBoothApplicant($app, $decision, $app, $feedback);
        echo json_encode(['success' => true, 'message' => '阶段二审核结果已确定并反馈给摊主'], JSON_UNESCAPED_UNICODE);
        exit();

    case 'undo_resolve':
        // 2026-08 两阶段撤回：总审可撤回已通过的最终决定
        // 一阶段 approved → pending；二阶段 confirmed/shared → phase2_pending
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        $applicationId = (int)($input['application_id'] ?? 0);
        $phase = (int)($input['phase'] ?? 0);

        if (!$applicationId) {
            echo json_encode(['success' => false, 'message' => '缺少 application_id'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if (!in_array($phase, [1, 2], true)) {
            echo json_encode(['success' => false, 'message' => '无效的审核阶段'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();
        $stmt = $db->prepare("SELECT ga.*, ge.event_code FROM galonly_applications ga LEFT JOIN galonly_events ge ON ga.event_id = ge.id WHERE ga.id = ?");
        $stmt->execute([$applicationId]);
        $app = $stmt->fetch();
        if (!$app) {
            echo json_encode(['success' => false, 'message' => '申请不存在'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if (strtolower((string)($app['event_code'] ?? '')) !== 'beijing') {
            echo json_encode(['success' => false, 'message' => '该活动无两阶段审核流程'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        if (galonlyReviewerRole($db, (int)$app['event_id'], $user) !== 'chief') {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '仅总审/专人可撤回最终决定'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $status = (string)($app['status'] ?? '');
        $now = date('Y-m-d H:i:s');
        if ($phase === 1) {
            if ($status !== 'approved' || (int)$app['phase'] !== 1) {
                echo json_encode(['success' => false, 'message' => '该申请不在阶段一已通过状态，无法撤回'], JSON_UNESCAPED_UNICODE);
                exit();
            }
            $db->prepare("UPDATE galonly_applications SET status = 'pending', phase = 1, phase1_feedback = NULL, updated_at = ? WHERE id = ?")
                ->execute([$now, $applicationId]);
            logAction('galonly.undo_resolve', 'galonly_application', $applicationId, ['phase' => 1]);
            echo json_encode(['success' => true, 'message' => '已撤回阶段一通过，申请回到待审核'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        // phase === 2
        if (!in_array($status, ['confirmed', 'shared'], true) || (int)$app['phase'] !== 2) {
            echo json_encode(['success' => false, 'message' => '该申请不在阶段二已通过状态，无法撤回'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        $db->prepare("UPDATE galonly_applications SET status = 'phase2_pending', phase = 2, phase2_feedback = NULL, revision_at = NULL, updated_at = ? WHERE id = ?")
            ->execute([$now, $applicationId]);
        logAction('galonly.undo_resolve', 'galonly_application', $applicationId, ['phase' => 2]);
        echo json_encode(['success' => true, 'message' => '已撤回阶段二通过，申请回到制品审核中'], JSON_UNESCAPED_UNICODE);
        exit();

    case 'list_reviewers':
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            echo json_encode(['success' => false, 'message' => '仅支持 GET 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        if (($user['role'] ?? '') !== 'super_admin') {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '仅超级管理员可管理审核成员'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        $db = getDB();
        galonlyEnsureBoothSchema($db);
        $stmt = $db->prepare("SELECT r.id, r.event_id, r.user_id, r.role, r.created_at, u.nickname, u.username, u.is_audit FROM galonly_reviewers r LEFT JOIN users u ON r.user_id = u.id ORDER BY r.role ASC, r.id DESC");
        $stmt->execute();
        $reviewers = $stmt->fetchAll();
        // 候选用户：已标记审核员或超级管理员（便于超管选择）
        $stmt = $db->prepare("SELECT id, nickname, username, role FROM users WHERE status = 'active' AND (is_audit = 1 OR role = 'super_admin') ORDER BY id DESC LIMIT 200");
        $stmt->execute();
        $candidates = $stmt->fetchAll();
        echo json_encode(['success' => true, 'reviewers' => $reviewers, 'candidates' => $candidates], JSON_UNESCAPED_UNICODE);
        exit();

    case 'save_reviewers':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        if (($user['role'] ?? '') !== 'super_admin') {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '仅超级管理员可管理审核成员'], JSON_UNESCAPED_UNICODE);
            exit();
        }
        $input = json_decode(file_get_contents('php://input'), true);
        $eventId = (int)($input['event_id'] ?? 0);
        $chiefIds = array_values(array_unique(array_map('intval', is_array($input['chief_ids'] ?? null) ? $input['chief_ids'] : [])));
        $juryIds = array_values(array_unique(array_map('intval', is_array($input['jury_ids'] ?? null) ? $input['jury_ids'] : [])));
        $chiefIds = array_values(array_filter($chiefIds, fn($id) => $id > 0));
        $juryIds = array_values(array_filter($juryIds, fn($id) => $id > 0));
        if (array_intersect($chiefIds, $juryIds)) {
            echo json_encode(['success' => false, 'message' => '同一用户不能同时担任总审与陪审'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();
        galonlyEnsureBoothSchema($db);

        // 细分权限仅可从「审核成员」身份（is_audit=1）或超级管理员中分配
        $assignIds = array_merge($chiefIds, $juryIds);
        if (!empty($assignIds)) {
            $ph = implode(',', array_fill(0, count($assignIds), '?'));
            $stmt = $db->prepare("SELECT COUNT(*) FROM users WHERE id IN ($ph) AND status = 'active' AND (is_audit = 1 OR role = 'super_admin')");
            $stmt->execute($assignIds);
            $valid = (int)$stmt->fetchColumn();
            if ($valid !== count($assignIds)) {
                echo json_encode(['success' => false, 'message' => '只能从「审核成员」身份用户中分配总审/陪审：请先在「用户管理」中为其开启审核成员身份'], JSON_UNESCAPED_UNICODE);
                exit();
            }
        }

        $db->beginTransaction();
        try {
            $db->prepare("DELETE FROM galonly_reviewers WHERE event_id = ?")->execute([$eventId]);
            $stmt = $db->prepare("INSERT INTO galonly_reviewers (event_id, user_id, role) VALUES (?, ?, ?)");
            foreach ($chiefIds as $uid) $stmt->execute([$eventId, $uid, 'chief']);
            foreach ($juryIds as $uid) $stmt->execute([$eventId, $uid, 'jury']);
            $db->commit();
        } catch (Exception $e) {
            $db->rollBack();
            echo json_encode(['success' => false, 'message' => '保存失败：' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
            exit();
        }
        logAction('galonly.save_reviewers', 'galonly_event', $eventId, ['chiefs' => $chiefIds, 'juries' => $juryIds]);
        echo json_encode(['success' => true, 'message' => '审核成员已更新'], JSON_UNESCAPED_UNICODE);
        exit();

    case 'submit_staff':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') galonlyStaffFail('仅支持 POST 请求', 405);

        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input)) galonlyStaffFail('请求数据格式错误');

        $db = getDB();
        galonlyEnsureStaffSchema($db);
        $payload = galonlyStaffPayload($input);
        if ($message = galonlyStaffValidate($payload)) galonlyStaffFail($message);

        $event = galonlyStaffEvent($db, $payload['event_id']);
        if (!$event) galonlyStaffFail('活动不存在');
        if ($reason = galonlyStaffRegistrationClosedReason($db, $event)) galonlyStaffFail($reason);
        if (!galonlyStaffIsIndividualApplicant($payload) && !galonlyStaffUserHasClub($db, (int)$user['id'], $payload['club_id'], $payload['club_country'])) {
            galonlyStaffFail('只能选择你已加入的高校社团');
        }

        $stmt = $db->prepare("SELECT id FROM galonly_staff_applications WHERE event_id = ? AND user_id = ? AND status IN ('pending','pooled') LIMIT 1");
        $stmt->execute([$payload['event_id'], $user['id']]);
        if ($stmt->fetch()) galonlyStaffFail('你已有该活动的待审核申请');

        $now = date('Y-m-d H:i:s');
        $stmt = $db->prepare("
            INSERT INTO galonly_staff_applications
                (event_id, user_id, cn_name, qq_number, phone_number, email, club_id, club_country, positions, confirm_schedule, is_cosplay, three_day_available, gender, staff_experience, skills, self_intro, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ");
        $stmt->execute([
            $payload['event_id'], $user['id'], $payload['cn_name'], $payload['qq_number'],
            $payload['phone_number'], $payload['email'], $payload['club_id'], $payload['club_country'],
            json_encode($payload['positions'], JSON_UNESCAPED_UNICODE),
            $payload['confirm_schedule'], $payload['is_cosplay'], $payload['three_day_available'],
            $payload['gender'], $payload['staff_experience'], $payload['skills'],
            $payload['self_intro'], $now, $now,
        ]);
        $applicationId = (int)$db->lastInsertId();
        logAction('galonly.submit_staff', 'galonly_staff_application', $applicationId);
        echo json_encode(['success' => true, 'application_id' => $applicationId, 'message' => 'Staff 申请已提交'], JSON_UNESCAPED_UNICODE);
        exit();

    case 'get_staff_application':
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') galonlyStaffFail('仅支持 GET 请求', 405);

        $user = requireLogin();
        $db = getDB();
        galonlyEnsureStaffSchema($db);
        $applicationId = (int)($_GET['application_id'] ?? $_GET['app_id'] ?? 0);
        $eventId = (int)($_GET['event_id'] ?? 0);
        if (!$applicationId && !$eventId) galonlyStaffFail('缺少查询参数');

        if ($applicationId) {
            $stmt = $db->prepare("SELECT a.*, u.nickname, u.username, u.avatar_url FROM galonly_staff_applications a JOIN users u ON a.user_id = u.id WHERE a.id = ?");
            $stmt->execute([$applicationId]);
        } else {
            $stmt = $db->prepare("SELECT a.*, u.nickname, u.username, u.avatar_url FROM galonly_staff_applications a JOIN users u ON a.user_id = u.id WHERE a.event_id = ? AND a.user_id = ? ORDER BY a.updated_at DESC, a.id DESC LIMIT 1");
            $stmt->execute([$eventId, $user['id']]);
        }
        $application = $stmt->fetch();
        if (!$application) galonlyStaffFail('申请不存在');
        if ((int)$application['user_id'] !== (int)$user['id'] && !hasAuditPermission($user)) {
            galonlyStaffFail('无权查看该申请', 403);
        }
        echo json_encode(['success' => true, 'application' => galonlyDecodeStaffRow($application)], JSON_UNESCAPED_UNICODE);
        exit();

    case 'update_staff':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') galonlyStaffFail('仅支持 POST 请求', 405);

        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input)) galonlyStaffFail('请求数据格式错误');
        $applicationId = (int)($input['application_id'] ?? $input['app_id'] ?? 0);
        if (!$applicationId) galonlyStaffFail('缺少申请 ID');

        $db = getDB();
        galonlyEnsureStaffSchema($db);
        $stmt = $db->prepare("SELECT * FROM galonly_staff_applications WHERE id = ? AND user_id = ?");
        $stmt->execute([$applicationId, $user['id']]);
        $existing = $stmt->fetch();
        if (!$existing) galonlyStaffFail('申请不存在或无权操作');

        if (empty($input['event_id'])) $input['event_id'] = $existing['event_id'];
        $payload = galonlyStaffPayload($input);
        if ((int)$payload['event_id'] !== (int)$existing['event_id']) galonlyStaffFail('活动 ID 不匹配');
        if ($message = galonlyStaffValidate($payload)) galonlyStaffFail($message);
        if (!galonlyStaffIsIndividualApplicant($payload) && !galonlyStaffUserHasClub($db, (int)$user['id'], $payload['club_id'], $payload['club_country'])) {
            galonlyStaffFail('只能选择你已加入的高校社团');
        }

        $status = $existing['status'];
        $resubmitted = (int)$existing['resubmitted'];
        $hasUpdate = (int)$existing['has_update'];
        $vote = $existing['vote'];
        $votedBy = $existing['voted_by'];
        if ($status === 'rejected') {
            $status = 'pending';
            $resubmitted = 1;
            $vote = null;
            $votedBy = null;
        } elseif ($status === 'confirmed') {
            $hasUpdate = 1;
        }

        $now = date('Y-m-d H:i:s');
        $stmt = $db->prepare("
            UPDATE galonly_staff_applications
            SET cn_name = ?, qq_number = ?, phone_number = ?, email = ?, club_id = ?, club_country = ?,
                positions = ?, confirm_schedule = ?, is_cosplay = ?, three_day_available = ?, gender = ?, staff_experience = ?, skills = ?, self_intro = ?,
                status = ?, voted_by = ?, vote = ?, resubmitted = ?, has_update = ?, updated_at = ?
            WHERE id = ?
        ");
        $stmt->execute([
            $payload['cn_name'], $payload['qq_number'], $payload['phone_number'], $payload['email'],
            $payload['club_id'], $payload['club_country'], json_encode($payload['positions'], JSON_UNESCAPED_UNICODE),
            $payload['confirm_schedule'], $payload['is_cosplay'], $payload['three_day_available'],
            $payload['gender'], $payload['staff_experience'], $payload['skills'],
            $payload['self_intro'],
            $status, $votedBy, $vote, $resubmitted, $hasUpdate, $now, $applicationId,
        ]);
        logAction('galonly.update_staff', 'galonly_staff_application', $applicationId);
        echo json_encode(['success' => true, 'message' => '申请已更新'], JSON_UNESCAPED_UNICODE);
        exit();

    case 'delete_staff_application':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') galonlyStaffFail('仅支持 POST 请求', 405);

        $user = requireLogin();
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input)) $input = [];
        $applicationId = (int)($input['application_id'] ?? $_GET['application_id'] ?? 0);
        if (!$applicationId) galonlyStaffFail('缺少申请 ID');

        $db = getDB();
        galonlyEnsureStaffSchema($db);
        $stmt = $db->prepare("SELECT id, status FROM galonly_staff_applications WHERE id = ? AND user_id = ?");
        $stmt->execute([$applicationId, $user['id']]);
        $application = $stmt->fetch();
        if (!$application) galonlyStaffFail('申请不存在或无权操作');
        if ($application['status'] === 'confirmed') galonlyStaffFail('已确认的申请无法删除');
        $db->prepare("DELETE FROM galonly_staff_applications WHERE id = ?")->execute([$applicationId]);
        logAction('galonly.delete_staff_application', 'galonly_staff_application', $applicationId);
        echo json_encode(['success' => true, 'message' => '申请已删除'], JSON_UNESCAPED_UNICODE);
        exit();

    case 'list_staff_applications':
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') galonlyStaffFail('仅支持 GET 请求', 405);

        $user = requireLogin();
        if (!hasAuditPermission($user)) galonlyStaffFail('无审核权限', 403);
        $db = getDB();
        galonlyEnsureStaffSchema($db);
        $eventId = (int)($_GET['event_id'] ?? 0);
        $status = trim((string)($_GET['status'] ?? 'all'));
        $sql = "SELECT a.*, u.nickname, u.username, u.avatar_url
                FROM galonly_staff_applications a
                JOIN users u ON a.user_id = u.id
                WHERE 1=1";
        $params = [];
        if ($eventId > 0) {
            $sql .= " AND a.event_id = ?";
            $params[] = $eventId;
        }
        if ($status !== '' && $status !== 'all') {
            $sql .= " AND a.status = ?";
            $params[] = $status;
        }
        $sql .= " ORDER BY a.created_at DESC";
        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        $applications = array_map('galonlyDecodeStaffRow', $stmt->fetchAll());
        echo json_encode(['success' => true, 'applications' => $applications], JSON_UNESCAPED_UNICODE);
        exit();

    case 'vote_staff':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') galonlyStaffFail('仅支持 POST 请求', 405);

        $user = requireLogin();
        if (!hasAuditPermission($user)) galonlyStaffFail('无审核权限', 403);
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input)) $input = [];
        $applicationId = (int)($input['application_id'] ?? 0);
        $vote = $input['vote'] ?? '';
        if (!$applicationId) galonlyStaffFail('缺少申请 ID');
        if (!in_array($vote, ['approve', 'reject'], true)) galonlyStaffFail('无效的投票选项');

        $db = getDB();
        galonlyEnsureStaffSchema($db);
        $stmt = $db->prepare("
            SELECT a.*, e.name AS event_name
            FROM galonly_staff_applications a
            LEFT JOIN galonly_events e ON a.event_id = e.id
            WHERE a.id = ?
        ");
        $stmt->execute([$applicationId]);
        $application = $stmt->fetch();
        if (!$application) galonlyStaffFail('申请不存在');
        if ($application['status'] === 'confirmed') galonlyStaffFail('名单已确认，不能重新投票');
        if (!empty($application['voted_by'])) galonlyStaffFail('该申请已被审核处理');

        $result = $vote === 'approve' ? 'pooled' : 'rejected';
        $db->prepare("UPDATE galonly_staff_applications SET status = ?, voted_by = ?, vote = ?, updated_at = ? WHERE id = ?")
            ->execute([$result, $user['id'], $vote, date('Y-m-d H:i:s'), $applicationId]);
        $application['status'] = $result;
        galonlyNotifyStaffApplicant($application, $result);
        logAction('galonly.vote_staff', 'galonly_staff_application', $applicationId, ['vote' => $vote]);
        echo json_encode(['success' => true, 'result' => $result, 'vote_by' => $user['id']], JSON_UNESCAPED_UNICODE);
        exit();

    case 'withdraw_staff_vote':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') galonlyStaffFail('仅支持 POST 请求', 405);

        $user = requireLogin();
        if (!hasAuditPermission($user)) galonlyStaffFail('无审核权限', 403);
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input)) $input = [];
        $applicationId = (int)($input['application_id'] ?? 0);
        if (!$applicationId) galonlyStaffFail('缺少申请 ID');

        $db = getDB();
        galonlyEnsureStaffSchema($db);
        $stmt = $db->prepare("
            SELECT a.*, e.name AS event_name
            FROM galonly_staff_applications a
            LEFT JOIN galonly_events e ON a.event_id = e.id
            WHERE a.id = ?
        ");
        $stmt->execute([$applicationId]);
        $application = $stmt->fetch();
        if (!$application) galonlyStaffFail('申请不存在');
        if ($application['status'] === 'confirmed') galonlyStaffFail('名单已确认，请先解锁名单');
        if (empty($application['voted_by'])) galonlyStaffFail('该申请尚未被投票');

        $db->prepare("UPDATE galonly_staff_applications SET status = 'pending', voted_by = NULL, vote = NULL, updated_at = ? WHERE id = ?")
            ->execute([date('Y-m-d H:i:s'), $applicationId]);
        galonlyNotifyStaffApplicant($application, 'pending');
        logAction('galonly.withdraw_staff_vote', 'galonly_staff_application', $applicationId);
        echo json_encode(['success' => true, 'result' => 'pending'], JSON_UNESCAPED_UNICODE);
        exit();

    case 'finalize_staff_roster':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') galonlyStaffFail('仅支持 POST 请求', 405);

        $user = requireLogin();
        if (!hasAuditPermission($user)) galonlyStaffFail('无审核权限', 403);
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input)) $input = [];
        $eventId = (int)($input['event_id'] ?? 0);
        if (!$eventId) galonlyStaffFail('缺少活动 ID');

        $db = getDB();
        galonlyEnsureStaffSchema($db);
        $event = galonlyStaffEvent($db, $eventId);
        if (!$event) galonlyStaffFail('活动不存在');
        if ((int)($event['staff_roster_finalized'] ?? 0) === 1) galonlyStaffFail('名单已确认，如需修改请先解锁');

        $stmt = $db->prepare("SELECT a.*, u.nickname, u.username FROM galonly_staff_applications a JOIN users u ON a.user_id = u.id WHERE a.event_id = ? AND a.status = 'pooled'");
        $stmt->execute([$eventId]);
        $pooled = $stmt->fetchAll();
        $required = (int)($event['staff_required_count'] ?? 0);
        if (count($pooled) < $required) {
            galonlyStaffFail('候选池人数不足，当前 ' . count($pooled) . ' 人，需要 ' . $required . ' 人');
        }

        $db->beginTransaction();
        try {
            $now = date('Y-m-d H:i:s');
            $db->prepare("UPDATE galonly_staff_applications SET status = 'confirmed', updated_at = ? WHERE event_id = ? AND status = 'pooled'")
                ->execute([$now, $eventId]);
            $db->prepare("UPDATE galonly_events SET staff_roster_finalized = 1 WHERE id = ?")->execute([$eventId]);
            $db->commit();
        } catch (Exception $e) {
            $db->rollBack();
            galonlyStaffFail('名单确认失败：' . $e->getMessage());
        }

        foreach ($pooled as $row) {
            galonlyNotifyStaffApplicant($row, 'confirmed', $event);
        }
        logAction('galonly.finalize_staff_roster', 'galonly_event', $eventId);
        echo json_encode([
            'success' => true,
            'confirmed_count' => count($pooled),
            'roster' => array_map(fn($row) => [
                'id' => (int)$row['id'],
                'user_id' => (int)$row['user_id'],
                'nickname' => $row['cn_name'] ?: ($row['nickname'] ?: $row['username']),
                'positions' => galonlyJsonArray($row['positions'] ?? []),
            ], $pooled),
        ], JSON_UNESCAPED_UNICODE);
        exit();

    case 'unlock_staff_roster':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') galonlyStaffFail('仅支持 POST 请求', 405);

        $user = requireLogin();
        if (!hasAuditPermission($user)) galonlyStaffFail('无审核权限', 403);
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input)) $input = [];
        $eventId = (int)($input['event_id'] ?? 0);
        if (!$eventId) galonlyStaffFail('缺少活动 ID');

        $db = getDB();
        galonlyEnsureStaffSchema($db);
        $event = galonlyStaffEvent($db, $eventId);
        if (!$event) galonlyStaffFail('活动不存在');
        if ((int)($event['staff_roster_finalized'] ?? 0) === 0) galonlyStaffFail('名单尚未确认，无需解锁');

        $stmt = $db->prepare("SELECT * FROM galonly_staff_applications WHERE event_id = ? AND status = 'confirmed'");
        $stmt->execute([$eventId]);
        $confirmed = $stmt->fetchAll();

        $now = date('Y-m-d H:i:s');
        $db->prepare("UPDATE galonly_events SET staff_roster_finalized = 0 WHERE id = ?")->execute([$eventId]);
        $db->prepare("UPDATE galonly_staff_applications SET status = 'pooled', updated_at = ? WHERE event_id = ? AND status = 'confirmed'")
            ->execute([$now, $eventId]);
        foreach ($confirmed as $row) {
            galonlyNotifyStaffApplicant($row, 'unlocked', $event);
        }
        logAction('galonly.unlock_staff_roster', 'galonly_event', $eventId);
        echo json_encode(['success' => true, 'message' => '名单已解锁'], JSON_UNESCAPED_UNICODE);
        exit();

    case 'update_staff_event_config':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') galonlyStaffFail('仅支持 POST 请求', 405);

        $user = requireLogin();
        if (!hasAuditPermission($user)) galonlyStaffFail('无审核权限', 403);
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input)) $input = [];
        $eventId = (int)($input['event_id'] ?? 0);
        if (!$eventId) galonlyStaffFail('缺少活动 ID');

        $db = getDB();
        galonlyEnsureStaffSchema($db);
        if (!galonlyStaffEvent($db, $eventId)) galonlyStaffFail('活动不存在');

        $fields = [];
        $params = [];
        if (array_key_exists('staff_deadline', $input)) {
            $value = trim((string)$input['staff_deadline']);
            $fields[] = 'staff_deadline = ?';
            $params[] = $value === '' ? null : str_replace('T', ' ', $value);
        }
        if (array_key_exists('staff_max_applicants', $input)) {
            $value = $input['staff_max_applicants'];
            $fields[] = 'staff_max_applicants = ?';
            $params[] = ($value === '' || $value === null) ? null : max(0, (int)$value);
        }
        if (array_key_exists('staff_required_count', $input)) {
            $fields[] = 'staff_required_count = ?';
            $params[] = max(0, (int)$input['staff_required_count']);
        }
        if (array_key_exists('staff_registration_open', $input)) {
            $fields[] = 'staff_registration_open = ?';
            $params[] = (int)$input['staff_registration_open'] ? 1 : 0;
        }
        if (!$fields) galonlyStaffFail('没有需要更新的字段');

        $params[] = $eventId;
        $stmt = $db->prepare("UPDATE galonly_events SET " . implode(', ', $fields) . " WHERE id = ?");
        $stmt->execute($params);
        logAction('galonly.update_staff_event_config', 'galonly_event', $eventId, ['fields' => array_keys($input)]);
        echo json_encode(['success' => true, 'message' => '活动 Staff 配置已更新'], JSON_UNESCAPED_UNICODE);
        exit();

    case 'add_event':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        if (!hasAuditPermission($user)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '权限不足'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $input = json_decode(file_get_contents('php://input'), true);
        $name = trim($input['name'] ?? '');
        $location = trim($input['location'] ?? '');
        $date = trim($input['date'] ?? '');
        $description = trim($input['description'] ?? '');

        if (!$name || !$date) {
            echo json_encode(['success' => false, 'message' => '活动名称和日期为必填项'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();
        $stmt = $db->prepare(
            "INSERT INTO galonly_events (name, location, date, registration_open, description, created_at)
             VALUES (?, ?, ?, 1, ?, ?)"
        );
        $now = date('Y-m-d H:i:s');
        $stmt->execute([$name, $location, $date, $description, $now]);
        $eventId = (int)$db->lastInsertId();

        logAction('galonly.add_event', 'galonly_event', $eventId, ['name' => $name]);

        echo json_encode(['success' => true, 'event_id' => $eventId], JSON_UNESCAPED_UNICODE);
        exit();

    case 'delete_event':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        if (!hasAuditPermission($user)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '权限不足'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $input = json_decode(file_get_contents('php://input'), true);
        $eventId = (int)($input['event_id'] ?? 0);

        if (!$eventId) {
            echo json_encode(['success' => false, 'message' => '缺少 event_id'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();
        $stmt = $db->prepare("SELECT id FROM galonly_events WHERE id = ?");
        $stmt->execute([$eventId]);
        if (!$stmt->fetch()) {
            echo json_encode(['success' => false, 'message' => '活动不存在'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        // 删除关联数据（投票、申请同好会、申请）
        $db->beginTransaction();
        try {
            $appIds = $db->prepare("SELECT id FROM galonly_applications WHERE event_id = ?");
            $appIds->execute([$eventId]);
            $ids = $appIds->fetchAll(PDO::FETCH_COLUMN);

            if ($ids) {
                $placeholders = implode(',', array_fill(0, count($ids), '?'));
                $db->prepare("DELETE FROM galonly_votes WHERE application_id IN ($placeholders)")->execute($ids);
                $db->prepare("DELETE FROM galonly_application_clubs WHERE application_id IN ($placeholders)")->execute($ids);
                $db->prepare("DELETE FROM galonly_applications WHERE id IN ($placeholders)")->execute($ids);
            }

            $db->prepare("DELETE FROM galonly_events WHERE id = ?")->execute([$eventId]);
            $db->commit();

            logAction('galonly.delete_event', 'galonly_event', $eventId);
            echo json_encode(['success' => true], JSON_UNESCAPED_UNICODE);
        } catch (Exception $e) {
            $db->rollBack();
            echo json_encode(['success' => false, 'message' => '删除失败：' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
        }
        exit();

    case 'update_event':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $user = requireLogin();
        if (!hasAuditPermission($user)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => '权限不足'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $input = json_decode(file_get_contents('php://input'), true);
        $eventId = (int)($input['event_id'] ?? 0);

        if (!$eventId) {
            echo json_encode(['success' => false, 'message' => '缺少 event_id'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $db = getDB();
        $stmt = $db->prepare("SELECT id FROM galonly_events WHERE id = ?");
        $stmt->execute([$eventId]);
        if (!$stmt->fetch()) {
            echo json_encode(['success' => false, 'message' => '活动不存在'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $fields = [];
        $params = [];

        if (isset($input['registration_open'])) {
            $fields[] = 'registration_open = ?';
            $params[] = (int)$input['registration_open'] ? 1 : 0;
        }
        if (isset($input['name'])) {
            $fields[] = 'name = ?';
            $params[] = trim($input['name']);
        }
        if (isset($input['location'])) {
            $fields[] = 'location = ?';
            $params[] = trim($input['location']);
        }
        if (isset($input['date'])) {
            $fields[] = 'date = ?';
            $params[] = trim($input['date']);
        }
        if (isset($input['description'])) {
            $fields[] = 'description = ?';
            $params[] = trim($input['description']);
        }

        if (empty($fields)) {
            echo json_encode(['success' => false, 'message' => '没有需要更新的字段'], JSON_UNESCAPED_UNICODE);
            exit();
        }

        $params[] = $eventId;
        $sql = "UPDATE galonly_events SET " . implode(', ', $fields) . " WHERE id = ?";
        $stmt = $db->prepare($sql);
        $stmt->execute($params);

        logAction('galonly.update_event', 'galonly_event', $eventId, ['fields' => array_keys($input)]);

        echo json_encode(['success' => true, 'message' => '活动已更新'], JSON_UNESCAPED_UNICODE);
        exit();

    default:
        echo json_encode(['success' => false, 'message' => '未知动作', 'available_actions' => [
            'list_events', 'list_participants', 'check_eligibility', 'submit', 'get_application',
            'update_application', 'delete_application', 'upload_image', 'upload_file',
            'list_applications', 'vote', 'withdraw_vote', 'cast_public_vote',
            'resolve', 'undo_resolve', 'submit_merchandise', 'get_merchandise', 'resolve_product',
            'list_reviewers', 'save_reviewers',
            'submit_staff', 'get_staff_application', 'update_staff', 'delete_staff_application',
            'list_staff_applications', 'vote_staff', 'withdraw_staff_vote',
            'finalize_staff_roster', 'unlock_staff_roster', 'update_staff_event_config',
            'add_event', 'delete_event', 'update_event',
        ]], JSON_UNESCAPED_UNICODE);
        exit();
}
