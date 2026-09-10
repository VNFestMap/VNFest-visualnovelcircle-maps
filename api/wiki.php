<?php
// api/wiki.php - wiki content editor API

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/image_host.php';

$rootDir = dirname(__DIR__);
$contentDir = $rootDir . '/wiki/content';
$pagesDir = $rootDir . '/wiki/pages';
$indexFile = $rootDir . '/wiki/index.json';
$homeFile = $rootDir . '/wiki/index.html';
$uploadsDir = $rootDir . '/wiki/uploads';

function wikiJsonResponse(array $payload, int $statusCode = 200): void {
    http_response_code($statusCode);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit();
}

function wikiServerError(Throwable $error): void {
    error_log('[wiki] ' . $error->getMessage() . "\n" . $error->getTraceAsString());
    wikiJsonResponse([
        'success' => false,
        'message' => '维基保存服务异常，请稍后重试或联系管理员查看服务器日志',
    ], 500);
}

function wikiEnsureDir(string $dir): bool {
    return is_dir($dir) || @mkdir($dir, 0755, true);
}

function wikiWriteFile(string $file, string $contents): bool {
    $dir = dirname($file);
    if (!wikiEnsureDir($dir)) return false;
    $temporaryFile = @tempnam($dir, '.wiki-write-');
    if ($temporaryFile === false) return false;
    if (@file_put_contents($temporaryFile, $contents, LOCK_EX) === false) {
        @unlink($temporaryFile);
        return false;
    }
    // Replace through the writable directory so root-owned 644 files from a deployment
    // do not make the PHP editor fail when the runtime user is www.
    @chmod($temporaryFile, 0664);
    if (!@rename($temporaryFile, $file)) {
        @unlink($temporaryFile);
        return false;
    }
    return true;
}

function wikiParseClubKey(string $clubKey): array {
    if (!preg_match('/^(china|japan)-([0-9]+)$/', $clubKey, $matches)) {
        wikiJsonResponse(['success' => false, 'message' => '无效的 wiki 标识']);
    }
    return [$matches[1], (int)$matches[2]];
}

function wikiReadJson(string $file, array $fallback): array {
    if (!file_exists($file)) return $fallback;
    $data = json_decode(file_get_contents($file), true);
    return is_array($data) ? $data : $fallback;
}

function wikiWriteJson(string $file, array $data): bool {
    return wikiWriteFile($file, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
}

function wikiEscape(string $value): string {
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function wikiFormatText(string $value): string {
    $normalized = str_replace(["\\r\\n", "\\n", "\\r"], ["\n", "\n", "\r"], $value);
    $tokens = [];
    $token = static function (string $html) use (&$tokens): string {
        $index = count($tokens);
        $tokens[] = $html;
        return '@@WIKIMARKDOWN' . $index . '@@';
    };
    $normalized = preg_replace_callback('/`([^`\r\n]+)`/', static function (array $match) use ($token): string {
        return $token('<code>' . wikiEscape($match[1]) . '</code>');
    }, $normalized);
    $normalized = preg_replace_callback('/\[([^\]\r\n]+)\]\(([^)\s]+)\)/', static function (array $match) use ($token): string {
        $safe = wikiSafeHref($match[2]);
        if ($safe === '#') return $match[0];
        return $token('<a href="' . wikiEscape($safe) . '" target="_blank" rel="noopener noreferrer">' . wikiEscape($match[1]) . '</a>');
    }, $normalized);

    $html = wikiEscape($normalized);
    $html = preg_replace('/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/s', '<strong>$2</strong>', $html);
    $html = preg_replace('/~~(?=\S)(.+?)(?<=\S)~~/s', '<del>$1</del>', $html);
    $html = preg_replace('/(^|[^\w])([*_])(?=\S)(.+?)(?<=\S)\2(?!\w)/s', '$1<em>$3</em>', $html);
    $html = nl2br($html, false);
    return preg_replace_callback('/@@WIKIMARKDOWN(\d+)@@/', static function (array $match) use ($tokens): string {
        return $tokens[(int)$match[1]] ?? '';
    }, $html);
}

function wikiSafeHref(string $value): string {
    $url = trim($value);
    if ($url === '') return '#';
    if (preg_match('/^\s*(?:javascript|vbscript|data:text\/html):/i', $url)) return '#';
    return $url;
}

function wikiImageWidthPercent($value): int {
    $width = (int)$value;
    if ($width < 25) return 25;
    if ($width > 100) return 100;
    return $width;
}

function wikiImageOption($value, array $allowed, string $fallback): string {
    $value = trim((string)$value);
    return in_array($value, $allowed, true) ? $value : $fallback;
}

function wikiSectionHeadingLevel($value): int {
    return (int)$value === 3 ? 3 : 2;
}

function wikiNormalizeImages($images): array {
    $normalized = [];
    foreach ((array)$images as $image) {
        if (!is_array($image)) continue;
        $url = wikiSafeHref((string)($image['url'] ?? ''));
        if ($url === '#') continue;
        $caption = trim((string)($image['caption'] ?? ''));
        $alt = trim((string)($image['alt'] ?? ''));
        $normalized[] = [
            'url' => $url,
            'caption' => $caption,
            'alt' => $alt,
            'width_percent' => wikiImageWidthPercent($image['width_percent'] ?? 100),
            'aspect_ratio' => wikiImageOption($image['aspect_ratio'] ?? '16/10', ['auto', '16/9', '4/3', '1/1', '3/4', '16/10'], '16/10'),
            'align' => wikiImageOption($image['align'] ?? 'center', ['left', 'center', 'right'], 'center'),
            'fit' => wikiImageOption($image['fit'] ?? 'cover', ['cover', 'contain'], 'cover'),
        ];
    }
    return $normalized;
}

function wikiNormalizeAvatar($avatar): array {
    if (!is_array($avatar)) return [];
    $url = wikiSafeHref((string)($avatar['url'] ?? ''));
    if ($url === '#') return [];
    return [
        'url' => $url,
        'caption' => trim((string)($avatar['caption'] ?? '')),
        'alt' => trim((string)($avatar['alt'] ?? '')),
        'position' => ($avatar['position'] ?? 'top') === 'bottom' ? 'bottom' : 'top',
    ];
}

function wikiNormalizeParagraphs($body): array {
    if (is_string($body)) {
        $body = preg_split('/\r\n|\r|\n/', $body);
    }
    $paragraphs = [];
    foreach ((array)$body as $text) {
        $text = trim((string)$text);
        if ($text !== '') $paragraphs[] = $text;
    }
    return $paragraphs;
}

function wikiNormalizeBlocks($blocks, $body = [], $legacyImages = []): array {
    $normalized = [];
    $hasExplicitBlocks = is_array($blocks) && count($blocks) > 0;
    if ($hasExplicitBlocks) {
        foreach ($blocks as $block) {
            if (!is_array($block)) continue;
            $type = strtolower(trim((string)($block['type'] ?? '')));
            if ($type === 'paragraph') {
                $text = trim((string)($block['text'] ?? ''));
                $noteValue = $block['note'] ?? '';
                $note = is_scalar($noteValue) ? trim((string)$noteValue) : '';
                if ($text !== '') $normalized[] = ['type' => 'paragraph', 'text' => $text, 'note' => $note];
                continue;
            }
            if ($type === 'image') {
                $images = wikiNormalizeImages([$block]);
                if ($images) $normalized[] = array_merge(['type' => 'image'], $images[0]);
            }
        }
        if ($normalized) return $normalized;
    }

    foreach (wikiNormalizeParagraphs($body) as $text) {
        $normalized[] = ['type' => 'paragraph', 'text' => $text, 'note' => ''];
    }
    foreach (wikiNormalizeImages($legacyImages) as $image) {
        $normalized[] = array_merge(['type' => 'image'], $image);
    }
    return $normalized;
}

function wikiBlocksBody(array $blocks): array {
    $body = [];
    foreach ($blocks as $block) {
        if (($block['type'] ?? '') === 'paragraph' && trim((string)($block['text'] ?? '')) !== '') {
            $body[] = trim((string)$block['text']);
        }
    }
    return $body;
}

function wikiNormalizeSection(array $section): ?array {
    $heading = trim((string)($section['heading'] ?? ''));
    $blocks = wikiNormalizeBlocks($section['blocks'] ?? [], $section['body'] ?? [], $section['images'] ?? []);
    if ($heading === '' || !$blocks) return null;
    return [
        'heading' => $heading,
        'level' => wikiSectionHeadingLevel($section['level'] ?? 2),
        'blocks' => $blocks,
        'body' => wikiBlocksBody($blocks),
    ];
}

function wikiSectionBlocks(array $section): array {
    return wikiNormalizeBlocks($section['blocks'] ?? [], $section['body'] ?? [], $section['images'] ?? []);
}

function wikiPageName(string $clubKey): string {
    [$country, $id] = wikiParseClubKey($clubKey);
    return $country . '-' . $id . '.html';
}

function wikiLanguagePageName(string $clubKey, string $lang = 'zh'): string {
    $pageName = wikiPageName($clubKey);
    return $lang === 'ja' ? preg_replace('/\.html$/', '-ja.html', $pageName) : $pageName;
}

function wikiCountryLabel(string $country): string {
    return $country === 'japan' ? '日本' : '中国';
}

function wikiDisplayName(array $club): string {
    return (string)($club['display_name'] ?? $club['name'] ?? $club['school'] ?? '');
}

function wikiNormalizeRegionName(string $value, string $country = 'china'): string {
    $value = trim($value);
    if ($value === '') return '';
    if ($country === 'japan') return $value;
    return preg_replace('/(壮族自治区|回族自治区|维吾尔自治区|特别行政区|自治区|省|市)$/u', '', $value) ?? $value;
}

function wikiRegionForClub(array $club, array $content): string {
    $country = (string)($club['country'] ?? explode('-', (string)($content['club_key'] ?? 'china'))[0] ?? 'china');
    return wikiNormalizeRegionName((string)($club['province'] ?? $club['prefecture'] ?? ($content['infobox']['地区'] ?? '') ?? ''), $country);
}

function wikiGetClub(string $country, int $clubId): array {
    $file = $country === 'japan' ? __DIR__ . '/../data/clubs_japan.json' : __DIR__ . '/../data/clubs.json';
    $json = wikiReadJson($file, ['data' => []]);
    foreach (($json['data'] ?? []) as $row) {
        if ((int)($row['id'] ?? 0) === $clubId) {
            $row['country'] = $country;
            return $row;
        }
    }
    return ['id' => $clubId, 'country' => $country];
}

function wikiDefaultContent(string $clubKey, array $club): array {
    $title = trim((string)($club['display_name'] ?? $club['name'] ?? $club['school'] ?? $clubKey));
    $region = trim((string)($club['province'] ?? $club['prefecture'] ?? ''));
    return [
        'club_key' => $clubKey,
        'title' => $title,
        'summary' => $title . ' 是登记在 Galgame 同好会地图中的高校同好会之一。',
        'infobox' => [
            '学校' => (string)($club['school'] ?? ''),
            '地区' => $region,
            '类型' => (($club['type'] ?? 'school') === 'school') ? '高校同好会' : '同好会',
            '成立时间' => (string)($club['created_at'] ?? ''),
            '状态' => !empty($club['verified']) ? '已认证' : '未认证',
        ],
        'sections' => [
            [
                'heading' => '概要',
                'level' => 2,
                'body' => ['本页面用于整理该同好会的公开资料、发展历史、活动记录和对外链接。'],
            ],
        ],
        'images' => [],
        'references' => [
            ['label' => 'Galgame 同好会地图登记资料', 'url' => '../../index.html'],
        ],
        'updated_at' => date('Y-m-d'),
    ];
}

function wikiNormalizeLocalizedContent(array $input): array {
    $title = trim((string)($input['title'] ?? ''));
    $summary = trim((string)($input['summary'] ?? ''));

    $infobox = [];
    if (isset($input['infobox']) && is_array($input['infobox'])) {
        foreach ($input['infobox'] as $key => $value) {
            $key = trim((string)$key);
            $value = trim((string)$value);
            if ($key !== '' && $value !== '') $infobox[$key] = $value;
        }
    }

    $sections = [];
    foreach (($input['sections'] ?? []) as $section) {
        if (!is_array($section)) continue;
        $normalizedSection = wikiNormalizeSection($section);
        if ($normalizedSection) $sections[] = $normalizedSection;
    }

    $hasContent = $title !== '' || $summary !== '' || !empty($infobox) || !empty($sections);
    if (!$hasContent) return [];

    $content = [];
    if ($title !== '') $content['title'] = $title;
    if ($summary !== '') $content['summary'] = $summary;
    if (!empty($infobox)) $content['infobox'] = $infobox;
    if (!empty($sections)) $content['sections'] = $sections;
    return $content;
}

function wikiNormalizeContent(array $input, string $clubKey, array $club): array {
    $default = wikiDefaultContent($clubKey, $club);
    $title = trim((string)($input['title'] ?? $default['title']));
    $summary = trim((string)($input['summary'] ?? $default['summary']));
    if ($title === '' || $summary === '') {
        wikiJsonResponse(['success' => false, 'message' => '标题和摘要不能为空']);
    }

    $infobox = [];
    if (isset($input['infobox']) && is_array($input['infobox'])) {
        foreach ($input['infobox'] as $key => $value) {
            $key = trim((string)$key);
            $value = trim((string)$value);
            if ($key !== '' && $value !== '') $infobox[$key] = $value;
        }
    }
    if (!$infobox) $infobox = $default['infobox'];

    $sections = [];
    foreach (($input['sections'] ?? []) as $section) {
        if (!is_array($section)) continue;
        $normalizedSection = wikiNormalizeSection($section);
        if ($normalizedSection) $sections[] = $normalizedSection;
    }
    if (!$sections) {
        wikiJsonResponse(['success' => false, 'message' => '至少需要一个章节，且章节需要包含正文或内容块']);
    }

    $images = wikiNormalizeImages($input['images'] ?? []);
    $avatar = wikiNormalizeAvatar($input['avatar'] ?? []);

    $references = [];
    foreach (($input['references'] ?? []) as $ref) {
        if (!is_array($ref)) continue;
        $label = trim((string)($ref['label'] ?? ''));
        $url = trim((string)($ref['url'] ?? ''));
        if ($label !== '' || $url !== '') {
            $references[] = ['label' => $label ?: $url, 'url' => wikiSafeHref($url)];
        }
    }

    $i18n = [];
    if (isset($input['i18n']['ja']) && is_array($input['i18n']['ja'])) {
        $ja = wikiNormalizeLocalizedContent($input['i18n']['ja']);
        if (!empty($ja)) $i18n['ja'] = $ja;
    }

    return [
        'club_key' => $clubKey,
        'title' => $title,
        'summary' => $summary,
        'infobox' => $infobox,
        'sections' => $sections,
        'images' => $images,
        'avatar' => $avatar,
        'references' => $references,
        'i18n' => $i18n,
        'updated_at' => date('Y-m-d'),
    ];
}

function wikiRenderBlocks(array $blocks, string $lang = 'zh', ?array &$footnotes = null): string {
    if ($footnotes === null) $footnotes = [];
    $html = '';
    foreach ($blocks as $block) {
        if (!is_array($block)) continue;
        if (($block['type'] ?? '') === 'paragraph') {
            $text = trim((string)($block['text'] ?? ''));
            if ($text !== '') {
                $noteValue = $block['note'] ?? '';
                $note = is_scalar($noteValue) ? trim((string)$noteValue) : '';
                $html .= '<p>' . wikiFormatText($text);
                if ($note !== '') {
                    $footnotes[] = $note;
                    $number = count($footnotes);
                    $footnoteId = $lang . '-footnote-' . $number;
                    $referenceId = $lang . '-footnote-ref-' . $number;
                    $html .= '<sup class="wiki-footnote-marker"><a href="#' . wikiEscape($footnoteId) . '" id="' . wikiEscape($referenceId) . '" aria-label="查看注释 ' . $number . '">' . $number . '</a></sup>';
                }
                $html .= "</p>\n";
            }
            continue;
        }
        if (($block['type'] ?? '') === 'image') {
            $html .= wikiRenderImages([$block], 'wiki-image-gallery wiki-inline-image-gallery', '正文图片');
        }
    }
    return $html;
}

function wikiRenderFootnotes(array $footnotes, string $lang): string {
    if (!$footnotes) return '';
    $items = '';
    foreach ($footnotes as $index => $note) {
        $number = $index + 1;
        $footnoteId = $lang . '-footnote-' . $number;
        $referenceId = $lang . '-footnote-ref-' . $number;
        $items .= '<li id="' . wikiEscape($footnoteId) . '"><a class="wiki-footnote-backlink" href="#' . wikiEscape($referenceId) . '" aria-label="返回正文">' . $number . '.</a> ' . wikiFormatText((string)$note) . '</li>';
    }
    return '<section class="wiki-section wiki-footnotes" aria-labelledby="' . wikiEscape($lang . '-footnotes-title') . '"><h2 id="' . wikiEscape($lang . '-footnotes-title') . '">注释</h2><ol>' . $items . '</ol></section>';
}

function wikiRenderImages(array $images, string $className = 'wiki-image-gallery', string $label = '图片'): string {
    $items = '';
    foreach ($images as $image) {
        if (!is_array($image)) continue;
        $url = wikiSafeHref((string)($image['url'] ?? ''));
        if ($url === '#') continue;
        $caption = trim((string)($image['caption'] ?? ''));
        $alt = trim((string)($image['alt'] ?? $caption));
        $width = wikiImageWidthPercent($image['width_percent'] ?? 100);
        $ratio = wikiImageOption($image['aspect_ratio'] ?? '16/10', ['auto', '16/9', '4/3', '1/1', '3/4', '16/10'], '16/10');
        $align = wikiImageOption($image['align'] ?? 'center', ['left', 'center', 'right'], 'center');
        $fit = wikiImageOption($image['fit'] ?? 'cover', ['cover', 'contain'], 'cover');
        $ratioStyle = $ratio !== 'auto' ? '--wiki-image-ratio:' . $ratio . ';' : '--wiki-image-ratio:auto;';
        $items .= '<figure class="wiki-image-card wiki-image-align-' . $align . ' wiki-image-fit-' . $fit . '" style="--wiki-image-width:' . $width . '%;' . $ratioStyle . '">';
        $items .= '<img src="' . wikiEscape($url) . '" alt="' . wikiEscape($alt) . '" loading="lazy">';
        if ($caption !== '') {
            $items .= '<figcaption>' . wikiFormatText($caption) . '</figcaption>';
        }
        $items .= "</figure>\n";
    }
    if ($items === '') return '';
    return '<section class="' . wikiEscape($className) . '" aria-label="' . wikiEscape($label) . '">' . $items . '</section>';
}

function wikiLocalizedContent(array $content, string $lang): array {
    $localized = $lang === 'ja' && isset($content['i18n']['ja']) && is_array($content['i18n']['ja'])
        ? $content['i18n']['ja']
        : [];
    return array_merge($content, [
        'title' => (string)($localized['title'] ?? $content['title'] ?? ''),
        'summary' => (string)($localized['summary'] ?? $content['summary'] ?? ''),
        'infobox' => !empty($localized['infobox']) && is_array($localized['infobox']) ? $localized['infobox'] : ($content['infobox'] ?? []),
        'sections' => !empty($localized['sections']) && is_array($localized['sections']) ? $localized['sections'] : ($content['sections'] ?? []),
        'images' => !empty($localized['images']) && is_array($localized['images']) ? $localized['images'] : ($content['images'] ?? []),
        'references' => !empty($localized['references']) && is_array($localized['references']) ? $localized['references'] : ($content['references'] ?? []),
        'avatar' => !empty($localized['avatar']) && is_array($localized['avatar']) ? $localized['avatar'] : ($content['avatar'] ?? []),
    ]);
}

function wikiRenderAppearanceRail(): string {
    return '<aside class="wiki-appearance-rail" aria-label="阅读外观" data-wiki-appearance aria-hidden="false"><div class="wiki-appearance-header"><div class="wiki-rail-heading">阅读外观</div><div class="wiki-appearance-header-actions"><button type="button" class="wiki-appearance-close" data-appearance-close aria-label="关闭阅读设置" hidden>×</button><button type="button" class="wiki-appearance-hide" data-appearance-hide>隐藏</button></div></div><button class="wiki-appearance-toggle" type="button" data-appearance-toggle aria-expanded="false">展开阅读设置</button><div class="wiki-appearance-panel" data-appearance-panel><fieldset><legend>字号</legend><div class="wiki-appearance-options" role="group" aria-label="字号"><button type="button" data-appearance-key="font" data-appearance-value="small">小</button><button type="button" data-appearance-key="font" data-appearance-value="medium">标准</button><button type="button" data-appearance-key="font" data-appearance-value="large">大</button></div></fieldset><fieldset><legend>正文宽度</legend><div class="wiki-appearance-options" role="group" aria-label="正文宽度"><button type="button" data-appearance-key="width" data-appearance-value="narrow">窄</button><button type="button" data-appearance-key="width" data-appearance-value="standard">标准</button><button type="button" data-appearance-key="width" data-appearance-value="wide">宽</button></div></fieldset><fieldset><legend>行距</legend><div class="wiki-appearance-options" role="group" aria-label="行距"><button type="button" data-appearance-key="leading" data-appearance-value="compact">紧凑</button><button type="button" data-appearance-key="leading" data-appearance-value="standard">标准</button><button type="button" data-appearance-key="leading" data-appearance-value="loose">宽松</button></div></fieldset><fieldset><legend>阅读主题</legend><div class="wiki-appearance-options" role="group" aria-label="阅读主题"><button type="button" data-appearance-key="theme" data-appearance-value="light">明亮</button><button type="button" data-appearance-key="theme" data-appearance-value="paper">纸张</button><button type="button" data-appearance-key="theme" data-appearance-value="dark">深色</button></div></fieldset><button type="button" class="wiki-appearance-reset" data-appearance-reset>恢复默认</button><button type="button" class="wiki-appearance-dock" data-appearance-dock hidden>恢复到侧栏</button></div></aside>';
}

function wikiRenderAppearanceLauncher(): string {
    return '<button type="button" class="wiki-appearance-launcher" data-appearance-launcher aria-label="打开阅读外观" aria-expanded="false" hidden><svg viewBox="0 0 24 24" width="18" height="18" role="img" aria-hidden="true" focusable="false"><title>阅读外观</title><path d="M4 5.5h16v13H4zM8 9v3m0 0 2-2m-2 2 2 2m6-3v3m0 0 2-2m-2 2 2 2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
}

function wikiRenderTocItems(array $items): string {
    $html = '';
    foreach ($items as $item) {
        $children = !empty($item['children'])
            ? '<ol class="wiki-toc-sublist">' . wikiRenderTocItems($item['children']) . '</ol>'
            : '';
        $html .= '<li class="wiki-toc-item wiki-toc-level-' . (int)$item['level'] . '"><a href="#' . wikiEscape($item['id']) . '" data-wiki-section-link="' . wikiEscape($item['id']) . '">' . wikiEscape($item['heading']) . '</a>' . $children . '</li>';
    }
    return $html;
}

function wikiRenderAvatar(array $avatar): string {
    $url = wikiSafeHref((string)($avatar['url'] ?? ''));
    if ($url === '#') return '';
    $caption = trim((string)($avatar['caption'] ?? ''));
    $alt = trim((string)($avatar['alt'] ?? ''));
    if ($alt === '') $alt = $caption !== '' ? $caption : '条目头像';
    $html = '<figure class="wiki-entry-avatar wiki-image-fit-contain" aria-label="条目头像"><img src="' . wikiEscape($url) . '" alt="' . wikiEscape($alt) . '" loading="lazy">';
    if ($caption !== '') $html .= '<figcaption>' . wikiEscape($caption) . '</figcaption>';
    return $html . '</figure>';
}

function wikiRenderArticle(array $content, array $club, string $lang, bool $hidden = false): string {
    $rows = $content['infobox'] ?? [];
    $infoboxRows = '';
    foreach ($rows as $key => $value) {
        if (trim((string)$value) === '') continue;
        $infoboxRows .= '<tr><th>' . wikiEscape((string)$key) . '</th><td>' . wikiFormatText((string)$value) . "</td></tr>\n";
    }

    $tocItems = [];
    foreach (($content['sections'] ?? []) as $i => $section) {
        $sectionId = $lang . '-section-' . ($i + 1);
        $level = wikiSectionHeadingLevel($section['level'] ?? 2);
        $item = ['id' => $sectionId, 'heading' => (string)($section['heading'] ?? ''), 'level' => $level, 'children' => []];
        if ($level === 3 && !empty($tocItems)) $tocItems[count($tocItems) - 1]['children'][] = $item;
        else $tocItems[] = $item;
    }
    $toc = wikiRenderTocItems($tocItems);

    $footnotes = [];
    $sections = '';
    foreach (($content['sections'] ?? []) as $i => $section) {
        $level = wikiSectionHeadingLevel($section['level'] ?? 2);
        $sectionId = $lang . '-section-' . ($i + 1);
        $sections .= '<section class="wiki-section" id="' . wikiEscape($sectionId) . '" data-wiki-section="' . wikiEscape($sectionId) . '">' . "\n";
        $sections .= '<h' . $level . '>' . wikiEscape((string)$section['heading']) . '</h' . $level . ">\n";
        $sections .= wikiRenderBlocks(wikiSectionBlocks($section), $lang, $footnotes);
        $sections .= "\n</section>\n";
    }

    $refs = '';
    foreach (($content['references'] ?? []) as $ref) {
        $label = wikiEscape((string)($ref['label'] ?? $ref['url'] ?? '参考资料'));
        $url = wikiEscape(wikiSafeHref((string)($ref['url'] ?? '#')));
        $refs .= '<li><a href="' . $url . '" target="_blank" rel="noopener noreferrer">' . $label . "</a></li>\n";
    }
    $references = $refs ? '<section class="wiki-section wiki-references"><h2>参考资料</h2><ol>' . $refs . '</ol></section>' : '';

    $title = wikiEscape((string)$content['title']);
    $summary = wikiEscape((string)$content['summary']);
    $updated = wikiEscape((string)($content['updated_at'] ?? '未记录'));
    $images = wikiRenderImages($content['images'] ?? []);
    $avatar = wikiRenderAvatar($content['avatar'] ?? []);
    $avatarTop = (($content['avatar']['position'] ?? 'top') === 'bottom') ? '' : $avatar;
    $avatarBottom = (($content['avatar']['position'] ?? 'top') === 'bottom') ? $avatar : '';
    $hiddenAttribute = $hidden ? ' hidden' : '';

    $entryFacts = '<aside class="wiki-entry-facts" aria-label="条目资料"><div class="wiki-rail-heading">条目资料</div>' . $avatarTop . '<div class="wiki-infobox"><div class="wiki-infobox-title">' . $title . '</div><table>' . $infoboxRows . '</table></div>' . $avatarBottom . '</aside>';

    return '<article class="wiki-article" data-wiki-lang="' . wikiEscape($lang) . '" data-wiki-article="true"' . $hiddenAttribute . '>
      <aside class="wiki-article-nav">
        <nav class="wiki-toc" aria-label="目录"><div class="wiki-toc-title">目录</div><ol>' . $toc . '</ol></nav>
      </aside>
      <div class="wiki-article-main">
        <header class="wiki-article-header"><p class="wiki-index-kicker">VNFest WIKI · 条目</p><h1>' . $title . '</h1></header>
        <p class="wiki-summary">' . wikiFormatText((string)$content['summary']) . '</p>
        ' . $entryFacts . '
        ' . $images . '
        ' . $sections . '
        ' . wikiRenderFootnotes($footnotes, $lang) . '
        ' . $references . '
        <footer class="wiki-footer">最后更新：' . $updated . '</footer>
      </div>
      <aside class="wiki-article-rail">
        ' . wikiRenderAppearanceRail() . '
      </aside>
    </article>';
}

function wikiRenderPage(array $content, array $club, string $lang = 'zh'): string {
    $article = wikiLocalizedContent($content, $lang);
    $title = wikiEscape((string)($article['title'] ?? $content['title'] ?? ''));
    $isJapanese = $lang === 'ja';
    $pageName = wikiLanguagePageName((string)$content['club_key'], $lang);
    $zhPageName = wikiLanguagePageName((string)$content['club_key'], 'zh');
    $jaPageName = wikiLanguagePageName((string)$content['club_key'], 'ja');

    return '<!DOCTYPE html>
<html lang="' . ($isJapanese ? 'ja' : 'zh-CN') . '">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="../../js/language-runtime.js?v=20260813-language"></script>
  <script src="../../js/language-catalog.js?v=20260813-language"></script>
  <script src="../../js/language-static-ja.js?v=20260813-language"></script>
  <title>' . $title . ' - 同好会维基</title>
  <link rel="stylesheet" href="../wiki.css?v=20260817-editor-workbench">
</head>
<body>
  <header class="wiki-header">
    <a href="../../index.html">Galgame 同好会地图</a>
    <a href="../index.html">VNFest WIKI</a>
    <span>同好会维基</span>
    ' . wikiRenderAppearanceLauncher() . '
  </header>
  <main class="wiki-page wiki-reading-page" data-wiki-page-lang="' . wikiEscape($lang) . '" data-wiki-page-name="' . wikiEscape($pageName) . '">
    <nav class="wiki-language-switch" role="tablist" aria-label="页面语言">
      <a role="tab" data-wiki-language="zh" aria-selected="' . ($isJapanese ? 'false' : 'true') . '" class="' . ($isJapanese ? '' : 'is-active') . '" href="./' . wikiEscape($zhPageName) . '">中文</a>
      <a role="tab" data-wiki-language="ja" aria-selected="' . ($isJapanese ? 'true' : 'false') . '" class="' . ($isJapanese ? 'is-active' : '') . '" href="./' . wikiEscape($jaPageName) . '">日本語</a>
    </nav>
    ' . wikiRenderArticle($article, $club, $lang, false) . '
  </main>
  <script src="../wiki-page.js?v=20260816-motion"></script>
</body>
</html>
';
}

function wikiReadLibraryDocs(string $rootDir): array {
    $data = wikiReadJson($rootDir . '/wiki/library/index.json', ['docs' => []]);
    $docs = [];
    foreach (($data['docs'] ?? []) as $doc) {
        if (!is_array($doc) || empty($doc['title']) || empty($doc['url'])) continue;
        $docs[] = [
            'title' => (string)$doc['title'],
            'url' => (string)$doc['url'],
            'category' => (string)($doc['category'] ?? '文档'),
            'description' => (string)($doc['description'] ?? ''),
            'updated_at' => (string)($doc['updated_at'] ?? ''),
        ];
    }
    return $docs;
}

function wikiReadFeatureSlots(string $rootDir): array {
    $data = wikiReadJson($rootDir . '/wiki/feature-slots.json', ['slots' => []]);
    $slots = [];
    foreach (($data['slots'] ?? []) as $slot) {
        if (!is_array($slot) || empty($slot['key']) || empty($slot['title'])) continue;
        $slots[] = [
            'key' => (string)$slot['key'],
            'title' => (string)$slot['title'],
            'description' => (string)($slot['description'] ?? ''),
            'status' => (string)($slot['status'] ?? 'reserved'),
            'url' => (string)($slot['url'] ?? ''),
        ];
    }
    return $slots;
}

function wikiRenderIndexHome(array $manifest, array $libraryDocs, array $featureSlots): string {
    $countries = ['china' => '中国', 'japan' => '日本'];
    $items = array_values($manifest);
    usort($items, function ($a, $b) {
        $left = (string)($a['country'] ?? '') . (string)($a['region'] ?? '') . (string)($a['title'] ?? '');
        $right = (string)($b['country'] ?? '') . (string)($b['region'] ?? '') . (string)($b['title'] ?? '');
        return strcmp($left, $right);
    });

    $renderEntry = function (array $item): string {
        $summary = trim((string)($item['summary'] ?? '该页面已建立，内容可继续补充。'));
        $summary = preg_split('/\r\n|\r|\n/', $summary)[0] ?? $summary;
        $search = strtolower(implode(' ', [$item['title'] ?? '', $item['club_name'] ?? '', $item['school'] ?? '', $item['region'] ?? '', $item['summary'] ?? '']));
        return '<article class="wiki-index-card wiki-entry" data-search="' . wikiEscape($search) . '">' .
            '<div class="wiki-index-card-meta">' . wikiEscape((string)($item['school'] ?? '未标注学校')) . ' · ' . wikiEscape((string)($item['region'] ?? '未标注地区')) . ' · ' . wikiEscape((string)($item['updated_at'] ?? '未记录更新')) . '</div>' .
            '<h3><a href="' . wikiEscape((string)($item['url'] ?? '#')) . '">' . wikiEscape((string)($item['title'] ?? '未命名页面')) . '</a></h3>' .
            '<p>' . wikiEscape($summary ?: '该页面已建立，内容可继续补充。') . '</p>' .
            '</article>';
    };

    $recentItems = $items;
    usort($recentItems, function ($a, $b) {
        $date = strcmp((string)($b['updated_at'] ?? ''), (string)($a['updated_at'] ?? ''));
        return $date !== 0 ? $date : strcmp((string)($a['title'] ?? ''), (string)($b['title'] ?? ''));
    });
    $recentHtml = '';
    foreach (array_slice($recentItems, 0, 6) as $item) {
        if (is_array($item)) $recentHtml .= $renderEntry($item);
    }
    if ($recentHtml === '') {
        $recentHtml = '<p class="wiki-index-empty">暂无最近更新。</p>';
    }

    $countryHtml = '';
    foreach ($countries as $country => $label) {
        $countryItems = array_filter($items, function ($item) use ($country) {
            return ($item['country'] ?? '') === $country;
        });
        $regions = [];
        foreach ($countryItems as $item) {
            $regions[(string)($item['region'] ?? '未标注地区')][] = $item;
        }
        $regionHtml = '';
        foreach ($regions as $region => $rows) {
            $cards = '';
            foreach ($rows as $item) {
                $cards .= $renderEntry($item);
            }
            $regionHtml .= '<section class="wiki-index-region"><h3>' . wikiEscape($region) . ' <span>' . count($rows) . '</span></h3><div class="wiki-entry-list">' . $cards . '</div></section>';
        }
        $countryHtml .= '<section class="wiki-index-country wiki-article-shell" id="country-' . $country . '"><div class="wiki-index-section-heading"><h2>' . $label . '</h2><span>' . count($countryItems) . ' 个页面</span></div>' . ($regionHtml ?: '<p class="wiki-index-empty">暂无已生成的' . $label . ' Wiki 页面。</p>') . '</section>';
    }

    $slotHtml = '';
    foreach ($featureSlots as $slot) {
        $enabled = ($slot['status'] ?? '') === 'active' && !empty($slot['url']);
        $slotHtml .= '<article class="wiki-extension-card wiki-maintenance-item' . ($enabled ? '' : ' is-disabled') . '">' .
            '<div class="wiki-index-card-meta">' . ($enabled ? '已启用' : '预留模块') . ' · ' . wikiEscape((string)$slot['key']) . '</div>' .
            '<h3>' . wikiEscape((string)$slot['title']) . '</h3>' .
            '<p>' . wikiEscape((string)$slot['description']) . '</p>' .
            '<a href="' . wikiEscape($enabled ? (string)$slot['url'] : '#') . '">' . ($enabled ? '进入模块' : '等待后续开发') . '</a>' .
            '</article>';
    }

    $libraryHtml = '';
    foreach ($libraryDocs as $doc) {
        $search = strtolower(implode(' ', [$doc['title'], $doc['category'], $doc['description']]));
        $libraryHtml .= '<article class="wiki-library-card wiki-entry" data-search="' . wikiEscape($search) . '">' .
            '<div class="wiki-index-card-meta">' . wikiEscape($doc['category']) . ' · ' . wikiEscape($doc['updated_at'] ?: '未记录更新') . '</div>' .
            '<h3><a href="' . wikiEscape($doc['url']) . '">' . wikiEscape($doc['title']) . '</a></h3>' .
            '<p>' . wikiEscape($doc['description'] ?: '文档库条目') . '</p>' .
            '</article>';
    }

    $allPagesHtml = '';
    foreach ($items as $item) {
        if (!is_array($item)) continue;
        $search = strtolower(implode(' ', [$item['title'] ?? '', $item['club_name'] ?? '', $item['school'] ?? '', $item['region'] ?? '', $item['summary'] ?? '']));
        $allPagesHtml .= '<a class="wiki-page-index-item wiki-index-card" href="' . wikiEscape((string)($item['url'] ?? '#')) . '" data-search="' . wikiEscape($search) . '">' .
            wikiEscape((string)($item['title'] ?? '未命名页面')) .
            '<span>' . wikiEscape((string)($item['school'] ?? ($item['region'] ?? '未标注'))) . '</span></a>';
    }
    if ($allPagesHtml === '') {
        $allPagesHtml = '<p class="wiki-index-empty">暂无已生成的高校 Wiki 页面。</p>';
    }

    return '<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="../js/language-runtime.js?v=20260813-language"></script>
  <script src="../js/language-catalog.js?v=20260813-language"></script>
  <script src="../js/language-static-ja.js?v=20260813-language"></script>
  <title>VNFest WIKI</title>
  <link rel="stylesheet" href="./wiki.css">
</head>
<body class="wiki-index-body">
  <header class="wiki-header wiki-site-header">
    <a href="../index.html">Galgame 同好会地图</a>
    <span>VNFest WIKI</span>
  </header>
  <main class="wiki-index-page wiki-encyclopedia-layout">
    <aside class="wiki-index-sidebar" aria-label="站点目录">
      <div class="wiki-sidebar-card"><p class="wiki-index-kicker">VNFest WIKI</p><h1>高校同好会百科</h1><p>集中整理高校视觉小说、Galgame 与相关同好会资料。</p></div>
      <nav class="wiki-nav wiki-index-toc" aria-label="首页目录"><a href="#recent-updates">最近更新</a><a href="#country-china">中国</a><a href="#country-japan">日本</a><a href="#all-pages">全部页面</a><a href="#wiki-library">文档库</a><a href="#maintenance">维护中心</a></nav>
    </aside>
    <section class="wiki-index-main">
    <section class="wiki-index-hero wiki-article-shell">
      <div><p class="wiki-index-kicker">百科索引</p><h2>VNFest WIKI 首页</h2><p>按地区、学校、文档和维护状态浏览同好会 Wiki。新增页面后，首页会从 JSON 索引自动同步。</p></div>
      <div class="wiki-index-stats"><div><strong id="statWiki">' . count($manifest) . '</strong><span>高校 Wiki</span></div><div><strong id="statLib">' . count($libraryDocs) . '</strong><span>文档条目</span></div></div>
    </section>
    <section class="wiki-index-tools wiki-article-shell"><label class="wiki-search-label" for="wikiIndexSearch">搜索条目</label><input id="wikiIndexSearch" type="search" placeholder="搜索学校、同好会、地区或文档"><p>搜索会同时过滤地区索引、全部页面和文档库。</p></section>
    <section class="wiki-index-notice wiki-article-shell"><strong>索引规则</strong><span>本页由后台保存或生成器检测 wiki/content 中已填写的高校 Wiki 内容后生成。</span></section>
    <section class="wiki-index-country wiki-article-shell" id="recent-updates"><div class="wiki-index-section-heading"><h2>最近更新</h2><span>按更新时间排序</span></div><div class="wiki-entry-list" id="recentUpdates">' . $recentHtml . '</div></section>
    <div id="wikiCountries">
    ' . $countryHtml . '
    </div>
    <section class="wiki-index-country wiki-article-shell" id="all-pages"><div class="wiki-index-section-heading"><h2>全部页面索引</h2><span id="allPagesCount">' . count($manifest) . ' 个页面</span></div><div class="wiki-page-index" id="allPagesList">' . $allPagesHtml . '</div></section>
    <div id="wikiLibrary"><section class="wiki-index-country wiki-article-shell" id="wiki-library"><div class="wiki-index-section-heading"><h2>文档库</h2><span>' . count($libraryDocs) . ' 个文档</span></div><div class="wiki-entry-list">' . ($libraryHtml ?: '<p class="wiki-index-empty">暂无文档。可以在 wiki/library/index.json 中添加文档条目。</p>') . '</div></section></div>
    <div class="wiki-empty-search" id="emptySearch">没有找到匹配的结果，试试其他关键词。</div>
    </section>
    <aside class="wiki-index-aside" aria-label="维护与编写">
      <section class="wiki-sidebar-card" id="maintenance"><div class="wiki-index-section-heading"><h2>维护中心</h2><span id="statExt">' . count($featureSlots) . ' 个扩展位</span></div><div class="wiki-maintenance-list" id="extensionsGrid">' . ($slotHtml ?: '<p class="wiki-index-empty">暂无扩展预留。</p>') . '</div></section>
      <section class="wiki-sidebar-card"><h2>编写指南</h2><p>建议优先补充简介、发展沿革、活动记录、公开链接和参考资料。</p><a class="wiki-text-link" href="./library/wiki-writing-guide.html">查看编写说明</a></section>
    </aside>
  </main>
  <script>(function(){var input=document.getElementById("wikiIndexSearch");var empty=document.getElementById("emptySearch");var navLinks=document.querySelectorAll(".wiki-nav a");function search(){var keyword=(input.value||"").trim().toLowerCase();var cards=document.querySelectorAll(".wiki-index-card,.wiki-library-card");var visible=false;cards.forEach(function(card){var hit=!keyword||(card.getAttribute("data-search")||"").indexOf(keyword)!==-1;card.style.display=hit?"":"none";if(hit&&card.closest("#wikiCountries,#wikiLibrary,#all-pages"))visible=true;});document.querySelectorAll(".wiki-index-region").forEach(function(region){var has=Array.prototype.some.call(region.querySelectorAll(".wiki-index-card"),function(card){return card.style.display!=="none";});region.classList.toggle("is-hidden",!has);});if(empty)empty.classList.toggle("is-visible",!!keyword&&!visible);}if(input)input.addEventListener("input",search);navLinks.forEach(function(link){link.addEventListener("click",function(event){var target=document.querySelector(link.getAttribute("href"));if(!target)return;event.preventDefault();target.scrollIntoView({behavior:"smooth",block:"start"});});});})();</script>
</body>
</html>';
}

function wikiGeneratePageAndIndex(string $clubKey, array $content, array $club, string $rootDir, string $contentDir, string $pagesDir, string $indexFile, string $homeFile): array {
    $pageName = wikiPageName($clubKey);
    if (!wikiWriteFile($pagesDir . '/' . $pageName, wikiRenderPage($content, $club))) {
        throw new RuntimeException('wiki page write failed: ' . $pageName);
    }
    $jaPageName = wikiLanguagePageName($clubKey, 'ja');
    if (!wikiWriteFile($pagesDir . '/' . $jaPageName, wikiRenderPage($content, $club, 'ja'))) {
        throw new RuntimeException('wiki page write failed: ' . $jaPageName);
    }

    $manifest = [];
    if (is_dir($contentDir)) {
        foreach (glob($contentDir . '/*.json') ?: [] as $file) {
            $row = wikiReadJson($file, []);
            if (empty($row['club_key']) || empty($row['title'])) continue;
            $name = wikiPageName((string)$row['club_key']);
            [$rowCountry, $rowId] = wikiParseClubKey((string)$row['club_key']);
            $rowClub = wikiGetClub($rowCountry, $rowId);
            $rowManifest = [
                'title' => (string)$row['title'],
                'url' => './pages/' . $name,
                'country' => $rowCountry,
                'country_label' => wikiCountryLabel($rowCountry),
                'school' => (string)($rowClub['school'] ?? ($row['infobox']['学校'] ?? '')),
                'club_name' => wikiDisplayName($rowClub),
                'region' => wikiRegionForClub($rowClub, $row),
                'summary' => (string)($row['summary'] ?? ''),
                'updated_at' => (string)($row['updated_at'] ?? ''),
            ];
            if (!empty($row['i18n']['ja']) && is_array($row['i18n']['ja'])) {
                $rowManifest['i18n'] = [
                    'ja' => [
                        'title' => (string)($row['i18n']['ja']['title'] ?? $row['title'] ?? ''),
                        'summary' => (string)($row['i18n']['ja']['summary'] ?? $row['summary'] ?? ''),
                        'region' => (string)($row['i18n']['ja']['region'] ?? ($row['i18n']['ja']['infobox']['Region'] ?? ($row['i18n']['ja']['infobox']['地域'] ?? ''))),
                        'url' => './pages/' . wikiLanguagePageName((string)$row['club_key'], 'ja'),
                    ],
                ];
            }
            $manifest[$row['club_key']] = $rowManifest;
        }
    }
    if (!wikiWriteJson($indexFile, $manifest)) {
        throw new RuntimeException('wiki index write failed');
    }
    if (!file_exists($homeFile)) {
        if (!wikiWriteFile($homeFile, wikiRenderIndexHome($manifest, wikiReadLibraryDocs($rootDir), wikiReadFeatureSlots($rootDir)))) {
            throw new RuntimeException('wiki home write failed');
        }
    }

    return ['page_url' => './wiki/pages/' . $pageName, 'ja_page_url' => './wiki/pages/' . $jaPageName, 'manifest' => $manifest];
}

function wikiUploadImage(string $clubKey, string $uploadsDir): void {
    if (!isset($_FILES['image']) || $_FILES['image']['error'] !== UPLOAD_ERR_OK) {
        wikiJsonResponse(['success' => false, 'message' => '上传失败，请重新选择图片']);
    }

    $file = $_FILES['image'];
    if ($file['size'] > 10 * 1024 * 1024) {
        wikiJsonResponse(['success' => false, 'message' => '图片大小不能超过 10MB']);
    }

    $detectedType = null;
    if (function_exists('exif_imagetype')) {
        $detectedType = @exif_imagetype($file['tmp_name']);
    } elseif (function_exists('getimagesize')) {
        $info = @getimagesize($file['tmp_name']);
        $detectedType = $info[2] ?? null;
    } else {
        $extMap = [
            'jpg' => IMAGETYPE_JPEG,
            'jpeg' => IMAGETYPE_JPEG,
            'png' => IMAGETYPE_PNG,
            'gif' => IMAGETYPE_GIF,
            'webp' => IMAGETYPE_WEBP,
        ];
        $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
        $detectedType = $extMap[$ext] ?? null;
    }

    $allowedTypes = [IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_GIF, IMAGETYPE_WEBP];
    if (!in_array($detectedType, $allowedTypes, true)) {
        wikiJsonResponse(['success' => false, 'message' => '仅支持 JPEG、PNG、GIF、WebP 格式']);
    }

    $extMap = [
        IMAGETYPE_JPEG => 'jpg',
        IMAGETYPE_PNG => 'png',
        IMAGETYPE_GIF => 'gif',
        IMAGETYPE_WEBP => 'webp',
    ];
    $ext = $extMap[$detectedType];
    $dir = $uploadsDir . '/' . $clubKey;
    if (!wikiEnsureDir($dir)) {
        wikiJsonResponse(['success' => false, 'message' => '图片目录不可写，请联系管理员检查 wiki/uploads 权限']);
    }

    $fileBase = date('YmdHis') . '_' . bin2hex(random_bytes(4));
    $fileName = $fileBase . '.' . $ext;
    $destPath = $dir . '/' . $fileName;
    $localUrl = '../uploads/' . $clubKey . '/' . $fileName;
    $stored = imageHostStoreUploadedFile($file['tmp_name'], $destPath, $localUrl, (string)$file['name'], 'wiki:' . $clubKey);
    if (!$stored['ok']) {
        wikiJsonResponse(['success' => false, 'message' => $stored['error'] ?? '图片保存失败']);
    }

    $imageUrl = $stored['url'] . (str_contains($stored['url'], '?') ? '&' : '?') . 't=' . time();
    wikiJsonResponse([
        'success' => true,
        'message' => '图片上传成功',
        'image_url' => $imageUrl,
        'storage' => $stored['storage'],
        'local_backup' => $stored['local_backup'],
    ]);
}

/*
 * 使用文档站：与同好会 Wiki 的内容模型分开保存。种子文件随代码发布，
 * data/wiki-guide 为 Docker 持久化目录，运营人员的草稿和已发布版本不会被镜像覆盖。
 */
function wikiGuideLanguage(string $lang): string {
    return $lang === 'ja-JP' ? 'ja-JP' : 'zh-CN';
}

function wikiGuideTruncate(string $value, int $length): string {
    // 开发机可能未启用 mbstring。此时宁可不截断 UTF-8 内容，也不能按字节截断并写出无效 JSON。
    return function_exists('mb_substr') ? mb_substr($value, 0, $length) : $value;
}

function wikiGuideId(string $id): string {
    $id = trim($id);
    return preg_match('/^[a-z0-9][a-z0-9\/-]{1,100}$/', $id) ? $id : '';
}

function wikiGuideSeedFile(string $rootDir, string $lang): string {
    return $rootDir . '/wiki/guide/seed/' . wikiGuideLanguage($lang) . '/documents.json';
}

function wikiGuideDataFile(string $rootDir, string $lang): string {
    return $rootDir . '/data/wiki-guide/' . wikiGuideLanguage($lang) . '/documents.json';
}

function wikiGuideRevision(array $catalog): string {
    return hash('sha256', json_encode($catalog, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

function wikiGuideReadSeed(string $rootDir, string $lang): array {
    $seed = wikiReadJson(wikiGuideSeedFile($rootDir, $lang), []);
    if (!is_array($seed) || !isset($seed['articles']) || !is_array($seed['articles'])) {
        throw new RuntimeException('guide seed is missing or invalid');
    }
    $seed['groups'] = is_array($seed['groups'] ?? null) ? $seed['groups'] : [];
    return $seed;
}

function wikiGuideNormalizeArticle(array $article, string $id, string $lang): array {
    $article['id'] = $id;
    $article['product'] = wikiGuideTruncate(trim((string)($article['product'] ?? 'VNFest')), 80);
    $article['audience'] = wikiGuideTruncate(trim((string)($article['audience'] ?? '')), 80);
    $article['title'] = wikiGuideTruncate(trim((string)($article['title'] ?? '')), 160);
    $article['summary'] = wikiGuideTruncate(trim((string)($article['summary'] ?? '')), 1500);
    $article['updatedAt'] = trim((string)($article['updatedAt'] ?? date('Y-m-d')));
    $article['previousId'] = wikiGuideId((string)($article['previousId'] ?? ''));
    $article['nextId'] = wikiGuideId((string)($article['nextId'] ?? ''));
    $article['search'] = array_values(array_filter(array_map(function ($value) {
        return wikiGuideTruncate(trim((string)$value), 80);
    }, is_array($article['search'] ?? null) ? $article['search'] : [])));
    $sections = [];
    foreach (is_array($article['sections'] ?? null) ? $article['sections'] : [] as $section) {
        if (!is_array($section)) continue;
        $title = wikiGuideTruncate(trim((string)($section['title'] ?? '')), 160);
        if ($title === '') continue;
        $blocks = [];
        foreach (is_array($section['blocks'] ?? null) ? $section['blocks'] : [] as $block) {
            if (!is_array($block)) continue;
            $type = (string)($block['type'] ?? 'paragraph');
            if (!in_array($type, ['paragraph', 'heading', 'tip', 'warning', 'steps', 'list', 'code', 'table', 'image'], true)) continue;
            $clean = ['type' => $type];
            if (in_array($type, ['paragraph', 'heading', 'tip', 'warning', 'code'], true)) {
                $clean['text'] = wikiGuideTruncate((string)($block['text'] ?? ''), $type === 'code' ? 8000 : 3000);
                if (isset($block['label'])) $clean['label'] = wikiGuideTruncate((string)$block['label'], 80);
            } elseif (in_array($type, ['steps', 'list'], true)) {
                $clean['items'] = array_values(array_filter(array_map(function ($value) {
                    return wikiGuideTruncate(trim((string)$value), 1000);
                }, is_array($block['items'] ?? null) ? $block['items'] : [])));
            } elseif ($type === 'table') {
                $clean['headers'] = array_values(array_map(function ($value) { return wikiGuideTruncate((string)$value, 300); }, is_array($block['headers'] ?? null) ? $block['headers'] : []));
                $clean['rows'] = [];
                foreach (is_array($block['rows'] ?? null) ? $block['rows'] : [] as $row) {
                    if (!is_array($row)) continue;
                    $clean['rows'][] = array_values(array_map(function ($value) { return wikiGuideTruncate((string)$value, 1200); }, $row));
                }
            } else {
                $src = trim((string)($block['src'] ?? ''));
                $isGuideLocal = str_starts_with($src, '../uploads/guide/');
                if ($src === '' || (!$isGuideLocal && !str_starts_with($src, './assets/') && !imageHostIsTrustedUrl($src))) continue;
                $clean['src'] = $src;
                $clean['alt'] = wikiGuideTruncate((string)($block['alt'] ?? ''), 300);
                $clean['caption'] = wikiGuideTruncate((string)($block['caption'] ?? ''), 500);
            }
            $blocks[] = $clean;
        }
        $sections[] = ['title' => $title, 'blocks' => $blocks];
    }
    $article['sections'] = $sections;
    if ($article['title'] === '' || $article['summary'] === '') throw new RuntimeException('guide article title and summary are required');
    return $article;
}

function wikiGuideRuntimeFromSeed(array $seed): array {
    $seedRevision = wikiGuideRevision($seed);
    $articles = [];
    foreach ($seed['articles'] as $raw) {
        if (!is_array($raw)) continue;
        $id = wikiGuideId((string)($raw['id'] ?? ''));
        if ($id === '') continue;
        $article = wikiGuideNormalizeArticle($raw, $id, 'zh-CN');
        $articles[$id] = ['id' => $id, 'seedRevision' => $seedRevision, 'status' => 'published', 'draft' => null, 'published' => $article, 'updatedAt' => date('c'), 'updatedBy' => 0];
    }
    return ['version' => 1, 'seedRevision' => $seedRevision, 'groups' => $seed['groups'], 'articles' => $articles];
}

function wikiGuideReadRuntime(string $rootDir, string $lang): array {
    $lang = wikiGuideLanguage($lang);
    $file = wikiGuideDataFile($rootDir, $lang);
    if (file_exists($file)) {
        $runtime = wikiReadJson($file, []);
        if (is_array($runtime) && is_array($runtime['articles'] ?? null)) return $runtime;
    }
    $runtime = wikiGuideRuntimeFromSeed(wikiGuideReadSeed($rootDir, $lang));
    if (!wikiWriteJson($file, $runtime)) throw new RuntimeException('guide data initialization failed');
    return $runtime;
}

function wikiGuideWriteRuntime(string $rootDir, string $lang, array $runtime): void {
    if (!wikiWriteJson(wikiGuideDataFile($rootDir, $lang), $runtime)) throw new RuntimeException('guide data write failed');
}

function wikiGuidePublicCatalog(array $runtime, string $lang): array {
    $articles = [];
    foreach ($runtime['articles'] as $record) {
        if (!is_array($record) || ($record['status'] ?? '') !== 'published' || !is_array($record['published'] ?? null)) continue;
        $articles[] = $record['published'];
    }
    return ['version' => 1, 'language' => wikiGuideLanguage($lang), 'groups' => is_array($runtime['groups'] ?? null) ? $runtime['groups'] : [], 'articles' => $articles];
}

function wikiGuideRequireAdmin(): array {
    $user = requireRole('super_admin');
    if (($user['role'] ?? '') !== 'super_admin') {
        wikiJsonResponse(['success' => false, 'message' => '仅超级管理员可维护使用文档'], 403);
    }
    return $user;
}

function wikiGuideInput(): array {
    $input = json_decode(file_get_contents('php://input'), true);
    return is_array($input) ? $input : [];
}

function wikiHandleGuideAction(string $action, string $rootDir, string $uploadsDir): void {
    $lang = wikiGuideLanguage((string)($_GET['lang'] ?? 'zh-CN'));
    if (in_array($action, ['guide_catalog', 'guide_article'], true) && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $catalog = wikiGuidePublicCatalog(wikiGuideReadRuntime($rootDir, $lang), $lang);
        if ($action === 'guide_catalog') wikiJsonResponse(['success' => true, 'catalog' => $catalog]);
        $id = wikiGuideId((string)($_GET['id'] ?? ''));
        foreach ($catalog['articles'] as $article) if (($article['id'] ?? '') === $id) wikiJsonResponse(['success' => true, 'article' => $article]);
        wikiJsonResponse(['success' => false, 'message' => '文档不存在'], 404);
    }

    $user = wikiGuideRequireAdmin();
    $input = wikiGuideInput();
    if (isset($input['lang'])) $lang = wikiGuideLanguage((string)$input['lang']);
    $runtime = wikiGuideReadRuntime($rootDir, $lang);
    $seed = wikiGuideReadSeed($rootDir, $lang);
    $seedRevision = wikiGuideRevision($seed);

    if ($action === 'guide_admin_catalog' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        wikiJsonResponse(['success' => true, 'runtime' => $runtime, 'seedRevision' => $seedRevision]);
    }
    if ($action === 'guide_diff' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $runtimeIds = array_keys($runtime['articles'] ?? []);
        $seedIds = array_values(array_filter(array_map(function ($article) { return wikiGuideId((string)($article['id'] ?? '')); }, $seed['articles'] ?? [])));
        wikiJsonResponse(['success' => true, 'seedRevision' => $seedRevision, 'runtimeRevision' => (string)($runtime['seedRevision'] ?? ''), 'changed' => $seedRevision !== ($runtime['seedRevision'] ?? ''), 'addedArticleIds' => array_values(array_diff($seedIds, $runtimeIds)), 'retiredArticleIds' => array_values(array_diff($runtimeIds, $seedIds))]);
    }
    if ($action === 'guide_upload' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        wikiUploadImage('guide', $uploadsDir);
    }

    $id = wikiGuideId((string)($input['id'] ?? $_GET['id'] ?? ''));
    if ($id === '') wikiJsonResponse(['success' => false, 'message' => '无效文档 ID'], 422);
    if (!isset($runtime['articles'][$id])) {
        $seedArticle = null;
        foreach ($seed['articles'] as $raw) if (is_array($raw) && ($raw['id'] ?? '') === $id) $seedArticle = $raw;
        if (!$seedArticle) wikiJsonResponse(['success' => false, 'message' => '文档不存在'], 404);
        $runtime['articles'][$id] = ['id' => $id, 'seedRevision' => $seedRevision, 'status' => 'published', 'draft' => null, 'published' => wikiGuideNormalizeArticle($seedArticle, $id, $lang), 'updatedAt' => date('c'), 'updatedBy' => (int)$user['id']];
    }
    $record =& $runtime['articles'][$id];
    if ($action === 'guide_save_draft' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $record['draft'] = wikiGuideNormalizeArticle(is_array($input['article'] ?? null) ? $input['article'] : [], $id, $lang);
        $record['updatedAt'] = date('c'); $record['updatedBy'] = (int)$user['id'];
        wikiGuideWriteRuntime($rootDir, $lang, $runtime);
        wikiJsonResponse(['success' => true, 'record' => $record]);
    }
    if ($action === 'guide_publish' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $article = is_array($record['draft'] ?? null) ? $record['draft'] : ($record['published'] ?? null);
        if (!is_array($article)) wikiJsonResponse(['success' => false, 'message' => '没有可发布的内容'], 422);
        $record['published'] = $article; $record['draft'] = null; $record['status'] = 'published'; $record['seedRevision'] = $seedRevision; $record['updatedAt'] = date('c'); $record['updatedBy'] = (int)$user['id'];
        $runtime['seedRevision'] = $seedRevision;
        wikiGuideWriteRuntime($rootDir, $lang, $runtime);
        wikiJsonResponse(['success' => true, 'record' => $record]);
    }
    if ($action === 'guide_unpublish' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $record['status'] = 'draft'; $record['updatedAt'] = date('c'); $record['updatedBy'] = (int)$user['id'];
        wikiGuideWriteRuntime($rootDir, $lang, $runtime);
        wikiJsonResponse(['success' => true, 'record' => $record]);
    }
    if ($action === 'guide_reset_seed' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $seedArticle = null;
        foreach ($seed['articles'] as $raw) if (is_array($raw) && ($raw['id'] ?? '') === $id) $seedArticle = $raw;
        if (!$seedArticle) wikiJsonResponse(['success' => false, 'message' => '种子文档不存在'], 404);
        $record['draft'] = wikiGuideNormalizeArticle($seedArticle, $id, $lang); $record['seedRevision'] = $seedRevision; $record['updatedAt'] = date('c'); $record['updatedBy'] = (int)$user['id'];
        wikiGuideWriteRuntime($rootDir, $lang, $runtime);
        wikiJsonResponse(['success' => true, 'record' => $record]);
    }
    wikiJsonResponse(['success' => false, 'message' => '不支持的使用文档操作'], 405);
}

try {
    $action = $_GET['action'] ?? '';
    if (str_starts_with($action, 'guide_')) {
        wikiHandleGuideAction($action, $rootDir, $uploadsDir);
    }
    $clubKey = trim((string)($_GET['club_key'] ?? ''));
    if ($clubKey === '') {
        $inputForKey = json_decode(file_get_contents('php://input'), true);
        if (is_array($inputForKey)) $clubKey = trim((string)($inputForKey['club_key'] ?? ''));
    }
    [$country, $clubId] = wikiParseClubKey($clubKey);

    $user = requireLogin();
    if (!canManageClubInCountry($user, $clubId, $country)) {
        wikiJsonResponse(['success' => false, 'message' => '无权编辑该同好会维基'], 403);
    }

    $club = wikiGetClub($country, $clubId);
    $contentFile = $contentDir . '/' . $clubKey . '.json';

    if ($action === 'get' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $exists = file_exists($contentFile);
        $content = $exists ? wikiReadJson($contentFile, []) : wikiDefaultContent($clubKey, $club);
        wikiJsonResponse([
            'success' => true,
            'exists' => $exists,
            'club' => $club,
            'content' => $content,
            'page_url' => './wiki/pages/' . wikiPageName($clubKey),
            'ja_page_url' => './wiki/pages/' . wikiLanguagePageName($clubKey, 'ja'),
        ]);
    }

    if ($action === 'upload' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        wikiUploadImage($clubKey, $uploadsDir);
    }

    if ($action === 'save' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input)) {
            wikiJsonResponse(['success' => false, 'message' => '无效数据']);
        }
        $content = wikiNormalizeContent($input, $clubKey, $club);
        if (!wikiWriteJson($contentFile, $content)) {
            wikiJsonResponse(['success' => false, 'message' => '保存内容失败，请联系管理员检查 wiki/content 权限']);
        }
        $generated = wikiGeneratePageAndIndex($clubKey, $content, $club, $rootDir, $contentDir, $pagesDir, $indexFile, $homeFile);
        wikiJsonResponse([
            'success' => true,
            'message' => '维基内容已保存',
            'content' => $content,
            'page_url' => $generated['page_url'],
            'ja_page_url' => $generated['ja_page_url'],
        ]);
    }

    wikiJsonResponse(['success' => false, 'message' => '不支持的操作']);
} catch (Throwable $error) {
    wikiServerError($error);
}
