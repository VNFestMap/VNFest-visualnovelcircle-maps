<?php

require_once __DIR__ . '/../includes/club_code.php';

function expectClubCode(bool $condition, string $message): void
{
    if (!$condition) {
        fwrite(STDERR, $message . PHP_EOL);
        exit(1);
    }
}

$db = new PDO('sqlite::memory:');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
foreach ([
    'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL)',
    "CREATE TABLE club_memberships (\n" .
        "  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, club_id INTEGER NOT NULL,\n" .
        "  country TEXT DEFAULT 'china', role TEXT DEFAULT 'member', status TEXT DEFAULT 'active',\n" .
        "  join_method TEXT DEFAULT 'school_no_code', joined_at TEXT, left_at TEXT,\n" .
        "  UNIQUE(user_id, club_id, country)\n" .
        ")",
    "CREATE TABLE club_verification_codes (\n" .
        "  id INTEGER PRIMARY KEY AUTOINCREMENT, club_id INTEGER NOT NULL, code TEXT NOT NULL,\n" .
        "  created_by INTEGER NOT NULL, max_uses INTEGER DEFAULT 50, use_count INTEGER DEFAULT 0,\n" .
        "  expires_at TEXT, is_active INTEGER DEFAULT 1, country TEXT DEFAULT 'china'\n" .
        ")",
] as $statement) {
    $db->exec($statement);
}
$db->exec("INSERT INTO users (username) VALUES ('code-owner'), ('new-member'), ('another-member'), ('blocked-member')");
$db->exec("INSERT INTO club_verification_codes (club_id, code, created_by, max_uses, country) VALUES (7, 'JOINME7', 1, 2, 'china')");

$db->beginTransaction();
$first = clubCodeBindUser($db, 2, ' joinme7 ');
expectClubCode($first['success'] === true, 'a valid code should bind a new user');
expectClubCode($first['club_id'] === 7 && $first['country'] === 'china', 'binding should use the code club identity');
$db->commit();

$membership = $db->query("SELECT club_id, role, status, join_method FROM club_memberships WHERE user_id = 2")->fetch(PDO::FETCH_ASSOC);
expectClubCode(($membership['club_id'] ?? null) === 7, 'membership should target the code club');
expectClubCode(($membership['role'] ?? null) === 'member' && ($membership['status'] ?? null) === 'active', 'membership should be active member access');
expectClubCode(($membership['join_method'] ?? null) === 'school_code', 'membership should record school_code');
expectClubCode((int)$db->query('SELECT use_count FROM club_verification_codes WHERE id = 1')->fetchColumn() === 1, 'successful binding should consume one use');

$db->beginTransaction();
$invalid = clubCodeBindUser($db, 3, 'not-a-code');
expectClubCode($invalid['success'] === false && $invalid['message'] === '绑定码无效', 'invalid code should be rejected');
$db->rollBack();

$db->beginTransaction();
$second = clubCodeBindUser($db, 3, 'JOINME7');
expectClubCode($second['success'] === true, 'a code should be reusable until its limit');
$db->commit();

$db->beginTransaction();
$atLimit = clubCodeBindUser($db, 4, 'JOINME7');
expectClubCode($atLimit['success'] === false && $atLimit['message'] === '绑定码已达使用上限', 'code usage limit should be enforced');
$db->rollBack();
expectClubCode((int)$db->query('SELECT COUNT(*) FROM club_memberships WHERE user_id = 4')->fetchColumn() === 0, 'a failed bind should not leave a membership');

echo "club code helper functional checks passed" . PHP_EOL;
