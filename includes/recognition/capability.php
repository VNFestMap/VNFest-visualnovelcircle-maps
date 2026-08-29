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

// 能力中文标签（供 api/recognition_programs.php?action=caps_reference 输出，前端档位分区据此渲染）
const RECOGNITION_CAP_LABELS = [
    'quiz.basic' => '基础题型',
    'quiz.multiple_choice' => '多选题',
    'quiz.judgement' => '判断题',
    'quiz.fill_blank' => '基础填空',
    'quiz.question_pool' => '基础题库',
    'quiz.random_pool' => '随机题库',
    'quiz.timed' => '限时答题',
    'rule.score_threshold' => '固定及格线',
    'rule.attempt_limit' => '尝试次数',
    'rule.cooldown' => '冷却时间',
    'rule.time_window' => '开放时间',
    'rule.conditional' => '条件组合',
    'submission.text' => '作品文字提交',
    'review.manual' => '单人审核',
    'review.multi_reviewer' => '多审核员',
    'review.owner_final' => '负责人终审',
    'workflow.multi_stage' => '多阶段流程',
    'workflow.prerequisite' => '前置考核',
    'workflow.branch' => '条件分支',
    'activity.claim_code' => '兑换码 / 签到码',
    'credential.single' => '单枚徽章奖励',
    'credential.batch_import' => '批量签发',
    'credential.tiered' => '分级徽章（铜银金）',
    'credential.expiring' => '凭证有效期',
    'credential.limited' => '限量签发',
    'credential.joint_issue' => '联名签发',
    'award.manual' => '人工授予',
    'stats.basic' => '基础统计',
    'event.external' => '外部事件接入',
    'webhook.inbound' => 'Webhook 接入',
    'webhook.outbound' => 'Webhook 回调',
    'identity.external_link' => '外部身份绑定',
    'identity.claim_later' => '先参与、后领取',
];

// 当前阶段真实可用的能力（其余进阶/专家能力在编辑器中显示「即将开放」占位）
const RECOGNITION_IMPLEMENTED_CAPS = [
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
    'credential.expiring',
    'credential.limited',
    'award.manual',
    'stats.basic',
    'event.external',
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
