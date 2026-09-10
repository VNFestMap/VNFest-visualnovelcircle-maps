<?php
// api/spy_table.php - 谁是卧底：圆桌快照（前端唯一的轮询入口）
// [HERE] api/spy_table.php
//
// 这是站点上「按玩家视角投影状态」的唯一出口。可见性规则集中在
// includes/spy_game.php 的 spyTableSnapshot()，本文件只负责判断
// 「你是谁、能不能看这个房间」，然后把投影原样发出去。

declare(strict_types=1);

require_once __DIR__ . '/../includes/spy_game.php';

spyBootstrap();
$db = spyBoot();
$body = spyReadJson();
$action = spyStr(spyParam($body, 'action', 'table'), 24);

switch ($action) {
    case 'table':
        $user = spyRequireLogin();
        $ref = spyStr(spyParam($body, 'code', '') ?: spyParam($body, 'room', ''), 16);
        if ($ref === '') spyFail('invalid_params', 400);
        $room = spyLoadRoom($db, $ref);
        if (!$room) spyFail('room_not_found', 404);

        $roomId = (int)$room['id'];
        $seat = spySeatOf($db, $roomId, (int)$user['id']);
        // 裁判 = 房主且未入座。房主一旦入座就和大家看到一样的东西。
        $referee = $seat === null && (int)$room['host_user_id'] === (int)$user['id'];
        if ($seat === null && !$referee && (int)$room['spectate'] !== 1) {
            spyFail('spectate_off', 403);
        }

        // 心跳自带节流（超过阈值才落笔），所以放在事务外单独执行，
        // 不让每次轮询都去抢 SQLite 的写锁。
        spyTouch($db, $room, $seat, $user);

        // ?since=<rev> 是增量轮询：状态没动就只回一个 rev，省掉整份快照。
        $since = spyInt(spyParam($body, 'since', 0));
        if ($since > 0 && $since >= (int)$room['rev']) {
            spyOk(['rev' => (int)$room['rev'], 'changed' => false]);
        }

        spyOk(spyTableSnapshot($db, $room, $seat, $referee, $since, spyIsHost($room, $user)));
        break;

    default:
        spyFail('invalid_action', 400);
}
