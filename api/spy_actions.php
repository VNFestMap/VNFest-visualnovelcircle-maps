<?php
// api/spy_actions.php - 谁是卧底：玩家与房主的动作（描述 / 投票 / 夜晚 / 白板猜词 / 推进 / 平票裁决）
// [HERE] api/spy_actions.php
//
// 每个动作都只是把参数交给 includes/spy_game.php 里的命令。
// 阶段门槛、身份校验、胜负裁决全在那一层，端点里不做任何规则判断。

declare(strict_types=1);

require_once __DIR__ . '/../includes/spy_game.php';

spyBootstrap();
$db = spyBoot();
$body = spyReadJson();
$action = spyStr(spyParam($body, 'action', ''), 24);

/** 目标座位：字段缺失、空串、null 一律视为「不选」（弃权 / 不刀人）。 */
function spySeatParam(PDO $db, array $body, string $key): ?int
{
    $raw = spyParam($body, $key, null);
    if ($raw === null || $raw === '' || $raw === 'null' || $raw === false) return null;
    if (!is_numeric($raw)) throw new SpyError('invalid_params', 400);
    return (int)$raw;
}

switch ($action) {
    case 'sentence':
        spyWrite($db, $body, static function (PDO $d, array $u, array $b): array {
            $roomId = spyRefId($d, $b);
            return spySubmitSentence($d, $roomId, $u,
                spyStr($b['body'] ?? '', 200), (bool)spyBool($b['skip'] ?? 0));
        });
        break;

    case 'vote':
        spyWrite($db, $body, static function (PDO $d, array $u, array $b): array {
            $roomId = spyRefId($d, $b);
            return spyCastVote($d, $roomId, $u, spySeatParam($d, $b, 'to_seat'));
        });
        break;

    case 'night':
        spyWrite($db, $body, static function (PDO $d, array $u, array $b): array {
            $roomId = spyRefId($d, $b);
            return spyNightAction($d, $roomId, $u, spySeatParam($d, $b, 'target_seat'));
        });
        break;

    case 'guess':
        spyWrite($db, $body, static function (PDO $d, array $u, array $b): array {
            $roomId = spyRefId($d, $b);
            return spyBlankGuess($d, $roomId, $u,
                spyStr($b['guess_a'] ?? '', 64), spyStr($b['guess_b'] ?? '', 64));
        });
        break;

    case 'advance':
        spyWrite($db, $body, static function (PDO $d, array $u, array $b): array {
            $roomId = spyRefId($d, $b);
            return spyHostAdvance($d, $roomId, $u);
        });
        break;

    case 'resolve':
        spyWrite($db, $body, static function (PDO $d, array $u, array $b): array {
            $roomId = spyRefId($d, $b);
            $ruling = spyStr($b['ruling'] ?? '', 16);
            if (!in_array($ruling, ['eliminate', 'revote', 'pass'], true)) {
                throw new SpyError('invalid_params', 400);
            }
            return spyResolveTie($d, $roomId, $u, $ruling, spySeatParam($d, $b, 'seat'));
        });
        break;

    case 'assign':
        spyWrite($db, $body, static function (PDO $d, array $u, array $b): array {
            $roomId = spyRefId($d, $b);
            $seatRaw = spyParam($b, 'seat', null);
            if ($seatRaw === null || !is_numeric($seatRaw)) throw new SpyError('invalid_params', 400);
            return spyAssignRole($d, $roomId, $u, (int)$seatRaw, spyStr($b['role'] ?? '', 16));
        });
        break;

    default:
        spyFail('invalid_action', 400);
}
