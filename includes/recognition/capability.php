<?php
// includes/recognition/capability.php - Capability 能力机制
// 不存储 mode 字段：构建层级由项目实际使用的能力集合自动判断（架构文档第 6 节）。

require_once __DIR__ . '/../db.php';

// 标准设置允许的能力集（第二期 MVP 范围，架构文档 4.1）
const RECOGNITION_STANDARD_CAPS = [
    'quiz.basic',
    'quiz.multiple_choice',
    'quiz.judgement',
    'quiz.fill_blank',
    'quiz.question_pool',
    'rule.score_threshold',
    'rule.attempt_limit',
    'rule.cooldown',
    'rule.time_window',
    'submission.text',
    'review.manual',
    'activity.claim_code',
    'credential.single',
    'credential.batch_import',
    'award.manual',
    'stats.basic',
];

// 进阶设置追加的能力（第三期）
const RECOGNITION_ADVANCED_CAPS = [
    'quiz.random_pool',
    'quiz.timed',
    'workflow.multi_stage',
    'workflow.prerequisite',
    'workflow.branch',
    'review.multi_reviewer',
    'review.owner_final',
    'rule.conditional',
    'credential.tiered',
    'credential.expiring',
    'credential.limited',
];

// 专家设置追加的能力（第四期）
const RECOGNITION_EXPERT_CAPS = [
    'event.external',
    'webhook.inbound',
    'webhook.outbound',
    'identity.external_link',
    'identity.claim_later',
    'credential.joint_issue',
];

/**
 * 校验能力名是否合法（防止保存任意字符串）
 */
function recogValidCapabilities(array $caps): array {
    $known = array_merge(RECOGNITION_STANDARD_CAPS, RECOGNITION_ADVANCED_CAPS, RECOGNITION_EXPERT_CAPS);
    return array_values(array_intersect($caps, $known));
}

/**
 * 根据能力集合自动判断构建层级
 * @return string standard|advanced|expert
 */
function recogDetectTier(array $caps): string {
    if (array_intersect($caps, RECOGNITION_EXPERT_CAPS)) {
        return 'expert';
    }
    if (array_intersect($caps, RECOGNITION_ADVANCED_CAPS)) {
        return 'advanced';
    }
    return 'standard';
}

/**
 * 层级对应的能力上限（用于编辑器暴露配置项）
 */
function recogAllowedCaps(string $tier): array {
    switch ($tier) {
        case 'expert':
            return array_merge(RECOGNITION_STANDARD_CAPS, RECOGNITION_ADVANCED_CAPS, RECOGNITION_EXPERT_CAPS);
        case 'advanced':
            return array_merge(RECOGNITION_STANDARD_CAPS, RECOGNITION_ADVANCED_CAPS);
        default:
            return RECOGNITION_STANDARD_CAPS;
    }
}

/**
 * 降级兼容性检查：当前能力是否全部能被目标层级表达
 * @return array 无法被目标层级表达的能力列表（空数组 = 可降级）
 */
function recogDowngradeConflicts(array $caps, string $targetTier): array {
    $allowed = recogAllowedCaps($targetTier);
    return array_values(array_diff($caps, $allowed));
}
