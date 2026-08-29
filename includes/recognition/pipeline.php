<?php
// includes/recognition/pipeline.php - 事件 → 规则评估 → 签发 编排
// 事件写入后在同一请求内同步评估规则并签发（PHP 单体下保持一致性）；
// 耗时后续动作经 outbox 由 worker 补偿。

require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/rules.php';
require_once __DIR__ . '/credential.php';

/**
 * 载入版本的快照内容
 */
function recogLoadVersion(PDO $db, int $versionId): ?array {
    $stmt = $db->prepare('SELECT * FROM recognition_program_versions WHERE id = ?');
    $stmt->execute([$versionId]);
    $version = $stmt->fetch();
    if (!$version) return null;
    $version['content'] = json_decode($version['content_snapshot'], true) ?: [];
    return $version;
}

/**
 * 获取项目当前已发布版本
 */
function recogPublishedVersion(PDO $db, int $programId): ?array {
    $stmt = $db->prepare(
        "SELECT id FROM recognition_program_versions WHERE program_id = ? AND status = 'published' ORDER BY id DESC LIMIT 1"
    );
    $stmt->execute([$programId]);
    $row = $stmt->fetch();
    if (!$row) return null;
    return recogLoadVersion($db, (int)$row['id']);
}

/**
 * 针对一次参与行为评估规则并尝试签发
 * $ctx: score / submission_status / reviewer_count / source 等
 * @return array ['passed','issued','duplicate','credential','reasons','error']
 */
function recogEvaluateAndAward(int $programVersionId, int $userId, array $ctx = []): array {
    $db = getDB();
    $result = ['passed' => false, 'issued' => false, 'duplicate' => false, 'credential' => null, 'reasons' => [], 'error' => null];

    $version = recogLoadVersion($db, $programVersionId);
    if (!$version || $version['status'] !== 'published') {
        $result['error'] = '项目版本不存在或未发布';
        return $result;
    }
    $content = $version['content'];
    $ruleSet = $content['rules'] ?? [];
    $badgeId = (int)($ruleSet['award']['badge_id'] ?? ($content['badge_id'] ?? 0));
    if ($badgeId <= 0) {
        $result['error'] = '项目未配置奖励徽章';
        return $result;
    }

    $stmt = $db->prepare('SELECT * FROM recognition_programs WHERE id = ?');
    $stmt->execute([(int)$version['program_id']]);
    $program = $stmt->fetch();
    if (!$program) {
        $result['error'] = '认可项目不存在';
        return $result;
    }
    if (!in_array($program['status'], ['published', 'paused'], true)) {
        $result['error'] = '认可项目当前不可参与';
        return $result;
    }

    $ctx = array_merge([
        'user_id' => $userId,
        'program_version_id' => $programVersionId,
        'score' => null,
        'submission_status' => null,
        'reviewer_count' => 0,
        'source' => 'site',
    ], $ctx);

    $eval = recogEvaluateRuleSet($ruleSet, $ctx);
    $result['passed'] = $eval['passed'];
    $result['reasons'] = $eval['reasons'];
    if (!$eval['passed']) {
        return $result;
    }

    $issue = issueCredential($db, [
        'holder_user_id' => $userId,
        'badge_id' => $badgeId,
        'issuer_club_id' => (int)$program['club_id'],
        'issuer_country' => (string)$program['country'],
        'program_id' => (int)$program['id'],
        'program_version_id' => $programVersionId,
        'credential_type' => $program['type'] === 'assessment' ? 'knowledge' : 'participation',
        'verification_level' => (string)($ruleSet['award']['verification_level'] ?? 'auto'),
        'condition_summary' => recogConditionSummary($ruleSet),
        'source_type' => $ctx['source'] === 'site' ? 'auto_rule' : 'external_event',
    ]);

    if (!$issue['ok']) {
        $result['error'] = $issue['error'];
        return $result;
    }
    $result['issued'] = !$issue['duplicate'];
    $result['duplicate'] = $issue['duplicate'];
    $result['credential'] = $issue['credential'];
    return $result;
}
