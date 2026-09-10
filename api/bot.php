<?php
// api/bot.php - private read-only aggregation API for AstrBot and other bots.

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

// auto_approve and similar mutating actions bypass the GET-only check
$action = trim((string)($_GET['action'] ?? ''));
$sessionActions = ['bot_tokens_list', 'bot_tokens_create', 'bot_tokens_revoke'];
$mutatingActions = ['auto_approve', 'membership_approve', 'membership_reject', 'bot_tokens_create', 'bot_tokens_revoke'];
$isReadAction = !in_array($action, $mutatingActions, true);
if ($isReadAction && $_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => 'GET only'], JSON_UNESCAPED_UNICODE);
    exit();
}

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/auth.php';
if (file_exists(__DIR__ . '/../includes/audit.php')) {
    require_once __DIR__ . '/../includes/audit.php';
}
require_once __DIR__ . '/../includes/growth.php';
if (file_exists(__DIR__ . '/../includes/japan_prefectures.php')) {
    require_once __DIR__ . '/../includes/japan_prefectures.php';
}
require_once __DIR__ . '/../includes/image_proxy_helper.php';
if (file_exists(__DIR__ . '/../includes/galonly_merchandise.php')) {
    require_once __DIR__ . '/../includes/galonly_merchandise.php';
}

function botRespond(array $payload, int $status = 200): void {
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit();
}

function botTokenFromRequest(): string {
    $token = trim((string)($_GET['token'] ?? ''));
    if ($token !== '') {
        return $token;
    }
    $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (preg_match('/^Bearer\s+(.+)$/i', $authHeader, $matches)) {
        return trim($matches[1]);
    }
    return '';
}

function botConfiguredToken(): string {
    if (defined('BOT_API_KEY') && trim((string)BOT_API_KEY) !== '') {
        return trim((string)BOT_API_KEY);
    }
    if (defined('LEGACY_AUTH_ENABLED') && LEGACY_AUTH_ENABLED && defined('ADMIN_TOKEN')) {
        return trim((string)ADMIN_TOKEN);
    }
    return '';
}

function botInputJson(): array {
    $data = json_decode((string)file_get_contents('php://input'), true);
    return is_array($data) ? $data : [];
}

function botDbDriver(PDO $db): string {
    try {
        return (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME);
    } catch (Throwable $e) {
        return '';
    }
}

function botEnsureClubTokenTable(?PDO $db = null): void {
    $db = $db ?: botDb();
    if (!$db) return;
    $driver = botDbDriver($db);
    try {
        if ($driver === 'sqlite') {
            $db->exec("
                CREATE TABLE IF NOT EXISTS club_bot_tokens (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    club_id INTEGER NOT NULL,
                    country TEXT DEFAULT 'china',
                    name TEXT DEFAULT '',
                    token_prefix TEXT NOT NULL,
                    token_hash TEXT NOT NULL,
                    permissions TEXT DEFAULT '[]',
                    created_by INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    last_used_at TEXT,
                    revoked_at TEXT
                )
            ");
            $db->exec("CREATE INDEX IF NOT EXISTS idx_club_bot_tokens_club ON club_bot_tokens(club_id, country)");
            $db->exec("CREATE INDEX IF NOT EXISTS idx_club_bot_tokens_prefix ON club_bot_tokens(token_prefix)");
            return;
        }
        $db->exec("
            CREATE TABLE IF NOT EXISTS club_bot_tokens (
                id INT AUTO_INCREMENT PRIMARY KEY,
                club_id INT NOT NULL,
                country VARCHAR(20) DEFAULT 'china',
                name VARCHAR(120) DEFAULT '',
                token_prefix VARCHAR(64) NOT NULL,
                token_hash VARCHAR(255) NOT NULL,
                permissions TEXT,
                created_by INT NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_used_at DATETIME NULL,
                revoked_at DATETIME NULL,
                INDEX idx_club_bot_tokens_club (club_id, country),
                INDEX idx_club_bot_tokens_prefix (token_prefix)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");
    } catch (Throwable $e) {
        // Existing deployments can still use the global BOT_API_KEY if table creation fails.
    }
}

function botDecodePermissions($value): array {
    if (is_array($value)) return $value;
    $decoded = json_decode((string)($value ?? ''), true);
    return is_array($decoded) ? array_values(array_filter(array_map('strval', $decoded))) : [];
}

function botClubTokenPrefix(string $token): string {
    return substr($token, 0, 22);
}

function botGenerateClubToken(): string {
    return 'gmap_club_' . bin2hex(random_bytes(24));
}

function botCanManageClubToken(array $user, int $clubId, string $country): bool {
    if (($user['role'] ?? '') === 'super_admin') return true;
    if (function_exists('canManageClubInCountry')) {
        return canManageClubInCountry($user, $clubId, $country);
    }
    return false;
}

function botPublicTokenRow(array $row): array {
    return [
        'id' => (int)($row['id'] ?? 0),
        'club_id' => (int)($row['club_id'] ?? 0),
        'country' => botString($row['country'] ?? 'china') ?: 'china',
        'name' => botString($row['name'] ?? ''),
        'token_prefix' => botString($row['token_prefix'] ?? ''),
        'permissions' => botDecodePermissions($row['permissions'] ?? '[]'),
        'created_by' => (int)($row['created_by'] ?? 0),
        'created_at' => botString($row['created_at'] ?? ''),
        'last_used_at' => botString($row['last_used_at'] ?? ''),
        'revoked_at' => botString($row['revoked_at'] ?? ''),
        'active' => botString($row['revoked_at'] ?? '') === '',
    ];
}

function authBot(): array {
    $expected = botConfiguredToken();
    $actual = botTokenFromRequest();
    if ($actual !== '' && str_starts_with($actual, 'gmap_club_')) {
        $db = botDb();
        if (!$db) botRespond(['success' => false, 'error' => 'database unavailable'], 500);
        botEnsureClubTokenTable($db);
        $prefix = botClubTokenPrefix($actual);
        try {
            $stmt = $db->prepare(
                "SELECT id, club_id, country, name, token_prefix, token_hash, permissions, revoked_at
                 FROM club_bot_tokens
                 WHERE token_prefix = ? AND revoked_at IS NULL
                 ORDER BY id DESC"
            );
            $stmt->execute([$prefix]);
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                if (password_verify($actual, (string)($row['token_hash'] ?? ''))) {
                    try {
                        $db->prepare("UPDATE club_bot_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?")->execute([(int)$row['id']]);
                    } catch (Throwable $e) {}
                    return [
                        'type' => 'club',
                        'token_id' => (int)$row['id'],
                        'club_id' => (int)$row['club_id'],
                        'country' => botString($row['country'] ?? 'china') ?: 'china',
                        'name' => botString($row['name'] ?? ''),
                        'permissions' => botDecodePermissions($row['permissions'] ?? '[]'),
                    ];
                }
            }
        } catch (Throwable $e) {
            botRespond(['success' => false, 'error' => 'club token query failed'], 500);
        }
        botRespond(['success' => false, 'error' => '无效的同好会 Bot token'], 401);
    }
    if ($expected === '') {
        botRespond(['success' => false, 'error' => 'BOT_API_KEY 未配置'], 500);
    }
    $valid = function_exists('hash_equals') ? hash_equals($expected, $actual) : ($expected === $actual);
    if (!$valid) botRespond(['success' => false, 'error' => '无效的 API 密钥'], 401);
    return ['type' => 'global', 'permissions' => ['all']];
}

function botLoadJson(string $path, array $fallback = []): array {
    if (!file_exists($path)) return $fallback;
    $data = json_decode((string)file_get_contents($path), true);
    return is_array($data) ? $data : $fallback;
}

function botRows(string $path, string $key): array {
    $data = botLoadJson($path, [$key => []]);
    $rows = $data[$key] ?? [];
    return is_array($rows) ? $rows : [];
}

function botString($value): string {
    return trim((string)($value ?? ''));
}

function botBoolParam(string $key): bool {
    $value = strtolower(trim((string)($_GET[$key] ?? '')));
    return in_array($value, ['1', 'true', 'yes', 'full'], true);
}

function botLimit(int $default = 20, int $max = 100): int {
    $limit = (int)($_GET['limit'] ?? $default);
    if ($limit < 1) return $default;
    return min($limit, $max);
}

function botQuery(): string {
    return botString($_GET['q'] ?? $_GET['query'] ?? $_GET['keyword'] ?? '');
}

function botContainsText(string $haystack, string $needle): bool {
    if ($needle === '') return true;
    if (function_exists('mb_stripos')) {
        return mb_stripos($haystack, $needle, 0, 'UTF-8') !== false;
    }
    return stripos($haystack, $needle) !== false || strpos($haystack, $needle) !== false;
}

function botSiteUrl(): string {
    return defined('SITE_URL') ? rtrim((string)SITE_URL, '/') : '';
}

function botAbsUrl(string $url): string {
    $url = trim($url);
    if ($url === '') return '';
    if (preg_match('/^https?:\/\//i', $url)) return $url;
    $site = botSiteUrl();
    if ($site === '') return $url;
    return $site . '/' . ltrim($url, '/');
}

function botCountry(): string {
    $country = strtolower(botString($_GET['country'] ?? 'all'));
    return in_array($country, ['china', 'japan', 'all'], true) ? $country : 'all';
}

function botNormalizeChinaRegion(string $value): string {
    $value = trim($value);
    if ($value === '') return '';
    $map = [
        '北京' => '北京', '北京市' => '北京', '京' => '北京',
        '天津' => '天津', '天津市' => '天津', '津' => '天津',
        '上海' => '上海', '上海市' => '上海', '沪' => '上海',
        '重庆' => '重庆', '重庆市' => '重庆', '渝' => '重庆',
        '河北' => '河北', '河北省' => '河北', '冀' => '河北',
        '山西' => '山西', '山西省' => '山西', '晋' => '山西',
        '辽宁' => '辽宁', '辽宁省' => '辽宁', '辽' => '辽宁',
        '吉林' => '吉林', '吉林省' => '吉林', '吉' => '吉林',
        '黑龙江' => '黑龙江', '黑龙江省' => '黑龙江', '黑' => '黑龙江',
        '江苏' => '江苏', '江苏省' => '江苏', '苏' => '江苏',
        '浙江' => '浙江', '浙江省' => '浙江', '浙' => '浙江',
        '安徽' => '安徽', '安徽省' => '安徽', '皖' => '安徽',
        '福建' => '福建', '福建省' => '福建', '闽' => '福建',
        '江西' => '江西', '江西省' => '江西', '赣' => '江西',
        '山东' => '山东', '山东省' => '山东', '鲁' => '山东',
        '河南' => '河南', '河南省' => '河南', '豫' => '河南',
        '湖北' => '湖北', '湖北省' => '湖北', '鄂' => '湖北',
        '湖南' => '湖南', '湖南省' => '湖南', '湘' => '湖南',
        '广东' => '广东', '广东省' => '广东', '粤' => '广东',
        '海南' => '海南', '海南省' => '海南', '琼' => '海南',
        '四川' => '四川', '四川省' => '四川', '川' => '四川', '蜀' => '四川',
        '贵州' => '贵州', '贵州省' => '贵州', '贵' => '贵州', '黔' => '贵州',
        '云南' => '云南', '云南省' => '云南', '云' => '云南', '滇' => '云南',
        '陕西' => '陕西', '陕西省' => '陕西', '陕' => '陕西', '秦' => '陕西',
        '甘肃' => '甘肃', '甘肃省' => '甘肃', '甘' => '甘肃', '陇' => '甘肃',
        '青海' => '青海', '青海省' => '青海', '青' => '青海',
        '台湾' => '台湾', '台湾省' => '台湾', '台' => '台湾',
        '广西' => '广西', '广西壮族自治区' => '广西', '桂' => '广西',
        '西藏' => '西藏', '西藏自治区' => '西藏', '藏' => '西藏',
        '宁夏' => '宁夏', '宁夏回族自治区' => '宁夏', '宁' => '宁夏',
        '新疆' => '新疆', '新疆维吾尔自治区' => '新疆', '新' => '新疆',
        '内蒙古' => '内蒙古', '内蒙古自治区' => '内蒙古', '蒙' => '内蒙古',
        '香港' => '香港', '香港特别行政区' => '香港', '港' => '香港',
        '澳门' => '澳门', '澳门特别行政区' => '澳门', '澳' => '澳门',
        '海外' => '海外',
    ];
    return $map[$value] ?? preg_replace('/(壮族自治区|回族自治区|维吾尔自治区|特别行政区|自治区|省|市)$/u', '', $value);
}

function botNormalizeJapanRegion(string $value): string {
    if (function_exists('normalizeJapanPrefectureName')) {
        return normalizeJapanPrefectureName($value);
    }
    return trim($value);
}

function botClubRegion(array $club, string $country): string {
    $region = $country === 'japan'
        ? botString($club['prefecture'] ?? $club['province'] ?? '')
        : botString($club['province'] ?? $club['prefecture'] ?? '');
    return $country === 'japan' ? botNormalizeJapanRegion($region) : botNormalizeChinaRegion($region);
}

function botLoadClubs(?string $country = null): array {
    $sources = [];
    if ($country === null || $country === 'all' || $country === 'china') {
        $sources[] = ['country' => 'china', 'rows' => botRows(__DIR__ . '/../data/clubs.json', 'data')];
    }
    if ($country === null || $country === 'all' || $country === 'japan') {
        $sources[] = ['country' => 'japan', 'rows' => botRows(__DIR__ . '/../data/clubs_japan.json', 'data')];
    }

    $clubs = [];
    foreach ($sources as $source) {
        foreach ($source['rows'] as $club) {
            if (!is_array($club)) continue;
            $club['country'] = $source['country'];
            $clubs[] = $club;
        }
    }
    usort($clubs, fn($a, $b) => [$a['country'] ?? '', (int)($a['id'] ?? 0)] <=> [$b['country'] ?? '', (int)($b['id'] ?? 0)]);
    return $clubs;
}

function botTextMatches(array $row, string $query, array $fields): bool {
    if ($query === '') return true;
    $keywords = preg_split('/\s+/u', $query) ?: [];
    foreach ($keywords as $keyword) {
        if ($keyword === '') continue;
        $matched = false;
        foreach ($fields as $field) {
            $value = $row[$field] ?? '';
            if (is_array($value)) $value = json_encode($value, JSON_UNESCAPED_UNICODE);
            if ($value !== '' && botContainsText((string)$value, $keyword)) {
                $matched = true;
                break;
            }
        }
        if (!$matched) return false;
    }
    return true;
}

function botDb(): ?PDO {
    static $db = null;
    static $attempted = false;
    if (!$attempted) {
        $attempted = true;
        try {
            require_once __DIR__ . '/../includes/db.php';
            $db = getDB();
        } catch (Throwable $e) {
            $db = null;
        }
    }
    return $db;
}

function botMemberCounts(): array {
    $db = botDb();
    if (!$db) return [];
    try {
        $stmt = $db->query("SELECT club_id, COALESCE(country, 'china') AS country, COUNT(*) AS cnt FROM club_memberships WHERE status = 'active' AND role <> 'external' GROUP BY club_id, COALESCE(country, 'china')");
        $result = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $key = ($row['country'] ?: 'china') . ':' . (int)$row['club_id'];
            $result[$key] = (int)$row['cnt'];
        }
        return $result;
    } catch (Throwable $e) {
        try {
            $stmt = $db->query("SELECT club_id, COUNT(*) AS cnt FROM club_memberships WHERE status = 'active' AND role <> 'external' GROUP BY club_id");
            $result = [];
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $result['china:' . (int)$row['club_id']] = (int)$row['cnt'];
            }
            return $result;
        } catch (Throwable $e2) {
            return [];
        }
    }
}

function botClubKey(array $club): string {
    return ($club['country'] ?? 'china') . ':' . (int)($club['id'] ?? 0);
}

function botWikiIndex(): array {
    $rows = botLoadJson(__DIR__ . '/../wiki/index.json', []);
    return is_array($rows) ? $rows : [];
}

function botWikiForClub(string $country, int $id): ?array {
    $wiki = botWikiIndex();
    $key = $country . '-' . $id;
    if (!isset($wiki[$key]) || !is_array($wiki[$key])) return null;
    $row = $wiki[$key];
    if (!empty($row['url'])) $row['url'] = botAbsUrl((string)$row['url']);
    return $row;
}

function botPublicationsForClub(array $club): array {
    $country = $club['country'] ?? 'china';
    $id = (int)($club['id'] ?? 0);
    $name = botString($club['display_name'] ?? $club['name'] ?? '');
    $shortName = botString($club['name'] ?? '');
    $items = [];
    foreach (botRows(__DIR__ . '/../data/publications.json', 'publications') as $pub) {
        $matched = false;
        foreach (($pub['club_ids'] ?? []) as $clubRef) {
            if ((int)($clubRef['id'] ?? 0) === $id && ($clubRef['country'] ?? 'china') === $country) {
                $matched = true;
                break;
            }
        }
        if (!$matched) {
            $clubName = botString($pub['clubName'] ?? '');
            $matched = $clubName !== '' && ($clubName === $name || $clubName === $shortName);
        }
        if ($matched) {
            $items[] = botPublicationRow($pub, false);
        }
    }
    return $items;
}

function botClubRow(array $club, bool $full = false, ?array $memberCounts = null): array {
    $country = $club['country'] ?? 'china';
    $id = (int)($club['id'] ?? 0);
    $region = botClubRegion($club, $country);
    $row = [
        'id' => $id,
        'key' => $country . ':' . $id,
        'country' => $country,
        'name' => botString($club['display_name'] ?? $club['name'] ?? ''),
        'short_name' => botString($club['name'] ?? ''),
        'school' => botString($club['school'] ?? ''),
        'region' => $region,
        'province' => $country === 'china' ? $region : '',
        'prefecture' => $country === 'japan' ? $region : '',
        'type' => botString($club['type'] ?? 'school') ?: 'school',
        'verified' => (int)($club['verified'] ?? 0),
        'project' => botString($club['project'] ?? 'galgame') ?: 'galgame',
        'created_at' => botString($club['created_at'] ?? ''),
        'logo_url' => botAbsUrl(botString($club['logo_url'] ?? '')),
        'share_url' => botAbsUrl('club_share.html?club=' . rawurlencode($country . ':' . $id)),
        'external_links' => botString($club['external_links'] ?? ''),
        'member_count' => 0,
    ];

    if ($memberCounts !== null) {
        $row['member_count'] = $memberCounts[$country . ':' . $id] ?? 0;
    }

    $contact = botString($club['info'] ?? '');
    if ($full) {
        $row['contact'] = $contact;
        $row['contact_hidden'] = false;
        $row['remark'] = botString($club['remark'] ?? '');
        $row['raw_text'] = botString($club['raw_text'] ?? '');
        $row['protected'] = (int)($club['protected'] ?? 0);
        $row['visible_by_default'] = (int)($club['visible_by_default'] ?? 0);
    } else {
        $visible = !empty($club['visible_by_default']);
        $row['contact'] = $visible ? $contact : '';
        $row['contact_hidden'] = !$visible && $contact !== '';
    }

    return $row;
}

function botClubMembers(int $clubId, string $country): array {
    $db = botDb();
    if (!$db) return [];
    try {
        $stmt = $db->prepare(
            "SELECT cm.id, cm.user_id, cm.role, cm.status, cm.joined_at, cm.qq_account, cm.apply_role, cm.is_student,
                    u.username, u.nickname, u.email, u.avatar_url
             FROM club_memberships cm
             JOIN users u ON u.id = cm.user_id
             WHERE cm.club_id = ? AND COALESCE(cm.country, 'china') = ? AND cm.status = 'active'
             ORDER BY CASE cm.role WHEN 'representative' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END, cm.joined_at ASC"
        );
        $stmt->execute([$clubId, $country]);
    } catch (Throwable $e) {
        try {
            $stmt = $db->prepare(
                "SELECT cm.id, cm.user_id, cm.role, cm.status, cm.joined_at, u.username, u.nickname, u.avatar_url
                 FROM club_memberships cm
                 JOIN users u ON u.id = cm.user_id
                 WHERE cm.club_id = ? AND cm.status = 'active'
                 ORDER BY cm.joined_at ASC"
            );
            $stmt->execute([$clubId]);
        } catch (Throwable $e2) {
            return [];
        }
    }
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$row) {
        $row['role_label'] = botRoleLabel(botString($row['role'] ?? 'member'));
    }
    return $rows;
}

function botJoinMethodLabel(string $method): string {
    return match ($method) {
        'school_code' => '本校成员申请（有绑定码）',
        'external_exchange' => '外校成员交流申请',
        default => '本校成员申请加入（未有绑定码）',
    };
}

function botRoleLabel(string $role): string {
    return match ($role) {
        'external' => '外交成员（IEM）',
        'representative' => '负责人',
        'manager' => '管理员',
        'super_admin' => '超级管理员',
        default => '成员',
    };
}

function botMoeKing(int $clubId, string $country): ?array {
    $db = botDb();
    if (!$db) return null;
    try {
        $stmt = $db->prepare("SELECT character_id, name, name_cn, image_url, summary, updated_at FROM club_moe_kings WHERE club_id = ? AND country = ? LIMIT 1");
        $stmt->execute([$clubId, $country]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) return null;
        $row['character_id'] = (int)($row['character_id'] ?? 0);
        $row['image_url'] = proxyImageUrl($row['image_url'] ?? '');
        return $row;
    } catch (Throwable $e) {
        return null;
    }
}

function botMembershipApplications(): array {
    $db = botDb();
    if (!$db) return ['success' => true, 'total' => 0, 'data' => []];
    botEnsureMembershipApplicationColumns($db);

    $scope = strtolower(botString($_GET['scope'] ?? 'all'));
    $status = strtolower(botString($_GET['status'] ?? 'pending'));
    $sinceId = max(0, (int)($_GET['since_id'] ?? 0));
    $order = strtolower(botString($_GET['order'] ?? 'asc'));
    $limit = botLimit(20, 50);
    $params = [];
    $where = [];

    if ($status !== '' && $status !== 'all') {
        $where[] = 'cm.status = ?';
        $params[] = $status;
    }
    if ($sinceId > 0) {
        $where[] = 'cm.id > ?';
        $params[] = $sinceId;
    }

    if (botIsClubAuth()) {
        global $BOT_AUTH;
        if ($scope === 'all') {
            $scope = 'club';
        }
        $clubKeyParam = botString($_GET['club_key'] ?? $_GET['key'] ?? '');
        $authClubKey = botAuthClubKey();
        if ($clubKeyParam !== '' && str_replace('-', ':', strtolower($clubKeyParam)) !== strtolower($authClubKey)) {
            botRespond(['success' => false, 'error' => '同好会 Bot token 只能读取本同好会申请'], 403);
        }
        $where[] = 'cm.club_id = ?';
        $params[] = (int)($BOT_AUTH['club_id'] ?? 0);
        $where[] = "COALESCE(cm.country, 'china') = ?";
        $params[] = $BOT_AUTH['country'] ?? 'china';
    } elseif ($scope === 'club') {
        $clubKey = botString($_GET['club_key'] ?? $_GET['key'] ?? '');
        $club = botFindClubByKey($clubKey);
        if (!$club) {
            return ['success' => false, 'error' => '无效的 club_key'];
        }
        $where[] = 'cm.club_id = ?';
        $params[] = (int)($club['id'] ?? 0);
        $where[] = "COALESCE(cm.country, 'china') = ?";
        $params[] = $club['country'] ?? 'china';
    } elseif ($scope !== 'all') {
        return ['success' => false, 'error' => 'scope must be club or all'];
    }

    $sql = "SELECT cm.id, cm.user_id, cm.club_id, COALESCE(cm.country, 'china') AS country,
                   cm.status, cm.role, cm.apply_role, cm.join_method, cm.qq_account, cm.contact_account,
                   cm.external_club_name, cm.external_club_role, cm.apply_reason, cm.joined_at,
                   u.username, u.nickname
            FROM club_memberships cm
            LEFT JOIN users u ON u.id = cm.user_id";
    if ($where) $sql .= ' WHERE ' . implode(' AND ', $where);
    $sql .= ' ORDER BY cm.id ' . ($order === 'desc' ? 'DESC' : 'ASC') . ' LIMIT ' . $limit;

    try {
        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        $items = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $country = botString($row['country'] ?? 'china') ?: 'china';
            $clubId = (int)($row['club_id'] ?? 0);
            $club = botFindClub($clubId, $country);
            $joinMethod = botString($row['join_method'] ?? 'school_no_code') ?: 'school_no_code';
            $role = botString($row['apply_role'] ?? $row['role'] ?? 'member') ?: 'member';
            $applicant = botString($row['nickname'] ?? '') ?: (botString($row['username'] ?? '') ?: ('用户#' . (int)($row['user_id'] ?? 0)));
            $items[] = [
                'id' => (int)($row['id'] ?? 0),
                'club_key' => $country . ':' . $clubId,
                'club_name' => $club ? botString($club['display_name'] ?? $club['name'] ?? ('同好会#' . $clubId)) : ('同好会#' . $clubId),
                'country' => $country,
                'club_id' => $clubId,
                'status' => botString($row['status'] ?? ''),
                'join_method' => $joinMethod,
                'join_method_label' => botJoinMethodLabel($joinMethod),
                'apply_role' => $role,
                'role_label' => botRoleLabel($role),
                'applicant_name' => $applicant,
                'username' => botString($row['username'] ?? ''),
                'user_id' => (int)($row['user_id'] ?? 0),
                'contact_account' => botString($row['contact_account'] ?? ''),
                'qq_account' => botString($row['qq_account'] ?? ''),
                'external_club_name' => botString($row['external_club_name'] ?? ''),
                'external_club_role' => botString($row['external_club_role'] ?? ''),
                'apply_reason' => botString($row['apply_reason'] ?? ''),
                'created_at' => botString($row['joined_at'] ?? ''),
                'joined_at' => botString($row['joined_at'] ?? ''),
            ];
        }
        return ['success' => true, 'total' => count($items), 'data' => $items];
    } catch (Throwable $e) {
        return ['success' => false, 'error' => 'membership application query failed'];
    }
}

function botFindClub(int $id, string $country = 'all'): ?array {
    foreach (botLoadClubs($country) as $club) {
        if ((int)($club['id'] ?? 0) === $id) return $club;
    }
    return null;
}

function botFindClubByKey(string $value): ?array {
    $value = trim($value);
    if (preg_match('/^(china|japan):([0-9]+)$/i', $value, $matches)) {
        return botFindClub((int)$matches[2], strtolower($matches[1]));
    }
    if (preg_match('/^(china|japan)-([0-9]+)$/i', $value, $matches)) {
        return botFindClub((int)$matches[2], strtolower($matches[1]));
    }
    if (ctype_digit($value)) {
        return botFindClub((int)$value, botCountry());
    }
    return null;
}

function botIsGlobalAuth(): bool {
    global $BOT_AUTH;
    return ($BOT_AUTH['type'] ?? '') === 'global';
}

function botIsClubAuth(): bool {
    global $BOT_AUTH;
    return ($BOT_AUTH['type'] ?? '') === 'club';
}

function botAuthClubKey(): string {
    global $BOT_AUTH;
    if (($BOT_AUTH['type'] ?? '') !== 'club') return '';
    return ($BOT_AUTH['country'] ?? 'china') . ':' . (int)($BOT_AUTH['club_id'] ?? 0);
}

function botAuthHasPermission(string $permission): bool {
    global $BOT_AUTH;
    if (($BOT_AUTH['type'] ?? '') === 'global') return true;
    return in_array($permission, $BOT_AUTH['permissions'] ?? [], true);
}

function botRequireGlobalAuth(): void {
    if (!botIsGlobalAuth()) {
        botRespond(['success' => false, 'error' => '该 action 仅全站 Bot API 密钥可用'], 403);
    }
}

function botClubMatchesAuth(array $club): bool {
    global $BOT_AUTH;
    if (($BOT_AUTH['type'] ?? '') !== 'club') return true;
    return (int)($club['id'] ?? 0) === (int)($BOT_AUTH['club_id'] ?? 0)
        && ($club['country'] ?? 'china') === ($BOT_AUTH['country'] ?? 'china');
}

function botRequireClubAccess(?array $club): array {
    if (!$club) botRespond(['success' => false, 'error' => '未找到该同好会'], 404);
    if (!botClubMatchesAuth($club)) {
        botRespond(['success' => false, 'error' => '同好会 Bot token 无权访问其他同好会'], 403);
    }
    return $club;
}

function botRequireClubPublicAccess(?array $club): array {
    if (!$club) botRespond(['success' => false, 'error' => '未找到该同好会'], 404);
    // 跨同好会查询：club token 也可以读取任意同好会的公开资料。
    // 隐私字段（联系方式、备注、成员名单）由顶部 full/include_private 拦截保证。
    return $club;
}

function botClubFromRequestOrAuth(): ?array {
    if (botIsClubAuth()) {
        global $BOT_AUTH;
        return botFindClub((int)$BOT_AUTH['club_id'], $BOT_AUTH['country'] ?? 'china');
    }
    $idParam = botString($_GET['id'] ?? $_GET['key'] ?? $_GET['club_key'] ?? '');
    if ($idParam !== '') {
        return botFindClubByKey($idParam);
    }
    return null;
}

function botMembershipApplicationById(PDO $db, int $membershipId): ?array {
    $stmt = $db->prepare("SELECT cm.* FROM club_memberships cm WHERE cm.id = ?");
    $stmt->execute([$membershipId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function botRequireMembershipApprovalAccess(array $membership): void {
    if (botIsGlobalAuth()) return;
    if (!botAuthHasPermission('approve_membership')) {
        botRespond(['success' => false, 'error' => '该 token 未开启审批权限'], 403);
    }
    global $BOT_AUTH;
    $clubId = (int)($membership['club_id'] ?? 0);
    $country = botString($membership['country'] ?? 'china') ?: 'china';
    if ($clubId !== (int)($BOT_AUTH['club_id'] ?? 0) || $country !== ($BOT_AUTH['country'] ?? 'china')) {
        botRespond(['success' => false, 'error' => '同好会 Bot token 只能审批本同好会申请'], 403);
    }
}

function botNotifyMembershipResult(array $membership, string $type, string $title, string $message): void {
    try {
        if (file_exists(__DIR__ . '/../includes/notifications.php')) {
            require_once __DIR__ . '/../includes/notifications.php';
            createNotification(
                (int)($membership['user_id'] ?? 0),
                $type,
                $title,
                $message,
                './index.html',
                'membership',
                (int)($membership['id'] ?? 0)
            );
        }
    } catch (Throwable $e) {}
}

function botPublicationRow(array $pub, bool $full): array {
    return [
        'id' => (int)($pub['id'] ?? 0),
        'title' => botString($pub['publicationName'] ?? ''),
        'club_name' => botString($pub['clubName'] ?? ''),
        'club_ids' => is_array($pub['club_ids'] ?? null) ? $pub['club_ids'] : [],
        'status' => botString($pub['status'] ?? ''),
        'deadline' => botString($pub['deadline'] ?? ''),
        'description' => botString($pub['description'] ?? ''),
        'submit_contact' => $full ? botString($pub['submitContact'] ?? '') : '',
        'submit_contact_hidden' => !$full && botString($pub['submitContact'] ?? '') !== '',
        'submit_link' => $full ? botString($pub['submitLink'] ?? '') : '',
        'image_url' => botAbsUrl(botString($pub['image_url'] ?? '')),
        'created_at' => botString($pub['created_at'] ?? ''),
        'updated_at' => botString($pub['updated_at'] ?? ''),
    ];
}

function botEventRow(array $event): array {
    return [
        'id' => (int)($event['id'] ?? 0),
        'title' => botString($event['event'] ?? ''),
        'date' => botString($event['date'] ?? ''),
        'date_end' => botString($event['date_end'] ?? ''),
        'description' => botString($event['description'] ?? ''),
        'link' => botString($event['link'] ?? ''),
        'image_url' => botAbsUrl(botString($event['image'] ?? '')),
        'official' => (int)($event['offical'] ?? $event['official'] ?? 0),
        'created_at' => botString($event['created_at'] ?? ''),
    ];
}

function botFilterRows(array $rows, string $query, array $fields, int $limit): array {
    $items = [];
    foreach ($rows as $row) {
        if (!is_array($row)) continue;
        if (!botTextMatches($row, $query, $fields)) continue;
        $items[] = $row;
        if (count($items) >= $limit) break;
    }
    return $items;
}

function botGrowthClubSummary(array $club): array {
    $summary = growthBuildClubSummary($club);
    $summary['share_url'] = botAbsUrl($summary['share_url'] ?? '');
    $summary['apply_url'] = botAbsUrl($summary['apply_url'] ?? '');
    if (!empty($summary['logo_url'])) {
        $summary['logo_url'] = botAbsUrl((string)$summary['logo_url']);
    }
    if (!empty($summary['activity']['wiki']['url'])) {
        $summary['activity']['wiki']['url'] = botAbsUrl((string)$summary['activity']['wiki']['url']);
    }
    return $summary;
}

function botDbCount(string $sql, array $params = []): int {
    $db = botDb();
    if (!$db) return 0;
    try {
        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        return (int)$stmt->fetchColumn();
    } catch (Throwable $e) {
        return 0;
    }
}

function botEnsureColumn(PDO $db, string $table, string $column, string $definition): void {
    $exists = false;
    try {
        if ($db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite') {
            $stmt = $db->query("PRAGMA table_info($table)");
            $cols = $stmt ? $stmt->fetchAll(PDO::FETCH_COLUMN, 1) : [];
            $exists = in_array($column, $cols, true);
        } else {
            $stmt = $db->query("SHOW COLUMNS FROM `$table` LIKE " . $db->quote($column));
            $exists = (bool)($stmt && $stmt->fetch());
        }
    } catch (Throwable $e) {
        $exists = true;
    }
    if (!$exists) {
        try {
            $db->exec("ALTER TABLE `$table` ADD COLUMN `$column` $definition");
        } catch (Throwable $e) {}
    }
}

function botEnsureMembershipApplicationColumns(PDO $db): void {
    botEnsureColumn($db, 'club_memberships', 'country', "VARCHAR(20) DEFAULT 'china'");
    botEnsureColumn($db, 'club_memberships', 'qq_account', "VARCHAR(255) DEFAULT ''");
    botEnsureColumn($db, 'club_memberships', 'contact_account', "VARCHAR(255) DEFAULT ''");
    botEnsureColumn($db, 'club_memberships', 'apply_role', "VARCHAR(50) DEFAULT 'member'");
    botEnsureColumn($db, 'club_memberships', 'join_method', "VARCHAR(50) DEFAULT 'school_no_code'");
    botEnsureColumn($db, 'club_memberships', 'external_club_name', "VARCHAR(255) DEFAULT ''");
    botEnsureColumn($db, 'club_memberships', 'external_club_role', "VARCHAR(255) DEFAULT ''");
    botEnsureColumn($db, 'club_memberships', 'apply_reason', "TEXT");
}

function botPendingJsonCount(string $path, string $listKey = ''): int {
    $rows = $listKey === '' ? botLoadJson($path, []) : botRows($path, $listKey);
    $count = 0;
    foreach ($rows as $row) {
        if (!is_array($row)) continue;
        if (($row['status'] ?? '') === 'pending') $count++;
    }
    return $count;
}

$action = strtolower(botString($_GET['action'] ?? 'help'));
$limit = botLimit();
$full = botBoolParam('full') || botBoolParam('include_private') || botBoolParam('include_contact');
$query = botQuery();
$BOT_AUTH = null;
if (!in_array($action, $sessionActions, true)) {
    $BOT_AUTH = authBot();
    if (botIsClubAuth() && $full) {
        botRespond(['success' => false, 'error' => '同好会 Bot token 不允许请求 full/include_private 数据'], 403);
    }
}

switch ($action) {
    case 'bot_tokens_list':
        $user = requireLogin();
        $clubId = (int)($_GET['club_id'] ?? 0);
        $country = botString($_GET['country'] ?? 'china') ?: 'china';
        if ($clubId <= 0) botRespond(['success' => false, 'error' => 'club_id required'], 400);
        if (!botCanManageClubToken($user, $clubId, $country)) {
            botRespond(['success' => false, 'error' => '无权查看该同好会 Bot token'], 403);
        }
        $db = botDb();
        if (!$db) botRespond(['success' => false, 'error' => 'database unavailable'], 500);
        botEnsureClubTokenTable($db);
        $stmt = $db->prepare(
            "SELECT id, club_id, country, name, token_prefix, permissions, created_by, created_at, last_used_at, revoked_at
             FROM club_bot_tokens
             WHERE club_id = ? AND country = ?
             ORDER BY id DESC"
        );
        $stmt->execute([$clubId, $country]);
        botRespond(['success' => true, 'tokens' => array_map('botPublicTokenRow', $stmt->fetchAll(PDO::FETCH_ASSOC))]);

    case 'bot_tokens_create':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') botRespond(['success' => false, 'error' => 'POST only'], 405);
        $user = requireLogin();
        $input = botInputJson();
        $clubId = (int)($input['club_id'] ?? 0);
        $country = botString($input['country'] ?? 'china') ?: 'china';
        $name = mb_substr(botString($input['name'] ?? 'AstrBot 接入'), 0, 80);
        if ($clubId <= 0) botRespond(['success' => false, 'error' => 'club_id required'], 400);
        if (!botCanManageClubToken($user, $clubId, $country)) {
            botRespond(['success' => false, 'error' => '无权创建该同好会 Bot token'], 403);
        }
        $permissions = [];
        if (!empty($input['approve_membership'])) {
            $permissions[] = 'approve_membership';
        }
        $token = botGenerateClubToken();
        $db = botDb();
        if (!$db) botRespond(['success' => false, 'error' => 'database unavailable'], 500);
        botEnsureClubTokenTable($db);
        $stmt = $db->prepare(
            "INSERT INTO club_bot_tokens (club_id, country, name, token_prefix, token_hash, permissions, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)"
        );
        $stmt->execute([
            $clubId,
            $country,
            $name,
            botClubTokenPrefix($token),
            password_hash($token, PASSWORD_DEFAULT),
            json_encode($permissions, JSON_UNESCAPED_UNICODE),
            (int)$user['id'],
        ]);
        $tokenId = (int)$db->lastInsertId();
        if (function_exists('logAction')) {
            logAction('bot_token.create', 'club_bot_tokens', $tokenId, ['club_id' => $clubId, 'country' => $country, 'permissions' => $permissions]);
        }
        botRespond([
            'success' => true,
            'message' => 'Bot token 已创建，请立即复制保存，刷新后不会再次显示明文。',
            'token' => $token,
            'item' => [
                'id' => $tokenId,
                'club_id' => $clubId,
                'country' => $country,
                'name' => $name,
                'token_prefix' => botClubTokenPrefix($token),
                'permissions' => $permissions,
                'active' => true,
            ],
        ]);

    case 'bot_tokens_revoke':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') botRespond(['success' => false, 'error' => 'POST only'], 405);
        $user = requireLogin();
        $input = botInputJson();
        $tokenId = (int)($input['token_id'] ?? $input['id'] ?? 0);
        if ($tokenId <= 0) botRespond(['success' => false, 'error' => 'token_id required'], 400);
        $db = botDb();
        if (!$db) botRespond(['success' => false, 'error' => 'database unavailable'], 500);
        botEnsureClubTokenTable($db);
        $stmt = $db->prepare("SELECT id, club_id, country FROM club_bot_tokens WHERE id = ?");
        $stmt->execute([$tokenId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) botRespond(['success' => false, 'error' => 'token not found'], 404);
        if (!botCanManageClubToken($user, (int)$row['club_id'], botString($row['country'] ?? 'china') ?: 'china')) {
            botRespond(['success' => false, 'error' => '无权吊销该同好会 Bot token'], 403);
        }
        $db->prepare("UPDATE club_bot_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL")->execute([$tokenId]);
        if (function_exists('logAction')) {
            logAction('bot_token.revoke', 'club_bot_tokens', $tokenId, ['club_id' => (int)$row['club_id'], 'country' => $row['country'] ?? 'china']);
        }
        botRespond(['success' => true, 'message' => 'Bot token 已吊销']);

    case 'help':
        botRespond([
            'success' => true,
            'auth' => $BOT_AUTH,
            'actions' => ['clubs', 'club', 'club_share', 'club_activity', 'search', 'events', 'publications', 'wiki', 'star_unions', 'moe_contests', 'announcements', 'membership_applications', 'membership_approve', 'membership_reject', 'stats', 'admin_summary', 'galonly_events', 'galonly_applications', 'galonly_staff_applications', 'bot_tokens_list', 'bot_tokens_create', 'bot_tokens_revoke'],
            'params' => ['token', 'action', 'country', 'id', 'q', 'region', 'type', 'status', 'limit', 'full', 'scope', 'club_key', 'since_id', 'order', 'membership_id', 'event_id'],
        ]);

    case 'clubs':
    case 'search':
        // 跨同好会查询已开放：club token 可按 country 参数浏览全站公开资料（full 隐私数据由顶部拦截）
        $country = botCountry();
        $regionFilter = botString($_GET['region'] ?? $_GET['province'] ?? $_GET['prefecture'] ?? '');
        $typeFilter = botString($_GET['type'] ?? '');
        $memberCounts = botMemberCounts();
        $items = [];
        foreach (botLoadClubs($country) as $club) {
            $clubCountry = $club['country'] ?? 'china';
            if ($typeFilter !== '' && botString($club['type'] ?? '') !== $typeFilter) continue;
            if ($regionFilter !== '') {
                $clubRegion = botClubRegion($club, $clubCountry);
                $wanted = $clubCountry === 'japan' ? botNormalizeJapanRegion($regionFilter) : botNormalizeChinaRegion($regionFilter);
                if ($clubRegion !== $wanted) continue;
            }
            if ($query !== '' && !botTextMatches($club, $query, ['name', 'display_name', 'school', 'province', 'prefecture', 'remark', 'raw_text', 'project'])) continue;
            $items[] = botClubRow($club, $full, $memberCounts);
            if (count($items) >= $limit) break;
        }
        botRespond(['success' => true, 'action' => $action, 'total' => count($items), 'data' => $items]);

    case 'club':
        $idParam = botString($_GET['id'] ?? $_GET['key'] ?? '');
        $club = botIsClubAuth() && $idParam === '' && $query === '' ? botClubFromRequestOrAuth() : botFindClubByKey($idParam);
        if (!$club && $query !== '') {
            foreach (botLoadClubs(botCountry()) as $candidate) {
                if (botTextMatches($candidate, $query, ['name', 'display_name', 'school', 'remark', 'raw_text'])) {
                    $club = $candidate;
                    break;
                }
            }
        }
        $club = botRequireClubPublicAccess($club);
        $memberCounts = botMemberCounts();
        $row = botClubRow($club, $full, $memberCounts);
        $country = $club['country'] ?? 'china';
        $id = (int)($club['id'] ?? 0);
        $row['wiki'] = botWikiForClub($country, $id);
        $row['publications'] = botPublicationsForClub($club);
        if ($full) {
            $row['members'] = botClubMembers($id, $country);
        }
        $row['moe_king'] = botMoeKing($id, $country);
        botRespond(['success' => true, 'data' => $row]);

    case 'club_share':
    case 'club_activity':
        $idParam = botString($_GET['id'] ?? $_GET['key'] ?? '');
        $club = botIsClubAuth() && $idParam === '' && $query === '' ? botClubFromRequestOrAuth() : botFindClubByKey($idParam);
        if (!$club && $query !== '') {
            foreach (botLoadClubs(botCountry()) as $candidate) {
                if (botTextMatches($candidate, $query, ['name', 'display_name', 'school', 'remark', 'raw_text'])) {
                    $club = $candidate;
                    break;
                }
            }
        }
        $club = botRequireClubAccess($club);
        $summary = botGrowthClubSummary($club);
        growthRecordAnalytics('bot_share_query', $summary['key'], 'bot');
        if ($action === 'club_activity') {
            botRespond([
                'success' => true,
                'data' => [
                    'club' => [
                        'key' => $summary['key'],
                        'name' => $summary['name'],
                        'share_url' => $summary['share_url'],
                    ],
                    'activity' => $summary['activity'],
                ],
            ]);
        }
        botRespond(['success' => true, 'data' => $summary]);

    case 'events':
        // 公开只读数据：global 与 club token 均可访问
        $rows = array_reverse(botRows(__DIR__ . '/../data/events.json', 'events'));
        $items = [];
        foreach (botFilterRows($rows, $query, ['event', 'date', 'date_end', 'description', 'link'], $limit) as $row) {
            $items[] = botEventRow($row);
        }
        botRespond(['success' => true, 'total' => count($items), 'data' => $items]);

    case 'publications':
        // 公开只读数据：global 与 club token 均可访问（投稿联系方式仍由 full 控制）
        $status = botString($_GET['status'] ?? '');
        $items = [];
        foreach (botRows(__DIR__ . '/../data/publications.json', 'publications') as $row) {
            if ($status !== '' && botString($row['status'] ?? '') !== $status) continue;
            if (!botTextMatches($row, $query, ['publicationName', 'clubName', 'status', 'deadline', 'description', 'submitContact'])) continue;
            $items[] = botPublicationRow($row, $full);
            if (count($items) >= $limit) break;
        }
        botRespond(['success' => true, 'total' => count($items), 'data' => $items]);

    case 'wiki':
        // 公开只读数据：global 与 club token 均可访问
        $items = [];
        foreach (botWikiIndex() as $key => $row) {
            if (!is_array($row)) continue;
            if (!botTextMatches($row, $query, ['title', 'school', 'club_name', 'region', 'summary', 'country_label'])) continue;
            $row['key'] = $key;
            if (!empty($row['url'])) $row['url'] = botAbsUrl((string)$row['url']);
            $items[] = $row;
            if (count($items) >= $limit) break;
        }
        botRespond(['success' => true, 'total' => count($items), 'data' => $items]);

    case 'star_unions':
        // 公开只读数据：global 与 club token 均可访问
        $db = botDb();
        if (!$db) botRespond(['success' => true, 'total' => 0, 'data' => []]);
        try {
            $country = botCountry();
            $params = [];
            $where = [];
            if ($country !== 'all') {
                $where[] = 'country = ?';
                $params[] = $country;
            }
            if ($query !== '') {
                $where[] = '(name LIKE ? OR description LIKE ? OR region LIKE ?)';
                $params[] = '%' . $query . '%';
                $params[] = '%' . $query . '%';
                $params[] = '%' . $query . '%';
            }
            $sql = 'SELECT id, name, description, region, country, bound_club_id, bound_club_country, star_color, created_at FROM star_unions';
            if ($where) $sql .= ' WHERE ' . implode(' AND ', $where);
            $sql .= ' ORDER BY created_at DESC LIMIT ' . $limit;
            $stmt = $db->prepare($sql);
            $stmt->execute($params);
            $items = [];
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $row['id'] = (int)$row['id'];
                $row['member_count'] = botDbCount('SELECT COUNT(*) FROM star_union_members WHERE union_id = ?', [(int)$row['id']]);
                $items[] = $row;
            }
            botRespond(['success' => true, 'total' => count($items), 'data' => $items]);
        } catch (Throwable $e) {
            botRespond(['success' => true, 'total' => 0, 'data' => []]);
        }

    case 'moe_contests':
        // 公开只读数据：global 与 club token 均可访问
        botRespond([
            'success' => true,
            'total' => 0,
            'data' => [],
            'code' => 'MOE_REBUILDING',
            'message' => '萌战模块正在重构，旧方案已下线，接口动作保留。',
        ]);

    case 'announcements':
        // 公开只读数据：global 与 club token 均可访问
        $db = botDb();
        if (!$db) botRespond(['success' => true, 'total' => 0, 'data' => []]);
        try {
            $stmt = $db->prepare(
                "SELECT id, title, content, type, status, is_persistent, created_at, published_at
                 FROM announcements
                 WHERE status = 'published'
                 ORDER BY published_at DESC, created_at DESC
                 LIMIT " . $limit
            );
            $stmt->execute();
            botRespond(['success' => true, 'total' => $stmt->rowCount(), 'data' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
        } catch (Throwable $e) {
            botRespond(['success' => true, 'total' => 0, 'data' => []]);
        }

    case 'membership_applications':
        $payload = botMembershipApplications();
        botRespond($payload, !empty($payload['success']) ? 200 : 400);

    case 'auto_approve':
    case 'membership_approve':
        $membershipId = (int)($_GET['membership_id'] ?? 0);
        if ($membershipId <= 0 && $_SERVER['REQUEST_METHOD'] === 'POST') {
            $input = botInputJson();
            $membershipId = (int)($input['membership_id'] ?? 0);
        }
        if ($membershipId <= 0) {
            botRespond(['success' => false, 'error' => 'membership_id required'], 400);
        }
        $db = botDb();
        if (!$db) botRespond(['success' => false, 'error' => 'database unavailable'], 500);
        try {
            $membership = botMembershipApplicationById($db, $membershipId);
            if (!$membership || ($membership['status'] ?? '') !== 'pending') {
                botRespond(['success' => false, 'error' => 'pending application not found'], 404);
            }
            botRequireMembershipApprovalAccess($membership);
            $stmt = $db->prepare("UPDATE club_memberships SET status = 'active', left_at = NULL WHERE id = ? AND status = 'pending'");
            $stmt->execute([$membershipId]);
            $club = botFindClub((int)$membership['club_id'], botString($membership['country'] ?? 'china') ?: 'china');
            $clubName = $club ? botString($club['display_name'] ?? $club['name'] ?? '同好会') : '同好会';
            botNotifyMembershipResult($membership, 'join_approved', '同好会申请已通过', "你在「{$clubName}」的加入申请已通过审核。");
            botRespond(['success' => true, 'message' => 'membership approved', 'membership_id' => $membershipId]);
        } catch (Throwable $e) {
            botRespond(['success' => false, 'error' => 'approve failed: ' . $e->getMessage()], 500);
        }

    case 'membership_reject':
        $membershipId = (int)($_GET['membership_id'] ?? 0);
        $reason = botString($_GET['reason'] ?? '');
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $input = botInputJson();
            $membershipId = $membershipId > 0 ? $membershipId : (int)($input['membership_id'] ?? 0);
            $reason = $reason !== '' ? $reason : botString($input['reason'] ?? '');
        }
        if ($membershipId <= 0) {
            botRespond(['success' => false, 'error' => 'membership_id required'], 400);
        }
        $db = botDb();
        if (!$db) botRespond(['success' => false, 'error' => 'database unavailable'], 500);
        try {
            $membership = botMembershipApplicationById($db, $membershipId);
            if (!$membership || ($membership['status'] ?? '') !== 'pending') {
                botRespond(['success' => false, 'error' => 'pending application not found'], 404);
            }
            botRequireMembershipApprovalAccess($membership);
            $stmt = $db->prepare("UPDATE club_memberships SET status = 'rejected' WHERE id = ? AND status = 'pending'");
            $stmt->execute([$membershipId]);
            $club = botFindClub((int)$membership['club_id'], botString($membership['country'] ?? 'china') ?: 'china');
            $clubName = $club ? botString($club['display_name'] ?? $club['name'] ?? '同好会') : '同好会';
            $message = "你在「{$clubName}」的加入申请未通过审核。";
            if ($reason !== '') $message .= "原因：{$reason}";
            botNotifyMembershipResult($membership, 'join_rejected', '同好会申请未通过', $message);
            botRespond(['success' => true, 'message' => 'membership rejected', 'membership_id' => $membershipId]);
        } catch (Throwable $e) {
            botRespond(['success' => false, 'error' => 'reject failed: ' . $e->getMessage()], 500);
        }

    case 'stats':
        $clubs = botLoadClubs('all');
        $memberCounts = botMemberCounts();
        $byCountry = [];
        $byType = [];
        $byRegion = [];
        $visibleClubs = [];
        foreach ($clubs as $club) {
            if (!botClubMatchesAuth($club)) continue;
            $visibleClubs[] = $club;
            $country = $club['country'] ?? 'china';
            $type = botString($club['type'] ?? 'school') ?: 'school';
            $region = botClubRegion($club, $country);
            $byCountry[$country] = ($byCountry[$country] ?? 0) + 1;
            $byType[$type] = ($byType[$type] ?? 0) + 1;
            if ($region !== '') $byRegion[$region] = ($byRegion[$region] ?? 0) + 1;
        }
        arsort($byRegion);
        botRespond([
            'success' => true,
            'data' => [
                'mode' => botIsClubAuth() ? 'club' : 'global',
                'club_key' => botIsClubAuth() ? botAuthClubKey() : '',
                'total_clubs' => count($visibleClubs),
                'total_members' => botIsClubAuth() ? ($memberCounts[botAuthClubKey()] ?? 0) : array_sum($memberCounts),
                'total_events' => botIsClubAuth() ? count(botGrowthClubSummary($visibleClubs[0] ?? [])['activity']['events'] ?? []) : count(botRows(__DIR__ . '/../data/events.json', 'events')),
                'total_publications' => botIsClubAuth() ? count(botGrowthClubSummary($visibleClubs[0] ?? [])['activity']['publications'] ?? []) : count(botRows(__DIR__ . '/../data/publications.json', 'publications')),
                'total_wiki_pages' => botIsClubAuth() ? (!empty(botGrowthClubSummary($visibleClubs[0] ?? [])['activity']['wiki']) ? 1 : 0) : count(botWikiIndex()),
                'total_moe_contests' => 0,
                'active_users' => botDbCount("SELECT COUNT(*) FROM users WHERE status = 'active'"),
                'growth_analytics_30d' => growthAnalyticsSummary([], 30),
                'by_country' => $byCountry,
                'by_type' => $byType,
                'top_regions' => array_slice($byRegion, 0, 20, true),
            ],
        ]);

    case 'admin_summary':
        botRequireGlobalAuth();
        botRespond([
            'success' => true,
            'data' => [
                'pending_club_submissions' => botPendingJsonCount(__DIR__ . '/../data/submissions.json'),
                'pending_publication_submissions' => botPendingJsonCount(__DIR__ . '/../data/submissions_publication.json'),
                'pending_event_submissions' => botPendingJsonCount(__DIR__ . '/../data/submissions_event.json'),
                'pending_feedback' => botPendingJsonCount(__DIR__ . '/../data/feedback.json'),
                'event_registrations' => count(botLoadJson(__DIR__ . '/../data/event_registrations.json', [])),
                'pending_memberships' => botDbCount("SELECT COUNT(*) FROM club_memberships WHERE status = 'pending'"),
                'pending_memberships_school_no_code' => botDbCount("SELECT COUNT(*) FROM club_memberships WHERE status = 'pending' AND COALESCE(join_method, 'school_no_code') = 'school_no_code'"),
                'pending_memberships_external_exchange' => botDbCount("SELECT COUNT(*) FROM club_memberships WHERE status = 'pending' AND COALESCE(join_method, 'school_no_code') = 'external_exchange'"),
                'active_users' => botDbCount("SELECT COUNT(*) FROM users WHERE status = 'active'"),
                'total_clubs' => count(botLoadClubs('all')),
                'total_publications' => count(botRows(__DIR__ . '/../data/publications.json', 'publications')),
                'total_events' => count(botRows(__DIR__ . '/../data/events.json', 'events')),
                'total_wiki_pages' => count(botWikiIndex()),
            ],
        ]);

    case 'galonly_events':
        botRequireGlobalAuth();
        {
            $db = botDb();
            if (!$db) botRespond(['success' => false, 'error' => 'database unavailable'], 500);
            try {
                $events = $db->query("SELECT id, name, location, date, registration_open, staff_only, event_code, description FROM galonly_events ORDER BY date ASC")->fetchAll(PDO::FETCH_ASSOC);
                $boothCounts = [];
                try {
                    foreach ($db->query("SELECT event_id, COUNT(*) AS cnt FROM galonly_applications WHERE status = 'pending' GROUP BY event_id")->fetchAll(PDO::FETCH_ASSOC) as $row) {
                        $boothCounts[(int)$row['event_id']] = (int)$row['cnt'];
                    }
                } catch (Throwable $e) {}
                $staffCounts = [];
                try {
                    foreach ($db->query("SELECT event_id, COUNT(*) AS cnt FROM galonly_staff_applications WHERE status IN ('pending','pooled') GROUP BY event_id")->fetchAll(PDO::FETCH_ASSOC) as $row) {
                        $staffCounts[(int)$row['event_id']] = (int)$row['cnt'];
                    }
                } catch (Throwable $e) {}
                foreach ($events as &$event) {
                    $event['pending_booths'] = $boothCounts[(int)$event['id']] ?? 0;
                    $event['pending_staff'] = $staffCounts[(int)$event['id']] ?? 0;
                }
                unset($event);
                botRespond(['success' => true, 'total' => count($events), 'data' => $events]);
            } catch (Throwable $e) {
                botRespond(['success' => true, 'total' => 0, 'data' => []]);
            }
        }

    case 'galonly_applications':
        botRequireGlobalAuth();
        {
            $db = botDb();
            if (!$db) botRespond(['success' => false, 'error' => 'database unavailable'], 500);
            $status = strtolower(botString($_GET['status'] ?? 'pending'));
            $sinceId = max(0, (int)($_GET['since_id'] ?? 0));
            $order = strtolower(botString($_GET['order'] ?? 'desc'));
            $limit = botLimit(20, 50);
            $eventId = (int)($_GET['event_id'] ?? 0);
            $appId = (int)($_GET['id'] ?? 0);
            $params = [];
            $where = [];
            if ($appId > 0) {
                $where[] = 'a.id = ?';
                $params[] = $appId;
            }
            if ($eventId > 0) {
                $where[] = 'a.event_id = ?';
                $params[] = $eventId;
            }
            if ($status !== '' && $status !== 'all' && $appId <= 0) {
                $where[] = 'a.status = ?';
                $params[] = $status;
            }
            if ($sinceId > 0 && $appId <= 0) {
                $where[] = 'a.id > ?';
                $params[] = $sinceId;
            }
            $sql = "SELECT a.*, u.nickname, u.username, e.name AS event_name
                    FROM galonly_applications a
                    LEFT JOIN users u ON u.id = a.user_id
                    LEFT JOIN galonly_events e ON e.id = a.event_id";
            if ($where) $sql .= ' WHERE ' . implode(' AND ', $where);
            if ($appId > 0) {
                $sql .= ' LIMIT 1';
            } else {
                $sql .= ' ORDER BY a.id ' . ($order === 'desc' ? 'DESC' : 'ASC') . ' LIMIT ' . (int)$limit;
            }
            try {
                $stmt = $db->prepare($sql);
                $stmt->execute($params);
                $items = [];
                foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                    $imageUrls = [];
                    $rawImages = botString($row['image_path'] ?? '');
                    if ($rawImages !== '') {
                        $decoded = json_decode($rawImages, true);
                        $paths = is_array($decoded) ? $decoded : [$rawImages];
                        foreach ($paths as $p) {
                            $abs = botAbsUrl(botString($p));
                            if ($abs !== '') $imageUrls[] = $abs;
                        }
                    }
                    $clubs = [];
                    try {
                        $cStmt = $db->prepare("SELECT club_id, club_country FROM galonly_application_clubs WHERE application_id = ?");
                        $cStmt->execute([(int)$row['id']]);
                        foreach ($cStmt->fetchAll(PDO::FETCH_ASSOC) as $c) {
                            $club = botFindClub((int)$c['club_id'], botString($c['club_country'] ?? 'china') ?: 'china');
                            $clubs[] = [
                                'club_id' => (int)$c['club_id'],
                                'club_country' => botString($c['club_country'] ?? 'china') ?: 'china',
                                'club_name' => $club ? botString($club['display_name'] ?? $club['name'] ?? ('同好会#' . (int)$c['club_id'])) : ('同好会#' . (int)$c['club_id']),
                            ];
                        }
                    } catch (Throwable $e) {}
                    $merchandiseItems = json_decode((string)($row['merchandise_items'] ?? ''), true);
                    if (!is_array($merchandiseItems)) $merchandiseItems = [];
                    foreach ($merchandiseItems as &$merchandiseItem) {
                        if (!is_array($merchandiseItem)) continue;
                        $itemImages = [];
                        foreach (($merchandiseItem['images'] ?? []) as $itemImage) {
                            $itemImageUrl = botAbsUrl(botString($itemImage));
                            if ($itemImageUrl !== '') $itemImages[] = $itemImageUrl;
                        }
                        $merchandiseItem['images'] = $itemImages;
                    }
                    unset($merchandiseItem);
                    $merchandiseAttachments = json_decode((string)($row['merchandise_attachments'] ?? ''), true);
                    if (!is_array($merchandiseAttachments)) $merchandiseAttachments = [];
                    $merchandiseAttachments = array_values(array_filter(array_map(fn($p) => botAbsUrl(botString($p)), $merchandiseAttachments)));
                    $merchandiseVersion = max(0, (int)($row['merchandise_version'] ?? 0));
                    $merchandiseStatus = botString($row['status'] ?? '');
                    $items[] = [
                        'id' => (int)($row['id'] ?? 0),
                        'event_id' => (int)($row['event_id'] ?? 0),
                        'event_number' => isset($row['event_number']) ? (int)$row['event_number'] : null,
                        'phase' => (int)($row['phase'] ?? 1),
                        'event_name' => botString($row['event_name'] ?? ''),
                        'booth_name' => botString($row['booth_name'] ?? ''),
                        'is_joint' => (int)($row['is_joint'] ?? 0),
                        'joint_name' => botString($row['joint_name'] ?? ''),
                        'wants_upgrade' => (int)($row['wants_upgrade'] ?? 0),
                        'contact' => botString($row['contact'] ?? ''),
                        'qq_number' => botString($row['qq_number'] ?? ''),
                        'phone_number' => botString($row['phone_number'] ?? ''),
                        'exhibition_experience' => botString($row['exhibition_experience'] ?? ''),
                        'notes' => botString($row['notes'] ?? ''),
                        'status' => botString($row['status'] ?? ''),
                        'phase2_approved_status' => botString($row['phase2_approved_status'] ?? ''),
                        'merchandise_version' => $merchandiseVersion,
                        'merchandise_updated_at' => botString($row['merchandise_updated_at'] ?? ''),
                        'merchandise_update_pending' => function_exists('galonlyMerchandiseIsUpdatePending') ? galonlyMerchandiseIsUpdatePending(['status' => $merchandiseStatus, 'merchandise_version' => $merchandiseVersion]) : ($merchandiseStatus === 'phase2_additional_pending'),
                        'merchandise_items' => $merchandiseItems,
                        'merchandise_attachments' => $merchandiseAttachments,
                        'image_paths' => $imageUrls,
                        'display_image' => botAbsUrl(botString($row['display_image'] ?? '')),
                        'clubs' => $clubs,
                        'applicant_name' => botString($row['nickname'] ?? '') ?: (botString($row['username'] ?? '') ?: ('用户#' . (int)($row['user_id'] ?? 0))),
                        'username' => botString($row['username'] ?? ''),
                        'user_id' => (int)($row['user_id'] ?? 0),
                        'created_at' => botString($row['created_at'] ?? ''),
                        'updated_at' => botString($row['updated_at'] ?? ''),
                    ];
                }
                botRespond(['success' => true, 'total' => count($items), 'data' => $items]);
            } catch (Throwable $e) {
                botRespond(['success' => false, 'error' => 'galonly application query failed'], 400);
            }
        }

    case 'galonly_staff_applications':
        botRequireGlobalAuth();
        {
            $db = botDb();
            if (!$db) botRespond(['success' => false, 'error' => 'database unavailable'], 500);
            $status = strtolower(botString($_GET['status'] ?? 'pending'));
            $sinceId = max(0, (int)($_GET['since_id'] ?? 0));
            $order = strtolower(botString($_GET['order'] ?? 'desc'));
            $limit = botLimit(20, 50);
            $eventId = (int)($_GET['event_id'] ?? 0);
            $appId = (int)($_GET['id'] ?? 0);
            $params = [];
            $where = [];
            if ($appId > 0) {
                $where[] = 'a.id = ?';
                $params[] = $appId;
            }
            if ($eventId > 0) {
                $where[] = 'a.event_id = ?';
                $params[] = $eventId;
            }
            if ($status !== '' && $status !== 'all' && $appId <= 0) {
                $where[] = 'a.status = ?';
                $params[] = $status;
            }
            if ($sinceId > 0 && $appId <= 0) {
                $where[] = 'a.id > ?';
                $params[] = $sinceId;
            }
            $sql = "SELECT a.*, u.nickname, u.username, e.name AS event_name
                    FROM galonly_staff_applications a
                    LEFT JOIN users u ON u.id = a.user_id
                    LEFT JOIN galonly_events e ON e.id = a.event_id";
            if ($where) $sql .= ' WHERE ' . implode(' AND ', $where);
            if ($appId > 0) {
                $sql .= ' LIMIT 1';
            } else {
                $sql .= ' ORDER BY a.id ' . ($order === 'desc' ? 'DESC' : 'ASC') . ' LIMIT ' . (int)$limit;
            }
            try {
                $stmt = $db->prepare($sql);
                $stmt->execute($params);
                $items = [];
                foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                    $positions = [];
                    $rawPositions = botString($row['positions'] ?? '');
                    if ($rawPositions !== '') {
                        $decoded = json_decode($rawPositions, true);
                        $positions = is_array($decoded) ? array_values(array_map('strval', $decoded)) : [];
                    }
                    $clubName = '';
                    $clubId = (int)($row['club_id'] ?? 0);
                    if ($clubId > 0) {
                        $club = botFindClub($clubId, botString($row['club_country'] ?? 'china') ?: 'china');
                        $clubName = $club ? botString($club['display_name'] ?? $club['name'] ?? ('同好会#' . $clubId)) : ('同好会#' . $clubId);
                    }
                    $items[] = [
                        'id' => (int)($row['id'] ?? 0),
                        'event_id' => (int)($row['event_id'] ?? 0),
                        'event_name' => botString($row['event_name'] ?? ''),
                        'cn_name' => botString($row['cn_name'] ?? ''),
                        'qq_number' => botString($row['qq_number'] ?? ''),
                        'phone_number' => botString($row['phone_number'] ?? ''),
                        'email' => botString($row['email'] ?? ''),
                        'club_id' => $clubId,
                        'club_country' => botString($row['club_country'] ?? 'china') ?: 'china',
                        'club_name' => $clubName,
                        'positions' => $positions,
                        'confirm_schedule' => (int)($row['confirm_schedule'] ?? 0),
                        'is_cosplay' => (int)($row['is_cosplay'] ?? 0),
                        'three_day_available' => (int)($row['three_day_available'] ?? 0),
                        'self_intro' => botString($row['self_intro'] ?? ''),
                        'gender' => botString($row['gender'] ?? ''),
                        'staff_experience' => (int)($row['staff_experience'] ?? 0),
                        'skills' => botString($row['skills'] ?? ''),
                        'status' => botString($row['status'] ?? ''),
                        'applicant_name' => botString($row['nickname'] ?? '') ?: (botString($row['username'] ?? '') ?: ('用户#' . (int)($row['user_id'] ?? 0))),
                        'username' => botString($row['username'] ?? ''),
                        'user_id' => (int)($row['user_id'] ?? 0),
                        'created_at' => botString($row['created_at'] ?? ''),
                        'updated_at' => botString($row['updated_at'] ?? ''),
                    ];
                }
                botRespond(['success' => true, 'total' => count($items), 'data' => $items]);
            } catch (Throwable $e) {
                botRespond(['success' => false, 'error' => 'galonly staff application query failed'], 400);
            }
        }

    default:
        botRespond(['success' => false, 'error' => '未知 action', 'action' => $action], 400);
}
