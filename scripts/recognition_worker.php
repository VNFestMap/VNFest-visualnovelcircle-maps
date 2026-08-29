<?php
// scripts/recognition_worker.php - 试炼系统补偿任务（CLI，cron 调用）
// 职责：
//   1. 消费 recognition_outbox（签发/撤销/过期通知等失败补偿与重试）
//   2. 扫描到期凭证并置为 expired（凭证过期不物理删除）
//
// 部署：服务器 cron 每 5 分钟执行一次（容器内）：
//   */5 * * * * docker exec vnfest-app php scripts/recognition_worker.php >> /tmp/recog_worker.log 2>&1

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/recognition/outbox.php';
require_once __DIR__ . '/../includes/recognition/credential.php';

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

$db = getDB();

// 1. 过期扫描（先于通知消费，保证过期通知能当轮入队）
$expired = expireDueCredentials($db);

// 2. 消费 outbox
$outbox = recogProcessOutbox($db, 100);

echo sprintf(
    "[%s] recognition_worker: expired=%d, outbox processed=%d, failed=%d\n",
    date('Y-m-d H:i:s'),
    $expired,
    $outbox['processed'],
    $outbox['failed']
);
