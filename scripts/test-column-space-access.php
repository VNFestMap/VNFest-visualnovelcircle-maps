<?php
declare(strict_types=1);

require_once __DIR__ . '/../includes/posts/helpers.php';

function expectSpaceAccess(bool $condition, string $message): void
{
    if (!$condition) {
        fwrite(STDERR, $message . PHP_EOL);
        exit(1);
    }
}

$db = new PDO('sqlite::memory:');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->exec('CREATE TABLE club_memberships (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, role TEXT, status TEXT)');

$guest = postsSpaceAccessFor($db, null);
expectSpaceAccess($guest === ['allowed' => false, 'reason' => 'login_required'], 'guest should require login');

foreach (['visitor', 'external'] as $role) {
    $access = postsSpaceAccessFor($db, ['id' => 1, 'role' => $role]);
    expectSpaceAccess(!$access['allowed'] && $access['reason'] === 'membership_required', $role . ' should be denied');
}

$systemMember = postsSpaceAccessFor($db, ['id' => 2, 'role' => 'member']);
expectSpaceAccess($systemMember['allowed'] === true && $systemMember['reason'] === 'ok', 'system member should be allowed without a club row');

$db->prepare("INSERT INTO club_memberships (user_id, role, status) VALUES (3, 'member', 'active')")->execute();
$clubMember = postsSpaceAccessFor($db, ['id' => 3, 'role' => 'visitor']);
expectSpaceAccess($clubMember['allowed'] === true, 'active club member should be allowed');

foreach (['manager', 'representative', 'super_admin'] as $role) {
    $access = postsSpaceAccessFor($db, ['id' => 4, 'role' => $role]);
    expectSpaceAccess($access['allowed'] === true, $role . ' should be allowed');
}

foreach (['pending', 'inactive'] as $status) {
    $db->prepare('INSERT INTO club_memberships (user_id, role, status) VALUES (?, ?, ?)')->execute([5, 'member', $status]);
    $access = postsSpaceAccessFor($db, ['id' => 5, 'role' => 'visitor']);
    expectSpaceAccess(!$access['allowed'] && $access['reason'] === 'membership_required', $status . ' membership should not grant access');
}

$dbFailure = postsSpaceAccess(['id' => 6, 'role' => 'visitor'], new PDO('sqlite::memory:'));
expectSpaceAccess(!$dbFailure['allowed'] && $dbFailure['reason'] === 'unavailable', 'membership lookup failure must fail closed');

echo "column space access tests passed" . PHP_EOL;
