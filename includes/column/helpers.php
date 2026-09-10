<?php
declare(strict_types=1);

require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../display_club.php';
require_once __DIR__ . '/../rate_limit.php';
require_once __DIR__ . '/../audit.php';
require_once __DIR__ . '/schema.php';

const COLUMN_TITLE_MAX = 180;
const COLUMN_SUMMARY_MAX = 1200;
const COLUMN_MARKDOWN_MAX = 500000;
const COLUMN_IMAGE_MAX_BYTES = 10485760;
const COLUMN_IMAGE_MAX_COUNT = 30;
const COLUMN_IMAGE_MAX_DIMENSION = 12000;
const COLUMN_IMAGE_MAX_PIXELS = 40000000;

const COLUMN_ARTICLE_TYPES = [
    'essay' => '论',
    'review' => '评',
    'translation' => '译',
    'interview' => '访',
    'community' => '社',
];

const COLUMN_STATUSES = ['draft', 'published', 'hidden', 'deleted'];

function columnDb(): PDO
{
    $db = getDB();
    columnEnsureSchema($db);
    return $db;
}

function columnProjectRoot(): string
{
    return dirname(__DIR__, 2);
}

function columnJson(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function columnFail(string $code, string $message, int $status = 400, array $fields = []): never
{
    columnJson([
        'success' => false,
        'error' => [
            'code' => $code,
            'message' => $message,
            'fields' => $fields,
        ],
    ], $status);
}

function columnInput(): array
{
    $contentType = strtolower((string)($_SERVER['CONTENT_TYPE'] ?? ''));
    if (str_contains($contentType, 'application/json')) {
        $decoded = json_decode((string)file_get_contents('php://input'), true);
        return is_array($decoded) ? $decoded : [];
    }
    return is_array($_POST) ? $_POST : [];
}

function columnRequireMethod(string $method): void
{
    if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== strtoupper($method)) {
        header('Allow: ' . strtoupper($method));
        columnFail('method_not_allowed', '请求方法不允许', 405);
    }
}

function columnRequireSameOrigin(): void
{
    if (PHP_SAPI === 'cli') return;
    $fetchSite = strtolower(trim((string)($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '')));
    if ($fetchSite === 'cross-site') columnFail('cross_origin', '拒绝跨站写入请求', 403);

    $forwarded = strtolower(trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0] ?? ''));
    $scheme = in_array($forwarded, ['http', 'https'], true)
        ? $forwarded
        : ((!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off') ? 'https' : 'http');
    $authority = trim((string)($_SERVER['HTTP_HOST'] ?? ''));
    $requestUrl = parse_url($scheme . '://' . $authority);
    $requestHost = strtolower((string)($requestUrl['host'] ?? ''));
    $requestPort = (int)($requestUrl['port'] ?? ($scheme === 'https' ? 443 : 80));
    if ($requestHost === '') columnFail('cross_origin', '无法校验请求来源', 403);

    foreach (['HTTP_ORIGIN', 'HTTP_REFERER'] as $header) {
        $source = trim((string)($_SERVER[$header] ?? ''));
        if ($source === '') continue;
        $sourceUrl = parse_url($source);
        $sourceHost = strtolower((string)($sourceUrl['host'] ?? ''));
        $sourceScheme = strtolower((string)($sourceUrl['scheme'] ?? ''));
        $sourcePort = (int)($sourceUrl['port'] ?? ($sourceScheme === 'https' ? 443 : 80));
        if ($sourceHost === '' || !in_array($sourceScheme, ['http', 'https'], true)
            || $sourceHost !== $requestHost || $sourcePort !== $requestPort || $sourceScheme !== $scheme) {
            columnFail('cross_origin', '拒绝跨站写入请求', 403);
        }
        return;
    }
    columnFail('cross_origin', '缺少同源请求信息', 403);
}

function columnLength(string $value): int
{
    return function_exists('mb_strlen') ? mb_strlen($value, 'UTF-8') : strlen($value);
}

function columnSlice(string $value, int $length): string
{
    return function_exists('mb_substr') ? mb_substr($value, 0, $length, 'UTF-8') : substr($value, 0, $length);
}

function columnString(mixed $value, int $max, bool $required = true): string
{
    $value = trim((string)$value);
    if ($required && $value === '') columnFail('required', '必填内容不能为空', 422);
    if (columnLength($value) > $max) columnFail('too_long', '内容超过允许长度', 422, ['max_length' => $max]);
    return $value;
}

function columnPagination(array $query): array
{
    $page = max(1, (int)($query['page'] ?? 1));
    $perPage = min(30, max(1, (int)($query['per_page'] ?? $query['limit'] ?? 12)));
    return [$page, $perPage, ($page - 1) * $perPage];
}

function columnArticleType(mixed $value): string
{
    $value = strtolower(trim((string)$value));
    if (!array_key_exists($value, COLUMN_ARTICLE_TYPES)) columnFail('invalid_type', '请选择文章类型', 422, ['field' => 'type']);
    return $value;
}

function columnSafeHttpUrl(string $value): string
{
    $value = trim($value);
    if ($value === '' || !preg_match('/^https?:\/\/[^\s"<>]+$/i', $value)) return '';
    return $value;
}

function columnSafeUploadPath(string $value): string
{
    $value = trim(str_replace('\\', '/', $value));
    $value = preg_replace('/^\/+/', '', $value) ?? '';
    $value = preg_replace('/^\.\/+/', '', $value) ?? '';
    if ($value === '' || str_contains($value, '..') || !preg_match('#^uploads/column/[a-zA-Z0-9/_\-.]+$#', $value)) return '';
    return '/' . $value;
}

function columnStoredPath(string $value): string
{
    $safe = columnSafeUploadPath($value);
    return $safe === '' ? '' : ltrim($safe, '/');
}

function columnMarkdownImagePaths(string $markdown): array
{
    preg_match_all('/!\[[^\]]{0,200}\]\(\s*([^\s)]+)(?:\s+["\'][^)]*["\'])?\s*\)/u', $markdown, $matches);
    $paths = [];
    foreach ($matches[1] ?? [] as $source) {
        $path = columnSafeUploadPath((string)$source);
        if ($path === '') columnFail('invalid_markdown_image', '正文图片必须使用专栏附件', 422);
        $stored = ltrim($path, '/');
        if (!in_array($stored, $paths, true)) $paths[] = $stored;
    }
    return $paths;
}

function columnValidateMarkdown(string $markdown): void
{
    if (columnLength($markdown) > COLUMN_MARKDOWN_MAX) columnFail('too_long', '正文超过允许长度', 422, ['max_length' => COLUMN_MARKDOWN_MAX]);
    if (preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', $markdown)) columnFail('invalid_markdown', '正文包含不可用字符', 422);
    if (preg_match('/<!--[\s\S]*?-->|<\/?[a-z][^>]*>/i', $markdown)) columnFail('html_not_allowed', '正文不支持原始 HTML', 422);
    if (preg_match('/^\s*\|.*\|\s*$/m', $markdown)) columnFail('table_not_allowed', '正文暂不支持表格', 422);

    preg_match_all('/(?<!!)\[[^\]]{1,400}\]\(\s*([^\s)]+)(?:\s+["\'][^)]*["\'])?\s*\)/u', $markdown, $links);
    foreach ($links[1] ?? [] as $href) {
        if (columnSafeHttpUrl((string)$href) === '') columnFail('invalid_markdown_link', '链接只支持 HTTP(S) 地址', 422);
    }
    columnMarkdownImagePaths($markdown);
}

function columnMarkdownConverter(): object
{
    $autoload = columnProjectRoot() . '/vendor/autoload.php';
    if (is_file($autoload)) require_once $autoload;
    if (!class_exists('League\\CommonMark\\CommonMarkConverter')) {
        throw new RuntimeException('缺少 league/commonmark 依赖');
    }
    return new \League\CommonMark\CommonMarkConverter([
        'html_input' => 'strip',
        'allow_unsafe_links' => false,
    ]);
}

function columnSanitizeHtml(string $html): string
{
    $html = trim($html);
    if ($html === '') return '';
    if (!class_exists('DOMDocument')) {
        $html = preg_replace('/<!--[\s\S]*?-->|<(script|style|noscript|iframe|object|embed|svg|math|form|input|button|textarea|select|template)[^>]*>[\s\S]*?<\/\1>/i', '', $html) ?? '';
        $allowed = ['p', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'img', 'hr', 'br'];
        $html = preg_replace_callback('/<\s*(\/?)\s*([a-z0-9]+)([^>]*)>/i', static function (array $match) use ($allowed): string {
            $closing = $match[1] === '/';
            $tag = strtolower($match[2]);
            if (!in_array($tag, $allowed, true)) return '';
            if ($closing) return in_array($tag, ['img', 'hr', 'br'], true) ? '' : '</' . $tag . '>';
            $attrs = html_entity_decode((string)$match[3], ENT_QUOTES | ENT_HTML5, 'UTF-8');
            if ($tag === 'a') {
                preg_match('/\bhref\s*=\s*(?:( ["\'])(.*?)\1|([^\s>]+))/ix', $attrs, $hrefMatch);
                $href = columnSafeHttpUrl((string)($hrefMatch[2] ?? $hrefMatch[3] ?? ''));
                return $href === '' ? '' : '<a href="' . htmlspecialchars($href, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '" target="_blank" rel="noopener noreferrer">';
            }
            if ($tag === 'img') {
                preg_match('/\bsrc\s*=\s*(?:( ["\'])(.*?)\1|([^\s>]+))/ix', $attrs, $srcMatch);
                $src = columnSafeUploadPath((string)($srcMatch[2] ?? $srcMatch[3] ?? ''));
                if ($src === '') return '';
                preg_match('/\balt\s*=\s*(?:( ["\'])(.*?)\1|([^\s>]+))/ix', $attrs, $altMatch);
                $alt = trim((string)($altMatch[2] ?? $altMatch[3] ?? '')) ?: '文章配图';
                return '<img src="' . htmlspecialchars($src, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '" alt="' . htmlspecialchars(columnSlice($alt, 160), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '" loading="lazy" decoding="async">';
            }
            if ($tag === 'code' && preg_match('/\bclass\s*=\s*["\'](language-[a-z0-9_-]+)["\']/i', $attrs, $classMatch)) {
                return '<code class="' . htmlspecialchars(strtolower($classMatch[1]), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '">';
            }
            return in_array($tag, ['hr', 'br'], true) ? '<' . $tag . '>' : '<' . $tag . '>';
        }, $html) ?? '';
        return trim($html);
    }

    $previous = libxml_use_internal_errors(true);
    $document = new DOMDocument('1.0', 'UTF-8');
    $document->loadHTML('<?xml encoding="UTF-8"><div id="column-root">' . $html . '</div>', LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD);
    $root = $document->getElementById('column-root');
    if (!$root) {
        libxml_clear_errors();
        libxml_use_internal_errors($previous);
        return '';
    }
    $allowed = ['p', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'img', 'hr', 'br'];
    $remove = ['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'input', 'button', 'textarea', 'select', 'template'];
    $walk = static function (DOMNode $parent) use (&$walk, $allowed, $remove): void {
        for ($node = $parent->firstChild; $node; ) {
            $next = $node->nextSibling;
            if ($node->nodeType === XML_COMMENT_NODE) {
                $parent->removeChild($node);
                $node = $next;
                continue;
            }
            if ($node->nodeType !== XML_ELEMENT_NODE) {
                $node = $next;
                continue;
            }
            $tag = strtolower($node->nodeName);
            if (in_array($tag, $remove, true)) {
                $parent->removeChild($node);
                $node = $next;
                continue;
            }
            if (!in_array($tag, $allowed, true)) {
                while ($node->firstChild) $parent->insertBefore($node->firstChild, $node);
                $parent->removeChild($node);
                $node = $next;
                continue;
            }
            if ($tag === 'a') {
                $href = columnSafeHttpUrl((string)$node->getAttribute('href'));
                if ($href === '') {
                    while ($node->firstChild) $parent->insertBefore($node->firstChild, $node);
                    $parent->removeChild($node);
                    $node = $next;
                    continue;
                }
                while ($node->attributes->length) $node->removeAttribute($node->attributes->item(0)->name);
                $node->setAttribute('href', $href);
                $node->setAttribute('target', '_blank');
                $node->setAttribute('rel', 'noopener noreferrer');
            } elseif ($tag === 'img') {
                $src = columnSafeUploadPath((string)$node->getAttribute('src'));
                if ($src === '') {
                    $parent->removeChild($node);
                    $node = $next;
                    continue;
                }
                $alt = trim((string)$node->getAttribute('alt')) ?: '文章配图';
                while ($node->attributes->length) $node->removeAttribute($node->attributes->item(0)->name);
                $node->setAttribute('src', $src);
                $node->setAttribute('alt', columnSlice($alt, 160));
                $node->setAttribute('loading', 'lazy');
                $node->setAttribute('decoding', 'async');
            } elseif ($tag === 'code') {
                $class = strtolower((string)$node->getAttribute('class'));
                while ($node->attributes->length) $node->removeAttribute($node->attributes->item(0)->name);
                if (preg_match('/^language-[a-z0-9_-]+$/', $class)) $node->setAttribute('class', $class);
            } else {
                while ($node->attributes->length) $node->removeAttribute($node->attributes->item(0)->name);
            }
            $walk($node);
            $node = $next;
        }
    };
    $walk($root);
    $result = '';
    foreach ($root->childNodes as $child) $result .= $document->saveHTML($child);
    libxml_clear_errors();
    libxml_use_internal_errors($previous);
    return trim($result);
}

function columnTextFromHtml(string $html): string
{
    $text = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $text = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $text) ?? '';
    return trim(preg_replace('/\s+/u', ' ', $text) ?? '');
}

function columnReadMinutes(string $text): int
{
    return max(1, min(999, (int)ceil(columnLength($text) / 420)));
}

function columnDecorateBody(string $html): array
{
    $toc = [];
    $index = 0;
    $body = preg_replace_callback('/<h([23])>([\s\S]*?)<\/h\1>/i', static function (array $match) use (&$toc, &$index): string {
        $index++;
        $text = trim(columnTextFromHtml($match[2]));
        if ($text !== '') $toc[] = ['id' => 'column-section-' . $index, 'level' => (int)$match[1], 'text' => $text];
        return '<h' . $match[1] . ' id="column-section-' . $index . '">' . $match[2] . '</h' . $match[1] . '>';
    }, $html) ?? $html;
    return [trim($body), $toc];
}

function columnRenderMarkdown(string $markdown): array
{
    columnValidateMarkdown($markdown);
    $converter = columnMarkdownConverter();
    $rendered = $converter->convert($markdown);
    $html = columnSanitizeHtml((string)$rendered);
    [$html, $toc] = columnDecorateBody($html);
    return [
        'body_html' => $html,
        'body_text' => columnTextFromHtml($html),
        'toc_json' => json_encode($toc, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
    ];
}

function columnExcerpt(string $text, int $max = 180): string
{
    $text = trim($text);
    if (columnLength($text) <= $max) return $text;
    return rtrim(columnSlice($text, $max), " \t\r\n，。！？；：、") . '…';
}

function columnCanManage(?array $user): bool
{
    return (bool)$user && ($user['role'] ?? '') === 'super_admin';
}

function columnUserPayload(?array $user): ?array
{
    if (!$user) return null;
    return [
        'id' => (int)$user['id'],
        'username' => (string)($user['username'] ?? ''),
        'nickname' => trim((string)($user['nickname'] ?? '')) ?: (string)($user['username'] ?? ''),
        'avatar_url' => (string)($user['avatar_url'] ?? ''),
        'role' => (string)($user['role'] ?? 'member'),
        'can_write' => true,
        'can_manage' => columnCanManage($user),
    ];
}

function columnClubFromRow(array $row): ?array
{
    $clubId = (int)($row['club_id'] ?? 0);
    if ($clubId <= 0) return null;
    $country = strtolower(trim((string)($row['club_country'] ?? '')));
    if (!in_array($country, ['china', 'japan'], true)) {
        $matches = [];
        foreach (['china', 'japan'] as $candidate) {
            if (displayClubRecord($clubId, $candidate)) $matches[] = $candidate;
        }
        $country = count($matches) === 1 ? $matches[0] : '';
    }
    if ($country === '') return null;
    $club = displayClubRecord($clubId, $country);
    if (!$club) return null;
    return [
        'id' => $clubId,
        'country' => $country,
        'name' => trim((string)($club['display_name'] ?? $club['name'] ?? $club['school'] ?? '')),
    ];
}

function columnAuthorFromRow(array $row): array
{
    $username = (string)($row['author_username'] ?? $row['username'] ?? '');
    return [
        'id' => (int)($row['author_id'] ?? 0),
        'username' => $username,
        'nickname' => trim((string)($row['author_nickname'] ?? $row['nickname'] ?? '')) ?: $username,
        'avatar_url' => (string)($row['author_avatar_url'] ?? $row['avatar_url'] ?? ''),
    ];
}

function columnBaseSelect(): string
{
    return "SELECT d.*, u.username AS author_username, u.nickname AS author_nickname,
                   u.avatar_url AS author_avatar_url, u.role AS author_role
            FROM column_documents d
            JOIN users u ON u.id = d.author_id";
}

function columnFetchDocument(int $id): ?array
{
    if ($id <= 0) return null;
    $stmt = columnDb()->prepare(columnBaseSelect() . ' WHERE d.id = ? LIMIT 1');
    $stmt->execute([$id]);
    return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
}

function columnFetchDocumentByPath(string $pathKey): ?array
{
    $pathKey = trim($pathKey);
    if (!preg_match('/^a-[a-z0-9]+$/', $pathKey)) return null;
    $stmt = columnDb()->prepare(columnBaseSelect() . ' WHERE d.path_key = ? LIMIT 1');
    $stmt->execute([$pathKey]);
    return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
}

function columnArticleStatusVisible(?array $row, ?array $user): bool
{
    if (!$row) return false;
    if (($row['status'] ?? '') === 'published' && empty($row['deleted_at'])) return true;
    return (bool)$user && ((int)$row['author_id'] === (int)$user['id'] || columnCanManage($user));
}

function columnArticleCanEdit(?array $row, ?array $user): bool
{
    return (bool)$row && (bool)$user && empty($row['deleted_at'])
        && ((int)$row['author_id'] === (int)$user['id'] || columnCanManage($user));
}

function columnSerializeArticle(array $row, ?array $user = null, bool $includeBody = false, bool $includeMarkdown = false): array
{
    $status = (string)($row['status'] ?? 'draft');
    $canEdit = columnArticleCanEdit($row, $user);
    $isAdmin = columnCanManage($user);
    $payload = [
        'id' => (int)$row['id'],
        'path_key' => $row['path_key'] !== null ? (string)$row['path_key'] : null,
        'type' => (string)($row['type'] ?? 'essay'),
        'type_label' => COLUMN_ARTICLE_TYPES[(string)($row['type'] ?? '')] ?? '论',
        'title' => (string)$row['title'],
        'summary' => (string)($row['summary'] ?? ''),
        'excerpt' => columnExcerpt((string)($row['summary'] ?? '') ?: (string)($row['body_text'] ?? '')),
        'cover_url' => columnSafeUploadPath((string)($row['cover_path'] ?? '')),
        'read_minutes' => max(1, (int)($row['read_minutes'] ?? 1)),
        'status' => $status,
        'featured_rank' => $row['featured_rank'] !== null ? (int)$row['featured_rank'] : null,
        'published_at' => $row['published_at'] ?? null,
        'created_at' => $row['created_at'] ?? null,
        'updated_at' => $row['updated_at'] ?? null,
        'deleted_at' => $row['deleted_at'] ?? null,
        'author' => columnAuthorFromRow($row),
        'club' => columnClubFromRow($row),
        'capabilities' => [
            'edit' => $canEdit || $isAdmin,
            'withdraw' => ($canEdit || $isAdmin) && $status === 'published',
            'delete' => ($canEdit || $isAdmin) && $status !== 'deleted',
            'moderate' => $isAdmin,
        ],
    ];
    if ($includeBody) {
        $toc = json_decode((string)($row['toc_json'] ?? '[]'), true);
        $payload['body_html'] = (string)($row['body_html'] ?? '');
        $payload['toc'] = is_array($toc) ? $toc : [];
    }
    if ($includeMarkdown && ($canEdit || $isAdmin)) $payload['body_markdown'] = (string)($row['body_markdown'] ?? '');
    return $payload;
}

function columnSelectableClubs(int $userId): array
{
    if ($userId <= 0) return [];
    try {
        $stmt = columnDb()->prepare(
            "SELECT id, club_id, COALESCE(country, 'china') AS country, role, status
             FROM club_memberships
             WHERE user_id = ? AND status = 'active' AND role IN ('member','manager','representative')
             ORDER BY id DESC"
        );
        $stmt->execute([$userId]);
        $result = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $club = displayClubPublicFromMembership($row);
            if (!$club) continue;
            $result[] = [
                'membership_id' => (int)$row['id'],
                'club_id' => (int)$row['club_id'],
                'country' => (string)$club['country'],
                'name' => (string)$club['name'],
                'role' => (string)$row['role'],
            ];
        }
        return $result;
    } catch (Throwable $e) {
        return [];
    }
}

function columnResolveClubSelection(PDO $db, int $userId, mixed $membershipId): array
{
    $membershipId = (int)$membershipId;
    if ($membershipId <= 0) return ['club_id' => null, 'club_country' => null];
    $membership = displayClubSelectableMembership($db, $userId, $membershipId);
    if (!$membership) columnFail('invalid_club', '同好会归属无效或已失效', 422, ['field' => 'club_membership_id']);
    return [
        'club_id' => (int)$membership['club_id'],
        'club_country' => (string)$membership['country'],
    ];
}

function columnInputPayload(array $input): array
{
    $title = columnString($input['title'] ?? '', COLUMN_TITLE_MAX);
    $summary = columnString($input['summary'] ?? '', COLUMN_SUMMARY_MAX, false);
    $type = columnArticleType($input['type'] ?? $input['article_type'] ?? '');
    $markdown = columnString($input['body_markdown'] ?? '', COLUMN_MARKDOWN_MAX);
    $rendered = columnRenderMarkdown($markdown);
    $coverPath = columnStoredPath((string)($input['cover_path'] ?? ''));
    return [
        'title' => $title,
        'summary' => $summary,
        'type' => $type,
        'body_markdown' => $markdown,
        'body_html' => $rendered['body_html'],
        'body_text' => $rendered['body_text'],
        'toc_json' => $rendered['toc_json'],
        'cover_path' => $coverPath,
        'read_minutes' => columnReadMinutes($rendered['body_text']),
    ];
}

function columnBase36(int $value): string
{
    if ($value <= 0) return '0';
    $chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    $result = '';
    while ($value > 0) {
        $result = $chars[$value % 36] . $result;
        $value = intdiv($value, 36);
    }
    return $result;
}

function columnAttachmentPaths(PDO $db, int $userId, int $documentId, string $markdown, string $coverPath, string $uploadToken): void
{
    $paths = columnMarkdownImagePaths($markdown);
    if ($coverPath !== '' && !in_array($coverPath, $paths, true)) $paths[] = $coverPath;
    if (!$paths) return;
    foreach ($paths as $path) {
        $stmt = $db->prepare(
            'SELECT id, document_id, upload_token FROM column_attachments
             WHERE uploader_id = ? AND relative_path = ? AND (document_id IS NULL OR document_id = ?) LIMIT 1'
        );
        $stmt->execute([$userId, $path, $documentId]);
        $attachment = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$attachment) columnFail('attachment_not_owned', '正文包含未通过专栏上传的图片', 422);
        if ((int)($attachment['document_id'] ?? 0) === 0 && ($uploadToken === '' || (string)$attachment['upload_token'] !== $uploadToken)) {
            columnFail('attachment_token_mismatch', '图片上传标识已失效，请重新上传', 422);
        }
        if ((int)($attachment['document_id'] ?? 0) === 0) {
            $db->prepare('UPDATE column_attachments SET document_id = ? WHERE id = ? AND uploader_id = ? AND document_id IS NULL')->execute([$documentId, (int)$attachment['id'], $userId]);
        }
    }
}
