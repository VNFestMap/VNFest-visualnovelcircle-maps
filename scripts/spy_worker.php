<?php
// scripts/spy_worker.php - 谁是卧底补偿任务（CLI，cron 调用）
// 职责：
//   1. spyTick：把所有已过截止时刻的活房间各推进一个阶段（夜间结算 / 描述超时跳过 / 投票截止等）
//   2. spyIdemPrune：清理过期的写操作幂等缓存
//   3. spyReap（可选 --reap）：回收超时无人打理的房间；--dry-run 只报告不删
//
// 部署：cron 每分钟执行一次：
//   * * * * * php /www/wwwroot/162.251.93.178/scripts/spy_worker.php >> /tmp/spy_worker.log 2>&1

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/spy_game.php';

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

$reap = in_array('--reap', $argv, true);
$dryRun = in_array('--dry-run', $argv, true);

$db = spyBoot();

// 1. 推进所有过期的房间。每轮把每个到点房间推进一步，最多五轮，
//    让停摆一段时间后恢复的 cron 一次跑完积压。
$advanced = 0;
$errors = [];
for ($i = 0; $i < 5; $i++) {
    $tick = spyTick($db);
    $advanced += $tick['advanced'];
    $errors = array_merge($errors, $tick['errors']);
    if ($tick['advanced'] === 0) break;
}

// 2. 幂等缓存清理
$pruned = spyIdemPrune($db);

// 3. 房间回收（只在显式传 --reap 时执行，避免每次分钟级 cron 都做删除扫描）
$reaped = ['count' => 0, 'ids' => [], 'dry_run' => false];
if ($reap) {
    $reaped = spyReap($db, $dryRun);
}

echo sprintf(
    "[%s] spy_worker: advanced=%d, idem_pruned=%d, reaped=%d%s\n",
    date('Y-m-d H:i:s'),
    $advanced,
    $pruned,
    $reaped['count'],
    $errors ? ', errors=' . implode(' | ', array_slice($errors, 0, 5)) : ''
);

if ($errors) {
    exit(1);
}
