<?php
// api/spy_rooms.php - 谁是卧底：房间生命周期（建房 / 列表 / 入座 / 离座 / 配置 / 就绪 / 开局 / 关闭）
// [HERE] api/spy_rooms.php
//
// 端点刻意做得很薄：认人、取参、分发。业务规则全在 includes/spy_game.php 的命令层，
// 那样一整局游戏可以脱离 HTTP 被 scripts/test-spy-game.php 一路驱动并断言。

declare(strict_types=1);

require_once __DIR__ . '/../includes/spy_game.php';

spyBootstrap();
$db = spyBoot();
$body = spyReadJson();
$action = spyStr(spyParam($body, 'action', ''), 24);

switch ($action) {
    case 'list':
        // 未登录也能看列表：这里只有公开字段（房号、人数、阶段），不含词对与身份。
        $user = spyUser();
        spyOk(['rooms' => spyLobbyRooms($db, (int)($user['id'] ?? 0))]);
        break;

    case 'create':
        spyWrite($db, $body, static fn(PDO $d, array $u, array $b) => spyCreateRoom($d, $u, $b));
        break;

    case 'join':
        spyWrite($db, $body, static function (PDO $d, array $u, array $b): array {
            return spyJoinRoom($d, spyRefId($d, $b), $u, spyStr($b['join_code'] ?? '', 16));
        });
        break;

    case 'leave':
        spyWrite($db, $body, static function (PDO $d, array $u, array $b): array {
            return spyLeaveRoom($d, spyRefId($d, $b), $u);
        });
        break;

    case 'config':
        spyWrite($db, $body, static function (PDO $d, array $u, array $b): array {
            // 允许整份 body 直接当 patch，也允许显式嵌一层，前端两种写法都不用改服务端。
            $patch = is_array($b['patch'] ?? null) ? $b['patch'] : $b;
            return spyUpdateRoom($d, spyRefId($d, $b), $u, $patch);
        });
        break;

    case 'ready':
        spyWrite($db, $body, static function (PDO $d, array $u, array $b): array {
            return spySetReady($d, spyRefId($d, $b), $u, (bool)spyBool(spyParam($b, 'ready', 1)));
        });
        break;

    case 'start':
        spyWrite($db, $body, static function (PDO $d, array $u, array $b): array {
            return spyHostStart($d, spyRefId($d, $b), $u);
        });
        break;

    case 'close':
        spyWrite($db, $body, static function (PDO $d, array $u, array $b): array {
            return spyHostClose($d, spyRefId($d, $b), $u);
        });
        break;

    default:
        spyFail('invalid_action', 400);
}
