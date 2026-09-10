<?php
declare(strict_types=1);

require_once __DIR__ . '/../../includes/column/schema.php';
require_once __DIR__ . '/../../includes/column/helpers.php';

function testColumnAssert(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

function makeColumnTestDb(string $path): PDO
{
    $db = new PDO('sqlite:' . $path);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, nickname TEXT, avatar TEXT, role TEXT, status TEXT)');
    $db->exec("INSERT INTO users (id, username, nickname, avatar, role, status) VALUES (1, 'tester', '测试用户', '', 'user', 'active')");
    return $db;
}

$path = tempnam(sys_get_temp_dir(), 'column-mvp-');
$dirtyPath = tempnam(sys_get_temp_dir(), 'column-dirty-');
if ($path === false || $dirtyPath === false) throw new RuntimeException('无法创建测试数据库');

try {
    $db = makeColumnTestDb($path);
    columnMigrateSchema($db);
    columnMigrateSchema($db);
    foreach (['column_documents', 'column_attachments', 'column_document_revisions'] as $table) {
        testColumnAssert(columnTableExists($db, $table), "missing table {$table}");
    }
    foreach (['column_series', 'column_articles', 'column_tags', 'column_article_tags', 'column_comments'] as $table) {
        testColumnAssert(!columnTableExists($db, $table), "legacy table should not remain: {$table}");
    }
    $indexes = $db->query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_column_document_listing'")->fetchColumn();
    testColumnAssert($indexes === 'idx_column_document_listing', 'listing index missing');

    $rendered = columnRenderMarkdown("# 不允许的一级标题\n\n## 小节一\n\n正文 **加粗**。\n\n> 引用\n\n- 项目\n\n[站点](https://example.com)");
    testColumnAssert(str_contains($rendered['body_html'], '<h2 id="column-section-1">小节一</h2>'), 'h2 should receive a stable id');
    testColumnAssert(str_contains($rendered['body_html'], '<strong>加粗</strong>'), 'strong markdown missing');
    testColumnAssert(str_contains($rendered['body_text'], '正文 加粗'), 'plain text extraction missing');
    $toc = json_decode($rendered['toc_json'], true);
    testColumnAssert(is_array($toc) && count($toc) === 1 && $toc[0]['level'] === 2, 'toc generation failed');

    $safe = columnSanitizeHtml('<p onclick="bad()">ok</p><script>alert(1)</script><iframe src="x"></iframe><a href="javascript:bad()">bad</a><a href="https://example.com">good</a><img src="/uploads/column/1/a.webp" onerror="bad()"><img src="https://example.com/x.png">');
    testColumnAssert(!str_contains($safe, '<script') && !str_contains($safe, '<iframe'), 'unsafe elements survived');
    testColumnAssert(!str_contains($safe, 'onclick') && !str_contains($safe, 'onerror'), 'event attributes survived');
    testColumnAssert(!str_contains($safe, 'javascript:'), 'unsafe link survived');
    testColumnAssert(!str_contains($safe, 'https://example.com/x.png') && str_contains($safe, '/uploads/column/1/a.webp'), 'image source filtering failed');
    testColumnAssert(columnReadMinutes(str_repeat('字', 421)) === 2, 'reading time rounding failed');

    $normalized = columnInputPayload([
        'title' => '测试文章',
        'summary' => '摘要',
        'type' => 'essay',
        'body_markdown' => '正文',
    ]);
    testColumnAssert($normalized['title'] === '测试文章' && $normalized['type'] === 'essay', 'document input normalization failed');

    $dirtyDb = makeColumnTestDb($dirtyPath);
    $dirtyDb->exec('CREATE TABLE column_articles (id INTEGER PRIMARY KEY, title TEXT)');
    $dirtyDb->exec("INSERT INTO column_articles (id, title) VALUES (1, 'legacy')");
    $blocked = false;
    try {
        columnMigrateSchema($dirtyDb);
    } catch (RuntimeException $error) {
        $blocked = str_contains($error->getMessage(), '旧专栏表仍有数据');
    }
    testColumnAssert($blocked, 'migration must stop when legacy content exists');
    echo "column PHP checks passed\n";
} finally {
    @unlink($path);
    @unlink($dirtyPath);
}
