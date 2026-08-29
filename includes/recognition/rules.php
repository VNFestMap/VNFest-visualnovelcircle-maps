<?php
// includes/recognition/rules.php - 受控规则引擎（架构文档第 10 节）
// 规则引擎只判断条件是否满足，不直接写凭证；签发由 credential.php 统一执行。
// 第一期只支持受控规则组件，不支持任意脚本。

require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/events.php';

// 第一期受控规则组件（对齐 docs/recognition-core-semantics.md 第 5 节）
const RECOGNITION_RULE_OPS = [
    'score_gte', 'eq', 'gte', 'lte', 'contains',
    'all_of', 'any_of', 'time_window', 'event_count_gte',
    'prerequisite_badge', 'reviewer_count_gte', 'submission_approved', 'source_is',
];

/**
 * 校验 RuleSet 结构（保存/发布前调用）
 * @return string|null 错误信息，合法返回 null
 */
function recogValidateRuleSet(array $ruleSet): ?string {
    if (empty($ruleSet['award']['badge_id'])) {
        return '规则必须指定奖励徽章（award.badge_id）';
    }
    $conds = $ruleSet['conditions'] ?? [];
    if (!is_array($conds)) {
        return 'conditions 必须为数组';
    }
    $logic = $ruleSet['logic'] ?? 'all';
    if (!in_array($logic, ['all', 'any'], true)) {
        return 'logic 只允许 all / any';
    }
    foreach ($conds as $c) {
        if (!is_array($c) || !in_array($c['op'] ?? '', RECOGNITION_RULE_OPS, true)) {
            return '不支持的规则组件：' . ($c['op'] ?? '(缺失)');
        }
        // 嵌套组合组件递归校验
        if (in_array($c['op'], ['all_of', 'any_of'], true)) {
            foreach (($c['conditions'] ?? []) as $sub) {
                if (!is_array($sub) || !in_array($sub['op'] ?? '', RECOGNITION_RULE_OPS, true)) {
                    return '嵌套规则组件不合法：' . ($sub['op'] ?? '(缺失)');
                }
            }
        }
    }
    return null;
}

/**
 * 评估单条规则
 * @param array $ctx 上下文：score / submission_status / reviewer_count / source / user_id / program_version_id
 */
function recogEvalCondition(array $cond, array $ctx): bool {
    $op = $cond['op'] ?? '';
    switch ($op) {
        case 'score_gte':
            return $ctx['score'] !== null && (float)$ctx['score'] >= (float)($cond['value'] ?? 0);
        case 'eq':
            return ($ctx[$cond['field'] ?? ''] ?? null) == ($cond['value'] ?? null);
        case 'gte':
            return (float)($ctx[$cond['field'] ?? ''] ?? 0) >= (float)($cond['value'] ?? 0);
        case 'lte':
            return (float)($ctx[$cond['field'] ?? ''] ?? PHP_INT_MAX) <= (float)($cond['value'] ?? 0);
        case 'contains':
            $haystack = $ctx[$cond['field'] ?? ''] ?? [];
            return is_array($haystack) && in_array($cond['value'] ?? null, $haystack, false);
        case 'all_of':
            foreach (($cond['conditions'] ?? []) as $sub) {
                if (!recogEvalCondition($sub, $ctx)) return false;
            }
            return true;
        case 'any_of':
            foreach (($cond['conditions'] ?? []) as $sub) {
                if (recogEvalCondition($sub, $ctx)) return true;
            }
            return false;
        case 'time_window':
            $now = time();
            $start = isset($cond['start']) ? strtotime($cond['start']) : false;
            $end = isset($cond['end']) ? strtotime($cond['end']) : false;
            if ($start !== false && $now < $start) return false;
            if ($end !== false && $now > $end) return false;
            return true;
        case 'event_count_gte':
            if (empty($ctx['user_id']) || empty($ctx['program_version_id'])) return false;
            $count = recogCountUserEvents(
                (int)$ctx['user_id'],
                (int)$ctx['program_version_id'],
                (string)($cond['event_type'] ?? '')
            );
            return $count >= (int)($cond['value'] ?? 1);
        case 'prerequisite_badge':
            if (empty($ctx['user_id'])) return false;
            $db = getDB();
            $stmt = $db->prepare(
                "SELECT id FROM recognition_credentials
                 WHERE holder_user_id = ? AND badge_id = ? AND status = 'active' LIMIT 1"
            );
            $stmt->execute([(int)$ctx['user_id'], (int)($cond['badge_id'] ?? 0)]);
            return (bool)$stmt->fetch();
        case 'reviewer_count_gte':
            return (int)($ctx['reviewer_count'] ?? 0) >= (int)($cond['value'] ?? 1);
        case 'submission_approved':
            return ($ctx['submission_status'] ?? '') === 'approved';
        case 'source_is':
            return ($ctx['source'] ?? '') === ($cond['value'] ?? '');
        default:
            return false;
    }
}

/**
 * 评估完整 RuleSet
 * @return array ['passed' => bool, 'reasons' => string[]]
 */
function recogEvaluateRuleSet(array $ruleSet, array $ctx): array {
    $conds = $ruleSet['conditions'] ?? [];
    $logic = $ruleSet['logic'] ?? 'all';

    // 无显式条件时视为自动满足（如活动签到类项目）
    if (empty($conds)) {
        return ['passed' => true, 'reasons' => []];
    }

    $reasons = [];
    foreach ($conds as $i => $cond) {
        $ok = recogEvalCondition($cond, $ctx);
        $reasons[] = recogDescribeCondition($cond) . ($ok ? '：满足' : '：不满足');
        if ($logic === 'all' && !$ok) {
            return ['passed' => false, 'reasons' => $reasons];
        }
        if ($logic === 'any' && $ok) {
            return ['passed' => true, 'reasons' => $reasons];
        }
    }
    return ['passed' => $logic === 'all', 'reasons' => $reasons];
}

/**
 * 生成条件的人类可读摘要（写入 Credential.condition_snapshot）
 */
function recogDescribeCondition(array $cond): string {
    switch ($cond['op'] ?? '') {
        case 'score_gte':     return '得分 ≥ ' . ($cond['value'] ?? 0);
        case 'eq':            return ($cond['field'] ?? '') . ' = ' . ($cond['value'] ?? '');
        case 'gte':           return ($cond['field'] ?? '') . ' ≥ ' . ($cond['value'] ?? 0);
        case 'lte':           return ($cond['field'] ?? '') . ' ≤ ' . ($cond['value'] ?? 0);
        case 'contains':      return ($cond['field'] ?? '') . ' 包含 ' . ($cond['value'] ?? '');
        case 'all_of':        return '同时满足 ' . count($cond['conditions'] ?? []) . ' 项条件';
        case 'any_of':        return '满足任意 ' . count($cond['conditions'] ?? []) . ' 项条件之一';
        case 'time_window':   return '在时间窗口内（' . ($cond['start'] ?? '-') . ' ~ ' . ($cond['end'] ?? '-') . '）';
        case 'event_count_gte': return ($cond['event_type'] ?? '') . ' 累计 ≥ ' . ($cond['value'] ?? 1) . ' 次';
        case 'prerequisite_badge': return '已拥有前置徽章 #' . ($cond['badge_id'] ?? 0);
        case 'reviewer_count_gte': return '审核人数 ≥ ' . ($cond['value'] ?? 1);
        case 'submission_approved': return '提交已通过审核';
        case 'source_is':     return '事件来源为 ' . ($cond['value'] ?? '');
        default:              return '未知条件';
    }
}

/**
 * 生成 RuleSet 的条件摘要列表
 */
function recogConditionSummary(array $ruleSet): array {
    $out = [];
    foreach (($ruleSet['conditions'] ?? []) as $cond) {
        $out[] = recogDescribeCondition($cond);
    }
    return $out;
}
